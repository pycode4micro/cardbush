import type * as React from 'react';
import { useCallback, useRef } from 'react';

import type { AppLanguage } from '../types';

const defaultSidebarWidth = 272;
const minimumSidebarWidth = 220;
const collapseSidebarWidthThreshold = 180;
const maximumSidebarWidth = 420;

type SidebarDragState = {
  startX: number;
  startWidth: number;
  currentWidth: number;
  pointerId: number;
  scope: HTMLElement;
  animationFrame: number;
  pendingWidth: number;
};

export function SidebarResizer({
  language,
  onWidthChange,
  onResizeEnd,
  onCollapse,
  softVisible = true,
}: {
  language: AppLanguage;
  onWidthChange: (value: number) => void;
  onResizeEnd?: (value: number, shouldCollapse: boolean) => void;
  onCollapse?: () => void;
  softVisible?: boolean;
}) {
  const dragStateRef = useRef<SidebarDragState | null>(null);

  const beginResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const scope = document.querySelector<HTMLElement>('.app') ?? document.documentElement;
      const currentWidth = readCurrentSidebarWidth(event.currentTarget);
      dragStateRef.current = {
        startX: event.clientX,
        startWidth: currentWidth,
        currentWidth,
        pointerId: event.pointerId,
        scope,
        animationFrame: 0,
        pendingWidth: currentWidth,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.classList.add('sidebar-resizing');

      const endResize = (restoreWidth = false) => {
        const state = dragStateRef.current;
        if (state?.animationFrame) {
          window.cancelAnimationFrame(state.animationFrame);
        }
        if (state && restoreWidth) {
          writePreviewWidth(state.scope, state.startWidth);
        }
        dragStateRef.current = null;
        document.body.classList.remove('sidebar-resizing');
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
        window.removeEventListener('pointercancel', handlePointerCancel);
      };
      const handlePointerMove = (moveEvent: PointerEvent) => {
        const state = dragStateRef.current;
        if (!state || moveEvent.pointerId !== state.pointerId) {
          return;
        }
        const nextWidth = clampPreviewWidth(
          state.startWidth + moveEvent.clientX - state.startX,
          Boolean(onCollapse),
        );
        state.currentWidth = nextWidth;
        state.pendingWidth = nextWidth;
        const shouldCollapseNow = Boolean(
          onCollapse
          && nextWidth < collapseSidebarWidthThreshold
          && nextWidth < state.startWidth,
        );
        if (shouldCollapseNow) {
          writePreviewWidth(state.scope, nextWidth);
          endResize();
          onResizeEnd?.(nextWidth, true);
          onCollapse?.();
          return;
        }
        if (!state.animationFrame) {
          state.animationFrame = window.requestAnimationFrame(() => {
            const latest = dragStateRef.current;
            if (!latest) return;
            latest.animationFrame = 0;
            writePreviewWidth(latest.scope, latest.pendingWidth);
          });
        }
      };
      const handlePointerUp = (upEvent: PointerEvent) => {
        const state = dragStateRef.current;
        if (!state || upEvent.pointerId !== state.pointerId) {
          return;
        }
        writePreviewWidth(state.scope, state.currentWidth);
        endResize();
        if (onResizeEnd) {
          onResizeEnd(state.currentWidth, false);
        } else {
          onWidthChange(state.currentWidth);
        }
      };
      const handlePointerCancel = () => endResize(true);
      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
      window.addEventListener('pointercancel', handlePointerCancel);
    },
    [onCollapse, onResizeEnd, onWidthChange],
  );

  return (
    <div
      className={`sidebar-resizer soft-panel-motion ${softVisible ? 'soft-panel-visible' : 'soft-panel-hidden'}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={language === 'zh' ? '调整侧边栏宽度' : 'Resize sidebar'}
      title={language === 'zh' ? '拖动调整侧边栏宽度' : 'Drag to resize sidebar'}
      onPointerDown={beginResize}
    />
  );
}

function readCurrentSidebarWidth(resizer: HTMLElement) {
  const renderedSidebar = resizer.previousElementSibling;
  if (renderedSidebar instanceof HTMLElement) {
    const renderedWidth = renderedSidebar.getBoundingClientRect().width;
    if (renderedWidth > 0) return renderedWidth;
  }
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

function clampPreviewWidth(value: number, canCollapse: boolean) {
  return Math.max(
    canCollapse ? 0 : minimumSidebarWidth,
    Math.min(maximumSidebarWidth, value),
  );
}

function writePreviewWidth(scope: HTMLElement, width: number) {
  scope.style.setProperty('--sidebar-width', `${width}px`);
}
