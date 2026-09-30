import { createPortal } from 'react-dom';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, CircleStop, LoaderCircle, RefreshCw, TriangleAlert } from 'lucide-react';
import { DEFAULT_MAX_CONTEXT_TOKENS } from '@cardbush/bush-product-agent';
import * as api from '../../backend/api';
import { conversationRuntime, type ConversationRuntime } from '../../backend/conversationRuntime';
import { localConversationBackend, type ConversationBackend } from '../../backend/conversationBackend';
import { useCardbushChat } from '../../hooks/useCardbushChat';
import type { AppLanguage, ChatMessage, ManagedModelConfig, SubagentTaskSnapshot, ThemeMode } from '../../types';
import { ChatPanel } from '../chat/ChatPanel';
import { ConversationHostContext, ConversationMessageTargetContext, type ConversationHost } from '../conversationHost';
import { createAgentConversationBackend, type AgentCall } from '../agents/agentConversationBackend';
import { useAgentConversationHost } from '../agents/useAgentConversationHost';
import { ConversationInspectorContext } from '../inspector/ConversationInspector';
import { ConversationHostPreview } from '../inspector/ConversationHostPreview';
import { ConversationChangeDialog } from '../sidebar/ChatSidebar';
import { recentReviewTurns } from '../sidebar/reviewModel';
import { WorkspaceChangeStateContext } from '../tools/WorkspaceChangeStateContext';
import { changeReportsFromMessages, type ConversationChangeReport } from '../tools/toolChangeReports';
import { conversationWorkspaceRoot } from '../conversationWorkspace';
import { useConversationViewState, conversationViewKey } from '../../shared/conversationViewState';
import { subagentConversationBackend } from './subagentConversationBackend';
import { subagentTaskPresentation } from './subagentTaskPresentation';
import './subagent-conversation.css';

export type SubagentConversationOptions = {
  theme?: ThemeMode;
  thinkingVisible?: boolean;
  guidanceDeliveryMode?: 'queue' | 'immediate';
  visualInputEnabled?: boolean;
  disabledSkillNames?: Set<string>;
  onToggleSkill?: (name: string, enabled: boolean) => void;
  onConfigureModels?: () => void;
};
type Props = SubagentConversationOptions & {
  task: SubagentTaskSnapshot; parentSessionId: string; language: AppLanguage; active: boolean;
  refresh: () => Promise<void>; refreshing: boolean; error: string;
};
const emptyStates = new Map<string, boolean>();
const noSkills = new Set<string>();
const nothing = () => {};
const nothingAsync = async () => {};

export function SubagentConversation(props: Props) {
  const parentHost = useContext(ConversationHostContext);
  const connectionId = props.task.remote?.connectionId || parentHost?.environmentId;
  const parentRuntime = parentHost?.runtime;
  const readTasks = useCallback(() => api.fetchSubagentTasks(props.parentSessionId, { limit: 1000 }, parentRuntime), [props.parentSessionId, parentRuntime]);
  if (!props.task.childSessionId) return <p className="subagent-conversation-pending" role="status">{props.language === 'zh' ? '正在创建子会话…' : 'Creating child conversation…'}</p>;
  return connectionId
    ? <RemoteChildConversation key={`${connectionId}:${props.task.childSessionId}`} {...props} connectionId={connectionId} readTasks={readTasks}/>
    : <LocalChildConversation key={props.task.childSessionId} {...props} readTasks={readTasks}/>;
}

function LocalChildConversation(props: Props & { readTasks: () => Promise<SubagentTaskSnapshot[]> }) {
  const runtime = useMemo(() => { const value = conversationRuntime(); return { ...value, client: value.client, answerPermission: value.answerPermission.bind(value), dispose: nothing }; }, []);
  return <SubagentConversationView {...props} runtime={runtime} base={localConversationBackend}/>;
}

