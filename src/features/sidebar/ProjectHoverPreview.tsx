import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Check, Edit3, Folder, LoaderCircle, MessageSquare, X } from 'lucide-react';
import { HoverPreview, type useHoverPreview } from '../../components/HoverPreview';
import { uiText } from '../../i18n';
import { conversationDisplayTitle } from '../../shared/conversationTitle';
import type { AppLanguage, ConversationSummary, ProjectItem, SessionAttentionState } from '../../types';
import { sessionAttentionLabel } from '../sessionAttention';
import { relativeConversationAge } from './ConversationHoverPreview';

const conversationPageSize = 3;

/** Mounted only while the project card is open; uses summaries, never full histories. */
export function ProjectHoverPreview({ preview, project, conversations, language, activeConversationId,
  runningConversationIds, attentionByConversation, onRename, onConversationChange }: {
  preview: ReturnType<typeof useHoverPreview>;
  project: ProjectItem;
  conversations: ConversationSummary[];
  language: AppLanguage;
  activeConversationId: string;
  runningConversationIds?: ReadonlySet<string>;
  attentionByConversation?: Record<string, SessionAttentionState>;
  onRename: (title: string) => Promise<string | null>;
  onConversationChange: (id: string) => void;
}) {
  const t = uiText(language);
  const listId = useId(), errorId = useId();
  const [visibleCount, setVisibleCount] = useState(conversationPageSize);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(project.title);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null), nameButton = useRef<HTMLButtonElement>(null);
  const pending = useRef(false), mounted = useRef(true), returnFocus = useRef(false);
  const releaseEdit = useRef<(() => void) | null>(null);
  const recent = useMemo(() => [...conversations].sort((a, b) =>
    (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0)), [conversations]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; releaseEdit.current?.(); };
  }, []);
  useLayoutEffect(() => {
    if (editing) { input.current?.focus(); input.current?.select(); }
    else if (returnFocus.current) { nameButton.current?.focus({ preventScroll: true }); returnFocus.current = false; }
  }, [editing]);

  function beginRename() {
    setDraft(project.title); setError(''); setEditing(true);
    // Editing owns the card until save/cancel, including blur to an outside control.
    preview.keepOpenUntil(new Promise<void>(resolve => { releaseEdit.current = resolve; }));
  }
  function finishRename() {
    returnFocus.current = input.current?.form?.contains(document.activeElement) ?? false;
    setEditing(false); setError('');
    releaseEdit.current?.(); releaseEdit.current = null;
  }
  async function saveName() {
    if (pending.current) return;
    const title = draft.trim();
    if (!title) { setError(t('app.projectNameIsRequired')); input.current?.focus(); return; }
    if (title === project.title) { finishRename(); return; }
    pending.current = true; setSaving(true); setError('');
    let failure: string | null;
    try { failure = await onRename(title); }
    catch { failure = t('projectHoverPreview.renameFailed'); }
    pending.current = false;
    if (!mounted.current) return;
    setSaving(false);
    if (failure) { setError(failure); input.current?.focus(); }
    else finishRename();
  }

  return <HoverPreview preview={preview} className="project-hover-preview"
    interactiveLabel={t('projectHoverPreview.details')} onEscape={() => {
      if (!editing) return false;
      if (!pending.current) finishRename();
      return true;
    }}>
    <div className="project-hover-heading">
      <Folder aria-hidden="true" />
      {editing ? <form className="project-hover-name-form" aria-busy={saving}
        onSubmit={event => { event.preventDefault(); void saveName(); }}>
        <input ref={input} value={draft} readOnly={saving} aria-label={t('projectHoverPreview.name')}
          title={t('projectHoverPreview.editHint')} aria-invalid={!!error} aria-describedby={error ? errorId : undefined}
          onChange={event => { setDraft(event.target.value); setError(''); }}
          onKeyDown={event => { if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault(); }}
          onBlur={event => {
            if (!event.currentTarget.form?.contains(event.relatedTarget as Node | null)) void saveName();
          }} />
        <button type="submit" disabled={saving} aria-label={t('chatSidebar.saveTitle')} title={t('chatSidebar.saveTitle')}>
          {saving ? <LoaderCircle className="spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
        </button>
        <button type="button" disabled={saving} onClick={finishRename}
          aria-label={t('chatSidebar.cancelRename')} title={t('chatSidebar.cancelRename')}><X aria-hidden="true" /></button>
      </form> : <button ref={nameButton} type="button" className="project-hover-name" onClick={beginRename}
        aria-label={t('chatSidebar.renameProject')} title={t('chatSidebar.renameProject')}>
        <strong>{project.title}</strong><Edit3 aria-hidden="true" />
      </button>}
    </div>
    {error && <p id={errorId} className="project-hover-error" role="alert">{error}</p>}
    <div className="project-hover-count"><MessageSquare aria-hidden="true" />
      <span>{t('projectHoverPreview.chatCount', { count: conversations.length, total: conversations.length.toLocaleString(language) })}</span>
    </div>
    {recent.length ? <>
      <div id={listId} className="project-hover-conversations" role="list" aria-label={t('conversationSearchDialog.recentChats')}>
        {recent.slice(0, visibleCount).map(conversation => {
          const running = runningConversationIds?.has(conversation.id);
          const attention = attentionByConversation?.[conversation.id];
          const status = attention && !(running && attention.kind === 'completed')
            ? sessionAttentionLabel(attention, language) : running ? t('chatSidebar.sessionRunning') : '';
          const updated = Date.parse(conversation.updatedAt);
          return <div key={conversation.id} role="listitem">
            <button type="button" className="project-hover-conversation" data-conversation-id={conversation.id}
              aria-current={conversation.id === activeConversationId ? 'page' : undefined}
              onClick={() => { preview.close(); onConversationChange(conversation.id); }}>
              <span className="project-hover-conversation-title">{conversationDisplayTitle(conversation.title)}</span>
              <span className="project-hover-conversation-meta">
                {Number.isFinite(updated) && <time dateTime={conversation.updatedAt} title={new Date(updated).toLocaleString(language)}>
                  {relativeConversationAge(updated, language)}</time>}
                {status && <span>{status}</span>}
              </span>
            </button>
          </div>;
        })}
      </div>
      {visibleCount < recent.length && <button type="button" className="project-hover-more" aria-controls={listId}
        onClick={() => setVisibleCount(count => count + conversationPageSize)}>
        {t('projectHoverPreview.showMore', { count: recent.length - visibleCount, total: (recent.length - visibleCount).toLocaleString(language) })}
      </button>}
    </> : <p className="project-hover-empty">{t('conversationSearchDialog.noChatsYet')}</p>}
  </HoverPreview>;
}
