import { useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

type QueueItem = { id: string };
type DragSession = {
  id: string;
  pointerId: number;
  row: HTMLElement;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
  targetId: string | null;
  frame: number;
  holdTimer: number;
  preview: HTMLElement | null;
  shiftedRows: Set<HTMLElement>;
  cleanup: () => void;
};

/** Animate a local preview; the queue changes only when the pointer is released. */
export function useQueueReorder(
  items: QueueItem[],
  onReorder: ((sourceId: string, targetId: string) => void) | undefined,
  disabled: boolean,
) {
  const listRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<DragSession | null>(null);
  const latestRef = useRef({ items, onReorder, disabled });
  latestRef.current = { items, onReorder, disabled };

  function finish(commit = false, pointerId?: number) {
    const session = sessionRef.current;
    if (!session || (pointerId != null && session.pointerId !== pointerId)) return;
    sessionRef.current = null;
    cancelAnimationFrame(session.frame);
    clearTimeout(session.holdTimer);
    session.cleanup();
    session.preview?.remove();
    listRef.current?.classList.remove('is-reordering');
    document.body.classList.remove('queue-reordering');
    session.row.classList.remove('dragging');
    session.shiftedRows.forEach(row => row.style.removeProperty('--queue-reorder-offset'));
    if (session.row.isConnected && session.row.hasPointerCapture(session.pointerId)) {
      session.row.releasePointerCapture(session.pointerId);
    }
    const current = latestRef.current;
    if (!commit || !session.active || !session.targetId || current.disabled || !current.onReorder) return;
    if (current.items.some(item => item.id === session.id) && current.items.some(item => item.id === session.targetId)) {
      current.onReorder(session.id, session.targetId);
    }
  }

  useEffect(() => () => finish(), []);
  useLayoutEffect(() => {
    const session = sessionRef.current;
    if (session && (disabled || !onReorder || items.length < 2 || !items.some(item => item.id === session.id))) finish();
  }, [disabled, items, onReorder]);

  function updatePreview(session: DragSession, scroll = false) {
    const list = listRef.current;
    if (!list || !session.row.isConnected) { finish(); return; }
    if (session.preview) {
      session.preview.style.transform = `translate3d(${session.x - session.startX}px, ${session.y - session.startY}px, 0)`;
    }
    const bounds = list.getBoundingClientRect();
    const inside = session.x >= bounds.left && session.x <= bounds.right &&
      session.y >= bounds.top - 48 && session.y <= bounds.bottom + 48;
    if (scroll && inside) {
      const edge = Math.min(36, bounds.height / 3);
      const velocity = session.y < bounds.top + edge
        ? -Math.min(12, (bounds.top + edge - session.y) / 3)
        : session.y > bounds.bottom - edge
          ? Math.min(12, (session.y - bounds.bottom + edge) / 3) : 0;
      if (velocity) list.scrollTop += velocity;
    }
    // Layout offsets ignore our transforms, so animated neighbours cannot move
    // the hit-test boundaries back and forth while the pointer is stationary.
    const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-queue-item-id]'))
      .map(element => ({ element, top: element.offsetTop, height: element.offsetHeight }));
    const sourceIndex = rows.findIndex(row => row.element === session.row);
    if (sourceIndex < 0) { finish(); return; }
    const remaining = rows.filter((_, index) => index !== sourceIndex);
    const pointerY = session.y - bounds.top + list.scrollTop;
    const next = remaining.findIndex(row => pointerY < row.top + row.height / 2);
    const destination = inside ? (next < 0 ? remaining.length : next) : sourceIndex;
    session.targetId = destination === sourceIndex ? null : rows[destination].element.dataset.queueItemId ?? null;
    const reordered = [...remaining];
    reordered.splice(destination, 0, rows[sourceIndex]);
    const gap = rows.length > 1 ? rows[1].top - rows[0].top - rows[0].height : 0;
    let top = rows[0].top;
    for (const row of reordered) {
      row.element.style.setProperty('--queue-reorder-offset', `${top - row.top}px`);
      session.shiftedRows.add(row.element);
      top += row.height + gap;
    }
  }

  function animate(session: DragSession) {
    if (sessionRef.current !== session || !session.active) return;
    updatePreview(session, true);
    if (sessionRef.current === session) session.frame = requestAnimationFrame(() => animate(session));
  }

  function activate(session: DragSession) {
    if (sessionRef.current !== session || session.active) return;
    clearTimeout(session.holdTimer);
    session.active = true;
    const bounds = session.row.getBoundingClientRect();
    // An inert visual copy escapes the scrolling panel. The real row stays
    // mounted for pointer capture and reserves the full-height insertion gap.
    const preview = session.row.cloneNode(true) as HTMLElement;
    preview.className = 'runtime-queue-item runtime-queue-drag-preview';
    preview.removeAttribute('data-queue-item-id');
    preview.removeAttribute('role');
    preview.querySelectorAll('[id]').forEach(element => element.removeAttribute('id'));
    preview.setAttribute('aria-hidden', 'true');
    preview.inert = true;
    preview.dataset.queueDragPreview = session.id;
    Object.assign(preview.style, { width: `${bounds.width}px`, height: `${bounds.height}px`, left: `${bounds.left}px`, top: `${bounds.top}px` });
    (session.row.closest('.app') ?? document.body).appendChild(preview);
    // Account for the app shell's fixed-position containing block, if present.
    const placed = preview.getBoundingClientRect();
    preview.style.left = `${bounds.left + bounds.left - placed.left}px`;
    preview.style.top = `${bounds.top + bounds.top - placed.top}px`;
    session.preview = preview;
    session.row.classList.add('dragging');
    listRef.current?.classList.add('is-reordering');
    document.body.classList.add('queue-reordering');
    animate(session);
  }

  function onPointerDown(id: string, event: ReactPointerEvent<HTMLElement>) {
    if (event.button !== 0 || !event.isPrimary || !onReorder || disabled || items.length < 2) return;
    const target = event.target as HTMLElement;
    const handle = target.closest('.runtime-queue-drag-handle');
    if (!handle && target.closest('button, a, input, textarea, select')) return;
    // Touch can scroll the card body; the handle is the dedicated touch drag area.
    if (event.pointerType === 'touch' && !handle) return;
    finish();
    event.preventDefault();
    const row = event.currentTarget;
    row.setPointerCapture(event.pointerId);
    const cancel = () => finish();
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== 'Escape') return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      cancel();
    };
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    window.addEventListener('keydown', onKeyDown, true);
    const session: DragSession = {
      id, pointerId: event.pointerId, row,
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
      active: false, targetId: null, frame: 0, holdTimer: 0, preview: null, shiftedRows: new Set(),
      cleanup: () => {
        window.removeEventListener('blur', cancel);
        window.removeEventListener('resize', cancel);
        window.removeEventListener('keydown', onKeyDown, true);
      },
    };
    sessionRef.current = session;
    // Holding lifts the card; an intentional drag starts immediately as well.
    session.holdTimer = window.setTimeout(() => activate(session), 180);
  }

  function onPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const session = sessionRef.current;
    if (!session || event.pointerId !== session.pointerId) return;
    if (!event.buttons) { finish(); return; }
    session.x = event.clientX;
    session.y = event.clientY;
    if (!session.active && Math.hypot(session.x - session.startX, session.y - session.startY) >= 4) activate(session);
    if (session.active) event.preventDefault();
  }

  return {
    listRef, onPointerDown, onPointerMove,
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
      const session = sessionRef.current;
      if (session?.pointerId === event.pointerId && session.active) {
        session.x = event.clientX;
        session.y = event.clientY;
        updatePreview(session);
      }
      finish(true, event.pointerId);
    },
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => finish(false, event.pointerId),
    moveWithKeyboard: (id: string, direction: -1 | 1) => {
      const current = latestRef.current;
      if (current.disabled || sessionRef.current) return;
      const index = current.items.findIndex(item => item.id === id);
      const target = current.items[index + direction];
      if (index >= 0 && target) current.onReorder?.(id, target.id);
    },
  };
}
