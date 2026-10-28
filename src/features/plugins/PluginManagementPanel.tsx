import { uiText, localizedContent } from '../../i18n';
import { dialogEventHandler } from '../../shared/dialogEvents';
import { useSettingsHost } from '../settings/SettingsHostContext';
import { BrowserConnectionSettings } from '../browser/BrowserConnectionSettings';
import { ComputerUseSettings } from '../computerUse/ComputerUseSettings';
import { RuntimePluginWorkspace } from '../../plugins/runtimeWorkspaces';
import { PluginMcpSettings } from './PluginMcpSettings';
import { pluginPrompt } from './pluginPrompts';
import { pluginPresentation } from './pluginPresentation';
import { NetworkProxySettings, proxyLabel } from '../settings/NetworkProxySettings';
import { PluginSearchSettings } from './PluginSearchSettings';
import { DEFAULT_SEARCH_RESULT_LIMIT, defaultPluginProxy, type PluginProxySettings as ProxySettings } from '@cardbush/bush-protocol';
import { AccountsPanel } from '../accounts/AccountsPanel';
import { useCapabilityCatalogRefresh } from '../../hooks/useCapabilityCatalogRefresh';
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  FileArchive,
  FolderOpen,
  LoaderCircle,
  PackagePlus,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  Store,
  Trash2,
  UserRound,
} from 'lucide-react';
import { type CSSProperties, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { PageNavigationScope, usePageState } from '../navigation/PageNavigation';


import type { McpConnectionOverview } from '../../backend/mcpConnectionOverview';
import { pluginMcpConnections, type PluginMcpConnection } from './pluginConnections';
import { fileUrl } from '../../shared/localPaths';
import type {
  AppLanguage,
  CardbushAppPlugin,
  CardbushAppsConfiguration,
  SkillDetail,
  SkillSummary,
} from '../../types';
import { SkillIcon } from '../skills/SkillIcon';
import { PluginIcon } from '../../components/PluginIcon';
import { PluginMarketplacePanel } from './PluginMarketplacePanel';
import { usePluginNavigation, type PluginPage as Page, type ManageTab } from './usePluginNavigation';
import './plugin-management.css';
import { SettingsCard } from '../settings/SettingsControls';

export function PluginManagementPanel({
  language,
  initialTab,
  skills,
  disabledSkillNames,
  onToggleSkill,
  onReloadSkills,
  onLoadSkillDetail,
  onOpenMcp,
  renderMcp,
  onNotify,
  onOpenPrompt,
  presentation = 'catalog',
  onOpenNetwork,
  requestedPlugin,
}: {
  language: AppLanguage;
  initialTab: 'plugins' | 'skills';
  skills: SkillSummary[];
  disabledSkillNames: Set<string>;
  onToggleSkill: (skillName: string, enabled: boolean) => void;
  onReloadSkills: () => Promise<SkillSummary[]>;
  onLoadSkillDetail: (skillName: string) => Promise<SkillDetail>;
  onOpenMcp?: (serverId?: string) => void;
  renderMcp?: (serverId?: string, dialog?: { dialogOnly: true; onClose: () => void }) => ReactNode;
  onNotify: (message: string) => void;
  onOpenPrompt?: (prompt: string) => void;
  presentation?: 'catalog' | 'network';
  onOpenNetwork?: () => void;
  requestedPlugin?: { id: string; nonce: number; extensionId?: string };
}) {
  const host = useSettingsHost();
  const [installPath, setInstallPath] = useState('');
  const [installOpen, setInstallOpen] = useState(false);
  const [tab, setTab] = usePageState<'plugins' | 'skills' | 'accounts'>('plugin-tab', initialTab);
  const navigationScope = useContext(PageNavigationScope);
  const { rootRef, entries, page, open: setPage, back, reset, dismissPlugin } = usePluginNavigation();
  const appliedPluginRequest = useRef<typeof requestedPlugin>(undefined);
  useEffect(() => {
    if (!requestedPlugin || appliedPluginRequest.current === requestedPlugin) return;
    appliedPluginRequest.current = requestedPlugin;
    setTab('plugins'); setPage(requestedPlugin.extensionId
      ? { kind: 'workspace', pluginId: requestedPlugin.id, extensionId: requestedPlugin.extensionId }
      : { kind: 'plugin', pluginId: requestedPlugin.id });
  }, [requestedPlugin, setPage]);
  const [mcpDialog, setMcpDialog] = useState<{ serverId?: string } | null>(null);
  const openMcp = (serverId?: string) => renderMcp ? setMcpDialog({ serverId }) : onOpenMcp?.(serverId);
  const [configuration, setConfiguration] = useState<CardbushAppsConfiguration | null>(null);
  const [localSkills, setLocalSkills] = useState(skills);
  const [skillDetail, setSkillDetail] = useState<SkillDetail | null>(null);
  const [query, setQuery] = useState('');
  const [proxyQuery, setProxyQuery] = useState('');
  const [proxyResetRevision, setProxyResetRevision] = useState(0);
  const [busy, setBusy] = useState('load');
  const [error, setError] = useState('');
  const [addOpen, setAddOpen] = useState(false);
  const [marketProxyOpen, setMarketProxyOpen] = useState(false);
  const [mcpOverview, setMcpOverview] = useState<McpConnectionOverview | null>(null);
  const [mcpError, setMcpError] = useState('');
  const [mcpLoading, setMcpLoading] = useState(true);
  const mcpLoadRevision = useRef(0);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const dirtyPluginIds = useRef(new Set<string>());
  const uninstalling = useRef(false);
  const skillLoadRevision = useRef(0);

  const loadSkillDetail = useCallback(async (name: string, isCurrent: () => boolean, quiet = false) => {
    const revision = ++skillLoadRevision.current;
    const current = () => isCurrent() && revision === skillLoadRevision.current;
    if (!quiet) { setBusy(`skill:${name}`); setError(''); }
    try {
      const detail = await onLoadSkillDetail(name);
      if (current()) setSkillDetail(detail);
    } catch (caught) {
      if (current()) setError(errorMessage(caught));
    } finally {
      if (current()) setBusy(value => value === `skill:${name}` ? '' : value);
    }
  }, [onLoadSkillDetail]);

  useEffect(() => {
    if (page.kind !== 'skill') {
      setBusy(value => value.startsWith('skill:') ? '' : value);
      return;
    }
    let disposed = false;
    setSkillDetail(null);
    void loadSkillDetail(page.skillName, () => !disposed);
    return () => { disposed = true; };
  }, [page, loadSkillDetail]);

  useEffect(() => setLocalSkills(skills), [skills]);
  const previousInitialTab = useRef(initialTab);
  useEffect(() => {
    if (previousInitialTab.current === initialTab) return;
    previousInitialTab.current = initialTab;
    setTab(initialTab);
    reset();
  }, [initialTab, reset]);
  useEffect(() => {
    if (!addOpen) return;
    const closeFromOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && !addMenuRef.current?.contains(target)) setAddOpen(false);
    };
    const closeFromKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAddOpen(false);
    };
    document.addEventListener('pointerdown', closeFromOutside, true);
    document.addEventListener('keydown', closeFromKeyboard);
    return () => {
      document.removeEventListener('pointerdown', closeFromOutside, true);
      document.removeEventListener('keydown', closeFromKeyboard);
    };
  }, [addOpen]);

  const receiveConfiguration = useCallback((apps: CardbushAppsConfiguration) => {
    setConfiguration(current => {
      if (current && apps.revision < current.revision) return current;
      const next = { ...apps, plugins: apps.plugins.map(plugin => dirtyPluginIds.current.has(plugin.id)
        ? current?.plugins.find(item => item.id === plugin.id) ?? plugin : plugin) };
      return JSON.stringify(current) === JSON.stringify(next) ? current : next;
    });
  }, []);

  const loadConnections = useCallback(async (isCurrent: () => boolean = () => true) => {
    const revision = ++mcpLoadRevision.current;
    const current = () => revision === mcpLoadRevision.current && isCurrent();
    // The initial read owns the loading placeholder. Background reads retain
    // existing rows so focus, open menus and list positions do not flicker.
    try {
      const result = await host.fetchMcpConnectionOverview();
      if (current()) {
        setMcpOverview(current => JSON.stringify(current) === JSON.stringify(result) ? current : result);
        setMcpError('');
      }
    } catch (caught) {
      if (current()) {
        setMcpError(errorMessage(caught));
        setMcpOverview(value => value ? { ...value, snapshot: null } : null);
      }
    } finally {
      if (revision === mcpLoadRevision.current) setMcpLoading(false);
    }
  }, [host]);

  const load = useCallback(async () => {
    setBusy('load');
    setError('');
    void loadConnections();
    try {
      const [apps, loadedSkills] = await Promise.all([
        host.fetchCardbushAppsConfiguration(),
        onReloadSkills(),
      ]);
      receiveConfiguration(apps);
      setLocalSkills(loadedSkills);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy('');
    }
  }, [host, onReloadSkills, loadConnections, receiveConfiguration]);

  useEffect(() => !host.remote ? window.cardbushDesktop?.onAccountsChanged?.(() => { void loadConnections(); }) : undefined, [host, loadConnections]);

  useEffect(() => {
    void load();
    return () => { mcpLoadRevision.current += 1; };
  }, [load]);

  useCapabilityCatalogRefresh(useCallback(async (isCurrent: () => boolean) => {
    await Promise.all([
      loadConnections(isCurrent),
      host.fetchCardbushAppsConfiguration().then(apps => { if (isCurrent()) receiveConfiguration(apps); }),
      page.kind === 'skill' ? loadSkillDetail(page.skillName, isCurrent, true) : undefined,
    ]);
  }, [host, page, loadSkillDetail, loadConnections, receiveConfiguration]));

  const persist = useCallback(async (
    next: CardbushAppsConfiguration,
    key: string,
    message: string,
  ) => {
    setBusy(key);
    setError('');
    try {
      const saved = await host.saveCardbushAppsConfiguration(next);
      dirtyPluginIds.current.clear();
      receiveConfiguration(saved);
      void loadConnections();
      setLocalSkills(await onReloadSkills());
      onNotify(message);
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      return false;
    } finally {
      setBusy('');
    }
  }, [host, onNotify, onReloadSkills, loadConnections, receiveConfiguration]);

  const replacePlugin = useCallback((plugin: CardbushAppPlugin) => {
    dirtyPluginIds.current.add(plugin.id);
    setConfiguration((current) => current ? {
      ...current,
      plugins: current.plugins.map((item) => item.id === plugin.id ? plugin : item),
    } : current);
  }, []);

  const uninstallPlugin = async (plugin: CardbushAppPlugin) => {
    if (busy || uninstalling.current) return;
    uninstalling.current = true;
    setBusy(`uninstall:${plugin.id}`); setError('');
    try {
      const result = await host.uninstallCardbushPlugin(plugin.id);
      dirtyPluginIds.current.delete(plugin.id);
      receiveConfiguration(result.configuration);
      dismissPlugin(plugin.id);
      onNotify(uiText(language)('pluginManagementPanel.uninstalled', { value1: plugin.name }));
      try { setLocalSkills(await onReloadSkills()); }
      catch (caught) { setError(current => current || (uiText(language)('pluginManagementPanel.pluginUninstalledButSkillRefreshFailed', { value1: errorMessage(caught) }))); }
      await loadConnections();
    } catch (caught) {
      setError(uiText(language)('pluginManagementPanel.uninstallIncomplete', { value1: errorMessage(caught) }));
      await host.fetchCardbushAppsConfiguration().then(receiveConfiguration).catch(() => undefined);
    }
    finally { uninstalling.current = false; setBusy(''); }
  };

  const observingConnections = mcpOverview?.snapshot?.applicationState === 'pending' || mcpOverview?.snapshot?.servers.some(server => server.health === 'restarting');
  useEffect(() => {
    if (!observingConnections || page.kind !== 'manage') return;
    let disposed = false;
    let timer = 0;
    const check = async () => {
      if (document.visibilityState !== 'hidden') await loadConnections(() => !disposed);
      if (!disposed) timer = window.setTimeout(() => void check(), 2_000);
    };
    timer = window.setTimeout(() => void check(), 2_000);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [observingConnections, page.kind, loadConnections]);

  const installLocal = async (kind: 'directory' | 'zip') => {
    setAddOpen(false);
    if (host.remote) { setInstallOpen(true); return; }
    if (busy || !window.cardbushDesktop) return;
    setBusy('install-local');
    setError('');
    try {
      const installed = await window.cardbushDesktop.installLocalPlugin(kind);
      if (!installed) return;
      onNotify(uiText(language)('pluginManagementPanel.installed', { value1: installed.id }));
      await load();
    } catch (caught) { setError(errorMessage(caught)); }
    finally { setBusy(''); }
  };

  const openSkill = useCallback((skill: SkillSummary) => {
    setPage({ kind: 'skill', skillName: skill.name });
  }, [setPage]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const plugins = configuration?.plugins ?? [];
  const connections = pluginMcpConnections(plugins, mcpOverview, configuration?.serviceEnabled ?? true);
  const filteredConnections = connections.filter(item => !normalizedQuery || [
    item.id, item.name, item.description, item.plugin?.name ?? '', 'MCP',
  ].join(' ').toLocaleLowerCase().includes(normalizedQuery));
  const filteredPlugins = useMemo(() => plugins.filter((plugin) => !normalizedQuery || [
    plugin.name,
    plugin.description,
    pluginPresentation(plugin, language).description,
    plugin.category,
    ...plugin.keywords,
    ...plugin.components.flatMap((component) => [component.name, component.description, component.id]),
  ].join(' ').toLocaleLowerCase().includes(normalizedQuery)), [normalizedQuery, plugins, language]);
  const filteredSkills = useMemo(() => localSkills.filter((skill) => !normalizedQuery || [
    skill.name,
    skill.displayName ?? '',
    skill.description,
    skill.descriptionZh ?? '',
    skill.sourceLabel ?? '',
  ].join(' ').toLocaleLowerCase().includes(normalizedQuery)), [localSkills, normalizedQuery]);

  const savePluginProxy = (pluginId: string, proxy?: ProxySettings) => configuration ? persist({ ...configuration,
    plugins: configuration.plugins.map(item => item.id === pluginId ? { ...item, config: { ...item.config, proxy } } : item),
  }, `proxy:${pluginId}`, uiText(language)('pluginManagementPanel.proxySettingsSaved')) : Promise.resolve(false);
  const saveStandaloneProxy = async (id: string, proxy?: ProxySettings) => {
    setBusy(`proxy:mcp:${id}`); setError('');
    try {
      await host.setMcpServerProxy(id, proxy);
      setMcpOverview(current => current ? { ...current, servers: current.servers.map(server => server.id === id ? { ...server, proxy } : server) } : current);
      await loadConnections(); onNotify(uiText(language)('pluginManagementPanel.mcpProxySaved')); return true;
    }
    catch (caught) { setError(errorMessage(caught)); return false; }
    finally { setBusy(''); }
  };
  const saveGlobalProxy = async (proxy: ProxySettings, applyToAll = false) => {
    if (busy) return false;
    setBusy('proxy:global'); setError('');
    try {
      const latest = await host.fetchCardbushAppsConfiguration();
      // Persist and request runtime application even on a retry whose values
      // already reached disk before the previous runtime refresh failed.
      const saved = await host.saveCardbushAppsConfiguration({ ...latest, proxy, plugins: applyToAll
        ? latest.plugins.map(plugin => ({ ...plugin, config: { ...plugin.config, proxy: undefined } })) : latest.plugins });
      receiveConfiguration(saved);
      if (applyToAll) {
        // Preserve other unsaved plugin fields while clearing this explicit override.
        setConfiguration(current => current && current.revision === saved.revision ? { ...current,
          plugins: current.plugins.map(plugin => ({ ...plugin, config: { ...plugin.config, proxy: undefined } })),
        } : current);
        await host.resetMcpServerProxies();
        setMcpOverview(current => current ? { ...current, servers: current.servers.map(server => ({ ...server, proxy: undefined })) } : current);
        setProxyResetRevision(value => value + 1);
      }
      onNotify(applyToAll
        ? (uiText(language)('pluginManagementPanel.savedAndAppliedToAllPluginsAnd'))
        : (uiText(language)('pluginManagementPanel.pluginProxySaved')));
      return true;
    } catch (caught) {
      setError(errorMessage(caught));
      // A runtime refresh can fail after a durable write. Read back the saved
      // facts so the page cannot revert to an older default on the next edit.
      await host.fetchCardbushAppsConfiguration().then(receiveConfiguration).catch(() => undefined);
      return false;
    }
    finally { await loadConnections(); setBusy(''); }
  };
  const saveSearchLimit = async (limit: number) => {
    if (busy) return;
    setBusy('search:default'); setError('');
    try {
      receiveConfiguration(await host.savePluginSearchResultLimit(limit));
      onNotify(uiText(language)('pluginManagementPanel.searchResultLimitSaved'));
    } catch (caught) { throw new Error(errorMessage(caught)); }
    finally { setBusy(''); }
  };
  const proxyMatches = (name: string, id: string) => `${name} ${id}`.toLocaleLowerCase().includes(proxyQuery.trim().toLocaleLowerCase());
  const renderPage = (page: Page, parent?: Page) => {
  const selectedPlugin = page.kind === 'plugin' ? plugins.find(plugin => plugin.id === page.pluginId) : undefined;
  const backLabel = parent?.kind === 'marketplace' ? (uiText(language)('pluginManagementPanel.backToMarketplace'))
    : parent?.kind === 'manage' ? (uiText(language)('pluginManagementPanel.backToManagement'))
    : (uiText(language)('pluginManagementPanel.backToPlugins'));

  if (page.kind === 'mcp') return <div className="plugin-mcp-settings">
    <button type="button" className="plugin-back" onClick={back}><ArrowLeft size={17}/>{backLabel}</button>
    {renderMcp?.(page.serverId)}
  </div>;

  if (presentation === 'network' || page.kind === 'network') return <div className="plugin-detail-page plugin-network-page">
    {presentation !== 'network' && <>
    <button type="button" className="plugin-back" onClick={back}><ArrowLeft size={17}/>{backLabel}</button>
    <header className="plugin-catalog-heading"><h2>{uiText(language)('pluginManagementPanel.pluginSettings')}</h2></header>
    {configuration && <PluginSearchSettings language={language} value={configuration.searchResultLimit ?? DEFAULT_SEARCH_RESULT_LIMIT}
      busy={Boolean(busy)} onSave={saveSearchLimit}/>}
    </>}
    {onOpenNetwork && presentation !== 'network' ? <button type="button" className="settings-link-row" onClick={onOpenNetwork}>
      <span><strong>{uiText(language)('pluginManagementPanel.networkProxy')}</strong><small>{uiText(language)('pluginManagementPanel.manageProxiesForTheMarketplacePluginsAnd')}</small></span><ChevronRight size={17} />
    </button> : <>
    <SettingsCard title={uiText(language)('pluginManagementPanel.marketplaceAndPluginDefault')}
      subtitle={uiText(language)('pluginManagementPanel.followsTheAppDefaultUnlessOverriddenHere')}>
    {configuration && <NetworkProxySettings language={language} value={configuration.proxy ?? defaultPluginProxy()} busy={Boolean(busy)}
      onSave={proxy => saveGlobalProxy(proxy ?? defaultPluginProxy())}
      applyToAll={{ formId: 'plugin-proxy-global', save: proxy => saveGlobalProxy(proxy, true) }} />}
    </SettingsCard>
    <section className="plugin-proxy-list"><div className="plugin-section-title"><h3>{uiText(language)('pluginManagementPanel.pluginsAndMcp')}</h3><span>{plugins.filter(item => item.installed).length + (mcpOverview?.servers.length ?? 0)}</span>
      <button type="submit" form="plugin-proxy-global" className="plugin-proxy-reset" disabled={Boolean(busy) || !configuration}>{uiText(language)('pluginManagementPanel.applyToAll')}</button></div>
      <label className="plugin-search"><Search size={17}/><input aria-label={uiText(language)('pluginManagementPanel.searchPluginsOrMcp')} placeholder={uiText(language)('pluginManagementPanel.searchPluginsOrMcp')} value={proxyQuery} onChange={event => setProxyQuery(event.target.value)}/></label>
      <McpCatalogNotice language={language} loading={mcpLoading} error={mcpError}/>
      {plugins.filter(item => item.installed).map(plugin => <div key={`plugin:${plugin.id}`} hidden={!proxyMatches(plugin.name, plugin.id)} data-proxy-scope={`plugin:${plugin.id}`}>
        <NetworkProxySettings compact individual language={language} label={plugin.name} caption={uiText(language)('pluginManagementPanel.plugin')} value={plugin.config.proxy} defaults={configuration?.proxy} resetRevision={proxyResetRevision} busy={Boolean(busy)} onSave={proxy => savePluginProxy(plugin.id, proxy)}/>
      </div>)}
      {(mcpOverview?.servers ?? []).map(server => <div key={`mcp:${server.id}`} hidden={!proxyMatches(server.name, server.id)} data-proxy-scope={`mcp:${server.id}`}>
        <NetworkProxySettings compact individual language={language} label={server.name} caption={`MCP · ${server.transport}`} value={server.proxy} defaults={configuration?.proxy} resetRevision={proxyResetRevision} busy={Boolean(busy)} onSave={proxy => saveStandaloneProxy(server.id, proxy)}/>
      </div>)}
      {!plugins.some(item => item.installed && proxyMatches(item.name, item.id)) && !mcpOverview?.servers.some(item => proxyMatches(item.name, item.id)) && <p className="plugin-proxy-help">{uiText(language)('pluginManagementPanel.noMatchingPluginsOrMcpServers')}</p>}
    </section>
    </>}
    {error && <p className="plugin-market-error" role="alert">{error}</p>}
  </div>;
  if (!host.remote && page.kind === 'accounts') return <AccountsPanel language={language} onBack={back}/>;
  if (page.kind === 'marketplace') {
    return <><PluginMarketplacePanel language={language}
      onOpenNetwork={() => setMarketProxyOpen(true)}
      onBack={back}
      onOpenBundled={pluginId => setPage({ kind: 'plugin', pluginId })}
      onNotify={onNotify}
      onInstalled={async (id, enabled) => {
        const latest = await host.fetchCardbushAppsConfiguration();
        if (!latest.plugins.some(plugin => plugin.id === id)) throw new Error(uiText(language)('pluginManagementPanel.filesInstalledPluginCatalogHasNotRefreshed'));
        const saved = await host.saveCardbushAppsConfiguration({ ...latest,
          plugins: latest.plugins.map(plugin => plugin.id === id ? { ...plugin, installed: true, enabled } : plugin) });
        setConfiguration(saved);
        setLocalSkills(await onReloadSkills());
        void loadConnections();
      }} />{marketProxyOpen && configuration && <dialog className="plugin-proxy-dialog" ref={node => { if (node && !node.open) node.showModal(); }} onCancel={dialogEventHandler(() => setMarketProxyOpen(false))}>
        <header><h3>{uiText(language)('pluginManagementPanel.marketplaceAndPluginDefault')}</h3><button type="button" className="plugin-back" onClick={() => setMarketProxyOpen(false)}>{uiText(language)('pluginManagementPanel.closeProxySettings')}</button></header>
        <NetworkProxySettings language={language} value={configuration.proxy ?? defaultPluginProxy()} busy={Boolean(busy)}
          onSave={proxy => saveGlobalProxy(proxy ?? defaultPluginProxy())} />
        {error && <p className="plugin-market-error" role="alert">{error}</p>}
      </dialog>}</>;
  }
  if (!host.remote && page.kind === 'workspace') {
    const plugin = plugins.find(item => item.id === page.pluginId);
    return <div className="plugin-workspace-page"><button className="plugin-back" type="button" onClick={back}><ArrowLeft size={17}/>{uiText(language)('accountsPanel.backToPlugin')}</button>
      {plugin?.installed && plugin.enabled ? <RuntimePluginWorkspace id={page.extensionId} language={language}/> : <p>{uiText(language)('pluginManagementPanel.enableThisPluginFirst')}</p>}
    </div>;
  }
  if (page.kind === 'plugin' && !selectedPlugin) return <div className="plugin-detail-page">
    <button className="plugin-back" type="button" onClick={back}><ArrowLeft size={17}/>{backLabel}</button>
    <p role="status">{uiText(language)('pluginManagementPanel.thisPluginIsNoLongerAvailableReturn')}</p>
  </div>;
  if (selectedPlugin) {
    return (
      <PluginDetail
        onOpenPrompt={onOpenPrompt}
        language={language}
        plugin={selectedPlugin}
        onOpenWorkspace={extensionId => setPage({ kind: 'workspace', pluginId: selectedPlugin.id, extensionId })}
        proxyDefaults={configuration?.proxy}
        onProxySave={proxy => savePluginProxy(selectedPlugin.id, proxy)}
        onUninstall={() => void uninstallPlugin(selectedPlugin)}
        onMcpSaved={() => void load()}
        onManageAccounts={() => setPage({ kind: 'accounts', pluginId: selectedPlugin.id })}
        busy={Boolean(busy)}
        error={error}
        onBack={back}
        backLabel={backLabel}
        onReplace={replacePlugin}
        onPersist={(plugin, message) => configuration && void persist({
          ...configuration,
          plugins: configuration.plugins.map((item) => item.id === plugin.id ? plugin : item),
        }, `plugin:${plugin.id}`, message)}
      />
    );
  }

  if (page.kind === 'skill') {
    const summary = localSkills.find((skill) => skill.name === page.skillName);
    return (
      <SkillDetailPage
        language={language}
        skill={skillDetail ?? summary ?? null}
        loading={busy === `skill:${page.skillName}`}
        error={error}
        enabled={!disabledSkillNames.has(page.skillName)}
        onBack={back}
        onToggle={(enabled) => onToggleSkill(page.skillName, enabled)}
      />
    );
  }

  if (page.kind === 'manage') {
    return (
      <PluginManagementList
        language={language}
        initialTab={page.tab}
        configuration={configuration}
        query={query}
        plugins={filteredPlugins}
        connections={filteredConnections}
        mcpLoading={mcpLoading}
        mcpError={mcpError}
        onOpenMcp={openMcp}
        onRefreshMcp={() => void loadConnections()}
        busy={Boolean(busy)}
        onQuery={setQuery}
        onBack={back}
        onOpen={(plugin) => setPage({ kind: 'plugin', pluginId: plugin.id })}
        onPersist={(next, message) => void persist(next, 'manage', message)}
        onUninstall={plugin => void uninstallPlugin(plugin)}
        error={error}
      />
    );
  }

  return (
    <div className="plugin-hub">
      <div className="plugin-hub-toolbar">
        <div className="plugin-hub-tabs" role="tablist">
          <button className={tab === 'plugins' ? 'active' : ''} type="button" onClick={() => setTab('plugins')}>
            {uiText(language)('appCenterModel.plugins')}
          </button>
          <button className={tab === 'skills' ? 'active' : ''} type="button" onClick={() => setTab('skills')}>
            {uiText(language)('composer.skills')}
          </button>
          <button type="button" onClick={() => setPage({ kind: 'marketplace' })}><Store size={16} />{uiText(language)('pluginManagementPanel.marketplace')}</button>
          {!host.remote && <button className={tab === 'accounts' ? 'active' : ''} type="button" onClick={() => { setAddOpen(false); setTab('accounts'); }}><UserRound size={16}/>{uiText(language)('accountsPanel.accounts')}</button>}
        </div>
        {tab !== 'accounts' && <div className="plugin-hub-actions">
          <button type="button" title={uiText(language)('pluginManagementPanel.pluginSettings')} onClick={() => setPage({ kind: 'network' })}>{uiText(language)('cardlingWindow.settings')}</button>
          <button className="plugin-mcp-manage-button" type="button" onClick={() => setPage({ kind: 'manage', tab: 'mcp' })}>
            <Server size={17} /><span>{uiText(language)('pluginManagementPanel.mcpServers')}</span>
          </button>
          <button type="button" title={uiText(language)('automationPanel.refresh')} onClick={() => void load()}>
            {busy === 'load' ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}
          </button>
          <button type="button" title={uiText(language)('browserStartBookmarks.manage')} onClick={() => setPage({ kind: 'manage' })}>
            <Settings size={17} />
          </button>
          <div className="plugin-add-wrap" ref={addMenuRef}>
            <button className="plugin-add-button" type="button" disabled={Boolean(busy)} onClick={() => setAddOpen((value) => !value)}>
              {uiText(language)('composer.add')} <ChevronDown size={15} />
            </button>
            {addOpen && (
              <div className="plugin-add-menu">
                <button type="button" onClick={() => { setAddOpen(false); setPage({ kind: 'marketplace' }); }}>
                  <Store size={15} /><span><strong>{uiText(language)('pluginManagementPanel.installFromMarketplace')}</strong><small>{uiText(language)('pluginManagementPanel.browseGithubAndLocalPluginMarketplaces')}</small></span>
                </button>
                {!host.remote && <button type="button" onClick={() => void installLocal('zip')}>
                  <FileArchive size={15} />
                  <span><strong>{uiText(language)('pluginManagementPanel.installFromZip')}</strong><small>{uiText(language)('pluginManagementPanel.importAPluginArchive')}</small></span>
                </button>}
                <button type="button" onClick={() => void installLocal('directory')}>
                  <FolderOpen size={15} />
                  <span><strong>{uiText(language)('pluginManagementPanel.installFromFolder')}</strong><small>{uiText(language)('pluginManagementPanel.chooseAnUnpackedPlugin')}</small></span>
                </button>
                <button type="button" onClick={() => { addMenuRef.current?.querySelector<HTMLButtonElement>('.plugin-add-button')?.focus(); setAddOpen(false); openMcp(); }}>
                  <Plus size={15} />
                  <span><strong>{uiText(language)('pluginManagementPanel.addMcpServer')}</strong><small>{uiText(language)('pluginManagementPanel.connectALocalOrRemoteToolService')}</small></span>
                </button>
                <button type="button" onClick={() => { setAddOpen(false); setTab('skills'); }}>
                  <PackagePlus size={15} />
                  <span><strong>{uiText(language)('pluginManagementPanel.browseSkills')}</strong><small>{uiText(language)('pluginManagementPanel.manageTheCardbushSkillCatalog')}</small></span>
                </button>
              </div>
            )}
          </div>
        </div>}
      </div>

      {installOpen && host.remote && <form className="settings-card settings-stack" onSubmit={event => {
        event.preventDefault(); if (busy || !host.installDirectory) return;
        setBusy('install'); setError('');
        void host.installDirectory(installPath.trim()).then(async () => { setInstallOpen(false); setInstallPath(''); await load(); })
          .catch(error => setError(errorMessage(error))).finally(() => setBusy(''));
      }}><label className="settings-field">{uiText(language)('pluginManagementPanel.pluginDirectoryOnTheAgentHost')}<input required value={installPath} onChange={event => setInstallPath(event.target.value)}/></label>
        <div className="settings-actions"><button type="button" disabled={Boolean(busy)} onClick={() => setInstallOpen(false)}>{uiText(language)('agentConnectionForm.cancel')}</button><button disabled={Boolean(busy) || !installPath.trim()}>{uiText(language)('pluginManagementPanel.installUpdate')}</button></div></form>}
      {tab !== 'accounts' && error && <p className="plugin-hub-error" role="alert">{error}</p>}
      {tab === 'accounts' ? <AccountsPanel language={language}/> : tab === 'plugins' ? (
        <PluginCatalog
          language={language}
          configuration={configuration}
          plugins={filteredPlugins}
          connections={filteredConnections}
          mcpLoading={mcpLoading}
          mcpError={mcpError}
          onOpenMcp={openMcp}
          query={query}
          busy={Boolean(busy)}
          onQuery={setQuery}
          onOpen={(plugin) => setPage({ kind: 'plugin', pluginId: plugin.id })}
          onInstall={(plugin) => configuration && void persist({
            ...configuration,
            plugins: configuration.plugins.map((item) => item.id === plugin.id
              ? { ...item, installed: true, enabled: true }
              : item),
          }, `install:${plugin.id}`, uiText(language)('pluginManagementPanel.pluginInstalled'))}
        />
      ) : (
        <SkillCatalog
          language={language}
          skills={filteredSkills}
          query={query}
          disabledSkillNames={disabledSkillNames}
          onQuery={setQuery}
          onOpen={(skill) => void openSkill(skill)}
          onToggle={onToggleSkill}
        />
      )}
    </div>
  );
  };

  return <div ref={rootRef} className="plugin-navigation">
    {entries.map((entry, index) => {
      const hidden = index !== entries.length - 1;
      return <div key={entry.id} className="plugin-navigation-page" data-plugin-page={entry.page.kind}
        hidden={hidden} inert={hidden} aria-hidden={hidden}>
        <PageNavigationScope.Provider value={`${navigationScope}:plugin:${entry.id}`}>{renderPage(entry.page, entries[index - 1]?.page)}</PageNavigationScope.Provider>
      </div>;
    })}
    {mcpDialog && renderMcp?.(mcpDialog.serverId, { dialogOnly: true, onClose: () => { setMcpDialog(null); void loadConnections(); } })}
  </div>;
}

function PluginCatalog({ language, configuration, plugins, connections, mcpLoading, mcpError, onOpenMcp, query, busy, onQuery, onOpen, onInstall }: {
  language: AppLanguage;
  configuration: CardbushAppsConfiguration | null;
  plugins: CardbushAppPlugin[];
  connections: PluginMcpConnection[];
  mcpLoading: boolean;
  mcpError: string;
  onOpenMcp: (serverId?: string) => void;
  query: string;
  busy: boolean;
  onQuery: (value: string) => void;
  onOpen: (plugin: CardbushAppPlugin) => void;
  onInstall: (plugin: CardbushAppPlugin) => void;
}) {
  const [scope, setScope] = usePageState<'public' | 'personal'>('plugin-catalog-scope', 'public');
  const scopedPlugins = plugins.filter((plugin) =>
    scope === 'public' ? plugin.source === 'bundled' : plugin.source === 'user');
  const installed = plugins.filter((plugin) => plugin.installed);
  const standalone = connections.filter(item => !item.plugin);
  return (
    <div className="plugin-catalog-page">
      <header className="plugin-catalog-heading"><h2>{uiText(language)('appCenterModel.plugins')}</h2><p>{uiText(language)('pluginManagementPanel.useCardbushWithTheToolsYouRely')}</p></header>
      <SearchField language={language} value={query} onChange={onQuery} kind="integrations" />
      <section className="plugin-installed-section">
        <div className="plugin-section-title"><h3>{uiText(language)('pluginManagementPanel.added')}</h3><span>{installed.length + standalone.length}</span></div>
        <McpCatalogNotice language={language} loading={mcpLoading} error={mcpError} />
        <div className="plugin-added-grid">
          {installed.map((plugin) => <button className="plugin-added-card" type="button" key={plugin.id} onClick={() => onOpen(plugin)}>
            <PluginLogo plugin={plugin} />
            <span className="plugin-added-copy"><strong>{plugin.name}</strong><small>{uiText(language)('pluginManagementPanel.plugin')} · {plugin.enabled && configuration?.serviceEnabled ? (uiText(language)('featureContentPanel.enabled')) : (uiText(language)('pluginManagementPanel.disabled'))}</small></span>
            <ChevronRight size={16} />
          </button>)}
          {standalone.map(item => <button className="plugin-added-card" type="button" key={`mcp:${item.id}`} onClick={() => onOpenMcp(item.id)}>
            <span className="plugin-logo"><Server size={23} /></span>
            <span className="plugin-added-copy"><strong>{item.name}</strong><small>{uiText(language)('pluginManagementPanel.standaloneMcp')}</small><McpConnectionBadge item={item} language={language} /></span>
            <ChevronRight size={16} />
          </button>)}
          {!installed.length && !standalone.length && !mcpLoading && !mcpError && <small>{query.trim() ? (uiText(language)('pluginManagementPanel.noMatchingItems')) : (uiText(language)('pluginManagementPanel.nothingAddedYet'))}</small>}
        </div>
        <div className="plugin-scope-tabs" role="tablist">
          <button className={scope === 'public' ? 'active' : ''} type="button" role="tab" aria-selected={scope === 'public'} onClick={() => setScope('public')}>{uiText(language)('pluginManagementPanel.public')}</button>
          <button className={scope === 'personal' ? 'active' : ''} type="button" role="tab" aria-selected={scope === 'personal'} onClick={() => setScope('personal')}>{uiText(language)('pluginManagementPanel.personal')}</button>
        </div>
      </section>
      <section className="plugin-featured-section">
        <div className="plugin-section-title"><h3>{scope === 'personal' ? (uiText(language)('pluginManagementPanel.personalPlugins')) : (uiText(language)('pluginManagementPanel.cardbushFeatured'))}</h3></div>
        <div className="plugin-featured-grid">
          {scopedPlugins.map((plugin) => (
            <article key={plugin.id}>
              <button className="plugin-featured-main" type="button" onClick={() => onOpen(plugin)}>
                <PluginLogo plugin={plugin} />
                <span><strong>{plugin.name}</strong><small>{pluginPresentation(plugin, language).description}</small></span>
              </button>
              {plugin.installed ? <span className="plugin-installed-check"><Check size={17} /></span> : (
                <button className="plugin-install-button" type="button" disabled={busy || !configuration} onClick={() => onInstall(plugin)}>{uiText(language)('browserInstallButton.install')}</button>
              )}
            </article>
          ))}
          {scopedPlugins.length === 0 && <p className="plugin-catalog-empty">{uiText(language)('pluginManagementPanel.noPluginsInThisScope')}</p>}
        </div>
      </section>
    </div>
  );
}

function SkillCatalog({ language, skills, query, disabledSkillNames, onQuery, onOpen, onToggle }: {
  language: AppLanguage;
  skills: SkillSummary[];
  query: string;
  disabledSkillNames: Set<string>;
  onQuery: (value: string) => void;
  onOpen: (skill: SkillSummary) => void;
  onToggle: (name: string, enabled: boolean) => void;
}) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const standaloneSkills = skills.filter((skill) => skill.source !== 'plugin');
  const pluginGroups = [...skills.reduce((groups, skill) => {
    if (skill.source !== 'plugin') return groups;
    const key = skill.sourceId || skill.sourceLabel || 'plugin';
    const group = groups.get(key) ?? {
      key,
      label: skill.sourceLabel || skill.sourceId || (uiText(language)('pluginManagementPanel.plugin')),
      skills: [] as SkillSummary[],
    };
    group.skills.push(skill);
    groups.set(key, group);
    return groups;
  }, new Map<string, { key: string; label: string; skills: SkillSummary[] }>()).values()]
    .sort((left, right) => left.label.localeCompare(right.label));
  const searching = Boolean(query.trim());
  const toggleGroup = (key: string) => setExpandedGroups((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });
  return (
    <div className="plugin-catalog-page">
      <header className="plugin-catalog-heading"><h2>{uiText(language)('composer.skills')}</h2><p>{uiText(language)('pluginManagementPanel.extendCardbushWithTaskSpecificSkills')}</p></header>
      <SearchField language={language} value={query} onChange={onQuery} kind="skills" />
      <section className="plugin-featured-section">
        <div className="plugin-section-title"><h3>{uiText(language)('pluginManagementPanel.installed_7bf4259')}</h3><span>{skills.length}</span></div>
        <div className="skill-catalog-grid">
          {standaloneSkills.map((skill) => (
            <SkillCatalogCard
              key={skill.name}
              language={language}
              skill={skill}
              enabled={!disabledSkillNames.has(skill.name)}
              onOpen={onOpen}
              onToggle={onToggle}
            />
          ))}
          {pluginGroups.map((group) => {
            const expanded = searching || expandedGroups.has(group.key);
            const countLabel = uiText(language)('plugins.skillCount', { count: group.skills.length });
            return (
              <section className={`skill-plugin-group${expanded ? ' expanded' : ''}`} key={group.key}>
                <button
                  className="skill-plugin-group-header"
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => toggleGroup(group.key)}
                >
                  <span className="skill-plugin-group-icon"><PluginIcon size={20} /></span>
                  <strong>{group.label} · {countLabel}</strong>
                  <ChevronRight size={17} />
                </button>
                {expanded && (
                  <div className="skill-plugin-group-grid">
                    {group.skills.map((skill) => (
                      <SkillCatalogCard
                        key={skill.name}
                        language={language}
                        skill={skill}
                        enabled={!disabledSkillNames.has(skill.name)}
                        onOpen={onOpen}
                        onToggle={onToggle}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
          {skills.length === 0 && <p className="plugin-catalog-empty">{uiText(language)('pluginManagementPanel.noMatchingSkills')}</p>}
        </div>
      </section>
    </div>
  );
}

function SkillCatalogCard({ language, skill, enabled, onOpen, onToggle }: {
  language: AppLanguage;
  skill: SkillSummary;
  enabled: boolean;
  onOpen: (skill: SkillSummary) => void;
  onToggle: (name: string, enabled: boolean) => void;
}) {
  const source = skillSourceText(language, skill);
  return (
    <article>
      <button className="plugin-featured-main" type="button" onClick={() => onOpen(skill)}>
        <SkillIcon skill={skill} />
        <span>
          <span className="skill-card-title"><strong>{skill.displayName || skill.name}</strong>{source && <em>{source}</em>}</span>
          <small>{localizedContent({ zh: skill.descriptionZh, en: skill.description }, language)}</small>
        </span>
      </button>
      <button className={`plugin-switch ${enabled ? 'on' : ''}`} type="button" aria-pressed={enabled} onClick={() => onToggle(skill.name, !enabled)}><span /></button>
    </article>
  );
}

function PluginManagementList({ language, initialTab, configuration, plugins, connections, mcpLoading, mcpError, onOpenMcp, onRefreshMcp, query, busy, onQuery, onBack, onOpen, onPersist, onUninstall, error }: {
  onUninstall: (plugin: CardbushAppPlugin) => void;
  error: string;
  language: AppLanguage;
  initialTab?: ManageTab;
  configuration: CardbushAppsConfiguration | null;
  plugins: CardbushAppPlugin[];
  connections: PluginMcpConnection[];
  mcpLoading: boolean;
  mcpError: string;
  onOpenMcp: (serverId?: string) => void;
  onRefreshMcp: () => void;
  query: string;
  busy: boolean;
  onQuery: (value: string) => void;
  onBack: () => void;
  onOpen: (plugin: CardbushAppPlugin) => void;
  onPersist: (configuration: CardbushAppsConfiguration, message: string) => void;
}) {
  const [activeTab, setActiveTab] = usePageState<ManageTab>('plugin-manage-tab', initialTab ?? 'plugins');
  const installed = plugins.filter((plugin) => plugin.installed);
  const appCount = installed.reduce((sum, plugin) => sum + plugin.components.filter((item) => item.kind === 'app').length, 0);
  const mcpCount = connections.length;
  const components = installed.flatMap((plugin) => plugin.components
    .filter((component) => component.kind === (activeTab === 'apps' ? 'app' : 'mcp'))
    .map((component) => ({ plugin, component })));
  const togglePlugin = (plugin: CardbushAppPlugin) => {
    if (!configuration) return;
    onPersist({
      ...configuration,
      plugins: configuration.plugins.map((item) => item.id === plugin.id
        ? { ...item, enabled: !item.enabled }
        : item),
    }, plugin.enabled
      ? (uiText(language)('pluginManagementPanel.pluginDisabled'))
      : (uiText(language)('pluginManagementPanel.pluginEnabled')));
  };
  return (
    <div className="plugin-manage-page">
      <button className="plugin-back" type="button" onClick={onBack}><ArrowLeft size={17} />{uiText(language)('appCenterModel.plugins')}</button>
      <div className="plugin-manage-tabs" role="tablist">
        <button className={activeTab === 'plugins' ? 'active' : ''} type="button" role="tab" aria-selected={activeTab === 'plugins'} onClick={() => setActiveTab('plugins')}>{uiText(language)('appCenterModel.plugins')} <em>{installed.length}</em></button>
        <button className={activeTab === 'apps' ? 'active' : ''} type="button" role="tab" aria-selected={activeTab === 'apps'} onClick={() => setActiveTab('apps')}>{uiText(language)('pluginManagementPanel.apps')} <em>{appCount}</em></button>
        <button className={activeTab === 'mcp' ? 'active' : ''} type="button" role="tab" aria-selected={activeTab === 'mcp'} onClick={() => setActiveTab('mcp')}>{uiText(language)('pluginManagementPanel.mcp')}<em>{mcpCount}</em></button>
      </div>
      <SearchField language={language} value={query} onChange={onQuery} kind={activeTab === 'plugins' ? 'plugins' : activeTab} />
      {error && <p className="plugin-market-error" role="alert">{error}</p>}
      {activeTab === 'mcp' && <>
        <McpCatalogNotice language={language} loading={mcpLoading} error={mcpError} />
        <button className="plugin-back" type="button" onClick={() => onOpenMcp()}><Plus size={16} />{uiText(language)('pluginManagementPanel.addMcpServer')}</button>
        <button className="plugin-back" type="button" disabled={mcpLoading} onClick={onRefreshMcp}><RefreshCw size={16} />{uiText(language)('pluginManagementPanel.refreshStatus')}</button>
      </>}
      <div className="plugin-manage-list">
        {activeTab === 'plugins' && installed.map((plugin) => (
          <article key={plugin.id}>
            <button className="plugin-featured-main" type="button" onClick={() => onOpen(plugin)}><PluginLogo plugin={plugin} /><span><strong>{plugin.name}</strong><small>{pluginPresentation(plugin, language).description}</small></span></button>
            <button className={`plugin-switch ${plugin.enabled ? 'on' : ''}`} type="button" disabled={busy || !configuration || plugin.removalPending} onClick={() => togglePlugin(plugin)}><span /></button>
            {plugin.source === 'user' && <button className="plugin-uninstall-button" type="button" disabled={busy || !configuration} aria-label={uiText(language)('pluginManagementPanel.uninstall', { value1: plugin.name })} title={uiText(language)('pluginManagementPanel.uninstallPluginAndDeleteItsFilesAnd')} onClick={() => onUninstall(plugin)}><Trash2 size={16}/></button>}
          </article>
        ))}
        {activeTab === 'apps' && components.map(({ plugin, component }) => (
          <article key={`${plugin.id}:${component.kind}:${component.id}`}>
            <button className="plugin-featured-main" type="button" onClick={() => onOpen(plugin)}>
              <PluginLogo plugin={plugin} />
              <span><strong>{component.name}</strong><small>{component.description} · {plugin.name}</small></span>
            </button>
            <button className={`plugin-switch ${plugin.enabled ? 'on' : ''}`} type="button" disabled={busy || !configuration} onClick={() => togglePlugin(plugin)}><span /></button>
          </article>
        ))}
        {activeTab === 'mcp' && connections.map(item => <article key={`${item.plugin?.id ?? 'standalone'}:${item.id}`}>
          <button className="plugin-featured-main" type="button" onClick={() => item.plugin ? onOpen(item.plugin) : onOpenMcp(item.id)}>
            {item.plugin ? <PluginLogo plugin={item.plugin} /> : <span className="plugin-logo"><Server size={23} /></span>}
            <span><strong>{item.name}</strong><small>{item.plugin ? (uiText(language)('pluginManagementPanel.managedBy', { value1: item.plugin.name })) : (uiText(language)('pluginManagementPanel.standaloneMcp'))}</small><McpConnectionBadge item={item} language={language} /></span>
            <ChevronRight size={16} className="plugin-row-chevron" />
          </button>
        </article>)}
        {((activeTab === 'plugins' && installed.length === 0) || (activeTab === 'apps' && components.length === 0) || (activeTab === 'mcp' && connections.length === 0 && !mcpLoading && !mcpError)) && (
          <p className="plugin-manage-empty">{uiText(language)('pluginManagementPanel.noMatchingInstalledItems')}</p>
        )}
      </div>
    </div>
  );
}

function McpCatalogNotice({ language, loading, error }: { language: AppLanguage; loading: boolean; error: string }) {
  if (error) return <p className="plugin-hub-error" role="alert">{uiText(language)('pluginManagementPanel.mcpListUnavailableRefreshToRetry')}{error}</p>;
  return loading ? <p className="plugin-mcp-loading" role="status">{uiText(language)('pluginManagementPanel.readingMcpServerStatus')}</p> : null;
}

function McpConnectionBadge({ item, language }: { item: PluginMcpConnection; language: AppLanguage }) {
  const labels = {
    waiting_for_resources: 'pluginMcpSettings.waitingForResources' as const,
    auth_required: 'pluginMcpSettings.signInRequired' as const, configuration_required: 'pluginMcpSettings.configurationRequired' as const, connected: 'browserConnectionSettings.connected' as const, pending: 'pluginManagementPanel.pending' as const, restarting: 'pluginManagementPanel.reconnecting' as const,
    unavailable: 'pluginManagementPanel.unavailable' as const, disabled: 'pluginManagementPanel.disabled' as const, unknown: 'pluginManagementPanel.connection_unconfirmed' as const,
  };
  return <span className={`plugin-connection-status ${item.state}`}>
    <i aria-hidden="true" />{uiText(language)(labels[item.state])}
    {item.state === 'connected' && item.toolCount !== undefined && ` · ${item.toolCount} ${uiText(language)('pluginManagementPanel.tools')}`}
  </span>;
}

function PluginDetail({ onOpenWorkspace, language, plugin, busy, error, onBack, backLabel, onReplace, onPersist, onMcpSaved, onManageAccounts, proxyDefaults, onProxySave, onUninstall, onOpenPrompt }: {
  onOpenWorkspace: (id: string) => void;
  onOpenPrompt?: (prompt: string) => void;
  onUninstall: () => void;
  proxyDefaults?: ProxySettings;
  onProxySave: (proxy: ProxySettings | undefined) => Promise<boolean>;
  onMcpSaved: () => void;
  onManageAccounts: () => void;
  language: AppLanguage;
  plugin: CardbushAppPlugin;
  busy: boolean;
  error: string;
  onBack: () => void;
  backLabel: string;
  onReplace: (plugin: CardbushAppPlugin) => void;
  onPersist: (plugin: CardbushAppPlugin, message: string) => void;
}) {
  const host = useSettingsHost();
  const presentation = pluginPresentation(plugin, language);
  return (
    <div className="plugin-detail-page">
      <button className="plugin-back" type="button" onClick={onBack}><ArrowLeft size={17} />{backLabel}</button>
      <header className="plugin-detail-hero">
        <PluginLogo plugin={plugin} large />
        <div><h2>{plugin.name}</h2><p>{presentation.description}</p></div>
        {plugin.installed ? <div className="plugin-detail-actions"><button className={`plugin-switch ${plugin.enabled ? 'on' : ''}`} type="button" disabled={busy || plugin.removalPending} onClick={() => onPersist({ ...plugin, enabled: !plugin.enabled }, plugin.enabled ? (uiText(language)('pluginManagementPanel.pluginDisabled')) : (uiText(language)('pluginManagementPanel.pluginEnabled')))}><span /></button>
          {plugin.source === 'user' && <button className="plugin-uninstall-button" type="button" disabled={busy} onClick={onUninstall}><Trash2 size={15}/>{uiText(language)('pluginManagementPanel.uninstall_776f552')}</button>}</div>
          : <button className="plugin-detail-primary" type="button" disabled={busy} onClick={() => onPersist({ ...plugin, installed: true, enabled: true }, uiText(language)('pluginManagementPanel.pluginInstalled'))}>{uiText(language)('pluginManagementPanel.install')}</button>}
      </header>
      <p className="plugin-uninstall-hint">{plugin.installed
        ? (plugin.source === 'user'
          ? (uiText(language)('pluginManagementPanel.uninstallDeletesThisPluginSInstalledFiles'))
          : (uiText(language)('pluginManagementPanel.bundledComponentsCanBeDisabled')))
        : (uiText(language)('pluginManagementPanel.thisPluginIsNotInstalledInstallIt'))}</p>
      {presentation.defaultPrompts.length > 0 && <div className="plugin-prompt-showcase" style={{ '--plugin-brand': plugin.brandColor } as CSSProperties}>{presentation.defaultPrompts.map((prompt) => <button type="button" key={prompt} disabled={!plugin.installed || busy || !onOpenPrompt}
        title={uiText(language)('pluginManagementPanel.useThisPromptInANewConversation')}
        onClick={() => onOpenPrompt?.(pluginPrompt(plugin, prompt))}><PluginLogo plugin={plugin} compact /><span><strong>{plugin.name}</strong>{prompt}</span><ChevronRight size={18} /></button>)}</div>}
      <p className="plugin-long-description">{presentation.longDescription}</p>
      {error && <p className="plugin-market-error" role="alert">{error}</p>}
      {!host.remote && plugin.installed && plugin.enabled && plugin.components.filter(component => component.kind === 'runtime' && component.runtime?.settings).map(component => <section className="plugin-detail-section" key={component.id}><button type="button" className="plugin-back" onClick={() => onOpenWorkspace(component.id)}><Settings size={16}/>{uiText(language)('pluginManagementPanel.openPluginSettings')}</button></section>)}
      {plugin.removalPending && <p className="plugin-market-error">{uiText(language)('pluginManagementPanel.uninstallIsIncompleteClickUninstallToRetry')}</p>}
      {plugin.installed && !plugin.removalPending && <PluginMcpSettings plugin={plugin} language={language} onSaved={onMcpSaved} onManageAccounts={onManageAccounts} onOpenPrompt={onOpenPrompt} />}
      {plugin.installed && <details className="plugin-detail-section plugin-proxy-section"><summary>{uiText(language)('pluginManagementPanel.networkProxy')} · {proxyLabel(plugin.config.proxy?.mode ?? 'inherit', language)}</summary>
        <NetworkProxySettings key={plugin.id} language={language} value={plugin.config.proxy} defaults={proxyDefaults} individual busy={busy} onSave={onProxySave} />
      </details>}
      {plugin.installed && <PluginHookTrust plugin={plugin} language={language} busy={busy} onPersist={onPersist} />}
      <section className="plugin-detail-section"><h3>{uiText(language)('pluginManagementPanel.components', { value1: plugin.components.length })}</h3>{plugin.components.map((component) => <div className="plugin-component-row" key={`${component.kind}-${component.id}`}><span className={`plugin-component-kind kind-${component.kind}`}>{component.kind === 'command' ? '/' : component.kind === 'skill' ? 'S' : component.kind === 'mcp' ? 'M' : component.kind === 'hook' ? 'H' : 'A'}</span><div><strong>{component.name}<span className="plugin-market-kind">{component.kind}</span></strong><small>{component.description}</small></div>{plugin.installed && component.kind !== 'mcp' && component.kind !== 'app' && <Check size={17} />}</div>)}</section>
      {!host.remote && plugin.id === 'computer-use' && plugin.installed && <ComputerUseSettings language={language} plugin={plugin} busy={busy} onReplace={onReplace} onPersist={onPersist} />}
      {!host.remote && plugin.id === 'chrome' && plugin.installed && (
        <BrowserConnectionSettings
          language={language}
          plugin={plugin}
          busy={busy}
          onReplace={onReplace}
          onPersist={onPersist}
        />
      )}
      <section className="plugin-detail-section plugin-info"><h3>{uiText(language)('pluginManagementPanel.information')}</h3><Info label={uiText(language)('pluginManagementPanel.capabilities')} value={plugin.capabilities.join(', ')} /><Info label={uiText(language)('pluginManagementPanel.developer')} value={plugin.developerName} /><Info label={uiText(language)('pluginManagementPanel.category')} value={plugin.category} /><Info label={uiText(language)('pluginManagementPanel.version')} value={plugin.version} /><Info label={uiText(language)('pluginManagementPanel.manifest')} value={plugin.manifestPath} /></section>
    </div>
  );
}

export function PluginHookTrust({ plugin, language, busy, onPersist }: {
  plugin: CardbushAppPlugin; language: AppLanguage; busy: boolean;
  onPersist: (plugin: CardbushAppPlugin, message: string) => void;
}) {
  const hooks = plugin.components.filter(component => component.hook);
  if (!hooks.length) return null;

  const trusted = new Set(Array.isArray(plugin.config.trustedHookHashes) ? plugin.config.trustedHookHashes.filter((value): value is string => typeof value === 'string') : []);
  return <section className="plugin-detail-section plugin-hook-trust"><h3>{uiText(language)('pluginManagementPanel.reviewAutomaticExecution')}</h3>
    <p>{uiText(language)('pluginManagementPanel.reviewHooksAndAgentLocalMcpDeclarations')}</p>
    {hooks.map(component => {
      const hook = component.hook!, enabled = trusted.has(hook.definitionHash);
      return <details key={component.id}><summary>{component.name} · {hook.executable ? enabled ? (uiText(language)('pluginManagementPanel.trusted')) : (uiText(language)('pluginManagementPanel.needsReview')) : (uiText(language)('pluginManagementPanel.skipped'))}</summary>
        <pre>{JSON.stringify(hook.definition, null, 2)}</pre>
        {hook.executable ? <button className="plugin-install-button" type="button" disabled={busy} onClick={() => {
          const hashes = new Set(trusted); if (enabled) hashes.delete(hook.definitionHash); else hashes.add(hook.definitionHash);
          onPersist({ ...plugin, config: { ...plugin.config, trustedHookHashes: [...hashes] } }, (enabled ? uiText(language)('pluginManagementPanel.definitionTrustRevoked') : uiText(language)('pluginManagementPanel.currentDefinitionTrusted')));
        }}>{enabled ? (uiText(language)('pluginManagementPanel.revokeTrustAndDisable')) : (uiText(language)('pluginManagementPanel.trustAndAllowExecution'))}</button>
          : <p>{uiText(language)('pluginManagementPanel.likeOpenaiPromptAndAgentHookHandlers')}</p>}
      </details>;
    })}
  </section>;
}

function SkillDetailPage({ language, skill, loading, error, enabled, onBack, onToggle }: { language: AppLanguage; skill: SkillSummary | SkillDetail | null; loading: boolean; error: string; enabled: boolean; onBack: () => void; onToggle: (enabled: boolean) => void }) {
  return <div className="plugin-detail-page">
    <button className="plugin-back" type="button" onClick={onBack}><ArrowLeft size={17} />{uiText(language)('pluginManagementPanel.backToSkills')}</button>
    {error && <p className="plugin-hub-error" role="alert">{error}</p>}
    {loading ? <div className="plugin-detail-loading"><LoaderCircle className="spin" />{uiText(language)('pluginManagementPanel.loadingSkill')}</div> : skill ? <>
      <header className="plugin-detail-hero"><SkillIcon skill={skill} /><div><h2>{skill.displayName || skill.name}</h2><p>{localizedContent({ zh: skill.descriptionZh, en: skill.description }, language)}</p></div><button className={`plugin-switch ${enabled ? 'on' : ''}`} type="button" onClick={() => onToggle(!enabled)}><span /></button></header>
      {skill.invocationMode && <p>{(({ manual: uiText(language)('pluginManagementPanel.manualInvocationOnly'), model: uiText(language)('pluginManagementPanel.modelInvocationOnly'), both: uiText(language)('pluginManagementPanel.manualAndModelInvocation'), disabled: uiText(language)('pluginManagementPanel.invocationDisabled') }))[skill.invocationMode]}{['manual', 'both'].includes(skill.invocationMode) && <> · <code>{skill.name.includes(':') ? `/${skill.name}` : `$${skill.name}`}</code></>}</p>}
      {skill.defaultPrompt && <section className="plugin-detail-section"><h3>{uiText(language)('pluginManagementPanel.suggestedPrompt')}</h3><p>{skill.defaultPrompt}</p></section>}
      <section className="plugin-detail-section plugin-info"><h3>{uiText(language)('pluginManagementPanel.information')}</h3>{'version' in skill && <Info label={uiText(language)('pluginManagementPanel.version')} value={skill.version || '—'} />}<Info label={uiText(language)('pluginManagementPanel.source')} value={skillSourceText(language, skill) || '—'} /><Info label={uiText(language)('pluginManagementPanel.location')} value={skill.path} /></section>
      {'content' in skill && <section className="plugin-detail-section"><h3>{uiText(language)('featureContentPanel.skill_md')}</h3><pre className="plugin-skill-source">{skill.content}</pre></section>}
    </> : null}
  </div>;
}

function skillSourceText(language: AppLanguage, skill: SkillSummary): string {
  if (skill.source === 'plugin') {
    const plugin = skill.sourceLabel || skill.sourceId || (uiText(language)('pluginManagementPanel.plugin'));
    return uiText(language)('pluginManagementPanel.from', { plugin });
  }
  if (skill.source === 'bundled') return uiText(language)('pluginManagementPanel.builtIn');
  if (skill.source === 'user') return uiText(language)('pluginManagementPanel.user');
  if (skill.source === 'external') return uiText(language)('pluginManagementPanel.external');
  return '';
}

function PluginLogo({ plugin, large = false, compact = false }: { plugin: CardbushAppPlugin; large?: boolean; compact?: boolean }) {
  const source = plugin.logoPath ? fileUrl(plugin.logoPath) : '';
  return <span className={`plugin-logo${large ? ' large' : ''}${compact ? ' compact' : ''}`} style={{ '--plugin-brand': plugin.brandColor } as CSSProperties}>{source ? <img src={source} alt="" /> : <PluginIcon className="plugin-logo-fallback-icon" />}</span>;
}

function SearchField({ language, value, onChange, kind }: { language: AppLanguage; value: string; onChange: (value: string) => void; kind: 'plugins' | 'skills' | 'apps' | 'mcp' | 'integrations' }) {

  const label = uiText(language)(`plugins.search.${kind}`);
  return <label className="plugin-search"><Search size={18} /><input aria-label={label} value={value} onChange={(event) => onChange(event.currentTarget.value)} placeholder={label} /></label>;
}

function Info({ label, value }: { label: string; value: string }) {
  return <div className="plugin-info-row"><span>{label}</span><strong>{value || '—'}</strong></div>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
