import { useCallback, useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { panelCollapseWidth } from './panelSizing';

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
  onCollapse,
  softVisible = true,
  label,
}: {
  width: number;
  windowMaximized: boolean;
  onWidthChange: (width: number) => void;
  onCollapse?: () => void;
  softVisible?: boolean;
  label: string;
}) {
  const handleRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<InspectorDragState | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelRef.current?.(), []);
  useLayoutEffect(() => {
    if (!softVisible) {
      cancelRef.current?.();
      return;
    }
    // A snap keeps its transient width through the exit animation. Restore the
    // saved width before reopening, including when the exit is interrupted.
    const scope = handleRef.current?.closest<HTMLElement>('.right-inspector');
    if (scope && !dragRef.current) writePreviewWidth(scope, width);
  }, [softVisible, width]);

  const beginResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !softVisible) return;
    cancelRef.current?.();
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
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
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
      cancelRef.current = null;
      document.body.classList.remove('right-inspector-resizing');
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerCancel);
      window.removeEventListener('blur', handleWindowBlur);
      if (state && handle.isConnected && handle.hasPointerCapture(state.pointerId)) {
        handle.releasePointerCapture(state.pointerId);
      }
    };
    const handlePointerMove = (moveEvent: PointerEvent) => {
      const state = dragRef.current;
      if (!state || moveEvent.pointerId !== state.pointerId) {
        return;
      }
      const nextWidth = clampPreviewWidth(
        state.startWidth + state.startX - moveEvent.clientX,
        state.maximumWidth,
        Boolean(onCollapse),
      );
      state.currentWidth = nextWidth;
      state.pendingWidth = nextWidth;
      if (onCollapse && nextWidth < panelCollapseWidth && nextWidth < state.startWidth) {
        writePreviewWidth(state.scope, nextWidth);
        finish();
        onCollapse();
        return;
      }
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
      const finalWidth = Math.max(minimumInspectorWidth, state.currentWidth);
      finish();
      writePreviewWidth(state.scope, finalWidth);
      onWidthChange(finalWidth);
    };
    const handlePointerCancel = (event: PointerEvent) => {
      if (event.pointerId === dragRef.current?.pointerId) finish(true);
    };
    const handleWindowBlur = () => finish(true);
    cancelRef.current = handleWindowBlur;
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerCancel);
    window.addEventListener('blur', handleWindowBlur);
  }, [onCollapse, onWidthChange, softVisible, width, windowMaximized]);

  return (
    <div
      ref={handleRef}
      className="right-inspector-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={label}
      onPointerDown={beginResize}
      onLostPointerCapture={() => cancelRef.current?.()}
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

function clampPreviewWidth(value: number, maximumWidth: number, canCollapse: boolean) {
  return Math.max(canCollapse ? 0 : minimumInspectorWidth, Math.min(maximumWidth, value));
}

function writePreviewWidth(scope: HTMLElement, width: number) {
  scope.style.setProperty('--right-inspector-width', `${width}px`);
}
