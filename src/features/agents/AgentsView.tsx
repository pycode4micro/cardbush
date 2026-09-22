import { createPortal } from 'react-dom';
import { useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Folder, LoaderCircle, Plus, RefreshCw, Server, Settings, Trash2, Unplug, X } from 'lucide-react';
import type { AgentConnection, AgentInfo, AgentOperation, AgentProject } from '../../../electron/agentTypes';
import type { AppLanguage, ManagedModelConfig, ThemeMode } from '../../types';
import { DEFAULT_MAX_CONTEXT_TOKENS } from '@cardbush/bush-product-agent';
import { useAgentChatPreferences } from './agentChatPreferences';
import './agents.css';
import { AgentConnectionForm } from './AgentConnectionForm';
import { AgentMcpSettings } from './AgentMcpSettings';
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
import { SettingsSwitch } from '../settings/SettingsControls';
import { appendReviewCommentsToDraft, emptyReviewComments, type ReviewCommentState } from '../sidebar/reviewCommentModel';
import { agentErrorText as errorText } from './agentErrorText';

type Call = <T = unknown>(operation: AgentOperation, input?: Record<string, unknown>) => Promise<T>;
type Models = { defaultModelId: string; models: ManagedModelConfig[] };
type Projects = { projects: AgentProject[]; defaultProjectId: string | null };
const api = () => { const value = window.cardbushDesktop?.agents; if (!value) throw new Error('Agent connections are unavailable.'); return value; };

type AgentChatAppearance = { theme?: ThemeMode; sidebarCollapsed?: boolean; windowMaximized?: boolean; thinkingVisible?: boolean; guidanceDeliveryMode?: 'queue' | 'immediate' };
type AgentSettingsSection = 'projects' | 'models' | 'plugins' | 'instructions';
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
      <div className="agents-cards">{connections.map(item => <button key={item.id} className="agents-card" onClick={() => onSelect(item.id)}><Server size={24}/><strong>{item.name}</strong><span>{item.migrationIssue || item.url}</span></button>)}
      <button className="agents-card" onClick={() => setAdding(true)}><Plus size={24}/><strong>{zh ? '添加连接' : 'Add connection'}</strong><span>HTTP / HTTPS</span></button></div></div>}
    {connecting && <div className="agents-empty"><LoaderCircle className="spin"/>{zh ? '正在连接 Agent…' : 'Connecting…'}</div>}
    {!error && selected?.connectionState === 'reconnecting' && <div className="agents-error" role="status">{zh ? '正在自动重连：' : 'Reconnecting: '}{selected.connectionError}<button onClick={() => setEditing(selected)}>{zh ? '连接设置' : 'Connection settings'}</button></div>}
    {error && <div className="agents-error" role="alert">{selected?.connectionState === 'reconnecting' ? (zh ? '正在自动重连：' : 'Reconnecting: ') + (selected.connectionError || error) : error}{selected && <button onClick={() => setEditing(selected)}>{zh ? '连接设置' : 'Connection settings'}</button>}<button onClick={() => setReconnect(value => value + 1)}>{zh ? '重试' : 'Retry'}</button>{selected && <button onClick={() => void api().remove(selected.id).then(async () => { onSelect(''); await onRefresh(); }).catch(error => setError(errorText(error)))}>{zh ? '移除此连接' : 'Remove connection'}</button>}</div>}
    {selected && info && connectedId === selectedId && <AgentWorkspace {...appearance} key={selected.id} connection={selected} info={info} language={language} agents={agents}
      onReconnect={() => { void api().disconnect(selectedId).then(() => setReconnect(value => value + 1)).catch(error => setError(errorText(error))); }}
      onEdit={() => setEditing(selected)} onRemove={async () => { await api().remove(selected.id); onSelect(''); await onRefresh(); }}/>}
    {(adding || editing) && <AgentConnectionForm language={language} initial={editing} onClose={() => { setAdding(false); setEditing(undefined); }} onSave={async input => {
      const next = await api().save(input); await onRefresh(); setAdding(false); setEditing(undefined); onSelect(input.id || next.at(-1)!.id); setReconnect(value => value + 1);
    }}/>}
  </div>;
}

