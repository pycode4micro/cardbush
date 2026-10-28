import { uiText } from '../../i18n';
import type { UserPromptInput } from '@cardbush/bush-protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_MAX_CONTEXT_TOKENS } from '@cardbush/bush-product-agent';
import * as api from '../../backend/api';
import { creationConversationBackend, type CreationConversationPreparation } from './creationConversationBackend';
import { conversationProjectDir, conversationWorkspaceRoot } from '../conversationWorkspace';
import { ComposerPortalContext } from '../composer/ComposerPortalContext';
import type { BrowserPromptReference } from '../../shared/promptReferences';
import { conversationRuntime } from '../../backend/conversationRuntime';
import { useCardbushChat } from '../../hooks/useCardbushChat';
import type { AppLanguage, ChatMessage, ConversationSummary, ManagedModelConfig, ReasoningLevel, ThemeMode } from '../../types';
import { ChatPanel } from '../chat/ChatPanel';
import { quickInputState, type QuickInputState } from '../composer/quickInputState';
import { ConversationHostContext, ConversationMessageTargetContext } from '../conversationHost';
import { ConversationChangeDialog } from '../sidebar/ChatSidebar';
import { recentReviewTurns } from '../sidebar/reviewModel';
import { WorkspaceChangeStateContext } from '../tools/WorkspaceChangeStateContext';
import { changeReportsFromMessages, type ConversationChangeReport } from '../tools/toolChangeReports';
import { useConversationViewState, conversationViewKey } from '../../shared/conversationViewState';
import '../inspector/inspectorWorkspace.css';

export type CreationInspectorContext = {
  sessionId: string; root: string; conversation: ConversationSummary; messages: ChatMessage[]; reports: ConversationChangeReport[];
  busy: boolean; error?: string | null; selectedModel: string; activeTurnId: string; reasoningLevel: ReasoningLevel;
  refresh: () => Promise<void>; revert: (report: ConversationChangeReport) => Promise<void>; appendDraft: (text: string) => void;
  send: (text: UserPromptInput) => Promise<boolean>;
  inputStatus?: QuickInputState;
};
export type CreationChatOptions = { theme?: ThemeMode; disabledSkillNames?: Set<string>; onToggleSkill?: (name: string, enabled: boolean) => void; onConfigureModels?: () => void; composerPortalTarget?: HTMLElement | null; externalComposerControls?: boolean; onOpenComposer?: () => void; browserTabs?: BrowserPromptReference[]; onOpenChangeReview?: (sessionId: string, path?: string, turnId?: string) => void; onInspectorContext?: (context: CreationInspectorContext | null) => void; onConversationChanged?: () => void };
const none = () => {}, empty = new Set<string>(), emptyStates = new Map<string, boolean>();
const emptyMessages: ChatMessage[] = [];

