import type * as React from 'react';
import { useCallback, useRef } from 'react';

import type { AppLanguage } from '../types';

const defaultSidebarWidth = 272;

export function SidebarResizer({
  language,
  onWidthChange,
}: {
  language: AppLanguage;
  onWidthChange: (value: number) => void;
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

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const state = dragStateRef.current;
        if (!state) {
          return;
        }
        onWidthChange(state.startWidth + moveEvent.clientX - state.startX);
      };
      const handlePointerUp = () => {
        dragStateRef.current = null;
        document.body.classList.remove('sidebar-resizing');
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
      };
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
    },
    [onWidthChange],
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
