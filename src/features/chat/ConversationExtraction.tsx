import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, FileOutput, GitFork, Lightbulb, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import type { ConversationExtractItem, ConversationExtractPreview, ConversationExtractSelection } from '@cardbush/bush-protocol';
import type { AppLanguage, ChatMessage } from '../../types';
import { useKeyboardShortcuts } from '../shortcuts/useKeyboardShortcuts';
import { promptReferenceMarkdown } from '../../shared/promptReferences';
import { showUiError } from '../../shared/showUiError';
import './conversationExtraction.css';

export const CONVERSATION_DRAG_TYPE = 'application/x-cardbush-conversation';
type Draft = { sessionId: string; title: string; description: string; mode: 'default' | 'select';
  selecting: boolean; keys: string[]; preview?: ConversationExtractPreview; error?: string; busy: boolean };
type ExtractionContext = {
  open: (sessionId: string) => void; fork: (sessionId: string) => void;
  permanent: ConversationExtractItem[]; pending: ConversationExtractItem[];
  draft: Draft | null; toggle: (key: string) => void; limit: number;
  referenceSession: (sessionId: string) => Promise<string>;
  consume: (id: string) => Promise<string>;
};
export const ConversationExtractionContext = createContext<ExtractionContext | null>(null);
const bytes = (text: string) => new TextEncoder().encode(text).length;
function count(draft: Draft) {
  const preview = draft.preview; if (!preview) return 0;
  const title = (draft.title.trim() || preview.source.title).replace(/[\r\n]+/g, ' ').trim();
  const extra = bytes(title) - bytes(preview.source.title.replace(/[\r\n]+/g, ' ').trim()) +
    (draft.description.trim() ? bytes(draft.description.trim()) + 2 : 0);
  return preview.overheadTokens + extra + preview.source.units.reduce((sum, unit) => sum + (draft.keys.includes(unit.key) ? unit.tokens : 0), 0);
}
function defaultKeys(preview: ConversationExtractPreview): string[] {
  let keys = [...preview.source.defaultKeys];
  while (keys.length && count({ ...emptyDraft(preview.source.sessionId), keys, preview }) > preview.tokenLimit) {
    const first = preview.source.units.find(unit => unit.key === keys[0])!;
    keys = keys.filter(key => preview.source.units.find(unit => unit.key === key)?.turnId !== first.turnId);
  }
  return keys;
}
const emptyDraft = (sessionId: string): Draft => ({ sessionId, title: '', description: '', mode: 'default', selecting: false, keys: [], busy: false });
const markdown = (item: ConversationExtractItem) => promptReferenceMarkdown({ kind: 'conversation-extract', id: item.id, title: item.title });

