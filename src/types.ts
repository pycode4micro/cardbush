import type { LucideIcon } from 'lucide-react';

export type AppSection = 'chat' | 'search' | 'skills' | 'subagents' | 'team';
export type SettingsSection =
  | 'profile'
  | 'companion'
  | 'proxy'
  | 'bots'
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
export type ProxyMode = 'none' | 'system' | 'manual';
export type PermissionMode = 'task_free' | 'user_free' | 'all_free';
export type ChatRole = 'user' | 'assistant' | 'system' | 'guidance' | 'tool';
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

export interface ProxySettings {
  mode: ProxyMode;
  httpProxy: string;
  httpsProxy: string;
  noProxy: string;
}

export interface BackendAuthSettings {
  bearerToken: string;
  localRequestKey: string;
}

export interface BackendCapabilities {
  chatStream: boolean;
  sessions: boolean;
  skills: boolean;
  interactions: boolean;
  turnStop: boolean;
  runtimeInspection: boolean;
  maintenanceConversationHistoryClear: boolean;
  maintenanceLogsCacheClear: boolean;
  botControl: boolean;
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
  localMusicLibrary: boolean;
}

export interface ManagedModelConfig {
  id: string;
  provider: string;
  apiKey: string;
  modelName: string;
  baseUrl: string;
  maxContextTokens?: number;
}

export interface RuntimeProfileSummary {
  id: string;
  label: string;
  description: string;
  defaultLane?: string;
  phases: string[];
  allowedLanes: string[];
  hookSet?: string;
  toolPolicy?: Record<string, unknown>;
  verificationPolicy?: Record<string, unknown>;
  finalResponseContract?: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface AppFontSettings {
  family: string;
  displayName: string;
  filePath: string;
}

export interface UserProfile {
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

export interface CardlingMiniChatState {
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
  backendAuth: BackendAuthSettings;
  managedModelConfigs: ManagedModelConfig[];
  backgroundImagePath: string;
  companionEnabled: boolean;
  companion: CompanionSettings;
  font: AppFontSettings;
  user: UserProfile;
}

export interface NavItem {
  id: AppSection;
  label: string;
  icon: LucideIcon;
}

export interface ConversationSummary {
  id: string;
  title: string;
  preview: string;
  updatedAt: string;
  agentProfile?: string;
  projectDir?: string;
  metadata?: Record<string, unknown>;
  workspaceContext?: WorkspaceContext;
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
  type: 'image' | 'video' | 'document';
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
  assistantMessageId?: string;
  metadata: Record<string, unknown>;
}

export interface AssistantRevision {
  action: 'clear' | 'replace' | string;
  turnId?: string;
  reason?: string;
  draftState?: string;
  loopIndex?: number;
  issue?: string;
  content?: string;
}

export interface ChatMessage {
  id: string;
  messageId?: string;
  role: ChatRole;
  content: string;
  conversationId?: string;
  turnId?: string;
  createdAt?: string;
  status?: string;
  loopIndex?: number;
  turnSequence?: number;
  messageIndex?: number;
  assistantMessageId?: string;
  attachments?: ChatAttachment[];
  toolExecutions?: ChatToolExecution[];
  loopHistory?: ChatMessage[];
  metadata?: Record<string, unknown>;
}

export interface StreamStart {
  sessionId: string;
  turnId: string;
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
export type SubagentValidationSeverity = 'error' | 'warning';

export interface SubagentValidationErrorItem {
  field: string;
  message: string;
  severity: SubagentValidationSeverity;
}

export interface SubagentValidationResult {
  ok: boolean;
  errors: SubagentValidationErrorItem[];
  effectiveConfig: Record<string, unknown>;
}

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

export interface SubagentDetail extends SubagentListItem {
  systemPrompt: string;
  instruction: string;
  tools: string[];
  toolProfile?: string;
  skills: string[];
  model?: string;
  provider?: string;
  baseUrl?: string;
  inheritsGlobalModel: boolean;
  permissionPolicy: Record<string, unknown>;
  routing: Record<string, unknown>;
  concurrencyLimit?: number;
  timeoutSeconds?: number;
  workdirPolicy: Record<string, unknown>;
  rawConfig: Record<string, unknown>;
}

export interface SubagentTemplate {
  id: string;
  name: string;
  description: string;
  rawConfig: Record<string, unknown>;
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

export interface SubagentRuntimeItem extends SubagentListItem {
  runtime: Record<string, unknown>;
}

export interface SubagentSupervisorLimits {
  maxActiveTotal?: number;
  maxActivePerSession?: number;
  maxActivePerAgent?: number;
  maxDepth?: number;
  taskTtlSeconds?: number;
}

export interface SubagentSupervisorCounts {
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

export interface SubagentUsageResult {
  byAgent: Record<string, Record<string, unknown>>;
  totals: Record<string, unknown>;
  recent: Array<Record<string, unknown>>;
}

export interface AutomationTask {
  id: string;
  title: string;
  cadence: string;
  enabled: boolean;
}
