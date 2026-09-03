import type {
  AssistantRevision,
  BackendCapabilities,
  ChatAttachment,
  ChatMessage,
  ChatToolExecution,
  ConversationSummary,
  ManagedModelConfig,
  McpServerConfig,
  McpServersResult,
  McpServerValidationResult,
  McpTransport,
  PendingInteraction,
  SkillDetail,
  SkillSummary,
  TeamFlowActionType,
  TeamFlowState,
  TeamFlowStreamEvent,
  AssistantStreamChunk,
  StreamExecutionUpdate,
  ThinkingStreamEvent,
  TaskPlanStreamUpdate,
  SubagentCapabilities,
  SubagentDispatchEvent,
  SubagentRuntimeResult,
  SubagentSupervisorSnapshot,
  SubagentTaskSnapshot,
  StreamStart,
  WorkspaceContext,
  InteractionReplyAnswer,
  PermissionMode,
  SubagentPermissionRouting,
  ReasoningLevel,
  ReferencePlanMode,
  RuntimeContextWindowUsage,
  RuntimeConnectionUpdate,
  RuntimeAssetCategory,
  RuntimeAssetResetPlan,
  RuntimeAssetResetResult,
  SessionTokenUsage,
  CapabilityCandidatesUpdate,
  TerminalRuntime,
  TurnTerminalSnapshot,
  AgentProfileDefinition,
  TeamDefinition,
  TeamConfigurationCapabilities,
  CardbushAppsConfiguration,
  CardbushAppPlugin,
} from '../types';
import type {
  GoalState as RuntimeGoalState,
  SessionSnapshot as RuntimeSessionSnapshot,
  SubagentTask as RuntimeSubagentTask,
  ToolExecutionRecord as RuntimeToolExecutionRecord,
  ToolExecutionSummary as RuntimeToolExecutionSummary,
} from '@cardbush/bush-protocol';
import { RUNTIME_REVERTED_WORKSPACE_CHANGE_IDS_METADATA_KEY } from '@cardbush/bush-protocol';
import { AGENT_PROFILE_PROTOCOL } from '../types';
import { standardImageInputToolDefaultName } from './toolVisibility';
import {
  readProductProjectContext,
  saveProductProjectContext,
} from './productProjectContext';
import { attachHistoryToolExecutions } from './historyToolAssociation';
import { isInternalRuntimeMessage } from './runtimeMessageVisibility';
import { contextWindowMetrics } from './contextWindowUsage';
import { toolArtifactsFromPayload } from './toolArtifacts';
import {
  projectRuntimeSessionMessage,
  projectRuntimeTurnMessages,
  restoreRuntimeTurnAttachmentMetadata,
} from './runtimeSessionMessageProjection';
import { streamRuntimeChat, streamRuntimeTurnEvents } from './runtimeChat';
import {
  CARDBUSH_APPS_MCP_SERVER_ID,
  readProductMcpServers,
  replaceProductMcpServers,
  synchronizeProductMcpSnapshot,
  validateProductMcpServer,
} from './productMcp';
import {
  readProductAgentProfiles,
  readProductTeams,
  replaceProductTeamConfiguration,
  resetProductTeamConfiguration,
  validateProductTeamConfiguration,
} from './productTeams';
import {
  answerRuntimeInteraction,
  answerRuntimeGenericInteraction,
  hasRuntimeGenericInteraction,
  registerRuntimeGenericInteraction,
  hasRuntimeInteraction,
  pendingRuntimeInteraction,
  stopActiveRuntimeTurn,
} from '../runtime-client/RuntimeInteractionBridge';
import { createDesktopRuntimeSession } from '../runtime-client/ElectronRuntimeSession';
import {
  closeRuntimeShadowConversation,
  createRuntimeShadowConversation,
  streamRuntimeShadowConversationMessage,
  updateRuntimeShadowConversationMode,
} from './shadowRuntime';

export const RUNTIME_ASSET_RESET_PROTOCOL = 'cardbush.runtime_asset_reset.v1';

function localizedClientMessage(zh: string, en: string): string {
  if (
    typeof document !== 'undefined' &&
    document.documentElement.lang.toLowerCase().startsWith('en')
  ) {
    return en;
  }
  return zh;
}

export interface BackendModelConfigsResult {
  defaultModelId: string;
  models: ManagedModelConfig[];
  raw: unknown;
}

export interface ExperimentalGoalA2AStatus {
  enabled: boolean;
  mode: string;
  goalProtocol: string;
  a2aProtocolVersion: string;
  mergedIntoCore: boolean;
}

export type ExperimentalGoalStatus =
  'active' | 'complete' | 'blocked' | 'cancelled';

