/**
 * Pure helpers for the name-index file used by keystore backends that
 * can't enumerate stored credentials (@napi-rs/keyring exposes only
 * get/set/delete — no list). The index stores just key NAMES, never
 * values, so it is safe to keep in a regular config file.
 *
 * Exported separately from keystore.ts so unit tests don't pull in
 * native bindings.
 */

export interface NameIndex {
  names: string[];
}

/**
 * Parse a possibly-missing, possibly-malformed index file. Returns an
 * empty index on any error — the on-disk index is an advisory cache,
 * not the source of truth for secret storage.
 */
export function parseIndex(content: string | undefined): NameIndex {
  if (!content) return { names: [] };
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { names?: unknown }).names)) {
      const names = ((parsed as { names: unknown[] }).names)
        .filter((n): n is string => typeof n === 'string')
        .filter((n) => /^[a-z0-9_-]{1,64}$/i.test(n));
      return { names: [...new Set(names)].sort() };
    }
  } catch {
    /* fall through */
  }
  return { names: [] };
}

export function serializeIndex(index: NameIndex): string {
  return `${JSON.stringify({ names: [...index.names].sort() }, null, 2)}\n`;
}

export function addName(index: NameIndex, name: string): NameIndex {
  if (index.names.includes(name)) return index;
  return { names: [...index.names, name].sort() };
}

export function removeName(index: NameIndex, name: string): NameIndex {
  if (!index.names.includes(name)) return index;
  return { names: index.names.filter((n) => n !== name) };
}
