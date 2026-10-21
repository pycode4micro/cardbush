import { prefersReducedMotion } from '../../shared/motionPreference';
import { suspendScrollAnchoring } from '../scrollAnchoring';
import { cancelConversationWheel } from './conversationWheelScrolling';

type MotionKind = 'submission' | 'jump';
type Target = number | (() => number);
type Motion = {
  scroller: HTMLElement;
  target: Target;
  kind: MotionKind;
  start: number;
  startedAt: number;
  duration: number;
  releaseAnchoring?: () => void;
  complete?: () => void;
};

/** Only explicit navigation animates. Stream layout is compensated before paint. */
export function createChatScrollMotion() {
  let motion: Motion | null = null;
  let frame: number | null = null;
  const targetTop = (item: Motion) => {
    const destination = typeof item.target === 'function' ? item.target() : item.target;
    return Math.max(0, Math.min(item.scroller.scrollHeight - item.scroller.clientHeight, destination));
  };
  const cancel = () => {
    if (frame != null) window.cancelAnimationFrame(frame);
    frame = null;
    if (motion) {
      motion.releaseAnchoring?.();
      delete motion.scroller.dataset.scrollAnimating;
    }
    motion = null;
  };
  const tick = (now: number) => {
    frame = null;
    const item = motion;
    if (!item || !item.scroller.isConnected) { cancel(); return; }
    const target = targetTop(item);
    // A frame's timestamp can predate work submitted during that same frame.
    const elapsed = Math.max(0, now - item.startedAt);
    const done = elapsed >= item.duration;
    const progress = Math.min(1, elapsed / item.duration);
    const next = done ? target : item.start + (target - item.start) * (1 - (1 - progress) ** 3);
    // No browser-owned smooth animation survives a wheel/touch/key cancellation.
    item.scroller.scrollTo({ top: next, behavior: 'instant' });
    if (done) {
      const complete = item.complete;
      cancel();
      complete?.();
    } else {
      frame = window.requestAnimationFrame(tick);
    }
  };
  const controller = {
    cancel,
    isActive: () => motion != null,
    move(scroller: HTMLElement, target: Target, kind: MotionKind, complete?: () => void) {
      cancelConversationWheel(scroller);
      const now = performance.now();
      cancel();
      const start = scroller.scrollTop;
      const destination = typeof target === 'function' ? target() : target;
      const item: Motion = { scroller, target, kind, start, startedAt: now,
        duration: kind === 'jump' ? Math.min(360, 180 + Math.sqrt(Math.abs(destination - start)) * 3) : 500,
        complete };
      if (prefersReducedMotion() || Math.abs(destination - start) < 0.75) {
        scroller.scrollTo({ top: targetTop(item), behavior: 'instant' });
        complete?.();
        return;
      }
      motion = item;
      item.releaseAnchoring = suspendScrollAnchoring(scroller);
      scroller.dataset.scrollAnimating = kind;
      frame = window.requestAnimationFrame(tick);
    },
  };
  return controller;
}
