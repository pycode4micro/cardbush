import {
  AlertCircle,
  Archive,
  ArrowDown,
  ArrowLeft,
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
  Image,
  LoaderCircle,
  Menu,
  MessageSquare,
  Monitor,
  MoreHorizontal,
  Network,
  Paperclip,
  Pause,
  Pin,
  Plus,
  Puzzle,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Smartphone,
  Sparkles,
  Terminal,
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
  type ReactNode,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  automationTasks,
} from './data/mock';
import {
  backendBaseUrl,
  clearConversationHistory,
  clearLogsCache,
  controlBotService,
  deleteWeixinAccount,
  fetchBotConfig,
  fetchBots,
  fetchBotServiceLogs,
  fetchBotStatus,
  fetchProjectContext,
  fetchWeixinLoginStatus,
  llmEndpoint,
  saveProjectContext,
  saveBotConfig,
  startWeixinLogin,
  type MaintenanceClearResult,
  type SessionShareLinkResult,
} from './backend/api';
import {
  useCardbushChat,
  type QueuedChatMessage,
} from './hooks/useCardbushChat';
import type {
  AppLanguage,
  AppLanguageMode,
  AppSection,
  AppSettingsState,
  AutomationTask,
  CardlingDesktopAction,
  CardlingDesktopState,
  ChatMessage,
  ChatToolExecution,
  CompanionMotionMode,
  CompanionSettings,
  CompanionSize,
  CompanionStatus,
  ConversationSummary,
  BotConfigResult,
  BotPlatform,
  BotPlatformOverview,
  BotServiceStatus,
  BotStatusResult,
  WeixinLoginStartResult,
  WeixinLoginStatus,
  WeixinLoginStatusResult,
  LightThemeStyle,
  ManagedModelConfig,
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
  automation: { zh: '自动化', en: 'Automation' },
};

const settingsLabels: Record<SettingsSection, { zh: string; en: string }> = {
  profile: { zh: '外观', en: 'Appearance' },
  companion: { zh: '卡灵', en: 'Cardling' },
  proxy: { zh: '代理设置', en: 'Proxy' },
  bots: { zh: 'Bot 连接', en: 'Bot connections' },
  cache: { zh: '缓存', en: 'Cache' },
  models: { zh: '模型管理', en: 'Models' },
  diagnostics: { zh: '连接诊断', en: 'Diagnostics' },
  mobile: { zh: '手机连接', en: 'Mobile' },
  about: { zh: '关于', en: 'About' },
};

const settingsIcons: Record<SettingsSection, typeof Settings> = {
  profile: Settings,
  companion: Sparkles,
  proxy: Monitor,
  bots: Network,
  cache: Archive,
  models: Cpu,
  diagnostics: Clipboard,
  mobile: Monitor,
  about: Circle,
};

const LazyMarkdownContent = lazy(async () => {
  const [{ default: ReactMarkdown }, { default: remarkGfm }] = await Promise.all([
    import('react-markdown'),
    import('remark-gfm'),
  ]);

  function MarkdownRenderer({ content }: { content: string }) {
    return <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>;
  }

  return { default: MarkdownRenderer };
});

type QuickLoadPayload = {
  kind: 'text' | 'file' | 'folder';
  title: string;
  value: string;
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
  platform?: string;
  icon: React.ReactNode;
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

type ScreenshotCaptureResult = {
  path: string;
  name: string;
  width: number;
  height: number;
  dataUrl?: string;
  windows?: ScreenshotWindowSource[];
};

type ScreenshotWindowSource = {
  id: string;
  name: string;
  path: string;
  width: number;
  height: number;
  dataUrl?: string;
};

type ScreenshotSelection = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type ScreenshotStroke = Array<{ x: number; y: number }>;

type ComposerImageAttachment = {
  id: string;
  path: string;
  name: string;
  previewUrl: string;
};

const COPY_FEEDBACK_EVENT = 'cardbush-copy-feedback';

type ImagePreview = {
  src: string;
  name: string;
  path?: string;
};

type ComposerMenu =
  | 'project'
  | 'tokens'
  | 'git'
  | 'screenshot'
  | 'skills'
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
};

const defaultSidebarWidth = 272;
const minSidebarWidth = 220;
const maxSidebarWidth = 420;
const customProviderValue = '__custom_provider__';
const suggestedProviders = [
  'openai',
  'anthropic',
  'gemini',
  'deepseek',
  'moonshot',
  'qwen',
];
const liteLlmProvidersDocsUrl = 'https://docs.litellm.ai/docs/providers';
const volcengineArkUrl = 'https://www.volcengine.cn/product/ark';
const miniMaxUrl = 'https://platform.minimaxi.com';

const defaultAppSettings: AppSettingsState = {
  proxy: {
    mode: 'manual',
    httpProxy: '',
    httpsProxy: '',
    noProxy: '127.0.0.1,localhost,::1',
  },
  managedModelConfigs: [],
  hideCardbushForScreenshot: false,
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
    icon: <Bot size={16} />,
  },
  {
    title: { zh: '微信', en: 'WeChat' },
    subtitle: { zh: '仅微信可使用此绑定码', en: 'Limit this code to WeChat' },
    platform: 'weixin',
    icon: <MessageSquare size={16} />,
  },
  {
    title: { zh: '飞书', en: 'Feishu' },
    subtitle: { zh: '仅飞书可使用此绑定码', en: 'Limit this code to Feishu' },
    platform: 'feishu',
    icon: <MessageSquare size={16} />,
  },
  {
    title: { zh: 'Discord', en: 'Discord' },
    subtitle: { zh: '仅 Discord 可使用此绑定码', en: 'Limit this code to Discord' },
    platform: 'discord',
    icon: <Code2 size={16} />,
  },
  {
    title: { zh: 'Telegram', en: 'Telegram' },
    subtitle: { zh: '仅 Telegram 可使用此绑定码', en: 'Limit this code to Telegram' },
    platform: 'telegram',
    icon: <ArrowUp size={16} />,
  },
];

const botPlatforms: BotPlatform[] = ['weixin', 'feishu', 'telegram', 'discord'];

const botPlatformLabels: Record<BotPlatform, { zh: string; en: string }> = {
  weixin: { zh: '微信', en: 'WeChat' },
  feishu: { zh: '飞书', en: 'Feishu' },
  telegram: { zh: 'Telegram', en: 'Telegram' },
  discord: { zh: 'Discord', en: 'Discord' },
};

type ProjectAction =
  | 'pin'
  | 'open'
  | 'refreshGit'
  | 'newChat'
  | 'rename'
  | 'archive'
  | 'remove';

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
  const [sidebarWidth, setSidebarWidthState] = useState(() =>
    readInitialSidebarWidth(),
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] =
    useState<SettingsSection>('profile');
  const [projectItems, setProjectItems] = useState<ProjectItem[]>(readProjectItems);
  const [wallpaperAccent, setWallpaperAccent] = useState<WallpaperAccent | null>(null);
  const [draft, setDraft] = useState('');
  const [projectContexts, setProjectContexts] = useState<Record<string, string>>(
    readProjectContexts,
  );
  const [disabledSkillNames, setDisabledSkillNames] = useState<Set<string>>(
    readDisabledSkillNames,
  );
  const theme = resolveTheme(themePreference, lightThemeStyle, systemDark);
  const language = resolveAppLanguage(languageMode, systemLanguage);
  const availableModels = useMemo(
    () => effectiveModels(appSettings.managedModelConfigs),
    [appSettings.managedModelConfigs],
  );
  const chat = useCardbushChat(appSettings.managedModelConfigs, availableModels, {
    projectContexts,
    disabledSkillNames,
  });
  const enabledSkills = useMemo(
    () => chat.skills.filter((skill) => !disabledSkillNames.has(skill.name)),
    [chat.skills, disabledSkillNames],
  );
  const activeProjectDir =
    conversationWorkspaceRoot(chat.activeConversation) || undefined;
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
  const activeToolRunning = chat.activeMessages.some((message) =>
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
    let cancelled = false;
    async function refreshWallpaperAccent() {
      const accent = await window.cardbushDesktop?.wallpaperAccent?.().catch(() => null);
      if (!cancelled && accent) {
        setWallpaperAccent(accent);
      }
    }
    void refreshWallpaperAccent();
    const refreshOnFocus = () => {
      void refreshWallpaperAccent();
    };
    window.addEventListener('focus', refreshOnFocus);
    document.addEventListener('visibilitychange', refreshOnFocus);
    const interval = window.setInterval(refreshOnFocus, 5 * 60 * 1000);
    return () => {
      cancelled = true;
      window.removeEventListener('focus', refreshOnFocus);
      document.removeEventListener('visibilitychange', refreshOnFocus);
      window.clearInterval(interval);
    };
  }, []);

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
    <div className={`app theme-${theme}`} lang={language} style={appStyle}>
      <WindowFrame
        onOpenBotSettings={() => openSettings('bots')}
        onOpenCacheSettings={() => openSettings('cache')}
      />
      {settingsOpen ? (
        <SettingsView
          themePreference={themePreference}
          lightThemeStyle={lightThemeStyle}
          language={language}
          languageMode={languageMode}
          systemLanguage={systemLanguage}
          settings={appSettings}
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
                skills={enabledSkills}
                loading={chat.loading || chat.messagesLoading}
                sending={chat.sending}
                activeTurnId={chat.activeTurnId}
                queuedMessageCount={chat.queuedMessageCount}
                queuedMessagePreview={chat.queuedMessagePreview}
                queuedMessages={chat.queuedMessages}
                pendingInteraction={chat.pendingInteraction}
                error={chat.error}
                selectedModel={chat.selectedModel}
                availableModels={availableModels}
                hideCardbushForScreenshot={appSettings.hideCardbushForScreenshot}
                onModelChange={chat.setSelectedModel}
                onConfigureModels={() => openSettings('models')}
                onCreateConversation={() => createConversation(activeProjectDir)}
                onSaveProjectContext={saveActiveProjectContext}
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
                draft={draft}
                onDraftChange={setDraft}
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
        <section className="cardling-panel" aria-label="Cardling status">
          <header>
            <strong>{language === 'zh' ? '卡灵' : 'Cardling'}</strong>
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
        aria-label={language === 'zh' ? '卡灵状态' : 'Cardling status'}
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
  if (stored === 'system' || stored === 'light' || stored === 'dark') {
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
    managedModelConfigs: readManagedModelConfigs(),
    hideCardbushForScreenshot:
      window.localStorage.getItem('cardbush_hide_for_screenshot') === 'true',
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
    managedModelConfigs: normalizeManagedModelConfigs(
      settings.managedModelConfigs,
    ),
    hideCardbushForScreenshot: settings.hideCardbushForScreenshot,
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
    'cardbush_managed_model_configs',
    JSON.stringify(settings.managedModelConfigs),
  );
  window.localStorage.setItem(
    'cardbush_hide_for_screenshot',
    String(settings.hideCardbushForScreenshot),
  );
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

function fileUrl(value: string) {
  const normalized = stripWrappingQuotes(value.trim());
  if (/^file:\/\//i.test(normalized)) {
    return normalized;
  }
  return `file:///${normalized.replaceAll('\\', '/').replace(/^\/+/, '')}`;
}

function isImagePath(value: string) {
  return /\.(png|jpe?g|webp|gif|bmp|ico)$/i.test(stripWrappingQuotes(value.trim()));
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
  onOpenBotSettings,
  onOpenCacheSettings,
}: {
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

function SidebarResizer({
  language,
  onWidthChange,
}: {
  language: AppLanguage;
  onWidthChange: (value: number) => void;
}) {
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const beginResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragStateRef.current = {
        startX: event.clientX,
        startWidth: readCurrentSidebarWidth(),
      };
      document.body.classList.add('sidebar-resizing');

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const state = dragStateRef.current;
        if (!state) {
          return;
        }
        onWidthChange(state.startWidth + moveEvent.clientX - state.startX);
      };
      const handlePointerUp = () => {
        dragStateRef.current = null;
        document.body.classList.remove('sidebar-resizing');
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
      };
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
    },
    [onWidthChange],
  );

  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={language === 'zh' ? '调整侧边栏宽度' : 'Resize sidebar'}
      title={language === 'zh' ? '拖动调整侧边栏宽度' : 'Drag to resize sidebar'}
      onPointerDown={beginResize}
    />
  );
}

function readCurrentSidebarWidth() {
  const scope = document.querySelector<HTMLElement>('.app') ?? document.documentElement;
  const raw = getComputedStyle(scope)
    .getPropertyValue('--sidebar-width')
    .trim();
  const fromRoot = Number.parseFloat(raw);
  if (Number.isFinite(fromRoot)) {
    return fromRoot;
  }
  const sidebar = document.querySelector<HTMLElement>('.sidebar, .settings-sidebar');
  return sidebar?.getBoundingClientRect().width ?? defaultSidebarWidth;
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

  useEffect(() => {
    if (!openMenu) {
      return undefined;
    }
    function closeOnOutsidePointer(event: PointerEvent) {
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      if (
        target.closest('.sidebar-menu') ||
        target.closest('.row-more') ||
        target.closest('.conversation-more')
      ) {
        return;
      }
      setOpenMenu(null);
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
    };
  }, [openMenu]);

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
        <NavRow icon={<Edit3 size={17} />} label={language === 'zh' ? '新会话' : 'New chat'} onClick={onCreateConversation} />
        <NavRow active={section === 'search'} icon={<Search size={17} />} label={t('search')} onClick={() => onSectionChange('search')} />
        <NavRow active={section === 'skills'} icon={<Puzzle size={17} />} label={t('skills')} onClick={() => onSectionChange('skills')} />
        <NavRow active={section === 'automation'} icon={<Clock3 size={17} />} label={t('automation')} onClick={() => onSectionChange('automation')} />
      </nav>

      <div className="sidebar-scroll">
        <SectionHeader
          title={language === 'zh' ? '项目' : 'Projects'}
          action={<FolderOpen size={14} />}
          expanded={expandedSections.has('projects')}
          onToggle={() => toggleSection('projects')}
          onAction={onAddProject}
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
            onMenuToggle={() =>
              setOpenMenu((current) =>
                current === `project:${project.id}` ? null : `project:${project.id}`,
              )
            }
            onProjectAction={(action) => {
              setOpenMenu(null);
              onProjectAction(action, project);
            }}
            onConversationChange={onConversationChange}
            onConversationMenuToggle={(conversationId) =>
              setOpenMenu((current) =>
                current === `conversation:${conversationId}`
                  ? null
                  : `conversation:${conversationId}`,
              )
            }
            onConversationArchive={toggleConversationArchive}
            onDeleteConversation={onDeleteConversation}
            onRenameConversation={onRenameConversation}
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
              setOpenMenu((current) =>
                current === 'section:conversations'
                  ? null
                  : 'section:conversations',
              )
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
                setOpenMenu((current) =>
                  current === `conversation:${conversation.id}`
                    ? null
                    : `conversation:${conversation.id}`,
                )
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
              onClick={() => onConversationChange(conversation.id)}
            />
          ))}
      </div>

      <button className="settings-dock" type="button" onClick={onOpenSettings}>
        <Settings size={17} />
        <span>{language === 'zh' ? '设置' : 'Settings'}</span>
      </button>
    </aside>
  );
}

