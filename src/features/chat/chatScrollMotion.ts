type MotionKind = 'follow' | 'submission' | 'jump';
type Target = number | (() => number);
type Motion = {
  scroller: HTMLElement;
  target: Target;
  kind: MotionKind;
  start: number;
  startedAt: number;
  updatedAt: number;
  lastFrameAt: number;
  duration: number;
  overflowAnchor: string;
  complete?: () => void;
  followTarget?: Target;
};

/** One cancellable animation owns the list; streamed targets update it in place. */
export function createChatScrollMotion() {
  let motion: Motion | null = null;
  let frame: number | null = null;
  const targetTop = (item: Motion) => {
    const destination = typeof item.target === 'function' ? item.target() : item.target;
    // Async media/font measurements can shrink after growing. Passive follow
    // reveals new content; it must not pull the reader upward on a later size
    // correction. Explicit jumps/submission placement still work both ways.
    return Math.max(0, Math.min(item.scroller.scrollHeight - item.scroller.clientHeight,
      item.kind === 'follow' ? Math.max(item.scroller.scrollTop, destination) : destination));
  };
  const cancel = () => {
    if (frame != null) window.cancelAnimationFrame(frame);
    frame = null;
    if (motion) {
      motion.scroller.style.overflowAnchor = motion.overflowAnchor;
      delete motion.scroller.dataset.scrollAnimating;
    }
    motion = null;
  };
  const tick = (now: number) => {
    frame = null;
    const item = motion;
    if (!item || !item.scroller.isConnected) { cancel(); return; }
    const target = targetTop(item);
    const current = item.scroller.scrollTop;
    // A frame's timestamp can predate work submitted during that same frame.
    const elapsed = Math.max(0, now - item.startedAt);
    const done = item.kind === 'follow'
      ? Math.abs(target - current) < 0.75 || now - item.updatedAt >= 320
      : elapsed >= item.duration;
    const progress = Math.min(1, elapsed / item.duration);
    const next = done ? target : item.kind === 'follow'
      ? current + (target - current) * (1 - Math.exp(-Math.max(0, Math.min(64, now - item.lastFrameAt)) / 65))
      : item.start + (target - item.start) * (1 - (1 - progress) ** 3);
    item.lastFrameAt = Math.max(item.lastFrameAt, now);
    // No browser-owned smooth animation survives a wheel/touch/key cancellation.
    item.scroller.scrollTo({ top: next, behavior: 'instant' });
    if (done) {
      const complete = item.complete;
      const followTarget = item.followTarget;
      cancel();
      complete?.();
      // A fast response can finish growing before placement ends. Reveal that
      // tail afterward, but never scroll back toward an obsolete follow target.
      if (followTarget != null && (typeof followTarget === 'function' ? followTarget() : followTarget) > item.scroller.scrollTop + 0.75) {
        controller.move(item.scroller, followTarget, 'follow');
      }
    } else {
      frame = window.requestAnimationFrame(tick);
    }
  };
  const controller = {
    cancel,
    isActive: () => motion != null,
    move(scroller: HTMLElement, target: Target, kind: MotionKind, complete?: () => void) {
      // Passive stream/resize updates must not replace explicit navigation.
      if (motion?.scroller === scroller && motion.kind !== 'follow' && kind === 'follow') {
        if (motion.kind === 'submission') motion.followTarget = target;
        return;
      }
      const now = performance.now();
      if (motion?.scroller === scroller && motion.kind === 'follow' && kind === 'follow') {
        motion.target = target;
        motion.updatedAt = now;
        return;
      }
      cancel();
      const start = scroller.scrollTop;
      const destination = typeof target === 'function' ? target() : target;
      const item: Motion = { scroller, target, kind, start, startedAt: now, updatedAt: now,
        lastFrameAt: now, duration: kind === 'jump' ? Math.min(360, 180 + Math.sqrt(Math.abs(destination - start)) * 3)
          : kind === 'submission' ? 500 : 260,
        overflowAnchor: scroller.style.overflowAnchor, complete };
      if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches || Math.abs(destination - start) < 0.75) {
        scroller.scrollTo({ top: targetTop(item), behavior: 'instant' });
        complete?.();
        return;
      }
      motion = item;
      scroller.style.overflowAnchor = 'none';
      scroller.dataset.scrollAnimating = kind;
      frame = window.requestAnimationFrame(tick);
    },
  };
  return controller;
}
