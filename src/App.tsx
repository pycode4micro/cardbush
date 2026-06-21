import {
  AlertCircle,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  CheckCircle2,
  Check,
  ChevronDown,
  Circle,
  Clipboard,
  Clock3,
  Edit3,
  ExternalLink,
  Eye,
  EyeOff,
  Folder,
  GitBranch,
  LoaderCircle,
  Menu,
  MessageSquare,
  Monitor,
  Music2,
  Network,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  Puzzle,
  RefreshCw,
  Search,
  Smartphone,
  Sparkles,
  Terminal,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import {
  Component,
  type CSSProperties,
  type ErrorInfo,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type UIEvent,
  type WheelEvent,
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
  fetchBackendCapabilities,
  fetchModelConfigs,
  fetchProjectContext,
  fetchSessionScene,
  fetchSessionScenes,
  saveModelConfigs,
  saveProjectContext,
  type SessionShareLinkResult,
} from './backend/api';
import { standardImageInputToolDefaultName } from './backend/toolVisibility';
import {
  normalizeChatMessagesForDisplay,
  useCardbushChat,
  type QueuedChatMessage,
} from './hooks/useCardbushChat';
import { BotPlatformIcon } from './components/BotPlatformIcon';
import { SidebarResizer } from './components/SidebarResizer';
import {
  MessageListFooter,
  absoluteBottomScrollTop,
  isMessageTailVisible,
  isScrollerNearVisualBottom,
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
  type GuidanceMode,
} from './features/chatMessages';
import {
  Composer,
  quickPayloadText,
  type QuickLoadPayload,
} from './features/composer';
import {
  ConsoleDock,
  type ConsoleMode,
} from './features/console';
import {
  changeRootForConversation,
  conversationWorkspaceRoot,
} from './features/conversationWorkspace';
import {
  ChatSidebar,
  ConversationChangeDialog,
  type ProjectAction,
} from './features/sidebar';
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
  type ConversationChangeReport,
} from './features/tools';
import { LocalMusicPanel } from './features/LocalMusicPanel';
import { SettingsView } from './features/SettingsView';
import { FeatureContentPanel } from './features/panels';
import { CardlingSceneHost } from './features/cardling/CardlingSceneHost';
import {
  cardlingSceneFromSessionSceneRecord,
  cardlingSceneKey,
  cardlingSceneRevisionKey,
  hasSceneHtml,
  latestCardlingSceneFromMessages,
  latestSessionSceneRecord,
  sceneAutoPlayEnabled,
  sceneString,
  type CardlingScene,
} from './features/cardling/scene';
import type {
  AppLanguage,
  AppLanguageMode,
  AppSection,
  AppSettingsState,
  BackendCapabilities,
  ChatMessage,
  ChatToolExecution,
  CompanionMotionMode,
  CompanionSettings,
  CompanionSize,
  ConversationSummary,
  BotPlatform,
  LightThemeStyle,
  ManagedModelConfig,
  PermissionMode,
  ReferencePlanMode,
  RuntimeProfileSummary,
  PendingInteraction,
  InteractionQuestion,
  InteractionReplyAnswer,
  ProjectItem,
  SettingsSection,
  SkillSummary,
  SkillDetail,
  ThemePreference,
  ThemeMode,
} from './types';

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

function scrollDebug(label: string, data: Record<string, unknown>) {
  void window.cardbushDesktop
    ?.writeDebugLog?.('scroll', {
      label,
      ...data,
    })
    .catch(() => undefined);
}

