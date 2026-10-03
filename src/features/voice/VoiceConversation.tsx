import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Mic, MicOff, Phone, PhoneOff, Settings2, Square, X, Minus, GripHorizontal, LoaderCircle, ArrowUp, RotateCcw } from 'lucide-react';
import { VoiceSession, type VoiceTarget } from './voiceSession';
import { VoiceSettingsPanel } from './VoiceSettingsPanel';
import { useVoicePosition } from './useVoicePosition';
import './voice.css';

const VoiceContext = createContext<VoiceSession | null>(null);
export function VoiceConversation({ target, language, disabled, children }: { target: VoiceTarget; language: 'zh' | 'en'; disabled?: boolean; children: ReactNode }) {
  const [session] = useState(() => new VoiceSession(window.cardbushDesktop?.voice));
  useLayoutEffect(() => { session.update(target); if (disabled) session.end(); }, [session, target, disabled]);
  useEffect(() => () => session.end(), [session]);
  return <VoiceContext.Provider value={disabled ? null : session}>{children}<VoiceOverlay session={session} language={language} /></VoiceContext.Provider>;
}

/** The pointer gesture has a single outcome: long press never also records on release. */
export function VoiceButton({ language, disabled, className = 'send-button', callOnly = false }: { language: 'zh' | 'en'; disabled?: boolean; className?: string; callOnly?: boolean }) {
  const session = useContext(VoiceContext), zh = language === 'zh';
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), held = useRef(false), origin = useRef<{ x: number; y: number } | undefined>(undefined);
  const clear = () => { clearTimeout(timer.current); timer.current = undefined; };
  useEffect(() => clear, []);
  if (!session) return null;
  const label = callOnly ? zh ? '语音通话' : 'Voice call' : zh ? '单击录音，长按语音通话' : 'Click to record; hold for a voice call';
  return <button type="button" className={className} disabled={disabled} title={label} aria-label={label}
    onPointerDown={event => {
      if (event.button !== 0 || callOnly) return;
      held.current = false; origin.current = { x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
      timer.current = setTimeout(() => { held.current = true; void session.start('call'); }, 500);
    }}
    onPointerMove={event => { if (origin.current && Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > 16) { clear(); held.current = true; } }}
    onPointerUp={clear} onPointerCancel={() => { clear(); held.current = true; }} onLostPointerCapture={clear}
    onContextMenu={event => event.preventDefault()}
    onClick={() => { clear(); if (held.current) { held.current = false; return; } void session.start(callOnly ? 'call' : 'recording'); }}>
    {callOnly ? <Phone size={15} /> : <Mic size={16} />}
  </button>;
}

