import { Ellipsis, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { useContext, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { HoverPreview, useHoverPreview } from '../../components/HoverPreview';
import { uiText } from '../../i18n';
import { showUiError } from '../../shared/showUiError';
import { ApplicationIcon } from '../appCenter/ApplicationIcon';
import { applicationReference, type ApplicationEntry } from '../appCenter/appCenterModel';
import { requestApplication, SHOW_MORE_APPLICATIONS_EVENT, updateAppCenterPreferences, useAppCenterPreferences, useApplications } from '../appCenter/appCenterStore';
import { ConversationHostContext } from '../conversationHost';
import { ApplicationLinkDialog } from './ApplicationLinkDialog';

export function SidebarApplications({ language }: { language: string }) {
  const t = uiText(language), label = t('sidebar.moreApps');
  const preview = useHoverPreview();
  const opened = Boolean(preview.anchor);
  const apps = useApplications(language, opened);
  const prefs = useAppCenterPreferences();
  const host = useContext(ConversationHostContext);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null), focusOnOpen = useRef(false);
  const [query, setQuery] = useState('');
  const [linkDialog, setLinkDialog] = useState<{ app?: ApplicationEntry }>();
  const [selectingLocal, setSelectingLocal] = useState(false);
  const { open: openPreview } = preview;
  const staleIcons = useEffectEvent(() => (prefs.localApps ?? []).filter(app => app.iconVersion !== 1).map(app => app.path));
  useEffect(() => {
    const show = () => {
      if (!trigger.current) return;
      setQuery('');
      openPreview(trigger.current);
    };
    window.addEventListener(SHOW_MORE_APPLICATIONS_EVENT, show);
    return () => window.removeEventListener(SHOW_MORE_APPLICATIONS_EVENT, show);
  }, [openPreview]);
  useEffect(() => {
    const api = window.cardbushDesktop?.localApplications;
    const paths = opened && api?.refreshIcons ? staleIcons() : [];
    if (!paths.length || !api?.refreshIcons) return;
    let cancelled = false;
    void api.refreshIcons(paths).then(icons => {
      if (cancelled) return;
      updateAppCenterPreferences(current => {
        if (!current.localApps?.some(app => app.iconVersion !== 1 && icons[app.path])) return current;
        return { ...current, localApps: current.localApps.map(app => app.iconVersion !== 1 && icons[app.path]
          ? { ...app, icon: icons[app.path], iconVersion: 1 } : app) };
      });
    }).catch(() => { /* A later open can retry the icon refresh. */ });
    return () => { cancelled = true; };
  }, [opened]);
  useLayoutEffect(() => {
    if (preview.anchor && focusOnOpen.current) {
      list.current?.querySelector('button')?.focus({ preventScroll: true });
      focusOnOpen.current = false;
    }
  }, [preview.anchor]);
  const addLocal = async () => {
    const api = window.cardbushDesktop?.localApplications;
    if (!api || selectingLocal) return;
    setSelectingLocal(true);
    try {
      const selected = await api.pick(language);
      if (!selected) return;
      updateAppCenterPreferences(current => {
        const localApps = current.localApps ?? [];
        const existing = localApps.find(app => app.id === selected.id);
        if (!existing && localApps.length >= 100) throw Error(t('appCenter.upTo100LocalAppsCanBe'));
        return { ...current, localApps: existing ? localApps.map(app => app.id === selected.id ? { ...selected, title: app.title } : app) : [...localApps, selected] };
      });
      setQuery('');
      if (trigger.current) openPreview(trigger.current);
    } catch (cause) { void showUiError(t('app.actionFailed'), cause instanceof Error ? cause.message : String(cause)); }
    finally { setSelectingLocal(false); }
  };
  const remove = (app: ApplicationEntry) => {
    try {
      updateAppCenterPreferences(current => ({ ...current,
        links: current.links.filter(item => item.id !== app.id),
        localApps: current.localApps?.filter(item => item.id !== app.id),
        webApps: current.webApps?.filter(item => item.id !== app.id),
        order: current.order?.filter(id => id !== app.id),
      }));
      list.current?.querySelector('input')?.focus({ preventScroll: true });
    } catch { void showUiError(t('app.actionFailed'), t('appCenter.couldNotSaveApps')); }
  };
  const editLink = (app?: ApplicationEntry) => { preview.dismiss(); setLinkDialog({ app }); };
  const filtered = apps.filter(app => `${app.title} ${app.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <>
    <button ref={trigger} type="button" className="nav-row sidebar-more-apps"
      aria-label={label} aria-haspopup="dialog" aria-expanded={opened} aria-controls={opened ? preview.id : undefined}
      onClick={event => {
        if (opened) { preview.dismiss(); return; }
        focusOnOpen.current = event.detail === 0;
        openPreview(event.currentTarget);
      }}>
      <span className="nav-row-icon" aria-hidden="true"><Ellipsis/></span><span>{label}</span>
    </button>
    <HoverPreview preview={preview} className="sidebar-app-flyout" interactiveLabel={label} clickOnly>
      <div ref={list} className="sidebar-app-list" onKeyDown={event => {
        if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key) ||
          (event.target instanceof HTMLInputElement && event.key !== 'ArrowDown')) return;
        event.preventDefault();
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 :
          (index + (event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      }}>
        <label className="sidebar-app-search"><Search aria-hidden="true"/><input aria-label={t('appCenter.searchApps')} placeholder={t('appCenter.searchApps')}
          value={query} onChange={event => setQuery(event.target.value)}/></label>
        {filtered.map(app => <div className="sidebar-app-row" key={app.id}>
          <button type="button" data-sidebar-app={app.id} onClick={() => {
            preview.dismiss(); requestApplication(app.id, host?.environmentId, applicationReference(app));
          }}><span aria-hidden="true"><ApplicationIcon app={app}/></span><span>{app.title}</span></button>
          {app.kind === 'external' && <button type="button" className="sidebar-app-action" data-sidebar-app-edit={app.id}
            aria-label={t('sidebar.editNamedApp', { name: app.title })} onClick={() => editLink(app)}><Pencil aria-hidden="true"/></button>}
          {(app.kind === 'web' || app.kind === 'local' || app.kind === 'external') && <button type="button" className="sidebar-app-action" data-sidebar-app-remove={app.id}
            title={app.kind === 'web' ? t('appCenter.removeWebAppKeepSiteData') : undefined}
            aria-label={t('sidebar.removeNamedApp', { name: app.title })} onClick={() => remove(app)}><Trash2 aria-hidden="true"/></button>}
        </div>)}
        {!filtered.length && <p className="sidebar-app-empty">{t('appCenter.noMatchingApps')}</p>}
        <div className="sidebar-app-add">
          {window.cardbushDesktop?.localApplications && <button type="button" disabled={selectingLocal} onClick={() => void addLocal()}>
            <Plus aria-hidden="true"/><span>{t(selectingLocal ? 'appCenterSettingsMenu.choosing' : 'appCenterSettingsMenu.addLocalApp')}</span></button>}
          <button type="button" onClick={() => editLink()}><Plus aria-hidden="true"/><span>{t('appCenterSettingsMenu.addAppLink')}</span></button>
        </div>
      </div>
    </HoverPreview>
    {linkDialog && <ApplicationLinkDialog app={linkDialog.app} language={language} onClose={() => setLinkDialog(undefined)}/>}
  </>;
}
