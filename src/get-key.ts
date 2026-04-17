import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';

const SERVICE = 'dev-api-keys';

/**
 * Get an API key — checks env var first, falls back to macOS Keychain.
 *
 *   const key = getKey('openrouter');
 *   // checks process.env.OPENROUTER_API_KEY, then Keychain "dev-api-keys" / "openrouter"
 *
 * Runtime note: the Keychain fallback uses the macOS `security` CLI and
 * so only works on darwin. On other platforms, set the env var explicitly
 * (or wire up a cross-platform KeyStore via dev-keys/src/keystore.ts).
 */
export function getKey(name: string): string {
  const envName = `${name.toUpperCase().replace(/-/g, '_')}_API_KEY`;
  const fromEnv = process.env[envName];
  if (fromEnv) {
    return fromEnv;
  }

  if (platform() !== 'darwin') {
    throw new Error(
      `API key "${name}" not found. Set ${envName} in your environment. ` +
      `(Keychain fallback is macOS-only; cross-platform KeyStore lives in ` +
      `dev-keys/src/keystore.ts.)`,
    );
  }

  try {
    return execFileSync(
      'security',
      ['find-generic-password', '-s', SERVICE, '-a', name, '-w'],
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
  } catch {
    throw new Error(
      `API key "${name}" not found. Set ${envName} or run: dev-keys set ${name}`,
    );
  }
}
