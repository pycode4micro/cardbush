import { useLayoutEffect, useRef, type ReactNode } from 'react';

/** Resize the cheap outer viewport immediately; reflow the document once the
 * pointer settles. The mounted document, scroll position and guest survive. */
export function DeferredResizePreview({ children, className = '' }: {
  children: ReactNode;
  className?: string;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    let timer = 0;
    let committed = 0;
    const commit = (width: number) => {
      if (width <= 0) return;
      committed = width;
      content.style.width = `${width}px`;
      viewport.removeAttribute('data-resizing');
    };
    commit(viewport.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      window.clearTimeout(timer);
      if (Math.abs(width - committed) < 0.5 || width <= 0) {
        viewport.removeAttribute('data-resizing');
        return;
      }
      viewport.dataset.resizing = 'true';
      timer = window.setTimeout(() => commit(width), 120);
    });
    observer.observe(viewport);
    return () => { window.clearTimeout(timer); observer.disconnect(); };
  }, []);
  return <div ref={viewportRef} className={`deferred-resize-preview ${className}`}>
    <div ref={contentRef} className="deferred-resize-content">{children}</div>
  </div>;
}
