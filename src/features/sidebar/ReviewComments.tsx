import { createContext, useContext, useMemo, useRef, useEffect, useState, type Dispatch, type SetStateAction, type ReactNode } from 'react';
import { ChevronDown, MessageSquare, Pencil, Plus, Trash2 } from 'lucide-react';
import type { AppLanguage } from '../../types';
import { basename } from '../../shared/localPaths';
import type { DiffLine } from '../tools/toolChangeReports';
import { diffLineNumbers } from '../tools/diffSyntax';
import { reviewAnchor, reviewLineLabel, reviewRevision, type ReviewComment, type ReviewCommentAnchor, type ReviewCommentState } from './reviewCommentModel';

export type ReviewCommentsChange = Dispatch<SetStateAction<ReviewCommentState>>;
type ReviewCommentsValue = {
  language: AppLanguage;
  path: string;
  turnId: string;
  revision: string;
  lines: DiffLine[];
  state: ReviewCommentState;
  onChange: ReviewCommentsChange;
  rows: Map<number, { comments: ReviewComment[]; draft: boolean; selected: boolean }>;
};
const ReviewCommentsContext = createContext<ReviewCommentsValue | null>(null);

export function ReviewCommentsScope({ language, path, turnId, lines, state, onChange, children }: {
  language: AppLanguage; path: string; turnId: string; lines: DiffLine[];
  state?: ReviewCommentState; onChange?: ReviewCommentsChange; children: ReactNode;
}) {
  const revision = useMemo(() => reviewRevision(lines), [lines]);
  const value = useMemo(() => {
    if (!state || !onChange) return null;
    const rows: ReviewCommentsValue['rows'] = new Map();
    const numbers = diffLineNumbers(lines);
    const matches = (anchor: ReviewCommentAnchor) => anchor.path === path && anchor.turnId === turnId && anchor.revision === revision;
    const comments = state.comments.filter(matches);
    const draft = state.draft && matches(state.draft) ? state.draft : null;
    numbers.forEach((number, index) => {
      const atEnd = (anchor: ReviewCommentAnchor) => (anchor.side === 'old' ? number.oldLine : number.newLine) === anchor.endLine;
      const selectedLine = draft?.side === 'old' ? number.oldLine : number.newLine;
      const rowComments = comments.filter(atEnd);
      const rowDraft = !!draft && atEnd(draft);
      const selected = !!draft && selectedLine != null && selectedLine >= draft.startLine && selectedLine <= draft.endLine;
      if (rowComments.length || rowDraft || selected) rows.set(index, { comments: rowComments, draft: rowDraft, selected });
    });
    return { language, path, turnId, revision, lines, state, onChange, rows };
  }, [language, path, turnId, revision, lines, state, onChange]);
  return <ReviewCommentsContext.Provider value={value}>{children}</ReviewCommentsContext.Provider>;
}

export function ReviewDiffLine({ index, oldLine, newLine, kind, children }: {
  index: number; oldLine: number | null; newLine: number | null; kind: string; children: ReactNode;
}) {
  const review = useContext(ReviewCommentsContext);
  const enabled = !!review && kind !== 'hunk' && (oldLine != null || newLine != null);
  const row = review?.rows.get(index);
  const open = (side: 'old' | 'new', extend: boolean, target: HTMLButtonElement) => {
    if (!review) return;
    const draft = review.state.draft;
    const extendDraft = extend && draft?.path === review.path && draft.turnId === review.turnId && draft.revision === review.revision && draft.side === side;
    if (draft && !extendDraft && (draft.text.trim() || draft.id)) {
      target.closest('.change-review-dialog')?.querySelector<HTMLTextAreaElement>('.review-comment-editor textarea')?.focus();
      return;
    }
    review.onChange(current => {
      const canExtend = extend && current.draft?.path === review.path && current.draft.turnId === review.turnId && current.draft.revision === review.revision && current.draft.side === side;
      const anchor = reviewAnchor(review.lines, review.path, review.turnId, review.revision, index, side, canExtend ? current.draft : null);
      if (!anchor) return current;
      // Switching the anchor must never silently replace an unfinished comment.
      if (current.draft && !canExtend && (current.draft.text.trim() || current.draft.id)) return current;
      return { ...current, draft: { ...anchor, ...(canExtend ? { id: current.draft?.id } : {}), text: canExtend ? current.draft?.text ?? '' : '' } };
    });
  };
  return <>
    <div className={`diff-line ${kind}${enabled ? ' review-commentable-line' : ''}${row?.selected ? ' review-comment-selected' : ''}`}>
      {children}
      {enabled && <span className="review-line-actions">
        <button type="button" className="review-add-comment" aria-label={review.language === 'zh' ? `在 ${newLine ?? oldLine} 行添加评论` : `Comment on line ${newLine ?? oldLine}`}
          title={review.language === 'zh' ? '添加评论 · Shift+点击另一行可选择多行' : 'Add comment · Shift+click another line to select a range'}
          onClick={event => open(newLine != null ? 'new' : 'old', event.shiftKey, event.currentTarget)}><Plus size={13} /></button>
        {oldLine != null && <button type="button" className="review-line-target old" aria-label={`L${oldLine}`} title={review.language === 'zh' ? '评论修改前的行' : 'Comment on the original line'} onClick={event => open('old', event.shiftKey, event.currentTarget)} />}
        {newLine != null && <button type="button" className="review-line-target new" aria-label={`R${newLine}`} title={review.language === 'zh' ? '评论修改后的行' : 'Comment on the updated line'} onClick={event => open('new', event.shiftKey, event.currentTarget)} />}
      </span>}
    </div>
    {review && row && (row.comments.length > 0 || row.draft) && <div className="review-line-comments">
      {row.comments.filter(comment => review.state.draft?.id !== comment.id).map(comment => <ReviewCommentCard key={comment.id} comment={comment} language={review.language} onChange={review.onChange} editing={!!review.state.draft} />)}
      {row.draft && <ReviewCommentEditor state={review.state} onChange={review.onChange} language={review.language} />}
    </div>}
  </>;
}

