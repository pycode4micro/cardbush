import {
  ANSWER_RUNTIME_PERMISSION_COMMAND,
  APPLY_RUNTIME_TEAM_SNAPSHOT_COMMAND,
  ASSEMBLE_RUNTIME_SESSION_CONTEXT_COMMAND,
  BUSH_RUNTIME_CAPABILITIES_PROTOCOL,
  BUSH_RUNTIME_EVENT_PROTOCOL,
  GET_RUNTIME_CAPABILITIES_COMMAND,
  GET_RUNTIME_GOAL_COMMAND,
  GET_RUNTIME_PLAN_COMMAND,
  GET_RUNTIME_TOOL_CATALOG_COMMAND,
  GET_RUNTIME_TEAM_SNAPSHOT_COMMAND,
  GET_RUNTIME_SUBAGENT_TASK_COMMAND,
  GET_RUNTIME_SESSION_COMMAND,
  GET_RUNTIME_TOOL_EXECUTION_COMMAND,
  INSPECT_RUNTIME_RECOVERY_COMMAND,
  RESUME_MODEL_TURN_COMMAND,
  RUN_RUNTIME_SESSION_TURN_COMMAND,
  LIST_RUNTIME_TURN_TOOL_EXECUTIONS_COMMAND,
  LIST_RUNTIME_SUBAGENT_TASKS_COMMAND,
  CREATE_RUNTIME_GOAL_COMMAND,
  SET_RUNTIME_PLAN_COMMAND,
  UPDATE_RUNTIME_GOAL_COMMAND,
  assembleRuntimeSessionContextRequestSchema,
  createRuntimeGoalRequestSchema,
  modelRequestSchema,
  runtimePermissionAnswerSchema,
  runtimeCoordinationSessionSchema,
  runtimeSessionIdentitySchema,
  runtimeSessionTurnRequestSchema,
  toolExecutionIdentitySchema,
  turnToolExecutionsIdentitySchema,
  runtimeEventKindSchema,
  runtimeTurnIdentitySchema,
  setRuntimePlanRequestSchema,
  subagentTaskIdentitySchema,
  subagentTaskListRequestSchema,
  teamSnapshotSchema,
  updateRuntimeGoalRequestSchema,
  type ModelRequest,
  type ModelMessage,
  type CacheChainState,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimePermissionAnswer,
  type RuntimeSessionCommitCheckpoint,
  type RuntimeSessionTurnRequest,
} from "@cardbush/bush-protocol";

