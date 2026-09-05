import {
  ANSWER_RUNTIME_PERMISSION_COMMAND,
  REMOVE_RUNTIME_PROVIDER_BINDING_COMMAND,
  RUN_MODEL_TURN_COMMAND,
  RUN_RUNTIME_SESSION_TURN_COMMAND,
  UPSERT_RUNTIME_PROVIDER_BINDING_COMMAND,
  decodeRuntimeEvent,
  runtimeProviderBindingConfigSchema,
  runtimeProviderBindingIdentitySchema,
  runtimeProviderBindingResultSchema,
  runtimePermissionAnswerSchema,
  type ModelRequest,
  type RuntimeSessionTurnRequest,
  type RuntimeEvent,
  type RuntimePermissionAnswer,
  type RuntimeProviderBindingConfig,
  type RuntimeProviderBindingResult,
} from '@cardbush/bush-protocol';
import {
  ElectronRuntimeTransport,
  type ElectronRuntimeBridge,
} from '@cardbush/bush-runtime-electron';

import { ProtocolRuntimeClient } from './ProtocolRuntimeClient';
import {
  GoalContinuationRunner,
  type GoalContinuationResult,
  type GoalContinuationRunInput,
  type GoalContinuationTurnResult,
} from './GoalContinuationRunner';
import type { RuntimeTerminalView } from './RuntimeTurnProjection';
import { RuntimeTurnStore } from './RuntimeTurnStore';
import { settleRuntimeTurn } from './settleRuntimeTurn';

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
 * provider failure remains visible as ordered Runtime events. Product Stop uses
 * the typed `runtime.stop_turn` command; operation cancellation here is reserved
 * for coordinator disposal while the event stream awaits Runtime-owned terminal
 * facts.
 */
export class ElectronRuntimeSession {
  readonly client: ElectronProtocolRuntimeClient;
  readonly store: RuntimeTurnStore;
  #operationController?: AbortController;
  #goalController?: AbortController;
  readonly #createId: (kind?: string) => string;

  constructor(
    bridge: ElectronRuntimeBridge,
    options: ElectronRuntimeSessionOptions = {},
  ) {
    this.#createId = options.createId ?? (() => crypto.randomUUID());
    this.client = new ElectronProtocolRuntimeClient(
      new ElectronRuntimeTransport(bridge, { createId: this.#createId }),
    );
    this.store = new RuntimeTurnStore(this.client);
  }

  async discoverCapabilities(signal?: AbortSignal) {
    await this.store.discoverCapabilities(signal);
    return this.store.getSnapshot().capabilities;
  }

  async run(request: ModelRequest): Promise<ElectronRuntimeTurnResult> {
    return this.#runCommand(
      request.sessionId,
      request.turnId,
      (signal) => this.client.runModelTurn(request, signal),
    );
  }

  async runSessionTurn(
    request: RuntimeSessionTurnRequest,
    signal?: AbortSignal,
  ): Promise<ElectronRuntimeTurnResult> {
    return this.#runCommand(
      request.sessionId,
      request.turnId,
      (operationSignal) => this.client.runSessionTurn(request, operationSignal),
      signal,
    );
  }

  async runGoal(
    input: GoalContinuationRunInput,
    options: {
      onTurnCompleted?: (result: GoalContinuationTurnResult) => void | Promise<void>;
    } = {},
  ): Promise<GoalContinuationResult> {
    if (this.#goalController) throw new Error('An Electron Runtime Goal is already active.');
    const controller = new AbortController();
    this.#goalController = controller;
    const runner = new GoalContinuationRunner({
      client: this.client,
      runTurn: async (request, signal) => {
        const result = await this.runSessionTurn(request, signal);
        if (!result.commandTerminal) {
          throw result.commandError ?? new Error('Goal Turn returned no terminal command fact.');
        }
        return result.commandTerminal;
      },
      createId: (kind) => this.#createId(kind),
    });
    try {
      return await runner.run(input, {
        signal: controller.signal,
        onTurnCompleted: options.onTurnCompleted,
      });
    } finally {
      if (this.#goalController === controller) this.#goalController = undefined;
    }
  }

  async #runCommand(
    sessionId: string,
    turnId: string,
    command: (signal: AbortSignal) => Promise<RuntimeTerminalEvent>,
    externalSignal?: AbortSignal,
  ): Promise<ElectronRuntimeTurnResult> {
    if (this.#operationController) {
      throw new Error('An Electron Runtime Turn is already active.');
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    if (externalSignal?.aborted) controller.abort();
    else externalSignal?.addEventListener('abort', abort, { once: true });
    this.#operationController = controller;
    const streamResult = this.store.start({
      sessionId,
      turnId,
    });
    const commandResult = Promise.resolve().then(() => command(controller.signal));

    try {
      let commandTerminal: RuntimeTerminalEvent | undefined;
      let commandError: unknown;
      try {
        [, commandTerminal] = await settleRuntimeTurn(
          streamResult, commandResult, () => this.store.cancel(),
        );
      } catch (error) {
        if (!this.store.getSnapshot().view.terminal) {
          this.store.fail(error);
          throw error;
        }
        commandError = error;
      }

      const terminal = this.store.getSnapshot().view.terminal;
      if (!terminal) {
        throw new Error('Electron Runtime stream settled without turn_terminal.');
      }

      return {
        terminal,
        commandTerminal,
        commandError,
      };
    } finally {
      if (this.#operationController === controller) {
        this.#operationController = undefined;
      }
      externalSignal?.removeEventListener('abort', abort);
    }
  }

  stop() {
    this.#goalController?.abort();
    this.#operationController?.abort();
  }

  answerPermission(
    answer: RuntimePermissionAnswer,
    signal?: AbortSignal,
  ) {
    return this.client.answerPermission(answer, signal);
  }

  configureProvider(
    config: RuntimeProviderBindingConfig,
    signal?: AbortSignal,
  ) {
    return this.client.configureProvider(config, signal);
  }

  removeProvider(bindingId: string, signal?: AbortSignal) {
    return this.client.removeProvider(bindingId, signal);
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

  override runSessionTurn(
    request: RuntimeSessionTurnRequest,
    signal?: AbortSignal,
  ): Promise<RuntimeTerminalEvent> {
    return this.command(
      { kind: RUN_RUNTIME_SESSION_TURN_COMMAND, payload: request },
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

  configureProvider(
    config: RuntimeProviderBindingConfig,
    signal?: AbortSignal,
  ): Promise<RuntimeProviderBindingResult> {
    const payload = runtimeProviderBindingConfigSchema.parse(config);
    return this.command(
      { kind: UPSERT_RUNTIME_PROVIDER_BINDING_COMMAND, payload },
      (input) => runtimeProviderBindingResultSchema.parse(input),
      signal,
    );
  }

  removeProvider(
    bindingId: string,
    signal?: AbortSignal,
  ): Promise<RuntimeProviderBindingResult> {
    const payload = runtimeProviderBindingIdentitySchema.parse({ bindingId });
    return this.command(
      { kind: REMOVE_RUNTIME_PROVIDER_BINDING_COMMAND, payload },
      (input) => runtimeProviderBindingResultSchema.parse(input),
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
