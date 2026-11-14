import { WebLanguage } from './Language';
import { uiText } from '../src/i18n';
import { useUiLanguage } from '../src/i18n/react';
import { createFrameStreamBuffers, type FrameStreamCheckpoint } from '../src/features/chatMessages/transcript/frameStreamBuffer';
import { AttachmentDrafts, Solutions, UploadButton, useAttachments, type Attachment } from './AgentWidgets';
import { NativeTranscript } from './NativeTranscript';
import { isSessionServiceFailure, recoverSessionSubmission, sessionServiceError } from './sessionService';
import { SessionConnectionStatus } from './templates/SessionConnectionStatus.template';
import { applyTranscriptEvent, writeLiveSegment, type LiveTranscript } from './transcript';
import { observeConversationReflow } from '../src/features/chat/conversationReflow';
import { ScrollBottomButton } from '../src/features/chat/ScrollBottomButton';
import { useScrollBottomPresence } from '../src/hooks/useScrollBottomPresence';
import { activateBrowserCache, type AccountCache } from './browserCache';
import { BrowserCacheContext, useAccountCache } from './BrowserCacheProvider';
import { OrganizationAdmin as Admin } from './OrganizationAdmin';
import { useConversationList } from './useConversationList';
import { useConversationSolutions } from './useConversationSolutions';
import { mergeConversationPage } from './conversationPages';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUp, LogOut, Menu, MessageSquare, MoreHorizontal, PanelLeftClose, PenLine, Plus, Search, ShieldCheck, Sparkles, Square, X } from 'lucide-react';
import { api, ApiError, requestId, setIdentity, watch, type Conversation, type Frame, type Identity, type State, type Department, type Job } from './api';
import './styles.css';
import './nativeTranscript.css';

const errorText = (error: unknown) => error instanceof Error ? error.message : uiText()("web.theOperationCannotBeCompletedRightNow");
const isWorking = (status: string) => status === 'queued' || status === 'running';
const accountChannel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('cardbush-web-identity');
function Brand({ small = false }: { small?: boolean }) {
  const language = useUiLanguage();
 return <div className={`brand ${small ? 'small' : ''}`}><span className="brand-symbol">{uiText(language)("web.brandSymbol")}</span><span>{uiText(language)("web.brandName")}<span className="brand-subtitle">{uiText(language)("web.brandCompany")}</span></span></div>; }

function App() {
  const language = useUiLanguage();

  const [identity, updateIdentity] = useState<Identity | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const revision = useRef(0);
  const cache = useRef<AccountCache | null>(null);
  const apply = useCallback((next: Identity | null) => { revision.current++; cache.current = activateBrowserCache(next?.user.id ?? null); setIdentity(next); updateIdentity(next); setLoading(false); }, []);
  useEffect(() => {
    let alive = true;
    const refresh = () => { const started = revision.current; void api<Identity>('/auth/me').then(next => { if (alive && revision.current === started) { apply(next); setError(''); } }).catch(failure => { if (alive && revision.current === started) { if (failure instanceof ApiError && failure.status === 401) apply(null); else { setLoading(false); setError(uiText()("web.connectionInterruptedPleaseTryAgainLater")); } } }); };
    const logout = () => apply(null);
    const accountChanged = () => { revision.current++; cache.current?.close(); cache.current = null; setIdentity(null); updateIdentity(null); setLoading(true); refresh(); };
    refresh(); window.addEventListener('cardbush:logged-out', logout); window.addEventListener('focus', refresh); window.addEventListener('cardbush:models-changed', refresh);
    if (accountChannel) accountChannel.onmessage = accountChanged;
    const storage = (event: StorageEvent) => { if (event.key === 'cardbush-cache-identity-v1' && cache.current && !cache.current.valid()) accountChanged(); };
    window.addEventListener('storage', storage);
    return () => { alive = false; window.removeEventListener('storage', storage); window.removeEventListener('cardbush:logged-out', logout); window.removeEventListener('focus', refresh); window.removeEventListener('cardbush:models-changed', refresh); if (accountChannel) accountChannel.onmessage = null; };
  }, [apply]);
  const logout = async () => { try { await api('/auth/logout', 'POST', {}); apply(null); accountChannel?.postMessage('changed'); } catch (failure) { setError(errorText(failure)); } };
  if (loading) return <div className="splash"><Brand/><span className="loading-dot"/>{uiText(language)("web.openingYourConversationSpace")}</div>;
  return identity ? <BrowserCacheContext.Provider value={cache.current}><Workspace key={identity.user.id} identity={identity} logout={logout} externalError={error}/></BrowserCacheContext.Provider>
    : <Auth onLogin={next => { apply(next); accountChannel?.postMessage('changed'); }}/>;
}

