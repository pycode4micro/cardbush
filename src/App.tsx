import { pickWorkspace } from './features/ssh/WorkspaceLocationPicker';
import { useAgentConnections } from './features/agents/useAgentConnections';
import './features/agents/agents.css';
import { withWorkspaceReference } from './shared/promptReferences';
import { recentReviewTurns } from './features/sidebar/reviewModel';
import { newBrowserTab } from './features/browser/browserStartPage';
import { appendReviewCommentsToDraft, emptyReviewComments, type ReviewCommentState } from './features/sidebar/reviewCommentModel';
import { defaultHostTerminalRuntime, normalizeHostTerminalRuntime } from './backend/hostPlatform';
import { McpUserRequests } from './features/plugins/McpUserRequests';
import { DEFAULT_MAX_CONTEXT_TOKENS, normalizeConversationStyle } from '@cardbush/bush-product-agent';
import { readConversationStyle, saveConversationStyle } from './features/settings/conversationStyle';
import { useCapabilityCatalogRefresh } from './hooks/useCapabilityCatalogRefresh';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  CheckCircle2,
  Clipboard,
  Clock3,
  ExternalLink,
  FileText,
  Folder,
  Globe2,
  LoaderCircle,
  Menu,
  PanelRightClose,
  Plus,
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
  fetchSkills,
  isRuntimeWorkspaceSnapshotUnavailableError,
  revertSessionWorkspaceChanges,
  restoreSessionWorkspaceChanges,
  saveModelConfigs,
} from './backend/api';
import { useCardbushChat } from './hooks/useCardbushChat';
import { showUiError } from './shared/showUiError';
import {
  normalizeChatMessagesForDisplay,
} from './features/chatMessages/transcript/messageProjection';
import { useSoftPanelPresence } from './hooks/useSoftPanelPresence';
import { useCompactSidebar } from './hooks/useCompactSidebar';
import { CompactSidebarBackdrop } from './components/CompactSidebarBackdrop';
import { useInspectorTabStrip } from './hooks/useInspectorTabStrip';
import { ConversationInspectorContext, ConversationInspectorOutlet, useConversationInspectorOutlets } from './features/inspector/ConversationInspector';
import { useInspectorTabs } from './hooks/useInspectorTabs';
import { inspectorBrowserReferences } from './features/composer/ComposerReferenceContext';
import { ConversationExtractionProvider } from './features/chat/ConversationExtraction';
import { forkConversation } from './backend/api';
import { workSummaryInspectorTab, type InspectorTab, type InspectorResourceTab, type InspectorReviewTab } from './features/inspector/inspectorTabs';
import { useOutsideDismiss } from './hooks/useOutsideDismiss';
import { createPortal } from 'react-dom';
import { SidebarResizer } from './components/SidebarResizer';
import { RightInspectorResizer } from './components/RightInspectorResizer';
import { WindowFrame } from './components/WindowFrame';
import { applicationMenus } from './features/windowMenu/applicationMenus';
import { inspectorMaximum } from './components/rightInspectorSizing';
import { InspectorActions } from './features/inspector/InspectorActions';
import { InspectorTabPages } from './features/inspector/InspectorTabPages';
import { sectionLabels } from './features/appSections';
import { automationSetupPrompt } from './features/automations/automationPrompts';
import { AutomationRunPanel } from './features/automations/AutomationRunPanel';
import { OPEN_AUTOMATION_RUN_EVENT, type AutomationRunOpenDetail } from './features/automations/automationEvents';
import { WorkSummaryInspector } from './features/chat/WorkSummaryInspector';
import {
  changeRootForConversation,
  conversationProjectDir as conversationProjectRoot,
  conversationWorkspaceRoot,
} from './features/conversationWorkspace';
import {
  conversationMatchesScope,
  conversationProjectId,
  conversationProjectPathAliases,
} from './features/conversationScope';
import {
  ChatSidebar,
  ConversationChangeDialog,
  type ProjectAction,
} from './features/sidebar';
import { refreshRuntimeRendererPlugins, useRuntimeDelegationWorkspace } from './plugins/runtimeExtensions';
import { RuntimeDelegationSurface } from './plugins/runtimeWorkspaces';
import { COPY_FEEDBACK_EVENT } from './features/messageFeedback';
import { basename, fileUrl, samePath, stripWrappingQuotes } from './shared/localPaths';
import {
  themeAccentColor,
  themeClassNames,
} from './features/appearance/themeRuntime';
import { useWindowAppearance, readWindowMaterialPreference, WINDOW_MATERIAL_STORAGE_KEY, type WindowMaterialPreference } from './features/appearance/windowAppearance';
import { useVisualThemeContext } from './features/appearance/useVisualThemeContext';
import { ConversationSearchDialog } from './features/search/ConversationSearchDialog';
import { useConversationSearch } from './features/search/useConversationSearch';
import { usePreviousConversationShortcut } from './features/shortcuts/usePreviousConversationShortcut';
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
import { WorkspaceChangeStateContext, readLegacyRevertKeys, saveLegacyRevertKeys, workspaceChangeKey, workspaceChangeReverted } from './features/tools/WorkspaceChangeStateContext';
import { ImageGalleryProvider } from './features/chatMessages/ImageGalleryContext';
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

import { DeferredModuleNotice, recoverableLazy } from './shared/recoverableLazy';
const LazyAgentsView = recoverableLazy('agents', async () => ({ default: (await import('./features/agents/AgentsView')).AgentsView }), (props, retry) => <DeferredModuleNotice language={props.language} retry={retry} />);

let settingsViewModulePromise: Promise<typeof import('./features/SettingsView')> | null = null;

function loadSettingsViewModule() {
  settingsViewModulePromise ??= import('./features/SettingsView').catch(error => {
    settingsViewModulePromise = null;
    throw error;
  });
  return settingsViewModulePromise;
}

const LazySettingsView = recoverableLazy('settings', async () => {
  const module = await loadSettingsViewModule();
  return { default: module.SettingsView };
}, (props, retry) => <SettingsModuleFallback {...props} retry={retry} />);

const LazyFeatureContentPanel = recoverableLazy('feature-panel', async () => {
  const module = await import('./features/panels');
  return { default: module.FeatureContentPanel };
}, (props, retry) => <DeferredModuleNotice language={props.language} retry={retry} />);

