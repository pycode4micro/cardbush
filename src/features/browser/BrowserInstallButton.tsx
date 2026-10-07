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
  const zh = language === 'zh', prefs = useAppCenterPreferences(), dialog = useRef<HTMLDialogElement>(null);
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
      <header><h2 id="browser-install-title">{zh ? '安装网页应用' : 'Install web app'}</h2><button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={onClose}><X size={18}/></button></header>
      <div className="browser-install-identity"><BrowserSiteIcon url={info.url} icon={info.icon} size={40}/>
        <label>{zh ? '应用名称' : 'App name'}<input autoFocus required maxLength={80} value={name ?? info.title} onChange={event => setName(event.target.value)} aria-label={zh ? '应用名称' : 'App name'}/></label></div>
      <p className="browser-install-url" title={info.url}>{info.url}</p>
      <p>{zh ? '添加到应用中心，之后可直接在 CardBush 中打开。' : 'Add to the app center and open directly in CardBush.'}</p>
      <label className="browser-install-pin"><input type="checkbox" checked={pin} disabled={prefs.shortcuts.length >= 4} onChange={event => setPin(event.target.checked)}/>
        {zh ? '固定到侧栏快捷方式' : 'Pin to sidebar shortcuts'}{prefs.shortcuts.length >= 4 && <small>{zh ? '（已满）' : ' (full)'}</small>}</label>
      {error && <p role="alert">{error}</p>}
      <footer><span role="status">{busy ? (zh ? '正在读取网站信息…' : 'Reading site information…') : ''}</span>
        <button type="button" onClick={onClose}>{zh ? '取消' : 'Cancel'}</button><button type="submit" disabled={busy || Boolean(error) || name !== null && !name.trim()}>{zh ? '安装' : 'Install'}</button></footer>
    </form>
  </dialog>, document.querySelector('.app') ?? document.body);
}

export function BrowserInstallButton({ language, navigation }: { language: AppLanguage; navigation?: InspectorNavigationState }) {
  const prefs = useAppCenterPreferences(), [open, setOpen] = useState(false);
  const url = navigation?.url || '', guestId = navigation?.guestWebContentsId;
  useEffect(() => { setOpen(false); }, [url, guestId]);
  if (!guestId || !websiteApplication(url, '') || !window.cardbushDesktop?.browser?.webApplication) return null;
  const installed = prefs.webApps?.some(app => webApplicationMatches(app, url));
  const label = installed ? (language === 'zh' ? '已安装 · 查看应用中心' : 'Installed · View app center') : (language === 'zh' ? '安装为网页应用' : 'Install as web app');
  return <><button type="button" className={`browser-install-button${installed ? ' installed' : ''}`} title={label} aria-label={label} aria-haspopup="dialog"
    onClick={() => installed ? requestAppCenter() : setOpen(true)}>{installed ? <Check size={15}/> : <MonitorDown size={16}/>}</button>
    {open && navigation && <InstallDialog key={`${guestId}:${url}`} language={language} navigation={navigation} onClose={() => setOpen(false)}/>}</>;
}
