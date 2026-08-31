import { createHash } from "node:crypto";

import {
  BUSH_CACHE_CHAIN_STATE_PROTOCOL,
  cacheChainStateSchema,
  type CacheChainObservationPayload,
  type CacheChainState,
  type ModelRequest,
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
    };
    return observation;
  }

  snapshot(): CacheChainState {
    return structuredClone(this.#state);
  }
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
