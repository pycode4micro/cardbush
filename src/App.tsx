import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  Clipboard,
  ExternalLink,
  Flag,
  Folder,
  Gamepad2,
  GitBranch,
  LoaderCircle,
  LogOut,
  Menu,
  MessageSquare,
  Monitor,
  MonitorCog,
  Keyboard,
  LayoutGrid,
  PanelRightClose,
  PanelRightOpen,
  Plug,
  Puzzle,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Terminal,
  Wrench,
  X,
} from 'lucide-react';
import {
  Component,
  type CSSProperties,
  type ErrorInfo,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type UIEvent,
  type WheelEvent,
  createElement,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  backendBearerTokenStorageKey,
  backendLocalRequestKeyStorageKey,
  defaultBackendCapabilities,
  closeShadowConversation,
  createShadowConversation,
  fetchBackendCapabilities,
  fetchBackendReadiness,
  fetchModelConfigs,
  fetchProjectContext,
  fetchRuntimeToolInventory,
  fetchSkills,
  isBushServerHttpError,
  isRuntimeWorkspaceSnapshotUnavailableError,
  revertSessionWorkspaceChanges,
  saveModelConfigs,
  saveProjectContext,
  streamShadowConversationMessage,
  type SessionShareLinkResult,
  type ShadowConversationRecord,
  type ExperimentalGoal,
} from './backend/api';
import { standardImageInputToolDefaultName } from './backend/toolVisibility';
import {
  normalizeChatMessagesForDisplay,
  normalizeActiveTurnTranscriptForDisplay,
  useCardbushChat,
  type QueuedChatMessage,
} from './hooks/useCardbushChat';
import { useSoftPanelPresence } from './hooks/useSoftPanelPresence';
import { BotPlatformIcon } from './components/BotPlatformIcon';
import { SidebarResizer } from './components/SidebarResizer';
import { RightInspectorResizer } from './components/RightInspectorResizer';
import {
  MessageListFooter,
  absoluteBottomScrollTop,
  isMessageTailVisible,
  lastAssistantMessage,
  manualScrollDetachHoldMs,
  scrollBottomLockTolerance,
  scrollBottomWheelFreezeMs,
  scrollBottomWheelLockTolerance,
  streamingAssistantMessage,
  visualBottomScrollTop,
  type ScrollBottomMetrics,
} from './features/chatScroll';
import { sectionLabels } from './features/appSections';
import {
  MessageBubble,
  MessageFileReferenceScope,
} from './features/chatMessages';
import { QuickContextRail } from './features/chat/QuickContextRail';
import { ConversationWorkSummary } from './features/chat/ConversationWorkSummary';
import { WorkSummaryInspector } from './features/chat/WorkSummaryInspector';
import {
  ShadowTemporaryChat,
  type ShadowChatEntry,
} from './features/chat/ShadowTemporaryChat';
import {
  isPermissionInteraction,
  permissionQuestion,
  PermissionRequestCard,
} from './features/interactions/PermissionRequestCard';
import {
  ComposerRuntimePreTest,
  isComposerRuntimePreTestEnabled,
} from './features/pre_test/ComposerRuntimePreTest';
import {
  isQuickContextPreTestEnabled,
  QuickContextPreTest,
} from './features/pre_test/QuickContextPreTest';
import {
  isLoopHistoryPreTestEnabled,
  LoopHistoryPreTest,
} from './features/pre_test/LoopHistoryPreTest';
import {
  isRuntimeStreamPreTestEnabled,
  runtimeStreamPreTestMode,
} from './features/pre_test/runtimeStreamPreTestActivation';
import {
  Composer,
  ComposerRuntimeRail,
  quickPayloadText,
  type ThinkingNotice,
  type QuickLoadPayload,
} from './features/composer';
import {
  ConsoleDock,
  type ConsoleMode,
} from './features/console';
import {
  changeRootForConversation,
  conversationProjectDir as conversationProjectRoot,
  conversationWorkspaceRoot,
  isOnlyTalkConversation,
} from './features/conversationWorkspace';
import {
  ChatSidebar,
  ConversationChangeDialog,
  TeamSidebar,
  type ProjectAction,
} from './features/sidebar';
import {
  loadTeamWorkspace,
  useTeamWorkspaceState,
} from './features/team/teamWorkspaceStore';
import {
  COPY_FEEDBACK_EVENT,
  copyText,
} from './features/messageFeedback';
import {
  basename,
  fileUrl,
  isImagePath,
  samePath,
  stripWrappingQuotes,
} from './shared/localPaths';
import {
  changeReportsFromMessages,
  serializeToolChangeReport,
  summarizeChangeReports,
  type ConversationChangeReport,
} from './features/tools';
import { goalToolUpdateFromExecution } from './shared/goalState';
import { CardlingSceneHost } from './features/cardling/CardlingSceneHost';
import {
  OPEN_INSPECTOR_EVENT,
  type InspectorOpenDetail,
} from './features/inspector/inspectorEvents';
import {
  OPEN_WORK_SUMMARY_INSPECTOR_EVENT,
  type WorkSummaryInspectorDetail,
} from './features/subagents/subagentObservabilityEvents';
import {
  OsSystemSurface,
  type OsApplication,
  type OsSystemSurfaceMode,
} from './features/os/OsSystemSurface';
import {
  cardlingSceneKey,
  cardlingSceneRevisionKey,
  latestCardlingSceneFromMessages,
  sceneAutoPlayEnabled,
  type CardlingScene,
} from './features/cardling/scene';
import type {
  AppLanguage,
  AppLanguageMode,
  AppSection,
  AppSettingsState,
  BackendCapabilities,
  ChatMessage,
  CompanionMotionMode,
  CompanionSettings,
  CompanionSize,
  ConversationSummary,
  BotPlatform,
  LightThemeStyle,
  ManagedModelConfig,
  PermissionMode,
  ReasoningLevel,
  ReferencePlanMode,
  RuntimeContextWindowUsage,
  RuntimeConnectionUpdate,
  RuntimeAssetCategory,
  PendingInteraction,
  InteractionQuestion,
  InteractionReplyAnswer,
  ProjectItem,
  SettingsSection,
  SkillSummary,
  SkillDetail,
  TerminalRuntime,
  ThemePreference,
  ThemeMode,
} from './types';
import { SUBAGENT_DISPATCH_EVENT_PROTOCOL } from './types';

let settingsViewModulePromise: Promise<typeof import('./features/SettingsView')> | null = null;

function loadSettingsViewModule() {
  settingsViewModulePromise ??= import('./features/SettingsView');
  return settingsViewModulePromise;
}

const LazySettingsView = lazy(async () => {
  const module = await loadSettingsViewModule();
  return { default: module.SettingsView };
});

const LazyFeatureContentPanel = lazy(async () => {
  const module = await import('./features/panels');
  return { default: module.FeatureContentPanel };
});

const LazyRuntimeStreamPreTest = import.meta.env.DEV
  ? lazy(async () => {
      const module = await import('./features/pre_test/RuntimeStreamPreTest');
      return { default: module.RuntimeStreamPreTest };
    })
  : null;

type AppErrorBoundaryState = {
  message: string;
};

class AppErrorBoundary extends Component<
  { children: ReactNode },
  AppErrorBoundaryState
