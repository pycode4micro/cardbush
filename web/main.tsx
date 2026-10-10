import { createFrameStreamBuffers, type FrameStreamCheckpoint } from '../src/features/chatMessages/transcript/frameStreamBuffer';
import { AttachmentDrafts, Solutions, UploadButton, useAttachments, type Attachment } from './AgentWidgets';
import { NativeTranscript } from './NativeTranscript';
import { applyTranscriptEvent, writeLiveSegment, type LiveTranscript } from './transcript';
import { observeConversationReflow } from '../src/features/chat/conversationReflow';
import { activateBrowserCache, type AccountCache } from './browserCache';
import { BrowserCacheContext, useAccountCache } from './BrowserCacheProvider';
import { OrganizationAdmin as Admin } from './OrganizationAdmin';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ArrowUp, LogOut, Menu, MessageSquare, MoreHorizontal, PanelLeftClose, PenLine, Plus, Search, ShieldCheck, Sparkles, Square, X } from 'lucide-react';
import { api, ApiError, requestId, setIdentity, watch, type Conversation, type Frame, type Identity, type State, type Department, type Job } from './api';
import './styles.css';
import './nativeTranscript.css';

const errorText = (error: unknown) => error instanceof Error ? error.message : '暂时无法完成操作。';
const isWorking = (status: string) => status === 'queued' || status === 'running';
const accountChannel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('cardbush-web-identity');
function Brand({ small = false }: { small?: boolean }) { return <div className={`brand ${small ? 'small' : ''}`}><span className="brand-symbol">兆</span><span>招财<span className="brand-subtitle">兆君服饰</span></span></div>; }

function App() {
  const [identity, updateIdentity] = useState<Identity | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const revision = useRef(0);
  const cache = useRef<AccountCache | null>(null);
  const apply = useCallback((next: Identity | null) => { revision.current++; cache.current = activateBrowserCache(next?.user.id ?? null); setIdentity(next); updateIdentity(next); setLoading(false); }, []);
  useEffect(() => {
    let alive = true;
    const refresh = () => { const started = revision.current; void api<Identity>('/auth/me').then(next => { if (alive && revision.current === started) { apply(next); setError(''); } }).catch(failure => { if (alive && revision.current === started) { if (failure instanceof ApiError && failure.status === 401) apply(null); else { setLoading(false); setError('连接暂时中断，请稍后重试。'); } } }); };
    const logout = () => apply(null);
    const accountChanged = () => { revision.current++; cache.current?.close(); cache.current = null; setIdentity(null); updateIdentity(null); setLoading(true); refresh(); };
    refresh(); window.addEventListener('cardbush:logged-out', logout); window.addEventListener('focus', refresh);
    if (accountChannel) accountChannel.onmessage = accountChanged;
    const storage = (event: StorageEvent) => { if (event.key === 'cardbush-cache-identity-v1' && cache.current && !cache.current.valid()) accountChanged(); };
    window.addEventListener('storage', storage);
    return () => { alive = false; window.removeEventListener('storage', storage); window.removeEventListener('cardbush:logged-out', logout); window.removeEventListener('focus', refresh); if (accountChannel) accountChannel.onmessage = null; };
  }, [apply]);
  const logout = async () => { try { await api('/auth/logout', 'POST', {}); apply(null); accountChannel?.postMessage('changed'); } catch (failure) { setError(errorText(failure)); } };
  if (loading) return <div className="splash"><Brand/><span className="loading-dot"/>正在打开对话空间</div>;
  return identity ? <BrowserCacheContext.Provider value={cache.current}><Workspace key={identity.user.id} identity={identity} logout={logout} externalError={error}/></BrowserCacheContext.Provider>
    : <Auth onLogin={next => { apply(next); accountChannel?.postMessage('changed'); }}/>;
}

