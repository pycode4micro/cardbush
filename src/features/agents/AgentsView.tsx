import { createPortal } from 'react-dom';
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Folder, LoaderCircle, Plus, RefreshCw, Server, Settings } from 'lucide-react';
import type { AgentConnection, AgentInfo, AgentOperation, AgentProject } from '../../../electron/agentTypes';
import type { AppLanguage, ManagedModelConfig, SettingsSection, ThemeMode } from '../../types';
import { DEFAULT_MAX_CONTEXT_TOKENS } from '@cardbush/bush-product-agent';
import { useAgentChatPreferences } from './agentChatPreferences';
import './agents.css';
import { AgentConnectionForm } from './AgentConnectionForm';
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
import { createAgentConversationBackend } from './agentConversationBackend';
import { useCardbushChat } from '../../hooks/useCardbushChat';
import { changeReportsFromMessages, type ConversationChangeReport } from '../tools/toolChangeReports';
import { conversationWorkspaceRoot } from '../conversationWorkspace';
import { useAgentConversationHost } from './useAgentConversationHost';
import { SettingsDropdown } from '../settings/SettingsDropdown';
import { appendReviewCommentsToDraft, emptyReviewComments, type ReviewCommentState } from '../sidebar/reviewCommentModel';
import { agentErrorText as errorText } from './agentErrorText';

type Call = <T = unknown>(operation: AgentOperation, input?: Record<string, unknown>) => Promise<T>;
type Models = { defaultModelId: string; models: ManagedModelConfig[] };
type Projects = { projects: AgentProject[]; defaultProjectId: string | null };
const api = () => { const value = window.cardbushDesktop?.agents; if (!value) throw new Error('Agent connections are unavailable.'); return value; };

type AgentChatAppearance = { visualInputEnabled?: boolean; onOpenSettings?: (id: string, section: SettingsSection) => void; theme?: ThemeMode; sidebarCollapsed?: boolean; windowMaximized?: boolean; thinkingVisible?: boolean; guidanceDeliveryMode?: 'queue' | 'immediate' };

const noAction = async () => {};
const emptyStates = new Map<string, boolean>();

export function AgentsView({ language, agents, ...appearance }: {
  language: AppLanguage; agents: AgentConnectionsController;
} & AgentChatAppearance) {
  const { connections, selectedId, select: onSelect, refresh: onRefresh } = agents;
  const zh = language === 'zh';
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AgentConnection>();
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
  useEffect(() => {
    if (selected?.connected && selected.info) { setInfo(selected.info); setConnectedId(selected.id); setError(''); setConnecting(false); }
    else if (selected?.connectionError && selected.connectionState === 'disconnected') setError(selected.connectionError);
  }, [selected]);
  return <div className="agents-view">
    {(!selected || !info || connectedId !== selectedId) && <TopBar title={selected?.name || 'Agents'} language={language} inspectorOpen={false}
      workspaceControl={<button className="agents-add" onClick={() => setAdding(true)}><Plus size={16}/>{zh ? '添加 Agent' : 'Add Agent'}</button>}/>}
    {!selected && <div className="agents-overview"><h2>{zh ? '让每个 Agent 专注自己的工作' : 'A workspace for every Agent'}</h2><p>{zh ? '连接后直接对话。项目、模型、插件和历史记录由各个 Agent 分别管理。' : 'Chat directly after connecting. Each Agent owns its projects, models, plugins and history.'}</p>
      <div className="agents-cards">{connections.map(item => <button key={item.id} className="agents-card" onClick={() => onSelect(item.id)}><Server size={24}/><strong>{item.name}</strong><span>{item.migrationIssue || (item.sshTunnel ? `${zh ? 'SSH 直连 · 服务器端口' : 'SSH direct · Server port'} ${item.sshTunnel.remotePort}` : item.url)}</span></button>)}
      <button className="agents-card" onClick={() => setAdding(true)}><Plus size={24}/><strong>{zh ? '添加连接' : 'Add connection'}</strong><span>SSH / HTTP / HTTPS</span></button></div></div>}
    {connecting && <div className="agents-empty"><LoaderCircle className="spin"/>{zh ? '正在连接 Agent…' : 'Connecting…'}</div>}
    {!error && selected?.connectionState === 'reconnecting' && <div className="agents-error" role="status">{zh ? '正在自动重连：' : 'Reconnecting: '}{selected.connectionError}<button onClick={() => setEditing(selected)}>{zh ? '连接设置' : 'Connection settings'}</button></div>}
    {error && <div className="agents-error" role="alert">{selected?.connectionState === 'reconnecting' ? (zh ? '正在自动重连：' : 'Reconnecting: ') + (selected.connectionError || error) : error}{selected && <button onClick={() => setEditing(selected)}>{zh ? '连接设置' : 'Connection settings'}</button>}<button onClick={() => setReconnect(value => value + 1)}>{zh ? '重试' : 'Retry'}</button></div>}
    {selected && info && connectedId === selectedId && <AgentWorkspace {...appearance} key={selected.id} connection={selected} info={info} language={language} agents={agents}
      onReconnect={() => { void api().disconnect(selectedId).then(() => setReconnect(value => value + 1)).catch(error => setError(errorText(error))); }}
      onEdit={() => setEditing(selected)}/>}
    {(adding || editing) && <AgentConnectionForm language={language} initial={editing} onClose={() => { setAdding(false); setEditing(undefined); }} onRemove={editing ? async () => {
      await api().remove(editing.id); if (selectedId === editing.id) onSelect(''); setEditing(undefined); await onRefresh();
    } : undefined} onSave={async input => {
      const next = await api().save(input); await onRefresh(); setAdding(false); setEditing(undefined); onSelect(input.id || next.at(-1)!.id); setReconnect(value => value + 1);
    }}/>}
  </div>;
}

