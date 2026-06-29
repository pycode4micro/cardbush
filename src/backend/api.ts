import type {
  AssistantRevision,
  AgentConfigPackageItem,
  AgentConfigPackagesResult,
  AgentConfigPackageValidationMessage,
  AgentConfigPackageValidationResult,
  AgentTransactionContractsResult,
  AgentTransactionContractSummary,
  BackendCapabilities,
  ChatMessage,
  ChatToolExecution,
  ConversationSummary,
  ManagedModelConfig,
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
  RuntimeProfileSummary,
  SubagentCapabilities,
  SubagentDetail,
  SubagentListItem,
  SubagentRuntimeResult,
  SubagentSupervisorSnapshot,
  SubagentTemplate,
  SubagentUsageResult,
  SubagentValidationResult,
  SubagentValidationStatus,
  StreamStart,
  WorkspaceContext,
  InteractionReplyAnswer,
  InteractionQuestion,
  InteractionOption,
  PermissionMode,
  ProfileTransactionContractBinding,
  ReferencePlanMode,
} from '../types';
import {
  applyDisabledToolsToMetadata,
  standardImageInputToolDefaultName,
} from './toolVisibility';
import { applyAllowedResourcePathsToMetadata } from './localPathMetadata';

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

export interface ChatStreamRequest {
  sessionId: string;
  userInput: string;
  model: string;
  modelConfig?: ManagedModelConfig;
  agentProfile?: string;
  projectDir?: string;
  projectUserPrompt?: string;
  allowedSkills?: string[];
  referencePlanMode?: ReferencePlanMode;
  permissionMode?: PermissionMode;
  standardImageInputEnabled?: boolean;
  images?: Array<{ path: string }>;
  files?: string[];
  disabledTools?: string[];
  signal?: AbortSignal;
  onStart?: (start: StreamStart) => void;
  onDelta?: (delta: string) => void;
  onAssistantRevision?: (revision: AssistantRevision) => void;
  onToolExecution?: (execution: ChatToolExecution) => void;
  onInteractiveRequest?: (interaction: PendingInteraction) => void;
  onFinalAssistantText?: (text: string) => void;
  onMessages?: (messages: ChatMessage[], finalSnapshot: boolean) => void;
}

export interface ControlStreamRequest {
  sessionId: string;
  model: string;
  modelConfig?: ManagedModelConfig;
  agentProfile?: string;
  projectDir?: string;
  projectUserPrompt?: string;
  allowedSkills?: string[];
  referencePlanMode?: ReferencePlanMode;
  permissionMode?: PermissionMode;
  standardImageInputEnabled?: boolean;
  images?: Array<{ path: string }>;
  files?: string[];
  disabledTools?: string[];
  signal?: AbortSignal;
  onStart?: (start: StreamStart) => void;
  onDelta?: (delta: string) => void;
  onAssistantRevision?: (revision: AssistantRevision) => void;
  onToolExecution?: (execution: ChatToolExecution) => void;
  onInteractiveRequest?: (interaction: PendingInteraction) => void;
  onFinalAssistantText?: (text: string) => void;
  onMessages?: (messages: ChatMessage[], finalSnapshot: boolean) => void;
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
  mode: 'append_context' | 'interrupt_and_continue';
  signal?: AbortSignal;
  onStart?: (start: StreamStart) => void;
  onDelta?: (delta: string) => void;
  onAssistantRevision?: (revision: AssistantRevision) => void;
  onToolExecution?: (execution: ChatToolExecution) => void;
  onInteractiveRequest?: (interaction: PendingInteraction) => void;
  onFinalAssistantText?: (text: string) => void;
  onMessages?: (messages: ChatMessage[], finalSnapshot: boolean) => void;
}

export const defaultBackendCapabilities: BackendCapabilities = {
  chatStream: true,
  sessions: true,
  skills: true,
  interactions: true,
  turnStop: true,
  runtimeInspection: true,
  maintenanceConversationHistoryClear: false,
  maintenanceLogsCacheClear: false,
  botControl: false,
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
  localMusicLibrary: false,
  agentConfigPackages: false,
  agentConfigPackageTransactionContracts: false,
};