> {
  state: AppErrorBoundaryState = { message: '' };

  static getDerivedStateFromError(error: unknown): AppErrorBoundaryState {
    return {
      message: error instanceof Error ? error.message : String(error),
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('CardBush render error', error, info);
  }

  render() {
    if (!this.state.message) {
      return this.props.children;
    }
    return (
      <div className="app theme-dark">
        <div className="render-failure-shell">
          <section className="render-failure-card">
            <h1>CardBush 渲染异常</h1>
            <p>{this.state.message}</p>
            <button type="button" onClick={() => window.location.reload()}>
              重新加载
            </button>
          </section>
        </div>
      </div>
    );
  }
}

type WallpaperAccent = {
  r: number;
  g: number;
  b: number;
  hex: string;
  source: 'wallpaper' | 'fallback';
};

type BotShareTarget = {
  title: { zh: string; en: string };
  subtitle: { zh: string; en: string };
  platform?: BotPlatform;
  icon: ReactNode;
};

type SessionShareLinkRequest = {
  sessionId: string;
  platform?: string;
  expiresSeconds?: number;
};

type RefreshActiveSession = (options?: { silent?: boolean }) => Promise<void>;

const defaultSidebarWidth = 272;
const minSidebarWidth = 220;
const maxSidebarWidth = 420;
const osConversationStorageKey = 'cardbush_os_conversation_id';
const recentProjectStorageKey = 'cardbush_recent_project_dir';
const onlyTalkModeStorageKey = 'cardbush_only_talk_mode';
const defaultShadowAccentColor = '#a8d5b5';
const thinkingEventName = 'cardbush:thinking';

function scrollDebug(label: string, data: Record<string, unknown>) {
  if (!import.meta.env.DEV) {
    try {
      if (window.localStorage.getItem('cardbush_scroll_debug') !== 'true') {
        return;
      }
    } catch {
      return;
    }
  }
  const entry = {
    at: new Date().toISOString(),
    label,
    ...data,
  };
  const buffer = window.__cardbushScrollDebug ?? [];
  buffer.push(entry);
  if (buffer.length > 300) {
    buffer.splice(0, buffer.length - 300);
  }
  window.__cardbushScrollDebug = buffer;
  console.debug('[cardbush:scroll]', entry);
  void window.cardbushDesktop
    ?.writeDebugLog?.('scroll', {
      ...entry,
    })
    .catch(() => undefined);
}

function gentleAutoFollowScrollBehavior(): ScrollBehavior {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    ? 'auto'
    : 'smooth';
}

const defaultAppSettings: AppSettingsState = {
  proxy: {
    mode: 'none',
    httpProxy: '',
    httpsProxy: '',
    noProxy: '127.0.0.1,localhost,::1',
  },
  browser: {
    privacyMode: false,
  },
  shadow: {
    accentColor: defaultShadowAccentColor,
  },
  thinking: {
    visible: false,
  },
  guidance: {
    deliveryMode: 'queue',
  },
  terminal: {
    runtime: 'powershell',
  },
  os: {
    launchAtLogin: false,
    startInOsMode: true,
    taskbarPlacement: 'bottom',
    backgroundContrast: 30,
    gamepad: {
      confirmButton: 0,
      backButton: 1,
      keyboardButton: 3,
      appsButton: 2,
      settingsButton: 9,
    },
  },
  backendAuth: {
    bearerToken: '',
    localRequestKey: '',
  },
  managedModelConfigs: [],
  backgroundImagePath: '',
  companionEnabled: true,
  companion: {
    size: 'normal',
    opacity: 0.95,
    motion: 'full',
  },
  font: {
    family: '',
    displayName: '',
    filePath: '',
  },
  user: {
    name: '访客',
    membership: 'Free',
    avatarEmoji: '🍃',
    avatarImagePath: '',
  },
};

const botShareTargets: BotShareTarget[] = [
  {
    title: { zh: '任意 Bot', en: 'Any Bot' },
    subtitle: {
      zh: '微信 / 飞书 / Discord / Telegram',
      en: 'WeChat / Feishu / Discord / Telegram',
    },
    icon: <BotPlatformIcon platform="any" />,
  },
  {
    title: { zh: '微信', en: 'WeChat' },
    subtitle: { zh: '仅微信可使用此绑定码', en: 'Limit this code to WeChat' },
    platform: 'weixin',
    icon: <BotPlatformIcon platform="weixin" />,
  },
  {
    title: { zh: '飞书', en: 'Feishu' },
    subtitle: { zh: '仅飞书可使用此绑定码', en: 'Limit this code to Feishu' },
    platform: 'feishu',
    icon: <BotPlatformIcon platform="feishu" />,
  },
  {
    title: { zh: 'Discord', en: 'Discord' },
    subtitle: { zh: '仅 Discord 可使用此绑定码', en: 'Limit this code to Discord' },
    platform: 'discord',
    icon: <BotPlatformIcon platform="discord" />,
  },
  {
    title: { zh: 'Telegram', en: 'Telegram' },
    subtitle: { zh: '仅 Telegram 可使用此绑定码', en: 'Limit this code to Telegram' },
    platform: 'telegram',
    icon: <BotPlatformIcon platform="telegram" />,
  },
];

export function App() {
  return (
    <AppErrorBoundary>
      <CardbushApp />
    </AppErrorBoundary>
  );
}

function CardbushApp() {
  const [themePreference, setThemePreferenceState] =
    useState<ThemePreference>(() => readInitialThemePreference());
  const [lightThemeStyle, setLightThemeStyleState] =
    useState<LightThemeStyle>(() => readInitialLightThemeStyle());
  const [systemDark, setSystemDark] = useState(() => systemPrefersDark());
  const [languageMode, setLanguageModeState] = useState<AppLanguageMode>(() =>
    readInitialLanguageMode(),
  );
  const [systemLanguage, setSystemLanguage] = useState<AppLanguage>(() =>
    readSystemLanguage(),
  );
  const [appSettings, setAppSettings] = useState<AppSettingsState>(() =>
    readInitialAppSettings(),
  );
  const [section, setSection] = useState<AppSection>('chat');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [sidebarWidth, setSidebarWidthState] = useState(() =>
    readInitialSidebarWidth(),
  );
  const [sidebarPreviewWidth, setSidebarPreviewWidth] = useState<number | null>(null);
  const [windowMaximized, setWindowMaximized] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsMounted, setSettingsMounted] = useState(false);
  const [settingsReady, setSettingsReady] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] =
    useState<SettingsSection>('profile');
  const [projectItems, setProjectItems] = useState<ProjectItem[]>(readProjectItems);
  const [recentProjectDir, setRecentProjectDir] = useState(
    () => window.localStorage.getItem(recentProjectStorageKey)?.trim() ?? '',
  );
  const [onlyTalkMode, setOnlyTalkMode] = useState(
    () => window.localStorage.getItem(onlyTalkModeStorageKey) === 'true',
  );
  const onlyTalkModeSyncedRef = useRef(false);
  const [wallpaperAccent, setWallpaperAccent] = useState<WallpaperAccent | null>(null);
  const [osWallpaperSource, setOsWallpaperSource] = useState('');
  const [draftsByConversation, setDraftsByConversation] = useState<Record<string, string>>({});
  const [projectContexts, setProjectContexts] = useState<Record<string, string>>(
    readProjectContexts,
  );
  const [disabledSkillNames, setDisabledSkillNames] = useState<Set<string>>(
    readDisabledSkillNames,
  );
  const [disabledToolNames, setDisabledToolNames] = useState<Set<string>>(
    readDisabledToolNames,
  );
  const [protectedCoreToolNames, setProtectedCoreToolNames] = useState<Set<string>>(
    () => new Set(),
  );
  const [visualInputEnabledSetting, setVisualInputEnabledSetting] = useState(
    readVisualInputEnabled,
  );

  useEffect(() => {
    let active = true;
    const refresh = () => {
      void window.cardbushDesktop?.isMaximized?.().then((value) => {
        if (active) setWindowMaximized(Boolean(value));
      }).catch(() => undefined);
    };
    refresh();
    window.addEventListener('resize', refresh);
    return () => {
      active = false;
      window.removeEventListener('resize', refresh);
    };
  }, []);
  const [thinkingNotice, setThinkingNotice] = useState<ThinkingNotice | null>(null);
  const activeConversationForThinkingRef = useRef('');
  const reasoningTraceVisibleRef = useRef(false);
  const [backendCapabilities, setBackendCapabilities] =
    useState<BackendCapabilities>(defaultBackendCapabilities);
  const [modelConfigSyncReady, setModelConfigSyncReady] = useState(false);
  const [backendDefaultModelName, setBackendDefaultModelName] = useState('');
  const lastSavedModelConfigSignatureRef = useRef('');
  const osStartupHandledRef = useRef(false);
  const conversationBeforeOsRef = useRef('');
  const permissionBeforeOsRef = useRef<PermissionMode>('task_free');
  const reasoningBeforeOsRef = useRef<ReasoningLevel>('medium');
  const projectItemsRef = useRef(projectItems);
  const theme = resolveTheme(themePreference, lightThemeStyle, systemDark);
  const language = resolveAppLanguage(languageMode, systemLanguage);
  const customBackgroundImagePath = appSettings.backgroundImagePath.trim();
  const customBackgroundSource = customBackgroundImagePath
    ? backgroundImageUrl(customBackgroundImagePath)
    : '';

  const applyThemeBackground = useCallback(() => {
    applyDocumentBackdrop(theme, customBackgroundSource);
  }, [customBackgroundSource, theme]);

  useEffect(() => {
    applyThemeBackground();
    void window.cardbushDesktop?.setWindowTheme?.(theme).catch(() => undefined);
  }, [applyThemeBackground, theme]);

  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  }, [language]);

  useEffect(() => {
    const receiveThinking = (event: Event) => {
      if (!(event instanceof CustomEvent) || !event.detail || typeof event.detail !== 'object') {
        return;
      }
      const detail = event.detail as Record<string, unknown>;
      const sessionId = String(detail.sessionId ?? detail.session_id ?? '').trim();
      if (
        sessionId &&
        activeConversationForThinkingRef.current &&
        sessionId !== activeConversationForThinkingRef.current
      ) {
        return;
      }
      const turnId = String(detail.turnId ?? detail.turn_id ?? detail.id ?? '').trim();
      const channel = String(detail.channel ?? 'reasoning').trim().toLowerCase();
      if (channel !== 'reasoning') return;
      const generationId = String(
        detail.generationId ?? detail.generation_id ?? detail.id ?? turnId,
      ).trim();
      const phase = String(detail.phase ?? 'delta');
      if (phase === 'start') {
        setThinkingNotice(null);
        return;
      }
      if (phase === 'end') {
        setThinkingNotice((current) => {
          if (!current) return null;
          if (generationId && current.id === generationId) return null;
          if (!detail.generationId && !detail.generation_id && turnId && current.turnId === turnId) {
            return null;
          }
          return current;
        });
        return;
      }
      if (!reasoningTraceVisibleRef.current) return;
      const delta = String(detail.delta ?? '');
      if (!delta || !turnId || !generationId) return;
      setThinkingNotice((current) => {
        const nextContent = current?.id === generationId
          ? `${current.content}${delta}`
          : delta;
        return {
          id: generationId,
          turnId,
          preview: nextContent.replace(/\s+/g, ' ').trim(),
          content: nextContent,
          createdAt: String(detail.createdAt ?? new Date().toISOString()),
        };
      });
    };
    window.addEventListener(thinkingEventName, receiveThinking);
    return () => window.removeEventListener(thinkingEventName, receiveThinking);
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchBackendCapabilities()
      .then((capabilities) => {
        if (!cancelled) {
          setBackendCapabilities(capabilities);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBackendCapabilities(defaultBackendCapabilities);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadModelConfigs() {
      try {
        const remote = await fetchModelConfigs();
        if (cancelled) {
          return;
        }
        if (remote.models.length > 0) {
          const normalized = normalizeManagedModelConfigs(remote.models);
          const defaultConfig =
            normalized.find((item) => item.id === remote.defaultModelId) ??
            normalized[0];
          lastSavedModelConfigSignatureRef.current = modelConfigSignature(
            normalized,
            defaultConfig?.id ?? '',
          );
          setAppSettings((current) => {
            const next = normalizeAppSettings({
              ...current,
              managedModelConfigs: normalized,
            });
            persistAppSettings(next);
            return next;
          });
          setBackendDefaultModelName(defaultConfig?.id ?? '');
          return;
        }
        const legacy = normalizeManagedModelConfigs(readManagedModelConfigs());
        if (legacy.length > 0) {
          const defaultId = defaultModelConfigId(
            legacy,
            window.localStorage.getItem('cardbush.selected_model') ?? '',
          );
          const saved = await saveModelConfigs({
            defaultModelId: defaultId,
            models: legacy,
          });
          if (cancelled) {
            return;
          }
          const normalized = normalizeManagedModelConfigs(saved.models);
          const savedDefault =
            normalized.find((item) => item.id === saved.defaultModelId) ??
            normalized.find((item) => item.id === defaultId) ??
            normalized[0];
          lastSavedModelConfigSignatureRef.current = modelConfigSignature(
            normalized,
            savedDefault?.id ?? '',
          );
          setAppSettings((current) => {
            const next = normalizeAppSettings({
              ...current,
              managedModelConfigs: normalized,
            });
            persistAppSettings(next);
            return next;
          });
          setBackendDefaultModelName(savedDefault?.id ?? '');
        }
      } catch {
        lastSavedModelConfigSignatureRef.current = '';
      } finally {
        if (!cancelled) {
          setModelConfigSyncReady(true);
        }
      }
    }
    void loadModelConfigs();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const refreshBackground = () => applyThemeBackground();
    const refreshVisibleBackground = () => {
      if (document.visibilityState === 'visible') {
        applyThemeBackground();
      }
    };
    window.addEventListener('focus', refreshBackground);
    window.addEventListener('pageshow', refreshBackground);
    document.addEventListener('visibilitychange', refreshVisibleBackground);
    return () => {
      window.removeEventListener('focus', refreshBackground);
      window.removeEventListener('pageshow', refreshBackground);
      document.removeEventListener('visibilitychange', refreshVisibleBackground);
    };
  }, [applyThemeBackground]);

  const availableModels = useMemo(
    () => effectiveModels(appSettings.managedModelConfigs),
    [appSettings.managedModelConfigs],
  );
  const standardImageInputToolName =
    backendCapabilities.standardImageInputToolName.trim() ||
    standardImageInputToolDefaultName;
  const visualInputAvailable = backendCapabilities.standardImageInputTool;
  const visualInputEnabled = visualInputAvailable && visualInputEnabledSetting;
  const browserPrivacyModeEnabled =
    backendCapabilities.browserPrivacyMode && appSettings.browser.privacyMode;
  const reasoningTraceVisible =
    backendCapabilities.reasoningStream && appSettings.thinking.visible;
  const effectiveDisabledToolNames = useMemo(
    () =>
      new Set(
        [...disabledToolNames].filter(
          (toolName) =>
            toolName.trim() !== standardImageInputToolName
            && !protectedCoreToolNames.has(toolName),
        ),
      ),
    [disabledToolNames, protectedCoreToolNames, standardImageInputToolName],
  );
  useEffect(() => {
    let active = true;
    void fetchRuntimeToolInventory()
      .then((inventory) => {
        if (!active) return;
        const protectedNames = new Set(
          inventory.installed
            .filter((tool) => tool.injection.core)
            .map((tool) => tool.name),
        );
        setProtectedCoreToolNames(protectedNames);
        setDisabledToolNames((current) => {
          const next = new Set([...current].filter((name) => !protectedNames.has(name)));
          if (next.size !== current.size) persistDisabledToolNames(next);
          return next;
        });
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);
  const fallbackProjectDir = useMemo(() => {
    const available = projectItems.filter((project) => !project.archived);
    return (
      available.find((project) => samePath(project.rootPath, recentProjectDir))?.rootPath.trim() ||
      available[0]?.rootPath.trim() ||
      ''
    );
  }, [projectItems, recentProjectDir]);
  const teamWorkspace = useTeamWorkspaceState();
  useEffect(() => {
    void loadTeamWorkspace().catch(() => undefined);
  }, []);
  const chat = useCardbushChat(appSettings.managedModelConfigs, availableModels, {
    language,
    projectContexts,
    disabledSkillNames,
    disabledToolNames: effectiveDisabledToolNames,
    standardImageInputEnabled: visualInputEnabled,
    browserPrivacyMode: browserPrivacyModeEnabled,
    selectedTeamId: teamWorkspace.selectedTeamId,
    selectedTeamName: teamWorkspace.teams.find((team) => team.id === teamWorkspace.selectedTeamId)?.name,
    osModeEnabled: section === 'os',
    terminalRuntime: appSettings.terminal.runtime,
    reasoningTraceVisible,
    interactiveRequestsAvailable: backendCapabilities.interactiveRequests,
    reasoningLevelSelection: backendCapabilities.reasoningLevelSelection,
    reasoningLevels: backendCapabilities.reasoningLevels,
    defaultReasoningLevel: backendCapabilities.defaultReasoningLevel,
    contextWindowUsageAvailable: backendCapabilities.contextWindowUsage,
    workspaceChangesAvailable: backendCapabilities.workspaceChanges,
    defaultProjectDir: onlyTalkMode ? '' : fallbackProjectDir,
  });
  const refreshBackendAndActiveSession = useCallback(
    async (options?: { silent?: boolean }) => {
      let capabilityError: unknown = null;
      try {
        const capabilities = await fetchBackendCapabilities();
        setBackendCapabilities(capabilities);
      } catch (caught) {
        capabilityError = caught;
        setBackendCapabilities(defaultBackendCapabilities);
      }

      await chat.refreshActiveSession(options);

      if (capabilityError) {
        throw capabilityError;
      }
    },
    [chat.refreshActiveSession],
  );
  const runningConversationIds = useMemo(
    () => new Set(Object.keys(chat.runningByConversation)),
    [chat.runningByConversation],
  );
  const reloadRuntimeAssetConfiguration = useCallback(async (
    categories: RuntimeAssetCategory[],
  ) => {
    const readiness = await fetchBackendReadiness();
    if (String(readiness.status ?? '').trim().toLowerCase() !== 'ready') {
      throw new Error(
        language === 'zh'
          ? 'BushServer 尚未就绪，请完成重启后再验证。'
          : 'BushServer is not ready. Finish restarting it before verification.',
      );
    }
    const [capabilities, inventory] = await Promise.all([
      fetchBackendCapabilities(),
      fetchRuntimeToolInventory(),
      fetchSkills(),
    ]);
    setBackendCapabilities(capabilities);
    if (categories.includes('skills')) {
      const next = new Set<string>();
      setDisabledSkillNames(next);
      persistDisabledSkillNames(next);
    }
    if (categories.includes('tools')) {
      const protectedNames = new Set(
        inventory.installed
          .filter((tool) => tool.injection.core)
          .map((tool) => tool.name),
      );
      const next = new Set<string>();
      setProtectedCoreToolNames(protectedNames);
      setDisabledToolNames(next);
      persistDisabledToolNames(next);
    }
  }, [language]);

  useEffect(() => {
    activeConversationForThinkingRef.current = chat.activeConversationId;
    setThinkingNotice(null);
  }, [chat.activeConversationId]);

  useEffect(() => {
    reasoningTraceVisibleRef.current = reasoningTraceVisible;
    if (!reasoningTraceVisible) {
      setThinkingNotice(null);
    }
  }, [reasoningTraceVisible]);

  useEffect(() => {
    if (!chat.sending) {
      setThinkingNotice(null);
    }
  }, [chat.sending]);

  useEffect(() => {
    const defaultSelection = backendDefaultModelName.trim();
    if (!defaultSelection) {
      return;
    }
    const defaultConfig = appSettings.managedModelConfigs.find(
      (config) =>
        config.id === defaultSelection ||
        config.modelName.trim().toLowerCase() === defaultSelection.toLowerCase(),
    );
    if (defaultConfig && chat.selectedModel !== defaultConfig.id) {
      chat.setSelectedModel(defaultConfig.id);
    }
    setBackendDefaultModelName('');
  }, [appSettings.managedModelConfigs, backendDefaultModelName, chat]);

  useEffect(() => {
    if (!modelConfigSyncReady || backendDefaultModelName.trim()) {
      return;
    }
    const defaultId = defaultModelConfigId(
      appSettings.managedModelConfigs,
      chat.selectedModel,
    );
    const signature = modelConfigSignature(
      appSettings.managedModelConfigs,
      defaultId,
    );
    if (signature === lastSavedModelConfigSignatureRef.current) {
      return;
    }
    lastSavedModelConfigSignatureRef.current = signature;
    void saveModelConfigs({
      defaultModelId: defaultId,
      models: appSettings.managedModelConfigs,
    }).then((saved) => {
      const sanitized = normalizeManagedModelConfigs(saved.models);
      const savedDefaultId = defaultModelConfigId(sanitized, saved.defaultModelId || defaultId);
      lastSavedModelConfigSignatureRef.current = modelConfigSignature(
        sanitized,
        savedDefaultId,
      );
      setAppSettings((current) => {
        if (modelConfigSignature(current.managedModelConfigs, defaultId) !== signature) {
          return current;
        }
        const next = normalizeAppSettings({
          ...current,
          managedModelConfigs: sanitized,
        });
        persistAppSettings(next);
        return next;
      });
    }).catch(() => {
      lastSavedModelConfigSignatureRef.current = '';
    });
  }, [
    appSettings.managedModelConfigs,
    backendDefaultModelName,
    chat.selectedModel,
    modelConfigSyncReady,
  ]);

  const activeConversationProjectDir = conversationProjectRoot(chat.activeConversation);
  const conversationProjectDir = conversationWorkspaceRoot(chat.activeConversation);
  const activeProjectDir =
    conversationProjectDir ||
    (!chat.activeConversation ? fallbackProjectDir || undefined : undefined);

  const rememberRecentProject = useCallback((projectDir: string) => {
    const normalized = projectDir.trim();
    if (!normalized) return;
    setRecentProjectDir(normalized);
    window.localStorage.setItem(recentProjectStorageKey, normalized);
  }, []);

  useEffect(() => {
    if (activeConversationProjectDir) rememberRecentProject(activeConversationProjectDir);
  }, [activeConversationProjectDir, rememberRecentProject]);
  const activeDraftKey = chat.activeConversationId.trim() || '__new__';
  const activeDraft = draftsByConversation[activeDraftKey] ?? '';
  const setActiveDraft = useCallback(
    (value: string) => {
      setDraftsByConversation((current) => ({
        ...current,
        [activeDraftKey]: value,
      }));
    },
    [activeDraftKey],
  );
  const [changeReviewConversationId, setChangeReviewConversationId] = useState('');
  const [changeReviewFilePath, setChangeReviewFilePath] = useState('');
  const [revertingChangeId, setRevertingChangeId] = useState('');
  const [changeReviewNotice, setChangeReviewNotice] = useState('');
  const [revertedChangeKeys, setRevertedChangeKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [inspectorTarget, setInspectorTarget] = useState<InspectorOpenDetail | null>(null);
  const [workSummaryInspector, setWorkSummaryInspector] =
    useState<WorkSummaryInspectorDetail | null>(null);
  const [inspectorSummaryOpen, setInspectorSummaryOpen] = useState(false);
  const [inspectorWidth, setInspectorWidthState] = useState(() => {
    const stored = Number.parseFloat(window.localStorage.getItem('cardbush.inspector_width') ?? '');
    return Number.isFinite(stored) ? Math.min(900, Math.max(380, stored)) : 620;
  });
  const inspectorWidthRef = useRef(inspectorWidth);
  const setInspectorWidth = useCallback((width: number) => {
    const next = Math.min(900, Math.max(380, Math.round(width)));
    inspectorWidthRef.current = next;
    setInspectorWidthState(next);
    window.localStorage.setItem('cardbush.inspector_width', String(next));
  }, []);
  const changeReportsByConversation = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(chat.messagesByConversation)
          .map(([conversationId, messages]) => [
            conversationId,
            changeReportsFromMessages(
              normalizeChatMessagesForDisplay(messages),
            ),
          ] as const)
          .filter(([, reports]) => reports.length > 0),
      ) as Record<string, ConversationChangeReport[]>,
    [chat.messagesByConversation],
  );
  const changeReviewReports = useMemo(
    () => changeReviewConversationId
      ? changeReportsByConversation[changeReviewConversationId] ?? []
      : [],
    [changeReportsByConversation, changeReviewConversationId],
  );
  const changeReviewConversation = useMemo(() => {
    if (!changeReviewConversationId) return null;
    const listed = chat.conversations.find(
      (item) => item.id === changeReviewConversationId,
    );
    if (listed) return listed;
    const active = chat.activeConversation;
    if (active?.id === changeReviewConversationId) return active;
    if (changeReviewReports.length === 0) return null;
    return {
      id: changeReviewConversationId,
      title: language === 'zh' ? '当前会话修改' : 'Current conversation changes',
      preview: '',
      updatedAt: new Date().toISOString(),
    };
  }, [
    changeReviewConversationId,
    changeReviewReports.length,
    chat.activeConversation,
    chat.conversations,
    language,
  ]);
  const inspectorOpen = Boolean(
    (changeReviewConversation && changeReviewReports.length > 0) ||
      inspectorTarget ||
      workSummaryInspector,
  );
  const [retainedInspectorContent, setRetainedInspectorContent] = useState<{
    target: InspectorOpenDetail | null;
    workSummary: WorkSummaryInspectorDetail | null;
    conversation: ConversationSummary | null;
    reports: ConversationChangeReport[];
  }>({ target: null, workSummary: null, conversation: null, reports: [] });
  useEffect(() => {
    if (!inspectorOpen) return;
    setRetainedInspectorContent({
      target: inspectorTarget,
      workSummary: workSummaryInspector,
      conversation: changeReviewConversation,
      reports: changeReviewReports,
    });
  }, [
    changeReviewConversation,
    changeReviewReports,
    inspectorOpen,
    inspectorTarget,
    workSummaryInspector,
  ]);
  const displayedInspectorTarget = inspectorTarget ?? (
    changeReviewConversation || workSummaryInspector
      ? null
      : retainedInspectorContent.target
  );
  const displayedReviewConversation = changeReviewConversation ?? (
    inspectorTarget || workSummaryInspector
      ? null
      : retainedInspectorContent.conversation
  );
  const displayedReviewReports = changeReviewConversation
    ? changeReviewReports
    : retainedInspectorContent.reports;
  const displayedWorkSummaryInspector = workSummaryInspector ?? (
    changeReviewConversation || inspectorTarget
      ? null
      : retainedInspectorContent.workSummary
  );
  const sidebarPresence = useSoftPanelPresence(
    section !== 'os' && !sidebarCollapsed,
  );
  const inspectorPresence = useSoftPanelPresence(inspectorOpen);

  useEffect(() => {
    let previousLeft = window.screenX;
    let previousOuterWidth = window.outerWidth;
    let previousInnerWidth = window.innerWidth;
    let pendingWidthDelta = 0;
    let animationFrame = 0;
    let resizeSettleTimer = 0;

    const resizeInspectorFromWindowRightEdge = () => {
      const nextLeft = window.screenX;
      const nextOuterWidth = window.outerWidth;
      const nextInnerWidth = window.innerWidth;
      const innerWidthDelta = nextInnerWidth - previousInnerWidth;
      const rightEdgeDelta = nextLeft + nextOuterWidth - (
        previousLeft + previousOuterWidth
      );
      const leftEdgeStayedPut = Math.abs(nextLeft - previousLeft) <= 2;

      previousLeft = nextLeft;
      previousOuterWidth = nextOuterWidth;
      previousInnerWidth = nextInnerWidth;

      if (
        !inspectorOpen ||
        innerWidthDelta === 0 ||
        !leftEdgeStayedPut ||
        Math.sign(innerWidthDelta) !== Math.sign(rightEdgeDelta)
      ) {
        return;
      }

      document.body.classList.add('window-right-edge-resizing');
      if (resizeSettleTimer) window.clearTimeout(resizeSettleTimer);
      resizeSettleTimer = window.setTimeout(() => {
        resizeSettleTimer = 0;
        document.body.classList.remove('window-right-edge-resizing');
      }, 140);
      pendingWidthDelta += innerWidthDelta;
      if (animationFrame) return;
      animationFrame = window.requestAnimationFrame(() => {
        animationFrame = 0;
        const widthDelta = pendingWidthDelta;
        pendingWidthDelta = 0;
        if (widthDelta !== 0) {
          setInspectorWidth(inspectorWidthRef.current + widthDelta);
        }
      });
    };

    window.addEventListener('resize', resizeInspectorFromWindowRightEdge);
    return () => {
      window.removeEventListener('resize', resizeInspectorFromWindowRightEdge);
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
      if (resizeSettleTimer) window.clearTimeout(resizeSettleTimer);
      document.body.classList.remove('window-right-edge-resizing');
    };
  }, [inspectorOpen, setInspectorWidth]);

  useEffect(() => {
    const handleOpenInspector = (event: Event) => {
      const detail = (event as CustomEvent<InspectorOpenDetail>).detail;
      if (!detail?.target?.trim()) return;
      setInspectorTarget(detail);
      setWorkSummaryInspector(null);
      setChangeReviewConversationId('');
      setInspectorSummaryOpen(false);
    };
    window.addEventListener(OPEN_INSPECTOR_EVENT, handleOpenInspector);
    const removeDesktopListener = window.cardbushDesktop?.onOpenInspectorRequest?.((detail) => {
      if (!detail?.target?.trim()) return;
      setInspectorTarget(detail);
      setWorkSummaryInspector(null);
      setChangeReviewConversationId('');
      setInspectorSummaryOpen(false);
    });
    return () => {
      window.removeEventListener(OPEN_INSPECTOR_EVENT, handleOpenInspector);
      removeDesktopListener?.();
    };
  }, []);

  useEffect(() => {
    const handleOpenWorkSummaryInspector = (event: Event) => {
      const detail = (event as CustomEvent<WorkSummaryInspectorDetail>).detail;
      if (!detail?.sessionId?.trim()) return;
      setWorkSummaryInspector(detail);
      setInspectorTarget(null);
      setChangeReviewConversationId('');
      setInspectorSummaryOpen(false);
    };
    window.addEventListener(
      OPEN_WORK_SUMMARY_INSPECTOR_EVENT,
      handleOpenWorkSummaryInspector,
    );
    return () => window.removeEventListener(
      OPEN_WORK_SUMMARY_INSPECTOR_EVENT,
      handleOpenWorkSummaryInspector,
    );
  }, []);

  useEffect(() => {
    void window.cardbushDesktop?.setCardlingState?.({
      enabled: false,
      language: 'zh',
      theme: 'dark',
      settings: {
        size: 'normal',
        opacity: 0.95,
        motion: 'off',
      },
      status: 'idle',
      sending: false,
      queuedMessageCount: 0,
      pendingInteraction: false,
      activeChangeCount: 0,
      activeChangeFileCount: 0,
      error: null,
      miniChat: {
        title: '',
        lastUser: '',
        lastAssistant: '',
      },
    }).catch(() => undefined);
  }, []);

  const setThemePreference = (value: ThemePreference) => {
    setThemePreferenceState(value);
    window.localStorage.setItem('cardbush_theme_mode', value);
  };

  const setLightThemeStyle = (value: LightThemeStyle) => {
    setLightThemeStyleState(value);
    window.localStorage.setItem('cardbush_light_theme_style', value);
  };

  const setLanguageMode = (value: AppLanguageMode) => {
    setLanguageModeState(value);
    window.localStorage.setItem('cardbush_language_mode', value);
  };

  const setSidebarWidth = useCallback((value: number) => {
    const next = clampSidebarWidth(value);
    setSidebarWidthState(next);
    window.localStorage.setItem('cardbush.sidebar_width', String(next));
  }, []);

  const updateAppSettings = useCallback(
    (updater: (current: AppSettingsState) => AppSettingsState) => {
      setAppSettings((current) => {
        const next = normalizeAppSettings(updater(current));
        persistAppSettings(next);
        return next;
      });
    },
    [],
  );

  useEffect(() => {
    void window.cardbushDesktop
      ?.setOsLoginSettings?.({
        enabled: appSettings.os.launchAtLogin,
        startInOsMode: appSettings.os.startInOsMode,
      })
      .catch(() => undefined);
  }, [appSettings.os.launchAtLogin, appSettings.os.startInOsMode]);

  useEffect(() => {
    if (
      !backendCapabilities.terminalRuntimeSelection ||
      backendCapabilities.terminalRuntimes.includes(appSettings.terminal.runtime)
    ) {
      return;
    }
    updateAppSettings((current) => ({
      ...current,
      terminal: {
        ...current.terminal,
        runtime: backendCapabilities.defaultTerminalRuntime,
      },
    }));
  }, [
    appSettings.terminal.runtime,
    backendCapabilities.defaultTerminalRuntime,
    backendCapabilities.terminalRuntimeSelection,
    backendCapabilities.terminalRuntimes,
    updateAppSettings,
  ]);

  useEffect(() => {
    const darkQuery = window.matchMedia?.('(prefers-color-scheme: dark)');
    const syncDark = () => setSystemDark(systemPrefersDark());
    const syncLanguage = () => setSystemLanguage(readSystemLanguage());
    darkQuery?.addEventListener('change', syncDark);
    window.addEventListener('languagechange', syncLanguage);
    return () => {
      darkQuery?.removeEventListener('change', syncDark);
      window.removeEventListener('languagechange', syncLanguage);
    };
  }, []);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void window.cardbushDesktop?.rendererReady?.().catch(() => undefined);
    });
    return () => window.cancelAnimationFrame(frame);
  }, []);

  useEffect(() => {
    projectItemsRef.current = projectItems;
    persistProjectItems(projectItems);
  }, [projectItems]);

  useEffect(() => {
    let disposed = false;

    const validateProjects = async () => {
      const validateProjectRoots = window.cardbushDesktop?.validateProjectRoots;
      const snapshot = projectItemsRef.current;
      if (!validateProjectRoots || snapshot.length === 0) {
        return;
      }

      try {
        const statuses = await validateProjectRoots(snapshot.map((project) => project.rootPath));
        if (disposed) {
          return;
        }
        const missingRoots = statuses
          .filter((status) => !status.exists)
          .map((status) => status.rootPath);
        if (missingRoots.length === 0) {
          return;
        }
        setProjectItems((current) => {
          const next = current.filter(
            (project) =>
              !missingRoots.some((rootPath) => samePath(rootPath, project.rootPath)),
          );
          return next.length === current.length ? current : next;
        });
      } catch {
        // Keep saved projects when the desktop bridge is temporarily unavailable.
      }
    };

    const validateVisibleProjects = () => {
      if (document.visibilityState === 'visible') {
        void validateProjects();
      }
    };

    void validateProjects();
    window.addEventListener('focus', validateVisibleProjects);
    window.addEventListener('pageshow', validateVisibleProjects);
    document.addEventListener('visibilitychange', validateVisibleProjects);
    return () => {
      disposed = true;
      window.removeEventListener('focus', validateVisibleProjects);
      window.removeEventListener('pageshow', validateVisibleProjects);
      document.removeEventListener('visibilitychange', validateVisibleProjects);
    };
  }, []);

  useEffect(() => {
    const font = appSettings.font;
    const id = 'cardbush-imported-font';
    document.getElementById(id)?.remove();
    if (!font.family.trim() || !font.filePath.trim()) {
      return;
    }
    const style = document.createElement('style');
    style.id = id;
    style.textContent = `@font-face { font-family: "${cssEscape(font.family)}"; src: url("${fileUrl(font.filePath)}"); }`;
    document.head.appendChild(style);
    return () => style.remove();
  }, [appSettings.font]);

  useEffect(() => {
    void window.cardbushDesktop?.setProxy?.(appSettings.proxy).catch(() => undefined);
  }, [appSettings.proxy]);

  const appFontStyle = appSettings.font.family.trim()
    ? ({ fontFamily: `"${appSettings.font.family}", var(--app-font-family)` } as CSSProperties)
    : undefined;

  useEffect(() => {
    let cancelled = false;
    if (!customBackgroundImagePath || !window.cardbushDesktop?.cacheBackgroundImage) {
      return () => {
        cancelled = true;
      };
    }
    void window.cardbushDesktop
      .cacheBackgroundImage(customBackgroundImagePath)
      .then((cachedPath) => {
        if (cancelled || !cachedPath || cachedPath === customBackgroundImagePath) {
          return;
        }
        updateAppSettings((current) =>
          current.backgroundImagePath.trim() === customBackgroundImagePath
            ? { ...current, backgroundImagePath: cachedPath }
            : current,
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [customBackgroundImagePath, updateAppSettings]);

  const mergedAppStyle = wallpaperAccent
    ? ({
        '--wallpaper-accent-rgb': `${wallpaperAccent.r} ${wallpaperAccent.g} ${wallpaperAccent.b}`,
        '--wallpaper-accent-hex': wallpaperAccent.hex,
        '--sidebar-width': `${sidebarPreviewWidth ?? sidebarWidth}px`,
        ...appFontStyle,
      } as CSSProperties)
    : ({
        '--sidebar-width': `${sidebarPreviewWidth ?? sidebarWidth}px`,
        ...appFontStyle,
      } as CSSProperties);

  const appStyle = mergedAppStyle;

  useEffect(() => {
    if (customBackgroundImagePath) {
      setWallpaperAccent(null);
      return undefined;
    }
    let cancelled = false;
    let refreshTimer = 0;
    async function refreshWallpaperAccent() {
      const accent = await window.cardbushDesktop?.wallpaperAccent?.().catch(() => null);
      if (!cancelled && accent) {
        setWallpaperAccent(accent);
      }
    }
    const scheduleRefresh = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        void refreshWallpaperAccent();
      }, 350);
    };
    scheduleRefresh();
    const interval = window.setInterval(scheduleRefresh, 10 * 60 * 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(refreshTimer);
      window.clearInterval(interval);
    };
  }, [customBackgroundImagePath]);

  useEffect(() => {
    if (section !== 'os') {
      return undefined;
    }
    let cancelled = false;
    const refresh = () => {
      const desktop = window.cardbushDesktop;
      void desktop
        ?.wallpaperDataUrl?.()
        .then(async (wallpaperDataUrl) => {
          if (!cancelled) {
            if (wallpaperDataUrl) {
              setOsWallpaperSource(wallpaperDataUrl);
              return;
            }
            const wallpaperPath = await desktop.wallpaperPath();
            if (!cancelled) {
              const normalizedPath = wallpaperPath.trim();
              setOsWallpaperSource(normalizedPath ? fileUrl(normalizedPath) : '');
            }
          }
        })
        .catch(() => {
          if (!cancelled) {
            setOsWallpaperSource('');
          }
        });
    };
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', refresh);
    };
  }, [section]);

  useEffect(() => {
    if (section !== 'os') {
      return;
    }
    chat.setPermissionMode('all_free');
    chat.setReasoningLevel(highestReasoningLevel(backendCapabilities.reasoningLevels));
  }, [backendCapabilities.reasoningLevels, chat.setPermissionMode, chat.setReasoningLevel, section]);

  const createConversation = useCallback(
    (projectDir?: string | null) => {
      const resolvedProjectDir = projectDir === undefined
        ? fallbackProjectDir || undefined
        : projectDir?.trim() || undefined;
      if (resolvedProjectDir) rememberRecentProject(resolvedProjectDir);
      setSection('chat');
      void chat.startConversation(resolvedProjectDir);
    },
    [chat, fallbackProjectDir, rememberRecentProject],
  );

  const changeOnlyTalkMode = useCallback((enabled: boolean) => {
    onlyTalkModeSyncedRef.current = enabled;
    setOnlyTalkMode(enabled);
    window.localStorage.setItem(onlyTalkModeStorageKey, String(enabled));
    setSection('chat');
    if (enabled) {
      const recentTaskConversation = chat.conversations.find(isOnlyTalkConversation);
      if (recentTaskConversation) {
        chat.openConversation(recentTaskConversation.id);
      } else {
        chat.clearConversationSelection();
      }
      return;
    }
    if (!fallbackProjectDir) {
      chat.clearConversationSelection();
      return;
    }
    const recentProjectConversation = chat.conversations.find((conversation) => {
      const projectDir = conversationProjectRoot(conversation);
      return Boolean(projectDir && samePath(projectDir, fallbackProjectDir));
    });
    if (recentProjectConversation) {
      chat.openConversation(recentProjectConversation.id);
    } else {
      chat.clearConversationSelection();
    }
  }, [chat, fallbackProjectDir]);

  useEffect(() => {
    if (!onlyTalkMode) {
      onlyTalkModeSyncedRef.current = false;
      return;
    }
    if (chat.loading || onlyTalkModeSyncedRef.current) return;
    onlyTalkModeSyncedRef.current = true;
    const recentTaskConversation = chat.conversations.find(isOnlyTalkConversation);
    if (recentTaskConversation) {
      chat.openConversation(recentTaskConversation.id);
    } else {
      chat.clearConversationSelection();
    }
  }, [
    chat.clearConversationSelection,
    chat.conversations,
    chat.loading,
    chat.openConversation,
    onlyTalkMode,
  ]);

  const changeWelcomeProject = useCallback(async (projectDir: string | null) => {
    const normalized = projectDir?.trim() || null;
    if (normalized) rememberRecentProject(normalized);
    if (!chat.activeConversationId.trim()) {
      createConversation(normalized);
      return;
    }
    await chat.setConversationProject(chat.activeConversationId, normalized);
  }, [chat, createConversation, rememberRecentProject]);

  const enterOsMode = useCallback(async () => {
    if (section !== 'os') {
      conversationBeforeOsRef.current = chat.activeConversationId;
      permissionBeforeOsRef.current = chat.permissionMode;
      reasoningBeforeOsRef.current = chat.reasoningLevel;
    }
    chat.setPermissionMode('all_free');
    chat.setReasoningLevel(highestReasoningLevel(backendCapabilities.reasoningLevels));
    setSection('os');
    const storedId = window.localStorage.getItem(osConversationStorageKey)?.trim() ?? '';
    if (storedId && chat.conversations.some((item) => item.id === storedId)) {
      chat.openConversation(storedId);
      return storedId;
    }
    const conversation = await chat.startConversation(
      undefined,
      language === 'zh' ? 'OS 会话' : 'OS session',
    );
    window.localStorage.setItem(osConversationStorageKey, conversation.id);
    return conversation.id;
  }, [backendCapabilities.reasoningLevels, chat.activeConversationId, chat.conversations, chat.openConversation, chat.permissionMode, chat.reasoningLevel, chat.setPermissionMode, chat.setReasoningLevel, chat.startConversation, language, section]);

  const exitOsMode = useCallback(() => {
    chat.setPermissionMode(permissionBeforeOsRef.current);
    chat.setReasoningLevel(reasoningBeforeOsRef.current);
    setSection('chat');
    const previousId = conversationBeforeOsRef.current.trim();
    if (previousId && chat.conversations.some((item) => item.id === previousId)) {
      chat.openConversation(previousId);
      return;
    }
    void chat.startConversation();
  }, [chat.conversations, chat.openConversation, chat.setPermissionMode, chat.setReasoningLevel, chat.startConversation]);

  useEffect(() => {
    const enabled = section === 'os';
    void window.cardbushDesktop?.setOsShellMode?.(enabled).catch(() => undefined);
    return () => {
      if (enabled) {
        void window.cardbushDesktop?.setOsShellMode?.(false).catch(() => undefined);
      }
    };
  }, [section]);

  useEffect(() => window.cardbushDesktop?.onOpenSessionAttention?.(({ sessionId }) => {
    const normalized = sessionId.trim();
    if (!normalized) return;
    setSettingsOpen(false);
    setSection('chat');
    chat.openConversation(normalized);
  }), [chat.openConversation]);

  useEffect(() => {
    if (osStartupHandledRef.current) {
      return;
    }
    osStartupHandledRef.current = true;
    void window.cardbushDesktop
      ?.osStartupContext?.()
      .then((context) => {
        if (context.launchedInOsMode) {
          void enterOsMode();
        }
      })
      .catch(() => undefined);
  }, [enterOsMode]);

  const addProject = useCallback(async () => {
    const selected = await window.cardbushDesktop?.pickProjectDirectory?.();
    if (!selected) {
      return;
    }
    const title = basename(selected);
    let branch = '';
    let changedCount = 0;
    try {
      const git = await window.cardbushDesktop?.gitInfo?.(selected);
      branch = git?.branch ?? '';
      changedCount = git?.changedFiles.length ?? 0;
    } catch {
      branch = '';
    }
    setProjectItems((current) => {
      const existing = current.find((item) => samePath(item.rootPath, selected));
      if (existing) {
        return current.map((item) =>
          item.id === existing.id
            ? { ...item, archived: false, branch, changedCount }
            : item,
        );
      }
      return [
        {
          id: `project-${crypto.randomUUID()}`,
          title,
          rootPath: selected,
          branch,
          changedCount,
        },
        ...current,
      ];
    });
  }, []);

  const handleProjectAction = useCallback(
    async (action: ProjectAction, project: ProjectItem) => {
      if (action === 'open') {
        await window.cardbushDesktop?.openPath?.(project.rootPath);
        return;
      }
      if (action === 'newChat') {
        createConversation(project.rootPath);
        return;
      }
      if (action === 'refreshGit') {
        try {
          const git = await window.cardbushDesktop?.gitInfo?.(project.rootPath);
          setProjectItems((current) =>
            current.map((item) =>
              item.id === project.id
                ? {
                    ...item,
                    branch: git?.branch ?? item.branch,
                    changedCount: git?.changedFiles.length ?? 0,
                  }
                : item,
            ),
          );
        } catch {
          setProjectItems((current) =>
            current.map((item) =>
              item.id === project.id ? { ...item, branch: '', changedCount: 0 } : item,
            ),
          );
        }
        return;
      }
      if (action === 'rename') {
        const nextTitle = window.prompt(
          language === 'zh' ? '重命名项目' : 'Rename project',
          project.title,
        );
        if (!nextTitle?.trim()) {
          return;
        }
        setProjectItems((current) =>
          current.map((item) =>
            item.id === project.id ? { ...item, title: nextTitle.trim() } : item,
          ),
        );
        return;
      }
      if (action === 'remove') {
        setProjectItems((current) => current.filter((item) => item.id !== project.id));
        return;
      }
      setProjectItems((current) =>
        current.map((item) => {
          if (item.id !== project.id) {
            return item;
          }
          if (action === 'pin') {
            return { ...item, pinned: !item.pinned };
          }
          if (action === 'archive') {
            return { ...item, archived: !item.archived };
          }
          return item;
        }),
      );
    },
    [createConversation, language],
  );

  const refreshProjectGitStatus = useCallback(async (rootPath: string) => {
    const root = rootPath.trim();
    if (!root || !window.cardbushDesktop?.gitInfo) {
      return;
    }
    try {
      const git = await window.cardbushDesktop.gitInfo(root);
      setProjectItems((current) =>
        current.map((item) =>
          samePath(item.rootPath, root)
            ? {
                ...item,
                branch: git.branch || item.branch,
                changedCount: git.changedFiles.length,
              }
            : item,
        ),
      );
    } catch {
      setProjectItems((current) =>
        current.map((item) =>
          samePath(item.rootPath, root)
            ? { ...item, branch: item.branch ?? '', changedCount: 0 }
            : item,
        ),
      );
    }
  }, []);

  const revertChangeReport = useCallback(
    async (conversationId: string, report: ConversationChangeReport) => {
      const conversation =
        chat.conversations.find((item) => item.id === conversationId) ??
        chat.activeConversation;
      const root =
        changeRootForConversation(conversation) ||
        activeProjectDir?.trim() ||
        '';
      const turnId = report.turnId?.trim() ?? '';
      const usesRecoverySnapshot = Boolean(turnId);
      if (!usesRecoverySnapshot && !root) {
        const message =
          language === 'zh'
            ? '没有可用于撤回的项目路径。'
            : 'No project path is available for revert.';
        setChangeReviewNotice(message);
        window.alert(message);
        return;
      }
      if (!usesRecoverySnapshot && !window.cardbushDesktop?.revertFileChanges) {
        const message =
          language === 'zh'
            ? '当前环境缺少撤回文件修改的桌面接口。'
            : 'The desktop revert API is not available.';
        setChangeReviewNotice(message);
        window.alert(message);
        return;
      }
      const files = serializeToolChangeReport(report);
      if (!usesRecoverySnapshot && files.length === 0) {
        const message =
          language === 'zh'
            ? '这组修改没有可撤回的 diff。'
            : 'This change set has no reversible diff.';
        setChangeReviewNotice(message);
        window.alert(message);
        return;
      }
      const confirmed = window.confirm(
        language === 'zh'
          ? `确定撤回这组修改吗？恢复前会校验文件是否又被改动。`
          : 'Revert this change set? Files will be checked for later edits first.',
      );
      if (!confirmed) {
        return;
      }
      setRevertingChangeId(report.id);
      setChangeReviewNotice('');
      try {
        let result: { revertedFiles: number };
        if (usesRecoverySnapshot) {
          try {
            result = await revertSessionWorkspaceChanges(conversationId, [turnId]);
          } catch (caught) {
            if (
              !snapshotRevertFallbackAllowed(caught) ||
              !root ||
              files.length === 0 ||
              !window.cardbushDesktop?.revertFileChanges
            ) {
              throw caught;
            }
            result = await window.cardbushDesktop.revertFileChanges(root, files);
          }
        } else {
          result = await window.cardbushDesktop!.revertFileChanges(root, files);
        }
        const message =
          language === 'zh'
            ? `已安全恢复 ${result.revertedFiles} 个文件。`
            : `Safely restored ${result.revertedFiles} file(s).`;
        setChangeReviewNotice(message);
        setRevertedChangeKeys((current) => {
          const next = new Set(current);
          next.add(`${conversationId}:${report.id}`);
          return next;
        });
        if (root) {
          await refreshProjectGitStatus(root);
        }
      } catch (caught) {
        const message =
          language === 'zh'
            ? `撤回失败：${workspaceRevertErrorMessage(caught, 'zh')}`
            : `Revert failed: ${workspaceRevertErrorMessage(caught, 'en')}`;
        setChangeReviewNotice(message);
        window.alert(message);
      } finally {
        setRevertingChangeId('');
      }
    },
    [
      activeProjectDir,
      chat.activeConversation,
      chat.conversations,
      language,
      refreshProjectGitStatus,
    ],
  );

  const revertConversationReports = useCallback(
    async (conversationId: string, reports: ConversationChangeReport[]) => {
      const conversation =
        chat.conversations.find((item) => item.id === conversationId) ??
        chat.activeConversation;
      const root =
        changeRootForConversation(conversation) ||
        activeProjectDir?.trim() ||
        '';
      const reversibleReports = reports
        .map((report) => ({ report, files: serializeToolChangeReport(report) }))
        .filter((item) => item.files.length > 0);
      const reportsWithSnapshot = reports.filter((report) => report.turnId?.trim());
      const snapshotTurnIds = Array.from(new Set(
        reportsWithSnapshot.map((report) => report.turnId!.trim()),
      ));
      const usesRecoverySnapshots =
        reports.length > 0 && reportsWithSnapshot.length === reports.length;
      if (
        (!usesRecoverySnapshots && !root) ||
        (!usesRecoverySnapshots && reversibleReports.length === 0)
      ) {
        const message =
          language === 'zh'
            ? '没有可撤回的会话修改。'
            : 'No reversible changes were found for this chat.';
        setChangeReviewNotice(message);
        window.alert(message);
        return;
      }
      if (!usesRecoverySnapshots && !window.cardbushDesktop?.revertFileChanges) {
        const message =
          language === 'zh'
            ? '当前环境缺少撤回文件修改的桌面接口。'
            : 'The desktop revert API is not available.';
        setChangeReviewNotice(message);
        window.alert(message);
        return;
      }
      const fileCount = usesRecoverySnapshots
        ? reports.reduce((sum, report) => sum + report.fileCount, 0)
        : reversibleReports.reduce((sum, item) => sum + item.files.length, 0);
      const confirmed = window.confirm(
        language === 'zh'
          ? `确定撤回这个会话里的全部修改吗？将按时间倒序校验并恢复 ${fileCount} 个文件。`
          : `Revert all changes in this chat? ${fileCount} file(s) will be checked and restored in reverse order.`,
      );
      if (!confirmed) {
        return;
      }
      setRevertingChangeId(`conversation:${conversationId}`);
      setChangeReviewNotice('');
      try {
        let revertedFiles = 0;
        const outputs: string[] = [];
        if (usesRecoverySnapshots) {
          try {
            const result = await revertSessionWorkspaceChanges(
              conversationId,
              [...snapshotTurnIds].reverse(),
            );
            revertedFiles = result.revertedFiles;
          } catch (caught) {
            if (
              !snapshotRevertFallbackAllowed(caught) ||
              !root ||
              reversibleReports.length !== reports.length ||
              !window.cardbushDesktop?.revertFileChanges
            ) {
              throw caught;
            }
            for (const item of [...reversibleReports].reverse()) {
              const result = await window.cardbushDesktop.revertFileChanges(root, item.files);
              revertedFiles += result.revertedFiles;
              if (result.output.trim()) {
                outputs.push(result.output.trim());
              }
            }
          }
        } else {
          for (const item of [...reversibleReports].reverse()) {
            const result = await window.cardbushDesktop!.revertFileChanges(root, item.files);
            revertedFiles += result.revertedFiles;
            if (result.output.trim()) {
              outputs.push(result.output.trim());
            }
          }
        }
        setChangeReviewNotice(
          outputs.join('\n') ||
            (language === 'zh'
              ? `已撤回 ${revertedFiles} 个文件的修改。`
              : `Reverted ${revertedFiles} file(s).`),
        );
        setRevertedChangeKeys((current) => {
          const next = new Set(current);
          for (const report of reports) {
            next.add(`${conversationId}:${report.id}`);
          }
          return next;
        });
        if (root) {
          await refreshProjectGitStatus(root);
        }
      } catch (caught) {
        const message =
          language === 'zh'
            ? `撤回失败：${workspaceRevertErrorMessage(caught, 'zh')}`
            : `Revert failed: ${workspaceRevertErrorMessage(caught, 'en')}`;
        setChangeReviewNotice(message);
        window.alert(message);
      } finally {
        setRevertingChangeId('');
      }
    },
    [
      activeProjectDir,
      chat.activeConversation,
      chat.conversations,
      language,
      refreshProjectGitStatus,
    ],
  );

  const openSettings = useCallback((targetSection: SettingsSection = 'profile') => {
    setSettingsInitialSection(targetSection);
    setSettingsMounted(true);
    setSettingsOpen(true);
  }, []);
  const markSettingsReady = useCallback(() => setSettingsReady(true), []);
  const settingsVisible = settingsOpen && settingsReady;

  useEffect(() => {
    const preloadTimer = window.setTimeout(() => {
      void loadSettingsViewModule();
    }, 0);
    return () => window.clearTimeout(preloadTimer);
  }, []);

  useEffect(() => {
    const projectDir = activeProjectDir?.trim();
    if (!projectDir) {
      return undefined;
    }
    const key = projectContextKey(projectDir);
    if (Object.prototype.hasOwnProperty.call(projectContexts, key)) {
      return undefined;
    }
    let cancelled = false;
    fetchProjectContext(projectDir)
      .then((context) => {
        if (cancelled) {
          return;
        }
        setProjectContexts((current) => {
          const next = { ...current, [key]: context.userPrompt };
          persistProjectContexts(next);
          return next;
        });
      })
      .catch(() => {
        if (cancelled) {
          return;
        }
        setProjectContexts((current) => ({ ...current, [key]: current[key] ?? '' }));
      });
    return () => {
      cancelled = true;
    };
  }, [activeProjectDir, projectContexts]);

  const saveActiveProjectContext = useCallback(
    async (value: string) => {
      const projectDir = activeProjectDir?.trim();
      if (!projectDir) {
        throw new Error(language === 'zh' ? '请先打开一个项目' : 'Open a project first');
      }
      const key = projectContextKey(projectDir);
      const saved = await saveProjectContext({
        projectDir,
        userPrompt: value,
      })
        .then((context) => context.userPrompt)
        .catch(() => value);
      setProjectContexts((current) => {
        const next = { ...current, [key]: saved };
        persistProjectContexts(next);
        return next;
      });
      return saved;
    },
    [activeProjectDir, language],
  );

  const toggleSkillEnabled = useCallback((skillName: string, enabled: boolean) => {
    setDisabledSkillNames((current) => {
      const next = new Set(current);
      if (enabled) {
        next.delete(skillName);
      } else {
        next.add(skillName);
      }
      persistDisabledSkillNames(next);
      return next;
    });
  }, []);

  const toggleToolEnabled = useCallback((toolName: string, enabled: boolean) => {
    const normalized = toolName.trim();
    if (!normalized) return;
    setDisabledToolNames((current) => {
      const next = new Set(current);
      if (enabled) {
        next.delete(normalized);
      } else {
        next.add(normalized);
      }
      persistDisabledToolNames(next);
      return next;
    });
  }, []);

  const setVisualInputEnabled = useCallback(
    (enabled: boolean) => {
      const nextEnabled = enabled && visualInputAvailable;
      setVisualInputEnabledSetting(nextEnabled);
      persistVisualInputEnabled(nextEnabled);
    },
    [visualInputAvailable],
  );

  return (
    <div
      className={`app theme-${theme}${customBackgroundImagePath ? ' has-custom-background' : ''}${section === 'os' ? ' os-shell-active' : ''}`}
      lang={language}
      style={appStyle}
    >
      {(section !== 'os' || settingsOpen) && (
        <WindowFrame
          language={language}
          onOpenBotSettings={() => openSettings('bots')}
          onOpenCacheSettings={() => openSettings('cache')}
          onOpenPluginSettings={() => openSettings('mcp')}
          onOpenTools={() => {
            setSettingsOpen(false);
            setSection('tools');
          }}
          onOpenSkills={() => {
            setSettingsOpen(false);
            setSection('skills');
          }}
          onOpenOs={() => {
            setSettingsOpen(false);
            void enterOsMode();
          }}
          onOpenTeam={() => {
            setSettingsOpen(false);
            setSection('team');
          }}
        />
      )}
      {settingsMounted && (
        <Suspense fallback={null}>
          <LazySettingsView
            active={settingsVisible}
            onReady={markSettingsReady}
            themePreference={themePreference}
            lightThemeStyle={lightThemeStyle}
            language={language}
            languageMode={languageMode}
            systemLanguage={systemLanguage}
            settings={appSettings}
            backgroundImageSource={customBackgroundSource}
            selectedModel={chat.selectedModel}
            availableModels={availableModels}
            backendCapabilities={backendCapabilities}
            runtimeBusy={runningConversationIds.size > 0}
            conversations={chat.conversations}
            initialSection={settingsInitialSection}
            onBack={() => setSettingsOpen(false)}
            onThemePreferenceChange={setThemePreference}
            onLightThemeStyleChange={setLightThemeStyle}
            onLanguageModeChange={setLanguageMode}
            onSettingsChange={updateAppSettings}
            onEnterOsMode={() => {
              setSettingsOpen(false);
              void enterOsMode();
            }}
            onUseModel={chat.setSelectedModel}
            onSidebarWidthChange={setSidebarWidth}
            onConversationHistoryCleared={() => chat.reloadConversations()}
            onRuntimeAssetsReloaded={reloadRuntimeAssetConfiguration}
          />
        </Suspense>
      )}
      <main
        className={`desktop-shell${sidebarCollapsed ? ' sidebar-is-collapsed' : ''}${settingsVisible ? ' app-content-suspended' : ''} ${section === 'os' ? 'os-desktop-shell' : ''}`}
        aria-hidden={settingsVisible}
        inert={settingsVisible ? true : undefined}
        style={section === 'os'
          ? ({
              '--os-background-filter': appSettings.os.backgroundContrast > 0
                ? `blur(${appSettings.os.backgroundContrast * 0.2}px)`
                : 'none',
            } as CSSProperties)
          : undefined}
      >
          {section === 'os' && osWallpaperSource && (
            <>
              <img
                className="os-wallpaper-layer"
                src={osWallpaperSource}
                alt=""
                aria-hidden="true"
              />
              <div
                className="os-wallpaper-contrast"
                style={{ opacity: appSettings.os.backgroundContrast / 100 }}
                aria-hidden="true"
              />
            </>
          )}
          {sidebarPresence.mounted && (
            <>
              {section === 'team' ? (
                <TeamSidebar
                  language={language}
                  onBack={() => setSection('chat')}
                  onOpenSettings={() => openSettings('profile')}
                  softVisible={sidebarPresence.visible}
                />
              ) : (
                <ChatSidebar
                  language={language}
                  section={section}
                  activeConversationId={chat.activeConversationId}
                  runningConversationIds={runningConversationIds}
                  attentionByConversation={chat.attentionByConversation}
                  projects={projectItems}
                  conversations={chat.conversations}
                  changeReportsByConversation={changeReportsByConversation}
                  onlyTalkMode={onlyTalkMode}
                  onOnlyTalkModeChange={changeOnlyTalkMode}
                  onSectionChange={(nextSection) => {
                    if (nextSection === 'os') {
                      void enterOsMode();
                      return;
                    }
                    setSection(nextSection);
                  }}
                  onConversationChange={(id) => {
                    chat.openConversation(id);
                    setSection('chat');
                  }}
                  onCreateConversation={() => {
                    createConversation(onlyTalkMode ? null : undefined);
                  }}
                  onAddProject={() => void addProject()}
                  onProjectAction={(action, project) => void handleProjectAction(action, project)}
                  onDeleteConversation={chat.deleteConversation}
                  onRenameConversation={chat.renameConversation}
                  onOpenConversationChanges={(conversationId) => {
                    setInspectorTarget(null);
                    setWorkSummaryInspector(null);
                    setChangeReviewFilePath('');
                    setChangeReviewConversationId(conversationId);
                    setChangeReviewNotice('');
                  }}
                  onOpenSettings={() => openSettings('profile')}
                  softVisible={sidebarPresence.visible}
                />
              )}
              <SidebarResizer
                language={language}
                onWidthChange={(width) => {
                  setSidebarWidth(width);
                }}
                onResizeEnd={(width, shouldCollapse) => {
                  if (shouldCollapse) {
                    setSidebarPreviewWidth(Math.max(0, Math.min(maxSidebarWidth, width)));
                    window.setTimeout(() => setSidebarPreviewWidth(null), 260);
                    return;
                  }
                  setSidebarWidth(width);
                }}
                onCollapse={() => setSidebarCollapsed(true)}
                softVisible={sidebarPresence.visible}
              />
            </>
          )}
          <section className="main-stage">
            {section === 'chat' || section === 'os' ? (
              <ChatPanel
                language={language}
                title={
                  section === 'os'
                    ? 'CardBush OS'
                    : chat.activeConversation?.title ?? 'cardbush'
                }
                osModeEnabled={section === 'os'}
                osRuntimeAvailable={
                  backendCapabilities.osMode && backendCapabilities.desktopAutomation
                }
                osSettings={appSettings.os}
                onlyTalkMode={onlyTalkMode}
                onOsSettingsChange={(os) => updateAppSettings((current) => ({ ...current, os }))}
                onExitOsMode={exitOsMode}
                sidebarCollapsed={sidebarCollapsed}
                inspectorOpen={inspectorOpen}
                windowMaximized={windowMaximized}
                onRevealSidebar={() => setSidebarCollapsed(false)}
                activeConversationId={chat.activeConversationId}
                activeProjectDir={section === 'os' ? undefined : activeProjectDir}
                selectedProjectDir={
                  section === 'os' || onlyTalkMode ? '' : activeConversationProjectDir
                }
                availableProjects={
                  onlyTalkMode
                    ? []
                    : projectItems.filter((project) => !project.archived)
                }
                onWelcomeProjectChange={changeWelcomeProject}
                projectContext={
                  section === 'os' || onlyTalkMode
                    ? ''
                    : projectContexts[projectContextKey(activeProjectDir)] ?? ''
                }
                messages={chat.activeMessages}
                activeGoal={chat.activeGoal}
                goalAvailable={chat.goalAvailable}
                goalCancelling={chat.activeGoalCancelling}
                goalWaiting={chat.activeGoalWaiting}
                changeReports={
                  changeReportsByConversation[chat.activeConversationId] ?? []
                }
                skills={chat.skills}
                disabledSkillNames={disabledSkillNames}
                visualInputAvailable={visualInputAvailable}
                visualInputEnabled={visualInputEnabled}
                contextSearchAvailable={backendCapabilities.sessionContextSearch}
                subagentObservabilityAvailable={
                  backendCapabilities.subagentObservability &&
                  backendCapabilities.subagentObservabilityProtocol ===
                    SUBAGENT_DISPATCH_EVENT_PROTOCOL
                }
                shadowAvailable={
                  section === 'chat' && backendCapabilities.shadowConversationActivation
                }
                shadowAccentColor={appSettings.shadow.accentColor}
                thinkingNotice={section === 'chat' ? thinkingNotice : null}
                thinkingVisible={reasoningTraceVisible}
                guidanceDeliveryMode={appSettings.guidance.deliveryMode}
                terminalRuntime={appSettings.terminal.runtime}
                loading={chat.loading || chat.messagesLoading}
                sending={chat.sending}
                stopping={chat.stopping}
                activeTurnId={chat.activeTurnId}
                connectionRecovery={chat.activeConnectionRecovery}
                queuedMessageCount={chat.queuedMessageCount}
                queuedMessagePreview={chat.queuedMessagePreview}
                queuedMessages={chat.queuedMessages}
                pendingInteraction={chat.pendingInteraction}
                error={chat.error}
                notice={chat.notice}
                selectedModel={chat.selectedModel}
                selectedModelConfig={appSettings.managedModelConfigs.find(
                  (config) => config.id === chat.selectedModel,
                )}
                contextWindowMaxTokens={appSettings.managedModelConfigs.find(
                  (config) => config.id === chat.selectedModel,
                )?.maxContextTokens}
                contextWindowUsage={chat.activeContextWindowUsage}
                availableModels={availableModels}
                referencePlanAvailable={backendCapabilities.taskPlan}
                referencePlanMode={chat.referencePlanMode}
                permissionMode={chat.permissionMode}
                reasoningLevelAvailable={backendCapabilities.reasoningLevelSelection}
                reasoningLevel={chat.reasoningLevel}
                reasoningLevels={backendCapabilities.reasoningLevels}
                botHandoffAvailable={backendCapabilities.sessionShareLinks}
                gitAvailable={section === 'chat' && backendCapabilities.git}
                terminalAvailable={section === 'chat' && backendCapabilities.terminal}
                onModelChange={chat.setSelectedModel}
                onReferencePlanModeChange={chat.setReferencePlanMode}
                onPermissionModeChange={chat.setPermissionMode}
                onReasoningLevelChange={chat.setReasoningLevel}
                onConfigureModels={() => openSettings('models')}
                onCreateConversation={() =>
                  createConversation(onlyTalkMode ? null : activeProjectDir)
                }
                onSaveProjectContext={saveActiveProjectContext}
                onToggleSkill={toggleSkillEnabled}
                onVisualInputEnabledChange={setVisualInputEnabled}
                onCreateSessionShareLink={chat.createSessionShareLink}
                onRefreshActiveSession={refreshBackendAndActiveSession}
                onSend={chat.sendMessage}
                onRetryMessage={chat.retryFailedUserMessage}
                onRegenerate={chat.regenerateAssistantMessage}
                onEditUserMessage={chat.editUserMessageAndRegenerate}
                onGuideMessage={chat.sendTurnGuidance}
                onRetryGuidance={chat.retryTurnGuidance}
                onGuideQueuedMessage={chat.sendQueuedMessageAsGuidance}
                onRemoveQueuedMessage={chat.removeQueuedMessage}
                onRevertChangeReport={(report, message) =>
                  revertChangeReport(
                    message.conversationId?.trim() || chat.activeConversationId,
                    report,
                  )
                }
                onOpenChangeReview={(filePath) => {
                  if (!chat.activeConversationId) return;
                  setInspectorTarget(null);
                  setWorkSummaryInspector(null);
                  setChangeReviewFilePath(
                    typeof filePath === 'string' ? filePath.trim() : '',
                  );
                  setChangeReviewConversationId(chat.activeConversationId);
                  setChangeReviewNotice('');
                }}
                onReplyInteraction={chat.replyToInteraction}
                onCancelInteraction={chat.cancelPendingInteraction}
                onCancelGoal={chat.cancelActiveGoal}
                onCancel={chat.cancelSending}
                onClearError={chat.clearError}
                onClearNotice={chat.clearNotice}
                draft={activeDraft}
                onDraftChange={setActiveDraft}
              />
            ) : (
              <FeaturePanel
                language={language}
                section={section}
                activeProjectDir={activeProjectDir}
                workflowValidationAvailable={backendCapabilities.teamWorkflows}
                sidebarCollapsed={sidebarCollapsed}
                onRevealSidebar={() => setSidebarCollapsed(false)}
                conversations={chat.conversations}
                skills={chat.skills}
                disabledSkillNames={disabledSkillNames}
                disabledToolNames={disabledToolNames}
                onToggleSkill={toggleSkillEnabled}
                onToggleTool={toggleToolEnabled}
                onReloadSkills={chat.reloadSkills}
                onLoadSkillDetail={chat.loadSkillDetail}
                onCreateConversation={() =>
                  createConversation(onlyTalkMode ? null : activeProjectDir)
                }
                onOpenConversation={(conversationId) => {
                  chat.openConversation(conversationId);
                  setSection('chat');
                }}
              />
            )}
          </section>
          {inspectorPresence.mounted ? (
            <aside
              className={`right-inspector soft-panel-motion ${inspectorPresence.visible ? 'soft-panel-visible' : 'soft-panel-hidden'}`}
              aria-label={language === 'zh' ? '右侧检查器' : 'Inspector'}
              aria-hidden={!inspectorPresence.visible}
              style={{ '--right-inspector-width': `${inspectorWidth}px` } as CSSProperties}
            >
              <RightInspectorResizer
                width={inspectorWidth}
                onWidthChange={setInspectorWidth}
                label={language === 'zh' ? '拖动调整右侧栏宽度' : 'Drag to resize inspector'}
              />
              <header className="right-inspector-toolbar">
                <strong>
                  {displayedReviewConversation
                    ? (language === 'zh' ? '审查' : 'Review')
                    : displayedWorkSummaryInspector
                      ? displayedWorkSummaryInspector.title || (
                          displayedWorkSummaryInspector.kind === 'turn-history'
                            ? language === 'zh' ? '回合详情' : 'Turn details'
                            : language === 'zh' ? '子任务详情' : 'Subagent task'
                        )
                    : displayedInspectorTarget?.title || basename(displayedInspectorTarget?.target ?? '')}
                </strong>
                {!displayedWorkSummaryInspector && (
                  <button
                    type="button"
                    className={inspectorSummaryOpen ? 'active' : ''}
                    onClick={() => setInspectorSummaryOpen((current) => !current)}
                    title={language === 'zh' ? '摘要' : 'Summary'}
                  >
                    <Clipboard size={15} />
                    <span>{language === 'zh' ? '摘要' : 'Summary'}</span>
                  </button>
                )}
                {displayedInspectorTarget && (
                  <button
                    type="button"
                    onClick={() => void window.cardbushDesktop?.openUiPreview?.(displayedInspectorTarget.target)}
                    title={language === 'zh' ? '弹出到独立窗口' : 'Pop out'}
                  >
                    <ExternalLink size={15} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setInspectorTarget(null);
                    setWorkSummaryInspector(null);
                    setChangeReviewFilePath('');
                    setChangeReviewConversationId('');
                    setChangeReviewNotice('');
                  }}
                  title={language === 'zh' ? '关闭右侧栏' : 'Close inspector'}
                >
                  <PanelRightClose size={16} />
                </button>
              </header>
              {!displayedWorkSummaryInspector && inspectorSummaryOpen && (
                <div className="right-inspector-summary">
                  {displayedReviewConversation
                    ? (() => {
                        const summary = summarizeChangeReports(displayedReviewReports);
                        return summary
                          ? `${summary.fileCount} ${language === 'zh' ? '个文件' : 'files'} · +${summary.additions} -${summary.deletions}`
                          : (language === 'zh' ? '暂无修改摘要' : 'No change summary');
                      })()
                    : displayedInspectorTarget?.target}
                </div>
              )}
              <div className="right-inspector-body">
                {displayedReviewConversation ? (
                  <ConversationChangeDialog
                    embedded
                    language={language}
                    conversation={displayedReviewConversation}
                    reports={displayedReviewReports}
                    initialFilePath={changeReviewFilePath}
                    notice={changeReviewNotice}
                    revertingChangeId={revertingChangeId}
                    revertedChangeIds={new Set(
                      displayedReviewReports
                        .filter((report) =>
                          revertedChangeKeys.has(`${displayedReviewConversation.id}:${report.id}`),
                        )
                        .map((report) => report.id),
                    )}
                    onClose={() => {
                      setChangeReviewFilePath('');
                      setChangeReviewConversationId('');
                    }}
                    onRevert={(report) => revertChangeReport(displayedReviewConversation.id, report)}
                    onRevertAll={() => revertConversationReports(
                      displayedReviewConversation.id,
                      displayedReviewReports.filter(
                        (report) => !revertedChangeKeys.has(
                          `${displayedReviewConversation.id}:${report.id}`,
                        ),
                      ),
                    )}
                  />
                ) : displayedInspectorTarget ? (
                  <InspectorWebview
                    key={displayedInspectorTarget.target}
                    source={inspectorSource(displayedInspectorTarget.target)}
                    language={language}
                  />
                ) : displayedWorkSummaryInspector ? (
                  <WorkSummaryInspector
                    detail={displayedWorkSummaryInspector}
                    messages={chat.messagesByConversation[
                      displayedWorkSummaryInspector.sessionId
                    ] ?? []}
                    language={language}
                  />
                ) : null}
              </div>
            </aside>
          ) : null}
      </main>
      <CopyToastHost language={language} />
    </div>
  );
}

