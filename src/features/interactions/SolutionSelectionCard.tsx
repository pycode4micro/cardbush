import { useId, useRef, useState } from 'react';
import { ArrowRight, ArrowUp, Lightbulb, LoaderCircle, X } from 'lucide-react';
import type { AppLanguage, InteractionReplyAnswer, PendingInteraction } from '../../types';
import './solutionSelection.css';

// Preserve an unfinished alternative when its conversation is temporarily hidden.
const drafts = new Map<string, string>();
export function SolutionSelectionCard({ language, interaction, onReply, onCancel }: {
  language: AppLanguage; interaction: PendingInteraction;
  onReply: (answers: InteractionReplyAnswer[]) => Promise<void>; onCancel: () => Promise<void>;
}) {
  const zh = language === 'zh';
  const question = interaction.questions?.[0];
  const promptId = useId();
  const key = JSON.stringify([interaction.sessionId, interaction.id]);
  const [draft, setDraft] = useState(() => drafts.get(key) ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const submit = async (answer?: InteractionReplyAnswer) => {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      if (answer) await onReply([answer]); else await onCancel();
      drafts.delete(key);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { submitting.current = false; setBusy(false); }
  };
  return <section className="interaction-dialog interaction-card solution-selection-card" data-no-floating-input="true"
    role="group" aria-labelledby={promptId} aria-busy={busy}>
    <header><Lightbulb size={15} aria-hidden="true"/><span>Solution Selection</span>
      <button type="button" aria-label={zh ? '取消方案选择' : 'Dismiss solution selection'} title={zh ? '取消方案选择' : 'Dismiss solution selection'} disabled={busy} onClick={() => void submit()}><X size={15}/></button>
    </header>
    <p className="solution-selection-prompt" id={promptId}>{question?.question}</p>
    <div className="solution-selection-options">
      {question?.options.slice(0, 3).map((option, index) => <button key={option.id} type="button" disabled={busy}
        onClick={() => void submit({ questionId: question.id, selectedOptionId: option.id })}>
        <span className="solution-selection-number" aria-hidden="true">{index + 1}</span><span>{option.label}</span><ArrowRight size={15} aria-hidden="true"/>
      </button>)}
    </div>
    <form className="solution-selection-custom" onSubmit={event => { event.preventDefault(); if (draft.trim() && question) void submit({ questionId: question.id, text: draft.trim() }); }}>
      <textarea rows={1} maxLength={8000} value={draft} disabled={busy} aria-label={zh ? '填写其他方案' : 'Write another solution'} placeholder={zh ? '或填写其他方案…' : 'Or write another solution…'}
        onChange={event => { const value = event.target.value; setDraft(value); drafts.set(key, value); if (drafts.size > 50) drafts.delete(drafts.keys().next().value!); }}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (draft.trim() && question) void submit({ questionId: question.id, text: draft.trim() }); } }}/>
      <button type="submit" disabled={busy || !draft.trim()} aria-label={zh ? '提交方案' : 'Submit solution'}>{busy ? <LoaderCircle size={16} className="spin"/> : <ArrowUp size={16}/>}</button>
    </form>
    {error && <p className="solution-selection-error" role="alert">{error}</p>}
  </section>;
}
