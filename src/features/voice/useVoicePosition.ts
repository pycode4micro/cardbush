import { useLayoutEffect, useRef, useState, type PointerEvent, type KeyboardEvent } from 'react';

/** Viewport CSS pixels throughout, including mixed DPI and resized app windows. */
export function useVoicePosition(visible: boolean, variant: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number }>();
  const drag = useRef<{ id: number; x: number; y: number; left: number; top: number } | undefined>(undefined);
  const moved = useRef(false);
  const clamp = (x: number, y: number) => {
    const rect = ref.current?.getBoundingClientRect();
    const next = { x: Math.max(8, Math.min(x, innerWidth - (rect?.width ?? 0) - 8)), y: Math.max(8, Math.min(y, innerHeight - (rect?.height ?? 0) - 8)) };
    setPosition(previous => previous?.x === next.x && previous?.y === next.y ? previous : next);
  };
  useLayoutEffect(() => {
    if (!visible || !ref.current) return;
    const resize = () => { const rect = ref.current?.getBoundingClientRect(); if (rect) clamp(rect.left, rect.top); };
    if (position) resize();
    const observer = new ResizeObserver(resize); observer.observe(ref.current);
    window.addEventListener('resize', resize);
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); };
  }, [visible, variant]);
  return { ref, style: position ? { position: 'fixed' as const, left: position.x, top: position.y, right: 'auto', bottom: 'auto', margin: 0 } : undefined,
    moved,
    handlers: {
      onPointerDown(event: PointerEvent<HTMLElement>) {
        if (event.button !== 0 || (event.target as Element).closest('button,input,select,textarea,a')) return;
        const rect = ref.current?.getBoundingClientRect(); if (!rect) return;
        moved.current = false;
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
        event.currentTarget.setPointerCapture(event.pointerId);
      },
      onPointerMove(event: PointerEvent<HTMLElement>) {
        const origin = drag.current; if (!origin || origin.id !== event.pointerId) return;
        const dx = event.clientX - origin.x, dy = event.clientY - origin.y;
        if (Math.hypot(dx, dy) < 4 && !moved.current) return;
        moved.current = true; clamp(origin.left + dx, origin.top + dy);
      },
      onPointerUp() { drag.current = undefined; },
      onPointerCancel() { drag.current = undefined; },
      onLostPointerCapture() { drag.current = undefined; },
      onKeyDown(event: KeyboardEvent<HTMLElement>) {
        if (event.target !== event.currentTarget || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault(); const rect = ref.current?.getBoundingClientRect(); if (!rect) return;
        clamp(rect.left + (event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0), rect.top + (event.key === 'ArrowUp' ? -16 : event.key === 'ArrowDown' ? 16 : 0));
      },
    },
  };
}
