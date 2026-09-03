import type { ModelEvent, ModelRequest } from "@cardbush/bush-protocol";

export interface ModelStreamOptions {
  signal?: AbortSignal;
}

export interface ModelInputTokenCount {
  inputTokens: number;
  source: "provider";
}

export interface ModelProvider {
  /**
   * Counts the exact input projection that this Provider would dispatch for
   * the supplied request. Implementations must use the same projection logic
   * as stream(), including Provider-side continuation state. Returns
   * undefined when the bound Provider does not expose an exact-count API;
   * transport, authentication and service failures must still be rejected.
   */
  countInputTokens?(
    request: ModelRequest,
    options?: ModelStreamOptions,
  ): Promise<ModelInputTokenCount | undefined>;
  stream(
    request: ModelRequest,
    options?: ModelStreamOptions,
  ): AsyncIterable<ModelEvent>;
}
