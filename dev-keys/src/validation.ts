import type { KeyStore } from './keystore.js';
import {
  getCustomService,
  isAllowedVerifyUrl,
  normalizeServiceName,
  type AuthScheme,
  type ServiceDefinition,
} from './service-metadata.js';

export { isAllowedVerifyUrl, normalizeServiceName } from './service-metadata.js';

export type KnownService = ServiceDefinition & {
  url: string;
  prefix: string;
  icon: string;
  verifyUrl: string;
  authScheme: AuthScheme;
  headers?: Record<string, string>;
};

export type ValidationResult = {
  ok: boolean;
  kind: 'format' | 'network';
  service: string;
  message: string;
  status?: number;
};

export const KNOWN_SERVICES: KnownService[] = [
  { name: 'openrouter', label: 'OpenRouter', url: 'https://openrouter.ai/settings/keys', prefix: 'sk-or-', icon: '🌐', verifyUrl: 'https://openrouter.ai/api/v1/key', authScheme: 'bearer' },
  { name: 'openai', label: 'OpenAI', url: 'https://platform.openai.com/api-keys', prefix: 'sk-', icon: '🤖', verifyUrl: 'https://api.openai.com/v1/models', authScheme: 'bearer' },
  { name: 'anthropic', label: 'Anthropic', url: 'https://console.anthropic.com/settings/keys', prefix: 'sk-ant-', icon: '🧠', verifyUrl: 'https://api.anthropic.com/v1/models', authScheme: 'x-api-key', headers: { 'anthropic-version': '2023-06-01' } },
  { name: 'google', label: 'Google AI', url: 'https://aistudio.google.com/apikey', prefix: 'AIza', icon: '🔍', verifyUrl: 'https://generativelanguage.googleapis.com/v1beta/models', authScheme: 'x-goog-api-key' },
  { name: 'github', label: 'GitHub', url: 'https://github.com/settings/tokens', prefix: 'ghp_', icon: '🐙', verifyUrl: 'https://api.github.com/user', authScheme: 'bearer', headers: { 'User-Agent': 'dev-keys' } },
  { name: 'huggingface', label: 'Hugging Face', url: 'https://huggingface.co/settings/tokens', prefix: 'hf_', icon: '🤗', verifyUrl: 'https://huggingface.co/api/whoami-v2', authScheme: 'bearer' },
];

export function getKnownService(name: string): KnownService | undefined {
  return KNOWN_SERVICES.find((service) => service.name === name.toLowerCase());
}

function getServiceDefinition(name: string): ServiceDefinition | undefined {
  return getKnownService(name) ?? getCustomService(name);
}

export function getStoredKeyValidationMessage(name: string): string {
  const service = getServiceDefinition(name);
  if (service?.verifyUrl) {
    return `${service.label} key is stored and ready for validation.`;
  }
  return 'Stored successfully. No verify endpoint is configured for this custom service, so manual validation may be required.';
}

export function validateKeyFormat(name: string, value: string): ValidationResult {
  const service = getServiceDefinition(name);
  const normalized = value.trim();

  if (!normalized) {
    return { ok: false, kind: 'format', service: service?.label ?? name, message: 'Key value is empty.' };
  }

  if (!service) {
    return {
      ok: true,
      kind: 'format',
      service: name,
      message: 'Stored successfully. Manual validation may be required for custom services.',
    };
  }

  if (normalized.length < 8) {
    return {
      ok: false,
      kind: 'format',
      service: service.label,
      message: `${service.label} key looks too short to be valid.`,
    };
  }

  const expectedPatterns: Partial<Record<string, RegExp>> = {
    github: /^(ghp_|github_pat_|gho_|ghu_|ghs_|ghr_)/i,
    google: /^(AIza|AI)/i,
  };

  const pattern = expectedPatterns[service.name];
  if (pattern ? !pattern.test(normalized) : (service.prefix && !normalized.startsWith(service.prefix))) {
    return {
      ok: false,
      kind: 'format',
      service: service.label,
      message: `${service.label} key format does not match the expected pattern.`,
    };
  }

  return {
    ok: true,
    kind: 'format',
    service: service.label,
    message: `${service.label} key format looks correct.`,
  };
}

async function checkResponse(service: ServiceDefinition, response: Response): Promise<ValidationResult> {
  if (response.ok) {
    return {
      ok: true,
      kind: 'network',
      service: service.label,
      status: response.status,
      message: `${service.label} accepted the key.`,
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      kind: 'network',
      service: service.label,
      status: response.status,
      message: `${service.label} rejected the key (${response.status}).`,
    };
  }

  return {
    ok: false,
    kind: 'network',
    service: service.label,
    status: response.status,
    message: `${service.label} validation returned HTTP ${response.status}.`,
  };
}

function buildAuthHeaders(service: ServiceDefinition, value: string): Record<string, string> {
  const headers: Record<string, string> = {};
  switch (service.authScheme ?? 'bearer') {
    case 'x-api-key':
      headers['x-api-key'] = value;
      break;
    case 'x-goog-api-key':
      headers['x-goog-api-key'] = value;
      break;
    case 'bearer':
    default:
      headers.Authorization = `Bearer ${value}`;
      break;
  }
  if ('headers' in service && service.headers) {
    Object.assign(headers, service.headers);
  }
  return headers;
}

async function validateService(service: ServiceDefinition, value: string): Promise<ValidationResult> {
  if (!service.verifyUrl) {
    return {
      ok: true,
      kind: 'format',
      service: service.label,
      message: `No verify endpoint is configured for ${service.label}.`,
    };
  }

  if (!isAllowedVerifyUrl(service.verifyUrl)) {
    return {
      ok: false,
      kind: 'network',
      service: service.label,
      message: `Verify endpoint for ${service.label} is not allowed by the security policy.`,
    };
  }

  const signal = AbortSignal.timeout(8000);
  const response = await fetch(service.verifyUrl, {
    method: 'GET',
    headers: buildAuthHeaders(service, value),
    signal,
  });
  return checkResponse(service, response);
}

export async function validateKey(name: string, value: string): Promise<ValidationResult> {
  const formatResult = validateKeyFormat(name, value);
  if (!formatResult.ok) {
    return formatResult;
  }

  const service = getServiceDefinition(name);
  if (!service) {
    return formatResult;
  }

  try {
    return await validateService(service, value.trim());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      kind: 'network',
      service: service.label,
      message: `${service.label} validation could not complete: ${message}`,
    };
  }
}

export async function validateStoredKey(
  name: string,
  store: Pick<KeyStore, 'get'>,
): Promise<ValidationResult> {
  const value = await store.get(name);
  if (!value) {
    return {
      ok: false,
      kind: 'format',
      service: name,
      message: `Key '${name}' not found.`,
    };
  }
  return validateKey(name, value);
}
