import { useCallback, useEffect, useState } from 'react';

export function useInspectorTabStrip(activeId: string, tabCount: number) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  const [state, setState] = useState({
    overflow: false, canScrollLeft: false, canScrollRight: false,
  });
  const measure = useCallback(() => {
    const maximum = element ? Math.max(0, element.scrollWidth - element.clientWidth) : 0;
    // Measure overflow against the full strip, including its arrow slots. Otherwise
    // the arrows themselves can keep overflow enabled after the panel grows.
    const available = element?.parentElement?.clientWidth ?? element?.clientWidth ?? 0;
    const next = {
      overflow: Boolean(element && element.scrollWidth > available + 2),
      canScrollLeft: Boolean(element && element.scrollLeft > 2),
      canScrollRight: Boolean(element && element.scrollLeft < maximum - 2),
    };
    setState(current => current.overflow === next.overflow
      && current.canScrollLeft === next.canScrollLeft
      && current.canScrollRight === next.canScrollRight ? current : next);
  }, [element]);

  useEffect(() => {
    if (!element) { measure(); return; }
    let frame: number | undefined;
    const schedule = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => { frame = undefined; measure(); });
    };
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey || element.scrollWidth <= element.clientWidth + 2) return;
      const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
      if (!delta) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1;
      element.scrollLeft += delta * unit;
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    element.addEventListener('scroll', schedule, { passive: true });
    element.addEventListener('wheel', wheel, { passive: false });
    schedule();
    return () => {
      observer.disconnect();
      element.removeEventListener('scroll', schedule);
      element.removeEventListener('wheel', wheel);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [element, measure]);

  useEffect(() => {
    if (!element) return;
    const frame = requestAnimationFrame(() => {
      const active = Array.from(element.children).find(
        child => (child as HTMLElement).dataset.inspectorTabId === activeId,
      );
      if (active) {
        const viewport = element.getBoundingClientRect();
        const bounds = active.getBoundingClientRect();
        const delta = bounds.left < viewport.left ? bounds.left - viewport.left
          : bounds.right > viewport.right ? bounds.right - viewport.right : 0;
        // Only move this strip; scrollIntoView can also move the enclosing app.
        if (delta) element.scrollLeft += delta;
      }
      measure();
    });
    return () => cancelAnimationFrame(frame);
  }, [element, activeId, tabCount, measure, state.overflow]);

  const scroll = (direction: -1 | 1) => {
    element?.scrollBy({
      left: direction * Math.max(160, Math.round(element.clientWidth * 0.72)),
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
    });
  };
  return { ref: setElement, state, scroll };
}
