import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type Scope = 'all' | 'project';
type OutputFormat = 'text' | 'json' | 'web';
type Mode = 'audit' | 'fix' | 'snapshot' | 'restore' | 'copy';
type FixTarget = 'global' | 'user' | 'workdir';
type Severity = 'high' | 'medium' | 'low' | 'info';
type Status = 'pass' | 'warn' | 'fail' | 'manual';

interface AuditOptions {
  mode: Mode;
  scope: Scope;
  projectPath: string;
  format: OutputFormat;
  outputPath?: string;
  target: FixTarget;
  yesGlobal: boolean;
  openBrowser: boolean;
  interactive: boolean;
  snapshotName: string;
  fromWorkdir?: string;
  toWorkdir?: string;
}

interface SnapshotFile {
  path: string;
  content: string;
}

interface SnapshotPayload {
  name: string;
  createdAt: string;
  target: FixTarget;
  projectPath: string;
  files: SnapshotFile[];
}

interface Finding {
  id: string;
  layer: 'os' | 'vscode' | 'extensions' | 'project';
  status: Status;
  severity: Severity;
  message: string;
  evidence?: string;
  recommendation?: string;
}

interface AuditReport {
  scope: Scope;
  projectPath: string;
  generatedAt: string;
  findings: Finding[];
  summary: {
    fail: number;
    warn: number;
    pass: number;
    manual: number;
  };
}

function parseArgs(argv: string[]): AuditOptions {
  let mode: Mode = 'audit';
  let scope: Scope = 'all';
  let projectPath = process.cwd();
  let format: OutputFormat = 'text';
  let outputPath: string | undefined;
  let target: FixTarget = 'workdir';
  let yesGlobal = false;
  let openBrowser = false;
  let interactive = false;
  let snapshotName = 'latest';
  let fromWorkdir: string | undefined;
  let toWorkdir: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];

    if (arg === '--mode' && (next === 'audit' || next === 'fix' || next === 'snapshot' || next === 'restore' || next === 'copy')) {
      mode = next;
      i += 1;
      continue;
    }

    if (arg === '--scope' && (next === 'all' || next === 'project')) {
      scope = next;
      i += 1;
      continue;
    }

    if ((arg === '--project' || arg === '-p') && next) {
      projectPath = resolve(next);
      i += 1;
      continue;
    }

    if (arg === '--format' && (next === 'text' || next === 'json' || next === 'web')) {
      format = next;
      i += 1;
      continue;
    }

    if (arg === '--output' && next) {
      outputPath = resolve(next);
      i += 1;
      continue;
    }

    if (arg === '--target' && (next === 'global' || next === 'user' || next === 'workdir')) {
      target = next;
      i += 1;
      continue;
    }

    if (arg === '--yes-global') {
      yesGlobal = true;
      continue;
    }

    if (arg === '--open-browser') {
      openBrowser = true;
      continue;
    }

    if (arg === '--interactive') {
      interactive = true;
      continue;
    }

    if (arg === '--snapshot' && next) {
      snapshotName = next;
      i += 1;
      continue;
    }

    if (arg === '--from-workdir' && next) {
      fromWorkdir = resolve(next);
      i += 1;
      continue;
    }

    if (arg === '--to-workdir' && next) {
      toWorkdir = resolve(next);
      i += 1;
      continue;
    }

    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return {
    mode,
    scope,
    projectPath,
    format,
    outputPath,
    target,
    yesGlobal,
    openBrowser,
    interactive,
    snapshotName,
    fromWorkdir,
    toWorkdir,
  };
}

function printHelp(): void {
  const lines = [
    'Usage: npm run audit:perms -- [options]',
    '',
    'Options:',
    '  --mode audit|fix|snapshot|restore|copy  Action mode (default: audit)',
    '  --scope all|project   Audit all layers or current project only (default: all)',
    '  --project, -p PATH    Project directory to audit (default: cwd)',
    '  --format text|json|web   Output format (default: text)',
    '  --output PATH         Write report to file',
    '  --target global|user|workdir   Fix target scope (default: workdir)',
    '  --yes-global          Required acknowledgement for global fix target',
    '  --open-browser        Open output web report in default browser',
    '  --interactive         Enable interactive web controls for web output',
    '  --snapshot NAME       Snapshot name for snapshot/restore (default: latest)',
    '  --from-workdir PATH   Source workdir for copy mode',
    '  --to-workdir PATH     Destination workdir for copy mode',
    '  --help, -h            Show this help',
  ];
  console.log(lines.join('\n'));
}

function getUserSettingsPath(): string {
  return join(homedir(), 'Library', 'Application Support', 'Code', 'User', 'settings.json');
}

function getWorkspaceSettingsPath(projectPath: string): string {
  return join(projectPath, '.vscode', 'settings.json');
}

function getClaudeSettingsPath(projectPath: string): string {
  return join(projectPath, '.claude', 'settings.local.json');
}

function getSnapshotPath(projectPath: string, snapshotName: string): string {
  const safeName = snapshotName.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(projectPath, '.permissions-snapshots', `${safeName}.json`);
}

function ensureParentDir(path: string): void {
  const parent = path.slice(0, path.lastIndexOf('/'));
  if (parent && !existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}

function readTextFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
}

function writeTextFile(path: string, content: string): void {
  ensureParentDir(path);
  writeFileSync(path, content, 'utf-8');
}

function collectPathsForTarget(projectPath: string, target: FixTarget): string[] {
  const files: string[] = [];
  if (target === 'user' || target === 'global') {
    files.push(getUserSettingsPath());
  }
  if (target === 'workdir' || target === 'global') {
    files.push(getWorkspaceSettingsPath(projectPath));
    files.push(getClaudeSettingsPath(projectPath));
  }
  return files;
}

