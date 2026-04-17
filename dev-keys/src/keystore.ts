import { execFile } from 'node:child_process';
import { platform } from 'node:os';

const SERVICE = 'dev-api-keys';

/**
 * Platform-agnostic interface for a key/value secret store keyed by a
 * human-readable name. Keys are single opaque strings (API keys, tokens).
 *
 * Today we ship only a macOS Keychain-backed implementation; adding
 * @napi-rs/keyring (or equivalent) to cover Linux Secret Service and
 * Windows Credential Manager is a mechanical addition behind this type.
 */
export interface KeyStore {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  list(): Promise<string[]>;
}

function run(args: string[]): Promise<string> {
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
      const value = await run(['find-generic-password', '-s', SERVICE, '-a', name, '-w']);
      return value.trim();
    } catch {
      return undefined;
    }
  },

  async set(name, value) {
    // `security add-generic-password` fails on duplicates without -U, and
    // -U alone merges metadata but keeps the old password in some cases.
    // Deleting first makes the result unambiguous.
    await this.delete(name).catch(() => { /* ignore */ });
    await run(['add-generic-password', '-s', SERVICE, '-a', name, '-w', value, '-U']);
  },

  async delete(name) {
    await run(['delete-generic-password', '-s', SERVICE, '-a', name]);
  },

  async list() {
    try {
      const dump = await run(['dump-keychain']);
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

/**
 * Return the KeyStore implementation for the current platform. Throws a
 * clear error on unsupported platforms so callers fail loudly rather than
 * silently misbehave.
 */
export function createKeyStore(): KeyStore {
  const p = platform();
  if (p === 'darwin') return darwinKeyStore;
  throw new Error(
    `dev-keys does not yet support platform "${p}". ` +
    'Only macOS (darwin) is implemented. See THREAT_MODEL.md.',
  );
}
