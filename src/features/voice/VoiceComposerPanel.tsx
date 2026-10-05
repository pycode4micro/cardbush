import { useEffect, useId, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { ArrowUp, Keyboard, Mic, MicOff, PhoneOff, RotateCcw, Settings2, X } from 'lucide-react';
import { voiceComposerPresentation } from './voiceComposerPresentation';
import type { VoiceSession, VoiceState } from './voiceSession';
import './voiceComposer.css';

function voiceStatus(state: VoiceState, zh: boolean) {
  if (state.error) return zh ? '语音需要处理' : 'Voice needs attention';
  if (state.reconnecting) return zh ? '正在恢复通话' : 'Reconnecting';
  if (state.phase === 'connecting') return zh ? state.mode === 'recording' ? '正在准备录音' : '正在接通' : 'Connecting';
  if (state.phase === 'idle') return zh ? '语音未启动' : 'Voice not started';
  if (state.inputFinishing || state.phase === 'transcribing' || state.capturePaused) return zh ? '正在整理语音' : 'Transcribing';
  if (state.phase === 'submitting') return zh ? '正在提交' : 'Sending';
  if (state.mode === 'recording') return state.phase === 'recorded' ? zh ? '待发送' : 'Ready to send' : state.muted ? zh ? '录音已暂停' : 'Recording paused' : zh ? '正在录音' : 'Recording';
  if (state.agentError) return zh ? '任务调用失败 · 仍可通话' : 'Task failed · call continues';
  if (state.muted) return zh ? '麦克风已静音' : 'Microphone muted';
  if (state.speaking) return zh ? '正在回应' : 'Speaking';
  if (state.inputPending) return zh ? '还在听，可以继续' : 'Listening — take your time';
  if (state.agentWaiting) return zh ? '等待你的操作' : 'Waiting for you';
  if (state.agentWorking) return zh ? '任务执行中 · 可以继续说' : 'Working · keep talking';
  return zh ? '正在聆听' : 'Listening';
}

/** One control surface for calls and recordings, docked in either composer or floating. */
export function VoiceComposerPanel({ session, language, onReturnText, leading }: {
  session: VoiceSession; language: 'zh' | 'en'; onReturnText?(): void; leading?: ReactNode;
}) {
  const state = useSyncExternalStore(session.subscribe, session.snapshot), zh = language === 'zh';
  const recording = state.mode === 'recording', presentation = voiceComposerPresentation(session);
  const [expanded, setExpanded] = useState(false), [elapsed, setElapsed] = useState(0), detailsId = useId();
  useEffect(() => {
    if (!recording || state.phase !== 'recording') return;
    const tick = () => setElapsed(Math.floor((Date.now() - state.startedAt) / 1000));
    tick(); const timer = setInterval(tick, 1000); return () => clearInterval(timer);
  }, [recording, state.phase, state.startedAt]);
  const detailOpen = recording && (expanded || Boolean(state.error));
  const status = voiceStatus(state, zh), canSend = recording && ['recording', 'recorded'].includes(state.phase);
  const sendLabel = state.error ? state.retryAvailable ? zh ? '重试发送' : 'Retry send' : zh ? '重新录音' : 'Record again' : zh ? '发送录音' : 'Send recording';
  const endLabel = recording ? zh ? '取消录音' : 'Cancel recording' : zh ? '结束通话' : 'End call';
  return <div className="voice-composer-call" data-mode={state.mode} data-speaking={state.speaking} data-muted={state.muted} data-connecting={state.phase === 'connecting' || state.phase === 'transcribing' || state.phase === 'submitting'} data-error={Boolean(state.error || state.agentError)}>
    {onReturnText ? <button type="button" className="voice-composer-return" aria-label={zh ? '返回文本输入框' : 'Return to text input'} title={zh ? `返回文本输入框 · ${recording ? '录音' : '通话'}继续` : `Return to text input · ${recording ? 'recording' : 'call'} continues`} onClick={() => { presentation.setText(true); onReturnText(); }}>
      <Keyboard size={18}/><span>{zh ? '返回文本输入框' : 'Text input'}</span>
    </button> : leading}
    <button type="button" className="voice-composer-status" aria-label={recording ? zh ? '查看录音状态' : 'Recording status' : zh ? '展开语音通话' : 'Expand voice call'}
      aria-expanded={recording ? detailOpen : undefined} aria-controls={detailOpen ? detailsId : undefined}
      title={state.error || state.connectionNotice || state.agentError || state.contextNotice || (zh ? recording ? '发送后转为文字消息，回复不会自动朗读' : '查看通话详情和设置' : recording ? 'Sends a text message. Replies are not spoken.' : 'Call details and settings')}
      onClick={() => recording ? setExpanded(value => !value) : presentation.showDetails()}>
      <span className="voice-composer-wave" aria-hidden="true">{[.3, .6, .85, 1, .75, .5, .25].map((scale, index) => <i key={index} style={{ '--voice-bar': `${5 + Math.max(.15, state.level) * scale * 23}px`, '--voice-delay': `${-index * .13}s` } as CSSProperties}/>)}</span>
      <span className="voice-composer-caption"><span className="voice-composer-label" role="status">{status}</span>
        {recording && state.phase === 'recording' && <time className="voice-composer-duration">{Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}</time>}</span>
    </button>
    <div className="voice-composer-actions">
      {recording ? <button type="button" className="voice-composer-send" aria-label={sendLabel} title={sendLabel} disabled={!canSend && !(state.error && state.phase === 'idle')}
        onClick={() => state.error ? state.retryAvailable ? session.retry() : session.restart() : session.finishRecording()}>{state.error ? <RotateCcw size={18}/> : <ArrowUp size={18}/>}</button> :
        <button type="button" aria-label={zh ? '麦克风静音' : 'Mute microphone'} title={state.muted ? zh ? '开启麦克风' : 'Unmute microphone' : zh ? '麦克风静音' : 'Mute microphone'} aria-pressed={state.muted} disabled={state.phase === 'connecting' || state.phase === 'idle'} onClick={() => session.mute()}>{state.muted ? <MicOff size={18}/> : <Mic size={18}/>}</button>}
      <button type="button" className="voice-composer-end" aria-label={endLabel} title={endLabel} onClick={() => session.end()}>{recording ? <X size={18}/> : <PhoneOff size={18}/>}</button>
    </div>
    {detailOpen && <div className="voice-composer-note" id={detailsId}>
      {state.error && <p role="alert" className="voice-error">{state.error}</p>}
      {state.transcript && <p className="voice-composer-transcript">{state.transcript}</p>}
      <div><span>{zh ? '发送后转为文字消息，回复不会自动朗读' : 'Sends a text message. Replies are not spoken.'}</span>
        <button type="button" aria-label={zh ? '语音设置' : 'Voice settings'} onClick={() => presentation.showSettings()}><Settings2 size={16}/></button></div>
    </div>}
  </div>;
}
