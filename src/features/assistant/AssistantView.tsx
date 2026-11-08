import { createPortal } from 'react-dom';
import { FloatingAssistantCapsule } from './FloatingAssistantCapsule';
import { useFloatingAssistant } from './useFloatingAssistant';
import { AssistantEventsDialog } from './events/AssistantEventsDialog';
import { uiText } from '../../i18n';
import { readUserPrompt, type UserPromptInput } from '@cardbush/bush-protocol';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { UsersRound } from 'lucide-react';
import { PERSONAL_ASSISTANT_SESSION, type ConversationEntry, type AssistantReaction } from '@cardbush/bush-protocol';
import type { ChatStreamRequest } from '../../backend/api';
import { journalMessages, type ConversationJournalSnapshot } from '../../backend/conversationJournal';
import { assistantBackend } from './assistantBackend';
import { assistantErrorText } from './assistantError';
import { VoiceConversation, applicationVoiceSession } from '../voice/VoiceConversation';
import type { VoiceTarget } from '../voice/voiceSession';
import { MarkdownContent, MessageFileAttachmentStrip, MessageImageStrip } from '../chatMessages/MessageBubble';
import { AssistantComposer, type AssistantComposerControls } from './AssistantComposer';
import { AssistantBulb } from './AssistantBulb';
import { readAssistantProfile, saveAssistantProfile, useAssistantProfile, setAssistantWorking } from './assistantProfile';
import { TopBar } from '../../components/TopBar';
import { ScrollBottomButton } from '../chat/ScrollBottomButton';
import { ConversationConnectionNotice, RuntimeStatusBanner } from '../chat/ChatStatusViews';
import { ConversationWorkSummary } from '../chat/ConversationWorkSummary';
import { useConversationWorkSummary } from '../chat/useConversationWorkSummary';
import { useAssistantViewport } from './useAssistantViewport';
import { ComposerPortalContext } from '../composer/ComposerPortalContext';
import { QuickInputStatus } from '../composer/QuickInputStatus';
import type { BrowserPromptReference } from '../../shared/promptReferences';
import '../chat/conversationComposerLayout.css';
import './assistant.css';
import { useLoopSubagentTasks } from '../subagents/useLoopSubagentTasks';
import { AssistantTaskBubble } from './AssistantTaskBubble';
import { PromptReferenceFallback } from '../composer/PromptReferenceLink';
import { usePublishRegionConversation } from '../inspector/RegionConversationContext';
import { localInspectorWorkspace } from '../inspector/inspectorSessions';
import { assistantInputEntry, assistantTimeLabel, assistantTimeSeparators } from './assistantTimeline';
import { AssistantPermissionCard } from './AssistantPermissionCard';
import { AssistantMessageMenu, AssistantQuote, assistantQuoteText, reactionName, type AssistantMessageMenuTarget } from './AssistantMessageActions';
import { copyText } from '../messageFeedback';

