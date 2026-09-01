export const ABORT_SETTLEMENT_GRACE_MS = 250;

/**
 * Gives cooperative work one short, tool-agnostic interval to publish its own
 * native stop fact. After the bound, the caller regains control and the late
 * Promise settlement is consumed without becoming a second Runtime fact.
 */
export function settleAtAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
  message: string,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    // The operation may have synchronously triggered this abort before it was
    // handed to us. Consume its eventual settlement so cancellation cannot
    // escape later as an unhandled rejection.
    void operation.catch(() => undefined);
    return Promise.reject(abortError(message));
  }
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      if (abortTimer) clearTimeout(abortTimer);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => {
      abortTimer ??= setTimeout(
        () => finish(() => reject(abortError(message))),
        ABORT_SETTLEMENT_GRACE_MS,
      );
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

export function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}
