import type { ModelEvent, ModelRequest, ProviderInputProjection } from "@cardbush/bush-protocol";

export interface ModelStreamOptions {
  signal?: AbortSignal;
  /** Full input fingerprints at each dispatch attempt, or of the local
   * projection during estimateInputTokens(). No API request is made by estimation.
   */
  onInputProjection?: (projection: ProviderInputProjection) => void;
}

export interface ModelInputTokenCount {
  inputTokens: number;
  source: "provider";
}

export interface ModelProvider {
  /** Local estimate of the full wire context (including any chained history).
   * Counts the Provider projection once, without Runtime replay sidecars.
   * This is not a tokenizer measurement and remains subject to calibration.
   */
  estimateInputTokens?(request: ModelRequest, options?: ModelStreamOptions): Promise<number | undefined>;
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