const sessionId = PERSONAL_ASSISTANT_SESSION;
// Also hide transcripts saved by older versions, without deleting conversational memory.
const isPageEntry = (entry: ConversationEntry) => entry.visibility !== 'internal' && entry.source !== 'voice';
type SubmittedMessage = { entry: ConversationEntry; prompt: UserPromptInput; state: 'sending' | 'accepted' | 'failed' };
export function AssistantView({ active, language, floating, prepare, ownsConfiguration = true, onManageHosts, composerControls,
  inspectorOpen = false, onToggleInspector, browserTabs = [], composerPortalTarget = null, windowMaximized = false, subagentObservabilityAvailable = false }: {
  active: boolean; language: string; floating?: { returnToWorkspace(): void; retainDraft?(value: boolean): void };
  prepare(): Promise<ChatStreamRequest>; ownsConfiguration?: boolean; onManageHosts?(): void;
  composerControls?: AssistantComposerControls;
  inspectorOpen?: boolean; onToggleInspector?(): void; browserTabs?: BrowserPromptReference[];
  composerPortalTarget?: HTMLElement | null; windowMaximized?: boolean; subagentObservabilityAvailable?: boolean;
}) {
  const profile = useAssistantProfile();
  const hasOpened = useRef(active);
  useEffect(() => { if (active) hasOpened.current = true; }, [active]);
  const [entries, setEntries] = useState<ConversationEntry[]>([]), [ready, setReady] = useState(false);
  const [submitted, setSubmitted] = useState<SubmittedMessage[]>([]);
  const [messageMenu, setMessageMenu] = useState<AssistantMessageMenuTarget>();
  const closeMessageMenu = useCallback(() => setMessageMenu(undefined), []);
  const [quote, setQuote] = useState<ConversationEntry['replyTo']>();
  const quoteRef = useRef(quote); quoteRef.current = quote;
  const quoteRevision = useRef(0);
  const [reactions, setReactions] = useState<Record<string, AssistantReaction>>({});
  const [reacting, setReacting] = useState(false), reactionPending = useRef(false);
  const [highlighted, setHighlighted] = useState<string>();
  useEffect(() => { if (!active) closeMessageMenu(); }, [active, closeMessageMenu]);
  useEffect(() => { if (highlighted) { const timer = setTimeout(() => setHighlighted(undefined), 1500); return () => clearTimeout(timer); } }, [highlighted]);
  const submittedRef = useRef(submitted); submittedRef.current = submitted;
  const sendingRequest = useRef<string | undefined>(undefined);
  const pageEntries = useMemo(() => [...entries.filter(isPageEntry), ...submitted
    .filter(item => !entries.some(entry => entry.id === item.entry.id)).map(item => item.entry)], [entries, submitted]);
  const allTasks = useLoopSubagentTasks(sessionId, active && !floating && ready, active && !floating);
  // Reset removes the journal; do not resurrect old tasks in a fresh conversation.
  const tasks = allTasks.filter(task => task.origin === 'subagent' && task.taskId && entries.length &&
    (task.createdAt || task.startedAt || '') >= entries[0].createdAt);
  const timeline = [...pageEntries.map(entry => ({ key: entry.id, at: entry.createdAt, entry })),
    ...tasks.map(task => ({ key: task.taskId!, at: task.createdAt || task.startedAt || '', task }))]
    .sort((a, b) => a.at.localeCompare(b.at));
  const lastPageEntry = timeline.at(-1)?.key;
  const pageMessages = useMemo(() => journalMessages(pageEntries, sessionId), [pageEntries]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [draft, setDraft] = useState('');
  const draftRef = useRef(draft); draftRef.current = draft;
  const [runtimeError, setRuntimeError] = useState('');
  const [canRetry, setCanRetry] = useState(false);
  const [submission, setSubmission] = useState<'send' | 'retry'>();
  const submitting = submission !== undefined;
  const [nextStepPrediction, setNextStepPrediction] = useState<ConversationJournalSnapshot['nextStepPrediction']>();
  const [eventNeedsResponse, setEventNeedsResponse] = useState(false);
  const [management, setManagement] = useState<ConversationJournalSnapshot['management']>();
  const overallPlan = management?.plan?.plan;
  const taskPlan = useMemo(() => overallPlan && { ...overallPlan, planId: overallPlan.plan_id, sessionId: overallPlan.session_id }, [overallPlan]);
  // Keep the indicator with its submitted bubble until the journal takes over.
  const pendingReply = submission === 'retry' || submitted.some(item => item.state !== 'failed');
  const replying = (busy || pendingReply) && !error && !runtimeError;
  const [retry, setRetry] = useState<ConversationJournalSnapshot['retry']>(null);
  const prepareRef = useRef(prepare); prepareRef.current = prepare;
  useEffect(() => {
    let cancelled = false;
    if (!ownsConfiguration) return;
    void prepareRef.current().then(config => {
      if (!cancelled) return window.cardbushDesktop?.embodied?.command({ action: 'assistant.save', input: {
        profile, language, modelId: config.modelConfig?.id || config.model,
        permissionMode: config.permissionMode || 'task_free',
        subagentPermissionRouting: config.subagentPermissionRouting, planEnabled: config.referencePlanMode !== 'off',
        disabledTools: config.disabledTools || [], disabledSkills: config.disabledSkills || [],
      } });
    }).catch(() => { /* Model/configuration startup can complete after this render. */ });
    return () => { cancelled = true; };
  }, [ownsConfiguration, profile, language, composerControls ? undefined : prepare, composerControls?.selectedModel, composerControls?.availableModels, composerControls?.permissionMode, composerControls?.subagentPermissionRouting, composerControls?.referencePlanMode, composerControls?.disabledSkillNames]);
  const entriesRef = useRef(entries); entriesRef.current = entries;
  const busyRef = useRef(busy); busyRef.current = busy;
  const cursor = useRef(0);
  const generation = useRef<number | undefined>(undefined);
  const refreshing = useRef<Promise<void> | undefined>(undefined);
  const capsule = useFloatingAssistant(Boolean(floating), active, entries, generation.current);
  const [capsuleFiles, setCapsuleFiles] = useState<string[]>([]);
  const retainDraft = floating?.retainDraft;
  useEffect(() => {
    retainDraft?.(Boolean(draft || capsuleFiles.length || submitting));
  }, [retainDraft, draft, capsuleFiles.length, submitting]);
  const chatBody = useRef<HTMLDivElement>(null), activeRef = useRef(active); activeRef.current = active;
  const scroller = useRef<HTMLDivElement>(null), composerDock = useRef<HTMLDivElement>(null);
  const viewport = useAssistantViewport({ active: active && !floating, bodyRef: chatBody, dockRef: composerDock, scrollerRef: scroller, revision: lastPageEntry, portaled: Boolean(composerPortalTarget) });
  const summary = useConversationWorkSummary(chatBody, sessionId, inspectorOpen);
  const historyLoaded = useRef(false), animationTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [arriving, setArriving] = useState<Set<string>>(() => new Set());
  const animateEntries = useCallback((ids: string[]) => {
    if (!ids.length) return;
    setArriving(current => new Set([...current, ...ids]));
    const timer = setTimeout(() => { setArriving(current => new Set([...current].filter(id => !ids.includes(id)))); animationTimers.current = animationTimers.current.filter(item => item !== timer); }, 420);
    animationTimers.current.push(timer);
  }, []);
  useEffect(() => () => animationTimers.current.forEach(clearTimeout), []);
  useEffect(() => { if (!active) setArriving(new Set()); }, [active]);
  const voice = applicationVoiceSession();
  const callHere = useSyncExternalStore(voice.subscribe, () => voice.snapshot().mode === 'call' && Boolean(voice.snapshot().assistant));
  useEffect(() => {
    if (capsule.surface === 'voice' && !callHere) void window.cardbushDesktop?.assistantSurface?.('capsule');
  }, [capsule.surface, callHere]);
  const voiceInUse = useSyncExternalStore(voice.subscribe, () => voice.snapshot().mode !== 'idle');
  const initialize = useRef<Promise<unknown> | undefined>(undefined);
  const ensure = useCallback(() => initialize.current ??= assistantBackend.ensure(profile.name)
    .catch(error => { initialize.current = undefined; throw error; }), [profile.name]);
  const refresh = useCallback(() => {
    if (refreshing.current) return refreshing.current;
    refreshing.current = (async () => {
      let result = await assistantBackend.read(cursor.current, language);
      const reset = result.cursor < cursor.current || result.generation !== generation.current;
      if (reset) result = await assistantBackend.read(0, language);
      generation.current = result.generation;
      if (!reactionPending.current) setReactions(current => JSON.stringify(current) === JSON.stringify(result.reactions ?? {}) ? current : result.reactions ?? {});
      if (reset && historyLoaded.current) { quoteRevision.current++; quoteRef.current = undefined; setQuote(undefined); setReactions(result.reactions ?? {}); closeMessageMenu(); }
      if (historyLoaded.current && !reset && activeRef.current && result.entries.length) {
        const ids = result.entries.filter(entry => isPageEntry(entry) && !submittedRef.current.some(item => item.entry.id === entry.id)).map(entry => entry.id);
        animateEntries(ids);
      }
      historyLoaded.current = true;
      cursor.current = result.cursor;
      if (reset) setEntries(result.entries);
      else if (result.entries.length) setEntries(current => [...current, ...result.entries.filter(entry => !current.some(old => old.id === entry.id))]);
      if (result.entries.length) setSubmitted(current => current.filter(item => !result.entries.some(entry => entry.id === item.entry.id)));
      setEventNeedsResponse(result.eventNeedsResponse === true);
      setBusy(result.busy); setAssistantWorking(result.busy || Boolean(result.workingTasks)); setRuntimeError(result.error); setRetry(result.retry);
      setNextStepPrediction(current => JSON.stringify(current) === JSON.stringify(result.nextStepPrediction) ? current : result.nextStepPrediction);
      setManagement(current => JSON.stringify(current) === JSON.stringify(result.management) ? current : result.management);
      setCanRetry(result.canRetry === true);
    })().finally(() => { refreshing.current = undefined; });
    return refreshing.current;
  }, [animateEntries, closeMessageMenu, language]);
  useEffect(() => {
    const reset = () => { sendingRequest.current = undefined; setSubmission(undefined); setSubmitted([]); setManagement(undefined); setCapsuleFiles([]); setDraft(''); setQuote(undefined); setReactions({}); closeMessageMenu(); setError(''); setRuntimeError(''); setRetry(null); setArriving(new Set()); void refresh().then(() => refresh()).catch(error => setError(String(error))); };
    window.addEventListener('cardbush:assistant-reset', reset);
    return () => window.removeEventListener('cardbush:assistant-reset', reset);
  }, [refresh, closeMessageMenu]);
  useEffect(() => {
    if (!active && !ready) return;
    let disposed = false, pending = false;
    const tick = async () => {
      if (pending) return; pending = true;
      try { await ensure(); if (!disposed) { setReady(true); await refresh(); } }
      catch (error) { if (!disposed) { initialize.current = undefined; setError(error instanceof Error ? error.message : String(error)); } }
      finally { pending = false; }
    };
    void tick(); const timer = setInterval(() => void tick(), 1000);
    return () => { disposed = true; clearInterval(timer); };
  }, [active, ready, ensure, refresh]);
  const submit = useCallback(async (text: UserPromptInput, spoken = false, identity?: ConversationEntry, contextVersion = assistantBackend.contextVersion()) => {
    await ensure();
    const config = await prepareRef.current();
    await assistantBackend.send(text, config, spoken, contextVersion, identity);
    // Admission succeeded; a later journal read failure is not a send failure.
    void refresh().catch(() => {}); return true;
  }, [ensure, refresh]);
  const agent = useMemo(() => assistantBackend.voice(async () => { await ensure(); return { ...await prepareRef.current(), sessionId }; }), [ensure]);
  // Typed messages and recording transcripts share positioning, acceptance and errors.
  const send = async (text: UserPromptInput, failed?: SubmittedMessage) => {
    if (!readUserPrompt(text).text.trim() || sendingRequest.current || submitting) return false;
    const request = crypto.randomUUID(), contextVersion = assistantBackend.contextVersion();
    const quoteVersion = quoteRevision.current;
    const replyTo = failed ? failed.entry.replyTo : quoteRef.current;
    if (!failed) { setQuote(undefined); quoteRef.current = undefined; }
    sendingRequest.current = request;
    viewport.prepareSend();
    setSubmission('send'); setError(''); setRuntimeError('');
    let entry: ConversationEntry | undefined;
    try {
      const prior = failed?.entry ? failed : submittedRef.current.find(item => item.state === 'failed' && JSON.stringify(item.prompt) === JSON.stringify(text) && JSON.stringify(item.entry.replyTo) === JSON.stringify(replyTo));
      entry = prior?.entry ?? { ...await assistantInputEntry(text), ...(replyTo ? { replyTo } : {}) };
      if (contextVersion !== assistantBackend.contextVersion()) return true;
      const message: SubmittedMessage = { entry, prompt: text, state: 'sending' };
      setSubmitted(current => [...current.filter(item => item.entry.id !== entry!.id), message]);
      animateEntries([entry.id]);
      await submit(text, false, entry, contextVersion);
      setSubmitted(current => current.map(item => item.entry.id === entry!.id ? { ...item, state: 'accepted' } : item));
      return true;
    } catch (error) {
      // Reset explicitly discards the pending input, including its draft snapshot.
      if (contextVersion !== assistantBackend.contextVersion()) return true;
      const received = entry && (entriesRef.current.some(item => item.id === entry!.id) ||
        await assistantBackend.read().then(result => result.entries.some(item => item.id === entry!.id)).catch(() => false));
      if (contextVersion !== assistantBackend.contextVersion()) return true;
      if (received) {
        setSubmitted(current => current.map(item => item.entry.id === entry!.id ? { ...item, state: 'accepted' } : item));
        void refresh().catch(() => {}); return true;
      }
      setSubmitted(current => current.map(item => item.entry.id === entry?.id ? { ...item, state: 'failed' } : item));
      if (!failed && !quoteRef.current && !draftRef.current && quoteVersion === quoteRevision.current) setQuote(replyTo);
      setError(error instanceof Error ? error.message : String(error)); return false;
    } finally {
      if (sendingRequest.current === request) { sendingRequest.current = undefined; setSubmission(undefined); }
    }
  };
  const focusComposer = () => (composerPortalTarget ?? composerDock.current)?.querySelector<HTMLElement>('.composer-surface textarea,.composer-prompt-editor[contenteditable=true]')?.focus();
  const jumpToMessage = (id: string) => {
    const root = composerPortalTarget?.querySelector('.quick-input-transcript') ?? scroller.current;
    const row = [...(root?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])].find(node => node.dataset.messageId === id)
      ?? [...(scroller.current?.querySelectorAll<HTMLElement>('[data-message-id]') ?? [])].find(node => node.dataset.messageId === id);
    if (!row) return;
    row.scrollIntoView({ block: 'center' }); row.querySelector<HTMLElement>('article')?.focus({ preventScroll: true }); setHighlighted(id);
  };
  const reactToMessage = async (id: string, reaction: AssistantReaction | null) => {
    if (reactionPending.current) return;
    const version = assistantBackend.contextVersion(), contextGeneration = generation.current;
    reactionPending.current = true; setReacting(true); closeMessageMenu();
    try {
      const result = await assistantBackend.react(id, reaction);
      if (version === assistantBackend.contextVersion() && contextGeneration === generation.current) setReactions(result.reactions);
    } catch {
      if (version === assistantBackend.contextVersion()) setError(uiText(language)('assistantMessage.reactionFailed'));
    } finally { reactionPending.current = false; setReacting(false); }
  };
  usePublishRegionConversation({ scope: localInspectorWorkspace('personal-assistant'), busy, error: error || runtimeError, messages: pageMessages, send }, active && !floating);
  const retryReply = async () => {
    viewport.prepareSend();
    setSubmission('retry'); setError(''); setRuntimeError('');
    try { await assistantBackend.retry(await prepareRef.current()); await refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setSubmission(undefined); }
  };
  // Both sides of the call remain available to inference and speech, independently of the page.
  const speechMessages = (items: ConversationEntry[]) => journalMessages(items.filter(entry => entry.source !== 'page' && entry.source !== 'task')
    .map(entry => ({ ...entry, visibility: 'conversation' })), sessionId);
  const target: VoiceTarget = { agent, environment: 'local', sessionId, contextGeneration: generation.current, messages: speechMessages(entries),
    historyMessages: journalMessages(entries.filter(entry => entry.source !== 'task').map(entry => ({ ...entry, visibility: 'conversation' })), sessionId), sending: busy, language,
    assistant: { name: profile.name, persona: profile.persona }, audioPreferences: readAssistantProfile,
    onMicrophoneMuteChange: microphoneMuted => saveAssistantProfile({ ...readAssistantProfile(), microphoneMuted }),
    send: text => voice.snapshot().mode === 'call' ? submit(text, true) : send(text) };
  target.refresh = () => ({ ...target, contextGeneration: generation.current, messages: speechMessages(entriesRef.current),
    historyMessages: journalMessages(entriesRef.current.filter(entry => entry.source !== 'task').map(entry => ({ ...entry, visibility: 'conversation' })), sessionId), sending: busyRef.current });
  const [eventsOpen, setEventsOpen] = useState(false);
  const headerControls = <div className="assistant-actions">
    <div className="assistant-composer-tools">
      <button type="button" title={uiText(language)('teamSidebar.manageAgents')} onClick={onManageHosts}><UsersRound size={17}/></button>
    </div>
  </div>;
  const renderTimelineItem = (item: typeof timeline[number]) => {
    if ('task' in item) return <AssistantTaskBubble key={item.key} task={item.task} language={language}/>;
    const { entry } = item;
    const pending = submitted.find(item => item.entry.id === entry.id);
    const openMenu = (trigger: HTMLElement, x: number, y: number) => {
      const selection = window.getSelection();
      const selected = selection && trigger.contains(selection.anchorNode) && trigger.contains(selection.focusNode) ? selection.toString().trim() : '';
      setMessageMenu({ entry, trigger, x, y, selection: selected, disabled: Boolean(pending && pending.state !== 'accepted') });
    };
    const reaction = Object.hasOwn(reactions, entry.id) ? reactions[entry.id] : undefined;
    return <div className="message-list-item assistant-message-row" data-message-role={entry.role} data-message-id={entry.id} key={entry.id}><article tabIndex={0}
      aria-label={uiText(language)('assistantMessage.messageFrom', { name: entry.role === 'user' ? uiText(language)('assistantMessage.you') : profile.name })}
      data-quote-highlight={highlighted === entry.id}
      onContextMenu={event => {
        if (event.defaultPrevented || (event.target as HTMLElement).closest('a,button,input,textarea,video,audio,[contenteditable=true]')) return;
        event.preventDefault(); event.stopPropagation(); openMenu(event.currentTarget, event.clientX, event.clientY);
      }} onKeyDown={event => {
        if (event.target !== event.currentTarget || (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))) return;
        event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); openMenu(event.currentTarget, rect.left, rect.bottom);
      }} className={`assistant-message assistant-message-${entry.role}${arriving.has(entry.id) ? ' assistant-message-arriving' : ''}`}>
    {entry.replyTo && <AssistantQuote source={pageEntries.find(item => item.id === entry.replyTo!.messageId)} excerpt={entry.replyTo.excerpt}
      language={language} assistantName={profile.name} onJump={() => jumpToMessage(entry.replyTo!.messageId)}/>}
    {entry.role === 'user' && Boolean(entry.attachments?.length) && <section className="user-message-attachments" aria-label={uiText(language)('image.scope.attachments')}>
      <MessageImageStrip paths={(entry.attachments ?? []).filter(file => file.type === 'image').flatMap(file => file.path ? [file.path] : [])} language={language}/>
      <MessageFileAttachmentStrip attachments={(entry.attachments ?? []).filter(file => file.type !== 'image')} language={language}/>
    </section>}
    {entry.content && <div className="assistant-text-bubble">{entry.role === 'assistant'
      ? <MarkdownContent content={entry.content} language={language}/>
      : <p><PromptReferenceFallback content={entry.content}/></p>}</div>}
    {reaction && <button type="button" className="assistant-message-reaction" disabled={reacting}
      title={uiText(language)('assistantMessage.removeReaction', { reaction: reactionName(language, reaction) })}
      aria-label={uiText(language)('assistantMessage.removeReaction', { reaction: reactionName(language, reaction) })}
      onClick={() => void reactToMessage(entry.id, null)}>{reaction}</button>}
    {pending?.state === 'sending' && <span className="assistant-message-delivery" role="status">{uiText(language)('assistantView.sendingMessage')}</span>}
    {pending?.state === 'failed' && <button type="button" className="assistant-message-retry" disabled={submitting} onClick={() => void send(pending.prompt, pending)}>{uiText(language)('assistantView.retryMessage')}</button>}
  </article></div>;
  };
  const renderTimeline = (items: typeof timeline) => {
    const separators = assistantTimeSeparators(items);
    return items.map(item => <Fragment key={item.key}>
      {separators.has(item.key) && <div className="assistant-time-separator"><time dateTime={item.at}>{assistantTimeLabel(item.at, language)}</time></div>}
      {renderTimelineItem(item)}
    </Fragment>);
  };
  const typingBubble = replying && <div className="message-list-item assistant-message-row assistant-activity-row" data-message-role="status">
    <div className="assistant-typing-bubble" role="status" aria-label={uiText(language)('assistantView.replying')}>
      <span aria-hidden="true"/><span aria-hidden="true"/><span aria-hidden="true"/>
    </div>
  </div>;
  const floatingView = floating && capsule.host && createPortal(
      <FloatingAssistantCapsule language={language} composing={capsule.surface === 'compose'} unread={capsule.unread}
        ready={ready} sending={submitting} calling={callHere} voiceOpen={capsule.surface === 'voice'} voiceBlocked={voiceInUse && !callHere} draft={draft} changeDraft={setDraft}
        files={capsuleFiles} changeFiles={setCapsuleFiles} compose={() => void capsule.show('compose')}
        collapse={() => void capsule.show('capsule')} open={() => void capsule.show('replies')} send={send}
        repliesOpen={capsule.surface === 'replies'} replies={capsule.replies} error={error || runtimeError ? assistantErrorText(error || runtimeError, language) : ''}
        returnToWorkspace={floating.returnToWorkspace}
        openVoice={() => {
          if (!callHere) { voice.update(target); void voice.start('call'); }
          void capsule.show('voice');
        }}/>, capsule.host);
  if (!active && !hasOpened.current) return null;
  if (!composerControls) return <VoiceConversation target={target} language={language} disabled={!ready} active={active}>{floatingView}</VoiceConversation>;
  return <section className={`assistant-view chat-panel composer-layout-managed${viewport.anchored ? ' composer-anchored' : ''}${summary.workSummaryPresence.mounted ? ' work-summary-requested' : ''}${summary.workSummaryPresence.visible ? ' work-summary-visible' : ''} ${summary.workSummaryDocked ? 'work-summary-docked' : 'work-summary-overlay'} ${windowMaximized ? 'window-maximized' : 'window-restored'}`}
    data-composer-after-send={viewport.flow.afterSend} data-conversation-output={viewport.flow.output} hidden={!active} aria-label={profile.name}>
    {floatingView}
    <TopBar title={profile.name} language={language} inspectorOpen={inspectorOpen} onToggleInspector={onToggleInspector}
      titleIcon={<span title={callHere ? uiText(language)('assistantView.inCallContinuesInTheBackground') : profile.name}><AssistantBulb size={22} working={busy}/></span>}
      workspaceControl={headerControls} conversationContentAvailable={timeline.length > 0} workSummaryVisible={summary.showWorkSummary}
      workSummaryHoverProps={summary.workSummaryHoverProps} onToggleWorkSummary={summary.toggleWorkSummary}/>
    {eventsOpen && active && <AssistantEventsDialog language={language} close={() => setEventsOpen(false)}/>}
    {messageMenu && active && <AssistantMessageMenu key={messageMenu.entry.id} target={messageMenu} language={language} reaction={reactions[messageMenu.entry.id]} pending={reacting}
      onClose={closeMessageMenu} onReply={excerpt => {
        const replyTo = { messageId: messageMenu.entry.id, ...(excerpt ? { excerpt } : {}) };
        quoteRevision.current++; quoteRef.current = replyTo; setQuote(replyTo); closeMessageMenu(); focusComposer();
      }} onCopy={() => {
        const text = messageMenu.selection || assistantQuoteText(messageMenu.entry, language);
        closeMessageMenu(); void copyText(text).catch(() => setError(uiText(language)('assistantMessage.copyFailed')));
      }} onReact={reaction => void reactToMessage(messageMenu.entry.id, reactions[messageMenu.entry.id] === reaction ? null : reaction)}/>}
    {(error || runtimeError) && <RuntimeStatusBanner language={language} tone="error" message={assistantErrorText(error || runtimeError, language)}
      actionLabel={canRetry ? uiText(language)('assistantView.retryReply') : undefined} onAction={canRetry ? retryReply : undefined}
      onDismiss={() => { setError(''); setRuntimeError(''); }}/>}
    {eventNeedsResponse && <div className="assistant-event-response" role="status"><button type="button" onClick={() => setEventsOpen(true)}>{uiText(language)('assistant.events.respond')}</button></div>}
    {retry && !error && !runtimeError && <ConversationConnectionNotice language={language}
      update={{ ...retry, sessionId, state: 'retrying', source: 'provider', reason: retry.code }}/>}
    <div className="assistant-body"><div className="assistant-chat chat-body" ref={chatBody} style={{ '--work-summary-anchor-right': `${summary.workSummaryAnchorRight}px` } as CSSProperties}>
      {summary.workSummaryPresence.mounted && <ConversationWorkSummary language={language} sessionId={sessionId} messages={pageMessages} changeReports={[]}
        taskPlan={taskPlan}
        onOpenChangeReview={() => {}} subagentObservabilityAvailable={subagentObservabilityAvailable}
        hoverProps={summary.workSummaryPanelProps} keepOpenUntil={summary.keepWorkSummaryOpenUntil}
        running={busy} softVisible={summary.workSummaryPresence.visible}/>}
      <div className="chat-content-frame">
      <div className="assistant-messages message-list" ref={scroller} tabIndex={-1} role="log" aria-label={uiText(language)('assistantView.assistantConversation')}>
      <div className="message-list-content">
        {!timeline.length && <div className="assistant-welcome"><AssistantBulb size={68}/><h2>{uiText(language)('assistantView.letSTalk')}</h2><p>{uiText(language)('assistantView.shareAThoughtOrHandOverA')}</p></div>}
        {renderTimeline(timeline)}
        {typingBubble}
      </div></div>
      <VoiceConversation target={target} language={language} disabled={!ready} active={active}>
        <div className="assistant-composer-dock composer-dock" ref={composerDock}>
          <ComposerPortalContext.Provider value={composerPortalTarget}>
          <QuickInputStatus language={language} messages={pageMessages} sending={busy || tasks.some(task => !task.terminal)}
            submitting={submitting} error={error || runtimeError}
            recovery={retry ? { ...retry, sessionId, state: 'retrying', source: 'provider' } : null} sessionId={sessionId}>
            {renderTimeline(timeline.slice(-12))}
            {typingBubble}
          </QuickInputStatus>
          <AssistantComposer controls={composerControls} language={language} draft={draft} onDraftChange={setDraft}
            quote={quote && <AssistantQuote source={pageEntries.find(item => item.id === quote.messageId)} excerpt={quote.excerpt}
              language={language} assistantName={profile.name} onJump={() => jumpToMessage(quote.messageId)} onCancel={() => { quoteRevision.current++; quoteRef.current = undefined; setQuote(undefined); focusComposer(); }}/>}
            interaction={management?.permissions[0] && <AssistantPermissionCard key={management.permissions[0].permissionId}
              permission={management.permissions[0]} language={language} onResolved={refresh}/>}
            nextStepPrediction={nextStepPrediction} predictionPending={busy || submitting || Boolean(error || runtimeError)}
            ready={ready} submitting={submitting} onSend={send} fileDropTarget={chatBody} messages={pageMessages} browserTabs={browserTabs}/>
          </ComposerPortalContext.Provider>
        </div>
      </VoiceConversation>
      </div><ScrollBottomButton language={language} visible={viewport.scrollBottomVisible && !management?.permissions.length} running={busy} onClick={viewport.scrollToBottom}/>
    </div></div>
  </section>;
}
