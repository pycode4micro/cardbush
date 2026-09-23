import {
  utilityProcess,
  type IpcMain,
  type UtilityProcess,
  type WebContents,
  type WebFrameMain,
} from 'electron';
import { isMcpHostMessage, handleMcpHostRequest, type McpHostOperation } from './mcpHostBridge.js';
import { HostProcessResourceOwner } from './hostProcesses.js';

import {
  BUSH_RUNTIME_ERROR_PROTOCOL,
  BUSH_RUNTIME_IPC_PROTOCOL,
  RUNTIME_IPC_CANCEL_OPERATION_CHANNEL,
  RUNTIME_IPC_COMMAND_CHANNEL,
  RUNTIME_IPC_START_STREAM_CHANNEL,
  RUNTIME_IPC_STOP_STREAM_CHANNEL,
  RUNTIME_IPC_STREAM_FRAME_CHANNEL,
  createProtocolVersionMismatchError,
  decodeRuntimeIpcInboundMessage,
  decodeRuntimeIpcOutboundMessage,
  extractRuntimeIpcProtocol,
  type RuntimeIpcInboundMessage,
  type RuntimeIpcOutboundMessage,
  type RuntimeProtocolError,
} from '@cardbush/bush-protocol';

export interface RuntimeHostControllerOptions {
  onReady?: () => void;
  onMcpHostRequest?: (operation: McpHostOperation, payload: unknown, signal: AbortSignal) => Promise<unknown>;
  modulePath: string;
  env?: NodeJS.ProcessEnv;
  startupTimeoutMs?: number;
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

interface PendingOperation {
  resolve: (message: RuntimeIpcOutboundMessage) => void;
  reject: (error: Error) => void;
}

interface RuntimeStreamSubscription {
  owner: WebContents;
  frame: WebFrameMain;
  controller?: RuntimeHostIpcController;
}

interface RuntimeIpcOperation {
  owner: WebContents;
  frame: WebFrameMain;
  controller?: RuntimeHostIpcController;
  cancelled?: Error;
}

export type RuntimeHostIpcController = Pick<RuntimeUtilityProcessController,
  'command' | 'startStream' | 'stopStream' | 'cancelOperation' | 'onStreamFrame'>;

export interface RuntimeHostIpcRegistration {
  reset(error?: Error): void;
  dispose(): void;
}

export class RuntimeUtilityProcessController {
  readonly #options: RuntimeHostControllerOptions;
  readonly #pending = new Map<string, PendingOperation>();
  readonly #frameListeners = new Set<(message: RuntimeIpcOutboundMessage) => void>();
  #child?: UtilityProcess;
  #ready?: Promise<RuntimeIpcOutboundMessage>;
  #disposed = false;

  constructor(options: RuntimeHostControllerOptions) {
    this.#options = options;
  }

