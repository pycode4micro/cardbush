import { ChevronLeft, ChevronRight, Maximize, Minus, Plus, X } from 'lucide-react';
import { useKeyboardShortcuts } from '../shortcuts/useKeyboardShortcuts';
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

import type { AppLanguage } from '../../types';
import { openFileContextMenu } from '../../shared/fileContextMenu';
import { useImageGallery } from './useImageGallery';
import { ConversationHostContext } from '../conversationHost';
import { useConversationFileSource } from '../conversationFileSource';
import { galleryImageKey, type ImageGalleryScope, type ImagePreviewSource } from './imageGallery';
export type { ImagePreviewSource } from './imageGallery';

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

type ImageView = { zoom: number; x: number; y: number; fitted: boolean };
type ImageGeometry = { width: number; height: number; viewportWidth: number; viewportHeight: number };

function fitZoom(geometry: ImageGeometry) {
  if (!geometry.width || !geometry.height || !geometry.viewportWidth || !geometry.viewportHeight) return 1;
  return Math.min(1, Math.max(1, geometry.viewportWidth - 32) / geometry.width,
    Math.max(1, geometry.viewportHeight - 32) / geometry.height);
}

function constrainView(view: ImageView, geometry: ImageGeometry): ImageView {
  if (view.fitted) return { zoom: fitZoom(geometry), x: 0, y: 0, fitted: true };
  const limitX = Math.max(0, (geometry.width * view.zoom - (geometry.viewportWidth - 32)) / 2);
  const limitY = Math.max(0, (geometry.height * view.zoom - (geometry.viewportHeight - 32)) / 2);
  return { ...view, x: Math.max(-limitX, Math.min(limitX, view.x)), y: Math.max(-limitY, Math.min(limitY, view.y)) };
}

function clampZoom(value: number, geometry: ImageGeometry) {
  return Math.min(maximumZoom, Math.max(Math.min(minimumZoom, fitZoom(geometry)), value));
}

function previewNaturalSize(image: ImagePreviewSource) {
  const width = image.naturalWidth ?? 0, height = image.naturalHeight ?? 0;
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height } : { width: 0, height: 0 };
}

