import {
  AlertCircle,
  Archive,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Bot,
  CheckCircle2,
  Check,
  ChevronDown,
  ChevronsLeft,
  Circle,
  Clipboard,
  Clock3,
  Code2,
  Edit3,
  ExternalLink,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  Cpu,
  GitBranch,
  LoaderCircle,
  Menu,
  MessageSquare,
  Monitor,
  MoreHorizontal,
  Music2,
  Network,
  Paperclip,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Pin,
  Play,
  Plus,
  Puzzle,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  Smartphone,
  Sparkles,
  Terminal,
  ThumbsDown,
  ThumbsUp,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type { Terminal as XTermInstance } from '@xterm/xterm';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import {
  Component,
  type CSSProperties,
  type ErrorInfo,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type UIEvent,
  type WheelEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  backendBearerTokenStorageKey,
  backendLocalRequestKeyStorageKey,
  dispatchSubagent,
  fetchProjectContext,
  fetchSessionScene,
  fetchSessionScenes,
  saveProjectContext,
  sendSceneEvent,
  type SessionSceneRecord,
  type SessionShareLinkResult,
  type SubagentDispatchResult,
} from './backend/api';
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
import {
  COPY_FEEDBACK_EVENT,
  copyText,
  readAssistantFeedback,
  recordAssistantFeedback,
  type AssistantFeedbackRating,
} from './features/messageFeedback';
import {
  isImagePath,
  splitMessageImages,
  stripWrappingQuotes,
} from './features/messageImages';
import {
  displayToolName,
  isToolRunning,
  isToolRunningInContext,
  runningToolLabel,
} from './features/toolExecutionState';
import {
  changeReportsFromMessages,
  looksLikeFileChangeExecution,
  serializeToolChangeReport,
  toolChangeReportFromExecutions,
  type ConversationChangeReport,
  type ToolChangeReport,
} from './features/toolChangeReports';
import { ToolChangeBlock, ToolFileChangeView } from './features/ToolChangeBlock';
import { preserveScrollPositionForToggle } from './features/preserveScrollPosition';
import {
  PlanVerificationPanel,
  normalizeAssertionResults,
  planVerificationInfoFromExecution,
  type VerificationAssertionItem,
} from './features/PlanVerificationPanel';
import {
  SubagentAuditSignalsPanel,
  subagentAuditSignalsFromExecution,
} from './features/SubagentAuditSignalsPanel';
import {
  ToolActionEnvelopeInfo,
  toolActionEnvelopeFromExecution,
  type ToolActionEnvelope,
} from './features/ToolActionEnvelopeInfo';
import {
  PlanningAssessmentNotice,
  planningAssessmentFromExecution,
} from './features/PlanningAssessmentNotice';
import {
  RuntimeProfileBadge,
  WorkerProfileBadge,
  runtimeProfileInfoFromExecution,
} from './features/ToolProfileBadges';
import {
  ToolHookDecisionNotice,
  toolHookDecisionFromExecution,
} from './features/ToolHookDecisionNotice';
import {
  SubagentChildTools,
  subagentChildToolExecutions,
} from './features/SubagentChildTools';
import { LocalMusicPanel } from './features/LocalMusicPanel';
import { GameCodingPanel } from './features/GameCodingPanel';
import { SettingsView } from './features/SettingsView';
import { SubagentsPanel } from './features/SubagentsPanel';
import type {
  AppLanguage,
  AppLanguageMode,
  AppSection,
  AppSettingsState,
  CardlingDesktopAction,
  CardlingDesktopState,
  ChatMessage,
  ChatToolExecution,
  CompanionMotionMode,
  CompanionSettings,
  CompanionSize,
  CompanionStatus,
  ConversationSummary,
  BotPlatform,
  LightThemeStyle,
  ManagedModelConfig,
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

const sectionLabels: Record<AppSection, { zh: string; en: string }> = {
  chat: { zh: '对话', en: 'Chat' },
  search: { zh: '搜索', en: 'Search' },
  skills: { zh: '技能', en: 'Skills' },
  subagents: { zh: '子 Agent', en: 'Subagents' },
  gamecoding: { zh: 'Game Coding', en: 'Game Coding' },
};

const LazyMarkdownContent = lazy(async () => {
  const [{ default: ReactMarkdown }, { default: remarkGfm }] = await Promise.all([
    import('react-markdown'),
    import('remark-gfm'),
  ]);

  function MarkdownRenderer({ content }: { content: string }) {
    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children, ...props }) => (
            <a
              {...props}
              href={href}
              onClick={(event) => {
                if (!href || href.startsWith('#')) {
                  return;
                }
                event.preventDefault();
                void window.cardbushDesktop?.openExternal?.(href);
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {normalizeMarkdownContentForDisplay(content)}
      </ReactMarkdown>
    );
  }

  return { default: MarkdownRenderer };
});

function normalizeMarkdownContentForDisplay(content: string) {
  return content.replace(
    /^```(powershell|pwsh|bash|sh|shell|cmd)([^\s`\r\n][^\r\n]*\s+[^\r\n]*)$/gim,
    '```$1\n$2',
  );
}

type QuickLoadPayload = {
  kind: 'text' | 'file' | 'folder';
  title: string;
  value: string;
};

type CardlingScenePlacement = 'top' | 'right' | 'bottom' | 'left';
type CardlingSceneMood = 'explain' | 'ask' | 'confirm' | 'warn' | 'celebrate';

type CardlingSceneAnchor = {
  nodeId?: string;
  selector?: string;
  placement: CardlingScenePlacement;
  offset: { x: number; y: number };
};

type CardlingScene = {
  sceneId: string;
  title: string;
  html: string;
  sourceExecutionId?: string;
  sessionId?: string;
  turnId?: string;
  cardling: {
    mode: 'embedded' | 'floating';
    speech: string;
    mood: CardlingSceneMood;
    anchor?: CardlingSceneAnchor;
    position?: string | { x: number; y: number };
  };
  nodes: Array<{
    nodeId: string;
    label?: string;
    purpose?: string;
  }>;
  expectedUserAction?: {
    type?: string;
    required?: boolean;
  };
  raw: Record<string, unknown>;
};

type CardlingSceneStep = {
  id: string;
  nodeId?: string;
  title?: string;
  speech: string;
  holdMs: number;
};

type CardlingSceneFeedback = {
  id: string;
  nodeId: string;
  stepId?: string;
  nodeLabel: string;
  text: string;
  createdAt: string;
};

type SceneRuntimeEventType =
  | 'scene_ready'
  | 'scene_health'
  | 'scene_error'
  | 'node_click'
  | 'node_drag_start'
  | 'node_drag_end'
  | 'node_reorder'
  | 'selection_change'
  | 'state_change'
  | 'route_update'
  | 'request_llm_action'
  | 'scene_toast'
  | 'form_submit'
  | 'external_url'
  | 'confirm'
  | 'cancel';

type SceneOpenTarget = {
  kind: 'url' | 'path';
  target: string;
  label?: string;
};

type SceneRuntimeNodeState = {
  nodeId: string;
  label?: string;
  status?: string;
  order: number;
  values: Record<string, string>;
};

type SceneRuntimeEdgeState = {
  from: string;
  to: string;
  status?: string;
};

type SceneRuntimeUserEvent = {
  id: string;
  type: SceneRuntimeEventType | string;
  nodeId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

type SceneRuntimeState = {
  selectedNodeId?: string;
  nodes: SceneRuntimeNodeState[];
  edges: SceneRuntimeEdgeState[];
  userEvents: SceneRuntimeUserEvent[];
  updatedAt: string;
};

type SceneHealthIssue = {
  code: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
};

type SceneHealthReport = {
  ok: boolean;
  checkedAt: string;
  renderedNodeCount: number;
  declaredNodeCount: number;
  missingNodeIds: string[];
  placeholderCount: number;
  blank: boolean;
  scriptErrors: string[];
  issues: SceneHealthIssue[];
};

const sceneRuntimeEventTypes = new Set<string>([
  'node_drag_start',
  'node_drag_end',
  'node_reorder',
  'selection_change',
  'state_change',
  'route_update',
  'request_llm_action',
  'scene_toast',
]);

type SceneEventStatus = 'idle' | 'sending' | 'continuing' | 'recorded' | 'failed';
type SceneEventDelivery = 'guidance' | 'recorded' | '';

type SceneAnchorRect = {
  nodeId: string;
  rect: { left: number; top: number; width: number; height: number };
  tone?: 'dark' | 'light';
};

type ProjectEntry = {
  name: string;
  path: string;
  kind: 'file' | 'folder';
};

type ProjectFileSearchResult = ProjectEntry & {
  relativePath: string;
};

type ConsoleMode = 'git' | 'terminal';

type GitInfo = {
  branch: string;
  root: string;
  changedFiles: Array<{ path: string; status: string }>;
  missing?: boolean;
  error?: string;
};

type TerminalSessionInfo = {
  id: string;
  cwd: string;
  shell: string;
};

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

type GuidanceMode = 'append_context' | 'interrupt_and_continue';

type CardlingPosition = {
  right: number;
  bottom: number;
};

type ComposerImageAttachment = {
  id: string;
  path: string;
  name: string;
  previewUrl: string;
};

type ImagePreview = {
  src: string;
  name: string;
  path?: string;
};

type ComposerMenu =
  | 'project'
  | 'tokens'
  | 'git'
  | 'skills'
  | 'runtime'
  | 'models'
  | null;

type ComposerCommandMode = 'slash' | 'mention';

type ComposerCommandState = {
  mode: ComposerCommandMode;
  start: number;
  end: number;
  query: string;
};

type ComposerCommandItem = {
  id: string;
  title: string;
  subtitle: string;
  icon: ReactNode;
  value?: string;
  run?: () => void | Promise<void>;
  searchText?: string;
};

type ModelIntelligence = 'low' | 'medium' | 'high' | 'xhigh';
type ModelSpeedMode = 'auto' | 'fast' | 'balanced';

type QuickSideItem = {
  id: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  payload?: QuickLoadPayload;
  jumpTarget?: QuickJumpTarget;
};

type QuickJumpTarget =
  | { kind: 'conversation'; conversationId: string }
  | { kind: 'message'; messageId: string }
  | { kind: 'path'; path: string };

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
    mode: 'manual',
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

type ProjectAction =
  | 'pin'
  | 'open'
  | 'refreshGit'
  | 'newChat'
  | 'rename'
  | 'archive'
  | 'remove';

const sidebarMenuCloseEvent = 'cardbush-sidebar-menu-close';

type SidebarContextMenuItem = {
  key: string;
  icon: ReactNode;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  children?: SidebarContextMenuItem[];
  onClick?: () => void;
};

type SidebarContextMenuState = {
  id: string;
  x: number;
  y: number;
  items: SidebarContextMenuItem[];
};

type ConversationMenuOptions = {
  changeCount: number;
  onOpenChanges?: () => void;
  onRename: () => void;
  onArchive: () => void;
  onDelete: () => void;
};

function sidebarContextMenuPosition(clientX: number, clientY: number, itemCount: number) {
  const menuWidth = 210;
  const menuHeight = Math.min(340, Math.max(1, itemCount) * 34 + 12);
  const padding = 8;
  return {
    x: Math.max(padding, Math.min(clientX, window.innerWidth - menuWidth - padding)),
    y: Math.max(padding, Math.min(clientY, window.innerHeight - menuHeight - padding)),
  };
}

function basename(value: string) {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
  return normalized.split('/').pop() || value;
}

function samePath(left: string, right: string) {
  return left.replaceAll('\\', '/').toLowerCase() ===
    right.replaceAll('\\', '/').toLowerCase();
}

function compactPath(value?: string) {
  if (!value) {
    return '~';
  }
  const parts = value.replaceAll('\\', '/').split('/').filter(Boolean);
  if (parts.length <= 2) {
    return value;
  }
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

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
  const chat = useCardbushChat(appSettings.managedModelConfigs, availableModels, {
    projectContexts,
    disabledSkillNames,
  });
  const activeProjectDir =
    conversationWorkspaceRoot(chat.activeConversation) || undefined;
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
  const [companionMoment, setCompanionMoment] = useState<'' | 'complete'>('');
  const previousSendingRef = useRef(false);
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
  const activeToolRunning = chat.sending &&
    chat.activeMessages.some((message) =>
      message.role === 'assistant' &&
      (message.toolExecutions ?? []).some(isToolRunning),
    );
  const activeChangeReports =
    changeReportsByConversation[chat.activeConversationId] ?? [];
  const activeChangeCount = activeChangeReports.length;
  const activeChangeFileCount = activeChangeReports.reduce(
    (sum, report) => sum + report.fileCount,
    0,
  );
  const companionStatus = companionStatusFromState({
    error: chat.error,
    pendingInteraction: chat.pendingInteraction,
    activeToolRunning,
    sending: chat.sending,
    queuedMessageCount: chat.queuedMessageCount,
    recentlyCompleted: companionMoment === 'complete',
  });
  const companionMiniChat = useMemo(() => {
    const latestUser = [...chat.activeMessages]
      .reverse()
      .find((message) => message.role === 'user' && message.content.trim());
    const latestAssistant = [...chat.activeMessages]
      .reverse()
      .find((message) => message.role === 'assistant' && message.content.trim());
    return {
      title: compactCompanionText(chat.activeConversation?.title ?? '', 72),
      lastUser: compactCompanionText(latestUser?.content ?? '', 140),
      lastAssistant: compactCompanionText(latestAssistant?.content ?? '', 300),
    };
  }, [chat.activeConversation?.title, chat.activeMessages]);
  const desktopCardlingAvailable = Boolean(window.cardbushDesktop?.setCardlingState);

  useEffect(() => {
    const wasSending = previousSendingRef.current;
    previousSendingRef.current = chat.sending;
    if (wasSending && !chat.sending && !chat.error) {
      setCompanionMoment('complete');
      const timer = window.setTimeout(() => setCompanionMoment(''), 3600);
      return () => window.clearTimeout(timer);
    }
    if (chat.sending || chat.error) {
      setCompanionMoment('');
    }
    return undefined;
  }, [chat.sending, chat.error, chat.activeConversationId]);

  useEffect(() => {
    const payload: CardlingDesktopState = {
      enabled: appSettings.companionEnabled,
      language,
      theme,
      settings: appSettings.companion,
      status: companionStatus,
      sending: chat.sending,
      queuedMessageCount: chat.queuedMessageCount,
      pendingInteraction: Boolean(chat.pendingInteraction),
      activeChangeCount,
      activeChangeFileCount,
      error: chat.error,
      miniChat: companionMiniChat,
    };
    void window.cardbushDesktop?.setCardlingState?.(payload);
  }, [
    activeChangeCount,
    activeChangeFileCount,
    appSettings.companion,
    appSettings.companionEnabled,
    chat.error,
    chat.pendingInteraction,
    chat.queuedMessageCount,
    chat.sending,
    companionMiniChat,
    companionStatus,
    desktopCardlingAvailable,
    language,
    theme,
  ]);

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
    return window.cardbushDesktop?.onCardlingAction?.((action: CardlingDesktopAction) => {
      if (typeof action === 'object' && action?.type === 'miniChatSend') {
        const text = action.text.trim();
        if (text) {
          void chat.sendMessage(text);
        }
        return;
      }
      if (action === 'settings') {
        openSettings('companion');
        return;
      }
      if (action === 'changes') {
        setChangeReviewConversationId(chat.activeConversationId);
        setChangeReviewNotice('');
        return;
      }
      if (action === 'revertChanges') {
        void revertConversationReports(chat.activeConversationId, activeChangeReports);
      }
    });
  }, [
    activeChangeReports,
    chat.activeConversationId,
    chat.sendMessage,
    openSettings,
    revertConversationReports,
  ]);

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

  return (
    <div
      className={`app theme-${theme}${customBackgroundImagePath ? ' has-custom-background' : ''}`}
      lang={language}
      style={appStyle}
    >
      <WindowFrame
        musicOpen={musicPanelOpen}
        onToggleMusic={() => setMusicPanelOpen((open) => !open)}
        onOpenBotSettings={() => openSettings('bots')}
        onOpenCacheSettings={() => openSettings('cache')}
      />
      {musicPanelOpen && (
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
          initialSection={settingsInitialSection}
          onBack={() => setSettingsOpen(false)}
          onThemePreferenceChange={setThemePreference}
          onLightThemeStyleChange={setLightThemeStyle}
          onLanguageModeChange={setLanguageMode}
          onSettingsChange={updateAppSettings}
          onUseModel={chat.setSelectedModel}
          onSidebarWidthChange={setSidebarWidth}
          onConversationHistoryCleared={() => chat.reloadConversations()}
        />
      ) : (
        <main className="desktop-shell">
          {!sidebarCollapsed && (
            <>
              <ChatSidebar
                language={language}
                section={section}
                activeConversationId={chat.activeConversationId}
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
                onCollapse={() => setSidebarCollapsed(true)}
                onOpenSettings={() => openSettings('profile')}
              />
              <SidebarResizer
                language={language}
                onWidthChange={setSidebarWidth}
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
                conversations={chat.conversations}
                activeConversationId={chat.activeConversationId}
                activeProjectDir={activeProjectDir}
                projectContext={projectContexts[projectContextKey(activeProjectDir)] ?? ''}
                messages={chat.activeMessages}
                skills={chat.skills}
                disabledSkillNames={disabledSkillNames}
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
                onModelChange={chat.setSelectedModel}
                onRuntimeProfileChange={chat.setSelectedRuntimeProfile}
                onReferencePlanModeChange={chat.setReferencePlanMode}
                onConfigureModels={() => openSettings('models')}
                onCreateConversation={() => createConversation(activeProjectDir)}
                onOpenConversation={chat.openConversation}
                onSaveProjectContext={saveActiveProjectContext}
                onToggleSkill={toggleSkillEnabled}
                onCreateSessionShareLink={chat.createSessionShareLink}
                onRefreshActiveSession={chat.refreshActiveSession}
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
      {!desktopCardlingAvailable && !settingsOpen && appSettings.companionEnabled && (
        <CardlingCompanion
          language={language}
          settings={appSettings.companion}
          status={companionStatus}
          sending={chat.sending}
          queuedMessageCount={chat.queuedMessageCount}
          pendingInteraction={chat.pendingInteraction}
          activeChangeCount={activeChangeCount}
          activeChangeFileCount={activeChangeFileCount}
          error={chat.error}
          onOpenSettings={() => openSettings('companion')}
          onOpenChanges={() => {
            setChangeReviewConversationId(chat.activeConversationId);
            setChangeReviewNotice('');
          }}
          onRevertChanges={() =>
            revertConversationReports(chat.activeConversationId, activeChangeReports)
          }
          reverting={Boolean(revertingChangeId)}
        />
      )}
      <CopyToastHost language={language} />
    </div>
  );
}

function CardlingCompanion({
  language,
  settings,
  status,
  sending,
  queuedMessageCount,
  pendingInteraction,
  activeChangeCount,
  activeChangeFileCount,
  error,
  onOpenSettings,
  onOpenChanges,
  onRevertChanges,
  reverting,
}: {
  language: AppLanguage;
  settings: CompanionSettings;
  status: CompanionStatus;
  sending: boolean;
  queuedMessageCount: number;
  pendingInteraction: PendingInteraction | null;
  activeChangeCount: number;
  activeChangeFileCount: number;
  error: string | null;
  onOpenSettings: () => void;
  onOpenChanges: () => void;
  onRevertChanges: () => Promise<void>;
  reverting: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState(readCardlingPosition);
  const positionRef = useRef(position);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startRight: number;
    startBottom: number;
    moved: boolean;
  } | null>(null);
  const labels = companionLabels(status, language);
  const scale = companionSizeScale(settings.size);
  const queueText =
    queuedMessageCount > 0
      ? language === 'zh'
        ? `${queuedMessageCount} 条`
        : `${queuedMessageCount}`
      : language === 'zh'
        ? '无'
        : 'None';

  useEffect(() => {
    positionRef.current = position;
  }, [position]);

  useEffect(() => {
    const syncPosition = () => {
      setPosition((current) => {
        const next = clampCardlingPosition(current);
        positionRef.current = next;
        persistCardlingPosition(next);
        return next;
      });
    };
    window.addEventListener('resize', syncPosition);
    return () => window.removeEventListener('resize', syncPosition);
  }, []);

  const changeText =
    activeChangeFileCount > 0
      ? language === 'zh'
        ? `${activeChangeFileCount} 个文件`
        : `${activeChangeFileCount} file(s)`
      : language === 'zh'
        ? '无'
        : 'None';
  const handleOpenChanges = () => {
    if (activeChangeCount === 0) {
      return;
    }
    onOpenChanges();
    setOpen(false);
  };
  const handleRevertChanges = () => {
    if (activeChangeCount === 0 || reverting) {
      return;
    }
    void onRevertChanges();
  };
  return (
    <div
      className={`cardling-companion ${open ? 'open' : ''}`}
      data-status={status}
      style={
        {
          '--cardling-right': `${position.right}px`,
          '--cardling-bottom': `${position.bottom}px`,
          '--cardling-scale': String(scale),
          '--cardling-opacity': String(settings.opacity),
        } as CSSProperties
      }
      data-motion={settings.motion}
    >
      {open && (
        <section className="cardling-panel" aria-label={language === 'zh' ? '卡布状态' : 'Kabu status'}>
          <header>
            <strong>{language === 'zh' ? '卡布' : 'Kabu'}</strong>
            <span>{labels.detail}</span>
          </header>
          <div className="cardling-status-row">
            <span className="cardling-status-dot" />
            <b>{labels.title}</b>
          </div>
          <div className="cardling-panel-grid">
            <CompanionMetric
              icon={<Sparkles size={14} />}
              label={language === 'zh' ? '回复' : 'Reply'}
              value={sending ? (language === 'zh' ? '运行中' : 'Running') : language === 'zh' ? '空闲' : 'Idle'}
            />
            <CompanionMetric
              icon={<Clock3 size={14} />}
              label={language === 'zh' ? '队列' : 'Queue'}
              value={queueText}
            />
            <CompanionMetric
              icon={<AlertCircle size={14} />}
              label={language === 'zh' ? '交互' : 'Input'}
              value={
                pendingInteraction
                  ? language === 'zh'
                    ? '等待'
                    : 'Waiting'
                  : language === 'zh'
                    ? '无'
                    : 'None'
              }
            />
            <CompanionMetric
              icon={<Code2 size={14} />}
              label={language === 'zh' ? '修改' : 'Changes'}
              value={changeText}
            />
          </div>
          {error && <p className="cardling-error">{error}</p>}
          <div className="cardling-actions">
            <button
              className="cardling-action"
              type="button"
              disabled={activeChangeCount === 0}
              onClick={handleOpenChanges}
            >
              <Code2 size={13} />
              <span>{language === 'zh' ? '查看 Diff' : 'View diff'}</span>
            </button>
            <button
              className="cardling-action"
              type="button"
              disabled={activeChangeCount === 0 || reverting}
              onClick={handleRevertChanges}
            >
              {reverting ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />}
              <span>{language === 'zh' ? '撤回全部' : 'Revert all'}</span>
            </button>
            <button className="cardling-action" type="button" onClick={onOpenSettings}>
              <Settings size={13} />
              <span>{language === 'zh' ? '设置' : 'Settings'}</span>
            </button>
          </div>
        </section>
      )}
      <button
        className="cardling-badge"
        type="button"
        aria-label={language === 'zh' ? '卡布状态' : 'Kabu status'}
        title={labels.title}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setOpen((value) => !value);
          }
        }}
        onPointerDown={(event) => {
          dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            startRight: position.right,
            startBottom: position.bottom,
            moved: false,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) {
            return;
          }
          const deltaX = event.clientX - drag.startX;
          const deltaY = event.clientY - drag.startY;
          if (Math.abs(deltaX) + Math.abs(deltaY) > 4) {
            drag.moved = true;
          }
          const next = clampCardlingPosition({
            right: drag.startRight - deltaX,
            bottom: drag.startBottom - deltaY,
          });
          positionRef.current = next;
          setPosition(next);
        }}
        onPointerUp={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) {
            return;
          }
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
          dragRef.current = null;
          if (drag.moved) {
            persistCardlingPosition(positionRef.current);
            return;
          }
          setOpen((value) => !value);
        }}
        onPointerCancel={(event) => {
          const drag = dragRef.current;
          if (!drag || drag.pointerId !== event.pointerId) {
            return;
          }
          dragRef.current = null;
          persistCardlingPosition(positionRef.current);
        }}
      >
        <span className="cardling-orbit" />
        <span className="cardling-card" aria-hidden="true">
          <span className="cardling-stack" />
          <span className="cardling-leaf" />
          <span className="cardling-eye left" />
          <span className="cardling-eye right" />
          <span className="cardling-wave" />
          <span className="cardling-cursor" />
          <span className="cardling-error-corner" />
          <span className="cardling-spark one" />
          <span className="cardling-spark two" />
        </span>
        {queuedMessageCount > 0 && (
          <span className="cardling-count">{queuedMessageCount}</span>
        )}
      </button>
    </div>
  );
}

function CompanionMetric({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="cardling-metric">
      {icon}
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function companionStatusFromState({
  error,
  pendingInteraction,
  activeToolRunning,
  sending,
  queuedMessageCount,
  recentlyCompleted,
}: {
  error: string | null;
  pendingInteraction: PendingInteraction | null;
  activeToolRunning: boolean;
  sending: boolean;
  queuedMessageCount: number;
  recentlyCompleted: boolean;
}): CompanionStatus {
  if (error) {
    return 'error';
  }
  if (pendingInteraction) {
    return 'waiting';
  }
  if (activeToolRunning) {
    return 'tool';
  }
  if (sending) {
    return 'thinking';
  }
  if (queuedMessageCount > 0) {
    return 'queued';
  }
  if (recentlyCompleted) {
    return 'complete';
  }
  return 'idle';
}

function compactCompanionText(value: string, maxLength: number) {
  const normalized = value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
}

function companionLabels(status: CompanionStatus, language: AppLanguage) {
  const labels: Record<CompanionStatus, { zh: [string, string]; en: [string, string] }> = {
    idle: {
      zh: ['准备就绪', '安静待命'],
      en: ['Ready', 'Standing by'],
    },
    thinking: {
      zh: ['正在思考', '正在生成回复'],
      en: ['Thinking', 'Generating a reply'],
    },
    tool: {
      zh: ['工具运行中', '正在处理任务'],
      en: ['Tool running', 'Working on the task'],
    },
    waiting: {
      zh: ['等待输入', '需要你的选择'],
      en: ['Waiting', 'Needs your input'],
    },
    queued: {
      zh: ['消息已排队', '稍后自动发送'],
      en: ['Queued', 'Will send next'],
    },
    complete: {
      zh: ['已完成', '这一轮处理结束'],
      en: ['Complete', 'This turn finished'],
    },
    error: {
      zh: ['需要关注', '出现了错误'],
      en: ['Needs attention', 'Something failed'],
    },
  };
  const [title, detail] = labels[status][language];
  return { title, detail };
}

function companionSizeScale(size: CompanionSize) {
  if (size === 'compact') {
    return 0.86;
  }
  if (size === 'large') {
    return 1.16;
  }
  return 1;
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

function projectContextKey(projectDir?: string) {
  return projectDir?.trim().replace(/\\/g, '/').toLowerCase() ?? '';
}

function clampSidebarWidth(value: number) {
  return Math.max(minSidebarWidth, Math.min(maxSidebarWidth, Math.round(value)));
}

function readCardlingPosition(): CardlingPosition {
  const raw = window.localStorage.getItem('cardbush_cardling_position');
  if (!raw?.trim()) {
    return { right: 22, bottom: 76 };
  }
  try {
    const decoded = JSON.parse(raw) as Partial<CardlingPosition>;
    return clampCardlingPosition({
      right: Number(decoded.right),
      bottom: Number(decoded.bottom),
    });
  } catch {
    return { right: 22, bottom: 76 };
  }
}

function persistCardlingPosition(position: CardlingPosition) {
  window.localStorage.setItem(
    'cardbush_cardling_position',
    JSON.stringify(clampCardlingPosition(position)),
  );
}

function clampCardlingPosition(position: CardlingPosition): CardlingPosition {
  const maxRight = Math.max(14, window.innerWidth - 74);
  const maxBottom = Math.max(58, window.innerHeight - 118);
  const right = Number.isFinite(position.right) ? position.right : 22;
  const bottom = Number.isFinite(position.bottom) ? position.bottom : 76;
  return {
    right: Math.max(14, Math.min(maxRight, Math.round(right))),
    bottom: Math.max(58, Math.min(maxBottom, Math.round(bottom))),
  };
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
      mode:
        window.localStorage.getItem('cardbush_proxy_mode') === 'system'
          ? 'system'
          : 'manual',
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
      }));
  } catch {
    return [];
  }
}

function normalizeAppSettings(settings: AppSettingsState): AppSettingsState {
  return {
    proxy: {
      mode: settings.proxy.mode === 'system' ? 'system' : 'manual',
      httpProxy: settings.proxy.httpProxy.trim(),
      httpsProxy: settings.proxy.httpsProxy.trim(),
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
    result.push({ id, provider, apiKey, modelName, baseUrl });
  }
  return result;
}

function normalizeProvider(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized === 'google' ? 'gemini' : normalized;
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

function fileUrl(value: string) {
  const normalized = stripWrappingQuotes(value.trim());
  if (/^file:\/\//i.test(normalized)) {
    if (!window.cardbushDesktop) {
      return normalized;
    }
    try {
      const parsed = new URL(normalized);
      const hostPrefix = parsed.hostname ? `/${parsed.hostname}` : '';
      return encodedLocalResourceUrl(`${hostPrefix}${decodeURIComponent(parsed.pathname)}`);
    } catch {
      return normalized;
    }
  }
  return encodedLocalResourceUrl(normalized);
}

function encodedLocalResourceUrl(value: string) {
  const pathValue = value.replaceAll('\\', '/').replace(/^\/+/, '');
  const encodedPath = pathValue
    .split('/')
    .map((segment, index) =>
      index === 0 && /^[a-z]:$/i.test(segment)
        ? segment
        : encodeURIComponent(segment),
    )
    .join('/');
  const scheme = window.cardbushDesktop ? 'cardbush-file' : 'file';
  return `${scheme}:///${encodedPath}`;
}

function imageAttachmentFromPath(pathValue: string): ComposerImageAttachment {
  return {
    id: `image-${crypto.randomUUID()}`,
    path: pathValue,
    name: basename(pathValue),
    previewUrl: fileUrl(pathValue),
  };
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image'));
    reader.readAsDataURL(file);
  });
}

function WindowFrame({
  musicOpen,
  onToggleMusic,
  onOpenBotSettings,
  onOpenCacheSettings,
}: {
  musicOpen: boolean;
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
      <button
        className={`music-chip no-drag ${musicOpen ? 'active' : ''}`}
        type="button"
        title="Local Music"
        onClick={onToggleMusic}
      >
        <Music2 size={14} />
        <span>Music</span>
      </button>
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
      type="button"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function ChatSidebar({
  language,
  section,
  activeConversationId,
  projects: projectItems,
  conversations: conversationItems,
  changeReportsByConversation,
  onSectionChange,
  onConversationChange,
  onCreateConversation,
  onAddProject,
  onProjectAction,
  onDeleteConversation,
  onRenameConversation,
  onOpenConversationChanges,
  onCollapse,
  onOpenSettings,
}: {
  language: AppLanguage;
  section: AppSection;
  activeConversationId: string;
  projects: ProjectItem[];
  conversations: ConversationSummary[];
  changeReportsByConversation: Record<string, ConversationChangeReport[]>;
  onSectionChange: (value: AppSection) => void;
  onConversationChange: (id: string) => void;
  onCreateConversation: () => void;
  onAddProject: () => void;
  onProjectAction: (action: ProjectAction, project: ProjectItem) => void;
  onDeleteConversation: (conversationId: string) => void;
  onRenameConversation: (conversationId: string, title: string) => void;
  onOpenConversationChanges: (conversationId: string) => void;
  onCollapse: () => void;
  onOpenSettings: () => void;
}) {
  const t = (id: AppSection) => sectionLabels[id][language];
  const [archivedConversationIds, setArchivedConversationIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<SidebarContextMenuState | null>(null);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    () => new Set(['projects', 'conversations']),
  );
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set(),
  );
  const visibleProjects = useMemo(
    () => projectItems.filter((project) => !project.archived),
    [projectItems],
  );
  const visibleConversations = useMemo(
    () =>
      conversationItems.filter(
        (conversation) => !archivedConversationIds.has(conversation.id),
      ),
    [archivedConversationIds, conversationItems],
  );
  const isKnownProjectConversation = useCallback(
    (conversation: ConversationSummary) => {
      const projectDir = conversationProjectDir(conversation);
      return Boolean(
        projectDir &&
          visibleProjects.some((project) => samePath(project.rootPath, projectDir)),
      );
    },
    [visibleProjects],
  );

  useEffect(() => {
    const active = visibleConversations.find(
      (conversation) => conversation.id === activeConversationId,
    );
    if (!active) {
      return;
    }
    const activeProjectDir = conversationProjectDir(active);
    if (!activeProjectDir) {
      setExpandedSections((current) =>
        current.has('conversations') ? current : new Set(current).add('conversations'),
      );
      return;
    }
    const project = visibleProjects.find((item) => samePath(item.rootPath, activeProjectDir));
    if (!project) {
      setExpandedSections((current) =>
        current.has('conversations') ? current : new Set(current).add('conversations'),
      );
      return;
    }
    setExpandedSections((current) =>
      current.has('projects') ? current : new Set(current).add('projects'),
    );
    setExpandedProjectIds((current) =>
      current.has(project.id) ? current : new Set(current).add(project.id),
    );
  }, [activeConversationId, visibleConversations, visibleProjects]);

  const closeMenus = useCallback(() => {
    setOpenMenu(null);
    setContextMenu(null);
  }, []);

  const toggleInlineMenu = useCallback((id: string) => {
    setContextMenu(null);
    setOpenMenu((current) => (current === id ? null : id));
  }, []);

  useEffect(() => {
    function closeFromMenuSelection() {
      closeMenus();
    }
    window.addEventListener(sidebarMenuCloseEvent, closeFromMenuSelection);
    return () => {
      window.removeEventListener(sidebarMenuCloseEvent, closeFromMenuSelection);
    };
  }, [closeMenus]);

  useEffect(() => {
    if (!openMenu && !contextMenu) {
      return undefined;
    }
    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (
        target.closest('.sidebar-menu') ||
        target.closest('.sidebar-context-menu') ||
        target.closest('[data-sidebar-menu-trigger="true"]') ||
        target.closest('.row-more') ||
        target.closest('.conversation-more')
      ) {
        return;
      }
      closeMenus();
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
    };
  }, [closeMenus, contextMenu, openMenu]);

  function openContextMenu(
    event: ReactMouseEvent,
    id: string,
    items: SidebarContextMenuItem[],
  ) {
    event.preventDefault();
    event.stopPropagation();
    const position = sidebarContextMenuPosition(event.clientX, event.clientY, items.length);
    setOpenMenu(null);
    setContextMenu({ id, items, ...position });
  }

  function runContextMenuItem(item: SidebarContextMenuItem) {
    if (item.disabled) {
      return;
    }
    if (item.children?.length) {
      return;
    }
    closeMenus();
    item.onClick?.();
  }

  function toggleConversationArchive(conversationId: string) {
    setArchivedConversationIds((current) => {
      const next = new Set(current);
      if (next.has(conversationId)) {
        next.delete(conversationId);
      } else {
        next.add(conversationId);
      }
      return next;
    });
  }

  function toggleSection(sectionId: string) {
    setExpandedSections((current) => {
      const next = new Set(current);
      if (next.has(sectionId)) {
        next.delete(sectionId);
      } else {
        next.add(sectionId);
      }
      return next;
    });
  }

  function toggleProject(projectId: string) {
    setExpandedProjectIds((current) => {
      const next = new Set(current);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }

  function projectMenuItems(project: ProjectItem): SidebarContextMenuItem[] {
    return [
      {
        key: 'pin',
        icon: <Pin size={15} />,
        label: project.pinned
          ? language === 'zh'
            ? '取消置顶'
            : 'Unpin'
          : language === 'zh'
            ? '置顶项目'
            : 'Pin project',
        onClick: () => onProjectAction('pin', project),
      },
      {
        key: 'open',
        icon: <FolderOpen size={15} />,
        label: language === 'zh' ? '在资源管理器中打开' : 'Open in Explorer',
        onClick: () => onProjectAction('open', project),
      },
      {
        key: 'refresh',
        icon: <RefreshCw size={15} />,
        label: language === 'zh' ? '刷新 Git 状态' : 'Refresh Git status',
        onClick: () => onProjectAction('refreshGit', project),
      },
      {
        key: 'new-chat',
        icon: <Edit3 size={15} />,
        label: language === 'zh' ? '新建项目会话' : 'New project chat',
        onClick: () => onProjectAction('newChat', project),
      },
      {
        key: 'rename',
        icon: <Edit3 size={15} />,
        label: language === 'zh' ? '重命名项目' : 'Rename project',
        onClick: () => onProjectAction('rename', project),
      },
      {
        key: 'archive',
        icon: <Archive size={15} />,
        label: language === 'zh' ? '归档项目' : 'Archive project',
        onClick: () => onProjectAction('archive', project),
      },
      {
        key: 'remove',
        icon: <X size={15} />,
        label: language === 'zh' ? '移除' : 'Remove',
        danger: true,
        onClick: () => onProjectAction('remove', project),
      },
    ];
  }

  function conversationMenuItems(
    conversation: ConversationSummary,
    options: ConversationMenuOptions,
  ): SidebarContextMenuItem[] {
    const items: SidebarContextMenuItem[] = [
      {
        key: 'open',
        icon: <MessageSquare size={15} />,
        label: language === 'zh' ? '打开对话' : 'Open chat',
        onClick: () => onConversationChange(conversation.id),
      },
    ];
    if (options.changeCount > 0) {
      items.push({
        key: 'diff',
        icon: <Code2 size={15} />,
        label: language === 'zh' ? '查看 Diff' : 'View diff',
        onClick: options.onOpenChanges,
      });
    }
    items.push(
      {
        key: 'rename',
        icon: <Edit3 size={15} />,
        label: language === 'zh' ? '重命名对话' : 'Rename chat',
        onClick: options.onRename,
      },
      {
        key: 'copy-id',
        icon: <Clipboard size={15} />,
        label: language === 'zh' ? '复制会话 ID' : 'Copy session ID',
        onClick: () => void copyText(conversation.id),
      },
      {
        key: 'archive',
        icon: <Archive size={15} />,
        label: language === 'zh' ? '归档对话' : 'Archive chat',
        onClick: options.onArchive,
      },
      {
        key: 'delete',
        icon: <Trash2 size={15} />,
        label: language === 'zh' ? '删除对话' : 'Delete chat',
        danger: true,
        onClick: options.onDelete,
      },
    );
    return items;
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-collapse">
        <button
          className="icon-button"
          type="button"
          title={language === 'zh' ? '折叠侧边栏' : 'Collapse sidebar'}
          aria-label={language === 'zh' ? '折叠侧边栏' : 'Collapse sidebar'}
          onClick={onCollapse}
        >
          <ChevronsLeft size={18} />
        </button>
      </div>
      <nav className="sidebar-nav">
        <NavRow
          icon={<Edit3 size={17} />}
          label={language === 'zh' ? '新会话' : 'New chat'}
          onClick={onCreateConversation}
          onContextMenu={(event) =>
            openContextMenu(event, 'nav:new-chat', [
              {
                key: 'new-chat',
                icon: <Edit3 size={15} />,
                label: language === 'zh' ? '新建普通对话' : 'New chat',
                onClick: onCreateConversation,
              },
            ])
          }
        />
        <NavRow
          active={section === 'search'}
          icon={<Search size={17} />}
          label={t('search')}
          onClick={() => onSectionChange('search')}
          onContextMenu={(event) =>
            openContextMenu(event, 'nav:search', [
              {
                key: 'open',
                icon: <Search size={15} />,
                label: language === 'zh' ? '打开搜索' : 'Open search',
                onClick: () => onSectionChange('search'),
              },
            ])
          }
        />
        <NavRow
          active={section === 'skills'}
          icon={<Puzzle size={17} />}
          label={t('skills')}
          onClick={() => onSectionChange('skills')}
          onContextMenu={(event) =>
            openContextMenu(event, 'nav:skills', [
              {
                key: 'open',
                icon: <Puzzle size={15} />,
                label: language === 'zh' ? '打开技能' : 'Open skills',
                onClick: () => onSectionChange('skills'),
              },
            ])
          }
        />
        <NavRow
          active={section === 'subagents'}
          icon={<Network size={17} />}
          label={t('subagents')}
          onClick={() => onSectionChange('subagents')}
          onContextMenu={(event) =>
            openContextMenu(event, 'nav:subagents', [
              {
                key: 'open',
                icon: <Network size={15} />,
                label: language === 'zh' ? '打开子 Agent' : 'Open subagents',
                onClick: () => onSectionChange('subagents'),
              },
            ])
          }
        />
        <NavRow
          active={section === 'gamecoding'}
          icon={<Sparkles size={17} />}
          label={t('gamecoding')}
          onClick={() => onSectionChange('gamecoding')}
          onContextMenu={(event) =>
            openContextMenu(event, 'nav:gamecoding', [
              {
                key: 'open',
                icon: <Sparkles size={15} />,
                label: language === 'zh' ? '打开 Game Coding' : 'Open Game Coding',
                onClick: () => onSectionChange('gamecoding'),
              },
            ])
          }
        />
      </nav>

      <div className="sidebar-scroll">
        <SectionHeader
          title={language === 'zh' ? '项目' : 'Projects'}
          action={<FolderOpen size={14} />}
          expanded={expandedSections.has('projects')}
          onToggle={() => toggleSection('projects')}
          onAction={onAddProject}
          onContextMenu={(event) =>
            openContextMenu(event, 'section:projects', [
              {
                key: 'toggle',
                icon: <ChevronDown size={15} />,
                label: expandedSections.has('projects')
                  ? language === 'zh'
                    ? '收起项目'
                    : 'Collapse projects'
                  : language === 'zh'
                    ? '展开项目'
                    : 'Expand projects',
                onClick: () => toggleSection('projects'),
              },
              {
                key: 'add-project',
                icon: <FolderOpen size={15} />,
                label: language === 'zh' ? '添加项目' : 'Add project',
                onClick: onAddProject,
              },
            ])
          }
        />
        {expandedSections.has('projects') && visibleProjects.map((project) => (
          <ProjectBlock
            key={project.id}
            project={project}
            conversations={visibleConversations.filter(
              (item) => {
                const projectDir = conversationProjectDir(item);
                return Boolean(projectDir && samePath(projectDir, project.rootPath));
              },
            )}
            activeConversationId={activeConversationId}
            menuOpen={openMenu === `project:${project.id}`}
            language={language}
            expanded={expandedProjectIds.has(project.id)}
            onToggleExpanded={() => toggleProject(project.id)}
            onContextMenu={(event) =>
              openContextMenu(event, `project:${project.id}`, projectMenuItems(project))
            }
            onMenuToggle={() =>
              toggleInlineMenu(`project:${project.id}`)
            }
            onProjectAction={(action) => {
              setOpenMenu(null);
              onProjectAction(action, project);
            }}
            onConversationChange={onConversationChange}
            onConversationMenuToggle={(conversationId) =>
              toggleInlineMenu(`conversation:${conversationId}`)
            }
            onConversationArchive={toggleConversationArchive}
            onDeleteConversation={onDeleteConversation}
            onRenameConversation={onRenameConversation}
            onConversationContextMenu={(event, conversation, options) =>
              openContextMenu(
                event,
                `conversation:${conversation.id}`,
                conversationMenuItems(conversation, options),
              )
            }
            changeReportsByConversation={changeReportsByConversation}
            onOpenConversationChanges={onOpenConversationChanges}
            openMenu={openMenu}
          />
        ))}

        <div className="section-header-wrap">
          <SectionHeader
            title={language === 'zh' ? '对话' : 'Conversations'}
            action={<MoreHorizontal size={14} />}
            expanded={expandedSections.has('conversations')}
            onToggle={() => toggleSection('conversations')}
            onAction={() =>
              toggleInlineMenu('section:conversations')
            }
            onContextMenu={(event) =>
              openContextMenu(event, 'section:conversations', [
                {
                  key: 'toggle',
                  icon: <ChevronDown size={15} />,
                  label: expandedSections.has('conversations')
                    ? language === 'zh'
                      ? '收起对话'
                      : 'Collapse conversations'
                    : language === 'zh'
                      ? '展开对话'
                      : 'Expand conversations',
                  onClick: () => toggleSection('conversations'),
                },
                {
                  key: 'new-chat',
                  icon: <Edit3 size={15} />,
                  label: language === 'zh' ? '新建普通对话' : 'New chat',
                  onClick: onCreateConversation,
                },
                {
                  key: 'restore',
                  icon: <Archive size={15} />,
                  label: language === 'zh' ? '恢复归档对话' : 'Restore archived chats',
                  onClick: () => setArchivedConversationIds(new Set()),
                },
              ])
            }
          />
          {openMenu === 'section:conversations' && (
            <SidebarMenu>
              <SidebarMenuButton icon={<Edit3 size={15} />} onClick={onCreateConversation}>
                {language === 'zh' ? '新建普通对话' : 'New chat'}
              </SidebarMenuButton>
              <SidebarMenuButton
                icon={<Archive size={15} />}
                onClick={() => setArchivedConversationIds(new Set())}
              >
                {language === 'zh' ? '恢复归档对话' : 'Restore archived chats'}
              </SidebarMenuButton>
            </SidebarMenu>
          )}
        </div>
        {expandedSections.has('conversations') && visibleConversations
          .filter((item) => !isKnownProjectConversation(item))
          .map((conversation) => (
            <ConversationRow
              key={conversation.id}
              conversation={conversation}
              active={conversation.id === activeConversationId}
              menuOpen={openMenu === `conversation:${conversation.id}`}
              language={language}
              onMenuToggle={() =>
                toggleInlineMenu(`conversation:${conversation.id}`)
              }
              onArchive={() => toggleConversationArchive(conversation.id)}
              onDelete={() => onDeleteConversation(conversation.id)}
              changeReports={changeReportsByConversation[conversation.id] ?? []}
              onOpenChanges={() => onOpenConversationChanges(conversation.id)}
              onRename={() => {
                const nextTitle = window.prompt(
                  language === 'zh' ? '重命名对话' : 'Rename chat',
                  conversation.title,
                );
                if (nextTitle?.trim()) {
                  onRenameConversation(conversation.id, nextTitle);
                }
              }}
              onContextMenu={(event, options) =>
                openContextMenu(
                  event,
                  `conversation:${conversation.id}`,
                  conversationMenuItems(conversation, options),
                )
              }
              onClick={() => onConversationChange(conversation.id)}
            />
          ))}
      </div>

      <button
        className="settings-dock"
        type="button"
        onClick={onOpenSettings}
        onContextMenu={(event) =>
          openContextMenu(event, 'settings', [
            {
              key: 'open-settings',
              icon: <Settings size={15} />,
              label: language === 'zh' ? '打开设置' : 'Open settings',
              onClick: onOpenSettings,
            },
          ])
        }
      >
        <Settings size={17} />
        <span>{language === 'zh' ? '设置' : 'Settings'}</span>
      </button>
      {contextMenu && (
        <SidebarContextMenu
          menu={contextMenu}
          onSelect={runContextMenuItem}
        />
      )}
    </aside>
  );
}

function NavRow({
  active,
  icon,
  label,
  onClick,
  onContextMenu,
}: {
  active?: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  onContextMenu?: (event: ReactMouseEvent) => void;
}) {
  return (
    <button
      className={`nav-row ${active ? 'active' : ''}`}
      type="button"
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function SectionHeader({
  title,
  action,
  expanded = true,
  onToggle,
  onAction,
  onContextMenu,
}: {
  title: string;
  action: React.ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
  onAction?: () => void;
  onContextMenu?: (event: ReactMouseEvent) => void;
}) {
  return (
    <div className="section-header" onContextMenu={onContextMenu}>
      <button
        className="section-title"
        type="button"
        onClick={onToggle}
        disabled={!onToggle}
      >
        <ChevronDown className={expanded ? '' : 'collapsed'} size={14} />
        {title}
      </button>
      <button
        className="section-action"
        data-sidebar-menu-trigger="true"
        type="button"
        onClick={onAction}
        disabled={!onAction}
      >
        {action}
      </button>
    </div>
  );
}

function ProjectBlock({
  project,
  conversations: projectConversations,
  activeConversationId,
  language,
  expanded,
  menuOpen,
  openMenu,
  onToggleExpanded,
  onContextMenu,
  onMenuToggle,
  onProjectAction,
  onConversationChange,
  onConversationMenuToggle,
  onConversationArchive,
  onDeleteConversation,
  onRenameConversation,
  onConversationContextMenu,
  changeReportsByConversation,
  onOpenConversationChanges,
}: {
  project: ProjectItem;
  conversations: ConversationSummary[];
  activeConversationId: string;
  language: AppLanguage;
  expanded: boolean;
  menuOpen: boolean;
  openMenu: string | null;
  onToggleExpanded: () => void;
  onContextMenu: (event: ReactMouseEvent) => void;
  onMenuToggle: () => void;
  onProjectAction: (action: ProjectAction) => void;
  onConversationChange: (id: string) => void;
  onConversationMenuToggle: (conversationId: string) => void;
  onConversationArchive: (conversationId: string) => void;
  onDeleteConversation: (conversationId: string) => void;
  onRenameConversation: (conversationId: string, title: string) => void;
  onConversationContextMenu: (
    event: ReactMouseEvent,
    conversation: ConversationSummary,
    options: ConversationMenuOptions,
  ) => void;
  changeReportsByConversation: Record<string, ConversationChangeReport[]>;
  onOpenConversationChanges: (conversationId: string) => void;
}) {
  return (
    <div className="project-block">
      <div
        className="project-row"
        role="button"
        tabIndex={0}
        onClick={onToggleExpanded}
        onContextMenu={onContextMenu}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onToggleExpanded();
          }
        }}
      >
        <Folder size={17} />
        <div className="project-title">
          <span>{project.title}</span>
          {project.branch && (
            <small>{`${project.branch} · ${project.changedCount ?? 0}`}</small>
          )}
        </div>
        <button
          className="row-new-chat"
          data-sidebar-menu-trigger="true"
          type="button"
          aria-label={language === 'zh' ? '新建项目会话' : 'New project chat'}
          title={language === 'zh' ? '新建项目会话' : 'New project chat'}
          onClick={(event) => {
            event.stopPropagation();
            onProjectAction('newChat');
          }}
          onContextMenu={(event) => {
            event.stopPropagation();
            onContextMenu(event);
          }}
        >
          <Plus size={14} />
        </button>
        <button
          className="row-more"
          data-sidebar-menu-trigger="true"
          type="button"
          aria-label="project options"
          onClick={(event) => {
            event.stopPropagation();
            onMenuToggle();
          }}
          onContextMenu={(event) => {
            event.stopPropagation();
            onContextMenu(event);
          }}
        >
          <MoreHorizontal size={15} />
        </button>
        {menuOpen && (
          <SidebarMenu>
            <SidebarMenuButton icon={<Pin size={15} />} onClick={() => onProjectAction('pin')}>
              {project.pinned
                ? language === 'zh'
                  ? '取消置顶'
                  : 'Unpin'
                : language === 'zh'
                  ? '置顶项目'
                  : 'Pin project'}
            </SidebarMenuButton>
            <SidebarMenuButton icon={<FolderOpen size={15} />} onClick={() => onProjectAction('open')}>
              {language === 'zh' ? '在资源管理器中打开' : 'Open in Explorer'}
            </SidebarMenuButton>
            <SidebarMenuButton icon={<RefreshCw size={15} />} onClick={() => onProjectAction('refreshGit')}>
              {language === 'zh' ? '刷新 Git 状态' : 'Refresh Git status'}
            </SidebarMenuButton>
            <SidebarMenuButton icon={<Edit3 size={15} />} onClick={() => onProjectAction('newChat')}>
              {language === 'zh' ? '新建项目会话' : 'New project chat'}
            </SidebarMenuButton>
            <SidebarMenuButton icon={<Edit3 size={15} />} onClick={() => onProjectAction('rename')}>
              {language === 'zh' ? '重命名项目' : 'Rename project'}
            </SidebarMenuButton>
            <SidebarMenuButton icon={<Archive size={15} />} onClick={() => onProjectAction('archive')}>
              {language === 'zh' ? '归档项目' : 'Archive project'}
            </SidebarMenuButton>
            <SidebarMenuButton danger icon={<X size={15} />} onClick={() => onProjectAction('remove')}>
              {language === 'zh' ? '移除' : 'Remove'}
            </SidebarMenuButton>
          </SidebarMenu>
        )}
      </div>
      {expanded && projectConversations.map((conversation) => (
        <ConversationRow
          key={conversation.id}
          conversation={conversation}
          active={conversation.id === activeConversationId}
          nested
          menuOpen={openMenu === `conversation:${conversation.id}`}
          language={language}
          onMenuToggle={() => onConversationMenuToggle(conversation.id)}
          onArchive={() => onConversationArchive(conversation.id)}
          onDelete={() => onDeleteConversation(conversation.id)}
          changeReports={changeReportsByConversation[conversation.id] ?? []}
          onOpenChanges={() => onOpenConversationChanges(conversation.id)}
          onRename={() => {
            const nextTitle = window.prompt(
              language === 'zh' ? '重命名对话' : 'Rename chat',
              conversation.title,
            );
            if (nextTitle?.trim()) {
              onRenameConversation(conversation.id, nextTitle);
            }
          }}
          onContextMenu={(event, options) =>
            onConversationContextMenu(event, conversation, options)
          }
          onClick={() => onConversationChange(conversation.id)}
        />
      ))}
    </div>
  );
}

function ConversationRow({
  conversation,
  active,
  nested,
  language,
  menuOpen,
  onMenuToggle,
  onArchive,
  onDelete,
  changeReports,
  onOpenChanges,
  onRename,
  onContextMenu,
  onClick,
}: {
  conversation: ConversationSummary;
  active: boolean;
  nested?: boolean;
  language: AppLanguage;
  menuOpen: boolean;
  onMenuToggle: () => void;
  onArchive: () => void;
  onDelete: () => void;
  changeReports?: ConversationChangeReport[];
  onOpenChanges?: () => void;
  onRename: () => void;
  onContextMenu?: (event: ReactMouseEvent, options: ConversationMenuOptions) => void;
  onClick: () => void;
}) {
  const changeCount = changeReports?.reduce((sum, report) => sum + report.fileCount, 0) ?? 0;
  const menuOptions: ConversationMenuOptions = {
    changeCount,
    onOpenChanges,
    onRename,
    onArchive,
    onDelete,
  };
  return (
    <div
      className={`conversation-row ${nested ? 'nested' : ''} ${active ? 'active' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onContextMenu={(event) => onContextMenu?.(event, menuOptions)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
    >
      <span>{conversation.title}</span>
      {changeCount > 0 && (
        <button
          className="conversation-change-badge"
          type="button"
          title={language === 'zh' ? '查看本会话 Diff' : 'View chat diff'}
          aria-label={language === 'zh' ? '查看本会话 Diff' : 'View chat diff'}
          onClick={(event) => {
            event.stopPropagation();
            onOpenChanges?.();
          }}
        >
          <Code2 size={13} />
          <b>{changeCount}</b>
        </button>
      )}
      <button
        className="conversation-more"
        data-sidebar-menu-trigger="true"
        type="button"
        aria-label="conversation options"
        onClick={(event) => {
          event.stopPropagation();
          onMenuToggle();
        }}
        onContextMenu={(event) => {
          event.stopPropagation();
          onContextMenu?.(event, menuOptions);
        }}
      >
        <MoreHorizontal size={15} />
      </button>
      {menuOpen && (
        <SidebarMenu>
          <SidebarMenuButton icon={<MessageSquare size={15} />} onClick={onClick}>
            {language === 'zh' ? '打开对话' : 'Open chat'}
          </SidebarMenuButton>
          {changeCount > 0 && (
            <SidebarMenuButton icon={<Code2 size={15} />} onClick={() => onOpenChanges?.()}>
              {language === 'zh' ? '查看 Diff' : 'View diff'}
            </SidebarMenuButton>
          )}
          <SidebarMenuButton icon={<Edit3 size={15} />} onClick={onRename}>
            {language === 'zh' ? '重命名对话' : 'Rename chat'}
          </SidebarMenuButton>
          <SidebarMenuButton
            icon={<Clipboard size={15} />}
            onClick={() => void copyText(conversation.id)}
          >
            {language === 'zh' ? '复制会话 ID' : 'Copy session ID'}
          </SidebarMenuButton>
          <SidebarMenuButton icon={<Archive size={15} />} onClick={onArchive}>
            {language === 'zh' ? '归档对话' : 'Archive chat'}
          </SidebarMenuButton>
          <SidebarMenuButton danger icon={<Trash2 size={15} />} onClick={onDelete}>
            {language === 'zh' ? '删除对话' : 'Delete chat'}
          </SidebarMenuButton>
        </SidebarMenu>
      )}
    </div>
  );
}

function SidebarMenu({ children }: { children: React.ReactNode }) {
  return <div className="sidebar-menu">{children}</div>;
}

function SidebarContextMenu({
  menu,
  onSelect,
}: {
  menu: SidebarContextMenuState;
  onSelect: (item: SidebarContextMenuItem) => void;
}) {
  return (
    <div
      className="sidebar-context-menu"
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {menu.items.map((item) => (
        <button
          key={item.key}
          className={`sidebar-menu-button ${item.danger ? 'danger' : ''}`}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(item);
          }}
        >
          {item.icon}
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
}

function SidebarMenuButton({
  icon,
  danger,
  onClick,
  children,
}: {
  icon: React.ReactNode;
  danger?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`sidebar-menu-button ${danger ? 'danger' : ''}`}
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        window.dispatchEvent(new CustomEvent(sidebarMenuCloseEvent));
        onClick();
      }}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}

function ConversationChangeDialog({
  language,
  conversation,
  reports,
  notice,
  revertingChangeId,
  onClose,
  onRevert,
  onRevertAll,
}: {
  language: AppLanguage;
  conversation: ConversationSummary;
  reports: ConversationChangeReport[];
  notice: string;
  revertingChangeId: string;
  onClose: () => void;
  onRevert: (report: ConversationChangeReport) => Promise<void>;
  onRevertAll: () => Promise<void>;
}) {
  const totals = reports.reduce(
    (sum, report) => ({
      files: sum.files + report.fileCount,
      additions: sum.additions + report.additions,
      deletions: sum.deletions + report.deletions,
    }),
    { files: 0, additions: 0, deletions: 0 },
  );
  const allBusy = revertingChangeId === `conversation:${conversation.id}`;
  return (
    <div
      className="modal-backdrop change-review-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <section className="change-review-dialog">
        <header>
          <div>
            <strong>{language === 'zh' ? '会话修改' : 'Chat changes'}</strong>
            <span>{conversation.title}</span>
          </div>
          <button type="button" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        <div className="change-review-summary">
          <Code2 size={16} />
          <span>
            {language === 'zh'
              ? `${reports.length} 组修改，${totals.files} 个文件`
              : `${reports.length} change set(s), ${totals.files} file(s)`}
          </span>
          {totals.additions > 0 && <b className="diff-count add">+{totals.additions}</b>}
          {totals.deletions > 0 && <b className="diff-count del">-{totals.deletions}</b>}
          <button
            className="danger-soft-button"
            type="button"
            disabled={Boolean(revertingChangeId)}
            onClick={() => void onRevertAll()}
          >
            {allBusy ? <LoaderCircle size={14} /> : <RotateCcw size={14} />}
            <span>{language === 'zh' ? '撤回全部修改' : 'Revert all'}</span>
          </button>
        </div>
        {notice && <pre className="change-review-notice">{notice}</pre>}
        <div className="change-review-list">
          {reports.map((report, index) => {
            const busy = revertingChangeId === report.id;
            return (
              <section className="change-review-card" key={report.id}>
                <header>
                  <div>
                    <strong>
                      {language === 'zh'
                        ? `修改 ${index + 1}`
                        : `Change ${index + 1}`}
                    </strong>
                    <span>{formatChangeTimestamp(report.createdAt, language)}</span>
                  </div>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={Boolean(revertingChangeId)}
                    onClick={() => void onRevert(report)}
                  >
                    {busy ? <LoaderCircle size={14} /> : <RotateCcw size={14} />}
                    <span>{language === 'zh' ? '撤回这组' : 'Revert set'}</span>
                  </button>
                </header>
                <div className="change-review-files">
                  {report.files.map((file, fileIndex) => (
                    <ToolFileChangeView
                      // eslint-disable-next-line react/no-array-index-key
                      key={`${report.id}-${file.path}-${fileIndex}`}
                      file={file}
                      language={language}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function ChatPanel({
  language,
  title,
  sidebarCollapsed,
  onRevealSidebar,
  conversations,
  activeConversationId,
  activeProjectDir,
  projectContext,
  messages,
  skills,
  disabledSkillNames,
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
  onModelChange,
  onRuntimeProfileChange,
  onReferencePlanModeChange,
  onConfigureModels,
  onCreateConversation,
  onOpenConversation,
  onSaveProjectContext,
  onToggleSkill,
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
  conversations: ConversationSummary[];
  activeConversationId: string;
  activeProjectDir?: string;
  projectContext: string;
  messages: ChatMessage[];
  skills: SkillSummary[];
  disabledSkillNames: Set<string>;
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
  onModelChange: (value: string) => void;
  onRuntimeProfileChange: (value: string) => void;
  onReferencePlanModeChange: (value: ReferencePlanMode) => void;
  onConfigureModels: () => void;
  onCreateConversation: () => void;
  onOpenConversation: (conversationId: string) => void;
  onSaveProjectContext: (value: string) => Promise<string>;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
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
  const [projectEntries, setProjectEntries] = useState<ProjectEntry[]>([]);
  const [composerDockHeight, setComposerDockHeight] = useState(0);
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
    let cancelled = false;
    async function loadProjectEntries() {
      const root = activeProjectDir?.trim();
      if (!root || !window.cardbushDesktop?.listProjectEntries) {
        setProjectEntries([]);
        return;
      }
      const entries = await window.cardbushDesktop
        .listProjectEntries(root)
        .catch(() => []);
      if (!cancelled) {
        setProjectEntries(entries);
      }
    }
    void loadProjectEntries();
    return () => {
      cancelled = true;
    };
  }, [activeProjectDir]);

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

  const quickItems = useMemo(
    () =>
      quickSideItems({
        conversations,
        activeConversationId,
        messages: renderMessages,
        projectEntries,
        activeProjectDir,
        language,
      }),
    [
      activeConversationId,
      activeProjectDir,
      conversations,
      language,
      renderMessages,
      projectEntries,
    ],
  );
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

  const jumpToMessage = useCallback(
    (messageId: string) => {
      const index = renderMessages.findIndex((message) => message.id === messageId);
      if (index < 0) {
        return;
      }
      programmaticScrollUntilRef.current = Date.now() + 1000;
      manualScrollDetachUntilRef.current = 0;
      autoFollowStreamRef.current = false;
      userDetachedFromBottomRef.current = true;
      pendingSubmittedUserFocusRef.current = false;
      lastWheelLockRef.current = null;
      setScrollBottomVisible(false);
      listRef.current?.scrollToIndex({
        index,
        align: 'center',
        behavior: 'auto',
      });
      window.requestAnimationFrame(() => {
        positionMessageAtReadingAnchor(messageId);
        window.requestAnimationFrame(() => {
          positionMessageAtReadingAnchor(messageId);
          setScrollBottomVisible(
            shouldShowScrollBottomForScroller(listScrollerRef.current),
          );
        });
      });
    },
    [
      positionMessageAtReadingAnchor,
      renderMessages,
      setScrollBottomVisible,
      shouldShowScrollBottomForScroller,
    ],
  );

  const jumpQuickTarget = useCallback(
    (target: QuickJumpTarget) => {
      if (target.kind === 'conversation') {
        onOpenConversation(target.conversationId);
        return;
      }
      if (target.kind === 'message') {
        jumpToMessage(target.messageId);
        return;
      }
      void window.cardbushDesktop?.openPath?.(target.path).catch(() => undefined);
    },
    [jumpToMessage, onOpenConversation],
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
        return;
      }
      lastScrollTopRef.current = nextScroller.scrollTop;
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

  const toggleConsole = useCallback((mode: ConsoleMode) => {
    setConsoleMode((current) => (current === mode ? null : mode));
  }, []);

  const chatBodyStyle = {
    '--composer-dock-height': `${composerDockHeight}px`,
    '--stream-status-height': `${streamStatusHeight}px`,
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
        onCreateSessionShareLink={onCreateSessionShareLink}
        onRefreshActiveSession={onRefreshActiveSession}
        activeConsole={consoleMode}
        onToggleGit={() => toggleConsole('git')}
        onToggleTerminal={() => toggleConsole('terminal')}
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
            selectedModel={selectedModel}
            availableModels={availableModels}
            selectedRuntimeProfile={selectedRuntimeProfile}
            runtimeProfiles={runtimeProfiles}
            referencePlanMode={referencePlanMode}
            onModelChange={onModelChange}
            onRuntimeProfileChange={onRuntimeProfileChange}
            onReferencePlanModeChange={onReferencePlanModeChange}
            onConfigureModels={onConfigureModels}
            onCreateConversation={onCreateConversation}
            activeProjectDir={activeProjectDir}
            projectContext={projectContext}
            skills={skills}
            disabledSkillNames={disabledSkillNames}
            onToggleSkill={onToggleSkill}
            onSaveProjectContext={onSaveProjectContext}
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
        {!loading && (
          <QuickSideDock
            language={language}
            items={quickItems}
            queuedMessages={queuedMessages}
            onLoad={applyQuickLoad}
            onJump={jumpQuickTarget}
            onEditQueuedMessage={editQueuedMessage}
            onDeleteQueuedMessage={onRemoveQueuedMessage}
            onGuideQueuedMessage={(queuedId) =>
              onGuideQueuedMessage(queuedId, 'append_context')
            }
          />
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
              selectedModel={selectedModel}
              availableModels={availableModels}
              selectedRuntimeProfile={selectedRuntimeProfile}
              runtimeProfiles={runtimeProfiles}
              referencePlanMode={referencePlanMode}
              onModelChange={onModelChange}
              onRuntimeProfileChange={onRuntimeProfileChange}
              onReferencePlanModeChange={onReferencePlanModeChange}
              onSend={handleComposerSend}
              onCancel={onCancel}
              messages={messages}
              skills={skills}
              disabledSkillNames={disabledSkillNames}
              onToggleSkill={onToggleSkill}
              activeProjectDir={activeProjectDir}
              projectContext={projectContext}
              onQuickLoad={applyQuickLoad}
              onSaveProjectContext={onSaveProjectContext}
              onConfigureModels={onConfigureModels}
              onCreateConversation={onCreateConversation}
              onOpenTerminalConsole={() => toggleConsole('terminal')}
            />
          </div>
        )}
      </div>
      {consoleMode && (
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

function CardlingSceneHost({
  scene,
  language,
  initialAutoPlay,
  llmRunning,
  activeTurnId,
  onSendFeedbackToLlm,
  onClose,
}: {
  scene: CardlingScene;
  language: AppLanguage;
  initialAutoPlay: boolean;
  llmRunning: boolean;
  activeTurnId: string;
  onSendFeedbackToLlm: (text: string) => Promise<void>;
  onClose: () => void;
}) {
  const sceneHostRef = useRef<HTMLElement | null>(null);
  const sceneInspectorRef = useRef<HTMLElement | null>(null);
  const sceneNodeListRef = useRef<HTMLDivElement | null>(null);
  const sceneFeedbackRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [anchorRect, setAnchorRect] = useState<SceneAnchorRect | null>(null);
  const [comment, setComment] = useState('');
  const [feedbackQueue, setFeedbackQueue] = useState<CardlingSceneFeedback[]>([]);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [eventStatus, setEventStatus] = useState<SceneEventStatus>('idle');
  const [sceneState, setSceneState] = useState<SceneRuntimeState>(() =>
    initialSceneRuntimeState(scene),
  );
  const [sceneHealth, setSceneHealth] = useState<SceneHealthReport>(() =>
    initialSceneHealth(scene),
  );
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const [freeTalkMode, setFreeTalkMode] = useState(false);
  const [kabuDialogOpen, setKabuDialogOpen] = useState(false);
  const [kabuDraft, setKabuDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [decisionSubmitting, setDecisionSubmitting] = useState<
    'confirm' | 'cancel' | ''
  >('');
  const lastSceneHealthKeyRef = useRef('');
  const srcDoc = useMemo(() => buildSceneSrcDoc(scene), [scene]);
  const sceneSteps = useMemo(
    () => buildCardlingSceneSteps(scene, language),
    [language, scene],
  );
  const [selectedNodeId, setSelectedNodeId] = useState(() =>
    initialSceneSelectedNodeId(scene, sceneSteps),
  );
  const [activeStepIndex, setActiveStepIndex] = useState(0);
  const [typedSpeech, setTypedSpeech] = useState('');
  const [playbackRunning, setPlaybackRunning] = useState(initialAutoPlay);
  const activeStep =
    sceneSteps[Math.min(activeStepIndex, Math.max(0, sceneSteps.length - 1))];
  const activeStepNodeId = activeStep?.nodeId?.trim() ?? '';
  const activeSpeech = freeTalkMode
    ? language === 'zh'
      ? '自由对话已开启。你可以直接测试这个 HTML 页面，点击不会切换反馈节点；点我可以聊整个场景。'
      : 'Free chat is on. You can test this HTML page directly; clicks will not retarget feedback nodes. Click me to discuss the whole scene.'
    : activeStep?.speech || scene.cardling.speech;
  const displayedSpeech = typedSpeech || (playbackRunning ? '' : activeSpeech);
  const embedded = scene.cardling.mode === 'embedded';
  const anchoredNodeId =
    activeStep != null
      ? activeStepNodeId || selectedNodeId
      : selectedNodeId ||
        anchorRect?.nodeId ||
        scene.cardling.anchor?.nodeId ||
        scene.nodes[0]?.nodeId ||
        '';
  const currentNodeId = freeTalkMode ? '' : anchoredNodeId;
  const cardlingAnchorRect =
    freeTalkMode || (activeStep != null && !activeStepNodeId) ? null : anchorRect;
  const expectedAction = scene.expectedUserAction?.type?.trim() ?? '';
  const showDecisionActions =
    scene.expectedUserAction?.required ||
    expectedAction === 'confirm' ||
    expectedAction === 'decision' ||
    expectedAction === 'approval';
  const activeTurnMatchesScene =
    !activeTurnId.trim() ||
    !scene.turnId?.trim() ||
    activeTurnId.trim() === scene.turnId.trim();
  const sceneLlmRunning = llmRunning && activeTurnMatchesScene;
  const sceneWorkActive =
    sceneLlmRunning || eventStatus === 'sending' || eventStatus === 'continuing';

  useEffect(() => {
    const host = sceneHostRef.current;
    const inspector = sceneInspectorRef.current;
    if (!host || !inspector) {
      return undefined;
    }
    let frame = 0;
    const report = () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const feedback = sceneFeedbackRef.current;
        const nodeList = sceneNodeListRef.current;
        const actions = feedback?.querySelector('.scene-feedback-actions');
        const hostRect = host.getBoundingClientRect();
        const inspectorRect = inspector.getBoundingClientRect();
        const actionsRect =
          actions instanceof HTMLElement ? actions.getBoundingClientRect() : null;
        const actionClipped =
          actionsRect != null && actionsRect.bottom > inspectorRect.bottom + 1;
        const inspectorNeedsScroll =
          inspector.scrollHeight > inspector.clientHeight + 1;
        const hostNeedsScroll =
          host.scrollHeight > host.clientHeight + 1 ||
          host.scrollWidth > host.clientWidth + 1;
        if (!actionClipped && !inspectorNeedsScroll && !hostNeedsScroll) {
          return;
        }
        console.debug('[cardbush:scene-layout]', {
          sceneId: scene.sceneId,
          window: {
            width: window.innerWidth,
            height: window.innerHeight,
          },
          host: {
            width: Math.round(hostRect.width),
            height: Math.round(hostRect.height),
            clientWidth: host.clientWidth,
            clientHeight: host.clientHeight,
            scrollWidth: host.scrollWidth,
            scrollHeight: host.scrollHeight,
          },
          inspector: {
            top: Math.round(inspectorRect.top),
            bottom: Math.round(inspectorRect.bottom),
            clientHeight: inspector.clientHeight,
            scrollHeight: inspector.scrollHeight,
            scrollTop: inspector.scrollTop,
          },
          nodeList: nodeList
            ? {
                clientHeight: nodeList.clientHeight,
                scrollHeight: nodeList.scrollHeight,
              }
            : null,
          feedback: feedback
            ? {
                clientHeight: feedback.clientHeight,
                scrollHeight: feedback.scrollHeight,
              }
            : null,
          actionsBottom: actionsRect ? Math.round(actionsRect.bottom) : null,
          actionClipped,
        });
      });
    };
    const observer = new ResizeObserver(report);
    observer.observe(host);
    observer.observe(inspector);
    if (sceneNodeListRef.current) {
      observer.observe(sceneNodeListRef.current);
    }
    if (sceneFeedbackRef.current) {
      observer.observe(sceneFeedbackRef.current);
    }
    window.addEventListener('resize', report);
    report();
    return () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      observer.disconnect();
      window.removeEventListener('resize', report);
    };
  }, [
    error,
    eventStatus,
    feedbackQueue.length,
    scene.sceneId,
    showDecisionActions,
    notice,
  ]);

  const sceneNodeById = useMemo(() => {
    return new Map(scene.nodes.map((node) => [node.nodeId, node]));
  }, [scene.nodes]);
  const sceneNavigationItems = useMemo(() => {
    const addedNodeIds = new Set<string>();
    const items = sceneSteps.map((step, index) => {
      const node = step.nodeId ? sceneNodeById.get(step.nodeId) : undefined;
      if (step.nodeId) {
        addedNodeIds.add(step.nodeId);
      }
      return {
        key: step.nodeId ? `node:${step.nodeId}` : `step:${step.id}`,
        nodeId: step.nodeId ?? '',
        stepId: step.id,
        stepIndex: index,
        label:
          step.title ||
          node?.label ||
          (step.nodeId
            ? step.nodeId
            : language === 'zh'
              ? '整体设计概述'
              : 'Design overview'),
        purpose:
          step.nodeId
            ? node?.purpose || step.speech
            : step.speech || (language === 'zh' ? '整体说明' : 'Overview'),
        overview: !step.nodeId,
      };
    });
    for (const node of scene.nodes) {
      if (addedNodeIds.has(node.nodeId)) {
        continue;
      }
      items.push({
        key: `node:${node.nodeId}`,
        nodeId: node.nodeId,
        stepId: '',
        stepIndex: -1,
        label: node.label || node.nodeId,
        purpose: node.purpose || '',
        overview: false,
      });
    }
    return items;
  }, [language, scene.nodes, sceneNodeById, sceneSteps]);
  const currentFeedbackTargetKey =
    freeTalkMode
      ? 'free_chat'
      : currentNodeId
        ? `node:${currentNodeId}`
        : `step:${activeStep?.id ?? 'overview'}`;
  const currentFeedbackStepId = freeTalkMode
    ? 'free_chat'
    : activeStep?.id ?? 'overview';
  const feedbackCountByTarget = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of feedbackQueue) {
      const key = item.nodeId ? `node:${item.nodeId}` : `step:${item.stepId ?? 'overview'}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [feedbackQueue]);
  const currentNodeLabel =
    freeTalkMode
      ? language === 'zh'
        ? '自由对话'
        : 'Free chat'
      : sceneNodeById.get(currentNodeId)?.label ||
        activeStep?.title ||
        currentNodeId ||
        (language === 'zh' ? '整体场景' : 'Overall scene');

  const requestAnchorRect = useCallback(
    (nodeId = currentNodeId, options?: { reveal?: boolean }) => {
      const targetNodeId = nodeId.trim();
      if (!targetNodeId) {
        setAnchorRect(null);
        return;
      }
      iframeRef.current?.contentWindow?.postMessage(
        {
          source: 'cardbush-scene-host',
          type: 'set_anchor',
          sceneId: scene.sceneId,
          reveal: options?.reveal === true,
          anchor: {
            nodeId: targetNodeId,
            selector: scene.cardling.anchor?.selector,
          },
        },
        '*',
      );
    },
    [currentNodeId, scene.cardling.anchor?.selector, scene.sceneId],
  );

  const syncSceneInteractionMode = useCallback(
    (freeMode = freeTalkMode) => {
      iframeRef.current?.contentWindow?.postMessage(
        {
          source: 'cardbush-scene-host',
          type: 'set_interaction_mode',
          sceneId: scene.sceneId,
          mode: freeMode ? 'free_chat' : 'node',
        },
        '*',
      );
    },
    [freeTalkMode, scene.sceneId],
  );

  useEffect(() => {
    syncSceneInteractionMode();
    if (freeTalkMode) {
      setAnchorRect(null);
    }
  }, [freeTalkMode, syncSceneInteractionMode]);

  const activateSceneStep = useCallback(
    (index: number, play = false) => {
      if (sceneSteps.length === 0) {
        return;
      }
      const nextIndex = Math.min(Math.max(index, 0), sceneSteps.length - 1);
      const nextStep = sceneSteps[nextIndex];
      setActiveStepIndex(nextIndex);
      setTypedSpeech('');
      setPlaybackRunning(play);
      if (nextStep?.nodeId) {
        setSelectedNodeId(nextStep.nodeId);
        window.requestAnimationFrame(() =>
          requestAnchorRect(nextStep.nodeId, { reveal: true }),
        );
      } else {
        setSelectedNodeId('');
        setAnchorRect(null);
      }
    },
    [requestAnchorRect, sceneSteps],
  );

  const activateSceneNode = useCallback(
    (nodeId: string, play = false) => {
      const stepIndex = sceneSteps.findIndex((step) => step.nodeId === nodeId);
      if (stepIndex >= 0) {
        activateSceneStep(stepIndex, play);
        return;
      }
      const node = scene.nodes.find((candidate) => candidate.nodeId === nodeId);
      setSelectedNodeId(nodeId);
      setTypedSpeech(nodePurposeSpeech(node, language));
      setPlaybackRunning(false);
      window.requestAnimationFrame(() => requestAnchorRect(nodeId, { reveal: true }));
    },
    [activateSceneStep, language, requestAnchorRect, scene.nodes, sceneSteps],
  );

  const restartScenePlayback = useCallback(() => {
    activateSceneStep(0, true);
  }, [activateSceneStep]);

  const toggleScenePlayback = useCallback(() => {
    if (playbackRunning) {
      setPlaybackRunning(false);
      return;
    }
    if (activeStep && typedSpeech.length >= activeStep.speech.length) {
      if (activeStepIndex >= sceneSteps.length - 1) {
        restartScenePlayback();
        return;
      }
      activateSceneStep(activeStepIndex + 1, true);
      return;
    }
    setPlaybackRunning(true);
  }, [
    activeStep,
    activeStepIndex,
    activateSceneStep,
    playbackRunning,
    restartScenePlayback,
    sceneSteps.length,
    typedSpeech.length,
  ]);

  const toggleFreeTalkMode = useCallback(() => {
    const next = !freeTalkMode;
    setFreeTalkMode(next);
    setKabuDialogOpen(next);
    setTypedSpeech('');
    setPlaybackRunning(false);
    syncSceneInteractionMode(next);
    if (next) {
      setSelectedNodeId('');
      setAnchorRect(null);
      return;
    }
    const nodeId = activeStep?.nodeId?.trim() || selectedNodeId;
    if (nodeId) {
      window.requestAnimationFrame(() => requestAnchorRect(nodeId, { reveal: true }));
    }
  }, [
    activeStep?.nodeId,
    freeTalkMode,
    requestAnchorRect,
    selectedNodeId,
    syncSceneInteractionMode,
  ]);

  useEffect(() => {
    setAnchorRect(null);
    setSelectedNodeId(initialSceneSelectedNodeId(scene, sceneSteps));
    setActiveStepIndex(0);
    setTypedSpeech('');
    setPlaybackRunning(initialAutoPlay && sceneSteps.length > 0);
    setComment('');
    setFeedbackQueue([]);
    setNotice('');
    setError('');
    setEventStatus('idle');
    setSceneState(initialSceneRuntimeState(scene));
    setSceneHealth(initialSceneHealth(scene));
    setInspectorCollapsed(false);
    setFreeTalkMode(false);
    setKabuDialogOpen(false);
    setKabuDraft('');
    lastSceneHealthKeyRef.current = '';
    setDecisionSubmitting('');
  }, [initialAutoPlay, scene, sceneSteps]);

  useEffect(() => {
    if (sceneSteps.length === 0) {
      return;
    }
    setActiveStepIndex((index) => Math.min(index, sceneSteps.length - 1));
  }, [sceneSteps.length]);

  useEffect(() => {
    if (freeTalkMode) {
      setAnchorRect(null);
      return;
    }
    if (!activeStep?.nodeId) {
      setAnchorRect(null);
      return;
    }
    setSelectedNodeId(activeStep.nodeId);
    const frame = window.requestAnimationFrame(() =>
      requestAnchorRect(activeStep.nodeId, { reveal: true }),
    );
    return () => window.cancelAnimationFrame(frame);
  }, [activeStep?.id, activeStep?.nodeId, freeTalkMode, requestAnchorRect]);

  const recordSceneRuntimeEvent = useCallback(
    (
      type: SceneRuntimeEventType | string,
      payload: Record<string, unknown>,
      nodeId = '',
    ) => {
      setSceneState((current) =>
        appendSceneRuntimeEvent(current, {
          id: `scene-event-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          type,
          nodeId: nodeId || undefined,
          payload,
          createdAt: new Date().toISOString(),
        }),
      );
    },
    [],
  );

  const applyBridgeRuntimeState = useCallback(
    (value: unknown) => {
      if (value == null) {
        return;
      }
      setSceneState((current) =>
        mergeSceneRuntimeState(
          current,
          normalizeSceneRuntimeState(value, scene, current),
        ),
      );
    },
    [scene],
  );

  const applyBridgeHealth = useCallback(
    (value: unknown, trigger: string) => {
      if (value == null) {
        return;
      }
      const health = normalizeSceneHealth(value, scene);
      setSceneHealth(health);
      const key = sceneHealthKey(health);
      if (key === lastSceneHealthKeyRef.current || health.ok) {
        return;
      }
      lastSceneHealthKeyRef.current = key;
      void sendSceneUserEvent(scene, {
        event: 'scene_health',
        values: { health },
        metadata: {
          kind: 'scene_health',
          trigger,
        },
      }).catch(() => undefined);
    },
    [scene],
  );

  const openSceneTarget = useCallback(
    async (payload: Record<string, unknown>) => {
      const target = sceneOpenTargetFromPayload(payload);
      if (!target) {
        setError(
          language === 'zh'
            ? '这个打开动作缺少可识别的链接或本地路径。'
            : 'This open action does not include a recognizable link or local path.',
        );
        return;
      }
      setError('');
      setNotice(
        language === 'zh'
          ? target.kind === 'url'
            ? '正在打开链接...'
            : '正在打开本地文件...'
          : target.kind === 'url'
            ? 'Opening link...'
            : 'Opening local file...',
      );
      try {
        if (target.kind === 'url') {
          await window.cardbushDesktop?.openExternal?.(target.target);
          setNotice(
            language === 'zh'
              ? '链接已在 CardBush 浏览器中打开。'
              : 'The link was opened in the CardBush browser.',
          );
          return;
        }
        const result = await window.cardbushDesktop?.openPath?.(target.target);
        if (result && result.trim()) {
          throw new Error(result);
        }
        setNotice(
          language === 'zh'
            ? '已交给系统打开本地文件。'
            : 'The local file was handed to the system.',
        );
      } catch (caught) {
        setNotice('');
        setError(
          language === 'zh'
            ? `打开失败：${errorMessage(caught)}`
            : `Open failed: ${errorMessage(caught)}`,
        );
      }
    },
    [language],
  );

  useEffect(() => {
    const speech = activeStep?.speech ?? '';
    if (!playbackRunning || !speech) {
      return;
    }
    if (typedSpeech.length >= speech.length) {
      if (activeStepIndex >= sceneSteps.length - 1) {
        setPlaybackRunning(false);
        return;
      }
      const timeout = window.setTimeout(
        () => activateSceneStep(activeStepIndex + 1, true),
        activeStep?.holdMs ?? 850,
      );
      return () => window.clearTimeout(timeout);
    }
    const chunkSize = speech.length > 140 ? 2 : 1;
    const timeout = window.setTimeout(() => {
      setTypedSpeech(speech.slice(0, Math.min(speech.length, typedSpeech.length + chunkSize)));
    }, 22);
    return () => window.clearTimeout(timeout);
  }, [
    activeStep?.holdMs,
    activeStep?.speech,
    activeStepIndex,
    activateSceneStep,
    playbackRunning,
    sceneSteps.length,
    typedSpeech,
  ]);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.source !== iframeRef.current?.contentWindow) {
        return;
      }
      const data = asRecord(event.data);
      if (data.source !== 'cardbush-scene' || data.sceneId !== scene.sceneId) {
        return;
      }
      const type = String(data.type ?? '');
      const nodeId = String(data.nodeId ?? currentNodeId).trim();
      if (
        freeTalkMode &&
        [
          'node_click',
          'selection_change',
          'node_drag_start',
          'node_drag_end',
          'node_reorder',
        ].includes(type)
      ) {
        return;
      }
      if (data.state != null) {
        applyBridgeRuntimeState(data.state);
      }
      if (data.health != null) {
        applyBridgeHealth(data.health, type || 'bridge');
      }
      if (type === 'scene_ready') {
        if (currentNodeId) {
          requestAnchorRect(currentNodeId, { reveal: true });
        } else {
          setAnchorRect(null);
        }
        recordSceneRuntimeEvent(type, asRecord(data), nodeId);
        void sendSceneUserEvent(scene, {
          event: 'scene_ready',
          values: {
            state: data.state,
            health: data.health,
          },
          metadata: { title: scene.title },
        }).catch(() => undefined);
        return;
      }
      if (type === 'anchor_rect') {
        const rect = asRecord(data.rect);
        setAnchorRect({
          nodeId: String(data.nodeId ?? currentNodeId),
          rect: {
            left: Number(rect.left) || 0,
            top: Number(rect.top) || 0,
            width: Number(rect.width) || 0,
            height: Number(rect.height) || 0,
          },
          tone: data.tone === 'light' ? 'light' : 'dark',
        });
        return;
      }
      if (type === 'anchor_missing') {
        setAnchorRect(null);
        return;
      }
      if (type === 'scene_health') {
        recordSceneRuntimeEvent(type, asRecord(data), nodeId);
        return;
      }
      if (type === 'scene_error') {
        const message = String(data.message ?? data.error ?? '').trim();
        recordSceneRuntimeEvent(type, asRecord(data), nodeId);
        if (message) {
          setError(
            language === 'zh'
              ? `场景脚本错误：${message}`
              : `Scene script error: ${message}`,
          );
        }
        void sendSceneUserEvent(scene, {
          event: 'scene_error',
          nodeId,
          values: {
            message,
            stack: String(data.stack ?? ''),
          },
          metadata: { kind: 'scene_health' },
        }).catch(() => undefined);
        return;
      }
      if (type === 'node_click') {
        if (nodeId) {
          activateSceneNode(nodeId);
          recordSceneRuntimeEvent(type, asRecord(data), nodeId);
          void sendSceneUserEvent(scene, {
            event: 'node_click',
            nodeId,
            values: { state: data.state },
            metadata: { label: data.label },
          }).catch(() => undefined);
        }
        return;
      }
      if (sceneRuntimeEventTypes.has(type)) {
        recordSceneRuntimeEvent(type, asRecord(data), nodeId);
        void sendSceneUserEvent(scene, {
          event: type,
          nodeId,
          values: {
            state: data.state,
            order: data.order,
            previous_order: data.previousOrder ?? data.previous_order,
            values: data.values,
            action: data.action,
            route: data.route,
          },
          metadata: {
            kind: 'scene_runtime_event',
            label: data.label,
            source: data.source,
          },
        })
          .then(async (response) => {
            if (
              type === 'request_llm_action' &&
              !sceneLlmRunning &&
              !sceneEventContinuesTurn(response)
            ) {
              const prompt = formatSceneActionRunPrompt(scene, data, language);
              if (prompt) {
                await onSendFeedbackToLlm(prompt);
              }
            }
          })
          .catch((caught) => setError(sceneEventError(caught, language)));
        if (type === 'selection_change' && nodeId) {
          activateSceneNode(nodeId);
        }
        if (type === 'node_reorder') {
          setNotice(
            language === 'zh'
              ? '节点顺序已同步给后端。'
              : 'Node order synced to the backend.',
          );
        }
        if (type === 'scene_toast') {
          const message = String(data.message ?? '').trim();
          if (message) {
            setNotice(message);
          }
        }
        return;
      }
      if (type === 'form_submit') {
        recordSceneRuntimeEvent(type, asRecord(data), nodeId);
        void sendSceneUserEvent(scene, {
          event: 'form_submit',
          nodeId,
          values: asRecord(data.values),
          metadata: { state: data.state },
        })
          .then(() =>
            setNotice(
              language === 'zh'
                ? '表单事件已发送给后端'
                : 'Form event sent to backend',
            ),
          )
          .catch((caught) => setError(sceneEventError(caught, language)));
        return;
      }
      if (type === 'external_url') {
        const target = sceneOpenTargetFromPayload(data);
        if (target) {
          recordSceneRuntimeEvent(type, { ...data, target: target.target }, nodeId);
          void sendSceneUserEvent(scene, {
            event: 'external_url',
            nodeId,
            metadata: {
              url: target.kind === 'url' ? target.target : undefined,
              path: target.kind === 'path' ? target.target : undefined,
              kind: target.kind,
              label: target.label,
            },
          }).catch(() => undefined);
          void openSceneTarget(data);
        }
      }
    }
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [
    activateSceneNode,
    applyBridgeHealth,
    applyBridgeRuntimeState,
    currentNodeId,
    freeTalkMode,
    language,
    onSendFeedbackToLlm,
    openSceneTarget,
    recordSceneRuntimeEvent,
    requestAnchorRect,
    scene,
    sceneLlmRunning,
  ]);

  const addFeedbackToQueue = useCallback(() => {
    const text = comment.trim();
    if (!text) {
      return;
    }
    setFeedbackQueue((current) => [
      ...current,
      {
        id: sceneFeedbackId(),
        nodeId: currentNodeId,
        stepId: currentNodeId ? undefined : currentFeedbackStepId,
        nodeLabel: currentNodeLabel,
        text,
        createdAt: new Date().toISOString(),
      },
    ]);
    setComment('');
    setError('');
    setEventStatus('idle');
    setNotice(
      language === 'zh'
        ? sceneLlmRunning
          ? '已加入反馈清单，不会打断 LLM 当前思考。'
          : '已加入反馈清单，可继续选择节点补充。'
        : sceneLlmRunning
          ? 'Added to the feedback list without interrupting the current run.'
          : 'Added to the feedback list. You can keep reviewing nodes.',
    );
  }, [
    comment,
    currentFeedbackStepId,
    currentNodeId,
    currentNodeLabel,
    language,
    sceneLlmRunning,
  ]);

  const removeFeedback = useCallback((id: string) => {
    setFeedbackQueue((current) => current.filter((item) => item.id !== id));
  }, []);

  const submitImmediateComment = useCallback(async () => {
    const text = comment.trim();
    if (!text || submitting) {
      return;
    }
    setSubmitting(true);
    setEventStatus('sending');
    setError('');
    try {
      const feedback: CardlingSceneFeedback = {
        id: sceneFeedbackId(),
        nodeId: currentNodeId,
        stepId: currentNodeId ? undefined : currentFeedbackStepId,
        nodeLabel: currentNodeLabel,
        text,
        createdAt: new Date().toISOString(),
      };
      const response = await sendSceneUserEvent(scene, {
        event: 'comment',
        nodeId: currentNodeId,
        text,
        metadata: {
          step_id: currentNodeId ? undefined : currentFeedbackStepId,
          target_key: currentFeedbackTargetKey,
          target_label: currentNodeLabel,
          target_kind: freeTalkMode ? 'free_chat' : currentNodeId ? 'node' : 'step',
        },
      });
      const continued =
        sceneEventContinuesTurn(response) || sceneEventDelivery(response) === 'guidance';
      if (!sceneLlmRunning && !continued) {
        await onSendFeedbackToLlm(
          formatSceneFeedbackRunPrompt(scene, [feedback], language),
        );
      }
      setEventStatus(continued || sceneLlmRunning ? 'continuing' : 'recorded');
      setComment('');
      setNotice(
        language === 'zh'
          ? continued || sceneLlmRunning
            ? '这条反馈已交给 LLM 继续处理。'
            : '这条反馈已发送给 LLM 处理。'
          : continued || sceneLlmRunning
            ? 'This feedback was handed to the running LLM task.'
            : 'This feedback was sent to the LLM.',
      );
    } catch (caught) {
      setEventStatus('failed');
      setError(sceneEventError(caught, language));
    } finally {
      setSubmitting(false);
    }
  }, [
    comment,
    currentFeedbackStepId,
    currentFeedbackTargetKey,
    currentNodeId,
    currentNodeLabel,
    freeTalkMode,
    language,
    onSendFeedbackToLlm,
    scene,
    sceneLlmRunning,
    submitting,
  ]);

  const submitKabuDialog = useCallback(async () => {
    const text = kabuDraft.trim();
    if (!text || submitting) {
      return;
    }
    setSubmitting(true);
    setEventStatus('sending');
    setError('');
    try {
      const response = await sendSceneUserEvent(scene, {
        event: 'comment',
        nodeId: currentNodeId,
        text,
        metadata: {
          kind: 'kabu_chat',
          step_id: currentNodeId ? undefined : currentFeedbackStepId,
          target_key: currentFeedbackTargetKey,
          target_label: currentNodeLabel,
          target_kind: freeTalkMode ? 'free_chat' : currentNodeId ? 'node' : 'step',
        },
      });
      const continued =
        sceneEventContinuesTurn(response) || sceneEventDelivery(response) === 'guidance';
      if (!sceneLlmRunning && !continued) {
        await onSendFeedbackToLlm(
          formatSceneKabuChatPrompt(scene, {
            text,
            nodeId: currentNodeId,
            nodeLabel: currentNodeLabel,
            stepId: currentNodeId ? undefined : currentFeedbackStepId,
            language,
          }),
        );
      }
      setKabuDraft('');
      setKabuDialogOpen(false);
      setEventStatus(continued || sceneLlmRunning ? 'continuing' : 'recorded');
      setNotice(
        language === 'zh'
          ? continued || sceneLlmRunning
            ? '卡布已把这句话交给正在运行的任务。'
            : '卡布已把这句话发给 LLM 继续处理。'
          : continued || sceneLlmRunning
            ? 'Kabu handed this message to the running task.'
            : 'Kabu sent this message to the LLM.',
      );
    } catch (caught) {
      setEventStatus('failed');
      setError(sceneEventError(caught, language));
    } finally {
      setSubmitting(false);
    }
  }, [
    currentFeedbackStepId,
    currentFeedbackTargetKey,
    currentNodeId,
    currentNodeLabel,
    freeTalkMode,
    kabuDraft,
    language,
    onSendFeedbackToLlm,
    scene,
    sceneLlmRunning,
    submitting,
  ]);

  const submitFeedbackQueue = useCallback(async () => {
    if (feedbackQueue.length === 0 || submitting) {
      return;
    }
    const feedbackToSubmit = feedbackQueue;
    setSubmitting(true);
    setEventStatus('sending');
    setError('');
    try {
      const response = await sendSceneUserEvent(scene, {
        event: 'form_submit',
        nodeId: currentNodeId,
        values: {
          kind: 'scene_feedback_batch',
          count: feedbackToSubmit.length,
          comments: feedbackToSubmit.map((item) => ({
            node_id: item.nodeId,
            step_id: item.stepId,
            target_kind:
              item.stepId === 'free_chat' ? 'free_chat' : item.nodeId ? 'node' : 'step',
            node_label: item.nodeLabel,
            text: item.text,
            created_at: item.createdAt,
          })),
        },
        metadata: {
          kind: 'scene_feedback_batch',
          count: feedbackToSubmit.length,
          delivery: sceneLlmRunning ? 'guidance' : 'recorded',
        },
      });
      const continued =
        sceneEventContinuesTurn(response) || sceneEventDelivery(response) === 'guidance';
      if (!sceneLlmRunning && !continued) {
        await onSendFeedbackToLlm(
          formatSceneFeedbackRunPrompt(scene, feedbackToSubmit, language),
        );
      }
      setEventStatus(continued || sceneLlmRunning ? 'continuing' : 'recorded');
      setFeedbackQueue([]);
      setNotice(
        language === 'zh'
          ? continued || sceneLlmRunning
            ? '反馈清单已提交给正在运行的任务。'
            : '反馈清单已发送给 LLM 处理。'
          : continued || sceneLlmRunning
            ? 'Feedback list submitted to the running task.'
            : 'Feedback list sent to the LLM.',
      );
    } catch (caught) {
      setEventStatus('failed');
      setError(sceneEventError(caught, language));
    } finally {
      setSubmitting(false);
    }
  }, [
    currentNodeId,
    feedbackQueue,
    language,
    onSendFeedbackToLlm,
    scene,
    sceneLlmRunning,
    submitting,
  ]);

  const submitDecision = useCallback(
    async (event: 'confirm' | 'cancel') => {
      if (decisionSubmitting) {
        return;
      }
      setDecisionSubmitting(event);
      setError('');
      try {
        await sendSceneUserEvent(scene, {
          event,
          nodeId: currentNodeId,
          metadata: { expectedAction },
        });
        setNotice(
          event === 'confirm'
            ? language === 'zh'
              ? '确认已发送给后端'
              : 'Confirmation sent to backend'
            : language === 'zh'
              ? '取消已发送给后端'
              : 'Cancellation sent to backend',
        );
      } catch (caught) {
        setError(sceneEventError(caught, language));
      } finally {
        setDecisionSubmitting('');
      }
    },
    [currentNodeId, decisionSubmitting, expectedAction, language, scene],
  );

  return (
    <section ref={sceneHostRef} className="scene-host" aria-label={scene.title}>
      <header className="scene-toolbar">
        <div className="scene-toolbar-title">
          <Sparkles size={16} />
          <span>
            <strong>{scene.title}</strong>
            <small>
              {language === 'zh'
                ? 'HTML 任务场景'
                : 'HTML task scene'}
            </small>
          </span>
        </div>
        <div className={`scene-runtime-pill ${sceneWorkActive ? 'running' : 'idle'}`}>
          {sceneWorkActive ? <LoaderCircle size={13} /> : <Bot size={13} />}
          <span>
            {eventStatus === 'sending'
              ? language === 'zh'
                ? '正在提交反馈'
                : 'Submitting feedback'
              : sceneWorkActive
              ? language === 'zh'
                ? 'LLM 正在思考'
                : 'LLM thinking'
              : language === 'zh'
                ? '卡布待命'
                : 'Kabu ready'}
          </span>
        </div>
        <button
          className={`scene-free-talk-toggle ${freeTalkMode ? 'active' : ''}`}
          type="button"
          onClick={toggleFreeTalkMode}
          title={
            freeTalkMode
              ? language === 'zh'
                ? '切回节点讲解'
                : 'Return to node narration'
              : language === 'zh'
                ? '开启自由对话，测试页面时不切换节点'
                : 'Enable free chat without retargeting nodes while testing the page'
          }
        >
          <MessageSquare size={14} />
          <span>
            {freeTalkMode
              ? language === 'zh'
                ? '自由对话'
                : 'Free chat'
              : language === 'zh'
                ? '节点讲解'
                : 'Node mode'}
          </span>
        </button>
        {sceneSteps.length > 0 && (
          <div
            className="scene-playback-controls"
            aria-label={language === 'zh' ? '场景播放控制' : 'Scene playback controls'}
          >
            <button
              type="button"
              onClick={restartScenePlayback}
              title={language === 'zh' ? '重播讲解' : 'Replay narration'}
            >
              <RotateCcw size={14} />
            </button>
            <button
              type="button"
              disabled={activeStepIndex <= 0}
              onClick={() => activateSceneStep(activeStepIndex - 1)}
              title={language === 'zh' ? '上一个节点' : 'Previous node'}
            >
              <ArrowLeft size={14} />
            </button>
            <button
              type="button"
              onClick={toggleScenePlayback}
              title={playbackRunning
                ? language === 'zh'
                  ? '暂停讲解'
                  : 'Pause narration'
                : language === 'zh'
                  ? '继续讲解'
                  : 'Resume narration'}
            >
              {playbackRunning ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button
              type="button"
              disabled={activeStepIndex >= sceneSteps.length - 1}
              onClick={() => activateSceneStep(activeStepIndex + 1)}
              title={language === 'zh' ? '下一个节点' : 'Next node'}
            >
              <ArrowRight size={14} />
            </button>
            <span>{`${Math.min(activeStepIndex + 1, sceneSteps.length)}/${sceneSteps.length}`}</span>
          </div>
        )}
        <button
          className={`scene-inspector-toggle ${inspectorCollapsed ? 'collapsed' : ''}`}
          type="button"
          onClick={() => setInspectorCollapsed((current) => !current)}
          title={
            inspectorCollapsed
              ? language === 'zh'
                ? '展开反馈面板'
                : 'Show feedback panel'
              : language === 'zh'
                ? '折叠反馈面板'
                : 'Hide feedback panel'
          }
        >
          {inspectorCollapsed ? (
            <PanelRightOpen size={16} />
          ) : (
            <PanelRightClose size={16} />
          )}
          {feedbackQueue.length > 0 && <span>{feedbackQueue.length}</span>}
        </button>
        <button
          type="button"
          onClick={() => requestAnchorRect()}
          title={language === 'zh' ? '重新同步卡布位置' : 'Resync Kabu position'}
        >
          <RefreshCw size={15} />
        </button>
        <button
          type="button"
          onClick={onClose}
          title={language === 'zh' ? '返回对话' : 'Back to chat'}
        >
          <X size={16} />
        </button>
      </header>
      <div className={`scene-body ${inspectorCollapsed ? 'inspector-collapsed' : ''}`}>
        <div className="scene-viewport">
          <iframe
            ref={iframeRef}
            title={scene.title}
            sandbox="allow-forms allow-scripts"
            srcDoc={srcDoc}
            onLoad={() => {
              syncSceneInteractionMode();
              if (freeTalkMode) {
                setAnchorRect(null);
              } else if (currentNodeId) {
                requestAnchorRect(currentNodeId, { reveal: true });
              } else {
                setAnchorRect(null);
              }
            }}
          />
          {(embedded || activeSpeech) && (
            <div
              className={`scene-cardling ${embedded ? 'embedded' : 'floating'} ${embedded && !cardlingAnchorRect ? 'fallback' : ''} mood-${scene.cardling.mood} tone-${cardlingAnchorRect?.tone ?? 'dark'}`}
              style={
                embedded
                  ? sceneCardlingStyle(cardlingAnchorRect, scene.cardling.anchor)
                  : sceneFloatingCardlingStyle(scene.cardling.position)
              }
            >
              <button
                className="scene-cardling-avatar scene-cardling-avatar-button"
                type="button"
                aria-label={language === 'zh' ? '和卡布对话' : 'Talk to Kabu'}
                title={language === 'zh' ? '和卡布对话' : 'Talk to Kabu'}
                onClick={() => setKabuDialogOpen((current) => !current)}
              >
                <span className="cardling-orbit" />
                <span className="cardling-card">
                  <span className="cardling-stack" />
                  <span className="cardling-leaf" />
                  <span className="cardling-eye left" />
                  <span className="cardling-eye right" />
                  <span className="cardling-wave" />
                  <span className="cardling-cursor" />
                  <span className="cardling-error-corner" />
                  <span className="cardling-spark one" />
                  <span className="cardling-spark two" />
                </span>
              </button>
              {activeSpeech && (
                <div className="scene-cardling-bubble">
                  <span>{displayedSpeech}</span>
                  {playbackRunning && typedSpeech.length < activeSpeech.length && (
                    <i aria-hidden="true" />
                  )}
                  {sceneWorkActive && !playbackRunning && (
                    <small>
                      <LoaderCircle size={11} />
                      {language === 'zh'
                        ? eventStatus === 'sending'
                          ? '我正在把反馈交给后端和 LLM。'
                          : '我正在跟进任务，反馈会先收进清单。'
                        : eventStatus === 'sending'
                          ? 'I am sending the feedback to the backend and LLM.'
                          : 'I am following the task. Feedback is collected first.'}
                    </small>
                  )}
                </div>
              )}
            </div>
          )}
          {kabuDialogOpen && (
            <div
              className="scene-kabu-dialog"
              style={sceneKabuDialogStyle(cardlingAnchorRect, scene.cardling.anchor)}
            >
              <header>
                <Sparkles size={14} />
                <strong>{language === 'zh' ? '和卡布说' : 'Talk to Kabu'}</strong>
                <button
                  type="button"
                  onClick={() => setKabuDialogOpen(false)}
                  title={language === 'zh' ? '关闭' : 'Close'}
                >
                  <X size={13} />
                </button>
              </header>
              <small>
                {freeTalkMode
                  ? language === 'zh'
                    ? '自由对话：不绑定具体节点'
                    : 'Free chat: not bound to a specific node'
                  : currentNodeId
                  ? `${language === 'zh' ? '当前节点' : 'Current node'}: ${currentNodeLabel}`
                  : activeStep?.title ||
                    (language === 'zh' ? '整体场景' : 'Overall scene')}
              </small>
              <textarea
                value={kabuDraft}
                autoFocus
                placeholder={
                  language === 'zh'
                    ? freeTalkMode
                      ? '和卡布自由聊这个页面、交互感受或测试结果...'
                      : '告诉卡布你想调整哪里，或让它解释这个节点...'
                    : freeTalkMode
                      ? 'Freely talk with Kabu about this page, interactions, or test results...'
                      : 'Tell Kabu what to adjust, or ask it to explain this node...'
                }
                onChange={(event) => setKabuDraft(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                    event.preventDefault();
                    void submitKabuDialog();
                  }
                }}
              />
              <footer>
                <button type="button" onClick={() => setKabuDraft('')}>
                  {language === 'zh' ? '清空' : 'Clear'}
                </button>
                <button
                  className="primary-button"
                  type="button"
                  disabled={submitting || !kabuDraft.trim()}
                  onClick={() => void submitKabuDialog()}
                >
                  {submitting ? <LoaderCircle size={13} /> : <ArrowUp size={13} />}
                  {language === 'zh' ? '发送' : 'Send'}
                </button>
              </footer>
            </div>
          )}
        </div>
        <aside
          ref={sceneInspectorRef}
          className={`scene-inspector ${inspectorCollapsed ? 'collapsed' : ''}`}
        >
          {inspectorCollapsed ? (
            <button
              className="scene-inspector-rail"
              type="button"
              onClick={() => setInspectorCollapsed(false)}
              title={language === 'zh' ? '展开节点反馈' : 'Show node feedback'}
            >
              <MessageSquare size={15} />
              {feedbackQueue.length > 0 && <span>{feedbackQueue.length}</span>}
            </button>
          ) : (
            <>
          <strong>{language === 'zh' ? '节点反馈' : 'Node feedback'}</strong>
          <p>
            {freeTalkMode
              ? language === 'zh'
                ? '自由对话模式：页面点击不会切换节点。'
                : 'Free chat mode: page clicks will not retarget nodes.'
              : currentNodeId
              ? `${language === 'zh' ? '当前节点' : 'Current node'}: ${currentNodeId}`
              : activeStep?.title
                ? `${language === 'zh' ? '当前步骤' : 'Current step'}: ${activeStep.title}`
              : language === 'zh'
                ? '点击场景里的节点来定位反馈。'
                : 'Click a node in the scene to target feedback.'}
          </p>
          {!sceneHealth.ok && (
            <div className="scene-health-warning">
              <AlertCircle size={14} />
              <span>
                <strong>
                  {language === 'zh'
                    ? '场景部分渲染异常'
                    : 'Scene rendered with issues'}
                </strong>
                <small>
                  {sceneHealth.issues[0]?.message ||
                    (language === 'zh'
                      ? '已把健康检查结果回传后端。'
                      : 'Health check was sent to the backend.')}
                  {sceneHealth.issues.length > 1
                    ? language === 'zh'
                      ? `，另有 ${sceneHealth.issues.length - 1} 项`
                      : `, plus ${sceneHealth.issues.length - 1} more`
                    : ''}
                </small>
              </span>
            </div>
          )}
          <div className="scene-state-strip">
            <span>
              {language === 'zh'
                ? `节点 ${sceneState.nodes.length}`
                : `Nodes ${sceneState.nodes.length}`}
            </span>
            <span>
              {language === 'zh'
                ? `事件 ${sceneState.userEvents.length}`
                : `Events ${sceneState.userEvents.length}`}
            </span>
          </div>
          {sceneNavigationItems.length > 0 && (
            <div ref={sceneNodeListRef} className="scene-node-list">
              {sceneNavigationItems.map((item) => {
                const isActiveNode = item.nodeId
                  ? item.nodeId === currentNodeId
                  : !currentNodeId && activeStep?.id === item.stepId;
                const isPlayingNode = item.stepIndex === activeStepIndex;
                const feedbackCount = feedbackCountByTarget.get(item.key) ?? 0;
                return (
                  <button
                    key={item.key}
                    className={`${isActiveNode ? 'active' : ''} ${isPlayingNode ? 'playing' : ''} ${item.overview ? 'overview' : ''}`.trim()}
                    type="button"
                    onClick={() => {
                      if (item.stepIndex >= 0) {
                        activateSceneStep(item.stepIndex);
                      } else if (item.nodeId) {
                        activateSceneNode(item.nodeId);
                      }
                      if (item.nodeId) {
                        void sendSceneUserEvent(scene, {
                          event: 'node_click',
                          nodeId: item.nodeId,
                          metadata: {
                            label: item.label,
                            source: 'inspector',
                          },
                        }).catch(() => undefined);
                      } else {
                        void sendSceneUserEvent(scene, {
                          event: 'scene_step_select',
                          metadata: {
                            step_id: item.stepId,
                            label: item.label,
                            source: 'inspector',
                          },
                        }).catch(() => undefined);
                      }
                    }}
                  >
                    <span>
                      {item.label}
                      {feedbackCount > 0 && <em>{feedbackCount}</em>}
                    </span>
                    {item.purpose && <small>{item.purpose}</small>}
                  </button>
                );
              })}
            </div>
          )}
          <div ref={sceneFeedbackRef} className="scene-feedback-panel">
            <div className={`scene-feedback-status ${sceneWorkActive ? 'running' : 'idle'}`}>
              {sceneWorkActive ? <LoaderCircle size={14} /> : <Sparkles size={14} />}
              <span>
                <strong>
                  {eventStatus === 'sending'
                    ? language === 'zh'
                      ? '正在提交反馈'
                      : 'Submitting feedback'
                    : sceneWorkActive
                    ? language === 'zh'
                      ? 'LLM 正在处理'
                      : 'LLM is running'
                    : language === 'zh'
                      ? '反馈清单'
                      : 'Feedback list'}
                </strong>
                <small>
                  {eventStatus === 'sending'
                    ? language === 'zh'
                      ? '正在把反馈交给后端，随后会触发 LLM 处理。'
                      : 'Sending feedback to the backend, then the LLM will process it.'
                    : eventStatus === 'recorded'
                      ? language === 'zh'
                        ? '反馈已提交。若没有运行中任务，前端已发起一轮 LLM 请求。'
                        : 'Feedback submitted. If no task was running, a new LLM request was started.'
                    : eventStatus === 'failed'
                      ? language === 'zh'
                        ? '反馈提交失败，请查看错误信息。'
                        : 'Feedback submission failed. See the error below.'
                    : sceneWorkActive
                    ? language === 'zh'
                      ? '继续添加反馈，默认不会打断当前思考。'
                      : 'Keep adding feedback; it will not interrupt by default.'
                    : feedbackQueue.length > 0
                      ? language === 'zh'
                        ? `待提交 ${feedbackQueue.length} 条反馈`
                        : `${feedbackQueue.length} feedback item(s) pending`
                      : language === 'zh'
                        ? '点选页面节点后添加修改意见。'
                        : 'Select nodes and add review notes.'}
                </small>
              </span>
            </div>
            <textarea
              value={comment}
              placeholder={
                language === 'zh'
                  ? sceneLlmRunning
                    ? 'LLM 正在思考。这里写下反馈，先加入清单...'
                    : '对这个位置提出修改、疑问或确认...'
                  : sceneLlmRunning
                    ? 'LLM is thinking. Write feedback here and collect it first...'
                    : 'Comment, ask, or confirm this position...'
              }
              onChange={(event) => setComment(event.currentTarget.value)}
            />
            <div className="scene-feedback-actions">
              <button
                className="primary-button"
                type="button"
                disabled={!comment.trim()}
                onClick={addFeedbackToQueue}
              >
                <MessageSquare size={14} />
                {language === 'zh' ? '添加反馈' : 'Add feedback'}
              </button>
              <button
                type="button"
                disabled={submitting || !comment.trim()}
                onClick={() => void submitImmediateComment()}
                title={
                  language === 'zh'
                    ? '绕过清单，立即把当前这条反馈发给后端'
                    : 'Bypass the list and send this note immediately'
                }
              >
                {submitting ? <LoaderCircle size={14} /> : <ArrowUp size={14} />}
                {language === 'zh' ? '立即发送' : 'Send now'}
              </button>
            </div>
            {feedbackQueue.length > 0 && (
              <div className="scene-feedback-queue">
                <header>
                  <strong>
                    {language === 'zh'
                      ? `待提交反馈 ${feedbackQueue.length}`
                      : `Pending feedback ${feedbackQueue.length}`}
                  </strong>
                  <button type="button" onClick={() => setFeedbackQueue([])}>
                    {language === 'zh' ? '清空' : 'Clear'}
                  </button>
                </header>
                <div>
                  {feedbackQueue.map((item) => (
                    <article key={item.id}>
                      <span>{item.nodeLabel}</span>
                      <p>{item.text}</p>
                      <button
                        type="button"
                        title={language === 'zh' ? '移除这条反馈' : 'Remove this feedback'}
                        onClick={() => removeFeedback(item.id)}
                      >
                        <X size={12} />
                      </button>
                    </article>
                  ))}
                </div>
                <button
                  className="primary-button"
                  type="button"
                  disabled={submitting}
                  onClick={() => void submitFeedbackQueue()}
                >
                  {submitting ? <LoaderCircle size={14} /> : <Check size={14} />}
                  {language === 'zh' ? '提交全部反馈' : 'Submit all feedback'}
                </button>
              </div>
            )}
            {showDecisionActions && (
              <div className="scene-decision-actions">
                <button
                  type="button"
                  disabled={decisionSubmitting !== ''}
                  onClick={() => void submitDecision('cancel')}
                >
                  {decisionSubmitting === 'cancel' ? (
                    <LoaderCircle size={14} />
                  ) : (
                    <X size={14} />
                  )}
                  {language === 'zh' ? '取消' : 'Cancel'}
                </button>
                <button
                  className="primary-button"
                  type="button"
                  disabled={decisionSubmitting !== ''}
                  onClick={() => void submitDecision('confirm')}
                >
                  {decisionSubmitting === 'confirm' ? (
                    <LoaderCircle size={14} />
                  ) : (
                    <Check size={14} />
                  )}
                  {language === 'zh' ? '确认' : 'Confirm'}
                </button>
              </div>
            )}
            {notice && <p className="scene-notice">{notice}</p>}
            {error && <p className="scene-error">{error}</p>}
          </div>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}

async function sendSceneUserEvent(
  scene: CardlingScene,
  payload: {
    event: string;
    nodeId?: string;
    text?: string;
    values?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  },
): Promise<Record<string, unknown>> {
  if (!scene.sessionId?.trim()) {
    throw new Error('Scene 暂无 session_id，无法回传后端');
  }
  return sendSceneEvent({
    sessionId: scene.sessionId,
    sceneId: scene.sceneId,
    turnId: scene.turnId,
    event: payload.event,
    nodeId: payload.nodeId,
    text: payload.text,
    values: payload.values,
    metadata: payload.metadata,
  });
}

function sceneOpenTargetFromPayload(payload: Record<string, unknown>): SceneOpenTarget | null {
  const rawTarget =
    sceneString(
      payload.target ??
        payload.path ??
        payload.file_path ??
        payload.filePath ??
        payload.url ??
        payload.href,
    ) ||
    sceneString(asRecord(payload.metadata).target) ||
    sceneString(asRecord(payload.metadata).path) ||
    sceneString(asRecord(payload.metadata).url) ||
    '';
  const target = rawTarget.trim();
  if (!target || target === '#' || /^javascript:/i.test(target)) {
    return null;
  }
  const requestedKind = (sceneString(payload.kind) ?? '').toLowerCase();
  const kind =
    requestedKind === 'path' || requestedKind === 'file'
      ? 'path'
      : requestedKind === 'url' || requestedKind === 'link'
        ? 'url'
        : sceneTargetLooksLikePath(target)
          ? 'path'
          : 'url';
  const normalizedTarget =
    kind === 'path' ? normalizeSceneOpenPath(target) : normalizeSceneOpenUrl(target);
  if (!normalizedTarget) {
    return null;
  }
  return {
    kind,
    target: normalizedTarget,
    label: sceneString(payload.label),
  };
}

function sceneTargetLooksLikePath(value: string) {
  return (
    /^file:/i.test(value) ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    /^\\\\/.test(value)
  );
}

function normalizeSceneOpenPath(value: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  if (/^file:/i.test(trimmed)) {
    try {
      const fileUrl = new URL(trimmed);
      const decodedPath = decodeURIComponent(fileUrl.pathname);
      if (fileUrl.hostname) {
        return `\\\\${fileUrl.hostname}${decodedPath.replace(/\//g, '\\')}`;
      }
      return decodedPath.replace(/^\/([a-zA-Z]:)/, '$1').replace(/\//g, '\\');
    } catch {
      return trimmed;
    }
  }
  return trimmed;
}

function normalizeSceneOpenUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed || /^javascript:/i.test(trimmed)) {
    return '';
  }
  return trimmed;
}

function sceneEventError(error: unknown, language: AppLanguage) {
  const message = errorMessage(error);
  if (/404|not found/i.test(message)) {
    return language === 'zh'
      ? '后端 Scene 事件接口尚未接入，暂时无法回传这条反馈。'
      : 'The backend Scene event endpoint is not available yet.';
  }
  return message;
}

function sceneEventContinuesTurn(payload: Record<string, unknown>) {
  return (
    sceneBoolean(payload.continue_turn) === true ||
    sceneBoolean(payload.continueTurn) === true ||
    sceneBoolean(asRecord(payload.result).continue_turn) === true ||
    sceneBoolean(asRecord(payload.result).continueTurn) === true
  );
}

function sceneEventDelivery(payload: Record<string, unknown>): SceneEventDelivery {
  const result = asRecord(payload.result);
  const metadata = asRecord(payload.metadata);
  const resultMetadata = asRecord(result.metadata);
  const value = String(
    payload.delivery ?? result.delivery ?? metadata.delivery ?? resultMetadata.delivery ?? '',
  ).toLowerCase();
  return value === 'guidance' || value === 'recorded' ? value : '';
}

function initialSceneRuntimeState(scene: CardlingScene): SceneRuntimeState {
  return {
    selectedNodeId: scene.cardling.anchor?.nodeId || scene.nodes[0]?.nodeId || '',
    nodes: scene.nodes.map((node, index) => ({
      nodeId: node.nodeId,
      label: node.label,
      status: 'idle',
      order: index,
      values: {},
    })),
    edges: parseSceneRuntimeEdges(scene.raw.edges),
    userEvents: [],
    updatedAt: new Date().toISOString(),
  };
}

function initialSceneHealth(scene: CardlingScene): SceneHealthReport {
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    renderedNodeCount: 0,
    declaredNodeCount: scene.nodes.length,
    missingNodeIds: [],
    placeholderCount: 0,
    blank: false,
    scriptErrors: [],
    issues: [],
  };
}

function normalizeSceneRuntimeState(
  value: unknown,
  scene: CardlingScene,
  fallback: SceneRuntimeState,
): SceneRuntimeState {
  const record = asRecord(value);
  const nodeRecords = Array.isArray(record.nodes) ? record.nodes.map(asRecord) : [];
  const fallbackById = new Map(fallback.nodes.map((node) => [node.nodeId, node]));
  const nodes: SceneRuntimeNodeState[] =
    nodeRecords.length > 0
      ? nodeRecords.reduce<SceneRuntimeNodeState[]>(
          (items, node, index) => {
            const nodeId = String(node.node_id ?? node.nodeId ?? node.id ?? '').trim();
            if (!nodeId) {
              return items;
            }
            const existing = fallbackById.get(nodeId);
            items.push({
              nodeId,
              label:
                optionalSceneString(node.label) ??
                existing?.label ??
                scene.nodes.find((item) => item.nodeId === nodeId)?.label,
              status: optionalSceneString(node.status) ?? existing?.status,
              order: sceneNumber(node.order, existing?.order ?? index),
              values: stringRecord(node.values ?? existing?.values ?? {}),
            });
            return items;
          },
          [],
        )
      : fallback.nodes;
  const edgeRecords = Array.isArray(record.edges) ? record.edges : undefined;
  return {
    selectedNodeId:
      optionalSceneString(record.selected_node_id ?? record.selectedNodeId) ??
      fallback.selectedNodeId,
    nodes,
    edges: edgeRecords ? parseSceneRuntimeEdges(edgeRecords) : fallback.edges,
    userEvents: fallback.userEvents,
    updatedAt: new Date().toISOString(),
  };
}

function mergeSceneRuntimeState(
  current: SceneRuntimeState,
  incoming: SceneRuntimeState,
): SceneRuntimeState {
  const incomingById = new Map(incoming.nodes.map((node) => [node.nodeId, node]));
  const mergedNodes = current.nodes.map((node) => ({
    ...node,
    ...incomingById.get(node.nodeId),
    values: {
      ...node.values,
      ...(incomingById.get(node.nodeId)?.values ?? {}),
    },
  }));
  for (const node of incoming.nodes) {
    if (!current.nodes.some((item) => item.nodeId === node.nodeId)) {
      mergedNodes.push(node);
    }
  }
  return {
    ...current,
    ...incoming,
    nodes: mergedNodes.sort((left, right) => left.order - right.order),
    userEvents: current.userEvents,
    updatedAt: new Date().toISOString(),
  };
}

function appendSceneRuntimeEvent(
  current: SceneRuntimeState,
  event: SceneRuntimeUserEvent,
): SceneRuntimeState {
  let nodes = current.nodes;
  const payload = asRecord(event.payload);
  const nextNodeId = event.nodeId || optionalSceneString(payload.nodeId) || '';
  if (event.type === 'node_reorder') {
    const order = Array.isArray(payload.order) ? payload.order.map(String) : [];
    if (order.length > 0) {
      const orderMap = new Map(order.map((nodeId, index) => [nodeId, index]));
      nodes = current.nodes
        .map((node) => ({
          ...node,
          order: orderMap.get(node.nodeId) ?? node.order,
        }))
        .sort((left, right) => left.order - right.order);
    }
  }
  if (event.type === 'state_change' && nextNodeId) {
    const values = stringRecord(payload.values);
    if (Object.keys(values).length > 0) {
      nodes = nodes.map((node) =>
        node.nodeId === nextNodeId
          ? { ...node, values: { ...node.values, ...values } }
          : node,
      );
    }
  }
  const selectedNodeId =
    event.type === 'node_click' || event.type === 'selection_change'
      ? nextNodeId || current.selectedNodeId
      : current.selectedNodeId;
  return {
    ...current,
    selectedNodeId,
    nodes,
    userEvents: [...current.userEvents, event].slice(-120),
    updatedAt: new Date().toISOString(),
  };
}

function normalizeSceneHealth(value: unknown, scene: CardlingScene): SceneHealthReport {
  const record = asRecord(value);
  const rawIssues = Array.isArray(record.issues) ? record.issues.map(asRecord) : [];
  const issues: SceneHealthIssue[] = rawIssues.map((issue) => ({
    code: String(issue.code ?? 'scene_issue'),
    message: String(issue.message ?? issue.description ?? issue.code ?? 'Scene issue'),
    severity:
      issue.severity === 'error' || issue.severity === 'info'
        ? issue.severity
        : 'warning',
  }));
  const missingNodeIds = Array.isArray(record.missing_node_ids)
    ? record.missing_node_ids.map(String)
    : Array.isArray(record.missingNodeIds)
      ? record.missingNodeIds.map(String)
      : [];
  const scriptErrors = Array.isArray(record.script_errors)
    ? record.script_errors.map(String)
    : Array.isArray(record.scriptErrors)
      ? record.scriptErrors.map(String)
      : [];
  const renderedNodeCount = sceneNumber(
    record.rendered_node_count ?? record.renderedNodeCount,
    sceneNumber(record.dom_node_count ?? record.domNodeCount, 0),
  );
  const declaredNodeCount = sceneNumber(
    record.declared_node_count ?? record.declaredNodeCount,
    scene.nodes.length,
  );
  const placeholderCount = sceneNumber(
    record.placeholder_count ?? record.placeholderCount,
    0,
  );
  const blank = sceneBoolean(record.blank) === true;
  const derivedIssues = [...issues];
  if (missingNodeIds.length > 0 && !derivedIssues.some((item) => item.code === 'missing_nodes')) {
    derivedIssues.push({
      code: 'missing_nodes',
      message: `Missing scene nodes: ${missingNodeIds.join(', ')}`,
      severity: 'warning',
    });
  }
  if (scriptErrors.length > 0 && !derivedIssues.some((item) => item.code === 'script_error')) {
    derivedIssues.push({
      code: 'script_error',
      message: scriptErrors[0] ?? 'Scene script error',
      severity: 'error',
    });
  }
  if (placeholderCount > 0 && !derivedIssues.some((item) => item.code === 'template_placeholder')) {
    derivedIssues.push({
      code: 'template_placeholder',
      message: `${placeholderCount} template placeholder(s) are visible.`,
      severity: 'warning',
    });
  }
  if (blank && !derivedIssues.some((item) => item.code === 'blank_scene')) {
    derivedIssues.push({
      code: 'blank_scene',
      message: 'Scene appears blank.',
      severity: 'error',
    });
  }
  const explicitOk = sceneBoolean(record.ok);
  const ok = explicitOk ?? (derivedIssues.length === 0);
  return {
    ok,
    checkedAt: String(record.checked_at ?? record.checkedAt ?? new Date().toISOString()),
    renderedNodeCount,
    declaredNodeCount,
    missingNodeIds,
    placeholderCount,
    blank,
    scriptErrors,
    issues: derivedIssues,
  };
}

function sceneHealthKey(health: SceneHealthReport) {
  return JSON.stringify({
    ok: health.ok,
    missingNodeIds: health.missingNodeIds,
    placeholderCount: health.placeholderCount,
    blank: health.blank,
    scriptErrors: health.scriptErrors,
    issues: health.issues.map((item) => [item.code, item.message, item.severity]),
  });
}

function parseSceneRuntimeEdges(value: unknown): SceneRuntimeEdgeState[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(asRecord).reduce<SceneRuntimeEdgeState[]>((items, edge) => {
    const from = String(edge.from ?? edge.source ?? '').trim();
    const to = String(edge.to ?? edge.target ?? '').trim();
    if (!from || !to) {
      return items;
    }
    items.push({
      from,
      to,
      status: optionalSceneString(edge.status),
    });
    return items;
  }, []);
}

function stringRecord(value: unknown): Record<string, string> {
  const record = asRecord(value);
  return Object.fromEntries(
    Object.entries(record).map(([key, item]) => [key, String(item ?? '')]),
  );
}

function optionalSceneString(value: unknown) {
  if (value == null) {
    return undefined;
  }
  const text = String(value).trim();
  return text || undefined;
}

function sceneNumber(value: unknown, fallback: number) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatSceneFeedbackRunPrompt(
  scene: CardlingScene,
  feedback: CardlingSceneFeedback[],
  language: AppLanguage,
) {
  const lines = feedback.map((item, index) => {
    const target = item.nodeId
      ? `${item.nodeLabel} (${item.nodeId})`
      : `${item.nodeLabel} (${item.stepId ?? 'overview'})`;
    return `${index + 1}. ${target}\n${item.text}`;
  });
  if (language === 'zh') {
    return [
      `请根据我在 Kabu Scene「${scene.title}」里提交的反馈继续处理这个 HTML 场景。`,
      '反馈如下：',
      ...lines,
      '请优先理解这些反馈对应的节点/步骤，给出修改方案并在需要时继续更新场景。',
    ].join('\n\n');
  }
  return [
    `Please continue the HTML scene "${scene.title}" based on the feedback I submitted in Kabu Scene.`,
    'Feedback:',
    ...lines,
    'Please map each item to its node/step, propose the update, and continue updating the scene when needed.',
  ].join('\n\n');
}

function formatSceneActionRunPrompt(
  scene: CardlingScene,
  payload: Record<string, unknown>,
  language: AppLanguage,
) {
  const action = String(payload.action ?? payload.intent ?? payload.text ?? '').trim();
  const nodeId = String(payload.nodeId ?? payload.node_id ?? '').trim();
  const context = JSON.stringify(
    {
      node_id: nodeId,
      values: payload.values ?? undefined,
      state: payload.state ?? undefined,
    },
    null,
    2,
  );
  if (!action && !nodeId) {
    return '';
  }
  if (language === 'zh') {
    return [
      `请继续处理 Kabu Scene「${scene.title}」里的交互请求。`,
      action ? `用户请求：${action}` : '',
      nodeId ? `关联节点：${nodeId}` : '',
      `场景上下文：\n${context}`,
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  return [
    `Please continue handling the interaction request in Kabu Scene "${scene.title}".`,
    action ? `User request: ${action}` : '',
    nodeId ? `Related node: ${nodeId}` : '',
    `Scene context:\n${context}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

function formatSceneKabuChatPrompt(
  scene: CardlingScene,
  {
    text,
    nodeId,
    nodeLabel,
    stepId,
    language,
  }: {
    text: string;
    nodeId: string;
    nodeLabel: string;
    stepId?: string;
    language: AppLanguage;
  },
) {
  const freeChat = !nodeId && stepId === 'free_chat';
  const target = nodeId
    ? `${nodeLabel} (${nodeId})`
    : freeChat
      ? nodeLabel
      : `${nodeLabel} (${stepId ?? 'overview'})`;
  if (language === 'zh') {
    return [
      `我正在 Kabu Scene「${scene.title}」里和卡布对话。`,
      `当前目标：${target}`,
      `我对卡布说：${text}`,
      freeChat
        ? '请把这句话作为对整个 HTML 场景的自由对话来处理，不要假定它绑定到某个节点。必要时解释、提出方案或更新场景。'
        : '请把这句话作为对当前场景节点/步骤的直接对话来处理，必要时继续解释、提出方案或更新场景。',
    ].join('\n\n');
  }
  return [
    `I am talking to Kabu inside Kabu Scene "${scene.title}".`,
    `Current target: ${target}`,
    `My message to Kabu: ${text}`,
    freeChat
      ? 'Treat this as a free conversation about the whole HTML scene, not bound to a specific node. Explain, propose changes, or update the scene when appropriate.'
      : 'Treat this as a direct conversation about the current scene node/step. Explain, propose changes, or update the scene when appropriate.',
  ].join('\n\n');
}

function sceneCardlingStyle(
  anchorRect: SceneAnchorRect | null,
  anchor?: CardlingSceneAnchor,
): CSSProperties {
  if (!anchorRect) {
    return {};
  }
  const placement = anchor?.placement ?? 'right';
  const offset = anchor?.offset ?? { x: 0, y: 0 };
  const rect = anchorRect.rect;
  const gap = 12;
  let left = rect.left + rect.width + gap;
  let top = rect.top + rect.height / 2 - 34;
  if (placement === 'left') {
    left = rect.left - 318 - gap;
  } else if (placement === 'top') {
    left = rect.left + rect.width / 2 - 110;
    top = rect.top - 92 - gap;
  } else if (placement === 'bottom') {
    left = rect.left + rect.width / 2 - 110;
    top = rect.top + rect.height + gap;
  }
  return {
    left: `clamp(12px, ${Math.round(left + offset.x)}px, calc(100% - 342px))`,
    top: `clamp(12px, ${Math.round(top + offset.y)}px, calc(100% - 232px))`,
  };
}

function sceneKabuDialogStyle(
  anchorRect: SceneAnchorRect | null,
  anchor?: CardlingSceneAnchor,
): CSSProperties {
  if (!anchorRect) {
    return { right: 18, bottom: 18 };
  }
  const placement = anchor?.placement ?? 'right';
  const rect = anchorRect.rect;
  const gap = 14;
  let left = rect.left + rect.width + gap;
  let top = rect.top + rect.height + gap;
  if (placement === 'left') {
    left = rect.left - 312 - gap;
    top = rect.top + rect.height + gap;
  } else if (placement === 'top') {
    left = rect.left + rect.width / 2 - 156;
    top = rect.top - 216 - gap;
  } else if (placement === 'bottom') {
    left = rect.left + rect.width / 2 - 156;
    top = rect.top + rect.height + gap;
  }
  return {
    left: `clamp(12px, ${Math.round(left)}px, calc(100% - 324px))`,
    top: `clamp(12px, ${Math.round(top)}px, calc(100% - 226px))`,
  };
}

function sceneFloatingCardlingStyle(
  position: CardlingScene['cardling']['position'],
): CSSProperties {
  if (typeof position === 'object' && position != null) {
    return {
      left: `clamp(12px, ${Math.round(Number(position.x) || 0)}px, calc(100% - 342px))`,
      top: `clamp(12px, ${Math.round(Number(position.y) || 0)}px, calc(100% - 232px))`,
    };
  }
  const value = typeof position === 'string' ? position : 'bottom-right';
  if (value === 'top-left') {
    return { left: 18, top: 18 };
  }
  if (value === 'top-right') {
    return { right: 18, top: 18 };
  }
  if (value === 'bottom-left') {
    return { left: 18, bottom: 18 };
  }
  return { right: 18, bottom: 18 };
}

function buildSceneSrcDoc(scene: CardlingScene) {
  const bridge = sceneBridgeScript(scene);
  const baseStyle = `
<style>
  :root { color-scheme: dark light; font-family: Inter, "Segoe UI", system-ui, sans-serif; }
  html, body { min-height: 100%; margin: 0; }
  body { background: #111; color: #f3f3f3; }
  [data-node-id] { scroll-margin: 72px; }
  [data-cardbush-active-node="true"] { outline: 2px solid rgba(134, 231, 178, 0.9); outline-offset: 3px; }
</style>`;
  const html = scene.html;
  if (/<html[\s>]/i.test(html)) {
    const withStyle = /<\/head>/i.test(html)
      ? html.replace(/<\/head>/i, `${baseStyle}</head>`)
      : `${baseStyle}${html}`;
    return /<\/body>/i.test(withStyle)
      ? withStyle.replace(/<\/body>/i, `${bridge}</body>`)
      : `${withStyle}${bridge}`;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${baseStyle}</head><body>${html}${bridge}</body></html>`;
}

function sceneBridgeScript(scene: CardlingScene) {
  const anchor = {
    nodeId: scene.cardling.anchor?.nodeId ?? '',
    selector: scene.cardling.anchor?.selector ?? '',
  };
  const declaredNodeIds = scene.nodes.map((node) => node.nodeId);
  return `<script>
(function () {
  var sceneId = ${JSON.stringify(scene.sceneId)};
  var anchor = ${JSON.stringify(anchor)};
  var declaredNodeIds = ${JSON.stringify(declaredNodeIds)};
  var scriptErrors = [];
  var lastHealthKey = '';
  var lastOrder = [];
  var inputTimer = 0;
  var healthTimer = 0;
  var drag = null;
  var interactionMode = 'node';
  function esc(value) {
    if (window.CSS && CSS.escape) return CSS.escape(value);
    return String(value).replace(/["\\\\]/g, '\\\\$&');
  }
  function post(type, payload, options) {
    var message = Object.assign({ source: 'cardbush-scene', sceneId: sceneId, type: type }, payload || {});
    if (options && options.state) message.state = collectState();
    if (options && options.health) message.health = computeHealth();
    parent.postMessage(message, '*');
  }
  function readOpenTarget(target) {
    var selector = [
      'a[href]',
      'button',
      '[role="button"]',
      '[data-cardbush-open]',
      '[data-open]',
      '[data-open-path]',
      '[data-file-path]',
      '[data-file]',
      '[data-path]',
      '[data-url]',
      '[data-href]',
      '[data-cardbush-url]',
      '[data-cardbush-path]'
    ].join(',');
    var element = target && target.closest ? target.closest(selector) : null;
    if (!element) return null;
    var names = [
      'data-cardbush-open',
      'data-open',
      'data-open-path',
      'data-file-path',
      'data-file',
      'data-path',
      'data-url',
      'data-href',
      'data-cardbush-url',
      'data-cardbush-path'
    ];
    var raw = '';
    var attr = '';
    for (var index = 0; index < names.length; index += 1) {
      raw = element.getAttribute(names[index]) || '';
      if (raw.trim()) {
        attr = names[index];
        break;
      }
    }
    if (!raw && element.tagName && element.tagName.toLowerCase() === 'a') {
      raw = element.getAttribute('href') || element.href || '';
      attr = 'href';
    }
    raw = String(raw || '').trim();
    if (!raw || raw === '#' || /^javascript:/i.test(raw)) return null;
    if (attr === 'href' && !/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[a-zA-Z]:[\\\\/]/.test(raw) && !/^\\\\\\\\/.test(raw)) {
      return null;
    }
    var kind = /url|href/i.test(attr) || /^https?:/i.test(raw) || /^[a-z][a-z0-9+.-]*:/i.test(raw) ? 'url' : 'path';
    if (/^file:/i.test(raw) || /^[a-zA-Z]:[\\\\/]/.test(raw) || /^\\\\\\\\/.test(raw)) {
      kind = 'path';
    }
    return {
      target: raw,
      url: kind === 'url' ? raw : '',
      path: kind === 'path' ? raw : '',
      kind: kind,
      nodeId: nodeIdFor(element),
      label: (element.textContent || '').trim().slice(0, 160)
    };
  }
  function nodeFor(nextAnchor) {
    var active = nextAnchor || anchor || {};
    if (active.nodeId) {
      var byId = document.querySelector('[data-node-id="' + esc(active.nodeId) + '"]');
      if (byId) return byId;
    }
    if (active.selector) {
      try { return document.querySelector(active.selector); } catch (_) {}
    }
    return document.querySelector('[data-node-id]');
  }
  function nodeIdFor(node) {
    var target = node && node.closest ? node.closest('[data-node-id]') : null;
    return target ? target.getAttribute('data-node-id') || '' : '';
  }
  function allNodeElements() {
    return Array.prototype.slice.call(document.querySelectorAll('[data-node-id]'));
  }
  function currentOrder() {
    return allNodeElements().map(function (node) { return node.getAttribute('data-node-id') || ''; }).filter(Boolean);
  }
  function sameOrder(left, right) {
    if (!left || !right || left.length !== right.length) return false;
    for (var index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return false;
    }
    return true;
  }
  function valuesFor(node) {
    var values = {};
    if (!node || !node.querySelectorAll) return values;
    node.querySelectorAll('input, textarea, select').forEach(function (field) {
      var key = field.name || field.id || field.getAttribute('data-key') || '';
      if (!key) return;
      if (field.type === 'checkbox') values[key] = field.checked ? 'true' : 'false';
      else if (field.type === 'radio') {
        if (field.checked) values[key] = field.value || 'on';
      } else values[key] = String(field.value || '');
    });
    return values;
  }
  function collectState() {
    var nodes = allNodeElements().map(function (node, index) {
      return {
        node_id: node.getAttribute('data-node-id') || '',
        label: node.getAttribute('data-label') || node.getAttribute('aria-label') || (node.textContent || '').trim().slice(0, 80),
        status: node.getAttribute('data-status') || '',
        order: index,
        values: valuesFor(node)
      };
    }).filter(function (node) { return !!node.node_id; });
    var edges = Array.prototype.slice.call(document.querySelectorAll('[data-edge-from][data-edge-to]')).map(function (edge) {
      return {
        from: edge.getAttribute('data-edge-from') || '',
        to: edge.getAttribute('data-edge-to') || '',
        status: edge.getAttribute('data-status') || ''
      };
    }).filter(function (edge) { return edge.from && edge.to; });
    return {
      selected_node_id: anchor.nodeId || '',
      nodes: nodes,
      edges: edges
    };
  }
  function countPlaceholders(text) {
    var count = 0;
    var index = text.indexOf('\${');
    while (index >= 0) {
      count += 1;
      index = text.indexOf('\${', index + 2);
    }
    return count;
  }
  function computeHealth() {
    var domIds = currentOrder();
    var missing = declaredNodeIds.filter(function (id) { return domIds.indexOf(id) < 0; });
    var text = (document.body && document.body.innerText ? document.body.innerText : '').trim();
    var interactiveCount = document.querySelectorAll('svg, canvas, img, button, input, textarea, select, [data-node-id]').length;
    var blank = text.length < 2 && interactiveCount === 0;
    var placeholderCount = countPlaceholders(text);
    var issues = [];
    if (missing.length > 0) issues.push({ code: 'missing_nodes', severity: 'warning', message: 'Missing scene nodes: ' + missing.join(', ') });
    if (scriptErrors.length > 0) issues.push({ code: 'script_error', severity: 'error', message: scriptErrors[scriptErrors.length - 1] });
    if (placeholderCount > 0) issues.push({ code: 'template_placeholder', severity: 'warning', message: placeholderCount + ' template placeholder(s) are visible.' });
    if (blank) issues.push({ code: 'blank_scene', severity: 'error', message: 'Scene appears blank.' });
    return {
      ok: issues.length === 0,
      checked_at: new Date().toISOString(),
      rendered_node_count: domIds.length,
      declared_node_count: declaredNodeIds.length,
      missing_node_ids: missing,
      placeholder_count: placeholderCount,
      blank: blank,
      script_errors: scriptErrors.slice(-5),
      issues: issues
    };
  }
  function postHealthIfChanged() {
    var health = computeHealth();
    var key = JSON.stringify({
      ok: health.ok,
      missing: health.missing_node_ids,
      placeholders: health.placeholder_count,
      blank: health.blank,
      errors: health.script_errors
    });
    if (key === lastHealthKey) return;
    lastHealthKey = key;
    post('scene_health', {}, { state: true, health: true });
  }
  function scheduleHealth() {
    clearTimeout(healthTimer);
    healthTimer = setTimeout(postHealthIfChanged, 180);
  }
  function postStateChange(nodeId, values) {
    post('state_change', { nodeId: nodeId || anchor.nodeId || '', values: values || {} }, { state: true, health: true });
    scheduleHealth();
  }
  function parseColor(value) {
    if (!value || value === 'transparent') return null;
    var match = String(value).match(/rgba?\\(([^)]+)\\)/i);
    if (!match) return null;
    var parts = match[1].split(',').map(function (part) { return Number(String(part).trim().replace('%', '')); });
    if (parts.length < 3 || !isFinite(parts[0]) || !isFinite(parts[1]) || !isFinite(parts[2])) return null;
    var alpha = parts.length > 3 && isFinite(parts[3]) ? parts[3] : 1;
    if (alpha <= 0.04) return null;
    return { r: parts[0], g: parts[1], b: parts[2], a: alpha };
  }
  function backgroundToneFor(node) {
    var current = node;
    while (current && current.nodeType === 1) {
      var color = parseColor(getComputedStyle(current).backgroundColor);
      if (color) {
        var luminance = (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
        return luminance > 0.56 ? 'light' : 'dark';
      }
      current = current.parentElement;
    }
    var bodyColor = parseColor(getComputedStyle(document.body).backgroundColor) || parseColor(getComputedStyle(document.documentElement).backgroundColor);
    if (!bodyColor) return 'dark';
    var bodyLuminance = (0.2126 * bodyColor.r + 0.7152 * bodyColor.g + 0.0722 * bodyColor.b) / 255;
    return bodyLuminance > 0.56 ? 'light' : 'dark';
  }
  function reportAnchor(nextAnchor) {
    if (nextAnchor) anchor = Object.assign({}, anchor, nextAnchor);
    var node = nodeFor(anchor);
    document.querySelectorAll('[data-cardbush-active-node="true"]').forEach(function (item) {
      item.removeAttribute('data-cardbush-active-node');
    });
    if (!node) {
      post('anchor_missing', { nodeId: anchor.nodeId || '' });
      return;
    }
    node.setAttribute('data-cardbush-active-node', 'true');
    var rect = node.getBoundingClientRect();
    post('anchor_rect', {
      nodeId: node.getAttribute('data-node-id') || anchor.nodeId || '',
      tone: backgroundToneFor(node),
      rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    });
  }
  function revealAnchor(nextAnchor) {
    if (nextAnchor) anchor = Object.assign({}, anchor, nextAnchor);
    var node = nodeFor(anchor);
    if (!node) {
      reportAnchor(anchor);
      return;
    }
    try {
      node.scrollIntoView({
        block: 'center',
        inline: 'center',
        behavior: 'smooth'
      });
    } catch (_) {
      try { node.scrollIntoView(true); } catch (__) {}
    }
    reportAnchor(anchor);
    [80, 180, 360, 620].forEach(function (delay) {
      setTimeout(function () { reportAnchor(anchor); }, delay);
    });
  }
  window.cardbushScene = {
    emit: function (type, payload) {
      var nextPayload = Object.assign({}, payload || {});
      if (!nextPayload.nodeId) nextPayload.nodeId = nodeIdFor(document.activeElement) || anchor.nodeId || '';
      post(String(type || 'state_change'), nextPayload, { state: true, health: true });
    },
    setState: function (nextState) {
      post('state_change', { state: nextState || {} }, { state: true, health: true });
    },
    requestLLM: function (payload) {
      post('request_llm_action', payload || {}, { state: true, health: true });
    },
    toast: function (message) {
      post('scene_toast', { message: String(message || '') });
    },
    open: function (target, options) {
      var payload = Object.assign({}, options || {}, { target: String(target || '') });
      post('external_url', payload);
    },
    getState: collectState,
    checkHealth: function () {
      var health = computeHealth();
      post('scene_health', {}, { state: true, health: true });
      return health;
    }
  };
  window.onerror = function (message, source, lineno, colno, error) {
    var text = String(message || 'Script error');
    scriptErrors.push(text);
    post('scene_error', { message: text, source: source || '', line: lineno || 0, column: colno || 0, stack: error && error.stack ? String(error.stack) : '' }, { state: true, health: true });
    scheduleHealth();
  };
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason && event.reason.message ? event.reason.message : event.reason;
    var text = String(reason || 'Unhandled promise rejection');
    scriptErrors.push(text);
    post('scene_error', { message: text }, { state: true, health: true });
    scheduleHealth();
  });
  document.addEventListener('click', function (event) {
    var openTarget = readOpenTarget(event.target);
    if (openTarget) {
      event.preventDefault();
      post('external_url', openTarget);
      return;
    }
    if (interactionMode === 'free_chat') return;
    var nodeId = nodeIdFor(event.target);
    if (nodeId) {
      anchor.nodeId = nodeId;
      reportAnchor(anchor);
      var label = event.target && event.target.textContent ? event.target.textContent.trim().slice(0, 160) : '';
      post('node_click', { nodeId: nodeId, label: label }, { state: true, health: true });
      post('selection_change', { nodeId: nodeId, label: label }, { state: true, health: false });
    }
  }, true);
  document.addEventListener('pointerdown', function (event) {
    if (interactionMode === 'free_chat') return;
    var nodeId = nodeIdFor(event.target);
    if (!nodeId) return;
    drag = {
      nodeId: nodeId,
      startX: event.clientX,
      startY: event.clientY,
      started: false,
      order: currentOrder()
    };
  }, true);
  document.addEventListener('pointermove', function (event) {
    if (!drag || drag.started) return;
    var distance = Math.abs(event.clientX - drag.startX) + Math.abs(event.clientY - drag.startY);
    if (distance <= 8) return;
    drag.started = true;
    post('node_drag_start', { nodeId: drag.nodeId, order: drag.order }, { state: true, health: false });
  }, true);
  document.addEventListener('pointerup', function () {
    if (!drag) return;
    var current = currentOrder();
    if (drag.started) {
      post('node_drag_end', { nodeId: drag.nodeId, order: current }, { state: true, health: true });
      if (!sameOrder(drag.order, current)) {
        post('node_reorder', { nodeId: drag.nodeId, previousOrder: drag.order, order: current }, { state: true, health: true });
      }
    }
    drag = null;
  }, true);
  document.addEventListener('change', function (event) {
    var node = event.target && event.target.closest ? event.target.closest('[data-node-id]') : null;
    if (!node) return;
    postStateChange(node.getAttribute('data-node-id') || '', valuesFor(node));
  }, true);
  document.addEventListener('input', function (event) {
    var node = event.target && event.target.closest ? event.target.closest('[data-node-id]') : null;
    if (!node) return;
    clearTimeout(inputTimer);
    inputTimer = setTimeout(function () {
      postStateChange(node.getAttribute('data-node-id') || '', valuesFor(node));
    }, 280);
  }, true);
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    var values = {};
    new FormData(form).forEach(function (value, key) {
      values[key] = String(value);
    });
    post('form_submit', { nodeId: nodeIdFor(form) || anchor.nodeId || '', values: values }, { state: true, health: true });
  }, true);
  window.addEventListener('hashchange', function () {
    post('route_update', { route: location.hash || location.pathname || '' }, { state: true, health: true });
  });
  window.addEventListener('popstate', function () {
    post('route_update', { route: location.hash || location.pathname || '' }, { state: true, health: true });
  });
  if (window.MutationObserver) {
    new MutationObserver(function () {
      var current = currentOrder();
      if (lastOrder.length > 0 && !sameOrder(lastOrder, current)) {
        post('node_reorder', { previousOrder: lastOrder, order: current }, { state: true, health: true });
      }
      lastOrder = current;
      scheduleHealth();
    }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-node-id', 'data-status'] });
  }
  window.addEventListener('message', function (event) {
    var data = event.data || {};
    if (data.source !== 'cardbush-scene-host' || data.sceneId !== sceneId) return;
    if (data.type === 'set_interaction_mode') {
      interactionMode = data.mode === 'free_chat' ? 'free_chat' : 'node';
      if (interactionMode === 'free_chat') {
        drag = null;
        document.querySelectorAll('[data-cardbush-active-node="true"]').forEach(function (item) {
          item.removeAttribute('data-cardbush-active-node');
        });
      }
      return;
    }
    if (data.type === 'set_anchor') {
      if (data.reveal) revealAnchor(data.anchor || {});
      else reportAnchor(data.anchor || {});
    }
  });
  window.addEventListener('resize', function () { reportAnchor(anchor); });
  window.addEventListener('scroll', function () { reportAnchor(anchor); }, true);
  setTimeout(function () {
    lastOrder = currentOrder();
    reportAnchor(anchor);
    post('scene_ready', {}, { state: true, health: true });
    postHealthIfChanged();
  }, 30);
})();
</script>`;
}

function quickSideItems({
  conversations,
  activeConversationId,
  messages,
  projectEntries,
  activeProjectDir,
  language,
}: {
  conversations: ConversationSummary[];
  activeConversationId: string;
  messages: ChatMessage[];
  projectEntries: ProjectEntry[];
  activeProjectDir?: string;
  language: AppLanguage;
}): QuickSideItem[] {
  const otherConversations = conversations
    .filter((item) => item.id !== activeConversationId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (otherConversations.length > 0) {
    return otherConversations.slice(0, 5).map((conversation) => {
      const preview = conversation.preview.trim();
      const title = fallbackTitle(conversation.title, preview, language);
      return {
        id: `conversation-${conversation.id}`,
        icon: <MessageSquare size={17} />,
        title,
        subtitle: preview || (language === 'zh' ? '上一会话' : 'Previous chat'),
        payload: {
          kind: 'text',
          title,
          value: preview
            ? language === 'zh'
              ? `来自「${title}」：\n${preview}`
              : `From "${title}":\n${preview}`
            : title,
        },
        jumpTarget: {
          kind: 'conversation',
          conversationId: conversation.id,
        },
      };
    });
  }

  const previousMessages = messages
    .filter((message) => message.content.trim())
    .slice(0, Math.max(0, messages.length - 1))
    .reverse()
    .slice(0, 5);
  if (previousMessages.length > 0) {
    return previousMessages.map((message) => {
      const content = message.content.trim();
      const title = compactTitle(content, language);
      return {
        id: `message-${message.id}`,
        icon:
          message.role === 'user' ? <MessageSquare size={17} /> : <Sparkles size={17} />,
        title,
        subtitle: content,
        payload: { kind: 'text', title, value: content },
        jumpTarget: { kind: 'message', messageId: message.id },
      };
    });
  }

  if (!activeProjectDir?.trim()) {
    return [
      {
        id: 'empty-project',
        icon: <FolderOpen size={17} />,
        title: language === 'zh' ? '暂无可加载内容' : 'Nothing to load',
        subtitle:
          language === 'zh'
            ? '打开项目后，这里会显示项目根目录文件和文件夹'
            : 'Open a project to show root files and folders here',
      },
    ];
  }

  if (projectEntries.length === 0) {
    return [
      {
        id: 'empty-root',
        icon: <FolderOpen size={17} />,
        title: language === 'zh' ? '项目根目录为空' : 'Project root is empty',
        subtitle:
          language === 'zh'
            ? '没有可拖入输入框的文件或文件夹'
            : 'No files or folders are available to load',
      },
    ];
  }

  return projectEntries.slice(0, 12).map((entry) => ({
    id: `project-${entry.path}`,
    icon: entry.kind === 'folder' ? <FolderOpen size={17} /> : <Clipboard size={17} />,
    title: entry.name,
    subtitle: language === 'zh'
      ? entry.kind === 'folder'
        ? '项目文件夹'
        : '项目文件'
      : entry.kind === 'folder'
        ? 'Project folder'
        : 'Project file',
    payload: {
      kind: entry.kind,
      title: entry.name,
      value: entry.path,
    },
    jumpTarget: { kind: 'path', path: entry.path },
  }));
}

function fallbackTitle(title: string, preview: string, language: AppLanguage) {
  const normalized = title.trim();
  if (
    normalized &&
    normalized !== '新对话' &&
    normalized !== '新会话' &&
    normalized !== '未命名对话'
  ) {
    return compactTitle(normalized, language);
  }
  if (preview.trim()) {
    return compactTitle(preview, language);
  }
  return language === 'zh' ? '上一会话' : 'Previous chat';
}

function compactTitle(value: string, language: AppLanguage) {
  const title = value.trim().replace(/\s+/g, ' ');
  if (!title) {
    return language === 'zh' ? '上一条消息' : 'Previous message';
  }
  return title.length <= 20 ? title : `${title.slice(0, 20)}...`;
}

function formatChangeTimestamp(value: string | undefined, language: AppLanguage) {
  if (!value) {
    return language === 'zh' ? '完成后' : 'After completion';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return language === 'zh' ? '完成后' : 'After completion';
  }
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function quickPayloadText(payload: QuickLoadPayload) {
  const value = payload.value.trim();
  if (!value) {
    return '';
  }
  if (payload.kind === 'text') {
    return value;
  }
  const suffix = payload.kind === 'folder' && !value.endsWith('/') ? '/' : '';
  return `@${value}${suffix}`;
}

function QuickSideDock({
  language,
  items,
  queuedMessages,
  onLoad,
  onJump,
  onEditQueuedMessage,
  onDeleteQueuedMessage,
  onGuideQueuedMessage,
}: {
  language: AppLanguage;
  items: QuickSideItem[];
  queuedMessages: QueuedChatMessage[];
  onLoad: (payload: QuickLoadPayload) => void;
  onJump: (target: QuickJumpTarget) => void;
  onEditQueuedMessage: (item: QueuedChatMessage) => void;
  onDeleteQueuedMessage: (queuedId: string) => void;
  onGuideQueuedMessage: (queuedId: string) => Promise<void>;
}) {
  const [visible, setVisible] = useState(false);
  const [guidingQueuedId, setGuidingQueuedId] = useState('');
  const dockRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!visible) {
      return undefined;
    }
    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (dockRef.current?.contains(target)) {
        return;
      }
      setVisible(false);
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
    };
  }, [visible]);
  return (
    <aside
      ref={dockRef}
      className={`quick-side-zone ${visible ? 'open' : ''}`}
      onPointerEnter={() => setVisible(true)}
      onPointerLeave={() => setVisible(false)}
      onClick={() => setVisible(true)}
    >
      <div className="quick-side-hotspot" />
      <div className="quick-side-handle" />
      <div className="quick-side-panel">
        <header className="quick-side-header">
          <ChevronsLeft size={17} />
          <div>
            <strong>{language === 'zh' ? '快速上下文' : 'Quick context'}</strong>
            <span>
              {language === 'zh'
                ? '拖拽加载，箭头跳转'
                : 'Drag to load, arrow to jump'}
            </span>
          </div>
        </header>
        <div className="quick-side-list">
          {queuedMessages.length > 0 && (
            <section className="quick-queue-section">
              <header>
                <Clock3 size={14} />
                <strong>
                  {language === 'zh'
                    ? `排队消息 ${queuedMessages.length}`
                    : `${queuedMessages.length} queued`}
                </strong>
              </header>
              <div className="quick-queue-list">
                {queuedMessages.map((item) => (
                  <QueuedSideItem
                    key={item.id}
                    item={item}
                    language={language}
                    guiding={guidingQueuedId === item.id}
                    onEdit={() => {
                      onEditQueuedMessage(item);
                      setVisible(false);
                    }}
                    onDelete={() => onDeleteQueuedMessage(item.id)}
                    onGuide={async () => {
                      setGuidingQueuedId(item.id);
                      try {
                        await onGuideQueuedMessage(item.id);
                      } finally {
                        setGuidingQueuedId('');
                      }
                    }}
                  />
                ))}
              </div>
            </section>
          )}
          {items.map((item) => (
            <QuickSideListItem
              key={item.id}
              item={item}
              language={language}
              onLoad={(payload) => {
                onLoad(payload);
                setVisible(false);
              }}
              onJump={(target) => {
                onJump(target);
                setVisible(false);
              }}
            />
          ))}
        </div>
      </div>
    </aside>
  );
}

function QueuedSideItem({
  item,
  language,
  guiding,
  onEdit,
  onDelete,
  onGuide,
}: {
  item: QueuedChatMessage;
  language: AppLanguage;
  guiding: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onGuide: () => Promise<void>;
}) {
  const { imagePaths, text } = splitMessageImages(item.text);
  const preview = text || item.text;
  const title = compactTitle(preview, language);
  const imageHint =
    imagePaths.length > 0
      ? language === 'zh'
        ? `${imagePaths.length} 张图片`
        : `${imagePaths.length} image${imagePaths.length === 1 ? '' : 's'}`
      : '';
  return (
    <article className="quick-queue-item">
      <div className="quick-queue-main">
        <MessageSquare size={15} />
        <span>
          <strong>{title}</strong>
          <small>{imageHint || preview}</small>
        </span>
      </div>
      <div className="quick-queue-actions">
        <button type="button" onClick={onEdit}>
          <Edit3 size={13} />
          <span>{language === 'zh' ? '撤回编辑' : 'Edit'}</span>
        </button>
        <button type="button" onClick={() => void onGuide()} disabled={guiding}>
          {guiding ? <LoaderCircle size={13} /> : <Sparkles size={13} />}
          <span>{language === 'zh' ? '引导' : 'Guide'}</span>
        </button>
        <button type="button" onClick={onDelete}>
          <Trash2 size={13} />
          <span>{language === 'zh' ? '删除' : 'Delete'}</span>
        </button>
      </div>
    </article>
  );
}

function QuickSideListItem({
  item,
  language,
  onLoad,
  onJump,
}: {
  item: QuickSideItem;
  language: AppLanguage;
  onLoad: (payload: QuickLoadPayload) => void;
  onJump: (target: QuickJumpTarget) => void;
}) {
  const enabled = item.payload != null;
  const canJump = item.jumpTarget != null;
  return (
    <article
      className={`quick-side-item ${enabled ? 'enabled' : ''}`}
      draggable={enabled}
      onDragStart={(event) => {
        if (!item.payload) {
          return;
        }
        event.dataTransfer.effectAllowed = 'copy';
        event.dataTransfer.setData(
          'application/x-cardbush-quickload',
          JSON.stringify(item.payload),
        );
        event.dataTransfer.setData('text/plain', quickPayloadText(item.payload));
      }}
    >
      <button
        className="quick-side-item-main"
        type="button"
        disabled={!enabled}
        onClick={() => item.payload && onLoad(item.payload)}
      >
        {item.icon}
        <span>
          <strong>{item.title}</strong>
          <small>{item.subtitle}</small>
        </span>
      </button>
      {canJump && (
        <button
          className="quick-side-jump"
          type="button"
          draggable={false}
          title={language === 'zh' ? '跳转' : 'Jump'}
          aria-label={language === 'zh' ? '跳转' : 'Jump'}
          onClick={(event) => {
            event.stopPropagation();
            if (item.jumpTarget) {
              onJump(item.jumpTarget);
            }
          }}
        >
          <ArrowRight size={14} />
        </button>
      )}
    </article>
  );
}

function ConsoleDock({
  mode,
  language,
  activeProjectDir,
  onClose,
}: {
  mode: ConsoleMode;
  language: AppLanguage;
  activeProjectDir?: string;
  onClose: () => void;
}) {
  const [gitInfo, setGitInfo] = useState<GitInfo | null>(null);
  const [gitError, setGitError] = useState('');
  const [gitLoading, setGitLoading] = useState(false);
  const [gitRefreshKey, setGitRefreshKey] = useState(0);
  const [gitBranches, setGitBranches] = useState<string[]>([]);
  const [targetBranch, setTargetBranch] = useState('');
  const [commitMessage, setCommitMessage] = useState('');
  const [gitActionOutput, setGitActionOutput] = useState('');
  const [gitActionLoading, setGitActionLoading] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function loadGitInfo() {
      if (mode !== 'git') {
        return;
      }
      const root = activeProjectDir?.trim();
      if (!root || !window.cardbushDesktop?.gitInfo) {
        setGitInfo(null);
        setGitError(language === 'zh' ? '请先打开一个 Git 项目' : 'Open a Git project first');
        return;
      }
      setGitLoading(true);
      try {
        const info = await window.cardbushDesktop.gitInfo(root);
        if (cancelled) {
          return;
        }
        setGitInfo(info);
        setGitError(info.error ?? '');
        setTargetBranch(info.branch);
        if (!info.error && window.cardbushDesktop?.gitBranches) {
          const branches = await window.cardbushDesktop.gitBranches(root).catch(() => []);
          if (!cancelled) {
            setGitBranches(branches);
          }
        } else {
          setGitBranches([]);
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        setGitInfo(null);
        setGitError(error instanceof Error ? error.message : String(error));
      } finally {
        if (!cancelled) {
          setGitLoading(false);
        }
      }
    }
    void loadGitInfo();
    return () => {
      cancelled = true;
    };
  }, [activeProjectDir, gitRefreshKey, language, mode]);

  const terminalTitle = language === 'zh' ? '终端控制台' : 'Terminal console';
  const gitTitle = language === 'zh' ? 'Git 控制台' : 'Git console';
  const canRunGitAction = Boolean(
    mode === 'git' &&
      activeProjectDir?.trim() &&
      gitInfo &&
      !gitInfo.missing &&
      !gitInfo.error,
  );

  const runGitAction = useCallback(
    async (
      action: 'checkout' | 'commit' | 'push',
      runner: () => Promise<{ output?: string; branch?: string } | void>,
    ) => {
      if (!canRunGitAction || gitActionLoading) {
        return;
      }
      setGitActionLoading(action);
      setGitActionOutput('');
      setGitError('');
      try {
        const result = await runner();
        setGitActionOutput(result?.output ?? '');
        setGitRefreshKey((value) => value + 1);
      } catch (error) {
        setGitError(error instanceof Error ? error.message : String(error));
      } finally {
        setGitActionLoading('');
      }
    },
    [canRunGitAction, gitActionLoading],
  );

  const checkoutBranch = useCallback(() => {
    const root = activeProjectDir?.trim();
    const branch = targetBranch.trim();
    if (!root || !branch) {
      setGitError(language === 'zh' ? '请输入要切换的分支' : 'Enter a branch to switch to');
      return;
    }
    void runGitAction('checkout', () => window.cardbushDesktop!.gitCheckout(root, branch));
  }, [activeProjectDir, language, runGitAction, targetBranch]);

  const commitChanges = useCallback(() => {
    const root = activeProjectDir?.trim();
    const message = commitMessage.trim();
    if (!root || !message) {
      setGitError(language === 'zh' ? '请输入提交信息' : 'Enter a commit message');
      return;
    }
    void runGitAction('commit', async () => {
      const result = await window.cardbushDesktop!.gitCommit(root, message);
      setCommitMessage('');
      return result;
    });
  }, [activeProjectDir, commitMessage, language, runGitAction]);

  const pushBranch = useCallback(() => {
    const root = activeProjectDir?.trim();
    if (!root) {
      return;
    }
    void runGitAction('push', () => window.cardbushDesktop!.gitPush(root));
  }, [activeProjectDir, runGitAction]);

  return (
    <section className={`console-dock ${mode}`}>
      <header className="console-header">
        {mode === 'git' ? <GitBranch size={16} /> : <Terminal size={16} />}
        <strong>{mode === 'git' ? gitTitle : terminalTitle}</strong>
        <span>
          {mode === 'git'
            ? gitInfo?.branch || gitError || activeProjectDir || ''
            : activeProjectDir || (language === 'zh' ? '当前工作区' : 'Current workspace')}
        </span>
        {mode === 'git' && (
          <button
            type="button"
            onClick={() => setGitRefreshKey((value) => value + 1)}
            aria-label="refresh git"
            disabled={gitLoading}
          >
            <RefreshCw size={15} />
          </button>
        )}
        <button type="button" onClick={onClose} aria-label="close console">
          <ChevronDown size={18} />
        </button>
      </header>
      {mode === 'git' ? (
        <div className="console-content git">
          {gitInfo ? (
            <>
              <ConsoleRow label={language === 'zh' ? '仓库' : 'Repository'} value={gitInfo.root} />
              <ConsoleRow label={language === 'zh' ? '分支' : 'Branch'} value={gitInfo.branch || 'HEAD'} />
              <ConsoleRow
                label={language === 'zh' ? '变更' : 'Changes'}
                value={
                  gitInfo.changedFiles.length === 0
                    ? language === 'zh'
                      ? '干净'
                      : 'Clean'
                    : language === 'zh'
                      ? `${gitInfo.changedFiles.length} 个文件`
                      : `${gitInfo.changedFiles.length} files`
                }
              />
              {gitError && <p className="console-error">{gitError}</p>}
              {!gitInfo.error && !gitInfo.missing && (
                <div className="git-actions">
                  <div className="git-action-row">
                    <input
                      list="git-branches"
                      value={targetBranch}
                      placeholder={language === 'zh' ? '分支名' : 'Branch name'}
                      onChange={(event) => setTargetBranch(event.currentTarget.value)}
                    />
                    <datalist id="git-branches">
                      {gitBranches.map((branch) => (
                        <option key={branch} value={branch} />
                      ))}
                    </datalist>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={Boolean(gitActionLoading)}
                      onClick={checkoutBranch}
                    >
                      {gitActionLoading === 'checkout' ? <LoaderCircle size={14} /> : <GitBranch size={14} />}
                      {language === 'zh' ? '切换分支' : 'Switch'}
                    </button>
                  </div>
                  <div className="git-action-row">
                    <input
                      value={commitMessage}
                      placeholder={language === 'zh' ? '提交信息' : 'Commit message'}
                      onChange={(event) => setCommitMessage(event.currentTarget.value)}
                    />
                    <button
                      className="primary-button"
                      type="button"
                      disabled={Boolean(gitActionLoading)}
                      onClick={commitChanges}
                    >
                      {gitActionLoading === 'commit' ? <LoaderCircle size={14} /> : <CheckCircle2 size={14} />}
                      {language === 'zh' ? '提交' : 'Commit'}
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={Boolean(gitActionLoading)}
                      onClick={pushBranch}
                    >
                      {gitActionLoading === 'push' ? <LoaderCircle size={14} /> : <ArrowUp size={14} />}
                      {language === 'zh' ? '推送' : 'Push'}
                    </button>
                  </div>
                  {gitActionOutput && <pre className="git-action-output">{gitActionOutput}</pre>}
                </div>
              )}
              {gitInfo.changedFiles.length > 0 ? (
                <div className="git-file-list">
                  {gitInfo.changedFiles.map((file) => (
                    <div className="git-file-row" key={`${file.status}:${file.path}`}>
                      <code>{file.status}</code>
                      <span title={file.path}>{file.path}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="console-empty">
                  {language === 'zh' ? '当前没有未提交变更。' : 'No uncommitted changes.'}
                </p>
              )}
            </>
          ) : (
            <p className="console-empty">
              {gitLoading
                ? language === 'zh'
                  ? '正在读取 Git 信息...'
                  : 'Reading Git info...'
                : gitError}
            </p>
          )}
        </div>
      ) : (
        <EmbeddedTerminal language={language} activeProjectDir={activeProjectDir} />
      )}
    </section>
  );
}

function EmbeddedTerminal({
  language,
  activeProjectDir,
}: {
  language: AppLanguage;
  activeProjectDir?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTermInstance | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const [session, setSession] = useState<TerminalSessionInfo | null>(null);
  const [status, setStatus] = useState('');

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return undefined;
    }
    const terminalContainer = container;
    let disposed = false;
    let terminal: XTermInstance | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let offData: (() => void) | null = null;
    let offExit: (() => void) | null = null;
    let writeDisposable: { dispose: () => void } | null = null;
    let resizeDisposable: { dispose: () => void } | null = null;

    async function bootTerminal() {
      const { Terminal: XTerm } = await import('@xterm/xterm');
      if (disposed) {
        return;
      }
      terminal = new XTerm({
        allowProposedApi: false,
        convertEol: true,
        cursorBlink: true,
        cursorStyle: 'bar',
        fontFamily: '"Cascadia Mono", Consolas, "Courier New", monospace',
        fontSize: 13,
        lineHeight: 1.18,
        scrollback: 6000,
        theme: {
          background: '#111111',
          foreground: '#f3f3f3',
          cursor: '#f3f3f3',
          selectionBackground: '#305f9f',
          black: '#111111',
          brightBlack: '#666666',
          red: '#f14c4c',
          green: '#23d18b',
          yellow: '#f5f543',
          blue: '#3b8eea',
          magenta: '#d670d6',
          cyan: '#29b8db',
          white: '#e5e5e5',
          brightWhite: '#ffffff',
        },
      });
      terminal.open(terminalContainer);
      terminalRef.current = terminal;

      if (!window.cardbushDesktop?.terminalCreate) {
        terminal.writeln(
          language === 'zh'
            ? '当前预览环境没有 Electron 终端接口，请在桌面窗口中运行。'
            : 'The Electron terminal API is unavailable in preview. Run the desktop window.',
        );
        return;
      }

      writeDisposable = terminal.onData((data) => {
        const id = sessionIdRef.current;
        if (!id) {
          return;
        }
        window.cardbushDesktop?.terminalWrite(id, data);
      });
      resizeDisposable = terminal.onResize(({ cols, rows }) => {
        const id = sessionIdRef.current;
        if (!id) {
          return;
        }
        window.cardbushDesktop?.terminalResize(id, cols, rows);
      });
      offData = window.cardbushDesktop.onTerminalData((payload) => {
        if (payload.id !== sessionIdRef.current || !terminal) {
          return;
        }
        terminal.write(payload.data);
      });
      offExit = window.cardbushDesktop.onTerminalExit((payload) => {
        if (payload.id !== sessionIdRef.current) {
          return;
        }
        setStatus(
          language === 'zh'
            ? `终端已退出，退出码 ${payload.exitCode ?? '-'}`
            : `Terminal exited with code ${payload.exitCode ?? '-'}`,
        );
      });

      function resizeToContainer() {
        if (!terminal) {
          return;
        }
        const width = Math.max(1, terminalContainer.clientWidth - 18);
        const height = Math.max(1, terminalContainer.clientHeight - 12);
        const cols = Math.max(20, Math.floor(width / 8));
        const rows = Math.max(6, Math.floor(height / 16));
        if (terminal.cols !== cols || terminal.rows !== rows) {
          terminal.resize(cols, rows);
        }
      }

      resizeObserver = new ResizeObserver(resizeToContainer);
      resizeObserver.observe(terminalContainer);
      resizeToContainer();

      window.cardbushDesktop
        .terminalCreate(activeProjectDir)
        .then((nextSession) => {
          if (disposed) {
            void window.cardbushDesktop?.terminalClose(nextSession.id);
            return;
          }
          sessionIdRef.current = nextSession.id;
          setSession(nextSession);
          setStatus('');
          resizeToContainer();
          terminal?.focus();
        })
        .catch((error) => {
          const message = error instanceof Error ? error.message : String(error);
          setStatus(message);
          terminal?.writeln(message);
        });
    }

    void bootTerminal()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        setStatus(message);
      });

    return () => {
      disposed = true;
      const id = sessionIdRef.current;
      sessionIdRef.current = null;
      setSession(null);
      resizeObserver?.disconnect();
      offData?.();
      offExit?.();
      writeDisposable?.dispose();
      resizeDisposable?.dispose();
      terminal?.dispose();
      terminalRef.current = null;
      if (id) {
        void window.cardbushDesktop?.terminalClose(id);
      }
    };
  }, [activeProjectDir, language]);

  return (
    <div className="console-content terminal native-terminal-shell">
      <div className="native-terminal-tabs">
        <div className="native-terminal-tab active">
          <Terminal size={14} />
          <span>{compactPath(session?.cwd ?? activeProjectDir)}</span>
        </div>
        <button type="button" aria-label="new terminal tab" disabled>
          <Plus size={16} />
        </button>
      </div>
      <div className="native-terminal-viewport" ref={containerRef} />
      {status && <div className="native-terminal-status">{status}</div>}
    </div>
  );
}

function ConsoleRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="console-row">
      <span>{label}</span>
      <code>{value}</code>
    </div>
  );
}

function BackendLoading() {
  return (
    <div className="loading-view">
      <div className="loading-icon">
        <LoaderCircle size={36} />
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
  selectedModel,
  availableModels,
  selectedRuntimeProfile,
  runtimeProfiles,
  referencePlanMode,
  activeProjectDir,
  projectContext,
  skills = [],
  disabledSkillNames,
  onToggleSkill,
  onModelChange,
  onRuntimeProfileChange,
  onReferencePlanModeChange,
  onConfigureModels,
  onCreateConversation,
  onSaveProjectContext,
  onSend,
  onCancel,
}: {
  language: AppLanguage;
  draft: string;
  onDraftChange: (value: string) => void;
  sending: boolean;
  queuedMessageCount: number;
  queuedMessagePreview: string;
  selectedModel: string;
  availableModels: string[];
  selectedRuntimeProfile: string;
  runtimeProfiles: RuntimeProfileSummary[];
  referencePlanMode: ReferencePlanMode;
  activeProjectDir?: string;
  projectContext: string;
  skills?: SkillSummary[];
  disabledSkillNames: Set<string>;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  onModelChange: (value: string) => void;
  onRuntimeProfileChange: (value: string) => void;
  onReferencePlanModeChange: (value: ReferencePlanMode) => void;
  onConfigureModels: () => void;
  onCreateConversation?: () => void;
  onSaveProjectContext: (value: string) => Promise<string>;
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
        selectedModel={selectedModel}
        availableModels={availableModels}
        selectedRuntimeProfile={selectedRuntimeProfile}
        runtimeProfiles={runtimeProfiles}
        referencePlanMode={referencePlanMode}
        onModelChange={onModelChange}
        onRuntimeProfileChange={onRuntimeProfileChange}
        onReferencePlanModeChange={onReferencePlanModeChange}
        onConfigureModels={onConfigureModels}
        onCreateConversation={onCreateConversation}
        activeProjectDir={activeProjectDir}
        projectContext={projectContext}
        skills={skills}
        disabledSkillNames={disabledSkillNames}
        onToggleSkill={onToggleSkill}
        onSaveProjectContext={onSaveProjectContext}
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
  onCreateSessionShareLink?: (
    request: SessionShareLinkRequest,
  ) => Promise<SessionShareLinkResult>;
  onRefreshActiveSession?: RefreshActiveSession;
  activeConsole?: ConsoleMode | null;
  onToggleGit: () => void;
  onToggleTerminal: () => void;
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
    if (!activeConversationId?.trim() || !onRefreshActiveSession) {
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
  }, [activeConversationId, onRefreshActiveSession]);

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
        disabled={!activeConversationId?.trim() || !onRefreshActiveSession || botHistoryRefreshing}
        onClick={() => void refreshBotHistory()}
        title={
          botHistoryRefreshFailed
            ? language === 'zh'
              ? '刷新 Bot 内容失败'
              : 'Failed to refresh Bot content'
            : language === 'zh'
              ? '刷新 Bot 内容'
              : 'Refresh Bot content'
        }
      >
        {botHistoryRefreshing ? <LoaderCircle size={16} /> : <RefreshCw size={16} />}
      </button>
      <button
        className={`topbar-square ${activeConsole === 'git' ? 'active' : ''}`}
        type="button"
        onClick={onToggleGit}
        title="Git 控制台"
      >
        <GitBranch size={16} />
      </button>
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
    </div>
  );
}

function MessageBubble({
  message,
  language,
  sending,
  activeTurnId,
  activeAssistantMessageId,
  onRegenerate,
  onEditUserMessage,
  onGuideMessage,
  onRevertChangeReport,
  onOpenScene,
}: {
  message: ChatMessage;
  language: AppLanguage;
  sending: boolean;
  activeTurnId: string;
  activeAssistantMessageId: string;
  onRegenerate: (message: ChatMessage) => Promise<void>;
  onEditUserMessage: (message: ChatMessage, content: string) => Promise<void>;
  onGuideMessage: (
    message: ChatMessage,
    guidance: string,
    mode: GuidanceMode,
  ) => Promise<void>;
  onRevertChangeReport: (
    report: ConversationChangeReport,
    message: ChatMessage,
  ) => Promise<void>;
  onOpenScene: (scene: CardlingScene) => void;
}) {
  const { imagePaths, text } = splitMessageImages(message.content);
  const allToolExecutions = message.toolExecutions ?? [];
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(text);
  const [submittingEdit, setSubmittingEdit] = useState(false);
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const [assistantFeedback, setAssistantFeedback] =
    useState<AssistantFeedbackRating | null>(() => readAssistantFeedback(message.id));
  const [feedbackPulse, setFeedbackPulse] =
    useState<AssistantFeedbackRating | null>(null);
  const feedbackPulseFrameRef = useRef<number | null>(null);
  const feedbackPulseTimerRef = useRef<number | null>(null);
  const activeMessageTurn = message.turnId?.trim() ?? '';
  const activeTurn = activeTurnId.trim();
  const activeAssistantId = activeAssistantMessageId.trim();
  const isActiveAssistantTurn =
    message.role === 'assistant' &&
    sending &&
    activeAssistantId === message.id &&
    (!activeTurn || !activeMessageTurn || activeTurn === activeMessageTurn);
  const [progressNow, setProgressNow] = useState(() => Date.now());
  const canGuide =
    isActiveAssistantTurn;

  useEffect(() => {
    if (!isActiveAssistantTurn) {
      return undefined;
    }
    setProgressNow(Date.now());
    const timer = window.setInterval(() => setProgressNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isActiveAssistantTurn]);

  useEffect(() => {
    setEditing(false);
    setSubmittingEdit(false);
    setGuidanceOpen(false);
    setAssistantFeedback(readAssistantFeedback(message.id));
    setFeedbackPulse(null);
    setEditText(splitMessageImages(message.content).text);
  }, [message.id, message.content]);

  useEffect(() => {
    return () => {
      if (feedbackPulseFrameRef.current != null) {
        window.cancelAnimationFrame(feedbackPulseFrameRef.current);
      }
      if (feedbackPulseTimerRef.current != null) {
        window.clearTimeout(feedbackPulseTimerRef.current);
      }
    };
  }, []);

  if (message.role === 'system' || message.role === 'guidance' || message.role === 'tool') {
    return null;
  }

  async function submitEdit() {
    if (submittingEdit) {
      return;
    }
    const nextContent = [
      ...imagePaths.map((pathValue) => `@${pathValue}`),
      editText.trim(),
    ]
      .filter(Boolean)
      .join('\n');
    if (!nextContent.trim()) {
      return;
    }
    if (nextContent.trim() === message.content.trim()) {
      setEditing(false);
      return;
    }
    setSubmittingEdit(true);
    try {
      await onEditUserMessage(message, nextContent);
      setEditing(false);
    } finally {
      setSubmittingEdit(false);
    }
  }

  function toggleAssistantFeedback(rating: AssistantFeedbackRating) {
    const nextRating = assistantFeedback === rating ? null : rating;
    playAssistantFeedbackPulse(rating);
    setAssistantFeedback(nextRating);
    recordAssistantFeedback(message, nextRating);
  }

  function playAssistantFeedbackPulse(rating: AssistantFeedbackRating) {
    if (feedbackPulseFrameRef.current != null) {
      window.cancelAnimationFrame(feedbackPulseFrameRef.current);
    }
    if (feedbackPulseTimerRef.current != null) {
      window.clearTimeout(feedbackPulseTimerRef.current);
    }
    setFeedbackPulse(null);
    feedbackPulseFrameRef.current = window.requestAnimationFrame(() => {
      setFeedbackPulse(rating);
      feedbackPulseTimerRef.current = window.setTimeout(() => {
        setFeedbackPulse(null);
        feedbackPulseTimerRef.current = null;
      }, 520);
      feedbackPulseFrameRef.current = null;
    });
  }

  if (message.role === 'user') {
    if (editing) {
      return (
        <div className="message-row user">
          <div className="user-edit-card">
            <MessageImageStrip paths={imagePaths} />
            <textarea
              value={editText}
              autoFocus
              onChange={(event) => setEditText(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                  event.preventDefault();
                  void submitEdit();
                }
                if (event.key === 'Escape') {
                  setEditing(false);
                }
              }}
              placeholder={language === 'zh' ? '修改这条提问' : 'Edit this message'}
              rows={Math.min(5, Math.max(2, editText.split(/\r?\n/).length))}
            />
            <div className="message-edit-actions">
              <button
                type="button"
                disabled={submittingEdit}
                onClick={() => setEditing(false)}
              >
                {language === 'zh' ? '取消' : 'Cancel'}
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={submittingEdit || (!editText.trim() && imagePaths.length === 0)}
                onClick={() => void submitEdit()}
              >
                {submittingEdit ? <LoaderCircle size={14} /> : <ArrowUp size={14} />}
                {language === 'zh' ? '发送' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="message-row user">
        <div className="user-bubble">
          <MessageImageStrip paths={imagePaths} />
          {text && <MarkdownContent content={text} />}
        </div>
        <div className="message-actions">
          <button
            type="button"
            title={language === 'zh' ? '复制' : 'Copy'}
            onClick={() => void copyText(message.content).catch(() => undefined)}
          >
            <Clipboard size={14} />
          </button>
          <button
            type="button"
            title={language === 'zh' ? '编辑并重新生成' : 'Edit and retry'}
            disabled={sending}
            onClick={() => setEditing(true)}
          >
            <Edit3 size={14} />
          </button>
        </div>
      </div>
    );
  }

  const loopHistory =
    message.role === 'assistant'
      ? (message.loopHistory ?? []).filter(hasVisibleLoopHistoryMessage)
      : [];
  const visibleLoopHistory = isActiveAssistantTurn ? [] : loopHistory;
  const activeTranscriptMessages = isActiveAssistantTurn
    ? activeAssistantTranscriptMessages(loopHistory, message)
    : [];
  const renderActiveTranscript = activeTranscriptMessages.length > 1;
  const suppressFinalTopLevelTools =
    message.role === 'assistant' &&
    !isActiveAssistantTurn &&
    isFinalAssistantDisplayMessage(message);
  const toolExecutions =
    message.role === 'assistant'
      ? suppressFinalTopLevelTools
        ? []
        : visibleTopLevelToolExecutions(
            allToolExecutions,
            loopHistory,
            isActiveAssistantTurn,
          )
      : allToolExecutions;
  const assistantProgressExecutions = suppressFinalTopLevelTools
    ? allToolExecutions
    : toolExecutions;
  const showAssistantProgress =
    message.role === 'assistant' &&
    (isActiveAssistantTurn ||
      toolExecutions.length > 0 ||
      hasAssistantProgressSource(message, assistantProgressExecutions));
  const assistantProgressText = showAssistantProgress
    ? assistantProgressLabel({
        executions: assistantProgressExecutions,
        isActive: isActiveAssistantTurn,
        message,
        now: progressNow,
        language,
      })
    : '';
  const hasAssistantBody = Boolean(
    text.trim() ||
      imagePaths.length > 0 ||
      toolExecutions.length > 0 ||
      renderActiveTranscript ||
      visibleLoopHistory.length > 0 ||
      agentHookSummaryFromMessage(message),
  );
  if (!showAssistantProgress && !hasAssistantBody) {
    return null;
  }
  return (
    <>
      <div className="message-row assistant">
        <div className="assistant-bubble">
          {showAssistantProgress && (
            <div
              className={`assistant-run-header ${isActiveAssistantTurn ? 'running' : ''}`}
            >
              <span className="assistant-run-label">{assistantProgressText}</span>
              <div />
            </div>
          )}
          <AgentHookSummaryBadge message={message} language={language} />
          {!renderActiveTranscript && <MessageImageStrip paths={imagePaths} />}
          {renderActiveTranscript ? (
            <AssistantActiveTranscript
              messages={activeTranscriptMessages}
              language={language}
              active={isActiveAssistantTurn}
              onRevertChangeReport={onRevertChangeReport}
              onOpenScene={onOpenScene}
            />
          ) : toolExecutions.length > 0 ? (
            <AssistantMessageContent
              content={text}
              executions={toolExecutions}
              language={language}
              message={message}
              active={isActiveAssistantTurn}
              showThinkingPlaceholder={isActiveAssistantTurn}
              onRevertChangeReport={onRevertChangeReport}
              onOpenScene={onOpenScene}
            />
          ) : text ? (
            <>
              <MarkdownContent content={text} />
              {isActiveAssistantTurn && (
                <AssistantThinkingProcessLine language={language} />
              )}
            </>
          ) : isActiveAssistantTurn ? (
            <AssistantThinkingProcessLine language={language} />
          ) : null}
          {visibleLoopHistory.length > 0 && (
            <AssistantLoopHistoryBlock
              history={visibleLoopHistory}
              language={language}
              onRevertChangeReport={onRevertChangeReport}
              onOpenScene={onOpenScene}
            />
          )}
        </div>
        <div className="message-actions">
          <button
            type="button"
            title={language === 'zh' ? '复制' : 'Copy'}
            onClick={() => void copyText(message.content).catch(() => undefined)}
          >
            <Clipboard size={14} />
          </button>
          <button
            className={`feedback-up ${assistantFeedback === 'up' ? 'active' : ''} ${
              feedbackPulse === 'up' ? 'feedback-pop' : ''
            }`}
            type="button"
            aria-pressed={assistantFeedback === 'up'}
            title={language === 'zh' ? '有帮助，记录给 LEM' : 'Helpful, record for LEM'}
            onClick={() => toggleAssistantFeedback('up')}
          >
            <ThumbsUp size={14} />
          </button>
          <button
            className={`feedback-down ${assistantFeedback === 'down' ? 'active' : ''} ${
              feedbackPulse === 'down' ? 'feedback-pop' : ''
            }`}
            type="button"
            aria-pressed={assistantFeedback === 'down'}
            title={language === 'zh' ? '不理想，记录给 LEM' : 'Needs improvement, record for LEM'}
            onClick={() => toggleAssistantFeedback('down')}
          >
            <ThumbsDown size={14} />
          </button>
          {activeMessageTurn && (
            <button
              type="button"
              title={language === 'zh' ? '重新生成' : 'Retry'}
              disabled={sending}
              onClick={() => void onRegenerate(message)}
            >
              <RefreshCw size={14} />
            </button>
          )}
          {canGuide && (
            <button
              type="button"
              title={language === 'zh' ? '插入引导' : 'Guide this turn'}
              onClick={() => setGuidanceOpen(true)}
            >
              <Sparkles size={14} />
            </button>
          )}
        </div>
      </div>
      {guidanceOpen && (
        <GuidanceDialog
          language={language}
          onCancel={() => setGuidanceOpen(false)}
          onSubmit={async (guidance, mode) => {
            await onGuideMessage(message, guidance, mode);
            setGuidanceOpen(false);
          }}
        />
      )}
    </>
  );
}

function AssistantActiveTranscript({
  messages,
  language,
  active,
  onRevertChangeReport,
  onOpenScene,
}: {
  messages: ChatMessage[];
  language: AppLanguage;
  active: boolean;
  onRevertChangeReport: (
    report: ConversationChangeReport,
    message: ChatMessage,
  ) => Promise<void>;
  onOpenScene: (scene: CardlingScene) => void;
}) {
  const visibleMessages = messages.filter(hasVisibleLoopHistoryMessage);
  if (visibleMessages.length === 0) {
    return null;
  }
  const hasRunningTool = visibleMessages.some((message) =>
    (message.toolExecutions ?? []).some((execution) => isToolRunningInContext(execution, active)),
  );
  const showThinkingPlaceholder = active && !hasRunningTool;
  return (
    <div className="assistant-active-transcript">
      {visibleMessages.map((segment, index) => {
        const { imagePaths, text } = splitMessageImages(segment.content);
        const executions = segment.toolExecutions ?? [];
        const isLastSegment = index === visibleMessages.length - 1;
        return (
          <section
            // eslint-disable-next-line react/no-array-index-key
            key={`${segment.id}-${index}`}
            className="assistant-active-transcript-segment"
          >
            <MessageImageStrip paths={imagePaths} />
            {executions.length > 0 ? (
              <AssistantMessageContent
                content={text}
                executions={executions}
                language={language}
                message={segment}
                active
                showThinkingPlaceholder={showThinkingPlaceholder && isLastSegment}
                onRevertChangeReport={onRevertChangeReport}
                onOpenScene={onOpenScene}
              />
            ) : text ? (
              <>
                <MarkdownContent content={text} />
                {showThinkingPlaceholder && isLastSegment && (
                  <AssistantThinkingProcessLine language={language} />
                )}
              </>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function activeAssistantTranscriptMessages(
  loopHistory: ChatMessage[],
  currentMessage: ChatMessage,
) {
  return [...loopHistory, currentMessage].filter(hasVisibleLoopHistoryMessage);
}

function AssistantMessageContent({
  content,
  executions,
  language,
  message,
  active,
  showThinkingPlaceholder = false,
  onRevertChangeReport,
  onOpenScene,
}: {
  content: string;
  executions: ChatToolExecution[];
  language: AppLanguage;
  message: ChatMessage;
  active: boolean;
  showThinkingPlaceholder?: boolean;
  onRevertChangeReport: (
    report: ConversationChangeReport,
    message: ChatMessage,
  ) => Promise<void>;
  onOpenScene: (scene: CardlingScene) => void;
}) {
  const sortedExecutions = [...executions].sort(compareToolExecutionOrder);
  const groups = groupExecutionsByContentOffset(content, sortedExecutions);
  const blocks: ReactNode[] = [];
  let cursor = 0;

  groups.forEach((group, index) => {
    const segment = content.slice(cursor, group.offset);
    if (segment.trim()) {
      blocks.push(
        // eslint-disable-next-line react/no-array-index-key
        <MarkdownContent key={`text-${index}`} content={segment.trim()} />,
      );
    }
    blocks.push(
      <ToolExecutionBlock
        // eslint-disable-next-line react/no-array-index-key
        key={`tools-${group.offset}-${index}`}
        executions={group.executions}
        language={language}
        message={message}
        active={active}
        onRevertChangeReport={onRevertChangeReport}
        onOpenScene={onOpenScene}
      />,
    );
    cursor = group.offset;
  });

  const tail = content.slice(cursor);
  if (tail.trim()) {
    blocks.push(<MarkdownContent key="text-tail" content={tail.trim()} />);
  }
  if (
    showThinkingPlaceholder &&
    !sortedExecutions.some((execution) => isToolRunningInContext(execution, active))
  ) {
    blocks.push(
      <AssistantThinkingProcessLine
        key="thinking-placeholder"
        language={language}
      />,
    );
  }

  return (
    <div className="assistant-message-content">
      {blocks}
    </div>
  );
}

function AssistantThinkingProcessLine({ language }: { language: AppLanguage }) {
  return (
    <div className="assistant-thinking-process">
      <LoaderCircle size={14} />
      <span>{language === 'zh' ? '正在思考' : 'Thinking'}</span>
    </div>
  );
}

function AgentHookSummaryBadge({
  message,
  language,
}: {
  message: ChatMessage;
  language: AppLanguage;
}) {
  const summary = agentHookSummaryFromMessage(message);
  if (!summary) {
    return null;
  }
  const tone =
    summary.verificationStatus === 'attempted_failed' ||
    summary.verificationStatus === 'failed'
      ? 'danger'
      : summary.verificationRequired && summary.verificationStatus !== 'satisfied'
        ? 'warning'
        : 'ok';
  const statusLabel = hookVerificationStatusLabel(
    summary.verificationStatus,
    summary.verificationRequired,
    language,
  );
  return (
    <div className={`agent-hook-summary ${tone}`}>
      {tone === 'ok' ? <CheckCircle2 size={14} /> : <ShieldCheck size={14} />}
      <span>
        <strong>{language === 'zh' ? 'Profile Hook' : 'Profile hook'}</strong>
        <em>{statusLabel}</em>
        {summary.changedFiles.length > 0 && (
          <small>
            {language === 'zh'
              ? `${summary.changedFiles.length} 个文件需要/已完成验证`
              : `${summary.changedFiles.length} changed file${summary.changedFiles.length > 1 ? 's' : ''}`}
          </small>
        )}
      </span>
    </div>
  );
}

function groupExecutionsByContentOffset(
  content: string,
  executions: ChatToolExecution[],
) {
  const groups: Array<{ offset: number; executions: ChatToolExecution[] }> = [];
  const annotated = executions
    .map((execution, index) => {
      const rawOffset =
        hasExplicitToolContentOffset(execution)
          ? execution.contentOffset
          : inferToolContentOffset(content, execution);
      return {
        execution,
        index,
        offset: safeAssistantToolSplitOffset(content, rawOffset),
      };
    })
    .sort(
      (left, right) =>
        left.offset - right.offset ||
        compareToolExecutionOrder(left.execution, right.execution) ||
        left.index - right.index,
    );
  for (const item of annotated) {
    const { execution, offset } = item;
    const previous = groups.at(-1);
    if (previous && previous.offset === offset) {
      previous.executions.push(execution);
      continue;
    }
    groups.push({
      offset,
      executions: [execution],
    });
  }
  return groups;
}

function visibleTopLevelToolExecutions(
  executions: ChatToolExecution[],
  loopHistory: ChatMessage[],
  active: boolean,
) {
  if (active || loopHistory.length === 0) {
    return executions;
  }
  const loopToolIds = new Set(
    loopHistory.flatMap((message) =>
      (message.toolExecutions ?? []).map((execution) => execution.id),
    ),
  );
  return executions.filter((execution) => {
    if (looksLikeFileChangeExecution(execution)) {
      return true;
    }
    if (loopToolIds.has(execution.id)) {
      return false;
    }
    return !isToolRunning(execution);
  });
}

function isFinalAssistantDisplayMessage(message: ChatMessage) {
  if (message.role !== 'assistant') {
    return false;
  }
  const status = String(message.status ?? message.metadata?.status ?? '')
    .trim()
    .toLowerCase();
  const transcriptKind = String(
    message.metadata?.transcript_kind ?? message.metadata?.transcriptKind ?? '',
  )
    .trim()
    .toLowerCase();
  if (status === 'superseded' || transcriptKind === 'assistant_loop') {
    return false;
  }
  return status === 'complete' || transcriptKind === 'assistant_final' || (!status && !transcriptKind);
}

function hasAssistantProgressSource(
  message: ChatMessage,
  executions: ChatToolExecution[],
) {
  if (executions.length > 0) {
    return true;
  }
  const metadata = message.metadata ?? {};
  return [
    metadata.cardbush_turn_started_at,
    metadata.turn_started_at,
    metadata.started_at,
    metadata.cardbush_turn_completed_at,
    metadata.completed_at,
    metadata.done_at,
    metadata.finished_at,
  ].some((value) => typeof value === 'string' && value.trim());
}

function compareToolExecutionOrder(
  left: ChatToolExecution,
  right: ChatToolExecution,
) {
  const sequenceDelta = compareOptionalNumber(left.sequence, right.sequence);
  if (sequenceDelta !== 0) {
    return sequenceDelta;
  }
  const loopDelta = compareOptionalNumber(left.loopIndex, right.loopIndex);
  if (loopDelta !== 0) {
    return loopDelta;
  }
  const dateDelta = compareOptionalNumber(
    dateTimestamp(left.createdAt),
    dateTimestamp(right.createdAt),
  );
  if (dateDelta !== 0) {
    return dateDelta;
  }
  return left.id.localeCompare(right.id);
}

function compareOptionalNumber(left: number | undefined, right: number | undefined) {
  if (left == null || right == null) {
    return 0;
  }
  return left - right;
}

function dateTimestamp(value: string | undefined) {
  if (!value) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function inferToolContentOffset(content: string, execution: ChatToolExecution) {
  const metadata = execution.metadata;
  const candidates = [
    metadata.content_offset,
    metadata.contentOffset,
    metadata.assistant_content_offset,
    metadata.assistantContentOffset,
    metadata.text_offset,
    metadata.textOffset,
  ];
  for (const candidate of candidates) {
    const value = Number(candidate);
    if (Number.isFinite(value) && value >= 0) {
      return Math.trunc(value);
    }
  }
  return content.length;
}

function hasExplicitToolContentOffset(execution: ChatToolExecution) {
  if (execution.contentOffsetExplicit) {
    return true;
  }
  const metadata = execution.metadata;
  return [
    metadata.content_offset,
    metadata.contentOffset,
    metadata.assistant_content_offset,
    metadata.assistantContentOffset,
    metadata.text_offset,
    metadata.textOffset,
  ].some((value) => value != null && value !== '' && Number.isFinite(Number(value)));
}

function safeAssistantToolSplitOffset(content: string, rawOffset: number) {
  const offset = Math.max(0, Math.min(content.length, rawOffset));
  if (offset <= 0 || offset >= content.length) {
    return offset;
  }
  const fencedRange = fencedMarkdownRangeAt(content, offset);
  if (fencedRange) {
    return nearestOffset(offset, fencedRange.start, fencedRange.end);
  }
  const tableRange = markdownTableRangeAt(content, offset);
  if (tableRange) {
    return nearestOffset(offset, tableRange.start, tableRange.end);
  }
  if (isMarkdownBoundary(content, offset)) {
    return offset;
  }
  const lineStart = content.lastIndexOf('\n', offset - 1) + 1;
  const nextLineBreak = content.indexOf('\n', offset);
  const lineEnd = nextLineBreak >= 0 ? nextLineBreak : content.length;
  if (offset <= lineStart || offset >= lineEnd) {
    return offset;
  }
  const line = content.slice(lineStart, lineEnd);
  if (markdownBlockLine(line)) {
    return lineEnd;
  }
  return nearestOffset(offset, lineStart, lineEnd);
}

function isMarkdownBoundary(content: string, offset: number) {
  return (
    offset <= 0 ||
    offset >= content.length ||
    content[offset - 1] === '\n' ||
    content[offset] === '\n'
  );
}

function markdownBlockLine(line: string) {
  return /^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+|```|~~~)/.test(line);
}

function fencedMarkdownRangeAt(content: string, offset: number) {
  const fencePattern = /(^|\n)(```|~~~)[^\n]*(?:\n|$)/g;
  let open: { start: number; marker: string } | null = null;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(content)) != null) {
    const start = match.index + (match[1] ? match[1].length : 0);
    const marker = match[2];
    if (!open) {
      open = { start, marker };
      continue;
    }
    if (open.marker !== marker) {
      continue;
    }
    const end = fencePattern.lastIndex;
    if (offset > open.start && offset < end) {
      return { start: open.start, end };
    }
    open = null;
  }
  if (open && offset > open.start) {
    return { start: open.start, end: content.length };
  }
  return null;
}

function markdownTableRangeAt(content: string, offset: number) {
  const lines = markdownLinesWithRanges(content);
  for (let index = 0; index < lines.length - 1; index += 1) {
    const header = lines[index];
    const separator = lines[index + 1];
    if (!markdownTableRowLine(header.text) || !markdownTableSeparatorLine(separator.text)) {
      continue;
    }
    let endIndex = index + 2;
    while (endIndex < lines.length && markdownTableRowLine(lines[endIndex].text)) {
      endIndex += 1;
    }
    const start = header.start;
    const end = lines[endIndex - 1].end;
    if (offset > start && offset < end) {
      return { start, end };
    }
  }
  return null;
}

function markdownLinesWithRanges(content: string) {
  const lines: Array<{ text: string; start: number; end: number }> = [];
  const pattern = /.*(?:\r?\n|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) != null) {
    const raw = match[0];
    if (!raw && pattern.lastIndex >= content.length) {
      break;
    }
    const start = match.index;
    const end = start + raw.length;
    lines.push({
      text: raw.replace(/\r?\n$/, ''),
      start,
      end,
    });
    if (pattern.lastIndex >= content.length) {
      break;
    }
  }
  return lines;
}

function markdownTableRowLine(line: string) {
  const trimmed = line.trim();
  return trimmed.includes('|') && /^\|?.+\|.+\|?$/.test(trimmed);
}

function markdownTableSeparatorLine(line: string) {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) {
    return false;
  }
  const normalized = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const columns = normalized.split('|').map((column) => column.trim());
  return columns.length >= 2 && columns.every((column) => /^:?-{3,}:?$/.test(column));
}

function nearestOffset(offset: number, before: number, after: number) {
  return offset - before <= after - offset ? before : after;
}

function AssistantLoopHistoryBlock({
  history,
  language,
  onRevertChangeReport,
  onOpenScene,
}: {
  history: ChatMessage[];
  language: AppLanguage;
  onRevertChangeReport: (
    report: ConversationChangeReport,
    message: ChatMessage,
  ) => Promise<void>;
  onOpenScene: (scene: CardlingScene) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const blockRef = useRef<HTMLDivElement>(null);
  const visibleHistory = history.filter(hasVisibleLoopHistoryMessage);
  const toolCount = visibleHistory.reduce(
    (total, item) => total + (item.toolExecutions?.length ?? 0),
    0,
  );
  const summary =
    language === 'zh'
      ? `历史执行 ${visibleHistory.length} 条${toolCount > 0 ? ` · ${toolCount} 个工具` : ''}`
      : `Loop history ${visibleHistory.length}${toolCount > 0 ? ` · ${toolCount} tools` : ''}`;
  const toggleExpanded = useCallback(() => {
    preserveScrollPositionForToggle(blockRef.current, () => {
      setExpanded((value) => !value);
    });
  }, []);

  if (visibleHistory.length === 0) {
    return null;
  }

  return (
    <div
      ref={blockRef}
      className={`assistant-loop-history ${expanded ? 'expanded' : ''}`}
    >
      <button
        className="assistant-loop-history-summary"
        type="button"
        aria-expanded={expanded}
        onClick={toggleExpanded}
      >
        <Clock3 size={15} />
        <span>{summary}</span>
        <em>{expanded ? (language === 'zh' ? '收起' : 'Hide') : language === 'zh' ? '展开' : 'Show'}</em>
        <ChevronDown size={16} className={expanded ? 'expanded' : ''} />
      </button>
      {expanded && (
        <div className="assistant-loop-history-details">
          {visibleHistory.map((historyMessage, index) => (
            <AssistantLoopHistoryItem
              // eslint-disable-next-line react/no-array-index-key
              key={`${historyMessage.id}-${index}`}
              index={index}
              message={historyMessage}
              language={language}
              onRevertChangeReport={onRevertChangeReport}
              onOpenScene={onOpenScene}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function AssistantLoopHistoryItem({
  index,
  message,
  language,
  onRevertChangeReport,
  onOpenScene,
}: {
  index: number;
  message: ChatMessage;
  language: AppLanguage;
  onRevertChangeReport: (
    report: ConversationChangeReport,
    message: ChatMessage,
  ) => Promise<void>;
  onOpenScene: (scene: CardlingScene) => void;
}) {
  const { imagePaths, text } = splitMessageImages(message.content);
  const executions = message.toolExecutions ?? [];
  const title =
    language === 'zh'
      ? `第 ${index + 1} 段执行`
      : `Step ${index + 1}`;
  const timestamp = formatLoopHistoryTimestamp(message, language);

  return (
    <section className="assistant-loop-history-item">
      <header>
        <strong>{title}</strong>
        {timestamp && <span>{timestamp}</span>}
      </header>
      <MessageImageStrip paths={imagePaths} />
      {executions.length > 0 ? (
        <AssistantMessageContent
          content={text}
          executions={executions}
          language={language}
          message={message}
          active={false}
          onRevertChangeReport={onRevertChangeReport}
          onOpenScene={onOpenScene}
        />
      ) : text ? (
        <MarkdownContent content={text} />
      ) : null}
    </section>
  );
}

function hasVisibleLoopHistoryMessage(message: ChatMessage) {
  return Boolean(
    message.content.trim() ||
      (message.attachments?.length ?? 0) > 0 ||
      (message.toolExecutions?.length ?? 0) > 0,
  );
}

function formatLoopHistoryTimestamp(message: ChatMessage, language: AppLanguage) {
  const value = loopHistoryTimestamp(message);
  if (value == null) {
    return '';
  }
  const date = new Date(value);
  return new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function loopHistoryTimestamp(message: ChatMessage) {
  const metadata = message.metadata ?? {};
  const executionTimestamps = (message.toolExecutions ?? []).flatMap((execution) => [
    execution.createdAt,
    toolExecutionFinishedAt(execution),
  ]);
  return latestTimestamp([
    metadata.cardbush_turn_completed_at,
    metadata.completed_at,
    metadata.done_at,
    metadata.finished_at,
    ...executionTimestamps,
    metadata.cardbush_turn_started_at,
    metadata.turn_started_at,
    metadata.started_at,
    message.createdAt,
  ]);
}

function ToolExecutionBlock({
  executions,
  language,
  message,
  active,
  onRevertChangeReport,
  onOpenScene,
}: {
  executions: ChatToolExecution[];
  language: AppLanguage;
  message: ChatMessage;
  active: boolean;
  onRevertChangeReport: (
    report: ConversationChangeReport,
    message: ChatMessage,
  ) => Promise<void>;
  onOpenScene: (scene: CardlingScene) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const blockRef = useRef<HTMLDivElement>(null);
  const running = executions.some((execution) => isToolRunningInContext(execution, active));
  const failedCount = executions.filter((execution) =>
    isToolFailedInContext(execution, active),
  ).length;
  const tone = running ? 'neutral' : toolExecutionToneInContext(executions, active);
  const changeReport = toolChangeReportFromExecutions(executions);
  const toggleExpanded = useCallback(() => {
    preserveScrollPositionForToggle(blockRef.current, () => {
      setExpanded((value) => !value);
    });
  }, []);

  if (changeReport) {
    const messageChangeReport: ConversationChangeReport = {
      ...changeReport,
      id: `${message.id}:${message.turnId ?? ''}`,
      messageId: message.id,
      turnId: message.turnId,
      createdAt: message.createdAt,
    };
    return (
      <ToolChangeBlock
        report={messageChangeReport}
        running={running}
        tone={tone}
        language={language}
        onRevert={() => onRevertChangeReport(messageChangeReport, message)}
      />
    );
  }

  const summary = running
    ? runningToolLabel(executions, language)
    : failedCount > 0
      ? language === 'zh'
        ? `已运行 ${executions.length} 条命令，${failedCount} 条失败`
        : `Ran ${executions.length} tools, ${failedCount} failed`
      : language === 'zh'
        ? `已运行 ${executions.length} 条命令`
        : `Ran ${executions.length} tools`;

  return (
    <div
      ref={blockRef}
      className={`tool-execution-block ${expanded ? 'expanded' : ''} ${running ? 'running' : ''} ${tone}`}
    >
      <button
        className="tool-execution-summary"
        type="button"
        onClick={toggleExpanded}
      >
        <Terminal size={15} />
        <span>{summary}</span>
        <ChevronDown size={16} className={expanded ? 'expanded' : ''} />
      </button>
      {expanded && (
        <div className="tool-execution-details">
          {executions.map((execution, index) => (
            <ToolExecutionDetail
              // eslint-disable-next-line react/no-array-index-key
              key={`${execution.id}-${index}`}
              execution={execution}
              message={message}
              language={language}
              active={active}
              onOpenScene={onOpenScene}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function isSubagentDispatchRejectionExecution(execution: ChatToolExecution) {
  const metadata = execution.metadata;
  const hasSubagentMarker =
    execution.name.trim().toLowerCase().includes('subagent') ||
    String(metadata.kind ?? metadata.type ?? '').trim() === 'subagent_tool' ||
    metadata.subagent_task_id != null ||
    metadata.subagentTaskId != null ||
    metadata.subagent_name != null ||
    metadata.subagentName != null;
  if (!hasSubagentMarker) {
    return false;
  }
  const outputPayload = parseToolOutputJson(execution.output);
  const candidates = [
    execution.metadata,
    asRecord(execution.metadata.result),
    asRecord(execution.metadata.payload),
    outputPayload,
  ];
  return candidates.some(isSubagentDispatchRejectionPayload);
}

function isSubagentDispatchRejectionPayload(payload: Record<string, unknown>) {
  if (Object.keys(payload).length === 0) {
    return false;
  }
  const status = String(payload.status ?? '').trim().toLowerCase();
  return (
    payload.accepted === false ||
    status === 'rejected' ||
    Boolean(payload.error_code ?? payload.errorCode)
  );
}

function parseToolOutputJson(value: string) {
  const text = value.trim();
  if (!text.startsWith('{')) {
    return {};
  }
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return {};
  }
}

function summarizeRecord(value: Record<string, unknown>) {
  const entries = Object.entries(value).filter(([, raw]) => raw != null && raw !== '');
  if (entries.length === 0) {
    return '-';
  }
  return entries
    .slice(0, 6)
    .map(([key, raw]) => `${key}: ${String(raw)}`)
    .join(' · ');
}

function summarizeWorkerContractDefaults(value: Record<string, unknown>) {
  const entries = Object.entries(value).filter(([, raw]) => raw != null && raw !== '');
  if (entries.length === 0) {
    return '';
  }
  return entries
    .slice(0, 6)
    .map(([key, raw]) => {
      if (Array.isArray(raw)) {
        return `${key}: ${raw.join(', ')}`;
      }
      if (raw && typeof raw === 'object') {
        return `${key}: ${summarizeRecord(asRecord(raw))}`;
      }
      return `${key}: ${String(raw)}`;
    })
    .join(' · ');
}

function summarizeWriteScope(scope: string[]) {
  if (scope.length === 0) {
    return '';
  }
  const visible = scope.slice(0, 4).join(', ');
  return scope.length > 4 ? `${visible} +${scope.length - 4}` : visible;
}

function summarizeIoManifest(manifest: Record<string, unknown>) {
  const keys = ['reads', 'writes', 'exports', 'consumes'];
  const parts = keys
    .map((key) => {
      const value = summarizeLooseValue(manifest[key]);
      return value ? `${key}: ${value}` : '';
    })
    .filter(Boolean);
  if (parts.length > 0) {
    return parts.join(' · ');
  }
  return summarizeRecord(manifest);
}

function summarizeAssertionResults(items: VerificationAssertionItem[]) {
  const visible = items
    .slice(0, 4)
    .map((item) =>
      [item.label, item.status ? `(${item.status})` : '', item.summary]
        .filter(Boolean)
        .join(' '),
    )
    .join(' · ');
  return items.length > 4 ? `${visible} +${items.length - 4}` : visible;
}

function stringArrayLoose(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(summarizeLooseValue)
    .map((item) => item.trim())
    .filter(Boolean);
}

function summarizeLooseValue(value: unknown): string {
  if (value == null || value === '') {
    return '';
  }
  if (Array.isArray(value)) {
    return value.map(summarizeLooseValue).filter(Boolean).join(', ');
  }
  if (typeof value === 'object') {
    const record = asRecord(value);
    const title = nonEmptyString(
      record.label ?? record.name ?? record.id ?? record.path ?? record.summary,
    );
    if (title) {
      return title;
    }
    return summarizeRecord(record);
  }
  return String(value).trim();
}

function summarizeSubagentWriteLease(
  lease: NonNullable<SubagentDispatchResult['writeLease']>,
) {
  const conflictText = lease.conflicts.length > 0
    ? `conflicts: ${lease.conflicts.slice(0, 2).map(summarizeWriteLeaseConflict).join(' | ')}`
    : '';
  return [
    lease.status ? `lease: ${lease.status}` : 'lease',
    lease.policy ? `policy: ${lease.policy}` : '',
    lease.scope.length > 0 ? `scope: ${summarizeWriteScope(lease.scope)}` : '',
    conflictText,
    lease.reason ? `reason: ${lease.reason}` : '',
  ].filter(Boolean).join(' · ');
}

function summarizeWriteLeaseRecord(value: Record<string, unknown>) {
  const scope = stringArray(value.scope);
  const conflicts = Array.isArray(value.conflicts)
    ? value.conflicts.map(asRecord)
    : [];
  return [
    nonEmptyString(value.status) ? `status: ${String(value.status)}` : '',
    nonEmptyString(value.policy) ? `policy: ${String(value.policy)}` : '',
    scope.length > 0 ? `scope: ${summarizeWriteScope(scope)}` : '',
    conflicts.length > 0
      ? `conflicts: ${conflicts.slice(0, 2).map(summarizeWriteLeaseConflict).join(' | ')}`
      : '',
    nonEmptyString(value.reason) ? `reason: ${String(value.reason)}` : '',
  ].filter(Boolean).join(' · ');
}

function summarizeWriteLeaseConflict(value: Record<string, unknown>) {
  const scope = stringArray(value.scope ?? value.write_scope ?? value.writeScope);
  return [
    nonEmptyString(value.task_id ?? value.taskId)
      ? `task: ${String(value.task_id ?? value.taskId)}`
      : '',
    scope.length > 0 ? summarizeWriteScope(scope) : '',
    nonEmptyString(value.reason) ? String(value.reason) : '',
  ].filter(Boolean).join(' ');
}

function nonEmptyString(value: unknown) {
  const text = value == null ? '' : String(value).trim();
  return text || undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => String(item ?? '').trim()).filter(Boolean)
    : [];
}

function firstDefined(values: unknown[]) {
  return values.find((value) => {
    if (value == null || value === '') {
      return false;
    }
    if (Array.isArray(value)) {
      return value.length > 0;
    }
    if (typeof value === 'object') {
      return Object.keys(asRecord(value)).length > 0;
    }
    return true;
  });
}

function ToolExecutionDetail({
  execution,
  message,
  language,
  active,
  onOpenScene,
}: {
  execution: ChatToolExecution;
  message: ChatMessage;
  language: AppLanguage;
  active: boolean;
  onOpenScene: (scene: CardlingScene) => void;
}) {
  const [outputExpanded, setOutputExpanded] = useState(false);
  const scene = cardlingSceneFromToolExecution(execution, message);
  const duration = formatDuration(execution.durationMs);
  const summary = execution.summary.trim();
  const actionEnvelope = toolActionEnvelopeFromExecution(execution);
  const output = toolDisplayOutput(execution, actionEnvelope).trim();
  const childExecutions = subagentChildToolExecutions(execution);
  const runtimeInfo = runtimeProfileInfoFromExecution(execution);
  const hookDecision = toolHookDecisionFromExecution(execution);
  const planningAssessment = planningAssessmentFromExecution(execution);
  const verificationInfo = planVerificationInfoFromExecution(execution);
  const auditSignals = subagentAuditSignalsFromExecution(execution);
  const workerInfo = workerProfileInfoFromExecution(execution);
  const dispatchPlan = planDispatchInfoFromExecution(execution);
  const failed = isToolFailedInContext(execution, active);
  const shouldCollapseOutput = toolOutputNeedsCollapse(output);
  const visibleOutput =
    shouldCollapseOutput && !outputExpanded ? compactToolOutput(output) : output;
  const status = verificationInfo?.failed
    ? language === 'zh'
      ? '节点验证未通过'
      : 'Verification failed'
    : isToolRunningInContext(execution, active)
      ? language === 'zh'
        ? '运行中'
        : 'Running'
      : failed
        ? language === 'zh'
          ? '失败'
          : 'Failed'
        : language === 'zh'
          ? '完成'
          : 'Done';
  return (
    <section className="tool-execution-detail">
      <header>
        <strong>{displayToolName(execution.name)}</strong>
        <span className={verificationInfo?.failed ? 'warning' : failed ? 'failed' : ''}>
          {duration ? `${status} · ${duration}` : status}
        </span>
      </header>
      {summary && <code>$ {summary}</code>}
      <RuntimeProfileBadge info={runtimeInfo} />
      <WorkerProfileBadge info={workerInfo} />
      {actionEnvelope && (
        <ToolActionEnvelopeInfo envelope={actionEnvelope} language={language} />
      )}
      {planningAssessment && (
        <PlanningAssessmentNotice language={language} />
      )}
      {dispatchPlan && (
        <PlanDispatchAdvisorPanel
          plan={dispatchPlan}
          language={language}
          sessionId={message.conversationId ?? ''}
          turnId={message.turnId}
        />
      )}
      {hookDecision && <ToolHookDecisionNotice decision={hookDecision} />}
      {verificationInfo && (
        <PlanVerificationPanel info={verificationInfo} language={language} />
      )}
      {auditSignals && (
        <SubagentAuditSignalsPanel signals={auditSignals} language={language} />
      )}
      {scene && (
        <button
          className="tool-scene-open"
          type="button"
          onClick={() => onOpenScene(scene)}
        >
          <Sparkles size={14} />
          <span>{language === 'zh' ? '打开交互场景' : 'Open interactive scene'}</span>
        </button>
      )}
      <SubagentChildTools
        executions={childExecutions}
        language={language}
        isFailed={(child) => isToolFailedInContext(child, active)}
      />
      {output && (
        <>
          <pre className={`tool-execution-output ${outputExpanded ? 'expanded' : ''}`}>
            {visibleOutput}
          </pre>
          {shouldCollapseOutput && (
            <button
              className="tool-output-toggle"
              type="button"
              onClick={() => setOutputExpanded((value) => !value)}
            >
              {outputExpanded ? '收起输出' : '展开完整输出'}
            </button>
          )}
        </>
      )}
    </section>
  );
}

type WorkerDispatchRecommendation = {
  agentName: string;
  runtimeProfile: string;
  resolvedRuntimeProfile: string;
  expectedHookSet: string;
  workerContractPolicy: string;
  workerContractDefaults: Record<string, unknown>;
  dispatchDecision: string;
  dispatchReady?: boolean;
  requiresUserApproval?: boolean;
  parentAutoDispatchExpected?: boolean;
  parentAutoDispatchPolicy: string;
  whyNotParentDirect: string;
  whyNotParallelTools: string;
  whyNotSubagent: string;
  writeScopeConfidence: string;
  dispatchGroupId: string;
  dispatchGroupNodeIds: string[];
  executionChannel: string;
  writeScope: string[];
  writeLease: Record<string, unknown>;
  ioManifest: Record<string, unknown>;
  successAssertions: string[];
  assertionResults: VerificationAssertionItem[];
  verificationLevel: string;
  lane: string;
  planNodeId: string;
  exitCondition: string;
  task: string;
  raw: Record<string, unknown>;
};

type PlanDispatchInfo = {
  advisor: Record<string, unknown>;
  candidates: WorkerDispatchRecommendation[];
};

function PlanDispatchAdvisorPanel({
  plan,
  language,
  sessionId,
  turnId,
}: {
  plan: PlanDispatchInfo;
  language: AppLanguage;
  sessionId: string;
  turnId?: string;
}) {
  const advisorText = summarizeDispatchAdvisor(plan.advisor, language);
  const groups = groupWorkerDispatchCandidates(plan.candidates);
  return (
    <section className="dispatch-advisor-panel">
      {advisorText && (
        <div className="dispatch-advisor-summary">
          <Network size={13} />
          <span>{advisorText}</span>
        </div>
      )}
      {groups.map((group) => (
        <div className="dispatch-candidate-group" key={group.id}>
          {group.label && (
            <div className="dispatch-candidate-group-label">{group.label}</div>
          )}
          {group.items.map((dispatch, index) => (
            <WorkerDispatchRecommendationCard
              key={`${dispatch.dispatchGroupId || 'candidate'}-${dispatch.planNodeId || index}-${dispatch.agentName}-${index}`}
              dispatch={dispatch}
              language={language}
              sessionId={sessionId}
              turnId={turnId}
            />
          ))}
        </div>
      ))}
    </section>
  );
}

function WorkerDispatchRecommendationCard({
  dispatch,
  language,
  sessionId,
  turnId,
}: {
  dispatch: WorkerDispatchRecommendation;
  language: AppLanguage;
  sessionId: string;
  turnId?: string;
}) {
  const [dispatching, setDispatching] = useState(false);
  const [result, setResult] = useState<SubagentDispatchResult | null>(null);
  const [error, setError] = useState('');
  const autoDispatchExpected =
    dispatch.parentAutoDispatchExpected === true &&
    dispatch.requiresUserApproval === false;
  const activeWriteScope =
    result?.writeScope && result.writeScope.length > 0
      ? result.writeScope
      : dispatch.writeScope;
  const rows = [
    [language === 'zh' ? 'Agent' : 'Agent', dispatch.agentName],
    [language === 'zh' ? '决策' : 'Decision', dispatch.dispatchDecision],
    [
      language === 'zh' ? '就绪' : 'Ready',
      dispatch.dispatchReady == null
        ? ''
        : dispatch.dispatchReady
          ? language === 'zh'
            ? '是'
            : 'Yes'
          : language === 'zh'
            ? '否'
            : 'No',
    ],
    [
      language === 'zh' ? '审批' : 'Approval',
      dispatch.requiresUserApproval == null
        ? ''
        : dispatch.requiresUserApproval
          ? language === 'zh'
            ? '需要用户确认'
            : 'User approval required'
          : language === 'zh'
            ? '不需要'
            : 'Not required',
    ],
    [
      language === 'zh' ? '自动派发' : 'Auto dispatch',
      dispatch.parentAutoDispatchExpected == null
        ? ''
        : dispatch.parentAutoDispatchExpected
          ? language === 'zh'
            ? '父 Agent 可自动执行'
            : 'Parent agent can dispatch'
          : language === 'zh'
            ? '不预期'
            : 'Not expected',
    ],
    [
      language === 'zh' ? '自动策略' : 'Auto policy',
      dispatch.parentAutoDispatchPolicy,
    ],
    [language === 'zh' ? '通道' : 'Channel', dispatch.executionChannel],
    [language === 'zh' ? 'Profile' : 'Profile', dispatch.runtimeProfile],
    [
      language === 'zh' ? '解析 Profile' : 'Resolved',
      result?.resolvedRuntimeProfile ?? dispatch.resolvedRuntimeProfile,
    ],
    [
      language === 'zh' ? 'Hook set' : 'Hook set',
      result?.resolvedHookSet ?? dispatch.expectedHookSet,
    ],
    [
      language === 'zh' ? '契约策略' : 'Contract',
      dispatch.workerContractPolicy,
    ],
    [
      language === 'zh' ? '默认推断' : 'Defaults',
      summarizeWorkerContractDefaults(dispatch.workerContractDefaults),
    ],
    [language === 'zh' ? '组' : 'Group', dispatch.dispatchGroupId],
    [
      language === 'zh' ? '组节点' : 'Group nodes',
      dispatch.dispatchGroupNodeIds.join(', '),
    ],
    [language === 'zh' ? '写入范围' : 'Write scope', summarizeWriteScope(activeWriteScope)],
    [language === 'zh' ? '范围置信' : 'Scope confidence', dispatch.writeScopeConfidence],
    [language === 'zh' ? 'Lane' : 'Lane', dispatch.lane],
    [language === 'zh' ? 'Plan node' : 'Plan node', dispatch.planNodeId],
    [language === 'zh' ? '退出条件' : 'Exit', dispatch.exitCondition],
    [
      language === 'zh' ? '非父级原因' : 'Not parent',
      dispatch.whyNotParentDirect,
    ],
    [
      language === 'zh' ? '非工具并发' : 'Not tools',
      dispatch.whyNotParallelTools,
    ],
    [
      language === 'zh' ? '非子 Agent' : 'Not subagent',
      dispatch.whyNotSubagent,
    ],
  ].filter(([, value]) => value);
  const hasExecutionEvidence =
    Object.keys(dispatch.ioManifest).length > 0 ||
    dispatch.successAssertions.length > 0 ||
    dispatch.assertionResults.length > 0 ||
    Boolean(dispatch.verificationLevel);
  const prompt = workerDispatchPrompt(dispatch);
  const canDispatch = Boolean(sessionId.trim() && dispatch.agentName.trim() && prompt.trim());
  const accepted = result?.accepted && result.status !== 'rejected';
  const statusTone =
    result?.accepted && result.status !== 'rejected'
      ? 'accepted'
      : result || error
        ? 'rejected'
        : '';
  const resolvedStatus = [
    result?.resolvedRuntimeProfile || dispatch.resolvedRuntimeProfile
      ? `profile: ${result?.resolvedRuntimeProfile ?? dispatch.resolvedRuntimeProfile}`
      : '',
    result?.resolvedHookSet || dispatch.expectedHookSet
      ? `hooks: ${result?.resolvedHookSet ?? dispatch.expectedHookSet}`
      : '',
  ].filter(Boolean).join(' · ');
  const writeLeaseStatus = result?.writeLease
    ? summarizeSubagentWriteLease(result.writeLease)
    : '';
  const runDispatch = useCallback(async () => {
    if (!canDispatch || dispatching) {
      return;
    }
    setDispatching(true);
    setError('');
    try {
      const nextResult = await dispatchSubagent({
        sessionId,
        turnId,
        agentName: dispatch.agentName,
        prompt,
        runtimeProfile: dispatch.runtimeProfile,
        lane: dispatch.lane,
        planNodeId: dispatch.planNodeId,
        exitCondition: dispatch.exitCondition,
        writeScope: dispatch.writeScope,
        waitSeconds: 0,
      });
      setResult(nextResult);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setDispatching(false);
    }
  }, [canDispatch, dispatch, dispatching, prompt, sessionId, turnId]);

  return (
    <section className={`worker-dispatch-card ${statusTone}`}>
      <header>
        <Network size={14} />
        <strong>
          {autoDispatchExpected
            ? language === 'zh'
              ? '父 Agent 可自动派发'
              : 'Parent auto-dispatch ready'
            : language === 'zh'
              ? '建议派发子 Agent'
              : 'Recommended worker dispatch'}
        </strong>
        <button
          className={autoDispatchExpected ? 'manual' : 'primary'}
          type="button"
          disabled={!canDispatch || dispatching}
          onClick={() => void runDispatch()}
        >
          {dispatching ? (
            <LoaderCircle size={13} />
          ) : accepted ? (
            <RefreshCw size={13} />
          ) : (
            <Play size={13} />
          )}
          <span>
            {dispatching
              ? language === 'zh'
                ? '派发中'
                : 'Dispatching'
              : accepted
                ? language === 'zh'
                  ? result?.reason === 'already_running'
                    ? '已复用'
                    : autoDispatchExpected
                      ? '调试复用'
                      : '复用检查'
                  : result?.reason === 'already_running'
                    ? 'Reused'
                    : autoDispatchExpected
                      ? 'Debug reuse'
                      : 'Check reuse'
                : language === 'zh'
                  ? autoDispatchExpected
                    ? '手动派发'
                    : '派发'
                  : autoDispatchExpected
                    ? 'Manual dispatch'
                    : 'Dispatch'}
          </span>
        </button>
        <button
          type="button"
          onClick={() =>
            void copyText(JSON.stringify(dispatch.raw, null, 2)).catch(() => undefined)
          }
        >
          <Clipboard size={13} />
          <span>{language === 'zh' ? '复制参数' : 'Copy'}</span>
        </button>
      </header>
      {autoDispatchExpected && (
        <p className="worker-dispatch-status auto">
          {language === 'zh'
            ? '无需用户审批；正常情况下父 Agent 会根据 plan 证据自行派发。这个按钮仅作为手动/调试兜底。'
            : 'No user approval is required; the parent agent should dispatch from plan evidence. This button is only a manual/debug fallback.'}
        </p>
      )}
      {dispatch.task && <p>{dispatch.task}</p>}
      {!canDispatch && (
        <p className="worker-dispatch-status rejected">
          {language === 'zh'
            ? '缺少 session、agent 或 prompt，暂不能派发。'
            : 'Missing session, agent, or prompt; cannot dispatch yet.'}
        </p>
      )}
      {(result || error) && (
        <p className={`worker-dispatch-status ${statusTone || 'rejected'}`}>
          {workerDispatchResultText(result, error, language)}
        </p>
      )}
      {resolvedStatus && (
        <p className="worker-dispatch-status accepted">{resolvedStatus}</p>
      )}
      {writeLeaseStatus && (
        <p className={`worker-dispatch-status ${accepted ? 'accepted' : 'rejected'}`}>
          {writeLeaseStatus}
        </p>
      )}
      {result?.supervisor && (!result.accepted || result.status === 'rejected') && (
        <p className="worker-dispatch-status rejected">
          {[
            result.supervisor.counts
              ? `${language === 'zh' ? '运行数' : 'Counts'}: ${summarizeRecord(result.supervisor.counts as unknown as Record<string, unknown>)}`
              : '',
            result.supervisor.limits
              ? `${language === 'zh' ? '限制' : 'Limits'}: ${summarizeRecord(result.supervisor.limits as unknown as Record<string, unknown>)}`
              : '',
          ].filter(Boolean).join(' · ')}
        </p>
      )}
      {rows.length > 0 && (
        <dl>
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {hasExecutionEvidence && (
        <details className="worker-dispatch-evidence">
          <summary>
            {language === 'zh' ? '输入输出与验收' : 'IO and verification'}
          </summary>
          <dl>
            {dispatch.verificationLevel && (
              <div>
                <dt>{language === 'zh' ? '验证级别' : 'Verification'}</dt>
                <dd>{dispatch.verificationLevel}</dd>
              </div>
            )}
            {Object.keys(dispatch.ioManifest).length > 0 && (
              <div>
                <dt>{language === 'zh' ? 'IO' : 'IO'}</dt>
                <dd>{summarizeIoManifest(dispatch.ioManifest)}</dd>
              </div>
            )}
            {dispatch.successAssertions.length > 0 && (
              <div>
                <dt>{language === 'zh' ? '验收条件' : 'Assertions'}</dt>
                <dd>{dispatch.successAssertions.join(' · ')}</dd>
              </div>
            )}
            {dispatch.assertionResults.length > 0 && (
              <div>
                <dt>{language === 'zh' ? '验收结果' : 'Results'}</dt>
                <dd>{summarizeAssertionResults(dispatch.assertionResults)}</dd>
              </div>
            )}
          </dl>
        </details>
      )}
    </section>
  );
}

function workerDispatchPrompt(dispatch: WorkerDispatchRecommendation) {
  return String(
    dispatch.raw.prompt ??
      dispatch.raw.task ??
      dispatch.raw.instruction ??
      dispatch.raw.user_input ??
      dispatch.raw.userInput ??
      dispatch.task,
  ).trim();
}

function workerDispatchResultText(
  result: SubagentDispatchResult | null,
  error: string,
  language: AppLanguage,
) {
  if (error) {
    return error;
  }
  if (!result) {
    return '';
  }
  if (!result.accepted || result.status === 'rejected') {
    if (result.reason === 'write_lease_conflict') {
      return result.message || (language === 'zh' ? '写租约冲突，未派发' : 'Write lease conflict');
    }
    return result.message || result.reason || (language === 'zh' ? '派发被拒绝' : 'Dispatch rejected');
  }
  const task = result.taskId ? ` · ${result.taskId}` : '';
  if (result.reason === 'already_running') {
    return language === 'zh'
      ? `已有运行中的子 Agent，已复用${task}`
      : `Already running; reused${task}`;
  }
  return language === 'zh'
    ? `子 Agent 已派发${task}`
    : `Subagent dispatched${task}`;
}

function planDispatchInfoFromExecution(
  execution: ChatToolExecution,
): PlanDispatchInfo | null {
  if (!/(^|_)plan$/i.test(execution.name) && execution.name !== 'plan') {
    return null;
  }
  const outputPayload = parseToolOutputJson(execution.output);
  const payloads = [
    execution.metadata,
    asRecord(execution.metadata.plan),
    asRecord(execution.metadata.result),
    asRecord(asRecord(execution.metadata.result).plan),
    outputPayload,
    asRecord(outputPayload.plan),
    asRecord(outputPayload.result),
    asRecord(asRecord(outputPayload.result).plan),
  ];
  const advisor = firstRecord(
    payloads.flatMap((payload) => [
      asRecord(payload.dispatch_advisor),
      asRecord(payload.dispatchAdvisor),
    ]),
  );
  const candidateItems = payloads.flatMap((payload) =>
    arrayRecords(payload.dispatch_candidates ?? payload.dispatchCandidates),
  );
  const candidates = candidateItems
    .map(normalizeWorkerDispatchRecord)
    .filter((item): item is WorkerDispatchRecommendation => item != null);
  if (candidates.length === 0) {
    const legacy = [
      execution.metadata.recommended_worker_dispatch,
      execution.metadata.recommendedWorkerDispatch,
      asRecord(execution.metadata.result).recommended_worker_dispatch,
      asRecord(execution.metadata.result).recommendedWorkerDispatch,
      outputPayload.recommended_worker_dispatch,
      outputPayload.recommendedWorkerDispatch,
      asRecord(outputPayload.result).recommended_worker_dispatch,
      asRecord(outputPayload.result).recommendedWorkerDispatch,
    ].map(asRecord);
    for (const candidate of legacy) {
      const normalized = normalizeWorkerDispatchRecord(candidate);
      if (normalized) {
        candidates.push(normalized);
        break;
      }
    }
  }
  if (Object.keys(advisor).length === 0 && candidates.length === 0) {
    return null;
  }
  return { advisor, candidates };
}

function firstRecord(values: Record<string, unknown>[]) {
  return values.find((value) => Object.keys(value).length > 0) ?? {};
}

function arrayRecords(value: unknown) {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function groupWorkerDispatchCandidates(candidates: WorkerDispatchRecommendation[]) {
  const groups = new Map<string, WorkerDispatchRecommendation[]>();
  candidates.forEach((candidate, index) => {
    const groupKey = candidate.dispatchGroupId ||
      (candidate.dispatchGroupNodeIds.length > 1
        ? candidate.dispatchGroupNodeIds.join('|')
        : `single-${candidate.planNodeId || candidate.agentName || index}`);
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), candidate]);
  });
  return Array.from(groups.entries()).map(([id, items]) => {
    const first = items[0];
    const groupNodes = first?.dispatchGroupNodeIds ?? [];
    const showLabel =
      Boolean(first?.dispatchGroupId) ||
      groupNodes.length > 1 ||
      items.length > 1 ||
      first?.executionChannel === 'parallel_writer';
    const labelParts = [
      first?.executionChannel === 'parallel_writer' ? 'parallel_writer' : '',
      first?.dispatchGroupId ? `group: ${first.dispatchGroupId}` : '',
      groupNodes.length > 0 ? `nodes: ${groupNodes.join(', ')}` : '',
      items.length > 1 ? `candidates: ${items.length}` : '',
    ].filter(Boolean);
    return {
      id,
      label: showLabel ? labelParts.join(' · ') : '',
      items,
    };
  });
}

function summarizeDispatchAdvisor(
  advisor: Record<string, unknown>,
  language: AppLanguage,
) {
  if (Object.keys(advisor).length === 0) {
    return '';
  }
  const currentNode = asRecord(advisor.current_node ?? advisor.currentNode);
  const currentNodeText =
    summarizeAdvisorValue(advisor.current_node ?? advisor.currentNode) ||
    summarizeAdvisorValue(
      currentNode.id ?? currentNode.node_id ?? currentNode.title ?? currentNode.name,
    );
  const recommendedExecution = nonEmptyString(
    advisor.recommended_execution ??
      advisor.recommendedExecution ??
      currentNode.recommended_execution ??
      currentNode.recommendedExecution,
  );
  const decision = nonEmptyString(
    advisor.dispatch_decision ??
      advisor.dispatchDecision ??
      currentNode.dispatch_decision ??
      currentNode.dispatchDecision,
  );
  const requiresApproval = optionalBoolean(
    advisor.requires_user_approval ??
      advisor.requiresUserApproval ??
      currentNode.requires_user_approval ??
      currentNode.requiresUserApproval,
  );
  const autoPolicy = nonEmptyString(
    advisor.parent_auto_dispatch_policy ??
      advisor.parentAutoDispatchPolicy ??
      currentNode.parent_auto_dispatch_policy ??
      currentNode.parentAutoDispatchPolicy,
  );
  const parts = [
    currentNodeText
      ? `${language === 'zh' ? '当前节点' : 'Node'}: ${currentNodeText}`
      : '',
    recommendedExecution
      ? `${language === 'zh' ? '推荐' : 'Recommended'}: ${recommendedExecution}`
      : '',
    decision ? `${language === 'zh' ? '决策' : 'Decision'}: ${decision}` : '',
    requiresApproval === false
      ? language === 'zh'
        ? '无需用户审批'
        : 'No user approval'
      : '',
    autoPolicy
      ? `${language === 'zh' ? '自动策略' : 'Auto policy'}: ${autoPolicy}`
      : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

function summarizeAdvisorValue(value: unknown) {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }
  const record = asRecord(value);
  if (Object.keys(record).length === 0) {
    return '';
  }
  const label = nonEmptyString(record.label ?? record.title ?? record.name);
  const id = nonEmptyString(record.id ?? record.node_id ?? record.nodeId);
  return [id, label && label !== id ? label : ''].filter(Boolean).join(' · ');
}

function normalizeWorkerDispatchRecord(
  value: Record<string, unknown>,
): WorkerDispatchRecommendation | null {
  if (Object.keys(value).length === 0) {
    return null;
  }
  const agentName = nonEmptyString(
    value.agent_name ?? value.agentName ?? value.name ?? value.agent,
  ) ?? '';
  const runtimeProfile = nonEmptyString(
    value.runtime_profile ??
      value.runtimeProfile ??
      value.agent_profile ??
      value.agentProfile,
  ) ?? '';
  const lane = nonEmptyString(value.lane ?? value.profile_lane ?? value.profileLane) ?? '';
  const resolvedRuntimeProfile = nonEmptyString(
    value.resolved_runtime_profile ?? value.resolvedRuntimeProfile,
  ) ?? '';
  const expectedHookSet = nonEmptyString(
    value.expected_hook_set ??
      value.expectedHookSet ??
      value.resolved_hook_set ??
      value.resolvedHookSet,
  ) ?? '';
  const workerContractPolicy = nonEmptyString(
    value.worker_contract_policy ?? value.workerContractPolicy,
  ) ?? '';
  const workerContractDefaults = asRecord(
    value.worker_contract_defaults ?? value.workerContractDefaults,
  );
  const dispatchDecision = nonEmptyString(
    value.dispatch_decision ?? value.dispatchDecision,
  ) ?? '';
  const dispatchReady = optionalBoolean(value.dispatch_ready ?? value.dispatchReady);
  const requiresUserApproval = optionalBoolean(
    value.requires_user_approval ?? value.requiresUserApproval,
  );
  const parentAutoDispatchExpected = optionalBoolean(
    value.parent_auto_dispatch_expected ?? value.parentAutoDispatchExpected,
  );
  const parentAutoDispatchPolicy = nonEmptyString(
    value.parent_auto_dispatch_policy ?? value.parentAutoDispatchPolicy,
  ) ?? '';
  const whyNotParentDirect = nonEmptyString(
    value.why_not_parent_direct ?? value.whyNotParentDirect,
  ) ?? '';
  const whyNotParallelTools = nonEmptyString(
    value.why_not_parallel_tools ?? value.whyNotParallelTools,
  ) ?? '';
  const whyNotSubagent = nonEmptyString(
    value.why_not_subagent ?? value.whyNotSubagent,
  ) ?? '';
  const writeScopeConfidence = nonEmptyString(
    value.write_scope_confidence ?? value.writeScopeConfidence,
  ) ?? '';
  const dispatchGroupId = nonEmptyString(
    value.dispatch_group_id ?? value.dispatchGroupId,
  ) ?? '';
  const dispatchGroupNodeIds = stringArray(
    value.dispatch_group_node_ids ?? value.dispatchGroupNodeIds,
  );
  const executionChannel = nonEmptyString(
    value.execution_channel ?? value.executionChannel,
  ) ?? '';
  const writeScope = stringArray(
    value.write_scope ??
      value.writeScope ??
      value.subagent_write_scope ??
      value.subagentWriteScope,
  );
  const writeLease = asRecord(
    value.write_lease ??
      value.writeLease ??
      value.subagent_write_lease ??
      value.subagentWriteLease,
  );
  const ioManifest = asRecord(value.io_manifest ?? value.ioManifest);
  const successAssertions = stringArrayLoose(
    value.success_assertions ?? value.successAssertions,
  );
  const assertionResults = normalizeAssertionResults(
    value.assertion_results ?? value.assertionResults,
  );
  const verificationLevel = nonEmptyString(
    value.verification_level ?? value.verificationLevel,
  ) ?? '';
  const planNodeId = nonEmptyString(
    value.plan_node_id ?? value.planNodeId ?? value.node_id ?? value.nodeId,
  ) ?? '';
  const exitCondition = nonEmptyString(
    value.exit_condition ?? value.exitCondition,
  ) ?? '';
  const task = nonEmptyString(
    value.task ?? value.prompt ?? value.instruction ?? value.title ?? value.summary,
  ) ?? '';
  if (!agentName && !runtimeProfile && !lane && !planNodeId && !exitCondition) {
    return null;
  }
  return {
    agentName,
    runtimeProfile,
    resolvedRuntimeProfile,
    expectedHookSet,
    workerContractPolicy,
    workerContractDefaults,
    dispatchDecision,
    dispatchReady,
    requiresUserApproval,
    parentAutoDispatchExpected,
    parentAutoDispatchPolicy,
    whyNotParentDirect,
    whyNotParallelTools,
    whyNotSubagent,
    writeScopeConfidence,
    dispatchGroupId,
    dispatchGroupNodeIds,
    executionChannel,
    writeScope,
    writeLease,
    ioManifest,
    successAssertions,
    assertionResults,
    verificationLevel,
    lane,
    planNodeId,
    exitCondition,
    task,
    raw: value,
  };
}

function optionalBoolean(value: unknown) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === 'yes') {
      return true;
    }
    if (normalized === 'false' || normalized === 'no') {
      return false;
    }
  }
  return undefined;
}

function workerProfileInfoFromExecution(execution: ChatToolExecution) {
  const metadata = execution.metadata;
  const outputPayload = parseToolOutputJson(execution.output);
  const candidate = normalizeWorkerDispatchRecord({
    agent_name:
      metadata.agent_name ??
      metadata.agentName ??
      metadata.subagent_name ??
      metadata.subagentName ??
      outputPayload.agent_name ??
      outputPayload.agentName,
    runtime_profile:
      metadata.runtime_profile ??
      metadata.runtimeProfile ??
      metadata.subagent_runtime_profile ??
      metadata.subagentRuntimeProfile ??
      outputPayload.runtime_profile ??
      outputPayload.runtimeProfile,
    lane:
      metadata.lane ??
      metadata.subagent_lane ??
      metadata.subagentLane ??
      outputPayload.lane,
    plan_node_id:
      metadata.plan_node_id ??
      metadata.planNodeId ??
      metadata.subagent_plan_node_id ??
      metadata.subagentPlanNodeId ??
      outputPayload.plan_node_id ??
      outputPayload.planNodeId,
    exit_condition:
      metadata.exit_condition ??
      metadata.exitCondition ??
      outputPayload.exit_condition ??
      outputPayload.exitCondition,
    resolved_runtime_profile:
      metadata.resolved_runtime_profile ??
      metadata.resolvedRuntimeProfile ??
      metadata.subagent_resolved_runtime_profile ??
      metadata.subagentResolvedRuntimeProfile ??
      outputPayload.resolved_runtime_profile ??
      outputPayload.resolvedRuntimeProfile,
    expected_hook_set:
      metadata.expected_hook_set ??
      metadata.expectedHookSet ??
      metadata.resolved_hook_set ??
      metadata.resolvedHookSet ??
      metadata.subagent_resolved_hook_set ??
      metadata.subagentResolvedHookSet ??
      outputPayload.expected_hook_set ??
      outputPayload.expectedHookSet ??
      outputPayload.resolved_hook_set ??
      outputPayload.resolvedHookSet,
    worker_contract_policy:
      metadata.worker_contract_policy ??
      metadata.workerContractPolicy ??
      outputPayload.worker_contract_policy ??
      outputPayload.workerContractPolicy,
    worker_contract_defaults:
      metadata.worker_contract_defaults ??
      metadata.workerContractDefaults ??
      outputPayload.worker_contract_defaults ??
      outputPayload.workerContractDefaults,
    dispatch_decision:
      metadata.dispatch_decision ??
      metadata.dispatchDecision ??
      outputPayload.dispatch_decision ??
      outputPayload.dispatchDecision,
    dispatch_ready:
      metadata.dispatch_ready ??
      metadata.dispatchReady ??
      outputPayload.dispatch_ready ??
      outputPayload.dispatchReady,
    write_scope_confidence:
      metadata.write_scope_confidence ??
      metadata.writeScopeConfidence ??
      outputPayload.write_scope_confidence ??
      outputPayload.writeScopeConfidence,
    execution_channel:
      metadata.execution_channel ??
      metadata.executionChannel ??
      outputPayload.execution_channel ??
      outputPayload.executionChannel,
    write_scope:
      metadata.write_scope ??
      metadata.writeScope ??
      metadata.subagent_write_scope ??
      metadata.subagentWriteScope ??
      outputPayload.write_scope ??
      outputPayload.writeScope,
    write_lease:
      metadata.write_lease ??
      metadata.writeLease ??
      metadata.subagent_write_lease ??
      metadata.subagentWriteLease ??
      outputPayload.write_lease ??
      outputPayload.writeLease,
  });
  if (!candidate) {
    return '';
  }
  const parts = [
    candidate.agentName ? `agent: ${candidate.agentName}` : '',
    candidate.dispatchDecision ? `decision: ${candidate.dispatchDecision}` : '',
    candidate.dispatchReady != null ? `ready: ${candidate.dispatchReady ? 'yes' : 'no'}` : '',
    candidate.executionChannel ? `channel: ${candidate.executionChannel}` : '',
    candidate.runtimeProfile ? `profile: ${candidate.runtimeProfile}` : '',
    candidate.resolvedRuntimeProfile ? `resolved: ${candidate.resolvedRuntimeProfile}` : '',
    candidate.expectedHookSet ? `hooks: ${candidate.expectedHookSet}` : '',
    candidate.workerContractPolicy ? `policy: ${candidate.workerContractPolicy}` : '',
    Object.keys(candidate.workerContractDefaults).length > 0
      ? `defaults: ${summarizeWorkerContractDefaults(candidate.workerContractDefaults)}`
      : '',
    candidate.writeScope.length > 0 ? `scope: ${summarizeWriteScope(candidate.writeScope)}` : '',
    candidate.writeScopeConfidence ? `scope confidence: ${candidate.writeScopeConfidence}` : '',
    Object.keys(candidate.writeLease).length > 0
      ? `lease: ${summarizeWriteLeaseRecord(candidate.writeLease)}`
      : '',
    candidate.lane ? `lane: ${candidate.lane}` : '',
    candidate.planNodeId ? `node: ${candidate.planNodeId}` : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

function agentHookSummaryFromMessage(message: ChatMessage) {
  const metadata = asRecord(message.metadata);
  const summary = asRecord(
    metadata.agent_hook_summary ??
      metadata.agentHookSummary ??
      metadata.hook_summary ??
      metadata.hookSummary,
  );
  if (Object.keys(summary).length === 0) {
    return null;
  }
  const changedFilesRaw = summary.changed_files ?? summary.changedFiles;
  const changedFiles = Array.isArray(changedFilesRaw)
    ? changedFilesRaw.map(String).filter(Boolean)
    : [];
  return {
    changedFiles,
    verificationRequired: Boolean(
      summary.verification_required ?? summary.verificationRequired,
    ),
    verificationStatus: String(
      summary.verification_status ?? summary.verificationStatus ?? '',
    ).trim(),
    verificationEvidence: summary.verification_evidence ?? summary.verificationEvidence,
  };
}

function hookVerificationStatusLabel(
  status: string,
  required: boolean,
  language: AppLanguage,
) {
  const normalized = status.trim().toLowerCase();
  if (normalized === 'satisfied' || normalized === 'verified') {
    return language === 'zh' ? '验证已满足' : 'verified';
  }
  if (normalized === 'attempted_failed' || normalized === 'failed') {
    return language === 'zh' ? '验证失败' : 'verification failed';
  }
  if (normalized === 'attempted' || normalized === 'attempted_unknown') {
    return language === 'zh' ? '已尝试验证' : 'verification attempted';
  }
  if (required) {
    return language === 'zh' ? '需要验证' : 'verification required';
  }
  return language === 'zh' ? '无强制验证' : 'no verification required';
}

function toolOutputNeedsCollapse(output: string) {
  if (!output.trim()) {
    return false;
  }
  return output.length > 320 || output.split(/\r?\n/).length > 4;
}

function compactToolOutput(output: string) {
  const lines = output.split(/\r?\n/);
  const preview = lines.slice(0, 3).join('\n');
  if (preview.length <= 320) {
    return preview;
  }
  return `${preview.slice(0, 320).trimEnd()}...`;
}

function toolDisplayOutput(
  execution: ChatToolExecution,
  envelope: ToolActionEnvelope | null,
) {
  if (!envelope || envelope.result == null || envelope.result === '') {
    return execution.output;
  }
  if (typeof envelope.result === 'string') {
    return envelope.result;
  }
  try {
    return JSON.stringify(envelope.result, null, 2);
  } catch {
    return String(envelope.result);
  }
}

function isToolFailed(execution: ChatToolExecution) {
  if (isSubagentDispatchRejectionExecution(execution)) {
    return false;
  }
  const verificationInfo = planVerificationInfoFromExecution(execution);
  if (verificationInfo?.failed) {
    return false;
  }
  const normalized = execution.state.trim().toLowerCase();
  return (
    ['fail', 'failed', 'error'].includes(normalized) ||
    (!execution.success && !isToolRunning(execution))
  );
}

function isToolFailedInContext(execution: ChatToolExecution, active: boolean) {
  if (!active && isToolRunning(execution)) {
    return false;
  }
  return isToolFailed(execution);
}

type ToolExecutionTone = 'neutral' | 'warning' | 'danger';

function toolExecutionTone(executions: ChatToolExecution[]): ToolExecutionTone {
  const settled = executions.filter((execution) => !isToolRunning(execution));
  if (settled.length === 0) {
    return 'neutral';
  }
  const failedCount = settled.filter(isToolFailed).length;
  if (failedCount > 1 && failedCount / settled.length > 0.5) {
    return 'danger';
  }
  const latestSettled = [...settled].sort(compareToolExecutionOrder).at(-1);
  if (latestSettled && isToolFailed(latestSettled)) {
    return 'warning';
  }
  return 'neutral';
}

function toolExecutionToneInContext(
  executions: ChatToolExecution[],
  active: boolean,
): ToolExecutionTone {
  if (active) {
    return toolExecutionTone(executions);
  }
  const failedCount = executions.filter((execution) =>
    isToolFailedInContext(execution, active),
  ).length;
  if (failedCount > 1 && failedCount / executions.length > 0.5) {
    return 'danger';
  }
  const latest = [...executions].sort(compareToolExecutionOrder).at(-1);
  if (latest && isToolFailedInContext(latest, active)) {
    return 'warning';
  }
  return 'neutral';
}

function conversationProjectDir(conversation?: ConversationSummary | null) {
  if (conversation?.workspaceContext?.mode === 'task') {
    return '';
  }
  return (
    conversation?.projectDir?.trim() ||
    (conversation?.workspaceContext?.mode === 'project'
      ? conversation.workspaceContext.projectDir?.trim() || ''
      : '') ||
    ''
  );
}

function conversationWorkspaceRoot(conversation?: ConversationSummary | null) {
  return (
    conversationProjectDir(conversation) ||
    conversation?.workspaceContext?.executionRoot?.trim() ||
    ''
  );
}

function changeRootForConversation(conversation?: ConversationSummary | null) {
  return conversationWorkspaceRoot(conversation);
}

function metadataInt(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : 0;
}

function asRecord(value: unknown) {
  return value != null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function cardlingSceneFromToolExecution(
  execution: ChatToolExecution,
  message: ChatMessage,
): CardlingScene | null {
  const metadata = execution.metadata;
  const kind = String(metadata.kind ?? metadata.type ?? '').trim();
  const name = execution.name.trim();
  if (
    kind !== 'cardling_scene' &&
    name !== 'present_cardling_scene' &&
    name !== 'cardling_scene'
  ) {
    return null;
  }
  const rawScene = asRecord(metadata.scene ?? metadata.cardling_scene ?? metadata);
  return cardlingSceneFromRawScene(rawScene, {
    metadata,
    executionId: execution.id,
    summary: execution.summary,
    sessionId: message.conversationId,
    turnId: message.turnId,
  });
}

function cardlingSceneFromSessionSceneRecord(
  record: SessionSceneRecord,
  fallbackSessionId?: string,
): CardlingScene | null {
  const raw = asRecord(record.raw);
  const rawScene = scenePayloadFromRecord(raw);
  const metadata = asRecord(
    raw.metadata ?? rawScene.metadata ?? asRecord(rawScene).metadata,
  );
  return cardlingSceneFromRawScene(rawScene, {
    metadata,
    executionId: sceneString(
      raw.source_execution_id ??
        raw.sourceExecutionId ??
        raw.tool_call_id ??
        raw.toolCallId,
    ),
    summary: sceneString(raw.title ?? rawScene.title),
    sessionId:
      record.sessionId ??
      sceneString(raw.session_id ?? raw.sessionId) ??
      fallbackSessionId,
    turnId: record.turnId ?? sceneString(raw.turn_id ?? raw.turnId),
  });
}

function cardlingSceneFromRawScene(
  rawScene: Record<string, unknown>,
  {
    metadata,
    executionId,
    summary,
    sessionId,
    turnId,
  }: {
    metadata: Record<string, unknown>;
    executionId?: string;
    summary?: string;
    sessionId?: string;
    turnId?: string;
  },
): CardlingScene | null {
  const html = String(rawScene.html ?? rawScene.content ?? '');
  if (!html.trim()) {
    return null;
  }
  const rawCardling = asRecord(rawScene.cardling ?? metadata.cardling);
  const rawAnchor = asRecord(rawCardling.anchor ?? rawScene.anchor);
  const modeText = String(rawCardling.mode ?? rawScene.mode ?? 'embedded').trim();
  const moodText = String(rawCardling.mood ?? rawScene.mood ?? 'explain').trim();
  const placementText = String(rawAnchor.placement ?? 'right').trim();
  const sceneId =
    sceneString(
      rawScene.scene_id ??
        rawScene.sceneId ??
        metadata.scene_id ??
        metadata.sceneId,
    ) || (executionId ? `scene-${executionId}` : '');
  if (!sceneId) {
    return null;
  }
  return {
    sceneId,
    title:
      sceneString(rawScene.title ?? metadata.title ?? summary) ||
      'Kabu Scene',
    html,
    sourceExecutionId: executionId,
    sessionId,
    turnId,
    cardling: {
      mode: modeText === 'floating' ? 'floating' : 'embedded',
      speech: sceneString(rawCardling.speech ?? rawCardling.text ?? rawScene.speech) || '',
      mood: isCardlingSceneMood(moodText) ? moodText : 'explain',
      anchor: {
        nodeId: sceneString(
          rawAnchor.node_id ?? rawAnchor.nodeId ?? rawCardling.node_id,
        ),
        selector: sceneString(rawAnchor.selector ?? rawCardling.selector),
        placement: isCardlingScenePlacement(placementText)
          ? placementText
          : 'right',
        offset: {
          x: metadataInt(asRecord(rawAnchor.offset).x ?? rawAnchor.offset_x),
          y: metadataInt(asRecord(rawAnchor.offset).y ?? rawAnchor.offset_y),
        },
      },
      position:
        rawCardling.position != null
          ? (rawCardling.position as string | { x: number; y: number })
          : undefined,
    },
    nodes: parseCardlingSceneNodes(rawScene.nodes),
    expectedUserAction: parseCardlingExpectedAction(
      rawScene.expected_user_action ?? rawScene.expectedUserAction,
    ),
    raw: rawScene,
  };
}

function scenePayloadFromRecord(payload: Record<string, unknown>) {
  const data = asRecord(payload.data);
  const item = asRecord(payload.item);
  const scene = asRecord(payload.scene);
  const metadata = asRecord(payload.metadata);
  const candidates = [
    scene,
    asRecord(payload.cardling_scene),
    asRecord(metadata.scene),
    asRecord(metadata.cardling_scene),
    item,
    data,
    payload,
  ];
  return (
    candidates.find(
      (candidate) =>
        candidate.html != null ||
        candidate.content != null ||
        candidate.scene_id != null ||
        candidate.sceneId != null,
    ) ?? payload
  );
}

function hasSceneHtml(payload: Record<string, unknown>) {
  const rawScene = scenePayloadFromRecord(payload);
  return String(rawScene.html ?? rawScene.content ?? '').trim().length > 0;
}

function latestSessionSceneRecord(records: SessionSceneRecord[]) {
  if (records.length === 0) {
    return null;
  }
  return [...records].sort(
    (a, b) => sceneRecordTimestamp(a) - sceneRecordTimestamp(b),
  )[records.length - 1];
}

function sceneRecordTimestamp(record: SessionSceneRecord) {
  const raw = asRecord(record.raw);
  const value =
    record.updatedAt ??
    record.createdAt ??
    sceneString(raw.updated_at ?? raw.updatedAt ?? raw.created_at ?? raw.createdAt);
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function parseCardlingSceneNodes(value: unknown): CardlingScene['nodes'] {
  if (!Array.isArray(value)) {
    return [];
  }
  const nodes: CardlingScene['nodes'] = [];
  for (const item of value) {
    const node = asRecord(item);
    const nodeId = sceneString(node.node_id ?? node.nodeId ?? node.id);
    if (!nodeId) {
      continue;
    }
    nodes.push({
      nodeId,
      label: sceneString(node.label),
      purpose: sceneString(node.purpose),
    });
  }
  return nodes;
}

function parseCardlingExpectedAction(value: unknown): CardlingScene['expectedUserAction'] {
  const action = asRecord(value);
  return {
    type: sceneString(action.type),
    required: Boolean(action.required),
  };
}

function initialSceneSelectedNodeId(
  scene: CardlingScene,
  steps: CardlingSceneStep[],
) {
  if (steps.length > 0) {
    return steps[0]?.nodeId ?? '';
  }
  return scene.cardling.anchor?.nodeId ?? scene.nodes[0]?.nodeId ?? '';
}

function sceneFeedbackId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `scene-feedback-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function buildCardlingSceneSteps(
  scene: CardlingScene,
  language: AppLanguage,
): CardlingSceneStep[] {
  const explicitSteps = parseCardlingPresentationSteps(scene, language);
  if (explicitSteps.length > 0) {
    return explicitSteps;
  }
  const fallbackSpeech = scene.cardling.speech.trim();
  if (scene.nodes.length === 0) {
    return [
      {
        id: 'scene-intro',
        title: scene.title,
        speech:
          fallbackSpeech ||
          (language === 'zh'
            ? '我已打开这个交互场景，可以直接在页面节点上给我反馈。'
            : 'I opened this interactive scene. You can comment on nodes directly.'),
        holdMs: 900,
      },
    ];
  }
  const anchorNodeId = scene.cardling.anchor?.nodeId ?? scene.nodes[0]?.nodeId;
  return scene.nodes.map((node, index) => {
    const title = node.label || node.nodeId;
    const shouldUseSceneSpeech =
      Boolean(fallbackSpeech) && (node.nodeId === anchorNodeId || index === 0);
    return {
      id: `node-${node.nodeId}`,
      nodeId: node.nodeId,
      title,
      speech: shouldUseSceneSpeech
        ? fallbackSpeech
        : nodePurposeSpeech(node, language),
      holdMs: 720,
    };
  });
}

function parseCardlingPresentationSteps(
  scene: CardlingScene,
  language: AppLanguage,
): CardlingSceneStep[] {
  const rawCardling = asRecord(scene.raw.cardling);
  const presentation = asRecord(
    scene.raw.presentation ??
      scene.raw.timeline ??
      scene.raw.playback ??
      rawCardling.presentation ??
      rawCardling.timeline,
  );
  const rawSteps = Array.isArray(presentation.steps)
    ? presentation.steps
    : Array.isArray(scene.raw.steps)
      ? scene.raw.steps
      : [];
  const steps: CardlingSceneStep[] = [];
  rawSteps.forEach((item, index) => {
    const step = asRecord(item);
    const nodeId = sceneString(
      step.node_id ??
        step.nodeId ??
        step.target_node_id ??
        step.targetNodeId ??
        step.anchor_node_id ??
        step.anchorNodeId,
    );
    const node = nodeId
      ? scene.nodes.find((candidate) => candidate.nodeId === nodeId)
      : undefined;
    const title =
      sceneString(step.title ?? step.label ?? step.name) ||
      node?.label ||
      nodeId ||
      `Step ${index + 1}`;
    const speech =
      sceneString(
        step.speech ??
          step.text ??
          step.message ??
          step.narration ??
          step.description,
      ) ||
      nodePurposeSpeech(node, language) ||
      scene.cardling.speech;
    if (!speech && !nodeId) {
      return;
    }
    const holdMs =
      metadataInt(step.hold_ms ?? step.holdMs ?? step.duration_ms ?? step.durationMs) ||
      820;
    steps.push({
      id: sceneString(step.id) || `step-${index + 1}`,
      nodeId,
      title,
      speech,
      holdMs: Math.min(Math.max(holdMs, 320), 3000),
    });
  });
  return steps;
}

function nodePurposeSpeech(
  node: CardlingScene['nodes'][number] | undefined,
  language: AppLanguage,
) {
  if (!node) {
    return '';
  }
  const label = node.label || node.nodeId;
  if (node.purpose) {
    return language === 'zh'
      ? `${label}：${node.purpose}`
      : `${label}: ${node.purpose}`;
  }
  return language === 'zh'
    ? `${label}：这里可以作为当前任务场景的反馈节点。`
    : `${label}: This is a feedback node in the current task scene.`;
}

function latestCardlingSceneFromMessages(messages: ChatMessage[]) {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    const executions = message.toolExecutions ?? [];
    for (let index = executions.length - 1; index >= 0; index -= 1) {
      const scene = cardlingSceneFromToolExecution(executions[index], message);
      if (scene) {
        return scene;
      }
    }
  }
  return null;
}

function cardlingSceneKey(scene: CardlingScene) {
  return `${scene.sceneId}:${scene.sourceExecutionId ?? ''}:${scene.turnId ?? ''}`;
}

function cardlingSceneRevisionKey(scene: CardlingScene) {
  return JSON.stringify({
    key: cardlingSceneKey(scene),
    title: scene.title,
    html: scene.html,
    cardling: scene.cardling,
    nodes: scene.nodes,
    expectedUserAction: scene.expectedUserAction,
  });
}

function sceneAutoPlayEnabled(scene: CardlingScene) {
  const rawCardling = asRecord(scene.raw.cardling);
  const presentation = asRecord(
    scene.raw.presentation ??
      scene.raw.timeline ??
      scene.raw.playback ??
      rawCardling.presentation ??
      rawCardling.timeline,
  );
  const autoPlay = sceneBoolean(
    presentation.auto_play ??
      presentation.autoPlay ??
      scene.raw.auto_play ??
      scene.raw.autoPlay ??
      rawCardling.auto_play ??
      rawCardling.autoPlay,
  );
  return autoPlay ?? true;
}

function sceneBoolean(value: unknown) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) {
      return false;
    }
  }
  return undefined;
}

function sceneString(value: unknown) {
  const text = value == null ? '' : String(value);
  return text.trim() ? text : undefined;
}

function isCardlingScenePlacement(value: string): value is CardlingScenePlacement {
  return value === 'top' || value === 'right' || value === 'bottom' || value === 'left';
}

function isCardlingSceneMood(value: string): value is CardlingSceneMood {
  return (
    value === 'explain' ||
    value === 'ask' ||
    value === 'confirm' ||
    value === 'warn' ||
    value === 'celebrate'
  );
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

function assistantProgressLabel({
  executions,
  isActive,
  message,
  now,
  language,
}: {
  executions: ChatToolExecution[];
  isActive: boolean;
  message: ChatMessage;
  now: number;
  language: AppLanguage;
}) {
  const elapsedMs = assistantTurnElapsedMs(message, executions, isActive, now);
  const duration = formatCompactDuration(elapsedMs);
  if (language === 'zh') {
    return duration ? `已处理 ${duration}` : '已处理';
  }
  return duration ? `Processed ${duration}` : 'Processed';
}

function assistantTurnElapsedMs(
  message: ChatMessage,
  executions: ChatToolExecution[],
  isActive: boolean,
  now: number,
) {
  const metadata = message.metadata ?? {};
  const startedAt = earliestTimestamp([
    metadata.cardbush_turn_started_at,
    metadata.turn_started_at,
    metadata.started_at,
    message.createdAt,
    ...executions.map((execution) => execution.createdAt),
  ]);
  if (isActive) {
    return startedAt == null ? 0 : Math.max(0, now - startedAt);
  }
  const completedAt = latestTimestamp([
    metadata.cardbush_turn_completed_at,
    metadata.completed_at,
    metadata.done_at,
    metadata.finished_at,
    message.createdAt,
    ...executions.map((execution) => toolExecutionFinishedAt(execution)),
  ]);
  if (startedAt != null && completedAt != null && completedAt >= startedAt) {
    return completedAt - startedAt;
  }
  return executions.reduce((total, execution) => total + Math.max(0, execution.durationMs), 0);
}

function toolExecutionFinishedAt(execution: ChatToolExecution) {
  const startedAt = parseTimestamp(execution.createdAt);
  if (startedAt == null) {
    return undefined;
  }
  return startedAt + Math.max(0, execution.durationMs);
}

function earliestTimestamp(values: unknown[]) {
  const timestamps = values
    .map(parseTimestamp)
    .filter((value): value is number => value != null);
  return timestamps.length > 0 ? Math.min(...timestamps) : undefined;
}

function latestTimestamp(values: unknown[]) {
  const timestamps = values
    .map(parseTimestamp)
    .filter((value): value is number => value != null);
  return timestamps.length > 0 ? Math.max(...timestamps) : undefined;
}

function parseTimestamp(value: unknown) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : undefined;
}

function formatCompactDuration(durationMs: number) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return '';
  }
  const seconds = Math.max(1, Math.round(durationMs / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function GuidanceDialog({
  language,
  onCancel,
  onSubmit,
}: {
  language: AppLanguage;
  onCancel: () => void;
  onSubmit: (guidance: string, mode: GuidanceMode) => Promise<void>;
}) {
  const [guidance, setGuidance] = useState('');
  const [mode, setMode] = useState<GuidanceMode>('append_context');
  const [submitting, setSubmitting] = useState(false);
  const modeOptions: Array<{
    value: GuidanceMode;
    title: string;
    description: string;
  }> = [
    {
      value: 'append_context',
      title: language === 'zh' ? '补充给当前回合' : 'Add to current turn',
      description:
        language === 'zh'
          ? '不打断正在运行的任务，把这段话作为即时引导注入。'
          : 'Keep the task running and inject this as immediate guidance.',
    },
    {
      value: 'interrupt_and_continue',
      title: language === 'zh' ? '中断后继续' : 'Interrupt and continue',
      description:
        language === 'zh'
          ? '让当前回合停在这里，再按你的新引导继续处理。'
          : 'Pause the current turn here, then continue with this guidance.',
    },
  ];

  async function submit(event?: FormEvent) {
    event?.preventDefault();
    const text = guidance.trim();
    if (!text || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(text, mode);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      className="modal-backdrop guidance-dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onCancel();
        }
      }}
    >
      <form className="guidance-dialog" onSubmit={(event) => void submit(event)}>
        <header>
          <Sparkles size={18} />
          <strong>{language === 'zh' ? '插入引导' : 'Guide this turn'}</strong>
          <button type="button" onClick={onCancel}>
            <X size={16} />
          </button>
        </header>
        <textarea
          value={guidance}
          autoFocus
          onChange={(event) => setGuidance(event.currentTarget.value)}
          placeholder={
            language === 'zh'
              ? '例如：先别写代码，先解释风险点'
              : 'For example: pause coding and explain the risks first'
          }
          rows={4}
        />
        <div className="guidance-mode-field">
          <span>{language === 'zh' ? '处理方式' : 'Mode'}</span>
          <div
            className="guidance-mode-options"
            role="radiogroup"
            aria-label={language === 'zh' ? '处理方式' : 'Guidance mode'}
          >
            {modeOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                className={mode === option.value ? 'active' : ''}
                aria-pressed={mode === option.value}
                disabled={submitting}
                onClick={() => setMode(option.value)}
              >
                <span>
                  <strong>{option.title}</strong>
                  <small>{option.description}</small>
                </span>
                {mode === option.value && <Check size={15} />}
              </button>
            ))}
          </div>
        </div>
        <footer>
          <button type="button" onClick={onCancel} disabled={submitting}>
            {language === 'zh' ? '取消' : 'Cancel'}
          </button>
          <button
            className="primary-button"
            type="submit"
            disabled={submitting || !guidance.trim()}
          >
            {submitting ? <LoaderCircle size={14} /> : <ArrowUp size={14} />}
            {language === 'zh' ? '发送' : 'Send'}
          </button>
        </footer>
      </form>
    </div>
  );
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

function MessageImageStrip({ paths }: { paths: string[] }) {
  const [preview, setPreview] = useState<ImagePreview | null>(null);
  if (paths.length === 0) {
    return null;
  }
  return (
    <>
      <div className="message-image-strip">
        {paths.map((pathValue, index) => {
          const src = fileUrl(pathValue);
          const name = basename(pathValue);
          return (
            <button
              className="message-image-preview"
              type="button"
              key={`${pathValue}-${index}`}
              title={name}
              onClick={() => setPreview({ src, name, path: pathValue })}
            >
              <img src={src} alt={name} />
            </button>
          );
        })}
      </div>
      {preview && (
        <ImagePreviewDialog
          image={preview}
          onClose={() => setPreview(null)}
        />
      )}
    </>
  );
}

function ImagePreviewDialog({
  image,
  onClose,
}: {
  image: ImagePreview;
  onClose: () => void;
}) {
  return (
    <div
      className="modal-backdrop image-preview-backdrop"
      onMouseDown={onClose}
    >
      <section
        className="image-preview-dialog"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <strong title={image.path ?? image.name}>{image.name}</strong>
          <button type="button" onClick={onClose} aria-label="close preview">
            <X size={16} />
          </button>
        </header>
        <div className="image-preview-stage">
          <img src={image.src} alt={image.name} />
        </div>
      </section>
    </div>
  );
}

function MarkdownContent({ content }: { content: string }) {
  return (
    <Suspense fallback={<p className="markdown-fallback">{content}</p>}>
      <LazyMarkdownContent content={content} />
    </Suspense>
  );
}

function Composer({
  compact,
  language,
  draft,
  onDraftChange,
  sending,
  queuedMessageCount = 0,
  queuedMessagePreview = '',
  selectedModel,
  availableModels,
  selectedRuntimeProfile,
  runtimeProfiles,
  referencePlanMode,
  onModelChange,
  onRuntimeProfileChange,
  onReferencePlanModeChange,
  onSend,
  onCancel,
  messages = [],
  skills = [],
  disabledSkillNames,
  activeProjectDir,
  projectContext = '',
  onQuickLoad,
  onSaveProjectContext,
  onConfigureModels,
  onCreateConversation,
  onOpenTerminalConsole,
  onToggleSkill,
}: {
  compact?: boolean;
  language: AppLanguage;
  draft: string;
  onDraftChange: (value: string) => void;
  sending: boolean;
  queuedMessageCount?: number;
  queuedMessagePreview?: string;
  selectedModel: string;
  availableModels: string[];
  selectedRuntimeProfile: string;
  runtimeProfiles: RuntimeProfileSummary[];
  referencePlanMode: ReferencePlanMode;
  onModelChange: (value: string) => void;
  onRuntimeProfileChange: (value: string) => void;
  onReferencePlanModeChange: (value: ReferencePlanMode) => void;
  onSend: (text: string) => Promise<void>;
  onCancel: () => Promise<void>;
  messages?: ChatMessage[];
  skills?: SkillSummary[];
  disabledSkillNames: Set<string>;
  activeProjectDir?: string;
  projectContext?: string;
  onQuickLoad?: (payload: QuickLoadPayload) => void;
  onSaveProjectContext?: (value: string) => Promise<string>;
  onConfigureModels: () => void;
  onCreateConversation?: () => void;
  onOpenTerminalConsole?: () => void;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
}) {
  const composerStackRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [activeMenu, setActiveMenu] = useState<ComposerMenu>(null);
  const [commandState, setCommandState] = useState<ComposerCommandState | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  const [imageAttachments, setImageAttachments] = useState<ComposerImageAttachment[]>([]);
  const [previewImage, setPreviewImage] = useState<ImagePreview | null>(null);
  const [popoverMaxHeight, setPopoverMaxHeight] = useState(420);
  const [mentionFileResults, setMentionFileResults] = useState<ProjectFileSearchResult[]>([]);
  const [mentionSearchBusy, setMentionSearchBusy] = useState(false);
  const hasContent = draft.trim().length > 0 || imageAttachments.length > 0;

  const resizeComposerTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) {
      return;
    }
    const computed = window.getComputedStyle(textarea);
    const lineHeight = Number.parseFloat(computed.lineHeight) || 20;
    const minHeight = Math.ceil(lineHeight * 2);
    const maxHeight = Math.min(
      Math.ceil(window.innerHeight * 0.32),
      Math.ceil(lineHeight * 10),
    );
    textarea.style.height = 'auto';
    const nextHeight = Math.max(minHeight, Math.min(textarea.scrollHeight, maxHeight));
    textarea.style.height = `${nextHeight}px`;
    textarea.style.overflowY = textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
  }, []);

  useEffect(() => {
    resizeComposerTextarea();
  }, [compact, draft, imageAttachments.length, resizeComposerTextarea]);

  useEffect(() => {
    const handleResize = () => resizeComposerTextarea();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [resizeComposerTextarea]);

  const updatePopoverMaxHeight = useCallback(() => {
    const host = composerStackRef.current;
    if (!host) {
      return;
    }
    const rect = host.getBoundingClientRect();
    const topInset = 52;
    const gap = 12;
    const availableAbove = Math.max(120, Math.floor(rect.top - topInset - gap));
    setPopoverMaxHeight(Math.min(520, availableAbove));
  }, []);

  useEffect(() => {
    if (!activeMenu && !commandState) {
      return undefined;
    }
    updatePopoverMaxHeight();
    const handleResize = () => updatePopoverMaxHeight();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [
    activeMenu,
    commandState,
    draft,
    imageAttachments.length,
    updatePopoverMaxHeight,
  ]);

  async function submit() {
    if (sending && !hasContent) {
      await onCancel();
      return;
    }
    if (!hasContent) {
      return;
    }
    const imagePaths = imageAttachments.map((item) => `@${item.path}`);
    const value = [...imagePaths, draft.trimEnd()].filter(Boolean).join('\n');
    onDraftChange('');
    setImageAttachments([]);
    await onSend(value);
  }

  function toggleMenu(menu: ComposerMenu) {
    setActiveMenu((current) => (current === menu ? null : menu));
    setCommandState(null);
  }

  function loadPayload(payload: QuickLoadPayload) {
    onQuickLoad?.(payload);
    setActiveMenu(null);
    setCommandState(null);
  }

  useEffect(() => {
    if (!activeMenu) {
      return undefined;
    }
    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (
        target.closest('.composer-popover') ||
        target.closest('[data-composer-menu-trigger="true"]')
      ) {
        return;
      }
      setActiveMenu(null);
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
    };
  }, [activeMenu]);

  useEffect(() => {
    if (!commandState) {
      return undefined;
    }
    function closeCommandOnOutsidePointer(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (composerStackRef.current?.contains(target)) {
        return;
      }
      setCommandState(null);
    }
    document.addEventListener('pointerdown', closeCommandOnOutsidePointer, true);
    return () => {
      document.removeEventListener('pointerdown', closeCommandOnOutsidePointer, true);
    };
  }, [commandState]);

  useEffect(() => {
    if (commandState?.mode !== 'mention') {
      setMentionFileResults([]);
      setMentionSearchBusy(false);
      return undefined;
    }
    const root = activeProjectDir?.trim();
    const searchFiles = window.cardbushDesktop?.searchProjectFiles;
    if (!root || !searchFiles) {
      setMentionFileResults([]);
      setMentionSearchBusy(false);
      return undefined;
    }
    let cancelled = false;
    setMentionSearchBusy(true);
    const timer = window.setTimeout(() => {
      void searchFiles(root, commandState.query)
        .then((results) => {
          if (!cancelled) {
            setMentionFileResults(results);
          }
        })
        .catch(() => {
          if (!cancelled) {
            setMentionFileResults([]);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setMentionSearchBusy(false);
          }
        });
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [activeProjectDir, commandState?.mode, commandState?.query]);

  function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    const raw = event.dataTransfer.getData('application/x-cardbush-quickload');
    if (!raw) {
      return;
    }
    event.preventDefault();
    try {
      loadPayload(JSON.parse(raw) as QuickLoadPayload);
    } catch {
      const text = event.dataTransfer.getData('text/plain');
      if (text.trim()) {
        onDraftChange(draft.trim() ? `${draft.trimEnd()}\n${text}` : text);
      }
    }
  }

  async function pickAttachments() {
    const paths = await window.cardbushDesktop?.pickAttachments?.();
    if (!paths || paths.length === 0) {
      return;
    }
    const imagePaths = paths.filter(isImagePath);
    if (imagePaths.length > 0) {
      setImageAttachments((current) => [
        ...current,
        ...imagePaths.map((pathValue) => imageAttachmentFromPath(pathValue)),
      ]);
    }
    const otherPaths = paths.filter((pathValue) => !isImagePath(pathValue));
    if (otherPaths.length > 0) {
      const next = otherPaths.map((value) => `@${value}`).join('\n');
      onDraftChange(draft.trim() ? `${draft.trimEnd()}\n${next}` : next);
    }
  }

  async function pasteImages(event: React.ClipboardEvent<HTMLDivElement>) {
    const files = [...event.clipboardData.files].filter((file) =>
      file.type.startsWith('image/'),
    );
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    if (!window.cardbushDesktop?.saveImageDataUrl) {
      return;
    }
    try {
      const saved = await Promise.all(
        files.map(async (file) => {
          const dataUrl = await readFileAsDataUrl(file);
          const result = await window.cardbushDesktop!.saveImageDataUrl(
            dataUrl,
            file.name || 'cardbush-paste',
          );
          return {
            id: `image-${crypto.randomUUID()}`,
            path: result.path,
            name: file.name || result.name,
            previewUrl: dataUrl,
          };
        }),
      );
      setImageAttachments((current) => [...current, ...saved]);
    } catch (caught) {
      console.warn(caught);
    }
  }

  function selectModel(model: string) {
    onModelChange(model);
    setActiveMenu(null);
  }

  function selectRuntimeProfile(profileId: string) {
    onRuntimeProfileChange(profileId);
    setActiveMenu(null);
  }

  function focusComposer(nextCaret?: number) {
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus();
      if (nextCaret != null) {
        textareaRef.current?.setSelectionRange(nextCaret, nextCaret);
      }
    });
  }

  function replaceCommandToken(replacement: string) {
    const state = commandState;
    if (!state) {
      return;
    }
    const before = draft.slice(0, state.start);
    const after = draft.slice(state.end);
    const next = `${before}${replacement}${after}`;
    onDraftChange(next);
    setCommandState(null);
    focusComposer(before.length + replacement.length);
  }

  function removeCommandToken() {
    const state = commandState;
    if (!state) {
      return;
    }
    const before = draft.slice(0, state.start);
    const after = draft.slice(state.end);
    const needsTrim = before.endsWith(' ') && after.startsWith(' ');
    const next = `${before}${needsTrim ? after.trimStart() : after}`;
    onDraftChange(next);
    setCommandState(null);
    focusComposer(before.length);
  }

  const slashCommands = useMemo<ComposerCommandItem[]>(
    () => {
      const modelItems: ComposerCommandItem[] = availableModels.map((model) => ({
        id: `/model ${model}`,
        title: `/model ${model}`,
        subtitle:
          language === 'zh'
            ? `切换到 ${model}`
            : `Switch to ${model}`,
        icon: <Bot size={16} />,
        run: () => selectModel(model),
        searchText: `/model ${model} model ${model}`,
      }));
      return [
        {
          id: '/help',
          title: '/help',
          subtitle:
            language === 'zh'
              ? '显示常用指令和 @ 文件引用方式'
              : 'Show common commands and @ file references',
          icon: <Circle size={16} />,
          value:
            language === 'zh'
              ? '请说明 CardBush 当前可用的 / 指令、@ 文件引用方式，以及我可以怎样组合使用它们。'
              : 'Explain the available CardBush / commands, @ file references, and how I can combine them.',
        },
        {
          id: '/clear',
          title: '/clear',
          subtitle:
            language === 'zh'
              ? '清空当前输入框内容'
              : 'Clear the current composer text',
          icon: <X size={16} />,
          run: () => onDraftChange(''),
        },
        {
          id: '/new',
          title: '/new',
          subtitle:
            language === 'zh'
              ? '在当前项目中开始新会话'
              : 'Start a fresh session in the current project',
          icon: <Edit3 size={16} />,
          run: () => onCreateConversation?.(),
        },
        {
          id: '/cd',
          title: '/cd <path>',
          subtitle:
            language === 'zh'
              ? 'CLI 同款：切换项目目录；在 CardBush 中可直接输入路径让助手处理'
              : 'CLI parity: change project directory; enter a path for the assistant',
          icon: <FolderOpen size={16} />,
          value: '/cd ',
        },
        {
          id: '/changedir',
          title: '/changedir <path>',
          subtitle:
            language === 'zh'
              ? 'CLI 同款：/cd 的完整写法'
              : 'CLI parity: long form of /cd',
          icon: <Folder size={16} />,
          value: '/changedir ',
        },
        {
          id: '/model',
          title: '/model',
          subtitle:
            language === 'zh'
              ? '列出或切换已配置模型'
              : 'List or switch configured models',
          icon: <Bot size={16} />,
          run: () => {
            if (availableModels.length === 0) {
              onConfigureModels();
              return;
            }
            setActiveMenu('models');
          },
        },
        ...modelItems,
        {
          id: '/skill',
          title: '/skill',
          subtitle:
            language === 'zh'
              ? '查看或选择当前启用的 skills'
              : 'View or choose currently enabled skills',
          icon: <Puzzle size={16} />,
          run: () => setActiveMenu('skills'),
        },
        {
          id: '/skill-args',
          title: '/skill <all|none|names>',
          subtitle:
            language === 'zh'
              ? 'CLI 同款：设置 skill 白名单；GUI 中请到 Skills 面板开启/关闭'
              : 'CLI parity: set skill whitelist; use the Skills panel in the GUI',
          icon: <Puzzle size={16} />,
          run: () => setActiveMenu('skills'),
        },
        {
          id: '/agents',
          title: '/agents',
          subtitle:
            language === 'zh'
              ? '查看子代理配置和可用场景'
              : 'Review subagent profiles and use cases',
          icon: <Network size={16} />,
          value:
            language === 'zh'
              ? '请帮我查看当前项目适合使用哪些子代理，并说明它们各自的使用场景。'
              : 'Review which subagents fit this project and explain when to use each one.',
        },
        {
          id: '/subagents',
          title: '/subagents',
          subtitle:
            language === 'zh'
              ? 'CLI 同款：管理子代理配置'
              : 'CLI parity: manage subagent profiles',
          icon: <Network size={16} />,
          value:
            language === 'zh'
              ? '请帮我梳理当前可用的子代理配置，并给出推荐的启用策略。'
              : 'Summarize available subagent profiles and recommend an enablement strategy.',
        },
        {
          id: '/subagent',
          title: '/subagent <on|off>',
          subtitle:
            language === 'zh'
              ? 'CLI 同款：切换子代理；GUI 暂以对话方式确认'
              : 'CLI parity: toggle subagents; confirm through chat in the GUI',
          icon: <Network size={16} />,
          value: '/subagent ',
        },
        {
          id: '/git',
          title: '/git',
          subtitle:
            language === 'zh'
              ? '打开 Git 分支列表'
              : 'Open Git branch list',
          icon: <GitBranch size={16} />,
          run: () => setActiveMenu('git'),
        },
        {
          id: '/attach',
          title: '/attach',
          subtitle:
            language === 'zh'
              ? '选择图片或文件插入输入框'
              : 'Pick images or files for this message',
          icon: <Paperclip size={16} />,
          run: () => void pickAttachments(),
        },
        {
          id: '/terminal',
          title: '/terminal',
          subtitle:
            language === 'zh'
              ? '打开当前项目终端'
              : 'Open the project terminal',
          icon: <Terminal size={16} />,
          run: () => onOpenTerminalConsole?.(),
        },
      ];
    },
    [
      availableModels,
      language,
      onConfigureModels,
      onCreateConversation,
      onDraftChange,
      onOpenTerminalConsole,
      selectModel,
    ],
  );

  const mentionCommands = useMemo<ComposerCommandItem[]>(
    () => {
      const root = activeProjectDir?.trim();
      if (!root) {
        return [
          {
            id: 'no-project',
            title: language === 'zh' ? '当前没有项目目录' : 'No project directory',
            subtitle:
              language === 'zh'
                ? '@ 只提示当前项目下的文件路径'
                : '@ only suggests files from the current project',
            icon: <FolderOpen size={16} />,
            run: () => undefined,
          },
        ];
      }
      return mentionFileResults.map((item) => {
        const relativePath = item.relativePath || item.name;
        const kindLabel =
          item.kind === 'folder'
            ? language === 'zh'
              ? '文件夹'
              : 'Folder'
            : language === 'zh'
              ? '文件'
              : 'File';
        return {
          id: item.path,
          title: `@${relativePath}`,
          subtitle: `${kindLabel} · ${compactPath(item.path)}`,
          icon: item.kind === 'folder' ? <Folder size={16} /> : <Code2 size={16} />,
          value: `@${item.path} `,
          searchText: `${relativePath} ${item.path} ${item.name}`,
        };
      });
    },
    [activeProjectDir, language, mentionFileResults],
  );

  const commandItems = useMemo(() => {
    if (!commandState) {
      return [];
    }
    const source = commandState.mode === 'slash' ? slashCommands : mentionCommands;
    return rankComposerCommandItems(source, commandState.query, commandState.mode)
      .slice(0, commandState.mode === 'slash' ? 12 : 10);
  }, [commandState, mentionCommands, slashCommands]);

  useEffect(() => {
    setCommandIndex(0);
  }, [commandState?.mode, commandState?.query]);

  useEffect(() => {
    setCommandIndex((current) =>
      Math.min(current, Math.max(commandItems.length - 1, 0)),
    );
  }, [commandItems.length]);

  function applyCommand(item: ComposerCommandItem) {
    if (commandState?.mode === 'mention') {
      if (item.run) {
        removeCommandToken();
        void item.run();
        return;
      }
      replaceCommandToken(item.value ?? `${item.title} `);
      return;
    }
    if (item.run) {
      removeCommandToken();
      void item.run();
      return;
    }
    replaceCommandToken(item.value ?? `${item.title} `);
  }

  function updateCommandFromTextarea(value: string, caret: number | null) {
    const next = detectComposerCommand(value, caret ?? value.length);
    setCommandState(next);
  }

  const hasConfiguredModels = availableModels.length > 0;
  const modelLabel =
    selectedModel.trim() ||
    (language === 'zh' ? '待配置' : 'Configure');
  const runtimeProfileLabel = runtimeProfileDisplayName(
    selectedRuntimeProfile,
    runtimeProfiles,
    language,
  );
  const referencePlanEnabled = referencePlanMode === 'auto';
  const referencePlanLabel =
    language === 'zh' ? '复杂任务计划书' : 'Reference plan';
  const referencePlanDescription =
    language === 'zh'
      ? '开启后，复杂任务会让模型判断是否先生成 PLAN.md；可能增加一点耗时。'
      : 'When enabled, complex tasks let the model decide whether to generate PLAN.md first; this may take a little longer.';
  const queueLabel =
    queuedMessageCount > 0
      ? language === 'zh'
        ? `已排队 ${queuedMessageCount} 条，当前回复完成后自动发送`
        : `${queuedMessageCount} queued, sending after this reply`
      : '';
  const queueTitle = queuedMessagePreview.trim()
    ? `${queueLabel}\n${queuedMessagePreview.trim()}`
    : queueLabel;

  return (
    <div
      className={`composer-stack ${compact ? 'compact' : ''}`}
      ref={composerStackRef}
      style={
        {
          '--composer-popover-max-height': `${popoverMaxHeight}px`,
        } as CSSProperties
      }
    >
      {commandState && (
        <ComposerCommandPalette
          language={language}
          mode={commandState.mode}
          query={commandState.query}
          items={commandItems}
          busy={commandState.mode === 'mention' && mentionSearchBusy}
          selectedIndex={commandIndex}
          onSelect={(item) => applyCommand(item)}
        />
      )}
      {activeMenu && (
        <ComposerPopover
          menu={activeMenu}
          language={language}
          messages={messages}
          skills={skills}
          disabledSkillNames={disabledSkillNames}
          selectedModel={selectedModel}
          availableModels={availableModels}
          selectedRuntimeProfile={selectedRuntimeProfile}
          runtimeProfiles={runtimeProfiles}
          activeProjectDir={activeProjectDir}
          projectContext={projectContext}
          onLoad={loadPayload}
          onToggleSkill={onToggleSkill}
          onSaveProjectContext={onSaveProjectContext}
          onSelectModel={selectModel}
          onSelectRuntimeProfile={selectRuntimeProfile}
          onConfigureModels={onConfigureModels}
          onClose={() => setActiveMenu(null)}
        />
      )}
      {previewImage && (
        <ImagePreviewDialog
          image={previewImage}
          onClose={() => setPreviewImage(null)}
        />
      )}
      <div
        className="composer-surface"
        onPointerDown={(event) => {
          const target = event.target;
          if (
            target instanceof Element &&
            target.closest('button, input, select, textarea, [role="button"]')
          ) {
            return;
          }
          textareaRef.current?.focus();
        }}
        onPaste={(event) => void pasteImages(event)}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes('application/x-cardbush-quickload')) {
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }
        }}
        onDrop={handleDrop}
      >
        {imageAttachments.length > 0 && (
          <div className="composer-image-strip">
            {imageAttachments.map((image) => (
              <figure className="composer-image-thumb" key={image.id}>
                <button
                  className="composer-image-preview"
                  type="button"
                  title={language === 'zh' ? '放大查看图片' : 'Preview image'}
                  onClick={() =>
                    setPreviewImage({
                      src: image.previewUrl,
                      name: image.name,
                      path: image.path,
                    })
                  }
                >
                  <img src={image.previewUrl} alt={image.name} />
                </button>
                <button
                  className="composer-image-remove"
                  type="button"
                  title={language === 'zh' ? '移除图片' : 'Remove image'}
                  onClick={() =>
                    setImageAttachments((current) =>
                      current.filter((item) => item.id !== image.id),
                    )
                  }
                >
                  <X size={13} />
                </button>
              </figure>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(event) => {
            const next = event.target.value;
            onDraftChange(next);
            updateCommandFromTextarea(next, event.currentTarget.selectionStart);
          }}
          onClick={(event) =>
            updateCommandFromTextarea(draft, event.currentTarget.selectionStart)
          }
          onKeyUp={(event) =>
            updateCommandFromTextarea(draft, event.currentTarget.selectionStart)
          }
          onKeyDown={(event) => {
            if (commandState) {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                setCommandIndex((current) => {
                  const count = Math.max(commandItems.length, 1);
                  return event.key === 'ArrowDown'
                    ? (current + 1) % count
                    : (current - 1 + count) % count;
                });
                return;
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setCommandState(null);
                return;
              }
              if (
                (event.key === 'Enter' || event.key === 'Tab') &&
                commandItems.length > 0
              ) {
                event.preventDefault();
                applyCommand(commandItems[Math.min(commandIndex, commandItems.length - 1)]);
                return;
              }
            }
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={
            language === 'zh'
              ? compact
                ? '问 cardbush 任何事。输入 @ 引用项目文件'
                : '给 cardbush 发消息…'
              : compact
                ? 'Ask cardbush anything. Type @ to reference project files'
                : 'Message cardbush...'
          }
          rows={2}
        />
        {queueLabel && (
          <div className="composer-queue-note" title={queueTitle}>
            <Clock3 size={13} />
            <span>{queueLabel}</span>
          </div>
        )}
        <div className="composer-footer">
          <div className="composer-tools">
            <ToolChip
              icon={<FolderOpen size={15} />}
              label={language === 'zh' ? '项目上下文' : 'Project'}
              active={activeMenu === 'project'}
              menuTrigger
              onClick={() => toggleMenu('project')}
            />
            <ToolChip
              icon={<Circle size={15} />}
              label="Tokens"
              active={activeMenu === 'tokens'}
              menuTrigger
              onClick={() => toggleMenu('tokens')}
            />
            <ToolChip
              icon={<GitBranch size={15} />}
              label={language === 'zh' ? 'Git 分支' : 'Git'}
              active={activeMenu === 'git'}
              menuTrigger
              onClick={() => toggleMenu('git')}
            />
            <ToolChip
              icon={<Paperclip size={15} />}
              label={language === 'zh' ? '附件' : 'Attach'}
              onClick={() => void pickAttachments()}
            />
            <ToolChip
              icon={<Puzzle size={15} />}
              label="Skills"
              active={activeMenu === 'skills'}
              menuTrigger
              onClick={() => toggleMenu('skills')}
            />
            <button
              className={`reference-plan-toggle ${referencePlanEnabled ? 'active' : ''}`}
              type="button"
              title={referencePlanDescription}
              aria-pressed={referencePlanEnabled}
              onClick={() => {
                setActiveMenu(null);
                setCommandState(null);
                onReferencePlanModeChange(referencePlanEnabled ? 'off' : 'auto');
              }}
            >
              {referencePlanEnabled ? <CheckCircle2 size={14} /> : <Circle size={14} />}
              <span>{referencePlanLabel}</span>
            </button>
          </div>
          <div className="composer-actions">
            <button
              className="model-select runtime-profile-select"
              type="button"
              data-composer-menu-trigger="true"
              title={
                language === 'zh'
                  ? `运行模式：${runtimeProfileLabel}`
                  : `Runtime: ${runtimeProfileLabel}`
              }
              onClick={() => toggleMenu('runtime')}
            >
              <Cpu size={14} />
              <span>{runtimeProfileLabel}</span>
              <ChevronDown size={15} />
            </button>
            <button
              className="model-select"
              type="button"
              data-composer-menu-trigger="true"
              title={
                language === 'zh'
                  ? `模型：${modelLabel}`
                  : `Model: ${modelLabel}`
              }
              onClick={() => {
                if (!hasConfiguredModels) {
                  onConfigureModels();
                  return;
                }
                toggleMenu('models');
              }}
            >
              <span>{modelLabel}</span>
              <ChevronDown size={15} />
            </button>
            <button
              className="tool-chip terminal-chip"
              type="button"
              title={language === 'zh' ? '终端控制台' : 'Terminal console'}
              onClick={() => onOpenTerminalConsole?.()}
            >
              <Terminal size={15} />
            </button>
            <button
              className={`send-button ${sending && hasContent ? 'queue' : ''}`}
              type="button"
              title={
                sending && hasContent
                  ? language === 'zh'
                    ? '加入发送队列'
                    : 'Queue message'
                  : undefined
              }
              onClick={() => void submit()}
            >
              {sending && !hasContent ? <Pause size={17} /> : <ArrowUp size={18} />}
            </button>
          </div>
        </div>
      </div>
      {!compact && (
        <div className="composer-note">
          {language === 'zh'
            ? 'cardbush 可能出错，请核实重要信息'
            : 'cardbush can make mistakes. Check important information.'}
        </div>
      )}
    </div>
  );
}

function ComposerCommandPalette({
  language,
  mode,
  query,
  items,
  busy,
  selectedIndex,
  onSelect,
}: {
  language: AppLanguage;
  mode: ComposerCommandMode;
  query: string;
  items: ComposerCommandItem[];
  busy?: boolean;
  selectedIndex: number;
  onSelect: (item: ComposerCommandItem) => void;
}) {
  const rowRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const emptyLabel =
    mode === 'mention'
      ? language === 'zh'
        ? busy
          ? '正在搜索项目文件...'
          : '没有匹配的项目文件'
        : busy
          ? 'Searching project files...'
          : 'No matching project files'
      : language === 'zh'
        ? '没有匹配的指令'
        : 'No matching commands';
  useEffect(() => {
    const row = rowRefs.current[Math.max(0, selectedIndex)];
    row?.scrollIntoView({ block: 'nearest' });
  }, [items.length, selectedIndex]);
  return (
    <div className="composer-command-palette">
      <header>
        <strong>{mode === 'mention' ? '@' : '/'} {query}</strong>
        <span>
          {mode === 'mention'
            ? language === 'zh'
              ? '项目文件'
              : 'Project files'
            : language === 'zh'
              ? '指令'
              : 'Command'}
        </span>
      </header>
      <div className="composer-command-list">
        {items.length === 0 ? (
          <div className="composer-command-empty">{emptyLabel}</div>
        ) : (
          items.map((item, index) => (
            <button
              className={`composer-command-row ${
                index === selectedIndex ? 'active' : ''
              }`}
              type="button"
              key={item.id}
              ref={(element) => {
                rowRefs.current[index] = element;
              }}
              onMouseDown={(event) => {
                event.preventDefault();
                onSelect(item);
              }}
            >
              {item.icon}
              <span>
                <strong>{item.title}</strong>
                <small>{item.subtitle}</small>
              </span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function rankComposerCommandItems(
  items: ComposerCommandItem[],
  rawQuery: string,
  mode: ComposerCommandMode,
) {
  const query = normalizeCommandQuery(rawQuery);
  if (!query) {
    return items;
  }
  if (mode === 'mention') {
    return items.filter((item) =>
      normalizeFileQuery(item.searchText ?? `${item.id} ${item.title} ${item.subtitle}`)
        .includes(normalizeFileQuery(rawQuery)),
    );
  }
  return items
    .map((item) => ({
      item,
      score: scoreSlashCommand(item, query),
    }))
    .filter((entry): entry is { item: ComposerCommandItem; score: [number, number, number] } =>
      entry.score != null,
    )
    .sort((left, right) =>
      left.score[0] - right.score[0] ||
      left.score[1] - right.score[1] ||
      left.score[2] - right.score[2],
    )
    .map((entry) => entry.item);
}

function scoreSlashCommand(
  item: ComposerCommandItem,
  query: string,
): [number, number, number] | null {
  const source = item.searchText ?? `${item.id} ${item.title} ${item.subtitle}`;
  const commandName = normalizeCommandQuery(item.title.replace(/^\/+/, ''));
  const compactSource = normalizeCommandQuery(source);
  if (!query) {
    return [0, 0, commandName.length];
  }
  if (commandName.startsWith(query)) {
    return [0, 0, commandName.length];
  }
  const directIndex = compactSource.indexOf(query);
  if (directIndex >= 0) {
    return [1, directIndex, commandName.length];
  }
  const positions: number[] = [];
  let searchFrom = 0;
  for (const char of query) {
    const foundAt = compactSource.indexOf(char, searchFrom);
    if (foundAt < 0) {
      return null;
    }
    positions.push(foundAt);
    searchFrom = foundAt + 1;
  }
  return [2, positions[positions.length - 1] - positions[0], commandName.length];
}

function normalizeCommandQuery(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, '');
}

function normalizeFileQuery(value: string) {
  return value.toLowerCase().replaceAll('\\', '/').trim();
}

function detectComposerCommand(
  value: string,
  caret: number,
): ComposerCommandState | null {
  const safeCaret = Math.max(0, Math.min(value.length, caret));
  const beforeCaret = value.slice(0, safeCaret);
  const lineStart = Math.max(beforeCaret.lastIndexOf('\n') + 1, 0);
  const linePrefix = beforeCaret.slice(lineStart);
  if (/^\/[^\s/]*$/.test(linePrefix)) {
    return {
      mode: 'slash',
      start: lineStart,
      end: safeCaret,
      query: linePrefix.slice(1),
    };
  }
  const mentionMatch = beforeCaret.match(/(^|\s)@([^\s@]*)$/);
  if (!mentionMatch || mentionMatch.index == null) {
    return null;
  }
  const prefix = mentionMatch[1] ?? '';
  const start = mentionMatch.index + prefix.length;
  return {
    mode: 'mention',
    start,
    end: safeCaret,
    query: mentionMatch[2] ?? '',
  };
}

function ComposerPopover({
  menu,
  language,
  messages,
  skills,
  disabledSkillNames,
  selectedModel,
  availableModels,
  selectedRuntimeProfile,
  runtimeProfiles,
  activeProjectDir,
  projectContext,
  onLoad,
  onToggleSkill,
  onSaveProjectContext,
  onSelectModel,
  onSelectRuntimeProfile,
  onConfigureModels,
  onClose,
}: {
  menu: Exclude<ComposerMenu, null>;
  language: AppLanguage;
  messages: ChatMessage[];
  skills: SkillSummary[];
  disabledSkillNames: Set<string>;
  selectedModel: string;
  availableModels: string[];
  selectedRuntimeProfile: string;
  runtimeProfiles: RuntimeProfileSummary[];
  activeProjectDir?: string;
  projectContext: string;
  onLoad: (payload: QuickLoadPayload) => void;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  onSaveProjectContext?: (value: string) => Promise<string>;
  onSelectModel: (model: string) => void;
  onSelectRuntimeProfile: (profileId: string) => void;
  onConfigureModels: () => void;
  onClose: () => void;
}) {
  const content = messages.map((message) => message.content).join('\n');
  const chars = content.length;
  const estimatedTokens = Math.ceil(chars / 4);
  const models = Array.from(new Set([selectedModel, ...availableModels].filter(Boolean)));
  const profiles = normalizeRuntimeProfiles(runtimeProfiles, selectedRuntimeProfile);
  const pickerMenu = menu === 'models';

  return (
    <div className={`composer-popover ${menu} ${pickerMenu ? 'picker' : ''}`}>
      {!pickerMenu && (
        <header>
          <strong>{composerMenuTitle(menu, language)}</strong>
          <button type="button" onClick={onClose} aria-label="close popover">
            <X size={15} />
          </button>
        </header>
      )}
      {menu === 'project' && (
        <ProjectContextEditor
          language={language}
          activeProjectDir={activeProjectDir}
          value={projectContext}
          onSave={onSaveProjectContext}
        />
      )}
      {menu === 'tokens' && (
        <div className="token-grid">
          <TokenStat label={language === 'zh' ? '消息数' : 'Messages'} value={messages.length} />
          <TokenStat label={language === 'zh' ? '字符数' : 'Characters'} value={chars} />
          <TokenStat label="Tokens" value={estimatedTokens} />
        </div>
      )}
      {menu === 'git' && (
        <GitBranchMenu language={language} activeProjectDir={activeProjectDir} />
      )}
      {menu === 'skills' && (
        <div className="popover-list skill-popover-list">
          {skills.length === 0 ? (
            <p className="composer-popover-empty">
              {language === 'zh' ? '暂无可用 skill' : 'No skills available'}
            </p>
          ) : (
            skills.map((skill) => {
              const enabled = !disabledSkillNames.has(skill.name);
              return (
                <div
                  className={`skill-popover-row ${enabled ? '' : 'disabled'}`}
                  key={skill.name}
                >
                  <button
                    className="skill-popover-main"
                    type="button"
                    onClick={() =>
                      onLoad({
                        kind: 'text',
                        title: skill.name,
                        value: `@${skill.name}`,
                      })
                    }
                  >
                    <Puzzle size={16} />
                    <span>
                      <strong>{skill.name}</strong>
                      <small>
                        {language === 'zh' ? skill.descriptionZh : skill.description}
                      </small>
                    </span>
                  </button>
                  <button
                    className={`skill-popover-toggle ${enabled ? 'on' : ''}`}
                    type="button"
                    title={
                      enabled
                        ? language === 'zh'
                          ? '禁用这个 skill'
                          : 'Disable this skill'
                        : language === 'zh'
                          ? '启用这个 skill'
                          : 'Enable this skill'
                    }
                    onClick={() => onToggleSkill(skill.name, !enabled)}
                  >
                    {enabled ? <CheckCircle2 size={14} /> : <Circle size={14} />}
                    <span>
                      {enabled
                        ? language === 'zh'
                          ? '开'
                          : 'On'
                        : language === 'zh'
                          ? '关'
                          : 'Off'}
                    </span>
                  </button>
                </div>
              );
            })
          )}
        </div>
      )}
      {menu === 'models' && (
        <div className="model-picker-menu">
          <div className="model-picker-section-label">
            {language === 'zh' ? '模型' : 'Model'}
          </div>
          {models.length === 0 ? (
            <button
              className="model-picker-row primary"
              type="button"
              onClick={onConfigureModels}
            >
              <span>{language === 'zh' ? '待配置，前往模型设置' : 'Configure models'}</span>
              <ArrowRight size={15} />
            </button>
          ) : (
            models.map((model) => (
              <button
                className={`model-picker-row ${model === selectedModel ? 'active' : ''}`}
                type="button"
                key={model}
                onClick={() => onSelectModel(model)}
              >
                <span>{model}</span>
                {model === selectedModel && <Check size={16} />}
              </button>
            ))
          )}
          <div className="model-picker-divider" />
          <button
            className="model-picker-row secondary"
            type="button"
            onClick={onConfigureModels}
          >
            <span>{language === 'zh' ? '管理模型' : 'Manage models'}</span>
            <ArrowRight size={15} />
          </button>
        </div>
      )}
      {menu === 'runtime' && (
        <div className="popover-list runtime-profile-list">
          {profiles.map((profile) => (
            <button
              className={`popover-row runtime-profile-row ${
                profile.id === selectedRuntimeProfile ? 'active' : ''
              }`}
              type="button"
              key={profile.id}
              onClick={() => onSelectRuntimeProfile(profile.id)}
            >
              <Cpu size={16} />
              <span>
                <strong>{runtimeProfileDisplayName(profile.id, profiles, language)}</strong>
                <small>{runtimeProfileDescription(profile, language)}</small>
                <small>{runtimeProfileMetaLine(profile, language)}</small>
              </span>
              {profile.id === selectedRuntimeProfile && <Check size={15} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function composerMenuTitle(menu: Exclude<ComposerMenu, null>, language: AppLanguage) {
  const labels: Record<Exclude<ComposerMenu, null>, { zh: string; en: string }> = {
    project: { zh: '项目上下文', en: 'Project context' },
    tokens: { zh: 'Token 用量', en: 'Token usage' },
    git: { zh: 'Git 分支', en: 'Git branches' },
    skills: { zh: 'Skills', en: 'Skills' },
    runtime: { zh: '运行模式', en: 'Runtime' },
    models: { zh: '模型', en: 'Model' },
  };
  return labels[menu][language];
}

function normalizeRuntimeProfiles(
  profiles: RuntimeProfileSummary[],
  selectedRuntimeProfile: string,
) {
  const merged = new Map<string, RuntimeProfileSummary>();
  for (const profile of [
    {
      id: 'general',
      label: 'General',
      description: 'General purpose assistant.',
      phases: [],
      allowedLanes: [],
      raw: { id: 'general' },
    },
    {
      id: 'code',
      label: 'Code',
      description: 'Programming workflow: inspect, edit, verify, final.',
      phases: ['inspect', 'edit', 'verify', 'final'],
      allowedLanes: ['code'],
      raw: { id: 'code' },
    },
    {
      id: 'code-review',
      label: 'Code Review',
      description: 'Read-only review focused on findings and risks.',
      phases: ['inspect', 'review', 'final'],
      allowedLanes: ['review'],
      raw: { id: 'code-review' },
    },
    {
      id: 'research',
      label: 'Research',
      description: 'Evidence-first research workflow.',
      phases: ['collect', 'compare', 'synthesize', 'final'],
      allowedLanes: ['research'],
      raw: { id: 'research' },
    },
    ...profiles,
  ]) {
    if (profile.id.trim()) {
      merged.set(profile.id, profile);
    }
  }
  if (selectedRuntimeProfile.trim() && !merged.has(selectedRuntimeProfile)) {
    merged.set(selectedRuntimeProfile, {
      id: selectedRuntimeProfile,
      label: selectedRuntimeProfile,
      description: '',
      phases: [],
      allowedLanes: [],
      raw: { id: selectedRuntimeProfile },
    });
  }
  return [...merged.values()];
}

function runtimeProfileDisplayName(
  profileId: string,
  profiles: RuntimeProfileSummary[],
  language: AppLanguage,
) {
  const normalized = profileId.trim() || 'general';
  if (language === 'zh') {
    const zhLabels: Record<string, string> = {
      general: '通用',
      code: '编程',
      'code-review': '审查',
      research: '研究',
    };
    if (zhLabels[normalized]) {
      return zhLabels[normalized];
    }
  }
  const profile = profiles.find((item) => item.id === normalized);
  return profile?.label?.trim() || normalized;
}

function runtimeProfileDescription(
  profile: RuntimeProfileSummary,
  language: AppLanguage,
) {
  if (language === 'zh') {
    const zhDescriptions: Record<string, string> = {
      general: '普通通用会话，适合问答、计划和轻量任务',
      code: '编程模式，按 inspect / edit / verify / final 推进',
      'code-review': '只读审查模式，优先输出问题、风险和测试缺口',
      research: '证据优先研究模式，强调来源、对照和结论',
    };
    if (zhDescriptions[profile.id]) {
      return zhDescriptions[profile.id];
    }
  }
  if (profile.description.trim()) {
    return profile.description;
  }
  if (profile.phases.length > 0) {
    return profile.phases.join(' / ');
  }
  return profile.defaultLane || profile.id;
}

function runtimeProfileMetaLine(profile: RuntimeProfileSummary, language: AppLanguage) {
  const segments = [
    profile.hookSet
      ? language === 'zh'
        ? `Hook: ${profile.hookSet}`
        : `Hook: ${profile.hookSet}`
      : '',
    profile.phases.length > 0
      ? language === 'zh'
        ? `流程: ${profile.phases.join(' / ')}`
        : `Flow: ${profile.phases.join(' / ')}`
      : '',
    profile.verificationPolicy
      ? language === 'zh'
        ? '含验证策略'
        : 'verification policy'
      : '',
  ].filter(Boolean);
  return segments.join(' · ') || (language === 'zh' ? '默认运行约束' : 'Default runtime constraints');
}

function GitBranchMenu({
  language,
  activeProjectDir,
}: {
  language: AppLanguage;
  activeProjectDir?: string;
}) {
  const [branches, setBranches] = useState<string[]>([]);
  const [currentBranch, setCurrentBranch] = useState('');
  const [newBranch, setNewBranch] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');

  const reload = useCallback(async () => {
    const root = activeProjectDir?.trim();
    if (!root || !window.cardbushDesktop?.gitInfo) {
      setBranches([]);
      setCurrentBranch('');
      setStatus(language === 'zh' ? '请先打开一个 Git 项目' : 'Open a Git project first');
      return;
    }
    setLoading(true);
    setStatus('');
    try {
      const [info, loadedBranches] = await Promise.all([
        window.cardbushDesktop.gitInfo(root),
        window.cardbushDesktop.gitBranches?.(root) ?? Promise.resolve([]),
      ]);
      setCurrentBranch(info.branch);
      setBranches(loadedBranches);
      if (info.error || info.missing) {
        setStatus(info.error || (language === 'zh' ? '不是 Git 项目' : 'Not a Git project'));
      }
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [activeProjectDir, language]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const switchBranch = useCallback(
    async (branch: string) => {
      const root = activeProjectDir?.trim();
      if (!root || !branch.trim()) {
        return;
      }
      setLoading(true);
      setStatus('');
      try {
        const result = await window.cardbushDesktop!.gitCheckout(root, branch);
        setCurrentBranch(result.branch || branch);
        setStatus(result.output || (language === 'zh' ? '已切换分支' : 'Branch switched'));
        void reload();
      } catch (caught) {
        setStatus(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setLoading(false);
      }
    },
    [activeProjectDir, language, reload],
  );

  const createBranch = useCallback(async () => {
    const root = activeProjectDir?.trim();
    const branch = newBranch.trim();
    if (!root || !branch) {
      setStatus(language === 'zh' ? '请输入新分支名称' : 'Enter a new branch name');
      return;
    }
    setLoading(true);
    setStatus('');
    try {
      const result = await window.cardbushDesktop!.gitCreateBranch(root, branch);
      setCurrentBranch(result.branch || branch);
      setNewBranch('');
      setStatus(result.output || (language === 'zh' ? '已创建并切换分支' : 'Branch created'));
      void reload();
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [activeProjectDir, language, newBranch, reload]);

  return (
    <div className="popover-stack git-branch-menu">
      <p>
        {activeProjectDir?.trim()
          ? activeProjectDir
          : language === 'zh'
            ? '请先打开一个 Git 项目'
            : 'Open a Git project first'}
      </p>
      <div className="branch-create-row">
        <input
          value={newBranch}
          disabled={loading || !activeProjectDir}
          onChange={(event) => setNewBranch(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void createBranch();
            }
          }}
          placeholder={language === 'zh' ? '新分支名称' : 'New branch name'}
        />
        <button type="button" disabled={loading || !newBranch.trim()} onClick={() => void createBranch()}>
          <Plus size={14} />
          {language === 'zh' ? '创建' : 'Create'}
        </button>
      </div>
      <div className="branch-list">
        {branches.length === 0 && (
          <span className="popover-status">
            {loading
              ? language === 'zh'
                ? '正在加载分支...'
                : 'Loading branches...'
              : language === 'zh'
                ? '暂无分支列表'
                : 'No branches found'}
          </span>
        )}
        {branches.map((branch) => (
          <button
            className={`popover-row ${branch === currentBranch ? 'active' : ''}`}
            type="button"
            key={branch}
            disabled={loading || branch === currentBranch}
            onClick={() => void switchBranch(branch)}
          >
            <GitBranch size={16} />
            <span>
              <strong>{branch}</strong>
              <small>
                {branch === currentBranch
                  ? language === 'zh'
                    ? '当前分支'
                    : 'Current branch'
                  : language === 'zh'
                    ? '切换到此分支'
                    : 'Switch to this branch'}
              </small>
            </span>
          </button>
        ))}
      </div>
      {status && <p className="popover-status">{status}</p>}
    </div>
  );
}

function ProjectContextEditor({
  language,
  activeProjectDir,
  value,
  onSave,
}: {
  language: AppLanguage;
  activeProjectDir?: string;
  value: string;
  onSave?: (value: string) => Promise<string>;
}) {
  const [draft, setDraft] = useState(value);
  const [status, setStatus] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDraft(value);
    setStatus('');
  }, [value, activeProjectDir]);

  const save = useCallback(
    async (nextValue: string) => {
      if (!activeProjectDir || !onSave) {
        setStatus(
          language === 'zh'
            ? '请先从左侧打开项目'
            : 'Open a project from the sidebar first',
        );
        return;
      }
      setSaving(true);
      setStatus('');
      try {
        const saved = await onSave(nextValue);
        setDraft(saved);
        setStatus(
          saved.trim()
            ? language === 'zh'
              ? '已保存为项目系统提示词'
              : 'Saved as project system prompt'
            : language === 'zh'
              ? '已清空项目上下文'
              : 'Project context cleared',
        );
      } catch (caught) {
        setStatus(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setSaving(false);
      }
    },
    [activeProjectDir, language, onSave],
  );

  return (
    <div className="popover-stack project-context-editor">
      <p>
        {activeProjectDir
          ? activeProjectDir
          : language === 'zh'
            ? '请先从左侧打开项目'
            : 'Open a project from the sidebar first'}
      </p>
      <textarea
        value={draft}
        disabled={!activeProjectDir || saving}
        onChange={(event) => setDraft(event.currentTarget.value)}
        placeholder={
          language === 'zh'
            ? '写给当前项目的长期提示词，例如代码风格、约束、偏好或特殊上下文。发送时会作为项目上下文进入系统提示词，不会插入输入框。'
            : 'Write persistent instructions for this project. They are sent as project context for the system prompt, not inserted into the composer.'
        }
      />
      <div className="popover-actions">
        <button type="button" onClick={() => void save('')} disabled={saving || !activeProjectDir}>
          {language === 'zh' ? '清空' : 'Clear'}
        </button>
        <button
          className="primary-button"
          type="button"
          onClick={() => void save(draft)}
          disabled={saving || !activeProjectDir}
        >
          {saving ? <LoaderCircle size={14} /> : <CheckCircle2 size={14} />}
          {language === 'zh' ? '保存' : 'Save'}
        </button>
      </div>
      {status && <p className="popover-status">{status}</p>}
    </div>
  );
}

function TokenStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="token-stat">
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  );
}

function ToolChip({
  icon,
  label,
  active,
  menuTrigger,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  menuTrigger?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      className={`tool-chip ${active ? 'active' : ''}`}
      type="button"
      title={label}
      data-composer-menu-trigger={menuTrigger ? 'true' : undefined}
      onClick={onClick}
    >
      {icon}
    </button>
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
}) {
  const label = sectionLabels[section][language];
  return (
    <div className="feature-panel">
      <TopBar
        title={label}
        sidebarCollapsed={sidebarCollapsed}
        botShareLabel={language === 'zh' ? '继续到 Bot' : 'Continue to Bot'}
        language={language}
        activeConsole={null}
        onToggleGit={() => undefined}
        onToggleTerminal={() => undefined}
        onRevealSidebar={onRevealSidebar}
      />
      {section === 'search' && (
        <SearchPanel language={language} conversations={conversations} />
      )}
      {section === 'skills' && (
        <SkillsPanel
          language={language}
          items={skills}
          disabledSkillNames={disabledSkillNames}
          onToggleSkill={onToggleSkill}
          onReload={onReloadSkills}
          onLoadDetail={onLoadSkillDetail}
        />
      )}
      {section === 'subagents' && (
        <SubagentsPanel language={language} />
      )}
      {section === 'gamecoding' && (
        <GameCodingPanel language={language} />
      )}
    </div>
  );
}

function SearchPanel({
  language,
  conversations,
}: {
  language: AppLanguage;
  conversations: ConversationSummary[];
}) {
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLowerCase();
  const results = useMemo(
    () =>
      conversations.filter((conversation) => {
        if (!normalizedQuery) {
          return true;
        }
        return `${conversation.title} ${conversation.preview}`
          .toLowerCase()
          .includes(normalizedQuery);
      }),
    [conversations, normalizedQuery],
  );

  return (
    <div className="feature-content">
      <div className="feature-toolbar">
        <div className="search-box">
          <Search size={18} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={language === 'zh' ? '搜索标题或摘要' : 'Search titles or summaries'}
          />
        </div>
        <button className="primary-button" type="button">
          <Edit3 size={16} />
          {language === 'zh' ? '新会话' : 'New chat'}
        </button>
      </div>
      <div className="result-stack">
        {results.map((conversation) => (
          <article className="result-card" key={conversation.id}>
            <h3>{conversation.title}</h3>
            <p>{conversation.preview}</p>
          </article>
        ))}
      </div>
    </div>
  );
}

function SkillsPanel({
  language,
  items,
  disabledSkillNames,
  onToggleSkill,
  onReload,
  onLoadDetail,
}: {
  language: AppLanguage;
  items: SkillSummary[];
  disabledSkillNames: Set<string>;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  onReload: () => Promise<SkillSummary[]>;
  onLoadDetail: (skillName: string) => Promise<SkillDetail>;
}) {
  const [query, setQuery] = useState('');
  const [localItems, setLocalItems] = useState(items);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<SkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');

  useEffect(() => {
    setLocalItems(items);
  }, [items]);

  const normalizedQuery = query.trim().toLowerCase();
  const results = useMemo(
    () =>
      localItems
        .filter((skill) => {
          if (!normalizedQuery) {
            return true;
          }
          return `${skill.name} ${skill.description} ${skill.descriptionZh ?? ''} ${skill.path}`
            .toLowerCase()
            .includes(normalizedQuery);
        })
        .sort((left, right) => left.name.localeCompare(right.name)),
    [localItems, normalizedQuery],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const loaded = await onReload();
      setLocalItems(loaded);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [onReload]);

  const openDetail = useCallback(
    async (skill: SkillSummary) => {
      setDetail(null);
      setDetailError('');
      setDetailLoading(true);
      try {
        const loaded = await onLoadDetail(skill.name);
        setDetail(loaded);
      } catch (caught) {
        setDetailError(caught instanceof Error ? caught.message : String(caught));
        setDetail({
          ...skill,
          packageDir: '',
          content: '',
          routingHidden: false,
          requires: [],
          conflictsWith: [],
          companionTools: [],
          blockedTools: [],
          requiredReads: [],
          conditionalReads: [],
          resourceQuickRefs: [],
        });
      } finally {
        setDetailLoading(false);
      }
    },
    [onLoadDetail],
  );

  return (
    <div className="feature-content">
      <div className="feature-toolbar">
        <div className="search-box">
          <Search size={18} />
          <input
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder={language === 'zh' ? '搜索技能' : 'Search skills'}
          />
        </div>
        <button className="secondary-button" type="button" disabled={loading} onClick={() => void reload()}>
          {loading ? <LoaderCircle size={14} /> : <RefreshCw size={14} />}
          {language === 'zh' ? '刷新' : 'Refresh'}
        </button>
      </div>
      <p className="feature-hint">
        {loading
          ? language === 'zh'
            ? '正在从 BushServer 加载 skills...'
            : 'Loading skills from BushServer...'
          : language === 'zh'
            ? `共 ${localItems.length} 个 skills，点击详情查看 SKILL.md。`
            : `${localItems.length} skills. Open details to view SKILL.md.`}
      </p>
      {error && <p className="feature-error">{error}</p>}
      <div className="result-stack">
        {results.map((skill) => {
          const enabled = !disabledSkillNames.has(skill.name);
          return (
            <article
              className={`result-card skill skill-tile ${enabled ? '' : 'disabled'}`}
              key={skill.name}
            >
              <button
                className="skill-tile-main"
                type="button"
                onClick={() => void openDetail(skill)}
              >
                <Code2 size={18} />
                <div>
                  <h3>{skill.name}</h3>
                  <p>{language === 'zh' ? skill.descriptionZh : skill.description}</p>
                  <small>{skill.path}</small>
                </div>
                <span className="skill-detail-label">
                  {language === 'zh' ? '详情' : 'Details'}
                </span>
              </button>
              <button
                className={`skill-toggle ${enabled ? 'on' : ''}`}
                type="button"
                onClick={() => onToggleSkill(skill.name, !enabled)}
              >
                {enabled ? <CheckCircle2 size={14} /> : <Circle size={14} />}
                {enabled
                  ? language === 'zh'
                    ? '已启用'
                    : 'Enabled'
                  : language === 'zh'
                    ? '已关闭'
                    : 'Disabled'}
              </button>
            </article>
          );
        })}
      </div>
      {detail && (
        <SkillDetailDialog
          language={language}
          detail={detail}
          loading={detailLoading}
          error={detailError}
          onClose={() => {
            setDetail(null);
            setDetailError('');
          }}
        />
      )}
    </div>
  );
}

function SkillDetailDialog({
  language,
  detail,
  loading,
  error,
  onClose,
}: {
  language: AppLanguage;
  detail: SkillDetail;
  loading: boolean;
  error: string;
  onClose: () => void;
}) {
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <section className="skill-detail-dialog" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <Puzzle size={18} />
          <strong>{detail.name}</strong>
          <button type="button" onClick={onClose}>
            <X size={16} />
          </button>
        </header>
        {loading ? (
          <div className="skill-detail-loading">
            <LoaderCircle size={22} />
            {language === 'zh' ? '正在加载 Skill 详情...' : 'Loading skill detail...'}
          </div>
        ) : (
          <>
            <p>{(language === 'zh' ? detail.descriptionZh : detail.description) || detail.description || (language === 'zh' ? '暂无描述' : 'No description')}</p>
            <div className="skill-meta">
              {detail.version && <span>v{detail.version}</span>}
              {detail.routingHidden && <span>{language === 'zh' ? '隐藏路由' : 'hidden routing'}</span>}
              {detail.minServerVersion && <span>server &gt;= {detail.minServerVersion}</span>}
              {detail.requires.map((item) => (
                <span key={`requires-${item}`}>requires {item}</span>
              ))}
            </div>
            {detail.packageDir && <InfoRow label="package_dir" value={detail.packageDir} />}
            {detail.path && <InfoRow label="SKILL.md" value={detail.path} />}
            {error ? (
              <p className="feature-error">{error}</p>
            ) : (
              <pre className="skill-content">{detail.content || (language === 'zh' ? 'Skill 详情为空' : 'Skill detail is empty')}</pre>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="info-row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
