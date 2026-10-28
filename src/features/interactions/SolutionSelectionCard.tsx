import { uiText } from '../../i18n';
import { useId, useRef, useState } from 'react';
import { ArrowRight, ArrowUp, ChevronLeft, ChevronRight, Lightbulb, LoaderCircle, X } from 'lucide-react';
import type { AppLanguage, InteractionReplyAnswer, PendingInteraction } from '../../types';
import './solutionSelection.css';

// Preserve every answer and the current step when the conversation is hidden.
type Draft = { index: number; answers: InteractionReplyAnswer[] };
const drafts = new Map<string, Draft>();
export function SolutionSelectionCard({ language, interaction, onReply, onCancel }: {
  language: AppLanguage; interaction: PendingInteraction;
  onReply: (answers: InteractionReplyAnswer[]) => Promise<void>; onCancel: () => Promise<void>;
}) {

  const questions = interaction.questions ?? [];
  const multi = questions.length > 1;
  const promptId = useId();
  const key = JSON.stringify([interaction.sessionId, interaction.id]);
  const [draft, setDraft] = useState<Draft>(() => drafts.get(key) ?? { index: 0, answers: [] });
  const question = questions[draft.index];
  const answer = draft.answers.find(answer => answer.questionId === question?.id);
  const text = answer?.text ?? '';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submitting = useRef(false);
  const save = (next: Draft) => {
    setDraft(next); drafts.set(key, next);
    if (drafts.size > 50) drafts.delete(drafts.keys().next().value!);
    setError('');
  };
  const choose = (answer: InteractionReplyAnswer) => {
    save({ ...draft, answers: [...draft.answers.filter(item => item.questionId !== answer.questionId), answer] });
  };
  const answered = (id: string) => {
    const value = draft.answers.find(answer => answer.questionId === id);
    return Boolean(value?.text?.trim() || questions.find(question => question.id === id)?.options.some(option => option.id === value?.selectedOptionId));
  };
  const complete = questions.length > 0 && questions.every(question => answered(question.id));
  const last = draft.index === questions.length - 1;
  const submit = async (answers?: InteractionReplyAnswer[]) => {
    if (submitting.current) return;
    submitting.current = true; setBusy(true); setError('');
    try {
      if (answers) await onReply(answers); else await onCancel();
      drafts.delete(key);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { submitting.current = false; setBusy(false); }
  };
  const advance = () => {
    if (!question || !answered(question.id) || submitting.current) return;
    if (!last) save({ ...draft, index: draft.index + 1 });
    else if (complete) void submit(questions.map(question => draft.answers.find(answer => answer.questionId === question.id)!));
  };
  return <section className="interaction-dialog interaction-card solution-selection-card" data-no-floating-input="true"
    role="group" aria-labelledby={promptId} aria-busy={busy}>
    <header><Lightbulb size={15} aria-hidden="true"/><span>{uiText(language)('solutionSelectionCard.solution_selection')}</span>
      {multi && <nav className="solution-selection-steps" aria-label={uiText(language)('solutionSelectionCard.questionNavigation')}>
        <button type="button" disabled={busy || draft.index === 0} aria-label={uiText(language)('solutionSelectionCard.previousQuestion')}
          onClick={() => save({ ...draft, index: draft.index - 1 })}><ChevronLeft size={15}/></button>
        <span aria-live="polite">{draft.index + 1} / {questions.length}</span>
        <button type="button" disabled={busy || last} aria-label={uiText(language)('solutionSelectionCard.nextQuestion')}
          onClick={() => save({ ...draft, index: draft.index + 1 })}><ChevronRight size={15}/></button>
      </nav>}
      <button type="button" aria-label={uiText(language)('solutionSelectionCard.dismissSolutionSelection')} title={uiText(language)('solutionSelectionCard.dismissSolutionSelection')} disabled={busy} onClick={() => void submit()}><X size={15}/></button>
    </header>
    <p className="solution-selection-prompt" id={promptId}>{question?.question}</p>
    <div className="solution-selection-options">
      {question?.options.slice(0, 3).map((option, index) => <button key={option.id} type="button" disabled={busy}
        aria-pressed={multi ? answer?.selectedOptionId === option.id : undefined}
        onClick={() => { const value = { questionId: question.id, selectedOptionId: option.id }; if (multi) choose(value); else void submit([value]); }}>
        <span className="solution-selection-number" aria-hidden="true">{index + 1}</span><span>{option.label}</span><ArrowRight size={15} aria-hidden="true"/>
      </button>)}
    </div>
    <form className="solution-selection-custom" onSubmit={event => { event.preventDefault(); advance(); }}>
      <textarea rows={1} maxLength={8000} value={text} disabled={busy} aria-label={uiText(language)('solutionSelectionCard.writeAnotherSolution')} placeholder={uiText(language)('solutionSelectionCard.orWriteAnotherSolution')}
        onChange={event => { if (question) choose({ questionId: question.id, text: event.target.value }); }}
        onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); advance(); } }}/>
      {!multi && <button type="submit" disabled={busy || !text.trim()} aria-label={uiText(language)('solutionSelectionCard.submitSolution')}>{busy ? <LoaderCircle size={16} className="spin"/> : <ArrowUp size={16}/>}</button>}
    </form>
    {multi && <footer className="solution-selection-actions">
      <span>{uiText(language)('solutionSelectionCard.answered', { value1: questions.filter(question => answered(question.id)).length, value2: questions.length })}</span>
      <button type="button" disabled={busy || !question || !answered(question.id) || (last && !complete)} onClick={advance}>
        {busy && <LoaderCircle size={14} className="spin"/>}{last ? (uiText(language)('solutionSelectionCard.submitAll')) : (uiText(language)('solutionSelectionCard.next'))}
      </button>
    </footer>}
    {error && <p className="solution-selection-error" role="alert">{error}</p>}
  </section>;
}
