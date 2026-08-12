import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from 'react';

const minimumInspectorWidth = 380;

export function RightInspectorResizer({
  width,
  onWidthChange,
  label,
}: {
  width: number;
  onWidthChange: (width: number) => void;
  label: string;
}) {
  const dragRef = useRef<{ x: number; width: number } | null>(null);

  const beginResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragRef.current = { x: event.clientX, width };
    document.body.classList.add('right-inspector-resizing');

    const finish = () => {
      dragRef.current = null;
      document.body.classList.remove('right-inspector-resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
    };
    const move = (moveEvent: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const mainWidth = document.querySelector<HTMLElement>('.main-stage')
        ?.getBoundingClientRect().width ?? 560;
      const inspectorWidth = document.querySelector<HTMLElement>('.right-inspector')
        ?.getBoundingClientRect().width ?? drag.width;
      const maximumWidth = Math.max(minimumInspectorWidth, mainWidth + inspectorWidth - 560);
      onWidthChange(Math.min(maximumWidth, Math.max(
        minimumInspectorWidth,
        drag.width + drag.x - moveEvent.clientX,
      )));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
  }, [onWidthChange, width]);

  return (
    <div
      className="right-inspector-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={label}
      onPointerDown={beginResize}
    />
  );
}
