import { Minus, Plus, X } from 'lucide-react';
import {
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import type { AppLanguage } from '../../types';

export type ImagePreviewSource = {
  src: string;
  name: string;
  path?: string;
};

const minimumZoom = 0.25;
const maximumZoom = 5;
const zoomStep = 0.25;

type ImageDragState = {
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
};

function clampZoom(value: number) {
  return Math.min(maximumZoom, Math.max(minimumZoom, value));
}

export function ImagePreviewDialog({
  image,
  language,
  onClose,
}: {
  image: ImagePreviewSource;
  language: AppLanguage;
  onClose: () => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<ImageDragState | null>(null);
  const zoomRef = useRef(1);
  const [zoom, setZoom] = useState(1);
  const [naturalSize, setNaturalSize] = useState({ width: 0, height: 0 });
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState(false);

  const applyZoom = useCallback((value: number, focalPoint?: { x: number; y: number }) => {
    const current = zoomRef.current;
    const next = clampZoom(Math.round(value * 100) / 100);
    if (next === current) return;

    const stage = stageRef.current;
    const point = stage
      ? focalPoint ?? { x: stage.clientWidth / 2, y: stage.clientHeight / 2 }
      : null;
    const contentPoint = stage && point
      ? { x: stage.scrollLeft + point.x, y: stage.scrollTop + point.y }
      : null;

    zoomRef.current = next;
    setZoom(next);

    if (stage && point && contentPoint) {
      const ratio = next / current;
      window.requestAnimationFrame(() => {
        stage.scrollLeft = contentPoint.x * ratio - point.x;
        stage.scrollTop = contentPoint.y * ratio - point.y;
      });
    }
  }, []);

  useEffect(() => {
    zoomRef.current = 1;
    setZoom(1);
    setNaturalSize({ width: 0, height: 0 });
  }, [image.src]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateSize = () => {
      setStageSize({ width: stage.clientWidth, height: stage.clientHeight });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(stage);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (!event.ctrlKey && !event.metaKey) return;
      const isZoomIn = event.key === '+' || event.key === '=' || event.code === 'NumpadAdd';
      const isZoomOut = event.key === '-' || event.key === '_' || event.code === 'NumpadSubtract';
      const isReset = event.key === '0' || event.code === 'Numpad0';
      if (!isZoomIn && !isZoomOut && !isReset) return;
      event.preventDefault();
      event.stopPropagation();
      applyZoom(isReset ? 1 : zoomRef.current + (isZoomIn ? zoomStep : -zoomStep));
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [applyZoom, onClose]);

  const handleWheel = useCallback((event: ReactWheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    applyZoom(
      zoomRef.current + (event.deltaY < 0 ? zoomStep : -zoomStep),
      { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
    );
  }, [applyZoom]);

  const finishDrag = useCallback((stage: HTMLDivElement, pointerId: number) => {
    if (dragRef.current?.pointerId !== pointerId) return;
    dragRef.current = null;
    setDragging(false);
    if (stage.hasPointerCapture(pointerId)) {
      stage.releasePointerCapture(pointerId);
    }
  }, []);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const stage = event.currentTarget;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: stage.scrollLeft,
      scrollTop: stage.scrollTop,
    };
    stage.setPointerCapture(event.pointerId);
    setDragging(true);
    event.preventDefault();
  }, []);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.currentTarget.scrollLeft = drag.scrollLeft - (event.clientX - drag.startX);
    event.currentTarget.scrollTop = drag.scrollTop - (event.clientY - drag.startY);
    event.preventDefault();
  }, []);

  const availableWidth = Math.max(1, stageSize.width - 32);
  const availableHeight = Math.max(1, stageSize.height - 32);
  const fitScale = naturalSize.width > 0 && naturalSize.height > 0
    ? Math.min(1, availableWidth / naturalSize.width, availableHeight / naturalSize.height)
    : 1;
  const canvasWidth = naturalSize.width > 0
    ? Math.max(1, Math.round(naturalSize.width * fitScale * zoom))
    : undefined;
  const canvasHeight = naturalSize.height > 0
    ? Math.max(1, Math.round(naturalSize.height * fitScale * zoom))
    : undefined;
  const percentage = Math.round(zoom * 100);

  return createPortal(
    <div className="modal-backdrop image-preview-backdrop" onMouseDown={onClose}>
      <section
        className="image-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={language === 'zh' ? `图片预览：${image.name}` : `Image preview: ${image.name}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <strong title={image.path ?? image.name}>{image.name}</strong>
          <div className="image-preview-zoom-controls" aria-label={language === 'zh' ? '图片缩放' : 'Image zoom'}>
            <button
              type="button"
              onClick={() => applyZoom(zoomRef.current - zoomStep)}
              disabled={zoom <= minimumZoom}
              aria-label={language === 'zh' ? '缩小图片' : 'Zoom out'}
              title={language === 'zh' ? '缩小（Ctrl -）' : 'Zoom out (Ctrl -)'}
            >
              <Minus size={15} />
            </button>
            <button
              className="image-preview-zoom-value"
              type="button"
              onClick={() => applyZoom(1)}
              aria-label={language === 'zh' ? '恢复适应窗口' : 'Fit to window'}
              title={language === 'zh' ? '适应窗口（Ctrl 0）' : 'Fit to window (Ctrl 0)'}
            >
              {percentage}%
            </button>
            <button
              type="button"
              onClick={() => applyZoom(zoomRef.current + zoomStep)}
              disabled={zoom >= maximumZoom}
              aria-label={language === 'zh' ? '放大图片' : 'Zoom in'}
              title={language === 'zh' ? '放大（Ctrl +）' : 'Zoom in (Ctrl +)'}
            >
              <Plus size={15} />
            </button>
          </div>
          <button
            className="image-preview-close"
            type="button"
            onClick={onClose}
            aria-label={language === 'zh' ? '关闭预览' : 'Close preview'}
          >
            <X size={16} />
          </button>
        </header>
        <div
          ref={stageRef}
          className={`image-preview-stage${dragging ? ' is-dragging' : ''}`}
          onWheel={handleWheel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={(event) => finishDrag(event.currentTarget, event.pointerId)}
          onPointerCancel={(event) => finishDrag(event.currentTarget, event.pointerId)}
          onLostPointerCapture={(event) => {
            if (dragRef.current?.pointerId === event.pointerId) {
              dragRef.current = null;
              setDragging(false);
            }
          }}
          onDoubleClick={() => applyZoom(zoomRef.current === 1 ? 2 : 1)}
        >
          <div
            className="image-preview-canvas"
            style={{ width: canvasWidth, height: canvasHeight }}
          >
            <img
              src={image.src}
              alt={image.name}
              draggable={false}
              onLoad={(event) => {
                setNaturalSize({
                  width: event.currentTarget.naturalWidth,
                  height: event.currentTarget.naturalHeight,
                });
              }}
            />
          </div>
        </div>
      </section>
    </div>,
    document.body,
  );
}
