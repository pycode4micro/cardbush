import type { ModelEvent, ModelRequest } from "@cardbush/bush-protocol";

export interface ModelStreamOptions {
  signal?: AbortSignal;
}

export interface ModelProvider {
  stream(
    request: ModelRequest,
    options?: ModelStreamOptions,
  ): AsyncIterable<ModelEvent>;
}
