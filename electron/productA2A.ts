import { randomUUID } from 'node:crypto';

const A2A_PROTOCOL_VERSION = '1.0';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_CHARS = 256 * 1024;
const MAX_ID_CHARS = 256;

export interface ProductA2AClientOptions {
  fetchImpl?: typeof fetch;
  allowedOrigins?: string[];
}

export class ProductA2AClient {
  readonly #fetch: typeof fetch;
  readonly #allowedOrigins: Set<string>;

  constructor(options: ProductA2AClientOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#allowedOrigins = new Set(
      (options.allowedOrigins ?? []).map((value) => origin(value)),
    );
  }

  async inspect(agentUrl: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const base = this.#validateUrl(agentUrl);
    return this.#readObject(`${origin(base)}/.well-known/agent-card.json`, {
      method: 'GET',
      headers: { accept: 'application/a2a+json' },
      redirect: 'error',
      signal,
    });
  }

  async dispatch(input: {
    agentUrl: string;
    text: string;
    contextId?: string;
    taskId?: string;
  }, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const base = this.#validateUrl(input.agentUrl);
    const text = input.text.trim();
    if (!text) throw new Error('A2A task text is required.');
    if (text.length > MAX_TEXT_CHARS) {
      throw new Error(`A2A task text exceeds ${MAX_TEXT_CHARS} characters.`);
    }
    const message: Record<string, unknown> = {
      messageId: `msg_${randomUUID().replaceAll('-', '')}`,
      role: 'ROLE_USER',
      parts: [{ text }],
    };
    if (input.contextId?.trim()) {
      message.contextId = boundedId(input.contextId, 'contextId');
    }
    if (input.taskId?.trim()) {
      message.taskId = boundedId(input.taskId, 'taskId');
    }
    return this.#readObject(`${base}/message:send`, {
      method: 'POST',
      headers: {
        'A2A-Version': A2A_PROTOCOL_VERSION,
        accept: 'application/a2a+json',
        'content-type': 'application/a2a+json',
      },
      body: JSON.stringify({ message }),
      redirect: 'error',
      signal,
    });
  }

  #validateUrl(value: string): string {
    const normalized = value.trim().replace(/\/+$/, '');
    const parsed = new URL(normalized);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
      throw new Error('A2A agent URL must be an absolute HTTP(S) URL.');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error('A2A agent URL may not contain credentials, query, or fragment.');
    }
    if (!isLoopback(parsed.hostname) && !this.#allowedOrigins.has(origin(normalized))) {
      throw new Error('A2A origin is not in the product allowlist.');
    }
    return normalized;
  }

  async #readObject(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    const response = await this.#fetch(url, init);
    if (!response.ok) {
      const body = await readBoundedText(response, 4096);
      throw new Error(`A2A request failed (${response.status}): ${body}`);
    }
    const text = await readBoundedText(response, MAX_RESPONSE_BYTES);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error('A2A response is not valid JSON.');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('A2A response must be an object.');
    }
    return value as Record<string, unknown>;
  }
}

export function productA2AAllowedOrigins(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

function boundedId(value: string, name: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > MAX_ID_CHARS ||
    [...normalized].some((character) => character.codePointAt(0)! < 32)
  ) {
    throw new Error(`${name} must be at most ${MAX_ID_CHARS} printable characters.`);
  }
  return normalized;
}

function origin(value: string): string {
  const parsed = new URL(value.trim());
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('A2A origin must be absolute HTTP(S).');
  }
  return parsed.origin.toLowerCase();
}

function isLoopback(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (normalized === 'localhost' || normalized === '::1') return true;
  const parts = normalized.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every((part) =>
    /^\d{1,3}$/.test(part) && Number(part) <= 255,
  );
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let output = '';
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += chunk.value.byteLength;
    if (received > limit) {
      await reader.cancel();
      throw new Error(`A2A response exceeds the ${limit}-byte limit.`);
    }
    output += decoder.decode(chunk.value, { stream: true });
  }
  return output + decoder.decode();
}
