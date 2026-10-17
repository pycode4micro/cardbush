import { createHash } from "node:crypto";

import {
  BUSH_CACHE_CHAIN_STATE_PROTOCOL,
  cacheChainStateSchema,
  type CacheChainObservationPayload,
  type CacheChainState,
  type ModelRequest,
  type ProviderInputProjection,
  type ProviderInputObservation,
} from "@cardbush/bush-protocol";

export class CacheChainTracker {
  #state: CacheChainState;

  constructor(state?: CacheChainState) {
    this.#state = state
      ? cacheChainStateSchema.parse(state)
      : {
          protocol: BUSH_CACHE_CHAIN_STATE_PROTOCOL,
          requestOrdinal: 0,
          messageDigests: [],
        };
  }

  observe(request: ModelRequest): CacheChainObservationPayload {
    const parameters = {
      model: request.model,
      providerBinding: request.providerBinding ?? null,
      tools: request.tools,
      maxOutputTokens: request.maxOutputTokens ?? null,
      temperature: request.temperature ?? null,
      topP: request.topP ?? null,
      reasoningEffort: request.reasoningEffort ?? null,
    };
    // Keep the aggregate digest compatible with old checkpoints; new snapshots
    // also retain individual hashes so diagnostics can name changed fields.
    const stableInputDigest = digest(JSON.stringify(parameters));
    const parameterDigests = Object.fromEntries(Object.entries(parameters).map(([key, value]) =>
      [key, digest(JSON.stringify(value))]));
    const messageDigests = request.messages.map((message) =>
      digest(JSON.stringify(message)),
    );
    const previousStableInput = this.#state.stableInputDigest;
    const stableInputChanged =
      previousStableInput !== undefined &&
      previousStableInput !== stableInputDigest;
    const changedParameters = this.#state.parameterDigests
      ? changedParameterNames(this.#state.parameterDigests, parameterDigests)
      : stableInputChanged ? undefined : [];
    const prefixComparisonAvailable = this.#state.requestOrdinal > 0;
    let sharedPrefixMessages = 0;
    const limit = Math.min(this.#state.messageDigests.length, messageDigests.length);
    while (
      sharedPrefixMessages < limit &&
      this.#state.messageDigests[sharedPrefixMessages] === messageDigests[sharedPrefixMessages]
    ) {
      sharedPrefixMessages += 1;
    }
    const frozenPrefixBreak =
      prefixComparisonAvailable && sharedPrefixMessages < this.#state.messageDigests.length;
    const requestOrdinal = this.#state.requestOrdinal + 1;
    const observation: CacheChainObservationPayload = {
      requestOrdinal,
      messageCount: messageDigests.length,
      previousMessageCount: this.#state.messageDigests.length,
      sharedPrefixMessages,
      appendedMessages: messageDigests.length - sharedPrefixMessages,
      prefixComparisonAvailable,
      parametersChanged: stableInputChanged,
      ...(changedParameters ? { changedParameters } : {}),
      frozenPrefixBreak,
      ...(frozenPrefixBreak ? { breakIndex: sharedPrefixMessages, messageBreakIndex: sharedPrefixMessages } : {}),
      stableInputDigest,
      sharedPrefixDigest: digest(JSON.stringify(messageDigests.slice(0, sharedPrefixMessages))),
    };
    this.#state = {
      protocol: BUSH_CACHE_CHAIN_STATE_PROTOCOL,
      requestOrdinal,
      stableInputDigest,
      parameterDigests,
      messageDigests,
      ...(this.#state.providerInput ? { providerInput: this.#state.providerInput } : {}),
    };
    return observation;
  }

  observeProviderInput(projection: ProviderInputProjection): ProviderInputObservation {
    const previous = this.#state.providerInput;
    const changedParameters = previous ? changedParameterNames(previous.parameterDigests, projection.parameterDigests) : [];
    const projectionFormatChanged = Boolean(previous && previous.format !== projection.format);
    const prefixComparisonAvailable = Boolean(previous && !projectionFormatChanged);
    let shared = 0;
    if (previous && prefixComparisonAvailable) {
      while (shared < Math.min(previous.inputDigests.length, projection.inputDigests.length) &&
        previous.inputDigests[shared] === projection.inputDigests[shared]) shared++;
    }
    const frozenPrefixBreak = Boolean(previous && prefixComparisonAvailable && shared < previous.inputDigests.length);
    const stableInputDigest = digest(JSON.stringify({ format: projection.format, parameters: projection.parameterDigests }));
    this.#state.providerInput = structuredClone(projection);
    return {
      requestOrdinal: this.#state.requestOrdinal,
      format: projection.format, transport: projection.transport,
      previousProjectionAvailable: Boolean(previous), changedParameters,
      projectionFormatChanged, prefixComparisonAvailable,
      parametersChanged: changedParameters.length > 0,
      ...(projection.cacheRouting ? { cacheRouting: projection.cacheRouting } : {}),
      ...(projection.images ? { images: imageObservation(previous, projection) } : {}),
      messageCount: projection.inputDigests.length,
      previousMessageCount: previous?.inputDigests.length ?? 0,
      sharedPrefixMessages: shared, appendedMessages: projection.inputDigests.length - shared,
      frozenPrefixBreak, ...(frozenPrefixBreak ? { breakIndex: shared, messageBreakIndex: shared } : {}),
      stableInputDigest,
      sharedPrefixDigest: digest(JSON.stringify(projection.inputDigests.slice(0, shared))),
    };
  }

  snapshot(): CacheChainState {
    return structuredClone(this.#state);
  }
}

function changedParameterNames(previous: Record<string, string>, current: Record<string, string>): string[] {
  return [...new Set([...Object.keys(previous), ...Object.keys(current)])]
    .filter(key => previous[key] !== current[key]).sort();
}

function imageObservation(previous: ProviderInputProjection | undefined, current: ProviderInputProjection): ProviderInputObservation['images'] {
  const images = current.images!;
  // Older persisted projections have no image metadata. Do not report their
  // entire history as newly added images on the first request after an upgrade.
  const priorImages = previous?.format === current.format ? previous.images : undefined;
  const common = { count: images.digests.length, remoteCount: images.remoteCount, comparisonAvailable: Boolean(priorImages) };
  if (!priorImages) return common;
  const remaining = new Map<string, number>();
  for (const digest of priorImages.digests) remaining.set(digest, (remaining.get(digest) ?? 0) + 1);
  let addedCount = 0;
  for (const digest of images.digests) {
    const count = remaining.get(digest) ?? 0;
    if (count) remaining.set(digest, count - 1);
    else addedCount++;
  }
  return { ...common, previousCount: priorImages.digests.length, addedCount,
    removedCount: [...remaining.values()].reduce((sum, count) => sum + count, 0) };
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