export interface ExperimentalGoal {
  protocol: string;
  goalId: string;
  sessionId: string;
  objective: string;
  status: ExperimentalGoalStatus;
  statusReason: string;
  tokenBudget?: number;
  consumedTokens: number;
  linkedA2ATaskIds: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface A2AAgentCard {
  name: string;
  description: string;
  protocolVersions: string[];
  streaming: boolean;
  skills: Array<{
    id: string;
    name: string;
    description: string;
    tags: string[];
  }>;
  raw: Record<string, unknown>;
}

export interface A2ATask {
  id: string;
  contextId: string;
  state: string;
  statusMessage: string;
  artifactText: string;
  revision: number;
  raw: Record<string, unknown>;
}

export interface ChatStreamRequest {
  sessionId: string;
  userInput: string;
  submittedAt?: string;
  model: string;
  modelConfig?: ManagedModelConfig;
  projectDir?: string;
  workspaceDir?: string;
  projectUserPrompt?: string;
  allowedSkills?: string[];
  referencePlanMode?: ReferencePlanMode;
  permissionMode?: PermissionMode;
  subagentPermissionRouting?: SubagentPermissionRouting;
  reasoningLevel?: ReasoningLevel;
  reasoningTraceVisible?: boolean;
  interactiveRequestsEnabled?: boolean;
  standardImageInputEnabled?: boolean;
  browserPrivacyMode?: boolean;
  teamModeEnabled?: boolean;
  teamId?: string;
  osModeEnabled?: boolean;
  terminalRuntime?: TerminalRuntime;
  images?: Array<{ path: string }>;
  files?: string[];
  attachments?: ChatAttachment[];
  disabledTools?: string[];
  signal?: AbortSignal;
  onStart?: (start: StreamStart) => void;
  onDelta?: (delta: string, chunk: AssistantStreamChunk) => void;
  onAssistantSegmentCompleted?: (content: string, chunk: AssistantStreamChunk) => void;
  onExecution?: (update: StreamExecutionUpdate) => void;
  onAssistantRevision?: (revision: AssistantRevision) => void;
  onToolExecution?: (execution: ChatToolExecution) => void;
  onTaskPlanUpdate?: (update: TaskPlanStreamUpdate) => void;
  onInteractiveRequest?: (interaction: PendingInteraction) => void;
  onFinalAssistantText?: (text: string, chunk: AssistantStreamChunk) => void;
  onDone?: (terminal: TurnTerminalSnapshot) => void;
  onMessages?: (messages: ChatMessage[], finalSnapshot: boolean) => void;
  onTeamFlowEvent?: (event: TeamFlowStreamEvent) => void;
  onSubagentDispatch?: (event: SubagentDispatchEvent) => void;
  onThinking?: (event: ThinkingStreamEvent) => void;
  onConnectionState?: (update: RuntimeConnectionUpdate) => void;
  onContextWindowUsage?: (usage: RuntimeContextWindowUsage) => void;
  onCapabilityCandidates?: (update: CapabilityCandidatesUpdate) => void;
  onWorkflowEvent?: (event: TeamWorkflowStreamEvent) => void;
  onSceneEvent?: (event: SceneStreamEvent) => void;
}

export type ChatStreamEventHandlers = Pick<
  ChatStreamRequest,
  | 'sessionId'
  | 'signal'
  | 'onStart'
  | 'onDelta'
  | 'onAssistantSegmentCompleted'
  | 'onExecution'
  | 'onAssistantRevision'
  | 'onToolExecution'
  | 'onTaskPlanUpdate'
  | 'onInteractiveRequest'
  | 'onFinalAssistantText'
  | 'onDone'
  | 'onMessages'
  | 'onTeamFlowEvent'
  | 'onSubagentDispatch'
  | 'onThinking'
  | 'onConnectionState'
  | 'onContextWindowUsage'
  | 'onCapabilityCandidates'
  | 'onWorkflowEvent'
  | 'onSceneEvent'
> & {
  onReplayReset?: (payload: Record<string, unknown>) => void;
  onEventCursor?: (cursor: {
    eventName: string;
    eventId: string;
    sequence: number;
  }) => void;
};

export interface TurnEventStreamRequest extends ChatStreamEventHandlers {
  turnId: string;
  afterSequence?: number;
  lastEventId?: string;
}

export interface ControlStreamRequest {
  sessionId: string;
  model: string;
  modelConfig?: ManagedModelConfig;
  projectDir?: string;
  workspaceDir?: string;
  projectUserPrompt?: string;
  allowedSkills?: string[];
  referencePlanMode?: ReferencePlanMode;
  permissionMode?: PermissionMode;
  subagentPermissionRouting?: SubagentPermissionRouting;
  reasoningLevel?: ReasoningLevel;
  reasoningTraceVisible?: boolean;
  interactiveRequestsEnabled?: boolean;
  standardImageInputEnabled?: boolean;
  browserPrivacyMode?: boolean;
  teamModeEnabled?: boolean;
  teamId?: string;
  osModeEnabled?: boolean;
  terminalRuntime?: TerminalRuntime;
  images?: Array<{ path: string }>;
  files?: string[];
  attachments?: ChatAttachment[];
  disabledTools?: string[];
  signal?: AbortSignal;
  onStart?: (start: StreamStart) => void;
  onDelta?: (delta: string, chunk: AssistantStreamChunk) => void;
  onAssistantSegmentCompleted?: (content: string, chunk: AssistantStreamChunk) => void;
  onExecution?: (update: StreamExecutionUpdate) => void;
  onAssistantRevision?: (revision: AssistantRevision) => void;
  onToolExecution?: (execution: ChatToolExecution) => void;
  onTaskPlanUpdate?: (update: TaskPlanStreamUpdate) => void;
  onInteractiveRequest?: (interaction: PendingInteraction) => void;
  onFinalAssistantText?: (text: string, chunk: AssistantStreamChunk) => void;
  onDone?: (terminal: TurnTerminalSnapshot) => void;
  onMessages?: (messages: ChatMessage[], finalSnapshot: boolean) => void;
  onTeamFlowEvent?: (event: TeamFlowStreamEvent) => void;
  onSubagentDispatch?: (event: SubagentDispatchEvent) => void;
  onThinking?: (event: ThinkingStreamEvent) => void;
  onConnectionState?: (update: RuntimeConnectionUpdate) => void;
  onContextWindowUsage?: (usage: RuntimeContextWindowUsage) => void;
  onCapabilityCandidates?: (update: CapabilityCandidatesUpdate) => void;
  onWorkflowEvent?: (event: TeamWorkflowStreamEvent) => void;
  onSceneEvent?: (event: SceneStreamEvent) => void;
}

export interface EditMessageRequest extends ControlStreamRequest {
  messageId: string;
  content: string;
}

export interface SendGuidanceRequest {
  sessionId: string;
  turnId: string;
  guidance: string;
  clientMessageId: string;
  mode: 'append_context' | 'interrupt_and_continue';
  terminalRuntime?: TerminalRuntime;
  interactiveRequestsEnabled?: boolean;
  signal?: AbortSignal;
  onStart?: (start: StreamStart) => void;
  onDelta?: (delta: string, chunk: AssistantStreamChunk) => void;
  onAssistantSegmentCompleted?: (content: string, chunk: AssistantStreamChunk) => void;
  onExecution?: (update: StreamExecutionUpdate) => void;
  onAssistantRevision?: (revision: AssistantRevision) => void;
  onToolExecution?: (execution: ChatToolExecution) => void;
  onTaskPlanUpdate?: (update: TaskPlanStreamUpdate) => void;
  onInteractiveRequest?: (interaction: PendingInteraction) => void;
  onFinalAssistantText?: (text: string, chunk: AssistantStreamChunk) => void;
  onDone?: (terminal: TurnTerminalSnapshot) => void;
  onMessages?: (messages: ChatMessage[], finalSnapshot: boolean) => void;
  onTeamFlowEvent?: (event: TeamFlowStreamEvent) => void;
  onSubagentDispatch?: (event: SubagentDispatchEvent) => void;
  onThinking?: (event: ThinkingStreamEvent) => void;
  onConnectionState?: (update: RuntimeConnectionUpdate) => void;
  onContextWindowUsage?: (usage: RuntimeContextWindowUsage) => void;
  onCapabilityCandidates?: (update: CapabilityCandidatesUpdate) => void;
  onWorkflowEvent?: (event: TeamWorkflowStreamEvent) => void;
  onSceneEvent?: (event: SceneStreamEvent) => void;
}

export interface ShadowConversationRecord {
  id: string;
  sessionId: string;
  sourceTurnId: string;
  workspaceDir: string;
  agentName: string;
  mode: 'readonly' | 'fork';
  status: string;
  createdAt: string;
  updatedAt: string;
  raw: Record<string, unknown>;
}

export interface ShadowConversationStreamRequest {
  conversationId: string;
  content: string;
  clientMessageId: string;
  modelConfig: ManagedModelConfig;
  reasoningLevel?: ReasoningLevel;
  projectDir?: string;
  signal?: AbortSignal;
  onStart?: (messageId: string) => void;
  onDelta?: (delta: string) => void;
  onDone?: (message: {
    id: string;
    content: string;
    createdAt: string;
  }) => void;
}

interface SessionContextSearchItem {
  messageId: string;
  turnId: string;
  role: ChatMessage['role'];
  score: number;
  snippet: string;
  createdAt: string;
}

export interface SessionContextSearchResult {
  requestId: string;
  sessionId: string;
  queryFingerprint: string;
  items: SessionContextSearchItem[];
  nextCursor?: string;
  indexState: string;
}

export interface SessionMessageWindow {
  anchorMessageId: string;
  messages: ChatMessage[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  beforeCursor?: string;
  afterCursor?: string;
}

export interface TeamWorkflowStreamEvent {
  type: string;
  runId: string;
  workflowId: string;
  sessionId: string;
  turnId: string;
  nodeId: string;
  status: string;
  summary: string;
  raw: Record<string, unknown>;
}

export interface SceneStreamEvent {
  type: 'scene_presented' | 'scene_updated' | 'scene_closed';
  sceneId: string;
  sessionId: string;
  turnId: string;
  revision?: number;
  status: string;
  title: string;
  summary: string;
  scene?: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface TeamFlowActionRequest {
  flowId: string;
  action: TeamFlowActionType;
  text?: string;
  values?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export const defaultBackendCapabilities: BackendCapabilities = {
  chatStream: true,
  sessions: true,
  skills: true,
  interactions: true,
  interactiveRequests: false,
  permissionRequests: true,
  turnStop: true,
  turnEventReplay: false,
  runtimeInspection: true,
  maintenanceConversationHistoryClear: false,
  maintenanceLogsCacheClear: false,
  maintenanceRuntimeAssetsReset: false,
  runtimeAssetResetProtocol: '',
  runtimeAssetResetCategories: [],
  messageEditRegenerate: false,
  turnRegenerate: false,
  stableMessageIds: false,
  standardImageInputTool: false,
  standardImageInputToolName: standardImageInputToolDefaultName,
  projects: false,
  git: false,
  terminal: false,
  resources: false,
  settingsSync: false,
  mcpServers: false,
  subagents: false,
  subagentObservability: false,
  subagentObservabilityProtocol: '',
  subagentFrontendConfiguration: false,
  remoteAgentsViaMcp: false,
  teamMode: false,
  teamAgentFlow: false,
  teamFlowState: false,
  teamFlowActions: false,
  teamFlowEvents: false,
  teamWorkflows: false,
  workflowRuntime: false,
  shadowConversationActivation: false,
  contextWindowUsage: false,
  capabilityDiscovery: false,
  workspaceChanges: false,
  sessionContextSearch: false,
  sessionActivityOrdering: false,
  agentVisualScenes: false,
  browserCookiePersistence: false,
  browserPrivacyMode: false,
  browserApiCandidates: false,
  browserContextApiRequest: false,
  osMode: false,
  desktopAutomation: false,
  taskPlan: false,
  reasoningStream: false,
  reasoningLevelSelection: false,
  reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh', 'max'],
  defaultReasoningLevel: 'high',
  terminalRuntimeSelection: false,
  terminalRuntimes: ['powershell', 'wsl'],
  defaultTerminalRuntime: 'powershell',
};

export interface McpServerConfigInput {
  id: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  transport: McpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface SubagentDispatchRequest {
  sessionId: string;
  turnId?: string;
  agentName: string;
  prompt: string;
  runtimeProfile?: string;
  lane?: string;
  planNodeId?: string;
  exitCondition?: string;
  writeScope?: string[];
  waitSeconds?: number;
}

interface SubagentWriteLeaseResult {
  status?: string;
  policy?: string;
  scope: string[];
  conflicts: Array<Record<string, unknown>>;
  reason?: string;
  raw: Record<string, unknown>;
}

export interface SubagentDispatchResult {
  accepted: boolean;
  status: string;
  taskId?: string;
  childSessionId?: string;
  agentName: string;
  runtimeProfile?: string;
  resolvedRuntimeProfile?: string;
  resolvedHookSet?: string;
  lane?: string;
  planNodeId?: string;
  writeScope: string[];
  writeLease?: SubagentWriteLeaseResult;
  parentTurnId?: string;
  message?: string;
  reason?: string;
  supervisor?: SubagentSupervisorSnapshot;
  raw: Record<string, unknown>;
}

export interface ProjectContextResult {
  projectDir: string;
  userPrompt: string;
}

export interface MaintenanceClearResult {
  target: string;
  cleared: boolean;
  counts: Record<string, number>;
}

export interface SceneEventRequest {
  sessionId: string;
  sceneId: string;
  turnId?: string;
  event: string;
  nodeId?: string;
  text?: string;
  values?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface SessionMessagesResult {
  conversation: ConversationSummary;
  messages: ChatMessage[];
  toolExecutions: ChatToolExecution[];
  workspaceContext?: WorkspaceContext;
  latestTurn?: SessionLatestTurn;
}

export interface SessionLatestTurn {
  turnId: string;
  turnSequence?: number;
  status: RuntimeSessionSnapshot['turns'][number]['status'];
  stopped: boolean;
  stopReason: string;
  stopScenario: string;
  errorMessage: string;
  finalDecision: string;
  finalReason: string;
  stopDetails?: Record<string, unknown>;
  completedAt?: string;
  durationMs?: number;
  terminalEventSequence?: number;
}

export async function fetchBackendCapabilities(): Promise<BackendCapabilities> {
  const runtime = createDesktopRuntimeSession();
  try {
    const capabilities = await runtime.client.getCapabilities();
    const features = new Set(capabilities.features);
    const commands = new Set(capabilities.supportedCommands);
    return {
      ...defaultBackendCapabilities,
      chatStream: features.has('turn_stream'),
      sessions: features.has('append_only_session_context'),
      interactions:
        features.has('interactive_permissions') || features.has('generic_user_choice'),
      interactiveRequests: features.has('interactive_permissions'),
      permissionRequests: features.has('interactive_permissions'),
      turnStop: true,
      turnEventReplay: features.has('cursor_replay'),
      stableMessageIds: true,
      messageEditRegenerate: true,
      turnRegenerate: true,
      maintenanceConversationHistoryClear: true,
      maintenanceLogsCacheClear: true,
      maintenanceRuntimeAssetsReset: true,
      runtimeAssetResetProtocol: RUNTIME_ASSET_RESET_PROTOCOL,
      runtimeAssetResetCategories: ['prompts', 'skills', 'agent_profiles', 'teams'],
      shadowConversationActivation: true,
      standardImageInputTool: features.has('native_image_inputs'),
      projects: true,
      git: true,
      terminal: true,
      mcpServers: features.has('product_mcp_snapshot'),
      subagents: features.has('subagent_context_fork'),
      subagentObservability: features.has('subagent_context_fork'),
      subagentObservabilityProtocol: features.has('subagent_context_fork')
        ? 'bush.subagent_task.v1'
        : '',
      teamMode: features.has('product_team_snapshot'),
      teamAgentFlow: features.has('team_concurrent_execution'),
      contextWindowUsage: features.has('append_only_session_context'),
      workspaceChanges:
        features.has('authoritative_tool_execution_records') &&
        features.has('workspace_revert'),
      sessionContextSearch: true,
      sessionActivityOrdering: true,
      capabilityDiscovery: commands.has('runtime.get_tool_catalog_details'),
      osMode: true,
      desktopAutomation: features.has('bundled_cardbush_apps_mcp'),
      taskPlan: features.has('explicit_plan_facts'),
      reasoningStream: features.has('reasoning_segments'),
      reasoningLevelSelection: true,
      runtimeInspection: commands.has('runtime.get_session'),
    };
  } finally {
    runtime.dispose();
  }
}

export async function fetchBackendReadiness(): Promise<
  Record<string, unknown>
> {
  const runtime = createDesktopRuntimeSession();
  try {
    const capabilities = await runtime.client.getCapabilities();
    return {
      ready: true,
      source: 'electron_runtime',
      runtimeId: capabilities.hostId,
      runtimeVersion: capabilities.runtimeVersion,
      protocolVersions: [capabilities.protocol, capabilities.eventProtocol],
    };
  } finally {
    runtime.dispose();
  }
}

export class RuntimeWorkspaceSnapshotUnavailableError extends Error {
  readonly code = 'runtime_workspace_snapshot_unavailable';

  constructor() {
    super(
      'The TypeScript Runtime has no reversible workspace snapshot for this change.',
    );
    this.name = 'RuntimeWorkspaceSnapshotUnavailableError';
  }
}

export function isRuntimeWorkspaceSnapshotUnavailableError(
  error: unknown,
): error is RuntimeWorkspaceSnapshotUnavailableError {
  return error instanceof RuntimeWorkspaceSnapshotUnavailableError;
}

export async function fetchTeams(
  signal?: AbortSignal,
): Promise<TeamDefinition[]> {
  void signal;
  return readProductTeams();
}

export async function fetchTeam(
  teamId: string,
  signal?: AbortSignal,
): Promise<TeamDefinition> {
  void signal;
  const team = readProductTeams().find((item) => item.id === teamId.trim());
  if (!team)
    throw new Error(
      localizedClientMessage('团队不存在', 'Team does not exist'),
    );
  return team;
}

export async function validateTeamDefinition(
  team: TeamDefinition,
  signal?: AbortSignal,
) {
  const runtime = createDesktopRuntimeSession();
  try {
    await synchronizeProductMcpSnapshot(runtime.client);
    const tools = await runtime.client.getToolCatalog(signal);
    const teams = readProductTeams().filter((item) => item.id !== team.id);
    const result = validateProductTeamConfiguration({
      teams: [...teams, team],
      profiles: readProductAgentProfiles(),
      tools,
    });
    if (!result.success) {
      throw new Error(
        result.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('\n'),
      );
    }
    return team;
  } finally {
    runtime.dispose();
  }
}

export async function saveTeamDefinition(
  team: TeamDefinition,
  signal?: AbortSignal,
) {
  const runtime = createDesktopRuntimeSession();
  try {
    await synchronizeProductMcpSnapshot(runtime.client);
    const tools = await runtime.client.getToolCatalog(signal);
    const teams = readProductTeams();
    const index = teams.findIndex((item) => item.id === team.id);
    if (index >= 0) teams[index] = team;
    else teams.push(team);
    await replaceProductTeamConfiguration(runtime.client, {
      teams,
      profiles: readProductAgentProfiles(),
      tools,
    });
    return team;
  } finally {
    runtime.dispose();
  }
}

export async function deleteTeamDefinition(teamId: string): Promise<void> {
  const runtime = createDesktopRuntimeSession();
  try {
    await synchronizeProductMcpSnapshot(runtime.client);
    const tools = await runtime.client.getToolCatalog();
    await replaceProductTeamConfiguration(runtime.client, {
      teams: readProductTeams().filter((team) => team.id !== teamId.trim()),
      profiles: readProductAgentProfiles(),
      tools,
    });
    return;
  } finally {
    runtime.dispose();
  }
}

export async function fetchAgentProfiles(
  signal?: AbortSignal,
): Promise<AgentProfileDefinition[]> {
  void signal;
  return readProductAgentProfiles();
}

export async function fetchAgentProfile(
  profileId: string,
  signal?: AbortSignal,
) {
  void signal;
  const profile = readProductAgentProfiles().find(
    (item) => item.id === profileId.trim(),
  );
  if (!profile)
    throw new Error(
      localizedClientMessage(
        '成员配置不存在',
        'Agent configuration does not exist',
      ),
    );
  return profile;
}

export async function validateAgentProfile(
  profile: AgentProfileDefinition,
  signal?: AbortSignal,
) {
  const runtime = createDesktopRuntimeSession();
  try {
    await synchronizeProductMcpSnapshot(runtime.client);
    const tools = await runtime.client.getToolCatalog(signal);
    const profiles = readProductAgentProfiles().filter(
      (item) => item.id !== profile.id,
    );
    const result = validateProductTeamConfiguration({
      teams: readProductTeams(),
      profiles: [...profiles, profile],
      tools,
    });
    if (!result.success) {
      throw new Error(
        result.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('\n'),
      );
    }
    return profile;
  } finally {
    runtime.dispose();
  }
}

export async function saveAgentProfile(
  profile: AgentProfileDefinition,
  signal?: AbortSignal,
) {
  const runtime = createDesktopRuntimeSession();
  try {
    await synchronizeProductMcpSnapshot(runtime.client);
    const tools = await runtime.client.getToolCatalog(signal);
    const profiles = readProductAgentProfiles();
    const index = profiles.findIndex((item) => item.id === profile.id);
    if (index >= 0) profiles[index] = profile;
    else profiles.push(profile);
    await replaceProductTeamConfiguration(runtime.client, {
      teams: readProductTeams(),
      profiles,
      tools,
    });
    return profile;
  } finally {
    runtime.dispose();
  }
}

export async function deleteAgentProfile(profileId: string): Promise<void> {
  const normalized = profileId.trim();
  const runtime = createDesktopRuntimeSession();
  try {
    await synchronizeProductMcpSnapshot(runtime.client);
    const tools = await runtime.client.getToolCatalog();
    await replaceProductTeamConfiguration(runtime.client, {
      teams: readProductTeams(),
      profiles: readProductAgentProfiles().filter(
        (profile) => profile.id !== normalized,
      ),
      tools,
    });
    return;
  } finally {
    runtime.dispose();
  }
}

export async function fetchTeamConfigurationCapabilities(signal?: AbortSignal) {
  void signal;
  return {
    available: true,
    teamProtocol: 'bush.team_snapshot.v1',
    agentProfileProtocol: AGENT_PROFILE_PROTOCOL,
    contextProtocol: 'bush.session_snapshot.v1',
    delegationTool: 'team_delegate',
    ordinarySubagentProfileArgument: false,
    memberCapabilities: [
      'responsibility',
      'disabled_tools',
      'skills',
      'hooks',
      'guards',
      'prompts.instructions',
      'fallback',
    ],
    toolPolicy: 'explicit_snapshot',
    fallbackMemberRequired: true,
    fixedDag: false,
    profileOnlyHooks: [],
  } satisfies TeamConfigurationCapabilities;
}

export async function fetchExperimentalGoalA2AStatus(): Promise<ExperimentalGoalA2AStatus> {
  return {
    enabled: true,
    mode: 'electron_runtime',
    goalProtocol: 'bush.goal.v1',
    a2aProtocolVersion: '1.0',
    mergedIntoCore: false,
  };
}

export async function fetchExperimentalGoals(
  sessionId: string,
): Promise<ExperimentalGoal[]> {
  const normalized = sessionId.trim();
  if (!normalized) return [];
  const runtime = createDesktopRuntimeSession();
  try {
    const goal = await runtime.client.getGoal(normalized);
    return goal ? [runtimeExperimentalGoal(goal)] : [];
  } finally {
    runtime.dispose();
  }
}

export async function updateExperimentalGoal(request: {
  goalId: string;
  status: ExperimentalGoalStatus;
  statusReason?: string;
  expectedRevision: number;
}): Promise<ExperimentalGoal> {
  const runtime = createDesktopRuntimeSession();
  try {
    const sessions = await runtime.client.listSessions();
    let current: Awaited<ReturnType<typeof runtime.client.getGoal>> = null;
    for (const session of sessions) {
      const goal = await runtime.client.getGoal(session.sessionId);
      if (goal?.goalId === request.goalId) {
        current = goal;
        break;
      }
    }
    if (!current) {
      throw new Error(
        localizedClientMessage('目标不存在', 'Goal does not exist'),
      );
    }
    return runtimeExperimentalGoal(
      await runtime.client.updateGoal({
        goalId: current.goalId,
        sessionId: current.sessionId,
        expectedRevision: request.expectedRevision,
        status: request.status,
        statusReason: request.statusReason ?? '',
        consumedTokens: current.consumedTokens,
        linkedA2ATaskIds: current.linkedA2ATaskIds,
      }),
    );
  } finally {
    runtime.dispose();
  }
}

export async function inspectExperimentalA2AAgent(
  agentUrl: string,
): Promise<A2AAgentCard> {
  const inspect = window.cardbushDesktop?.a2aInspect;
  if (!inspect) throw new Error('CardBush A2A Host is unavailable.');
  return a2aAgentCardFromPayload(await inspect(agentUrl));
}

export async function dispatchExperimentalA2ATask(request: {
  agentUrl: string;
  text: string;
  goalId?: string;
  contextId?: string;
}): Promise<A2ATask> {
  const dispatch = window.cardbushDesktop?.a2aDispatch;
  if (dispatch) {
    let linkedGoal: RuntimeGoalState | null = null;
    let linkedRuntime: ReturnType<typeof createDesktopRuntimeSession> | null =
      null;
    if (request.goalId) {
      if (!window.cardbushDesktop?.runtime) {
        throw new Error(
          localizedClientMessage(
            '当前环境无法关联 Goal。',
            'The current environment cannot link an A2A task to a Goal.',
          ),
        );
      }
      linkedRuntime = createDesktopRuntimeSession();
      const sessions = await linkedRuntime.client.listSessions();
      for (const session of sessions) {
        const candidate = await linkedRuntime.client.getGoal(session.sessionId);
        if (candidate?.goalId === request.goalId) {
          linkedGoal = candidate;
          break;
        }
      }
      if (!linkedGoal || linkedGoal.status !== 'active') {
        linkedRuntime.dispose();
        throw new Error(
          localizedClientMessage(
            '关联的 Goal 不存在或已结束。',
            'The linked Goal is missing or no longer active.',
          ),
        );
      }
    }
    try {
      const payload = recordFromUnknown(
        await dispatch({
          agentUrl: request.agentUrl,
          text: request.text,
          ...(request.contextId ? { contextId: request.contextId } : {}),
        }),
      );
      const task = a2aTaskFromPayload(payload.task ?? payload);
      if (!linkedGoal || !linkedRuntime || !task.id) return task;
      try {
        await linkedRuntime.client.updateGoal({
          goalId: linkedGoal.goalId,
          sessionId: linkedGoal.sessionId,
          expectedRevision: linkedGoal.revision,
          status: linkedGoal.status,
          statusReason: linkedGoal.statusReason,
          consumedTokens: linkedGoal.consumedTokens,
          linkedA2ATaskIds: [
            ...new Set([...linkedGoal.linkedA2ATaskIds, task.id]),
          ],
        });
        return {
          ...task,
          raw: { ...task.raw, goalLink: { status: 'linked' } },
        };
      } catch (error) {
        return {
          ...task,
          raw: {
            ...task.raw,
            goalLink: {
              status: 'failed',
              message: error instanceof Error ? error.message : String(error),
            },
          },
        };
      }
    } finally {
      linkedRuntime?.dispose();
    }
  }
  throw new Error('CardBush A2A Host is unavailable.');
}

export async function fetchModelConfigs(): Promise<BackendModelConfigsResult> {
  return modelConfigsFromPayload(
    await productHostValue({ kind: 'models.get' }),
  );
}

function runtimeExperimentalGoal(goal: RuntimeGoalState): ExperimentalGoal {
  return {
    protocol: goal.protocol,
    goalId: goal.goalId,
    sessionId: goal.sessionId,
    objective: goal.objective,
    status: goal.status,
    statusReason: goal.statusReason,
    tokenBudget: goal.tokenBudget,
    consumedTokens: goal.consumedTokens,
    linkedA2ATaskIds: goal.linkedA2ATaskIds,
    revision: goal.revision,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt,
    completedAt: goal.completedAt,
  };
}

export async function saveModelConfigs(request: {
  defaultModelId?: string;
  models: ManagedModelConfig[];
}): Promise<BackendModelConfigsResult> {
  return modelConfigsFromPayload(
    await productHostValue({
      kind: 'models.update',
      config: {
        version: 1,
        defaultModelId: request.defaultModelId?.trim() ?? '',
        models: request.models,
      },
    }),
  );
}

export async function fetchCardbushAppsConfiguration(): Promise<CardbushAppsConfiguration> {
  return cardbushAppsConfigurationFromPayload(
    await productHostValue({ kind: 'apps.get' }),
  );
}

export async function saveCardbushAppsConfiguration(
  configuration: CardbushAppsConfiguration,
): Promise<CardbushAppsConfiguration> {
  const saved = cardbushAppsConfigurationFromPayload(
    await productHostValue({
      kind: 'apps.update',
      config: {
        serviceEnabled: configuration.serviceEnabled,
        plugins: configuration.plugins.map((plugin) => ({
          id: plugin.id,
          installed: plugin.installed,
          enabled: plugin.enabled,
          config: plugin.config,
        })),
      },
    }),
  );
  const runtime = createDesktopRuntimeSession();
  try {
    await synchronizeProductMcpSnapshot(runtime.client);
  } catch {
    // A running turn can temporarily lock the MCP catalog. The persisted Product Host
    // configuration is applied by the mandatory snapshot sync before the next turn.
  } finally {
    runtime.dispose();
  }
  return saved;
}

export async function fetchMcpServers(): Promise<McpServersResult> {
  const runtime = createDesktopRuntimeSession();
  try {
    const apps = await fetchCardbushAppsConfiguration();
    const servers = await readProductMcpServers();
    const result = await synchronizeProductMcpSnapshot(runtime.client).catch(
      () => null,
    );
    const toolCounts = new Map(
      result?.servers.map((server) => [server.id, server.tools.length]) ?? [],
    );
    const bundledApps = result?.servers.find((server) => server.id === 'cardbush_apps');
    return {
      servers: [
        ...([{
          id: 'cardbush_apps',
          name: 'CardBush Apps',
          description: 'Bundled independent MCP host for CardBush app plugins.',
          enabled: apps.serviceEnabled,
          transport: 'stdio' as const,
          args: [],
          toolCount: bundledApps?.tools.length ?? 0,
          status: apps.serviceEnabled ? (bundledApps ? 'connected' : 'unavailable') : 'disabled',
          raw: {
            source: 'cardbush_builtin_plugin',
            bundled: true,
            readOnly: true,
            tools: bundledApps?.tools ?? [],
            apps,
          },
        }]),
        ...servers.map((server) => ({
          ...server,
          toolCount: toolCounts.get(server.id) ?? 0,
          status: result
            ? server.enabled
              ? 'connected'
              : 'disabled'
            : 'unavailable',
        })),
      ],
      protocolVersions: ['2025-11-25', '2025-06-18'],
      raw: { source: 'cardbush_product', snapshot: result },
    };
  } finally {
    runtime.dispose();
  }
}

export async function validateMcpServerConfig(
  input: McpServerConfigInput,
): Promise<McpServerValidationResult> {
  const candidate = mcpServerFromPayload(mcpServerRequestBody(input));
  if (candidate.id === CARDBUSH_APPS_MCP_SERVER_ID) {
    return {
      ok: false,
      serverId: candidate.id,
      tools: [],
      messages: [{
        path: 'id',
        message: localizedClientMessage(
          'cardbush_apps 是内置插件服务的保留 ID',
          'cardbush_apps is reserved for the bundled plugin server',
        ),
        severity: 'error',
      }],
      raw: { source: 'cardbush_product', reserved: true },
    };
  }
  const result = validateProductMcpServer(candidate);
  return {
    ok: result.success,
    serverId: candidate.id,
    tools: [],
    messages: result.success
      ? []
      : result.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
          severity: 'error' as const,
        })),
    raw: result.success
      ? { source: 'cardbush_product' }
      : { issues: result.error.issues },
  };
}

export async function saveMcpServerConfig(
  input: McpServerConfigInput,
): Promise<McpServerConfig> {
  const normalized = input.id.trim();
  if (!normalized) {
    throw new Error(
      localizedClientMessage('MCP 服务 ID 为空', 'MCP server ID is empty'),
    );
  }
  if (normalized === CARDBUSH_APPS_MCP_SERVER_ID) {
    throw new Error(
      localizedClientMessage(
        'cardbush_apps 是内置插件服务的保留 ID',
        'cardbush_apps is reserved for the bundled plugin server',
      ),
    );
  }
  const candidate = mcpServerFromPayload(mcpServerRequestBody(input));
  const servers = await readProductMcpServers();
  const index = servers.findIndex((server) => server.id === normalized);
  if (index >= 0) servers[index] = candidate;
  else servers.push(candidate);
  const runtime = createDesktopRuntimeSession();
  try {
    const result = await replaceProductMcpServers(runtime.client, servers);
    const connected = result.servers.find(
      (server) => server.id === candidate.id,
    );
    return {
      ...candidate,
      toolCount: connected?.tools.length ?? 0,
      status: candidate.enabled ? 'connected' : 'disabled',
    };
  } finally {
    runtime.dispose();
  }
}

export async function setMcpServerEnabled(
  serverId: string,
  enabled: boolean,
): Promise<McpServerConfig> {
  const normalized = serverId.trim();
  if (!normalized) {
    throw new Error(
      localizedClientMessage('MCP 服务 ID 为空', 'MCP server ID is empty'),
    );
  }
  const servers = await readProductMcpServers();
  const index = servers.findIndex((server) => server.id === normalized);
  if (index < 0) {
    throw new Error(
      localizedClientMessage('MCP 服务不存在', 'MCP server does not exist'),
    );
  }
  servers[index] = { ...servers[index], enabled };
  const runtime = createDesktopRuntimeSession();
  try {
    const result = await replaceProductMcpServers(runtime.client, servers);
    const current = servers[index];
    return {
      ...current,
      toolCount:
        result.servers.find((server) => server.id === normalized)?.tools
          .length ?? 0,
      status: enabled ? 'connected' : 'disabled',
    };
  } finally {
    runtime.dispose();
  }
}

export async function deleteMcpServerConfig(
  serverId: string,
): Promise<Record<string, unknown>> {
  const normalized = serverId.trim();
  if (!normalized) {
    throw new Error(
      localizedClientMessage('MCP 服务 ID 为空', 'MCP server ID is empty'),
    );
  }
  const servers = await readProductMcpServers();
  const exists = servers.some((server) => server.id === normalized);
  if (!exists)
    return { id: normalized, deleted: false, source: 'cardbush_product' };
  const runtime = createDesktopRuntimeSession();
  try {
    await replaceProductMcpServers(
      runtime.client,
      servers.filter((server) => server.id !== normalized),
    );
    return { id: normalized, deleted: true, source: 'cardbush_product' };
  } finally {
    runtime.dispose();
  }
}

function modelConfigsFromPayload(payload: unknown): BackendModelConfigsResult {
  const root = recordFromUnknown(payload);
  const rawItems = Array.isArray(root.models)
    ? root.models
    : Array.isArray(root.items)
      ? root.items
      : [];
  const models = rawItems
    .map(managedModelConfigFromPayload)
    .filter((item): item is ManagedModelConfig => item !== null);
  return {
    defaultModelId: String(root.default_model_id ?? root.defaultModelId ?? ''),
    models,
    raw: payload,
  };
}

function a2aAgentCardFromPayload(payload: unknown): A2AAgentCard {
  const item = recordFromUnknown(payload);
  const capabilities = recordFromUnknown(item.capabilities);
  return {
    name: String(item.name ?? ''),
    description: String(item.description ?? ''),
    protocolVersions: stringList(
      item.protocolVersions ?? item.protocol_versions,
    ),
    streaming: capabilities.streaming === true,
    skills: arrayFrom(item.skills).map((raw) => {
      const skill = recordFromUnknown(raw);
      return {
        id: String(skill.id ?? ''),
        name: String(skill.name ?? skill.id ?? ''),
        description: String(skill.description ?? ''),
        tags: stringList(skill.tags),
      };
    }),
    raw: item,
  };
}

function a2aTaskFromPayload(payload: unknown): A2ATask {
  const item = recordFromUnknown(payload);
  const status = recordFromUnknown(item.status);
  const statusMessage = recordFromUnknown(status.message);
  const artifacts = arrayFrom(item.artifacts);
  const artifactText = artifacts
    .flatMap((artifact) => arrayFrom(recordFromUnknown(artifact).parts))
    .map((part) => String(recordFromUnknown(part).text ?? ''))
    .filter(Boolean)
    .join('\n');
  return {
    id: String(item.id ?? ''),
    contextId: String(item.contextId ?? item.context_id ?? ''),
    state: String(status.state ?? ''),
    statusMessage: arrayFrom(statusMessage.parts)
      .map((part) => String(recordFromUnknown(part).text ?? ''))
      .filter(Boolean)
      .join('\n'),
    artifactText,
    revision: numericValue(item.revision),
    raw: item,
  };
}

function managedModelConfigFromPayload(
  payload: unknown,
): ManagedModelConfig | null {
  const item = recordFromUnknown(payload);
  const provider = String(item.provider ?? '').trim();
  const modelName = String(
    item.modelName ?? item.model_name ?? item.model ?? item.name ?? '',
  ).trim();
  if (!provider || !modelName) {
    return null;
  }
  const maxContextTokens = positiveNumber(
    item.maxContextTokens ??
      item.max_context_tokens ??
      item.contextWindowTokens ??
      item.context_window_tokens ??
      item.maxInputTokens ??
      item.max_input_tokens,
  );
  const maxCompletionTokens = positiveNumber(
    item.maxCompletionTokens ??
      item.max_completion_tokens ??
      item.maxOutputTokens ??
      item.max_output_tokens,
  );
  return {
    id: String(item.id ?? ''),
    provider,
    apiKey: String(item.apiKey ?? item.api_key ?? ''),
    hasApiKey:
      item.hasApiKey === true ||
      item.has_api_key === true ||
      Boolean(String(item.apiKeyMasked ?? item.api_key_masked ?? '').trim()),
    apiKeyMasked: optionalString(item.apiKeyMasked ?? item.api_key_masked),
    modelName,
    baseUrl: String(item.baseUrl ?? item.base_url ?? item.llm_base_url ?? ''),
    ...(maxContextTokens ? { maxContextTokens } : {}),
    ...(maxCompletionTokens ? { maxCompletionTokens } : {}),
  };
}

function mcpServerRequestBody(input: McpServerConfigInput) {
  const body: Record<string, unknown> = {
    id: input.id.trim(),
    name: input.name?.trim() ?? '',
    description: input.description?.trim() ?? '',
    enabled: input.enabled !== false,
    transport: input.transport,
  };
  if (input.command?.trim()) {
    body.command = input.command.trim();
  }
  if (input.args?.length) {
    body.args = input.args;
  }
  if (input.cwd?.trim()) {
    body.cwd = input.cwd.trim();
  }
  if (input.env && Object.keys(input.env).length > 0) {
    body.env = input.env;
  }
  if (input.url?.trim()) {
    body.url = input.url.trim();
  }
  if (input.headers && Object.keys(input.headers).length > 0) {
    body.headers = input.headers;
  }
  return body;
}

function mcpServerFromPayload(payload: unknown, index = 0): McpServerConfig {
  const root = asRecord(payload);
  const item = asRecord(
    root.server ?? root.item ?? root.mcp_server ?? root.mcpServer ?? payload,
  );
  const id = String(
    item.id ?? item.name ?? item.server_id ?? item.serverId ?? `mcp-${index}`,
  ).trim();
  const transport = normalizeMcpTransport(
    item.transport ?? item.protocol ?? asRecord(item.connection).transport,
  );
  const command = optionalString(
    item.command ??
      item.cmd ??
      asRecord(item.stdio).command ??
      asRecord(item.connection).command,
  );
  const urlValue = optionalString(
    item.url ??
      item.endpoint ??
      asRecord(item.sse).url ??
      asRecord(item.connection).url,
  );
  const env = stringRecord(item.env ?? item.environment);
  const headers = stringRecord(item.headers ?? asRecord(item.sse).headers);
  return {
    id,
    name: String(
      item.label ?? item.display_name ?? item.displayName ?? item.name ?? id,
    ),
    description: String(item.description ?? item.summary ?? ''),
    enabled: item.enabled !== false,
    transport,
    ...(command ? { command } : {}),
    args: stringList(item.args ?? item.arguments ?? asRecord(item.stdio).args),
    cwd: optionalString(item.cwd ?? item.working_dir ?? item.workingDir),
    ...(env ? { env } : {}),
    ...(urlValue ? { url: urlValue } : {}),
    ...(headers ? { headers } : {}),
    toolCount: optionalNumber(
      item.tool_count ?? item.toolCount ?? asRecord(item.tools).count,
    ),
    status: optionalString(item.status ?? item.state),
    lastError: optionalString(item.last_error ?? item.lastError ?? item.error),
    raw: item,
  };
}

function normalizeMcpTransport(value: unknown): McpTransport {
  const text = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  if (text === 'sse') {
    return 'sse';
  }
  if (text === 'streamable_http' || text === 'streamablehttp') {
    return 'streamable_http';
  }
  if (text === 'http' || text === 'https') {
    return 'http';
  }
  return 'stdio';
}

function stringRecord(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const record: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const normalized = String(key ?? '').trim();
    if (normalized) {
      record[normalized] = String(raw ?? '');
    }
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

function recordFromUnknown(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function positiveNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

export async function fetchConversations(): Promise<ConversationSummary[]> {
  const runtime = createDesktopRuntimeSession();
  try {
    const sessions = await runtime.client.listSessions();
    return sessions
      .filter(
        (session) =>
          session.metadata?.agentRole !== 'child' &&
          session.metadata?.hidden !== true,
      )
      .map(runtimeConversation)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  } finally {
    runtime.dispose();
  }
}

export async function fetchMessages(
  sessionId: string,
  options: { includeSuperseded?: boolean } = {},
): Promise<ChatMessage[]> {
  const result = await fetchSessionMessages(sessionId, options);
  return result.messages;
}

export async function fetchSessionMessages(
  sessionId: string,
  options: { includeSuperseded?: boolean } = {},
): Promise<SessionMessagesResult> {
  const runtime = createDesktopRuntimeSession();
  try {
    const snapshot = await runtime.client.getConversationSession(sessionId);
    if (!snapshot) {
      return {
        conversation: {
          id: sessionId,
          title: sessionId,
          preview: '',
          updatedAt: new Date(0).toISOString(),
        },
        messages: [],
        toolExecutions: [],
      };
    }
    const superseded = new Set(
      options.includeSuperseded === false ? snapshot.supersededMessageIds : [],
    );
    const messages = snapshot.turns.flatMap((turn) => {
      const restoredTurn = restoreRuntimeTurnAttachmentMetadata(turn);
      return projectRuntimeTurnMessages({
        ...restoredTurn,
        messages: restoredTurn.messages
          .filter((message) => !superseded.has(message.messageId))
          .filter((message) => !isInternalRuntimeMessage(message)),
      }, snapshot.sessionId);
    });
    const records = (
      await Promise.all(
        snapshot.turns.map((turn) =>
          runtime.client.listTurnToolExecutionSummaries({
            sessionId: snapshot.sessionId,
            turnId: turn.turnId,
          }),
        ),
      )
    ).flat();
    const toolExecutions = records.map(runtimeHistoryToolExecution);
    const latest = snapshot.turns.at(-1);
    const projectDir = optionalString(snapshot.metadata?.projectDir);
    const taskDir = projectDir ? '' : taskWorkspaceDirectory(snapshot.metadata);
    const workspaceContext: WorkspaceContext | undefined = projectDir || taskDir
      ? {
          mode: projectDir ? 'project' : 'task',
          executionRoot: projectDir || taskDir,
          projectDir: projectDir || null,
          taskDir,
          source: 'electron_runtime',
        }
      : undefined;
    return {
      conversation: {
        ...runtimeConversation(snapshot),
        workspaceContext,
      },
      messages: attachHistoryToolExecutions(messages, toolExecutions),
      toolExecutions,
      workspaceContext,
      ...(latest
        ? {
            latestTurn: {
              turnId: latest.turnId,
              turnSequence: latest.turnSequence,
              status: latest.status,
              stopped: latest.status === 'stopped',
              stopReason: latest.reason,
              stopScenario: latest.reason,
              errorMessage: latest.status === 'failed' ? latest.reason : '',
              finalDecision: latest.status,
              finalReason: latest.reason,
              completedAt: latest.completedAt,
            },
          }
        : {}),
    };
  } finally {
    runtime.dispose();
  }
}

function runtimeConversation(
  snapshot: RuntimeSessionSnapshot,
): ConversationSummary {
  const visibleMessages = snapshot.turns
    .flatMap((turn) => turn.messages)
    .filter(
      (message) => !snapshot.supersededMessageIds.includes(message.messageId),
    )
    .filter((message) => !isInternalRuntimeMessage(message));
  const firstUserMessage = visibleMessages.find(
    (message) => message.message.role === 'user',
  );
  const lastAssistantMessage = [...visibleMessages]
    .reverse()
    .find((message) => message.message.role === 'assistant');
  const title =
    optionalString(snapshot.metadata?.title) ||
    initialRuntimeConversationTitle(firstUserMessage?.message.content) ||
    defaultConversationTitle(snapshot.sessionId);
  const projectDir = optionalString(snapshot.metadata?.projectDir);
  const projectId =
    optionalString(snapshot.metadata?.project_id) ||
    optionalString(snapshot.metadata?.projectId);
  return {
    id: snapshot.sessionId,
    title,
    preview: lastAssistantMessage?.message.content ?? '',
    updatedAt: snapshot.updatedAt,
    ...(projectId ? { projectId } : {}),
    ...(projectDir ? { projectDir } : {}),
    ...(snapshot.metadata ? { metadata: { ...snapshot.metadata } } : {}),
  };
}

function taskWorkspaceDirectory(metadata: Record<string, unknown> | undefined) {
  if (!metadata) return '';
  for (const candidate of [
    metadata.task_dir,
    metadata.taskDir,
    metadata.session_workspace_dir,
    metadata.sessionWorkspaceDir,
    metadata.workspace_dir,
    metadata.workspaceDir,
  ]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

function initialRuntimeConversationTitle(value: unknown) {
  const normalized = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  return normalized.length > 48 ? `${normalized.slice(0, 48)}…` : normalized;
}

function lexicalTerms(value: string) {
  return [
    ...new Set(
      value
        .normalize('NFKC')
        .toLocaleLowerCase()
        .split(/[^\p{L}\p{N}_]+/u)
        .map((term) => term.trim())
        .filter(Boolean),
    ),
  ];
}

function lexicalScore(content: string, terms: string[]) {
  if (terms.length === 0) return 0;
  const normalized = content.normalize('NFKC').toLocaleLowerCase();
  return (
    terms.reduce(
      (score, term) => score + (normalized.includes(term) ? 1 : 0),
      0,
    ) / terms.length
  );
}

function runtimeHistoryToolExecution(
  record: RuntimeToolExecutionRecord | RuntimeToolExecutionSummary,
): ChatToolExecution {
  const hasNativeResult = 'result' in record && record.result !== undefined;
  const artifacts = record.outcome === 'returned' && hasNativeResult
    ? toolArtifactsFromPayload({ result: record.result })
    : [];
  const output = hasNativeResult
    ? typeof record.result === 'string'
      ? record.result
      : JSON.stringify(record.result, null, 2) ?? 'null'
    : '';
  return {
    id: record.toolCall.id,
    name: record.toolCall.name,
    state: record.outcome === 'returned' ? 'completed' : record.outcome,
    summary: record.error?.message ?? record.toolCall.name,
    output,
    success: record.outcome === 'returned',
    durationMs: 0,
    createdAt: record.recordedAt,
    contentOffset: 0,
    sequence: record.ordinal,
    loopIndex: record.round,
    turnId: record.turnId,
    ...(artifacts.length > 0 ? { artifacts } : {}),
    metadata: {
      actionManifest: record.actionManifest,
      ...(hasNativeResult
        ? { nativeResult: record.result }
        : 'resultAvailable' in record
          ? {
              nativeResultDeferred: record.resultAvailable === true,
              workspaceChangeDetailsDeferred: record.workspaceChanges.some(
                (change) => change.detailAvailable,
              ),
            }
          : {}),
      workspaceChanges: record.workspaceChanges,
      error: record.error,
    },
  };
}

const runtimeTurnToolExecutionDetailCache = new Map<
  string,
  Promise<ChatToolExecution[]>
>();

export function fetchRuntimeTurnToolExecutionDetails(input: {
  sessionId: string;
  turnId: string;
}): Promise<ChatToolExecution[]> {
  const sessionId = input.sessionId.trim();
  const turnId = input.turnId.trim();
  if (!sessionId || !turnId) return Promise.resolve([]);
  const key = `${sessionId}\u0000${turnId}`;
  const cached = runtimeTurnToolExecutionDetailCache.get(key);
  if (cached) return cached;
  const pending = (async () => {
    const runtime = createDesktopRuntimeSession();
    try {
      const records = await runtime.client.listTurnToolExecutions({ sessionId, turnId });
      return records.map(runtimeHistoryToolExecution);
    } finally {
      runtime.dispose();
    }
  })();
  runtimeTurnToolExecutionDetailCache.set(key, pending);
  const release = () => {
    if (runtimeTurnToolExecutionDetailCache.get(key) === pending) {
      runtimeTurnToolExecutionDetailCache.delete(key);
    }
  };
  void pending.then(release, release);
  return pending;
}

export async function createConversation({
  title = '新会话',
  projectId,
  projectDir,
  sessionId,
  metadata,
}: {
  title?: string;
  projectId?: string;
  projectDir?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
} = {}): Promise<ConversationSummary> {
  const normalizedProjectDir = projectDir?.trim() || '';
  const normalizedProjectId = projectId?.trim() || '';
  const normalizedSessionId = sessionId?.trim() || `local-${crypto.randomUUID()}`;
  const normalizedMetadata: Record<string, unknown> = { ...(metadata ?? {}) };
  if (normalizedProjectDir) {
    normalizedMetadata.workspace_mode = 'project';
    normalizedMetadata.workspace_dir = normalizedProjectDir;
    normalizedMetadata.user_project_dir = normalizedProjectDir;
    normalizedMetadata.project_dir = normalizedProjectDir;
    if (normalizedProjectId) normalizedMetadata.project_id = normalizedProjectId;
  } else {
    const taskDir = await window.cardbushDesktop?.ensureTaskWorkspace?.(normalizedSessionId);
    normalizedMetadata.workspace_mode = 'task';
    if (taskDir) {
      normalizedMetadata.workspace_dir = taskDir;
      normalizedMetadata.task_dir = taskDir;
      normalizedMetadata.session_workspace_dir = taskDir;
    }
  }
  const runtime = createDesktopRuntimeSession();
  try {
    const snapshot = await runtime.client.createSession({
      sessionId: normalizedSessionId,
      metadata: {
        ...normalizedMetadata,
        title,
        ...(normalizedProjectDir ? { projectDir: normalizedProjectDir } : {}),
      },
    });
    return runtimeConversation(snapshot);
  } finally {
    runtime.dispose();
  }
}

export async function updateConversation({
  sessionId,
  title,
  projectId,
  projectDir,
  metadata,
}: {
  sessionId: string;
  title?: string;
  projectId?: string | null;
  projectDir?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<ConversationSummary> {
  const normalized = sessionId.trim();
  if (!normalized) {
    throw new Error(
      localizedClientMessage('会话 ID 为空', 'Conversation ID is empty'),
    );
  }
  const normalizedMetadata: Record<string, unknown> = { ...(metadata ?? {}) };
  if (projectId !== undefined) {
    normalizedMetadata.project_id = projectId?.trim() || null;
  }
  if (projectDir !== undefined) {
    const normalizedProjectDir = projectDir?.trim() || '';
    const taskDir = normalizedProjectDir
      ? ''
      : await window.cardbushDesktop?.ensureTaskWorkspace?.(normalized);
    normalizedMetadata.workspace_mode = normalizedProjectDir
      ? 'project'
      : 'task';
    normalizedMetadata.workspace_dir = normalizedProjectDir || taskDir || null;
    normalizedMetadata.task_dir = taskDir || null;
    normalizedMetadata.session_workspace_dir = taskDir || null;
    normalizedMetadata.user_project_dir = normalizedProjectDir || null;
    normalizedMetadata.project_dir = normalizedProjectDir || null;
  }
  const runtime = createDesktopRuntimeSession();
  try {
    const current = await runtime.client.getSession(normalized);
    if (!current) {
      throw new Error(
        localizedClientMessage('会话不存在', 'Conversation does not exist'),
      );
    }
    const nextMetadata: Record<string, unknown> = {
      ...(current.metadata ?? {}),
      ...normalizedMetadata,
      ...(title != null ? { title } : {}),
    };
    if (projectDir !== undefined) {
      nextMetadata.projectDir = projectDir?.trim() || null;
    }
    const snapshot = await runtime.client.updateSessionMetadata({
      sessionId: normalized,
      expectedRevision: current.revision,
      metadata: nextMetadata,
    });
    return runtimeConversation(snapshot);
  } finally {
    runtime.dispose();
  }
}

export async function deleteConversationApi(sessionId: string) {
  const normalized = sessionId.trim();
  if (!normalized) {
    return false;
  }
  const runtime = createDesktopRuntimeSession();
  try {
    return (await runtime.client.deleteSession(normalized)).deleted;
  } finally {
    runtime.dispose();
  }
}

export async function recordAssistantLogicFeedback(
  message: ChatMessage,
  rating: 'up' | 'down' | null,
) {
  const sessionId = message.conversationId?.trim() ?? '';
  const turnId = message.turnId?.trim() ?? '';
  const messageId = message.id.trim();
  if (!sessionId || !turnId || !messageId || message.role !== 'assistant') {
    return null;
  }
  const runtime = createDesktopRuntimeSession();
  try {
    return await runtime.client.recordLogicFeedback({
      sessionId,
      turnId,
      messageId,
      rating,
    });
  } finally {
    runtime.dispose();
  }
}

const productHostProtocol = 'cardbush.product_host_ipc.v1';

export class ProductHostCommandError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProductHostCommandError';
    this.code = code;
  }
}

function cardbushAppsConfigurationFromPayload(
  payload: Record<string, unknown>,
): CardbushAppsConfiguration {
  const plugins = arrayFrom(payload.plugins).map((candidate): CardbushAppPlugin => {
    const value = asRecord(candidate);
    return {
      id: String(value.id ?? ''),
      name: String(value.name ?? value.id ?? ''),
      description: String(value.description ?? ''),
      longDescription: String(value.longDescription ?? value.description ?? ''),
      version: String(value.version ?? ''),
      developerName: String(value.developerName ?? ''),
      category: String(value.category ?? ''),
      capabilities: arrayFrom(value.capabilities).map(String).filter(Boolean),
      keywords: arrayFrom(value.keywords).map(String).filter(Boolean),
      defaultPrompts: arrayFrom(value.defaultPrompts).map(String).filter(Boolean),
      brandColor: String(value.brandColor ?? ''),
      logoPath: String(value.logoPath ?? ''),
      logoDarkPath: String(value.logoDarkPath ?? ''),
      manifestPath: String(value.manifestPath ?? ''),
      source: value.source === 'user' ? 'user' : 'bundled',
      installation: value.installation === 'INSTALLED_BY_DEFAULT'
        ? 'INSTALLED_BY_DEFAULT'
        : 'AVAILABLE',
      components: arrayFrom(value.components).map((candidate) => {
        const component = asRecord(candidate);
        const kind = component.kind === 'skill' || component.kind === 'app' ? component.kind : 'mcp';
        return {
          kind,
          id: String(component.id ?? ''),
          name: String(component.name ?? component.id ?? ''),
          description: String(component.description ?? ''),
        };
      }),
      installed: value.installed === true,
      enabled: value.enabled === true,
      config: asRecord(value.config),
    };
  });
  return {
    protocol: String(payload.protocol ?? ''),
    revision: finiteNumber(payload.revision),
    serviceEnabled: payload.serviceEnabled === true,
    plugins,
  };
}

export function isProductHostCommandError(
  error: unknown,
  code?: string,
): error is ProductHostCommandError {
  return error instanceof ProductHostCommandError && (code == null || error.code === code);
}

async function productHostValue(
  command: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const execute = window.cardbushDesktop?.productHostCommand;
  if (execute == null) {
    throw new Error(
      localizedClientMessage(
        'CardBush 产品宿主仅在桌面客户端中可用。',
        'The CardBush Product Host is only available in the desktop client.',
      ),
    );
  }
  const payload = asRecord(
    await execute({ protocol: productHostProtocol, ...command }),
  );
  if (payload.protocol !== productHostProtocol) {
    throw new Error(
      'CardBush Product Host returned an incompatible protocol response.',
    );
  }
  if (payload.ok !== true) {
    const error = asRecord(payload.error);
    throw new ProductHostCommandError(
      String(error.code ?? 'product_host_command_failed'),
      String(error.message ?? error.code ?? 'Product Host command failed'),
    );
  }
  return asRecord(payload.value);
}

export async function clearConversationHistory(): Promise<MaintenanceClearResult> {
  const runtime = createDesktopRuntimeSession();
  try {
    const sessions = await runtime.client.listSessions();
    let deleted = 0;
    for (const session of sessions) {
      if ((await runtime.client.deleteSession(session.sessionId)).deleted)
        deleted += 1;
    }
    return {
      target: 'conversation_history',
      cleared: true,
      counts: { sessions: deleted },
    };
  } finally {
    runtime.dispose();
  }
}

export async function clearLogsCache(): Promise<MaintenanceClearResult> {
  return maintenanceClearResultFromPayload(
    await productHostValue({ kind: 'maintenance.clear_logs_cache' }),
  );
}

export async function fetchRuntimeAssetResetPlan(): Promise<RuntimeAssetResetPlan> {
  const plan = runtimeAssetResetPlanFromPayload(
    await productHostValue({ kind: 'maintenance.runtime_assets.plan' }),
  );
  assertRuntimeAssetResetProtocol(plan.protocol);
  return plan;
}

export async function resetRuntimeAssets(
  categories: RuntimeAssetCategory[],
): Promise<RuntimeAssetResetResult> {
  const selected = [...new Set(categories)];
  const resetsTeams = selected.includes('teams') || selected.includes('agent_profiles');
  if (resetsTeams && !(selected.includes('teams') && selected.includes('agent_profiles'))) {
    throw new ProductHostCommandError(
      'team_configuration_reset_pair_required',
      localizedClientMessage(
        'Teams 与 Agent Profiles 存在引用关系，必须一起恢复。',
        'Teams and Agent Profiles reference each other and must be restored together.',
      ),
    );
  }
  const result = runtimeAssetResetResultFromPayload(
    await productHostValue({
      kind: 'maintenance.runtime_assets.reset',
      categories: selected,
      confirm: true,
    }),
  );
  if (resetsTeams) {
    const runtime = createDesktopRuntimeSession();
    try {
      await synchronizeProductMcpSnapshot(runtime.client);
      const tools = await runtime.client.getToolCatalog();
      await resetProductTeamConfiguration(runtime.client, tools);
      for (const category of ['agent_profiles', 'teams'] as const) {
        const current = result.categories[category];
        result.categories[category] = {
          changed: true,
          sourcePath: current?.sourcePath ?? 'bundled-defaults',
          targetPath: current?.targetPath ?? 'product-configuration',
          seedFileCount: 1,
          restoredFileCount: 1,
          removedRuntimeFileCount: 0,
        };
      }
      result.changed = true;
    } finally {
      runtime.dispose();
    }
  }
  assertRuntimeAssetResetProtocol(result.protocol);
  return result;
}

export async function fetchRuntimeMaintenanceLogs(): Promise<{
  chain: unknown[];
  toolFailures: unknown[];
}> {
  const payload = await productHostValue({ kind: 'maintenance.diagnostics' });
  return {
    chain: arrayFrom(payload.chain),
    toolFailures: arrayFrom(payload.toolFailures),
  };
}

export async function createShadowConversation({
  sessionId,
  sourceTurnId,
  clientConversationId,
  mode,
}: {
  sessionId: string;
  sourceTurnId?: string;
  clientConversationId: string;
  mode: 'readonly' | 'fork';
}): Promise<ShadowConversationRecord> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    throw new Error(
      localizedClientMessage(
        'Shadow 需要一个已建立的会话',
        'Shadow requires an existing conversation',
      ),
    );
  }
  return createRuntimeShadowConversation({
    sessionId: normalizedSessionId,
    sourceTurnId,
    clientConversationId,
    mode,
  });
}

export async function closeShadowConversation(
  conversationId: string,
): Promise<void> {
  const normalizedConversationId = conversationId.trim();
  if (!normalizedConversationId) return;
  await closeRuntimeShadowConversation(normalizedConversationId);
}

export async function updateShadowConversationMode(
  conversationId: string,
  mode: 'readonly' | 'fork',
): Promise<ShadowConversationRecord> {
  const normalizedConversationId = conversationId.trim();
  if (!normalizedConversationId) {
    throw new Error(
      localizedClientMessage(
        'Shadow 会话不存在',
        'The Shadow conversation does not exist',
      ),
    );
  }
  return updateRuntimeShadowConversationMode(normalizedConversationId, mode);
}

export async function streamShadowConversationMessage(
  request: ShadowConversationStreamRequest,
): Promise<void> {
  const conversationId = request.conversationId.trim();
  const content = request.content.trim();
  if (!conversationId || !content) return;
  await streamRuntimeShadowConversationMessage({
    ...request,
    conversationId,
    content,
  });
}

export async function searchSessionContext({
  sessionId,
  query,
  limit = 8,
  cursor,
  roles = ['user'],
  excludeMessageIds,
  requestId,
  signal,
}: {
  sessionId: string;
  query: string;
  limit?: number;
  cursor?: string;
  roles?: ChatMessage['role'][];
  excludeMessageIds?: string[];
  requestId?: string;
  signal?: AbortSignal;
}): Promise<SessionContextSearchResult> {
  const runtime = createDesktopRuntimeSession();
  try {
    const snapshot = await runtime.client.getSession(sessionId.trim(), signal);
    const excluded = new Set(excludeMessageIds ?? []);
    const terms = lexicalTerms(query);
    const offset = Math.max(0, Number(cursor) || 0);
    const items = (snapshot?.turns.flatMap((turn) =>
      turn.messages.map((message) => ({ message, turn })),
    ) ?? [])
      .filter(({ message }) => !excluded.has(message.messageId))
      .filter(({ message }) => !isInternalRuntimeMessage(message))
      .map(({ message, turn }) => ({
        message,
        projected: projectRuntimeSessionMessage(message, sessionId, turn),
      }))
      .filter(({ projected }) => roles.includes(projected.role))
      .map(({ message, projected }) => ({
        messageId: message.messageId,
        turnId: message.turnId,
        role: projected.role,
        score: lexicalScore(projected.content, terms),
        snippet: projected.content.slice(0, 800),
        createdAt: message.createdAt,
      }))
      .filter((item) => item.score > 0)
      .sort(
        (left, right) =>
          right.score - left.score ||
          right.createdAt.localeCompare(left.createdAt),
      );
    const page = items.slice(offset, offset + limit);
    return {
      requestId: requestId ?? `context_${crypto.randomUUID()}`,
      sessionId: snapshot?.sessionId ?? sessionId,
      queryFingerprint: lexicalTerms(query).join('|'),
      items: page,
      nextCursor:
        offset + page.length < items.length
          ? String(offset + page.length)
          : undefined,
      indexState: 'electron_runtime_exact_history',
    };
  } finally {
    runtime.dispose();
  }
}

export async function fetchSessionMessageWindow({
  sessionId,
  messageId,
  before = 6,
  after = 6,
  signal,
}: {
  sessionId: string;
  messageId: string;
  before?: number;
  after?: number;
  signal?: AbortSignal;
}): Promise<SessionMessageWindow> {
  const runtime = createDesktopRuntimeSession();
  try {
    const snapshot = await runtime.client.getSession(sessionId.trim(), signal);
    const messages = (
      snapshot?.turns.flatMap((turn) =>
        turn.messages.map((message) => ({ message, turn })),
      ) ?? []
    ).filter(({ message }) => !isInternalRuntimeMessage(message));
    const anchor = messages.findIndex(
      ({ message }) => message.messageId === messageId.trim(),
    );
    if (anchor < 0) {
      throw new Error(
        localizedClientMessage('消息不存在', 'Message does not exist'),
      );
    }
    const start = Math.max(0, anchor - before);
    const end = Math.min(messages.length, anchor + after + 1);
    return {
      anchorMessageId: messageId,
      messages: messages
        .slice(start, end)
        .map(({ message, turn }) => projectRuntimeSessionMessage(message, sessionId, turn)),
      hasMoreBefore: start > 0,
      hasMoreAfter: end < messages.length,
      beforeCursor: start > 0 ? String(start) : undefined,
      afterCursor: end < messages.length ? String(end) : undefined,
    };
  } finally {
    runtime.dispose();
  }
}

export async function fetchSessionTurnMessages({
  sessionId,
  messageId,
  signal,
}: {
  sessionId: string;
  messageId: string;
  signal?: AbortSignal;
}): Promise<ChatMessage[]> {
  const runtime = createDesktopRuntimeSession();
  try {
    const snapshot = await runtime.client.getSession(sessionId.trim(), signal);
    const turn = snapshot?.turns.find((candidate) =>
      candidate.messages.some((message) => message.messageId === messageId.trim()),
    );
    if (!turn) {
      throw new Error(
        localizedClientMessage('消息不存在', 'Message does not exist'),
      );
    }
    const restored = restoreRuntimeTurnAttachmentMetadata(turn);
    return projectRuntimeTurnMessages({
      ...restored,
      messages: restored.messages.filter((message) => !isInternalRuntimeMessage(message)),
    }, snapshot?.sessionId ?? sessionId);
  } finally {
    runtime.dispose();
  }
}

export async function fetchSessionContextWindowUsage(
  sessionId: string,
  signal?: AbortSignal,
): Promise<RuntimeContextWindowUsage> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    throw new Error('session_id is required');
  }
  const runtime = createDesktopRuntimeSession();
  try {
    const snapshot = await runtime.client.getSession(normalizedSessionId, signal);
    const latest = snapshot?.turns.at(-1);
    const contextMetrics = contextWindowMetrics(latest?.usage);
    return {
      sessionId: normalizedSessionId,
      turnId: latest?.turnId ?? '',
      model: typeof latest?.usage.model === 'string' ? latest.usage.model : '',
      ...contextMetrics,
      measuredAt:
        latest?.completedAt ?? snapshot?.updatedAt ?? new Date().toISOString(),
      source: 'electron_runtime_latest_request',
      raw: {
        usage: latest?.usage ?? {},
        measurement: 'last_request_input_tokens',
      },
    };
  } finally {
    runtime.dispose();
  }
}

export async function fetchSessionTokenUsage(
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionTokenUsage> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    throw new Error('session_id is required');
  }
  const runtime = createDesktopRuntimeSession();
  try {
    const snapshot = await runtime.client.getSession(
      normalizedSessionId,
      signal,
    );
    const totals = (snapshot?.turns ?? []).reduce(
      (current, turn) => ({
        prompt: current.prompt + (turn.usage.inputTokens ?? 0),
        completion: current.completion + (turn.usage.outputTokens ?? 0),
        cache: current.cache + (turn.usage.cachedInputTokens ?? 0),
      }),
      { prompt: 0, completion: 0, cache: 0 },
    );
    return {
      sessionId: normalizedSessionId,
      promptTokens: totals.prompt,
      completionTokens: totals.completion,
      totalTokens: totals.prompt + totals.completion,
      promptCacheHitTokens: totals.cache,
      promptCacheMissTokens: Math.max(0, totals.prompt - totals.cache),
    };
  } finally {
    runtime.dispose();
  }
}

export async function fetchSessionWorkspaceChanges(
  sessionId: string,
  signal?: AbortSignal,
): Promise<ChatToolExecution[]> {
  const normalized = sessionId.trim();
  if (!normalized) return [];
  const runtime = createDesktopRuntimeSession();
  try {
    const snapshot = await runtime.client.getSession(normalized, signal);
    if (!snapshot) return [];
    const records = (
      await Promise.all(
        snapshot.turns.map((turn) =>
          runtime.client.listTurnToolExecutions(
            { sessionId: normalized, turnId: turn.turnId },
            signal,
          ),
        ),
      )
    ).flat();
    const revertedChangeIds = new Set(
      Array.isArray(snapshot.metadata?.[RUNTIME_REVERTED_WORKSPACE_CHANGE_IDS_METADATA_KEY])
        ? snapshot.metadata[RUNTIME_REVERTED_WORKSPACE_CHANGE_IDS_METADATA_KEY]
            .filter((value): value is string => typeof value === 'string')
        : [],
    );
    return records
      .map((record) => ({
        ...record,
        workspaceChanges: record.workspaceChanges.filter(
          (change) => !revertedChangeIds.has(change.change_id),
        ),
      }))
      .filter((record) => record.workspaceChanges.length > 0)
      .map(runtimeHistoryToolExecution);
  } finally {
    runtime.dispose();
  }
}

interface SendGuidanceResponse {
  continuationQueued: boolean;
  willContinueAfterCurrentRound: boolean;
  guidance: {
    clientMessageId: string;
    mode: 'append_context' | 'interrupt_and_continue';
  };
}

export async function revertSessionWorkspaceChanges(
  sessionId: string,
  turnIds: string[],
): Promise<{
  revertedFiles: number;
  revertedChangeIds: string[];
  revertedAt: string;
  turnIds: string[];
}> {
  const normalizedSession = sessionId.trim();
  const normalizedTurns = [
    ...new Set(turnIds.map((value) => value.trim()).filter(Boolean)),
  ];
  if (!normalizedSession || normalizedTurns.length === 0) {
    throw new Error('session_id and turn_ids are required');
  }
  const runtime = createDesktopRuntimeSession();
  try {
    let result;
    try {
      result = await runtime.client.revertWorkspaceChanges({
        sessionId: normalizedSession,
        turnIds: normalizedTurns,
      });
    } catch (error) {
      if (runtimeProtocolErrorCode(error) === 'runtime_workspace_snapshot_unavailable') {
        throw new RuntimeWorkspaceSnapshotUnavailableError();
      }
      throw error;
    }
    return {
      revertedFiles: result.revertedFiles,
      revertedChangeIds: result.revertedChangeIds,
      revertedAt: result.revertedAt,
      turnIds: result.turnIds,
    };
  } finally {
    runtime.dispose();
  }
}

export async function fetchTeamFlow(
  sessionId: string,
): Promise<TeamFlowState | null> {
  const normalized = sessionId.trim();
  if (!normalized) {
    throw new Error(
      localizedClientMessage(
        'Team Flow session_id 为空',
        'Team Flow session_id is empty',
      ),
    );
  }
  return null;
}

export async function sendTeamFlowAction(
  request: TeamFlowActionRequest,
): Promise<TeamFlowState> {
  const flowId = request.flowId.trim();
  if (!flowId) {
    throw new Error(
      localizedClientMessage('Team Flow ID 为空', 'Team Flow ID is empty'),
    );
  }
  throw new Error(
    localizedClientMessage(
      '旧 Team Flow 动作协议已停用；当前 Team 由显式配置和 team_delegate 工具执行。',
      'Legacy Team Flow actions are retired; Teams execute through explicit configuration and team_delegate.',
    ),
  );
}

export async function fetchSubagentCapabilities(): Promise<SubagentCapabilities> {
  const runtime = createDesktopRuntimeSession();
  try {
    const tools = await runtime.client.getToolCatalog();
    return {
      models: [],
      tools: tools.map((tool) => tool.name),
      toolPackages: [],
      skills: [],
      permissionLevels: ['allow', 'ask'],
      runModes: ['concurrent_context_fork'],
      toolProfiles: [],
    };
  } finally {
    runtime.dispose();
  }
}

export async function fetchSubagentRuntime(): Promise<SubagentRuntimeResult> {
  const runtime = createDesktopRuntimeSession();
  try {
    const sessions = await runtime.client.listSessions();
    const tasks = (
      await Promise.all(
        sessions.map((session) =>
          runtime.client.listSubagentTasks({
            parentSessionId: session.sessionId,
          }),
        ),
      )
    ).flat();
    return {
      activeTasks: tasks
        .filter((task) => task.status === 'running')
        .map((task) => ({ ...task })),
      items: [],
      usage: tasks.reduce(
        (usage, task) => ({
          inputTokens:
            Number(usage.inputTokens ?? 0) + (task.usage.inputTokens ?? 0),
          outputTokens:
            Number(usage.outputTokens ?? 0) + (task.usage.outputTokens ?? 0),
        }),
        {} as Record<string, unknown>,
      ),
    };
  } finally {
    runtime.dispose();
  }
}

export async function fetchSubagentTasks(
  sessionId: string,
  options?: { activeOnly?: boolean; limit?: number; signal?: AbortSignal },
): Promise<SubagentTaskSnapshot[]> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) return [];
  const runtime = createDesktopRuntimeSession();
  try {
    const tasks = await runtime.client.listSubagentTasks(
      { parentSessionId: normalizedSessionId },
      options?.signal,
    );
    return tasks
      .filter((task) => !options?.activeOnly || task.status === 'running')
      .slice(0, Math.max(1, options?.limit ?? 100))
      .map(runtimeSubagentTask);
  } finally {
    runtime.dispose();
  }
}