function RemoteChildConversation({ connectionId, ...props }: Props & { connectionId: string; readTasks: () => Promise<SubagentTaskSnapshot[]> }) {
  const call = useCallback<AgentCall>(async (operation, input) => {
    const desktop = window.cardbushDesktop?.agents;
    if (!desktop) throw new Error('Agent connections are unavailable.');
    return await desktop.call(connectionId, operation, input) as never;
  }, [connectionId]);
  const connection = useMemo(() => createAgentConversationBackend(call, connectionId,
    (request, listener) => window.cardbushDesktop!.agents!.watchEvents(connectionId, request, listener),
    { enhanced: true, sharedSettings: true, visualInputAvailable: true }), [call, connectionId]);
  const { host: baseHost, preview, closePreview, error } = useAgentConversationHost(call, connectionId, props.task.childSessionId!, true, true);
  const host = useMemo(() => ({ ...baseHost, sessionId: props.task.childSessionId!, runtime: connection.runtime }), [baseHost, props.task.childSessionId, connection]);
  const inspector = useContext(ConversationInspectorContext);
  const previewId = `subagent-file:${host.id}`;
  useEffect(() => { if (props.active && preview) inspector?.open(previewId, preview.name); }, [props.active, preview, previewId, inspector?.open]);
  useEffect(() => () => { inspector?.close(previewId); closePreview(); }, [previewId, inspector?.close, closePreview]);
  return <ConversationHostContext.Provider value={host}>
    <SubagentConversationView {...props} error={props.error || error} runtime={connection.runtime} base={connection.backend} host={host} call={call}/>
    {preview && inspector?.outlets.get(previewId) && createPortal(<ConversationHostPreview path={preview.path} language={props.language}/>, inspector.outlets.get(previewId)!)}
  </ConversationHostContext.Provider>;
}

