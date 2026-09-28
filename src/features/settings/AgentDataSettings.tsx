import { useCallback, useEffect, useState } from 'react';
import type { AgentConnection, AgentInfo, AgentProject } from '../../../electron/agentTypes';
import type { AppLanguage, BackendCapabilities } from '../../types';
import type { AgentCall } from '../agents/agentConversationBackend';
import { agentErrorText } from '../agents/agentErrorText';
import { CacheMaintenancePanel } from '../SettingsView';
import { AgentArchivesPanel } from './AgentArchivesPanel';
import { SettingsCard, SettingsInput } from './SettingsControls';

/** Execution data stays on its host even though configuration has one shared source. */
export function AgentDataSettings({ connection, language, onNotify }: {
  connection: AgentConnection; language: AppLanguage; onNotify: (message: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return <details className="settings-agent-data" data-agent-data={connection.id} onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>{connection.name} · {language === 'zh' ? '项目与数据' : 'Projects and data'}</summary>
    {expanded && <AgentDataContent connection={connection} language={language} onNotify={onNotify}/>}
  </details>;
}

function AgentDataContent({ connection, language, onNotify }: Parameters<typeof AgentDataSettings>[0]) {
  const [info, setInfo] = useState<AgentInfo>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const call = useCallback<AgentCall>(async (operation, input) => {
    const result = await window.cardbushDesktop!.agents!.call(connection.id, operation, input);
    if (['projects.save', 'projects.remove', 'projects.default'].includes(operation) || operation === 'product.command' && String(input?.kind).startsWith('maintenance.')) {
      window.dispatchEvent(new CustomEvent('cardbush:agent-sessions-updated', { detail: connection.id }));
    }
    return result as never;
  }, [connection.id]);
  useEffect(() => {
    let alive = true; setError('');
    void window.cardbushDesktop!.agents!.connect(connection.id).then(value => { if (alive) setInfo(value); }, error => { if (alive) setError(agentErrorText(error)); });
    return () => { alive = false; };
  }, [connection.id, retry]);
  const zh = language === 'zh';
  if (error) return <p role="alert">{error}<button className="secondary-button" onClick={() => setRetry(value => value + 1)}>{zh ? '重试' : 'Retry'}</button></p>;
  if (!info) return <p role="status">{zh ? '正在连接 Agent…' : 'Connecting to Agent…'}</p>;
  const capabilities = { maintenanceConversationHistoryClear: true, maintenanceLogsCacheClear: true } as BackendCapabilities;
  return <div className="settings-stack">
    {info.capabilities.conversationManagement && <AgentArchivesPanel call={call} connectionId={connection.id} language={language} onNotify={onNotify}/>}
    {info.capabilities.projects && <AgentProjects call={call} language={language}/>}
    <CacheMaintenancePanel language={language} capabilities={capabilities} runtimeBusy={false} onNotify={onNotify} scopeName={connection.name}
      clear={target => call('product.command', { kind: target === 'conversation' ? 'maintenance.clear_conversations' : target === 'logs' ? 'maintenance.clear_logs_cache' : 'maintenance.clear_cache' })}/>
  </div>;
}

function AgentProjects({ call, language }: { call: AgentCall; language: AppLanguage }) {
  const zh = language === 'zh';
  const [projects, setProjects] = useState<{ projects: AgentProject[]; defaultProjectId: string | null }>({ projects: [], defaultProjectId: null });
  const [name, setName] = useState(''); const [path, setPath] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => setProjects(await call('projects.list')), [call]);
  useEffect(() => { let alive = true; void call<typeof projects>('projects.list').then(value => { if (alive) setProjects(value); }, error => { if (alive) setError(agentErrorText(error)); }); return () => { alive = false; }; }, [call]);
  async function act(fn: () => Promise<unknown>) { if (busy) return; setBusy(true); setError(''); try { await fn(); await refresh(); } catch (error) { setError(agentErrorText(error)); } finally { setBusy(false); } }
  return <SettingsCard title={zh ? '绑定项目' : 'Projects'}>
    {error && <p role="alert">{error}</p>}{projects.projects.map(project => <div className="settings-project-row" key={project.id}><div><strong>{project.name}</strong><small>{project.path}</small></div>
      <button disabled={busy || project.id === projects.defaultProjectId} onClick={() => void act(() => call('projects.default', { id: project.id }))}>{project.id === projects.defaultProjectId ? zh ? '默认' : 'Default' : zh ? '设为默认' : 'Make default'}</button>
      <button disabled={busy} onClick={() => void act(() => call('projects.remove', { id: project.id }))}>{zh ? '移除' : 'Remove'}</button></div>)}
    <form className="settings-stack" onSubmit={event => { event.preventDefault(); void act(async () => { await call('projects.save', { name: name.trim(), path: path.trim() }); setName(''); setPath(''); }); }}>
      <SettingsInput label={zh ? '项目名称' : 'Project name'} value={name} onChange={setName}/><SettingsInput label={zh ? 'Agent 主机上的目录' : 'Directory on the Agent host'} value={path} onChange={setPath}/>
      <button className="secondary-button" disabled={busy || !name.trim() || !path.trim()}>{zh ? '添加项目' : 'Add project'}</button></form>
  </SettingsCard>;
}
