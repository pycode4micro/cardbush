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

/**
 * Product-only fixture transport. It lets React features consume the same
 * RuntimeClient boundary before a live Runtime Host is available.
 */
export class FixtureRuntimeTransport implements RuntimeTransport {
  readonly #scenario: RuntimeFixtureScenario;

  constructor(scenario: RuntimeFixtureScenario) {
    this.#scenario = scenario;
  }

  async *openEventStream(request: RuntimeStreamRequest): AsyncIterable<unknown> {
    for (const frame of this.#scenario.events) {
      if (request.signal?.aborted) {
        return;
      }
      await delay(frame.delayMs ?? 0, request.signal);
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
