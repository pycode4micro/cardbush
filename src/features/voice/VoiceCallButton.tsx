import { useLayoutEffect, useRef, useState, type ButtonHTMLAttributes } from 'react';
import { useVoiceContext } from './VoiceConversation';

/** Hold starts a call; releasing that hold must never submit the text draft. */
export function VoiceCallButton({ callEnabled, children, onClick, disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { callEnabled: boolean }) {
  const context = useVoiceContext();
  const current = useRef({ context, callEnabled, disabled });
  current.current = { context, callEnabled, disabled };
  const [pressing, setPressing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const held = useRef(false), origin = useRef<{ x: number; y: number } | null>(null);
  const clear = () => { clearTimeout(timer.current); timer.current = undefined; setPressing(false); };
  useLayoutEffect(() => {
    setPressing(false);
    return () => {
      // Suppress a release only when a gesture was actually in progress. An
      // idle scope change (or StrictMode cleanup) must not eat the next click.
      if (timer.current !== undefined || origin.current) held.current = true;
      clearTimeout(timer.current); timer.current = undefined; origin.current = null;
    };
  }, [context?.session, context?.target.environment, context?.target.sessionId]);
  useLayoutEffect(() => { if (disabled || !callEnabled || !context) { if (timer.current) held.current = true; clear(); } }, [disabled, callEnabled, context === null]);
  const begin = () => {
    clear();
    held.current = false;
    if (!context || !callEnabled || disabled || context.session.snapshot().mode !== 'idle') return;
    setPressing(true);
    timer.current = setTimeout(() => {
      timer.current = undefined; held.current = true; setPressing(false);
      const latest = current.current;
      if (!latest.context || !latest.callEnabled || latest.disabled) return;
      latest.context.session.update(latest.context.target); void latest.context.session.start('call');
    }, 500);
  };
  return <button {...props} type="button" disabled={disabled} className={`${props.className ?? ''} voice-call-trigger${pressing ? ' is-holding' : ''}`}
    onPointerDown={event => {
      if (event.button !== 0) return;
      origin.current = { x: event.clientX, y: event.clientY };
      event.currentTarget.setPointerCapture(event.pointerId); begin();
    }}
    onPointerMove={event => { if (origin.current && Math.hypot(event.clientX - origin.current.x, event.clientY - origin.current.y) > 16) { clear(); held.current = true; } }}
    onPointerUp={() => { clear(); origin.current = null; }} onPointerCancel={() => { clear(); held.current = true; origin.current = null; }}
    onLostPointerCapture={() => { if (timer.current) held.current = true; clear(); }}
    onBlur={() => { if (timer.current) held.current = true; clear(); }} onContextMenu={event => event.preventDefault()}
    onKeyDown={event => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); if (!event.repeat) begin(); } }}
    onKeyUp={event => {
      if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); clear(); if (!held.current) event.currentTarget.click(); held.current = false; }
    }}
    onClick={event => { clear(); if (held.current) { held.current = false; return; } onClick?.(event); }}>
    {children}
    {pressing && <svg className="voice-hold-progress" viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="18"/></svg>}
  </button>;
}
