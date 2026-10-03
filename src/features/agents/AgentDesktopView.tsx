import { useCallback, useEffect, useRef, useState } from 'react';
import { Monitor, Hand, Send } from 'lucide-react';
import type { AgentDesktopFrame, AgentDesktopInput, AgentDesktopStatus } from '../../../electron/agentDesktopTypes';
import type { AgentOperation } from '../../../electron/agentTypes';
import { desktopPoint } from './agentDesktopCoordinates';
import './agentDesktop.css';

type Call = <T = unknown>(operation: AgentOperation, input?: Record<string, unknown>) => Promise<T>;
export function AgentDesktopView({ call, language, active, name }: { call: Call; language: string; active: boolean; name: string }) {
  const zh = language === 'zh';
  const [frame, setFrame] = useState<AgentDesktopFrame>();
  const [status, setStatus] = useState<AgentDesktopStatus>();
  const [error, setError] = useState('');
  const [owned, setOwned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [typing, setTyping] = useState(false);
  const token = useRef<string | undefined>(undefined);
  const epoch = useRef(0);
  const activeRef = useRef(active); activeRef.current = active;
  const alive = useRef(true);
  const surface = useRef<HTMLImageElement>(null);
  const frameRef = useRef(frame); frameRef.current = frame;
  const gesture = useRef<{ x: number; y: number; frameId: string; button: 'left' | 'middle' | 'right' } | undefined>(undefined);
  const inputQueue = useRef<Promise<void>>(Promise.resolve());
  const pendingInputs = useRef(0);
  const release = useCallback(async () => {
    epoch.current++;
    const value = token.current; token.current = undefined; gesture.current = undefined;
    if (alive.current) setOwned(false);
    if (value) await call('desktop.release', { token: value }).catch(() => {});
  }, [call]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; void release(); }; }, [release]);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (cancelled) return;
      if (!active || document.hidden || !surface.current?.getClientRects().length) {
        await release();
      } else {
        try {
          const currentToken = token.current;
          const value = await call<AgentDesktopFrame>('desktop.frame', currentToken ? { token: currentToken } : {});
          if (!cancelled && currentToken === token.current) {
            setFrame(value); setStatus(value);
            if (currentToken && value.control !== 'user') await release();
          }
        } catch (failure) {
          if (!cancelled) { setError(String(failure)); setFrame(undefined); await release(); }
        }
      }
      if (!cancelled) timer = setTimeout(() => void poll(), 700);
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); void release(); };
  }, [active, call, release]);
  const take = async () => {
    const generation = epoch.current;
    setBusy(true); setError('');
    try {
      const result = await call<AgentDesktopStatus & { token: string }>('desktop.take');
      if (!alive.current || !activeRef.current || epoch.current !== generation || document.hidden || !surface.current?.getClientRects().length) { await call('desktop.release', { token: result.token }); return; }
      token.current = result.token; setOwned(true); setStatus(result);
      // A new owner needs a frame issued to its own lease before sending input.
      const initialFrame = await call<AgentDesktopFrame>('desktop.frame', { token: result.token });
      if (alive.current && token.current === result.token) setFrame(initialFrame);
      surface.current?.focus();
    } catch (failure) { if (alive.current) { setError(String(failure)); await release(); } }
    finally { if (alive.current) setBusy(false); }
  };
  const send = async (event: AgentDesktopInput, frameId = frameRef.current?.frameId) => {
    if (!token.current || !frameId) return false;
    if (pendingInputs.current >= 12) { setError(zh ? '操作过快，请稍候。' : 'Please wait for pending input.'); return false; }
    const currentToken = token.current;
    pendingInputs.current++;
    const task = inputQueue.current.then(async () => {
      if (currentToken !== token.current || !alive.current) return false;
      await call('desktop.input', { token: currentToken, frameId, event });
      return true;
    });
    inputQueue.current = task.then(() => {}, failure => { if (alive.current) setError(String(failure)); });
    const accepted = await task.catch(() => false);
    pendingInputs.current--;
    return accepted;
  };
  const point = (x: number, y: number) => frameRef.current && surface.current
    ? desktopPoint(x, y, surface.current.getBoundingClientRect(), frameRef.current) : null;
  return <section className="agent-desktop-view" aria-label={zh ? `${name} 的电脑` : `${name}’s computer`}>
    <header><Monitor size={16}/><strong>{zh ? `${name} 的电脑` : `${name}’s computer`}</strong><span>Linux</span></header>
    <div className="agent-desktop-screen">
      <img ref={surface} src={frame ? `data:${frame.mimeType};base64,${frame.data}` : undefined} alt={zh ? '远程 Linux 桌面' : 'Remote Linux desktop'} draggable={false}
        tabIndex={owned ? 0 : -1} data-controlling={owned} style={!frame ? { opacity: 0 } : undefined}
        onContextMenu={event => { if (owned) event.preventDefault(); }}
        onPointerDown={event => {
          if (!owned || busy || !frame || ![0, 1, 2].includes(event.button)) return;
          const position = point(event.clientX, event.clientY); if (!position) return;
          event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
          gesture.current = { ...position, frameId: frame.frameId, button: event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left' };
        }}
        onPointerCancel={() => { gesture.current = undefined; }}
        onPointerUp={event => {
          const start = gesture.current; gesture.current = undefined;
          const end = point(event.clientX, event.clientY); if (!start || !end) return;
          const drag = start.button === 'left' && Math.hypot(start.x - end.x, start.y - end.y) > 4;
          void send(drag ? { action: 'drag', x: start.x, y: start.y, toX: end.x, toY: end.y }
            : { action: 'click', x: end.x, y: end.y, button: start.button }, start.frameId);
        }}
        onWheel={event => { const position = point(event.clientX, event.clientY); if (owned && position && event.deltaY) void send({ action: 'scroll', ...position, direction: event.deltaY < 0 ? 'up' : 'down' }); }}
        onPaste={event => { if (owned) { event.preventDefault(); const value = event.clipboardData.getData('text/plain').slice(0, 16000); if (value) void send({ action: 'type', text: value }); } }}
        onKeyDown={event => {
          if (!owned || event.nativeEvent.isComposing || event.key === 'Process') return;
          const keys: Record<string, string> = { Enter: 'Return', Backspace: 'BackSpace', Escape: 'Escape', Tab: 'Tab', Delete: 'Delete', ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', Home: 'Home', End: 'End', PageUp: 'Prior', PageDown: 'Next', ' ': 'space' };
          const key = keys[event.key] || (/^[a-zA-Z0-9]$/.test(event.key) ? event.key : undefined);
          if (!key || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v')) return;
          event.preventDefault();
          void send({ action: 'key', key: [event.ctrlKey || event.metaKey ? 'ctrl' : '', event.altKey ? 'alt' : '', event.shiftKey ? 'shift' : '', key].filter(Boolean).join('+') });
        }}/>
      {!frame && <p className="agent-desktop-placeholder">{error || (zh ? '正在获取桌面…' : 'Loading desktop…')}</p>}
    </div>
    <footer><span role="status">{owned ? (zh ? '你正在控制' : 'You have control') : status?.control === 'user' ? (zh ? '其他窗口正在控制' : 'Another viewer has control') : (zh ? 'Agent 拥有控制权' : 'Agent has control')}</span>
      <button disabled={busy || !frame || (!owned && status?.control === 'user')} onClick={() => { if (owned) void release(); else void take(); }}><Hand size={14}/>{owned ? (zh ? '交还 Agent' : 'Return control') : (zh ? '接管' : 'Take control')}</button></footer>
    {owned && <form className="agent-desktop-text" onSubmit={event => {
      event.preventDefault(); if (!text || typing) return;
      const submitted = text; setTyping(true);
      void send({ action: 'type', text: submitted }).then(accepted => { if (alive.current && accepted) setText(current => current === submitted ? '' : current); })
        .finally(() => { if (alive.current) setTyping(false); });
    }}>
      <input aria-label={zh ? '输入到远程桌面' : 'Type into remote desktop'} placeholder={zh ? '输入文字到远程桌面' : 'Type into remote desktop'} value={text} maxLength={16000} onChange={event => setText(event.target.value)}/>
      <button aria-label={zh ? '发送文字' : 'Send text'} disabled={!text || typing}><Send size={15}/></button>
    </form>}
    {error && frame && <p className="agents-error" role="alert">{error}</p>}
  </section>;
}