function AgentWorkspace({ connection, info, language, agents, onReconnect, onRemove, onEdit, ...appearance }: { connection: AgentConnection; info: AgentInfo; language: AppLanguage; agents: AgentConnectionsController; onReconnect: () => void; onRemove: () => Promise<void>; onEdit: () => void } & AgentChatAppearance) {
  const zh = language === 'zh';
  const call = useCallback<Call>(async (operation, input) => await api().call(connection.id, operation, input) as never, [connection.id]);
  const { refreshSessions } = agents;
  const sessionId = agents.selectedSessions[connection.id] ?? '';
  const sessions = agents.sessionsByAgent[connection.id]?.sessions ?? [];
  const [models, setModels] = useState<Models>({ defaultModelId: '', models: [] });
  const chatPreferences = useAgentChatPreferences(connection.id, models.defaultModelId);
  // The shared-conversation protocol added visionEnabled to chat.send.
  const visualInputAvailable = info.capabilities.sharedConversation === true;
  const [preferences, setPreferences] = chatPreferences;
  const [projects, setProjects] = useState<Projects>({ projects: [], defaultProjectId: null });
  const [settingsReady, setSettingsReady] = useState(false);
  const [settingsSection, setSettingsSection] = useState<AgentSettingsSection>('projects');
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
  const headerActions = <div className="agent-header-actions">
      <button className="topbar-inspector-action" onClick={onEdit}>{zh ? '连接设置' : 'Connection settings'}</button>
      <button className="topbar-inspector-action icon-only" title={zh ? '刷新连接' : 'Refresh connection'} aria-label={zh ? '刷新连接' : 'Refresh connection'} onClick={onReconnect}><RefreshCw size={15}/></button>
      <button className="topbar-inspector-action icon-only" title={zh ? '新建会话' : 'New chat'} aria-label={zh ? '新建会话' : 'New chat'} disabled={creating} onClick={() => void create()}><Plus size={16}/></button>
      <button className={`topbar-inspector-action icon-only agent-manage${tab === 'settings' ? ' active' : ''}`} aria-pressed={tab === 'settings'} title={tab === 'settings' ? zh ? '返回对话' : 'Return to chat' : zh ? '管理此 Agent' : 'Manage Agent'} aria-label={tab === 'settings' ? zh ? '返回对话' : 'Return to chat' : zh ? '管理此 Agent' : 'Manage Agent'} onClick={manage}><Settings size={15}/></button>
    </div>;
  return <div className="agent-workspace">
    {(tab === 'settings' || !sessionId) && <TopBar title={title} language={language} inspectorOpen={false} workspaceControl={headerActions}/>}
    {error && <div className="agents-error" role="alert">{error}</div>}
    {tab === 'settings' ? settingsReady ? <AgentSettings call={call} language={language} models={models} projects={projects} onRefresh={refresh} onRemove={onRemove} connection={connection} initialSection={settingsSection}
        visualInputAvailable={visualInputAvailable} visualInputEnabled={visualInputAvailable && preferences.visionEnabled} onVisualInputEnabledChange={visionEnabled => setPreferences(current => ({ ...current, visionEnabled }))}/>
      : !error && <div className="agents-empty" role="status"><LoaderCircle className="spin"/>{zh ? '正在加载设置…' : 'Loading settings…'}</div>
      : sessionId ? <AgentChat {...appearance} title={title} headerActions={headerActions} onCreate={() => void create()} key={`${connection.id}:${sessionId}`} call={call} enhanced={Boolean(info.capabilities.conversationUi)} management={Boolean(info.capabilities.conversationManagement)} visualInputAvailable={visualInputAvailable} chatPreferences={chatPreferences} connectionId={connection.id} sessionId={sessionId} language={language} models={models} projects={projects} onChanged={refresh} onConfigure={() => { setSettingsSection('models'); agents.select(connection.id, undefined, 'settings'); }} onOpenSession={id => agents.select(connection.id, id)}/>
      : <div className="agents-empty"><h2>{zh ? '有什么可以帮你？' : 'How can I help?'}</h2><p>{zh ? `与 ${connection.name} 开始新对话，或从左侧选择会话。` : `Start a chat with ${connection.name}, or select one in the sidebar.`}</p><button className="agents-primary" disabled={creating} onClick={() => void create()}><Plus size={16}/>{zh ? '开始对话' : 'Start chat'}</button></div>}
  </div>;
}

