import { ChevronDown } from 'lucide-react';
import { type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react';
import type { AppLanguage } from '../../types';
import { preserveScrollPositionForToggle } from '../preserveScrollPosition';

export function UserMessageDisclosure({ children, language }: {
  children: ReactNode;
  language: AppLanguage;
}) {
  const contentId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    const measure = () => {
      const contentHeight = content.getBoundingClientRect().height;
      if (!viewport.clientWidth || !contentHeight) return;
      const style = getComputedStyle(viewport);
      const previewHeight = Number.parseFloat(style.lineHeight)
        * Number.parseFloat(style.getPropertyValue('--user-message-preview-lines'));
      const overflows = contentHeight > previewHeight + 1;
      setOverflowing(overflows);
      if (!overflows) setExpanded(false);
    };
    measure();
    // Observe the natural content height, including lazy Markdown, and the
    // viewport for changes in pane width or font size. Never measure clipped text.
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="user-message-disclosure" ref={rootRef}>
      <div
        id={contentId}
        ref={viewportRef}
        className={`user-message-viewport${expanded ? ' expanded' : ''}${overflowing ? ' overflowing' : ''}`}
        onFocusCapture={(event) => {
          // Keyboard navigation to a clipped link/control should reveal it,
          // without creating a second scrollable area inside the bubble.
          if (!expanded && event.target.getBoundingClientRect().bottom > event.currentTarget.getBoundingClientRect().bottom) {
            preserveScrollPositionForToggle(rootRef.current, () => setExpanded(true));
            event.target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
          }
        }}
      >
        <div className="user-message-body" ref={contentRef}>{children}</div>
      </div>
      {overflowing && (
        <button
          type="button"
          className="user-message-toggle"
          aria-expanded={expanded}
          aria-controls={contentId}
          onClick={(event) => preserveScrollPositionForToggle(
            expanded ? event.currentTarget : rootRef.current,
            () => setExpanded((value) => !value),
          )}
        >
          {language === 'zh' ? (expanded ? '收起' : '展示更多') : (expanded ? 'Show less' : 'Show more')}
          <ChevronDown size={13} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