function CopyToastHost({ language }: { language: AppLanguage }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let timer = 0;
    const show = () => {
      setVisible(true);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setVisible(false), 1500);
    };
    window.addEventListener(COPY_FEEDBACK_EVENT, show);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(COPY_FEEDBACK_EVENT, show);
    };
  }, []);

  if (!visible) {
    return null;
  }
  return (
    <div className="copy-toast" role="status" aria-live="polite">
      <CheckCircle2 size={15} />
      <span>{language === 'zh' ? '已复制到剪贴板' : 'Copied to clipboard'}</span>
    </div>
  );
}

function readInitialThemePreference(): ThemePreference {
  const stored = window.localStorage.getItem('cardbush_theme_mode');
  if (
    stored === 'system' ||
    stored === 'light' ||
    stored === 'dark'
  ) {
    return stored;
  }
  const legacy = window.localStorage.getItem('cardbush.theme');
  if (legacy === 'dark') {
    return 'dark';
  }
  if (legacy === 'parchment' || legacy === 'bright') {
    return 'light';
  }
  return 'system';
}

function readInitialLightThemeStyle(): LightThemeStyle {
  const stored = window.localStorage.getItem('cardbush_light_theme_style');
  if (stored === 'parchment' || stored === 'bright') {
    return stored;
  }
  const legacy = window.localStorage.getItem('cardbush.theme');
  if (legacy === 'bright') {
    return 'bright';
  }
  return 'parchment';
}

function readInitialLanguageMode(): AppLanguageMode {
  const stored = window.localStorage.getItem('cardbush_language_mode');
  if (stored === 'system' || stored === 'zh' || stored === 'en') {
    return stored;
  }
  const legacy = window.localStorage.getItem('cardbush.language');
  if (legacy === 'zh' || legacy === 'en') {
    return legacy;
  }
  return 'system';
}

function readInitialSidebarWidth() {
  const stored = window.localStorage.getItem('cardbush.sidebar_width');
  if (stored) {
    const width = Number(stored);
    if (Number.isFinite(width)) {
      return clampSidebarWidth(width);
    }
  }
  return defaultSidebarWidth;
}

function readProjectItems(): ProjectItem[] {
  const raw = window.localStorage.getItem('cardbush_projects');
  if (!raw?.trim()) {
    return [];
  }
  try {
    const decoded: unknown = JSON.parse(raw);
    if (!Array.isArray(decoded)) {
      return [];
    }
    const result: ProjectItem[] = [];
    for (const item of decoded) {
      const value = item != null && typeof item === 'object'
        ? (item as Record<string, unknown>)
        : {};
      const rootPath = String(value.rootPath ?? '').trim();
      if (!rootPath || result.some((project) => samePath(project.rootPath, rootPath))) {
        continue;
      }
      const changedCount = Number(value.changedCount);
      result.push({
        id: String(value.id ?? '').trim() || stableProjectId(rootPath),
        title: String(value.title ?? '').trim() || basename(rootPath),
        rootPath,
        pinned: Boolean(value.pinned),
        archived: Boolean(value.archived),
        branch: String(value.branch ?? '').trim(),
        changedCount: Number.isFinite(changedCount) ? changedCount : 0,
      });
    }
    return result;
  } catch {
    return [];
  }
}

function persistProjectItems(value: ProjectItem[]) {
  window.localStorage.setItem('cardbush_projects', JSON.stringify(value));
}

function stableProjectId(rootPath: string) {
  return `project-${rootPath.replaceAll('\\', '/').toLowerCase()}`;
}

function readProjectContexts() {
  const raw = window.localStorage.getItem('cardbush_project_contexts');
  if (!raw?.trim()) {
    return {};
  }
  try {
    const decoded = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(decoded)
        .filter(([, value]) => typeof value === 'string')
        .map(([key, value]) => [key, String(value)]),
    );
  } catch {
    return {};
  }
}

function persistProjectContexts(value: Record<string, string>) {
  window.localStorage.setItem('cardbush_project_contexts', JSON.stringify(value));
}

function readDisabledSkillNames() {
  const raw = window.localStorage.getItem('cardbush_disabled_skills');
  if (!raw?.trim()) {
    return new Set<string>();
  }
  try {
    const decoded: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(decoded)
        ? decoded.map((item) => String(item)).filter((item) => item.trim())
        : [],
    );
  } catch {
    return new Set<string>();
  }
}

function persistDisabledSkillNames(value: Set<string>) {
  window.localStorage.setItem(
    'cardbush_disabled_skills',
    JSON.stringify([...value].sort()),
  );
}

function readDisabledToolNames() {
  const raw = window.localStorage.getItem('cardbush_disabled_tools');
  if (!raw?.trim()) {
    return new Set<string>();
  }
  try {
    const decoded: unknown = JSON.parse(raw);
    return new Set(
      Array.isArray(decoded)
        ? decoded.map((item) => String(item)).filter((item) => item.trim())
        : [],
    );
  } catch {
    return new Set<string>();
  }
}

function persistDisabledToolNames(value: Set<string>) {
  window.localStorage.setItem(
    'cardbush_disabled_tools',
    JSON.stringify([...value].sort()),
  );
}

function readVisualInputEnabled() {
  return window.localStorage.getItem('cardbush_visual_input_enabled') === 'true';
}

function persistVisualInputEnabled(value: boolean) {
  window.localStorage.setItem('cardbush_visual_input_enabled', value ? 'true' : 'false');
}

function projectContextKey(projectDir?: string) {
  return projectDir?.trim().replace(/\\/g, '/').toLowerCase() ?? '';
}

function clampSidebarWidth(value: number) {
  return Math.max(minSidebarWidth, Math.min(maxSidebarWidth, Math.round(value)));
}

function readCompanionSettings(): CompanionSettings {
  return normalizeCompanionSettings({
    size: window.localStorage.getItem('cardbush_cardling_size') as CompanionSize,
    opacity: Number(window.localStorage.getItem('cardbush_cardling_opacity')),
    motion: window.localStorage.getItem('cardbush_cardling_motion') as CompanionMotionMode,
  });
}

function normalizeCompanionSettings(
  value?: Partial<CompanionSettings>,
): CompanionSettings {
  const size = normalizeCompanionSize(value?.size);
  const motion = normalizeCompanionMotion(value?.motion);
  const opacity = Number(value?.opacity);
  return {
    size,
    motion,
    opacity: Number.isFinite(opacity)
      ? Math.max(0.55, Math.min(1, Math.round(opacity * 100) / 100))
      : defaultAppSettings.companion.opacity,
  };
}

function normalizeCompanionSize(value?: string): CompanionSize {
  return value === 'compact' || value === 'large' || value === 'normal'
    ? value
    : defaultAppSettings.companion.size;
}

function normalizeCompanionMotion(value?: string): CompanionMotionMode {
  return value === 'full' || value === 'reduced' || value === 'off'
    ? value
    : defaultAppSettings.companion.motion;
}

function systemPrefersDark() {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

function readSystemLanguage(): AppLanguage {
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

function resolveTheme(
  preference: ThemePreference,
  lightStyle: LightThemeStyle,
  prefersDark: boolean,
): ThemeMode {
  if (preference === 'dark') {
    return 'dark';
  }
  if (preference === 'light') {
    return lightStyle;
  }
  return prefersDark ? 'dark' : lightStyle;
}

function themeBackgroundColor(theme: ThemeMode) {
  if (theme === 'bright') {
    return '#f5f3ef';
  }
  if (theme === 'parchment') {
    return '#e1d4ba';
  }
  return '#1a1a1a';
}

function applyDocumentBackdrop(theme: ThemeMode, backgroundSource: string) {
  const background = themeBackgroundColor(theme);
  const root = document.getElementById('root');
  const hasCustomBackground = Boolean(backgroundSource.trim());
  const documentStyle = document.documentElement.style;
  if (document.documentElement.dataset.startTheme !== theme) {
    document.documentElement.dataset.startTheme = theme;
  }
  if (documentStyle.getPropertyValue('--cardbush-window-bg') !== background) {
    documentStyle.setProperty('--cardbush-window-bg', background);
  }
  if (document.documentElement.style.backgroundColor !== background) {
    document.documentElement.style.backgroundColor = background;
  }
  if (document.body.style.backgroundColor !== background) {
    document.body.style.backgroundColor = background;
  }
  if (hasCustomBackground) {
    const imageValue = cssImageUrl(backgroundSource);
    if (document.documentElement.dataset.startCustomBackground !== 'true') {
      document.documentElement.dataset.startCustomBackground = 'true';
    }
    if (
      documentStyle.getPropertyValue('--cardbush-custom-background-image') !==
      imageValue
    ) {
      documentStyle.setProperty('--cardbush-custom-background-image', imageValue);
    }
    if (root?.style.background !== 'transparent') {
      root?.style.setProperty('background', 'transparent');
    }
    return;
  }
  if (document.documentElement.dataset.startCustomBackground) {
    delete document.documentElement.dataset.startCustomBackground;
  }
  if (documentStyle.getPropertyValue('--cardbush-custom-background-image')) {
    documentStyle.removeProperty('--cardbush-custom-background-image');
  }
  if (root?.style.background !== background) {
    root?.style.setProperty('background', background);
  }
}

function resolveAppLanguage(mode: AppLanguageMode, systemLanguage: AppLanguage) {
  return mode === 'system' ? systemLanguage : mode;
}

function readInitialAppSettings(): AppSettingsState {
  const storedOsPreferences = readStoredOsPreferences();
  return normalizeAppSettings({
    proxy: {
      mode: proxyModeFromStorage(
        window.localStorage.getItem('cardbush_proxy_mode'),
        window.localStorage.getItem('cardbush_proxy_http') ?? '',
        window.localStorage.getItem('cardbush_proxy_https') ?? '',
      ),
      httpProxy: window.localStorage.getItem('cardbush_proxy_http') ?? '',
      httpsProxy: window.localStorage.getItem('cardbush_proxy_https') ?? '',
      noProxy:
        window.localStorage.getItem('cardbush_proxy_no_proxy') ??
        '127.0.0.1,localhost,::1',
    },
    browser: {
      privacyMode:
        window.localStorage.getItem('cardbush_browser_privacy_mode') === 'true',
    },
    shadow: {
      accentColor:
        window.localStorage.getItem('cardbush_shadow_accent_color') ??
        defaultShadowAccentColor,
    },
    thinking: {
      visible: window.localStorage.getItem('cardbush_thinking_visible') === 'true',
    },
    guidance: {
      deliveryMode:
        window.localStorage.getItem('cardbush_guidance_delivery_mode') === 'immediate'
          ? 'immediate'
          : 'queue',
    },
    terminal: {
      runtime: terminalRuntimeFromStorage(
        window.localStorage.getItem('cardbush_terminal_runtime'),
      ),
    },
    os: {
      launchAtLogin: window.localStorage.getItem('cardbush_os_launch_at_login') === 'true',
      startInOsMode: window.localStorage.getItem('cardbush_os_start_mode') !== 'standard',
      taskbarPlacement: storedOsPreferences.taskbarPlacement,
      backgroundContrast: storedOsPreferences.backgroundContrast,
      gamepad: storedOsPreferences.gamepad,
    },
    backendAuth: {
      bearerToken: window.localStorage.getItem(backendBearerTokenStorageKey) ?? '',
      localRequestKey: window.localStorage.getItem(backendLocalRequestKeyStorageKey) ?? '',
    },
    managedModelConfigs: readManagedModelConfigs(),
    backgroundImagePath: window.localStorage.getItem('cardbush_background_image_path') ?? '',
    companionEnabled:
      window.localStorage.getItem('cardbush_cardling_enabled') !== 'false',
    companion: readCompanionSettings(),
    font: {
      family: window.localStorage.getItem('cardbush_font_family') ?? '',
      displayName: window.localStorage.getItem('cardbush_font_display_name') ?? '',
      filePath: window.localStorage.getItem('cardbush_font_file_path') ?? '',
    },
    user: {
      name:
        window.localStorage.getItem('cardbush_user_name') ??
        defaultAppSettings.user.name,
      membership:
        window.localStorage.getItem('cardbush_user_membership') ??
        defaultAppSettings.user.membership,
      avatarEmoji:
        window.localStorage.getItem('cardbush_user_avatar') ??
        defaultAppSettings.user.avatarEmoji,
      avatarImagePath: window.localStorage.getItem('cardbush_user_avatar_image') ?? '',
    },
  });
}

function readStoredOsPreferences(): Pick<AppSettingsState['os'], 'taskbarPlacement' | 'backgroundContrast' | 'gamepad'> {
  try {
    const value = JSON.parse(window.localStorage.getItem('cardbush_os_preferences') ?? '{}') as Partial<AppSettingsState['os']>;
    return {
      taskbarPlacement: value.taskbarPlacement === 'top' ? 'top' : 'bottom',
      backgroundContrast: Number.isFinite(value.backgroundContrast)
        ? Math.min(100, Math.max(0, Math.round(value.backgroundContrast ?? 30)))
        : defaultAppSettings.os.backgroundContrast,
      gamepad: {
        ...defaultAppSettings.os.gamepad,
        ...(value.gamepad ?? {}),
      },
    };
  } catch {
    return {
      taskbarPlacement: defaultAppSettings.os.taskbarPlacement,
      backgroundContrast: defaultAppSettings.os.backgroundContrast,
      gamepad: defaultAppSettings.os.gamepad,
    };
  }
}

function readStoredOsPinnedApplications(): OsApplication[] {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem('cardbush_os_pinned_applications') ?? '[]',
    );
    if (!Array.isArray(value)) return [];
    return value
      .filter((item): item is OsApplication => Boolean(
        item &&
        typeof item === 'object' &&
        typeof item.id === 'string' &&
        typeof item.name === 'string' &&
        typeof item.path === 'string' &&
        item.source === 'start_menu' &&
        typeof item.icon === 'string',
      ))
      .slice(0, 12);
  } catch {
    return [];
  }
}

function readManagedModelConfigs() {
  const raw =
    window.localStorage.getItem('cardbush_managed_model_configs') ??
    window.localStorage.getItem('cardbush_managed_models');
  if (!raw?.trim()) {
    return [];
  }
  try {
    const decoded: unknown = JSON.parse(raw);
    if (!Array.isArray(decoded)) {
      return [];
    }
    if (decoded.every((item) => typeof item === 'string')) {
      return decoded.map((modelName) => ({
        id: '',
        provider: 'custom',
        apiKey: '',
        modelName,
        baseUrl: '',
        maxContextTokens: undefined,
        maxCompletionTokens: undefined,
      }));
    }
    return decoded
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => ({
        id: String(item.id ?? ''),
        provider: String(item.provider ?? ''),
        apiKey: String(item.apiKey ?? ''),
        hasApiKey: item.hasApiKey === true,
        apiKeyMasked:
          typeof item.apiKeyMasked === 'string' ? item.apiKeyMasked : undefined,
        modelName: String(item.modelName ?? ''),
        baseUrl: String(item.baseUrl ?? ''),
        maxContextTokens: normalizeMaxContextTokens(
          item.maxContextTokens ??
            item.max_context_tokens ??
            item.contextWindowTokens ??
            item.context_window_tokens ??
            item.maxInputTokens ??
            item.max_input_tokens,
        ),
        maxCompletionTokens: normalizeMaxCompletionTokens(
          item.maxCompletionTokens ??
            item.max_completion_tokens ??
            item.maxOutputTokens ??
            item.max_output_tokens,
        ),
      }));
  } catch {
    return [];
  }
}

function normalizeAppSettings(settings: AppSettingsState): AppSettingsState {
  const httpProxy = settings.proxy.httpProxy.trim();
  const httpsProxy = settings.proxy.httpsProxy.trim();
  return {
    proxy: {
      mode: normalizeProxyMode(settings.proxy.mode),
      httpProxy,
      httpsProxy,
      noProxy:
        settings.proxy.noProxy.trim() || defaultAppSettings.proxy.noProxy,
    },
    browser: {
      privacyMode: settings.browser.privacyMode === true,
    },
    shadow: {
      accentColor: normalizeHexColor(
        settings.shadow?.accentColor,
        defaultShadowAccentColor,
      ),
    },
    thinking: {
      visible: settings.thinking?.visible === true,
    },
    guidance: {
      deliveryMode:
        settings.guidance?.deliveryMode === 'immediate' ? 'immediate' : 'queue',
    },
    terminal: {
      runtime: normalizeTerminalRuntime(settings.terminal?.runtime),
    },
    os: {
      launchAtLogin: settings.os?.launchAtLogin === true,
      startInOsMode: settings.os?.startInOsMode !== false,
      taskbarPlacement: settings.os?.taskbarPlacement === 'top' ? 'top' : 'bottom',
      backgroundContrast: Number.isFinite(settings.os?.backgroundContrast)
        ? Math.min(100, Math.max(0, Math.round(settings.os.backgroundContrast)))
        : defaultAppSettings.os.backgroundContrast,
      gamepad: {
        confirmButton: normalizeGamepadButton(settings.os?.gamepad?.confirmButton, 0),
        backButton: normalizeGamepadButton(settings.os?.gamepad?.backButton, 1),
        keyboardButton: normalizeGamepadButton(settings.os?.gamepad?.keyboardButton, 3),
        appsButton: normalizeGamepadButton(settings.os?.gamepad?.appsButton, 2),
        settingsButton: normalizeGamepadButton(settings.os?.gamepad?.settingsButton, 9),
      },
    },
    backendAuth: {
      bearerToken: settings.backendAuth.bearerToken.trim(),
      localRequestKey: settings.backendAuth.localRequestKey.trim(),
    },
    managedModelConfigs: normalizeManagedModelConfigs(
      settings.managedModelConfigs,
    ),
    backgroundImagePath: settings.backgroundImagePath.trim(),
    companionEnabled: settings.companionEnabled !== false,
    companion: normalizeCompanionSettings(settings.companion),
    font: {
      family: settings.font.family.trim(),
      displayName: settings.font.displayName.trim(),
      filePath: settings.font.filePath.trim(),
    },
    user: {
      name: settings.user.name.trim() || defaultAppSettings.user.name,
      membership:
        settings.user.membership.trim() || defaultAppSettings.user.membership,
      avatarEmoji:
        settings.user.avatarEmoji.trim() || defaultAppSettings.user.avatarEmoji,
      avatarImagePath: settings.user.avatarImagePath?.trim() ?? '',
    },
  };
}

function normalizeGamepadButton(value: number | undefined, fallback: number) {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 17
    ? Number(value)
    : fallback;
}

function normalizeHexColor(value: string | undefined, fallback: string) {
  const normalized = value?.trim().toLowerCase() ?? '';
  return /^#[0-9a-f]{6}$/.test(normalized) ? normalized : fallback;
}

function proxyModeFromStorage(
  value: string | null,
  httpProxy: string,
  httpsProxy: string,
): AppSettingsState['proxy']['mode'] {
  if (value === 'system') {
    return 'system';
  }
  if (value === 'manual') {
    return httpProxy.trim() || httpsProxy.trim() ? 'manual' : 'none';
  }
  return value === 'none' ? 'none' : defaultAppSettings.proxy.mode;
}

function normalizeProxyMode(
  value: AppSettingsState['proxy']['mode'],
) {
  if (value === 'system') {
    return 'system';
  }
  if (value === 'manual') {
    return 'manual';
  }
  return 'none';
}

function terminalRuntimeFromStorage(value: string | null): TerminalRuntime {
  return normalizeTerminalRuntime(value as TerminalRuntime | undefined);
}

