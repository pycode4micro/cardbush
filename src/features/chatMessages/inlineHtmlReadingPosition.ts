export function captureInlineHtmlReadingPosition(host: HTMLElement) {
  let scroller = host.parentElement;
  while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
  const edge = (scroller?.getBoundingClientRect().top ?? 0);
  const before = host.getBoundingClientRect();
  const side = before.bottom <= edge ? 'bottom' : 'top';
  const anchor = before[side];
  let cancelled = false;
  const cancel = () => { cancelled = true; };
  // Never move the user's viewport back after they deliberately scroll away.
  window.addEventListener('wheel', cancel, { capture: true, passive: true });
  window.addEventListener('touchstart', cancel, { capture: true, passive: true });
  window.addEventListener('pointerdown', cancel, true);
  window.addEventListener('keydown', cancel, true);
  const dispose = () => {
    window.removeEventListener('wheel', cancel, true);
    window.removeEventListener('touchstart', cancel, true);
    window.removeEventListener('pointerdown', cancel, true);
    window.removeEventListener('keydown', cancel, true);
  };
  return {
    restore() {
      dispose();
      if (cancelled || !host.isConnected) return;
      const delta = host.getBoundingClientRect()[side] - anchor;
      if (Math.abs(delta) < 1) return;
      if (scroller) scroller.scrollTop += delta;
      else window.scrollBy(0, delta);
    },
    dispose,
  };
}
