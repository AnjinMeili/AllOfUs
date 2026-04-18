import { describe, expect, it } from 'vitest';
import { getBrowserOpenCommand, getSecureStoreLabel } from '../dev-keys/src/platform.js';

describe('platform helpers', () => {
  it('returns human-friendly secure store labels', () => {
    expect(getSecureStoreLabel('darwin')).toBe('macOS Keychain');
    expect(getSecureStoreLabel('linux')).toBe('Linux Secret Service');
    expect(getSecureStoreLabel('win32')).toBe('Windows Credential Manager');
    expect(getSecureStoreLabel('freebsd')).toBe('secure OS credential store');
  });

  it('uses a platform-appropriate browser open command', () => {
    expect(getBrowserOpenCommand('https://example.com', 'darwin')).toEqual({
      command: 'open',
      args: ['https://example.com'],
    });

    expect(getBrowserOpenCommand('https://example.com', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['https://example.com'],
    });

    expect(getBrowserOpenCommand('https://example.com', 'win32')).toEqual({
      command: 'cmd',
      args: ['/c', 'start', '', 'https://example.com'],
    });
  });
});
