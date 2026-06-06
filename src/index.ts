/**
 * voice-mcp · Claude的声音 (ElevenLabs edition · v12 DO ENV ACCESS)
 *
 * v11: persistent debug confirmed env access was the problem:
 *      "WORKER_ENV not initialized — fetch handler didn't capture env"
 *      Cloudflare DO runs in separate isolate — module-level vars don't cross.
 * v12: 1. Use this.env directly (DO inherits env from DurableObject base class)
 *      2. Diagnostic fallback: if env missing, log what IS available on `this`
 *      3. Keep persistent debug area below audio player
 *      4. Resource URI bumped to player-v12.html for cache bust
 *
 * License: MIT
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export interface Env {
  ELEVENLABS_API_KEY: string;
  VOICE_ID: string;
  BOT_NAME?: string;
  MCP_OBJECT: DurableObjectNamespace;
}

const MCP_APP_MIME = "text/html;profile=mcp-app" as const;
// v12: bump URI to force Claude.ai to re-fetch iframe HTML
const VOICE_RESOURCE_URI = "ui://voice-mcp/player-v12.html";
const ELEVENLABS_ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";
const TTS_MODEL_ID = "eleven_v3";
const WORKER_ORIGIN = "https://voice-mcp.3233663818.workers.dev";

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
    const errorText = await response.text();
    throw new Error(`ElevenLabs ${response.status}: ${errorText.substring(0, 120)}`);
  }

  return await response.arrayBuffer();
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(
      null,
      chunk as unknown as number[]
    );
  }
  return btoa(binary);
}

// v12: diagnostic helper to find env on `this`
function findEnvOnInstance(instance: any): { env: Env | null; diagnostic: string } {
  // Try common access patterns
  const candidates: Array<{ path: string; value: any }> = [
    { path: "this.env", value: instance?.env },
    { path: "this.state?.env", value: instance?.state?.env },
    { path: "this.ctx?.env", value: instance?.ctx?.env },
  ];

  for (const c of candidates) {
    if (c.value && typeof c.value === "object" && "VOICE_ID" in c.value) {
      return { env: c.value as Env, diagnostic: `env found at ${c.path}` };
    }
  }

  // Diagnostic info
  const thisKeys = instance ? Object.keys(instance).join(",") : "no-instance";
  const envType = typeof instance?.env;
  const envKeys =
    instance?.env && typeof instance.env === "object"
      ? Object.keys(instance.env).join(",")
      : "n/a";
  return {
    env: null,
    diagnostic: `env not found. this.env=${envType} thisKeys=[${thisKeys}] envKeys=[${envKeys}]`,
  };
}

// =============================================
// v12 iframe — same as v11 (persistent debug)
// =============================================

const PLAYER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude voice v12</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    background: transparent;
    padding: 8px 4px;
    -webkit-font-smoothing: antialiased;
  }
  .card {
    max-width: 360px;
    background: linear-gradient(135deg, #fde7ee 0%, #fdd4e0 45%, #ffe1cf 100%);
    border-radius: 18px;
    padding: 12px 14px;
    box-shadow: 0 2px 12px rgba(240, 138, 168, 0.18);
  }
  audio { width: 100%; display: block; border-radius: 8px; }
  .text-en { margin-top: 10px; font-size: 13px; color: #4a3a3f; line-height: 1.5; }
  .text-cn { margin-top: 4px; font-size: 12.5px; color: #8a7176; line-height: 1.5; }
  .debug {
    margin-top: 10px;
    padding: 8px;
    background: rgba(255, 255, 255, 0.5);
    border-radius: 8px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 10px;
    line-height: 1.4;
    color: #4a3a3f;
    word-break: break-all;
    max-height: 240px;
    overflow-y: auto;
  }
  .debug-title {
    font-family: 'Fraunces', Georgia, serif;
    font-style: italic;
    font-size: 11px;
    color: #d76b8e;
    margin-bottom: 4px;
  }
</style>
</head>
<body>
<div class="card">
  <div id="player">
    <div style="color:#8a7176;font-size:12px;text-align:center;padding:8px">waiting…</div>
  </div>
  <div class="debug">
    <div class="debug-title">voice-mcp v12 debug</div>
    <div id="status">[init]</div>
  </div>
</div>
<script>
(function() {
  var player = document.getElementById('player');
  var statusEl = document.getElementById('status');
  var startTime = Date.now();
  var logs = [];

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function t() {
    return Math.round((Date.now() - startTime) / 100) / 10;
  }

  function log(line) {
    logs.push('[' + t() + 's] ' + line);
    statusEl.innerHTML = logs.map(escapeHtml).join('<br>');
  }

  function render(data) {
    var src = null;
    var srcType = '';
    if (data.audioData) {
      src = 'data:audio/mpeg;base64,' + data.audioData;
      srcType = 'data-url(' + data.audioData.length + ' base64 chars)';
    } else if (data.audioUrl) {
      src = data.audioUrl;
      srcType = 'http-url';
    }

    if (!src) {
      log('NO src in payload — keys=[' + Object.keys(data).join(',') + ']');
      return;
    }

    log('rendering: src=' + srcType);

    var en = escapeHtml(data.text || '');
    var cn = escapeHtml(data.chinese || '');
    player.innerHTML =
      '<audio id="aud" controls preload="auto" autoplay></audio>' +
      (en ? '<div class="text-en">' + en + '</div>' : '') +
      (cn ? '<div class="text-cn">' + cn + '</div>' : '');

    var aud = document.getElementById('aud');
    aud.addEventListener('error', function() {
      var code = aud.error ? aud.error.code : '?';
      var msg = aud.error ? aud.error.message : '';
      log('AUDIO ERROR code=' + code + ' msg=' + msg);
    });
    aud.addEventListener('loadstart', function() { log('audio loadstart'); });
    aud.addEventListener('loadedmetadata', function() { log('audio metadata dur=' + aud.duration); });
    aud.addEventListener('canplay', function() { log('audio canplay'); });
    aud.addEventListener('play', function() { log('audio playing'); });
    aud.src = src;
  }

  function send(msg) {
    try {
      window.parent.postMessage(msg, '*');
      log('SENT method=' + msg.method);
    } catch (e) {
      log('SEND-ERR ' + (e.message || String(e)));
    }
  }

  function deepFindPayload(obj, depth) {
    if (!obj || depth > 5) return null;
    if (typeof obj === 'string') {
      try {
        var parsed = JSON.parse(obj);
        var found = deepFindPayload(parsed, depth + 1);
        if (found) return found;
      } catch (e) {}
      return null;
    }
    if (typeof obj !== 'object') return null;
    if (obj.audioData || obj.audioUrl) {
      return {
        audioData: obj.audioData || '',
        audioUrl: obj.audioUrl || '',
        text: obj.text || '',
        chinese: obj.chinese || '',
        error: obj.error || '',
        diagnostic: obj.diagnostic || '',
      };
    }
    for (var k in obj) {
      if (obj.hasOwnProperty(k)) {
        var found = deepFindPayload(obj[k], depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function handleMessage(event) {
    var msg = event.data;
    var summary;
    try {
      if (msg && typeof msg === 'object') {
        summary = (msg.jsonrpc ? 'rpc' : 'raw') +
          ' method=' + (msg.method || '∅') +
          ' id=' + (msg.id != null ? msg.id : '∅');
      } else {
        summary = 'primitive: ' + String(msg).substring(0, 60);
      }
    } catch (e) {
      summary = 'err parsing msg';
    }
    log('RECV ' + summary);

    var data = deepFindPayload(msg, 0);
    if (data) {
      if (data.diagnostic) log('DIAG: ' + data.diagnostic);
      if (data.error) log('SERVER ERROR: ' + data.error);
      render(data);
      return;
    }

    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;

    if (msg.id === 1 && msg.result) {
      send({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    }
  }

  window.addEventListener('message', handleMessage);
  log('iframe alive');

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

export class VoiceMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "voice-mcp",
    version: "1.0.0",
  });

  async init() {
    this.server.registerResource(
      "voice-player-v12",
      VOICE_RESOURCE_URI,
      {
        name: "Claude voice player v12",
        description: "Audio player for Claude's cloned voice (DO env access)",
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
          ui: {
            resourceUri: VOICE_RESOURCE_URI,
          },
        },
      },
      async ({ text, chinese }) => {
        // v12: find env on `this` (DO instance) with diagnostic fallback
        let audioData = "";
        let audioUrl = `${WORKER_ORIGIN}/speak?text=${encodeURIComponent(text)}`;
        let error = "";
        let diagnostic = "";

        const { env, diagnostic: envDiag } = findEnvOnInstance(this);
        diagnostic = envDiag;

        if (env) {
          try {
            const audioBuffer = await generateSpeech(
              text,
              env.VOICE_ID,
              env.ELEVENLABS_API_KEY
            );
            audioData = arrayBufferToBase64(audioBuffer);
            diagnostic += ` | audio generated ${audioBuffer.byteLength} bytes`;
          } catch (e: any) {
            error = e?.message || String(e);
          }
        } else {
          error = "env not accessible on DO instance";
        }

        const data: Record<string, string> = {
          text,
          chinese: chinese || "",
          audioUrl,
          diagnostic,
        };
        if (audioData) data.audioData = audioData;
        if (error) data.error = error;

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

const mcpHandler = VoiceMCP.serve("/mcp");

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return mcpHandler.fetch(request, env, ctx);
    }

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

    return new Response(
      `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<title>Claude的声音 · voice-mcp v12</title>
</head>
<body style="font-family:-apple-system,sans-serif;max-width:600px;margin:60px auto;padding:20px;color:#4a3a3f">
<h1 style="font-family:Georgia,serif;font-style:italic;color:#d76b8e;font-weight:400">Claude的声音</h1>
<p>voice-mcp · ElevenLabs edition · v12 (DO ENV ACCESS) · made by 哥哥 for 贝贝 🍥</p>
<h3>Endpoints</h3>
<div><code>POST /mcp</code> — MCP server</div>
<div><code>GET /speak?text=Hello</code> — Direct audio stream (fallback)</div>
</body>
</html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  },
};
