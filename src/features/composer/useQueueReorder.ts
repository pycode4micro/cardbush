import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

type QueueItem = { id: string };
type DropPosition = { id: string; side: 'before' | 'after' };
type DragSession = {
  id: string;
  pointerId: number;
  handle: HTMLButtonElement;
  startX: number;
  startY: number;
  x: number;
  y: number;
  active: boolean;
  drop: DropPosition | null;
  frame: number;
  cleanup: () => void;
};

/** Keep drag previews local; only commit the queue order on a valid drop. */
export function useQueueReorder(
  items: QueueItem[],
  onReorder: ((sourceId: string, targetId: string) => void) | undefined,
  disabled: boolean,
) {
  const listRef = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<DragSession | null>(null);
  const latestRef = useRef({ items, onReorder, disabled });
  latestRef.current = { items, onReorder, disabled };
  const [draggingId, setDraggingId] = useState('');
  const [dropPosition, setDropPosition] = useState<DropPosition | null>(null);

  function finish(commit = false, pointerId?: number, render = true) {
    const session = sessionRef.current;
    if (!session || (pointerId != null && session.pointerId !== pointerId)) return;
    sessionRef.current = null;
    cancelAnimationFrame(session.frame);
    session.cleanup();
    // A session switch can detach the captured handle before passive cleanup.
    if (session.handle.isConnected && session.handle.hasPointerCapture(session.pointerId)) {
      session.handle.releasePointerCapture(session.pointerId);
    }
    if (render) {
      setDraggingId('');
      setDropPosition(null);
    }
    const current = latestRef.current;
    if (!commit || !session.active || !session.drop || current.disabled || !current.onReorder) return;
    if (!current.items.some(item => item.id === session.id)) return;
    const remaining = current.items.filter(item => item.id !== session.id);
    const boundary = remaining.findIndex(item => item.id === session.drop!.id);
    if (boundary < 0) return;
    const destination = boundary + (session.drop.side === 'after' ? 1 : 0);
    const targetId = current.items[destination]?.id;
    if (targetId && targetId !== session.id) current.onReorder(session.id, targetId);
  }

  useEffect(() => () => finish(false, undefined, false), []);
  useEffect(() => {
    const session = sessionRef.current;
    if (session && (disabled || items.length < 2 || !items.some(item => item.id === session.id))) finish();
  }, [disabled, items]);

  function updateDrop(session: DragSession) {
    const list = listRef.current;
    if (!list) return;
    const bounds = list.getBoundingClientRect();
    let drop: DropPosition | null = null;
    if (session.x >= bounds.left && session.x <= bounds.right &&
      session.y >= bounds.top - 48 && session.y <= bounds.bottom + 48) {
      const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-queue-item-id]'))
        .filter(row => row.dataset.queueItemId !== session.id);
      const next = rows.find(row => {
        const rect = row.getBoundingClientRect();
        return session.y < rect.top + rect.height / 2;
      });
      const row = next ?? rows.at(-1);
      if (row?.dataset.queueItemId) {
        drop = { id: row.dataset.queueItemId, side: next ? 'before' : 'after' };
        const current = latestRef.current.items;
        const remaining = current.filter(item => item.id !== session.id);
        const destination = remaining.findIndex(item => item.id === drop!.id) + (next ? 0 : 1);
        if (current[destination]?.id === session.id) drop = null;
      }
    }
    if (session.drop?.id !== drop?.id || session.drop?.side !== drop?.side) {
      session.drop = drop;
      setDropPosition(drop);
    }
  }

  function autoScroll(session: DragSession) {
    if (sessionRef.current !== session || !session.active) return;
    const list = listRef.current;
    if (list) {
      const bounds = list.getBoundingClientRect();
      if (session.x >= bounds.left && session.x <= bounds.right &&
        session.y >= bounds.top - 48 && session.y <= bounds.bottom + 48) {
        const edge = Math.min(36, bounds.height / 3);
        const velocity = session.y < bounds.top + edge
          ? -Math.min(12, (bounds.top + edge - session.y) / 3)
          : session.y > bounds.bottom - edge
            ? Math.min(12, (session.y - bounds.bottom + edge) / 3) : 0;
        if (velocity) list.scrollTop += velocity;
      }
      updateDrop(session);
    }
    session.frame = requestAnimationFrame(() => autoScroll(session));
  }

  function onPointerDown(id: string, event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !event.isPrimary || !onReorder || disabled || items.length < 2) return;
    finish();
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const cancel = () => finish();
    const onKeyDown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.key !== 'Escape') return;
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      cancel();
    };
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', onKeyDown, true);
    sessionRef.current = {
      id, pointerId: event.pointerId, handle,
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
      active: false, drop: null, frame: 0,
      cleanup: () => {
        window.removeEventListener('blur', cancel);
        window.removeEventListener('keydown', onKeyDown, true);
      },
    };
  }

  function onPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const session = sessionRef.current;
    if (!session || event.pointerId !== session.pointerId) return;
    if (!event.buttons) { finish(); return; }
    session.x = event.clientX;
    session.y = event.clientY;
    if (!session.active) {
      if (Math.hypot(session.x - session.startX, session.y - session.startY) < 4) return;
      session.active = true;
      setDraggingId(session.id);
      autoScroll(session);
    }
    event.preventDefault();
    updateDrop(session);
  }

  return {
    listRef, draggingId, dropPosition, onPointerDown, onPointerMove,
    onPointerUp: (event: ReactPointerEvent<HTMLButtonElement>) => {
      const session = sessionRef.current;
      if (session?.pointerId === event.pointerId && session.active) {
        session.x = event.clientX;
        session.y = event.clientY;
        updateDrop(session);
      }
      finish(true, event.pointerId);
    },
    onPointerCancel: (event: ReactPointerEvent<HTMLButtonElement>) => finish(false, event.pointerId),
    moveWithKeyboard: (id: string, direction: -1 | 1) => {
      const current = latestRef.current;
      if (current.disabled) return;
      const index = current.items.findIndex(item => item.id === id);
      const target = current.items[index + direction];
      if (index >= 0 && target) current.onReorder?.(id, target.id);
    },
  };
}
