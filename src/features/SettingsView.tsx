import { SettingsPersonalizationPanel } from './settings/SettingsPersonalizationPanel';
import { SettingsKeyboardPanel } from './settings/SettingsKeyboardPanel';
import { SettingsDropdown } from './settings/SettingsDropdown';
import { SettingsAppearancePanel } from './settings/SettingsAppearancePanel';
import { UsageStatisticsPanel } from './settings/UsageStatisticsPanel';
import { SettingsCard, SettingsDivider, SettingsRadio, SettingsSwitch, SettingsInput, InfoRow } from './settings/SettingsControls';
import { settingsLabels, settingsDescriptions, settingsNavigationGroups, settingsSectionMatchesQuery, visibleSettingsSection, type VisibleSettingsSection } from './settings/settingsNavigation';
import type { WindowMaterialPreference } from './appearance/windowAppearance';
import { useCapabilityCatalogRefresh } from '../hooks/useCapabilityCatalogRefresh';
import type { SoftPanelPresence } from '../hooks/useSoftPanelPresence';
import { DEFAULT_MAX_CONTEXT_TOKENS as defaultMaxContextTokens } from '@cardbush/bush-product-agent';
import {
  AlertCircle,
  Archive,
  BarChart3,
  ArrowLeft,
  Check,
  CheckCircle2,
  ChevronUp,
  Clipboard,
  Cpu,
  Eye,
  EyeOff,
  Keyboard,
  LoaderCircle,
  Monitor,
  PackageOpen,
  Search,
  SlidersHorizontal,
  Sun,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings,
  Terminal,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type * as React from 'react';
import {
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
import { McpLogoIcon } from '../components/McpLogoIcon';
import { SidebarResizer } from '../components/SidebarResizer';
import { basename } from '../shared/localPaths';
import {
  IMPORTED_THEME_STYLE_PROTOCOL,
  parseImportedThemeStyle,
} from './appearance/importedThemeStyle';
import {
  ChromeConnectionSettings,
  PluginManagementPanel,
} from './plugins/PluginManagementPanel';
import type {
  AppLanguage,
  AppLanguageMode,
  AppSettingsState,
  BackendCapabilities,
  CardbushAppsConfiguration,
  CardbushAppPlugin,
  ConversationSummary,
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
const settingsIcons: Record<VisibleSettingsSection, React.ComponentType<{ size?: number; className?: string }>> = {
  profile: SlidersHorizontal, appearance: Sun, shortcuts: Keyboard, usage: BarChart3,
  models: Cpu, mcp: McpLogoIcon,
  runtime: Terminal, proxy: Monitor, cache: Archive, diagnostics: Clipboard,
};
export function SettingsView({
  active,
  onReady,
  themePreference,
  windowMaterial = 'auto',
  onWindowMaterialChange,
  language,
  languageMode,
  systemLanguage,
  settings,
  selectedModel,
  availableModels,
  backendCapabilities,
  runtimeBusy,
  skills,
  disabledSkillNames,
  initialSection,
  initialPluginTab,
  onBack,
  onThemePreferenceChange,
  onLanguageModeChange,
  onSettingsChange,
  onUseModel,
  sidebarCollapsed,
  sidebarPresence,
  sidebarWidth,
  onSidebarCollapse,
  onSidebarWidthChange,
  onConversationHistoryCleared,
  onRuntimeAssetsReloaded,
  onToggleSkill,
  onReloadSkills,
  onLoadSkillDetail,
  onOpenPluginPrompt,
  visualInputAvailable,
  visualInputEnabled,
  onVisualInputEnabledChange,
}: {
  active: boolean;
  onReady: () => void;
  themePreference: ThemePreference;
  windowMaterial?: WindowMaterialPreference;
  onWindowMaterialChange?: (value: WindowMaterialPreference) => void;
  language: AppLanguage;
  languageMode: AppLanguageMode;
  systemLanguage: AppLanguage;
  settings: AppSettingsState;
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
  onLanguageModeChange: (value: AppLanguageMode) => void;
  onSettingsChange: (updater: (current: AppSettingsState) => AppSettingsState) => void;
  onUseModel: (model: string) => void;
  sidebarCollapsed: boolean;
  sidebarPresence: SoftPanelPresence;
  sidebarWidth: number;
  onSidebarCollapse: () => void;
  onSidebarWidthChange: (value: number) => void;
  onConversationHistoryCleared?: () => void | Promise<void>;
  onRuntimeAssetsReloaded?: (categories: RuntimeAssetCategory[]) => Promise<void>;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  onReloadSkills: () => Promise<SkillSummary[]>;
  onLoadSkillDetail: (skillName: string) => Promise<SkillDetail>;
  onOpenPluginPrompt?: (prompt: string) => void;
  visualInputAvailable: boolean;
  visualInputEnabled: boolean;
  onVisualInputEnabledChange: (enabled: boolean) => void;
}) {
  const [section, setSection] = useState<VisibleSettingsSection>(
    visibleSettingsSection(initialSection),
  );
  const [settingsQuery, setSettingsQuery] = useState('');
  const [networkTab, setNetworkTab] = useState<'models' | 'plugins'>('models');
  const settingsContentRef = useRef<HTMLElement>(null);
  const sectionScrollPositions = useRef<Partial<Record<VisibleSettingsSection, number>>>({});
  const filteredNavigation = settingsNavigationGroups.map(group => ({
    ...group, sections: group.sections.filter(id => settingsSectionMatchesQuery(id, settingsQuery)),
  })).filter(group => group.sections.length > 0);
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
  const [pluginMcpTarget, setPluginMcpTarget] = useState<{ serverId?: string } | null>(null);
  const providerOptions = useMemo(
    () => collectProviderOptions(settings.managedModelConfigs),
    [settings.managedModelConfigs],
  );

  useLayoutEffect(() => {
    onReady();
  }, [onReady]);

  useEffect(() => {
    setSection(visibleSettingsSection(initialSection));
    setPluginMcpTarget(null);
    setSettingsQuery('');
  }, [initialSection]);

  useLayoutEffect(() => {
    if (settingsContentRef.current) settingsContentRef.current.scrollTop = sectionScrollPositions.current[section] ?? 0;
  }, [section]);

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
      const nextMaxContextTokens = normalizeMaxContextTokens(maxContextTokens);
      const nextMaxCompletionTokens = normalizeMaxCompletionTokens(maxCompletionTokens);
      if (
        nextMaxContextTokens &&
        nextMaxCompletionTokens &&
        nextMaxCompletionTokens >= nextMaxContextTokens
      ) {
        notify(
          language === 'zh'
            ? '最大输出 token 必须小于最大上下文 token'
            : 'Max output tokens must be less than max context tokens',
        );
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
              nextMaxContextTokens
                ? { maxContextTokens: nextMaxContextTokens }
                : {}
            ),
            ...(
              nextMaxCompletionTokens
                ? {
                    maxCompletionTokens: nextMaxCompletionTokens,
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
      const existing = settings.managedModelConfigs.find((item) => item.id === id);
      if (
        normalized &&
        existing?.maxCompletionTokens &&
        existing.maxCompletionTokens >= normalized
      ) {
        notify(
          language === 'zh'
            ? '最大上下文 token 必须大于当前最大输出 token'
            : 'Max context tokens must be greater than the current max output tokens',
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
    [language, notify, settings.managedModelConfigs, updateSettings],
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
      const existing = settings.managedModelConfigs.find((item) => item.id === id);
      if (
        normalized &&
        existing?.maxContextTokens &&
        normalized >= existing.maxContextTokens
      ) {
        notify(
          language === 'zh'
            ? '最大输出 token 必须小于当前最大上下文 token'
            : 'Max output tokens must be less than the current max context tokens',
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
    [language, notify, settings.managedModelConfigs, updateSettings],
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

  const importThemeStyle = useCallback(async () => {
    const filePath = await window.cardbushDesktop?.pickAppearanceStyle?.();
    if (!filePath) {
      return;
    }
    try {
      const preview = await window.cardbushDesktop?.readTextPreview?.(filePath);
      if (!preview || preview.truncated || preview.size > 128 * 1024) {
        throw new Error('style_config_too_large');
      }
      const importedThemeStyle = parseImportedThemeStyle(preview.content, filePath);
      updateSettings((current) => ({
        ...current,
        importedThemeStyle,
      }));
      onThemePreferenceChange('custom');
      notify(language === 'zh' ? '主题配置已导入' : 'Theme configuration imported');
    } catch {
      notify(
        language === 'zh'
          ? `无法导入主题配置，请检查 ${IMPORTED_THEME_STYLE_PROTOCOL} 格式`
          : `Unable to import theme configuration. Check the ${IMPORTED_THEME_STYLE_PROTOCOL} format.`,
      );
    }
  }, [language, notify, onThemePreferenceChange, updateSettings]);

  const resetImportedThemeStyle = useCallback(() => {
    updateSettings((current) => ({
      ...current,
      importedThemeStyle: null,
    }));
    if (themePreference === 'custom') {
      onThemePreferenceChange('system');
    }
    notify(language === 'zh' ? '已移除导入主题' : 'Imported theme removed');
  }, [language, notify, onThemePreferenceChange, themePreference, updateSettings]);

  const resetFont = useCallback(() => {
    updateSettings((current) => ({
      ...current,
      font: defaultFontSettings,
    }));
  }, [updateSettings]);

  const content = (() => {
    if (section === 'shortcuts') return <SettingsKeyboardPanel language={language} />;
    if (section === 'profile') return <SettingsPersonalizationPanel language={language} settings={settings}
      reasoningStreamAvailable={backendCapabilities.reasoningStream} onSettingsChange={updateSettings} />;
    if (section === 'usage') return <UsageStatisticsPanel language={language} active={active} />;
    if (section === 'appearance') return <SettingsAppearancePanel
      themePreference={themePreference} windowMaterial={windowMaterial} onWindowMaterialChange={onWindowMaterialChange}
      language={language} languageMode={languageMode} systemLanguage={systemLanguage} settings={settings}
      onThemePreferenceChange={onThemePreferenceChange} onLanguageModeChange={onLanguageModeChange}
      onImportFont={importFont} onResetFont={resetFont} onImportThemeStyle={importThemeStyle} onResetImportedThemeStyle={resetImportedThemeStyle} />;
    if (section === 'runtime') {
      return (
        <div className="settings-stack">
          <SettingsCard
            title={language === 'zh' ? '默认终端' : 'Default terminal'}
            subtitle={
              language === 'zh'
                ? '选择应用内终端使用的 Shell。Agent 工具仍按命令指定的 Shell 执行。'
                : 'Choose the embedded terminal Shell. Agent tools use the Shell specified by each command.'
            }
          >
            {backendCapabilities.terminalRuntimes.includes('powershell') && <SettingsRadio
              name="terminal-runtime"
              value="powershell"
              title="PowerShell"
              subtitle={
                language === 'zh'
                  ? '使用已安装的 PowerShell，支持本机路径和 PowerShell 脚本。'
                  : 'Use installed PowerShell for local paths and PowerShell scripts.'
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
            />}
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
                title={language === 'zh' ? '系统 Shell' : 'Native Shell'}
                subtitle={
                  language === 'zh'
                    ? '使用系统默认 Shell，未配置时使用 Bash 或 sh。'
                    : 'Use the system Shell, falling back to Bash or sh when unconfigured.'
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
    if (section === 'proxy') {
      return (
        <div className="settings-stack network-settings-stack">
        <div className="settings-page-tabs" role="tablist" aria-label={language === 'zh' ? '网络代理类别' : 'Proxy category'}>
          {(['models', 'plugins'] as const).map(tab => <button key={tab} id={`proxy-tab-${tab}`} role="tab" type="button"
            tabIndex={networkTab === tab ? 0 : -1}
            onKeyDown={event => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === 'Home' ? 'models' : event.key === 'End' ? 'plugins' : tab === 'models' ? 'plugins' : 'models';
              setNetworkTab(next);
              document.getElementById(`proxy-tab-${next}`)?.focus();
            }}
            aria-selected={networkTab === tab} aria-controls={`proxy-panel-${tab}`} onClick={() => setNetworkTab(tab)}>
            {tab === 'models' ? language === 'zh' ? '模型请求' : 'Model requests' : language === 'zh' ? '插件与 MCP' : 'Plugins & MCP'}
          </button>)}
        </div>
        <div role="tabpanel" id={`proxy-panel-${networkTab}`} aria-labelledby={`proxy-tab-${networkTab}`}>
        {networkTab === 'plugins' ? <PluginManagementPanel key="network" presentation="network" language={language}
          initialTab="plugins" skills={skills} disabledSkillNames={disabledSkillNames}
          onToggleSkill={onToggleSkill} onReloadSkills={onReloadSkills} onLoadSkillDetail={onLoadSkillDetail}
          onOpenMcp={serverId => { setSection('mcp'); setPluginMcpTarget({ serverId }); }} onNotify={notify} /> :
        <SettingsCard
          title={language === 'zh' ? '模型代理' : 'Model proxy'}
          subtitle={
            language === 'zh'
              ? '插件选择“跟随模型代理”时，也会使用这里的设置。'
              : 'Plugins use this configuration when set to follow the model proxy.'
          }
        >
          <SettingsRadio
            name="proxy-mode"
            value="none"
            title={language === 'zh' ? '不使用代理' : 'No proxy'}
            subtitle={
              language === 'zh'
                ? '模型请求直接连接，不继承环境代理。'
                : 'Model requests connect directly without inheriting environment proxies.'
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
          {settings.proxy.mode === 'manual' && <>
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
          </>}

        </SettingsCard>}
        </div>
        </div>
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
          visualInputAvailable={visualInputAvailable}
          visualInputEnabled={visualInputEnabled}
          onVisualInputEnabledChange={onVisualInputEnabledChange}
          onAddModelConfig={addModelConfig}
          onResetModels={resetModels}
          onRemoveModelConfig={removeModelConfig}
          onUpdateModelContextTokens={updateModelContextTokens}
          onUpdateModelCompletionTokens={updateModelCompletionTokens}
          onUseModel={useModel}
        />
      );
    }
    if (section === 'mcp') {
      return pluginMcpTarget ? (
        <div className="plugin-mcp-settings">
          <button className="plugin-back" type="button" onClick={() => setPluginMcpTarget(null)}>
            <ArrowLeft size={17} />
            {language === 'zh' ? '返回插件' : 'Back to plugins'}
          </button>
          <McpServersPanel
            initialServerId={pluginMcpTarget.serverId}
            language={language}
            capabilities={backendCapabilities}
            onNotify={notify}
          />
        </div>
      ) : (
        <PluginManagementPanel
          key="catalog"
          onOpenNetwork={() => { setNetworkTab('plugins'); setSection('proxy'); }}
          onOpenPrompt={onOpenPluginPrompt}
          language={language}
          initialTab={initialPluginTab}
          skills={skills}
          disabledSkillNames={disabledSkillNames}
          onToggleSkill={onToggleSkill}
          onReloadSkills={onReloadSkills}
          onLoadSkillDetail={onLoadSkillDetail}
          onOpenMcp={(serverId) => setPluginMcpTarget({ serverId })}
          renderMcp={serverId => <McpServersPanel initialServerId={serverId} language={language}
            capabilities={backendCapabilities} onNotify={notify} />}
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
        <div className="settings-stack">
        <DiagnosticsPanel
          language={language}
          settings={settings}
          selectedModel={selectedModel}
        />
        <AboutSettingsPanel language={language} settings={settings} selectedModel={selectedModel} />
        </div>
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

  return (
    <>
    <main
      className={`settings-shell${sidebarCollapsed ? ' sidebar-is-collapsed' : ''}${active ? '' : ' settings-inactive'}`}
      aria-hidden={!active}
      inert={active ? undefined : true}
    >
      {sidebarPresence.mounted && <>
      <aside className={`sidebar settings-sidebar soft-panel-motion ${sidebarPresence.visible ? 'soft-panel-visible' : 'soft-panel-hidden'}`}
        aria-hidden={!sidebarPresence.visible} inert={sidebarPresence.visible ? undefined : true}>
        <div className="sidebar-panel-content">
        <button className="back-button" type="button" onClick={onBack}>
          <ArrowLeft size={18} />
          {language === 'zh' ? '返回应用' : 'Back to app'}
        </button>
        <label className="settings-search">
          <Search size={15} aria-hidden="true" />
          <input value={settingsQuery} onChange={event => setSettingsQuery(event.target.value)}
            aria-label={language === 'zh' ? '搜索设置' : 'Search settings'}
            placeholder={language === 'zh' ? '搜索设置…' : 'Search settings…'}
            onKeyDown={event => { if (event.key === 'Escape') setSettingsQuery(''); }} />
          {settingsQuery && <button type="button" aria-label={language === 'zh' ? '清除搜索' : 'Clear search'} onClick={() => setSettingsQuery('')}><X size={14} /></button>}
        </label>
        <nav className="settings-navigation" aria-label={language === 'zh' ? '设置分类' : 'Settings sections'}>
          {filteredNavigation.map((group) => (
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
                    data-settings-section={id}
                    onClick={() => { setSection(id); setSettingsQuery(''); }}
                  >
                    <Icon size={18} />
                    <span>{settingsLabels[id][language]}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {filteredNavigation.length === 0 && <p className="settings-search-empty" role="status">{language === 'zh' ? '没有匹配的设置' : 'No matching settings'}</p>}
        </nav>
        </div>
      </aside>
      <SidebarResizer language={language} width={sidebarWidth} onWidthChange={onSidebarWidthChange}
        onCollapse={onSidebarCollapse} softVisible={active && sidebarPresence.visible} />
      </>}
      <section className="settings-content" ref={settingsContentRef}
        onScroll={event => { sectionScrollPositions.current[section] = event.currentTarget.scrollTop; }}>
        <div className={`settings-track${section === 'mcp' ? ' plugin-settings-track' : ''}`}>
          {section !== 'mcp' && <header className="settings-page-header">
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
  visualInputAvailable,
  visualInputEnabled,
  onVisualInputEnabledChange,
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
  visualInputAvailable: boolean;
  visualInputEnabled: boolean;
  onVisualInputEnabledChange: (enabled: boolean) => void;
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
      <SettingsCard title={language === 'zh' ? '模型输入' : 'Model input'}>
        <SettingsSwitch
          title={language === 'zh' ? '视觉功能' : 'Vision input'}
          subtitle={visualInputAvailable
            ? (language === 'zh' ? '允许模型直接接收图片。请使用支持视觉输入的模型；关闭后仍可通过文件工具处理图片。' : 'Allow native image input with a vision-capable model. File tools remain available when disabled.')
            : (language === 'zh' ? '当前运行环境未提供视觉输入。' : 'Vision input is unavailable in the current runtime.')}
          checked={visualInputEnabled}
          disabled={!visualInputAvailable}
          onChange={onVisualInputEnabledChange}
        />
      </SettingsCard>
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
              <SettingsDropdown label={language === 'zh' ? '模型商' : 'Provider'} value={providerSelection}
                onChange={onProviderSelectionChange} options={providerOptions.map(provider => ({ value: provider,
                  label: provider === customProviderValue ? language === 'zh' ? '模型商名称...' : 'Provider name...' : provider }))} />
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
        title={language === 'zh' ? '本地数据' : 'Local data'}
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
                  ? '删除会话、消息和摘要，保留项目文件与累计用量统计。'
                  : 'Delete conversations, messages and summaries. Keep project files and cumulative usage statistics.'}
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
                    ? '当前 Runtime 尚未提供此接口'
                    : 'This API is not available in the current Runtime'
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
                  ? '清理运行与工具错误日志，保留会话和使用记录。'
                  : 'Clear runtime and tool error logs. Keep conversations and usage records.'}
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
                    ? '当前 Runtime 尚未提供此接口'
                    : 'This API is not available in the current Runtime'
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
      <details className="settings-disclosure" open={Boolean(readPendingRuntimeAssetReset()) || undefined}>
      <summary>{language === 'zh' ? '恢复内置配置' : 'Restore bundled configuration'}</summary>
      <div className="settings-disclosure-body"><RuntimeAssetResetCard
        language={language}
        capabilities={capabilities}
        runtimeBusy={runtimeBusy}
        onNotify={onNotify}
        onRuntimeAssetsReloaded={onRuntimeAssetsReloaded}
      /></div>
      </details>
    </div>
  );
}

const runtimeAssetCategoryOrder: RuntimeAssetCategory[] = [
  'prompts',
  'skills',
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
  const supportedCategories = runtimeAssetCategoryOrder.filter(category =>
    capabilities.runtimeAssetResetCategories.includes(category));
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
    if (!available) return;
    setSelected((current) => new Set(
      [...current].filter((category) => supportedCategories.includes(category)),
    ));
  }, [available, supportedCategories.join('|')]);

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
      else if (supportedCategories.includes(category)) next.add(category);
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
      if (!next.restartRequired) {
        await onRuntimeAssetsReloaded?.(next.selectedCategories);
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
        ? '将 Prompts 和 Skills 恢复为当前 CardBush 随附的内置版本。'
        : 'Restore Prompts and Skills to the versions bundled with the current CardBush build.'}
    >
      <div className="runtime-asset-reset-panel">
        <div className="runtime-asset-category-grid">
          {supportedCategories.map((category) => {
            return (
              <label key={category}>
                <input
                  type="checkbox"
                  checked={selected.has(category)}
                  disabled={!available || Boolean(busy) || requiresRestart}
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
            {supportedCategories.map((category) => {
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
  } as const;
  return labels[category][language];
}

function runtimeAssetCategoryDescription(category: RuntimeAssetCategory, language: AppLanguage) {
  const descriptions = {
    prompts: { zh: '系统提示词与内置模板', en: 'System prompts and bundled templates' },
    skills: { zh: '内置技能包及其文件', en: 'Bundled skill packages and files' },
  } as const;
  return descriptions[category][language];
}

function readPendingRuntimeAssetReset(): RuntimeAssetResetResult | null {
  try {
    const raw = window.localStorage.getItem(pendingRuntimeAssetResetStorageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RuntimeAssetResetResult;
    if (parsed?.restartRequired !== true || !Array.isArray(parsed.selectedCategories)) return null;
    const selectedCategories = runtimeAssetCategoryOrder.filter(category => parsed.selectedCategories.includes(category));
    if (!selectedCategories.length) return null;
    return { ...parsed, selectedCategories, categories: Object.fromEntries(
      selectedCategories.flatMap(category => parsed.categories?.[category] ? [[category, parsed.categories[category]]] : []),
    ) };
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
};

function McpServersPanel({
  initialServerId,
  language,
  capabilities,
  onNotify,
}: {
  initialServerId?: string;
  language: AppLanguage;
  capabilities: BackendCapabilities;
  onNotify: (message: string) => void;
}) {
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [selectedId, setSelectedId] = useState(initialServerId ?? '');
  const [draft, setDraft] = useState<McpServerDraft>(emptyMcpDraft);
  const [editorOpen, setEditorOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState('');
  const [error, setError] = useState('');
  const [validation, setValidation] = useState<McpServerValidationResult | null>(null);
  const selectedIdRef = useRef(initialServerId ?? '');
  const initialEditorPending = useRef(true);

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
      const selected = result.servers.find((server) => server.id === currentId && !mcpServerIsFromPlugin(server));
      if (selected) {
        if (selected.id !== currentId) {
          selectServerId(selected.id);
        }
        setDraft(mcpDraftFromServer(selected));
      } else if (currentId) {
        selectServerId('');
        setDraft(emptyMcpDraft);
        setError(language === 'zh' ? '该 MCP 服务已被移除，请刷新插件列表。' : 'This MCP server was removed. Refresh the plugin catalog.');
      }
      if (initialEditorPending.current) {
        initialEditorPending.current = false;
        setEditorOpen(!currentId || Boolean(selected));
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

  const refreshServerStatus = useCallback(async (isCurrent: () => boolean) => {
    const result = await fetchMcpServers();
    if (isCurrent()) setServers(result.servers);
  }, []);
  useCapabilityCatalogRefresh(refreshServerStatus);
  useEffect(() => {
    if (!servers.some((server) => server.status === 'pending')) return;
    let active = true;
    const timer = window.setTimeout(() => void refreshServerStatus(() => active).catch(() => undefined), 1_000);
    return () => { active = false; window.clearTimeout(timer); };
  }, [servers, refreshServerStatus]);

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
        {servers.some((server) => server.status === 'pending') && <p role="status">
          {language === 'zh' ? '配置已保存，当前任务结束后自动生效，无需重启。' : 'Saved. Changes apply automatically after active tasks finish; no restart needed.'}
        </p>}
        {servers.find((server) => server.lastError)?.lastError && <p className="settings-inline-error" role="alert">
          {language === 'zh' ? 'MCP 更新失败，保留上次可用配置：' : 'MCP update failed; the previous working configuration is retained: '}
          {servers.find((server) => server.lastError)?.lastError}
        </p>}
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
                {server.transport !== 'stdio' && <button className="mcp-icon-button" type="button" disabled={Boolean(busyKey)} onClick={() => {
                  setBusyKey(server.id); setError('');
                  void window.cardbushDesktop!.mcpConnectionAction(server.id, 'login').then(() => fetchMcpServers()).then(value => setServers(value.servers)).catch(caught => setError(mcpErrorText(caught, language))).finally(() => setBusyKey(''));
                }}>{server.status === 'auth_required' ? (language === 'zh' ? '需要登录' : 'Sign-in required') : (language === 'zh' ? '登录' : 'Sign in')}</button>}
                {server.transport !== 'stdio' && <button className="mcp-icon-button" type="button" disabled={Boolean(busyKey) && busyKey !== server.id} onClick={() => {
                  const action = busyKey === server.id ? 'cancel_login' : 'logout';
                  void window.cardbushDesktop!.mcpConnectionAction(server.id, action).then(() => fetchMcpServers()).then(value => setServers(value.servers)).catch(caught => setError(mcpErrorText(caught, language)));
                }}>{busyKey === server.id ? (language === 'zh' ? '取消登录' : 'Cancel sign-in') : (language === 'zh' ? '退出登录' : 'Sign out')}</button>}


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
              <SettingsDropdown label={language === 'zh' ? '连接方式' : 'Connection'} value={draft.transport}
                onChange={transport => updateDraft({ transport: transport as McpTransport })}
                options={[{ value: 'stdio', label: 'stdio' }, { value: 'sse', label: 'SSE' }, { value: 'streamable_http', label: 'HTTP stream' }, { value: 'http', label: 'HTTP' }]} />
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
                      ? '服务未返回错误详情。'
                      : 'No error details were returned.'}
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
                      checked={plugin.config.yieldToUser !== false}
                      onChange={(event) => replacePlugin({
                        ...plugin,
                        config: { ...plugin.config, yieldToUser: event.currentTarget.checked },
                      })}
                    />
                    <span>{language === 'zh' ? '用户输入优先（检测到操作时主动让行）' : 'Yield when user input is detected'}</span>
                  </label>
                  <label className="cardbush-app-option">
                    <input
                      type="checkbox"
                      checked={plugin.config.restorePointer !== false}
                      onChange={(event) => replacePlugin({
                        ...plugin,
                        config: { ...plugin.config, restorePointer: event.currentTarget.checked },
                      })}
                    />
                    <span>{language === 'zh' ? '鼠标操作后恢复原位置' : 'Restore pointer after mouse actions'}</span>
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
              {expanded && plugin.id === 'chrome' && (
                <div className="cardbush-app-config chrome-connector-settings-wrap">
                  <ChromeConnectionSettings
                    language={language}
                    plugin={plugin}
                    busy={Boolean(busyKey)}
                    onReplace={replacePlugin}
                    onPersist={(next, message) => void persist({
                      ...configuration,
                      plugins: configuration.plugins.map((item) => item.id === next.id ? next : item),
                    }, `config:${plugin.id}`, message, message)}
                  />
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
