import { createHash } from 'node:crypto';
import type { ModelRequest, ProviderInputProjection } from '@cardbush/bush-protocol';

/** A routing hint, not explicit cache creation or a guarantee of a cache hit. */
export function sessionPromptCacheKey(request: Pick<ModelRequest, 'sessionId'>, baseURL = 'https://api.openai.com/v1'): string | undefined {
  let endpoint: URL;
  try { endpoint = new URL(baseURL); } catch { return undefined; }
  // OpenAI compatibility alone does not imply support for this optional field.
  // Keep unknown gateways unchanged, including OpenCode, OpenRouter and SIWC.
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
      !(endpoint.hostname === 'api.openai.com' || /^ark\.[a-z0-9-]+\.volces\.com$/.test(endpoint.hostname))) return undefined;
  if (!request.sessionId.trim()) return undefined;
  // Never include a turn/request id, time, credentials or mutable generation
  // settings. The same conversation keeps its routing hint after a restart.
  return `cb-${createHash('sha256').update('cardbush.prompt-cache.v1\0').update(request.sessionId).digest('hex').slice(0, 48)}`;
}

export function cacheRoutingFingerprint(key: unknown): NonNullable<ProviderInputProjection['cacheRouting']> {
  return typeof key === 'string' && key
    ? { mode: 'session', keyDigest: createHash('sha256').update(key).digest('hex') }
    : { mode: 'provider_default' };
}
