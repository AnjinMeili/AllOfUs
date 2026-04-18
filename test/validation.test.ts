import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getCustomService,
  removeCustomService,
  saveCustomService,
} from '../dev-keys/src/service-metadata.js';
import {
  getKnownService,
  getStoredKeyValidationMessage,
  isAllowedVerifyUrl,
  normalizeServiceName,
  validateKeyFormat,
} from '../dev-keys/src/validation.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.XDG_CONFIG_HOME;
});

function useTempConfigHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'allofus-validation-'));
  tempDirs.push(dir);
  process.env.XDG_CONFIG_HOME = dir;
  return dir;
}

describe('key validation helpers', () => {
  it('recognizes well-known services', () => {
    expect(getKnownService('openrouter')?.label).toBe('OpenRouter');
    expect(getKnownService('HUGGINGFACE')?.label).toBe('Hugging Face');
    expect(getKnownService('unknown')).toBeUndefined();
  });

  it('performs local format sanity checks', () => {
    expect(validateKeyFormat('openrouter', 'sk-or-123456789')).toMatchObject({ ok: true, kind: 'format' });
    expect(validateKeyFormat('huggingface', 'hf_abcdef')).toMatchObject({ ok: true, kind: 'format' });
    expect(validateKeyFormat('github', 'github_pat_abcdef123456')).toMatchObject({ ok: true, kind: 'format' });
    expect(validateKeyFormat('openai', 'bad-key')).toMatchObject({ ok: false, kind: 'format' });
  });

  it('returns a helpful message for stored custom keys', () => {
    useTempConfigHome();
    saveCustomService({ name: 'custom-service', label: 'Custom Service' });
    expect(getStoredKeyValidationMessage('custom-service')).toMatch(/manual validation/i);
  });

  it('normalizes custom labels into stable key names', () => {
    expect(normalizeServiceName('Hugging Face')).toBe('huggingface');
    expect(normalizeServiceName('My Custom Key')).toBe('mycustomkey');
  });

  it('allows only safe verify endpoints', () => {
    expect(isAllowedVerifyUrl('https://api.example.com/verify')).toBe(true);
    expect(isAllowedVerifyUrl('http://api.example.com/verify')).toBe(false);
    expect(isAllowedVerifyUrl('https://user:pass@example.com/verify')).toBe(false);
  });

  it('rejects custom services that reuse built-in names', () => {
    useTempConfigHome();
    expect(() => saveCustomService({ name: 'openai', label: 'My OpenAI Clone' }))
      .toThrow(/reserved for a built-in service/i);
  });

  it('stores and removes custom service metadata independently', () => {
    useTempConfigHome();
    saveCustomService({ name: 'custom-service', label: 'Custom Service' });
    expect(getCustomService('custom-service')?.label).toBe('Custom Service');
    removeCustomService('custom-service');
    expect(getCustomService('custom-service')).toBeUndefined();
  });
});