function NavRow({
  active,
  icon,
  label,
  onClick,
}: {
  active?: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button className={`nav-row ${active ? 'active' : ''}`} type="button" onClick={onClick}>
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
}: {
  title: string;
  action: React.ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
  onAction?: () => void;
}) {
  return (
    <div className="section-header">
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
  onMenuToggle,
  onProjectAction,
  onConversationChange,
  onConversationMenuToggle,
  onConversationArchive,
  onDeleteConversation,
  onRenameConversation,
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
  onMenuToggle: () => void;
  onProjectAction: (action: ProjectAction) => void;
  onConversationChange: (id: string) => void;
  onConversationMenuToggle: (conversationId: string) => void;
  onConversationArchive: (conversationId: string) => void;
  onDeleteConversation: (conversationId: string) => void;
  onRenameConversation: (conversationId: string, title: string) => void;
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
          <small>
            {project.branch
              ? `${project.branch} · ${project.changedCount ?? 0}`
              : project.rootPath}
          </small>
        </div>
        <button
          className="row-more"
          type="button"
          aria-label="project options"
          onClick={(event) => {
            event.stopPropagation();
            onMenuToggle();
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
  onClick: () => void;
}) {
  const changeCount = changeReports?.reduce((sum, report) => sum + report.fileCount, 0) ?? 0;
  return (
    <div
      className={`conversation-row ${nested ? 'nested' : ''} ${active ? 'active' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onClick}
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
        type="button"
        aria-label="conversation options"
        onClick={(event) => {
          event.stopPropagation();
          onMenuToggle();
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
  loading,
  sending,
  activeTurnId,
  queuedMessageCount,
  queuedMessagePreview,
  queuedMessages,
  pendingInteraction,
  error,
  selectedModel,
  availableModels,
  hideCardbushForScreenshot,
  onModelChange,
  onConfigureModels,
  onCreateConversation,
  onSaveProjectContext,
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
  loading: boolean;
  sending: boolean;
  activeTurnId: string;
  queuedMessageCount: number;
  queuedMessagePreview: string;
  queuedMessages: QueuedChatMessage[];
  pendingInteraction: PendingInteraction | null;
  error: string | null;
  selectedModel: string;
  availableModels: string[];
  hideCardbushForScreenshot: boolean;
  onModelChange: (value: string) => void;
  onConfigureModels: () => void;
  onCreateConversation: () => void;
  onSaveProjectContext: (value: string) => Promise<string>;
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
  draft: string;
  onDraftChange: (value: string) => void;
}) {
  const showWelcome = !loading && messages.length === 0;
  const listRef = useRef<VirtuosoHandle>(null);
  const listScrollerRef = useRef<HTMLElement | null>(null);
  const composerDockRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const autoFollowStreamRef = useRef(true);
  const userDetachedFromBottomRef = useRef(false);
  const showScrollBottomRef = useRef(false);
  const pendingSubmittedUserFocusRef = useRef(false);
  const programmaticScrollUntilRef = useRef(0);
  const messageSnapshotRef = useRef<{ conversationId: string; ids: string[] }>({
    conversationId: '',
    ids: [],
  });
  const streamScrollFrameRef = useRef<number | null>(null);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [consoleMode, setConsoleMode] = useState<ConsoleMode | null>(null);
  const [projectEntries, setProjectEntries] = useState<ProjectEntry[]>([]);
  const [composerDockHeight, setComposerDockHeight] = useState(0);

  const setScrollBottomVisible = useCallback((visible: boolean) => {
    showScrollBottomRef.current = visible;
    setShowScrollBottom(visible);
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
      const desiredTop = Math.round(scroller.clientHeight * 0.22);
      const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const nextTop = Math.max(
        0,
        Math.min(
          maxTop,
          scroller.scrollTop + itemRect.top - scrollerRect.top - desiredTop,
        ),
      );
      scroller.scrollTo({ top: nextTop, behavior: 'auto' });
    },
    [],
  );

  const focusSubmittedUserMessage = useCallback(
    (index: number, messageId: string) => {
      pendingSubmittedUserFocusRef.current = false;
      programmaticScrollUntilRef.current = Date.now() + 1200;
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
        scrollerRect.bottom - Math.max(0, composerDockHeight) - 18;
      if (itemRect.bottom <= visibleBottom) {
        return;
      }
      scroller.scrollBy({
        top: Math.ceil(itemRect.bottom - visibleBottom),
        behavior: 'auto',
      });
    },
    [composerDockHeight],
  );

  const scheduleActiveAssistantFollow = useCallback(
    (messageId: string) => {
      if (streamScrollFrameRef.current != null) {
        window.cancelAnimationFrame(streamScrollFrameRef.current);
      }
      programmaticScrollUntilRef.current = Date.now() + 500;
      streamScrollFrameRef.current = window.requestAnimationFrame(() => {
        streamScrollFrameRef.current = null;
        ensureMessageBottomVisible(messageId);
      });
    },
    [ensureMessageBottomVisible],
  );

  const markUserDetachedFromBottom = useCallback(() => {
    userDetachedFromBottomRef.current = true;
    autoFollowStreamRef.current = false;
    pendingSubmittedUserFocusRef.current = false;
    if (!atBottomRef.current) {
      setScrollBottomVisible(true);
      return;
    }
    window.requestAnimationFrame(() => {
      if (userDetachedFromBottomRef.current && !atBottomRef.current) {
        setScrollBottomVisible(true);
      }
    });
  }, [setScrollBottomVisible]);

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
    };
  }, []);

  useEffect(() => {
    const previous = messageSnapshotRef.current;
    const ids = messages.map((message) => message.id);
    if (previous.conversationId !== activeConversationId) {
      autoFollowStreamRef.current = true;
      userDetachedFromBottomRef.current = false;
      atBottomRef.current = true;
      setScrollBottomVisible(false);
      messageSnapshotRef.current = { conversationId: activeConversationId, ids };
      if (
        messages.length > 0 &&
        (pendingSubmittedUserFocusRef.current || sending)
      ) {
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          if (messages[index]?.role === 'user') {
            focusSubmittedUserMessage(index, messages[index].id);
            break;
          }
        }
      }
      return;
    }
    const previousIds = new Set(previous.ids);
    const submittedUserIndex = messages.findIndex(
      (message) => message.role === 'user' && !previousIds.has(message.id),
    );
    if (
      submittedUserIndex >= 0 &&
      (pendingSubmittedUserFocusRef.current ||
        (sending &&
          messages.length > previous.ids.length &&
          !userDetachedFromBottomRef.current))
    ) {
      focusSubmittedUserMessage(
        submittedUserIndex,
        messages[submittedUserIndex].id,
      );
    }
    messageSnapshotRef.current = { conversationId: activeConversationId, ids };
  }, [
    activeConversationId,
    focusSubmittedUserMessage,
    messages,
    sending,
    setScrollBottomVisible,
  ]);

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
      messages.find(
        (message) =>
          message.role === 'assistant' &&
          activeTurnId.trim() !== '' &&
          message.turnId?.trim() === activeTurnId.trim(),
      ) ??
      [...messages].reverse().find((message) => message.role === 'assistant');
    if (!activeAssistant) {
      return;
    }
    scheduleActiveAssistantFollow(activeAssistant.id);
  }, [
    activeTurnId,
    loading,
    messages,
    scheduleActiveAssistantFollow,
    sending,
    showWelcome,
  ]);

  const quickItems = useMemo(
    () =>
      quickSideItems({
        conversations,
        activeConversationId,
        messages,
        projectEntries,
        activeProjectDir,
        language,
      }),
    [
      activeConversationId,
      activeProjectDir,
      conversations,
      language,
      messages,
      projectEntries,
    ],
  );

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

  const scrollToBottom = useCallback(() => {
    if (messages.length === 0) {
      return;
    }
    programmaticScrollUntilRef.current = Date.now() + 800;
    autoFollowStreamRef.current = true;
    userDetachedFromBottomRef.current = false;
    pendingSubmittedUserFocusRef.current = false;
    listRef.current?.scrollTo({
      top: Number.MAX_SAFE_INTEGER,
      behavior: 'smooth',
    });
    setScrollBottomVisible(false);
  }, [messages.length, setScrollBottomVisible]);

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
      {error && (
        <div className="error-banner">
          <AlertCircle size={16} />
          <span>{error}</span>
          <button type="button" onClick={onClearError}>
            <X size={16} />
          </button>
        </div>
      )}
      <div className="chat-body" style={chatBodyStyle}>
        {loading ? (
          <BackendLoading />
        ) : showWelcome ? (
          <WelcomeComposer
            language={language}
            draft={draft}
            onDraftChange={onDraftChange}
            sending={sending}
            queuedMessageCount={queuedMessageCount}
            queuedMessagePreview={queuedMessagePreview}
            selectedModel={selectedModel}
            availableModels={availableModels}
            hideCardbushForScreenshot={hideCardbushForScreenshot}
            onModelChange={onModelChange}
            onConfigureModels={onConfigureModels}
            onCreateConversation={onCreateConversation}
            activeProjectDir={activeProjectDir}
            projectContext={projectContext}
            skills={skills}
            onSaveProjectContext={onSaveProjectContext}
            onSend={handleComposerSend}
            onCancel={onCancel}
          />
        ) : (
          <Virtuoso
            ref={listRef}
            className="message-list"
            style={{ height: '100%' }}
            data={messages}
            components={{ Footer: MessageListFooter }}
            followOutput={false}
            scrollerRef={(ref) => {
              listScrollerRef.current = ref instanceof HTMLElement ? ref : null;
            }}
            onWheelCapture={markUserDetachedFromBottom}
            onTouchStartCapture={markUserDetachedFromBottom}
            atBottomStateChange={(atBottom) => {
              atBottomRef.current = atBottom;
              if (atBottom) {
                autoFollowStreamRef.current = true;
                userDetachedFromBottomRef.current = false;
                setScrollBottomVisible(false);
                return;
              }
              if (
                autoFollowStreamRef.current ||
                Date.now() < programmaticScrollUntilRef.current
              ) {
                setScrollBottomVisible(false);
                return;
              }
              setScrollBottomVisible(userDetachedFromBottomRef.current);
            }}
            itemContent={(_, message) => (
              <div data-message-id={message.id} data-message-role={message.role}>
                <MessageBubble
                  key={message.id}
                  message={message}
                  language={language}
                  sending={sending}
                  activeTurnId={activeTurnId}
                  onRegenerate={onRegenerate}
                  onEditUserMessage={onEditUserMessage}
                  onGuideMessage={onGuideMessage}
                  onRevertChangeReport={onRevertChangeReport}
                />
              </div>
            )}
          />
        )}
        <button
          className={`scroll-bottom ${
            loading || showWelcome || !showScrollBottom ? 'hidden' : ''
          }`}
          type="button"
          aria-label="scroll bottom"
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
            onEditQueuedMessage={editQueuedMessage}
            onDeleteQueuedMessage={onRemoveQueuedMessage}
            onGuideQueuedMessage={(queuedId) =>
              onGuideQueuedMessage(queuedId, 'append_context')
            }
          />
        )}
        {!showWelcome && !loading && (
          <div className="composer-dock" ref={composerDockRef}>
            <Composer
              language={language}
              draft={draft}
              onDraftChange={onDraftChange}
              sending={sending}
              queuedMessageCount={queuedMessageCount}
              queuedMessagePreview={queuedMessagePreview}
              selectedModel={selectedModel}
              availableModels={availableModels}
              hideCardbushForScreenshot={hideCardbushForScreenshot}
            onModelChange={onModelChange}
              onSend={handleComposerSend}
              onCancel={onCancel}
              messages={messages}
              skills={skills}
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

function MessageListFooter() {
  return <div className="message-list-footer" />;
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
  onEditQueuedMessage,
  onDeleteQueuedMessage,
  onGuideQueuedMessage,
}: {
  language: AppLanguage;
  items: QuickSideItem[];
  queuedMessages: QueuedChatMessage[];
  onLoad: (payload: QuickLoadPayload) => void;
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
                ? '拖到输入框加载'
                : 'Drag into the composer'}
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
              onLoad={(payload) => {
                onLoad(payload);
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
  onLoad,
}: {
  item: QuickSideItem;
  onLoad: (payload: QuickLoadPayload) => void;
}) {
  const enabled = item.payload != null;
  return (
    <button
      className={`quick-side-item ${enabled ? 'enabled' : ''}`}
      type="button"
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
      onClick={() => item.payload && onLoad(item.payload)}
    >
      {item.icon}
      <span>
        <strong>{item.title}</strong>
        <small>{item.subtitle}</small>
      </span>
    </button>
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
  hideCardbushForScreenshot,
  activeProjectDir,
  projectContext,
  skills = [],
  onModelChange,
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
  hideCardbushForScreenshot: boolean;
  activeProjectDir?: string;
  projectContext: string;
  skills?: SkillSummary[];
  onModelChange: (value: string) => void;
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
        hideCardbushForScreenshot={hideCardbushForScreenshot}
        onModelChange={onModelChange}
        onConfigureModels={onConfigureModels}
        onCreateConversation={onCreateConversation}
        activeProjectDir={activeProjectDir}
        projectContext={projectContext}
        skills={skills}
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

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    window.dispatchEvent(new CustomEvent(COPY_FEEDBACK_EVENT));
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  if (!copied) {
    throw new Error('Copy failed');
  }
  window.dispatchEvent(new CustomEvent(COPY_FEEDBACK_EVENT));
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
  const [autoRefresh, setAutoRefresh] = useState(true);
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

  useEffect(() => {
    if (!link || !autoRefresh) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      void refreshSession(true);
    }, 8000);
    return () => window.clearInterval(timer);
  }, [autoRefresh, link, refreshSession]);

  return (
    <div className="bot-share-menu" role="dialog" aria-label={language === 'zh' ? 'Bot 绑定' : 'Bot link'}>
      <header>
        <span className="bot-share-icon">
          <Bot size={16} />
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
              ? '在 Bot 对话里发送下面命令，即可接管当前会话。'
              : 'Send this command in the Bot chat to take over the current session.'}
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
          <label className="bot-share-check">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.currentTarget.checked)}
            />
            <span>{language === 'zh' ? '每 8 秒自动刷新历史' : 'Auto refresh history every 8s'}</span>
          </label>
          <div className="bot-share-actions">
            <button className="secondary-button" type="button" onClick={() => void refreshSession(false)}>
              {refreshing ? <LoaderCircle size={14} /> : <RefreshCw size={14} />}
              <span>{language === 'zh' ? '刷新历史' : 'Refresh'}</span>
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
          className="topbar-pill"
          type="button"
          disabled={!botShareEnabled}
          aria-expanded={botMenuOpen}
          title={
            botShareEnabled
              ? botShareLabel
              : language === 'zh'
                ? '请先创建会话'
                : 'Create a chat first'
          }
          onClick={() => setBotMenuOpen((current) => !current)}
        >
          <Bot size={14} />
          <span>{botShareLabel}</span>
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
  onRegenerate,
  onEditUserMessage,
  onGuideMessage,
  onRevertChangeReport,
}: {
  message: ChatMessage;
  language: AppLanguage;
  sending: boolean;
  activeTurnId: string;
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
}) {
  const { imagePaths, text } = splitMessageImages(message.content);
  const toolExecutions = message.toolExecutions ?? [];
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(text);
  const [submittingEdit, setSubmittingEdit] = useState(false);
  const [guidanceOpen, setGuidanceOpen] = useState(false);
  const activeMessageTurn = message.turnId?.trim() ?? '';
  const isActiveAssistantTurn =
    message.role === 'assistant' &&
    sending &&
    activeTurnId.trim() !== '' &&
    activeTurnId.trim() === activeMessageTurn;
  const [progressNow, setProgressNow] = useState(() => Date.now());
  const canGuide =
    sending && activeTurnId.trim() !== '' && activeTurnId.trim() === activeMessageTurn;

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
    setEditText(splitMessageImages(message.content).text);
  }, [message.id, message.content]);

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

  const showAssistantProgress =
    message.role === 'assistant' && (isActiveAssistantTurn || toolExecutions.length > 0);
  const assistantProgressText = showAssistantProgress
    ? assistantProgressLabel({
        executions: toolExecutions,
        isActive: isActiveAssistantTurn,
        messageCreatedAt: message.createdAt,
        now: progressNow,
        language,
      })
    : '';

  return (
    <>
      <div className="message-row assistant">
        <div className="assistant-bubble">
          {showAssistantProgress && (
            <div className="assistant-run-header">
              <span>{assistantProgressText}</span>
              <div />
            </div>
          )}
          <MessageImageStrip paths={imagePaths} />
          {toolExecutions.length > 0 ? (
            <AssistantMessageContent
              content={text}
              executions={toolExecutions}
              language={language}
              message={message}
              onRevertChangeReport={onRevertChangeReport}
            />
          ) : text ? (
            <MarkdownContent content={text} />
          ) : (
            <p className="assistant-thinking">
              {language === 'zh' ? '正在思考' : 'Thinking'}
            </p>
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

function AssistantMessageContent({
  content,
  executions,
  language,
  message,
  onRevertChangeReport,
}: {
  content: string;
  executions: ChatToolExecution[];
  language: AppLanguage;
  message: ChatMessage;
  onRevertChangeReport: (
    report: ConversationChangeReport,
    message: ChatMessage,
  ) => Promise<void>;
}) {
  const sortedExecutions = [...executions].sort(
    (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
  );
  const offsets = sortedExecutions
    .map((item) => item.contentOffset)
    .filter((offset) => offset > 0);
  const firstOffset = offsets.length > 0 ? Math.min(...offsets) : 0;
  const clampedOffset = Math.max(0, Math.min(content.length, firstOffset));
  const before = content.slice(0, clampedOffset).trimEnd();
  const after = content.slice(clampedOffset).trimStart();
  const running = sortedExecutions.some(isToolRunning);

  return (
    <div className="assistant-message-content">
      {before && <MarkdownContent content={before} />}
      <ToolExecutionBlock
        executions={sortedExecutions}
        language={language}
        message={message}
        onRevertChangeReport={onRevertChangeReport}
      />
      {after && <MarkdownContent content={after} />}
      {!after && running && (
        <p className="assistant-thinking assistant-thinking-inline">
          {language === 'zh' ? '正在思考' : 'Thinking'}
        </p>
      )}
    </div>
  );
}

function ToolExecutionBlock({
  executions,
  language,
  message,
  onRevertChangeReport,
}: {
  executions: ChatToolExecution[];
  language: AppLanguage;
  message: ChatMessage;
  onRevertChangeReport: (
    report: ConversationChangeReport,
    message: ChatMessage,
  ) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const running = executions.some(isToolRunning);
  const failedCount = executions.filter(isToolFailed).length;
  const changeReport = toolChangeReportFromExecutions(executions);

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
        failed={failedCount > 0}
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
    <div className="tool-execution-block">
      <button
        className="tool-execution-summary"
        type="button"
        onClick={() => setExpanded((value) => !value)}
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
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolChangeBlock({
  report,
  running,
  language,
  onRevert,
}: {
  report: ToolChangeReport;
  running: boolean;
  failed: boolean;
  language: AppLanguage;
  onRevert?: () => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [reverting, setReverting] = useState(false);
  const hasDetails = report.files.some((file) => file.lines.length > 0);
  const title =
    running && !hasDetails
      ? language === 'zh'
        ? '正在修改文件'
        : 'Changing files'
      : language === 'zh'
        ? `${report.fileCount} 个文件已更改`
        : `${report.fileCount} file${report.fileCount === 1 ? '' : 's'} changed`;

  return (
    <div className="tool-change-block">
      <div className="tool-change-header-row">
        <button
          className="tool-change-header"
          type="button"
          disabled={!hasDetails}
          onClick={() => setExpanded((value) => !value)}
        >
          <Code2 size={15} />
          <span>
            <strong>{title}</strong>
            {report.additions > 0 && (
              <b className="diff-count add">+{report.additions}</b>
            )}
            {report.deletions > 0 && (
              <b className="diff-count del">-{report.deletions}</b>
            )}
          </span>
          <em>{expanded ? (language === 'zh' ? '收起' : 'Hide') : language === 'zh' ? '查看改动' : 'View diff'}</em>
          <ChevronDown size={16} className={expanded ? 'expanded' : ''} />
        </button>
        {onRevert && hasDetails && (
          <button
            className="tool-change-revert"
            type="button"
            disabled={reverting}
            title={language === 'zh' ? '撤回这组修改' : 'Revert this change set'}
            onClick={async () => {
              setReverting(true);
              try {
                await onRevert();
              } finally {
                setReverting(false);
              }
            }}
          >
            {reverting ? <LoaderCircle size={14} /> : <RotateCcw size={14} />}
            <span>{language === 'zh' ? '撤回' : 'Revert'}</span>
          </button>
        )}
      </div>
      {expanded && (
        <div className="tool-change-files">
          {report.files.map((file, index) => (
            <ToolFileChangeView
              // eslint-disable-next-line react/no-array-index-key
              key={`${file.path}-${index}`}
              file={file}
              language={language}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ToolFileChangeView({
  file,
  language,
}: {
  file: ToolFileChange;
  language: AppLanguage;
}) {
  return (
    <section className="tool-file-change">
      <header>
        <strong title={file.path}>{file.path}</strong>
        <span>
          {file.additions > 0 && <b className="diff-count add">+{file.additions}</b>}
          {file.deletions > 0 && <b className="diff-count del">-{file.deletions}</b>}
        </span>
      </header>
      {file.lines.length === 0 ? (
        <p>{language === 'zh' ? '没有可展开的 diff 内容' : 'No diff details available'}</p>
      ) : (
        <div className="diff-lines">
          {file.lines.map((line, index) => (
            <DiffLineView
              // eslint-disable-next-line react/no-array-index-key
              key={index}
              line={line}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function DiffLineView({ line }: { line: DiffLine }) {
  return (
    <div className={`diff-line ${line.kind}`}>
      <span className="diff-marker" />
      <code>{line.text || ' '}</code>
    </div>
  );
}

function ToolExecutionDetail({ execution }: { execution: ChatToolExecution }) {
  const [outputExpanded, setOutputExpanded] = useState(false);
  const status = isToolRunning(execution)
    ? '运行中'
    : isToolFailed(execution)
      ? '失败'
      : '完成';
  const duration = formatDuration(execution.durationMs);
  const summary = execution.summary.trim();
  const output = execution.output.trim();
  const shouldCollapseOutput = toolOutputNeedsCollapse(output);
  const visibleOutput =
    shouldCollapseOutput && !outputExpanded ? compactToolOutput(output) : output;
  return (
    <section className="tool-execution-detail">
      <header>
        <strong>{displayToolName(execution.name)}</strong>
        <span className={isToolFailed(execution) ? 'failed' : ''}>
          {duration ? `${status} · ${duration}` : status}
        </span>
      </header>
      {summary && <code>$ {summary}</code>}
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

type DiffLineKind = 'addition' | 'deletion' | 'context' | 'hunk';

type DiffLine = {
  kind: DiffLineKind;
  text: string;
};

type ToolFileChange = {
  path: string;
  additions: number;
  deletions: number;
  diff: string;
  lines: DiffLine[];
};

type ToolChangeReport = {
  files: ToolFileChange[];
  additions: number;
  deletions: number;
  fileCount: number;
};

type ConversationChangeReport = ToolChangeReport & {
  id: string;
  messageId: string;
  turnId?: string;
  createdAt?: string;
};

type SerializedToolFileChange = {
  path: string;
  diff: string;
  lines: string[];
};

type ParsedToolFileChange = {
  files: ToolFileChange[];
  fallbackAdditions: number;
  fallbackDeletions: number;
};

function isToolRunning(execution: ChatToolExecution) {
  const normalized = execution.state.trim().toLowerCase();
  return ['using', 'running', 'pending', 'started'].includes(normalized);
}

function isToolFailed(execution: ChatToolExecution) {
  const normalized = execution.state.trim().toLowerCase();
  return (
    ['fail', 'failed', 'error'].includes(normalized) ||
    (!execution.success && !isToolRunning(execution))
  );
}

function runningToolLabel(executions: ChatToolExecution[], language: AppLanguage) {
  const running =
    executions.find((item) => isToolRunning(item)) ?? executions[executions.length - 1];
  const summary = running?.summary.trim();
  const toolNameText = displayToolName(running?.name ?? '');
  if (!summary) {
    return language === 'zh' ? `正在运行 ${toolNameText}` : `Running ${toolNameText}`;
  }
  return language === 'zh'
    ? `正在运行 ${toolNameText} ${summary}`
    : `Running ${toolNameText} ${summary}`;
}

function toolChangeReportFromExecutions(
  executions: ChatToolExecution[],
): ToolChangeReport | null {
  const relevant = executions.filter(looksLikeFileChangeExecution);
  if (relevant.length === 0) {
    return null;
  }
  const allFiles: ToolFileChange[] = [];
  let fallbackAdditions = 0;
  let fallbackDeletions = 0;
  for (const execution of relevant) {
    const parsed = parseToolFileChange(execution);
    allFiles.push(...parsed.files);
    fallbackAdditions += parsed.fallbackAdditions;
    fallbackDeletions += parsed.fallbackDeletions;
  }
  const files = mergeToolFileChanges(allFiles);
  const parsedAdditions = files.reduce((sum, file) => sum + file.additions, 0);
  const parsedDeletions = files.reduce((sum, file) => sum + file.deletions, 0);
  if (files.length === 0 && fallbackAdditions === 0 && fallbackDeletions === 0) {
    const running = relevant.some(isToolRunning);
    if (!running) {
      return null;
    }
  }
  return {
    files,
    additions: parsedAdditions > 0 ? parsedAdditions : fallbackAdditions,
    deletions: parsedDeletions > 0 ? parsedDeletions : fallbackDeletions,
    fileCount: files.length === 0 ? 1 : files.length,
  };
}

function changeReportsFromMessages(messages: ChatMessage[]): ConversationChangeReport[] {
  return messages.flatMap((message, index) => {
    const report = toolChangeReportFromExecutions(message.toolExecutions ?? []);
    if (!report) {
      return [];
    }
    return [
      {
        ...report,
        id: `${message.id || index}:${message.turnId ?? ''}`,
        messageId: message.id,
        turnId: message.turnId,
        createdAt: message.createdAt,
      },
    ];
  });
}

function serializeToolChangeReport(report: ToolChangeReport): SerializedToolFileChange[] {
  return report.files
    .map((file) => ({
      path: file.path,
      diff: file.diff || file.lines.map((line) => line.text).join('\n'),
      lines: file.lines.map((line) => line.text),
    }))
    .filter((file) => file.path.trim() && (file.diff.trim() || file.lines.length > 0));
}

function conversationProjectDir(conversation?: ConversationSummary | null) {
  return (
    conversation?.projectDir?.trim() ||
    conversation?.workspaceContext?.projectDir?.trim() ||
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

function looksLikeFileChangeExecution(execution: ChatToolExecution) {
  if (String(execution.metadata.kind ?? '').trim() === 'file_change') {
    return true;
  }
  const name = execution.name.toLowerCase();
  const text = `${execution.summary}\n${execution.output}`.toLowerCase();
  return (
    name.includes('edit_file') ||
    name.includes('write_file') ||
    name.includes('apply_patch') ||
    name.includes('replace_file') ||
    text.includes('*** update file:') ||
    text.includes('*** add file:') ||
    text.includes('*** delete file:') ||
    text.includes('diff --git ') ||
    text.includes('\n+++ ') ||
    text.includes('files changed') ||
    text.includes('个文件已更改')
  );
}

function parseToolFileChange(execution: ChatToolExecution): ParsedToolFileChange {
  const metadataParsed = parseToolFileChangeMetadata(execution);
  if (metadataParsed) {
    return metadataParsed;
  }
  const text = `${execution.summary}\n${execution.output}`
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const fallback = parseFallbackChangeCounts(text);
  const files: ToolFileChange[] = [];
  const holder: { current: MutableToolFileChange | null } = { current: null };

  function flush() {
    if (holder.current?.hasContent()) {
      files.push(holder.current.freeze());
    }
    holder.current = null;
  }

  function startFile(rawPath: string) {
    const path = cleanDiffPath(rawPath);
    if (!path || path === '/dev/null') {
      return;
    }
    if (holder.current?.path === path) {
      return;
    }
    flush();
    holder.current = new MutableToolFileChange(path);
  }

  function ensureFile() {
    holder.current ??= new MutableToolFileChange(displayToolName(execution.name));
    return holder.current;
  }

  const diffHeader = /^diff --git\s+a\/(.*?)\s+b\/(.*?)$/;
  const patchHeader = /^\*\*\* (?:Update|Add|Delete) File:\s+(.+)$/;
  const oldHeader = /^---\s+(.+)$/;
  const newHeader = /^\+\+\+\s+(.+)$/;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    const diffMatch = diffHeader.exec(line);
    if (diffMatch) {
      startFile(diffMatch[2] || diffMatch[1] || '');
      continue;
    }
    const patchMatch = patchHeader.exec(line);
    if (patchMatch) {
      startFile(patchMatch[1] ?? '');
      continue;
    }
    const oldMatch = oldHeader.exec(line);
    if (oldMatch) {
      if (!holder.current) {
        startFile(oldMatch[1] ?? '');
      }
      continue;
    }
    const newMatch = newHeader.exec(line);
    if (newMatch) {
      const path = cleanDiffPath(newMatch[1] ?? '');
      if (path && path !== '/dev/null') {
        if (!holder.current || holder.current.path === '/dev/null') {
          startFile(path);
        } else {
          holder.current.path = path;
        }
      }
      continue;
    }
    if (line.startsWith('@@')) {
      const file = ensureFile();
      file.diffLines.push(line);
      file.lines.push({ kind: 'hunk', text: line });
      continue;
    }
    if (line.startsWith('+')) {
      const file = ensureFile();
      file.additions += 1;
      file.diffLines.push(line);
      file.lines.push({ kind: 'addition', text: line });
      continue;
    }
    if (line.startsWith('-')) {
      const file = ensureFile();
      file.deletions += 1;
      file.diffLines.push(line);
      file.lines.push({ kind: 'deletion', text: line });
      continue;
    }
    if (rawLine.startsWith(' ') && holder.current) {
      holder.current.diffLines.push(rawLine.trimEnd());
      holder.current.lines.push({ kind: 'context', text: rawLine.trimEnd() });
    }
  }
  flush();
  return {
    files,
    fallbackAdditions: fallback.additions,
    fallbackDeletions: fallback.deletions,
  };
}

function parseToolFileChangeMetadata(
  execution: ChatToolExecution,
): ParsedToolFileChange | null {
  const metadata = execution.metadata;
  if (String(metadata.kind ?? '').trim() !== 'file_change') {
    return null;
  }
  const filesRaw = Array.isArray(metadata.files) ? metadata.files : [];
  const files: ToolFileChange[] = [];
  for (const rawFile of filesRaw) {
    const fileMap = asRecord(rawFile);
    const path = cleanDiffPath(String(fileMap.path ?? ''));
    if (!path) {
      continue;
    }
    let additions = metadataInt(fileMap.additions);
    let deletions = metadataInt(fileMap.deletions);
    const lines = diffLinesFromText(String(fileMap.diff ?? ''));
    if (additions === 0 && deletions === 0 && lines.length > 0) {
      additions = lines.filter((line) => line.kind === 'addition').length;
      deletions = lines.filter((line) => line.kind === 'deletion').length;
    }
    files.push({
      path,
      additions,
      deletions,
      diff: normalizeDiffText(String(fileMap.diff ?? '')),
      lines,
    });
  }
  return {
    files,
    fallbackAdditions: metadataInt(metadata.additions),
    fallbackDeletions: metadataInt(metadata.deletions),
  };
}

function diffLinesFromText(diff: string): DiffLine[] {
  const lines: DiffLine[] = [];
  for (const rawLine of diff.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')) {
    const line = rawLine.trimEnd();
    if (!line || line.startsWith('+++') || line.startsWith('---')) {
      continue;
    }
    if (line.startsWith('@@')) {
      lines.push({ kind: 'hunk', text: line });
    } else if (line.startsWith('+')) {
      lines.push({ kind: 'addition', text: line });
    } else if (line.startsWith('-')) {
      lines.push({ kind: 'deletion', text: line });
    } else if (line.startsWith(' ')) {
      lines.push({ kind: 'context', text: line });
    }
  }
  return lines;
}

function normalizeDiffText(diff: string) {
  return diff.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
}

class MutableToolFileChange {
  path: string;
  additions = 0;
  deletions = 0;
  diffLines: string[] = [];
  lines: DiffLine[] = [];

  constructor(path: string) {
    this.path = path;
  }

  hasContent() {
    return this.additions > 0 || this.deletions > 0 || this.lines.length > 0;
  }

  freeze(): ToolFileChange {
    return {
      path: this.path,
      additions: this.additions,
      deletions: this.deletions,
      diff: normalizeDiffText(this.diffLines.join('\n')),
      lines: [...this.lines],
    };
  }
}

function mergeToolFileChanges(files: ToolFileChange[]) {
  const byPath = new Map<string, MutableToolFileChange>();
  for (const file of files) {
    let target = byPath.get(file.path);
    if (!target) {
      target = new MutableToolFileChange(file.path);
      byPath.set(file.path, target);
    }
    target.additions += file.additions;
    target.deletions += file.deletions;
    if (file.diff.trim()) {
      target.diffLines.push(file.diff.trimEnd());
    }
    target.lines.push(...file.lines);
  }
  return [...byPath.values()].map((item) => item.freeze());
}

function parseFallbackChangeCounts(text: string) {
  const compact = /\+(\d+)\s+-([0-9]+)/.exec(text);
  if (compact) {
    return {
      additions: Number.parseInt(compact[1] ?? '', 10) || 0,
      deletions: Number.parseInt(compact[2] ?? '', 10) || 0,
    };
  }
  const insertions = /(\d+)\s+insertions?\(\+\)/.exec(text);
  const deletions = /(\d+)\s+deletions?\(-\)/.exec(text);
  return {
    additions: Number.parseInt(insertions?.[1] ?? '', 10) || 0,
    deletions: Number.parseInt(deletions?.[1] ?? '', 10) || 0,
  };
}

function cleanDiffPath(raw: string) {
  let pathValue = raw.trim();
  const tabIndex = pathValue.indexOf('\t');
  if (tabIndex >= 0) {
    pathValue = pathValue.slice(0, tabIndex);
  }
  if (pathValue.startsWith('"') && pathValue.endsWith('"') && pathValue.length > 1) {
    pathValue = pathValue.slice(1, -1);
  }
  if (pathValue.startsWith('a/') || pathValue.startsWith('b/')) {
    pathValue = pathValue.slice(2);
  }
  return pathValue.trim();
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

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function displayToolName(value: string) {
  let text = value.trim();
  if (!text) {
    return 'Tool';
  }
  for (const separator of [':', '.', '/']) {
    if (text.includes(separator)) {
      text = text.split(separator).pop() ?? text;
    }
  }
  if (text === 'shell_command' || text === 'terminal_exec') {
    return 'Shell';
  }
  return text;
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
  messageCreatedAt,
  now,
  language,
}: {
  executions: ChatToolExecution[];
  isActive: boolean;
  messageCreatedAt?: string;
  now: number;
  language: AppLanguage;
}) {
  const parsedCreatedAt = Date.parse(messageCreatedAt || new Date(now).toISOString());
  const elapsedMs = isActive
    ? Number.isFinite(parsedCreatedAt)
      ? Math.max(0, now - parsedCreatedAt)
      : 0
    : executions.reduce((total, execution) => total + Math.max(0, execution.durationMs), 0);
  const duration = formatCompactDuration(elapsedMs);
  if (language === 'zh') {
    return duration ? `已处理 ${duration}` : '已处理';
  }
  return duration ? `Processed ${duration}` : 'Processed';
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
        <label>
          <span>{language === 'zh' ? '处理方式' : 'Mode'}</span>
          <select
            value={mode}
            onChange={(event) => setMode(event.currentTarget.value as GuidanceMode)}
          >
            <option value="append_context">
              {language === 'zh' ? '插入当前回合' : 'Append to current turn'}
            </option>
            <option value="interrupt_and_continue">
              {language === 'zh' ? '中断并继续' : 'Interrupt and continue'}
            </option>
          </select>
        </label>
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

function splitMessageImages(content: string) {
  const imagePaths: string[] = [];
  const textLines: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const pathValue = imagePathFromMessageLine(line);
    if (pathValue) {
      imagePaths.push(pathValue);
    } else {
      textLines.push(line);
    }
  }
  return {
    imagePaths,
    text: textLines.join('\n').trim(),
  };
}

function imagePathFromMessageLine(value: string) {
  const trimmed = value.trim();
  const pathValue = stripWrappingQuotes(
    trimmed.startsWith('@') ? trimmed.slice(1).trim() : trimmed,
  );
  if (!isAbsoluteLocalPath(pathValue) && !/^file:\/\//i.test(pathValue)) {
    return '';
  }
  return isImagePath(pathValue) ? pathValue : '';
}

function stripWrappingQuotes(value: string) {
  const trimmed = value.trim();
  if (trimmed.length < 2) {
    return trimmed;
  }
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if (
    (first === '"' && last === '"') ||
    (first === "'" && last === "'") ||
    (first === '`' && last === '`')
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function isAbsoluteLocalPath(value: string) {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\') || value.startsWith('/');
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
  hideCardbushForScreenshot,
  onModelChange,
  onSend,
  onCancel,
  messages = [],
  skills = [],
  activeProjectDir,
  projectContext = '',
  onQuickLoad,
  onSaveProjectContext,
  onConfigureModels,
  onCreateConversation,
  onOpenTerminalConsole,
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
  hideCardbushForScreenshot: boolean;
  onModelChange: (value: string) => void;
  onSend: (text: string) => Promise<void>;
  onCancel: () => Promise<void>;
  messages?: ChatMessage[];
  skills?: SkillSummary[];
  activeProjectDir?: string;
  projectContext?: string;
  onQuickLoad?: (payload: QuickLoadPayload) => void;
  onSaveProjectContext?: (value: string) => Promise<string>;
  onConfigureModels: () => void;
  onCreateConversation?: () => void;
  onOpenTerminalConsole?: () => void;
}) {
  const composerStackRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [activeMenu, setActiveMenu] = useState<ComposerMenu>(null);
  const [commandState, setCommandState] = useState<ComposerCommandState | null>(null);
  const [commandIndex, setCommandIndex] = useState(0);
  const [hideForScreenshot, setHideForScreenshot] = useState(
    hideCardbushForScreenshot,
  );
  const [screenshotBusy, setScreenshotBusy] = useState(false);
  const [screenshotError, setScreenshotError] = useState('');
  const [editingScreenshot, setEditingScreenshot] =
    useState<ScreenshotCaptureResult | null>(null);
  const [imageAttachments, setImageAttachments] = useState<ComposerImageAttachment[]>([]);
  const [previewImage, setPreviewImage] = useState<ImagePreview | null>(null);
  const [mentionFileResults, setMentionFileResults] = useState<ProjectFileSearchResult[]>([]);
  const [mentionSearchBusy, setMentionSearchBusy] = useState(false);
  const hasContent = draft.trim().length > 0 || imageAttachments.length > 0;

  useEffect(() => {
    setHideForScreenshot(hideCardbushForScreenshot);
  }, [hideCardbushForScreenshot]);

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

  const captureScreenshot = useCallback(async (options?: { forceHideWindow?: boolean }) => {
    if (screenshotBusy) {
      return;
    }
    if (!window.cardbushDesktop?.captureScreenshot) {
      setScreenshotError(
        language === 'zh'
          ? '当前环境没有 Electron 截图接口'
          : 'Screenshot API is not available in this runtime',
      );
      return;
    }
    setScreenshotBusy(true);
    setScreenshotError('');
    setActiveMenu(null);
    setCommandState(null);
    try {
      const screenshot = await window.cardbushDesktop.captureScreenshot({
        hideWindow: options?.forceHideWindow ?? hideForScreenshot,
      });
      setEditingScreenshot(screenshot);
    } catch (error) {
      setScreenshotError(error instanceof Error ? error.message : String(error));
    } finally {
      setScreenshotBusy(false);
    }
  }, [draft, hideForScreenshot, language, onDraftChange, screenshotBusy]);

  useEffect(() => {
    return window.cardbushDesktop?.onScreenshotShortcut?.(() => {
      void captureScreenshot({ forceHideWindow: true });
    });
  }, [captureScreenshot]);

  useEffect(() => {
    document.body.classList.toggle(
      'screenshot-tool-active',
      screenshotBusy || editingScreenshot != null,
    );
    return () => document.body.classList.remove('screenshot-tool-active');
  }, [editingScreenshot, screenshotBusy]);

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

  function insertScreenshotPath(path: string) {
    setImageAttachments((current) => [...current, imageAttachmentFromPath(path)]);
  }

  async function pasteImages(event: React.ClipboardEvent<HTMLDivElement>) {
    const files = [...event.clipboardData.files].filter((file) =>
      file.type.startsWith('image/'),
    );
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    if (!window.cardbushDesktop?.saveScreenshotDataUrl) {
      setScreenshotError(
        language === 'zh'
          ? '当前环境无法保存剪贴板图片'
          : 'Cannot save clipboard images in this runtime',
      );
      return;
    }
    try {
      const saved = await Promise.all(
        files.map(async (file) => {
          const dataUrl = await readFileAsDataUrl(file);
          const result = await window.cardbushDesktop!.saveScreenshotDataUrl(
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
      setScreenshotError('');
    } catch (caught) {
      setScreenshotError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function selectModel(model: string) {
    onModelChange(model);
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
          icon: <Bot size={16} />,
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
          icon: <Bot size={16} />,
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
          icon: <Bot size={16} />,
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
          id: '/screenshot',
          title: '/screenshot',
          subtitle:
            language === 'zh'
              ? '启动截图并作为图片附件'
              : 'Capture a screenshot and attach it',
          icon: <Image size={16} />,
          run: () => void captureScreenshot(),
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
      captureScreenshot,
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
    <div className={`composer-stack ${compact ? 'compact' : ''}`} ref={composerStackRef}>
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
      {screenshotBusy && !editingScreenshot && (
        <ScreenshotCaptureBackdrop language={language} />
      )}
      {activeMenu && (
        <ComposerPopover
          menu={activeMenu}
          language={language}
          messages={messages}
          skills={skills}
            selectedModel={selectedModel}
            availableModels={availableModels}
            activeProjectDir={activeProjectDir}
          projectContext={projectContext}
          hideForScreenshot={hideForScreenshot}
          onHideForScreenshotChange={setHideForScreenshot}
          screenshotBusy={screenshotBusy}
          screenshotError={screenshotError}
          onLoad={loadPayload}
          onCaptureScreenshot={captureScreenshot}
          onSaveProjectContext={onSaveProjectContext}
          onSelectModel={selectModel}
          onConfigureModels={onConfigureModels}
          onClose={() => setActiveMenu(null)}
        />
      )}
      {editingScreenshot && (
        <ScreenshotEditorDialog
          language={language}
          screenshot={editingScreenshot}
          onCancel={() => setEditingScreenshot(null)}
          onComplete={(savedPath) => {
            insertScreenshotPath(savedPath);
            setEditingScreenshot(null);
          }}
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
          rows={1}
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
              icon={<Image size={15} />}
              label={language === 'zh' ? '截图 Alt+A' : 'Screenshot'}
              active={activeMenu === 'screenshot'}
              menuTrigger
              onClick={() => toggleMenu('screenshot')}
            />
            <ToolChip
              icon={<Puzzle size={15} />}
              label="Skills"
              active={activeMenu === 'skills'}
              menuTrigger
              onClick={() => toggleMenu('skills')}
            />
          </div>
          <div className="composer-actions">
            <button
              className="model-select"
              type="button"
              data-composer-menu-trigger="true"
              onClick={() => {
                if (!hasConfiguredModels) {
                  onConfigureModels();
                  return;
                }
                toggleMenu('models');
              }}
            >
              {modelLabel}
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

function ScreenshotCaptureBackdrop({ language }: { language: AppLanguage }) {
  return (
    <div className="screenshot-capture-backdrop">
      <section className="screenshot-capture-card">
        <LoaderCircle size={22} />
        <span>
          {language === 'zh' ? '正在启动截图工具...' : 'Opening screenshot tool...'}
        </span>
      </section>
    </div>
  );
}

function ScreenshotEditorDialog({
  language,
  screenshot,
  onCancel,
  onComplete,
}: {
  language: AppLanguage;
  screenshot: ScreenshotCaptureResult;
  onCancel: () => void;
  onComplete: (path: string) => void;
}) {
  const imageRef = useRef<HTMLImageElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<
    | { kind: 'select'; start: { x: number; y: number } }
    | { kind: 'draw'; index: number }
    | null
  >(null);
  const [active, setActive] = useState<ScreenshotCaptureResult | ScreenshotWindowSource>(
    screenshot,
  );
  const [selection, setSelection] = useState<ScreenshotSelection | null>(null);
  const [mode, setMode] = useState<'select' | 'draw'>('select');
  const [strokes, setStrokes] = useState<ScreenshotStroke[]>([]);
  const [overlayStyle, setOverlayStyle] = useState<CSSProperties>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const sourceDataUrl = active.dataUrl || fileUrl(active.path);

  useEffect(() => {
    setActive(screenshot);
    setSelection(null);
    setStrokes([]);
    setMode('select');
    setError('');
  }, [screenshot]);

  const updateOverlayBounds = useCallback(() => {
    const image = imageRef.current;
    const shell = shellRef.current;
    if (!image || !shell) {
      return;
    }
    const imageRect = image.getBoundingClientRect();
    const shellRect = shell.getBoundingClientRect();
    setOverlayStyle({
      left: imageRect.left - shellRect.left + shell.scrollLeft,
      top: imageRect.top - shellRect.top + shell.scrollTop,
      width: imageRect.width,
      height: imageRect.height,
    });
  }, []);

  useEffect(() => {
    const image = imageRef.current;
    if (!image) {
      return undefined;
    }
    const observer = new ResizeObserver(updateOverlayBounds);
    observer.observe(image);
    updateOverlayBounds();
    window.addEventListener('resize', updateOverlayBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateOverlayBounds);
    };
  }, [active, updateOverlayBounds]);

  function pointFromEvent(event: React.PointerEvent<HTMLElement>) {
    const image = imageRef.current;
    if (!image) {
      return { x: 0, y: 0 };
    }
    const rect = image.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * active.width;
    const y = ((event.clientY - rect.top) / rect.height) * active.height;
    return {
      x: Math.max(0, Math.min(active.width, x)),
      y: Math.max(0, Math.min(active.height, y)),
    };
  }

  function beginEdit(event: React.PointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const point = pointFromEvent(event);
    if (mode === 'draw') {
      const index = strokes.length;
      dragRef.current = { kind: 'draw', index };
      setStrokes((current) => [...current, [point]]);
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    dragRef.current = { kind: 'select', start: point };
    setSelection({ x: point.x, y: point.y, width: 0, height: 0 });
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function continueEdit(event: React.PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    const point = pointFromEvent(event);
    if (drag.kind === 'draw') {
      setStrokes((current) =>
        current.map((stroke, index) =>
          index === drag.index ? [...stroke, point] : stroke,
        ),
      );
      return;
    }
    setSelection(normalizeSelection(drag.start, point));
  }

  function finishEdit(event: React.PointerEvent<HTMLDivElement>) {
    if (!dragRef.current) {
      return;
    }
    dragRef.current = null;
    event.currentTarget.releasePointerCapture(event.pointerId);
  }

  async function saveEdited() {
    setSaving(true);
    setError('');
    try {
      const dataUrl = await renderEditedScreenshot(sourceDataUrl, active, selection, strokes);
      const saved = await window.cardbushDesktop?.saveScreenshotDataUrl?.(
        dataUrl,
        'cardbush-screenshot-edited',
      );
      onComplete(saved?.path ?? active.path);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop screenshot-editor-backdrop">
      <section className="screenshot-editor">
        <header>
          <Image size={18} />
          <strong>{language === 'zh' ? '编辑截图' : 'Edit screenshot'}</strong>
          <button type="button" onClick={onCancel}>
            <X size={16} />
          </button>
        </header>
        <div className="screenshot-editor-body">
          <aside className="screenshot-editor-tools">
            <button
              className={mode === 'select' ? 'active' : ''}
              type="button"
              onClick={() => setMode('select')}
            >
              <Image size={15} />
              {language === 'zh' ? '框选裁剪' : 'Crop'}
            </button>
            <button
              className={mode === 'draw' ? 'active' : ''}
              type="button"
              onClick={() => setMode('draw')}
            >
              <Edit3 size={15} />
              {language === 'zh' ? '标注' : 'Draw'}
            </button>
            <button type="button" onClick={() => setSelection(null)}>
              <RotateCcw size={15} />
              {language === 'zh' ? '全图' : 'Full image'}
            </button>
            <button type="button" onClick={() => setStrokes([])}>
              <Trash2 size={15} />
              {language === 'zh' ? '清除标注' : 'Clear marks'}
            </button>
            {screenshot.windows && screenshot.windows.length > 0 && (
              <div className="window-source-list">
                <span>{language === 'zh' ? '识别到的窗口' : 'Detected windows'}</span>
                {screenshot.windows.map((source) => (
                  <button
                    type="button"
                    key={source.id}
                    className={active.path === source.path ? 'active' : ''}
                    onClick={() => {
                      setActive(source);
                      setSelection(null);
                      setStrokes([]);
                    }}
                  >
                    <Monitor size={14} />
                    <span>{source.name}</span>
                  </button>
                ))}
              </div>
            )}
          </aside>
          <div
            ref={shellRef}
            className={`screenshot-canvas-shell ${mode}`}
            onPointerDown={beginEdit}
            onPointerMove={continueEdit}
            onPointerUp={finishEdit}
            onPointerCancel={finishEdit}
          >
            <img
              ref={imageRef}
              src={sourceDataUrl}
              alt=""
              draggable={false}
              onLoad={updateOverlayBounds}
            />
            <ScreenshotSvgOverlay
              active={active}
              selection={selection}
              strokes={strokes}
              style={overlayStyle}
            />
          </div>
        </div>
        <footer>
          <p>
            {language === 'zh'
              ? '拖拽可自由框选；从左侧窗口列表可快速使用识别到的窗口截图。'
              : 'Drag to select a crop; choose a detected window from the left.'}
          </p>
          {error && <span className="popover-error">{error}</span>}
          <button type="button" onClick={onCancel}>
            {language === 'zh' ? '取消' : 'Cancel'}
          </button>
          <button className="primary-button" type="button" onClick={() => void saveEdited()} disabled={saving}>
            {saving ? <LoaderCircle size={14} /> : <CheckCircle2 size={14} />}
            {language === 'zh' ? '完成并插入' : 'Save and insert'}
          </button>
        </footer>
      </section>
    </div>
  );
}

function ScreenshotSvgOverlay({
  active,
  selection,
  strokes,
  style,
}: {
  active: { width: number; height: number };
  selection: ScreenshotSelection | null;
  strokes: ScreenshotStroke[];
  style: CSSProperties;
}) {
  return (
    <svg style={style} viewBox={`0 0 ${active.width} ${active.height}`} preserveAspectRatio="none">
      {selection && selection.width > 2 && selection.height > 2 && (
        <>
          <rect className="screenshot-mask" x="0" y="0" width={active.width} height={active.height} />
          <rect
            className="screenshot-selection"
            x={selection.x}
            y={selection.y}
            width={selection.width}
            height={selection.height}
          />
        </>
      )}
      {strokes.map((stroke, index) => (
        <polyline
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          className="screenshot-stroke"
          points={stroke.map((point) => `${point.x},${point.y}`).join(' ')}
        />
      ))}
    </svg>
  );
}

function normalizeSelection(
  start: { x: number; y: number },
  end: { x: number; y: number },
): ScreenshotSelection {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    x,
    y,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

async function renderEditedScreenshot(
  source: string,
  active: { width: number; height: number },
  selection: ScreenshotSelection | null,
  strokes: ScreenshotStroke[],
) {
  const image = await loadImage(source);
  const crop =
    selection && selection.width > 2 && selection.height > 2
      ? selection
      : { x: 0, y: 0, width: active.width, height: active.height };
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(crop.width));
  canvas.height = Math.max(1, Math.round(crop.height));
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Canvas is not available');
  }
  context.drawImage(
    image,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  context.lineWidth = Math.max(2, Math.round(Math.min(canvas.width, canvas.height) / 180));
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.strokeStyle = '#ff5d5d';
  for (const stroke of strokes) {
    const visible = stroke
      .map((point) => ({ x: point.x - crop.x, y: point.y - crop.y }))
      .filter((point) => point.x >= 0 && point.y >= 0 && point.x <= crop.width && point.y <= crop.height);
    if (visible.length < 2) {
      continue;
    }
    context.beginPath();
    context.moveTo(visible[0].x, visible[0].y);
    for (const point of visible.slice(1)) {
      context.lineTo(point.x, point.y);
    }
    context.stroke();
  }
  return canvas.toDataURL('image/png');
}

function loadImage(source: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Screenshot image failed to load'));
    image.src = source;
  });
}

function ComposerPopover({
  menu,
  language,
  messages,
  skills,
  selectedModel,
  availableModels,
  activeProjectDir,
  projectContext,
  hideForScreenshot,
  onHideForScreenshotChange,
  screenshotBusy,
  screenshotError,
  onLoad,
  onCaptureScreenshot,
  onSaveProjectContext,
  onSelectModel,
  onConfigureModels,
  onClose,
}: {
  menu: Exclude<ComposerMenu, null>;
  language: AppLanguage;
  messages: ChatMessage[];
  skills: SkillSummary[];
  selectedModel: string;
  availableModels: string[];
  activeProjectDir?: string;
  projectContext: string;
  hideForScreenshot: boolean;
  onHideForScreenshotChange: (value: boolean) => void;
  screenshotBusy: boolean;
  screenshotError: string;
  onLoad: (payload: QuickLoadPayload) => void;
  onCaptureScreenshot: () => void;
  onSaveProjectContext?: (value: string) => Promise<string>;
  onSelectModel: (model: string) => void;
  onConfigureModels: () => void;
  onClose: () => void;
}) {
  const content = messages.map((message) => message.content).join('\n');
  const chars = content.length;
  const estimatedTokens = Math.ceil(chars / 4);
  const models = Array.from(new Set([selectedModel, ...availableModels].filter(Boolean)));

  return (
    <div className={`composer-popover ${menu}`}>
      <header>
        <strong>{composerMenuTitle(menu, language)}</strong>
        <button type="button" onClick={onClose} aria-label="close popover">
          <X size={15} />
        </button>
      </header>
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
      {menu === 'screenshot' && (
        <div className="popover-stack">
          <button
            className="popover-row primary"
            type="button"
            onClick={onCaptureScreenshot}
            disabled={screenshotBusy}
          >
            {screenshotBusy ? <LoaderCircle size={16} /> : <Image size={16} />}
            <span>
              <strong>
                {screenshotBusy
                  ? language === 'zh'
                    ? '正在截图...'
                    : 'Capturing...'
                  : language === 'zh'
                    ? '开始截图'
                    : 'Start screenshot'}
              </strong>
              <small>Alt+A</small>
            </span>
          </button>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={hideForScreenshot}
              onChange={(event) => onHideForScreenshotChange(event.target.checked)}
            />
            <span>
              {language === 'zh'
                ? '截图时隐藏 cardbush'
                : 'Hide cardbush while capturing'}
            </span>
          </label>
          <p>
            {language === 'zh'
              ? '截图会保存到图片目录，并把文件路径插入输入框。'
              : 'The screenshot is saved to Pictures and inserted into the composer.'}
          </p>
          {screenshotError && <p className="popover-error">{screenshotError}</p>}
        </div>
      )}
      {menu === 'skills' && (
        <div className="popover-list">
          {skills.map((skill) => (
            <button
              className="popover-row"
              type="button"
              key={skill.name}
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
                <small>{language === 'zh' ? skill.descriptionZh : skill.description}</small>
              </span>
            </button>
          ))}
        </div>
      )}
      {menu === 'models' && (
        <div className="popover-list compact">
          {models.length === 0 ? (
            <button className="popover-row primary" type="button" onClick={onConfigureModels}>
              <Bot size={16} />
              {language === 'zh' ? '待配置，前往模型设置' : 'Configure models'}
            </button>
          ) : (
            models.map((model) => (
              <button
                className={`popover-row ${model === selectedModel ? 'active' : ''}`}
                type="button"
                key={model}
                onClick={() => onSelectModel(model)}
              >
                <Bot size={16} />
                {model}
              </button>
            ))
          )}
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
    screenshot: { zh: '截图', en: 'Screenshot' },
    skills: { zh: 'Skills', en: 'Skills' },
    models: { zh: '模型', en: 'Model' },
  };
  return labels[menu][language];
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
      {section === 'automation' && (
        <AutomationPanel language={language} items={automationTasks} />
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

function AutomationPanel({
  language,
  items,
}: {
  language: AppLanguage;
  items: AutomationTask[];
}) {
  return (
    <div className="feature-content">
      <div className="feature-toolbar">
        <button className="primary-button" type="button">
          <Edit3 size={16} />
          {language === 'zh' ? '新建任务' : 'New task'}
        </button>
        <button className="filter-chip" type="button">
          {language === 'zh' ? '仅运行中' : 'Running only'}
        </button>
      </div>
      <div className="result-stack">
        {items.map((task) => (
          <article className="result-card automation" key={task.id}>
            <Clock3 size={18} />
            <div>
              <h3>{task.title}</h3>
              <p>{task.cadence}</p>
            </div>
            <span className={`status-dot ${task.enabled ? 'on' : ''}`} />
          </article>
        ))}
      </div>
    </div>
  );
}

function SettingsView({
  themePreference,
  lightThemeStyle,
  language,
  languageMode,
  systemLanguage,
  settings,
  selectedModel,
  availableModels,
  initialSection,
  onBack,
  onThemePreferenceChange,
  onLightThemeStyleChange,
  onLanguageModeChange,
  onSettingsChange,
  onUseModel,
  onSidebarWidthChange,
  onConversationHistoryCleared,
}: {
  themePreference: ThemePreference;
  lightThemeStyle: LightThemeStyle;
  language: AppLanguage;
  languageMode: AppLanguageMode;
  systemLanguage: AppLanguage;
  settings: AppSettingsState;
  selectedModel: string;
  availableModels: string[];
  initialSection: SettingsSection;
  onBack: () => void;
  onThemePreferenceChange: (value: ThemePreference) => void;
  onLightThemeStyleChange: (value: LightThemeStyle) => void;
  onLanguageModeChange: (value: AppLanguageMode) => void;
  onSettingsChange: (updater: (current: AppSettingsState) => AppSettingsState) => void;
  onUseModel: (model: string) => void;
  onSidebarWidthChange: (value: number) => void;
  onConversationHistoryCleared?: () => void | Promise<void>;
}) {
  const [section, setSection] = useState<SettingsSection>(initialSection);
  const [providerSelection, setProviderSelection] = useState(
    settings.managedModelConfigs[0]?.provider || suggestedProviders[0],
  );
  const [customProvider, setCustomProvider] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [modelName, setModelName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [toast, setToast] = useState('');
  const providerOptions = useMemo(
    () => collectProviderOptions(settings.managedModelConfigs),
    [settings.managedModelConfigs],
  );

  useEffect(() => {
    setSection(initialSection);
  }, [initialSection]);

  useEffect(() => {
    if (!providerOptions.includes(providerSelection)) {
      setProviderSelection(providerOptions[0] ?? suggestedProviders[0]);
    }
  }, [providerOptions, providerSelection]);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(''), 1800);
  }, []);

  const updateSettings = useCallback(
    (updater: (current: AppSettingsState) => AppSettingsState) => {
      onSettingsChange(updater);
    },
    [onSettingsChange],
  );

  const updateProxy = useCallback(
    (patch: Partial<AppSettingsState['proxy']>) => {
      updateSettings((current) => ({
        ...current,
        proxy: { ...current.proxy, ...patch },
      }));
    },
    [updateSettings],
  );

  const addModelConfig = useCallback(
    (event?: FormEvent) => {
      event?.preventDefault();
      const provider = normalizeProvider(
        providerSelection === customProviderValue ? customProvider : providerSelection,
      );
      const nextModel = modelName.trim();
      if (!provider) {
        notify(language === 'zh' ? '请输入模型商名称' : 'Enter a provider name');
        return;
      }
      if (!nextModel) {
        notify(language === 'zh' ? '请输入模型名称' : 'Enter a model name');
        return;
      }
      updateSettings((current) => ({
        ...current,
        managedModelConfigs: [
          ...current.managedModelConfigs,
          {
            id: newModelConfigId(),
            provider,
            apiKey,
            modelName: nextModel,
            baseUrl,
          },
        ],
      }));
      setProviderSelection(provider);
      setModelName('');
      setBaseUrl('');
      notify(language === 'zh' ? '模型配置已添加' : 'Model configuration added');
    },
    [
      apiKey,
      baseUrl,
      customProvider,
      language,
      modelName,
      notify,
      providerSelection,
      updateSettings,
    ],
  );

  const removeModelConfig = useCallback(
    (id: string) => {
      updateSettings((current) => ({
        ...current,
        managedModelConfigs: current.managedModelConfigs.filter(
          (item) => item.id !== id,
        ),
      }));
    },
    [updateSettings],
  );

  const resetModels = useCallback(() => {
    updateSettings((current) => ({ ...current, managedModelConfigs: [] }));
    onUseModel('');
    notify(language === 'zh' ? '已清空模型配置' : 'Model configurations cleared');
  }, [language, notify, onUseModel, updateSettings]);

  const useModel = useCallback(
    (model: string) => {
      if (!availableModels.includes(model)) {
        notify(
          language === 'zh'
            ? `切换失败：当前模型列表中不存在 ${model}`
            : `Switch failed: ${model} is not in the model list`,
        );
        return;
      }
      onUseModel(model);
      notify(
        language === 'zh'
          ? `已切换当前模型：${model}`
          : `Current model switched: ${model}`,
      );
    },
    [availableModels, language, notify, onUseModel],
  );

  const openDocs = useCallback(
    async (name: string, url: string) => {
      try {
        await window.cardbushDesktop?.openExternal?.(url);
        notify(language === 'zh' ? `已打开 ${name}` : `Opened ${name}`);
      } catch {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    },
    [language, notify],
  );

  const importFont = useCallback(async () => {
    const filePath = await window.cardbushDesktop?.pickFont?.();
    if (!filePath) {
      return;
    }
    const displayName = basename(filePath);
    updateSettings((current) => ({
      ...current,
      font: {
        family: `cardbush-imported-${stableModelConfigId('font', displayName, '', filePath)}`,
        displayName,
        filePath,
      },
    }));
    notify(language === 'zh' ? '字体已导入' : 'Font imported');
  }, [language, notify, updateSettings]);

  const resetFont = useCallback(() => {
    updateSettings((current) => ({
      ...current,
      font: defaultAppSettings.font,
    }));
  }, [updateSettings]);

  const resetCompanionPosition = useCallback(() => {
    window.localStorage.removeItem('cardbush_cardling_position');
    void window.cardbushDesktop?.resetCardlingPosition?.();
    notify(language === 'zh' ? '卡灵位置已重置' : 'Cardling position reset');
  }, [language, notify]);

  const content = (() => {
    if (section === 'profile') {
      return (
        <SettingsProfilePanel
          themePreference={themePreference}
          lightThemeStyle={lightThemeStyle}
          language={language}
          languageMode={languageMode}
          systemLanguage={systemLanguage}
          settings={settings}
          onThemePreferenceChange={onThemePreferenceChange}
          onLightThemeStyleChange={onLightThemeStyleChange}
          onLanguageModeChange={onLanguageModeChange}
          onSettingsChange={updateSettings}
          onImportFont={importFont}
          onResetFont={resetFont}
        />
      );
    }
    if (section === 'companion') {
      return (
        <CompanionSettingsPanel
          language={language}
          settings={settings}
          onSettingsChange={updateSettings}
          onResetCompanionPosition={resetCompanionPosition}
        />
      );
    }
    if (section === 'proxy') {
      return (
        <SettingsCard
          title={language === 'zh' ? '代理设置' : 'Proxy settings'}
          subtitle={
            language === 'zh'
              ? '配置 cardbush 发起网络请求时使用的代理环境。'
              : 'Configure proxy environment values used by cardbush network requests.'
          }
        >
          <SettingsSwitch
            title={language === 'zh' ? '跟随系统代理' : 'Follow system proxy'}
            subtitle={
              language === 'zh'
                ? '开启后禁用手动 HTTP_PROXY / HTTPS_PROXY / NO_PROXY 输入。'
                : 'Disables manual HTTP_PROXY / HTTPS_PROXY / NO_PROXY fields.'
            }
            checked={settings.proxy.mode === 'system'}
            onChange={(checked) =>
              updateProxy({ mode: checked ? 'system' : 'manual' })
            }
          />
          <SettingsDivider />
          <SettingsInput
            label="HTTP_PROXY"
            value={settings.proxy.httpProxy}
            disabled={settings.proxy.mode === 'system'}
            placeholder="127.0.0.1:7890 或 http://127.0.0.1:7890"
            onChange={(value) => updateProxy({ httpProxy: value })}
          />
          <SettingsInput
            label="HTTPS_PROXY"
            value={settings.proxy.httpsProxy}
            disabled={settings.proxy.mode === 'system'}
            placeholder="127.0.0.1:7890 或 http://127.0.0.1:7890"
            onChange={(value) => updateProxy({ httpsProxy: value })}
          />
          <SettingsInput
            label="NO_PROXY"
            value={settings.proxy.noProxy}
            disabled={settings.proxy.mode === 'system'}
            placeholder="127.0.0.1,localhost,::1,.internal"
            onChange={(value) => updateProxy({ noProxy: value })}
          />
        </SettingsCard>
      );
    }
    if (section === 'models') {
      return (
        <ModelsSettingsPanel
          language={language}
          settings={settings}
          selectedModel={selectedModel}
          providerOptions={providerOptions}
          providerSelection={providerSelection}
          customProvider={customProvider}
          apiKey={apiKey}
          modelName={modelName}
          baseUrl={baseUrl}
          showApiKey={showApiKey}
          onProviderSelectionChange={setProviderSelection}
          onCustomProviderChange={setCustomProvider}
          onApiKeyChange={setApiKey}
          onModelNameChange={setModelName}
          onBaseUrlChange={setBaseUrl}
          onShowApiKeyChange={setShowApiKey}
          onAddModelConfig={addModelConfig}
          onResetModels={resetModels}
          onRemoveModelConfig={removeModelConfig}
          onUseModel={useModel}
          onOpenDocs={openDocs}
        />
      );
    }
    if (section === 'bots') {
      return <BotSettingsPanel language={language} />;
    }
    if (section === 'cache') {
      return (
        <CacheMaintenancePanel
          language={language}
          onNotify={notify}
          onConversationHistoryCleared={onConversationHistoryCleared}
        />
      );
    }
    if (section === 'diagnostics') {
      return (
        <DiagnosticsPanel
          language={language}
          settings={settings}
          selectedModel={selectedModel}
        />
      );
    }
    if (section === 'mobile') {
      return <MobileSettingsPanel language={language} />;
    }
    return <AboutSettingsPanel language={language} />;
  })();

  return (
    <main className="settings-shell">
      <aside className="settings-sidebar">
        <button className="back-button" type="button" onClick={onBack}>
          <ArrowLeft size={18} />
          {language === 'zh' ? '返回应用' : 'Back to app'}
        </button>
        {(Object.keys(settingsLabels) as SettingsSection[]).map((id) => {
          const Icon = settingsIcons[id];
          return (
            <button
              key={id}
              className={`settings-nav ${section === id ? 'active' : ''}`}
              type="button"
              onClick={() => setSection(id)}
            >
              <Icon size={18} />
              {settingsLabels[id][language]}
            </button>
          );
        })}
      </aside>
      <SidebarResizer language={language} onWidthChange={onSidebarWidthChange} />
      <section className="settings-content">
        <div className="settings-track">
          <h2>{settingsLabels[section][language]}</h2>
          <p>
            {language === 'zh'
              ? '配置 cardbush 的外观、网络、模型和连接能力。'
              : 'Configure cardbush appearance, network, models, and connection features.'}
          </p>
          {content}
        </div>
      </section>
      {toast && <div className="settings-toast">{toast}</div>}
    </main>
  );
}

function SettingsProfilePanel({
  themePreference,
  lightThemeStyle,
  language,
  languageMode,
  systemLanguage,
  settings,
  onThemePreferenceChange,
  onLightThemeStyleChange,
  onLanguageModeChange,
  onSettingsChange,
  onImportFont,
  onResetFont,
}: {
  themePreference: ThemePreference;
  lightThemeStyle: LightThemeStyle;
  language: AppLanguage;
  languageMode: AppLanguageMode;
  systemLanguage: AppLanguage;
  settings: AppSettingsState;
  onThemePreferenceChange: (value: ThemePreference) => void;
  onLightThemeStyleChange: (value: LightThemeStyle) => void;
  onLanguageModeChange: (value: AppLanguageMode) => void;
  onSettingsChange: (updater: (current: AppSettingsState) => AppSettingsState) => void;
  onImportFont: () => void;
  onResetFont: () => void;
}) {
  const fontIsCustom = Boolean(settings.font.family && settings.font.filePath);

  return (
    <SettingsCard
      title={language === 'zh' ? '外观' : 'Appearance'}
      subtitle={
        language === 'zh'
          ? '配置主题、语言和全局字体。'
          : 'Configure theme, language, and global font.'
      }
    >
      <SettingsGroupTitle>
        {language === 'zh' ? '显示模式' : 'Display mode'}
      </SettingsGroupTitle>
      <SettingsRadio
        name="theme-mode"
        title={language === 'zh' ? '跟随系统' : 'Follow system'}
        value="system"
        checked={themePreference === 'system'}
        onChange={() => onThemePreferenceChange('system')}
      />
      <SettingsRadio
        name="theme-mode"
        title={language === 'zh' ? '浅色模式' : 'Light mode'}
        subtitle={
          language === 'zh'
            ? '使用下面选择的浅色外观。'
            : 'Uses the selected light appearance below.'
        }
        value="light"
        checked={themePreference === 'light'}
        onChange={() => onThemePreferenceChange('light')}
      />
      <SettingsRadio
        name="theme-mode"
        title={language === 'zh' ? '深色主题' : 'Dark theme'}
        value="dark"
        checked={themePreference === 'dark'}
        onChange={() => onThemePreferenceChange('dark')}
      />
      <SettingsDivider />
      <SettingsGroupTitle>
        {language === 'zh' ? '应用语言' : 'App language'}
      </SettingsGroupTitle>
      <SettingsRadio
        name="language-mode"
        title={language === 'zh' ? '跟随系统' : 'Follow system'}
        subtitle={
          language === 'zh'
            ? `当前检测：${systemLanguage === 'zh' ? '中文' : 'English'}`
            : `Detected: ${systemLanguage === 'zh' ? 'Chinese' : 'English'}`
        }
        value="system"
        checked={languageMode === 'system'}
        onChange={() => onLanguageModeChange('system')}
      />
      <SettingsRadio
        name="language-mode"
        title="中文"
        subtitle={language === 'zh' ? '固定使用中文界面' : 'Use Chinese UI'}
        value="zh"
        checked={languageMode === 'zh'}
        onChange={() => onLanguageModeChange('zh')}
      />
      <SettingsRadio
        name="language-mode"
        title="English"
        subtitle={
          language === 'zh' ? '固定使用英文界面' : 'Use English UI'
        }
        value="en"
        checked={languageMode === 'en'}
        onChange={() => onLanguageModeChange('en')}
      />
      <SettingsDivider />
      <SettingsGroupTitle>
        {language === 'zh' ? '浅色外观' : 'Light appearance'}
      </SettingsGroupTitle>
      <SettingsRadio
        name="light-style"
        title={language === 'zh' ? '羊皮纸' : 'Parchment'}
            subtitle={
              language === 'zh'
                ? '使用温暖的纸感浅色外观。'
                : 'Uses the warmer parchment light appearance.'
            }
        value="parchment"
        checked={lightThemeStyle === 'parchment'}
        onChange={() => onLightThemeStyleChange('parchment')}
      />
      <SettingsRadio
        name="light-style"
        title={language === 'zh' ? '明亮' : 'Bright'}
        subtitle={
          language === 'zh'
            ? '更接近系统原生的白色界面。'
            : 'A cleaner white desktop surface.'
        }
        value="bright"
        checked={lightThemeStyle === 'bright'}
        onChange={() => onLightThemeStyleChange('bright')}
      />
      <SettingsDivider />
      <SettingsGroupTitle>
        {language === 'zh' ? '全局字体' : 'Global font'}
      </SettingsGroupTitle>
      <div className="font-preview">
        <strong>
          {fontIsCustom
            ? settings.font.displayName
            : language === 'zh'
              ? '系统默认字体'
              : 'System default font'}
        </strong>
        <span>
          {fontIsCustom
            ? settings.font.filePath
            : language === 'zh'
              ? 'Windows 使用 Microsoft YaHei UI，macOS 使用 PingFang SC。'
              : 'Uses Microsoft YaHei UI on Windows and PingFang SC on macOS.'}
        </span>
        <p>
          {language === 'zh'
            ? '你好，cardbush  Aa 123  轻快地处理项目、对话和代码。'
            : 'Hello, cardbush  Aa 123  Handling projects, chats, and code with ease.'}
        </p>
      </div>
      <div className="settings-actions">
        <button className="secondary-button" type="button" onClick={onImportFont}>
          <Upload size={14} />
          {language === 'zh' ? '导入字体配置' : 'Import font'}
        </button>
        <button
          className="secondary-button"
          type="button"
          disabled={!fontIsCustom}
          onClick={onResetFont}
        >
          <RotateCcw size={14} />
          {language === 'zh' ? '恢复默认字体' : 'Reset default font'}
        </button>
      </div>
      <SettingsDivider />
      <SettingsSwitch
        title={language === 'zh' ? '截图时隐藏 cardbush' : 'Hide cardbush for screenshots'}
        subtitle={
          language === 'zh'
            ? '截图按钮会在捕获前暂时隐藏主窗口。'
            : 'The screenshot button temporarily hides the main window before capture.'
        }
        checked={settings.hideCardbushForScreenshot}
        onChange={(checked) =>
          onSettingsChange((current) => ({
            ...current,
            hideCardbushForScreenshot: checked,
          }))
        }
      />
    </SettingsCard>
  );
}

function CompanionSettingsPanel({
  language,
  settings,
  onSettingsChange,
  onResetCompanionPosition,
}: {
  language: AppLanguage;
  settings: AppSettingsState;
  onSettingsChange: (updater: (current: AppSettingsState) => AppSettingsState) => void;
  onResetCompanionPosition: () => void;
}) {
  const updateCompanion = useCallback(
    (patch: Partial<CompanionSettings>) => {
      onSettingsChange((current) => ({
        ...current,
        companion: normalizeCompanionSettings({
          ...current.companion,
          ...patch,
        }),
      }));
    },
    [onSettingsChange],
  );
  return (
    <div className="settings-stack">
      <SettingsCard
        title={language === 'zh' ? '卡灵状态助手' : 'Cardling companion'}
        subtitle={
          language === 'zh'
            ? '配置卡灵在桌面上的显示、动效和停靠行为。'
            : 'Configure Cardling display, motion, and dock behavior.'
        }
      >
        <div
          className="companion-preview"
          data-motion={settings.companion.motion}
          style={
            {
              '--cardling-scale': String(companionSizeScale(settings.companion.size)),
              '--cardling-opacity': String(settings.companion.opacity),
            } as CSSProperties
          }
        >
          <div className="cardling-badge companion-preview-stage" data-status="idle">
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
          </div>
          <div>
            <strong>{language === 'zh' ? 'Cardling / 卡灵' : 'Cardling'}</strong>
            <span>
              {language === 'zh'
                ? '轻量、可拖拽、跟随对话状态。'
                : 'Lightweight, draggable, and tied to chat state.'}
            </span>
          </div>
        </div>
        <SettingsSwitch
          title={language === 'zh' ? '显示卡灵' : 'Show Cardling'}
          subtitle={
            language === 'zh'
              ? '关闭后隐藏聊天界面的卡灵入口，但保留现有偏好。'
              : 'Hides Cardling in chat while keeping current preferences.'
          }
          checked={settings.companionEnabled}
          onChange={(checked) =>
            onSettingsChange((current) => ({
              ...current,
              companionEnabled: checked,
            }))
          }
        />
        <SettingsDivider />
        <SettingsGroupTitle>
          {language === 'zh' ? '形态' : 'Shape'}
        </SettingsGroupTitle>
        <SettingsRadio
          name="companion-size"
          title={language === 'zh' ? '小号' : 'Compact'}
          subtitle={language === 'zh' ? '更适合小屏或窄窗口。' : 'Better for small screens or narrow windows.'}
          value="compact"
          checked={settings.companion.size === 'compact'}
          onChange={() => updateCompanion({ size: 'compact' })}
        />
        <SettingsRadio
          name="companion-size"
          title={language === 'zh' ? '标准' : 'Standard'}
          value="normal"
          checked={settings.companion.size === 'normal'}
          onChange={() => updateCompanion({ size: 'normal' })}
        />
        <SettingsRadio
          name="companion-size"
          title={language === 'zh' ? '大号' : 'Large'}
          subtitle={language === 'zh' ? '状态更醒目，但占用更多边缘空间。' : 'More visible, with more edge space.'}
          value="large"
          checked={settings.companion.size === 'large'}
          onChange={() => updateCompanion({ size: 'large' })}
        />
        <SettingsRange
          label={language === 'zh' ? '透明度' : 'Opacity'}
          value={Math.round(settings.companion.opacity * 100)}
          min={55}
          max={100}
          step={5}
          suffix="%"
          onChange={(value) => updateCompanion({ opacity: value / 100 })}
        />
      </SettingsCard>
      <SettingsCard
        title={language === 'zh' ? '动效与位置' : 'Motion and position'}
        subtitle={
          language === 'zh'
            ? '控制卡灵的循环动画、反馈强度和停靠位置。'
            : 'Control Cardling loops, feedback intensity, and dock position.'
        }
      >
        <SettingsRadio
          name="companion-motion"
          title={language === 'zh' ? '完整动效' : 'Full motion'}
          subtitle={language === 'zh' ? '保留呼吸、扫描和完成反馈。' : 'Keeps breathing, scan, and completion feedback.'}
          value="full"
          checked={settings.companion.motion === 'full'}
          onChange={() => updateCompanion({ motion: 'full' })}
        />
        <SettingsRadio
          name="companion-motion"
          title={language === 'zh' ? '轻动效' : 'Reduced motion'}
          subtitle={language === 'zh' ? '减少工具运行和等待状态的循环动画。' : 'Reduces tool and waiting loops.'}
          value="reduced"
          checked={settings.companion.motion === 'reduced'}
          onChange={() => updateCompanion({ motion: 'reduced' })}
        />
        <SettingsRadio
          name="companion-motion"
          title={language === 'zh' ? '关闭动效' : 'Motion off'}
          value="off"
          checked={settings.companion.motion === 'off'}
          onChange={() => updateCompanion({ motion: 'off' })}
        />
        <div className="settings-actions">
          <button className="secondary-button" type="button" onClick={onResetCompanionPosition}>
            <RotateCcw size={14} />
            {language === 'zh' ? '重置卡灵位置' : 'Reset Cardling position'}
          </button>
        </div>
      </SettingsCard>
      <SettingsCard
        title={language === 'zh' ? '状态事件表' : 'Status event map'}
        subtitle={
          language === 'zh'
            ? '卡灵只反映产品状态，不替代主流程操作。'
            : 'Cardling reflects product state without replacing primary workflows.'
        }
      >
        <div className="companion-event-table">
          {companionEventRows(language).map((row) => (
            <div className="companion-event-row" key={row.status}>
              <b>{row.status}</b>
              <span>{row.trigger}</span>
              <em>{row.visual}</em>
            </div>
          ))}
        </div>
      </SettingsCard>
    </div>
  );
}

function companionEventRows(language: AppLanguage) {
  return [
    {
      status: 'idle',
      trigger: language === 'zh' ? '没有运行中的回复或工具' : 'No active reply or tool',
      visual: language === 'zh' ? '慢呼吸' : 'slow breathing',
    },
    {
      status: 'thinking',
      trigger: language === 'zh' ? 'AI 正在生成回复' : 'assistant is generating',
      visual: language === 'zh' ? '眼部轻闪' : 'eye pulse',
    },
    {
      status: 'tool',
      trigger: language === 'zh' ? '工具或文件操作运行中' : 'tool or file operation running',
      visual: language === 'zh' ? '扫描线和光标' : 'scan line and cursor',
    },
    {
      status: 'waiting',
      trigger: language === 'zh' ? '需要用户选择或输入' : 'user choice or input needed',
      visual: language === 'zh' ? '暖色叶片' : 'warm leaf',
    },
    {
      status: 'queued',
      trigger: language === 'zh' ? '回复期间提交了排队消息' : 'message queued during a reply',
      visual: language === 'zh' ? '叠卡和计数' : 'stacked card and count',
    },
    {
      status: 'complete',
      trigger: language === 'zh' ? '一轮回复正常结束' : 'turn completed successfully',
      visual: language === 'zh' ? '短暂星光反馈' : 'brief sparkle feedback',
    },
    {
      status: 'error',
      trigger: language === 'zh' ? '当前流程出现错误' : 'current flow has an error',
      visual: language === 'zh' ? '红色角标' : 'red corner signal',
    },
  ];
}

function ModelsSettingsPanel({
  language,
  settings,
  selectedModel,
  providerOptions,
  providerSelection,
  customProvider,
  apiKey,
  modelName,
  baseUrl,
  showApiKey,
  onProviderSelectionChange,
  onCustomProviderChange,
  onApiKeyChange,
  onModelNameChange,
  onBaseUrlChange,
  onShowApiKeyChange,
  onAddModelConfig,
  onResetModels,
  onRemoveModelConfig,
  onUseModel,
  onOpenDocs,
}: {
  language: AppLanguage;
  settings: AppSettingsState;
  selectedModel: string;
  providerOptions: string[];
  providerSelection: string;
  customProvider: string;
  apiKey: string;
  modelName: string;
  baseUrl: string;
  showApiKey: boolean;
  onProviderSelectionChange: (value: string) => void;
  onCustomProviderChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onModelNameChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onShowApiKeyChange: (value: boolean) => void;
  onAddModelConfig: (event?: FormEvent) => void;
  onResetModels: () => void;
  onRemoveModelConfig: (id: string) => void;
  onUseModel: (model: string) => void;
  onOpenDocs: (name: string, url: string) => void;
}) {
  const grouped = groupModelConfigs(settings.managedModelConfigs);
  const providers = Object.keys(grouped).sort();

  return (
    <div className="settings-stack">
      <SettingsCard
        title={language === 'zh' ? '模型管理' : 'Model management'}
        subtitle={
          language === 'zh'
            ? '配置模型商、API Key、模型名和 base_url，发送消息时会随当前模型生效。'
            : 'Configure provider, API key, model name, and base_url. The active model is used when sending.'
        }
      >
        <div className="settings-subblock">
          <strong>{language === 'zh' ? '集成参考' : 'Integration reference'}</strong>
          <button
            className="settings-link-tile"
            type="button"
            onClick={() =>
              onOpenDocs(
                language === 'zh' ? 'LiteLLM 文档' : 'LiteLLM docs',
                liteLlmProvidersDocsUrl,
              )
            }
          >
            <ExternalLink size={16} />
            <span>
              <strong>LiteLLM Providers</strong>
              <small>
                {language === 'zh'
                  ? '查看 provider / base_url 兼容写法'
                  : 'Provider and base_url compatibility reference'}
              </small>
            </span>
          </button>
        </div>
        <div className="settings-subblock">
          <strong>
            {language === 'zh' ? '推荐模型商' : 'Recommended providers'}
          </strong>
          <div className="settings-link-grid">
            <button
              className="settings-link-tile"
              type="button"
              onClick={() =>
                onOpenDocs(
                  language === 'zh' ? '火山方舟' : 'Volcengine Ark',
                  volcengineArkUrl,
                )
              }
            >
              <ExternalLink size={16} />
              <span>
                <strong>{language === 'zh' ? '火山方舟' : 'Volcengine Ark'}</strong>
                <small>{language === 'zh' ? '国内模型接入参考' : 'China model access reference'}</small>
              </span>
            </button>
            <button
              className="settings-link-tile"
              type="button"
              onClick={() => onOpenDocs('minimax', miniMaxUrl)}
            >
              <ExternalLink size={16} />
              <span>
                <strong>minimax</strong>
                <small>{language === 'zh' ? '多模态与文本模型平台' : 'Text and multimodal model platform'}</small>
              </span>
            </button>
          </div>
        </div>
        <SettingsDivider />
        <form className="model-form" onSubmit={onAddModelConfig}>
          <label>
            <span>{language === 'zh' ? '模型商' : 'Provider'}</span>
            <select
              value={providerSelection}
              onChange={(event) => onProviderSelectionChange(event.currentTarget.value)}
            >
              {providerOptions.map((provider) => (
                <option key={provider} value={provider}>
                  {provider === customProviderValue
                    ? language === 'zh'
                      ? '模型商名称...'
                      : 'Provider name...'
                    : provider}
                </option>
              ))}
            </select>
          </label>
          {providerSelection === customProviderValue && (
            <SettingsInput
              label={language === 'zh' ? '模型商名称' : 'Provider name'}
              value={customProvider}
              placeholder="myprovider"
              onChange={onCustomProviderChange}
            />
          )}
          <label>
            <span>api_key</span>
            <div className="password-field">
              <input
                value={apiKey}
                type={showApiKey ? 'text' : 'password'}
                placeholder={`${language === 'zh' ? '模型商' : 'Provider'} API Key`}
                onChange={(event) => onApiKeyChange(event.currentTarget.value)}
              />
              <button
                type="button"
                title={showApiKey ? (language === 'zh' ? '隐藏' : 'Hide') : (language === 'zh' ? '显示' : 'Show')}
                onClick={() => onShowApiKeyChange(!showApiKey)}
              >
                {showApiKey ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
            </div>
          </label>
          <SettingsInput
            label={language === 'zh' ? '模型名称' : 'Model name'}
            value={modelName}
            placeholder="gpt-4.1-mini"
            onChange={onModelNameChange}
          />
          <SettingsInput
            label="base_url"
            value={baseUrl}
            placeholder="https://api.openai.com/v1"
            onChange={onBaseUrlChange}
          />
          <div className="settings-actions">
            <button className="primary-button" type="submit">
              <Plus size={14} />
              {language === 'zh' ? '添加模型' : 'Add model'}
            </button>
            <button className="secondary-button" type="button" onClick={onResetModels}>
              <RotateCcw size={14} />
              {language === 'zh' ? '清空模型配置' : 'Clear model configs'}
            </button>
          </div>
        </form>
      </SettingsCard>
      {providers.length === 0 ? (
        <SettingsCard
          title={language === 'zh' ? '模型列表' : 'Model list'}
          subtitle={
            language === 'zh'
              ? '未配置模型时，输入框会显示“待配置”，点击会回到此页。'
              : 'When no model is configured, the composer shows Configure and opens this page.'
          }
        >
          <p className="settings-muted">
            {language === 'zh' ? '暂无数据' : 'No data'}
          </p>
        </SettingsCard>
      ) : (
        providers.map((provider) => (
          <SettingsCard
            key={provider}
            title={provider}
            subtitle={
              language === 'zh'
                ? `${grouped[provider].length} 个模型`
                : `${grouped[provider].length} models`
            }
          >
            {grouped[provider].map((config) => (
              <ModelConfigRow
                key={config.id}
                config={config}
                language={language}
                selected={selectedModel === config.modelName}
                onUse={() => onUseModel(config.modelName)}
                onDelete={() => onRemoveModelConfig(config.id)}
              />
            ))}
          </SettingsCard>
        ))
      )}
    </div>
  );
}

function CacheMaintenancePanel({
  language,
  onNotify,
  onConversationHistoryCleared,
}: {
  language: AppLanguage;
  onNotify: (message: string) => void;
  onConversationHistoryCleared?: () => void | Promise<void>;
}) {
  const [busyTarget, setBusyTarget] = useState<'conversation' | 'logs' | ''>('');
  const [result, setResult] = useState<MaintenanceClearResult | null>(null);
  const [error, setError] = useState('');

  const runClear = useCallback(
    async (target: 'conversation' | 'logs') => {
      if (busyTarget) {
        return;
      }
      const confirmed = window.confirm(
        target === 'conversation'
          ? language === 'zh'
            ? '确定清空本地对话历史吗？这会删除会话、轮次、摘要和 token usage，但不会删除项目文件或任务工作目录。'
            : 'Clear local conversation history? This removes sessions, turns, summaries, and token usage, but not project files or task workspaces.'
          : language === 'zh'
            ? '确定清空本地日志缓存吗？这只会删除 chain logs 和 tool failure logs，不影响对话历史。'
            : 'Clear local logs cache? This removes chain logs and tool failure logs without touching conversations.',
      );
      if (!confirmed) {
        return;
      }
      setBusyTarget(target);
      setError('');
      try {
        const cleared =
          target === 'conversation'
            ? await clearConversationHistory()
            : await clearLogsCache();
        setResult(cleared);
        if (target === 'conversation') {
          await onConversationHistoryCleared?.();
        }
        onNotify(
          target === 'conversation'
            ? language === 'zh'
              ? '对话历史已清空'
              : 'Conversation history cleared'
            : language === 'zh'
              ? '日志缓存已清空'
              : 'Logs cache cleared',
        );
      } catch (caught) {
        setError(errorMessage(caught));
      } finally {
        setBusyTarget('');
      }
    },
    [busyTarget, language, onConversationHistoryCleared, onNotify],
  );

  return (
    <div className="settings-stack">
      <SettingsCard
        title={language === 'zh' ? '缓存维护' : 'Cache maintenance'}
        subtitle={
          language === 'zh'
            ? '这些操作只清理 BushServer 本地数据库中的历史和诊断缓存，不会删除项目文件、任务工作目录或 provider 侧缓存。'
            : 'These actions clear BushServer local database history and diagnostics cache only. Project files, task workspaces, and provider-side caches are untouched.'
        }
      >
        <div className="maintenance-action-list">
          <div className="maintenance-action-row">
            <Archive size={18} />
            <span>
              <strong>
                {language === 'zh' ? '清空对话历史' : 'Clear conversation history'}
              </strong>
              <small>
                {language === 'zh'
                  ? '清理 chat_messages、turns、turn_summaries、session_token_usage 和 chat_sessions。'
                  : 'Clears chat messages, turns, summaries, token usage, and sessions.'}
              </small>
            </span>
            <button
              className="secondary-button"
              type="button"
              disabled={Boolean(busyTarget)}
              onClick={() => void runClear('conversation')}
            >
              {busyTarget === 'conversation' ? (
                <LoaderCircle size={14} />
              ) : (
                <Trash2 size={14} />
              )}
              {language === 'zh' ? '清空' : 'Clear'}
            </button>
          </div>
          <div className="maintenance-action-row">
            <Clipboard size={18} />
            <span>
              <strong>{language === 'zh' ? '清空日志缓存' : 'Clear logs cache'}</strong>
              <small>
                {language === 'zh'
                  ? '清理 chain_logs 和 tool_failure_logs，保留对话与 token usage。'
                  : 'Clears chain logs and tool failure logs while keeping conversations and token usage.'}
              </small>
            </span>
            <button
              className="secondary-button"
              type="button"
              disabled={Boolean(busyTarget)}
              onClick={() => void runClear('logs')}
            >
              {busyTarget === 'logs' ? <LoaderCircle size={14} /> : <Trash2 size={14} />}
              {language === 'zh' ? '清空' : 'Clear'}
            </button>
          </div>
        </div>
        {error && <p className="bot-settings-error">{error}</p>}
        {result && (
          <div className="maintenance-result">
            <strong>
              {language === 'zh' ? '上次执行结果' : 'Last result'}
              {result.target ? ` · ${result.target}` : ''}
            </strong>
            <div className="maintenance-count-grid">
              {Object.entries(result.counts).length ? (
                Object.entries(result.counts).map(([table, count]) => (
                  <span key={table}>
                    <code>{table}</code>
                    <b>{count}</b>
                  </span>
                ))
              ) : (
                <em>{language === 'zh' ? '无计数返回' : 'No counts returned'}</em>
              )}
            </div>
          </div>
        )}
      </SettingsCard>
    </div>
  );
}

function DiagnosticsPanel({
  language,
  settings,
  selectedModel,
}: {
  language: AppLanguage;
  settings: AppSettingsState;
  selectedModel: string;
}) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<DiagnosticResult | null>(null);
  const modelInfo = resolveEffectiveModelInfo(settings, selectedModel, language);
  const authLabels = useMemo(() => 'X-Bush-Local-Key / Bearer token', []);

  const runCheck = useCallback(async () => {
    if (checking) {
      return;
    }
    setChecking(true);
    try {
      const [health, auth] = await Promise.all([
        probeEndpoint(
          language === 'zh' ? '健康检查' : 'Health check',
          '/healthz',
          false,
          language,
        ),
        probeEndpoint(
          language === 'zh' ? '鉴权检查' : 'Auth check',
          '/v1/sessions?limit=1',
          true,
          language,
        ),
      ]);
      setResult({ health, auth });
    } finally {
      setChecking(false);
    }
  }, [checking, language]);

  useEffect(() => {
    void runCheck();
  }, []);

  const copyDiagnostics = async () => {
    await copyText(
      [
        `BACKEND_BASE_URL=${backendBaseUrl}`,
        `LLM_ENDPOINT=${llmEndpoint}`,
        `auth_headers=${authLabels}`,
        `model_source=${modelInfo.source}`,
        `model=${modelInfo.model}`,
        `provider=${modelInfo.provider}`,
        `api_key=${modelInfo.apiKeyLabel}`,
        `base_url=${modelInfo.baseUrl}`,
        result ? `health=${diagnosticSummary(result.health)}` : '',
        result ? `auth=${diagnosticSummary(result.auth)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  };

  return (
    <SettingsCard
      title={language === 'zh' ? '连接诊断' : 'Connection diagnostics'}
      subtitle={
        language === 'zh'
          ? '检查 BushServer 连接、鉴权状态，以及实际发送的模型参数。'
          : 'Check BushServer connection, auth state, and the model parameters sent by cardbush.'
      }
    >
      <div className="settings-subblock">
        <strong>{language === 'zh' ? '当前请求配置' : 'Current request config'}</strong>
        <InfoRow label={language === 'zh' ? '模式' : 'Mode'} value={modelInfo.source} />
        <InfoRow label={language === 'zh' ? '模型名称' : 'Model name'} value={modelInfo.model} />
        <InfoRow label={language === 'zh' ? '模型商' : 'Provider'} value={modelInfo.provider} />
        <InfoRow label="api_key" value={modelInfo.apiKeyLabel} />
        <InfoRow label="base_url" value={modelInfo.baseUrl} />
        <InfoRow
          label={language === 'zh' ? '流式端点' : 'Stream endpoint'}
          value={llmEndpoint || `${backendBaseUrl}/v1/chat/stream`}
        />
      </div>
      <SettingsDivider />
      <div className="settings-subblock">
        <strong>{language === 'zh' ? '服务检查' : 'Service check'}</strong>
        <InfoRow label={language === 'zh' ? '后端地址' : 'Backend address'} value={backendBaseUrl} />
        <InfoRow label={language === 'zh' ? '请求凭据' : 'Request credentials'} value={authLabels} />
        {result ? (
          <>
            <DiagnosticRow probe={result.health} />
            <DiagnosticRow probe={result.auth} />
          </>
        ) : (
          <p className="settings-muted">
            {checking
              ? language === 'zh'
                ? '正在检查...'
                : 'Checking...'
              : language === 'zh'
                ? '尚未检查'
                : 'Not checked'}
          </p>
        )}
        <div className="settings-actions">
          <button
            className="primary-button"
            type="button"
            disabled={checking}
            onClick={() => void runCheck()}
          >
            {checking ? <LoaderCircle size={14} /> : <RefreshCw size={14} />}
            {checking
              ? language === 'zh'
                ? '检查中'
                : 'Checking'
              : language === 'zh'
                ? '运行检查'
                : 'Run check'}
          </button>
          <button className="secondary-button" type="button" onClick={() => void copyDiagnostics()}>
            <Clipboard size={14} />
            {language === 'zh' ? '复制诊断信息' : 'Copy diagnostics'}
          </button>
        </div>
      </div>
    </SettingsCard>
  );
}

function MobileSettingsPanel({ language }: { language: AppLanguage }) {
  return (
    <SettingsCard
      title={language === 'zh' ? '手机连接' : 'Connect to phone'}
      subtitle={
        language === 'zh'
          ? '在同一局域网下，把手机接入 cardbush 服务。'
          : 'Connect your phone to cardbush on the same local network.'
      }
    >
      <div className="mobile-steps">
        <StepText>{language === 'zh' ? '1. 让手机和当前电脑连接同一个 Wi-Fi。' : '1. Connect your phone and this computer to the same Wi-Fi.'}</StepText>
        <StepText>{language === 'zh' ? '2. 启动后端时监听 0.0.0.0:51717。' : '2. Start the backend listening on 0.0.0.0:51717.'}</StepText>
        <StepText>{language === 'zh' ? '3. 在手机端把服务地址配置为 http://<电脑局域网IP>:51717。' : '3. On your phone, set the service URL to http://<LAN IP>:51717.'}</StepText>
      </div>
      <button
        className="settings-copyline"
        type="button"
        onClick={() => void copyText('BACKEND_BASE_URL=http://<LAN IP>:51717')}
      >
        <Smartphone size={16} />
        <span>
          {language === 'zh'
            ? '示例：BACKEND_BASE_URL=http://192.168.1.8:51717'
            : 'Example: BACKEND_BASE_URL=http://192.168.1.8:51717'}
        </span>
      </button>
    </SettingsCard>
  );
}

function AboutSettingsPanel({ language }: { language: AppLanguage }) {
  const copyEnvironment = async () => {
    await copyText(`BACKEND_BASE_URL=${backendBaseUrl}\nLLM_ENDPOINT=${llmEndpoint}`);
  };
  return (
    <SettingsCard
      title={language === 'zh' ? '关于' : 'About'}
      subtitle={
        language === 'zh'
          ? 'cardbush 桌面端设置信息'
          : 'Desktop app information for cardbush.'
      }
    >
      <InfoRow label={language === 'zh' ? '应用' : 'App'} value="cardbush" />
      <InfoRow label={language === 'zh' ? '版本' : 'Version'} value="0.1.0+1" />
      <InfoRow label={language === 'zh' ? '后端地址' : 'Backend address'} value={backendBaseUrl} />
      <InfoRow
        label={language === 'zh' ? 'LLM 地址' : 'LLM address'}
        value={
          llmEndpoint ||
          (language === 'zh'
            ? '未配置（使用 BushServer）'
            : 'Not configured (using BushServer)')
        }
      />
      <div className="settings-actions">
        <button className="secondary-button" type="button" onClick={() => void copyEnvironment()}>
          <Clipboard size={14} />
          {language === 'zh' ? '复制环境信息' : 'Copy environment'}
        </button>
      </div>
    </SettingsCard>
  );
}

function BotSettingsPanel({ language }: { language: AppLanguage }) {
  const [overviews, setOverviews] = useState<BotPlatformOverview[]>([]);
  const [selectedPlatform, setSelectedPlatform] = useState<BotPlatform>('weixin');
  const [statusByPlatform, setStatusByPlatform] = useState<
    Partial<Record<BotPlatform, BotStatusResult>>
  >({});
  const [configByPlatform, setConfigByPlatform] = useState<
    Partial<Record<BotPlatform, BotConfigResult>>
  >({});
  const [configDraftByPlatform, setConfigDraftByPlatform] = useState<
    Partial<Record<BotPlatform, string>>
  >({});
  const [logsByPlatform, setLogsByPlatform] = useState<
    Partial<Record<BotPlatform, string[]>>
  >({});
  const [loginStart, setLoginStart] = useState<WeixinLoginStartResult | null>(null);
  const [loginStatus, setLoginStatus] = useState<WeixinLoginStatusResult | null>(null);
  const [busyKey, setBusyKey] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  const overviewByPlatform = useMemo(
    () => new Map(overviews.map((item) => [item.platform, item] as const)),
    [overviews],
  );
  const selectedOverview = overviewByPlatform.get(selectedPlatform);
  const selectedStatus = statusByPlatform[selectedPlatform];
  const selectedConfig = configByPlatform[selectedPlatform];
  const selectedDraft = configDraftByPlatform[selectedPlatform] ?? '';
  const selectedLogs = logsByPlatform[selectedPlatform] ?? [];

  const notify = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(''), 1800);
  }, []);

  const refreshBots = useCallback(async () => {
    setBusyKey('bots:refresh');
    setError('');
    try {
      setOverviews(await fetchBots());
    } catch (caught) {
      setError(botPanelError(caught, language));
    } finally {
      setBusyKey('');
    }
  }, [language]);

  const refreshStatus = useCallback(
    async (platform: BotPlatform) => {
      setBusyKey(`status:${platform}`);
      setError('');
      try {
        const status = await fetchBotStatus(platform);
        setStatusByPlatform((current) => ({ ...current, [platform]: status }));
      } catch (caught) {
        setError(botPanelError(caught, language));
      } finally {
        setBusyKey('');
      }
    },
    [language],
  );

  const loadConfig = useCallback(
    async (platform: BotPlatform) => {
      setBusyKey(`config:${platform}`);
      setError('');
      try {
        const config = await fetchBotConfig(platform);
        setConfigByPlatform((current) => ({ ...current, [platform]: config }));
        setConfigDraftByPlatform((current) => ({
          ...current,
          [platform]: JSON.stringify(config.config, null, 2),
        }));
      } catch (caught) {
        setError(botPanelError(caught, language));
      } finally {
        setBusyKey('');
      }
    },
    [language],
  );

  const saveConfig = useCallback(async () => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(selectedDraft || '{}') as Record<string, unknown>;
    } catch {
      setError(language === 'zh' ? '配置 JSON 格式不正确' : 'Invalid config JSON');
      return;
    }
    setBusyKey(`save:${selectedPlatform}`);
    setError('');
    try {
      const saved = await saveBotConfig({
        platform: selectedPlatform,
        config: parsed,
      });
      setConfigByPlatform((current) => ({ ...current, [selectedPlatform]: saved }));
      setConfigDraftByPlatform((current) => ({
        ...current,
        [selectedPlatform]: JSON.stringify(saved.config, null, 2),
      }));
      await refreshStatus(selectedPlatform).catch(() => undefined);
      notify(language === 'zh' ? 'Bot 配置已保存' : 'Bot config saved');
    } catch (caught) {
      setError(botPanelError(caught, language));
    } finally {
      setBusyKey('');
    }
  }, [language, notify, refreshStatus, selectedDraft, selectedPlatform]);

  const runServiceAction = useCallback(
    async (platform: BotPlatform, action: 'start' | 'stop' | 'restart') => {
      setBusyKey(`service:${platform}:${action}`);
      setError('');
      try {
        const status = await controlBotService(platform, action);
        setStatusByPlatform((current) => ({ ...current, [platform]: status }));
        notify(language === 'zh' ? '服务命令已发送' : 'Service command sent');
      } catch (caught) {
        setError(botPanelError(caught, language));
      } finally {
        setBusyKey('');
      }
    },
    [language, notify],
  );

  const loadLogs = useCallback(
    async (platform: BotPlatform) => {
      setBusyKey(`logs:${platform}`);
      setError('');
      try {
        const logs = await fetchBotServiceLogs({ platform, tail: 200 });
        setLogsByPlatform((current) => ({ ...current, [platform]: logs.lines }));
      } catch (caught) {
        setError(botPanelError(caught, language));
      } finally {
        setBusyKey('');
      }
    },
    [language],
  );

  const beginWeixinLogin = useCallback(async () => {
    setBusyKey('weixin:login');
    setLoginStart(null);
    setLoginStatus(null);
    setError('');
    try {
      const started = await startWeixinLogin();
      setLoginStart(started);
      notify(language === 'zh' ? '微信登录已开始' : 'WeChat login started');
    } catch (caught) {
      setError(botPanelError(caught, language));
    } finally {
      setBusyKey('');
    }
  }, [language, notify]);

  const clearWeixinAccount = useCallback(
    async (accountId: string) => {
      const normalized = accountId.trim();
      if (!normalized) {
        return;
      }
      setBusyKey(`weixin:clear:${normalized}`);
      setError('');
      try {
        await deleteWeixinAccount(normalized);
        await refreshStatus('weixin');
        notify(language === 'zh' ? '微信账号已移除' : 'WeChat account removed');
      } catch (caught) {
        setError(botPanelError(caught, language));
      } finally {
        setBusyKey('');
      }
    },
    [language, notify, refreshStatus],
  );

  useEffect(() => {
    void refreshBots();
  }, [refreshBots]);

  useEffect(() => {
    void refreshStatus(selectedPlatform);
  }, [refreshStatus, selectedPlatform]);

  useEffect(() => {
    if (!loginStart?.loginId) {
      return undefined;
    }
    const loginId = loginStart.loginId;
    let cancelled = false;
    async function poll() {
      try {
        const next = await fetchWeixinLoginStatus(loginId);
        if (cancelled) {
          return;
        }
        setLoginStatus(next);
        if (next.status === 'confirmed') {
          await refreshStatus('weixin').catch(() => undefined);
          notify(language === 'zh' ? '微信账号已连接' : 'WeChat account connected');
        }
      } catch (caught) {
        if (!cancelled) {
          setError(botPanelError(caught, language));
        }
      }
    }
    void poll();
    const timer = window.setInterval(() => {
      if (
        loginStatus?.status === 'confirmed' ||
        loginStatus?.status === 'expired' ||
        loginStatus?.status === 'failed'
      ) {
        window.clearInterval(timer);
        return;
      }
      void poll();
    }, 1800);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [language, loginStart, loginStatus?.status, notify, refreshStatus]);

  return (
    <div className="settings-stack">
      <SettingsCard
        title={language === 'zh' ? 'Bot 连接' : 'Bot connections'}
        subtitle={
          language === 'zh'
            ? 'CardBush 只负责配置入口和状态展示；运行时、密钥、登录状态和 adapter 生命周期由 BushServer 管理。'
            : 'CardBush owns the UX; BushServer owns runtime, secrets, login state, and adapter lifecycle.'
        }
      >
        <div className="bot-platform-grid">
          {botPlatforms.map((platform) => {
            const overview = overviewByPlatform.get(platform);
            const status = statusByPlatform[platform];
            const serviceStatus =
              status?.serviceStatus ?? overview?.serviceStatus ?? 'stopped';
            const configured = status?.configured ?? overview?.configured ?? false;
            const accountCount = status?.accountCount ?? overview?.accountCount;
            return (
              <button
                className={`bot-platform-card ${
                  selectedPlatform === platform ? 'active' : ''
                }`}
                key={platform}
                type="button"
                onClick={() => setSelectedPlatform(platform)}
              >
                <span className={`bot-status-dot ${botStatusTone(serviceStatus)}`} />
                <span>
                  <strong>{botPlatformLabels[platform][language]}</strong>
                  <small>
                    {configured
                      ? language === 'zh'
                        ? '已配置'
                        : 'Configured'
                      : language === 'zh'
                        ? '待配置'
                        : 'Not configured'}
                    {' · '}
                    {botServiceStatusText(serviceStatus, language)}
                    {accountCount != null ? ` · ${accountCount}` : ''}
                  </small>
                </span>
              </button>
            );
          })}
        </div>
        <div className="settings-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={busyKey === 'bots:refresh'}
            onClick={() => void refreshBots()}
          >
            {busyKey === 'bots:refresh' ? <LoaderCircle size={14} /> : <RefreshCw size={14} />}
            {language === 'zh' ? '刷新平台' : 'Refresh platforms'}
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={busyKey === `status:${selectedPlatform}`}
            onClick={() => void refreshStatus(selectedPlatform)}
          >
            {busyKey === `status:${selectedPlatform}` ? (
              <LoaderCircle size={14} />
            ) : (
              <Monitor size={14} />
            )}
            {language === 'zh' ? '刷新状态' : 'Refresh status'}
          </button>
        </div>
        {error && <p className="bot-settings-error">{error}</p>}
        {notice && <p className="bot-settings-notice">{notice}</p>}
      </SettingsCard>

      <SettingsCard
        title={`${botPlatformLabels[selectedPlatform][language]} ${
          language === 'zh' ? '服务' : 'service'
        }`}
        subtitle={
          language === 'zh'
            ? '服务状态来自 BushServer，前端只发送启动、停止或重启请求。'
            : 'Service status comes from BushServer; the UI only sends lifecycle commands.'
        }
      >
        <div className="bot-service-row">
          <span className={`bot-status-dot ${botStatusTone(
            selectedStatus?.serviceStatus ?? selectedOverview?.serviceStatus ?? 'stopped',
          )}`} />
          <div>
            <strong>
              {botServiceStatusText(
                selectedStatus?.serviceStatus ??
                  selectedOverview?.serviceStatus ??
                  'stopped',
                language,
              )}
            </strong>
            <small>
              {selectedStatus?.lastError ||
                selectedOverview?.lastError ||
                (language === 'zh'
                  ? '暂无错误信息'
                  : 'No error reported')}
            </small>
          </div>
        </div>
        <div className="settings-actions">
          {(['start', 'stop', 'restart'] as const).map((action) => (
            <button
              className="secondary-button"
              key={action}
              type="button"
              disabled={busyKey === `service:${selectedPlatform}:${action}`}
              onClick={() => void runServiceAction(selectedPlatform, action)}
            >
              {busyKey === `service:${selectedPlatform}:${action}` ? (
                <LoaderCircle size={14} />
              ) : (
                <RefreshCw size={14} />
              )}
              {botServiceActionText(action, language)}
            </button>
          ))}
        </div>
      </SettingsCard>

      {selectedPlatform === 'weixin' && (
        <SettingsCard
          title={language === 'zh' ? '微信扫码登录' : 'WeChat QR login'}
          subtitle={
            language === 'zh'
              ? '扫码流程由 BushServer 管理，CardBush 只显示二维码和状态。'
              : 'BushServer manages the QR login state machine; CardBush only displays it.'
          }
        >
          <div className="settings-actions">
            <button
              className="primary-button"
              type="button"
              disabled={busyKey === 'weixin:login'}
              onClick={() => void beginWeixinLogin()}
            >
              {busyKey === 'weixin:login' ? <LoaderCircle size={14} /> : <Bot size={14} />}
              {language === 'zh' ? '开始扫码登录' : 'Start QR login'}
            </button>
          </div>
          {loginStart?.qrcodeUrl && (
            <div className="weixin-login-box">
              <img src={loginStart.qrcodeUrl} alt="WeChat login QR code" />
              <button
                className="settings-copyline"
                type="button"
                onClick={() => void copyText(loginStart.qrcodeUrl)}
              >
                <Clipboard size={15} />
                <span>
                  {language === 'zh' ? '复制二维码链接' : 'Copy QR link'}
                </span>
              </button>
              <InfoRow
                label={language === 'zh' ? '登录状态' : 'Login status'}
                value={botLoginStatusText(loginStatus?.status ?? 'waiting', language)}
              />
              {loginStart.expiresAt && (
                <InfoRow
                  label={language === 'zh' ? '过期时间' : 'Expires'}
                  value={formatBotExpiry(loginStart.expiresAt, language)}
                />
              )}
              {loginStatus?.message && (
                <p className="settings-muted">{loginStatus.message}</p>
              )}
            </div>
          )}
          {(selectedStatus?.accounts ?? []).length > 0 && (
            <div className="bot-account-list">
              {(selectedStatus?.accounts ?? []).map((account, index) => {
                const accountId = String(
                  account.account_id ?? account.accountId ?? account.id ?? '',
                );
                return (
                  <div className="bot-account-row" key={`${accountId || index}`}>
                    <div>
                      <strong>{accountId || (language === 'zh' ? '未知账号' : 'Unknown account')}</strong>
                      <small>
                        {String(account.user_id ?? account.userId ?? '') ||
                          (language === 'zh' ? '未返回 user_id' : 'No user_id')}
                      </small>
                    </div>
                    <button
                      className="secondary-button danger"
                      type="button"
                      disabled={!accountId || busyKey === `weixin:clear:${accountId}`}
                      onClick={() => void clearWeixinAccount(accountId)}
                    >
                      {busyKey === `weixin:clear:${accountId}` ? (
                        <LoaderCircle size={14} />
                      ) : (
                        <Trash2 size={14} />
                      )}
                      {language === 'zh' ? '移除' : 'Remove'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </SettingsCard>
      )}

      <SettingsCard
        title={language === 'zh' ? '配置' : 'Configuration'}
        subtitle={
          language === 'zh'
            ? '配置由 BushServer 落盘。secret 字段应只返回脱敏值；如果要修改 secret，请重新输入对应字段。'
            : 'BushServer persists config. Secret fields should be masked on read; re-enter them when changing secrets.'
        }
      >
        {!selectedConfig ? (
          <button
            className="secondary-button"
            type="button"
            disabled={busyKey === `config:${selectedPlatform}`}
            onClick={() => void loadConfig(selectedPlatform)}
          >
            {busyKey === `config:${selectedPlatform}` ? (
              <LoaderCircle size={14} />
            ) : (
              <Settings size={14} />
            )}
            {language === 'zh' ? '加载配置' : 'Load config'}
          </button>
        ) : (
          <>
            <textarea
              className="settings-json-editor"
              spellCheck={false}
              value={selectedDraft}
              onChange={(event) =>
                setConfigDraftByPlatform((current) => ({
                  ...current,
                  [selectedPlatform]: event.currentTarget.value,
                }))
              }
            />
            <div className="settings-actions">
              <button
                className="primary-button"
                type="button"
                disabled={busyKey === `save:${selectedPlatform}`}
                onClick={() => void saveConfig()}
              >
                {busyKey === `save:${selectedPlatform}` ? (
                  <LoaderCircle size={14} />
                ) : (
                  <Check size={14} />
                )}
                {language === 'zh' ? '保存配置' : 'Save config'}
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => void loadConfig(selectedPlatform)}
              >
                <RefreshCw size={14} />
                {language === 'zh' ? '重新加载' : 'Reload'}
              </button>
            </div>
          </>
        )}
      </SettingsCard>

      <SettingsCard
        title={language === 'zh' ? '日志' : 'Logs'}
        subtitle={
          language === 'zh'
            ? '读取 BushServer 暴露的 adapter 日志 tail。'
            : 'Read the adapter log tail exposed by BushServer.'
        }
      >
        <div className="settings-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={busyKey === `logs:${selectedPlatform}`}
            onClick={() => void loadLogs(selectedPlatform)}
          >
            {busyKey === `logs:${selectedPlatform}` ? (
              <LoaderCircle size={14} />
            ) : (
              <Clipboard size={14} />
            )}
            {language === 'zh' ? '加载最近 200 行' : 'Load last 200 lines'}
          </button>
        </div>
        <pre className="bot-log-view">
          {selectedLogs.length > 0
            ? selectedLogs.join('\n')
            : language === 'zh'
              ? '暂无日志'
              : 'No logs loaded'}
        </pre>
      </SettingsCard>
    </div>
  );
}

function botPanelError(caught: unknown, language: AppLanguage) {
  const message = caught instanceof Error ? caught.message : String(caught);
  if (message.includes('Failed to fetch')) {
    return language === 'zh'
      ? '无法连接 BushServer。请确认后端服务已启动，或稍后重试。'
      : 'Could not connect to BushServer. Start the backend service and try again.';
  }
  if (message.includes('404')) {
    return language === 'zh'
      ? 'Bot API 尚未由 BushServer 提供，等待后端接入后即可使用。'
      : 'Bot API is not available from BushServer yet.';
  }
  return message;
}

function botStatusTone(status: BotServiceStatus) {
  if (status === 'running') {
    return 'running';
  }
  if (status === 'starting' || status === 'stopping') {
    return 'pending';
  }
  if (status === 'failed') {
    return 'failed';
  }
  return 'stopped';
}

function botServiceStatusText(status: BotServiceStatus, language: AppLanguage) {
  const labels: Record<BotServiceStatus, { zh: string; en: string }> = {
    stopped: { zh: '已停止', en: 'Stopped' },
    starting: { zh: '启动中', en: 'Starting' },
    running: { zh: '运行中', en: 'Running' },
    stopping: { zh: '停止中', en: 'Stopping' },
    failed: { zh: '失败', en: 'Failed' },
  };
  return labels[status][language];
}

function botServiceActionText(
  action: 'start' | 'stop' | 'restart',
  language: AppLanguage,
) {
  const labels = {
    start: { zh: '启动', en: 'Start' },
    stop: { zh: '停止', en: 'Stop' },
    restart: { zh: '重启', en: 'Restart' },
  } as const;
  return labels[action][language];
}

function botLoginStatusText(status: WeixinLoginStatus, language: AppLanguage) {
  const labels: Record<WeixinLoginStatus, { zh: string; en: string }> = {
    waiting: { zh: '等待扫码', en: 'Waiting' },
    scanned: { zh: '已扫码，等待确认', en: 'Scanned' },
    confirmed: { zh: '已确认', en: 'Confirmed' },
    expired: { zh: '已过期', en: 'Expired' },
    failed: { zh: '失败', en: 'Failed' },
  };
  return labels[status][language];
}

function SettingsCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-card">
      <div className="settings-card-header">
        <h3>{title}</h3>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {children}
    </section>
  );
}

function SettingsDivider() {
  return <div className="settings-divider" />;
}

function SettingsGroupTitle({ children }: { children: React.ReactNode }) {
  return <div className="settings-group-title">{children}</div>;
}

function SettingsRadio({
  name,
  title,
  subtitle,
  value,
  checked,
  onChange,
}: {
  name: string;
  title: string;
  subtitle?: string;
  value: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <label className="settings-radio">
      <input name={name} type="radio" value={value} checked={checked} onChange={onChange} />
      <span>
        <strong>{title}</strong>
        {subtitle && <small>{subtitle}</small>}
      </span>
    </label>
  );
}

function SettingsSwitch({
  title,
  subtitle,
  checked,
  onChange,
}: {
  title: string;
  subtitle?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="settings-switch">
      <span>
        <strong>{title}</strong>
        {subtitle && <small>{subtitle}</small>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </label>
  );
}

function SettingsInput({
  label,
  value,
  placeholder,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="settings-field">
      <span>{label}</span>
      <input
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );
}

function SettingsRange({
  label,
  value,
  min,
  max,
  step,
  suffix,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  suffix?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="settings-range">
      <span>
        <strong>{label}</strong>
        <b>{value}{suffix ?? ''}</b>
      </span>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      />
    </label>
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

function StepText({ children }: { children: React.ReactNode }) {
  return <p className="step-text">{children}</p>;
}

function ModelConfigRow({
  config,
  language,
  selected,
  onUse,
  onDelete,
}: {
  config: ManagedModelConfig;
  language: AppLanguage;
  selected: boolean;
  onUse: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="model-row">
      <div>
        <strong>{config.modelName}</strong>
        <span>
          provider={config.provider || 'custom'} · api_key={maskSecret(config.apiKey, language)} · base_url={config.baseUrl || (language === 'zh' ? '未填写' : 'not filled')}
        </span>
      </div>
      {selected && (
        <span className="current-badge">
          <CheckCircle2 size={13} />
          {language === 'zh' ? '当前' : 'Current'}
        </span>
      )}
      <button className="secondary-button" type="button" onClick={onUse}>
        {language === 'zh' ? '设为当前' : 'Use'}
      </button>
      <button className="secondary-button danger" type="button" onClick={onDelete}>
        <Trash2 size={14} />
        {language === 'zh' ? '删除' : 'Delete'}
      </button>
    </div>
  );
}

function DiagnosticRow({ probe }: { probe: DiagnosticProbe }) {
  return (
    <div className={`diagnostic-row ${probe.ok ? 'ok' : 'fail'}`}>
      {probe.ok ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
      <div>
        <strong>{probe.label}</strong>
        <span>{probe.detail}</span>
      </div>
      <small>{probe.elapsedMs}ms</small>
    </div>
  );
}

type DiagnosticResult = {
  health: DiagnosticProbe;
  auth: DiagnosticProbe;
};

type DiagnosticProbe = {
  label: string;
  ok: boolean;
  elapsedMs: number;
  detail: string;
  statusCode?: number;
};

type EffectiveModelInfo = {
  source: string;
  model: string;
  provider: string;
  apiKeyLabel: string;
  baseUrl: string;
};

function collectProviderOptions(configs: ManagedModelConfig[]) {
  const seen = new Set<string>();
  const result = [...suggestedProviders];
  for (const item of configs) {
    const provider = normalizeProvider(item.provider);
    if (provider && !suggestedProviders.includes(provider)) {
      result.push(provider);
    }
  }
  const unique = result.filter((item) => {
    const key = item.toLowerCase();
    return seen.has(key) ? false : seen.add(key);
  });
  unique.push(customProviderValue);
  return unique;
}

function groupModelConfigs(configs: ManagedModelConfig[]) {
  return configs.reduce<Record<string, ManagedModelConfig[]>>((groups, item) => {
    const provider = item.provider.trim() || 'custom';
    groups[provider] = [...(groups[provider] ?? []), item];
    return groups;
  }, {});
}

function resolveEffectiveModelInfo(
  settings: AppSettingsState,
  selectedModel: string,
  language: AppLanguage,
): EffectiveModelInfo {
  const determinedByServer =
    language === 'zh' ? '(由 BushServer 决定)' : '(determined by BushServer)';
  const config = settings.managedModelConfigs.find(
    (item) => item.modelName.trim().toLowerCase() === selectedModel.trim().toLowerCase(),
  );
  if (!config || !shouldUseManagedConfig(config)) {
    return {
      source: llmEndpoint ? 'External LLM_ENDPOINT' : language === 'zh' ? 'BushServer 默认配置' : 'BushServer default config',
      model: selectedModel || determinedByServer,
      provider: determinedByServer,
      apiKeyLabel: determinedByServer,
      baseUrl: determinedByServer,
    };
  }
  return {
    source: language === 'zh' ? '托管模型配置' : 'Managed model config',
    model: config.modelName,
    provider: config.provider || (language === 'zh' ? '(未填写)' : '(not filled)'),
    apiKeyLabel: maskSecret(config.apiKey, language),
    baseUrl: config.baseUrl || (language === 'zh' ? '(未填写)' : '(not filled)'),
  };
}

function shouldUseManagedConfig(config: ManagedModelConfig) {
  return (
    config.modelName.trim() &&
    (config.provider.trim().toLowerCase() !== 'custom' ||
      config.apiKey.trim() ||
      config.baseUrl.trim())
  );
}

function maskSecret(value: string, language: AppLanguage) {
  const raw = value.trim();
  if (!raw) {
    return language === 'zh' ? '(未填写)' : '(not filled)';
  }
  if (raw.length <= 8) {
    return `${raw[0]}${'*'.repeat(Math.max(0, raw.length - 1))}`;
  }
  return `${raw.slice(0, 4)}****${raw.slice(-4)}`;
}

async function probeEndpoint(
  label: string,
  path: string,
  includeAuthHeaders: boolean,
  language: AppLanguage,
): Promise<DiagnosticProbe> {
  const endpoint = `${backendBaseUrl.replace(/\/$/, '')}${path}`;
  const started = performance.now();
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 4000);
  try {
    const headers = includeAuthHeaders
      ? await window.cardbushDesktop?.bushHeaders?.(endpoint)
      : {};
    const response = await fetch(endpoint, {
      headers,
      signal: controller.signal,
    });
    const text = await response.text();
    return {
      label,
      ok: response.ok,
      statusCode: response.status,
      elapsedMs: Math.round(performance.now() - started),
      detail: probeDetail(response.status, text, language),
    };
  } catch (caught) {
    return {
      label,
      ok: false,
      elapsedMs: Math.round(performance.now() - started),
      detail: friendlyProbeError(caught, language),
    };
  } finally {
    window.clearTimeout(timeout);
  }
}

function probeDetail(status: number, body: string, language: AppLanguage) {
  const compact = body.trim().replace(/\s+/g, ' ');
  if (!compact) {
    return `HTTP ${status}`;
  }
  try {
    const decoded: unknown = JSON.parse(compact);
    if (isRecord(decoded)) {
      if (decoded.status) {
        return `HTTP ${status} · status=${decoded.status}`;
      }
      if (decoded.detail) {
        return `HTTP ${status} · ${decoded.detail}`;
      }
    }
  } catch {
    // Keep compact text below.
  }
  const clipped = compact.length > 90 ? `${compact.slice(0, 87)}...` : compact;
  if ((status === 401 || status === 403) && language === 'zh') {
    return `HTTP ${status} · ${clipped} · 鉴权失败`;
  }
  return `HTTP ${status} · ${clipped}`;
}

function friendlyProbeError(caught: unknown, language: AppLanguage) {
  const text = caught instanceof Error ? caught.message : String(caught);
  if (/abort|timeout/i.test(text)) {
    return language === 'zh'
      ? '请求超时，请检查 BushServer 是否卡住或被防火墙阻止'
      : 'Request timed out. Check whether BushServer is blocked or stuck.';
  }
  if (/failed to fetch|connection refused/i.test(text)) {
    return language === 'zh'
      ? '连接失败，BushServer 可能没有启动或端口不对'
      : 'Connection failed. BushServer may not be running or the port is wrong.';
  }
  return text.replace(/^Exception:\s*/, '');
}

function diagnosticSummary(probe: DiagnosticProbe) {
  return `${probe.ok ? 'ok' : 'fail'}${probe.statusCode ? ` HTTP ${probe.statusCode}` : ''} ${probe.elapsedMs}ms ${probe.detail}`;
}