function normalizeTerminalRuntime(value?: TerminalRuntime): TerminalRuntime {
  if (value === 'wsl' || value === 'git_bash' || value === 'bash') {
    return value;
  }
  return 'powershell';
}

function persistAppSettings(settings: AppSettingsState) {
  window.localStorage.setItem('cardbush_proxy_mode', settings.proxy.mode);
  window.localStorage.setItem('cardbush_proxy_http', settings.proxy.httpProxy);
  window.localStorage.setItem('cardbush_proxy_https', settings.proxy.httpsProxy);
  window.localStorage.setItem('cardbush_proxy_no_proxy', settings.proxy.noProxy);
  window.localStorage.setItem(
    'cardbush_browser_privacy_mode',
    String(settings.browser.privacyMode),
  );
  window.localStorage.setItem(
    'cardbush_shadow_accent_color',
    normalizeHexColor(settings.shadow.accentColor, defaultShadowAccentColor),
  );
  window.localStorage.setItem(
    'cardbush_thinking_visible',
    String(settings.thinking.visible),
  );
  window.localStorage.setItem(
    'cardbush_guidance_delivery_mode',
    settings.guidance.deliveryMode,
  );
  window.localStorage.removeItem('cardbush_thinking_accent_color');
  window.localStorage.setItem(
    'cardbush_terminal_runtime',
    normalizeTerminalRuntime(settings.terminal.runtime),
  );
  window.localStorage.setItem(
    'cardbush_os_launch_at_login',
    String(settings.os.launchAtLogin),
  );
  window.localStorage.setItem(
    'cardbush_os_start_mode',
    settings.os.startInOsMode ? 'os' : 'standard',
  );
  window.localStorage.setItem('cardbush_os_preferences', JSON.stringify({
    taskbarPlacement: settings.os.taskbarPlacement,
    backgroundContrast: settings.os.backgroundContrast,
    gamepad: settings.os.gamepad,
  }));
  window.localStorage.setItem(
    backendBearerTokenStorageKey,
    settings.backendAuth.bearerToken,
  );
  window.localStorage.setItem(
    backendLocalRequestKeyStorageKey,
    settings.backendAuth.localRequestKey,
  );
  window.localStorage.setItem(
    'cardbush_managed_model_configs',
    JSON.stringify(settings.managedModelConfigs.map((config) => ({
      ...config,
      apiKey: '',
      hasApiKey: config.hasApiKey === true || Boolean(config.apiKey),
      apiKeyMasked: config.apiKeyMasked,
    }))),
  );
  window.localStorage.removeItem('cardbush_runtime_default_model_id');
  window.localStorage.setItem('cardbush_background_image_path', settings.backgroundImagePath);
  window.localStorage.setItem(
    'cardbush_cardling_enabled',
    String(settings.companionEnabled),
  );
  window.localStorage.setItem('cardbush_cardling_size', settings.companion.size);
  window.localStorage.setItem(
    'cardbush_cardling_opacity',
    String(settings.companion.opacity),
  );
  window.localStorage.setItem('cardbush_cardling_motion', settings.companion.motion);
  window.localStorage.setItem('cardbush_font_family', settings.font.family);
  window.localStorage.setItem(
    'cardbush_font_display_name',
    settings.font.displayName,
  );
  window.localStorage.setItem('cardbush_font_file_path', settings.font.filePath);
  window.localStorage.setItem('cardbush_user_name', settings.user.name);
  window.localStorage.setItem('cardbush_user_membership', settings.user.membership);
  window.localStorage.setItem('cardbush_user_avatar', settings.user.avatarEmoji);
  window.localStorage.setItem(
    'cardbush_user_avatar_image',
    settings.user.avatarImagePath ?? '',
  );
}

function normalizeManagedModelConfigs(source: ManagedModelConfig[]) {
  const seen = new Set<string>();
  const usedIds = new Set<string>();
  const result: ManagedModelConfig[] = [];
  for (const raw of source) {
    const provider = normalizeProvider(raw.provider);
    const modelName = raw.modelName.trim();
    const apiKey = raw.apiKey.trim();
    const baseUrl = raw.baseUrl.trim();
    const maxContextTokens = normalizeMaxContextTokens(raw.maxContextTokens);
    const maxCompletionTokens = normalizeMaxCompletionTokens(
      raw.maxCompletionTokens,
    );
    if (!provider || !modelName) {
      continue;
    }
    const key = raw.id.trim()
      ? `id:${raw.id.trim().toLowerCase()}`
      : `model:${provider.toLowerCase()}\u0000${modelName.toLowerCase()}\u0000${baseUrl.toLowerCase()}`;
    if (!seen.add(key)) {
      continue;
    }
    let id =
      raw.id.trim() || stableModelConfigId(provider, modelName, apiKey, baseUrl);
    let suffix = 2;
    const baseId = id;
    while (usedIds.has(id)) {
      id = `${baseId}-${suffix}`;
      suffix += 1;
    }
    usedIds.add(id);
    result.push({
      id,
      provider,
      apiKey,
      hasApiKey: raw.hasApiKey === true || Boolean(apiKey),
      apiKeyMasked: raw.apiKeyMasked?.trim() || undefined,
      modelName,
      baseUrl,
      ...(maxContextTokens ? { maxContextTokens } : {}),
      ...(maxCompletionTokens ? { maxCompletionTokens } : {}),
    });
  }
  return result;
}

function normalizeProvider(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized === 'google' ? 'gemini' : normalized;
}

