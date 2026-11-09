import { uiText } from '../../i18n';
import { fetchCardbushAppsConfiguration } from '../../backend/api';
import { dialogEventHandler } from '../../shared/dialogEvents';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AppWindow, Blocks, ExternalLink, FileText, LayoutGrid, Pencil, Search, Trash2, UsersRound, X } from 'lucide-react';
import { PluginIcon } from '../../components/PluginIcon';
import type { AppLanguage, CardbushAppPlugin } from '../../types';
import { PluginGlyph } from '../plugins/PluginGlyph';
import { BrowserSiteIcon } from '../browser/BrowserSiteIcon';
import { AppCenterSettingsMenu } from './AppCenterSettingsMenu';
import { ConversationHostContext } from '../conversationHost';
import { useSoftPanelPresence } from '../../hooks/useSoftPanelPresence';
import { applicationCatalog, applicationLink, type ApplicationEntry } from './appCenterModel';
import { OPEN_APPLICATION_EVENT, OPEN_APP_CENTER_EVENT, saveAppCenterPreferences, useAppCenterPreferences, useApplications } from './appCenterStore';
import './app-center.css';

const LaunchApplicationContext = createContext<(app: ApplicationEntry) => void>(() => {});

export function ApplicationIcon({ app, size = 20 }: { app: ApplicationEntry; size?: number }) {
  const [failedIcon, setFailedIcon] = useState('');
  if (app.plugin) return <PluginGlyph plugin={app.plugin} />;
  if (app.kind === 'web' || app.kind === 'external') return <BrowserSiteIcon url={app.target} icon={app.icon} size={size} persist/>;
  if (app.kind === 'local') return app.icon && app.icon !== failedIcon
    ? <img className="composer-plugin-option-logo" src={app.icon} alt="" draggable={false} onError={() => setFailedIcon(app.icon ?? '')}/>
    : <AppWindow size={size} aria-hidden="true"/>;
  const Icon = app.target === 'plugins' ? PluginIcon : app.target === 'components' ? Blocks : app.target === 'team' ? UsersRound : app.target === 'md-presentation' ? FileText : AppWindow;
  return <Icon size={size} aria-hidden="true" />;
}

export function useLaunchApplication() { return useContext(LaunchApplicationContext); }

