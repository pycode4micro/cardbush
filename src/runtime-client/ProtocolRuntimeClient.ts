import {
  ASSEMBLE_RUNTIME_SESSION_CONTEXT_COMMAND,
  APPLY_RUNTIME_MCP_SNAPSHOT_COMMAND,
  GET_RUNTIME_CAPABILITIES_COMMAND,
  GET_RUNTIME_GOAL_COMMAND,
  GET_RUNTIME_PLAN_COMMAND,
  GET_RUNTIME_MCP_SNAPSHOT_COMMAND,
  GET_RUNTIME_TOOL_CATALOG_COMMAND,
  GET_RUNTIME_SUBAGENT_TASK_COMMAND,
  GET_RUNTIME_SESSION_COMMAND,
  GET_RUNTIME_TOOL_EXECUTION_COMMAND,
  LIST_RUNTIME_TURN_TOOL_EXECUTIONS_COMMAND,
  LIST_RUNTIME_SUBAGENT_TASKS_COMMAND,
  RUN_RUNTIME_SESSION_TURN_COMMAND,
  CREATE_RUNTIME_GOAL_COMMAND,
  SET_RUNTIME_PLAN_COMMAND,
  UPDATE_RUNTIME_GOAL_COMMAND,
  assembleRuntimeSessionContextRequestSchema,
  createRuntimeGoalRequestSchema,
  decodeContextSnapshot,
  decodeRuntimeCapabilities,
  decodeRuntimeEvent,
  decodeRuntimeFixture,
  runtimeSessionIdentitySchema,
  runtimeSessionTurnRequestSchema,
  runtimeCoordinationSessionSchema,
  setRuntimePlanRequestSchema,
  updateRuntimeGoalRequestSchema,
  planStateSchema,
  goalStateSchema,
  mcpSnapshotResultSchema,
  mcpSnapshotSchema,
  sessionSnapshotSchema,
  toolExecutionIdentitySchema,
  toolExecutionRecordSchema,
  toolDefinitionSchema,
  subagentTaskIdentitySchema,
  subagentTaskListRequestSchema,
  subagentTaskSchema,
  turnToolExecutionsIdentitySchema,
  type ContextSnapshot,
  type RuntimeCapabilities,
  type RuntimeEvent,
  type RuntimeFixture,
  type RuntimeSessionTurnRequest,
  type PlanState,
  type GoalState,
  type McpSnapshot,
  type McpSnapshotResult,
  type SessionSnapshot,
  type ToolExecutionRecord,
  type ToolDefinition,
  type SubagentTask,
} from '@cardbush/bush-protocol';
import {
  FixtureRuntimeTransport,
  type RuntimeFixtureScenario,
  type RuntimeFixtureTransportOptions,
} from './FixtureRuntimeTransport';
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
}

export interface RuntimeFixtureClient {
  client: ProtocolRuntimeClient;
  fixture: RuntimeFixture;
}

export function createRuntimeFixtureClient(
  input: unknown,
  options?: RuntimeFixtureTransportOptions,
): RuntimeFixtureClient {
  const fixture = decodeRuntimeFixture(input);
  const transport = new FixtureRuntimeTransport(
    fixture satisfies RuntimeFixtureScenario,
    options,
  );
  return {
    client: new ProtocolRuntimeClient(transport),
    fixture,
  };
}
