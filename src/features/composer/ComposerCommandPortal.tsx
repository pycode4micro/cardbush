import { useLayoutEffect, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

/** A composer embedded in a resizable card must not clip its command list. */
export function ComposerCommandPortal({ anchor, children }: { anchor: RefObject<HTMLElement | null>; children: ReactNode }) {
  const [position, setPosition] = useState<CSSProperties | null>(null);
  useLayoutEffect(() => {
    const element = anchor.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect(), margin = 10, topInset = 52, gap = 8;
      const above = rect.top - topInset - gap, below = window.innerHeight - rect.bottom - margin - gap;
      const up = above >= Math.min(240, below), width = Math.min(460, rect.width, window.innerWidth - margin * 2);
      setPosition({ position: 'fixed', zIndex: 2000, width,
        left: Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin)),
        top: up ? Math.max(topInset, rect.top - gap) : Math.max(topInset, rect.bottom + gap),
        transform: up ? 'translateY(-100%)' : undefined,
        '--composer-popover-max-height': `${Math.max(120, Math.min(420, up ? above : below))}px`,
      } as CSSProperties);
    };
    update();
    const observer = new ResizeObserver(update); observer.observe(element);
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
  }, [anchor]);
  return position ? createPortal(<div className="composer-command-portal" style={position}>{children}</div>, document.querySelector('.app') ?? document.body) : null;
}
