import { useEffect, useRef, useState } from 'react';
import { usesOpenAiHostedConnection } from '@cardbush/bush-protocol';
import { OpenAiAccountPanel } from './OpenAiAccountPanel';
import { fetchCardbushAppsConfiguration, fetchMcpConnectionOverview } from '../../backend/api';
import type { McpConnectionOverview } from '../../backend/mcpConnectionOverview';
import type { CardbushAppPlugin } from '../../types';
import './mcp-integration.css';

type Json = Record<string, unknown>;
export function PluginMcpSettings({ plugin, language, onSaved }: { plugin: CardbushAppPlugin; language: 'zh' | 'en'; onSaved: () => void }) {
  const zh = language === 'zh';
  const [draft, setDraft] = useState<Json>(() => record(plugin.config.mcp_servers));
  const [overview, setOverview] = useState<McpConnectionOverview | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [savedMessage, setSavedMessage] = useState('');
  const [secrets, setSecrets] = useState<Record<string, string | null>>({});
  const remote = JSON.stringify(record(plugin.config.mcp_servers));
  const baseline = useRef(remote);
  const refresh = async () => { const value = await fetchMcpConnectionOverview(); setOverview(value); };
  useEffect(() => { void refresh().catch(caught => setError(String(caught))); }, [plugin.id]);
  useEffect(() => { baseline.current = remote; setDraft(JSON.parse(remote)); setSecrets({}); setError(''); }, [plugin.id]);
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
  if (!services.length || ['chrome', 'computer-use'].includes(plugin.id)) return null;
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
      setSavedMessage(zh ? '配置已保存。正在运行的任务结束后生效。' : 'Saved. Active tasks defer application until they finish.');
      try { await refresh(); } catch (caught) { setError(current => current || String(caught)); }
    } catch (caught) { setError(String(caught)); } finally { setBusy(''); }
  };
  const action = async (id: string, action: 'login' | 'logout' | 'reconnect') => {
    setBusy(`${id}:${action}`); setError('');
    try { await window.cardbushDesktop!.mcpConnectionAction(id, action); }
    catch (caught) { setError(String(caught)); }
    finally {
      try { await refresh(); } catch (caught) { setError(current => current || String(caught)); }
      setBusy('');
    }
  };
  return <section className="plugin-detail-section plugin-mcp-settings"><h3>{zh ? '服务与工具' : 'Servers and tools'}</h3>
    {services.some(component => component.mcp?.registeredAppId) && <OpenAiAccountPanel language={language} onChanged={() => void refresh().catch(() => {})} />}
    {services.map(component => {
      const settings = record(draft[component.id]), connection = record(settings.connection), oauth = record(settings.oauth);
      const id = `plugin_${plugin.id.replaceAll('.', '_')}_${component.id}`;
      const actual = overview?.snapshot?.servers.find(server => server.id === id);
      const registered = Boolean(component.mcp?.registeredAppId) || component.kind === 'app';
      const hosted = usesOpenAiHostedConnection(component.mcp?.registeredAppId, settings);
      const bound = registered && Boolean(settings.server);
      const binding = bound ? overview?.servers.find(server => server.id === settings.server) : undefined;
      const missingBinding = bound && !binding?.enabled;
      const needsConnection = !hosted && !bound && component.kind === 'app' && !connection.url;
      const required = (settings.required ?? component.mcp?.required) === true;
      const status = overview?.snapshot?.applicationState === 'pending' ? (zh ? '等待生效' : 'Pending') : actual?.health === 'ready' ? (zh ? '已连接' : 'Connected') : actual?.health === 'auth_required' ? (zh ? '需要登录' : 'Sign-in required')
        : actual?.health === 'configuration_required' ? (zh ? '需要配置' : 'Configuration required') : settings.enabled === false ? (zh ? '已停用' : 'Disabled') : missingBinding ? (zh ? '绑定的服务不可用' : 'Bound service unavailable') : needsConnection ? (zh ? '需要绑定连接' : 'Connection required')
          : (zh ? '未连接' : 'Disconnected');
      const tools = [...new Set([...(actual?.tools.map(tool => tool.remoteName) ?? []), ...Object.keys(record(settings.tools))])];
      const transport = bound ? binding?.transport : component.mcp?.transport;
      const network = (!bound && component.kind === 'app') || ['http', 'streamable_http', 'sse'].includes(transport ?? '');
      const unavailable = !plugin.enabled || settings.enabled === false || missingBinding || Boolean(needsConnection);
      const signingIn = busy === `${id}:login`;
      return <div className="plugin-mcp-service" key={component.id}><header><strong>{component.name}</strong><span>{status}</span>
        <label><input type="checkbox" checked={settings.enabled !== false} onChange={event => change(component.id, { enabled: event.target.checked })} />{zh ? '启用' : 'Enabled'}</label>
        <label><input type="checkbox" checked={required} onChange={event => change(component.id, { required: event.target.checked })} />{zh ? '必需连接' : 'Required connection'}</label></header>
        {required && (needsConnection || missingBinding || settings.enabled === false) && <p role="alert">{zh ? '此插件需要这条连接。请先配置并启用服务，或明确取消“必需连接”。' : 'This plugin requires this connection. Configure and enable it, or explicitly make it optional.'}</p>}
        {component.mcp?.registeredAppId && <p><small>{hosted ? (zh ? '使用 OpenAI 账户中已授权的应用。可在上方登录或管理授权。' : 'Uses the app authorized in your OpenAI account. Sign in or manage authorization above.') : component.kind === 'mcp'
          ? (zh ? '此包已提供 MCP 连接，默认使用包内配置；也可绑定已有服务。' : 'This package includes an MCP connection, used by default. You can also bind an existing service.')
          : (zh ? '此包引用 OpenAI 注册连接。请选择本机 MCP 服务或填写服务商提供的地址；CardBush 独立登录。' : 'This package references an OpenAI registration. Choose a local MCP connection or enter the provider endpoint and sign in with CardBush.')}<br />{component.mcp.registeredAppId}</small></p>}
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
        {actual?.lastError && <p><small>{actual.lastError}</small></p>}
        <div className="plugin-mcp-actions">{network && !hosted && <button type="button" disabled={Boolean(busy) || dirty || unavailable} onClick={() => void action(id, 'login')}>{signingIn ? (zh ? '等待浏览器登录…' : 'Waiting for sign-in…') : (zh ? '登录 / 重新授权' : 'Sign in / authorize')}</button>}
          {signingIn ? <button type="button" onClick={() => void window.cardbushDesktop!.mcpConnectionAction(id, 'cancel_login').catch(caught => setError(String(caught)))}>{zh ? '取消登录' : 'Cancel sign-in'}</button>
            : <button type="button" disabled={Boolean(busy) || dirty || unavailable} onClick={() => void action(id, 'reconnect')}>{zh ? '重新连接' : 'Reconnect'}</button>}
          {network && !hosted && <button type="button" disabled={Boolean(busy) || dirty || unavailable} onClick={() => void action(id, 'logout')}>{zh ? '退出登录' : 'Sign out'}</button>}</div>
      </div>;
    })}
    {dirty && <p role="status">{zh ? '连接配置有未保存的修改，请保存后再登录或连接。' : 'Save your connection changes before signing in or reconnecting.'}</p>}
    {error && <p role="alert" className="plugin-hub-error">{error}</p>}{savedMessage && <p role="status">{savedMessage}</p>}
    <div className="plugin-mcp-actions"><button type="button" disabled={Boolean(busy)} onClick={() => void save()}>{zh ? '保存连接配置' : 'Save connection settings'}</button>
      {dirty && <button type="button" disabled={Boolean(busy)} onClick={() => { baseline.current = remote; setDraft(JSON.parse(remote)); setSecrets({}); setError(''); }}>{zh ? '重置修改' : 'Reset changes'}</button>}
      <button type="button" disabled={Boolean(busy)} onClick={() => void refresh().catch(caught => setError(String(caught)))}>{zh ? '刷新连接状态' : 'Refresh status'}</button></div>
  </section>;
}
function record(value: unknown): Json { return value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}; }
