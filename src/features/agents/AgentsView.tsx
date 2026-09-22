import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Folder, LoaderCircle, Plus, RefreshCw, Server, Settings, Square, Trash2, Unplug, X } from 'lucide-react';
import type { RuntimeEvent, SessionSnapshot, RuntimeSolutionSelection, RuntimePermissionRequest } from '@cardbush/bush-protocol';
import type { AgentConnection, AgentConnectionInput, AgentInfo, AgentJob, AgentOperation, AgentProject } from '../../../electron/agentTypes';
import type { AppLanguage, PermissionMode, ReasoningLevel, ReferencePlanMode, SubagentPermissionRouting } from '../../types';
import './agents.css';
import { AgentMcpSettings } from './AgentMcpSettings';
import type { AgentConnectionsController } from './useAgentConnections';
import { TopBar } from '../../components/TopBar';
import { Composer } from '../composer/Composer';
import { ComposerReferenceContext } from '../composer/ComposerReferenceContext';
import { ConversationExtractionContext } from '../chat/ConversationExtraction';
import { ConversationHostContext } from '../conversationHost';
import { AgentInteractions, AgentSubagents } from './AgentConversationUi';
import { AgentTranscript } from './AgentTranscript';
import { useAgentConversationHost } from './useAgentConversationHost';
import { SettingsDropdown } from '../settings/SettingsDropdown';
import { appendReviewCommentsToDraft } from '../sidebar/reviewCommentModel';
import { agentErrorText as errorText } from './agentErrorText';

type Call = <T = unknown>(operation: AgentOperation, input?: Record<string, unknown>) => Promise<T>;
type Job = Omit<AgentJob, 'input'> & { text: string; modelId: string };
type Models = { defaultModelId: string; models: Array<{ id: string; provider: string; modelName: string; apiKey: string; hasApiKey?: boolean; baseUrl: string; maxContextTokens?: number; maxCompletionTokens?: number }> };
type Projects = { projects: AgentProject[]; defaultProjectId: string | null };
const api = () => { const value = window.cardbushDesktop?.agents; if (!value) throw new Error('Agent connections are unavailable.'); return value; };

export function AgentsView({ language, agents }: {
  language: AppLanguage; agents: AgentConnectionsController;
}) {
  const { connections, selectedId, select: onSelect, refresh: onRefresh } = agents;
  const zh = language === 'zh';
  const [adding, setAdding] = useState(false);
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [connectedId, setConnectedId] = useState('');
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [reconnect, setReconnect] = useState(0);
  const selected = connections.find(item => item.id === selectedId);
  useEffect(() => {
    let alive = true; setInfo(null); setConnectedId(''); setError('');
    if (!selectedId) { setConnecting(false); return; }
    setConnecting(true);
    void api().connect(selectedId).then(info => { if (alive) { setInfo(info); setConnectedId(selectedId); void onRefresh(); } }, error => { if (alive) setError(errorText(error)); })
      .finally(() => { if (alive) setConnecting(false); });
    return () => { alive = false; }; // Leaving this view does not disconnect or stop remote work.
  }, [selectedId, reconnect, onRefresh]);
  return <div className="agents-view">
    {(!selected || !info || connectedId !== selectedId) && <TopBar title={selected?.name || 'Agents'} language={language} inspectorOpen={false}
      workspaceControl={<button className="agents-add" onClick={() => setAdding(true)}><Plus size={16}/>{zh ? '添加 Agent' : 'Add Agent'}</button>}/>}
    {!selected && <div className="agents-overview"><h2>{zh ? '让每个 Agent 专注自己的工作' : 'A workspace for every Agent'}</h2><p>{zh ? '连接后直接对话。项目、模型、插件和历史记录由各个 Agent 分别管理。' : 'Chat directly after connecting. Each Agent owns its projects, models, plugins and history.'}</p>
      <div className="agents-cards">{connections.map(item => <button key={item.id} className="agents-card" onClick={() => onSelect(item.id)}><Server size={24}/><strong>{item.name}</strong><span>{item.migrationIssue || item.url}</span></button>)}
      <button className="agents-card" onClick={() => setAdding(true)}><Plus size={24}/><strong>{zh ? '添加连接' : 'Add connection'}</strong><span>HTTP / HTTPS</span></button></div></div>}
    {connecting && <div className="agents-empty"><LoaderCircle className="spin"/>{zh ? '正在连接 Agent…' : 'Connecting…'}</div>}
    {error && <div className="agents-error" role="alert">{error}<button onClick={() => setReconnect(value => value + 1)}>{zh ? '重试' : 'Retry'}</button>{selected && <button onClick={() => void api().remove(selected.id).then(async () => { onSelect(''); await onRefresh(); }).catch(error => setError(errorText(error)))}>{zh ? '移除此连接' : 'Remove connection'}</button>}</div>}
    {selected && info && connectedId === selectedId && <AgentWorkspace key={selected.id} connection={selected} info={info} language={language} agents={agents}
      onReconnect={() => { void api().disconnect(selectedId).then(() => setReconnect(value => value + 1)).catch(error => setError(errorText(error))); }}
      onRemove={async () => { await api().remove(selected.id); onSelect(''); await onRefresh(); }}/>}
    {adding && <ConnectionForm language={language} onClose={() => setAdding(false)} onSave={async input => {
      const next = await api().save(input); await onRefresh(); setAdding(false); onSelect(next.at(-1)!.id);
    }}/>}
  </div>;
}

