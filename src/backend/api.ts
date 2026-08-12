import type {
  AssistantRevision,
  BackendCapabilities,
  ChatMessage,
  ChatToolExecution,
  ConversationSummary,
  ManagedModelConfig,
  McpServerConfig,
  McpServersResult,
  McpServerValidationResult,
  McpTransport,
  McpValidationMessage,
  PendingInteraction,
  BotConfigResult,
  BotPlatform,
  BotPlatformOverview,
  BotServiceLogsResult,
  BotServiceStatus,
  BotStatusResult,
  WeixinLoginStartResult,
  WeixinLoginStatus,
  WeixinLoginStatusResult,
  SkillDetail,
  SkillSummary,
  TeamFlowActionType,
  TeamFlowActionOption,
  TeamFlowEdge,
  TeamFlowGraph,
  TeamFlowLayer,
  TeamFlowNode,
  TeamFlowState,
  TeamFlowStreamEvent,
  AssistantStreamChunk,
  StreamExecutionUpdate,
  ThinkingStreamEvent,
  TaskPlanStreamUpdate,
  SubagentCapabilities,
  SubagentListItem,
  SubagentRuntimeResult,
  SubagentSupervisorSnapshot,
  SubagentValidationStatus,
  StreamStart,
  WorkspaceContext,
  InteractionReplyAnswer,
  InteractionQuestion,
  InteractionOption,
  PermissionMode,
  ReasoningLevel,
  ReferencePlanMode,
  RuntimeContextWindowUsage,
  CapabilityCandidatesUpdate,
  TerminalRuntime,
} from '../types';
import {
  applyDisabledToolsToMetadata,
  standardImageInputToolDefaultName,
} from './toolVisibility';
import { applyAllowedResourcePathsToMetadata } from './localPathMetadata';
import { applyAllowedSkillsToRequest } from './skillSelectionMetadata';
import {
  taskPlanFromPayload,
  taskPlanUpdateFromExecutionPayload,
} from './taskPlan';
import { desktopActionToolPayload } from './desktopAction';
import { capabilityCandidatesFromPayload } from './capabilityCandidates';
import {
  assistantStreamChunkFromPayload,
  executionUpdateFromPayload,
} from './streamProtocol';
import { attachHistoryToolExecutions } from './historyToolAssociation';

const conversationListPageSize = 160;
const conversationListMaxPages = 1;
const conversationListMaxVisible = 160;

export const backendBaseUrl =
  import.meta.env.VITE_BACKEND_BASE_URL?.trim() || 'http://127.0.0.1:51717';
export const llmEndpoint = import.meta.env.VITE_LLM_ENDPOINT?.trim() || '';
export const backendBearerTokenStorageKey = 'cardbush_backend_bearer_token';
export const backendLocalRequestKeyStorageKey = 'cardbush_backend_local_request_key';

export interface SessionShareLinkResult {
  code: string;
  sessionId: string;
  platform: string;
  expiresAt: string;
}

export interface SaveBotConfigRequest {
  platform: BotPlatform;
  config: Record<string, unknown>;
}

export interface BackendModelConfigsResult {
  defaultModelId: string;
  models: ManagedModelConfig[];
  raw: unknown;
}

export interface RuntimeToolInventoryEntry {
  name: string;
  package: string;
  description: string;
  enabled: boolean;
  runtimeLoaded: boolean;
  schemaAvailable: boolean;
  inputSchema?: Record<string, unknown>;
  dispatch?: Record<string, unknown>;
  injection: {
    core: boolean;
    default: boolean;
  };
  category: 'default' | 'discoverable_plugin' | 'disabled' | string;
}

export interface RuntimeToolInventory {
  protocol: string;
  tools: string[];
  installed: RuntimeToolInventoryEntry[];
  modelVisibleDefault: string[];
  modelVisibleThisTurn: string[];
  modelVisibleSource: string;
  modelVisibleSnapshot: {
    requestId: string;
    sessionId: string;
    turnId: string;
    loopIndex?: number;
    provider: string;
    model: string;
    completedAt: string;
  } | null;
  conditional: Array<{ name: string; reason: string }>;
  turnAdded: string[];
  discoverablePlugins: string[];
  disabled: string[];
  internalGuardEvents: Array<{
    name: string;
    kind: string;
    modelVisible: boolean;
    frontendVisible: boolean;
    description: string;
  }>;
  loadErrors: Array<Record<string, unknown>>;
}

export interface ChatStreamRequest {
  sessionId: string;
  userInput: string;
  model: string;
  modelConfig?: ManagedModelConfig;
  projectDir?: string;
  projectUserPrompt?: string;
  allowedSkills?: string[];
  referencePlanMode?: ReferencePlanMode;
  permissionMode?: PermissionMode;
  reasoningLevel?: ReasoningLevel;
  reasoningTraceVisible?: boolean;
  interactiveRequestsEnabled?: boolean;
  standardImageInputEnabled?: boolean;
  browserPrivacyMode?: boolean;
  teamModeEnabled?: boolean;
  osModeEnabled?: boolean;
  terminalRuntime?: TerminalRuntime;
  images?: Array<{ path: string }>;
  files?: string[];
  disabledTools?: string[];
  signal?: AbortSignal;
  onStart?: (start: StreamStart) => void;
  onDelta?: (delta: string, chunk: AssistantStreamChunk) => void;
  onExecution?: (update: StreamExecutionUpdate) => void;
  onAssistantRevision?: (revision: AssistantRevision) => void;
  onToolExecution?: (execution: ChatToolExecution) => void;
  onTaskPlanUpdate?: (update: TaskPlanStreamUpdate) => void;
  onInteractiveRequest?: (interaction: PendingInteraction) => void;
  onFinalAssistantText?: (text: string, chunk: AssistantStreamChunk) => void;
  onMessages?: (messages: ChatMessage[], finalSnapshot: boolean) => void;
  onTeamFlowEvent?: (event: TeamFlowStreamEvent) => void;
  onThinking?: (event: ThinkingStreamEvent) => void;
  onContextWindowUsage?: (usage: RuntimeContextWindowUsage) => void;
  onCapabilityCandidates?: (update: CapabilityCandidatesUpdate) => void;
  onWorkflowEvent?: (event: TeamWorkflowStreamEvent) => void;
  onSceneEvent?: (event: SceneStreamEvent) => void;
}

export interface ControlStreamRequest {
  sessionId: string;
  model: string;
  modelConfig?: ManagedModelConfig;
  projectDir?: string;
  projectUserPrompt?: string;
  allowedSkills?: string[];
  referencePlanMode?: ReferencePlanMode;
  permissionMode?: PermissionMode;
  reasoningLevel?: ReasoningLevel;
  reasoningTraceVisible?: boolean;
  interactiveRequestsEnabled?: boolean;
  standardImageInputEnabled?: boolean;
  browserPrivacyMode?: boolean;
  teamModeEnabled?: boolean;
  osModeEnabled?: boolean;
  terminalRuntime?: TerminalRuntime;
  images?: Array<{ path: string }>;
  files?: string[];
  disabledTools?: string[];
  signal?: AbortSignal;
  onStart?: (start: StreamStart) => void;
  onDelta?: (delta: string, chunk: AssistantStreamChunk) => void;
  onExecution?: (update: StreamExecutionUpdate) => void;
  onAssistantRevision?: (revision: AssistantRevision) => void;
  onToolExecution?: (execution: ChatToolExecution) => void;
  onTaskPlanUpdate?: (update: TaskPlanStreamUpdate) => void;
  onInteractiveRequest?: (interaction: PendingInteraction) => void;
  onFinalAssistantText?: (text: string, chunk: AssistantStreamChunk) => void;
  onMessages?: (messages: ChatMessage[], finalSnapshot: boolean) => void;
  onTeamFlowEvent?: (event: TeamFlowStreamEvent) => void;
  onThinking?: (event: ThinkingStreamEvent) => void;
  onContextWindowUsage?: (usage: RuntimeContextWindowUsage) => void;
  onCapabilityCandidates?: (update: CapabilityCandidatesUpdate) => void;
  onWorkflowEvent?: (event: TeamWorkflowStreamEvent) => void;
  onSceneEvent?: (event: SceneStreamEvent) => void;
}

export interface RegenerateTurnRequest extends ControlStreamRequest {
  turnId: string;
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
  onExecution?: (update: StreamExecutionUpdate) => void;
  onAssistantRevision?: (revision: AssistantRevision) => void;
  onToolExecution?: (execution: ChatToolExecution) => void;
  onTaskPlanUpdate?: (update: TaskPlanStreamUpdate) => void;
  onInteractiveRequest?: (interaction: PendingInteraction) => void;
  onFinalAssistantText?: (text: string, chunk: AssistantStreamChunk) => void;
  onMessages?: (messages: ChatMessage[], finalSnapshot: boolean) => void;
  onTeamFlowEvent?: (event: TeamFlowStreamEvent) => void;
  onThinking?: (event: ThinkingStreamEvent) => void;
  onContextWindowUsage?: (usage: RuntimeContextWindowUsage) => void;
  onCapabilityCandidates?: (update: CapabilityCandidatesUpdate) => void;
  onWorkflowEvent?: (event: TeamWorkflowStreamEvent) => void;
  onSceneEvent?: (event: SceneStreamEvent) => void;
}

export interface ShadowConversationRecord {
  id: string;
  sessionId: string;
  sourceTurnId: string;
  agentName: string;
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
  signal?: AbortSignal;
  onStart?: (messageId: string) => void;
  onDelta?: (delta: string) => void;
  onDone?: (message: { id: string; content: string; createdAt: string }) => void;
}

export interface SessionContextSearchItem {
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

export interface TeamWorkflowValidationResult {
  valid: boolean;
  errors: Array<Record<string, unknown>>;
  warnings: Array<Record<string, unknown>>;
  normalized?: Record<string, unknown>;
  raw: Record<string, unknown>;
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
  runtimeInspection: true,
  maintenanceConversationHistoryClear: false,
  maintenanceLogsCacheClear: false,
  botControl: false,
  sessionShareLinks: false,
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
  reasoningLevels: ['low', 'medium', 'max'],
  defaultReasoningLevel: 'medium',
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
  timeoutSeconds?: number;
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

export interface SubagentWriteLeaseResult {
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

export interface SessionSceneRecord {
  sceneId: string;
  sessionId?: string;
  turnId?: string;
  createdAt?: string;
  updatedAt?: string;
  raw: Record<string, unknown>;
}

export interface SessionMessagesResult {
  conversation: ConversationSummary;
  messages: ChatMessage[];
  toolExecutions: ChatToolExecution[];
  workspaceContext?: WorkspaceContext;
}

function url(path: string) {
  const normalizedBase = backendBaseUrl.endsWith('/')
    ? backendBaseUrl.slice(0, -1)
    : backendBaseUrl;
  return `${normalizedBase}${path}`;
}

function backendUrlFor(path: string) {
  const normalizedBase = backendBaseUrl.endsWith('/')
    ? backendBaseUrl
    : `${backendBaseUrl}/`;
  return new URL(path, normalizedBase).toString();
}

export async function backendRequestHeaders(targetUrl: string, json = false) {
  const fromDesktop = await desktopBackendHeaders(targetUrl, json);
  const headers: Record<string, string> = {
    ...fromDesktop,
  };
  if (shouldAttachBackendAuth(targetUrl)) {
    const bearerToken = browserBackendBearerToken();
    if (bearerToken && !hasHeader(headers, 'authorization')) {
      headers.authorization = `Bearer ${bearerToken}`;
    }
  }
  if (isLoopbackUrl(targetUrl)) {
    const localKey = browserBackendLocalRequestKey();
    if (localKey && !hasHeader(headers, 'X-Bush-Local-Key')) {
      headers['X-Bush-Local-Key'] = localKey;
    }
  }
  if (json && !hasHeader(headers, 'content-type')) {
    headers['content-type'] = 'application/json';
  }
  return headers;
}

async function desktopBackendHeaders(targetUrl: string, json: boolean) {
  try {
    return (await window.cardbushDesktop?.bushHeaders(targetUrl, json)) ?? {};
  } catch {
    return {};
  }
}

function headersFor(targetUrl: string, json = false) {
  return backendRequestHeaders(targetUrl, json);
}

function browserBackendBearerToken() {
  return (
    import.meta.env.VITE_BUSH_API_AUTH_TOKEN?.trim() ||
    import.meta.env.VITE_BACKEND_AUTH_TOKEN?.trim() ||
    readBrowserStorage(backendBearerTokenStorageKey)
  );
}

function browserBackendLocalRequestKey() {
  return (
    import.meta.env.VITE_BUSH_LOCAL_REQUEST_SECRET?.trim() ||
    import.meta.env.VITE_BUSH_LOCAL_REQUEST_KEY?.trim() ||
    readBrowserStorage(backendLocalRequestKeyStorageKey)
  );
}

function readBrowserStorage(key: string) {
  try {
    return window.localStorage.getItem(key)?.trim() ?? '';
  } catch {
    return '';
  }
}

function shouldAttachBackendAuth(targetUrl: string) {
  try {
    return new URL(targetUrl).origin === new URL(backendBaseUrl).origin;
  } catch {
    return false;
  }
}

function isLoopbackUrl(targetUrl: string) {
  try {
    const host = new URL(targetUrl).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
  } catch {
    return false;
  }
}

function hasHeader(headers: Record<string, string>, name: string) {
  const normalized = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === normalized);
}

export class BushServerHttpError extends Error {
  readonly statusCode: number;
  readonly responseBody: string;
  readonly code?: string;
  readonly requestId?: string;
  readonly details?: unknown;