function AgentWorkspace({ connection, info, language, agents, onReconnect, onEdit, ...appearance }: { connection: AgentConnection; info: AgentInfo; language: AppLanguage; agents: AgentConnectionsController; onReconnect: () => void; onEdit: () => void } & AgentChatAppearance) {
  const zh = language === 'zh';
  const call = useCallback<Call>(async (operation, input) => await api().call(connection.id, operation, input) as never, [connection.id]);
  const { refreshSessions } = agents;
  const sessionId = agents.selectedSessions[connection.id] ?? '';
  const sessions = agents.sessionsByAgent[connection.id]?.sessions ?? [];
  const [models, setModels] = useState<Models>({ defaultModelId: '', models: [] });
  const chatPreferences = useAgentChatPreferences(connection.id, models.defaultModelId);
  // The shared-conversation protocol added visionEnabled to chat.send.
  const visualInputAvailable = info.capabilities.sharedConversation === true;
  const [projects, setProjects] = useState<Projects>({ projects: [], defaultProjectId: null });
  const [error, setError] = useState('');
  const creating = agents.sessionsByAgent[connection.id]?.creating;
  const refresh = useCallback(async () => {
    const [models, projects] = await Promise.all([call<Models>('product.command', { kind: 'models.get' }), call<Projects>('projects.list'), refreshSessions(connection.id)]);
    setModels(models); setProjects(projects); setError('');
  }, [call, connection.id, refreshSessions]);
  useEffect(() => { let alive = true; void refresh().catch(error => { if (alive) setError(errorText(error)); }); return () => { alive = false; }; }, [refresh]);
  useEffect(() => {
    const updated = (event: Event) => { if ((event as CustomEvent<string>).detail === connection.id) void refresh().catch(error => setError(errorText(error))); };
    window.addEventListener('cardbush:agent-settings-updated', updated);
    return () => window.removeEventListener('cardbush:agent-settings-updated', updated);
  }, [connection.id, refresh]);
  const create = () => agents.createSession(connection.id, zh ? '新对话' : 'New conversation');
  const manage = () => appearance.onOpenSettings?.(connection.id, 'models');
  const title = String(sessions.find(item => item.sessionId === sessionId)?.metadata?.title || connection.name);
  const headerActions = <div className="agent-header-actions">
      <button className="topbar-inspector-action" onClick={onEdit}>{zh ? '连接设置' : 'Connection settings'}</button>
      <button className="topbar-inspector-action icon-only" title={zh ? '刷新连接' : 'Refresh connection'} aria-label={zh ? '刷新连接' : 'Refresh connection'} onClick={onReconnect}><RefreshCw size={15}/></button>
      <button className="topbar-inspector-action icon-only" title={zh ? '新建会话' : 'New chat'} aria-label={zh ? '新建会话' : 'New chat'} disabled={creating} onClick={() => void create()}><Plus size={16}/></button>
      <button className="topbar-inspector-action icon-only agent-manage" title={zh ? '管理此 Agent' : 'Manage Agent'} aria-label={zh ? '管理此 Agent' : 'Manage Agent'} onClick={manage}><Settings size={15}/></button>
    </div>;
  return <div className="agent-workspace">
    {(!sessionId) && <TopBar title={title} language={language} inspectorOpen={false} workspaceControl={headerActions}/>}
    {error && <div className="agents-error" role="alert">{error}</div>}
    {sessionId ? <AgentChat {...appearance} title={title} headerActions={headerActions} onCreate={() => void create()} key={`${connection.id}:${sessionId}`} call={call} enhanced={Boolean(info.capabilities.conversationUi)} management={Boolean(info.capabilities.conversationManagement)} sharedSettings={info.capabilities.sharedSettings === true} visualInputAvailable={visualInputAvailable} chatPreferences={chatPreferences} connectionId={connection.id} sessionId={sessionId} language={language} models={models} projects={projects} onChanged={refresh} onConfigure={() => appearance.onOpenSettings?.(connection.id, 'models')} onOpenSession={id => agents.select(connection.id, id)}/>
      : <div className="agents-empty"><h2>{zh ? '有什么可以帮你？' : 'How can I help?'}</h2><p>{zh ? `与 ${connection.name} 开始新对话，或从左侧选择会话。` : `Start a chat with ${connection.name}, or select one in the sidebar.`}</p><button className="agents-primary" disabled={creating} onClick={() => void create()}><Plus size={16}/>{zh ? '开始对话' : 'Start chat'}</button></div>}
  </div>;
}

