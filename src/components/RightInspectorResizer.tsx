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
  scaleX: number;
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
  onExpand,
  softVisible = true,
  label,
}: {
  width: number;
  windowMaximized: boolean;
  onWidthChange: (width: number) => void;
  onCollapse?: () => void;
  onExpand?: () => void;
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
    const bounds = scope.getBoundingClientRect();
    const scaleX = bounds.width / scope.offsetWidth || 1;
    const currentWidth = bounds.width > 0 ? bounds.width / scaleX : width;
    const shell = scope.closest<HTMLElement>('.desktop-shell');
    const compact = getComputedStyle(scope).position === 'absolute';
    // Docked panes can shrink the conversation continuously down to the cover
    // threshold. Compact overlays retain their existing 48px edge allowance.
    const availableWidth = compact
      ? (shell?.clientWidth ?? window.innerWidth) - 48
      : currentWidth + (shell?.querySelector('.main-stage')?.getBoundingClientRect().width ?? 0) / scaleX;
    dragRef.current = {
      startX: event.clientX,
      startWidth: currentWidth,
      scaleX,
      currentWidth,
      maximumWidth: onExpand ? availableWidth : readMaximumInspectorWidth(currentWidth, windowMaximized, scaleX),
      pointerId: event.pointerId,
      scope,
      animationFrame: 0,
      pendingWidth: currentWidth,
    };
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    // If the reveal animation is still running, freeze at the visible width
    // before disabling transitions; otherwise the boundary jumps on press.
    writePreviewWidth(scope, currentWidth);
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
      if (onExpand && moveEvent.clientX <= (shell?.getBoundingClientRect().left ?? 0) + 24 * state.scaleX) {
        finish(true);
        onExpand();
        return;
      }
      const nextWidth = clampPreviewWidth(
        state.startWidth + (state.startX - moveEvent.clientX) / state.scaleX,
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
      // The final pointer location can arrive without a preceding move event.
      handlePointerMove(upEvent);
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
  }, [onCollapse, onExpand, onWidthChange, softVisible, width, windowMaximized]);

  return (
    <div
      ref={handleRef}
      className="right-inspector-resizer"
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      title={label}
      onPointerDown={beginResize}
      onDoubleClick={onExpand}
      onKeyDown={event => {
        if (event.key === 'Home' && onExpand) { event.preventDefault(); onExpand(); }
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); onWidthChange(width + (event.key === 'ArrowLeft' ? 40 : -40)); }
      }}
      onLostPointerCapture={() => cancelRef.current?.()}
    />
  );
}

function readMaximumInspectorWidth(currentWidth: number, windowMaximized: boolean, scaleX: number) {
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
      mainWidth / scaleX + currentWidth - minimumConversationPaneWidth,
    ),
  );
}

function clampPreviewWidth(value: number, maximumWidth: number, canCollapse: boolean) {
  return Math.max(canCollapse ? 0 : minimumInspectorWidth, Math.min(maximumWidth, value));
}

function writePreviewWidth(scope: HTMLElement, width: number) {
  scope.style.setProperty('--right-inspector-width', `${width}px`);
}
