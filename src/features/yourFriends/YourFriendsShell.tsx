import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowLeft, ArrowUp, Check, ChevronRight, Circle, History, Palette, Settings2, Sparkles, X } from 'lucide-react';
import { uiText, type MessageKey } from '../../i18n';
import { ComposerPromptInput, type ComposerPromptInputHandle } from '../composer/ComposerPromptInput';
import { useKeyboardShortcuts } from '../shortcuts/useKeyboardShortcuts';
import { FriendAvatar } from './FriendAvatar';
import { FriendTextPages } from './FriendTextPages';
import { FriendAppearanceEditor, characterLabels } from './FriendAppearanceEditor';
import type { FriendAppearanceGenerator } from './generateFriendAppearance';
import type { FriendAppearance } from './friendDesign';
import { YourFriendsSettings } from './YourFriendsSettings';
import { circleGeometry, confirmFriendIntroduction, introductionSteps, readFriendsDraft, recordFriendEvent, saveFriendsDraft,
  updateFriendsState, useFriendsState, type IntroductionStep } from './friendsStore';
import './yourFriends.css';

const stepTitles: Record<IntroductionStep, MessageKey> = {
  address: 'yourFriends.addressTitle', context: 'yourFriends.contextTitle', judgment: 'yourFriends.judgmentTitle',
  communication: 'yourFriends.communicationTitle', boundaries: 'yourFriends.boundariesTitle', appearance: 'yourFriends.appearanceTitle',
};
const stepPrompts: Record<IntroductionStep, MessageKey> = {
  address: 'yourFriends.addressPrompt', context: 'yourFriends.contextPrompt', judgment: 'yourFriends.judgmentPrompt',
  communication: 'yourFriends.communicationPrompt', boundaries: 'yourFriends.boundariesPrompt', appearance: 'yourFriends.appearancePrompt',
};
const reviewLabels: Record<IntroductionStep, MessageKey> = {
  address: 'yourFriends.reviewAddress', context: 'yourFriends.reviewContext', judgment: 'yourFriends.reviewJudgment',
  communication: 'yourFriends.reviewCommunication', boundaries: 'yourFriends.reviewBoundaries', appearance: 'yourFriends.reviewAppearance',
};
const exampleFile = 'SettingsToolbar.tsx';
const panelTitles: Record<'events' | 'settings' | 'appearance', MessageKey> = {
  events: 'yourFriends.events', settings: 'yourFriends.settings', appearance: 'yourFriends.designAppearance',
};