function AgentChat({ call, enhanced, management, visualInputAvailable, chatPreferences, connectionId, sessionId, language, models, projects, onChanged, onConfigure, onOpenSession, title, headerActions, onCreate, theme = 'dark', sidebarCollapsed = false, windowMaximized = false, thinkingVisible = true, guidanceDeliveryMode = 'queue' }: { call: Call; enhanced: boolean; management: boolean; visualInputAvailable: boolean; chatPreferences: ReturnType<typeof useAgentChatPreferences>; connectionId: string; sessionId: string; language: AppLanguage; models: Models; projects: Projects; onChanged: () => Promise<void>; onConfigure: () => void; onOpenSession: (id: string) => void; title: string; headerActions: ReactNode; onCreate: () => void } & AgentChatAppearance) {
  const zh = language === 'zh'; const storageKey = `cardbush-agent-draft:${connectionId}:${sessionId}`;
  const submittedRef = useRef<() => void>(() => {});
  const connection = useMemo(() => createAgentConversationBackend(call, connectionId,
    (request, listener) => api().watchEvents(connectionId, request, listener), { enhanced, visualInputAvailable, onSubmitted: () => submittedRef.current() }), [call, connectionId, enhanced, visualInputAvailable]);
  const [preferences, setPreferences] = chatPreferences;
  const disabledSkills = useMemo(() => new Set(preferences.disabledSkills), [preferences.disabledSkills]);
  const availableModels = useMemo(() => [...models.models].sort((a, b) => Number(b.id === models.defaultModelId) - Number(a.id === models.defaultModelId)), [models]);
  const chat = useCardbushChat(availableModels, models.models, { runtimeReady: models.models.length > 0,
    language, reasoningTraceVisible: thinkingVisible, standardImageInputEnabled: visualInputAvailable && preferences.visionEnabled, disabledSkillNames: disabledSkills,
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

function AgentSettings({ call, language, models, projects, onRefresh, onRemove, connection, initialSection, visualInputAvailable, visualInputEnabled, onVisualInputEnabledChange }: { call: Call; language: AppLanguage; models: Models; projects: Projects; onRefresh: () => Promise<void>; onRemove: () => Promise<void>; connection: AgentConnection; initialSection: AgentSettingsSection; visualInputAvailable: boolean; visualInputEnabled: boolean; onVisualInputEnabledChange: (enabled: boolean) => void }) {
  const zh = language === 'zh'; const [section, setSection] = useState<AgentSettingsSection>(initialSection);
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
    {section === 'models' && <><h3>{zh ? '模型配置' : 'Models'}</h3><SettingsSwitch
      title={zh ? '视觉功能' : 'Vision input'}
      subtitle={visualInputAvailable
        ? (zh ? '允许此 Agent 的模型直接接收图片。请使用支持视觉输入的模型；关闭后仍可通过文件工具处理图片。选择自动保存到本机。' : 'Allow this Agent’s model to receive images directly. Use a vision-capable model; file tools remain available when off. Your choice is saved on this device.')
        : (zh ? '更新此 Agent 服务后可开启视觉输入。关闭时仍可通过文件工具处理图片。' : 'Update this Agent service to enable vision input. File tools can still process images while it is off.')}
      checked={visualInputEnabled} disabled={!visualInputAvailable} onChange={onVisualInputEnabledChange}/>
    <form className="agents-form" onSubmit={event => { event.preventDefault(); void act(async () => {
      for (const model of modelDraft.models) {
        if (model.maxCompletionTokens !== undefined && model.maxCompletionTokens >= (model.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS)) {
          throw new Error(zh ? '最大输出 tokens 必须小于上下文上限。' : 'Maximum output tokens must be below the context limit.');
        }
      }
      const saved = await call<Models>('product.command', { kind: 'models.update', config: modelDraft }); setModelDraft(saved);
    }); }}>{modelDraft.models.map((model, index) => {
      const update = (key: keyof ManagedModelConfig, value: string | number | undefined) => setModelDraft(current => ({ ...current, models: current.models.map((item, i) => i === index ? { ...item, [key]: value } : item) }));
      return <fieldset key={model.id}><legend>{model.modelName || (zh ? '新模型' : 'New model')}</legend>
        <label>{zh ? '模型名称' : 'Model name'}<input required value={model.modelName} onChange={event => update('modelName', event.target.value)}/></label>
        <label>{zh ? 'API 地址' : 'API base URL'}<input type="url" value={model.baseUrl} placeholder="https://api.openai.com/v1" onChange={event => update('baseUrl', event.target.value)}/></label>
        <label>API Key<input autoComplete="off" type="password" value={model.apiKey} placeholder={model.hasApiKey ? zh ? '已保存，留空保留' : 'Saved; leave blank to keep' : ''} onChange={event => update('apiKey', event.target.value)}/></label>
        <label>{zh ? '上下文上限' : 'Context tokens'}<input aria-label={zh ? '上下文上限' : 'Context tokens'} type="number" min="1" step="1" placeholder={String(DEFAULT_MAX_CONTEXT_TOKENS)} value={model.maxContextTokens ?? ''} onChange={event => update('maxContextTokens', event.target.value ? event.target.valueAsNumber : undefined)}/></label>
        <label>{zh ? '最大输出 tokens' : 'Maximum output tokens'}<input aria-label={zh ? '最大输出 tokens' : 'Maximum output tokens'} type="number" min="1" step="1" placeholder={zh ? '供应商默认' : 'Provider default'} value={model.maxCompletionTokens ?? ''} onChange={event => update('maxCompletionTokens', event.target.value ? event.target.valueAsNumber : undefined)}/></label>
        <button type="button" onClick={() => setModelDraft(current => ({ ...current, models: current.models.filter(item => item.id !== model.id) }))}><Trash2 size={15}/>{zh ? '移除模型' : 'Remove model'}</button></fieldset>;
    })}<label>{zh ? '默认模型' : 'Default model'}<select value={modelDraft.defaultModelId} onChange={event => setModelDraft(current => ({ ...current, defaultModelId: event.target.value }))}><option value="">{zh ? '选择模型' : 'Select model'}</option>{modelDraft.models.map(model => <option key={model.id} value={model.id}>{model.modelName}</option>)}</select></label><footer><button type="button" onClick={() => setModelDraft(current => ({ ...current, models: [...current.models, { id: crypto.randomUUID(), provider: 'openai', modelName: '', apiKey: '', baseUrl: '' }] }))}><Plus size={15}/>{zh ? '新增模型' : 'Add model'}</button><button className="agents-primary" disabled={busy}>{zh ? '保存模型' : 'Save models'}</button></footer></form></>}
    {section === 'plugins' && <><h3>{zh ? '已安装插件' : 'Installed plugins'}</h3>{plugins?.plugins.map(plugin => <div key={plugin.id} className="agent-settings-row"><div><strong>{plugin.name}</strong><small>{plugin.description}</small></div><button disabled={busy} onClick={() => void act(async () => { const saved = await call<typeof plugins>('product.command', { kind: 'apps.update', config: { ...plugins, expectedRevision: plugins.revision, plugins: plugins.plugins.map(item => item.id === plugin.id ? { ...item, installed: true, enabled: !item.enabled } : item) } }); setPlugins(saved); })}>{plugin.enabled ? zh ? '禁用' : 'Disable' : zh ? '启用' : 'Enable'}</button></div>)}<form className="agents-form" onSubmit={event => { event.preventDefault(); void act(async () => { await call('plugins.install', { path: pluginPath }); setPlugins(await call('product.command', { kind: 'apps.get' })); setPluginPath(''); }); }}><label>{zh ? '服务器上的插件目录' : 'Plugin directory on the server'}<input required value={pluginPath} onChange={event => setPluginPath(event.target.value)} placeholder="/srv/cardbush-plugins/my-plugin"/></label><button disabled={busy}>{zh ? '安装 / 更新' : 'Install / update'}</button></form><p>{zh ? '插件安装、运行和凭据均留在该 Agent 主机。此服务不提供桌面鼠标或图形浏览器控制。' : 'Plugins run on this Agent host. Desktop mouse and graphical browser control are unavailable.'}</p></>}
    {section === 'plugins' && <AgentMcpSettings call={call} language={language}/>}
    {section === 'instructions' && instructions && <form className="agents-form" onSubmit={event => { event.preventDefault(); void act(async () => setInstructions(await call('instructions.save', instructions))); }}><h3>AGENTS.md</h3><textarea aria-label="AGENTS.md" rows={14} value={instructions.content} onChange={event => setInstructions({ ...instructions, content: event.target.value })}/><button disabled={busy}>{zh ? '保存指令' : 'Save instructions'}</button></form>}
    <div className="agent-remove"><button onClick={() => setConfirmRemove(value => !value)}><Unplug size={16}/>{zh ? '移除此连接' : 'Remove connection'}</button>{confirmRemove && <p>{zh ? '仅移除此连接，Agent 服务、历史和任务继续保留。' : 'Only remove this connection. The Agent service, history and tasks are preserved.'}<button onClick={() => void act(onRemove)}>{zh ? '确认移除' : 'Confirm removal'}</button></p>}</div>
  </div></div>;
}
