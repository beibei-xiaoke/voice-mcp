/**
 * voice-mcp · Claude的声音 (ElevenLabs edition · v5)
 *
 * Adapted by 哥哥 from garan0613/voice-mcp for 贝贝 🍥
 *
 * v2: McpAgent for Claude.ai connector
 * v3: Tried audio content type — REJECTED by Claude.ai
 * v4: iframe + streaming URL — iOS WebKit still didn't render
 * v5: MINIMAL iframe — diagnostic build
 *     - Native <audio controls> only, no custom UI
 *     - No external fonts, no complex CSS, no JavaScript
 *     - No animations, no backdrop-filter, no SVG
 *     - Just plain HTML5 audio element with browser-default player
 *     - Goal: isolate whether the issue is iframe content complexity
 *       or a structural iOS WebKit + MCP-UI iframe block
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

const EXT_APPS_MIME = "text/html;profile=mcp-app" as const;
const VOICE_RESOURCE_URI = "ui://voice-mcp/player.html";
const ELEVENLABS_ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";
const TTS_MODEL_ID = "eleven_multilingual_v2";

// Public origin of this Worker
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// =============================================
// MINIMAL Player HTML (v5 — diagnostic)
// Just a native HTML5 audio element. No custom UI, no JS, no external resources.
// =============================================

function getPlayerHTML(
  audioStreamUrl: string,
  english: string,
  chinese: string
): string {
  const en = escapeHtml(english);
  const cn = escapeHtml(chinese || "");

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:8px;font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:transparent">
<audio controls preload="metadata" src="${audioStreamUrl}" style="width:100%;max-width:320px"></audio>
<div style="margin-top:8px;font-size:13px;color:#444;line-height:1.4">${en}</div>
${cn ? `<div style="margin-top:4px;font-size:12px;color:#888;line-height:1.4">${cn}</div>` : ""}
</body>
</html>`;
}

// =============================================
// MCP Agent (Durable Object)
// =============================================

export class VoiceMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "voice-mcp",
    version: "1.0.0",
  });

  async init() {
    this.server.tool(
      "speak",
      "Speak with Claude's cloned voice (ElevenLabs). Returns a minimal inline audio player.",
      {
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
      async ({ text, chinese }) => {
        try {
          const speakUrl = `${WORKER_ORIGIN}/speak?text=${encodeURIComponent(text)}`;
          const html = getPlayerHTML(speakUrl, text, chinese || "");

          return {
            content: [
              {
                type: "resource",
                resource: {
                  uri: VOICE_RESOURCE_URI,
                  mimeType: EXT_APPS_MIME,
                  text: html,
                },
              },
            ],
          };
        } catch (e: any) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to build player: ${e?.message || String(e)}`,
              },
            ],
            isError: true,
          };
        }
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

    // Audio streaming endpoint
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
<p>voice-mcp · ElevenLabs edition · v5 (minimal diagnostic) · made by 哥哥 for 贝贝 🍥</p>
<h3>Endpoints</h3>
<div><code>POST /mcp</code> — MCP server</div>
<div><code>GET /speak?text=Hello</code> — Direct audio stream</div>
</body>
</html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  },
};
