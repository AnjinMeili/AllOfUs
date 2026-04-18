import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { addName, parseIndex, removeName, serializeIndex, type NameIndex } from './keystore-names.js';

const SERVICE = 'dev-api-keys';

/**
 * Platform-agnostic interface for a key/value secret store keyed by a
 * human-readable name. Keys are single opaque strings (API keys, tokens).
 *
 * Two implementations ship today:
 *  - Darwin: macOS `security` CLI (unchanged from before; preserves
 *    existing Keychain entries and supports listing via dump-keychain)
 *  - Other platforms: @napi-rs/keyring (Windows Credential Manager,
 *    Linux Secret Service) plus a small on-disk name index for list()
 *    because keyring exposes only get/set/delete.
 */
export interface KeyStore {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  list(): Promise<string[]>;
}

// ── Darwin: macOS `security` CLI (existing behavior) ─────────────────

function runSecurity(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('security', args, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
        return;
      }
      resolve(stdout);
    });
  });
}

const darwinKeyStore: KeyStore = {
  async get(name) {
    try {
      const value = await runSecurity(['find-generic-password', '-s', SERVICE, '-a', name, '-w']);
      return value.trim();
    } catch {
      return undefined;
    }
  },

  async set(name, value) {
    await this.delete(name).catch(() => { /* ignore */ });
    await runSecurity(['add-generic-password', '-s', SERVICE, '-a', name, '-w', value, '-U']);
  },

  async delete(name) {
    await runSecurity(['delete-generic-password', '-s', SERVICE, '-a', name]);
  },

  async list() {
    try {
      const dump = await runSecurity(['dump-keychain']);
      const names: string[] = [];
      const lines = dump.split('\n');
      let foundService = false;

      for (const line of lines) {
        if (line.includes('0x00000007 <blob>=') && line.includes(`"${SERVICE}"`)) {
          foundService = true;
          continue;
        }
        if (foundService && line.includes('"acct"<blob>=')) {
          const match = line.match(/="([^"]*)"/);
          if (match?.[1]) names.push(match[1]);
          foundService = false;
        }
        if (line.startsWith('keychain:') || line.startsWith('class:')) {
          foundService = false;
        }
      }

      return [...new Set(names)].sort();
    } catch {
      return [];
    }
  },
};

// ── Other platforms: @napi-rs/keyring + on-disk name index ───────────

function configDir(): string {
  if (platform() === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) return join(appData, 'dev-keys');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, 'dev-keys');
  return join(homedir(), '.config', 'dev-keys');
}

function indexPath(): string {
  return join(configDir(), 'names.json');
}

type AsyncEntryLike = {
  getPassword(): Promise<string | null | undefined>;
  setPassword(value: string): Promise<void>;
  deletePassword(): Promise<void>;
};

type AsyncEntryCtor = new (service: string, name: string) => AsyncEntryLike;

let asyncEntryCtor: AsyncEntryCtor | undefined;

async function getKeyringEntry(name: string): Promise<AsyncEntryLike> {
  if (!asyncEntryCtor) {
    const mod = await import('@napi-rs/keyring');
    asyncEntryCtor = mod.AsyncEntry as AsyncEntryCtor;
  }
  return new asyncEntryCtor(SERVICE, name);
}

function readIndex(): NameIndex {
  const path = indexPath();
  if (!existsSync(path)) return { names: [] };
  try {
    return parseIndex(readFileSync(path, 'utf-8'));
  } catch {
    return { names: [] };
  }
}

function writeIndex(index: NameIndex): void {
  const path = indexPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, serializeIndex(index), { encoding: 'utf-8', mode: 0o600 });
}

const keyringKeyStore: KeyStore = {
  async get(name) {
    try {
      const entry = await getKeyringEntry(name);
      const value = await entry.getPassword();
      return value ?? undefined;
    } catch {
      return undefined;
    }
  },

  async set(name, value) {
    const entry = await getKeyringEntry(name);
    await entry.setPassword(value);
    writeIndex(addName(readIndex(), name));
  },

  async delete(name) {
    const entry = await getKeyringEntry(name);
    try { await entry.deletePassword(); } catch { /* absent is fine */ }
    writeIndex(removeName(readIndex(), name));
  },

  async list() {
    // Reconcile the index against the credential store: any name that's
    // in the index but whose credential has disappeared (e.g. a user
    // deleted it via a native tool) is pruned here, so list() never
    // reports ghosts.
    const index = readIndex();
    const present: string[] = [];
    for (const name of index.names) {
      try {
        const entry = await getKeyringEntry(name);
        const value = await entry.getPassword();
        if (value !== undefined && value !== null) present.push(name);
      } catch {
        /* pruned */
      }
    }
    if (present.length !== index.names.length) {
      writeIndex({ names: present });
    }
    return [...present].sort();
  },
};

// ── Factory ──────────────────────────────────────────────────────────

/**
 * Return the KeyStore implementation for the current platform.
 *
 * macOS uses the existing `security` CLI implementation so users who
 * stored keys before this change continue to see them. Linux and
 * Windows use @napi-rs/keyring, which maps to Secret Service and
 * Credential Manager respectively.
 */
export function createKeyStore(): KeyStore {
  if (platform() === 'darwin') return darwinKeyStore;
  return keyringKeyStore;
}
