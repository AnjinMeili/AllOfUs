import { describe, expect, it } from 'vitest';
import {
  addName,
  parseIndex,
  removeName,
  serializeIndex,
} from '../dev-keys/src/keystore-names.js';

describe('parseIndex', () => {
  it('returns empty index for missing/empty input', () => {
    expect(parseIndex(undefined).names).toEqual([]);
    expect(parseIndex('').names).toEqual([]);
  });

  it('returns empty index for malformed JSON', () => {
    expect(parseIndex('{not json').names).toEqual([]);
    expect(parseIndex('[]').names).toEqual([]);
    expect(parseIndex('null').names).toEqual([]);
  });

  it('parses a valid index and dedupes + sorts', () => {
    const idx = parseIndex(JSON.stringify({ names: ['zoo', 'alpha', 'alpha'] }));
    expect(idx.names).toEqual(['alpha', 'zoo']);
  });

  it('drops names that fail the [a-z0-9_-] pattern', () => {
    const idx = parseIndex(JSON.stringify({
      names: ['ok_name', 'ALSO-OK-1', 'has space', '<script>', ''],
    }));
    expect(idx.names).toEqual(['ALSO-OK-1', 'ok_name']);
  });

  it('drops non-string entries', () => {
    const idx = parseIndex(JSON.stringify({ names: ['a', 42, null, { x: 1 }] }));
    expect(idx.names).toEqual(['a']);
  });
});

describe('serializeIndex', () => {
  it('produces sorted, stable JSON ending in a newline', () => {
    const out = serializeIndex({ names: ['zoo', 'alpha'] });
    expect(out).toBe('{\n  "names": [\n    "alpha",\n    "zoo"\n  ]\n}\n');
  });

  it('round-trips through parseIndex', () => {
    const input = { names: ['openrouter', 'anthropic'] };
    expect(parseIndex(serializeIndex(input)).names).toEqual(['anthropic', 'openrouter']);
  });
});

describe('addName / removeName', () => {
  it('addName inserts and sorts; is a no-op if present', () => {
    const a = addName({ names: ['b'] }, 'a');
    expect(a.names).toEqual(['a', 'b']);
    const b = addName(a, 'a');
    expect(b).toEqual(a);
  });

  it('removeName removes; is a no-op if absent', () => {
    const a = removeName({ names: ['a', 'b'] }, 'a');
    expect(a.names).toEqual(['b']);
    const b = removeName(a, 'a');
    expect(b).toEqual(a);
  });

  it('addName/removeName do not mutate the input', () => {
    const orig = { names: ['a'] };
    const after = addName(orig, 'b');
    expect(orig.names).toEqual(['a']);
    expect(after.names).toEqual(['a', 'b']);
  });
});
