import { uiText } from '../../i18n';
import { useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { dialogEventHandler } from '../../shared/dialogEvents';
import type { AppLanguage } from '../../types';
import './settingsFormDialog.css';

/** Shared settings form shell; the caller owns its draft and persistence. */
export function SettingsFormDialog({ id, className = '', title, description, language, busy = false, onCancel, onSubmit, children, footer }: {
  id?: string; className?: string; title: string; description?: string; language: AppLanguage; busy?: boolean;
  onCancel: () => void; onSubmit: () => void | Promise<void>; children: ReactNode; footer: ReactNode;
}) {
  const titleId = useId(), descriptionId = useId(), dialog = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const node = dialog.current!, previous = document.activeElement as HTMLElement | null;
    node.showModal();
    node.querySelector<HTMLElement>('.settings-dialog-body :is(input:not([type=hidden]), textarea, [role=combobox]):not(:disabled)')?.focus({ preventScroll: true });
    return () => {
      node.close();
      // Saving can briefly disable the opener until React commits the new state.
      queueMicrotask(() => { if (previous?.isConnected) previous.focus({ preventScroll: true }); });
    };
  }, []);
  return <dialog ref={dialog} id={id} className={`settings-form-dialog ${className}`} aria-labelledby={titleId}
    aria-describedby={description ? descriptionId : undefined} aria-busy={busy} closedby={busy ? 'none' : 'closerequest'}
    onCancel={dialogEventHandler(() => { if (!busy) onCancel(); })} onKeyDown={event => {
      if (busy && event.key === 'Escape') event.preventDefault();
      event.stopPropagation();
    }}>
    <header className="settings-dialog-header"><div><h2 id={titleId}>{title}</h2>
      {description && <p id={descriptionId}>{description}</p>}</div>
      <button type="button" className="icon-button" disabled={busy} aria-label={uiText(language)('common.close')} onClick={onCancel}><X size={18}/></button></header>
    <form className="settings-dialog-form" onSubmit={event => { event.preventDefault(); if (!busy) void onSubmit(); }}>
      <div className="settings-dialog-body">{children}</div>
      <footer className="settings-dialog-footer">{footer}</footer>
    </form>
  </dialog>;
}
