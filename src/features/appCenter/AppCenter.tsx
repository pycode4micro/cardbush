import { uiText } from '../../i18n';
import { dialogEventHandler } from '../../shared/dialogEvents';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { AppWindow, Blocks, CalendarClock, ExternalLink, FileText, LayoutGrid, Pencil, Pin, Search, Settings, Trash2, UsersRound, X } from 'lucide-react';
import { PluginIcon } from '../../components/PluginIcon';
import type { AppLanguage, CardbushAppPlugin } from '../../types';
import { PluginGlyph } from '../plugins/PluginGlyph';
import { BrowserSiteIcon } from '../browser/BrowserSiteIcon';
import { AppCenterSettingsMenu } from './AppCenterSettingsMenu';
import { useKeyboardShortcuts } from '../shortcuts/useKeyboardShortcuts';
import { useSoftPanelPresence } from '../../hooks/useSoftPanelPresence';
import { observeExplicitInteraction } from '../../shared/explicitInteraction';
import { applicationCatalog, applicationLink, moveApplication, type ApplicationEntry } from './appCenterModel';
import { OPEN_APPLICATION_EVENT, OPEN_APP_CENTER_EVENT, saveAppCenterPreferences, useAppCenterPreferences, useApplications } from './appCenterStore';
import './app-center.css';

const dragType = 'application/x-cardbush-app';
const shortcutHoverHoldMs = 1200;
type CenterContext = { open: () => void; launch: (app: ApplicationEntry) => void; dragging: string;
  startDrag: (event: DragEvent, id: string) => void; endDrag: () => void;
  drop: (event: DragEvent, target?: string) => void;
  move: (event: KeyboardEvent, id: string) => void };
const AppCenterContext = createContext<CenterContext>({ open: () => {}, launch: () => {}, dragging: '', startDrag: () => {}, endDrag: () => {}, drop: () => {}, move: () => {} });
const allowDrop = (event: DragEvent) => { if (event.dataTransfer.types.includes(dragType)) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; } };
export function ApplicationIcon({ app, size = 20 }: { app: ApplicationEntry; size?: number }) {
  const [failedIcon, setFailedIcon] = useState('');
  if (app.plugin) return <PluginGlyph plugin={app.plugin} />;
  if (app.kind === 'web' || app.kind === 'external') return <BrowserSiteIcon url={app.target} icon={app.icon} size={size} persist/>;
  if (app.kind === 'local') return app.icon && app.icon !== failedIcon
    ? <img className="composer-plugin-option-logo" src={app.icon} alt="" draggable={false} onError={() => setFailedIcon(app.icon ?? '')}/>
    : <AppWindow size={size} aria-hidden="true"/>;
  const Icon = app.target === 'plugins' ? PluginIcon : app.target === 'automations' ? CalendarClock : app.target === 'components' ? Blocks : app.target === 'team' ? UsersRound : app.target === 'md-presentation' ? FileText : Settings;
  return <Icon size={size} aria-hidden="true" />;
}

function ShortcutItems({ language, unread = 0 }: { language: AppLanguage; unread?: number }) {
  const center = useContext(AppCenterContext), apps = useApplications(language), prefs = useAppCenterPreferences();
  return <>{prefs.shortcuts.flatMap(id => {
    const app = apps.find(item => item.id === id);
    return app ? [<span className="app-shortcut-item" key={id} data-application-id={id} data-dragging={center.dragging === id}
      onDragOver={allowDrop} onDrop={event => center.drop(event, id)}>
      <button type="button" className="app-center-shortcut" aria-label={app.title} title={app.title} data-shortcut={app.shortcut}
        draggable onDragStart={event => center.startDrag(event, id)} onDragEnd={center.endDrag}
        onKeyDown={event => center.move(event, id)} onClick={() => center.launch(app)}>
        <ApplicationIcon app={app} size={17}/>{app.target === 'automations' && unread > 0 && <span className="app-shortcut-dot" aria-label={`${unread} ${uiText(language)('appCenter.unreadResults')}`} />}
      </button>
    </span>] : [];
  })}</>;
}