import { executeModelRound } from "./modelRound.js";
import { CacheChainTracker } from "./cacheChainTracker.js";
import { CoordinationStore } from "./coordinationStore.js";
import { registerCoordinationTools } from "./coordinationTools.js";
import { registerSubagentTool } from "./subagentTool.js";
import { SubagentTaskStore } from "./subagentTaskStore.js";
import { TeamSnapshotStore } from "./teamSnapshotStore.js";
import { registerTeamTool } from "./teamTool.js";
import { registerWorkspaceTools, WorkspaceObservationStore } from "./workspaceTools.js";
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
import {
  InMemoryRuntimeCheckpointStore,
  type RuntimeCheckpointStore,
} from "./runtimeCheckpointStore.js";
import { RuntimeRecoveryCoordinator } from "./runtimeRecoveryCoordinator.js";
import { SessionStore } from "./sessionStore.js";
import { ToolExecutionStore } from "./toolExecutionStore.js";
import {
  RuntimeSessionCoordinator,
  type GeneratedMessageFact,
  type TurnFinalizedObserver,
  type TurnTerminalPayload,
} from "./runtimeSessionCoordinator.js";

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
  checkpointStore?: RuntimeCheckpointStore;
  checkpointNow?: () => string;
  onRecoveryError?: (error: Error) => void;
  durableRecovery?: boolean;
  sessionStore?: SessionStore;
  durableSessions?: boolean;
  sessionNow?: () => string;
  toolExecutionStore?: ToolExecutionStore;
  coordinationStore?: CoordinationStore;
  durableCoordination?: boolean;
  subagentTaskStore?: SubagentTaskStore;
  teamSnapshotStore?: TeamSnapshotStore;
  durableSubagentTasks?: boolean;
  workspaceObservationStore?: WorkspaceObservationStore;
  registerDefaultWorkspaceTools?: boolean;
  additionalSupportedCommands?: string[];
  additionalFeatures?: string[];
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
  readonly #recovery: RuntimeRecoveryCoordinator;
  readonly #sessions: RuntimeSessionCoordinator;
  readonly #sessionNow: () => string;
  readonly #toolExecutions: ToolExecutionStore;
  readonly #coordination: CoordinationStore;
  readonly #subagentTasks: SubagentTaskStore;
  readonly #teams: TeamSnapshotStore;
  readonly #workspaceObservations: WorkspaceObservationStore;
  readonly #onRecoveryError?: (error: Error) => void;
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
    this.#recovery = new RuntimeRecoveryCoordinator({
      eventLog: this.#eventLog,
      checkpoints: options.checkpointStore ?? new InMemoryRuntimeCheckpointStore(),
      now: options.checkpointNow,
    });
    this.#sessionNow = options.sessionNow ?? (() => new Date().toISOString());
    this.#sessions = new RuntimeSessionCoordinator({
      store: options.sessionStore,
      now: this.#sessionNow,
    });
    this.#toolExecutions = options.toolExecutionStore ?? new ToolExecutionStore();
    this.#coordination = options.coordinationStore ?? new CoordinationStore();
    registerCoordinationTools(this.#toolRegistry, this.#coordination);
    this.#workspaceObservations =
      options.workspaceObservationStore ?? new WorkspaceObservationStore();
    if (options.registerDefaultWorkspaceTools !== false) {
      registerWorkspaceTools(this.#toolRegistry, this.#workspaceObservations);
    }
    this.#subagentTasks = options.subagentTaskStore ?? new SubagentTaskStore();
    registerSubagentTool(
      this.#toolRegistry,
      this.#subagentTasks,
      async (request, signal) => {
        const terminal = await this.runSessionTurn(request, { signal });
        return {
          terminal,
          session: this.#sessions.snapshot(request.sessionId),
        };
      },
    );
    this.#teams = options.teamSnapshotStore ?? new TeamSnapshotStore({
      canApply: () => !this.hasActiveTurns(),
    });
    registerTeamTool(
      this.#toolRegistry,
      this.#teams,
      this.#subagentTasks,
      async (request, signal) => {
        const terminal = await this.runSessionTurn(request, { signal });
        return {
          terminal,
          session: this.#sessions.snapshot(request.sessionId),
        };
      },
    );
    this.#onRecoveryError = options.onRecoveryError;
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
          "cache_chain_observed",
          "provider_retry",
          "replay_reset",
          "stream_resumed",
          "turn_terminal",
        ].includes(kind),
      ),
      supportedCommands: [
        GET_RUNTIME_CAPABILITIES_COMMAND,
        RUN_MODEL_TURN_COMMAND,
        ANSWER_RUNTIME_PERMISSION_COMMAND,
        INSPECT_RUNTIME_RECOVERY_COMMAND,
        RESUME_MODEL_TURN_COMMAND,
        GET_RUNTIME_SESSION_COMMAND,
        ASSEMBLE_RUNTIME_SESSION_CONTEXT_COMMAND,
        RUN_RUNTIME_SESSION_TURN_COMMAND,
        GET_RUNTIME_TOOL_EXECUTION_COMMAND,
        LIST_RUNTIME_TURN_TOOL_EXECUTIONS_COMMAND,
        GET_RUNTIME_TOOL_CATALOG_COMMAND,
        GET_RUNTIME_SUBAGENT_TASK_COMMAND,
        LIST_RUNTIME_SUBAGENT_TASKS_COMMAND,
        APPLY_RUNTIME_TEAM_SNAPSHOT_COMMAND,
        GET_RUNTIME_TEAM_SNAPSHOT_COMMAND,
        GET_RUNTIME_PLAN_COMMAND,
        SET_RUNTIME_PLAN_COMMAND,
        GET_RUNTIME_GOAL_COMMAND,
        CREATE_RUNTIME_GOAL_COMMAND,
        UPDATE_RUNTIME_GOAL_COMMAND,
        ...(options.additionalSupportedCommands ?? []),
      ],
      features: [
        "turn_stream",
        "reasoning_segments",
        "assistant_segments",
        "cursor_replay",
        "provider_retry",
        "tool_execution",
        "interactive_permissions",
        "checkpoint_recovery",
        "cache_chain_observation",
        ...(options.durableRecovery ? ["durable_restart_recovery"] : []),
        "append_only_session_context",
        ...(options.durableSessions ? ["durable_sessions"] : []),
        "authoritative_tool_execution_records",
        "explicit_plan_facts",
        "explicit_goal_facts",
        ...(options.durableCoordination ? ["durable_coordination"] : []),
        "subagent_context_fork",
        "product_team_snapshot",
        "team_concurrent_execution",
        ...(options.durableSubagentTasks ? ["durable_subagent_tasks"] : []),
        ...(options.additionalFeatures ?? []),
      ],
    };
  }

  capabilities(): RuntimeCapabilities {
    return structuredClone(this.#capabilities);
  }

  hasActiveTurns(): boolean {
    return this.#activeTurns.size > 0;
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
      case GET_RUNTIME_SESSION_COMMAND: {
        const identity = runtimeSessionIdentitySchema.parse(command.payload);
        return this.#sessions.snapshot(identity.sessionId) ?? null;
      }
      case ASSEMBLE_RUNTIME_SESSION_CONTEXT_COMMAND: {
        const input = assembleRuntimeSessionContextRequestSchema.parse(command.payload);
        return this.#sessions.assemble({
          sessionId: input.sessionId,
          prefix: input.prefixMessages,
          current: input.currentMessages,
          throughTurnSequence: input.throughTurnSequence,
        });
      }
      case RUN_RUNTIME_SESSION_TURN_COMMAND:
        return this.runSessionTurn(
          runtimeSessionTurnRequestSchema.parse(command.payload),
          { signal },
        );
      case GET_RUNTIME_TOOL_EXECUTION_COMMAND: {
        const identity = toolExecutionIdentitySchema.parse(command.payload);
        return this.#toolExecutions.get(
          identity.sessionId,
          identity.turnId,
          identity.toolCallId,
        ) ?? null;
      }
      case LIST_RUNTIME_TURN_TOOL_EXECUTIONS_COMMAND: {
        const identity = turnToolExecutionsIdentitySchema.parse(command.payload);
        return this.#toolExecutions.listTurn(identity.sessionId, identity.turnId);
      }
      case GET_RUNTIME_TOOL_CATALOG_COMMAND:
        return this.#toolRegistry.definitions();
      case GET_RUNTIME_SUBAGENT_TASK_COMMAND: {
        const identity = subagentTaskIdentitySchema.parse(command.payload);
        return this.#subagentTasks.get(identity.parentSessionId, identity.taskId) ?? null;
      }
      case LIST_RUNTIME_SUBAGENT_TASKS_COMMAND: {
        const input = subagentTaskListRequestSchema.parse(command.payload);
        return this.#subagentTasks.list(input.parentSessionId, input.parentTurnId);
      }
      case APPLY_RUNTIME_TEAM_SNAPSHOT_COMMAND:
        return this.#teams.apply(teamSnapshotSchema.parse(command.payload));
      case GET_RUNTIME_TEAM_SNAPSHOT_COMMAND:
        return this.#teams.result() ?? null;
      case GET_RUNTIME_PLAN_COMMAND: {
        const identity = runtimeCoordinationSessionSchema.parse(command.payload);
        return this.#coordination.getPlan(identity.sessionId) ?? null;
      }
      case SET_RUNTIME_PLAN_COMMAND:
        return this.#coordination.setPlan(setRuntimePlanRequestSchema.parse(command.payload));
      case GET_RUNTIME_GOAL_COMMAND: {
        const identity = runtimeCoordinationSessionSchema.parse(command.payload);
        return this.#coordination.getGoal(identity.sessionId) ?? null;
      }
      case CREATE_RUNTIME_GOAL_COMMAND:
        return this.#coordination.createGoal(
          createRuntimeGoalRequestSchema.parse(command.payload),
        );
      case UPDATE_RUNTIME_GOAL_COMMAND:
        return this.#coordination.updateGoal(
          updateRuntimeGoalRequestSchema.parse(command.payload),
        );
      case ANSWER_RUNTIME_PERMISSION_COMMAND:
        return this.#answerPermission(
          runtimePermissionAnswerSchema.parse(command.payload),
        );
      case INSPECT_RUNTIME_RECOVERY_COMMAND: {
        const identity = runtimeTurnIdentitySchema.parse(command.payload);
        return this.#recovery.inspect(identity.sessionId, identity.turnId);
      }
      case RESUME_MODEL_TURN_COMMAND: {
        const identity = runtimeTurnIdentitySchema.parse(command.payload);
        return this.resumeModelTurn(identity.sessionId, identity.turnId, { signal });
      }
      default:
        throw new Error(`Unsupported Runtime command: ${command.kind}`);
    }
  }

  async runModelTurn(
    input: ModelRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<RuntimeEvent> {
    return this.#runModelTurn(input, options);
  }

  async runSessionTurn(
    input: RuntimeSessionTurnRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<RuntimeEvent> {
    const prepared = this.#sessions.prepare(
      runtimeSessionTurnRequestSchema.parse(input),
    );
    try {
      return await this.#runModelTurn(prepared.modelRequest, {
        signal: options.signal,
        sessionCommit: prepared.sessionCommit,
      });
    } catch (error) {
      this.#sessions.abandon(input.sessionId, input.turnId);
      throw error;
    }
  }

  async #runModelTurn(
    input: ModelRequest,
    options: {
      signal?: AbortSignal;
      onFinalized?: TurnFinalizedObserver;
      sessionCommit?: RuntimeSessionCommitCheckpoint;
    } = {},
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
    try {
      this.#eventLog.append(identity, {
        kind: "turn_accepted",
        payload: { status: "accepted" },
      });
      this.#eventLog.append(identity, {
        kind: "turn_started",
        payload: { status: "running" },
      });
      this.#recovery.save({
        request,
        messages: request.messages,
        nextRound: 1,
        completedReceiptIds: [],
        cacheChainState: new CacheChainTracker().snapshot(),
        sessionCommit: options.sessionCommit,
      });
    } catch (error) {
      this.#activeTurns.delete(turnKey);
      throw error;
    }
    return this.#continueModelTurn({
      request,
      identity,
      messages: request.messages,
      nextRound: 1,
      completedReceiptIds: [],
      cacheChainState: new CacheChainTracker().snapshot(),
      signal: options.signal,
      sessionCommit: options.sessionCommit,
      onFinalized:
        options.onFinalized ??
        (options.sessionCommit
          ? this.#sessions.finalizer(request, options.sessionCommit)
          : undefined),
    });
  }

  async resumeModelTurn(
    sessionId: string,
    turnId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<RuntimeEvent> {
    const turnKey = JSON.stringify([sessionId, turnId]);
    if (this.#activeTurns.has(turnKey)) {
      throw new Error(`Turn ${turnId} is already running.`);
    }
    this.#activeTurns.add(turnKey);
    let recovery;
    try {
      recovery = this.#recovery.prepareResume(sessionId, turnId);
    } catch (error) {
      this.#activeTurns.delete(turnKey);
      throw error;
    }
    return this.#continueModelTurn({
      request: recovery.checkpoint.request,
      identity: recovery.identity,
      messages: recovery.checkpoint.request.messages,
      nextRound: recovery.nextRound,
      completedReceiptIds: recovery.checkpoint.completedReceiptIds,
      cacheChainState: recovery.checkpoint.cacheChainState,
      signal: options.signal,
      sessionCommit: recovery.checkpoint.sessionCommit,
      onFinalized: recovery.checkpoint.sessionCommit
        ? this.#sessions.finalizer(
            recovery.checkpoint.request,
            recovery.checkpoint.sessionCommit,
          )
        : undefined,
    });
  }

  async #continueModelTurn(input: {
    request: ModelRequest;
    identity: RuntimeEventIdentity;
    messages: ModelMessage[];
    nextRound: number;
    completedReceiptIds: string[];
    cacheChainState: CacheChainState;
    signal?: AbortSignal;
    onFinalized?: TurnFinalizedObserver;
    sessionCommit?: RuntimeSessionCommitCheckpoint;
  }): Promise<RuntimeEvent> {
    const { request, identity } = input;
    const turnKey = JSON.stringify([request.sessionId, request.turnId]);
    const toolLoop = new RuntimeToolLoop({
      eventLog: this.#eventLog,
      identity,
      registry: this.#toolRegistry,
      createPermissionId: this.#createPermissionId,
      existingReceiptIds: input.completedReceiptIds,
      executionStore: this.#toolExecutions,
    });
    this.#toolLoops.add(toolLoop);
    let messages: ModelMessage[] = [...input.messages];
    let completedReceiptIds = [...input.completedReceiptIds];
    let round = input.nextRound - 1;
    const cacheChain = new CacheChainTracker(input.cacheChainState);
    const generatedMessages: GeneratedMessageFact[] = input.sessionCommit
      ? structuredClone(input.sessionCommit.generatedMessages)
      : [];
    const usage: {
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
    } = input.sessionCommit ? { ...input.sessionCommit.usage } : {};
    const finalize = (payload: TurnTerminalPayload): RuntimeEvent => {
      input.onFinalized?.(payload, generatedMessages, usage);
      return this.#finishTurn(identity, payload);
    };
    const stop = (finalMessageId?: string): RuntimeEvent =>
      finalize({
        status: "stopped",
        reason: "user_stop_requested",
        finalMessageId,
        details: {},
      });
    try {
      while (true) {
        round += 1;
        if (input.signal?.aborted) return stop();

        let completedRound:
          | Extract<
              Awaited<ReturnType<typeof executeModelRound>>,
              { status: "completed" }
            >
          | undefined;
        let completedProjector: RuntimeEventProjector | undefined;
        for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
          const roundRequest = { ...request, messages };
          const cacheObservation = cacheChain.observe(roundRequest);
          this.#eventLog.append(identity, {
            kind: "cache_chain_observed",
            payload: cacheObservation,
          });
          this.#recovery.save({
            request,
            messages,
            nextRound: round,
            completedReceiptIds,
            cacheChainState: cacheChain.snapshot(),
            sessionCommit: input.sessionCommit
              ? { ...input.sessionCommit, generatedMessages, usage }
              : undefined,
          });
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
              roundRequest,
              {
                signal: input.signal,
                onEvent: (event) => {
                  if (input.signal?.aborted) {
                    throw new Error("Runtime Turn was stopped.");
                  }
                  projector.accept(event);
                },
              },
            );
          } catch (error) {
            projector.completeOpenSegment();
            if (input.signal?.aborted) {
              return stop(projector.finalMessageId);
            }
            return finalize({
              status: "failed",
              reason: "provider_stream_exception",
              details: {
                message: error instanceof Error ? error.message : String(error),
              },
            });
          }
          projector.completeOpenSegment();
          mergeUsage(usage, result.usage);
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
            await this.#wait(nextRetryMs, input.signal);
            if (input.signal?.aborted) {
              return stop(projector.finalMessageId);
            }
            continue;
          }
          return finalize({
            status: "failed",
            reason: result.error.code,
            finalMessageId: projector.finalMessageId,
            details: {
              message: result.error.message,
              retryable: result.error.retryable,
              attempts: attempt,
              round,
            },
          });
        }
        if (!completedRound || !completedProjector) {
          throw new Error("Runtime retry loop exited without a model result.");
        }
        if (completedRound.toolCalls.length === 0) {
          if (completedRound.text) {
            generatedMessages.push({
              messageId: completedProjector.messageId,
              createdAt: this.#sessionNow(),
              message: {
                role: "assistant",
                content: completedRound.text,
                toolCalls: [],
              },
            });
          }
          return finalize({
            status: "completed",
            reason: "model_response_completed",
            finalMessageId: completedProjector.finalMessageId,
            details: {
              finishReason: completedRound.finishReason ?? null,
              rounds: round,
            },
          });
        }

        const toolRound = await toolLoop.execute(completedRound.toolCalls, {
          round,
          assistantMessageId: completedProjector.messageId,
          signal: input.signal,
          request,
          contextMessages: messages,
        });
        const assistantMessage: ModelMessage = {
          role: "assistant",
          content: completedRound.text,
          toolCalls: completedRound.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            argumentsText: call.argumentsText,
          })),
        };
        messages = [
          ...messages,
          assistantMessage,
          ...toolRound.messages,
        ];
        generatedMessages.push({
          messageId: completedProjector.messageId,
          createdAt: this.#sessionNow(),
          message: assistantMessage,
        });
        toolRound.messages.forEach((message, index) => {
          generatedMessages.push({
            messageId:
              message.role === "tool"
                ? `msg_tool_${request.turnId}_${round}_${index}_${message.toolCallId}`
                : `msg_guidance_${request.turnId}_${round}_${index}`,
            createdAt: this.#sessionNow(),
            message,
          });
        });
        completedReceiptIds = [
          ...new Set([...completedReceiptIds, ...toolRound.receiptIds]),
        ];
        this.#recovery.save({
          request,
          messages,
          nextRound: round + 1,
          completedReceiptIds,
          cacheChainState: cacheChain.snapshot(),
          sessionCommit: input.sessionCommit
            ? { ...input.sessionCommit, generatedMessages, usage }
            : undefined,
        });
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

  #finishTurn(
    identity: RuntimeEventIdentity,
    payload: Extract<RuntimeEvent, { kind: "turn_terminal" }>["payload"],
  ): RuntimeEvent {
    const terminal = this.#eventLog.append(identity, {
      kind: "turn_terminal",
      payload,
    });
    try {
      this.#recovery.remove(identity.sessionId, identity.turnId);
    } catch (error) {
      this.#onRecoveryError?.(
        error instanceof Error ? error : new Error(String(error)),
      );
    }
    return terminal;
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

function mergeUsage(
  target: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number },
  source: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number },
): void {
  for (const key of ["inputTokens", "outputTokens", "cachedInputTokens"] as const) {
    if (source[key] !== undefined) target[key] = (target[key] ?? 0) + source[key];
  }
}