function ReviewCommentEditor({ state, onChange, language }: { state: ReviewCommentState; onChange: ReviewCommentsChange; language: AppLanguage }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const draft = state.draft;
  useEffect(() => { input.current?.focus({ preventScroll: true }); }, [draft?.path, draft?.turnId, draft?.startLine, draft?.endLine]);
  if (!draft) return null;
  const save = () => {
    onChange(current => {
      if (!current.draft?.text.trim()) return current;
      const comment: ReviewComment = { ...current.draft, id: current.draft.id ?? crypto.randomUUID(), text: current.draft.text.trim() };
      return { comments: [...current.comments.filter(item => item.id !== comment.id), comment], draft: null };
    });
  };
  return <form className="review-comment-editor" onSubmit={event => { event.preventDefault(); save(); }}>
    <header><strong>{language === 'zh' ? '你' : 'You'}</strong><span>{reviewLineLabel(draft)} · {language === 'zh' ? '本地评论' : 'Local comment'}</span></header>
    <textarea ref={input} aria-label={language === 'zh' ? '代码评论' : 'Code comment'} placeholder={language === 'zh' ? '描述希望修改的地方…' : 'Describe the requested change…'} value={draft.text}
      onChange={event => { const text = event.target.value; onChange(current => current.draft ? { ...current, draft: { ...current.draft, text } } : current); }}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); save(); }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onChange(current => ({ ...current, draft: null })); }
      }} />
    <footer><button type="button" onClick={() => onChange(current => ({ ...current, draft: null }))}>{language === 'zh' ? '取消' : 'Cancel'}</button>
      <button type="submit" className="review-comment-save" disabled={!draft.text.trim()}>{draft.id ? (language === 'zh' ? '保存' : 'Save') : (language === 'zh' ? '评论' : 'Comment')}</button></footer>
  </form>;
}

function ReviewCommentCard({ comment, language, onChange, editing }: { comment: ReviewComment; language: AppLanguage; onChange: ReviewCommentsChange; editing: boolean }) {
  return <article className="review-comment-card">
    <header><strong>{language === 'zh' ? '你' : 'You'}</strong><span>{reviewLineLabel(comment)} · {language === 'zh' ? '待提交' : 'Pending'}</span>
      <button type="button" aria-label={language === 'zh' ? '编辑评论' : 'Edit comment'} disabled={editing} onClick={() => onChange(current => ({ ...current, draft: { ...comment } }))}><Pencil size={12} /></button>
      <button type="button" aria-label={language === 'zh' ? '删除评论' : 'Delete comment'} onClick={() => onChange(current => ({ ...current, comments: current.comments.filter(item => item.id !== comment.id) }))}><Trash2 size={12} /></button></header>
    <p>{comment.text}</p>
  </article>;
}

export function ReviewCommentsFooter({ state, onChange, onCompose, language, path, turnId, revision, onSelect }: {
  state: ReviewCommentState; onChange: ReviewCommentsChange; onCompose: (comments: ReviewComment[]) => void; language: AppLanguage;
  path: string; turnId: string; revision: string; onSelect: (anchor: ReviewCommentAnchor) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const draftElsewhere = state.draft && (state.draft.path !== path || state.draft.turnId !== turnId || state.draft.revision !== revision);
  if (!state.comments.length && !state.draft) return null;
  return <div className="review-comments-footer">
    {draftElsewhere && <div className="review-comment-away"><button type="button" title={state.draft!.path} onClick={() => onSelect(state.draft!)}>{basename(state.draft!.path)} · {reviewLineLabel(state.draft!)}</button>
      <ReviewCommentEditor state={state} onChange={onChange} language={language} /></div>}
    {expanded && state.comments.length > 0 && <div className="review-comments-list">{state.comments.map(comment => <div key={comment.id}>
      <button type="button" className="review-comment-location" title={comment.path} onClick={() => onSelect(comment)}>{basename(comment.path)} · {reviewLineLabel(comment)}</button>
      <ReviewCommentCard comment={comment} language={language} onChange={onChange} editing={!!state.draft} />
    </div>)}</div>}
    <div className="review-comments-toolbar"><button type="button" aria-expanded={expanded} disabled={!state.comments.length} onClick={() => setExpanded(value => !value)}><MessageSquare size={14} />
      <span>{state.comments.length ? (language === 'zh' ? `${state.comments.length} 条评论` : `${state.comments.length} comments`) : (language === 'zh' ? '正在写评论' : 'Writing a comment')}</span>{state.comments.length > 0 && <ChevronDown size={12} />}</button>
      <button type="button" className="review-comment-compose" disabled={!state.comments.length || !!state.draft} title={state.draft ? (language === 'zh' ? '请先保存或取消正在编辑的评论' : 'Save or cancel the open comment first') : (language === 'zh' ? '将评论加入此会话输入框' : 'Add comments to this conversation draft')}
        onClick={() => { onCompose(state.comments); const ids = new Set(state.comments.map(comment => comment.id)); onChange(current => ({ ...current, comments: current.comments.filter(comment => !ids.has(comment.id)) })); }}>
        {language === 'zh' ? '加入对话' : 'Add to conversation'}</button></div>
  </div>;
}
