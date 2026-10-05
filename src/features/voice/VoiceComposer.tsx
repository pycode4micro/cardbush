import { useLayoutEffect, useRef, useSyncExternalStore, type CSSProperties, type RefObject } from 'react';
import { useVoiceContext } from './VoiceConversation';
import { emptyVoiceComposerPresentation, voiceComposerPresentation } from './voiceComposerPresentation';
export { VoiceComposerPanel } from './VoiceComposerPanel';
import './voiceComposer.css';

export function useVoiceComposer(enabled: boolean, surface: RefObject<HTMLDivElement | null>) {
  const context = useVoiceContext(), session = context?.session;
  const presentation = session ? voiceComposerPresentation(session) : emptyVoiceComposerPresentation;
  const display = useSyncExternalStore(presentation.subscribe, presentation.snapshot);
  const callId = useSyncExternalStore(session?.subscribe ?? presentation.subscribe, () => session && session.snapshot().mode !== 'idle' ? session.snapshot().startedAt : 0);
  const ownsVoice = Boolean(enabled && callId && context && session?.ownsVoice(context.target));
  const visible = ownsVoice && (display.callId !== callId || !display.text);
  useLayoutEffect(() => {
    if (!ownsVoice) return;
    presentation.begin(callId); return presentation.attach();
  }, [ownsVoice, callId, presentation]);
  const scope = context ? `${context.target.environment}\0${context.target.sessionId}` : null;
  const previousVoice = useRef({ recording: false, visible: false, scope });
  useLayoutEffect(() => {
    const previous = previousVoice.current;
    previousVoice.current = { recording: session?.snapshot().mode === 'recording', visible, scope };
    if (callId || !enabled || !previous.recording || !previous.visible || previous.scope !== scope) return;
    // Only restore this input's focus. Finishing a hidden view must not take focus
    // from another conversation or a control the user selected during transcription.
    const element = surface.current;
    const canFocus = () => element?.isConnected && (document.activeElement === document.body || element.contains(document.activeElement));
    if (!canFocus()) return;
    const frame = requestAnimationFrame(() => { if (canFocus()) element?.querySelector<HTMLTextAreaElement>('textarea')?.focus({ preventScroll: true }); });
    return () => cancelAnimationFrame(frame);
  }, [callId, visible, scope, session, surface, enabled]);
  const previousHeight = useRef(0), animation = useRef<Animation | null>(null);
  useLayoutEffect(() => {
    const element = surface.current; if (!element) return;
    const observer = new ResizeObserver(() => { if (!animation.current) previousHeight.current = element.getBoundingClientRect().height; });
    previousHeight.current = element.getBoundingClientRect().height; observer.observe(element);
    return () => { observer.disconnect(); animation.current?.cancel(); };
  }, [surface]);
  useLayoutEffect(() => {
    const element = surface.current; if (!element) return;
    animation.current?.cancel(); animation.current = null;
    const next = element.getBoundingClientRect().height, previous = previousHeight.current;
    previousHeight.current = next;
    if (previous && Math.abs(previous - next) > 1 && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const motion = element.animate([{ height: `${previous}px` }, { height: `${next}px` }], { duration: 250, easing: 'cubic-bezier(.22,1,.36,1)' });
      animation.current = motion;
      motion.onfinish = () => { if (animation.current === motion) animation.current = null; };
    }
    if (visible) element.querySelector<HTMLButtonElement>('.voice-composer-return')?.focus({ preventScroll: true });
  }, [visible, surface]);
  return { visible, ownsVoice, session, presentation,
    style: { '--voice-origin-right': `${display.right}px`, '--voice-origin-bottom': `${display.bottom}px` } as CSSProperties };
}