export function AppCenterProvider({ language, exploring = false, onNavigate, onExplore, children }: { language: AppLanguage; exploring?: boolean; onExplore?: () => void; onNavigate: (app: ApplicationEntry, environmentId?: string) => void; children: ReactNode }) {
  const [open, setOpen] = useState(false), [query, setQuery] = useState('');
  const localCatalog = !useContext(ConversationHostContext);
  const listening = exploring || open;
  const apps = useApplications(language, listening), prefs = useAppCenterPreferences();
  const [link, setLink] = useState<{ id?: string; title: string; url: string } | null>(null), [error, setError] = useState('');
  const [selectingLocal, setSelectingLocal] = useState(false);
  const presence = useSoftPanelPresence(open, 200), dialog = useRef<HTMLDialogElement>(null), opener = useRef<HTMLElement | null>(null);
  const requestRevision = useRef(0);
  const current = useRef({ apps, prefs, onNavigate, listening }); current.current = { apps, prefs, onNavigate, listening };
  const show = useCallback(() => { if (!dialog.current?.open) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setError(''); setOpen(true); }, []);
  const openApplication = useCallback(async (app: ApplicationEntry, environmentId?: string) => {
    opener.current = null; setOpen(false);
    try {
      if (app.kind === 'web') {
        if (!applicationLink(app.target)) throw new Error(uiText(language)('appCenter.invalidAppUrl'));
        current.current.onNavigate(app); return;
      }
      if (app.kind === 'local') {
        if (!window.cardbushDesktop?.localApplications) throw new Error(uiText(language)('appCenter.openLocalAppsFromTheDesktopApp'));
        await window.cardbushDesktop.localApplications.open(app.target, language);
        return;
      }
      const url = app.kind === 'external' ? app.target : app.launch?.kind === 'url' ? app.launch.url : undefined;
      if (url) {
        if (!applicationLink(url)) throw new Error(uiText(language)('appCenter.invalidAppUrl'));
        if (window.cardbushDesktop?.openExternal) await window.cardbushDesktop.openExternal(url);
        else window.open(url, '_blank', 'noopener,noreferrer');
      } else if (app.kind === 'plugin' && (!app.launch || environmentId)) {
        throw new Error(uiText(language)('appCenter.thisAppHasNoPageAvailableOn'));
      } else current.current.onNavigate(app, environmentId);
    } catch (cause) { setError(String(cause)); setOpen(true); }
  }, [language]);
  const launch = useCallback((app: ApplicationEntry) => {
    const available = current.current.apps.find(item => item.id === app.id);
    if (available) void openApplication(available);
    else { show(); setError(uiText(language)('appCenter.thisAppWasRemovedOrDisabled')); }
  }, [openApplication, show, language]);
  useEffect(() => {
    const center = (event: Event) => {
      if ((event as CustomEvent).detail === 'manage' || !onExplore) show();
      else onExplore();
    };
    const application = async (event: Event) => {
      const { id, environmentId, reference } = (event as CustomEvent).detail ?? {};
      const revision = ++requestRevision.current;
      try {
        let available = current.current.apps;
        if (environmentId && reference?.applicationKind === 'plugin') {
          const api = window.cardbushDesktop?.agents;
          if (!api) throw new Error(uiText(language)('appCenter.remoteAppsAreUnavailable'));
          await api.connect(environmentId);
          const config = await api.call(environmentId, 'product.command', { kind: 'apps.get' }) as { plugins: CardbushAppPlugin[] };
          available = applicationCatalog(language, config.plugins, { ...current.current.prefs, links: [] });
        } else if (localCatalog && !environmentId && typeof id === 'string' && id.startsWith('plugin:') &&
          (!current.current.listening || !available.some(app => app.id === id))) {
          const config = await fetchCardbushAppsConfiguration();
          available = applicationCatalog(language, config.plugins, current.current.prefs);
        }
        if (revision !== requestRevision.current) return;
        const app = available.find(item => item.id === id);
        if (!app) throw new Error(uiText(language)('appCenter.thisAppWasRemovedDisabledOrHas'));
        await openApplication(app, environmentId);
      } catch (cause) { if (revision === requestRevision.current) { show(); setError(String(cause)); } }
    };
    window.addEventListener(OPEN_APP_CENTER_EVENT, center); window.addEventListener(OPEN_APPLICATION_EVENT, application);
    return () => { requestRevision.current++; window.removeEventListener(OPEN_APP_CENTER_EVENT, center); window.removeEventListener(OPEN_APPLICATION_EVENT, application); };
  }, [language, localCatalog, onExplore, show, openApplication]);
  useEffect(() => {
    if (!presence.mounted) return;
    const node = dialog.current; node?.showModal();
    node?.querySelector<HTMLInputElement>('.app-center-search input')?.focus({ preventScroll: true });
    return () => { node?.close(); if (opener.current?.isConnected && !document.querySelector('dialog[open]')) opener.current.focus({ preventScroll: true }); };
  }, [presence.mounted]);
  const save = useCallback((next: typeof prefs) => { try { saveAppCenterPreferences(next); setError(''); return true; } catch { setError(uiText(language)('appCenter.couldNotSaveApps')); return false; } }, [language]);
  useEffect(() => {
    const api = window.cardbushDesktop?.localApplications;
    const stale = (current.current.prefs.localApps ?? []).filter(app => app.iconVersion !== 1);
    if (!presence.mounted || !api?.refreshIcons || !stale.length) return;
    let cancelled = false;
    void api.refreshIcons(stale.map(app => app.path)).then(icons => {
      if (cancelled) return;
      const latest = current.current.prefs;
      let changed = false;
      const localApps = latest.localApps?.map(app => {
        if (app.iconVersion === 1 || !icons[app.path]) return app;
        changed = true;
        return { ...app, icon: icons[app.path], iconVersion: 1 as const };
      });
      if (changed) saveAppCenterPreferences({ ...latest, localApps });
    }).catch(() => { /* Retain saved icons and retry on the next open. */ });
    return () => { cancelled = true; };
  }, [presence.mounted]);
  const addLocal = async () => {
    const api = window.cardbushDesktop?.localApplications;
    if (!api || selectingLocal) return;
    setSelectingLocal(true); setError('');
    try {
      const selected = await api.pick(language);
      if (!selected) return;
      const latest = current.current.prefs, localApps = latest.localApps ?? [];
      const existing = localApps.find(app => app.id === selected.id);
      if (!existing && localApps.length >= 100) throw Error(uiText(language)('appCenter.upTo100LocalAppsCanBe'));
      const next = existing ? localApps.map(app => app.id === selected.id ? { ...selected, title: app.title } : app) : [...localApps, selected];
      if (save({ ...latest, localApps: next })) setQuery('');
    } catch (cause) { setError(String(cause)); }
    finally { setSelectingLocal(false); }
  };
  const removeApp = (app: ApplicationEntry) => {
    const latest = current.current.prefs;
    const saved = save({
      ...latest,
      links: latest.links.filter(item => item.id !== app.id),
      localApps: latest.localApps?.filter(item => item.id !== app.id),
      webApps: latest.webApps?.filter(item => item.id !== app.id),
      order: latest.order?.filter(id => id !== app.id),
    });
    if (saved) dialog.current?.querySelector<HTMLInputElement>('.app-center-search input')?.focus({preventScroll:true});
  };
  const filtered = apps.filter(app => `${app.title} ${app.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <LaunchApplicationContext.Provider value={launch}>
    {children}
    {presence.mounted && <dialog ref={dialog} className="app-center-drawer" data-visible={presence.visible} aria-labelledby="app-center-title" aria-modal="true" role="dialog"
      onCancel={dialogEventHandler(event => { event.preventDefault(); setOpen(false); })} onClick={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div className="app-center-content" inert={!open ? true : undefined}>
        <header><div><LayoutGrid size={20}/><h2 id="app-center-title">{uiText(language)(onExplore ? 'desktop.manageApps' : 'appCenter.appCenter')}</h2></div>
          <div className="app-center-header-actions">
            <AppCenterSettingsMenu language={language} active={open}
              selectingLocal={selectingLocal} onAddLocal={() => void addLocal()} onAddLink={() => { setLink({ title: '', url: '' }); setError(''); }}/>
            <button type="button" className="app-center-icon" aria-label={uiText(language)('appCenter.closeAppCenter')} title={uiText(language)('appCenter.closeEsc')} onClick={() => setOpen(false)}><X size={18}/></button>
          </div>
        </header>
        <label className="app-center-search"><Search size={16}/><input placeholder={uiText(language)('appCenter.searchApps')} aria-label={uiText(language)('appCenter.searchApps')} value={query} onChange={event => setQuery(event.target.value)}/></label>
        <div className="app-center-grid">{filtered.map(app => <article key={app.id} className="app-center-tile" data-application-id={app.id}>
          <button type="button" className="app-center-tile-open" data-shortcut={app.shortcut} title={app.title} onClick={() => launch(app)}>
            <span className="app-center-tile-icon"><ApplicationIcon app={app}/></span><strong>{app.title}</strong>
            {(app.kind === 'external' || app.launch?.kind === 'url') && <ExternalLink className="app-center-external" size={12}/>}</button>
          {(app.kind === 'local' || app.kind === 'web' || app.kind === 'external') && <div className="app-center-tile-actions">
            {app.kind === 'local' && <button type="button" className="app-center-icon" aria-label={`${uiText(language)('appCenter.remove')} ${app.title}`} title={uiText(language)('appCenter.removeFromAppCenter')} onClick={() => removeApp(app)}><Trash2 size={14}/></button>}
            {app.kind === 'web' && <button type="button" className="app-center-icon" aria-label={`${uiText(language)('appCenter.remove')} ${app.title}`} title={uiText(language)('appCenter.removeWebAppKeepSiteData')} onClick={() => removeApp(app)}><Trash2 size={14}/></button>}
            {app.kind === 'external' && <><button type="button" className="app-center-icon" aria-label={`${uiText(language)('common.edit')} ${app.title}`} onClick={() => setLink({ id: app.id, title: app.title, url: app.target })}><Pencil size={14}/></button>
              <button type="button" className="app-center-icon" aria-label={`${uiText(language)('appCenter.delete')} ${app.title}`} onClick={() => removeApp(app)}><Trash2 size={14}/></button></>}
          </div>}
        </article>)}</div>
        {!filtered.length && <p className="app-center-empty">{uiText(language)('appCenter.noMatchingApps')}</p>}
        {link && <form className="app-center-link-form" onSubmit={event => { event.preventDefault(); const url = applicationLink(link.url); if (!url || !link.title.trim()) { setError(uiText(language)('appCenter.enterANameAndValidHttpHttps')); return; }
          if (!link.id && prefs.links.length >= 100) { setError(uiText(language)('appCenter.upTo100AppLinksCanBe')); return; }
          const id = link.id ?? `external:${Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')}`;
          const value = { id, title: link.title, url }; if (save({ ...prefs, links: [...prefs.links.filter(item => item.id !== value.id), value] })) setLink(null); }}>
          <input aria-label={uiText(language)('appCenter.appName')} placeholder={uiText(language)('appCenter.appName')} maxLength={80} autoFocus required value={link.title} onChange={event => { const title = event.target.value; setLink(previous => previous && { ...previous, title }); }}/>
          <input aria-label={uiText(language)('appCenter.appAddress')} placeholder={uiText(language)('appCenter.https_http_localhost')} maxLength={4096} required value={link.url} onChange={event => { const url = event.target.value; setLink(previous => previous && { ...previous, url }); }}/>
          <div><button type="button" onClick={() => setLink(null)}>{uiText(language)('agentConnectionForm.cancel')}</button><button type="submit">{uiText(language)('appCenter.save')}</button></div>
        </form>}
        {error && <p className="app-center-error" role="alert">{error}</p>}
      </div>
    </dialog>}
  </LaunchApplicationContext.Provider>;
}
