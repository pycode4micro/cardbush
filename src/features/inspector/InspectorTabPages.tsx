import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';
import type { InspectorTab } from './inspectorTabs';
import type { AppLanguage } from '../../types';
import { panelDividers, panelRects, type PanelLayout } from './panelLayout';
import './inspectorWorkspace.css';

/** Switching tabs preserves each page's local state and its underlying guest. */
export function InspectorTabPages({ tabs, activeId, children, layout = null, onResize, renderFrame, onActivate, language = 'en' }: {
  language?: AppLanguage;
  tabs: InspectorTab[];
  activeId: string;
  children: (tab: InspectorTab, active: boolean) => ReactNode;
  layout?: PanelLayout | null;
  onResize?: (path: string, ratio: number) => void;
  renderFrame?: (tab: InspectorTab) => ReactNode;
  onActivate?: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null), dragging = useRef<{ path: string; ratio: number } | null>(null);
  const rects = panelRects(layout);
  useEffect(() => () => document.body.classList.remove('inspector-layout-resizing'), []);
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
      onPointerDown={event => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); dragging.current = { path: divider.path, ratio: divider.ratio }; document.body.classList.add('inspector-layout-resizing'); }}
      onPointerMove={event => { if (dragging.current?.path !== divider.path || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
        const bounds = ref.current?.getBoundingClientRect(); if (!bounds) return;
        const value = divider.axis === 'x' ? ((event.clientX - bounds.left) / bounds.width - divider.rect.x) / divider.rect.width
          : ((event.clientY - bounds.top) / bounds.height - divider.rect.y) / divider.rect.height;
        onResize?.(divider.path, value);
      }}
      onPointerUp={event => { dragging.current = null; document.body.classList.remove('inspector-layout-resizing'); event.currentTarget.releasePointerCapture(event.pointerId); }}
      onPointerCancel={() => { if (dragging.current) onResize?.(dragging.current.path, dragging.current.ratio); dragging.current = null; document.body.classList.remove('inspector-layout-resizing'); }}
      onLostPointerCapture={() => { dragging.current = null; document.body.classList.remove('inspector-layout-resizing'); }}
      onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) { event.preventDefault(); onResize?.(divider.path, divider.ratio + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -.025 : .025)); } }}
    />)}
  </div>;
}