export function SubagentConversationView({ task, language, active, refresh, refreshing, error: taskError, runtime, base, host, call, readTasks,
  theme = 'dark', thinkingVisible = true, guidanceDeliveryMode = 'queue', visualInputEnabled = false,
  disabledSkillNames = noSkills, onToggleSkill = nothing, onConfigureModels = nothing }: Props & {
  runtime: ConversationRuntime; base: ConversationBackend; host?: ConversationHost; call?: AgentCall; readTasks: () => Promise<SubagentTaskSnapshot[]>;
}) {
  const sessionId = task.childSessionId!, zh = language === 'zh';
  const [models, setModels] = useState<ManagedModelConfig[]>([]);
  const [configurationError, setConfigurationError] = useState('');
  useEffect(() => {
    let alive = true;
    const load = () => void (call ? call<{ models: ManagedModelConfig[]; defaultModelId: string }>('product.command', { kind: 'models.get' }) : api.fetchModelConfigs())
      .then(value => { if (alive) { setModels([...value.models].sort((a, b) => Number(b.id === value.defaultModelId) - Number(a.id === value.defaultModelId))); setConfigurationError(''); } })
      .catch(error => { if (alive) setConfigurationError(String(error.message ?? error)); });
    const reasoningChanged = (event: Event) => { if ((event as CustomEvent<{ connectionId: string }>).detail.connectionId === (host?.environmentId ?? '')) load(); };
    load(); window.addEventListener('cardbush:shared-configuration-updated', load);
    window.addEventListener('cardbush:model-reasoning-updated', reasoningChanged);
    return () => { alive = false; window.removeEventListener('cardbush:shared-configuration-updated', load); window.removeEventListener('cardbush:model-reasoning-updated', reasoningChanged); };
  }, [call, host?.environmentId]);
  const accepted = useRef<(() => void) | undefined>(undefined);
  const knownTask = useRef(task);
  knownTask.current = task;
  const backend = useMemo(() => subagentConversationBackend({ base, runtime, sessionId, readTasks, knownTask: () => knownTask.current,
    onSubmitted: () => accepted.current?.() }), [base, runtime, sessionId, readTasks]);
  const chat = useCardbushChat(models, models, { runtimeReady: true, activeConversationId: sessionId, viewActive: active,
    onModelReasoningChange: (id, effort) => api.saveModelReasoning(id, effort, host?.environmentId),
    language, reasoningTraceVisible: thinkingVisible, standardImageInputEnabled: visualInputEnabled, disabledSkillNames,
    interactiveRequestsAvailable: true, contextWindowUsageAvailable: true, workspaceChangesAvailable: true }, backend);
  const [draft, setDraft] = useConversationViewState(conversationViewKey(host?.environmentId, sessionId, 'subagent-draft'), () => '', Boolean);
  const [submissionPending, setSubmissionPending] = useState(false);
  const send = (text: string): Promise<boolean> => {
    if (accepted.current) return Promise.resolve(false);
    if (chat.sending) return chat.sendMessage(text).then(() => true);
    setSubmissionPending(true);
    return new Promise(resolve => {
      let settled = false;
      const finish = (ok: boolean) => { if (!settled) { settled = true; accepted.current = undefined; setSubmissionPending(false); resolve(ok); } };
      accepted.current = () => finish(true);
      void chat.sendMessage(text).then(() => finish(false), () => finish(false));
    });
  };
  const messages = useMemo(() => childConversationMessages(chat.activeMessages, task), [chat.activeMessages, task]);
  const reports = useMemo(() => changeReportsFromMessages(messages), [messages]);
  const [error, setError] = useState('');
  const [reverting, setReverting] = useState('');
  const busy = chat.sending || chat.stopping;
  const revert = async (report: ConversationChangeReport) => {
    if (!report.turnId || busy || reverting) return;
    setReverting(report.id); setError('');
    try {
      const input = { sessionId, turnIds: [report.turnId] };
      if (report.reverted) await runtime.client.restoreWorkspaceChanges(input); else await runtime.client.revertWorkspaceChanges(input);
      await chat.refreshActiveSession({ silent: true });
    } catch (error) { setError(String(error)); throw error; }
    finally { setReverting(''); }
  };
  const inspector = useContext(ConversationInspectorContext);
  const reviewId = `subagent-review:${host?.id ?? sessionId}`;
  const [review, setReview] = useState<{ path: string; turnId?: string }>();
  const openReview = (path = '', turnId?: string) => { setReview({ path, turnId }); inspector?.open(reviewId, zh ? '审查' : 'Review'); };
  useEffect(() => () => inspector?.close(reviewId), [reviewId, inspector?.close]);
  const latestReply = [...chat.activeMessages].reverse().find(message => message.role === 'assistant');
  const displayedStatus = busy ? 'running' : latestReply?.turnId !== task.childTurnId && latestReply?.status && ['completed', 'failed', 'stopped'].includes(latestReply.status)
    ? latestReply.status as SubagentTaskSnapshot['status'] : task.status;
  const status = subagentTaskPresentation({ status: displayedStatus }, language);
  const selectedModel = models.find(model => model.id === chat.selectedModel);
  const refreshAll = async () => { await refresh(); await chat.refreshActiveSession({ silent: true }); };
  return <ConversationHostContext.Provider value={host}>
    <ConversationMessageTargetContext.Provider value={`${backend.scope}:${sessionId}`}>
    <WorkspaceChangeStateContext.Provider value={{ states: emptyStates, busy: busy || !!reverting }}>
    <section className="subagent-conversation" aria-label={zh ? '子代理会话' : 'Subagent conversation'}>
      <header className="subagent-conversation-heading">
        <span className={`subagent-inspector-state ${status.tone}`}>
          {displayedStatus === 'running' ? <LoaderCircle className="spin" size={16}/> : displayedStatus === 'failed' ? <TriangleAlert size={16}/> : displayedStatus === 'stopped' ? <CircleStop size={16}/> : <CheckCircle2 size={16}/>}
        </span>
        <div><strong>{task.agentName || task.teamMemberId || (zh ? '子 Agent' : 'Subagent')}</strong><small>{zh ? '主 Agent 的子会话' : 'Child of the parent Agent'} · {status.label}</small></div>
        <button type="button" disabled={refreshing} title={zh ? '刷新会话' : 'Refresh conversation'} onClick={() => void refreshAll().catch(error => setError(String(error)))}><RefreshCw size={15} className={refreshing ? 'spin' : ''}/></button>
      </header>
      <ChatPanel embedded welcomeEnabled={false} workSummaryAvailable={false}
        language={language} theme={theme} title={task.agentName || 'Subagent'} sidebarCollapsed windowMaximized={false} inspectorOpen={false} onToggleInspector={() => openReview()}
        activeConversationId={host?.id ?? sessionId} activeProjectDir={chat.activeConversation ? conversationWorkspaceRoot(chat.activeConversation) : undefined}
        projectPathAliases={[]} selectedProjectDir="" availableProjects={[]} onWelcomeProjectChange={nothingAsync}
        messages={messages} changeReports={reports} activeTurnId={chat.activeTurnId}
        loading={chat.loading || chat.messagesLoading} historyLoading={chat.messagesLoading} sending={chat.sending} stopping={chat.stopping}
        turnHistoryAvailable subagentObservabilityAvailable={false} thinkingVisible={thinkingVisible} guidanceDeliveryMode={guidanceDeliveryMode}
        activeGoal={chat.activeGoal} goalAvailable={false} goalCancelling={chat.activeGoalCancelling} goalWaiting={chat.activeGoalWaiting}
        shadowAvailable={false} shadowAccentColor="" shadowThemeVariables={{}}
        queueLocked={chat.queueLocked} queueLockPending={chat.queueLockPending} onToggleQueueLock={chat.toggleQueueLock}
                queuedMessageCount={chat.queuedMessageCount} queuedMessagePreview={chat.queuedMessagePreview} queuedMessages={chat.queuedMessages}
        pendingInteraction={chat.pendingInteraction ? { ...chat.pendingInteraction, sessionId: host?.id ?? sessionId } : null}
        connectionRecovery={chat.activeConnectionRecovery} error={error || taskError || configurationError || chat.error || (displayedStatus === 'failed' ? task.errorMessage ?? '' : '')} notice={chat.notice}
        onClearError={() => { setError(''); chat.clearError(); }} onClearNotice={chat.clearNotice}
        draft={draft} onDraftChange={setDraft} selectedModel={chat.selectedModel} selectedModelConfig={selectedModel} availableModels={models} onModelChange={chat.setSelectedModel} onConfigureModels={onConfigureModels}
        contextWindowMaxTokens={selectedModel?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS} contextWindowUsage={chat.activeContextWindowUsage}
        permissionMode={chat.permissionMode} onPermissionModeChange={chat.setPermissionMode} subagentPermissionRouting={chat.subagentPermissionRouting} onSubagentPermissionRoutingChange={chat.setSubagentPermissionRouting}
        referencePlanAvailable referencePlanMode={chat.referencePlanMode} onReferencePlanModeChange={chat.setReferencePlanMode}
        reasoningLevelAvailable reasoningLevel={chat.reasoningLevel} reasoningLevels={['none', 'low', 'medium', 'high', 'xhigh', 'max']} onReasoningLevelChange={chat.setReasoningLevel}
        skills={chat.skills} disabledSkillNames={disabledSkillNames} onToggleSkill={onToggleSkill}
        onSend={send} submissionPending={submissionPending} onCancel={chat.cancelSending}
        onRefreshActiveSession={chat.refreshActiveSession} onCreateConversation={nothing} onOpenConversation={nothing}
        onRetryMessage={chat.retryFailedUserMessage} onRegenerate={chat.regenerateAssistantMessage} onEditUserMessage={chat.editUserMessageAndRegenerate}
        onGuideMessage={async (message, text, mode) => { await chat.sendTurnGuidance({ ...message, conversationId: sessionId }, text, mode); setDraft(''); }} onRetryGuidance={chat.retryTurnGuidance}
        onGuideQueuedMessage={chat.sendQueuedMessageAsGuidance} onRemoveQueuedMessage={chat.removeQueuedMessage} onReorderQueuedMessage={chat.reorderQueuedMessage}
        onRevertChangeReport={revert} onOpenChangeReview={openReview} onReplyInteraction={chat.replyToInteraction} onCancelInteraction={chat.cancelPendingInteraction} onCancelGoal={chat.cancelActiveGoal}/>
      {review && inspector?.outlets.get(reviewId) && createPortal(<ConversationChangeDialog embedded language={language}
        conversation={chat.activeConversation ?? { id: sessionId, title: '', preview: '', updatedAt: '' }} reports={reports} turns={recentReviewTurns(messages)}
        initialFilePath={review.path} initialTurnId={review.turnId} notice={error} revertingChangeId={reverting}
        revertedChangeIds={new Set(reports.filter(item => item.reverted).map(item => item.id))} revertAvailable={!busy}
        onClose={() => inspector.close(reviewId)} onRevert={revert}/>, inspector.outlets.get(reviewId)!)}
    </section>
    </WorkspaceChangeStateContext.Provider>
    </ConversationMessageTargetContext.Provider>
  </ConversationHostContext.Provider>;
}

