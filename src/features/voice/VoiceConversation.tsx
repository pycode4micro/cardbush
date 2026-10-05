import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AudioLines, Mic, MicOff, Phone, PhoneOff, Settings2, Square, X, Minus, GripHorizontal, LoaderCircle, ArrowUp, RotateCcw, ShieldCheck, ShieldAlert } from 'lucide-react';
import { VoiceSession, type VoiceTarget } from './voiceSession';
import { VoiceSettingsPanel } from './VoiceSettingsPanel';
import { SettingsDropdown } from '../settings/SettingsDropdown';
import { useVoicePosition } from './useVoicePosition';
import { voiceComposerPresentation, emptyVoiceComposerPresentation } from './voiceComposerPresentation';
import { VoiceComposerPanel } from './VoiceComposerPanel';
import './voice.css';
import './voiceComposer.css';

const VoiceContext = createContext<{session: VoiceSession; target: VoiceTarget} | null>(null);
export const useVoiceContext = () => useContext(VoiceContext);
const VoiceHostContext = createContext(false);
let applicationSession: VoiceSession | undefined;
export const applicationVoiceSession = () => applicationSession ??= new VoiceSession(window.cardbushDesktop?.voice);
export function ApplicationVoiceHost({ language, children }: { language: 'zh' | 'en'; children: ReactNode }) {
  const session = applicationVoiceSession();
  useEffect(() => () => session.end(), [session]);
  return <VoiceHostContext.Provider value={true}>{children}<VoiceOverlay session={session} language={language}/></VoiceHostContext.Provider>;
}
export function VoiceConversation({ target, language, disabled, active = true, children }: { target: VoiceTarget; language: 'zh' | 'en'; disabled?: boolean; active?: boolean; children: ReactNode }) {
  const hosted = useContext(VoiceHostContext);
  const [session] = useState(() => hosted ? applicationVoiceSession() : new VoiceSession(window.cardbushDesktop?.voice));
  const currentTarget = useRef(target);
  useLayoutEffect(() => {
    currentTarget.current = target;
    // Retained background views must not take ownership of another view's recording.
    if (active && !disabled) session.update(target);
    else session.releaseRecording(target);
  }, [session, target, disabled, active]);
  useLayoutEffect(() => () => {
    if (hosted) session.releaseRecording(currentTarget.current);
    else session.end();
  }, [session, hosted]);
  return <VoiceContext.Provider value={disabled || !active ? null : {session, target}}>{children}{!hosted && <VoiceOverlay session={session} language={language} />}</VoiceContext.Provider>;
}