export function AppCenterDock({ language, unread = 0 }: { language: AppLanguage; unread?: number }) {
  const center = useContext(AppCenterContext), prefs = useAppCenterPreferences(), shortcuts = useKeyboardShortcuts();
  const [hoverExpanded, setHoverExpanded] = useState(false), hoverTimer = useRef<number | undefined>(undefined);
  const [keyboardExpanded, setKeyboardExpanded] = useState(false), dock = useRef<HTMLDivElement>(null);
  const cancelCollapse = useCallback(() => { window.clearTimeout(hoverTimer.current); hoverTimer.current = undefined; }, []);
  useEffect(() => {
    const reset = () => { cancelCollapse(); setHoverExpanded(false); setKeyboardExpanded(false); };
    const focus = () => setKeyboardExpanded(Boolean(dock.current?.contains(document.activeElement)));
    reset();
    const stopInteraction = observeExplicitInteraction({
      reset, focus, keyboard: focus, pointerDown: () => setKeyboardExpanded(false),
      pointerMove: event => {
        if (prefs.display !== 'hover' || !(event.target instanceof Node) || !dock.current?.contains(event.target)) return;
        cancelCollapse(); setHoverExpanded(true);
      },
    });
    return () => { stopInteraction(); cancelCollapse(); };
  }, [prefs.display, cancelCollapse]);
  return <div ref={dock} className="app-center-dock" data-display={prefs.display} data-dragging={Boolean(center.dragging)} data-hover-expanded={hoverExpanded} data-keyboard-expanded={keyboardExpanded}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setKeyboardExpanded(false); }}
    onPointerLeave={event => {
      if (event.pointerType === 'touch' || prefs.display !== 'hover') return;
      cancelCollapse();
      hoverTimer.current = window.setTimeout(() => { hoverTimer.current = undefined; setHoverExpanded(false); }, shortcutHoverHoldMs);
    }}
    onDragOver={allowDrop} onDrop={event => center.drop(event)}>
    <button type="button" className="app-center-launcher" onClick={center.open} aria-haspopup="dialog" data-shortcut="openAppCenter"
      title={uiText(language)('appCenter.appCenter')}
      aria-label={uiText(language)('appCenter.appCenter')} aria-keyshortcuts={shortcuts.aria('openAppCenter')}>
      <LayoutGrid size={18} aria-hidden="true"/>
    </button>
    <div className="app-center-shortcuts" aria-label={uiText(language)('appCenter.appShortcuts')}>
      <ShortcutItems language={language} unread={unread}/>
    </div>
  </div>;
}

