import type * as React from 'react';
import { useCallback, useRef } from 'react';

import type { AppLanguage } from '../types';

const defaultSidebarWidth = 272;
const collapseSidebarWidthThreshold = 220;

export function SidebarResizer({
  language,
  onWidthChange,
  onCollapse,
}: {
  language: AppLanguage;
  onWidthChange: (value: number) => void;
  onCollapse?: () => void;
}) {
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const beginResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragStateRef.current = {
        startX: event.clientX,
        startWidth: readCurrentSidebarWidth(),
      };
      document.body.classList.add('sidebar-resizing');

      const endResize = () => {
        dragStateRef.current = null;
        document.body.classList.remove('sidebar-resizing');
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
      };
      const handlePointerMove = (moveEvent: PointerEvent) => {
        const state = dragStateRef.current;
        if (!state) {
          return;
        }
        const nextWidth = state.startWidth + moveEvent.clientX - state.startX;
        if (onCollapse && nextWidth < collapseSidebarWidthThreshold) {
          onCollapse();
          endResize();
          return;
        }
        onWidthChange(nextWidth);
      };
      const handlePointerUp = () => {
        endResize();
      };
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
    },
    [onCollapse, onWidthChange],
  );

  return (
    <div
      className="sidebar-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={language === 'zh' ? '调整侧边栏宽度' : 'Resize sidebar'}
      title={language === 'zh' ? '拖动调整侧边栏宽度' : 'Drag to resize sidebar'}
      onPointerDown={beginResize}
    />
  );
}

function readCurrentSidebarWidth() {
  const scope = document.querySelector<HTMLElement>('.app') ?? document.documentElement;
  const raw = getComputedStyle(scope)
    .getPropertyValue('--sidebar-width')
    .trim();
  const fromRoot = Number.parseFloat(raw);
  if (Number.isFinite(fromRoot)) {
    return fromRoot;
  }
  const sidebar = document.querySelector<HTMLElement>('.sidebar, .settings-sidebar');
  return sidebar?.getBoundingClientRect().width ?? defaultSidebarWidth;
}
