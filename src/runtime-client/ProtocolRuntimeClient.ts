import {
  ASSEMBLE_RUNTIME_SESSION_CONTEXT_COMMAND,
  APPLY_RUNTIME_MCP_SNAPSHOT_COMMAND,
  APPLY_RUNTIME_TEAM_SNAPSHOT_COMMAND,
  ENQUEUE_RUNTIME_GUIDANCE_COMMAND,
  ANSWER_RUNTIME_INTERACTION_COMMAND,
  GET_PENDING_RUNTIME_INTERACTIONS_COMMAND,
  GET_RUNTIME_CAPABILITIES_COMMAND,
  GET_RUNTIME_GOAL_COMMAND,
  GET_RUNTIME_PLAN_COMMAND,
  GET_RUNTIME_MCP_SNAPSHOT_COMMAND,
  GET_RUNTIME_TEAM_SNAPSHOT_COMMAND,
  GET_RUNTIME_TOOL_CATALOG_COMMAND,
  GET_RUNTIME_TOOL_CATALOG_DETAILS_COMMAND,
  GET_RUNTIME_SUBAGENT_TASK_COMMAND,
  GET_RUNTIME_SESSION_COMMAND,
  LIST_RUNTIME_SESSIONS_COMMAND,
  UPDATE_RUNTIME_SESSION_METADATA_COMMAND,
  GET_RUNTIME_TOOL_EXECUTION_COMMAND,
  LIST_RUNTIME_TURN_TOOL_EXECUTIONS_COMMAND,
  LIST_RUNTIME_SUBAGENT_TASKS_COMMAND,
  RUN_RUNTIME_SESSION_TURN_COMMAND,
  STOP_RUNTIME_TURN_COMMAND,
  CREATE_RUNTIME_GOAL_COMMAND,
  CREATE_RUNTIME_SESSION_COMMAND,
  DELETE_RUNTIME_SESSION_COMMAND,
  SET_RUNTIME_PLAN_COMMAND,
  SUPERSEDE_RUNTIME_SESSION_MESSAGES_COMMAND,
  UPDATE_RUNTIME_GOAL_COMMAND,
  assembleRuntimeSessionContextRequestSchema,
  createRuntimeGoalRequestSchema,
  createRuntimeSessionRequestSchema,
  decodeContextSnapshot,
  decodeRuntimeCapabilities,
  decodeRuntimeEvent,
  runtimeSessionIdentitySchema,
  runtimeSessionListRequestSchema,
  runtimeSessionTurnRequestSchema,
  runtimeTurnIdentitySchema,
  runtimeStopReceiptSchema,
  runtimeGuidanceRequestSchema,
  runtimeGuidanceReceiptSchema,
  runtimeInteractionAnswerSchema,
  runtimeInteractionSchema,
  pendingRuntimeInteractionsRequestSchema,
  runtimeCoordinationSessionSchema,
  setRuntimePlanRequestSchema,
  updateRuntimeGoalRequestSchema,
  planStateSchema,
  goalStateSchema,
  mcpSnapshotResultSchema,
  mcpSnapshotSchema,
  teamSnapshotSchema,
  teamSnapshotResultSchema,
  sessionSnapshotSchema,
  toolExecutionIdentitySchema,
  toolExecutionRecordSchema,
  toolDefinitionSchema,
  toolCatalogEntrySchema,
  subagentTaskIdentitySchema,
  subagentTaskListRequestSchema,
  subagentTaskSchema,
  turnToolExecutionsIdentitySchema,
  updateRuntimeSessionMetadataRequestSchema,
  supersedeRuntimeSessionMessagesRequestSchema,
  type ContextSnapshot,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimeSessionTurnRequest,
  type RuntimeStopReceipt,
  type RuntimeGuidanceRequest,
  type RuntimeGuidanceReceipt,
  type RuntimeInteraction,
  type RuntimeInteractionAnswer,
  type PlanState,
  type GoalState,
  type McpSnapshot,
  type McpSnapshotResult,
  type TeamSnapshot,
  type TeamSnapshotResult,
  type SessionSnapshot,
  type ToolExecutionRecord,
  type ToolDefinition,
  type ToolCatalogEntry,
  type SubagentTask,
  REVERT_RUNTIME_WORKSPACE_CHANGES_COMMAND,
  revertRuntimeWorkspaceChangesSchema,
} from '@cardbush/bush-protocol';
import {
  RuntimeClient,
  type RuntimeTransport,
} from './RuntimeClient';