/** Keep parent assignments distinguishable from direct human interventions. */
export function childConversationMessages(messages: ChatMessage[], task: SubagentTaskSnapshot): ChatMessage[] {
  const result = messages.map(message => {
    if (message.role !== 'user') return message;
    const legacy = message.content.startsWith('你当前处于子agent状态\n');
    const parent = legacy || message.metadata?.subagent_author === 'parent' ||
      (!message.metadata?.subagent_author && message.turnId === task.childTurnId && message.content === task.requestPrompt);
    return { ...message, content: legacy ? message.content.replace(/^你当前处于子agent状态\s*\n+/, '') : message.content,
      metadata: { ...message.metadata, subagent_author: parent ? 'parent' : 'user' } };
  });
  // Active turns are not committed yet. Show the known assignment immediately;
  // replace it with the durable user message as soon as the transcript arrives.
  if (!task.terminal && task.requestPrompt && !task.raw.resumedFromTaskId && !result.some(message => message.role === 'user' && message.turnId === task.childTurnId && message.metadata?.subagent_author === 'parent')) {
    result.unshift({ id: `subagent-assignment:${task.taskId}`, role: 'user', content: task.requestPrompt,
      conversationId: task.childSessionId, turnId: task.childTurnId, createdAt: task.createdAt,
      metadata: { subagent_author: 'parent' } });
  }
  return result;
}
