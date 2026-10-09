import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

/** Keep short prompts inline; give wrapped prompts the full width above the toolbar. */
export function useComposerMultiline(
  surfaceRef: RefObject<HTMLDivElement | null>,
  value: string,
  mode: 'simple' | 'input-only' | null,
) {
  const [multiline, setMultiline] = useState(false);
  const measureRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    if (!mode || !surface) return;
    const actions = surface.querySelector<HTMLElement>('.composer-actions');
    if (!actions) return;

    const measure = () => {
      const input = surface.querySelector<HTMLElement>('[data-composer-input]');
      if (!input || !surface.clientWidth) return;
      const text = input instanceof HTMLTextAreaElement ? input.value : input.textContent ?? '';
      if (!text || text.includes('\n')) {
        setMultiline(Boolean(text));
        return;
      }
      const style = getComputedStyle(surface);
      const gap = parseFloat(style.columnGap) || 0;
      const leadingWidth = mode === 'simple' ? parseFloat(style.gridTemplateColumns) : 0;
      const width = surface.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
        - actions.getBoundingClientRect().width - leadingWidth - gap * (mode === 'simple' ? 2 : 1);
      if (!Number.isFinite(width) || width <= 0) return;

      // Always measure at the compact width. Measuring the expanded width would
      // toggle between layouts when a prompt fits one full-width line only.
      // The same mounted editor measures rich chips and text with native font
      // metrics; restore its styles and scroll before the browser paints.
      const { width: previousWidth, whiteSpace } = input.style;
      const { scrollTop, scrollLeft } = input;
      try {
        input.style.width = `${width}px`;
        input.style.whiteSpace = 'pre';
        const oneLineHeight = input.scrollHeight;
        input.style.whiteSpace = whiteSpace;
        setMultiline(input.scrollHeight > oneLineHeight + 1);
      } finally {
        input.style.width = previousWidth;
        input.style.whiteSpace = whiteSpace;
        input.scrollTop = scrollTop;
        input.scrollLeft = scrollLeft;
      }
    };
    measureRef.current = measure;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    observer.observe(surface);
    observer.observe(actions);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      measureRef.current = null;
    };
  }, [mode, surfaceRef]);

  useLayoutEffect(() => { measureRef.current?.(); }, [value, mode]);
  return Boolean(mode && value && (value.includes('\n') || multiline));
}
