import { uiText } from '../../i18n';
import type { UserPromptInput } from '@cardbush/bush-protocol';
import { createPortal } from 'react-dom';
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Folder, LoaderCircle, Monitor, Plus, RefreshCw, Server, Settings } from 'lucide-react';
import type { AgentConnection, AgentInfo, AgentOperation, AgentProject } from '../../../electron/agentTypes';
import type { AppLanguage, ManagedModelConfig, SettingsSection, ThemeMode } from '../../types';
import { DEFAULT_MAX_CONTEXT_TOKENS } from '@cardbush/bush-product-agent';
import './agents.css';
import { AgentConnectionForm } from './AgentConnectionForm';
import { AgentConnectionStatus } from './AgentConnectionStatus';
import { AgentConfigurationDialog } from './AgentConfigurationDialog';
import { AgentDesktopPanel as AgentDesktopView } from './AgentDesktopPanel';
import type { AgentConnectionsController } from './useAgentConnections';
import { TopBar } from '../../components/TopBar';
import { ChatPanel } from '../chat/ChatPanel';
import { WorkSummaryInspector } from '../chat/WorkSummaryInspector';
import type { WorkSummaryInspectorDetail } from '../subagents/subagentObservabilityEvents';
import { ConversationHostPreview } from '../inspector/ConversationHostPreview';
import { ConversationInspectorContext } from '../inspector/ConversationInspector';
import { ConversationChangeDialog } from '../sidebar/ChatSidebar';
import { recentReviewTurns } from '../sidebar/reviewModel';
import { WorkspaceChangeStateContext } from '../tools/WorkspaceChangeStateContext';
import { ConversationExtractionProvider } from '../chat/ConversationExtraction';
import { ConversationHostContext } from '../conversationHost';
import { usePublishRegionConversation } from '../inspector/RegionConversationContext';
import { agentInspectorWorkspace } from '../inspector/inspectorSessions';
import { ComposerPortalContext } from '../composer/ComposerPortalContext';
import { createAgentConversationBackend } from './agentConversationBackend';
import { useCardbushChat } from '../../hooks/useCardbushChat';
import { saveModelReasoning } from '../../backend/api';
import { changeReportsFromMessages, type ConversationChangeReport } from '../tools/toolChangeReports';
import { conversationWorkspaceRoot } from '../conversationWorkspace';
import { useAgentConversationHost } from './useAgentConversationHost';
import { SettingsDropdown } from '../settings/SettingsDropdown';
import { appendReviewCommentsToDraft, emptyReviewComments, type ReviewCommentState } from '../sidebar/reviewCommentModel';
import { agentErrorText as errorText } from './agentErrorText';
import { conversationViewKey, useConversationViewState } from '../../shared/conversationViewState';

type Call = <T = unknown>(operation: AgentOperation, input?: Record<string, unknown>) => Promise<T>;
type Models = { defaultModelId: string; models: ManagedModelConfig[] };
type Projects = { projects: AgentProject[]; defaultProjectId: string | null };
const api = () => { const value = window.cardbushDesktop?.agents; if (!value) throw new Error(uiText()('agentsView.agent_connections_are_unavailable')); return value; };

type AgentChatAppearance = { composerPortalTarget?: HTMLElement | null; visualInputEnabled?: boolean; disabledSkillNames?: Set<string>; onToggleSkill?: (name: string, enabled: boolean) => void; onOpenSettings?: (section: SettingsSection) => void; theme?: ThemeMode; sidebarCollapsed?: boolean; windowMaximized?: boolean; thinkingVisible?: boolean; guidanceDeliveryMode?: 'queue' | 'immediate' };

const emptyStates = new Map<string, boolean>();

