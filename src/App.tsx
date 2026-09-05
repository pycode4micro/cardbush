import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Clipboard,
  ExternalLink,
  FileText,
  Flag,
  Folder,
  Globe2,
  LoaderCircle,
  Menu,
  PanelRightClose,
  Plus,
  Plug,
  Puzzle,
  RefreshCw,
  X,
} from 'lucide-react';
import {
  Component,
  type CSSProperties,
  type ErrorInfo,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  defaultBackendCapabilities,
  fetchBackendCapabilities,
  fetchBackendReadiness,
  fetchModelConfigs,
  fetchProjectContext,
  fetchSkills,
  isRuntimeWorkspaceSnapshotUnavailableError,
  revertSessionWorkspaceChanges,
  saveModelConfigs,
  saveProjectContext,
} from './backend/api';
import { useCardbushChat } from './hooks/useCardbushChat';
import {
  normalizeChatMessagesForDisplay,
} from './features/chatMessages/transcript/messageProjection';
import { useSoftPanelPresence } from './hooks/useSoftPanelPresence';
import { useInspectorTabStrip } from './hooks/useInspectorTabStrip';
import { createPortal } from 'react-dom';
import { SidebarResizer } from './components/SidebarResizer';
import { RightInspectorResizer } from './components/RightInspectorResizer';
import { inspectorMaximum } from './components/rightInspectorSizing';
import { sectionLabels } from './features/appSections';
import { WorkSummaryInspector } from './features/chat/WorkSummaryInspector';
import {
  changeRootForConversation,
  conversationProjectDir as conversationProjectRoot,
  conversationWorkspaceRoot,
  isOnlyTalkConversation,
} from './features/conversationWorkspace';
import {
  conversationMatchesScope,
  conversationProjectId,
  conversationProjectPathAliases,
  firstConversationInScope,
  type ConversationScope,
} from './features/conversationScope';
import {
  ChatSidebar,
  ConversationChangeDialog,
  TeamSidebar,
  type ProjectAction,
} from './features/sidebar';
import { loadTeamWorkspace, useTeamWorkspaceState } from './features/team/teamWorkspaceStore';
import { COPY_FEEDBACK_EVENT } from './features/messageFeedback';
import { basename, fileUrl, samePath, stripWrappingQuotes } from './shared/localPaths';
import {
  themeAccentColor,
  themeBackgroundColor,
  themeClassNames,
} from './features/appearance/themeRuntime';
import {
  importedThemeBaseMode,
  importedThemeStyleVariables,
  normalizeImportedThemeStyle,
} from './features/appearance/importedThemeStyle';
import {
  changeReportsFromMessages,
  serializeToolChangeReport,
  type ConversationChangeReport,
} from './features/tools';
import { ShadowCloneIcon } from './components/ShadowCloneIcon';
import { ShadowWindow, type ShadowConversationContext } from './ShadowWindow';
import {
  OPEN_INSPECTOR_EVENT,
  type InspectorOpenDetail,
} from './features/inspector/inspectorEvents';
import {
  OPEN_WORK_SUMMARY_INSPECTOR_EVENT,
  type WorkSummaryInspectorDetail,
} from './features/subagents/subagentObservabilityEvents';
import {
  type AppLanguage,
  type AppLanguageMode,
  type AppSection,
  type AppSettingsState,
  type BackendCapabilities,
  type ChatMessage,
  type CompanionMotionMode,
  type CompanionSettings,
  type CompanionSize,
  type ConversationSummary,
  type ManagedModelConfig,
  type RuntimeAssetCategory,
  type RuntimeStartupStatus,
  type ImportedThemeStyle,
  type ProjectItem,
  type SettingsSection,
  type SkillSummary,
  type SkillDetail,
  type TerminalRuntime,
  type ThemePreference,
  type ThemeMode,
  SUBAGENT_DISPATCH_EVENT_PROTOCOL,
} from './types';
import {
  installUiLongTaskObserver,
  setUiPerformanceActiveSession,
} from './shared/uiPerformanceTrace';
import { cssEscape } from './shared/cssEscape';
import { ChatPanel } from './features/chat/ChatPanel';
import { TopBar } from './components/TopBar';
import {
  inspectorTargetIdentity,
  isInspectorBrowserTarget,
  inspectorTabLabel,
  inspectorSource,
} from './features/inspector/inspectorTargets';
import {
  type InspectorNavigationState,
  type InspectorWebviewHandle,
  InspectorWebview,
} from './features/inspector/InspectorWebview';

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
    void window.cardbushDesktop?.writeDebugLog('renderer-lifecycle', {
      stage: 'react-error-boundary',
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      componentStack: info.componentStack,
    }).catch(() => undefined);
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

type InspectorResourceTab = {
  id: string;
  kind: 'resource';
  detail: InspectorOpenDetail;
};

type InspectorReviewTab = {
  id: string;
  kind: 'review';
  conversationId: string;
  initialFilePath: string;
  title: string;
};

type InspectorShadowTab = {
  id: string;
  kind: 'shadow';
  context: ShadowConversationContext;
  title: string;
};

type InspectorTab = InspectorResourceTab | InspectorReviewTab | InspectorShadowTab;

type InspectorTabContextMenuState = {
  tabId: string;
  x: number;
  y: number;
};

const defaultSidebarWidth = 272;
const minSidebarWidth = 220;
const maxSidebarWidth = 420;
const recentProjectStorageKey = 'cardbush_recent_project_dir';
const onlyTalkModeStorageKey = 'cardbush_only_talk_mode';
const importedThemeStyleStorageKey = 'cardbush_imported_theme_style';

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
  thinking: {
    visible: false,
  },
  guidance: {
    deliveryMode: 'queue',
  },
  terminal: {
    runtime: 'powershell',
  },
  managedModelConfigs: [],
  importedThemeStyle: null,
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

export function App() {
  return (
    <AppErrorBoundary>
      <CardbushApp />
    </AppErrorBoundary>
  );
}

