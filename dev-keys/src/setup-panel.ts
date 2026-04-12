import * as vscode from 'vscode';
import * as keychain from './keychain.js';

/** Well-known services with metadata for the setup UI */
const KNOWN_SERVICES = [
  { name: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/settings/keys', prefix: 'sk-or-', icon: '🌐' },
  { name: 'openai', label: 'OpenAI', url: 'https://platform.openai.com/api-keys', prefix: 'sk-', icon: '🤖' },
  { name: 'anthropic', label: 'Anthropic', url: 'https://console.anthropic.com/settings/keys', prefix: 'sk-ant-', icon: '🧠' },
  { name: 'google', label: 'Google AI', url: 'https://aistudio.google.com/apikey', prefix: 'AI', icon: '🔍' },
  { name: 'github', label: 'GitHub', url: 'https://github.com/settings/tokens', prefix: 'ghp_', icon: '🐙' },
  { name: 'huggingface', label: 'Hugging Face', url: 'https://huggingface.co/settings/tokens', prefix: 'hf_', icon: '🤗' },
];

let currentPanel: vscode.WebviewPanel | undefined;

export function showSetupPanel(context: vscode.ExtensionContext, onKeysChanged: () => void): void {
  if (currentPanel) {
    currentPanel.reveal(vscode.ViewColumn.Active);
    refreshPanel();
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

  currentPanel.onDidDispose(() => { currentPanel = undefined; }, null, context.subscriptions);

  currentPanel.webview.onDidReceiveMessage(
    async (msg: { type: string; name?: string; value?: string }) => {
      switch (msg.type) {
        case 'ready':
        case 'refresh':
          await refreshPanel();
          break;

        case 'save':
        case 'saveCustom': {
          if (!msg.name || !msg.value) { break; }
          await keychain.setKey(msg.name, msg.value);
          onKeysChanged();
          await refreshPanel();
          currentPanel?.webview.postMessage({ type: 'saved', name: msg.name });
          break;
        }

        case 'delete': {
          if (!msg.name) { break; }
          await keychain.deleteKey(msg.name);
          onKeysChanged();
          await refreshPanel();
          currentPanel?.webview.postMessage({ type: 'deleted', name: msg.name });
          break;
        }

        case 'openUrl': {
          if (msg.value) {
            vscode.env.openExternal(vscode.Uri.parse(msg.value));
          }
          break;
        }
      }
    },
    undefined,
    context.subscriptions,
  );

  refreshPanel();
}

async function refreshPanel(): Promise<void> {
  if (!currentPanel) { return; }

  const storedNames = await keychain.listKeys();
  const values = await Promise.all(storedNames.map(name => keychain.getKey(name)));
  const keys: Array<{ name: string; stored: boolean; masked: string }> = storedNames.map(
    (name, i) => ({ name, stored: true, masked: maskValue(values[i] ?? '') }),
  );

  currentPanel.webview.html = getHtml(keys, storedNames);
}

function maskValue(value: string): string {
  if (!value) { return ''; }
  const len = value.length;
  const show = len <= 8 ? 2 : 4;
  return value.slice(0, show) + '•'.repeat(Math.max(0, Math.min(len - show, 24)));
}

function getHtml(
  keys: Array<{ name: string; stored: boolean; masked: string }>,
  storedNames: string[],
): string {
  const storedSet = new Set(storedNames);

  const serviceCards = KNOWN_SERVICES.map(svc => {
    const stored = storedSet.has(svc.name);
    const key = keys.find(k => k.name === svc.name);
    return `
      <div class="card ${stored ? 'card-stored' : ''}" data-name="${svc.name}">
        <div class="card-header">
          <span class="card-icon">${svc.icon}</span>
          <div class="card-title">
            <span class="card-label">${svc.label}</span>
            <span class="card-name">${svc.name}</span>
          </div>
          <span class="card-status ${stored ? 'status-ok' : 'status-missing'}">
            ${stored ? '✓ Stored' : '○ Not set'}
          </span>
        </div>
        ${stored ? `
          <div class="card-body">
            <code class="masked-value">${key?.masked ?? ''}</code>
            <div class="card-actions">
              <button class="btn btn-sm btn-ghost" onclick="editKey('${svc.name}', '${svc.prefix}')">Update</button>
              <button class="btn btn-sm btn-danger" onclick="deleteKey('${svc.name}')">Remove</button>
            </div>
          </div>
        ` : `
          <div class="card-body">
            <div class="input-row">
              <input type="password" id="input-${svc.name}" class="key-input"
                     placeholder="${svc.prefix}..." spellcheck="false" autocomplete="off" />
              <button class="btn btn-sm btn-toggle" onclick="toggleVis('input-${svc.name}', this)" title="Show/hide">👁</button>
            </div>
            <div class="card-actions">
              <button class="btn btn-primary" onclick="saveKey('${svc.name}')">Save to Keychain</button>
              <button class="btn btn-ghost btn-link" onclick="openUrl('${svc.url}')">Get key ↗</button>
            </div>
          </div>
        `}
      </div>`;
  }).join('\n');

  // Custom keys not in the known list
  const customKeys = keys.filter(k => !KNOWN_SERVICES.some(s => s.name === k.name));
  const customCards = customKeys.map(k => `
    <div class="card card-stored" data-name="${k.name}">
      <div class="card-header">
        <span class="card-icon">🔑</span>
        <div class="card-title">
          <span class="card-label">${k.name}</span>
          <span class="card-name">custom</span>
        </div>
        <span class="card-status status-ok">✓ Stored</span>
      </div>
      <div class="card-body">
        <code class="masked-value">${k.masked}</code>
        <div class="card-actions">
          <button class="btn btn-sm btn-ghost" onclick="editKey('${k.name}', '')">Update</button>
          <button class="btn btn-sm btn-danger" onclick="deleteKey('${k.name}')">Remove</button>
        </div>
      </div>
    </div>
  `).join('\n');

  const storedCount = storedNames.length;
  const totalKnown = KNOWN_SERVICES.length;
  const configuredKnown = KNOWN_SERVICES.filter(s => storedSet.has(s.name)).length;

  return /*html*/ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';" />
<style>
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
    --btn-hover: var(--vscode-button-hoverBackground);
    --accent: var(--vscode-focusBorder, #007acc);
    --danger: var(--vscode-errorForeground, #f44);
    --success: var(--vscode-terminal-ansiGreen, #4c4);
    --muted: var(--vscode-descriptionForeground, #888);
    --radius: 8px;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--fg);
    background: var(--bg);
    padding: 0;
    overflow-y: auto;
  }

  .container {
    max-width: 640px;
    margin: 0 auto;
    padding: 24px 20px 40px;
  }

  /* ── Header ────────────────────────── */
  .header {
    text-align: center;
    margin-bottom: 28px;
  }
  .header h1 {
    font-size: 20px;
    font-weight: 600;
    margin-bottom: 6px;
  }
  .header p {
    color: var(--muted);
    font-size: 12px;
  }

  /* ── Progress bar ──────────────────── */
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
  .progress-track {
    flex: 1;
    height: 6px;
    background: var(--input-bg);
    border-radius: 3px;
    overflow: hidden;
  }
  .progress-fill {
    height: 100%;
    background: var(--success);
    border-radius: 3px;
    transition: width 0.3s ease;
  }
  .progress-label {
    font-size: 12px;
    color: var(--muted);
    white-space: nowrap;
  }

  /* ── Section ───────────────────────── */
  .section-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--muted);
    margin: 20px 0 10px;
  }

  /* ── Cards ─────────────────────────── */
  .card {
    background: var(--card-bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    margin-bottom: 8px;
    transition: border-color 0.2s;
  }
  .card:hover { border-color: var(--accent); }
  .card-stored { border-left: 3px solid var(--success); }

  .card-header {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    cursor: pointer;
  }
  .card-header:hover { opacity: 0.9; }
  .card-icon { font-size: 18px; flex-shrink: 0; }
  .card-title { flex: 1; min-width: 0; }
  .card-label { font-weight: 600; display: block; }
  .card-name { font-size: 11px; color: var(--muted); }
  .card-status { font-size: 11px; font-weight: 500; white-space: nowrap; }
  .status-ok { color: var(--success); }
  .status-missing { color: var(--muted); }

  .card-body {
    padding: 0 16px 14px;
  }
  .masked-value {
    display: block;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    color: var(--muted);
    margin-bottom: 10px;
    word-break: break-all;
  }

  /* ── Inputs ────────────────────────── */
  .input-row {
    display: flex;
    gap: 6px;
    margin-bottom: 10px;
  }
  .key-input {
    flex: 1;
    padding: 7px 10px;
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 12px;
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--input-border);
    border-radius: 4px;
    outline: none;
  }
  .key-input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent);
  }
  .key-input::placeholder { opacity: 0.4; }

  /* ── Buttons ───────────────────────── */
  .card-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .btn {
    padding: 5px 12px;
    font-size: 12px;
    font-family: inherit;
    border-radius: 4px;
    border: none;
    cursor: pointer;
    transition: opacity 0.15s;
  }
  .btn:hover { opacity: 0.85; }
  .btn:active { opacity: 0.7; }

  .btn-primary {
    background: var(--btn-bg);
    color: var(--btn-fg);
  }
  .btn-ghost {
    background: transparent;
    color: var(--fg);
    border: 1px solid var(--border);
  }
  .btn-danger {
    background: transparent;
    color: var(--danger);
    border: 1px solid var(--danger);
    opacity: 0.7;
  }
  .btn-danger:hover { opacity: 1; }
  .btn-link {
    border: none;
    text-decoration: underline;
    color: var(--accent);
    padding: 5px 4px;
  }
  .btn-sm { padding: 3px 8px; font-size: 11px; }
  .btn-toggle {
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 5px 8px;
    cursor: pointer;
    font-size: 13px;
  }

  /* ── Add custom ────────────────────── */
  .add-custom {
    margin-top: 12px;
    padding: 14px 16px;
    background: var(--card-bg);
    border: 1px dashed var(--border);
    border-radius: var(--radius);
  }
  .add-custom-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }
  .add-custom-row input {
    padding: 6px 10px;
    font-size: 12px;
    background: var(--input-bg);
    color: var(--input-fg);
    border: 1px solid var(--input-border);
    border-radius: 4px;
    outline: none;
    font-family: inherit;
  }
  .add-custom-row input:focus {
    border-color: var(--accent);
  }
  .name-input { width: 140px; }
  .value-input { flex: 1; font-family: var(--vscode-editor-font-family, monospace) !important; }

  /* ── Toast ─────────────────────────── */
  .toast {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%) translateY(80px);
    background: var(--success);
    color: #000;
    padding: 8px 20px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    opacity: 0;
    transition: all 0.3s ease;
    pointer-events: none;
    z-index: 1000;
  }
  .toast.show {
    transform: translateX(-50%) translateY(0);
    opacity: 1;
  }

  /* ── Footer ────────────────────────── */
  .footer {
    margin-top: 24px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .footer-hint {
    font-size: 11px;
    color: var(--muted);
  }
</style>
</head>
<body>
<div class="container">

  <div class="header">
    <h1>🔐 API Keys Setup</h1>
    <p>Keys are stored in macOS Keychain — encrypted at rest, shared across all apps</p>
  </div>

  <div class="progress-bar">
    <div class="progress-track">
      <div class="progress-fill" style="width: ${totalKnown > 0 ? Math.round((configuredKnown / totalKnown) * 100) : 0}%"></div>
    </div>
    <span class="progress-label">${storedCount} key${storedCount !== 1 ? 's' : ''} stored${configuredKnown > 0 ? ` · ${configuredKnown}/${totalKnown} services` : ''}</span>
  </div>

  <div class="section-label">AI Services</div>
  ${serviceCards}

  ${customCards.length > 0 ? `<div class="section-label">Custom Keys</div>${customCards}` : ''}

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
    <button class="btn btn-ghost btn-sm" onclick="refresh()">↻ Refresh</button>
  </div>

</div>

<div class="toast" id="toast"></div>

<script>
  const vscode = acquireVsCodeApi();

  function send(msg) { vscode.postMessage(msg); }

  function saveKey(name) {
    const input = document.getElementById('input-' + name);
    if (!input || !input.value.trim()) {
      input?.focus();
      return;
    }
    send({ type: 'save', name, value: input.value.trim() });
  }

  function editKey(name, prefix) {
    // Replace the card body inline with an edit input
    const card = document.querySelector('[data-name="' + name + '']');
    if (!card) return;
    const body = card.querySelector('.card-body');
    if (!body) return;
    body.innerHTML =
      '<div class="input-row">' +
        '<input type="password" id="edit-' + name + '" class="key-input" placeholder="' + prefix + '..." spellcheck="false" autocomplete="off" />' +
        '<button class="btn btn-sm btn-toggle" onclick="toggleVis(\\'edit-' + name + '\\', this)">👁</button>' +
      '</div>' +
      '<div class="card-actions">' +
        '<button class="btn btn-primary btn-sm" onclick="saveEdit(\\'' + name + '\\')">Save</button>' +
        '<button class="btn btn-ghost btn-sm" onclick="refresh()">Cancel</button>' +
      '</div>';
    document.getElementById('edit-' + name)?.focus();
  }

  function saveEdit(name) {
    const input = document.getElementById('edit-' + name);
    if (!input || !input.value.trim()) {
      input?.focus();
      return;
    }
    send({ type: 'save', name, value: input.value.trim() });
  }

  function deleteKey(name) {
    send({ type: 'delete', name });
  }

  function saveCustom() {
    const nameEl = document.getElementById('custom-name');
    const valueEl = document.getElementById('custom-value');
    const name = nameEl?.value.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    const value = valueEl?.value.trim();
    if (!name) { nameEl?.focus(); return; }
    if (!value) { valueEl?.focus(); return; }
    send({ type: 'saveCustom', name, value });
  }

  function openUrl(url) {
    send({ type: 'openUrl', value: url });
  }

  function toggleVis(id, btn) {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === 'password') {
      el.type = 'text';
      btn.textContent = '🙈';
    } else {
      el.type = 'password';
      btn.textContent = '👁';
    }
  }

  function refresh() {
    send({ type: 'refresh' });
  }

  function showToast(msg) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 2000);
  }

  // Handle messages from extension
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'saved') showToast('✓ Saved ' + msg.name);
    if (msg.type === 'deleted') showToast('✓ Removed ' + msg.name);
  });

  // Enter key support for inputs
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const target = e.target;
    if (!target?.classList?.contains('key-input')) return;
    const id = target.id;
    if (id.startsWith('input-')) {
      saveKey(id.replace('input-', ''));
    } else if (id.startsWith('edit-')) {
      saveEdit(id.replace('edit-', ''));
    }
  });

  document.getElementById('custom-value')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveCustom();
  });

  // Ready
  send({ type: 'ready' });
</script>
</body>
</html>`;
}