export async function fetchSubagentTask(
  taskId: string,
  signal?: AbortSignal,
): Promise<SubagentTaskSnapshot> {
  const normalizedTaskId = taskId.trim();
  if (!normalizedTaskId) {
    throw new Error(
      localizedClientMessage('子任务 ID 为空', 'Subagent task ID is empty'),
    );
  }
  const runtime = createDesktopRuntimeSession();
  try {
    const sessions = await runtime.client.listSessions(signal);
    for (const session of sessions) {
      const task = await runtime.client.getSubagentTask(
        {
          parentSessionId: session.sessionId,
          taskId: normalizedTaskId,
        },
        signal,
      );
      if (task) return runtimeSubagentTask(task);
    }
    throw new Error(
      localizedClientMessage('子任务不存在', 'Subagent task does not exist'),
    );
  } finally {
    runtime.dispose();
  }
}

export async function fetchTurnSnapshot(
  turnId: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const normalizedTurnId = turnId.trim();
  if (!normalizedTurnId) {
    throw new Error(localizedClientMessage('Turn ID 为空', 'Turn ID is empty'));
  }
  const runtime = createDesktopRuntimeSession();
  try {
    const sessions = await runtime.client.listSessions(signal);
    for (const session of sessions) {
      const turn = session.turns.find(
        (item) => item.turnId === normalizedTurnId,
      );
      if (turn)
        return {
          ...turn,
          sessionId: session.sessionId,
          source: 'electron_runtime',
        };
    }
    throw new Error(
      localizedClientMessage('Turn 不存在', 'Turn does not exist'),
    );
  } finally {
    runtime.dispose();
  }
}

