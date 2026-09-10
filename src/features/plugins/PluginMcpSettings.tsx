import { useCallback, useEffect, useRef, useState } from 'react';
import { openAiAppAuthorizationUrl, usesOpenAiHostedConnection, type OpenAiAccountStatus } from '@cardbush/bush-protocol';
import { OpenAiAccountPanel } from './OpenAiAccountPanel';
import { fetchCardbushAppsConfiguration, fetchMcpConnectionOverview } from '../../backend/api';
import { mcpConnectionState, type McpConnectionOverview } from '../../backend/mcpConnectionOverview';
import type { CardbushAppPlugin } from '../../types';
import { useCapabilityCatalogRefresh } from '../../hooks/useCapabilityCatalogRefresh';
import './mcp-integration.css';

type Json = Record<string, unknown>;
export function PluginMcpSettings({ plugin, language, onSaved, onManageAccounts }: { plugin: CardbushAppPlugin; language: 'zh' | 'en'; onSaved: () => void; onManageAccounts?: () => void }) {
  const zh = language === 'zh';
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
    const value = await fetchMcpConnectionOverview();
    if (revision === readRevision.current) {
      setOverview(value);
      if (authorizationRef.current && mcpConnectionState(authorizationRef.current, true, value.snapshot, value.revision) === 'connected') {
        authorizationRef.current = ''; setAuthorizationTarget('');
      }
    }
    return value;
  }, []);
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
      setError(zh ? '连接配置已在其他位置修改。当前输入已保留，请重新读取配置后合并修改。' : 'Connection settings changed elsewhere. Your draft is retained; reload the configuration to reconcile it.');
      return;
    }
    baseline.current = remote; setDraft(JSON.parse(remote));
  }, [remote]);
  const dirty = JSON.stringify(draft) !== baseline.current || Object.keys(secrets).length > 0;
  const services = plugin.components.filter(item => item.kind === 'mcp' || item.kind === 'app');
  const change = (name: string, patch: Json) => { setSavedMessage(''); setDraft(current => ({ ...current, [name]: { ...record(current[name]), ...patch } })); };
  const save = async () => {
    setBusy('save'); setError(''); setSavedMessage('');
    try {
      const latest = await fetchCardbushAppsConfiguration();
      const current = latest.plugins.find(item => item.id === plugin.id);
      if (!current || JSON.stringify(record(current.config.mcp_servers)) !== baseline.current) throw new Error(zh ? '连接配置已在其他位置修改，请重新读取配置。' : 'Connection settings changed elsewhere. Reload the configuration.');
      const saved = await window.cardbushDesktop!.savePluginConnections({ pluginId: plugin.id, expectedRevision: latest.revision, connections: draft, secrets });
      baseline.current = JSON.stringify(saved.connections); setDraft(saved.connections); setSecrets({});
      onSaved();
      if (saved.applicationError || saved.runtimeError) setError(saved.applicationError || saved.runtimeError || '');
      setSavedMessage(zh ? '配置已保存。' : 'Settings saved.');
      try { await refresh(); } catch (caught) { setError(current => current || String(caught)); }
    } catch (caught) { setError(String(caught)); } finally { setBusy(''); }
  };
  const action = async (id: string, action: 'login' | 'logout' | 'reconnect') => {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    const revision = ++actionRevision.current;
    setBusy(`${id}:${action}`); setError(''); setSavedMessage('');
    let succeeded = false;
    try { await window.cardbushDesktop!.mcpConnectionAction(id, action); succeeded = true; }
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
    if (changingConnection.current || busy === 'save' || (busy && !busy.startsWith(`${id}:`))) return;
    changingConnection.current = true;
    const revision = ++actionRevision.current;
    actionInFlight.current = true;
    if (authorizationRef.current === id) setAuthorization('');
    readRevision.current++; // Earlier connection checks cannot restore a cancelled attempt.
    setBusy(`${id}:${enabled ? 'enable' : 'cancel'}`); setError(''); setSavedMessage('');
    try {
      let cancellationError = '';
      if (!enabled) {
        try { await window.cardbushDesktop!.mcpConnectionAction(id, 'cancel_login'); }
        catch (caught) { cancellationError = String(caught); }
      }
      const latest = await fetchCardbushAppsConfiguration();
      if (revision !== actionRevision.current) return;
      const current = latest.plugins.find(item => item.id === plugin.id);
      if (!current) throw new Error(zh ? '插件已移除，请刷新插件列表。' : 'This plugin was removed. Refresh the plugin list.');
      // Persist only this switch, using the latest configuration. Unrelated
      // drafts and private credential input must never be saved by cancellation.
      const connections = record(current.config.mcp_servers);
      const settings = record(connections[componentId]);
      const required = (settings.required ?? current.components.find(component => component.id === componentId)?.mcp?.required) === true;
      const patch = { enabled, ...(!enabled && required ? { required: false } : {}) };
      const saved = await window.cardbushDesktop!.savePluginConnections({ pluginId: plugin.id, expectedRevision: latest.revision,
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
      setSavedMessage(enabled ? (zh ? '连接已启用。' : 'Connection enabled.') : (zh ? '已取消连接并停用此服务。需要时可重新启用。' : 'Connection cancelled and this service disabled. You can enable it again later.'));
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
  return <section className="plugin-detail-section plugin-mcp-settings"><div className="plugin-mcp-heading"><h3>{zh ? '应用连接' : 'App connections'}</h3>
    <button type="button" className="mcp-quiet-action" disabled={Boolean(busy)} onClick={() => void refresh().catch(caught => setError(String(caught)))}>{zh ? '刷新连接状态' : 'Refresh status'}</button></div>
    {services.some(component => component.mcp?.registeredAppId) && <OpenAiAccountPanel language={language} onChanged={() => void refresh().catch(() => {})} onStatusChange={setOpenAiStatus} onManageAccounts={onManageAccounts} navigationDisabled={dirty || Boolean(busy)} />}
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
      const needsAccount = hosted && openAiStatus?.state !== 'signed_in';
      const modified = JSON.stringify(settings) !== JSON.stringify(record(stored[component.id])) || Object.hasOwn(secrets, component.id);
      const ready = !modified && !needsAccount && !missingBinding && connectionState === 'connected';
      const waitingForAuthorization = hosted && authorizationTarget === id;
      const cancelling = busy === `${id}:cancel`;
      const status = modified ? (zh ? '有未保存修改' : 'Unsaved changes') : !enabled ? (zh ? '已停用' : 'Disabled') : pending ? (actual?.updateState === 'waiting_for_catalog' ? (zh ? '等待工具生效' : 'Awaiting tool activation') : (zh ? '等待任务结束后生效' : 'Pending until tasks finish'))
        : needsAccount ? (zh ? '登录账户后连接' : 'Sign in above to connect') : ready ? (zh ? '已连接' : 'Connected')
          : busy === `${id}:reconnect` || connectionState === 'restarting' ? (zh ? '连接中…' : 'Connecting…')
            : connectionState === 'unavailable' ? (zh ? '连接失败' : 'Connection failed') : connectionState === 'auth_required' ? (zh ? '需要登录' : 'Sign-in required') : connectionState === 'configuration_required' ? (hosted ? (zh ? '尚未连接' : 'Not connected') : (zh ? '需要配置' : 'Configuration required'))
              : missingBinding ? (zh ? '绑定的服务不可用' : 'Bound service unavailable') : needsConnection ? (zh ? '需要配置' : 'Configuration required') : (zh ? '未连接' : 'Disconnected');
      const tools = [...new Set([...(actual?.tools.map(tool => tool.remoteName) ?? []), ...Object.keys(record(settings.tools))])];
      const transport = bound ? binding?.transport : component.mcp?.transport;
      const network = (!bound && component.kind === 'app') || ['http', 'streamable_http', 'sse'].includes(transport ?? '');
      const unavailable = !plugin.enabled || settings.enabled === false || missingBinding || Boolean(needsConnection);
      const signingIn = busy === `${id}:login`;
      const needsSetup = !hosted && (missingBinding || needsConnection || connectionState === 'configuration_required');
      const openHostedAuthorization = !waitingForAuthorization && connectionState !== 'unavailable' && Boolean(authorizationUrl);
      return <div className="plugin-mcp-service" key={component.id}><header><div className="plugin-mcp-identity"><strong>{component.name}</strong><span className="plugin-mcp-status" data-ready={ready}>{status}</span></div>
        {plugin.enabled && !ready && <div className="plugin-mcp-primary-actions">
          {!enabled ? <button type="button" disabled={Boolean(busy)} onClick={() => void setConnectionEnabled(component.id, true)}>{zh ? '重新启用' : 'Enable again'}</button>
            : <>{!needsAccount && !signingIn && <button type="button" className="mcp-primary-action" disabled={Boolean(busy) || dirty || pending || connectionState === 'restarting'} onClick={() => {
              if (hosted && openHostedAuthorization) void authorizeApp(id, authorizationUrl!);
              else if (needsSetup) toggleAdvanced(id, true);
              else void action(id, !hosted && network && connectionState === 'auth_required' ? 'login' : 'reconnect');
            }}>{hosted ? (waitingForAuthorization ? (zh ? '检查连接' : 'Check connection') : connectionState === 'unavailable' ? (zh ? '重试连接' : 'Retry') : (zh ? '连接' : 'Connect'))
              : needsSetup ? (zh ? '配置连接' : 'Set up') : connectionState === 'auth_required' ? (zh ? '登录' : 'Sign in') : (zh ? '连接' : 'Connect')}</button>}
              <button type="button" disabled={cancelling || busy === 'save' || Boolean(busy && !busy.startsWith(`${id}:`))}
                onClick={() => void setConnectionEnabled(component.id, false)}>{cancelling ? (zh ? '正在取消…' : 'Cancelling…') : (zh ? '取消连接' : 'Cancel connection')}</button></>}
        </div>}</header>
        {waitingForAuthorization && <p role="status" className="plugin-mcp-hint">{zh ? '请在浏览器完成授权，返回后会自动检查连接。' : 'Finish authorization in your browser. We’ll check the connection when you return.'}</p>}
        {pending && <p className="plugin-mcp-hint">{!enabled
          ? (zh ? '已保存停用设置；正在运行的任务仍可能使用旧连接，任务结束后会移除。' : 'Disabling is saved. Running tasks may still use the previous connection until they finish.')
          : (zh ? '连接配置正在等待运行中的任务结束，可先取消不需要的连接。状态会自动更新。' : 'Connection settings are waiting for running tasks to finish. You can cancel unwanted connections; status updates automatically.')}</p>}
        {!ready && enabled && required && <p className="plugin-mcp-hint">{zh ? '取消后将停用此连接，依赖它的功能将不可用。' : 'Cancelling disables this connection and features that depend on it.'}</p>}
        <details className="plugin-mcp-advanced" open={advancedOpen.has(id)} onToggle={event => toggleAdvanced(id, event.currentTarget.open)}><summary>{zh ? '高级设置' : 'Advanced settings'}</summary>
        <div className="plugin-mcp-options">
        <label><input type="checkbox" checked={settings.enabled !== false} onChange={event => change(component.id, { enabled: event.target.checked })} />{zh ? '启用' : 'Enabled'}</label>
        <label><input type="checkbox" checked={required} onChange={event => change(component.id, { required: event.target.checked })} />{zh ? '必需连接' : 'Required connection'}</label></div>
        {required && (needsConnection || missingBinding || settings.enabled === false) && <p role="alert">{zh ? '此插件需要这条连接。请先配置并启用服务，或明确取消“必需连接”。' : 'This plugin requires this connection. Configure and enable it, or explicitly make it optional.'}</p>}
        {component.mcp?.registeredAppId && <p><small>{hosted ? (zh ? '连接方式：OpenAI 账户。在下方授权页面使用同一个 OpenAI 账户，登录服务商并授予此应用所需权限。' : 'Connection source: OpenAI account. Use the same OpenAI account on the authorization page below, then sign in to the provider and grant this app access.') : bound
          ? (zh ? '连接方式：绑定已有 MCP 服务，使用该服务的认证配置。' : 'Connection source: existing MCP server, using its authentication settings.')
          : (zh ? '连接方式：服务商直连，使用独立的认证配置。要使用上方已登录的 OpenAI 账户，请将下面的连接方式改为“OpenAI 账户”并保存。' : 'Connection source: direct, with separate authentication. To use the OpenAI account above, select OpenAI account below and save.')}<br />{component.mcp.registeredAppId}</small></p>}
        <div className="mcp-fields">
          {registered && <label>{zh ? '连接方式' : 'Connection source'}<select value={hosted ? '__openai__' : String(settings.server ?? '')} onChange={event => {
            const isOpenAi = event.target.value === '__openai__';
            change(component.id, { provider: isOpenAi ? 'openai' : 'direct', server: isOpenAi ? undefined : event.target.value || undefined });
            if (isOpenAi) setSecrets(current => { const next = { ...current }; delete next[component.id]; return next; });
          }}>
            {component.mcp?.registeredAppId && <option value="__openai__">{zh ? 'OpenAI 账户（实验性）' : 'OpenAI account (experimental)'}</option>}
            <option value="">{component.kind === 'mcp' ? (zh ? '使用插件内置连接' : 'Use bundled connection') : (zh ? '使用下面的服务地址' : 'Use endpoint below')}</option>
            {bound && !binding && <option value={String(settings.server)}>{String(settings.server)}{zh ? '（不可用）' : ' (unavailable)'}</option>}
            {overview?.servers.map(server => <option key={server.id} value={server.id}>{server.name}{server.enabled ? '' : (zh ? '（已停用）' : ' (disabled)')}</option>)}</select></label>}
          {network && !bound && !hosted && <label>{zh ? 'MCP 服务地址' : 'MCP endpoint'}<input type="url" placeholder={component.mcp?.url || 'https://…/mcp'} value={String(connection.url ?? '')}
            onChange={event => change(component.id, { connection: { ...connection, url: event.target.value || undefined } })} /></label>}
          <label>{zh ? '默认工具审批' : 'Default tool approval'}<select value={String(settings.default_tools_approval_mode ?? 'prompt')} onChange={event => change(component.id, { default_tools_approval_mode: event.target.value })}>
            <option value="prompt">{zh ? '调用时询问' : 'Prompt'}</option><option value="approve">{zh ? '允许调用' : 'Approve'}</option></select></label>
          <label>{zh ? '只启用这些工具（逗号分隔，留空为全部）' : 'Enabled tools (comma separated; blank for all)'}<input value={Array.isArray(settings.enabled_tools) ? settings.enabled_tools.join(', ') : ''}
            onChange={event => change(component.id, { enabled_tools: event.target.value.trim() ? event.target.value.split(',').map(item => item.trim()).filter(Boolean) : undefined })} /></label>
        </div>
        {network && !hosted && <details><summary>{zh ? 'OAuth 高级配置' : 'OAuth options'}</summary><div className="mcp-fields">
          {[['clientId', 'client_id', zh ? '客户端 ID（可选）' : 'Client ID (optional)'], ['scopes', 'scopes', zh ? '请求权限（空格分隔）' : 'Scopes (space separated)'],
            ['callbackUrl', 'callback_url', zh ? '本机回调地址（可选）' : 'Loopback callback (optional)'], ['callbackPort', 'callback_port', zh ? '本机回调端口（可选）' : 'Loopback port (optional)'], ['resourceUrl', 'oauth_resource', zh ? 'OAuth 资源地址（可选）' : 'OAuth resource URL (optional)'], ['clientMetadataUrl', 'client_metadata_url', zh ? 'CIMD 文档地址（可选）' : 'CIMD document URL (optional)'],
            ['clientSecretEnv', 'client_secret_env', zh ? '客户端密钥环境变量名（高级）' : 'Client secret environment variable (advanced)']].map(([key, alias, label]) => {
            const value = oauth[key] ?? oauth[alias];
            return <label key={key}>{label}<input value={key === 'scopes' && Array.isArray(value) ? value.join(' ') : String(value ?? '')}
              type={key === 'callbackPort' ? 'number' : 'text'} min={key === 'callbackPort' ? 0 : undefined} max={key === 'callbackPort' ? 65535 : undefined}
              onChange={event => { const next = { ...oauth }; delete next[alias];
                next[key] = event.target.value ? key === 'scopes' ? event.target.value.trim().split(/\s+/) : key === 'callbackPort' ? Number(event.target.value) : event.target.value : undefined;
                if (key === 'clientSecretEnv' && event.target.value) { delete next.clientSecretRef; delete next.client_secret_ref; }
                change(component.id, { oauth: next }); }} /></label>;
          })}
          <label>{zh ? '客户端密钥' : 'Client secret'}<input type="password" autoComplete="off" disabled={Boolean(busy)} value={secrets[component.id] ?? ''}
            placeholder={(oauth.clientSecretRef || oauth.client_secret_ref) && secrets[component.id] !== null ? (zh ? '已加密保存；留空保持原值' : 'Encrypted secret saved; leave blank to keep') : (zh ? '输入后保存到本机加密存储' : 'Save in encrypted storage on this device')}
            onChange={event => { setSavedMessage(''); setSecrets(current => { const next = { ...current }; if (event.target.value) next[component.id] = event.target.value; else delete next[component.id]; return next; }); }} />
            <small>{zh ? '保存后无需重启应用。密钥不会写入会话或配置明文。' : 'No restart required. The secret stays out of conversation and plaintext configuration.'}</small>
            {Boolean(oauth.clientSecretRef || oauth.client_secret_ref) && <button type="button" disabled={Boolean(busy)} onClick={() => setSecrets(current => ({ ...current, [component.id]: null }))}>{secrets[component.id] === null ? (zh ? '保存后移除凭据引用' : 'Reference will be removed on save') : (zh ? '移除凭据引用' : 'Remove credential reference')}</button>}
          </label>
        </div></details>}
        {tools.length > 0 && <details><summary>{zh ? `${tools.length} 个工具的权限` : `Approval for ${tools.length} tools`}</summary>{tools.map(name => {
          const policies = record(settings.tools), policy = record(policies[name]);
          return <label className="plugin-mcp-tool" key={name}><code>{name}</code><select value={policy.enabled === false ? 'deny' : String(policy.approval_mode ?? 'default')}
            onChange={event => change(component.id, { tools: { ...policies, [name]: { ...policy, enabled: event.target.value !== 'deny', approval_mode: event.target.value === 'default' ? undefined : event.target.value } } })}>
            <option value="default">{zh ? '继承默认' : 'Default'}</option><option value="prompt">{zh ? '询问' : 'Prompt'}</option><option value="approve">{zh ? '允许' : 'Approve'}</option><option value="deny">{zh ? '停用' : 'Disable'}</option>
          </select></label>;
        })}</details>}
        {(actual?.lastError || overview?.snapshot?.applicationError) && <details className="plugin-mcp-error"><summary>{zh ? '连接详情' : 'Connection details'}</summary><p>{actual?.lastError || overview?.snapshot?.applicationError}</p></details>}
        <div className="plugin-mcp-actions">{hosted && authorizationUrl && <button type="button" disabled={Boolean(busy) || dirty || needsAccount} onClick={() => void authorizeApp(id, authorizationUrl)}>{zh ? '在 OpenAI 授权此应用' : 'Authorize this app through OpenAI'}</button>}
          {network && !hosted && <button type="button" disabled={Boolean(busy) || dirty || unavailable} onClick={() => void action(id, 'login')}>{signingIn ? (zh ? '等待浏览器登录…' : 'Waiting for sign-in…') : (zh ? '登录 / 重新授权' : 'Sign in / authorize')}</button>}
          {signingIn ? <button type="button" onClick={() => void window.cardbushDesktop!.mcpConnectionAction(id, 'cancel_login').catch(caught => setError(String(caught)))}>{zh ? '取消登录' : 'Cancel sign-in'}</button>
            : <button type="button" disabled={Boolean(busy) || dirty || unavailable || pending || connectionState === 'restarting'} onClick={() => void action(id, 'reconnect')}>{hosted ? (zh ? '检查授权与连接' : 'Check authorization and connection') : (zh ? '重新连接' : 'Reconnect')}</button>}
          {network && !hosted && <button type="button" disabled={Boolean(busy) || dirty || unavailable} onClick={() => void action(id, 'logout')}>{zh ? '退出登录' : 'Sign out'}</button>}</div></details>
      </div>;
    })}
    {dirty && <p role="status">{zh ? '连接配置有未保存的修改，请保存后再登录或连接。' : 'Save your connection changes before signing in or reconnecting.'}</p>}
    {error && <div role="alert" className="plugin-mcp-error"><p>{zh ? '操作未完成，请查看详情后重试。' : 'The action could not be completed. Check the details and try again.'}</p><details><summary>{zh ? '错误详情' : 'Error details'}</summary><p>{error}</p></details></div>}
    {savedMessage && <p role="status" className="plugin-mcp-hint">{savedMessage}</p>}
    {dirty && <div className="plugin-mcp-actions plugin-mcp-save"><button type="button" className="mcp-primary-action" disabled={Boolean(busy)} onClick={() => void save()}>{zh ? '保存连接配置' : 'Save connection settings'}</button>
      <button type="button" disabled={Boolean(busy)} onClick={() => { baseline.current = remote; setDraft(JSON.parse(remote)); setSecrets({}); setError(''); }}>{zh ? '重置修改' : 'Reset changes'}</button></div>}
  </section>;
}
function record(value: unknown): Json { return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}; }
