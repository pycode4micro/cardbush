import type { ModelEvent, ModelRequest, ProviderInputProjection, ProviderCompatibilityDiagnostic, ProviderStreamDiagnostic } from "@cardbush/bush-protocol";
import type { ModelRequestAttempts } from './modelRequestAttempts.js';

export interface ModelRequestBodyBudget {
  /** UTF-8 bytes of the complete serialized HTTP body, including base64. */
  bytes: number;
  maxBytes: number;
}

export interface ModelStreamOptions {
  signal?: AbortSignal;
  /** Shared by every dispatch/recovery of one frozen model round, not token counting. */
  attempts?: ModelRequestAttempts;
  /** Full input fingerprints at each dispatch attempt, or of the local
   * projection during estimateInputTokens(). No API request is made by estimation.
   */
  onInputProjection?: (projection: ProviderInputProjection) => void;
  /** Separate transport budget; never turn bytes into reported token usage. */
  onRequestBodyBudget?: (budget: ModelRequestBodyBudget) => void;
  /** Original provider failures and compatibility recovery, independent of UI output. */
  onCompatibilityDiagnostic?: (diagnostic: ProviderCompatibilityDiagnostic) => void;
  /** Content-free stream lifecycle observations; never changes request or retry policy. */
  onStreamDiagnostic?: (diagnostic: ProviderStreamDiagnostic) => void;
}

export interface ModelInputTokenCount {
  inputTokens: number;
  source: "provider";
}

/**
 * One model exchange at the protocol boundary: canonical ModelRequest in,
 * normalized ModelEvent out. Adapters own wire roles, tool/image encoding,
 * streaming and opaque replay only. They never execute tools, append canonical
 * conversation messages, or decide Agent continuation/permissions/recovery.
 * Wire-only negotiation before output uses the Runtime-owned attempts budget.
 * InMemoryRuntimeHost + executeModelRound own that loop for every adapter.
 */
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
   * undefined when exact counting is unavailable or a provider failure selects
   * local estimation. Such failures must be recorded through diagnostics;
   * cancellation must still be rejected.
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