function normalizeMaxContextTokens(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function stableModelConfigId(
  provider: string,
  modelName: string,
  apiKey: string,
  baseUrl: string,
) {
  const raw = `${provider}\u0000${modelName}\u0000${apiKey}\u0000${baseUrl}`.toLowerCase();
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `mm-${(hash >>> 0).toString(36)}`;
}

function effectiveModels(configs: ManagedModelConfig[]) {
  const seen = new Set<string>();
  return configs
    .filter((item) => item.id.trim() && seen.add(item.id.trim().toLowerCase()));
}

function defaultModelConfigId(configs: ManagedModelConfig[], selectedModel: string) {
  const selected = selectedModel.trim().toLowerCase();
  return (
    configs.find((item) => item.id.trim().toLowerCase() === selected)?.id ??
    configs.find((item) => item.modelName.trim().toLowerCase() === selected)?.id ??
    configs[0]?.id ??
    ''
  );
}

function modelConfigSignature(configs: ManagedModelConfig[], defaultModelId: string) {
  return JSON.stringify({
    defaultModelId,
    configs: normalizeManagedModelConfigs(configs),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function cssEscape(value: string) {
  return value.replace(/["\\]/g, '\\$&');
}

function cssImageUrl(value: string) {
  return `url("${cssEscape(value)}")`;
}

function backgroundImageUrl(value: string) {
  const cachedName = cachedBackgroundFileName(value);
  if (cachedName && window.cardbushDesktop) {
    return `cardbush-file://backgrounds/${encodeURIComponent(cachedName)}`;
  }
  return fileUrl(value);
}

function cachedBackgroundFileName(value: string) {
  const normalized = stripWrappingQuotes(value.trim()).replaceAll('\\', '/');
  if (!/\/backgrounds\//i.test(normalized)) {
    return '';
  }
  const fileName = normalized.split('/').filter(Boolean).pop() ?? '';
  return isImagePath(fileName) ? fileName : '';
}

function WindowFrame({
  language,
  onOpenBotSettings,
  onOpenCacheSettings,
  onOpenPluginSettings,
  onOpenTools,
  onOpenSkills,
  onOpenOs,
  onOpenTeam,
}: {
  language: AppLanguage;
  onOpenBotSettings: () => void;
  onOpenCacheSettings: () => void;
  onOpenPluginSettings: () => void;
  onOpenTools: () => void;
  onOpenSkills: () => void;
  onOpenOs: () => void;
  onOpenTeam: () => void;
}) {
  const [maximized, setMaximized] = useState(false);
  const [openMenu, setOpenMenu] = useState<'plugins' | 'beta' | null>(null);
  const menuRootRef = useRef<HTMLDivElement | null>(null);

  const syncMaximized = useCallback(() => {
    void window.cardbushDesktop
      ?.isMaximized()
      .then(setMaximized)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    syncMaximized();
    window.addEventListener('resize', syncMaximized);
    return () => window.removeEventListener('resize', syncMaximized);
  }, [syncMaximized]);

  useEffect(() => {
    if (!openMenu) return undefined;
    const closeFromPointer = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !menuRootRef.current?.contains(event.target)) {
        setOpenMenu(null);
      }
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenMenu(null);
    };
    document.addEventListener('pointerdown', closeFromPointer);
    document.addEventListener('keydown', closeFromKeyboard);
    return () => {
      document.removeEventListener('pointerdown', closeFromPointer);
      document.removeEventListener('keydown', closeFromKeyboard);
    };
  }, [openMenu]);

  const runMenuAction = useCallback((action: () => void) => {
    setOpenMenu(null);
    action();
  }, []);

  async function toggleMaximize() {
    await window.cardbushDesktop?.toggleMaximize();
    syncMaximized();
  }

  return (
    <header className="window-frame window-drag">
      <div className="window-brand">
        <span>cardbush</span>
      </div>
      <div className="window-separator">|</div>
      <button className="bot-chip no-drag" type="button" onClick={onOpenBotSettings}>
        BOT
      </button>
      <button
        className="bot-chip cache-chip no-drag"
        type="button"
        onClick={onOpenCacheSettings}
      >
        {language === 'zh' ? '缓存' : 'Cache'}
      </button>
      <div className="window-frame-menu-group no-drag" ref={menuRootRef}>
        <WindowFrameMenu
          label={language === 'zh' ? '插件' : 'Plugins'}
          open={openMenu === 'plugins'}
          onToggle={() => setOpenMenu((current) => current === 'plugins' ? null : 'plugins')}
        >
          <WindowFrameMenuItem
            icon={<Plug size={14} />}
            label={language === 'zh' ? '插件管理' : 'Plugin management'}
            onClick={() => runMenuAction(onOpenPluginSettings)}
          />
          <WindowFrameMenuItem
            icon={<Wrench size={14} />}
            label={language === 'zh' ? '工具管理' : 'Tool management'}
            onClick={() => runMenuAction(onOpenTools)}
          />
          <WindowFrameMenuItem
            icon={<Puzzle size={14} />}
            label={language === 'zh' ? '技能管理' : 'Skill management'}
            onClick={() => runMenuAction(onOpenSkills)}
          />
        </WindowFrameMenu>
        <WindowFrameMenu
          label="Beta"
          open={openMenu === 'beta'}
          onToggle={() => setOpenMenu((current) => current === 'beta' ? null : 'beta')}
        >
          <WindowFrameMenuItem
            icon={<MonitorCog size={14} />}
            label="OS"
            onClick={() => runMenuAction(onOpenOs)}
          />
          <WindowFrameMenuItem
            icon={<Flag size={14} />}
            label="Team"
            onClick={() => runMenuAction(onOpenTeam)}
          />
        </WindowFrameMenu>
      </div>
      <div className="window-spacer" />
      <WindowButton
        label={language === 'zh' ? '最小化' : 'Minimize'}
        onClick={() => window.cardbushDesktop?.minimize()}
      >
        <span className="window-glyph minimize" aria-hidden="true" />
      </WindowButton>
      <WindowButton
        label={
          maximized
            ? language === 'zh' ? '还原窗口' : 'Restore'
            : language === 'zh' ? '最大化' : 'Maximize'
        }
        onClick={() => void toggleMaximize()}
      >
        <span
          className={`window-glyph ${maximized ? 'restore' : 'maximize'}`}
          aria-hidden="true"
        />
      </WindowButton>
      <WindowButton
        label={language === 'zh' ? '关闭' : 'Close'}
        danger
        onClick={() => window.cardbushDesktop?.closeToTray()}
      >
        <span className="window-glyph close" aria-hidden="true" />
      </WindowButton>
    </header>
  );
}

function WindowFrameMenu({
  label,
  open,
  onToggle,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="window-frame-menu">
      <button
        className="bot-chip window-frame-menu-trigger no-drag"
        type="button"
        aria-expanded={open}
        onClick={onToggle}
      >
        <span>{label}</span>
      </button>
      {open && (
        <div className="window-frame-menu-popover no-drag" role="menu">
          {children}
        </div>
      )}
    </div>
  );
}

function WindowFrameMenuItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button type="button" role="menuitem" onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function WindowButton({
  label,
  danger,
  onClick,
  children,
}: {
  label: string;
  danger?: boolean;
  onClick?: () => void | Promise<void>;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`window-button no-drag ${danger ? 'danger' : ''}`}
      aria-label={label}
      title={label}
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function normalizeMaxCompletionTokens(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function FeaturePanelLoading({ language }: { language: AppLanguage }) {
  return (
    <div className="feature-content feature-loading">
      <LoaderCircle size={18} />
      <span>{language === 'zh' ? '正在加载...' : 'Loading...'}</span>
    </div>
  );
}

function highestReasoningLevel(levels: ReasoningLevel[]): ReasoningLevel {
  const available = new Set(levels);
  return (['max', 'high', 'medium', 'low'] as const).find((level) =>
    available.has(level)
  ) ?? 'max';
}

function useOsGamepadNavigation(
  enabled: boolean,
  mapping: AppSettingsState['os']['gamepad'],
  actions: {
    openSettings: () => void;
    openApps: () => void;
    toggleKeyboard: () => void;
    goBack: () => void;
  },
) {
  const [connected, setConnected] = useState(false);
  const [active, setActive] = useState(false);
  const mappingRef = useRef(mapping);
  const actionsRef = useRef(actions);
  const connectedRef = useRef(false);
  const previousButtonsRef = useRef<boolean[]>([]);
  const lastMoveAtRef = useRef(0);
  mappingRef.current = mapping;
  actionsRef.current = actions;

  useEffect(() => {
    if (!enabled || typeof navigator.getGamepads !== 'function') {
      setConnected(false);
      setActive(false);
      return undefined;
    }

    let frame = 0;
    const visibleControls = () =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          '.os-chat-panel button:not([disabled]), .os-chat-panel textarea:not([disabled]), .os-chat-panel [data-os-control="true"]',
        ),
      ).filter((element, index, items) => {
        if (items.indexOf(element) !== index) {
          return false;
        }
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden';
      });

    const primaryInput = () =>
      document.querySelector<HTMLTextAreaElement>(
        '.os-chat-panel textarea[data-os-primary-input="true"]',
      );

    const focusDirection = (x: number, y: number) => {
      const controls = visibleControls();
      if (controls.length === 0) {
        return;
      }
      const current = document.activeElement as HTMLElement | null;
      if (!current || !controls.includes(current)) {
        (primaryInput() ?? controls[0])?.focus({ preventScroll: true });
        return;
      }
      const origin = current.getBoundingClientRect();
      const originX = origin.left + origin.width / 2;
      const originY = origin.top + origin.height / 2;
      let best: { element: HTMLElement; score: number } | null = null;
      for (const element of controls) {
        if (element === current) {
          continue;
        }
        const rect = element.getBoundingClientRect();
        const dx = rect.left + rect.width / 2 - originX;
        const dy = rect.top + rect.height / 2 - originY;
        const forward = dx * x + dy * y;
        if (forward <= 4) {
          continue;
        }
        const sideways = Math.abs(dx * y - dy * x);
        const score = forward + sideways * 2.4;
        if (!best || score < best.score) {
          best = { element, score };
        }
      }
      best?.element.focus({ preventScroll: true });
    };

    const press = (buttons: readonly GamepadButton[], index: number) => {
      const down = buttons[index]?.pressed === true;
      const wasDown = previousButtonsRef.current[index] === true;
      previousButtonsRef.current[index] = down;
      return down && !wasDown;
    };

    const poll = () => {
      const gamepad = Array.from(navigator.getGamepads()).find(Boolean) ?? null;
      const isConnected = Boolean(gamepad?.connected);
      if (connectedRef.current !== isConnected) {
        connectedRef.current = isConnected;
        setConnected(isConnected);
        if (!isConnected) {
          setActive(false);
          previousButtonsRef.current = [];
        }
      }
      if (gamepad) {
        const buttons = gamepad.buttons;
        const now = performance.now();
        const horizontal = Math.abs(gamepad.axes[0] ?? 0) > 0.58 ? Math.sign(gamepad.axes[0]) : 0;
        const vertical = Math.abs(gamepad.axes[1] ?? 0) > 0.58 ? Math.sign(gamepad.axes[1]) : 0;
        const left = buttons[14]?.pressed || horizontal < 0;
        const right = buttons[15]?.pressed || horizontal > 0;
        const up = buttons[12]?.pressed || vertical < 0;
        const down = buttons[13]?.pressed || vertical > 0;
        if ((left || right || up || down) && now - lastMoveAtRef.current > 180) {
          lastMoveAtRef.current = now;
          setActive(true);
          focusDirection(left ? -1 : right ? 1 : 0, up ? -1 : down ? 1 : 0);
        }
        if (press(buttons, mappingRef.current.confirmButton)) {
          setActive(true);
          const focused = document.activeElement as HTMLElement | null;
          if (focused?.matches('button, [role="button"]')) {
            focused.click();
          } else {
            focused?.focus();
          }
        }
        if (press(buttons, mappingRef.current.backButton)) {
          setActive(true);
          actionsRef.current.goBack();
        }
        if (press(buttons, mappingRef.current.keyboardButton)) {
          setActive(true);
          actionsRef.current.toggleKeyboard();
        }
        if (press(buttons, mappingRef.current.appsButton)) {
          setActive(true);
          actionsRef.current.openApps();
        }
        if (press(buttons, mappingRef.current.settingsButton)) {
          setActive(true);
          actionsRef.current.openSettings();
        }
        const scrollAxis = gamepad.axes[3] ?? 0;
        if (Math.abs(scrollAxis) > 0.42) {
          const scroller = document.querySelector<HTMLElement>('.os-chat-panel .message-list');
          scroller?.scrollBy({ top: scrollAxis * 14, behavior: 'auto' });
        }
      }
      frame = window.requestAnimationFrame(poll);
    };

    const usePointer = () => setActive(false);
    window.addEventListener('pointerdown', usePointer, { passive: true });
    frame = window.requestAnimationFrame(poll);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('pointerdown', usePointer);
    };
  }, [enabled]);

  return { connected, active };
}

function ChatPanel({
  language,
  title,
  osModeEnabled,
  osRuntimeAvailable,
  osSettings,
  onlyTalkMode,
  onOsSettingsChange,
  onExitOsMode,
  sidebarCollapsed,
  inspectorOpen,
  windowMaximized,
  onRevealSidebar,
  activeConversationId,
  activeProjectDir,
  selectedProjectDir,
  availableProjects,
  onWelcomeProjectChange,
  projectContext,
  messages,
  activeGoal,
  goalAvailable,
  goalCancelling,
  goalWaiting,
  changeReports,
  skills,
  disabledSkillNames,
  visualInputAvailable,
  visualInputEnabled,
  contextSearchAvailable,
  subagentObservabilityAvailable,
  shadowAvailable,
  shadowAccentColor,
  thinkingNotice,
  thinkingVisible,
  guidanceDeliveryMode,
  terminalRuntime,
  loading,
  sending,
  stopping,
  activeTurnId,
  connectionRecovery,
  queuedMessageCount,
  queuedMessagePreview,
  queuedMessages,
  pendingInteraction,
  error,
  notice,
  selectedModel,
  selectedModelConfig,
  contextWindowMaxTokens,
  contextWindowUsage,
  availableModels,
  referencePlanAvailable,
  referencePlanMode,
  permissionMode,
  reasoningLevelAvailable,
  reasoningLevel,
  reasoningLevels,
  botHandoffAvailable,
  gitAvailable,
  terminalAvailable,
  onModelChange,
  onReferencePlanModeChange,
  onPermissionModeChange,
  onReasoningLevelChange,
  onConfigureModels,
  onCreateConversation,
  onSaveProjectContext,
  onToggleSkill,
  onVisualInputEnabledChange,
  onCreateSessionShareLink,
  onRefreshActiveSession,
  onSend,
  onRetryMessage,
  onRegenerate,
  onEditUserMessage,
  onGuideMessage,
  onRetryGuidance,
  onGuideQueuedMessage,
  onRemoveQueuedMessage,
  onRevertChangeReport,
  onOpenChangeReview,
  onReplyInteraction,
  onCancelInteraction,
  onCancelGoal,
  onCancel,
  onClearError,
  onClearNotice,
  draft,
  onDraftChange,
}: {
  language: AppLanguage;
  title: string;
  osModeEnabled: boolean;
  osRuntimeAvailable: boolean;
  osSettings: AppSettingsState['os'];
  onlyTalkMode: boolean;
  onOsSettingsChange: (settings: AppSettingsState['os']) => void;
  onExitOsMode: () => void;
  sidebarCollapsed: boolean;
  inspectorOpen: boolean;
  windowMaximized: boolean;
  onRevealSidebar: () => void;
  activeConversationId: string;
  activeProjectDir?: string;
  selectedProjectDir: string;
  availableProjects: ProjectItem[];
  onWelcomeProjectChange: (projectDir: string | null) => Promise<void>;
  projectContext: string;
  messages: ChatMessage[];
  activeGoal: ExperimentalGoal | null;
  goalAvailable: boolean;
  goalCancelling: boolean;
  goalWaiting: boolean;
  changeReports: ConversationChangeReport[];
  skills: SkillSummary[];
  disabledSkillNames: Set<string>;
  visualInputAvailable: boolean;
  visualInputEnabled: boolean;
  contextSearchAvailable: boolean;
  subagentObservabilityAvailable: boolean;
  shadowAvailable: boolean;
  shadowAccentColor: string;
  thinkingNotice: ThinkingNotice | null;
  thinkingVisible: boolean;
  guidanceDeliveryMode: AppSettingsState['guidance']['deliveryMode'];
  terminalRuntime: TerminalRuntime;
  loading: boolean;
  sending: boolean;
  stopping: boolean;
  activeTurnId: string;
  connectionRecovery?: RuntimeConnectionUpdate;
  queuedMessageCount: number;
  queuedMessagePreview: string;
  queuedMessages: QueuedChatMessage[];
  pendingInteraction: PendingInteraction | null;
  error: string | null;
  notice: string | null;
  selectedModel: string;
  selectedModelConfig?: ManagedModelConfig;
  contextWindowMaxTokens?: number;
  contextWindowUsage?: RuntimeContextWindowUsage;
  availableModels: ManagedModelConfig[];
  referencePlanAvailable: boolean;
  referencePlanMode: ReferencePlanMode;
  permissionMode: PermissionMode;
  reasoningLevelAvailable: boolean;
  reasoningLevel: ReasoningLevel;
  reasoningLevels: ReasoningLevel[];
  botHandoffAvailable: boolean;
  gitAvailable: boolean;
  terminalAvailable: boolean;
  onModelChange: (value: string) => void;
  onReferencePlanModeChange: (value: ReferencePlanMode) => void;
  onPermissionModeChange: (value: PermissionMode) => void;
  onReasoningLevelChange: (value: ReasoningLevel) => void;
  onConfigureModels: () => void;
  onCreateConversation: () => void;
  onSaveProjectContext: (value: string) => Promise<string>;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  onVisualInputEnabledChange: (enabled: boolean) => void;
  onCreateSessionShareLink: (
    request: SessionShareLinkRequest,
  ) => Promise<SessionShareLinkResult>;
  onRefreshActiveSession: RefreshActiveSession;
  onSend: (text: string) => Promise<void>;
  onRetryMessage: (message: ChatMessage) => Promise<void>;
  onRegenerate: (message: ChatMessage) => Promise<void>;
  onEditUserMessage: (message: ChatMessage, content: string) => Promise<void>;
  onGuideMessage: (
    message: ChatMessage,
    guidance: string,
    mode: 'append_context' | 'interrupt_and_continue',
  ) => Promise<void>;
  onRetryGuidance: (message: ChatMessage) => Promise<void>;
  onGuideQueuedMessage: (
    queuedId: string,
    mode?: 'append_context' | 'interrupt_and_continue',
  ) => Promise<void>;
  onRemoveQueuedMessage: (queuedId: string) => void;
  onRevertChangeReport: (
    report: ConversationChangeReport,
    message: ChatMessage,
  ) => Promise<void>;
  onOpenChangeReview: (filePath?: string) => void;
  onReplyInteraction: (reply: string | InteractionReplyAnswer[]) => Promise<void>;
  onCancelInteraction: () => Promise<void>;
  onCancelGoal: () => Promise<void>;
  onCancel: () => Promise<void>;
  onClearError: () => void;
  onClearNotice: () => void;
  draft: string;
  onDraftChange: (value: string) => void;
}) {
  const renderMessages = useMemo(() => {
    const normalized = normalizeChatMessagesForDisplay(messages);
    return sending
      ? normalizeActiveTurnTranscriptForDisplay(normalized, activeTurnId)
      : normalized;
  }, [activeTurnId, messages, sending]);
  const [refreshError, setRefreshError] = useState('');
  const refreshBackendWithFeedback = useCallback(async (
    options?: { silent?: boolean },
  ) => {
    try {
      await onRefreshActiveSession(options);
      setRefreshError('');
    } catch (caught) {
      setRefreshError(
        language === 'zh'
          ? '无法连接 BushServer，请检查后端是否正在运行。'
          : 'Unable to connect to BushServer. Check whether the backend is running.',
      );
      throw caught;
    }
  }, [language, onRefreshActiveSession]);
  const currentTurnChangeReports = useMemo(() => {
    if (changeReports.length === 0) return [];
    const active = activeTurnId.trim();
    const latest = changeReports[changeReports.length - 1];
    const targetTurn = active || latest?.turnId?.trim() || '';
    if (!targetTurn) return latest ? [latest] : [];
    const matching = changeReports.filter(
      (report) => report.turnId?.trim() === targetTurn,
    );
    return matching.length > 0 ? matching : active ? [] : latest ? [latest] : [];
  }, [activeTurnId, changeReports]);
  const currentTurnChangeSummary = useMemo(
    () => summarizeChangeReports(currentTurnChangeReports),
    [currentTurnChangeReports],
  );
  const activeRuntimeAssistant = useMemo(
    () => sending
      ? streamingAssistantMessage(renderMessages, activeTurnId)?.message ?? null
      : null,
    [activeTurnId, renderMessages, sending],
  );
  const activeTaskPlan = useMemo(() => {
    if (!activeRuntimeAssistant) return undefined;
    if (activeRuntimeAssistant.taskPlan) return activeRuntimeAssistant.taskPlan;
    return [...(activeRuntimeAssistant.loopHistory ?? [])]
      .reverse()
      .find((message) => message.taskPlan)?.taskPlan;
  }, [activeRuntimeAssistant]);
  const activeGoalRounds = useMemo(() => {
    if (!activeRuntimeAssistant) return [];
    const transcript = [
      ...(activeRuntimeAssistant.loopHistory ?? []),
      activeRuntimeAssistant,
    ];
    const seen = new Set<string>();
    return transcript.flatMap((message) => message.toolExecutions ?? [])
      .map((execution) => ({ execution, update: goalToolUpdateFromExecution(execution) }))
      .filter(({ execution, update }) => {
        if (!update || seen.has(execution.id)) return false;
        seen.add(execution.id);
        return true;
      })
      .map(({ update }) => update!);
  }, [activeRuntimeAssistant]);
  const showWelcome = !loading && renderMessages.length === 0;
  const listScrollerRef = useRef<HTMLElement | null>(null);
  const chatBodyRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const scrollBottomButtonRef = useRef<HTMLButtonElement>(null);
  const atBottomRef = useRef(true);
  const autoFollowStreamRef = useRef(true);
  const userDetachedFromBottomRef = useRef(false);
  const showScrollBottomRef = useRef(false);
  const pendingSubmittedUserFocusRef = useRef(false);
  const pendingSubmittedUserEntryUntilRef = useRef(0);
  const userMessageEntryTimersRef = useRef<Map<string, number>>(new Map());
  const programmaticScrollUntilRef = useRef(0);
  const manualScrollDetachUntilRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const lastWheelEventAtRef = useRef(0);
  const handledWheelEventsRef = useRef<WeakSet<globalThis.WheelEvent>>(new WeakSet());
  const scrollbarDragActiveRef = useRef(false);
  const scrollbarDragUntilRef = useRef(0);
  const listScrollerWheelCleanupRef = useRef<(() => void) | null>(null);
  const scrollBottomWheelCleanupRef = useRef<(() => void) | null>(null);
  const lastWheelLockRef = useRef<{
    at: number;
    source: string;
    scrollTop: number;
  } | null>(null);
  const latestConversationScrollRef = useRef<{
    conversationId: string;
    latestMessageId: string;
  }>({
    conversationId: '',
    latestMessageId: '',
  });

  useEffect(() => {
    if (!notice) {
      return undefined;
    }
    const timer = window.setTimeout(onClearNotice, 4200);
    return () => window.clearTimeout(timer);
  }, [notice, onClearNotice]);
  const messageSnapshotRef = useRef<{ conversationId: string; ids: string[] }>({
    conversationId: '',
    ids: [],
  });
  const streamScrollFrameRef = useRef<number | null>(null);
  const outerResizeFollowFrameRef = useRef<number | null>(null);
  const scrollTraceSequenceRef = useRef(0);
  const activeScrollTraceIdRef = useRef('');
  const scrollTraceObserveUntilRef = useRef(0);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [enteringUserMessageIds, setEnteringUserMessageIds] = useState<Set<string>>(
    () => new Set(),
  );
  const pendingSubmittedUserEntryMessageId = (() => {
    if (Date.now() > pendingSubmittedUserEntryUntilRef.current) return '';
    const previous = messageSnapshotRef.current;
    const previousIds = previous.conversationId === activeConversationId
      ? new Set(previous.ids)
      : new Set<string>();
    for (let index = renderMessages.length - 1; index >= 0; index -= 1) {
      const message = renderMessages[index];
      if (message?.role === 'user' && !previousIds.has(message.id)) {
        return message.id;
      }
    }
    return '';
  })();
  const [consoleMode, setConsoleMode] = useState<ConsoleMode | null>(null);
  const [shadowThreadOpen, setShadowThreadOpen] = useState(false);
  const [thinkingOpen, setThinkingOpen] = useState(false);
  const [shadowConversation, setShadowConversation] =
    useState<ShadowConversationRecord | null>(null);
  const [shadowDraft, setShadowDraft] = useState('');
  const [shadowEntries, setShadowEntries] = useState<ShadowChatEntry[]>([]);
  const [shadowError, setShadowError] = useState('');
  const [shadowReplying, setShadowReplying] = useState(false);
  const shadowAbortControllerRef = useRef<AbortController | null>(null);
  const [osSystemSurface, setOsSystemSurface] = useState<OsSystemSurfaceMode | null>(null);
  const [osNineKeyOpen, setOsNineKeyOpen] = useState(false);
  const [osSettingsOpen, setOsSettingsOpen] = useState(false);
  const [osLaunchedApplications, setOsLaunchedApplications] = useState<OsApplication[]>([]);
  const [osPinnedApplications, setOsPinnedApplications] = useState<OsApplication[]>(
    readStoredOsPinnedApplications,
  );
  const [osDesktopNotice, setOsDesktopNotice] = useState<{
    tone: 'neutral' | 'error';
    text: string;
  } | null>(null);

  useEffect(() => {
    shadowAbortControllerRef.current?.abort();
    shadowAbortControllerRef.current = null;
    setShadowThreadOpen(false);
    setShadowConversation(null);
    setShadowDraft('');
    setShadowEntries([]);
    setShadowError('');
    setShadowReplying(false);
  }, [activeConversationId]);

  useEffect(() => {
    setThinkingOpen(false);
  }, [thinkingNotice?.id]);

  const shadowCanActivate = shadowAvailable && Boolean(activeConversationId) &&
    messages.some((message) => message.role === 'user');

  const closeShadowThread = useCallback(() => {
    shadowAbortControllerRef.current?.abort();
    shadowAbortControllerRef.current = null;
    const conversationId = shadowConversation?.id ?? '';
    setShadowThreadOpen(false);
    setShadowConversation(null);
    setShadowDraft('');
    setShadowEntries([]);
    setShadowError('');
    setShadowReplying(false);
    if (conversationId) {
      void closeShadowConversation(conversationId).catch(() => undefined);
    }
  }, [shadowConversation?.id]);

  const toggleShadowThread = useCallback(async () => {
    if (shadowThreadOpen) {
      closeShadowThread();
      return;
    }
    if (!shadowCanActivate || shadowReplying) return;
    setThinkingOpen(false);
    setShadowThreadOpen(true);
    setShadowError('');
    if (shadowConversation) return;
    setShadowReplying(true);
    try {
      const conversation = await createShadowConversation({
        sessionId: activeConversationId,
        sourceTurnId: activeTurnId,
        clientConversationId: crypto.randomUUID(),
      });
      setShadowConversation(conversation);
    } catch (error) {
      setShadowError(error instanceof Error ? error.message : String(error));
    } finally {
      setShadowReplying(false);
    }
  }, [
    activeConversationId,
    activeTurnId,
    closeShadowThread,
    shadowCanActivate,
    shadowConversation,
    shadowReplying,
    shadowThreadOpen,
  ]);

  const sendShadowReply = useCallback(async (text: string) => {
    const reply = text.trim();
    if (!shadowConversation || !reply || shadowReplying) return;
    if (!selectedModelConfig) {
      setShadowError(`No model configuration found for ${selectedModel}`);
      return;
    }
    const userEntry: ShadowChatEntry = {
      id: crypto.randomUUID(),
      role: 'user',
      content: reply,
      createdAt: new Date().toISOString(),
    };
    const assistantEntryId = crypto.randomUUID();
    setShadowEntries((current) => [
      ...current,
      userEntry,
      {
        id: assistantEntryId,
        role: 'assistant',
        content: '',
        createdAt: new Date().toISOString(),
      },
    ]);
    setShadowDraft('');
    setShadowError('');
    setShadowReplying(true);
    const controller = new AbortController();
    shadowAbortControllerRef.current = controller;
    try {
      await streamShadowConversationMessage({
        conversationId: shadowConversation.id,
        content: reply,
        clientMessageId: userEntry.id,
        modelConfig: selectedModelConfig,
        reasoningLevel,
        signal: controller.signal,
        onDelta: (delta) => {
          setShadowEntries((current) => current.map((entry) =>
            entry.id === assistantEntryId
              ? { ...entry, content: `${entry.content}${delta}` }
              : entry
          ));
        },
        onDone: (message) => {
          setShadowEntries((current) => current.map((entry) =>
            entry.id === assistantEntryId
              ? { ...entry, content: message.content || entry.content, createdAt: message.createdAt }
              : entry
          ));
        },
      });
    } catch (error) {
      if (!controller.signal.aborted) {
        setShadowError(error instanceof Error ? error.message : String(error));
      }
    } finally {
      if (shadowAbortControllerRef.current === controller) {
        shadowAbortControllerRef.current = null;
      }
      setShadowReplying(false);
    }
  }, [
    reasoningLevel,
    selectedModel,
    selectedModelConfig,
    shadowConversation,
    shadowReplying,
  ]);
  const osApplicationLaunchGraceRef = useRef(new Map<string, number>());
  const osPinnedApplicationIds = useMemo(
    () => new Set(osPinnedApplications.map((application) => application.id)),
    [osPinnedApplications],
  );
  const osTaskbarApplications = useMemo(
    () => [...osPinnedApplications, ...osLaunchedApplications]
      .filter((application, index, all) =>
        all.findIndex((candidate) => candidate.id === application.id) === index)
      .slice(0, 12),
    [osLaunchedApplications, osPinnedApplications],
  );
  const osRunningApplicationIds = useMemo(
    () => new Set(osLaunchedApplications.map((application) => application.id)),
    [osLaunchedApplications],
  );

  useEffect(() => {
    window.localStorage.setItem(
      'cardbush_os_pinned_applications',
      JSON.stringify(osPinnedApplications),
    );
  }, [osPinnedApplications]);

  const toggleOsPinnedApplication = useCallback((application: OsApplication) => {
    setOsPinnedApplications((current) => current.some((item) => item.id === application.id)
      ? current.filter((item) => item.id !== application.id)
      : [...current, application].slice(0, 12));
  }, []);
  const [composerDockHeight, setComposerDockHeight] = useState(0);
  const [quickContextBottomInset, setQuickContextBottomInset] = useState(0);
  const [activeScene, setActiveScene] = useState<CardlingScene | null>(null);
  const [availableScene, setAvailableScene] = useState<CardlingScene | null>(null);
  const [activeSceneInitialAutoPlay, setActiveSceneInitialAutoPlay] = useState(false);
  const activeSceneKeyRef = useRef('');
  const activeSceneRevisionRef = useRef('');
  const dismissedSceneKeysRef = useRef(new Set<string>());
  const autoPlayedSceneKeysRef = useRef(new Set<string>());
  const streamStatusHeight = 0;
  useEffect(() => {
    if (!osModeEnabled) {
      setOsSystemSurface(null);
      setOsNineKeyOpen(false);
      setOsSettingsOpen(false);
    }
  }, [osModeEnabled]);

  useEffect(() => {
    if (!osModeEnabled || (!osNineKeyOpen && !osSettingsOpen)) {
      return;
    }
    const closeOsOverlays = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('.os-system-surface, .os-nine-key, .os-control-center, [data-os-overlay-trigger="true"]')) {
        return;
      }
      setOsNineKeyOpen(false);
      setOsSettingsOpen(false);
    };
    window.addEventListener('pointerdown', closeOsOverlays, true);
    return () => window.removeEventListener('pointerdown', closeOsOverlays, true);
  }, [osModeEnabled, osNineKeyOpen, osSettingsOpen]);

  const rememberLaunchedApplication = useCallback((application: OsApplication) => {
    osApplicationLaunchGraceRef.current.set(application.id, Date.now() + 10_000);
    setOsLaunchedApplications((current) => {
      const existingIndex = current.findIndex((item) => item.id === application.id);
      if (existingIndex < 0) return [...current, application].slice(0, 7);
      return current.map((item, index) => index === existingIndex ? application : item);
    });
  }, []);

  const refreshOsRunningApplications = useCallback(async () => {
    const request = window.cardbushDesktop?.osRunningApplications?.();
    const running = request ? await request.catch(() => null) : null;
    if (!running) return;
    const now = Date.now();
    setOsLaunchedApplications((current) => {
      const runningById = new Map(running.map((application) => [application.id, application]));
      const stableApplications = current.flatMap((application) => {
        const runningApplication = runningById.get(application.id);
        if (runningApplication) {
          runningById.delete(application.id);
          osApplicationLaunchGraceRef.current.delete(application.id);
          return [runningApplication];
        }
        const graceUntil = osApplicationLaunchGraceRef.current.get(application.id) ?? 0;
        if (graceUntil > now) return [application];
        osApplicationLaunchGraceRef.current.delete(application.id);
        return [];
      });
      return [...stableApplications, ...runningById.values()].slice(0, 7);
    });
  }, []);

  useEffect(() => {
    if (!osModeEnabled) return undefined;
    void refreshOsRunningApplications();
    const timer = window.setInterval(() => {
      void refreshOsRunningApplications();
    }, 4_500);
    return () => window.clearInterval(timer);
  }, [osModeEnabled, refreshOsRunningApplications]);

  const launchOsApplication = useCallback(async (application: OsApplication) => {
    rememberLaunchedApplication(application);
    setOsDesktopNotice({
      tone: 'neutral',
      text: language === 'zh' ? `正在打开 ${application.name}` : `Opening ${application.name}`,
    });
    try {
      const result = await window.cardbushDesktop?.osLaunchApplication?.(application.id);
      setOsDesktopNotice({
        tone: 'neutral',
        text: result?.status === 'focused'
          ? language === 'zh' ? `已切换到 ${application.name}` : `Switched to ${application.name}`
          : language === 'zh' ? `${application.name} 已启动` : `${application.name} launched`,
      });
      window.setTimeout(() => void refreshOsRunningApplications(), 900);
    } catch (error) {
      osApplicationLaunchGraceRef.current.delete(application.id);
      setOsLaunchedApplications((current) =>
        current.filter((item) => item.id !== application.id));
      setOsDesktopNotice({
        tone: 'error',
        text: error instanceof Error ? error.message : String(error),
      });
    }
  }, [language, refreshOsRunningApplications, rememberLaunchedApplication]);

  useEffect(() => {
    if (!osDesktopNotice) return undefined;
    const timer = window.setTimeout(() => setOsDesktopNotice(null), 3200);
    return () => window.clearTimeout(timer);
  }, [osDesktopNotice]);

  const toggleOsSurface = useCallback((surface: OsSystemSurfaceMode) => {
    setOsNineKeyOpen(false);
    setOsSettingsOpen(false);
    setOsSystemSurface((current) => current === surface ? null : surface);
  }, []);

  const toggleOsSettings = useCallback(() => {
    setOsSystemSurface(null);
    setOsNineKeyOpen(false);
    setOsSettingsOpen((current) => !current);
  }, []);

  const osGamepad = useOsGamepadNavigation(osModeEnabled, osSettings.gamepad, {
    openSettings: () => setOsSettingsOpen(true),
    openApps: () => setOsSystemSurface('apps'),
    toggleKeyboard: () => setOsNineKeyOpen((current) => !current),
    goBack: () => {
      if (osNineKeyOpen) setOsNineKeyOpen(false);
      else if (osSystemSurface) setOsSystemSurface(null);
    },
  });

  const setScrollBottomVisible = useCallback((visible: boolean) => {
    showScrollBottomRef.current = visible;
    setShowScrollBottom(visible);
  }, []);

  const readBottomMetrics = useCallback((scroller: HTMLElement): ScrollBottomMetrics => {
    const absoluteBottomDistance = absoluteBottomScrollTop(scroller) - scroller.scrollTop;
    const visualBottomDistance =
      visualBottomScrollTop(scroller, composerDockHeight, streamStatusHeight) -
      scroller.scrollTop;
    const visualNearBottom =
      visualBottomDistance <= scrollBottomLockTolerance ||
      absoluteBottomDistance <= scrollBottomLockTolerance;
    const visualAtBottom =
      visualBottomDistance <= scrollBottomWheelLockTolerance ||
      absoluteBottomDistance <= scrollBottomWheelLockTolerance;
    return {
      visualNearBottom,
      visualAtBottom,
      visualBottomDistance,
      absoluteBottomDistance,
      absoluteAtBottom:
        absoluteBottomDistance <= scrollBottomWheelLockTolerance,
    };
  }, [composerDockHeight, streamStatusHeight]);

  const captureScrollGeometry = useCallback(
    (label: string, extra: Record<string, unknown> = {}) => {
      const scroller = listScrollerRef.current;
      const chatBody = chatBodyRef.current;
      const frame = chatBody?.querySelector('.chat-content-frame');
      const footer = scroller?.querySelector('.message-list-footer');
      const dock = composerDockRef.current;
      const button = scrollBottomButtonRef.current;
      const rect = (element: Element | null | undefined) => {
        if (!(element instanceof HTMLElement)) return null;
        const value = element.getBoundingClientRect();
        return {
          x: Math.round(value.x),
          y: Math.round(value.y),
          width: Math.round(value.width),
          height: Math.round(value.height),
          bottom: Math.round(value.bottom),
          right: Math.round(value.right),
        };
      };
      const metrics = scroller ? readBottomMetrics(scroller) : null;
      scrollDebug(label, {
        traceId:
          Date.now() <= scrollTraceObserveUntilRef.current
            ? activeScrollTraceIdRef.current || null
            : null,
        conversationId: activeConversationId,
        sending,
        showScrollBottom: showScrollBottomRef.current,
        autoFollow: autoFollowStreamRef.current,
        userDetached: userDetachedFromBottomRef.current,
        atBottom: atBottomRef.current,
        composerDockHeight,
        scrollTop: scroller ? Math.round(scroller.scrollTop) : null,
        scrollHeight: scroller?.scrollHeight ?? null,
        clientHeight: scroller?.clientHeight ?? null,
        offsetWidth: scroller?.offsetWidth ?? null,
        clientWidth: scroller?.clientWidth ?? null,
        absoluteBottomDistance: metrics
          ? Math.round(metrics.absoluteBottomDistance)
          : null,
        visualBottomDistance: metrics
          ? Math.round(metrics.visualBottomDistance)
          : null,
        scrollerRect: rect(scroller),
        chatBodyRect: rect(chatBody),
        frameRect: rect(frame),
        composerRect: rect(dock),
        footerRect: rect(footer),
        buttonRect: rect(button),
        ...extra,
      });
    },
    [activeConversationId, composerDockHeight, readBottomMetrics, sending],
  );

  const isLatestMessageTailVisible = useCallback(
    (scroller: HTMLElement, tolerance = 36) => {
      const latestMessage = renderMessages[renderMessages.length - 1];
      if (!latestMessage) {
        return true;
      }
      return isMessageTailVisible(scroller, latestMessage.id, {
        composerDockHeight: quickContextBottomInset,
        streamStatusHeight,
        tolerance,
      });
    },
    [quickContextBottomInset, renderMessages, streamStatusHeight],
  );

  const shouldShowScrollBottomForMetrics = useCallback(
    (scroller: HTMLElement, metrics: ScrollBottomMetrics) => {
      if (metrics.visualNearBottom || metrics.absoluteAtBottom) {
        return false;
      }
      return !isLatestMessageTailVisible(scroller);
    },
    [isLatestMessageTailVisible],
  );

  const shouldShowScrollBottomForScroller = useCallback(
    (scroller: HTMLElement | null) => {
      if (!scroller) {
        return false;
      }
      return shouldShowScrollBottomForMetrics(scroller, readBottomMetrics(scroller));
    },
    [readBottomMetrics, shouldShowScrollBottomForMetrics],
  );

  const nativeWheelEvent = useCallback(
    (event: WheelEvent<HTMLElement> | globalThis.WheelEvent) =>
      'nativeEvent' in event ? event.nativeEvent : event,
    [],
  );

  const wheelAlreadyHandled = useCallback(
    (event: WheelEvent<HTMLElement> | globalThis.WheelEvent) =>
      handledWheelEventsRef.current.has(nativeWheelEvent(event)),
    [nativeWheelEvent],
  );

  const markWheelHandled = useCallback(
    (event: WheelEvent<HTMLElement> | globalThis.WheelEvent) => {
      handledWheelEventsRef.current.add(nativeWheelEvent(event));
    },
    [nativeWheelEvent],
  );

  const wheelTargetIsListSurface = useCallback((target: EventTarget | null) => {
    if (!(target instanceof Node)) {
      return false;
    }
    return Boolean(
      listScrollerRef.current?.contains(target) ||
        scrollBottomButtonRef.current?.contains(target),
    );
  }, []);

  const isPointerOnVerticalScrollbar = useCallback(
    (scroller: HTMLElement, event: ReactPointerEvent<HTMLElement>) => {
      const rect = scroller.getBoundingClientRect();
      const nativeScrollbarWidth = Math.max(0, scroller.offsetWidth - scroller.clientWidth);
      const scrollbarHitWidth = Math.max(18, nativeScrollbarWidth + 8);
      return (
        scroller.scrollHeight > scroller.clientHeight + 1 &&
        event.clientX >= rect.right - scrollbarHitWidth &&
        event.clientX <= rect.right + 2 &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      );
    },
    [],
  );

  const nextSceneInitialAutoPlay = useCallback(
    (scene: CardlingScene, allowAutoPlay: boolean) => {
      const key = cardlingSceneKey(scene);
      if (
        !allowAutoPlay ||
        !sceneAutoPlayEnabled(scene) ||
        autoPlayedSceneKeysRef.current.has(key)
      ) {
        return false;
      }
      autoPlayedSceneKeysRef.current.add(key);
      return true;
    },
    [],
  );

  const showScene = useCallback(
    (scene: CardlingScene, options?: { autoPlay?: boolean }) => {
      const key = cardlingSceneKey(scene);
      const revision = cardlingSceneRevisionKey(scene);
      setAvailableScene((current) =>
        current && cardlingSceneRevisionKey(current) === revision ? current : scene,
      );
      if (activeSceneKeyRef.current !== key) {
        activeSceneKeyRef.current = key;
        activeSceneRevisionRef.current = revision;
        setActiveSceneInitialAutoPlay(
          nextSceneInitialAutoPlay(scene, Boolean(options?.autoPlay)),
        );
        setActiveScene(scene);
      } else if (activeSceneRevisionRef.current !== revision) {
        activeSceneRevisionRef.current = revision;
        setActiveSceneInitialAutoPlay(false);
        setActiveScene(scene);
      }
    },
    [nextSceneInitialAutoPlay],
  );

  const openScene = useCallback((scene: CardlingScene) => {
    dismissedSceneKeysRef.current.delete(cardlingSceneKey(scene));
    showScene(scene);
  }, [showScene]);

  const closeScene = useCallback(() => {
    setActiveScene((current) => {
      if (current) {
        dismissedSceneKeysRef.current.add(cardlingSceneKey(current));
      }
      activeSceneKeyRef.current = '';
      activeSceneRevisionRef.current = '';
      return null;
    });
    setActiveSceneInitialAutoPlay(false);
  }, []);

  const positionMessageAtReadingAnchor = useCallback(
    (messageId: string) => {
      const scroller = listScrollerRef.current;
      if (!scroller) {
        return;
      }
      const item = scroller.querySelector(
        `[data-message-id="${cssEscape(messageId)}"]`,
      );
      if (!(item instanceof HTMLElement)) {
        return;
      }
      const scrollerRect = scroller.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      const desiredTop = Math.max(72, Math.round(scroller.clientHeight * 0.28));
      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const nextTop = Math.max(
        0,
        Math.min(
          maxTop,
          scroller.scrollTop + itemRect.top - scrollerRect.top - desiredTop,
        ),
      );
      if (
        import.meta.env.DEV &&
        nextTop === 0 &&
        itemRect.top - scrollerRect.top < desiredTop - 8
      ) {
        console.debug('[cardbush:message-anchor]', {
          messageId,
          currentScrollTop: Math.round(scroller.scrollTop),
          nextTop,
          maxTop,
          desiredTop,
          itemTop: Math.round(itemRect.top - scrollerRect.top),
          itemHeight: Math.round(itemRect.height),
          scrollerHeight: scroller.clientHeight,
          scrollHeight: scroller.scrollHeight,
        });
      }
      scroller.scrollTo({ top: nextTop, behavior: 'auto' });
    },
    [],
  );

  const focusSubmittedUserMessage = useCallback(
    (_index: number, messageId: string) => {
      pendingSubmittedUserFocusRef.current = false;
      programmaticScrollUntilRef.current = Date.now() + 1200;
      manualScrollDetachUntilRef.current = 0;
      autoFollowStreamRef.current = true;
      userDetachedFromBottomRef.current = false;
      setScrollBottomVisible(false);
      window.requestAnimationFrame(() => {
        positionMessageAtReadingAnchor(messageId);
        window.requestAnimationFrame(() => {
          positionMessageAtReadingAnchor(messageId);
        });
      });
    },
    [positionMessageAtReadingAnchor, setScrollBottomVisible],
  );

  const ensureMessageBottomVisible = useCallback(
    (messageId: string) => {
      const scroller = listScrollerRef.current;
      if (!scroller) {
        return;
      }
      const item = scroller.querySelector(
        `[data-message-id="${cssEscape(messageId)}"]`,
      );
      if (!(item instanceof HTMLElement)) {
        return;
      }
      const scrollerRect = scroller.getBoundingClientRect();
      const itemRect = item.getBoundingClientRect();
      const visibleBottom =
        scrollerRect.bottom - Math.max(0, quickContextBottomInset) - streamStatusHeight - 18;
      if (itemRect.bottom <= visibleBottom) {
        return;
      }
      const delta = Math.ceil(itemRect.bottom - visibleBottom);
      scroller.scrollBy({
        top: delta,
        behavior: gentleAutoFollowScrollBehavior(),
      });
    },
    [quickContextBottomInset, streamStatusHeight],
  );

  const cancelScheduledStreamFollow = useCallback(() => {
    if (streamScrollFrameRef.current == null) {
      return;
    }
    window.cancelAnimationFrame(streamScrollFrameRef.current);
    streamScrollFrameRef.current = null;
  }, []);

  const scheduleActiveAssistantFollow = useCallback(
    (messageId: string, _index: number) => {
      if (streamScrollFrameRef.current != null) {
        window.cancelAnimationFrame(streamScrollFrameRef.current);
      }
      programmaticScrollUntilRef.current = Date.now() + 900;
      streamScrollFrameRef.current = window.requestAnimationFrame(() => {
        streamScrollFrameRef.current = null;
        if (
          !autoFollowStreamRef.current ||
          userDetachedFromBottomRef.current ||
          Date.now() < manualScrollDetachUntilRef.current
        ) {
          return;
        }
        const scroller = listScrollerRef.current;
        const item = scroller?.querySelector(
          `[data-message-id="${cssEscape(messageId)}"]`,
        );
        if (!(item instanceof HTMLElement)) {
          window.requestAnimationFrame(() => {
            if (
              autoFollowStreamRef.current &&
              !userDetachedFromBottomRef.current &&
              Date.now() >= manualScrollDetachUntilRef.current
            ) {
              ensureMessageBottomVisible(messageId);
            }
          });
          return;
        }
        ensureMessageBottomVisible(messageId);
      });
    },
    [composerDockHeight, ensureMessageBottomVisible, streamStatusHeight],
  );

  const restoreWheelLockedScrollTop = useCallback(
    (
      scroller: HTMLElement,
      lockedScrollTop: number,
    ) => {
      if (Math.abs(scroller.scrollTop - lockedScrollTop) >= 0.5) {
        scroller.scrollTop = lockedScrollTop;
      }
    },
    [],
  );

  const resolveWheelLockedScrollTop = useCallback(
    (
      source: string,
      scroller: HTMLElement,
      metrics: { visualNearBottom: boolean },
    ) => {
      const now = Date.now();
      const previous = lastWheelLockRef.current;
      const reusePrevious =
        previous &&
        now - previous.at < scrollBottomWheelFreezeMs &&
        metrics.visualNearBottom &&
        Math.abs(scroller.scrollTop - previous.scrollTop) <=
          scrollBottomLockTolerance * 2;
      const scrollTop = reusePrevious ? previous.scrollTop : scroller.scrollTop;
      const anchor = {
        at: now,
        source,
        scrollTop,
      };
      lastWheelLockRef.current = anchor;
      return scrollTop;
    },
    [],
  );

  const lockWheelDownAtBottom = useCallback(
    (source: 'list' | 'scroll-bottom-hotzone', event: WheelEvent<HTMLElement>) => {
      const scroller = listScrollerRef.current;
      if (!scroller || event.deltaY <= 0) {
        return false;
      }
      const metrics = readBottomMetrics(scroller);
      if (!metrics.visualAtBottom) {
        return false;
      }
      if (metrics.absoluteAtBottom) {
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      manualScrollDetachUntilRef.current = 0;
      autoFollowStreamRef.current = true;
      userDetachedFromBottomRef.current = false;
      setScrollBottomVisible(false);
      const lockedScrollTop = resolveWheelLockedScrollTop(source, scroller, metrics);
      scrollDebug('wheel-bottom-lock', {
        source,
        scrollTop: Math.round(scroller.scrollTop),
        lockedScrollTop: Math.round(lockedScrollTop),
        visualBottomDistance: Math.round(metrics.visualBottomDistance),
        absoluteBottomDistance: Math.round(metrics.absoluteBottomDistance),
        visualAtBottom: metrics.visualAtBottom,
      });
      restoreWheelLockedScrollTop(scroller, lockedScrollTop);
      return true;
    },
    [
      readBottomMetrics,
      resolveWheelLockedScrollTop,
      restoreWheelLockedScrollTop,
      setScrollBottomVisible,
    ],
  );

  const lockNativeWheelDownAtBottom = useCallback(
    (
      source: 'native-chat-body' | 'native-list' | 'native-scroll-bottom-hotzone',
      event: globalThis.WheelEvent,
    ) => {
      const scroller = listScrollerRef.current;
      if (!scroller || event.deltaY <= 0) {
        return false;
      }
      const metrics = readBottomMetrics(scroller);
      if (!metrics.visualAtBottom) {
        return false;
      }
      if (metrics.absoluteAtBottom) {
        return false;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      manualScrollDetachUntilRef.current = 0;
      autoFollowStreamRef.current = true;
      userDetachedFromBottomRef.current = false;
      setScrollBottomVisible(false);
      const lockedScrollTop = resolveWheelLockedScrollTop(source, scroller, metrics);
      scrollDebug('native-wheel-bottom-lock', {
        source,
        scrollTop: Math.round(scroller.scrollTop),
        lockedScrollTop: Math.round(lockedScrollTop),
        visualBottomDistance: Math.round(metrics.visualBottomDistance),
        absoluteBottomDistance: Math.round(metrics.absoluteBottomDistance),
        visualAtBottom: metrics.visualAtBottom,
      });
      restoreWheelLockedScrollTop(scroller, lockedScrollTop);
      return true;
    },
    [
      readBottomMetrics,
      resolveWheelLockedScrollTop,
      restoreWheelLockedScrollTop,
      setScrollBottomVisible,
    ],
  );

  const releaseWheelBottomFreeze = useCallback(
    (
      event: WheelEvent<HTMLElement> | globalThis.WheelEvent,
    ) => {
      if (event.deltaY >= 0) {
        return false;
      }
      const previous = lastWheelLockRef.current;
      if (!previous) {
        return false;
      }
      lastWheelLockRef.current = null;
      programmaticScrollUntilRef.current = 0;
      manualScrollDetachUntilRef.current = Date.now() + manualScrollDetachHoldMs;
      autoFollowStreamRef.current = false;
      userDetachedFromBottomRef.current = true;
      pendingSubmittedUserFocusRef.current = false;
      cancelScheduledStreamFollow();
      setScrollBottomVisible(shouldShowScrollBottomForScroller(listScrollerRef.current));
      return true;
    },
    [
      cancelScheduledStreamFollow,
      setScrollBottomVisible,
      shouldShowScrollBottomForScroller,
    ],
  );

  const markUserDetachedFromBottom = useCallback((reason = 'user-scroll') => {
    captureScrollGeometry('trace-detach', { reason });
    lastWheelLockRef.current = null;
    programmaticScrollUntilRef.current = 0;
    manualScrollDetachUntilRef.current = Date.now() + manualScrollDetachHoldMs;
    cancelScheduledStreamFollow();
    scrollDebug('detach', {
      reason,
      sending,
      atBottom: atBottomRef.current,
      scrollTop: Math.round(listScrollerRef.current?.scrollTop ?? 0),
    });
    userDetachedFromBottomRef.current = true;
    autoFollowStreamRef.current = false;
    pendingSubmittedUserFocusRef.current = false;
    const shouldShow = shouldShowScrollBottomForScroller(listScrollerRef.current);
    if (!atBottomRef.current) {
      setScrollBottomVisible(shouldShow);
      return;
    }
    window.requestAnimationFrame(() => {
      if (userDetachedFromBottomRef.current && !atBottomRef.current) {
        setScrollBottomVisible(
          shouldShowScrollBottomForScroller(listScrollerRef.current),
        );
      }
    });
  }, [
    cancelScheduledStreamFollow,
    captureScrollGeometry,
    sending,
    setScrollBottomVisible,
    shouldShowScrollBottomForScroller,
  ]);

  const handleListWheelCapture = useCallback(
    (event: WheelEvent<HTMLElement>) => {
      if (event.defaultPrevented || wheelAlreadyHandled(event)) {
        return;
      }
      lastWheelEventAtRef.current = Date.now();
      captureScrollGeometry('trace-wheel-input', {
        surface: 'list',
        deltaX: Math.round(event.deltaX),
        deltaY: Math.round(event.deltaY),
        deltaMode: event.deltaMode,
      });
      if (event.deltaY < 0) {
        if (releaseWheelBottomFreeze(event)) {
          markWheelHandled(event);
        }
        markUserDetachedFromBottom('wheel-up');
        markWheelHandled(event);
        return;
      }
      if (lockWheelDownAtBottom('list', event)) {
        markWheelHandled(event);
        return;
      }
    },
    [
      lockWheelDownAtBottom,
      captureScrollGeometry,
      markUserDetachedFromBottom,
      markWheelHandled,
      releaseWheelBottomFreeze,
      wheelAlreadyHandled,
    ],
  );

  const handleScrollBottomWheelCapture = useCallback(
    (event: WheelEvent<HTMLElement>) => {
      if (event.defaultPrevented || wheelAlreadyHandled(event)) {
        return;
      }
      lastWheelEventAtRef.current = Date.now();
      captureScrollGeometry('trace-wheel-input', {
        surface: 'scroll-bottom-button',
        deltaX: Math.round(event.deltaX),
        deltaY: Math.round(event.deltaY),
        deltaMode: event.deltaMode,
      });
      if (event.deltaY < 0) {
        if (releaseWheelBottomFreeze(event)) {
          markWheelHandled(event);
        }
        markUserDetachedFromBottom('wheel-up-hotzone');
        markWheelHandled(event);
        return;
      }
      if (lockWheelDownAtBottom('scroll-bottom-hotzone', event)) {
        markWheelHandled(event);
        return;
      }
    },
    [
      lockWheelDownAtBottom,
      captureScrollGeometry,
      markUserDetachedFromBottom,
      markWheelHandled,
      releaseWheelBottomFreeze,
      wheelAlreadyHandled,
    ],
  );

  const handleChatBodyWheelCapture = useCallback(
    (event: WheelEvent<HTMLElement>) => {
      if (
        event.defaultPrevented ||
        wheelAlreadyHandled(event) ||
        wheelTargetIsListSurface(event.target)
      ) {
        return;
      }
      lastWheelEventAtRef.current = Date.now();
      if (event.deltaY < 0) {
        if (releaseWheelBottomFreeze(event)) {
          markWheelHandled(event);
        }
        markUserDetachedFromBottom('wheel-up-body');
        markWheelHandled(event);
      }
    },
    [
      markUserDetachedFromBottom,
      markWheelHandled,
      releaseWheelBottomFreeze,
      wheelAlreadyHandled,
      wheelTargetIsListSurface,
    ],
  );

  useEffect(() => {
    const chatBody = chatBodyRef.current;
    if (!chatBody) {
      return undefined;
    }
    const handleNativeWheel = (event: globalThis.WheelEvent) => {
      if (
        event.defaultPrevented ||
        wheelAlreadyHandled(event) ||
        wheelTargetIsListSurface(event.target)
      ) {
        return;
      }
      lastWheelEventAtRef.current = Date.now();
      if (releaseWheelBottomFreeze(event)) {
        markWheelHandled(event);
        return;
      }
      if (lockNativeWheelDownAtBottom('native-chat-body', event)) {
        markWheelHandled(event);
        return;
      }
    };
    chatBody.addEventListener('wheel', handleNativeWheel, {
      capture: true,
      passive: false,
    });
    return () => {
      chatBody.removeEventListener('wheel', handleNativeWheel, {
        capture: true,
      });
    };
  }, [
    lockNativeWheelDownAtBottom,
    markWheelHandled,
    releaseWheelBottomFreeze,
    wheelAlreadyHandled,
    wheelTargetIsListSurface,
  ]);

  const lockStreamFollow = useCallback(
    (_reason: string) => {
      scrollDebug('lock-follow', {
        reason: _reason,
        sending,
        scrollTop: Math.round(listScrollerRef.current?.scrollTop ?? 0),
      });
      manualScrollDetachUntilRef.current = 0;
      autoFollowStreamRef.current = true;
      userDetachedFromBottomRef.current = false;
      pendingSubmittedUserFocusRef.current = false;
      if (showScrollBottomRef.current) {
        setScrollBottomVisible(false);
      }
    },
    [sending, setScrollBottomVisible],
  );

  const finishScrollbarDrag = useCallback(
    (reason: string) => {
      if (!scrollbarDragActiveRef.current) {
        return;
      }
      scrollbarDragActiveRef.current = false;
      const scroller = listScrollerRef.current;
      if (!scroller) {
        scrollbarDragUntilRef.current = Date.now() + 220;
        cancelScheduledStreamFollow();
        return;
      }
      const metrics = readBottomMetrics(scroller);
      scrollDebug('scrollbar-release', {
        reason,
        sending,
        scrollTop: Math.round(scroller.scrollTop),
        visualBottomDistance: Math.round(metrics.visualBottomDistance),
        visualNearBottom: metrics.visualNearBottom,
      });
      if (metrics.visualNearBottom) {
        scrollbarDragUntilRef.current = 0;
        lockStreamFollow(`${reason}:bottom`);
        return;
      }
      const shouldShow = shouldShowScrollBottomForMetrics(scroller, metrics);
      if (!shouldShow) {
        scrollbarDragUntilRef.current = 0;
        lockStreamFollow(`${reason}:tail-visible`);
        return;
      }
      scrollbarDragUntilRef.current = Date.now() + 220;
      autoFollowStreamRef.current = false;
      userDetachedFromBottomRef.current = true;
      pendingSubmittedUserFocusRef.current = false;
      cancelScheduledStreamFollow();
      setScrollBottomVisible(true);
    },
    [
      cancelScheduledStreamFollow,
      lockStreamFollow,
      readBottomMetrics,
      sending,
      setScrollBottomVisible,
      shouldShowScrollBottomForMetrics,
    ],
  );

  useEffect(() => {
    const handlePointerEnd = () => finishScrollbarDrag('scrollbar-pointer-end');
    window.addEventListener('pointerup', handlePointerEnd);
    window.addEventListener('pointercancel', handlePointerEnd);
    return () => {
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
    };
  }, [finishScrollbarDrag]);

  const maybeLockStreamFollowFromScroll = useCallback(
    (scroller: HTMLElement, reason: string) => {
      if (!sending) {
        return;
      }
      const now = Date.now();
      const activeAssistant = streamingAssistantMessage(renderMessages, activeTurnId);
      const metrics = readBottomMetrics(scroller);
      const shouldShow = shouldShowScrollBottomForMetrics(scroller, metrics);
      if (
        userDetachedFromBottomRef.current &&
        now < manualScrollDetachUntilRef.current
      ) {
        if (!shouldShow) {
          lockStreamFollow(`${reason}:tail-visible-during-detach-hold`);
          return;
        }
        autoFollowStreamRef.current = false;
        pendingSubmittedUserFocusRef.current = false;
        setScrollBottomVisible(true);
        return;
      }
      if (metrics.visualAtBottom) {
        lockStreamFollow(`${reason}:bottom`);
        return;
      }
      if (userDetachedFromBottomRef.current) {
        if (!shouldShow) {
          lockStreamFollow(`${reason}:tail-visible`);
          return;
        }
        autoFollowStreamRef.current = false;
        pendingSubmittedUserFocusRef.current = false;
        setScrollBottomVisible(true);
        return;
      }
      if (metrics.visualNearBottom) {
        lockStreamFollow(`${reason}:near-bottom`);
        return;
      }
      const activeTailVisible = activeAssistant
        ? isMessageTailVisible(scroller, activeAssistant.message.id, {
            composerDockHeight: quickContextBottomInset,
            streamStatusHeight,
            tolerance: 36,
          })
        : false;
      if (activeTailVisible) {
        lockStreamFollow(`${reason}:active-tail`);
        return;
      }
      if (
        now >= programmaticScrollUntilRef.current &&
        (autoFollowStreamRef.current || !userDetachedFromBottomRef.current)
      ) {
        autoFollowStreamRef.current = false;
        userDetachedFromBottomRef.current = true;
        pendingSubmittedUserFocusRef.current = false;
        setScrollBottomVisible(shouldShow);
      }
    },
    [
      activeTurnId,
      lockStreamFollow,
      quickContextBottomInset,
      readBottomMetrics,
      renderMessages,
      sending,
      setScrollBottomVisible,
      shouldShowScrollBottomForMetrics,
      streamStatusHeight,
    ],
  );

  const handleListPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (
        event.button !== 0 ||
        !(event.currentTarget instanceof HTMLElement) ||
        !isPointerOnVerticalScrollbar(event.currentTarget, event)
      ) {
        return;
      }
      const scroller = event.currentTarget;
      const metrics = readBottomMetrics(scroller);
      scrollbarDragActiveRef.current = true;
      scrollbarDragUntilRef.current = Date.now() + 4000;
      lastWheelLockRef.current = null;
      autoFollowStreamRef.current = false;
      userDetachedFromBottomRef.current = true;
      pendingSubmittedUserFocusRef.current = false;
      cancelScheduledStreamFollow();
      setScrollBottomVisible(shouldShowScrollBottomForMetrics(scroller, metrics));
      scrollDebug('scrollbar-pointer-down', {
        sending,
        scrollTop: Math.round(scroller.scrollTop),
        visualBottomDistance: Math.round(metrics.visualBottomDistance),
        visualNearBottom: metrics.visualNearBottom,
      });
    },
    [
      cancelScheduledStreamFollow,
      isPointerOnVerticalScrollbar,
      readBottomMetrics,
      sending,
      setScrollBottomVisible,
      shouldShowScrollBottomForMetrics,
    ],
  );

  const handleListScrollCapture = useCallback(
    (event: UIEvent<HTMLElement>) => {
      if (!(event.currentTarget instanceof HTMLElement)) {
        return;
      }
      const scroller = event.currentTarget;
      if (scroller.dataset.cardbushPreserveScroll === '1') {
        lastScrollTopRef.current = scroller.scrollTop;
        return;
      }
      const previousScrollTop = lastScrollTopRef.current;
      const scrollDelta = scroller.scrollTop - previousScrollTop;
      lastScrollTopRef.current = scroller.scrollTop;
      const metrics = readBottomMetrics(scroller);
      atBottomRef.current = metrics.visualAtBottom;
      const now = Date.now();
      const recentLock = lastWheelLockRef.current;
      const recentWheel = now - lastWheelEventAtRef.current <= 250;
      const scrollbarDragging =
        scrollbarDragActiveRef.current || now < scrollbarDragUntilRef.current;
      if (Date.now() <= scrollTraceObserveUntilRef.current) {
        captureScrollGeometry('trace-scroll-event', {
          scrollDelta: Math.round(scrollDelta),
          recentWheel,
          scrollbarDragging,
          programmaticRemainingMs: Math.max(
            0,
            programmaticScrollUntilRef.current - now,
          ),
        });
      }
      const likelyUserScrollWithoutWheel =
        sending &&
        scrollDelta > 0.5 &&
        now >= programmaticScrollUntilRef.current &&
        now - lastWheelEventAtRef.current > 120;
      if (scrollbarDragging) {
        lastWheelLockRef.current = null;
        autoFollowStreamRef.current = false;
        userDetachedFromBottomRef.current = true;
        pendingSubmittedUserFocusRef.current = false;
        cancelScheduledStreamFollow();
        setScrollBottomVisible(shouldShowScrollBottomForMetrics(scroller, metrics));
        scrollDebug('scrollbar-scroll', {
          sending,
          delta: Math.round(scrollDelta),
          scrollTop: Math.round(scroller.scrollTop),
          visualBottomDistance: Math.round(metrics.visualBottomDistance),
          visualNearBottom: metrics.visualNearBottom,
        });
        return;
      }
      if (likelyUserScrollWithoutWheel && metrics.visualAtBottom) {
        lockStreamFollow('scroll:bottom-without-wheel');
        return;
      }
      if (
        sending &&
        scrollDelta < -0.5 &&
        (recentWheel || now >= programmaticScrollUntilRef.current)
      ) {
        lastWheelLockRef.current = null;
        programmaticScrollUntilRef.current = 0;
        manualScrollDetachUntilRef.current =
          Date.now() + manualScrollDetachHoldMs;
        autoFollowStreamRef.current = false;
        userDetachedFromBottomRef.current = true;
        pendingSubmittedUserFocusRef.current = false;
        cancelScheduledStreamFollow();
        if (!shouldShowScrollBottomForMetrics(scroller, metrics)) {
          lockStreamFollow('scroll:tail-visible-after-up');
          return;
        }
        setScrollBottomVisible(true);
        return;
      }
      if (
        recentLock &&
        now - recentLock.at < scrollBottomWheelFreezeMs &&
        scroller.scrollTop < recentLock.scrollTop - 0.5 &&
        metrics.visualNearBottom
      ) {
        lastWheelLockRef.current = null;
        autoFollowStreamRef.current = false;
        userDetachedFromBottomRef.current = true;
        pendingSubmittedUserFocusRef.current = false;
        cancelScheduledStreamFollow();
        if (!shouldShowScrollBottomForMetrics(scroller, metrics)) {
          lockStreamFollow('scroll:wheel-lock-tail-visible');
          return;
        }
        setScrollBottomVisible(true);
        return;
      }
      if (
        recentLock &&
        now - recentLock.at < scrollBottomWheelFreezeMs &&
        Math.abs(scroller.scrollTop - recentLock.scrollTop) >= 0.5 &&
        metrics.visualNearBottom
      ) {
        scroller.scrollTop = recentLock.scrollTop;
        return;
      }
      if (!sending) {
        if (
          userDetachedFromBottomRef.current &&
          now < manualScrollDetachUntilRef.current &&
          !metrics.absoluteAtBottom
        ) {
          autoFollowStreamRef.current = false;
          pendingSubmittedUserFocusRef.current = false;
          setScrollBottomVisible(shouldShowScrollBottomForMetrics(scroller, metrics));
          return;
        }
        if (now < programmaticScrollUntilRef.current) {
          if (metrics.visualNearBottom) {
            setScrollBottomVisible(false);
          }
          return;
        }
        if (!shouldShowScrollBottomForMetrics(scroller, metrics)) {
          autoFollowStreamRef.current = true;
          userDetachedFromBottomRef.current = false;
          setScrollBottomVisible(false);
        } else {
          autoFollowStreamRef.current = false;
          userDetachedFromBottomRef.current = true;
          pendingSubmittedUserFocusRef.current = false;
          setScrollBottomVisible(true);
        }
        return;
      }
      maybeLockStreamFollowFromScroll(scroller, 'scroll');
    },
    [
      maybeLockStreamFollowFromScroll,
      cancelScheduledStreamFollow,
      captureScrollGeometry,
      lockStreamFollow,
      readBottomMetrics,
      sending,
      setScrollBottomVisible,
      shouldShowScrollBottomForMetrics,
    ],
  );

  useEffect(() => {
    const chatBody = chatBodyRef.current;
    if (loading || showWelcome) {
      setComposerDockHeight(0);
      setQuickContextBottomInset(0);
      chatBody?.style.removeProperty('--composer-surface-top');
      chatBody?.style.removeProperty('--composer-content-top');
      chatBody?.style.removeProperty('--composer-surface-center-x');
      chatBody?.style.removeProperty('--message-list-scrollbar-inset');
      return undefined;
    }
    const dock = composerDockRef.current;
    if (!dock) {
      setComposerDockHeight(0);
      setQuickContextBottomInset(0);
      chatBody?.style.removeProperty('--composer-surface-top');
      chatBody?.style.removeProperty('--composer-content-top');
      chatBody?.style.removeProperty('--composer-surface-center-x');
      chatBody?.style.removeProperty('--message-list-scrollbar-inset');
      return undefined;
    }
    let lastMeasurement = '';
    const updateHeight = () => {
      const dockRect = dock.getBoundingClientRect();
      const firstVisibleElement = dock.firstElementChild;
      const visibleTop = firstVisibleElement instanceof HTMLElement
        ? firstVisibleElement.getBoundingClientRect().top
        : dockRect.top;
      const nextDockHeight = Math.ceil(dockRect.height);
      const nextBottomInset = Math.ceil(Math.max(0, dockRect.bottom - visibleTop));
      if (chatBody) {
        const chatBodyRect = chatBody.getBoundingClientRect();
        chatBody.style.setProperty(
          '--composer-content-top',
          `${Math.max(0, visibleTop - chatBodyRect.top)}px`,
        );
      }
      const composerSurface = dock.querySelector<HTMLElement>(
        '.composer-surface, .interaction-card, .composer-stack',
      );
      if (chatBody && composerSurface) {
        const chatBodyRect = chatBody.getBoundingClientRect();
        const surfaceRect = composerSurface.getBoundingClientRect();
        chatBody.style.setProperty(
          '--composer-surface-top',
          `${Math.max(0, surfaceRect.top - chatBodyRect.top)}px`,
        );
        chatBody.style.setProperty(
          '--composer-surface-center-x',
          `${surfaceRect.left + surfaceRect.width / 2 - chatBodyRect.left}px`,
        );
      }
      const scroller = listScrollerRef.current;
      if (chatBody && scroller) {
        const scrollbarInset = Math.max(0, scroller.offsetWidth - scroller.clientWidth);
        chatBody.style.setProperty(
          '--message-list-scrollbar-inset',
          `${scrollbarInset}px`,
        );
      }
      const measurement = `${nextDockHeight}:${nextBottomInset}:${Math.round(dockRect.width)}`;
      if (measurement !== lastMeasurement) {
        lastMeasurement = measurement;
        captureScrollGeometry('trace-composer-measure', {
          nextDockHeight,
          nextBottomInset,
          measuredDockWidth: Math.round(dockRect.width),
        });
      }
      setComposerDockHeight(nextDockHeight);
      setQuickContextBottomInset(nextBottomInset);
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(dock);
    if (chatBody) {
      observer.observe(chatBody);
    }
    if (listScrollerRef.current) {
      observer.observe(listScrollerRef.current);
    }
    if (dock.firstElementChild instanceof HTMLElement) {
      observer.observe(dock.firstElementChild);
    }
    const composerSurface = dock.querySelector<HTMLElement>(
      '.composer-surface, .interaction-card, .composer-stack',
    );
    if (composerSurface) {
      observer.observe(composerSurface);
    }
    const mutationObserver = new MutationObserver(updateHeight);
    mutationObserver.observe(dock, { childList: true });
    return () => {
      observer.disconnect();
      mutationObserver.disconnect();
      chatBody?.style.removeProperty('--composer-surface-top');
      chatBody?.style.removeProperty('--composer-content-top');
      chatBody?.style.removeProperty('--composer-surface-center-x');
      chatBody?.style.removeProperty('--message-list-scrollbar-inset');
    };
  }, [captureScrollGeometry, loading, pendingInteraction, showWelcome]);

  useEffect(() => {
    if (loading || showWelcome) return undefined;
    const chatBody = chatBodyRef.current;
    const chatPanel = chatBody?.closest('.chat-panel');
    const mainStage = chatBody?.closest('.main-stage');
    const frame = chatBody?.querySelector('.chat-content-frame');
    const scroller = listScrollerRef.current;
    const content = scroller?.querySelector('.message-list-content');
    const footer = scroller?.querySelector('.message-list-footer');
    const dock = composerDockRef.current;
    const dockContent = dock?.firstElementChild;
    const observed = [
      mainStage,
      chatPanel,
      chatBody,
      frame,
      scroller,
      content,
      footer,
      dock,
      dockContent,
    ].filter(
      (element): element is Element => element instanceof Element,
    );
    if (observed.length === 0) return undefined;
    let lastSignature = '';
    const observer = new ResizeObserver((entries) => {
      const signature = entries
        .map((entry) => {
          const target = entry.target as HTMLElement;
          return `${target.className}:${Math.round(entry.contentRect.width)}x${Math.round(entry.contentRect.height)}`;
        })
        .sort()
        .join('|');
      if (signature === lastSignature) return;
      lastSignature = signature;
      const beforeScrollTop = scroller?.scrollTop ?? null;
      const beforeScrollHeight = scroller?.scrollHeight ?? null;
      const beforeBottom = scroller
        ? absoluteBottomScrollTop(scroller) - scroller.scrollTop
        : null;
      captureScrollGeometry('trace-outer-resize', {
        entries: signature,
        beforeScrollTop: beforeScrollTop == null ? null : Math.round(beforeScrollTop),
        beforeScrollHeight,
        beforeBottom: beforeBottom == null ? null : Math.round(beforeBottom),
      });
      if (
        !scroller ||
        scroller.dataset.cardbushPreserveScroll === '1' ||
        scrollbarDragActiveRef.current ||
        Date.now() < scrollbarDragUntilRef.current ||
        Date.now() < manualScrollDetachUntilRef.current ||
        userDetachedFromBottomRef.current ||
        !autoFollowStreamRef.current
      ) {
        return;
      }
      if (outerResizeFollowFrameRef.current != null) {
        window.cancelAnimationFrame(outerResizeFollowFrameRef.current);
      }
      outerResizeFollowFrameRef.current = window.requestAnimationFrame(() => {
        outerResizeFollowFrameRef.current = null;
        if (
          scroller.dataset.cardbushPreserveScroll === '1' ||
          scrollbarDragActiveRef.current ||
          Date.now() < scrollbarDragUntilRef.current ||
          Date.now() < manualScrollDetachUntilRef.current ||
          userDetachedFromBottomRef.current ||
          !autoFollowStreamRef.current
        ) {
          captureScrollGeometry('trace-outer-resize-follow-abort');
          return;
        }
        const scrollTopBeforeCorrection = scroller.scrollTop;
        const targetScrollTop = absoluteBottomScrollTop(scroller);
        if (Math.abs(targetScrollTop - scrollTopBeforeCorrection) > 0.5) {
          programmaticScrollUntilRef.current = Date.now() + 520;
          scroller.scrollTo({
            top: targetScrollTop,
            behavior: gentleAutoFollowScrollBehavior(),
          });
        }
        lastScrollTopRef.current = scroller.scrollTop;
        atBottomRef.current = true;
        setScrollBottomVisible(false);
        captureScrollGeometry('trace-outer-resize-follow', {
          scrollTopBeforeCorrection: Math.round(scrollTopBeforeCorrection),
          targetScrollTop: Math.round(targetScrollTop),
          correction: Math.round(targetScrollTop - scrollTopBeforeCorrection),
        });
      });
    });
    observed.forEach((element) => observer.observe(element));
    return () => {
      observer.disconnect();
      if (outerResizeFollowFrameRef.current != null) {
        window.cancelAnimationFrame(outerResizeFollowFrameRef.current);
        outerResizeFollowFrameRef.current = null;
      }
    };
  }, [
    captureScrollGeometry,
    loading,
    setScrollBottomVisible,
    showWelcome,
  ]);

  useEffect(() => {
    return () => {
      if (streamScrollFrameRef.current != null) {
        window.cancelAnimationFrame(streamScrollFrameRef.current);
      }
      if (outerResizeFollowFrameRef.current != null) {
        window.cancelAnimationFrame(outerResizeFollowFrameRef.current);
      }
      for (const timer of userMessageEntryTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      userMessageEntryTimersRef.current.clear();
      listScrollerWheelCleanupRef.current?.();
      listScrollerWheelCleanupRef.current = null;
      scrollBottomWheelCleanupRef.current?.();
      scrollBottomWheelCleanupRef.current = null;
    };
  }, []);

  useEffect(() => {
    const previous = messageSnapshotRef.current;
    const ids = renderMessages.map((message) => message.id);
    const previousIds = previous.conversationId === activeConversationId
      ? new Set(previous.ids)
      : new Set<string>();
    let submittedUserIndex = -1;
    for (let index = renderMessages.length - 1; index >= 0; index -= 1) {
      const message = renderMessages[index];
      if (message?.role === 'user' && !previousIds.has(message.id)) {
        submittedUserIndex = index;
        break;
      }
    }
    if (
      submittedUserIndex >= 0 &&
      Date.now() <= pendingSubmittedUserEntryUntilRef.current
    ) {
      const messageId = renderMessages[submittedUserIndex].id;
      pendingSubmittedUserEntryUntilRef.current = 0;
      setEnteringUserMessageIds((current) => {
        if (current.has(messageId)) return current;
        const next = new Set(current);
        next.add(messageId);
        return next;
      });
      const previousTimer = userMessageEntryTimersRef.current.get(messageId);
      if (previousTimer != null) window.clearTimeout(previousTimer);
      userMessageEntryTimersRef.current.set(
        messageId,
        window.setTimeout(() => {
          userMessageEntryTimersRef.current.delete(messageId);
          setEnteringUserMessageIds((current) => {
            if (!current.has(messageId)) return current;
            const next = new Set(current);
            next.delete(messageId);
            return next;
          });
        }, 260),
      );
    }
    if (previous.conversationId !== activeConversationId) {
      autoFollowStreamRef.current = true;
      userDetachedFromBottomRef.current = false;
      manualScrollDetachUntilRef.current = 0;
      atBottomRef.current = true;
      setScrollBottomVisible(false);
      messageSnapshotRef.current = { conversationId: activeConversationId, ids };
      if (
        renderMessages.length > 0 &&
        (pendingSubmittedUserFocusRef.current || sending)
      ) {
        for (let index = renderMessages.length - 1; index >= 0; index -= 1) {
          if (renderMessages[index]?.role === 'user') {
            focusSubmittedUserMessage(index, renderMessages[index].id);
            break;
          }
        }
      }
      return;
    }
    if (
      submittedUserIndex >= 0 &&
      (pendingSubmittedUserFocusRef.current ||
        (sending &&
          renderMessages.length > previous.ids.length &&
          !userDetachedFromBottomRef.current))
    ) {
      focusSubmittedUserMessage(
        submittedUserIndex,
        renderMessages[submittedUserIndex].id,
      );
    }
    messageSnapshotRef.current = { conversationId: activeConversationId, ids };
  }, [
    activeConversationId,
    focusSubmittedUserMessage,
    renderMessages,
    sending,
    setScrollBottomVisible,
  ]);

  useEffect(() => {
    setActiveScene(null);
    setAvailableScene(null);
    setActiveSceneInitialAutoPlay(false);
    activeSceneKeyRef.current = '';
    activeSceneRevisionRef.current = '';
  }, [activeConversationId]);

  useEffect(() => {
    const receiveSceneEvent = (event: Event) => {
      if (!(event instanceof CustomEvent) || !event.detail || typeof event.detail !== 'object') {
        return;
      }
      const detail = event.detail as Record<string, unknown>;
      const sessionId = String(detail.sessionId ?? detail.session_id ?? '').trim();
      const sceneId = String(detail.sceneId ?? detail.scene_id ?? '').trim();
      const type = String(detail.type ?? '');
      if (!sceneId || sessionId !== activeConversationId) return;
      if (type === 'scene_closed') {
        setAvailableScene((current) => current?.sceneId === sceneId ? null : current);
        setActiveScene((current) => current?.sceneId === sceneId ? null : current);
        return;
      }
      // Session Scene REST was removed from BushServer. New scene content is
      // restored from the streamed message artifacts below; this event only
      // carries lifecycle identity and must not trigger a legacy fetch.
    };
    window.addEventListener('cardbush:scene-event', receiveSceneEvent);
    return () => window.removeEventListener('cardbush:scene-event', receiveSceneEvent);
  }, [activeConversationId]);

  useEffect(() => {
    const latestScene = latestCardlingSceneFromMessages(renderMessages);
    if (!latestScene) {
      return;
    }
    const key = cardlingSceneKey(latestScene);
    setAvailableScene(latestScene);
    if (activeSceneKeyRef.current === key) {
      showScene(latestScene);
      return;
    }
    const sceneTurnId = latestScene.turnId?.trim() ?? '';
    const currentTurnId = activeTurnId.trim();
    if (!sending || !sceneTurnId || !currentTurnId || sceneTurnId !== currentTurnId) {
      return;
    }
    if (dismissedSceneKeysRef.current.has(key)) {
      return;
    }
    showScene(latestScene, { autoPlay: true });
  }, [activeTurnId, renderMessages, sending, showScene]);

  useEffect(() => {
    if (
      loading ||
      showWelcome ||
      !sending ||
      !autoFollowStreamRef.current
    ) {
      return;
    }
    const activeAssistant =
      streamingAssistantMessage(renderMessages, activeTurnId) ??
      lastAssistantMessage(renderMessages);
    if (!activeAssistant) {
      return;
    }
    scheduleActiveAssistantFollow(
      activeAssistant.message.id,
      activeAssistant.index,
    );
  }, [
    activeTurnId,
    loading,
    renderMessages,
    scheduleActiveAssistantFollow,
    sending,
    showWelcome,
  ]);

  const activeAssistantForRender =
    streamingAssistantMessage(renderMessages, activeTurnId) ??
    (sending ? lastAssistantMessage(renderMessages) : null);

  const applyQuickLoad = useCallback(
    (payload: QuickLoadPayload) => {
      const loaded = quickPayloadText(payload);
      if (!loaded) {
        return;
      }
      const next = draft.trim()
        ? `${draft.trimEnd()}\n${loaded}`
        : loaded;
      onDraftChange(next);
    },
    [draft, onDraftChange],
  );

  const editQueuedMessage = useCallback(
    (item: QueuedChatMessage) => {
      onRemoveQueuedMessage(item.id);
      const next = draft.trim()
        ? `${draft.trimEnd()}\n${item.text.trim()}`
        : item.text;
      onDraftChange(next);
    },
    [draft, onDraftChange, onRemoveQueuedMessage],
  );

  const forceListToVisualBottom = useCallback(() => {
    const scroller = listScrollerRef.current;
    if (!scroller) {
      return;
    }
    scroller.scrollTop = visualBottomScrollTop(
      scroller,
      quickContextBottomInset,
      streamStatusHeight,
    );
  }, [composerDockHeight, streamStatusHeight]);

  const jumpToLatestMessage = useCallback(
    (_reason: string) => {
      cancelScheduledStreamFollow();
      scrollTraceSequenceRef.current += 1;
      activeScrollTraceIdRef.current = `${Date.now().toString(36)}-${scrollTraceSequenceRef.current}`;
      scrollTraceObserveUntilRef.current = Date.now() + 3000;
      captureScrollGeometry('trace-jump-start', { reason: _reason });
      programmaticScrollUntilRef.current = Date.now() + 500;
      manualScrollDetachUntilRef.current = 0;
      autoFollowStreamRef.current = true;
      userDetachedFromBottomRef.current = false;
      pendingSubmittedUserFocusRef.current = false;
      atBottomRef.current = true;
      lastWheelLockRef.current = null;
      setScrollBottomVisible(false);

      forceListToVisualBottom();
      streamScrollFrameRef.current = window.requestAnimationFrame(() => {
        streamScrollFrameRef.current = null;
        if (userDetachedFromBottomRef.current) {
          captureScrollGeometry('trace-jump-abort', {
            reason: 'user-detached',
          });
          return;
        }
        forceListToVisualBottom();
        atBottomRef.current = true;
        setScrollBottomVisible(false);
        captureScrollGeometry('trace-jump-complete', {
          strategy: 'native-message-list',
        });
      });
    },
    [
      cancelScheduledStreamFollow,
      captureScrollGeometry,
      forceListToVisualBottom,
      setScrollBottomVisible,
    ],
  );

  const scrollToBottom = useCallback(() => {
    if (messages.length === 0) {
      return;
    }
    jumpToLatestMessage('scroll-bottom-button');
  }, [jumpToLatestMessage, messages.length]);

  useEffect(() => {
    if (loading || showWelcome || messages.length === 0) {
      return;
    }
    const conversationKey = activeConversationId.trim() || '__new__';
    const latestMessageId = messages[messages.length - 1]?.id ?? '';
    if (!latestMessageId) {
      return;
    }
    const previous = latestConversationScrollRef.current;
    if (previous.conversationId === conversationKey) {
      return;
    }
    latestConversationScrollRef.current = {
      conversationId: conversationKey,
      latestMessageId,
    };
    jumpToLatestMessage('session-enter');
  }, [
    activeConversationId,
    jumpToLatestMessage,
    loading,
    messages,
    showWelcome,
  ]);

  const setListScrollerRef = useCallback(
    (ref: HTMLElement | Window | null) => {
      listScrollerWheelCleanupRef.current?.();
      listScrollerWheelCleanupRef.current = null;
      const nextScroller = ref instanceof HTMLElement ? ref : null;
      listScrollerRef.current = nextScroller;
      if (!nextScroller) {
        return;
      }
      lastScrollTopRef.current = nextScroller.scrollTop;
      const handleNativeWheel = (event: globalThis.WheelEvent) => {
        if (event.defaultPrevented || wheelAlreadyHandled(event)) {
          return;
        }
        lastWheelEventAtRef.current = Date.now();
        if (releaseWheelBottomFreeze(event)) {
          markWheelHandled(event);
          return;
        }
        if (lockNativeWheelDownAtBottom('native-list', event)) {
          markWheelHandled(event);
        }
      };
      nextScroller.addEventListener('wheel', handleNativeWheel, {
        capture: true,
        passive: false,
      });
      listScrollerWheelCleanupRef.current = () => {
        nextScroller.removeEventListener('wheel', handleNativeWheel, {
          capture: true,
        });
      };
    },
    [
      lockNativeWheelDownAtBottom,
      markWheelHandled,
      releaseWheelBottomFreeze,
      wheelAlreadyHandled,
    ],
  );

  const setScrollBottomRef = useCallback(
    (ref: HTMLButtonElement | null) => {
      scrollBottomWheelCleanupRef.current?.();
      scrollBottomWheelCleanupRef.current = null;
      scrollBottomButtonRef.current = ref;
      if (!ref) {
        return;
      }
      const handleNativeWheel = (event: globalThis.WheelEvent) => {
        if (event.defaultPrevented || wheelAlreadyHandled(event)) {
          return;
        }
        lastWheelEventAtRef.current = Date.now();
        if (releaseWheelBottomFreeze(event)) {
          markWheelHandled(event);
          return;
        }
        if (lockNativeWheelDownAtBottom('native-scroll-bottom-hotzone', event)) {
          markWheelHandled(event);
        }
      };
      ref.addEventListener('wheel', handleNativeWheel, {
        capture: true,
        passive: false,
      });
      scrollBottomWheelCleanupRef.current = () => {
        ref.removeEventListener('wheel', handleNativeWheel, {
          capture: true,
        });
      };
    },
    [
      lockNativeWheelDownAtBottom,
      markWheelHandled,
      releaseWheelBottomFreeze,
      wheelAlreadyHandled,
    ],
  );

  const handleComposerSend = useCallback(
    async (text: string) => {
      if (
        sending &&
        guidanceDeliveryMode === 'immediate' &&
        activeTurnId
      ) {
        const guidanceAnchor: ChatMessage = {
          ...(activeAssistantForRender?.message ?? {
            id: `active-turn-${activeTurnId}`,
            role: 'assistant',
            content: '',
            createdAt: new Date().toISOString(),
          }),
          conversationId: activeConversationId,
          turnId: activeTurnId,
        };
        await onGuideMessage(
          guidanceAnchor,
          text,
          'append_context',
        );
        return;
      }
      if (!sending) {
        pendingSubmittedUserEntryUntilRef.current = Date.now() + 2000;
        const shouldFollowSubmission =
          !showScrollBottomRef.current || !userDetachedFromBottomRef.current;
        pendingSubmittedUserFocusRef.current = shouldFollowSubmission;
        if (shouldFollowSubmission) {
          programmaticScrollUntilRef.current = Date.now() + 1200;
          autoFollowStreamRef.current = true;
          userDetachedFromBottomRef.current = false;
          setScrollBottomVisible(false);
        }
      }
      await onSend(text);
    },
    [
      activeAssistantForRender,
      activeConversationId,
      activeTurnId,
      guidanceDeliveryMode,
      onGuideMessage,
      onSend,
      sending,
      setScrollBottomVisible,
    ],
  );

  const toggleConsole = useCallback(
    (mode: ConsoleMode) => {
      if ((mode === 'git' && !gitAvailable) || (mode === 'terminal' && !terminalAvailable)) {
        return;
      }
      setConsoleMode((current) => (current === mode ? null : mode));
    },
    [gitAvailable, terminalAvailable],
  );

  useEffect(() => {
    if (
      (consoleMode === 'git' && !gitAvailable) ||
      (consoleMode === 'terminal' && !terminalAvailable)
    ) {
      setConsoleMode(null);
    }
  }, [consoleMode, gitAvailable, terminalAvailable]);

  const [workSummaryVisible, setWorkSummaryVisible] = useState(false);
  const [workSummaryAnchorRight, setWorkSummaryAnchorRight] = useState(12);
  const chatBodyStyle = {
    '--composer-dock-height': `${composerDockHeight}px`,
    '--quick-context-bottom-inset': `${quickContextBottomInset}px`,
    '--stream-status-height': `${streamStatusHeight}px`,
    '--work-summary-anchor-right': `${workSummaryAnchorRight}px`,
  } as CSSProperties;
  const showWorkSummary = workSummaryVisible && !inspectorOpen;
  const workSummaryPresence = useSoftPanelPresence(showWorkSummary);
  const updateRestoredWorkSummaryAnchor = useCallback((anchor?: HTMLElement | null) => {
    if (windowMaximized) return;
    const chatBody = chatBodyRef.current;
    const toggle = anchor ?? chatBody
      ?.closest('.chat-panel')
      ?.querySelector<HTMLElement>('[data-work-summary-toggle]');
    if (!chatBody || !toggle) return;
    const bodyBounds = chatBody.getBoundingClientRect();
    const toggleBounds = toggle.getBoundingClientRect();
    const summaryWidth = Math.min(336, Math.max(0, bodyBounds.width - 24));
    const maximumRight = Math.max(12, bodyBounds.width - summaryWidth - 12);
    setWorkSummaryAnchorRight(Math.min(
      maximumRight,
      Math.max(12, Math.round(bodyBounds.right - toggleBounds.right)),
    ));
  }, [windowMaximized]);
  useEffect(() => {
    if (!showWorkSummary || windowMaximized) return undefined;
    const refreshAnchor = () => updateRestoredWorkSummaryAnchor();
    refreshAnchor();
    window.addEventListener('resize', refreshAnchor);
    return () => window.removeEventListener('resize', refreshAnchor);
  }, [showWorkSummary, updateRestoredWorkSummaryAnchor, windowMaximized]);
  useEffect(() => {
    if (!showWorkSummary || windowMaximized) {
      return undefined;
    }
    const closeRestoredSummary = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (
        target.closest('.conversation-work-summary') ||
        target.closest('[data-work-summary-toggle]')
      ) {
        return;
      }
      setWorkSummaryVisible(false);
    };
    const closeRestoredSummaryWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setWorkSummaryVisible(false);
      }
    };
    document.addEventListener('pointerdown', closeRestoredSummary);
    document.addEventListener('keydown', closeRestoredSummaryWithKeyboard);
    return () => {
      document.removeEventListener('pointerdown', closeRestoredSummary);
      document.removeEventListener('keydown', closeRestoredSummaryWithKeyboard);
    };
  }, [showWorkSummary, windowMaximized]);
  useEffect(() => {
    setWorkSummaryVisible(false);
  }, [activeConversationId]);
  if (import.meta.env.DEV && isComposerRuntimePreTestEnabled()) {
    return <ComposerRuntimePreTest language={language} />;
  }

  if (import.meta.env.DEV && isLoopHistoryPreTestEnabled()) {
    return <LoopHistoryPreTest language={language} />;
  }

  if (import.meta.env.DEV && isQuickContextPreTestEnabled()) {
    return <QuickContextPreTest language={language} />;
  }

  if (import.meta.env.DEV && LazyRuntimeStreamPreTest && isRuntimeStreamPreTestEnabled()) {
    return (
      <Suspense fallback={null}>
        <LazyRuntimeStreamPreTest
          language={language}
          mode={runtimeStreamPreTestMode() ?? 'fixture'}
          modelConfig={selectedModelConfig}
        />
      </Suspense>
    );
  }

  return (
    <div
      className={`chat-panel${sidebarCollapsed ? ' sidebar-collapsed' : ''}${!workSummaryPresence.mounted ? ' work-summary-hidden' : ' work-summary-requested'}${windowMaximized ? ' window-maximized' : ' window-restored'} ${osModeEnabled ? `os-chat-panel${osGamepad.active ? ' os-gamepad-active' : ''}` : ''}`}
    >
      {osModeEnabled ? (
        <OsShellBar
          language={language}
          runtimeAvailable={osRuntimeAvailable}
          gamepadConnected={osGamepad.connected}
          taskbarPlacement={osSettings.taskbarPlacement}
          launchedApplications={osTaskbarApplications}
          runningApplicationIds={osRunningApplicationIds}
          onLaunchApplication={(application) => void launchOsApplication(application)}
          onOpenApps={() => toggleOsSurface('apps')}
          onOpenTasks={() => toggleOsSurface('tasks')}
          onOpenFiles={() => toggleOsSurface('files')}
          onOpenSettings={toggleOsSettings}
          onExit={onExitOsMode}
        />
      ) : (
        <TopBar
          title={title}
          sidebarCollapsed={sidebarCollapsed}
          botShareLabel={
            messages.length === 0
              ? language === 'zh'
                ? '发送到 Bot'
                : 'Send to Bot'
              : language === 'zh'
                ? '继续到 Bot'
                : 'Continue to Bot'
          }
          language={language}
          activeConversationId={activeConversationId}
          botHandoffAvailable={botHandoffAvailable}
          onCreateSessionShareLink={
            botHandoffAvailable ? onCreateSessionShareLink : undefined
          }
          onRefreshActiveSession={refreshBackendWithFeedback}
          conversationContentAvailable={renderMessages.length > 0}
          activeConsole={consoleMode}
          onToggleGit={gitAvailable ? () => toggleConsole('git') : undefined}
          onToggleTerminal={terminalAvailable ? () => toggleConsole('terminal') : undefined}
          workSummaryVisible={showWorkSummary}
          reviewAvailable={changeReports.length > 0}
          onToggleWorkSummary={renderMessages.length > 0
            ? (anchor) => {
                updateRestoredWorkSummaryAnchor(anchor);
                setWorkSummaryVisible((current) => !current);
              }
            : undefined}
          onOpenReview={changeReports.length > 0 ? onOpenChangeReview : undefined}
          onRevealSidebar={onRevealSidebar}
        />
      )}
      {osModeEnabled && osSystemSurface && (
        <OsSystemSurface
          mode={osSystemSurface}
          language={language}
          onApplicationLaunched={rememberLaunchedApplication}
          pinnedApplicationIds={osPinnedApplicationIds}
          onToggleApplicationPinned={toggleOsPinnedApplication}
          onAskAgent={(prompt) => {
            onDraftChange(prompt);
            setOsSystemSurface(null);
          }}
          onClose={() => setOsSystemSurface(null)}
        />
      )}
      {osModeEnabled && osDesktopNotice && (
        <div className={`os-desktop-notice ${osDesktopNotice.tone}`} role="status">
          {osDesktopNotice.text}
        </div>
      )}
      {osModeEnabled && osSettings.taskbarPlacement === 'bottom' && (
        <OsTaskbar
          language={language}
          applications={osTaskbarApplications}
          runningApplicationIds={osRunningApplicationIds}
          onOpenApps={() => toggleOsSurface('apps')}
          onLaunch={(application) => void launchOsApplication(application)}
        />
      )}
      {osModeEnabled && osNineKeyOpen && (
        <OsNineKeyInput
          language={language}
          value={draft}
          onChange={onDraftChange}
          onSubmit={() => void handleComposerSend(draft)}
          onClose={() => setOsNineKeyOpen(false)}
        />
      )}
      {osModeEnabled && osSettingsOpen && (
        <OsControlCenter
          language={language}
          settings={osSettings}
          onChange={onOsSettingsChange}
          onClose={() => setOsSettingsOpen(false)}
        />
      )}
      {notice && (
        <RuntimeStatusBanner
          language={language}
          tone="notice"
          message={notice}
          onDismiss={onClearNotice}
        />
      )}
      {(error || refreshError) && (
        <RuntimeStatusBanner
          language={language}
          tone="error"
          message={error || refreshError}
          actionLabel={language === 'zh' ? '重试' : 'Retry'}
          onAction={async () => {
            await refreshBackendWithFeedback({ silent: false });
            onClearError();
          }}
          onDismiss={() => {
            setRefreshError('');
            onClearError();
          }}
        />
      )}
      <div
        className="chat-body"
        ref={chatBodyRef}
        style={chatBodyStyle}
        onWheelCapture={handleChatBodyWheelCapture}
      >
        {!osModeEnabled && !loading && workSummaryPresence.mounted && (
          <ConversationWorkSummary
            language={language}
            sessionId={activeConversationId}
            messages={renderMessages}
            changeReports={changeReports}
            onOpenChangeReview={onOpenChangeReview}
            subagentObservabilityAvailable={subagentObservabilityAvailable}
            softVisible={workSummaryPresence.visible}
          />
        )}
        {!osModeEnabled && !loading && !showWelcome && (
          <QuickContextRail
            language={language}
            messages={renderMessages}
            draft={draft}
            sessionId={activeConversationId}
            serverSearchAvailable={contextSearchAvailable}
          />
        )}
        <div className="chat-content-frame">
        {loading ? (
          <BackendLoading language={language} />
        ) : showWelcome ? (
          <WelcomeComposer
            key={activeConversationId || 'new-session'}
            language={language}
            osModeEnabled={osModeEnabled}
            onlyTalkMode={onlyTalkMode}
            osGamepadConnected={osGamepad.connected}
            draft={draft}
            onDraftChange={onDraftChange}
            sending={sending}
            stopping={stopping}
            guidanceDeliveryMode={guidanceDeliveryMode}
            cancelEnabled={Boolean(activeTurnId)}
            queuedMessageCount={queuedMessageCount}
            queuedMessagePreview={queuedMessagePreview}
            queuedMessages={queuedMessages}
            selectedModel={selectedModel}
            availableModels={availableModels}
            goalAvailable={goalAvailable}
            referencePlanAvailable={referencePlanAvailable}
            referencePlanMode={referencePlanMode}
            permissionMode={permissionMode}
            reasoningLevelAvailable={reasoningLevelAvailable}
            reasoningLevel={reasoningLevel}
            reasoningLevels={reasoningLevels}
            onModelChange={onModelChange}
            onReferencePlanModeChange={onReferencePlanModeChange}
            onPermissionModeChange={onPermissionModeChange}
            onReasoningLevelChange={onReasoningLevelChange}
            onConfigureModels={onConfigureModels}
            onCreateConversation={onCreateConversation}
            activeProjectDir={activeProjectDir}
            selectedProjectDir={selectedProjectDir}
            availableProjects={availableProjects}
            onProjectChange={onWelcomeProjectChange}
            projectContext={projectContext}
            skills={skills}
            disabledSkillNames={disabledSkillNames}
            visualInputAvailable={visualInputAvailable}
            visualInputEnabled={visualInputEnabled}
            gitAvailable={gitAvailable}
            terminalAvailable={terminalAvailable}
            onToggleSkill={onToggleSkill}
            onVisualInputEnabledChange={onVisualInputEnabledChange}
            onSaveProjectContext={onSaveProjectContext}
            onEditQueuedMessage={editQueuedMessage}
            onGuideQueuedMessage={(queuedId) =>
              onGuideQueuedMessage(queuedId, 'append_context')
            }
            onRemoveQueuedMessage={onRemoveQueuedMessage}
            onSend={handleComposerSend}
            onCancel={onCancel}
          />
        ) : (
          <div
            key={activeConversationId.trim() || 'new-session'}
            className="message-list"
            ref={setListScrollerRef}
            onWheelCapture={handleListWheelCapture}
            onPointerDownCapture={handleListPointerDownCapture}
            onTouchStartCapture={() => markUserDetachedFromBottom('touch')}
            onScrollCapture={handleListScrollCapture}
          >
            <div className="message-list-content">
              {renderMessages.map((message, index) => (
                <div
                  key={message.id}
                  className={`message-list-item${index === 0 ? ' first' : ''}${
                    message.role === 'user' && (
                      enteringUserMessageIds.has(message.id) ||
                      pendingSubmittedUserEntryMessageId === message.id
                    )
                      ? ' user-message-entering'
                      : ''
                  }`}
                  data-message-id={message.id}
                  data-message-role={message.role}
                >
                  <MessageFileReferenceScope workspaceRoot={activeProjectDir}>
                    <MessageBubble
                      key={message.id}
                      message={message}
                      language={language}
                      sending={sending}
                      activeTurnId={activeTurnId}
                      activeAssistantMessageId={
                        activeAssistantForRender?.message.id ?? ''
                      }
                      selectedModel={selectedModelConfig?.modelName ?? selectedModel}
                      goalObjective={activeGoal?.objective ?? ''}
                      onRegenerate={onRegenerate}
                      onEditUserMessage={onEditUserMessage}
                      onGuideMessage={onGuideMessage}
                      onRetryMessage={onRetryMessage}
                      onRetryGuidance={onRetryGuidance}
                      onRevertChangeReport={onRevertChangeReport}
                      onOpenChangeReview={onOpenChangeReview}
                      onOpenScene={openScene}
                    />
                  </MessageFileReferenceScope>
                </div>
              ))}
              {connectionRecovery && connectionRecovery.state !== 'recovered' && (
                <ConversationConnectionNotice
                  language={language}
                  update={connectionRecovery}
                />
              )}
            </div>
            <MessageListFooter />
          </div>
        )}
        {activeScene && (
          <CardlingSceneHost
            scene={activeScene}
            language={language}
            initialAutoPlay={activeSceneInitialAutoPlay}
            llmRunning={sending}
            activeTurnId={activeTurnId}
            onSendFeedbackToLlm={onSend}
            onClose={closeScene}
          />
        )}
        {!activeScene && availableScene && !loading && (
          <button
            className="scene-reopen-button"
            type="button"
            onClick={() => openScene(availableScene)}
            title={language === 'zh' ? '继续交互场景' : 'Continue interactive scene'}
          >
            <Sparkles size={15} />
            <span>{language === 'zh' ? '继续场景' : 'Scene'}</span>
          </button>
        )}
        {!showWelcome && pendingInteraction && (
          <div
            className={`composer-dock interaction-only${
              isPermissionInteraction(pendingInteraction) ? ' permission-only' : ''
            }`}
            ref={composerDockRef}
          >
            <InteractionCard
              language={language}
              interaction={pendingInteraction}
              onReply={onReplyInteraction}
              onCancel={onCancelInteraction}
            />
          </div>
        )}
        {!showWelcome && !loading && !pendingInteraction && (
          <div
            className={`composer-dock${
              sending || activeGoal || (thinkingVisible && thinkingNotice) || currentTurnChangeSummary || queuedMessageCount > 0 || shadowThreadOpen
                ? ' runtime-attached'
                : ''
            }${shadowThreadOpen ? ' shadow-active' : ''}`}
            ref={composerDockRef}
            style={{
              '--shadow-accent': shadowAccentColor,
            } as CSSProperties}
          >
            {(sending || activeGoal || (thinkingVisible && thinkingNotice) || currentTurnChangeSummary || queuedMessageCount > 0) && (
              <ComposerRuntimeRail
                language={language}
                running={sending || (activeGoal?.status === 'active' && !goalWaiting)}
                stopping={stopping}
                taskPlan={activeTaskPlan}
                goal={activeGoal}
                goalRounds={activeGoalRounds}
                goalCancelling={goalCancelling}
                goalWaiting={goalWaiting}
                thinkingNotice={thinkingVisible ? thinkingNotice : null}
                thinkingOpen={thinkingOpen}
                changeReports={currentTurnChangeReports}
                changeSummary={currentTurnChangeSummary}
                queuedMessageCount={queuedMessageCount}
                queuedMessagePreview={queuedMessagePreview}
                queuedMessages={queuedMessages}
                onToggleThinking={() => {
                  setShadowThreadOpen(false);
                  setThinkingOpen((current) => !current);
                }}
                onCloseThinking={() => setThinkingOpen(false)}
                onCancelGoal={onCancelGoal}
                onOpenChangeReview={onOpenChangeReview}
                onEditQueuedMessage={editQueuedMessage}
                onGuideQueuedMessage={(queuedId) =>
                  onGuideQueuedMessage(queuedId, 'append_context')
                }
                onRemoveQueuedMessage={onRemoveQueuedMessage}
              />
            )}
            {shadowThreadOpen && (
              <div className="composer-shadow-chat-host">
                <ShadowTemporaryChat
                  language={language}
                  agentName={shadowConversation?.agentName || 'Shadow Agent'}
                  entries={shadowEntries}
                  busy={shadowReplying}
                  error={shadowError}
                  open={shadowThreadOpen}
                  accentColor={shadowAccentColor}
                  onClose={closeShadowThread}
                />
              </div>
            )}
            <Composer
              key={activeConversationId || 'active-session'}
              compact
              osMode={osModeEnabled}
              language={language}
              draft={shadowThreadOpen ? shadowDraft : draft}
              onDraftChange={shadowThreadOpen ? setShadowDraft : onDraftChange}
              sending={shadowThreadOpen ? shadowReplying : sending}
              stopping={shadowThreadOpen ? false : stopping}
              guidanceDeliveryMode={shadowThreadOpen ? 'queue' : guidanceDeliveryMode}
              cancelEnabled={shadowThreadOpen ? shadowReplying : Boolean(activeTurnId)}
              queuedMessageCount={0}
              queuedMessagePreview=""
              queuedMessages={[]}
              selectedModel={selectedModel}
              availableModels={availableModels}
              goalAvailable={goalAvailable}
              referencePlanAvailable={referencePlanAvailable}
              referencePlanMode={referencePlanMode}
              permissionMode={permissionMode}
              reasoningLevelAvailable={reasoningLevelAvailable}
              reasoningLevel={reasoningLevel}
              reasoningLevels={reasoningLevels}
              onModelChange={onModelChange}
              onReferencePlanModeChange={onReferencePlanModeChange}
              onPermissionModeChange={onPermissionModeChange}
              onReasoningLevelChange={onReasoningLevelChange}
              onSend={shadowThreadOpen ? sendShadowReply : handleComposerSend}
              onCancel={shadowThreadOpen
                ? async () => {
                    shadowAbortControllerRef.current?.abort();
                    shadowAbortControllerRef.current = null;
                    setShadowReplying(false);
                  }
                : onCancel}
              shadowActive={shadowThreadOpen}
              shadowAvailable={shadowCanActivate}
              shadowAgentName={shadowConversation?.agentName}
              onToggleShadow={shadowCanActivate ? toggleShadowThread : undefined}
              contextWindow={{
                usedTokens: contextWindowUsage?.usedTokens,
                maxTokens: contextWindowUsage?.maxTokens ?? contextWindowMaxTokens,
                remainingTokens: contextWindowUsage?.remainingTokens,
                measuredAt: contextWindowUsage?.measuredAt,
              }}
              skills={skills}
              disabledSkillNames={disabledSkillNames}
              visualInputAvailable={visualInputAvailable}
              visualInputEnabled={visualInputEnabled}
              gitAvailable={gitAvailable}
              terminalAvailable={terminalAvailable}
              onToggleSkill={onToggleSkill}
              onVisualInputEnabledChange={onVisualInputEnabledChange}
              activeProjectDir={activeProjectDir}
              projectContext={projectContext}
              onQuickLoad={applyQuickLoad}
              onSaveProjectContext={onSaveProjectContext}
              onConfigureModels={onConfigureModels}
              onCreateConversation={onCreateConversation}
              onOpenTerminalConsole={
                terminalAvailable ? () => toggleConsole('terminal') : undefined
              }
            />
          </div>
        )}
        </div>
        <button
          ref={setScrollBottomRef}
          className={`scroll-bottom ${
            loading || showWelcome || !showScrollBottom ? 'hidden' : ''
          }`}
          type="button"
          aria-label="scroll bottom"
          onWheelCapture={handleScrollBottomWheelCapture}
          onClick={scrollToBottom}
        >
          <ArrowDown size={16} strokeWidth={1.8} />
        </button>
      </div>
      {consoleMode &&
        ((consoleMode === 'git' && gitAvailable) ||
          (consoleMode === 'terminal' && terminalAvailable)) && (
          <ConsoleDock
            mode={consoleMode}
            language={language}
            activeProjectDir={activeProjectDir}
            terminalRuntime={terminalRuntime}
            onClose={() => setConsoleMode(null)}
          />
        )}
    </div>
  );
}

