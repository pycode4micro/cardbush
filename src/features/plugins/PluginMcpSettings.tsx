import { uiText } from '../../i18n';
import { useSettingsHost } from '../settings/SettingsHostContext';
import { useCallback, useEffect, useRef, useState } from 'react';
import { openAiAppAuthorizationUrl, usesOpenAiHostedConnection, type OpenAiAccountStatus } from '@cardbush/bush-protocol';
import { OpenAiAccountPanel } from './OpenAiAccountPanel';
import { mcpConnectionState, type McpConnectionOverview } from '../../backend/mcpConnectionOverview';
import type { CardbushAppPlugin } from '../../types';
import { useCapabilityCatalogRefresh } from '../../hooks/useCapabilityCatalogRefresh';
import { ArrowUpRight } from 'lucide-react';
import { pluginTroubleshootingPrompt } from './pluginPrompts';
import './mcp-integration.css';

type Json = Record<string, unknown>;
export function PluginMcpSettings({ plugin, language, onSaved, onManageAccounts, onOpenPrompt }: { plugin: CardbushAppPlugin; language: string; onSaved: () => void; onManageAccounts?: () => void; onOpenPrompt?: (prompt: string) => void }) {
  const host = useSettingsHost();

  const [draft, setDraft] = useState<Json>(() => record(plugin.config.mcp_servers));
  const [overview, setOverview] = useState<McpConnectionOverview | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [savedMessage, setSavedMessage] = useState('');
  const [authorizationTarget, setAuthorizationTarget] = useState('');
  const [openAiStatus, setOpenAiStatus] = useState<OpenAiAccountStatus>();
  const [advancedOpen, setAdvancedOpen] = useState<Set<string>>(() => new Set());
  const actionInFlight = useRef(false);
  const actionRevision = useRef(0);
  const readRevision = useRef(0);
  const authorizationRef = useRef('');
  const changingConnection = useRef(false);
  const [secrets, setSecrets] = useState<Record<string, string | null>>({});
  const remote = JSON.stringify(record(plugin.config.mcp_servers));
  const baseline = useRef(remote);
  const refresh = useCallback(async () => {
    const revision = ++readRevision.current;
    const value = await host.fetchMcpConnectionOverview();
    if (revision === readRevision.current) {
      setOverview(value);
      if (authorizationRef.current && mcpConnectionState(authorizationRef.current, true, value.snapshot, value.revision) === 'connected') {
        authorizationRef.current = ''; setAuthorizationTarget('');
      }
    }
    return value;
  }, [host]);
  const setAuthorization = (id: string) => { authorizationRef.current = id; setAuthorizationTarget(id); };
  useEffect(() => {
    baseline.current = remote; setDraft(JSON.parse(remote)); setSecrets({}); setError(''); setSavedMessage('');
    setAuthorization(''); setAdvancedOpen(new Set()); setOverview(null); setBusy(''); actionInFlight.current = false; changingConnection.current = false;
    const revision = ++actionRevision.current;
    void refresh().catch(caught => { if (revision === actionRevision.current) setError(String(caught)); });
    return () => { actionRevision.current++; readRevision.current++; authorizationRef.current = ''; };
  }, [plugin.id, refresh]);
  useCapabilityCatalogRefresh(useCallback(async () => { await refresh(); }, [refresh]));
  // Snapshot reads do not reconnect or open authorization pages. Pending changes
  // can finish inside the worker without a catalog event reaching this panel.
  const observing = overview?.snapshot?.applicationState === 'pending' || overview?.snapshot?.servers.some(server => server.health === 'restarting');
  useEffect(() => {
    if (!observing) return;
    let disposed = false;
    let timer = 0;
    const check = async () => {
      try { if (document.visibilityState !== 'hidden') await refresh(); }
      catch { /* Keep the last observation until the next read or manual refresh. */ }
      if (!disposed) timer = window.setTimeout(() => void check(), 2_000);
    };
    timer = window.setTimeout(() => void check(), 2_000);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [observing, refresh]);
  useEffect(() => {
    if (baseline.current === remote) return;
    if (JSON.stringify(draft) !== baseline.current || Object.keys(secrets).length > 0) {
      setError(uiText(language)('pluginMcpSettings.connectionSettingsChangedElsewhereYourDraftIs'));
      return;
    }
    baseline.current = remote; setDraft(JSON.parse(remote));
  }, [remote]);
  const dirty = JSON.stringify(draft) !== baseline.current || Object.keys(secrets).length > 0;
  const services = plugin.components.filter(item => item.kind === 'mcp' || (item.kind === 'app' && !item.app));
  const change = (name: string, patch: Json) => { setSavedMessage(''); setDraft(current => ({ ...current, [name]: { ...record(current[name]), ...patch } })); };
  const troubleshoot = async (componentId: string, connection: Parameters<typeof pluginTroubleshootingPrompt>[1]) => {
    if (actionInFlight.current || dirty || !onOpenPrompt) return;
    actionInFlight.current = true;
    const revision = ++actionRevision.current;
    setBusy('troubleshoot');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // A failed or slow context read must still allow an editable diagnostic draft.
      const context = await Promise.race([
        window.cardbushDesktop?.pluginTroubleshootingContext?.(plugin.id, componentId).catch(() => undefined),
        new Promise<undefined>(resolve => { timeout = setTimeout(() => resolve(undefined), 2_000); }),
      ]);
      if (revision === actionRevision.current) onOpenPrompt(pluginTroubleshootingPrompt(plugin, connection, language, context));
    } finally {
      clearTimeout(timeout);
      if (revision === actionRevision.current) { actionInFlight.current = false; setBusy(''); }
    }
  };
  const save = async () => {
    if (!host.supportsPluginConnections) return;
    setBusy('save'); setError(''); setSavedMessage('');
    try {
      const latest = await host.fetchCardbushAppsConfiguration();
      const current = latest.plugins.find(item => item.id === plugin.id);
      if (!current || JSON.stringify(record(current.config.mcp_servers)) !== baseline.current) throw new Error(uiText(language)('pluginMcpSettings.connectionSettingsChangedElsewhereReloadTheConfiguration'));
      const saved = await host.savePluginConnections({ pluginId: plugin.id, expectedRevision: latest.revision, connections: draft, secrets });
      baseline.current = JSON.stringify(saved.connections); setDraft(saved.connections); setSecrets({});
      onSaved();
      if (saved.applicationError || saved.runtimeError) setError(saved.applicationError || saved.runtimeError || '');
      setSavedMessage(uiText(language)('pluginMcpSettings.settingsSaved'));
      try { await refresh(); } catch (caught) { setError(current => current || String(caught)); }
    } catch (caught) { setError(String(caught)); } finally { setBusy(''); }
  };
  const action = async (id: string, action: 'login' | 'logout' | 'reconnect') => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    const revision = ++actionRevision.current;
    setBusy(`${id}:${action}`); setError(''); setSavedMessage('');
    let succeeded = false;
    try { await host.mcpConnectionAction(id, action); succeeded = true; }
    catch (caught) { if (revision === actionRevision.current) setError(String(caught)); }
    finally {
      if (revision !== actionRevision.current) return;
      try {
        const value = await refresh();
        if (revision === actionRevision.current && succeeded && action === 'reconnect' && mcpConnectionState(id, true, value.snapshot, value.revision) === 'connected' && authorizationRef.current === id) {
          setAuthorization('');
        }
      } catch (caught) { if (revision === actionRevision.current) setError(current => current || String(caught)); }
      if (revision === actionRevision.current) { actionInFlight.current = false; setBusy(''); }
    }
  };
  const authorizeApp = async (id: string, url: string) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    const revision = ++actionRevision.current;
    setBusy(`${id}:authorize`); setError(''); setSavedMessage('');
    try { await window.cardbushDesktop!.openExternal(url); if (revision === actionRevision.current) setAuthorization(id); }
    catch (caught) { if (revision === actionRevision.current) setError(String(caught)); }
    finally { if (revision === actionRevision.current) { actionInFlight.current = false; setBusy(''); } }
  };
  const setConnectionEnabled = async (componentId: string, enabled: boolean) => {
    const id = `plugin_${plugin.id.replaceAll('.', '_')}_${componentId}`;
    if (!host.supportsPluginConnections || changingConnection.current || busy === 'save' || (busy && !busy.startsWith(`${id}:`))) return;
    changingConnection.current = true;
    const revision = ++actionRevision.current;
    actionInFlight.current = true;
    if (authorizationRef.current === id) setAuthorization('');
    readRevision.current++; // Earlier connection checks cannot restore a cancelled attempt.
    setBusy(`${id}:${enabled ? 'enable' : 'cancel'}`); setError(''); setSavedMessage('');
    try {
      let cancellationError = '';
      if (!enabled && !host.remote) {
        try { await host.mcpConnectionAction(id, 'cancel_login'); }
        catch (caught) { cancellationError = String(caught); }
      }
      const latest = await host.fetchCardbushAppsConfiguration();
      if (revision !== actionRevision.current) return;
      const current = latest.plugins.find(item => item.id === plugin.id);
      if (!current) throw new Error(uiText(language)('pluginMcpSettings.thisPluginWasRemovedRefreshThePlugin'));
      // Persist only this switch, using the latest configuration. Unrelated
      // drafts and private credential input must never be saved by cancellation.
      const connections = record(current.config.mcp_servers);
      const settings = record(connections[componentId]);
      const required = (settings.required ?? current.components.find(component => component.id === componentId)?.mcp?.required) === true;
      const patch = { enabled, ...(!enabled && required ? { required: false } : {}) };
      const saved = await host.savePluginConnections({ pluginId: plugin.id, expectedRevision: latest.revision,
        connections: { ...connections, [componentId]: { ...record(connections[componentId]), ...patch } } });
      if (revision !== actionRevision.current) return;
      const prior = record(JSON.parse(baseline.current));
      // A retained draft still belongs to its original baseline. Do not silently
      // rebase it onto concurrent edits and let a later save overwrite them.
      baseline.current = JSON.stringify(dirty ? { ...prior, [componentId]: { ...record(prior[componentId]), ...patch } } : saved.connections);
      setDraft(draft => {
        const next = { ...saved.connections };
        for (const [name, value] of Object.entries(draft)) if (JSON.stringify(value) !== JSON.stringify(prior[name])) next[name] = value;
        next[componentId] = { ...record(next[componentId]), ...patch };
        return next;
      });
      onSaved();
      setSavedMessage(enabled ? (uiText(language)('pluginMcpSettings.connectionEnabled')) : (uiText(language)('pluginMcpSettings.connectionCancelledAndThisServiceDisabledYou')));
      if (saved.applicationError || saved.runtimeError || cancellationError) setError(saved.applicationError || saved.runtimeError || cancellationError);
      await refresh();
    } catch (caught) { if (revision === actionRevision.current) setError(String(caught)); }
    finally { if (revision === actionRevision.current) { changingConnection.current = false; actionInFlight.current = false; setBusy(''); } }
  };
  useEffect(() => {
    if (!authorizationTarget || busy || dirty || openAiStatus?.state !== 'signed_in') return;
    const component = services.find(item => `plugin_${plugin.id.replaceAll('.', '_')}_${item.id}` === authorizationTarget);
    if (!component || !usesOpenAiHostedConnection(component.mcp?.registeredAppId, record(draft[component.id]))) return;
    // Only a user-started authorization gets a reconnect on return; no background polling.
    const onFocus = () => { if (authorizationRef.current === authorizationTarget && document.visibilityState !== 'hidden') void action(authorizationTarget, 'reconnect'); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [authorizationTarget, busy, dirty, openAiStatus?.state, plugin.id, draft]);
  useEffect(() => {
    if (authorizationTarget && !busy && !dirty && openAiStatus?.state === 'signed_in' &&
        mcpConnectionState(authorizationTarget, true, overview?.snapshot ?? null, overview?.revision) === 'connected') setAuthorization('');
  }, [authorizationTarget, busy, dirty, openAiStatus?.state, overview]);
  if (!services.length || ['chrome', 'computer-use'].includes(plugin.id)) return null;
  const toggleAdvanced = (id: string, open: boolean) => setAdvancedOpen(current => {
    if (current.has(id) === open) return current;
    const next = new Set(current); if (open) next.add(id); else next.delete(id); return next;
  });
  const stored = record(JSON.parse(baseline.current));
  return <section className="plugin-detail-section plugin-mcp-settings"><div className="plugin-mcp-heading"><h3>{uiText(language)('pluginMcpSettings.appConnections')}</h3>
    <button type="button" className="mcp-quiet-action" disabled={Boolean(busy)} onClick={() => void refresh().catch(caught => setError(String(caught)))}>{uiText(language)('pluginMcpSettings.refreshStatus')}</button></div>
    {!host.remote && services.some(component => component.mcp?.registeredAppId) && <OpenAiAccountPanel language={language} onChanged={() => void refresh().catch(() => {})} onStatusChange={setOpenAiStatus} onManageAccounts={onManageAccounts} navigationDisabled={dirty || Boolean(busy)} />}
    {!host.supportsPluginConnections && <p role="status">{uiText(language)('pluginMcpSettings.updateTheAgentServiceToEditPlugin')}</p>}
    {services.map(component => {
      const settings = record(draft[component.id]), connection = record(settings.connection), oauth = record(settings.oauth);
      const id = `plugin_${plugin.id.replaceAll('.', '_')}_${component.id}`;
      const actual = overview?.snapshot?.servers.find(server => server.id === id);
      const registered = Boolean(component.mcp?.registeredAppId) || component.kind === 'app';
      const hosted = usesOpenAiHostedConnection(component.mcp?.registeredAppId, settings);
      const authorizationUrl = openAiAppAuthorizationUrl(component.name, component.mcp?.registeredAppId);
      const bound = registered && Boolean(settings.server);
      const binding = bound ? overview?.servers.find(server => server.id === settings.server) : undefined;
      const missingBinding = bound && !binding?.enabled;
      const needsConnection = !hosted && !bound && component.kind === 'app' && !connection.url;
      const required = (settings.required ?? component.mcp?.required) === true;
      const enabled = plugin.enabled && settings.enabled !== false;
      const connectionState = mcpConnectionState(id, enabled, overview?.snapshot ?? null, overview?.revision);
      const pending = connectionState === 'pending';
      const resourceWaiting = connectionState === 'waiting_for_resources';
      const needsAccount = !host.remote && hosted && openAiStatus?.state !== 'signed_in';
      const modified = JSON.stringify(settings) !== JSON.stringify(record(stored[component.id])) || Object.hasOwn(secrets, component.id);
      const ready = !modified && !needsAccount && !missingBinding && connectionState === 'connected';
      const waitingForAuthorization = hosted && authorizationTarget === id;
      const cancelling = busy === `${id}:cancel`;
      const status = modified ? (uiText(language)('pluginMcpSettings.unsavedChanges')) : !enabled ? (uiText(language)('pluginManagementPanel.disabled'))
        : resourceWaiting ? (actual?.health === 'ready' ? (uiText(language)('pluginMcpSettings.connectedUpdateWaitingForResources')) : (uiText(language)('pluginMcpSettings.waitingForResources')))
        : pending ? (actual?.updateState === 'waiting_for_calls' ? (uiText(language)('pluginMcpSettings.waitingForCurrentToolCalls')) : (uiText(language)('pluginMcpSettings.synchronizingTools')))
        : needsAccount ? (uiText(language)('pluginMcpSettings.signInAboveToConnect')) : ready ? (uiText(language)('browserConnectionSettings.connected'))
          : busy === `${id}:reconnect` || connectionState === 'restarting' ? (uiText(language)('workspace.connecting'))
            : connectionState === 'unavailable' ? (uiText(language)('pluginMcpSettings.connectionFailed')) : connectionState === 'auth_required' ? (uiText(language)('pluginMcpSettings.signInRequired')) : connectionState === 'configuration_required' ? (hosted ? (uiText(language)('pluginMcpSettings.notConnected')) : (uiText(language)('pluginMcpSettings.configurationRequired')))
              : missingBinding ? (uiText(language)('pluginMcpSettings.boundServiceUnavailable')) : needsConnection ? (uiText(language)('pluginMcpSettings.configurationRequired')) : (uiText(language)('pluginMcpSettings.disconnected'));
      const tools = [...new Set([...(actual?.tools.map(tool => tool.remoteName) ?? []), ...Object.keys(record(settings.tools))])];
      const transport = bound ? binding?.transport : component.mcp?.transport;
      const network = (!bound && component.kind === 'app') || ['http', 'streamable_http', 'sse'].includes(transport ?? '');
      const unavailable = !plugin.enabled || settings.enabled === false || missingBinding || Boolean(needsConnection);
      const signingIn = busy === `${id}:login`;
      const needsSetup = !hosted && (missingBinding || needsConnection || connectionState === 'configuration_required');
      const openHostedAuthorization = !waitingForAuthorization && connectionState !== 'unavailable' && Boolean(authorizationUrl);
      return <div className="plugin-mcp-service" key={component.id}><header><div className="plugin-mcp-identity"><strong>{component.name}</strong><span className="plugin-mcp-status" data-ready={ready}>{status}</span></div>
        {plugin.enabled && !ready && <div className="plugin-mcp-primary-actions">
          {!enabled ? <button type="button" disabled={!host.supportsPluginConnections || Boolean(busy)} onClick={() => void setConnectionEnabled(component.id, true)}>{uiText(language)('pluginMcpSettings.enableAgain')}</button>
            : <>{!needsAccount && !signingIn && <button type="button" className="mcp-primary-action" disabled={Boolean(busy) || dirty || pending || resourceWaiting || connectionState === 'restarting'} onClick={() => {
              if (!host.remote && hosted && openHostedAuthorization) void authorizeApp(id, authorizationUrl!);
              else if (needsSetup) toggleAdvanced(id, true);
              else void action(id, !host.remote && !hosted && network && connectionState === 'auth_required' ? 'login' : 'reconnect');
            }}>{hosted ? (waitingForAuthorization ? (uiText(language)('mcpActivationStatus.checkConnection')) : connectionState === 'unavailable' ? (uiText(language)('pluginMcpSettings.retry')) : (uiText(language)('pluginMcpSettings.connect')))
              : needsSetup ? (uiText(language)('pluginMcpSettings.setUp')) : !host.remote && connectionState === 'auth_required' ? (uiText(language)('pluginMcpSettings.signIn')) : (uiText(language)('pluginMcpSettings.connect'))}</button>}
              <button type="button" disabled={!host.supportsPluginConnections || cancelling || busy === 'save' || Boolean(busy && !busy.startsWith(`${id}:`))}
                onClick={() => void setConnectionEnabled(component.id, false)}>{cancelling ? (uiText(language)('accountsPanel.cancelling')) : (uiText(language)('pluginMcpSettings.cancelConnection'))}</button></>}
        </div>}</header>
        {onOpenPrompt && enabled && ['unavailable', 'configuration_required', 'auth_required'].includes(connectionState) && <button
          type="button" className="plugin-troubleshoot-action" disabled={Boolean(busy) || dirty}
          onClick={() => void troubleshoot(component.id, {
            id, name: component.name, state: connectionState, transport,
            error: actual?.lastError || overview?.snapshot?.applicationError,
            configurationRevision: overview?.snapshot?.configurationRevision, updateState: actual?.updateState,
            restartAttempts: actual?.restartAttempts, toolCount: actual?.tools.length,
          })}><ArrowUpRight size={15} />{uiText(language)('pluginMcpSettings.troubleshootWithAssistant')}</button>}
        {waitingForAuthorization && !resourceWaiting && <p role="status" className="plugin-mcp-hint">{uiText(language)('pluginMcpSettings.finishAuthorizationInYourBrowserWeLl')}</p>}
        {resourceWaiting && <p role="status" className="plugin-mcp-hint">{uiText(language)('pluginMcpSettings.connectsAutomaticallyWhenResourcesAreAvailable')}</p>}
        {pending && <p className="plugin-mcp-hint">{!enabled
          ? (uiText(language)('pluginMcpSettings.disablingIsSavedAlreadyDispatchedCallsOn'))
          : (uiText(language)('pluginMcpSettings.updatingThisConnectionAfterItsDispatchedCalls'))}</p>}
        {!ready && enabled && required && <p className="plugin-mcp-hint">{uiText(language)('pluginMcpSettings.cancellingDisablesThisConnectionAndFeaturesThat')}</p>}
        <details className="plugin-mcp-advanced" open={advancedOpen.has(id)} onToggle={event => toggleAdvanced(id, event.currentTarget.open)}><summary>{uiText(language)('pluginMcpSettings.advancedSettings')}</summary>
        <div className="plugin-mcp-options">
        <label><input type="checkbox" checked={settings.enabled !== false} onChange={event => change(component.id, { enabled: event.target.checked })} />{uiText(language)('pluginMcpSettings.enabled')}</label>
        <label><input type="checkbox" checked={required} onChange={event => change(component.id, { required: event.target.checked })} />{uiText(language)('pluginMcpSettings.requiredConnection')}</label></div>
        {required && (needsConnection || missingBinding || settings.enabled === false) && <p role="alert">{uiText(language)('pluginMcpSettings.thisPluginRequiresThisConnectionConfigureAnd')}</p>}
        {component.mcp?.registeredAppId && <p><small>{host.remote && hosted ? (uiText(language)('pluginMcpSettings.connectionSourceTheAgentServerSOpenai')) : hosted ? (uiText(language)('pluginMcpSettings.connectionSourceOpenaiAccountUseTheSame')) : bound
          ? (uiText(language)('pluginMcpSettings.connectionSourceExistingMcpServerUsingIts'))
          : host.remote ? (uiText(language)('pluginMcpSettings.connectionSourceDirectUsingThisAgentS')) : (uiText(language)('pluginMcpSettings.connectionSourceDirectWithSeparateAuthenticationTo'))}<br />{component.mcp.registeredAppId}</small></p>}
        <div className="mcp-fields">
          {registered && <label>{uiText(language)('pluginMcpSettings.connectionSource')}<select value={hosted ? '__openai__' : String(settings.server ?? '')} onChange={event => {
            const isOpenAi = event.target.value === '__openai__';
            change(component.id, { provider: isOpenAi ? 'openai' : 'direct', server: isOpenAi ? undefined : event.target.value || undefined });
            if (isOpenAi) setSecrets(current => { const next = { ...current }; delete next[component.id]; return next; });
          }}>
            {!host.remote && component.mcp?.registeredAppId && <option value="__openai__">{uiText(language)('pluginMcpSettings.openaiAccountExperimental')}</option>}
            {host.remote && hosted && <option value="__openai__" disabled>{uiText(language)('pluginMcpSettings.openaiAccountServerManaged')}</option>}
            <option value="">{component.kind === 'mcp' ? (uiText(language)('pluginMcpSettings.useBundledConnection')) : (uiText(language)('pluginMcpSettings.useEndpointBelow'))}</option>
            {bound && !binding && <option value={String(settings.server)}>{String(settings.server)}{uiText(language)('pluginMcpSettings.unavailable')}</option>}
            {overview?.servers.map(server => <option key={server.id} value={server.id}>{server.name}{server.enabled ? '' : (uiText(language)('pluginMcpSettings.disabled'))}</option>)}</select></label>}
          {network && !bound && !hosted && <label>{uiText(language)('pluginMcpSettings.mcpEndpoint')}<input type="url" placeholder={component.mcp?.url || 'https://…/mcp'} value={String(connection.url ?? '')}
            onChange={event => change(component.id, { connection: { ...connection, url: event.target.value || undefined } })} /></label>}
          <label>{uiText(language)('pluginMcpSettings.defaultToolApproval')}<select value={String(settings.default_tools_approval_mode ?? 'prompt')} onChange={event => change(component.id, { default_tools_approval_mode: event.target.value })}>
            <option value="prompt">{uiText(language)('pluginMcpSettings.prompt')}</option><option value="approve">{uiText(language)('pluginMcpSettings.approve')}</option></select></label>
          <label>{uiText(language)('pluginMcpSettings.enabledToolsCommaSeparatedBlankForAll')}<input value={Array.isArray(settings.enabled_tools) ? settings.enabled_tools.join(', ') : ''}
            onChange={event => change(component.id, { enabled_tools: event.target.value.trim() ? event.target.value.split(',').map(item => item.trim()).filter(Boolean) : undefined })} /></label>
        </div>
        {!host.remote && network && !hosted && <details><summary>{uiText(language)('pluginMcpSettings.oauthOptions')}</summary><div className="mcp-fields">
          {[['clientId', 'client_id', uiText(language)('pluginMcpSettings.clientIdOptional')], ['scopes', 'scopes', uiText(language)('pluginMcpSettings.scopesSpaceSeparated')],
            ['expectedIssuer', 'expected_issuer', uiText(language)('pluginMcpSettings.authorizationServerUrlIssuerRequiredWithA')],
            ['callbackUrl', 'callback_url', uiText(language)('pluginMcpSettings.loopbackCallbackOptional')], ['callbackPort', 'callback_port', uiText(language)('pluginMcpSettings.loopbackPortOptional')], ['resourceUrl', 'oauth_resource', uiText(language)('pluginMcpSettings.oauthResourceUrlOptional')], ['clientMetadataUrl', 'client_metadata_url', uiText(language)('pluginMcpSettings.cimdDocumentUrlOptional')],
            ['clientSecretEnv', 'client_secret_env', uiText(language)('pluginMcpSettings.clientSecretEnvironmentVariableAdvanced')]].map(([key, alias, label]) => {
            const value = oauth[key] ?? oauth[alias];
            return <label key={key}>{label}<input value={key === 'scopes' && Array.isArray(value) ? value.join(' ') : String(value ?? '')}
              type={key === 'callbackPort' ? 'number' : 'text'} min={key === 'callbackPort' ? 0 : undefined} max={key === 'callbackPort' ? 65535 : undefined}
              onChange={event => { const next = { ...oauth }; delete next[alias];
                next[key] = event.target.value ? key === 'scopes' ? event.target.value.trim().split(/\s+/) : key === 'callbackPort' ? Number(event.target.value) : event.target.value : undefined;
                if (key === 'clientSecretEnv' && event.target.value) { delete next.clientSecretRef; delete next.client_secret_ref; }
                change(component.id, { oauth: next }); }} /></label>;
          })}
          <label>{uiText(language)('pluginMcpSettings.clientSecret')}<input type="password" autoComplete="off" disabled={Boolean(busy)} value={secrets[component.id] ?? ''}
            placeholder={(oauth.clientSecretRef || oauth.client_secret_ref) && secrets[component.id] !== null ? (uiText(language)('pluginMcpSettings.encryptedSecretSavedLeaveBlankToKeep')) : (uiText(language)('pluginMcpSettings.saveInEncryptedStorageOnThisDevice'))}
            onChange={event => { setSavedMessage(''); setSecrets(current => { const next = { ...current }; if (event.target.value) next[component.id] = event.target.value; else delete next[component.id]; return next; }); }} />
            <small>{uiText(language)('pluginMcpSettings.noRestartRequiredTheSecretStaysOut')}</small>
            {Boolean(oauth.clientSecretRef || oauth.client_secret_ref) && <button type="button" disabled={Boolean(busy)} onClick={() => setSecrets(current => ({ ...current, [component.id]: null }))}>{secrets[component.id] === null ? (uiText(language)('pluginMcpSettings.referenceWillBeRemovedOnSave')) : (uiText(language)('pluginMcpSettings.removeCredentialReference'))}</button>}
          </label>
        </div></details>}
        {tools.length > 0 && <details><summary>{uiText(language)('pluginMcpSettings.approvalForTools', { value1: tools.length })}</summary>{tools.map(name => {
          const policies = record(settings.tools), policy = record(policies[name]);
          return <label className="plugin-mcp-tool" key={name}><code>{name}</code><select value={policy.enabled === false ? 'deny' : String(policy.approval_mode ?? 'default')}
            onChange={event => change(component.id, { tools: { ...policies, [name]: { ...policy, enabled: event.target.value !== 'deny', approval_mode: event.target.value === 'default' ? undefined : event.target.value } } })}>
            <option value="default">{uiText(language)('pluginMcpSettings.default')}</option><option value="prompt">{uiText(language)('pluginMcpSettings.prompt_28fb08c')}</option><option value="approve">{uiText(language)('pluginMcpSettings.approve_5670603')}</option><option value="deny">{uiText(language)('pluginMcpSettings.disable')}</option>
          </select></label>;
        })}</details>}
        {(actual?.lastError || overview?.snapshot?.applicationError) && <details className="plugin-mcp-error"><summary>{uiText(language)('pluginMcpSettings.connectionDetails')}</summary><p>{actual?.lastError || overview?.snapshot?.applicationError}</p></details>}
        <div className="plugin-mcp-actions">{!host.remote && hosted && authorizationUrl && <button type="button" disabled={Boolean(busy) || dirty || needsAccount} onClick={() => void authorizeApp(id, authorizationUrl)}>{uiText(language)('pluginMcpSettings.authorizeThisAppThroughOpenai')}</button>}
          {!host.remote && network && !hosted && <button type="button" disabled={Boolean(busy) || dirty || unavailable} onClick={() => void action(id, 'login')}>{signingIn ? (uiText(language)('pluginMcpSettings.waitingForSignIn')) : (uiText(language)('pluginMcpSettings.signInAuthorize'))}</button>}
          {signingIn ? <button type="button" onClick={() => void host.mcpConnectionAction(id, 'cancel_login').catch(caught => setError(String(caught)))}>{uiText(language)('pluginMcpSettings.cancelSignIn')}</button>
            : <button type="button" disabled={Boolean(busy) || dirty || unavailable || pending || resourceWaiting || connectionState === 'restarting'} onClick={() => void action(id, 'reconnect')}>{hosted ? (uiText(language)('pluginMcpSettings.checkAuthorizationAndConnection')) : (uiText(language)('pluginMcpSettings.reconnect'))}</button>}
          {!host.remote && network && !hosted && <button type="button" disabled={Boolean(busy) || dirty || unavailable} onClick={() => void action(id, 'logout')}>{uiText(language)('pluginMcpSettings.signOut')}</button>}</div></details>
      </div>;
    })}
    {dirty && <p role="status">{uiText(language)('pluginMcpSettings.saveYourConnectionChangesBeforeSigningIn')}</p>}
    {error && <div role="alert" className="plugin-mcp-error"><p>{uiText(language)('pluginMcpSettings.theActionCouldNotBeCompletedCheck')}</p><details><summary>{uiText(language)('messageBubble.errorDetails')}</summary><p>{error}</p></details></div>}
    {savedMessage && <p role="status" className="plugin-mcp-hint">{savedMessage}</p>}
    {dirty && <div className="plugin-mcp-actions plugin-mcp-save"><button type="button" className="mcp-primary-action" disabled={!host.supportsPluginConnections || Boolean(busy)} onClick={() => void save()}>{uiText(language)('pluginMcpSettings.saveConnectionSettings')}</button>
      <button type="button" disabled={Boolean(busy)} onClick={() => { baseline.current = remote; setDraft(JSON.parse(remote)); setSecrets({}); setError(''); }}>{uiText(language)('pluginMcpSettings.resetChanges')}</button></div>}
  </section>;
}
function record(value: unknown): Json { return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}; }