export function ConversationExtractionProvider({ activeSessionId, contextWindowTokens, onOpen, onFork, language, children, api: suppliedApi }: {
  api?: import('@cardbush/bush-protocol').ConversationExtractDesktopApi;
  activeSessionId: string; contextWindowTokens: number; onOpen: (sessionId: string) => void;
  onFork: (sessionId: string) => Promise<void>; language: AppLanguage; children: ReactNode;
}) {
  const api = suppliedApi ?? window.cardbushDesktop?.conversationExtracts;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [items, setItems] = useState<{ permanent: ConversationExtractItem[]; pending: ConversationExtractItem[] }>({ permanent: [], pending: [] });
  const generation = useRef(0), shortcuts = useKeyboardShortcuts();
  const [now, setNow] = useState(Date.now());
  const limit = Math.floor(contextWindowTokens / 4);
  const open = useCallback((sessionId: string) => {
    if (!api || !sessionId) return;
    const request = ++generation.current;
    setDraft({ ...emptyDraft(sessionId), busy: true });
    void api.preview({ sessionId, keys: [], title: '', description: '', contextWindowTokens }).then(preview => {
      if (generation.current === request) setDraft({ ...emptyDraft(sessionId), preview, keys: defaultKeys(preview) });
    }).catch(error => { if (generation.current === request) setDraft({ ...emptyDraft(sessionId), error: String(error) }); });
  }, [api, contextWindowTokens]);
  useEffect(() => {
    if (!api) return;
    let alive = true, revision = 0;
    const refresh = () => { const request = ++revision; void api.list().then(items => { if (alive && request === revision) setItems(items); })
      .catch(error => console.warn('Conversation extracts unavailable', error)); };
    refresh(); const unsubscribe = api.onChanged(refresh);
    return () => { alive = false; unsubscribe(); };
  }, [api]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const current = Date.now(); setNow(current);
      const next = Math.min(...items.pending.map(item => item.expiresAt ?? current).filter(time => time > current));
      if (Number.isFinite(next)) timer = setTimeout(tick, Math.max(1, next - current));
    };
    tick();
    return () => clearTimeout(timer);
  }, [items.pending]);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || document.querySelector('[role="dialog"]')) return;
      if (activeSessionId && shortcuts.matches('extractConversation', event)) { event.preventDefault(); open(activeSessionId); }
    };
    window.addEventListener('keydown', keydown); return () => window.removeEventListener('keydown', keydown);
  }, [activeSessionId, open, shortcuts]);
  const selection = (draft: Draft): ConversationExtractSelection => ({ sessionId: draft.sessionId, keys: draft.keys,
    title: draft.title, description: draft.description, contextWindowTokens });
  const toggle = (key: string) => setDraft(current => {
    if (!current || current.busy) return current;
    const next = { ...current, keys: current.keys.includes(key) ? current.keys.filter(item => item !== key) : [...current.keys, key], error: undefined };
    if (count(next) > limit && next.keys.length > current.keys.length) return { ...current, error: '已达到当前模型上下文窗口的 1/4 上限。' };
    return next;
  });
  const close = () => { generation.current++; setDraft(null); };
  const save = async (kind: 'temporary' | 'permanent' | 'file') => {
    if (!api || !draft) return;
    const request = generation.current;
    setDraft(current => current && { ...current, busy: true, error: undefined });
    try {
      if (kind === 'file') { const result = await api.export(selection(draft)); if (result.cancelled) { setDraft(current => current && { ...current, busy: false }); return; } }
      else await api.save(selection(draft), kind);
      if (generation.current === request) close();
    } catch (error) { if (generation.current === request) setDraft(current => current && { ...current, busy: false, error: String(error) }); }
  };
  const referenceSession = async (sessionId: string) => {
    if (!api) throw new Error('对话提取不可用。');
    const preview = await api.preview({ sessionId, keys: [], title: '', description: '', contextWindowTokens });
    return markdown(await api.save({ sessionId, keys: defaultKeys(preview), title: '', description: '', contextWindowTokens }, 'reference'));
  };
  const context: ExtractionContext = { open, fork: sessionId => { void onFork(sessionId).catch(error => showUiError('Fork 会话失败', String(error))); },
    permanent: items.permanent, pending: items.pending.filter(item => (item.expiresAt ?? 0) > now), draft, toggle, limit, referenceSession,
    consume: async id => { if (!api) throw new Error('对话提取不可用。'); return markdown(await api.consume(id)); } };
  const choose = () => { if (draft) { setDraft({ ...draft, mode: 'select', selecting: true }); onOpen(draft.sessionId); } };
  return <ConversationExtractionContext.Provider value={context}>
    {children}
    {draft && !draft.selecting && createPortal(<div className="extract-dialog-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !draft.busy) close(); }}>
      <section className="extract-dialog" role="dialog" aria-modal="true" aria-labelledby="extract-title"
        onKeyDown={event => {
          if (event.key === 'Escape' && !draft.busy) { event.stopPropagation(); close(); }
          if (event.key === 'Tab') {
            const nodes = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled), textarea:not(:disabled), select:not(:disabled), button:not(:disabled)'));
            const first = nodes[0], last = nodes.at(-1);
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }}>
        <header><FileOutput size={20} /><h2 id="extract-title">{language === 'zh' ? '提取对话' : 'Extract conversation'}</h2>
          <button type="button" aria-label="关闭" disabled={draft.busy} onClick={close}><X size={18} /></button></header>
        <label>标题（可选）<input autoFocus maxLength={160} value={draft.title} disabled={draft.busy}
          onChange={event => setDraft({ ...draft, title: event.target.value })} placeholder={draft.preview?.source.title || '给这段对话起个名字'} /></label>
        <label>描述（可选）<textarea maxLength={2000} rows={2} value={draft.description} disabled={draft.busy}
          onChange={event => setDraft({ ...draft, description: event.target.value })} placeholder="这段对话能提供什么背景或帮助" /></label>
        <label>提取范围<select value={draft.mode} disabled={draft.busy || !draft.preview} onChange={event => {
          if (event.target.value === 'select') choose(); else setDraft({ ...draft, mode: 'default', keys: defaultKeys(draft.preview!) });
        }}><option value="default">默认 · 最近 5 轮</option><option value="select">选择</option></select></label>
        {draft.mode === 'select' && <button type="button" className="extract-select-again" disabled={draft.busy} onClick={choose}>返回会话调整选择</button>}
        <p className="extract-hint">提取已保存的轮次，优先采用后台总结；无总结时保留可见回复。超出预算时，默认范围从最早一轮开始缩减。</p>
        <div className={`extract-budget${count(draft) > limit ? ' over' : ''}`} role="status">
          已选 {draft.keys.length} 条 · {count(draft).toLocaleString()} / {limit.toLocaleString()} Token
          <small>{draft.preview?.tokenMethod || '正在读取会话…'} · 当前模型上下文的 1/4</small>
        </div>
        {draft.error && <p className="extract-error" role="alert">{draft.error}</p>}
        {draft.preview && !draft.keys.length && <p className="extract-hint">没有选中的内容。可切换“选择”手动勾选能放入预算的消息。</p>}
        <p className="extract-hint">填写标题和描述后可永久保存，并从任意输入框通过 @ 引用。永久保存仅记录来源和范围。</p>
        <footer>
          <button type="button" disabled={draft.busy || !draft.keys.length || count(draft) > limit} onClick={() => void save('file')}>另存为 Markdown</button>
          <button type="button" disabled={draft.busy || !draft.keys.length || count(draft) > limit} onClick={() => void save('temporary')}>临时保存 · 30 秒</button>
          <button type="button" className="primary" disabled={draft.busy || !draft.keys.length || count(draft) > limit || !draft.title.trim() || !draft.description.trim()}
            title={!draft.title.trim() || !draft.description.trim() ? '请填写标题和描述' : '永久保存并加入 @ 引用列表'} onClick={() => void save('permanent')}>永久保存</button>
        </footer>
      </section>
    </div>, document.querySelector('.app') ?? document.body)}
    {draft?.selecting && createPortal(<div className="extract-selection-bar" role="region" aria-label="对话提取选择">
      <span>已选 {draft.keys.length} 条 · {count(draft).toLocaleString()} / {limit.toLocaleString()} Token（保守上界）</span>
      {draft.error && <span className="extract-error" role="alert">{draft.error}</span>}
      {draft.sessionId !== activeSessionId && <button type="button" onClick={() => onOpen(draft.sessionId)}>返回来源会话</button>}
      <button type="button" onClick={() => setDraft({ ...draft, keys: [], error: undefined })}>清空选择</button>
      <button type="button" onClick={close}>取消</button>
      <button type="button" className="primary" onClick={() => setDraft({ ...draft, selecting: false })}>完成选择</button>
    </div>, document.querySelector('.app') ?? document.body)}
  </ConversationExtractionContext.Provider>;
}

