import { uiText } from '../../i18n';
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { GripVertical, Mic, MicOff, Square, X } from 'lucide-react';
import { VoiceSession, type VoiceState, type VoiceTarget } from './voiceSession';
import { voiceComposerPresentation } from './voiceComposerPresentation';
import { VoiceComposerPanel, VoiceWave } from './VoiceComposerPanel';
import { playDictationCue } from './voiceCue';
import type { DictationUpdate } from './dictationPreview';
import './voice.css';
import './voiceComposer.css';

const VoiceContext = createContext<{ session: VoiceSession; target: VoiceTarget } | null>(null);
export const useVoiceContext = () => useContext(VoiceContext);
const VoiceHostContext = createContext(false);
let applicationSession: VoiceSession | undefined;
export const applicationVoiceSession = () => applicationSession ??= new VoiceSession(window.cardbushDesktop?.voice);
export function ApplicationVoiceHost({ language, children }: { language: string; children: ReactNode }) {
  const session = applicationVoiceSession();
  useEffect(() => () => session.end(), [session]);
  return <VoiceHostContext.Provider value={true}>{children}<UndockedVoiceCall session={session} language={language}/></VoiceHostContext.Provider>;
}
export function VoiceConversation({ target, language, disabled, active = true, children }: { target: VoiceTarget; language: string; disabled?: boolean; active?: boolean; children: ReactNode }) {
  const hosted = useContext(VoiceHostContext);
  const [session] = useState(() => hosted ? applicationVoiceSession() : new VoiceSession(window.cardbushDesktop?.voice));
  const currentTarget = useRef(target);
  useLayoutEffect(() => {
    const previousTarget = currentTarget.current;
    currentTarget.current = target;
    if (active && !disabled) session.update(target);
    else session.releaseRecording(previousTarget);
  }, [session, target, disabled, active]);
  useLayoutEffect(() => () => {
    if (hosted) session.releaseRecording(currentTarget.current);
    else session.end();
  }, [session, hosted]);
  return <VoiceContext.Provider value={disabled || !active ? null : { session, target }}>{children}{!hosted && <UndockedVoiceCall session={session} language={language}/>}</VoiceContext.Provider>;
}

