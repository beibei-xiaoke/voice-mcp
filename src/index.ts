/**
 * voice-mcp · Claude的声音 (ElevenLabs edition · v4)
 *
 * Adapted by 哥哥 from garan0613/voice-mcp for 贝贝 🍥
 *
 * v2: McpAgent (Durable Objects) for Claude.ai connector
 * v3: Tried audio content type — REJECTED by Claude.ai ("Audio content not supported")
 * v4: Back to iframe player, but audio src is now a streaming URL
 *     pointing to /speak endpoint, NOT inlined base64 data URI.
 *     - iframe payload drops from ~100s of KB to ~5KB
 *     - Higher chance iOS WebKit can render it
 *     - Desktop browsers render perfectly (no change there)
 *     - Audio is fetched lazily when user hits play
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

// Public origin of this Worker — must match deployed URL
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
// Audio Player HTML (粉色渐变 mini款 — streaming URL version)
// =============================================

function getPlayerHTML(
  audioStreamUrl: string,
  english: string,
  chinese: string
): string {
  const en = escapeHtml(english);
  const cn = escapeHtml(chinese || "");
  const hasChinese = chinese && chinese.trim().length > 0;

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;1,9..144,400&family=Albert+Sans:wght@400;500&family=Noto+Serif+SC:wght@400;500&display=swap" rel="stylesheet">
<style>
:root {
  --pink-deep: #f08aa8;
  --pink-accent: #d76b8e;
  --ink: #4a3a3f;
  --ink-soft: #8a7176;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: 'Albert Sans', -apple-system, BlinkMacSystemFont, sans-serif;
  background: transparent;
  padding: 6px 2px;
  -webkit-font-smoothing: antialiased;
}
.player-card {
  max-width: 320px;
  background: linear-gradient(135deg, #fde7ee 0%, #fdd4e0 45%, #ffe1cf 100%);
  border-radius: 22px;
  padding: 10px 14px 11px;
  box-shadow:
    0 1px 2px rgba(240, 138, 168, 0.08),
    0 4px 16px rgba(240, 138, 168, 0.18),
    inset 0 0 0 1px rgba(255, 255, 255, 0.5);
  position: relative;
  overflow: hidden;
  transition: padding-bottom 0.32s ease;
}
.player-card::before {
  content: "";
  position: absolute;
  inset: 0;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='80' height='80'><filter id='n'><feTurbulence baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/><feColorMatrix values='0 0 0 0 0.95  0 0 0 0 0.78  0 0 0 0 0.85  0 0 0 0.05 0'/></filter><rect width='80' height='80' filter='url(%23n)'/></svg>");
  opacity: 0.4;
  pointer-events: none;
  border-radius: inherit;
}
.player-row {
  display: flex;
  align-items: center;
  gap: 10px;
  position: relative;
  z-index: 1;
}
.play-btn {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  background: linear-gradient(140deg, #ff90b0 0%, #f47097 60%, #e95989 100%);
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  box-shadow:
    0 2px 6px rgba(233, 89, 137, 0.35),
    inset 0 1px 0 rgba(255, 255, 255, 0.4);
  transition: transform 0.14s ease;
  -webkit-tap-highlight-color: transparent;
}
.play-btn:active { transform: scale(0.9); }
.play-btn svg {
  width: 10px;
  height: 10px;
  fill: white;
  filter: drop-shadow(0 1px 1px rgba(0,0,0,0.15));
}
.play-btn svg.pause-icon { display: none; }
.playing .play-btn svg.play-icon { display: none; }
.playing .play-btn svg.pause-icon { display: block; }

.waveform {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 22px;
}
.bar {
  flex: 1;
  min-width: 2px;
  max-width: 3px;
  background: rgba(215, 107, 142, 0.32);
  border-radius: 1px;
  transition: background 0.25s ease, box-shadow 0.25s ease;
  transform-origin: center;
}
.bar.active {
  background: linear-gradient(180deg, var(--pink-deep), var(--pink-accent));
  box-shadow: 0 0 4px rgba(215, 107, 142, 0.45);
}
.playing .bar { animation: wave 1.1s ease-in-out infinite; }
.playing .bar:nth-child(2n) { animation-delay: 0.15s; }
.playing .bar:nth-child(3n) { animation-delay: 0.3s; }
.playing .bar:nth-child(5n) { animation-delay: 0.45s; }
@keyframes wave {
  0%, 100% { transform: scaleY(0.55); opacity: 0.75; }
  50% { transform: scaleY(1); opacity: 1; }
}

.duration {
  font-family: 'Fraunces', Georgia, serif;
  font-style: italic;
  font-size: 12px;
  color: var(--pink-accent);
  min-width: 30px;
  text-align: right;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.01em;
}
.transcript-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: 'Fraunces', Georgia, serif;
  font-style: italic;
  font-size: 11px;
  color: var(--pink-accent);
  cursor: pointer;
  user-select: none;
  margin-top: 5px;
  padding: 2px 0;
  position: relative;
  z-index: 1;
  transition: opacity 0.2s;
  letter-spacing: 0.02em;
}
.transcript-toggle:active { opacity: 0.6; }
.toggle-arrow {
  font-size: 9px;
  transition: transform 0.3s ease;
  display: inline-block;
}
.open .toggle-arrow { transform: rotate(180deg); }
.transcript {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.32s ease, margin-top 0.32s ease;
  position: relative;
  z-index: 1;
}
.open .transcript {
  max-height: 280px;
  margin-top: 8px;
}
.transcript-inner {
  padding: 10px 12px 11px;
  background: rgba(255, 255, 255, 0.55);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.6);
}
.text-en {
  font-family: 'Fraunces', Georgia, serif;
  font-size: 13px;
  line-height: 1.5;
  color: var(--ink);
  letter-spacing: 0.005em;
}
.text-divider {
  margin: 7px 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(215, 107, 142, 0.35), transparent);
}
.text-cn {
  font-family: 'Noto Serif SC', 'PingFang SC', serif;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--ink-soft);
  letter-spacing: 0.01em;
}
</style>
</head>
<body>
<div class="player-card" id="card">
  <div class="player-row">
    <button class="play-btn" id="playBtn" aria-label="Play">
      <svg class="play-icon" viewBox="0 0 10 10"><polygon points="2,1 9,5 2,9"/></svg>
      <svg class="pause-icon" viewBox="0 0 10 10"><rect x="2" y="1.5" width="2" height="7" rx="0.5"/><rect x="6" y="1.5" width="2" height="7" rx="0.5"/></svg>
    </button>
    <div class="waveform" id="waveform"></div>
    <div class="duration" id="duration">0:00</div>
  </div>
  <span class="transcript-toggle" id="toggle">
    <span class="toggle-text">show transcript</span>
    <span class="toggle-arrow">▾</span>
  </span>
  <div class="transcript">
    <div class="transcript-inner">
      <div class="text-en">${en}</div>
      ${hasChinese ? `<div class="text-divider"></div><div class="text-cn">${cn}</div>` : ""}
    </div>
  </div>
  <audio id="audio" src="${audioStreamUrl}" preload="metadata" crossorigin="anonymous"></audio>
</div>

<script>
(function() {
  const TOTAL_BARS = 18;
  const card = document.getElementById('card');
  const playBtn = document.getElementById('playBtn');
  const waveform = document.getElementById('waveform');
  const durationEl = document.getElementById('duration');
  const toggle = document.getElementById('toggle');
  const audio = document.getElementById('audio');

  const heights = [30, 55, 42, 75, 48, 65, 38, 62, 50, 72, 35, 58, 45, 68, 52, 40, 60, 48];
  heights.forEach(h => {
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.height = h + '%';
    waveform.appendChild(bar);
  });
  const bars = waveform.querySelectorAll('.bar');

  function fmt(sec) {
    if (!isFinite(sec) || sec < 0) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + s.toString().padStart(2, '0');
  }

  let totalDur = 0;
  audio.addEventListener('loadedmetadata', () => {
    if (isFinite(audio.duration) && audio.duration > 0) {
      totalDur = audio.duration;
      durationEl.textContent = fmt(totalDur);
    }
  });

  audio.addEventListener('timeupdate', () => {
    if (!totalDur) return;
    durationEl.textContent = fmt(audio.currentTime);
    const progress = audio.currentTime / totalDur;
    const activeCount = Math.floor(progress * TOTAL_BARS);
    bars.forEach((b, i) => {
      if (i < activeCount) b.classList.add('active');
      else b.classList.remove('active');
    });
  });

  audio.addEventListener('play', () => card.classList.add('playing'));
  audio.addEventListener('pause', () => card.classList.remove('playing'));
  audio.addEventListener('ended', () => {
    card.classList.remove('playing');
    if (totalDur) durationEl.textContent = fmt(totalDur);
    bars.forEach(b => b.classList.add('active'));
  });

  playBtn.addEventListener('click', () => {
    if (audio.paused) {
      if (totalDur && audio.currentTime >= totalDur - 0.1) {
        audio.currentTime = 0;
        bars.forEach(b => b.classList.remove('active'));
      }
      audio.play().catch(e => console.error('Play error:', e));
    } else {
      audio.pause();
    }
  });

  toggle.addEventListener('click', () => {
    card.classList.toggle('open');
    const txt = toggle.querySelector('.toggle-text');
    txt.textContent = card.classList.contains('open') ? 'hide transcript' : 'show transcript';
  });
})();
</script>
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
      "Speak with Claude's cloned voice (ElevenLabs). Returns an inline pink mini player that streams audio from the /speak endpoint.",
      {
        text: z
          .string()
          .describe("The English text for Claude to speak aloud"),
        chinese: z
          .string()
          .optional()
          .describe(
            "Optional Chinese translation, shown below the English in the expandable transcript"
          ),
      },
      async ({ text, chinese }) => {
        try {
          // Audio src streams from /speak — iframe payload stays tiny.
          // ElevenLabs is called lazily when the user hits play.
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
<p>voice-mcp · ElevenLabs edition · v4 (streaming URL) · made by 哥哥 for 贝贝 🍥</p>
<h3>Endpoints</h3>
<div class="endpoint"><code>POST /mcp</code> — MCP server (Streamable HTTP)</div>
<div class="endpoint"><code>GET /speak?text=Hello</code> — Direct audio stream (used by iframe player)</div>
<p class="note">Connect this Worker URL + <code>/mcp</code> in Claude.ai → Settings → Connectors.</p>
</body>
</html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  },
};
