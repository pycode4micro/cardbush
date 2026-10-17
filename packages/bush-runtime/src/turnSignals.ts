/** Turn-scoped observation only. Executors and plugins retain their own work,
 * messages, permissions and persistence; this service owns no agent lifecycle. */
export type TurnWakeReason = 'task_completed' | 'user_message' | 'peer_message' | 'turn_ended' | 'yield_timeout';
type Notice = 'user_message' | 'peer_message' | 'turn_ended';

export class RuntimeTurnSignals {
  private readonly waiters = new Map<string, Set<(reason: Notice) => void>>();
  constructor(private readonly pending: (session: string, turn: string) => Exclude<Notice, 'turn_ended'> | undefined = () => undefined) {}
  private key(session: string, turn: string) { return JSON.stringify([session, turn]); }

  wake(session: string, turn: string, reason: Notice = 'user_message') {
    for (const wake of this.waiters.get(this.key(session, turn)) ?? []) wake(reason);
  }
  endTurn(session: string, turn: string) { this.wake(session, turn, 'turn_ended'); }

  /** Cancelling a wait never cancels its underlying work. */
  async wait(session: string, turn: string, promises: Promise<unknown>[], mode: 'any' | 'all', signal?: AbortSignal, yieldTimeMs?: number): Promise<TurnWakeReason> {
    // A pending notice or cancellation may win before observers subscribe.
    // Still observe later job failures; their owners retain the actual result.
    for (const promise of promises) void promise.catch(() => {});
    signal?.throwIfAborted();
    const pending = this.pending(session, turn);
    if (pending) return pending;
    const key = this.key(session, turn);
    return new Promise<TurnWakeReason>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiters = this.waiters.get(key) ?? new Set();
      const cleanup = () => {
        clearTimeout(timer); waiters.delete(wake);
        if (!waiters.size) this.waiters.delete(key);
        signal?.removeEventListener('abort', abort);
      };
      const finish = (reason: TurnWakeReason) => {
        if (settled) return;
        settled = true; cleanup(); resolve(reason);
      };
      const fail = (error: unknown) => { if (!settled) { settled = true; cleanup(); reject(error); } };
      const wake = (reason: Notice) => finish(reason);
      const abort = () => fail(signal?.reason ?? new DOMException('Wait cancelled', 'AbortError'));
      waiters.add(wake); this.waiters.set(key, waiters);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      if (yieldTimeMs !== undefined) timer = setTimeout(() => finish('yield_timeout'), yieldTimeMs);
      void (mode === 'all' ? Promise.all(promises) : Promise.race(promises)).then(() => finish('task_completed'), fail);
    });
  }
}
