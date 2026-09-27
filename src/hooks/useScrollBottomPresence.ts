import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

const bottomHoldMs = 200;
const bottomPixelTolerance = 1;

/** Keep the button until the viewport has actually stayed at the bottom.
 * Follow/jump intent is separate: clicking must not dismiss it mid-scroll. */
export function useScrollBottomPresence({ scrollerRef, requestedVisible, scope, enabled = true, revision = 0 }: {
  scrollerRef: RefObject<HTMLElement | null>;
  requestedVisible: boolean;
  scope: string;
  enabled?: boolean;
  revision?: number;
}) {
  const current = useRef({ scope, visible: false });
  const [presence, setPresence] = useState(current.current);
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const publish = (visible: boolean) => {
      if (current.current.scope === scope && current.current.visible === visible) return;
      current.current = { scope, visible };
      setPresence(current.current);
    };
    if (current.current.scope !== scope || !enabled || !scroller) publish(false);
    if (!enabled || !scroller) return;
    let timer: number | undefined;
    const cancelHide = () => { window.clearTimeout(timer); timer = undefined; };
    const atBottom = () => scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= bottomPixelTolerance;
    const sync = () => {
      if (!atBottom()) {
        cancelHide();
        if (requestedVisible) publish(true);
      } else if (current.current.visible && timer === undefined) {
        timer = window.setTimeout(() => {
          timer = undefined;
          // A stream update or resize can move the tail during the hold.
          if (scrollerRef.current === scroller && scroller.isConnected && atBottom()) publish(false);
        }, bottomHoldMs);
      }
    };
    scroller.addEventListener('scroll', sync, { passive: true });
    const resize = new ResizeObserver(sync);
    resize.observe(scroller);
    for (const child of scroller.children) resize.observe(child);
    sync();
    return () => { cancelHide(); scroller.removeEventListener('scroll', sync); resize.disconnect(); };
  }, [scrollerRef, requestedVisible, scope, enabled, revision]);
  return enabled && presence.scope === scope && presence.visible;
}