export async function dispatchSubagent(
  _request: SubagentDispatchRequest,
): Promise<SubagentDispatchResult> {
  throw new Error(
    localizedClientMessage(
      '子 Agent 由运行中的主 Agent 通过 subagent 工具派发，产品层不再伪造独立派发上下文。',
      'Subagents are dispatched by the active parent Agent through the subagent tool.',
    ),
  );
}

export async function fetchSkills(): Promise<SkillSummary[]> {
  const listSkills = window.cardbushDesktop?.listSkills;
  if (!listSkills) throw new Error('CardBush Skill catalog is unavailable.');
  const items = await listSkills();
  return items.map((item) => {
    const value = asRecord(item);
    return {
      name: String(value.name ?? ''),
      description: String(value.description ?? ''),
      descriptionZh: String(value.descriptionZh ?? value.description_zh ?? ''),
      path: String(value.path ?? ''),
      logoPath: String(value.logoPath ?? value.logo_path ?? ''),
      logoDarkPath: String(value.logoDarkPath ?? value.logo_dark_path ?? ''),
      source: skillSource(value.source),
      sourceId: String(value.sourceId ?? value.source_id ?? ''),
      sourceLabel: String(value.sourceLabel ?? value.source_label ?? ''),
    };
  });
}

export async function fetchSkillDetail(
  skillName: string,
): Promise<SkillDetail> {
  const normalized = skillName.trim();
  if (!normalized) {
    throw new Error(
      localizedClientMessage('Skill 名称为空', 'Skill name is empty'),
    );
  }
  const readSkill = window.cardbushDesktop?.readSkill;
  if (!readSkill) throw new Error('CardBush Skill catalog is unavailable.');
  return skillDetailFromPayload(await readSkill(normalized));
}

