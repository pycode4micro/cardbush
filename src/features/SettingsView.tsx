import {
  AlertCircle,
  Archive,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronUp,
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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  RUNTIME_ASSET_RESET_PROTOCOL,
  clearConversationHistory,
  clearLogsCache,
  deleteMcpServerConfig,
  fetchCardbushAppsConfiguration,
  fetchMcpServers,
  fetchBackendCapabilities,
  fetchBackendReadiness,
  fetchModelConfigs,
  fetchRuntimeAssetResetPlan,
  fetchRuntimeMaintenanceLogs,
  fetchSubagentRuntime,
  isProductHostCommandError,
  resetRuntimeAssets,
  saveCardbushAppsConfiguration,
  saveMcpServerConfig,
  setMcpServerEnabled,
  validateMcpServerConfig,
  type MaintenanceClearResult,
  type McpServerConfigInput,
} from '../backend/api';
import packageMetadata from '../../package.json';
import mcpLogoUrl from '../assets/integration-logos/mcp.svg';
import { SidebarResizer } from '../components/SidebarResizer';
import { basename } from '../shared/localPaths';
import { SubagentsPanel } from './SubagentsPanel';
import { PluginManagementPanel } from './plugins/PluginManagementPanel';
import {
  loadCumulativeUsageStatistics,
  type CumulativeUsageStatistics,
} from './settings/usageActivity';
import type {
  AppLanguage,
  AppLanguageMode,
  AppSettingsState,
  BackendCapabilities,
  CardbushAppsConfiguration,
  CardbushAppPlugin,
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
  SkillDetail,
  SkillSummary,
  ThemePreference,
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
  'subagents',
  'mcp',
  'cache',
  'models',
  'diagnostics',
  'about',
];

const settingsLabels: Record<VisibleSettingsSection, { zh: string; en: string }> = {
  profile: { zh: '个性化', en: 'Personalization' },
  os: { zh: '桌面 OS', en: 'Desktop OS' },
  runtime: { zh: '运行环境', en: 'Runtime' },
  proxy: { zh: '代理设置', en: 'Proxy' },
  subagents: { zh: '子任务运行态', en: 'Task runtime' },
  mcp: { zh: '插件', en: 'Plugins' },
  cache: { zh: '缓存', en: 'Cache' },
  models: { zh: '模型管理', en: 'Models' },
  diagnostics: { zh: '运行诊断', en: 'Runtime diagnostics' },
  about: { zh: '关于', en: 'About' },
};

const settingsDescriptions: Record<VisibleSettingsSection, { zh: string; en: string }> = {
  profile: { zh: '查看累计使用量，并统一管理主题、语言、背景与字体。', en: 'Review cumulative usage and manage theme, language, background, and typography.' },
  os: { zh: '配置桌面模式、开机启动和手柄操作。', en: 'Configure desktop mode, startup behavior, and controller input.' },
  runtime: { zh: '选择工具与终端命令使用的默认运行环境。', en: 'Choose the default runtime for tools and terminal commands.' },
  proxy: { zh: '统一管理网络代理与浏览隐私选项。', en: 'Manage network proxy and browser privacy options.' },
  subagents: { zh: '查看子任务能力、运行状态和依赖。', en: 'Inspect task-agent capabilities, runtime state, and dependencies.' },
  mcp: { zh: '管理由 Skill、MCP 与应用组成的 CardBush 插件。', en: 'Manage CardBush plugins composed of Skills, MCP servers, and apps.' },
  cache: { zh: '清理本地历史和诊断缓存。', en: 'Clear local history and diagnostic caches.' },
  models: { zh: '添加模型服务并设置默认模型。', en: 'Add model providers and choose the default model.' },
  diagnostics: { zh: '检查内嵌 Runtime、Product Host 与模型配置。', en: 'Inspect the embedded Runtime, Product Host, and model configuration.' },
  about: { zh: '查看版本与本地运行架构。', en: 'View version and local runtime architecture.' },
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
    sections: ['proxy'],
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
  subagents: Network,
  mcp: McpLogoIcon,
  cache: Archive,
  models: Cpu,
  diagnostics: Clipboard,
  about: Circle,
};

