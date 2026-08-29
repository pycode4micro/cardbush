import type {
  RuntimeCommand,
  RuntimeStreamRequest,
  RuntimeTransport,
} from './RuntimeClient';

export interface RuntimeFixtureFrame {
  event: unknown;
  delayMs?: number;
}

export interface RuntimeFixtureScenario {
  events: RuntimeFixtureFrame[];
  commandResponses?: Record<string, unknown | ((payload: unknown) => unknown)>;
}

export interface RuntimeFixtureTransportOptions {
  delayScale?: number;
  minimumDelayMs?: number;
}

/**
 * Product-only fixture transport. It lets React features consume the same
 * RuntimeClient boundary before a live Runtime Host is available.
 */
export class FixtureRuntimeTransport implements RuntimeTransport {
  readonly #scenario: RuntimeFixtureScenario;
  readonly #delayScale: number;
  readonly #minimumDelayMs: number;

  constructor(
    scenario: RuntimeFixtureScenario,
    options: RuntimeFixtureTransportOptions = {},
  ) {
    this.#scenario = scenario;
    this.#delayScale = Math.max(0, options.delayScale ?? 1);
    this.#minimumDelayMs = Math.max(0, options.minimumDelayMs ?? 0);
  }

  async *openEventStream(request: RuntimeStreamRequest): AsyncIterable<unknown> {
    for (const frame of this.#scenario.events) {
      if (request.signal?.aborted) {
        return;
      }
      const delayMs = Math.max(frame.delayMs ?? 0, this.#minimumDelayMs) *
        this.#delayScale;
      await delay(delayMs, request.signal);
      if (request.signal?.aborted) {
        return;
      }
      yield structuredClone(frame.event);
    }
  }

  async sendCommand(command: RuntimeCommand, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) {
      throw abortError();
    }
    const response = this.#scenario.commandResponses?.[command.kind];
    if (response === undefined) {
      throw new Error(`No fixture response registered for command: ${command.kind}`);
    }
    const value = typeof response === 'function' ? response(command.payload) : response;
    return structuredClone(value);
  }
}

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (milliseconds <= 0) {
    return signal?.aborted ? Promise.reject(abortError()) : Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      globalThis.clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function abortError(): DOMException {
  return new DOMException('The Runtime fixture stream was aborted.', 'AbortError');
}