function runSnapshot(options: AuditOptions): { snapshotPath: string; captured: string[]; skipped: string[]; warnings: string[] } {
  const projectPath = resolve(options.projectPath);
  const warnings: string[] = [];

  if (options.target === 'global' && !options.yesGlobal) {
    throw new Error(
      [
        'GLOBAL SNAPSHOT BLOCKED',
        'Global snapshot includes user-level settings and repository-level settings.',
        'Rerun with: --mode snapshot --target global --yes-global',
      ].join('\n'),
    );
  }

  const files = collectPathsForTarget(projectPath, options.target);
  const captured: SnapshotFile[] = [];
  const skipped: string[] = [];

  for (const filePath of files) {
    const content = readTextFile(filePath);
    if (content === undefined) {
      skipped.push(filePath);
      continue;
    }
    captured.push({ path: filePath, content });
  }

  const payload: SnapshotPayload = {
    name: options.snapshotName,
    createdAt: new Date().toISOString(),
    target: options.target,
    projectPath,
    files: captured,
  };

  const snapshotPath = getSnapshotPath(projectPath, options.snapshotName);
  ensureParentDir(snapshotPath);
  writeFileSync(snapshotPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf-8');

  if (options.target === 'global') {
    warnings.push('STERN WARNING: This snapshot includes user-level settings that impact all VS Code workflows.');
  }

  return {
    snapshotPath,
    captured: captured.map((item) => item.path),
    skipped,
    warnings,
  };
}

function runRestore(options: AuditOptions): { snapshotPath: string; restored: string[]; warnings: string[] } {
  const projectPath = resolve(options.projectPath);

  if (options.target === 'global' && !options.yesGlobal) {
    throw new Error(
      [
        'GLOBAL RESTORE BLOCKED',
        'Global restore writes user-level and repository-level settings.',
        'Rerun with: --mode restore --target global --yes-global',
      ].join('\n'),
    );
  }

  const snapshotPath = getSnapshotPath(projectPath, options.snapshotName);
  const raw = readTextFile(snapshotPath);
  if (!raw) {
    throw new Error(`Snapshot not found: ${snapshotPath}`);
  }

  let payload: SnapshotPayload;
  try {
    payload = JSON.parse(raw) as SnapshotPayload;
  } catch {
    throw new Error(`Invalid snapshot file: ${snapshotPath}`);
  }

  const restorePaths = new Set(collectPathsForTarget(projectPath, options.target));
  const restored: string[] = [];

  for (const file of payload.files) {
    if (!restorePaths.has(file.path)) {
      continue;
    }
    writeTextFile(file.path, file.content);
    restored.push(file.path);
  }

  const warnings: string[] = [];
  if (options.target === 'global') {
    warnings.push('STERN WARNING: Global restore overwrote user-level settings and project settings.');
  }

  return { snapshotPath, restored, warnings };
}

function runCopy(options: AuditOptions): { copied: string[]; skipped: string[] } {
  const fromWorkdir = options.fromWorkdir;
  const toWorkdir = options.toWorkdir;

  if (!fromWorkdir || !toWorkdir) {
    throw new Error('Copy mode requires --from-workdir and --to-workdir.');
  }

  const sourceFiles = [
    getWorkspaceSettingsPath(fromWorkdir),
    getClaudeSettingsPath(fromWorkdir),
  ];

  const copied: string[] = [];
  const skipped: string[] = [];

  for (const source of sourceFiles) {
    const content = readTextFile(source);
    if (content === undefined) {
      skipped.push(source);
      continue;
    }

    const relative = source.slice(fromWorkdir.length + 1);
    const destination = join(toWorkdir, relative);
    writeTextFile(destination, content);
    copied.push(`${source} -> ${destination}`);
  }

  return { copied, skipped };
}

function openInBrowser(path: string): void {
  try {
    execFileSync('open', [path], { stdio: 'ignore' });
  } catch {
    console.error(`Could not open browser automatically: ${path}`);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderAuditWeb(report: AuditReport, interactive: boolean): string {
  const byLayer: Record<string, Finding[]> = {};
  for (const finding of report.findings) {
    byLayer[finding.layer] ??= [];
    byLayer[finding.layer].push(finding);
  }

  const payload = JSON.stringify(report);
  const layers = Object.keys(byLayer);

  const layerControls = layers
    .map((layer) => {
      const safeLayer = escapeHtml(layer);
      return `<label><input type="checkbox" class="layer-toggle" data-layer="${safeLayer}" checked> ${safeLayer}</label>`;
    })
    .join(' ');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Permissions Audit Report</title>
  <style>
    :root { color-scheme: light; --bg: #f4f7f8; --card: #ffffff; --ink: #1c2a2b; --muted: #5b6d70; --accent: #0c7a6b; --line: #d5e1e3; }
    body { margin: 0; font-family: ui-monospace, Menlo, Monaco, "Cascadia Mono", "Segoe UI Mono", monospace; background: linear-gradient(120deg, #eef5f6, #f8fbfb); color: var(--ink); }
    .wrap { max-width: 1100px; margin: 1rem auto; padding: 0 1rem 2rem; }
    .head { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 1rem; }
    .head h1 { margin: 0 0 .25rem; font-size: 1.2rem; }
    .meta { color: var(--muted); font-size: .9rem; }
    .controls { margin-top: .9rem; display: grid; gap: .75rem; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
    fieldset { border: 1px solid var(--line); border-radius: 10px; padding: .6rem .8rem; background: #fcfefe; }
    legend { font-weight: 700; color: var(--accent); }
    label { display: inline-flex; align-items: center; gap: .35rem; margin-right: .7rem; margin-bottom: .45rem; }
    .tree { margin-top: 1rem; }
    .tree-root, .tree-children, .finding-children { list-style: none; margin: 0; padding: 0; }
    .tree-children { margin-left: 1.1rem; padding-left: .8rem; border-left: 2px solid var(--line); }
    .finding-children { margin-left: 1.2rem; padding-left: .7rem; border-left: 1px dashed var(--line); margin-top: .45rem; }
    .tree-layer { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: .8rem; margin-bottom: .9rem; position: relative; }
    .layer-header { display: flex; justify-content: space-between; align-items: center; }
    .layer-header h2 { margin: 0; font-size: 1rem; text-transform: uppercase; letter-spacing: .06em; }
    .finding { padding-top: .7rem; margin-top: .7rem; border-top: 1px dashed var(--line); position: relative; }
    .finding::before { content: ''; position: absolute; left: -1.4rem; top: 1.1rem; width: 1rem; border-top: 2px solid var(--line); }
    .leaf { position: relative; margin-top: .35rem; padding-left: .55rem; }
    .leaf::before { content: ''; position: absolute; left: -1rem; top: .62rem; width: .8rem; border-top: 1px dashed var(--line); }
    .badges { display: flex; gap: .4rem; flex-wrap: wrap; margin: .35rem 0; }
    .badge { font-size: .75rem; border-radius: 999px; padding: .15rem .45rem; border: 1px solid var(--line); background: #f3f8f8; }
    .status-fail { background: #ffe2e2; border-color: #f2b5b5; }
    .status-warn { background: #fff0dd; border-color: #f4d2a6; }
    .status-pass { background: #e2f6ea; border-color: #b6e3c6; }
    .status-manual { background: #e7efff; border-color: #c7d6ff; }
    .sev-high { color: #9d1515; } .sev-medium { color: #8a4d00; } .sev-low { color: #1a6a52; } .sev-info { color: #285879; }
    .message { margin: .25rem 0; }
    .small { color: var(--muted); font-size: .86rem; }
    .plan { margin-top: 1rem; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: .8rem; }
    .plan textarea { width: 100%; min-height: 150px; resize: vertical; font-family: inherit; border: 1px solid var(--line); border-radius: 8px; padding: .6rem; }
    .btn { border: 1px solid #0d8b79; background: #0c7a6b; color: #fff; border-radius: 8px; padding: .45rem .65rem; cursor: pointer; font-family: inherit; }
    .btn.secondary { background: #fff; color: #0c7a6b; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="head">
      <h1>Permissions Audit Report</h1>
      <div class="meta" id="meta"></div>
      <div class="controls" ${interactive ? '' : 'style="display:none"'}>
        <fieldset>
          <legend>Status Filter (radio)</legend>
          <label><input type="radio" name="status" value="all" checked> all</label>
          <label><input type="radio" name="status" value="fail"> fail</label>
          <label><input type="radio" name="status" value="warn"> warn</label>
          <label><input type="radio" name="status" value="pass"> pass</label>
          <label><input type="radio" name="status" value="manual"> manual</label>
        </fieldset>
        <fieldset>
          <legend>Layer Toggles (subtrees)</legend>
          ${layerControls}
        </fieldset>
        <fieldset>
          <legend>Fix Plan</legend>
          <button class="btn" id="build-plan" type="button">Build from selected findings</button>
          <button class="btn secondary" id="copy-plan" type="button">Copy plan text</button>
        </fieldset>
        <fieldset>
          <legend>Apply Commands</legend>
          <button class="btn" id="build-commands" type="button">Build CLI commands</button>
          <button class="btn secondary" id="copy-commands" type="button">Copy commands</button>
        </fieldset>
      </div>
    </div>
    <div id="tree" class="tree"></div>
    <div class="plan" ${interactive ? '' : 'style="display:none"'}>
      <div class="small" style="margin-bottom:.45rem">Generated from checked finding nodes</div>
      <textarea id="plan-output" placeholder="Click 'Build from selected findings' to generate a fix plan."></textarea>
    </div>
    <div class="plan" ${interactive ? '' : 'style="display:none"'}>
      <div class="small" style="margin-bottom:.45rem">Generated CLI commands (review before running)</div>
      <textarea id="commands-output" placeholder="Click 'Build CLI commands' to generate non-executing command suggestions."></textarea>
    </div>
  </div>

  <script>
    const report = ${payload};
    const tree = document.getElementById('tree');
    const meta = document.getElementById('meta');
    const planOutput = document.getElementById('plan-output');
    const commandsOutput = document.getElementById('commands-output');
    const buildPlanBtn = document.getElementById('build-plan');
    const copyPlanBtn = document.getElementById('copy-plan');
    const buildCommandsBtn = document.getElementById('build-commands');
    const copyCommandsBtn = document.getElementById('copy-commands');
    const selectedLayers = new Set(report.findings.map(f => f.layer));
    let selectedStatus = 'all';

    meta.textContent = 'Scope: ' + report.scope + ' | Project: ' + report.projectPath + ' | Generated: ' + report.generatedAt;

    function badgeClass(status) {
      return 'status-' + status;
    }

    function severityClass(severity) {
      return 'sev-' + severity;
    }

    function esc(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
    }

    function render() {
      const byLayer = {};
      for (const finding of report.findings) {
        if (!selectedLayers.has(finding.layer)) continue;
        if (selectedStatus !== 'all' && finding.status !== selectedStatus) continue;
        if (!byLayer[finding.layer]) byLayer[finding.layer] = [];
        byLayer[finding.layer].push(finding);
      }

      const layers = Object.keys(byLayer).sort();
      if (layers.length === 0) {
        tree.innerHTML = '<div class="tree-layer"><div class="small">No findings match current filters.</div></div>';
        return;
      }

      tree.innerHTML = '<ul class="tree-root">' + layers.map((layer) => {
        const items = byLayer[layer];
        const checks = '<label class="small"><input type="checkbox" data-layer-toggle="' + layer + '" checked> show subtree</label>';
        const findingsHtml = items.map((item, i) => {
          const id = layer + '-' + i;
          const details = [];
          if (item.evidence) {
            details.push('<li class="leaf small"><strong>Evidence</strong>: ' + esc(item.evidence) + '</li>');
          }
          if (item.recommendation) {
            details.push('<li class="leaf small"><strong>Recommendation</strong>: ' + esc(item.recommendation) + '</li>');
          }

          return [
            '<li class="finding" data-finding="' + id + '" data-id="' + esc(item.id) + '" data-layer="' + esc(layer) + '" data-status="' + esc(item.status) + '" data-severity="' + esc(item.severity) + '">',
            '<label class="small"><input type="checkbox" data-finding-toggle="' + id + '" checked> include</label>',
            '<div class="badges">',
            '<span class="badge ' + badgeClass(item.status) + '">' + esc(item.status) + '</span>',
            '<span class="badge ' + severityClass(item.severity) + '">' + esc(item.severity) + '</span>',
            '<span class="badge">' + esc(item.id) + '</span>',
            '</div>',
            '<div class="message">' + esc(item.message) + '</div>',
            '<ul class="finding-children">' + details.join('') + '</ul>',
            '</li>',
          ].join('');
        }).join('');

        return [
          '<li>',
          '<section class="tree-layer" data-layer="' + layer + '">',
          '<div class="layer-header"><h2>' + layer + ' (inherits ' + items.length + ' findings)</h2><div>' + checks + '</div></div>',
          '<ul class="tree-children">',
          findingsHtml,
          '</ul>',
          '</section>',
          '</li>'
        ].join('');
      }).join('') + '</ul>';

      bindLocalToggles();
    }

    function bindLocalToggles() {
      document.querySelectorAll('[data-layer-toggle]').forEach((toggle) => {
        toggle.addEventListener('change', (event) => {
          const layer = event.target.getAttribute('data-layer-toggle');
          const layerNode = document.querySelector('[data-layer="' + layer + '"]');
          if (!layerNode) return;
          const show = event.target.checked;
          layerNode.querySelectorAll('.finding').forEach((el) => {
            el.style.display = show ? '' : 'none';
          });
        });
      });

      document.querySelectorAll('[data-finding-toggle]').forEach((toggle) => {
        toggle.addEventListener('change', (event) => {
          const id = event.target.getAttribute('data-finding-toggle');
          const node = document.querySelector('[data-finding="' + id + '"]');
          if (!node) return;
          if (!event.target.checked) {
            node.style.opacity = '.45';
          } else {
            node.style.opacity = '1';
          }
        });
      });
    }

    function buildFixPlan() {
      const selected = [];
      document.querySelectorAll('[data-finding]').forEach((node) => {
        const id = node.getAttribute('data-finding');
        const check = document.querySelector('[data-finding-toggle="' + id + '"]');
        if (!check || !check.checked) return;

        selected.push({
          id: node.getAttribute('data-id') || 'unknown',
          layer: node.getAttribute('data-layer') || 'unknown',
          status: node.getAttribute('data-status') || 'unknown',
          severity: node.getAttribute('data-severity') || 'unknown',
          message: node.querySelector('.message')?.textContent?.trim() || '',
          recommendation: node.querySelector('.leaf:last-child')?.textContent?.trim() || '',
        });
      });

      const lines = [];
      lines.push('Fix Plan');
      lines.push('Generated: ' + new Date().toISOString());
      lines.push('Scope: ' + report.scope + ' | Project: ' + report.projectPath);
      lines.push('');

      if (selected.length === 0) {
        lines.push('- No findings selected.');
      } else {
        selected.forEach((item, index) => {
          lines.push(String(index + 1) + '. [' + item.layer + '] ' + item.id + ' (' + item.status + '/' + item.severity + ')');
          lines.push('   Issue: ' + item.message);
          if (item.recommendation) {
            lines.push('   Action: ' + item.recommendation.replace(/^Recommendation:\s*/i, ''));
          }
          lines.push('');
        });
      }

      planOutput.value = lines.join('\n');
    }

    function commandForFinding(item) {
      const base = 'npm run audit:perms -- --mode fix';

      if (item.id === 'copilot-dangerous-skip-permissions') {
        return base + ' --target user';
      }

      if (item.id === 'workspace-settings-risk' || item.id.startsWith('workspace-suspicious-') || item.id === 'claude-broad-allowlist' || item.id === 'claude-permissions-config') {
        return base + ' --target workdir --project "' + report.projectPath + '"';
      }

      if (item.layer === 'project') {
        return base + ' --target workdir --project "' + report.projectPath + '"';
      }

      if (item.layer === 'vscode') {
        return base + ' --target user';
      }

      if (item.layer === 'os') {
        return 'No direct CLI fix: review macOS Privacy & Security settings manually.';
      }

      return 'No direct fix command for this finding; rerun audit and apply manually.';
    }

    function buildFixCommands() {
      const selected = [];
      document.querySelectorAll('[data-finding]').forEach((node) => {
        const id = node.getAttribute('data-finding');
        const check = document.querySelector('[data-finding-toggle="' + id + '"]');
        if (!check || !check.checked) return;

        selected.push({
          id: node.getAttribute('data-id') || 'unknown',
          layer: node.getAttribute('data-layer') || 'unknown',
          status: node.getAttribute('data-status') || 'unknown',
          severity: node.getAttribute('data-severity') || 'unknown',
          message: node.querySelector('.message')?.textContent?.trim() || '',
        });
      });

      const lines = [];
      lines.push('# CLI Fix Commands (generated)');
      lines.push('# Review each command before running.');
      lines.push('');

      if (selected.length === 0) {
        lines.push('# No findings selected.');
      } else {
        selected.forEach((item, index) => {
          lines.push('# ' + String(index + 1) + ' [' + item.layer + '] ' + item.id + ' (' + item.status + '/' + item.severity + ')');
          lines.push('# ' + item.message);
          lines.push(commandForFinding(item));
          lines.push('');
        });
      }

      lines.push('# Optional combined command (global; explicit acknowledgement required)');
      lines.push('npm run audit:perms -- --mode fix --target global --yes-global --project "' + report.projectPath + '"');

      commandsOutput.value = lines.join('\n');
    }

    document.querySelectorAll('input[name="status"]').forEach((radio) => {
      radio.addEventListener('change', (event) => {
        selectedStatus = event.target.value;
        render();
      });
    });

    document.querySelectorAll('.layer-toggle').forEach((box) => {
      box.addEventListener('change', (event) => {
        const layer = event.target.getAttribute('data-layer');
        if (event.target.checked) selectedLayers.add(layer);
        else selectedLayers.delete(layer);
        render();
      });
    });

    if (buildPlanBtn) {
      buildPlanBtn.addEventListener('click', () => {
        buildFixPlan();
      });
    }

    if (copyPlanBtn) {
      copyPlanBtn.addEventListener('click', async () => {
        if (!planOutput.value.trim()) {
          buildFixPlan();
        }
        try {
          await navigator.clipboard.writeText(planOutput.value);
          copyPlanBtn.textContent = 'Copied';
          setTimeout(() => { copyPlanBtn.textContent = 'Copy plan text'; }, 1200);
        } catch {
          copyPlanBtn.textContent = 'Copy failed';
          setTimeout(() => { copyPlanBtn.textContent = 'Copy plan text'; }, 1400);
        }
      });
    }

    if (buildCommandsBtn) {
      buildCommandsBtn.addEventListener('click', () => {
        buildFixCommands();
      });
    }

    if (copyCommandsBtn) {
      copyCommandsBtn.addEventListener('click', async () => {
        if (!commandsOutput.value.trim()) {
          buildFixCommands();
        }
        try {
          await navigator.clipboard.writeText(commandsOutput.value);
          copyCommandsBtn.textContent = 'Copied';
          setTimeout(() => { copyCommandsBtn.textContent = 'Copy commands'; }, 1200);
        } catch {
          copyCommandsBtn.textContent = 'Copy failed';
          setTimeout(() => { copyCommandsBtn.textContent = 'Copy commands'; }, 1400);
        }
      });
    }

    render();
  </script>
</body>
</html>`;
}

function writeJsonFile(path: string, data: Record<string, unknown>): void {
  ensureParentDir(path);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
}

function safeRead(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return undefined;
  }
}

function stripJsonComments(content: string): string {
  const withoutBlock = content.replace(/\/\*[\s\S]*?\*\//g, '');
  return withoutBlock
    .split('\n')
    .map((line) => line.replace(/(^|[^:])\/\/.*$/g, '$1'))
    .join('\n');
}

function parseJsonFile(path: string): Record<string, unknown> | undefined {
  const content = safeRead(path);
  if (!content) return undefined;
  try {
    return JSON.parse(stripJsonComments(content)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function scanInstalledExtensions(): string[] {
  const dir = join(homedir(), '.vscode', 'extensions');
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function includesAny(value: string, needles: string[]): boolean {
  const lowered = value.toLowerCase();
  return needles.some((needle) => lowered.includes(needle.toLowerCase()));
}

function findSuspiciousSettings(settings: Record<string, unknown> | undefined): Array<[string, unknown]> {
  if (!settings) return [];
  return Object.entries(settings).filter(([key, value]) => {
    if (typeof value === 'object' && value !== null) return false;
    const keyMatch = /(danger|skippermissions|auto.?approve|never.?ask|allowdangerously)/i.test(key);
    const valueMatch = typeof value === 'string' && /(always|neverask|autoapprove|danger)/i.test(value);
    const boolMatch = typeof value === 'boolean' && value === true && /(danger|skippermissions|allowdangerously)/i.test(key);
    return keyMatch || valueMatch || boolMatch;
  });
}

function gatherProjectFiles(root: string, collected: string[] = []): string[] {
  const skipDirs = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage']);
  const entries = readdirSync(root, { withFileTypes: true });

  for (const entry of entries) {
    if (skipDirs.has(entry.name)) continue;
    const fullPath = join(root, entry.name);

    if (entry.isDirectory()) {
      gatherProjectFiles(fullPath, collected);
      continue;
    }

    if (entry.isFile()) {
      collected.push(fullPath);
    }
  }

  return collected;
}

function scanProjectSecrets(projectPath: string): string[] {
  if (!existsSync(projectPath)) return [];
  const files = gatherProjectFiles(projectPath);
  const hits: string[] = [];
  const patterns = [
    /OPENROUTER_API_KEY\s*=\s*['\"][^'\"]+['\"]/,
    /sk-or-[A-Za-z0-9_-]{10,}/,
    /sk-proj-[A-Za-z0-9_-]{10,}/,
  ];
  const placeholderHints = ['your-key', 'your_key', 'example', 'placeholder', 'sample'];

  for (const file of files) {
    let isText = true;
    try {
      const stat = statSync(file);
      if (stat.size > 1024 * 1024) continue;
      const content = readFileSync(file, 'utf-8');
      const lines = content.split('\n');

      for (const line of lines) {
        const lowered = line.toLowerCase();
        if (placeholderHints.some((hint) => lowered.includes(hint))) {
          continue;
        }

        for (const pattern of patterns) {
          if (pattern.test(line)) {
            hits.push(file);
            break;
          }
        }

        if (hits[hits.length - 1] === file) {
          break;
        }
      }
    } catch {
      isText = false;
    }

    if (!isText) continue;
  }

  return hits;
}

function runAudit(options: AuditOptions): AuditReport {
  const findings: Finding[] = [];
  const projectPath = resolve(options.projectPath);

  const userSettingsPath = getUserSettingsPath();
  const userSettings = options.scope === 'all' ? parseJsonFile(userSettingsPath) : undefined;

  const workspaceSettingsPath = getWorkspaceSettingsPath(projectPath);
  const workspaceSettings = parseJsonFile(workspaceSettingsPath);

  const claudeSettingsPath = getClaudeSettingsPath(projectPath);
  const claudeSettings = parseJsonFile(claudeSettingsPath);

  if (options.scope === 'all') {
    const securityCliAvailable = (() => {
      try {
        execFileSync('which', ['security'], { stdio: 'pipe' });
        return true;
      } catch {
        return false;
      }
    })();

    findings.push({
      id: 'os-keychain-cli',
      layer: 'os',
      status: securityCliAvailable ? 'pass' : 'warn',
      severity: securityCliAvailable ? 'low' : 'medium',
      message: securityCliAvailable
        ? 'macOS Keychain CLI (security) is available.'
        : 'macOS Keychain CLI (security) is not available.',
      recommendation: securityCliAvailable
        ? 'Keep secrets in Keychain-backed storage, not plaintext config files.'
        : 'Install or enable the security CLI path to support Keychain-backed credentials.',
    });

    findings.push({
      id: 'os-tcc-review',
      layer: 'os',
      status: 'manual',
      severity: 'medium',
      message: 'Manual check required for macOS TCC grants (Accessibility, Full Disk Access, Automation).',
      recommendation:
        'In System Settings > Privacy and Security, keep only minimum required app grants and remove stale approvals.',
    });
  }

  if (options.scope === 'all') {
    if (!userSettings) {
      findings.push({
        id: 'vscode-user-settings',
        layer: 'vscode',
        status: 'warn',
        severity: 'medium',
        message: 'Unable to read VS Code user settings.json.',
        evidence: userSettingsPath,
        recommendation: 'Verify this path is readable and rerun audit.',
      });
    } else {
      const skipPerm = userSettings['github.copilot.chat.claudeAgent.allowDangerouslySkipPermissions'];
      if (skipPerm === true) {
        findings.push({
          id: 'copilot-dangerous-skip-permissions',
          layer: 'vscode',
          status: 'fail',
          severity: 'high',
          message: 'Dangerous permission skipping is enabled for Copilot Claude agent.',
          evidence: 'github.copilot.chat.claudeAgent.allowDangerouslySkipPermissions=true',
          recommendation:
            'Set github.copilot.chat.claudeAgent.allowDangerouslySkipPermissions to false to restore permission prompts.',
        });
      } else {
        findings.push({
          id: 'copilot-dangerous-skip-permissions',
          layer: 'vscode',
          status: 'pass',
          severity: 'low',
          message: 'Dangerous permission skipping is not enabled for Copilot Claude agent.',
        });
      }

      const trustEnabled = userSettings['security.workspace.trust.enabled'];
      if (trustEnabled === false) {
        findings.push({
          id: 'workspace-trust-disabled',
          layer: 'vscode',
          status: 'warn',
          severity: 'high',
          message: 'Workspace Trust appears disabled globally.',
          evidence: 'security.workspace.trust.enabled=false',
          recommendation: 'Enable Workspace Trust globally; trust only known repositories.',
        });
      }

      const suspicious = findSuspiciousSettings(userSettings);
      for (const [key, value] of suspicious) {
        if (key === 'github.copilot.chat.claudeAgent.allowDangerouslySkipPermissions') continue;
        findings.push({
          id: `suspicious-setting-${key}`,
          layer: 'vscode',
          status: 'warn',
          severity: 'medium',
          message: `Potentially permissive setting found: ${key}`,
          evidence: `${key}=${String(value)}`,
          recommendation: 'Review this setting and prefer prompt/approval modes for command and file-write actions.',
        });
      }
    }
  }

  if (workspaceSettings) {
    const suspiciousWorkspace = findSuspiciousSettings(workspaceSettings);
    if (suspiciousWorkspace.length === 0) {
      findings.push({
        id: 'workspace-settings-risk',
        layer: 'project',
        status: 'pass',
        severity: 'low',
        message: 'No obviously permissive risk flags were detected in workspace settings.',
        evidence: workspaceSettingsPath,
      });
    } else {
      for (const [key, value] of suspiciousWorkspace) {
        findings.push({
          id: `workspace-suspicious-${key}`,
          layer: 'project',
          status: 'warn',
          severity: 'medium',
          message: `Potentially permissive workspace setting: ${key}`,
          evidence: `${key}=${String(value)}`,
          recommendation: 'Use least-privilege defaults in workspace settings for shared repositories.',
        });
      }
    }
  } else {
    findings.push({
      id: 'workspace-settings-missing',
      layer: 'project',
      status: 'manual',
      severity: 'low',
      message: 'No workspace settings file found.',
      evidence: workspaceSettingsPath,
      recommendation: 'If needed, add .vscode/settings.json with explicit safe defaults for this repo.',
    });
  }

  const claudePermissions = claudeSettings?.permissions as { allow?: unknown } | undefined;
  const allowedList = Array.isArray(claudePermissions?.allow) ? claudePermissions?.allow : [];
  if (allowedList.length > 0) {
    const broad = allowedList.filter((entry) => typeof entry === 'string' && includesAny(entry, ['Bash(*)', 'WebFetch(*)', 'File(*)', 'AllowAll']));
    if (broad.length > 0) {
      findings.push({
        id: 'claude-broad-allowlist',
        layer: 'project',
        status: 'fail',
        severity: 'high',
        message: 'Claude local permissions include broad allow patterns.',
        evidence: broad.join(', '),
        recommendation: 'Replace broad allow entries with narrowly scoped commands/domains only.',
      });
    } else {
      findings.push({
        id: 'claude-allowlist-scoped',
        layer: 'project',
        status: 'pass',
        severity: 'low',
        message: 'Claude local permissions appear scoped to explicit commands/domains.',
        evidence: claudeSettingsPath,
      });
    }
  } else {
    findings.push({
      id: 'claude-permissions-config',
      layer: 'project',
      status: 'manual',
      severity: 'info',
      message: 'No Claude local allowlist found for this project.',
      evidence: claudeSettingsPath,
      recommendation: 'If using Claude Code in this project, define minimal allow rules per command/domain.',
    });
  }

  const leakedSecrets = scanProjectSecrets(projectPath);
  if (leakedSecrets.length > 0) {
    findings.push({
      id: 'project-secrets-detected',
      layer: 'project',
      status: 'fail',
      severity: 'high',
      message: 'Potential API secret patterns detected in project files.',
      evidence: leakedSecrets.slice(0, 10).join(', '),
      recommendation: 'Move secrets to Keychain or environment variables and rotate exposed keys.',
    });
  } else {
    findings.push({
      id: 'project-secrets-detected',
      layer: 'project',
      status: 'pass',
      severity: 'low',
      message: 'No obvious API key patterns detected in scanned project files.',
    });
  }

  if (options.scope === 'all') {
    const extensions = scanInstalledExtensions();

    const hasCopilot = extensions.some((name) => includesAny(name, ['github.copilot-chat']));
    const hasClaude = extensions.some((name) => includesAny(name, ['anthropic.claude-code']));
    const hasCodex = extensions.some((name) => includesAny(name, ['openai.chatgpt', 'codex', 'openai']));

    findings.push({
      id: 'extension-copilot-presence',
      layer: 'extensions',
      status: hasCopilot ? 'pass' : 'manual',
      severity: hasCopilot ? 'info' : 'low',
      message: hasCopilot
        ? 'GitHub Copilot Chat extension detected.'
        : 'GitHub Copilot Chat extension not detected.',
      recommendation: hasCopilot
        ? 'Review Copilot per-feature approval settings for terminal and file edits.'
        : 'Install and configure only if needed.',
    });

    findings.push({
      id: 'extension-claude-presence',
      layer: 'extensions',
      status: hasClaude ? 'pass' : 'manual',
      severity: hasClaude ? 'info' : 'low',
      message: hasClaude
        ? 'Anthropic Claude Code extension detected.'
        : 'Anthropic Claude Code extension not detected.',
      recommendation: hasClaude
        ? 'Keep command/domain allowlists narrow and project-scoped.'
        : 'Install only when required for workflow.',
    });

    findings.push({
      id: 'extension-codex-presence',
      layer: 'extensions',
      status: hasCodex ? 'pass' : 'manual',
      severity: hasCodex ? 'info' : 'low',
      message: hasCodex
        ? 'OpenAI extension (Codex/ChatGPT family) detected.'
        : 'OpenAI Codex/ChatGPT extension not detected.',
      recommendation: hasCodex
        ? 'Use prompt-on-write/execute mode unless in tightly controlled trusted projects.'
        : 'Install only when required for workflow.',
    });
  }

  const summary = {
    fail: findings.filter((f) => f.status === 'fail').length,
    warn: findings.filter((f) => f.status === 'warn').length,
    pass: findings.filter((f) => f.status === 'pass').length,
    manual: findings.filter((f) => f.status === 'manual').length,
  };

  return {
    scope: options.scope,
    projectPath,
    generatedAt: new Date().toISOString(),
    findings,
    summary,
  };
}

function formatText(report: AuditReport): string {
  const lines: string[] = [];

  lines.push('Permissions Audit Report');
  lines.push(`Scope: ${report.scope}`);
  lines.push(`Project: ${report.projectPath}`);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');

  for (const finding of report.findings) {
    lines.push(`[${finding.status.toUpperCase()}][${finding.severity.toUpperCase()}][${finding.layer}] ${finding.message}`);
    if (finding.evidence) lines.push(`  Evidence: ${finding.evidence}`);
    if (finding.recommendation) lines.push(`  Change: ${finding.recommendation}`);
    lines.push('');
  }

  lines.push('Summary');
  lines.push(`  Fail: ${report.summary.fail}`);
  lines.push(`  Warn: ${report.summary.warn}`);
  lines.push(`  Pass: ${report.summary.pass}`);
  lines.push(`  Manual: ${report.summary.manual}`);

  return lines.join('\n');
}

function runFix(options: AuditOptions): { changed: string[]; warnings: string[] } {
  const projectPath = resolve(options.projectPath);
  const userSettingsPath = getUserSettingsPath();
  const workspaceSettingsPath = getWorkspaceSettingsPath(projectPath);
  const claudeSettingsPath = getClaudeSettingsPath(projectPath);

  const changed: string[] = [];
  const warnings: string[] = [];

  if (options.target === 'global' && !options.yesGlobal) {
    throw new Error(
      [
        'GLOBAL FIX BLOCKED',
        'Global mode changes user-level settings and project settings that affect multiple workflows.',
        'Review the current report first, then rerun with: --target global --yes-global',
      ].join('\n'),
    );
  }

  const shouldFixUser = options.target === 'user' || options.target === 'global';
  const shouldFixWorkdir = options.target === 'workdir' || options.target === 'global';

  if (shouldFixUser) {
    const userSettings = parseJsonFile(userSettingsPath) ?? {};
    const prior = userSettings['github.copilot.chat.claudeAgent.allowDangerouslySkipPermissions'];
    userSettings['github.copilot.chat.claudeAgent.allowDangerouslySkipPermissions'] = false;
    writeJsonFile(userSettingsPath, userSettings);
    changed.push(`Updated user setting at ${userSettingsPath}`);

    if (prior === true) {
      warnings.push('Disabled dangerous Copilot skip-permissions flag in VS Code user settings.');
    }
  }

  if (shouldFixWorkdir) {
    const workspaceSettings = parseJsonFile(workspaceSettingsPath) ?? {};
    workspaceSettings['github.copilot.chat.claudeAgent.allowDangerouslySkipPermissions'] = false;
    writeJsonFile(workspaceSettingsPath, workspaceSettings);
    changed.push(`Updated workspace setting at ${workspaceSettingsPath}`);

    const claudeSettings = parseJsonFile(claudeSettingsPath);
    if (claudeSettings && typeof claudeSettings === 'object') {
      const permissions = claudeSettings.permissions as { allow?: unknown } | undefined;
      if (permissions && Array.isArray(permissions.allow)) {
        const original = permissions.allow.filter((x) => typeof x === 'string');
        const narrowed = original.filter((entry) => !includesAny(entry, ['Bash(*)', 'WebFetch(*)', 'File(*)', 'AllowAll']));
        if (narrowed.length !== original.length) {
          claudeSettings.permissions = { ...permissions, allow: narrowed };
          writeJsonFile(claudeSettingsPath, claudeSettings);
          changed.push(`Narrowed Claude allowlist at ${claudeSettingsPath}`);
        }
      }
    }
  }

  if (options.target === 'global') {
    warnings.unshift('STERN WARNING: Global fix mode modifies both user-level and repository-level behavior.');
    warnings.push('Global fix mode does not alter macOS TCC permissions; review those manually in System Settings.');
  }

  return { changed, warnings };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));

  if (options.mode === 'snapshot') {
    const result = runSnapshot(options);
    const lines: string[] = [];
    lines.push('Permissions Snapshot Report');
    lines.push(`Target: ${options.target}`);
    lines.push(`Snapshot: ${options.snapshotName}`);
    lines.push(`File: ${result.snapshotPath}`);
    lines.push('');
    if (result.warnings.length > 0) {
      lines.push('Warnings');
      for (const warning of result.warnings) lines.push(`- ${warning}`);
      lines.push('');
    }
    lines.push('Captured');
    if (result.captured.length === 0) lines.push('- None');
    else for (const item of result.captured) lines.push(`- ${item}`);
    if (result.skipped.length > 0) {
      lines.push('');
      lines.push('Skipped (not found/unreadable)');
      for (const item of result.skipped) lines.push(`- ${item}`);
    }
    console.log(lines.join('\n'));
    return;
  }

  if (options.mode === 'restore') {
    const result = runRestore(options);
    const lines: string[] = [];
    lines.push('Permissions Restore Report');
    lines.push(`Target: ${options.target}`);
    lines.push(`Snapshot: ${options.snapshotName}`);
    lines.push(`Source: ${result.snapshotPath}`);
    lines.push('');
    if (result.warnings.length > 0) {
      lines.push('Warnings');
      for (const warning of result.warnings) lines.push(`- ${warning}`);
      lines.push('');
    }
    lines.push('Restored');
    if (result.restored.length === 0) lines.push('- No matching files restored for selected target.');
    else for (const item of result.restored) lines.push(`- ${item}`);
    console.log(lines.join('\n'));
    return;
  }

  if (options.mode === 'copy') {
    const result = runCopy(options);
    const lines: string[] = [];
    lines.push('Permissions Copy Report');
    lines.push(`From: ${options.fromWorkdir ?? ''}`);
    lines.push(`To: ${options.toWorkdir ?? ''}`);
    lines.push('');
    lines.push('Copied');
    if (result.copied.length === 0) lines.push('- None');
    else for (const item of result.copied) lines.push(`- ${item}`);
    if (result.skipped.length > 0) {
      lines.push('');
      lines.push('Skipped (missing source files)');
      for (const item of result.skipped) lines.push(`- ${item}`);
    }
    console.log(lines.join('\n'));
    return;
  }

  if (options.mode === 'fix') {
    const result = runFix(options);
    const lines: string[] = [];

    lines.push('Permissions Fix Report');
    lines.push(`Target: ${options.target}`);
    lines.push(`Project: ${resolve(options.projectPath)}`);
    lines.push(`Timestamp: ${new Date().toISOString()}`);
    lines.push('');

    if (result.warnings.length > 0) {
      lines.push('Warnings');
      for (const warning of result.warnings) {
        lines.push(`- ${warning}`);
      }
      lines.push('');
    }

    lines.push('Changes');
    if (result.changed.length === 0) {
      lines.push('- No changes were required.');
    } else {
      for (const change of result.changed) {
        lines.push(`- ${change}`);
      }
    }

    const renderedFix = lines.join('\n');
    if (options.outputPath) {
      writeFileSync(options.outputPath, renderedFix, 'utf-8');
      console.log(`Wrote report: ${options.outputPath}`);
    } else {
      console.log(renderedFix);
    }
    return;
  }

  const report = runAudit(options);

  if (options.format === 'web') {
    const html = renderAuditWeb(report, options.interactive);
    const filePath = options.outputPath
      ? options.outputPath
      : join(mkdtempSync(join(tmpdir(), 'allofus-perms-')), 'permissions-audit.html');

    const parent = filePath.slice(0, filePath.lastIndexOf('/'));
    if (parent && !existsSync(parent)) {
      mkdirSync(parent, { recursive: true });
    }

    writeFileSync(filePath, html, 'utf-8');
    console.log(`Wrote web report: ${filePath}`);

    if (options.openBrowser || !options.outputPath) {
      openInBrowser(filePath);
      console.log('Opened report in default browser.');
    }

    if (report.summary.fail > 0) {
      process.exitCode = 2;
    } else if (report.summary.warn > 0) {
      process.exitCode = 1;
    }
    return;
  }

  const rendered = options.format === 'json'
    ? JSON.stringify(report, null, 2)
    : formatText(report);

  if (options.outputPath) {
    writeFileSync(options.outputPath, rendered, 'utf-8');
    console.log(`Wrote report: ${options.outputPath}`);
    return;
  }

  console.log(rendered);

  if (report.summary.fail > 0) {
    process.exitCode = 2;
  } else if (report.summary.warn > 0) {
    process.exitCode = 1;
  }
}

main();