function Auth({ onLogin }: { onLogin: (identity: Identity) => void }) {
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
  return <main className="auth-page"><section className="auth-story"><Brand/><div className="auth-intro"><span className="eyebrow">让思考，自然发生</span><h1>每个想法，<br/>都值得聊一聊。</h1><p>从一句话开始，整理思路、打磨表达，<br/>在持续的对话中找到更好的答案。</p></div><div className="auth-orbit" aria-hidden="true"><span>想法</span><span>灵感</span><span>答案</span></div><footer>兆君 · Powered by CardBush</footer></section>
    <section className="auth-form-area"><form onSubmit={submit}><span className="eyebrow">你的专属对话空间</span><h2>{register ? '创建账号' : '欢迎回来'}</h2><p className="muted">{register ? '注册后，请等待管理员启用账号。' : '登录后，继续属于你的对话。'}</p>
      <label>用户名<input name="username" autoComplete="username" required minLength={register ? 3 : 1} maxLength={80} pattern={register ? '[A-Za-z0-9_.-]+' : undefined} placeholder="输入用户名"/></label>
      {register && <label>姓名<input name="display_name" autoComplete="name" required maxLength={120} placeholder="如何称呼你"/></label>}
      <label>密码<input name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} minLength={register ? 8 : 1} maxLength={128} required placeholder={register ? '至少 8 位字符' : '输入密码'}/></label>
      {register && departments.length > 0 && <><label>公司<select aria-label="注册公司" value={company} onChange={event=>{setCompany(event.target.value);setDepartment('');}}><option value="">暂不选择</option>{[...new Map(departments.map(item=>[item.company_id,item.company_name])).entries()].map(([id,name])=><option key={id} value={id}>{name}</option>)}</select></label><label>部门<select name="department_id" aria-label="注册部门" disabled={!company} required={Boolean(company)} value={department} onChange={event=>setDepartment(event.target.value)}><option value="">{company?'请选择部门':'先选择公司'}</option>{departments.filter(item=>item.company_id===company).map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label></>}
      {error && <p className="form-error" role="alert">{error}</p>}{notice && <p className="form-notice" role="status">{notice}</p>}
      <button className="primary auth-submit" disabled={busy}>{busy ? '请稍候…' : register ? '注册账号' : '登录'}<span>→</span></button>
      <p className="auth-switch">{register ? '已有账号？' : '还没有账号？'}<button type="button" onClick={() => { setRegister(!register); setError(''); setNotice(''); }}>{register ? '立即登录' : '创建账号'}</button></p>
    </form></section></main>;
}

