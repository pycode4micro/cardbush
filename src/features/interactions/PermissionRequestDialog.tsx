import { useEffect, useRef, type ComponentProps } from 'react';
import { uiText } from '../../i18n';
import { InteractionCard } from './InteractionCard';

export function PermissionRequestDialog(props: ComponentProps<typeof InteractionCard>) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    node?.showModal();
    node?.querySelector<HTMLElement>('summary')?.focus({ preventScroll: true });
    return () => { node?.close(); if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  return <dialog className="permission-request-dialog" ref={dialog}
    aria-label={uiText(props.language)('permissionRequestCard.approvalRequired')} onCancel={event => event.preventDefault()}>
    <InteractionCard {...props} />
  </dialog>;
}