function ConnectionForm({ language, onClose, onSave }: { language: AppLanguage; onClose: () => void; onSave: (value: AgentConnectionInput) => Promise<void> }) {
  const zh = language === 'zh';
  const [name, setName] = useState(''); const [url, setUrl] = useState(''); const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await onSave({ name, transport: 'http', url, token }); }
    catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  return <div className="agents-modal-backdrop"><form className="agents-modal agents-form" role="dialog" aria-modal="true" aria-label={zh ? '添加 Agent' : 'Add Agent'} onSubmit={submit}>
    <header><h2>{zh ? '添加 Agent' : 'Add Agent'}</h2><button type="button" onClick={onClose} aria-label={zh ? '关闭' : 'Close'}><X size={18}/></button></header>
    <label>{zh ? '名称' : 'Name'}<input autoFocus required value={name} onChange={event => setName(event.target.value)} placeholder="Agent A"/></label>
    <label>{zh ? '服务地址' : 'Service address'}<input required type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://agent.example.com"/></label>
    <label>{zh ? '访问令牌' : 'Access token'}<input type="password" required autoComplete="off" value={token} onChange={event => setToken(event.target.value)}/></label>
    <p>{zh ? '填写 Agent 的 HTTP(S) 地址和 access-token。本机服务可使用 http://127.0.0.1:4780，远程使用 HTTPS；通过 SSH 隧道接入时，需先在本机启动并保持隧道运行。' : 'Enter the Agent HTTP(S) address and access-token. Use http://127.0.0.1:4780 locally or HTTPS remotely. For an SSH tunnel, start it on this computer and keep it running.'}</p>
    {error && <p className="agents-error" role="alert">{error}</p>}<footer><button type="button" onClick={onClose}>{zh ? '取消' : 'Cancel'}</button><button className="agents-primary" disabled={busy}>{busy ? <LoaderCircle className="spin" size={16}/> : <Plus size={16}/>} {zh ? '保存并连接' : 'Save and connect'}</button></footer>
  </form></div>;
}