/** The pointer gesture has a single outcome: long press never also records on release. */
export function VoiceButton({ language, disabled, className = 'send-button', callOnly = false }: { language: 'zh' | 'en'; disabled?: boolean; className?: string; callOnly?: boolean }) {
  const context = useContext(VoiceContext), session = context?.session, zh = language === 'zh';
  const presentation = session ? voiceComposerPresentation(session) : emptyVoiceComposerPresentation;
  const mode = useSyncExternalStore(session?.subscribe ?? presentation.subscribe, () => session?.snapshot().mode ?? 'idle');
  const voiceActive = mode !== 'idle';
  const [pressing, setPressing] = useState(false);
  const start = (mode: 'call' | 'recording', button: HTMLButtonElement) => {
    if (!context) return;
    if (context.session.snapshot().mode !== 'idle') {
      if (context.session.ownsVoice(context.target) && presentation.snapshot().docked) presentation.setText(false);
      else presentation.showDetails();
      return;
    }
    presentation.origin(button); context.session.update(context.target); void context.session.start(mode);
  };
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined), held = useRef(false), origin = useRef<{ x: number; y: number } | undefined>(undefined);
  const clear = () => { clearTimeout(timer.current); timer.current = undefined; setPressing(false); };
  useEffect(() => {
    setPressing(false); held.current = false;
    return () => { clearTimeout(timer.current); timer.current = undefined; origin.current = undefined; held.current = true; };
  }, [session, context?.target.environment, context?.target.sessionId]);
  useEffect(() => { if (disabled) clear(); }, [disabled]);
  if (!session) return null;
  const label = voiceActive ? mode === 'recording' ? zh ? '返回录音面板' : 'Return to recording' : zh ? '返回通话面板' : 'Return to call' : callOnly ? zh ? '语音通话' : 'Voice call' : zh ? '单击录音，长按语音通话' : 'Click to record; hold for a voice call';
  return <button type="button" className={`${className} voice-trigger${pressing ? ' voice-trigger-holding' : ''}${voiceActive ? ' voice-trigger-connected' : ''}`} disabled={disabled} title={label} aria-label={label}
    onPointerDown={event => {
      if (event.button !== 0) return;
      held.current = false;
      if (callOnly || voiceActive) return;
      origin.current = { x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId);
      setPressing(true); const button = event.currentTarget;
      timer.current = setTimeout(() => { held.current = true; setPressing(false); start('call', button); }, 500);
    }}
    onPointerMove={event => { if (origin.current && Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > 16) { clear(); held.current = true; } }}
    onPointerUp={clear} onPointerCancel={() => { clear(); held.current = true; }} onLostPointerCapture={clear}
    onContextMenu={event => event.preventDefault()}
    onBlur={clear}
    onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') held.current = false; }}
    onClick={event => { clear(); if (held.current) { held.current = false; return; } start(callOnly ? 'call' : 'recording', event.currentTarget); }}>
    {voiceActive ? <AudioLines size={16}/> : callOnly ? <Phone size={15} /> : <Mic size={16} />}
    {pressing && <svg className="voice-hold-progress" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="18"/></svg>}
  </button>;
}

