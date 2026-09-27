import { useLayoutEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { focusEditor } from '../shared/editorFocus';
import './confirm-action.css';

type Confirmation = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
};

let open = false;

/** Keep confirmation and keyboard focus in the renderer, including on Windows. */
export function confirmAction(options: Confirmation): Promise<boolean> {
  // One confirmation must never authorize a second, different action.
  if (open) return Promise.resolve(false);
  open = true;
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const surface = previous?.closest('.app, .cardling-desktop')
    ?? document.querySelector('.app, .cardling-desktop') ?? document.body;
  const container = document.createElement('div');
  surface.append(container);
  const root = createRoot(container);
  return new Promise(resolve => {
    let finished = false;
    const finish = (confirmed: boolean) => {
      if (finished) return;
      finished = true;
      // Unmount outside React's event/commit stack, before resuming the action.
      queueMicrotask(() => {
        root.unmount();
        container.remove();
        open = false;
        resolve(confirmed);
      });
    };
    root.render(<ConfirmationDialog {...options} previous={previous} onFinish={finish} />);
  });
}

function ConfirmationDialog({ title, message, confirmLabel, cancelLabel, previous, onFinish }:
  Confirmation & { previous: HTMLElement | null; onFinish(confirmed: boolean): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const node = dialog.current!;
    node.showModal();
    cancel.current?.focus({ preventScroll: true });
    return () => {
      const ownsFocus = node.contains(document.activeElement);
      node.close();
      if (!ownsFocus) return;
      // Context-menu items disappear before this dialog opens. Return to the
      // visible composer in that case, rather than a removed menu element.
      const target = previous?.isConnected && previous.checkVisibility() && !previous.closest('[inert]')
        && previous !== document.body ? previous
        : Array.from(document.querySelectorAll<HTMLElement>('[data-composer-input]'))
          .find(element => element.checkVisibility() && !element.closest('[inert]'));
      if (target) focusEditor(target);
    };
  }, []);
  return <dialog ref={dialog} className="confirm-action-dialog" aria-labelledby="confirm-action-title"
    aria-describedby="confirm-action-message" onCancel={event => { event.preventDefault(); onFinish(false); }}
    onClose={() => onFinish(false)} onKeyDown={event => event.stopPropagation()}>
    <h2 id="confirm-action-title">{title}</h2>
    <p id="confirm-action-message">{message}</p>
    <footer>
      <button ref={cancel} type="button" className="secondary-button" onClick={() => onFinish(false)}>{cancelLabel}</button>
      <button type="button" className="danger" onClick={() => onFinish(true)}>{confirmLabel}</button>
    </footer>
  </dialog>;
}