export async function fetchProjectContext(
  projectDir: string,
): Promise<ProjectContextResult> {
  const normalized = projectDir.trim();
  if (!normalized) {
    return { projectDir: '', userPrompt: '' };
  }
  return readProductProjectContext(normalized);
}

export async function saveProjectContext({
  projectDir,
  userPrompt,
}: {
  projectDir: string;
  userPrompt: string;
}): Promise<ProjectContextResult> {
  return saveProductProjectContext({ projectDir, userPrompt });
}

export async function fetchPendingInteraction(
  sessionId: string,
): Promise<PendingInteraction | null> {
  const normalized = sessionId.trim();
  if (!normalized) {
    return null;
  }
  const runtimeInteraction = pendingRuntimeInteraction(normalized);
  if (runtimeInteraction) return runtimeInteraction;
  const runtime = createDesktopRuntimeSession();
  try {
    const pending = (await runtime.client.pendingInteractions({ sessionId: normalized }))[0];
    if (pending) {
      return registerRuntimeGenericInteraction(
        pending,
        (answer) => runtime.client.answerInteraction(answer),
      );
    }
  } catch {
    // Runtime may be unavailable while the app is still starting.
  }
  return null;
}

export async function replyInteraction({
  interactionId,
  rawText,
  answers,
}: {
  interactionId: string;
  rawText?: string;
  answers?: InteractionReplyAnswer[];
}) {
  const normalized = interactionId.trim();
  if (!normalized) {
    throw new Error(
      localizedClientMessage('交互 ID 为空', 'Interaction ID is empty'),
    );
  }
  const normalizedAnswers = answers
    ?.map((answer) => ({
      question_id: answer.questionId,
      ...(answer.selectedOptionId
        ? { selected_option_id: answer.selectedOptionId }
        : {}),
      ...(answer.selectedOptionIds && answer.selectedOptionIds.length > 0
        ? { selected_option_ids: answer.selectedOptionIds }
        : {}),
      ...(answer.inputText?.trim()
        ? { input_text: answer.inputText.trim() }
        : {}),
    }))
    .filter(
      (answer) =>
        answer.question_id &&
        (answer.selected_option_id ||
          (answer.selected_option_ids?.length ?? 0) > 0 ||
          answer.input_text),
    );
  const trimmedRawText = rawText?.trim() ?? '';
  if ((normalizedAnswers?.length ?? 0) === 0 && !trimmedRawText) {
    throw new Error(
      localizedClientMessage('交互回答为空', 'Interaction reply is empty'),
    );
  }
  if (hasRuntimeInteraction(normalized)) {
    if (hasRuntimeGenericInteraction(normalized)) {
      await answerRuntimeGenericInteraction(normalized, {
        decision: 'submit',
        answers: (normalizedAnswers ?? []).map((answer) => ({
          questionId: answer.question_id,
          ...(answer.selected_option_id ? { selectedOptionId: answer.selected_option_id } : {}),
          ...(answer.selected_option_ids ? { selectedOptionIds: answer.selected_option_ids } : {}),
          ...(answer.input_text ? { inputText: answer.input_text } : {}),
        })),
        ...(trimmedRawText ? { rawText: trimmedRawText } : {}),
      });
      return;
    }
    const candidate = String(
      normalizedAnswers?.find((answer) => answer.question_id === 'permission')
        ?.selected_option_id ?? trimmedRawText,
    ).trim();
    if (!['allow_once', 'allow_session', 'deny'].includes(candidate)) {
      throw new Error(
        localizedClientMessage(
          '权限回答必须是允许一次、本会话允许或拒绝',
          'Runtime permission reply must be allow_once, allow_session, or deny',
        ),
      );
    }
    await answerRuntimeInteraction(
      normalized,
      candidate as 'allow_once' | 'allow_session' | 'deny',
    );
    return;
  }
  throw new Error(
    localizedClientMessage(
      '当前 Runtime 中不存在这个待处理交互。',
      'This interaction is not pending in the current Runtime.',
    ),
  );
}