function visibleSettingsSection(value: SettingsSection): VisibleSettingsSection {
  return visibleSettingsSections.includes(value as VisibleSettingsSection)
    ? (value as VisibleSettingsSection)
    : 'profile';
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

export function SettingsView({
  active,
  onReady,
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
  skills,
  disabledSkillNames,
  initialSection,
  initialPluginTab,
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
  onToggleSkill,
  onReloadSkills,
  onLoadSkillDetail,
}: {
  active: boolean;
  onReady: () => void;
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
  skills: SkillSummary[];
  disabledSkillNames: Set<string>;
  initialSection: SettingsSection;
  initialPluginTab: 'plugins' | 'skills';
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
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  onReloadSkills: () => Promise<SkillSummary[]>;
  onLoadSkillDetail: (skillName: string) => Promise<SkillDetail>;
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
  const [pluginMcpOpen, setPluginMcpOpen] = useState(false);
  const providerOptions = useMemo(
    () => collectProviderOptions(settings.managedModelConfigs),
    [settings.managedModelConfigs],
  );

  useLayoutEffect(() => {
    onReady();
  }, [onReady]);

  useEffect(() => {
    setSection(visibleSettingsSection(initialSection));
    setPluginMcpOpen(false);
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
                ? '选择终端命令默认在哪个环境中执行。这个设置会影响内置终端，也会随对话请求传给内嵌 Runtime。'
                : 'Choose where terminal commands run by default. This affects the embedded terminal and is sent to the embedded Runtime with chat requests.'
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
          <SettingsCard
            title={language === 'zh' ? '引导方式' : 'Guidance delivery'}
            subtitle={
              language === 'zh'
                ? '设置任务运行中再次发送内容时，是等待下一轮还是立即交给当前轮次。'
                : 'Choose whether messages sent during a running task wait for the next turn or enter the active turn immediately.'
            }
          >
            <SettingsRadio
              name="guidance-delivery-mode"
              value="queue"
              title={language === 'zh' ? '加入队列' : 'Add to queue'}
              subtitle={
                language === 'zh'
                  ? '等待当前回复完成，再作为下一条消息自动发送。'
                  : 'Wait for the current response, then send it automatically as the next message.'
              }
              checked={settings.guidance.deliveryMode === 'queue'}
              onChange={() =>
                updateSettings((current) => ({
                  ...current,
                  guidance: { deliveryMode: 'queue' },
                }))
              }
            />
            <SettingsRadio
              name="guidance-delivery-mode"
              value="immediate"
              title={language === 'zh' ? '马上发送' : 'Send immediately'}
              subtitle={
                language === 'zh'
                  ? '立即提交到当前运行轮次，在下一次可用的执行边界生效。'
                  : 'Submit to the active turn now and apply it at the next available execution boundary.'
              }
              checked={settings.guidance.deliveryMode === 'immediate'}
              onChange={() =>
                updateSettings((current) => ({
                  ...current,
                  guidance: { deliveryMode: 'immediate' },
                }))
              }
            />
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
                ? '应用启动、软件识别、窗口控制和界面操作由桌面端与内嵌 Runtime 共同提供。'
                : 'App startup, discovery, window control, and UI actions are provided by the desktop host and embedded Runtime.'}
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
                ? '默认直连。代理仅用于模型提供商和远程 MCP 等外部网络请求，内嵌 Runtime 不经过代理。'
                : 'Direct connection by default. Proxies only affect external provider and remote MCP traffic; the embedded Runtime does not use them.'
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
                  ? '当前内嵌 Runtime 未声明 browser_privacy_mode，前端不会发送该模式。'
                  : 'The embedded Runtime does not advertise browser_privacy_mode, so this mode is not sent.'
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
      return pluginMcpOpen ? (
        <div className="plugin-mcp-settings">
          <button className="plugin-back" type="button" onClick={() => setPluginMcpOpen(false)}>
            <ArrowLeft size={17} />
            {language === 'zh' ? '返回插件' : 'Back to plugins'}
          </button>
          <McpServersPanel
            language={language}
            capabilities={backendCapabilities}
            onNotify={notify}
          />
        </div>
      ) : (
        <PluginManagementPanel
          language={language}
          initialTab={initialPluginTab}
          skills={skills}
          disabledSkillNames={disabledSkillNames}
          onToggleSkill={onToggleSkill}
          onReloadSkills={onReloadSkills}
          onLoadSkillDetail={onLoadSkillDetail}
          onOpenMcp={() => setPluginMcpOpen(true)}
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
        />
      );
    }
    return (
      <AboutSettingsPanel
        language={language}
        settings={settings}
        selectedModel={selectedModel}
      />
    );
  })();
  const SectionIcon = settingsIcons[section];

  return (
    <>
    <main
      className={`settings-shell${active ? '' : ' settings-inactive'}`}
      aria-hidden={!active}
      inert={active ? undefined : true}
    >
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
        <div className={`settings-track${section === 'mcp' ? ' plugin-settings-track' : ''}`}>
          {section !== 'mcp' && <header className="settings-page-header">
            <span className="settings-page-icon"><SectionIcon size={20} /></span>
            <div>
              <h2>{settingsLabels[section][language]}</h2>
              <p>{settingsDescriptions[section][language]}</p>
            </div>
          </header>}
          {content}
        </div>
      </section>
    </main>
    {active && toast && <div className="settings-toast">{toast}</div>}
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
  const [activityRange, setActivityRange] = useState<UsageHeatmapRange>('year');
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
    () => usageHeatmap(statistics?.activity ?? [], language, activityRange),
    [activityRange, language, statistics?.activity],
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
          ? '汇总全部本地会话的真实 Token 用量，并按年、月或周查看对话活跃度。'
          : 'Summarizes real token usage across local conversations with yearly, monthly, or weekly activity views.'
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
        <div className="usage-activity-actions">
          <div
            className="usage-range-switcher"
            role="group"
            aria-label={language === 'zh' ? '活跃度日期跨度' : 'Activity date range'}
          >
            {(['year', 'month', 'week'] as const).map((range) => (
              <button
                className={activityRange === range ? 'active' : ''}
                type="button"
                aria-pressed={activityRange === range}
                key={range}
                onClick={() => setActivityRange(range)}
              >
                {language === 'zh'
                  ? { year: '年', month: '月', week: '周' }[range]
                  : { year: 'Year', month: 'Month', week: 'Week' }[range]}
              </button>
            ))}
          </div>
          {loading && <LoaderCircle className="spin" size={15} aria-hidden="true" />}
        </div>
      </div>
      <div
        className="usage-heatmap-scroll"
        aria-label={language === 'zh' ? `最近${activityRange === 'year' ? '一年' : activityRange === 'month' ? '一月' : '一周'}使用活跃度` : `Usage activity for the current ${activityRange}`}
      >
        <div
          className={`usage-heatmap-frame range-${activityRange}`}
          style={{ '--usage-heatmap-columns': heatmap.weekCount } as CSSProperties}
        >
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
  const [addModelExpanded, setAddModelExpanded] = useState(false);

  const confirmResetModels = useCallback(() => {
    const count = settings.managedModelConfigs.length;
    if (count === 0) return;
    const confirmed = window.confirm(
      language === 'zh'
        ? `确定清空全部 ${count} 个模型配置吗？保存的 API Key、服务地址和 token 上限都会被移除，此操作无法撤销。`
        : `Clear all ${count} model configurations? Saved API keys, endpoints, and token limits will be removed. This cannot be undone.`,
    );
    if (confirmed) onResetModels();
  }, [language, onResetModels, settings.managedModelConfigs.length]);

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
    <div className="settings-stack model-settings-stack">
      <SettingsCard
        title={language === 'zh' ? '添加模型' : 'Add model'}
        subtitle={
          language === 'zh'
            ? '连接模型服务，选择模型并保存。'
            : 'Connect a provider, choose a model, and save it.'
        }
        bodyHidden={!addModelExpanded}
        headerAction={(
          <button
            className="secondary-button model-form-disclosure"
            type="button"
            aria-expanded={addModelExpanded}
            onClick={() => setAddModelExpanded((current) => !current)}
          >
            {addModelExpanded ? <ChevronUp size={14} /> : <Plus size={14} />}
            {addModelExpanded
              ? language === 'zh' ? '收起' : 'Collapse'
              : language === 'zh' ? '添加模型' : 'Add model'}
          </button>
        )}
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
          headerAction={(
            <button
              className="secondary-button danger model-clear-all-button"
              type="button"
              onClick={confirmResetModels}
            >
              <RotateCcw size={14} />
              {language === 'zh' ? '清空全部' : 'Clear all'}
            </button>
          )}
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
            ? 'Product Host 尚未提供这个缓存维护命令。'
            : 'Product Host does not expose this cache maintenance command yet.',
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
              ? 'Product Host 尚未提供缓存维护命令。'
              : 'Product Host does not expose the cache maintenance command yet.'
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
            ? '这些操作只清理 CardBush Runtime 本地数据库中的历史和诊断缓存，不会删除项目文件、任务工作目录或 provider 侧缓存。'
            : 'These actions clear CardBush Runtime history and diagnostics cache only. Project files, task workspaces, and provider-side caches are untouched.'
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
          <p className="settings-inline-error">
            {language === 'zh'
              ? '部分缓存维护能力尚未由 Product Host 暴露，已暂时禁用对应按钮。'
              : 'Some cache maintenance capabilities are not exposed by Product Host yet, so the matching buttons are disabled.'}
          </p>
        )}
        {error && <p className="settings-inline-error">{error}</p>}
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