  start(): Promise<RuntimeIpcOutboundMessage> {
    if (this.#disposed) return Promise.reject(new RuntimeHostControllerError(runtimeError(
      'transport', 'runtime_host_stopped', 'Runtime Utility Process controller was disposed.',
    )));
    if (this.#ready) return this.#ready;
    const ready = new Promise<RuntimeIpcOutboundMessage>((resolve, reject) => {
      // Node permits unset ProcessEnv entries; Electron rejects them at fork.
      // Omit only undefined values so explicit policies and empty strings survive.
      const env = Object.fromEntries(
        Object.entries(this.#options.env ?? process.env).filter(([, value]) => value !== undefined),
      );
      const child = utilityProcess.fork(this.#options.modulePath, [], {
        env: { ...env, CARDBUSH_RESOURCE_COORDINATION: 'desktop' },
        serviceName: 'CardBush Runtime Host',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      this.#child = child;
      const hostRequests = new Map<string, AbortController>();
      const resources = new HostProcessResourceOwner();
      child.once('exit', () => { for (const request of hostRequests.values()) request.abort(); hostRequests.clear(); resources.close(); });
      const startupTimeoutMs = Math.max(1_000, this.#options.startupTimeoutMs ?? 12_000);
      const startupTimeout = setTimeout(() => {
        const failure = new RuntimeHostControllerError(
          runtimeError(
            'transport',
            'runtime_host_startup_timeout',
            `Runtime Utility Process did not become ready within ${startupTimeoutMs}ms.`,
          ),
        );
        if (this.#child === child) {
          this.#failAll(failure);
          this.#child = undefined;
          child.kill();
        }
        reject(failure);
      }, startupTimeoutMs);
      const clearStartupTimeout = () => clearTimeout(startupTimeout);
      child.stdout?.on('data', (chunk) => {
        this.#options.onStdout?.(String(chunk));
      });
      child.stderr?.on('data', (chunk) => {
        this.#options.onStderr?.(String(chunk));
      });
      child.on('message', (candidate) => {
        if (this.#child !== child) return;
        if (isMcpHostMessage(candidate)) {
          if (candidate.type === 'cancel') { hostRequests.get(candidate.id)?.abort(); return; }
          if (candidate.type === 'request') {
            const abort = new AbortController();
            hostRequests.set(candidate.id, abort);
            void handleMcpHostRequest(candidate, abort.signal, (operation, payload, signal) => {
              if (operation === 'resources.acquire' || operation === 'resources.release') return resources.handle(operation, payload, signal);
              if (!this.#options.onMcpHostRequest) throw new Error('MCP desktop integration is unavailable.');
              return this.#options.onMcpHostRequest(operation, payload, signal);
            })
              .then(response => { if (this.#child === child) child.postMessage(response); })
              .catch(error => this.#options.onStderr?.(`MCP host response delivery failed: ${errorMessage(error)}`))
              .finally(() => hostRequests.delete(candidate.id));
          }
          return;
        }
        let message;
        try {
          message = decodeRuntimeIpcOutboundMessage(candidate);
        } catch (error) {
          const received = extractRuntimeIpcProtocol(candidate);
          const fact = received !== BUSH_RUNTIME_IPC_PROTOCOL
            ? createProtocolVersionMismatchError(received)
            : runtimeError('protocol', 'invalid_runtime_host_message', errorMessage(error));
          const failure = new RuntimeHostControllerError(fact);
          clearStartupTimeout();
          reject(failure);
          this.#failAll(failure);
          return;
        }
        if (message.type === 'ready') {
          clearStartupTimeout();
          resolve(message);
          this.#options.onReady?.();
          return;
        }
        if (message.type === 'command_response') {
          const pending = this.#pending.get(message.operationId);
          if (pending) {
            this.#pending.delete(message.operationId);
            pending.resolve(message);
          }
          return;
        }
        if (message.type === 'stream_frame') {
          for (const listener of this.#frameListeners) listener(message);
          return;
        }
        const failure = new RuntimeHostControllerError(message.error);
        this.#failAll(failure);
      });
      child.on('exit', (code) => {
        clearStartupTimeout();
        const failure = new RuntimeHostControllerError(
          runtimeError(
            'transport',
            'runtime_host_exited',
            `Runtime Utility Process exited with code ${code}.`,
          ),
        );
        reject(failure);
        // A stopped process may exit after its replacement has already started.
        // Its late events must not clear the new process or reject its commands.
        if (this.#child === child) {
          this.#child = undefined;
          this.#ready = undefined;
          this.#failAll(failure);
        }
      });
      child.on('error', (_type, location, report) => {
        clearStartupTimeout();
        const failure = new RuntimeHostControllerError(
          runtimeError(
            'transport',
            'runtime_host_fatal_error',
            `Runtime Utility Process failed at ${location}.`,
            undefined,
            { report },
          ),
        );
        reject(failure);
        if (this.#child === child) this.#failAll(failure);
      });
    });
    this.#ready = ready;
    void ready.catch(() => {
      if (this.#ready === ready) this.#ready = undefined;
    });
    return ready;
  }

  async command(input: unknown): Promise<RuntimeIpcOutboundMessage> {
    const operationId = extractString(input, 'operationId') ?? 'invalid_operation';
    let message;
    try {
      message = decodeRuntimeIpcInboundMessage(input);
    } catch (error) {
      return commandFailure(
        operationId,
        inboundProtocolError(input, error, operationId),
      );
    }
    if (message.type !== 'command') {
      return commandFailure(
        operationId,
        runtimeError(
          'protocol',
          'invalid_runtime_command',
          'Runtime command channel received a non-command message.',
          operationId,
        ),
      );
    }
    try {
      await this.start();
    } catch (error) {
      return commandFailure(
        message.operationId,
        error instanceof RuntimeHostControllerError
          ? error.fact
          : runtimeError(
              'transport',
              'runtime_host_unavailable',
              errorMessage(error),
              message.operationId,
            ),
      );
    }
    if (this.#pending.has(message.operationId)) {
      return commandFailure(
        message.operationId,
        runtimeError(
          'protocol',
          'duplicate_operation_id',
          `Operation ${message.operationId} already exists.`,
          message.operationId,
        ),
      );
    }
    return new Promise((resolve, reject) => {
      this.#pending.set(message.operationId, { resolve, reject });
      this.#post(message);
    });
  }

  async startStream(input: unknown): Promise<void> {
    const message = decodeRuntimeIpcInboundMessage(input);
    if (message.type !== 'start_stream') {
      throw new Error('Runtime stream channel received an invalid message.');
    }
    await this.start();
    this.#post(message);
  }

  async stopStream(input: unknown): Promise<void> {
    const message = decodeRuntimeIpcInboundMessage(input);
    if (message.type !== 'stop_stream') {
      throw new Error('Runtime stop channel received an invalid message.');
    }
    // Cleanup must not start (or target) a replacement Runtime process.
    const child = this.#child;
    if (!child) return;
    await this.#ready?.catch(() => undefined);
    if (this.#child === child) child.postMessage(message);
  }

  async cancelOperation(input: unknown): Promise<void> {
    const message = decodeRuntimeIpcInboundMessage(input);
    if (message.type !== 'cancel_operation') {
      throw new Error('Runtime cancellation channel received an invalid message.');
    }
    // Cancellation, like stream cleanup, must never launch a replacement worker.
    const child = this.#child;
    if (!child) return;
    await this.#ready?.catch(() => undefined);
    if (this.#child === child) child.postMessage(message);
  }

  onStreamFrame(listener: (message: RuntimeIpcOutboundMessage) => void): () => void {
    this.#frameListeners.add(listener);
    return () => this.#frameListeners.delete(listener);
  }

  stop(): void {
    const child = this.#child;
    this.#child = undefined;
    this.#ready = undefined;
    this.#failAll(new RuntimeHostControllerError(runtimeError(
      'transport', 'runtime_host_stopped', 'Runtime Utility Process was stopped.',
    )));
    child?.kill();
  }

  dispose(): void {
    this.#disposed = true;
    this.stop();
  }

  #post(message: RuntimeIpcInboundMessage) {
    if (!this.#child) throw new Error('Runtime Utility Process is not running.');
    this.#child.postMessage(message);
  }

  #failAll(error: Error) {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }

}

export class RuntimeHostControllerError extends Error {
  readonly fact: RuntimeProtocolError;

  constructor(fact: RuntimeProtocolError) {
    super(fact.message);
    this.name = 'RuntimeHostControllerError';
    this.fact = fact;
  }
}

export function registerRuntimeHostIpc(
  ipc: IpcMain,
  source: RuntimeHostIpcController | (() => Promise<RuntimeHostIpcController>),
  isAllowedSender: (sender: WebContents) => boolean,
): RuntimeHostIpcRegistration {
  const getController = typeof source === 'function' ? source : async () => source;
  const subscriptions = new Map<string, RuntimeStreamSubscription>();
  const startingSubscriptions = new Set<string>();
  const ownerCleanup = new Map<WebContents, () => void>();
  const frameListeners = new Map<RuntimeHostIpcController, () => void>();
  const operations = new Map<string, RuntimeIpcOperation>();
  let disposed = false;
  const releaseOwnerListeners = (owner: WebContents) => {
    if (![...subscriptions.values()].some(item => item.owner === owner)
      && ![...operations.values()].some(item => item.owner === owner)) {
      ownerCleanup.get(owner)?.();
      ownerCleanup.delete(owner);
    }
  };
  const releaseSubscription = (id: string, stopWorker = true) => {
    const subscription = subscriptions.get(id);
    if (!subscription) return;
    subscriptions.delete(id);
    if (stopWorker && subscription.controller) {
      void subscription.controller.stopStream({
        protocol: BUSH_RUNTIME_IPC_PROTOCOL, type: 'stop_stream', subscriptionId: id,
      }).catch(() => undefined);
    }
    if (subscription.controller && ![...subscriptions.values()].some(item => item.controller === subscription.controller)) {
      frameListeners.get(subscription.controller)?.();
      frameListeners.delete(subscription.controller);
    }
    releaseOwnerListeners(subscription.owner);
  };
  const watchOwner = (owner: WebContents) => {
    if (ownerCleanup.has(owner)) return;
    let navigating = new Map<string, RuntimeStreamSubscription>();
    let navigatingOperations = new Map<string, RuntimeIpcOperation>();
    const cancelPending = (operation: { cancelled?: Error }) => {
      operation.cancelled = new Error('The requesting renderer document is no longer available.');
    };
    const releaseOwner = () => {
      for (const operation of operations.values()) {
        if (operation.owner === owner) cancelPending(operation);
      }
      for (const [id, subscription] of subscriptions) {
        if (subscription.owner === owner) releaseSubscription(id);
      }
    };
    const navigationStarted = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
      if (!details.isMainFrame || details.isSameDocument) return;
      // Capture old IDs but do not cancel on a merely attempted navigation: a
      // beforeunload handler or navigation guard may keep this document alive.
      navigating = new Map([...subscriptions].filter(([, s]) => s.owner === owner));
      navigatingOperations = new Map([...operations].filter(([, item]) => item.owner === owner));
    };
    const navigationCommitted = () => {
      for (const [id, subscription] of navigating) {
        if (subscriptions.get(id) === subscription) releaseSubscription(id);
      }
      navigating.clear();
      for (const [id, operation] of navigatingOperations) {
        if (operations.get(id) === operation) cancelPending(operation);
      }
      navigatingOperations.clear();
    };
    owner.on('destroyed', releaseOwner);
    owner.on('render-process-gone', releaseOwner);
    owner.on('did-start-navigation', navigationStarted);
    owner.on('did-navigate', navigationCommitted);
    ownerCleanup.set(owner, () => {
      owner.removeListener('destroyed', releaseOwner);
      owner.removeListener('render-process-gone', releaseOwner);
      owner.removeListener('did-start-navigation', navigationStarted);
      owner.removeListener('did-navigate', navigationCommitted);
    });
  };
  const ensureAllowed = (sender: WebContents) => {
    if (disposed || !isAllowedSender(sender)) {
      throw new Error('Renderer is not allowed to access the Runtime Host.');
    }
  };
  const ensureFrame = (frame: WebFrameMain | null) => {
    if (!frame || frame.isDestroyed() || frame.detached) {
      throw new Error('Renderer frame is unavailable for Runtime request.');
    }
  };
  ipc.handle(RUNTIME_IPC_COMMAND_CHANNEL, async (event, input) => {
    ensureAllowed(event.sender);
    const operationId = extractString(input, 'operationId') ?? 'invalid_operation';
    let message;
    try { message = decodeRuntimeIpcInboundMessage(input); }
    catch (error) { return commandFailure(operationId, inboundProtocolError(input, error, operationId)); }
    if (message.type !== 'command') {
      return commandFailure(operationId, runtimeError('protocol', 'invalid_runtime_command',
        'Runtime command channel received a non-command message.', operationId));
    }
    if (operations.has(operationId)) {
      return commandFailure(operationId, runtimeError('protocol', 'duplicate_operation_id',
        `Operation ${operationId} already exists.`, operationId));
    }
    const frame = event.senderFrame;
    ensureFrame(frame);
    const operation: RuntimeIpcOperation = {
      owner: event.sender, frame: frame!,
    };
    operations.set(operationId, operation);
    watchOwner(event.sender);
    try {
      const controller = await getController();
      ensureAllowed(event.sender);
      ensureFrame(frame);
      if (operation.cancelled) throw operation.cancelled;
      operation.controller = controller;
      return await controller.command(message);
    } catch (error) {
      return commandFailure(operationId, error instanceof RuntimeHostControllerError ? error.fact
        : runtimeError('transport', (error as { code?: string })?.code ?? 'runtime_host_unavailable', errorMessage(error), operationId));
    } finally {
      operations.delete(operationId);
      releaseOwnerListeners(event.sender);
    }
  });
  ipc.handle(RUNTIME_IPC_START_STREAM_CHANNEL, async (event, input) => {
    ensureAllowed(event.sender);
    const message = decodeRuntimeIpcInboundMessage(input);
    if (message.type !== 'start_stream') {
      throw new Error('Invalid Runtime stream request.');
    }
    const frame = event.senderFrame;
    if (!frame || frame.isDestroyed() || frame.detached) {
      throw new Error('Renderer frame is unavailable for Runtime stream.');
    }
    if (subscriptions.has(message.subscriptionId) || startingSubscriptions.has(message.subscriptionId)) {
      throw new Error('Runtime subscription identity is already in use.');
    }
    const subscription: RuntimeStreamSubscription = {
      owner: event.sender,
      frame,
    };
    subscriptions.set(message.subscriptionId, subscription);
    watchOwner(event.sender);
    startingSubscriptions.add(message.subscriptionId);
    try {
      const controller = await getController();
      if (subscriptions.get(message.subscriptionId) !== subscription) return;
      ensureAllowed(event.sender);
      ensureFrame(frame);
      subscription.controller = controller;
      if (!frameListeners.has(controller)) {
        frameListeners.set(controller, controller.onStreamFrame(message => deliverFrame(controller, message)));
      }
      await controller.startStream(message);
      // The frame can disappear while Runtime startup is awaiting readiness.
      if (subscriptions.get(message.subscriptionId) !== subscription) {
        await controller.stopStream({
          protocol: BUSH_RUNTIME_IPC_PROTOCOL, type: 'stop_stream', subscriptionId: message.subscriptionId,
        }).catch(() => undefined);
      }
    } catch (error) {
      if (subscriptions.get(message.subscriptionId) === subscription) releaseSubscription(message.subscriptionId);
      throw error;
    } finally {
      startingSubscriptions.delete(message.subscriptionId);
    }
  });
  ipc.handle(RUNTIME_IPC_STOP_STREAM_CHANNEL, async (event, input) => {
    ensureAllowed(event.sender);
    const message = decodeRuntimeIpcInboundMessage(input);
    if (message.type !== 'stop_stream') {
      throw new Error('Invalid Runtime stream stop request.');
    }
    const subscription = subscriptions.get(message.subscriptionId);
    if (subscription && (subscription.owner !== event.sender || subscription.frame !== event.senderFrame)) {
      throw new Error('Runtime stream belongs to a different renderer.');
    }
    releaseSubscription(message.subscriptionId);
  });
  ipc.handle(RUNTIME_IPC_CANCEL_OPERATION_CHANNEL, (event, input) => {
    ensureAllowed(event.sender);
    const message = decodeRuntimeIpcInboundMessage(input);
    if (message.type !== 'cancel_operation') throw new Error('Invalid Runtime cancellation request.');
    const operation = operations.get(message.operationId);
    if (!operation) return;
    if (operation.owner !== event.sender || operation.frame !== event.senderFrame) {
      throw new Error('Runtime operation belongs to a different renderer.');
    }
    operation.cancelled = new RuntimeHostControllerError(runtimeError('transport', 'runtime_operation_cancelled',
      'Runtime operation was cancelled before completion.', message.operationId));
    return operation.controller?.cancelOperation(message);
  });
  function deliverFrame(controller: RuntimeHostIpcController, message: RuntimeIpcOutboundMessage) {
    if (message.type !== 'stream_frame') return;
    const subscription = subscriptions.get(message.subscriptionId);
    if (subscription?.controller !== controller) return;
    if (
      !subscription
      || subscription.owner.isDestroyed()
      || subscription.frame.isDestroyed()
      || subscription.frame.detached
    ) {
      releaseSubscription(message.subscriptionId);
      return;
    }
    try {
      subscription.frame.send(RUNTIME_IPC_STREAM_FRAME_CHANNEL, message);
    } catch {
      // Navigation or a renderer crash can dispose the exact subscribing frame
      // while the owning WebContents remains alive. Never retarget its stream to
      // a replacement frame created by a reload.
      releaseSubscription(message.subscriptionId);
      return;
    }
    if (message.frame.kind === 'end' || message.frame.kind === 'error') {
      releaseSubscription(message.subscriptionId, false);
    }
  }
  const reset = (error = new Error('Runtime services are restarting.')) => {
    for (const operation of operations.values()) operation.cancelled = error;
    for (const [id, subscription] of subscriptions) {
      try {
        subscription.frame.send(RUNTIME_IPC_STREAM_FRAME_CHANNEL, {
          protocol: BUSH_RUNTIME_IPC_PROTOCOL, type: 'stream_frame', subscriptionId: id,
          frame: { kind: 'error', error: runtimeError('transport', 'runtime_host_unavailable', error.message) },
        });
      } catch { /* The owning document may already have closed. */ }
      releaseSubscription(id);
    }
  };
  return {
    reset,
    dispose() {
      disposed = true;
      reset(new Error('Runtime IPC was closed.'));
      ipc.removeHandler(RUNTIME_IPC_COMMAND_CHANNEL);
      ipc.removeHandler(RUNTIME_IPC_START_STREAM_CHANNEL);
      ipc.removeHandler(RUNTIME_IPC_STOP_STREAM_CHANNEL);
      ipc.removeHandler(RUNTIME_IPC_CANCEL_OPERATION_CHANNEL);
    },
  };
}

function runtimeError(
  kind: RuntimeProtocolError['kind'],
  code: string,
  message: string,
  requestId?: string,
  details: Record<string, unknown> = {},
): RuntimeProtocolError {
  return {
    protocol: BUSH_RUNTIME_ERROR_PROTOCOL,
    kind,
    code,
    message,
    retryable: false,
    details,
    requestId,
  };
}

function commandFailure(
  operationId: string,
  error: RuntimeProtocolError,
): RuntimeIpcOutboundMessage {
  return {
    protocol: BUSH_RUNTIME_IPC_PROTOCOL,
    type: 'command_response',
    operationId,
    ok: false,
    error,
  };
}

function inboundProtocolError(
  input: unknown,
  error: unknown,
  requestId?: string,
): RuntimeProtocolError {
  const received = extractRuntimeIpcProtocol(input);
  return received !== BUSH_RUNTIME_IPC_PROTOCOL
    ? createProtocolVersionMismatchError(
        received,
        BUSH_RUNTIME_IPC_PROTOCOL,
        requestId,
      )
    : runtimeError('protocol', 'invalid_ipc_message', errorMessage(error), requestId);
}

function extractString(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' && value ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
