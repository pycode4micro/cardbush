import { useCallback, useEffect, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';

const storageKey = 'cardbush.inspector_cover_position';
type Position = { x: number; y: number };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));

function readPosition(): Position {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? 'null');
    if (Number.isFinite(value?.x) && Number.isFinite(value?.y)) return { x: clamp(value.x, 0, 1), y: clamp(value.y, 0, 1) };
  } catch { /* A missing preference uses the bottom-center position. */ }
  return { x: .5, y: 1 };
}

/** Anchor the capsule, then fit the input independently so opening it never moves the capsule. */
export function useInspectorCoverPosition(inputOpen: boolean, inert: boolean) {
  const root = useRef<HTMLDivElement>(null), capsule = useRef<HTMLDivElement>(null);
  const position = useRef<Position | null>(null);
  position.current ??= readPosition();
  const geometry = useRef({ minX: 0, maxX: 0, minY: 0, maxY: 0, scaleX: 1, scaleY: 1, left: 0, top: 0 });
  const drag = useRef<{ id: number; capture: HTMLElement; x: number; y: number; left: number; top: number; origin: Position; moved: boolean } | null>(null);
  const suppressPointerClick = useRef(false);

  const layout = useCallback(() => {
    const host = root.current, bar = capsule.current;
    if (!host || !bar) return;
    const bounds = host.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const pane = host.parentElement?.querySelector('.right-inspector')?.getBoundingClientRect() ?? bounds;
    const scaleX = bounds.width / host.clientWidth || 1, scaleY = bounds.height / host.clientHeight || 1;
    const left = Math.max(0, (pane.left - bounds.left) / scaleX) + 16;
    const right = Math.min(host.clientWidth, (pane.right - bounds.left) / scaleX) - 16;
    const top = Math.max(0, (pane.top - bounds.top) / scaleY) + 16;
    const bottom = Math.min(host.clientHeight, (pane.bottom - bounds.top) / scaleY) - 16;
    const width = bar.offsetWidth, height = bar.offsetHeight;
    const maxX = Math.max(left, right - width), maxY = Math.max(top, bottom - height);
    const x = left + (maxX - left) * position.current!.x;
    const y = top + (maxY - top) * position.current!.y;
    geometry.current = { minX: left, maxX, minY: top, maxY, scaleX, scaleY, left: x, top: y };
    Object.assign(bar.style, { left: `${x}px`, top: `${y}px`, bottom: 'auto', transform: 'none' });
    const above = Math.max(0, y - top - 10), below = Math.max(0, bottom - y - height - 10);
    const upwards = above >= below;
    const panelWidth = Math.max(0, Math.min(680, right - left));
    host.dataset.expands = upwards ? 'above' : 'below';
    host.style.setProperty('--quick-input-left', `${clamp(x + width / 2 - panelWidth / 2, left, right - panelWidth)}px`);
    host.style.setProperty('--quick-input-width', `${panelWidth}px`);
    host.style.setProperty('--quick-input-top', upwards ? 'auto' : `${y + height + 10}px`);
    host.style.setProperty('--quick-input-bottom', upwards ? `${host.clientHeight - y + 10}px` : 'auto');
    host.style.setProperty('--quick-input-max-height', `${upwards ? above : below}px`);
  }, []);

  const save = useCallback(() => { try { localStorage.setItem(storageKey, JSON.stringify(position.current)); } catch { /* Optional preference. */ } }, []);
  const move = useCallback((x: number, y: number) => {
    const g = geometry.current;
    position.current = {
      x: g.maxX > g.minX ? (clamp(x, g.minX, g.maxX) - g.minX) / (g.maxX - g.minX) : .5,
      y: g.maxY > g.minY ? (clamp(y, g.minY, g.maxY) - g.minY) / (g.maxY - g.minY) : 1,
    };
    layout();
  }, [layout]);
  const finish = useCallback((cancel = false) => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    suppressPointerClick.current = cancel || current.moved;
    if (cancel) { position.current = current.origin; layout(); }
    else if (current.moved) save();
    document.body.classList.remove('inspector-cover-pointer-active', 'inspector-cover-dragging');
    if (current.capture.hasPointerCapture(current.id)) current.capture.releasePointerCapture(current.id);
  }, [layout, save]);

  useLayoutEffect(() => {
    layout();
    const observer = new ResizeObserver(layout);
    for (const node of [root.current, capsule.current, root.current?.parentElement?.querySelector('.right-inspector')]) {
      if (node) observer.observe(node);
    }
    window.addEventListener('resize', layout);
    return () => { observer.disconnect(); window.removeEventListener('resize', layout); };
  }, [layout, inputOpen, inert]);
  useEffect(() => {
    const cancel = () => finish(true);
    const pointerMove = (event: globalThis.PointerEvent) => {
      const current = drag.current;
      if (!current || event.pointerId !== current.id) return;
      const dx = (event.clientX - current.x) / geometry.current.scaleX, dy = (event.clientY - current.y) / geometry.current.scaleY;
      if (!current.moved) {
        if (Math.hypot(dx, dy) < 4) return;
        current.moved = true;
        document.body.classList.add('inspector-cover-dragging');
        root.current?.querySelectorAll<HTMLElement>('[popover]:popover-open').forEach(menu => menu.hidePopover());
      }
      move(current.left + dx, current.top + dy);
    };
    const pointerUp = (event: globalThis.PointerEvent) => { if (event.pointerId === drag.current?.id) finish(); };
    const pointerCancel = (event: globalThis.PointerEvent) => { if (event.pointerId === drag.current?.id) cancel(); };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (drag.current && event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
    };
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('pointermove', pointerMove, true);
    window.addEventListener('pointerup', pointerUp, true);
    window.addEventListener('pointercancel', pointerCancel, true);
    return () => {
      cancel(); window.removeEventListener('blur', cancel); window.removeEventListener('keydown', escape, true);
      window.removeEventListener('pointermove', pointerMove, true); window.removeEventListener('pointerup', pointerUp, true);
      window.removeEventListener('pointercancel', pointerCancel, true);
    };
  }, [finish, move]);
  useEffect(() => { if (inert) finish(true); }, [inert, finish]);

  return { root, capsule, handlers: {
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      if (!event.isPrimary || event.button !== 0 || inert || drag.current) return;
      suppressPointerClick.current = false;
      layout();
      const { left, top } = geometry.current;
      // Keep the native click on the pressed button (including its icon),
      // while retaining pointer events outside the capsule during a drag.
      const capture = (event.target as Element).closest('button') ?? event.currentTarget;
      drag.current = { id: event.pointerId, capture, x: event.clientX, y: event.clientY,
        left, top, origin: { ...position.current! }, moved: false };
      capture.setPointerCapture(event.pointerId);
      // A native webview would otherwise swallow the first move outside the pill.
      document.body.classList.add('inspector-cover-pointer-active');
    },
    onClickCapture(event: MouseEvent<HTMLDivElement>) {
      if (event.detail !== 0 && suppressPointerClick.current) {
        event.preventDefault(); event.stopPropagation();
      }
    },
    onLostPointerCapture(event: PointerEvent<HTMLDivElement>) {
      if (event.target === drag.current?.capture && event.pointerId === drag.current.id) finish(true);
    },
    onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      if (event.key === 'Home') position.current = { x: .5, y: 1 };
      else {
        const step = event.shiftKey ? 48 : 16, g = geometry.current;
        move(g.left + (event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0),
          g.top + (event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0));
      }
      layout(); save();
    },
  } };
}
