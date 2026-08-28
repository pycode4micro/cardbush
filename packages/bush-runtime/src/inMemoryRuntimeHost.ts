import {
  BUSH_RUNTIME_CAPABILITIES_PROTOCOL,
  BUSH_RUNTIME_EVENT_PROTOCOL,
  GET_RUNTIME_CAPABILITIES_COMMAND,
  modelRequestSchema,
  runtimeEventKindSchema,
  type ModelRequest,
  type RuntimeCapabilities,
  type RuntimeEvent,
} from "@cardbush/bush-protocol";

import { executeModelRound } from "./modelRound.js";
import type { ModelProvider } from "./modelProvider.js";
import {
  InMemoryRuntimeEventLog,
  type RuntimeEventCursor,
  type RuntimeEventIdentity,
  type RuntimeEventLogOptions,
} from "./runtimeEventLog.js";
import {
  RuntimeEventProjector,
  type RuntimeEventProjectorOptions,
} from "./runtimeEventProjector.js";

export const RUN_MODEL_TURN_COMMAND = "runtime.run_model_turn" as const;

export interface RuntimeRetryContext {
  nextAttempt: number;
  maxAttempts: number;
  code: string;
}

export interface InMemoryRuntimeHostOptions {
  provider: ModelProvider;
  hostId?: string;
  runtimeVersion?: string;
  maxAttempts?: number;
  retryDelayMs?: (context: RuntimeRetryContext) => number;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  eventLog?: InMemoryRuntimeEventLog;
  eventLogOptions?: RuntimeEventLogOptions;
  projectorOptions?: RuntimeEventProjectorOptions;
}

export interface RuntimeHostStreamRequest {
  sessionId: string;
  turnId?: string;
  cursor?: RuntimeEventCursor;
  signal?: AbortSignal;
}

export interface RuntimeHostCommand {
  kind: string;
  payload: unknown;
}

export class InMemoryRuntimeHost {
  readonly #provider: ModelProvider;
  readonly #eventLog: InMemoryRuntimeEventLog;
  readonly #capabilities: RuntimeCapabilities;
  readonly #maxAttempts: number;
  readonly #retryDelayMs: (context: RuntimeRetryContext) => number;
  readonly #wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly #projectorOptions: RuntimeEventProjectorOptions;
  readonly #activeTurns = new Set<string>();

