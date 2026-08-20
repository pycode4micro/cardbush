import {
  AlertCircle,
  Archive,
  ArrowLeft,
  Bot,
  Check,
  CheckCircle2,
  Circle,
  Clipboard,
  Cpu,
  Eye,
  EyeOff,
  Gamepad2,
  Image,
  LoaderCircle,
  Monitor,
  MonitorCog,
  Network,
  PackageOpen,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings,
  Smartphone,
  Terminal,
  Trash2,
  Upload,
} from 'lucide-react';
import type * as React from 'react';
import {
  type CSSProperties,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  backendBaseUrl,
  backendRequestHeaders,
  RUNTIME_ASSET_RESET_PROTOCOL,
  clearConversationHistory,
  clearLogsCache,
  controlBotService,
  deleteMcpServerConfig,
  deleteWeixinAccount,
  fetchBotConfig,
  fetchBots,
  fetchBotServiceLogs,
  fetchBotStatus,
  fetchMcpServers,
  fetchRuntimeAssetResetPlan,
  fetchRuntimeMaintenanceLogs,
  fetchSubagentRuntime,
  fetchWeixinLoginStatus,
  llmEndpoint,
  isBushServerHttpError,
  resetRuntimeAssets,
  saveBotConfig,
  saveMcpServerConfig,
  setMcpServerEnabled,
  startWeixinLogin,
  validateMcpServerConfig,
  type MaintenanceClearResult,
  type McpServerConfigInput,
} from '../backend/api';
import mcpLogoUrl from '../assets/integration-logos/mcp.svg';
import { BotPlatformIcon } from '../components/BotPlatformIcon';
import { SidebarResizer } from '../components/SidebarResizer';
import { basename } from '../shared/localPaths';
import { SubagentsPanel } from './SubagentsPanel';
import {
  loadCumulativeUsageStatistics,
  type CumulativeUsageStatistics,
} from './settings/usageActivity';
import type {
  AppLanguage,
  AppLanguageMode,
  AppSettingsState,
  BackendCapabilities,
  BotConfigResult,
  BotPlatform,
  BotPlatformOverview,
  BotServiceStatus,
  BotStatusResult,
  ConversationSummary,
  LightThemeStyle,
  ManagedModelConfig,
  McpServerConfig,
  McpServerValidationResult,
  McpTransport,
  RuntimeAssetCategory,
  RuntimeAssetResetPlan,
  RuntimeAssetResetResult,
  SettingsSection,
  ThemePreference,
  WeixinLoginStartResult,
  WeixinLoginStatus,
  WeixinLoginStatusResult,
} from '../types';

const COPY_FEEDBACK_EVENT = 'cardbush-copy-feedback';
const pendingRuntimeAssetResetStorageKey = 'cardbush_pending_runtime_asset_reset';
const customProviderValue = '__custom_provider__';
const defaultMaxContextTokens = 256_000;
const suggestedProviders = [
  'openai',
  'anthropic',
  'gemini',
  'deepseek',
  'moonshot',
  'qwen',
];
const defaultFontSettings = {
  family: '',
  displayName: '',
  filePath: '',
};
type VisibleSettingsSection = Exclude<SettingsSection, 'companion'>;
type SettingsIconComponent = React.ComponentType<{ size?: number; className?: string }>;

const visibleSettingsSections: VisibleSettingsSection[] = [
  'profile',
  'os',
  'runtime',
  'proxy',
  'bots',
  'subagents',
  'mcp',
  'cache',
  'models',
  'diagnostics',
  'mobile',
  'about',
];

const settingsLabels: Record<VisibleSettingsSection, { zh: string; en: string }> = {
  profile: { zh: '个性化', en: 'Personalization' },
  os: { zh: '桌面 OS', en: 'Desktop OS' },
  runtime: { zh: '运行环境', en: 'Runtime' },
  proxy: { zh: '代理设置', en: 'Proxy' },
  bots: { zh: 'Bot 连接', en: 'Bot links' },
  subagents: { zh: '子任务运行态', en: 'Task runtime' },
  mcp: { zh: 'MCP 服务器', en: 'MCP servers' },
  cache: { zh: '缓存', en: 'Cache' },
  models: { zh: '模型管理', en: 'Models' },
  diagnostics: { zh: '连接诊断', en: 'Diagnostics' },
  mobile: { zh: '手机连接', en: 'Mobile' },
  about: { zh: '关于', en: 'About' },
};

const settingsDescriptions: Record<VisibleSettingsSection, { zh: string; en: string }> = {
  profile: { zh: '查看累计使用量，并统一管理主题、语言、背景与字体。', en: 'Review cumulative usage and manage theme, language, background, and typography.' },
  os: { zh: '配置桌面模式、开机启动和手柄操作。', en: 'Configure desktop mode, startup behavior, and controller input.' },
  runtime: { zh: '选择工具与终端命令使用的默认运行环境。', en: 'Choose the default runtime for tools and terminal commands.' },
  proxy: { zh: '统一管理网络代理与浏览隐私选项。', en: 'Manage network proxy and browser privacy options.' },
  bots: { zh: '连接并管理外部消息平台。', en: 'Connect and manage external messaging platforms.' },
  subagents: { zh: '查看子任务能力、运行状态和依赖。', en: 'Inspect task-agent capabilities, runtime state, and dependencies.' },
  mcp: { zh: '配置 MCP 服务及其连接状态。', en: 'Configure MCP servers and their connection status.' },
  cache: { zh: '清理本地历史和诊断缓存。', en: 'Clear local history and diagnostic caches.' },
  models: { zh: '添加模型服务并设置默认模型。', en: 'Add model providers and choose the default model.' },
  diagnostics: { zh: '检查后端、鉴权与模型请求配置。', en: 'Inspect backend, authentication, and model request settings.' },
  mobile: { zh: '配置手机端访问和局域网连接。', en: 'Configure mobile access and local-network connectivity.' },
  about: { zh: '查看版本、服务地址和项目链接。', en: 'View version, service endpoints, and project links.' },
};

const settingsNavigationGroups: Array<{
  label: { zh: string; en: string };
  sections: VisibleSettingsSection[];
}> = [
  {
    label: { zh: '常规', en: 'General' },
    sections: ['profile', 'os', 'runtime'],
  },
  {
    label: { zh: '智能与扩展', en: 'AI & extensions' },
    sections: ['models', 'subagents', 'mcp'],
  },
  {
    label: { zh: '连接', en: 'Connections' },
    sections: ['proxy', 'bots', 'mobile'],
  },
  {
    label: { zh: '系统', en: 'System' },
    sections: ['cache', 'diagnostics', 'about'],
  },
];

const settingsIcons: Record<VisibleSettingsSection, SettingsIconComponent> = {
  profile: Settings,
  os: MonitorCog,
  runtime: Terminal,
  proxy: Monitor,
  bots: SettingsBotIcon,
  subagents: Network,
  mcp: McpLogoIcon,
  cache: Archive,
  models: Cpu,
  diagnostics: Clipboard,
  mobile: Smartphone,
  about: Circle,
};

function visibleSettingsSection(value: SettingsSection): VisibleSettingsSection {
  return visibleSettingsSections.includes(value as VisibleSettingsSection)
    ? (value as VisibleSettingsSection)
    : 'profile';
}

function SettingsBotIcon({
  size = 18,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={`settings-bot-icon ${className ?? ''}`.trim()}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <BotPlatformIcon platform="any" />
    </span>
  );
}

