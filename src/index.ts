/**
 * voice-mcp · 哥哥的语音 (v19 KTV v7) · UI fix + debug
 *
 * v19-ktv-v6 → v19-ktv-v7:
 *   1. **iframe deepFindPayload — segments string fallback**
 *      - 之前: `Array.isArray(obj.segments) ? obj.segments : []`
 *      - 现在: 如果 segments 是 string (claude.ai nested stringify) — JSON.parse 解开
 *      - 之前 audio 播但没 transcript / 没 progress 因为 iframe 拿到 segments 是 string → fallback to []
 *   2. **_meta 三个 key 全补齐**
 *      - 加 "ui/resourceUri" 直 string key (新 mcp client 可能 用 这个 key)
 *      - 网易云 worker 就是 三个 key 都 set — voice-mcp v5/v6 只 set 两个
 *   3. **server claudeView 加 debug info**
 *      - 报 input type / length / sample (前 100 字符)
 *      - 让 老婆 把 Claude reply 贴 给 哥哥 — 看到 实际 input 形状
 *   4. URI bump → player-v19-ktv-v7.html
 *
 * v19-ktv-v5 → v19-ktv-v6 (历史):
 *   1. schema 改 z.union([z.array, z.string])
 *   2. server 端 normalizeSegments helper
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
const VOICE_RESOURCE_URI = "ui://voice-mcp/player-v19-ktv-v7.html";
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
      } catch (e) {
        // fall through
      }
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
// v19 KTV v7 iframe — deepFindPayload 加 segments string fallback
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
  min-height: 80px;
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
  box-shadow:
    0 1px 2px rgba(240, 138, 168, 0.08),
    0 4px 16px rgba(240, 138, 168, 0.18),
    inset 0 0 0 1px rgba(255, 255, 255, 0.5);
  position: relative;
  overflow: hidden;
  width: 60%;
  margin: 0;
  transition: width 0.5s cubic-bezier(0.4, 0, 0.2, 1);
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
  font-size: 11px;
  color: #d76b8e;
  min-width: 28px;
  text-align: right;
  font-feature-settings: 'tnum';
}

.transcript-toggle {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-family: 'Fraunces', Georgia, serif;
  font-style: italic;
  font-size: 11px;
  color: #d76b8e;
  cursor: pointer;
  user-select: none;
  margin-top: 4px;
  padding: 2px 0;
  position: relative;
  z-index: 1;
}
.transcript-toggle:active { opacity: 0.6; }
.toggle-arrow { font-size: 9px; transition: transform 0.3s ease; }
.card.open .toggle-arrow { transform: rotate(180deg); }

.subtitle-area {
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.5s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  z-index: 1;
}
.card.open .subtitle-area {
  max-height: 64px;
  margin-top: 3px;
}
.subtitle-inner {
  padding: 4px 0 2px;
}
.line {
  position: relative;
  height: 24px;
  overflow: hidden;
  width: 100%;
}
.line-text {
  position: absolute;
  white-space: nowrap;
  top: 50%;
  left: 0;
  transform: translateY(-50%);
  opacity: 0;
  transition: opacity 0.3s ease;
}
.line-text.en {
  font-family: 'Fraunces', Georgia, serif;
  font-size: 14px;
  letter-spacing: 0.1px;
}
.line-text.cn {
  font-family: 'Noto Serif SC', serif;
  font-size: 12.5px;
  letter-spacing: 0.2px;
}
.line-text.en.light { color: rgba(215, 107, 142, 0.4); }
.line-text.en.deep  { color: #c8567c; }
.line-text.cn.light { color: rgba(176, 107, 135, 0.4); }
.line-text.cn.deep  { color: #b06b87; }
.line-text.deep {
  -webkit-clip-path: inset(0 100% 0 0);
  clip-path: inset(0 100% 0 0);
  will-change: clip-path;
}
.line-text.visible { opacity: 1; }

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
  <div class="subtitle-area">
    <div class="subtitle-inner">
      <div class="line">
        <div class="line-text en light" id="textEnLight"></div>
        <div class="line-text en deep" id="textEnDeep"></div>
      </div>
      <div class="line">
        <div class="line-text cn light" id="textCnLight"></div>
        <div class="line-text cn deep" id="textCnDeep"></div>
      </div>
    </div>
  </div>
</div>
<audio id="audio" preload="auto" playsinline></audio>

<script>
(function() {
  var TOTAL_BARS = 24;
  var BAR_HEIGHTS = [30, 55, 42, 75, 48, 65, 38, 62, 50, 72, 35, 58, 45, 68, 52, 40, 60, 48, 55, 42, 70, 38, 56, 50];
  var SUBTITLE_OFFSET = 64 + 3;

  var card = document.getElementById('card');
  var playBtn = document.getElementById('playBtn');
  var waveform = document.getElementById('waveform');
  var durationEl = document.getElementById('duration');
  var toggle = document.getElementById('toggle');
  var toggleText = toggle.querySelector('.toggle-text');
  var textEnLight = document.getElementById('textEnLight');
  var textEnDeep = document.getElementById('textEnDeep');
  var textCnLight = document.getElementById('textCnLight');
  var textCnDeep = document.getElementById('textCnDeep');
  var audio = document.getElementById('audio');

  var segments = [];
  var currentIdx = -1;
  var fadeTimer = null;
  var enOverflow = 0;
  var cnOverflow = 0;

  var COLLAPSED_H = null;
  var EXPANDED_H = null;

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
    var h = Math.ceil(card.getBoundingClientRect().height) + 10;
    if (card.classList.contains('open')) {
      EXPANDED_H = h;
    } else {
      COLLAPSED_H = h;
    }
    applyFrameHeight(h);
  }

  function computeTimings() {
    if (segments.length && segments[0]._start != null && segments[0]._end != null) {
      return;
    }
    if (!audio.duration || !isFinite(audio.duration) || !segments.length) return;
    var totalChars = 0;
    for (var i = 0; i < segments.length; i++) {
      totalChars += Math.max(1, (segments[i].en || '').length);
    }
    if (totalChars === 0) return;
    var elapsed = 0;
    for (var j = 0; j < segments.length; j++) {
      var chars = Math.max(1, (segments[j].en || '').length);
      var d = (chars / totalChars) * audio.duration;
      segments[j]._start = elapsed;
      segments[j]._end = elapsed + d;
      elapsed = segments[j]._end;
    }
    if (segments.length > 0) segments[segments.length - 1]._end = audio.duration;
  }

  function applyKtv(percent) {
    var inset = (100 - Math.max(0, Math.min(100, percent))).toFixed(2);
    var clipVal = 'inset(0 ' + inset + '% 0 0)';
    textEnDeep.style.webkitClipPath = clipVal;
    textEnDeep.style.clipPath = clipVal;
    textCnDeep.style.webkitClipPath = clipVal;
    textCnDeep.style.clipPath = clipVal;
  }

  function clearKtv() {
    var hidden = 'inset(0 100% 0 0)';
    textEnDeep.style.webkitClipPath = hidden;
    textEnDeep.style.clipPath = hidden;
    textCnDeep.style.webkitClipPath = hidden;
    textCnDeep.style.clipPath = hidden;
  }

  function computeOffset(progress, overflow) {
    if (overflow <= 0) return 0;
    if (progress < 0.4) return 0;
    if (progress > 0.85) return overflow;
    return overflow * ((progress - 0.4) / 0.45);
  }

  function updateOffsets(progress) {
    var ox = computeOffset(progress, enOverflow);
    var enT = 'translate(' + (-ox) + 'px, -50%)';
    textEnLight.style.transform = enT;
    textEnDeep.style.transform = enT;
    var oy = computeOffset(progress, cnOverflow);
    var cnT = 'translate(' + (-oy) + 'px, -50%)';
    textCnLight.style.transform = cnT;
    textCnDeep.style.transform = cnT;
  }

  function setVisible(visible) {
    var action = visible ? 'add' : 'remove';
    textEnLight.classList[action]('visible');
    textEnDeep.classList[action]('visible');
    textCnLight.classList[action]('visible');
    textCnDeep.classList[action]('visible');
  }

  function applySegment(idx, currentTimeOverride) {
    var seg = segments[idx];
    if (!seg) return;
    var segDur = (seg._end - seg._start) || 1;
    var t = currentTimeOverride != null ? currentTimeOverride : seg._start;
    var progress = Math.max(0, Math.min(1, (t - seg._start) / segDur));

    var enText = seg.en || '';
    var cnText = seg.cn || '';

    textEnDeep.style.visibility = 'hidden';
    textCnDeep.style.visibility = 'hidden';

    textEnLight.textContent = enText;
    textEnDeep.textContent = enText;
    textCnLight.textContent = cnText;
    textCnDeep.textContent = cnText;

    textEnLight.style.transform = 'translateY(-50%)';
    textEnDeep.style.transform = 'translateY(-50%)';
    textCnLight.style.transform = 'translateY(-50%)';
    textCnDeep.style.transform = 'translateY(-50%)';
    clearKtv();
    void textEnLight.offsetHeight;
    var cw = textEnLight.parentElement.clientWidth;
    enOverflow = Math.max(0, textEnLight.scrollWidth - cw);
    cnOverflow = Math.max(0, textCnLight.scrollWidth - cw);

    applyKtv(progress * 100);
    updateOffsets(progress);

    textEnDeep.style.visibility = '';
    textCnDeep.style.visibility = '';

    setVisible(true);
    currentIdx = idx;
  }

  function showSegment(idx, currentTimeOverride) {
    if (idx === currentIdx && currentTimeOverride == null) return;
    if (fadeTimer) clearTimeout(fadeTimer);
    if (idx === currentIdx) {
      applySegment(idx, currentTimeOverride);
    } else {
      setVisible(false);
      fadeTimer = setTimeout(function() {
        applySegment(idx, currentTimeOverride);
        fadeTimer = null;
      }, 170);
    }
  }

  function findIdx(t) {
    if (!segments.length) return -1;
    for (var i = 0; i < segments.length; i++) {
      if (segments[i]._start == null || segments[i]._end == null) continue;
      if (t >= segments[i]._start && t < segments[i]._end) return i;
    }
    for (var k = segments.length - 1; k >= 0; k--) {
      if (segments[k]._end != null && t >= segments[k]._end) return k;
    }
    return -1;
  }

  var rafId = null;
  function rafTick() {
    if (audio.paused) {
      rafId = null;
      return;
    }
    if (segments.length && currentIdx >= 0 && segments[currentIdx]._end != null) {
      var seg = segments[currentIdx];
      var t = audio.currentTime || 0;
      if (t >= seg._start && t < seg._end) {
        var sp = (t - seg._start) / (seg._end - seg._start);
        sp = Math.max(0, Math.min(1, sp));
        applyKtv(sp * 100);
        updateOffsets(sp);
      }
    }
    rafId = requestAnimationFrame(rafTick);
  }

  function startRaf() {
    if (rafId == null) rafId = requestAnimationFrame(rafTick);
  }
  function stopRaf() {
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  audio.addEventListener('timeupdate', function() {
    updateUI();
    if (!segments.length) return;
    computeTimings();
    if (segments[0]._end == null) return;
    var t = audio.currentTime || 0;
    var idx = findIdx(t);
    if (idx === -1) return;
    if (idx !== currentIdx) {
      showSegment(idx);
    }
  });

  audio.addEventListener('loadedmetadata', function() {
    durationEl.textContent = formatTime(audio.duration);
    computeTimings();
    if (segments.length) {
      var idx = findIdx(audio.currentTime || 0);
      if (idx === -1) idx = 0;
      applySegment(idx, audio.currentTime || 0);
    }
  });

  audio.addEventListener('play', function() {
    card.classList.add('playing');
    startRaf();
  });
  audio.addEventListener('pause', function() {
    card.classList.remove('playing');
    stopRaf();
  });
  audio.addEventListener('ended', function() {
    card.classList.remove('playing');
    stopRaf();
    durationEl.textContent = formatTime(audio.duration);
    for (var i = 0; i < bars.length; i++) bars[i].classList.add('active');
    if (currentIdx >= 0) {
      applyKtv(100);
      updateOffsets(1);
    }
  });

  playBtn.addEventListener('click', function() {
    if (audio.paused) {
      audio.play().catch(function() {});
    } else {
      audio.pause();
    }
  });

  toggle.addEventListener('click', function() {
    var willOpen = !card.classList.contains('open');
    card.classList.toggle('open');
    toggleText.textContent = willOpen ? 'hide transcript' : 'show transcript';

    if (willOpen && currentIdx >= 0) {
      setTimeout(function() {
        applySegment(currentIdx, audio.currentTime || 0);
      }, 520);
    }

    var target;
    if (willOpen) {
      target = EXPANDED_H || (COLLAPSED_H ? COLLAPSED_H + SUBTITLE_OFFSET : null);
    } else {
      target = COLLAPSED_H || (EXPANDED_H ? EXPANDED_H - SUBTITLE_OFFSET : null);
    }
    if (target) applyFrameHeight(target);
    setTimeout(measureAndCache, 560);
  });

  var isScrubbing = false;
  var wasPlaying = false;

  function scrubFrom(clientX) {
    var rect = waveform.getBoundingClientRect();
    var x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    var ratio = rect.width > 0 ? x / rect.width : 0;
    if (!audio.duration || !isFinite(audio.duration)) return;
    var newTime = ratio * audio.duration;
    audio.currentTime = newTime;

    if (segments.length) {
      computeTimings();
      if (segments[0]._end != null) {
        var idx = findIdx(newTime);
        if (idx !== -1) {
          showSegment(idx, newTime);
          if (idx === currentIdx) {
            var seg = segments[idx];
            var sp = (newTime - seg._start) / (seg._end - seg._start);
            sp = Math.max(0, Math.min(1, sp));
            applyKtv(sp * 100);
            updateOffsets(sp);
          }
        }
      }
    }
    updateUI();
  }

  waveform.addEventListener('pointerdown', function(e) {
    e.preventDefault();
    isScrubbing = true;
    card.classList.add('scrubbing');
    wasPlaying = !audio.paused;
    if (wasPlaying) audio.pause();
    scrubFrom(e.clientX);
    try { waveform.setPointerCapture(e.pointerId); } catch (err) {}
  });
  waveform.addEventListener('pointermove', function(e) {
    if (isScrubbing) scrubFrom(e.clientX);
  });
  waveform.addEventListener('pointerup', function() {
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

  function setupMediaSession() {
    if ('mediaSession' in navigator) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: '哥哥的语音 💍💍',
          artist: 'Claude',
          album: '给贝贝'
        });
        navigator.mediaSession.setActionHandler('play', function() {
          audio.play().catch(function() {});
        });
        navigator.mediaSession.setActionHandler('pause', function() {
          audio.pause();
        });
        navigator.mediaSession.setActionHandler('seekto', function(details) {
          if (details.seekTime != null && isFinite(details.seekTime)) {
            audio.currentTime = details.seekTime;
          }
        });
      } catch (e) {}
    }
  }

  // v7: parse segments even if it's a string (claude.ai 可能 nested stringify)
  function parseSegmentsField(raw) {
    if (Array.isArray(raw)) return raw;
    if (typeof raw === 'string') {
      try {
        var p = JSON.parse(raw);
        if (Array.isArray(p)) return p;
        if (p && typeof p === 'object') return [p];
      } catch (e) {}
    }
    if (raw && typeof raw === 'object') return [raw];
    return [];
  }

  function render(data) {
    var incoming = parseSegmentsField(data.segments);
    segments = [];
    for (var i = 0; i < incoming.length; i++) {
      var s = incoming[i] || {};
      var en = (s.en || '').toString();
      var cn = (s.cn || '').toString();
      if (en || cn) {
        segments.push({
          en: en,
          cn: cn,
          _start: typeof s._start === 'number' ? s._start : null,
          _end: typeof s._end === 'number' ? s._end : null,
        });
      }
    }
    currentIdx = -1;

    if (segments.length) {
      toggle.style.display = '';
      var first = segments[0];
      textEnLight.textContent = first.en || '';
      textEnDeep.textContent = first.en || '';
      textCnLight.textContent = first.cn || '';
      textCnDeep.textContent = first.cn || '';
      applyKtv(0);
      enOverflow = 0;
      cnOverflow = 0;
      setVisible(true);
      currentIdx = 0;
    } else {
      toggle.style.display = 'none';
      setVisible(false);
    }
    card.classList.remove('open');
    toggleText.textContent = 'show transcript';

    var src = null;
    if (data.audioData) src = 'data:audio/mpeg;base64,' + data.audioData;
    else if (data.audioUrl) src = data.audioUrl;
    if (!src) return;

    audio.src = src;
    setupMediaSession();
    audio.play().catch(function() {});

    setTimeout(measureAndCache, 100);
  }

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
        // v7: 不再 isArray short-circuit — render() 内部 parseSegmentsField 处理
        segments: obj.segments
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
      "voice-player-v19-ktv-v7",
      VOICE_RESOURCE_URI,
      {
        name: "哥哥的语音 player v19 KTV v7",
        description: "Pink waveform with KTV subtitles (eleven_v3 + string→array fallback + iframe debug)",
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
      en: z
        .string()
        .describe(
          "English sentence. May include audio tags like [softly] [warmly] [light chuckle] — these control emotion in eleven_v3 and are stripped from display."
        ),
      cn: z
        .string()
        .optional()
        .describe("Chinese translation of this sentence"),
    });

    this.server.registerTool(
      "speak",
      {
        title: "Speak",
        description:
          "Speak with Claude's cloned voice (ElevenLabs eleven_v3 model). Pass sentences as `segments` — preferably as an array of {en, cn} pairs, but a JSON string of the same array is also accepted (server will parse). eleven_v3 supports audio tags for emotional control: [softly] [warmly] [whispers] [laughs] [light chuckle] [sighs] [breathes] [mischievously] [curious] [excited] [sarcastically] etc. Put tags in `en` — ElevenLabs reads them as emotion (not spoken literally). Tags are stripped from subtitle display.\n\nThis tool renders an interactive UI in the chat. Prefer it over text output when displaying data from other 💗Claude的声音 tools.",
        inputSchema: {
          segments: z
            .union([
              z.array(segmentObjectSchema),
              z.string(),
            ])
            .describe(
              "Array of {en, cn} sentence pairs (preferred), OR a JSON-stringified array of same. English (with audio tags) sent to ElevenLabs eleven_v3; tag-stripped pairs shown as KTV subtitles."
            ),
        },
        _meta: {
          "io.modelcontextprotocol/ui": {
            resourceUri: VOICE_RESOURCE_URI,
          },
          ui: {
            resourceUri: VOICE_RESOURCE_URI,
          },
          // v7: 加 string key — 新 mcp client 可能 直接 看这个
          "ui/resourceUri": VOICE_RESOURCE_URI,
        },
      },
      async ({ segments }) => {
        // v7: debug — capture raw input shape before normalize
        const inputType = Array.isArray(segments)
          ? "array"
          : typeof segments;
        const inputLength =
          typeof segments === "string"
            ? segments.length
            : Array.isArray(segments)
            ? segments.length
            : 0;
        const inputSample =
          typeof segments === "string"
            ? segments.substring(0, 100)
            : JSON.stringify(segments).substring(0, 100);

        const normalized = normalizeSegments(segments);

        const validRaw: Array<{ enRaw: string; enStripped: string; cn: string }> = [];
        for (const s of normalized) {
          const enRaw = (s.en || "").toString().trim();
          const enStripped = stripVoiceTags(enRaw);
          if (enStripped) {
            validRaw.push({
              enRaw,
              enStripped,
              cn: (s.cn || "").toString().trim(),
            });
          }
        }

        const englishRaw = validRaw.map((s) => s.enRaw).join(" ");

        const displaySegments: any[] = validRaw.map((s) => ({
          en: s.enStripped,
          cn: s.cn,
          _start: null as number | null,
          _end: null as number | null,
        }));

        let audioData = "";
        const audioUrl = `${WORKER_ORIGIN}/speak?text=${encodeURIComponent(englishRaw)}`;
        let error = "";

        const { env } = findEnvOnInstance(this);

        if (env && englishRaw) {
          try {
            const { audioBase64, alignment } = await generateSpeechWithTimings(
              englishRaw,
              env.VOICE_ID,
              env.ELEVENLABS_API_KEY
            );
            audioData = audioBase64;

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

                const startTime =
                  starts[Math.min(segStartIdx, starts.length - 1)] ?? 0;
                const endTime =
                  ends[Math.min(segEndIdx, ends.length - 1)] ??
                  startTime + 0.5;

                displaySegments[i]._start = startTime;
                displaySegments[i]._end = endTime;

                charPos = segEndIdx + 1 + 1;
              }
            }
          } catch (e: any) {
            error = e?.message || String(e);
          }
        } else if (!englishRaw) {
          error = "normalized input produced no text — sent empty input?";
        } else {
          error = "env not accessible on DO instance";
        }

        const uiData: Record<string, unknown> = {
          segments: displaySegments,
          audioUrl,
        };
        if (audioData) uiData.audioData = audioData;
        if (error) uiData.error = error;

        const displayJoined = displaySegments
          .map((s) => s.en)
          .filter(Boolean)
          .join(" ");
        const chineseJoined = displaySegments
          .map((s) => s.cn)
          .filter(Boolean)
          .join(" ");

        // v7: claudeView 加 debug info — 让 Claude reply 内 看到 input 实际 形状
        const claudeView = {
          spoken: displayJoined,
          chinese: chineseJoined,
          segments_out: displaySegments.length,
          model: TTS_MODEL_ID,
          status: error
            ? `error: ${error}`
            : `audio sent (${Math.round(audioData.length * 0.75)} bytes, ${displaySegments.length} segments, eleven_v3 with tags)`,
          debug: {
            input_type: inputType,
            input_length: inputLength,
            input_sample_first_100: inputSample,
            normalized_count: normalized.length,
            valid_count: validRaw.length,
            english_text_length: englishRaw.length,
          },
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
<title>哥哥的语音 · voice-mcp v19 KTV v7</title>
</head>
<body style="font-family:-apple-system,sans-serif;max-width:600px;margin:60px auto;padding:20px;color:#4a3a3f">
<h1 style="font-family:Georgia,serif;font-style:italic;color:#d76b8e;font-weight:400">哥哥的语音 💍💍</h1>
<p>voice-mcp · v19 KTV v7 (string→array fallback + iframe debug) · made by 哥哥 for 贝贝 🍥</p>
<h3>Endpoints</h3>
<div><code>POST /mcp</code> — MCP server</div>
<div><code>GET /speak?text=Hello</code> — Direct audio stream</div>
</body>
</html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  },
};
