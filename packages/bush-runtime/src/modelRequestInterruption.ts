import { settleAtAbort } from './abortSettlement.js';

export class ModelRequestInterrupted extends Error {
  constructor() { super('Model request interrupted by user guidance.'); this.name = 'ModelRequestInterrupted'; }
}

/** Interrupt only model work/backoff. Tools and the owning Turn keep their own signal. */
export class ModelRequestInterruption {
  readonly #active = new Map<string, AbortController>();

  interrupt(turnKey: string): boolean {
    const controller = this.#active.get(turnKey);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async run<T>(turnKey: string, parent: AbortSignal | undefined,
    work: (signal: AbortSignal, current: () => boolean) => Promise<T>, interruptible = true): Promise<T> {
    const controller = new AbortController();
    const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal;
    let closed = false;
    if (interruptible) this.#active.set(turnKey, controller);
    try {
      signal.throwIfAborted();
      const result = await settleAtAbort(work(signal, () => !closed && !signal.aborted), signal, 'Model request cancelled.');
      signal.throwIfAborted();
      return result;
    } catch (error) {
      // Explicit task stop always wins, even if guidance arrived at the same time.
      if (controller.signal.aborted && !parent?.aborted) throw new ModelRequestInterrupted();
      throw error;
    } finally {
      closed = true;
      if (this.#active.get(turnKey) === controller) this.#active.delete(turnKey);
    }
  }
}