function BackendLoading({ language }: { language: AppLanguage }) {
  return (
    <div className="loading-view">
      <div className="loading-brand" aria-label="cardbush">
        <img className="loading-logo-mark" src="./cardbush-logo.png" alt="" />
        <strong>cardbush</strong>
      </div>
      <div className="loading-rhythm" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
      <p>{language === 'zh' ? '正在连接后端服务...' : 'Connecting to backend service...'}</p>
    </div>
  );
}

function RuntimeStatusBanner({
  language,
  tone,
  message,
  actionLabel,
  onAction,
  onDismiss,
}: {
  language: AppLanguage;
  tone: 'notice' | 'error';
  message: string;
  actionLabel?: string;
  onAction?: () => Promise<void>;
  onDismiss: () => void;
}) {
  const [actionState, setActionState] = useState<'idle' | 'running' | 'failed'>('idle');
  const runAction = useCallback(async () => {
    if (!onAction || actionState === 'running') return;
    setActionState('running');
    try {
      await onAction();
      setActionState('idle');
    } catch {
      setActionState('failed');
    }
  }, [actionState, onAction]);
  const statusLabel = actionState === 'running'
    ? language === 'zh' ? '正在重试' : 'Retrying'
    : actionState === 'failed'
      ? language === 'zh' ? '重试失败' : 'Retry failed'
      : actionLabel;

  return (
    <div
      className={`runtime-status-banner ${tone === 'error' ? 'error-banner' : 'notice-banner'}`}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
    >
      {tone === 'error' ? <AlertCircle size={16} /> : <CheckCircle2 size={16} />}
      <span className="runtime-status-message">{message}</span>
      {onAction && actionLabel && (
        <button
          className="runtime-status-action"
          type="button"
          disabled={actionState === 'running'}
          onClick={() => void runAction()}
        >
          {actionState === 'running' && <LoaderCircle size={14} />}
          {statusLabel}
        </button>
      )}
      <button
        className="runtime-status-dismiss"
        type="button"
        aria-label={language === 'zh' ? '关闭提示' : 'Dismiss notification'}
        title={language === 'zh' ? '关闭' : 'Dismiss'}
        onClick={onDismiss}
      >
        <X size={16} />
      </button>
    </div>
  );
}

