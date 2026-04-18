import { describe, expect, it } from 'vitest';
import {
  getKnownService,
  getStoredKeyValidationMessage,
  isAllowedVerifyUrl,
  normalizeServiceName,
  validateKeyFormat,
} from '../dev-keys/src/validation.js';

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
});
