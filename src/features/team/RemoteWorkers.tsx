import { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCw, Settings2 } from 'lucide-react';
import { supportsRemoteInteraction } from '@cardbush/bush-protocol';
import type { AgentConnection, AgentConnectionInput } from '../../../electron/agentTypes';
import { uiText } from '../../i18n';
import { AgentConnectionForm } from '../agents/AgentConnectionForm';
import { agentErrorText } from '../agents/agentErrorText';
import '../agents/agents.css';

export function canRegisterWorker(connection: AgentConnection): boolean {
  return Boolean(connection.hasToken && connection.agentId && !connection.migrationIssue
    && connection.info?.capabilities.delegation && supportsRemoteInteraction(connection.info.capabilities.workerInteraction));
}

export function useWorkerConnections() {
  const [connections, setConnections] = useState<AgentConnection[]>([]);
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    try { setConnections(await window.cardbushDesktop?.agents?.list() ?? []); setError(''); }
    catch (failure) { setError(agentErrorText(failure)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { connections, error, refresh };
}

/** Connections are registration candidates. This surface never opens a remote chat. */
export function RemoteWorkers({ language, connections, refresh, onRegister }: {
  language: string; connections: AgentConnection[]; refresh(): Promise<void>; onRegister(connection: AgentConnection): void;
}) {
  const [editing, setEditing] = useState<AgentConnection | null | undefined>();
  const [error, setError] = useState(''), [busy, setBusy] = useState('');
  const api = () => { const value = window.cardbushDesktop?.agents; if (!value) throw Error(uiText(language)('agentsView.agent_connections_are_unavailable')); return value; };
  const verify = async (id: string) => {
    const info = await api().connect(id);
    await refresh();
    if (!info.capabilities.delegation || !supportsRemoteInteraction(info.capabilities.workerInteraction)) throw Error(uiText(language)('remoteWorkers.unavailable'));
  };
  const save = async (input: AgentConnectionInput) => {
    const before = new Set(connections.map(item => item.id));
    const saved = await api().save(input);
    await refresh();
    const target = input.id ? saved.find(item => item.id === input.id) : saved.find(item => !before.has(item.id) && item.name === input.name.trim());
    if (!target) throw Error(uiText(language)('remoteWorkers.unavailable'));
    // Keep the saved identity when verification fails, so retry edits the same record.
    setEditing(target);
    await verify(target.id);
    setEditing(undefined);
  };
  return <section className="remote-workers" aria-label={uiText(language)('remoteWorkers.title')}>
    <header><h2>{uiText(language)('remoteWorkers.title')}</h2><button type="button" onClick={() => setEditing(null)}><Plus size={16}/>{uiText(language)('remoteWorkers.add')}</button></header>
    <p>{uiText(language)('remoteWorkers.description')}</p>
    {error && <p role="alert">{error}</p>}
    {!connections.length && <p>{uiText(language)('remoteWorkers.empty')}</p>}
    {connections.map(connection => <article key={connection.id}>
      <div><strong>{connection.name}</strong><small>{canRegisterWorker(connection) ? uiText(language)('remoteWorkers.verified') : uiText(language)('remoteWorkers.notVerified')}</small></div>
      <button type="button" disabled={!canRegisterWorker(connection)} onClick={() => onRegister(connection)}>{uiText(language)('remoteWorkers.registerRole')}</button>
      <button type="button" disabled={busy === connection.id} aria-label={uiText(language)('remoteWorkers.test')} title={uiText(language)('remoteWorkers.test')} onClick={() => {
        setBusy(connection.id); setError(''); void verify(connection.id).catch(failure => setError(agentErrorText(failure))).finally(() => setBusy(''));
      }}><RefreshCw size={16}/></button>
      <button type="button" aria-label={uiText(language)('remoteWorkers.configure')} title={uiText(language)('remoteWorkers.configure')} onClick={() => setEditing(connection)}><Settings2 size={16}/></button>
    </article>)}
    {editing !== undefined && <AgentConnectionForm language={language} initial={editing ?? undefined} onClose={() => setEditing(undefined)} onSave={save}
      onRemove={editing ? async () => { await api().remove(editing.id); await refresh(); setEditing(undefined); } : undefined}/>}
  </section>;
}
