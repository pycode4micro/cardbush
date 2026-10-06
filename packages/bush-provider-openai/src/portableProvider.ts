import { createHash } from 'node:crypto';
import { BUSH_MODEL_EVENT_PROTOCOL, type ModelEvent, type ModelRequest } from '@cardbush/bush-protocol';
import type { ModelStreamOptions } from '@cardbush/bush-runtime';
import { assertRequestBodyBudget, requestBodyBudget } from './requestBodyBudget.js';
import { providerToolAliases } from './toolNames.js';
import { ProviderToolCallError } from './providerFailure.js';
import { cacheRoutingFingerprint } from './promptCache.js';
import { imageInputFingerprint } from './imageInputFingerprint.js';

type Payload = ModelEvent extends infer E ? E extends ModelEvent ? Omit<E, 'protocol' | 'requestId' | 'sequence' | 'createdAt'> : never : never;
export function eventWriter(requestId: string) {
  let sequence = 0;
  return (payload: Payload): ModelEvent => ({ protocol: BUSH_MODEL_EVENT_PROTOCOL, requestId,
    sequence: sequence++, createdAt: new Date().toISOString(), ...payload });
}

/** Fingerprint the wire projection once, excluding replay sidecars and image bytes. */
export function recordProjection(format: string, request: ModelRequest, params: Record<string, unknown>, options: ModelStreamOptions,
  maxBytes?: number, dispatch = false): number {
  let images = 0;
  const input = { system: params.system, messages: params.messages, tools: params.tools, thinking: params.thinking,
    output_config: params.output_config, reasoning_effort: params.reasoning_effort,
    ...(params.reasoning !== undefined ? { reasoning: params.reasoning } : {}) };
  const chars = JSON.stringify(input, (_key, value) => {
    if (value?.type === 'image' || value?.type === 'image_url') { images++; return { type: value.type }; }
    return value;
  }).length;
  const tokens = Math.ceil(chars / 4) + images * 1024;
  // Routing is not prompt content and must not invalidate token calibration.
  const { messages, prompt_cache_key, ...parameters } = params;
  // Messages combines adjacent user messages. Appending a runtime notice to
  // that content array preserves the cached block prefix, not the message hash.
  const items = (Array.isArray(messages) ? messages : []).flatMap(message =>
    format === 'anthropic.messages.v1' && Array.isArray(message.content)
      ? message.content.map((block: unknown) => ({ role: message.role, block })) : [message]);
  options.onInputProjection?.({ format, transport: 'full',
    images: imageInputFingerprint(messages), cacheRouting: cacheRoutingFingerprint(prompt_cache_key),
    parameterDigests: Object.fromEntries(Object.entries({ ...parameters, providerBinding: request.providerBinding }).map(([key, value]) => [key, hash(value)])),
    inputDigests: items.map(hash),
    tokenEstimate: { method: `${format}-chars-v1`, tokens, inputParametersDigest: hash({ ...input, messages: undefined, model: request.model, providerBinding: request.providerBinding }) } });
  const budget = requestBodyBudget(params, maxBytes);
  options.onRequestBodyBudget?.(budget);
  if (dispatch) assertRequestBodyBudget(budget);
  return tokens;
}
function hash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value) ?? 'null').digest('hex'); }

export interface PortableCall { id: string; name: string; arguments: string }
export function toolCallEvents(calls: Map<number, PortableCall>, request: ModelRequest): Payload[] {
  const aliases = providerToolAliases(request), ids = new Set<string>();
  return [...calls].sort(([a], [b]) => a - b).map(([index, call]) => {
    if (!Number.isSafeInteger(index) || index < 0 || !call.id || !call.name || ids.has(call.id)) {
      throw new ProviderToolCallError('provider_tool_call_incomplete', 'The provider returned incomplete or duplicate tool identities.');
    }
    ids.add(call.id);
    // Match Responses: transport completion is not argument/schema validation.
    // The shared Runtime tool coordinator records malformed JSON as a factual
    // tool failure and feeds that result into the next model round.
    return { kind: 'tool_call_delta', index, toolCallId: call.id, nameDelta: aliases.get(call.name) ?? call.name, argumentsDelta: call.arguments };
  });
}

export function incompleteStream(): Payload { return { kind: 'response_failed', code: 'provider_stream_incomplete',
  message: 'The model stream ended without a terminal event.', retryable: true }; }