  constructor(statusCode: number, responseBody: string) {
    super(formatHttpError(statusCode, responseBody));
    this.name = 'BushServerHttpError';
    this.statusCode = statusCode;
    this.responseBody = responseBody;
    const detail = structuredErrorDetail(responseBody);
    this.code = detail?.code;
    this.requestId = detail?.requestId;
    this.details = detail?.details;
  }
}

export function isBushServerHttpError(
  error: unknown,
  statusCode?: number,
): error is BushServerHttpError {
  return (
    error instanceof BushServerHttpError &&
    (statusCode == null || error.statusCode === statusCode)
  );
}

async function readJson<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    ...init,
    headers: {
      ...(await headersFor(input, init?.body != null)),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new BushServerHttpError(response.status, body);
  }
  return (await response.json()) as T;
}

export async function fetchBackendCapabilities(): Promise<BackendCapabilities> {
  const endpoint = url('/v1/capabilities');
  const response = await fetch(endpoint, {
    headers: await headersFor(endpoint),
  });
  if (response.status === 404) {
    return defaultBackendCapabilities;
  }
  if (!response.ok) {
    throw new Error(formatHttpError(response.status, await response.text()));
  }
  return backendCapabilitiesFromPayload(await response.json());
}

export async function fetchRuntimeToolInventory(filters?: {
  sessionId?: string;
  turnId?: string;
}): Promise<RuntimeToolInventory> {
  const endpoint = new URL(url('/v1/tools'));
  if (filters?.sessionId?.trim()) {
    endpoint.searchParams.set('session_id', filters.sessionId.trim());
  }
  if (filters?.turnId?.trim()) {
    endpoint.searchParams.set('turn_id', filters.turnId.trim());
  }
  return runtimeToolInventoryFromPayload(await readJson<unknown>(endpoint.toString()));
}

export async function fetchModelConfigs(): Promise<BackendModelConfigsResult> {
  const payload = await readJson<unknown>(url('/v1/model-configs'));
  return modelConfigsFromPayload(payload);
}

export async function saveModelConfigs(request: {
  defaultModelId?: string;
  models: ManagedModelConfig[];
}): Promise<BackendModelConfigsResult> {
  const payload = await readJson<unknown>(url('/v1/model-configs'), {
    method: 'PUT',
    body: JSON.stringify({
      version: 1,
      default_model_id: request.defaultModelId ?? '',
      models: request.models.map((item) => ({
        id: item.id,
        provider: item.provider,
        model: item.modelName,
        model_name: item.modelName,
        ...(item.apiKey.trim() ? { api_key: item.apiKey } : {}),
        base_url: item.baseUrl,
        max_context_tokens: item.maxContextTokens,
      })),
    }),
  });
  return modelConfigsFromPayload(payload);
}

export async function fetchMcpServers(): Promise<McpServersResult> {
  const payload = await readJson<unknown>(url('/v1/mcp/servers'));
  return mcpServersFromPayload(payload);
}

export async function validateMcpServerConfig(
  input: McpServerConfigInput,
): Promise<McpServerValidationResult> {
  const payload = await readJson<unknown>(url('/v1/mcp/servers/validate'), {
    method: 'POST',
    body: JSON.stringify(mcpServerRequestBody(input)),
  });
  return mcpServerValidationFromPayload(payload);
}

export async function saveMcpServerConfig(
  input: McpServerConfigInput,
): Promise<McpServerConfig> {
  const normalized = input.id.trim();
  if (!normalized) {
    throw new Error('MCP server id 为空');
  }
  const payload = await readJson<unknown>(
    url(`/v1/mcp/servers/${encodeURIComponent(normalized)}`),
    {
      method: 'PUT',
      body: JSON.stringify(mcpServerRequestBody(input)),
    },
  );
  return mcpServerFromPayload(payload, 0);
}

export async function setMcpServerEnabled(
  serverId: string,
  enabled: boolean,
): Promise<McpServerConfig> {
  const normalized = serverId.trim();
  if (!normalized) {
    throw new Error('MCP server id 为空');
  }
  const payload = await readJson<unknown>(
    url(`/v1/mcp/servers/${encodeURIComponent(normalized)}/${enabled ? 'enable' : 'disable'}`),
    { method: 'POST' },
  );
  return mcpServerFromPayload(payload, 0);
}

export async function deleteMcpServerConfig(
  serverId: string,
): Promise<Record<string, unknown>> {
  const normalized = serverId.trim();
  if (!normalized) {
    throw new Error('MCP server id 为空');
  }
  return readJson<Record<string, unknown>>(
    url(`/v1/mcp/servers/${encodeURIComponent(normalized)}`),
    { method: 'DELETE' },
  );
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

function managedModelConfigFromPayload(payload: unknown): ManagedModelConfig | null {
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
  if (input.timeoutSeconds != null) {
    body.timeout_seconds = input.timeoutSeconds;
    body.timeoutSeconds = input.timeoutSeconds;
  }
  return body;
}

function mcpServersFromPayload(payload: unknown): McpServersResult {
  const root = asRecord(payload);
  const servers = Array.isArray(root.servers)
    ? root.servers
    : Array.isArray(root.items)
      ? root.items
      : Array.isArray(root.mcp_servers)
        ? root.mcp_servers
        : Array.isArray(root.mcpServers)
          ? root.mcpServers
          : Array.isArray(payload)
            ? payload
            : [];
  return {
    servers: servers
      .map(mcpServerFromPayload)
      .filter((item): item is McpServerConfig => Boolean(item.id.trim())),
    protocolVersions: stringList(
      root.protocol_versions ?? root.protocolVersions ?? root.supported_protocol_versions,
    ),
    raw: root,
  };
}

function mcpServerFromPayload(payload: unknown, index = 0): McpServerConfig {
  const root = asRecord(payload);
  const item = asRecord(root.server ?? root.item ?? root.mcp_server ?? root.mcpServer ?? payload);
  const id = String(item.id ?? item.name ?? item.server_id ?? item.serverId ?? `mcp-${index}`).trim();
  const transport = normalizeMcpTransport(
    item.transport ?? item.protocol ?? asRecord(item.connection).transport,
  );
  const command = optionalString(
    item.command ?? item.cmd ?? asRecord(item.stdio).command ?? asRecord(item.connection).command,
  );
  const urlValue = optionalString(
    item.url ?? item.endpoint ?? asRecord(item.sse).url ?? asRecord(item.connection).url,
  );
  const env = stringRecord(item.env ?? item.environment);
  const headers = stringRecord(item.headers ?? asRecord(item.sse).headers);
  return {
    id,
    name: String(item.label ?? item.display_name ?? item.displayName ?? item.name ?? id),
    description: String(item.description ?? item.summary ?? ''),
    enabled: item.enabled !== false,
    transport,
    ...(command ? { command } : {}),
    args: stringList(item.args ?? item.arguments ?? asRecord(item.stdio).args),
    cwd: optionalString(item.cwd ?? item.working_dir ?? item.workingDir),
    ...(env ? { env } : {}),
    ...(urlValue ? { url: urlValue } : {}),
    ...(headers ? { headers } : {}),
    timeoutSeconds: optionalNumber(item.timeout_seconds ?? item.timeoutSeconds),
    toolCount: optionalNumber(
      item.tool_count ?? item.toolCount ?? asRecord(item.tools).count,
    ),
    status: optionalString(item.status ?? item.state),
    lastError: optionalString(item.last_error ?? item.lastError ?? item.error),
    raw: item,
  };
}

function mcpServerValidationFromPayload(
  payload: unknown,
): McpServerValidationResult {
  const root = asRecord(payload);
  const messages = [
    ...mcpValidationMessagesFromPayload(root.errors, 'error'),
    ...mcpValidationMessagesFromPayload(root.warnings, 'warning'),
    ...mcpValidationMessagesFromPayload(root.messages, 'info'),
  ];
  const lastError = optionalString(root.last_error ?? root.lastError ?? root.error);
  if (
    lastError &&
    !messages.some((item) => item.severity === 'error' && item.message === lastError)
  ) {
    messages.push({ path: '', message: lastError, severity: 'error' });
  }
  const ok = typeof root.ok === 'boolean'
    ? root.ok
    : typeof root.valid === 'boolean'
      ? root.valid
      : !messages.some((item) => item.severity === 'error');
  return {
    ok,
    serverId: optionalString(root.server_id ?? root.serverId ?? root.id),
    tools: stringList(root.tools ?? root.tool_names ?? root.toolNames),
    messages,
    raw: root,
  };
}

function mcpValidationMessagesFromPayload(
  payload: unknown,
  fallbackSeverity: McpValidationMessage['severity'],
): McpValidationMessage[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload.map((item) => {
    if (typeof item === 'string') {
      return { path: '', message: item, severity: fallbackSeverity };
    }
    const value = asRecord(item);
    const severity = String(value.severity ?? fallbackSeverity).toLowerCase();
    return {
      path: String(value.path ?? value.field ?? ''),
      message: String(value.message ?? value.detail ?? value.error ?? item),
      severity:
        severity === 'error' || severity === 'warning' || severity === 'info'
          ? severity
          : fallbackSeverity,
    };
  });
}

function normalizeMcpTransport(value: unknown): McpTransport {
  const text = String(value ?? '').trim().toLowerCase().replace(/-/g, '_');
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

function runtimeToolInventoryFromPayload(payload: unknown): RuntimeToolInventory {
  const root = recordFromUnknown(payload);
  const snapshotValue = root.model_visible_snapshot ?? root.modelVisibleSnapshot;
  const snapshot = recordFromUnknown(snapshotValue);
  const hasSnapshot = snapshotValue != null && Object.keys(snapshot).length > 0;
  const guardEventsValue = root.internal_guard_events ?? root.internalGuardEvents;
  const loadErrorsValue = root.load_errors ?? root.loadErrors;
  return {
    protocol: String(root.protocol ?? ''),
    tools: stringList(root.tools),
    installed: Array.isArray(root.installed)
      ? root.installed.map(runtimeToolInventoryEntryFromPayload)
      : [],
    modelVisibleDefault: stringList(
      root.model_visible_default ?? root.modelVisibleDefault,
    ),
    modelVisibleThisTurn: stringList(
      root.model_visible_this_turn ?? root.modelVisibleThisTurn,
    ),
    modelVisibleSource: String(
      root.model_visible_source ?? root.modelVisibleSource ?? 'none',
    ),
    modelVisibleSnapshot: hasSnapshot
      ? {
          requestId: String(snapshot.request_id ?? snapshot.requestId ?? ''),
          sessionId: String(snapshot.session_id ?? snapshot.sessionId ?? ''),
          turnId: String(snapshot.turn_id ?? snapshot.turnId ?? ''),
          loopIndex: positiveNumber(snapshot.loop_index ?? snapshot.loopIndex),
          provider: String(snapshot.provider ?? ''),
          model: String(snapshot.model ?? ''),
          completedAt: String(snapshot.completed_at ?? snapshot.completedAt ?? ''),
        }
      : null,
    conditional: runtimeToolReasonItems(root.conditional),
    turnAdded: stringList(root.turn_added ?? root.turnAdded),
    discoverablePlugins: stringList(
      root.discoverable_plugins ?? root.discoverablePlugins,
    ),
    disabled: stringList(root.disabled),
    internalGuardEvents: Array.isArray(guardEventsValue)
      ? guardEventsValue.map((item) => {
          const value = recordFromUnknown(item);
          return {
            name: String(value.name ?? ''),
            kind: String(value.kind ?? ''),
            modelVisible: Boolean(value.model_visible ?? value.modelVisible),
            frontendVisible: Boolean(
              value.frontend_visible ?? value.frontendVisible,
            ),
            description: String(value.description ?? ''),
          };
        })
      : [],
    loadErrors: Array.isArray(loadErrorsValue)
      ? loadErrorsValue.map(recordFromUnknown)
      : [],
  };
}

function runtimeToolInventoryEntryFromPayload(
  payload: unknown,
): RuntimeToolInventoryEntry {
  const value = recordFromUnknown(payload);
  const injection = recordFromUnknown(value.injection);
  return {
    name: String(value.name ?? ''),
    package: String(value.package ?? ''),
    description: String(value.description ?? ''),
    enabled: Boolean(value.enabled),
    runtimeLoaded: Boolean(value.runtime_loaded ?? value.runtimeLoaded),
    schemaAvailable: Boolean(value.schema_available ?? value.schemaAvailable),
    inputSchema:
      Object.keys(recordFromUnknown(value.input_schema ?? value.inputSchema)).length > 0
        ? recordFromUnknown(value.input_schema ?? value.inputSchema)
        : undefined,
    dispatch:
      Object.keys(recordFromUnknown(value.dispatch)).length > 0
        ? recordFromUnknown(value.dispatch)
        : undefined,
    injection: {
      core: Boolean(injection.core),
      default: Boolean(injection.default),
    },
    category: String(value.category ?? ''),
  };
}

function runtimeToolReasonItems(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => {
    const record = recordFromUnknown(item);
    return {
      name: String(record.name ?? ''),
      reason: String(record.reason ?? ''),
    };
  });
}

function positiveNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

export async function fetchConversations(): Promise<ConversationSummary[]> {
  const rawItems: unknown[] = [];
  for (let page = 0; page < conversationListMaxPages; page += 1) {
    const offset = page * conversationListPageSize;
    const payload = await readJson<
      { items?: unknown[]; sessions?: unknown[] } | unknown[]
    >(
      url(`/v1/sessions?limit=${conversationListPageSize}&offset=${offset}`),
    );
    const items = sessionItemsFromPayload(payload);
    if (items.length === 0) {
      break;
    }
    rawItems.push(...items);
    if (items.length < conversationListPageSize) {
      break;
    }
  }
  return normalizeConversationList(rawItems);
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
  const query = options.includeSuperseded ? '?include_superseded=true' : '';
  const payload = await readJson<{ messages?: unknown[] }>(
    url(`/v1/sessions/${encodeURIComponent(sessionId)}${query}`),
  );
  const root = asRecord(payload);
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const parsedMessages = messages.map(messageFromPayload).filter((item) => item.id.trim());
  const toolExecutions = toolExecutionsFromPayload(
    root.tool_executions ?? root.toolExecutions,
  );
  const conversation = conversationFromPayload(payload);
  const workspaceContext = workspaceContextFromPayload(
    asRecord(payload).workspace_context ?? asRecord(payload).workspaceContext,
  );
  return {
    conversation: {
      ...conversation,
      workspaceContext,
      projectDir: conversationProjectDirFromWorkspace(conversation.projectDir, workspaceContext),
    },
    messages: attachHistoryToolExecutions(parsedMessages, toolExecutions),
    toolExecutions,
    workspaceContext,
  };
}

export async function createConversation({
  title = '新会话',
  projectDir,
  sessionId,
  metadata,
}: {
  title?: string;
  projectDir?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
} = {}): Promise<ConversationSummary> {
  const endpoint = url('/v1/sessions');
  const payload = await readJson<Record<string, unknown>>(endpoint, {
    method: 'POST',
    body: JSON.stringify({
      title,
      ...(sessionId?.trim() ? { session_id: sessionId.trim() } : {}),
      ...(projectDir?.trim() ? { project_dir: projectDir.trim() } : {}),
      ...(metadata ? { metadata } : {}),
    }),
  });
  return conversationFromPayload(payload);
}

export async function updateConversation({
  sessionId,
  title,
  projectDir,
  metadata,
}: {
  sessionId: string;
  title?: string;
  projectDir?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<ConversationSummary> {
  const normalized = sessionId.trim();
  if (!normalized) {
    throw new Error('会话 ID 为空');
  }
  const payload = await readJson<Record<string, unknown>>(
    url(`/v1/sessions/${encodeURIComponent(normalized)}`),
    {
      method: 'PATCH',
      body: JSON.stringify({
        ...(title != null ? { title } : {}),
        ...(projectDir !== undefined ? { project_dir: projectDir } : {}),
        ...(metadata ? { metadata } : {}),
      }),
    },
  );
  return conversationFromPayload(payload);
}

export async function deleteConversationApi(sessionId: string) {
  const normalized = sessionId.trim();
  if (!normalized) {
    return false;
  }
  const endpoint = url(`/v1/sessions/${encodeURIComponent(normalized)}`);
  const response = await fetch(endpoint, {
    method: 'DELETE',
    headers: await headersFor(endpoint, true),
  });
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new Error(formatHttpError(response.status, await response.text()));
  }
  return true;
}

export async function createSessionShareLink({
  sessionId,
  platform,
  expiresSeconds = 900,
}: {
  sessionId: string;
  platform?: string;
  expiresSeconds?: number;
}): Promise<SessionShareLinkResult> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    throw new Error('会话 ID 为空');
  }
  const normalizedPlatform = platform?.trim().toLowerCase();
  const endpoint = url(
    `/v1/sessions/${encodeURIComponent(normalizedSessionId)}/share-links`,
  );
  const payload = await readJson<Record<string, unknown>>(endpoint, {
    method: 'POST',
    body: JSON.stringify({
      expires_seconds: expiresSeconds,
      ...(normalizedPlatform ? { platform: normalizedPlatform } : {}),
    }),
  });
  const result = shareLinkFromPayload(payload);
  if (!result.code.trim()) {
    throw new Error('Bot 绑定码为空');
  }
  return result;
}

export async function fetchBots(): Promise<BotPlatformOverview[]> {
  const payload = await readJson<Record<string, unknown>>(url('/v1/bots'));
  const candidates =
    payload.bots ?? payload.items ?? payload.platforms ?? payload.data ?? [];
  if (Array.isArray(candidates)) {
    return candidates
      .map(botOverviewFromPayload)
      .filter((item): item is BotPlatformOverview => item != null);
  }
  const record = asRecord(candidates);
  return Object.entries(record)
    .map(([platform, value]) => botOverviewFromPayload({ platform, ...asRecord(value) }))
    .filter((item): item is BotPlatformOverview => item != null);
}

export async function fetchBotConfig(
  platform: BotPlatform,
): Promise<BotConfigResult> {
  const payload = await readJson<Record<string, unknown>>(
    url(`/v1/bots/${encodeURIComponent(platform)}/config`),
  );
  return botConfigFromPayload(platform, payload);
}

export async function saveBotConfig({
  platform,
  config,
}: SaveBotConfigRequest): Promise<BotConfigResult> {
  const endpoint = url(`/v1/bots/${encodeURIComponent(platform)}/config`);
  const payload = await readJson<Record<string, unknown>>(endpoint, {
    method: 'PUT',
    body: JSON.stringify(config),
  });
  return botConfigFromPayload(platform, payload);
}

export async function fetchBotStatus(platform: BotPlatform): Promise<BotStatusResult> {
  const payload = await readJson<Record<string, unknown>>(
    url(`/v1/bots/${encodeURIComponent(platform)}/status`),
  );
  return botStatusFromPayload(platform, payload);
}

export async function startWeixinLogin(): Promise<WeixinLoginStartResult> {
  const endpoint = url('/v1/bots/weixin/login/start');
  const payload = await readJson<Record<string, unknown>>(endpoint, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return weixinLoginStartFromPayload(payload);
}

export async function fetchWeixinLoginStatus(
  loginId: string,
): Promise<WeixinLoginStatusResult> {
  const payload = await readJson<Record<string, unknown>>(
    url(`/v1/bots/weixin/login/${encodeURIComponent(loginId)}/status`),
  );
  return weixinLoginStatusFromPayload(loginId, payload);
}

export async function deleteWeixinAccount(accountId: string): Promise<void> {
  const endpoint = url(
    `/v1/bots/weixin/accounts/${encodeURIComponent(accountId)}`,
  );
  await readJson<Record<string, unknown>>(endpoint, {
    method: 'DELETE',
  });
}

export async function controlBotService(
  platform: BotPlatform,
  action: 'start' | 'stop' | 'restart',
): Promise<BotStatusResult> {
  const endpoint = url(
    `/v1/bots/${encodeURIComponent(platform)}/service/${action}`,
  );
  const payload = await readJson<Record<string, unknown>>(endpoint, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return botStatusFromPayload(platform, payload);
}

export async function fetchBotServiceLogs({
  platform,
  tail = 200,
  since,
}: {
  platform: BotPlatform;
  tail?: number;
  since?: string;
}): Promise<BotServiceLogsResult> {
  const query = new URLSearchParams({ tail: String(tail) });
  if (since?.trim()) {
    query.set('since', since.trim());
  }
  const payload = await readJson<Record<string, unknown>>(
    url(`/v1/bots/${encodeURIComponent(platform)}/service/logs?${query}`),
  );
  return botLogsFromPayload(platform, payload);
}

export async function clearConversationHistory(): Promise<MaintenanceClearResult> {
  const payload = await readJson<Record<string, unknown>>(
    url('/v1/maintenance/conversation-history/clear'),
    {
      method: 'POST',
    },
  );
  return maintenanceClearResultFromPayload(payload);
}

export async function clearLogsCache(): Promise<MaintenanceClearResult> {
  const payload = await readJson<Record<string, unknown>>(
    url('/v1/maintenance/logs-cache/clear'),
    {
      method: 'POST',
    },
  );
  return maintenanceClearResultFromPayload(payload);
}

export async function sendSceneEvent({
  sessionId,
  sceneId,
  turnId,
  event,
  nodeId,
  text,
  values,
  metadata,
}: SceneEventRequest): Promise<Record<string, unknown>> {
  const normalizedSessionId = sessionId.trim();
  const normalizedSceneId = sceneId.trim();
  if (!normalizedSessionId || !normalizedSceneId) {
    throw new Error('Scene 缺少 session_id 或 scene_id');
  }
  return readJson<Record<string, unknown>>(
    url(
      `/v1/sessions/${encodeURIComponent(normalizedSessionId)}/scenes/${encodeURIComponent(normalizedSceneId)}/events`,
    ),
    {
      method: 'POST',
      body: JSON.stringify({
        event,
        ...(turnId?.trim() ? { turn_id: turnId.trim() } : {}),
        ...(nodeId?.trim() ? { node_id: nodeId.trim() } : {}),
        ...(text?.trim() ? { text: text.trim() } : {}),
        ...(values ? { values } : {}),
        ...(metadata ? { metadata } : {}),
      }),
    },
  );
}

export async function fetchSessionScenes(
  sessionId: string,
): Promise<SessionSceneRecord[]> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    return [];
  }
  const payload = await readJson<unknown>(
    url(`/v1/sessions/${encodeURIComponent(normalizedSessionId)}/scenes`),
  );
  const records = sceneRecordsFromPayload(payload, normalizedSessionId);
  return records.filter((item) => item.sceneId.trim());
}

export async function fetchSessionScene({
  sessionId,
  sceneId,
}: {
  sessionId: string;
  sceneId: string;
}): Promise<SessionSceneRecord | null> {
  const normalizedSessionId = sessionId.trim();
  const normalizedSceneId = sceneId.trim();
  if (!normalizedSessionId || !normalizedSceneId) {
    return null;
  }
  const payload = await readJson<Record<string, unknown>>(
    url(
      `/v1/sessions/${encodeURIComponent(normalizedSessionId)}/scenes/${encodeURIComponent(normalizedSceneId)}`,
    ),
  );
  return sceneRecordFromPayload(payload, normalizedSessionId);
}

export async function createShadowConversation({
  sessionId,
  sourceTurnId,
  clientConversationId,
}: {
  sessionId: string;
  sourceTurnId?: string;
  clientConversationId: string;
}): Promise<ShadowConversationRecord> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    throw new Error('Shadow 需要一个已建立的会话');
  }
  const payload = await readJson<Record<string, unknown>>(
    url(`/v1/sessions/${encodeURIComponent(normalizedSessionId)}/shadow-conversations`),
    {
      method: 'POST',
      body: JSON.stringify({
        client_conversation_id: clientConversationId,
        ...(sourceTurnId?.trim() ? { source_turn_id: sourceTurnId.trim() } : {}),
      }),
    },
  );
  return shadowConversationFromPayload(payload, normalizedSessionId);
}

