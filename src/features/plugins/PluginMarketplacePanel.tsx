import type { MessageKey } from '../../i18n';
import { uiText } from '../../i18n';
import { PluginMarketCard } from './PluginMarketCard';
import { ArrowLeft, Check, Download, FolderOpen, LoaderCircle, Plus, RefreshCw, Search, Settings, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PluginMarketCatalog, PluginMarketPreview, PluginMarketSource, PluginMarketInstallProgress } from '../../../electron/pluginMarketplaceTypes';
import type { AppLanguage } from '../../types';
import { marketError, marketRetryAt, marketRateLimited, networkError } from './pluginMarketErrors';
import { useSettingsHost } from '../settings/SettingsHostContext';
import { usePageState } from '../navigation/PageNavigation';
import { SettingsFormDialog } from '../settings/SettingsFormDialog';
import { SettingsDropdown } from '../settings/SettingsDropdown';
import { SettingsInput } from '../settings/SettingsControls';

export function PluginMarketplacePanel({ language, onBack, onOpenBundled, onInstalled, onNotify, onOpenNetwork }: {
  language: AppLanguage;
  onBack: () => void;
  onOpenBundled: (id: string) => void;
  onInstalled: (id: string, enabled: boolean) => Promise<void>;
  onNotify: (message: string) => void;
  onOpenNetwork?: () => void;
}) {
  const uiLanguage = language;
  const host = useSettingsHost();
  const bridge = host.marketplace;
  const [sources, setSources] = useState<PluginMarketSource[]>([]);
  const [sourceId, setSourceId] = usePageState('market-source', 'builtin');
  const [previewTarget, setPreviewTarget, returnToPreview] = usePageState<{ sourceId: string; name: string } | null>('market-preview', null);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const [catalog, setCatalog] = useState<PluginMarketCatalog | null>(null);
  const [preview, setPreview] = useState<PluginMarketPreview | null>(null);
  const [query, setQuery] = useState('');
  const [sourceInput, setSourceInput] = useState('');
  const [directoryInput, setDirectoryInput] = useState('');
  const [busy, setBusy] = useState('catalog');
  const [error, setError] = useState('');
  const [retryPreview, setRetryPreview] = useState<{ sourceId: string; name: string } | null>(null);
  const [clock, setClock] = useState(Date.now);
  const [installedId, setInstalledId] = useState('');
  const [activated, setActivated] = useState(false);
  const [installProgress, setInstallProgress] = useState<PluginMarketInstallProgress | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [sourceKind, setSourceKind] = useState<'git' | 'local'>('git');
  const [sourceError, setSourceError] = useState('');
  const sourcePending = useRef(false);
  const generation = useRef(0);
  const selectedSource = sources.find(source => source.id === sourceId);
  const retryAt = marketRetryAt(sourceError || error || catalog?.error || '');
  const now = Math.max(clock, Date.now());
  const needsConfiguration = Boolean(preview?.warnings?.some(warning => warning.code === 'variables'));

  useEffect(() => {
    if (busy !== 'install' || !preview || !bridge?.pluginMarketInstallProgress) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const value = await bridge.pluginMarketInstallProgress!(preview.token); if (active && value) setInstallProgress(value); }
      catch { /* The install request reports its own failure; progress is advisory. */ }
      if (active) timer = setTimeout(() => void poll(), 400);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [busy, preview?.token, bridge]);

  useEffect(() => {
    if (retryAt === undefined || retryAt <= Date.now()) return;
    const timer = window.setInterval(() => {
      const time = Date.now(); setClock(time);
      if (time >= retryAt) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  useEffect(() => {
    let active = true;
    if (!bridge?.pluginMarketSources) {
      setError(host.remote ? (uiText(language)('pluginMarketplacePanel.updateThisAgentServiceToEnablePlugin')) : (uiText(language)('pluginMarketplacePanel.restartCardbushToEnablePluginMarketplaces'))); setBusy(''); return;
    }
    void bridge.pluginMarketSources().then(value => { if (active) setSources(value); })
      .catch(caught => { if (active) setError(message(caught)); });
    return () => { active = false; generation.current++; };
  }, [bridge, host.remote, uiLanguage]);

  const loadCatalog = useCallback(async (refresh = false) => {
    if (!bridge?.pluginMarketCatalog) return;
    const revision = ++generation.current;
    setBusy('catalog'); setError(''); setRetryPreview(null); setPreview(null); if (!refresh) setCatalog(null);
    try {
      const value = await bridge.pluginMarketCatalog(sourceId, refresh);
      if (revision === generation.current) setCatalog(value);
    } catch (caught) { if (revision === generation.current) setError(message(caught)); }
    finally { if (revision === generation.current) setBusy(''); }
  }, [bridge, sourceId]);
  useEffect(() => { if (!previewTarget) void loadCatalog(); return () => { generation.current++; }; }, [loadCatalog, previewTarget]);

  const addSource = async (local = false) => {
    if (!bridge || busy || sourcePending.current) return;
    sourcePending.current = true;
    setBusy('source'); setSourceError(''); setError(''); setRetryPreview(null);
    try {
      const source = local ? await bridge.addLocalPluginMarket(host.remote ? directoryInput.trim() : undefined) : await bridge.addPluginMarket(sourceInput.trim());
      if (!source) return;
      setSources(await bridge.pluginMarketSources()); setSourceInput(''); setDirectoryInput(''); setAddOpen(false);
      if (source.id === sourceId) await loadCatalog(true); else setSourceId(source.id);
    } catch (caught) { setSourceError(message(caught)); }
    finally { sourcePending.current = false; setBusy(value => value === 'source' ? '' : value); }
  };
  const removeSource = async () => {
    if (!bridge || !selectedSource || selectedSource.builtin || busy) return;
    setBusy('source'); setError(''); setRetryPreview(null);
    try {
      await bridge.removePluginMarket(sourceId);
      setSources(await bridge.pluginMarketSources()); setSourceId('builtin');
      onNotify(uiText(language)('pluginMarketplacePanel.sourceRemovedInstalledPluginsAreRetained'));
    } catch (caught) { setError(message(caught)); }
    finally { setBusy(value => value === 'source' ? '' : value); }
  };
  const openPlugin = (name: string) => {
    if (catalog?.source.builtin) { onOpenBundled(name); return; }
    if (!bridge || busy) return;
    setPreviewTarget({ sourceId, name }); setPreviewAttempt(value => value + 1);
  };
  useEffect(() => {
    if (!bridge || !previewTarget) { setPreview(null); return; }
    const { sourceId, name } = previewTarget;
    const revision = ++generation.current;
    setBusy(`preview:${name}`); setError(''); setRetryPreview(null); setPreview(null); setInstalledId(''); setActivated(false);
    void bridge.previewMarketPlugin(sourceId, name).then(detail => {
      if (revision === generation.current) setPreview(detail);
    }).catch(caught => {
      if (revision === generation.current) {
        setError(message(caught));
        if (marketRateLimited(message(caught)) || networkError(message(caught))) setRetryPreview({ sourceId, name });
      }
    }).finally(() => { if (revision === generation.current) setBusy(''); });
    return () => { generation.current++; };
  }, [bridge, previewTarget, previewAttempt]);
  const navigateBack = () => { if (previewTarget) returnToPreview(null); else onBack(); };
  const install = async () => {
    if (!bridge || !preview || busy || preview.issues.length) return;
    setBusy('install'); setError(''); setInstallProgress(null); setCancelling(false);
    let id = installedId;
    let configurationNeeded = needsConfiguration;
    try {
      if (!id) {
        const result = await bridge.installMarketPlugin(preview.token);
        id = result.id; setInstalledId(id);
        if (result.warnings) {
          configurationNeeded = result.warnings.some(warning => warning.code === 'variables');
          setPreview(value => value ? { ...value, warnings: result.warnings, validation: 'complete' } : value);
        }
      }
      await onInstalled(id, !configurationNeeded); setActivated(true);
      if (preview.authentication === 'ON_INSTALL') onOpenBundled(id);
      onNotify(configurationNeeded ? (uiText(language)('pluginMarketplacePanel.pluginInstalledConfigureTheRequiredEnvironmentVariables'))
        : (uiText(language)('pluginMarketplacePanel.pluginInstalledCheckItsStatusInAdded')));
    } catch (caught) {
      if (message(caught).includes('[market-cancelled]')) onNotify(uiText(language)('pluginMarketplacePanel.installationCancelled'));
      else setError(`${id ? (configurationNeeded ? (uiText(language)('pluginMarketplacePanel.pluginFilesInstalledSavingStateIncomplete')) : (uiText(language)('pluginMarketplacePanel.pluginFilesInstalledActivationIncomplete'))) : ''}${message(caught)}`);
    } finally { setBusy(''); setCancelling(false); }
  };
  const cancelInstall = async () => {
    if (!preview || !bridge?.cancelMarketPluginInstall || cancelling) return;
    setCancelling(true);
    try { if (!await bridge.cancelMarketPluginInstall(preview.token)) setCancelling(false); }
    catch (caught) { setCancelling(false); setError(message(caught)); }
  };
  const entries = catalog?.entries.filter(entry => [entry.name, entry.description, entry.category].join(' ').toLowerCase().includes(query.trim().toLowerCase())) ?? [];
  const closeSource = () => { if (!sourcePending.current) { setAddOpen(false); setSourceError(''); } };
  const renderError = (failure: string, source = false) => <div className="plugin-market-error" role="alert"><p>{marketError(failure, uiLanguage, now)}</p>
    {!source && retryPreview?.sourceId === sourceId && <button className="plugin-back" type="button" disabled={Boolean(busy)} onClick={() => void openPlugin(retryPreview.name)}>
      <RefreshCw size={15}/>{uiText(language)('pluginMarketplacePanel.retryDownload')}</button>}
    {(networkError(failure) || marketRateLimited(failure)) && onOpenNetwork && <button className="plugin-back" type="button" onClick={onOpenNetwork}><Settings size={15}/>{uiText(language)('pluginMarketplacePanel.proxySettings')}</button>}
    <details><summary>{uiText(language)('messageBubble.errorDetails')}</summary><code>{failure}</code></details></div>;
  return <div className="plugin-market-page plugin-catalog-page">
    <button className="plugin-back" type="button" disabled={busy === 'install'} onClick={() => {
      generation.current++;
      setError(''); navigateBack();
    }}><ArrowLeft size={17} />{previewTarget ? (uiText(language)('pluginManagementPanel.backToMarketplace')) : (uiText(language)('pluginManagementPanel.backToPlugins'))}</button>
    <header className="plugin-market-heading"><div><h2>{preview ? preview.name : (uiText(language)('pluginMarketplacePanel.pluginMarketplaces'))}</h2>
      <p>{preview ? preview.description : (uiText(language)('pluginMarketplacePanel.installSkillsToolsAndAutomationsFromCustom'))}</p></div>
      {!preview && <button className="plugin-install-button" type="button" disabled={Boolean(busy) || !bridge} onClick={() => { setSourceError(''); setAddOpen(true); }} aria-haspopup="dialog"><Plus size={16} />{uiText(language)('pluginMarketplacePanel.addSource')}</button>}</header>
    {host.remote && <p className="plugin-market-hint">{uiText(language)('pluginMarketplacePanel.pluginsInstallOnTheSelectedAgentUsing')}</p>}
    {error && renderError(error)}
    {preview ? <div className="plugin-market-detail">
      <dl><dt>{uiText(language)('pluginManagementPanel.source')}</dt><dd>{preview.source}</dd>
        <dt>{uiText(language)('pluginMarketplacePanel.packageFormat')}</dt><dd>{preview.format === 'agent-plugins' ? 'Agent Plugins' : preview.format === 'claude' ? (uiText(language)('pluginMarketplacePanel.claudeCompatibilityMode')) : (uiText(language)('pluginMarketplacePanel.codexCompatibilityFormat'))}</dd>
        <dt>{uiText(language)('pluginManagementPanel.version')}</dt><dd>{preview.version}</dd>
        <dt>{uiText(language)('pluginManagementPanel.developer')}</dt><dd>{preview.developerName}</dd>
        <dt>{uiText(language)('pluginMarketplacePanel.contentRevision')}</dt><dd>{preview.revision === 'local' ? (uiText(language)('pluginMarketplacePanel.localSnapshot')) : preview.revision.slice(0, 12)}</dd></dl>
      <h3>{preview.validation === 'metadata' ? (uiText(language)('pluginMarketplacePanel.declaredCapabilities')) : (uiText(language)('pluginMarketplacePanel.includedCapabilities'))}</h3>
      {preview.components.map((component, index) => <div className="plugin-component-row" key={`${component.kind}:${index}`}><span className={`plugin-component-kind kind-${component.kind}`}>{component.kind === 'command' ? '/' : component.kind === 'skill' ? 'S' : component.kind === 'agent' ? 'A' : component.kind === 'hook' ? 'H' : 'M'}</span><div><strong>{component.name}<span className="plugin-market-kind">{component.kind}</span></strong><small>{component.description}</small></div></div>)}
      {!preview.components.length && <p>{preview.validation === 'metadata' ? (uiText(language)('pluginMarketplacePanel.capabilitiesInThePackageWillBeChecked')) : (uiText(language)('pluginMarketplacePanel.noLoadableCapabilitiesFound'))}</p>}
      {preview.components.some(component => component.kind === 'command') && <p className="plugin-market-hint">{uiText(language)('pluginMarketplacePanel.commandsLoadNativelyInvokePluginCommandFrom')}</p>}
      {preview.components.some(component => component.kind === 'hook') && <p className="plugin-market-hint">{uiText(language)('pluginMarketplacePanel.hooksRunCommandsAndMcpToolsClaude')}</p>}
      {preview.notes?.length ? <div className="plugin-market-notes"><strong>{uiText(language)('pluginMarketplacePanel.adaptationNotes')}</strong><ul>{preview.notes.map((note, index) => <li key={index}>{adaptationNote(note, uiLanguage)}</li>)}</ul></div> : null}
      {preview.requirements.length > 0 && <p className="plugin-market-hint">{host.remote ? (uiText(language)('pluginMarketplacePanel.requiresExecutablesOnTheAgentHost')) : (uiText(language)('pluginMarketplacePanel.requiresLocalExecutables'))}{preview.requirements.join(', ')}</p>}
      {preview.issues.length > 0 ? <div className="plugin-market-issues" role="status"><strong>{uiText(language)('pluginMarketplacePanel.notFullySupportedYet')}</strong><ul>{preview.issues.map((issue, index) => <li key={index}>{issueText(issue.code, uiLanguage)}{issue.detail && `：${issue.detail}`}</li>)}</ul></div>
        : <p className="plugin-market-hint">{preview.validation === 'metadata'
          ? (uiText(language)('pluginMarketplacePanel.onlyPluginMetadataHasBeenLoadedInstall'))
          : (uiText(language)('pluginMarketplacePanel.structureChecksPassedInstallationEnablesThePlugin'))}</p>}
      {!!preview.warnings?.length && <div className="plugin-market-notes" role="status"><strong>{uiText(language)('pluginMarketplacePanel.readyToInstallConfigurationNeededBeforeUse')}</strong>
        <ul>{preview.warnings.map((warning, index) => <li key={index}>{issueText(warning.code, uiLanguage)}{warning.detail && `：${warning.detail}`}</li>)}</ul>
        <p>{uiText(language)('pluginMarketplacePanel.installTheFilesNowThenEnableThe')}</p></div>}
      <button className="plugin-detail-primary" type="button" disabled={Boolean(busy) || preview.issues.length > 0 || activated} onClick={() => void install()}>
        {busy === 'install' ? <LoaderCircle className="spin" size={16} /> : activated ? <Check size={16} /> : <Download size={16} />}
        {busy === 'install' ? (uiText(language)('pluginMarketplacePanel.installing')) : activated ? (uiText(language)('pluginManagementPanel.installed_7bf4259')) : needsConfiguration ? (installedId ? (uiText(language)('pluginMarketplacePanel.retrySavingState')) : preview.updating ? (uiText(language)('pluginMarketplacePanel.updateConfigureLater')) : (uiText(language)('pluginMarketplacePanel.installConfigureLater'))) : installedId ? (uiText(language)('pluginMarketplacePanel.retryActivation')) : preview.updating ? (uiText(language)('pluginMarketplacePanel.updateAndEnable')) : (uiText(language)('pluginMarketplacePanel.installAndEnable'))}
      </button>
      {busy === 'install' && <div className="plugin-market-install-progress" role="status">
        <p>{installPhase(installProgress?.phase, uiLanguage)}{installProgress?.phase === 'downloading' && ` · ${downloadSize(installProgress.downloadedBytes)}${installProgress.totalBytes ? ` / ${downloadSize(installProgress.totalBytes)}` : ''}`}</p>
        {installProgress?.phase === 'downloading' && <progress aria-label={uiText(language)('pluginMarketplacePanel.downloadProgress')}
          max={installProgress.totalBytes || 1} value={installProgress.totalBytes ? installProgress.downloadedBytes : undefined} />}
        {installProgress?.cancellable && bridge?.cancelMarketPluginInstall && <button className="plugin-back" type="button" disabled={cancelling} onClick={() => void cancelInstall()}>
          <X size={15} />{cancelling ? (uiText(language)('accountsPanel.cancelling')) : (uiText(language)('pluginMarketplacePanel.cancelInstallation'))}
        </button>}
      </div>}
      {activated && <button className="plugin-back" type="button" onClick={() => onOpenBundled(installedId)}>{uiText(language)('pluginMarketplacePanel.configureConnectionsAndApproval')}</button>}
    </div> : <>
      {addOpen && <SettingsFormDialog className="plugin-market-source-dialog" language={language} busy={Boolean(busy)}
        title={uiText(language)('pluginMarketplacePanel.addAMarketplaceSource')}
        description={uiText(language)('pluginMarketplacePanel.connectAMarketplaceToBrowseAndInstall')}
        onCancel={closeSource} onSubmit={() => addSource(sourceKind === 'local')}
        footer={<>
          <button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={closeSource}>{uiText(language)('agentConnectionForm.cancel')}</button>
          <button className="primary-button" type="submit" disabled={Boolean(busy) || (sourceKind === 'git' ? !sourceInput.trim() : host.remote && !directoryInput.trim())}>
            {busy === 'source' ? <LoaderCircle className="spin" size={15}/> : sourceKind === 'local' && !host.remote ? <FolderOpen size={15}/> : <Plus size={15}/>}
            {busy === 'source' ? (uiText(language)('pluginMarketplacePanel.adding')) : sourceKind === 'local' && !host.remote ? (uiText(language)('pluginMarketplacePanel.chooseFolderAndAdd')) : (uiText(language)('pluginMarketplacePanel.addMarketplace'))}
          </button>
        </>}>
        <fieldset className="settings-dialog-fields" disabled={Boolean(busy)}>
          <label className="settings-field"><span>{uiText(language)('pluginMarketplacePanel.sourceType')}</span>
            <SettingsDropdown label={uiText(language)('pluginMarketplacePanel.sourceType')} value={sourceKind} onChange={value => { setSourceKind(value as 'git' | 'local'); setSourceError(''); }}
              options={[{ value: 'git', label: uiText(language)('pluginMarketplacePanel.gitRepository') }, { value: 'local', label: host.remote ? (uiText(language)('pluginMarketplacePanel.agentHostDirectory')) : (uiText(language)('pluginMarketplacePanel.localFolder')) }]}/>
          </label>
          {sourceKind === 'git' ? <>
            <SettingsInput label={uiText(language)('pluginMarketplacePanel.marketplaceRepository')} value={sourceInput} onChange={value => { setSourceInput(value); setSourceError(''); }} placeholder={uiText(language)('pluginMarketplacePanel.https_github_com_owner_repo')}/>
            <details className="plugin-market-source-help"><summary>{uiText(language)('pluginMarketplacePanel.addressFormatsAndVersions')}</summary>
              <p className="plugin-market-hint">{uiText(language)('pluginMarketplacePanel.supportsHttpSSshGitUrlsOr')}</p>
              <p className="plugin-market-hint">{host.remote ? (uiText(language)('pluginMarketplacePanel.gitUsesAuthenticationConfiguredOnTheAgent')) : (uiText(language)('pluginMarketplacePanel.gitUsesYourLocalAuthentication'))}</p>
            </details>
          </> : host.remote ? <SettingsInput label={uiText(language)('pluginMarketplacePanel.marketplaceDirectoryOnTheAgentHost')} value={directoryInput} onChange={value => { setDirectoryInput(value); setSourceError(''); }} placeholder={uiText(language)('pluginMarketplacePanel.srv_plugins_marketplace')}/>
            : <p className="plugin-market-hint">{uiText(language)('pluginMarketplacePanel.chooseAFolderContainingAMarketplaceManifest')}</p>}
          {sourceError && renderError(sourceError, true)}
        </fieldset>
      </SettingsFormDialog>}
      <div className="plugin-market-toolbar"><div className="plugin-market-controls">
        <select aria-label={uiText(language)('pluginMarketplacePanel.selectMarketplace')} value={sourceId} onChange={event => { setSourceId(event.currentTarget.value); setQuery(''); }} disabled={Boolean(busy)}>
          {sources.map(source => <option key={source.id} value={source.id}>{source.builtin ? (uiText(language)('pluginManagementPanel.cardbushFeatured')) : `${source.location}${source.ref && source.ref !== 'HEAD' ? `@${source.ref}` : ''}`}</option>)}
        </select>
        <button className="plugin-back plugin-market-icon-button" type="button" disabled={Boolean(busy)} title={uiText(language)('pluginMarketplacePanel.refreshMarketplace')} aria-label={uiText(language)('pluginMarketplacePanel.refreshMarketplace')} onClick={() => void loadCatalog(true)}><RefreshCw size={16} className={busy === 'catalog' ? 'spin' : undefined} /><span className="sr-only">{uiText(language)('pluginMarketplacePanel.refreshMarketplace')}</span></button>
        {selectedSource && !selectedSource.builtin && <button className="plugin-back" type="button" title={uiText(language)('pluginMarketplacePanel.removeSourceKeepInstalledPlugins')} disabled={Boolean(busy)} onClick={() => void removeSource()}><Trash2 size={16} /></button>}
      </div><label className="plugin-search"><Search size={18} /><input aria-label={uiText(language)('pluginMarketplacePanel.searchMarketplacePlugins')} placeholder={uiText(language)('pluginMarketplacePanel.searchPluginsOrCapabilities')} value={query} onChange={event => setQuery(event.currentTarget.value)} /></label></div>
      {catalog?.cached && <p className="plugin-market-hint" role="status">{uiText(language)('pluginMarketplacePanel.showingCachedCatalogRefreshFailed')}{marketError(catalog.error ?? '', uiLanguage, now)}</p>}
      {busy && busy !== 'source' && <p className="plugin-market-progress" role="status"><LoaderCircle className="spin" size={16} />{busy.startsWith('preview:') ? (uiText(language)('pluginMarketplacePanel.loadingPluginDetails')) : (uiText(language)('pluginMarketplacePanel.loadingMarketplace'))}</p>}
      {catalog && <div className="plugin-section-title"><h3>{catalog.source.builtin ? (uiText(language)('pluginManagementPanel.cardbushFeatured')) : catalog.displayName}</h3><span>{uiText(language)('pluginMarketplacePanel.plugins', { value1: entries.length })}</span></div>}
      <div className="plugin-market-grid">
        {bridge && entries.map(entry => <PluginMarketCard bridge={bridge} key={`${sourceId}:${catalog?.fetchedAt}:${entry.name}`} entry={entry} sourceId={sourceId} busy={Boolean(busy)} uiLanguage={uiLanguage} onOpen={() => void openPlugin(entry.name)} />)}
        {catalog && !entries.length && !busy && <p className="plugin-catalog-empty">{uiText(language)('pluginMarketplacePanel.noMatchingPlugins')}</p>}
      </div>
    </>}
  </div>;
}

function message(value: unknown) { return value instanceof Error ? value.message : String(value); }
function downloadSize(value: number) { return `${(value / 1024 / 1024).toFixed(1)} MiB`; }
function installPhase(phase: PluginMarketInstallProgress['phase'] | undefined, uiLanguage: string) {
  const labels = { queued: 'pluginMarketplacePanel.waiting_to_install' as const, downloading: 'voiceModelPanel.downloading' as const, extracting: 'pluginMarketplacePanel.extracting_plugin_files' as const,
    validating: 'pluginMarketplacePanel.validating_plugin' as const, installing: 'pluginMarketplacePanel.finishing_installation' as const, completed: 'pluginMarketplacePanel.installation_completed' as const, cancelled: 'browserLibraryDialog.cancelled' as const, failed: 'pluginMarketplacePanel.installation_failed' as const };
  return uiText(uiLanguage)(labels[phase ?? 'queued']);
}
function adaptationNote(note: string, uiLanguage: string) {
  const prefix = note.split(':')[0];
  if (note.startsWith('Command ') && note.includes('model inherits')) return uiText(uiLanguage)('plugin.note.commandModel', { prefix });
  if (note.includes('declared tool preapprovals')) return uiText(uiLanguage)('plugin.note.preapproval', { prefix });
  if (note.includes('model inherits')) return uiText(uiLanguage)('plugin.note.subagentModel', { prefix });
  if (note.includes('reasoning effort')) return uiText(uiLanguage)('plugin.note.reasoning', { prefix });
  return note;
}
function issueText(code: string, uiLanguage: string) {
  const labels: Record<string, MessageKey> = {
    components: 'pluginMarketplacePanel.unsupported_components' as const, variables: 'pluginMarketplacePanel.environment_variables_require_configuration' as const,
    authentication: 'pluginMarketplacePanel.additional_authentication_support_required' as const, transport: 'pluginMarketplacePanel.unsupported_transport' as const,
    reserved: 'pluginMarketplacePanel.name_reserved_by_a_bundled_plugin' as const, collision: 'pluginMarketplacePanel.installed_plugin_from_another_source_uses_this' as const,
    conflicting: 'pluginMarketplacePanel.marketplace_and_plugin_definitions_conflict' as const,
    empty: 'pluginMarketplacePanel.no_loadable_capabilities_found' as const, configuration: 'pluginMarketplacePanel.mcp_requires_a_valid_command_or_url' as const,
    extension: 'pluginMarketplacePanel.this_component_uses_unsupported_features' as const,
  };
  return (labels[code] && uiText(uiLanguage)(labels[code])) ?? code;
}
