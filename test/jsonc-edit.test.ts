import { describe, expect, it } from 'vitest';
import { planJsoncEdits } from '../src/jsonc-edit.js';

describe('planJsoncEdits', () => {
  it('preserves line and block comments around the edit', () => {
    const input = [
      '{',
      '  // keep me',
      '  "a": 1,',
      '  /* block comment */',
      '  "b": true',
      '}',
      '',
    ].join('\n');

    const { newText, edits } = planJsoncEdits(input, [
      { jsonPath: ['b'], newValue: false, description: 'flip b' },
    ]);

    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ before: true, after: false });
    expect(newText).toContain('// keep me');
    expect(newText).toContain('/* block comment */');
    expect(newText).toContain('"b": false');
  });

  it('does not corrupt URLs inside comments or strings', () => {
    const input = [
      '{',
      '  "font": "Menlo", // see https://example.com/x',
      '  "flag": true',
      '}',
      '',
    ].join('\n');

    const { newText } = planJsoncEdits(input, [
      { jsonPath: ['flag'], newValue: false, description: 'flip flag' },
    ]);

    expect(newText).toContain('https://example.com/x');
  });

  it('tolerates trailing commas', () => {
    const input = '{\n  "a": 1,\n  "b": 2,\n}\n';
    const { newText } = planJsoncEdits(input, [
      { jsonPath: ['b'], newValue: 99, description: 'bump b' },
    ]);
    expect(newText).toContain('"b": 99');
  });

  it('skips edits whose before equals after', () => {
    const input = '{\n  "a": 1\n}\n';
    const { newText, edits } = planJsoncEdits(input, [
      { jsonPath: ['a'], newValue: 1, description: 'no-op' },
    ]);
    expect(edits).toHaveLength(0);
    expect(newText).toBe(input);
  });

  it('creates missing keys', () => {
    const input = '{\n  "a": 1\n}\n';
    const { newText, edits } = planJsoncEdits(input, [
      { jsonPath: ['b'], newValue: 2, description: 'add b' },
    ]);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ before: undefined, after: 2 });
    expect(newText).toContain('"b": 2');
  });

  it('replaces arrays as a whole', () => {
    const input = '{\n  "allow": ["x", "y", "z"]\n}\n';
    const { newText, edits } = planJsoncEdits(input, [
      { jsonPath: ['allow'], newValue: ['y'], description: 'narrow' },
    ]);
    expect(edits).toHaveLength(1);
    expect(newText).toContain('"y"');
    expect(newText).not.toContain('"x"');
    expect(newText).not.toContain('"z"');
  });

  it('handles empty input by seeding {}', () => {
    const { newText } = planJsoncEdits('', [
      { jsonPath: ['k'], newValue: 1, description: 'init' },
    ]);
    expect(newText).toContain('"k": 1');
  });
});
