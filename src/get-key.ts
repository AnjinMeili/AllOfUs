import { AsyncEntry } from '@napi-rs/keyring';

const SERVICE = 'dev-api-keys';

/**
 * Resolve an API key — env var first, then the OS credential store.
 *
 *   const key = await getKey('openrouter');
 *   // checks process.env.OPENROUTER_API_KEY, then the platform keystore:
 *   //   macOS   → Keychain
 *   //   Linux   → Secret Service
 *   //   Windows → Credential Manager
 *
 * Throws with a clear message pointing at `dev-keys set <name>` if the
 * key is missing everywhere.
 */
export async function getKey(name: string): Promise<string> {
  const envName = `${name.toUpperCase().replace(/-/g, '_')}_API_KEY`;
  const fromEnv = process.env[envName];
  if (fromEnv) return fromEnv;

  let lookupError: string | undefined;
  try {
    const entry = new AsyncEntry(SERVICE, name);
    const value = await entry.getPassword();
    if (value) return value;
  } catch (error) {
    lookupError = error instanceof Error ? error.message : String(error);
  }

  if (lookupError) {
    throw new Error(
      `API key "${name}" could not be read from the secure store (${lookupError}). Set ${envName} or run: dev-keys set ${name}`,
    );
  }

  throw new Error(
    `API key "${name}" not found. Set ${envName} or run: dev-keys set ${name}`,
  );
}
