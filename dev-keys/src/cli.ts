#!/usr/bin/env node
/**
 * dev-keys — cross-platform CLI for the KeyStore.
 *
 * Replaces the earlier bash script, which was macOS-only because it
 * shelled directly to the `security` command. All key operations now go
 * through ./keystore.js, so the same code path works on macOS (Keychain),
 * Linux (Secret Service), and Windows (Credential Manager).
 *
 * The terminal-capability detection (NO_COLOR, CLICOLOR, CLICOLOR_FORCE,
 * TERM=dumb, Unicode locale, tty width) is ported verbatim from the bash
 * original — that logic was the most carefully tuned part of the old
 * script and it works the same way in Node.
 */

import { spawnSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { createKeyStore, type KeyStore } from './keystore.js';
import { validateKey, validateStoredKey } from './validation.js';

const VERSION = '0.1.0';

// ── Terminal capability detection ────────────────────────────────────

const env = process.env;

function isDumb(): boolean {
  const t = env.TERM;
  return t === 'dumb' || t === 'emacs' || !t;
}

function useColor(): boolean {
  // Respect NO_COLOR absolutely (https://no-color.org)
  if (env.NO_COLOR) return false;
  // CLICOLOR_FORCE forces color regardless of tty/dumb
  if (env.CLICOLOR_FORCE) return true;
  if (isDumb()) return false;
  if (env.CLICOLOR === '0') return false;
  return process.stderr.isTTY === true;
}

function useUnicode(): boolean {
  if (isDumb()) return false;
  const locale = env.LC_ALL ?? env.LC_CTYPE ?? env.LANG ?? '';
  if (/UTF-?8/i.test(locale)) return true;
  // Modern terminals generally support Unicode even without locale hints
  return !!env.TERM;
}

function termCols(): number {
  if (typeof process.stderr.columns === 'number' && process.stderr.columns > 0) {
    return process.stderr.columns;
  }
  const cols = parseInt(env.COLUMNS ?? '', 10);
  return Number.isFinite(cols) && cols > 0 ? cols : 80;
}

const color = useColor();
const unicode = useUnicode();
const cols = termCols();

const seq = color
  ? {
    bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m',
    green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m',
  }
  : {
    bold: '', dim: '', reset: '', green: '', red: '', yellow: '', cyan: '',
  };

const sym = unicode
  ? { ok: '✓', err: '✗', bullet: '·', key: '🔑' }
  : { ok: 'OK', err: 'ERR', bullet: '-', key: '*' };

function ok(msg: string): void { process.stderr.write(`${seq.green}${sym.ok}${seq.reset} ${msg}\n`); }
function err(msg: string): void { process.stderr.write(`${seq.red}${sym.err}${seq.reset} ${msg}\n`); }
function info(msg: string): void { process.stderr.write(`${seq.dim}${msg}${seq.reset}\n`); }

// ── Input helpers ────────────────────────────────────────────────────

function readLineFromStdin(prompt: string): Promise<string> {
  return new Promise((resolveLine) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    rl.question(prompt, (answer) => {
      rl.close();
      resolveLine(answer);
    });
  });
}

function readPasswordFromStdin(prompt: string): Promise<string> {
  return new Promise((resolveValue) => {
    // If stdin isn't a TTY, fall back to a regular read (no masking needed)
    if (!process.stdin.isTTY) {
      return resolveValue(readLineFromStdin(prompt));
    }
    process.stderr.write(prompt);
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    // readline's terminal mode still echoes — we temporarily disable echo
    const setRawMode = process.stdin.setRawMode?.bind(process.stdin);
    if (!setRawMode) {
      // No raw mode available; fall back to echoing
      rl.question('', (answer) => { rl.close(); resolveValue(answer); });
      return;
    }
    setRawMode(true);
    let buf = '';
    const onData = (chunk: Buffer) => {
      const s = chunk.toString('utf-8');
      for (const ch of s) {
        if (ch === '\r' || ch === '\n') {
          process.stdin.removeListener('data', onData);
          setRawMode(false);
          rl.close();
          process.stderr.write('\n');
          resolveValue(buf);
          return;
        }
        if (ch === '\x03') { // Ctrl-C
          process.stdin.removeListener('data', onData);
          setRawMode(false);
          rl.close();
          process.stderr.write('\n');
          process.exit(130);
        }
        if (ch === '\x7f' || ch === '\b') { // backspace
          buf = buf.slice(0, -1);
        } else {
          buf += ch;
        }
      }
    };
    process.stdin.on('data', onData);
  });
}