export function AppCenterProvider({ language, onNavigate, children }: { language: AppLanguage; onNavigate: (app: ApplicationEntry, environmentId?: string) => void; children: ReactNode }) {
  const apps = useApplications(language), prefs = useAppCenterPreferences();
  const [open, setOpen] = useState(false), [query, setQuery] = useState(''), [dragging, setDragging] = useState('');
  const [link, setLink] = useState<{ id?: string; title: string; url: string } | null>(null), [error, setError] = useState('');
  const [selectingLocal, setSelectingLocal] = useState(false);
  const presence = useSoftPanelPresence(open, 200), dialog = useRef<HTMLDialogElement>(null), opener = useRef<HTMLElement | null>(null);
  const suppressClick = useRef(false), requestRevision = useRef(0);
  const dragPreview = useRef<HTMLDivElement | null>(null), dragFrame = useRef(0), dragFocus = useRef<HTMLElement | null>(null);
  const current = useRef({ apps, prefs, onNavigate }); current.current = { apps, prefs, onNavigate };
  const show = useCallback(() => { if (!dialog.current?.open) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setError(''); setOpen(true); }, []);
  const openApplication = useCallback(async (app: ApplicationEntry, environmentId?: string) => {
    if (suppressClick.current) return;
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
    const center = () => show();
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
        }
        if (revision !== requestRevision.current) return;
        const app = available.find(item => item.id === id);
        if (!app) throw new Error(uiText(language)('appCenter.thisAppWasRemovedDisabledOrHas'));
        await openApplication(app, environmentId);
      } catch (cause) { if (revision === requestRevision.current) { show(); setError(String(cause)); } }
    };
    window.addEventListener(OPEN_APP_CENTER_EVENT, center); window.addEventListener(OPEN_APPLICATION_EVENT, application);
    return () => { requestRevision.current++; window.removeEventListener(OPEN_APP_CENTER_EVENT, center); window.removeEventListener(OPEN_APPLICATION_EVENT, application); };
  }, [language, language, show, openApplication]);
  useEffect(() => {
    if (!presence.mounted) return;
    const node = dialog.current; node?.showModal();
    node?.querySelector<HTMLInputElement>('.app-center-search input')?.focus({ preventScroll: true });
    return () => { node?.close(); if (opener.current?.isConnected && !document.querySelector('dialog[open]')) opener.current.focus({ preventScroll: true }); };
  }, [presence.mounted]);
  useEffect(() => {
    const node = dialog.current;
    if (!node?.open) return;
    // A modal dialog makes the real dock inert. Keep the drawer mounted while
    // temporarily releasing modality so native drops can reach the dock.
    if (dragging && node.matches(':modal')) {
      dragFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      node.close(); node.show();
    } else if (!dragging && !node.matches(':modal')) {
      node.close(); node.showModal();
      if (dragFocus.current?.isConnected && node.contains(dragFocus.current)) dragFocus.current.focus({ preventScroll: true });
      dragFocus.current = null;
    }
  }, [dragging, presence.mounted]);
  useEffect(() => () => { window.cancelAnimationFrame(dragFrame.current); dragPreview.current?.remove(); }, []);
  const save = useCallback((next: typeof prefs) => { try { saveAppCenterPreferences(next); setError(''); return true; } catch { setError(uiText(language)('appCenter.couldNotSaveShortcutsToLocalStorage')); return false; } }, [language]);
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
  const unpin = useCallback((id: string) => save({ ...current.current.prefs, shortcuts: current.current.prefs.shortcuts.filter(item => item !== id) }), [save]);
  const pin = (app: ApplicationEntry) => {
    const shortcuts = prefs.shortcuts.filter(id => apps.some(item => item.id === id));
    if (prefs.shortcuts.includes(app.id)) unpin(app.id);
    else if (shortcuts.length < 4) save({ ...prefs, shortcuts: [...shortcuts, app.id] });
    else setError(uiText(language)('appCenter.theDockHoldsFourShortcutsRemoveOne'));
  };
  const endDrag = useCallback(() => {
    window.cancelAnimationFrame(dragFrame.current); dragPreview.current?.remove(); dragPreview.current = null;
    setDragging(''); window.setTimeout(() => { suppressClick.current = false; }, 0);
  }, []);
  const startDrag = useCallback((event: DragEvent, id: string) => {
    event.dataTransfer.setData(dragType, id); event.dataTransfer.effectAllowed = 'move'; suppressClick.current = true;
    const icon = event.currentTarget.querySelector('.app-center-tile-icon svg, .app-center-tile-icon img, :scope > svg, :scope > img, :scope > .browser-site-icon svg, :scope > .browser-site-icon img');
    dragPreview.current?.remove();
    if (icon) {
      const preview = document.createElement('div');
      preview.className = 'app-center-drag-preview'; preview.setAttribute('aria-hidden', 'true');
      preview.style.color = getComputedStyle(icon).color;
      preview.append(icon.cloneNode(true)); document.body.append(preview); dragPreview.current = preview;
      event.dataTransfer.setDragImage(preview, 18, 18);
    }
    // Let Chromium capture the icon before changing the source dialog's mode.
    window.cancelAnimationFrame(dragFrame.current);
    dragFrame.current = window.requestAnimationFrame(() => setDragging(id));
  }, []);
  const reorder = useCallback((id: string, target?: string) => {
    const { apps, prefs } = current.current;
    if (!apps.some(app => app.id === id)) return;
    const visible = prefs.shortcuts.filter(item => apps.some(app => app.id === item));
    if (!visible.includes(id) && visible.length >= 4) { setError(uiText(language)('appCenter.removeAShortcutBeforeAddingAFifth')); return; }
    save({ ...prefs, shortcuts: moveApplication(visible, id, target) });
  }, [save, language]);
  const drop = useCallback((event: DragEvent, target?: string) => {
    if (!event.dataTransfer.types.includes(dragType)) return;
    event.preventDefault(); event.stopPropagation();
    const id = event.dataTransfer.getData(dragType), { apps, prefs } = current.current;
    const ids = prefs.shortcuts.filter(item => apps.some(app => app.id === item));
    const from = ids.indexOf(id), to = target ? ids.indexOf(target) : -1;
    // Crossing a later item moves after it, so adjacent items can swap in either direction.
    reorder(id, from >= 0 && to > from ? ids[to + 1] : target); endDrag();
  }, [reorder, endDrag]);
  const move = useCallback((event: KeyboardEvent, id: string) => {
    if (!event.altKey || event.ctrlKey || event.metaKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const { apps, prefs } = current.current, ids = prefs.shortcuts.filter(item => apps.some(app => app.id === item));
    const index = ids.indexOf(id), next = index + (event.key === 'ArrowLeft' ? -1 : 1);
    if (index < 0 || next < 0 || next >= ids.length) return;
    reorder(id, ids[next + (next > index ? 1 : 0)]);
  }, [reorder]);
  const context = useMemo(() => ({ open: show, launch, dragging, startDrag, endDrag, drop, move }), [show, launch, dragging, startDrag, endDrag, drop, move]);
  const filtered = apps.filter(app => `${app.title} ${app.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <AppCenterContext.Provider value={context}>
    {children}
    {presence.mounted && <dialog ref={dialog} className="app-center-drawer" data-visible={presence.visible} data-dragging={Boolean(dragging)} aria-labelledby="app-center-title" aria-modal={!dragging} role="dialog"
      onCancel={dialogEventHandler(event => { event.preventDefault(); setOpen(false); })} onClick={event => { if (event.target === event.currentTarget) setOpen(false); }}>
      <div className="app-center-content" inert={!open ? true : undefined}>
        <header><div><LayoutGrid size={20}/><h2 id="app-center-title">{uiText(language)('appCenter.appCenter')}</h2></div>
          <div className="app-center-header-actions">
            <AppCenterSettingsMenu language={language} active={open && !dragging} display={prefs.display} onDisplayChange={display => save({ ...current.current.prefs, display })}
              selectingLocal={selectingLocal} onAddLocal={() => void addLocal()} onAddLink={() => { setLink({ title: '', url: '' }); setError(''); }}/>
            <button type="button" className="app-center-icon" aria-label={uiText(language)('appCenter.closeAppCenter')} title={uiText(language)('appCenter.closeEsc')} onClick={() => setOpen(false)}><X size={18}/></button>
          </div>
        </header>
        <label className="app-center-search"><Search size={16}/><input placeholder={uiText(language)('appCenter.searchApps')} aria-label={uiText(language)('appCenter.searchApps')} value={query} onChange={event => setQuery(event.target.value)}/></label>
        <div className="app-center-grid">{filtered.map(app => <article key={app.id} className="app-center-tile" data-application-id={app.id} data-dragging={dragging === app.id}>
          <button type="button" className="app-center-tile-open" data-shortcut={app.shortcut} title={app.title} onClick={() => launch(app)}
            draggable onDragStart={event => startDrag(event, app.id)} onDragEnd={endDrag}>
            <span className="app-center-tile-icon"><ApplicationIcon app={app}/></span><strong>{app.title}</strong>
            {(app.kind === 'external' || app.launch?.kind === 'url') && <ExternalLink className="app-center-external" size={12}/>}</button>
          <div className="app-center-tile-actions"><button type="button" className={`app-center-icon${prefs.shortcuts.includes(app.id) ? ' selected' : ''}`} aria-pressed={prefs.shortcuts.includes(app.id)} aria-label={`${prefs.shortcuts.includes(app.id) ? (uiText(language)('appCenter.unpin')) : (uiText(language)('appCenter.pinShortcut'))} ${app.title}`} onClick={() => pin(app)}><Pin size={14}/></button>
            {app.kind === 'local' && <button type="button" className="app-center-icon" aria-label={`${uiText(language)('appCenter.remove')} ${app.title}`} title={uiText(language)('appCenter.removeFromAppCenter')} onClick={() => save({ ...prefs, localApps: prefs.localApps?.filter(item => item.id !== app.id), shortcuts: prefs.shortcuts.filter(id => id !== app.id) })}><Trash2 size={14}/></button>}
            {app.kind === 'web' && <button type="button" className="app-center-icon" aria-label={`${uiText(language)('appCenter.remove')} ${app.title}`} title={uiText(language)('appCenter.removeWebAppKeepSiteData')} onClick={() => save({ ...prefs, webApps: prefs.webApps?.filter(item => item.id !== app.id), shortcuts: prefs.shortcuts.filter(id => id !== app.id), order: prefs.order?.filter(id => id !== app.id) })}><Trash2 size={14}/></button>}
            {app.kind === 'external' && <><button type="button" className="app-center-icon" aria-label={`${uiText(language)('common.edit')} ${app.title}`} onClick={() => setLink({ id: app.id, title: app.title, url: app.target })}><Pencil size={14}/></button>
              <button type="button" className="app-center-icon" aria-label={`${uiText(language)('appCenter.delete')} ${app.title}`} onClick={() => save({ ...prefs, links: prefs.links.filter(item => item.id !== app.id), shortcuts: prefs.shortcuts.filter(id => id !== app.id) })}><Trash2 size={14}/></button></>}
          </div>
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
  </AppCenterContext.Provider>;
}