export function ImagePreviewDialog({
  image: initialImage,
  images,
  initialScope,
  language,
  onClose,
}: {
  image: ImagePreviewSource;
  images?: ImagePreviewSource[];
  initialScope?: ImageGalleryScope;
  language: AppLanguage;
  onClose: () => void;
}) {
  const gallery = useImageGallery(initialImage, { images, initialScope, onClose });
  const { image } = gallery;
  const host = useContext(ConversationHostContext);
  const remoteSource = useConversationFileSource(host ? image.path || image.src : image.src);
  const imageKey = galleryImageKey(image);
  const dialogRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const keyboardShortcuts = useKeyboardShortcuts();
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<ImageDragState | null>(null);
  const viewRef = useRef<ImageView>({ zoom: 1, x: 0, y: 0, fitted: true });
  const geometryRef = useRef<ImageGeometry>({ width: 0, height: 0, viewportWidth: 0, viewportHeight: 0 });
  const [view, setView] = useState(viewRef.current);
  const [naturalSize, setNaturalSize] = useState(() => previewNaturalSize(image));
  const [stageSize, setStageSize] = useState({ width: 0, height: 0 });
  const [dragging, setDragging] = useState(false);
  const [failed, setFailed] = useState(false);
  const [fallback, setFallback] = useState<{ key: string; src: string } | null>(null);
  const currentKey = useRef(imageKey);
  currentKey.current = imageKey;
  const source = host ? remoteSource.source || undefined : fallback?.key === imageKey ? fallback.src : image.src;

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus({ preventScroll: true });
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);

  const updateView = useCallback((next: ImageView) => {
    const constrained = constrainView(next, geometryRef.current);
    viewRef.current = constrained;
    setView(current => current.zoom === constrained.zoom && current.x === constrained.x && current.y === constrained.y && current.fitted === constrained.fitted ? current : constrained);
  }, []);

  const fitToWindow = useCallback(() => updateView({ zoom: 1, x: 0, y: 0, fitted: true }), [updateView]);

  const applyZoom = useCallback((value: number, focalPoint?: { x: number; y: number }) => {
    const current = viewRef.current;
    const geometry = geometryRef.current;
    const next = clampZoom(Math.round(value * 100) / 100, geometry);
    if (!geometry.width || !geometry.height) return;
    const dx = focalPoint ? focalPoint.x - geometry.viewportWidth / 2 : 0;
    const dy = focalPoint ? focalPoint.y - geometry.viewportHeight / 2 : 0;
    const ratio = next / current.zoom;
    // Commit scale and focal-point positioning together, before the same paint.
    updateView({ zoom: next, x: dx - (dx - current.x) * ratio, y: dy - (dy - current.y) * ratio, fitted: false });
  }, [updateView]);

  useLayoutEffect(() => {
    viewRef.current = { zoom: 1, x: 0, y: 0, fitted: true };
    setView(viewRef.current);
    setFailed(false);
    dragRef.current = null;
    setDragging(false);
    const element = imageRef.current;
    // Cached images may finish loading before passive effects run. Never erase that observation.
    setNaturalSize(element?.complete && element.naturalWidth > 0
      ? { width: element.naturalWidth, height: element.naturalHeight }
      : previewNaturalSize(image));
  }, [imageKey, image.src]);

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
        event.stopImmediatePropagation();
        onClose();
        return;
      }
      if (event.key === 'Tab') {
        const controls = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), select') ?? [])];
        const current = controls.indexOf(document.activeElement as HTMLElement);
        if (current < 0 || (event.shiftKey && current === 0) || (!event.shiftKey && current === controls.length - 1)) {
          event.preventDefault();
          controls[event.shiftKey ? controls.length - 1 : 0]?.focus();
        }
        event.stopPropagation();
        return;
      }
      if ((event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !event.ctrlKey && !event.metaKey && !event.altKey &&
        !(event.target instanceof HTMLSelectElement)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        gallery.move(event.key === 'ArrowLeft' ? -1 : 1);
        return;
      }
      const isZoomIn = keyboardShortcuts.matches('imageZoomIn', event);
      const isZoomOut = keyboardShortcuts.matches('imageZoomOut', event);
      const isReset = keyboardShortcuts.matches('imageReset', event);
      if (!isZoomIn && !isZoomOut && !isReset) return;
      event.preventDefault();
      event.stopPropagation();
      if (isReset) fitToWindow();
      else applyZoom(viewRef.current.zoom + (isZoomIn ? zoomStep : -zoomStep));
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [applyZoom, fitToWindow, keyboardShortcuts, onClose, gallery.move]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.deltaY && (!event.shiftKey || event.ctrlKey || event.metaKey)) {
        const bounds = stage.getBoundingClientRect();
        applyZoom(viewRef.current.zoom + (event.deltaY < 0 ? zoomStep : -zoomStep),
          { x: event.clientX - bounds.left, y: event.clientY - bounds.top });
      } else {
        // Keep horizontal gestures and Shift+wheel available for panning.
        const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? stage.clientHeight : 1;
        const dx = event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX;
        const dy = event.shiftKey && !event.deltaX ? 0 : event.deltaY;
        updateView({ ...viewRef.current, x: viewRef.current.x - dx * unit, y: viewRef.current.y - dy * unit });
      }
    };
    // Consume the wheel here so image zoom cannot scroll the conversation or zoom the app.
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
    updateView({ ...viewRef.current, x: drag.x + event.clientX - drag.startX, y: drag.y + event.clientY - drag.startY });
    event.preventDefault();
  }, [updateView]);

  const ready = !failed && naturalSize.width > 0 && naturalSize.height > 0 && stageSize.width > 0 && stageSize.height > 0;
  // Keep the image plane at its natural resolution. 100% is one source pixel
  // per CSS pixel, not a magnification of the fitted thumbnail.
  const canvasWidth = ready ? naturalSize.width : 0;
  const canvasHeight = ready ? naturalSize.height : 0;
  const fitScale = fitZoom({ width: canvasWidth, height: canvasHeight, viewportWidth: stageSize.width, viewportHeight: stageSize.height });
  const zoom = view.fitted ? fitScale : view.zoom;
  const percentage = Math.round(zoom * 100);

  useLayoutEffect(() => {
    geometryRef.current = { width: canvasWidth, height: canvasHeight, viewportWidth: stageSize.width, viewportHeight: stageSize.height };
    updateView(viewRef.current);
  }, [canvasWidth, canvasHeight, stageSize.width, stageSize.height, updateView]);

  return createPortal(
    <div className="modal-backdrop image-preview-backdrop" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        tabIndex={-1}
        className="image-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={language === 'zh' ? `图片预览：${image.name}` : `Image preview: ${image.name}`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <strong title={image.path ?? image.name}>{image.name}</strong>
          {gallery.scopes.length > 0 && <select className="image-preview-scope" value={gallery.scope}
            aria-label={language === 'zh' ? '图片范围' : 'Image scope'}
            onChange={event => gallery.changeScope(event.target.value as ImageGalleryScope)}>
            {gallery.scopes.map(scope => <option key={scope} value={scope}>{({
              session: language === 'zh' ? '会话' : 'Conversation',
              attachments: language === 'zh' ? '附件' : 'Attachments',
              directory: language === 'zh' ? '目录' : 'Folder',
              workspace: language === 'zh' ? '工作区' : 'Workspace',
            })[scope]}</option>)}
          </select>}
          <span className="image-preview-position" aria-live="polite">{gallery.index + 1} / {gallery.images.length}{gallery.loading || gallery.more ? '+' : ''}</span>
          <div className="image-preview-zoom-controls" aria-label={language === 'zh' ? '图片缩放' : 'Image zoom'}>
            <button
              type="button"
              onClick={() => applyZoom(viewRef.current.zoom - zoomStep)}
              disabled={!ready || zoom <= Math.min(minimumZoom, fitScale)}
              aria-label={language === 'zh' ? '缩小图片' : 'Zoom out'}
              title={[language === 'zh' ? '缩小' : 'Zoom out', keyboardShortcuts.label('imageZoomOut')].filter(Boolean).join(' · ')}
              aria-keyshortcuts={keyboardShortcuts.aria('imageZoomOut')}
            >
              <Minus size={15} />
            </button>
            <button
              className="image-preview-zoom-value"
              type="button"
              onClick={() => applyZoom(1)}
              disabled={!ready}
              aria-label={language === 'zh' ? '原始尺寸（100%）' : 'Actual size (100%)'}
              title={language === 'zh' ? '按原始尺寸查看（100%）' : 'View at actual size (100%)'}
            >
              {percentage}%
            </button>
            <button
              type="button"
              onClick={() => applyZoom(viewRef.current.zoom + zoomStep)}
              disabled={!ready || zoom >= maximumZoom}
              aria-label={language === 'zh' ? '放大图片' : 'Zoom in'}
              title={[language === 'zh' ? '放大' : 'Zoom in', keyboardShortcuts.label('imageZoomIn')].filter(Boolean).join(' · ')}
              aria-keyshortcuts={keyboardShortcuts.aria('imageZoomIn')}
            >
              <Plus size={15} />
            </button>
            <button
              type="button"
              onClick={fitToWindow}
              disabled={!ready}
              aria-label={language === 'zh' ? '恢复适应窗口' : 'Fit to window'}
              aria-pressed={view.fitted}
              title={[language === 'zh' ? '适应窗口' : 'Fit to window', keyboardShortcuts.label('imageReset')].filter(Boolean).join(' · ')}
              aria-keyshortcuts={keyboardShortcuts.aria('imageReset')}
            >
              <Maximize size={15} />
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
        {(gallery.loading || gallery.error || gallery.skipped > 0 || gallery.more) && <div className="image-preview-gallery-status" role="status">
          <span>{gallery.error ? (language === 'zh' ? '无法读取图片列表，可继续查看已有图片。' : 'Unable to read the image list. Available images can still be viewed.')
            : gallery.loading ? (language === 'zh' ? '正在查找图片…' : 'Finding images…')
            : gallery.skipped ? (language === 'zh' ? '部分目录无法读取。' : 'Some folders could not be read.') : ''}</span>
          {gallery.more && <button type="button" onClick={gallery.loadMore}>{language === 'zh' ? '加载更多' : 'Load more'}</button>}
          {gallery.error && <button type="button" onClick={gallery.retry}>{language === 'zh' ? '重试' : 'Retry'}</button>}
        </div>}
        <div
          ref={stageRef}
          className={`image-preview-stage${dragging ? ' is-dragging' : ''}`}
          title={language === 'zh' ? '滚轮缩放 · 拖动查看' : 'Scroll to zoom · Drag to pan'}
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
            if (viewRef.current.zoom === 1) fitToWindow();
            else applyZoom(1, { x: event.clientX - bounds.left, y: event.clientY - bounds.top });
          }}
          onContextMenu={host ? undefined : event => openFileContextMenu(event, image.path ?? '', { image: true, language })}
        >
          {gallery.images.length > 1 && <div className="image-preview-navigation"
            onPointerDown={event => event.stopPropagation()} onDoubleClick={event => event.stopPropagation()}>
            <button type="button" disabled={gallery.index === 0} onClick={() => gallery.move(-1)}
              aria-label={language === 'zh' ? '上一张图片' : 'Previous image'} title="←"><ChevronLeft size={22} /></button>
            <button type="button" disabled={gallery.index === gallery.images.length - 1} onClick={() => gallery.move(1)}
              aria-label={language === 'zh' ? '下一张图片' : 'Next image'} title="→"><ChevronRight size={22} /></button>
          </div>}
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
              key={imageKey}
              src={source}
              alt={image.name}
              draggable={false}
              decoding="sync"
              onError={() => {
                const read = host ? undefined : window.cardbushDesktop?.readImageDataUrl;
                if (read && image.path && !/^(?:https?:|data:|blob:)/i.test(image.path) && !source?.startsWith('data:')) {
                  void read(image.path).then(src => {
                    if (currentKey.current !== imageKey) return;
                    if (src.startsWith('data:image/')) setFallback({ key: imageKey, src });
                    else setFailed(true);
                  }).catch(() => { if (currentKey.current === imageKey) setFailed(true); });
                } else setFailed(true);
              }}
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