export function AgentsView({ language, agents, active = true, ...appearance }: {
  language: AppLanguage; agents: AgentConnectionsController; active?: boolean;
} & AgentChatAppearance) {
  const { connections, selectedId, select: onSelect, refresh: onRefresh } = agents;

  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AgentConnection>();
  // Keep controllers, cursors and transcripts per host. Only the selected chat
  // mounts its DOM; navigation must not tear down a running stream.
  const [connectedHosts, setConnectedHosts] = useState<Record<string, AgentInfo>>({});
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [reconnect, setReconnect] = useState(0);
  const selected = connections.find(item => item.id === selectedId);
  const managingConnection = !adding && active && agents.views[selectedId] === 'settings';
  const connectionToEdit = managingConnection ? selected : editing;
  const info = connectedHosts[selectedId];
  useEffect(() => {
    let alive = true; setError('');
    if (!active || !selectedId) { setConnecting(false); return; }
    setConnecting(true);
    void api().connect(selectedId).then(info => { if (alive) { setConnectedHosts(current => ({ ...current, [selectedId]: info })); void onRefresh(); } }, async error => {
      // Read the manager's retry/terminal state before presenting the failure.
      // Otherwise a transient SSH timeout flashes an alert until the next poll.
      if (!alive) return;
      await onRefresh();
      if (alive) setError(errorText(error));
    })
      .finally(() => { if (alive) setConnecting(false); });
    return () => { alive = false; }; // Leaving this view does not disconnect or stop remote work.
  }, [active, selectedId, reconnect, onRefresh]);
  useEffect(() => {
    if (selected?.connected && selected.info) { setConnectedHosts(current => current[selected.id] === selected.info ? current : { ...current, [selected.id]: selected.info! }); setError(''); setConnecting(false); }
    else if (selected?.connectionError && selected.connectionState === 'disconnected') setError(selected.connectionError);
  }, [selected]);
  return <div className="agents-view" hidden={!active}>
    {(!selected || !info) && <TopBar title={selected?.name || 'Agents'} language={language} inspectorOpen={false}
      workspaceControl={<button className="agents-add" onClick={() => setAdding(true)}><Plus size={16}/>{uiText(language)('agentConnectionForm.addAgent')}</button>}/>}
    {!selected && <div className="agents-overview"><h2>{uiText(language)('agentsView.aWorkspaceForEveryAgent')}</h2><p>{uiText(language)('agentsView.chatDirectlyAfterConnectingModelSettingsGlobal')}</p>
      <div className="agents-cards">{connections.map(item => <button key={item.id} className="agents-card" onClick={() => onSelect(item.id)}><Server size={24}/><strong>{item.name}</strong><span>{item.migrationIssue || (item.sshTunnel ? `${uiText(language)('agentsView.sshDirectServerPort')} ${item.sshTunnel.remotePort}` : item.url)}</span></button>)}
      <button className="agents-card" onClick={() => setAdding(true)}><Plus size={24}/><strong>{uiText(language)('agentsView.addConnection')}</strong><span>{uiText(language)('agentsView.ssh_http_https')}</span></button></div></div>}
    {connecting && !info && selected?.connectionState !== 'reconnecting' && <div className="agents-empty"><LoaderCircle className="spin"/>{uiText(language)('agentsView.connecting')}</div>}
    {selected && <AgentConnectionStatus key={selected.id} connection={selected} language={language} error={error} pending={connecting} retained={Boolean(info)}
      onEdit={() => onSelect(selected.id, undefined, 'settings')} onRetry={() => setReconnect(value => value + 1)}/>}
    {connections.filter(item => connectedHosts[item.id]).map(connection => <AgentWorkspace {...appearance} key={connection.id}
      active={active && connection.id === selectedId} connection={connection} info={connectedHosts[connection.id]} language={language} agents={agents}
      configurationDialogEnabled={!adding && !connectionToEdit}
      onReconnect={() => { void api().disconnect(connection.id).then(() => setReconnect(value => value + 1)).catch(error => setError(errorText(error))); }}
      onEdit={() => onSelect(connection.id, undefined, 'settings')}/>)}
    {active && (adding || connectionToEdit) && <AgentConnectionForm key={managingConnection ? `connection-settings:${selectedId}` : 'new-connection'} language={language} initial={connectionToEdit} onClose={() => {
      setAdding(false); setEditing(undefined); if (agents.views[selectedId] === 'settings') onSelect(selectedId);
    }} onRemove={connectionToEdit ? async () => {
      await api().remove(connectionToEdit.id); if (selectedId === connectionToEdit.id) onSelect(''); setEditing(undefined); await onRefresh();
    } : undefined} onSave={async input => {
      const next = await api().save(input), id = input.id || next.at(-1)!.id;
      // Keep the saved identity on failures so retrying a new connection cannot create duplicates.
      setAdding(false); setEditing(next.find(item => item.id === id));
      await onRefresh();
      setEditing(undefined); onSelect(id); setReconnect(value => value + 1);
    }}/>}
  </div>;
}