const runtimeAssetCategoryOrder: RuntimeAssetCategory[] = [
  'prompts',
  'skills',
  'agent_profiles',
  'teams',
];

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
      const teamConfigurationCategory = category === 'agent_profiles' || category === 'teams';
      const affected = teamConfigurationCategory
        ? (['agent_profiles', 'teams'] as RuntimeAssetCategory[])
        : [category];
      const remove = next.has(category);
      for (const item of affected) {
        if (remove) next.delete(item);
        else if (supportedCategories.includes(item)) next.add(item);
      }
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
        // The Product Host remains the final authority for runtime-idle checks.
      }
    }
    const confirmed = window.confirm(
      language === 'zh'
          ? `确定恢复 ${selectedCategories.map((item) => runtimeAssetCategoryLabel(item, language)).join('、')} 吗？\n\n所选类别中的本地修改、运行时自定义包和过期文件将被永久移除。`
          : `Restore ${selectedCategories.map((item) => runtimeAssetCategoryLabel(item, language)).join(', ')}?\n\nLocal edits, runtime-only packages, and stale files in the selected categories will be permanently removed.`,
    );
    if (!confirmed) return;
    setBusy('reset');
    try {
      const next = await resetRuntimeAssets(selectedCategories);
      setResult(next);
      if (selectedCategories.includes('agent_profiles') || selectedCategories.includes('teams')) {
        await onRuntimeAssetsReloaded?.(selectedCategories);
      }
      setRestartVerified(false);
      persistPendingRuntimeAssetReset(next.restartRequired ? next : null);
      onNotify(next.changed
        ? language === 'zh' ? '内置配置已恢复' : 'Bundled runtime assets restored'
        : language === 'zh' ? '配置已与内置版本一致' : 'Runtime assets already match the bundled version');
    } catch (caught) {
      if (
        isProductHostCommandError(caught, 'runtime_asset_reset_requires_idle_runtime')
      ) {
        setError(language === 'zh'
          ? '检测到主 Agent 或子 Agent 正在运行。请先结束所有任务，再重新手动执行重置。'
          : 'A parent or child turn is active. Stop all tasks, then start the reset again manually.');
      } else if (
        isProductHostCommandError(caught, 'runtime_asset_reset_confirmation_required')
      ) {
        setError(language === 'zh'
          ? 'Product Host 未收到有效确认，本次没有执行任何重置。'
          : 'Product Host did not receive valid confirmation. Nothing was reset.');
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
    onRuntimeAssetsReloaded,
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
        ? 'CardBush 运行时已就绪，配置能力已重新加载'
        : 'The CardBush Runtime is ready and its capabilities were reloaded');
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
        ? '将 Prompts、Skills、Agent Profiles 或 Teams 精确恢复为当前 CardBush 随附的内置版本。这是破坏性维护操作。'
        : 'Restore Prompts, Skills, Agent Profiles, or Teams exactly to the versions bundled with the current CardBush build. This is destructive maintenance.'}
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
          <p className="settings-inline-error">
            {language === 'zh'
              ? `运行时正忙${activeChildTasks > 0 ? `（${activeChildTasks} 个子任务）` : ''}，重置已禁用。`
              : `The runtime is busy${activeChildTasks > 0 ? ` (${activeChildTasks} child tasks)` : ''}; reset is disabled.`}
          </p>
        )}
        {!available && (
          <p className="settings-inline-error">
            {language === 'zh'
              ? '当前 CardBush 产品宿主未声明 runtime asset reset 能力。'
              : 'The current CardBush Product Host does not advertise runtime asset reset.'}
          </p>
        )}
        {error && (
          <div className="runtime-asset-reset-error">
            <p className="settings-inline-error">{error}</p>
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
              <strong>{language === 'zh' ? '必须重启 CardBush' : 'CardBush restart required'}</strong>
              <small>{language === 'zh'
                ? '配置已经写入，但尚未激活。请先重启 CardBush，然后再验证。'
                : 'Assets were written but are not active yet. Restart CardBush, then verify.'}</small>
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
    agent_profiles: { zh: 'Agent Profiles', en: 'Agent Profiles' },
    teams: { zh: 'Teams', en: 'Teams' },
  } as const;
  return labels[category][language];
}