const defaultAppSettings: AppSettingsState = {
  proxy: {
    mode: 'none',
    httpProxy: '',
    httpsProxy: '',
    noProxy: '127.0.0.1,localhost,::1',
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
  const [musicPanelOpen, setMusicPanelOpen] = useState(false);
  const [sidebarWidth, setSidebarWidthState] = useState(() =>
    readInitialSidebarWidth(),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] =
    useState<SettingsSection>('profile');
  const [projectItems, setProjectItems] = useState<ProjectItem[]>(readProjectItems);
  const [wallpaperAccent, setWallpaperAccent] = useState<WallpaperAccent | null>(null);
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
  const [visualInputEnabledSetting, setVisualInputEnabledSetting] = useState(
    readVisualInputEnabled,
  );
  const [backendCapabilities, setBackendCapabilities] =
    useState<BackendCapabilities>(defaultBackendCapabilities);
  const [modelConfigSyncReady, setModelConfigSyncReady] = useState(false);
  const [backendDefaultModelName, setBackendDefaultModelName] = useState('');
  const lastSavedModelConfigSignatureRef = useRef('');
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
    if (!backendCapabilities.localMusicLibrary) {
      setMusicPanelOpen(false);
    }
  }, [backendCapabilities.localMusicLibrary]);

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
          setBackendDefaultModelName(defaultConfig?.modelName ?? '');
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
          setBackendDefaultModelName(savedDefault?.modelName ?? '');
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
  const effectiveDisabledToolNames = useMemo(
    () =>
      new Set(
        [...disabledToolNames].filter(
          (toolName) => toolName.trim() !== standardImageInputToolName,
        ),
      ),
    [disabledToolNames, standardImageInputToolName],
  );
  const chat = useCardbushChat(appSettings.managedModelConfigs, availableModels, {
    projectContexts,
    disabledSkillNames,
    disabledToolNames: effectiveDisabledToolNames,
    standardImageInputEnabled: visualInputEnabled,
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

  useEffect(() => {
    const defaultName = backendDefaultModelName.trim();
    if (!defaultName) {
      return;
    }
    if (availableModels.includes(defaultName) && chat.selectedModel !== defaultName) {
      chat.setSelectedModel(defaultName);
    }
    setBackendDefaultModelName('');
  }, [availableModels, backendDefaultModelName, chat]);

  useEffect(() => {
    if (!modelConfigSyncReady) {
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
    }).catch(() => {
      lastSavedModelConfigSignatureRef.current = '';
    });
  }, [
    appSettings.managedModelConfigs,
    chat.selectedModel,
    modelConfigSyncReady,
  ]);

  const fallbackProjectDir = useMemo(
    () => projectItems.find((project) => !project.archived)?.rootPath.trim() || '',
    [projectItems],
  );
  const conversationProjectDir = conversationWorkspaceRoot(chat.activeConversation);
  const activeProjectDir =
    conversationProjectDir ||
    (!chat.activeConversation ? fallbackProjectDir || undefined : undefined);
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
  const [revertingChangeId, setRevertingChangeId] = useState('');
  const [changeReviewNotice, setChangeReviewNotice] = useState('');
  const changeReportsByConversation = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(chat.messagesByConversation)
          .map(([conversationId, messages]) => [
            conversationId,
            changeReportsFromMessages(messages),
          ] as const)
          .filter(([, reports]) => reports.length > 0),
      ) as Record<string, ConversationChangeReport[]>,
    [chat.messagesByConversation],
  );
  const changeReviewConversation =
    chat.conversations.find((item) => item.id === changeReviewConversationId) ?? null;
  const changeReviewReports = changeReviewConversationId
    ? changeReportsByConversation[changeReviewConversationId] ?? []
    : [];

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
    persistProjectItems(projectItems);
  }, [projectItems]);

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
        '--sidebar-width': `${sidebarWidth}px`,
        ...appFontStyle,
      } as CSSProperties)
    : ({
        '--sidebar-width': `${sidebarWidth}px`,
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

  const createConversation = useCallback(
    (projectDir?: string) => {
      setSection('chat');
      void chat.startConversation(projectDir);
    },
    [chat],
  );

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
      if (!root) {
        const message =
          language === 'zh'
            ? '没有可用于撤回的项目路径。'
            : 'No project path is available for revert.';
        setChangeReviewNotice(message);
        window.alert(message);
        return;
      }
      if (!window.cardbushDesktop?.revertFileChanges) {
        const message =
          language === 'zh'
            ? '当前环境缺少撤回文件修改的桌面接口。'
            : 'The desktop revert API is not available.';
        setChangeReviewNotice(message);
        window.alert(message);
        return;
      }
      const files = serializeToolChangeReport(report);
      if (files.length === 0) {
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
          ? `确定撤回这组修改吗？将按 diff 反向修改 ${files.length} 个文件。`
          : `Revert this change set? This will reverse-patch ${files.length} file(s).`,
      );
      if (!confirmed) {
        return;
      }
      setRevertingChangeId(report.id);
      setChangeReviewNotice('');
      try {
        const result = await window.cardbushDesktop.revertFileChanges(root, files);
        const message =
          result.output.trim() ||
          (language === 'zh'
            ? `已撤回 ${result.revertedFiles} 个文件的修改。`
            : `Reverted ${result.revertedFiles} file(s).`);
        setChangeReviewNotice(message);
        await refreshProjectGitStatus(root);
      } catch (caught) {
        const message =
          language === 'zh'
            ? `撤回失败：${errorMessage(caught)}`
            : `Revert failed: ${errorMessage(caught)}`;
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
      if (!root || reversibleReports.length === 0) {
        const message =
          language === 'zh'
            ? '没有可撤回的会话修改。'
            : 'No reversible changes were found for this chat.';
        setChangeReviewNotice(message);
        window.alert(message);
        return;
      }
      if (!window.cardbushDesktop?.revertFileChanges) {
        const message =
          language === 'zh'
            ? '当前环境缺少撤回文件修改的桌面接口。'
            : 'The desktop revert API is not available.';
        setChangeReviewNotice(message);
        window.alert(message);
        return;
      }
      const fileCount = reversibleReports.reduce(
        (sum, item) => sum + item.files.length,
        0,
      );
      const confirmed = window.confirm(
        language === 'zh'
          ? `确定撤回这个会话里的全部修改吗？将按时间倒序反向修改 ${fileCount} 个文件。`
          : `Revert all changes in this chat? This will reverse-patch ${fileCount} file(s) in reverse order.`,
      );
      if (!confirmed) {
        return;
      }
      setRevertingChangeId(`conversation:${conversationId}`);
      setChangeReviewNotice('');
      try {
        let revertedFiles = 0;
        const outputs: string[] = [];
        for (const item of [...reversibleReports].reverse()) {
          const result = await window.cardbushDesktop.revertFileChanges(root, item.files);
          revertedFiles += result.revertedFiles;
          if (result.output.trim()) {
            outputs.push(result.output.trim());
          }
        }
        setChangeReviewNotice(
          outputs.join('\n') ||
            (language === 'zh'
              ? `已撤回 ${revertedFiles} 个文件的修改。`
              : `Reverted ${revertedFiles} file(s).`),
        );
        await refreshProjectGitStatus(root);
      } catch (caught) {
        const message =
          language === 'zh'
            ? `撤回失败：${errorMessage(caught)}`
            : `Revert failed: ${errorMessage(caught)}`;
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
    setSettingsOpen(true);
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
      className={`app theme-${theme}${customBackgroundImagePath ? ' has-custom-background' : ''}`}
      lang={language}
      style={appStyle}
    >
      <WindowFrame
        musicOpen={musicPanelOpen}
        musicAvailable={backendCapabilities.localMusicLibrary}
        onToggleMusic={() => setMusicPanelOpen((open) => !open)}
        onOpenBotSettings={() => openSettings('bots')}
        onOpenCacheSettings={() => openSettings('cache')}
      />
      {musicPanelOpen && backendCapabilities.localMusicLibrary && (
        <LocalMusicPanel
          language={language}
          onClose={() => setMusicPanelOpen(false)}
        />
      )}
      {settingsOpen ? (
        <SettingsView
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
          initialSection={settingsInitialSection}
          onBack={() => setSettingsOpen(false)}
          onThemePreferenceChange={setThemePreference}
          onLightThemeStyleChange={setLightThemeStyle}
          onLanguageModeChange={setLanguageMode}
          onSettingsChange={updateAppSettings}
          onUseModel={chat.setSelectedModel}
          onSidebarWidthChange={setSidebarWidth}
          onConversationHistoryCleared={() => chat.reloadConversations()}
          onAgentConfigPackagesChanged={async () => {
            await chat.reloadRuntimeProfiles();
          }}
        />
      ) : (
        <main className="desktop-shell">
          {!sidebarCollapsed && (
            <>
              <ChatSidebar
                language={language}
                section={section}
                activeConversationId={chat.activeConversationId}
                runningConversationIds={runningConversationIds}
                projects={projectItems}
                conversations={chat.conversations}
                changeReportsByConversation={changeReportsByConversation}
                onSectionChange={setSection}
                onConversationChange={(id) => {
                  chat.openConversation(id);
                  setSection('chat');
                }}
                onCreateConversation={() => {
                  createConversation();
                }}
                onAddProject={() => void addProject()}
                onProjectAction={(action, project) => void handleProjectAction(action, project)}
                onDeleteConversation={chat.deleteConversation}
                onRenameConversation={chat.renameConversation}
                onOpenConversationChanges={(conversationId) => {
                  setChangeReviewConversationId(conversationId);
                  setChangeReviewNotice('');
                }}
                onOpenSettings={() => openSettings('profile')}
              />
              <SidebarResizer
                language={language}
                onWidthChange={setSidebarWidth}
                onCollapse={() => setSidebarCollapsed(true)}
              />
            </>
          )}
          <section className="main-stage">
            {section === 'chat' ? (
              <ChatPanel
                language={language}
                title={chat.activeConversation?.title ?? 'cardbush'}
                sidebarCollapsed={sidebarCollapsed}
                onRevealSidebar={() => setSidebarCollapsed(false)}
                activeConversationId={chat.activeConversationId}
                activeProjectDir={activeProjectDir}
                projectContext={projectContexts[projectContextKey(activeProjectDir)] ?? ''}
                messages={chat.activeMessages}
                skills={chat.skills}
                disabledSkillNames={disabledSkillNames}
                visualInputAvailable={visualInputAvailable}
                visualInputEnabled={visualInputEnabled}
                loading={chat.loading || chat.messagesLoading}
                sending={chat.sending}
                activeTurnId={chat.activeTurnId}
                queuedMessageCount={chat.queuedMessageCount}
                queuedMessagePreview={chat.queuedMessagePreview}
                queuedMessages={chat.queuedMessages}
                pendingInteraction={chat.pendingInteraction}
                error={chat.error}
                notice={chat.notice}
                selectedModel={chat.selectedModel}
                availableModels={availableModels}
                selectedRuntimeProfile={chat.selectedRuntimeProfile}
                runtimeProfiles={chat.runtimeProfiles}
                referencePlanMode={chat.referencePlanMode}
                permissionMode={chat.permissionMode}
                botControlAvailable={backendCapabilities.botControl}
                gitAvailable={backendCapabilities.git}
                terminalAvailable={backendCapabilities.terminal}
                onModelChange={chat.setSelectedModel}
                onRuntimeProfileChange={chat.setSelectedRuntimeProfile}
                onReferencePlanModeChange={chat.setReferencePlanMode}
                onPermissionModeChange={chat.setPermissionMode}
                onConfigureModels={() => openSettings('models')}
                onCreateConversation={() => createConversation(activeProjectDir)}
                onSaveProjectContext={saveActiveProjectContext}
                onToggleSkill={toggleSkillEnabled}
                onVisualInputEnabledChange={setVisualInputEnabled}
                onCreateSessionShareLink={chat.createSessionShareLink}
                onRefreshActiveSession={refreshBackendAndActiveSession}
                onSend={chat.sendMessage}
                onRegenerate={chat.regenerateAssistantMessage}
                onEditUserMessage={chat.editUserMessageAndRegenerate}
                onGuideMessage={chat.sendTurnGuidance}
                onGuideQueuedMessage={chat.sendQueuedMessageAsGuidance}
                onRemoveQueuedMessage={chat.removeQueuedMessage}
                onRevertChangeReport={(report, message) =>
                  revertChangeReport(
                    message.conversationId?.trim() || chat.activeConversationId,
                    report,
                  )
                }
                onReplyInteraction={chat.replyToInteraction}
                onCancelInteraction={chat.cancelPendingInteraction}
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
                sidebarCollapsed={sidebarCollapsed}
                onRevealSidebar={() => setSidebarCollapsed(false)}
                conversations={chat.conversations}
                skills={chat.skills}
                disabledSkillNames={disabledSkillNames}
                onToggleSkill={toggleSkillEnabled}
                onReloadSkills={chat.reloadSkills}
                onLoadSkillDetail={chat.loadSkillDetail}
                onCreateConversation={() => createConversation(activeProjectDir)}
                onOpenConversation={(conversationId) => {
                  chat.openConversation(conversationId);
                  setSection('chat');
                }}
              />
            )}
          </section>
        </main>
      )}
      {changeReviewConversation && changeReviewReports.length > 0 && (
        <ConversationChangeDialog
          language={language}
          conversation={changeReviewConversation}
          reports={changeReviewReports}
          notice={changeReviewNotice}
          revertingChangeId={revertingChangeId}
          onClose={() => {
            setChangeReviewConversationId('');
            setChangeReviewNotice('');
          }}
          onRevert={(report) =>
            revertChangeReport(changeReviewConversation.id, report)
          }
          onRevertAll={() =>
            revertConversationReports(changeReviewConversation.id, changeReviewReports)
          }
        />
      )}
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
      }));
    }
    return decoded
      .filter((item): item is Record<string, unknown> => isRecord(item))
      .map((item) => ({
        id: String(item.id ?? ''),
        provider: String(item.provider ?? ''),
        apiKey: String(item.apiKey ?? ''),
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

function persistAppSettings(settings: AppSettingsState) {
  window.localStorage.setItem('cardbush_proxy_mode', settings.proxy.mode);
  window.localStorage.setItem('cardbush_proxy_http', settings.proxy.httpProxy);
  window.localStorage.setItem('cardbush_proxy_https', settings.proxy.httpsProxy);
  window.localStorage.setItem('cardbush_proxy_no_proxy', settings.proxy.noProxy);
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
    JSON.stringify(settings.managedModelConfigs),
  );
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
    if (!provider || !modelName) {
      continue;
    }
    const key = `${provider.toLowerCase()}\u0000${modelName.toLowerCase()}\u0000${apiKey.toLowerCase()}\u0000${baseUrl.toLowerCase()}`;
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
      modelName,
      baseUrl,
      ...(maxContextTokens ? { maxContextTokens } : {}),
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

function newModelConfigId() {
  return `mm-${Date.now()}-${Math.floor(Math.random() * 9000) + 1000}`;
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
    .map((item) => item.modelName.trim())
    .filter((model) => model && seen.add(model.toLowerCase()));
}

function defaultModelConfigId(configs: ManagedModelConfig[], selectedModel: string) {
  const selected = selectedModel.trim().toLowerCase();
  return (
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
  musicOpen,
  musicAvailable,
  onToggleMusic,
  onOpenBotSettings,
  onOpenCacheSettings,
}: {
  musicOpen: boolean;
  musicAvailable: boolean;
  onToggleMusic: () => void;
  onOpenBotSettings: () => void;
  onOpenCacheSettings: () => void;
}) {
  const [maximized, setMaximized] = useState(false);

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
      {musicAvailable && (
        <button
          className={`music-chip no-drag ${musicOpen ? 'active' : ''}`}
          type="button"
          title="Local Music"
          onClick={onToggleMusic}
        >
          <Music2 size={14} />
          <span>Music</span>
        </button>
      )}
      <button className="bot-chip no-drag" type="button" onClick={onOpenBotSettings}>
        BOT
      </button>
      <button
        className="bot-chip cache-chip no-drag"
        type="button"
        onClick={onOpenCacheSettings}
      >
        缓存
      </button>
      <div className="window-spacer" />
      <WindowButton label="minimize" onClick={() => window.cardbushDesktop?.minimize()}>
        <span className="window-glyph minimize" aria-hidden="true" />
      </WindowButton>
      <WindowButton
        label={maximized ? 'restore' : 'maximize'}
        onClick={() => void toggleMaximize()}
      >
        <span
          className={`window-glyph ${maximized ? 'restore' : 'maximize'}`}
          aria-hidden="true"
        />
      </WindowButton>
      <WindowButton
        label="close"
        danger
        onClick={() => window.cardbushDesktop?.closeToTray()}
      >
        <span className="window-glyph close" aria-hidden="true" />
      </WindowButton>
    </header>
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

function ChatPanel({
  language,
  title,
  sidebarCollapsed,
  onRevealSidebar,
  activeConversationId,
  activeProjectDir,
  projectContext,
  messages,
  skills,
  disabledSkillNames,
  visualInputAvailable,
  visualInputEnabled,
  loading,
  sending,
  activeTurnId,
  queuedMessageCount,
  queuedMessagePreview,
  queuedMessages,
  pendingInteraction,
  error,
  notice,
  selectedModel,
  availableModels,
  selectedRuntimeProfile,
  runtimeProfiles,
  referencePlanMode,
  permissionMode,
  botControlAvailable,
  gitAvailable,
  terminalAvailable,
  onModelChange,
  onRuntimeProfileChange,
  onReferencePlanModeChange,
  onPermissionModeChange,
  onConfigureModels,
  onCreateConversation,
  onSaveProjectContext,
  onToggleSkill,
  onVisualInputEnabledChange,
  onCreateSessionShareLink,
  onRefreshActiveSession,
  onSend,
  onRegenerate,
  onEditUserMessage,
  onGuideMessage,
  onGuideQueuedMessage,
  onRemoveQueuedMessage,
  onRevertChangeReport,
  onReplyInteraction,
  onCancelInteraction,
  onCancel,
  onClearError,
  onClearNotice,
  draft,
  onDraftChange,
}: {
  language: AppLanguage;
  title: string;
  sidebarCollapsed: boolean;
  onRevealSidebar: () => void;
  activeConversationId: string;
  activeProjectDir?: string;
  projectContext: string;
  messages: ChatMessage[];
  skills: SkillSummary[];
  disabledSkillNames: Set<string>;
  visualInputAvailable: boolean;
  visualInputEnabled: boolean;
  loading: boolean;
  sending: boolean;
  activeTurnId: string;
  queuedMessageCount: number;
  queuedMessagePreview: string;
  queuedMessages: QueuedChatMessage[];
  pendingInteraction: PendingInteraction | null;
  error: string | null;
  notice: string | null;
  selectedModel: string;
  availableModels: string[];
  selectedRuntimeProfile: string;
  runtimeProfiles: RuntimeProfileSummary[];
  referencePlanMode: ReferencePlanMode;
  permissionMode: PermissionMode;
  botControlAvailable: boolean;
  gitAvailable: boolean;
  terminalAvailable: boolean;
  onModelChange: (value: string) => void;
  onRuntimeProfileChange: (value: string) => void;
  onReferencePlanModeChange: (value: ReferencePlanMode) => void;
  onPermissionModeChange: (value: PermissionMode) => void;
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
  onRegenerate: (message: ChatMessage) => Promise<void>;
  onEditUserMessage: (message: ChatMessage, content: string) => Promise<void>;
  onGuideMessage: (
    message: ChatMessage,
    guidance: string,
    mode: 'append_context' | 'interrupt_and_continue',
  ) => Promise<void>;
  onGuideQueuedMessage: (
    queuedId: string,
    mode?: 'append_context' | 'interrupt_and_continue',
  ) => Promise<void>;
  onRemoveQueuedMessage: (queuedId: string) => void;
  onRevertChangeReport: (
    report: ConversationChangeReport,
    message: ChatMessage,
  ) => Promise<void>;
  onReplyInteraction: (reply: string | InteractionReplyAnswer[]) => Promise<void>;
  onCancelInteraction: () => Promise<void>;
  onCancel: () => Promise<void>;
  onClearError: () => void;
  onClearNotice: () => void;
  draft: string;
  onDraftChange: (value: string) => void;
}) {
  const renderMessages = useMemo(
    () => normalizeChatMessagesForDisplay(messages),
    [messages],
  );
  const showWelcome = !loading && renderMessages.length === 0;
  const listRef = useRef<VirtuosoHandle>(null);
  const listScrollerRef = useRef<HTMLElement | null>(null);
  const chatBodyRef = useRef<HTMLDivElement>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const scrollBottomButtonRef = useRef<HTMLButtonElement>(null);
  const atBottomRef = useRef(true);
  const autoFollowStreamRef = useRef(true);
  const userDetachedFromBottomRef = useRef(false);
  const showScrollBottomRef = useRef(false);
  const pendingSubmittedUserFocusRef = useRef(false);
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
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [consoleMode, setConsoleMode] = useState<ConsoleMode | null>(null);
  const [composerDockHeight, setComposerDockHeight] = useState(0);
  const [chatScrollbarGutter, setChatScrollbarGutter] = useState(0);
  const [activeScene, setActiveScene] = useState<CardlingScene | null>(null);
  const [availableScene, setAvailableScene] = useState<CardlingScene | null>(null);
  const [activeSceneInitialAutoPlay, setActiveSceneInitialAutoPlay] = useState(false);
  const activeSceneKeyRef = useRef('');
  const activeSceneRevisionRef = useRef('');
  const dismissedSceneKeysRef = useRef(new Set<string>());
  const autoPlayedSceneKeysRef = useRef(new Set<string>());
  const streamStatusHeight = 0;
  const virtuosoComponents = useMemo(() => ({ Footer: MessageListFooter }), []);

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

  const isLatestMessageTailVisible = useCallback(
    (scroller: HTMLElement, tolerance = 36) => {
      const latestMessage = renderMessages[renderMessages.length - 1];
      if (!latestMessage) {
        return true;
      }
      return isMessageTailVisible(scroller, latestMessage.id, {
        composerDockHeight,
        streamStatusHeight,
        tolerance,
      });
    },
    [composerDockHeight, renderMessages, streamStatusHeight],
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

  const updateChatScrollbarGutter = useCallback((scroller: HTMLElement | null) => {
    const nextGutter = scroller
      ? Math.max(0, Math.ceil(scroller.offsetWidth - scroller.clientWidth))
      : 0;
    setChatScrollbarGutter((current) =>
      current === nextGutter ? current : nextGutter,
    );
  }, []);

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
    (scene: CardlingScene, options?: { autoPlay?: boolean; fetchLatest?: boolean }) => {
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
      if (!options?.fetchLatest || !scene.sessionId?.trim() || !scene.sceneId.trim()) {
        return;
      }
      void fetchSessionScene({
        sessionId: scene.sessionId,
        sceneId: scene.sceneId,
      })
        .then((record) => {
          if (!record) {
            return;
          }
          const storedScene = cardlingSceneFromSessionSceneRecord(
            record,
            scene.sessionId,
          );
          if (!storedScene) {
            return;
          }
          const storedRevision = cardlingSceneRevisionKey(storedScene);
          setAvailableScene((current) =>
            current && cardlingSceneRevisionKey(current) === storedRevision
              ? current
              : storedScene,
          );
          setActiveScene((current) => {
            if (current?.sceneId !== scene.sceneId) {
              return current;
            }
            if (activeSceneRevisionRef.current === storedRevision) {
              return current;
            }
            activeSceneRevisionRef.current = storedRevision;
            return storedScene;
          });
          if (activeSceneKeyRef.current === key) {
            activeSceneKeyRef.current = cardlingSceneKey(storedScene);
          }
        })
        .catch(() => undefined);
    },
    [nextSceneInitialAutoPlay],
  );

  const openScene = useCallback((scene: CardlingScene) => {
    dismissedSceneKeysRef.current.delete(cardlingSceneKey(scene));
    showScene(scene, { fetchLatest: true });
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
    (index: number, messageId: string) => {
      pendingSubmittedUserFocusRef.current = false;
      programmaticScrollUntilRef.current = Date.now() + 1200;
      manualScrollDetachUntilRef.current = 0;
      autoFollowStreamRef.current = true;
      userDetachedFromBottomRef.current = false;
      setScrollBottomVisible(false);
      window.requestAnimationFrame(() => {
        listRef.current?.scrollToIndex({
          index,
          align: 'start',
          behavior: 'auto',
        });
        window.requestAnimationFrame(() => {
          positionMessageAtReadingAnchor(messageId);
          window.requestAnimationFrame(() => {
            positionMessageAtReadingAnchor(messageId);
          });
        });
      });
    },
    [positionMessageAtReadingAnchor, setScrollBottomVisible],
  );

  const ensureMessageBottomVisible = useCallback(
    (messageId: string, reason = 'stream') => {
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
        scrollerRect.bottom - Math.max(0, composerDockHeight) - streamStatusHeight - 18;
      if (itemRect.bottom <= visibleBottom) {
        return;
      }
      const delta = Math.ceil(itemRect.bottom - visibleBottom);
      scroller.scrollBy({
        top: delta,
        behavior: 'auto',
      });
    },
    [composerDockHeight, streamStatusHeight],
  );

  const cancelScheduledStreamFollow = useCallback(() => {
    if (streamScrollFrameRef.current == null) {
      return;
    }
    window.cancelAnimationFrame(streamScrollFrameRef.current);
    streamScrollFrameRef.current = null;
  }, []);

  const scheduleActiveAssistantFollow = useCallback(
    (messageId: string, index: number, reason = 'stream') => {
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
        const nearBottom = scroller
          ? isScrollerNearVisualBottom(
              scroller,
              composerDockHeight,
              streamStatusHeight,
            )
          : false;
        if (index >= 0 && !nearBottom && !(item instanceof HTMLElement)) {
          listRef.current?.scrollToIndex({
            index,
            align: 'end',
            behavior: 'auto',
          });
        }
        window.requestAnimationFrame(() => {
          if (
            !autoFollowStreamRef.current ||
            userDetachedFromBottomRef.current ||
            Date.now() < manualScrollDetachUntilRef.current
          ) {
            return;
          }
          ensureMessageBottomVisible(messageId, reason);
        });
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
      window.requestAnimationFrame(() => {
        const currentScrollTop = scroller.scrollTop;
        if (Math.abs(currentScrollTop - lockedScrollTop) < 0.5) {
          return;
        }
        scroller.scrollTop = lockedScrollTop;
      });
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
      source: string,
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
      if (event.deltaY < 0) {
        if (releaseWheelBottomFreeze('react-list', event)) {
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
      if (event.deltaY < 0) {
        if (releaseWheelBottomFreeze('react-scroll-bottom-hotzone', event)) {
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
        if (releaseWheelBottomFreeze('react-chat-body', event)) {
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
      if (releaseWheelBottomFreeze('native-chat-body', event)) {
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
            composerDockHeight,
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
      composerDockHeight,
      lockStreamFollow,
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
      const now = Date.now();
      const recentLock = lastWheelLockRef.current;
      const recentWheel = now - lastWheelEventAtRef.current <= 250;
      const scrollbarDragging =
        scrollbarDragActiveRef.current || now < scrollbarDragUntilRef.current;
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
      lockStreamFollow,
      readBottomMetrics,
      sending,
      setScrollBottomVisible,
      shouldShowScrollBottomForMetrics,
    ],
  );

  useEffect(() => {
    if (loading || showWelcome) {
      setComposerDockHeight(0);
      return undefined;
    }
    const dock = composerDockRef.current;
    if (!dock) {
      return undefined;
    }
    const updateHeight = () => {
      setComposerDockHeight(Math.ceil(dock.getBoundingClientRect().height));
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(dock);
    return () => observer.disconnect();
  }, [loading, showWelcome]);

  useEffect(() => {
    return () => {
      if (streamScrollFrameRef.current != null) {
        window.cancelAnimationFrame(streamScrollFrameRef.current);
      }
      listScrollerWheelCleanupRef.current?.();
      listScrollerWheelCleanupRef.current = null;
      scrollBottomWheelCleanupRef.current?.();
      scrollBottomWheelCleanupRef.current = null;
    };
  }, []);

  useEffect(() => {
    const previous = messageSnapshotRef.current;
    const ids = renderMessages.map((message) => message.id);
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
    const previousIds = new Set(previous.ids);
    const submittedUserIndex = renderMessages.findIndex(
      (message) => message.role === 'user' && !previousIds.has(message.id),
    );
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
    let cancelled = false;
    setActiveScene(null);
    setAvailableScene(null);
    setActiveSceneInitialAutoPlay(false);
    activeSceneKeyRef.current = '';
    activeSceneRevisionRef.current = '';
    if (!activeConversationId.trim()) {
      return () => {
        cancelled = true;
      };
    }
    async function loadLatestStoredScene() {
      const records = await fetchSessionScenes(activeConversationId).catch(() => []);
      if (cancelled || records.length === 0) {
        return;
      }
      let latestRecord = latestSessionSceneRecord(records);
      if (!latestRecord) {
        return;
      }
      if (!hasSceneHtml(latestRecord.raw)) {
        latestRecord =
          (await fetchSessionScene({
            sessionId: activeConversationId,
            sceneId: latestRecord.sceneId,
          }).catch(() => null)) ?? latestRecord;
      }
      if (cancelled) {
        return;
      }
      const latestScene = cardlingSceneFromSessionSceneRecord(
        latestRecord,
        activeConversationId,
      );
      if (!latestScene) {
        return;
      }
      setAvailableScene(latestScene);
    }
    void loadLatestStoredScene();
    return () => {
      cancelled = true;
    };
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
      'stream-update',
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
      composerDockHeight,
      streamStatusHeight,
    );
  }, [composerDockHeight, streamStatusHeight]);

  const scrollToBottom = useCallback(() => {
    if (messages.length === 0) {
      return;
    }
    programmaticScrollUntilRef.current = Date.now() + 1400;
    manualScrollDetachUntilRef.current = 0;
    autoFollowStreamRef.current = true;
    userDetachedFromBottomRef.current = false;
    pendingSubmittedUserFocusRef.current = false;
    atBottomRef.current = true;
    setScrollBottomVisible(false);
    lastWheelLockRef.current = null;
    forceListToVisualBottom();
    window.requestAnimationFrame(() => {
      forceListToVisualBottom();
    });
  }, [forceListToVisualBottom, messages.length, setScrollBottomVisible]);

  const jumpToLatestMessage = useCallback(
    (_reason: string) => {
      programmaticScrollUntilRef.current = Date.now() + 1400;
      manualScrollDetachUntilRef.current = 0;
      autoFollowStreamRef.current = true;
      userDetachedFromBottomRef.current = false;
      pendingSubmittedUserFocusRef.current = false;
      atBottomRef.current = true;
      lastWheelLockRef.current = null;
      setScrollBottomVisible(false);
      listRef.current?.scrollToIndex({
        index: 'LAST',
        align: 'end',
        behavior: 'auto',
      });
      window.requestAnimationFrame(() => {
        forceListToVisualBottom();
        window.requestAnimationFrame(() => {
          forceListToVisualBottom();
        });
      });
    },
    [forceListToVisualBottom, setScrollBottomVisible],
  );

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
        updateChatScrollbarGutter(null);
        return;
      }
      lastScrollTopRef.current = nextScroller.scrollTop;
      updateChatScrollbarGutter(nextScroller);
      const resizeObserver = new ResizeObserver(() => {
        updateChatScrollbarGutter(nextScroller);
      });
      resizeObserver.observe(nextScroller);
      const handleNativeWheel = (event: globalThis.WheelEvent) => {
        if (event.defaultPrevented || wheelAlreadyHandled(event)) {
          return;
        }
        lastWheelEventAtRef.current = Date.now();
        if (releaseWheelBottomFreeze('native-list', event)) {
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
        resizeObserver.disconnect();
        nextScroller.removeEventListener('wheel', handleNativeWheel, {
          capture: true,
        });
      };
    },
    [
      lockNativeWheelDownAtBottom,
      markWheelHandled,
      releaseWheelBottomFreeze,
      updateChatScrollbarGutter,
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
        if (releaseWheelBottomFreeze('native-scroll-bottom-hotzone', event)) {
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
      if (!sending) {
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
    [onSend, sending, setScrollBottomVisible],
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

  const chatBodyStyle = {
    '--composer-dock-height': `${composerDockHeight}px`,
    '--stream-status-height': `${streamStatusHeight}px`,
    '--chat-scrollbar-gutter': `${chatScrollbarGutter}px`,
    '--chat-scrollbar-gutter-half': `${chatScrollbarGutter / 2}px`,
  } as CSSProperties;

  return (
    <div className="chat-panel">
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
        botControlAvailable={botControlAvailable}
        onCreateSessionShareLink={
          botControlAvailable ? onCreateSessionShareLink : undefined
        }
        onRefreshActiveSession={onRefreshActiveSession}
        activeConsole={consoleMode}
        onToggleGit={gitAvailable ? () => toggleConsole('git') : undefined}
        onToggleTerminal={terminalAvailable ? () => toggleConsole('terminal') : undefined}
        onRevealSidebar={onRevealSidebar}
      />
      {notice && (
        <div className="notice-banner" role="status" aria-live="polite">
          <CheckCircle2 size={16} />
          <span>{notice}</span>
          <button type="button" onClick={onClearNotice}>
            <X size={16} />
          </button>
        </div>
      )}
      {error && (
        <div className="error-banner">
          <AlertCircle size={16} />
          <span>{error}</span>
          <button type="button" onClick={onClearError}>
            <X size={16} />
          </button>
        </div>
      )}
      <div
        className="chat-body"
        ref={chatBodyRef}
        style={chatBodyStyle}
        onWheelCapture={handleChatBodyWheelCapture}
      >
        {loading ? (
          <BackendLoading />
        ) : showWelcome ? (
          <WelcomeComposer
            key={activeConversationId || 'new-session'}
            language={language}
            draft={draft}
            onDraftChange={onDraftChange}
            sending={sending}
            queuedMessageCount={queuedMessageCount}
            queuedMessagePreview={queuedMessagePreview}
            queuedMessages={queuedMessages}
            selectedModel={selectedModel}
            availableModels={availableModels}
            selectedRuntimeProfile={selectedRuntimeProfile}
            runtimeProfiles={runtimeProfiles}
            referencePlanMode={referencePlanMode}
            permissionMode={permissionMode}
            onModelChange={onModelChange}
            onRuntimeProfileChange={onRuntimeProfileChange}
            onReferencePlanModeChange={onReferencePlanModeChange}
            onPermissionModeChange={onPermissionModeChange}
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
            onEditQueuedMessage={editQueuedMessage}
            onGuideQueuedMessage={(queuedId) =>
              onGuideQueuedMessage(queuedId, 'append_context')
            }
            onRemoveQueuedMessage={onRemoveQueuedMessage}
            onSend={handleComposerSend}
            onCancel={onCancel}
          />
        ) : (
          <Virtuoso
            key={activeConversationId.trim() || 'new-session'}
            ref={listRef}
            className="message-list"
            style={{ height: '100%' }}
            data={renderMessages}
            components={virtuosoComponents}
            computeItemKey={(_index, message) => message.id}
            followOutput={false}
            initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
            scrollerRef={setListScrollerRef}
            onWheelCapture={handleListWheelCapture}
            onPointerDownCapture={handleListPointerDownCapture}
            onTouchStartCapture={() => markUserDetachedFromBottom('touch')}
            atBottomStateChange={(atBottom) => {
              const now = Date.now();
              const scrollbarDragging =
                scrollbarDragActiveRef.current || now < scrollbarDragUntilRef.current;
              const scroller = listScrollerRef.current;
              const metrics = scroller ? readBottomMetrics(scroller) : null;
              const shouldShow = scroller && metrics
                ? shouldShowScrollBottomForMetrics(scroller, metrics)
                : false;
              const effectiveAtBottom =
                atBottom || Boolean(metrics?.visualNearBottom);
              atBottomRef.current = atBottom;
              if (
                userDetachedFromBottomRef.current &&
                now < manualScrollDetachUntilRef.current &&
                !metrics?.absoluteAtBottom
              ) {
                setScrollBottomVisible(shouldShow);
                return;
              }
              if (scrollbarDragging) {
                setScrollBottomVisible(shouldShow);
                return;
              }
              if (effectiveAtBottom) {
                if (
                  userDetachedFromBottomRef.current &&
                  shouldShow &&
                  (now < manualScrollDetachUntilRef.current ||
                    !metrics?.absoluteAtBottom)
                ) {
                  setScrollBottomVisible(true);
                  return;
                }
                lockStreamFollow('virtuoso-bottom');
                return;
              }
              if (
                autoFollowStreamRef.current ||
                now < programmaticScrollUntilRef.current
              ) {
                setScrollBottomVisible(false);
                return;
              }
              setScrollBottomVisible(userDetachedFromBottomRef.current && shouldShow);
            }}
            onScrollCapture={handleListScrollCapture}
            itemContent={(index, message) => (
              <div
                className={`message-list-item ${index === 0 ? 'first' : ''}`}
                data-message-id={message.id}
                data-message-role={message.role}
              >
                <MessageBubble
                  key={message.id}
                  message={message}
                  language={language}
                  sending={sending}
                  activeTurnId={activeTurnId}
                  activeAssistantMessageId={
                    activeAssistantForRender?.message.id ?? ''
                  }
                  onRegenerate={onRegenerate}
                  onEditUserMessage={onEditUserMessage}
                  onGuideMessage={onGuideMessage}
                  onRevertChangeReport={onRevertChangeReport}
                  onOpenScene={openScene}
                />
              </div>
            )}
          />
        )}
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
          <ArrowDown size={22} />
        </button>
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
        {!showWelcome && !loading && (
          <div className="composer-dock" ref={composerDockRef}>
            <Composer
              key={activeConversationId || 'active-session'}
              language={language}
              draft={draft}
              onDraftChange={onDraftChange}
              sending={sending}
              queuedMessageCount={queuedMessageCount}
              queuedMessagePreview={queuedMessagePreview}
              queuedMessages={queuedMessages}
              selectedModel={selectedModel}
              availableModels={availableModels}
              selectedRuntimeProfile={selectedRuntimeProfile}
              runtimeProfiles={runtimeProfiles}
              referencePlanMode={referencePlanMode}
              permissionMode={permissionMode}
              onModelChange={onModelChange}
              onRuntimeProfileChange={onRuntimeProfileChange}
              onReferencePlanModeChange={onReferencePlanModeChange}
              onPermissionModeChange={onPermissionModeChange}
              onSend={handleComposerSend}
              onCancel={onCancel}
              messages={messages}
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
              onEditQueuedMessage={editQueuedMessage}
              onGuideQueuedMessage={(queuedId) =>
                onGuideQueuedMessage(queuedId, 'append_context')
              }
              onRemoveQueuedMessage={onRemoveQueuedMessage}
            />
          </div>
        )}
      </div>
      {consoleMode &&
        ((consoleMode === 'git' && gitAvailable) ||
          (consoleMode === 'terminal' && terminalAvailable)) && (
        <ConsoleDock
          mode={consoleMode}
          language={language}
          activeProjectDir={activeProjectDir}
          onClose={() => setConsoleMode(null)}
        />
      )}
      {pendingInteraction && (
        <InteractionDialog
          language={language}
          interaction={pendingInteraction}
          onReply={onReplyInteraction}
          onCancel={onCancelInteraction}
        />
      )}
    </div>
  );
}

function BackendLoading() {
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
      <p>正在连接后端服务...</p>
    </div>
  );
}

function WelcomeComposer({
  language,
  draft,
  onDraftChange,
  sending,
  queuedMessageCount,
  queuedMessagePreview,
  queuedMessages,
  selectedModel,
  availableModels,
  selectedRuntimeProfile,
  runtimeProfiles,
  referencePlanMode,
  permissionMode,
  activeProjectDir,
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
  onRuntimeProfileChange,
  onReferencePlanModeChange,
  onPermissionModeChange,
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
  draft: string;
  onDraftChange: (value: string) => void;
  sending: boolean;
  queuedMessageCount: number;
  queuedMessagePreview: string;
  queuedMessages: QueuedChatMessage[];
  selectedModel: string;
  availableModels: string[];
  selectedRuntimeProfile: string;
  runtimeProfiles: RuntimeProfileSummary[];
  referencePlanMode: ReferencePlanMode;
  permissionMode: PermissionMode;
  activeProjectDir?: string;
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
  onRuntimeProfileChange: (value: string) => void;
  onReferencePlanModeChange: (value: ReferencePlanMode) => void;
  onPermissionModeChange: (value: PermissionMode) => void;
  onConfigureModels: () => void;
  onCreateConversation?: () => void;
  onSaveProjectContext: (value: string) => Promise<string>;
  onEditQueuedMessage: (item: QueuedChatMessage) => void;
  onGuideQueuedMessage: (queuedId: string) => Promise<void>;
  onRemoveQueuedMessage: (queuedId: string) => void;
  onSend: (text: string) => Promise<void>;
  onCancel: () => Promise<void>;
}) {
  return (
    <div className="welcome-composer">
      <h2>{language === 'zh' ? '要在 cardbush 中构建什么？' : 'What do you want to build in cardbush?'}</h2>
      <Composer
        compact
        language={language}
        draft={draft}
        onDraftChange={onDraftChange}
        sending={sending}
        queuedMessageCount={queuedMessageCount}
        queuedMessagePreview={queuedMessagePreview}
        queuedMessages={queuedMessages}
        selectedModel={selectedModel}
        availableModels={availableModels}
        selectedRuntimeProfile={selectedRuntimeProfile}
        runtimeProfiles={runtimeProfiles}
        referencePlanMode={referencePlanMode}
        permissionMode={permissionMode}
        onModelChange={onModelChange}
        onRuntimeProfileChange={onRuntimeProfileChange}
        onReferencePlanModeChange={onReferencePlanModeChange}
        onPermissionModeChange={onPermissionModeChange}
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
      <div className="prompt-starters">
        <PromptStarter
          icon={<Monitor size={14} />}
          text={language === 'zh' ? '帮我控制浏览器打开一个网页，检查页面内容并总结结果' : 'Control the browser to open a page, inspect it, and summarize the result'}
          onClick={onDraftChange}
        />
        <PromptStarter
          icon={<GitBranch size={14} />}
          text={language === 'zh' ? '和我讨论这个项目的设计，帮我拆解模块和下一步实现计划' : 'Discuss this project design with me and break down modules and next steps'}
          onClick={onDraftChange}
        />
        <PromptStarter
          icon={<Puzzle size={14} />}
          text={language === 'zh' ? '告诉我如何使用 skill，并帮我选择适合当前任务的技能' : 'Show me how to use skills and choose the right one for this task'}
          onClick={onDraftChange}
        />
      </div>
    </div>
  );
}

function PromptStarter({
  icon,
  text,
  onClick,
}: {
  icon: React.ReactNode;
  text: string;
  onClick: (value: string) => void;
}) {
  return (
    <button className="prompt-starter" type="button" onClick={() => onClick(text)}>
      {icon}
      <span>{text}</span>
    </button>
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

function TopBar({
  title,
  sidebarCollapsed,
  botShareLabel,
  language,
  activeConversationId,
  botControlAvailable,
  onCreateSessionShareLink,
  onRefreshActiveSession,
  activeConsole,
  onToggleGit,
  onToggleTerminal,
  onRevealSidebar,
}: {
  title: string;
  sidebarCollapsed: boolean;
  botShareLabel: string;
  language: AppLanguage;
  activeConversationId?: string;
  botControlAvailable: boolean;
  onCreateSessionShareLink?: (
    request: SessionShareLinkRequest,
  ) => Promise<SessionShareLinkResult>;
  onRefreshActiveSession?: RefreshActiveSession;
  activeConsole?: ConsoleMode | null;
  onToggleGit?: () => void;
  onToggleTerminal?: () => void;
  onRevealSidebar: () => void;
}) {
  const [botMenuOpen, setBotMenuOpen] = useState(false);
  const [botHistoryRefreshing, setBotHistoryRefreshing] = useState(false);
  const [botHistoryRefreshFailed, setBotHistoryRefreshFailed] = useState(false);
  const botShareRef = useRef<HTMLDivElement>(null);
  const botShareEnabled = Boolean(
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
    setBotHistoryRefreshFailed(false);
    try {
      await onRefreshActiveSession({ silent: true });
    } catch {
      setBotHistoryRefreshFailed(true);
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
              : !botControlAvailable
                ? language === 'zh'
                  ? 'BushServer 尚未提供 Bot API'
                  : 'BushServer does not expose Bot APIs yet'
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
      <button
        className={`topbar-square native-refresh-square ${botHistoryRefreshFailed ? 'failed' : ''}`}
        type="button"
        disabled={!onRefreshActiveSession || botHistoryRefreshing}
        onClick={() => void refreshBotHistory()}
        title={
          botHistoryRefreshFailed
            ? language === 'zh'
              ? '刷新后端内容失败'
              : 'Failed to refresh backend content'
            : language === 'zh'
              ? '重新连接后端并刷新会话'
              : 'Reconnect backend and refresh sessions'
        }
      >
        {botHistoryRefreshing ? <LoaderCircle size={16} /> : <RefreshCw size={16} />}
      </button>
      {onToggleGit && (
        <button
          className={`topbar-square ${activeConsole === 'git' ? 'active' : ''}`}
          type="button"
          onClick={onToggleGit}
          title="Git 控制台"
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
          title="终端控制台"
        >
          <Terminal size={16} />
        </button>
      )}
    </div>
  );
}

function asRecord(value: unknown) {
  return value != null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function displayableRuntimeLastError(value: unknown) {
  const text = String(value ?? '').trim();
  if (!text) {
    return '';
  }
  if (
    /Client error '404 Not Found'/i.test(text) &&
    /\/v1\/turns\/[^/\s]+\/stop/i.test(text)
  ) {
    return '';
  }
  return text;
}

function optionalDisplayText(value: unknown) {
  return String(value ?? '').trim();
}

function formatDuration(durationMs: number) {
  if (durationMs <= 0) {
    return '';
  }
  if (durationMs >= 1000) {
    return `${(durationMs / 1000).toFixed(1)}s`;
  }
  return `${Math.round(durationMs)}ms`;
}

function InteractionDialog({
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
    (permission
      ? language === 'zh'
        ? '需要授权'
        : 'Permission required'
      : language === 'zh'
        ? '需要你的选择'
        : 'Input needed');
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

  return (
    <div className="modal-backdrop interaction-dialog-backdrop">
      <form className="interaction-dialog" onSubmit={(event) => void submit(event)}>
        <header>
          {permission ? <AlertCircle size={18} /> : <MessageSquare size={18} />}
          <strong>{title}</strong>
          <button type="button" onClick={() => void cancel()} disabled={busy}>
            <X size={16} />
          </button>
        </header>
        <div className="interaction-dialog-body">
          {message && <p>{message}</p>}
          {permission ? (
            <PermissionInteractionPanel
              language={language}
              interaction={interaction}
              busy={busy}
              onChoose={(optionId) => void submitPermission(optionId)}
            />
          ) : structured ? (
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
        {!permission && (
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
        )}
      </form>
    </div>
  );
}

type InteractionAnswerDraft = {
  selectedOptionId?: string;
  selectedOptionIds: string[];
  inputText: string;
};

function PermissionInteractionPanel({
  language,
  interaction,
  busy,
  onChoose,
}: {
  language: AppLanguage;
  interaction: PendingInteraction;
  busy: boolean;
  onChoose: (optionId: string) => void;
}) {
  const question = permissionQuestion(interaction.questions ?? []);
  const preview = interaction.permissionPreview ?? {};
  const toolName = String(preview.tool_name ?? preview.toolName ?? interaction.toolName ?? '');
  const parameters = Array.isArray(preview.parameters) ? preview.parameters.map(asRecord) : [];
  const options = question?.options ?? [];
  return (
    <div className="permission-request-panel">
      <div className="permission-preview">
        {toolName && (
          <div className="permission-preview-row">
            <span>{language === 'zh' ? '工具' : 'Tool'}</span>
            <code>{toolName}</code>
          </div>
        )}
        {parameters.map((parameter, index) => {
          const name = String(parameter.name ?? parameter.key ?? '');
          const previewText = String(parameter.preview ?? parameter.value ?? '');
          return (
            <div
              // eslint-disable-next-line react/no-array-index-key
              key={`${name}-${index}`}
              className="permission-preview-row"
            >
              <span>{name || (language === 'zh' ? '参数' : 'Parameter')}</span>
              <code>{previewText}</code>
            </div>
          );
        })}
      </div>
      <div className="permission-actions">
        {options.map((option) => (
          <button
            key={option.id}
            className={`permission-action ${permissionOptionClass(option.id)}`}
            type="button"
            disabled={busy}
            onClick={() => onChoose(option.id)}
          >
            {busy ? <LoaderCircle size={14} /> : permissionOptionIcon(option.id)}
            <span>{option.label}</span>
            {option.description && <small>{option.description}</small>}
          </button>
        ))}
      </div>
    </div>
  );
}

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
    question.selectionMode === 'input' ||
    (question.selectionMode === 'single' && question.options.length > 0);

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

function isPermissionInteraction(interaction: PendingInteraction) {
  const type = interaction.type?.trim().toLowerCase() ?? '';
  const tool = interaction.toolName?.trim().toLowerCase() ?? '';
  return (
    type.includes('permission') ||
    tool.includes('permission') ||
    interaction.permissionPreview != null
  );
}

function permissionQuestion(questions: InteractionQuestion[]) {
  return (
    questions.find((question) => question.id === 'permission') ??
    questions.find((question) => question.options.some((option) => option.id.includes('allow'))) ??
    questions[0]
  );
}

function permissionOptionClass(optionId: string) {
  const normalized = optionId.toLowerCase();
  if (normalized.includes('deny')) {
    return 'deny';
  }
  if (normalized.includes('session')) {
    return 'session';
  }
  return 'allow';
}

function permissionOptionIcon(optionId: string) {
  return optionId.toLowerCase().includes('deny') ? (
    <X size={14} />
  ) : (
    <Check size={14} />
  );
}

function FeaturePanel({
  language,
  section,
  sidebarCollapsed,
  onRevealSidebar,
  conversations,
  skills,
  disabledSkillNames,
  onToggleSkill,
  onReloadSkills,
  onLoadSkillDetail,
  onCreateConversation,
  onOpenConversation,
}: {
  language: AppLanguage;
  section: AppSection;
  sidebarCollapsed: boolean;
  onRevealSidebar: () => void;
  conversations: ConversationSummary[];
  skills: SkillSummary[];
  disabledSkillNames: Set<string>;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  onReloadSkills: () => Promise<SkillSummary[]>;
  onLoadSkillDetail: (skillName: string) => Promise<SkillDetail>;
  onCreateConversation: () => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  const label = sectionLabels[section][language];
  return (
    <div className="feature-panel">
      <TopBar
        title={label}
        sidebarCollapsed={sidebarCollapsed}
        botShareLabel={language === 'zh' ? '继续到 Bot' : 'Continue to Bot'}
        language={language}
        botControlAvailable={false}
        activeConsole={null}
        onRevealSidebar={onRevealSidebar}
      />
      <FeatureContentPanel
        language={language}
        section={section}
        conversations={conversations}
        skills={skills}
        disabledSkillNames={disabledSkillNames}
        onToggleSkill={onToggleSkill}
        onReloadSkills={onReloadSkills}
        onLoadSkillDetail={onLoadSkillDetail}
        onCreateConversation={onCreateConversation}
        onOpenConversation={onOpenConversation}
      />
    </div>
  );
}