function AgentWorkspace({ connection, info, language, agents, onReconnect, onEdit, active, configurationDialogEnabled, ...appearance }: { active: boolean; configurationDialogEnabled: boolean; connection: AgentConnection; info: AgentInfo; language: AppLanguage; agents: AgentConnectionsController; onReconnect: () => void; onEdit: () => void } & AgentChatAppearance) {

  const inspector = useContext(ConversationInspectorContext);
  const inspectorRef = useRef(inspector); inspectorRef.current = inspector;
  const desktopId = `agent-desktop:${connection.id}`;
  useEffect(() => () => { inspectorRef.current?.close(desktopId); }, [desktopId]);
  const call = useCallback<Call>(async (operation, input) => await api().call(connection.id, operation, input) as never, [connection.id]);
  const { refreshSessions } = agents;
  const sessionId = agents.selectedSessions[connection.id] ?? '';
  const visitedSessions = useRef(new Set<string>());
  if (sessionId) visitedSessions.current.add(sessionId);
  const sessions = agents.sessionsByAgent[connection.id]?.sessions ?? [];
  const [models, setModels] = useState<Models>({ defaultModelId: '', models: [] });
  // The shared-conversation protocol added visionEnabled to chat.send.
  const visualInputAvailable = info.capabilities.sharedConversation === true;
  const [projects, setProjects] = useState<Projects>({ projects: [], defaultProjectId: null });
  const [error, setError] = useState('');
  const wasReconnecting = useRef(false);
  const [recoveryRevision, setRecoveryRevision] = useState(0);
  useEffect(() => {
    if (connection.connectionState === 'reconnecting') wasReconnecting.current = true;
    else if (connection.connected && wasReconnecting.current) {
      wasReconnecting.current = false;
      setRecoveryRevision(current => current + 1);
      window.dispatchEvent(new CustomEvent('cardbush:agent-connection-restored', { detail: connection.id }));
    }
  }, [connection.id, connection.connectionState, connection.connected]);
  const creating = agents.sessionsByAgent[connection.id]?.creating;
  const refresh = useCallback(async () => {
    await Promise.all([
      call<Models>('product.command', { kind: 'models.get' }).then(value => { setModels(value); window.dispatchEvent(new CustomEvent('cardbush:agent-configuration-synced', {detail:connection.id})); }),
      call<Projects>('projects.list').then(setProjects), refreshSessions(connection.id),
    ]);
    setError('');
  }, [call, connection.id, refreshSessions]);
  const refreshConversationList = useCallback(() => refreshSessions(connection.id), [connection.id, refreshSessions]);
  const [settingsRevision, setSettingsRevision] = useState(0);
  const needsRefresh = useRef(true);
  useEffect(() => { needsRefresh.current = true; }, [refresh, recoveryRevision, settingsRevision]);
  useEffect(() => {
    let alive = true;
    if (active && needsRefresh.current) {
      needsRefresh.current = false;
      void refresh().catch(error => { needsRefresh.current = true; if (alive) setError(errorText(error)); });
    }
    return () => { alive = false; };
  }, [active, refresh, recoveryRevision, settingsRevision]);
  useEffect(() => {
    const changed = () => setSettingsRevision(value => value + 1);
    window.addEventListener('cardbush:shared-configuration-updated', changed);
    return () => window.removeEventListener('cardbush:shared-configuration-updated', changed);
  }, []);
  useEffect(() => {
    const updated = (event: Event) => { if ((event as CustomEvent<string>).detail === connection.id) void refresh().catch(error => setError(errorText(error))); };
    window.addEventListener('cardbush:agent-settings-updated', updated);
    return () => window.removeEventListener('cardbush:agent-settings-updated', updated);
  }, [connection.id, refresh]);
  const create = () => agents.createSession(connection.id, uiText(language)('agentsView.newConversation'));
  const title = String(sessions.find(item => item.sessionId === sessionId)?.metadata?.title || connection.name);
  const headerActions = <div className="agent-header-actions">
      {info.capabilities.desktop && inspector && <button className="topbar-inspector-action icon-only" title={uiText(language)('agentsView.viewComputer')} aria-label={uiText(language)('agentsView.viewComputer')} onClick={() => inspector.open(desktopId, uiText(language)('agentsView.sComputer', { value1: connection.name }))}><Monitor size={16}/></button>}
      <button className="topbar-inspector-action icon-only" title={uiText(language)('agentsView.refreshConnection')} aria-label={uiText(language)('agentsView.refreshConnection')} onClick={onReconnect}><RefreshCw size={15}/></button>
      <button className="topbar-inspector-action icon-only" title={uiText(language)('agentsView.newChat')} aria-label={uiText(language)('agentsView.newChat')} disabled={creating} onClick={() => void create()}><Plus size={16}/></button>
      <button className="topbar-inspector-action icon-only agent-manage" title={uiText(language)('agentConnectionForm.connectionSettings')} aria-label={uiText(language)('agentConnectionForm.connectionSettings')} onClick={onEdit}><Settings size={15}/></button>
    </div>;
  return <div className="agent-workspace" hidden={!active}>
    {info.capabilities.desktop && inspector?.outlets.get(desktopId) && createPortal(<AgentDesktopView call={call} name={connection.name} language={language}
      active={inspector.visibleTabIds?.has(desktopId) ?? (active && inspector.visible)}/>, inspector.outlets.get(desktopId)!)}
    {active && !sessionId && <TopBar title={title} language={language} inspectorOpen={false} workspaceControl={headerActions}/>}
    <AgentConfigurationDialog connection={connection} language={language} active={active && configurationDialogEnabled} onEdit={onEdit}/>
    {active && error && connection.connectionState !== 'reconnecting' && <div className="agents-error" role="alert">{error}</div>}
    {[...visitedSessions.current].map(retainedSessionId => <AgentChat key={retainedSessionId} {...appearance} active={active && retainedSessionId === sessionId}
      title={String(sessions.find(item => item.sessionId === retainedSessionId)?.metadata?.title || connection.name)} headerActions={headerActions} onCreate={() => void create()} call={call}
      enhanced={Boolean(info.capabilities.conversationUi)} management={Boolean(info.capabilities.conversationManagement)} sharedSettings={info.capabilities.sharedSettings === true}
      visualInputAvailable={visualInputAvailable} connectionId={connection.id} sessionId={retainedSessionId} language={language} models={models} projects={projects}
      onChanged={refreshConversationList} onConfigure={() => appearance.onOpenSettings?.('models')} onOpenSession={id => agents.select(connection.id, id)} onForkSession={id => agents.forkSession(connection.id, id)}/>)}
    {active && !sessionId && <div className="agents-empty"><h2>{uiText(language)('agentsView.howCanIHelp')}</h2><p>{uiText(language)('agentsView.startAChatWithOrSelectOne', { value1: connection.name })}</p><button className="agents-primary" disabled={creating} onClick={() => void create()}><Plus size={16}/>{uiText(language)('agentsView.startChat')}</button></div>}
  </div>;
}

