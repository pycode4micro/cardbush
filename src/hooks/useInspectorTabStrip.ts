import { useEffect, useState } from 'react';

export function useInspectorTabStrip(activeId: string, tabCount: number) {
  const [element, setElement] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!element) return;
    let frame: number | undefined;
    const schedule = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        const active = Array.from(element.children).find(
          child => (child as HTMLElement).dataset.inspectorTabId === activeId,
        );
        if (!active) return;
        const viewport = element.getBoundingClientRect();
        const bounds = active.getBoundingClientRect();
        const delta = bounds.left < viewport.left ? bounds.left - viewport.left
          : bounds.right > viewport.right ? bounds.right - viewport.right : 0;
        // Only move this strip; scrollIntoView can also move the enclosing app.
        if (delta) element.scrollLeft += delta;
      });
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
    element.addEventListener('wheel', wheel, { passive: false });
    schedule();
    return () => {
      observer.disconnect();
      element.removeEventListener('wheel', wheel);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [element, activeId, tabCount]);

  return { ref: setElement };
}
