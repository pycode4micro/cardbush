import { modelFailureAction, type ModelFailureFacts } from './modelFailurePolicy.js';

export type ModelTransportRecovery = 'restart_continuation' | 'negotiate_capability';

/** One unchanged model round owns transport retries and at most one wire recovery.
 * A recovery stays applied across outer retries; tools never run in this boundary. */
export class ModelRequestAttempts {
  #providerAttempts = 0;
  #recovery?: ModelTransportRecovery;

  constructor(readonly maxAttempts: number | null = 1) {
    if (maxAttempts !== null && (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1)) {
      throw new Error('maxAttempts must be a positive integer or null.');
    }
  }

  dispatch(): void { this.#providerAttempts++; }

  canRetry(error: ModelFailureFacts, attempt: number): boolean {
    return modelFailureAction(error) === 'retry' && (this.maxAttempts === null || attempt < this.maxAttempts);
  }

  recover(action: ModelTransportRecovery, state: { outputExposed?: boolean; signal?: AbortSignal } = {}): boolean {
    if (this.#recovery || state.outputExposed || state.signal?.aborted) return false;
    this.#recovery = action;
    return true;
  }

  hasRecovery(action: ModelTransportRecovery): boolean { return this.#recovery === action; }

  snapshot() {
    return { providerAttempts: this.#providerAttempts, recoveryAttempts: this.#recovery ? 1 : 0 };
  }
}
