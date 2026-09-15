import { useCallback, useEffect, useState } from 'react';
import { useKeyboardShortcuts } from '../shortcuts/useKeyboardShortcuts';

/** Owned by App so search remains available with the sidebar collapsed. */
export function useConversationSearch() {
  const [open, setOpen] = useState(false);
  const shortcuts = useKeyboardShortcuts();
  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !shortcuts.matches('searchConversations', event)) return;
      if (event.target instanceof Element && event.target.closest(
        '[inert], dialog, [role="dialog"], [data-shortcut-recorder]',
      )) return;
      event.preventDefault();
      show();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [shortcuts, show]);

  return { open, show, close };
}
