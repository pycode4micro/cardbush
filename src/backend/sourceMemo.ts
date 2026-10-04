import { RESOLVE_SOURCE_MEMO_COMMAND, RESOLVE_SOURCE_REFERENCES_COMMAND, sourceMemoResolutionSchema, sourceReferencesSchema,
  type SourceMemoResolution, type SourceReferencesRequest, type SourceReferences } from '@cardbush/bush-protocol';
import { conversationRuntime, type ConversationRuntime } from './conversationRuntime';

const local = new Map<string, { expires: number; value: Promise<SourceMemoResolution> }>();
const remote = new WeakMap<ConversationRuntime, typeof local>();
const localReferences = new Map<string, { expires: number; value: Promise<SourceReferences> }>();
const remoteReferences = new WeakMap<ConversationRuntime, typeof localReferences>();

export function fetchSourceReferences(input: SourceReferencesRequest, runtimeOverride?: ConversationRuntime): Promise<SourceReferences> {
  let cache = localReferences;
  if (runtimeOverride) {
    cache = remoteReferences.get(runtimeOverride) ?? new Map();
    remoteReferences.set(runtimeOverride, cache);
  }
  const key = JSON.stringify(input), found = cache.get(key);
  if (found && found.expires > Date.now()) return found.value;
  const runtime = conversationRuntime(runtimeOverride);
  const value = runtime.client.command({ kind: RESOLVE_SOURCE_REFERENCES_COMMAND, payload: input },
    result => sourceReferencesSchema.parse(result), AbortSignal.timeout(10_000)).finally(() => runtime.dispose());
  cache.set(key, { value, expires: Date.now() + 15_000 });
  if (cache.size > 256) cache.delete(cache.keys().next().value!);
  void value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
  return value;
}
/** Preload on render/focus. Hover only reveals already loaded facts, never a model request. */
export function fetchSourceMemo(reference: string, runtimeOverride?: ConversationRuntime): Promise<SourceMemoResolution> {
  let cache = local;
  if (runtimeOverride) {
    cache = remote.get(runtimeOverride) ?? new Map();
    remote.set(runtimeOverride, cache);
  }
  const found = cache.get(reference);
  if (found && found.expires > Date.now()) return found.value;
  const runtime = conversationRuntime(runtimeOverride);
  const value = runtime.client.command({ kind: RESOLVE_SOURCE_MEMO_COMMAND, payload: { reference } },
    result => sourceMemoResolutionSchema.parse(result), AbortSignal.timeout(10_000)).finally(() => runtime.dispose());
  cache.set(reference, { value, expires: Date.now() + 15_000 });
  if (cache.size > 256) cache.delete(cache.keys().next().value!);
  void value.catch(() => { if (cache.get(reference)?.value === value) cache.delete(reference); });
  return value;
}
