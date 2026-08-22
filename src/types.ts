export type AppSection = 'chat' | 'os' | 'search' | 'skills' | 'tools' | 'subagents' | 'team';
export type SettingsSection =
  | 'profile'
  | 'companion'
  | 'os'
  | 'runtime'
  | 'proxy'
  | 'bots'
  | 'subagents'
  | 'mcp'
  | 'cache'
  | 'models'
  | 'diagnostics'
  | 'mobile'
  | 'about';
export type ThemeMode = 'parchment' | 'bright' | 'dark';
export type ThemePreference = 'system' | 'light' | 'dark';
export type LightThemeStyle = 'parchment' | 'bright';
export type AppLanguage = 'zh' | 'en';
export type AppLanguageMode = 'system' | 'zh' | 'en';
export type ReferencePlanMode = 'off' | 'auto';
export type TaskPlanStatus = 'pending' | 'in_progress' | 'completed';
type ProxyMode = 'none' | 'system' | 'manual';
export type PermissionMode = 'task_free' | 'user_free' | 'all_free';
export type ReasoningLevel = 'low' | 'medium' | 'high' | 'max';
export type TerminalRuntime = 'powershell' | 'wsl' | 'git_bash' | 'bash';
export type McpTransport = 'stdio' | 'sse' | 'streamable_http' | 'http';
type ChatRole = 'user' | 'assistant' | 'system' | 'guidance' | 'tool';
export type CompanionSize = 'compact' | 'normal' | 'large';
export type CompanionMotionMode = 'full' | 'reduced' | 'off';
export type CompanionStatus =
  | 'idle'
  | 'thinking'
  | 'tool'
  | 'waiting'
  | 'queued'
  | 'complete'
  | 'error';
export type BotPlatform = 'weixin' | 'feishu' | 'telegram' | 'discord';
export type BotServiceStatus =
  | 'stopped'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'failed';
export type WeixinLoginStatus =
  | 'waiting'
  | 'scanned'
  | 'confirmed'
  | 'expired'
  | 'failed';

interface ProxySettings {
  mode: ProxyMode;
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;
}

interface BackendAuthSettings {
  bearerToken: string;
  localRequestKey: string;
}

interface TerminalSettings {
  runtime: TerminalRuntime;
}

interface OsSettings {
  launchAtLogin: boolean;
  startInOsMode: boolean;
  taskbarPlacement: 'top' | 'bottom';
  backgroundContrast: number;
  gamepad: {
    confirmButton: number;
    backButton: number;
    keyboardButton: number;
    appsButton: number;
    settingsButton: number;
  };
}

export interface BackendCapabilities {
  chatStream: boolean;
  sessions: boolean;
  skills: boolean;
  interactions: boolean;
  interactiveRequests: boolean;
  permissionRequests: boolean;
  turnStop: boolean;
  turnEventReplay: boolean;
  runtimeInspection: boolean;
  maintenanceConversationHistoryClear: boolean;
  maintenanceLogsCacheClear: boolean;
  maintenanceRuntimeAssetsReset: boolean;
  runtimeAssetResetProtocol: string;
  runtimeAssetResetCategories: RuntimeAssetCategory[];
  botControl: boolean;
  sessionShareLinks: boolean;
  messageEditRegenerate: boolean;
  turnRegenerate: boolean;
  stableMessageIds: boolean;
  standardImageInputTool: boolean;
  standardImageInputToolName: string;
  projects: boolean;
  git: boolean;
  terminal: boolean;
  resources: boolean;
  settingsSync: boolean;
  mcpServers: boolean;
  subagents: boolean;
  subagentObservability: boolean;
  subagentObservabilityProtocol: string;
  subagentFrontendConfiguration: boolean;
  remoteAgentsViaMcp: boolean;
  teamMode: boolean;
  teamAgentFlow: boolean;
  teamFlowState: boolean;
  teamFlowActions: boolean;
  teamFlowEvents: boolean;
  teamWorkflows: boolean;
  workflowRuntime: boolean;
  shadowConversationActivation: boolean;
  contextWindowUsage: boolean;
  capabilityDiscovery: boolean;
  workspaceChanges: boolean;
  sessionContextSearch: boolean;
  sessionActivityOrdering: boolean;
  agentVisualScenes: boolean;
  browserCookiePersistence: boolean;
  browserPrivacyMode: boolean;
  browserApiCandidates: boolean;
  browserContextApiRequest: boolean;
  osMode: boolean;
  desktopAutomation: boolean;
  taskPlan: boolean;
  reasoningStream: boolean;
  reasoningLevelSelection: boolean;
  reasoningLevels: ReasoningLevel[];
  defaultReasoningLevel: ReasoningLevel;
  terminalRuntimeSelection: boolean;
  terminalRuntimes: TerminalRuntime[];
  defaultTerminalRuntime: TerminalRuntime;
}

