export interface RuntimeRetryContext {
  nextAttempt: number;
  maxAttempts: number | null;
  code: string;
  retryAfterMs?: number;
}

export function defaultRuntimeRetryDelayMs(context: RuntimeRetryContext): number {
  // 1, 2, 4, 8, 16, then 30 seconds. Retry the same request; never replay tools.
  const backoff = Math.min(30_000, 1000 * 2 ** Math.min(5, Math.max(0, context.nextAttempt - 2)));
  const retryAfter = Number.isFinite(context.retryAfterMs) ? Math.max(0, context.retryAfterMs!) : 0;
  return Math.round(Math.max(backoff, Math.min(retryAfter, 300_000)));
}
