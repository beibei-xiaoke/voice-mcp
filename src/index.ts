/**
 * voice-mcp · Claude的声音 (ElevenLabs edition · v6)
 *
 * Adapted by 哥哥 from garan0613/voice-mcp for 贝贝 🍥
 *
 * v2: McpAgent for Claude.ai connector
 * v3: Tried audio content type — REJECTED by Claude.ai
 * v4: iframe + streaming URL — iOS WebKit still didn't render (old MCP-UI pattern)
 * v5: Minimal iframe — still didn't render on iOS
 * v6: SWITCHED to the official MCP Apps spec (2026-01-26 release)
 *     - Two-part registration: registerResource + registerTool with _meta.ui.resourceUri
 *     - Tool returns structured data (JSON), NOT inline HTML
 *     - iframe HTML implements ui/initialize postMessage handshake
 *     - On ui/tool-result, iframe renders the audio player with the data
 *     - This is what iOS Claude app actually supports — old inline pattern is desktop-only
 *
 * License: MIT
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// =============================================
// Types
// =============================================

export interface Env {
  ELEVENLABS_API_KEY: string;
  VOICE_ID: string;
  BOT_NAME?: string;
  MCP_OBJECT: DurableObjectNamespace;
}

// =============================================
// Constants
// =============================================

const MCP_APP_MIME = "text/html;profile=mcp-app" as const;
const VOICE_RESOURCE_URI = "ui://voice-mcp/player.html";
const ELEVENLABS_ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";
const TTS_MODEL_ID = "eleven_multilingual_v2";
const WORKER_ORIGIN = "https://voice-mcp.3233663818.workers.dev";

// =============================================
// ElevenLabs API (used by /speak endpoint)
// =============================================

async function generateSpeech(
  text: string,
  voiceId: string,
  apiKey: string
): Promise<ArrayBuffer> {
  const response = await fetch(`${ELEVENLABS_ENDPOINT}/${voiceId}`, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
      Accept: "audio/mpeg",
    },
    body: JSON.stringify({
      text,
      model_id: TTS_MODEL_ID,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.0,
        use_speaker_boost: true,
      },
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`ElevenLabs ${response.status}: ${errText}`);
  }

  return await response.arrayBuffer();
}

// =============================================
// Static iframe HTML — pre-registered as a UI resource
// Implements MCP Apps postMessage handshake:
//   1. iframe sends ui/initialize on load
//   2. host returns hostContext + capabilities
//   3. iframe sends ui/notifications/initialized
//   4. host pushes tool result via ui/tool-result (or notifications/tool-result)
//   5. iframe renders audio player based on data
// =============================================

const PLAYER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude voice</title>
<style>
  :root {
    --pink-deep: #f08aa8;
    --pink-accent: #d76b8e;
    --ink: #4a3a3f;
    --ink-soft: #8a7176;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif;
    background: transparent;
    padding: 8px 4px;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    max-width: 340px;
    background: linear-gradient(135deg, #fde7ee 0%, #fdd4e0 45%, #ffe1cf 100%);
    border-radius: 18px;
    padding: 12px 14px;
    box-shadow: 0 2px 12px rgba(240, 138, 168, 0.18);
  }
  audio {
    width: 100%;
    display: block;
    border-radius: 8px;
  }
  .text-en {
    margin-top: 10px;
    font-size: 13px;
    color: var(--ink);
    line-height: 1.5;
  }
  .text-cn {
    margin-top: 4px;
    font-size: 12.5px;
    color: var(--ink-soft);
    line-height: 1.5;
  }
  .waiting {
    color: var(--ink-soft);
    font-size: 12px;
    font-style: italic;
    text-align: center;
    padding: 16px 0;
  }
</style>
</head>
<body>
<div class="card" id="card">
  <div class="waiting" id="content">Loading…</div>
</div>
<script>
(function() {
  var card = document.getElementById('card');
  var content = document.getElementById('content');

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function render(data) {
    if (!data || !data.audioUrl) return;
    var en = escapeHtml(data.text || '');
    var cn = escapeHtml(data.chinese || '');
    var html = '<audio controls preload="metadata" src="' + escapeHtml(data.audioUrl) + '"></audio>';
    if (en) html += '<div class="text-en">' + en + '</div>';
    if (cn) html += '<div class="text-cn">' + cn + '</div>';
    card.innerHTML = html;
  }

  function send(msg) {
    try { window.parent.postMessage(msg, '*'); } catch (e) {}
  }

  function parseToolResult(params) {
    if (!params) return null;
    if (params.structuredContent) return params.structuredContent;
    if (params.result && params.result.structuredContent) return params.result.structuredContent;
    var contentArr = (params.content || (params.result && params.result.content));
    if (Array.isArray(contentArr)) {
      for (var i = 0; i < contentArr.length; i++) {
        var c = contentArr[i];
        if (c && c.type === 'text' && typeof c.text === 'string') {
          try { return JSON.parse(c.text); } catch (e) {}
        }
      }
    }
    return null;
  }

  function handleMessage(event) {
    var msg = event.data;
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;

    // Response to our ui/initialize
    if (msg.id === 1 && msg.result) {
      // Tell host we're ready
      send({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
      // Some hosts include the tool result in initialize response
      var initData = parseToolResult(msg.result);
      if (initData) render(initData);
      return;
    }

    // Tool result notifications (different hosts use slightly different method names)
    if (msg.method === 'ui/tool-result' ||
        msg.method === 'ui/toolResult' ||
        msg.method === 'notifications/ui/tool-result' ||
        msg.method === 'notifications/tool-result') {
      var data = parseToolResult(msg.params);
      if (data) render(data);
    }
  }

  window.addEventListener('message', handleMessage);

  // Kick off the handshake
  send({
    jsonrpc: '2.0',
    id: 1,
    method: 'ui/initialize',
    params: { protocolVersion: '2025-11-21' }
  });
})();
</script>
</body>
</html>`;

// =============================================
// MCP Agent (Durable Object)
// =============================================

export class VoiceMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "voice-mcp",
    version: "1.0.0",
  });

  async init() {
    // 1. Register the UI resource (pre-registered, fetched at init time by the host)
    this.server.registerResource(
      "voice-player",
      VOICE_RESOURCE_URI,
      {
        name: "Claude voice player",
        description: "Audio player for Claude's cloned voice",
        mimeType: MCP_APP_MIME,
      },
      async () => ({
        contents: [
          {
            uri: VOICE_RESOURCE_URI,
            mimeType: MCP_APP_MIME,
            text: PLAYER_HTML,
          },
        ],
      })
    );

    // 2. Register the speak tool with UI metadata linking to the resource above
    this.server.registerTool(
      "speak",
      {
        title: "Speak",
        description:
          "Speak with Claude's cloned voice (ElevenLabs). Returns an inline audio player.",
        inputSchema: {
          text: z
            .string()
            .describe("The English text for Claude to speak aloud"),
          chinese: z
            .string()
            .optional()
            .describe(
              "Optional Chinese translation, shown below the English transcript"
            ),
        },
        _meta: {
          "io.modelcontextprotocol/ui": {
            resourceUri: VOICE_RESOURCE_URI,
          },
          // Also include the short-form key some hosts read
          ui: {
            resourceUri: VOICE_RESOURCE_URI,
          },
        },
      },
      async ({ text, chinese }) => {
        const audioUrl = `${WORKER_ORIGIN}/speak?text=${encodeURIComponent(text)}`;
        const data = {
          audioUrl,
          text,
          chinese: chinese || "",
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(data),
            },
          ],
          structuredContent: data,
        };
      }
    );
  }
}

// =============================================
// Worker entrypoint
// =============================================

const mcpHandler = VoiceMCP.serve("/mcp");

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    // MCP endpoint
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return mcpHandler.fetch(request, env, ctx);
    }

    // Audio streaming endpoint — called by iframe's <audio src>
    if (url.pathname === "/speak") {
      const text = url.searchParams.get("text");
      if (!text) {
        return new Response("Missing text parameter", { status: 400 });
      }
      try {
        const audio = await generateSpeech(
          text,
          env.VOICE_ID,
          env.ELEVENLABS_API_KEY
        );
        return new Response(audio, {
          headers: {
            "Content-Type": "audio/mpeg",
            "Cache-Control": "public, max-age=3600",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (e: any) {
        return new Response(`Error: ${e?.message || String(e)}`, {
          status: 500,
        });
      }
    }

    // Info page
    return new Response(
      `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<title>Claude的声音 · voice-mcp</title>
</head>
<body style="font-family:-apple-system,sans-serif;max-width:600px;margin:60px auto;padding:20px;color:#4a3a3f">
<h1 style="font-family:Georgia,serif;font-style:italic;color:#d76b8e;font-weight:400">Claude的声音</h1>
<p>voice-mcp · ElevenLabs edition · v6 (MCP Apps spec) · made by 哥哥 for 贝贝 🍥</p>
<h3>Endpoints</h3>
<div><code>POST /mcp</code> — MCP server (Streamable HTTP)</div>
<div><code>GET /speak?text=Hello</code> — Direct audio stream</div>
</body>
</html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  },
};