function McpLogoIcon({
  size = 18,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <img
      className={`mcp-logo-mark ${className ?? ''}`.trim()}
      src={mcpLogoUrl}
      width={size}
      height={size}
      style={{
        width: size,
        height: size,
      }}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

const botPlatforms: BotPlatform[] = ['weixin', 'feishu', 'telegram', 'discord'];
const botPlatformLabels: Record<BotPlatform, { zh: string; en: string }> = {
  weixin: { zh: '微信', en: 'WeChat' },
  feishu: { zh: '飞书', en: 'Feishu' },
  telegram: { zh: 'Telegram', en: 'Telegram' },
  discord: { zh: 'Discord', en: 'Discord' },
};
export function SettingsView({
  themePreference,
  lightThemeStyle,
  language,
  languageMode,
  systemLanguage,
  settings,
  backgroundImageSource,
  selectedModel,
  availableModels,
  backendCapabilities,
  runtimeBusy,
  conversations,
  initialSection,
  onBack,
  onThemePreferenceChange,
  onLightThemeStyleChange,
  onLanguageModeChange,
  onSettingsChange,
  onEnterOsMode,
  onUseModel,
  onSidebarWidthChange,
  onConversationHistoryCleared,
  onRuntimeAssetsReloaded,
}: {
  themePreference: ThemePreference;
  lightThemeStyle: LightThemeStyle;
  language: AppLanguage;
  languageMode: AppLanguageMode;
  systemLanguage: AppLanguage;
  settings: AppSettingsState;
  backgroundImageSource: string;
  selectedModel: string;
  availableModels: ManagedModelConfig[];
  backendCapabilities: BackendCapabilities;
  runtimeBusy: boolean;
  conversations: ConversationSummary[];
  initialSection: SettingsSection;
  onBack: () => void;
  onThemePreferenceChange: (value: ThemePreference) => void;
  onLightThemeStyleChange: (value: LightThemeStyle) => void;
  onLanguageModeChange: (value: AppLanguageMode) => void;
  onSettingsChange: (updater: (current: AppSettingsState) => AppSettingsState) => void;
  onEnterOsMode: () => void;
  onUseModel: (model: string) => void;
  onSidebarWidthChange: (value: number) => void;
  onConversationHistoryCleared?: () => void | Promise<void>;
  onRuntimeAssetsReloaded?: (categories: RuntimeAssetCategory[]) => Promise<void>;
}) {
  const [section, setSection] = useState<VisibleSettingsSection>(
    visibleSettingsSection(initialSection),
  );
  const [providerSelection, setProviderSelection] = useState(
    settings.managedModelConfigs[0]?.provider || suggestedProviders[0],
  );
  const [customProvider, setCustomProvider] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [modelName, setModelName] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [maxContextTokens, setMaxContextTokens] = useState(
    String(defaultMaxContextTokens),
  );
  const [maxCompletionTokens, setMaxCompletionTokens] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [toast, setToast] = useState('');
  const providerOptions = useMemo(
    () => collectProviderOptions(settings.managedModelConfigs),
    [settings.managedModelConfigs],
  );

  useEffect(() => {
    setSection(visibleSettingsSection(initialSection));
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
            ...(
              normalizeMaxContextTokens(maxContextTokens)
                ? { maxContextTokens: normalizeMaxContextTokens(maxContextTokens) }
                : {}
            ),
            ...(
              normalizeMaxCompletionTokens(maxCompletionTokens)
                ? {
                    maxCompletionTokens:
                      normalizeMaxCompletionTokens(maxCompletionTokens),
                  }
                : {}
            ),
          },
        ],
      }));
      setProviderSelection(provider);
      setModelName('');
      setMaxContextTokens(String(defaultMaxContextTokens));
      setMaxCompletionTokens('');
      notify(language === 'zh' ? '模型配置已添加' : 'Model configuration added');
    },
    [
      apiKey,
      baseUrl,
      customProvider,
      language,
      maxContextTokens,
      maxCompletionTokens,
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

  const updateModelContextTokens = useCallback(
    (id: string, value: string) => {
      const trimmed = value.trim();
      const normalized = normalizeMaxContextTokens(trimmed);
      if (trimmed && !normalized) {
        notify(
          language === 'zh'
            ? '最大上下文 token 必须是大于 0 的数字'
            : 'Max context tokens must be a number greater than 0',
        );
        return;
      }
      updateSettings((current) => ({
        ...current,
        managedModelConfigs: current.managedModelConfigs.map((item) => {
          if (item.id !== id) {
            return item;
          }
          if (!trimmed) {
            const { maxContextTokens: _removed, ...withoutContextTokens } = item;
            return withoutContextTokens;
          }
          return { ...item, maxContextTokens: normalized };
        }),
      }));
      notify(
        language === 'zh'
          ? '最大上下文 token 已更新'
          : 'Max context tokens updated',
      );
    },
    [language, notify, updateSettings],
  );

  const updateModelCompletionTokens = useCallback(
    (id: string, value: string) => {
      const trimmed = value.trim();
      const normalized = normalizeMaxCompletionTokens(trimmed);
      if (trimmed && !normalized) {
        notify(
          language === 'zh'
            ? '最大输出 token 必须是大于 0 的数字'
            : 'Max output tokens must be a number greater than 0',
        );
        return;
      }
      updateSettings((current) => ({
        ...current,
        managedModelConfigs: current.managedModelConfigs.map((item) => {
          if (item.id !== id) {
            return item;
          }
          if (!trimmed) {
            const { maxCompletionTokens: _removed, ...withoutCompletionTokens } = item;
            return withoutCompletionTokens;
          }
          return { ...item, maxCompletionTokens: normalized };
        }),
      }));
      notify(
        language === 'zh'
          ? '最大输出 token 已更新'
          : 'Max output tokens updated',
      );
    },
    [language, notify, updateSettings],
  );

  const resetModels = useCallback(() => {
    updateSettings((current) => ({ ...current, managedModelConfigs: [] }));
    onUseModel('');
    notify(language === 'zh' ? '已清空模型配置' : 'Model configurations cleared');
  }, [language, notify, onUseModel, updateSettings]);

  const useModel = useCallback(
    (modelConfigId: string) => {
      const config = availableModels.find((item) => item.id === modelConfigId);
      if (!config) {
        notify(
          language === 'zh'
            ? '切换失败：当前模型配置不存在'
            : 'Switch failed: the model configuration no longer exists',
        );
        return;
      }
      onUseModel(config.id);
      notify(
        language === 'zh'
          ? `已切换当前模型：${config.provider} / ${config.modelName}`
          : `Current model switched: ${config.provider} / ${config.modelName}`,
      );
    },
    [availableModels, language, notify, onUseModel],
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

  const importBackgroundImage = useCallback(async () => {
    const filePath = await window.cardbushDesktop?.pickBackgroundImage?.();
    if (!filePath) {
      return;
    }
    let backgroundPath = filePath;
    if (window.cardbushDesktop?.cacheBackgroundImage) {
      try {
        backgroundPath = await window.cardbushDesktop.cacheBackgroundImage(filePath);
      } catch {
        notify(language === 'zh' ? '背景图片缓存失败' : 'Failed to cache background image');
        return;
      }
    }
    updateSettings((current) => ({
      ...current,
      backgroundImagePath: backgroundPath,
    }));
    notify(language === 'zh' ? '背景图片已更新' : 'Background image updated');
  }, [language, notify, updateSettings]);

  const resetBackgroundImage = useCallback(() => {
    updateSettings((current) => ({
      ...current,
      backgroundImagePath: '',
    }));
    notify(language === 'zh' ? '背景图片已清除' : 'Background image cleared');
  }, [language, notify, updateSettings]);

  const resetFont = useCallback(() => {
    updateSettings((current) => ({
      ...current,
      font: defaultFontSettings,
    }));
  }, [updateSettings]);

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
          reasoningStreamAvailable={backendCapabilities.reasoningStream}
          backgroundImageSource={backgroundImageSource}
          conversations={conversations}
          onThemePreferenceChange={onThemePreferenceChange}
          onLightThemeStyleChange={onLightThemeStyleChange}
          onLanguageModeChange={onLanguageModeChange}
          onSettingsChange={updateSettings}
          onImportFont={importFont}
          onResetFont={resetFont}
          onImportBackgroundImage={importBackgroundImage}
          onResetBackgroundImage={resetBackgroundImage}
        />
      );
    }
    if (section === 'runtime') {
      return (
        <div className="settings-stack">
          <SettingsCard
            title={language === 'zh' ? '运行环境' : 'Runtime environment'}
            subtitle={
              language === 'zh'
                ? '选择终端命令默认在哪个环境中执行。这个设置会影响内置终端，也会随对话请求传给 BushServer。'
                : 'Choose where terminal commands run by default. This affects the embedded terminal and is sent to BushServer with chat requests.'
            }
          >
            <SettingsRadio
              name="terminal-runtime"
              value="powershell"
              title="PowerShell"
              subtitle={
                language === 'zh'
                  ? '默认 Windows 终端环境，适合 npm、Electron、PowerShell 脚本和本机路径。'
                  : 'Default Windows terminal runtime for npm, Electron, PowerShell scripts, and local Windows paths.'
              }
              checked={settings.terminal.runtime === 'powershell'}
              onChange={() =>
                updateSettings((current) => ({
                  ...current,
                  terminal: {
                    ...current.terminal,
                    runtime: 'powershell',
                  },
                }))
              }
            />
            {backendCapabilities.terminalRuntimes.includes('wsl') && (
              <SettingsRadio
                name="terminal-runtime"
                value="wsl"
                title="WSL"
                subtitle={
                  language === 'zh'
                    ? '使用 Windows Subsystem for Linux 执行命令；需要本机已安装并配置 WSL。'
                    : 'Run commands through Windows Subsystem for Linux. Requires WSL to be installed and configured.'
                }
                checked={settings.terminal.runtime === 'wsl'}
                onChange={() =>
                  updateSettings((current) => ({
                    ...current,
                    terminal: {
                      ...current.terminal,
                      runtime: 'wsl',
                    },
                  }))
                }
              />
            )}
            {backendCapabilities.terminalRuntimes.includes('git_bash') && (
              <SettingsRadio
                name="terminal-runtime"
                value="git_bash"
                title="Git Bash"
                subtitle={
                  language === 'zh'
                    ? '使用 Git for Windows 自带的 Bash，适合 Unix 命令和 Windows 项目路径。'
                    : 'Use Git for Windows Bash for Unix-style commands and Windows project paths.'
                }
                checked={settings.terminal.runtime === 'git_bash'}
                onChange={() =>
                  updateSettings((current) => ({
                    ...current,
                    terminal: {
                      ...current.terminal,
                      runtime: 'git_bash',
                    },
                  }))
                }
              />
            )}
            {backendCapabilities.terminalRuntimes.includes('bash') && (
              <SettingsRadio
                name="terminal-runtime"
                value="bash"
                title="Bash"
                subtitle={
                  language === 'zh'
                    ? '使用系统原生 Bash。'
                    : 'Use the system-native Bash runtime.'
                }
                checked={settings.terminal.runtime === 'bash'}
                onChange={() =>
                  updateSettings((current) => ({
                    ...current,
                    terminal: {
                      ...current.terminal,
                      runtime: 'bash',
                    },
                  }))
                }
              />
            )}
          </SettingsCard>
        </div>
      );
    }
    if (section === 'os') {
      const loginSettingsAvailable = Boolean(window.cardbushDesktop?.setOsLoginSettings);
      return (
        <SettingsCard
          title={language === 'zh' ? '桌面 OS' : 'Desktop OS'}
          subtitle={
            language === 'zh'
              ? '让 CardBush 随系统启动，并作为桌面 Agent 的默认对话入口。'
              : 'Start CardBush with the system and use it as the desktop agent entry point.'
          }
        >
          <SettingsSwitch
            title={language === 'zh' ? '开机自动启动' : 'Launch at login'}
            subtitle={
              language === 'zh'
                ? '登录 Windows 后自动启动 CardBush。'
                : 'Start CardBush automatically after signing in.'
            }
            checked={settings.os.launchAtLogin}
            disabled={!loginSettingsAvailable}
            onChange={(checked) =>
              updateSettings((current) => ({
                ...current,
                os: { ...current.os, launchAtLogin: checked },
              }))
            }
          />
          <SettingsSwitch
            title={language === 'zh' ? '启动后进入 OS 模式' : 'Open in OS mode'}
            subtitle={
              language === 'zh'
                ? '开机启动时直接进入极简桌面对话，不打开项目工作区。'
                : 'Open the minimal desktop conversation instead of a project workspace.'
            }
            checked={settings.os.startInOsMode}
            disabled={!settings.os.launchAtLogin || !loginSettingsAvailable}
            onChange={(checked) =>
              updateSettings((current) => ({
                ...current,
                os: { ...current.os, startInOsMode: checked },
              }))
            }
          />
          <SettingsDivider />
          <SettingsGroupTitle>{language === 'zh' ? '任务栏位置' : 'Taskbar placement'}</SettingsGroupTitle>
          <SettingsRadio
            name="os-taskbar-placement"
            value="bottom"
            title={language === 'zh' ? '底部呼吸条' : 'Bottom breathing bar'}
            subtitle={language === 'zh' ? '默认收起，靠近底部时展开最近启动的应用。' : 'Collapsed by default; reveals recent apps near the bottom edge.'}
            checked={settings.os.taskbarPlacement === 'bottom'}
            onChange={() => updateSettings((current) => ({
              ...current,
              os: { ...current.os, taskbarPlacement: 'bottom' },
            }))}
          />
          <SettingsRadio
            name="os-taskbar-placement"
            value="top"
            title={language === 'zh' ? '顶部状态栏' : 'Top status bar'}
            subtitle={language === 'zh' ? '把最近启动的应用固定在 CardBush OS 顶栏。' : 'Keep recently launched apps in the CardBush OS status bar.'}
            checked={settings.os.taskbarPlacement === 'top'}
            onChange={() => updateSettings((current) => ({
              ...current,
              os: { ...current.os, taskbarPlacement: 'top' },
            }))}
          />
          <SettingsDivider />
          <SettingsGroupTitle>{language === 'zh' ? '手柄映射' : 'Controller mapping'}</SettingsGroupTitle>
          <div className="os-gamepad-settings">
            <div className="os-gamepad-settings-heading">
              <Gamepad2 size={16} />
              <span>{language === 'zh' ? '使用标准手柄按键，可在 OS 界面完成导航、输入和启动应用。' : 'Use standard gamepad buttons to navigate, type, and launch apps in OS mode.'}</span>
            </div>
            {([
              ['confirmButton', language === 'zh' ? '确认' : 'Confirm'],
              ['backButton', language === 'zh' ? '返回' : 'Back'],
              ['keyboardButton', language === 'zh' ? '九键输入' : 'Nine-key input'],
              ['appsButton', language === 'zh' ? '应用' : 'Applications'],
              ['settingsButton', language === 'zh' ? '设置' : 'Settings'],
            ] as const).map(([key, label]) => (
              <GamepadMappingRow
                key={key}
                label={label}
                value={settings.os.gamepad[key]}
                onChange={(value) => updateSettings((current) => ({
                  ...current,
                  os: {
                    ...current.os,
                    gamepad: { ...current.os.gamepad, [key]: value },
                  },
                }))}
              />
            ))}
          </div>
          <div className="os-settings-note">
            <MonitorCog size={16} />
            <span>
              {language === 'zh'
                ? '应用启动能力由桌面端提供；软件识别、窗口控制和界面操作仍需要 BushServer 暴露对应能力。'
                : 'Startup is handled by the desktop app. App discovery, window control, and UI actions still require BushServer support.'}
            </span>
          </div>
          <div className="settings-actions">
            <button className="primary-button" type="button" onClick={onEnterOsMode}>
              <MonitorCog size={14} />
              {language === 'zh' ? '立即进入' : 'Open now'}
            </button>
          </div>
        </SettingsCard>
      );
    }
    if (section === 'proxy') {
      return (
        <SettingsCard
          title={language === 'zh' ? '代理设置' : 'Proxy settings'}
          subtitle={
            language === 'zh'
              ? '配置 cardbush 发起网络请求时使用的代理方式；默认直连，不继承环境代理。'
              : 'Configure how cardbush network requests use proxy settings; direct connection is the default.'
          }
        >
          <SettingsRadio
            name="proxy-mode"
            value="none"
            title={language === 'zh' ? '不使用代理' : 'No proxy'}
            subtitle={
              language === 'zh'
                ? '默认直连，本地 BushServer 请求不会被 HTTP_PROXY / HTTPS_PROXY 接走。'
                : 'Direct connection by default; local BushServer requests are not routed through HTTP_PROXY / HTTPS_PROXY.'
            }
            checked={settings.proxy.mode === 'none'}
            onChange={() => updateProxy({ mode: 'none' })}
          />
          <SettingsRadio
            name="proxy-mode"
            value="manual"
            title={language === 'zh' ? '手动代理' : 'Manual proxy'}
            subtitle={
              language === 'zh'
                ? '使用下方 HTTP_PROXY / HTTPS_PROXY，并保留 NO_PROXY 绕过列表。'
                : 'Use the HTTP_PROXY / HTTPS_PROXY values below with the NO_PROXY bypass list.'
            }
            checked={settings.proxy.mode === 'manual'}
            onChange={() => updateProxy({ mode: 'manual' })}
          />
          <SettingsRadio
            name="proxy-mode"
            value="system"
            title={language === 'zh' ? '跟随系统代理' : 'Follow system proxy'}
            subtitle={
              language === 'zh'
                ? '使用操作系统或 Chromium 会话代理配置。'
                : 'Use the operating system or Chromium session proxy configuration.'
            }
            checked={settings.proxy.mode === 'system'}
            onChange={() => updateProxy({ mode: 'system' })}
          />
          <SettingsDivider />
          <SettingsInput
            label="HTTP_PROXY"
            value={settings.proxy.httpProxy}
            disabled={settings.proxy.mode !== 'manual'}
            placeholder={
              language === 'zh'
                ? '127.0.0.1:7890 或 http://127.0.0.1:7890'
                : '127.0.0.1:7890 or http://127.0.0.1:7890'
            }
            onChange={(value) => updateProxy({ httpProxy: value })}
          />
          <SettingsInput
            label="HTTPS_PROXY"
            value={settings.proxy.httpsProxy}
            disabled={settings.proxy.mode !== 'manual'}
            placeholder={
              language === 'zh'
                ? '127.0.0.1:7890 或 http://127.0.0.1:7890'
                : '127.0.0.1:7890 or http://127.0.0.1:7890'
            }
            onChange={(value) => updateProxy({ httpsProxy: value })}
          />
          <SettingsInput
            label="NO_PROXY"
            value={settings.proxy.noProxy}
            disabled={settings.proxy.mode !== 'manual'}
            placeholder="127.0.0.1,localhost,::1,.internal"
            onChange={(value) => updateProxy({ noProxy: value })}
          />
          <SettingsDivider />
          <SettingsSwitch
            title={language === 'zh' ? '隐私浏览 / 不保存 Cookie' : 'Private browsing'}
            subtitle={
              backendCapabilities.browserPrivacyMode
                ? language === 'zh'
                  ? '开启后浏览器工具不会读取或保存 cookie/localStorage；默认关闭以保持登录态。'
                  : 'When enabled, browser tools do not read or save cookie/localStorage. Off keeps signed-in state.'
                : language === 'zh'
                  ? '当前 BushServer 未声明 browser_privacy_mode，前端不会发送该模式。'
                  : 'The current BushServer does not advertise browser_privacy_mode, so this mode is not sent.'
            }
            checked={settings.browser.privacyMode}
            disabled={!backendCapabilities.browserPrivacyMode}
            onChange={(checked) =>
              updateSettings((current) => ({
                ...current,
                browser: {
                  ...current.browser,
                  privacyMode: checked,
                },
              }))
            }
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
          maxContextTokens={maxContextTokens}
          maxCompletionTokens={maxCompletionTokens}
          showApiKey={showApiKey}
          onProviderSelectionChange={setProviderSelection}
          onCustomProviderChange={setCustomProvider}
          onApiKeyChange={setApiKey}
          onModelNameChange={setModelName}
          onBaseUrlChange={setBaseUrl}
          onMaxContextTokensChange={setMaxContextTokens}
          onMaxCompletionTokensChange={setMaxCompletionTokens}
          onShowApiKeyChange={setShowApiKey}
          onAddModelConfig={addModelConfig}
          onResetModels={resetModels}
          onRemoveModelConfig={removeModelConfig}
          onUpdateModelContextTokens={updateModelContextTokens}
          onUpdateModelCompletionTokens={updateModelCompletionTokens}
          onUseModel={useModel}
        />
      );
    }
    if (section === 'bots') {
      if (!backendCapabilities.botControl) {
        return (
          <SettingsCard
            title={language === 'zh' ? 'Bot 连接' : 'Bot links'}
            subtitle={
              language === 'zh'
                ? 'Bot 适配器独立运行，BushServer 不管理其配置与进程。'
                : 'Bot adapters run independently; BushServer does not manage their configuration or processes.'
            }
          >
            <div className="maintenance-action-row">
              <AlertCircle size={18} />
              <span>
                <strong>
                  {language === 'zh' ? '未连接 Bot 管理服务' : 'Bot manager not connected'}
                </strong>
                <small>
                  {language === 'zh'
                    ? '请通过独立适配器或其管理服务配置、登录和启停 Bot；聊天与会话交接仍由 BushServer 提供。'
                    : 'Configure, sign in, and control Bots through an independent adapter or manager; BushServer still provides chat and session handoff.'}
                </small>
              </span>
            </div>
          </SettingsCard>
        );
      }
      return (
        <BotSettingsPanel
          language={language}
          modelConfigs={settings.managedModelConfigs}
          selectedModel={selectedModel}
        />
      );
    }
    if (section === 'subagents') {
      return (
        <SubagentsPanel
          language={language}
          embedded
          capabilities={backendCapabilities}
        />
      );
    }
    if (section === 'mcp') {
      return (
        <McpServersPanel
          language={language}
          capabilities={backendCapabilities}
          onNotify={notify}
        />
      );
    }
    if (section === 'cache') {
      return (
        <CacheMaintenancePanel
          language={language}
          capabilities={backendCapabilities}
          onNotify={notify}
          onConversationHistoryCleared={onConversationHistoryCleared}
          runtimeBusy={runtimeBusy}
          onRuntimeAssetsReloaded={onRuntimeAssetsReloaded}
        />
      );
    }
    if (section === 'diagnostics') {
      return (
        <DiagnosticsPanel
          language={language}
          settings={settings}
          selectedModel={selectedModel}
          onSettingsChange={updateSettings}
        />
      );
    }
    if (section === 'mobile') {
      return <MobileSettingsPanel language={language} />;
    }
    return <AboutSettingsPanel language={language} />;
  })();
  const SectionIcon = settingsIcons[section];

  return (
    <>
    <main className="settings-shell">
      <aside className="settings-sidebar">
        <button className="back-button" type="button" onClick={onBack}>
          <ArrowLeft size={18} />
          {language === 'zh' ? '返回应用' : 'Back to app'}
        </button>
        <nav className="settings-navigation" aria-label={language === 'zh' ? '设置分类' : 'Settings sections'}>
          {settingsNavigationGroups.map((group) => (
            <div className="settings-nav-group" key={group.label.en}>
              <span className="settings-nav-group-label">{group.label[language]}</span>
              {group.sections.map((id) => {
                const Icon = settingsIcons[id];
                return (
                  <button
                    key={id}
                    className={`settings-nav ${section === id ? 'active' : ''}`}
                    type="button"
                    aria-current={section === id ? 'page' : undefined}
                    onClick={() => setSection(id)}
                  >
                    <Icon size={18} />
                    <span>{settingsLabels[id][language]}</span>
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>
      <SidebarResizer language={language} onWidthChange={onSidebarWidthChange} />
      <section className="settings-content">
        <div className="settings-track">
          <header className="settings-page-header">
            <span className="settings-page-icon"><SectionIcon size={20} /></span>
            <div>
              <h2>{settingsLabels[section][language]}</h2>
              <p>{settingsDescriptions[section][language]}</p>
            </div>
          </header>
          {content}
        </div>
      </section>
    </main>
    {toast && <div className="settings-toast">{toast}</div>}
    </>
  );
}

function SettingsProfilePanel({
  themePreference,
  lightThemeStyle,
  language,
  languageMode,
  systemLanguage,
  settings,
  reasoningStreamAvailable,
  backgroundImageSource,
  conversations,
  onThemePreferenceChange,
  onLightThemeStyleChange,
  onLanguageModeChange,
  onSettingsChange,
  onImportFont,
  onResetFont,
  onImportBackgroundImage,
  onResetBackgroundImage,
}: {
  themePreference: ThemePreference;
  lightThemeStyle: LightThemeStyle;
  language: AppLanguage;
  languageMode: AppLanguageMode;
  systemLanguage: AppLanguage;
  settings: AppSettingsState;
  reasoningStreamAvailable: boolean;
  backgroundImageSource: string;
  conversations: ConversationSummary[];
  onThemePreferenceChange: (value: ThemePreference) => void;
  onLightThemeStyleChange: (value: LightThemeStyle) => void;
  onLanguageModeChange: (value: AppLanguageMode) => void;
  onSettingsChange: (updater: (current: AppSettingsState) => AppSettingsState) => void;
  onImportFont: () => void;
  onResetFont: () => void;
  onImportBackgroundImage: () => void;
  onResetBackgroundImage: () => void;
}) {
  const fontIsCustom = Boolean(settings.font.family && settings.font.filePath);
  const backgroundImagePath = settings.backgroundImagePath.trim();
  const backgroundIsCustom = Boolean(backgroundImagePath);
  const backgroundPreviewStyle = backgroundIsCustom
    ? ({
        backgroundImage: cssImageUrl(
          backgroundImageSource || backgroundImageUrl(backgroundImagePath),
        ),
      } as CSSProperties)
    : undefined;

  return (
    <div className="settings-stack personalization-settings-stack">
      <UsageStatisticsPanel language={language} conversations={conversations} />
      <SettingsCard
        title={language === 'zh' ? '外观' : 'Appearance'}
        subtitle={
          language === 'zh'
            ? '配置主题、语言、背景和全局字体。'
            : 'Configure theme, language, background, and global font.'
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
        {language === 'zh' ? '背景图片' : 'Background image'}
      </SettingsGroupTitle>
      <div
        className={`background-preview ${backgroundIsCustom ? 'has-image' : ''}`}
        style={backgroundPreviewStyle}
      >
        <span>
          <Image size={16} />
          <strong>
            {backgroundIsCustom
              ? basename(backgroundImagePath)
              : language === 'zh'
                ? '未设置自定义背景'
                : 'No custom background'}
          </strong>
        </span>
        {backgroundIsCustom && <small>{backgroundImagePath}</small>}
      </div>
      <div className="settings-actions">
        <button
          className="secondary-button"
          type="button"
          onClick={onImportBackgroundImage}
        >
          <Upload size={14} />
          {language === 'zh' ? '选择背景图片' : 'Choose image'}
        </button>
        <button
          className="secondary-button"
          type="button"
          disabled={!backgroundIsCustom}
          onClick={onResetBackgroundImage}
        >
          <RotateCcw size={14} />
          {language === 'zh' ? '清除背景' : 'Clear background'}
        </button>
      </div>
      <SettingsDivider />
      <SettingsGroupTitle>
        {language === 'zh' ? 'Shadow 消息' : 'Shadow messages'}
      </SettingsGroupTitle>
      <div className="shadow-color-setting">
        <label>
          <input
            type="color"
            value={settings.shadow.accentColor}
            onChange={(event) => {
              const accentColor = event.currentTarget.value;
              onSettingsChange((current) => ({
                ...current,
                shadow: { ...current.shadow, accentColor },
              }));
            }}
          />
          <span>
            <strong>{language === 'zh' ? '提示颜色' : 'Accent color'}</strong>
            <small>{settings.shadow.accentColor}</small>
          </span>
        </label>
      </div>
      {reasoningStreamAvailable && (
        <>
          <SettingsDivider />
          <SettingsGroupTitle>
            {language === 'zh' ? '思考过程' : 'Thinking'}
          </SettingsGroupTitle>
          <SettingsSwitch
            title={language === 'zh' ? '显示思考过程' : 'Show thinking'}
            subtitle={
              language === 'zh'
                ? '仅在运行中的输入框上沿显示，不写入主对话。'
                : 'Show it only above the composer during a loop, never in the conversation.'
            }
            checked={settings.thinking.visible}
            onChange={(visible) => {
              onSettingsChange((current) => ({
                ...current,
                thinking: { ...current.thinking, visible },
              }));
            }}
          />
          <div className={`shadow-color-setting${settings.thinking.visible ? '' : ' disabled'}`}>
            <label>
              <input
                type="color"
                value={settings.thinking.accentColor}
                disabled={!settings.thinking.visible}
                onChange={(event) => {
                  const accentColor = event.currentTarget.value;
                  onSettingsChange((current) => ({
                    ...current,
                    thinking: { ...current.thinking, accentColor },
                  }));
                }}
              />
              <span>
                <strong>{language === 'zh' ? '思考颜色' : 'Thinking color'}</strong>
                <small>{settings.thinking.accentColor}</small>
              </span>
            </label>
          </div>
        </>
      )}
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
      </SettingsCard>
    </div>
  );
}

function UsageStatisticsPanel({
  language,
  conversations,
}: {
  language: AppLanguage;
  conversations: ConversationSummary[];
}) {
  const [statistics, setStatistics] = useState<CumulativeUsageStatistics | null>(null);
  const [loading, setLoading] = useState(true);
  const refreshKey = conversations
    .map((conversation) => `${conversation.id}:${conversation.updatedAt}`)
    .join('|');

  useEffect(() => {
    let active = true;
    setLoading(true);
    void loadCumulativeUsageStatistics(conversations)
      .then((result) => {
        if (active) setStatistics(result);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [refreshKey]);

  const heatmap = useMemo(
    () => usageHeatmap(statistics?.activity ?? [], language),
    [language, statistics?.activity],
  );
  const stats = statistics ?? emptyCumulativeUsageStatistics;
  const numberLocale = language === 'zh' ? 'zh-CN' : 'en-US';
  const statItems = [
    {
      label: language === 'zh' ? '累计 Token' : 'Total tokens',
      value: formatUsageNumber(stats.totalTokens, numberLocale),
      exact: stats.totalTokens,
    },
    {
      label: language === 'zh' ? '输入 Token' : 'Input tokens',
      value: formatUsageNumber(stats.promptTokens, numberLocale),
      exact: stats.promptTokens,
    },
    {
      label: language === 'zh' ? '输出 Token' : 'Output tokens',
      value: formatUsageNumber(stats.completionTokens, numberLocale),
      exact: stats.completionTokens,
    },
    {
      label: language === 'zh' ? '活跃天数' : 'Active days',
      value: new Intl.NumberFormat(numberLocale).format(stats.activeDays),
      exact: stats.activeDays,
    },
  ];

  return (
    <SettingsCard
      title={language === 'zh' ? '累计使用量' : 'Cumulative usage'}
      subtitle={
        language === 'zh'
          ? '汇总全部本地会话的真实 Token 用量与最近一年的对话活跃度。'
          : 'Summarizes real token usage across local conversations and chat activity over the past year.'
      }
    >
      <div className="usage-stat-grid" aria-busy={loading}>
        {statItems.map((item) => (
          <div className="usage-stat" key={item.label} title={new Intl.NumberFormat(numberLocale).format(item.exact)}>
            <span>{item.label}</span>
            <strong>{loading ? '—' : item.value}</strong>
          </div>
        ))}
      </div>
      <div className="usage-activity-header">
        <div>
          <strong>{language === 'zh' ? '使用活跃度' : 'Usage activity'}</strong>
          <span>
            {language === 'zh'
              ? `${stats.conversationCount} 个会话 · 最长连续 ${stats.longestStreak} 天`
              : `${stats.conversationCount} conversations · ${stats.longestStreak}-day longest streak`}
          </span>
        </div>
        {loading && <LoaderCircle className="spin" size={15} aria-hidden="true" />}
      </div>
      <div className="usage-heatmap-scroll" aria-label={language === 'zh' ? '最近一年使用活跃度' : 'Usage activity in the past year'}>
        <div className="usage-heatmap-frame">
          <div className="usage-month-labels" aria-hidden="true">
            {heatmap.monthLabels.map((label, index) => <span key={`${label}-${index}`}>{label}</span>)}
          </div>
          <div className="usage-weekday-labels" aria-hidden="true">
            <span>{language === 'zh' ? '一' : 'M'}</span>
            <span>{language === 'zh' ? '三' : 'W'}</span>
            <span>{language === 'zh' ? '五' : 'F'}</span>
          </div>
          <div className="usage-heatmap-grid">
            {heatmap.days.map((day) => (
              <span
                className={`usage-heatmap-cell level-${day.level}${day.future ? ' future' : ''}`}
                key={day.date}
                title={day.future ? '' : usageDayTitle(day.date, day.interactions, language)}
                aria-hidden="true"
              />
            ))}
          </div>
        </div>
      </div>
      <div className="usage-legend">
        <span>{language === 'zh' ? '少' : 'Less'}</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <i className={`usage-heatmap-cell level-${level}`} key={level} />
        ))}
        <span>{language === 'zh' ? '多' : 'More'}</span>
      </div>
      {!loading && stats.failedSessionCount > 0 && (
        <p className="usage-partial-note">
          {language === 'zh'
            ? `${stats.failedSessionCount} 个会话暂时无法读取，当前统计为可用数据。`
            : `${stats.failedSessionCount} conversations could not be read; available data is shown.`}
        </p>
      )}
    </SettingsCard>
  );
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
  maxContextTokens,
  maxCompletionTokens,
  showApiKey,
  onProviderSelectionChange,
  onCustomProviderChange,
  onApiKeyChange,
  onModelNameChange,
  onBaseUrlChange,
  onMaxContextTokensChange,
  onMaxCompletionTokensChange,
  onShowApiKeyChange,
  onAddModelConfig,
  onResetModels,
  onRemoveModelConfig,
  onUpdateModelContextTokens,
  onUpdateModelCompletionTokens,
  onUseModel,
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
  maxContextTokens: string;
  maxCompletionTokens: string;
  showApiKey: boolean;
  onProviderSelectionChange: (value: string) => void;
  onCustomProviderChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onModelNameChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onMaxContextTokensChange: (value: string) => void;
  onMaxCompletionTokensChange: (value: string) => void;
  onShowApiKeyChange: (value: boolean) => void;
  onAddModelConfig: (event?: FormEvent) => void;
  onResetModels: () => void;
  onRemoveModelConfig: (id: string) => void;
  onUpdateModelContextTokens: (id: string, value: string) => void;
  onUpdateModelCompletionTokens: (id: string, value: string) => void;
  onUseModel: (model: string) => void;
}) {
  const grouped = groupModelConfigs(settings.managedModelConfigs);
  const providers = Object.keys(grouped).sort();
  const [modelDiscovery, setModelDiscovery] = useState<{
    status: 'idle' | 'loading' | 'ready' | 'error';
    endpoint: string;
    models: string[];
    message: string;
  }>({
    status: 'idle',
    endpoint: '',
    models: [],
    message: '',
  });

  useEffect(() => {
    setModelDiscovery((current) =>
      current.status === 'idle'
        ? current
        : { status: 'idle', endpoint: '', models: [], message: '' },
    );
  }, [apiKey, baseUrl]);

  const fetchProviderModels = useCallback(async () => {
    const trimmedBaseUrl = baseUrl.trim();
    const trimmedApiKey = apiKey.trim();
    if (!trimmedBaseUrl) {
      setModelDiscovery({
        status: 'error',
        endpoint: '',
        models: [],
        message: language === 'zh' ? '请先填写 base_url' : 'Enter base_url first',
      });
      return;
    }
    if (!trimmedApiKey) {
      setModelDiscovery({
        status: 'error',
        endpoint: '',
        models: [],
        message: language === 'zh' ? '请先填写 api_key' : 'Enter api_key first',
      });
      return;
    }
    let endpoint = '';
    try {
      endpoint = modelListEndpoint(trimmedBaseUrl);
    } catch (caught) {
      setModelDiscovery({
        status: 'error',
        endpoint: '',
        models: [],
        message: errorMessage(caught),
      });
      return;
    }
    setModelDiscovery({
      status: 'loading',
      endpoint,
      models: [],
      message: language === 'zh' ? '正在请求 /models...' : 'Requesting /models...',
    });
    try {
      const result = await requestProviderModels(trimmedBaseUrl, trimmedApiKey);
      setModelDiscovery({
        status: 'ready',
        endpoint: result.endpoint,
        models: result.models,
        message:
          result.models.length > 0
            ? language === 'zh'
              ? `已获取 ${result.models.length} 个模型`
              : `Loaded ${result.models.length} models`
            : language === 'zh'
              ? '请求成功，但响应里没有可用模型 id'
              : 'Request succeeded, but no model ids were found',
      });
      if (!modelName.trim() && result.models[0]) {
        onModelNameChange(result.models[0]);
      }
    } catch (caught) {
      setModelDiscovery({
        status: 'error',
        endpoint,
        models: [],
        message: errorMessage(caught),
      });
    }
  }, [apiKey, baseUrl, language, modelName, onModelNameChange]);

  return (
    <div className="settings-stack">
      <SettingsCard
        title={language === 'zh' ? '添加模型' : 'Add model'}
        subtitle={
          language === 'zh'
            ? '连接模型服务，选择模型并保存。'
            : 'Connect a provider, choose a model, and save it.'
        }
      >
        <form className="model-form" onSubmit={onAddModelConfig}>
          <div className="model-form-grid">
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
            <SettingsInput
              label="base_url"
              value={baseUrl}
              placeholder="https://api.openai.com/v1"
              onChange={onBaseUrlChange}
            />
          </div>
          {providerSelection === customProviderValue && (
            <SettingsInput
              label={language === 'zh' ? '模型商名称' : 'Provider name'}
              value={customProvider}
              placeholder="myprovider"
              onChange={onCustomProviderChange}
            />
          )}
          <div className="model-credentials-row">
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
            <button
              className="secondary-button model-fetch-button"
              type="button"
              disabled={modelDiscovery.status === 'loading'}
              onClick={() => void fetchProviderModels()}
            >
              {modelDiscovery.status === 'loading' ? (
                <LoaderCircle size={14} />
              ) : (
                <RefreshCw size={14} />
              )}
              {language === 'zh' ? '获取模型列表' : 'Fetch models'}
            </button>
          </div>
          {modelDiscovery.status !== 'idle' && (
            <div className={`model-discovery-panel ${modelDiscovery.status}`}>
              <div className="model-discovery-head">
                <strong>{modelDiscovery.message}</strong>
                {modelDiscovery.endpoint && <code>{modelDiscovery.endpoint}</code>}
              </div>
              {modelDiscovery.models.length > 0 && (
                <div className="model-discovery-list">
                  {modelDiscovery.models.slice(0, 24).map((model) => (
                    <button
                      key={model}
                      className={modelName.trim() === model ? 'active' : ''}
                      type="button"
                      onClick={() => onModelNameChange(model)}
                    >
                      {model}
                    </button>
                  ))}
                  {modelDiscovery.models.length > 24 && (
                    <span>
                      +{modelDiscovery.models.length - 24}
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="model-form-grid model-form-grid-final">
            <SettingsInput
              label={language === 'zh' ? '模型名称' : 'Model name'}
              value={modelName}
              placeholder="gpt-4.1-mini"
              onChange={onModelNameChange}
            />
            <SettingsInput
              label={language === 'zh' ? '最大上下文 token' : 'Max context tokens'}
              value={maxContextTokens}
              placeholder={String(defaultMaxContextTokens)}
              onChange={onMaxContextTokensChange}
            />
            <SettingsInput
              label={
                language === 'zh'
                  ? '最大输出 token（可选）'
                  : 'Max output tokens (optional)'
              }
              value={maxCompletionTokens}
              placeholder={language === 'zh' ? '供应商默认' : 'Provider default'}
              onChange={onMaxCompletionTokensChange}
            />
          </div>
          <div className="settings-actions">
            <button className="primary-button" type="submit">
              <Plus size={14} />
              {language === 'zh' ? '添加模型' : 'Add model'}
            </button>
            <button className="secondary-button danger" type="button" onClick={onResetModels}>
              <RotateCcw size={14} />
              {language === 'zh' ? '清空全部' : 'Clear all'}
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
        <SettingsCard
          title={language === 'zh' ? '已配置模型' : 'Configured models'}
          subtitle={
            language === 'zh'
              ? `${settings.managedModelConfigs.length} 个模型`
              : `${settings.managedModelConfigs.length} models`
          }
        >
          <div className="model-provider-list">
            {providers.map((provider) => (
              <section className="model-provider-group" key={provider}>
                <header>
                  <strong>{provider}</strong>
                  <span>{grouped[provider].length}</span>
                </header>
                {grouped[provider].map((config) => (
                  <ModelConfigRow
                    key={config.id}
                    config={config}
                    language={language}
                    selected={selectedModel === config.id}
                    onUse={() => onUseModel(config.id)}
                    onDelete={() => onRemoveModelConfig(config.id)}
                    onSaveContextTokens={(value) =>
                      onUpdateModelContextTokens(config.id, value)
                    }
                    onSaveCompletionTokens={(value) =>
                      onUpdateModelCompletionTokens(config.id, value)
                    }
                  />
                ))}
              </section>
            ))}
          </div>
        </SettingsCard>
      )}
    </div>
  );
}

function CacheMaintenancePanel({
  language,
  capabilities,
  onNotify,
  onConversationHistoryCleared,
  runtimeBusy,
  onRuntimeAssetsReloaded,
}: {
  language: AppLanguage;
  capabilities: BackendCapabilities;
  onNotify: (message: string) => void;
  onConversationHistoryCleared?: () => void | Promise<void>;
  runtimeBusy: boolean;
  onRuntimeAssetsReloaded?: (categories: RuntimeAssetCategory[]) => Promise<void>;
}) {
  const [busyTarget, setBusyTarget] = useState<'conversation' | 'logs' | ''>('');
  const [result, setResult] = useState<MaintenanceClearResult | null>(null);
  const [error, setError] = useState('');

  const runClear = useCallback(
    async (target: 'conversation' | 'logs') => {
      if (busyTarget) {
        return;
      }
      const supported =
        target === 'conversation'
          ? capabilities.maintenanceConversationHistoryClear
          : capabilities.maintenanceLogsCacheClear;
      if (!supported) {
        setError(
          language === 'zh'
            ? 'BushServer 尚未提供这个缓存维护接口。'
            : 'BushServer does not expose this cache maintenance API yet.',
        );
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
        const message = errorMessage(caught);
        setError(
          message.includes('404')
            ? language === 'zh'
              ? 'BushServer 尚未提供缓存维护接口，请后端接入 maintenance clear API 后再使用。'
              : 'BushServer does not expose the cache maintenance API yet.'
            : message,
        );
      } finally {
        setBusyTarget('');
      }
    },
    [busyTarget, capabilities, language, onConversationHistoryCleared, onNotify],
  );
  const conversationClearSupported = capabilities.maintenanceConversationHistoryClear;
  const logsClearSupported = capabilities.maintenanceLogsCacheClear;

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
              disabled={Boolean(busyTarget) || !conversationClearSupported}
              onClick={() => void runClear('conversation')}
              title={
                conversationClearSupported
                  ? undefined
                  : language === 'zh'
                    ? '后端尚未提供此接口'
                    : 'Backend API is not available yet'
              }
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
              disabled={Boolean(busyTarget) || !logsClearSupported}
              onClick={() => void runClear('logs')}
              title={
                logsClearSupported
                  ? undefined
                  : language === 'zh'
                    ? '后端尚未提供此接口'
                    : 'Backend API is not available yet'
              }
            >
              {busyTarget === 'logs' ? <LoaderCircle size={14} /> : <Trash2 size={14} />}
              {language === 'zh' ? '清空' : 'Clear'}
            </button>
          </div>
        </div>
        {(!conversationClearSupported || !logsClearSupported) && (
          <p className="bot-settings-error">
            {language === 'zh'
              ? '部分缓存维护能力尚未由 BushServer 暴露，已暂时禁用对应按钮。'
              : 'Some cache maintenance capabilities are not exposed by BushServer yet, so the matching buttons are disabled.'}
          </p>
        )}
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
      <RuntimeAssetResetCard
        language={language}
        capabilities={capabilities}
        runtimeBusy={runtimeBusy}
        onNotify={onNotify}
        onRuntimeAssetsReloaded={onRuntimeAssetsReloaded}
      />
    </div>
  );
}

const runtimeAssetCategoryOrder: RuntimeAssetCategory[] = ['prompts', 'skills', 'tools'];

function RuntimeAssetResetCard({
  language,
  capabilities,
  runtimeBusy,
  onNotify,
  onRuntimeAssetsReloaded,
}: {
  language: AppLanguage;
  capabilities: BackendCapabilities;
  runtimeBusy: boolean;
  onNotify: (message: string) => void;
  onRuntimeAssetsReloaded?: (categories: RuntimeAssetCategory[]) => Promise<void>;
}) {
  const available = capabilities.maintenanceRuntimeAssetsReset &&
    capabilities.runtimeAssetResetProtocol === RUNTIME_ASSET_RESET_PROTOCOL;
  const supportedCategories = capabilities.runtimeAssetResetCategories.length > 0
    ? capabilities.runtimeAssetResetCategories
    : runtimeAssetCategoryOrder;
  const [selected, setSelected] = useState<Set<RuntimeAssetCategory>>(
    () => new Set(runtimeAssetCategoryOrder),
  );
  const [plan, setPlan] = useState<RuntimeAssetResetPlan | null>(null);
  const [result, setResult] = useState<RuntimeAssetResetResult | null>(
    readPendingRuntimeAssetReset,
  );
  const [activeChildTasks, setActiveChildTasks] = useState(0);
  const [busy, setBusy] = useState<'inspect' | 'reset' | 'verify' | ''>('');
  const [error, setError] = useState('');
  const [restartVerified, setRestartVerified] = useState(false);
  const [serviceLogs, setServiceLogs] = useState<{
    chain: unknown[];
    toolFailures: unknown[];
  } | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);

  const refreshInspection = useCallback(async () => {
    if (!available) return;
    setBusy('inspect');
    try {
      const [nextPlan, runtime] = await Promise.all([
        fetchRuntimeAssetResetPlan(),
        capabilities.subagents
          ? fetchSubagentRuntime().catch(() => null)
          : Promise.resolve(null),
      ]);
      setPlan(nextPlan);
      setActiveChildTasks(runtime?.activeTasks.length ?? 0);
      setError('');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy('');
    }
  }, [available, capabilities.subagents]);

  useEffect(() => {
    void refreshInspection();
  }, [refreshInspection]);

  useEffect(() => {
    setSelected((current) => new Set(
      [...current].filter((category) => supportedCategories.includes(category)),
    ));
  }, [supportedCategories.join('|')]);

  const selectedCategories = runtimeAssetCategoryOrder.filter(
    (category) => selected.has(category) && supportedCategories.includes(category),
  );
  const runtimeActive = runtimeBusy || activeChildTasks > 0;
  const requiresRestart = Boolean(result?.restartRequired && !restartVerified);

  const toggleCategory = (category: RuntimeAssetCategory) => {
    if (busy || requiresRestart) return;
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(category)) next.delete(category);
      else next.add(category);
      return next;
    });
  };

  const runReset = useCallback(async () => {
    if (!available || busy || selectedCategories.length === 0 || runtimeActive) return;
    setError('');
    if (capabilities.subagents) {
      try {
        const runtime = await fetchSubagentRuntime();
        setActiveChildTasks(runtime.activeTasks.length);
        if (runtime.activeTasks.length > 0) {
          setError(language === 'zh'
            ? '仍有子 Agent 任务在运行，请等待或停止任务后再重置。'
            : 'Subagent tasks are still active. Wait for or stop them before resetting.');
          return;
        }
      } catch {
        // The reset endpoint remains the final authority for runtime-idle checks.
      }
    }
    const confirmed = window.confirm(
      language === 'zh'
        ? `确定恢复 ${selectedCategories.map((item) => runtimeAssetCategoryLabel(item, language)).join('、')} 吗？\n\n所选类别中的本地修改、运行时自定义包、过期文件和工具启用覆盖将被永久移除。`
        : `Restore ${selectedCategories.map((item) => runtimeAssetCategoryLabel(item, language)).join(', ')}?\n\nLocal edits, runtime-only packages, stale files, and tool enable overrides in the selected categories will be permanently removed.`,
    );
    if (!confirmed) return;
    setBusy('reset');
    try {
      const next = await resetRuntimeAssets(selectedCategories);
      setResult(next);
      setRestartVerified(false);
      persistPendingRuntimeAssetReset(next.restartRequired ? next : null);
      onNotify(next.changed
        ? language === 'zh' ? '内置配置已恢复，重启 BushServer 后生效' : 'Bundled assets restored; restart BushServer to apply'
        : language === 'zh' ? '配置已与内置版本一致' : 'Runtime assets already match the bundled version');
    } catch (caught) {
      if (
        isBushServerHttpError(caught, 409) &&
        caught.code === 'runtime_asset_reset_requires_idle_runtime'
      ) {
        setError(language === 'zh'
          ? '检测到主 Agent 或子 Agent 正在运行。请先结束所有任务，再重新手动执行重置。'
          : 'A parent or child turn is active. Stop all tasks, then start the reset again manually.');
      } else if (
        isBushServerHttpError(caught, 409) &&
        caught.code === 'runtime_asset_reset_confirmation_required'
      ) {
        setError(language === 'zh'
          ? '后端未收到有效确认，本次没有执行任何重置。'
          : 'The backend did not receive valid confirmation. Nothing was reset.');
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      setBusy('');
    }
  }, [
    available,
    busy,
    capabilities.subagents,
    language,
    onNotify,
    runtimeActive,
    selectedCategories,
  ]);

  const verifyRestart = useCallback(async () => {
    if (!result?.restartRequired || busy) return;
    setBusy('verify');
    setError('');
    try {
      await onRuntimeAssetsReloaded?.(result.selectedCategories);
      setRestartVerified(true);
      persistPendingRuntimeAssetReset(null);
      await refreshInspection();
      onNotify(language === 'zh'
        ? 'BushServer 已就绪，配置能力已重新加载'
        : 'BushServer is ready and runtime capabilities were reloaded');
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy('');
    }
  }, [busy, language, onNotify, onRuntimeAssetsReloaded, refreshInspection, result]);

  const loadServiceLogs = useCallback(async () => {
    if (loadingLogs) return;
    setLoadingLogs(true);
    try {
      setServiceLogs(await fetchRuntimeMaintenanceLogs());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setLoadingLogs(false);
    }
  }, [loadingLogs]);

  return (
    <SettingsCard
      title={language === 'zh' ? '恢复内置配置包' : 'Restore bundled runtime assets'}
      subtitle={language === 'zh'
        ? '将 Prompts、Skills 或 Tools 精确恢复为当前 BushServer 随附的内置版本。这是破坏性维护操作。'
        : 'Restore Prompts, Skills, or Tools exactly to the versions bundled with the current BushServer build. This is destructive maintenance.'}
    >
      <div className="runtime-asset-reset-panel">
        <div className="runtime-asset-category-grid">
          {runtimeAssetCategoryOrder.map((category) => {
            const supported = supportedCategories.includes(category);
            return (
              <label key={category} className={!supported ? 'disabled' : ''}>
                <input
                  type="checkbox"
                  checked={supported && selected.has(category)}
                  disabled={!available || !supported || Boolean(busy) || requiresRestart}
                  onChange={() => toggleCategory(category)}
                />
                <span>
                  <strong>{runtimeAssetCategoryLabel(category, language)}</strong>
                  <small>{runtimeAssetCategoryDescription(category, language)}</small>
                </span>
              </label>
            );
          })}
        </div>

        <div className="runtime-asset-reset-warning">
          <AlertCircle size={17} />
          <span>{language === 'zh'
            ? '会删除所选类别中的本地编辑、运行时安装包、过期文件和工具启用覆盖。项目文件与对话历史不受影响。'
            : 'Removes local edits, runtime-installed packages, stale files, and tool enable overrides in selected categories. Project files and conversations are not affected.'}</span>
        </div>

        {runtimeActive && (
          <p className="bot-settings-error">
            {language === 'zh'
              ? `运行时正忙${activeChildTasks > 0 ? `（${activeChildTasks} 个子任务）` : ''}，重置已禁用。`
              : `The runtime is busy${activeChildTasks > 0 ? ` (${activeChildTasks} child tasks)` : ''}; reset is disabled.`}
          </p>
        )}
        {!available && (
          <p className="bot-settings-error">
            {language === 'zh'
              ? '当前 BushServer 未声明 runtime asset reset 能力。'
              : 'The current BushServer does not advertise runtime asset reset.'}
          </p>
        )}
        {error && (
          <div className="runtime-asset-reset-error">
            <p className="bot-settings-error">{error}</p>
            <button className="secondary-button" type="button" onClick={() => void loadServiceLogs()}>
              {loadingLogs ? <LoaderCircle size={14} /> : <Clipboard size={14} />}
              {language === 'zh' ? '查看服务日志' : 'View service logs'}
            </button>
          </div>
        )}

        {serviceLogs && (
          <details className="runtime-asset-service-logs" open>
            <summary>{language === 'zh' ? '最近服务日志' : 'Recent service logs'}</summary>
            <pre>{JSON.stringify(serviceLogs, null, 2)}</pre>
          </details>
        )}

        <div className="runtime-asset-reset-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={!available || Boolean(busy) || runtimeActive || requiresRestart || selectedCategories.length === 0}
            onClick={() => void runReset()}
          >
            {busy === 'reset' ? <LoaderCircle size={14} /> : <PackageOpen size={14} />}
            {language === 'zh' ? '恢复所选配置' : 'Restore selected assets'}
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={!available || Boolean(busy)}
            onClick={() => void refreshInspection()}
          >
            {busy === 'inspect' ? <LoaderCircle size={14} /> : <RefreshCw size={14} />}
            {language === 'zh' ? '检查状态' : 'Inspect status'}
          </button>
        </div>

        {result && <RuntimeAssetResetResultView result={result} language={language} />}

        {requiresRestart && (
          <div className="runtime-asset-restart-required" role="alert">
            <RotateCcw size={18} />
            <span>
              <strong>{language === 'zh' ? '必须重启 BushServer' : 'BushServer restart required'}</strong>
              <small>{language === 'zh'
                ? '配置已经写入，但尚未激活。请先在服务管理器或运行后端的终端中重启 BushServer，然后再验证。'
                : 'Assets were written but are not active yet. Restart BushServer in its service manager or terminal, then verify.'}</small>
            </span>
            <button
              className="primary-button"
              type="button"
              disabled={busy === 'verify' || !onRuntimeAssetsReloaded}
              onClick={() => void verifyRestart()}
            >
              {busy === 'verify' ? <LoaderCircle size={14} /> : <Check size={14} />}
              {language === 'zh' ? '我已重启，验证并加载' : 'Restarted — verify and reload'}
            </button>
          </div>
        )}

        {plan && (
          <details className="runtime-asset-paths">
            <summary>{language === 'zh' ? '查看内置来源与运行时路径' : 'View bundled source and runtime paths'}</summary>
            {runtimeAssetCategoryOrder.map((category) => {
              const location = plan.categories[category];
              if (!location) return null;
              return (
                <div key={category}>
                  <strong>{runtimeAssetCategoryLabel(category, language)}</strong>
                  <code title={location.sourcePath}>{location.sourcePath}</code>
                  <code title={location.targetPath}>{location.targetPath}</code>
                </div>
              );
            })}
          </details>
        )}
      </div>
    </SettingsCard>
  );
}

function RuntimeAssetResetResultView({
  result,
  language,
}: {
  result: RuntimeAssetResetResult;
  language: AppLanguage;
}) {
  return (
    <div className="runtime-asset-reset-result">
      <strong>{result.changed
        ? language === 'zh' ? '恢复结果' : 'Restore result'
        : language === 'zh' ? '已经是内置版本' : 'Already matches bundled assets'}</strong>
      <div>
        {result.selectedCategories.map((category) => {
          const item = result.categories[category];
          if (!item) return null;
          return (
            <span key={category}>
              <b>{runtimeAssetCategoryLabel(category, language)}</b>
              <small>
                {language === 'zh'
                  ? `恢复 ${item.restoredFileCount} · 删除 ${item.removedRuntimeFileCount} · 内置 ${item.seedFileCount}`
                  : `restored ${item.restoredFileCount} · removed ${item.removedRuntimeFileCount} · bundled ${item.seedFileCount}`}
              </small>
            </span>
          );
        })}
      </div>
    </div>
  );
}

function runtimeAssetCategoryLabel(category: RuntimeAssetCategory, language: AppLanguage) {
  const labels = {
    prompts: { zh: 'Prompts', en: 'Prompts' },
    skills: { zh: 'Skills', en: 'Skills' },
    tools: { zh: 'Tools', en: 'Tools' },
  } as const;
  return labels[category][language];
}

function runtimeAssetCategoryDescription(category: RuntimeAssetCategory, language: AppLanguage) {
  const descriptions = {
    prompts: { zh: '系统提示词与内置模板', en: 'System prompts and bundled templates' },
    skills: { zh: '内置技能包及其文件', en: 'Bundled skill packages and files' },
    tools: { zh: '工具包、配置与启用覆盖', en: 'Tool packages, configuration, and enable overrides' },
  } as const;
  return descriptions[category][language];
}

function readPendingRuntimeAssetReset(): RuntimeAssetResetResult | null {
  try {
    const raw = window.localStorage.getItem(pendingRuntimeAssetResetStorageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RuntimeAssetResetResult;
    return parsed?.restartRequired === true && Array.isArray(parsed.selectedCategories)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function persistPendingRuntimeAssetReset(result: RuntimeAssetResetResult | null) {
  if (!result) {
    window.localStorage.removeItem(pendingRuntimeAssetResetStorageKey);
    return;
  }
  window.localStorage.setItem(pendingRuntimeAssetResetStorageKey, JSON.stringify(result));
}

function DiagnosticsPanel({
  language,
  settings,
  selectedModel,
  onSettingsChange,
}: {
  language: AppLanguage;
  settings: AppSettingsState;
  selectedModel: string;
  onSettingsChange: (updater: (current: AppSettingsState) => AppSettingsState) => void;
}) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<DiagnosticResult | null>(null);
  const modelInfo = resolveEffectiveModelInfo(settings, selectedModel, language);
  const desktopAuthAvailable = Boolean(window.cardbushDesktop?.bushHeaders);
  const authLabels = useMemo(
    () => {
      const labels = [
        desktopAuthAvailable ? 'Electron X-Bush-Local-Key' : '',
        settings.backendAuth.bearerToken ? 'frontend Bearer token' : '',
        settings.backendAuth.localRequestKey ? 'frontend local key' : '',
      ]
        .filter(Boolean);
      return labels.length
        ? labels.join(' / ')
        : language === 'zh'
          ? '(未配置)'
          : '(not configured)';
    },
    [
      desktopAuthAvailable,
      language,
      settings.backendAuth.bearerToken,
      settings.backendAuth.localRequestKey,
    ],
  );

  const updateBackendAuth = useCallback(
    (patch: Partial<AppSettingsState['backendAuth']>) => {
      onSettingsChange((current) => ({
        ...current,
        backendAuth: {
          ...current.backendAuth,
          ...patch,
        },
      }));
    },
    [onSettingsChange],
  );

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
        <SettingsInput
          label={language === 'zh' ? '后端 Bearer token' : 'Backend Bearer token'}
          type="password"
          value={settings.backendAuth.bearerToken}
          placeholder="BUSH_API_AUTH_TOKEN"
          onChange={(value) => updateBackendAuth({ bearerToken: value })}
        />
        <SettingsInput
          label={language === 'zh' ? '本地请求 key' : 'Local request key'}
          type="password"
          value={settings.backendAuth.localRequestKey}
          placeholder="X-Bush-Local-Key"
          onChange={(value) => updateBackendAuth({ localRequestKey: value })}
        />
        <p className="settings-muted">
          {language === 'zh'
            ? 'Electron 会自动注入本地 key；浏览器/Vite 调试时可在这里填 Bearer token 或 local key。'
            : 'Electron injects the local key automatically; browser/Vite debugging can use a Bearer token or local key here.'}
        </p>
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

function BotSettingsPanel({
  language,
  modelConfigs,
  selectedModel,
}: {
  language: AppLanguage;
  modelConfigs: ManagedModelConfig[];
  selectedModel: string;
}) {
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
  const [qrImageSrc, setQrImageSrc] = useState('');
  const [qrImageFailed, setQrImageFailed] = useState(false);
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
  const selectedEnabled =
    selectedStatus?.enabled ?? selectedOverview?.enabled ?? false;
  const selectedConfigured =
    selectedStatus?.configured ?? selectedOverview?.configured ?? false;
  const selectedMissingFields =
    selectedStatus?.missingRequiredFields ??
    selectedOverview?.missingRequiredFields ??
    [];
  const selectedServiceStatus =
    selectedStatus?.serviceStatus ?? selectedOverview?.serviceStatus ?? 'stopped';
  const selectedLastError = botServiceDetailText(selectedStatus, selectedOverview, language);
  const selectedModelConfig = useMemo(
    () => modelConfigForBot(modelConfigs, selectedModel),
    [modelConfigs, selectedModel],
  );
  const selectedModelInfo = selectedModelConfig
    ? `${selectedModelConfig.provider} / ${selectedModelConfig.modelName}`
    : selectedModel.trim() || (language === 'zh' ? '未选择' : 'not selected');

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

  const loadLogs = useCallback(
    async (platform: BotPlatform, options?: { silent?: boolean }) => {
      if (!options?.silent) {
        setBusyKey(`logs:${platform}`);
        setError('');
      }
      try {
        const logs = await fetchBotServiceLogs({ platform, tail: 200 });
        setLogsByPlatform((current) => ({ ...current, [platform]: logs.lines }));
      } catch (caught) {
        if (!options?.silent) {
          setError(botPanelError(caught, language));
        }
      } finally {
        if (!options?.silent) {
          setBusyKey('');
        }
      }
    },
    [language],
  );

  const runServiceAction = useCallback(
    async (platform: BotPlatform, action: 'start' | 'stop' | 'restart') => {
      const status = statusByPlatform[platform];
      const overview = overviewByPlatform.get(platform);
      const platformEnabled = status?.enabled ?? overview?.enabled ?? false;
      const platformConfigured = status?.configured ?? overview?.configured ?? false;
      const missingFields =
        status?.missingRequiredFields ?? overview?.missingRequiredFields ?? [];
      if ((action === 'start' || action === 'restart') && !platformEnabled) {
        setError(
          language === 'zh'
            ? `${botPlatformLabels[platform][language]} Bot 当前未启用。请先加载配置，将 enabled 设置为 true 并保存，然后再启动服务。`
            : `${botPlatformLabels[platform][language]} bot is disabled. Load its config, set enabled to true, save it, then start the service.`,
        );
        return;
      }
      if ((action === 'start' || action === 'restart') && !platformConfigured) {
        setError(botMissingConfigurationText(platform, missingFields, language));
        return;
      }
      setBusyKey(`service:${platform}:${action}`);
      setError('');
      try {
        const status = await controlBotService(platform, action);
        setStatusByPlatform((current) => ({ ...current, [platform]: status }));
        if (status.serviceStatus === 'failed') {
          setError(botServiceDetailText(status, overviewByPlatform.get(platform), language));
          void loadLogs(platform, { silent: true }).catch(() => undefined);
        } else {
          notify(
            action === 'stop'
              ? language === 'zh'
                ? '停止请求已发送，服务状态已刷新'
                : 'Stop request sent and service status refreshed'
              : language === 'zh'
                ? '服务命令已发送'
                : 'Service command sent',
          );
        }
      } catch (caught) {
        setError(botPanelError(caught, language));
      } finally {
        setBusyKey('');
      }
    },
    [
      language,
      loadLogs,
      notify,
      overviewByPlatform,
      statusByPlatform,
    ],
  );

  const beginWeixinLogin = useCallback(async () => {
    setBusyKey('weixin:login');
    setLoginStart(null);
    setLoginStatus(null);
    setQrImageSrc('');
    setQrImageFailed(false);
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
    setQrImageFailed(false);
    setQrImageSrc('');
    const source = loginStart?.qrcodeUrl.trim() ?? '';
    if (!source) {
      return undefined;
    }
    let cancelled = false;
    async function renderQr() {
      if (isDirectImageSource(source)) {
        setQrImageSrc(source);
        return;
      }
      try {
        const qrcode = await import('qrcode');
        const image = await qrcode.toDataURL(source, {
          errorCorrectionLevel: 'M',
          margin: 2,
          width: 512,
          color: {
            dark: '#111111',
            light: '#ffffff',
          },
        });
        if (!cancelled) {
          setQrImageSrc(image);
        }
      } catch {
        if (!cancelled) {
          setQrImageFailed(true);
        }
      }
    }
    void renderQr();
    return () => {
      cancelled = true;
    };
  }, [loginStart?.qrcodeUrl]);

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
            const enabled = status?.enabled ?? overview?.enabled ?? false;
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
                <span className="bot-platform-icon-wrap">
                  <BotPlatformIcon platform={platform} />
                  <span className={`bot-status-dot ${botStatusTone(serviceStatus)}`} />
                </span>
                <span className="bot-platform-copy">
                  <strong>{botPlatformLabels[platform][language]}</strong>
                  <small>
                    {!enabled
                      ? language === 'zh'
                        ? '未启用'
                        : 'Disabled'
                      : configured
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
          <span className={`bot-status-dot ${botStatusTone(selectedServiceStatus)}`} />
          <div>
            <strong>
              {botServiceStatusText(selectedServiceStatus, language)}
            </strong>
            <small>
              {selectedLastError ||
                (language === 'zh'
                  ? '暂无错误信息'
                  : 'No error reported')}
            </small>
          </div>
        </div>
        <InfoRow
          label={language === 'zh' ? '使用模型' : 'Model'}
          value={selectedModelInfo}
        />
        {selectedModelConfig && (
          <p className="settings-muted">
            {language === 'zh'
              ? 'Bot 启动时由 BushServer 统一模型配置的默认槽位注入 provider / model / api_key / base_url。'
              : 'Bot startup uses the default slot from BushServer model configs for provider / model / api_key / base_url.'}
          </p>
        )}
        {(!selectedEnabled || !selectedConfigured) && (
          <p className="bot-settings-warning">
            {!selectedEnabled
              ? language === 'zh'
                ? '当前平台未启用，BushServer 会拒绝启动请求。请先在配置中将 enabled 设置为 true 并保存。'
                : 'This platform is disabled, so BushServer will reject start requests. Set enabled to true and save it first.'
              : botMissingConfigurationText(
                  selectedPlatform,
                  selectedMissingFields,
                  language,
                )}
          </p>
        )}
        <div className="settings-actions">
          {(['start', 'stop', 'restart'] as const).map((action) => (
            <button
              className="secondary-button"
              key={action}
              type="button"
              disabled={
                busyKey === `service:${selectedPlatform}:${action}` ||
                ((!selectedEnabled || !selectedConfigured) && action !== 'stop')
              }
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
              <div
                className={`weixin-qr-frame ${
                  qrImageSrc && !qrImageFailed ? '' : 'failed'
                }`}
              >
                {qrImageSrc && (
                  <img
                    src={qrImageSrc}
                    alt="WeChat login QR code"
                    onLoad={() => setQrImageFailed(false)}
                    onError={() => setQrImageFailed(true)}
                  />
                )}
                {(!qrImageSrc || qrImageFailed) && (
                  <span>
                    {language === 'zh'
                      ? '正在生成二维码；如果长时间不显示，请复制链接在浏览器打开，或重新开始扫码。'
                      : 'Generating QR code. If it does not appear, copy the link or start again.'}
                  </span>
                )}
              </div>
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
              onChange={(event) => {
                const value = event.currentTarget.value;
                setConfigDraftByPlatform((current) => ({
                  ...current,
                  [selectedPlatform]: value,
                }));
              }}
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

type McpServerDraft = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  transport: McpTransport;
  command: string;
  argsText: string;
  cwd: string;
  envText: string;
  url: string;
  headersText: string;
  timeoutSeconds: string;
};

const emptyMcpDraft: McpServerDraft = {
  id: '',
  name: '',
  description: '',
  enabled: true,
  transport: 'stdio',
  command: '',
  argsText: '',
  cwd: '',
  envText: '{}',
  url: '',
  headersText: '{}',
  timeoutSeconds: '60',
};

function McpServersPanel({
  language,
  capabilities,
  onNotify,
}: {
  language: AppLanguage;
  capabilities: BackendCapabilities;
  onNotify: (message: string) => void;
}) {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState<McpServerDraft>(emptyMcpDraft);
  const [editorOpen, setEditorOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState('');
  const [error, setError] = useState('');
  const [validation, setValidation] = useState<McpServerValidationResult | null>(null);
  const selectedIdRef = useRef('');

  const selectServerId = useCallback((serverId: string) => {
    selectedIdRef.current = serverId;
    setSelectedId(serverId);
  }, []);

  const loadServers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await fetchMcpServers();
      setServers(result.servers);
      const currentId = selectedIdRef.current;
      const selected =
        result.servers.find((server) => server.id === currentId) ??
        result.servers[0];
      if (selected) {
        if (selected.id !== currentId) {
          selectServerId(selected.id);
        }
        setDraft(mcpDraftFromServer(selected));
      } else if (currentId) {
        selectServerId('');
        setDraft(emptyMcpDraft);
      }
    } catch (caught) {
      setError(mcpErrorText(caught, language));
    } finally {
      setLoading(false);
    }
  }, [language, selectServerId]);

  useEffect(() => {
    void loadServers();
  }, [loadServers]);

  const updateDraft = useCallback((patch: Partial<McpServerDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
  }, []);

  const startNew = useCallback(() => {
    selectServerId('');
    setDraft(emptyMcpDraft);
    setEditorOpen(true);
    setValidation(null);
    setError('');
  }, [selectServerId]);

  const selectServer = useCallback((server: McpServerConfig) => {
    selectServerId(server.id);
    setDraft(mcpDraftFromServer(server));
    setEditorOpen(true);
    setValidation(null);
    setError('');
  }, [selectServerId]);

  const makeInput = useCallback(
    (): McpServerConfigInput => mcpDraftToInput(draft, language),
    [draft, language],
  );

  const validateServer = useCallback(async () => {
    setBusyKey('validate');
    setError('');
    setValidation(null);
    try {
      const result = await validateMcpServerConfig(makeInput());
      setValidation(result);
      onNotify(
        result.ok
          ? language === 'zh'
            ? 'MCP 配置校验通过'
            : 'MCP config validation passed'
          : language === 'zh'
            ? 'MCP 配置校验未通过'
            : 'MCP config validation failed',
      );
    } catch (caught) {
      setError(mcpErrorText(caught, language));
    } finally {
      setBusyKey('');
    }
  }, [language, makeInput, onNotify]);

  const saveServer = useCallback(async () => {
    setBusyKey('save');
    setError('');
    try {
      const saved = await saveMcpServerConfig(makeInput());
      selectServerId(saved.id);
      setDraft(mcpDraftFromServer(saved));
      setValidation(null);
      await loadServers();
      onNotify(language === 'zh' ? 'MCP 服务配置已保存' : 'MCP server saved');
    } catch (caught) {
      setError(mcpErrorText(caught, language));
    } finally {
      setBusyKey('');
    }
  }, [language, loadServers, makeInput, onNotify, selectServerId]);

  const toggleServer = useCallback(
    async (server: McpServerConfig) => {
      const nextEnabled = !server.enabled;
      setBusyKey(`toggle:${server.id}`);
      setError('');
      try {
        await setMcpServerEnabled(server.id, nextEnabled);
        await loadServers();
        onNotify(
          nextEnabled
            ? language === 'zh'
              ? 'MCP 服务已启用'
              : 'MCP server enabled'
            : language === 'zh'
              ? 'MCP 服务已停用'
              : 'MCP server disabled',
        );
      } catch (caught) {
        setError(mcpErrorText(caught, language));
      } finally {
        setBusyKey('');
      }
    },
    [language, loadServers, onNotify],
  );

  const removeServer = useCallback(
    async (server: McpServerConfig) => {
      const confirmed = window.confirm(
        language === 'zh'
          ? `确定删除 MCP 服务 ${server.name || server.id} 吗？`
          : `Delete MCP server ${server.name || server.id}?`,
      );
      if (!confirmed) {
        return;
      }
      setBusyKey(`delete:${server.id}`);
      setError('');
      try {
        await deleteMcpServerConfig(server.id);
        if (selectedId === server.id) {
          startNew();
        }
        await loadServers();
        onNotify(language === 'zh' ? 'MCP 服务已删除' : 'MCP server deleted');
      } catch (caught) {
        setError(mcpErrorText(caught, language));
      } finally {
        setBusyKey('');
      }
    },
    [language, loadServers, onNotify, selectedId, startNew],
  );

  const selectedServer = servers.find((server) => server.id === selectedId);
  const pluginServers = servers.filter(mcpServerIsFromPlugin);
  const userServers = servers.filter((server) => !mcpServerIsFromPlugin(server));
  const capabilityUndeclared = !capabilities.mcpServers;

  return (
    <div className="mcp-simple-page">
      <header className="mcp-page-header">
        <div>
          <h3>{language === 'zh' ? 'MCP 服务器' : 'MCP servers'}</h3>
          <p>
            {language === 'zh'
              ? '连接外部工具和数据源。'
              : 'Connect external tools and data sources.'}
            <a
              className="mcp-inline-link"
              href="https://modelcontextprotocol.io"
              target="_blank"
              rel="noreferrer"
            >
              {language === 'zh' ? '了解更多。' : 'Learn more.'}
            </a>
          </p>
        </div>
      </header>

      {capabilityUndeclared && (
        <p className="bot-settings-error">
          {language === 'zh'
            ? '当前 /v1/capabilities 未声明 mcp_servers；后端接口上线后这里会直接可用。'
            : '/v1/capabilities does not declare mcp_servers yet. This panel will work once backend endpoints are exposed.'}
        </p>
      )}
      {error && <p className="bot-settings-error">{error}</p>}

      <section className="mcp-simple-section">
        <div className="mcp-section-title">
          <strong>{language === 'zh' ? '服务器' : 'Servers'}</strong>
          <button className="mcp-add-button" type="button" onClick={startNew}>
            <Plus size={16} />
            {language === 'zh' ? '添加服务器' : 'Add server'}
          </button>
        </div>
        <div className="mcp-simple-list">
          {loading ? (
            <div className="mcp-empty-row">
              <LoaderCircle size={16} />
              <span>{language === 'zh' ? '正在加载' : 'Loading'}</span>
            </div>
          ) : userServers.length === 0 ? (
            <div className="mcp-empty-row">
              <span>{language === 'zh' ? '暂无服务器' : 'No servers'}</span>
            </div>
          ) : (
            userServers.map((server) => (
              <div className="mcp-simple-row" key={server.id}>
                <McpLogoIcon className="mcp-logo-icon" size={18} />
                <strong>{server.name || server.id}</strong>
                <button
                  className="mcp-icon-button"
                  type="button"
                  title={language === 'zh' ? '配置' : 'Configure'}
                  onClick={() => selectServer(server)}
                >
                  <Settings size={16} />
                </button>
                <button
                  className={`mcp-toggle ${server.enabled ? 'on' : ''}`}
                  type="button"
                  disabled={Boolean(busyKey)}
                  title={server.enabled ? (language === 'zh' ? '停用' : 'Disable') : (language === 'zh' ? '启用' : 'Enable')}
                  onClick={() => void toggleServer(server)}
                >
                  <span />
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      {pluginServers.length > 0 && (
        <section className="mcp-simple-section">
          <div className="mcp-section-title">
            <strong>{language === 'zh' ? '来自插件' : 'From plugins'}</strong>
          </div>
          <div className="mcp-simple-list">
            {pluginServers.map((server) => (
              <div className="mcp-simple-row plugin" key={server.id}>
                <McpLogoIcon className="mcp-logo-icon" size={18} />
                <strong>{server.name || server.id}</strong>
                <button
                  className={`mcp-toggle ${server.enabled ? 'on' : ''}`}
                  type="button"
                  disabled={Boolean(busyKey)}
                  onClick={() => void toggleServer(server)}
                >
                  <span />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      {editorOpen && (
        <section className="mcp-editor-panel">
          <div className="mcp-section-title">
            <strong>
              {selectedId
                ? language === 'zh'
                  ? '配置服务器'
                  : 'Configure server'
                : language === 'zh'
                  ? '添加服务器'
                  : 'Add server'}
            </strong>
            <button
              className="mcp-icon-button"
              type="button"
              onClick={() => {
                setEditorOpen(false);
                setValidation(null);
              }}
            >
              ×
            </button>
          </div>
          <div className="mcp-compact-form">
            <SettingsInput
              label={language === 'zh' ? '名称' : 'Name'}
              value={draft.name}
              placeholder="node_repl"
              onChange={(value) => updateDraft({ name: value })}
            />
            <label className="settings-field">
              <span>{language === 'zh' ? '连接方式' : 'Connection'}</span>
              <select
                value={draft.transport}
                onChange={(event) => updateDraft({ transport: event.currentTarget.value as McpTransport })}
              >
                <option value="stdio">stdio</option>
                <option value="sse">SSE</option>
                <option value="streamable_http">HTTP stream</option>
                <option value="http">HTTP</option>
              </select>
            </label>
            {draft.transport === 'stdio' ? (
              <SettingsInput
                label={language === 'zh' ? '启动命令' : 'Command'}
                value={draft.command}
                placeholder="npx @modelcontextprotocol/server-filesystem C:\\Users\\wfang\\Desktop"
                onChange={(value) => updateDraft({ command: value })}
              />
            ) : (
              <SettingsInput
                label="URL"
                value={draft.url}
                placeholder="http://127.0.0.1:3000/sse"
                onChange={(value) => updateDraft({ url: value })}
              />
            )}
          </div>
          <details className="mcp-advanced">
            <summary>{language === 'zh' ? '高级设置' : 'Advanced settings'}</summary>
            <div className="mcp-form-grid">
              <SettingsInput
                label="id"
                value={draft.id}
                placeholder="filesystem"
                onChange={(value) => updateDraft({ id: value })}
              />
              <SettingsInput
                label={language === 'zh' ? '超时秒数' : 'Timeout seconds'}
                value={draft.timeoutSeconds}
                placeholder="60"
                onChange={(value) => updateDraft({ timeoutSeconds: value })}
              />
              <SettingsInput
                label={language === 'zh' ? '工作目录' : 'Working directory'}
                value={draft.cwd}
                placeholder="C:\\Users\\..."
                onChange={(value) => updateDraft({ cwd: value })}
              />
              <SettingsInput
                label={language === 'zh' ? '描述' : 'Description'}
                value={draft.description}
                placeholder={language === 'zh' ? '这个 MCP 服务提供什么工具' : 'What this MCP server provides'}
                onChange={(value) => updateDraft({ description: value })}
              />
            </div>
            <div className="mcp-form-grid">
              <label className="mcp-editor">
                <span>env JSON</span>
                <textarea
                  value={draft.envText}
                  placeholder="{&#10;  &quot;API_KEY&quot;: &quot;...&quot;&#10;}"
                  onChange={(event) => updateDraft({ envText: event.currentTarget.value })}
                />
              </label>
              <label className="mcp-editor">
                <span>headers JSON</span>
                <textarea
                  value={draft.headersText}
                  placeholder="{&#10;  &quot;Authorization&quot;: &quot;Bearer ...&quot;&#10;}"
                  onChange={(event) => updateDraft({ headersText: event.currentTarget.value })}
                />
              </label>
            </div>
          </details>
          <div className="settings-actions">
            <button className="secondary-button" type="button" disabled={Boolean(busyKey)} onClick={() => void validateServer()}>
              {busyKey === 'validate' ? <LoaderCircle size={14} /> : <CheckCircle2 size={14} />}
              {language === 'zh' ? '校验' : 'Validate'}
            </button>
            <button className="primary-button" type="button" disabled={Boolean(busyKey)} onClick={() => void saveServer()}>
              {busyKey === 'save' ? <LoaderCircle size={14} /> : <Upload size={14} />}
              {language === 'zh' ? '保存' : 'Save'}
            </button>
            {selectedServer && (
              <button
                className="secondary-button danger"
                type="button"
                disabled={Boolean(busyKey)}
                onClick={() => void removeServer(selectedServer)}
              >
                {busyKey === `delete:${selectedServer.id}` ? <LoaderCircle size={14} /> : <Trash2 size={14} />}
                {language === 'zh' ? '删除' : 'Delete'}
              </button>
            )}
          </div>
          {validation && (
            <div className={`subagent-validation ${validation.ok ? 'ok' : 'invalid'}`}>
              <strong>
                {validation.ok
                  ? language === 'zh'
                    ? '校验通过'
                    : 'Validation passed'
                  : language === 'zh'
                    ? '校验未通过'
                    : 'Validation failed'}
                {validation.tools.length ? ` · tools: ${validation.tools.length}` : ''}
              </strong>
              {validation.messages.length > 0 ? (
                validation.messages.map((message, index) => (
                  <p key={`${message.severity}-${message.path}-${index}`}>
                    {message.severity}
                    {message.path ? ` · ${message.path}` : ''}: {message.message}
                  </p>
                ))
              ) : (
                <p>
                  {validation.tools.length
                    ? validation.tools.join(', ')
                    : language === 'zh'
                      ? '后端未返回错误。'
                      : 'No backend messages returned.'}
                </p>
              )}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function mcpDraftFromServer(server: McpServerConfig): McpServerDraft {
  return {
    id: server.id,
    name: server.name,
    description: server.description,
    enabled: server.enabled,
    transport: server.transport,
    command: mcpCommandLineFromServer(server),
    argsText: '',
    cwd: server.cwd ?? '',
    envText: jsonRecordText(server.env),
    url: server.url ?? '',
    headersText: jsonRecordText(server.headers),
    timeoutSeconds: server.timeoutSeconds ? String(server.timeoutSeconds) : '60',
  };
}

function mcpDraftToInput(
  draft: McpServerDraft,
  language: AppLanguage,
): McpServerConfigInput {
  const commandParts =
    draft.transport === 'stdio' ? splitMcpCommandLine(draft.command.trim()) : [];
  const id =
    draft.id.trim() ||
    mcpSlug(draft.name || commandParts[0] || draft.url) ||
    'mcp-server';
  const timeoutSeconds = Number(draft.timeoutSeconds);
  if (draft.timeoutSeconds.trim() && (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0)) {
    throw new Error(language === 'zh' ? '超时秒数必须大于 0' : 'Timeout must be greater than 0');
  }
  const env = draft.transport === 'stdio'
    ? parseStringRecordText(draft.envText, 'env', language)
    : {};
  const headers = draft.transport !== 'stdio'
    ? parseStringRecordText(draft.headersText, 'headers', language)
    : {};
  const args = draft.argsText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (draft.transport === 'stdio' && commandParts.length === 0) {
    throw new Error(language === 'zh' ? 'stdio 模式需要填写命令' : 'stdio transport requires a command');
  }
  if (draft.transport !== 'stdio' && !draft.url.trim()) {
    throw new Error(language === 'zh' ? '远程 MCP 模式需要填写 URL' : 'Remote MCP transport requires a URL');
  }
  return {
    id,
    name: draft.name.trim() || id,
    description: draft.description.trim(),
    enabled: draft.enabled,
    transport: draft.transport,
    command: draft.transport === 'stdio' ? commandParts[0] : '',
    args: draft.transport === 'stdio' ? [...commandParts.slice(1), ...args] : [],
    cwd: draft.cwd.trim(),
    env,
    url: draft.url.trim(),
    headers,
    ...(Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
      ? { timeoutSeconds: Math.floor(timeoutSeconds) }
      : {}),
  };
}

function mcpCommandLineFromServer(server: McpServerConfig) {
  if (!server.command) {
    return '';
  }
  return [server.command, ...server.args.map(quoteMcpArg)].filter(Boolean).join(' ');
}

function quoteMcpArg(value: string) {
  if (!/\s/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, '\\"')}"`;
}

function splitMcpCommandLine(value: string) {
  const tokens: string[] = [];
  let current = '';
  let quote = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote) {
        quote = '';
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function mcpSlug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\/+/i, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function parseStringRecordText(
  value: string,
  label: string,
  language: AppLanguage,
): Record<string, string> {
  const text = value.trim();
  if (!text || text === '{}') {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not_object');
    }
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>)
        .map(([key, item]) => [key.trim(), String(item ?? '')])
        .filter(([key]) => key),
    );
  } catch {
    throw new Error(
      language === 'zh'
        ? `${label} 必须是合法 JSON 对象`
        : `${label} must be a valid JSON object`,
    );
  }
}

function jsonRecordText(value: Record<string, string> | undefined) {
  return value && Object.keys(value).length > 0 ? JSON.stringify(value, null, 2) : '{}';
}

function mcpServerIsFromPlugin(server: McpServerConfig) {
  const raw = server.raw;
  const source = String(raw.source ?? raw.origin ?? raw.kind ?? '').toLowerCase();
  return (
    source.includes('plugin') ||
    Boolean(raw.plugin ?? raw.plugin_id ?? raw.pluginId ?? raw.plugin_name ?? raw.pluginName)
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
      ? '当前地址没有 Bot 管理 API。请连接独立 Bot 管理服务。'
      : 'This endpoint has no Bot management API. Connect an independent Bot manager.';
  }
  if (/bot is disabled/i.test(message)) {
    return language === 'zh'
      ? 'Bot 当前未启用。请先加载配置，将 enabled 设置为 true 并保存，然后再启动服务。'
      : 'Bot is disabled. Load its config, set enabled to true, save it, then start the service.';
  }
  if (/weixin bot has no logged-in account/i.test(message)) {
    return language === 'zh'
      ? '微信 Bot 还没有已登录账号。请先完成微信扫码确认，再启动服务。'
      : 'The WeChat bot has no logged-in account. Complete QR login before starting the service.';
  }
  return message;
}

function mcpErrorText(caught: unknown, language: AppLanguage) {
  const message = errorMessage(caught);
  if (message.includes('Failed to fetch')) {
    return language === 'zh'
      ? '无法连接 BushServer。请确认后端服务已启动后重试。'
      : 'Could not connect to BushServer. Start the backend and try again.';
  }
  if (message.includes('404')) {
    return language === 'zh'
      ? 'MCP 服务配置接口尚未由 BushServer 提供。'
      : 'MCP server configuration API is not available from BushServer yet.';
  }
  if (/mcp/i.test(message) && /transport/i.test(message)) {
    return language === 'zh'
      ? `MCP transport 配置无效：${message}`
      : `Invalid MCP transport config: ${message}`;
  }
  return message;
}

function modelConfigForBot(
  configs: ManagedModelConfig[],
  selectedModel: string,
) {
  const normalized = selectedModel.trim().toLowerCase();
  if (!normalized) {
    return configs.length === 1 ? configs[0] : undefined;
  }
  return configs.find(
    (config) => config.id.trim().toLowerCase() === normalized,
  ) ?? configs.find(
    (config) => config.modelName.trim().toLowerCase() === normalized,
  ) ?? (configs.length === 1 ? configs[0] : undefined);
}

function botServiceDetailText(
  status: BotStatusResult | undefined,
  overview: BotPlatformOverview | undefined,
  language: AppLanguage,
) {
  const explicitError = status?.lastError ?? overview?.lastError ?? '';
  if (explicitError) {
    return explicitError;
  }
  if (status?.serviceStatus === 'failed') {
    if (status.returnCode != null) {
      return language === 'zh'
        ? `服务进程已退出，退出码 ${status.returnCode}。停止请求已送达，但进程此前/当前以失败状态结束；可查看下方日志或重新启动。`
        : `The service process exited with code ${status.returnCode}. The stop request was accepted, but the process ended in a failed state. Check logs or restart.`;
    }
    return language === 'zh'
      ? '服务处于失败状态，但后端没有返回错误详情；可加载日志查看原因。'
      : 'The service is failed, but BushServer returned no error detail. Load logs to inspect it.';
  }
  if (status?.serviceStatus === 'stopped' && status.stoppedAt) {
    return language === 'zh'
      ? `已停止于 ${formatBotStatusTime(status.stoppedAt)}`
      : `Stopped at ${formatBotStatusTime(status.stoppedAt)}`;
  }
  if (status?.serviceStatus === 'running' && status.pid != null) {
    return language === 'zh'
      ? `运行中，PID ${status.pid}`
      : `Running, PID ${status.pid}`;
  }
  return language === 'zh' ? '暂无错误信息' : 'No error reported';
}

function formatBotStatusTime(value: string) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    return value;
  }
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(timestamp);
}

function isDirectImageSource(value: string) {
  const source = value.trim();
  return (
    /^data:image\//i.test(source) ||
    /^(blob:|file:)/i.test(source) ||
    /\.(png|jpe?g|gif|webp|svg)([?#].*)?$/i.test(source)
  );
}

function botMissingConfigurationText(
  platform: BotPlatform,
  missingFields: string[],
  language: AppLanguage,
) {
  if (platform === 'weixin' && missingFields.includes('weixin_account')) {
    return language === 'zh'
      ? '微信 Bot 还没有已登录账号。请先在“微信扫码登录”里扫码并确认，成功连接后再启动服务。'
      : 'The WeChat bot has no logged-in account. Scan and confirm the QR login first, then start the service.';
  }
  if (missingFields.length > 0) {
    const fields = missingFields.join(', ');
    return language === 'zh'
      ? `当前平台缺少必填配置：${fields}。请加载配置、补齐并保存后再启动服务。`
      : `This platform is missing required config: ${fields}. Load, complete, and save the config before starting.`;
  }
  return language === 'zh'
    ? '当前平台配置尚未完成。请加载配置、补齐并保存后再启动服务。'
    : 'This platform is not fully configured. Load, complete, and save the config before starting.';
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

const emptyCumulativeUsageStatistics: CumulativeUsageStatistics = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  promptCacheHitTokens: 0,
  promptCacheMissTokens: 0,
  conversationCount: 0,
  activeDays: 0,
  longestStreak: 0,
  activity: [],
  failedSessionCount: 0,
};

function formatUsageNumber(value: number, locale: string) {
  return new Intl.NumberFormat(locale, {
    notation: value >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: 1,
  }).format(value);
}

function usageHeatmap(
  activity: Array<{ date: string; interactions: number }>,
  language: AppLanguage,
) {
  const activityByDate = new Map(activity.map((day) => [day.date, day.interactions]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(start.getDate() - start.getDay() - (52 * 7));
  const visibleCounts = activity
    .filter((day) => day.date >= localDayKey(start) && day.date <= localDayKey(today))
    .map((day) => day.interactions);
  const maximum = Math.max(1, ...visibleCounts);
  const days = Array.from({ length: 53 * 7 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    const dateKey = localDayKey(date);
    const interactions = activityByDate.get(dateKey) ?? 0;
    return {
      date: dateKey,
      interactions,
      future: date > today,
      level: interactions === 0 ? 0 : Math.max(1, Math.ceil((interactions / maximum) * 4)),
    };
  });
  const formatter = new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
  });
  const monthLabels = Array.from({ length: 53 }, (_, weekIndex) => {
    const weekStart = new Date(start);
    weekStart.setDate(start.getDate() + weekIndex * 7);
    const previousWeek = new Date(weekStart);
    previousWeek.setDate(weekStart.getDate() - 7);
    return weekIndex === 0 || weekStart.getMonth() !== previousWeek.getMonth()
      ? formatter.format(weekStart)
      : '';
  });
  return { days, monthLabels };
}

function localDayKey(date: Date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function usageDayTitle(date: string, interactions: number, language: AppLanguage) {
  const formatted = new Intl.DateTimeFormat(language === 'zh' ? 'zh-CN' : 'en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${date}T00:00:00`));
  return language === 'zh'
    ? `${formatted} · ${interactions} 次对话`
    : `${formatted} · ${interactions} chat interactions`;
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
      <div className="settings-card-body">{children}</div>
    </section>
  );
}

function SettingsDivider() {
  return <div className="settings-divider" />;
}

function SettingsGroupTitle({ children }: { children: React.ReactNode }) {
  return <div className="settings-group-title">{children}</div>;
}

const gamepadButtonOptions = [
  [0, 'A'], [1, 'B'], [2, 'X'], [3, 'Y'], [4, 'LB'], [5, 'RB'],
  [8, 'View'], [9, 'Menu'], [10, 'L3'], [11, 'R3'],
] as const;

function GamepadMappingRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="os-gamepad-mapping-row">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(Number(event.currentTarget.value))}>
        {gamepadButtonOptions.map(([button, name]) => (
          <option key={button} value={button}>{name}</option>
        ))}
      </select>
    </label>
  );
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
  disabled,
  onChange,
}: {
  title: string;
  subtitle?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={`settings-switch${disabled ? ' disabled' : ''}`}>
      <span>
        <strong>{title}</strong>
        {subtitle && <small>{subtitle}</small>}
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    </label>
  );
}

function SettingsInput({
  label,
  type = 'text',
  value,
  placeholder,
  disabled,
  onChange,
}: {
  label: string;
  type?: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="settings-field">
      <span>{label}</span>
      <input
        type={type}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => onChange(event.currentTarget.value)}
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
  onSaveContextTokens,
  onSaveCompletionTokens,
}: {
  config: ManagedModelConfig;
  language: AppLanguage;
  selected: boolean;
  onUse: () => void;
  onDelete: () => void;
  onSaveContextTokens: (value: string) => void;
  onSaveCompletionTokens: (value: string) => void;
}) {
  const [contextDraft, setContextDraft] = useState(
    contextTokenDraftValue(config.maxContextTokens),
  );
  const savedContextDraft = contextTokenDraftValue(config.maxContextTokens);
  const trimmedContextDraft = contextDraft.trim();
  const hasInvalidContext =
    trimmedContextDraft.length > 0 && !normalizeMaxContextTokens(trimmedContextDraft);
  const contextDraftChanged = contextDraft !== savedContextDraft;
  const [completionDraft, setCompletionDraft] = useState(
    completionTokenDraftValue(config.maxCompletionTokens),
  );
  const savedCompletionDraft = completionTokenDraftValue(
    config.maxCompletionTokens,
  );
  const trimmedCompletionDraft = completionDraft.trim();
  const hasInvalidCompletion =
    trimmedCompletionDraft.length > 0 &&
    !normalizeMaxCompletionTokens(trimmedCompletionDraft);
  const completionDraftChanged = completionDraft !== savedCompletionDraft;

  useEffect(() => {
    setContextDraft(savedContextDraft);
  }, [savedContextDraft]);

  useEffect(() => {
    setCompletionDraft(savedCompletionDraft);
  }, [savedCompletionDraft]);

  return (
    <div className="model-row">
      <div className="model-row-summary">
        <strong>{config.modelName}</strong>
        <span>
          {config.baseUrl || (language === 'zh' ? '默认服务地址' : 'Default endpoint')}
          {' · '}
          {config.apiKey || config.hasApiKey
            ? language === 'zh' ? '凭证已保存' : 'Credential saved'
            : language === 'zh' ? '未设置凭证' : 'No credential'}
        </span>
      </div>
      <label className="model-context-editor">
        <span>{language === 'zh' ? '上下文' : 'Context'}</span>
        <div className="model-context-controls">
          <input
            aria-label={
              language === 'zh'
                ? `${config.modelName} 最大上下文 token`
                : `${config.modelName} max context tokens`
            }
            inputMode="numeric"
            min={1}
            placeholder={language === 'zh' ? '默认' : 'default'}
            type="number"
            value={contextDraft}
            onChange={(event) => setContextDraft(event.currentTarget.value)}
          />
          <button
            className="icon-button model-context-save"
            type="button"
            aria-label={language === 'zh' ? '保存上下文' : 'Save context'}
            title={language === 'zh' ? '保存上下文' : 'Save context'}
            disabled={!contextDraftChanged || hasInvalidContext}
            onClick={() => onSaveContextTokens(contextDraft)}
          >
            <Check size={14} />
          </button>
        </div>
        {hasInvalidContext && (
          <small>
            {language === 'zh' ? '请输入正整数' : 'Use a positive integer'}
          </small>
        )}
      </label>
      <label className="model-context-editor">
        <span>{language === 'zh' ? '输出' : 'Output'}</span>
        <div className="model-context-controls">
          <input
            aria-label={
              language === 'zh'
                ? `${config.modelName} 最大输出 token`
                : `${config.modelName} max output tokens`
            }
            inputMode="numeric"
            min={1}
            placeholder={language === 'zh' ? '供应商默认' : 'provider default'}
            type="number"
            value={completionDraft}
            onChange={(event) => setCompletionDraft(event.currentTarget.value)}
          />
          <button
            className="icon-button model-context-save"
            type="button"
            aria-label={language === 'zh' ? '保存输出上限' : 'Save output limit'}
            title={language === 'zh' ? '保存输出上限' : 'Save output limit'}
            disabled={!completionDraftChanged || hasInvalidCompletion}
            onClick={() => onSaveCompletionTokens(completionDraft)}
          >
            <Check size={14} />
          </button>
        </div>
        {hasInvalidCompletion && (
          <small>
            {language === 'zh' ? '请输入正整数' : 'Use a positive integer'}
          </small>
        )}
      </label>
      {selected && (
        <span className="current-badge">
          <CheckCircle2 size={13} />
          {language === 'zh' ? '当前' : 'Current'}
        </span>
      )}
      {!selected && (
        <button className="secondary-button model-use-button" type="button" onClick={onUse}>
          {language === 'zh' ? '设为当前' : 'Use'}
        </button>
      )}
      <button
        className="icon-button model-delete-button"
        type="button"
        aria-label={language === 'zh' ? `删除 ${config.modelName}` : `Delete ${config.modelName}`}
        title={language === 'zh' ? '删除模型' : 'Delete model'}
        onClick={onDelete}
      >
        <Trash2 size={14} />
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

type ProviderModelListResult = {
  endpoint: string;
  models: string[];
  rawCount: number;
};

async function requestProviderModels(
  baseUrl: string,
  apiKey: string,
): Promise<ProviderModelListResult> {
  if (window.cardbushDesktop?.listProviderModels) {
    return window.cardbushDesktop.listProviderModels(baseUrl, apiKey);
  }
  const endpoint = modelListEndpoint(baseUrl);
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${apiKey.trim()}`,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `GET /models failed (${response.status} ${response.statusText || 'HTTP error'}): ${text.slice(0, 240)}`,
    );
  }
  const payload = parseJsonRecord(text);
  const models = modelIdsFromPayload(payload);
  return {
    endpoint,
    models,
    rawCount: Array.isArray(payload.data) ? payload.data.length : models.length,
  };
}

function modelListEndpoint(baseUrl: string) {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  if (!trimmed) {
    throw new Error('Missing base_url');
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('base_url must be an http(s) URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('base_url must be an http(s) URL');
  }
  const normalizedPath = parsed.pathname.replace(/\/+$/, '');
  parsed.pathname = normalizedPath.endsWith('/models')
    ? normalizedPath
    : `${normalizedPath || ''}/models`;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function parseJsonRecord(text: string) {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

function modelIdsFromPayload(payload: Record<string, unknown>) {
  const ids = [payload.data, payload.models, payload.items].flatMap(modelIdsFromUnknown);
  return Array.from(new Set(ids.map((id) => id.trim()).filter(Boolean))).sort(
    (left, right) => left.localeCompare(right),
  );
}

function modelIdsFromUnknown(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) => {
      if (typeof item === 'string') {
        return item;
      }
      if (!isRecord(item)) {
        return '';
      }
      return String(item.id ?? item.name ?? item.model ?? '').trim();
    })
    .filter(Boolean);
}

function resolveEffectiveModelInfo(
  settings: AppSettingsState,
  selectedModel: string,
  language: AppLanguage,
): EffectiveModelInfo {
  const determinedByServer =
    language === 'zh' ? '(由 BushServer 决定)' : '(determined by BushServer)';
  const config = settings.managedModelConfigs.find(
    (item) => item.id.trim().toLowerCase() === selectedModel.trim().toLowerCase(),
  ) ?? settings.managedModelConfigs.find(
    (item) => item.modelName.trim().toLowerCase() === selectedModel.trim().toLowerCase(),
  );
  if (!config || !shouldUseManagedConfig(config)) {
    return {
      source: llmEndpoint ? 'External LLM_ENDPOINT' : language === 'zh' ? 'BushServer 默认配置' : 'BushServer default config',
      model: config?.modelName || selectedModel || determinedByServer,
      provider: determinedByServer,
      apiKeyLabel: determinedByServer,
      baseUrl: determinedByServer,
    };
  }
  return {
    source: language === 'zh' ? '托管模型配置' : 'Managed model config',
    model: config.modelName,
    provider: config.provider || (language === 'zh' ? '(未填写)' : '(not filled)'),
    apiKeyLabel:
      config.apiKeyMasked ||
      (config.hasApiKey
        ? language === 'zh' ? '(已配置)' : '(configured)'
        : maskSecret(config.apiKey, language)),
    baseUrl: config.baseUrl || (language === 'zh' ? '(未填写)' : '(not filled)'),
  };
}

function shouldUseManagedConfig(config: ManagedModelConfig) {
  return (
    config.modelName.trim() &&
    (config.provider.trim().toLowerCase() !== 'custom' ||
      config.apiKey.trim() ||
      config.hasApiKey === true ||
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
    const headers = includeAuthHeaders ? await backendRequestHeaders(endpoint) : {};
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

function cssImageUrl(value: string) {
  return `url("${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}")`;
}

function backgroundImageUrl(value: string) {
  if (!value) {
    return '';
  }
  if (/^(data:|blob:|https?:|cardbush-file:)/i.test(value)) {
    return value;
  }
  return fileUrl(value);
}

function fileUrl(value: string) {
  if (!value) {
    return '';
  }
  if (/^(data:|blob:|https?:|cardbush-file:)/i.test(value)) {
    return value;
  }
  const normalized = value.replaceAll('\\', '/');
  const prefixed = normalized.startsWith('/') ? normalized : `/${normalized}`;
  return `cardbush-file://${prefixed
    .split('/')
    .map((part, index) => (index === 0 ? part : encodeURIComponent(part)))
    .join('/')}`;
}

function normalizeProvider(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, '-');
}

function normalizeMaxContextTokens(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function normalizeMaxCompletionTokens(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function contextTokenDraftValue(value: number | undefined) {
  return String(value && value > 0 ? Math.floor(value) : defaultMaxContextTokens);
}

function completionTokenDraftValue(value: number | undefined) {
  return String(value && value > 0 ? Math.floor(value) : '');
}

function newModelConfigId() {
  return `model-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function stableModelConfigId(
  provider: string,
  modelName: string,
  apiKey: string,
  baseUrl: string,
) {
  const raw = `${provider}\n${modelName}\n${apiKey}\n${baseUrl}`;
  let hash = 2166136261;
  for (let index = 0; index < raw.length; index += 1) {
    hash ^= raw.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `model-${(hash >>> 0).toString(36)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
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