function ConversationConnectionNotice({
  language,
  update,
}: {
  language: AppLanguage;
  update: RuntimeConnectionUpdate;
}) {
  const isFailed = update.state === 'failed';
  const isSyncing = update.state === 'syncing';
  const attempt = update.attempt && update.attempt > 0
    ? language === 'zh'
      ? ` · 第 ${update.attempt} 次`
      : ` · attempt ${update.attempt}`
    : '';
  const retryDelay = update.nextRetryMs && update.nextRetryMs > 0
    ? language === 'zh'
      ? `${Math.max(0.1, update.nextRetryMs / 1000).toFixed(1)} 秒后重试`
      : `Retrying in ${Math.max(0.1, update.nextRetryMs / 1000).toFixed(1)}s`
    : '';
  const title = isFailed
    ? update.source === 'provider'
      ? language === 'zh'
        ? '模型服务重试失败'
        : 'Model provider retry failed.'
      : language === 'zh'
        ? '连接恢复失败，请检查 BushServer'
        : 'Connection recovery failed. Check BushServer.'
    : isSyncing
      ? language === 'zh'
        ? '连接已建立，正在同步运行状态'
        : 'Connected. Synchronizing the running turn.'
      : update.source === 'provider'
        ? language === 'zh'
          ? `模型服务异常，正在重试${attempt}`
          : `Model provider issue. Retrying${attempt}`
        : language === 'zh'
          ? `连接异常，正在恢复${attempt}`
          : `Connection interrupted. Recovering${attempt}`;
  const detail = isFailed
    ? update.message || update.reason || ''
    : retryDelay;

  return (
    <div
      className={`conversation-connection-notice ${isFailed ? 'failed' : 'working'}`}
      role={isFailed ? 'alert' : 'status'}
      aria-live={isFailed ? 'assertive' : 'polite'}
    >
      {isFailed ? <AlertCircle size={16} /> : <LoaderCircle size={16} />}
      <div className="conversation-connection-copy">
        <strong>{title}</strong>
        {detail && <span>{detail}</span>}
      </div>
    </div>
  );
}

function WelcomeComposer({
  language,
  osModeEnabled = false,
  onlyTalkMode = false,
  osGamepadConnected = false,
  draft,
  onDraftChange,
  sending,
  stopping,
  guidanceDeliveryMode,
  cancelEnabled,
  queuedMessageCount,
  queuedMessagePreview,
  queuedMessages,
  selectedModel,
  availableModels,
  goalAvailable,
  referencePlanAvailable,
  referencePlanMode,
  permissionMode,
  reasoningLevelAvailable,
  reasoningLevel,
  reasoningLevels,
  activeProjectDir,
  selectedProjectDir,
  availableProjects,
  onProjectChange,
  projectContext,
  skills = [],
  disabledSkillNames,
  visualInputAvailable,
  visualInputEnabled,
  gitAvailable,
  terminalAvailable,
  onToggleSkill,
  onVisualInputEnabledChange,
  onModelChange,
  onReferencePlanModeChange,
  onPermissionModeChange,
  onReasoningLevelChange,
  onConfigureModels,
  onCreateConversation,
  onSaveProjectContext,
  onEditQueuedMessage,
  onGuideQueuedMessage,
  onRemoveQueuedMessage,
  onSend,
  onCancel,
}: {
  language: AppLanguage;
  osModeEnabled?: boolean;
  onlyTalkMode?: boolean;
  osGamepadConnected?: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  sending: boolean;
  stopping: boolean;
  guidanceDeliveryMode: AppSettingsState['guidance']['deliveryMode'];
  cancelEnabled: boolean;
  queuedMessageCount: number;
  queuedMessagePreview: string;
  queuedMessages: QueuedChatMessage[];
  selectedModel: string;
  availableModels: ManagedModelConfig[];
  goalAvailable: boolean;
  referencePlanAvailable: boolean;
  referencePlanMode: ReferencePlanMode;
  permissionMode: PermissionMode;
  reasoningLevelAvailable: boolean;
  reasoningLevel: ReasoningLevel;
  reasoningLevels: ReasoningLevel[];
  activeProjectDir?: string;
  selectedProjectDir: string;
  availableProjects: ProjectItem[];
  onProjectChange: (projectDir: string | null) => Promise<void>;
  projectContext: string;
  skills?: SkillSummary[];
  disabledSkillNames: Set<string>;
  visualInputAvailable: boolean;
  visualInputEnabled: boolean;
  gitAvailable: boolean;
  terminalAvailable: boolean;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  onVisualInputEnabledChange: (enabled: boolean) => void;
  onModelChange: (value: string) => void;
  onReferencePlanModeChange: (value: ReferencePlanMode) => void;
  onPermissionModeChange: (value: PermissionMode) => void;
  onReasoningLevelChange: (value: ReasoningLevel) => void;
  onConfigureModels: () => void;
  onCreateConversation?: () => void;
  onSaveProjectContext: (value: string) => Promise<string>;
  onEditQueuedMessage: (item: QueuedChatMessage) => void;
  onGuideQueuedMessage: (queuedId: string) => Promise<void>;
  onRemoveQueuedMessage: (queuedId: string) => void;
  onSend: (text: string) => Promise<void>;
  onCancel: () => Promise<void>;
}) {
  const welcomeComposer = (
    <Composer
      compact
      osMode={osModeEnabled}
      language={language}
      draft={draft}
      onDraftChange={onDraftChange}
      sending={sending}
      stopping={stopping}
      guidanceDeliveryMode={guidanceDeliveryMode}
      cancelEnabled={cancelEnabled}
      queuedMessageCount={queuedMessageCount}
      queuedMessagePreview={queuedMessagePreview}
      queuedMessages={queuedMessages}
      selectedModel={selectedModel}
      availableModels={availableModels}
      goalAvailable={goalAvailable}
      referencePlanAvailable={referencePlanAvailable}
      referencePlanMode={referencePlanMode}
      permissionMode={permissionMode}
      reasoningLevelAvailable={reasoningLevelAvailable}
      reasoningLevel={reasoningLevel}
      reasoningLevels={reasoningLevels}
      onModelChange={onModelChange}
      onReferencePlanModeChange={onReferencePlanModeChange}
      onPermissionModeChange={onPermissionModeChange}
      onReasoningLevelChange={onReasoningLevelChange}
      onConfigureModels={onConfigureModels}
      onCreateConversation={onCreateConversation}
      activeProjectDir={activeProjectDir}
      projectContext={projectContext}
      skills={skills}
      disabledSkillNames={disabledSkillNames}
      visualInputAvailable={visualInputAvailable}
      visualInputEnabled={visualInputEnabled}
      gitAvailable={gitAvailable}
      terminalAvailable={terminalAvailable}
      onToggleSkill={onToggleSkill}
      onVisualInputEnabledChange={onVisualInputEnabledChange}
      onSaveProjectContext={onSaveProjectContext}
      onEditQueuedMessage={onEditQueuedMessage}
      onGuideQueuedMessage={onGuideQueuedMessage}
      onRemoveQueuedMessage={onRemoveQueuedMessage}
      onSend={onSend}
      onCancel={onCancel}
    />
  );

  return (
    <div className={`welcome-composer ${osModeEnabled ? 'os-welcome-composer' : ''}`}>
      {!osModeEnabled && (
        <div className="welcome-hero">
          <span className="welcome-hero-mark" aria-hidden="true">
            <img className="welcome-hero-logo" src="./cardbush-logo.png" alt="" />
          </span>
          <h2>
            {onlyTalkMode
              ? language === 'zh'
                ? '你想聊些什么？'
                : 'What would you like to talk about?'
              : language === 'zh'
                ? `你想让我们在 ${selectedProjectDir ? (availableProjects.find((project) => samePath(project.rootPath, selectedProjectDir))?.title || 'cardbush') : 'cardbush'} 中构建什么？`
                : `What do you want us to build in ${selectedProjectDir ? (availableProjects.find((project) => samePath(project.rootPath, selectedProjectDir))?.title || 'cardbush') : 'cardbush'}?`}
          </h2>
        </div>
      )}
      {!osModeEnabled ? (
        <div className={`welcome-input-stack${onlyTalkMode ? ' only-talk' : ''}`}>
          {!onlyTalkMode && (
            <WelcomeProjectSwitcher
              language={language}
              projects={availableProjects}
              selectedProjectDir={selectedProjectDir}
              onSelect={onProjectChange}
            />
          )}
          {welcomeComposer}
        </div>
      ) : (
        welcomeComposer
      )}
      {osModeEnabled && osGamepadConnected && (
        <div className="os-controller-hint" aria-hidden="true">
          <span><kbd>A</kbd>{language === 'zh' ? '选择' : 'Select'}</span>
          <span><kbd>Y</kbd>{language === 'zh' ? '输入' : 'Type'}</span>
          <span><kbd>☰</kbd>{language === 'zh' ? '设置' : 'Settings'}</span>
        </div>
      )}
    </div>
  );
}

