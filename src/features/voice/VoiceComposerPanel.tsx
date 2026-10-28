import { uiText } from '../../i18n';
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Square } from 'lucide-react';
import type { VoiceSession } from './voiceSession';
import './voiceComposer.css';

/** A single continuous line responds to the microphone or the spoken reply. */
function VoiceWave({ level, speaking, quiet }: { level: number; speaking: boolean; quiet: boolean }) {
  const path = useRef<SVGPathElement>(null), current = useRef({ level, speaking, quiet });
  current.current = { level, speaking, quiet };
  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0, amplitude = 0;
    const draw = (time: number) => {
      const state = current.current;
      const target = state.quiet ? 0 : Math.max(state.level, state.speaking ? .3 : 0);
      amplitude += (Math.min(1, target) - amplitude) * .18;
      const phase = reduced.matches ? 0 : time / 240;
      const points = Array.from({ length: 101 }, (_, i) => {
        const envelope = Math.sin(Math.PI * i / 100) ** 2;
        const wave = Math.sin(i * .22 - phase) * .7 + Math.sin(i * .39 - phase * .7) * .3;
        return `${i ? 'L' : 'M'}${i * 6},${(16 + wave * envelope * amplitude * 13).toFixed(2)}`;
      });
      path.current?.setAttribute('d', points.join(' '));
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, []);
  return <svg className="voice-call-wave" viewBox="0 0 600 32" preserveAspectRatio="none" aria-hidden="true"><path ref={path} d="M0,16 L600,16" vectorEffect="non-scaling-stroke"/></svg>;
}

export function VoiceComposerPanel({ session, language }: { session: VoiceSession; language: string }) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot);
  const error = state.error || state.agentError;
  const connecting = state.phase === 'connecting' || state.reconnecting;
  const audible = state.speaking && !state.outputMuted;
  const label = error || (connecting ? uiText(language)('voiceComposerPanel.connecting') : state.speaking && !state.outputMuted ? uiText(language)('voiceComposerPanel.speaking') : state.muted ? uiText(language)('chatSidebar.microphoneMuted') : state.capturePaused ? uiText(language)('voiceComposerPanel.processingSpeech') : uiText(language)('voiceComposerPanel.listening'));
  return <div className="voice-composer-call" data-connecting={Boolean(connecting)} data-error={Boolean(error)} title={label}>
    <div className="voice-call-signal">
      <VoiceWave level={state.muted || state.capturePaused ? 0 : state.level} speaking={audible} quiet={Boolean(error || connecting || state.muted && !audible)}/>
      {error ? <span className="voice-call-error" role="alert">{error}</span> : <span className="voice-call-status" role="status">{label}</span>}
    </div>
    <button type="button" className="send-button voice-composer-end" aria-label={uiText(language)('voiceComposerPanel.endCall')} title={uiText(language)('voiceComposerPanel.endCall')} onClick={() => session.end()}><Square size={11} fill="currentColor"/></button>
  </div>;
}
