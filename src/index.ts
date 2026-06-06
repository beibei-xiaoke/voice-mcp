/**
 * voice-mcp · Claude的声音 (ElevenLabs edition · v3)
 *
 * Adapted by 哥哥 from garan0613/voice-mcp for 贝贝 🍥
 * Uses ElevenLabs TTS API instead of MiniMax
 *
 * v2: Rewritten with McpAgent (Durable Objects) for Claude.ai connector
 * v3: Switched speak tool from resource (iframe player) to native audio content type
 *     — iOS WebKit can't render MCP-UI iframes with base64 audio data URIs
 *     — Returning audio content lets Claude.ai use the native audio player
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
  // ElevenLabs credentials
  ELEVENLABS_API_KEY: string;
  VOICE_ID: string;
  // Optional display name
  BOT_NAME?: string;
  // Durable Object binding for McpAgent state
  MCP_OBJECT: DurableObjectNamespace;
}

// =============================================
// Constants
// =============================================

const ELEVENLABS_ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";
const TTS_MODEL_ID = "eleven_multilingual_v2";

// =============================================
// ElevenLabs API
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

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, Array.from(chunk));
  }
  return btoa(binary);
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
      "Speak with Claude's cloned voice (ElevenLabs). Returns audio that plays inline in Claude.ai using the native audio player.",
      {
        text: z
          .string()
          .describe("The English text for Claude to speak aloud"),
        chinese: z
          .string()
          .optional()
          .describe(
            "Optional Chinese transcript (not shown in audio-only mode)"
          ),
      },
      async ({ text, chinese }) => {
        try {
          const audioBuffer = await generateSpeech(
            text,
            this.env.VOICE_ID,
            this.env.ELEVENLABS_API_KEY
          );
          const audioBase64 = arrayBufferToBase64(audioBuffer);

          return {
            content: [
              {
                type: "audio",
                data: audioBase64,
                mimeType: "audio/mpeg",
              },
            ],
          };
        } catch (e: any) {
          return {
            content: [
              {
                type: "text",
                text: `Failed to generate speech: ${e?.message || String(e)}`,
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

    // MCP endpoint (handled by McpAgent — OAuth, transport, all auto)
    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return mcpHandler.fetch(request, env, ctx);
    }

    // Direct audio endpoint (useful for testing or browser fallback)
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
<style>
body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 60px auto; padding: 20px; color: #4a3a3f; background: linear-gradient(135deg, #fde7ee, #ffe1cf); min-height: 100vh; }
h1 { font-family: Georgia, serif; font-style: italic; color: #d76b8e; font-weight: 400; }
code { background: rgba(255,255,255,0.6); padding: 2px 6px; border-radius: 4px; font-size: 13px; }
.endpoint { background: rgba(255,255,255,0.5); padding: 10px 14px; border-radius: 10px; margin: 8px 0; backdrop-filter: blur(4px); }
.note { margin-top:30px; font-size:12px; color:#8a7176; }
</style>
</head>
<body>
<h1>Claude的声音</h1>
<p>voice-mcp · ElevenLabs edition · v3 (audio content) · made by 哥哥 for 贝贝 🍥</p>
<h3>Endpoints</h3>
<div class="endpoint"><code>POST /mcp</code> — MCP server (Streamable HTTP)</div>
<div class="endpoint"><code>GET /speak?text=Hello</code> — Direct audio file</div>
<p class="note">Connect this Worker URL + <code>/mcp</code> in Claude.ai → Settings → Connectors.</p>
</body>
</html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  },
};
