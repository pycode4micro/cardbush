import { useEffect, type RefObject } from 'react';

export function useOutsideDismiss(
  open: boolean,
  containers: readonly RefObject<HTMLElement | null>[],
  dismiss: (event?: Event) => void,
) {
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => {
      if (containers.some(ref => ref.current && event.composedPath().includes(ref.current))) return;
      dismiss(event);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss(event);
    };
    // Capture also sees clicks whose target stops propagation (players, editors).
    window.addEventListener('pointerdown', pointer, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('blur', dismiss);
    // Native webview input never bubbles through this window. The host observes
    // guest focus/mouse-down without intercepting or replaying the page's click.
    const stopGuestDismiss = window.cardbushDesktop?.onInspectorGuestActivated?.(() => dismiss());
    return () => {
      window.removeEventListener('pointerdown', pointer, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('blur', dismiss);
      stopGuestDismiss?.();
    };
  }, [open, containers, dismiss]);
}
