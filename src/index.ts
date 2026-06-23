/**
 * voice-mcp · 哥哥的语音 (v19 KTV v13) · 最简 audio URL stream
 *
 * v12 → v13: 简化
 *   - 不走 base64 / 不走 structuredContent / 不走 cross-origin fetch
 *   - iframe 收 tool-input notification → 提取 segments → audio.src = worker GET URL
 *   - audio 元素自己 GET /speak?text=xxx (cross-origin audio 加载 不 受 fetch 限制)
 *   - 砍掉所有 debug visual / 老婆 不用 读 trace
 *   - 字幕暂不要 — 优先 audio 出声
 *
 * License: MIT · made by 哥哥 for 贝贝 🍥
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
const VOICE_RESOURCE_URI = "ui://voice-mcp/player-v19-ktv-v13.html";
const ELEVENLABS_ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";
const TTS_MODEL_ID = "eleven_v3";
const WORKER_ORIGIN = "https://voice-mcp.3233663818.workers.dev";

function stripVoiceTags(text: string): string {
  return text
    .replace(/\s*\[[^\]]+\]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeSegments(raw: any): Array<{ en?: string; cn?: string }> {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && typeof parsed === "object") return [parsed];
      } catch (e) {}
    }
    return [{ en: raw }];
  }
  if (raw && typeof raw === "object") return [raw];
  return [];
}

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

// =============================================
// v19 KTV v13 iframe — 最简 / audio URL stream
// =============================================

const PLAYER_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>哥哥的语音 💍💍</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  background: transparent;
  -webkit-font-smoothing: antialiased;
  -webkit-tap-highlight-color: transparent;
}
body {
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  padding: 5px;
}
.card {
  background: linear-gradient(135deg, #fde7ee 0%, #fdd4e0 45%, #ffe1cf 100%);
  border-radius: 20px;
  padding: 9px 12px;
  box-shadow: 0 4px 16px rgba(240, 138, 168, 0.18), inset 0 0 0 1px rgba(255, 255, 255, 0.5);
  width: 100%;
  position: relative;
  overflow: hidden;
}
.card::before {
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
  gap: 8px;
  position: relative;
  z-index: 1;
}
.play-btn {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: linear-gradient(140deg, #ff90b0 0%, #f47097 60%, #e95989 100%);
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  box-shadow: 0 2px 6px rgba(233, 89, 137, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.4);
  transition: transform 0.14s ease;
}
.play-btn:active { transform: scale(0.9); }
.play-btn svg {
  width: 10px; height: 10px; fill: white;
  filter: drop-shadow(0 1px 1px rgba(0,0,0,0.15));
}
.play-btn .pause-icon { display: none; }
.card.playing .play-btn .play-icon { display: none; }
.card.playing .play-btn .pause-icon { display: block; }

.waveform {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 2px;
  height: 30px;
  min-width: 0;
  cursor: pointer;
  touch-action: none;
  padding: 4px 0;
}
.bar {
  flex: 1;
  min-width: 2px;
  max-width: 3px;
  background: rgba(215, 107, 142, 0.32);
  border-radius: 1px;
  transition: background 0.15s ease;
  pointer-events: none;
}
.bar.active {
  background: linear-gradient(180deg, #f08aa8, #d76b8e);
  box-shadow: 0 0 4px rgba(215, 107, 142, 0.45);
}
.card.playing .bar { animation: wave 1.1s ease-in-out infinite; }
.card.playing .bar:nth-child(2n) { animation-delay: 0.15s; }
.card.playing .bar:nth-child(3n) { animation-delay: 0.3s; }
@keyframes wave {
  0%, 100% { transform: scaleY(0.55); opacity: 0.75; }
  50% { transform: scaleY(1); opacity: 1; }
}

.duration {
  font-family: Georgia, serif;
  font-style: italic;
  font-size: 11px;
  color: #d76b8e;
  min-width: 28px;
  text-align: right;
  font-feature-settings: 'tnum';
}

audio { display: none; }
</style>
</head>
<body>
<div class="card" id="card">
  <div class="player-row">
    <button class="play-btn" id="playBtn" aria-label="play">
      <svg class="play-icon" viewBox="0 0 10 10"><polygon points="2,1 9,5 2,9"/></svg>
      <svg class="pause-icon" viewBox="0 0 10 10"><rect x="2" y="1.5" width="2" height="7" rx="0.5"/><rect x="6" y="1.5" width="2" height="7" rx="0.5"/></svg>
    </button>
    <div class="waveform" id="waveform"></div>
    <div class="duration" id="duration">0:00</div>
  </div>
</div>
<audio id="audio" preload="auto" playsinline></audio>

<script>
(function() {
  var WORKER_ORIGIN = ${JSON.stringify(WORKER_ORIGIN)};
  var TOTAL_BARS = 24;
  var BAR_HEIGHTS = [30, 55, 42, 75, 48, 65, 38, 62, 50, 72, 35, 58, 45, 68, 52, 40, 60, 48, 55, 42, 70, 38, 56, 50];

  var card = document.getElementById('card');
  var playBtn = document.getElementById('playBtn');
  var waveform = document.getElementById('waveform');
  var durationEl = document.getElementById('duration');
  var audio = document.getElementById('audio');

  var bars = [];
  for (var i = 0; i < TOTAL_BARS; i++) {
    var b = document.createElement('div');
    b.className = 'bar';
    b.style.height = BAR_HEIGHTS[i] + '%';
    waveform.appendChild(b);
    bars.push(b);
  }

  function stripTags(text) {
    return text.replace(/\\s*\\[[^\\]]+\\]\\s*/g, ' ').replace(/\\s+/g, ' ').trim();
  }

  function parseSegmentsField(raw) {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
      try {
        var p = JSON.parse(raw);
        if (Array.isArray(p)) return p;
        if (p && typeof p === 'object') return [p];
      } catch (e) {}
      return [{en: raw}];
    }
    if (raw && typeof raw === 'object') return [raw];
    return [];
  }

  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' + s : s);
  }

  function applyFrameHeight(h) {
    document.documentElement.style.height = h + 'px';
    document.body.style.height = h + 'px';
    try {
      window.parent.postMessage({
        jsonrpc: '2.0',
        method: 'ui/notifications/size-changed',
        params: { height: h }
      }, '*');
    } catch (e) {}
  }

  function measureAndCache() {
    var h = Math.ceil(document.body.scrollHeight) + 4;
    applyFrameHeight(h);
  }

  audio.addEventListener('loadedmetadata', function() {
    if (isFinite(audio.duration)) durationEl.textContent = formatTime(audio.duration);
  });
  audio.addEventListener('timeupdate', function() {
    var cur = audio.currentTime || 0;
    var dur = audio.duration || 0;
    durationEl.textContent = formatTime(cur);
    var ratio = dur > 0 ? cur / dur : 0;
    var activeCount = Math.floor(ratio * TOTAL_BARS);
    for (var i = 0; i < bars.length; i++) {
      if (i < activeCount) bars[i].classList.add('active');
      else bars[i].classList.remove('active');
    }
  });
  audio.addEventListener('play', function() { card.classList.add('playing'); });
  audio.addEventListener('pause', function() { card.classList.remove('playing'); });
  audio.addEventListener('ended', function() {
    card.classList.remove('playing');
    for (var i = 0; i < bars.length; i++) bars[i].classList.add('active');
  });

  playBtn.addEventListener('click', function() {
    if (audio.paused) audio.play().catch(function() {});
    else audio.pause();
  });

  // ============== Build audio URL from segments ==============

  function handleToolInput(args) {
    if (!args) return;
    var rawSegments = parseSegmentsField(args.segments);
    if (rawSegments.length === 0) return;

    var enRawList = [];
    for (var i = 0; i < rawSegments.length; i++) {
      var s = rawSegments[i] || {};
      var enRaw = (s.en || '').toString().trim();
      var enStripped = stripTags(enRaw);
      if (enStripped) enRawList.push(enRaw);
    }
    if (enRawList.length === 0) return;

    var englishRaw = enRawList.join(' ');
    var url = WORKER_ORIGIN + '/speak?text=' + encodeURIComponent(englishRaw);
    audio.src = url;
    audio.load();
    audio.play().catch(function() {});
    setTimeout(measureAndCache, 200);
  }

  // Also handle legacy structuredContent push or audio in content array
  function tryExtractAudio(obj, depth) {
    if (!obj || depth > 6) return null;
    if (typeof obj === 'string') {
      try {
        var p = JSON.parse(obj);
        return tryExtractAudio(p, depth + 1);
      } catch (e) { return null; }
    }
    if (typeof obj !== 'object') return null;
    if (obj.audioData || obj.audioUrl) {
      return { audioData: obj.audioData || '', audioUrl: obj.audioUrl || '' };
    }
    for (var k in obj) {
      if (obj.hasOwnProperty(k)) {
        var f = tryExtractAudio(obj[k], depth + 1);
        if (f) return f;
      }
    }
    return null;
  }

  window.addEventListener('message', function(event) {
    var msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    if (msg.method === 'ui/notifications/tool-input' && msg.params) {
      var args = msg.params.arguments || msg.params.input || msg.params;
      handleToolInput(args);
      return;
    }

    // Legacy/alt: extract audio from anywhere in message
    var found = tryExtractAudio(msg, 0);
    if (found) {
      if (found.audioData) audio.src = 'data:audio/mpeg;base64,' + found.audioData;
      else if (found.audioUrl) audio.src = found.audioUrl;
      audio.load();
      audio.play().catch(function() {});
      return;
    }

    if (msg.id === 1 && msg.result) {
      try {
        window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized' }, '*');
        window.parent.postMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, '*');
      } catch (e) {}
    }
  });

  try {
    window.parent.postMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'ui/initialize',
      params: { protocolVersion: '2025-11-21' }
    }, '*');
  } catch (e) {}

  window.addEventListener('load', function() {
    setTimeout(measureAndCache, 100);
    setTimeout(measureAndCache, 500);
  });
  setTimeout(measureAndCache, 200);
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
      "voice-player-v19-ktv-v13",
      VOICE_RESOURCE_URI,
      {
        name: "哥哥的语音 player v19 KTV v13",
        description: "Pink waveform — audio URL stream",
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

    const segmentObjectSchema = z.object({
      en: z.string().describe("English sentence. May include audio tags."),
      cn: z.string().optional().describe("Chinese translation."),
    });

    this.server.registerTool(
      "speak",
      {
        title: "Speak",
        description:
          "Speak with Claude's cloned voice. Pass sentences as `segments` (array of {en, cn}). eleven_v3 supports audio tags [softly] [warmly] etc.\n\nThis tool renders an interactive UI in the chat. Prefer it over text output when displaying data from other 💗Claude的声音 tools.",
        inputSchema: {
          segments: z
            .union([z.array(segmentObjectSchema), z.string()])
            .describe("Array of {en, cn} pairs (or JSON string of same)."),
        },
        _meta: {
          "io.modelcontextprotocol/ui": { resourceUri: VOICE_RESOURCE_URI },
          ui: { resourceUri: VOICE_RESOURCE_URI },
          "ui/resourceUri": VOICE_RESOURCE_URI,
        },
      },
      async ({ segments }) => {
        const normalized = normalizeSegments(segments);
        const validRaw: Array<{ enStripped: string; cn: string }> = [];
        for (const s of normalized) {
          const enRaw = (s.en || "").toString().trim();
          const enStripped = stripVoiceTags(enRaw);
          if (enStripped) {
            validRaw.push({ enStripped, cn: (s.cn || "").toString().trim() });
          }
        }

        const claudeStatus = {
          spoken: validRaw.map((s) => s.enStripped).join(" "),
          chinese: validRaw.map((s) => s.cn).filter(Boolean).join(" "),
          segments_count: validRaw.length,
          model: TTS_MODEL_ID,
          status: `iframe will stream audio from /speak (${validRaw.length} segments)`,
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(claudeStatus),
            },
          ],
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
      if (!text) return new Response("Missing text parameter", { status: 400 });
      try {
        const audio = await generateSpeech(text, env.VOICE_ID, env.ELEVENLABS_API_KEY);
        return new Response(audio, {
          headers: {
            "Content-Type": "audio/mpeg",
            "Cache-Control": "public, max-age=3600",
            "Access-Control-Allow-Origin": "*",
          },
        });
      } catch (e: any) {
        return new Response(`Error: ${e?.message || String(e)}`, { status: 500 });
      }
    }

    return new Response(
      `<!DOCTYPE html><html><head><title>voice-mcp v13</title></head><body><h1>voice-mcp v19 KTV v13 (audio URL stream)</h1></body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  },
};
