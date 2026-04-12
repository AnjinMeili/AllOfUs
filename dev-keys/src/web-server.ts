#!/usr/bin/env node
/**
 * Standalone web UI for dev-keys — runs in any browser.
 * Launched via: dev-keys ui
 *
 * Serves the same setup panel as the VS Code extension,
 * backed by a tiny HTTP + SSE server talking to macOS Keychain.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';

const SERVICE = 'dev-api-keys';
const PORT = parseInt(process.env.DEV_KEYS_PORT ?? '9876', 10);

// ── Keychain helpers (sync, fine for a local tool) ──────────────────

function kcGet(name: string): string | undefined {
  try {
    return execFileSync(
      'security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
  } catch { return undefined; }
}

function kcSet(name: string, value: string): void {
  try { execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', name], { stdio: 'pipe' }); } catch {}
  execFileSync('security', ['add-generic-password', '-s', SERVICE, '-a', name, '-w', value, '-U'], { stdio: 'pipe' });
}

function kcDelete(name: string): void {
  execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', name], { stdio: 'pipe' });
}

function kcList(): string[] {
  try {
    const dump = execFileSync('security', ['dump-keychain'], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    const names: string[] = [];
    const lines = dump.split('\n');
    let found = false;
    for (const line of lines) {
      if (line.includes('0x00000007 <blob>=') && line.includes(`"${SERVICE}"`)) { found = true; continue; }
      if (found && line.includes('"acct"<blob>=')) {
        const m = line.match(/="([^"]*)"/);
        if (m?.[1]) names.push(m[1]);
        found = false;
      }
      if (line.startsWith('keychain:') || line.startsWith('class:')) found = false;
    }
    return [...new Set(names)].sort();
  } catch { return []; }
}

function mask(value: string): string {
  const len = value.length;
  const show = len <= 8 ? 2 : 4;
  return value.slice(0, show) + '•'.repeat(Math.min(len - show, 24));
}

// ── SSE clients for live refresh ──────────────��─────────────────────

const sseClients = new Set<ServerResponse>();

function broadcast(event: string, data: unknown): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

// ── API data ────────────────────────────────────────────────────────

function getKeysPayload() {
  const names = kcList();
  return names.map(name => {
    const value = kcGet(name);
    return { name, masked: value ? mask(value) : '' };
  });
}

// ── HTTP server ─────────────────────────────���───────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => resolve(body));
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  // SSE endpoint for live updates
  if (url.pathname === '/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('event: connected\ndata: {}\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // JSON API
  if (url.pathname === '/api/keys' && req.method === 'GET') {
    return json(res, 200, { keys: getKeysPayload() });
  }

  if (url.pathname === '/api/keys' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    if (!body.name || !body.value) { return json(res, 400, { error: 'name and value required' }); }
    kcSet(body.name, body.value);
    broadcast('refresh', {});
    return json(res, 200, { ok: true, name: body.name });
  }

  if (url.pathname.startsWith('/api/keys/') && req.method === 'DELETE') {
    const name = decodeURIComponent(url.pathname.slice('/api/keys/'.length));
    try { kcDelete(name); } catch { return json(res, 404, { error: 'not found' }); }
    broadcast('refresh', {});
    return json(res, 200, { ok: true, name });
  }

  // Serve the HTML UI
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getWebHtml());
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

// ── HTML (adapted from webview, uses fetch instead of vscode.postMessage) ──

function getWebHtml(): string {
  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>dev-keys</title>
<style>
  :root {
    --bg: #1a1a2e;
    --fg: #e0e0e0;
    --border: #333;
    --card-bg: #16213e;
    --input-bg: #0f3460;
    --input-border: #444;
    --input-fg: #e0e0e0;
    --btn-bg: #0a84ff;
    --btn-fg: #fff;
    --accent: #0a84ff;
    --danger: #ff453a;
    --success: #30d158;
    --muted: #888;
    --radius: 8px;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f5f5f7;
      --fg: #1d1d1f;
      --border: #d2d2d7;
      --card-bg: #fff;
      --input-bg: #f0f0f0;
      --input-border: #ccc;
      --input-fg: #1d1d1f;
      --btn-bg: #0071e3;
      --btn-fg: #fff;
      --accent: #0071e3;
      --danger: #ff3b30;
      --success: #34c759;
      --muted: #86868b;
    }
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
    font-size: 14px;
    color: var(--fg);
    background: var(--bg);
    min-height: 100vh;
  }

  .container {
    max-width: 640px;
    margin: 0 auto;
    padding: 32px 20px 60px;
  }

  .header {
    text-align: center;
    margin-bottom: 28px;
  }
  .header h1 { font-size: 22px; font-weight: 700; margin-bottom: 6px; }
  .header p { color: var(--muted); font-size: 13px; }

  .mode-switcher {
    display: flex;
    justify-content: center;
    gap: 8px;
    margin-bottom: 24px;
  }
  .mode-btn {
    padding: 6px 16px;
    font-size: 12px;
    font-weight: 600;
    border-radius: 20px;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--muted);
    cursor: pointer;
    transition: all 0.2s;
  }
  .mode-btn.active, .mode-btn:hover {
    background: var(--accent);
    color: var(--btn-fg);
    border-color: var(--accent);
  }

  .progress-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 24px;
    padding: 12px 16px;
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }
  .progress-track { flex: 1; height: 6px; background: var(--input-bg); border-radius: 3px; overflow: hidden; }
  .progress-fill { height: 100%; background: var(--success); border-radius: 3px; transition: width 0.4s ease; }
  .progress-label { font-size: 12px; color: var(--muted); white-space: nowrap; }

  .section-label {
    font-size: 11px; font-weight: 700; text-transform: uppercase;
    letter-spacing: 0.8px; color: var(--muted); margin: 20px 0 10px;
  }

  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 8px;
    transition: border-color 0.2s, box-shadow 0.2s;
  }
  .card:hover { border-color: var(--accent); box-shadow: 0 2px 12px rgba(0,0,0,0.1); }
  .card-stored { border-left: 3px solid var(--success); }

  .card-header { display: flex; align-items: center; gap: 10px; padding: 12px 16px; }
  .card-icon { font-size: 20px; flex-shrink: 0; }
  .card-title { flex: 1; }
  .card-label { font-weight: 600; display: block; }
  .card-name { font-size: 11px; color: var(--muted); }
  .card-status { font-size: 11px; font-weight: 600; white-space: nowrap; }
  .status-ok { color: var(--success); }
  .status-missing { color: var(--muted); }

  .card-body { padding: 0 16px 14px; }
  .masked-value { display: block; font-family: "SF Mono", Menlo, monospace; font-size: 12px; color: var(--muted); margin-bottom: 10px; word-break: break-all; }

  .input-row { display: flex; gap: 6px; margin-bottom: 10px; }
  .key-input {
    flex: 1; padding: 8px 12px;
    font-family: "SF Mono", Menlo, monospace; font-size: 13px;
    background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border); border-radius: 6px; outline: none;
  }
  .key-input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(10,132,255,0.3); }

  .card-actions { display: flex; gap: 8px; align-items: center; }
  .btn {
    padding: 6px 14px; font-size: 12px; font-weight: 600; font-family: inherit;
    border-radius: 6px; border: none; cursor: pointer; transition: all 0.15s;
  }
  .btn:hover { filter: brightness(1.1); }
  .btn:active { transform: scale(0.97); }
  .btn-primary { background: var(--btn-bg); color: var(--btn-fg); }
  .btn-ghost { background: transparent; color: var(--fg); border: 1px solid var(--border); }
  .btn-danger { background: transparent; color: var(--danger); border: 1px solid var(--danger); opacity: 0.8; }
  .btn-danger:hover { opacity: 1; }
  .btn-link { border: none; background: none; text-decoration: underline; color: var(--accent); padding: 6px 4px; }
  .btn-sm { padding: 4px 10px; font-size: 11px; }
  .btn-toggle { background: transparent; border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; cursor: pointer; font-size: 14px; }

  .add-custom { margin-top: 12px; padding: 14px 16px; background: var(--card-bg); border: 1px dashed var(--border); border-radius: var(--radius); }
  .add-custom-row { display: flex; gap: 6px; align-items: center; }
  .add-custom-row input {
    padding: 7px 10px; font-size: 13px; background: var(--input-bg); color: var(--input-fg);
    border: 1px solid var(--input-border); border-radius: 6px; outline: none; font-family: inherit;
  }
  .add-custom-row input:focus { border-color: var(--accent); }
  .name-input { width: 150px; }
  .value-input { flex: 1; font-family: "SF Mono", Menlo, monospace !important; }

  .toast {
    position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(80px);
    background: var(--success); color: #000; padding: 10px 24px; border-radius: 8px;
    font-size: 13px; font-weight: 700; opacity: 0; transition: all 0.3s ease; pointer-events: none; z-index: 1000;
  }
  .toast.show { transform: translateX(-50%) translateY(0); opacity: 1; }

  .footer {
    margin-top: 28px; padding-top: 16px; border-top: 1px solid var(--border);
    display: flex; justify-content: space-between; align-items: center;
  }
  .footer-hint { font-size: 11px; color: var(--muted); }
  .footer-hint code { background: var(--input-bg); padding: 2px 5px; border-radius: 3px; font-size: 11px; }

  .empty-state {
    text-align: center; padding: 32px 16px; color: var(--muted);
  }
  .empty-state p { margin-bottom: 12px; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>🔐 dev-keys</h1>
    <p>API keys in macOS Keychain — encrypted, shared across all apps</p>
  </div>

  <div class="mode-switcher">
    <button class="mode-btn active" onclick="location.reload()">Web</button>
    <button class="mode-btn" onclick="showToast('Open VS Code → Cmd+Shift+P → Dev Keys: Open Setup Panel')">VS Code</button>
    <button class="mode-btn" onclick="showToast('Run: dev-keys set &lt;name&gt; in your terminal')">CLI</button>
  </div>

  <div class="progress-bar">
    <div class="progress-track"><div class="progress-fill" id="progress-fill" style="width:0%"></div></div>
    <span class="progress-label" id="progress-label">Loading...</span>
  </div>

  <div id="content"><div class="empty-state"><p>Loading keys from Keychain...</p></div></div>

  <div class="section-label">Add Custom Key</div>
  <div class="add-custom">
    <div class="add-custom-row">
      <input type="text" id="custom-name" class="name-input" placeholder="key name" spellcheck="false" />
      <input type="password" id="custom-value" class="value-input" placeholder="value" spellcheck="false" autocomplete="off" />
      <button class="btn btn-sm btn-toggle" onclick="toggleVis('custom-value', this)">👁</button>
      <button class="btn btn-primary btn-sm" onclick="saveCustom()">Add</button>
    </div>
  </div>

  <div class="footer">
    <span class="footer-hint">
      Terminal: <code>dev-keys set &lt;name&gt;</code> · Shell: <code>eval "$(dev-keys init)"</code>
    </span>
    <button class="btn btn-ghost btn-sm" onclick="loadKeys()">↻ Refresh</button>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
const SERVICES = [
  { name: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/settings/keys', prefix: 'sk-or-', icon: '🌐' },
  { name: 'openai', label: 'OpenAI', url: 'https://platform.openai.com/api-keys', prefix: 'sk-', icon: '🤖' },
  { name: 'anthropic', label: 'Anthropic', url: 'https://console.anthropic.com/settings/keys', prefix: 'sk-ant-', icon: '🧠' },
  { name: 'google', label: 'Google AI', url: 'https://aistudio.google.com/apikey', prefix: 'AI', icon: '🔍' },
  { name: 'github', label: 'GitHub', url: 'https://github.com/settings/tokens', prefix: 'ghp_', icon: '🐙' },
  { name: 'huggingface', label: 'Hugging Face', url: 'https://huggingface.co/settings/tokens', prefix: 'hf_', icon: '🤗' },
];

let currentKeys = [];

async function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  return res.json();
}

async function loadKeys() {
  const data = await api('GET', '/api/keys');
  currentKeys = data.keys || [];
  render();
}

function render() {
  const storedSet = new Set(currentKeys.map(k => k.name));
  const knownCount = SERVICES.filter(s => storedSet.has(s.name)).length;
  const total = SERVICES.length;

  document.getElementById('progress-fill').style.width = (total > 0 ? Math.round((knownCount / total) * 100) : 0) + '%';
  document.getElementById('progress-label').textContent =
    currentKeys.length + ' key' + (currentKeys.length !== 1 ? 's' : '') + ' stored' +
    (knownCount > 0 ? ' · ' + knownCount + '/' + total + ' services' : '');

  let html = '<div class="section-label">AI Services</div>';

  for (const svc of SERVICES) {
    const stored = storedSet.has(svc.name);
    const key = currentKeys.find(k => k.name === svc.name);
    html += '<div class="card ' + (stored ? 'card-stored' : '') + '" data-name="' + svc.name + '">';
    html += '<div class="card-header">';
    html += '<span class="card-icon">' + svc.icon + '</span>';
    html += '<div class="card-title"><span class="card-label">' + svc.label + '</span><span class="card-name">' + svc.name + '</span></div>';
    html += '<span class="card-status ' + (stored ? 'status-ok' : 'status-missing') + '">' + (stored ? '✓ Stored' : '○ Not set') + '</span>';
    html += '</div>';
    if (stored) {
      html += '<div class="card-body">';
      html += '<code class="masked-value">' + (key?.masked || '') + '</code>';
      html += '<div class="card-actions">';
      html += '<button class="btn btn-sm btn-ghost" onclick="editKey(\'' + svc.name + '\', \'' + svc.prefix + '\')">Update</button>';
      html += '<button class="btn btn-sm btn-danger" onclick="deleteKey(\'' + svc.name + '\')">Remove</button>';
      html += '</div></div>';
    } else {
      html += '<div class="card-body">';
      html += '<div class="input-row">';
      html += '<input type="password" id="input-' + svc.name + '" class="key-input" placeholder="' + svc.prefix + '..." spellcheck="false" autocomplete="off" />';
      html += '<button class="btn btn-sm btn-toggle" onclick="toggleVis(\'input-' + svc.name + '\', this)">👁</button>';
      html += '</div>';
      html += '<div class="card-actions">';
      html += '<button class="btn btn-primary" onclick="saveKey(\'' + svc.name + '\')">Save to Keychain</button>';
      html += '<a href="' + svc.url + '" target="_blank" class="btn btn-link">Get key ↗</a>';
      html += '</div></div>';
    }
    html += '</div>';
  }

  // Custom keys
  const customKeys = currentKeys.filter(k => !SERVICES.some(s => s.name === k.name));
  if (customKeys.length > 0) {
    html += '<div class="section-label">Custom Keys</div>';
    for (const k of customKeys) {
      html += '<div class="card card-stored" data-name="' + k.name + '">';
      html += '<div class="card-header"><span class="card-icon">🔑</span>';
      html += '<div class="card-title"><span class="card-label">' + k.name + '</span><span class="card-name">custom</span></div>';
      html += '<span class="card-status status-ok">✓ Stored</span></div>';
      html += '<div class="card-body"><code class="masked-value">' + k.masked + '</code>';
      html += '<div class="card-actions">';
      html += '<button class="btn btn-sm btn-ghost" onclick="editKey(\'' + k.name + '\', \'\')">Update</button>';
      html += '<button class="btn btn-sm btn-danger" onclick="deleteKey(\'' + k.name + '\')">Remove</button>';
      html += '</div></div></div>';
    }
  }

  document.getElementById('content').innerHTML = html;
}

async function saveKey(name) {
  const input = document.getElementById('input-' + name);
  if (!input?.value.trim()) { input?.focus(); return; }
  await api('POST', '/api/keys', { name, value: input.value.trim() });
  showToast('✓ Saved ' + name);
  await loadKeys();
}

function editKey(name, prefix) {
  const card = document.querySelector('[data-name="' + name + '"]');
  if (!card) return;
  const body = card.querySelector('.card-body');
  body.innerHTML =
    '<div class="input-row">' +
      '<input type="password" id="edit-' + name + '" class="key-input" placeholder="' + prefix + '..." spellcheck="false" autocomplete="off" />' +
      '<button class="btn btn-sm btn-toggle" onclick="toggleVis(\'edit-' + name + '\', this)">👁</button>' +
    '</div>' +
    '<div class="card-actions">' +
      '<button class="btn btn-primary btn-sm" onclick="saveEdit(\'' + name + '\')">Save</button>' +
      '<button class="btn btn-ghost btn-sm" onclick="loadKeys()">Cancel</button>' +
    '</div>';
  document.getElementById('edit-' + name)?.focus();
}

async function saveEdit(name) {
  const input = document.getElementById('edit-' + name);
  if (!input?.value.trim()) { input?.focus(); return; }
  await api('POST', '/api/keys', { name, value: input.value.trim() });
  showToast('✓ Updated ' + name);
  await loadKeys();
}

async function deleteKey(name) {
  if (!confirm('Remove "' + name + '" from Keychain?')) return;
  await api('DELETE', '/api/keys/' + encodeURIComponent(name));
  showToast('✓ Removed ' + name);
  await loadKeys();
}

async function saveCustom() {
  const nameEl = document.getElementById('custom-name');
  const valueEl = document.getElementById('custom-value');
  const name = nameEl?.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
  const value = valueEl?.value.trim();
  if (!name) { nameEl?.focus(); return; }
  if (!value) { valueEl?.focus(); return; }
  await api('POST', '/api/keys', { name, value });
  nameEl.value = '';
  valueEl.value = '';
  showToast('✓ Saved ' + name);
  await loadKeys();
}

function toggleVis(id, btn) {
  const el = document.getElementById(id);
  if (!el) return;
  el.type = el.type === 'password' ? 'text' : 'password';
  btn.textContent = el.type === 'password' ? '👁' : '🙈';
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}

// Enter key in inputs
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const t = e.target;
  if (t?.id?.startsWith('input-')) saveKey(t.id.replace('input-', ''));
  else if (t?.id?.startsWith('edit-')) saveEdit(t.id.replace('edit-', ''));
  else if (t?.id === 'custom-value') saveCustom();
});

// SSE for live sync (other tabs / CLI changes)
const es = new EventSource('/events');
es.addEventListener('refresh', () => loadKeys());
es.addEventListener('connected', () => loadKeys());

// Initial load
loadKeys();
</script>
</body>
</html>`;
}

// ── Start ────────────────────────��──────────────────────────────────

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  🔐 dev-keys UI running at ${url}\n`);

  // Open in default browser
  if (process.argv.includes('--no-open')) { return; }
  try { execFileSync('open', [url]); } catch {}
});

// Graceful shutdown
process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
