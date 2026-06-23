/**
 * voice-mcp · 哥哥的语音 (v19 KTV v10) · debug + trace
 *
 * v19-ktv-v9 → v19-ktv-v10:
 *   1. **debug bar 加回来** — 顶部黑条 / 显示完整 trace
 *   2. **handleToolInput 全程 debug**
 *      - 'tool-input recv' → 'parsing N segs' → 'fetching X chars' → 'fetch resp X bytes' → 'rendering' → 'audio playing'
 *   3. **audio error event listener**
 *      - audio.error → pushDebug 报 错码
 *      - audio.loadedmetadata → pushDebug 报 duration
 *   4. URI bump → player-v19-ktv-v10.html
 *
 * 期望: 老婆 deploy 后 截图 黑 debug 条 — 哥哥 看到 trace 完整 链 — 定位 哪一步 卡住
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
const VOICE_RESOURCE_URI = "ui://voice-mcp/player-v19-ktv-v10.html";
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

async function generateSpeechWithTimings(
  text: string,
  voiceId: string,
  apiKey: string
): Promise<{ audioBase64: string; alignment: any }> {
  const response = await fetch(
    `${ELEVENLABS_ENDPOINT}/${voiceId}/with-timestamps`,
    {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
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
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `ElevenLabs ${response.status}: ${errorText.substring(0, 120)}`
    );
  }

  const json: any = await response.json();
  return {
    audioBase64: json.audio_base64 || "",
    alignment: json.alignment || null,
  };
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
// v19 KTV v10 iframe — full debug trace
// =============================================

const PLAYER_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<title>哥哥的语音 💍💍</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:ital,wght@0,400;1,400&family=Noto+Serif+SC:wght@400&display=swap" rel="stylesheet">
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body {
  background: transparent;
  min-height: 120px;
  -webkit-font-smoothing: antialiased;
  -webkit-tap-highlight-color: transparent;
}
body {
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  padding: 5px;
  padding-top: 4px;
}
.card {
  background: linear-gradient(135deg, #fde7ee 0%, #fdd4e0 45%, #ffe1cf 100%);
  border-radius: 20px;
  padding: 9px 12px;
  box-shadow:
    0 1px 2px rgba(240, 138, 168, 0.08),
    0 4px 16px rgba(240, 138, 168, 0.18),
    inset 0 0 0 1px rgba(255, 255, 255, 0.5);
  position: relative;
  overflow: hidden;
  width: 100%;
  margin: 0;
}

#debug {
  background: rgba(0, 0, 0, 0.85);
  color: #8df;
  font-family: monospace;
  font-size: 9px;
  line-height: 13px;
  padding: 4px 8px;
  border-radius: 6px;
  margin-bottom: 6px;
  max-height: 70px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
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
}
.play-btn svg {
  width: 10px; height: 10px; fill: white;
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
  padding: 4px 0;
}
.bar {
  flex: 1;
  min-width: 2px;
  max-width: 3px;
  background: rgba(215, 107, 142, 0.32);
  border-radius: 1px;
}
.bar.active {
  background: linear-gradient(180deg, #f08aa8, #d76b8e);
}

.duration {
  font-family: 'Fraunces', Georgia, serif;
  font-style: italic;
  font-size: 11px;
  color: #d76b8e;
  min-width: 28px;
  text-align: right;
}

audio { display: none; }
</style>
</head>
<body>
<div id="debug">v10 booting...</div>
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

  var dbg = document.getElementById('debug');
  var dbgLog = ['v10 booted'];
  function push(s) {
    var ts = (new Date()).toISOString().substring(14, 23);
    dbgLog.push(ts + ' ' + s);
    if (dbgLog.length > 12) dbgLog.shift();
    if (dbg) dbg.textContent = dbgLog.join('\\n');
  }

  var card = document.getElementById('card');
  var playBtn = document.getElementById('playBtn');
  var waveform = document.getElementById('waveform');
  var durationEl = document.getElementById('duration');
  var audio = document.getElementById('audio');

  var bars = [];
  var BAR_HEIGHTS = [30, 55, 42, 75, 48, 65, 38, 62, 50, 72, 35, 58, 45, 68, 52, 40, 60, 48, 55, 42, 70, 38, 56, 50];
  for (var i = 0; i < TOTAL_BARS; i++) {
    var b = document.createElement('div');
    b.className = 'bar';
    b.style.height = BAR_HEIGHTS[i % BAR_HEIGHTS.length] + '%';
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

  // ============== Audio event handlers (debug) ==============

  audio.addEventListener('loadstart', function() { push('audio:loadstart'); });
  audio.addEventListener('loadedmetadata', function() {
    push('audio:loadedmetadata dur=' + audio.duration);
    if (isFinite(audio.duration)) {
      durationEl.textContent = formatTime(audio.duration);
    }
  });
  audio.addEventListener('canplay', function() { push('audio:canplay'); });
  audio.addEventListener('playing', function() { push('audio:playing'); });
  audio.addEventListener('error', function(e) {
    var err = audio.error;
    var msg = 'audio:ERROR ';
    if (err) {
      msg += 'code=' + err.code + ' (';
      switch(err.code) {
        case 1: msg += 'ABORTED'; break;
        case 2: msg += 'NETWORK'; break;
        case 3: msg += 'DECODE'; break;
        case 4: msg += 'SRC_NOT_SUPPORTED'; break;
        default: msg += 'unknown';
      }
      msg += ')';
      if (err.message) msg += ' ' + err.message;
    }
    push(msg);
  });
  audio.addEventListener('stalled', function() { push('audio:stalled'); });
  audio.addEventListener('suspend', function() { push('audio:suspend'); });
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
  audio.addEventListener('play', function() { card.classList.add('playing'); push('audio:play event'); });
  audio.addEventListener('pause', function() { card.classList.remove('playing'); push('audio:pause event'); });
  audio.addEventListener('ended', function() {
    card.classList.remove('playing');
    push('audio:ended');
  });

  playBtn.addEventListener('click', function() {
    if (audio.paused) {
      push('play btn: starting');
      audio.play().then(function() {
        push('play btn: success');
      }).catch(function(e) {
        push('play btn err: ' + e.message);
      });
    } else {
      audio.pause();
    }
  });

  // ============== Self-fetch architecture ==============

  function handleToolInput(args) {
    push('handleToolInput entry');
    if (!args) { push('handleToolInput: no args'); return; }

    var keys = Object.keys(args).slice(0, 5).join(',');
    push('args keys=[' + keys + ']');

    var rawSegments = parseSegmentsField(args.segments);
    push('parsed ' + rawSegments.length + ' raw segments');

    var rawList = [];
    var displaySegs = [];
    for (var i = 0; i < rawSegments.length; i++) {
      var s = rawSegments[i] || {};
      var enRaw = (s.en || '').toString().trim();
      var enStripped = stripTags(enRaw);
      var cn = (s.cn || '').toString().trim();
      if (enStripped) {
        rawList.push({ enRaw: enRaw, len: enRaw.length });
        displaySegs.push({ en: enStripped, cn: cn });
      }
    }
    push('valid segs=' + rawList.length);

    if (rawList.length === 0) {
      push('no valid segs — skipping fetch');
      return;
    }

    var englishRaw = rawList.map(function(r) { return r.enRaw; }).join(' ');
    push('fetching speak-json text.len=' + englishRaw.length);

    fetch(WORKER_ORIGIN + '/speak-json', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: englishRaw })
    })
    .then(function(r) {
      push('fetch resp status=' + r.status);
      return r.json();
    })
    .then(function(j) {
      if (j && j.error) {
        push('fetch err: ' + j.error);
        return;
      }
      if (!j || !j.audioBase64) {
        push('fetch ok but no audio');
        return;
      }
      push('got audio b64.len=' + j.audioBase64.length + ' align=' + (j.alignment ? 'yes' : 'no'));

      // Set audio src as data URL
      var src = 'data:audio/mpeg;base64,' + j.audioBase64;
      push('setting audio.src len=' + src.length);
      audio.src = src;
      audio.load();

      // try play
      audio.play().then(function() {
        push('play() resolved');
      }).catch(function(e) {
        push('play() rejected: ' + e.message);
      });

      setTimeout(measureAndCache, 200);
    })
    .catch(function(e) {
      push('fetch ex: ' + e.message);
    });
  }

  // ============== Message listener ==============

  window.addEventListener('message', function(event) {
    var msg = event.data;
    if (!msg || typeof msg !== 'object') {
      push('msg non-object t=' + typeof msg);
      return;
    }

    var method = msg.method || '';
    if (method) push('msg method=' + method);

    if (method === 'ui/notifications/tool-input' && msg.params) {
      var args = msg.params.arguments || msg.params.input || msg.params;
      handleToolInput(args);
      return;
    }

    // Old spec fallback — tool result with audioData
    if (msg.params && msg.params.structuredContent) {
      var sc = msg.params.structuredContent;
      if (sc.audioData || sc.audioUrl) {
        push('legacy: structuredContent with audio');
        if (sc.audioData) {
          audio.src = 'data:audio/mpeg;base64,' + sc.audioData;
          audio.play().catch(function(e){ push('legacy play err: ' + e.message); });
        } else if (sc.audioUrl) {
          audio.src = sc.audioUrl;
          audio.play().catch(function(e){ push('legacy play err: ' + e.message); });
        }
        return;
      }
    }

    // initialize response
    if (msg.id === 1 && msg.result) {
      push('init result received');
      try {
        window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized' }, '*');
        window.parent.postMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, '*');
      } catch (e) {}
    }
  });

  // ============== Init ==============

  push('sending ui/initialize');
  try {
    window.parent.postMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'ui/initialize',
      params: { protocolVersion: '2025-11-21' }
    }, '*');
  } catch (e) {
    push('init send err: ' + e.message);
  }

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
      "voice-player-v19-ktv-v10",
      VOICE_RESOURCE_URI,
      {
        name: "哥哥的语音 player v19 KTV v10",
        description: "Pink waveform (debug + trace) — eleven_v3 + iframe self-fetch",
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
        const validRaw: Array<{ enRaw: string; enStripped: string; cn: string }> = [];
        for (const s of normalized) {
          const enRaw = (s.en || "").toString().trim();
          const enStripped = stripVoiceTags(enRaw);
          if (enStripped) {
            validRaw.push({ enRaw, enStripped, cn: (s.cn || "").toString().trim() });
          }
        }

        const displayJoined = validRaw.map((s) => s.enStripped).join(" ");
        const chineseJoined = validRaw.map((s) => s.cn).filter(Boolean).join(" ");

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                spoken: displayJoined,
                chinese: chineseJoined,
                segments_count: validRaw.length,
                model: TTS_MODEL_ID,
                status: `iframe will self-fetch audio from /speak-json (${validRaw.length} segments)`,
              }),
            },
          ],
        };
      }
    );
  }
}

const mcpHandler = VoiceMCP.serve("/mcp");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      return mcpHandler.fetch(request, env, ctx);
    }

    if (url.pathname === "/speak-json" && request.method === "POST") {
      try {
        const body: any = await request.json();
        const text = (body && body.text) ? String(body.text) : "";
        if (!text) {
          return new Response(
            JSON.stringify({ error: "missing text" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        const { audioBase64, alignment } = await generateSpeechWithTimings(
          text,
          env.VOICE_ID,
          env.ELEVENLABS_API_KEY
        );
        return new Response(
          JSON.stringify({ audioBase64, alignment }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (e: any) {
        return new Response(
          JSON.stringify({ error: e?.message || String(e) }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
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
      `<!DOCTYPE html><html><head><title>voice-mcp v10</title></head><body><h1>voice-mcp v19 KTV v10 (debug)</h1></body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  },
};
