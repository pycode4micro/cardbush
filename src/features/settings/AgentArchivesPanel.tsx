import { useEffect, useState } from 'react';
import type { AgentProject } from '../../../electron/agentTypes';
import type { AppLanguage, ConversationSummary } from '../../types';
import { isVisibleConversationSession } from '../../backend/runtimeSessionVisibility';
import type { AgentCall } from '../agents/agentConversationBackend';
import type { AgentSessionItem } from '../agents/useAgentConnections';
import { agentErrorText } from '../agents/agentErrorText';
import { ArchivedItemsManager } from './ArchivedItemsPanel';
import { SettingsCard } from './SettingsControls';

export function AgentArchivesPanel({ call, connectionId, language, onNotify }: {
  call: AgentCall; connectionId: string; language: AppLanguage; onNotify: (message: string) => void;
}) {
  const [data, setData] = useState<{ sessions: AgentSessionItem[]; projects: AgentProject[] }>();
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const zh = language === 'zh';
  useEffect(() => {
    const updated = (event: Event) => {
      if ((event as CustomEvent<string>).detail === connectionId) setRetry(value => value + 1);
    };
    window.addEventListener('cardbush:agent-settings-updated', updated);
    return () => window.removeEventListener('cardbush:agent-settings-updated', updated);
  }, [connectionId]);
  useEffect(() => {
    let alive = true; setData(undefined); setError('');
    void Promise.all([call<AgentSessionItem[]>('sessions.list'), call<{ projects: AgentProject[] }>('projects.list')])
      .then(([sessions, { projects }]) => { if (alive) setData({ sessions, projects }); }, error => { if (alive) setError(agentErrorText(error)); });
    return () => { alive = false; };
  }, [call, retry]);

  async function restore(ids: string[]) {
    let changed = false;
    try {
      for (const sessionId of ids) {
        await call('sessions.update', { sessionId, archived: false });
        changed = true;
        setData(current => current && { ...current, sessions: current.sessions.filter(item => item.sessionId !== sessionId) });
      }
    } catch (error) { throw new Error(agentErrorText(error)); }
    finally {
      if (changed) window.dispatchEvent(new CustomEvent('cardbush:agent-sessions-updated', { detail: connectionId }));
    }
  }

  if (!data) return <SettingsCard title={zh ? '归档管理' : 'Archived items'}>
    {error ? <p role="alert" className="settings-inline-error">{error}<button className="secondary-button" onClick={() => setRetry(value => value + 1)}>{zh ? '重试' : 'Retry'}</button></p>
      : <p role="status">{zh ? '正在加载归档…' : 'Loading archives…'}</p>}
  </SettingsCard>;
  const conversations: ConversationSummary[] = data.sessions.filter(session => isVisibleConversationSession(session) && session.metadata?.archived === true)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .map(session => ({ id: session.sessionId, title: String(session.metadata?.title || (zh ? '新对话' : 'Conversation')), preview: '', updatedAt: session.updatedAt ?? '',
      projectId: typeof session.metadata?.projectId === 'string' ? session.metadata.projectId : undefined }));
  return <ArchivedItemsManager language={language} conversations={conversations}
    projects={data.projects.map(project => ({ id: project.id, title: project.name, rootPath: project.path }))}
    showProjects={false} onRestoreConversations={restore} onNotify={onNotify}/>;
}