// ── Commands ─────────────────────────────────────────────────────────

function envNameFor(key: string): string {
  return `${key.toUpperCase().replace(/-/g, '_')}_API_KEY`;
}

const VALID_KEY_NAME = /^[a-z0-9_-]{1,64}$/i;

function requireValidName(name: string | undefined): string {
  if (!name) {
    err('Missing key name');
    process.exit(1);
  }
  if (!VALID_KEY_NAME.test(name)) {
    err(`Invalid key name "${name}" (use [a-z0-9_-], 1-64 chars)`);
    process.exit(1);
  }
  return name;
}

async function cmdSet(store: KeyStore, args: string[]): Promise<void> {
  const name = requireValidName(args[0]);
  let value = args[1];
  if (!value) {
    if (process.stdin.isTTY) {
      value = await readPasswordFromStdin(
        `${seq.bold}Enter value for ${seq.cyan}${name}${seq.reset}: `,
      );
    } else {
      value = (await readLineFromStdin('')).trim();
    }
  }
  if (!value) {
    err('Empty value — nothing stored');
    process.exit(1);
  }
  await store.set(name, value);
  ok(`Stored ${seq.bold}${name}${seq.reset}`);

  const validation = await validateKey(name, value);
  if (validation.kind === 'network' && validation.ok) {
    ok(validation.message);
  } else if (!validation.ok) {
    err(`Sanity check failed: ${validation.message}`);
  } else {
    info(validation.message);
  }
}

async function cmdGet(store: KeyStore, args: string[]): Promise<void> {
  const name = requireValidName(args[0]);
  const value = await store.get(name);
  if (!value) {
    err(`Key '${name}' not found`);
    info(`Store it with: dev-keys set ${name}`);
    process.exit(1);
  }
  process.stdout.write(value);
  if (process.stdout.isTTY) process.stdout.write('\n');
}

function mask(value: string, maxWidth: number): string {
  const visible = value.length <= 8 ? 2 : 4;
  const maxMask = Math.max(8, maxWidth);
  const maskLen = Math.min(value.length - visible, maxMask);
  return value.slice(0, visible) + '*'.repeat(Math.max(0, maskLen));
}

async function cmdShow(store: KeyStore, args: string[]): Promise<void> {
  const name = requireValidName(args[0]);
  const value = await store.get(name);
  if (!value) {
    err(`Key '${name}' not found`);
    process.exit(1);
  }
  const nameCol = 20;
  const maxMask = Math.max(8, cols - nameCol - 2);
  const masked = mask(value, maxMask);
  process.stdout.write(`${seq.cyan}${name.padEnd(nameCol)}${seq.reset} ${masked}\n`);
}

async function cmdDelete(store: KeyStore, args: string[]): Promise<void> {
  const name = requireValidName(args[0]);
  if (process.stdin.isTTY) {
    const answer = await readLineFromStdin(
      `${seq.yellow}Delete${seq.reset} ${seq.bold}${name}${seq.reset} from the keystore? [y/N] `,
    );
    if (!/^y(es)?$/i.test(answer.trim())) {
      info('Cancelled');
      return;
    }
  }
  const existed = await store.get(name);
  if (!existed) {
    err(`Key '${name}' not found`);
    process.exit(1);
  }
  await store.delete(name);
  ok(`Deleted ${seq.bold}${name}${seq.reset}`);
}

async function cmdList(store: KeyStore): Promise<void> {
  const names = await store.list();
  if (names.length === 0) {
    info('No keys stored. Add one with: dev-keys set <name>');
    return;
  }
  info(`${names.length} key(s) stored:`);
  for (const name of names) {
    process.stdout.write(`  ${seq.cyan}${name}${seq.reset}\n`);
  }
}

