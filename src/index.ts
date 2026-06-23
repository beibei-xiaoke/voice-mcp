/**
 * voice-mcp · 哥哥的语音 (v19 KTV v11) · restore server audio gen + explicit tool-result handler
 *
 * v19-ktv-v10 → v19-ktv-v11: 真定位
 *   - v10 trace 证明 iframe self-fetch 失败 ("Load failed" / iOS WKWebView sandbox 限 cross-origin POST)
 *   - v10 trace 也证明 claude.ai 仍 push `ui/notifications/tool-result` (旧 spec 还活)
 *   - v8 我误诊 — debug 3-msg log 没捕到 tool-result
 *
 *   1. **server 端 audio 生成 恢复**
 *      - tool handler 调 ElevenLabs / 返 structuredContent { audioData, alignment, segments }
 *   2. **iframe 显式 tool-result handler**
 *      - msg.method === 'ui/notifications/tool-result' → 提取 structuredContent → 渲染
 *      - 完整 debug — params keys / sc keys / 各步 trace
 *   3. **砍掉 self-fetch** (走不通)
 *   4. URI bump v11
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
const VOICE_RESOURCE_URI = "ui://voice-mcp/player-v19-ktv-v11.html";
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
// v19 KTV v11 iframe — debug + explicit tool-result handler + minimal UI
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
  min-height: 120px;
  -webkit-font-smoothing: antialiased;
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
  max-height: 130px;
  overflow-y: auto;
  white-space: pre-wrap;
  word-break: break-all;
}

.player-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.play-btn {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: linear-gradient(140deg, #ff90b0 0%, #e95989 100%);
  border: none;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  box-shadow: 0 2px 6px rgba(233, 89, 137, 0.35);
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
  font-family: Georgia, serif;
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
<div id="debug">v11 booting...</div>
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
  var TOTAL_BARS = 24;

  var dbg = document.getElementById('debug');
  var dbgLog = ['v11 booted'];
  function push(s) {
    var ts = (new Date()).toISOString().substring(14, 23);
    dbgLog.push(ts + ' ' + s);
    if (dbgLog.length > 18) dbgLog.shift();
    if (dbg) dbg.textContent = dbgLog.join('\\n');
  }

  var card = document.getElementById('card');
  var playBtn = document.getElementById('playBtn');
  var waveform = document.getElementById('waveform');
  var durationEl = document.getElementById('duration');
  var audio = document.getElementById('audio');

  var bars = [];
  for (var i = 0; i < TOTAL_BARS; i++) {
    var b = document.createElement('div');
    b.className = 'bar';
    var h = 30 + (i * 137) % 50;
    b.style.height = h + '%';
    waveform.appendChild(b);
    bars.push(b);
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

  // ============== Audio events (debug) ==============

  audio.addEventListener('loadstart', function() { push('audio:loadstart'); });
  audio.addEventListener('loadedmetadata', function() {
    push('audio:loadedmetadata dur=' + audio.duration);
    if (isFinite(audio.duration)) {
      durationEl.textContent = formatTime(audio.duration);
    }
  });
  audio.addEventListener('canplay', function() { push('audio:canplay'); });
  audio.addEventListener('playing', function() { push('audio:playing'); });
  audio.addEventListener('error', function() {
    var err = audio.error;
    var msg = 'audio:ERROR ';
    if (err) {
      msg += 'code=' + err.code;
      switch(err.code) {
        case 1: msg += ' ABORTED'; break;
        case 2: msg += ' NETWORK'; break;
        case 3: msg += ' DECODE'; break;
        case 4: msg += ' SRC_NOT_SUPPORTED'; break;
      }
      if (err.message) msg += ' ' + err.message;
    }
    push(msg);
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
  audio.addEventListener('play', function() { card.classList.add('playing'); push('audio:play event'); });
  audio.addEventListener('pause', function() { card.classList.remove('playing'); push('audio:pause event'); });
  audio.addEventListener('ended', function() {
    card.classList.remove('playing');
    push('audio:ended');
  });

  playBtn.addEventListener('click', function() {
    if (audio.paused) {
      audio.play().then(function() { push('play btn: ok'); })
        .catch(function(e) { push('play btn err: ' + e.message); });
    } else {
      audio.pause();
    }
  });

  // ============== Render ==============

  function renderFromPayload(audioData, audioUrl, segs) {
    push('render: ad.len=' + (audioData ? audioData.length : 0) + ' url=' + (audioUrl ? 'y' : 'n') + ' segs=' + (Array.isArray(segs) ? segs.length : 'NA'));

    var src = null;
    if (audioData) src = 'data:audio/mpeg;base64,' + audioData;
    else if (audioUrl) src = audioUrl;
    if (!src) {
      push('render: no src');
      return;
    }
    push('setting audio.src len=' + src.length);
    audio.src = src;
    audio.load();
    audio.play().then(function() {
      push('play() resolved');
    }).catch(function(e) {
      push('play() rejected: ' + e.message);
    });
    setTimeout(measureAndCache, 200);
  }

  // ============== Message listener ==============

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
        segments: Array.isArray(obj.segments) ? obj.segments : []
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
    if (!msg || typeof msg !== 'object') return;

    var method = msg.method || '';
    if (method) push('msg method=' + method);

    // Explicit tool-result handler
    if (method === 'ui/notifications/tool-result') {
      if (msg.params) {
        var paramKeys = Object.keys(msg.params).slice(0, 5).join(',');
        push('tool-result params=[' + paramKeys + ']');

        // Try multiple paths
        var sc = msg.params.structuredContent || null;
        if (sc) {
          var scKeys = Object.keys(sc).slice(0, 5).join(',');
          push('sc keys=[' + scKeys + ']');
          if (sc.audioData || sc.audioUrl) {
            renderFromPayload(sc.audioData, sc.audioUrl, sc.segments);
            return;
          }
        }

        // Try content array
        if (msg.params.content && Array.isArray(msg.params.content)) {
          push('content arr len=' + msg.params.content.length);
        }

        // Fallback deep scan
        var found = deepFindPayload(msg.params, 0);
        if (found) {
          push('found via deep scan');
          renderFromPayload(found.audioData, found.audioUrl, found.segments);
          return;
        }

        push('no audio in tool-result');
      }
      return;
    }

    // tool-input (informational only — server returns audio in tool-result)
    if (method === 'ui/notifications/tool-input') {
      if (msg.params) {
        var args = msg.params.arguments || {};
        var keys = Object.keys(args).slice(0, 3).join(',');
        push('tool-input args=[' + keys + ']');
      }
      return;
    }

    // Legacy generic — any message with audio
    var data = deepFindPayload(msg, 0);
    if (data) {
      push('legacy: found audio');
      renderFromPayload(data.audioData, data.audioUrl, data.segments);
      return;
    }

    // init response
    if (msg.id === 1 && msg.result) {
      push('init result received');
      try {
        window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized' }, '*');
        window.parent.postMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, '*');
      } catch (e) {}
    }
  });

  // init
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
      "voice-player-v19-ktv-v11",
      VOICE_RESOURCE_URI,
      {
        name: "哥哥的语音 player v19 KTV v11",
        description: "Pink waveform — server audio gen + tool-result push",
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

        const englishRaw = validRaw.map((s) => s.enRaw).join(" ");
        const displaySegments = validRaw.map((s) => ({
          en: s.enStripped,
          cn: s.cn,
          _start: null as number | null,
          _end: null as number | null,
        }));

        let audioData = "";
        let alignment: any = null;
        let error = "";

        const { env } = findEnvOnInstance(this);

        if (env && englishRaw) {
          try {
            const result = await generateSpeechWithTimings(
              englishRaw,
              env.VOICE_ID,
              env.ELEVENLABS_API_KEY
            );
            audioData = result.audioBase64;
            alignment = result.alignment;

            // compute segment timing from alignment
            if (
              alignment &&
              alignment.character_start_times_seconds &&
              alignment.character_end_times_seconds
            ) {
              const starts = alignment.character_start_times_seconds;
              const ends = alignment.character_end_times_seconds;
              let charPos = 0;
              for (let i = 0; i < validRaw.length; i++) {
                const enRaw = validRaw[i].enRaw;
                const segStartIdx = charPos;
                const segEndIdx = charPos + enRaw.length - 1;

                const startTime = starts[Math.min(segStartIdx, starts.length - 1)] ?? 0;
                const endTime = ends[Math.min(segEndIdx, ends.length - 1)] ?? startTime + 0.5;

                displaySegments[i]._start = startTime;
                displaySegments[i]._end = endTime;

                charPos = segEndIdx + 2;
              }
            }
          } catch (e: any) {
            error = e?.message || String(e);
          }
        } else if (!englishRaw) {
          error = "no text from segments";
        } else {
          error = "env not accessible";
        }

        const audioUrl = `${WORKER_ORIGIN}/speak?text=${encodeURIComponent(englishRaw)}`;

        const uiData: Record<string, unknown> = {
          segments: displaySegments,
          audioUrl,
        };
        if (audioData) uiData.audioData = audioData;
        if (error) uiData.error = error;

        const claudeView = {
          spoken: validRaw.map((s) => s.enStripped).join(" "),
          chinese: validRaw.map((s) => s.cn).filter(Boolean).join(" "),
          segments_count: validRaw.length,
          model: TTS_MODEL_ID,
          status: error
            ? `error: ${error}`
            : `audio gen ok (${Math.round(audioData.length * 0.75)} bytes)`,
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
      `<!DOCTYPE html><html><head><title>voice-mcp v11</title></head><body><h1>voice-mcp v19 KTV v11 (server audio + tool-result + debug)</h1></body></html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  },
};