function AgentWorkspace({ connection, info, language, agents, onReconnect, onRemove }: { connection: AgentConnection; info: AgentInfo; language: AppLanguage; agents: AgentConnectionsController; onReconnect: () => void; onRemove: () => Promise<void> }) {
  const zh = language === 'zh';
  const call = useCallback<Call>(async (operation, input) => await api().call(connection.id, operation, input) as never, [connection.id]);
  const { refreshSessions } = agents;
  const sessionId = agents.selectedSessions[connection.id] ?? '';
  const sessions = agents.sessionsByAgent[connection.id]?.sessions ?? [];
  const [models, setModels] = useState<Models>({ defaultModelId: '', models: [] });
  const [projects, setProjects] = useState<Projects>({ projects: [], defaultProjectId: null });
  const [settingsReady, setSettingsReady] = useState(false);
  const tab = agents.views[connection.id] ?? 'chat';
  const [error, setError] = useState('');
  const creating = agents.sessionsByAgent[connection.id]?.creating;
  const refresh = useCallback(async () => {
    const [models, projects] = await Promise.all([call<Models>('product.command', { kind: 'models.get' }), call<Projects>('projects.list'), refreshSessions(connection.id)]);
    setModels(models); setProjects(projects); setSettingsReady(true); setError('');
  }, [call, connection.id, refreshSessions]);
  useEffect(() => { let alive = true; void refresh().catch(error => { if (alive) setError(errorText(error)); }); return () => { alive = false; }; }, [refresh]);
  const create = () => agents.createSession(connection.id, zh ? '新对话' : 'New conversation');
  const manage = () => agents.select(connection.id, undefined, tab === 'settings' ? 'chat' : 'settings');
  const title = tab === 'settings' ? connection.name : String(sessions.find(item => item.sessionId === sessionId)?.metadata?.title || connection.name);
  return <div className="agent-workspace">
    <TopBar title={title} language={language} inspectorOpen={false} workspaceControl={<div className="agent-header-actions">
      <button className="topbar-inspector-action icon-only" title={zh ? '刷新连接' : 'Refresh connection'} aria-label={zh ? '刷新连接' : 'Refresh connection'} onClick={onReconnect}><RefreshCw size={15}/></button>
      <button className="topbar-inspector-action icon-only" title={zh ? '新建会话' : 'New chat'} aria-label={zh ? '新建会话' : 'New chat'} disabled={creating} onClick={() => void create()}><Plus size={16}/></button>
      <button className={`topbar-inspector-action icon-only agent-manage${tab === 'settings' ? ' active' : ''}`} aria-pressed={tab === 'settings'} title={tab === 'settings' ? zh ? '返回对话' : 'Return to chat' : zh ? '管理此 Agent' : 'Manage Agent'} aria-label={tab === 'settings' ? zh ? '返回对话' : 'Return to chat' : zh ? '管理此 Agent' : 'Manage Agent'} onClick={manage}><Settings size={15}/></button>
    </div>}/>
    {error && <div className="agents-error" role="alert">{error}</div>}
    {tab === 'settings' ? settingsReady ? <AgentSettings call={call} language={language} models={models} projects={projects} onRefresh={refresh} onRemove={onRemove} connection={connection}/>
      : !error && <div className="agents-empty" role="status"><LoaderCircle className="spin"/>{zh ? '正在加载设置…' : 'Loading settings…'}</div>
      : sessionId ? <AgentChat key={`${connection.id}:${sessionId}`} call={call} enhanced={Boolean(info.capabilities.conversationUi)} management={Boolean(info.capabilities.conversationManagement)} connectionId={connection.id} sessionId={sessionId} language={language} models={models} projects={projects} onChanged={refresh} onConfigure={manage} onOpenSession={id => agents.select(connection.id, id)}/>
      : <div className="agents-empty"><h2>{zh ? '有什么可以帮你？' : 'How can I help?'}</h2><p>{zh ? `与 ${connection.name} 开始新对话，或从左侧选择会话。` : `Start a chat with ${connection.name}, or select one in the sidebar.`}</p><button className="agents-primary" disabled={creating} onClick={() => void create()}><Plus size={16}/>{zh ? '开始对话' : 'Start chat'}</button></div>}
  </div>;
}