function VoiceOverlay({ session, language }: { session: VoiceSession; language: 'zh' | 'en' }) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot), zh = language === 'zh';
  const presentation = voiceComposerPresentation(session), display = useSyncExternalStore(presentation.subscribe, presentation.snapshot);
  const [settings, setSettings] = useState(false), [elapsed, setElapsed] = useState(0);
  const [minimized, setMinimized] = useState(true);
  // Enrollment releases the call microphone. Keep its settings mounted until
  // explicitly closed so recording the voice profile is not cancelled by hangup.
  const open = settings || state.mode === 'call' && !minimized;
  const floating = useVoicePosition(state.mode !== 'idle' || settings, settings ? 'settings' : state.mode === 'recording' ? `recording-${display.docked}-${display.text}` : minimized ? 'mini' : state.mode);
  const panel = floating.ref, returnFocus = useRef<HTMLElement | null>(null);
  useEffect(() => { if (state.mode === 'idle') setMinimized(true); }, [state.mode]);
  useEffect(() => { if (display.details) setMinimized(false); }, [display.details]);
  useEffect(() => {
    if (state.mode === 'idle') return;
    const tick = () => setElapsed(Math.floor((Date.now() - state.startedAt) / 1000));
    tick(); const timer = window.setInterval(tick, 1000); return () => clearInterval(timer);
  }, [state.mode, state.startedAt]);
  const configure = (value: boolean) => { session.setSettingsOpen(value); setSettings(value); };
  useEffect(() => { if (display.settings) configure(true); }, [display.settings]);
  useEffect(() => {
    if (!open) { if (settings) session.setSettingsOpen(false); setSettings(false); return; }
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.current?.focus();
    return () => { returnFocus.current?.isConnected && returnFocus.current.focus(); };
  }, [open, state.startedAt]);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape' && panel.current?.contains(document.activeElement)) { event.preventDefault(); if (settings) { session.setSettingsOpen(false); setSettings(false); } else setMinimized(true); }
      if (event.key === 'Tab' && settings) {
        const nodes = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),summary,a[href],[tabindex]') ?? [])]
          .filter(node => node.tabIndex >= 0 && node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden');
        if (!nodes.length) return;
        const next = nodes[(nodes.indexOf(document.activeElement as HTMLElement) + (event.shiftKey ? nodes.length - 1 : 1)) % nodes.length];
        event.preventDefault(); next.focus();
      }
    };
    window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close);
  }, [open, session, settings, state.mode]);
  if (state.mode === 'idle' && !settings) return null;
  if (state.mode === 'call' && display.docked && minimized && !settings) return null;
  const agentStatus = state.agentWaiting ? zh ? '等待你的操作' : 'Waiting for you' : state.agentWorking ? state.realtime ? zh ? 'Agent 执行中 · 可以继续说' : 'Agent working · keep talking' : zh ? 'Agent 正在执行' : 'Agent working' : '';
  const collecting = state.mode === 'call' && state.inputPending && !state.inputFinishing && !state.muted && !state.capturePaused && state.phase !== 'submitting';
  const miniStatus = state.error ? zh ? '语音需要处理' : 'Voice needs attention' : state.agentError ? zh ? '任务调用失败 · 仍可通话' : 'Task call failed · keep talking' : state.speakerNotice ? state.speakerNotice :
    state.reconnecting ? zh ? '正在恢复通话' : 'Reconnecting' : state.phase === 'connecting' ? zh ? '正在连接' : 'Connecting' : state.phase === 'idle' ? zh ? '语音未启动' : 'Voice not started' :
    state.inputFinishing ? zh ? '正在整理，准备发送' : 'Preparing your message' : collecting ? zh ? '还在听，可以继续' : 'Listening — take your time' : state.phase === 'transcribing' || state.capturePaused ? zh ? '正在转文字' : 'Transcribing' : state.phase === 'submitting' ? zh ? '正在提交' : 'Submitting' :
    state.speaking ? zh ? '正在播报' : 'Speaking' : state.muted ? zh ? '已静音' : 'Muted' : agentStatus || (zh ? '正在聆听' : 'Listening');
  const canFinishUtterance = state.mode === 'call' && ['listening', 'transcribing'].includes(state.phase) && (!state.muted || state.inputPending) && !state.inputFinishing;
  const lockStatus = state.realtime ? zh ? '实时通话 · Agent 后台执行，可以继续交流' : 'Realtime call · Agent runs in the background; keep talking' : state.speakerLocked ? zh ? '声纹锁定已开启' : 'Speaker lock enabled' : zh ? '未开启声纹锁定，识别完成后自动发送' : 'Speaker lock off — speech sends automatically';
  const finishLabel = state.realtime ? zh ? '说完了，请回复' : 'Finished speaking — reply now' : zh ? '说完了，立即识别' : 'Finished speaking — transcribe now';
  // Keep live theme variables, native control colors and font preferences from the app.
  const portalRoot = document.querySelector('.app, .cardling-desktop') ?? document.body;
  if (state.mode === 'recording' && !settings) {
    if (display.docked && !display.text) return null;
    return createPortal(<div className="voice-floating-composer" ref={panel} style={floating.style} aria-label={zh ? '录音控制' : 'Recording controls'}>
      <VoiceComposerPanel session={session} language={language} leading={<span className="voice-drag-handle" {...floating.handlers} tabIndex={0} aria-label={zh ? '移动语音按钮' : 'Move voice control'}><GripHorizontal size={16}/></span>}/>
    </div>, portalRoot);
  }
  if (minimized && !settings) return createPortal(<div className="voice-mini" ref={panel} style={floating.style} aria-label={zh ? '语音悬浮按钮' : 'Floating voice control'}>
    <span className="voice-drag-handle" {...floating.handlers} tabIndex={0} aria-label={zh ? '移动语音按钮' : 'Move voice control'}><GripHorizontal size={14}/></span>
    {state.mode === 'call' && <button type="button" aria-label={lockStatus} title={lockStatus} onClick={() => configure(true)}>{state.speakerLocked ? <ShieldCheck size={15}/> : <ShieldAlert size={15}/>}</button>}
    <button type="button" aria-label={zh ? '麦克风静音' : 'Mute microphone'} aria-pressed={state.muted}
      disabled={state.phase === 'connecting' || state.phase === 'idle'} onClick={() => session.mute()}>{state.muted ? <MicOff size={17}/> : <Mic size={17}/>}</button>
    <button type="button" className="voice-mini-restore" onClick={() => setMinimized(false)} title={state.error || state.connectionNotice || state.agentError || state.contextNotice || (zh ? '展开详情' : 'Show details')}
      aria-label={zh ? '展开语音通话' : 'Expand voice call'}>
      <span className="voice-mini-status" role="status">{miniStatus}</span>
    </button>
    {canFinishUtterance && !state.error && <button type="button" aria-label={finishLabel} title={finishLabel} onClick={() => session.finishUtterance()}><ArrowUp size={17}/></button>}
    {state.speaking && <button type="button" aria-label={zh ? '停止播报' : 'Stop speaking'} title={zh ? '停止播报' : 'Stop speaking'} onClick={() => session.interrupt()}><Square size={15}/></button>}
    {state.error && <button type="button" aria-label={zh ? state.retryAvailable ? '重试发送' : '重新开始' : state.retryAvailable ? 'Retry send' : 'Start again'}
      onClick={() => state.retryAvailable ? session.retry() : session.restart()}><RotateCcw size={16}/></button>}
    <button type="button" aria-label={zh ? '结束通话' : 'End call'} className="voice-end" onClick={() => session.end()}><PhoneOff size={16}/></button>
  </div>, portalRoot);
  if (!open) return null;
  const status = state.reconnecting ? zh ? '正在恢复通话…' : 'Reconnecting…' : state.phase === 'connecting' ? zh ? '正在连接麦克风…' : 'Connecting microphone…' :
    state.phase === 'idle' ? zh ? '语音未启动' : 'Voice not started' : state.phase === 'recorded' ? zh ? '录音已结束' : 'Recording ready' :
    state.inputFinishing ? zh ? '正在整理，准备发送 · 收音已暂停' : 'Preparing your message · microphone paused' : collecting ? state.realtime ? zh ? '正在聆听，可以继续' : 'Listening — take your time' : zh ? '还在听，可以继续 · 说完后合并发送' : 'Listening — continued speech joins this message' : state.phase === 'submitting' ? zh ? '正在提交消息…' : 'Submitting message…' : state.phase === 'transcribing' ? zh ? '正在转文字…' : 'Transcribing…' :
    state.speaking ? zh ? '语音回复中，可以插话' : 'Voice reply — you can interrupt' : state.muted ? zh ? '麦克风已静音' : 'Microphone muted' : zh ? '正在聆听' : 'Listening';
  return createPortal(<div className={`voice-overlay ${!settings ? 'voice-call-overlay' : ''}`}>
    <div className={`voice-dialog${settings ? ' voice-settings-dialog' : ''}`} style={floating.style} role="dialog" aria-modal={settings} aria-label={zh ? '语音' : 'Voice'} tabIndex={-1} ref={panel}>
      <div className="voice-dialog-title voice-drag-handle" {...floating.handlers} tabIndex={0} aria-label={zh ? '拖动语音窗口' : 'Move voice window'}><strong>{settings ? zh ? '语音设置' : 'Voice settings' : zh ? '语音通话' : 'Voice call'}</strong>
        <div className="voice-window-actions">{!settings && <button type="button" aria-label={zh ? '收起为悬浮按钮' : 'Minimize voice call'} onClick={() => setMinimized(true)}><Minus size={16}/></button>}
        <button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={() => settings ? configure(false) : session.end()}><X size={16} /></button></div>
      </div>
      {settings ? <VoiceSettingsPanel language={language} /> : <>
        <div className="voice-level" aria-hidden="true">{[.45, .7, 1, .65, .9, .6, .4].map((scale, i) => <i key={i} style={{ height: `${6 + state.level * scale * 34}px` }} />)}</div>
        <div className="voice-status" role="status">{status} · {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</div>
        {state.mode === 'call' && <p className="voice-help voice-lock-status">{lockStatus}</p>}
        {(state.draftTranscript || state.transcript) && <p className="voice-transcript"><small>{state.draftTranscript ? zh ? '正在整理 · 尚未发送' : 'Draft · not sent' : zh ? '你说' : 'You'}</small>{state.draftTranscript || state.transcript}</p>}
        {state.mode === 'call' && (agentStatus || state.spokenText) && <div className="voice-agent-progress" aria-live="polite">
          {agentStatus && <div className="voice-agent-status">{state.agentWorking && !state.agentWaiting && <LoaderCircle size={14}/>}<strong>{agentStatus}</strong></div>}
          {state.activity && state.agentWorking && <p>{state.activity}</p>}
          {state.spokenText && (!state.agentWorking || state.spokenText !== state.activity) && <p className="voice-reply-preview">{state.spokenText}</p>}
        </div>}
        {state.capturePaused && <p className="voice-help" role="status">{zh ? `正在处理 ${state.queuedClips} 段录音，处理后继续聆听。` : `Processing ${state.queuedClips} recordings; listening resumes afterwards.`}</p>}
        {state.error && <p role="alert" className="voice-error">{state.error}</p>}
        {state.agentError && <p role="alert" className="voice-error">{state.agentError}</p>}
        {state.contextNotice && <p role="status" className="voice-hint">{state.contextNotice}</p>}
        {state.connectionNotice && <p role="status" className="voice-hint">{state.connectionNotice}</p>}
        <div className="voice-actions">
          {state.phase === 'idle' && <button type="button" onClick={() => session.restart()}>{zh ? '重新开始' : 'Start again'}</button>}
          {state.mode === 'call' && <>
            {canFinishUtterance && <button type="button" onClick={() => session.finishUtterance()} title={finishLabel}><ArrowUp size={14}/>{zh ? '说完了' : 'Transcribe now'}</button>}
            <button type="button" disabled={state.phase === 'connecting' || state.phase === 'idle'} aria-label={zh ? '麦克风静音' : 'Mute microphone'} aria-pressed={state.muted} onClick={() => session.mute()}>{state.muted ? <MicOff size={16} /> : <Mic size={16} />}</button>
            <button type="button" onClick={() => session.interrupt()} disabled={!state.speaking}><Square size={13} />{zh ? '停止播报' : 'Stop speaking'}</button>
            <SettingsDropdown label={zh ? '音色' : 'Voice'} value={state.voice} minMenuWidth={140} onChange={value => void session.setVoice(value as 'male' | 'female')}
              options={[{ value: 'female', label: zh ? '女声' : 'Female' }, { value: 'male', label: zh ? '男声' : 'Male' }]} />
          </>}
          {state.mode === 'call' && state.retryAvailable && <button type="button" disabled={state.phase === 'transcribing'} onClick={() => session.retry()}>{zh ? '重试发送' : 'Retry send'}</button>}
          <button type="button" aria-label={zh ? '语音设置' : 'Voice settings'} onClick={() => configure(true)}><Settings2 size={16} /></button>
          <button type="button" className="voice-end" onClick={() => session.end()}><PhoneOff size={16} />{zh ? '结束通话' : 'End call'}</button>
        </div>
        <small className="voice-help">{zh ? 'AI 生成语音 · 结束通话不会停止 Agent 任务' : 'AI-generated voice · Ending the call keeps Agent tasks running'}</small>
      </>}
    </div>
  </div>, portalRoot);
}
