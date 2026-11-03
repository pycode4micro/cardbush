import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react';
import { uiText, type MessageKey } from '../../i18n';
import { FriendAppearanceEditor, characterLabels } from './FriendAppearanceEditor';
import { FriendTextPages } from './FriendTextPages';
import { introductionSteps, type FriendsState, type IntroductionStep } from './friendsStore';
import type { FriendAppearance } from './friendDesign';
import type { FriendAppearanceGenerator } from './generateFriendAppearance';

const titles: Record<IntroductionStep, MessageKey> = {
  address: 'yourFriends.addressTitle', context: 'yourFriends.contextTitle', judgment: 'yourFriends.judgmentTitle',
  communication: 'yourFriends.communicationTitle', boundaries: 'yourFriends.boundariesTitle', appearance: 'yourFriends.appearanceTitle',
};
const prompts: Record<IntroductionStep, MessageKey> = {
  address: 'yourFriends.addressPrompt', context: 'yourFriends.contextPrompt', judgment: 'yourFriends.judgmentPrompt',
  communication: 'yourFriends.communicationPrompt', boundaries: 'yourFriends.boundariesPrompt', appearance: 'yourFriends.appearancePrompt',
};
const labels: Record<IntroductionStep, MessageKey> = {
  address: 'yourFriends.reviewAddress', context: 'yourFriends.reviewContext', judgment: 'yourFriends.reviewJudgment',
  communication: 'yourFriends.reviewCommunication', boundaries: 'yourFriends.reviewBoundaries', appearance: 'yourFriends.reviewAppearance',
};

