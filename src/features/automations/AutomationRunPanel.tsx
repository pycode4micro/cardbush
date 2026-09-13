import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Check, Mail, RefreshCw, Square, ExternalLink } from 'lucide-react';
import { isAutomationResult, type AutomationConversation } from '@cardbush/bush-protocol';
import { fetchSessionMessages, fetchPendingInteraction, streamChat, streamTurnEvents, stopTurn, replyInteraction, cancelInteraction, recordAssistantLogicFeedback, type ChatStreamEventHandlers } from '../../backend/api';
import type { ChatMessage, PendingInteraction, PermissionMode, ReasoningLevel } from '../../types';
import { MessageBubble, MessageFileReferenceScope, projectRenderableChatMessages } from '../chatMessages';
import { normalizeChatMessagesForDisplay } from '../chatMessages/transcript/messageProjection';
import { appendAssistantDelta, applyAssistantRevision, appendToolExecution, applyTaskPlanUpdate, applyTurnTerminalSnapshot, assignTurnToLocalMessages, ensureBackgroundTurnAssistant, markLocalAssistantTurnCompleted } from '../chatMessages/transcript/liveMessageUpdates';
import { InteractionCard } from '../interactions/InteractionCard';
import { onRuntimeInteractionsChanged } from '../../runtime-client/RuntimeInteractionBridge';
import './automations.css';

// Closing an inspector only detaches its view. The ordinary persisted conversation
// continues, and another view can reconnect to the same turn.
const continuations = new Map<string, { controller: AbortController; turnId: string; userMessage: ChatMessage }>();
const CONTINUATION_CHANGED = 'cardbush:automation-continuation-changed';
const notifyContinuation = () => window.dispatchEvent(new Event(CONTINUATION_CHANGED));
const ignoreAsync = async () => undefined;
const ignore = () => undefined;
type MessageState = Record<string, ChatMessage[]>;