function AgentChat({ call, enhanced, management, connectionId, sessionId, language, models, projects, onChanged, onConfigure, onOpenSession }: { call: Call; enhanced: boolean; management: boolean; connectionId: string; sessionId: string; language: AppLanguage; models: Models; projects: Projects; onChanged: () => Promise<void>; onConfigure: () => void; onOpenSession: (id: string) => void }) {
  const zh = language === 'zh'; const storageKey = `cardbush-agent-draft:${connectionId}:${sessionId}`;
  const { host, skills, error: hostError, preview, closePreview } = useAgentConversationHost(call, connectionId, sessionId, enhanced, management);
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null); const [jobs, setJobs] = useState<Job[]>([]);
  const [events, setEvents] = useState<RuntimeEvent[]>([]); const [draft, setDraft] = useState(() => sessionStorage.getItem(storageKey) ?? '');
  const [modelId, setModelId] = useState(models.defaultModelId); const [permissionMode, setPermissionMode] = useState<PermissionMode>('task_free');
  const [reasoning, setReasoning] = useState<ReasoningLevel>('medium');
  const [plan, setPlan] = useState<ReferencePlanMode>('off');
  const [routing, setRouting] = useState<SubagentPermissionRouting>('user');
  const [disabledSkills, setDisabledSkills] = useState<Set<string>>(new Set());
  useEffect(() => { if (!models.models.some(model => model.id === modelId)) setModelId(models.defaultModelId); }, [models, modelId]);
  const [error, setError] = useState(''); const [networkError, setNetworkError] = useState(''); const [sending, setSending] = useState(false); const [refresh, setRefresh] = useState(0);
  const [streamError, setStreamError] = useState('');
  useEffect(() => {
    const changed = (event: Event) => { const detail = (event as CustomEvent).detail; if (detail?.connectionId === connectionId && detail?.sessionId === sessionId) setRefresh(value => value + 1); };
    window.addEventListener('cardbush:agent-session-updated', changed);
    return () => window.removeEventListener('cardbush:agent-session-updated', changed);
  }, [connectionId, sessionId]);
  const uncertain = useRef<Record<string, unknown> | null>(readPendingSubmission(storageKey)); const bottom = useRef<HTMLDivElement>(null); const following = useRef(true);
  useEffect(() => { sessionStorage.setItem(storageKey, draft); }, [draft, storageKey]);
  useEffect(() => { if (following.current) bottom.current?.scrollIntoView({ block: 'end' }); }, [events, snapshot, jobs]);
  useEffect(() => {
    let alive = true; let timer: ReturnType<typeof setTimeout>; let lastJobs = ''; let lastSnapshotUpdatedAt = '';
    const read = async () => {
      try {
        const nextJobs = await call<Job[]>('chat.jobs', { sessionId }); if (!alive) return;
        if (uncertain.current && nextJobs.some(job => job.id === uncertain.current!.requestId)) {
          sessionStorage.removeItem(`${storageKey}:submission`); uncertain.current = null; setDraft(''); setError('');
        }
        const signature = nextJobs.map(job => `${job.id}:${job.status}`).join('|');
        if (signature !== lastJobs || !lastJobs) {
          const next = await call<SessionSnapshot>('sessions.get', { sessionId }); if (!alive) return;
          const changed = signature !== lastJobs || next?.updatedAt !== lastSnapshotUpdatedAt;
          setSnapshot(current => current && current.revision === next?.revision && current.updatedAt === next.updatedAt && JSON.stringify(current.metadata) === JSON.stringify(next.metadata) ? current : next); lastJobs = signature;
          lastSnapshotUpdatedAt = next?.updatedAt ?? '';
          if (changed && management && next?.updatedAt) {
            await call('sessions.update', { sessionId, readAt: next.updatedAt, forcedUnread: false });
            if (alive) void onChanged().catch(() => {});
          }
        }
        setJobs(nextJobs);
        setNetworkError('');
        if (alive) timer = setTimeout(() => void read(), nextJobs.some(job => job.status === 'running') ? 1200 : 1800);
      } catch (error) { if (alive) { setNetworkError(errorText(error)); timer = setTimeout(() => void read(), 3000); } }
    };
    void read(); return () => { alive = false; clearTimeout(timer); };
  }, [call, sessionId, refresh, storageKey, management, onChanged]);
  const activeTurnId = jobs.find(job => job.status === 'running')?.turnId;
  useEffect(() => {
    setEvents([]); setStreamError('');
    if (!activeTurnId) return;
    let alive = true; let cursor: number | undefined; let stop: (() => void) | undefined; let retry: ReturnType<typeof setTimeout> | undefined;
    const subscribe = () => {
      if (!alive) return;
      stop = api().watchEvents(connectionId, { sessionId, turnId: activeTurnId, ...(cursor === undefined ? {} : { afterSequence: cursor }) }, frame => {
        if (!alive) return;
        if (frame.type === 'error') {
          setStreamError(frame.error); stop?.(); clearTimeout(retry);
          retry = setTimeout(subscribe, 3000);
        } else {
          setStreamError('');
          if (frame.type === 'event') {
            if (cursor !== undefined && frame.event.sequence <= cursor) return;
            cursor = frame.event.sequence; setEvents(current => [...current, frame.event]);
          } else if (frame.type === 'end') setRefresh(value => value + 1);
        }
      });
    };
    subscribe();
    return () => { alive = false; clearTimeout(retry); stop?.(); };
  }, [connectionId, sessionId, activeTurnId]);
  const send = async (text: string): Promise<boolean> => {
    if (!text.trim() || !modelId || sending) return false;
    setSending(true); setError('');
    const retrying = Boolean(uncertain.current);
    const input = uncertain.current ?? { requestId: crypto.randomUUID(), sessionId, text: text.trim(), modelId, permissionMode, language,
      ...(enhanced ? { reasoningEffort: reasoning, planEnabled: plan === 'auto', disabledSkills: [...disabledSkills], subagentPermissionRouting: routing } : {}) };
    uncertain.current = input;
    sessionStorage.setItem(`${storageKey}:submission`, JSON.stringify(input));
    let titleUpdated = false; let titleError = '';
    // A successful send starts the turn immediately. Name an untouched session
    // first; retries and queued follow-ups must never mutate active metadata.
    if (!management && !retrying && snapshot && !snapshot.turns.length && !jobs.length && ['新对话', 'New conversation'].includes(String(snapshot.metadata?.title))) {
      try { await call('sessions.rename', { sessionId, title: String(input.text).slice(0, 60) }); titleUpdated = true; }
      catch (error) { titleError = errorText(error); } // A cosmetic update cannot block delivery.
    }
    try {
      await call('chat.send', input); uncertain.current = null; sessionStorage.removeItem(`${storageKey}:submission`); setDraft(''); following.current = true; setRefresh(value => value + 1);
      if (titleError) setError(`${zh ? '消息已发送，但会话标题未更新：' : 'Message sent, but the conversation title was not updated: '}${titleError}`);
    } catch (error) { setError(`${errorText(error)} ${zh ? '可重试发送；会沿用请求编号，避免重复执行。' : 'Retry uses the same request ID to prevent duplicate work.'}`); return false; }
    finally { setSending(false); }
    // List refresh failures are independent of whether the server accepted the message.
    if (management || titleUpdated) void onChanged().catch(error => setNetworkError(`${zh ? '会话列表刷新失败：' : 'Unable to refresh conversations: '}${errorText(error)}`));
    return true;
  };
  const act = async (operation: AgentOperation, input: Record<string, unknown>) => {
    setError('');
    try { await call(operation, input); setRefresh(value => value + 1); } catch (error) { setError(errorText(error)); }
  };
  const busy = jobs.some(job => ['running', 'queued'].includes(job.status));
  const permissions = pendingPermissions(events);
  const selection = pendingSelection(events);
  const stoppable = jobs.find(job => job.status === 'running') ?? jobs.find(job => job.status === 'queued');
  return <ConversationHostContext.Provider value={host}><ComposerReferenceContext.Provider value={{ sessionId: host.id, browserTabs: [], messages: [] }}><ConversationExtractionContext.Provider value={null}><section className="agent-chat">
    <div className="agent-messages" onScroll={event => { const element = event.currentTarget; following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 100; }}>
      <div className="agent-message-track">
      <AgentTranscript call={call} scope={connectionId} sessionId={sessionId} snapshot={snapshot} jobs={jobs} events={events} activeTurnId={activeTurnId} busy={busy} language={language} onRefresh={() => setRefresh(value => value + 1)} onComposeReviewComments={comments => setDraft(current => appendReviewCommentsToDraft(current, comments, language))}/>
      {jobs.filter(job => !snapshot?.turns.some(turn => turn.turnId === job.turnId)).map(job => job.status === 'queued' ? <div key={job.id} className="agent-job"><LoaderCircle size={14} className="spin"/>{zh ? '已排队' : 'Queued'}<button onClick={() => void act('chat.stop', { id: job.id })}><Square size={12}/>{zh ? '停止' : 'Stop'}</button></div>
        : job.status === 'stopped' ? <p key={job.id} className="agent-job-status">{zh ? '已停止' : 'Stopped'}</p>
        : ['failed', 'interrupted'].includes(job.status) ? <p key={job.id} className="agents-error">{job.error || (zh ? '执行中断，请查看记录后重试。' : 'Execution interrupted. Inspect history before retrying.')}</p> : null)}
      <AgentInteractions call={call} scope={connectionId} sessionId={sessionId} language={language} permissions={permissions} selection={selection}/>
      <AgentSubagents call={call} sessionId={sessionId} language={language} active={busy} onOpen={onOpenSession}/>
      <div ref={bottom}/>
      </div>
    </div>
    {(error || networkError || streamError || hostError) && <div className="agents-error" role="alert">{error || networkError || streamError || hostError}</div>}
    <div className="agent-composer-dock"><div className="agent-composer">
      {projects.projects.length > 0 && <div className="agent-project-picker"><SettingsDropdown label={zh ? '会话项目' : 'Conversation project'} disabled={busy} value={String(snapshot?.metadata?.projectId ?? '')}
        onChange={projectId => void act('sessions.bind', { sessionId, projectId }).then(onChanged)} options={[
          { value: '', label: zh ? '独立目录' : 'Private workspace', disabled: !management },
          ...projects.projects.map(project => ({ value: project.id, label: project.name, icon: <Folder size={14}/> })),
        ]}/></div>}
      <Composer compact autoFocus language={language} draft={draft} onDraftChange={setDraft} sending={busy} submissionPending={sending} inputReadOnly={Boolean(uncertain.current)}
        selectedModel={modelId} availableModels={models.models} onModelChange={setModelId} onConfigureModels={onConfigure}
        permissionMode={permissionMode} onPermissionModeChange={setPermissionMode} subagentPermissionRouting={routing} onSubagentPermissionRoutingChange={setRouting}
        referencePlanAvailable={enhanced} referencePlanMode={plan} onReferencePlanModeChange={setPlan}
        reasoningLevelAvailable={enhanced} reasoningLevel={reasoning} reasoningLevels={['none', 'low', 'medium', 'high', 'xhigh', 'max']} onReasoningLevelChange={setReasoning}
        skills={skills} disabledSkillNames={disabledSkills} onToggleSkill={(name, enabled) => setDisabledSkills(current => { const next = new Set(current); if (enabled) next.delete(name); else next.add(name); return next; })}
        onSend={send} onCancel={() => stoppable ? act('chat.stop', { id: stoppable.id }) : Promise.resolve()} cancelEnabled={Boolean(stoppable)}/>
    </div></div>
    {preview && <div className="agents-modal-backdrop"><div className="agents-modal agent-file-preview" role="dialog" aria-modal="true" aria-label={preview.name}>
      <header><h2>{preview.name}</h2><button aria-label={zh ? '关闭' : 'Close'} onClick={closePreview}><X size={18}/></button></header>
      {preview.image ? <img src={preview.url} alt={preview.name}/> : preview.text !== undefined ? <pre>{preview.text}</pre> : <p>{zh ? '下载文件以查看内容' : 'Download this file to view it'}</p>}
      <a href={preview.url} download={preview.name}>{zh ? '下载' : 'Download'}</a>
    </div></div>}
  </section></ConversationExtractionContext.Provider></ComposerReferenceContext.Provider></ConversationHostContext.Provider>;

}