export async function cancelInteraction(interactionId: string) {
  const normalized = interactionId.trim();
  if (!normalized) {
    return;
  }
  if (hasRuntimeInteraction(normalized)) {
    if (hasRuntimeGenericInteraction(normalized)) {
      await answerRuntimeGenericInteraction(normalized, { decision: 'cancel', answers: [] });
      return;
    }
    await answerRuntimeInteraction(normalized, 'cancel');
    return;
  }
  return;
}

export interface StopTurnResult {
  turnId: string;
  accepted: boolean;
  terminal: boolean;
  alreadyInactive: boolean;
  reason: string;
  raw: Record<string, unknown>;
}

export async function stopTurn(turnId: string): Promise<StopTurnResult> {
  const normalized = turnId.trim();
  if (!normalized) {
    return {
      turnId: '',
      accepted: false,
      terminal: false,
      alreadyInactive: false,
      reason: 'turn_id_empty',
      raw: {},
    };
  }
  const receipt = await stopActiveRuntimeTurn(normalized);
  if (receipt) {
    return {
      turnId: normalized,
      accepted: receipt.accepted,
      terminal: receipt.terminal,
      alreadyInactive: !receipt.accepted && receipt.terminal,
      reason: receipt.reason,
      raw: { source: 'electron_runtime', receipt },
    };
  }
  const runtime = createDesktopRuntimeSession();
  try {
    const sessions = await runtime.client.listSessions();
    const turn = sessions
      .flatMap((session) => session.turns)
      .find((candidate) => candidate.turnId === normalized);
    return {
      turnId: normalized,
      accepted: false,
      terminal: Boolean(turn),
      alreadyInactive: Boolean(turn),
      reason: turn ? turn.reason : 'turn_not_found',
      raw: {
        source: 'electron_runtime',
        ...(turn ? { status: turn.status } : {}),
      },
    };
  } finally {
    runtime.dispose();
  }
}

