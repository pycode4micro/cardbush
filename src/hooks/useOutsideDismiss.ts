import { useEffect, type RefObject } from 'react';

export function useOutsideDismiss(
  open: boolean,
  containers: readonly RefObject<HTMLElement | null>[],
  dismiss: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => {
      if (containers.some(ref => ref.current && event.composedPath().includes(ref.current))) return;
      dismiss();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss();
    };
    // Capture also sees clicks whose target stops propagation (players, editors).
    window.addEventListener('pointerdown', pointer, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', dismiss);
    return () => {
      window.removeEventListener('pointerdown', pointer, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', dismiss);
    };
  }, [open, containers, dismiss]);
}
