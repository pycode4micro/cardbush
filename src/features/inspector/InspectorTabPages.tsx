import { useEffect, useRef, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { InspectorTab } from './inspectorTabs';
import type { AppLanguage } from '../../types';
import { panelDividers, panelRects, type PanelLayout } from './panelLayout';
import './inspectorWorkspace.css';

/** Switching tabs preserves each page's local state and its underlying guest. */
export function InspectorTabPages({ tabs, activeId, children, layout = null, onResize, renderFrame, onActivate, language = 'en', workspaceId = 'shared' }: {
  workspaceId?: string;
  language?: AppLanguage;
  tabs: InspectorTab[];
  activeId: string;
  children: (tab: InspectorTab, active: boolean) => ReactNode;
  layout?: PanelLayout | null;
  onResize?: (path: string, ratio: number) => void;
  renderFrame?: (tab: InspectorTab) => ReactNode;
  onActivate?: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cancelDrag = useRef<((restore?: boolean) => void) | null>(null);
  const resize = useRef(onResize);
  resize.current = onResize;
  const rects = panelRects(layout);
  useEffect(() => () => cancelDrag.current?.(false), []);
  useEffect(() => { cancelDrag.current?.(false); }, [workspaceId]);
  useEffect(() => { if (!layout) cancelDrag.current?.(false); }, [layout]);

  const beginResize = (event: ReactPointerEvent<HTMLDivElement>, divider: ReturnType<typeof panelDividers>[number]) => {
    if (event.button !== 0 || !onResize) return;
    cancelDrag.current?.();
    const bounds = ref.current?.getBoundingClientRect();
    if (!bounds) return;
    event.preventDefault();
    const handle = event.currentTarget, pointerId = event.pointerId;
    const horizontal = divider.axis === 'x';
    const start = horizontal ? divider.rect.x : divider.rect.y;
    const size = horizontal ? divider.rect.width : divider.rect.height;
    const grabOffset = horizontal
      ? event.clientX - bounds.left - (start + size * divider.ratio) * bounds.width
      : event.clientY - bounds.top - (start + size * divider.ratio) * bounds.height;
    const update = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      const current = ref.current?.getBoundingClientRect();
      if (!current || current.width <= 0 || current.height <= 0) return;
      const position = horizontal ? (next.clientX - grabOffset - current.left) / current.width
        : (next.clientY - grabOffset - current.top) / current.height;
      resize.current?.(divider.path, (position - start) / size);
    };
    const finish = (restore = true) => {
      cancelDrag.current = null;
      document.body.classList.remove('inspector-layout-resizing');
      window.removeEventListener('pointermove', update);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', blur);
      if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
      if (restore) resize.current?.(divider.path, divider.ratio);
    };
    const release = (next: PointerEvent) => { if (next.pointerId === pointerId) { update(next); finish(false); } };
    const cancel = (next: PointerEvent) => { if (next.pointerId === pointerId) finish(); };
    const blur = () => finish();
    cancelDrag.current = finish;
    handle.setPointerCapture(pointerId);
    document.body.classList.add('inspector-layout-resizing');
    window.addEventListener('pointermove', update);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', blur);
  };
  return <div ref={ref} className={`right-inspector-tab-pages${layout ? ' tiled' : ''}`}>
    {tabs.map(tab => {
      const active = layout ? Boolean(rects[tab.id]) : tab.id === activeId, rect = rects[tab.id];
      return <section key={tab.id} data-inspector-page-id={tab.id}
        className={`right-inspector-tab-page${active ? ' active' : ''}`}
        style={layout && rect ? { left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.width * 100}%`, height: `${rect.height * 100}%` } as CSSProperties : undefined}
        role="tabpanel" aria-hidden={!active} inert={!active}
        onFocusCapture={() => { if (layout && tab.id !== activeId) onActivate?.(tab.id); }}
        onPointerDown={() => { if (layout && tab.id !== activeId) onActivate?.(tab.id); }}>
        {layout && active && renderFrame?.(tab)}
        <div className="inspector-page-content">{children(tab, active)}</div>
      </section>;
    })}
    {layout && panelDividers(layout).map(divider => <div key={divider.path} role="separator" tabIndex={0}
      aria-label={divider.axis === 'x' ? (language === 'zh' ? '调整列宽' : 'Resize columns') : (language === 'zh' ? '调整行高' : 'Resize rows')} aria-orientation={divider.axis === 'x' ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round(divider.ratio * 100)} aria-valuemin={15} aria-valuemax={85}
      className={`inspector-tile-divider axis-${divider.axis}`}
      style={divider.axis === 'x' ? { left: `${(divider.rect.x + divider.rect.width * divider.ratio) * 100}%`, top: `${divider.rect.y * 100}%`, height: `${divider.rect.height * 100}%` }
        : { top: `${(divider.rect.y + divider.rect.height * divider.ratio) * 100}%`, left: `${divider.rect.x * 100}%`, width: `${divider.rect.width * 100}%` }}
      onPointerDown={event => beginResize(event, divider)}
      onLostPointerCapture={() => cancelDrag.current?.()}
      onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); onResize?.(divider.path, divider.ratio + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -.025 : .025)); } }}
    />)}
  </div>;
}