export type AgentConfigPackageInput =
  | { yaml: string; rawConfig?: never; sourcePath?: never; replace?: boolean }
  | { yaml?: never; rawConfig: Record<string, unknown>; sourcePath?: never; replace?: boolean }
  | { yaml?: never; rawConfig?: never; sourcePath: string; replace?: boolean };

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
    throw new Error(formatHttpError(response.status, body));
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
        api_key: item.apiKey,
        base_url: item.baseUrl,
        max_context_tokens: item.maxContextTokens,
      })),
    }),
  });
  return modelConfigsFromPayload(payload);
}

export async function fetchAgentConfigPackages(): Promise<AgentConfigPackagesResult> {
  const payload = await readJson<unknown>(url('/v1/agent-config-packages'));
  return agentConfigPackagesFromPayload(payload);
}

export async function fetchAgentConfigPackageTransactionContracts(): Promise<AgentTransactionContractsResult> {
  const payload = await readJson<unknown>(
    url('/v1/agent-config-packages/transaction-contracts'),
  );
  return agentTransactionContractsFromPayload(payload);
}

export async function validateAgentConfigPackage(
  input: AgentConfigPackageInput,
): Promise<AgentConfigPackageValidationResult> {
  const payload = await readJson<unknown>(url('/v1/agent-config-packages/validate'), {
    method: 'POST',
    body: JSON.stringify(agentConfigPackageRequestBody(input)),
  });
  return agentConfigPackageValidationFromPayload(payload);
}

export async function installAgentConfigPackage(
  input: AgentConfigPackageInput,
): Promise<AgentConfigPackageItem> {
  const payload = await readJson<unknown>(url('/v1/agent-config-packages/install'), {
    method: 'POST',
    body: JSON.stringify(agentConfigPackageRequestBody(input)),
  });
  return agentConfigPackageFromPayload(payload, 0);
}

export async function setAgentConfigPackageEnabled(
  packageId: string,
  enabled: boolean,
): Promise<AgentConfigPackageItem> {
  const normalized = packageId.trim();
  if (!normalized) {
    throw new Error('Agent config package id 为空');
  }
  const payload = await readJson<unknown>(
    url(
      `/v1/agent-config-packages/${encodeURIComponent(normalized)}/${enabled ? 'enable' : 'disable'}`,
    ),
    { method: 'POST' },
  );
  return agentConfigPackageFromPayload(payload, 0);
}

export async function deleteAgentConfigPackage(
  packageId: string,
): Promise<Record<string, unknown>> {
  const normalized = packageId.trim();
  if (!normalized) {
    throw new Error('Agent config package id 为空');
  }
  return readJson<Record<string, unknown>>(
    url(`/v1/agent-config-packages/${encodeURIComponent(normalized)}`),
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
    modelName,
    baseUrl: String(item.baseUrl ?? item.base_url ?? item.llm_base_url ?? ''),
    ...(maxContextTokens ? { maxContextTokens } : {}),
  };
}

function agentConfigPackageRequestBody(input: AgentConfigPackageInput) {
  const body: Record<string, unknown> = {};
  if ('yaml' in input && input.yaml != null) {
    body.yaml = input.yaml;
  }
  if ('rawConfig' in input && input.rawConfig != null) {
    body.raw_config = input.rawConfig;
  }
  if ('sourcePath' in input && input.sourcePath != null) {
    body.source_path = input.sourcePath;
  }
  if (input.replace != null) {
    body.replace = input.replace;
  }
  return body;
}

function agentConfigPackagesFromPayload(payload: unknown): AgentConfigPackagesResult {
  const root = asRecord(payload);
  const rawSchema = asRecord(root.schema);
  const packages = Array.isArray(root.packages)
    ? root.packages
    : Array.isArray(root.items)
      ? root.items
      : [];
  return {
    packageSchemaVersion: String(
      root.package_schema_version ?? root.packageSchemaVersion ?? '',
    ),
    schema: {
      configNames: stringList(rawSchema.config_names ?? rawSchema.configNames),
      profilePolicySections: stringList(
        rawSchema.profile_policy_sections ?? rawSchema.profilePolicySections,
      ),
      raw: rawSchema,
    },
    packages: packages.map(agentConfigPackageFromPayload),
    raw: root,
  };
}

