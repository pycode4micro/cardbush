import { useLayoutEffect, useSyncExternalStore } from 'react';
import { useVoiceContext } from './VoiceConversation';
import { emptyVoiceComposerPresentation, voiceComposerPresentation } from './voiceComposerPresentation';
export { VoiceComposerPanel } from './VoiceComposerPanel';
import './voiceComposer.css';

export function useVoiceComposer(enabled: boolean) {
  const context = useVoiceContext(), session = context?.session;
  const presentation = session ? voiceComposerPresentation(session) : emptyVoiceComposerPresentation;
  // Audio-level updates only redraw the waveform, never the whole text editor.
  const callId = useSyncExternalStore(session?.subscribe ?? presentation.subscribe, () => session?.snapshot().mode === 'call' ? session.snapshot().startedAt : 0);
  const visible = Boolean(enabled && callId && context && session?.ownsCall(context.target));
  useLayoutEffect(() => { if (visible) return presentation.attach(); }, [visible, presentation]);
  return { visible, session };
}