function SettingsModuleFallback({ active, onReady, onBack, language, retry }: {
  active: boolean;
  onReady: () => void;
  onBack: () => void;
  language: AppLanguage;
  retry: () => void;
}) {
  useEffect(onReady, [onReady]);
  return <main className={`settings-shell${active ? '' : ' settings-inactive'}`} aria-hidden={!active} inert={!active}>
    <section className="settings-content">
      <button type="button" className="settings-module-back" onClick={onBack}>
        {language === 'zh' ? '返回应用' : 'Back to app'}
      </button>
      <DeferredModuleNotice language={language} retry={retry} />
    </section>
  </main>;
}

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
      message: (error instanceof Error ? error.message : String(error)) || '未知渲染错误',
    };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('CardBush render error', error, info);
    void window.cardbushDesktop?.writeDebugLog('renderer-lifecycle', {
      stage: 'react-error-boundary',
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      componentStack: info.componentStack,
    }).catch(() => undefined);
    void showUiError('CardBush 界面异常', `${this.state.message}\n应用未自动重新加载。请关闭窗口后手动重新打开。`);
  }

  render() {
    if (!this.state.message) {
      return this.props.children;
    }
    return (
      <div className="app theme-dark">
        <div className="render-failure-shell">
          <section className="render-failure-card" role="alert" aria-label="CardBush 界面异常">
            <h1>CardBush 渲染异常</h1>
            <p>{this.state.message}</p>
            <p>应用未自动重新加载。请关闭窗口后手动重新打开。</p>
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

type InspectorTabContextMenuState = {
  tabId: string;
  x: number;
  y: number;
};

const defaultSidebarWidth = 272;
const minSidebarWidth = 220;
const maxSidebarWidth = 420;
const importedThemeStyleStorageKey = 'cardbush_imported_theme_style';

const defaultAppSettings: AppSettingsState = {
  conversationStyle: normalizeConversationStyle(undefined),
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
    runtime: defaultHostTerminalRuntime(),
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
  const conversationSearch = useConversationSearch();
  const [runtimeStartup, setRuntimeStartup] = useState<RuntimeStartupStatus>(() =>
    window.cardbushDesktop?.runtimeStartupStatus
      ? { phase: 'initializing', attempt: 0, startedAt: new Date().toISOString() }
      : { phase: 'ready', attempt: 0, startedAt: new Date().toISOString() },
  );
  const [themePreference, setThemePreferenceState] =
    useState<ThemePreference>(() => readInitialThemePreference());
  const [windowMaterial, setWindowMaterialState] = useState(readWindowMaterialPreference);
  const setWindowMaterial = useCallback((value: WindowMaterialPreference) => {
    localStorage.setItem(WINDOW_MATERIAL_STORAGE_KEY, value);
    setWindowMaterialState(value);
  }, []);
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
  const agents = useAgentConnections();
  const { compactLayout, sidebarCollapsed, setSidebarCollapsed } = useCompactSidebar();
  const [sidebarWidth, setSidebarWidthState] = useState(() =>
    readInitialSidebarWidth(),
  );
  const [windowMaximized, setWindowMaximized] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [conversationPromptFocus, setConversationPromptFocus] = useState(0);
  const [settingsMounted, setSettingsMounted] = useState(false);
  const [settingsReady, setSettingsReady] = useState(false);
  const [settingsAgentId, setSettingsAgentId] = useState('');
  const [settingsInitialSection, setSettingsInitialSection] =
    useState<SettingsSection>('profile');
  const [settingsPluginTab, setSettingsPluginTab] = useState<'plugins' | 'skills'>('plugins');
  const [projectItems, setProjectItems] = useState<ProjectItem[]>(readProjectItems);
  const [projectRenameTarget, setProjectRenameTarget] = useState<ProjectItem | null>(null);
  const [wallpaperAccent, setWallpaperAccent] = useState<WallpaperAccent | null>(null);
  const [draftsByConversation, setDraftsByConversation] = useState<Record<string, string>>({});
  const [reviewCommentsByConversation, setReviewCommentsByConversation] = useState<Record<string, ReviewCommentState>>({});
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
  useCapabilityCatalogRefresh(useCallback(async isCurrent => {
    const capabilities = await fetchBackendCapabilities();
    if (isCurrent()) setBackendCapabilities(capabilities);
  }, []));
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

  useWindowAppearance(theme, themePreference, windowMaterial, importedThemeVariables['--text']);
  useVisualThemeContext(theme, themePreference);

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
  const teamWorkspace = useRuntimeDelegationWorkspace();
  useEffect(() => {
    if (backendCapabilities.teamMode) void refreshRuntimeRendererPlugins().catch(() => undefined);
    else if (section === 'team') setSection('chat');
  }, [backendCapabilities.teamMode, section]);
  const chat = useCardbushChat(appSettings.managedModelConfigs, availableModels, {
    runtimeReady: runtimeStartup.phase === 'ready',
    language,
    disabledSkillNames,
    standardImageInputEnabled: visualInputEnabled,
    browserPrivacyMode: browserPrivacyModeEnabled,
    teamModeEnabled: backendCapabilities.teamMode && Boolean(teamWorkspace.selectedId),
    selectedTeamId: backendCapabilities.teamMode ? teamWorkspace.selectedId : '',
    selectedTeamName: teamWorkspace.choices.find((team) => team.id === teamWorkspace.selectedId)?.name,
    selectedTeamInstructions: teamWorkspace.instructions,
    terminalRuntime: appSettings.terminal.runtime,
    reasoningTraceVisible,
    interactiveRequestsAvailable: backendCapabilities.interactiveRequests,
    reasoningLevelSelection: backendCapabilities.reasoningLevelSelection,
    reasoningLevels: backendCapabilities.reasoningLevels,
    defaultReasoningLevel: backendCapabilities.defaultReasoningLevel,
    contextWindowUsageAvailable: backendCapabilities.contextWindowUsage,
    workspaceChangesAvailable: backendCapabilities.workspaceChanges,
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
  const activeProjectDir = conversationProjectDir || undefined;
  const activeProjectPathAliases = useMemo(
    () => conversationProjectPathAliases(chat.activeConversation),
    [chat.activeConversation],
  );

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
  const [initialLegacyRevertKeys] = useState(readLegacyRevertKeys);
  const legacyRevertKeysRef = useRef(initialLegacyRevertKeys);
  const workspaceChangeBusyRef = useRef(false);
  const [revertedChangeStates, setRevertedChangeStates] = useState<Map<string, boolean>>(
    () => new Map([...legacyRevertKeysRef.current].map(key => [key, true])),
  );
  const workspaceChangeState = useMemo(() => ({ states: revertedChangeStates, busy: Boolean(revertingChangeId) }),
    [revertedChangeStates, revertingChangeId]);
  const {
    tabs: inspectorTabs, activeTab: activeInspectorTab,
    openTab: openInspectorTab, activateTab: selectInspectorTab, closeTabs: removeInspectorTabs,
  } = useInspectorTabs();
  const { outlets: conversationInspectorOutlets, register: registerConversationInspectorOutlet } = useConversationInspectorOutlets();
  const openConversationInspector = useCallback((id: string, title: string) => {
    openInspectorTab({ id, title, kind: 'conversation' });
    setInspectorOpen(true);
    setInspectorAddMenuOpen(false);
    setInspectorTabsMenuOpen(false);
    setInspectorTabContextMenu(null);
  }, [openInspectorTab]);
  const [inspectorOpen, setInspectorOpen] = useState(false);
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
  const composerBrowserTabs = useMemo(() => inspectorBrowserReferences(inspectorTabs, inspectorNavigationByTarget), [inspectorTabs, inspectorNavigationByTarget]);
  const composerBrowserTabsRef = useRef(composerBrowserTabs);
  composerBrowserTabsRef.current = composerBrowserTabs;
  const inspectorTabContextTarget = inspectorTabContextMenu
    ? inspectorTabs.find((tab) => tab.id === inspectorTabContextMenu.tabId) ?? null
    : null;
  const inspectorTabContextTargetIndex = inspectorTabContextTarget
    ? inspectorTabs.findIndex((tab) => tab.id === inspectorTabContextTarget.id)
    : -1;
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
    const sourceTab = detail.sourceTabId ? composerBrowserTabsRef.current.find(tab => tab.tabId === detail.sourceTabId && tab.url === target) : undefined;
    if (sourceTab) {
      selectInspectorTab(sourceTab.tabId);
      setInspectorOpen(true);
      setInspectorAddMenuOpen(false);
      setInspectorTabsMenuOpen(false);
      setInspectorTabContextMenu(null);
      return;
    }
    const normalizedDetail: InspectorOpenDetail = {
      target,
      ...(detail.title?.trim() ? { title: detail.title.trim() } : {}),
      ...(detail.mediaType ? { mediaType: detail.mediaType } : {}),
    };
    const identity = detail.newTab ? `browser:${crypto.randomUUID()}` : `resource:${inspectorTargetIdentity(target)}`;
    const nextTab: InspectorResourceTab = {
      id: identity,
      kind: 'resource',
      detail: normalizedDetail,
    };
    openInspectorTab(nextTab);
    setInspectorOpen(true);
    setInspectorAddMenuOpen(false);
    setInspectorTabsMenuOpen(false);
    setInspectorTabContextMenu(null);
  }, [openInspectorTab, selectInspectorTab]);
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
      selectionRequestId: crypto.randomUUID(),
      title: language === 'zh' ? '审查' : 'Review',
    };
    openInspectorTab(nextTab);
    setInspectorOpen(true);
    setChangeReviewNotice('');
    setInspectorAddMenuOpen(false);
    setInspectorTabsMenuOpen(false);
    setInspectorTabContextMenu(null);
  }, [language, openInspectorTab]);
  const openWorkSummaryTab = useCallback((detail: WorkSummaryInspectorDetail) => {
    if (!detail.sessionId.trim()) return;
    openInspectorTab(workSummaryInspectorTab(detail, language));
    setInspectorOpen(true);
    setInspectorAddMenuOpen(false);
    setInspectorTabsMenuOpen(false);
    setInspectorTabContextMenu(null);
  }, [language, openInspectorTab]);
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<AutomationRunOpenDetail>).detail;
      if (!detail?.jobId || !detail.runId) return;
      openInspectorTab({ id: `automation:${detail.runId}`, kind: 'automation', ...detail });
      setInspectorOpen(true); setInspectorAddMenuOpen(false); setInspectorTabsMenuOpen(false); setInspectorTabContextMenu(null);
    };
    window.addEventListener(OPEN_AUTOMATION_RUN_EVENT, open);
    return () => window.removeEventListener(OPEN_AUTOMATION_RUN_EVENT, open);
  }, [openInspectorTab]);
  const changeReportsByConversation = useMemo(
    () =>
      Object.fromEntries(
        Object.entries(chat.messagesByConversation)
          .map(([conversationId, messages]) => [
            conversationId,
            changeReportsFromMessages(
              normalizeChatMessagesForDisplay(messages),
              new Set(recentReviewTurns(messages).map(turn => turn.id)),
            ).map(report => ({ ...report, reverted: workspaceChangeReverted(revertedChangeStates, conversationId, report) })),
          ] as const)
          .filter(([, reports]) => reports.length > 0),
      ) as Record<string, ConversationChangeReport[]>,
    [chat.messagesByConversation, revertedChangeStates],
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
        new Set(recentReviewTurns(messages).map(turn => turn.id)),
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
  const reviewConversationsById = useMemo(() => {
    const byId = new Map<string, ConversationSummary>();
    for (const [id, reports] of Object.entries(changeReportsByConversation)) {
      if (reports.length === 0) continue;
      byId.set(id, {
        id,
        title: language === 'zh' ? '当前会话修改' : 'Current conversation changes',
        preview: '',
        updatedAt: reports.at(-1)?.createdAt ?? '',
      });
    }
    for (const conversation of [...chat.preparedConversations, ...chat.conversations]) {
      byId.set(conversation.id, conversation);
    }
    if (chat.activeConversation) byId.set(chat.activeConversation.id, chat.activeConversation);
    return byId;
  }, [
    changeReportsByConversation,
    chat.activeConversation,
    chat.conversations,
    chat.preparedConversations,
    language,
  ]);
  const closeInspector = useCallback(() => {
    setInspectorOpen(false);
    setChangeReviewNotice('');
    setInspectorAddMenuOpen(false);
    setInspectorTabsMenuOpen(false);
    setInspectorTabContextMenu(null);
  }, []);
  const toggleInspector = useCallback(() => {
    if (inspectorOpen) {
      closeInspector();
      return;
    }
    // Reopen the selected tab; on first open, prefer the current review when available.
    if (!activeInspectorTab && section === 'chat' &&
      changeReportsByConversation[chat.activeConversationId]?.length) {
      openChangeReviewInspector(chat.activeConversationId);
    } else {
      setInspectorOpen(true);
    }
  }, [activeInspectorTab, changeReportsByConversation, chat.activeConversationId,
    closeInspector, inspectorOpen, openChangeReviewInspector, section]);
  // Collapsing only changes visibility, so content stays intact throughout the exit animation.
  const displayedInspectorTab = activeInspectorTab;
  const displayedInspectorTarget = displayedInspectorTab?.kind === 'resource'
    ? displayedInspectorTab.detail
    : null;
  const displayedInspectorTabs = inspectorTabs;
  const activeInspectorTabIdentity = displayedInspectorTab?.id ?? '';
  const { ref: inspectorTabsRef } = useInspectorTabStrip(activeInspectorTabIdentity, displayedInspectorTabs.length);
  const activateInspectorTab = (tab: InspectorTab) => {
    selectInspectorTab(tab.id);
    setInspectorOpen(true);
    setInspectorAddMenuOpen(false);
    setInspectorTabsMenuOpen(false);
    setInspectorTabContextMenu(null);
  };
  const closeInspectorTabs = (closingIdentities: Set<string>) => {
    const closingTabs = inspectorTabs.filter((tab) => closingIdentities.has(tab.id));
    if (closingTabs.length === 0) return;
    removeInspectorTabs(closingIdentities);
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
    if (closingTabs.some((tab) => tab.kind === 'review')) setChangeReviewNotice('');
    setInspectorAddMenuOpen(false);
    setInspectorTabsMenuOpen(false);
    setInspectorTabContextMenu(null);
    if (closingTabs.length === inspectorTabs.length) closeInspector();
  };
  const closeInspectorTab = (closingIdentity: string) => {
    closeInspectorTabs(new Set([closingIdentity]));
  };
  const closeOtherInspectorTabs = (identity: string) => {
    closeInspectorTabs(new Set(inspectorTabs
      .filter((tab) => tab.id !== identity)
      .map((tab) => tab.id)));
    selectInspectorTab(identity);
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
    ? displayedInspectorTarget.mediaType && displayedInspectorTarget.target.startsWith('data:')
      ? displayedInspectorTarget.title || displayedInspectorTarget.mediaType
      : isInspectorBrowserTarget(displayedInspectorTarget.target, displayedInspectorTarget.mediaType)
      ? activeInspectorNavigation?.url || displayedInspectorTarget.target
      : displayedInspectorTarget.target
    : '';
  const [inspectorAddressDraft, setInspectorAddressDraft] = useState('');
  const inspectorAddressRef = useRef<HTMLInputElement>(null);
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
  const inspectorShadowUnavailableReason = inspectorShadowAvailable ? ''
    : !backendCapabilities.shadowConversationActivation
      ? language === 'zh' ? '当前运行环境不支持 Shadow 对话' : 'Shadow chat is unavailable in this runtime'
      : chat.sending
        ? language === 'zh' ? '当前任务结束后可创建 Shadow 对话' : 'Shadow chat is available after the current task finishes'
        : !selectedInspectorModelConfig
          ? language === 'zh' ? '请先选择可用模型' : 'Select an available model first'
          : language === 'zh' ? '完成一轮会话后可创建 Shadow 对话' : 'Complete a conversation turn to create a Shadow chat';
  const openNewBrowserInspectorTab = useCallback(async () => {
    try { openInspectorTarget(await newBrowserTab()); }
    catch (error) { window.alert(`${language === 'zh' ? '无法读取浏览器设置' : 'Unable to read browser settings'}: ${String(error)}`); }
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
    openInspectorTab({
        id,
        kind: 'shadow',
        context,
        title: `Shadow · ${title}`,
    });
    setInspectorOpen(true);
    setInspectorAddMenuOpen(false);
    setInspectorTabsMenuOpen(false);
    setInspectorTabContextMenu(null);
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
    openInspectorTab,
  ]);
  const inspectorReviewAvailable = section === 'chat' && Boolean(chat.activeConversation) && Boolean(
    activeConversationProjectDir || changeReportsByConversation[chat.activeConversationId]?.length,
  );
  const inspectorActionProps = {
    language,
    filesAvailable: Boolean(window.cardbushDesktop?.pickAttachments),
    shadowUnavailableReason: inspectorShadowUnavailableReason,
    onOpenReview: inspectorReviewAvailable
      ? () => openChangeReviewInspector(chat.activeConversationId)
      : undefined,
    onOpenHistory: section === 'chat' && chat.activeConversationId
      ? () => openWorkSummaryTab({ kind: 'turn-history', sessionId: chat.activeConversationId })
      : undefined,
    onOpenFiles: () => { void openInspectorFiles(); },
    onOpenShadow: openShadowInspectorTab,
    onOpenBrowser: openNewBrowserInspectorTab,
  };
  const dismissInspectorMenus = useCallback(() => {
    setInspectorAddMenuOpen(false);
    setInspectorTabsMenuOpen(false);
    setInspectorTabContextMenu(null);
  }, []);
  const inspectorMenuContainers = useMemo(() => [
    inspectorAddMenuRef, inspectorTabsMenuRef, inspectorTabContextMenuRef,
  ], []);
  const inspectorMenuOpen = inspectorAddMenuOpen || inspectorTabsMenuOpen || !!inspectorTabContextMenu;
  useOutsideDismiss(inspectorMenuOpen, inspectorMenuContainers, dismissInspectorMenus);
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
        !inspectorOpen || compactLayout ||
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
  }, [inspectorOpen, setInspectorWidth, compactLayout]);

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
      openWorkSummaryTab(detail);
    };
    window.addEventListener(
      OPEN_WORK_SUMMARY_INSPECTOR_EVENT,
      handleOpenWorkSummaryInspector,
    );
    return () => window.removeEventListener(
      OPEN_WORK_SUMMARY_INSPECTOR_EVENT,
      handleOpenWorkSummaryInspector,
    );
  }, [openWorkSummaryTab]);

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

  const collapseSidebar = useCallback(() => setSidebarCollapsed(true), [setSidebarCollapsed]);
  useEffect(() => {
    if (compactLayout) collapseSidebar();
  }, [compactLayout, collapseSidebar, chat.activeConversationId, section, settingsOpen, inspectorOpen]);

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
        '--sidebar-width': `${sidebarWidth}px`,
        ...appFontStyle,
        ...importedThemeVariables,
      } as CSSProperties)
    : ({
        '--sidebar-width': `${sidebarWidth}px`,
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
      const resolvedProjectDir = projectDir?.trim() || undefined;
      const resolvedProjectId = resolvedProjectDir
        ? projectItems.find((project) => samePath(project.rootPath, resolvedProjectDir))?.id ?? stableProjectId(resolvedProjectDir)
        : undefined;
      const target = chat.prepareConversation(resolvedProjectDir, undefined, resolvedProjectId);
      if (!chat.activeConversationId) {
        setDraftsByConversation(current => {
          const unassigned = current.__new__;
          if (!unassigned) return current;
          const existing = current[target.id];
          return { ...current, __new__: '', [target.id]: existing && existing !== unassigned ? `${existing}\n\n${unassigned}` : unassigned };
        });
      }
      setSection('chat');
      return target;
    },
    [
      chat.activeConversationId,
      chat.prepareConversation,
      projectItems,
    ],
  );

  const openConversationPrompt = useCallback((prompt: string, scope: 'current' | 'independent' = 'current') => {
    const target = createConversation(scope === 'current' ? activeConversationProjectDir : undefined);
    setDraftsByConversation(current => {
      const existing = current[target.id] || '';
      return { ...current, [target.id]: existing.trim() && existing !== prompt ? `${existing.trimEnd()}\n\n${prompt}` : prompt };
    });
    setSettingsOpen(false);
    setConversationPromptFocus(value => value + 1);
  }, [activeConversationProjectDir, createConversation]);

  const openPluginPrompt = useCallback((prompt: string) => openConversationPrompt(prompt), [openConversationPrompt]);
  const createAutomationConversation = useCallback(() => {
    openConversationPrompt(automationSetupPrompt(language), 'independent');
  }, [language, openConversationPrompt]);

  useEffect(() => {
    if (!conversationPromptFocus || settingsOpen || section !== 'chat') return;
    const focus = () => {
      const input = Array.from(document.querySelectorAll<HTMLElement>('[data-composer-input]')).find(node => node.checkVisibility());
      if (!input) return;
      input.focus({ preventScroll: true });
      if (input instanceof HTMLTextAreaElement) input.setSelectionRange(input.value.length, input.value.length);
      else {
        const range = document.createRange(); range.selectNodeContents(input); range.collapse(false);
        const selection = window.getSelection(); selection?.removeAllRanges(); selection?.addRange(range);
      }
      observer.disconnect();
      setConversationPromptFocus(0);
    };
    let frame = requestAnimationFrame(focus);
    const observer = new MutationObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(focus); });
    observer.observe(document.querySelector('.desktop-shell') ?? document.body, { childList: true, subtree: true });
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [conversationPromptFocus, settingsOpen, section, chat.activeConversationId]);

  const openConversation = useCallback((conversationId: string) => {
    const normalized = conversationId.trim();
    if (!normalized) return false;
    const target = chat.conversations.find((conversation) => conversation.id === normalized);
    if (!target) return false;
    chat.openConversation(normalized);
    setSection('chat');
    return true;
  }, [chat.conversations, chat.openConversation]);

  const openAutomationConversation = useCallback((conversationId: string) => {
    if (!openConversation(conversationId)) {
      void chat.openStoredConversation(conversationId).then(opened => { if (opened) setSection('chat'); });
    }
  }, [openConversation, chat.openStoredConversation]);

  const changeWelcomeProject = useCallback(async (
    projectDir: string | null,
    reference?: string,
    conversationId = chat.activeConversationId,
  ) => {
    const normalized = projectDir?.trim() || null;
    const projectId =
      normalized ? projectItems.find((project) => samePath(project.rootPath, normalized))?.id ?? stableProjectId(normalized) : null;
    let targetId = conversationId;
    if (!targetId.trim()) targetId = createConversation(normalized).id;
    else await chat.setConversationProject(targetId, normalized, projectId);
    // Publish the sidebar target only after the workspace switch succeeds.
    if (normalized && projectId) setProjectItems(current => {
      const existing = current.find(project => samePath(project.rootPath, normalized));
      return existing
        ? current.map(project => project.id === existing.id ? { ...project, archived: false, missing: false } : project)
        : [...current, { id: projectId, title: basename(normalized), rootPath: normalized }];
    });
    // Write to the chosen conversation, even if switching mounted a new composer.
    setDraftsByConversation(current => ({ ...current, [targetId]: withWorkspaceReference(current[targetId] ?? '', reference) }));
  }, [chat.activeConversationId, chat.setConversationProject, createConversation, projectItems]);

  const pendingSessionAttentionRef = useRef('');
  const openSessionAttention = useCallback((sessionId: string) => {
    const normalized = sessionId.trim();
    if (!normalized) return;
    setSettingsOpen(false);
    setSection('chat');
    pendingSessionAttentionRef.current = normalized;
    if (openConversation(normalized)) {
      pendingSessionAttentionRef.current = '';
    }
  }, [openConversation]);

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
    const selected = await pickWorkspace({ language, projects: projectItems });
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
  }, [chat.conversations, runtimeStartup.phase, language, projectItems]);

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
    return null;
  }, [chat, language]);

  const handleProjectAction = useCallback(
    async (action: ProjectAction, project: ProjectItem) => {
      if (action === 'open') {
        if (project.rootPath.startsWith('ssh://')) {
          const targetId = conversationMatchesScope(chat.activeConversation, {
            mode: 'project', projectId: project.id, projectDir: project.rootPath,
          }) ? chat.activeConversationId : '';
          const selected = await pickWorkspace({ language, initialPath: project.rootPath, projects: projectItems });
          if (selected) {
            try { await changeWelcomeProject(selected, undefined, targetId); }
            catch (error) { void showUiError(language === 'zh' ? '切换工作区失败' : 'Workspace switch failed', error instanceof Error ? error.message : String(error)); }
          }
          return;
        }
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
    [chat.activeConversation, chat.activeConversationId, chat.clearConversationSelection, createConversation, changeWelcomeProject, language, projectItems],
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

  const setChangeReportsReverted = useCallback(
    async (conversationId: string, reports: ConversationChangeReport[], reverted: boolean, busyId: string) => {
      if (workspaceChangeBusyRef.current || reports.length === 0) return;
      if (chat.processingConversationIds.has(conversationId)) {
        setChangeReviewNotice(language === 'zh'
          ? '当前回合仍在运行，完成或停止后才能撤回或恢复修改。'
          : 'Wait for this turn to complete or stop before reverting or restoring changes.');
        return;
      }
      const conversation = chat.conversations.find(item => item.id === conversationId);
      const root = changeRootForConversation(conversation) || '';
      const action = language === 'zh' ? (reverted ? '撤回' : '取消撤回') : (reverted ? 'Revert' : 'Undo revert');
      if (reverted && !window.confirm(language === 'zh'
        ? '确定撤回这些修改吗？会先校验文件版本，撤回后可以取消撤回。'
        : 'Revert these changes? File versions will be checked first. You can undo this revert.')) return;
      workspaceChangeBusyRef.current = true;
      setRevertingChangeId(busyId);
      setChangeReviewNotice('');
      // Changes to the same file must be undone newest first and restored oldest first.
      const ordered = reverted ? [...reports].reverse() : reports;
      const markCompleted = (completed: ConversationChangeReport[], legacy: boolean) => {
        const keys = completed.map(report => workspaceChangeKey(conversationId, report));
        for (const key of keys) {
          if (legacy && reverted) legacyRevertKeysRef.current.add(key);
          else legacyRevertKeysRef.current.delete(key);
        }
        saveLegacyRevertKeys(legacyRevertKeysRef.current);
        setRevertedChangeStates(current => {
          const next = new Map(current);
          for (const key of keys) next.set(key, reverted);
          return next;
        });
      };
      const applyLegacy = async (group: ConversationChangeReport[]) => {
        const desktop = window.cardbushDesktop;
        const changes = group.map(report => ({ report, files: serializeToolChangeReport(report) }));
        if (!root || changes.some(item => !item.files.length) || !desktop?.revertFileChanges || !desktop.restoreFileChanges) {
          throw new Error(language === 'zh' ? '缺少可用的文件快照或桌面恢复接口。' : 'No usable file snapshot or desktop restore API is available.');
        }
        const write = async (item: typeof changes[number], reverse: boolean) => reverse
          ? (await desktop.revertFileChanges(root, item.files)).revertedFiles
          : (await desktop.restoreFileChanges(root, item.files)).restoredFiles;
        const applied: typeof changes = [];
        let count = 0;
        try {
          for (const item of changes) {
            count += await write(item, reverted);
            applied.push(item);
          }
        } catch (caught) {
          const failures: string[] = [];
          for (const item of applied.reverse()) {
            try { await write(item, !reverted); }
            catch (rollbackError) {
              markCompleted([item.report], true);
              failures.push(errorMessage(rollbackError));
            }
          }
          if (failures.length) throw new Error(errorMessage(caught) + '\n' + (language === 'zh'
            ? '部分文件无法回滚，请审查当前内容：' : 'Some files could not be rolled back; review their current contents: ') + failures.join('\n'));
          throw caught;
        }
        markCompleted(group, true);
        return count;
      };
      const applySnapshots = async (turnIds: string[]) => reverted
        ? (await revertSessionWorkspaceChanges(conversationId, turnIds)).revertedFiles
        : (await restoreSessionWorkspaceChanges(conversationId, turnIds)).restoredFiles;
      try {
        let changedFiles = 0;
        const allSnapshots = ordered.every(report => report.turnId?.trim()
          && !legacyRevertKeysRef.current.has(workspaceChangeKey(conversationId, report)));
        if (allSnapshots) {
          try {
            changedFiles = await applySnapshots([...new Set(ordered.map(report => report.turnId!.trim()))]);
            markCompleted(ordered, false);
          } catch (caught) {
            // A conflict or missing redo image must never turn into an unchecked diff fallback.
            if (!reverted || !snapshotRevertFallbackAllowed(caught)) throw caught;
            changedFiles += await applyLegacy(ordered);
          }
        } else {
          const completedKeys = new Set<string>();
          const legacyKeys = new Set(legacyRevertKeysRef.current);
          for (const report of ordered) {
            const key = workspaceChangeKey(conversationId, report);
            if (completedKeys.has(key)) continue;
            const group = ordered.filter(item => workspaceChangeKey(conversationId, item) === key);
            const turnId = report.turnId?.trim();
            if (!turnId || legacyKeys.has(key)) {
              changedFiles += await applyLegacy(group);
            } else {
              try {
                changedFiles += await applySnapshots([turnId]);
                markCompleted(group, false);
              } catch (caught) {
                if (!reverted || !snapshotRevertFallbackAllowed(caught)) throw caught;
                changedFiles += await applyLegacy(group);
              }
            }
            completedKeys.add(key);
          }
        }
        setChangeReviewNotice(language === 'zh'
          ? (reverted ? '已撤回 ' : '已取消撤回，恢复 ') + changedFiles + ' 个文件的修改。'
          : action + ' completed for ' + changedFiles + ' file(s).');
        if (root) await refreshProjectGitStatus(root);
      } catch (caught) {
        const message = action + (language === 'zh' ? '失败：' : ' failed: ') + workspaceRevertErrorMessage(caught, language);
        setChangeReviewNotice(message);
        window.alert(message);
      } finally {
        workspaceChangeBusyRef.current = false;
        setRevertingChangeId('');
      }
    }, [chat.conversations, chat.processingConversationIds, language, refreshProjectGitStatus],
  );
  const revertChangeReport = useCallback((conversationId: string, report: ConversationChangeReport) =>
    setChangeReportsReverted(conversationId, [report],
      !workspaceChangeReverted(revertedChangeStates, conversationId, report), report.id),
    [revertedChangeStates, setChangeReportsReverted]);
  const revertActiveConversationChangeReport = useCallback((report: ConversationChangeReport, message: ChatMessage) =>
    revertChangeReport(message.conversationId?.trim() || chat.activeConversationId, report),
    [chat.activeConversationId, revertChangeReport]);
  const openActiveConversationChangeReview = useCallback((filePath?: string) => {
    if (!chat.activeConversationId) return;
    openChangeReviewInspector(chat.activeConversationId, typeof filePath === 'string' ? filePath.trim() : '');
  }, [chat.activeConversationId, openChangeReviewInspector]);

  const openSettings = useCallback((
    targetSection: SettingsSection = 'profile',
    pluginTab: 'plugins' | 'skills' = 'plugins',
    agentId = '',
  ) => {
    setSettingsAgentId(agentId);
    setSettingsInitialSection(targetSection);
    setSettingsPluginTab(pluginTab);
    setSettingsMounted(true);
    setSettingsOpen(true);
  }, []);
  const markSettingsReady = useCallback(() => setSettingsReady(true), []);
  const settingsVisible = settingsOpen && settingsReady;

  useEffect(() => {
    const preloadTimer = window.setTimeout(() => {
      void loadSettingsViewModule().catch(() => undefined);
    }, 0);
    return () => window.clearTimeout(preloadTimer);
  }, []);

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
    if (nextSection === 'agents') closeInspector();
  }, [closeInspector]);
  const handleAgentSelect = useCallback((id: string, sessionId?: string, view?: 'chat' | 'settings') => {
    if (view === 'settings') { openSettings('models', 'plugins', id); return; }
    agents.select(id, sessionId, view); setSection('agents'); closeInspector(); if (compactLayout && (sessionId !== undefined || !id)) collapseSidebar();
  }, [agents.select, compactLayout, collapseSidebar, closeInspector, openSettings]);
  useEffect(() => {
    const open = (event: Event) => {
      const target = (event as CustomEvent<AgentConversationTarget>).detail;
      if (target && agents.connections.some(connection => connection.id === target.connectionId) && target.sessionId) handleAgentSelect(target.connectionId, target.sessionId);
    };
    window.addEventListener(OPEN_AGENT_CONVERSATION, open);
    return () => window.removeEventListener(OPEN_AGENT_CONVERSATION, open);
  }, [agents.connections, handleAgentSelect]);
  const handleSidebarConversationChange = useCallback((conversationId: string) => {
    openConversation(conversationId);
    if (compactLayout) collapseSidebar();
  }, [openConversation, compactLayout, collapseSidebar]);
  const handleSidebarCreateConversation = useCallback(() => {
    createConversation();
  }, [createConversation]);
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
    if (compactLayout) collapseSidebar();
  }, [openChangeReviewInspector, compactLayout, collapseSidebar]);
  const handleSidebarOpenSettings = useCallback(() => {
    openSettings('profile', 'plugins', section === 'agents' ? agents.selectedId : '');
  }, [openSettings, section, agents.selectedId]);
  const handleSidebarOpenPlugins = useCallback(() => setSection('plugins'), []);
  const handleSearchOpenConversation = useCallback((conversationId: string) => {
    setSettingsOpen(false);
    openConversation(conversationId);
  }, [openConversation]);
  const handlePreviousConversation = useCallback((conversationId: string) => {
    setSettingsOpen(false);
    chat.openConversation(conversationId);
    setSection('chat');
    setConversationPromptFocus(value => value + 1);
  }, [chat.openConversation]);
  const conversationNavigation = usePreviousConversationShortcut({
    activeConversationId: chat.activeConversationId,
    conversations: chat.conversations,
    preparedConversations: chat.preparedConversations,
    enabled: section === 'chat' && !settingsOpen && !conversationSearch.open,
    onOpenConversation: handlePreviousConversation,
  });
  const handleSearchCreateConversation = useCallback(() => {
    setSettingsOpen(false);
    createConversation();
  }, [createConversation]);
  const handleSearchOpenFiles = useCallback(() => {
    setSettingsOpen(false);
    void openInspectorFiles();
  }, [openInspectorFiles]);
  const handleSearchAddProject = useCallback(() => {
    setSettingsOpen(false);
    void addProject();
  }, [addProject]);

  const toggleSidebar = () => setSidebarCollapsed(collapsed => !collapsed);
  const windowMenus = applicationMenus(language, {
    newConversation: () => { handleSearchCreateConversation(); setConversationPromptFocus(value => value + 1); },
    openProject: window.cardbushDesktop?.pickProjectDirectory ? handleSearchAddProject : undefined,
    openFiles: window.cardbushDesktop?.pickAttachments ? handleSearchOpenFiles : undefined,
    openSettings: () => openSettings('profile'),
    showShortcuts: () => openSettings('shortcuts'),
    openDiagnostics: () => openSettings('diagnostics'),
    toggleSidebar,
    toggleInspector: () => {
      if (settingsOpen) { setSettingsOpen(false); setInspectorOpen(true); }
      else toggleInspector();
    },
    search: conversationSearch.show,
    openBrowser: () => { setSettingsOpen(false); openNewBrowserInspectorTab(); },
    focusBrowserAddress: !settingsOpen && inspectorOpen && displayedInspectorTarget &&
      isInspectorBrowserTarget(displayedInspectorTarget.target, displayedInspectorTarget.mediaType)
      ? () => { inspectorAddressRef.current?.focus(); inspectorAddressRef.current?.select(); } : undefined,
    reloadBrowser: !settingsOpen && inspectorOpen && displayedInspectorTarget && activeInspectorNavigation &&
      inspectorWebviewRefs.current.has(activeInspectorTabIdentity)
      ? () => inspectorWebviewRefs.current.get(activeInspectorTabIdentity)?.reload() : undefined,
    openReview: inspectorReviewAvailable ? () => { setSettingsOpen(false); openChangeReviewInspector(chat.activeConversationId); } : undefined,
    openHistory: section === 'chat' && chat.activeConversationId
      ? () => { setSettingsOpen(false); openWorkSummaryTab({ kind: 'turn-history', sessionId: chat.activeConversationId }); } : undefined,
    openShadow: inspectorShadowAvailable ? () => { setSettingsOpen(false); openShadowInspectorTab(); } : undefined,
    previousConversation: conversationNavigation.canGoPrevious ? conversationNavigation.previous : undefined,
    back: conversationNavigation.canGoBack ? conversationNavigation.goBack : undefined,
    forward: conversationNavigation.canGoForward ? conversationNavigation.goForward : undefined,
    openTeam: backendCapabilities.teamMode ? () => { setSettingsOpen(false); setSection('team'); } : undefined,
  }, { sidebarVisible: !sidebarCollapsed, inspectorVisible: inspectorOpen && !settingsOpen,
    native: Boolean(window.cardbushDesktop?.executeWindowMenuAction), externalLinks: Boolean(window.cardbushDesktop?.openExternal) });

  return (
    <WorkspaceChangeStateContext.Provider value={workspaceChangeState}>
    <ConversationExtractionProvider activeSessionId={chat.activeConversationId} language={language}
      contextWindowTokens={appSettings.managedModelConfigs.find(config => config.id === chat.selectedModel)?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS}
      onOpen={handlePreviousConversation} onFork={async sessionId => {
        const fork = await forkConversation(sessionId);
        await chat.reloadConversations();
        handlePreviousConversation(fork.id);
      }}>
    <ImageGalleryProvider sessionId={chat.activeConversationId} messages={chat.activeMessages}
      workspaceRoot={activeProjectDir} pathAliases={activeProjectPathAliases} language={language}>
    <div
      className={`app ${themeClassNames(theme)}`}
      lang={language}
      style={appStyle}
    >
      <WindowFrame
        language={language}
        sidebarCollapsed={sidebarCollapsed}
        onToggleSidebar={toggleSidebar}
        menus={windowMenus}
        onBack={conversationNavigation.canGoBack ? conversationNavigation.goBack : undefined}
        onForward={conversationNavigation.canGoForward ? conversationNavigation.goForward : undefined}
        onError={error => { void showUiError(language === 'zh' ? '操作失败' : 'Action failed', errorMessage(error)); }}
      />
      {conversationSearch.open && <ConversationSearchDialog
        language={language}
        conversations={chat.conversations}
        projects={projectItems}
        runningConversationIds={chat.processingConversationIds}
        onClose={conversationSearch.close}
        onOpenConversation={handleSearchOpenConversation}
        onCreateConversation={handleSearchCreateConversation}
        onAddProject={window.cardbushDesktop?.pickProjectDirectory ? handleSearchAddProject : undefined}
        onOpenFiles={window.cardbushDesktop?.pickAttachments ? handleSearchOpenFiles : undefined}
      />}
      {settingsMounted && (
        <Suspense fallback={null}>
          <LazySettingsView
            agentConnections={agents.connections} agentId={settingsAgentId} onAgentChange={setSettingsAgentId}
            onOpenPluginPrompt={openPluginPrompt}
            active={settingsVisible}
            onReady={markSettingsReady}
            themePreference={themePreference}
            windowMaterial={windowMaterial}
            onWindowMaterialChange={setWindowMaterial}
            language={language}
            languageMode={languageMode}
            systemLanguage={systemLanguage}
            settings={appSettings}
            selectedModel={chat.selectedModel}
            availableModels={availableModels}
            backendCapabilities={backendCapabilities}
            conversations={chat.conversations}
            projects={projectItems}
            onRestoreProjects={ids => {
              const restoredIds = new Set(ids);
              setProjectItems(current => current.map(project =>
                restoredIds.has(project.id) ? { ...project, archived: false } : project));
            }}
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
            sidebarCollapsed={sidebarCollapsed}
            compactLayout={compactLayout}
            sidebarPresence={sidebarPresence}
            sidebarWidth={sidebarWidth}
            onSidebarCollapse={collapseSidebar}
            onSidebarWidthChange={setSidebarWidth}
            onConversationHistoryCleared={() => chat.reloadConversations()}
            onRuntimeAssetsReloaded={reloadRuntimeAssetConfiguration}
            onToggleSkill={toggleSkillEnabled}
            onReloadSkills={chat.reloadSkills}
            onLoadSkillDetail={chat.loadSkillDetail}
            visualInputAvailable={visualInputAvailable}
            visualInputEnabled={visualInputEnabledSetting}
            onVisualInputEnabledChange={setVisualInputEnabled}
          />
        </Suspense>
      )}
      <ConversationInspectorContext.Provider value={{ open: openConversationInspector, close: closeInspectorTab, outlets: conversationInspectorOutlets, visible: inspectorOpen }}>
      <main
        className={`desktop-shell${sidebarCollapsed ? ' sidebar-is-collapsed' : ''}${settingsVisible ? ' app-content-suspended' : ''}${windowMaximized ? ' window-maximized' : ' window-restored'}`}
        aria-hidden={settingsVisible}
        inert={settingsVisible ? true : undefined}
      >
          <CompactSidebarBackdrop visible={compactLayout && !sidebarCollapsed} language={language} onClose={collapseSidebar} />
          {sidebarPresence.mounted && (
            <>
              {section === 'team' ? (
                <RuntimeDelegationSurface slot="sidebar"
                  language={language}
                  onBack={() => setSection('chat')}
                  onOpenSettings={() => openSettings('profile')}
                  softVisible={sidebarPresence.visible}
                />
              ) : (
                <ChatSidebar
                  agents={agents.connections}
                  activeAgentId={agents.selectedId}
                  onAgentSelect={handleAgentSelect}
                  agentSessions={agents}
                  language={language}
                  section={section}
                  activeConversationId={section === 'agents' ? '' : chat.activeConversationId}
                  runningConversationIds={chat.processingConversationIds}
                  onConversationWorkspaceChange={(conversationId, project) => chat.setConversationProject(conversationId, project?.rootPath ?? null, project?.id ?? null)}
                  attentionByConversation={chat.attentionByConversation}
                  projects={projectItems}
                  conversations={chat.conversations}
                  changeReportsByConversation={sidebarChangeReportsByConversation}
                  onSectionChange={handleSidebarSectionChange}
                  onConversationChange={handleSidebarConversationChange}
                  onCreateConversation={handleSidebarCreateConversation}
                  onAddProject={handleSidebarAddProject}
                  onProjectAction={handleSidebarProjectAction}
                  onDeleteConversation={chat.deleteConversation}
                  onRenameConversation={chat.renameConversation}
                  onOpenConversationChanges={handleSidebarOpenConversationChanges}
                  onOpenSettings={handleSidebarOpenSettings}
                  onOpenArchives={() => openSettings('cache')}
                  onOpenPlugins={handleSidebarOpenPlugins}
                  onOpenSearch={conversationSearch.show}
                  softVisible={sidebarPresence.visible}
                />
              )}
              <SidebarResizer
                language={language}
                width={sidebarWidth}
                onWidthChange={setSidebarWidth}
                onCollapse={collapseSidebar}
                softVisible={sidebarPresence.visible && !settingsVisible}
              />
            </>
          )}
          <section className="main-stage" inert={compactLayout && (!sidebarCollapsed || inspectorOpen) ? true : undefined}>
            {section === 'agents' ? (
              <Suspense fallback={<FeaturePanelLoading language={language} />}><LazyAgentsView visualInputEnabled={visualInputEnabledSetting} onOpenSettings={(id, section) => openSettings(section, 'plugins', id)} language={language} agents={agents} theme={theme} sidebarCollapsed={sidebarCollapsed} windowMaximized={windowMaximized} thinkingVisible={appSettings.thinking.visible} guidanceDeliveryMode={appSettings.guidance.deliveryMode} /></Suspense>
            ) : section === 'chat' ? (
              <ChatPanel
                browserTabs={composerBrowserTabs}
                language={language}
                theme={theme}
                title={chat.activeConversation?.title ?? 'cardbush'}
                sidebarCollapsed={sidebarCollapsed}
                windowMaximized={windowMaximized}
                inspectorOpen={inspectorOpen}
                onToggleInspector={toggleInspector}
                activeConversationId={chat.activeConversationId}
                activeProjectDir={activeProjectDir}
                projectPathAliases={activeProjectPathAliases}
                selectedProjectDir={activeConversationProjectDir}
                availableProjects={projectItems.filter((project) => !project.archived && !project.missing)}
                onWelcomeProjectChange={changeWelcomeProject}
                messages={chat.activeMessages}
                activeGoal={chat.activeGoal}
                teamAvailable={backendCapabilities.teamMode}
                goalAvailable={chat.goalAvailable}
                goalCancelling={chat.activeGoalCancelling}
                goalWaiting={chat.activeGoalWaiting}
                changeReports={
                  changeReportsByConversation[chat.activeConversationId] ?? []
                }
                skills={chat.skills}
                disabledSkillNames={disabledSkillNames}
                turnHistoryAvailable={backendCapabilities.sessionTurnHistory}
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
                historyLoading={chat.messagesLoading}
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
                )?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS}
                contextWindowUsage={chat.activeContextWindowUsage}
                availableModels={availableModels}
                referencePlanAvailable={backendCapabilities.taskPlan}
                referencePlanMode={chat.referencePlanMode}
                permissionMode={chat.permissionMode}
                subagentPermissionRouting={chat.subagentPermissionRouting}
                reasoningLevelAvailable={backendCapabilities.reasoningLevelSelection}
                reasoningLevel={chat.reasoningLevel}
                reasoningLevels={backendCapabilities.reasoningLevels}
                onModelChange={chat.setSelectedModel}
                onReferencePlanModeChange={chat.setReferencePlanMode}
                onPermissionModeChange={chat.setPermissionMode}
                onSubagentPermissionRoutingChange={chat.setSubagentPermissionRouting}
                onReasoningLevelChange={chat.setReasoningLevel}
                onConfigureModels={() => openSettings('models')}
                onCreateConversation={handleSidebarCreateConversation}
                onOpenConversation={openConversation}
                onToggleSkill={toggleSkillEnabled}
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
                backendCapabilities={backendCapabilities}
                onOpenPluginPrompt={openPluginPrompt}
                onCreateAutomation={createAutomationConversation}
                inspectorOpen={inspectorOpen}
                onToggleInspector={toggleInspector}
                section={section}
                activeProjectDir={activeProjectDir}
                workflowValidationAvailable={backendCapabilities.teamWorkflows}
                skills={chat.skills}
                disabledSkillNames={disabledSkillNames}
                onToggleSkill={toggleSkillEnabled}
                onReloadSkills={chat.reloadSkills}
                onLoadSkillDetail={chat.loadSkillDetail}
                onOpenConversation={openAutomationConversation}
              />
            )}
          </section>
          {inspectorPresence.mounted ? (
            <aside
              id="right-inspector"
              className={`right-inspector soft-panel-motion ${inspectorPresence.visible ? 'soft-panel-visible' : 'soft-panel-hidden'}`}
              aria-label={language === 'zh' ? '右侧检查器' : 'Inspector'}
              aria-hidden={!inspectorPresence.visible}
              inert={!inspectorPresence.visible || (compactLayout && !sidebarCollapsed) ? true : undefined}
              style={{ '--right-inspector-width': `${inspectorWidth}px` } as CSSProperties}
            >
              <RightInspectorResizer
                width={inspectorWidth}
                windowMaximized={windowMaximized}
                onWidthChange={setInspectorWidth}
                onCollapse={closeInspector}
                softVisible={inspectorPresence.visible}
                label={language === 'zh' ? '拖动调整右侧栏宽度，靠近右边缘收起' : 'Drag to resize; move toward the right edge to collapse'}
              />
              <div className="right-inspector-viewport">
              <div className="right-inspector-content">
              <header className={`right-inspector-toolbar${
                displayedInspectorTab && displayedInspectorTabs.length > 0 ? ' with-tabs' : ''
              }`}>
                {displayedInspectorTab && displayedInspectorTabs.length > 0 ? (
                  <>
                    <div className="right-inspector-tab-strip">
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
                              : tab.kind === 'conversation' ? label : tab.kind === 'automation' ? `${label} · ${tab.runId}` : tab.kind === 'shadow'
                                ? tab.context.title
                                : `${label} · ${tab.detail.sessionId}`;
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
                                  ? isInspectorBrowserTarget(tab.detail.target, tab.detail.mediaType)
                                    ? <Globe2 size={13} aria-hidden="true" />
                                    : <FileText size={13} aria-hidden="true" />
                                  : tab.kind === 'review' || tab.kind === 'conversation'
                                    ? <Clipboard size={13} aria-hidden="true" />
                                    : tab.kind === 'history' || tab.kind === 'automation'
                                      ? <Clock3 size={13} aria-hidden="true" />
                                      : tab.kind === 'subagent'
                                        ? <Bot size={13} aria-hidden="true" />
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
                                    role="menuitemradio"
                                    aria-checked={active}
                                    title={label}
                                    onClick={() => activateInspectorTab(tab)}
                                  >
                                    {tab.kind === 'resource'
                                      ? isInspectorBrowserTarget(tab.detail.target, tab.detail.mediaType)
                                        ? <Globe2 size={14} aria-hidden="true" />
                                        : <FileText size={14} aria-hidden="true" />
                                      : tab.kind === 'review' || tab.kind === 'conversation'
                                        ? <Clipboard size={14} aria-hidden="true" />
                                        : tab.kind === 'history' || tab.kind === 'automation'
                                          ? <Clock3 size={14} aria-hidden="true" />
                                          : tab.kind === 'subagent'
                                            ? <Bot size={14} aria-hidden="true" />
                                            : <ShadowCloneIcon size={14} />}
                                    <span>{label}</span>
                                  </button>
                                  <button
                                    type="button"
                                    role="menuitem"
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
                        <InspectorActions {...inspectorActionProps} menu />
                      )}
                    </div>
                  </>
                ) : (
                  <strong />
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
                  aria-label={language === 'zh' ? '关闭右侧栏' : 'Close inspector'}
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
                  {isInspectorBrowserTarget(displayedInspectorTarget.target, displayedInspectorTarget.mediaType) ? (
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
                        ref={inspectorAddressRef}
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
                {inspectorMenuOpen && (
                  // Guest webview pointer events do not bubble into the app document.
                  <div className="inspector-menu-dismiss-layer" aria-hidden="true"
                    onPointerDown={dismissInspectorMenus}
                    onContextMenu={(event) => { event.preventDefault(); dismissInspectorMenus(); }} />
                )}
                {displayedInspectorTab ? (
                  <InspectorTabPages tabs={displayedInspectorTabs} activeId={activeInspectorTabIdentity}>
                    {(tab, active) => {
                      const displayedReviewConversation = tab.kind === 'review'
                        ? reviewConversationsById.get(tab.conversationId)
                        : null;
                      const displayedReviewReports = tab.kind === 'review'
                        ? changeReportsByConversation[tab.conversationId] ?? []
                        : [];
                      return (
                        <>
                          {tab.kind === 'resource' ? (
                            <InspectorWebview
                              ref={(handle) => {
                                if (handle) inspectorWebviewRefs.current.set(tab.id, handle);
                                else inspectorWebviewRefs.current.delete(tab.id);
                              }}
                              identity={tab.id}
                              target={tab.detail.target}
                              source={inspectorSource(tab.detail.target)}
                              mediaType={tab.detail.mediaType}
                              title={tab.detail.title}
                              language={language}
                              onNavigationStateChange={updateInspectorNavigation}
                              onOpenTarget={openInspectorTarget}
                            />
                          ) : tab.kind === 'conversation' ? (
                            <ConversationInspectorOutlet id={tab.id} register={registerConversationInspectorOutlet} />
                          ) : tab.kind === 'shadow' ? (
                            <ShadowWindow embedded context={tab.context} />
                          ) : tab.kind === 'automation' ? (
                            <AutomationRunPanel jobId={tab.jobId} runId={tab.runId} language={language} active={active && inspectorPresence.visible} onOpenConversation={openAutomationConversation}/>
                          ) : tab.kind === 'history' || tab.kind === 'subagent' ? (
                            <WorkSummaryInspector
                              detail={tab.detail}
                              messages={chat.messagesByConversation[tab.detail.sessionId] ?? []}
                              language={language}
                              active={active && inspectorPresence.visible}
                            />
                          ) : displayedReviewConversation ? (
                            <ConversationChangeDialog
                              embedded
                              workspaceControls={<TaskWorkspaceBar
                                key={`${displayedReviewConversation.id}:${conversationProjectRoot(displayedReviewConversation)}`}
                                sessionId={displayedReviewConversation.id}
                                projectDir={conversationProjectRoot(displayedReviewConversation)}
                                language={language}
                                busy={chat.processingConversationIds.has(displayedReviewConversation.id)}
                                gitAvailable={backendCapabilities.git}
                                revisionKey={displayedReviewConversation.updatedAt}
                                onChanged={refreshBackendAndActiveSession}
                              />}
                              language={language}
                              conversation={displayedReviewConversation}
                              reports={displayedReviewReports}
                              reviewComments={reviewCommentsByConversation[displayedReviewConversation.id] ?? emptyReviewComments}
                              onReviewCommentsChange={update => {
                                const sessionId = displayedReviewConversation.id;
                                setReviewCommentsByConversation(current => ({ ...current,
                                  [sessionId]: typeof update === 'function' ? update(current[sessionId] ?? emptyReviewComments) : update,
                                }));
                              }}
                              onComposeReviewComments={comments => {
                                const sessionId = displayedReviewConversation.id;
                                setDraftsByConversation(current => ({ ...current,
                                  [sessionId]: appendReviewCommentsToDraft(current[sessionId] ?? '', comments, language),
                                }));
                                chat.openConversation(sessionId);
                                setSection('chat');
                                setSettingsOpen(false);
                                setConversationPromptFocus(value => value + 1);
                              }}
                              turns={recentReviewTurns(chat.messagesByConversation[displayedReviewConversation.id] ?? [])}
                              initialFilePath={tab.initialFilePath}
                              selectionRequestId={tab.selectionRequestId}
                              notice={changeReviewNotice}
                              revertingChangeId={revertingChangeId}
                              revertedChangeIds={new Set(
                                displayedReviewReports
                                  .filter((report) => workspaceChangeReverted(revertedChangeStates, displayedReviewConversation.id, report))
                                  .map((report) => report.id),
                              )}
                              onClose={() => closeInspectorTab(tab.id)}
                              onRevert={(report) => revertChangeReport(
                                displayedReviewConversation.id,
                                report,
                              )}
                              revertAvailable={!chat.processingConversationIds.has(
                                displayedReviewConversation.id,
                              )}
                            />
                          ) : null}
                        </>
                      );
                    }}
                  </InspectorTabPages>
                ) : (
                  <div className="right-inspector-start">
                    <InspectorActions {...inspectorActionProps} />
                  </div>
                )}
              </div>
              </div>
              </div>
            </aside>
          ) : null}
      </main>
      </ConversationInspectorContext.Provider>
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
      <McpUserRequests language={language} />
    </div>
    </ImageGalleryProvider>
    </ConversationExtractionProvider>
    </WorkspaceChangeStateContext.Provider>
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
  window.localStorage.removeItem('cardbush_light_theme_style');
  if (
    stored === 'system' ||
    stored === 'light' ||
    stored === 'dark' ||
    stored === 'cyberpunk'
  ) {
    return stored;
  }
  if (stored === 'custom' && readImportedThemeStyle()) {
    return 'custom';
  }
  // Retired or invalid selections fall back without reviving a stale legacy value.
  if (stored) return 'system';
  const legacy = window.localStorage.getItem('cardbush.theme');
  if (legacy === 'dark') {
    return 'dark';
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
  return `project-${rootPath.startsWith('ssh://') ? rootPath : rootPath.replaceAll('\\', '/').toLowerCase()}`;
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
  if (preference === 'dark') {
    return 'dark';
  }
  if (preference === 'light') {
    return 'bright';
  }
  return prefersDark ? 'dark' : 'bright';
}

function resolveAppLanguage(mode: AppLanguageMode, systemLanguage: AppLanguage) {
  return mode === 'system' ? systemLanguage : mode;
}

function readInitialAppSettings(): AppSettingsState {
  return normalizeAppSettings({
    conversationStyle: readConversationStyle(),
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
    conversationStyle: normalizeConversationStyle(settings.conversationStyle),
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
  return normalizeHostTerminalRuntime(value);
}

function persistAppSettings(settings: AppSettingsState) {
  saveConversationStyle(settings.conversationStyle);
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
  const detail = errorMessage(error);
  if (/current revision no longer matches|changed after this (?:Turn|revert)/i.test(detail)) {
    return language === 'zh' ? '文件有后续修改，已保留当前内容。请先审查差异后再试。' : 'Files have later edits. Your current content was preserved; review the differences before retrying.';
  }
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
  backendCapabilities,
  onOpenPluginPrompt,
  section,
  activeProjectDir,
  workflowValidationAvailable,
  inspectorOpen,
  onToggleInspector,
  skills,
  disabledSkillNames,
  onToggleSkill,
  onReloadSkills,
  onLoadSkillDetail,
  onCreateAutomation,
  onOpenConversation,
}: {
  language: AppLanguage;
  backendCapabilities: BackendCapabilities;
  onOpenPluginPrompt: (prompt: string) => void;
  section: AppSection;
  activeProjectDir?: string;
  workflowValidationAvailable: boolean;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  skills: SkillSummary[];
  disabledSkillNames: Set<string>;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  onReloadSkills: () => Promise<SkillSummary[]>;
  onLoadSkillDetail: (skillName: string) => Promise<SkillDetail>;
  onCreateAutomation: () => void;
  onOpenConversation: (conversationId: string) => void;
}) {
  const teamWorkspace = useRuntimeDelegationWorkspace();
  const label = section === 'team' ? teamWorkspace.title || sectionLabels[section][language] : sectionLabels[section][language];
  return (
    <div className="feature-panel">
      <TopBar
        title={label}
        language={language}
        inspectorOpen={inspectorOpen}
        onToggleInspector={onToggleInspector}
      />
      <Suspense fallback={<FeaturePanelLoading language={language} />}>
        <LazyFeatureContentPanel
          language={language}
          backendCapabilities={backendCapabilities}
          onOpenPluginPrompt={onOpenPluginPrompt}
          section={section}
          activeProjectDir={activeProjectDir}
          workflowValidationAvailable={workflowValidationAvailable}
          skills={skills}
          disabledSkillNames={disabledSkillNames}
          onToggleSkill={onToggleSkill}
          onReloadSkills={onReloadSkills}
          onLoadSkillDetail={onLoadSkillDetail}
          onCreateAutomation={onCreateAutomation}
          onOpenConversation={onOpenConversation}
        />
      </Suspense>
    </div>
  );
}
import { TaskWorkspaceBar } from './features/chat/TaskWorkspaceBar';
import { OPEN_AGENT_CONVERSATION, type AgentConversationTarget } from './features/agents/agentNavigation';
