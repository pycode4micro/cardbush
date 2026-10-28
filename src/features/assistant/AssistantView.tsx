import { uiText } from '../../i18n';
import { readUserPrompt, type UserPromptInput } from '@cardbush/bush-protocol';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { Monitor, Server, Settings2, X, Link } from 'lucide-react';
import { PERSONAL_ASSISTANT_SESSION, type ConversationEntry } from '@cardbush/bush-protocol';
import type { ChatStreamRequest } from '../../backend/api';
import { journalMessages, type ConversationJournalSnapshot } from '../../backend/conversationJournal';
import { assistantBackend } from './assistantBackend';
import { VoiceConversation, applicationVoiceSession } from '../voice/VoiceConversation';
import type { VoiceTarget } from '../voice/voiceSession';
import { MarkdownContent, MessageFileAttachmentStrip, MessageImageStrip } from '../chatMessages/MessageBubble';
import { AssistantComposer, type AssistantComposerControls } from './AssistantComposer';
import { SettingsDropdown } from '../settings/SettingsDropdown';
import { AgentDesktopPanel as AgentDesktopView } from '../agents/AgentDesktopPanel';
import type { AgentConnection, AgentOperation } from '../../../electron/agentTypes';
import { AssistantBulb } from './AssistantBulb';
import { AssistantSettingsDialog } from './AssistantSettingsDialog';
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

