import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

/** Move a read-only copy of the title/address row; native page guests stay mounted. */
export function useInspectorTileDrag(tabId: string, onSwap: (from: string, x: number, y: number) => void) {
  const cancelDrag = useRef<(() => void) | null>(null);
  const swap = useRef(onSwap); swap.current = onSwap;
  useEffect(() => () => cancelDrag.current?.(), []);

  const beginDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const target = event.target as Element;
    if (target.closest('button, input, a, select, textarea, [contenteditable]') && !target.closest('.inspector-tile-drag')) return;
    event.preventDefault();
    cancelDrag.current?.();
    const frame = event.currentTarget, pointerId = event.pointerId;
    const pages = frame.closest('.right-inspector-tab-pages');
    const startX = event.clientX, startY = event.clientY;
    let preview: HTMLElement | undefined, destination: HTMLElement | undefined;
    let animationFrame = 0, x = startX, y = startY, scaleX = 1, scaleY = 1;
    const clearDestination = () => { destination?.removeAttribute('data-tile-drop-target'); destination = undefined; };
    const paint = () => {
      animationFrame = 0;
      if (!preview) return;
      preview.style.transform = `translate3d(${(x - startX) / scaleX}px, ${(y - startY) / scaleY}px, 0)`;
      const next = Array.from(pages?.querySelectorAll<HTMLElement>(':scope > .right-inspector-tab-page.active') ?? []).find(page => {
        const rect = page.getBoundingClientRect();
        return page.dataset.inspectorPageId !== tabId && x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom;
      });
      if (next !== destination) { clearDestination(); destination = next; destination?.setAttribute('data-tile-drop-target', ''); }
    };
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      x = next.clientX; y = next.clientY;
      if (!preview && Math.hypot(x - startX, y - startY) > 5) {
        const bounds = frame.getBoundingClientRect();
        preview = frame.cloneNode(true) as HTMLElement;
        preview.classList.add('inspector-tile-drag-preview');
        preview.inert = true;
        preview.setAttribute('aria-hidden', 'true');
        preview.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
        preview.style.width = `${frame.offsetWidth}px`;
        (frame.closest('.app') ?? document.body).append(preview);
        const origin = preview.getBoundingClientRect();
        scaleX = origin.width / preview.offsetWidth || 1;
        scaleY = origin.height / preview.offsetHeight || 1;
        preview.style.left = `${(bounds.left - origin.left) / scaleX}px`;
        preview.style.top = `${(bounds.top - origin.top) / scaleY}px`;
        frame.setAttribute('data-tile-drag-source', '');
      }
      if (preview && !animationFrame) animationFrame = requestAnimationFrame(paint);
    };
    const finish = () => {
      cancelDrag.current = null;
      cancelAnimationFrame(animationFrame);
      preview?.remove(); clearDestination(); frame.removeAttribute('data-tile-drag-source');
      document.body.classList.remove('inspector-layout-resizing', 'inspector-tile-dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', escape, true);
      window.removeEventListener('blur', finish);
      if (frame.isConnected && frame.hasPointerCapture(pointerId)) frame.releasePointerCapture(pointerId);
    };
    const release = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      const moved = Math.hypot(next.clientX - startX, next.clientY - startY) > 5;
      finish();
      if (moved) swap.current(tabId, next.clientX, next.clientY);
    };
    const cancel = (next: PointerEvent) => { if (next.pointerId === pointerId) finish(); };
    const escape = (next: KeyboardEvent) => {
      if (next.key === 'Escape' && !next.isComposing) { next.preventDefault(); finish(); }
    };
    cancelDrag.current = finish;
    frame.setPointerCapture(pointerId);
    document.body.classList.add('inspector-layout-resizing', 'inspector-tile-dragging');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', escape, true);
    window.addEventListener('blur', finish);
  };
  return { onPointerDown: beginDrag, onLostPointerCapture: () => cancelDrag.current?.() };
}