function AgentChat({ composerPortalTarget, active, call, sharedSettings, enhanced, management, visualInputAvailable, connectionId, sessionId, language, models, projects, onChanged, onConfigure, onOpenSession, onForkSession, title, headerActions, onCreate, theme = 'dark', sidebarCollapsed = false, windowMaximized = false, thinkingVisible = true, guidanceDeliveryMode = 'queue', visualInputEnabled = false, disabledSkillNames, onToggleSkill }: { active: boolean; call: Call; sharedSettings: boolean; enhanced: boolean; management: boolean; visualInputAvailable: boolean; connectionId: string; sessionId: string; language: AppLanguage; models: Models; projects: Projects; onChanged: () => Promise<void>; onConfigure: () => void; onOpenSession: (id: string) => void; onForkSession: (id: string) => Promise<void>; title: string; headerActions: ReactNode; onCreate: () => void } & AgentChatAppearance) {
   const storageKey = `cardbush-agent-draft:${connectionId}:${sessionId}`;
  const viewKey = (field: string) => conversationViewKey(connectionId, sessionId, field);
  const submittedRef = useRef<(sessionId: string) => void>(() => {});
  const connection = useMemo(() => createAgentConversationBackend(call, connectionId,
    (request, listener) => api().watchEvents(connectionId, request, listener), { enhanced, sharedSettings, visualInputAvailable, onSubmitted: id => submittedRef.current(id) }), [call, connectionId, enhanced, visualInputAvailable, sharedSettings]);
  const disabledSkills = useMemo(() => disabledSkillNames ?? new Set<string>(), [disabledSkillNames]);
  const availableModels = useMemo(() => [...models.models].sort((a, b) => Number(b.id === models.defaultModelId) - Number(a.id === models.defaultModelId)), [models]);
  const chat = useCardbushChat(availableModels, models.models, { runtimeReady: true,
    defaultModelId: models.defaultModelId,
    activeConversationId: sessionId, viewActive: active,
    onModelReasoningChange: (id, effort) => saveModelReasoning(id, effort, connectionId),
    language, reasoningTraceVisible: thinkingVisible, standardImageInputEnabled: visualInputAvailable && visualInputEnabled, disabledSkillNames: disabledSkills,
    interactiveRequestsAvailable: enhanced, contextWindowUsageAvailable: true, workspaceChangesAvailable: true,
  }, connection.backend);
  const { host: baseHost, skills, error: hostError, preview, closePreview } = useAgentConversationHost(call, connectionId, sessionId, enhanced, management);
  const inspector = useContext(ConversationInspectorContext);
  const inspectorRef = useRef(inspector); inspectorRef.current = inspector;
  const [summary, setSummary] = useConversationViewState<WorkSummaryInspectorDetail | undefined>(viewKey('summary'), () => undefined);
  const summaryId = `agent-summary:${baseHost.id}`;
  const previewId = `agent-file:${baseHost.id}`;
  const openWorkSummary = useCallback((detail: WorkSummaryInspectorDetail) => {
    setSummary({ ...detail, sessionId: detail.sessionId || sessionId });
    inspectorRef.current?.open(summaryId, detail.title || (uiText(language)('agentsView.executionDetails')));
  }, [sessionId, summaryId, language, setSummary]);
  const host = useMemo(() => ({ ...baseHost, optimisticSubmission: true, conversationStyleAvailable: sharedSettings, sessionId, runtime: connection.runtime, openWorkSummary }), [baseHost, sharedSettings, sessionId, connection, openWorkSummary]);
  // Reopening the chat must preserve its selected tab. Only a new file request
  // should activate the preview (including clicks from a locked remote page).
  useEffect(() => { if (preview) inspectorRef.current?.open(previewId, preview.name); }, [preview, previewId]);
  useEffect(() => () => {
    inspectorRef.current?.close(summaryId); inspectorRef.current?.close(previewId); closePreview();
  }, [summaryId, previewId, closePreview]);
  const [draft, updateDraft] = useConversationViewState(viewKey('draft'), () => sessionStorage.getItem(storageKey) ?? '', Boolean);
  const draftRevision = useRef(0);
  const setDraft = useCallback((value: string | ((current: string) => string)) => updateDraft(current => {
    const next = typeof value === 'function' ? value(current) : value;
    draftRevision.current++;
    sessionStorage.setItem(storageKey, next);
    return next;
  }), [storageKey, updateDraft]);
  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ connectionId: string; sessionId: string }>).detail;
      if (detail?.connectionId === connectionId && detail.sessionId === sessionId) void chat.refreshActiveSession({ silent: true }).catch(() => {});
    };
    window.addEventListener('cardbush:agent-session-updated', refresh);
    const restored = (event: Event) => {
      if ((event as CustomEvent<string>).detail === connectionId && sessionId) void chat.refreshActiveSession({ silent: true }).catch(() => {});
    };
    window.addEventListener('cardbush:agent-connection-restored', restored);
    return () => {
      window.removeEventListener('cardbush:agent-session-updated', refresh);
      window.removeEventListener('cardbush:agent-connection-restored', restored);
    };
  }, [connectionId, sessionId, chat.refreshActiveSession]);
  const selectedModel = models.models.find(model => model.id === chat.selectedModel);
  const maxContextTokens = selectedModel?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  const workspaceRoot = chat.activeConversation ? conversationWorkspaceRoot(chat.activeConversation) : undefined;
  const availableProjects = useMemo(() => projects.projects.map(project => ({ id: project.id, title: project.name, rootPath: project.path })), [projects.projects]);
  const selectedProject = projects.projects.find(project => project.id === chat.activeConversation?.projectId);
  const reports = useMemo(() => changeReportsFromMessages(chat.activeMessages), [chat.activeMessages]);
  const [error, setError] = useConversationViewState(viewKey('error'), () => '');
  const [submissionPending, setSubmissionPending] = useConversationViewState(viewKey('submission'), () => false, Boolean);
  const acceptSubmissionRef = useRef(new Map<string, { accept: () => void; refreshFailed: (error: unknown) => void }>());
  submittedRef.current = id => {
    const submission = acceptSubmissionRef.current.get(id);
    submission?.accept();
    void onChanged().catch(error => submission?.refreshFailed(error));
  };
  const sendComposerMessage = (text: UserPromptInput): Promise<boolean> => {
    if (acceptSubmissionRef.current.has(sessionId)) return Promise.resolve(false);
    setSubmissionPending(true);
    return new Promise(resolve => {
      let settled = false;
      const finish = (accepted: boolean) => {
        if (settled) return;
        settled = true;
        if (acceptSubmissionRef.current.get(sessionId)?.accept === accept) acceptSubmissionRef.current.delete(sessionId);
        setSubmissionPending(false);
        resolve(accepted);
      };
      const accept = () => finish(true);
      acceptSubmissionRef.current.set(sessionId, { accept, refreshFailed: error =>
        setError(`${uiText(language)('agentsView.messageAcceptedConversationRefreshFailed')}${errorText(error)}`) });
      // The composer waits for durable admission, not for the whole streamed Turn.
      // A later completion must not clear attachments prepared for the next message.
      void chat.sendMessage(text).then(() => finish(false), error => {
        setError(errorText(error)); finish(false);
      });
    });
  };
  const [reverting, setReverting] = useConversationViewState(viewKey('reverting'), () => '', Boolean);
  const busy = chat.sending || chat.stopping;
  usePublishRegionConversation({ scope: agentInspectorWorkspace(connectionId, sessionId), busy, error: error || chat.error, messages: chat.activeMessages, send: sendComposerMessage,
    saveImage: async data => {
      const blob = await (await fetch(data)).blob();
      const uploaded = await host.uploadFiles([new File([blob], 'region.png', { type: 'image/png' })]);
      if (!uploaded[0]?.path) throw Error(uiText(language)('agentsView.regionUploadFailed'));
      return uploaded[0].path;
    },
  }, active);
  const revert = async (report: ConversationChangeReport) => {
    if (!report.turnId || busy || reverting) return;
    setReverting(report.id); setError('');
    try {
      const input = { sessionId, turnIds: [report.turnId] };
      if (report.reverted) await connection.client.restoreWorkspaceChanges(input); else await connection.client.revertWorkspaceChanges(input);
      await chat.refreshActiveSession({ silent: true });
    } catch (error) { setError(errorText(error)); }
    finally { setReverting(''); }
  };
  const reviewId = `agent-review:${host.id}`;
  useEffect(() => () => inspectorRef.current?.close(reviewId), [reviewId]);
  const [review, setReview] = useConversationViewState<{ path: string; turnId?: string; requestId: string } | undefined>(viewKey('review'), () => undefined);
  const [comments, setComments] = useConversationViewState<ReviewCommentState>(viewKey('comments'), () => emptyReviewComments, value => Boolean(value.comments.length || value.draft));
  const openReview = (path = '', turnId?: string) => {
    setReview({ path, turnId, requestId: crypto.randomUUID() });
    inspector?.open(reviewId, uiText(language)('app.review'));
  };
  const reviewOutlet = inspector?.outlets.get(reviewId);
  const selectProject = async (projectDir: string | null) => {
    const project = projectDir ? projects.projects.find(item => item.path === projectDir) : undefined;
    if (projectDir && !project) throw new Error(uiText(language)('agentsView.selectAProjectOnThisAgent'));
    await call('sessions.bind', { sessionId, projectId: project?.id ?? null });
    await chat.refreshActiveSession({ silent: true }); await onChanged();
  };
  const projectPicker = <div className="agent-project-picker"><SettingsDropdown label={uiText(language)('agentsView.conversationProject')} disabled={busy || submissionPending || !management} value={selectedProject?.id ?? ''}
    onChange={projectId => void selectProject(projects.projects.find(project => project.id === projectId)?.path ?? null).catch(error => setError(errorText(error)))} options={[
      { value: '', label: uiText(language)('agentsView.privateWorkspace'), disabled: !management },
      ...projects.projects.map(project => ({ value: project.id, label: project.name, icon: <Folder size={14}/> })),
    ]}/></div>;
  return <ConversationHostContext.Provider value={host}><ConversationExtractionProvider api={connection.extracts} activeSessionId={sessionId} contextWindowTokens={maxContextTokens}
    language={language} onOpen={onOpenSession} onFork={onForkSession}>
    <WorkspaceChangeStateContext.Provider value={{ states: emptyStates, busy: busy || Boolean(reverting) }}>
    <section className={active ? 'agent-chat' : 'agent-chat-retained-host'} hidden={!active}>
      {active && <ComposerPortalContext.Provider value={composerPortalTarget ?? null}>
      <ChatPanel language={language} theme={theme} title={title} headerActions={headerActions}
        sidebarCollapsed={sidebarCollapsed} windowMaximized={windowMaximized} inspectorOpen={inspector?.visible ?? false} onToggleInspector={() => openReview()}
        activeConversationId={host.id} activeProjectDir={workspaceRoot} projectPathAliases={[]} selectedProjectDir={selectedProject?.path ?? ''} availableProjects={availableProjects} onWelcomeProjectChange={selectProject}
        messages={chat.activeMessages} changeReports={reports} activeTurnId={chat.activeTurnId}
        loading={chat.loading || chat.messagesLoading} historyLoading={chat.messagesLoading} historyPages={chat.historyPages} sending={chat.sending} stopping={chat.stopping}
        turnHistoryAvailable subagentObservabilityAvailable thinkingVisible={thinkingVisible} guidanceDeliveryMode={guidanceDeliveryMode}
        activeGoal={chat.activeGoal} goalAvailable={chat.goalAvailable} goalCancelling={chat.activeGoalCancelling} goalWaiting={chat.activeGoalWaiting} shadowAvailable={false} shadowAccentColor="" shadowThemeVariables={{}}
        queueLocked={chat.queueLocked} queueLockPending={chat.queueLockPending} onToggleQueueLock={chat.toggleQueueLock}
                queuedMessageCount={chat.queuedMessageCount} queuedMessagePreview={chat.queuedMessagePreview} queuedMessages={chat.queuedMessages}
        pendingInteraction={chat.pendingInteraction ? { ...chat.pendingInteraction, sessionId: host.id } : null}
        connectionRecovery={chat.activeConnectionRecovery} welcomeWorkspaceControl={projectPicker}
        error={error || hostError || chat.error} notice={chat.notice} onClearError={() => { setError(''); chat.clearError(); }} onClearNotice={chat.clearNotice}
        draft={draft} onDraftChange={setDraft} selectedModel={chat.selectedModel} selectedModelConfig={selectedModel} availableModels={models.models} onModelChange={chat.setSelectedModel} onConfigureModels={onConfigure}
        contextWindowMaxTokens={maxContextTokens} contextWindowUsage={chat.activeContextWindowUsage}
        permissionMode={chat.permissionMode} onPermissionModeChange={chat.setPermissionMode} subagentPermissionRouting={chat.subagentPermissionRouting} onSubagentPermissionRoutingChange={chat.setSubagentPermissionRouting}
        referencePlanAvailable={enhanced} referencePlanMode={chat.referencePlanMode} onReferencePlanModeChange={chat.setReferencePlanMode}
        reasoningLevelAvailable={enhanced} reasoningLevel={chat.reasoningLevel} reasoningLevels={['none', 'low', 'medium', 'high', 'xhigh', 'max']} onReasoningLevelChange={chat.setReasoningLevel}
        skills={skills} disabledSkillNames={disabledSkills} onToggleSkill={(name, enabled) => onToggleSkill?.(name, enabled)}
        onSend={sendComposerMessage} onVoiceSend={chat.sendVoiceMessage} submissionPending={submissionPending} onCancel={() => chat.cancelSending()}
        onRefreshActiveSession={chat.refreshActiveSession} onCreateConversation={onCreate} onOpenConversation={onOpenSession}
        onRetryMessage={chat.retryFailedUserMessage} onRegenerate={chat.regenerateAssistantMessage} onEditUserMessage={chat.editUserMessageAndRegenerate}
        onGuideMessage={(message, text, mode) => chat.sendTurnGuidance({ ...message, conversationId: sessionId }, text, mode)}
        onRetryGuidance={message => {
          const revision = draftRevision.current;
          return chat.retryTurnGuidance(message, () => {
            if (draftRevision.current === revision) setDraft(current => current.trim() === message.content.trim() ? '' : current);
          });
        }}
        onGuideQueuedMessage={chat.sendQueuedMessageAsGuidance} onRemoveQueuedMessage={chat.removeQueuedMessage} onReorderQueuedMessage={chat.reorderQueuedMessage}
        onRevertChangeReport={revert} onOpenChangeReview={openReview} onReplyInteraction={chat.replyToInteraction} onCancelInteraction={chat.cancelPendingInteraction} onCancelGoal={chat.cancelActiveGoal}/>
      </ComposerPortalContext.Provider>}
      {review && reviewOutlet && createPortal(<ConversationChangeDialog key={review.turnId ?? ''} embedded language={language}
        conversation={chat.activeConversation ?? { id: sessionId, title, updatedAt: '', preview: '' }}
        reports={reports} turns={recentReviewTurns(chat.activeMessages)} initialFilePath={review.path} initialTurnId={review.turnId} selectionRequestId={review.requestId}
        reviewComments={comments} onReviewCommentsChange={setComments} onComposeReviewComments={items => {
          setDraft(current => appendReviewCommentsToDraft(current, items, language)); inspector?.close(reviewId);
          requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.agent-chat [data-composer-input]')?.focus({ preventScroll: true }));
        }} notice={error} revertingChangeId={reverting} revertedChangeIds={new Set(reports.filter(report => report.reverted).map(report => report.id))}
        revertAvailable={!busy} onClose={() => inspector?.close(reviewId)} onRevert={revert}/>, reviewOutlet)}
      {summary && inspector?.outlets.get(summaryId) && createPortal(<WorkSummaryInspector detail={summary} messages={chat.activeMessages} language={language}
        active={inspector.visibleTabIds?.has(summaryId) ?? (active && inspector.visible)} conversationOptions={{ theme, thinkingVisible, guidanceDeliveryMode,
        visualInputEnabled: visualInputAvailable && visualInputEnabled, disabledSkillNames: disabledSkills, onToggleSkill, onConfigureModels: onConfigure }}/>, inspector.outlets.get(summaryId)!)}
      {preview && inspector?.outlets.get(previewId) && createPortal(<ConversationHostPreview key={preview.path} path={preview.path} language={language}/>, inspector.outlets.get(previewId)!)}
    </section>
    </WorkspaceChangeStateContext.Provider></ConversationExtractionProvider></ConversationHostContext.Provider>;
}
