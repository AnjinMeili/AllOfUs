#!/usr/bin/env node
/**
 * Standalone web UI for dev-keys — runs in any browser.
 * Launched via: dev-keys ui
 *
 * Security posture:
 *   - Binds to 127.0.0.1 only
 *   - Validates the Host header (blocks DNS rebinding)
 *   - Requires a per-launch random token on every request
 *   - No CORS headers (same-origin only)
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { execFileSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createKeyStore } from './keystore.js';

const PORT = parseInt(process.env.DEV_KEYS_PORT ?? '9876', 10);
const TOKEN = randomBytes(32).toString('hex');
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const keyStore = createKeyStore();

function mask(value: string): string {
  const len = value.length;
  const show = len <= 8 ? 2 : 4;
  return value.slice(0, show) + '•'.repeat(Math.min(len - show, 24));
}

async function getKeysPayload(): Promise<Array<{ name: string; masked: string }>> {
  const names = await keyStore.list();
  const values = await Promise.all(names.map((n) => keyStore.get(n)));
  return names.map((name, i) => ({
    name,
    masked: values[i] ? mask(values[i] as string) : '',
  }));
}

// ── Auth ────────────────────────────────────────────────────────────

function constantTimeEq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function extractToken(req: IncomingMessage, url: URL): string | undefined {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  const q = url.searchParams.get('t');
  if (q) return q;
  return undefined;
}

function hostOk(req: IncomingMessage): boolean {
  const host = req.headers.host;
  return typeof host === 'string' && ALLOWED_HOSTS.has(host);
}

// ── SSE clients for live refresh ───────────────────────────────────

const sseClients = new Set<ServerResponse>();

function broadcast(event: string, data: unknown): void {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

// ── HTTP server ─────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => resolve(body));
  });
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function plain(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (!hostOk(req)) {
    plain(res, 403, 'Forbidden: invalid Host header');
    return;
  }

  // Landing page: open via the URL printed on stdout (contains ?t=<token>).
  // Stores token in sessionStorage, then redirects to /app so it isn't visible.
  if (url.pathname === '/' && req.method === 'GET') {
    const urlToken = url.searchParams.get('t') ?? '';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getLandingHtml(urlToken));
    return;
  }

  // Authenticated app page: requires token in sessionStorage (we do not
  // re-check here because the app always fetches /api/* which does check).
  if (url.pathname === '/app' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getAppHtml());
    return;
  }

  // All remaining routes require the token.
  const presented = extractToken(req, url);
  if (!presented || !constantTimeEq(presented, TOKEN)) {
    plain(res, 401, 'Unauthorized');
    return;
  }

  if (url.pathname === '/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('event: connected\ndata: {}\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (url.pathname === '/api/keys' && req.method === 'GET') {
    return json(res, 200, { keys: await getKeysPayload() });
  }

  if (url.pathname === '/api/keys' && req.method === 'POST') {
    let body: { name?: unknown; value?: unknown };
    try { body = JSON.parse(await readBody(req)); }
    catch { return json(res, 400, { error: 'invalid json' }); }
    if (typeof body.name !== 'string' || typeof body.value !== 'string' || !body.name || !body.value) {
      return json(res, 400, { error: 'name and value required' });
    }
    if (!/^[a-z0-9_-]{1,64}$/i.test(body.name)) {
      return json(res, 400, { error: 'invalid name (use [a-z0-9_-], 1-64 chars)' });
    }
    await keyStore.set(body.name, body.value);
    broadcast('refresh', {});
    return json(res, 200, { ok: true, name: body.name });
  }

  if (url.pathname.startsWith('/api/keys/') && req.method === 'DELETE') {
    const name = decodeURIComponent(url.pathname.slice('/api/keys/'.length));
    if (!/^[a-z0-9_-]{1,64}$/i.test(name)) {
      return json(res, 400, { error: 'invalid name' });
    }
    try { await keyStore.delete(name); }
    catch { return json(res, 404, { error: 'not found' }); }
    broadcast('refresh', {});
    return json(res, 200, { ok: true, name });
  }

  plain(res, 404, 'Not found');
});

// ── HTML ────────────────────────────────────────────────────────────

function getLandingHtml(urlToken: string): string {
  // The token is placed into sessionStorage and the URL is replaced so the
  // token is no longer visible. If no token is present we tell the user to
  // re-launch from the terminal.
  return /*html*/ `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8" />
<title>dev-keys</title>
<meta name="referrer" content="no-referrer" />
<style>body{font-family:-apple-system,sans-serif;max-width:520px;margin:80px auto;padding:24px;color:#333}</style>
</head><body>
<noscript>This page requires JavaScript.</noscript>
<script>
(function(){
  var u = new URL(window.location.href);
  var t = u.searchParams.get('t');
  if (t) {
    sessionStorage.setItem('dk_token', t);
    u.searchParams.delete('t');
    u.pathname = '/app';
    window.location.replace(u.toString());
  } else if (sessionStorage.getItem('dk_token')) {
    u.pathname = '/app';
    window.location.replace(u.toString());
  } else {
    document.body.innerHTML =
      '<h2>dev-keys</h2>' +
      '<p>No session token. Run <code>dev-keys ui</code> in a terminal and ' +
      'use the URL it prints — the token is included there.</p>';
  }
})();
</script>
</body></html>`;
}

