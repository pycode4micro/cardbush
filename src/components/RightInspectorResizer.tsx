import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from 'react';

import {
  conversationPaneMinimum,
  inspectorMaximum,
  minimumInspectorWidth,
} from './rightInspectorSizing';

type InspectorDragState = {
  startX: number;
  startWidth: number;
  currentWidth: number;
  maximumWidth: number;
  pointerId: number;
  scope: HTMLElement;
  animationFrame: number;
  pendingWidth: number;
};

export function RightInspectorResizer({
  width,
  windowMaximized,
  onWidthChange,
  label,
}: {
  width: number;
  windowMaximized: boolean;
  onWidthChange: (width: number) => void;
  label: string;
}) {
  const dragRef = useRef<InspectorDragState | null>(null);

  const beginResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const scope = event.currentTarget.closest<HTMLElement>('.right-inspector');
    if (!scope) {
      return;
    }
    const currentWidth = readCurrentInspectorWidth(scope, width);
    dragRef.current = {
      startX: event.clientX,
      startWidth: currentWidth,
      currentWidth,
      maximumWidth: readMaximumInspectorWidth(currentWidth, windowMaximized),
      pointerId: event.pointerId,
      scope,
      animationFrame: 0,
      pendingWidth: currentWidth,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add('right-inspector-resizing');

    const finish = (restoreWidth = false) => {
      const state = dragRef.current;
      if (state?.animationFrame) {
        window.cancelAnimationFrame(state.animationFrame);
      }
      if (state && restoreWidth) {
        writePreviewWidth(state.scope, state.startWidth);
      }
      dragRef.current = null;
      document.body.classList.remove('right-inspector-resizing');
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
    };
    const handlePointerMove = (moveEvent: PointerEvent) => {
      const state = dragRef.current;
      if (!state || moveEvent.pointerId !== state.pointerId) {
        return;
      }
      const nextWidth = clampPreviewWidth(
        state.startWidth + state.startX - moveEvent.clientX,
        state.maximumWidth,
      );
      state.currentWidth = nextWidth;
      state.pendingWidth = nextWidth;
      if (!state.animationFrame) {
        state.animationFrame = window.requestAnimationFrame(() => {
          const latest = dragRef.current;
          if (!latest) return;
          latest.animationFrame = 0;
          writePreviewWidth(latest.scope, latest.pendingWidth);
        });
      }
    };
    const handlePointerUp = (upEvent: PointerEvent) => {
      const state = dragRef.current;
      if (!state || upEvent.pointerId !== state.pointerId) {
        return;
      }
      const finalWidth = state.currentWidth;
      writePreviewWidth(state.scope, finalWidth);
      finish();
      onWidthChange(finalWidth);
    };
    const handlePointerCancel = () => finish(true);
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
  }, [onWidthChange, width, windowMaximized]);

  return (
    <div
      className="right-inspector-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={label}
      onPointerDown={beginResize}
    />
  );
}

function readCurrentInspectorWidth(scope: HTMLElement, fallbackWidth: number) {
  const currentWidth = scope.getBoundingClientRect().width;
  return Number.isFinite(currentWidth) && currentWidth > 0
    ? currentWidth
    : fallbackWidth;
}

function readMaximumInspectorWidth(currentWidth: number, windowMaximized: boolean) {
  const minimumConversationPaneWidth = conversationPaneMinimum(
    windowMaximized,
    window.innerWidth,
  );
  const mainWidth = document.querySelector<HTMLElement>('.main-stage')
    ?.getBoundingClientRect().width ?? minimumConversationPaneWidth;
  return Math.min(
    inspectorMaximum(windowMaximized, window.innerWidth),
    Math.max(
      minimumInspectorWidth,
      mainWidth + currentWidth - minimumConversationPaneWidth,
    ),
  );
}

function clampPreviewWidth(value: number, maximumWidth: number) {
  return Math.max(minimumInspectorWidth, Math.min(maximumWidth, value));
}

function writePreviewWidth(scope: HTMLElement, width: number) {
  scope.style.setProperty('--right-inspector-width', `${width}px`);
}