function agentConfigPackageFromPayload(
  payload: unknown,
  index = 0,
): AgentConfigPackageItem {
  const root = asRecord(payload);
  const item = asRecord(
    root.package ??
      root.item ??
      root.agent_config_package ??
      root.agentConfigPackage ??
      payload,
  );
  const frontendMetadata = asOptionalRecord(
    item.frontend_metadata ?? item.frontendMetadata,
  );
  const id = String(item.id ?? item.package_id ?? item.packageId ?? `package-${index}`).trim();
  const rawProfiles = Array.isArray(item.profiles)
    ? item.profiles
    : Array.isArray(item.runtime_profiles)
      ? item.runtime_profiles
      : Array.isArray(item.runtimeProfiles)
        ? item.runtimeProfiles
        : [];
  const profileIds = rawProfiles
    .map((profile) =>
      typeof profile === 'string'
        ? profile
        : String(
            asRecord(profile).id ??
              asRecord(profile).name ??
              asRecord(profile).profile ??
              '',
          ),
    )
    .map((profileId) => profileId.trim())
    .filter(Boolean);
  const transactionContracts = rawProfiles
    .map(transactionContractBindingFromProfile)
    .filter((binding): binding is ProfileTransactionContractBinding => binding != null);
  return {
    id,
    label: String(
      item.label ??
        item.display_name ??
        item.displayName ??
        frontendMetadata?.label ??
        frontendMetadata?.display_name ??
        frontendMetadata?.displayName ??
        id,
    ),
    description: String(
      item.description ??
        item.summary ??
        frontendMetadata?.description ??
        frontendMetadata?.summary ??
        '',
    ),
    enabled: Boolean(item.enabled ?? true),
    sourcePath: optionalString(item.source_path ?? item.sourcePath),
    profileIds,
    transactionContracts,
    frontendMetadata,
    raw: item,
  };
}

function transactionContractBindingFromProfile(
  payload: unknown,
): ProfileTransactionContractBinding | null {
  if (typeof payload === 'string') {
    return null;
  }
  const profile = asRecord(payload);
  const rawContract = profile.transaction_contract ?? profile.transactionContract;
  if (rawContract == null) {
    return null;
  }
  const profileId = String(
    profile.id ?? profile.name ?? profile.profile ?? profile.profile_id ?? profile.profileId ?? '',
  ).trim();
  const contract =
    typeof rawContract === 'string' ? { id: rawContract } : asRecord(rawContract);
  const contractId = transactionContractId(contract);
  if (!contractId) {
    return null;
  }
  return {
    profileId: profileId || '-',
    contractId,
    label: String(
      contract.label ??
        contract.display_name ??
        contract.displayName ??
        contract.title ??
        contractId,
    ),
    raw: contract,
  };
}

function transactionContractId(value: Record<string, unknown>) {
  return String(
    value.id ??
      value.name ??
      value.type ??
      value.kind ??
      value.contract ??
      value.contract_id ??
      value.contractId ??
      value.protocol ??
      '',
  ).trim();
}

function agentTransactionContractsFromPayload(
  payload: unknown,
): AgentTransactionContractsResult {
  const root = asRecord(payload);
  const manifest = asRecord(root.manifest);
  const rawContracts =
    arrayOrRecordValues(root.transaction_contracts ?? root.transactionContracts) ??
    arrayOrRecordValues(root.contracts) ??
    arrayOrRecordValues(root.items) ??
    arrayOrRecordValues(manifest.transaction_contracts ?? manifest.transactionContracts) ??
    arrayOrRecordValues(manifest.contracts) ??
    [];
  const protocol = String(
    root.protocol ??
      root.transaction_contract_protocol ??
      root.transactionContractProtocol ??
      root.profile_transaction_contract_protocol ??
      root.profileTransactionContractProtocol ??
      manifest.protocol ??
      '',
  );
  return {
    protocol,
    contracts: rawContracts
      .map(agentTransactionContractFromPayload)
      .filter((item): item is AgentTransactionContractSummary => item != null),
    raw: root,
  };
}