export async function streamChat(request: ChatStreamRequest) {
  return streamRuntimeChat(request);
}

export async function streamTurnEvents(request: TurnEventStreamRequest) {
  const turnId = request.turnId.trim();
  if (!turnId) {
    throw new Error(localizedClientMessage('turn_id 为空', 'turn_id is empty'));
  }
  return streamRuntimeTurnEvents(request);
}

export async function editMessage(request: EditMessageRequest) {
  const sessionId = request.sessionId.trim();
  const messageId = request.messageId.trim();
  const content = request.content.trim();
  if (!sessionId || !messageId) {
    throw new Error(
      localizedClientMessage(
        '会话或 message_id 为空',
        'Conversation ID or message_id is empty',
      ),
    );
  }
  if (!content) {
    throw new Error(
      localizedClientMessage('消息内容为空', 'Message content is empty'),
    );
  }
  const runtime = createDesktopRuntimeSession();
  try {
    const snapshot = await runtime.client.getSession(sessionId, request.signal);
    if (!snapshot) {
      throw new Error(
        localizedClientMessage('会话不存在', 'Conversation does not exist'),
      );
    }
    const superseded = new Set(snapshot.supersededMessageIds);
    const messages = snapshot.turns
      .flatMap((turn) => turn.messages)
      .filter((message) => !superseded.has(message.messageId));
    const index = messages.findIndex(
      (message) => message.messageId === messageId,
    );
    if (index < 0) {
      throw new Error(
        localizedClientMessage('消息不存在', 'Message does not exist'),
      );
    }
    const supersedeFrom =
      index > 0 &&
      messages[index - 1]?.turnId === messages[index]?.turnId &&
      isInternalRuntimeMessage(messages[index - 1]!)
        ? index - 1
        : index;
    await runtime.client.supersedeSessionMessages(
      {
        sessionId,
        messageIds: messages
          .slice(supersedeFrom)
          .map((message) => message.messageId),
        reason: 'user_edit_regenerate',
      },
      request.signal,
    );
  } finally {
    runtime.dispose();
  }
  return streamRuntimeChat({ ...request, userInput: content });
}

