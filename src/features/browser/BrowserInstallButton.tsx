import { uiText } from '../../i18n';
import { Check, MonitorDown, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AppLanguage } from '../../types';
import { dialogEventHandler } from '../../shared/dialogEvents';
import { webApplicationMatches, websiteApplication, type WebApplicationInfo } from '@cardbush/bush-protocol';
import { installWebApplication, requestAppCenter, useAppCenterPreferences } from '../appCenter/appCenterStore';
import type { InspectorNavigationState } from '../inspector/InspectorWebview';
import { BrowserSiteIcon } from './BrowserSiteIcon';
import './browserInstall.css';

function InstallDialog({ language, navigation, onClose }: { language: AppLanguage; navigation: InspectorNavigationState; onClose: () => void }) {
  const prefs = useAppCenterPreferences(), dialog = useRef<HTMLDialogElement>(null);
  const [info, setInfo] = useState<WebApplicationInfo>(() => websiteApplication(navigation.url, navigation.title, { icon: navigation.faviconUrl })!);
  const [name, setName] = useState<string | null>(null), [busy, setBusy] = useState(true), [pin, setPin] = useState(false), [error, setError] = useState('');
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close(); }, []);
  useEffect(() => {
    let active = true;
    void window.cardbushDesktop!.browser!.webApplication(navigation.guestWebContentsId!, navigation.url).then(result => {
      if (active) setInfo(result);
    }, cause => { if (active) setError(String(cause)); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [navigation.guestWebContentsId, navigation.url]);
  return createPortal(<dialog ref={dialog} className="browser-install-dialog" aria-labelledby="browser-install-title"
    onCancel={dialogEventHandler(() => onClose())} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <form onSubmit={event => {
      event.preventDefault(); event.stopPropagation(); if (busy || error) return;
      try { installWebApplication({ ...info, title: name?.trim() || info.title }, pin); onClose(); requestAppCenter(); }
      catch (cause) { setError(String(cause)); }
    }}>
      <header><h2 id="browser-install-title">{uiText(language)('browserInstallButton.installWebApp')}</h2><button type="button" aria-label={uiText(language)('common.close')} onClick={onClose}><X size={18}/></button></header>
      <div className="browser-install-identity"><BrowserSiteIcon url={info.url} icon={info.icon} size={40}/>
        <label>{uiText(language)('appCenter.appName')}<input autoFocus required maxLength={80} value={name ?? info.title} onChange={event => setName(event.target.value)} aria-label={uiText(language)('appCenter.appName')}/></label></div>
      <p className="browser-install-url" title={info.url}>{info.url}</p>
      <p>{uiText(language)('browserInstallButton.addToTheAppCenterAndOpen')}</p>
      <label className="browser-install-pin"><input type="checkbox" checked={pin} disabled={prefs.shortcuts.length >= 4} onChange={event => setPin(event.target.checked)}/>
        {uiText(language)('browserInstallButton.pinToSidebarShortcuts')}{prefs.shortcuts.length >= 4 && <small>{uiText(language)('browserInstallButton.full')}</small>}</label>
      {error && <p role="alert">{error}</p>}
      <footer><span role="status">{busy ? (uiText(language)('browserInstallButton.readingSiteInformation')) : ''}</span>
        <button type="button" onClick={onClose}>{uiText(language)('agentConnectionForm.cancel')}</button><button type="submit" disabled={busy || Boolean(error) || name !== null && !name.trim()}>{uiText(language)('browserInstallButton.install')}</button></footer>
    </form>
  </dialog>, document.querySelector('.app') ?? document.body);
}

export function BrowserInstallButton({ language, navigation }: { language: AppLanguage; navigation?: InspectorNavigationState }) {
  const prefs = useAppCenterPreferences(), [open, setOpen] = useState(false);
  const url = navigation?.url || '', guestId = navigation?.guestWebContentsId;
  useEffect(() => { setOpen(false); }, [url, guestId]);
  if (!guestId || !websiteApplication(url, '') || !window.cardbushDesktop?.browser?.webApplication) return null;
  const installed = prefs.webApps?.some(app => webApplicationMatches(app, url));
  const label = installed ? (uiText(language)('browserInstallButton.installedViewAppCenter')) : (uiText(language)('browserInstallButton.installAsWebApp'));
  return <><button type="button" className={`browser-install-button${installed ? ' installed' : ''}`} title={label} aria-label={label} aria-haspopup="dialog"
    onClick={() => installed ? requestAppCenter() : setOpen(true)}>{installed ? <Check size={15}/> : <MonitorDown size={16}/>}</button>
    {open && navigation && <InstallDialog key={`${guestId}:${url}`} language={language} navigation={navigation} onClose={() => setOpen(false)}/>}</>;
}