export async function closeShadowConversation(conversationId: string): Promise<void> {
  const normalizedConversationId = conversationId.trim();
  if (!normalizedConversationId) return;
  await readJson<Record<string, unknown>>(
    url(`/v1/shadow-conversations/${encodeURIComponent(normalizedConversationId)}/close`),
    {
      method: 'POST',
      body: JSON.stringify({}),
    },
  );
}

export async function streamShadowConversationMessage(
  request: ShadowConversationStreamRequest,
): Promise<void> {
  const conversationId = request.conversationId.trim();
  const content = request.content.trim();
  if (!conversationId || !content) return;
  const endpoint = url(
    `/v1/shadow-conversations/${encodeURIComponent(conversationId)}/messages/stream`,
  );
  const response = await fetch(endpoint, {
    method: 'POST',
    signal: request.signal,
    headers: {
      ...(await headersFor(endpoint, true)),
      accept: 'text/event-stream',
    },
    body: JSON.stringify({
      content,
      client_message_id: request.clientMessageId,
      model: request.modelConfig.modelName,
      provider: request.modelConfig.provider,
      api_key: request.modelConfig.apiKey,
      base_url: request.modelConfig.baseUrl,
      reasoning_level: normalizeReasoningLevel(request.reasoningLevel),
      stream: true,
    }),
  });
  if (!response.ok || response.body == null) {
    throw new Error(formatHttpError(response.status, await response.text()));
  }

  await readShadowConversationStream(response.body, request);
}

async function readShadowConversationStream(
  body: ReadableStream<Uint8Array>,
  request: ShadowConversationStreamRequest,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';
  let dataLines: string[] = [];
  let assistantText = '';
  let assistantMessageId = '';

  const flush = () => {
    if (dataLines.length === 0) {
      eventName = 'message';
      return;
    }
    const decoded = parseJson(dataLines.join('\n'));
    const currentEvent = eventName;
    eventName = 'message';
    dataLines = [];
    if (!decoded) return;
    if (currentEvent === 'error' || currentEvent === 'shadow_error') {
      throw new Error(streamErrorMessage(decoded));
    }
    if (currentEvent === 'shadow_start') {
      assistantMessageId = String(decoded.message_id ?? decoded.id ?? '');
      request.onStart?.(assistantMessageId);
      return;
    }
    if (currentEvent === 'shadow_token') {
      const delta = String(decoded.delta ?? '');
      if (delta) {
        assistantText += delta;
        request.onDelta?.(delta);
      }
      return;
    }
    if (currentEvent === 'shadow_done') {
      const content = String(decoded.content ?? decoded.message ?? assistantText);
      request.onDone?.({
        id: String(decoded.message_id ?? decoded.id ?? assistantMessageId),
        content,
        createdAt: String(decoded.created_at ?? decoded.createdAt ?? new Date().toISOString()),
      });
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (line === '') {
        flush();
      } else if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const raw = line.slice(5);
        dataLines.push(raw.startsWith(' ') ? raw.slice(1) : raw);
      }
    }
    if (done) break;
  }
  if (buffer.trim()) dataLines.push(buffer.trim());
  flush();
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
  const payload = await readJson<Record<string, unknown>>(
    url(`/v1/sessions/${encodeURIComponent(sessionId.trim())}/context-search`),
    {
      method: 'POST',
      signal,
      body: JSON.stringify({
        query: query.trim(),
        limit,
        roles,
        ...(cursor ? { cursor } : {}),
        ...(excludeMessageIds?.length ? { exclude_message_ids: excludeMessageIds } : {}),
        ...(requestId ? { request_id: requestId } : {}),
      }),
    },
  );
  return {
    requestId: String(payload.request_id ?? ''),
    sessionId: String(payload.session_id ?? sessionId),
    queryFingerprint: String(payload.query_fingerprint ?? ''),
    items: arrayFrom(payload.items).map((value) => {
      const item = asRecord(value);
      return {
        messageId: String(item.message_id ?? ''),
        turnId: String(item.turn_id ?? ''),
        role: normalizeRole(item.role),
        score: Number(item.score ?? 0),
        snippet: String(item.snippet ?? ''),
        createdAt: String(item.created_at ?? ''),
      };
    }),
    nextCursor: optionalString(payload.next_cursor),
    indexState: String(payload.index_state ?? ''),
  };
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
  const query = new URLSearchParams({ before: String(before), after: String(after) });
  const payload = await readJson<Record<string, unknown>>(
    url(`/v1/sessions/${encodeURIComponent(sessionId.trim())}/messages/${encodeURIComponent(messageId.trim())}/window?${query}`),
    { signal },
  );
  return {
    anchorMessageId: String(payload.anchor_message_id ?? messageId),
    messages: arrayFrom(payload.messages).map((item, index) => ({
      ...messageFromPayload(item, index),
      conversationId: sessionId,
    })),
    hasMoreBefore: payload.has_more_before === true,
    hasMoreAfter: payload.has_more_after === true,
    beforeCursor: optionalString(payload.before_cursor),
    afterCursor: optionalString(payload.after_cursor),
  };
}

export async function fetchSessionContextWindowUsage(
  sessionId: string,
  signal?: AbortSignal,
): Promise<RuntimeContextWindowUsage> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    throw new Error('session_id is required');
  }
  const payload = await readJson<Record<string, unknown>>(
    url(`/v1/sessions/${encodeURIComponent(normalizedSessionId)}/context-window`),
    { signal },
  );
  return contextWindowUsageFromPayload(payload, normalizedSessionId);
}

export async function fetchSessionWorkspaceChanges(
  sessionId: string,
  signal?: AbortSignal,
): Promise<ChatToolExecution[]> {
  const normalized = sessionId.trim();
  if (!normalized) return [];
  const payload = await readJson<{ items?: unknown[] }>(
    url(`/v1/sessions/${encodeURIComponent(normalized)}/workspace-changes`),
    { signal },
  );
  return arrayFrom(payload.items)
    .map(asRecord)
    .map((item) => toolExecutionFromPayload(workspaceChangeToolPayload(item)));
}

export interface SendGuidanceResponse {
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
  revertedAt: string;
  turnIds: string[];
}> {
  const normalizedSession = sessionId.trim();
  const normalizedTurns = [...new Set(turnIds.map((value) => value.trim()).filter(Boolean))];
  if (!normalizedSession || normalizedTurns.length === 0) {
    throw new Error('session_id and turn_ids are required');
  }
  const payload = await readJson<Record<string, unknown>>(
    url(`/v1/sessions/${encodeURIComponent(normalizedSession)}/workspace-changes/revert`),
    {
      method: 'POST',
      body: JSON.stringify({ turn_ids: normalizedTurns }),
    },
  );
  return {
    revertedFiles: numericValue(payload.reverted_files),
    revertedAt: String(payload.reverted_at ?? ''),
    turnIds: arrayFrom(payload.turn_ids).map(String),
  };
}

export async function validateTeamWorkflow({
  yaml,
  projectDir,
  workflowId,
}: {
  yaml?: string;
  projectDir?: string;
  workflowId?: string;
}): Promise<TeamWorkflowValidationResult> {
  const payload = await readJson<Record<string, unknown>>(
    url('/v1/team-workflows/validate'),
    {
      method: 'POST',
      body: JSON.stringify({
        ...(yaml?.trim() ? { yaml } : {}),
        ...(projectDir?.trim() ? { project_dir: projectDir.trim() } : {}),
        ...(workflowId?.trim() ? { workflow_id: workflowId.trim() } : {}),
      }),
    },
  );
  return {
    valid: payload.valid === true,
    errors: arrayFrom(payload.errors).map(asRecord),
    warnings: arrayFrom(payload.warnings).map(asRecord),
    normalized: asOptionalRecord(payload.normalized ?? payload.workflow),
    raw: payload,
  };
}

export async function fetchWorkflowRun(runId: string): Promise<Record<string, unknown>> {
  return readJson<Record<string, unknown>>(
    url(`/v1/workflow-runs/${encodeURIComponent(runId.trim())}`),
  );
}

export async function fetchSessionWorkflowRuns(
  sessionId: string,
  limit = 20,
): Promise<Record<string, unknown>[]> {
  const payload = await readJson<Record<string, unknown>>(
    url(`/v1/sessions/${encodeURIComponent(sessionId.trim())}/workflow-runs?limit=${limit}`),
  );
  return arrayFrom(payload.items).map(asRecord);
}

export async function stopWorkflowRun(runId: string): Promise<Record<string, unknown>> {
  return readJson<Record<string, unknown>>(
    url(`/v1/workflow-runs/${encodeURIComponent(runId.trim())}/stop`),
    { method: 'POST' },
  );
}

export async function fetchTeamFlow(sessionId: string): Promise<TeamFlowState> {
  const normalized = sessionId.trim();
  if (!normalized) {
    throw new Error('Team Flow session_id 为空');
  }
  const payload = await readJson<unknown>(
    url(`/v1/team-flows/${encodeURIComponent(normalized)}`),
  );
  return teamFlowStateFromPayload(payload, normalized);
}

export async function fetchTeamFlowGraph(sessionId: string): Promise<TeamFlowGraph> {
  const normalized = sessionId.trim();
  if (!normalized) {
    throw new Error('Team Flow session_id 为空');
  }
  const payload = await readJson<unknown>(
    url(`/v1/team-flows/${encodeURIComponent(normalized)}/graph`),
  );
  return teamFlowGraphFromPayload(payload, normalized);
}

export async function sendTeamFlowAction(
  request: TeamFlowActionRequest,
): Promise<TeamFlowState> {
  const flowId = request.flowId.trim();
  if (!flowId) {
    throw new Error('Team Flow id 为空');
  }
  const text = request.text?.trim() ?? '';
  const payload = await readJson<unknown>(
    url(`/v1/team-flows/${encodeURIComponent(flowId)}/actions`),
    {
      method: 'POST',
      body: JSON.stringify({
        action: request.action,
        ...(text ? { text, instructions: text } : {}),
        ...(request.values ? { values: request.values } : {}),
        ...(request.metadata ? { metadata: request.metadata } : {}),
      }),
    },
  );
  return teamFlowStateFromPayload(payload, flowId);
}

export async function fetchSubagentCapabilities(): Promise<SubagentCapabilities> {
  const payload = await readJson<Record<string, unknown>>(
    url('/v1/subagents/capabilities'),
  );
  return subagentCapabilitiesFromPayload(payload);
}

export async function fetchSubagentRuntime(): Promise<SubagentRuntimeResult> {
  const payload = await readJson<Record<string, unknown>>(
    url('/v1/subagents/runtime'),
  );
  const items = Array.isArray(payload.items) ? payload.items : [];
  const activeTasks = Array.isArray(payload.active_tasks)
    ? payload.active_tasks
    : Array.isArray(payload.activeTasks)
      ? payload.activeTasks
      : [];
  return {
    activeTasks: activeTasks.map(asRecord),
    items: items.map((item) => {
      const value = asRecord(item);
      return {
        ...subagentListItemFromPayload(value),
        runtime: asRecord(value.runtime),
      };
    }),
    usage: asRecord(payload.usage),
    supervisor: subagentSupervisorFromPayload(payload.supervisor),
  };
}

export async function dispatchSubagent({
  sessionId,
  turnId,
  agentName,
  prompt,
  runtimeProfile,
  lane,
  planNodeId,
  exitCondition,
  writeScope,
  waitSeconds = 0,
}: SubagentDispatchRequest): Promise<SubagentDispatchResult> {
  const normalizedSessionId = sessionId.trim();
  if (!normalizedSessionId) {
    throw new Error('会话 ID 为空');
  }
  const normalizedWriteScope = Array.isArray(writeScope)
    ? writeScope.map((item) => item.trim()).filter(Boolean)
    : [];
  const payload = await readJson<Record<string, unknown>>(
    url(`/v1/sessions/${encodeURIComponent(normalizedSessionId)}/subagents/dispatch`),
    {
      method: 'POST',
      body: JSON.stringify({
        agent_name: agentName.trim(),
        prompt: prompt.trim(),
        ...(turnId?.trim() ? { turn_id: turnId.trim() } : {}),
        ...(runtimeProfile?.trim() ? { runtime_profile: runtimeProfile.trim() } : {}),
        ...(lane?.trim() ? { lane: lane.trim() } : {}),
        ...(planNodeId?.trim() ? { plan_node_id: planNodeId.trim() } : {}),
        ...(exitCondition?.trim() ? { exit_condition: exitCondition.trim() } : {}),
        ...(normalizedWriteScope.length > 0 ? { write_scope: normalizedWriteScope } : {}),
        wait_seconds: waitSeconds,
      }),
    },
  );
  return subagentDispatchResultFromPayload(payload);
}

export async function fetchSkills(): Promise<SkillSummary[]> {
  const payload = await readJson<{ skills?: unknown[]; items?: unknown[] }>(
    url('/v1/skills'),
  );
  const items = Array.isArray(payload.skills) ? payload.skills : payload.items;
  if (!Array.isArray(items)) {
    return [];
  }
  return items.map((item) => {
    const value = asRecord(item);
    return {
      name: String(value.name ?? ''),
      description: String(value.description ?? ''),
      descriptionZh: String(value.description_zh ?? ''),
      path: String(value.path ?? ''),
    };
  });
}

export async function fetchSkillDetail(skillName: string): Promise<SkillDetail> {
  const normalized = skillName.trim();
  if (!normalized) {
    throw new Error('Skill 名称为空');
  }
  const payload = await readJson<Record<string, unknown>>(
    url(`/v1/skills/${encodeURIComponent(normalized)}`),
  );
  return skillDetailFromPayload(payload);
}

export async function fetchProjectContext(
  projectDir: string,
): Promise<ProjectContextResult> {
  const normalized = projectDir.trim();
  if (!normalized) {
    return { projectDir: '', userPrompt: '' };
  }
  const payload = await readJson<Record<string, unknown>>(
    url(`/v1/projects/context?project_dir=${encodeURIComponent(normalized)}`),
  );
  return projectContextFromPayload(payload);
}

export async function saveProjectContext({
  projectDir,
  userPrompt,
}: {
  projectDir: string;
  userPrompt: string;
}): Promise<ProjectContextResult> {
  const payload = await readJson<Record<string, unknown>>(url('/v1/projects/context'), {
    method: 'PUT',
    body: JSON.stringify({
      project_dir: projectDir,
      user_prompt: userPrompt,
    }),
  });
  return projectContextFromPayload(payload);
}

export async function fetchPendingInteraction(
  sessionId: string,
): Promise<PendingInteraction | null> {
  const normalized = sessionId.trim();
  if (!normalized) {
    return null;
  }
  const payload = await readJson<Record<string, unknown>>(
    url(`/v1/interactions/pending?session_id=${encodeURIComponent(normalized)}`),
  );
  const interaction = pendingInteractionFromPayload(payload);
  return interaction && isPermissionInteractionPayload(interaction)
    ? permissionInteractionFromPayload(payload)
    : interaction;
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
    throw new Error('交互 ID 为空');
  }
  const normalizedAnswers = answers
    ?.map((answer) => ({
      question_id: answer.questionId,
      ...(answer.selectedOptionId ? { selected_option_id: answer.selectedOptionId } : {}),
      ...(answer.selectedOptionIds && answer.selectedOptionIds.length > 0
        ? { selected_option_ids: answer.selectedOptionIds }
        : {}),
      ...(answer.inputText?.trim() ? { input_text: answer.inputText.trim() } : {}),
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
    throw new Error('交互回答为空');
  }
  await readJson<Record<string, unknown>>(
    url(`/v1/interactions/${encodeURIComponent(normalized)}/reply`),
    {
      method: 'POST',
      body: JSON.stringify(
        normalizedAnswers && normalizedAnswers.length > 0
          ? { answers: normalizedAnswers }
          : { raw_text: trimmedRawText },
      ),
    },
  );
}

export async function cancelInteraction(interactionId: string) {
  const normalized = interactionId.trim();
  if (!normalized) {
    return;
  }
  await readJson<Record<string, unknown>>(
    url(`/v1/interactions/${encodeURIComponent(normalized)}/cancel`),
    {
      method: 'POST',
      body: JSON.stringify({}),
    },
  );
}

export async function stopTurn(turnId: string) {
  const normalized = turnId.trim();
  if (!normalized) {
    return false;
  }
  const endpoint = url(`/v1/turns/${encodeURIComponent(normalized)}/stop`);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: await headersFor(endpoint, true),
  });
  if (response.status === 404) {
    return false;
  }
  if (!response.ok) {
    throw new Error(formatHttpError(response.status, await response.text()));
  }
  return true;
}

export async function streamChat(request: ChatStreamRequest) {
  await streamEndpoint({
    endpoint: url('/v1/chat/stream'),
    method: 'POST',
    body: chatStreamBody(request),
    request,
  });
}

export async function regenerateTurn(request: RegenerateTurnRequest) {
  const sessionId = request.sessionId.trim();
  const turnId = request.turnId.trim();
  if (!sessionId || !turnId) {
    throw new Error('会话或 turn_id 为空');
  }
  await streamEndpoint({
    endpoint: url(
      `/v1/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/regenerate`,
    ),
    method: 'POST',
    body: controlStreamBody(request),
    request,
  });
}

