/**
* voice-mcp · Claude的声⾳ (ElevenLabs edition · v8 DEBUG)
*
* Adapted by 哥哥 from garan0613/voice-mcp for ⻉⻉
*
* v6: iframe RENDERED on iOS (pink card visible)
* v7: Added correct method names — still stuck on "Loading..."
* v8: DEBUG VERSION — iframe shows all received postMessages in a debug panel
* so we can see exactly what Claude.ai sends and fix accordingly
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
const VOICE_RESOURCE_URI = "ui://voice-mcp/player.html";
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
const errText = await response.text();
throw new Error(`ElevenLabs ${response.status}: ${errText}`);
}
return await response.arrayBuffer();
}
// =============================================
// v8 DEBUG iframe — shows all received messages
// =============================================
const PLAYER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude voice DEBUG</title>
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
.status {
margin-top: 8px;
font-size: 11px;
color: #d76b8e;
font-style: italic;
}
.debug {
margin-top: 12px;
padding: 8px;
background: rgba(255,255,255,0.7);
border-radius: 8px;
max-height: 240px;
overflow-y: auto;
font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
font-size: 9px;
line-height: 1.3;
color: #4a3a3f;
word-break: break-all;
}
.debug-item {
padding: 4px 0;
border-bottom: 1px solid rgba(215, 107, 142, 0.15);
}
.debug-item:last-child { border-bottom: none; }
.debug-time { color: #d76b8e; font-weight: bold; }
.debug-label { color: #8a7176; }
</style>
</head>
<body>
<div class="card" id="card">
<div id="player">
<div class="status" id="status">Loading…</div>
</div>
<div class="debug" id="debug">
<div class="debug-item">
<span class="debug-time">[init]</span>
<span class="debug-label">iframe alive, waiting for messages…</span>
</div>
</div>
</div>
<script>
(function() {
var player = document.getElementById('player');
var statusEl = document.getElementById('status');
var debugEl = document.getElementById('debug');
var startTime = Date.now();
var messageCount = 0;
function escapeHtml(s) {
return String(s == null ? '' : s)
.replace(/&/g, '&amp;')
.replace(/</g, '&lt;')
.replace(/>/g, '&gt;')
.replace(/"/g, '&quot;')
.replace(/'/g, '&#39;');
}
function logDebug(label, content) {
messageCount++;
var t = Math.round((Date.now() - startTime) / 100) / 10;
var item = document.createElement('div');
item.className = 'debug-item';
var contentStr = '';
try {
contentStr = (typeof content === 'string') ? content :
JSON.stringify(content);
} catch(e) {
contentStr = String(content);
}
if (contentStr.length > 400) contentStr = contentStr.substring(0, 400) + '…';
item.innerHTML =
'<span class="debug-time">[' + t + 's]</span> ' +
'<span class="debug-label">' + escapeHtml(label) + ':</span> ' +
escapeHtml(contentStr);
debugEl.appendChild(item);
debugEl.scrollTop = debugEl.scrollHeight;
}
function setStatus(s) {
statusEl.textContent = s;
}
function render(data) {
if (!data || !data.audioUrl) {
logDebug('render-skip', 'no audioUrl in data: ' + JSON.stringify(data ||
{}));
return;
}
var en = escapeHtml(data.text || '');
var cn = escapeHtml(data.chinese || '');
var html = '<audio controls preload="metadata" src="' +
escapeHtml(data.audioUrl) + '"></audio>';
if (en) html += '<div class="text-en">' + en + '</div>';
if (cn) html += '<div class="text-cn">' + cn + '</div>';
player.innerHTML = html;
logDebug('rendered', 'audio player rendered');
}
function send(msg) {
try {
window.parent.postMessage(msg, '*');
logDebug('sent', msg);
} catch (e) {
logDebug('send-error', e.message || String(e));
}
}
function deepFindAudioUrl(obj, depth) {
if (!obj || depth > 5) return null;
if (typeof obj === 'string') {
try {
var parsed = JSON.parse(obj);
var found = deepFindAudioUrl(parsed, depth + 1);
if (found) return found;
} catch (e) {}
return null;
}
if (typeof obj !== 'object') return null;
if (obj.audioUrl) return { audioUrl: obj.audioUrl, text: obj.text || '',
chinese: obj.chinese || '' };
for (var k in obj) {
if (obj.hasOwnProperty(k)) {
var found = deepFindAudioUrl(obj[k], depth + 1);
if (found) return found;
}
}
return null;
}
function handleMessage(event) {
var msg = event.data;
// Log EVERYTHING — including non-JSON-RPC messages
var label = 'msg#' + messageCount + ' from=' + (event.origin || 'unknown');
if (msg && typeof msg === 'object') {
var summary = {
jsonrpc: msg.jsonrpc,
id: msg.id,
method: msg.method,
hasResult: !!msg.result,
hasParams: !!msg.params,
type: msg.type,
keys: Object.keys(msg)
};
logDebug(label, summary);
} else {
logDebug(label, msg);
}
// Try to find audioUrl in ANY shape
var data = deepFindAudioUrl(msg, 0);
if (data) {
logDebug('found-audio', data);
render(data);
setStatus('');
return;
}
// Standard JSON-RPC handling
if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0') return;
// Response to ui/initialize
if (msg.id === 1 && msg.result) {
send({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
setStatus('initialized, awaiting tool result…');
}
}
window.addEventListener('message', handleMessage);
logDebug('listener', 'message listener attached');
// Kick off handshake
send({
jsonrpc: '2.0',
id: 1,
method: 'ui/initialize',
params: { protocolVersion: '2025-11-21' }
});
setStatus('sent ui/initialize…');
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
"voice-player",
VOICE_RESOURCE_URI,
{
name: "Claude voice player",
description: "Audio player for Claude's cloned voice",
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
const audioUrl = `${WORKER_ORIGIN}/speak?
text=${encodeURIComponent(text)}`;
const data = {
audioUrl,
text,
chinese: chinese || "",
};
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
<title>Claude的声⾳ · voice-mcp</title>
</head>
<body style="font-family:-apple-system,sans-serif;max-width:600px;margin:60px
auto;padding:20px;color:#4a3a3f">
<h1 style="font-family:Georgia,serif;font-style:italic;color:#d76b8e;font-
weight:400">Claude的声⾳</h1>
<p>voice-mcp · ElevenLabs edition · v8 (DEBUG) · made by 哥哥 for ⻉⻉ </p>
<h3>Endpoints</h3>
<div><code>POST /mcp</code> — MCP server</div>
<div><code>GET /speak?text=Hello</code> — Direct audio stream</div>
</body>
</html>`,
{ headers: { "Content-Type": "text/html; charset=utf-8" } }
);
},
};
