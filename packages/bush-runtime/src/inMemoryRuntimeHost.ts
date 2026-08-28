import {
  ANSWER_RUNTIME_PERMISSION_COMMAND,
  BUSH_RUNTIME_CAPABILITIES_PROTOCOL,
  BUSH_RUNTIME_EVENT_PROTOCOL,
  GET_RUNTIME_CAPABILITIES_COMMAND,
  modelRequestSchema,
  runtimePermissionAnswerSchema,
  runtimeEventKindSchema,
  type ModelRequest,
  type ModelMessage,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimePermissionAnswer,
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
import { RuntimeToolLoop } from "./runtimeToolLoop.js";
import { ToolRegistry } from "./toolRegistry.js";

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
  toolRegistry?: ToolRegistry;
  createPermissionId?: () => string;
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
  readonly #toolRegistry: ToolRegistry;
  readonly #createPermissionId?: () => string;
  readonly #activeTurns = new Set<string>();
  readonly #toolLoops = new Set<RuntimeToolLoop>();

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
    this.#toolRegistry = options.toolRegistry ?? new ToolRegistry();
    this.#createPermissionId = options.createPermissionId;
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
          "tool_running",
          "tool_completed",
          "tool_failed",
          "tool_cancelled",
          "permission_requested",
          "permission_answered",
          "permission_rejected",
          "permission_cancelled",
          "provider_retry",
          "replay_reset",
          "turn_terminal",
        ].includes(kind),
      ),
      supportedCommands: [
        GET_RUNTIME_CAPABILITIES_COMMAND,
        RUN_MODEL_TURN_COMMAND,
        ANSWER_RUNTIME_PERMISSION_COMMAND,
      ],
      features: [
        "turn_stream",
        "reasoning_segments",
        "assistant_segments",
        "cursor_replay",
        "provider_retry",
        "tool_execution",
        "interactive_permissions",
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
      case ANSWER_RUNTIME_PERMISSION_COMMAND:
        return this.#answerPermission(
          runtimePermissionAnswerSchema.parse(command.payload),
        );
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

    const toolLoop = new RuntimeToolLoop({
      eventLog: this.#eventLog,
      identity,
      registry: this.#toolRegistry,
      createPermissionId: this.#createPermissionId,
    });
    this.#toolLoops.add(toolLoop);

    try {
      let messages: ModelMessage[] = [...request.messages];
      let round = 0;
      while (true) {
        round += 1;
        if (options.signal?.aborted) return this.#stopped(identity);

        let completedRound:
          | Extract<
              Awaited<ReturnType<typeof executeModelRound>>,
              { status: "completed" }
            >
          | undefined;
        let completedProjector: RuntimeEventProjector | undefined;
        for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
          const projector = new RuntimeEventProjector(
            this.#eventLog,
            identity,
            this.#projectorOptions,
          );
          const attemptStartSequence =
            this.#eventLog.replay(request.sessionId, request.turnId).at(-1)
              ?.sequence ?? 0;
          let result;
          try {
            result = await executeModelRound(
              this.#provider,
              { ...request, messages },
              {
                signal: options.signal,
                onEvent: (event) => {
                  if (options.signal?.aborted) {
                    throw new Error("Runtime Turn was stopped.");
                  }
                  projector.accept(event);
                },
              },
            );
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
            completedRound = result;
            completedProjector = projector;
            break;
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
                round,
              },
            },
          });
        }
        if (!completedRound || !completedProjector) {
          throw new Error("Runtime retry loop exited without a model result.");
        }
        if (completedRound.toolCalls.length === 0) {
          return this.#eventLog.append(identity, {
            kind: "turn_terminal",
            payload: {
              status: "completed",
              reason: "model_response_completed",
              finalMessageId: completedProjector.finalMessageId,
              details: {
                finishReason: completedRound.finishReason ?? null,
                rounds: round,
              },
            },
          });
        }

        const toolMessages = await toolLoop.execute(completedRound.toolCalls, {
          round,
          assistantMessageId: completedProjector.messageId,
          signal: options.signal,
        });
        messages = [
          ...messages,
          {
            role: "assistant",
            content: completedRound.text,
            toolCalls: completedRound.toolCalls.map((call) => ({
              id: call.id,
              name: call.name,
              argumentsText: call.argumentsText,
            })),
          },
          ...toolMessages,
        ];
      }
    } finally {
      this.#toolLoops.delete(toolLoop);
      this.#activeTurns.delete(turnKey);
    }
  }

  #answerPermission(answer: RuntimePermissionAnswer): RuntimePermissionAnswer {
    const matches = [...this.#toolLoops].filter((toolLoop) =>
      toolLoop.hasPendingPermission(answer.permissionId),
    );
    if (matches.length > 1) {
      throw new Error(
        `Permission ${answer.permissionId} is ambiguous across active Turns.`,
      );
    }
    if (matches.length === 1) return matches[0].answerPermission(answer);
    throw new Error(`Permission ${answer.permissionId} is not pending.`);
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