function CardbushApp() {
  const [runtimeStartup, setRuntimeStartup] = useState<RuntimeStartupStatus>(() =>
    window.cardbushDesktop?.runtimeStartupStatus
      ? { phase: 'initializing', attempt: 0, startedAt: new Date().toISOString() }
      : { phase: 'ready', attempt: 0, startedAt: new Date().toISOString() },
  );
  const [themePreference, setThemePreferenceState] =
    useState<ThemePreference>(() => readInitialThemePreference());
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
  const [settingsPluginTab, setSettingsPluginTab] = useState<'plugins' | 'skills'>('plugins');
  const [projectItems, setProjectItems] = useState<ProjectItem[]>(readProjectItems);
  const [projectRenameTarget, setProjectRenameTarget] = useState<ProjectItem | null>(null);
  const [recentProjectDir, setRecentProjectDir] = useState(
    () => window.localStorage.getItem(recentProjectStorageKey)?.trim() ?? '',
  );
  const [onlyTalkMode, setOnlyTalkMode] = useState(
    () => window.localStorage.getItem(onlyTalkModeStorageKey) === 'true',
  );
  const [wallpaperAccent, setWallpaperAccent] = useState<WallpaperAccent | null>(null);
  const [draftsByConversation, setDraftsByConversation] = useState<Record<string, string>>({});
  const [projectContexts, setProjectContexts] = useState<Record<string, string>>(
    readProjectContexts,
  );
  const [disabledSkillNames, setDisabledSkillNames] = useState<Set<string>>(
    readDisabledSkillNames,
  );
  const [visualInputEnabledSetting, setVisualInputEnabledSetting] = useState(
    readVisualInputEnabled,
  );

  useEffect(() => {
    const desktop = window.cardbushDesktop;
    if (!desktop?.runtimeStartupStatus || !desktop.onRuntimeStartupStatus) return undefined;
    let disposed = false;
    const apply = (status: RuntimeStartupStatus) => {
      if (!disposed) setRuntimeStartup(status);
    };
    const unsubscribe = desktop.onRuntimeStartupStatus(apply);
    void desktop.runtimeStartupStatus().then(apply).catch((error) => apply({
      phase: 'error',
      attempt: 0,
      startedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    }));
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

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
  const [backendCapabilities, setBackendCapabilities] =
    useState<BackendCapabilities>(defaultBackendCapabilities);
  const [modelConfigSyncReady, setModelConfigSyncReady] = useState(false);
  const [backendDefaultModelName, setBackendDefaultModelName] = useState('');
  const lastSavedModelConfigSignatureRef = useRef('');
  const projectItemsRef = useRef(projectItems);
  const theme = resolveTheme(
    themePreference,
    systemDark,
    appSettings.importedThemeStyle,
  );
  const language = resolveAppLanguage(languageMode, systemLanguage);
  const importedThemeVariables = useMemo(
    () => themePreference === 'custom'
      ? importedThemeStyleVariables(appSettings.importedThemeStyle)
      : {},
    [appSettings.importedThemeStyle, themePreference],
  );
  const shadowAccentColor =
    importedThemeVariables['--accent'] ?? themeAccentColor(theme);

  const applyThemeBackground = useCallback(() => {
    applyDocumentBackdrop(theme);
  }, [theme]);

  useEffect(() => {
    applyThemeBackground();
    void window.cardbushDesktop?.setWindowTheme?.(theme).catch(() => undefined);
  }, [applyThemeBackground, theme]);

  useEffect(() => {
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  }, [language]);

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
          const remoteModels = normalizeManagedModelConfigs(remote.models);
          const legacyModels = normalizeManagedModelConfigs(readManagedModelConfigs());
          const migrated = mergeLegacyModelCredentials(remoteModels, legacyModels);
          const snapshot = migrated.changed
            ? await saveModelConfigs({
                defaultModelId: remote.defaultModelId,
                models: migrated.models,
              })
            : remote;
          if (cancelled) {
            return;
          }
          const normalized = normalizeManagedModelConfigs(snapshot.models);
          const defaultConfig =
            normalized.find((item) => item.id === snapshot.defaultModelId) ??
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
  const visualInputAvailable = backendCapabilities.standardImageInputTool;
  const visualInputEnabled = visualInputAvailable && visualInputEnabledSetting;
  const browserPrivacyModeEnabled =
    backendCapabilities.browserPrivacyMode && appSettings.browser.privacyMode;
  const reasoningTraceVisible =
    backendCapabilities.reasoningStream && appSettings.thinking.visible;
  const fallbackProject = useMemo(() => {
    const available = projectItems.filter((project) => !project.archived && !project.missing);
    return (
      available.find((project) => samePath(project.rootPath, recentProjectDir)) ??
      available[0]
    );
  }, [projectItems, recentProjectDir]);
  const fallbackProjectDir = fallbackProject?.rootPath.trim() ?? '';
  const fallbackProjectId = fallbackProject?.id.trim() ?? '';
  const teamWorkspace = useTeamWorkspaceState();
  useEffect(() => {
    void loadTeamWorkspace().catch(() => undefined);
  }, []);
  const chat = useCardbushChat(appSettings.managedModelConfigs, availableModels, {
    runtimeReady: runtimeStartup.phase === 'ready',
    language,
    projectContexts,
    disabledSkillNames,
    standardImageInputEnabled: visualInputEnabled,
    browserPrivacyMode: browserPrivacyModeEnabled,
    selectedTeamId: teamWorkspace.selectedTeamId,
    selectedTeamName: teamWorkspace.teams.find((team) => team.id === teamWorkspace.selectedTeamId)?.name,
    terminalRuntime: appSettings.terminal.runtime,
    reasoningTraceVisible,
    interactiveRequestsAvailable: backendCapabilities.interactiveRequests,
    reasoningLevelSelection: backendCapabilities.reasoningLevelSelection,
    reasoningLevels: backendCapabilities.reasoningLevels,
    defaultReasoningLevel: backendCapabilities.defaultReasoningLevel,
    contextWindowUsageAvailable: backendCapabilities.contextWindowUsage,
    workspaceChangesAvailable: backendCapabilities.workspaceChanges,
    defaultProjectId: onlyTalkMode ? '' : fallbackProjectId,
    defaultProjectDir: onlyTalkMode ? '' : fallbackProjectDir,
  });
  useEffect(() => installUiLongTaskObserver(), []);
  useEffect(() => {
    setUiPerformanceActiveSession(chat.activeConversationId);
  }, [chat.activeConversationId]);
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
    if (readiness.ready !== true) {
      throw new Error(
        language === 'zh'
          ? 'CardBush Runtime 尚未就绪，请完成重启后再验证。'
          : 'CardBush Runtime is not ready. Finish restarting it before verification.',
      );
    }
    const [capabilities] = await Promise.all([
      fetchBackendCapabilities(),
      fetchSkills(),
    ]);
    setBackendCapabilities(capabilities);
    if (categories.includes('skills')) {
      const next = new Set<string>();
      setDisabledSkillNames(next);
      persistDisabledSkillNames(next);
    }
    if (categories.includes('agent_profiles') || categories.includes('teams')) {
      await loadTeamWorkspace(true);
    }
  }, [language]);
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
    (!onlyTalkMode && !chat.activeConversation
      ? fallbackProjectDir || undefined
      : undefined);
  const activeProjectPathAliases = useMemo(
    () => conversationProjectPathAliases(chat.activeConversation),
    [chat.activeConversation],
  );

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
  const [revertingChangeId, setRevertingChangeId] = useState('');
  const [changeReviewNotice, setChangeReviewNotice] = useState('');
  const [revertedChangeKeys, setRevertedChangeKeys] = useState<Set<string>>(
    () => new Set(),
  );
  const [inspectorTabs, setInspectorTabs] = useState<InspectorTab[]>([]);
  const [activeInspectorTabId, setActiveInspectorTabId] = useState('');
  const [inspectorAddMenuOpen, setInspectorAddMenuOpen] = useState(false);
  const [inspectorTabsMenuOpen, setInspectorTabsMenuOpen] = useState(false);
  const [inspectorTabContextMenu, setInspectorTabContextMenu] =
    useState<InspectorTabContextMenuState | null>(null);
  const inspectorAddMenuRef = useRef<HTMLDivElement | null>(null);
  const inspectorTabsMenuRef = useRef<HTMLDivElement | null>(null);
  const inspectorTabContextMenuRef = useRef<HTMLDivElement | null>(null);
  const inspectorWebviewRefs = useRef(new Map<string, InspectorWebviewHandle>());
  const [inspectorNavigationByTarget, setInspectorNavigationByTarget] = useState<
    Record<string, InspectorNavigationState>
  >({});
  const [workSummaryInspector, setWorkSummaryInspector] =
    useState<WorkSummaryInspectorDetail | null>(null);
  const activeInspectorTab = inspectorTabs.find(
    (tab) => tab.id === activeInspectorTabId,
  ) ?? null;
  const inspectorTabContextTarget = inspectorTabContextMenu
    ? inspectorTabs.find((tab) => tab.id === inspectorTabContextMenu.tabId) ?? null
    : null;
  const inspectorTabContextTargetIndex = inspectorTabContextTarget
    ? inspectorTabs.findIndex((tab) => tab.id === inspectorTabContextTarget.id)
    : -1;
  const inspectorTarget = activeInspectorTab?.kind === 'resource'
    ? activeInspectorTab.detail
    : null;
  const changeReviewConversationId = activeInspectorTab?.kind === 'review'
    ? activeInspectorTab.conversationId
    : '';
  const [inspectorWidth, setInspectorWidthState] = useState(() => {
    const stored = Number.parseFloat(window.localStorage.getItem('cardbush.inspector_width') ?? '');
    return Number.isFinite(stored) ? Math.min(900, Math.max(380, stored)) : 620;
  });
  const inspectorWidthRef = useRef(inspectorWidth);
  const setInspectorWidth = useCallback((width: number) => {
    const next = Math.min(
      inspectorMaximum(windowMaximized, window.innerWidth),
      Math.max(380, Math.round(width)),
    );
    inspectorWidthRef.current = next;
    setInspectorWidthState(next);
    window.localStorage.setItem('cardbush.inspector_width', String(next));
  }, [windowMaximized]);
  const openInspectorTarget = useCallback((detail: InspectorOpenDetail) => {
    const target = stripWrappingQuotes(detail.target.trim());
    if (!target) return;
    const normalizedDetail: InspectorOpenDetail = {
      target,
      ...(detail.title?.trim() ? { title: detail.title.trim() } : {}),
    };
    const identity = `resource:${inspectorTargetIdentity(target)}`;
    const nextTab: InspectorResourceTab = {
      id: identity,
      kind: 'resource',
      detail: normalizedDetail,
    };
    setInspectorTabs((current) => {
      const existingIndex = current.findIndex((tab) => tab.id === identity);
      if (existingIndex < 0) return [...current, nextTab];
      const existing = current[existingIndex];
      if (existing.kind !== 'resource') return current;
      const nextDetail: InspectorOpenDetail = {
        ...existing.detail,
        ...normalizedDetail,
        title: normalizedDetail.title || existing.detail.title,
      };
      if (
        existing.detail.target === nextDetail.target &&
        existing.detail.title === nextDetail.title
      ) {
        return current;
      }
      const next = [...current];
      next[existingIndex] = { ...existing, detail: nextDetail };
      return next;
    });
    setActiveInspectorTabId(identity);
    setWorkSummaryInspector(null);
    setInspectorAddMenuOpen(false);
  }, []);
  const openChangeReviewInspector = useCallback((
    conversationId: string,
    initialFilePath = '',
  ) => {
    const normalizedConversationId = conversationId.trim();
    if (!normalizedConversationId) return;
    const id = `review:${normalizedConversationId}`;
    const nextTab: InspectorReviewTab = {
      id,
      kind: 'review',
      conversationId: normalizedConversationId,
      initialFilePath: initialFilePath.trim(),
      title: language === 'zh' ? '审查' : 'Review',
    };
    setInspectorTabs((current) => {
      const existingIndex = current.findIndex((tab) => tab.id === id);
      if (existingIndex < 0) return [...current, nextTab];
      const next = [...current];
      next[existingIndex] = nextTab;
      return next;
    });
    setActiveInspectorTabId(id);
    setWorkSummaryInspector(null);
    setChangeReviewNotice('');
    setInspectorAddMenuOpen(false);
  }, [language]);
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
  const [sidebarChangeReportsByConversation, setSidebarChangeReportsByConversation] =
    useState<Record<string, ConversationChangeReport[]>>({});
  const sidebarChangeReportSourcesRef = useRef(new Map<string, ChatMessage[]>());
  const sidebarChangeReportFingerprintsRef = useRef(new Map<string, string>());
  useEffect(() => {
    const sources = sidebarChangeReportSourcesRef.current;
    const fingerprints = sidebarChangeReportFingerprintsRef.current;
    const availableConversationIds = new Set(Object.keys(chat.messagesByConversation));
    const updates = new Map<string, ConversationChangeReport[] | null>();

    for (const conversationId of sources.keys()) {
      if (availableConversationIds.has(conversationId)) continue;
      sources.delete(conversationId);
      fingerprints.delete(conversationId);
      updates.set(conversationId, null);
    }
    for (const [conversationId, messages] of Object.entries(chat.messagesByConversation)) {
      // While a Turn is running, message/tool facts may update frequently. The
      // sidebar owns only the submit -> done lifecycle and keeps its last
      // completed report snapshot until that lifecycle reaches done.
      if (chat.processingConversationIds.has(conversationId)) continue;
      if (sources.get(conversationId) === messages) continue;
      sources.set(conversationId, messages);
      const reports = changeReportsFromMessages(
        normalizeChatMessagesForDisplay(messages),
      );
      const fingerprint = JSON.stringify(reports);
      if (fingerprints.get(conversationId) === fingerprint) continue;
      fingerprints.set(conversationId, fingerprint);
      updates.set(conversationId, reports.length > 0 ? reports : null);
    }
    if (updates.size === 0) return;
    setSidebarChangeReportsByConversation((current) => {
      const next = { ...current };
      let changed = false;
      for (const [conversationId, reports] of updates) {
        if (reports) {
          next[conversationId] = reports;
          changed = true;
        } else if (conversationId in next) {
          delete next[conversationId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [chat.messagesByConversation, chat.processingConversationIds]);
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
  const inspectorOpen = Boolean(activeInspectorTab || workSummaryInspector);
  const closeInspector = useCallback(() => {
    setActiveInspectorTabId('');
    setWorkSummaryInspector(null);
    setChangeReviewNotice('');
    setInspectorAddMenuOpen(false);
    setInspectorTabsMenuOpen(false);
    setInspectorTabContextMenu(null);
  }, []);
  const [retainedInspectorContent, setRetainedInspectorContent] = useState<{
    tab: InspectorTab | null;
    workSummary: WorkSummaryInspectorDetail | null;
    conversation: ConversationSummary | null;
    reports: ConversationChangeReport[];
  }>({ tab: null, workSummary: null, conversation: null, reports: [] });
  useEffect(() => {
    if (!inspectorOpen) return;
    setRetainedInspectorContent({
      tab: activeInspectorTab,
      workSummary: workSummaryInspector,
      conversation: changeReviewConversation,
      reports: changeReviewReports,
    });
  }, [
    activeInspectorTab,
    changeReviewConversation,
    changeReviewReports,
    inspectorOpen,
    workSummaryInspector,
  ]);
  const displayedInspectorTab = activeInspectorTab ?? (
    workSummaryInspector ? null : retainedInspectorContent.tab
  );
  const displayedInspectorTarget = displayedInspectorTab?.kind === 'resource'
    ? displayedInspectorTab.detail
    : null;
  const displayedReviewConversation = changeReviewConversation ?? (
    activeInspectorTab || workSummaryInspector
      ? null
      : retainedInspectorContent.conversation
  );
  const displayedReviewReports = changeReviewConversation
    ? changeReviewReports
    : retainedInspectorContent.reports;
  const displayedWorkSummaryInspector = workSummaryInspector ?? (
    activeInspectorTab
      ? null
      : retainedInspectorContent.workSummary
  );
  const displayedInspectorTabs = displayedInspectorTab
    ? inspectorTabs.length > 0
      ? inspectorTabs
      : [displayedInspectorTab]
    : [];
  const activeInspectorTabIdentity = displayedInspectorTab?.id ?? '';
  const {
    ref: inspectorTabsRef,
    state: inspectorTabScrollState,
    scroll: scrollInspectorTabs,
  } = useInspectorTabStrip(activeInspectorTabIdentity, displayedInspectorTabs.length);
  const activateInspectorTab = (tab: InspectorTab) => {
    setActiveInspectorTabId(tab.id);
    setWorkSummaryInspector(null);
    setInspectorAddMenuOpen(false);
    setInspectorTabsMenuOpen(false);
    setInspectorTabContextMenu(null);
  };
  const closeInspectorTabs = (closingIdentities: Set<string>) => {
    const closingTabs = inspectorTabs.filter((tab) => closingIdentities.has(tab.id));
    if (closingTabs.length === 0) return;
    const activeClosingIndex = inspectorTabs.findIndex(
      (tab) => tab.id === activeInspectorTabIdentity,
    );
    const remaining = inspectorTabs.filter((tab) => !closingIdentities.has(tab.id));
    setInspectorTabs(remaining);
    for (const closingTab of closingTabs) {
      inspectorWebviewRefs.current.delete(closingTab.id);
    }
    setInspectorNavigationByTarget((current) => {
      const next = { ...current };
      let changed = false;
      for (const closingTab of closingTabs) {
        if (!(closingTab.id in next)) continue;
        delete next[closingTab.id];
        changed = true;
      }
      return changed ? next : current;
    });
    if (closingIdentities.has(activeInspectorTabIdentity)) {
      setActiveInspectorTabId(
        remaining[Math.min(Math.max(activeClosingIndex, 0), remaining.length - 1)]?.id ?? '',
      );
    }
    if (closingTabs.some((tab) => tab.kind === 'review')) setChangeReviewNotice('');
    setInspectorAddMenuOpen(false);
    setInspectorTabsMenuOpen(false);
    setInspectorTabContextMenu(null);
  };
  const closeInspectorTab = (closingIdentity: string) => {
    closeInspectorTabs(new Set([closingIdentity]));
  };
  const closeOtherInspectorTabs = (identity: string) => {
    closeInspectorTabs(new Set(inspectorTabs
      .filter((tab) => tab.id !== identity)
      .map((tab) => tab.id)));
    setActiveInspectorTabId(identity);
  };
  const closeInspectorTabsToRight = (identity: string) => {
    const index = inspectorTabs.findIndex((tab) => tab.id === identity);
    if (index < 0) return;
    closeInspectorTabs(new Set(inspectorTabs.slice(index + 1).map((tab) => tab.id)));
  };
  const openInspectorTabContextMenu = (
    event: ReactMouseEvent<HTMLDivElement>,
    tabId: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const width = 188;
    const height = 164;
    setInspectorTabContextMenu({
      tabId,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - width - 8)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - height - 8)),
    });
    setInspectorTabsMenuOpen(false);
    setInspectorAddMenuOpen(false);
  };
  const updateInspectorNavigation = useCallback((
    identity: string,
    navigation: InspectorNavigationState,
  ) => {
    setInspectorNavigationByTarget((current) => {
      const previous = current[identity];
      if (
        previous?.url === navigation.url &&
        previous.title === navigation.title &&
        previous.canGoBack === navigation.canGoBack &&
        previous.canGoForward === navigation.canGoForward &&
        previous.loading === navigation.loading
      ) {
        return current;
      }
      return { ...current, [identity]: navigation };
    });
  }, []);
  const activeInspectorNavigation = activeInspectorTabIdentity
    ? inspectorNavigationByTarget[activeInspectorTabIdentity]
    : undefined;
  const activeInspectorAddress = displayedInspectorTarget
    ? isInspectorBrowserTarget(displayedInspectorTarget.target)
      ? activeInspectorNavigation?.url || displayedInspectorTarget.target
      : displayedInspectorTarget.target
    : '';
  const [inspectorAddressDraft, setInspectorAddressDraft] = useState('');
  useEffect(() => {
    setInspectorAddressDraft(
      /^about:blank(?:[?#]|$)/i.test(activeInspectorAddress)
        ? ''
        : activeInspectorAddress,
    );
  }, [activeInspectorAddress, activeInspectorTabIdentity]);
  const selectedInspectorModelConfig = useMemo(
    () => appSettings.managedModelConfigs.find(
      (config) => config.id === chat.selectedModel,
    ),
    [appSettings.managedModelConfigs, chat.selectedModel],
  );
  const inspectorShadowAvailable =
    section === 'chat' &&
    backendCapabilities.shadowConversationActivation &&
    !chat.sending &&
    Boolean(chat.activeConversationId) &&
    Boolean(selectedInspectorModelConfig) &&
    chat.activeMessages.some((message) => message.role === 'user');
  const openNewBrowserInspectorTab = useCallback(() => {
    openInspectorTarget({
      target: `about:blank?cardbush-tab=${crypto.randomUUID()}`,
      title: language === 'zh' ? '新标签页' : 'New tab',
    });
  }, [language, openInspectorTarget]);
  const openInspectorFiles = useCallback(async () => {
    setInspectorAddMenuOpen(false);
    const paths = await window.cardbushDesktop?.pickAttachments?.().catch(() => []);
    if (!paths?.length) return;
    for (const path of paths) openInspectorTarget({ target: path });
  }, [openInspectorTarget]);
  const openShadowInspectorTab = useCallback(() => {
    if (
      !inspectorShadowAvailable ||
      !selectedInspectorModelConfig ||
      !chat.activeConversationId
    ) return;
    const id = `shadow:${crypto.randomUUID()}`;
    const title = chat.activeConversation?.title?.trim() || (
      language === 'zh' ? '当前会话' : 'Current conversation'
    );
    const context: ShadowConversationContext = {
      windowId: id,
      sessionId: chat.activeConversationId,
      sourceTurnId: chat.activeTurnId,
      title,
      language,
      theme,
      accentColor: shadowAccentColor,
      themeVariables: importedThemeVariables,
      modelConfig: selectedInspectorModelConfig,
      reasoningLevel: chat.reasoningLevel,
      projectDir: activeProjectDir ?? '',
      initialMode: 'readonly',
    };
    setInspectorTabs((current) => [
      ...current,
      {
        id,
        kind: 'shadow',
        context,
        title: `Shadow · ${title}`,
      },
    ]);
    setActiveInspectorTabId(id);
    setWorkSummaryInspector(null);
    setInspectorAddMenuOpen(false);
  }, [
    activeProjectDir,
    chat.activeConversation?.title,
    chat.activeConversationId,
    chat.activeTurnId,
    chat.reasoningLevel,
    inspectorShadowAvailable,
    importedThemeVariables,
    language,
    selectedInspectorModelConfig,
    shadowAccentColor,
    theme,
  ]);
  useEffect(() => {
    if (!inspectorAddMenuOpen) return undefined;
    const closeOnOutsidePointer = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !inspectorAddMenuRef.current?.contains(target)) {
        setInspectorAddMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setInspectorAddMenuOpen(false);
    };
    window.addEventListener('pointerdown', closeOnOutsidePointer);
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('pointerdown', closeOnOutsidePointer);
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [inspectorAddMenuOpen]);
  useEffect(() => {
    if (!inspectorTabsMenuOpen && !inspectorTabContextMenu) return undefined;
    const closeTabMenusFromPointer = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (inspectorTabsMenuRef.current?.contains(target)) return;
      if (inspectorTabContextMenuRef.current?.contains(target)) return;
      setInspectorTabsMenuOpen(false);
      setInspectorTabContextMenu(null);
    };
    const closeTabMenusFromKeyboard = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setInspectorTabsMenuOpen(false);
      setInspectorTabContextMenu(null);
    };
    window.addEventListener('pointerdown', closeTabMenusFromPointer);
    window.addEventListener('keydown', closeTabMenusFromKeyboard);
    return () => {
      window.removeEventListener('pointerdown', closeTabMenusFromPointer);
      window.removeEventListener('keydown', closeTabMenusFromKeyboard);
    };
  }, [inspectorTabContextMenu, inspectorTabsMenuOpen]);
  useEffect(() => {
    if (!inspectorOpen || settingsOpen) return undefined;
    const handleInspectorShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey) return;
      const key = event.key.toLowerCase();
      if (key === 't' && !event.altKey) {
        event.preventDefault();
        openNewBrowserInspectorTab();
      } else if (key === 'p' && !event.altKey) {
        event.preventDefault();
        void openInspectorFiles();
      } else if (key === 's' && event.altKey && inspectorShadowAvailable) {
        event.preventDefault();
        openShadowInspectorTab();
      }
    };
    window.addEventListener('keydown', handleInspectorShortcut);
    return () => window.removeEventListener('keydown', handleInspectorShortcut);
  }, [
    inspectorOpen,
    inspectorShadowAvailable,
    openInspectorFiles,
    openNewBrowserInspectorTab,
    openShadowInspectorTab,
    settingsOpen,
  ]);
  const sidebarPresence = useSoftPanelPresence(
    !sidebarCollapsed,
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
      openInspectorTarget(detail);
    };
    window.addEventListener(OPEN_INSPECTOR_EVENT, handleOpenInspector);
    const removeDesktopListener = window.cardbushDesktop?.onOpenInspectorRequest?.((detail) => {
      if (!detail?.target?.trim()) return;
      openInspectorTarget(detail);
    });
    return () => {
      window.removeEventListener(OPEN_INSPECTOR_EVENT, handleOpenInspector);
      removeDesktopListener?.();
    };
  }, [openInspectorTarget]);

  useEffect(() => {
    const handleOpenWorkSummaryInspector = (event: Event) => {
      const detail = (event as CustomEvent<WorkSummaryInspectorDetail>).detail;
      if (!detail?.sessionId?.trim()) return;
      setWorkSummaryInspector(detail);
      setActiveInspectorTabId('');
      setInspectorAddMenuOpen(false);
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
    window.localStorage.removeItem('cardbush_light_theme_style');
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
        setProjectItems((current) => {
          let changed = false;
          const next = current.map((project) => {
            const status = statuses.find((candidate) =>
              samePath(candidate.rootPath, project.rootPath),
            );
            if (!status || project.missing === !status.exists) return project;
            changed = true;
            return { ...project, missing: !status.exists };
          });
          return changed ? next : current;
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

  const mergedAppStyle = wallpaperAccent
    ? ({
        '--wallpaper-accent-rgb': `${wallpaperAccent.r} ${wallpaperAccent.g} ${wallpaperAccent.b}`,
        '--wallpaper-accent-hex': wallpaperAccent.hex,
        '--sidebar-width': `${sidebarPreviewWidth ?? sidebarWidth}px`,
        ...appFontStyle,
        ...importedThemeVariables,
      } as CSSProperties)
    : ({
        '--sidebar-width': `${sidebarPreviewWidth ?? sidebarWidth}px`,
        ...appFontStyle,
        ...importedThemeVariables,
      } as CSSProperties);

  const appStyle = mergedAppStyle;

  useEffect(() => {
    let cancelled = false;
    let refreshTimer = 0;
    async function refreshWallpaperAccent() {
      const accent = await window.cardbushDesktop?.wallpaperAccent?.().catch(() => null);
      if (!cancelled && accent) {
        setWallpaperAccent((current) =>
          current?.r === accent.r &&
          current.g === accent.g &&
          current.b === accent.b &&
          current.hex === accent.hex &&
          current.source === accent.source
            ? current
            : accent,
        );
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
  }, []);

  const createConversation = useCallback(
    (projectDir?: string | null) => {
      const activeProject = activeConversationProjectDir
        ? projectItems.find((project) =>
            !project.archived &&
            !project.missing &&
            samePath(project.rootPath, activeConversationProjectDir),
          )
        : undefined;
      const resolvedProjectDir = projectDir === undefined
        ? activeProject?.rootPath.trim() || fallbackProjectDir || undefined
        : projectDir?.trim() || undefined;
      const resolvedProjectId = resolvedProjectDir
        ? projectItems.find((project) => samePath(project.rootPath, resolvedProjectDir))?.id
        : undefined;
      if (!onlyTalkMode && !resolvedProjectDir) {
        setSection('chat');
        chat.clearConversationSelection();
        return;
      }
      if (resolvedProjectDir) rememberRecentProject(resolvedProjectDir);
      setSection('chat');
      chat.prepareConversation(resolvedProjectDir, undefined, resolvedProjectId);
    },
    [
      activeConversationProjectDir,
      chat.clearConversationSelection,
      chat.prepareConversation,
      fallbackProjectDir,
      onlyTalkMode,
      projectItems,
      rememberRecentProject,
    ],
  );

  const changeOnlyTalkMode = useCallback((enabled: boolean) => {
    setOnlyTalkMode(enabled);
    window.localStorage.setItem(onlyTalkModeStorageKey, String(enabled));
    setSection('chat');
    chat.clearConversationSelection();
  }, [chat.clearConversationSelection]);

  const openConversationInScope = useCallback((conversationId: string) => {
    const normalized = conversationId.trim();
    if (!normalized) return false;
    const target = chat.conversations.find((conversation) => conversation.id === normalized);
    if (!target) return false;
    const taskMode = isOnlyTalkConversation(target);
    setOnlyTalkMode(taskMode);
    window.localStorage.setItem(onlyTalkModeStorageKey, String(taskMode));
    const targetProjectDir = conversationProjectRoot(target);
    if (targetProjectDir) rememberRecentProject(targetProjectDir);
    chat.openConversation(normalized);
    setSection('chat');
    return true;
  }, [chat.conversations, chat.openConversation, rememberRecentProject]);

  useEffect(() => {
    if (section !== 'chat' || chat.loading) return;
    const scope: ConversationScope = onlyTalkMode
      ? { mode: 'task' }
      : fallbackProjectDir
        ? {
            mode: 'project',
            projectId: fallbackProjectId || undefined,
            projectDir: fallbackProjectDir,
          }
        : { mode: 'project', projectDir: '' };
    const activeMatchesMode = onlyTalkMode
      ? conversationMatchesScope(chat.activeConversation, { mode: 'task' })
      : Boolean(chat.activeConversation && !isOnlyTalkConversation(chat.activeConversation));
    if (activeMatchesMode) return;
    const preparedConversation = firstConversationInScope(
      chat.preparedConversations,
      scope,
    );
    if (preparedConversation) {
      chat.openConversation(preparedConversation.id);
      return;
    }
    const recentConversation = firstConversationInScope(chat.conversations, scope);
    if (recentConversation) {
      chat.openConversation(recentConversation.id);
      return;
    }
    if (scope.mode === 'task') {
      chat.prepareConversation();
      return;
    }
    if (scope.projectDir) {
      chat.prepareConversation(scope.projectDir, undefined, scope.projectId);
      return;
    }
    if (chat.activeConversationId) chat.clearConversationSelection();
  }, [
    chat.activeConversation,
    chat.activeConversationId,
    chat.clearConversationSelection,
    chat.conversations,
    chat.loading,
    chat.openConversation,
    chat.preparedConversations,
    chat.prepareConversation,
    fallbackProjectDir,
    fallbackProjectId,
    onlyTalkMode,
    section,
  ]);

  const changeWelcomeProject = useCallback(async (projectDir: string | null) => {
    const normalized = projectDir?.trim() || null;
    if (!normalized) {
      changeOnlyTalkMode(true);
      return;
    }
    const projectId =
      projectItems.find((project) => samePath(project.rootPath, normalized))?.id ?? null;
    rememberRecentProject(normalized);
    if (!chat.activeConversationId.trim()) {
      createConversation(normalized);
      return;
    }
    await chat.setConversationProject(chat.activeConversationId, normalized, projectId);
  }, [changeOnlyTalkMode, chat, createConversation, projectItems, rememberRecentProject]);

  const pendingSessionAttentionRef = useRef('');
  const openSessionAttention = useCallback((sessionId: string) => {
    const normalized = sessionId.trim();
    if (!normalized) return;
    setSettingsOpen(false);
    setSection('chat');
    pendingSessionAttentionRef.current = normalized;
    if (openConversationInScope(normalized)) {
      pendingSessionAttentionRef.current = '';
    }
  }, [openConversationInScope]);

  const consumeSessionAttentionOpen = useCallback(async () => {
    const consume = window.cardbushDesktop?.consumeSessionAttentionOpen;
    if (!consume) return;
    for (let index = 0; index < 20; index += 1) {
      const intent = await consume().catch(() => null);
      if (!intent) break;
      openSessionAttention(intent.sessionId);
    }
  }, [openSessionAttention]);

  useEffect(() => {
    const dispose = window.cardbushDesktop?.onOpenSessionAttention?.(() => {
      void consumeSessionAttentionOpen();
    });
    void consumeSessionAttentionOpen();
    return dispose;
  }, [consumeSessionAttentionOpen]);

  useEffect(() => {
    const pending = pendingSessionAttentionRef.current;
    if (!pending || !chat.conversations.some((conversation) => conversation.id === pending)) {
      return;
    }
    openSessionAttention(pending);
  }, [chat.conversations, openSessionAttention]);

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
    const recoveredProjectConversation = chat.conversations
      .find((conversation) => {
        const projectDir = conversationProjectRoot(conversation);
        return Boolean(projectDir && samePath(projectDir, selected));
      });
    const projectId = conversationProjectId(recoveredProjectConversation);
    setProjectItems((current) => {
      const existing = current.find((item) => samePath(item.rootPath, selected));
      if (existing) {
        return current.map((item) =>
          item.id === existing.id
            ? { ...item, missing: false, archived: false, branch, changedCount }
            : item,
        );
      }
      const existingIdentity = projectId
        ? current.find((item) => item.id === projectId)
        : undefined;
      if (existingIdentity) {
        return current.map((item) =>
          item.id === existingIdentity.id
            ? {
                ...item,
                rootPath: selected,
                missing: false,
                archived: false,
                branch,
                changedCount,
              }
            : item,
        );
      }
      return [
        {
          id: projectId || stableProjectId(selected),
          title,
          rootPath: selected,
          branch,
          changedCount,
        },
        ...current,
      ];
    });
  }, [chat.conversations, runtimeStartup.phase]);

  const renameProject = useCallback(async (
    project: ProjectItem,
    title: string,
    renameFolder: boolean,
  ): Promise<string | null> => {
    const nextTitle = title.trim();
    if (!nextTitle) return language === 'zh' ? '项目名称不能为空' : 'Project name is required';
    if (!renameFolder || basename(project.rootPath) === nextTitle) {
      setProjectItems((current) => current.map((item) =>
        item.id === project.id ? { ...item, title: nextTitle } : item,
      ));
      return null;
    }
    if (project.missing) {
      return language === 'zh'
        ? '项目文件夹不存在，请先重新添加或定位项目'
        : 'The project folder is missing. Locate or add it again first.';
    }
    if (Object.keys(chat.runningByConversation).length > 0) {
      return language === 'zh'
        ? '有会话仍在运行，完成或停止后才能重命名文件夹'
        : 'A conversation is still running. Stop or finish it before renaming the folder.';
    }
    const renameDirectory = window.cardbushDesktop?.renameProjectDirectory;
    if (!renameDirectory) {
      return language === 'zh' ? '当前运行环境不支持重命名文件夹' : 'Folder rename is unavailable.';
    }

    let moved: Awaited<ReturnType<typeof renameDirectory>>;
    try {
      moved = await renameDirectory({ rootPath: project.rootPath, name: nextTitle });
    } catch (caught) {
      return caught instanceof Error ? caught.message : String(caught);
    }
    if (!moved.changed) {
      setProjectItems((current) => current.map((item) =>
        item.id === project.id ? { ...item, title: nextTitle, missing: false } : item,
      ));
      return null;
    }

    try {
      await chat.relocateProjectConversations(
        project.id,
        moved.previousPath,
        moved.nextPath,
      );
    } catch (caught) {
      const rollbackName = basename(moved.previousPath);
      const rolledBack = await renameDirectory({
        rootPath: moved.nextPath,
        name: rollbackName,
      }).then(() => true).catch(() => false);
      if (rolledBack) {
        return language === 'zh'
          ? `会话路径迁移失败，文件夹已恢复原名：${caught instanceof Error ? caught.message : String(caught)}`
          : `Session migration failed and the folder name was restored: ${caught instanceof Error ? caught.message : String(caught)}`;
      }
      setProjectItems((current) => current.map((item) =>
        item.id === project.id
          ? { ...item, title: nextTitle, rootPath: moved.nextPath, missing: false }
          : item,
      ));
      return language === 'zh'
        ? '文件夹已改名，但部分会话路径迁移失败且无法自动回滚；项目已保留在真实的新路径'
        : 'The folder was renamed, but some session paths could not be migrated or rolled back. The project now points to the real new path.';
    }

    setProjectItems((current) => {
      const next = current.map((item) =>
        item.id === project.id
          ? { ...item, title: nextTitle, rootPath: moved.nextPath, missing: false }
          : item,
      );
      persistProjectItems(next);
      return next;
    });
    if (samePath(recentProjectDir, moved.previousPath)) {
      setRecentProjectDir(moved.nextPath);
      window.localStorage.setItem(recentProjectStorageKey, moved.nextPath);
    }
    const previousContextKey = projectContextKey(moved.previousPath);
    const nextContextKey = projectContextKey(moved.nextPath);
    const savedContext = projectContexts[previousContextKey];
    setProjectContexts((current) => {
      if (!Object.prototype.hasOwnProperty.call(current, previousContextKey)) return current;
      const next = { ...current, [nextContextKey]: current[previousContextKey] ?? '' };
      delete next[previousContextKey];
      persistProjectContexts(next);
      return next;
    });
    if (savedContext !== undefined) {
      void saveProjectContext({
        projectDir: moved.nextPath,
        userPrompt: savedContext,
      }).catch(() => undefined);
    }
    return null;
  }, [chat, language, projectContexts, recentProjectDir]);

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
        setProjectRenameTarget(project);
        return;
      }
      if (action === 'remove') {
        if (conversationMatchesScope(chat.activeConversation, {
          mode: 'project',
          projectId: project.id,
          projectDir: project.rootPath,
        })) {
          chat.clearConversationSelection();
        }
        setProjectItems((current) => current.filter((item) => item.id !== project.id));
        return;
      }
      if (
        action === 'archive' &&
        !project.archived &&
        conversationMatchesScope(chat.activeConversation, {
          mode: 'project',
          projectId: project.id,
          projectDir: project.rootPath,
        })
      ) {
        chat.clearConversationSelection();
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
    [chat.activeConversation, chat.clearConversationSelection, createConversation, language],
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
      if (chat.processingConversationIds.has(conversationId)) {
        setChangeReviewNotice(
          language === 'zh'
            ? '当前回合仍在运行，完成或停止后才能撤回修改。'
            : 'This turn is still running. Changes can be reverted after it completes or stops.',
        );
        return;
      }
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
        let result: { revertedFiles: number; revertedChangeIds?: string[] };
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
          const turnReports = turnId
            ? (changeReportsByConversation[conversationId] ?? []).filter(
                (candidate) => candidate.turnId?.trim() === turnId,
              )
            : [report];
          for (const candidate of turnReports.length > 0 ? turnReports : [report]) {
            next.add(`${conversationId}:${candidate.id}`);
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
      chat.processingConversationIds,
      changeReportsByConversation,
      language,
      refreshProjectGitStatus,
    ],
  );
  const revertActiveConversationChangeReport = useCallback((
    report: ConversationChangeReport,
    message: ChatMessage,
  ) => revertChangeReport(
    message.conversationId?.trim() || chat.activeConversationId,
    report,
  ), [chat.activeConversationId, revertChangeReport]);
  const openActiveConversationChangeReview = useCallback((filePath?: string) => {
    if (!chat.activeConversationId) return;
    openChangeReviewInspector(
      chat.activeConversationId,
      typeof filePath === 'string' ? filePath.trim() : '',
    );
  }, [chat.activeConversationId, openChangeReviewInspector]);

  const revertConversationReports = useCallback(
    async (conversationId: string, reports: ConversationChangeReport[]) => {
      if (chat.processingConversationIds.has(conversationId)) {
        setChangeReviewNotice(
          language === 'zh'
            ? '当前回合仍在运行，完成或停止后才能撤回修改。'
            : 'This turn is still running. Changes can be reverted after it completes or stops.',
        );
        return;
      }
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
      chat.processingConversationIds,
      language,
      refreshProjectGitStatus,
    ],
  );

  const openSettings = useCallback((
    targetSection: SettingsSection = 'profile',
    pluginTab: 'plugins' | 'skills' = 'plugins',
  ) => {
    setSettingsInitialSection(targetSection);
    setSettingsPluginTab(pluginTab);
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


  const setVisualInputEnabled = useCallback(
    (enabled: boolean) => {
      const nextEnabled = enabled && visualInputAvailable;
      setVisualInputEnabledSetting(nextEnabled);
      persistVisualInputEnabled(nextEnabled);
    },
    [visualInputAvailable],
  );

  // Keep the sidebar outside high-frequency chat/reasoning renders. These
  // handlers used to be recreated by App on every message update, defeating
  // React.memo and making an unrelated stream interrupt title animations.
  const handleSidebarSectionChange = useCallback((nextSection: AppSection) => {
    setSection(nextSection);
  }, []);
  const handleSidebarConversationChange = useCallback((conversationId: string) => {
    openConversationInScope(conversationId);
  }, [openConversationInScope]);
  const handleSidebarCreateConversation = useCallback(() => {
    createConversation(onlyTalkMode ? null : undefined);
  }, [createConversation, onlyTalkMode]);
  const handleSidebarAddProject = useCallback(() => {
    void addProject();
  }, [addProject]);
  const handleSidebarProjectAction = useCallback((
    action: ProjectAction,
    project: ProjectItem,
  ) => {
    void handleProjectAction(action, project);
  }, [handleProjectAction]);
  const handleSidebarOpenConversationChanges = useCallback((conversationId: string) => {
    openChangeReviewInspector(conversationId);
  }, [openChangeReviewInspector]);
  const handleSidebarOpenSettings = useCallback(() => {
    openSettings('profile');
  }, [openSettings]);

  return (
    <div
      className={`app ${themeClassNames(theme)}`}
      lang={language}
      style={appStyle}
    >
      <WindowFrame
        language={language}
        onOpenCacheSettings={() => openSettings('cache')}
        onOpenPluginSettings={() => openSettings('mcp', 'plugins')}
        onOpenSkills={() => {
          openSettings('mcp', 'skills');
        }}
        onOpenTeam={() => {
          setSettingsOpen(false);
          setSection('team');
        }}
      />
      {settingsMounted && (
        <Suspense fallback={null}>
          <LazySettingsView
            active={settingsVisible}
            onReady={markSettingsReady}
            themePreference={themePreference}
            language={language}
            languageMode={languageMode}
            systemLanguage={systemLanguage}
            settings={appSettings}
            selectedModel={chat.selectedModel}
            availableModels={availableModels}
            backendCapabilities={backendCapabilities}
            conversations={chat.conversations}
            skills={chat.skills}
            disabledSkillNames={disabledSkillNames}
            runtimeBusy={runningConversationIds.size > 0}
            initialSection={settingsInitialSection}
            initialPluginTab={settingsPluginTab}
            onBack={() => setSettingsOpen(false)}
            onThemePreferenceChange={setThemePreference}
            onLanguageModeChange={setLanguageMode}
            onSettingsChange={updateAppSettings}
            onUseModel={chat.setSelectedModel}
            onSidebarWidthChange={setSidebarWidth}
            onConversationHistoryCleared={() => chat.reloadConversations()}
            onRuntimeAssetsReloaded={reloadRuntimeAssetConfiguration}
            onToggleSkill={toggleSkillEnabled}
            onReloadSkills={chat.reloadSkills}
            onLoadSkillDetail={chat.loadSkillDetail}
          />
        </Suspense>
      )}
      <main
        className={`desktop-shell${sidebarCollapsed ? ' sidebar-is-collapsed' : ''}${settingsVisible ? ' app-content-suspended' : ''}${windowMaximized ? ' window-maximized' : ' window-restored'}`}
        aria-hidden={settingsVisible}
        inert={settingsVisible ? true : undefined}
      >
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
                  runningConversationIds={chat.processingConversationIds}
                  attentionByConversation={chat.attentionByConversation}
                  projects={projectItems}
                  conversations={chat.conversations}
                  changeReportsByConversation={sidebarChangeReportsByConversation}
                  onlyTalkMode={onlyTalkMode}
                  onOnlyTalkModeChange={changeOnlyTalkMode}
                  onSectionChange={handleSidebarSectionChange}
                  onConversationChange={handleSidebarConversationChange}
                  onCreateConversation={handleSidebarCreateConversation}
                  onAddProject={handleSidebarAddProject}
                  onProjectAction={handleSidebarProjectAction}
                  onDeleteConversation={chat.deleteConversation}
                  onRenameConversation={chat.renameConversation}
                  onOpenConversationChanges={handleSidebarOpenConversationChanges}
                  onOpenSettings={handleSidebarOpenSettings}
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
            {section === 'chat' ? (
              <ChatPanel
                language={language}
                theme={theme}
                title={chat.activeConversation?.title ?? 'cardbush'}
                onlyTalkMode={onlyTalkMode}
                sidebarCollapsed={sidebarCollapsed}
                windowMaximized={windowMaximized}
                onRevealSidebar={() => setSidebarCollapsed(false)}
                activeConversationId={chat.activeConversationId}
                activeProjectDir={activeProjectDir}
                projectPathAliases={activeProjectPathAliases}
                selectedProjectDir={
                  onlyTalkMode ? '' : activeConversationProjectDir
                }
                availableProjects={
                  onlyTalkMode
                    ? []
                    : projectItems.filter((project) => !project.archived && !project.missing)
                }
                onWelcomeProjectChange={changeWelcomeProject}
                projectContext={
                  onlyTalkMode
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
                shadowAccentColor={shadowAccentColor}
                shadowThemeVariables={importedThemeVariables}
                thinkingVisible={reasoningTraceVisible}
                guidanceDeliveryMode={appSettings.guidance.deliveryMode}
                loading={chat.loading || chat.messagesLoading}
                historyLoading={!chat.loading && chat.messagesLoading}
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
                subagentPermissionRouting={chat.subagentPermissionRouting}
                reasoningLevelAvailable={backendCapabilities.reasoningLevelSelection}
                reasoningLevel={chat.reasoningLevel}
                reasoningLevels={backendCapabilities.reasoningLevels}
                gitAvailable={section === 'chat' && backendCapabilities.git}
                onModelChange={chat.setSelectedModel}
                onReferencePlanModeChange={chat.setReferencePlanMode}
                onPermissionModeChange={chat.setPermissionMode}
                onSubagentPermissionRoutingChange={chat.setSubagentPermissionRouting}
                onReasoningLevelChange={chat.setReasoningLevel}
                onConfigureModels={() => openSettings('models')}
                onCreateConversation={() =>
                  createConversation(onlyTalkMode ? null : activeConversationProjectDir || undefined)
                }
                onSaveProjectContext={saveActiveProjectContext}
                onToggleSkill={toggleSkillEnabled}
                onVisualInputEnabledChange={setVisualInputEnabled}
                onRefreshActiveSession={refreshBackendAndActiveSession}
                onSend={chat.sendMessage}
                onRetryMessage={chat.retryFailedUserMessage}
                onRegenerate={chat.regenerateAssistantMessage}
                onEditUserMessage={chat.editUserMessageAndRegenerate}
                onGuideMessage={chat.sendTurnGuidance}
                onRetryGuidance={chat.retryTurnGuidance}
                onGuideQueuedMessage={chat.sendQueuedMessageAsGuidance}
                onRemoveQueuedMessage={chat.removeQueuedMessage}
                onReorderQueuedMessage={chat.reorderQueuedMessage}
                onRevertChangeReport={revertActiveConversationChangeReport}
                onOpenChangeReview={openActiveConversationChangeReview}
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
                onToggleSkill={toggleSkillEnabled}
                onReloadSkills={chat.reloadSkills}
                onLoadSkillDetail={chat.loadSkillDetail}
                onCreateConversation={() =>
                  createConversation(onlyTalkMode ? null : activeConversationProjectDir || undefined)
                }
                onOpenConversation={(conversationId) => {
                  openConversationInScope(conversationId);
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
                windowMaximized={windowMaximized}
                onWidthChange={setInspectorWidth}
                label={language === 'zh' ? '拖动调整右侧栏宽度' : 'Drag to resize inspector'}
              />
              <header className={`right-inspector-toolbar${
                displayedInspectorTab && displayedInspectorTabs.length > 0 ? ' with-tabs' : ''
              }`}>
                {displayedInspectorTab && displayedInspectorTabs.length > 0 ? (
                  <>
                    <div className="right-inspector-tab-strip">
                      {inspectorTabScrollState.overflow && (
                        <button
                          type="button"
                          className="right-inspector-tab-scroll"
                          disabled={!inspectorTabScrollState.canScrollLeft}
                          title={language === 'zh' ? '向前查看标签页' : 'Scroll tabs backward'}
                          aria-label={language === 'zh' ? '向前查看标签页' : 'Scroll tabs backward'}
                          onClick={() => scrollInspectorTabs(-1)}
                        >
                          <ArrowLeft size={13} aria-hidden="true" />
                        </button>
                      )}
                      <div
                        className="right-inspector-tabs"
                        ref={inspectorTabsRef}
                        role="tablist"
                        aria-label={language === 'zh' ? '已打开的标签页' : 'Open inspector tabs'}
                      >
                        {displayedInspectorTabs.map((tab) => {
                          const active = tab.id === activeInspectorTabIdentity;
                          const navigation = tab.kind === 'resource'
                            ? inspectorNavigationByTarget[tab.id]
                            : undefined;
                          const label = tab.kind === 'resource'
                            ? navigation?.title || inspectorTabLabel(tab.detail)
                            : tab.title;
                          const targetTitle = tab.kind === 'resource'
                            ? tab.detail.target
                            : tab.kind === 'review'
                              ? `${label} · ${tab.conversationId}`
                              : tab.context.title;
                          return (
                            <div
                              className={`right-inspector-tab${active ? ' active' : ''}`}
                              key={tab.id}
                              data-inspector-tab-id={tab.id}
                              onContextMenu={(event) => openInspectorTabContextMenu(event, tab.id)}
                              onAuxClick={(event) => {
                                if (event.button === 1) closeInspectorTab(tab.id);
                              }}
                            >
                              <button
                                type="button"
                                className="right-inspector-tab-select"
                                role="tab"
                                aria-selected={active}
                                title={targetTitle}
                                onClick={() => activateInspectorTab(tab)}
                              >
                                {tab.kind === 'resource'
                                  ? isInspectorBrowserTarget(tab.detail.target)
                                    ? <Globe2 size={13} aria-hidden="true" />
                                    : <FileText size={13} aria-hidden="true" />
                                  : tab.kind === 'review'
                                    ? <Clipboard size={13} aria-hidden="true" />
                                    : <ShadowCloneIcon size={13} />}
                                <span>{label}</span>
                              </button>
                              <button
                                type="button"
                                className="right-inspector-tab-close"
                                title={language === 'zh' ? '关闭标签页' : 'Close tab'}
                                aria-label={`${language === 'zh' ? '关闭' : 'Close'} ${label}`}
                                onClick={() => closeInspectorTab(tab.id)}
                              >
                                <X size={12} aria-hidden="true" />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                      {inspectorTabScrollState.overflow && (
                        <button
                          type="button"
                          className="right-inspector-tab-scroll"
                          disabled={!inspectorTabScrollState.canScrollRight}
                          title={language === 'zh' ? '向后查看标签页' : 'Scroll tabs forward'}
                          aria-label={language === 'zh' ? '向后查看标签页' : 'Scroll tabs forward'}
                          onClick={() => scrollInspectorTabs(1)}
                        >
                          <ArrowRight size={13} aria-hidden="true" />
                        </button>
                      )}
                    </div>
                    <div className="right-inspector-tab-manager" ref={inspectorTabsMenuRef}>
                      <button
                        type="button"
                        className={inspectorTabsMenuOpen ? 'active' : ''}
                        aria-label={language === 'zh' ? '管理全部标签页' : 'Manage all tabs'}
                        aria-haspopup="menu"
                        aria-expanded={inspectorTabsMenuOpen}
                        title={language === 'zh'
                          ? `管理全部标签页（${displayedInspectorTabs.length}）`
                          : `Manage all tabs (${displayedInspectorTabs.length})`}
                        onClick={() => {
                          setInspectorTabsMenuOpen((open) => !open);
                          setInspectorAddMenuOpen(false);
                          setInspectorTabContextMenu(null);
                        }}
                      >
                        <Menu size={15} aria-hidden="true" />
                        <span>{displayedInspectorTabs.length}</span>
                      </button>
                      {inspectorTabsMenuOpen && (
                        <div className="right-inspector-tab-menu" role="menu">
                          <div className="right-inspector-tab-menu-heading">
                            <strong>{language === 'zh' ? '全部标签页' : 'All tabs'}</strong>
                            <span>{displayedInspectorTabs.length}</span>
                          </div>
                          <div className="right-inspector-tab-menu-list">
                            {displayedInspectorTabs.map((tab) => {
                              const active = tab.id === activeInspectorTabIdentity;
                              const navigation = tab.kind === 'resource'
                                ? inspectorNavigationByTarget[tab.id]
                                : undefined;
                              const label = tab.kind === 'resource'
                                ? navigation?.title || inspectorTabLabel(tab.detail)
                                : tab.title;
                              return (
                                <div
                                  className={`right-inspector-tab-menu-item${active ? ' active' : ''}`}
                                  key={tab.id}
                                >
                                  <button
                                    type="button"
                                    role="menuitem"
                                    title={label}
                                    onClick={() => activateInspectorTab(tab)}
                                  >
                                    {tab.kind === 'resource'
                                      ? isInspectorBrowserTarget(tab.detail.target)
                                        ? <Globe2 size={13} aria-hidden="true" />
                                        : <FileText size={13} aria-hidden="true" />
                                      : tab.kind === 'review'
                                        ? <Clipboard size={13} aria-hidden="true" />
                                        : <ShadowCloneIcon size={13} />}
                                    <span>{label}</span>
                                  </button>
                                  <button
                                    type="button"
                                    title={language === 'zh' ? '关闭标签页' : 'Close tab'}
                                    aria-label={`${language === 'zh' ? '关闭' : 'Close'} ${label}`}
                                    onClick={() => closeInspectorTab(tab.id)}
                                  >
                                    <X size={12} aria-hidden="true" />
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                          <button
                            type="button"
                            className="right-inspector-tab-menu-close-all"
                            role="menuitem"
                            onClick={() => closeInspectorTabs(new Set(inspectorTabs.map((tab) => tab.id)))}
                          >
                            <X size={13} aria-hidden="true" />
                            {language === 'zh' ? '关闭全部标签页' : 'Close all tabs'}
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="right-inspector-add-tab" ref={inspectorAddMenuRef}>
                      <button
                        type="button"
                        className={inspectorAddMenuOpen ? 'active' : ''}
                        aria-label={language === 'zh' ? '新建标签页' : 'New tab'}
                        aria-haspopup="menu"
                        aria-expanded={inspectorAddMenuOpen}
                        title={language === 'zh' ? '新建标签页' : 'New tab'}
                        onClick={() => {
                          setInspectorAddMenuOpen((open) => !open);
                          setInspectorTabsMenuOpen(false);
                          setInspectorTabContextMenu(null);
                        }}
                      >
                        <Plus size={17} aria-hidden="true" />
                      </button>
                      {inspectorAddMenuOpen && (
                        <div className="right-inspector-add-menu" role="menu">
                          <button
                            type="button"
                            role="menuitem"
                            disabled={!window.cardbushDesktop?.pickAttachments}
                            onClick={() => void openInspectorFiles()}
                          >
                            <FileText size={15} aria-hidden="true" />
                            <span>
                              <strong>{language === 'zh' ? '文件' : 'File'}</strong>
                              <small>{language === 'zh' ? '选择一个或多个文件' : 'Choose one or more files'}</small>
                            </span>
                            <kbd>Ctrl+P</kbd>
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            disabled={!inspectorShadowAvailable}
                            title={!inspectorShadowAvailable
                              ? language === 'zh'
                                ? '完成一轮会话后可创建 Shadow 对话'
                                : 'Complete a conversation turn to create a Shadow chat'
                              : undefined}
                            onClick={openShadowInspectorTab}
                          >
                            <ShadowCloneIcon size={15} />
                            <span>
                              <strong>{language === 'zh' ? 'Shadow 对话' : 'Shadow chat'}</strong>
                              <small>{language === 'zh' ? '基于当前会话冻结历史' : 'Freeze the current conversation history'}</small>
                            </span>
                            <kbd>Ctrl+Alt+S</kbd>
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={openNewBrowserInspectorTab}
                          >
                            <Globe2 size={15} aria-hidden="true" />
                            <span>
                              <strong>{language === 'zh' ? '浏览器' : 'Browser'}</strong>
                              <small>{language === 'zh' ? '打开可导航的空白页' : 'Open a navigable blank page'}</small>
                            </span>
                            <kbd>Ctrl+T</kbd>
                          </button>
                        </div>
                      )}
                    </div>
                  </>
                ) : (
                  <strong>
                    {displayedWorkSummaryInspector
                      ? displayedWorkSummaryInspector.title || (
                          displayedWorkSummaryInspector.kind === 'turn-history'
                            ? language === 'zh' ? '回合详情' : 'Turn details'
                            : language === 'zh' ? '子任务详情' : 'Subagent task'
                        )
                      : ''}
                  </strong>
                )}
                {displayedInspectorTarget && (
                  <button
                    type="button"
                    onClick={() => void window.cardbushDesktop?.openExternal?.(
                      activeInspectorAddress || displayedInspectorTarget.target,
                    )}
                    title={language === 'zh' ? '在系统浏览器或应用中打开' : 'Open in system browser or app'}
                  >
                    <ExternalLink size={15} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={closeInspector}
                  title={language === 'zh' ? '关闭右侧栏' : 'Close inspector'}
                >
                  <PanelRightClose size={16} />
                </button>
              </header>
              {inspectorOpen && !settingsVisible && inspectorTabContextMenu && inspectorTabContextTarget && createPortal(
                <div
                  className="right-inspector-tab-context-menu"
                  ref={inspectorTabContextMenuRef}
                  role="menu"
                  style={{ left: inspectorTabContextMenu.x, top: inspectorTabContextMenu.y }}
                >
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => closeInspectorTab(inspectorTabContextTarget.id)}
                  >
                    {language === 'zh' ? '关闭标签页' : 'Close tab'}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={inspectorTabs.length <= 1}
                    onClick={() => closeOtherInspectorTabs(inspectorTabContextTarget.id)}
                  >
                    {language === 'zh' ? '关闭其他标签页' : 'Close other tabs'}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    disabled={inspectorTabContextTargetIndex >= inspectorTabs.length - 1}
                    onClick={() => closeInspectorTabsToRight(inspectorTabContextTarget.id)}
                  >
                    {language === 'zh' ? '关闭右侧标签页' : 'Close tabs to the right'}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => closeInspectorTabs(new Set(inspectorTabs.map((tab) => tab.id)))}
                  >
                    {language === 'zh' ? '关闭全部标签页' : 'Close all tabs'}
                  </button>
                </div>,
                document.querySelector('.app') ?? document.body,
              )}
              {displayedInspectorTarget && (
                <div className="right-inspector-navigation">
                  <button
                    type="button"
                    disabled={!activeInspectorNavigation?.canGoBack}
                    title={language === 'zh' ? '后退' : 'Back'}
                    aria-label={language === 'zh' ? '后退' : 'Back'}
                    onClick={() => inspectorWebviewRefs.current
                      .get(activeInspectorTabIdentity)?.goBack()}
                  >
                    <ArrowLeft size={15} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    disabled={!activeInspectorNavigation?.canGoForward}
                    title={language === 'zh' ? '前进' : 'Forward'}
                    aria-label={language === 'zh' ? '前进' : 'Forward'}
                    onClick={() => inspectorWebviewRefs.current
                      .get(activeInspectorTabIdentity)?.goForward()}
                  >
                    <ArrowRight size={15} aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    title={language === 'zh' ? '刷新当前页面' : 'Reload current page'}
                    aria-label={language === 'zh' ? '刷新当前页面' : 'Reload current page'}
                    onClick={() => inspectorWebviewRefs.current
                      .get(activeInspectorTabIdentity)?.reload()}
                  >
                    <RefreshCw
                      className={activeInspectorNavigation?.loading ? 'spinning' : undefined}
                      size={14}
                      aria-hidden="true"
                    />
                  </button>
                  {isInspectorBrowserTarget(displayedInspectorTarget.target) ? (
                    <form
                      className="right-inspector-address editable"
                      title={activeInspectorAddress}
                      onSubmit={(event) => {
                        event.preventDefault();
                        inspectorWebviewRefs.current
                          .get(activeInspectorTabIdentity)
                          ?.navigate(inspectorAddressDraft);
                      }}
                    >
                      <Globe2 size={13} aria-hidden="true" />
                      <input
                        value={inspectorAddressDraft}
                        aria-label={language === 'zh' ? '网址' : 'Address'}
                        placeholder={language === 'zh' ? '输入网址' : 'Enter address'}
                        spellCheck={false}
                        onChange={(event) => setInspectorAddressDraft(event.target.value)}
                      />
                    </form>
                  ) : (
                    <div className="right-inspector-address" title={activeInspectorAddress}>
                      <FileText size={13} aria-hidden="true" />
                      <span>{activeInspectorAddress}</span>
                    </div>
                  )}
                </div>
              )}
              <div className="right-inspector-body">
                {displayedInspectorTab ? (
                  <div className="right-inspector-tab-pages">
                    {displayedInspectorTabs.map((tab) => {
                      const active = tab.id === activeInspectorTabIdentity;
                      return (
                        <section
                          className={`right-inspector-tab-page${active ? ' active' : ''}`}
                          key={tab.id}
                          role="tabpanel"
                          aria-hidden={!active}
                        >
                          {tab.kind === 'resource' ? (
                            <InspectorWebview
                              ref={(handle) => {
                                if (handle) inspectorWebviewRefs.current.set(tab.id, handle);
                                else inspectorWebviewRefs.current.delete(tab.id);
                              }}
                              identity={tab.id}
                              target={tab.detail.target}
                              source={inspectorSource(tab.detail.target)}
                              language={language}
                              onNavigationStateChange={updateInspectorNavigation}
                              onOpenTarget={openInspectorTarget}
                            />
                          ) : tab.kind === 'shadow' ? (
                            <ShadowWindow embedded context={tab.context} />
                          ) : active && displayedReviewConversation ? (
                            <ConversationChangeDialog
                              embedded
                              language={language}
                              conversation={displayedReviewConversation}
                              reports={displayedReviewReports}
                              initialFilePath={tab.initialFilePath}
                              notice={changeReviewNotice}
                              revertingChangeId={revertingChangeId}
                              revertedChangeIds={new Set(
                                displayedReviewReports
                                  .filter((report) => revertedChangeKeys.has(
                                    `${displayedReviewConversation.id}:${report.id}`,
                                  ))
                                  .map((report) => report.id),
                              )}
                              onClose={() => closeInspectorTab(tab.id)}
                              onRevert={(report) => revertChangeReport(
                                displayedReviewConversation.id,
                                report,
                              )}
                              onRevertAll={() => revertConversationReports(
                                displayedReviewConversation.id,
                                displayedReviewReports.filter(
                                  (report) => !revertedChangeKeys.has(
                                    `${displayedReviewConversation.id}:${report.id}`,
                                  ),
                                ),
                              )}
                              revertAvailable={!chat.processingConversationIds.has(
                                displayedReviewConversation.id,
                              )}
                            />
                          ) : null}
                        </section>
                      );
                    })}
                  </div>
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
      {projectRenameTarget && (
        <ProjectRenameDialog
          key={projectRenameTarget.id}
          language={language}
          project={projectRenameTarget}
          onClose={() => setProjectRenameTarget(null)}
          onRename={(title, renameFolder) =>
            renameProject(projectRenameTarget, title, renameFolder)
          }
        />
      )}
      <CopyToastHost language={language} />
    </div>
  );
}

function ProjectRenameDialog({
  language,
  project,
  onClose,
  onRename,
}: {
  language: AppLanguage;
  project: ProjectItem;
  onClose: () => void;
  onRename: (title: string, renameFolder: boolean) => Promise<string | null>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const onCloseRef = useRef(onClose);
  const [title, setTitle] = useState(project.title);
  const [renameFolder, setRenameFolder] = useState(
    () => project.title.trim() === basename(project.rootPath),
  );
  const [invalid, setInvalid] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const busyRef = useRef(false);
  onCloseRef.current = onClose;
  busyRef.current = busy;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    const closeWithKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busyRef.current) onCloseRef.current();
    };
    document.addEventListener('keydown', closeWithKeyboard);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', closeWithKeyboard);
    };
  }, []);

  const submit = async () => {
    const nextTitle = title.trim();
    if (!nextTitle) {
      setInvalid(true);
      inputRef.current?.focus();
      return;
    }
    if (
      nextTitle === project.title.trim() &&
      (!renameFolder || nextTitle === basename(project.rootPath))
    ) {
      onClose();
      return;
    }
    setBusy(true);
    setError('');
    const failure = await onRename(nextTitle, renameFolder).catch((caught) =>
      caught instanceof Error ? caught.message : String(caught),
    );
    setBusy(false);
    if (failure) {
      setError(failure);
      return;
    }
    onClose();
  };

  return (
    <div
      className="modal-backdrop project-rename-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (!busy && event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="project-rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-rename-title"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <header>
          <Folder size={17} aria-hidden="true" />
          <div>
            <strong id="project-rename-title">
              {language === 'zh' ? '重命名项目' : 'Rename project'}
            </strong>
            <span>{language === 'zh' ? '可同时重命名真实项目文件夹' : 'You can also rename the real project folder'}</span>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            title={language === 'zh' ? '关闭' : 'Close'}
            aria-label={language === 'zh' ? '关闭重命名' : 'Close rename dialog'}
          >
            <X size={15} />
          </button>
        </header>
        <label>
          <span>{language === 'zh' ? '项目名称' : 'Project name'}</span>
          <input
            ref={inputRef}
            value={title}
            maxLength={120}
            disabled={busy}
            aria-invalid={invalid}
            onChange={(event) => {
              setTitle(event.target.value);
              setInvalid(false);
            }}
          />
          {invalid && (
            <small role="alert">
              {language === 'zh' ? '项目名称不能为空' : 'Project name cannot be empty'}
            </small>
          )}
        </label>
        <div className="project-rename-path" title={project.rootPath}>
          <Folder size={13} aria-hidden="true" />
          <span>{project.rootPath}</span>
        </div>
        <label className="project-rename-folder-option">
          <input
            type="checkbox"
            checked={renameFolder}
            disabled={busy}
            onChange={(event) => {
              setRenameFolder(event.currentTarget.checked);
              setError('');
            }}
          />
          <span>
            {language === 'zh'
              ? '同时重命名项目文件夹（同一父目录）'
              : 'Also rename the project folder (same parent directory)'}
          </span>
        </label>
        {error ? <p className="project-rename-error" role="alert">{error}</p> : null}
        <footer>
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
            {language === 'zh' ? '取消' : 'Cancel'}
          </button>
          <button type="submit" className="primary-button" disabled={!title.trim() || busy}>
            {busy
              ? language === 'zh' ? '处理中…' : 'Renaming…'
              : language === 'zh' ? '重命名' : 'Rename'}
          </button>
        </footer>
      </form>
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
    stored === 'dark' ||
    stored === 'parchment' ||
    stored === 'cyberpunk'
  ) {
    return stored;
  }
  if (stored === 'custom' && readImportedThemeStyle()) {
    return 'custom';
  }
  if (stored === 'light') {
    if (window.localStorage.getItem('cardbush_light_theme_style') === 'parchment') {
      window.localStorage.setItem('cardbush_theme_mode', 'parchment');
      window.localStorage.removeItem('cardbush_light_theme_style');
      return 'parchment';
    }
    window.localStorage.removeItem('cardbush_light_theme_style');
    return 'light';
  }
  const legacy = window.localStorage.getItem('cardbush.theme');
  if (legacy === 'dark') {
    return 'dark';
  }
  if (legacy === 'parchment') {
    return 'parchment';
  }
  if (legacy === 'bright') {
    return 'light';
  }
  return 'system';
}

function readImportedThemeStyle(): ImportedThemeStyle | null {
  const raw = window.localStorage.getItem(importedThemeStyleStorageKey);
  if (!raw?.trim()) return null;
  try {
    return normalizeImportedThemeStyle(JSON.parse(raw));
  } catch {
    return null;
  }
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
      const id = String(value.id ?? '').trim() || stableProjectId(rootPath);
      if (
        !rootPath ||
        result.some((project) => project.id === id || samePath(project.rootPath, rootPath))
      ) {
        continue;
      }
      const changedCount = Number(value.changedCount);
      result.push({
        id,
        title: String(value.title ?? '').trim() || basename(rootPath),
        rootPath,
        missing: Boolean(value.missing),
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
  prefersDark: boolean,
  importedThemeStyle: ImportedThemeStyle | null,
): ThemeMode {
  if (preference === 'custom' && importedThemeStyle) {
    return importedThemeBaseMode(importedThemeStyle.base);
  }
  if (preference === 'cyberpunk') {
    return 'cyberpunk';
  }
  if (preference === 'parchment') {
    return 'parchment';
  }
  if (preference === 'dark') {
    return 'dark';
  }
  if (preference === 'light') {
    return 'bright';
  }
  return prefersDark ? 'dark' : 'bright';
}

function applyDocumentBackdrop(theme: ThemeMode) {
  const background = themeBackgroundColor(theme);
  const root = document.getElementById('root');
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
  if (document.documentElement.dataset.startCustomBackground) {
    delete document.documentElement.dataset.startCustomBackground;
  }
  if (documentStyle.getPropertyValue('--cardbush-custom-background-image')) {
    documentStyle.removeProperty('--cardbush-custom-background-image');
  }
  if (root?.style.background !== background) {
    root?.style.setProperty('background', background);
  }
  window.localStorage.removeItem('cardbush_background_image_path');
  window.localStorage.removeItem('cardbush_shadow_accent_color');
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
    browser: {
      privacyMode:
        window.localStorage.getItem('cardbush_browser_privacy_mode') === 'true',
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
    managedModelConfigs: readManagedModelConfigs(),
    importedThemeStyle: readImportedThemeStyle(),
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
    managedModelConfigs: normalizeManagedModelConfigs(
      settings.managedModelConfigs,
    ),
    importedThemeStyle: normalizeImportedThemeStyle(settings.importedThemeStyle),
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
  window.localStorage.removeItem('cardbush_shadow_accent_color');
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
    'cardbush_managed_model_configs',
    JSON.stringify(settings.managedModelConfigs.map((config) => ({
      ...config,
      apiKey: '',
      hasApiKey: config.hasApiKey === true || Boolean(config.apiKey),
      apiKeyMasked: config.apiKeyMasked,
    }))),
  );
  window.localStorage.removeItem('cardbush_runtime_default_model_id');
  window.localStorage.removeItem('cardbush_background_image_path');
  if (settings.importedThemeStyle) {
    window.localStorage.setItem(
      importedThemeStyleStorageKey,
      JSON.stringify(settings.importedThemeStyle),
    );
  } else {
    window.localStorage.removeItem(importedThemeStyleStorageKey);
  }
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

function mergeLegacyModelCredentials(
  productHostModels: ManagedModelConfig[],
  legacyModels: ManagedModelConfig[],
) {
  let changed = false;
  const models = productHostModels.map((model) => {
    if (model.hasApiKey === true || model.apiKey.trim()) {
      return model;
    }
    const id = model.id.trim().toLowerCase();
    const provider = normalizeProvider(model.provider);
    const modelName = model.modelName.trim().toLowerCase();
    const baseUrl = model.baseUrl.trim().toLowerCase();
    const candidates = legacyModels.filter((legacy) =>
      legacy.apiKey.trim() &&
      normalizeProvider(legacy.provider) === provider &&
      legacy.modelName.trim().toLowerCase() === modelName
    );
    const legacy = legacyModels.find((candidate) =>
      id && candidate.id.trim().toLowerCase() === id && candidate.apiKey.trim()
    ) ?? candidates.find((candidate) => candidate.baseUrl.trim().toLowerCase() === baseUrl)
      ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!legacy) {
      return model;
    }
    changed = true;
    return {
      ...model,
      apiKey: legacy.apiKey.trim(),
      hasApiKey: true,
    };
  });
  return { models, changed };
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

function WindowFrame({
  language,
  onOpenCacheSettings,
  onOpenPluginSettings,
  onOpenSkills,
  onOpenTeam,
}: {
  language: AppLanguage;
  onOpenCacheSettings: () => void;
  onOpenPluginSettings: () => void;
  onOpenSkills: () => void;
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
      <button
        className="frame-chip cache-chip no-drag"
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
            icon={<Flag size={14} />}
            label="Team"
            onClick={() => runMenuAction(onOpenTeam)}
          />
        </WindowFrameMenu>
      </div>
      <div className="window-spacer window-drag" aria-hidden="true" />
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
        className="frame-chip window-frame-menu-trigger no-drag"
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function workspaceRevertErrorMessage(error: unknown, language: AppLanguage) {
  if (isRuntimeWorkspaceSnapshotUnavailableError(error)) {
    return language === 'zh'
      ? 'Runtime 尚无完整恢复快照，已尝试使用桌面 diff 安全撤回。'
      : 'Runtime has no complete recovery snapshot; the desktop diff fallback was attempted.';
  }
  return errorMessage(error);
}

function snapshotRevertFallbackAllowed(error: unknown) {
  return isRuntimeWorkspaceSnapshotUnavailableError(error);
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
  onToggleSkill,
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
  onToggleSkill: (skillName: string, enabled: boolean) => void;
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
        language={language}
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
          onToggleSkill={onToggleSkill}
          onReloadSkills={onReloadSkills}
          onLoadSkillDetail={onLoadSkillDetail}
          onCreateConversation={onCreateConversation}
          onOpenConversation={onOpenConversation}
        />
      </Suspense>
    </div>
  );
}
