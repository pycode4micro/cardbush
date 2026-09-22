import { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw, X } from 'lucide-react';
import type { McpSnapshotResult } from '@cardbush/bush-protocol';
import type { AgentOperation } from '../../../electron/agentTypes';
import type { AppLanguage } from '../../types';

type State = { configuration: { servers: Array<{ id: string; name: string; enabled: boolean; transport: string }> }; runtime: McpSnapshotResult | null; runtimeError?: string };
export function AgentMcpSettings({ call, language }: { call: <T = unknown>(operation: AgentOperation, input?: Record<string, unknown>) => Promise<T>; language: AppLanguage }) {
  const zh = language === 'zh';
  const [state, setState] = useState<State | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [name, setName] = useState(''); const [transport, setTransport] = useState('streamable_http');
  const [endpoint, setEndpoint] = useState(''); const [args, setArgs] = useState(''); const [token, setToken] = useState('');
  const refresh = useCallback(async () => { setState(await call<State>('mcp.list')); }, [call]);
  useEffect(() => { void refresh().catch(error => setError(String(error))); }, [refresh]);
  const act = async (operation: AgentOperation, input: Record<string, unknown>) => {
    setBusy(true); setError('');
    try { await call(operation, input); await refresh(); return true; }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); return false; }
    finally { setBusy(false); }
  };
  return <section className="agent-mcp-settings"><h3>{zh ? 'MCP 服务与工具' : 'MCP services and tools'}</h3>
    <button onClick={() => void refresh().catch(error => setError(String(error)))}><RefreshCw size={14}/>{zh ? '刷新状态' : 'Refresh status'}</button>
    {state?.runtime?.applicationState === 'pending' && <p>{zh ? '配置已保存，等待正在运行的任务结束后应用。' : 'Saved; changes apply after running tasks finish.'}</p>}
    {(error || state?.runtimeError || state?.runtime?.applicationError) && <p className="agents-error" role="alert">{error || state?.runtimeError || state?.runtime?.applicationError}</p>}
    {state?.configuration.servers.map(server => {
      const runtime = state.runtime?.servers.find(item => item.id === server.id);
      return <div className="agent-settings-row" key={server.id}><div><strong>{server.name}</strong><small>{server.transport} · {runtime?.health ?? (server.enabled ? zh ? '等待连接' : 'Pending' : zh ? '已禁用' : 'Disabled')} · {runtime?.tools.length ?? 0} {zh ? '项工具' : 'tools'}</small>{runtime?.lastError && <small>{runtime.lastError}</small>}</div><button disabled={busy} onClick={() => void act('mcp.reconnect', { id: server.id })}>{zh ? '重新连接' : 'Reconnect'}</button><button disabled={busy} aria-label={zh ? `移除服务 ${server.name}` : `Remove service ${server.name}`} onClick={() => void act('mcp.remove', { id: server.id })}><X size={14}/></button></div>;
    })}
    <details><summary>{zh ? '添加 MCP 连接' : 'Add MCP connection'}</summary><form className="agents-form" onSubmit={event => {
      event.preventDefault();
      void act('mcp.configure', { id: `service-${crypto.randomUUID().slice(0, 8)}`, name, enabled: true, transport,
        ...(transport === 'stdio' ? { command: endpoint, args: args.split('\n').map(value => value.trim()).filter(Boolean) }
          : { url: endpoint, auth: 'none', ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) }),
      }).then(saved => { if (saved) { setName(''); setEndpoint(''); setArgs(''); setToken(''); } });
    }}><label>{zh ? '服务名称' : 'Service name'}<input required value={name} onChange={event => setName(event.target.value)}/></label>
      <label>{zh ? '连接方式' : 'Transport'}<select value={transport} onChange={event => { setTransport(event.target.value); setEndpoint(''); }}><option value="streamable_http">Streamable HTTP</option><option value="stdio">stdio</option><option value="sse">SSE</option></select></label>
      <label>{transport === 'stdio' ? zh ? '服务器上的启动程序' : 'Executable on the server' : zh ? 'MCP 地址' : 'MCP endpoint'}<input required value={endpoint} onChange={event => setEndpoint(event.target.value)}/></label>
      {transport === 'stdio' ? <label>{zh ? '参数（每行一个）' : 'Arguments (one per line)'}<textarea value={args} onChange={event => setArgs(event.target.value)}/></label> : <label>{zh ? 'Bearer 令牌（可选）' : 'Bearer token (optional)'}<input type="password" autoComplete="off" value={token} onChange={event => setToken(event.target.value)}/></label>}
      <button disabled={busy}><Plus size={14}/>{zh ? '保存连接' : 'Save connection'}</button>
    </form></details>
  </section>;
}