async function cmdEnv(store: KeyStore, args: string[]): Promise<void> {
  const requested = args.length > 0 ? args : await store.list();
  for (const name of requested) {
    if (!VALID_KEY_NAME.test(name)) continue;
    const value = await store.get(name);
    if (!value) continue;
    // Escape single quotes for safe eval in sh/bash
    const escaped = value.replace(/'/g, `'\\''`);
    process.stdout.write(`export ${envNameFor(name)}='${escaped}'\n`);
  }
}

async function cmdTest(store: KeyStore, args: string[]): Promise<void> {
  const name = requireValidName(args[0]);
  const result = await validateStoredKey(name, store);
  if (result.ok) {
    ok(result.message);
    return;
  }
  err(result.message);
  process.exit(1);
}

function cmdInit(): void {
  process.stdout.write(`# dev-keys: load API keys into the environment
# Add this line to your .zshrc / .bashrc:
#   eval "$(dev-keys init)"

# Load all stored keys as <NAME>_API_KEY env vars
eval "$(dev-keys env 2>/dev/null)"

# Helper: run any command with a single key injected
# Usage: with-key openrouter npm start
with-key() {
  local name="$1"; shift
  local env_name
  env_name=$(echo "$name" | tr '[:lower:]-' '[:upper:]_')
  export "\${env_name}_API_KEY=$(dev-keys get "$name")"
  "$@"
}
`);
}

function cmdUi(args: string[]): never {
  // Resolve the compiled web-server script next to this CLI module.
  // dev-keys compiles to CommonJS, so __dirname is defined.
  const server = resolve(__dirname, 'web-server.js');
  const result = spawnSync(process.execPath, [server, ...args], { stdio: 'inherit' });
  process.exit(result.status ?? 0);
}

// ── Help ─────────────────────────────────────────────────────────────

function printHelp(): void {
  const s = unicode ? seq : { ...seq, bold: '', dim: '', reset: '', cyan: '' };
  process.stdout.write(`${s.bold}dev-keys${s.reset} ${s.dim}v${VERSION}${s.reset} — cross-platform API key storage

${s.bold}USAGE${s.reset}
  dev-keys <command> [args]

${s.bold}COMMANDS${s.reset}
  ${s.cyan}set${s.reset} <name> [value]     Store a key (prompts securely if value omitted)
  ${s.cyan}get${s.reset} <name>             Print a key to stdout
  ${s.cyan}delete${s.reset} <name>          Remove a key
  ${s.cyan}list${s.reset}                   List stored key names
  ${s.cyan}env${s.reset} [names...]         Print export statements for shell eval
  ${s.cyan}init${s.reset}                   Print shell startup script (for .zshrc/.bashrc)
  ${s.cyan}show${s.reset} <name>            Print key name + masked value
  ${s.cyan}test${s.reset} <name>            Validate a stored key with a sanity check
  ${s.cyan}ui${s.reset}                     Open setup panel in your browser

${s.bold}OPTIONS${s.reset}
  --help, -h              Show this help
  --version, -v           Print version

${s.bold}BACKEND${s.reset}
  macOS   — Keychain (via the security CLI)
  Linux   — Secret Service (via @napi-rs/keyring)
  Windows — Credential Manager (via @napi-rs/keyring)
`);
}

// ── Dispatch ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);

  if (!cmd || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }
  if (cmd === '--version' || cmd === '-v') {
    process.stdout.write(`dev-keys ${VERSION}\n`);
    return;
  }

  // `ui` spawns a child process and replaces this one — no store needed here
  if (cmd === 'ui') return cmdUi(rest);
  if (cmd === 'init') return cmdInit();

  const store = createKeyStore();

  switch (cmd) {
    case 'set':                                  return cmdSet(store, rest);
    case 'get':                                  return cmdGet(store, rest);
    case 'show':                                 return cmdShow(store, rest);
    case 'test': case 'validate':                return cmdTest(store, rest);
    case 'delete': case 'rm':                    return cmdDelete(store, rest);
    case 'list': case 'ls':                      return cmdList(store);
    case 'env':                                  return cmdEnv(store, rest);
    default:
      err(`Unknown command: ${cmd}`);
      process.stderr.write('\n');
      printHelp();
      process.exit(1);
  }
}

main().catch((e) => {
  err(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