function getAppHtml(): string {
  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="referrer" content="no-referrer" />
<title>dev-keys</title>
<style>
  :root {
    --bg: #1a1a2e; --fg: #e0e0e0; --border: #333; --card-bg: #16213e;
    --input-bg: #0f3460; --input-border: #444; --input-fg: #e0e0e0;
    --btn-bg: #0a84ff; --btn-fg: #fff; --accent: #0a84ff;
    --danger: #ff453a; --success: #30d158; --muted: #888; --radius: 8px;
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg: #f5f5f7; --fg: #1d1d1f; --border: #d2d2d7; --card-bg: #fff;
      --input-bg: #f0f0f0; --input-border: #ccc; --input-fg: #1d1d1f;
      --btn-bg: #0071e3; --btn-fg: #fff; --accent: #0071e3;
      --danger: #ff3b30; --success: #34c759; --muted: #86868b;
    }
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif;
         font-size: 14px; color: var(--fg); background: var(--bg); min-height: 100vh; }
  .container { max-width: 640px; margin: 0 auto; padding: 32px 20px 60px; }
  .header { text-align: center; margin-bottom: 28px; }
  .header h1 { font-size: 22px; font-weight: 700; margin-bottom: 6px; }
  .header p { color: var(--muted); font-size: 13px; }
  .progress-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 24px;
                  padding: 12px 16px; background: var(--card-bg); border: 1px solid var(--border);
                  border-radius: var(--radius); }
  .progress-track { flex: 1; height: 6px; background: var(--input-bg); border-radius: 3px; overflow: hidden; }
  .progress-fill { height: 100%; background: var(--success); border-radius: 3px; transition: width 0.4s ease; }
  .progress-label { font-size: 12px; color: var(--muted); white-space: nowrap; }
  .section-label { font-size: 11px; font-weight: 700; text-transform: uppercase;
                   letter-spacing: 0.8px; color: var(--muted); margin: 20px 0 10px; }
  .card { background: var(--card-bg); border: 1px solid var(--border);
          border-radius: var(--radius); margin-bottom: 8px;
          transition: border-color 0.2s, box-shadow 0.2s; }
  .card:hover { border-color: var(--accent); }
  .card-stored { border-left: 3px solid var(--success); }
  .card-header { display: flex; align-items: center; gap: 10px; padding: 12px 16px; }
  .card-icon { font-size: 20px; flex-shrink: 0; }
  .card-title { flex: 1; min-width: 0; }
  .card-label { font-weight: 600; display: block; }
  .card-name { font-size: 11px; color: var(--muted); word-break: break-all; }
  .card-status { font-size: 11px; font-weight: 600; white-space: nowrap; }
  .status-ok { color: var(--success); }
  .status-missing { color: var(--muted); }
  .card-body { padding: 0 16px 14px; }
  .masked-value { display: block; font-family: "SF Mono", Menlo, monospace;
                  font-size: 12px; color: var(--muted); margin-bottom: 10px; word-break: break-all; }
  .input-row { display: flex; gap: 6px; margin-bottom: 10px; }
  .key-input { flex: 1; padding: 8px 12px; font-family: "SF Mono", Menlo, monospace;
               font-size: 13px; background: var(--input-bg); color: var(--input-fg);
               border: 1px solid var(--input-border); border-radius: 6px; outline: none; }
  .key-input:focus { border-color: var(--accent); box-shadow: 0 0 0 2px rgba(10,132,255,0.3); }
  .card-actions { display: flex; gap: 8px; align-items: center; }
  .btn { padding: 6px 14px; font-size: 12px; font-weight: 600; font-family: inherit;
         border-radius: 6px; border: none; cursor: pointer; transition: all 0.15s; }
  .btn:hover { filter: brightness(1.1); }
  .btn-primary { background: var(--btn-bg); color: var(--btn-fg); }
  .btn-ghost { background: transparent; color: var(--fg); border: 1px solid var(--border); }
  .btn-danger { background: transparent; color: var(--danger); border: 1px solid var(--danger); opacity: 0.8; }
  .btn-danger:hover { opacity: 1; }
  .btn-link { border: none; background: none; text-decoration: underline; color: var(--accent); padding: 6px 4px; }
  .btn-sm { padding: 4px 10px; font-size: 11px; }
  .btn-toggle { background: transparent; border: 1px solid var(--border); border-radius: 6px; padding: 6px 10px; cursor: pointer; font-size: 14px; }
  .add-custom { margin-top: 12px; padding: 14px 16px; background: var(--card-bg);
                border: 1px dashed var(--border); border-radius: var(--radius); }
  .add-custom-row { display: flex; gap: 6px; align-items: center; }
  .add-custom-row input { padding: 7px 10px; font-size: 13px; background: var(--input-bg);
                           color: var(--input-fg); border: 1px solid var(--input-border);
                           border-radius: 6px; outline: none; font-family: inherit; }
  .name-input { width: 150px; }
  .value-input { flex: 1; font-family: "SF Mono", Menlo, monospace !important; }
  .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%) translateY(80px);
           background: var(--success); color: #000; padding: 10px 24px; border-radius: 8px;
           font-size: 13px; font-weight: 700; opacity: 0; transition: all 0.3s ease;
           pointer-events: none; z-index: 1000; }
  .toast.show { transform: translateX(-50%) translateY(0); opacity: 1; }
  .footer { margin-top: 28px; padding-top: 16px; border-top: 1px solid var(--border);
            display: flex; justify-content: space-between; align-items: center; }
  .footer-hint { font-size: 11px; color: var(--muted); }
  .footer-hint code { background: var(--input-bg); padding: 2px 5px; border-radius: 3px; font-size: 11px; }
  .empty-state { text-align: center; padding: 32px 16px; color: var(--muted); }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>🔐 dev-keys</h1>
    <p>API keys in macOS Keychain — encrypted, shared across all apps</p>
  </div>
  <div class="progress-bar">
    <div class="progress-track"><div class="progress-fill" id="progress-fill" style="width:0%"></div></div>
    <span class="progress-label" id="progress-label">Loading…</span>
  </div>
  <div id="content"><div class="empty-state"><p>Loading keys from Keychain…</p></div></div>
  <div class="section-label">Add Custom Key</div>
  <div class="add-custom">
    <div class="add-custom-row">
      <input type="text" id="custom-name" class="name-input" placeholder="key name" spellcheck="false" />
      <input type="password" id="custom-value" class="value-input" placeholder="value" spellcheck="false" autocomplete="off" />
      <button class="btn btn-sm btn-toggle" id="toggle-custom">👁</button>
      <button class="btn btn-primary btn-sm" id="save-custom">Add</button>
    </div>
  </div>
  <div class="footer">
    <span class="footer-hint">
      Terminal: <code>dev-keys set &lt;name&gt;</code> · Shell: <code>eval "$(dev-keys init)"</code>
    </span>
    <button class="btn btn-ghost btn-sm" id="refresh-btn">↻ Refresh</button>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>
