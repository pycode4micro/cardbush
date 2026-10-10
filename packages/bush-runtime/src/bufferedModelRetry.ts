import { setTimeout } from 'node:timers/promises';
import type { ModelRequest } from '@cardbush/bush-protocol';
import type { ModelProvider } from './modelProvider.js';
import { executeModelRound } from './modelRound.js';
import { ModelRequestAttempts } from './modelRequestAttempts.js';
import { defaultRuntimeRetryDelayMs } from './runtimeRetry.js';

export interface BufferedModelRetryStatus {
  attempt: number;
  maxAttempts: number;
  nextRetryMs: number;
  code: string;
  createdAt: string;
  providerAttempts: number;
  recoveryAttempts: number;
}

/** Retry only the current unpublished model round. Tool execution stays outside
 * this boundary, so earlier successful dispatches and page writes are not replayed. */
export async function executeBufferedModelRound(provider: ModelProvider, request: ModelRequest, options: {
  signal: AbortSignal;
  onRetry?: (status: BufferedModelRetryStatus) => void;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}) {
  const maxAttempts = 3;
  const attempts = new ModelRequestAttempts(maxAttempts);
  const wait = options.wait ?? ((ms, signal) => setTimeout(ms, undefined, { signal }));
  for (let attempt = 1; ; attempt++) {
    options.signal.throwIfAborted();
    const result = await executeModelRound(provider, request, { signal: options.signal, attempts });
    options.signal.throwIfAborted();
    if (result.status === 'completed' || !attempts.canRetry(result.error, attempt)) return result;
    const nextRetryMs = defaultRuntimeRetryDelayMs({ nextAttempt: attempt + 1, maxAttempts,
      code: result.error.code, retryAfterMs: result.error.retryAfterMs });
    options.onRetry?.({ attempt: attempt + 1, maxAttempts, nextRetryMs, code: result.error.code, createdAt: new Date().toISOString(), ...attempts.snapshot() });
    await wait(nextRetryMs, options.signal);
  }
}
