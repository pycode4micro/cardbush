import { setTimeout as delay } from 'node:timers/promises';
import { BUSH_MODEL_EVENT_PROTOCOL, type ModelRequest } from '@cardbush/bush-protocol';
import type { ModelProvider } from './modelProvider.js';
import { executeModelRound, type ModelRoundResult } from './modelRound.js';
import { ModelRequestAttempts } from './modelRequestAttempts.js';
import { defaultRuntimeRetryDelayMs } from './runtimeRetry.js';
import { settleAtAbort } from './abortSettlement.js';

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
  idleTimeoutMs?: number;
}) {
  const maxAttempts = 3;
  const attempts = new ModelRequestAttempts(maxAttempts);
  const wait = options.wait ?? ((ms, signal) => delay(ms, undefined, { signal }));
  for (let attempt = 1; ; attempt++) {
    options.signal.throwIfAborted();
    // Active reasoning/output refreshes the deadline; a stalled transport cannot
    // leave the UI busy forever, even when its SDK ignores cancellation.
    const idle = new AbortController();
    const signal = AbortSignal.any([options.signal, idle.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const progress = () => {
      clearTimeout(timer);
      if (!signal.aborted) {
        timer = setTimeout(() => idle.abort(), options.idleTimeoutMs ?? 120_000);
        timer.unref?.();
      }
    };
    let result: ModelRoundResult;
    progress();
    try {
      result = await settleAtAbort(executeModelRound(provider, request, { signal, attempts, onEvent: progress }), signal, 'Model request stopped.');
      signal.throwIfAborted();
    } catch (error) {
      options.signal.throwIfAborted();
      if (!idle.signal.aborted) throw error;
      result = { status: 'failed', text: '', reasoning: '', toolCalls: [], usage: {}, error: {
        protocol: BUSH_MODEL_EVENT_PROTOCOL, requestId: request.requestId, sequence: 0, createdAt: new Date().toISOString(),
        kind: 'response_failed', code: 'provider_timeout', message: 'The model stopped responding.', retryable: true,
      } };
    } finally { clearTimeout(timer); }
    options.signal.throwIfAborted();
    if (result.status === 'completed' || !attempts.canRetry(result.error, attempt)) return result;
    const nextRetryMs = defaultRuntimeRetryDelayMs({ nextAttempt: attempt + 1, maxAttempts,
      code: result.error.code, retryAfterMs: result.error.retryAfterMs });
    options.onRetry?.({ attempt: attempt + 1, maxAttempts, nextRetryMs, code: result.error.code, createdAt: new Date().toISOString(), ...attempts.snapshot() });
    await wait(nextRetryMs, options.signal);
  }
}
