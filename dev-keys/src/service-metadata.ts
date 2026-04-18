import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';

export type AuthScheme = 'bearer' | 'x-api-key' | 'x-goog-api-key';

export type ServiceDefinition = {
  name: string;
  label: string;
  url?: string;
  prefix?: string;
  icon?: string;
  verifyUrl?: string;
  authScheme?: AuthScheme;
  custom?: boolean;
};

type ServiceIndex = {
  services: ServiceDefinition[];
};

const RESERVED_SERVICE_NAMES = new Set([
  'openrouter',
  'openai',
  'anthropic',
  'google',
  'github',
  'huggingface',
]);

function configDir(): string {
  if (platform() === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) return join(appData, 'dev-keys');
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, 'dev-keys');
  return join(homedir(), '.config', 'dev-keys');
}

function metadataPath(): string {
  return join(configDir(), 'services.json');
}

export function normalizeServiceName(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 64);
}

export function isAllowedVerifyUrl(value: string | undefined): boolean {
  if (!value) { return true; }
  try {
    const url = new URL(value);
    const isLoopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
    const protocolOk = url.protocol === 'https:' || (isLoopback && url.protocol === 'http:');
    if (!protocolOk) { return false; }
    if (url.username || url.password) { return false; }
    if (url.search || url.hash) { return false; }
    return true;
  } catch {
    return false;
  }
}

function readIndex(): ServiceIndex {
  const path = metadataPath();
  if (!existsSync(path)) return { services: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Partial<ServiceIndex>;
    const services = Array.isArray(parsed.services) ? parsed.services.filter((s): s is ServiceDefinition => {
      return !!s && typeof s === 'object' && typeof s.name === 'string' && typeof s.label === 'string';
    }) : [];
    return { services };
  } catch {
    return { services: [] };
  }
}

function writeIndex(index: ServiceIndex): void {
  const path = metadataPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(index, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
}

function sanitizeService(input: Partial<ServiceDefinition>): ServiceDefinition {
  const label = (input.label ?? input.name ?? '').trim();
  const rawName = (input.name ?? '').trim().toLowerCase();
  const name = /^[a-z0-9_-]{1,64}$/i.test(rawName) ? rawName : normalizeServiceName(label);

  if (!name) {
    throw new Error('A custom key name is required.');
  }

  if (RESERVED_SERVICE_NAMES.has(name)) {
    throw new Error(`'${name}' is reserved for a built-in service.`);
  }

  const verifyUrl = (input.verifyUrl ?? '').trim();
  if (verifyUrl && !isAllowedVerifyUrl(verifyUrl)) {
    throw new Error('Verify URL must use HTTPS (or localhost HTTP), with no embedded credentials, query, or fragment.');
  }

  const authScheme: AuthScheme = input.authScheme === 'x-api-key' || input.authScheme === 'x-goog-api-key'
    ? input.authScheme
    : 'bearer';

  return {
    name,
    label: label || name,
    prefix: (input.prefix ?? '').trim(),
    verifyUrl: verifyUrl || undefined,
    authScheme,
    icon: input.icon ?? '🔑',
    custom: true,
  };
}

export function listCustomServices(): ServiceDefinition[] {
  return readIndex().services.sort((a, b) => a.label.localeCompare(b.label));
}

export function getCustomService(name: string): ServiceDefinition | undefined {
  const normalized = name.trim().toLowerCase();
  return readIndex().services.find((service) => service.name === normalized);
}

export function saveCustomService(input: Partial<ServiceDefinition>): ServiceDefinition {
  const service = sanitizeService(input);
  const index = readIndex();
  const others = index.services.filter((entry) => entry.name !== service.name);
  others.push(service);
  writeIndex({ services: others.sort((a, b) => a.label.localeCompare(b.label)) });
  return service;
}

export function removeCustomService(name: string): void {
  const normalized = name.trim().toLowerCase();
  const index = readIndex();
  const next = index.services.filter((entry) => entry.name !== normalized);
  if (next.length !== index.services.length) {
    writeIndex({ services: next });
  }
}
