import {
  ANSWER_RUNTIME_PERMISSION_COMMAND,
  ENQUEUE_RUNTIME_GUIDANCE_COMMAND,
  APPLY_RUNTIME_TEAM_SNAPSHOT_COMMAND,
  ASSEMBLE_RUNTIME_SESSION_CONTEXT_COMMAND,
  BUSH_RUNTIME_CAPABILITIES_PROTOCOL,
  BUSH_RUNTIME_EVENT_PROTOCOL,
  GET_RUNTIME_CAPABILITIES_COMMAND,
  GET_RUNTIME_GOAL_COMMAND,
  GET_RUNTIME_PLAN_COMMAND,
  GET_RUNTIME_TOOL_CATALOG_COMMAND,
  GET_RUNTIME_TOOL_CATALOG_DETAILS_COMMAND,
  GET_RUNTIME_TEAM_SNAPSHOT_COMMAND,
  GET_RUNTIME_SUBAGENT_TASK_COMMAND,
  GET_RUNTIME_SESSION_COMMAND,
  LIST_RUNTIME_SESSIONS_COMMAND,
  LIST_RUNTIME_TURN_CONTEXT_COMPACTIONS_COMMAND,
  UPDATE_RUNTIME_SESSION_METADATA_COMMAND,
  GET_RUNTIME_TOOL_EXECUTION_COMMAND,
  INSPECT_RUNTIME_RECOVERY_COMMAND,
  RESUME_MODEL_TURN_COMMAND,
  RUN_MODEL_TURN_COMMAND,
  RUN_RUNTIME_SESSION_TURN_COMMAND,
  SHUTDOWN_RUNTIME_COMMAND,
  STOP_RUNTIME_TURN_COMMAND,
  CANCEL_RUNTIME_TOOL_COMMAND,
  BUSH_RUNTIME_STOP_RECEIPT_PROTOCOL,
  BUSH_RUNTIME_TOOL_CANCEL_RECEIPT_PROTOCOL,
  LIST_RUNTIME_TURN_TOOL_EXECUTIONS_COMMAND,
  LIST_RUNTIME_SUBAGENT_TASKS_COMMAND,
  CREATE_RUNTIME_GOAL_COMMAND,
  CREATE_RUNTIME_SESSION_COMMAND,
  DELETE_RUNTIME_SESSION_COMMAND,
  SET_RUNTIME_PLAN_COMMAND,
  SUPERSEDE_RUNTIME_SESSION_MESSAGES_COMMAND,
  UPDATE_RUNTIME_GOAL_COMMAND,
  assembleRuntimeSessionContextRequestSchema,
  createRuntimeGoalRequestSchema,
  createRuntimeSessionRequestSchema,
  modelRequestSchema,
  runtimePermissionAnswerSchema,
  runtimeGuidanceRequestSchema,
  runtimeCoordinationSessionSchema,
  runtimeSessionIdentitySchema,
  runtimeSessionReadRequestSchema,
  runtimeSessionListRequestSchema,
  runtimeSessionTurnRequestSchema,
  toolExecutionIdentitySchema,
  turnToolExecutionsRequestSchema,
  runtimeEventKindSchema,
  runtimeTurnIdentitySchema,
  runtimeToolCancellationIdentitySchema,
  setRuntimePlanRequestSchema,
  subagentTaskIdentitySchema,
  subagentTaskListRequestSchema,
  teamSnapshotSchema,
  updateRuntimeGoalRequestSchema,
  updateRuntimeSessionMetadataRequestSchema,
  supersedeRuntimeSessionMessagesRequestSchema,
  REVERT_RUNTIME_WORKSPACE_CHANGES_COMMAND,
  RECORD_RUNTIME_LOGIC_FEEDBACK_COMMAND,
  RUNTIME_REVERTED_WORKSPACE_CHANGE_IDS_METADATA_KEY,
  revertRuntimeWorkspaceChangesSchema,
  runtimeLogicFeedbackRequestSchema,
  type ModelRequest,
  type ModelMessage,
  type ModelProviderState,
  type CacheChainState,
  type RuntimeCapabilities,
  type RuntimeContextCompactionEvent,
  type RuntimeEvent,
  type RuntimePermissionAnswer,
  type RuntimeSessionCommitCheckpoint,
  type RuntimeSessionTurnRequest,
  type SessionSnapshot,
  type TurnContextCheckpoint,
  type ToolExecutionRecord,
  type WorkspaceChange,
} from "@cardbush/bush-protocol";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import { executeModelRound } from "./modelRound.js";
import { abortError, settleAtAbort } from "./abortSettlement.js";
import {
  DEFAULT_SUBAGENT_PERMISSION_POLICY,
  type SubagentPermissionPolicy,
} from "./childTurn.js";
import { CacheChainTracker } from "./cacheChainTracker.js";
import {
  CHECKPOINT_CONTEXT_TOOL,
  CONTEXT_COMPACTION_HARD_PRESSURE,
  CONTEXT_SUMMARY_FALLBACK_TURNS,
  ContextCheckpointInputError,
  bindContextCheckpointInput,
  contextCheckpointFailure,
  contextToolIngressTokenBudget,
  contextPressureNotice,
  estimateContextPressure,
  projectContextCompactionMaintenanceMessages,
  registerContextCompactionTool,
  requiresContextCompactionBeforeRound,
  resolveContextOutputTokens,
  type ContextCheckpointInput,
  type ContextCompactionState,
  type ContextPressure,
} from "./contextCompaction.js";
import { projectActiveTurnContext } from "./contextAssembler.js";

import { CoordinationStore } from "./coordinationStore.js";
import { registerCoordinationTools } from "./coordinationTools.js";
import { registerInteractionTools } from "./interactionTools.js";
import { registerExtendedBuiltins } from "./extendedBuiltins.js";
import { LogicMemoryStore } from "./logicMemory.js";
import { ModelImageStore } from "./modelImageStore.js";
import {
  registerSubagentTool,
  type JoinedSubagentResult,
} from "./subagentTool.js";
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
import { InMemoryRuntimeCapabilityStore } from "./runtimeCapabilityStore.js";
import { SessionStore } from "./sessionStore.js";
import { ToolExecutionStore } from "./toolExecutionStore.js";
import {
  RuntimeSessionCoordinator,
  type GeneratedMessageFact,
  type TurnFinalizedObserver,
  type TurnTerminalPayload,
} from "./runtimeSessionCoordinator.js";

export interface RuntimeRetryContext {
  nextAttempt: number;
  maxAttempts: number | null;
  code: string;
  retryAfterMs?: number;
}

