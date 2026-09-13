import { Minus, Plus, X } from 'lucide-react';
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import type { AppLanguage } from '../../types';
import { openFileContextMenu } from '../../shared/fileContextMenu';

export type ImagePreviewSource = {
  src: string;
  name: string;
  path?: string;
  naturalWidth?: number;
  naturalHeight?: number;
};

const minimumZoom = 0.25;
const maximumZoom = 5;
const zoomStep = 0.25;

type ImageDragState = {
  pointerId: number;
  startX: number;
  startY: number;
  x: number;
  y: number;
};

type ImageView = { zoom: number; x: number; y: number };
type ImageGeometry = { width: number; height: number; viewportWidth: number; viewportHeight: number };

function constrainView(view: ImageView, geometry: ImageGeometry): ImageView {
  const limitX = Math.max(0, (geometry.width * view.zoom - (geometry.viewportWidth - 32)) / 2);
  const limitY = Math.max(0, (geometry.height * view.zoom - (geometry.viewportHeight - 32)) / 2);
  return { zoom: view.zoom, x: Math.max(-limitX, Math.min(limitX, view.x)), y: Math.max(-limitY, Math.min(limitY, view.y)) };
}

function clampZoom(value: number) {
  return Math.min(maximumZoom, Math.max(minimumZoom, value));
}