function Auth({ onLogin }: { onLogin: (identity: Identity) => void }) {
  const language = useUiLanguage();

  const [register, setRegister] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [departments, setDepartments] = useState<Department[]>([]), [company,setCompany] = useState(''), [department,setDepartment] = useState('');
  useEffect(() => { void api<typeof departments>('/auth/departments').then(setDepartments).catch(() => {}); }, []);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = new FormData(event.currentTarget); setBusy(true); setError(''); setNotice('');
    try {
      const credentials = { username: String(values.get('username')), password: String(values.get('password')) };
      if (register) {
        const result = await api<{ message: string }>('/auth/register', 'POST', { ...credentials, display_name: String(values.get('display_name')), department_id: values.get('department_id') || null });
        setNotice(result.message); setRegister(false);
      } else onLogin(await api<Identity>('/auth/login', 'POST', credentials));
    } catch (failure) { setError(errorText(failure)); } finally { setBusy(false); }
  }
  return <main className="auth-page"><section className="auth-story"><Brand/><div className="auth-intro"><span className="eyebrow">{uiText(language)("web.letYourIdeasFlow")}</span><h1>{uiText(language)("web.everyIdeaDeservesAConversation")}</h1><p>{uiText(language)("web.startWithASentenceOrganizeYourThoughtsRefineYourWordsAndFind")}</p></div><div className="auth-orbit" aria-hidden="true"><span>{uiText(language)("web.ideas")}</span><span>{uiText(language)("web.inspiration")}</span><span>{uiText(language)("web.answers")}</span></div><footer>{uiText(language)("web.brandCredit")}</footer></section>
    <section className="auth-form-area"><form onSubmit={submit}><span className="eyebrow">{uiText(language)("web.yourPersonalConversationSpace")}</span><h2>{register ? uiText(language)("web.createAccount") : uiText(language)("web.welcomeBack")}</h2><p className="muted">{register ? uiText(language)("web.afterRegisteringWaitForAnAdministratorToEnableYourAccount") : uiText(language)("web.signInToContinueYourConversations")}</p>
      <label>{uiText(language)("web.username")}<input name="username" autoComplete="username" required minLength={register ? 3 : 1} maxLength={80} pattern={register ? '[A-Za-z0-9_.-]+' : undefined} placeholder={uiText(language)("web.enterYourUsername")}/></label>
      {register && <label>{uiText(language)("web.name")}<input name="display_name" autoComplete="name" required maxLength={120} placeholder={uiText(language)("web.whatShouldWeCallYou")}/></label>}
      <label>{uiText(language)("sshConnectionsPanel.password")}<input name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} minLength={register ? 8 : 1} maxLength={128} required placeholder={register ? uiText(language)("web.atLeast8Characters") : uiText(language)("web.enterYourPassword")}/></label>
      {register && departments.length > 0 && <><label>{uiText(language)("web.company")}<select aria-label={uiText(language)("web.registrationCompany")} value={company} onChange={event=>{setCompany(event.target.value);setDepartment('');}}><option value="">{uiText(language)("web.notSelected")}</option>{[...new Map(departments.map(item=>[item.company_id,item.company_name])).entries()].map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label><label>{uiText(language)("web.department")}<select name="department_id" aria-label={uiText(language)("web.registrationDepartment")} disabled={!company} required={Boolean(company)} value={department} onChange={event=>setDepartment(event.target.value)}><option value="">{company?uiText(language)("web.selectADepartment"):uiText(language)("web.selectACompanyFirst")}</option>{departments.filter(item=>item.company_id===company).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label></>}
      {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="form-notice" role="status">{notice}</p>}
      <button className="primary auth-submit" disabled={busy}>{busy ? uiText(language)("web.pleaseWait") : register ? uiText(language)("web.registerAccount") : uiText(language)("pluginMcpSettings.signIn")}<span>→</span></button>
      <p className="auth-switch">{register ? uiText(language)("web.alreadyHaveAnAccount") : uiText(language)("web.donTHaveAnAccount")}<button type="button" onClick={() => { setRegister(!register); setError(''); setNotice(''); }}>{register ? uiText(language)("web.signInNow") : uiText(language)("web.createAccount")}</button></p>
    </form></section></main>;
}

function Workspace({ identity, logout, externalError }: { identity: Identity; logout: () => Promise<void>; externalError: string }) {
  const language = useUiLanguage();

  const cache = useAccountCache();
  const [selected, setSelected] = useState<string | null>(null), [state, setState] = useState<State | null>(null);
  const [draft, setDraft] = useState(''), [model, setModel] = useState(identity.defaultModelId), [query, setQuery] = useState(''), [error, setError] = useState(externalError);
  useEffect(() => { setModel(previous => identity.models.some(item => item.id === previous) ? previous : identity.defaultModelId); }, [identity.models, identity.defaultModelId]);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [sidebar, setSidebar] = useState(true), [admin, setAdmin] = useState(false), [archive, setArchive] = useState(false);
  const solutions = useConversationSolutions(admin ? null : selected);
  const list = useConversationList(archive, query, setError), conversations = list.items, setConversations = list.setItems, refreshList = list.refresh;
  const [olderLoading, setOlderLoading] = useState(false);
  const stateRef = useRef(state); stateRef.current = state;
  const controllers = useRef(new Map<string, AbortController>()), olderRequest = useRef<AbortController | null>(null);
  const [menu, setMenu] = useState<string | null>(null), [edit, setEdit] = useState<{ id: string; title: string } | null>(null), [deleting, setDeleting] = useState<string | null>(null);
  const [live, setLive] = useState<LiveTranscript>({}), [reconnecting, setReconnecting] = useState(false);
  const [connectionError, setConnectionError] = useState('');
  const [submitting, setSubmitting] = useState<{ sessionId: string; id: string; text: string; attachments: Attachment[] } | null>(null);
  const selectedRef = useRef(selected), mounted = useRef(true), editor = useRef<HTMLTextAreaElement>(null), transcript = useRef<HTMLDivElement>(null), atBottom = useRef(true);
  const [scrollBottomRequested, setScrollBottomRequested] = useState(false);
  const scrollBottomVisible = useScrollBottomPresence({ scrollerRef: transcript, requestedVisible: scrollBottomRequested,
    scope: selected ?? '', enabled: Boolean(selected) && !admin && !loading });
  const updateScrollPosition = useCallback(() => {
    const element = transcript.current;
    if (!element) return;
    atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;
    setScrollBottomRequested(!atBottom.current);
  }, []);
  const upload = useAttachments();
  const [compacting, setCompacting] = useState(false);
  const pending = useRef<{ text: string; modelId: string; requestId: string; attachments: string[]; sessionId: string | null } | null>(null);
  const sending = useRef(false), creationRequest = useRef<string | null>(null);
  type StreamView = { live: LiveTranscript; checkpoint?: FrameStreamCheckpoint; cursors: Map<string, number>; scroll?: number };
  const views = useRef(new Map<string, StreamView>());
  const viewFor = useCallback((id: string) => { let view = views.current.get(id); if (!view) { view = { live: {}, cursors: new Map() }; views.current.set(id, view); } return view; }, []);
  const requests = useRef(new Map<string, Promise<void>>()), versions = useRef(new Map<string, number>()), selectionRevision = useRef(0);
  const restoredScroll = useRef<string | null>(null);
  selectedRef.current = selected;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controllers.current.forEach(controller => controller.abort()); olderRequest.current?.abort(); }; }, []);
  const refresh = useCallback(async (id: string, force = false) => {
    const existing = requests.current.get(id); if (existing) { try { await existing; } catch (error) { if (!force) throw error; } if (!force) return; }
    const version = versions.current.get(id);
    const controller = new AbortController(); controllers.current.set(id, controller);
    const request = api<State>(`/sessions/${id}?limit=20${force ? '&fresh=1' : ''}`, 'GET', undefined, controller.signal).then(page => {
      if (controller.signal.aborted || !mounted.current || !cache.valid() || versions.current.get(id) !== version) return;
      const prior = stateRef.current?.conversation.id === id ? stateRef.current : cache.peek<State>(`state:${id}`);
      const next = mergeConversationPage(prior, page);
      cache.put(`state:${id}`, next, 'state');
      if (selectedRef.current === id) { setState(next); setLoading(false); setConnectionError(''); }
    }).catch(failure => {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && failure.status === 404) { cache.removeSession(id); if (selectedRef.current === id) { setSelected(null); setState(null); } }
      throw failure;
    });
    requests.current.set(id, request);
    try { await request; } finally { if (requests.current.get(id) === request) requests.current.delete(id); if (controllers.current.get(id) === controller) controllers.current.delete(id); }
  }, [cache]);
  useEffect(() => {
    const revision = selectionRevision.current;
    void cache.get<string>('selection').then(last => {
      if (!mounted.current || !cache.valid()) return;
      if (last && selectionRevision.current === revision) setSelected(last);
    });
  }, [cache]);
  useEffect(() => {
    setCompacting(false); setError(''); setConnectionError(''); setReconnecting(false); atBottom.current = true; setScrollBottomRequested(false);
    if (!selected) { setState(null); setLive({}); setLoading(false); return; }
    cache.put('selection', selected, 'selection');
    const view = viewFor(selected), stored = cache.peek<State>(`state:${selected}`), cached = stored?.history ? stored : undefined;
    setState(cached ?? null); setLive(view.live); setLoading(!cached);
    if (view.scroll !== undefined) atBottom.current = false;
    // Bound retained partial streams while keeping the most recently opened conversations warm.
    views.current.delete(selected); views.current.set(selected, view);
    while (views.current.size > 8) views.current.delete(views.current.keys().next().value!);
    let alive = true;
    void cache.get<State>(`state:${selected}`).then(value => { if (alive && value?.history && cache.valid()) { setState(value); setLoading(false); } });
    void refresh(selected).catch(failure => { if (alive && cache.valid()) { if (isSessionServiceFailure(failure)) setConnectionError(errorText(failure)); else setError(errorText(failure)); setLoading(false); } });
    return () => { alive = false; controllers.current.get(selected)?.abort(); controllers.current.delete(selected); requests.current.delete(selected); olderRequest.current?.abort(); olderRequest.current = null; setOlderLoading(false); };
  }, [cache, selected, refresh, viewFor]);
  const working = state?.conversation.id === selected ? state.jobs.filter(job => isWorking(job.status)) : [];
  const workingIds = working.map(job => job.turnId).join('|');
  useEffect(() => {
    if (!selected || !workingIds) return;
    let alive = true;
    const statusAbort = new AbortController();
    let lastEventAt = Date.now();
    const view = viewFor(selected);
    const writeLive = (content: string, route: { turnId?: string; messageId?: string; segmentId?: string }, replace = false) => { const key = route.messageId || route.segmentId || 'reply'; view.live = writeLiveSegment(view.live, route.turnId!, key, content, replace); if (alive && selectedRef.current === selected) setLive(view.live); };
    const buffer = createFrameStreamBuffers((delta, route) => writeLive(delta, route), { checkpoint: view.checkpoint, replace: (content, route) => writeLive(content, route, true) });
    const stops = workingIds.split('|').map(turnId => watch(selected, turnId, (frame: Frame) => {
      if (!alive || selectedRef.current !== selected) return;
      if (frame.event) lastEventAt = Date.now();
      if (frame.type === 'reconnecting') { setReconnecting(true); return; }
      if (frame.type === 'error') { setReconnecting(true); setConnectionError(sessionServiceError(frame.error, language)); }
      else if (frame.type === 'ready' || frame.event) setConnectionError('');
      if (frame.type !== 'error') setReconnecting(false);
      const event = frame.event;
      if (event) view.cursors.set(turnId, event.sequence);
      if (event && ['tool_queued','tool_running','tool_returned','tool_failed','tool_cancelled'].includes(event.kind)) {
        buffer.flushToolBoundary(); view.live = applyTranscriptEvent(view.live, event); setLive(view.live);
      }
      if (event?.kind.startsWith('context_compaction_')) setCompacting(['context_compaction_started','context_compaction_retrying'].includes(event.kind));
      if (event?.kind.startsWith('solution_selection_')) void refresh(selected).catch(() => {});
      if (event && event.kind.startsWith('assistant_segment_') && event.payload.segmentId) {
        view.live = applyTranscriptEvent(view.live, event);
        const route = { turnId, messageId: event.payload.messageId ?? event.payload.segmentId, segmentId: event.payload.segmentId, segmentOrdinal: event.payload.ordinal, eventId: String(event.sequence) };
        if (event.kind === 'assistant_segment_completed') void buffer.completeSegment(event.payload.content ?? '', route);
        else if (event.kind === 'assistant_segment_delta') buffer.push(event.payload.delta ?? '', route);
        else setLive(view.live);
      }
      if (frame.type === 'end' || frame.type === 'error') { void buffer.releaseTerminal(); void refresh(selected, true).catch(() => {}); void refreshList(true).catch(() => {}); }
    }, view.cursors.get(turnId)));
    // SSE is authoritative; a light, non-overlapping status check recovers lost terminal events.
    let poll: ReturnType<typeof setTimeout>;
    const check = async () => {
      try {
        if (!document.hidden && Date.now() - lastEventAt >= 10_000) {
          const params = new URLSearchParams(workingIds.split('|').map(id => ['turnId', id]));
          const status = await api<{ jobs: Job[] }>(`/sessions/${selected}/status?${params}`, 'GET', undefined, statusAbort.signal);
          const prior = stateRef.current;
          if (alive && selectedRef.current === selected && prior?.conversation.id === selected &&
            workingIds.split('|').some(id => status.jobs.find(job => job.turnId === id)?.status !== prior.jobs.find(job => job.turnId === id)?.status)) await refresh(selected, true);
        }
      } catch (failure) {
        if (alive && !statusAbort.signal.aborted && isSessionServiceFailure(failure)) {
          setReconnecting(true); setConnectionError(errorText(failure));
        }
      }
      finally { if (alive) poll = setTimeout(check, 12_000 + Math.random() * 3_000); }
    };
    poll = setTimeout(check, 12_000 + Math.random() * 3_000);
    return () => { alive = false; statusAbort.abort(); view.checkpoint = buffer.checkpoint(); buffer.dispose(); stops.forEach(stop => stop()); clearTimeout(poll); };
  }, [selected, workingIds, refresh, refreshList, viewFor]);
  useEffect(() => {
    if (state?.conversation.id !== selected || !selected) return;
    const view = viewFor(selected);
    if (restoredScroll.current !== selected && view.scroll !== undefined) transcript.current?.scrollTo({ top: view.scroll, behavior: 'auto' });
    else if (atBottom.current) transcript.current?.scrollTo({ top: transcript.current.scrollHeight, behavior: 'auto' });
    restoredScroll.current = selected;
  }, [state, live, selected, viewFor]);
  useEffect(() => {
    const scroller = transcript.current, column = scroller?.querySelector<HTMLElement>('.message-column');
    if (!scroller || !column) return;
    const reflow = observeConversationReflow(scroller, () => ({
      paused: () => false, following: () => atBottom.current,
      beforeRestore: () => {}, followTop: () => scroller.scrollHeight, restored: () => {},
    }));
    const observer = new ResizeObserver(() => {
      if (atBottom.current && !scroller.dataset.cardbushPreserveScroll) scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' });
      setScrollBottomRequested(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight >= 120);
    });
    observer.observe(column);
    return () => { observer.disconnect(); reflow.dispose(); };
  }, [selected, admin]);
  const jumpToBottom = () => {
    const element = transcript.current;
    if (!element) return;
    atBottom.current = true; setScrollBottomRequested(false);
    if (selected) viewFor(selected).scroll = undefined;
    element.focus({ preventScroll: true });
    element.scrollTo({ top: element.scrollHeight, behavior: 'instant' });
  };
  const choose = (id: string | null) => {
    selectionRevision.current++;
    if (selectedRef.current && transcript.current) viewFor(selectedRef.current).scroll = atBottom.current ? undefined : transcript.current.scrollTop;
    const cached = id ? cache.peek<State>(`state:${id}`) : undefined;
    selectedRef.current = id; setSelected(id); setState(cached?.history ? cached : null); setLive(id ? viewFor(id).live : {});
    upload.clear(); setAdmin(false); setMenu(null); setDraft(''); pending.current = null;
    if (id) cache.put('selection', id, 'selection'); else cache.forget('selection');
  };
  async function loadOlder() {
    const id = selectedRef.current, before = stateRef.current?.history?.nextCursor;
    if (!id || !before || olderRequest.current) return;
    const controller = new AbortController(); olderRequest.current = controller; setOlderLoading(true);
    try {
      const page = await api<State>(`/sessions/${id}?limit=20&before=${encodeURIComponent(before)}`, 'GET', undefined, controller.signal);
      if (controller.signal.aborted || !cache.valid() || selectedRef.current !== id) return;
      const element = transcript.current, height = element?.scrollHeight ?? 0, top = element?.scrollTop ?? 0;
      atBottom.current = false;
      const next = mergeConversationPage(stateRef.current ?? undefined, page, true);
      cache.put(`state:${id}`, next, 'state'); setState(next);
      requestAnimationFrame(() => { if (element && selectedRef.current === id) element.scrollTop = top + element.scrollHeight - height; });
    } catch (failure) { if (!controller.signal.aborted) setError(errorText(failure)); }
    finally { if (olderRequest.current === controller) { olderRequest.current = null; setOlderLoading(false); } }
  }
  const newChat = () => { choose(null); pending.current = null; creationRequest.current = null; setError(''); editor.current?.focus(); };
  useEffect(() => { const key = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'o') { event.preventDefault(); newChat(); } }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [newChat]);
  async function send(event?: React.FormEvent) {
    event?.preventDefault(); const text = draft.trim() || (upload.items.length ? uiText(language)("web.pleaseReviewTheseAttachments") : ''); if (!text || busy || upload.busy || sending.current) return;
    sending.current = true;
    const attachments = [...upload.items], startedSelection = selectionRevision.current;
    let submission = pending.current?.sessionId === selected && pending.current.text === text && pending.current.modelId === model && JSON.stringify(pending.current.attachments) === JSON.stringify(attachments.map(item => item.id)) ? pending.current : { text, modelId: model, requestId: requestId(), attachments: attachments.map(item => item.id), sessionId: selected };
    setBusy(true); setError(''); let id = selected;
    try {
      if (!id) {
        creationRequest.current ??= requestId();
        const conversation = await api<Conversation>('/sessions', 'POST', { requestId: creationRequest.current });
        creationRequest.current = null;
        if (!mounted.current || !cache.valid()) return;
        cache.allowSession(conversation.id);
        cache.put(`state:${conversation.id}`, { conversation, jobs: [], snapshot: null, history: { nextCursor: null } }, 'state');
        setConversations(previous => [conversation, ...previous]);
        id = conversation.id;
        if (selectionRevision.current === startedSelection) { selectionRevision.current++; selectedRef.current = id; setSelected(id); }
      }
      submission.sessionId = id;
      submission = recoverSessionSubmission(await cache.get(`outbox:${id}`), submission);
      if (!mounted.current || !cache.valid()) return;
      pending.current = submission;
      cache.put(`outbox:${id}`, submission, 'state'); await cache.settled();
      setSubmitting({ sessionId: id, id: submission.requestId, text, attachments }); atBottom.current = true;
      const job = await api<Job>(`/sessions/${id}/messages`, 'POST', { text: submission.text, modelId: submission.modelId, requestId: submission.requestId, attachments: submission.attachments });
      if (!mounted.current || !cache.valid()) return;
      versions.current.set(id, (versions.current.get(id) ?? 0) + 1);
      const prior = cache.peek<State>(`state:${id}`);
      if (prior) { const next = { ...prior, jobs: [...prior.jobs.filter(item => item.id !== job.id), { ...job, attachments: job.attachments ?? attachments }] }; cache.put(`state:${id}`, next, 'state'); if (selectedRef.current === id) setState(next); }
      cache.forget(`outbox:${id}`); setSubmitting(null);
      void refresh(id, true).catch(failure => { if (mounted.current && selectedRef.current === id) setError(errorText(failure)); });
      void refreshList(true).catch(() => {});
      if (!mounted.current || selectedRef.current !== id) return;
      pending.current = null; upload.clear(); setDraft(''); atBottom.current = true;
    } catch (failure) { if (mounted.current) { setSubmitting(null); setError(sessionServiceError(failure, language)); if (failure instanceof ApiError && failure.message === uiText(language)("web.thisModelIsNotEnabled")) window.dispatchEvent(new Event('cardbush:models-changed')); } } finally { sending.current = false; if (mounted.current) { setBusy(false); editor.current?.focus(); } }
  }
  async function patch(id: string, value: Record<string, unknown>) {
    try { await api(`/sessions/${id}`, 'PATCH', value); setMenu(null); setEdit(null); await refreshList(true); } catch (failure) { setError(errorText(failure)); }
  }
  async function remove(id: string) {
    try { await api(`/sessions/${id}`, 'DELETE', {}); versions.current.set(id, (versions.current.get(id) ?? 0) + 1); cache.removeSession(id); views.current.delete(id); setDeleting(null); if (id === selected) newChat(); await refreshList(true); } catch (failure) { setError(errorText(failure)); }
  }
  async function stop() {
    if (!selected) return;
    try { for (const job of working) await api(`/sessions/${selected}/jobs/${job.id}/stop`, 'POST', {}); await refresh(selected, true); } catch (failure) { setError(errorText(failure)); }
  }
  const visible = conversations.filter(item => item.archived === archive && item.title.toLowerCase().includes(query.toLowerCase()));
  const title = conversations.find(item => item.id === selected)?.title ?? state?.conversation.title ?? uiText(language)("agentsView.newConversation");
  return <div className={`workspace ${sidebar ? '' : 'sidebar-closed'}`}>
    {sidebar && <aside className="sidebar"><div className="sidebar-brand"><Brand small/><button className="icon-button" aria-label={uiText(language)("compactSidebarBackdrop.closeSidebar")} onClick={() => setSidebar(false)}><PanelLeftClose size={18}/></button></div>
      <button className="new-chat" onClick={newChat}><Plus size={18}/>{uiText(language)("agentsView.newConversation")}<span>{'⌘ ⇧ O'}</span></button>
      <div className="search"><Search size={15}/><input aria-label={uiText(language)("web.searchConversations")} placeholder={uiText(language)("web.searchConversations")} value={query} onChange={event => setQuery(event.target.value)}/></div>
      <div className="list-label"><span>{archive ? uiText(language)("yourFriends.archived") : uiText(language)("web.myConversations")}</span><button onClick={() => setArchive(!archive)}>{archive ? uiText(language)("web.backToList") : uiText(language)("yourFriends.archive")}</button></div>
      <nav className="conversation-list" aria-label={uiText(language)("web.conversationList")}>{visible.length === 0 && !list.loading && <p className="empty-list">{query ? uiText(language)("web.noMatchingConversations") : archive ? uiText(language)("web.noArchivedConversationsYet") : uiText(language)("web.startANewIdeaHere")}</p>}{visible.map(item => <div key={item.id} className={`conversation ${selected === item.id && !admin ? 'selected' : ''}`}>
        <button className="conversation-title" onClick={() => { choose(item.id); if (innerWidth < 760) setSidebar(false); }}><MessageSquare size={15}/><span>{item.pinned ? '· ' : ''}{item.title}</span></button><button aria-label={uiText(language)("web.moreActionsFor", { title: item.title })} className="icon-button more-button" onClick={() => setMenu(menu === item.id ? null : item.id)}><MoreHorizontal size={16}/></button>
        {menu === item.id && <div className="dropdown"><button onClick={() => { setEdit({ id: item.id, title: item.title }); setMenu(null); }}>{uiText(language)("useAssistantActions.rename")}</button><button onClick={() => void patch(item.id, { pinned: !item.pinned })}>{item.pinned ? uiText(language)("chatSidebar.unpin") : uiText(language)("chatSidebar.pinned")}</button><button onClick={() => void patch(item.id, { archived: !item.archived })}>{item.archived ? uiText(language)("web.unarchive") : uiText(language)("yourFriends.archive")}</button><button className="danger" onClick={() => { setDeleting(item.id); setMenu(null); }}>{uiText(language)("chatSidebar.deleteChat")}</button></div>}
      </div>)}{(list.nextCursor || list.loading) && <button className="load-more-conversations" disabled={list.loading} onClick={() => void list.more()}>{list.loading ? uiText(language)("common.loading") : uiText(language)("web.loadMoreConversations")}</button>}</nav>
      <div className="account">{identity.user.role === 'admin' && <button className={`admin-link ${admin ? 'active' : ''}`} onClick={() => { setAdmin(true); }}><ShieldCheck size={17}/>{uiText(language)("web.administration")}</button>}<div className="account-row"><span className="avatar">{identity.user.display_name.slice(0, 1)}</span><div><strong>{identity.user.display_name}</strong><span>{identity.user.department_name || uiText(language)("web.personalConversationSpace")}</span></div><button className="icon-button" aria-label={uiText(language)("pluginMcpSettings.signOut")} title={uiText(language)("pluginMcpSettings.signOut")} onClick={() => void logout()}><LogOut size={17}/></button></div></div>
    </aside>}
    <main className="main"><header className="topbar"><div>{!sidebar && <button className="icon-button" aria-label={uiText(language)("web.expandSidebar")} onClick={() => setSidebar(true)}><Menu size={20}/></button>}<span>{admin ? uiText(language)("web.administration") : selected ? title : uiText(language)("settingsKeyboardPanel.conversation")}</span></div><span className="mode-badge"><span/>{uiText(language)("web.conversationMode")}</span></header>
      {admin ? <Admin currentUserId={identity.user.id}/> : <><div className="conversation-transcript"><div className="transcript message-list" ref={transcript} tabIndex={-1} onScroll={updateScrollPosition}>
        {!selected && <div className="welcome"><div className="welcome-mark"><Sparkles size={26}/></div><span className="eyebrow">{uiText(language)("web.hello", { name: identity.user.display_name })}</span><h1>{uiText(language)("web.whatWouldYouLikeToTalkAboutToday")}</h1><p>{uiText(language)("web.aQuestionSomeInspirationOrAnIdeaYouReStillExploring")}</p><div className="suggestions">{[{ icon: <PenLine size={19}/>, title: uiText(language)("web.refineSomeWriting"), text: uiText(language)("web.iHaveSomeWritingIDLikeYouToHelpOrganizeAnd") }, { icon: <Sparkles size={19}/>, title: uiText(language)("web.findInspiration"), text: uiText(language)("web.letSBrainstormUnderstandMyGoalFirstThenHelpMeExplorePossibilities") }, { icon: <MessageSquare size={19}/>, title: uiText(language)("web.thinkThroughAProblem"), text: uiText(language)("web.iDLikeToDiscussAProblemHelpMeOrganizeMyThoughts") }].map(item => <button key={item.title} onClick={() => { setDraft(item.text); editor.current?.focus(); }}>{item.icon}<span>{item.title}</span><span>↗</span></button>)}</div></div>}
        {loading && <div className="status-line"><span className="loading-dot"/>{uiText(language)("web.openingConversation")}</div>}
        <div className="message-column">{state?.history?.nextCursor && <button className="load-older-messages" disabled={olderLoading} onClick={() => void loadOlder()}>{olderLoading ? uiText(language)("common.loading") : uiText(language)("web.loadEarlierMessages")}</button>}<NativeTranscript state={state} live={live} selected={selected} submitting={submitting} connectionUnavailable={reconnecting || Boolean(connectionError)} modelName={identity.models.find(item => item.id === model)?.name ?? model} onError={setError} onRetry={text => { setDraft(text); editor.current?.focus(); }}>
          {compacting && <div className="status-line"><span className="loading-dot"/>{uiText(language)("web.compactingContextTheConversationWillContinue")}</div>}
          <Solutions items={solutions.items ?? state?.solutions ?? []} refresh={solutions.refresh}/>
          {solutions.unavailable && <p className="form-error" role="alert">{uiText(language)('web.remoteQuestionsUnavailable')}</p>}
        </NativeTranscript></div>
      </div><ScrollBottomButton language={language} visible={scrollBottomVisible} onClick={jumpToBottom}/></div><div className="composer-area">{error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label={uiText(language)("chatStatusViews.dismissNotification")} onClick={() => setError('')}><X size={15}/></button></div>}{(loading || reconnecting || connectionError) && <SessionConnectionStatus
          phase={connectionError ? 'failed' : loading ? 'starting' : 'reconnecting'}
          message={connectionError || uiText(language)(loading ? 'web.sessionPreparing' : 'web.sessionReconnecting')}/> }
        <form className="composer" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void upload.add(Array.from(event.dataTransfer.files)); }} onSubmit={event => void send(event)}><AttachmentDrafts upload={upload}/><textarea ref={editor} onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); void upload.add(Array.from(event.clipboardData.files)); } }} aria-label={uiText(language)("web.message")} placeholder={uiText(language)("web.shareYourThoughts")} rows={3} value={draft} maxLength={100000} disabled={busy} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}/><div className="composer-bottom"><div><UploadButton upload={upload}/><select aria-label={uiText(language)("modelFormDialog.chooseModel")} value={model} onChange={event => setModel(event.target.value)}>{identity.models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div><div>{working.length > 0 && <button className="stop-button" type="button" onClick={() => void stop()}><Square size={12} fill="currentColor"/>{uiText(language)("automationPanel.stop")}</button>}<button className="send-button" aria-label={uiText(language)("keyboardShortcuts.sendMessage")} disabled={(!draft.trim() && !upload.items.length) || busy || upload.busy}>{busy ? <span className="loading-dot"/> : <ArrowUp size={20}/>}</button></div></div></form><div className="composer-note"><span>{uiText(language)("web.enterToSendShiftEnterForANewLine")}</span><span>{uiText(language)("web.poweredBy")}</span></div>
      </div></>}
    </main>
    {edit && <Modal title={uiText(language)("chatSidebar.renameChat")} close={() => setEdit(null)}><form onSubmit={event => { event.preventDefault(); void patch(edit.id, { title: edit.title }); }}><input aria-label={uiText(language)("web.conversationName")} autoFocus required maxLength={200} value={edit.title} onChange={event => setEdit({ ...edit, title: event.target.value })}/><button className="primary">{uiText(language)("appCenter.save")}</button></form></Modal>}
    {deleting && <Modal title={uiText(language)("web.deleteThisConversation")} close={() => setDeleting(null)}><p>{uiText(language)("web.deletedConversationsCannotBeRestoredFromTheList")}</p><div className="modal-actions"><button onClick={() => setDeleting(null)}>{uiText(language)("agentConnectionForm.cancel")}</button><button className="primary destructive" onClick={() => void remove(deleting)}>{uiText(language)("chatSidebar.deleteChat")}</button></div></Modal>}
  </div>;
}

function Modal({ title, close, children }: { title: string; close: () => void; children: React.ReactNode }) {
  const language = useUiLanguage();
 return <div className="modal-backdrop" onClick={close}><section className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={event => event.stopPropagation()}><header><h2>{title}</h2><button className="icon-button" aria-label={uiText(language)("yourFriends.close")} onClick={close}><X size={18}/></button></header>{children}</section></div>; }

createRoot(document.getElementById('root')!).render(<WebLanguage><App/></WebLanguage>);
