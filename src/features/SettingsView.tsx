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
  ExternalLink,
  Eye,
  EyeOff,
  Image,
  LoaderCircle,
  Monitor,
  Network,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings,
  Smartphone,
  Sparkles,
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
  useState,
} from 'react';

import {
  backendBaseUrl,
  backendRequestHeaders,
  clearConversationHistory,
  clearLogsCache,
  controlBotService,
  deleteWeixinAccount,
  fetchBotConfig,
  fetchBots,
  fetchBotServiceLogs,
  fetchBotStatus,
  fetchWeixinLoginStatus,
  llmEndpoint,
  saveBotConfig,
  startWeixinLogin,
  type MaintenanceClearResult,
} from '../backend/api';
import { BotPlatformIcon } from '../components/BotPlatformIcon';
import { SidebarResizer } from '../components/SidebarResizer';
import type {
  AppLanguage,
  AppLanguageMode,
  AppSettingsState,
  BotConfigResult,
  BotPlatform,
  BotPlatformOverview,
  BotServiceStatus,
  BotStatusResult,
  CompanionMotionMode,
  CompanionSettings,
  CompanionSize,
  LightThemeStyle,
  ManagedModelConfig,
  SettingsSection,
  ThemePreference,
  WeixinLoginStartResult,
  WeixinLoginStatus,
  WeixinLoginStatusResult,
} from '../types';

const COPY_FEEDBACK_EVENT = 'cardbush-copy-feedback';
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
const defaultFontSettings = {
  family: '',
  displayName: '',
  filePath: '',
};
const defaultCompanionSettings: CompanionSettings = {
  size: 'normal',
  opacity: 0.95,
  motion: 'full',
};

const settingsLabels: Record<SettingsSection, { zh: string; en: string }> = {
  profile: { zh: '外观', en: 'Appearance' },
  companion: { zh: '卡布', en: 'Kabu' },
  proxy: { zh: '代理设置', en: 'Proxy' },
  bots: { zh: 'Bot 连接', en: 'Bot links' },
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
  mobile: Smartphone,
  about: Circle,
};

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
  backgroundImageSource: string;
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

  const resetCompanionPosition = useCallback(() => {
    window.localStorage.removeItem('cardbush_cardling_position');
    void window.cardbushDesktop?.resetCardlingPosition?.();
    notify(language === 'zh' ? '卡布位置已重置' : 'Kabu position reset');
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
          backgroundImageSource={backgroundImageSource}
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
          onSettingsChange={updateSettings}
        />
      );
    }
    if (section === 'mobile') {
      return <MobileSettingsPanel language={language} />;
    }
    return <AboutSettingsPanel language={language} />;
  })();

  return (
    <>
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
  backgroundImageSource,
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
  backgroundImageSource: string;
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
        title={language === 'zh' ? '卡布状态助手' : 'Kabu companion'}
        subtitle={
          language === 'zh'
            ? '配置卡布在桌面上的显示、动效和停靠行为。'
            : 'Configure Kabu display, motion, and dock behavior.'
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
            <strong>{language === 'zh' ? 'Kabu / 卡布' : 'Kabu'}</strong>
            <span>
              {language === 'zh'
                ? '轻量、可拖拽、跟随对话状态。'
                : 'Lightweight, draggable, and tied to chat state.'}
            </span>
          </div>
        </div>
        <SettingsSwitch
          title={language === 'zh' ? '显示卡布' : 'Show Kabu'}
          subtitle={
            language === 'zh'
              ? '关闭后隐藏聊天界面的卡布入口，但保留现有偏好。'
              : 'Hides Kabu in chat while keeping current preferences.'
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
            ? '控制卡布的循环动画、反馈强度和停靠位置。'
            : 'Control Kabu loops, feedback intensity, and dock position.'
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
            {language === 'zh' ? '重置卡布位置' : 'Reset Kabu position'}
          </button>
        </div>
      </SettingsCard>
      <SettingsCard
        title={language === 'zh' ? '状态事件表' : 'Status event map'}
        subtitle={
          language === 'zh'
            ? '卡布只反映产品状态，不替代主流程操作。'
            : 'Kabu reflects product state without replacing primary workflows.'
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
        title={language === 'zh' ? '模型管理' : 'Model management'}
        subtitle={
          language === 'zh'
            ? '先填写 base_url 和 api_key，获取模型列表后选择并添加。'
            : 'Enter base_url and api_key, then fetch models and add the one you want.'
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
          <div className="model-fetch-row">
            <button
              className="secondary-button"
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
            <span>
              {language === 'zh'
                ? 'GET base_url + /models，Authorization: Bearer <api_key>'
                : 'GET base_url + /models with Authorization: Bearer <api_key>'}
            </span>
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
          <SettingsInput
            label={language === 'zh' ? '模型名称' : 'Model name'}
            value={modelName}
            placeholder="gpt-4.1-mini"
            onChange={onModelNameChange}
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
        <details className="model-reference-details">
          <summary>{language === 'zh' ? '接入参考' : 'Integration reference'}</summary>
          <div className="model-reference-links">
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
                    ? 'provider / base_url 兼容写法'
                    : 'Provider and base_url compatibility'}
                </small>
              </span>
            </button>
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
                <small>{language === 'zh' ? '国内模型接入参考' : 'China model reference'}</small>
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
                <small>{language === 'zh' ? '多模态与文本模型平台' : 'Text and multimodal models'}</small>
              </span>
            </button>
          </div>
        </details>
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
    [language, loadLogs, notify, overviewByPlatform, statusByPlatform],
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

function companionSizeScale(size: CompanionSize) {
  if (size === 'compact') {
    return 0.86;
  }
  if (size === 'large') {
    return 1.16;
  }
  return 1;
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
      : defaultCompanionSettings.opacity,
  };
}

function normalizeCompanionSize(value?: string): CompanionSize {
  return value === 'compact' || value === 'large' || value === 'normal'
    ? value
    : defaultCompanionSettings.size;
}

function normalizeCompanionMotion(value?: string): CompanionMotionMode {
  return value === 'full' || value === 'reduced' || value === 'off'
    ? value
    : defaultCompanionSettings.motion;
}

function basename(value: string) {
  const normalized = value.replaceAll('\\', '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts.at(-1) ?? value;
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
