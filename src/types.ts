import type { LucideIcon } from 'lucide-react';

export type AppSection = 'chat' | 'search' | 'skills' | 'automation';
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
export type ProxyMode = 'system' | 'manual';
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

export interface ManagedModelConfig {
  id: string;
  provider: string;
  apiKey: string;
  modelName: string;
  baseUrl: string;
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
}

export type CardlingDesktopAction = 'settings' | 'changes' | 'revertChanges';

export interface AppSettingsState {
  proxy: ProxySettings;
  managedModelConfigs: ManagedModelConfig[];
  hideCardbushForScreenshot: boolean;
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
  metadata: Record<string, unknown>;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  conversationId?: string;
  turnId?: string;
  createdAt?: string;
  attachments?: ChatAttachment[];
  toolExecutions?: ChatToolExecution[];
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
  configured: boolean;
  serviceStatus: BotServiceStatus;
  accountCount?: number;
  displayName?: string;
  lastError?: string;
  raw: Record<string, unknown>;
}

export interface BotConfigResult {
  platform: BotPlatform;
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface BotStatusResult {
  platform: BotPlatform;
  configured: boolean;
  serviceStatus: BotServiceStatus;
  accountCount?: number;
  accounts?: Array<Record<string, unknown>>;
  lastError?: string;
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

export interface AutomationTask {
  id: string;
  title: string;
  cadence: string;
  enabled: boolean;
}
