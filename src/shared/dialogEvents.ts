import type { ReactEventHandler } from 'react';

/** File inputs bubble cancel; React also propagates events across portals.
 * Only the dialog that owns a cancel/close event may dismiss its state. */
export function dialogEventHandler(handle: ReactEventHandler<HTMLDialogElement>): ReactEventHandler<HTMLDialogElement> {
  return event => {
    if (event.target !== event.currentTarget) return;
    event.stopPropagation();
    // React owns dismissal. Do not also run the browser's default close after
    // this callback unmounts the dialog and exposes its parent.
    if (event.type === 'cancel') event.preventDefault();
    handle(event);
  };
}