function agentTransactionContractFromPayload(
  payload: unknown,
): AgentTransactionContractSummary | null {
  const item =
    typeof payload === 'string'
      ? { id: payload }
      : asRecord(payload);
  const id = transactionContractId(item);
  if (!id) {
    return null;
  }
  return {
    id,
    label: String(
      item.label ?? item.display_name ?? item.displayName ?? item.title ?? id,
    ),
    description: String(item.description ?? item.summary ?? ''),
    protocol: optionalString(item.protocol),
    raw: item,
  };
}

function arrayOrRecordValues(value: unknown): unknown[] | null {
  if (Array.isArray(value)) {
    return value;
  }
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).map(([key, item]) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        return { id: key, ...asRecord(item) };
      }
      return { id: key, value: item };
    });
  }
  return null;
}

function agentConfigPackageValidationFromPayload(
  payload: unknown,
): AgentConfigPackageValidationResult {
  const root = asRecord(payload);
  const messages = [
    ...validationMessagesFromPayload(root.errors, 'error'),
    ...validationMessagesFromPayload(root.warnings, 'warning'),
    ...validationMessagesFromPayload(root.messages, 'info'),
  ];
  const ok = typeof root.ok === 'boolean'
    ? root.ok
    : typeof root.valid === 'boolean'
      ? root.valid
      : !messages.some((item) => item.severity === 'error');
  return {
    ok,
    packageId: optionalString(root.package_id ?? root.packageId ?? root.id),
    messages,
    raw: root,
  };
}

function validationMessagesFromPayload(
  payload: unknown,
  fallbackSeverity: AgentConfigPackageValidationMessage['severity'],
): AgentConfigPackageValidationMessage[] {
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

export async function fetchRuntimeProfiles(): Promise<RuntimeProfileSummary[]> {
  const payload = await readJson<unknown>(url('/v1/runtime-profiles'));
  return runtimeProfilesFromPayload(payload);
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
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
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
    messages: messages.map(messageFromPayload).filter((item) => item.id.trim()),
    workspaceContext,
  };
}