const idle = { mode: 'idle', phase: 'idle', error: '', retryAvailable: false } as const;
const noopSubscribe = () => () => {};
/** Dismissing a notice does not discard audio retained for transcription retry. */
function DictationErrorNotice({ message, language }: { message: string; language: string }) {
  const [visible, setVisible] = useState(true);
  const notice = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!visible) return;
    const dismiss = () => setVisible(false);
    const timer = window.setTimeout(dismiss, 5000);
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !notice.current?.contains(event.target)) dismiss(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); }
    };
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', escape, true);
    return () => { window.clearTimeout(timer); document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', escape, true); };
  }, [visible]);
  if (!visible) return null;
  return <span ref={notice} className="voice-dictation-error">
    <span className="voice-dictation-error-message" role="alert">{message}</span>
    <button type="button" className="voice-dictation-error-close" aria-label={uiText(language)('common.close')} title={uiText(language)('common.close')} onClick={() => setVisible(false)}><X aria-hidden="true"/></button>
  </span>;
}
/** The microphone has one job: insert recognized speech into this input. */
export function VoiceButton({ language, disabled, onTranscript, onTranscriptUpdate }: {
  language: string; disabled?: boolean; onTranscript: (text: string) => void;
  onTranscriptUpdate?: (text: string, update: DictationUpdate) => void;
}) {
  const context = useVoiceContext(), session = context?.session;
  const state = useSyncExternalStore<Pick<VoiceState, 'mode' | 'phase' | 'error' | 'retryAvailable'> & Partial<Pick<VoiceState, 'muted' | 'level'>>>(session?.subscribe ?? noopSubscribe, session?.snapshot ?? (() => idle));
  const [starting, setStarting] = useState(false), sequence = useRef(0);
  const control = useRef<HTMLSpanElement>(null), travel = useRef(0);
  const current = useRef({ context, disabled, onTranscript, onTranscriptUpdate });
  current.current = { context, disabled, onTranscript, onTranscriptUpdate };
  useLayoutEffect(() => {
    sequence.current++; setStarting(false);
    return () => { sequence.current++; };
  }, [session, context?.target.environment, context?.target.sessionId, disabled]);
  const recording = state.mode === 'recording' && Boolean(context && session?.ownsVoice(context.target));
  const error = context && session?.matchesTarget(context.target) && state.mode !== 'call' ? state.error : '';
  const engaged = starting || recording && state.phase !== 'idle' && !error;
  // Requesting a device is cancellable, but is not yet a live recording.
  const active = engaged && !starting && state.phase !== 'connecting';
  const label = uiText(language)(error && state.retryAvailable ? 'voiceConversation.retryTranscription'
    : !engaged ? 'voiceConversation.dictate'
    : state.phase === 'transcribing' ? 'voiceConversation.cancelTranscription'
    : starting || state.phase === 'connecting' ? 'voiceConversation.cancelDictation'
    : 'voiceConversation.finishDictation');
  async function toggle() {
    if (!context || disabled) return;
    if (starting) { sequence.current++; setStarting(false); return; }
    if (recording) {
      if (state.error) state.retryAvailable ? session!.retry() : session!.restart();
      else if (state.phase === 'connecting' || state.phase === 'transcribing') session!.end();
      else session!.finishRecording();
      return;
    }
    if (state.mode !== 'idle') return;
    if (state.error) session!.end();
    const attempt = ++sequence.current;
    const rect = control.current?.getBoundingClientRect(), footer = control.current?.closest('.composer-footer')?.getBoundingClientRect();
    travel.current = rect && footer ? rect.left - footer.left : 0;
    setStarting(true);
    // Play before acquiring the microphone, so the cue cannot enter the transcript.
    await playDictationCue();
    if (attempt !== sequence.current || current.current.disabled || !current.current.context) return;
    session!.update(current.current.context.target);
    void session!.start('recording', text => current.current.onTranscript(text),
      current.current.onTranscriptUpdate ? (text, update) => current.current.onTranscriptUpdate?.(text, update) : undefined);
    setStarting(false);
  }
  const canMute = recording && state.phase === 'recording';
  const micLabel = canMute ? uiText(language)(state.muted ? 'useAssistantActions.unmuteMicrophone' : 'useAssistantActions.muteMicrophone') : label;
  return <span ref={control} className="voice-dictation-control" data-engaged={engaged} data-muted={Boolean(state.muted)} style={{ '--dictation-travel': `${travel.current}px` } as React.CSSProperties}>
    <button type="button" className={`voice-dictation-button${active ? ' is-active' : ''}`} aria-label={label} title={label}
      {...(canMute ? { 'aria-label': micLabel, title: micLabel } : {})}
      aria-pressed={canMute ? Boolean(state.muted) : engaged} aria-busy={starting || recording && (state.phase === 'connecting' || state.phase === 'transcribing')} aria-keyshortcuts={engaged || recording ? 'Escape' : undefined} disabled={!context || disabled || state.mode !== 'idle' && !recording}
      onKeyDown={event => { if (event.key === 'Escape' && (engaged || recording)) { event.preventDefault(); event.stopPropagation(); sequence.current++; setStarting(false); if (recording) session?.end(); } }}
      onClick={() => canMute ? session?.mute() : void toggle()}>{state.muted && engaged ? <MicOff/> : <Mic/>}</button>
    {engaged && <>
      <span className="voice-dictation-signal"><VoiceWave level={state.level ?? 0} quiet={!canMute || Boolean(state.muted)}/></span>
      <button type="button" className="send-button voice-dictation-stop" aria-label={label} title={label}
        onClick={() => void toggle()}><Square size={11} fill="currentColor"/></button>
    </>}
    {error && !starting && <DictationErrorNotice key={error} message={error} language={language}/>}
  </span>;
}

/** Navigation keeps a call alive; its stop control must remain reachable. */
function UndockedVoiceCall({ session, language }: { session: VoiceSession; language: string }) {
  const mode = useSyncExternalStore(session.subscribe, () => session.snapshot().mode);
  const presentation = voiceComposerPresentation(session);
  const docked = useSyncExternalStore(presentation.subscribe, presentation.snapshot);
  const box = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number }>();
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | undefined>(undefined);
  const move = (x: number, y: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (rect) setPosition({ x: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)), y: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)) });
  };
  useEffect(() => {
    const resize = () => { const rect = box.current?.getBoundingClientRect(); if (rect) move(rect.left, rect.top); };
    window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize);
  }, []);
  if (mode !== 'call' || docked) return null;
  return createPortal(<div ref={box} className="voice-call-undocked" style={position ? { left: position.x, top: position.y, right: 'auto', bottom: 'auto' } : undefined}>
    <button type="button" className="voice-call-drag" aria-label={uiText(language)('voiceComposerPanel.moveCall')}
      onPointerDown={event => { if (event.button !== 0) return; const rect = box.current!.getBoundingClientRect(); drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top }; event.currentTarget.setPointerCapture(event.pointerId); event.preventDefault(); }}
      onPointerMove={event => { const start = drag.current; if (start?.id === event.pointerId) move(start.left + event.clientX - start.x, start.top + event.clientY - start.y); }}
      onPointerUp={() => { drag.current = undefined; }} onLostPointerCapture={() => { drag.current = undefined; }} onPointerCancel={() => { drag.current = undefined; }}
      onKeyDown={event => { const delta = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }[event.key]; const rect = box.current?.getBoundingClientRect(); if (delta && rect) { event.preventDefault(); move(rect.left + delta[0], rect.top + delta[1]); } }}><GripVertical/></button>
    <VoiceComposerPanel session={session} language={language}/></div>,
    document.querySelector('.app, .cardling-desktop') ?? document.body);
}
