import { useLayoutEffect, useRef, useState } from 'react';
import type { AppLanguage } from '../../types';
import { BuiltinComponentSurface } from './BuiltinComponentSurface';
import { HtmlComponentSurface } from './HtmlComponentSurface';
import { componentTitle, isBuiltinComponent, type ComponentItem } from './componentModel';
import { layoutPoint, layoutSpace } from './welcomeLayoutGeometry';
import { ComposerPortalContext } from '../composer/ComposerPortalContext';

export function WelcomeComponentPreview({ item, language, anchor }: { item: ComponentItem; language: AppLanguage; anchor: HTMLElement }) {
  const preview = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0, width: 280, maxHeight: 280, visible: false });
  useLayoutEffect(() => {
    const root = preview.current?.parentElement;
    if (!root) return;
    const place = () => {
      const space = layoutSpace(root), menu = anchor.closest('.welcome-layout-menu')!.getBoundingClientRect();
      const start = layoutPoint(space, menu.left, menu.top), end = layoutPoint(space, menu.right, menu.bottom);
      const row = layoutPoint(space, anchor.getBoundingClientRect().left, anchor.getBoundingClientRect().top);
      const toolbar = anchor.closest('.welcome-layout-toolbar')!, bar = toolbar.getBoundingClientRect();
      const above = toolbar.classList.contains('menus-above');
      const minTop = above ? (root.querySelector<HTMLElement>('.topbar')?.offsetHeight ?? 50) + 8 : layoutPoint(space, bar.left, bar.bottom).y + 8;
      const maxBottom = above ? layoutPoint(space, bar.left, bar.top).y - 8 : space.height - 12;
      const maxHeight = Math.max(0, maxBottom - minTop);
      const width = Math.min(280, space.width - 24), height = Math.min(maxHeight, preview.current?.offsetHeight ?? 240);
      const beside = end.x + width + 10 <= space.width - 12 || start.x - width - 10 >= 12;
      const left = end.x + width + 10 <= space.width - 12 ? end.x + 10 : start.x - width - 10 >= 12 ? start.x - width - 10 : 12;
      const top = beside ? row.y : start.y - height - 10 >= minTop ? start.y - height - 10 : end.y + 10;
      setPosition({ left, top: Math.max(minTop, Math.min(maxBottom - height, top)), width, maxHeight, visible: true });
    };
    place();
    const observer = new ResizeObserver(place); observer.observe(root); observer.observe(preview.current!);
    window.addEventListener('resize', place); root.addEventListener('scroll', place, true);
    return () => { observer.disconnect(); window.removeEventListener('resize', place); root.removeEventListener('scroll', place, true); };
  }, [anchor]);
  return <div ref={preview} className="welcome-component-preview" role="tooltip" id="welcome-component-preview"
    style={{ left: position.left, top: position.top, width: position.width, maxHeight: position.maxHeight, visibility: position.visible ? 'visible' : 'hidden' }}>
    <div className="welcome-preview-heading"><span>{componentTitle(item, language)}</span><span>{language === 'zh' ? '预览' : 'Preview'}</span></div>
    <div className="welcome-preview-surface" inert>
      <ComposerPortalContext.Provider value={null}>
        {isBuiltinComponent(item) ? <BuiltinComponentSurface component={item} language={language} preview/> : <HtmlComponentSurface component={item} active={false}/>}
      </ComposerPortalContext.Provider>
    </div>
  </div>;
}
