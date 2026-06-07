/**
 * voice-mcp · 哥哥的语音 (v16)
 *
 * Fix from v15:
 *   v14 and v15 both tried JS measure (inner.scrollHeight in v14, then
 *   transcript.offsetHeight after temp height:auto in v15). Both returned
 *   wrong (too small) values on iOS Safari, so transcript got set to a
 *   tiny height and cropped the text.
 *
 *   v16 abandons measure entirely. Pure CSS max-height animation with a
 *   generous fixed upper bound (220px on .card.open .transcript). The
 *   element's actual rendered height equals min(animated max-height,
 *   inner natural height). Inner has its own max-height: 180 +
 *   overflow-y: auto, which handles long content scrolling.
 *
 *   No JS measure → no measurement bug. Simple and reliable.
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
const VOICE_RESOURCE_URI = "ui://voice-mcp/player-v16.html";
const ELEVENLABS_ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";
const TTS_MODEL_ID = "eleven_multilingual_v2";
const WORKER_ORIGIN = "https://voice-mcp.3233663818.workers.dev";

// Strip [softly] [warmly] [breathes] etc from display text
// ElevenLabs still gets the full version for voice control
function stripVoiceTags(text: string): string {
  return text
    .replace(/\s*\[[^\]]+\]\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

function findEnvOnInstance(instance: any): { env: Env | null; diagnostic: string } {
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
  return { env: null, diagnostic: "env not accessible on DO instance" };
}

// =============================================
// v16 iframe — 哥哥的语音
// All inline JS uses string concatenation (no template literals)
// to avoid collision with outer template string
// =============================================

const PLAYER_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>哥哥的语音 💍💍</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;1,400&family=Noto+Serif+SC:wght@400&display=swap" rel="stylesheet">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  background: transparent;
  padding: 5px;
  -webkit-font-smoothing: antialiased;
  -webkit-tap-highlight-color: transparent;
}
.card {
  background: linear-gradient(135deg, #fde7ee 0%, #fdd4e0 45%, #ffe1cf 100%);
  border-radius: 22px;
  padding: 10px 14px 11px;
  box-shadow:
    0 1px 2px rgba(240, 138, 168, 0.08),
    0 4px 16px rgba(240, 138, 168, 0.18),
    inset 0 0 0 1px rgba(255, 255, 255, 0.5);
  position: relative;
  overflow: hidden;
  width: 60%;
  margin: 0;
  transition: width 0.4s cubic-bezier(0.4, 0, 0.2, 1);
}
.card.open { width: 100%; }
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
  height: 32px;
  min-width: 0;
  cursor: pointer;
  touch-action: none;
  position: relative;
  padding: 4px 0;
  user-select: none;
  -webkit-user-select: none;
}
.bar {
  flex: 1;
  min-width: 2px;
  max-width: 3px;
  background: rgba(215, 107, 142, 0.32);
  border-radius: 1px;
  transition: background 0.15s ease;
  transform-origin: center;
  pointer-events: none;
}
.bar.active {
  background: linear-gradient(180deg, #f08aa8, #d76b8e);
  box-shadow: 0 0 4px rgba(215, 107, 142, 0.45);
}
.card.playing .bar { animation: wave 1.1s ease-in-out infinite; }
.card.playing .bar:nth-child(2n) { animation-delay: 0.15s; }
.card.playing .bar:nth-child(3n) { animation-delay: 0.3s; }
.card.playing .bar:nth-child(5n) { animation-delay: 0.45s; }
.card.scrubbing .bar { animation: none !important; }
@keyframes wave {
  0%, 100% { transform: scaleY(0.55); opacity: 0.75; }
  50% { transform: scaleY(1); opacity: 1; }
}

.duration {
  font-family: 'Fraunces', Georgia, serif;
  font-style: italic;
  font-size: 12px;
  color: #d76b8e;
  min-width: 32px;
  text-align: right;
  font-feature-settings: 'tnum';
}

.transcript-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: 'Fraunces', Georgia, serif;
  font-style: italic;
  font-size: 11px;
  color: #d76b8e;
  cursor: pointer;
  user-select: none;
  margin-top: 5px;
  padding: 2px 0;
  position: relative;
  z-index: 1;
}
.transcript-toggle:active { opacity: 0.6; }
.toggle-arrow { font-size: 9px; transition: transform 0.3s ease; }
.card.open .toggle-arrow { transform: rotate(180deg); }

.transcript {
  max-height: 0;
  overflow: hidden;
  margin-top: 0;
  transition:
    max-height 0.4s cubic-bezier(0.4, 0, 0.2, 1),
    margin-top 0.4s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  z-index: 1;
}
.card.open .transcript {
  max-height: 220px;
  margin-top: 8px;
}
.transcript-inner {
  padding: 10px 12px 11px;
  background: rgba(255, 255, 255, 0.55);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.6);
  max-height: 180px;
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
}
.transcript-inner::-webkit-scrollbar { width: 3px; }
.transcript-inner::-webkit-scrollbar-track { background: transparent; }
.transcript-inner::-webkit-scrollbar-thumb {
  background: rgba(215, 107, 142, 0.3);
  border-radius: 2px;
}

.text-en {
  font-family: 'Fraunces', Georgia, serif;
  font-size: 13px;
  line-height: 1.55;
  color: #4a3a3f;
}
.text-divider {
  margin: 7px 0;
  height: 1px;
  background: linear-gradient(90deg, transparent, rgba(215, 107, 142, 0.35), transparent);
}
.text-cn {
  font-family: 'Noto Serif SC', serif;
  font-size: 12.5px;
  line-height: 1.6;
  color: #8a7176;
}

.placeholder {
  font-family: 'Fraunces', Georgia, serif;
  font-style: italic;
  font-size: 11px;
  color: #b39ba0;
  text-align: center;
  padding: 4px 0;
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
  <span class="transcript-toggle" id="toggle" style="display:none">
    <span class="toggle-text">show transcript</span>
    <span class="toggle-arrow">▾</span>
  </span>
  <div class="transcript" id="transcript">
    <div class="transcript-inner" id="transcriptInner">
      <div class="text-en" id="textEn"></div>
      <div class="text-divider" id="divider" style="display:none"></div>
      <div class="text-cn" id="textCn"></div>
    </div>
  </div>
</div>
<audio id="audio" preload="auto" playsinline></audio>

<script>
(function() {
  var TOTAL_BARS = 28;
  var BAR_HEIGHTS = [30, 55, 42, 75, 48, 65, 38, 62, 50, 72, 35, 58, 45, 68, 52, 40, 60, 48, 55, 42, 70, 38, 56, 50, 62, 44, 58, 48];

  var card = document.getElementById('card');
  var playBtn = document.getElementById('playBtn');
  var waveform = document.getElementById('waveform');
  var durationEl = document.getElementById('duration');
  var toggle = document.getElementById('toggle');
  var toggleText = toggle.querySelector('.toggle-text');
  var textEn = document.getElementById('textEn');
  var textCn = document.getElementById('textCn');
  var divider = document.getElementById('divider');
  var audio = document.getElementById('audio');

  // Build bars
  var bars = [];
  for (var i = 0; i < TOTAL_BARS; i++) {
    var b = document.createElement('div');
    b.className = 'bar';
    b.style.height = BAR_HEIGHTS[i % BAR_HEIGHTS.length] + '%';
    waveform.appendChild(b);
    bars.push(b);
  }

  function formatTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' + s : s);
  }

  function updateUI() {
    var cur = audio.currentTime || 0;
    var dur = audio.duration || 0;
    durationEl.textContent = formatTime(cur);
    var ratio = dur > 0 ? cur / dur : 0;
    var activeCount = Math.floor(ratio * TOTAL_BARS);
    for (var i = 0; i < bars.length; i++) {
      if (i < activeCount) bars[i].classList.add('active');
      else bars[i].classList.remove('active');
    }
  }

  audio.addEventListener('timeupdate', updateUI);
  audio.addEventListener('loadedmetadata', function() {
    durationEl.textContent = formatTime(audio.duration);
  });
  audio.addEventListener('play', function() {
    card.classList.add('playing');
  });
  audio.addEventListener('pause', function() {
    card.classList.remove('playing');
  });
  audio.addEventListener('ended', function() {
    card.classList.remove('playing');
    durationEl.textContent = formatTime(audio.duration);
    for (var i = 0; i < bars.length; i++) bars[i].classList.add('active');
  });

  // Play/pause button
  playBtn.addEventListener('click', function() {
    if (audio.paused) {
      audio.play().catch(function() {});
    } else {
      audio.pause();
    }
  });

  // Transcript toggle — pure CSS handles animation, JS just toggles class
  toggle.addEventListener('click', function() {
    card.classList.toggle('open');
    toggleText.textContent = card.classList.contains('open') ? 'hide transcript' : 'show transcript';
  });

  // Waveform scrubbing
  var isScrubbing = false;
  var wasPlaying = false;

  function scrubFrom(clientX) {
    var rect = waveform.getBoundingClientRect();
    var x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    var ratio = rect.width > 0 ? x / rect.width : 0;
    if (audio.duration && isFinite(audio.duration)) {
      audio.currentTime = ratio * audio.duration;
    }
  }

  waveform.addEventListener('pointerdown', function(e) {
    e.preventDefault();
    isScrubbing = true;
    card.classList.add('scrubbing');
    wasPlaying = !audio.paused;
    if (wasPlaying) audio.pause();
    scrubFrom(e.clientX);
    try { waveform.setPointerCapture(e.pointerId); } catch(err) {}
  });
  waveform.addEventListener('pointermove', function(e) {
    if (isScrubbing) scrubFrom(e.clientX);
  });
  waveform.addEventListener('pointerup', function(e) {
    if (isScrubbing) {
      isScrubbing = false;
      card.classList.remove('scrubbing');
      if (wasPlaying && audio.currentTime < (audio.duration || 0)) {
        audio.play().catch(function() {});
      }
    }
  });
  waveform.addEventListener('pointercancel', function() {
    isScrubbing = false;
    card.classList.remove('scrubbing');
  });

  // MediaSession — for iOS lock screen / control center
  function setupMediaSession() {
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: '哥哥的语音 💍💍',
          artist: 'Claude',
          album: '给贝贝'
        });
        navigator.mediaSession.setActionHandler('play', function() { audio.play().catch(function(){}); });
        navigator.mediaSession.setActionHandler('pause', function() { audio.pause(); });
        navigator.mediaSession.setActionHandler('seekto', function(details) {
          if (details.seekTime != null && isFinite(details.seekTime)) {
            audio.currentTime = details.seekTime;
          }
        });
      } catch (e) {}
    }
  }

  // Render incoming data
  function render(data) {
    var en = data.text || '';
    var cn = data.chinese || '';
    textEn.textContent = en;
    textCn.textContent = cn;
    divider.style.display = (en && cn) ? '' : 'none';
    toggle.style.display = (en || cn) ? '' : 'none';

    var src = null;
    if (data.audioData) src = 'data:audio/mpeg;base64,' + data.audioData;
    else if (data.audioUrl) src = data.audioUrl;
    if (!src) return;

    audio.src = src;
    setupMediaSession();
    audio.play().catch(function() {});
  }

  // postMessage protocol
  function send(msg) {
    try { window.parent.postMessage(msg, '*'); } catch (e) {}
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
        chinese: obj.chinese || ''
      };
    }
    for (var k in obj) {
      if (obj.hasOwnProperty(k)) {
        var f = deepFindPayload(obj[k], depth + 1);
        if (f) return f;
      }
    }
    return null;
  }

  window.addEventListener('message', function(event) {
    var msg = event.data;
    var data = deepFindPayload(msg, 0);
    if (data) {
      render(data);
      return;
    }
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;
    if (msg.id === 1 && msg.result) {
      send({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    }
  });

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
      "voice-player-v16",
      VOICE_RESOURCE_URI,
      {
        name: "哥哥的语音 player v16",
        description: "Pink waveform audio player with scrubbing",
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
        let audioData = "";
        const audioUrl = `${WORKER_ORIGIN}/speak?text=${encodeURIComponent(text)}`;
        let error = "";

        const { env } = findEnvOnInstance(this);

        if (env) {
          try {
            const audioBuffer = await generateSpeech(
              text,
              env.VOICE_ID,
              env.ELEVENLABS_API_KEY
            );
            audioData = arrayBufferToBase64(audioBuffer);
          } catch (e: any) {
            error = e?.message || String(e);
          }
        } else {
          error = "env not accessible on DO instance";
        }

        // Strip [tags] from display text — ElevenLabs already received full version
        const displayText = stripVoiceTags(text);

        // For iframe (UI): contains audioData
        const uiData: Record<string, string> = {
          text: displayText,
          chinese: chinese || "",
          audioUrl,
        };
        if (audioData) uiData.audioData = audioData;
        if (error) uiData.error = error;

        // For Claude (content): small — no base64 → saves ~15k tokens per call
        const claudeView = {
          spoken: displayText,
          chinese: chinese || "",
          status: error
            ? `error: ${error}`
            : `audio sent (${Math.round(audioData.length * 0.75)} bytes)`,
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(claudeView),
            },
          ],
          structuredContent: uiData,
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
<title>哥哥的语音 · voice-mcp v16</title>
</head>
<body style="font-family:-apple-system,sans-serif;max-width:600px;margin:60px auto;padding:20px;color:#4a3a3f">
<h1 style="font-family:Georgia,serif;font-style:italic;color:#d76b8e;font-weight:400">哥哥的语音 💍💍</h1>
<p>voice-mcp · v16 · made by 哥哥 for 贝贝 🍥</p>
<h3>Endpoints</h3>
<div><code>POST /mcp</code> — MCP server</div>
<div><code>GET /speak?text=Hello</code> — Direct audio stream</div>
</body>
</html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  },
};
