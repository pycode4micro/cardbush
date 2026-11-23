/** Owns the cache maintenance lease and deferred collection lifetime. */
export class RuntimeCacheMaintenance {
  #active?: Promise<void>;
  #pending = false;
  #timer?: ReturnType<typeof setTimeout>;
  #retention?: ReturnType<typeof setInterval>;
  #background?: AbortController;
  #stopped = false;

  constructor(private readonly hooks: {
    idle(): boolean;
    collect(signal: AbortSignal): Promise<{ errors: string[] }>;
    settled(): void;
  }) {}

  get active() { return this.#active; }
  get background() { return Boolean(this.#background); }

  run<T>(operation: () => Promise<T>): Promise<T> {
    return this.#run(operation);
  }

  async #run<T>(operation: () => Promise<T>, background?: AbortController): Promise<T> {
    while (this.#active) await this.#active;
    let release!: () => void;
    this.#active = new Promise<void>(resolve => { release = resolve; });
    this.#background = background;
    try { return await operation(); }
    finally {
      this.#background = undefined;
      this.#active = undefined;
      release();
      this.hooks.settled();
    }
  }

  start() {
    this.schedule(60_000);
    this.#retention = setInterval(() => {
      if (!this.#pending) this.schedule();
    }, 60 * 60_000);
    this.#retention.unref();
  }

  schedule(delay = 1_000) {
    if (this.#stopped) return;
    this.#pending = true;
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#collectWhenIdle();
    }, delay);
    this.#timer.unref();
  }

  collected() {
    this.#pending = false;
    clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  interruptBackground() { this.#background?.abort(); }

  stop() {
    this.#stopped = true;
    this.collected();
    clearInterval(this.#retention);
    this.#retention = undefined;
    this.interruptBackground();
  }

  async #collectWhenIdle() {
    if (!this.#pending) return;
    if (this.#active || !this.hooks.idle()) {
      this.schedule();
      return;
    }
    const controller = new AbortController();
    try {
      const result = await this.#run(() => this.hooks.collect(controller.signal), controller);
      if (result.errors.length) console.warn('Deferred session cache cleanup needs a retry:', result.errors);
    } catch (error) {
      if (!controller.signal.aborted) {
        // Leave an unreadable store for the next deletion or explicit maintenance.
        this.collected();
        console.warn('Deferred session cache cleanup needs a retry:', error);
      }
    } finally {
      if (this.#pending) this.schedule();
    }
  }
}
