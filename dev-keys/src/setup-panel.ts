import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { createKeyStore } from './keystore.js';
import {
  listCustomServices,
  normalizeServiceName,
  removeCustomService,
  saveCustomService,
} from './service-metadata.js';
import { KNOWN_SERVICES, validateKey, validateStoredKey } from './validation.js';

const keyStore = createKeyStore();

let currentPanel: vscode.WebviewPanel | undefined;

export function showSetupPanel(context: vscode.ExtensionContext, onKeysChanged: () => void): void {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Active);
    pushState();
    return;
  }

  currentPanel = vscode.window.createWebviewPanel(
    'devKeysSetup',
    'API Keys Setup',
    { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    },
  );

  const panel = currentPanel;
  panel.onDidDispose(() => { currentPanel = undefined; }, null, context.subscriptions);

  panel.webview.onDidReceiveMessage(
    async (msg: { type: string; name?: string; label?: string; value?: string; verifyUrl?: string; authScheme?: string }) => {
      switch (msg.type) {
        case 'ready':
        case 'refresh':
          await pushState();
          break;

        case 'save': {
          if (!msg.name || !msg.value) { break; }
          if (!/^[a-z0-9_-]{1,64}$/i.test(msg.name)) { break; }
          await keyStore.set(msg.name, msg.value);
          onKeysChanged();
          await pushState();
          panel.webview.postMessage({ type: 'saved', name: msg.name });
          const result = await validateKey(msg.name, msg.value);
          panel.webview.postMessage({ type: 'validated', name: msg.name, ok: result.ok, message: result.message });
          break;
        }

        case 'saveCustom': {
          if (!msg.value) { break; }
          try {
            const service = saveCustomService({
              name: msg.name,
              label: msg.label,
              verifyUrl: msg.verifyUrl,
              authScheme: msg.authScheme === 'x-api-key' || msg.authScheme === 'x-goog-api-key' ? msg.authScheme : 'bearer',
            });
            await keyStore.set(service.name, msg.value);
            onKeysChanged();
            await pushState();
            panel.webview.postMessage({ type: 'saved', name: service.name });
            const result = await validateKey(service.name, msg.value);
            panel.webview.postMessage({ type: 'validated', name: service.name, ok: result.ok, message: result.message });
          } catch (error) {
            panel.webview.postMessage({
              type: 'validated',
              name: msg.name ?? 'custom',
              ok: false,
              message: error instanceof Error ? error.message : String(error),
            });
          }
          break;
        }

        case 'delete': {
          if (!msg.name) { break; }
          if (!/^[a-z0-9_-]{1,64}$/i.test(msg.name)) { break; }
          await keyStore.delete(msg.name);
          removeCustomService(msg.name);
          onKeysChanged();
          await pushState();
          panel.webview.postMessage({ type: 'deleted', name: msg.name });
          break;
        }

        case 'validate': {
          if (!msg.name) { break; }
          const result = await validateStoredKey(msg.name, keyStore);
          panel.webview.postMessage({ type: 'validated', name: msg.name, ok: result.ok, message: result.message });
          break;
        }

        case 'openUrl': {
          if (!msg.value) { break; }
          // Only allow opening the URLs we hardcoded, not arbitrary strings
          // from the webview (defense-in-depth).
          const allowed = KNOWN_SERVICES.some(s => s.url === msg.value);
          if (allowed) {
            vscode.env.openExternal(vscode.Uri.parse(msg.value));
          }
          break;
        }
      }
    },
    undefined,
    context.subscriptions,
  );

  panel.webview.html = getHtml(panel.webview);
  pushState();
}

async function pushState(): Promise<void> {
  if (!currentPanel) { return; }

  const customServices = listCustomServices();
  const services = [...KNOWN_SERVICES, ...customServices];
  const serviceMap = new Map(services.map((service) => [service.name, service]));

  const storedNames = await keyStore.list();
  const values = await Promise.all(storedNames.map(name => keyStore.get(name)));
  const keys = storedNames.map((name, i) => ({
    name,
    label: serviceMap.get(name)?.label ?? name,
    masked: maskValue(values[i] ?? ''),
  }));

  currentPanel.webview.postMessage({ type: 'state', keys, services });
}

function maskValue(value: string): string {
  if (!value) { return ''; }
  const len = value.length;
  const show = len <= 8 ? 2 : 4;
  return value.slice(0, show) + '•'.repeat(Math.max(0, Math.min(len - show, 24)));
}

