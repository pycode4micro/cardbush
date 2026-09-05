import {
  BUSH_RUNTIME_IPC_PROTOCOL,
  createProtocolVersionMismatchError,
  decodeRuntimeIpcOutboundMessage,
  extractRuntimeIpcProtocol,
  type RuntimeIpcInboundMessage,
  type RuntimeIpcOutboundMessage,
  type RuntimeIpcStreamFrame,
  type RuntimeProtocolError,
} from "@cardbush/bush-protocol";

export interface ElectronRuntimeCommand {
  kind: string;
  payload: unknown;
}

export interface ElectronRuntimeStreamRequest {
  sessionId: string;
  turnId?: string;
  cursor?: { afterSequence?: number; lastEventId?: string };
  signal?: AbortSignal;
}

export interface ElectronRuntimeBridge {
  command(message: RuntimeIpcInboundMessage): Promise<unknown>;
  startStream(message: RuntimeIpcInboundMessage): Promise<void>;
  stopStream(message: RuntimeIpcInboundMessage): Promise<void>;
  cancelOperation(message: RuntimeIpcInboundMessage): Promise<void>;
  onStreamFrame(
    listener: (message: unknown) => void,
  ): () => void;
}

export interface ElectronRuntimeTransportOptions {
  createId?: () => string;
}

export class RuntimeRemoteError extends Error {
  readonly fact: RuntimeProtocolError;

  constructor(fact: RuntimeProtocolError) {
    super(fact.message);
    this.name = "RuntimeRemoteError";
    this.fact = fact;
  }
}

export class ElectronRuntimeTransport {
  readonly #bridge: ElectronRuntimeBridge;
  readonly #createId: () => string;

  constructor(
    bridge: ElectronRuntimeBridge,
    options: ElectronRuntimeTransportOptions = {},
  ) {
    this.#bridge = bridge;
    this.#createId = options.createId ?? (() => crypto.randomUUID());
  }

  async sendCommand(
    command: ElectronRuntimeCommand,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (signal?.aborted) throw abortError();
    const operationId = this.#createId();
    const request: RuntimeIpcInboundMessage = {
      protocol: BUSH_RUNTIME_IPC_PROTOCOL,
      type: "command",
      operationId,
      command,
    };
    const cancel = () => {
      void this.#bridge.cancelOperation({
        protocol: BUSH_RUNTIME_IPC_PROTOCOL,
        type: "cancel_operation",
        operationId,
      }).catch(() => undefined);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      let rawResponse: unknown;
      try {
        rawResponse = await this.#bridge.command(request);
      } catch (error) {
        throw transportError(
          "runtime_command_transport_failed",
          errorMessage(error),
          operationId,
        );
      }
      const response = decodeOutbound(rawResponse, operationId);
      if (response.type !== "command_response" || response.operationId !== operationId) {
        throw protocolError(
          "ipc_response_identity_mismatch",
          `Runtime response does not belong to operation ${operationId}.`,
          operationId,
        );
      }
      if (!response.ok) throw new RuntimeRemoteError(response.error);
      return response.result;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  async *openEventStream(
    request: ElectronRuntimeStreamRequest,
  ): AsyncIterable<unknown> {
    if (!request.turnId) {
      throw new Error("turnId is required for the Electron Runtime stream.");
    }
    if (request.signal?.aborted) return;
    const subscriptionId = this.#createId();
    const frames: RuntimeIpcStreamFrame[] = [];
    let frameError: unknown;
    let wake: (() => void) | undefined;
    const unsubscribe = this.#bridge.onStreamFrame((candidate) => {
      if (extractString(candidate, "subscriptionId") !== subscriptionId) {
        return;
      }
      let message;
      try {
        message = decodeOutbound(candidate, subscriptionId);
      } catch (error) {
        frameError = error;
        wake?.();
        wake = undefined;
        return;
      }
      if (
        message.type !== "stream_frame" ||
        message.subscriptionId !== subscriptionId
      ) {
        return;
      }
      frames.push(message.frame);
      wake?.();
      wake = undefined;
    });
    const stopMessage: RuntimeIpcInboundMessage = {
      protocol: BUSH_RUNTIME_IPC_PROTOCOL,
      type: "stop_stream",
      subscriptionId,
    };
    const stop = () => {
      // The command/stream owns reporting transport failure. Cancellation is a
      // best-effort side channel and must not produce an unhandled rejection.
      void this.#bridge.stopStream(stopMessage).catch(() => undefined);
    };
    request.signal?.addEventListener("abort", stop, { once: true });
    try {
      try {
        await this.#bridge.startStream({
          protocol: BUSH_RUNTIME_IPC_PROTOCOL,
          type: "start_stream",
          subscriptionId,
          request: {
            sessionId: request.sessionId,
            turnId: request.turnId,
            cursor: request.cursor,
          },
        });
      } catch (error) {
        throw transportError(
          "runtime_stream_transport_failed",
          errorMessage(error),
          subscriptionId,
        );
      }
      while (!request.signal?.aborted) {
        if (frameError) throw frameError;
        const frame = frames.shift();
        if (!frame) {
          await waitForFrame(frames, request.signal, (resolve) => {
            wake = resolve;
          });
          continue;
        }
        if (frame.kind === "event") {
          yield frame.event;
          continue;
        }
        if (frame.kind === "error") {
          throw new RuntimeRemoteError(frame.error);
        }
        return;
      }
    } finally {
      unsubscribe();
      request.signal?.removeEventListener("abort", stop);
      await this.#bridge.stopStream(stopMessage).catch(() => undefined);
    }
  }
}

function decodeOutbound(
  input: unknown,
  requestId?: string,
): RuntimeIpcOutboundMessage {
  try {
    return decodeRuntimeIpcOutboundMessage(input);
  } catch (error) {
    const received = extractRuntimeIpcProtocol(input);
    if (received !== BUSH_RUNTIME_IPC_PROTOCOL) {
      throw new RuntimeRemoteError(
        createProtocolVersionMismatchError(
          received,
          BUSH_RUNTIME_IPC_PROTOCOL,
          requestId,
        ),
      );
    }
    throw protocolError(
      "invalid_runtime_ipc_message",
      errorMessage(error),
      requestId,
    );
  }
}

function protocolError(
  code: string,
  message: string,
  requestId?: string,
): RuntimeRemoteError {
  return new RuntimeRemoteError({
    protocol: "bush.runtime_error.v1",
    kind: "protocol",
    code,
    message,
    retryable: false,
    details: {},
    requestId,
  });
}

function transportError(
  code: string,
  message: string,
  requestId?: string,
): RuntimeRemoteError {
  return new RuntimeRemoteError({
    protocol: "bush.runtime_error.v1",
    kind: "transport",
    code,
    message,
    retryable: true,
    details: {},
    requestId,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(): DOMException {
  return new DOMException("The Runtime operation was aborted.", "AbortError");
}

function waitForFrame(
  frames: RuntimeIpcStreamFrame[],
  signal: AbortSignal | undefined,
  register: (resolve: () => void) => void,
): Promise<void> {
  if (signal?.aborted || frames.length > 0) return Promise.resolve();
  return new Promise((resolve) => {
    const complete = () => {
      signal?.removeEventListener("abort", complete);
      resolve();
    };
    signal?.addEventListener("abort", complete, { once: true });
    register(complete);
    if (frames.length > 0) complete();
  });
}

function extractString(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}