export async function editMessage(request: EditMessageRequest) {
  const sessionId = request.sessionId.trim();
  const messageId = request.messageId.trim();
  const content = request.content.trim();
  if (!sessionId || !messageId) {
    throw new Error('会话或 message_id 为空');
  }
  if (!content) {
    throw new Error('消息内容为空');
  }
  await streamEndpoint({
    endpoint: url(
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(messageId)}`,
    ),
    method: 'PATCH',
    body: {
      ...controlStreamBody(request),
      content,
      regenerate: true,
      truncate_after: true,
    },
    request,
  });
}

export async function sendGuidance(request: SendGuidanceRequest) {
  const sessionId = request.sessionId.trim();
  const turnId = request.turnId.trim();
  const guidance = request.guidance.trim();
  if (!sessionId || !turnId || !guidance) {
    throw new Error('会话、turn_id 或引导内容为空');
  }
  const body: Record<string, unknown> = {
    session_id: sessionId,
    guidance,
    message_id: request.clientMessageId.trim(),
    mode: request.mode,
    source: 'frontend',
    stream: true,
    metadata: {
      source: 'cardbush_electron',
      terminal_runtime: normalizeTerminalRuntime(request.terminalRuntime),
      terminalRuntime: normalizeTerminalRuntime(request.terminalRuntime),
      command_shell: normalizeTerminalRuntime(request.terminalRuntime),
      commandShell: normalizeTerminalRuntime(request.terminalRuntime),
    },
  };
  applyInteractiveRequestsToBody(body, request.interactiveRequestsEnabled);
  const done = await streamEndpoint({
    endpoint: url(`/v1/turns/${encodeURIComponent(turnId)}/guidance`),
    method: 'POST',
    body,
    request,
  });
  const guidanceResult = asRecord(done.guidance);
  return {
    continuationQueued: done.continuation_queued === true,
    willContinueAfterCurrentRound: done.will_continue_after_current_round === true,
    guidance: {
      clientMessageId: String(
        guidanceResult.client_message_id ?? request.clientMessageId,
      ),
      mode: normalizeGuidanceMode(guidanceResult.mode ?? request.mode),
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

async function streamEndpoint({
  endpoint,
  method,
  body,
  request,
}: {
  endpoint: string;
  method: string;
  body: Record<string, unknown>;
  request: Pick<
    ChatStreamRequest,
    | 'sessionId'
    | 'signal'
    | 'onStart'
    | 'onDelta'
    | 'onExecution'
    | 'onAssistantRevision'
    | 'onToolExecution'
    | 'onTaskPlanUpdate'
    | 'onInteractiveRequest'
    | 'onFinalAssistantText'
    | 'onMessages'
    | 'onTeamFlowEvent'
    | 'onThinking'
    | 'onContextWindowUsage'
    | 'onCapabilityCandidates'
    | 'onWorkflowEvent'
    | 'onSceneEvent'
  >;
}) {
  const response = await fetch(endpoint, {
    method,
    signal: request.signal,
    headers: {
      ...(await headersFor(endpoint, true)),
      accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok || response.body == null) {
    const responseText = await response.text();
    if (response.status === 409) {
      const interaction = interactionFromConflictResponse(responseText);
      if (interaction) {
        request.onInteractiveRequest?.(interaction);
        throw new PendingInteractionConflictError(interaction);
      }
    }
    throw new BushServerHttpError(response.status, responseText);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';
  let dataLines: string[] = [];
  let emittedAny = false;
  const seenStreamEvents = new Set<string>();
  let donePayload: Record<string, unknown> = {};

  const flush = () => {
    if (dataLines.length === 0) {
      eventName = 'message';
      return;
    }
    const rawData = dataLines.join('\n');
    dataLines = [];
    const currentEvent = eventName;
    eventName = 'message';
    const eventIdentity = streamEventIdentity(currentEvent, rawData);
    if (eventIdentity && seenStreamEvents.has(eventIdentity)) {
      return;
    }
    if (eventIdentity) {
      seenStreamEvents.add(eventIdentity);
    }
    const effect = handleStreamEvent(currentEvent, rawData, emittedAny, request);
    if (effect?.clearEmitted) {
      emittedAny = false;
    }
    if (effect?.donePayload) {
      donePayload = effect.donePayload;
    }
    if (currentEvent === 'token') {
      emittedAny = true;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line === '') {
        flush();
      } else if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        const raw = line.slice(5);
        dataLines.push(raw.startsWith(' ') ? raw.slice(1) : raw);
      }
    }

    if (done) {
      break;
    }
  }

  if (buffer.trim()) {
    dataLines.push(buffer.trim());
  }
  flush();
  return donePayload;
}

function streamEventIdentity(eventName: string, rawData: string) {
  const payload = parseJson(rawData);
  if (!payload) {
    return '';
  }
  const eventId = optionalString(payload.event_id ?? payload.eventId);
  if (eventId) {
    return `event:${eventId}`;
  }
  const sequence = optionalNumber(payload.sequence);
  if (sequence == null) {
    return '';
  }
  const requestId = optionalString(payload.request_id ?? payload.requestId) ?? '';
  return `sequence:${requestId}:${eventName}:${sequence}`;
}

function controlStreamBody(request: ControlStreamRequest) {
  const body: Record<string, unknown> = {
    stream: true,
    stream_render_mode: 'strict',
    progressive_tool_disclosure: true,
    reference_plan_mode: normalizeReferencePlanMode(request.referencePlanMode),
    workspace_mode: request.projectDir?.trim() ? 'project' : 'task',
    metadata: {
      source: 'cardbush_electron',
      subagent_enabled: true,
      selected_model_alias: request.model,
    },
  };
  const metadata = body.metadata as Record<string, unknown>;
  applyInteractiveRequestsToBody(body, request.interactiveRequestsEnabled);
  applyPermissionModeToBody(body, metadata, request.permissionMode);
  applyReasoningLevelToBody(body, metadata, request.reasoningLevel);
  body.reasoning_trace_visible = request.reasoningTraceVisible === true;
  applyStandardImageInputEnabledToMetadata(metadata, request.standardImageInputEnabled);
  applyBrowserPrivacyModeToMetadata(metadata, request.browserPrivacyMode);
  applyTeamModeToMetadata(metadata, request.teamModeEnabled);
  applyOsModeToMetadata(metadata, request.osModeEnabled);
  applyTerminalRuntimeToMetadata(metadata, request.terminalRuntime);
  applyDisabledToolsToMetadata(metadata, request.disabledTools);
  applyAllowedResourcePathsToMetadata(metadata, request);
  const projectDir = request.projectDir?.trim();
  if (projectDir) {
    body.project_dir = projectDir;
    metadata.workspace_dir = projectDir;
    metadata.user_project_dir = projectDir;
    metadata.project_dir = projectDir;
  }
  if (request.images && request.images.length > 0) {
    body.images = request.images;
  }
  if (request.files && request.files.length > 0) {
    body.files = request.files;
  }
  const projectUserPrompt = request.projectUserPrompt?.trim();
  if (projectUserPrompt) {
    body.project_user_prompt = projectUserPrompt;
    metadata.project_user_prompt = projectUserPrompt;
  }
  const allowedSkills = normalizeSkillNames(request.allowedSkills);
  applyAllowedSkillsToRequest(body, metadata, allowedSkills);
  const config = request.modelConfig;
  if (config) {
    putIfNotEmpty(body, 'model', config.modelName);
    putIfNotEmpty(body, 'provider', config.provider);
    putIfNotEmpty(body, 'api_key', config.apiKey);
    putIfNotEmpty(body, 'base_url', config.baseUrl);
    if (config.maxContextTokens && config.maxContextTokens > 0) {
      body.max_input_tokens = Math.floor(config.maxContextTokens);
      metadata.max_input_tokens = Math.floor(config.maxContextTokens);
      metadata.context_window_tokens = Math.floor(config.maxContextTokens);
    }
    putIfNotEmpty(metadata, 'selected_model', config.modelName);
    putIfNotEmpty(metadata, 'selected_provider', config.provider);
    putIfNotEmpty(metadata, 'selected_model_alias', request.model);
  }
  return body;
}

function chatStreamBody(request: ChatStreamRequest) {
  const body: Record<string, unknown> = {
    session_id: request.sessionId,
    user_input: request.userInput,
    stream: true,
    stream_render_mode: 'strict',
    progressive_tool_disclosure: true,
    reference_plan_mode: normalizeReferencePlanMode(request.referencePlanMode),
    workspace_mode: request.projectDir?.trim() ? 'project' : 'task',
    metadata: {
      source: 'cardbush_electron',
      subagent_enabled: true,
      selected_model_alias: request.model,
    },
  };
  const metadata = body.metadata as Record<string, unknown>;
  applyInteractiveRequestsToBody(body, request.interactiveRequestsEnabled);
  applyPermissionModeToBody(body, metadata, request.permissionMode);
  applyReasoningLevelToBody(body, metadata, request.reasoningLevel);
  body.reasoning_trace_visible = request.reasoningTraceVisible === true;
  applyStandardImageInputEnabledToMetadata(metadata, request.standardImageInputEnabled);
  applyBrowserPrivacyModeToMetadata(metadata, request.browserPrivacyMode);
  applyTeamModeToMetadata(metadata, request.teamModeEnabled);
  applyOsModeToMetadata(metadata, request.osModeEnabled);
  applyTerminalRuntimeToMetadata(metadata, request.terminalRuntime);
  applyDisabledToolsToMetadata(metadata, request.disabledTools);
  applyAllowedResourcePathsToMetadata(metadata, request);
  const projectDir = request.projectDir?.trim();
  if (projectDir) {
    body.project_dir = projectDir;
    metadata.workspace_dir = projectDir;
    metadata.user_project_dir = projectDir;
    metadata.project_dir = projectDir;
  }
  if (request.images && request.images.length > 0) {
    body.images = request.images;
  }
  if (request.files && request.files.length > 0) {
    body.files = request.files;
  }
  const projectUserPrompt = request.projectUserPrompt?.trim();
  if (projectUserPrompt) {
    body.project_user_prompt = projectUserPrompt;
    metadata.project_user_prompt = projectUserPrompt;
  }
  const allowedSkills = normalizeSkillNames(request.allowedSkills);
  applyAllowedSkillsToRequest(body, metadata, allowedSkills);
  const config = request.modelConfig;
  if (config) {
    putIfNotEmpty(body, 'model', config.modelName);
    putIfNotEmpty(body, 'provider', config.provider);
    putIfNotEmpty(body, 'api_key', config.apiKey);
    putIfNotEmpty(body, 'base_url', config.baseUrl);
    if (config.maxContextTokens && config.maxContextTokens > 0) {
      body.max_input_tokens = Math.floor(config.maxContextTokens);
      metadata.max_input_tokens = Math.floor(config.maxContextTokens);
      metadata.context_window_tokens = Math.floor(config.maxContextTokens);
    }
    putIfNotEmpty(metadata, 'selected_model', config.modelName);
    putIfNotEmpty(metadata, 'selected_provider', config.provider);
    putIfNotEmpty(metadata, 'selected_model_alias', request.model);
  }
  return body;
}

function normalizeReferencePlanMode(value?: ReferencePlanMode): ReferencePlanMode {
  return value === 'off' ? 'off' : 'auto';
}

function applyInteractiveRequestsToBody(
  body: Record<string, unknown>,
  enabled?: boolean,
) {
  if (enabled !== true) {
    return;
  }
  body.requestCapabilities = {
    interactiveRequests: true,
  };
}

function normalizePermissionMode(value?: PermissionMode): PermissionMode {
  if (value === 'user_free' || value === 'all_free') {
    return value;
  }
  return 'task_free';
}

function normalizeReasoningLevel(value?: ReasoningLevel): ReasoningLevel {
  if (value === 'low' || value === 'high' || value === 'max') {
    return value;
  }
  return 'medium';
}

function applyReasoningLevelToBody(
  body: Record<string, unknown>,
  metadata: Record<string, unknown>,
  value?: ReasoningLevel,
) {
  const normalized = normalizeReasoningLevel(value);
  body.reasoning_level = normalized;
  metadata.reasoning_level = normalized;
}

function applyPermissionModeToBody(
  body: Record<string, unknown>,
  metadata: Record<string, unknown>,
  value?: PermissionMode,
) {
  const normalized = normalizePermissionMode(value);
  body.permission_mode = normalized;
  metadata.permission_mode = normalized;
  metadata.permissionMode = normalized;
}

function applyStandardImageInputEnabledToMetadata(
  metadata: Record<string, unknown>,
  value?: boolean,
) {
  const enabled = value === true;
  metadata.standard_image_input_enabled = enabled;
  metadata.standardImageInputEnabled = enabled;
}

function applyBrowserPrivacyModeToMetadata(
  metadata: Record<string, unknown>,
  value?: boolean,
) {
  if (value !== true) {
    return;
  }
  metadata.browser_privacy_mode = true;
  metadata.browserPrivacyMode = true;
  metadata.browser_storage_mode = 'private';
  metadata.browserStorageMode = 'private';
}

function applyTeamModeToMetadata(
  metadata: Record<string, unknown>,
  value?: boolean,
) {
  if (value !== true) {
    return;
  }
  metadata.team_mode_enabled = true;
  metadata.teamModeEnabled = true;
  metadata.team_mode = 'agent_flow';
  metadata.teamMode = 'agent_flow';
}

function applyOsModeToMetadata(
  metadata: Record<string, unknown>,
  value?: boolean,
) {
  if (value !== true) {
    return;
  }
  metadata.os_mode_enabled = true;
  metadata.osModeEnabled = true;
  metadata.runtime_mode = 'desktop_os';
  metadata.runtimeMode = 'desktop_os';
  metadata.workspace_mode = 'desktop';
  metadata.workspaceMode = 'desktop';
}

function normalizeTerminalRuntime(value?: TerminalRuntime) {
  if (value === 'wsl' || value === 'git_bash' || value === 'bash') {
    return value;
  }
  return 'powershell';
}

function applyTerminalRuntimeToMetadata(
  metadata: Record<string, unknown>,
  value?: TerminalRuntime,
) {
  const normalized = normalizeTerminalRuntime(value);
  metadata.terminal_runtime = normalized;
  metadata.terminalRuntime = normalized;
  metadata.command_shell = normalized;
  metadata.commandShell = normalized;
}

function normalizeSkillNames(values?: string[]) {
  if (!values) {
    return undefined;
  }
  const normalized = values
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index)
    .sort();
  return normalized.length > 0 ? normalized : undefined;
}

function putIfNotEmpty(target: Record<string, unknown>, key: string, value: string) {
  const trimmed = value.trim();
  if (trimmed) {
    target[key] = trimmed;
  }
}

function handleStreamEvent(
  eventName: string,
  rawData: string,
  emittedAny: boolean,
  request: Pick<
    ChatStreamRequest,
    | 'sessionId'
    | 'onStart'
    | 'onDelta'
    | 'onExecution'
    | 'onToolExecution'
    | 'onTaskPlanUpdate'
    | 'onInteractiveRequest'
    | 'onFinalAssistantText'
    | 'onMessages'
    | 'onAssistantRevision'
    | 'onTeamFlowEvent'
    | 'onThinking'
    | 'onContextWindowUsage'
    | 'onCapabilityCandidates'
    | 'onWorkflowEvent'
    | 'onSceneEvent'
  >,
): { clearEmitted?: boolean; donePayload?: Record<string, unknown> } | undefined {
  const decoded = parseJson(rawData);
  if (decoded == null) {
    return;
  }

  if (eventName === 'start') {
    request.onStart?.({
      sessionId: String(decoded.session_id ?? ''),
      turnId: String(decoded.turn_id ?? ''),
      messageId: optionalString(decoded.message_id ?? decoded.messageId),
      assistantSegmentIndex: optionalNumber(
        decoded.assistant_segment_index ?? decoded.assistantSegmentIndex,
      ),
      createdAt: optionalString(decoded.created_at ?? decoded.createdAt),
    });
    return;
  }

  if (eventName === 'error') {
    throw new Error(streamErrorMessage(decoded));
  }

  if (eventName === 'token') {
    const delta = String(decoded.delta ?? '');
    if (delta) {
      request.onDelta?.(delta, assistantStreamChunkFromPayload(decoded));
    }
    return;
  }

  if (eventName === 'reasoning') {
    const rawPhase = String(decoded.phase ?? 'delta').trim().toLowerCase();
    const phase: ThinkingStreamEvent['phase'] =
      rawPhase === 'start' || rawPhase === 'end' ? rawPhase : 'delta';
    const delta = String(decoded.delta ?? '');
    if (phase === 'delta' && !delta) {
      return;
    }
    const turnId = String(decoded.turn_id ?? '');
    const generationId = String(decoded.generation_id ?? turnId);
    if (!turnId || !generationId) {
      return;
    }
    const loopIndex = optionalNumber(decoded.loop_index);
    const attemptIndex = optionalNumber(decoded.attempt_index);
    request.onThinking?.({
      id: generationId,
      channel: 'reasoning',
      turnId,
      generationId,
      phase,
      ...(loopIndex !== undefined ? { loopIndex } : {}),
      ...(attemptIndex !== undefined ? { attemptIndex } : {}),
      delta,
      content: '',
      preview: delta,
      createdAt: String(decoded.created_at ?? new Date().toISOString()),
    });
    return;
  }

  if (eventName === 'context_window_usage') {
    request.onContextWindowUsage?.(contextWindowUsageFromPayload(decoded));
    return;
  }

  if (eventName === 'capability_candidates') {
    request.onCapabilityCandidates?.(capabilityCandidatesFromPayload(decoded));
    return;
  }

  if (
    eventName === 'workflow_started' ||
    eventName === 'workflow_node_state' ||
    eventName === 'workflow_node_output' ||
    eventName === 'workflow_completed' ||
    eventName === 'workflow_failed'
  ) {
    request.onWorkflowEvent?.(workflowStreamEventFromPayload(eventName, decoded));
    return;
  }

  if (
    eventName === 'scene_presented' ||
    eventName === 'scene_updated' ||
    eventName === 'scene_closed'
  ) {
    request.onSceneEvent?.(sceneStreamEventFromPayload(eventName, decoded));
    return;
  }

  if (eventName === 'assistant_revision') {
    const revision = assistantRevisionFromPayload(decoded);
    request.onAssistantRevision?.(revision);
    if (revision.action === 'clear' || revision.action === 'replace') {
      return { clearEmitted: true };
    }
    return undefined;
  }

  if (eventName === 'tool') {
    request.onToolExecution?.(toolExecutionFromPayload(decoded));
    return;
  }

  if (eventName === 'workspace_change' || eventName === 'file_change') {
    request.onToolExecution?.(
      toolExecutionFromPayload(workspaceChangeToolPayload(decoded)),
    );
    return;
  }

  if (eventName === 'desktop_action') {
    request.onToolExecution?.(
      toolExecutionFromPayload(desktopActionToolPayload(decoded)),
    );
    return;
  }

  if (eventName === 'execution') {
    request.onExecution?.(executionUpdateFromPayload(decoded));
    const update = taskPlanUpdateFromExecutionPayload(decoded, request.sessionId);
    if (update) {
      request.onTaskPlanUpdate?.(update);
    }
    return;
  }

  if (eventName === 'interactive_request') {
    const interaction = pendingInteractionFromPayload(decoded);
    if (interaction) {
      request.onInteractiveRequest?.(
        isPermissionInteractionPayload(interaction)
          ? permissionInteractionFromPayload(decoded) ?? interaction
          : interaction,
      );
    }
    return;
  }

  if (eventName === 'path_permission_request') {
    const interaction = permissionInteractionFromPayload(decoded);
    if (interaction) {
      request.onInteractiveRequest?.(interaction);
    }
    return;
  }

  if (
    eventName === 'team_layer' ||
    eventName === 'team_node' ||
    eventName === 'team_action_required'
  ) {
    request.onTeamFlowEvent?.(teamFlowStreamEventFromPayload(eventName, decoded));
    return;
  }

  if (
    eventName === 'message' ||
    eventName === 'assistant_message'
  ) {
    const messages = messagesFromPayload(decoded);
    if (messages.length > 0) {
      request.onMessages?.(messages, false);
    }
    return;
  }

  if (eventName === 'done') {
    const text = String(decoded.assistant_message ?? decoded.assistantMessage ?? '');
    if (text && request.onFinalAssistantText) {
      request.onFinalAssistantText(text, assistantStreamChunkFromPayload(decoded));
      return { donePayload: decoded };
    }
    if (text && !emittedAny) {
      request.onDelta?.(text, assistantStreamChunkFromPayload(decoded));
    }
    return { donePayload: decoded };
  }

  const text = decoded.delta ?? decoded.text ?? decoded.content;
  if (text != null) {
    request.onDelta?.(String(text), assistantStreamChunkFromPayload(decoded));
  }
}

function normalizeGuidanceMode(value: unknown): SendGuidanceRequest['mode'] {
  return value === 'interrupt_and_continue'
    ? 'interrupt_and_continue'
    : 'append_context';
}

function sessionItemsFromPayload(
  payload: { items?: unknown[]; sessions?: unknown[] } | unknown[],
) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload.items)) {
    return payload.items;
  }
  return Array.isArray(payload.sessions) ? payload.sessions : [];
}

function normalizeConversationList(items: unknown[]): ConversationSummary[] {
  const byId = new Map<
    string,
    { conversation: ConversationSummary; index: number; timestamp: number }
  >();
  items.forEach((item, index) => {
    if (isInternalConversationPayload(item)) {
      return;
    }
    const conversation = conversationFromPayload(item, index);
    const id = conversation.id.trim();
    if (!id) {
      return;
    }
    const timestamp = conversationTimestamp(item);
    const existing = byId.get(id);
    if (!existing || timestamp > existing.timestamp) {
      byId.set(id, { conversation, index, timestamp });
    }
  });
  return Array.from(byId.values())
    .sort((left, right) => {
      if (left.timestamp !== right.timestamp) {
        return right.timestamp - left.timestamp;
      }
      return left.index - right.index;
    })
    .map((item) => item.conversation)
    .slice(0, conversationListMaxVisible);
}

function conversationTimestamp(item: unknown) {
  const value = asRecord(item);
  const metadata = asRecord(value.metadata);
  const candidates = [
    value.updated_at,
    value.updatedAt,
    value.last_message_at,
    value.lastMessageAt,
    value.created_at,
    value.createdAt,
    metadata.updated_at,
    metadata.updatedAt,
    metadata.last_message_at,
    metadata.lastMessageAt,
  ];
  for (const candidate of candidates) {
    const parsed = Date.parse(String(candidate ?? ''));
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function conversationFromPayload(item: unknown, index = 0): ConversationSummary {
  if (typeof item === 'string') {
    const id = item.trim();
    return {
      id,
      title: defaultConversationTitle(id),
      preview: '',
      updatedAt: new Date().toISOString(),
    };
  }
  const value = asRecord(item);
  const id = String(value.id ?? value.session_id ?? value.sessionId ?? `session-${index}`);
  return {
    id,
    title: normalizeConversationTitle(value.title ?? value.name, id),
    preview: String(value.preview ?? value.summary ?? value.last_message_preview ?? ''),
    updatedAt: String(value.updated_at ?? value.updatedAt ?? new Date().toISOString()),
    projectDir: value.project_dir == null ? undefined : String(value.project_dir),
    metadata: asOptionalRecord(value.metadata),
    workspaceContext: workspaceContextFromPayload(
      value.workspace_context ?? value.workspaceContext,
    ),
  };
}

function normalizeConversationTitle(value: unknown, sessionId: string) {
  const title = String(value ?? '').trim();
  if (!title || isGeneratedConversationTitle(title, sessionId)) {
    return defaultConversationTitle(sessionId);
  }
  return title;
}

function defaultConversationTitle(_sessionId: string) {
  return '新会话';
}

function isGeneratedConversationTitle(title: string, sessionId: string) {
  const normalized = title.trim();
  const normalizedId = sessionId.trim();
  if (normalizedId && normalized === normalizedId) {
    return true;
  }
  const lower = normalized.toLowerCase();
  return (
    lower.startsWith('local-') ||
    lower.startsWith('weixin:') ||
    lower.startsWith('feishu:') ||
    lower.startsWith('telegram:') ||
    lower.startsWith('discord:') ||
    lower.includes('@im.bot') ||
    lower.includes('@im.wechat') ||
    /^cardbush-\d/.test(lower)
  );
}

function teamFlowStateFromPayload(
  payload: unknown,
  fallbackId = '',
): TeamFlowState {
  const root = asRecord(payload);
  const flow = asRecord(
    root.flow ??
      root.team_flow ??
      root.teamFlow ??
      root.state ??
      root.snapshot ??
      payload,
  );
  const sessionId = String(
    flow.session_id ??
      flow.sessionId ??
      root.session_id ??
      root.sessionId ??
      fallbackId,
  ).trim();
  const flowId = String(
    flow.team_flow_id ??
      flow.teamFlowId ??
      flow.flow_id ??
      flow.flowId ??
      flow.id ??
      root.team_flow_id ??
      root.teamFlowId ??
      root.flow_id ??
      root.flowId ??
      fallbackId,
  ).trim();
  const currentLayer = asRecord(flow.current_layer ?? flow.currentLayer);
  const currentLayerId = optionalString(
    flow.current_layer_id ??
      flow.currentLayerId ??
      currentLayer.id ??
      currentLayer.layer_id ??
      currentLayer.layerId,
  );
  const currentLayerIndex = optionalNumber(
    flow.current_layer_index ??
      flow.currentLayerIndex ??
      currentLayer.index ??
      currentLayer.layer_index ??
      currentLayer.layerIndex,
  );
  const rawLayers = arrayFrom(
    flow.layers ?? root.layers ?? flow.layer_list ?? flow.layerList,
  );
  const layers = rawLayers.map((item, index) => teamFlowLayerFromPayload(item, index));
  if (Object.keys(currentLayer).length > 0) {
    const normalizedCurrent = teamFlowLayerFromPayload(
      {
        ...currentLayer,
        id: currentLayerId ?? currentLayer.id,
        index: currentLayerIndex ?? currentLayer.index,
      },
      layers.length,
    );
    if (!layers.some((item) => item.id === normalizedCurrent.id)) {
      layers.push(normalizedCurrent);
    }
  }
  const directNodes = arrayFrom(flow.nodes ?? root.nodes).map((item, index) =>
    teamFlowNodeFromPayload(item, index),
  );
  const layerNodes = layers.flatMap((layer) => layer.nodes);
  const nodes = mergeTeamFlowNodes([...directNodes, ...layerNodes]);
  const actionOptions = teamFlowActionOptionList(
    flow.action_options ??
      flow.actionOptions ??
      root.action_options ??
      root.actionOptions,
  );
  const suggestedActions =
    actionOptions.length > 0
      ? actionOptions.map((option) => option.action)
      : teamFlowActionList(
          flow.suggested_actions ??
            flow.suggestedActions ??
            flow.actions ??
            root.suggested_actions ??
            root.suggestedActions ??
            root.actions,
        );
  return {
    id: flowId || sessionId || fallbackId,
    flowId: flowId || fallbackId,
    sessionId,
    status: String(flow.status ?? root.status ?? ''),
    currentLayerId,
    currentLayerIndex,
    layers,
    nodes,
    suggestedActions,
    actionOptions:
      actionOptions.length > 0
        ? actionOptions
        : suggestedActions.map(teamFlowActionOptionFromAction),
    raw: root,
  };
}

function teamFlowGraphFromPayload(
  payload: unknown,
  fallbackSessionId = '',
): TeamFlowGraph {
  const root = asRecord(payload);
  const flow = teamFlowStateFromPayload(
    root.flow ?? root.team_flow ?? root.teamFlow ?? root.state ?? payload,
    fallbackSessionId,
  );
  const nodes = mergeTeamFlowNodes([
    ...arrayFrom(root.nodes).map((item, index) => teamFlowNodeFromPayload(item, index)),
    ...flow.nodes,
  ]);
  const edges = arrayFrom(root.edges ?? root.links).map((item, index) =>
    teamFlowEdgeFromPayload(item, index),
  );
  return {
    flow,
    nodes,
    edges,
    raw: root,
  };
}

function teamFlowLayerFromPayload(payload: unknown, index = 0): TeamFlowLayer {
  const item = asRecord(payload);
  const layerIndex = optionalNumber(
    item.index ?? item.layer_index ?? item.layerIndex ?? item.order,
  );
  const id = String(
    item.id ??
      item.layer_id ??
      item.layerId ??
      (layerIndex != null ? `layer-${layerIndex}` : `layer-${index + 1}`),
  ).trim();
  const nodes = arrayFrom(item.nodes ?? item.scene_agents ?? item.sceneAgents).map(
    (node, nodeIndex) =>
      teamFlowNodeFromPayload(
        {
          ...asRecord(node),
          layer_id: asRecord(node).layer_id ?? asRecord(node).layerId ?? id,
          layer_index:
            asRecord(node).layer_index ?? asRecord(node).layerIndex ?? layerIndex,
        },
        nodeIndex,
      ),
  );
  return {
    id,
    index: layerIndex,
    title: String(
      item.title ??
        item.name ??
        item.label ??
        (layerIndex != null ? `Layer ${layerIndex}` : `Layer ${index + 1}`),
    ),
    goal: String(item.goal ?? item.objective ?? item.target ?? ''),
    summary: String(item.summary ?? item.description ?? item.message ?? ''),
    status: String(item.status ?? item.state ?? ''),
    nodes,
    suggestedActions: teamFlowActionList(
      item.suggested_actions ?? item.suggestedActions ?? item.actions,
    ),
    actionOptions: teamFlowActionOptionList(item.action_options ?? item.actionOptions),
    raw: item,
  };
}

function teamFlowNodeFromPayload(payload: unknown, index = 0): TeamFlowNode {
  const item = asRecord(payload);
  const id = String(
    item.id ??
      item.node_id ??
      item.nodeId ??
      item.name ??
      item.title ??
      `node-${index + 1}`,
  ).trim();
  return {
    id,
    layerId: optionalString(item.layer_id ?? item.layerId),
    layerIndex: optionalNumber(item.layer_index ?? item.layerIndex),
    title: String(item.title ?? item.name ?? item.label ?? id),
    summary: String(item.summary ?? item.description ?? item.goal ?? item.objective ?? ''),
    status: String(item.status ?? item.state ?? ''),
    kind: optionalString(item.kind ?? item.type),
    profileId: optionalString(item.profile_id ?? item.profileId ?? item.profile),
    parentIds: stringList(
      item.parent_ids ?? item.parentIds ?? item.parents ?? item.dependencies,
    ),
    tools: stringList(item.tools ?? item.tool_names ?? item.toolNames),
    validation: optionalString(
      item.validation ?? item.validation_contract ?? item.validationContract,
    ),
    raw: item,
  };
}

function teamFlowEdgeFromPayload(payload: unknown, index = 0): TeamFlowEdge {
  const item = asRecord(payload);
  const source = String(item.source ?? item.from ?? item.parent ?? '').trim();
  const target = String(item.target ?? item.to ?? item.child ?? '').trim();
  return {
    id: String(item.id ?? `${source || 'source'}-${target || 'target'}-${index}`),
    source,
    target,
    label: optionalString(item.label ?? item.title),
    raw: item,
  };
}

function teamFlowStreamEventFromPayload(
  type: TeamFlowStreamEvent['type'],
  payload: unknown,
): TeamFlowStreamEvent {
  const root = asRecord(payload);
  const layerPayload = root.layer ?? root.current_layer ?? root.currentLayer;
  const nodePayload = root.node ?? root.team_node ?? root.teamNode;
  const layer =
    layerPayload != null
      ? teamFlowLayerFromPayload(layerPayload)
      : type === 'team_layer'
        ? teamFlowLayerFromPayload(root)
        : undefined;
  const node =
    nodePayload != null
      ? teamFlowNodeFromPayload(nodePayload)
      : type === 'team_node'
        ? teamFlowNodeFromPayload(root)
        : undefined;
  return {
    type,
    flowId: optionalString(
      root.team_flow_id ?? root.teamFlowId ?? root.flow_id ?? root.flowId,
    ),
    sessionId: optionalString(root.session_id ?? root.sessionId),
    status: optionalString(root.status ?? root.state),
    currentLayerId: optionalString(
      root.current_layer_id ??
        root.currentLayerId ??
        layer?.id ??
        node?.layerId,
    ),
    currentLayerIndex: optionalNumber(
      root.current_layer_index ??
        root.currentLayerIndex ??
        layer?.index ??
        node?.layerIndex,
    ),
    layer,
    node,
    suggestedActions:
      teamFlowActionOptionList(root.action_options ?? root.actionOptions).length > 0
        ? teamFlowActionOptionList(root.action_options ?? root.actionOptions).map(
            (option) => option.action,
          )
        : teamFlowActionList(root.suggested_actions ?? root.suggestedActions ?? root.actions),
    actionOptions: teamFlowActionOptionList(
      root.action_options ?? root.actionOptions,
    ),
    raw: root,
  };
}

function teamFlowActionList(value: unknown): TeamFlowActionType[] {
  return stringList(value).filter(Boolean);
}

function teamFlowActionOptionList(value: unknown): TeamFlowActionOption[] {
  return arrayFrom(value)
    .map((item, index) => teamFlowActionOptionFromPayload(item, index))
    .filter((item): item is TeamFlowActionOption => Boolean(item?.action));
}

function teamFlowActionOptionFromPayload(
  payload: unknown,
  index = 0,
): TeamFlowActionOption | null {
  if (typeof payload === 'string') {
    return teamFlowActionOptionFromAction(payload);
  }
  const item = asRecord(payload);
  const action = String(item.action ?? item.id ?? item.name ?? '').trim();
  if (!action) {
    return null;
  }
  const id = String(item.id ?? action ?? `action-${index + 1}`).trim();
  return {
    id: id || action,
    action,
    label: optionalString(item.label ?? item.title ?? item.text),
    labelKey: optionalString(item.label_key ?? item.labelKey),
    control: optionalString(item.control ?? item.preferred_control ?? item.preferredControl),
    description: optionalString(item.description ?? item.summary),
    raw: item,
  };
}

function teamFlowActionOptionFromAction(
  action: TeamFlowActionType,
): TeamFlowActionOption {
  return {
    id: action,
    action,
    raw: { action },
  };
}

function mergeTeamFlowNodes(nodes: TeamFlowNode[]) {
  const byId = new Map<string, TeamFlowNode>();
  for (const node of nodes) {
    if (!node.id) {
      continue;
    }
    byId.set(node.id, { ...(byId.get(node.id) ?? node), ...node });
  }
  return Array.from(byId.values());
}

function arrayFrom(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function shadowConversationFromPayload(
  value: unknown,
  fallbackSessionId = '',
): ShadowConversationRecord {
  const root = asRecord(value);
  const payload = asRecord(root.conversation ?? root.shadow_conversation ?? root);
  return {
    id: String(payload.id ?? payload.conversation_id ?? payload.shadow_conversation_id ?? ''),
    sessionId: String(payload.session_id ?? payload.sessionId ?? fallbackSessionId),
    sourceTurnId: String(payload.source_turn_id ?? payload.sourceTurnId ?? ''),
    agentName: String(payload.agent_name ?? payload.agentName ?? 'Shadow Agent'),
    status: String(payload.status ?? 'active'),
    createdAt: String(payload.created_at ?? payload.createdAt ?? ''),
    updatedAt: String(payload.updated_at ?? payload.updatedAt ?? ''),
    raw: payload,
  };
}

function workflowStreamEventFromPayload(
  type: string,
  value: unknown,
): TeamWorkflowStreamEvent {
  const payload = asRecord(value);
  return {
    type,
    runId: String(payload.run_id ?? payload.runId ?? ''),
    workflowId: String(payload.workflow_id ?? payload.workflowId ?? ''),
    sessionId: String(payload.session_id ?? payload.sessionId ?? ''),
    turnId: String(payload.turn_id ?? payload.turnId ?? ''),
    nodeId: String(payload.node_id ?? payload.nodeId ?? ''),
    status: String(payload.status ?? ''),
    summary: String(payload.summary ?? payload.message ?? ''),
    raw: payload,
  };
}

function sceneStreamEventFromPayload(
  type: SceneStreamEvent['type'],
  value: unknown,
): SceneStreamEvent {
  const payload = asRecord(value);
  return {
    type,
    sceneId: String(payload.scene_id ?? payload.sceneId ?? ''),
    sessionId: String(payload.session_id ?? payload.sessionId ?? ''),
    turnId: String(payload.turn_id ?? payload.turnId ?? ''),
    revision: optionalNumber(payload.revision),
    status: String(payload.status ?? ''),
    title: String(payload.title ?? ''),
    summary: String(payload.summary ?? ''),
    scene: asOptionalRecord(payload.scene),
    raw: payload,
  };
}

function contextWindowUsageFromPayload(
  value: unknown,
  fallbackSessionId = '',
): RuntimeContextWindowUsage {
  const payload = asRecord(value);
  const usedTokens = optionalNumber(payload.used_tokens ?? payload.usedTokens);
  const maxTokens = optionalNumber(payload.max_tokens ?? payload.maxTokens);
  const remainingTokens = optionalNumber(
    payload.remaining_tokens ?? payload.remainingTokens,
  ) ?? (
    usedTokens != null && maxTokens != null
      ? Math.max(0, maxTokens - usedTokens)
      : undefined
  );
  const usageRatio = optionalNumber(payload.usage_ratio ?? payload.usageRatio) ?? (
    usedTokens != null && maxTokens != null && maxTokens > 0
      ? usedTokens / maxTokens
      : undefined
  );
  return {
    sessionId: String(payload.session_id ?? payload.sessionId ?? fallbackSessionId),
    turnId: String(payload.turn_id ?? payload.turnId ?? ''),
    model: String(payload.model ?? ''),
    usedTokens,
    maxTokens,
    remainingTokens,
    usageRatio,
    measuredAt: String(
      payload.measured_at ?? payload.measuredAt ?? new Date().toISOString(),
    ),
    source: String(payload.source ?? 'runtime_context'),
    raw: payload,
  };
}

function backendCapabilitiesFromPayload(payload: unknown): BackendCapabilities {
  const root = asRecord(payload);
  const features = asRecord(root.features ?? root.capabilities ?? root);
  const endpoints = asRecord(root.endpoints);
  const terminalRuntime = asRecord(
    root.terminal_runtime ?? root.terminalRuntime,
  );
  const reasoningLevel = asRecord(
    root.reasoning_level ?? root.reasoningLevel,
  );
  const reasoningStream = asRecord(
    root.reasoning_stream ?? root.reasoningStream,
  );
  const permissionRequests = asRecord(
    root.permission_requests ?? root.permissionRequests,
  );
  const requestCapabilities = asRecord(
    root.request_capabilities ?? root.requestCapabilities,
  );
  const requestCapabilityItems = asRecord(requestCapabilities.capabilities);
  const interactiveRequestsPayload =
    requestCapabilityItems.interactive_requests ??
    requestCapabilityItems.interactiveRequests;
  const standardImageInputTool = asRecord(
    root.standard_image_input_tool ??
      root.standardImageInputTool ??
      features.standard_image_input_tool ??
      features.standardImageInputTool ??
      features.standard_image_input_tool_config ??
      features.standardImageInputToolConfig,
  );
  return {
    chatStream: capabilityBoolean(features, endpoints, 'chatStream', ['chat_stream']),
    sessions: capabilityBoolean(features, endpoints, 'sessions', ['session_history']),
    skills: capabilityBoolean(features, endpoints, 'skills'),
    interactions: capabilityBoolean(features, endpoints, 'interactions'),
    interactiveRequests: interactiveRequestCapabilityAvailable(
      requestCapabilities,
      interactiveRequestsPayload,
    ),
    permissionRequests: typeof permissionRequests.available === 'boolean'
      ? permissionRequests.available
      : capabilityBoolean(features, endpoints, 'permissionRequests', [
          'permission_requests',
        ]),
    turnStop: capabilityBoolean(features, endpoints, 'turnStop', ['turn_stop']),
    runtimeInspection: capabilityBoolean(features, endpoints, 'runtimeInspection', [
      'runtime_inspection',
    ]),
    maintenanceConversationHistoryClear: capabilityBoolean(
      features,
      endpoints,
      'maintenanceConversationHistoryClear',
      ['maintenance_conversation_history_clear'],
    ),
    maintenanceLogsCacheClear: capabilityBoolean(
      features,
      endpoints,
      'maintenanceLogsCacheClear',
      ['maintenance_logs_cache_clear'],
    ),
    botControl: capabilityBoolean(features, endpoints, 'botControl', ['bot_control']),
    sessionShareLinks: capabilityBoolean(features, endpoints, 'sessionShareLinks', [
      'session_share_links',
      'bot_session_handoff',
    ]),
    messageEditRegenerate: capabilityBoolean(
      features,
      endpoints,
      'messageEditRegenerate',
      ['message_edit_regenerate'],
    ),
    turnRegenerate: capabilityBoolean(features, endpoints, 'turnRegenerate', [
      'turn_regenerate',
    ]),
    stableMessageIds: capabilityBoolean(
      features,
      endpoints,
      'stableMessageIds',
      ['stable_message_ids', 'stable_message_id', 'message_ids'],
    ),
    standardImageInputTool: standardImageInputToolAvailable(
      features,
      endpoints,
      standardImageInputTool,
    ),
    standardImageInputToolName:
      nonEmpty(
        standardImageInputTool.tool_name ??
          standardImageInputTool.toolName ??
          root.standard_image_input_tool_name ??
          root.standardImageInputToolName ??
          features.standard_image_input_tool_name ??
          features.standardImageInputToolName,
      ) ?? standardImageInputToolDefaultName,
    projects: capabilityBoolean(features, endpoints, 'projects'),
    git: capabilityBoolean(features, endpoints, 'git'),
    terminal: capabilityBoolean(features, endpoints, 'terminal'),
    resources: capabilityBoolean(features, endpoints, 'resources'),
    settingsSync: capabilityBoolean(features, endpoints, 'settingsSync', [
      'settings_sync',
    ]),
    mcpServers: capabilityBoolean(features, endpoints, 'mcpServers', [
      'mcp_servers',
      'mcp_tool_loading',
      'mcp_tools',
      'mcp',
    ]),
    subagents: capabilityBoolean(features, endpoints, 'subagents'),
    subagentFrontendConfiguration: capabilityBoolean(
      features,
      endpoints,
      'subagentFrontendConfiguration',
      ['subagent_frontend_configuration'],
    ),
    remoteAgentsViaMcp: capabilityBoolean(features, endpoints, 'remoteAgentsViaMcp', [
      'remote_agents_via_mcp',
    ]),
    teamMode: capabilityBoolean(features, endpoints, 'teamMode', ['team_mode']),
    teamAgentFlow: capabilityBoolean(features, endpoints, 'teamAgentFlow', [
      'team_agent_flow',
    ]),
    teamFlowState: capabilityBoolean(features, endpoints, 'teamFlowState', [
      'team_flow_state',
    ]),
    teamFlowActions: capabilityBoolean(features, endpoints, 'teamFlowActions', [
      'team_flow_actions',
    ]),
    teamFlowEvents: capabilityBoolean(features, endpoints, 'teamFlowEvents', [
      'team_flow_events',
    ]),
    teamWorkflows: capabilityBoolean(features, endpoints, 'teamWorkflows', [
      'team_workflows',
    ]),
    workflowRuntime: capabilityBoolean(features, endpoints, 'workflowRuntime', [
      'workflow_runtime',
    ]),
    shadowConversationActivation: capabilityBoolean(
      features,
      endpoints,
      'shadowConversationActivation',
      [
        'shadow_conversation_activation',
        'shadow_conversations',
        'shadow_conversation_messages',
      ],
    ),
    contextWindowUsage: capabilityBoolean(features, endpoints, 'contextWindowUsage', [
      'context_window_usage',
      'session_context_window',
    ]),
    capabilityDiscovery: capabilityBoolean(features, endpoints, 'capabilityDiscovery', [
      'capability_discovery',
    ]),
    workspaceChanges: capabilityBoolean(features, endpoints, 'workspaceChanges', [
      'workspace_changes',
      'workspace_change_stream',
      'file_change_stream',
    ]),
    sessionContextSearch: capabilityBoolean(features, endpoints, 'sessionContextSearch', [
      'session_context_search',
    ]),
    sessionActivityOrdering: capabilityBoolean(
      features,
      endpoints,
      'sessionActivityOrdering',
      ['session_activity_ordering'],
    ),
    agentVisualScenes: capabilityBoolean(features, endpoints, 'agentVisualScenes', [
      'agent_visual_scenes',
    ]),
    browserCookiePersistence: capabilityBoolean(
      features,
      endpoints,
      'browserCookiePersistence',
      ['browser_cookie_persistence'],
    ),
    browserPrivacyMode: capabilityBoolean(features, endpoints, 'browserPrivacyMode', [
      'browser_privacy_mode',
    ]),
    browserApiCandidates: capabilityBoolean(features, endpoints, 'browserApiCandidates', [
      'browser_api_candidates',
    ]),
    browserContextApiRequest: capabilityBoolean(
      features,
      endpoints,
      'browserContextApiRequest',
      ['browser_context_api_request'],
    ),
    osMode: capabilityBoolean(features, endpoints, 'osMode', ['os_mode']),
    desktopAutomation: capabilityBoolean(features, endpoints, 'desktopAutomation', [
      'desktop_automation',
    ]),
    taskPlan: capabilityBoolean(features, endpoints, 'taskPlan', ['task_plan']),
    reasoningStream: typeof reasoningStream.available === 'boolean'
      ? reasoningStream.available
      : capabilityBoolean(features, endpoints, 'reasoningStream', ['reasoning_stream']),
    reasoningLevelSelection: capabilityBoolean(
      features,
      endpoints,
      'reasoningLevelSelection',
      ['reasoning_level_selection'],
    ),
    reasoningLevels: reasoningLevelValues(
      reasoningLevel.available ?? reasoningLevel.levels,
    ),
    defaultReasoningLevel: reasoningLevelValue(
      reasoningLevel.default,
      defaultBackendCapabilities.defaultReasoningLevel,
    ) ?? defaultBackendCapabilities.defaultReasoningLevel,
    terminalRuntimeSelection: capabilityBoolean(
      features,
      endpoints,
      'terminalRuntimeSelection',
      ['terminal_runtime_selection'],
    ),
    terminalRuntimes: terminalRuntimeValues(terminalRuntime.available),
    defaultTerminalRuntime: terminalRuntimeValue(
      terminalRuntime.default,
      defaultBackendCapabilities.defaultTerminalRuntime,
    ) ?? defaultBackendCapabilities.defaultTerminalRuntime,
  };
}

function interactiveRequestCapabilityAvailable(
  requestCapabilities: Record<string, unknown>,
  interactiveRequests: unknown,
) {
  return requestCapabilities.available === true && interactiveRequests != null;
}

function reasoningLevelValues(value: unknown): ReasoningLevel[] {
  if (!Array.isArray(value)) {
    return defaultBackendCapabilities.reasoningLevels;
  }
  const levels = value
    .map((item) => reasoningLevelValue(item))
    .filter((item): item is ReasoningLevel => item != null)
    .filter((item, index, all) => all.indexOf(item) === index);
  return levels.length > 0 ? levels : defaultBackendCapabilities.reasoningLevels;
}

function reasoningLevelValue(
  value: unknown,
  fallback?: ReasoningLevel,
): ReasoningLevel | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (
    normalized === 'low' ||
    normalized === 'medium' ||
    normalized === 'high' ||
    normalized === 'max'
  ) {
    return normalized;
  }
  return fallback;
}

function terminalRuntimeValues(value: unknown): TerminalRuntime[] {
  if (!Array.isArray(value)) {
    return defaultBackendCapabilities.terminalRuntimes;
  }
  const runtimes = value
    .map((item) => terminalRuntimeValue(item))
    .filter((item): item is TerminalRuntime => item != null)
    .filter((item, index, all) => all.indexOf(item) === index);
  return runtimes.length > 0
    ? runtimes
    : defaultBackendCapabilities.terminalRuntimes;
}

function terminalRuntimeValue(
  value: unknown,
  fallback?: TerminalRuntime,
): TerminalRuntime | undefined {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_');
  if (
    normalized === 'powershell' ||
    normalized === 'wsl' ||
    normalized === 'git_bash' ||
    normalized === 'bash'
  ) {
    return normalized;
  }
  return fallback;
}

function standardImageInputToolAvailable(
  features: Record<string, unknown>,
  endpoints: Record<string, unknown>,
  config: Record<string, unknown>,
) {
  if (
    capabilityBoolean(features, endpoints, 'standardImageInputTool', [
      'standard_image_input_tool',
    ])
  ) {
    return true;
  }
  return Object.keys(config).length > 0;
}

type BackendCapabilityBooleanKey = {
  [Key in keyof BackendCapabilities]: BackendCapabilities[Key] extends boolean
    ? Key
    : never;
}[keyof BackendCapabilities];

function capabilityBoolean(
  features: Record<string, unknown>,
  endpoints: Record<string, unknown>,
  key: BackendCapabilityBooleanKey,
  aliases: string[] = [],
) {
  const snakeKey = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
  for (const candidate of [key, snakeKey, ...aliases]) {
    const raw = features[candidate];
    if (typeof raw === 'boolean') {
      return raw;
    }
    const endpoint = asRecord(endpoints[candidate]);
    if (typeof endpoint.available === 'boolean') {
      return endpoint.available;
    }
  }
  return defaultBackendCapabilities[key];
}

function isInternalConversationPayload(item: unknown) {
  const value = asRecord(item);
  const id = String(
    typeof item === 'string'
      ? item
      : value.id ?? value.session_id ?? value.sessionId ?? '',
  ).trim();
  if (id.startsWith('subagent::')) {
    return true;
  }
  const metadata = asRecord(value.metadata);
  if (isBotConversationPayload(id, value, metadata)) {
    return false;
  }
  const kind = String(
    metadata.kind ??
      metadata.type ??
      metadata.session_kind ??
      metadata.sessionKind ??
      metadata.source ??
      '',
  )
    .trim()
    .toLowerCase();
  if (
    kind === 'subagent' ||
    kind === 'child_agent' ||
    kind === 'internal_subagent'
  ) {
    return true;
  }
  if (
    metadata.parent_session_id != null ||
    metadata.parentSessionId != null ||
    metadata.subagent_task_id != null ||
    metadata.subagentTaskId != null
  ) {
    return true;
  }
  const workspace = asRecord(value.workspace_context ?? value.workspaceContext);
  const executionRoot = String(
    workspace.execution_root ?? workspace.executionRoot ?? '',
  );
  const taskDir = String(workspace.task_dir ?? workspace.taskDir ?? '');
  return /[\\/]task[\\/]subagent_[^\\/]+/i.test(executionRoot) ||
    /[\\/]task[\\/]subagent_[^\\/]+/i.test(taskDir);
}

function isBotConversationPayload(
  id: string,
  value: Record<string, unknown>,
  metadata: Record<string, unknown>,
) {
  const platform = normalizeBotPlatform(
    value.platform ??
      value.bot_platform ??
      value.botPlatform ??
      metadata.platform ??
      metadata.bot_platform ??
      metadata.botPlatform ??
      metadata.source_platform ??
      metadata.sourcePlatform,
  );
  if (platform) {
    return true;
  }
  const source = String(
    metadata.source ??
      metadata.kind ??
      metadata.type ??
      metadata.session_kind ??
      metadata.sessionKind ??
      value.source ??
      '',
  )
    .trim()
    .toLowerCase();
  if (
    source === 'bot' ||
    source === 'bot_session' ||
    source === 'external_bot' ||
    source === 'weixin' ||
    source === 'feishu' ||
    source === 'telegram' ||
    source === 'discord'
  ) {
    return true;
  }
  const normalizedId = id.toLowerCase();
  return (
    normalizedId.includes('@im.bot') ||
    normalizedId.startsWith('weixin:') ||
    normalizedId.startsWith('feishu:') ||
    normalizedId.startsWith('telegram:') ||
    normalizedId.startsWith('discord:') ||
    normalizedId.includes('@im.wechat')
  );
}

function shareLinkFromPayload(item: unknown): SessionShareLinkResult {
  const value = asRecord(item);
  return {
    code: String(value.code ?? ''),
    sessionId: String(value.session_id ?? value.sessionId ?? ''),
    platform: String(value.platform ?? ''),
    expiresAt: String(value.expires_at ?? value.expiresAt ?? ''),
  };
}

function botOverviewFromPayload(item: unknown): BotPlatformOverview | null {
  const value = asRecord(item);
  const platform = normalizeBotPlatform(value.platform ?? value.id ?? value.name);
  if (!platform) {
    return null;
  }
  return {
    platform,
    enabled: Boolean(value.enabled ?? value.is_enabled ?? value.configured ?? false),
    configured: Boolean(value.configured ?? value.is_configured ?? false),
    serviceStatus: normalizeBotServiceStatus(
      value.service_status ??
        value.serviceStatus ??
        asRecord(value.service).status ??
        value.status,
    ),
    accountCount: optionalNumber(
      value.account_count ??
        value.accountCount ??
        (Array.isArray(value.accounts) ? value.accounts.length : undefined),
    ),
    displayName: optionalString(
      value.display_name ?? value.displayName ?? value.title ?? value.label,
    ),
    lastError: optionalString(value.last_error ?? value.lastError ?? value.error),
    missingRequiredFields: stringList(
      value.missing_required_fields ?? value.missingRequiredFields,
    ),
    raw: value,
  };
}

function botConfigFromPayload(
  platform: BotPlatform,
  payload: Record<string, unknown>,
): BotConfigResult {
  const value = asRecord(payload);
  return {
    platform: normalizeBotPlatform(value.platform) ?? platform,
    enabled: Boolean(value.enabled ?? value.is_enabled ?? false),
    configured: Boolean(value.configured ?? value.is_configured ?? false),
    config: asRecord(value.config ?? value.values ?? value),
    secrets: asRecord(value.secrets ?? value.secret_fields ?? value.secretFields),
    missingRequiredFields: stringList(
      value.missing_required_fields ?? value.missingRequiredFields,
    ),
    raw: value,
  };
}

function botStatusFromPayload(
  platform: BotPlatform,
  payload: Record<string, unknown>,
): BotStatusResult {
  const value = asRecord(payload);
  return {
    platform: normalizeBotPlatform(value.platform) ?? platform,
    enabled: Boolean(value.enabled ?? value.is_enabled ?? value.configured ?? false),
    configured: Boolean(value.configured ?? value.is_configured ?? false),
    serviceStatus: normalizeBotServiceStatus(
      value.service_status ??
        value.serviceStatus ??
        asRecord(value.service).status ??
        value.status,
    ),
    accountCount: optionalNumber(
      value.account_count ??
        value.accountCount ??
        (Array.isArray(value.accounts) ? value.accounts.length : undefined),
    ),
    pid: optionalNumber(value.pid),
    returnCode: optionalNumber(value.returncode ?? value.returnCode),
    startedAt: optionalString(value.started_at ?? value.startedAt),
    stoppedAt: optionalString(value.stopped_at ?? value.stoppedAt),
    logPath: optionalString(value.log_path ?? value.logPath),
    accounts: recordList(value.accounts),
    lastError: optionalString(value.last_error ?? value.lastError ?? value.error),
    missingRequiredFields: stringList(
      value.missing_required_fields ?? value.missingRequiredFields,
    ),
    raw: value,
  };
}

function weixinLoginStartFromPayload(
  payload: Record<string, unknown>,
): WeixinLoginStartResult {
  const value = asRecord(payload);
  const qrcodeSource =
    value.qrcode_url ??
    value.qrcodeUrl ??
    value.qr_url ??
    value.qrUrl ??
    value.qr_code_url ??
    value.qrCodeUrl ??
    value.qrcode_img_content ??
    value.qrcodeImgContent ??
    value.qrcode_image ??
    value.qrcodeImage ??
    value.qrcode ??
    value.qr_code ??
    value.qrCode;
  return {
    loginId: String(value.login_id ?? value.loginId ?? value.id ?? ''),
    qrcodeUrl: normalizeImageSource(qrcodeSource),
    expiresAt: optionalString(value.expires_at ?? value.expiresAt),
    raw: value,
  };
}

function weixinLoginStatusFromPayload(
  loginId: string,
  payload: Record<string, unknown>,
): WeixinLoginStatusResult {
  const value = asRecord(payload);
  return {
    loginId: String(value.login_id ?? value.loginId ?? loginId),
    status: normalizeWeixinLoginStatus(value.status),
    account: asOptionalRecord(value.account),
    message: optionalString(value.message ?? value.error ?? value.detail),
    raw: value,
  };
}

function botLogsFromPayload(
  platform: BotPlatform,
  payload: Record<string, unknown>,
): BotServiceLogsResult {
  const value = asRecord(payload);
  const lines = Array.isArray(value.lines)
    ? value.lines.map((item) => String(item))
    : String(value.text ?? value.logs ?? '')
        .split(/\r?\n/)
        .filter(Boolean);
  return {
    platform: normalizeBotPlatform(value.platform) ?? platform,
    lines,
    raw: value,
  };
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

function sceneRecordsFromPayload(
  payload: unknown,
  fallbackSessionId: string,
): SessionSceneRecord[] {
  const value = asRecord(payload);
  const candidates = Array.isArray(payload)
    ? payload
    : Array.isArray(value.items)
      ? value.items
      : Array.isArray(value.scenes)
        ? value.scenes
        : Array.isArray(value.data)
          ? value.data
          : [];
  return candidates
    .map((item) => sceneRecordFromPayload(item, fallbackSessionId))
    .filter((item): item is SessionSceneRecord => item != null);
}

function sceneRecordFromPayload(
  payload: unknown,
  fallbackSessionId: string,
): SessionSceneRecord | null {
  const value = asRecord(payload);
  const nested = asRecord(value.scene ?? value.item ?? value.data);
  const target = Object.keys(nested).length > 0 ? nested : value;
  const sceneId = String(
    target.scene_id ??
      target.sceneId ??
      value.scene_id ??
      value.sceneId ??
      '',
  );
  if (!sceneId.trim()) {
    return null;
  }
  return {
    sceneId,
    sessionId: optionalString(
      target.session_id ?? target.sessionId ?? value.session_id ?? value.sessionId,
    ) ?? fallbackSessionId,
    turnId: optionalString(
      target.turn_id ?? target.turnId ?? value.turn_id ?? value.turnId,
    ),
    createdAt: optionalString(
      target.created_at ?? target.createdAt ?? value.created_at ?? value.createdAt,
    ),
    updatedAt: optionalString(
      target.updated_at ?? target.updatedAt ?? value.updated_at ?? value.updatedAt,
    ),
    raw: value,
  };
}

function projectContextFromPayload(item: unknown): ProjectContextResult {
  const value = asRecord(item);
  return {
    projectDir: String(value.project_dir ?? value.projectDir ?? ''),
    userPrompt: String(value.user_prompt ?? value.userPrompt ?? ''),
  };
}

function workspaceContextFromPayload(item: unknown): WorkspaceContext | undefined {
  const value = asRecord(item);
  const mode = String(value.mode ?? '');
  if (mode !== 'task' && mode !== 'project') {
    return undefined;
  }
  return {
    mode,
    executionRoot: String(value.execution_root ?? value.executionRoot ?? ''),
    projectDir:
      value.project_dir == null && value.projectDir == null
        ? null
        : String(value.project_dir ?? value.projectDir),
    taskDir: String(value.task_dir ?? value.taskDir ?? ''),
    source: String(value.source ?? ''),
  };
}

function conversationProjectDirFromWorkspace(
  explicitProjectDir: string | undefined,
  workspaceContext: WorkspaceContext | undefined,
) {
  const explicit = explicitProjectDir?.trim();
  if (explicit) {
    return explicit;
  }
  if (workspaceContext?.mode === 'project') {
    return workspaceContext.projectDir?.trim() || undefined;
  }
  return undefined;
}

function pendingInteractionFromPayload(item: unknown): PendingInteraction | null {
  const value = asRecord(item);
  const nested = asRecord(value.interaction ?? value.pending ?? value.item);
  const target = Object.keys(nested).length > 0 ? nested : value;
  const id = String(
    target.id ??
      target.interaction_id ??
      target.interactionId ??
      target.request_id ??
      target.requestId ??
      '',
  ).trim();
  if (!id) {
    return null;
  }
  const questions = target.questions;
  const description = optionalString(target.description);
  const prompt = optionalString(target.message ?? target.prompt);
  return {
    id,
    type: optionalString(target.type),
    sessionId: optionalString(target.session_id ?? target.sessionId),
    turnId: optionalString(target.turn_id ?? target.turnId),
    title: optionalString(target.title),
    reason: optionalString(target.reason),
    message: prompt ?? description,
    description,
    submitLabel: optionalString(target.submit_label ?? target.submitLabel),
    cancelLabel: optionalString(target.cancel_label ?? target.cancelLabel),
    replyMode: optionalString(target.reply_mode ?? target.replyMode),
    toolName: optionalString(target.tool_name ?? target.toolName),
    permissionPreview: asOptionalRecord(
      target.permission_preview ?? target.permissionPreview,
    ),
    questions: Array.isArray(questions)
      ? questions.map(interactionQuestionFromPayload).filter((question) => question.id)
      : undefined,
    raw: target,
  };
}

function interactionFromConflictResponse(body: string) {
  const payload = parseJson(body);
  if (!payload) {
    return null;
  }
  const detail = asRecord(payload.detail);
  const candidate =
    detail.interactive_request ??
    detail.interactiveRequest ??
    payload.interactive_request ??
    payload.interactiveRequest;
  if (candidate == null) {
    return null;
  }
  const interaction = pendingInteractionFromPayload(candidate);
  if (!interaction) {
    return null;
  }
  return isPermissionInteractionPayload(interaction)
    ? permissionInteractionFromPayload(candidate) ?? interaction
    : interaction;
}

function interactionQuestionFromPayload(item: unknown): InteractionQuestion {
  const value = asRecord(item);
  const rawMode = String(value.selection_mode ?? value.selectionMode ?? '').toLowerCase();
  const selectionMode: InteractionQuestion['selectionMode'] =
    rawMode === 'multiple' || rawMode === 'multi'
      ? 'multiple'
      : rawMode === 'input'
        ? 'input'
        : 'single';
  return {
    id: String(value.id ?? value.key ?? value.name ?? ''),
    label: String(value.label ?? value.title ?? value.question ?? ''),
    question: String(value.question ?? value.prompt ?? value.label ?? ''),
    selectionMode,
    needInput:
      value.need_input === true ||
      value.needInput === true ||
      selectionMode === 'input',
    required: value.required !== false,
    options: Array.isArray(value.options)
      ? value.options.map(interactionOptionFromPayload).filter((option) => option.id)
      : [],
  };
}

function interactionOptionFromPayload(item: unknown): InteractionOption {
  const value = asRecord(item);
  const id = String(value.id ?? value.value ?? value.key ?? value.label ?? '');
  return {
    id,
    label: String(value.label ?? value.title ?? value.text ?? id),
    description: optionalString(value.description ?? value.hint ?? value.help),
  };
}

function messageFromPayload(item: unknown, index = 0): ChatMessage {
  const value = asRecord(item);
  const content = normalizeContent(value.content);
  const turnId = optionalString(value.turn_id ?? value.turnId);
  const role = normalizeRole(value.role);
  const sourceMetadata = asOptionalRecord(value.metadata);
  const completedAt = optionalString(
    value.cardbush_turn_completed_at ??
      value.cardbushTurnCompletedAt ??
      value.turn_completed_at ??
      value.turnCompletedAt ??
      value.completed_at ??
      value.completedAt ??
      value.done_at ??
      value.doneAt ??
      value.finished_at ??
      value.finishedAt,
  );
  const clientMessageId = optionalString(
    value.client_message_id ?? value.clientMessageId ?? sourceMetadata?.client_message_id,
  );
  const metadata = completedAt || clientMessageId
    ? {
        ...sourceMetadata,
        ...(completedAt
          ? {
              cardbush_turn_completed_at:
                sourceMetadata?.cardbush_turn_completed_at ?? completedAt,
            }
          : {}),
        ...(clientMessageId ? { client_message_id: clientMessageId } : {}),
      }
    : sourceMetadata;
  const conversationId = optionalString(
    value.conversation_id ?? value.session_id ?? value.conversationId ?? value.sessionId,
  );
  const id = String(
    value.id ??
      value.message_id ??
      value.messageId ??
      fallbackMessageId({
        role,
        content,
        turnId,
        createdAt: optionalString(value.created_at ?? value.createdAt),
        messageIndex: value.message_index ?? value.messageIndex ?? index,
      }),
  );
  return {
    id,
    messageId: optionalString(value.message_id ?? value.messageId),
    clientMessageId,
    role,
    content,
    conversationId,
    turnId,
    createdAt: optionalString(value.created_at ?? value.createdAt),
    status: optionalString(value.status ?? asRecord(value.metadata).status),
    loopIndex: optionalNumber(
      value.loop_index ?? value.loopIndex ?? asRecord(value.metadata).loop_index,
    ),
    turnSequence: optionalNumber(value.turn_sequence ?? value.turnSequence),
    messageIndex: optionalNumber(value.message_index ?? value.messageIndex ?? index),
    sequence: optionalNumber(value.sequence ?? asRecord(value.metadata).sequence),
    requestId: optionalString(
      value.request_id ?? value.requestId ?? asRecord(value.metadata).request_id,
    ),
    eventId: optionalString(
      value.event_id ?? value.eventId ?? asRecord(value.metadata).event_id,
    ),
    assistantMessageId: optionalString(
      value.assistant_message_id ??
        value.assistantMessageId ??
        asRecord(value.metadata).assistant_message_id ??
        asRecord(value.metadata).assistantMessageId,
    ),
    toolExecutions: toolExecutionsFromPayload(
      value.toolExecutions ?? value.tool_executions,
    ),
    taskPlan: taskPlanFromPayload(metadata?.active_task_plan, conversationId) ?? undefined,
    metadata,
  };
}

function permissionInteractionFromPayload(item: unknown): PendingInteraction | null {
  const interaction = pendingInteractionFromPayload(item);
  if (!interaction) {
    return null;
  }
  const raw = interaction.raw;
  const preview = interaction.permissionPreview ?? {};
  const permission = asRecord(
    raw.permission ?? raw.permission_request ?? raw.permissionRequest,
  );
  const mergedPreview = {
    ...preview,
    ...permission,
    path:
      permission.path ??
      preview.path ??
      raw.path ??
      raw.target,
    resource_kind:
      permission.resource_kind ??
      permission.resourceKind ??
      preview.resource_kind ??
      preview.resourceKind ??
      raw.resource_kind ??
      raw.resourceKind,
    access_kind:
      permission.access_kind ??
      permission.accessKind ??
      preview.access_kind ??
      preview.accessKind ??
      raw.access_kind ??
      raw.accessKind,
    reason: permission.reason ?? preview.reason ?? raw.reason,
    operation:
      permission.operation ??
      preview.operation ??
      raw.operation ??
      raw.planned_operation ??
      raw.plannedOperation,
  };
  return {
    ...interaction,
    type: 'path_permission_request',
    toolName: interaction.toolName || 'request_permission',
    permissionPreview: mergedPreview,
    questions: [normalizedPermissionQuestion(interaction.questions ?? [])],
  };
}

function isPermissionInteractionPayload(interaction: PendingInteraction) {
  const type = interaction.type?.trim().toLowerCase() ?? '';
  const toolName = interaction.toolName?.trim().toLowerCase() ?? '';
  return (
    type === 'path_permission_request' ||
    toolName === 'request_permission' ||
    interaction.permissionPreview != null
  );
}

function normalizedPermissionQuestion(questions: InteractionQuestion[]): InteractionQuestion {
  const source =
    questions.find((question) => question.id === 'permission') ??
    questions.find((question) =>
      question.options.some((option) => option.id === 'allow_once'),
    );
  const sourceOptions = new Map(
    (source?.options ?? []).map((option) => [option.id.toLowerCase(), option]),
  );
  return {
    id: 'permission',
    label: source?.label || 'Permission',
    question: source?.question || 'Allow this exact access request?',
    selectionMode: 'single',
    needInput: false,
    required: true,
    options: ['allow_once', 'allow_session', 'deny'].map((id) => ({
      id,
      label: sourceOptions.get(id)?.label || id,
      description: sourceOptions.get(id)?.description,
    })),
  };
}

function assistantRevisionFromPayload(payload: Record<string, unknown>): AssistantRevision {
  return {
    action: String(payload.action ?? ''),
    channel: optionalString(payload.channel),
    turnId: optionalString(payload.turn_id ?? payload.turnId),
    reason: optionalString(payload.reason),
    draftState: optionalString(payload.draft_state ?? payload.draftState),
    loopIndex: optionalNumber(payload.loop_index ?? payload.loopIndex),
    issue: optionalString(payload.issue),
    content: optionalString(payload.content),
    messageId: optionalString(payload.message_id ?? payload.messageId),
    assistantSegmentIndex: optionalNumber(
      payload.assistant_segment_index ?? payload.assistantSegmentIndex,
    ),
  };
}

function toolExecutionFromPayload(payload: Record<string, unknown>): ChatToolExecution {
  const metadata = asRecord(payload.metadata);
  const contentOffsetValue =
    payload.contentOffset ??
    payload.content_offset ??
    metadata.contentOffset ??
    metadata.content_offset;
  const id =
    nonEmpty(payload.id) ??
    nonEmpty(payload.tool_call_id) ??
    nonEmpty(metadata.tool_call_id) ??
    toolFingerprint(payload);
  const state = normalizeToolState(payload, metadata);
  return {
    id,
    name: toolName(payload.name),
    state,
    summary: toolSummary(payload),
    output: String(payload.output ?? ''),
    success: typeof payload.success === 'boolean' ? payload.success : state === 'completed',
    durationMs: numericValue(payload.duration_ms ?? payload.durationMs),
    createdAt:
      optionalString(payload.created_at ?? payload.createdAt) ?? new Date().toISOString(),
    contentOffset: integerValue(contentOffsetValue),
    contentOffsetExplicit: hasNumericValue(contentOffsetValue),
    sequence: optionalNumber(payload.sequence ?? metadata.sequence),
    loopIndex: optionalNumber(
      payload.loop_index ?? payload.loopIndex ?? metadata.loop_index ?? metadata.loopIndex,
    ),
    turnId: optionalString(
      payload.turn_id ?? payload.turnId ?? metadata.turn_id ?? metadata.turnId,
    ),
    messageId: optionalString(payload.message_id ?? payload.messageId),
    assistantMessageId: optionalString(
      payload.assistant_message_id ??
        payload.assistantMessageId ??
        payload.message_id ??
        payload.messageId ??
        metadata.assistant_message_id ??
        metadata.assistantMessageId,
    ),
    assistantSegmentIndex: optionalNumber(
      payload.assistant_segment_index ??
        payload.assistantSegmentIndex ??
        metadata.assistant_segment_index ??
        metadata.assistantSegmentIndex,
    ),
    metadata,
  };
}

function workspaceChangeToolPayload(payload: Record<string, unknown>) {
  const metadata = asRecord(payload.metadata);
  const files = arrayFrom(payload.files).map((value) => {
    const item = asRecord(value);
    return {
      path: String(item.path ?? ''),
      additions: numericValue(item.additions),
      deletions: numericValue(item.deletions),
      diff: String(item.diff ?? ''),
      status: String(item.status ?? ''),
    };
  });
  const status = String(payload.status ?? payload.state ?? 'running');
  const additions = numericValue(payload.additions) ||
    files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = numericValue(payload.deletions) ||
    files.reduce((sum, file) => sum + file.deletions, 0);
  const turnId = String(payload.turn_id ?? payload.turnId ?? '');
  const changeId = nonEmpty(payload.change_id ?? payload.changeId) ??
    `workspace-change:${turnId || 'current'}`;
  return {
    id: changeId,
    name: 'workspace_change',
    state: status,
    summary: String(
      payload.summary ?? `${files.length} files changed +${additions} -${deletions}`,
    ),
    output: '',
    success: payload.success === true || status === 'completed' || status === 'ok',
    created_at: payload.created_at ?? payload.createdAt ?? new Date().toISOString(),
    sequence: payload.sequence,
    metadata: {
      ...metadata,
      ...payload,
      kind: 'file_change',
      files,
      additions,
      deletions,
      turn_id: turnId,
      change_id: changeId,
    },
  };
}

function toolExecutionsFromPayload(value: unknown): ChatToolExecution[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(asRecord)
    .map((item) => {
      const metadata = asRecord(item.metadata);
      const contentOffsetValue =
        item.contentOffset ??
        item.content_offset ??
        metadata.contentOffset ??
        metadata.content_offset;
      const state = normalizeToolState(item, metadata);
      return {
        id:
          nonEmpty(item.id) ??
          nonEmpty(item.tool_call_id) ??
          nonEmpty(metadata.tool_call_id) ??
          toolFingerprint(item),
        name: toolName(item.name),
        state,
        summary: String(item.summary ?? ''),
        output: String(item.output ?? ''),
        success: typeof item.success === 'boolean' ? item.success : state === 'completed',
        durationMs: numericValue(item.durationMs ?? item.duration_ms),
        createdAt:
          optionalString(item.createdAt ?? item.created_at) ?? new Date().toISOString(),
        contentOffset: integerValue(contentOffsetValue),
        contentOffsetExplicit: hasNumericValue(contentOffsetValue),
        sequence: optionalNumber(item.sequence ?? metadata.sequence),
        loopIndex: optionalNumber(
          item.loopIndex ??
            item.loop_index ??
            metadata.loopIndex ??
            metadata.loop_index,
        ),
        assistantMessageId: optionalString(
          item.assistantMessageId ??
            item.assistant_message_id ??
            metadata.assistantMessageId ??
            metadata.assistant_message_id,
        ),
        metadata,
      };
    })
    .filter((item) => item.id.trim());
}

function skillDetailFromPayload(item: unknown): SkillDetail {
  const value = asRecord(item);
  return {
    name: String(value.name ?? ''),
    description: String(value.description ?? ''),
    descriptionZh: String(value.description_zh ?? ''),
    path: String(value.path ?? ''),
    packageDir: String(value.package_dir ?? ''),
    content: String(value.content ?? ''),
    version: optionalString(value.version),
    routingHidden: value.routing_hidden === true,
    requires: stringList(value.requires),
    conflictsWith: stringList(value.conflicts_with),
    minServerVersion: optionalString(value.min_server_version),
    timeout: numberRecord(value.timeout),
    companionTools: stringList(value.companion_tools),
    blockedTools: stringList(value.blocked_tools),
    requiredReads: stringList(value.required_reads),
    conditionalReads: stringList(value.conditional_reads),
    resourceQuickRefs: recordList(value.resource_quick_refs),
  };
}

function messagesFromPayload(payload: Record<string, unknown>) {
  const list = payload.messages;
  if (Array.isArray(list)) {
    const parsed = list.map(messageFromPayload).filter((item) => item.id.trim());
    if (parsed.length > 0) {
      return parsed;
    }
  }
  const assistantMessages = payload.assistant_messages ?? payload.assistantMessages;
  if (Array.isArray(assistantMessages)) {
    return assistantMessages
      .map((item, index) =>
        messageFromPayload(
          mergeMessageEnvelope(payload, item, {
            role: 'assistant',
            message_index: index,
          }),
          index,
        ),
      )
      .filter((item) => item.id.trim());
  }
  const message = payload.message;
  if (message != null) {
    const parsed = messageFromPayload(mergeMessageEnvelope(payload, message));
    return parsed.id.trim() ? [parsed] : [];
  }
  const assistantMessage = payload.assistant_message ?? payload.assistantMessage;
  if (assistantMessage != null) {
    const parsed = messageFromPayload(
      mergeMessageEnvelope(payload, assistantMessage, { role: 'assistant' }),
    );
    return parsed.id.trim() ? [parsed] : [];
  }
  const visibleOutput =
    payload.visible_output ??
    payload.visibleOutput ??
    asRecord(payload.resource_summary).assistant_message ??
    asRecord(payload.resource_summary).assistantMessage;
  if (visibleOutput != null) {
    const parsed = messageFromPayload(
      mergeMessageEnvelope(payload, visibleOutput, { role: 'assistant' }),
    );
    return parsed.id.trim() ? [parsed] : [];
  }
  if (payload.role != null && payload.content != null) {
    const parsed = messageFromPayload(payload);
    return parsed.id.trim() ? [parsed] : [];
  }
  return [];
}

function mergeMessageEnvelope(
  envelope: Record<string, unknown>,
  item: unknown,
  fallback: Record<string, unknown> = {},
) {
  const base = {
    session_id: envelope.session_id ?? envelope.sessionId,
    turn_id: envelope.turn_id ?? envelope.turnId,
    created_at: envelope.created_at ?? envelope.createdAt,
    ...fallback,
  };
  if (typeof item === 'string') {
    return {
      ...base,
      content: item,
    };
  }
  if (item && typeof item === 'object' && !Array.isArray(item)) {
    return {
      ...base,
      ...asRecord(item),
    };
  }
  return {
    ...base,
    content: item,
  };
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? '').trim()).filter(Boolean)
    : [];
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

function normalizeToolState(
  payload: Record<string, unknown>,
  metadata: Record<string, unknown>,
) {
  const rawState =
    nonEmpty(payload.state) ??
    nonEmpty(payload.status) ??
    nonEmpty(metadata.state) ??
    nonEmpty(metadata.status);
  const state = (rawState ?? '').toLowerCase();
  if (['ok', 'done', 'success', 'completed'].includes(state)) {
    return 'completed';
  }
  if (['pending', 'queued', 'waiting_confirmation'].includes(state)) {
    return 'queued';
  }
  if (['using', 'running', 'started'].includes(state)) {
    return 'running';
  }
  if (['fail', 'failed', 'error'].includes(state)) {
    return 'failed';
  }
  if (['cancelled', 'canceled', 'stopped'].includes(state)) {
    return 'cancelled';
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'success')) {
    return payload.success === true ? 'completed' : 'failed';
  }
  return state || 'queued';
}

function toolName(value: unknown) {
  let text = String(value ?? '').trim();
  if (!text) {
    return 'tool';
  }
  for (const separator of [':', '.', '/']) {
    if (text.includes(separator)) {
      text = text.split(separator).pop() ?? text;
    }
  }
  return text || 'tool';
}

function toolSummary(payload: Record<string, unknown>) {
  const summary = payload.arguments_summary;
  if (summary && typeof summary === 'object' && !Array.isArray(summary)) {
    const normalized = asRecord(summary);
    const parsed = normalized.parsed;
    return summarizeMap(
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? asRecord(parsed)
        : normalized,
    );
  }
  if (Array.isArray(summary)) {
    return summary.slice(0, 4).map(String).join(', ');
  }
  const text = String(summary ?? payload.summary ?? '').trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    try {
      const decoded = JSON.parse(text) as unknown;
      if (decoded && typeof decoded === 'object' && !Array.isArray(decoded)) {
        return summarizeMap(asRecord(decoded));
      }
      if (Array.isArray(decoded)) {
        return decoded.slice(0, 4).map(String).join(', ');
      }
    } catch {
      return ellipsize(text, 110);
    }
  }
  return ellipsize(text, 110);
}

function summarizeMap(value: Record<string, unknown>) {
  const preferredKeys = [
    'command',
    'cmd',
    'path',
    'file_path',
    'target_path',
    'url',
    'query',
    'pattern',
    'name',
    'action',
  ];
  const parts: string[] = [];
  for (const key of preferredKeys) {
    const text = summaryValue(value[key]);
    if (text) {
      parts.push(`${summaryLabel(key)}: ${text}`);
    }
    if (parts.length >= 2) {
      break;
    }
  }
  if (parts.length === 0) {
    for (const [key, item] of Object.entries(value).slice(0, 2)) {
      const text = summaryValue(item);
      if (text) {
        parts.push(`${summaryLabel(key)}: ${text}`);
      }
    }
  }
  return ellipsize(parts.join(' · '), 110);
}

function summaryValue(value: unknown) {
  if (value == null) {
    return '';
  }
  if (Array.isArray(value)) {
    return value.slice(0, 3).map(String).join(', ');
  }
  if (typeof value === 'object') {
    return ellipsize(JSON.stringify(value), 80);
  }
  return ellipsize(String(value), 80);
}

function summaryLabel(value: string) {
  return value.replace(/_/g, ' ');
}

function toolFingerprint(payload: Record<string, unknown>) {
  const seed = JSON.stringify({
    name: payload.name,
    state: payload.state,
    summary: payload.arguments_summary ?? payload.summary,
    output: payload.output,
  });
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(31, hash) + seed.charCodeAt(index);
    hash |= 0;
  }
  return `tool-${Math.abs(hash)}`;
}

function nonEmpty(value: unknown) {
  const text = value == null ? '' : String(value).trim();
  return text || undefined;
}

function numericValue(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function integerValue(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function ellipsize(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`;
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

function normalizeRole(value: unknown): ChatMessage['role'] {
  return value === 'user' ||
    value === 'assistant' ||
    value === 'system' ||
    value === 'guidance' ||
    value === 'tool'
    ? value
    : 'assistant';
}

function normalizeContent(value: unknown) {
  if (typeof value === 'string') {
    return value;
  }
  if (value == null) {
    return '';
  }
  if (Array.isArray(value)) {
    return value.map(contentPartToText).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    return contentPartToText(value);
  }
  return JSON.stringify(value);
}

function contentPartToText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value == null) {
    return '';
  }
  if (Array.isArray(value)) {
    return value.map(contentPartToText).filter(Boolean).join('\n');
  }
  if (typeof value !== 'object') {
    return String(value);
  }
  const item = asRecord(value);
  const text =
    item.text ??
    item.content ??
    item.value ??
    item.visible_text ??
    item.visibleText ??
    item.assistant_message ??
    item.assistantMessage;
  if (typeof text === 'string') {
    return text;
  }
  const imagePath =
    item.path ??
    item.file_path ??
    item.filePath ??
    asRecord(item.image).path ??
    asRecord(item.image_url).url ??
    asRecord(item.imageUrl).url ??
    item.url;
  if (imagePath != null) {
    return `@${String(imagePath)}`;
  }
  return JSON.stringify(item);
}

function fallbackMessageId({
  role,
  content,
  turnId,
  createdAt,
  messageIndex,
}: {
  role: ChatMessage['role'];
  content: string;
  turnId?: string;
  createdAt?: string;
  messageIndex: unknown;
}) {
  const index = Number.isFinite(Number(messageIndex)) ? Number(messageIndex) : 0;
  const seed = `${turnId ?? ''}|${role}|${createdAt ?? ''}|${index}|${content}`;
  return `message-${role}-${Math.abs(hashText(seed))}`;
}

function hashText(seed: string) {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = Math.imul(31, hash) + seed.charCodeAt(index);
    hash |= 0;
  }
  return hash;
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
    try {
      return backendUrlFor(text);
    } catch {
      return text;
    }
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

function optionalNumber(value: unknown) {
  if (value == null || value === '') {
    return undefined;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

function hasNumericValue(value: unknown) {
  if (value == null || value === '') {
    return false;
  }
  return Number.isFinite(Number(value));
}

function normalizeSubagentValidationStatus(value: unknown): SubagentValidationStatus {
  const text = String(value ?? '').trim().toLowerCase();
  if (text === 'invalid' || text === 'disabled') {
    return text;
  }
  return 'valid';
}

function subagentListItemFromPayload(value: unknown): SubagentListItem {
  const item = asRecord(value);
  return {
    id: String(item.id ?? item.name ?? ''),
    name: String(item.name ?? item.id ?? ''),
    displayName: String(item.display_name ?? item.displayName ?? item.name ?? item.id ?? ''),
    description: String(item.description ?? ''),
    enabled: item.enabled !== false,
    tags: stringList(item.tags),
    source: String(item.source ?? 'runtime'),
    registryPath: String(item.registry_path ?? item.registryPath ?? ''),
    version: optionalString(item.version),
    lastLoadedAt: optionalString(item.last_loaded_at ?? item.lastLoadedAt),
    validationStatus: normalizeSubagentValidationStatus(
      item.validation_status ?? item.validationStatus,
    ),
    error: optionalString(item.error),
  };
}

function subagentCapabilitiesFromPayload(value: unknown): SubagentCapabilities {
  const item = asRecord(value);
  const models = Array.isArray(item.models) ? item.models.map(asRecord) : [];
  const skills = Array.isArray(item.skills) ? item.skills.map(asRecord) : [];
  return {
    models,
    tools: stringList(item.tools),
    toolPackages: stringList(item.tool_packages ?? item.toolPackages),
    skills,
    permissionLevels: stringList(item.permission_levels ?? item.permissionLevels),
    runModes: stringList(item.run_modes ?? item.runModes),
    toolProfiles: stringList(item.tool_profiles ?? item.toolProfiles),
  };
}

function subagentSupervisorFromPayload(
  value: unknown,
): SubagentSupervisorSnapshot | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const item = asRecord(value);
  const limits = asRecord(item.limits);
  const counts = asRecord(item.counts);
  return {
    enabled: item.enabled !== false,
    limits: {
      maxActiveTotal: optionalNumber(
        limits.max_active_total ?? limits.maxActiveTotal,
      ),
      maxActivePerSession: optionalNumber(
        limits.max_active_per_session ?? limits.maxActivePerSession,
      ),
      maxActivePerAgent: optionalNumber(
        limits.max_active_per_agent ?? limits.maxActivePerAgent,
      ),
      maxDepth: optionalNumber(limits.max_depth ?? limits.maxDepth),
      taskTtlSeconds: optionalNumber(
        limits.task_ttl_seconds ?? limits.taskTtlSeconds,
      ),
    },
    counts: {
      totalActive: optionalNumber(counts.total_active ?? counts.totalActive),
      sessionActive:
        numberRecord(counts.session_active ?? counts.sessionActive) ?? {},
      agentActive: numberRecord(counts.agent_active ?? counts.agentActive) ?? {},
    },
    queueMode: optionalString(item.queue_mode ?? item.queueMode),
    rejectStrategy: optionalString(item.reject_strategy ?? item.rejectStrategy),
    depth: optionalNumber(item.depth),
    blockedTools: stringList(item.blocked_tools ?? item.blockedTools),
  };
}

function subagentDispatchResultFromPayload(
  value: unknown,
): SubagentDispatchResult {
  const item = asRecord(value);
  return {
    accepted: item.accepted === true,
    status: String(item.status ?? ''),
    taskId: optionalString(item.task_id ?? item.taskId),
    childSessionId: optionalString(item.child_session_id ?? item.childSessionId),
    agentName: String(item.agent_name ?? item.agentName ?? ''),
    runtimeProfile: optionalString(item.runtime_profile ?? item.runtimeProfile),
    resolvedRuntimeProfile: optionalString(
      item.resolved_runtime_profile ?? item.resolvedRuntimeProfile,
    ),
    resolvedHookSet: optionalString(item.resolved_hook_set ?? item.resolvedHookSet),
    lane: optionalString(item.lane),
    planNodeId: optionalString(item.plan_node_id ?? item.planNodeId),
    writeScope: stringList(item.write_scope ?? item.writeScope),
    writeLease: subagentWriteLeaseFromPayload(item.write_lease ?? item.writeLease),
    parentTurnId: optionalString(item.parent_turn_id ?? item.parentTurnId),
    message: optionalString(item.message),
    reason: optionalString(item.reason),
    supervisor: subagentSupervisorFromPayload(item.supervisor),
    raw: item,
  };
}

function subagentWriteLeaseFromPayload(
  value: unknown,
): SubagentWriteLeaseResult | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }
  const item = asRecord(value);
  return {
    status: optionalString(item.status),
    policy: optionalString(item.policy),
    scope: stringList(item.scope),
    conflicts: Array.isArray(item.conflicts)
      ? item.conflicts.map(asRecord)
      : [],
    reason: optionalString(item.reason),
    raw: item,
  };
}