export interface InMemoryRuntimeHostOptions {
  provider: ModelProvider;
  hostId?: string;
  runtimeVersion?: string;
  /** null keeps retryable provider requests alive until Stop; omitted defaults to one attempt. */
  maxAttempts?: number | null;
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
  subagentPermissionPolicy?: SubagentPermissionPolicy;
  settleOrphanedTurns?: boolean;
  workspaceObservationStore?: WorkspaceObservationStore;
  registerDefaultWorkspaceTools?: boolean;
  additionalSupportedCommands?: string[];
  additionalFeatures?: string[];
  dataRoot?: string;
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

function logicIdsFromExecutions(records: ToolExecutionRecord[]): string[] {
  const ids = new Set<string>();
  for (const record of records) {
    if (record.outcome !== "returned") continue;
    const output = recordOutput(record.result);
    if (record.toolCall.name === "consult_logic" && Array.isArray(output.matched_logic)) {
      for (const candidate of output.matched_logic) {
        if (!candidate || typeof candidate !== "object") continue;
        const logicId = String((candidate as Record<string, unknown>).logic_id ?? "").trim();
        if (logicId) ids.add(logicId);
      }
    }
    if (
      record.toolCall.name === "learn_logic" &&
      String(output.status ?? "") === "learned"
    ) {
      const logicId = String(output.logic_id ?? "").trim();
      if (logicId) ids.add(logicId);
    }
  }
  return [...ids];
}

function recordOutput(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

interface PendingAgentGuidance {
  taskId: string;
  promise: Promise<JoinedSubagentResult["message"]>;
  settled: boolean;
  message?: JoinedSubagentResult["message"];
}

class ProviderInputTokenCountError extends Error {
  constructor(readonly original: unknown) {
    super(original instanceof Error ? original.message : String(original));
    this.name = "ProviderInputTokenCountError";
  }
}

type SettledAgentGuidance = JoinedSubagentResult;

export class InMemoryRuntimeHost {
  readonly #provider: ModelProvider;
  readonly #eventLog: InMemoryRuntimeEventLog;
  readonly #capabilities: RuntimeCapabilities;
  readonly #maxAttempts: number | null;
  readonly #retryDelayMs: (context: RuntimeRetryContext) => number;
  readonly #wait: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  readonly #projectorOptions: RuntimeEventProjectorOptions;
  readonly #toolRegistry: ToolRegistry;
  readonly #createPermissionId?: () => string;
  readonly #recovery: RuntimeRecoveryCoordinator;
  readonly #sessions: RuntimeSessionCoordinator;
  readonly #sessionNow: () => string;
  readonly #toolExecutions: ToolExecutionStore;
  readonly #capabilityGrants = new InMemoryRuntimeCapabilityStore();
  readonly #coordination: CoordinationStore;
  readonly #subagentTasks: SubagentTaskStore;
  readonly #teams: TeamSnapshotStore;
  readonly #workspaceObservations: WorkspaceObservationStore;
  readonly #onRecoveryError?: (error: Error) => void;
  readonly #activeTurns = new Set<string>();
  readonly #activeTurnControllers = new Map<string, AbortController>();
  readonly #toolLoops = new Set<RuntimeToolLoop>();
  readonly #logicMemory: LogicMemoryStore;
  readonly #modelImages: ModelImageStore;
  readonly #guidanceQueues = new Map<string, Array<{
    messageId: string;
    content: string;
    createdAt: string;
  }>>();
  readonly #pendingAgentGuidance = new Map<string, PendingAgentGuidance[]>();
  readonly #contextCompactionAuthorizations = new Map<string, ContextCompactionState>();
  #shuttingDown = false;

  constructor(options: InMemoryRuntimeHostOptions) {
    this.#provider = options.provider;
    this.#eventLog =
      options.eventLog ?? new InMemoryRuntimeEventLog(options.eventLogOptions);
    if (
      options.maxAttempts !== undefined &&
      options.maxAttempts !== null &&
      (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1)
    ) {
      throw new Error("maxAttempts must be a positive integer or null.");
    }
    this.#maxAttempts = options.maxAttempts === undefined ? 1 : options.maxAttempts;
    this.#retryDelayMs = options.retryDelayMs ?? defaultRuntimeRetryDelayMs;
    this.#wait = options.wait ?? wait;
    this.#projectorOptions = options.projectorOptions ?? {};
    this.#toolRegistry = options.toolRegistry ?? new ToolRegistry();
    this.#toolExecutions = options.toolExecutionStore ?? new ToolExecutionStore();
    registerInteractionTools(this.#toolRegistry);
    const runtimeDataRoot = resolve(
      options.dataRoot || join(process.cwd(), ".cardbush-runtime"),
    );
    this.#logicMemory = new LogicMemoryStore(join(runtimeDataRoot, "lem", "logic.json"));
    this.#modelImages = new ModelImageStore(runtimeDataRoot);
    registerExtendedBuiltins(this.#toolRegistry, {
      dataRoot: options.dataRoot,
      readToolResult: (locator) => this.#readArchivedToolResult(locator),
      logicMemory: this.#logicMemory,
      modelImages: this.#modelImages,
    });
    this.#createPermissionId = options.createPermissionId;
    this.#recovery = new RuntimeRecoveryCoordinator({
      eventLog: this.#eventLog,
      checkpoints: options.checkpointStore ?? new InMemoryRuntimeCheckpointStore(),
      now: options.checkpointNow,
    });
    this.#onRecoveryError = options.onRecoveryError;
    this.#sessionNow = options.sessionNow ?? (() => new Date().toISOString());
    this.#sessions = new RuntimeSessionCoordinator({
      store: options.sessionStore,
      now: this.#sessionNow,
    });
    registerContextCompactionTool(this.#toolRegistry, (input) =>
      this.#applyContextCheckpoint(input),
    );
    if (options.settleOrphanedTurns === true) this.#settleOrphanedTurns();
    this.#coordination = options.coordinationStore ?? new CoordinationStore();
    registerCoordinationTools(this.#toolRegistry, this.#coordination);
    this.#workspaceObservations =
      options.workspaceObservationStore ?? new WorkspaceObservationStore({
        persistencePath: options.dataRoot
          ? join(options.dataRoot, "project-cognition.json")
          : undefined,
      });
    if (options.registerDefaultWorkspaceTools !== false) {
      registerWorkspaceTools(this.#toolRegistry, this.#workspaceObservations);
    }
    this.#subagentTasks = options.subagentTaskStore ?? new SubagentTaskStore();
    const subagentPermissionPolicy = options.subagentPermissionPolicy ??
      DEFAULT_SUBAGENT_PERMISSION_POLICY;
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
      {
        asyncDispatch: true,
        onAsyncResult: ({ parentSessionId, parentTurnId, taskId, result }) => {
          const key = JSON.stringify([parentSessionId, parentTurnId]);
          this.#trackAgentGuidance(key, taskId, result);
        },
        awaitAsyncResults: ({ parentSessionId, parentTurnId, taskIds }) => {
          const key = JSON.stringify([parentSessionId, parentTurnId]);
          return this.#joinPendingAgentGuidance(key, taskIds);
        },
        permissionPolicy: subagentPermissionPolicy,
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
      { permissionPolicy: subagentPermissionPolicy },
    );
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
          "guidance_applied",
          "tool_queued",
          "tool_running",
          "tool_returned",
          "tool_failed",
          "tool_cancelled",
          "permission_requested",
          "permission_answered",
          "permission_rejected",
          "permission_cancelled",
          "cache_chain_observed",
          "model_request_usage",
          "context_compaction_started",
          "context_compaction_retrying",
          "context_compaction_completed",
          "context_compaction_failed",
          "context_compaction_cancelled",
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
        ENQUEUE_RUNTIME_GUIDANCE_COMMAND,
        INSPECT_RUNTIME_RECOVERY_COMMAND,
        RESUME_MODEL_TURN_COMMAND,
        GET_RUNTIME_SESSION_COMMAND,
        CREATE_RUNTIME_SESSION_COMMAND,
        DELETE_RUNTIME_SESSION_COMMAND,
        LIST_RUNTIME_SESSIONS_COMMAND,
        UPDATE_RUNTIME_SESSION_METADATA_COMMAND,
        SUPERSEDE_RUNTIME_SESSION_MESSAGES_COMMAND,
        ASSEMBLE_RUNTIME_SESSION_CONTEXT_COMMAND,
        RUN_RUNTIME_SESSION_TURN_COMMAND,
        SHUTDOWN_RUNTIME_COMMAND,
        STOP_RUNTIME_TURN_COMMAND,
        CANCEL_RUNTIME_TOOL_COMMAND,
        GET_RUNTIME_TOOL_EXECUTION_COMMAND,
        LIST_RUNTIME_TURN_TOOL_EXECUTIONS_COMMAND,
        LIST_RUNTIME_TURN_CONTEXT_COMPACTIONS_COMMAND,
        GET_RUNTIME_TOOL_CATALOG_COMMAND,
        GET_RUNTIME_TOOL_CATALOG_DETAILS_COMMAND,
        RECORD_RUNTIME_LOGIC_FEEDBACK_COMMAND,
        REVERT_RUNTIME_WORKSPACE_CHANGES_COMMAND,
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
        "targeted_tool_cancellation",
        "same_turn_guidance",
        "checkpoint_recovery",
        "cache_chain_observation",
        "cross_turn_cache_chain",
        "stopped_turn_continuation",
        ...(options.durableRecovery ? ["durable_restart_recovery"] : []),
        "append_only_session_context",
        "semantic_turn_context_compaction",
        ...(options.durableSessions ? ["durable_sessions"] : []),
        "authoritative_tool_execution_records",
        "bounded_tool_result_projection",
        "project_cognition",
        "workspace_revert",
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
        if (this.#shuttingDown) throw new Error("Runtime is shutting down.");
        return this.runModelTurn(modelRequestSchema.parse(command.payload), { signal });
      case GET_RUNTIME_SESSION_COMMAND: {
        const input = runtimeSessionReadRequestSchema.parse(command.payload);
        const snapshot = this.#sessions.snapshot(input.sessionId);
        if (!snapshot || input.messageProjection === "full") return snapshot ?? null;
        return conversationSessionSnapshot(snapshot);
      }
      case CREATE_RUNTIME_SESSION_COMMAND: {
        const input = createRuntimeSessionRequestSchema.parse(command.payload);
        return this.#sessions.create(input.sessionId, input.metadata);
      }
      case DELETE_RUNTIME_SESSION_COMMAND: {
        const identity = runtimeSessionIdentitySchema.parse(command.payload);
        return { sessionId: identity.sessionId, deleted: this.#sessions.delete(identity.sessionId) };
      }
      case LIST_RUNTIME_SESSIONS_COMMAND:
        runtimeSessionListRequestSchema.parse(command.payload);
        return this.#sessions.list();
      case UPDATE_RUNTIME_SESSION_METADATA_COMMAND:
        return this.#sessions.updateMetadata(
          updateRuntimeSessionMetadataRequestSchema.parse(command.payload),
        );
      case SUPERSEDE_RUNTIME_SESSION_MESSAGES_COMMAND:
        return this.#sessions.supersedeMessages(
          supersedeRuntimeSessionMessagesRequestSchema.parse(command.payload),
        );
      case ASSEMBLE_RUNTIME_SESSION_CONTEXT_COMMAND: {
        const input = assembleRuntimeSessionContextRequestSchema.parse(command.payload);
        return this.#sessions.assemble({
          sessionId: input.sessionId,
          prefix: input.prefixMessages,
          current: input.currentMessages,
          throughTurnSequence: input.throughTurnSequence,
          maxChars: input.maxChars,
          maxSummaryTurns: input.maxSummaryTurns,
        });
      }
      case RUN_RUNTIME_SESSION_TURN_COMMAND:
        if (this.#shuttingDown) throw new Error("Runtime is shutting down.");
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
        const input = turnToolExecutionsRequestSchema.parse(command.payload);
        return input.detail === "summary"
          ? this.#toolExecutions.listTurnSummaries(input.sessionId, input.turnId)
          : this.#toolExecutions.listTurn(input.sessionId, input.turnId);
      }
      case LIST_RUNTIME_TURN_CONTEXT_COMPACTIONS_COMMAND: {
        const input = runtimeTurnIdentitySchema.parse(command.payload);
        return effectiveContextCompactionEvents(
          this.#eventLog.replay(input.sessionId, input.turnId),
        );
      }
      case GET_RUNTIME_TOOL_CATALOG_COMMAND:
        return this.#toolRegistry.definitions();
      case GET_RUNTIME_TOOL_CATALOG_DETAILS_COMMAND:
        return this.#toolRegistry.catalog();
      case RECORD_RUNTIME_LOGIC_FEEDBACK_COMMAND:
        return this.#recordLogicFeedback(
          runtimeLogicFeedbackRequestSchema.parse(command.payload),
        );
      case REVERT_RUNTIME_WORKSPACE_CHANGES_COMMAND:
        return this.#revertWorkspaceChanges(
          revertRuntimeWorkspaceChangesSchema.parse(command.payload),
        );
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
      case ENQUEUE_RUNTIME_GUIDANCE_COMMAND: {
        const guidance = runtimeGuidanceRequestSchema.parse(command.payload);
        const key = JSON.stringify([guidance.sessionId, guidance.turnId]);
        if (!this.#activeTurns.has(key)) {
          throw new Error(`Turn ${guidance.turnId} is not accepting guidance.`);
        }
        const queue = this.#guidanceQueues.get(key) ?? [];
        if (!queue.some((entry) => entry.messageId === guidance.messageId)) {
          queue.push({
            messageId: guidance.messageId,
            content: guidance.content,
            createdAt: guidance.createdAt,
          });
          this.#guidanceQueues.set(key, queue);
        }
        return {
          protocol: guidance.protocol,
          sessionId: guidance.sessionId,
          turnId: guidance.turnId,
          messageId: guidance.messageId,
          accepted: true,
          queueDepth: queue.length,
        };
      }
      case SHUTDOWN_RUNTIME_COMMAND:
        this.#shuttingDown = true;
        for (const controller of this.#activeTurnControllers.values()) controller.abort();
        return { accepted: true, activeTurns: this.#activeTurns.size };
      case STOP_RUNTIME_TURN_COMMAND: {
        const identity = runtimeTurnIdentitySchema.parse(command.payload);
        const key = JSON.stringify([identity.sessionId, identity.turnId]);
        const terminal = this.#eventLog.replay(identity.sessionId, identity.turnId).at(-1)?.kind === "turn_terminal";
        if (terminal) return {
          protocol: BUSH_RUNTIME_STOP_RECEIPT_PROTOCOL,
          ...identity,
          accepted: false,
          terminal: true,
          reason: "turn_already_terminal",
        };
        const controller = this.#activeTurnControllers.get(key);
        if (!controller) return {
          protocol: BUSH_RUNTIME_STOP_RECEIPT_PROTOCOL,
          ...identity,
          accepted: false,
          terminal: false,
          reason: "turn_not_active",
        };
        controller.abort();
        return {
          protocol: BUSH_RUNTIME_STOP_RECEIPT_PROTOCOL,
          ...identity,
          accepted: true,
          terminal: false,
          reason: "stop_accepted",
        };
      }
      case CANCEL_RUNTIME_TOOL_COMMAND: {
        const identity = runtimeToolCancellationIdentitySchema.parse(command.payload);
        const matches = [...this.#toolLoops].filter((toolLoop) =>
          toolLoop.matches(identity.sessionId, identity.turnId)
        );
        if (matches.length > 1) {
          throw new Error(
            `Tool ${identity.toolCallId} is ambiguous across active Runtime loops.`,
          );
        }
        const accepted = matches[0]?.cancelTool(identity.toolCallId) === true;
        return {
          protocol: BUSH_RUNTIME_TOOL_CANCEL_RECEIPT_PROTOCOL,
          ...identity,
          accepted,
          reason: accepted ? "tool_cancel_accepted" : "tool_not_active",
        };
      }
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
    const candidate = runtimeSessionTurnRequestSchema.parse(input);
    if (!candidate.tools.some((tool) => tool.name === CHECKPOINT_CONTEXT_TOOL)) {
      const maintenanceTool = this.#toolRegistry.definitions().find((tool) =>
        tool.name === CHECKPOINT_CONTEXT_TOOL,
      );
      if (!maintenanceTool) {
        throw new Error("Runtime context maintenance Tool is not registered.");
      }
      candidate.tools = [...candidate.tools, maintenanceTool];
    }
    const prepared = this.#sessions.prepare(
      candidate,
    );
    try {
      return await this.#runModelTurn(prepared.modelRequest, {
        signal: options.signal,
        sessionCommit: prepared.sessionCommit,
        cacheChainState: prepared.cacheChainState,
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
      cacheChainState?: CacheChainState;
    } = {},
  ): Promise<RuntimeEvent> {
    const request = resolveModelRequestContextLimits(modelRequestSchema.parse(input));
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
    const turnController = new AbortController();
    const detachAbort = forwardAbort(options.signal, turnController);
    this.#activeTurns.add(turnKey);
    this.#activeTurnControllers.set(turnKey, turnController);
    const initialCacheChainState = options.cacheChainState ??
      new CacheChainTracker().snapshot();
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
        cacheChainState: initialCacheChainState,
        sessionCommit: options.sessionCommit,
      });
    } catch (error) {
      this.#activeTurns.delete(turnKey);
      this.#activeTurnControllers.delete(turnKey);
      detachAbort();
      throw error;
    }
    return this.#continueModelTurn({
      request,
      identity,
      messages: request.messages,
      nextRound: 1,
      cacheChainState: initialCacheChainState,
      signal: turnController.signal,
      onSettled: detachAbort,
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
    const turnController = new AbortController();
    const detachAbort = forwardAbort(options.signal, turnController);
    this.#activeTurnControllers.set(turnKey, turnController);
    let recovery;
    try {
      recovery = this.#recovery.prepareResume(sessionId, turnId);
    } catch (error) {
      this.#activeTurns.delete(turnKey);
      this.#activeTurnControllers.delete(turnKey);
      detachAbort();
      throw error;
    }
    const sessionCommit = recovery.checkpoint.sessionCommit;
    const messages = sessionCommit
      ? this.#rebuildCompactedMessages(
          sessionId,
          turnId,
          sessionCommit,
          sessionCommit.generatedMessages,
          sessionCommit.activeContextCheckpoint,
        )
      : recovery.checkpoint.request.messages;
    const request = resolveModelRequestContextLimits(modelRequestSchema.parse({
      ...recovery.checkpoint.request,
      messages,
    }));
    return this.#continueModelTurn({
      request,
      identity: recovery.identity,
      messages,
      nextRound: recovery.nextRound,
      cacheChainState: recovery.checkpoint.cacheChainState,
      signal: turnController.signal,
      onSettled: detachAbort,
      sessionCommit,
      onFinalized: sessionCommit
        ? this.#sessions.finalizer(
            request,
            sessionCommit,
          )
        : undefined,
    });
  }

  async #continueModelTurn(input: {
    request: ModelRequest;
    identity: RuntimeEventIdentity;
    messages: ModelMessage[];
    nextRound: number;
    cacheChainState: CacheChainState;
    signal?: AbortSignal;
    onSettled?: () => void;
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
      executionStore: this.#toolExecutions,
      modelImages: this.#modelImages,
      capabilities: this.#capabilityGrants,
      ...childPermissionRuntimeOptions(request, identity),
    });
    this.#toolLoops.add(toolLoop);
    let messages: ModelMessage[] = [...input.messages];
    let round = input.nextRound - 1;
    let unresolvedPlanContinuations = 0;
    let emptyStopRetries = 0;
    let contextCompactionFailures = 0;
    let contextPressureNoticeKey: string | undefined;
    // Resumed checkpoints retain their saved tool catalog and cache prefix.
    const checkpointRequiredFields = request.tools.find((tool) =>
      tool.name === CHECKPOINT_CONTEXT_TOOL)?.inputSchema.required;
    const legacyCheckpointInput = Array.isArray(checkpointRequiredFields) &&
      checkpointRequiredFields.includes("session_revision");
    let providerState: ModelProviderState = freshResponseChain();
    const cacheChain = new CacheChainTracker(input.cacheChainState);
    const generatedMessages: GeneratedMessageFact[] = input.sessionCommit
      ? structuredClone(input.sessionCommit.generatedMessages)
      : [];
    let activeContextCheckpoint: TurnContextCheckpoint | undefined = input.sessionCommit
      ?.activeContextCheckpoint
      ? structuredClone(input.sessionCommit.activeContextCheckpoint)
      : undefined;
    const previousCommittedUsage = input.sessionCommit
      ? this.#sessions.snapshot(request.sessionId)?.turns.at(-1)?.usage
      : undefined;
    const usage: {
      model?: string;
      contextWindowTokens?: number;
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      lastRequestInputTokens?: number;
      lastRequestOutputTokens?: number;
      lastRequestCachedInputTokens?: number;
    } = {
      ...(input.sessionCommit ? input.sessionCommit.usage : {}),
      model: request.model,
      ...(Number.isInteger(Number(request.metadata.contextWindowTokens)) &&
      Number(request.metadata.contextWindowTokens) > 0
        ? { contextWindowTokens: Number(request.metadata.contextWindowTokens) }
        : {}),
    };
    let fallbackTokenScale = 1;
    let appendOnlyInputFloorTokens = input.sessionCommit?.usage.lastRequestInputTokens ??
      (
        previousCommittedUsage?.model === request.model &&
        previousCommittedUsage.contextWindowTokens === usage.contextWindowTokens
          ? previousCommittedUsage.lastRequestInputTokens
          : undefined
      );
    const sessionCommitCheckpoint = (): RuntimeSessionCommitCheckpoint | undefined =>
      input.sessionCommit
        ? {
            ...input.sessionCommit,
            generatedMessages,
            usage,
            ...(activeContextCheckpoint ? { activeContextCheckpoint } : {}),
          }
        : undefined;
    const priorContextCompactionEvents = effectiveContextCompactionEvents(
      this.#eventLog.replay(request.sessionId, request.turnId),
    );
    let contextCompactionOrdinal = priorContextCompactionEvents.filter((event) =>
      event.kind === "context_compaction_started"
    ).length;
    let activeContextCompaction = pendingContextCompactionLifecycle(
      priorContextCompactionEvents,
    );
    const latestAssistantAnchor = () => {
      const item = [...generatedMessages]
        .reverse()
        .find((candidate) => candidate.message.role === "assistant");
      return item
        ? {
            assistantMessageId: item.messageId,
            assistantContentOffset: item.message.content.length,
          }
        : { assistantContentOffset: 0 };
    };
    const beginContextCompaction = (
      state: ContextCompactionState,
      pressure: ContextPressure,
    ) => {
      if (activeContextCompaction) return;
      contextCompactionOrdinal += 1;
      const assistantAnchor = latestAssistantAnchor();
      activeContextCompaction = {
        compactionId: `context_compaction:${request.turnId}:${contextCompactionOrdinal}`,
        round,
        attempt: 1,
        ...assistantAnchor,
      };
      this.#eventLog.append(identity, {
        kind: "context_compaction_started",
        payload: {
          ...activeContextCompaction,
          thresholdRatio: CONTEXT_COMPACTION_HARD_PRESSURE,
          triggerRatio: pressure.ratio,
          estimatedInputTokens: pressure.estimatedPromptTokens,
          usableInputTokens: pressure.usableInputTokens,
          measurement: pressure.measurement,
          precedingTurnCount: state.unsummarizedTurnIds.length,
          activeTurnIncluded: state.activeTurn !== undefined,
          ...(state.activeTurn
            ? { activeThroughMessageId: state.activeTurn.throughMessageId }
            : {}),
        },
      });
    };
    const retryContextCompaction = (
      reason: string,
      message: string,
      diagnostics?: Record<string, unknown>,
    ) => {
      if (!activeContextCompaction) return;
      activeContextCompaction = {
        ...activeContextCompaction,
        round,
        attempt: activeContextCompaction.attempt + 1,
      };
      this.#eventLog.append(identity, {
        kind: "context_compaction_retrying",
        payload: {
          ...activeContextCompaction,
          reason,
          message,
          ...(diagnostics ? { diagnostics } : {}),
        },
      });
    };
    const completeContextCompaction = (
      checkpoint: ContextCheckpointInput,
    ) => {
      if (!activeContextCompaction) return;
      this.#eventLog.append(identity, {
        kind: "context_compaction_completed",
        payload: {
          ...activeContextCompaction,
          round,
          summarizedTurnCount: checkpoint.summaries.length,
          activeTurnCheckpointed: checkpoint.activeTurn !== undefined,
          ...(checkpoint.activeTurn
            ? { activeThroughMessageId: checkpoint.activeTurn.throughMessageId }
            : {}),
        },
      });
      activeContextCompaction = undefined;
    };
    const settleActiveContextCompaction = (payload: TurnTerminalPayload) => {
      if (!activeContextCompaction) return;
      if (payload.status === "stopped") {
        this.#eventLog.append(identity, {
          kind: "context_compaction_cancelled",
          payload: {
            ...activeContextCompaction,
            round,
            reason: payload.reason,
          },
        });
      } else {
        this.#eventLog.append(identity, {
          kind: "context_compaction_failed",
          payload: {
            ...activeContextCompaction,
            round,
            reason: payload.reason,
            message: typeof payload.details.message === "string"
              ? payload.details.message
              : "Context compaction did not complete.",
            diagnostics: payload.details.checkpointDiagnostics as Record<string, unknown> | undefined,
          },
        });
      }
      activeContextCompaction = undefined;
    };
    const finalize = (payload: TurnTerminalPayload): RuntimeEvent => {
      if ((this.#pendingAgentGuidance.get(turnKey)?.length ?? 0) > 0) {
        this.#activeTurnControllers.get(turnKey)?.abort();
      }
      settleActiveContextCompaction(payload);
      input.onFinalized?.(
        payload,
        generatedMessages,
        usage,
        cacheChain.snapshot(),
        activeContextCheckpoint,
      );
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
        let dispatchPressure: ContextPressure | undefined;
        if (input.signal?.aborted) return stop();
        const readyAtRoundBoundary = this.#takeSettledAgentGuidance(turnKey);
        if (readyAtRoundBoundary.length > 0) {
          messages = this.#appendAgentGuidance(
            request.turnId,
            messages,
            generatedMessages,
            readyAtRoundBoundary,
          );
        }

        let contextCompactionRequired = false;
        if (input.sessionCommit) {
          let pressure = await this.#measureContextPressure(
            request,
            messages,
            providerState,
            input.signal,
            fallbackTokenScale,
            appendOnlyInputFloorTokens,
          );
          dispatchPressure = pressure;
          let state = this.#contextCompactionState(
            request.sessionId,
            request.turnId,
            generatedMessages,
            activeContextCheckpoint,
          );
          if (
            pressure &&
            requiresContextCompactionBeforeRound(pressure) &&
            (state.unsummarizedTurnIds.length > 0 || state.activeTurn !== undefined)
          ) {
            this.#contextCompactionAuthorizations.set(turnKey, state);
            contextCompactionRequired = true;
            beginContextCompaction(state, pressure);
            const noticeKey = contextCompactionStateKey(state);
            if (contextPressureNoticeKey !== noticeKey) {
              messages = [
                ...messages,
                contextPressureNotice(state, pressure, legacyCheckpointInput),
              ];
              contextPressureNoticeKey = noticeKey;
            }
          } else {
            this.#contextCompactionAuthorizations.delete(turnKey);
            if (
              state.unsummarizedTurnIds.length === 0 &&
              state.activeTurn === undefined &&
              pressure &&
              requiresContextCompactionBeforeRound(pressure)
            ) {
              let summaryLimit = Math.min(
                CONTEXT_SUMMARY_FALLBACK_TURNS,
                state.totalTurns,
              );
              do {
                appendOnlyInputFloorTokens = undefined;
                messages = this.#rebuildCompactedMessages(
                  request.sessionId,
                  request.turnId,
                  input.sessionCommit,
                  generatedMessages,
                  activeContextCheckpoint,
                  summaryLimit,
                );
                providerState = freshResponseChain();
                pressure = await this.#measureContextPressure(
                  request,
                  messages,
                  providerState,
                  input.signal,
                  fallbackTokenScale,
                  appendOnlyInputFloorTokens,
                );
                dispatchPressure = pressure;
                if (!pressure || !requiresContextCompactionBeforeRound(pressure)) break;
                summaryLimit -= 1;
              } while (summaryLimit >= 0);
              if (pressure && requiresContextCompactionBeforeRound(pressure)) {
                return finalize({
                  status: "failed",
                  reason: "current_turn_context_limit_exceeded",
                  details: {
                    estimatedPromptTokens: pressure.estimatedPromptTokens,
                    measurement: pressure.measurement,
                    usableInputTokens: pressure.usableInputTokens,
                    preservedSummaryTurns: Math.max(0, summaryLimit),
                  },
                });
              }
            }
          }
        }

        let dispatchMessages = messages;
        let dispatchProviderState = providerState;
        if (contextCompactionRequired) {
          let maintenancePressure = await this.#measureContextPressure(
            request,
            dispatchMessages,
            dispatchProviderState,
            input.signal,
            fallbackTokenScale,
            appendOnlyInputFloorTokens,
          );
          dispatchPressure = maintenancePressure;
          let acceptedOverLimitRecovery = acceptsBoundedOverLimitRecovery(
            maintenancePressure,
            appendOnlyInputFloorTokens,
          );
          while (
            maintenancePressure &&
            maintenancePressure.ratio >= 1 &&
            !acceptedOverLimitRecovery
          ) {
            const projection = projectContextCompactionMaintenanceMessages({
              messages: dispatchMessages,
              sessionId: request.sessionId,
              turnId: request.turnId,
              pressure: maintenancePressure,
            });
            if (
              projection.omittedReasoningMessages === 0 &&
              projection.compactedToolResults === 0
            ) {
              break;
            }
            dispatchMessages = projection.messages;
            dispatchProviderState = freshResponseChain();
            maintenancePressure = await this.#measureContextPressure(
              request,
              dispatchMessages,
              dispatchProviderState,
              input.signal,
              fallbackTokenScale,
              appendOnlyInputFloorTokens,
            );
            dispatchPressure = maintenancePressure;
            acceptedOverLimitRecovery = acceptsBoundedOverLimitRecovery(
              maintenancePressure,
              appendOnlyInputFloorTokens,
            );
          }
          if (
            maintenancePressure &&
            maintenancePressure.ratio >= 1 &&
            !acceptedOverLimitRecovery
          ) {
            return finalize({
              status: "failed",
              reason: "context_compaction_request_limit_exceeded",
              details: {
                inputTokens: maintenancePressure.estimatedPromptTokens,
                measurement: maintenancePressure.measurement,
                usableInputTokens: maintenancePressure.usableInputTokens,
              },
            });
          }
        }

        let completedRound:
          | Extract<
              Awaited<ReturnType<typeof executeModelRound>>,
              { status: "completed" }
            >
          | undefined;
        let completedProjector: RuntimeEventProjector | undefined;
        for (let attempt = 1; this.#maxAttempts === null || attempt <= this.#maxAttempts; attempt += 1) {
          if (input.signal?.aborted) return stop();
          const roundRequest = {
            ...request,
            messages: dispatchMessages,
            providerState: dispatchProviderState,
          };
          if (
            contextCompactionRequired &&
            !roundRequest.tools.some((tool) => tool.name === CHECKPOINT_CONTEXT_TOOL)
          ) {
            return finalize({
              status: "failed",
              reason: "context_compaction_tool_unavailable",
              details: {},
            });
          }
          const cacheObservation = cacheChain.observe(roundRequest);
          this.#eventLog.append(identity, {
            kind: "cache_chain_observed",
            payload: cacheObservation,
          });
          this.#recovery.save({
            request,
            messages,
            nextRound: round,
            cacheChainState: cacheChain.snapshot(),
            sessionCommit: sessionCommitCheckpoint(),
          });
          const projector = new RuntimeEventProjector(
            this.#eventLog,
            identity,
            this.#projectorOptions,
          );
          const attemptStartSequence =
            this.#eventLog.replay(request.sessionId, request.turnId).at(-1)
              ?.sequence ?? 0;
          const deferProviderProjection =
            this.#contextCompactionAuthorizations.has(turnKey);
          const deferredProviderEvents: Array<
            Parameters<RuntimeEventProjector["accept"]>[0]
          > = [];
          let result;
          try {
            result = await settleAtAbort(
              executeModelRound(
                this.#provider,
                roundRequest,
                {
                  signal: input.signal,
                  onEvent: (event) => {
                    if (input.signal?.aborted) {
                      throw abortError("Runtime Turn was stopped.");
                    }
                    if (deferProviderProjection) deferredProviderEvents.push(event);
                    else projector.accept(event);
                  },
                },
              ),
              input.signal,
              "Provider execution was cancelled.",
            );
          } catch (error) {
            projector.completeOpenSegment();
            if (input.signal?.aborted) {
              appendInterruptedAssistantMessage(
                projector,
                generatedMessages,
                this.#sessionNow,
              );
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
          const isMaintenanceResponse =
            result.status === "completed" &&
            result.toolCalls.some((call) => call.name === CHECKPOINT_CONTEXT_TOOL);
          if (!contextCompactionRequired && !isMaintenanceResponse) {
            deferredProviderEvents.forEach((event) => projector.accept(event));
          }
          projector.completeOpenSegment();
          mergeUsage(usage, result.usage);
          replaceLastRequestUsage(usage, result.usage);
          if (result.usage.inputTokens !== undefined) {
            appendOnlyInputFloorTokens = result.usage.inputTokens;
            if (
              dispatchPressure?.measurement === "fallback_estimate" &&
              dispatchPressure.fallbackPromptTokens > 0
            ) {
              fallbackTokenScale = Math.max(
                fallbackTokenScale,
                result.usage.inputTokens / dispatchPressure.fallbackPromptTokens,
              );
            }
          }
          if (result.usage.inputTokens !== undefined) {
            this.#eventLog.append(identity, {
              kind: "model_request_usage",
              payload: {
                round,
                attempt,
                model: request.model,
                ...(usage.contextWindowTokens !== undefined
                  ? { contextWindowTokens: usage.contextWindowTokens }
                  : {}),
                inputTokens: result.usage.inputTokens,
                ...(result.usage.outputTokens !== undefined
                  ? { outputTokens: result.usage.outputTokens }
                  : {}),
                ...(result.usage.cachedInputTokens !== undefined
                  ? { cachedInputTokens: result.usage.cachedInputTokens }
                  : {}),
                ...(result.providerResponseId
                  ? { providerResponseId: result.providerResponseId }
                  : {}),
                ...(dispatchPressure
                  ? {
                      preflightInputTokens: dispatchPressure.estimatedPromptTokens,
                      preflightMeasurement: dispatchPressure.measurement,
                      usableInputTokens: dispatchPressure.usableInputTokens,
                    }
                  : {}),
              },
            });
          }
          if (input.signal?.aborted) {
            appendInterruptedAssistantMessage(
              projector,
              generatedMessages,
              this.#sessionNow,
            );
            return stop(projector.finalMessageId);
          }
          if (result.status === "completed") {
            completedRound = result;
            completedProjector = projector;
            break;
          }
          if (result.error.retryable && (this.#maxAttempts === null || attempt < this.#maxAttempts)) {
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
                retryAfterMs: result.error.retryAfterMs,
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
                status: result.error.status,
                providerRequestId: result.error.providerRequestId,
                diagnostics: result.error.diagnostics,
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
              status: result.error.status,
              providerRequestId: result.error.providerRequestId,
              diagnostics: result.error.diagnostics,
            },
          });
        }
        if (!completedRound || !completedProjector) {
          throw new Error("Runtime retry loop exited without a model result.");
        }
        const checkpointCalls = completedRound.toolCalls.filter((call) =>
          call.name === CHECKPOINT_CONTEXT_TOOL,
        );
        if (contextCompactionRequired && checkpointCalls.length === 0) {
          contextCompactionFailures += 1;
          if (contextCompactionFailures >= 3) {
            return finalize({
              status: "failed",
              reason: "context_compaction_required",
              finalMessageId: completedProjector.finalMessageId,
              details: { message: "The model did not produce the required context checkpoint." },
            });
          }
          retryContextCompaction(
            "checkpoint_not_produced",
            "The model did not produce the required context checkpoint.",
          );
          contextPressureNoticeKey = undefined;
          messages = [...messages, {
            role: "user",
            name: "context_compaction_correction",
            visibility: "internal",
            content: "Context compaction is mandatory before normal work can continue. Call checkpoint_context now and do not answer or call another Tool.",
          }];
          providerState = freshResponseChain();
          continue;
        }
        if (checkpointCalls.length > 0) {
          if (checkpointCalls.length !== 1 || completedRound.toolCalls.length !== 1) {
            contextCompactionFailures += 1;
            if (contextCompactionFailures >= 3) {
              return finalize({
                status: "failed",
                reason: "context_compaction_protocol_invalid",
                finalMessageId: completedProjector.finalMessageId,
                details: { message: "checkpoint_context must be called alone." },
              });
            }
            retryContextCompaction(
              "checkpoint_not_atomic",
              "checkpoint_context must be called alone.",
            );
            messages = [...messages, {
              role: "user",
              name: "context_compaction_correction",
              visibility: "internal",
              content: "checkpoint_context must be the only Tool call in this maintenance round. Call it again alone with every requested context segment.",
            }];
            providerState = freshResponseChain();
            continue;
          }
          try {
            const { checkpoint } = this.#applyContextCheckpoint({
              sessionId: request.sessionId,
              activeTurnId: request.turnId,
              checkpoint: JSON.parse(checkpointCalls[0]!.argumentsText),
            });
            if (checkpoint.activeTurn) {
              activeContextCheckpoint = {
                throughMessageId: checkpoint.activeTurn.throughMessageId,
                summary: checkpoint.activeTurn.summary,
                inputMessageCount: input.sessionCommit!.inputMessages.length,
              };
            }
            completeContextCompaction(checkpoint);
            this.#contextCompactionAuthorizations.delete(turnKey);
            contextPressureNoticeKey = undefined;
            contextCompactionFailures = 0;
            appendOnlyInputFloorTokens = undefined;
            messages = this.#rebuildCompactedMessages(
              request.sessionId,
              request.turnId,
              input.sessionCommit!,
              generatedMessages,
              activeContextCheckpoint,
            );
            const previousAssistantMessageId = [...generatedMessages]
              .reverse()
              .find((item) => item.message.role === "assistant")
              ?.messageId;
            messages = this.#appendQueuedTurnGuidance({
              turnKey,
              identity,
              round,
              previousAssistantMessageId,
              messages,
              generatedMessages,
            }).messages;
            providerState = freshResponseChain();
            this.#recovery.save({
              request,
              messages,
              nextRound: round + 1,
              cacheChainState: cacheChain.snapshot(),
              sessionCommit: sessionCommitCheckpoint(),
            });
            continue;
          } catch (error) {
            const failure = contextCheckpointFailure(error, checkpointCalls[0]!.argumentsText);
            contextCompactionFailures += 1;
            // Persistence/application failures are not malformed model output.
            if (contextCompactionFailures >= 3 || failure.diagnostics.code === "checkpoint_apply_failed") {
              return finalize({
                status: "failed",
                reason: "context_compaction_failed",
                finalMessageId: completedProjector.finalMessageId,
                details: {
                  message: failure.message,
                  checkpointDiagnostics: failure.diagnostics,
                },
              });
            }
            const state = this.#contextCompactionState(
              request.sessionId,
              request.turnId,
              generatedMessages,
              activeContextCheckpoint,
            );
            const pressure = await this.#measureContextPressure(
              request,
              messages,
              providerState,
              input.signal,
              fallbackTokenScale,
              appendOnlyInputFloorTokens,
            );
            const mayRetry = Boolean(
              pressure &&
              requiresContextCompactionBeforeRound(pressure) &&
              (state.unsummarizedTurnIds.length > 0 || state.activeTurn !== undefined),
            );
            if (mayRetry) {
              this.#contextCompactionAuthorizations.set(turnKey, state);
              contextPressureNoticeKey = undefined;
              retryContextCompaction(
                "checkpoint_rejected",
                failure.message,
                failure.diagnostics,
              );
            } else {
              this.#contextCompactionAuthorizations.delete(turnKey);
              if (activeContextCompaction) {
                this.#eventLog.append(identity, {
                  kind: "context_compaction_failed",
                  payload: {
                    ...activeContextCompaction,
                    round,
                    reason: "checkpoint_rejected",
                    message: failure.message,
                    diagnostics: failure.diagnostics,
                  },
                });
                activeContextCompaction = undefined;
              }
            }
            messages = [...messages, {
              role: "user",
              name: "context_compaction_correction",
              visibility: "internal",
              content: mayRetry
                ? `The context checkpoint was rejected: ${failure.message} Re-read the next context_pressure notice and return the requested summary fields in its order.${legacyCheckpointInput ? " Match the saved Tool schema and the exact authorized identifiers." : " Return only summaries (an array of strings) and active_summary (a string); Runtime supplies the revision and boundaries."}`
                : `The checkpoint_context call was rejected because Runtime has not issued an authorizing user-role context_pressure instruction at the mandatory threshold. Continue the task normally and do not call checkpoint_context proactively.`,
            }];
            providerState = freshResponseChain();
            continue;
          }
        }
        if (completedRound.toolCalls.length === 0) {
          if (
            completedRound.finishReason === "length" &&
            !completedRound.text.trim()
          ) {
            return finalize({
              status: "failed",
              reason: "reasoning-budget-exhausted-before-action",
              finalMessageId: completedProjector.finalMessageId,
              details: {
                round,
                hadHiddenReasoning: Boolean(completedRound.reasoning.trim()),
              },
            });
          }
          if (completedRound.text) {
            const assistantMessage: ModelMessage = {
              role: "assistant",
              content: completedRound.text,
              ...(completedRound.reasoning
                ? { reasoningContent: completedRound.reasoning }
                : {}),
              toolCalls: [],
            };
            generatedMessages.push({
              messageId: completedProjector.messageId,
              createdAt: this.#sessionNow(),
              message: assistantMessage,
            });
            messages = [...messages, assistantMessage];
          }
          providerState = continuedResponseChain(
            completedRound.providerResponseId,
            messages.length,
          );
          const appliedGuidance = this.#appendQueuedTurnGuidance({
            turnKey,
            identity,
            round,
            previousAssistantMessageId: completedProjector.messageId,
            messages,
            generatedMessages,
          });
          if (appliedGuidance.count > 0) {
            messages = appliedGuidance.messages;
            this.#recovery.save({
              request,
              messages,
              nextRound: round + 1,
              cacheChainState: cacheChain.snapshot(),
              sessionCommit: sessionCommitCheckpoint(),
            });
            continue;
          }
          const readyAgentResults = this.#takeSettledAgentGuidance(turnKey);
          if (readyAgentResults.length > 0) {
            messages = this.#appendAgentGuidance(
              request.turnId,
              messages,
              generatedMessages,
              readyAgentResults,
            );
            continue;
          }
          if ((this.#pendingAgentGuidance.get(turnKey)?.length ?? 0) > 0) {
            const joinedAgentResults = await this.#joinPendingAgentGuidance(turnKey);
            if (input.signal?.aborted) return stop(completedProjector.finalMessageId);
            messages = this.#appendAgentGuidance(
              request.turnId,
              messages,
              generatedMessages,
              joinedAgentResults,
            );
            continue;
          }
          const activePlan = request.metadata.planEnabled === true
            ? this.#coordination.getPlan(request.sessionId)
            : undefined;
          if (activePlan?.plan.active) {
            if (unresolvedPlanContinuations >= 2) {
              return finalize({
                status: "failed",
                reason: "open_task_plan_not_resolved",
                finalMessageId: completedProjector.finalMessageId,
                details: {
                  planId: activePlan.plan.plan_id,
                  revision: activePlan.revision,
                  openNodeIds: activePlan.plan.nodes
                    .filter((node) => node.status !== "completed")
                    .map((node) => node.id ?? node.step),
                },
              });
            }
            unresolvedPlanContinuations += 1;
            const planMessage: ModelMessage = {
              role: "user",
              name: "task_plan_continuation",
              visibility: "internal",
              content: "The active task plan still has open nodes. Continue the work or update_task_plan with accurate terminal node states before finishing this Turn.",
            };
            messages = [...messages, planMessage];
            generatedMessages.push({
              messageId: `msg_plan_continuation_${request.turnId}_${round}`,
              createdAt: this.#sessionNow(),
              message: planMessage,
            });
            continue;
          }
          if (!completedRound.text.trim()) {
            if (emptyStopRetries < 1) {
              emptyStopRetries += 1;
              const recoveryMessage: ModelMessage = {
                role: "user",
                name: "empty_stop_recovery",
                visibility: "internal",
                content: "The previous response ended without visible content or a Tool call. Produce one concise user-facing final response now, or call the required Tool. Do not emit an empty response.",
              };
              messages = [...messages, recoveryMessage];
              generatedMessages.push({
                messageId: `msg_empty_stop_recovery_${request.turnId}_${round}`,
                createdAt: this.#sessionNow(),
                message: recoveryMessage,
              });
              continue;
            }
            return finalize({
              status: "failed",
              reason: "empty_model_response",
              finalMessageId: completedProjector.finalMessageId,
              details: { rounds: round, recoveryAttempts: emptyStopRetries },
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

        const assistantMessage: ModelMessage = {
          role: "assistant",
          content: completedRound.text,
          ...(completedRound.reasoning
            ? { reasoningContent: completedRound.reasoning }
            : {}),
          toolCalls: completedRound.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            argumentsText: call.argumentsText,
          })),
        };
        const toolRound = await toolLoop.execute(completedRound.toolCalls, {
          round,
          assistantMessageId: completedProjector.messageId,
          signal: input.signal,
          request,
          contextMessages: messages,
          modelContextIngressBudgetTokens: contextToolIngressTokenBudget({
            pressure: dispatchPressure,
            actualInputTokens: completedRound.usage.inputTokens,
            actualOutputTokens: completedRound.usage.outputTokens,
          }),
        });
        const continuationOffset = messages.length + 1;
        messages = [
          ...messages,
          assistantMessage,
          ...toolRound.messages,
        ];
        providerState = continuedResponseChain(
          completedRound.providerResponseId,
          continuationOffset,
        );
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
        const readyAgentResults = this.#takeSettledAgentGuidance(turnKey);
        if (readyAgentResults.length > 0) {
          messages = this.#appendAgentGuidance(
            request.turnId,
            messages,
            generatedMessages,
            readyAgentResults,
          );
        }
        const appliedGuidance = this.#appendQueuedTurnGuidance({
          turnKey,
          identity,
          round,
          previousAssistantMessageId: completedProjector.messageId,
          messages,
          generatedMessages,
        });
        messages = appliedGuidance.messages;
        this.#recovery.save({
          request,
          messages,
          nextRound: round + 1,
          cacheChainState: cacheChain.snapshot(),
          sessionCommit: sessionCommitCheckpoint(),
        });
      }
    } catch (error) {
      if (!(error instanceof ProviderInputTokenCountError)) throw error;
      return finalize({
        status: "failed",
        reason: "provider_input_token_count_failed",
        details: { message: error.message },
      });
    } finally {
      this.#guidanceQueues.delete(turnKey);
      this.#pendingAgentGuidance.delete(turnKey);
      this.#toolLoops.delete(toolLoop);
      this.#contextCompactionAuthorizations.delete(turnKey);
      this.#activeTurns.delete(turnKey);
      this.#activeTurnControllers.delete(turnKey);
      input.onSettled?.();
    }
  }

  async #measureContextPressure(
    request: ModelRequest,
    messages: ModelMessage[],
    providerState: ModelProviderState,
    signal?: AbortSignal,
    fallbackScale = 1,
    minimumInputTokens?: number,
  ) {
    const contextWindowTokens = Number(request.metadata.contextWindowTokens);
    if (!Number.isFinite(contextWindowTokens) || contextWindowTokens <= 0) {
      return undefined;
    }
    let providerInputTokens: number | undefined;
    try {
      const measurement = await this.#provider.countInputTokens?.(
        { ...request, messages, providerState },
        { signal },
      );
      if (
        measurement &&
        (!Number.isInteger(measurement.inputTokens) || measurement.inputTokens < 0)
      ) {
        throw new Error("Provider input-token count must be a nonnegative integer.");
      }
      providerInputTokens = measurement?.inputTokens;
    } catch (error) {
      throw new ProviderInputTokenCountError(error);
    }
    return estimateContextPressure(
      request,
      messages,
      providerInputTokens,
      { scale: fallbackScale, minimumInputTokens },
    );
  }

  #contextCompactionState(
    sessionId: string,
    activeTurnId: string,
    generatedMessages: GeneratedMessageFact[],
    activeContextCheckpoint?: TurnContextCheckpoint,
  ): ContextCompactionState {
    const state = this.#sessions.contextCompactionState(sessionId);
    const boundary = generatedMessages.at(-1)?.messageId;
    if (!boundary || boundary === activeContextCheckpoint?.throughMessageId) return state;
    return {
      ...state,
      activeTurn: {
        turnId: activeTurnId,
        throughMessageId: boundary,
      },
    };
  }

  #applyContextCheckpoint(input: {
    sessionId: string;
    activeTurnId: string;
    checkpoint: unknown;
  }) {
    const key = JSON.stringify([input.sessionId, input.activeTurnId]);
    const authorized = this.#contextCompactionAuthorizations.get(key);
    if (!authorized) {
      throw new ContextCheckpointInputError("authorization", "a Runtime-authorized context_pressure boundary", undefined);
    }
    const checkpoint = bindContextCheckpointInput(input.checkpoint, authorized);
    const session = this.#sessions.summarizeContext({
      sessionId: input.sessionId,
      activeTurnId: input.activeTurnId,
      expectedRevision: checkpoint.sessionRevision,
      summaries: checkpoint.summaries,
    });
    return { session, checkpoint };
  }

  #rebuildCompactedMessages(
    sessionId: string,
    activeTurnId: string,
    checkpoint: RuntimeSessionCommitCheckpoint,
    generatedMessages: GeneratedMessageFact[],
    activeContextCheckpoint?: TurnContextCheckpoint,
    maxSummaryTurns?: number,
  ): ModelMessage[] {
    return this.#sessions.rebuildActiveContext({
      sessionId,
      supersession: checkpoint.supersession,
      prefix: checkpoint.prefixMessages,
      current: projectActiveTurnContext({
        turnId: activeTurnId,
        inputMessages: checkpoint.inputMessages,
        generatedMessages,
        checkpoint: activeContextCheckpoint,
        includeResumeInstruction: true,
      }),
      ...(maxSummaryTurns === undefined ? {} : { maxSummaryTurns }),
    }).messages;
  }

  #trackAgentGuidance(
    turnKey: string,
    taskId: string,
    result: Promise<JoinedSubagentResult["message"] | null>,
  ): void {
    const entry: PendingAgentGuidance = {
      taskId,
      settled: false,
      promise: Promise.resolve(agentGuidanceFailure(taskId, "Result tracking was not initialized.")),
    };
    entry.promise = result
      .then((message) => message ?? agentGuidanceFailure(taskId, "No terminal result was returned."))
      .catch((error) => agentGuidanceFailure(
        taskId,
        error instanceof Error ? error.message : String(error),
      ))
      .then((message) => {
        entry.message = message;
        entry.settled = true;
        return message;
      });
    const pending = this.#pendingAgentGuidance.get(turnKey) ?? [];
    pending.push(entry);
    this.#pendingAgentGuidance.set(turnKey, pending);
  }

  #takeSettledAgentGuidance(turnKey: string): SettledAgentGuidance[] {
    const pending = this.#pendingAgentGuidance.get(turnKey) ?? [];
    if (pending.length === 0) return [];
    const settled = pending.filter(
      (entry): entry is PendingAgentGuidance & { message: JoinedSubagentResult["message"] } =>
        entry.settled && entry.message !== undefined,
    );
    if (settled.length === 0) return [];
    const settledSet = new Set<PendingAgentGuidance>(settled);
    const remaining = pending.filter((entry) => !settledSet.has(entry));
    if (remaining.length > 0) this.#pendingAgentGuidance.set(turnKey, remaining);
    else this.#pendingAgentGuidance.delete(turnKey);
    return settled.map((entry) => ({ taskId: entry.taskId, message: entry.message }));
  }

  async #joinPendingAgentGuidance(
    turnKey: string,
    taskIds: string[] = [],
  ): Promise<SettledAgentGuidance[]> {
    const pending = this.#pendingAgentGuidance.get(turnKey) ?? [];
    const joining = taskIds.length > 0
      ? taskIds.map((taskId) => {
          const entry = pending.find((candidate) => candidate.taskId === taskId);
          if (!entry) throw new Error(`Subagent task ${taskId} is not outstanding in this parent Turn.`);
          return entry;
        })
      : [...pending];
    if (joining.length === 0) return [];
    const messages = await Promise.all(joining.map((entry) => entry.promise));
    const joiningSet = new Set(joining);
    const remaining = (this.#pendingAgentGuidance.get(turnKey) ?? [])
      .filter((entry) => !joiningSet.has(entry));
    if (remaining.length > 0) this.#pendingAgentGuidance.set(turnKey, remaining);
    else this.#pendingAgentGuidance.delete(turnKey);
    return joining.map((entry, index) => ({ taskId: entry.taskId, message: messages[index]! }));
  }

  #appendAgentGuidance(
    turnId: string,
    messages: ModelMessage[],
    generatedMessages: GeneratedMessageFact[],
    results: SettledAgentGuidance[],
  ): ModelMessage[] {
    for (const result of results) {
      generatedMessages.push({
        messageId: `msg_subagent_result_${turnId}_${result.taskId}`,
        createdAt: this.#sessionNow(),
        message: result.message,
      });
    }
    return [...messages, ...results.map((result) => result.message)];
  }

  #appendQueuedTurnGuidance(input: {
    turnKey: string;
    identity: RuntimeEventIdentity;
    round: number;
    previousAssistantMessageId?: string;
    messages: ModelMessage[];
    generatedMessages: GeneratedMessageFact[];
  }): { messages: ModelMessage[]; count: number } {
    const queued = this.#guidanceQueues.get(input.turnKey);
    if (!queued || queued.length === 0) {
      return { messages: input.messages, count: 0 };
    }
    this.#guidanceQueues.delete(input.turnKey);
    const guidanceMessages = queued.map((guidance) => {
      const message: ModelMessage = {
        role: "user",
        name: "turn_guidance",
        content: guidance.content,
      };
      input.generatedMessages.push({
        messageId: guidance.messageId,
        createdAt: guidance.createdAt,
        message,
      });
      return message;
    });
    queued.forEach((guidance, index) => {
      this.#eventLog.append(input.identity, {
        kind: "guidance_applied",
        payload: {
          messageId: guidance.messageId,
          queueDepth: queued.length - index - 1,
          afterRound: input.round,
          ...(input.previousAssistantMessageId
            ? { previousAssistantMessageId: input.previousAssistantMessageId }
            : {}),
        },
      });
    });
    return {
      messages: [...input.messages, ...guidanceMessages],
      count: guidanceMessages.length,
    };
  }

  #settleOrphanedTurns(): void {
    for (const checkpoint of this.#recovery.orphanedCheckpoints()) {
      const { request, sessionCommit } = checkpoint;
      const payload: TurnTerminalPayload = {
        status: "stopped",
        reason: "runtime_restart_interrupted",
        details: { recoveredAtStartup: true },
      };
      try {
        if (sessionCommit) {
          this.#sessions.finalizer(request, sessionCommit)(
            payload,
            sessionCommit.generatedMessages,
            sessionCommit.usage,
            checkpoint.cacheChainState,
            sessionCommit.activeContextCheckpoint,
          );
        }
        this.#finishTurn({
          requestId: request.requestId,
          sessionId: request.sessionId,
          turnId: request.turnId,
        }, payload);
      } catch (error) {
        this.#onRecoveryError?.(error instanceof Error ? error : new Error(String(error)));
      }
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

  #readArchivedToolResult(locator: string): unknown {
    const match = /^tool-result:\/\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(locator);
    if (!match) throw new Error("Invalid archived Tool result locator.");
    const [sessionId, turnId, toolCallId] = match.slice(1).map((value) =>
      decodeURIComponent(value!),
    );
    const record = this.#toolExecutions.get(sessionId!, turnId!, toolCallId!);
    if (!record) throw new Error("Archived Tool result was not found.");
    return record.outcome === "returned"
      ? record.result
      : { runtimeError: record.error };
  }

  async #recordLogicFeedback(input: {
    sessionId: string;
    turnId: string;
    messageId: string;
    rating: "up" | "down" | null;
  }) {
    const snapshot = this.#sessions.snapshot(input.sessionId);
    const turn = snapshot?.turns.find((candidate) => candidate.turnId === input.turnId);
    if (!turn) throw new Error(`Turn ${input.turnId} does not exist in ${input.sessionId}.`);
    const message = turn.messages.find((candidate) => candidate.messageId === input.messageId);
    if (!message || message.message.role !== "assistant") {
      throw new Error(`Message ${input.messageId} is not an assistant message in ${input.turnId}.`);
    }
    const associatedLogicIds = logicIdsFromExecutions(
      this.#toolExecutions.listTurn(input.sessionId, input.turnId),
    );
    const feedback = await this.#logicMemory.recordFeedbackForLogicIds(
      associatedLogicIds,
      input.rating,
      {
        sourceId: `assistant:${input.sessionId}:${input.turnId}:${input.messageId}`,
        source: "user_thumb",
      },
    );
    return {
      ...input,
      associatedLogicIds,
      updatedLogicIds: feedback.updatedLogicIds,
      missingLogicIds: feedback.missingLogicIds,
    };
  }

  async #revertWorkspaceChanges(input: { sessionId: string; turnIds: string[] }) {
    if (this.#activeTurns.size > 0) throw new Error("Workspace changes cannot be reverted while a Turn is active.");
    const session = this.#sessions.snapshot(input.sessionId);
    if (!session) {
      throw workspaceSnapshotUnavailable(`Session ${input.sessionId} does not exist.`);
    }
    const previouslyReverted = new Set(
      stringArrayMetadata(
        session.metadata?.[RUNTIME_REVERTED_WORKSPACE_CHANGE_IDS_METADATA_KEY],
      ),
    );
    let recordedChangeCount = 0;
    const changes = [...new Set(input.turnIds)].flatMap((turnId) =>
      this.#toolExecutions.listTurn(input.sessionId, turnId)
        .reverse()
        .flatMap((record) => {
          recordedChangeCount += record.workspaceChanges.length;
          return [...record.workspaceChanges].reverse();
        }),
    ).filter((change) => !previouslyReverted.has(change.change_id));
    if (recordedChangeCount === 0) {
      throw workspaceSnapshotUnavailable(
        "No authoritative workspace changes were recorded for the requested Turn(s).",
      );
    }
    if (changes.length === 0) {
      return {
        sessionId: input.sessionId,
        turnIds: input.turnIds,
        revertedFiles: 0,
        revertedChangeIds: [],
        revertedAt: this.#sessionNow(),
      };
    }

    const projectPathAliases = projectPathAliasesMetadata(
      session.metadata?.project_path_aliases,
      session.metadata?.projectDir,
    );
    const paths = [...new Set(changes.map((change) => {
      if (!isAbsolute(change.path)) {
        throw new Error(`Cannot revert ${change.path}; workspace change paths must be absolute.`);
      }
      return resolveProjectPathAlias(change.path, projectPathAliases);
    }))].sort();
    const releases: Array<() => void> = [];
    try {
      for (const path of paths) releases.push(this.#workspaceObservations.acquireMutation(path));
      const initial = new Map<string, WorkspaceFileSnapshot>();
      for (const path of paths) initial.set(path, await readWorkspaceFile(path));
      const virtual = new Map(initial);
      const operations: WorkspaceRevertOperation[] = [];
      for (const change of changes) {
        const path = resolveProjectPathAlias(change.path, projectPathAliases);
        const current = virtual.get(path) ?? { exists: false };
        assertWorkspaceChangeRevision(change, current);
        const restored = restoredWorkspaceSnapshot(change);
        operations.push({ path, expected: current, restored });
        virtual.set(path, restored);
      }

      try {
        for (const operation of operations) {
          const current = await readWorkspaceFile(operation.path);
          assertSnapshotMatches(operation.path, operation.expected, current);
          await restoreWorkspaceFile(operation.path, operation.restored);
        }
        const latestSession = this.#sessions.snapshot(input.sessionId);
        if (!latestSession) {
          throw new Error(`Session ${input.sessionId} disappeared during workspace revert.`);
        }
        const revertedChangeIds = changes.map((change) => change.change_id);
        this.#sessions.updateMetadata({
          sessionId: input.sessionId,
          expectedRevision: latestSession.revision,
          metadata: {
            ...(latestSession.metadata ?? {}),
            [RUNTIME_REVERTED_WORKSPACE_CHANGE_IDS_METADATA_KEY]: [
              ...new Set([...previouslyReverted, ...revertedChangeIds]),
            ],
          },
        });
        return {
          sessionId: input.sessionId,
          turnIds: input.turnIds,
          revertedFiles: paths.length,
          revertedChangeIds,
          revertedAt: this.#sessionNow(),
        };
      } catch (error) {
        const rollbackErrors: string[] = [];
        for (const [path, snapshot] of initial) {
          try {
            await restoreWorkspaceFile(path, snapshot);
          } catch (rollbackError) {
            rollbackErrors.push(
              `${path}: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
            );
          }
        }
        if (rollbackErrors.length > 0) {
          throw new Error(
            `${error instanceof Error ? error.message : String(error)} Recovery also failed for ${rollbackErrors.join("; ")}`,
          );
        }
        throw error;
      }
    } finally {
      for (const release of releases.reverse()) release();
    }
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

interface WorkspaceFileSnapshot {
  exists: boolean;
  content?: Buffer;
  sha256?: string;
}

interface WorkspaceRevertOperation {
  path: string;
  expected: WorkspaceFileSnapshot;
  restored: WorkspaceFileSnapshot;
}

function workspaceSnapshotUnavailable(message: string): Error {
  return Object.assign(new Error(message), {
    code: "runtime_workspace_snapshot_unavailable",
    retryable: false,
    details: {},
  });
}

function stringArrayMetadata(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()))
    : [];
}

interface ProjectPathAlias {
  from: string;
  to: string;
}

function projectPathAliasesMetadata(value: unknown, currentRootValue: unknown): ProjectPathAlias[] {
  const currentRoot = typeof currentRootValue === "string" && isAbsolute(currentRootValue)
    ? resolve(currentRootValue)
    : "";
  if (!Array.isArray(value) || !currentRoot) return [];
  const parsed = value.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    const record = candidate as Record<string, unknown>;
    const from = typeof record.from === "string" ? record.from.trim() : "";
    const to = typeof record.to === "string" ? record.to.trim() : "";
    if (!from || !to || !isAbsolute(from) || !isAbsolute(to)) return [];
    return [{ from: resolve(from), to: resolve(to) }];
  });
  return parsed
    .filter((alias) => aliasReachesCurrentRoot(alias, parsed, currentRoot))
    .sort((left, right) => right.from.length - left.from.length);
}

function aliasReachesCurrentRoot(
  alias: ProjectPathAlias,
  aliases: ProjectPathAlias[],
  currentRoot: string,
): boolean {
  let current = alias.to;
  const visited = new Set<string>();
  for (let step = 0; step <= aliases.length; step += 1) {
    if (sameFilesystemPath(current, currentRoot)) return true;
    const identity = filesystemPathIdentity(current);
    if (visited.has(identity)) return false;
    visited.add(identity);
    const next = aliases.find((candidate) => sameFilesystemPath(candidate.from, current));
    if (!next) return false;
    current = next.to;
  }
  return false;
}

function resolveProjectPathAlias(value: string, aliases: ProjectPathAlias[]): string {
  let current = resolve(value);
  const visited = new Set<string>();
  for (let step = 0; step <= aliases.length; step += 1) {
    const identity = filesystemPathIdentity(current);
    if (visited.has(identity)) break;
    visited.add(identity);
    const alias = aliases.find((candidate) => isPathInside(candidate.from, current));
    if (!alias) break;
    current = resolve(alias.to, relative(alias.from, current));
  }
  return current;
}

function filesystemPathIdentity(value: string): string {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLocaleLowerCase() : normalized;
}

function sameFilesystemPath(left: string, right: string): boolean {
  return filesystemPathIdentity(left) === filesystemPathIdentity(right);
}

function isPathInside(root: string, candidate: string): boolean {
  const remainder = relative(root, candidate);
  return remainder === "" || (!remainder.startsWith("..") && !isAbsolute(remainder));
}

async function readWorkspaceFile(path: string): Promise<WorkspaceFileSnapshot> {
  try {
    const content = await readFile(path);
    return {
      exists: true,
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw error;
  }
}

function assertWorkspaceChangeRevision(
  change: WorkspaceChange,
  current: WorkspaceFileSnapshot,
): void {
  if (change.status === "renamed") {
    throw new Error(`Cannot revert ${change.path}; renamed workspace changes are not supported.`);
  }
  if (change.status === "deleted") {
    if (current.exists) {
      throw new Error(`Cannot revert ${change.path}; the recorded deletion no longer matches the workspace.`);
    }
    return;
  }
  if (!change.after_hash) {
    throw new Error(`Cannot revert ${change.path}; no after-revision was recorded.`);
  }
  if (!current.exists || current.sha256 !== change.after_hash) {
    throw new Error(`Cannot revert ${change.path}; its current revision no longer matches the recorded change.`);
  }
}

function restoredWorkspaceSnapshot(change: WorkspaceChange): WorkspaceFileSnapshot {
  if (change.status === "added") return { exists: false };
  const encoded = typeof change.metadata.beforeContentBase64 === "string"
    ? change.metadata.beforeContentBase64
    : "";
  if (!encoded) {
    throw new Error(`Cannot revert ${change.path}; no before-image was recorded.`);
  }
  const content = Buffer.from(encoded, "base64");
  const sha256 = createHash("sha256").update(content).digest("hex");
  if (change.before_hash && sha256 !== change.before_hash) {
    throw new Error(`Cannot revert ${change.path}; the recorded before-image is corrupt.`);
  }
  return { exists: true, content, sha256 };
}

function assertSnapshotMatches(
  path: string,
  expected: WorkspaceFileSnapshot,
  current: WorkspaceFileSnapshot,
): void {
  if (expected.exists !== current.exists || expected.sha256 !== current.sha256) {
    throw new Error(`Cannot revert ${path}; it changed while the revert was being prepared.`);
  }
}

async function restoreWorkspaceFile(path: string, snapshot: WorkspaceFileSnapshot): Promise<void> {
  if (!snapshot.exists) {
    await rm(path, { force: true });
    return;
  }
  if (!snapshot.content) throw new Error(`Cannot restore ${path}; snapshot content is missing.`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, snapshot.content);
}

function agentGuidanceFailure(
  taskId: string,
  message: string,
): JoinedSubagentResult["message"] {
  return {
    role: "user",
    name: "subagent_result",
    content: `<subagent_result task_id="${taskId}" status="failed">\n${message}\n</subagent_result>`,
  };
}

function childPermissionRuntimeOptions(
  request: ModelRequest,
  identity: RuntimeEventIdentity,
): Pick<
  ConstructorParameters<typeof RuntimeToolLoop>[0],
  "capabilitySessionId" | "permissionEventIdentity" | "permissionSource"
> {
  if (request.metadata.agentRole !== "child") return {};
  const requestId = metadataString(request.metadata.permissionEventRequestId);
  const parentSessionId = metadataString(request.metadata.permissionEventSessionId);
  const parentTurnId = metadataString(request.metadata.permissionEventTurnId);
  const permissionRouting = request.metadata.permissionRouting === "user" ? "user" : "parent";
  if (!requestId || !parentSessionId || !parentTurnId) return {};
  const subagentTaskId = metadataString(request.metadata.subagentTaskId);
  return {
    capabilitySessionId:
      metadataString(request.metadata.permissionScopeSessionId) || identity.sessionId,
    permissionEventIdentity: { requestId, sessionId: parentSessionId, turnId: parentTurnId },
    permissionSource: {
      sourceSessionId: identity.sessionId,
      sourceTurnId: identity.turnId,
      parentSessionId,
      parentTurnId,
      ...(subagentTaskId ? { subagentTaskId } : {}),
      permissionRouting,
    },
  };
}

function metadataString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

interface ActiveContextCompactionLifecycle {
  compactionId: string;
  round: number;
  attempt: number;
  assistantMessageId?: string;
  assistantContentOffset?: number;
}

function contextCompactionStateKey(state: ContextCompactionState): string {
  return JSON.stringify({
    revision: state.revision,
    unsummarizedTurnIds: state.unsummarizedTurnIds,
    activeTurn: state.activeTurn ?? null,
  });
}

function isContextCompactionEvent(
  event: RuntimeEvent,
): event is RuntimeContextCompactionEvent {
  return event.kind === "context_compaction_started" ||
    event.kind === "context_compaction_retrying" ||
    event.kind === "context_compaction_completed" ||
    event.kind === "context_compaction_failed" ||
    event.kind === "context_compaction_cancelled";
}

function effectiveContextCompactionEvents(
  events: RuntimeEvent[],
): RuntimeContextCompactionEvent[] {
  const supersededEventIds = new Set(
    events.flatMap((event) =>
      event.kind === "replay_reset" ? event.payload.supersededEventIds : []
    ),
  );
  return events.filter((event): event is RuntimeContextCompactionEvent =>
    isContextCompactionEvent(event) && !supersededEventIds.has(event.eventId)
  );
}

function pendingContextCompactionLifecycle(
  events: RuntimeContextCompactionEvent[],
): ActiveContextCompactionLifecycle | undefined {
  let active: ActiveContextCompactionLifecycle | undefined;
  for (const event of events) {
    if (event.kind === "context_compaction_started") {
      active = {
        compactionId: event.payload.compactionId,
        round: event.payload.round,
        attempt: event.payload.attempt,
        ...(event.payload.assistantMessageId
          ? { assistantMessageId: event.payload.assistantMessageId }
          : {}),
        ...(event.payload.assistantContentOffset !== undefined
          ? { assistantContentOffset: event.payload.assistantContentOffset }
          : {}),
      };
      continue;
    }
    if (!active || event.payload.compactionId !== active.compactionId) continue;
    if (event.kind === "context_compaction_retrying") {
      active = {
        ...active,
        round: event.payload.round,
        attempt: event.payload.attempt,
      };
    } else {
      active = undefined;
    }
  }
  return active;
}

function freshResponseChain(): ModelProviderState {
  return { strategy: "response_chain" };
}

function resolveModelRequestContextLimits(request: ModelRequest): ModelRequest {
  const contextWindowTokens = Number(request.metadata.contextWindowTokens);
  if (!Number.isInteger(contextWindowTokens) || contextWindowTokens <= 0) return request;
  return modelRequestSchema.parse({
    ...request,
    maxOutputTokens: resolveContextOutputTokens(
      contextWindowTokens,
      request.maxOutputTokens,
    ),
  });
}

function continuedResponseChain(
  previousResponseId: string | undefined,
  inputMessageOffset: number,
): ModelProviderState {
  return previousResponseId
    ? { strategy: "response_chain", previousResponseId, inputMessageOffset }
    : freshResponseChain();
}

function acceptsBoundedOverLimitRecovery(
  pressure: ContextPressure | undefined,
  appendOnlyInputFloorTokens: number | undefined,
): boolean {
  return Boolean(
    pressure &&
    appendOnlyInputFloorTokens !== undefined &&
    appendOnlyInputFloorTokens >= pressure.usableInputTokens &&
    pressure.estimatedPromptTokens <=
      appendOnlyInputFloorTokens + pressure.reservedOutputTokens,
  );
}

function appendInterruptedAssistantMessage(
  projector: RuntimeEventProjector,
  generatedMessages: GeneratedMessageFact[],
  now: () => string,
): void {
  const messageId = projector.finalMessageId;
  if (!messageId || generatedMessages.some((item) => item.messageId === messageId)) {
    return;
  }
  generatedMessages.push({
    messageId,
    createdAt: now(),
    message: {
      role: "assistant",
      content: projector.assistantContent,
      ...(projector.reasoningContent
        ? { reasoningContent: projector.reasoningContent }
        : {}),
      toolCalls: [],
    },
  });
}

function conversationSessionSnapshot(snapshot: SessionSnapshot): SessionSnapshot {
  return {
    ...snapshot,
    turns: snapshot.turns.map((turn) => ({
      ...turn,
      messages: turn.messages.flatMap((entry) => {
        if (entry.message.role === "tool") return [];
        if (
          entry.message.role === "system" ||
          entry.message.role === "developer"
        ) {
          return [];
        }
        if (entry.message.role !== "assistant") return [entry];
        const { reasoningContent: _reasoningContent, ...message } = entry.message;
        return [{ ...entry, message }];
      }),
    })),
  };
}

export function defaultRuntimeRetryDelayMs(context: RuntimeRetryContext): number {
  // 1, 2, 4, 8, 16, then 30 seconds. Retry the same request; never replay tools.
  const backoff = Math.min(30_000, 1000 * 2 ** Math.min(5, Math.max(0, context.nextAttempt - 2)));
  const retryAfter = Number.isFinite(context.retryAfterMs) ? Math.max(0, context.retryAfterMs!) : 0;
  return Math.round(Math.max(backoff, Math.min(retryAfter, 300_000)));
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

function replaceLastRequestUsage(
  target: {
    lastRequestInputTokens?: number;
    lastRequestOutputTokens?: number;
    lastRequestCachedInputTokens?: number;
  },
  source: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number },
): void {
  const mappings = [
    ["lastRequestInputTokens", "inputTokens"],
    ["lastRequestOutputTokens", "outputTokens"],
    ["lastRequestCachedInputTokens", "cachedInputTokens"],
  ] as const;
  for (const [targetKey, sourceKey] of mappings) {
    const value = source[sourceKey];
    if (value === undefined) delete target[targetKey];
    else target[targetKey] = value;
  }
}

function forwardAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  if (!signal) return () => {};
  const abort = () => controller.abort();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", abort, { once: true });
  return () => signal.removeEventListener("abort", abort);
}
