import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { AppLanguage } from '../../types';
import { uiText } from '../../i18n';
import { dialogEventHandler } from '../../shared/dialogEvents';
import { websiteAddress, type HomeBlock } from './homeLayout';

export type WebsiteBlock = Extract<HomeBlock, {kind: 'web'}>;
export function HomeWebsiteDialog({language, initial, onSave, onClose}: {
  language: AppLanguage; initial?: WebsiteBlock; onSave(title: string, url: string): void; onClose(): void;
}) {
  const t = uiText(language), dialog = useRef<HTMLDialogElement>(null);
  const [address, setAddress] = useState(initial?.url ?? '');
  const [title, setTitle] = useState(initial?.title ?? '');
  const [invalid, setInvalid] = useState(false);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => element.close();
  }, []);
  return <dialog className="inspector-page-dialog component-import" ref={dialog} aria-labelledby="home-web-heading" onCancel={dialogEventHandler(onClose)}>
    <form onSubmit={event => {
      event.preventDefault();
      const url = websiteAddress(address.trim());
      if (!url) { setInvalid(true); return; }
      onSave(title.trim() || new URL(url).hostname, url);
    }}>
      <div className="component-import-heading"><h2 id="home-web-heading">{t('homeLayout.website')}</h2>
        <button type="button" aria-label={t('common.close')} onClick={onClose}><X/></button></div>
      <label>{t('homeLayout.address')}<input name="address" autoFocus required type="url" value={address}
        aria-invalid={invalid} onChange={event => { setAddress(event.target.value); setInvalid(false); }}/></label>
      <label>{t('agentConnectionForm.name')}<input name="title" maxLength={80} value={title} onChange={event => setTitle(event.target.value)}/></label>
      <small>{t('homeLayout.embedHint')}</small>
      {invalid && <p role="alert">{t('homeLayout.invalidAddress')}</p>}
      <footer><button type="button" onClick={onClose}>{t('agentConnectionForm.cancel')}</button><button type="submit">{t('appCenter.save')}</button></footer>
    </form>
  </dialog>;
}
