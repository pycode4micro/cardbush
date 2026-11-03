import { useEffect, useRef, useState } from 'react';
import { Check, RotateCcw, Sparkles } from 'lucide-react';
import { uiText, type MessageKey } from '../../i18n';
import { FriendAvatar } from './FriendAvatar';
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
      setCandidate(result);
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : t('yourFriends.designFailed'));
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  };
  const cancel = () => { request.current?.abort(); request.current = null; setBusy(false); setError(''); };
  return <div className="friends-appearance-editor" aria-busy={busy}>
    <div className="friends-generated-preview" data-busy={busy}>
      <FriendAvatar appearance={candidate} state={busy ? 'working' : 'idle'}/>
      <span className="friends-preview">{t(candidate?.type === 'generated' ? 'yourFriends.generatedDesign' : candidate?.type === 'builtin' ? 'yourFriends.builtinDesign' : 'yourFriends.designNotGenerated')}</span>
    </div>
    {candidate?.type === 'generated' && <div className="friends-design-explanation"><h2>{candidate.design.name}</h2><p>{candidate.design.description}</p></div>}
    <label className="friends-design-feedback"><span>{t('yourFriends.designFeedback')}</span>
      <textarea value={feedback} maxLength={2000} onChange={event => setFeedback(event.target.value)} placeholder={t('yourFriends.designFeedbackPlaceholder')} disabled={busy}/>
    </label>
    {error && <p role="alert" className="your-friends-error">{error}</p>}
    {!generate && <p className="your-friends-error">{t('yourFriends.designUnavailable')}</p>}
    <div className="friends-generation-actions">
      <button type="button" className="friends-primary friends-generate" disabled={busy || !generate || !state.introduction.answers.context?.trim()} onClick={() => void create()}>
        {candidate?.type === 'generated' ? <RotateCcw/> : <Sparkles/>}{t(busy ? 'yourFriends.designGenerating' : candidate?.type === 'generated' ? 'yourFriends.designRegenerate' : 'yourFriends.designGenerate')}
      </button>
      {busy && <button type="button" className="friends-text-button friends-generation-cancel" onClick={cancel}>{t('yourFriends.designCancel')}</button>}
      {candidate && !busy && <button type="button" className="friends-primary friends-apply-design" onClick={() => onApply(candidate)}><Check/>{t('yourFriends.useAppearance')}</button>}
    </div>
    <p className="friends-design-note">{t('yourFriends.designModelNotice')}</p>
    <label className="friends-appearance-motion"><input type="checkbox" checked={state.motion} onChange={event => onChange({ motion: event.target.checked })}/>
      <span>{t('yourFriends.motion')}<small>{t('yourFriends.appearanceMotionDescription')}</small></span>
    </label>
    <details className="friends-builtin-options"><summary>{t('yourFriends.useBuiltin')}</summary>
      <p className="friends-design-note">{t('yourFriends.builtinDescription')}</p>
      <div className="friends-characters" role="group" aria-label={t('yourFriends.characterLabel')}>
        {characters.map(character => <button type="button" key={character} data-character={character} disabled={busy}
          aria-pressed={candidate?.type === 'builtin' && candidate.character === character} onClick={() => setCandidate({ type: 'builtin', character })}>
          <FriendAvatar appearance={{ type: 'builtin', character }} preview/><span>{t(characterLabels[character])}</span><Check className="friends-selection-check"/>
        </button>)}
      </div>
      <div className="friends-tones" role="group" aria-label={t('yourFriends.colorLabel')}>
        {tones.map(tone => <button key={tone} type="button" data-tone={tone} aria-pressed={state.tone === tone}
          onClick={() => onChange({ tone })}><i/>{t(toneLabels[tone])}{state.tone === tone && <Check/>}</button>)}
      </div>
    </details>
  </div>;
}
