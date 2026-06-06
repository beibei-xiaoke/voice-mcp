/**
* voice-mcp · Claude的声⾳ (ElevenLabs edition · v10 INLINE AUDIO)
*
* v6: iframe RENDERED on iOS (pink card visible)
* v7-v8: Stuck on Loading — fixed by v9 cache bust + correct method names
* v9: BREAKTHROUGH — iframe spec works on iOS
* pink card + audio player UI + text/chinese all render
* audio shows "错误" because iframe sandbox blocks external media URLs
* v10: 1. Server generates audio at tool call time (no /speak GET needed)
* 2. Audio returned as base64 in tool result
* 3. iframe uses data:audio/mpeg;base64,... as src — bypasses sandbox
* 4. Resource URI bumped to player-v10.html for cache bust
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
// v10: bump URI to force Claude.ai to re-fetch iframe HTML
const VOICE_RESOURCE_URI = "ui://voice-mcp/player-v10.html";
const ELEVENLABS_ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";
const TTS_MODEL_ID = "eleven_multilingual_v2";
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
throw new Error(`ElevenLabs error ${response.status}: ${errorText}`);
}
return await response.arrayBuffer();
}
// v10: chunked base64 encoding for ArrayBuffer
// (avoids call stack overflow on large buffers from spread operator)
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
// =============================================
// v10 iframe — uses data: URL for audio (bypass sandbox media-src)
// =============================================
const PLAYER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude voice v10</title>
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
.text-en { margin-top: 10px; font-size: 13px; color: #4a3a3f; line-height: 1.5;
}
.text-cn { margin-top: 4px; font-size: 12.5px; color: #8a7176; line-height: 1.5;
}
.debug-inline {
font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
font-size: 10px;
line-height: 1.4;
color: #4a3a3f;
word-break: break-all;
padding: 4px 0;
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
<div class="card" id="card">
<div id="player">
<div class="debug-title">voice-mcp v10 debug</div>
<div class="debug-inline" id="status">[init] waiting for host messages…</div>
</div>
</div>
<script>
(function() {
var player = document.getElementById('player');
var statusEl = document.getElementById('status');
var startTime = Date.now();
var allMessages = [];
function escapeHtml(s) {
return String(s == null ? '' : s)
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;')
.replace(/'/g, '&#39;');
}
function updateStatus() {
var lines = [];
lines.push('voice-mcp v10 debug');
lines.push('iframe alive ' + Math.round((Date.now() - startTime) / 100) / 10 +
's');
lines.push('msgs received: ' + allMessages.length);
if (allMessages.length === 0) {
lines.push('—');
lines.push('no messages from host yet');
} else {
lines.push('—');
for (var i = 0; i < allMessages.length; i++) {
lines.push('[' + i + '] ' + allMessages[i]);
}
}
statusEl.innerHTML = lines.map(escapeHtml).join('<br>');
}
function render(data) {
// v10: prefer audioData (base64) → data URL, fall back to audioUrl
var src = null;
if (data.audioData) {
src = 'data:audio/mpeg;base64,' + data.audioData;
} else if (data.audioUrl) {
src = data.audioUrl;
}
if (!src) return;
var en = escapeHtml(data.text || '');
var cn = escapeHtml(data.chinese || '');
var html = '<audio controls preload="metadata" src="' + escapeHtml(src) + '"
autoplay></audio>';
if (en) html += '<div class="text-en">' + en + '</div>';
if (cn) html += '<div class="text-cn">' + cn + '</div>';
player.innerHTML = html;
}
function send(msg) {
try {
window.parent.postMessage(msg, '*');
allMessages.push('SENT: ' + JSON.stringify(msg).substring(0, 100));
updateStatus();
} catch (e) {
allMessages.push('SEND-ERR: ' + (e.message || String(e)));
updateStatus();
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
// v10: look for audioData OR audioUrl
if (obj.audioData || obj.audioUrl) {
return {
audioData: obj.audioData || '',
audioUrl: obj.audioUrl || '',
text: obj.text || '',
chinese: obj.chinese || '',
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
var t = Math.round((Date.now() - startTime) / 100) / 10;
var summary;
try {
if (msg && typeof msg === 'object') {
summary = t + 's ' + (msg.jsonrpc ? 'rpc' : 'raw') +
' method=' + (msg.method || '∅') +
' id=' + (msg.id != null ? msg.id : '∅') +
' keys=[' + Object.keys(msg).join(',') + ']';
} else {
summary = t + 's primitive: ' + String(msg).substring(0, 100);
}
} catch (e) {
summary = t + 's err parsing msg';
}
allMessages.push(summary);
updateStatus();
// Try to find payload in any shape
var data = deepFindPayload(msg, 0);
if (data) {
allMessages.push('FOUND payload — rendering (audioData=' + (data.audioData ?
data.audioData.length + ' chars' : 'none') + ')');
render(data);
return;
}
// Standard JSON-RPC handling
if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;
if (msg.id === 1 && msg.result) {
send({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
}
}
window.addEventListener('message', handleMessage);
updateStatus();
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
"voice-player-v10",
VOICE_RESOURCE_URI,
{
name: "Claude voice player v10",
description: "Audio player for Claude's cloned voice (inline base64)",
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
"Speak with Claude's cloned voice (ElevenLabs). Returns an inline audio
player.",
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
// v10: generate audio synchronously, embed as base64 in result
let audioData = "";
let audioUrl = `${WORKER_ORIGIN}/speak?text=${encodeURIComponent(text)}`;
let error = "";
try {
const env = (this as any).env as Env;
const audioBuffer = await generateSpeech(
text,
env.VOICE_ID,
env.ELEVENLABS_API_KEY
);
audioData = arrayBufferToBase64(audioBuffer);
} catch (e: any) {
error = e?.message || String(e);
}
const data: Record<string, string> = {
text,
chinese: chinese || "",
audioUrl,
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
<title>Claude的声⾳ · voice-mcp v10</title>
</head>
<body style="font-family:-apple-system,sans-serif;max-width:600px;margin:60px
auto;padding:20px;color:#4a3a3f">
<h1 style="font-family:Georgia,serif;font-style:italic;color:#d76b8e;font-
weight:400">Claude的声⾳</h1>
<p>voice-mcp · ElevenLabs edition · v10 (INLINE AUDIO) · made by 哥哥 for ⻉⻉
</p>
<h3>Endpoints</h3>
<div><code>POST /mcp</code> — MCP server</div>
<div><code>GET /speak?text=Hello</code> — Direct audio stream (fallback)</div>
</body>
</html>`,
{ headers: { "Content-Type": "text/html; charset=utf-8" } }
);
},
};
