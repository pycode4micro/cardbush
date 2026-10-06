import type { ModelApiProtocol } from '@cardbush/bush-protocol';
import type { ProviderCapabilityStore } from './providerCapabilities.js';

/** Connection and transport settings, never Agent loop policy. */
export interface ModelProviderConfig {
  chatGpt?: { accountId: string; access: import('./siwc.js').ChatGptAccess; signal?: AbortSignal };
  adapter?: ModelApiProtocol;
  apiKey: string;
  fetch?: typeof fetch;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
  capabilityStore?: ProviderCapabilityStore;
  capabilityScope?: string;
  anthropicThinkingMode?: 'adaptive' | 'budget';
  /** Local JSON-body budget, default 40,000,000 bytes. Can override for a known
   * transport limit; independent of the model's context window. */
  maxRequestBodyBytes?: number;
}
