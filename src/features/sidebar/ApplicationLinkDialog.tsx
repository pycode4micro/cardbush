import { useState } from 'react';
import { uiText } from '../../i18n';
import { applicationLink, type ApplicationEntry } from '../appCenter/appCenterModel';
import { updateAppCenterPreferences } from '../appCenter/appCenterStore';
import { SettingsFormDialog } from '../settings/SettingsFormDialog';

export function ApplicationLinkDialog({ app, language, onClose }: { app?: ApplicationEntry; language: string; onClose(): void }) {
  const t = uiText(language);
  const [title, setTitle] = useState(app?.title ?? '');
  const [address, setAddress] = useState(app?.target ?? '');
  const [error, setError] = useState('');
  const save = () => {
    const url = applicationLink(address.trim());
    if (!url || !title.trim()) { setError(t('appCenter.enterANameAndValidHttpHttps')); return; }
    try {
      updateAppCenterPreferences(prefs => {
        if (!app && prefs.links.length >= 100) throw Error(t('appCenter.upTo100AppLinksCanBe'));
        const id = app?.id ?? `external:${Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')}`;
        const entry = { id, title: title.trim(), url };
        return { ...prefs, links: app ? prefs.links.map(item => item.id === entry.id ? entry : item) : [...prefs.links, entry] };
      });
      onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('appCenter.couldNotSaveApps')); }
  };
  return <SettingsFormDialog className="application-link-dialog" title={t(app ? 'sidebar.editAppLink' : 'appCenterSettingsMenu.addAppLink')}
    language={language} onCancel={onClose} onSubmit={save}
    footer={<><button type="button" onClick={onClose}>{t('agentConnectionForm.cancel')}</button><button type="submit" className="primary-button">{t('appCenter.save')}</button></>}>
    <div className="settings-dialog-fields">
      <label className="settings-field">{t('appCenter.appName')}<input name="title" value={title} required maxLength={80} onChange={event => setTitle(event.target.value)}/></label>
      <label className="settings-field">{t('appCenter.appAddress')}<input name="address" value={address} required maxLength={4096} onChange={event => setAddress(event.target.value)}/></label>
      {error && <p role="alert" className="settings-inline-error">{error}</p>}
    </div>
  </SettingsFormDialog>;
}
