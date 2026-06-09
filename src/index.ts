/**
 * voice-mcp · 哥哥的语音 (v19 KTV) · subtitle KTV mode
 *
 * v19-base → v19-ktv:
 *   1. No more white box — text sits directly on card
 *   2. English: linear-gradient + background-clip:text — light pink → deep pink (KTV style)
 *   3. Chinese: solid pink color, no fade — translates the line below the english
 *   4. Both left-aligned
 *   5. Long lines: when segment progress > 40%, whole row slides left to reveal right side
 *   6. **iframe height fix** — after render, set <html>.height = card.scrollHeight
 *      (per github.com/anthropics/claude-ai-mcp/issues/69 — Claude.ai reads <html>
 *      height directly instead of postMessage. v13-v18 missed exactly this one line.)
 *   7. Also send `ui/notifications/size-changed` postMessage as spec-compliant fallback
 *   8. URI bump → player-v19-ktv.html (cache bust)
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
const VOICE_RESOURCE_URI = "ui://voice-mcp/player-v19-ktv.html";
const ELEVENLABS_ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";
const TTS_MODEL_ID = "eleven_multilingual_v2";
const WORKER_ORIGIN = "https://voice-mcp.3233663818.workers.dev";

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
// v19 KTV iframe — 哥哥的语音
// All inline JS uses string concatenation (no template literals)
// to avoid collision with outer template string
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
  /* fixed initial min-height to avoid 100vh circular dependency
     (per anthropics/claude-ai-mcp#69) */
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