export function FriendsOnboarding({ language, state, draft, error, renderInput, onSubmit, onSave, onApply, onFinish, generate }: {
  language: string; state: FriendsState; draft: string; error: string;
  renderInput(submit: () => void): ReactNode; onSubmit(): boolean;
  onSave(update: (current: FriendsState) => FriendsState): boolean;
  onApply(appearance: FriendAppearance): boolean; onFinish(): boolean; generate?: FriendAppearanceGenerator;
}) {
  const t = uiText(language), number = new Intl.NumberFormat(language), step = introductionSteps[state.introduction.step];
  const [boundaryPart, setBoundaryPart] = useState<'before' | 'report' | 'notes'>('before');
  const [reading, setReading] = useState(false), [reviewIndex, setReviewIndex] = useState(0);
  const [profileConfirmed, setProfileConfirmed] = useState(false), [boundaryConfirmed, setBoundaryConfirmed] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'leaving' | 'arriving'>('idle');
  const scene = useRef<HTMLDivElement>(null), phaseRef = useRef(phase), pending = useRef<(() => unknown) | null>(null);
  const changePhase = (value: typeof phase) => { phaseRef.current = value; setPhase(value); };
  const run = (action: () => unknown) => {
    if (phaseRef.current !== 'idle') return;
    pending.current = action; changePhase('leaving');
  };
  const completeTransition = () => {
    if (phaseRef.current === 'leaving') {
      const action = pending.current; pending.current = null;
      changePhase('arriving'); action?.();
    } else if (phaseRef.current === 'arriving') {
      changePhase('idle');
    }
  };
  useEffect(() => {
    if (phase === 'idle') {
      scene.current?.querySelector<HTMLElement>('h1')?.focus();
      return;
    }
    const duration = parseFloat(getComputedStyle(scene.current!).animationDuration) * 1000 || 0;
    const timer = window.setTimeout(completeTransition, duration + 50);
    return () => window.clearTimeout(timer);
  }, [phase]);
  useEffect(() => () => { pending.current = null; }, []);
  useEffect(() => { setBoundaryPart('before'); setReading(false); }, [step]);

  const navigate = (index: number) => onSave(current => ({ ...current, introduction: { ...current.introduction, step: index } }));
  const advance = () => navigate(state.introduction.step + 1);
  const previous = () => {
    if (step === 'boundaries' && boundaryPart !== 'before') setBoundaryPart(boundaryPart === 'notes' ? 'report' : 'before');
    else navigate(state.introduction.step - 1);
  };
  const continueBoundary = () => {
    if (boundaryPart === 'before') setBoundaryPart('report');
    else if (draft.trim()) onSubmit();
    else advance();
  };
  const reviewKey = introductionSteps[reviewIndex];
  const reviewText = reviewKey === 'appearance'
    ? [t('yourFriends.appearanceSummary', { character: state.appearance?.type === 'generated' ? state.appearance.design.name : state.appearance?.type === 'builtin' ? t(characterLabels[state.appearance.character]) : t('yourFriends.designNotGenerated'), motion: t(state.motion ? 'yourFriends.motionOn' : 'yourFriends.motionOff') }), state.introduction.answers.appearance].filter(Boolean).join('\n\n')
    : state.introduction.answers[reviewKey] || t('yourFriends.notShared');
  const title = step === 'boundaries' ? t(boundaryPart === 'before' ? 'yourFriends.actionQuestion' : boundaryPart === 'report' ? 'yourFriends.reportQuestion' : 'yourFriends.boundaryNotesTitle')
    : !step ? t(reading ? 'yourFriends.reviewTitle' : 'yourFriends.readyToBegin') : t(titles[step]);
  const prompt = step === 'boundaries' ? t(boundaryPart === 'notes' ? 'yourFriends.boundaryNotesPrompt' : 'yourFriends.boundaryDraft')
    : !step ? t(reading ? 'yourFriends.reviewPrompt' : 'yourFriends.readyToBeginPrompt') : t(prompts[step]);
  const isQuestion = Boolean(step && step !== 'appearance' && step !== 'boundaries');
  const canFinish = Boolean(state.introduction.answers.context?.trim() && state.appearance && profileConfirmed && boundaryConfirmed);

  return <section className="friends-onboarding" data-screen={step ?? (reading ? 'reading' : 'confirmation')} aria-labelledby="friends-step-title">
    <div className="friends-onboarding-scene" data-phase={phase} ref={scene} inert={phase !== 'idle'}
      onAnimationEnd={event => { if (event.target === event.currentTarget) completeTransition(); }}>
      <div className="friends-onboarding-heading"><h1 id="friends-step-title" tabIndex={-1}>{title}</h1><p className="friends-lead">{prompt}</p></div>
      {isQuestion && <div className="friends-onboarding-question">
        {renderInput(() => run(onSubmit))}
        <button type="button" className="friends-primary friends-send friends-onboarding-next" disabled={!draft.trim()} onClick={() => run(onSubmit)}>{t('yourFriends.keepSelection')}</button>
      </div>}
      {step === 'boundaries' && <div className="friends-onboarding-question friends-boundary-flow" data-part={boundaryPart}>
        {boundaryPart === 'notes' ? renderInput(() => run(continueBoundary)) : <div className="friends-boundary-options" role="radiogroup" aria-label={title}>
          {(boundaryPart === 'before' ? ['ask', 'within-scope'] as const : ['always', 'important'] as const).map(value => <label key={value}>
            <input type="radio" name={boundaryPart} value={value} checked={(boundaryPart === 'before' ? state.delegation.beforeExecution : state.delegation.report) === value}
              onChange={() => onSave(current => ({ ...current, delegation: { ...current.delegation, ...(boundaryPart === 'before' ? { beforeExecution: value as 'ask' | 'within-scope' } : { report: value as 'always' | 'important' }), confirmedAt: undefined } }))}/>
            <span>{t(value === 'ask' ? 'yourFriends.askFirst' : value === 'within-scope' ? 'yourFriends.withinScope' : value === 'always' ? 'yourFriends.reportAlways' : 'yourFriends.reportImportant')}</span>
          </label>)}
        </div>}
        {boundaryPart === 'report' && <button type="button" className="friends-text-button friends-add-boundary-note" onClick={() => run(() => setBoundaryPart('notes'))}>{t('yourFriends.addBoundaryNote')}</button>}
        <button type="button" className="friends-primary friends-onboarding-next friends-boundary-continue" onClick={() => run(continueBoundary)}>{t('yourFriends.keepSelection')}</button>
      </div>}
      {step === 'appearance' && <FriendAppearanceEditor language={language} state={state} generate={generate} onApply={appearance => run(() => onApply(appearance))} onChange={change => onSave(current => ({ ...current, ...change }))}/>}
      {!step && (reading ? <div className="friends-review friends-review-reader" data-section={reviewKey}>
        <div className="friends-review-sections">
          <button type="button" className="friends-icon friends-review-section-previous" disabled={reviewIndex === 0} aria-label={t('yourFriends.previousSection')} onClick={() => run(() => setReviewIndex(index => index - 1))}><ChevronLeft/></button>
          <span>{t('yourFriends.reviewSectionProgress', { section: t(labels[reviewKey]), current: number.format(reviewIndex + 1), total: number.format(introductionSteps.length) })}</span>
          <button type="button" className="friends-icon friends-review-section-next" disabled={reviewIndex === introductionSteps.length - 1} aria-label={t('yourFriends.nextSection')} onClick={() => run(() => setReviewIndex(index => index + 1))}><ChevronRight/></button>
        </div>
        <FriendTextPages key={reviewKey} language={language} text={reviewText}/>
        <div className="friends-review-row"><button type="button" className="friends-text-button friends-review-edit" onClick={() => run(() => { setProfileConfirmed(false); setBoundaryConfirmed(false); return navigate(reviewIndex); })}>{t('yourFriends.edit')}</button></div>
        <button type="button" className="friends-primary friends-review-continue" onClick={() => run(() => setReading(false))}>{t('yourFriends.returnToConfirmation')}</button>
      </div> : <div className="friends-review friends-review-confirmation">
        {!state.introduction.answers.context?.trim() && <p className="your-friends-error">{t('yourFriends.contextRequired')}</p>}
        {!state.appearance && <p className="your-friends-error">{t('yourFriends.designRequired')}</p>}
        <label className="friends-confirm"><input type="checkbox" checked={profileConfirmed} onChange={event => setProfileConfirmed(event.target.checked)}/><span>{t('yourFriends.confirmProfile')}</span></label>
        <label className="friends-confirm"><input type="checkbox" checked={boundaryConfirmed} onChange={event => setBoundaryConfirmed(event.target.checked)}/><span>{t('yourFriends.confirmBoundary')}</span></label>
        <p className="friends-confirmed-boundary">{t('yourFriends.boundarySummary', { before: t(state.delegation.beforeExecution === 'ask' ? 'yourFriends.askFirst' : 'yourFriends.withinScope'), report: t(state.delegation.report === 'always' ? 'yourFriends.reportAlways' : 'yourFriends.reportImportant') })}</p>
        <button type="button" className="friends-primary friends-onboarding-next" disabled={!canFinish} onClick={() => run(onFinish)}>{t('yourFriends.finish')}</button>
        <button type="button" className="friends-text-button friends-review-return" onClick={() => run(() => setReading(true))}>{t('yourFriends.reviewResponses')}</button>
      </div>)}
      {error && <p role="alert" className="your-friends-error friends-onboarding-error">{error}</p>}
      {step && <div className="friends-step-actions">
        {state.introduction.step > 0 && <button type="button" className="friends-text-button" onClick={() => run(previous)}><ArrowLeft/>{t('yourFriends.previous')}</button>}
        {isQuestion && step !== 'context' && <button type="button" className="friends-text-button" onClick={() => run(advance)}>{t('yourFriends.skip')}</button>}
      </div>}
    </div>
    <div className="friends-onboarding-progress" role="progressbar" aria-valuemin={1} aria-valuemax={introductionSteps.length + 1} aria-valuenow={state.introduction.step + 1}
      aria-label={t('yourFriends.introductionProgress', { current: number.format(state.introduction.step + 1), total: number.format(introductionSteps.length + 1) })}>
      {Array.from({ length: introductionSteps.length + 1 }, (_, index) => <i key={index} data-current={index === state.introduction.step} data-complete={index < state.introduction.step}/>)}
    </div>
  </section>;
}
