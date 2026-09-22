import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentConnection, AgentProject } from '../../../electron/agentTypes';
import { copyText } from '../messageFeedback';
import { projectRuntimeTurnMessages } from '../../backend/runtimeSessionMessageProjection';
import { agentErrorText as message } from './agentErrorText';

export type AgentSessionItem = { sessionId: string; metadata?: Record<string, unknown>; updatedAt?: string };
type SessionList = { sessions: AgentSessionItem[]; management?: boolean; projects?: AgentProject[]; loading?: boolean; creating?: boolean; error?: string };
const api = () => { const value = window.cardbushDesktop?.agents; if (!value) throw new Error('Agent connections are unavailable.'); return value; };

export function useAgentConnections() {
  const [connections, setConnections] = useState<AgentConnection[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [error, setError] = useState('');
  const [sessionsByAgent, setSessionsByAgent] = useState<Record<string, SessionList>>({});
  const [selectedSessions, setSelectedSessions] = useState<Record<string, string>>({});
  const [views, setViews] = useState<Record<string, 'chat' | 'settings'>>({});
  const loads = useRef(new Map<string, Promise<void>>());
  const creates = useRef(new Set<string>());
  const selectionRevision = useRef(new Map<string, number>());
  const updateList = useCallback((id: string, patch: Partial<SessionList>) => {
    setSessionsByAgent(current => ({ ...current, [id]: { ...(current[id] ?? { sessions: [] }), ...patch } }));
  }, []);
  const refreshSessions = useCallback((id: string): Promise<void> => {
    const pending = loads.current.get(id);
    if (pending) return pending;
    updateList(id, { loading: true, error: '' });
    const load = (async () => {
      try {
        const info = await api().connect(id);
        const sessions = await api().call(id, 'sessions.list') as AgentSessionItem[];
        const projects = info.capabilities.conversationManagement ? await api().call(id, 'projects.list') as { projects: AgentProject[] } : undefined;
        updateList(id, { sessions: sessions.filter(item => item.metadata?.hidden !== true), loading: false, management: Boolean(info.capabilities.conversationManagement), projects: projects?.projects });
      } catch (error) { updateList(id, { loading: false, error: message(error) }); throw error; }
      finally { loads.current.delete(id); }
    })();
    loads.current.set(id, load);
    return load;
  }, [updateList]);
  const select = useCallback((id: string, sessionId?: string, view: 'chat' | 'settings' = 'chat') => {
    selectionRevision.current.set(id, (selectionRevision.current.get(id) ?? 0) + 1);
    setSelectedId(id);
    if (sessionId !== undefined) setSelectedSessions(current => ({ ...current, [id]: sessionId }));
    setViews(current => ({ ...current, [id]: view }));
  }, []);
  const createSession = useCallback(async (id: string, title: string) => {
    if (creates.current.has(id)) return;
    const revision = selectionRevision.current.get(id);
    creates.current.add(id); updateList(id, { creating: true, error: '' });
    try {
      await api().connect(id);
      const session = await api().call(id, 'sessions.create', { title }) as AgentSessionItem;
      // Finish any older list read before refreshing the newly created session.
      await loads.current.get(id)?.catch(() => undefined);
      if (selectionRevision.current.get(id) === revision) {
        setSelectedSessions(current => ({ ...current, [id]: session.sessionId }));
        setViews(current => ({ ...current, [id]: 'chat' }));
      }
      await refreshSessions(id);
    } catch (error) { updateList(id, { error: message(error) }); }
    finally { creates.current.delete(id); updateList(id, { creating: false }); }
  }, [refreshSessions, updateList]);
  const renameSession = useCallback(async (id: string, sessionId: string, title: string) => {
    try {
      await api().call(id, 'sessions.rename', { sessionId, title });
      await loads.current.get(id)?.catch(() => undefined);
      await refreshSessions(id);
      return true;
    } catch (error) { updateList(id, { error: message(error) }); return false; }
  }, [refreshSessions, updateList]);
  const deleteSession = useCallback(async (id: string, sessionId: string) => {
    try {
      await api().call(id, 'sessions.delete', { sessionId });
      setSelectedSessions(current => current[id] === sessionId ? { ...current, [id]: '' } : current);
      sessionStorage.removeItem(`cardbush-agent-draft:${id}:${sessionId}`);
      sessionStorage.removeItem(`cardbush-agent-draft:${id}:${sessionId}:submission`);
      await loads.current.get(id)?.catch(() => undefined);
      await refreshSessions(id);
    } catch (error) { updateList(id, { error: message(error) }); }
  }, [refreshSessions, updateList]);
  const updateSession = useCallback(async (id: string, sessionId: string, patch: Record<string, unknown>) => {
    try {
      await api().call(id, 'sessions.update', { sessionId, ...patch });
      await loads.current.get(id)?.catch(() => undefined); await refreshSessions(id);
    } catch (error) { updateList(id, { error: message(error) }); }
  }, [refreshSessions, updateList]);
  const forkSession = useCallback(async (id: string, sessionId: string) => {
    try {
      const session = await api().call(id, 'sessions.fork', { sessionId }) as AgentSessionItem;
      await loads.current.get(id)?.catch(() => undefined); await refreshSessions(id);
      select(id, session.sessionId);
    } catch (error) { updateList(id, { error: message(error) }); }
  }, [refreshSessions, updateList, select]);
  const bindSession = useCallback(async (id: string, sessionId: string, projectId: string | null) => {
    try {
      await api().call(id, 'sessions.bind', { sessionId, projectId });
      await loads.current.get(id)?.catch(() => undefined); await refreshSessions(id);
      // Remount the selected chat to reload its workspace and scoped file services.
      window.dispatchEvent(new CustomEvent('cardbush:agent-session-updated', { detail: { connectionId: id, sessionId } }));
    } catch (error) { updateList(id, { error: message(error) }); }
  }, [refreshSessions, updateList]);
  const copySession = useCallback(async (id: string, sessionId: string) => {
    try {
      const snapshot = await api().call(id, 'sessions.get', { sessionId }) as import('@cardbush/bush-protocol').SessionSnapshot;
      const messages = snapshot.turns.flatMap(turn => projectRuntimeTurnMessages(turn, sessionId)).filter(item => !snapshot.supersededMessageIds?.includes(item.id) && ['user', 'assistant'].includes(item.role));
      await copyText(messages.map(item => `${item.role === 'user' ? 'User' : 'Assistant'}:\n${item.content}`).join('\n\n'));
    } catch (error) { updateList(id, { error: message(error) }); }
  }, [updateList]);
  const refresh = useCallback(async () => {
    try { setConnections(await window.cardbushDesktop?.agents?.list() ?? []); setError(''); }
    catch (error) { setError(message(error)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  return { connections, selectedId, select, error, refresh, sessionsByAgent, selectedSessions, views, refreshSessions, createSession, renameSession, deleteSession, updateSession, forkSession, bindSession, copySession };
}

export type AgentConnectionsController = ReturnType<typeof useAgentConnections>;