export function ExtractionSelector({ message, sessionId }: { message: ChatMessage; sessionId: string }) {
  const context = useContext(ConversationExtractionContext), draft = context?.draft;
  if (!context || !draft?.selecting || draft.sessionId !== sessionId) return null;
  const unit = draft.preview?.source.units.find(unit => unit.role === message.role && (unit.role === 'assistant'
    ? unit.turnId === message.turnId : unit.messageIds.includes(message.messageId ?? message.id)));
  if (!unit) return null;
  const checked = draft.keys.includes(unit.key);
  return <div className={`extract-message-choice ${unit.role}${checked ? ' selected' : ''}`}>
    <button type="button" className="extract-circle" role="checkbox" aria-checked={checked}
      aria-label={`选择${unit.role === 'user' ? '用户消息' : 'Agent 回复'}${unit.summarized ? '（后台总结）' : ''}`}
      onClick={() => context.toggle(unit.key)}>{checked && <Check size={15} />}</button>
    {unit.summarized && <span className="extract-summary-note" title={unit.preview}>使用后台总结</span>}
  </div>;
}

export function ExtractionBulbs({ onInsert }: { onInsert: (text: string) => void }) {
  const context = useContext(ConversationExtractionContext);
  return <>{context?.pending.map(item => <button key={item.id} className="tool-chip extract-bulb" type="button"
    title={`插入对话提取：${item.title}（30 秒内有效）`} aria-label={`插入对话提取：${item.title}`}
    onClick={() => { void context.consume(item.id).then(onInsert).catch(error => showUiError('无法插入提取', String(error))); }}><Lightbulb size={17} /></button>)}</>;
}

export function ExtractionMenuIcon({ fork = false }: { fork?: boolean }) { return fork ? <GitFork size={15} /> : <FileOutput size={15} />; }