function VoiceOverlay({ session, language }: { session: VoiceSession; language: 'zh' | 'en' }) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot), zh = language === 'zh';
  const [settings, setSettings] = useState(false), [elapsed, setElapsed] = useState(0);
  const [minimized, setMinimized] = useState(true), [review, setReview] = useState('');
  const open = state.mode !== 'idle' && !minimized;
  const floating = useVoicePosition(state.mode !== 'idle', minimized ? 'mini' : settings ? 'settings' : state.mode);
  const panel = floating.ref, returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => { if (state.mode === 'idle') setMinimized(true); }, [state.mode]);
  useEffect(() => { setReview(state.reviewText); }, [state.reviewText]);
  useEffect(() => { if (state.background) setMinimized(true); }, [state.background]);
  useEffect(() => {
    if (state.mode === 'idle') return;
    const tick = () => setElapsed(Math.floor((Date.now() - state.startedAt) / 1000));
    tick(); const timer = window.setInterval(tick, 1000); return () => clearInterval(timer);
  }, [state.mode, state.startedAt]);
  const configure = (value: boolean) => { session.setSettingsOpen(value); setSettings(value); };
  useEffect(() => {
    if (!open) { if (settings) session.setSettingsOpen(false); setSettings(false); return; }
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    return () => { returnFocus.current?.isConnected && returnFocus.current.focus(); };
  }, [open, state.startedAt]);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && panel.current?.contains(document.activeElement)) { event.preventDefault(); if (settings) { session.setSettingsOpen(false); setSettings(false); } else setMinimized(true); }
      if (event.key === 'Tab' && settings) {
        const nodes = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary') ?? [])];
        if (!nodes.length) return;
        const next = nodes[(nodes.indexOf(document.activeElement as HTMLElement) + (event.shiftKey ? nodes.length - 1 : 1)) % nodes.length];
        event.preventDefault(); next.focus();
      }
    };
    window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close);
  }, [open, session, settings, state.mode]);
  if (state.mode === 'idle') return null;
  const agentStatus = state.agentWaiting ? zh ? '等待你的操作' : 'Waiting for you' : state.agentWorking ? zh ? 'Agent 正在执行' : 'Agent working' : '';
  const duration = Math.floor(elapsed / 60) + ':' + String(elapsed % 60).padStart(2, '0');
  const miniStatus = state.error ? zh ? '语音需要处理' : 'Voice needs attention' : state.reviewText ? zh ? '识别待确认' : 'Review speech' :
    state.phase === 'connecting' ? zh ? '正在连接' : 'Connecting' : state.phase === 'idle' ? zh ? '语音未启动' : 'Voice not started' :
    state.phase === 'transcribing' || state.capturePaused ? zh ? '正在转文字' : 'Transcribing' : state.phase === 'submitting' ? zh ? '正在提交' : 'Submitting' :
    state.mode === 'recording' ? state.phase === 'recorded' ? zh ? '待发送' : 'Ready to send' : zh ? '正在录音' : 'Recording' :
    state.speaking ? zh ? '正在播报' : 'Speaking' : agentStatus || (state.muted ? zh ? '已静音' : 'Muted' : zh ? '正在聆听' : 'Listening');
  const canSendRecording = state.mode === 'recording' && !state.background && ['recording', 'recorded'].includes(state.phase);
  if (minimized) return createPortal(<div className="voice-mini" ref={panel} style={floating.style} aria-label={zh ? '语音悬浮按钮' : 'Floating voice control'}>
    <span className="voice-drag-handle" {...floating.handlers} tabIndex={0} aria-label={zh ? '移动语音按钮' : 'Move voice control'}><GripHorizontal size={14}/></span>
    {state.mode === 'call' ? <button type="button" aria-label={zh ? '麦克风静音' : 'Mute microphone'} aria-pressed={state.muted}
      disabled={state.phase === 'connecting' || state.phase === 'idle'} onClick={() => session.mute()}>{state.muted ? <MicOff size={17}/> : <Mic size={17}/>}</button> :
      <Mic size={17} className={state.phase === 'recording' ? 'voice-recording-mark' : ''} aria-hidden="true"/>}
    <button type="button" className="voice-mini-restore" onClick={() => setMinimized(false)} title={state.error || (zh ? '展开详情' : 'Show details')}
      aria-label={zh ? state.mode === 'call' ? '展开语音通话' : '展开录音详情' : state.mode === 'call' ? 'Expand voice call' : 'Expand recording'}>
      <span className="voice-mini-status" role="status">{miniStatus}</span>{state.mode === 'recording' && <small>{duration}</small>}
    </button>
    {canSendRecording && !state.error && <button type="button" className="voice-mini-send" aria-label={zh ? '发送录音' : 'Send recording'} title={zh ? '发送录音' : 'Send recording'} onClick={() => session.finishRecording()}><ArrowUp size={17}/></button>}
    {state.speaking && <button type="button" aria-label={zh ? '停止播报' : 'Stop speaking'} title={zh ? '停止播报' : 'Stop speaking'} onClick={() => session.interrupt()}><Square size={15}/></button>}
    {state.error && <button type="button" aria-label={zh ? state.retryAvailable ? '重试发送' : '重新开始' : state.retryAvailable ? 'Retry send' : 'Start again'}
      onClick={() => state.retryAvailable ? session.retry() : session.restart()}><RotateCcw size={16}/></button>}
    <button type="button" aria-label={zh ? state.mode === 'call' ? '结束通话' : '取消录音' : state.mode === 'call' ? 'End call' : 'Cancel recording'} className="voice-end" onClick={() => session.end()}>
      {state.mode === 'call' ? <PhoneOff size={16}/> : <X size={16}/>}</button>
  </div>, document.body);
  if (!open) return null;
  const status = state.phase === 'connecting' ? zh ? '正在连接麦克风…' : 'Connecting microphone…' :
    state.phase === 'idle' ? zh ? '语音未启动' : 'Voice not started' : state.phase === 'recorded' ? zh ? '录音已结束' : 'Recording ready' :
    state.phase === 'submitting' ? zh ? '正在提交消息…' : 'Submitting message…' : state.phase === 'transcribing' ? zh ? '正在转文字…' : 'Transcribing…' : state.mode === 'recording' ? zh ? '正在录音' : 'Recording' :
    state.speaking ? zh ? '语音回复中，可以插话' : 'Voice reply — you can interrupt' : state.muted ? zh ? '麦克风已静音' : 'Microphone muted' : zh ? '正在聆听' : 'Listening';
  return createPortal(<div className={`voice-overlay ${!settings ? 'voice-call-overlay' : ''}`}>
    <div className={`voice-dialog${settings ? ' voice-settings-dialog' : ''}`} style={floating.style} role="dialog" aria-modal={settings} aria-label={zh ? '语音' : 'Voice'} tabIndex={-1} ref={panel}>
      <div className="voice-dialog-title voice-drag-handle" {...floating.handlers} tabIndex={0} aria-label={zh ? '拖动语音窗口' : 'Move voice window'}><strong>{settings ? zh ? '语音设置' : 'Voice settings' : state.mode === 'call' ? zh ? '语音通话' : 'Voice call' : zh ? '录音转文字' : 'Voice message'}</strong>
        <div className="voice-window-actions">{!settings && <button type="button" aria-label={zh ? '收起为悬浮按钮' : 'Minimize voice call'} onClick={() => setMinimized(true)}><Minus size={16}/></button>}
        <button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={() => settings ? configure(false) : session.end()}><X size={16} /></button></div>
      </div>
      {settings ? <VoiceSettingsPanel language={language} /> : <>
        <div className="voice-level" aria-hidden="true">{[.45, .7, 1, .65, .9, .6, .4].map((scale, i) => <i key={i} style={{ height: `${6 + state.level * scale * 34}px` }} />)}</div>
        <div className="voice-status" role="status">{status} · {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</div>
        {state.transcript && <p className="voice-transcript"><small>{zh ? '你说' : 'You'}</small>{state.transcript}</p>}
        {state.mode === 'call' && (agentStatus || state.spokenText) && <div className="voice-agent-progress" aria-live="polite">
          {agentStatus && <div className="voice-agent-status">{state.agentWorking && !state.agentWaiting && <LoaderCircle size={14}/>}<strong>{agentStatus}</strong></div>}
          {state.activity && state.agentWorking && <p>{state.activity}</p>}
          {state.spokenText && (!state.agentWorking || state.spokenText !== state.activity) && <p className="voice-reply-preview">{state.spokenText}</p>}
        </div>}
        {state.capturePaused && <p className="voice-help" role="status">{zh ? `正在处理 ${state.queuedClips} 段录音，处理后继续聆听。` : `Processing ${state.queuedClips} recordings; listening resumes afterwards.`}</p>}
        {state.reviewText && <div className="voice-review"><label>{zh ? '识别内容待确认' : 'Review speech'}<input aria-label={zh ? '确认识别内容' : 'Review transcript'} value={review} onChange={event => setReview(event.target.value)}/></label>
          <button type="button" disabled={!review.trim() || state.queuedClips >= 3} onClick={() => session.review(review)}>{zh ? '发送' : 'Send'}</button><button type="button" onClick={() => session.review('')}>{zh ? '忽略' : 'Dismiss'}</button></div>}
        {state.error && <p role="alert" className="voice-error">{state.error}</p>}
        <div className="voice-actions">
          {state.phase === 'idle' && <button type="button" onClick={() => session.restart()}>{zh ? '重新开始' : 'Start again'}</button>}
          {state.mode === 'call' && <>
            <button type="button" disabled={state.phase === 'connecting' || state.phase === 'idle'} aria-label={zh ? '麦克风静音' : 'Mute microphone'} aria-pressed={state.muted} onClick={() => session.mute()}>{state.muted ? <MicOff size={16} /> : <Mic size={16} />}</button>
            <button type="button" onClick={() => session.interrupt()} disabled={!state.speaking}><Square size={13} />{zh ? '停止播报' : 'Stop speaking'}</button>
            <select aria-label={zh ? '音色' : 'Voice'} value={state.voice} onChange={event => void session.setVoice(event.target.value as 'male' | 'female')}><option value="female">{zh ? '女声' : 'Female'}</option><option value="male">{zh ? '男声' : 'Male'}</option></select>
          </>}
          {state.mode === 'recording' && <button type="button" disabled={state.background ? !state.retryAvailable : !canSendRecording} onClick={() => state.background ? session.retry() : session.finishRecording()}>{state.error ? zh ? '重试发送' : 'Retry send' : zh ? '发送' : 'Send'}</button>}
          {state.mode === 'call' && state.retryAvailable && <button type="button" disabled={state.phase === 'transcribing'} onClick={() => session.retry()}>{zh ? '重试发送' : 'Retry send'}</button>}
          <button type="button" aria-label={zh ? '语音设置' : 'Voice settings'} onClick={() => configure(true)}><Settings2 size={16} /></button>
          <button type="button" className="voice-end" onClick={() => session.end()}>{state.mode === 'call' ? <PhoneOff size={16} /> : null}{zh ? state.mode === 'call' ? '结束通话' : '取消' : state.mode === 'call' ? 'End call' : 'Cancel'}</button>
        </div>
        <small className="voice-help">{zh ? state.mode === 'call' ? 'AI 生成语音 · 结束通话不会停止 Agent 任务' : '发送后转为文字消息，回复不会自动朗读' : state.mode === 'call' ? 'AI-generated voice · Ending the call keeps Agent tasks running' : 'Sends a text message. Replies are not spoken.'}</small>
      </>}
    </div>
  </div>, document.body);
}
