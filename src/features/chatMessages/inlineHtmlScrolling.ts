import { connectConversationWheelScrolling, conversationWheelWasHandled, scrollConversationByWheel } from '../chat/conversationWheelScrolling';

type PreviewGuest = HTMLElement & { executeJavaScript(code: string): Promise<unknown> };
type WheelDelta = { pixels: number; lines: number; pages: number; events: number };

// Runs in the sandboxed document. Only unused vertical wheel deltas leave it;
// authored controls and nested scrollers keep their normal input handling.
function installGuestScrolling() {
  type Bridge = { read(): Promise<WheelDelta | null>; dispose(): void };
  const scope = window as Window & { __cardbushInlineScroll?: Bridge };
  scope.__cardbushInlineScroll?.dispose();
  const empty = (): WheelDelta => ({ pixels: 0, lines: 0, pages: 0, events: 0 });
  let delta = empty(), frame = 0, disposed = false;
  let waiter: ((value: WheelDelta | null) => void) | undefined;
  // The guest always has its full document height. Only the conversation owns
  // page scrolling, whether the host clips the preview or reveals it in full.
  // `clip` also blocks focus/scrollIntoView from creating a hidden root offset.
  const rootStyle = document.createElement('style');
  rootStyle.textContent = 'html,body{overflow:clip!important;scroll-behavior:auto!important}';
  document.head.append(rootStyle);
  const flush = () => {
    frame = 0;
    if (!waiter || !delta.events) return;
    const resolve = waiter, value = delta;
    waiter = undefined; delta = empty(); resolve(value);
  };
  const wheel = (event: WheelEvent) => {
    if (!event.isTrusted || !event.cancelable || event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey ||
      !Number.isFinite(event.deltaY) || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
    const root = document.scrollingElement;
    for (const target of event.composedPath()) {
      if (!(target instanceof Element)) continue;
      // A focused native input can use the wheel to change its value.
      if (target.matches('input[type="number"],select')) return;
      if (target === root || target === document.body || target === document.documentElement) continue;
      const style = getComputedStyle(target);
      const scrollable = /(auto|scroll|overlay)/.test(style.overflowY);
      if (!scrollable) continue;
      const remaining = target.scrollHeight - target.clientHeight;
      if (remaining > 1 && (event.deltaY < 0 ? target.scrollTop > 0 : target.scrollTop < remaining - 1)) return;
      if (remaining > 1 && (style.overscrollBehaviorY === 'contain' || style.overscrollBehaviorY === 'none')) {
        // Native webview scroll chaining can ignore CSS containment at an edge.
        event.preventDefault(); return;
      }
    }
    // Prevent Chromium from chaining a compositor scroll from the native guest
    // into the moving/clipped host surface. The host applies this delta once.
    event.preventDefault();
    const key = event.deltaMode === 1 ? 'lines' : event.deltaMode === 2 ? 'pages' : 'pixels';
    delta[key] += event.deltaY;
    delta.events++;
    if (!frame) frame = requestAnimationFrame(flush);
  };
  addEventListener('wheel', wheel, { passive: false });
  scope.__cardbushInlineScroll = {
    read: () => disposed ? Promise.resolve(null) : new Promise(resolve => { waiter = resolve; if (delta.events && !frame) frame = requestAnimationFrame(flush); }),
    dispose: () => {
      disposed = true; removeEventListener('wheel', wheel); cancelAnimationFrame(frame);
      rootStyle.remove();
      waiter?.(null); waiter = undefined; delta = empty();
    },
  };
}

/** Consume wheel handoffs without adding IPC or host capabilities to the file. */
export function connectInlineHtmlScrolling(
  guest: PreviewGuest, host: Element, diagnostic?: (event: string, detail: Record<string, unknown>) => void,
) {
  const findScroller = () => {
    for (let node = host.parentElement; node; node = node.parentElement) {
      if (/(auto|scroll|overlay)/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight + 1) return node;
    }
    return document.scrollingElement as HTMLElement | null;
  };
  let disposed = false, lastLog = 0;
  let scrollContainer: HTMLElement | null = null;
  let disconnectWheel: (() => void) | undefined;
  const connectScroller = () => {
    const next = findScroller();
    if (next !== scrollContainer) {
      disconnectWheel?.();
      scrollContainer = next;
      disconnectWheel = next ? connectConversationWheelScrolling(next) : undefined;
    }
    return next;
  };
  connectScroller();
  const disposeGuest = () => {
    try { void guest.executeJavaScript('window.__cardbushInlineScroll?.dispose()').catch(() => {}); }
    catch { /* React may already have detached or replaced the native guest. */ }
  };
  void (async () => {
    try {
      await guest.executeJavaScript(`(${installGuestScrolling.toString()})()`);
      if (disposed) return;
      diagnostic?.('wheel-bridge-ready', { version: 4, scrollOwner: 'conversation' });
      while (!disposed) {
        const delta = await guest.executeJavaScript('window.__cardbushInlineScroll?.read()') as WheelDelta | null;
        if (disposed || !delta) break;
        if (![delta.pixels, delta.lines, delta.pages, delta.events].every(Number.isFinite) || delta.events < 1) continue;
        if (!host.isConnected || !guest.isConnected || document.hidden) continue;
        // Layout/overflow can change after mounting (for example, a short reply
        // grows). Do not send scroll into a non-overflowing intermediate wrapper.
        const target = connectScroller();
        if (!target) continue;
        const unit = parseFloat(getComputedStyle(target).lineHeight) || 16;
        const distance = delta.pixels + delta.lines * unit + delta.pages * target.clientHeight;
        if (!Number.isFinite(distance)) continue;
        const dy = Math.max(-target.clientHeight * 3, Math.min(target.clientHeight * 3, distance));
        if (!dy) continue;
        // Notify the existing conversation follow/reading-position handlers.
        // Synthetic wheel events have no default scroll; apply it only when
        // those handlers have not already consumed or cancelled the gesture.
        const event = new WheelEvent('wheel', { deltaY: dy, deltaMode: 0, bubbles: true, cancelable: true });
        const before = target.scrollTop;
        if (guest.dispatchEvent(event)) scrollConversationByWheel(target, dy);
        const now = performance.now();
        if (now - lastLog >= 250) {
          lastLog = now;
          diagnostic?.('wheel-handoff', { deltaY: dy, events: delta.events, before, after: target.scrollTop,
            scrollOwner: 'conversation', cancelled: event.defaultPrevented && !conversationWheelWasHandled(event) });
        }
      }
    } catch { if (!disposed) diagnostic?.('wheel-bridge-error', {}); }
    finally { disconnectWheel?.(); disposeGuest(); }
  })();
  return () => {
    disposed = true;
    disconnectWheel?.();
    disposeGuest();
  };
}