export interface RuntimeContextWindowUsage {
  sessionId: string;
  turnId: string;
  model: string;
  usedTokens?: number;
  maxTokens?: number;
  remainingTokens?: number;
  usageRatio?: number;
  measuredAt: string;
  source: string;
  raw: Record<string, unknown>;
}

export interface CapabilityCandidate {
  name: string;
  type: 'skill' | 'tool';
  description: string;
  score?: number;
  path?: string;
  matchedFields: string[];
}

export interface CapabilityCandidatesUpdate {
  protocol: string;
  sessionId: string;
  turnId: string;
  authority: string;
  selection: string;
  skills: CapabilityCandidate[];
  tools: CapabilityCandidate[];
  timestamp: string;
  raw: Record<string, unknown>;
}

export interface ManagedModelConfig {
  id: string;
  provider: string;
  apiKey: string;
  hasApiKey?: boolean;
  apiKeyMasked?: string;
  modelName: string;
  baseUrl: string;
  maxContextTokens?: number;
  maxCompletionTokens?: number;
}

export interface McpServerConfig {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  transport: McpTransport;
  command?: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  timeoutSeconds?: number;
  toolCount?: number;
  status?: string;
  lastError?: string;
  raw: Record<string, unknown>;
}

export interface McpServersResult {
  servers: McpServerConfig[];
  protocolVersions: string[];
  raw: Record<string, unknown>;
}