const sessionId = PERSONAL_ASSISTANT_SESSION;
// Also hide transcripts saved by older versions, without deleting conversational memory.
const isPageEntry = (entry: ConversationEntry) => entry.visibility !== 'internal' && entry.source !== 'voice';
export function AssistantView({ active, language, connections, prepare, onManageHosts, composerControls,
  inspectorOpen = false, onToggleInspector, browserTabs = [], composerPortalTarget = null, windowMaximized = false, subagentObservabilityAvailable = false }: {
  active: boolean; language: string; connections: AgentConnection[];
  prepare(): Promise<ChatStreamRequest>; onManageHosts(): void;
  composerControls: AssistantComposerControls;
  inspectorOpen?: boolean; onToggleInspector?(): void; browserTabs?: BrowserPromptReference[];
  composerPortalTarget?: HTMLElement | null; windowMaximized?: boolean; subagentObservabilityAvailable?: boolean;
}) {
  const profile = useAssistantProfile();
  const [entries, setEntries] = useState<ConversationEntry[]>([]), [ready, setReady] = useState(false);
  const pageEntries = useMemo(() => entries.filter(isPageEntry), [entries]);
  const allTasks = useLoopSubagentTasks(sessionId, active && ready, active);
  // Reset removes the journal; do not resurrect old tasks in a fresh conversation.
  const tasks = allTasks.filter(task => task.origin === 'subagent' && task.taskId && entries.length &&
    (task.createdAt || task.startedAt || '') >= entries[0].createdAt);
  const timeline = [...pageEntries.map(entry => ({ key: entry.id, at: entry.createdAt, entry })),
    ...tasks.map(task => ({ key: task.taskId!, at: task.createdAt || task.startedAt || '', task }))]
    .sort((a, b) => a.at.localeCompare(b.at));
  const lastPageEntry = timeline.at(-1)?.key;
  const pageMessages = useMemo(() => journalMessages(pageEntries, sessionId), [pageEntries]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [draft, setDraft] = useState('');
  const [runtimeError, setRuntimeError] = useState('');
  const [canRetry, setCanRetry] = useState(false), [stopping, setStopping] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [nextStepPrediction, setNextStepPrediction] = useState<ConversationJournalSnapshot['nextStepPrediction']>();
  const replying = (busy || submitting) && !error && !runtimeError;
  const [retry, setRetry] = useState<ConversationJournalSnapshot['retry']>(null);
  const [settings, setSettings] = useState(false), [desktop, setDesktop] = useState(false);
  useEffect(() => { if (!active) setSettings(false); }, [active]);
  const prepareRef = useRef(prepare); prepareRef.current = prepare;
  useEffect(() => {
    let cancelled = false;
    void prepareRef.current().then(config => {
      if (!cancelled) return window.cardbushDesktop?.embodied?.command({ action: 'assistant.save', input: {
        profile, language, modelId: config.modelConfig?.id || config.model,
        permissionMode: config.permissionMode || 'task_free',
        subagentPermissionRouting: config.subagentPermissionRouting, planEnabled: config.referencePlanMode !== 'off',
        disabledTools: config.disabledTools || [], disabledSkills: config.disabledSkills || [],
      } });
    }).catch(() => { /* Model/configuration startup can complete after this render. */ });
    return () => { cancelled = true; };
  }, [profile, language, composerControls.selectedModel, composerControls.availableModels, composerControls.permissionMode, composerControls.subagentPermissionRouting, composerControls.referencePlanMode, composerControls.disabledSkillNames]);
  const entriesRef = useRef(entries); entriesRef.current = entries;
  const busyRef = useRef(busy); busyRef.current = busy;
  const cursor = useRef(0);
  const generation = useRef<number | undefined>(undefined);
  const refreshing = useRef<Promise<void> | undefined>(undefined);
  const chatBody = useRef<HTMLDivElement>(null), activeRef = useRef(active); activeRef.current = active;
  const scroller = useRef<HTMLDivElement>(null), composerDock = useRef<HTMLDivElement>(null);
  const viewport = useAssistantViewport({ active, bodyRef: chatBody, dockRef: composerDock, scrollerRef: scroller, revision: lastPageEntry, portaled: Boolean(composerPortalTarget) });
  const summary = useConversationWorkSummary(chatBody, sessionId, inspectorOpen);
  const historyLoaded = useRef(false), animationTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const [arriving, setArriving] = useState<Set<string>>(() => new Set());
  useEffect(() => () => animationTimers.current.forEach(clearTimeout), []);
  useEffect(() => { if (!active) setArriving(new Set()); }, [active]);
  const voice = applicationVoiceSession();
  const callHere = useSyncExternalStore(voice.subscribe, () => voice.snapshot().mode === 'call' && Boolean(voice.snapshot().assistant));
  const host = connections.find(item => item.id === profile.targetAgent);
  const initialize = useRef<Promise<unknown> | undefined>(undefined);
  const ensure = useCallback(() => initialize.current ??= assistantBackend.ensure(profile.name)
    .catch(error => { initialize.current = undefined; throw error; }), [profile.name]);
  const refresh = useCallback(() => {
    if (refreshing.current) return refreshing.current;
    refreshing.current = (async () => {
      let result = await assistantBackend.read(cursor.current);
      const reset = result.cursor < cursor.current || result.generation !== generation.current;
      if (reset) result = await assistantBackend.read(0);
      generation.current = result.generation;
      if (historyLoaded.current && !reset && activeRef.current && result.entries.length) {
        const ids = result.entries.filter(isPageEntry).map(entry => entry.id);
        setArriving(current => new Set([...current, ...ids]));
        const timer = setTimeout(() => { setArriving(current => new Set([...current].filter(id => !ids.includes(id)))); animationTimers.current = animationTimers.current.filter(item => item !== timer); }, 420);
        animationTimers.current.push(timer);
      }
      historyLoaded.current = true;
      cursor.current = result.cursor;
      if (reset) setEntries(result.entries);
      else if (result.entries.length) setEntries(current => [...current, ...result.entries.filter(entry => !current.some(old => old.id === entry.id))]);
      setBusy(result.busy); setAssistantWorking(result.busy || Boolean(result.workingTasks)); setRuntimeError(result.error); setRetry(result.retry);
      setNextStepPrediction(current => JSON.stringify(current) === JSON.stringify(result.nextStepPrediction) ? current : result.nextStepPrediction);
      setCanRetry(result.canRetry === true);
    })().finally(() => { refreshing.current = undefined; });
    return refreshing.current;
  }, []);
  useEffect(() => {
    const reset = () => { setDraft(''); setError(''); setRuntimeError(''); setRetry(null); setArriving(new Set()); void refresh().then(() => refresh()).catch(error => setError(String(error))); };
    window.addEventListener('cardbush:assistant-reset', reset);
    return () => window.removeEventListener('cardbush:assistant-reset', reset);
  }, [refresh]);
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
  const submit = useCallback(async (text: UserPromptInput, spoken = false) => {
    const contextVersion = assistantBackend.contextVersion();
    await ensure();
    const config = await prepareRef.current();
    await assistantBackend.send(text, config, spoken, contextVersion);
    await refresh(); return true;
  }, [ensure, refresh]);
  const agent = useMemo(() => assistantBackend.voice(async () => { await ensure(); return { ...await prepareRef.current(), sessionId }; }), [ensure]);
  // Typed messages and recording transcripts share positioning, acceptance and errors.
  const send = async (text: UserPromptInput) => {
    if (!readUserPrompt(text).text.trim() || submitting) return false;
    viewport.prepareSend();
    setSubmitting(true); setError(''); setRuntimeError('');
    try { await submit(text); return true; }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); return false; }
    finally { setSubmitting(false); }
  };
  usePublishRegionConversation({ scope: localInspectorWorkspace('personal-assistant'), busy, error: error || runtimeError, messages: pageMessages, send }, active);
  const retryReply = async () => {
    viewport.prepareSend();
    setSubmitting(true); setError(''); setRuntimeError('');
    try { await assistantBackend.retry(await prepareRef.current()); await refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setSubmitting(false); }
  };
  const stopReply = async () => {
    if (stopping) return;
    setStopping(true);
    try { await assistantBackend.stop(); await refresh(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { setStopping(false); }
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
  const remoteCall = useCallback(async <T,>(operation: AgentOperation, input?: Record<string, unknown>) => {
    const api = window.cardbushDesktop?.agents;
    if (!api || !profile.targetAgent) throw Error(uiText(language)('assistantView.select_an_execution_host_first'));
    await api.connect(profile.targetAgent);
    return api.call(profile.targetAgent, operation, input) as Promise<T>;
  }, [profile.targetAgent]);
  const headerControls = <div className="assistant-actions">
    <SettingsDropdown value={profile.targetAgent} onChange={targetAgent => { saveAssistantProfile({ ...profile, targetAgent }); setDesktop(false); }}
      label={uiText(language)('assistantView.executionHost')} options={[{ value: '', label: uiText(language)('workspace.local'), icon: <Monitor size={14}/> }, ...connections.map(item => ({ value: item.id, label: `${item.name}${item.sshTunnel ? ' · SSH' : ''}`, icon: <Server size={14}/> }))]}/>
    <div className="assistant-composer-tools">
      <button type="button" title={uiText(language)('assistantView.connectSshManageHosts')} onClick={onManageHosts}><Link size={17}/></button>
      {host && <button type="button" aria-pressed={desktop} title={uiText(language)('assistantView.remoteComputer')} onClick={() => setDesktop(value => !value)}><Monitor size={18}/></button>}
      <button type="button" title={uiText(language)('assistantSettingsDialog.assistantSettings')} onClick={() => setSettings(true)}><Settings2 size={18}/></button>
    </div>
  </div>;
  const renderTimelineItem = (item: typeof timeline[number]) => {
    if ('task' in item) return <AssistantTaskBubble key={item.key} task={item.task} language={language}/>;
    const { entry } = item;
    return <div className="message-list-item assistant-message-row" data-message-role={entry.role} data-message-id={entry.id} key={entry.id}><article className={`assistant-message assistant-message-${entry.role}${arriving.has(entry.id) ? ' assistant-message-arriving' : ''}`}>
    <div>{entry.role === 'assistant' ? <MarkdownContent content={entry.content} language={language}/> : <>
      <MessageImageStrip paths={(entry.attachments ?? []).filter(file => file.type === 'image').flatMap(file => file.path ? [file.path] : [])} language={language}/>
      <MessageFileAttachmentStrip attachments={(entry.attachments ?? []).filter(file => file.type !== 'image')} language={language}/><p><PromptReferenceFallback content={entry.content}/></p>
    </>}</div>
    <time dateTime={entry.createdAt}>{new Date(entry.createdAt).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })}</time>
  </article></div>;
  };
  const typingBubble = replying && <div className="message-list-item assistant-message-row assistant-activity-row" data-message-role="status">
    <div className="assistant-typing-bubble" role="status" aria-label={uiText(language)('assistantView.replying')}>
      <span aria-hidden="true"/><span aria-hidden="true"/><span aria-hidden="true"/>
    </div>
    {busy && <button className="assistant-stop-reply" type="button" disabled={stopping} onClick={() => void stopReply()}>
      {uiText(language)('assistantView.stopWaiting')}
    </button>}
  </div>;
  return <section className={`assistant-view chat-panel composer-layout-managed${viewport.anchored ? ' composer-anchored' : ''}${summary.workSummaryPresence.mounted ? ' work-summary-requested' : ''}${summary.workSummaryPresence.visible ? ' work-summary-visible' : ''} ${summary.workSummaryDocked ? 'work-summary-docked' : 'work-summary-overlay'} ${windowMaximized ? 'window-maximized' : 'window-restored'}`}
    data-composer-after-send={viewport.flow.afterSend} data-conversation-output={viewport.flow.output} hidden={!active} aria-label={profile.name}>
    <TopBar title={profile.name} language={language} inspectorOpen={inspectorOpen} onToggleInspector={onToggleInspector}
      titleIcon={<span title={callHere ? uiText(language)('assistantView.inCallContinuesInTheBackground') : profile.name}><AssistantBulb size={22} working={busy}/></span>}
      workspaceControl={headerControls} conversationContentAvailable={timeline.length > 0} workSummaryVisible={summary.showWorkSummary}
      workSummaryHoverProps={summary.workSummaryHoverProps} onToggleWorkSummary={summary.toggleWorkSummary}/>
    {settings && active && <AssistantSettingsDialog language={language} onClose={() => setSettings(false)}/>}
    {(error || runtimeError) && <RuntimeStatusBanner language={language} tone="error" message={error || runtimeError}
      actionLabel={canRetry ? uiText(language)('assistantView.retryReply') : undefined} onAction={canRetry ? retryReply : undefined}
      onDismiss={() => { setError(''); setRuntimeError(''); }}/>}
    {retry && !error && !runtimeError && <ConversationConnectionNotice language={language}
      update={{ ...retry, sessionId, state: 'retrying', source: 'provider', reason: retry.code }}/>}
    <div className="assistant-body"><div className="assistant-chat chat-body" ref={chatBody} style={{ '--work-summary-anchor-right': `${summary.workSummaryAnchorRight}px` } as CSSProperties}>
      {summary.workSummaryPresence.mounted && <ConversationWorkSummary language={language} sessionId={sessionId} messages={pageMessages} changeReports={[]}
        onOpenChangeReview={() => {}} subagentObservabilityAvailable={subagentObservabilityAvailable}
        hoverProps={summary.workSummaryPanelProps} keepOpenUntil={summary.keepWorkSummaryOpenUntil}
        running={busy} softVisible={summary.workSummaryPresence.visible}/>}
      <div className="chat-content-frame">
      <div className="assistant-messages message-list" ref={scroller} tabIndex={-1} role="log" aria-label={uiText(language)('assistantView.assistantConversation')}>
      <div className="message-list-content">
        {!timeline.length && <div className="assistant-welcome"><AssistantBulb size={68}/><h2>{uiText(language)('assistantView.letSTalk')}</h2><p>{uiText(language)('assistantView.shareAThoughtOrHandOverA')}</p></div>}
        {timeline.map(renderTimelineItem)}
        {typingBubble}
      </div></div>
      <VoiceConversation target={target} language={language} disabled={!ready} active={active}>
        <div className="assistant-composer-dock composer-dock" ref={composerDock}>
          <ComposerPortalContext.Provider value={composerPortalTarget}>
          <QuickInputStatus language={language} messages={pageMessages} sending={busy || tasks.some(task => !task.terminal)}
            submitting={submitting} error={error || runtimeError}
            recovery={retry ? { ...retry, sessionId, state: 'retrying', source: 'provider' } : null} sessionId={sessionId}>
            {timeline.slice(-12).map(renderTimelineItem)}
            {typingBubble}
          </QuickInputStatus>
          <AssistantComposer controls={composerControls} language={language} draft={draft} onDraftChange={setDraft}
            nextStepPrediction={nextStepPrediction} predictionPending={busy || submitting || Boolean(error || runtimeError)}
            ready={ready} submitting={submitting} onSend={send} fileDropTarget={chatBody} messages={pageMessages} browserTabs={browserTabs}/>
          </ComposerPortalContext.Provider>
        </div>
      </VoiceConversation>
      </div><ScrollBottomButton language={language} visible={viewport.scrollBottomVisible} running={busy} onClick={viewport.scrollToBottom}/>
    </div>{desktop && host && <aside className="assistant-desktop"><button className="assistant-desktop-close" type="button" onClick={() => setDesktop(false)} aria-label={uiText(language)('assistantView.closeRemoteComputer')}><X size={18}/></button><AgentDesktopView call={remoteCall} active={active} name={host.name} language={language}/></aside>}</div>
  </section>;
}