/** The normal conversation stack owns models, permissions, tools, recovery and history. */
export function CreationConversation({ sessionId, root, language, visible, beforeSend, contextLabel, preparation, scope = 'creation',
  theme = 'dark', disabledSkillNames = empty, onToggleSkill = none, onConfigureModels = none, composerPortalTarget, browserTabs, onOpenChangeReview, onInspectorContext, onConversationChanged, onOpen }: CreationChatOptions & {
  sessionId: string; root: string; language: AppLanguage; visible: boolean;
  scope?: 'creation' | 'team';
  preparation?: CreationConversationPreparation;
  beforeSend: (text: UserPromptInput) => Promise<UserPromptInput>; contextLabel: string; onOpen?: () => void;
}) {
  const [configuration, setConfiguration] = useState<{ models: ManagedModelConfig[]; defaultModelId: string }>();
  const [error, setError] = useState(''), [pending, setPending] = useState(false);
  const preparationRef = useRef(preparation); preparationRef.current = preparation;
  const [initialPreparedConversation] = useState<ConversationSummary | undefined>(() => preparation ? {
    id: sessionId, title: preparation.title, projectDir: preparation.projectDir, preview: '', updatedAt: new Date().toISOString(), metadata: { ui_draft: true },
  } : undefined);
  const backend = useMemo(() => creationConversationBackend(sessionId, scope, preparation ? { ...preparation,
    onCreated: conversation => preparationRef.current?.onCreated?.(conversation),
  } : undefined), [sessionId, scope]);
  useEffect(() => {
    let alive = true;
    const load = () => void api.fetchModelConfigs().then(value => { if (alive) setConfiguration(value); }).catch(error => { if (alive) setError(String(error.message)); });
    load(); window.addEventListener('cardbush:shared-configuration-updated', load);
    return () => { alive = false; window.removeEventListener('cardbush:shared-configuration-updated', load); };
  }, []);
  const models = useMemo(() => configuration?.models ?? [], [configuration]);
  const chat = useCardbushChat(models, models, { runtimeReady: true, modelsReady: !!configuration, defaultModelId: configuration?.defaultModelId,
    activeConversationId: sessionId, initialPreparedConversation, viewActive: visible || !!composerPortalTarget, language, disabledSkillNames, interactiveRequestsAvailable: true,
    reasoningTraceVisible: true, contextWindowUsageAvailable: true, workspaceChangesAvailable: true, onModelReasoningChange: api.saveModelReasoning }, backend);
  const messages = chat.activeMessages.length ? chat.activeMessages : emptyMessages;
  const [draft, setDraft] = useConversationViewState(conversationViewKey(scope, sessionId, 'draft'), () => '', Boolean);
  const submitting = useRef(false);
  const changedRef = useRef(onConversationChanged); changedRef.current = onConversationChanged;
  const send = async (text: UserPromptInput): Promise<boolean> => {
    if (submitting.current || !(typeof text === 'string' ? text : text.text).trim()) return false;
    submitting.current = true; setPending(true); setError('');
    try {
      const request = await beforeSend(text);
      return await new Promise<boolean>(resolve => {
        let settled = false;
        const finish = (accepted: boolean) => { if (!settled) { settled = true; if (accepted) changedRef.current?.(); resolve(accepted); } };
        void chat.sendMessage(request, undefined, undefined, undefined, undefined, undefined, () => finish(true))
          .then(() => { changedRef.current?.(); finish(false); }, error => { changedRef.current?.(); setError(String(error.message)); finish(false); });
      });
    } catch (error) { setError(String((error as Error).message)); return false; }
    finally { submitting.current = false; setPending(false); }
  };
  const reports = useMemo(() => changeReportsFromMessages(messages), [messages]);
  const sendRef = useRef(send); sendRef.current = send;
  const sendFromInspector = useCallback((text: UserPromptInput) => sendRef.current(text), []);
  const [review, setReview] = useState<{ path: string; turnId?: string }>(), [reverting, setReverting] = useState('');
  const busy = chat.sending || chat.stopping;
  const workspaceRoot = conversationWorkspaceRoot(chat.activeConversation) || root;
  const refresh = useCallback(async () => { await chat.refreshActiveSession({ silent: true }); }, [chat.refreshActiveSession]);
  const revert = useCallback(async (report: ConversationChangeReport) => {
    if (!report.turnId || busy || reverting) return;
    setReverting(report.id); setError('');
    const runtime = conversationRuntime();
    try {
      const input = { sessionId, turnIds: [report.turnId] }, client = runtime.client;
      if (report.reverted) await client.restoreWorkspaceChanges(input); else await client.revertWorkspaceChanges(input);
      await refresh();
    } catch (error) { setError(String((error as Error).message)); } finally { runtime.dispose(); setReverting(''); }
  }, [sessionId, busy, reverting, refresh]);
  const openRef = useRef(onOpen); openRef.current = onOpen;
  const appendDraft = useCallback((text: string) => {
    setDraft(current => [current.trim(), text.trim()].filter(Boolean).join('\n\n'));
    openRef.current?.();
  }, [setDraft]);
  useEffect(() => {
    if (!chat.activeConversation) return;
    onInspectorContext?.({ sessionId, root: workspaceRoot, conversation: chat.activeConversation, messages, reports,
      inputStatus: quickInputState({ language, messages, sending: chat.sending, stopping: chat.stopping, submitting: pending,
        waiting: chat.pendingInteraction?.sessionId === sessionId, error: error || chat.error, recovery: chat.activeConnectionRecovery, queued: chat.queuedMessageCount }),
      busy: busy || !!reverting, error: error || chat.error, selectedModel: chat.selectedModel, activeTurnId: chat.activeTurnId, reasoningLevel: chat.reasoningLevel,
      refresh, revert, appendDraft, send: sendFromInspector });
  }, [onInspectorContext, sessionId, workspaceRoot, chat.activeConversation, messages, reports, busy, error, chat.error, reverting, chat.selectedModel, chat.activeTurnId, chat.reasoningLevel, refresh, revert, appendDraft, sendFromInspector, language, chat.sending, chat.stopping, pending, chat.pendingInteraction, chat.activeConnectionRecovery, chat.queuedMessageCount]);
  useEffect(() => () => onInspectorContext?.(null), [onInspectorContext]);
  const model = models.find(item => item.id === chat.selectedModel);
  return <ConversationHostContext.Provider value={undefined}><ConversationMessageTargetContext.Provider value={`${scope}:${sessionId}`}>
    <WorkspaceChangeStateContext.Provider value={{ states: emptyStates, busy: busy || !!reverting }}>
    <section className="creation-conversation" hidden aria-label={contextLabel || (uiText(language)('creationConversation.writingConversation'))}>
      <ComposerPortalContext.Provider value={composerPortalTarget ?? null}>
      <ChatPanel embedded progressive browserTabs={browserTabs} welcomeEnabled={false} workSummaryAvailable={false} language={language} theme={theme} title={scope === 'team' ? (uiText(language)('appCenterModel.workflows')) : (uiText(language)('appCenterModel.create'))}
        sidebarCollapsed windowMaximized={false} inspectorOpen={false} onToggleInspector={() => setReview({ path: '' })}
        activeConversationId={sessionId} activeProjectDir={workspaceRoot || undefined} projectPathAliases={[]} selectedProjectDir={conversationProjectDir(chat.activeConversation)} availableProjects={[]} onWelcomeProjectChange={async () => {}}
        messages={chat.activeMessages} changeReports={reports} activeTurnId={chat.activeTurnId} loading={chat.loading || chat.messagesLoading} historyLoading={chat.messagesLoading} historyPages={chat.historyPages} sending={chat.sending} stopping={chat.stopping}
        turnHistoryAvailable subagentObservabilityAvailable={false} thinkingVisible guidanceDeliveryMode="queue"
        activeGoal={chat.activeGoal} goalAvailable={chat.goalAvailable} goalCancelling={chat.activeGoalCancelling} goalWaiting={chat.activeGoalWaiting}
        shadowAvailable={false} shadowAccentColor="" shadowThemeVariables={{}}
        queueLocked={chat.queueLocked} queueLockPending={chat.queueLockPending} onToggleQueueLock={chat.toggleQueueLock}
        queuedMessageCount={chat.queuedMessageCount} queuedMessagePreview={chat.queuedMessagePreview} queuedMessages={chat.queuedMessages}
        pendingInteraction={chat.pendingInteraction} connectionRecovery={chat.activeConnectionRecovery} error={error || chat.error} notice={chat.notice}
        onClearError={() => { setError(''); chat.clearError(); }} onClearNotice={chat.clearNotice}
        draft={draft} onDraftChange={setDraft} selectedModel={chat.selectedModel} selectedModelConfig={model} availableModels={models} onModelChange={chat.setSelectedModel} onConfigureModels={onConfigureModels}
        contextWindowMaxTokens={model?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS} contextWindowUsage={chat.activeContextWindowUsage}
        permissionMode={chat.permissionMode} onPermissionModeChange={chat.setPermissionMode} subagentPermissionRouting={chat.subagentPermissionRouting} onSubagentPermissionRoutingChange={chat.setSubagentPermissionRouting}
        referencePlanAvailable referencePlanMode={chat.referencePlanMode} onReferencePlanModeChange={chat.setReferencePlanMode}
        reasoningLevelAvailable reasoningLevel={chat.reasoningLevel} reasoningLevels={['none', 'low', 'medium', 'high', 'xhigh', 'max']} onReasoningLevelChange={chat.setReasoningLevel}
        skills={chat.skills} disabledSkillNames={disabledSkillNames} onToggleSkill={onToggleSkill}
        onSend={send} submissionPending={pending} onCancel={chat.cancelSending} onRefreshActiveSession={chat.refreshActiveSession} onCreateConversation={none} onOpenConversation={none}
        onRetryMessage={chat.retryFailedUserMessage} onRegenerate={chat.regenerateAssistantMessage} onEditUserMessage={chat.editUserMessageAndRegenerate}
        onGuideMessage={chat.sendTurnGuidance} onRetryGuidance={chat.retryTurnGuidance} onGuideQueuedMessage={chat.sendQueuedMessageAsGuidance} onRemoveQueuedMessage={chat.removeQueuedMessage} onReorderQueuedMessage={chat.reorderQueuedMessage}
        onRevertChangeReport={revert} onOpenChangeReview={(path = '', turnId) => onOpenChangeReview ? onOpenChangeReview(sessionId, path, turnId) : setReview({ path, turnId })} onReplyInteraction={chat.replyToInteraction} onCancelInteraction={chat.cancelPendingInteraction} onCancelGoal={chat.cancelActiveGoal}/>
      </ComposerPortalContext.Provider>
    </section>
      {review && <ConversationChangeDialog language={language} conversation={chat.activeConversation ?? { id: sessionId, title: '', preview: '', updatedAt: '' }} reports={reports} turns={recentReviewTurns(chat.activeMessages)}
        initialFilePath={review.path} initialTurnId={review.turnId} notice={error} revertingChangeId={reverting} revertedChangeIds={new Set(reports.filter(report => report.reverted).map(report => report.id))} revertAvailable={!busy}
        onClose={() => setReview(undefined)} onRevert={revert}/>}
    </WorkspaceChangeStateContext.Provider>
  </ConversationMessageTargetContext.Provider></ConversationHostContext.Provider>;
}