function WelcomeProjectSwitcher({
  language,
  projects,
  selectedProjectDir,
  onSelect,
}: {
  language: AppLanguage;
  projects: ProjectItem[];
  selectedProjectDir: string;
  onSelect: (projectDir: string | null) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const selectedProject = projects.find((project) =>
    samePath(project.rootPath, selectedProjectDir),
  );
  const normalizedQuery = query.trim().toLowerCase();
  const filteredProjects = projects.filter((project) =>
    !normalizedQuery || `${project.title} ${project.rootPath}`.toLowerCase().includes(normalizedQuery),
  );

  useEffect(() => {
    if (!open) return undefined;
    const closeFromPointer = (event: globalThis.PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', closeFromPointer);
    document.addEventListener('keydown', closeFromKeyboard);
    return () => {
      document.removeEventListener('pointerdown', closeFromPointer);
      document.removeEventListener('keydown', closeFromKeyboard);
    };
  }, [open]);

  async function selectProject(projectDir: string | null) {
    setBusy(true);
    try {
      await onSelect(projectDir);
      setOpen(false);
      setQuery('');
    } catch {
      // The shared conversation error banner reports project update failures.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="welcome-project-switcher" ref={rootRef}>
      {open && (
        <div className="welcome-project-menu" role="menu">
          <label className="welcome-project-search">
            <Search size={13} aria-hidden="true" />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={language === 'zh' ? '搜索项目' : 'Search projects'}
            />
          </label>
          <div className="welcome-project-options">
            {filteredProjects.map((project) => {
              const selected = samePath(project.rootPath, selectedProjectDir);
              return (
                <button
                  key={project.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  disabled={busy}
                  onClick={() => void selectProject(project.rootPath)}
                >
                  <Folder size={14} />
                  <span>{project.title}</span>
                  {selected && <Check size={14} />}
                </button>
              );
            })}
            {filteredProjects.length === 0 && (
              <div className="welcome-project-empty">
                {language === 'zh' ? '没有匹配的项目' : 'No matching projects'}
              </div>
            )}
          </div>
          <div className="welcome-project-menu-footer">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={!selectedProject}
              disabled={busy}
              onClick={() => void selectProject(null)}
            >
              <X size={14} />
              <span>{language === 'zh' ? '不在项目中工作' : 'Work without a project'}</span>
              {!selectedProject && <Check size={14} />}
            </button>
          </div>
        </div>
      )}
      <button
        className="welcome-project-trigger"
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {busy ? <LoaderCircle className="spinning" size={14} /> : <Folder size={14} />}
        <span>{selectedProject?.title || (language === 'zh' ? '不在项目中' : 'No project')}</span>
      </button>
      {selectedProject && (
        <span className="welcome-project-context-meta" aria-label={language === 'zh' ? '本地项目' : 'Local project'}>
          <Monitor size={13} aria-hidden="true" />
          <span>{language === 'zh' ? '本地' : 'Local'}</span>
        </span>
      )}
    </div>
  );
}

function botTargetKey(target: BotShareTarget) {
  return target.platform ?? 'any';
}

function botUiError(caught: unknown, fallback: string, language: AppLanguage) {
  const message = caught instanceof Error ? caught.message : '';
  if (!message) {
    return fallback;
  }
  if (language === 'zh' && /failed to fetch|networkerror/i.test(message)) {
    return fallback;
  }
  return message;
}

function formatBotExpiry(value: string, language: AppLanguage) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value || (language === 'zh' ? '15 分钟后' : 'in 15 minutes');
  }
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp);
}

function BotShareMenu({
  language,
  sessionId,
  onCreateLink,
  onRefreshSession,
  onClose,
}: {
  language: AppLanguage;
  sessionId: string;
  onCreateLink: (
    request: SessionShareLinkRequest,
  ) => Promise<SessionShareLinkResult>;
  onRefreshSession: RefreshActiveSession;
  onClose: () => void;
}) {
  const [link, setLink] = useState<SessionShareLinkResult | null>(null);
  const [selectedTarget, setSelectedTarget] = useState<BotShareTarget | null>(null);
  const [creatingTarget, setCreatingTarget] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  const activeTarget = selectedTarget ?? botShareTargets[0];
  const command = link ? `/link ${link.code}` : '';

  const createLink = useCallback(
    async (target: BotShareTarget) => {
      const targetKey = botTargetKey(target);
      setCreatingTarget(targetKey);
      setError('');
      setCopied(false);
      try {
        const nextLink = await onCreateLink({
          sessionId,
          platform: target.platform,
          expiresSeconds: 900,
        });
        setSelectedTarget(target);
        setLink(nextLink);
        await onRefreshSession({ silent: true }).catch(() => undefined);
      } catch (caught) {
        setError(
          botUiError(
            caught,
            language === 'zh' ? '创建 Bot 绑定码失败' : 'Failed to create Bot link',
            language,
          ),
        );
      } finally {
        setCreatingTarget(null);
      }
    },
    [language, onCreateLink, onRefreshSession, sessionId],
  );

  const refreshSession = useCallback(
    async (silent = false) => {
      if (!silent) {
        setRefreshing(true);
        setError('');
      }
      try {
        await onRefreshSession({ silent: true });
      } catch (caught) {
        if (!silent) {
          setError(
            botUiError(
              caught,
              language === 'zh' ? '刷新会话失败' : 'Failed to refresh chat',
              language,
            ),
          );
        }
      } finally {
        if (!silent) {
          setRefreshing(false);
        }
      }
    },
    [language, onRefreshSession],
  );

  const copyCommand = useCallback(async () => {
    if (!command) {
      return;
    }
    try {
      await copyText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch (caught) {
      setError(
        botUiError(
          caught,
          language === 'zh' ? '复制命令失败' : 'Failed to copy command',
          language,
        ),
      );
    }
  }, [command, language]);

  return (
    <div className="bot-share-menu" role="dialog" aria-label={language === 'zh' ? 'Bot 绑定' : 'Bot link'}>
      <header>
        <span className="bot-share-icon">
          {link ? activeTarget.icon : <BotPlatformIcon platform="any" />}
        </span>
        <div>
          <strong>
            {link
              ? language === 'zh'
                ? `继续到 ${activeTarget.title.zh}`
                : `Continue in ${activeTarget.title.en}`
              : language === 'zh'
                ? '发送到 Bot'
                : 'Send to Bot'}
          </strong>
          <small>
            {language === 'zh'
              ? '绑定码有效 15 分钟'
              : 'The binding code is valid for 15 minutes'}
          </small>
        </div>
        <button type="button" title={language === 'zh' ? '关闭' : 'Close'} onClick={onClose}>
          <X size={15} />
        </button>
      </header>
      {!link ? (
        <div className="bot-share-targets">
          <p>
            {language === 'zh'
              ? '选择一个 Bot 平台，然后把生成的 /link 命令发送给 Bot。'
              : 'Choose a Bot platform, then send the generated /link command to the Bot.'}
          </p>
          {botShareTargets.map((target) => {
            const key = botTargetKey(target);
            const creating = creatingTarget === key;
            return (
              <button
                className="bot-share-target"
                key={key}
                type="button"
                disabled={creatingTarget !== null}
                onClick={() => void createLink(target)}
              >
                <span className="bot-share-target-icon">
                  {creating ? <LoaderCircle size={16} /> : target.icon}
                </span>
                <span>
                  <strong>{target.title[language]}</strong>
                  <small>{target.subtitle[language]}</small>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="bot-share-detail">
          <p>
            {language === 'zh'
              ? '在 Bot 对话里发送下面命令，即可接管当前会话；回到 CardBush 后点“刷新 Bot 内容”拉回新历史。'
              : 'Send this command in the Bot chat to take over the current session; use Refresh Bot content to pull updates back.'}
          </p>
          <button className="bot-link-command" type="button" onClick={() => void copyCommand()}>
            <code>{command}</code>
            <span>{copied ? (language === 'zh' ? '已复制' : 'Copied') : (language === 'zh' ? '复制' : 'Copy')}</span>
          </button>
          <div className="bot-share-meta">
            <span>
              {language === 'zh' ? '过期时间' : 'Expires'}: {formatBotExpiry(link.expiresAt, language)}
            </span>
            <span>
              {language === 'zh' ? '平台' : 'Platform'}: {activeTarget.title[language]}
            </span>
          </div>
          <div className="bot-share-actions">
            <button className="secondary-button" type="button" onClick={() => void refreshSession(false)}>
              {refreshing ? <LoaderCircle size={14} /> : <RefreshCw size={14} />}
              <span>{language === 'zh' ? '刷新 Bot 内容' : 'Refresh Bot content'}</span>
            </button>
            <button className="secondary-button" type="button" onClick={() => setLink(null)}>
              <Bot size={14} />
              <span>{language === 'zh' ? '换一个 Bot' : 'Choose another'}</span>
            </button>
            <button className="primary-button" type="button" onClick={() => void copyCommand()}>
              <Clipboard size={14} />
              <span>{copied ? (language === 'zh' ? '已复制' : 'Copied') : (language === 'zh' ? '复制命令' : 'Copy command')}</span>
            </button>
          </div>
          <div className="bot-share-hint">
            {language === 'zh'
              ? '需要断开时，在 Bot 中发送 /unlink。'
              : 'To unlink later, send /unlink in the Bot.'}
          </div>
        </div>
      )}
      {error && <p className="bot-share-error">{error}</p>}
    </div>
  );
}

function OsShellBar({
  language,
  runtimeAvailable,
  gamepadConnected,
  taskbarPlacement,
  launchedApplications,
  runningApplicationIds,
  onLaunchApplication,
  onOpenApps,
  onOpenTasks,
  onOpenFiles,
  onOpenSettings,
  onExit,
}: {
  language: AppLanguage;
  runtimeAvailable: boolean;
  gamepadConnected: boolean;
  taskbarPlacement: AppSettingsState['os']['taskbarPlacement'];
  launchedApplications: OsApplication[];
  runningApplicationIds: ReadonlySet<string>;
  onLaunchApplication: (application: OsApplication) => void;
  onOpenApps: () => void;
  onOpenTasks: () => void;
  onOpenFiles: () => void;
  onOpenSettings: () => void;
  onExit: () => void;
}) {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const locale = language === 'zh' ? 'zh-CN' : 'en-US';
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(now);
  const date = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    weekday: 'short',
  }).format(now);

  return (
    <header className="os-shell-bar" data-no-floating-input="true">
      <div className="os-shell-brand">
        <MonitorCog size={16} />
        <strong>CardBush OS</strong>
        <span className={runtimeAvailable ? 'ready' : ''} aria-hidden="true" />
      </div>
      <div className="os-shell-clock">
        <strong>{time}</strong>
        <span>{date}</span>
      </div>
      {taskbarPlacement === 'top' && launchedApplications.length > 0 && (
        <nav className="os-top-taskbar" aria-label={language === 'zh' ? '最近启动' : 'Recently launched'}>
          {launchedApplications.map((application) => (
            <button
              className={runningApplicationIds.has(application.id) ? 'running' : 'pinned'}
              type="button"
              data-os-control="true"
              key={application.id}
              title={application.name}
              onClick={() => onLaunchApplication(application)}
            >
              {application.icon
                ? <img src={application.icon} alt="" />
                : <span>{Array.from(application.name)[0]?.toLocaleUpperCase()}</span>}
            </button>
          ))}
        </nav>
      )}
      <div className="os-shell-actions">
        {gamepadConnected && (
          <span
            className="os-controller-status"
            title={language === 'zh' ? '手柄导航已启用' : 'Controller navigation enabled'}
          >
            <Gamepad2 size={15} />
          </span>
        )}
        <button
          type="button"
          data-os-control="true"
          data-os-overlay-trigger="true"
          title={language === 'zh' ? '应用' : 'Applications'}
          onClick={onOpenApps}
        >
          <LayoutGrid size={16} />
        </button>
        <button
          type="button"
          data-os-control="true"
          data-os-overlay-trigger="true"
          title={language === 'zh' ? '任务' : 'Tasks'}
          onClick={onOpenTasks}
        >
          <Monitor size={16} />
        </button>
        <button
          type="button"
          data-os-control="true"
          data-os-overlay-trigger="true"
          title={language === 'zh' ? 'AI 空间' : 'AI Space'}
          onClick={onOpenFiles}
        >
          <Folder size={16} />
        </button>
        <button
          type="button"
          data-os-control="true"
          data-os-overlay-trigger="true"
          title={language === 'zh' ? 'OS 设置' : 'OS settings'}
          onClick={onOpenSettings}
        >
          <Settings2 size={16} />
        </button>
        <button
          type="button"
          data-os-control="true"
          title={language === 'zh' ? '退出桌面 OS' : 'Exit desktop OS'}
          onClick={onExit}
        >
          <LogOut size={16} />
        </button>
      </div>
    </header>
  );
}

function OsTaskbar({
  language,
  applications,
  runningApplicationIds,
  onOpenApps,
  onLaunch,
}: {
  language: AppLanguage;
  applications: OsApplication[];
  runningApplicationIds: ReadonlySet<string>;
  onOpenApps: () => void;
  onLaunch: (application: OsApplication) => void;
}) {
  return (
    <nav className="os-bottom-taskbar" aria-label={language === 'zh' ? 'CardBush 任务栏' : 'CardBush taskbar'}>
      <div className="os-taskbar-handle" aria-hidden="true" />
      <div className="os-taskbar-content">
        <button type="button" data-os-control="true" data-os-overlay-trigger="true" onClick={onOpenApps} title={language === 'zh' ? '所有应用' : 'All apps'}>
          <LayoutGrid size={17} />
        </button>
        {applications.map((application) => (
          <button className={runningApplicationIds.has(application.id) ? 'running' : 'pinned'} type="button" data-os-control="true" key={application.id} title={application.name} onClick={() => onLaunch(application)}>
            {application.icon
              ? <img src={application.icon} alt="" />
              : <span>{Array.from(application.name)[0]?.toLocaleUpperCase()}</span>}
          </button>
        ))}
      </div>
    </nav>
  );
}

const osNineKeyGroups: Record<string, string> = {
  '1': '.,?!',
  '2': 'abc',
  '3': 'def',
  '4': 'ghi',
  '5': 'jkl',
  '6': 'mno',
  '7': 'pqrs',
  '8': 'tuv',
  '9': 'wxyz',
};

function OsNineKeyInput({
  language,
  value,
  onChange,
  onSubmit,
  onClose,
}: {
  language: AppLanguage;
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const [numeric, setNumeric] = useState(false);
  const cycleRef = useRef({ key: '', index: 0, at: 0 });

  const pressKey = (key: string) => {
    if (numeric) {
      onChange(`${value}${key}`);
      cycleRef.current = { key: '', index: 0, at: 0 };
      return;
    }
    const group = osNineKeyGroups[key] ?? key;
    const now = Date.now();
    const continuing = cycleRef.current.key === key && now - cycleRef.current.at < 900 && value.length > 0;
    const index = continuing ? (cycleRef.current.index + 1) % group.length : 0;
    const character = group[index];
    onChange(continuing ? `${value.slice(0, -1)}${character}` : `${value}${character}`);
    cycleRef.current = { key, index, at: now };
  };

  return (
    <section className="os-nine-key" aria-label={language === 'zh' ? '九键输入' : 'Nine-key input'}>
      <header>
        <span><Keyboard size={15} />{language === 'zh' ? '九键输入' : 'Nine-key input'}</span>
        <button type="button" data-os-control="true" onClick={() => setNumeric((current) => !current)}>{numeric ? '123' : 'abc'}</button>
        <button type="button" data-os-control="true" onClick={onClose}><X size={15} /></button>
      </header>
      <div className="os-nine-key-grid">
        {Object.entries(osNineKeyGroups).map(([key, letters]) => (
          <button type="button" data-os-control="true" key={key} onClick={() => pressKey(key)}>
            <strong>{key}</strong><small>{numeric ? key : letters.toLocaleUpperCase()}</small>
          </button>
        ))}
      </div>
      <footer>
        <button type="button" data-os-control="true" onClick={() => onChange(value.slice(0, -1))}>{language === 'zh' ? '删除' : 'Delete'}</button>
        <button type="button" data-os-control="true" onClick={() => onChange(`${value} `)}>{language === 'zh' ? '空格' : 'Space'}</button>
        <button type="button" data-os-control="true" disabled={!value.trim()} onClick={onSubmit}>{language === 'zh' ? '发送' : 'Send'}</button>
      </footer>
    </section>
  );
}

const osGamepadButtonOptions = [
  [0, 'A'], [1, 'B'], [2, 'X'], [3, 'Y'], [4, 'LB'], [5, 'RB'],
  [8, 'View'], [9, 'Menu'], [10, 'L3'], [11, 'R3'],
] as const;

function OsControlCenter({
  language,
  settings,
  onChange,
  onClose,
}: {
  language: AppLanguage;
  settings: AppSettingsState['os'];
  onChange: (settings: AppSettingsState['os']) => void;
  onClose: () => void;
}) {
  const updateGamepad = (key: keyof AppSettingsState['os']['gamepad'], value: number) => {
    onChange({ ...settings, gamepad: { ...settings.gamepad, [key]: value } });
  };
  const mappings = [
    ['confirmButton', language === 'zh' ? '确认' : 'Confirm'],
    ['backButton', language === 'zh' ? '返回' : 'Back'],
    ['keyboardButton', language === 'zh' ? '九键输入' : 'Nine-key input'],
    ['appsButton', language === 'zh' ? '应用' : 'Applications'],
    ['settingsButton', language === 'zh' ? '控制中心' : 'Control center'],
  ] as const;

  return (
    <aside className="os-control-center" data-no-floating-input="true">
      <header>
        <span><Settings2 size={16} />{language === 'zh' ? '控制中心' : 'Control center'}</span>
        <button type="button" data-os-control="true" onClick={onClose}><X size={16} /></button>
      </header>
      <section>
        <h3>{language === 'zh' ? '桌面' : 'Desktop'}</h3>
        <div className="os-control-segmented">
          <button
            type="button"
            data-os-control="true"
            aria-pressed={settings.taskbarPlacement === 'bottom'}
            onClick={() => onChange({ ...settings, taskbarPlacement: 'bottom' })}
          >{language === 'zh' ? '底部呼吸条' : 'Bottom bar'}</button>
          <button
            type="button"
            data-os-control="true"
            aria-pressed={settings.taskbarPlacement === 'top'}
            onClick={() => onChange({ ...settings, taskbarPlacement: 'top' })}
          >{language === 'zh' ? '顶部状态栏' : 'Top bar'}</button>
        </div>
        <label className="os-control-range">
          <span>
            {language === 'zh' ? '背景对比度' : 'Background contrast'}
            <output>{settings.backgroundContrast}%</output>
          </span>
          <input
            type="range"
            min="0"
            max="100"
            step="5"
            value={settings.backgroundContrast}
            data-os-control="true"
            onChange={(event) => onChange({
              ...settings,
              backgroundContrast: Number(event.currentTarget.value),
            })}
          />
        </label>
        <label className="os-control-toggle">
          <span>{language === 'zh' ? '开机启动' : 'Launch at login'}</span>
          <input type="checkbox" checked={settings.launchAtLogin} onChange={(event) => onChange({ ...settings, launchAtLogin: event.currentTarget.checked })} />
        </label>
        <label className="os-control-toggle">
          <span>{language === 'zh' ? '启动后直接进入 OS' : 'Open directly in OS mode'}</span>
          <input type="checkbox" checked={settings.startInOsMode} onChange={(event) => onChange({ ...settings, startInOsMode: event.currentTarget.checked })} />
        </label>
      </section>
      <section>
        <h3><Gamepad2 size={14} />{language === 'zh' ? '手柄' : 'Controller'}</h3>
        <div className="os-control-mappings">
          {mappings.map(([key, label]) => (
            <label key={key}>
              <span>{label}</span>
              <select data-os-control="true" value={settings.gamepad[key]} onChange={(event) => updateGamepad(key, Number(event.currentTarget.value))}>
                {osGamepadButtonOptions.map(([button, name]) => <option key={button} value={button}>{name}</option>)}
              </select>
            </label>
          ))}
        </div>
      </section>
      <p>{language === 'zh' ? '设置与普通模式共享，但在 OS 中保持即时生效。' : 'Settings are shared with standard mode and apply immediately.'}</p>
    </aside>
  );
}

function TopBar({
  title,
  sidebarCollapsed,
  botShareLabel,
  language,
  activeConversationId,
  conversationContentAvailable = false,
  botHandoffAvailable,
  onCreateSessionShareLink,
  onRefreshActiveSession,
  activeConsole,
  onToggleGit,
  onToggleTerminal,
  workSummaryVisible,
  reviewAvailable,
  onToggleWorkSummary,
  onOpenReview,
  onRevealSidebar,
}: {
  title: string;
  sidebarCollapsed: boolean;
  botShareLabel: string;
  language: AppLanguage;
  activeConversationId?: string;
  conversationContentAvailable?: boolean;
  botHandoffAvailable: boolean;
  onCreateSessionShareLink?: (
    request: SessionShareLinkRequest,
  ) => Promise<SessionShareLinkResult>;
  onRefreshActiveSession?: RefreshActiveSession;
  activeConsole?: ConsoleMode | null;
  onToggleGit?: () => void;
  onToggleTerminal?: () => void;
  workSummaryVisible?: boolean;
  reviewAvailable?: boolean;
  onToggleWorkSummary?: (anchor: HTMLElement) => void;
  onOpenReview?: () => void;
  onRevealSidebar: () => void;
}) {
  const [botMenuOpen, setBotMenuOpen] = useState(false);
  const [botHistoryRefreshing, setBotHistoryRefreshing] = useState(false);
  const botShareRef = useRef<HTMLDivElement>(null);
  const botShareEnabled = Boolean(
    conversationContentAvailable &&
    activeConversationId?.trim() &&
      onCreateSessionShareLink &&
      onRefreshActiveSession,
  );

  useEffect(() => {
    if (!botMenuOpen) {
      return undefined;
    }
    const handlePointerDown = (event: PointerEvent) => {
      if (!botShareRef.current?.contains(event.target as Node)) {
        setBotMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setBotMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [botMenuOpen]);

  useEffect(() => {
    setBotMenuOpen(false);
  }, [activeConversationId]);

  const refreshBotHistory = useCallback(async () => {
    if (!onRefreshActiveSession) {
      return;
    }
    setBotHistoryRefreshing(true);
    try {
      await onRefreshActiveSession({ silent: true });
    } catch {
      // The shared runtime status banner owns the visible failure state.
    } finally {
      setBotHistoryRefreshing(false);
    }
  }, [onRefreshActiveSession]);

  return (
    <div className="topbar">
      {sidebarCollapsed && (
        <button className="icon-button" type="button" onClick={onRevealSidebar}>
          <Menu size={20} />
        </button>
      )}
      <h1>{title}</h1>
      {onToggleWorkSummary && (
        <button
          className={`topbar-inspector-action ${workSummaryVisible ? 'active' : ''}`}
          type="button"
          data-work-summary-toggle
          onClick={(event) => onToggleWorkSummary(event.currentTarget)}
          title={language === 'zh' ? '显示或隐藏工作摘要' : 'Show or hide work summary'}
        >
          <Clipboard size={15} />
          <span>{language === 'zh' ? '摘要' : 'Summary'}</span>
        </button>
      )}
      {onOpenReview && reviewAvailable && (
        <button
          className="topbar-inspector-action"
          type="button"
          onClick={() => onOpenReview()}
          title={language === 'zh' ? '在右侧打开修改审查' : 'Open review on the right'}
        >
          <PanelRightOpen size={15} />
          <span>{language === 'zh' ? '审查' : 'Review'}</span>
        </button>
      )}
      {conversationContentAvailable && activeConversationId?.trim() && (
      <div className="bot-share-wrap" ref={botShareRef}>
        <button
          className="topbar-native-menu"
          type="button"
          disabled={!botShareEnabled}
          aria-expanded={botMenuOpen}
          aria-label={botShareLabel}
          title={
            botShareEnabled
              ? botShareLabel
              : !botHandoffAvailable
                ? language === 'zh'
                  ? 'BushServer 尚未提供 Bot 会话交接能力'
                  : 'BushServer does not expose Bot session handoff yet'
              : language === 'zh'
                ? '请先创建会话'
                : 'Create a chat first'
          }
          onClick={() => setBotMenuOpen((current) => !current)}
        >
          <span className="native-bot-share-icon">
            <BotPlatformIcon platform="any" />
          </span>
          <ChevronDown className="native-chevron-icon" size={14} />
        </button>
        {botMenuOpen &&
          activeConversationId &&
          onCreateSessionShareLink &&
          onRefreshActiveSession && (
            <BotShareMenu
              language={language}
              sessionId={activeConversationId}
              onCreateLink={onCreateSessionShareLink}
              onRefreshSession={onRefreshActiveSession}
              onClose={() => setBotMenuOpen(false)}
            />
          )}
      </div>
      )}
      <button
        className="topbar-square native-refresh-square"
        type="button"
        disabled={!onRefreshActiveSession || botHistoryRefreshing}
        onClick={() => void refreshBotHistory()}
        title={language === 'zh'
          ? '重新连接后端并刷新会话'
          : 'Reconnect backend and refresh sessions'}
      >
        {botHistoryRefreshing ? <LoaderCircle size={16} /> : <RefreshCw size={16} />}
      </button>
      {onToggleGit && (
        <button
          className={`topbar-square ${activeConsole === 'git' ? 'active' : ''}`}
          type="button"
          onClick={onToggleGit}
          title={language === 'zh' ? 'Git 控制台' : 'Git console'}
        >
          <GitBranch size={16} />
        </button>
      )}
      {onToggleTerminal && (
        <button
          className={`topbar-square ${
            activeConsole === 'terminal' ? 'active' : ''
          }`}
          type="button"
          onClick={onToggleTerminal}
          title={language === 'zh' ? '终端控制台' : 'Terminal console'}
        >
          <Terminal size={16} />
        </button>
      )}
    </div>
  );
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function workspaceRevertErrorMessage(error: unknown, language: AppLanguage) {
  if (isRuntimeWorkspaceSnapshotUnavailableError(error)) {
    return language === 'zh'
      ? 'Runtime 尚无完整恢复快照，已尝试使用桌面 diff 安全撤回。'
      : 'Runtime has no complete recovery snapshot; the desktop diff fallback was attempted.';
  }
  if (isBushServerHttpError(error)) {
    if (error.code === 'workspace_change_conflict') {
      return language === 'zh'
        ? '文件在该修改之后又发生了变化，为避免覆盖后续编辑，本次未执行撤回。'
        : 'A file changed after this edit, so nothing was overwritten.';
    }
    if (error.code === 'workspace_change_revert_unavailable') {
      return language === 'zh'
        ? '这组修改没有完整的恢复快照，无法安全撤回。'
        : 'This change does not have a complete recovery snapshot.';
    }
    if (error.statusCode === 404 || error.statusCode === 405) {
      return language === 'zh'
        ? '当前 BushServer 版本尚不支持快照撤回，请升级服务端。'
        : 'The current BushServer version does not support snapshot restore.';
    }
  }
  return errorMessage(error);
}

function snapshotRevertFallbackAllowed(error: unknown) {
  return isRuntimeWorkspaceSnapshotUnavailableError(error) || (
    isBushServerHttpError(error) && (
      error.code === 'workspace_change_revert_unavailable' ||
      error.statusCode === 404 ||
      error.statusCode === 405
    )
  );
}

function InteractionCard({
  language,
  interaction,
  onReply,
  onCancel,
}: {
  language: AppLanguage;
  interaction: PendingInteraction;
  onReply: (reply: string | InteractionReplyAnswer[]) => Promise<void>;
  onCancel: () => Promise<void>;
}) {
  const questions = interaction.questions ?? [];
  const [rawAnswer, setRawAnswer] = useState('');
  const [drafts, setDrafts] = useState<Record<string, InteractionAnswerDraft>>(
    () => initialInteractionDrafts(questions),
  );
  const [busy, setBusy] = useState(false);
  const permission = isPermissionInteraction(interaction);
  const structured = questions.length > 0 && interaction.replyMode !== 'raw_text_passthrough';
  const title =
    interaction.title ||
    (language === 'zh' ? '需要你的选择' : 'Input needed');
  const message =
    interaction.message ||
    interaction.description ||
    interactionPromptFromQuestions(questions, language);

  useEffect(() => {
    setDrafts(initialInteractionDrafts(questions));
    setRawAnswer('');
  }, [interaction.id, questions]);

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (busy) {
      return;
    }
    const payload = structured ? interactionAnswersFromDrafts(questions, drafts) : rawAnswer.trim();
    if ((Array.isArray(payload) && payload.length === 0) || (!Array.isArray(payload) && !payload)) {
      return;
    }
    setBusy(true);
    try {
      await onReply(payload);
    } finally {
      setBusy(false);
    }
  }

  async function submitPermission(optionId: string) {
    const question = permissionQuestion(questions);
    if (!question || busy) {
      return;
    }
    setBusy(true);
    try {
      await onReply([{ questionId: question.id, selectedOptionId: optionId }]);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (busy) {
      return;
    }
    setBusy(true);
    try {
      await onCancel();
    } finally {
      setBusy(false);
    }
  }

  if (permission) {
    return (
      <PermissionRequestCard
        language={language}
        interaction={interaction}
        busy={busy}
        onChoose={(optionId) => void submitPermission(optionId)}
        onCancel={() => void cancel()}
      />
    );
  }

  return (
      <form
        className="interaction-dialog interaction-card"
        data-no-floating-input="true"
        onSubmit={(event) => void submit(event)}
      >
        <header>
          <MessageSquare size={18} />
          <strong>{title}</strong>
          <button type="button" onClick={() => void cancel()} disabled={busy}>
            <X size={16} />
          </button>
        </header>
        <div className="interaction-dialog-body">
          {message && <p>{message}</p>}
          {structured ? (
            <div className="interaction-question-list">
              {questions.map((question) => (
                <InteractionQuestionField
                  key={question.id}
                  question={question}
                  language={language}
                  draft={drafts[question.id] ?? emptyInteractionDraft()}
                  onChange={(nextDraft) =>
                    setDrafts((current) => ({
                      ...current,
                      [question.id]: nextDraft,
                    }))
                  }
                />
              ))}
            </div>
          ) : (
            <textarea
              value={rawAnswer}
              autoFocus
              onChange={(event) => setRawAnswer(event.currentTarget.value)}
              placeholder={
                language === 'zh'
                  ? '输入你的回答'
                  : 'Type your reply'
              }
              rows={4}
            />
          )}
        </div>
        <footer>
          <button type="button" onClick={() => void cancel()} disabled={busy}>
            {interaction.cancelLabel || (language === 'zh' ? '取消' : 'Cancel')}
          </button>
          <button
            className="primary-button"
            type="submit"
            disabled={busy || !interactionReplyIsReady(questions, drafts, rawAnswer, structured)}
          >
            {busy ? <LoaderCircle size={14} /> : <ArrowUp size={14} />}
            {interaction.submitLabel || (language === 'zh' ? '继续' : 'Continue')}
          </button>
        </footer>
      </form>
  );
}

type InteractionAnswerDraft = {
  selectedOptionId?: string;
  selectedOptionIds: string[];
  inputText: string;
};

function InteractionQuestionField({
  question,
  language,
  draft,
  onChange,
}: {
  question: InteractionQuestion;
  language: AppLanguage;
  draft: InteractionAnswerDraft;
  onChange: (draft: InteractionAnswerDraft) => void;
}) {
  const showInput =
    question.needInput ||
    question.selectionMode === 'input';

  function toggleOption(optionId: string) {
    if (question.selectionMode === 'multiple') {
      const selected = draft.selectedOptionIds.includes(optionId)
        ? draft.selectedOptionIds.filter((item) => item !== optionId)
        : [...draft.selectedOptionIds, optionId];
      onChange({ ...draft, selectedOptionIds: selected });
      return;
    }
    onChange({
      ...draft,
      selectedOptionId: draft.selectedOptionId === optionId ? undefined : optionId,
    });
  }

  return (
    <section className="interaction-question">
      <strong>{question.label || question.question}</strong>
      {question.question && <small>{question.question}</small>}
      {question.options.length > 0 && (
        <div className="interaction-option-grid">
          {question.options.map((option) => {
            const active =
              question.selectionMode === 'multiple'
                ? draft.selectedOptionIds.includes(option.id)
                : draft.selectedOptionId === option.id;
            return (
              <button
                key={option.id}
                className={active ? 'active' : ''}
                type="button"
                onClick={() => toggleOption(option.id)}
              >
                <span>{option.label}</span>
                {option.description && <small>{option.description}</small>}
              </button>
            );
          })}
        </div>
      )}
      {showInput && (
        <textarea
          value={draft.inputText}
          onChange={(event) =>
            onChange({ ...draft, inputText: event.currentTarget.value })
          }
          placeholder={
            question.selectionMode === 'input'
              ? language === 'zh'
                ? '输入回答'
                : 'Type an answer'
              : language === 'zh'
                ? '也可以直接输入自定义回答'
                : 'Or type a custom answer'
          }
          rows={question.selectionMode === 'input' ? 3 : 2}
        />
      )}
    </section>
  );
}

function interactionPromptFromQuestions(
  questions: InteractionQuestion[],
  language: AppLanguage,
) {
  if (questions.length === 0) {
    return language === 'zh'
      ? '后端正在等待你补充信息。'
      : 'The backend is waiting for more information.';
  }
  return questions
    .map((question) => question.question.trim())
    .filter(Boolean)
    .join('\n');
}

function initialInteractionDrafts(questions: InteractionQuestion[]) {
  return Object.fromEntries(
    questions.map((question) => [question.id, emptyInteractionDraft()]),
  );
}

function emptyInteractionDraft(): InteractionAnswerDraft {
  return { selectedOptionIds: [], inputText: '' };
}

function interactionAnswersFromDrafts(
  questions: InteractionQuestion[],
  drafts: Record<string, InteractionAnswerDraft>,
): InteractionReplyAnswer[] {
  return questions.flatMap((question) => {
    const draft = drafts[question.id] ?? emptyInteractionDraft();
    const inputText = draft.inputText.trim();
    const answer: InteractionReplyAnswer = { questionId: question.id };
    if (question.selectionMode === 'multiple') {
      if (draft.selectedOptionIds.length > 0) {
        answer.selectedOptionIds = draft.selectedOptionIds;
      }
    } else if (question.selectionMode !== 'input' && draft.selectedOptionId) {
      answer.selectedOptionId = draft.selectedOptionId;
    }
    if (inputText) {
      answer.inputText = inputText;
    }
    return answer.selectedOptionId ||
      (answer.selectedOptionIds?.length ?? 0) > 0 ||
      answer.inputText
      ? [answer]
      : [];
  });
}

function interactionReplyIsReady(
  questions: InteractionQuestion[],
  drafts: Record<string, InteractionAnswerDraft>,
  rawAnswer: string,
  structured: boolean,
) {
  if (!structured) {
    return rawAnswer.trim().length > 0;
  }
  return questions.every((question) => {
    if (!question.required) {
      return true;
    }
    const draft = drafts[question.id] ?? emptyInteractionDraft();
    const hasInput = draft.inputText.trim().length > 0;
    if (question.selectionMode === 'input') {
      return hasInput;
    }
    if (question.selectionMode === 'multiple') {
      return draft.selectedOptionIds.length > 0 || hasInput;
    }
    return Boolean(draft.selectedOptionId) || hasInput;
  });
}

function inspectorSource(target: string) {
  const value = stripWrappingQuotes(target.trim());
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  if (/^file:\/\//i.test(value)) {
    if (isOfficeDocumentPath(value)) return officeDocumentPreviewUrl(value);
    return usesNativeFilePreview(value) ? value : textFilePreviewUrl(value);
  }
  if (/^cardbush-file:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (['office-preview', 'text-preview'].includes(parsed.hostname.toLowerCase())) {
        return value;
      }
      return localFilePreviewUrl(decodeURIComponent(parsed.pathname));
    } catch {
      return value;
    }
  }
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
    if (isOfficeDocumentPath(value)) {
      return officeDocumentPreviewUrl(value);
    }
    return usesNativeFilePreview(value)
      ? localFilePreviewUrl(value)
      : textFilePreviewUrl(value);
  }
  if (isOfficeDocumentPath(value)) {
    return officeDocumentPreviewUrl(value);
  }
  return usesNativeFilePreview(value) ? fileUrl(value) : textFilePreviewUrl(value);
}

function InspectorWebview({
  source,
  language,
}: {
  source: string;
  language: AppLanguage;
}) {
  const webviewRef = useRef<HTMLElement | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return undefined;
    const finish = () => setLoading(false);
    const fail = () => setLoading(false);
    webview.addEventListener('did-finish-load', finish);
    webview.addEventListener('did-fail-load', fail);
    return () => {
      webview.removeEventListener('did-finish-load', finish);
      webview.removeEventListener('did-fail-load', fail);
    };
  }, [source]);

  return (
    <div className={`right-inspector-preview ${loading ? 'loading' : 'ready'}`}>
      {createElement('webview', {
        ref: webviewRef,
        className: 'right-inspector-webview',
        src: source,
        webpreferences: 'contextIsolation=yes,nodeIntegration=no,sandbox=yes',
      })}
      {loading && (
        <div className="right-inspector-preview-loading" role="status">
          <span />
          <span />
          <span />
          <small>{language === 'zh' ? '正在加载预览' : 'Loading preview'}</small>
        </div>
      )}
    </div>
  );
}

function isOfficeDocumentPath(value: string) {
  return /\.(?:docx?|xlsx?|pptx?)$/i.test(value.split(/[?#]/, 1)[0]);
}

function officeDocumentPreviewUrl(value: string) {
  return `cardbush-file://office-preview/?path=${encodeURIComponent(value)}`;
}

function textFilePreviewUrl(value: string) {
  return `cardbush-file://text-preview/?path=${encodeURIComponent(value)}`;
}

function usesNativeFilePreview(value: string) {
  return /\.(?:html?|xhtml|pdf|svg|png|jpe?g|gif|webp|bmp|ico|mp3|m4a|mp4|aac|wav|ogg|oga|opus|flac|webm)$/i.test(
    value.split(/[?#]/, 1)[0],
  );
}

function localFilePreviewUrl(value: string) {
  const normalized = value.replaceAll('\\', '/').replace(/^\/+/, '');
  const encoded = normalized
    .split('/')
    .map((part, index) => index === 0 && /^[a-z]:$/i.test(part) ? part : encodeURIComponent(part))
    .join('/');
  return `file:///${encoded}`;
}

function FeaturePanel({
  language,
  section,
  activeProjectDir,
  workflowValidationAvailable,
  sidebarCollapsed,
  onRevealSidebar,
  conversations,
  skills,
  disabledSkillNames,
  disabledToolNames,
  onToggleSkill,
  onToggleTool,
  onReloadSkills,
  onLoadSkillDetail,
  onCreateConversation,
  onOpenConversation,
}: {
  language: AppLanguage;
  section: AppSection;
  activeProjectDir?: string;
  workflowValidationAvailable: boolean;
  sidebarCollapsed: boolean;
  onRevealSidebar: () => void;
  conversations: ConversationSummary[];
  skills: SkillSummary[];
  disabledSkillNames: Set<string>;
  disabledToolNames: Set<string>;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  onToggleTool: (toolName: string, enabled: boolean) => void;
  onReloadSkills: () => Promise<SkillSummary[]>;
  onLoadSkillDetail: (skillName: string) => Promise<SkillDetail>;
  onCreateConversation: () => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  const teamWorkspace = useTeamWorkspaceState();
  const activeTeam = teamWorkspace.teams.find((team) => team.id === teamWorkspace.activeTeamId);
  const label = section === 'team'
    ? activeTeam?.name.trim() || sectionLabels[section][language]
    : sectionLabels[section][language];
  return (
    <div className="feature-panel">
      <TopBar
        title={label}
        sidebarCollapsed={sidebarCollapsed}
        botShareLabel={language === 'zh' ? '继续到 Bot' : 'Continue to Bot'}
        language={language}
        botHandoffAvailable={false}
        activeConsole={null}
        onRevealSidebar={onRevealSidebar}
      />
      <Suspense fallback={<FeaturePanelLoading language={language} />}>
        <LazyFeatureContentPanel
          language={language}
          section={section}
          activeProjectDir={activeProjectDir}
          workflowValidationAvailable={workflowValidationAvailable}
          conversations={conversations}
          skills={skills}
          disabledSkillNames={disabledSkillNames}
          disabledToolNames={disabledToolNames}
          onToggleSkill={onToggleSkill}
          onToggleTool={onToggleTool}
          onReloadSkills={onReloadSkills}
          onLoadSkillDetail={onLoadSkillDetail}
          onCreateConversation={onCreateConversation}
          onOpenConversation={onOpenConversation}
        />
      </Suspense>
    </div>
  );
}
