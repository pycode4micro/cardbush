import { useUiLanguage } from '../i18n/react';
import { uiText, formatMessageList } from '../i18n';
import { modelRequestHeaders } from '@cardbush/bush-protocol';
import { normalizeAppearance, updateAppearanceProfile } from './appearance/appearancePreferences';
import { useSettingsHost } from './settings/SettingsHostContext';
import { SandboxSettingsPanel } from './settings/SandboxSettingsPanel';
import { ModelsSettingsPanel } from './settings/ModelsSettingsPanel';
import { SettingsPersonalizationPanel } from './settings/SettingsPersonalizationPanel';
import { SettingsGeneralPanel } from './settings/SettingsGeneralPanel';
import { NotificationSoundSettings } from './settings/NotificationSoundSettings';
import { SettingsSummaryPanel } from './settings/SettingsSummaryPanel';
import { VoiceSettingsPanel } from './voice/VoiceSettingsPanel';
import { BrowserSettingsPanel } from './browser/BrowserSettingsPanel';
import { SshConnectionsPanel } from './ssh/SshConnectionsPanel';
import { BrowserConnectionSettings } from './browser/BrowserConnectionSettings';
import { ComputerUseSettings, ComputerUseSettingsPanel } from './computerUse/ComputerUseSettings';
import { SettingsKeyboardPanel } from './settings/SettingsKeyboardPanel';
import { ArchivedItemsPanel } from './settings/ArchivedItemsPanel';
import { AgentDataSettings } from './settings/AgentDataSettings';
import type { AgentConnection } from '../../electron/agentTypes';
import { SettingsDropdown } from './settings/SettingsDropdown';
import { NetworkProxySettings } from './settings/NetworkProxySettings';
import { SettingsAppearancePanel } from './settings/SettingsAppearancePanel';
import { UsageStatisticsPanel } from './settings/UsageStatisticsPanel';
import { SettingsCard, SettingsDivider, SettingsRadio, SettingsInput, InfoRow } from './settings/SettingsControls';
import './settings/settingsLayout.css';
import { SettingsFormDialog } from './settings/SettingsFormDialog';
import { settingsLabels, settingsDescriptions, settingsNavigationGroups, settingsSectionMatchesQuery, visibleSettingsSection, type VisibleSettingsSection } from './settings/settingsNavigation';
import { usePageState } from './navigation/PageNavigation';
import type { WindowMaterialPreference } from './appearance/windowAppearance';
import { useCapabilityCatalogRefresh } from '../hooks/useCapabilityCatalogRefresh';
import type { SoftPanelPresence } from '../hooks/useSoftPanelPresence';
import {
  AlertCircle,
  Archive,
  BarChart3,
  Bell,
  Brain,
  ArrowLeft,
  Check,
  CheckCircle2,
  Clipboard,
  Copy,
  Container,
  Cpu,
  Keyboard,
  LoaderCircle,
  Monitor,
  Mic,
  Network,
  PackageOpen,
  Search,
  SlidersHorizontal,
  Stethoscope,
  Sun,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import type * as React from 'react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';

import {
  RUNTIME_ASSET_RESET_PROTOCOL,
  clearConversationHistory,
  clearLogsCache,
  clearApplicationCache,
  fetchCardbushAppsConfiguration,
  fetchBackendCapabilities,
  fetchBackendReadiness,
  fetchModelConfigs,
  fetchRuntimeAssetResetPlan,
  fetchRuntimeMaintenanceLogs,
  fetchSubagentRuntime,
  isProductHostCommandError,
  resetRuntimeAssets,
  saveCardbushAppsConfiguration,
  validateMcpServerConfig,
  type MaintenanceClearResult,
  type McpServerConfigInput,
} from '../backend/api';
import { version as packageVersion } from '../../package.json';
import { PluginIcon } from '../components/PluginIcon';
import { SidebarResizer } from '../components/SidebarResizer';
import { CompactSidebarBackdrop } from '../components/CompactSidebarBackdrop';
import { basename } from '../shared/localPaths';
import {
  IMPORTED_THEME_STYLE_PROTOCOL,
  parseImportedThemeStyle,
} from './appearance/importedThemeStyle';
import {
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
  ProjectItem,
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
// Store builds inject the MSIX identity version; other channels keep their own version.
const applicationVersion = import.meta.env.VITE_CARDBUSH_APP_VERSION || packageVersion;
const pendingRuntimeAssetResetStorageKey = 'cardbush_pending_runtime_asset_reset';
const defaultFontSettings = {
  family: '',
  displayName: '',
  filePath: '',
};
const settingsIcons: Record<VisibleSettingsSection, React.ComponentType<{ size?: number; className?: string }>> = {
  general: Settings, notifications: Bell,
  voice: Mic,
  profile: SlidersHorizontal, summary_for_user: Brain, appearance: Sun, shortcuts: Keyboard, usage: BarChart3,
  models: Cpu, mcp: PluginIcon, browser: Monitor, 'computer-use': Keyboard,
  projects: PackageOpen, runtime: Container, ssh: Network, proxy: Monitor, cache: Archive, diagnostics: Stethoscope,
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
  availableModels = [],
  defaultModelId = selectedModel,
  backendCapabilities,
  runtimeBusy,
  conversations,
  projects,
  onRestoreProjects,
  agentConnections = [],
  skills,
  disabledSkillNames,
  initialSection,
  onSectionChange,
  initialPluginTab,
  onBack,
  onThemePreferenceChange,
  onLanguageModeChange,
  onSettingsChange,
  onUseModel,
  sidebarCollapsed,
  compactLayout = false,
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
  defaultModelId?: string;
  availableModels: ManagedModelConfig[];
  backendCapabilities: BackendCapabilities;
  runtimeBusy: boolean;
  conversations: ConversationSummary[];
  projects?: ProjectItem[];
  onRestoreProjects?: (ids: string[]) => void;
  agentConnections?: AgentConnection[];
  skills: SkillSummary[];
  disabledSkillNames: Set<string>;
  initialSection: SettingsSection;
  onSectionChange?: (section: SettingsSection) => void;
  initialPluginTab: 'plugins' | 'skills';
  onBack: () => void;
  onThemePreferenceChange: (value: ThemePreference) => void;
  onLanguageModeChange: (value: AppLanguageMode) => void;
  onSettingsChange: (updater: (current: AppSettingsState) => AppSettingsState) => void;
  onUseModel: (model: string) => void;
  sidebarCollapsed: boolean;
  compactLayout?: boolean;
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
  useEffect(() => {
    if (!active) return;
    return () => { window.dispatchEvent(new Event('cardbush:shared-configuration-updated')); };
  }, [active]);
  const [localSection, setLocalSection] = useState<VisibleSettingsSection>(
    visibleSettingsSection(initialSection),
  );
  const section = onSectionChange ? visibleSettingsSection(initialSection) : localSection;
  const setSection = (value: VisibleSettingsSection) => onSectionChange ? onSectionChange(value) : setLocalSection(value);
  const [settingsQuery, setSettingsQuery] = useState('');
  const [networkTab, setNetworkTab] = usePageState<'models' | 'plugins'>('network-tab', 'models');
  const settingsContentRef = useRef<HTMLElement>(null);
  const settingsNavigationRef = useRef<HTMLElement>(null);
  const sectionScrollPositions = useRef<Record<string, number>>({});
  const effectiveSection = section === 'projects' ? 'models' : section;
  const scrollKey = effectiveSection;
  const filteredNavigation = settingsNavigationGroups.map(group => ({
    ...group, sections: group.sections.filter(id => settingsSectionMatchesQuery(id, settingsQuery)),
  })).filter(group => group.sections.length > 0);
  const [toast, setToast] = useState('');
  const [pluginMcpTarget, setPluginMcpTarget] = usePageState<{ serverId?: string } | null>('mcp-target', null);
  useLayoutEffect(() => {
    onReady();
  }, [onReady]);

  useLayoutEffect(() => {
    if (!active) return;
    setLocalSection(visibleSettingsSection(initialSection));
    setSettingsQuery('');
  }, [initialSection, active]);

  useLayoutEffect(() => {
    if (!active) return;
    if (settingsContentRef.current) settingsContentRef.current.scrollTop = scrollKey === 'general' ? 0 : sectionScrollPositions.current[scrollKey] ?? 0;
  }, [scrollKey, active]);

  useLayoutEffect(() => {
    if (!active) return;
    if (effectiveSection === 'general') settingsNavigationRef.current?.scrollTo({ top: 0 });
  }, [effectiveSection, settingsQuery, active]);

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

  const importFont = useCallback(async () => {
    const filePath = await window.cardbushDesktop?.pickFont?.();
    if (!filePath) {
      return;
    }
    const displayName = basename(filePath);
    updateSettings((current) => ({
      ...current,
      appearance: updateAppearanceProfile(normalizeAppearance(current.appearance), themePreference === 'light' || (themePreference === 'system' && !matchMedia('(prefers-color-scheme: dark)').matches) ? 'bright' : 'dark', { font: 'imported' }),
      font: {
        family: `cardbush-imported-${stableModelConfigId('font', displayName, '', filePath)}`,
        displayName,
        filePath,
      },
    }));
    notify(uiText(language)('settingsView.fontImported'));
  }, [language, notify, updateSettings, themePreference]);

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
        appearance: updateAppearanceProfile(normalizeAppearance(current.appearance), importedThemeStyle.base === 'light' ? 'bright' : 'dark', { theme: 'imported' }),
      }));
      onThemePreferenceChange(importedThemeStyle.base);
      notify(uiText(language)('settingsView.themeConfigurationImported'));
    } catch {
      notify(
        uiText(language)('settingsView.unableToImportThemeConfigurationCheckThe', { IMPORTED_THEME_STYLE_PROTOCOL }),
      );
    }
  }, [language, notify, onThemePreferenceChange, updateSettings]);

  const resetImportedThemeStyle = useCallback(() => {
    updateSettings((current) => ({
      ...current,
      importedThemeStyle: null,
      appearance: (() => { const next = normalizeAppearance(current.appearance); for (const key of ['shared', 'light', 'dark'] as const) next[key].theme = 'default'; return next; })(),
    }));
    notify(uiText(language)('settingsView.importedThemeRemoved'));
  }, [language, notify, onThemePreferenceChange, themePreference, updateSettings]);

  const resetFont = useCallback(() => {
    updateSettings((current) => ({
      ...current,
      font: defaultFontSettings,
      appearance: (() => { const next = normalizeAppearance(current.appearance); for (const key of ['shared', 'light', 'dark'] as const) { if (next[key].font === 'imported') next[key].font = 'system'; if (next[key].contentFont === 'imported') next[key].contentFont = 'inherit'; } return next; })(),
    }));
  }, [updateSettings]);

  const content = (() => {
    if (effectiveSection === 'general') return <SettingsGeneralPanel language={language} languageMode={languageMode}
      systemLanguage={systemLanguage} settings={settings} reasoningStreamAvailable={backendCapabilities.reasoningStream}
      onLanguageModeChange={onLanguageModeChange} onSettingsChange={updateSettings} />;
    if (effectiveSection === 'notifications') return <div className="settings-stack"><NotificationSoundSettings language={language}/></div>;
    if (effectiveSection === 'voice') return <VoiceSettingsPanel language={language} />;
    if (effectiveSection === 'shortcuts') return <SettingsKeyboardPanel language={language} />;
    if (effectiveSection === 'browser') return <BrowserSettingsPanel language={language} />;
    if (effectiveSection === 'ssh') return <SshConnectionsPanel language={language} projects={projects} />;
    if (effectiveSection === 'computer-use') return <ComputerUseSettingsPanel language={language} />;
    if (effectiveSection === 'profile') return <SettingsPersonalizationPanel language={language} settings={settings}
      onSettingsChange={updateSettings} />;
    if (effectiveSection === 'summary_for_user') return <SettingsSummaryPanel language={language} settings={settings}
      onSettingsChange={updateSettings} modelId={selectedModel} modelLabel={availableModels.find(model=>model.id===selectedModel)?.modelName} connections={agentConnections}/>;
    if (effectiveSection === 'usage') return <UsageStatisticsPanel language={language} active={active} />;
    if (effectiveSection === 'appearance') return <SettingsAppearancePanel
      themePreference={themePreference} windowMaterial={windowMaterial} onWindowMaterialChange={onWindowMaterialChange}
      language={language} settings={settings}
      onThemePreferenceChange={onThemePreferenceChange}
      onSettingsChange={updateSettings}
      onImportFont={importFont} onResetFont={resetFont} onImportThemeStyle={importThemeStyle} onResetImportedThemeStyle={resetImportedThemeStyle} />;
    if (effectiveSection === 'runtime') {
      return (
        <div className="settings-stack">
          <SandboxSettingsPanel language={language}/>
          <SettingsCard
            title={uiText(language)('settingsView.defaultTerminal')}
            subtitle={
              uiText(language)('settingsView.chooseTheEmbeddedTerminalShellAgentTools')
            }
          >
            {backendCapabilities.terminalRuntimes.includes('powershell') && <SettingsRadio
              name="terminal-runtime"
              value="powershell"
              title={uiText(language)('settingsView.powershell')}
              subtitle={
                uiText(language)('settingsView.useInstalledPowershellForLocalPathsAnd')
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
                title={uiText(language)('settingsView.wsl')}
                subtitle={
                  uiText(language)('settingsView.runCommandsThroughWindowsSubsystemForLinux')
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
                title={uiText(language)('settingsView.git_bash')}
                subtitle={
                  uiText(language)('settingsView.useGitForWindowsBashForUnix')
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
                title={uiText(language)('settingsView.nativeShell')}
                subtitle={
                  uiText(language)('settingsView.useTheSystemShellFallingBackTo')
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
    if (effectiveSection === 'proxy') {
      return (
        <div className="settings-stack network-settings-stack">
        <div className="settings-page-tabs" role="tablist" aria-label={uiText(language)('settingsView.proxyCategory')}>
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
            {tab === 'models' ? uiText(language)('settingsView.appDefault') : uiText(language)('settingsView.marketplacePlugins')}
          </button>)}
        </div>
        <div role="tabpanel" id={`proxy-panel-${networkTab}`} aria-labelledby={`proxy-tab-${networkTab}`}>
        {networkTab === 'plugins' ? <PluginManagementPanel key="network" presentation="network" language={language}
          initialTab="plugins" skills={skills} disabledSkillNames={disabledSkillNames}
          onToggleSkill={onToggleSkill} onReloadSkills={onReloadSkills} onLoadSkillDetail={onLoadSkillDetail}
          onOpenMcp={serverId => { setSection('mcp'); setPluginMcpTarget({ serverId }); }} onNotify={notify} /> :
        <SettingsCard
          title={uiText(language)('settingsView.appDefaultProxy')}
          subtitle={uiText(language)('settingsView.usedForModelRequestsModelListsAccount')}
        >
          <NetworkProxySettings scope="application" language={language} value={settings.proxy}
            onSave={async proxy => {
              if (!proxy || proxy.mode === 'model') return false;
              const saved = { ...proxy, mode: proxy.mode };
              await window.cardbushDesktop?.setProxy?.(saved);
              updateProxy(saved);
              return true;
            }} />
        </SettingsCard>}
        </div>
        </div>
      );
    }
    if (effectiveSection === 'models') return <ModelsSettingsPanel language={language}
      models={{ defaultModelId, models: settings.managedModelConfigs }} defaultSelection
      onSave={async config => {
        const merged = config.models.map(model => ({ ...model,
          apiKey: model.authentication?.kind === 'chatgpt' ? '' : model.apiKey || settings.managedModelConfigs.find(item => item.id === model.id)?.apiKey || '',
        }));
        onSettingsChange(current => ({ ...current, managedModelConfigs: merged }));
        if (defaultModelId !== config.defaultModelId) onUseModel(config.defaultModelId);
        return { ...config, models: merged };
      }} onRefresh={async () => {}} onSelect={onUseModel} discoverModels={requestProviderModels}
      visualInputAvailable={visualInputAvailable} visualInputEnabled={visualInputEnabled} onVisualInputEnabledChange={onVisualInputEnabledChange}/>;
    if (effectiveSection === 'mcp') {
      return pluginMcpTarget ? (
        <div className="plugin-mcp-settings">
          <button className="plugin-back" type="button" onClick={() => setPluginMcpTarget(null)}>
            <ArrowLeft size={17} />
            {uiText(language)('pluginManagementPanel.backToPlugins')}
          </button>
          <McpServersPanel
            initialServerId={pluginMcpTarget.serverId}
            initialCreate={!pluginMcpTarget.serverId}
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
          renderMcp={(serverId, dialog) => <McpServersPanel initialServerId={serverId} initialCreate={!serverId} {...dialog} language={language}
            capabilities={backendCapabilities} onNotify={notify} />}
          onNotify={notify}
        />
      );
    }
    if (effectiveSection === 'cache') {
      return (
        <div className="settings-stack">
        <ArchivedItemsPanel language={language} conversations={conversations} projects={projects}
          onRestoreProjects={onRestoreProjects} onNotify={notify} />
        <CacheMaintenancePanel
          language={language}
          capabilities={backendCapabilities}
          onNotify={notify}
          onConversationHistoryCleared={onConversationHistoryCleared}
          runtimeBusy={runtimeBusy}
          onRuntimeAssetsReloaded={onRuntimeAssetsReloaded}
        />
        {agentConnections.map(connection => <AgentDataSettings key={connection.id} connection={connection} language={language} onNotify={notify}/>)}
        </div>
      );
    }
    if (effectiveSection === 'diagnostics') {
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
      <CompactSidebarBackdrop visible={compactLayout && !sidebarCollapsed} language={language} onClose={onSidebarCollapse} />
      {sidebarPresence.mounted && <>
      <aside className={`sidebar settings-sidebar soft-panel-motion ${sidebarPresence.visible ? 'soft-panel-visible' : 'soft-panel-hidden'}`}
        aria-hidden={!sidebarPresence.visible} inert={sidebarPresence.visible ? undefined : true}>
        <div className="sidebar-panel-content">
        <button className="back-button" type="button" onClick={onBack}>
          <ArrowLeft size={18} />
          {uiText(language)('app.backToApp')}
        </button>
        <label className="settings-search">
          <Search size={15} aria-hidden="true" />
          <input value={settingsQuery} onChange={event => setSettingsQuery(event.target.value)}
            aria-label={uiText(language)('settingsView.searchSettings')}
            placeholder={uiText(language)('settingsView.searchSettings_5d017d7')}
            onKeyDown={event => { if (event.key === 'Escape') setSettingsQuery(''); }} />
          {settingsQuery && <button type="button" aria-label={uiText(language)('settingsView.clearSearch')} onClick={() => setSettingsQuery('')}><X size={14} /></button>}
        </label>
        <nav className="settings-navigation" ref={settingsNavigationRef} aria-label={uiText(language)('settingsView.settingsSections')}>
          {filteredNavigation.map((group) => (
            <div className="settings-nav-group" key={uiText('en')(group.label)}>
              <span className="settings-nav-group-label">{uiText(language)(group.label)}</span>
              {group.sections.map((id) => {
                const Icon = settingsIcons[id];
                return (
                  <button
                    key={id}
                    className={`settings-nav ${effectiveSection === id ? 'active' : ''}`}
                    type="button"
                    aria-current={effectiveSection === id ? 'page' : undefined}
                    data-settings-section={id}
                    onClick={() => { setSection(id); setSettingsQuery(''); if (compactLayout) onSidebarCollapse(); }}
                  >
                    <Icon size={18} />
                    <span>{uiText(language)(settingsLabels[id])}</span>
                  </button>
                );
              })}
            </div>
          ))}
          {filteredNavigation.length === 0 && <p className="settings-search-empty" role="status">{uiText(language)('settingsView.noMatchingSettings')}</p>}
        </nav>
        </div>
      </aside>
      <SidebarResizer language={language} width={sidebarWidth} onWidthChange={onSidebarWidthChange}
        onCollapse={onSidebarCollapse} softVisible={active && sidebarPresence.visible} />
      </>}
      <section className="settings-content" ref={settingsContentRef} inert={compactLayout && !sidebarCollapsed ? true : undefined}
        onScroll={event => { sectionScrollPositions.current[scrollKey] = event.currentTarget.scrollTop; }}>
        <div className={`settings-track${section === 'mcp' ? ' plugin-settings-track' : ''}`}>
          {effectiveSection !== 'mcp' && <header className="settings-page-header">
            <div>
              <h2>{uiText(language)(settingsLabels[effectiveSection])}</h2>
              <p>{uiText(language)(settingsDescriptions[effectiveSection])}</p>
            </div>
          </header>}
          <div>{content}</div>
        </div>
      </section>
    </main>
    {active && toast && <div className="settings-toast">{toast}</div>}
    </>
  );
}

export function CacheMaintenancePanel({
  scopeName, clear,
  language,
  capabilities,
  onNotify,
  onConversationHistoryCleared,
  runtimeBusy,
  onRuntimeAssetsReloaded,
}: {
  scopeName?: string; clear?: (target: 'conversation' | 'logs' | 'cache') => Promise<MaintenanceClearResult>;
  language: AppLanguage;
  capabilities: BackendCapabilities;
  onNotify: (message: string) => void;
  onConversationHistoryCleared?: () => void | Promise<void>;
  runtimeBusy: boolean;
  onRuntimeAssetsReloaded?: (categories: RuntimeAssetCategory[]) => Promise<void>;
}) {
  const [busyTarget, setBusyTarget] = useState<'conversation' | 'logs' | 'cache' | ''>('');
  const [result, setResult] = useState<MaintenanceClearResult | null>(null);
  const [error, setError] = useState('');

  const runClear = useCallback(
    async (target: 'conversation' | 'logs' | 'cache') => {
      if (busyTarget || (runtimeBusy && target !== 'logs')) {
        return;
      }
      const supported =
        target === 'conversation'
          ? capabilities.maintenanceConversationHistoryClear
          : capabilities.maintenanceLogsCacheClear;
      if (!supported) {
        setError(
          uiText(language)('settingsView.productHostDoesNotExposeThisCache'),
        );
        return;
      }
      const confirmed = window.confirm(
        scopeName ? (uiText(language)(`settings.clear.${target}`, { name: scopeName })) : target === 'conversation'
          ? uiText(language)('settingsView.clearLocalConversationHistoryAndUnreferencedAttachments')
          : target === 'cache'
            ? uiText(language)('settingsView.clearApplicationCachesExpiredPreviewsAndUnreferenced')
            : uiText(language)('settingsView.clearLocalRuntimeLogsAndOldCrash'),
      );
      if (!confirmed) {
        return;
      }
      setBusyTarget(target);
      setError('');
      try {
        const cleared =
          clear ? await clear(target) : target === 'conversation'
            ? await clearConversationHistory()
            : target === 'cache' ? await clearApplicationCache() : await clearLogsCache();
        setResult(cleared);
        if (cleared.errors?.length) setError(cleared.errors.join('\n'));
        if (target === 'conversation') {
          await onConversationHistoryCleared?.();
        }
        onNotify(
          cleared.errors?.length ? (uiText(language)('settingsView.someCleanupCouldNotFinishSeeDetails'))
          : !cleared.cleared ? (uiText(language)('settingsView.noDataToClear'))
          : target === 'cache' ? (uiText(language)('settingsView.cacheCleanupFinished'))
          : target === 'conversation'
            ? uiText(language)('settingsView.conversationHistoryCleared')
            : uiText(language)('settingsView.logsCacheCleared'),
        );
      } catch (caught) {
        const message = errorMessage(caught);
        setError(
          message.includes('404')
            ? uiText(language)('settingsView.productHostDoesNotExposeTheCache')
            : message,
        );
      } finally {
        setBusyTarget('');
      }
    },
    [clear, scopeName, busyTarget, capabilities, language, onConversationHistoryCleared, onNotify, runtimeBusy],
  );
  const conversationClearSupported = capabilities.maintenanceConversationHistoryClear;
  const logsClearSupported = capabilities.maintenanceLogsCacheClear;

  return (
    <div className="settings-stack">
      <SettingsCard
        title={scopeName || (uiText(language)('settingsView.localData'))}
        subtitle={
          uiText(language)('settingsView.manageHistoryLogsAndCachesInThis')
        }
      >
        <div className="maintenance-action-list">
          <div className="maintenance-action-row">
            <Archive size={18} />
            <span>
              <strong>
                {uiText(language)('settingsView.clearConversationHistory')}
              </strong>
              <small>
                {uiText(language)('settingsView.deleteConversationsMessagesAndSummariesKeepProject')}
              </small>
            </span>
            <button
              className="secondary-button"
              type="button"
              disabled={Boolean(busyTarget) || runtimeBusy || !conversationClearSupported}
              onClick={() => void runClear('conversation')}
              title={
                conversationClearSupported
                  ? undefined
                  : uiText(language)('settingsView.thisApiIsNotAvailableInThe')
              }
            >
              {busyTarget === 'conversation' ? (
                <LoaderCircle size={14} />
              ) : (
                <Trash2 size={14} />
              )}
              {uiText(language)('cardlingSceneHost.clear')}
            </button>
          </div>
          <div className="maintenance-action-row">
            <Clipboard size={18} />
            <span>
              <strong>{uiText(language)('settingsView.clearLogsCache')}</strong>
              <small>
                {uiText(language)('settingsView.clearRuntimeLogsAndOldCrashReports')}
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
                  : uiText(language)('settingsView.thisApiIsNotAvailableInThe')
              }
            >
              {busyTarget === 'logs' ? <LoaderCircle size={14} /> : <Trash2 size={14} />}
              {uiText(language)('cardlingSceneHost.clear')}
            </button>
          </div>
          <div className="maintenance-action-row">
            <Trash2 size={18} />
            <span>
              <strong>{uiText(language)('settingsView.clearApplicationCache')}</strong>
              <small>{uiText(language)('settingsView.reclaimExpiredPreviewsUnreferencedAttachmentsAndDeleted')}</small>
            </span>
            <button className="secondary-button" type="button" disabled={Boolean(busyTarget) || runtimeBusy || !logsClearSupported} onClick={() => void runClear('cache')}>
              {busyTarget === 'cache' ? <LoaderCircle size={14} /> : <Trash2 size={14} />}
              {uiText(language)('settingsView.clear')}
            </button>
          </div>
        </div>
        {runtimeBusy && <small>{uiText(language)('settingsView.historyAndApplicationCachesCanBeCleared')}</small>}
        {(!conversationClearSupported || !logsClearSupported) && (
          <p className="settings-inline-error">
            {uiText(language)('settingsView.someCacheMaintenanceCapabilitiesAreNotExposed')}
          </p>
        )}
        {error && <p className="settings-inline-error">{error}</p>}
        {result && (
          <div className="maintenance-result">
            <strong>
              {uiText(language)('settingsView.lastResult')}
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
                <em>{uiText(language)('settingsView.noCountsReturned')}</em>
              )}
            </div>
          </div>
        )}
      </SettingsCard>
      {!scopeName && <details className="settings-disclosure" open={Boolean(readPendingRuntimeAssetReset()) || undefined}>
      <summary>{uiText(language)('settingsView.restoreBundledConfiguration')}</summary>
      <div className="settings-disclosure-body"><RuntimeAssetResetCard
        language={language}
        capabilities={capabilities}
        runtimeBusy={runtimeBusy}
        onNotify={onNotify}
        onRuntimeAssetsReloaded={onRuntimeAssetsReloaded}
      /></div>
      </details>}
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
          setError(uiText(language)('settingsView.subagentTasksAreStillActiveWaitFor'));
          return;
        }
      } catch {
        // The Product Host remains the final authority for runtime-idle checks.
      }
    }
    const confirmed = window.confirm(
      uiText(language)('settings.restoreAssets', { categories: formatMessageList(language, selectedCategories.map(item => runtimeAssetCategoryLabel(item, language))) }),
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
        ? uiText(language)('settingsView.bundledRuntimeAssetsRestored')
        : uiText(language)('settingsView.runtimeAssetsAlreadyMatchTheBundledVersion'));
    } catch (caught) {
      if (
        isProductHostCommandError(caught, 'runtime_asset_reset_requires_idle_runtime')
      ) {
        setError(uiText(language)('settingsView.aParentOrChildTurnIsActive'));
      } else if (
        isProductHostCommandError(caught, 'runtime_asset_reset_confirmation_required')
      ) {
        setError(uiText(language)('settingsView.productHostDidNotReceiveValidConfirmation'));
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
      onNotify(uiText(language)('settingsView.theCardbushRuntimeIsReadyAndIts'));
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
      title={uiText(language)('settingsView.restoreBundledRuntimeAssets')}
      subtitle={uiText(language)('settingsView.restorePromptsAndSkillsToTheVersions')}
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
          <span>{uiText(language)('settingsView.removesLocalEditsRuntimeInstalledPackagesStale')}</span>
        </div>

        {runtimeActive && (
          <p className="settings-inline-error">
            {uiText(language)('settingsView.theRuntimeIsBusyResetIsDisabled', { value1: (activeChildTasks > 0 ? uiText(language)('settingsView.childTasks', { value1: activeChildTasks }) : '') })}
          </p>
        )}
        {!available && (
          <p className="settings-inline-error">
            {uiText(language)('settingsView.theCurrentCardbushProductHostDoesNot')}
          </p>
        )}
        {error && (
          <div className="runtime-asset-reset-error">
            <p className="settings-inline-error">{error}</p>
            <button className="secondary-button" type="button" onClick={() => void loadServiceLogs()}>
              {loadingLogs ? <LoaderCircle size={14} /> : <Clipboard size={14} />}
              {uiText(language)('settingsView.viewServiceLogs')}
            </button>
          </div>
        )}

        {serviceLogs && (
          <details className="runtime-asset-service-logs" open>
            <summary>{uiText(language)('settingsView.recentServiceLogs')}</summary>
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
            {uiText(language)('settingsView.restoreSelectedAssets')}
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={!available || Boolean(busy)}
            onClick={() => void refreshInspection()}
          >
            {busy === 'inspect' ? <LoaderCircle size={14} /> : <RefreshCw size={14} />}
            {uiText(language)('settingsView.inspectStatus')}
          </button>
        </div>

        {result && <RuntimeAssetResetResultView result={result} language={language} />}

        {requiresRestart && (
          <div className="runtime-asset-restart-required" role="alert">
            <RotateCcw size={18} />
            <span>
              <strong>{uiText(language)('settingsView.cardbushRestartRequired')}</strong>
              <small>{uiText(language)('settingsView.assetsWereWrittenButAreNotActive')}</small>
            </span>
            <button
              className="primary-button"
              type="button"
              disabled={busy === 'verify' || !onRuntimeAssetsReloaded}
              onClick={() => void verifyRestart()}
            >
              {busy === 'verify' ? <LoaderCircle size={14} /> : <Check size={14} />}
              {uiText(language)('settingsView.restartedVerifyAndReload')}
            </button>
          </div>
        )}

        {plan && (
          <details className="runtime-asset-paths">
            <summary>{uiText(language)('settingsView.viewBundledSourceAndRuntimePaths')}</summary>
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
        ? uiText(language)('settingsView.restoreResult')
        : uiText(language)('settingsView.alreadyMatchesBundledAssets')}</strong>
      <div>
        {result.selectedCategories.map((category) => {
          const item = result.categories[category];
          if (!item) return null;
          return (
            <span key={category}>
              <b>{runtimeAssetCategoryLabel(category, language)}</b>
              <small>
                {uiText(language)('settingsView.restoredRemovedBundled', { value1: item.restoredFileCount, value2: item.removedRuntimeFileCount, value3: item.seedFileCount })}
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
    prompts: 'settingsView.prompts',
    skills: 'composer.skills_4b57155',
  } as const;
  return uiText(language)(labels[category]);
}

function runtimeAssetCategoryDescription(category: RuntimeAssetCategory, language: AppLanguage) {
  const descriptions = {
    prompts: 'settingsView.systemPromptsAndBundledTemplates',
    skills: 'settingsView.bundledSkillPackagesAndFiles',
  } as const;
  return uiText(language)(descriptions[category]);
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
          uiText(language)('settingsView.embeddedRuntime'),
          async () => {
            assertDesktopRuntime();
            const readiness = await fetchBackendReadiness();
            if (readiness.ready !== true) {
              throw new Error(uiText(language)('settingsView.runtimeIsNotReady'));
            }
            const versions = Array.isArray(readiness.protocolVersions)
              ? readiness.protocolVersions.join(' / ')
              : '';
            return [String(readiness.runtimeVersion ?? '').trim(), versions]
              .filter(Boolean)
              .join(' · ') || (uiText(language)('runtimeStreamPreTest.ready'));
          },
        ),
        localDiagnosticProbe(
          'Product Host',
          async () => {
            assertProductHost();
            const snapshot = await fetchModelConfigs();
            return uiText(language)('settingsView.ipcAvailableModelConfigurations', { value1: snapshot.models.length });
          },
        ),
        localDiagnosticProbe(
          uiText(language)('settingsView.capabilityContract'),
          async () => {
            assertDesktopRuntime();
            const capabilities = await fetchBackendCapabilities();
            if (!capabilities.chatStream || !capabilities.sessions) {
              throw new Error(uiText(language)('settingsView.coreChatCapabilitiesAreMissing'));
            }
            return uiText(language)('settingsView.typedCommandsEventStreamingAndSessionPersistence');
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
      title={uiText(language)('settingsView.runtimeDiagnostics')}
      subtitle={
        uiText(language)('settingsView.checkTheEmbeddedTypescriptRuntimeProductHost')
      }
    >
      <div className="settings-subblock">
        <strong>{uiText(language)('settingsView.currentRequestConfig')}</strong>
        <InfoRow label={uiText(language)('settingsAppearancePanel.mode')} value={modelInfo.source} />
        <InfoRow label={uiText(language)('modelFormDialog.modelName')} value={modelInfo.model} />
        <InfoRow label={uiText(language)('modelProviderSelect.provider')} value={modelInfo.provider} />
        <InfoRow label={uiText(language)('settingsView.api_key')} value={modelInfo.apiKeyLabel} />
        <InfoRow label={uiText(language)('settingsView.base_url')} value={modelInfo.baseUrl} />
        <InfoRow
          label={uiText(language)('settingsView.runtimeTransport')}
          value="Electron typed IPC"
        />
      </div>
      <SettingsDivider />
      <div className="settings-subblock">
        <strong>{uiText(language)('settingsView.localComponentCheck')}</strong>
        {result ? (
          <>
            <DiagnosticRow probe={result.runtime} />
            <DiagnosticRow probe={result.productHost} />
            <DiagnosticRow probe={result.capabilities} />
          </>
        ) : (
          <p className="settings-muted">
            {checking
              ? uiText(language)('settingsView.checking')
              : uiText(language)('settingsView.notChecked')}
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
              ? uiText(language)('settingsView.checking_0fc35fb')
              : uiText(language)('settingsView.runCheck')}
          </button>
          <button className="secondary-button" type="button" onClick={() => void copyDiagnostics()}>
            <Copy size={14} />
            {uiText(language)('browserConnectionSettings.copyDiagnostics')}
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
      `CARDBUSH_VERSION=${applicationVersion}`,
      'RUNTIME=Embedded TypeScript Runtime',
      'RUNTIME_TRANSPORT=Electron typed IPC',
      `MODEL=${modelInfo.model}`,
      `PROVIDER=${modelInfo.provider}`,
      `MODEL_BASE_URL=${modelInfo.baseUrl}`,
    ].join('\n'));
  };
  return (
    <SettingsCard
      title={uiText(language)('settingsView.about')}
      subtitle={
        uiText(language)('settingsView.desktopAppInformationForCardbush')
      }
    >
      <InfoRow label={uiText(language)('settingsView.app')} value="cardbush" />
      <InfoRow label={uiText(language)('pluginManagementPanel.version')} value={applicationVersion} />
      <InfoRow label={uiText(language)('settingsView.runtime')} value="Embedded TypeScript Runtime" />
      <InfoRow label={uiText(language)('settingsView.transport')} value="Electron typed IPC" />
      <InfoRow
        label={uiText(language)('settingsView.currentModel')}
        value={`${modelInfo.provider} / ${modelInfo.model}`}
      />
      <InfoRow label={uiText(language)('settingsView.base_url')} value={modelInfo.baseUrl} />
      <div className="settings-actions">
        <button className="secondary-button" type="button" onClick={() => void copyEnvironment()}>
          <Copy size={14} />
          {uiText(language)('settingsView.copyEnvironment')}
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

export function McpServersPanel({
  initialServerId,
  initialCreate = false,
  dialogOnly = false,
  onClose,
  language,
  capabilities,
  onNotify,
}: {
  initialServerId?: string;
  initialCreate?: boolean;
  dialogOnly?: boolean;
  onClose?: () => void;
  language: AppLanguage;
  capabilities: BackendCapabilities;
  onNotify: (message: string) => void;
}) {
  const host = useSettingsHost();
  const [servers, setServers] = useState<McpServerConfig[]>([]);
  const [selectedId, setSelectedId] = useState(initialServerId ?? '');
  const [draft, setDraft] = useState<McpServerDraft>(emptyMcpDraft);
  const [editorOpen, setEditorOpen] = useState(dialogOnly);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState('');
  const [error, setError] = useState('');
  const [validation, setValidation] = useState<McpServerValidationResult | null>(null);
  const selectedIdRef = useRef(initialServerId ?? '');
  const initialEditorPending = useRef(true);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const editorPending = useRef(false);
  const closeEditor = useCallback(() => {
    setEditorOpen(false); setValidation(null); setError(''); onClose?.();
  }, [onClose]);

  const selectServerId = useCallback((serverId: string) => {
    selectedIdRef.current = serverId;
    setSelectedId(serverId);
  }, [host]);

  const loadServers = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await host.fetchMcpServers();
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
        setError(uiText(language)('settingsView.thisMcpServerWasRemovedRefreshThe'));
      }
      if (initialEditorPending.current) {
        initialEditorPending.current = false;
        setEditorOpen(dialogOnly || Boolean(selected) || (!currentId && initialCreate));
      }
    } catch (caught) {
      setError(mcpErrorText(caught, language));
    } finally {
      setLoading(false);
    }
  }, [host, language, initialCreate, dialogOnly, selectServerId]);

  useEffect(() => {
    void loadServers();
  }, [loadServers]);

  const refreshServerStatus = useCallback(async (isCurrent: () => boolean) => {
    const result = await host.fetchMcpServers();
    if (isCurrent()) setServers(result.servers);
  }, []);
  useCapabilityCatalogRefresh(refreshServerStatus);
  useEffect(() => {
    if (!servers.some((server) => ['pending', 'waiting_for_resources', 'restarting'].includes(server.status ?? ''))) return;
    let active = true;
    const timer = window.setTimeout(() => void refreshServerStatus(() => active).catch(() => undefined), 1_000);
    return () => { active = false; window.clearTimeout(timer); };
  }, [servers, refreshServerStatus]);

  const updateDraft = useCallback((patch: Partial<McpServerDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setValidation(null);
  }, []);

  const startNew = useCallback(() => {
    // Reopening a new server keeps the draft until the user leaves this page.
    if (selectedIdRef.current) setDraft(emptyMcpDraft);
    selectServerId('');
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
    if (busyKey || loading || editorPending.current) return;
    editorPending.current = true;
    setBusyKey('validate');
    setError('');
    setValidation(null);
    try {
      const result = await validateMcpServerConfig(makeInput());
      setValidation(result);
      onNotify(
        result.ok
          ? uiText(language)('settingsView.mcpConfigValidationPassed')
          : uiText(language)('settingsView.mcpConfigValidationFailed'),
      );
    } catch (caught) {
      setError(mcpErrorText(caught, language));
    } finally {
      setBusyKey('');
      editorPending.current = false;
    }
  }, [busyKey, loading, language, makeInput, onNotify]);

  const saveServer = useCallback(async () => {
    if (busyKey || loading || editorPending.current) return;
    editorPending.current = true;
    setBusyKey('save');
    setError('');
    try {
      const saved = await host.saveMcpServerConfig(makeInput());
      selectServerId(saved.id);
      setDraft(mcpDraftFromServer(saved));
      setValidation(null);
      await loadServers();
      onNotify(uiText(language)('settingsView.mcpServerSaved'));
      closeEditor();
    } catch (caught) {
      setError(mcpErrorText(caught, language));
    } finally {
      setBusyKey('');
      editorPending.current = false;
    }
  }, [host, busyKey, loading, language, loadServers, makeInput, onNotify, selectServerId, closeEditor]);

  const toggleServer = useCallback(
    async (server: McpServerConfig) => {
      const nextEnabled = !server.enabled;
      setBusyKey(`toggle:${server.id}`);
      setError('');
      try {
        await host.setMcpServerEnabled(server.id, nextEnabled);
        await loadServers();
        onNotify(
          nextEnabled
            ? uiText(language)('settingsView.mcpServerEnabled')
            : uiText(language)('settingsView.mcpServerDisabled'),
        );
      } catch (caught) {
        setError(mcpErrorText(caught, language));
      } finally {
        setBusyKey('');
      }
    },
    [host, language, loadServers, onNotify],
  );

  const removeServer = useCallback(
    async (server: McpServerConfig) => {
      const confirmed = window.confirm(
        uiText(language)('settingsView.deleteMcpServer', { value1: server.name || server.id }),
      );
      if (!confirmed) {
        return;
      }
      setBusyKey(`delete:${server.id}`);
      setError('');
      try {
        await host.deleteMcpServerConfig(server.id);
        if (selectedId === server.id) {
          selectServerId('');
          setDraft(emptyMcpDraft);
          closeEditor();
        }
        await loadServers();
        onNotify(uiText(language)('settingsView.mcpServerDeleted'));
      } catch (caught) {
        setError(mcpErrorText(caught, language));
      } finally {
        setBusyKey('');
      }
    },
    [host, language, loadServers, onNotify, selectedId, selectServerId, closeEditor],
  );

  const selectedServer = servers.find((server) => server.id === selectedId);
  const userServers = servers.filter((server) => !mcpServerIsFromPlugin(server));
  const capabilityUndeclared = !capabilities.mcpServers;

  const editor = editorOpen && <SettingsFormDialog id="mcp-server-editor" className="mcp-server-dialog"
    language={language} busy={Boolean(busyKey) || loading} onCancel={closeEditor} onSubmit={saveServer}
    title={selectedId ? (uiText(language)('settingsView.configureServer')) : (uiText(language)('settingsView.addServer'))}
    description={uiText(language)('settingsView.configureAConnectionToExternalToolsAnd')}
    footer={<>
      {selectedServer && <button className="secondary-button danger settings-dialog-secondary-action" type="button" disabled={Boolean(busyKey) || loading}
        onClick={() => void removeServer(selectedServer)}><Trash2 size={14}/>{uiText(language)('appCenter.delete')}</button>}
      <button className="secondary-button" type="button" disabled={Boolean(busyKey) || loading} onClick={closeEditor}>{uiText(language)('agentConnectionForm.cancel')}</button>
      <button className="secondary-button" type="button" disabled={Boolean(busyKey) || loading} onClick={() => void validateServer()}>
        {busyKey === 'validate' ? <LoaderCircle size={14} className="spin"/> : <CheckCircle2 size={14}/>}{uiText(language)('settingsView.validate')}</button>
      <button className="primary-button" type="submit" disabled={Boolean(busyKey) || loading}>
        {busyKey === 'save' ? <LoaderCircle size={14} className="spin"/> : <Upload size={14}/>}{busyKey === 'save' ? (uiText(language)('automationPanel.saving')) : (uiText(language)('appCenter.save'))}</button>
    </>}>
    <fieldset className="settings-dialog-fields" disabled={Boolean(busyKey) || loading}>
      <div className="mcp-compact-form">
        <SettingsInput
          label={uiText(language)('agentConnectionForm.name')}
          value={draft.name}
          placeholder={uiText(language)('settingsView.node_repl')}
          onChange={(value) => updateDraft({ name: value })}
        />
        <label className="settings-field">
          <span>{uiText(language)('settingsView.connection')}</span>
          <SettingsDropdown label={uiText(language)('settingsView.connection')} value={draft.transport}
            onChange={transport => updateDraft({ transport: transport as McpTransport })}
            options={[{ value: 'stdio', label: 'stdio' }, { value: 'sse', label: 'SSE' }, { value: 'streamable_http', label: uiText(language)('settingsView.http_stream') }, { value: 'http', label: 'HTTP' }]} />
        </label>
        {draft.transport === 'stdio' ? (
          <SettingsInput
            label={uiText(language)('settingsView.command')}
            value={draft.command}
            placeholder={uiText(language)('settingsView.npx_modelcontextprotocol_server_filesystem_c_users_fixture')}
            onChange={(value) => updateDraft({ command: value })}
          />
        ) : (
          <SettingsInput
            label={uiText(language)('settingsView.url')}
            value={draft.url}
            placeholder={uiText(language)('settingsView.http_127_0_0_1_3000_sse')}
            onChange={(value) => updateDraft({ url: value })}
          />
        )}
      </div>
      <details key={selectedId || 'new'} className="mcp-advanced">
        <summary>{uiText(language)('pluginMcpSettings.advancedSettings')}</summary>
        <div className="mcp-form-grid">
          <SettingsInput
            label={uiText(language)('settingsView.id')}
            value={draft.id}
            placeholder={uiText(language)('settingsView.filesystem')}
            onChange={(value) => updateDraft({ id: value })}
          />
          <SettingsInput
            label={uiText(language)('settingsView.workingDirectory')}
            value={draft.cwd}
            placeholder={uiText(language)('settingsView.c_users')}
            onChange={(value) => updateDraft({ cwd: value })}
          />
          <SettingsInput
            label={uiText(language)('settingsView.description')}
            value={draft.description}
            placeholder={uiText(language)('settingsView.whatThisMcpServerProvides')}
            onChange={(value) => updateDraft({ description: value })}
          />
        </div>
        <div className="mcp-form-grid">
          <label className="mcp-editor">
            <span>{uiText(language)('settingsView.env_json')}</span>
            <textarea
              value={draft.envText}
              placeholder={uiText(language)('settingsView.10_quot_api_key_quot_quot_quot')}
              onChange={(event) => updateDraft({ envText: event.currentTarget.value })}
            />
          </label>
          <label className="mcp-editor">
            <span>{uiText(language)('settingsView.headers_json')}</span>
            <textarea
              value={draft.headersText}
              placeholder={uiText(language)('settingsView.10_quot_authorization_quot_quot_bearer_quot')}
              onChange={(event) => updateDraft({ headersText: event.currentTarget.value })}
            />
          </label>
        </div>
      </details>
      {validation && (
        <div className={`subagent-validation ${validation.ok ? 'ok' : 'invalid'}`}>
          <strong>
            {validation.ok
              ? uiText(language)('settingsView.validationPassed')
              : uiText(language)('settingsView.validationFailed')}
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
                : uiText(language)('settingsView.noErrorDetailsWereReturned')}
            </p>
          )}
        </div>
      )}
      {error && <p className="settings-inline-error" role="alert">{error}</p>}
    </fieldset>
  </SettingsFormDialog>;
  if (dialogOnly) return editor;

  return (
    <div className="mcp-simple-page">
      <header className="mcp-page-header">
        <div>
          <h3>{uiText(language)('pluginWorkspace.mcpServers')}</h3>
          <p>
            {uiText(language)('settingsView.connectExternalToolsAndDataSources')}
            <a
              className="mcp-inline-link"
              href="https://modelcontextprotocol.io"
              target="_blank"
              rel="noreferrer"
            >
              {uiText(language)('settingsView.learnMore')}
            </a>
          </p>
        </div>
      </header>

      {capabilityUndeclared && (
        <p className="settings-inline-error">
          {uiText(language)('settingsView.theTypescriptRuntimeDoesNotExposeMcp')}
        </p>
      )}
      {error && !editorOpen && <p className="settings-inline-error">{error}</p>}

      <section className="mcp-simple-section">
        {servers.some((server) => server.status === 'pending') && <p role="status">
          {uiText(language)('settingsView.savedUpdatesApplyAfterTheAffectedTool')}
        </p>}
        {servers.find((server) => server.lastError)?.lastError && <p className="settings-inline-error" role="alert">
          {uiText(language)('settingsView.mcpConnectionIssue')}
          {servers.find((server) => server.lastError)?.lastError}
        </p>}
        <div className="mcp-section-title">
          <strong>{uiText(language)('settingsView.servers')}</strong>
          <button ref={addButtonRef} className="mcp-add-button" type="button" disabled={loading || Boolean(busyKey)}
            aria-haspopup="dialog" aria-controls="mcp-server-editor" onClick={startNew}>
            <Plus size={16} />
            {uiText(language)('settingsView.addServer')}
          </button>
        </div>
        <div className="mcp-simple-list">
          {loading ? (
            <div className="mcp-empty-row">
              <LoaderCircle size={16} />
              <span>{uiText(language)('settingsView.loading')}</span>
            </div>
          ) : userServers.length === 0 ? (
            <div className="mcp-empty-row">
              <span>{uiText(language)('settingsView.noServers')}</span>
            </div>
          ) : (
            userServers.map((server) => (
              <div className="mcp-simple-row" key={server.id}>
                <PluginIcon size={18} />
                <strong>{server.name || server.id}</strong>
                {server.status === 'waiting_for_resources' && <span role="status">{uiText(language)('settingsView.waitingForResourcesConnectsAutomatically')}</span>}
                {!host.remote && server.transport !== 'stdio' && <button className="mcp-icon-button" type="button" disabled={Boolean(busyKey)} onClick={() => {
                  setBusyKey(server.id); setError('');
                  void window.cardbushDesktop!.mcpConnectionAction(server.id, 'login').then(() => host.fetchMcpServers()).then(value => setServers(value.servers)).catch(caught => setError(mcpErrorText(caught, language))).finally(() => setBusyKey(''));
                }}>{server.status === 'auth_required' ? (uiText(language)('pluginMcpSettings.signInRequired')) : (uiText(language)('pluginMcpSettings.signIn'))}</button>}
                {server.transport !== 'stdio' && <button className="mcp-icon-button" type="button" disabled={Boolean(busyKey) && busyKey !== server.id} onClick={() => {
                  const action = busyKey === server.id ? 'cancel_login' : 'logout';
                  void window.cardbushDesktop!.mcpConnectionAction(server.id, action).then(() => host.fetchMcpServers()).then(value => setServers(value.servers)).catch(caught => setError(mcpErrorText(caught, language)));
                }}>{busyKey === server.id ? (uiText(language)('pluginMcpSettings.cancelSignIn')) : (uiText(language)('pluginMcpSettings.signOut'))}</button>}


                {host.remote && <button className="mcp-icon-button" type="button" disabled={Boolean(busyKey)} onClick={() => {
                  setBusyKey(server.id); void host.mcpConnectionAction(server.id, 'reconnect').then(loadServers).catch(error => setError(mcpErrorText(error, language))).finally(() => setBusyKey(''));
                }}>{uiText(language)('pluginMcpSettings.reconnect')}</button>}
                <button
                  className="mcp-icon-button"
                  type="button"
                  title={uiText(language)('settingsView.configure')}
                  disabled={Boolean(busyKey)}
                  aria-haspopup="dialog"
                  aria-controls="mcp-server-editor"
                  onClick={() => selectServer(server)}
                >
                  <Settings size={16} />
                </button>
                <button
                  className={`mcp-toggle ${server.enabled ? 'on' : ''}`}
                  type="button"
                  disabled={Boolean(busyKey)}
                  title={server.enabled ? (uiText(language)('pluginMcpSettings.disable')) : (uiText(language)('automationPanel.enable'))}
                  onClick={() => void toggleServer(server)}
                >
                  <span />
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      {!host.remote && <CardbushAppsPanel language={language} onNotify={onNotify} />}
      {editor}
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
    message: string,
  ) => {
    setBusyKey(key);
    setError('');
    try {
      const saved = await saveCardbushAppsConfiguration(next);
      setConfiguration(saved);
      onNotify(message);
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
          <strong>{uiText(language)('settingsView.cardbush_apps')}</strong>
          <small>{uiText(language)('settingsView.independentMcpPluginServiceAppsRegisterAnd')}</small>
        </div>
        <button
          className={`mcp-toggle ${serviceEnabled ? 'on' : ''}`}
          type="button"
          disabled={!configuration || Boolean(busyKey)}
          title={serviceEnabled
            ? uiText(language)('settingsView.disableCardbushApps')
            : uiText(language)('settingsView.enableCardbushApps')}
          onClick={() => configuration && void persist(
            { ...configuration, serviceEnabled: !configuration.serviceEnabled },
            'service',
            configuration.serviceEnabled ? uiText(language)('apps.disabled') : uiText(language)('apps.enabled'),
          )}
        >
          <span />
        </button>
      </div>

      {error && <p className="settings-inline-error">{error}</p>}
      <div className="cardbush-app-list">
        {!configuration || busyKey === 'load' ? (
          <div className="mcp-empty-row"><LoaderCircle size={16} /><span>{uiText(language)('settingsView.loading')}</span></div>
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
                    title={uiText(language)('settingsView.pluginSettings')}
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
                      title={plugin.enabled ? (uiText(language)('settingsView.disablePlugin')) : (uiText(language)('settingsView.enablePlugin'))}
                      onClick={() => void persist({
                        ...configuration,
                        plugins: configuration.plugins.map((item) => item.id === plugin.id
                          ? { ...item, enabled: !item.enabled }
                          : item),
                      }, `toggle:${plugin.id}`, plugin.enabled ? uiText(language)('plugins.disabled') : uiText(language)('plugins.enabled'))}
                    >
                      <span />
                    </button>
                    <button
                      className="secondary-button compact danger"
                      type="button"
                      disabled={Boolean(busyKey)}
                      onClick={() => {
                        const confirmed = window.confirm(uiText(language)('settingsView.uninstallItsSettingsWillBeRetainedFor', { value1: plugin.name }));
                        if (!confirmed) return;
                        void persist({
                          ...configuration,
                          plugins: configuration.plugins.map((item) => item.id === plugin.id
                            ? { ...item, installed: false, enabled: false }
                            : item),
                        }, `uninstall:${plugin.id}`, uiText(language)('plugins.uninstalled'));
                      }}
                    >
                      {uiText(language)('settingsView.uninstall')}
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
                    }, `install:${plugin.id}`, uiText(language)('plugins.installed'))}
                  >
                    <Plus size={14} />
                    {uiText(language)('browserInstallButton.install')}
                  </button>
                )}
              </div>

              {expanded && ['computer-use', 'computer_use'].includes(plugin.id) && (
                <ComputerUseSettings language={language} plugin={plugin} busy={Boolean(busyKey)} onReplace={replacePlugin}
                  onPersist={(next, message) => void persist({ ...configuration,
                    plugins: configuration.plugins.map(item => item.id === next.id ? next : item),
                  }, 'config:' + plugin.id, message)} />
              )}
              {expanded && plugin.id === 'chrome' && (
                <div className="cardbush-app-config chrome-connector-settings-wrap">
                  <BrowserConnectionSettings
                    language={language}
                    plugin={plugin}
                    busy={Boolean(busyKey)}
                    onReplace={replacePlugin}
                    onPersist={(next, message) => void persist({
                      ...configuration,
                      plugins: configuration.plugins.map((item) => item.id === next.id ? next : item),
                    }, `config:${plugin.id}`, message)}
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
    throw new Error(uiText(language)('settingsView.stdioTransportRequiresACommand'));
  }
  if (draft.transport !== 'stdio' && !draft.url.trim()) {
    throw new Error(uiText(language)('settingsView.remoteMcpTransportRequiresAUrl'));
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
      uiText(language)('settingsView.mustBeAValidJsonObject', { label }),
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
    return uiText(language)('settingsView.invalidMcpTransportConfig', { message });
  }
  return message;
}

function DiagnosticRow({ probe }: { probe: DiagnosticProbe }) {
  const language = useUiLanguage();
  return (
    <div className={`diagnostic-row ${probe.ok ? 'ok' : 'fail'}`}>
      {probe.ok ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
      <div>
        <strong>{probe.label}</strong>
        <span>{probe.detail}</span>
      </div>
      <small>{probe.elapsedMs}{uiText(language)('settingsView.ms')}</small>
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

type ProviderModelListResult = {
  endpoint: string;
  models: string[];
  rawCount: number;
};

async function requestProviderModels(
  baseUrl: string,
  apiKey: string,
  options: import('./settings/modelProtocols').ModelDiscoveryOptions,
): Promise<ProviderModelListResult> {
  if (window.cardbushDesktop?.listProviderModels) {
    return window.cardbushDesktop.listProviderModels(baseUrl, apiKey, options);
  }
  const endpoint = modelListEndpoint(baseUrl);
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      ...(options.apiProtocol === 'anthropic_messages'
        ? { 'x-api-key': apiKey.trim(), 'anthropic-version': '2023-06-01' }
        : { authorization: `Bearer ${apiKey.trim()}` }),
      ...modelRequestHeaders(baseUrl, options.defaultHeaders, 'cardbush-model-discovery'),
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
    throw new Error(uiText()('settingsView.missing_base_url'));
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(uiText()('settingsView.base_url_must_be_an_http_s'));
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(uiText()('settingsView.base_url_must_be_an_http_s'));
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
    uiText(language)('settingsView.determinedByProductHost');
  const config = settings.managedModelConfigs.find(
    (item) => item.id.trim().toLowerCase() === selectedModel.trim().toLowerCase(),
  ) ?? settings.managedModelConfigs.find(
    (item) => item.modelName.trim().toLowerCase() === selectedModel.trim().toLowerCase(),
  );
  if (!config || !shouldUseManagedConfig(config)) {
    return {
      source: uiText(language)('settingsView.productHostDefaultConfig'),
      model: config?.modelName || selectedModel || determinedByHost,
      provider: determinedByHost,
      apiKeyLabel: determinedByHost,
      baseUrl: determinedByHost,
    };
  }
  return {
    source: uiText(language)('settingsView.managedModelConfig'),
    model: config.modelName,
    provider: config.provider || (uiText(language)('settingsView.notFilled')),
    apiKeyLabel:
      config.apiKeyMasked ||
      (config.hasApiKey
        ? uiText(language)('settingsView.configured')
        : maskSecret(config.apiKey, language)),
    baseUrl: config.baseUrl || (uiText(language)('settingsView.notFilled')),
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
    return uiText(language)('settingsView.notFilled');
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
    throw new Error(uiText()('runtimeChat.electron_runtime_bridge_is_unavailable'));
  }
}

function assertProductHost() {
  if (!window.cardbushDesktop?.productHostCommand) {
    throw new Error(uiText()('productMcp.cardbush_product_host_is_unavailable'));
  }
}

function diagnosticSummary(probe: DiagnosticProbe) {
  return `${probe.ok ? 'ok' : 'fail'}${probe.statusCode ? ` HTTP ${probe.statusCode}` : ''} ${probe.elapsedMs}ms ${probe.detail}`;
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
    throw new Error(uiText()('messageFeedback.copy_failed'));
  }
  window.dispatchEvent(new CustomEvent(COPY_FEEDBACK_EVENT));
}