function runtimeAssetCategoryDescription(category: RuntimeAssetCategory, language: AppLanguage) {
  const descriptions = {
    prompts: { zh: '系统提示词与内置模板', en: 'System prompts and bundled templates' },
    skills: { zh: '内置技能包及其文件', en: 'Bundled skill packages and files' },
    agent_profiles: { zh: '内置 Agent 配置（与 Teams 联动恢复）', en: 'Bundled Agent profiles (restored with Teams)' },
    teams: { zh: '内置 Team 配置（与 Profiles 联动恢复）', en: 'Bundled Team definitions (restored with Profiles)' },
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
}: {
  language: AppLanguage;
  settings: AppSettingsState;
  selectedModel: string;
}) {
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<DiagnosticResult | null>(null);
  const modelInfo = resolveEffectiveModelInfo(settings, selectedModel, language);

  const runCheck = useCallback(async () => {
    if (checking) {
      return;
    }
    setChecking(true);
    try {
      const [runtime, productHost, capabilities] = await Promise.all([
        localDiagnosticProbe(
          language === 'zh' ? '内嵌 Runtime' : 'Embedded Runtime',
          async () => {
            assertDesktopRuntime();
            const readiness = await fetchBackendReadiness();
            if (readiness.ready !== true) {
              throw new Error(language === 'zh' ? 'Runtime 尚未就绪' : 'Runtime is not ready');
            }
            const versions = Array.isArray(readiness.protocolVersions)
              ? readiness.protocolVersions.join(' / ')
              : '';
            return [String(readiness.runtimeVersion ?? '').trim(), versions]
              .filter(Boolean)
              .join(' · ') || (language === 'zh' ? '已就绪' : 'Ready');
          },
        ),
        localDiagnosticProbe(
          'Product Host',
          async () => {
            assertProductHost();
            const snapshot = await fetchModelConfigs();
            return language === 'zh'
              ? `IPC 可用 · ${snapshot.models.length} 个模型配置`
              : `IPC available · ${snapshot.models.length} model configurations`;
          },
        ),
        localDiagnosticProbe(
          language === 'zh' ? '能力契约' : 'Capability contract',
          async () => {
            assertDesktopRuntime();
            const capabilities = await fetchBackendCapabilities();
            if (!capabilities.chatStream || !capabilities.sessions) {
              throw new Error(language === 'zh' ? '缺少核心对话能力' : 'Core chat capabilities are missing');
            }
            return language === 'zh'
              ? '类型化命令、事件流与会话持久化已就绪'
              : 'Typed commands, event streaming, and session persistence are ready';
          },
        ),
      ]);
      setResult({ runtime, productHost, capabilities });
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
        'runtime_transport=Electron typed IPC',
        'product_host_transport=Electron IPC',
        `model_source=${modelInfo.source}`,
        `model=${modelInfo.model}`,
        `provider=${modelInfo.provider}`,
        `api_key=${modelInfo.apiKeyLabel}`,
        `base_url=${modelInfo.baseUrl}`,
        result ? `runtime=${diagnosticSummary(result.runtime)}` : '',
        result ? `product_host=${diagnosticSummary(result.productHost)}` : '',
        result ? `capabilities=${diagnosticSummary(result.capabilities)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    );
  };

  return (
    <SettingsCard
      title={language === 'zh' ? '运行诊断' : 'Runtime diagnostics'}
      subtitle={
        language === 'zh'
          ? '检查内嵌 TypeScript Runtime、Product Host 与当前模型配置，不使用 localhost HTTP 端口。'
          : 'Check the embedded TypeScript Runtime, Product Host, and current model configuration without a localhost HTTP port.'
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
          label={language === 'zh' ? '运行传输' : 'Runtime transport'}
          value="Electron typed IPC"
        />
      </div>
      <SettingsDivider />
      <div className="settings-subblock">
        <strong>{language === 'zh' ? '本地组件检查' : 'Local component check'}</strong>
        {result ? (
          <>
            <DiagnosticRow probe={result.runtime} />
            <DiagnosticRow probe={result.productHost} />
            <DiagnosticRow probe={result.capabilities} />
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
function AboutSettingsPanel({
  language,
  settings,
  selectedModel,
}: {
  language: AppLanguage;
  settings: AppSettingsState;
  selectedModel: string;
}) {
  const modelInfo = resolveEffectiveModelInfo(settings, selectedModel, language);
  const copyEnvironment = async () => {
    await copyText([
      `CARDBUSH_VERSION=${packageMetadata.version}`,
      'RUNTIME=Embedded TypeScript Runtime',
      'RUNTIME_TRANSPORT=Electron typed IPC',
      `MODEL=${modelInfo.model}`,
      `PROVIDER=${modelInfo.provider}`,
      `MODEL_BASE_URL=${modelInfo.baseUrl}`,
    ].join('\n'));
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
      <InfoRow label={language === 'zh' ? '版本' : 'Version'} value={packageMetadata.version} />
      <InfoRow label="Runtime" value="Embedded TypeScript Runtime" />
      <InfoRow label={language === 'zh' ? '通信方式' : 'Transport'} value="Electron typed IPC" />
      <InfoRow
        label={language === 'zh' ? '当前模型' : 'Current model'}
        value={`${modelInfo.provider} / ${modelInfo.model}`}
      />
      <InfoRow label="base_url" value={modelInfo.baseUrl} />
      <div className="settings-actions">
        <button className="secondary-button" type="button" onClick={() => void copyEnvironment()}>
          <Clipboard size={14} />
          {language === 'zh' ? '复制环境信息' : 'Copy environment'}
        </button>
      </div>
    </SettingsCard>
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
        <p className="settings-inline-error">
          {language === 'zh'
            ? '当前 TypeScript Runtime 未声明 MCP 快照能力。'
            : 'The TypeScript Runtime does not expose MCP snapshot capability.'}
        </p>
      )}
      {error && <p className="settings-inline-error">{error}</p>}

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

      <CardbushAppsPanel language={language} onNotify={onNotify} />

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

function CardbushAppsPanel({
  language,
  onNotify,
}: {
  language: AppLanguage;
  onNotify: (message: string) => void;
}) {
  const [configuration, setConfiguration] = useState<CardbushAppsConfiguration | null>(null);
  const [expandedPluginId, setExpandedPluginId] = useState('');
  const [busyKey, setBusyKey] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setBusyKey('load');
    setError('');
    try {
      setConfiguration(await fetchCardbushAppsConfiguration());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusyKey('');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const persist = useCallback(async (
    next: CardbushAppsConfiguration,
    key: string,
    zh: string,
    en: string,
  ) => {
    setBusyKey(key);
    setError('');
    try {
      const saved = await saveCardbushAppsConfiguration(next);
      setConfiguration(saved);
      onNotify(language === 'zh' ? zh : en);
    } catch (caught) {
      setError(errorMessage(caught));
      await load();
    } finally {
      setBusyKey('');
    }
  }, [language, load, onNotify]);

  const replacePlugin = useCallback((plugin: CardbushAppPlugin) => {
    setConfiguration((current) => current ? {
      ...current,
      plugins: current.plugins.map((item) => item.id === plugin.id ? plugin : item),
    } : current);
  }, []);

  const serviceEnabled = configuration?.serviceEnabled === true;

  return (
    <section className="mcp-simple-section cardbush-apps-section">
      <div className="mcp-section-title">
        <div>
          <strong>CardBush Apps</strong>
          <small>{language === 'zh'
            ? '独立 MCP 插件服务；插件只在该服务内注册和执行。'
            : 'Independent MCP plugin service; apps register and run only inside it.'}</small>
        </div>
        <button
          className={`mcp-toggle ${serviceEnabled ? 'on' : ''}`}
          type="button"
          disabled={!configuration || Boolean(busyKey)}
          title={serviceEnabled
            ? language === 'zh' ? '停用 CardBush Apps' : 'Disable CardBush Apps'
            : language === 'zh' ? '启用 CardBush Apps' : 'Enable CardBush Apps'}
          onClick={() => configuration && void persist(
            { ...configuration, serviceEnabled: !configuration.serviceEnabled },
            'service',
            configuration.serviceEnabled ? 'CardBush Apps 已停用' : 'CardBush Apps 已启用',
            configuration.serviceEnabled ? 'CardBush Apps disabled' : 'CardBush Apps enabled',
          )}
        >
          <span />
        </button>
      </div>

      {error && <p className="settings-inline-error">{error}</p>}
      <div className="cardbush-app-list">
        {!configuration || busyKey === 'load' ? (
          <div className="mcp-empty-row"><LoaderCircle size={16} /><span>{language === 'zh' ? '正在加载' : 'Loading'}</span></div>
        ) : configuration.plugins.map((plugin) => {
          const expanded = expandedPluginId === plugin.id;
          return (
            <article className={`cardbush-app-card ${!plugin.installed ? 'not-installed' : ''}`} key={plugin.id}>
              <div className="cardbush-app-summary">
                <div className="cardbush-app-copy">
                  <strong>{plugin.name}</strong>
                  <small>{plugin.description}</small>
                </div>
                {plugin.installed && (
                  <button
                    className="mcp-icon-button"
                    type="button"
                    title={language === 'zh' ? '插件配置' : 'Plugin settings'}
                    onClick={() => setExpandedPluginId(expanded ? '' : plugin.id)}
                  >
                    <Settings size={16} />
                  </button>
                )}
                {plugin.installed ? (
                  <>
                    <button
                      className={`mcp-toggle ${plugin.enabled ? 'on' : ''}`}
                      type="button"
                      disabled={Boolean(busyKey)}
                      title={plugin.enabled ? (language === 'zh' ? '停用插件' : 'Disable plugin') : (language === 'zh' ? '启用插件' : 'Enable plugin')}
                      onClick={() => void persist({
                        ...configuration,
                        plugins: configuration.plugins.map((item) => item.id === plugin.id
                          ? { ...item, enabled: !item.enabled }
                          : item),
                      }, `toggle:${plugin.id}`, plugin.enabled ? '插件已停用' : '插件已启用', plugin.enabled ? 'Plugin disabled' : 'Plugin enabled')}
                    >
                      <span />
                    </button>
                    <button
                      className="secondary-button compact danger"
                      type="button"
                      disabled={Boolean(busyKey)}
                      onClick={() => {
                        const confirmed = window.confirm(language === 'zh'
                          ? `确定卸载 ${plugin.name} 吗？插件配置会保留，重新安装后可以继续使用。`
                          : `Uninstall ${plugin.name}? Its settings will be retained for reinstall.`);
                        if (!confirmed) return;
                        void persist({
                          ...configuration,
                          plugins: configuration.plugins.map((item) => item.id === plugin.id
                            ? { ...item, installed: false, enabled: false }
                            : item),
                        }, `uninstall:${plugin.id}`, '插件已卸载', 'Plugin uninstalled');
                      }}
                    >
                      {language === 'zh' ? '卸载' : 'Uninstall'}
                    </button>
                  </>
                ) : (
                  <button
                    className="secondary-button compact"
                    type="button"
                    disabled={Boolean(busyKey)}
                    onClick={() => void persist({
                      ...configuration,
                      plugins: configuration.plugins.map((item) => item.id === plugin.id
                        ? { ...item, installed: true, enabled: true }
                        : item),
                    }, `install:${plugin.id}`, '插件已安装', 'Plugin installed')}
                  >
                    <Plus size={14} />
                    {language === 'zh' ? '安装' : 'Install'}
                  </button>
                )}
              </div>

              {expanded && plugin.id === 'computer_use' && (
                <div className="cardbush-app-config">
                  <label className="settings-field cardbush-app-path-field">
                    <span>{language === 'zh' ? '截图保存目录' : 'Screenshot directory'}</span>
                    <input
                      value={String(plugin.config.screenshotDirectory ?? '')}
                      placeholder={language === 'zh' ? '留空时使用系统临时目录' : 'Leave empty to use the system temp directory'}
                      onChange={(event) => replacePlugin({
                        ...plugin,
                        config: { ...plugin.config, screenshotDirectory: event.currentTarget.value },
                      })}
                    />
                  </label>
                  <label className="cardbush-app-option">
                    <input
                      type="checkbox"
                      checked={plugin.config.allowOpenApp !== false}
                      onChange={(event) => replacePlugin({
                        ...plugin,
                        config: { ...plugin.config, allowOpenApp: event.currentTarget.checked },
                      })}
                    />
                    <span>{language === 'zh' ? '允许启动应用' : 'Allow opening applications'}</span>
                  </label>
                  <label className="cardbush-app-option">
                    <input
                      type="checkbox"
                      checked={plugin.config.allowWindowClose !== false}
                      onChange={(event) => replacePlugin({
                        ...plugin,
                        config: { ...plugin.config, allowWindowClose: event.currentTarget.checked },
                      })}
                    />
                    <span>{language === 'zh' ? '允许关闭窗口' : 'Allow closing windows'}</span>
                  </label>
                  <div className="cardbush-app-config-actions">
                    <button
                      className="primary-button compact"
                      type="button"
                      disabled={Boolean(busyKey)}
                      onClick={() => void persist(configuration, `config:${plugin.id}`, '插件配置已保存', 'Plugin settings saved')}
                    >
                      {language === 'zh' ? '保存配置' : 'Save settings'}
                    </button>
                  </div>
                </div>
              )}
            </article>
          );
        })}
      </div>
    </section>
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

function mcpErrorText(caught: unknown, language: AppLanguage) {
  const message = errorMessage(caught);
  if (/mcp/i.test(message) && /transport/i.test(message)) {
    return language === 'zh'
      ? `MCP transport 配置无效：${message}`
      : `Invalid MCP transport config: ${message}`;
  }
  return message;
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

type UsageHeatmapRange = 'year' | 'month' | 'week';

function usageHeatmap(
  activity: Array<{ date: string; interactions: number }>,
  language: AppLanguage,
  range: UsageHeatmapRange,
) {
  const activityByDate = new Map(activity.map((day) => [day.date, day.interactions]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let start = new Date(today);
  let end = new Date(today);
  let selectedMonth = today.getMonth();

  if (range === 'year') {
    start.setDate(start.getDate() - start.getDay() - (52 * 7));
    end = new Date(start);
    end.setDate(start.getDate() + (53 * 7) - 1);
  } else if (range === 'month') {
    const monthStart = new Date(today.getFullYear(), today.getMonth(), 1);
    const monthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);
    selectedMonth = monthStart.getMonth();
    start = new Date(monthStart);
    start.setDate(monthStart.getDate() - monthStart.getDay());
    end = new Date(monthEnd);
    end.setDate(monthEnd.getDate() + (6 - monthEnd.getDay()));
  } else {
    start.setDate(start.getDate() - start.getDay());
    end = new Date(start);
    end.setDate(start.getDate() + 6);
  }

  const weekCount = Math.floor((end.getTime() - start.getTime()) / 86_400_000 / 7) + 1;
  const visibleCounts = activity
    .filter((day) => day.date >= localDayKey(start) && day.date <= localDayKey(end))
    .map((day) => day.interactions);
  const maximum = Math.max(1, ...visibleCounts);
  const days = Array.from({ length: weekCount * 7 }, (_, index) => {
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
  const monthLabels = Array.from({ length: weekCount }, (_, weekIndex) => {
    const weekStart = new Date(start);
    weekStart.setDate(start.getDate() + weekIndex * 7);
    const previousWeek = new Date(weekStart);
    previousWeek.setDate(weekStart.getDate() - 7);
    if (range === 'month') {
      return weekIndex === 0 ? formatter.format(new Date(today.getFullYear(), selectedMonth, 1)) : '';
    }
    return weekIndex === 0 || weekStart.getMonth() !== previousWeek.getMonth()
      ? formatter.format(weekStart)
      : '';
  });
  return { days, monthLabels, weekCount };
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
  headerAction,
  bodyHidden = false,
  children,
}: {
  title: string;
  subtitle?: string;
  headerAction?: React.ReactNode;
  bodyHidden?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="settings-card">
      <div className={`settings-card-header${headerAction ? ' has-action' : ''}`}>
        <div className="settings-card-heading">
          <h3>{title}</h3>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {headerAction && <div className="settings-card-header-action">{headerAction}</div>}
      </div>
      {!bodyHidden && <div className="settings-card-body">{children}</div>}
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
        <strong title={config.modelName}>{config.modelName}</strong>
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
  runtime: DiagnosticProbe;
  productHost: DiagnosticProbe;
  capabilities: DiagnosticProbe;
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
  const determinedByHost =
    language === 'zh' ? '(由 Product Host 决定)' : '(determined by Product Host)';
  const config = settings.managedModelConfigs.find(
    (item) => item.id.trim().toLowerCase() === selectedModel.trim().toLowerCase(),
  ) ?? settings.managedModelConfigs.find(
    (item) => item.modelName.trim().toLowerCase() === selectedModel.trim().toLowerCase(),
  );
  if (!config || !shouldUseManagedConfig(config)) {
    return {
      source: language === 'zh' ? 'Product Host 默认配置' : 'Product Host default config',
      model: config?.modelName || selectedModel || determinedByHost,
      provider: determinedByHost,
      apiKeyLabel: determinedByHost,
      baseUrl: determinedByHost,
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

async function localDiagnosticProbe(
  label: string,
  action: () => Promise<string> | string,
): Promise<DiagnosticProbe> {
  const started = performance.now();
  try {
    return {
      label,
      ok: true,
      elapsedMs: Math.round(performance.now() - started),
      detail: await action(),
    };
  } catch (caught) {
    return {
      label,
      ok: false,
      elapsedMs: Math.round(performance.now() - started),
      detail: caught instanceof Error ? caught.message : String(caught),
    };
  }
}

function assertDesktopRuntime() {
  if (!window.cardbushDesktop?.runtime) {
    throw new Error('Electron Runtime bridge is unavailable.');
  }
}

function assertProductHost() {
  if (!window.cardbushDesktop?.productHostCommand) {
    throw new Error('CardBush Product Host is unavailable.');
  }
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