export async function sendGuidance(request: SendGuidanceRequest) {
  const sessionId = request.sessionId.trim();
  const turnId = request.turnId.trim();
  const guidance = request.guidance.trim();
  if (!sessionId || !turnId || !guidance) {
    throw new Error(
      localizedClientMessage(
        '会话、turn_id 或引导内容为空',
        'Conversation ID, turn_id, or guidance is empty',
      ),
    );
  }
  const runtime = createDesktopRuntimeSession();
  try {
    await runtime.client.enqueueGuidance({
      protocol: 'bush.runtime_guidance.v1',
      sessionId,
      turnId,
      messageId: request.clientMessageId.trim(),
      content: guidance,
      createdAt: new Date().toISOString(),
    }, request.signal);
  } finally {
    runtime.dispose();
  }
  return {
    continuationQueued: true,
    willContinueAfterCurrentRound: true,
    guidance: {
      clientMessageId: request.clientMessageId.trim(),
      mode: 'append_context',
    },
  } satisfies SendGuidanceResponse;
}

export class PendingInteractionConflictError extends Error {
  readonly interaction: PendingInteraction;

  constructor(interaction: PendingInteraction) {
    super('A pending interaction requires a response');
    this.name = 'PendingInteractionConflictError';
    this.interaction = interaction;
  }
}

export function isPendingInteractionConflictError(
  error: unknown,
): error is PendingInteractionConflictError {
  return error instanceof PendingInteractionConflictError;
}

function defaultConversationTitle(_sessionId: string) {
  return '新会话';
}

function arrayFrom(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function maintenanceClearResultFromPayload(
  payload: Record<string, unknown>,
): MaintenanceClearResult {
  const counts = asRecord(payload.counts);
  return {
    target: String(payload.target ?? ''),
    cleared: Boolean(payload.cleared),
    counts: Object.fromEntries(
      Object.entries(counts).map(([key, value]) => {
        const numeric = Number(value);
        return [key, Number.isFinite(numeric) ? numeric : 0];
      }),
    ),
  };
}

function runtimeAssetResetPlanFromPayload(
  payload: Record<string, unknown>,
): RuntimeAssetResetPlan {
  const categories = asRecord(payload.categories);
  return {
    protocol: String(payload.protocol ?? ''),
    categories: Object.fromEntries(
      runtimeAssetCategories(Object.keys(categories)).map((category) => {
        const item = asRecord(categories[category]);
        return [category, {
          sourcePath: String(item.source_path ?? item.sourcePath ?? ''),
          targetPath: String(item.target_path ?? item.targetPath ?? ''),
        }];
      }),
    ),
    requiresConfirmation: payload.requires_confirmation === true,
    requiresIdleRuntime: payload.requires_idle_runtime === true,
    destructive: payload.destructive === true,
    restartRequiredAfterChange: payload.restart_required_after_change === true,
  };
}

function runtimeAssetResetResultFromPayload(
  payload: Record<string, unknown>,
): RuntimeAssetResetResult {
  const categories = asRecord(payload.categories);
  return {
    protocol: String(payload.protocol ?? ''),
    selectedCategories: runtimeAssetCategories(
      payload.selected_categories ?? payload.selectedCategories,
    ),
    categories: Object.fromEntries(
      runtimeAssetCategories(Object.keys(categories)).map((category) => {
        const item = asRecord(categories[category]);
        return [category, {
          changed: item.changed === true,
          sourcePath: String(item.source_path ?? item.sourcePath ?? ''),
          targetPath: String(item.target_path ?? item.targetPath ?? ''),
          seedFileCount: finiteNumber(item.seed_file_count ?? item.seedFileCount),
          restoredFileCount: finiteNumber(item.restored_file_count ?? item.restoredFileCount),
          removedRuntimeFileCount: finiteNumber(
            item.removed_runtime_file_count ?? item.removedRuntimeFileCount,
          ),
        }];
      }),
    ),
    changed: payload.changed === true,
    restartRequired: payload.restart_required === true,
    effectiveAfter: String(payload.effective_after ?? payload.effectiveAfter ?? ''),
  };
}

function runtimeAssetCategories(value: unknown): RuntimeAssetCategory[] {
  const items = Array.isArray(value) ? value : [];
  return items
    .map((item) => String(item ?? '').trim().toLowerCase())
    .filter((item): item is RuntimeAssetCategory => (
      item === 'prompts' || item === 'skills' || item === 'agent_profiles' || item === 'teams'
    ));
}

function assertRuntimeAssetResetProtocol(protocol: string) {
  if (protocol === RUNTIME_ASSET_RESET_PROTOCOL) return;
  throw new Error(localizedClientMessage(
    `配置重置协议不兼容：${protocol || 'missing'}`,
    `Incompatible runtime asset reset protocol: ${protocol || 'missing'}`,
  ));
}

function finiteNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function skillDetailFromPayload(item: unknown): SkillDetail {
  const value = asRecord(item);
  return {
    name: String(value.name ?? ''),
    description: String(value.description ?? ''),
    descriptionZh: String(value.descriptionZh ?? value.description_zh ?? ''),
    path: String(value.path ?? ''),
    logoPath: String(value.logoPath ?? value.logo_path ?? ''),
    logoDarkPath: String(value.logoDarkPath ?? value.logo_dark_path ?? ''),
    source: skillSource(value.source),
    sourceId: String(value.sourceId ?? value.source_id ?? ''),
    sourceLabel: String(value.sourceLabel ?? value.source_label ?? ''),
    packageDir: String(value.packageDir ?? value.package_dir ?? ''),
    content: String(value.content ?? ''),
    version: optionalString(value.version),
    routingHidden:
      value.routingHidden === true || value.routing_hidden === true,
    requires: stringList(value.requires),
    conflictsWith: stringList(value.conflictsWith ?? value.conflicts_with),
    minServerVersion: optionalString(
      value.minServerVersion ?? value.min_server_version,
    ),
    timeout: numberRecord(value.timeout),
    companionTools: stringList(value.companionTools ?? value.companion_tools),
    blockedTools: stringList(value.blockedTools ?? value.blocked_tools),
    requiredReads: stringList(value.requiredReads ?? value.required_reads),
    conditionalReads: stringList(
      value.conditionalReads ?? value.conditional_reads,
    ),
    resourceQuickRefs: recordList(
      value.resourceQuickRefs ?? value.resource_quick_refs,
    ),
  };
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? '').trim()).filter(Boolean)
    : [];
}

function skillSource(value: unknown): SkillSummary['source'] {
  const normalized = String(value ?? '').trim();
  return ['bundled', 'user', 'plugin', 'external'].includes(normalized)
    ? normalized as NonNullable<SkillSummary['source']>
    : undefined;
}

function numberRecord(value: unknown) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) {
      result[key] = numeric;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function numericValue(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function recordList(value: unknown) {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> =>
          item != null && typeof item === 'object',
      )
    : [];
}

function asOptionalRecord(value: unknown) {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  return asRecord(value);
}

function normalizeImageSource(value: unknown) {
  const text = optionalString(value)?.trim() ?? '';
  if (!text) {
    return '';
  }
  if (/^data:image\//i.test(text)) {
    return text;
  }
  if (/^<svg[\s>]/i.test(text)) {
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}`;
  }
  if (/^(https?:|file:|blob:|data:)/i.test(text) || text.startsWith('//')) {
    return text;
  }
  if (text.startsWith('/') || text.startsWith('./') || text.startsWith('../')) {
    return text;
  }
  const compact = text.replace(/\s+/g, '');
  if (
    compact.length >= 80 &&
    compact.length % 4 === 0 &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(compact)
  ) {
    const mime = compact.startsWith('/9j/')
      ? 'image/jpeg'
      : compact.startsWith('R0lGOD')
        ? 'image/gif'
        : compact.startsWith('PHN2Zy')
          ? 'image/svg+xml'
          : 'image/png';
    return `data:${mime};base64,${compact}`;
  }
  return text;
}

function optionalString(value: unknown) {
  const text = value == null ? '' : String(value);
  return text.trim() ? text : undefined;
}

function runtimeProtocolErrorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const value = error as { code?: unknown; fact?: { code?: unknown } };
  return String(value.fact?.code ?? value.code ?? '').trim();
}

function optionalNumber(value: unknown) {
  if (value == null || value === '') {
    return undefined;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function runtimeSubagentTask(task: RuntimeSubagentTask): SubagentTaskSnapshot {
  return {
    protocol: task.protocol,
    taskId: task.taskId,
    parentSessionId: task.parentSessionId,
    parentTurnId: task.parentTurnId,
    childSessionId: task.childSessionId,
    childTurnId: task.childTurnId,
    origin: task.origin,
    teamId: task.teamId,
    teamMemberId: task.teamMemberId,
    agentProfileId: task.agentProfileId,
    requestPrompt: task.prompt,
    responsePrompt: task.finalResponse || undefined,
    status: task.status,
    terminal: task.status !== 'running',
    accepted: true,
    errorMessage: task.errorMessage || undefined,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    report: task.finalResponse ? { finalResponse: task.finalResponse } : {},
    review: {},
    contractEvaluation: {},
    executionContract: {},
    workerProposal: {},
    mergePlan: {},
    usage: task.usage,
    raw: { ...task },
  };
}

function asRecord(value: unknown) {
  return value != null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}
