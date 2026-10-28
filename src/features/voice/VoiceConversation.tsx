import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Mic } from 'lucide-react';
import { VoiceSession, type VoiceState, type VoiceTarget } from './voiceSession';
import { voiceComposerPresentation } from './voiceComposerPresentation';
import { VoiceComposerPanel } from './VoiceComposerPanel';
import { playDictationCue } from './voiceCue';
import './voice.css';
import './voiceComposer.css';

const VoiceContext = createContext<{ session: VoiceSession; target: VoiceTarget } | null>(null);
export const useVoiceContext = () => useContext(VoiceContext);
const VoiceHostContext = createContext(false);
let applicationSession: VoiceSession | undefined;
export const applicationVoiceSession = () => applicationSession ??= new VoiceSession(window.cardbushDesktop?.voice);
export function ApplicationVoiceHost({ language, children }: { language: 'zh' | 'en'; children: ReactNode }) {
  const session = applicationVoiceSession();
  useEffect(() => () => session.end(), [session]);
  return <VoiceHostContext.Provider value={true}>{children}<UndockedVoiceCall session={session} language={language}/></VoiceHostContext.Provider>;
}
export function VoiceConversation({ target, language, disabled, active = true, children }: { target: VoiceTarget; language: 'zh' | 'en'; disabled?: boolean; active?: boolean; children: ReactNode }) {
  const hosted = useContext(VoiceHostContext);
  const [session] = useState(() => hosted ? applicationVoiceSession() : new VoiceSession(window.cardbushDesktop?.voice));
  const currentTarget = useRef(target);
  useLayoutEffect(() => {
    currentTarget.current = target;
    if (active && !disabled) session.update(target);
    else session.releaseRecording(target);
  }, [session, target, disabled, active]);
  useLayoutEffect(() => () => {
    if (hosted) session.releaseRecording(currentTarget.current);
    else session.end();
  }, [session, hosted]);
  return <VoiceContext.Provider value={disabled || !active ? null : { session, target }}>{children}{!hosted && <UndockedVoiceCall session={session} language={language}/>}</VoiceContext.Provider>;
}

const idle = { mode: 'idle', phase: 'idle', error: '', retryAvailable: false } as const;
const noopSubscribe = () => () => {};
/** The microphone has one job: insert recognized speech into this input. */
export function VoiceButton({ language, disabled, onTranscript }: {
  language: 'zh' | 'en'; disabled?: boolean; onTranscript: (text: string) => void;
}) {
  const context = useVoiceContext(), session = context?.session, zh = language === 'zh';
  const state = useSyncExternalStore<Pick<VoiceState, 'mode' | 'phase' | 'error' | 'retryAvailable'>>(session?.subscribe ?? noopSubscribe, session?.snapshot ?? (() => idle));
  const [starting, setStarting] = useState(false), sequence = useRef(0);
  const current = useRef({ context, disabled, onTranscript });
  current.current = { context, disabled, onTranscript };
  useLayoutEffect(() => {
    sequence.current++; setStarting(false);
    return () => { sequence.current++; };
  }, [session, context?.target.environment, context?.target.sessionId, disabled]);
  const recording = state.mode === 'recording' && Boolean(context && session?.ownsVoice(context.target));
  const active = starting || recording;
  const label = active ? state.error ? zh ? '重试转写' : 'Retry transcription'
    : state.phase === 'transcribing' ? zh ? '取消转写' : 'Cancel transcription'
    : starting || state.phase === 'connecting' ? zh ? '取消录音' : 'Cancel dictation'
    : zh ? '结束录音并转写' : 'Finish dictation'
    : zh ? '语音转写' : 'Dictate';
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
    const attempt = ++sequence.current;
    setStarting(true);
    // Play before acquiring the microphone, so the cue cannot enter the transcript.
    await playDictationCue();
    if (attempt !== sequence.current || current.current.disabled || !current.current.context) return;
    setStarting(false);
    session!.update(current.current.context.target);
    void session!.start('recording', text => current.current.onTranscript(text));
  }
  return <span className="voice-dictation-control">
    <button type="button" className={`voice-dictation-button${active ? ' is-active' : ''}`} aria-label={label} title={label}
      aria-pressed={active} aria-keyshortcuts={active ? 'Escape' : undefined} disabled={!context || disabled || state.mode !== 'idle' && !recording}
      onKeyDown={event => { if (event.key === 'Escape' && active) { event.preventDefault(); event.stopPropagation(); sequence.current++; setStarting(false); if (recording) session?.end(); } }}
      onClick={() => void toggle()}><Mic size={17} strokeWidth={1.7}/></button>
    {recording && state.error && <span className="voice-dictation-error" role="alert">{state.error}</span>}
  </span>;
}

/** Navigation keeps a call alive; its stop control must remain reachable. */
function UndockedVoiceCall({ session, language }: { session: VoiceSession; language: 'zh' | 'en' }) {
  const mode = useSyncExternalStore(session.subscribe, () => session.snapshot().mode);
  const presentation = voiceComposerPresentation(session);
  const docked = useSyncExternalStore(presentation.subscribe, presentation.snapshot);
  if (mode !== 'call' || docked) return null;
  return createPortal(<div className="voice-call-undocked"><VoiceComposerPanel session={session} language={language}/></div>,
    document.querySelector('.app, .cardling-desktop') ?? document.body);
}