function normalizeBotPlatform(value: unknown): BotPlatform | null {
  const text = String(value ?? '').trim().toLowerCase();
  if (
    text === 'weixin' ||
    text === 'feishu' ||
    text === 'telegram' ||
    text === 'discord'
  ) {
    return text;
  }
  return null;
}

function normalizeBotServiceStatus(value: unknown): BotServiceStatus {
  const text = String(value ?? '').trim().toLowerCase();
  if (
    text === 'starting' ||
    text === 'running' ||
    text === 'stopping' ||
    text === 'failed'
  ) {
    return text;
  }
  return 'stopped';
}

function normalizeWeixinLoginStatus(value: unknown): WeixinLoginStatus {
  const text = String(value ?? '').trim().toLowerCase();
  if (
    text === 'scanned' ||
    text === 'scaned' ||
    text === 'scaned_but_redirect'
  ) {
    return 'scanned';
  }
  if (
    text === 'confirmed' ||
    text === 'expired' ||
    text === 'failed' ||
    text === 'waiting'
  ) {
    return text;
  }
  return 'waiting';
}

function asRecord(value: unknown) {
  return value != null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function parseJson(value: string) {
  try {
    const decoded = JSON.parse(value);
    return asRecord(decoded);
  } catch {
    return null;
  }
}

function formatHttpError(statusCode: number, body: string) {
  const detail = extractErrorDetail(body);
  const structured = structuredErrorDetail(body);
  const diagnostic = [structured?.code, structured?.requestId]
    .filter(Boolean)
    .join(' · ');
  const withDiagnostic = (message: string) =>
    diagnostic ? `${message} (${diagnostic})` : message;
  if (statusCode === 403) {
    return withDiagnostic(`BushServer 拒绝访问${detail ? `: ${detail}` : ''}。请检查本地 secret 文件或 BUSH_API_AUTH_TOKEN 是否与 BushServer 启动配置一致。`);
  }
  const serviceError = normalizedServiceError(detail, statusCode);
  if (serviceError) {
    return withDiagnostic(serviceError);
  }
  const message = detail
    ? `BushServer error ${statusCode}: ${detail}`
    : `BushServer error: ${statusCode}`;
  return withDiagnostic(message);
}

function structuredErrorDetail(body: string) {
  try {
    const decoded = JSON.parse(body) as Record<string, unknown>;
    const detail = asRecord(decoded.detail);
    if (Object.keys(detail).length === 0) {
      return undefined;
    }
    return {
      code: optionalString(detail.code),
      requestId: optionalString(detail.request_id ?? detail.requestId),
      details: detail.details,
    };
  } catch {
    return undefined;
  }
}

function streamErrorMessage(decoded: Record<string, unknown>) {
  const structured = asRecord(decoded.detail);
  const detail =
    errorDetailText(decoded.message) ||
    errorDetailText(decoded.detail) ||
    errorDetailText(decoded.error) ||
    'BushServer stream error';
  const message = normalizedServiceError(detail) || detail;
  const diagnostic = [
    optionalString(structured.code ?? decoded.code),
    optionalString(
      structured.request_id ??
        structured.requestId ??
        decoded.request_id ??
        decoded.requestId,
    ),
  ]
    .filter(Boolean)
    .join(' · ');
  return diagnostic ? `${message} (${diagnostic})` : message;
}

function normalizedServiceError(detail: string, statusCode?: number) {
  const text = detail.trim();
  const isUpstreamModelError =
    /InternalServiceError|Service has some internal Error|litellm\.|DeepseekException|OpenAIException/i.test(
      text,
    );
  const isInternalServerError =
    statusCode === 500 || /InternalServerError|Error code:\s*500/i.test(text);
  if (!isInternalServerError && !isUpstreamModelError) {
    return '';
  }
  const requestId = text.match(/Request\s*id\s*:\s*([\w-]+)/i)?.[1] ?? '';
  const serviceName = isUpstreamModelError ? '上游模型服务' : 'BushServer';
  return `${serviceName}暂时不可用（500），请稍后重试${requestId ? `。请求 ID：${requestId}` : ''}`;
}

function extractErrorDetail(body: string) {
  const text = body.trim();
  if (!text) {
    return '';
  }
  try {
    const decoded = JSON.parse(text) as Record<string, unknown>;
    return (
      errorDetailText(decoded.detail) ||
      errorDetailText(decoded.message) ||
      errorDetailText(decoded.error) ||
      text
    );
  } catch {
    return text;
  }
}

function errorDetailText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        const record = asRecord(item);
        const location = Array.isArray(record.loc)
          ? record.loc.map((part) => String(part)).join('.')
          : '';
        const message = String(record.msg ?? record.message ?? '');
        return [location, message].filter(Boolean).join(': ');
      })
      .filter(Boolean)
      .join('; ');
  }
  if (value && typeof value === 'object') {
    const record = asRecord(value);
    return (
      errorDetailText(record.message) ||
      errorDetailText(record.detail) ||
      errorDetailText(record.error) ||
      JSON.stringify(record)
    );
  }
  return '';
}
