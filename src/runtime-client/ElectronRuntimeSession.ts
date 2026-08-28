import {
  ANSWER_RUNTIME_PERMISSION_COMMAND,
  decodeRuntimeEvent,
  runtimePermissionAnswerSchema,
  type ModelRequest,
  type RuntimeEvent,
  type RuntimePermissionAnswer,
} from '@cardbush/bush-protocol';
import { RUN_MODEL_TURN_COMMAND } from '@cardbush/bush-runtime';
import {
  ElectronRuntimeTransport,
  type ElectronRuntimeBridge,
} from '@cardbush/bush-runtime-electron';

import { ProtocolRuntimeClient } from './ProtocolRuntimeClient';
import type { RuntimeTerminalView } from './RuntimeTurnProjection';
import { RuntimeTurnStore } from './RuntimeTurnStore';

type RuntimeTerminalEvent = Extract<RuntimeEvent, { kind: 'turn_terminal' }>;

export interface ElectronRuntimeTurnResult {
  terminal: RuntimeTerminalView;
  commandTerminal?: RuntimeTerminalEvent;
  commandError?: unknown;
}

export interface ElectronRuntimeSessionOptions {
  createId?: () => string;
}

/**
 * Product-side coordinator for one live Electron Runtime Turn at a time.
 *
 * It subscribes before dispatching the Turn command so even an immediate
 * provider failure remains visible as ordered Runtime events. A user stop only
 * cancels the command operation; the event stream stays attached long enough to
 * receive the Runtime-owned `turn_terminal` fact.
 */
export class ElectronRuntimeSession {
  readonly client: ElectronProtocolRuntimeClient;
  readonly store: RuntimeTurnStore;
  #operationController?: AbortController;

  constructor(
    bridge: ElectronRuntimeBridge,
    options: ElectronRuntimeSessionOptions = {},
  ) {
    this.client = new ElectronProtocolRuntimeClient(
      new ElectronRuntimeTransport(bridge, { createId: options.createId }),
    );
    this.store = new RuntimeTurnStore(this.client);
  }

  async discoverCapabilities(signal?: AbortSignal) {
    await this.store.discoverCapabilities(signal);
    return this.store.getSnapshot().capabilities;
  }

  async run(request: ModelRequest): Promise<ElectronRuntimeTurnResult> {
    if (this.#operationController) {
      throw new Error('An Electron Runtime Turn is already active.');
    }

    const controller = new AbortController();
    this.#operationController = controller;
    const streamResult = this.store.start({
      sessionId: request.sessionId,
      turnId: request.turnId,
    });
    const commandResult = this.client.runModelTurn(request, controller.signal);

    try {
      const [stream, command] = await Promise.allSettled([
        streamResult,
        commandResult,
      ]);
      if (stream.status === 'rejected') throw stream.reason;

      const terminal = this.store.getSnapshot().view.terminal;
      if (!terminal) {
        throw new Error('Electron Runtime stream settled without turn_terminal.');
      }

      return {
        terminal,
        commandTerminal:
          command.status === 'fulfilled' ? command.value : undefined,
        commandError: command.status === 'rejected' ? command.reason : undefined,
      };
    } finally {
      if (this.#operationController === controller) {
        this.#operationController = undefined;
      }
    }
  }

  stop() {
    this.#operationController?.abort();
  }

  answerPermission(
    answer: RuntimePermissionAnswer,
    signal?: AbortSignal,
  ) {
    return this.client.answerPermission(answer, signal);
  }

  dispose() {
    this.stop();
    this.store.cancel();
  }
}

export class ElectronProtocolRuntimeClient extends ProtocolRuntimeClient {
  runModelTurn(
    request: ModelRequest,
    signal?: AbortSignal,
  ): Promise<RuntimeTerminalEvent> {
    return this.command(
      { kind: RUN_MODEL_TURN_COMMAND, payload: request },
      decodeRuntimeTerminalEvent,
      signal,
    );
  }

  answerPermission(
    answer: RuntimePermissionAnswer,
    signal?: AbortSignal,
  ): Promise<RuntimePermissionAnswer> {
    const payload = runtimePermissionAnswerSchema.parse(answer);
    return this.command(
      { kind: ANSWER_RUNTIME_PERMISSION_COMMAND, payload },
      (input) => runtimePermissionAnswerSchema.parse(input),
      signal,
    );
  }
}

export function createDesktopRuntimeSession(
  options?: ElectronRuntimeSessionOptions,
) {
  const bridge = window.cardbushDesktop?.runtime;
  if (!bridge) {
    throw new Error('Electron Runtime bridge is unavailable in this renderer.');
  }
  return new ElectronRuntimeSession(bridge, options);
}

function decodeRuntimeTerminalEvent(input: unknown): RuntimeTerminalEvent {
  const event = decodeRuntimeEvent(input);
  if (event.kind !== 'turn_terminal') {
    throw new Error(`Runtime Turn command returned ${event.kind}, not turn_terminal.`);
  }
  return event;
}