function AgentChat({ call, sharedSettings, enhanced, management, visualInputAvailable, chatPreferences, connectionId, sessionId, language, models, projects, onChanged, onConfigure, onOpenSession, title, headerActions, onCreate, theme = 'dark', sidebarCollapsed = false, windowMaximized = false, thinkingVisible = true, guidanceDeliveryMode = 'queue', visualInputEnabled = false }: { call: Call; sharedSettings: boolean; enhanced: boolean; management: boolean; visualInputAvailable: boolean; chatPreferences: ReturnType<typeof useAgentChatPreferences>; connectionId: string; sessionId: string; language: AppLanguage; models: Models; projects: Projects; onChanged: () => Promise<void>; onConfigure: () => void; onOpenSession: (id: string) => void; title: string; headerActions: ReactNode; onCreate: () => void } & AgentChatAppearance) {
  const zh = language === 'zh'; const storageKey = `cardbush-agent-draft:${connectionId}:${sessionId}`;
  const submittedRef = useRef<() => void>(() => {});
  const connection = useMemo(() => createAgentConversationBackend(call, connectionId,
    (request, listener) => api().watchEvents(connectionId, request, listener), { enhanced, sharedSettings, visualInputAvailable, onSubmitted: () => submittedRef.current() }), [call, connectionId, enhanced, visualInputAvailable, sharedSettings]);
  const [preferences, setPreferences] = chatPreferences;
  const disabledSkills = useMemo(() => new Set(preferences.disabledSkills), [preferences.disabledSkills]);
  const availableModels = useMemo(() => [...models.models].sort((a, b) => Number(b.id === models.defaultModelId) - Number(a.id === models.defaultModelId)), [models]);
  const chat = useCardbushChat(availableModels, models.models, { runtimeReady: models.models.length > 0,
    language, reasoningTraceVisible: thinkingVisible, standardImageInputEnabled: visualInputAvailable && (preferences.visionEnabled ?? visualInputEnabled), disabledSkillNames: disabledSkills,
    interactiveRequestsAvailable: enhanced, contextWindowUsageAvailable: true, workspaceChangesAvailable: true,
  }, connection.backend);
  const { host: baseHost, skills, error: hostError, preview } = useAgentConversationHost(call, connectionId, sessionId, enhanced, management);
  const inspector = useContext(ConversationInspectorContext);
  const inspectorRef = useRef(inspector); inspectorRef.current = inspector;
  const [summary, setSummary] = useState<WorkSummaryInspectorDetail>();
  const summaryId = `agent-summary:${baseHost.id}`;
  const previewId = `agent-file:${baseHost.id}`;
  const openWorkSummary = useCallback((detail: WorkSummaryInspectorDetail) => {
    setSummary({ ...detail, sessionId: detail.sessionId || sessionId });
    inspectorRef.current?.open(summaryId, detail.title || (language === 'zh' ? '执行详情' : 'Execution details'));
  }, [sessionId, summaryId, language]);
  const host = useMemo(() => ({ ...baseHost, sessionId, runtime: connection.runtime, openWorkSummary }), [baseHost, sessionId, connection, openWorkSummary]);
  useEffect(() => { if (preview) inspectorRef.current?.open(previewId, preview.name); }, [preview, previewId]);
  useEffect(() => () => { inspectorRef.current?.close(summaryId); inspectorRef.current?.close(previewId); }, [summaryId, previewId]);
  const [draft, setDraft] = useState(() => sessionStorage.getItem(storageKey) ?? '');
  useEffect(() => { sessionStorage.setItem(storageKey, draft); }, [draft, storageKey]);
  useEffect(() => { void chat.openStoredConversation(sessionId); }, [sessionId, chat.openStoredConversation]);
  useEffect(() => {
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<{ connectionId: string; sessionId: string }>).detail;
      if (detail?.connectionId === connectionId && detail.sessionId === sessionId) void chat.refreshActiveSession({ silent: true }).catch(() => {});
    };
    window.addEventListener('cardbush:agent-session-updated', refresh);
    return () => window.removeEventListener('cardbush:agent-session-updated', refresh);
  }, [connectionId, sessionId, chat.refreshActiveSession]);
  const selectedModel = models.models.find(model => model.id === chat.selectedModel);
  const maxContextTokens = selectedModel?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
  const workspaceRoot = chat.activeConversation ? conversationWorkspaceRoot(chat.activeConversation) : undefined;
  const reports = useMemo(() => changeReportsFromMessages(chat.activeMessages), [chat.activeMessages]);
  const [error, setError] = useState('');
  submittedRef.current = () => { void onChanged().catch(error => setError(`${zh ? '消息已接收，会话列表刷新失败：' : 'Message accepted; conversation refresh failed: '}${errorText(error)}`)); };
  const [reverting, setReverting] = useState('');
  const busy = chat.sending || chat.stopping;
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
  const [review, setReview] = useState<{ path: string; turnId?: string; requestId: string }>();
  const [comments, setComments] = useState<ReviewCommentState>(emptyReviewComments);
  const openReview = (path = '', turnId?: string) => {
    setReview({ path, turnId, requestId: crypto.randomUUID() });
    inspector?.open(reviewId, zh ? '审查' : 'Review');
  };
  const reviewOutlet = inspector?.outlets.get(reviewId);
  const projectPicker = projects.projects.length > 0 && <div className="agent-project-picker"><SettingsDropdown label={zh ? '会话项目' : 'Conversation project'} disabled={busy} value={chat.activeConversation?.projectId ?? ''}
    onChange={projectId => void call('sessions.bind', { sessionId, projectId: projectId || null }).then(async () => { await chat.refreshActiveSession({ silent: true }); await onChanged(); }).catch(error => setError(errorText(error)))} options={[
      { value: '', label: zh ? '独立目录' : 'Private workspace', disabled: !management },
      ...projects.projects.map(project => ({ value: project.id, label: project.name, icon: <Folder size={14}/> })),
    ]}/></div>;
  return <ConversationHostContext.Provider value={host}><ConversationExtractionProvider api={connection.extracts} activeSessionId={sessionId} contextWindowTokens={maxContextTokens}
    language={language} onOpen={onOpenSession} onFork={async sessionId => { const next = await call<{ sessionId: string }>('sessions.fork', { sessionId }); await onChanged(); onOpenSession(next.sessionId); }}>
    <WorkspaceChangeStateContext.Provider value={{ states: emptyStates, busy: busy || Boolean(reverting) }}>
    <section className="agent-chat">
      <ChatPanel language={language} theme={theme} title={title} headerActions={headerActions}
        sidebarCollapsed={sidebarCollapsed} windowMaximized={windowMaximized} inspectorOpen={inspector?.visible ?? false} onToggleInspector={() => openReview()}
        activeConversationId={host.id} activeProjectDir={workspaceRoot} projectPathAliases={[]} selectedProjectDir="" availableProjects={[]} onWelcomeProjectChange={noAction}
        messages={chat.activeMessages} changeReports={reports} activeTurnId={chat.activeTurnId}
        loading={chat.loading || !chat.activeConversationId} historyLoading={chat.messagesLoading} sending={chat.sending} stopping={chat.stopping}
        welcomeEnabled={false} turnHistoryAvailable subagentObservabilityAvailable thinkingVisible={thinkingVisible} guidanceDeliveryMode={guidanceDeliveryMode}
        activeGoal={chat.activeGoal} goalAvailable={chat.goalAvailable} goalCancelling={chat.activeGoalCancelling} goalWaiting={chat.activeGoalWaiting} shadowAvailable={false} shadowAccentColor="" shadowThemeVariables={{}}
        queuedMessageCount={chat.queuedMessageCount} queuedMessagePreview={chat.queuedMessagePreview} queuedMessages={chat.queuedMessages}
        pendingInteraction={chat.pendingInteraction ? { ...chat.pendingInteraction, sessionId: host.id } : null}
        connectionRecovery={chat.activeConnectionRecovery} composerAccessory={projectPicker}
        error={error || hostError || chat.error} notice={chat.notice} onClearError={() => { setError(''); chat.clearError(); }} onClearNotice={chat.clearNotice}
        draft={draft} onDraftChange={setDraft} selectedModel={chat.selectedModel} selectedModelConfig={selectedModel} availableModels={models.models} onModelChange={chat.setSelectedModel} onConfigureModels={onConfigure}
        contextWindowMaxTokens={maxContextTokens} contextWindowUsage={chat.activeContextWindowUsage}
        permissionMode={chat.permissionMode} onPermissionModeChange={chat.setPermissionMode} subagentPermissionRouting={chat.subagentPermissionRouting} onSubagentPermissionRoutingChange={chat.setSubagentPermissionRouting}
        referencePlanAvailable={enhanced} referencePlanMode={chat.referencePlanMode} onReferencePlanModeChange={chat.setReferencePlanMode}
        reasoningLevelAvailable={enhanced} reasoningLevel={chat.reasoningLevel} reasoningLevels={['none', 'low', 'medium', 'high', 'xhigh', 'max']} onReasoningLevelChange={chat.setReasoningLevel}
        skills={skills} disabledSkillNames={disabledSkills} onToggleSkill={(name, enabled) => setPreferences(current => ({ ...current, disabledSkills: enabled ? current.disabledSkills.filter(item => item !== name) : [...new Set([...current.disabledSkills, name])] }))}
        onSend={async text => { setDraft(''); await chat.sendMessage(text); if (connection.unconfirmedText(sessionId)) setDraft(current => current || text); await onChanged().catch(error => setError(errorText(error))); }} onCancel={() => chat.cancelSending()}
        onRefreshActiveSession={chat.refreshActiveSession} onCreateConversation={onCreate} onOpenConversation={onOpenSession}
        onRetryMessage={chat.retryFailedUserMessage} onRegenerate={chat.regenerateAssistantMessage} onEditUserMessage={chat.editUserMessageAndRegenerate}
        onGuideMessage={async (message, text, mode) => { await chat.sendTurnGuidance({ ...message, conversationId: sessionId }, text, mode); setDraft(''); }} onRetryGuidance={chat.retryTurnGuidance}
        onGuideQueuedMessage={chat.sendQueuedMessageAsGuidance} onRemoveQueuedMessage={chat.removeQueuedMessage} onReorderQueuedMessage={chat.reorderQueuedMessage}
        onRevertChangeReport={revert} onOpenChangeReview={openReview} onReplyInteraction={chat.replyToInteraction} onCancelInteraction={chat.cancelPendingInteraction} onCancelGoal={chat.cancelActiveGoal}/>
      {review && reviewOutlet && createPortal(<ConversationChangeDialog key={review.turnId ?? ''} embedded language={language}
        conversation={chat.activeConversation ?? { id: sessionId, title, updatedAt: '', preview: '' }}
        reports={reports} turns={recentReviewTurns(chat.activeMessages)} initialFilePath={review.path} initialTurnId={review.turnId} selectionRequestId={review.requestId}
        reviewComments={comments} onReviewCommentsChange={setComments} onComposeReviewComments={items => {
          setDraft(current => appendReviewCommentsToDraft(current, items, language)); inspector?.close(reviewId);
          requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('.agent-chat [data-composer-input]')?.focus({ preventScroll: true }));
        }} notice={error} revertingChangeId={reverting} revertedChangeIds={new Set(reports.filter(report => report.reverted).map(report => report.id))}
        revertAvailable={!busy} onClose={() => inspector?.close(reviewId)} onRevert={revert}/>, reviewOutlet)}
      {summary && inspector?.outlets.get(summaryId) && createPortal(<WorkSummaryInspector detail={summary} messages={chat.activeMessages} language={language}/>, inspector.outlets.get(summaryId)!)}
      {preview && inspector?.outlets.get(previewId) && createPortal(<ConversationHostPreview key={preview.path} path={preview.path} language={language}/>, inspector.outlets.get(previewId)!)}
    </section>
    </WorkspaceChangeStateContext.Provider></ConversationExtractionProvider></ConversationHostContext.Provider>;
}