export async function createConversation({
  title = '新会话',
  projectDir,
  sessionId,
  metadata,
  agentProfile,
}: {
  title?: string;
  projectDir?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
  agentProfile?: string;
} = {}): Promise<ConversationSummary> {
  const endpoint = url('/v1/sessions');
  const payload = await readJson<Record<string, unknown>>(endpoint, {
    method: 'POST',
    body: JSON.stringify({
      title,
      ...(sessionId?.trim() ? { session_id: sessionId.trim() } : {}),
      ...(projectDir?.trim() ? { project_dir: projectDir.trim() } : {}),
      ...(agentProfile?.trim() ? { agent_profile: agentProfile.trim() } : {}),
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
  agentProfile,
}: {
  sessionId: string;
  title?: string;
  projectDir?: string | null;
  metadata?: Record<string, unknown>;
  agentProfile?: string;
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
        ...(agentProfile?.trim() ? { agent_profile: agentProfile.trim() } : {}),
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

export async function fetchSubagents(): Promise<SubagentListItem[]> {
  const payload = await readJson<{ subagents?: unknown[]; items?: unknown[] }>(
    url('/v1/subagents'),
  );
  const items = Array.isArray(payload.subagents) ? payload.subagents : payload.items;
  return Array.isArray(items) ? items.map(subagentListItemFromPayload) : [];
}

export async function fetchSubagentDetail(agentId: string): Promise<SubagentDetail> {
  const normalized = agentId.trim();
  if (!normalized) {
    throw new Error('Subagent id 为空');
  }
  const payload = await readJson<Record<string, unknown>>(
    url(`/v1/subagents/${encodeURIComponent(normalized)}`),
  );
  return subagentDetailFromPayload(payload);
}

export async function registerSubagent(input: {
  sourcePath?: string;
  rawConfig?: Record<string, unknown>;
  replace?: boolean;
}): Promise<SubagentDetail> {
  const payload = await readJson<Record<string, unknown>>(
    url('/v1/subagents/register'),
    {
      method: 'POST',
      body: JSON.stringify({
        ...(input.sourcePath?.trim() ? { source_path: input.sourcePath.trim() } : {}),
        ...(input.rawConfig ? { raw_config: input.rawConfig } : {}),
        replace: Boolean(input.replace),
      }),
    },
  );
  return subagentDetailFromPayload(payload);
}

export async function patchSubagent(
  agentId: string,
  updates: Record<string, unknown>,
): Promise<SubagentDetail> {
  const normalized = agentId.trim();
  if (!normalized) {
    throw new Error('Subagent id 为空');
  }
  const payload = await readJson<Record<string, unknown>>(
    url(`/v1/subagents/${encodeURIComponent(normalized)}`),
    {
      method: 'PATCH',
      body: JSON.stringify(updates),
    },
  );
  return subagentDetailFromPayload(payload);
}

export async function setSubagentEnabled(
  agentId: string,
  enabled: boolean,
): Promise<SubagentDetail> {
  const normalized = agentId.trim();
  if (!normalized) {
    throw new Error('Subagent id 为空');
  }
  const payload = await readJson<Record<string, unknown>>(
    url(
      `/v1/subagents/${encodeURIComponent(normalized)}/${enabled ? 'enable' : 'disable'}`,
    ),
    { method: 'POST' },
  );
  return subagentDetailFromPayload(payload);
}

export async function deleteSubagent(agentId: string): Promise<Record<string, unknown>> {
  const normalized = agentId.trim();
  if (!normalized) {
    throw new Error('Subagent id 为空');
  }
  return readJson<Record<string, unknown>>(
    url(`/v1/subagents/${encodeURIComponent(normalized)}`),
    { method: 'DELETE' },
  );
}

export async function reloadSubagents(): Promise<{
  subagents: SubagentListItem[];
  raw: Record<string, unknown>;
}> {
  const payload = await readJson<Record<string, unknown>>(
    url('/v1/subagents/reload'),
    { method: 'POST' },
  );
  const items = Array.isArray(payload.subagents) ? payload.subagents : [];
  return {
    subagents: items.map(subagentListItemFromPayload),
    raw: payload,
  };
}

export async function validateSubagent(
  rawConfig: Record<string, unknown>,
): Promise<SubagentValidationResult> {
  const payload = await readJson<Record<string, unknown>>(
    url('/v1/subagents/validate'),
    {
      method: 'POST',
      body: JSON.stringify({ raw_config: rawConfig }),
    },
  );
  return subagentValidationFromPayload(payload);
}

export async function fetchSubagentTemplates(): Promise<SubagentTemplate[]> {
  const payload = await readJson<Record<string, unknown>>(
    url('/v1/subagents/templates'),
  );
  const items = Array.isArray(payload.templates) ? payload.templates : [];
  return items.map((item) => {
    const value = asRecord(item);
    return {
      id: String(value.id ?? value.name ?? ''),
      name: String(value.name ?? value.id ?? ''),
      description: String(value.description ?? ''),
      rawConfig: asRecord(value.raw_config ?? value.rawConfig),
    };
  });
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

export async function fetchSubagentUsage(agentId: string): Promise<SubagentUsageResult> {
  const normalized = agentId.trim();
  if (!normalized) {
    throw new Error('Subagent id 为空');
  }
  const payload = await readJson<Record<string, unknown>>(
    url(`/v1/subagents/${encodeURIComponent(normalized)}/usage`),
  );
  return subagentUsageFromPayload(payload);
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
  return pendingInteractionFromPayload(payload);
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
    return;
  }
  await streamEndpoint({
    endpoint: url(`/v1/turns/${encodeURIComponent(turnId)}/guidance`),
    method: 'POST',
    body: {
      session_id: sessionId,
      guidance,
      mode: request.mode,
      stream: true,
    },
    request,
  });
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
    | 'signal'
    | 'onStart'
    | 'onDelta'
    | 'onAssistantRevision'
    | 'onToolExecution'
    | 'onInteractiveRequest'
    | 'onFinalAssistantText'
    | 'onMessages'
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
    throw new Error(formatHttpError(response.status, await response.text()));
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = 'message';
  let dataLines: string[] = [];
  let emittedAny = false;

  const flush = () => {
    if (dataLines.length === 0) {
      eventName = 'message';
      return;
    }
    const rawData = dataLines.join('\n');
    dataLines = [];
    const currentEvent = eventName;
    eventName = 'message';
    const effect = handleStreamEvent(currentEvent, rawData, emittedAny, request);
    if (effect?.clearEmitted) {
      emittedAny = false;
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
  applyPermissionModeToBody(body, metadata, request.permissionMode);
  applyRuntimeProfileToBody(body, metadata, request.agentProfile);
  applyStandardImageInputEnabledToMetadata(metadata, request.standardImageInputEnabled);
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
  if (allowedSkills) {
    body.allowed_skills = allowedSkills;
    metadata.allowed_skills = allowedSkills;
    metadata.skills = allowedSkills;
  }
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
  applyPermissionModeToBody(body, metadata, request.permissionMode);
  applyRuntimeProfileToBody(body, metadata, request.agentProfile);
  applyStandardImageInputEnabledToMetadata(metadata, request.standardImageInputEnabled);
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
  if (allowedSkills) {
    body.allowed_skills = allowedSkills;
    metadata.allowed_skills = allowedSkills;
    metadata.skills = allowedSkills;
  }
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
  return value === 'auto' ? 'auto' : 'off';
}

function normalizePermissionMode(value?: PermissionMode): PermissionMode {
  if (value === 'user_free' || value === 'all_free') {
    return value;
  }
  return 'task_free';
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
    | 'onStart'
    | 'onDelta'
    | 'onToolExecution'
    | 'onInteractiveRequest'
    | 'onFinalAssistantText'
    | 'onMessages'
    | 'onAssistantRevision'
  >,
): { clearEmitted?: boolean } | undefined {
  const decoded = parseJson(rawData);
  if (decoded == null) {
    return;
  }

  if (eventName === 'start') {
    request.onStart?.({
      sessionId: String(decoded.session_id ?? ''),
      turnId: String(decoded.turn_id ?? ''),
    });
    return;
  }

  if (eventName === 'error') {
    throw new Error(String(decoded.message ?? decoded.detail ?? 'BushServer stream error'));
  }

  if (eventName === 'token') {
    const delta = String(decoded.delta ?? '');
    if (delta) {
      request.onDelta?.(delta);
    }
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

  if (eventName === 'interactive_request') {
    const interaction = pendingInteractionFromPayload(decoded);
    if (interaction) {
      request.onInteractiveRequest?.(interaction);
    }
    return;
  }

  if (
    eventName === 'message' ||
    eventName === 'assistant_message' ||
    eventName === 'node_state'
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
      request.onFinalAssistantText(text);
      return;
    }
    if (text && !emittedAny) {
      request.onDelta?.(text);
    }
    return;
  }

  const text = decoded.delta ?? decoded.text ?? decoded.content;
  if (text != null) {
    request.onDelta?.(String(text));
  }
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
  const metadata = asRecord(value.metadata);
  const id = String(value.id ?? value.session_id ?? value.sessionId ?? `session-${index}`);
  return {
    id,
    title: normalizeConversationTitle(value.title ?? value.name, id),
    preview: String(value.preview ?? value.summary ?? value.last_message_preview ?? ''),
    updatedAt: String(value.updated_at ?? value.updatedAt ?? new Date().toISOString()),
    agentProfile: optionalString(
      value.agent_profile ??
        value.agentProfile ??
        value.runtime_profile ??
        value.runtimeProfile ??
        metadata.agent_profile ??
        metadata.agentProfile ??
        metadata.runtime_profile ??
        metadata.runtimeProfile,
    ),
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

function runtimeProfilesFromPayload(payload: unknown): RuntimeProfileSummary[] {
  const value = asRecord(payload);
  const primary = Array.isArray(payload)
    ? payload
    : Array.isArray(value.profiles)
      ? value.profiles
      : Array.isArray(value.items)
        ? value.items
        : Array.isArray(value.data)
          ? value.data
          : [];
  const custom = Array.isArray(value.custom_profiles)
    ? value.custom_profiles
    : Array.isArray(value.customProfiles)
      ? value.customProfiles
      : [];
  return [...primary, ...custom]
    .map(runtimeProfileFromPayload)
    .filter((item): item is RuntimeProfileSummary => item != null);
}

function runtimeProfileFromPayload(payload: unknown): RuntimeProfileSummary | null {
  const value = asRecord(payload);
  const id = String(value.id ?? value.name ?? value.profile ?? '').trim();
  if (!id) {
    return null;
  }
  return {
    id,
    label: String(value.label ?? value.display_name ?? value.displayName ?? id),
    description: String(value.description ?? value.summary ?? ''),
    defaultLane: optionalString(value.default_lane ?? value.defaultLane),
    phases: stringList(value.phases),
    allowedLanes: stringList(value.allowed_lanes ?? value.allowedLanes),
    hookSet: optionalString(value.hook_set ?? value.hookSet),
    toolPolicy: asOptionalRecord(value.tool_policy ?? value.toolPolicy),
    verificationPolicy: asOptionalRecord(
      value.verification_policy ?? value.verificationPolicy,
    ),
    finalResponseContract: asOptionalRecord(
      value.final_response_contract ?? value.finalResponseContract,
    ),
    transactionContract: asOptionalRecord(
      value.transaction_contract ?? value.transactionContract,
    ),
    raw: value,
  };
}

function backendCapabilitiesFromPayload(payload: unknown): BackendCapabilities {
  const root = asRecord(payload);
  const features = asRecord(root.features ?? root.capabilities ?? root);
  const endpoints = asRecord(root.endpoints);
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
    localMusicLibrary: capabilityBoolean(features, endpoints, 'localMusicLibrary', [
      'local_music_library',
    ]),
    agentConfigPackages: capabilityBoolean(features, endpoints, 'agentConfigPackages', [
      'agent_config_packages',
    ]),
    agentConfigPackageTransactionContracts: capabilityBoolean(
      features,
      endpoints,
      'agentConfigPackageTransactionContracts',
      [
        'agent_config_package_transaction_contracts',
        'agent_config_packages_transaction_contracts',
        'transaction_contracts',
      ],
    ),
  };
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

function applyRuntimeProfileToBody(
  body: Record<string, unknown>,
  metadata: Record<string, unknown>,
  value?: string,
) {
  const normalized = value?.trim();
  if (!normalized) {
    return;
  }
  body.agent_profile = normalized;
  body.runtime_profile = normalized;
  metadata.agent_profile = normalized;
  metadata.runtime_profile = normalized;
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
    role,
    content,
    conversationId: optionalString(
      value.conversation_id ?? value.session_id ?? value.conversationId ?? value.sessionId,
    ),
    turnId,
    createdAt: optionalString(value.created_at ?? value.createdAt),
    status: optionalString(value.status ?? asRecord(value.metadata).status),
    loopIndex: optionalNumber(
      value.loop_index ?? value.loopIndex ?? asRecord(value.metadata).loop_index,
    ),
    turnSequence: optionalNumber(value.turn_sequence ?? value.turnSequence),
    messageIndex: optionalNumber(value.message_index ?? value.messageIndex ?? index),
    assistantMessageId: optionalString(
      value.assistant_message_id ??
        value.assistantMessageId ??
        asRecord(value.metadata).assistant_message_id ??
        asRecord(value.metadata).assistantMessageId,
    ),
    toolExecutions: toolExecutionsFromPayload(
      value.toolExecutions ?? value.tool_executions,
    ),
    metadata: asOptionalRecord(value.metadata),
  };
}

function assistantRevisionFromPayload(payload: Record<string, unknown>): AssistantRevision {
  return {
    action: String(payload.action ?? ''),
    turnId: optionalString(payload.turn_id ?? payload.turnId),
    reason: optionalString(payload.reason),
    draftState: optionalString(payload.draft_state ?? payload.draftState),
    loopIndex: optionalNumber(payload.loop_index ?? payload.loopIndex),
    issue: optionalString(payload.issue),
    content: optionalString(payload.content),
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
    success: typeof payload.success === 'boolean' ? payload.success : state === 'ok',
    durationMs: numericValue(payload.duration_ms ?? payload.durationMs),
    createdAt:
      optionalString(payload.created_at ?? payload.createdAt) ?? new Date().toISOString(),
    contentOffset: integerValue(contentOffsetValue),
    contentOffsetExplicit: hasNumericValue(contentOffsetValue),
    sequence: optionalNumber(payload.sequence ?? metadata.sequence),
    loopIndex: optionalNumber(
      payload.loop_index ?? payload.loopIndex ?? metadata.loop_index ?? metadata.loopIndex,
    ),
    assistantMessageId: optionalString(
      payload.assistant_message_id ??
        payload.assistantMessageId ??
        metadata.assistant_message_id ??
        metadata.assistantMessageId,
    ),
    metadata,
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
        success: typeof item.success === 'boolean' ? item.success : state === 'ok',
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
  const rawState = nonEmpty(payload.state) ?? nonEmpty(metadata.state);
  const state = (rawState ?? '').toLowerCase();
  if (['ok', 'done', 'success', 'completed'].includes(state)) {
    return 'ok';
  }
  if (['using', 'running', 'pending', 'started'].includes(state)) {
    return 'using';
  }
  if (['fail', 'failed', 'error'].includes(state)) {
    return 'fail';
  }
  if (Object.prototype.hasOwnProperty.call(payload, 'success')) {
    return payload.success === true ? 'ok' : 'fail';
  }
  return state || 'using';
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

function subagentDetailFromPayload(value: unknown): SubagentDetail {
  const item = asRecord(value);
  return {
    ...subagentListItemFromPayload(item),
    systemPrompt: String(item.system_prompt ?? item.systemPrompt ?? ''),
    instruction: String(item.instruction ?? ''),
    tools: stringList(item.tools),
    toolProfile: optionalString(item.tool_profile ?? item.toolProfile),
    skills: stringList(item.skills),
    model: optionalString(item.model),
    provider: optionalString(item.provider),
    baseUrl: optionalString(item.base_url ?? item.baseUrl),
    inheritsGlobalModel:
      item.inherits_global_model !== false && item.inheritsGlobalModel !== false,
    permissionPolicy: asRecord(item.permission_policy ?? item.permissionPolicy),
    routing: asRecord(item.routing),
    concurrencyLimit: optionalNumber(item.concurrency_limit ?? item.concurrencyLimit),
    timeoutSeconds: optionalNumber(item.timeout_seconds ?? item.timeoutSeconds),
    workdirPolicy: asRecord(item.workdir_policy ?? item.workdirPolicy),
    rawConfig: asRecord(item.raw_config ?? item.rawConfig),
  };
}

function subagentValidationFromPayload(value: unknown): SubagentValidationResult {
  const item = asRecord(value);
  const errors = Array.isArray(item.errors) ? item.errors : [];
  return {
    ok: item.ok === true,
    errors: errors.map((error) => {
      const record = asRecord(error);
      const severity = String(record.severity ?? '').trim().toLowerCase();
      return {
        field: String(record.field ?? ''),
        message: String(record.message ?? ''),
        severity: severity === 'warning' ? 'warning' : 'error',
      };
    }),
    effectiveConfig: asRecord(item.effective_config ?? item.effectiveConfig),
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

function subagentUsageFromPayload(value: unknown): SubagentUsageResult {
  const item = asRecord(value);
  return {
    byAgent: Object.fromEntries(
      Object.entries(asRecord(item.by_agent ?? item.byAgent)).map(([key, raw]) => [
        key,
        asRecord(raw),
      ]),
    ),
    totals: asRecord(item.totals),
    recent: Array.isArray(item.recent) ? item.recent.map(asRecord) : [],
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
  if (statusCode === 403) {
    return `BushServer 拒绝访问${detail ? `: ${detail}` : ''}。请检查本地 secret 文件或 BUSH_API_AUTH_TOKEN 是否与 BushServer 启动配置一致。`;
  }
  return detail ? `BushServer error ${statusCode}: ${detail}` : `BushServer error: ${statusCode}`;
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
