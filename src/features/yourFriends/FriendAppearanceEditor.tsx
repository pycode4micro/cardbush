import { useEffect, useRef, useState } from 'react';
import { Check, PenTool, RotateCcw } from 'lucide-react';
import { uiText, type MessageKey } from '../../i18n';
import { FriendAvatar } from './FriendAvatar';
import { FriendTextPages } from './FriendTextPages';
import type { FriendsState } from './friendsStore';
import type { FriendAppearance, FriendCharacter } from './friendDesign';
import type { FriendAppearanceGenerator } from './generateFriendAppearance';

const characters: FriendCharacter[] = ['sprout', 'bunny', 'cat'];
const tones = ['lilac', 'peach', 'sage'] as const;
export const characterLabels: Record<FriendCharacter, MessageKey> = {
  sprout: 'yourFriends.characterSprout', bunny: 'yourFriends.characterBunny', cat: 'yourFriends.characterCat',
};
export const toneLabels: Record<FriendsState['tone'], MessageKey> = {
  lilac: 'yourFriends.lilac', peach: 'yourFriends.peach', sage: 'yourFriends.sage',
};
export function FriendAppearanceEditor({ language, state, generate, onApply, onChange }: {
  language: string; state: FriendsState; generate?: FriendAppearanceGenerator;
  onApply(appearance: FriendAppearance): void; onChange(change: Partial<Pick<FriendsState, 'tone' | 'motion'>>): void;
}) {
  const t = uiText(language), [candidate, setCandidate] = useState(state.appearance);
  const [feedback, setFeedback] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [mode, setMode] = useState<'generate' | 'builtin'>('generate'), [explanation, setExplanation] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const request = useRef<AbortController | null>(null), latestState = useRef(state); latestState.current = state;
  useEffect(() => () => { request.current?.abort(); request.current = null; }, []);
  const create = async () => {
    if (request.current || !generate) return;
    if (!state.introduction.answers.context?.trim()) { setError(t('yourFriends.designNeedsContext')); return; }
    const controller = new AbortController(); request.current = controller;
    setBusy(true); setError('');
    const { address, context, judgment, communication } = state.introduction.answers;
    const profile = { address, context, judgment, communication };
    try {
      const result = await generate({ language, profile, feedback, previous: candidate?.type === 'generated' ? candidate.design : undefined }, controller.signal);
      if (request.current !== controller || controller.signal.aborted) return;
      const current = latestState.current.introduction.answers;
      if (JSON.stringify(profile) !== JSON.stringify({ address: current.address, context: current.context, judgment: current.judgment, communication: current.communication })) {
        setError(t('yourFriends.designProfileChanged')); return;
      }
      setCandidate(result); setExplanation(false); setFeedbackOpen(false);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('yourFriends.designFailed'));
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  };
  const cancel = () => { request.current?.abort(); request.current = null; setBusy(false); setError(''); };
  const view = busy ? 'generating' : mode === 'builtin' ? 'presets' : feedbackOpen ? 'preferences' : candidate ? 'preview' : 'prepare';
  const showPreview = Boolean(candidate && !feedbackOpen && (mode === 'generate' || candidate.type === 'builtin'));
  return <div className="friends-appearance-editor" aria-busy={busy} data-mode={mode} data-view={view}>
    <div className="friends-design-workspace" data-has-design={showPreview}>
      <div className="friends-design-step" key={view}>
        {busy ? <div className="friends-generation-status" role="status">
          <p>{t('yourFriends.designGenerating')}</p><div className="friends-generation-progress" aria-hidden="true"><i/></div>
          <button type="button" className="friends-text-button friends-generation-cancel" onClick={cancel}>{t('yourFriends.designCancel')}</button>
        </div> : <>
          {showPreview && candidate && <div className="friends-generated-preview">
            <div className="friends-design-canvas">
              {candidate.type === 'generated' && explanation ? <FriendTextPages text={`${candidate.design.name}\n\n${candidate.design.description}`} language={language}/> : <FriendAvatar appearance={candidate}/>}
            </div>
            <div className="friends-design-explanation">
              <h2>{candidate.type === 'generated' ? candidate.design.name : t(characterLabels[candidate.character])}</h2>
              {candidate.type === 'generated' && <button type="button" className="friends-text-button friends-explanation-toggle" aria-pressed={explanation} onClick={() => setExplanation(value => !value)}>{t(explanation ? 'yourFriends.showArtwork' : 'yourFriends.showDesignNotes')}</button>}
            </div>
          </div>}
          {mode === 'builtin' ? <div className="friends-builtin-options">
            <div className="friends-characters" role="group" aria-label={t('yourFriends.characterLabel')}>
              {characters.map(character => <button type="button" key={character} data-character={character}
                aria-pressed={candidate?.type === 'builtin' && candidate.character === character} onClick={() => { setCandidate({ type: 'builtin', character }); setExplanation(false); }}>
                <FriendAvatar appearance={{ type: 'builtin', character }} preview/><span>{t(characterLabels[character])}</span><Check className="friends-selection-check"/>
              </button>)}
            </div>
            {candidate?.type === 'builtin' && <div className="friends-tones" role="group" aria-label={t('yourFriends.colorLabel')}>
              {tones.map(tone => <button key={tone} type="button" data-tone={tone} aria-pressed={state.tone === tone}
                onClick={() => onChange({ tone })}><i/>{t(toneLabels[tone])}{state.tone === tone && <Check/>}</button>)}
            </div>}
          </div> : feedbackOpen ? <label className="friends-design-feedback"><span>{t('yourFriends.designFeedback')}</span>
            <textarea autoFocus value={feedback} maxLength={2000} onChange={event => setFeedback(event.target.value)} placeholder={t('yourFriends.designFeedbackPlaceholder')}/>
          </label> : !candidate && <p className="friends-design-note">{t('yourFriends.designModelNotice')}</p>}
          {(error || (!generate && mode === 'generate')) && <div role="alert" className="your-friends-error friends-design-error"><FriendTextPages language={language} text={error || t('yourFriends.designUnavailable')}/></div>}
          <div className="friends-generation-actions">
            {mode === 'generate' && (!candidate || feedbackOpen) && <button type="button" className="friends-primary friends-generate" disabled={!generate || !state.introduction.answers.context?.trim()} onClick={() => void create()}>
              {candidate?.type === 'generated' ? <RotateCcw/> : <PenTool/>}{t(candidate?.type === 'generated' ? 'yourFriends.designRegenerate' : 'yourFriends.designGenerate')}
            </button>}
            {candidate && !feedbackOpen && (mode === 'generate' || candidate.type === 'builtin') && <button type="button" className="friends-primary friends-apply-design" onClick={() => onApply(candidate)}>{t('yourFriends.useAppearance')}</button>}
          </div>
          <div className="friends-design-secondary">
            {mode === 'generate' && !feedbackOpen && <button type="button" className="friends-text-button friends-refine-design" onClick={() => { setFeedbackOpen(true); setExplanation(false); }}>{t(candidate ? 'yourFriends.refineAppearance' : 'yourFriends.addDesignPreferences')}</button>}
            {mode === 'generate' && feedbackOpen && <button type="button" className="friends-text-button friends-refine-cancel" onClick={() => setFeedbackOpen(false)}>{t(candidate ? 'yourFriends.showArtwork' : 'yourFriends.cancelPreferences')}</button>}
            {!feedbackOpen && <button type="button" className="friends-text-button friends-design-method" data-mode={mode === 'generate' ? 'builtin' : 'generate'} onClick={() => { setMode(mode === 'generate' ? 'builtin' : 'generate'); setFeedbackOpen(false); }}>{t(mode === 'generate' ? 'yourFriends.useBuiltin' : 'yourFriends.returnToGenerate')}</button>}
          </div>
        </>}
      </div>
    </div>
  </div>;
}