  constructor(options: InMemoryRuntimeHostOptions) {
    this.#provider = options.provider;
    this.#eventLog =
      options.eventLog ?? new InMemoryRuntimeEventLog(options.eventLogOptions);
    if (
      options.maxAttempts !== undefined &&
      (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1)
    ) {
      throw new Error("maxAttempts must be a positive integer.");
    }
    this.#maxAttempts = options.maxAttempts ?? 1;
    this.#retryDelayMs = options.retryDelayMs ?? (() => 0);
    this.#wait = options.wait ?? wait;
    this.#projectorOptions = options.projectorOptions ?? {};
    this.#capabilities = {
      protocol: BUSH_RUNTIME_CAPABILITIES_PROTOCOL,
      hostId: options.hostId ?? "in-memory-runtime",
      runtimeVersion: options.runtimeVersion ?? "0.1.0",
      eventProtocol: BUSH_RUNTIME_EVENT_PROTOCOL,
      supportedEvents: runtimeEventKindSchema.options.filter((kind) =>
        [
          "turn_accepted",
          "turn_started",
          "reasoning_segment_started",
          "reasoning_segment_delta",
          "reasoning_segment_completed",
          "assistant_segment_started",
          "assistant_segment_delta",
          "assistant_segment_completed",
          "tool_queued",
          "provider_retry",
          "replay_reset",
          "turn_terminal",
        ].includes(kind),
      ),
      supportedCommands: [
        GET_RUNTIME_CAPABILITIES_COMMAND,
        RUN_MODEL_TURN_COMMAND,
      ],
      features: [
        "turn_stream",
        "reasoning_segments",
        "assistant_segments",
        "cursor_replay",
        "provider_retry",
      ],
    };
  }

  capabilities(): RuntimeCapabilities {
    return structuredClone(this.#capabilities);
  }

  events(
    sessionId: string,
    turnId: string,
    cursor: RuntimeEventCursor = {},
  ): RuntimeEvent[] {
    return this.#eventLog.replay(sessionId, turnId, cursor);
  }

  openEventStream(request: RuntimeHostStreamRequest): AsyncIterable<RuntimeEvent> {
    if (!request.turnId) {
      throw new Error("turnId is required for the in-memory Runtime stream.");
    }
    return this.#eventLog.subscribe(
      request.sessionId,
      request.turnId,
      request.cursor,
      request.signal,
    );
  }

  async sendCommand(
    command: RuntimeHostCommand,
    signal?: AbortSignal,
  ): Promise<unknown> {
    switch (command.kind) {
      case GET_RUNTIME_CAPABILITIES_COMMAND:
        return this.capabilities();
      case RUN_MODEL_TURN_COMMAND:
        return this.runModelTurn(modelRequestSchema.parse(command.payload), { signal });
      default:
        throw new Error(`Unsupported Runtime command: ${command.kind}`);
    }
  }

  async runModelTurn(
    input: ModelRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<RuntimeEvent> {
    const request = modelRequestSchema.parse(input);
    const identity: RuntimeEventIdentity = {
      requestId: request.requestId,
      sessionId: request.sessionId,
      turnId: request.turnId,
    };
    const turnKey = JSON.stringify([request.sessionId, request.turnId]);
    if (this.#activeTurns.has(turnKey)) {
      throw new Error(`Turn ${request.turnId} is already running.`);
    }
    if (this.#eventLog.replay(request.sessionId, request.turnId).length > 0) {
      throw new Error(`Turn ${request.turnId} already exists.`);
    }
    this.#activeTurns.add(turnKey);
    this.#eventLog.append(identity, {
      kind: "turn_accepted",
      payload: { status: "accepted" },
    });
    this.#eventLog.append(identity, {
      kind: "turn_started",
      payload: { status: "running" },
    });

    try {
      for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
        if (options.signal?.aborted) {
          return this.#stopped(identity);
        }
        const projector = new RuntimeEventProjector(
          this.#eventLog,
          identity,
          this.#projectorOptions,
        );
        const attemptStartSequence =
          this.#eventLog.replay(request.sessionId, request.turnId).at(-1)?.sequence ?? 0;
        let result;
        try {
          result = await executeModelRound(this.#provider, request, {
            signal: options.signal,
            onEvent: (event) => {
              if (options.signal?.aborted) {
                throw new Error("Runtime Turn was stopped.");
              }
              projector.accept(event);
            },
          });
        } catch (error) {
          projector.completeOpenSegment();
          if (options.signal?.aborted) {
            return this.#stopped(identity, projector.finalMessageId);
          }
          return this.#eventLog.append(identity, {
            kind: "turn_terminal",
            payload: {
              status: "failed",
              reason: "provider_stream_exception",
              details: {
                message: error instanceof Error ? error.message : String(error),
              },
            },
          });
        }
        projector.completeOpenSegment();

        if (result.status === "completed") {
          if (result.toolCalls.length > 0) {
            result.toolCalls.forEach((toolCall, ordinal) => {
              this.#eventLog.append(identity, {
                kind: "tool_queued",
                payload: {
                  toolCallId: toolCall.id,
                  toolName: toolCall.name,
                  ordinal,
                  assistantMessageId: projector.messageId,
                },
              });
            });
            return this.#eventLog.append(identity, {
              kind: "turn_terminal",
              payload: {
                status: "failed",
                reason: "tool_execution_not_implemented",
                finalMessageId: projector.finalMessageId,
                details: { toolCallIds: result.toolCalls.map((call) => call.id) },
              },
            });
          }
          return this.#eventLog.append(identity, {
            kind: "turn_terminal",
            payload: {
              status: "completed",
              reason: "model_response_completed",
              finalMessageId: projector.finalMessageId,
              details: { finishReason: result.finishReason ?? null },
            },
          });
        }

        if (result.error.retryable && attempt < this.#maxAttempts) {
          const supersededEventIds = this.#eventLog
            .replay(request.sessionId, request.turnId, {
              afterSequence: attemptStartSequence,
            })
            .map((event) => event.eventId);
          if (supersededEventIds.length > 0) {
            this.#eventLog.append(identity, {
              kind: "replay_reset",
              payload: {
                reason: "provider_attempt_failed",
                supersededEventIds,
              },
            });
          }
          const nextAttempt = attempt + 1;
          const nextRetryMs = Math.max(
            0,
            this.#retryDelayMs({
              nextAttempt,
              maxAttempts: this.#maxAttempts,
              code: result.error.code,
            }),
          );
          this.#eventLog.append(identity, {
            kind: "provider_retry",
            payload: {
              attempt: nextAttempt,
              maxAttempts: this.#maxAttempts,
              nextRetryMs,
              code: result.error.code,
              message: result.error.message,
            },
          });
          await this.#wait(nextRetryMs, options.signal);
          if (options.signal?.aborted) {
            return this.#stopped(identity, projector.finalMessageId);
          }
          continue;
        }

        return this.#eventLog.append(identity, {
          kind: "turn_terminal",
          payload: {
            status: "failed",
            reason: result.error.code,
            finalMessageId: projector.finalMessageId,
            details: {
              message: result.error.message,
              retryable: result.error.retryable,
              attempts: attempt,
            },
          },
        });
      }
      throw new Error("Runtime retry loop exited without a terminal event.");
    } finally {
      this.#activeTurns.delete(turnKey);
    }
  }

  #stopped(
    identity: RuntimeEventIdentity,
    finalMessageId?: string,
  ): RuntimeEvent {
    return this.#eventLog.append(identity, {
      kind: "turn_terminal",
      payload: {
        status: "stopped",
        reason: "user_stop_requested",
        finalMessageId,
        details: {},
      },
    });
  }
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted || milliseconds <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const complete = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", complete);
      resolve();
    };
    const timeout = setTimeout(complete, milliseconds);
    signal?.addEventListener("abort", complete, { once: true });
  });
}
