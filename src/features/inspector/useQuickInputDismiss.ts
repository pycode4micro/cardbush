import { useEffect } from 'react';

export const hasOpenModal = () => Array.from(document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"][aria-modal="true"]'))
  .some(element => element.checkVisibility());

/** Portaled menus and modal close clicks belong to the input, not the page behind it. */
export function useQuickInputDismiss(enabled: boolean, onDismiss: () => void, escape = false) {
  useEffect(() => {
    if (!enabled) return;
    const inside = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest(
      '.inspector-cover-controls, .inspector-region-conversation, .composer-popover, .composer-command-portal, .turn-change-preview, .modal-backdrop, dialog[open], [role="dialog"][aria-modal="true"], .voice-dialog, .voice-mini, .voice-floating-composer',
    ));
    const outsidePointer = (event: PointerEvent) => {
      if (!hasOpenModal() && !inside(event.target)) onDismiss();
    };
    // Native guest clicks do not bubble into the host document. Preserve modal
    // ownership before and after their deferred focus transfer.
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    const guestFocus = () => {
      clearTimeout(focusTimer);
      if (hasOpenModal()) return;
      focusTimer = setTimeout(() => {
        const target = document.activeElement;
        if (!hasOpenModal() && target?.matches('webview, iframe') && !inside(target)) onDismiss();
      }, 0);
    };
    const keydown = (event: KeyboardEvent) => {
      if (!escape || event.key !== 'Escape' || event.defaultPrevented || event.isComposing || hasOpenModal()) return;
      event.preventDefault(); onDismiss();
    };
    document.addEventListener('pointerdown', outsidePointer, true);
    document.addEventListener('focusin', guestFocus, true);
    window.addEventListener('blur', guestFocus);
    window.addEventListener('keydown', keydown);
    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener('pointerdown', outsidePointer, true);
      document.removeEventListener('focusin', guestFocus, true);
      window.removeEventListener('blur', guestFocus);
      window.removeEventListener('keydown', keydown);
    };
  }, [enabled, onDismiss, escape]);
}