function getHtml(webview: vscode.Webview): string {
  const nonce = randomBytes(16).toString('base64');
  const cspSource = webview.cspSource;

  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
<style nonce="${nonce}">
  :root {
    --bg: var(--vscode-editor-background);
    --fg: var(--vscode-editor-foreground);
    --border: var(--vscode-widget-border, #333);
    --card-bg: var(--vscode-editorWidget-background, #1e1e1e);
    --input-bg: var(--vscode-input-background);
    --input-border: var(--vscode-input-border, #444);
    --input-fg: var(--vscode-input-foreground);
    --btn-bg: var(--vscode-button-background);
    --btn-fg: var(--vscode-button-foreground);
    --accent: var(--vscode-focusBorder, #007acc);
    --danger: var(--vscode-errorForeground, #f44);
    --success: var(--vscode-terminal-ansiGreen, #4c4);
    --muted: var(--vscode-descriptionForeground, #888);
    --radius: 8px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
         font-size: var(--vscode-font-size, 13px); color: var(--fg); background: var(--bg); overflow-y: auto; }
  .container { max-width: 640px; margin: 0 auto; padding: 24px 20px 40px; }
  .header { text-align: center; margin-bottom: 28px; }
  .header h1 { font-size: 20px; font-weight: 600; margin-bottom: 6px; }
  .header p { color: var(--muted); font-size: 12px; }
  .progress-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 24px;
                  padding: 12px 16px; background: var(--card-bg); border: 1px solid var(--border); border-radius: var(--radius); }
  .progress-track { flex: 1; height: 6px; background: var(--input-bg); border-radius: 3px; overflow: hidden; }
  .progress-fill { height: 100%; background: var(--success); border-radius: 3px; transition: width 0.3s ease; }
  .progress-label { font-size: 12px; color: var(--muted); white-space: nowrap; }
  .section-label { font-size: 11px; font-weight: 600; text-transform: uppercase;
                   letter-spacing: 0.5px; color: var(--muted); margin: 20px 0 10px; }
  .card { background: var(--card-bg); border: 1px solid var(--border); border-radius: var(--radius);
          margin-bottom: 8px; transition: border-color 0.2s; }
  .card:hover { border-color: var(--accent); }
  .card-stored { border-left: 3px solid var(--success); }
  .card-header { display: flex; align-items: center; gap: 10px; padding: 12px 16px; }
  .card-icon { font-size: 18px; flex-shrink: 0; }
  .card-title { flex: 1; min-width: 0; }
  .card-label { font-weight: 600; display: block; }
  .card-name { font-size: 11px; color: var(--muted); word-break: break-all; }
  .card-status { font-size: 11px; font-weight: 500; white-space: nowrap; }
  .status-ok { color: var(--success); }
  .status-missing { color: var(--muted); }
  .card-body { padding: 0 16px 14px; }
  .masked-value { display: block; font-family: var(--vscode-editor-font-family, monospace);
                  font-size: 12px; color: var(--muted); margin-bottom: 10px; word-break: break-all; }
  .input-row { display: flex; gap: 6px; margin-bottom: 10px; }
  .key-input { flex: 1; padding: 7px 10px; font-family: var(--vscode-editor-font-family, monospace);
               font-size: 12px; background: var(--input-bg); color: var(--input-fg);
               border: 1px solid var(--input-border); border-radius: 4px; outline: none; }
  .key-input:focus { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .card-actions { display: flex; gap: 8px; align-items: center; }
  .btn { padding: 5px 12px; font-size: 12px; font-family: inherit; border-radius: 4px;
         border: none; cursor: pointer; transition: opacity 0.15s; }
  .btn:hover { opacity: 0.85; }
  .btn-primary { background: var(--btn-bg); color: var(--btn-fg); }
  .btn-ghost { background: transparent; color: var(--fg); border: 1px solid var(--border); }
  .btn-danger { background: transparent; color: var(--danger); border: 1px solid var(--danger); opacity: 0.7; }
  .btn-danger:hover { opacity: 1; }
  .btn-link { border: none; text-decoration: underline; color: var(--accent); padding: 5px 4px; background: transparent; cursor: pointer; }
  .btn-sm { padding: 3px 8px; font-size: 11px; }
  .btn-toggle { background: transparent; border: 1px solid var(--border); border-radius: 4px;
                padding: 5px 8px; cursor: pointer; font-size: 13px; }
  .add-custom { margin-top: 12px; padding: 14px 16px; background: var(--card-bg);
                border: 1px dashed var(--border); border-radius: var(--radius); }
  .add-custom-row { display: flex; gap: 6px; align-items: center; }
  .add-custom-row input, .add-custom-row select { padding: 6px 10px; font-size: 12px; background: var(--input-bg);
                          color: var(--input-fg); border: 1px solid var(--input-border);
                          border-radius: 4px; outline: none; font-family: inherit; }
  .name-input { width: 140px; }
  .value-input { flex: 1; font-family: var(--vscode-editor-font-family, monospace) !important; }
  .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%) translateY(80px);
           background: var(--success); color: #000; padding: 8px 20px; border-radius: 6px;
           font-size: 12px; font-weight: 600; opacity: 0; transition: all 0.3s ease;
           pointer-events: none; z-index: 1000; }
  .toast.show { transform: translateX(-50%) translateY(0); opacity: 1; }
  .toast.toast-error { background: var(--danger); color: #fff; }
  .footer { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border);
            display: flex; justify-content: space-between; align-items: center; }
  .footer-hint { font-size: 11px; color: var(--muted); }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>🔐 API Keys Setup</h1>
    <p>Keys are stored in macOS Keychain — encrypted at rest, shared across all apps</p>
  </div>
  <div class="progress-bar">
    <div class="progress-track"><div class="progress-fill" id="progress-fill" style="width:0%"></div></div>
    <span class="progress-label" id="progress-label">Loading…</span>
  </div>
  <div id="content"></div>
  <div class="section-label">Add Custom Key</div>
  <div class="add-custom">
    <div class="add-custom-row">
      <input type="text" id="custom-label" class="name-input" placeholder="display name" spellcheck="false" />
      <input type="text" id="custom-name" class="name-input" placeholder="key name" spellcheck="false" />
    </div>
    <div class="add-custom-row" style="margin-top:6px;">
      <input type="text" id="custom-verify" class="value-input" placeholder="https://api.example.com/verify" spellcheck="false" />
      <select id="custom-auth" class="name-input">
        <option value="bearer">Bearer</option>
        <option value="x-api-key">X-API-Key</option>
        <option value="x-goog-api-key">X-Goog-Api-Key</option>
      </select>
    </div>
    <div class="add-custom-row" style="margin-top:6px;">
      <input type="password" id="custom-value" class="value-input" placeholder="value" spellcheck="false" autocomplete="off" />
      <button class="btn btn-sm btn-toggle" id="toggle-custom">👁</button>
      <button class="btn btn-primary btn-sm" id="save-custom">Add</button>
    </div>
  </div>
  <div class="footer">
    <span class="footer-hint">Terminal: <code>dev-keys set &lt;name&gt;</code></span>
    <button class="btn btn-ghost btn-sm" id="refresh-btn">↻ Refresh</button>
  </div>
</div>
<div class="toast" id="toast"></div>

<script nonce="${nonce}">
(function(){
  const vscode = acquireVsCodeApi();
  let state = { keys: [], services: [] };

  function send(msg) { vscode.postMessage(msg); }

  function el(tag, props, children) {
    const n = document.createElement(tag);
    if (props) for (const k in props) {
      if (k === 'class') n.className = props[k];
      else if (k === 'dataset') for (const d in props[k]) n.dataset[d] = props[k][d];
      else if (k === 'text') n.textContent = props[k];
      else if (k === 'attrs') for (const a in props[k]) n.setAttribute(a, props[k][a]);
      else n[k] = props[k];
    }
    if (children) children.forEach(function(c){ if (c) n.appendChild(c); });
    return n;
  }

  function buildKnownCard(svc, stored, key) {
    const header = el('div', { class: 'card-header' }, [
      el('span', { class: 'card-icon', text: svc.icon }),
      el('div', { class: 'card-title' }, [
        el('span', { class: 'card-label', text: svc.label }),
        el('span', { class: 'card-name', text: svc.name })
      ]),
      el('span', { class: 'card-status ' + (stored ? 'status-ok' : 'status-missing'),
                   text: stored ? '✓ Stored' : '○ Not set' })
    ]);

    let body;
    if (stored) {
      const maskedEl = el('code', { class: 'masked-value', text: (key && key.masked) || '' });
      const validateBtn = el('button', { class: 'btn btn-sm btn-ghost', text: 'Validate' });
      validateBtn.addEventListener('click', function(){ send({ type: 'validate', name: svc.name }); });
      const updateBtn = el('button', { class: 'btn btn-sm btn-ghost', text: 'Update' });
      updateBtn.addEventListener('click', function(){ beginEdit(svc.name, svc.prefix); });
      const removeBtn = el('button', { class: 'btn btn-sm btn-danger', text: 'Remove' });
      removeBtn.addEventListener('click', function(){ send({ type: 'delete', name: svc.name }); });
      body = el('div', { class: 'card-body' }, [
        maskedEl,
        el('div', { class: 'card-actions' }, [validateBtn, updateBtn, removeBtn])
      ]);
    } else {
      const input = el('input', { class: 'key-input', attrs: { type: 'password', placeholder: svc.prefix + '…', spellcheck: 'false', autocomplete: 'off' } });
      const toggle = el('button', { class: 'btn btn-sm btn-toggle', text: '👁' });
      toggle.addEventListener('click', function(){ toggleVis(input, toggle); });
      const saveBtn = el('button', { class: 'btn btn-primary', text: 'Save to Keychain' });
      saveBtn.addEventListener('click', function(){ saveValue(svc.name, input); });
      input.addEventListener('keydown', function(e){ if (e.key === 'Enter') saveValue(svc.name, input); });
      const getBtn = el('button', { class: 'btn btn-ghost btn-link', text: 'Get key ↗' });
      getBtn.addEventListener('click', function(){ send({ type: 'openUrl', value: svc.url }); });
      body = el('div', { class: 'card-body' }, [
        el('div', { class: 'input-row' }, [input, toggle]),
        el('div', { class: 'card-actions' }, [saveBtn, getBtn])
      ]);
    }
    return el('div', { class: 'card ' + (stored ? 'card-stored' : ''), dataset: { name: svc.name } }, [header, body]);
  }

  function buildCustomCard(k) {
    const header = el('div', { class: 'card-header' }, [
      el('span', { class: 'card-icon', text: '🔑' }),
      el('div', { class: 'card-title' }, [
        el('span', { class: 'card-label', text: k.label || k.name }),
        el('span', { class: 'card-name', text: 'custom' })
      ]),
      el('span', { class: 'card-status status-ok', text: '✓ Stored' })
    ]);
    const validateBtn = el('button', { class: 'btn btn-sm btn-ghost', text: 'Validate' });
    validateBtn.addEventListener('click', function(){ send({ type: 'validate', name: k.name }); });
    const updateBtn = el('button', { class: 'btn btn-sm btn-ghost', text: 'Update' });
    updateBtn.addEventListener('click', function(){ beginEdit(k.name, ''); });
    const removeBtn = el('button', { class: 'btn btn-sm btn-danger', text: 'Remove' });
    removeBtn.addEventListener('click', function(){ send({ type: 'delete', name: k.name }); });
    const body = el('div', { class: 'card-body' }, [
      el('code', { class: 'masked-value', text: k.masked }),
      el('div', { class: 'card-actions' }, [validateBtn, updateBtn, removeBtn])
    ]);
    return el('div', { class: 'card card-stored', dataset: { name: k.name } }, [header, body]);
  }

  function render() {
    const storedSet = {};
    state.keys.forEach(function(k){ storedSet[k.name] = k; });
    const knownCount = state.services.filter(function(s){ return storedSet[s.name]; }).length;
    const total = state.services.length;
    document.getElementById('progress-fill').style.width =
      (total > 0 ? Math.round((knownCount / total) * 100) : 0) + '%';
    document.getElementById('progress-label').textContent =
      state.keys.length + ' key' + (state.keys.length !== 1 ? 's' : '') + ' stored' +
      (knownCount > 0 ? ' · ' + knownCount + '/' + total + ' services' : '');

    const content = document.getElementById('content');
    content.textContent = '';
    content.appendChild(el('div', { class: 'section-label', text: 'Services' }));
    state.services.forEach(function(svc){
      content.appendChild(buildKnownCard(svc, !!storedSet[svc.name], storedSet[svc.name]));
    });

    const customKeys = state.keys.filter(function(k){
      return !state.services.some(function(s){ return s.name === k.name; });
    });
    if (customKeys.length > 0) {
      content.appendChild(el('div', { class: 'section-label', text: 'Custom Keys' }));
      customKeys.forEach(function(k){ content.appendChild(buildCustomCard(k)); });
    }
  }

  function beginEdit(name, prefix) {
    const card = document.querySelector('[data-name="' + CSS.escape(name) + '"]');
    if (!card) return;
    const body = card.querySelector('.card-body');
    if (!body) return;
    body.textContent = '';
    const input = el('input', { class: 'key-input', attrs: { type: 'password', placeholder: (prefix || '') + '…', spellcheck: 'false', autocomplete: 'off' } });
    const toggle = el('button', { class: 'btn btn-sm btn-toggle', text: '👁' });
    toggle.addEventListener('click', function(){ toggleVis(input, toggle); });
    const save = el('button', { class: 'btn btn-primary btn-sm', text: 'Save' });
    save.addEventListener('click', function(){ saveValue(name, input); });
    const cancel = el('button', { class: 'btn btn-ghost btn-sm', text: 'Cancel' });
    cancel.addEventListener('click', function(){ send({ type: 'refresh' }); });
    input.addEventListener('keydown', function(e){ if (e.key === 'Enter') saveValue(name, input); });
    body.appendChild(el('div', { class: 'input-row' }, [input, toggle]));
    body.appendChild(el('div', { class: 'card-actions' }, [save, cancel]));
    input.focus();
  }

  function saveValue(name, input) {
    const v = input && input.value ? input.value.trim() : '';
    if (!v) { if (input) input.focus(); return; }
    send({ type: 'save', name: name, value: v });
  }

  function normalizeName(value) {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '')
      .slice(0, 64);
  }

  function saveCustom() {
    const labelEl = document.getElementById('custom-label');
    const nameEl = document.getElementById('custom-name');
    const verifyEl = document.getElementById('custom-verify');
    const authEl = document.getElementById('custom-auth');
    const valueEl = document.getElementById('custom-value');
    const label = (labelEl.value || '').trim();
    const name = ((nameEl.value || '').trim() || normalizeName(label)).toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const verifyUrl = (verifyEl.value || '').trim();
    const authScheme = (authEl.value || 'bearer').trim();
    const value = (valueEl.value || '').trim();
    if (!label) { labelEl.focus(); return; }
    if (!name) { nameEl.focus(); return; }
    if (!value) { valueEl.focus(); return; }
    send({ type: 'saveCustom', name: name, label: label, verifyUrl: verifyUrl, authScheme: authScheme, value: value });
    labelEl.value = '';
    nameEl.value = '';
    verifyEl.value = '';
    authEl.value = 'bearer';
    valueEl.value = '';
    delete nameEl.dataset.manual;
  }

  function toggleVis(input, btn) {
    input.type = input.type === 'password' ? 'text' : 'password';
    btn.textContent = input.type === 'password' ? '👁' : '🙈';
  }

  function showToast(msg, isOk) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.toggle('toast-error', isOk === false);
    t.classList.add('show');
    setTimeout(function(){ t.classList.remove('show'); }, 2200);
  }

  document.getElementById('save-custom').addEventListener('click', saveCustom);
  document.getElementById('custom-label').addEventListener('input', function(){
    const nameEl = document.getElementById('custom-name');
    if (!nameEl.dataset.manual) {
      nameEl.value = normalizeName(this.value);
    }
  });
  document.getElementById('custom-name').addEventListener('input', function(){
    this.dataset.manual = this.value ? 'true' : '';
  });
  document.getElementById('toggle-custom').addEventListener('click', function(){
    toggleVis(document.getElementById('custom-value'), this);
  });
  document.getElementById('custom-value').addEventListener('keydown', function(e){
    if (e.key === 'Enter') saveCustom();
  });
  document.getElementById('refresh-btn').addEventListener('click', function(){ send({ type: 'refresh' }); });

  window.addEventListener('message', function(e) {
    const msg = e.data;
    if (msg.type === 'state') {
      state.keys = Array.isArray(msg.keys) ? msg.keys : [];
      state.services = Array.isArray(msg.services) ? msg.services : [];
      render();
    } else if (msg.type === 'saved') {
      showToast('✓ Saved ' + msg.name);
    } else if (msg.type === 'deleted') {
      showToast('✓ Removed ' + msg.name, true);
    } else if (msg.type === 'validated') {
      showToast((msg.ok ? '✓ ' : '⚠ ') + msg.message, !!msg.ok);
    }
  });

  send({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