(function(){
  var TOKEN = sessionStorage.getItem('dk_token');
  if (!TOKEN) { window.location.replace('/'); return; }

  var SERVICES = [
    { name: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/settings/keys', prefix: 'sk-or-', icon: '🌐' },
    { name: 'openai', label: 'OpenAI', url: 'https://platform.openai.com/api-keys', prefix: 'sk-', icon: '🤖' },
    { name: 'anthropic', label: 'Anthropic', url: 'https://console.anthropic.com/settings/keys', prefix: 'sk-ant-', icon: '🧠' },
    { name: 'google', label: 'Google AI', url: 'https://aistudio.google.com/apikey', prefix: 'AI', icon: '🔍' },
    { name: 'github', label: 'GitHub', url: 'https://github.com/settings/tokens', prefix: 'ghp_', icon: '🐙' },
    { name: 'huggingface', label: 'Hugging Face', url: 'https://huggingface.co/settings/tokens', prefix: 'hf_', icon: '🤗' }
  ];
  var currentKeys = [];

  function api(method, path, body) {
    var opts = { method: method, headers: { 'Authorization': 'Bearer ' + TOKEN } };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(path, opts).then(function(r){
      if (r.status === 401) { sessionStorage.removeItem('dk_token'); window.location.replace('/'); throw new Error('unauthorized'); }
      return r.json();
    });
  }

  function el(tag, props, children) {
    var n = document.createElement(tag);
    if (props) for (var k in props) {
      if (k === 'class') n.className = props[k];
      else if (k === 'dataset') for (var d in props[k]) n.dataset[d] = props[k][d];
      else if (k === 'text') n.textContent = props[k];
      else if (k === 'attrs') for (var a in props[k]) n.setAttribute(a, props[k][a]);
      else n[k] = props[k];
    }
    if (children) children.forEach(function(c){ if (c) n.appendChild(c); });
    return n;
  }

  function loadKeys() {
    return api('GET', '/api/keys').then(function(data){ currentKeys = data.keys || []; render(); });
  }

  function buildKnownCard(svc, stored, key) {
    var headerTitle = el('div', { class: 'card-title' }, [
      el('span', { class: 'card-label', text: svc.label }),
      el('span', { class: 'card-name', text: svc.name })
    ]);
    var statusText = stored ? '✓ Stored' : '○ Not set';
    var header = el('div', { class: 'card-header' }, [
      el('span', { class: 'card-icon', text: svc.icon }),
      headerTitle,
      el('span', { class: 'card-status ' + (stored ? 'status-ok' : 'status-missing'), text: statusText })
    ]);

    var body;
    if (stored) {
      var maskedEl = el('code', { class: 'masked-value', text: (key && key.masked) || '' });
      var updateBtn = el('button', { class: 'btn btn-sm btn-ghost', text: 'Update' });
      updateBtn.addEventListener('click', function(){ beginEdit(svc.name, svc.prefix); });
      var removeBtn = el('button', { class: 'btn btn-sm btn-danger', text: 'Remove' });
      removeBtn.addEventListener('click', function(){ deleteKey(svc.name); });
      body = el('div', { class: 'card-body' }, [
        maskedEl,
        el('div', { class: 'card-actions' }, [updateBtn, removeBtn])
      ]);
    } else {
      var input = el('input', { class: 'key-input', attrs: { type: 'password', placeholder: svc.prefix + '…', spellcheck: 'false', autocomplete: 'off' } });
      var toggle = el('button', { class: 'btn btn-sm btn-toggle', text: '👁' });
      toggle.addEventListener('click', function(){ toggleVis(input, toggle); });
      var saveBtn = el('button', { class: 'btn btn-primary', text: 'Save to Keychain' });
      saveBtn.addEventListener('click', function(){ saveValue(svc.name, input); });
      input.addEventListener('keydown', function(e){ if (e.key === 'Enter') saveValue(svc.name, input); });
      var getBtn = el('a', { class: 'btn btn-link', text: 'Get key ↗', attrs: { href: svc.url, target: '_blank', rel: 'noopener noreferrer' } });
      body = el('div', { class: 'card-body' }, [
        el('div', { class: 'input-row' }, [input, toggle]),
        el('div', { class: 'card-actions' }, [saveBtn, getBtn])
      ]);
    }
    var card = el('div', { class: 'card ' + (stored ? 'card-stored' : ''), dataset: { name: svc.name } }, [header, body]);
    return card;
  }

  function buildCustomCard(k) {
    var header = el('div', { class: 'card-header' }, [
      el('span', { class: 'card-icon', text: '🔑' }),
      el('div', { class: 'card-title' }, [
        el('span', { class: 'card-label', text: k.name }),
        el('span', { class: 'card-name', text: 'custom' })
      ]),
      el('span', { class: 'card-status status-ok', text: '✓ Stored' })
    ]);
    var updateBtn = el('button', { class: 'btn btn-sm btn-ghost', text: 'Update' });
    updateBtn.addEventListener('click', function(){ beginEdit(k.name, ''); });
    var removeBtn = el('button', { class: 'btn btn-sm btn-danger', text: 'Remove' });
    removeBtn.addEventListener('click', function(){ deleteKey(k.name); });
    var body = el('div', { class: 'card-body' }, [
      el('code', { class: 'masked-value', text: k.masked }),
      el('div', { class: 'card-actions' }, [updateBtn, removeBtn])
    ]);
    return el('div', { class: 'card card-stored', dataset: { name: k.name } }, [header, body]);
  }

  function render() {
    var storedSet = {};
    currentKeys.forEach(function(k){ storedSet[k.name] = k; });
    var knownCount = SERVICES.filter(function(s){ return storedSet[s.name]; }).length;
    var total = SERVICES.length;

    document.getElementById('progress-fill').style.width = (total > 0 ? Math.round((knownCount / total) * 100) : 0) + '%';
    document.getElementById('progress-label').textContent =
      currentKeys.length + ' key' + (currentKeys.length !== 1 ? 's' : '') + ' stored' +
      (knownCount > 0 ? ' · ' + knownCount + '/' + total + ' services' : '');

    var content = document.getElementById('content');
    content.textContent = '';
    content.appendChild(el('div', { class: 'section-label', text: 'AI Services' }));
    SERVICES.forEach(function(svc){
      content.appendChild(buildKnownCard(svc, !!storedSet[svc.name], storedSet[svc.name]));
    });

    var customKeys = currentKeys.filter(function(k){
      return !SERVICES.some(function(s){ return s.name === k.name; });
    });
    if (customKeys.length > 0) {
      content.appendChild(el('div', { class: 'section-label', text: 'Custom Keys' }));
      customKeys.forEach(function(k){ content.appendChild(buildCustomCard(k)); });
    }
  }

  function beginEdit(name, prefix) {
    var card = document.querySelector('[data-name="' + CSS.escape(name) + '"]');
    if (!card) return;
    var body = card.querySelector('.card-body');
    if (!body) return;
    body.textContent = '';
    var input = el('input', { class: 'key-input', attrs: { type: 'password', placeholder: (prefix || '') + '…', spellcheck: 'false', autocomplete: 'off' } });
    var toggle = el('button', { class: 'btn btn-sm btn-toggle', text: '👁' });
    toggle.addEventListener('click', function(){ toggleVis(input, toggle); });
    var save = el('button', { class: 'btn btn-primary btn-sm', text: 'Save' });
    save.addEventListener('click', function(){ saveValue(name, input); });
    var cancel = el('button', { class: 'btn btn-ghost btn-sm', text: 'Cancel' });
    cancel.addEventListener('click', function(){ loadKeys(); });
    input.addEventListener('keydown', function(e){ if (e.key === 'Enter') saveValue(name, input); });
    body.appendChild(el('div', { class: 'input-row' }, [input, toggle]));
    body.appendChild(el('div', { class: 'card-actions' }, [save, cancel]));
    input.focus();
  }

  function saveValue(name, input) {
    var v = input && input.value ? input.value.trim() : '';
    if (!v) { if (input) input.focus(); return; }
    api('POST', '/api/keys', { name: name, value: v }).then(function(){
      showToast('✓ Saved ' + name);
      loadKeys();
    });
  }

  function deleteKey(name) {
    if (!confirm('Remove "' + name + '" from Keychain?')) return;
    api('DELETE', '/api/keys/' + encodeURIComponent(name)).then(function(){
      showToast('✓ Removed ' + name);
      loadKeys();
    });
  }

  function saveCustom() {
    var nameEl = document.getElementById('custom-name');
    var valueEl = document.getElementById('custom-value');
    var name = (nameEl && nameEl.value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    var value = (valueEl && valueEl.value || '').trim();
    if (!name) { if (nameEl) nameEl.focus(); return; }
    if (!value) { if (valueEl) valueEl.focus(); return; }
    api('POST', '/api/keys', { name: name, value: value }).then(function(){
      nameEl.value = ''; valueEl.value = '';
      showToast('✓ Saved ' + name);
      loadKeys();
    });
  }

  function toggleVis(input, btn) {
    input.type = input.type === 'password' ? 'text' : 'password';
    btn.textContent = input.type === 'password' ? '👁' : '🙈';
  }

  function showToast(msg) {
    var t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(function(){ t.classList.remove('show'); }, 2200);
  }

  document.getElementById('save-custom').addEventListener('click', saveCustom);
  document.getElementById('toggle-custom').addEventListener('click', function(){
    var v = document.getElementById('custom-value');
    toggleVis(v, this);
  });
  document.getElementById('custom-value').addEventListener('keydown', function(e){ if (e.key === 'Enter') saveCustom(); });
  document.getElementById('refresh-btn').addEventListener('click', loadKeys);

  var es = new EventSource('/events?t=' + encodeURIComponent(TOKEN));
  es.addEventListener('refresh', function(){ loadKeys(); });
  es.addEventListener('connected', function(){ loadKeys(); });
  es.addEventListener('error', function(){});

  loadKeys();
})();
</script>
</body></html>`;
}

// ── Start ───────────────────────────────────────────────────────────

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}/?t=${TOKEN}`;
  console.log(`\n  🔐 dev-keys UI running at http://127.0.0.1:${PORT}`);
  console.log(`  Open this URL (includes one-time session token):`);
  console.log(`  ${url}\n`);

  if (process.argv.includes('--no-open')) { return; }
  try { execFileSync('open', [url]); } catch {}
});

process.on('SIGINT', () => { server.close(); process.exit(0); });
process.on('SIGTERM', () => { server.close(); process.exit(0); });