function previewNaturalSize(image: ImagePreviewSource) {
  const width = image.naturalWidth ?? 0, height = image.naturalHeight ?? 0;
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height } : { width: 0, height: 0 };
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
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<ImageDragState | null>(null);
  const viewRef = useRef<ImageView>({ zoom: 1, x: 0, y: 0 });
  const geometryRef = useRef<ImageGeometry>({ width: 0, height: 0, viewportWidth: 0, viewportHeight: 0 });
  const [view, setView] = useState(viewRef.current);
  const [naturalSize, setNaturalSize] = useState(() => previewNaturalSize(image));
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState(false);
  const [failed, setFailed] = useState(false);
  const { zoom } = view;

  const updateView = useCallback((next: ImageView) => {
    const constrained = constrainView(next, geometryRef.current);
    viewRef.current = constrained;
    setView(current => current.zoom === constrained.zoom && current.x === constrained.x && current.y === constrained.y ? current : constrained);
  }, []);

  const applyZoom = useCallback((value: number, focalPoint?: { x: number; y: number }) => {
    const current = viewRef.current;
    const next = clampZoom(Math.round(value * 100) / 100);
    const geometry = geometryRef.current;
    if (next === current.zoom || !geometry.width || !geometry.height) return;
    const dx = focalPoint ? focalPoint.x - geometry.viewportWidth / 2 : 0;
    const dy = focalPoint ? focalPoint.y - geometry.viewportHeight / 2 : 0;
    const ratio = next / current.zoom;
    // Commit scale and focal-point positioning together, before the same paint.
    updateView({ zoom: next, x: dx - (dx - current.x) * ratio, y: dy - (dy - current.y) * ratio });
  }, [updateView]);

  useLayoutEffect(() => {
    viewRef.current = { zoom: 1, x: 0, y: 0 };
    setView(viewRef.current);
    setFailed(false);
    dragRef.current = null;
    setDragging(false);
    const element = imageRef.current;
    // Cached images may finish loading before passive effects run. Never erase that observation.
    setNaturalSize(element?.complete && element.naturalWidth > 0
      ? { width: element.naturalWidth, height: element.naturalHeight }
      : previewNaturalSize(image));
  }, [image.src]);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateSize = () => {
      const width = stage.clientWidth, height = stage.clientHeight;
      setStageSize(current => current.width === width && current.height === height ? current : { width, height });
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
      applyZoom(isReset ? 1 : viewRef.current.zoom + (isZoomIn ? zoomStep : -zoomStep));
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [applyZoom, onClose]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.ctrlKey || event.metaKey) {
        if (!event.deltaY) return;
        const bounds = stage.getBoundingClientRect();
        applyZoom(viewRef.current.zoom + (event.deltaY < 0 ? zoomStep : -zoomStep),
          { x: event.clientX - bounds.left, y: event.clientY - bounds.top });
      } else {
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1;
        const dx = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
        const dy = event.shiftKey && !event.deltaX ? 0 : event.deltaY;
        updateView({ ...viewRef.current, x: viewRef.current.x - dx * unit, y: viewRef.current.y - dy * unit });
      }
    };
    // React's delegated wheel listener is passive; use a cancellable listener so Ctrl+wheel cannot zoom the app.
    stage.addEventListener('wheel', handleWheel, { passive: false });
    return () => stage.removeEventListener('wheel', handleWheel);
  }, [applyZoom, updateView]);

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
      x: viewRef.current.x,
      y: viewRef.current.y,
    };
    stage.setPointerCapture(event.pointerId);
    setDragging(true);
    event.preventDefault();
  }, []);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    updateView({ zoom: viewRef.current.zoom, x: drag.x + event.clientX - drag.startX, y: drag.y + event.clientY - drag.startY });
    event.preventDefault();
  }, [updateView]);

  const availableWidth = Math.max(1, stageSize.width - 32);
  const availableHeight = Math.max(1, stageSize.height - 32);
  const ready = !failed && naturalSize.width > 0 && naturalSize.height > 0 && stageSize.width > 0 && stageSize.height > 0;
  const fitScale = ready
    ? Math.min(1, availableWidth / naturalSize.width, availableHeight / naturalSize.height)
    : 1;
  const canvasWidth = ready
    ? Math.max(1, Math.round(naturalSize.width * fitScale))
    : 0;
  const canvasHeight = ready
    ? Math.max(1, Math.round(naturalSize.height * fitScale))
    : 0;
  const percentage = Math.round(zoom * 100);

  useLayoutEffect(() => {
    geometryRef.current = { width: canvasWidth, height: canvasHeight, viewportWidth: stageSize.width, viewportHeight: stageSize.height };
    updateView(viewRef.current);
  }, [canvasWidth, canvasHeight, stageSize.width, stageSize.height, updateView]);

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
              onClick={() => applyZoom(viewRef.current.zoom - zoomStep)}
              disabled={!ready || zoom <= minimumZoom}
              aria-label={language === 'zh' ? '缩小图片' : 'Zoom out'}
              title={language === 'zh' ? '缩小（Ctrl -）' : 'Zoom out (Ctrl -)'}
            >
              <Minus size={15} />
            </button>
            <button
              className="image-preview-zoom-value"
              type="button"
              onClick={() => applyZoom(1)}
              disabled={!ready}
              aria-label={language === 'zh' ? '恢复适应窗口' : 'Fit to window'}
              title={language === 'zh' ? '适应窗口（Ctrl 0）' : 'Fit to window (Ctrl 0)'}
            >
              {percentage}%
            </button>
            <button
              type="button"
              onClick={() => applyZoom(viewRef.current.zoom + zoomStep)}
              disabled={!ready || zoom >= maximumZoom}
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
            title={language === 'zh' ? '关闭预览（Esc）' : 'Close preview (Esc)'}
          >
            <X size={16} />
          </button>
        </header>
        <div
          ref={stageRef}
          className={`image-preview-stage${dragging ? ' is-dragging' : ''}`}
          aria-busy={!ready && !failed}
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
          onDoubleClick={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect();
            applyZoom(viewRef.current.zoom === 1 ? 2 : 1, { x: event.clientX - bounds.left, y: event.clientY - bounds.top });
          }}
          onContextMenu={event => openFileContextMenu(event, image.path ?? '', { image: true, language })}
        >
          {!ready && <p className="image-preview-status" role="status">{failed
            ? language === 'zh' ? '图片无法预览' : 'Image preview unavailable'
            : language === 'zh' ? '正在加载图片…' : 'Loading image…'}</p>}
          <div
            className="image-preview-canvas"
            style={{ width: canvasWidth, height: canvasHeight, visibility: ready ? 'visible' : 'hidden',
              transform: `translate3d(${(stageSize.width - canvasWidth * zoom) / 2 + view.x}px, ${(stageSize.height - canvasHeight * zoom) / 2 + view.y}px, 0) scale(${zoom})` }}
          >
            <img
              ref={imageRef}
              src={image.src}
              alt={image.name}
              draggable={false}
              decoding="sync"
              onError={() => setFailed(true)}
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
    // Escape message containment while retaining the application's live theme tokens.
    document.querySelector('.app') ?? document.body,
  );
}