function Workspace({ identity, logout, externalError }: { identity: Identity; logout: () => Promise<void>; externalError: string }) {
  const cache = useAccountCache();
  const [conversations, setConversations] = useState<Conversation[]>([]), [selected, setSelected] = useState<string | null>(null), [state, setState] = useState<State | null>(null);
  const [draft, setDraft] = useState(''), [model, setModel] = useState(identity.defaultModelId), [query, setQuery] = useState(''), [error, setError] = useState(externalError);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(false), [sidebar, setSidebar] = useState(true), [admin, setAdmin] = useState(false), [archive, setArchive] = useState(false);
  const [menu, setMenu] = useState<string | null>(null), [edit, setEdit] = useState<{ id: string; title: string } | null>(null), [deleting, setDeleting] = useState<string | null>(null);
  const [live, setLive] = useState<LiveTranscript>({}), [reconnecting, setReconnecting] = useState(false);
  const [submitting, setSubmitting] = useState<{ sessionId: string; id: string; text: string; attachments: Attachment[] } | null>(null);
  const selectedRef = useRef(selected), mounted = useRef(true), editor = useRef<HTMLTextAreaElement>(null), transcript = useRef<HTMLDivElement>(null), atBottom = useRef(true);
  const upload = useAttachments();
  const [compacting, setCompacting] = useState(false);
  const pending = useRef<{ text: string; modelId: string; requestId: string; attachments: string[] } | null>(null);
  type StreamView = { live: LiveTranscript; checkpoint?: FrameStreamCheckpoint; cursors: Map<string, number>; scroll?: number };
  const views = useRef(new Map<string, StreamView>());
  const viewFor = useCallback((id: string) => { let view = views.current.get(id); if (!view) { view = { live: {}, cursors: new Map() }; views.current.set(id, view); } return view; }, []);
  const requests = useRef(new Map<string, Promise<void>>()), versions = useRef(new Map<string, number>()), selectionRevision = useRef(0), listReady = useRef(false);
  const listRequest = useRef<Promise<void> | null>(null), listVersion = useRef(0), restoredScroll = useRef<string | null>(null);
  selectedRef.current = selected;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const refreshList = useCallback(async (force = false) => {
    if (listRequest.current) { try { await listRequest.current; } catch (error) { if (!force) throw error; } if (!force) return; }
    const version = listVersion.current;
    const request = api<Conversation[]>('/sessions').then(items => {
      if (!mounted.current || !cache.valid() || version !== listVersion.current) return;
      listReady.current = true; cache.put('list', items, 'list'); cache.reconcileSessions(items.map(item => item.id)); setConversations(items);
      if (selectedRef.current && !items.some(item => item.id === selectedRef.current)) { setSelected(null); setState(null); cache.forget('selection'); }
    });
    listRequest.current = request;
    try { await request; } finally { if (listRequest.current === request) listRequest.current = null; }
  }, [cache]);
  const refresh = useCallback(async (id: string, force = false) => {
    const existing = requests.current.get(id); if (existing) { try { await existing; } catch (error) { if (!force) throw error; } if (!force) return; }
    const version = versions.current.get(id);
    const request = api<State>(`/sessions/${id}`).then(next => {
      if (!mounted.current || !cache.valid() || versions.current.get(id) !== version) return;
      cache.put(`state:${id}`, next, 'state');
      if (selectedRef.current === id) { setState(next); setLoading(false); }
    }).catch(failure => {
      if (failure instanceof ApiError && failure.status === 404) { cache.removeSession(id); if (selectedRef.current === id) { setSelected(null); setState(null); } }
      throw failure;
    });
    requests.current.set(id, request);
    try { await request; } finally { if (requests.current.get(id) === request) requests.current.delete(id); }
  }, [cache]);
  useEffect(() => {
    const revision = selectionRevision.current;
    void Promise.all([cache.get<Conversation[]>('list'), cache.get<string>('selection')]).then(([items, last]) => {
      if (!mounted.current || !cache.valid()) return;
      if (items && !listReady.current) setConversations(items);
      const allowed = cache.peek<Conversation[]>('list') ?? items;
      if (last && allowed?.some(item => item.id === last) && selectionRevision.current === revision) setSelected(last);
    });
    void refreshList().catch(failure => setError(errorText(failure)));
  }, [cache, refreshList]);
  useEffect(() => {
    setCompacting(false); setError(''); setReconnecting(false); atBottom.current = true;
    if (!selected) { setState(null); setLive({}); setLoading(false); return; }
    cache.put('selection', selected, 'selection');
    const view = viewFor(selected), cached = cache.peek<State>(`state:${selected}`);
    setState(cached ?? null); setLive(view.live); setLoading(!cached);
    if (view.scroll !== undefined) atBottom.current = false;
    // Bound retained partial streams while keeping the most recently opened conversations warm.
    views.current.delete(selected); views.current.set(selected, view);
    while (views.current.size > 8) views.current.delete(views.current.keys().next().value!);
    let alive = true;
    void cache.get<State>(`state:${selected}`).then(value => { if (alive && value && cache.valid()) { setState(value); setLoading(false); } });
    void refresh(selected).catch(failure => { if (alive && cache.valid()) { setError(errorText(failure)); setLoading(false); } });
    return () => { alive = false; };
  }, [cache, selected, refresh, viewFor]);
  const working = state?.conversation.id === selected ? state.jobs.filter(job => isWorking(job.status)) : [];
  const workingIds = working.map(job => job.turnId).join('|');
  useEffect(() => {
    if (!selected || !workingIds) return;
    let alive = true;
    const view = viewFor(selected);
    const writeLive = (content: string, route: { turnId?: string; messageId?: string; segmentId?: string }, replace = false) => { const key = route.messageId || route.segmentId || 'reply'; view.live = writeLiveSegment(view.live, route.turnId!, key, content, replace); if (alive && selectedRef.current === selected) setLive(view.live); };
    const buffer = createFrameStreamBuffers((delta, route) => writeLive(delta, route), { checkpoint: view.checkpoint, replace: (content, route) => writeLive(content, route, true) });
    const stops = workingIds.split('|').map(turnId => watch(selected, turnId, (frame: Frame) => {
      if (!alive || selectedRef.current !== selected) return;
      if (frame.type === 'reconnecting') { setReconnecting(true); return; }
      setReconnecting(false);
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
    const poll = setInterval(() => { void refresh(selected).catch(() => {}); }, 4000);
    return () => { alive = false; view.checkpoint = buffer.checkpoint(); buffer.dispose(); stops.forEach(stop => stop()); clearInterval(poll); };
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
    });
    observer.observe(column);
    return () => { observer.disconnect(); reflow.dispose(); };
  }, [selected, admin]);
  const choose = (id: string | null) => {
    selectionRevision.current++;
    if (selectedRef.current && transcript.current) viewFor(selectedRef.current).scroll = atBottom.current ? undefined : transcript.current.scrollTop;
    selectedRef.current = id; setSelected(id); setState(id ? cache.peek<State>(`state:${id}`) ?? null : null); setLive(id ? viewFor(id).live : {});
    upload.clear(); setAdmin(false); setMenu(null); setDraft(''); pending.current = null;
    if (id) cache.put('selection', id, 'selection'); else cache.forget('selection');
  };
  const newChat = () => { choose(null); setError(''); editor.current?.focus(); };
  useEffect(() => { const key = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'o') { event.preventDefault(); newChat(); } }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [newChat]);
  async function send(event?: React.FormEvent) {
    event?.preventDefault(); const text = draft.trim() || (upload.items.length ? '请查看这些附件。' : ''); if (!text || busy || upload.busy) return;
    const attachments = [...upload.items], startedSelection = selectionRevision.current;
    const submission = pending.current?.text === text && pending.current.modelId === model && JSON.stringify(pending.current.attachments) === JSON.stringify(attachments.map(item => item.id)) ? pending.current : { text, modelId: model, requestId: requestId(), attachments: attachments.map(item => item.id) };
    setBusy(true); setError(''); let id = selected;
    try {
      if (!id) {
        const conversation = await api<Conversation>('/sessions', 'POST', { requestId: requestId() });
        if (!mounted.current || !cache.valid()) return;
        listVersion.current++; cache.allowSession(conversation.id);
        cache.put(`state:${conversation.id}`, { conversation, jobs: [], snapshot: null }, 'state');
        setConversations(previous => [conversation, ...previous]);
        id = conversation.id;
        if (selectionRevision.current === startedSelection) { selectionRevision.current++; selectedRef.current = id; setSelected(id); }
      }
      pending.current = submission;
      setSubmitting({ sessionId: id, id: submission.requestId, text, attachments }); atBottom.current = true;
      const job = await api<Job>(`/sessions/${id}/messages`, 'POST', submission);
      if (!mounted.current || !cache.valid()) return;
      versions.current.set(id, (versions.current.get(id) ?? 0) + 1); listVersion.current++;
      const prior = cache.peek<State>(`state:${id}`);
      if (prior) { const next = { ...prior, jobs: [...prior.jobs.filter(item => item.id !== job.id), { ...job, attachments: job.attachments ?? attachments }] }; cache.put(`state:${id}`, next, 'state'); if (selectedRef.current === id) setState(next); }
      setSubmitting(null);
      void refresh(id, true).catch(failure => { if (mounted.current && selectedRef.current === id) setError(errorText(failure)); });
      void refreshList(true).catch(() => {});
      if (!mounted.current || selectedRef.current !== id) return;
      pending.current = null; upload.clear(); setDraft(''); atBottom.current = true;
    } catch (failure) { if (mounted.current) { setSubmitting(null); setError(errorText(failure)); } } finally { if (mounted.current) { setBusy(false); editor.current?.focus(); } }
  }
  async function patch(id: string, value: Record<string, unknown>) {
    try { await api(`/sessions/${id}`, 'PATCH', value); listVersion.current++; setMenu(null); setEdit(null); await refreshList(true); } catch (failure) { setError(errorText(failure)); }
  }
  async function remove(id: string) {
    try { await api(`/sessions/${id}`, 'DELETE', {}); versions.current.set(id, (versions.current.get(id) ?? 0) + 1); listVersion.current++; cache.removeSession(id); views.current.delete(id); setDeleting(null); if (id === selected) newChat(); await refreshList(true); } catch (failure) { setError(errorText(failure)); }
  }
  async function stop() {
    if (!selected) return;
    try { for (const job of working) await api(`/sessions/${selected}/jobs/${job.id}/stop`, 'POST', {}); await refresh(selected, true); } catch (failure) { setError(errorText(failure)); }
  }
  const visible = conversations.filter(item => item.archived === archive && item.title.toLowerCase().includes(query.toLowerCase()));
  const title = conversations.find(item => item.id === selected)?.title ?? '新对话';
  return <div className={`workspace ${sidebar ? '' : 'sidebar-closed'}`}>
    {sidebar && <aside className="sidebar"><div className="sidebar-brand"><Brand small/><button className="icon-button" aria-label="收起侧栏" onClick={() => setSidebar(false)}><PanelLeftClose size={18}/></button></div>
      <button className="new-chat" onClick={newChat}><Plus size={18}/>新对话<span>⌘ ⇧ O</span></button>
      <div className="search"><Search size={15}/><input aria-label="搜索对话" placeholder="搜索对话" value={query} onChange={event => setQuery(event.target.value)}/></div>
      <div className="list-label"><span>{archive ? '已归档' : '我的对话'}</span><button onClick={() => setArchive(!archive)}>{archive ? '返回列表' : '归档'}</button></div>
      <nav className="conversation-list" aria-label="对话列表">{visible.length === 0 && <p className="empty-list">{query ? '没有找到相关对话' : archive ? '还没有归档的对话' : '新的想法，从这里开始'}</p>}{visible.map(item => <div key={item.id} className={`conversation ${selected === item.id && !admin ? 'selected' : ''}`}>
        <button className="conversation-title" onClick={() => { choose(item.id); if (innerWidth < 760) setSidebar(false); }}><MessageSquare size={15}/><span>{item.pinned ? '· ' : ''}{item.title}</span></button><button aria-label={`${item.title}的更多操作`} className="icon-button more-button" onClick={() => setMenu(menu === item.id ? null : item.id)}><MoreHorizontal size={16}/></button>
        {menu === item.id && <div className="dropdown"><button onClick={() => { setEdit({ id: item.id, title: item.title }); setMenu(null); }}>重命名</button><button onClick={() => void patch(item.id, { pinned: !item.pinned })}>{item.pinned ? '取消置顶' : '置顶'}</button><button onClick={() => void patch(item.id, { archived: !item.archived })}>{item.archived ? '取消归档' : '归档'}</button><button className="danger" onClick={() => { setDeleting(item.id); setMenu(null); }}>删除对话</button></div>}
      </div>)}</nav>
      <div className="account">{identity.user.role === 'admin' && <button className={`admin-link ${admin ? 'active' : ''}`} onClick={() => { setAdmin(true); }}><ShieldCheck size={17}/>管理中心</button>}<div className="account-row"><span className="avatar">{identity.user.display_name.slice(0, 1)}</span><div><strong>{identity.user.display_name}</strong><span>{identity.user.department_name || '个人对话空间'}</span></div><button className="icon-button" aria-label="退出登录" title="退出登录" onClick={() => void logout()}><LogOut size={17}/></button></div></div>
    </aside>}
    <main className="main"><header className="topbar"><div>{!sidebar && <button className="icon-button" aria-label="展开侧栏" onClick={() => setSidebar(true)}><Menu size={20}/></button>}<span>{admin ? '管理中心' : selected ? title : '对话'}</span></div><span className="mode-badge"><span/>对话模式</span></header>
      {admin ? <Admin currentUserId={identity.user.id}/> : <><div className="transcript message-list" ref={transcript} onScroll={() => { const element = transcript.current; if (element) atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120; }}>
        {!selected && <div className="welcome"><div className="welcome-mark"><Sparkles size={26}/></div><span className="eyebrow">你好，{identity.user.display_name}</span><h1>今天，想聊些什么？</h1><p>一个问题、一点灵感，或者一个还没想清楚的想法。</p><div className="suggestions">{[{ icon: <PenLine size={19}/>, title: '打磨一段表达', text: '我有一段文字，想请你帮我整理和润色。' }, { icon: <Sparkles size={19}/>, title: '寻找新的灵感', text: '我们一起头脑风暴。请先了解我的目标，再帮我拓展思路。' }, { icon: <MessageSquare size={19}/>, title: '把问题想清楚', text: '我想和你讨论一个问题，请通过对话帮我梳理思路。' }].map(item => <button key={item.title} onClick={() => { setDraft(item.text); editor.current?.focus(); }}>{item.icon}<span>{item.title}</span><span>↗</span></button>)}</div></div>}
        {loading && <div className="status-line"><span className="loading-dot"/>正在打开对话…</div>}
        <div className="message-column"><NativeTranscript state={state} live={live} selected={selected} submitting={submitting} modelName={identity.models.find(item => item.id === model)?.name ?? model} onError={setError} onRetry={text => { setDraft(text); editor.current?.focus(); }}>
          {compacting && <div className="status-line"><span className="loading-dot"/>正在整理上下文，对话会继续…</div>}
          <Solutions items={state?.solutions ?? []} refresh={() => selected ? refresh(selected) : Promise.resolve()}/>
        </NativeTranscript></div>
      </div><div className="composer-area">{error && <div className="error-banner" role="alert"><span>{error}</span><button className="icon-button" aria-label="关闭提示" onClick={() => setError('')}><X size={15}/></button></div>}{reconnecting && <div className="status-line">连接正在恢复，已提交的对话会继续处理。</div>}
        <form className="composer" onDragOver={event => event.preventDefault()} onDrop={event => { event.preventDefault(); void upload.add(Array.from(event.dataTransfer.files)); }} onSubmit={event => void send(event)}><AttachmentDrafts upload={upload}/><textarea ref={editor} onPaste={event => { if (event.clipboardData.files.length) { event.preventDefault(); void upload.add(Array.from(event.clipboardData.files)); } }} aria-label="输入消息" placeholder="输入你的想法…" rows={3} value={draft} maxLength={100000} disabled={busy} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}/><div className="composer-bottom"><div><UploadButton upload={upload}/><select aria-label="选择模型" value={model} onChange={event => setModel(event.target.value)}>{identity.models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></div><div>{working.length > 0 && <button className="stop-button" type="button" onClick={() => void stop()}><Square size={12} fill="currentColor"/>停止</button>}<button className="send-button" aria-label="发送消息" disabled={(!draft.trim() && !upload.items.length) || busy || upload.busy}>{busy ? <span className="loading-dot"/> : <ArrowUp size={20}/>}</button></div></div></form><div className="composer-note"><span>Enter 发送 · Shift + Enter 换行</span><span>Powered by CardBush</span></div>
      </div></>}
    </main>
    {edit && <Modal title="重命名对话" close={() => setEdit(null)}><form onSubmit={event => { event.preventDefault(); void patch(edit.id, { title: edit.title }); }}><input aria-label="对话名称" autoFocus required maxLength={200} value={edit.title} onChange={event => setEdit({ ...edit, title: event.target.value })}/><button className="primary">保存</button></form></Modal>}
    {deleting && <Modal title="删除这段对话？" close={() => setDeleting(null)}><p>删除后，对话记录将无法从列表中恢复。</p><div className="modal-actions"><button onClick={() => setDeleting(null)}>取消</button><button className="primary destructive" onClick={() => void remove(deleting)}>删除对话</button></div></Modal>}
  </div>;
}

function Modal({ title, close, children }: { title: string; close: () => void; children: React.ReactNode }) { return <div className="modal-backdrop" onClick={close}><section className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={event => event.stopPropagation()}><header><h2>{title}</h2><button className="icon-button" aria-label="关闭" onClick={close}><X size={18}/></button></header>{children}</section></div>; }

createRoot(document.getElementById('root')!).render(<App/>);