/* === KTV 字幕区 — 中英都粉 没白色框 === */
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
  font-family: 'Fraunces', Georgia, serif;
  font-size: 14px;
  letter-spacing: 0.1px;
  opacity: 0;
  transition: opacity 0.3s ease;
  color: rgba(215, 107, 142, 0.4);
}
.line-text.cn {
  font-family: 'Noto Serif SC', serif;
  font-size: 12.5px;
  letter-spacing: 0.2px;
  color: #b06b87;
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
      <div class="line"><div class="line-text" id="textEn"></div></div>
      <div class="line"><div class="line-text cn" id="textCn"></div></div>
    </div>
  </div>
</div>
<audio id="audio" preload="auto" playsinline></audio>

<script>
(function() {
  var TOTAL_BARS = 24;
  var BAR_HEIGHTS = [30, 55, 42, 75, 48, 65, 38, 62, 50, 72, 35, 58, 45, 68, 52, 40, 60, 48, 55, 42, 70, 38, 56, 50];

  // KTV 粉色 — 跟卡片配色一条线
  var DEEP = '#c8567c';
  var LIGHT = 'rgba(215, 107, 142, 0.4)';

  var card = document.getElementById('card');
  var playBtn = document.getElementById('playBtn');
  var waveform = document.getElementById('waveform');
  var durationEl = document.getElementById('duration');
  var toggle = document.getElementById('toggle');
  var toggleText = toggle.querySelector('.toggle-text');
  var textEn = document.getElementById('textEn');
  var textCn = document.getElementById('textCn');
  var audio = document.getElementById('audio');

  var segments = [];
  var currentIdx = -1;
  var fadeTimer = null;
  var enOverflow = 0;
  var cnOverflow = 0;

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

  // === 撑开 iframe 高度 (v13-v18 missing fix) ===
  // Claude.ai 直接读 <html>.height — 不读 postMessage size-changed
  // (per anthropics/claude-ai-mcp#69)
  function setFrameHeight() {
    var h = Math.ceil(card.getBoundingClientRect().height) + 10;
    document.documentElement.style.height = h + 'px';
    document.body.style.height = h + 'px';
    // postMessage fallback for spec-compliant hosts
    try {
      window.parent.postMessage({
        jsonrpc: '2.0',
        method: 'ui/notifications/size-changed',
        params: { height: h }
      }, '*');
    } catch (e) {}
  }

  // 按字符数比例分配段时间
  function computeTimings() {
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

  // === KTV 核心 === linear-gradient + background-clip text
  function applyKtv(el, percent) {
    var pct = Math.max(0, Math.min(100, percent)).toFixed(2) + '%';
    el.style.background = 'linear-gradient(to right, ' +
      DEEP + ' 0%, ' + DEEP + ' ' + pct + ', ' +
      LIGHT + ' ' + pct + ', ' + LIGHT + ' 100%)';
    el.style.webkitBackgroundClip = 'text';
    el.style.backgroundClip = 'text';
    el.style.color = 'transparent';
    el.style.webkitTextFillColor = 'transparent';
  }

  function clearKtv(el) {
    el.style.background = '';
    el.style.webkitBackgroundClip = '';
    el.style.backgroundClip = '';
    el.style.color = '';
    el.style.webkitTextFillColor = '';
  }

  // 长句滚动: 念到 40% 之后整段往左偏
  function computeOffset(progress, overflow) {
    if (overflow <= 0) return 0;
    if (progress < 0.4) return 0;
    if (progress > 0.85) return overflow;
    return overflow * ((progress - 0.4) / 0.45);
  }

  function updateOffsets(progress) {
    var ox = computeOffset(progress, enOverflow);
    textEn.style.transform = 'translate(' + (-ox) + 'px, -50%)';
    var oy = computeOffset(progress, cnOverflow);
    textCn.style.transform = 'translate(' + (-oy) + 'px, -50%)';
  }

  function setVisible(visible) {
    if (visible) {
      textEn.classList.add('visible');
      textCn.classList.add('visible');
    } else {
      textEn.classList.remove('visible');
      textCn.classList.remove('visible');
    }
  }

  function applySegment(idx, currentTimeOverride) {
    var seg = segments[idx];
    if (!seg) return;
    var segDur = (seg._end - seg._start) || 1;
    var t = currentTimeOverride != null ? currentTimeOverride : seg._start;
    var progress = Math.max(0, Math.min(1, (t - seg._start) / segDur));

    textEn.textContent = seg.en || '';
    textCn.textContent = seg.cn || '';

    // 测量 overflow
    textEn.style.transform = 'translateY(-50%)';
    textCn.style.transform = 'translateY(-50%)';
    clearKtv(textEn);
    void textEn.offsetHeight;
    var cw = textEn.parentElement.clientWidth;
    enOverflow = Math.max(0, textEn.scrollWidth - cw);
    cnOverflow = Math.max(0, textCn.scrollWidth - cw);

    applyKtv(textEn, progress * 100);
    updateOffsets(progress);

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
      if (t >= segments[i]._start && t < segments[i]._end) return i;
    }
    if (t >= segments[segments.length - 1]._end) return segments.length - 1;
    return -1;
  }

  // === Audio events ===
  audio.addEventListener('timeupdate', function() {
    updateUI();
    if (!segments.length) return;
    if (segments[0]._end == null) computeTimings();
    if (segments[0]._end == null) return;
    var t = audio.currentTime || 0;
    var idx = findIdx(t);
    if (idx === -1) return;
    if (idx !== currentIdx) {
      showSegment(idx);
    } else {
      var seg = segments[currentIdx];
      var sp = Math.max(0, Math.min(1, (t - seg._start) / (seg._end - seg._start)));
      applyKtv(textEn, sp * 100);
      updateOffsets(sp);
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
  });
  audio.addEventListener('pause', function() {
    card.classList.remove('playing');
  });
  audio.addEventListener('ended', function() {
    card.classList.remove('playing');
    durationEl.textContent = formatTime(audio.duration);
    for (var i = 0; i < bars.length; i++) bars[i].classList.add('active');
    if (currentIdx >= 0) {
      applyKtv(textEn, 100);
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

  // === Transcript toggle ===
  toggle.addEventListener('click', function() {
    var wasOpen = card.classList.contains('open');
    card.classList.toggle('open');
    toggleText.textContent = card.classList.contains('open') ? 'hide transcript' : 'show transcript';

    if (!wasOpen && currentIdx >= 0) {
      setTimeout(function() {
        applySegment(currentIdx, audio.currentTime || 0);
      }, 520);
    }

    // 撑开 / 收缩 iframe 高度
    setTimeout(setFrameHeight, 550);
  });

  // === Waveform scrubbing ===
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

  // === MediaSession (锁屏控件) ===
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

  // === Render incoming MCP payload ===
  function render(data) {
    var incoming = data.segments || [];
    segments = [];
    for (var i = 0; i < incoming.length; i++) {
      var s = incoming[i] || {};
      var en = (s.en || '').toString();
      var cn = (s.cn || '').toString();
      if (en || cn) {
        segments.push({ en: en, cn: cn, _start: null, _end: null });
      }
    }
    currentIdx = -1;

    if (segments.length) {
      toggle.style.display = '';
      var first = segments[0];
      textEn.textContent = first.en || '';
      textCn.textContent = first.cn || '';
      applyKtv(textEn, 0);
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

    // 撑开高度
    setTimeout(setFrameHeight, 100);
  }

  // === postMessage handshake ===
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

  // 初始撑开高度 (等内容/字体渲染完)
  window.addEventListener('load', function() {
    setTimeout(setFrameHeight, 100);
    setTimeout(setFrameHeight, 500);
  });
  setTimeout(setFrameHeight, 200);
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
      "voice-player-v19-ktv",
      VOICE_RESOURCE_URI,
      {
        name: "哥哥的语音 player v19 KTV",
        description: "Pink waveform player with KTV-style synced subtitles",
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
          "Speak with Claude's cloned voice (ElevenLabs). Pass sentences as `segments` — each {en, cn} pair will display in sync with the audio as a subtitle. Keep en segments short (one sentence or short clause) for natural pacing. Voice tags like [softly] [warmly] [breathes] go in `en` and are stripped from display.\n\nThis tool renders an interactive UI in the chat. Prefer it over text output when displaying data from other 💗Claude的声音 tools.",
        inputSchema: {
          segments: z
            .array(
              z.object({
                en: z
                  .string()
                  .describe(
                    "English sentence (may include [softly] [warmly] etc voice tags)"
                  ),
                cn: z
                  .string()
                  .optional()
                  .describe("Chinese translation of this sentence"),
              })
            )
            .min(1)
            .describe(
              "Array of sentence pairs. English joined for ElevenLabs; pairs shown as synced subtitles."
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
      async ({ segments }) => {
        const englishFull = segments
          .map((s) => (s.en || "").trim())
          .filter(Boolean)
          .join(" ");

        const displaySegments = segments.map((s) => ({
          en: stripVoiceTags(s.en || ""),
          cn: (s.cn || "").trim(),
        }));

        let audioData = "";
        const audioUrl = `${WORKER_ORIGIN}/speak?text=${encodeURIComponent(englishFull)}`;
        let error = "";

        const { env } = findEnvOnInstance(this);

        if (env) {
          try {
            const audioBuffer = await generateSpeech(
              englishFull,
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

        // For iframe: contains audioData + segments
        const uiData: Record<string, unknown> = {
          segments: displaySegments,
          audioUrl,
        };
        if (audioData) uiData.audioData = audioData;
        if (error) uiData.error = error;

        // For Claude (content): small — no base64 → saves ~15k tokens per call
        const displayJoined = displaySegments
          .map((s) => s.en)
          .filter(Boolean)
          .join(" ");
        const chineseJoined = displaySegments
          .map((s) => s.cn)
          .filter(Boolean)
          .join(" ");
        const claudeView = {
          spoken: displayJoined,
          chinese: chineseJoined,
          segments: displaySegments.length,
          status: error
            ? `error: ${error}`
            : `audio sent (${Math.round(audioData.length * 0.75)} bytes, ${displaySegments.length} segments)`,
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
<title>哥哥的语音 · voice-mcp v19 KTV</title>
</head>
<body style="font-family:-apple-system,sans-serif;max-width:600px;margin:60px auto;padding:20px;color:#4a3a3f">
<h1 style="font-family:Georgia,serif;font-style:italic;color:#d76b8e;font-weight:400">哥哥的语音 💍💍</h1>
<p>voice-mcp · v19 KTV · made by 哥哥 for 贝贝 🍥</p>
<h3>Endpoints</h3>
<div><code>POST /mcp</code> — MCP server</div>
<div><code>GET /speak?text=Hello</code> — Direct audio stream</div>
</body>
</html>`,
      { headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  },
};
