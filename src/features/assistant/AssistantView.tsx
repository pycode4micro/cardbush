import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { Monitor, Server, Settings2, X, PhoneOff, Link } from 'lucide-react';
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

const sessionId = PERSONAL_ASSISTANT_SESSION;
// Also hide transcripts saved by older versions, without deleting conversational memory.
const isPageEntry = (entry: ConversationEntry) => entry.visibility !== 'internal' && entry.source !== 'voice';
export function AssistantView({ active, language, connections, prepare, onManageHosts, composerControls,
  inspectorOpen = false, onToggleInspector, browserTabs = [], composerPortalTarget = null, windowMaximized = false, subagentObservabilityAvailable = false }: {
  active: boolean; language: 'zh' | 'en'; connections: AgentConnection[];
  prepare(): Promise<ChatStreamRequest>; onManageHosts(): void;
  composerControls: AssistantComposerControls;
  inspectorOpen?: boolean; onToggleInspector?(): void; browserTabs?: BrowserPromptReference[];
  composerPortalTarget?: HTMLElement | null; windowMaximized?: boolean; subagentObservabilityAvailable?: boolean;
}) {
  const zh = language === 'zh', profile = useAssistantProfile();
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
  const [retry, setRetry] = useState<ConversationJournalSnapshot['retry']>(null);
  const [settings, setSettings] = useState(false), [desktop, setDesktop] = useState(false);
  useEffect(() => { if (!active) setSettings(false); }, [active]);
  const prepareRef = useRef(prepare); prepareRef.current = prepare;
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
  const voice = applicationVoiceSession(), voiceState = useSyncExternalStore(voice.subscribe, voice.snapshot);
  const callHere = voiceState.mode === 'call' && voiceState.assistant;
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
  const submit = useCallback(async (text: string, spoken = false) => {
    const contextVersion = assistantBackend.contextVersion();
    await ensure();
    const config = await prepareRef.current();
    await assistantBackend.send(text, config, spoken, contextVersion);
    await refresh(); return true;
  }, [ensure, refresh]);
  const agent = useMemo(() => assistantBackend.voice(async () => { await ensure(); return { ...await prepareRef.current(), sessionId }; }), [ensure]);
  const [submitting, setSubmitting] = useState(false);
  // Typed messages and recording transcripts share positioning, acceptance and errors.
  const send = async (text: string) => {
    if (!text.trim() || submitting) return false;
    viewport.prepareSend();
    setSubmitting(true); setError('');
    try { await submit(text); return true; }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); return false; }
    finally { setSubmitting(false); }
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
    if (!api || !profile.targetAgent) throw Error('请先选择执行主机。');
    await api.connect(profile.targetAgent);
    return api.call(profile.targetAgent, operation, input) as Promise<T>;
  }, [profile.targetAgent]);
  const headerControls = <div className="assistant-actions">
    <SettingsDropdown value={profile.targetAgent} onChange={targetAgent => { saveAssistantProfile({ ...profile, targetAgent }); setDesktop(false); }}
      label={zh ? '执行主机' : 'Execution host'} options={[{ value: '', label: zh ? '本地' : 'Local', icon: <Monitor size={14}/> }, ...connections.map(item => ({ value: item.id, label: `${item.name}${item.sshTunnel ? ' · SSH' : ''}`, icon: <Server size={14}/> }))]}/>
    <div className="assistant-composer-tools">
      {callHere && <button type="button" className="assistant-hangup" title={zh ? '结束通话' : 'End call'} onClick={() => voice.end()}><PhoneOff size={17}/></button>}
      <button type="button" title={zh ? '连接 SSH / 管理主机' : 'Connect SSH / manage hosts'} onClick={onManageHosts}><Link size={17}/></button>
      {host && <button type="button" aria-pressed={desktop} title={zh ? '云端电脑' : 'Remote computer'} onClick={() => setDesktop(value => !value)}><Monitor size={18}/></button>}
      <button type="button" title={zh ? '助手设置' : 'Assistant settings'} onClick={() => setSettings(true)}><Settings2 size={18}/></button>
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
  return <section className={`assistant-view chat-panel composer-layout-managed${viewport.anchored ? ' composer-anchored' : ''}${summary.workSummaryPresence.mounted ? ' work-summary-requested' : ''}${summary.workSummaryPresence.visible ? ' work-summary-visible' : ''} ${summary.workSummaryDocked ? 'work-summary-docked' : 'work-summary-overlay'} ${windowMaximized ? 'window-maximized' : 'window-restored'}`}
    data-composer-after-send={viewport.flow.afterSend} data-conversation-output={viewport.flow.output} hidden={!active} aria-label={profile.name}>
    <TopBar title={profile.name} language={language} inspectorOpen={inspectorOpen} onToggleInspector={onToggleInspector}
      titleIcon={<span title={callHere ? zh ? '通话中 · 切换页面仍可继续' : 'In call · continues in the background' : profile.name}><AssistantBulb size={22} working={busy}/></span>}
      workspaceControl={headerControls} conversationContentAvailable={timeline.length > 0} workSummaryVisible={summary.showWorkSummary}
      onToggleWorkSummary={anchor => { summary.updateWorkSummaryLayout(anchor); summary.setWorkSummaryVisible(value => !value); }}/>
    {settings && active && <AssistantSettingsDialog language={language} onClose={() => setSettings(false)}/>}
    {(error || runtimeError) && <RuntimeStatusBanner language={language} tone="error" message={error || runtimeError}
      onDismiss={() => { setError(''); setRuntimeError(''); }}/>}
    {retry && !error && !runtimeError && <ConversationConnectionNotice language={language}
      update={{ ...retry, sessionId, state: 'retrying', source: 'provider', reason: retry.code }}/>}
    <div className="assistant-body"><div className="assistant-chat chat-body" ref={chatBody} style={{ '--work-summary-anchor-right': `${summary.workSummaryAnchorRight}px` } as CSSProperties}>
      {summary.workSummaryPresence.mounted && <ConversationWorkSummary language={language} sessionId={sessionId} messages={pageMessages} changeReports={[]}
        onOpenChangeReview={() => {}} subagentObservabilityAvailable={subagentObservabilityAvailable} softVisible={summary.workSummaryPresence.visible}/>}
      <div className="chat-content-frame">
      <div className="assistant-messages message-list" ref={scroller} tabIndex={-1} role="log" aria-label={zh ? '助手对话' : 'Assistant conversation'}>
      <div className="message-list-content">
        {!timeline.length && <div className="assistant-welcome"><AssistantBulb size={68}/><h2>{zh ? '随时聊聊' : 'Let’s talk'}</h2><p>{zh ? '说说想法，或把事情交给我。任务在后台进行，我们可以继续聊。' : 'Share a thought or hand over a task. We can keep talking while work continues.'}</p></div>}
        {timeline.map(renderTimelineItem)}
      </div></div>
      <VoiceConversation target={target} language={language} disabled={!ready} active={active}>
        <div className="assistant-composer-dock composer-dock" ref={composerDock}>
          <ComposerPortalContext.Provider value={composerPortalTarget}>
          <QuickInputStatus language={language} messages={pageMessages} sending={busy || tasks.some(task => !task.terminal)}
            submitting={submitting} error={error || runtimeError}
            recovery={retry ? { ...retry, sessionId, state: 'retrying', source: 'provider' } : null} sessionId={sessionId}>
            {timeline.slice(-12).map(renderTimelineItem)}
          </QuickInputStatus>
          <AssistantComposer controls={composerControls} language={language} draft={draft} onDraftChange={setDraft}
            ready={ready} submitting={submitting} onSend={send} fileDropTarget={chatBody} messages={pageMessages} browserTabs={browserTabs}/>
          </ComposerPortalContext.Provider>
        </div>
      </VoiceConversation>
      </div><ScrollBottomButton language={language} visible={viewport.scrollBottomVisible} onClick={viewport.scrollToBottom}/>
    </div>{desktop && host && <aside className="assistant-desktop"><button className="assistant-desktop-close" type="button" onClick={() => setDesktop(false)} aria-label={zh ? '关闭云端电脑' : 'Close remote computer'}><X size={18}/></button><AgentDesktopView call={remoteCall} active={active} name={host.name} language={language}/></aside>}</div>
  </section>;
}