export function AutomationRunPanel({ jobId, runId, language, active = true, onOpenConversation }: {
  jobId: string; runId: string; language: 'zh' | 'en'; onOpenConversation: (sessionId: string) => void;
  active?: boolean;
}) {
  const zh = language === 'zh';
  const [detail, setDetail] = useState<AutomationConversation>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [readBusy, setReadBusy] = useState(false);
  const [turnId, setTurnId] = useState('');
  const [historyRevision, setHistoryRevision] = useState(0);
  const [interaction, setInteraction] = useState<PendingInteraction | null>(null);
  const mounted = useRef(true), generation = useRef(0), ownSend = useRef(false), scroll = useRef<HTMLDivElement>(null), follow = useRef(true);
  const refresh = useCallback(async () => {
    const version = ++generation.current;
    try {
      const result = await window.cardbushDesktop!.automationCommand({ action: 'conversation', id: jobId, runIds: [runId] }) as AutomationConversation;
      if (mounted.current && version === generation.current) setDetail(result);
    } catch (reason) { if (mounted.current && version === generation.current) setError(String(reason)); }
  }, [jobId, runId]);
  useEffect(() => {
    mounted.current = true;
    let timer = 0;
    const update = () => { clearTimeout(timer); timer = window.setTimeout(() => void refresh(), 120); };
    void refresh();
    const unsubscribe = window.cardbushDesktop?.onAutomationChanged?.(update);
    const continuationChanged = () => { if (!ownSend.current) setHistoryRevision(value => value + 1); };
    window.addEventListener(CONTINUATION_CHANGED, continuationChanged);
    window.addEventListener('focus', update);
    return () => { mounted.current = false; generation.current++; clearTimeout(timer); unsubscribe?.(); window.removeEventListener('focus', update); window.removeEventListener(CONTINUATION_CHANGED, continuationChanged); };
  }, [refresh]);

  const handlers = useCallback((sessionId: string, initialTurnId: string, userId?: string, accept: () => boolean = () => true): Omit<ChatStreamEventHandlers, 'sessionId'> => {
    const assistantId = `automation-live-${initialTurnId || userId}`;
    let currentTurnId = initialTurnId;
    const current = () => mounted.current && accept();
    const update = (change: (state: MessageState) => MessageState, ensure = true) => {
      if (current()) setMessages(previous => change(ensure ? ensureBackgroundTurnAssistant({ [sessionId]: previous }, sessionId, assistantId, currentTurnId) : { [sessionId]: previous })[sessionId]);
    };
    return {
      onStart: start => {
        currentTurnId = start.turnId;
        const active = continuations.get(sessionId);
        if (active && ownSend.current) {
          active.turnId = start.turnId;
          active.userMessage = { ...active.userMessage, turnId: start.turnId, messageId: start.userMessageId,
            metadata: { ...active.userMessage.metadata, ...start.userMessageMetadata } };
          notifyContinuation();
        }
        if (current()) { setTurnId(start.turnId); update(state => assignTurnToLocalMessages(state, sessionId, start.turnId, [userId ?? '', assistantId], undefined, start.userMessageId, start.userMessageMetadata)); }
      },
      onDelta: (delta, chunk) => update(state => appendAssistantDelta(state, sessionId, assistantId, delta, chunk)),
      onAssistantRevision: revision => { if (!revision.channel || revision.channel === 'assistant') update(state => applyAssistantRevision(state, sessionId, assistantId, revision)); },
      onToolExecution: execution => update(state => appendToolExecution(state, sessionId, assistantId, execution)),
      onTaskPlanUpdate: plan => update(state => applyTaskPlanUpdate(state, sessionId, assistantId, plan)),
      onFinalAssistantText: (text, chunk) => update(state => markLocalAssistantTurnCompleted(state, sessionId, assistantId, new Date().toISOString(), chunk, text)),
      onMessages: loaded => { if (current()) setMessages(loaded); },
      onInteractiveRequest: value => { if (current()) setInteraction(value); },
      onDone: terminal => { update(state => applyTurnTerminalSnapshot(state, sessionId, assistantId, terminal), false); if (current()) setInteraction(null); },
    };
  }, []);

  const sessionId = detail?.sessionId;
  const scopedInteraction = interaction?.sessionId === sessionId ? interaction : null;
  useEffect(() => {
    if (!sessionId) return;
    let disposed = false, revision = 0;
    const refreshInteraction = () => {
      const current = ++revision;
      void fetchPendingInteraction(sessionId).then(value => { if (!disposed && current === revision) setInteraction(value); }).catch(() => undefined);
    };
    const unsubscribe = onRuntimeInteractionsChanged(changedSession => { if (changedSession === sessionId) refreshInteraction(); });
    refreshInteraction();
    return () => { disposed = true; unsubscribe(); };
  }, [sessionId]);
  const runStatus = detail?.run.status;
  useEffect(() => {
    if (!sessionId || ownSend.current) return;
    let disposed = false;
    const observer = new AbortController();
    const continuation = continuations.get(sessionId);
    const connectedTurn = continuation?.turnId || (runStatus === 'running' ? detail!.run.turnId : '');
    setSending(continuations.has(sessionId) || Boolean(connectedTurn));
    void (async () => {
      try {
        const history = await fetchSessionMessages(sessionId, { includeSuperseded: false });
        if (disposed) return;
        setMessages(history.messages);
        if (continuation && !history.messages.some(message => message.role === 'user' && (message.id === continuation.userMessage.id || Boolean(connectedTurn && message.turnId === connectedTurn)))) {
          setMessages(previous => [...previous, continuation.userMessage]);
        }
        setInteraction(await fetchPendingInteraction(sessionId));
        if (disposed) return;
        if (connectedTurn) {
          setTurnId(connectedTurn); setSending(true);
          // Replay only the live turn; persisted history is already loaded.
          setMessages(previous => previous.filter(message => message.turnId !== connectedTurn || message.role === 'user'));
          if (connectedTurn === detail!.run.turnId && !history.messages.some(message => message.turnId === connectedTurn && message.role === 'user')) {
            setMessages(previous => [...previous, { id: `message_${runId}`, role: 'user', content: detail!.job.prompt, conversationId: sessionId, turnId: connectedTurn, createdAt: detail!.run.startedAt }]);
          }
          await streamTurnEvents({ sessionId, turnId: connectedTurn, signal: observer.signal, ...handlers(sessionId, connectedTurn, undefined, () => !disposed) });
        }
      } catch (reason) { if (!disposed) setError(String(reason)); }
      finally { if (!disposed) { setSending(continuations.has(sessionId)); setTurnId(''); } }
    })();
    return () => { disposed = true; observer.abort(); };
  }, [sessionId, runStatus, detail?.run.turnId, handlers, runId, historyRevision]);

  const send = async (content = draft.trim()) => {
    if (!detail || !content || ownSend.current || sending || continuations.has(detail.sessionId) || !isAutomationResult(detail.run)) return;
    const current = detail, userId = `user-${crypto.randomUUID()}`, controller = new AbortController();
    const userMessage: ChatMessage = { id: userId, role: 'user', content, conversationId: current.sessionId, createdAt: new Date().toISOString() };
    continuations.set(current.sessionId, { controller, turnId: '', userMessage });
    ownSend.current = true; follow.current = true; setSending(true); setDraft(''); setError('');
    setMessages(previous => [...previous, userMessage]);
    try {
      await streamChat({ sessionId: current.sessionId, userInput: content, model: current.model, uiLanguage: language,
        projectDir: current.projectDir, workspaceDir: current.workspaceDir,
        permissionMode: current.permissionMode as PermissionMode, reasoningLevel: current.reasoningEffort as ReasoningLevel,
        allowedTools: current.allowedTools, allowedSkills: current.allowedSkills, disabledSkills: current.disabledSkills,
        interactiveRequestsEnabled: current.interactiveRequests, standardImageInputEnabled: current.vision,
        signal: controller.signal, ...handlers(current.sessionId, '', userId),
      });
    } catch (reason) { if (mounted.current && !controller.signal.aborted) { setError(String(reason)); setDraft(content); } }
    finally {
      if (mounted.current) {
        try { const history = await fetchSessionMessages(current.sessionId, { includeSuperseded: false }); if (mounted.current) setMessages(history.messages); } catch (reason) { if (mounted.current) setError(String(reason)); }
      }
      continuations.delete(current.sessionId); ownSend.current = false;
      if (mounted.current) { setSending(false); setTurnId(''); setInteraction(null); }
      notifyContinuation();
    }
  };
  const toggleRead = async () => {
    if (!detail || readBusy) return;
    setReadBusy(true);
    try { await window.cardbushDesktop!.automationCommand({ action: detail.run.readAt ? 'mark_unread' : 'mark_read', id: jobId, runIds: [runId] }); await refresh(); }
    catch (reason) { setError(String(reason)); }
    finally { setReadBusy(false); }
  };
  useEffect(() => {
    if (active && follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [messages, interaction, active]);
  useEffect(() => {
    const node = scroll.current, content = node?.firstElementChild;
    if (!active || !node || !content) return;
    const observer = new ResizeObserver(() => { if (follow.current) node.scrollTop = node.scrollHeight; });
    observer.observe(content);
    return () => observer.disconnect();
  }, [active]);
  const rendered = useMemo(() => projectRenderableChatMessages(normalizeChatMessagesForDisplay(messages)), [messages]);
  const labels = zh ? { queued: '排队中', running: '执行中', completed: '已完成', failed: '失败', stopped: '已停止', interrupted: '执行中断', awaiting_user_action: '等待处理' }
    : { queued: 'Queued', running: 'Running', completed: 'Completed', failed: 'Failed', stopped: 'Stopped', interrupted: 'Interrupted', awaiting_user_action: 'Needs attention' };
  return <section className="automation-run-panel shadow-inspector-shell">
    <header className="automation-run-heading"><div><strong>{detail?.job.name || (zh ? '执行结果' : 'Execution result')}</strong><span>{detail ? `${labels[detail.run.status]}${isAutomationResult(detail.run) ? ` · ${detail.run.readAt ? (zh ? '已读' : 'Read') : (zh ? '未读' : 'Unread')}` : ''}` : (zh ? '正在加载…' : 'Loading…')}</span></div>
      <div className="automation-actions"><button type="button" aria-label={zh ? '刷新结果' : 'Refresh result'} onClick={() => { setError(''); void refresh(); if (!sending) setHistoryRevision(value => value + 1); }}><RefreshCw size={14}/></button>
        {detail && <button type="button" title={zh ? '在主会话打开' : 'Open full conversation'} aria-label={zh ? '在主会话打开' : 'Open full conversation'} onClick={() => onOpenConversation(detail.sessionId)}><ExternalLink size={14}/></button>}
        {detail && isAutomationResult(detail.run) && <button type="button" disabled={readBusy} onClick={() => void toggleRead()}>{detail.run.readAt ? <Mail size={14}/> : <Check size={14}/>} {detail.run.readAt ? (zh ? '标记未读' : 'Mark unread') : (zh ? '标记已读' : 'Mark read')}</button>}
      </div></header>
    <div className="automation-run-transcript message-list" ref={scroll} onScroll={event => { const node = event.currentTarget; follow.current = node.scrollHeight - node.clientHeight - node.scrollTop < 70; }}>
      <MessageFileReferenceScope workspaceRoot={detail?.workspaceDir || detail?.projectDir}><div className="message-list-content">
        {rendered.map(message => <div className="message-list-item" key={message.id}><MessageBubble message={message} language={language} sending={sending} activeTurnId={turnId} activeAssistantMessageId="" selectedModel={detail?.modelName ?? detail?.model}
          readOnlyActions onRegenerate={ignoreAsync} onEditUserMessage={ignoreAsync} onRetryMessage={ignoreAsync} onRetryGuidance={ignoreAsync} onRevertChangeReport={ignoreAsync} onOpenScene={ignore} onAssistantFeedback={recordAssistantLogicFeedback}/></div>)}
        {!rendered.length && <p className="automation-hint">{detail?.run.status === 'queued' ? (zh ? '等待执行，开始后会显示对话。' : 'Waiting to execute. The conversation will appear here.') : (zh ? '本次执行还没有对话内容。' : 'This execution has no conversation content yet.')}</p>}
        {detail?.run.error && <p className="automation-error">{detail.run.error}</p>}
        {error && <p className="automation-error" role="alert">{error}</p>}
      </div></MessageFileReferenceScope>
    </div>
    {scopedInteraction && <InteractionCard key={scopedInteraction.id} language={language} interaction={scopedInteraction}
      onReply={async answers => { await replyInteraction({ interactionId: scopedInteraction.id, answers }); const next = await fetchPendingInteraction(scopedInteraction.sessionId!); if (mounted.current) setInteraction(next); }}
      onCancel={async () => { await cancelInteraction(scopedInteraction.id); const next = await fetchPendingInteraction(scopedInteraction.sessionId!); if (mounted.current) setInteraction(next); }}/ >}
    {!scopedInteraction && <form className="automation-run-composer composer-surface" onSubmit={event => { event.preventDefault(); void send(); }}>
      <textarea aria-label={zh ? '继续本次对话' : 'Continue this conversation'} placeholder={zh ? '继续本次对话…' : 'Continue this conversation…'} rows={2} value={draft} onChange={event => setDraft(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}/>
      <div><span>{detail?.modelName ?? detail?.model}</span>{sending ? <button type="button" aria-label={zh ? '停止执行' : 'Stop execution'} onClick={() => { if (detail && continuations.has(detail.sessionId)) continuations.get(detail.sessionId)!.controller.abort(); else if (turnId) void stopTurn(turnId).catch(reason => setError(String(reason))); }}><Square size={15}/></button>
        : <button type="submit" aria-label={zh ? '发送追问' : 'Send follow-up'} disabled={!draft.trim() || !detail || !isAutomationResult(detail.run)}><ArrowUp size={17}/></button>}</div>
    </form>}
  </section>;
}