export interface McpValidationMessage {
  path: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

export interface McpServerValidationResult {
  ok: boolean;
  serverId?: string;
  tools: string[];
  messages: McpValidationMessage[];
  raw: Record<string, unknown>;
}

interface AppFontSettings {
  family: string;
  displayName: string;
  filePath: string;
}

interface UserProfile {
  name: string;
  membership: string;
  avatarEmoji: string;
  avatarImagePath?: string;
}

export interface CompanionSettings {
  size: CompanionSize;
  opacity: number;
  motion: CompanionMotionMode;
}

interface BrowserSettings {
  privacyMode: boolean;
}

interface ShadowUiSettings {
  accentColor: string;
}

interface ThinkingUiSettings {
  visible: boolean;
}

export interface ThinkingStreamEvent {
  id: string;
  channel: 'reasoning';
  turnId: string;
  generationId: string;
  phase: 'start' | 'delta' | 'end';
  loopIndex?: number;
  attemptIndex?: number;
  delta: string;
  content: string;
  preview: string;
  createdAt: string;
}

type RuntimeConnectionState =
  | 'retrying'
  | 'syncing'
  | 'recovered'
  | 'failed';

export interface RuntimeConnectionUpdate {
  state: RuntimeConnectionState;
  source: 'network' | 'provider';
  sessionId: string;
  turnId?: string;
  attempt?: number;
  nextRetryMs?: number;
  reason?: string;
  message?: string;
  createdAt: string;
}

export interface CardlingDesktopState {
  enabled: boolean;
  language: AppLanguage;
  theme: ThemeMode;
  settings: CompanionSettings;
  status: CompanionStatus;
  sending: boolean;
  queuedMessageCount: number;
  pendingInteraction: boolean;
  activeChangeCount: number;
  activeChangeFileCount: number;
  error: string | null;
  miniChat: CardlingMiniChatState;
}

interface CardlingMiniChatState {
  title: string;
  lastUser: string;
  lastAssistant: string;
}

export type CardlingDesktopAction =
  | 'settings'
  | 'changes'
  | 'revertChanges'
  | 'openMain'
  | { type: 'miniChatSend'; text: string };

export interface AppSettingsState {
  proxy: ProxySettings;
  browser: BrowserSettings;
  shadow: ShadowUiSettings;
  thinking: ThinkingUiSettings;
  terminal: TerminalSettings;
  os: OsSettings;
  backendAuth: BackendAuthSettings;
  managedModelConfigs: ManagedModelConfig[];
  backgroundImagePath: string;
  companionEnabled: boolean;
  companion: CompanionSettings;
  font: AppFontSettings;
  user: UserProfile;
}

export interface ConversationSummary {
  id: string;
  title: string;
  preview: string;
  updatedAt: string;
  projectDir?: string;
  metadata?: Record<string, unknown>;
  workspaceContext?: WorkspaceContext;
}

export type SessionAttentionKind = 'completed' | 'waiting' | 'error';

export interface SessionAttentionState {
  sessionId: string;
  kind: SessionAttentionKind;
  title: string;
  body: string;
  turnId?: string;
  updatedAt: string;
}

export interface WorkspaceContext {
  mode: 'task' | 'project';
  executionRoot: string;
  projectDir: string | null;
  taskDir: string;
  source: string;
}

export interface ProjectItem {
  id: string;
  title: string;
  rootPath: string;
  pinned?: boolean;
  archived?: boolean;
  branch?: string;
  changedCount?: number;
}

export interface ChatAttachment {
  id: string;
  name: string;
  type: 'image' | 'video' | 'audio' | 'document';
  path?: string;
  size?: number;
}

export type RuntimeAssetCategory = 'prompts' | 'skills' | 'tools';

interface RuntimeAssetLocation {
  sourcePath: string;
  targetPath: string;
}

export interface RuntimeAssetResetPlan {
  protocol: string;
  categories: Partial<Record<RuntimeAssetCategory, RuntimeAssetLocation>>;
  requiresConfirmation: boolean;
  requiresIdleRuntime: boolean;
  destructive: boolean;
  restartRequiredAfterChange: boolean;
}

interface RuntimeAssetResetCategoryResult extends RuntimeAssetLocation {
  changed: boolean;
  seedFileCount: number;
  restoredFileCount: number;
  removedRuntimeFileCount: number;
}

export interface RuntimeAssetResetResult {
  protocol: string;
  selectedCategories: RuntimeAssetCategory[];
  categories: Partial<Record<RuntimeAssetCategory, RuntimeAssetResetCategoryResult>>;
  changed: boolean;
  restartRequired: boolean;
  effectiveAfter: string;
}

export interface SessionTokenUsage {
  sessionId: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  promptCacheHitTokens: number;
  promptCacheMissTokens: number;
}

export interface ChatToolExecution {
  id: string;
  name: string;
  state: string;
  summary: string;
  output: string;
  success: boolean;
  durationMs: number;
  createdAt: string;
  contentOffset: number;
  contentOffsetExplicit?: boolean;
  sequence?: number;
  loopIndex?: number;
  turnId?: string;
  messageId?: string;
  assistantMessageId?: string;
  assistantSegmentIndex?: number;
  metadata: Record<string, unknown>;
}

interface TaskPlanNode {
  id?: string;
  step: string;
  status: TaskPlanStatus;
}

export interface TaskPlanSnapshot {
  protocol: 'bush.task_plan.v1';
  planId: string;
  sessionId: string;
  nodes: TaskPlanNode[];
  explanation: string;
  active: boolean;
}

export interface TaskPlanStreamUpdate {
  turnId: string;
  messageId?: string;
  assistantSegmentIndex?: number;
  plan: TaskPlanSnapshot;
}

export interface AssistantRevision {
  action: 'clear' | 'replace' | string;
  channel?: 'assistant' | string;
  turnId?: string;
  reason?: string;
  draftState?: string;
  loopIndex?: number;
  issue?: string;
  content?: string;
  messageId?: string;
  assistantSegmentIndex?: number;
}

export interface ChatMessage {
  id: string;
  messageId?: string;
  clientMessageId?: string;
  role: ChatRole;
  content: string;
  conversationId?: string;
  turnId?: string;
  createdAt?: string;
  status?: string;
  loopIndex?: number;
  turnSequence?: number;
  messageIndex?: number;
  sequence?: number;
  requestId?: string;
  eventId?: string;
  assistantMessageId?: string;
  attachments?: ChatAttachment[];
  toolExecutions?: ChatToolExecution[];
  taskPlan?: TaskPlanSnapshot;
  loopHistory?: ChatMessage[];
  metadata?: Record<string, unknown>;
}

export interface StreamStart {
  sessionId: string;
  turnId: string;
  messageId?: string;
  assistantSegmentIndex?: number;
  createdAt?: string;
}

export interface AssistantStreamChunk {
  messageId: string;
  assistantSegmentIndex?: number;
  turnId: string;
  createdAt?: string;
  sequence?: number;
  requestId?: string;
  eventId?: string;
}

export interface TurnTerminalSnapshot {
  turnId: string;
  status: string;
  stopped: boolean;
  stopReason: string;
  stopScenario: string;
  stopDetails?: Record<string, unknown>;
  completedAt?: string;
  durationMs?: number;
  terminalEventSequence?: number;
  raw: Record<string, unknown>;
}

export interface StreamExecutionUpdate extends AssistantStreamChunk {
  kind: string;
  reason?: string;
  pendingGuidanceCount?: number;
  guidanceRoundIndex?: number;
  previousAssistantSegmentIndex?: number;
  nextAssistantSegmentIndex?: number;
  nextRound?: number;
}

export type TeamFlowActionType =
  | 'modify_layer'
  | 'continue_next_layer'
  | 'enter_execution'
  | 'cancel'
  | string;

export interface TeamFlowActionOption {
  id: string;
  action: TeamFlowActionType;
  label?: string;
  labelKey?: string;
  control?: string;
  description?: string;
  raw: Record<string, unknown>;
}

type TeamFlowEventType =
  | 'team_layer'
  | 'team_node'
  | 'team_action_required';

export interface TeamFlowNode {
  id: string;
  layerId?: string;
  layerIndex?: number;
  title: string;
  summary: string;
  status: string;
  kind?: string;
  profileId?: string;
  parentIds: string[];
  tools: string[];
  validation?: string;
  raw: Record<string, unknown>;
}

export interface TeamFlowLayer {
  id: string;
  index?: number;
  title: string;
  goal: string;
  summary: string;
  status: string;
  nodes: TeamFlowNode[];
  suggestedActions: TeamFlowActionType[];
  actionOptions: TeamFlowActionOption[];
  raw: Record<string, unknown>;
}

export interface TeamFlowState {
  id: string;
  flowId: string;
  sessionId: string;
  status: string;
  currentLayerId?: string;
  currentLayerIndex?: number;
  layers: TeamFlowLayer[];
  nodes: TeamFlowNode[];
  suggestedActions: TeamFlowActionType[];
  actionOptions: TeamFlowActionOption[];
  raw: Record<string, unknown>;
}

export interface TeamFlowStreamEvent {
  type: TeamFlowEventType;
  flowId?: string;
  sessionId?: string;
  status?: string;
  currentLayerId?: string;
  currentLayerIndex?: number;
  layer?: TeamFlowLayer;
  node?: TeamFlowNode;
  suggestedActions: TeamFlowActionType[];
  actionOptions: TeamFlowActionOption[];
  raw: Record<string, unknown>;
}

export interface PendingInteraction {
  id: string;
  type?: string;
  sessionId?: string;
  turnId?: string;
  title?: string;
  reason?: string;
  message?: string;
  description?: string;
  submitLabel?: string;
  cancelLabel?: string;
  replyMode?: string;
  toolName?: string;
  permissionPreview?: Record<string, unknown>;
  questions?: InteractionQuestion[];
  raw: Record<string, unknown>;
}

export interface InteractionOption {
  id: string;
  label: string;
  description?: string;
}

export interface InteractionQuestion {
  id: string;
  label: string;
  question: string;
  selectionMode: 'single' | 'multiple' | 'input';
  needInput: boolean;
  required: boolean;
  options: InteractionOption[];
}

export interface InteractionReplyAnswer {
  questionId: string;
  selectedOptionId?: string;
  selectedOptionIds?: string[];
  inputText?: string;
}

export interface BotPlatformOverview {
  platform: BotPlatform;
  enabled: boolean;
  configured: boolean;
  serviceStatus: BotServiceStatus;
  accountCount?: number;
  displayName?: string;
  lastError?: string;
  missingRequiredFields: string[];
  raw: Record<string, unknown>;
}

export interface BotConfigResult {
  platform: BotPlatform;
  enabled: boolean;
  configured: boolean;
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
  missingRequiredFields: string[];
  raw: Record<string, unknown>;
}

export interface BotStatusResult {
  platform: BotPlatform;
  enabled: boolean;
  configured: boolean;
  serviceStatus: BotServiceStatus;
  pid?: number;
  returnCode?: number;
  startedAt?: string;
  stoppedAt?: string;
  logPath?: string;
  accountCount?: number;
  accounts?: Array<Record<string, unknown>>;
  lastError?: string;
  missingRequiredFields: string[];
  raw: Record<string, unknown>;
}

export interface WeixinLoginStartResult {
  loginId: string;
  qrcodeUrl: string;
  expiresAt?: string;
  raw: Record<string, unknown>;
}

export interface WeixinLoginStatusResult {
  loginId: string;
  status: WeixinLoginStatus;
  account?: Record<string, unknown>;
  message?: string;
  raw: Record<string, unknown>;
}

export interface BotServiceLogsResult {
  platform: BotPlatform;
  lines: string[];
  raw: Record<string, unknown>;
}

export interface SkillSummary {
  name: string;
  description: string;
  descriptionZh?: string;
  path: string;
}

export interface SkillDetail extends SkillSummary {
  packageDir: string;
  content: string;
  version?: string;
  routingHidden: boolean;
  requires: string[];
  conflictsWith: string[];
  minServerVersion?: string;
  timeout?: Record<string, number>;
  companionTools: string[];
  blockedTools: string[];
  requiredReads: string[];
  conditionalReads: string[];
  resourceQuickRefs: Array<Record<string, unknown>>;
}

export type SubagentValidationStatus = 'valid' | 'invalid' | 'disabled';
export interface SubagentListItem {
  id: string;
  name: string;
  displayName: string;
  description: string;
  enabled: boolean;
  tags: string[];
  source: string;
  registryPath: string;
  version?: string;
  lastLoadedAt?: string;
  validationStatus: SubagentValidationStatus;
  error?: string;
}

export interface SubagentCapabilities {
  models: Array<Record<string, unknown>>;
  tools: string[];
  toolPackages: string[];
  skills: Array<Record<string, unknown>>;
  permissionLevels: string[];
  runModes: string[];
  toolProfiles: string[];
}

interface SubagentRuntimeItem extends SubagentListItem {
  runtime: Record<string, unknown>;
}

interface SubagentSupervisorLimits {
  maxActiveTotal?: number;
  maxActivePerSession?: number;
  maxActivePerAgent?: number;
  maxDepth?: number;
  taskTtlSeconds?: number;
}

interface SubagentSupervisorCounts {
  totalActive?: number;
  sessionActive: Record<string, number>;
  agentActive: Record<string, number>;
}

export interface SubagentSupervisorSnapshot {
  enabled: boolean;
  limits: SubagentSupervisorLimits;
  counts: SubagentSupervisorCounts;
  queueMode?: string;
  rejectStrategy?: string;
  depth?: number;
  blockedTools: string[];
}

export interface SubagentRuntimeResult {
  activeTasks: Array<Record<string, unknown>>;
  items: SubagentRuntimeItem[];
  usage: Record<string, unknown>;
  supervisor?: SubagentSupervisorSnapshot;
}

export const SUBAGENT_DISPATCH_EVENT_PROTOCOL = 'bushserver.subagent_dispatch_event.v1';

type SubagentDispatchPhase = 'dispatching' | 'dispatched' | 'failed';

export interface SubagentDispatchEvent {
  protocol: string;
  phase: SubagentDispatchPhase;
  status: string;
  terminal: boolean;
  accepted?: boolean;
  taskId?: string;
  toolCallId: string;
  parentSessionId: string;
  parentTurnId: string;
  childSessionId?: string;
  agentName?: string;
  autonomyLevel?: string;
  taskType?: string;
  reviewStatus?: string;
  contractState?: string;
  errorCode?: string;
  detailEndpoint?: string;
  taskListEndpoint?: string;
  completionEndpoint?: string;
  raw: Record<string, unknown>;
}

export interface SubagentTaskSnapshot {
  protocol: string;
  taskId?: string;
  toolCallId?: string;
  parentSessionId: string;
  parentTurnId: string;
  childSessionId?: string;
  agentName?: string;
  requestPrompt?: string;
  responsePrompt?: string;
  status: string;
  terminal: boolean;
  accepted?: boolean;
  errorMessage?: string;
  reviewStatus?: string;
  reportOutcome?: string;
  contractState?: string;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  completedAt?: string;
  detailEndpoint?: string;
  report: Record<string, unknown>;
  review: Record<string, unknown>;
  contractEvaluation: Record<string, unknown>;
  executionContract: Record<string, unknown>;
  workerProposal: Record<string, unknown>;
  mergePlan: Record<string, unknown>;
  usage: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface SubagentCompletionEvent {
  eventId: string;
  deliveryState: string;
  claimedByTurnId?: string;
  createdAt?: string;
  updatedAt?: string;
  task: SubagentTaskSnapshot;
  raw: Record<string, unknown>;
}