export class ProtocolRuntimeClient extends RuntimeClient<RuntimeEvent> {
  constructor(transport: RuntimeTransport) {
    super({ transport, decodeEvent: decodeRuntimeEvent });
  }

  getCapabilities(signal?: AbortSignal): Promise<RuntimeCapabilities> {
    return this.command(
      { kind: GET_RUNTIME_CAPABILITIES_COMMAND, payload: {} },
      decodeRuntimeCapabilities,
      signal,
    );
  }

  getSession(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<SessionSnapshot | null> {
    const payload = runtimeSessionIdentitySchema.parse({ sessionId });
    return this.command(
      { kind: GET_RUNTIME_SESSION_COMMAND, payload },
      (input) => input == null ? null : sessionSnapshotSchema.parse(input),
      signal,
    );
  }

  createSession(
    input: { sessionId: string; metadata?: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<SessionSnapshot> {
    const payload = createRuntimeSessionRequestSchema.parse(input);
    return this.command(
      { kind: CREATE_RUNTIME_SESSION_COMMAND, payload },
      (value) => sessionSnapshotSchema.parse(value),
      signal,
    );
  }

  deleteSession(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{ sessionId: string; deleted: boolean }> {
    const payload = runtimeSessionIdentitySchema.parse({ sessionId });
    return this.command(
      { kind: DELETE_RUNTIME_SESSION_COMMAND, payload },
      (value) => {
        const record = value as Record<string, unknown>;
        return { sessionId: String(record.sessionId), deleted: record.deleted === true };
      },
      signal,
    );
  }

  listSessions(signal?: AbortSignal): Promise<SessionSnapshot[]> {
    const payload = runtimeSessionListRequestSchema.parse({});
    return this.command(
      { kind: LIST_RUNTIME_SESSIONS_COMMAND, payload },
      (input) => sessionSnapshotSchema.array().parse(input),
      signal,
    );
  }

  updateSessionMetadata(
    input: { sessionId: string; expectedRevision: number; metadata: Record<string, unknown> },
    signal?: AbortSignal,
  ): Promise<SessionSnapshot> {
    const payload = updateRuntimeSessionMetadataRequestSchema.parse(input);
    return this.command(
      { kind: UPDATE_RUNTIME_SESSION_METADATA_COMMAND, payload },
      (value) => sessionSnapshotSchema.parse(value),
      signal,
    );
  }

  supersedeSessionMessages(
    input: {
      sessionId: string;
      messageIds: string[];
      reason: string;
      replacementTurnId?: string;
    },
    signal?: AbortSignal,
  ): Promise<SessionSnapshot> {
    const payload = supersedeRuntimeSessionMessagesRequestSchema.parse(input);
    return this.command(
      { kind: SUPERSEDE_RUNTIME_SESSION_MESSAGES_COMMAND, payload },
      (value) => sessionSnapshotSchema.parse(value),
      signal,
    );
  }

  assembleSessionContext(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<ContextSnapshot> {
    const payload = assembleRuntimeSessionContextRequestSchema.parse(input);
    return this.command(
      { kind: ASSEMBLE_RUNTIME_SESSION_CONTEXT_COMMAND, payload },
      decodeContextSnapshot,
      signal,
    );
  }

  runSessionTurn(
    input: RuntimeSessionTurnRequest,
    signal?: AbortSignal,
  ): Promise<RuntimeEvent> {
    const payload = runtimeSessionTurnRequestSchema.parse(input);
    return this.command(
      { kind: RUN_RUNTIME_SESSION_TURN_COMMAND, payload },
      decodeRuntimeEvent,
      signal,
    );
  }

  stopTurn(
    input: { sessionId: string; turnId: string },
    signal?: AbortSignal,
  ): Promise<RuntimeStopReceipt> {
    const payload = runtimeTurnIdentitySchema.parse(input);
    return this.command(
      { kind: STOP_RUNTIME_TURN_COMMAND, payload },
      (value) => runtimeStopReceiptSchema.parse(value),
      signal,
    );
  }

  enqueueGuidance(
    input: RuntimeGuidanceRequest,
    signal?: AbortSignal,
  ): Promise<RuntimeGuidanceReceipt> {
    const payload = runtimeGuidanceRequestSchema.parse(input);
    return this.command(
      { kind: ENQUEUE_RUNTIME_GUIDANCE_COMMAND, payload },
      (value) => runtimeGuidanceReceiptSchema.parse(value),
      signal,
    );
  }

  pendingInteractions(
    input: { sessionId?: string; turnId?: string } = {},
    signal?: AbortSignal,
  ): Promise<RuntimeInteraction[]> {
    const payload = pendingRuntimeInteractionsRequestSchema.parse(input);
    return this.command(
      { kind: GET_PENDING_RUNTIME_INTERACTIONS_COMMAND, payload },
      (value) => runtimeInteractionSchema.array().parse(value),
      signal,
    );
  }

  answerInteraction(
    input: RuntimeInteractionAnswer,
    signal?: AbortSignal,
  ): Promise<RuntimeInteractionAnswer> {
    const payload = runtimeInteractionAnswerSchema.parse(input);
    return this.command(
      { kind: ANSWER_RUNTIME_INTERACTION_COMMAND, payload },
      (value) => runtimeInteractionAnswerSchema.parse(value),
      signal,
    );
  }

  getToolExecution(
    input: { sessionId: string; turnId: string; toolCallId: string },
    signal?: AbortSignal,
  ): Promise<ToolExecutionRecord | null> {
    const payload = toolExecutionIdentitySchema.parse(input);
    return this.command(
      { kind: GET_RUNTIME_TOOL_EXECUTION_COMMAND, payload },
      (value) => value == null ? null : toolExecutionRecordSchema.parse(value),
      signal,
    );
  }

  listTurnToolExecutions(
    input: { sessionId: string; turnId: string },
    signal?: AbortSignal,
  ): Promise<ToolExecutionRecord[]> {
    const payload = turnToolExecutionsIdentitySchema.parse(input);
    return this.command(
      { kind: LIST_RUNTIME_TURN_TOOL_EXECUTIONS_COMMAND, payload },
      (value) => toolExecutionRecordSchema.array().parse(value),
      signal,
    );
  }

  getToolCatalog(signal?: AbortSignal): Promise<ToolDefinition[]> {
    return this.command(
      { kind: GET_RUNTIME_TOOL_CATALOG_COMMAND, payload: {} },
      (value) => toolDefinitionSchema.array().parse(value),
      signal,
    );
  }

  getToolCatalogDetails(signal?: AbortSignal): Promise<ToolCatalogEntry[]> {
    return this.command(
      { kind: GET_RUNTIME_TOOL_CATALOG_DETAILS_COMMAND, payload: {} },
      (value) => toolCatalogEntrySchema.array().parse(value),
      signal,
    );
  }

  applyMcpSnapshot(
    input: McpSnapshot,
    signal?: AbortSignal,
  ): Promise<McpSnapshotResult> {
    const payload = mcpSnapshotSchema.parse(input);
    return this.command(
      { kind: APPLY_RUNTIME_MCP_SNAPSHOT_COMMAND, payload },
      (value) => mcpSnapshotResultSchema.parse(value),
      signal,
    );
  }

  getMcpSnapshot(signal?: AbortSignal): Promise<McpSnapshotResult | null> {
    return this.command(
      { kind: GET_RUNTIME_MCP_SNAPSHOT_COMMAND, payload: {} },
      (value) => value == null ? null : mcpSnapshotResultSchema.parse(value),
      signal,
    );
  }

  applyTeamSnapshot(
    input: TeamSnapshot,
    signal?: AbortSignal,
  ): Promise<TeamSnapshotResult> {
    const payload = teamSnapshotSchema.parse(input);
    return this.command(
      { kind: APPLY_RUNTIME_TEAM_SNAPSHOT_COMMAND, payload },
      (value) => teamSnapshotResultSchema.parse(value),
      signal,
    );
  }

  getTeamSnapshot(signal?: AbortSignal): Promise<TeamSnapshotResult | null> {
    return this.command(
      { kind: GET_RUNTIME_TEAM_SNAPSHOT_COMMAND, payload: {} },
      (value) => value == null ? null : teamSnapshotResultSchema.parse(value),
      signal,
    );
  }

  getSubagentTask(
    input: { parentSessionId: string; taskId: string },
    signal?: AbortSignal,
  ): Promise<SubagentTask | null> {
    const payload = subagentTaskIdentitySchema.parse(input);
    return this.command(
      { kind: GET_RUNTIME_SUBAGENT_TASK_COMMAND, payload },
      (value) => value == null ? null : subagentTaskSchema.parse(value),
      signal,
    );
  }

  listSubagentTasks(
    input: { parentSessionId: string; parentTurnId?: string },
    signal?: AbortSignal,
  ): Promise<SubagentTask[]> {
    const payload = subagentTaskListRequestSchema.parse(input);
    return this.command(
      { kind: LIST_RUNTIME_SUBAGENT_TASKS_COMMAND, payload },
      (value) => subagentTaskSchema.array().parse(value),
      signal,
    );
  }

  getPlan(sessionId: string, signal?: AbortSignal): Promise<PlanState | null> {
    const payload = runtimeCoordinationSessionSchema.parse({ sessionId });
    return this.command(
      { kind: GET_RUNTIME_PLAN_COMMAND, payload },
      (value) => value == null ? null : planStateSchema.parse(value),
      signal,
    );
  }

  setPlan(input: unknown, signal?: AbortSignal): Promise<PlanState> {
    const payload = setRuntimePlanRequestSchema.parse(input);
    return this.command(
      { kind: SET_RUNTIME_PLAN_COMMAND, payload },
      (value) => planStateSchema.parse(value),
      signal,
    );
  }

  getGoal(sessionId: string, signal?: AbortSignal): Promise<GoalState | null> {
    const payload = runtimeCoordinationSessionSchema.parse({ sessionId });
    return this.command(
      { kind: GET_RUNTIME_GOAL_COMMAND, payload },
      (value) => value == null ? null : goalStateSchema.parse(value),
      signal,
    );
  }

  createGoal(input: unknown, signal?: AbortSignal): Promise<GoalState> {
    const payload = createRuntimeGoalRequestSchema.parse(input);
    return this.command(
      { kind: CREATE_RUNTIME_GOAL_COMMAND, payload },
      (value) => goalStateSchema.parse(value),
      signal,
    );
  }

  updateGoal(input: unknown, signal?: AbortSignal): Promise<GoalState> {
    const payload = updateRuntimeGoalRequestSchema.parse(input);
    return this.command(
      { kind: UPDATE_RUNTIME_GOAL_COMMAND, payload },
      (value) => goalStateSchema.parse(value),
      signal,
    );
  }

  revertWorkspaceChanges(
    input: { sessionId: string; turnIds: string[] },
    signal?: AbortSignal,
  ): Promise<{ sessionId: string; turnIds: string[]; revertedFiles: number; revertedAt: string }> {
    const payload = revertRuntimeWorkspaceChangesSchema.parse(input);
    return this.command(
      { kind: REVERT_RUNTIME_WORKSPACE_CHANGES_COMMAND, payload },
      (value) => value as { sessionId: string; turnIds: string[]; revertedFiles: number; revertedAt: string },
      signal,
    );
  }
}