function readPendingSubmission(storageKey: string): Record<string, unknown> | null {
  try { const value = JSON.parse(sessionStorage.getItem(`${storageKey}:submission`) ?? 'null'); return value && typeof value.requestId === 'string' && typeof value.text === 'string' ? value : null; } catch { return null; }
}
function pendingPermissions(events: RuntimeEvent[]) {
  const pending = new Map<string, RuntimePermissionRequest & { permissionId: string }>();
  for (const event of events) { if (event.kind === 'permission_requested') pending.set(event.payload.permissionId, event.payload); else if (['permission_answered', 'permission_rejected', 'permission_cancelled', 'permission_expired'].includes(event.kind) && 'permissionId' in event.payload) pending.delete(event.payload.permissionId as string); }
  return [...pending.values()];
}
function pendingSelection(events: RuntimeEvent[]): RuntimeSolutionSelection | undefined {
  let pending: RuntimeSolutionSelection | undefined;
  for (const event of events) { if (event.kind === 'solution_selection_requested') pending = event.payload; else if (event.kind === 'solution_selection_answered' || event.kind === 'solution_selection_cancelled') pending = undefined; }
  return pending;
}

function AgentSettings({ call, language, models, projects, onRefresh, onRemove, connection }: { call: Call; language: AppLanguage; models: Models; projects: Projects; onRefresh: () => Promise<void>; onRemove: () => Promise<void>; connection: AgentConnection }) {
  const zh = language === 'zh'; const [section, setSection] = useState<'projects' | 'models' | 'plugins' | 'instructions'>('projects');
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const [modelDraft, setModelDraft] = useState(models); const [projectName, setProjectName] = useState(''); const [projectPath, setProjectPath] = useState('');
  const [pluginPath, setPluginPath] = useState(''); const [plugins, setPlugins] = useState<{ revision: number; serviceEnabled: boolean; plugins: Array<{ id: string; name: string; description: string; enabled: boolean; installed: boolean }> } | null>(null);
  const [instructions, setInstructions] = useState<{ content: string; revision: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setError(''); setNotice(''); try { await fn(); await onRefresh(); setNotice(zh ? '已保存到此 Agent' : 'Saved to this Agent'); } catch (error) { setError(errorText(error)); } finally { setBusy(false); } };
  useEffect(() => { if (section === 'plugins') void call<typeof plugins>('product.command', { kind: 'apps.get' }).then(setPlugins).catch(error => setError(errorText(error))); if (section === 'instructions') void call<typeof instructions>('instructions.get').then(setInstructions).catch(error => setError(errorText(error))); }, [call, section]);
  return <div className="agent-settings"><nav>{(['projects', 'models', 'plugins', 'instructions'] as const).map(item => <button key={item} className={section === item ? 'active' : ''} onClick={() => { setSection(item); setNotice(''); setError(''); }}>{({ projects: zh ? '项目' : 'Projects', models: zh ? '模型' : 'Models', plugins: zh ? '插件' : 'Plugins', instructions: 'AGENTS.md' })[item]}</button>)}</nav><div className="agent-settings-content">
    <h2>{connection.name}</h2><p>{zh ? '这里的设置仅属于当前 Agent。' : 'These settings belong only to the selected Agent.'}</p>
    {error && <p className="agents-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {section === 'projects' && <><h3>{zh ? '绑定项目' : 'Projects'}</h3>{projects.projects.map(project => <div key={project.id} className="agent-settings-row"><Folder size={18}/><div><strong>{project.name}</strong><small>{project.path}</small></div><button disabled={busy} onClick={() => void act(() => call('projects.default', { id: project.id }))}>{projects.defaultProjectId === project.id ? zh ? '默认' : 'Default' : zh ? '设为默认' : 'Make default'}</button><button disabled={busy} aria-label={zh ? `移除 ${project.name}` : `Remove ${project.name}`} onClick={() => void act(() => call('projects.remove', { id: project.id }))}><X size={16}/></button></div>)}<form className="agents-form" onSubmit={event => { event.preventDefault(); void act(async () => { await call('projects.save', { name: projectName, path: projectPath }); setProjectName(''); setProjectPath(''); }); }}><label>{zh ? '项目名称' : 'Project name'}<input required value={projectName} onChange={event => setProjectName(event.target.value)}/></label><label>{zh ? 'Agent 所在主机的目录' : 'Directory on the Agent host'}<input required value={projectPath} onChange={event => setProjectPath(event.target.value)} placeholder="/srv/projects/my-project"/></label><button disabled={busy}><Plus size={16}/>{zh ? '添加项目' : 'Add project'}</button></form></>}
    {section === 'models' && <form className="agents-form" onSubmit={event => { event.preventDefault(); void act(async () => { const saved = await call<Models>('product.command', { kind: 'models.update', config: modelDraft }); setModelDraft(saved); }); }}><h3>{zh ? '模型配置' : 'Models'}</h3>{modelDraft.models.map((model, index) => {
      const update = (key: string, value: string) => setModelDraft(current => ({ ...current, models: current.models.map((item, i) => i === index ? { ...item, [key]: value } : item) }));
      return <fieldset key={model.id}><legend>{model.modelName || (zh ? '新模型' : 'New model')}</legend><label>{zh ? '模型名称' : 'Model name'}<input required value={model.modelName} onChange={event => update('modelName', event.target.value)}/></label><label>{zh ? 'API 地址' : 'API base URL'}<input type="url" value={model.baseUrl} placeholder="https://api.openai.com/v1" onChange={event => update('baseUrl', event.target.value)}/></label><label>API Key<input autoComplete="off" type="password" value={model.apiKey} placeholder={model.hasApiKey ? zh ? '已保存，留空保留' : 'Saved; leave blank to keep' : ''} onChange={event => update('apiKey', event.target.value)}/></label><label>{zh ? '上下文上限' : 'Context tokens'}<input type="number" min="1" value={model.maxContextTokens ?? ''} onChange={event => update('maxContextTokens', event.target.value)}/></label><button type="button" onClick={() => setModelDraft(current => ({ ...current, models: current.models.filter(item => item.id !== model.id) }))}><Trash2 size={15}/>{zh ? '移除模型' : 'Remove model'}</button></fieldset>;
    })}<label>{zh ? '默认模型' : 'Default model'}<select value={modelDraft.defaultModelId} onChange={event => setModelDraft(current => ({ ...current, defaultModelId: event.target.value }))}><option value="">{zh ? '选择模型' : 'Select model'}</option>{modelDraft.models.map(model => <option key={model.id} value={model.id}>{model.modelName}</option>)}</select></label><footer><button type="button" onClick={() => setModelDraft(current => ({ ...current, models: [...current.models, { id: crypto.randomUUID(), provider: 'openai', modelName: '', apiKey: '', baseUrl: '' }] }))}><Plus size={15}/>{zh ? '新增模型' : 'Add model'}</button><button className="agents-primary" disabled={busy}>{zh ? '保存模型' : 'Save models'}</button></footer></form>}
    {section === 'plugins' && <><h3>{zh ? '已安装插件' : 'Installed plugins'}</h3>{plugins?.plugins.map(plugin => <div key={plugin.id} className="agent-settings-row"><div><strong>{plugin.name}</strong><small>{plugin.description}</small></div><button disabled={busy} onClick={() => void act(async () => { const saved = await call<typeof plugins>('product.command', { kind: 'apps.update', config: { ...plugins, expectedRevision: plugins.revision, plugins: plugins.plugins.map(item => item.id === plugin.id ? { ...item, installed: true, enabled: !item.enabled } : item) } }); setPlugins(saved); })}>{plugin.enabled ? zh ? '禁用' : 'Disable' : zh ? '启用' : 'Enable'}</button></div>)}<form className="agents-form" onSubmit={event => { event.preventDefault(); void act(async () => { await call('plugins.install', { path: pluginPath }); setPlugins(await call('product.command', { kind: 'apps.get' })); setPluginPath(''); }); }}><label>{zh ? '服务器上的插件目录' : 'Plugin directory on the server'}<input required value={pluginPath} onChange={event => setPluginPath(event.target.value)} placeholder="/srv/cardbush-plugins/my-plugin"/></label><button disabled={busy}>{zh ? '安装 / 更新' : 'Install / update'}</button></form><p>{zh ? '插件安装、运行和凭据均留在该 Agent 主机。此服务不提供桌面鼠标或图形浏览器控制。' : 'Plugins run on this Agent host. Desktop mouse and graphical browser control are unavailable.'}</p></>}
    {section === 'plugins' && <AgentMcpSettings call={call} language={language}/>}
    {section === 'instructions' && instructions && <form className="agents-form" onSubmit={event => { event.preventDefault(); void act(async () => setInstructions(await call('instructions.save', instructions))); }}><h3>AGENTS.md</h3><textarea aria-label="AGENTS.md" rows={14} value={instructions.content} onChange={event => setInstructions({ ...instructions, content: event.target.value })}/><button disabled={busy}>{zh ? '保存指令' : 'Save instructions'}</button></form>}
    <div className="agent-remove"><button onClick={() => setConfirmRemove(value => !value)}><Unplug size={16}/>{zh ? '移除此连接' : 'Remove connection'}</button>{confirmRemove && <p>{zh ? '仅移除此连接，Agent 服务、历史和任务继续保留。' : 'Only remove this connection. The Agent service, history and tasks are preserved.'}<button onClick={() => void act(onRemove)}>{zh ? '确认移除' : 'Confirm removal'}</button></p>}</div>
  </div></div>;
}
