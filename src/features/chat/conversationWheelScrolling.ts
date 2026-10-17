import { prefersReducedMotion } from '../../shared/motionPreference';

type WheelMotion = {
  start: number; target: number; started: number; direction: number; lastTop: number;
  frame: number;
};
const motions = new WeakMap<HTMLElement, WheelMotion>();
const owners = new Map<HTMLElement, number>();
const handled = new WeakSet<WheelEvent>();
export const conversationWheelWasHandled = (event: WheelEvent) => handled.has(event);

export function cancelConversationWheel(scroller: HTMLElement) {
  const motion = motions.get(scroller);
  if (!motion) return;
  cancelAnimationFrame(motion.frame);
  motions.delete(scroller);
}

/** Both native conversation input and sandboxed HTML use this one motion. */
export function scrollConversationByWheel(scroller: HTMLElement, delta: number) {
  if (!Number.isFinite(delta) || !delta) return;
  const clamp = (value: number) => Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, value));
  const previous = motions.get(scroller);
  const direction = Math.sign(delta);
  // Keep pending distance across a burst or crossing a webview boundary. On a
  // reversal, respond immediately instead of finishing the old direction first.
  const continuing = previous?.direction === direction && Math.abs(scroller.scrollTop - previous.lastTop) <= 1;
  const target = clamp((continuing ? previous.target : scroller.scrollTop) + delta);
  if (prefersReducedMotion()) {
    cancelConversationWheel(scroller);
    scroller.scrollTo({ top: target, behavior: 'instant' });
    return;
  }
  if (Math.abs(target - scroller.scrollTop) < 0.5) { cancelConversationWheel(scroller); return; }
  if (previous && Math.abs(scroller.scrollTop - previous.lastTop) <= 1) {
    // Retarget one frame loop rather than creating a new animation per packet.
    previous.start = previous.lastTop = scroller.scrollTop;
    previous.target = target;
    previous.direction = direction;
    previous.started = performance.now();
    return;
  }
  cancelConversationWheel(scroller);
  // User wheel motion never toggles overflow-anchor: changing the scroll
  // container's style can invalidate a native guest's painted surface. External
  // layout/anchor corrections are handled by the position guard below instead.
  const motion: WheelMotion = { start: scroller.scrollTop, lastTop: scroller.scrollTop, target, direction, started: performance.now(), frame: 0 };
  motions.set(scroller, motion);
  const tick = (now: number) => {
    if (!scroller.isConnected || document.hidden) { cancelConversationWheel(scroller); return; }
    // A scrollbar drag, restored anchor or explicit navigation wins over any
    // queued wheel frame. Never pull the document back toward a stale target.
    if (Math.abs(scroller.scrollTop - motion.lastTop) > 1) { cancelConversationWheel(scroller); return; }
    const progress = Math.min(1, Math.max(0, now - motion.started) / 160);
    scroller.scrollTo({ top: clamp(motion.start + (motion.target - motion.start) * (1 - (1 - progress) ** 3)), behavior: 'instant' });
    motion.lastTop = scroller.scrollTop;
    if (progress === 1) cancelConversationWheel(scroller);
    else motion.frame = requestAnimationFrame(tick);
  };
  motion.frame = requestAnimationFrame(tick);
}

function handleWheel(event: WheelEvent) {
  if (event.defaultPrevented || !event.cancelable || event.ctrlKey || event.metaKey || event.shiftKey ||
    !Number.isFinite(event.deltaY) || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
  const path = event.composedPath();
  const scroller = path.find((node): node is HTMLElement => node instanceof HTMLElement && owners.has(node));
  if (!scroller) return;
  for (const node of path) {
    if (node === scroller) break;
    if (!(node instanceof Element)) continue;
    if (node.matches('input[type="number"],select')) return;
    const style = getComputedStyle(node), remaining = node.scrollHeight - node.clientHeight;
    if (!/(auto|scroll|overlay)/.test(style.overflowY) || remaining <= 1) continue;
    if ((event.deltaY < 0 ? node.scrollTop > 0 : node.scrollTop < remaining - 1) ||
      /^(contain|none)$/.test(style.overscrollBehaviorY)) return;
  }
  const unit = event.deltaMode === 1 ? parseFloat(getComputedStyle(scroller).lineHeight) || 16
    : event.deltaMode === 2 ? scroller.clientHeight : 1;
  event.preventDefault();
  handled.add(event);
  scrollConversationByWheel(scroller, event.deltaY * unit);
}

function cancelInput() { for (const scroller of owners.keys()) cancelConversationWheel(scroller); }

/** Reference counted: many embeds and the conversation share one listener. */
export function connectConversationWheelScrolling(scroller: HTMLElement) {
  if (!owners.size) {
    // Run after the conversation's follow, bottom-lock and authored handlers.
    window.addEventListener('wheel', handleWheel, { passive: false });
    window.addEventListener('pointerdown', cancelInput, true);
    window.addEventListener('keydown', cancelInput, true);
    window.addEventListener('touchstart', cancelInput, { capture: true, passive: true });
    document.addEventListener('visibilitychange', cancelInput);
  }
  owners.set(scroller, (owners.get(scroller) ?? 0) + 1);
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    const count = (owners.get(scroller) ?? 1) - 1;
    if (count) owners.set(scroller, count);
    else { owners.delete(scroller); cancelConversationWheel(scroller); }
    if (!owners.size) {
      window.removeEventListener('wheel', handleWheel);
      window.removeEventListener('pointerdown', cancelInput, true);
      window.removeEventListener('keydown', cancelInput, true);
      window.removeEventListener('touchstart', cancelInput, true);
      document.removeEventListener('visibilitychange', cancelInput);
    }
  };
}
