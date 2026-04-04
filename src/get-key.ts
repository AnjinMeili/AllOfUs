import { execFileSync } from 'node:child_process';

const SERVICE = 'dev-api-keys';

/**
 * Get an API key — checks env var first, falls back to macOS Keychain.
 *
 *   const key = getKey('openrouter');
 *   // checks process.env.OPENROUTER_API_KEY, then Keychain "dev-api-keys" / "openrouter"
 */
export function getKey(name: string): string {
  const envName = `${name.toUpperCase().replace(/-/g, '_')}_API_KEY`;
  const fromEnv = process.env[envName];
  if (fromEnv) {
    return fromEnv;
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
