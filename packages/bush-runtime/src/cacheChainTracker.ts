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
    const stableInputDigest = digest(
      JSON.stringify({
        model: request.model,
        providerBinding: request.providerBinding ?? null,
        tools: request.tools,
        maxOutputTokens: request.maxOutputTokens ?? null,
        temperature: request.temperature ?? null,
        topP: request.topP ?? null,
        reasoningEffort: request.reasoningEffort ?? null,
      }),
    );
    const messageDigests = request.messages.map((message) =>
      digest(JSON.stringify(message)),
    );
    const previousStableInput = this.#state.stableInputDigest;
    const stableInputChanged =
      previousStableInput !== undefined &&
      previousStableInput !== stableInputDigest;
    let sharedPrefixMessages = 0;
    if (!stableInputChanged) {
      const limit = Math.min(
        this.#state.messageDigests.length,
        messageDigests.length,
      );
      while (
        sharedPrefixMessages < limit &&
        this.#state.messageDigests[sharedPrefixMessages] ===
          messageDigests[sharedPrefixMessages]
      ) {
        sharedPrefixMessages += 1;
      }
    }
    const frozenPrefixBreak =
      previousStableInput !== undefined &&
      (stableInputChanged ||
        sharedPrefixMessages < this.#state.messageDigests.length);
    const requestOrdinal = this.#state.requestOrdinal + 1;
    const observation: CacheChainObservationPayload = {
      requestOrdinal,
      messageCount: messageDigests.length,
      previousMessageCount: this.#state.messageDigests.length,
      sharedPrefixMessages,
      appendedMessages: messageDigests.length - sharedPrefixMessages,
      frozenPrefixBreak,
      breakIndex: frozenPrefixBreak
        ? stableInputChanged
          ? 0
          : sharedPrefixMessages
        : undefined,
      stableInputDigest,
      sharedPrefixDigest: digest(
        JSON.stringify({
          stableInputDigest,
          messages: messageDigests.slice(0, sharedPrefixMessages),
        }),
      ),
    };
    this.#state = {
      protocol: BUSH_CACHE_CHAIN_STATE_PROTOCOL,
      requestOrdinal,
      stableInputDigest,
      messageDigests,
      ...(this.#state.providerInput ? { providerInput: this.#state.providerInput } : {}),
    };
    return observation;
  }

  observeProviderInput(projection: ProviderInputProjection): ProviderInputObservation {
    const previous = this.#state.providerInput;
    const changedParameters = previous ? [...new Set([
      ...Object.keys(previous.parameterDigests), ...Object.keys(projection.parameterDigests),
    ])].filter(key => previous.parameterDigests[key] !== projection.parameterDigests[key]).sort() : [];
    if (previous && previous.format !== projection.format) changedParameters.unshift("projection_format");
    let shared = 0;
    if (previous && !changedParameters.length) {
      while (shared < Math.min(previous.inputDigests.length, projection.inputDigests.length) &&
        previous.inputDigests[shared] === projection.inputDigests[shared]) shared++;
    }
    const frozenPrefixBreak = Boolean(previous &&
      (changedParameters.length || shared < previous.inputDigests.length));
    const stableInputDigest = digest(JSON.stringify({ format: projection.format, parameters: projection.parameterDigests }));
    this.#state.providerInput = structuredClone(projection);
    return {
      requestOrdinal: this.#state.requestOrdinal,
      format: projection.format, transport: projection.transport,
      previousProjectionAvailable: Boolean(previous), changedParameters,
      messageCount: projection.inputDigests.length,
      previousMessageCount: previous?.inputDigests.length ?? 0,
      sharedPrefixMessages: shared, appendedMessages: projection.inputDigests.length - shared,
      frozenPrefixBreak, ...(frozenPrefixBreak ? { breakIndex: shared } : {}),
      stableInputDigest,
      sharedPrefixDigest: digest(JSON.stringify(projection.inputDigests.slice(0, shared))),
    };
  }

  snapshot(): CacheChainState {
    return structuredClone(this.#state);
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
