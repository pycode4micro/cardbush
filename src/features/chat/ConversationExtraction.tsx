import { uiText } from '../../i18n';
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
  language: AppLanguage;
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
    if (count(next) > limit && next.keys.length > current.keys.length) return { ...current, error: uiText(language)('conversationExtraction.the_selection_has_reached_one_quarter_of') };
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
    if (!api) throw new Error(uiText(language)('conversationExtraction.conversation_excerpts_are_unavailable'));
    const preview = await api.preview({ sessionId, keys: [], title: '', description: '', contextWindowTokens });
    return markdown(await api.save({ sessionId, keys: defaultKeys(preview), title: '', description: '', contextWindowTokens }, 'reference'));
  };
  const context: ExtractionContext = { language, open, fork: sessionId => { void onFork(sessionId).catch(error => showUiError(uiText(language)('conversationExtraction.could_not_fork_the_conversation'), String(error))); },
    permanent: items.permanent, pending: items.pending.filter(item => (item.expiresAt ?? 0) > now), draft, toggle, limit, referenceSession,
    consume: async id => { if (!api) throw new Error(uiText(language)('conversationExtraction.conversation_excerpts_are_unavailable')); return markdown(await api.consume(id)); } };
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
        <header><FileOutput size={20} /><h2 id="extract-title">{uiText(language)('conversationExtraction.extractConversation')}</h2>
          <button type="button" aria-label={uiText(language)('common.close')} disabled={draft.busy} onClick={close}><X size={18} /></button></header>
        <label>{uiText(language)('conversationExtraction.title_optional')}<input autoFocus maxLength={160} value={draft.title} disabled={draft.busy}
          onChange={event => setDraft({ ...draft, title: event.target.value })} placeholder={draft.preview?.source.title || uiText(language)('conversationExtraction.name_this_conversation_excerpt')} /></label>
        <label>{uiText(language)('conversationExtraction.description_optional')}<textarea maxLength={2000} rows={2} value={draft.description} disabled={draft.busy}
          onChange={event => setDraft({ ...draft, description: event.target.value })} placeholder={uiText(language)('conversationExtraction.what_context_or_help_does_this_excerpt')} /></label>
        <label>{uiText(language)('conversationExtraction.excerpt_range')}<select value={draft.mode} disabled={draft.busy || !draft.preview} onChange={event => {
          if (event.target.value === 'select') choose(); else setDraft({ ...draft, mode: 'default', keys: defaultKeys(draft.preview!) });
        }}><option value="default">{uiText(language)('conversationExtraction.default_last_5_turns')}</option><option value="select">{uiText(language)('conversationExtraction.select')}</option></select></label>
        {draft.mode === 'select' && <button type="button" className="extract-select-again" disabled={draft.busy} onClick={choose}>{uiText(language)('conversationExtraction.return_to_the_conversation_to_adjust_the')}</button>}
        <p className="extract-hint">{uiText(language)('conversationExtraction.extract_saved_turns_using_background_summaries_when')}</p>
        <div className={`extract-budget${count(draft) > limit ? ' over' : ''}`} role="status">
          {uiText(language)('extraction.budget', { count: draft.keys.length, used: count(draft).toLocaleString(language), limit: limit.toLocaleString(language) })}<small>{draft.preview?.tokenMethod || uiText(language)('conversationExtraction.reading_conversation')}{uiText(language)('extraction.budgetFraction')}</small>
        </div>
        {draft.error && <p className="extract-error" role="alert">{draft.error}</p>}
        {draft.preview && !draft.keys.length && <p className="extract-hint">{uiText(language)('conversationExtraction.nothing_is_selected_choose_select_to_pick')}</p>}
        <p className="extract-hint">{uiText(language)('conversationExtraction.add_a_title_and_description_to_save')}</p>
        <footer>
          <button type="button" disabled={draft.busy || !draft.keys.length || count(draft) > limit} onClick={() => void save('file')}>{uiText(language)('conversationExtraction.save_as_markdown')}</button>
          <button type="button" disabled={draft.busy || !draft.keys.length || count(draft) > limit} onClick={() => void save('temporary')}>{uiText(language)('conversationExtraction.save_temporarily_30_seconds')}</button>
          <button type="button" className="primary" disabled={draft.busy || !draft.keys.length || count(draft) > limit || !draft.title.trim() || !draft.description.trim()}
            title={!draft.title.trim() || !draft.description.trim() ? uiText(language)('conversationExtraction.enter_a_title_and_description') : uiText(language)('conversationExtraction.save_permanently_and_add_to_references')} onClick={() => void save('permanent')}>{uiText(language)('conversationExtraction.save_permanently')}</button>
        </footer>
      </section>
    </div>, document.querySelector('.app') ?? document.body)}
    {draft?.selecting && createPortal(<div className="extract-selection-bar" role="region" aria-label={uiText(language)('conversationExtraction.conversation_excerpt_selection')}>
      <span>{uiText(language)('extraction.conservativeBudget', { count: draft.keys.length, used: count(draft).toLocaleString(language), limit: limit.toLocaleString(language) })}</span>
      {draft.error && <span className="extract-error" role="alert">{draft.error}</span>}
      {draft.sessionId !== activeSessionId && <button type="button" onClick={() => onOpen(draft.sessionId)}>{uiText(language)('conversationExtraction.return_to_source_conversation')}</button>}
      <button type="button" onClick={() => setDraft({ ...draft, keys: [], error: undefined })}>{uiText(language)('conversationExtraction.clear_selection')}</button>
      <button type="button" onClick={close}>{uiText(language)('agentConnectionForm.cancel')}</button>
      <button type="button" className="primary" onClick={() => setDraft({ ...draft, selecting: false })}>{uiText(language)('conversationExtraction.finish_selection')}</button>
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
      aria-label={uiText(context?.language)('conversationExtraction.select_value1_value2', { value1: unit.role === 'user' ? uiText(context?.language)('conversationExtraction.user_message') : uiText(context?.language)('conversationExtraction.agent_reply'), value2: unit.summarized ? uiText(context?.language)('conversationExtraction.background_summary') : '' })}
      onClick={() => context.toggle(unit.key)}>{checked && <Check size={15} />}</button>
    {unit.summarized && <span className="extract-summary-note" title={unit.preview}>{uiText()('conversationExtraction.using_a_background_summary')}</span>}
  </div>;
}

export function ExtractionBulbs({ onInsert }: { onInsert: (text: string) => void }) {
  const context = useContext(ConversationExtractionContext);
  return <>{context?.pending.map(item => <button key={item.id} className="tool-chip extract-bulb" type="button"
    title={uiText(context?.language)('conversationExtraction.insert_excerpt_value1_valid_for_30_seconds', { value1: item.title })} aria-label={uiText(context?.language)('conversationExtraction.insert_excerpt_value1', { value1: item.title })}
    onClick={() => { void context.consume(item.id).then(onInsert).catch(error => showUiError(uiText(context?.language)('conversationExtraction.could_not_insert_the_excerpt'), String(error))); }}><Lightbulb size={17} /></button>)}</>;
}

export function ExtractionMenuIcon({ fork = false }: { fork?: boolean }) { return fork ? <GitFork size={15} /> : <FileOutput size={15} />; }
