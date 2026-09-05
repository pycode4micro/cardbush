import type {
  RuntimeCapabilities,
  RuntimeEventKind,
} from '@cardbush/bush-protocol';
import { useSyncExternalStore } from 'react';

import type { ProtocolRuntimeClient } from './ProtocolRuntimeClient';
import type { RuntimeStreamRequest } from './RuntimeClient';
import {
  RuntimeTurnProjection,
  type RuntimeTurnView,
} from './RuntimeTurnProjection';

export type RuntimeTurnStreamState =
  | 'idle'
  | 'discovering'
  | 'ready'
  | 'streaming'
  | 'settled'
  | 'error';

export interface RuntimeTurnStoreState {
  streamState: RuntimeTurnStreamState;
  capabilities?: RuntimeCapabilities;
  view: RuntimeTurnView;
  eventCount: number;
  lastEventKind?: RuntimeEventKind;
  error?: string;
}

const emptyProjection = new RuntimeTurnProjection().snapshot();

export class RuntimeTurnStore {
  readonly #client: ProtocolRuntimeClient;
  readonly #listeners = new Set<() => void>();
  #projection = new RuntimeTurnProjection();
  #state: RuntimeTurnStoreState = {
    streamState: 'idle',
    view: emptyProjection,
    eventCount: 0,
  };
  #runController?: AbortController;
  #runRevision = 0;

  constructor(client: ProtocolRuntimeClient) {
    this.#client = client;
  }

  getSnapshot = () => this.#state;

  subscribe = (listener: () => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  async discoverCapabilities(signal?: AbortSignal) {
    this.#publish({ ...this.#state, streamState: 'discovering', error: undefined });
    try {
      const capabilities = await this.#client.getCapabilities(signal);
      if (signal?.aborted) return;
      this.#publish({
        ...this.#state,
        capabilities,
        streamState: 'ready',
        error: undefined,
      });
    } catch (error) {
      if (isAbortError(error)) return;
      this.#publish({
        ...this.#state,
        streamState: 'error',
        error: errorMessage(error),
      });
      throw error;
    }
  }

  async start(request: RuntimeStreamRequest) {
    this.cancel();
    const revision = ++this.#runRevision;
    const controller = new AbortController();
    this.#runController = controller;
    const detachExternalAbort = forwardAbort(request.signal, controller);
    this.#projection = new RuntimeTurnProjection();
    this.#publish({
      ...this.#state,
      streamState: 'streaming',
      view: this.#projection.snapshot(),
      eventCount: 0,
      lastEventKind: undefined,
      error: undefined,
    });

    try {
      for await (const event of this.#client.events({
        ...request,
        signal: controller.signal,
      })) {
        if (revision !== this.#runRevision) return;
        const view = this.#projection.apply(event);
        this.#publish({
          ...this.#state,
          streamState: view.terminal ? 'settled' : 'streaming',
          view,
          eventCount: this.#state.eventCount + 1,
          lastEventKind: event.kind,
          error: undefined,
        });
      }
      if (revision !== this.#runRevision || controller.signal.aborted) return;
      if (!this.#projection.snapshot().terminal) {
        throw new Error('Runtime stream closed before turn_terminal.');
      }
    } catch (error) {
      if (revision !== this.#runRevision || isAbortError(error)) return;
      this.#publish({
        ...this.#state,
        streamState: 'error',
        error: errorMessage(error),
      });
      throw error;
    } finally {
      detachExternalAbort();
      if (this.#runController === controller) {
        this.#runController = undefined;
      }
    }
  }

  cancel() {
    this.#runRevision += 1;
    this.#runController?.abort();
    this.#runController = undefined;
  }

  fail(error: unknown) {
    this.cancel();
    this.#publish({ ...this.#state, streamState: 'error', error: errorMessage(error) });
  }

  #publish(next: RuntimeTurnStoreState) {
    this.#state = next;
    this.#listeners.forEach((listener) => listener());
  }
}

export function useRuntimeTurnStore(store: RuntimeTurnStore) {
  return useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
}

function forwardAbort(
  signal: AbortSignal | undefined,
  controller: AbortController,
) {
  if (!signal) return () => undefined;
  if (signal.aborted) {
    controller.abort();
    return () => undefined;
  }
  const abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  return () => signal.removeEventListener('abort', abort);
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