/** Profile and events stay local; appearance generation explicitly uses the configured model. */
export function YourFriendsShell({ language, origin, onClose, generateAppearance }: {
  language: string; origin?: { x: number; y: number }; onClose(): void; generateAppearance?: FriendAppearanceGenerator;
}) {
  const t = uiText(language), state = useFriendsState(), shortcuts = useKeyboardShortcuts();
  const number = new Intl.NumberFormat(language);
  const name = state.name || t('yourFriends.title'), ready = Boolean(state.introduction.confirmedAt);
  const step = introductionSteps[state.introduction.step];
  const designing = !ready && step === 'appearance';
  const draftScope = ready ? 'event' : step ?? 'review';
  const savedDraft = () => readFriendsDraft(draftScope) ?? (!ready && step ? state.introduction.answers[step] ?? '' : '');
  const [draft, setDraft] = useState(savedDraft), [error, setError] = useState('');
  const [phase, setPhase] = useState<'opening' | 'open' | 'closing'>(origin ? 'opening' : 'open');
  const [geometry, setGeometry] = useState<ReturnType<typeof circleGeometry>>();
  const [panel, setPanel] = useState<keyof typeof panelTitles | null>(null), [selectedId, setSelectedId] = useState('');
  const [relatesTo, setRelatesTo] = useState<string>(), [demoStep, setDemoStep] = useState<number | null>(null);
  const [profileConfirmed, setProfileConfirmed] = useState(false), [boundaryConfirmed, setBoundaryConfirmed] = useState(false);
  const [reviewIndex, setReviewIndex] = useState(0);
  const [reviewConfirming, setReviewConfirming] = useState(false);
  const reviewKey = introductionSteps[reviewIndex];
  const root = useRef<HTMLDivElement>(null), stage = useRef<HTMLDivElement>(null), input = useRef<ComposerPromptInputHandle>(null);
  const titleId = useId(), noticeId = useId(), submitting = useRef(false), close = useRef(onClose);
  const focusInputAfterDialog = useRef(false);
  close.current = onClose;
  const selected = state.events.find(event => event.id === selectedId && !event.archived);
  const related = state.events.find(event => event.id === relatesTo);
  const save = (change: Parameters<typeof updateFriendsState>[0]) => {
    try { updateFriendsState(change); setError(''); return true; } catch { setError(t('yourFriends.saveError')); return false; }
  };
  const applyAppearance = (appearance: FriendAppearance, advance = false) => {
    if (save(current => ({ ...current, appearance, ...(advance ? { introduction: { ...current.introduction, step: introductionSteps.length } } : {}) }))) {
      setPanel(null);
      if (advance) setReviewConfirming(false);
    }
  };

  useLayoutEffect(() => {
    if (!origin || !root.current) return;
    const element = root.current;
    const measure = () => setGeometry(circleGeometry(element.getBoundingClientRect(), origin));
    measure();
    const observer = new ResizeObserver(measure); observer.observe(element);
    return () => observer.disconnect();
  }, [origin]);

  useEffect(() => {
    if (phase === 'open') return;
    const duration = parseFloat(getComputedStyle(root.current!).animationDuration) * 1000 || 0;
    // Transition cleanup still completes if the window is hidden or animationend is lost.
    const timer = window.setTimeout(() => phase === 'closing' ? close.current() : setPhase('open'), duration + 80);
    return () => window.clearTimeout(timer);
  }, [phase]);
  useEffect(() => { root.current?.querySelector<HTMLButtonElement>('.friends-back')?.focus(); }, []);
  // A draft belongs to one question/event, even when navigating backwards or skipping.
  useLayoutEffect(() => { setDraft(savedDraft()); }, [draftScope]);
  useLayoutEffect(() => {
    if (!panel && focusInputAfterDialog.current) { focusInputAfterDialog.current = false; input.current?.focus(); }
  }, [panel]);
  useEffect(() => { stage.current?.scrollTo({ top: 0 }); }, [state.introduction.step, ready, selectedId]);
  useEffect(() => { if (demoStep !== null) root.current?.querySelector('.friends-demo')?.scrollIntoView({ block: 'nearest' }); }, [demoStep]);

  const submit = () => {
    if (submitting.current || !draft.trim() || designing || (!ready && !step)) return;
    if (draft.length > 8000) { setError(t('yourFriends.inputTooLong', { count: number.format(8000) })); return; }
    submitting.current = true;
    try {
      // Clear the persisted draft first: if saving the event fails, restore it below.
      saveFriendsDraft(null, draftScope);
      const event = recordFriendEvent(draft, ready ? undefined : step, relatesTo);
      setSelectedId(event.id); setDraft(''); setRelatesTo(undefined); setError(''); setDemoStep(null);
    } catch {
      try { saveFriendsDraft(draft, draftScope); } catch { /* The visible input remains available to copy. */ }
      setError(t('yourFriends.saveError'));
    } finally { submitting.current = false; }
  };
  const changeDraft = (value: string) => {
    setDraft(value);
    try { saveFriendsDraft(value, draftScope); setError(''); } catch { setError(t('yourFriends.saveError')); }
  };
  const leave = () => { if (phase !== 'closing') setPhase('closing'); };
  const continueIntroduction = () => save(current => ({ ...current, introduction: { ...current.introduction,
    step: current.introduction.step + 1,
  } }));
  const canFinish = Boolean(state.introduction.answers.context?.trim()) && Boolean(state.appearance) && profileConfirmed && boundaryConfirmed;
  const transitionStyle = geometry ? {
    '--friend-origin-x': `${geometry.x}px`, '--friend-origin-y': `${geometry.y}px`, '--friend-radius': `${geometry.radius}px`,
  } as CSSProperties : undefined;

  return <div ref={root} className="your-friends" role="dialog" aria-modal="true" aria-labelledby={titleId}
    data-phase={phase} data-tone={state.tone} data-motion={state.motion} data-ready={ready} data-designing={designing} data-step={step ?? 'review'} data-active-panel={panel ?? 'none'} style={transitionStyle}
    onAnimationEnd={event => { if (event.target === event.currentTarget) { if (phase === 'closing') onClose(); else setPhase('open'); } }}
    onKeyDown={event => {
      if (panel || event.nativeEvent.isComposing) return;
      if (event.key === 'Escape') { event.stopPropagation(); leave(); }
      if (event.key === 'Tab') {
        const controls = Array.from(root.current!.querySelectorAll<HTMLElement>('button:not(:disabled),textarea:not(:disabled),input:not(:disabled),select,summary,[tabindex="0"]')).filter(node => node.getClientRects().length);
        const first = controls[0], last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    }}>
    <header className="friends-header">
      <button className="friends-icon friends-back" type="button" onClick={leave} aria-label={t('yourFriends.back')} title={t('yourFriends.back')}><ArrowLeft/></button>
      <div className="friends-brand"><span id={titleId}>{name}</span><span className="friends-preview">{t('yourFriends.preview')}</span></div>
      <nav aria-label={t('yourFriends.navigation')}>
        <button type="button" className="friends-icon" data-panel="appearance" disabled={designing} onClick={() => setPanel('appearance')} aria-label={t('yourFriends.designAppearance')} title={t('yourFriends.designAppearance')}><Palette/></button>
        <button type="button" className="friends-icon" data-panel="events" onClick={() => setPanel('events')} aria-label={t('yourFriends.events')} title={t('yourFriends.events')}><History/></button>
        <button type="button" className="friends-icon" data-panel="settings" onClick={() => setPanel('settings')} aria-label={t('yourFriends.settings')} title={t('yourFriends.settings')}><Settings2/></button>
      </nav>
    </header>
    <div className="friends-stage" ref={stage}>
      <div className="friends-story">
        {ready && <div className="friends-companion"><FriendAvatar appearance={state.appearance} state={draft ? 'listening' : demoStep !== null && demoStep < 2 ? 'working' : 'done'}/>
          <span className="friends-presence"><i/>{t(ready ? 'yourFriends.here' : 'yourFriends.gettingAcquainted')}</span></div>}
        {!ready ? <section className="friends-introduction" aria-labelledby="friends-step-title">
          <div className="friends-eyebrow">{t('yourFriends.introductionProgress', { current: number.format(state.introduction.step + 1), total: number.format(introductionSteps.length + 1) })}</div>
          <h1 id="friends-step-title">{t(step ? stepTitles[step] : 'yourFriends.reviewTitle')}</h1>
          <p className="friends-lead">{t(step ? stepPrompts[step] : 'yourFriends.reviewPrompt')}</p>
          {step === 'address' && <p className="friends-aside">{t('yourFriends.interviewNote')}</p>}
          {step === 'boundaries' && <div className="friends-card friends-boundaries">
            <label><span>{t('yourFriends.beforeLabel')}</span><select aria-label={t('yourFriends.beforeLabel')} value={state.delegation.beforeExecution}
              onChange={event => save(current => ({ ...current, delegation: { ...current.delegation, beforeExecution: event.target.value as 'ask' | 'within-scope', confirmedAt: undefined } }))}>
              <option value="ask">{t('yourFriends.askFirst')}</option><option value="within-scope">{t('yourFriends.withinScope')}</option></select></label>
            <label><span>{t('yourFriends.reportLabel')}</span><select aria-label={t('yourFriends.reportLabel')} value={state.delegation.report}
              onChange={event => save(current => ({ ...current, delegation: { ...current.delegation, report: event.target.value as 'always' | 'important', confirmedAt: undefined } }))}>
              <option value="always">{t('yourFriends.reportAlways')}</option><option value="important">{t('yourFriends.reportImportant')}</option></select></label>
            <p>{t('yourFriends.boundaryDraft')}</p>
          </div>}
          {designing && <FriendAppearanceEditor language={language} state={state} generate={generateAppearance} onApply={appearance => applyAppearance(appearance, true)} onChange={change => save(current => ({ ...current, ...change }))}/>}
          {!step && <div className="friends-review">
            {!reviewConfirming ? <><div className="friends-review-tabs friends-view-switch" role="group" aria-label={t('yourFriends.reviewSections')}>
              {introductionSteps.map((key, index) => <button type="button" key={key} data-section={key} aria-pressed={reviewIndex === index} onClick={() => setReviewIndex(index)}>{t(reviewLabels[key])}</button>)}
            </div>
            <div className="friends-review-row"><h2>{t(stepTitles[reviewKey])}</h2>
              <button type="button" className="friends-text-button" onClick={() => { setProfileConfirmed(false); setBoundaryConfirmed(false); save(current => ({ ...current, introduction: { ...current.introduction, step: reviewIndex } })); }}>{t('yourFriends.edit')}</button></div>
            <FriendTextPages key={reviewKey} language={language} text={reviewKey === 'appearance'
              ? [t('yourFriends.appearanceSummary', { character: state.appearance?.type === 'generated' ? state.appearance.design.name : state.appearance?.type === 'builtin' ? t(characterLabels[state.appearance.character]) : t('yourFriends.designNotGenerated'), motion: t(state.motion ? 'yourFriends.motionOn' : 'yourFriends.motionOff') }), state.introduction.answers.appearance].filter(Boolean).join('\n\n')
              : state.introduction.answers[reviewKey] || t('yourFriends.notShared')}/>
            <button type="button" className="friends-primary friends-review-continue" onClick={() => setReviewConfirming(true)}>{t('yourFriends.continueReview')}<ChevronRight/></button>
            </> : <div className="friends-review-confirmation">
            <button type="button" className="friends-text-button friends-review-return" onClick={() => setReviewConfirming(false)}><ArrowLeft/>{t('yourFriends.reviewResponses')}</button>
            <p>{t('yourFriends.boundarySummary', { before: t(state.delegation.beforeExecution === 'ask' ? 'yourFriends.askFirst' : 'yourFriends.withinScope'), report: t(state.delegation.report === 'always' ? 'yourFriends.reportAlways' : 'yourFriends.reportImportant') })}</p>
            {!state.introduction.answers.context?.trim() && <p className="your-friends-error">{t('yourFriends.contextRequired')}</p>}
            {!state.appearance && <p className="your-friends-error">{t('yourFriends.designRequired')}</p>}
            <label className="friends-confirm"><input type="checkbox" checked={profileConfirmed} onChange={event => setProfileConfirmed(event.target.checked)}/><span>{t('yourFriends.confirmProfile')}</span></label>
            <label className="friends-confirm"><input type="checkbox" checked={boundaryConfirmed} onChange={event => setBoundaryConfirmed(event.target.checked)}/><span>{t('yourFriends.confirmBoundary')}</span></label>
            <button type="button" className="friends-primary" disabled={!canFinish} onClick={() => { try { confirmFriendIntroduction(); setError(''); setSelectedId(''); } catch { setError(t('yourFriends.saveError')); } }}>{t('yourFriends.finish')}<ChevronRight/></button>
            </div>}
          </div>}
          {(step || !reviewConfirming) && <div className="friends-step-actions">
            {state.introduction.step > 0 && <button className="friends-text-button" type="button" onClick={() => save(current => ({ ...current, introduction: { ...current.introduction, step: current.introduction.step - 1 } }))}><ArrowLeft/>{t('yourFriends.previous')}</button>}
            {step && !designing && (step !== 'context' || Boolean(state.introduction.answers.context?.trim())) && <button className="friends-text-button" type="button" onClick={continueIntroduction}>{t(step === 'boundaries' ? 'yourFriends.keepSelection' : 'yourFriends.skip')}<ChevronRight/></button>}
          </div>}
        </section> : <section className="friends-event-stage" aria-live="polite">
          <h1>{t(selected ? 'yourFriends.receivedTitle' : 'yourFriends.readyTitle', { name })}</h1>
          <p className="friends-lead">{t(selected ? 'yourFriends.receivedDescription' : 'yourFriends.readyDescription')}</p>
          {selected && <div className="friends-card friends-receipt"><span className="friends-status"><Circle/>{t('yourFriends.recorded')}</span><p>{t('yourFriends.eventSaved', { time: new Intl.DateTimeFormat(language, { hour: 'numeric', minute: '2-digit' }).format(new Date(selected.createdAt)) })}</p><button type="button" className="friends-text-button" onClick={() => setPanel('events')}>{t('yourFriends.viewEvent')}<ChevronRight/></button></div>}
          {demoStep === null ? <button className="friends-demo-invite" type="button" onClick={() => setDemoStep(0)}><Sparkles/><span>{t('yourFriends.tryDemo')}</span><ChevronRight/></button> : <div className="friends-card friends-demo">
            <span className="friends-preview">{t('yourFriends.example')}</span><h2>{t('yourFriends.demoTitle')}</h2><p>{t('yourFriends.demoDisclosure')}</p>
            <ol className="friends-flow">{(['yourFriends.demoLocate', 'yourFriends.demoChange', 'yourFriends.demoVerify'] as const).map((key, index) => <li key={key} data-complete={index <= demoStep}>{index <= demoStep ? <Check/> : <Circle/>}{t(key)}</li>)}</ol>
            <p className="friends-demo-conclusion">{t((['yourFriends.demoLocateResult', 'yourFriends.demoChangeResult', 'yourFriends.demoVerifyResult'] as const)[demoStep])}</p>
            {demoStep >= 1 && <div className="friends-artifact"><span>{exampleFile}</span><pre><code><span className="friends-deletion">{'− const title = defaultMessages.settings;\n'}</span><span className="friends-addition">{"+ const title = t('settings.title');"}</span></code></pre></div>}
            <div className="friends-step-actions">{demoStep < 2 && <button type="button" className="friends-primary" onClick={() => setDemoStep(demoStep + 1)}>{t('yourFriends.demoNext')}<ChevronRight/></button>}
              <button type="button" className="friends-text-button" onClick={() => setDemoStep(null)}>{t('yourFriends.closeExample')}</button></div>
          </div>}
        </section>}
      </div>
    </div>
    <footer className="friends-input-dock">
      <div className="friends-input-inner">
        {related && <div className="friends-relation"><span>{t('yourFriends.continuing', { text: related.text })}</span><button type="button" className="friends-icon" aria-label={t('yourFriends.removeRelation')} onClick={() => setRelatesTo(undefined)}><X/></button></div>}
        {error && <p role="alert" className="your-friends-error">{error}</p>}
        {(ready || (step && !designing)) && <div className="friends-input-surface">
          <ComposerPromptInput ref={input} language={language} plugins={[]} richReferences={false} value={draft}
            ariaLabel={t('yourFriends.inputLabel')} ariaDescribedBy={noticeId} placeholder={t('yourFriends.inputPlaceholder')}
            onChange={changeDraft} onSelectionChange={() => {}} onKeyDown={event => {
              if (event.nativeEvent.isComposing || event.keyCode === 229 || event.repeat) return;
              if (shortcuts.matches('sendMessage', event) || shortcuts.matches('guideNow', event)) { event.preventDefault(); event.stopPropagation(); submit(); }
            }}/>
          <button type="button" className="friends-send" aria-label={t('yourFriends.send')} title={t('yourFriends.send')} disabled={!draft.trim() || (!ready && !step)} onClick={submit}><ArrowUp/></button>
        </div>}
        <p className="friends-footnote" id={noticeId}>{t('yourFriends.previewNotice')}</p>
      </div>
    </footer>
    {panel && <FriendsDialog kind={panel} title={t(panelTitles[panel])} closeLabel={t('yourFriends.close')} onClose={() => setPanel(null)}>
      {panel === 'appearance' ? <>
        {!state.introduction.answers.context?.trim() && <p className="friends-aside">{t('yourFriends.designNeedsContext')}</p>}
        <FriendAppearanceEditor language={language} state={state} generate={generateAppearance} onApply={appearance => applyAppearance(appearance)} onChange={change => save(current => ({ ...current, ...change }))}/>
        {error && <p className="your-friends-error" role="alert">{error}</p>}
      </> : panel === 'settings' ? <><YourFriendsSettings language={language}/><p className="friends-aside">{t('yourFriends.localData')}</p>
        {ready && <button type="button" className="friends-text-button" onClick={() => { save(current => ({ ...current, introduction: { ...current.introduction, step: introductionSteps.length, confirmedAt: undefined } })); setProfileConfirmed(false); setBoundaryConfirmed(false); setReviewConfirming(false); setPanel(null); }}>{t('yourFriends.reviewIdentity')}</button>}</> : <>
        <p className="friends-aside">{t('yourFriends.eventsDescription')}</p>
        {!state.events.length && <p className="friends-empty">{t('yourFriends.noEvents')}</p>}
        <ol className="friends-event-list">{[...state.events].reverse().map(event => <li key={event.id} data-archived={event.archived}>
          <div className="friends-event-meta"><span>{t(event.archived ? 'yourFriends.archived' : event.kind === 'introduction' ? 'yourFriends.introductionEvent' : 'yourFriends.recorded')}</span><time dateTime={event.createdAt}>{new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(event.createdAt))}</time></div>
          <p>{event.text}</p>{event.relatesTo && <small>{t('yourFriends.relatedEvent', { text: state.events.find(item => item.id === event.relatesTo)?.text || '' })}</small>}
          <div className="friends-event-actions">{ready && !event.archived && <button className="friends-text-button" type="button" onClick={() => { setSelectedId(event.id); setPanel(null); setDemoStep(null); }}>{t('yourFriends.viewEvent')}</button>}
            {ready && <button className="friends-text-button" type="button" onClick={() => { setRelatesTo(event.id); focusInputAfterDialog.current = true; setPanel(null); }}>{t('yourFriends.continue')}</button>}
            <button className="friends-text-button" type="button" onClick={() => save(current => ({ ...current, events: current.events.map(item => item.id === event.id ? { ...item, archived: !item.archived } : item) }))}>{t(event.archived ? 'yourFriends.restore' : 'yourFriends.archive')}</button></div>
        </li>)}</ol>
      </>}
    </FriendsDialog>}
  </div>;
}

function FriendsDialog({ kind, title, closeLabel, onClose, children }: { kind: string; title: string; closeLabel: string; onClose(): void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null), id = useId();
  useLayoutEffect(() => { const element = dialog.current!; element.showModal(); return () => element.close(); }, []);
  return <dialog ref={dialog} className="friends-dialog" data-panel={kind} aria-labelledby={id} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header><h2 id={id}>{title}</h2><button className="friends-icon" type="button" onClick={onClose} aria-label={closeLabel}><X/></button></header>
    <div className="friends-dialog-body">{children}</div>
  </dialog>;
}
