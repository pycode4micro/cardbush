import { uiText } from '../../i18n';
import { dialogEventHandler } from '../../shared/dialogEvents';
import { useEffect, useRef, useState } from 'react';
import { Download, FolderOpen, Globe, Pause, Play, Trash2, X } from 'lucide-react';
import type { AppLanguage } from '../../types';
import type { BrowserProfile } from '../../../electron/browserImport';
import type { BrowserDownload, BrowserVisit } from '../../../electron/browserLibrary';
import { importBrowserBookmarks, toggleBrowserBookmark, useBrowserBookmarks } from '../inspector/useBrowserBookmarks';
import './browserTools.css';
import { BrowserSiteIcon } from './BrowserSiteIcon';

export type BrowserDialogKind = 'import' | 'bookmarks' | 'history' | 'downloads' | 'clear';
const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const bytes = (value: number) => value < 1024 ? `${value} B` : value < 1024 * 1024 ? `${(value / 1024).toFixed(1)} KB` : `${(value / 1024 / 1024).toFixed(1)} MB`;

export function BrowserBookmarkImport({ language }: { language: AppLanguage }) {
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]), [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    const api = window.cardbushDesktop?.browser;
    if (!api) { setLoading(false); setError(uiText(language)('browserLibraryDialog.localBrowserImportIsUnavailable')); return; }
    api.profiles().then(items => { if (active) { setProfiles(items); setSelected(items[0]?.id ?? ''); } }, cause => { if (active) setError(errorMessage(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [language]);
  const run = async (id?: string) => {
    const api = window.cardbushDesktop?.browser;
    if (!api) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const imported = await api.importBookmarks(id);
      if (!imported) return;
      const result = importBrowserBookmarks(imported.bookmarks);
      setNotice(uiText(language)('browserLibraryDialog.importedBookmarksSkippedDuplicateOrUnsupportedEntries', { value1: result.added, value2: result.duplicates + imported.skipped }));
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  return <div className="browser-bookmark-import">
    <p>{uiText(language)('browserLibraryDialog.mergeBookmarksFromABrowserProfileInto')}</p>
    <div className="browser-import-controls">
      <select aria-label={uiText(language)('browserLibraryDialog.browserProfile')} value={selected} disabled={loading || busy || !profiles.length} onChange={event => setSelected(event.target.value)}>
        {!profiles.length && <option value="">{loading ? (uiText(language)('browserLibraryDialog.lookingForProfiles')) : (uiText(language)('browserLibraryDialog.noLocalBookmarksFound'))}</option>}
        {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.browser === 'chrome' ? 'Chrome' : 'Edge'} · {profile.name}</option>)}
      </select>
      <button type="button" disabled={busy || !selected} onClick={() => void run(selected)}>{uiText(language)('browserLibraryDialog.importBookmarks')}</button>
    </div>
    <button type="button" disabled={busy || !window.cardbushDesktop?.browser} onClick={() => void run()}>{uiText(language)('browserLibraryDialog.chooseAnExportedHtmlBookmarksFile')}</button>
    <p className="browser-muted">{uiText(language)('browserLibraryDialog.youCanAlsoExportHtmlFromChrome')}</p>
    {busy && <p role="status">{uiText(language)('browserLibraryDialog.importing')}</p>}{notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </div>;
}

export function BrowserLibraryDialog({ kind, language, guestId, url = '', onClose, onNavigate }: {
  kind: BrowserDialogKind; language: AppLanguage; guestId?: number; url?: string; onClose: () => void; onNavigate?: (url: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), bookmarks = useBrowserBookmarks();
  const [query, setQuery] = useState(''), [offset, setOffset] = useState(0), [revision, setRevision] = useState(0);
  const [rows, setRows] = useState<Array<BrowserVisit | BrowserDownload>>([]), [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [loaded, setLoaded] = useState(false), [notice, setNotice] = useState('');
  const [clear, setClear] = useState({ history: true, downloads: false, cache: false, site: false });
  const title = ({ import: uiText(language)('browserLibraryDialog.importBookmarks'), bookmarks: uiText(language)('browserLibraryDialog.bookmarks'), history: uiText(language)('browserLibraryDialog.browsingHistory'), downloads: uiText(language)('browserLibraryDialog.downloads'), clear: uiText(language)('browserLibraryDialog.clearBrowsingData') })[kind];
  let origin = '';
  try { if (/^https?:/.test(url)) origin = new URL(url).origin; } catch { /* No site selected. */ }
  useEffect(() => { const node = dialog.current; node?.showModal(); return () => node?.close(); }, []);
  useEffect(() => {
    if (kind !== 'history' && kind !== 'downloads') return;
    let active = true, polling = 0;
    setLoaded(false);
    const load = async () => {
      try {
        const api = window.cardbushDesktop?.browser;
        if (!api) throw Error(uiText(language)('browserLibraryDialog.browserRecordsAreUnavailable'));
        const result = await api[kind](query, offset);
        if (active) { setRows(result.items); setTotal(result.total); setError(''); }
      } catch (cause) { if (active) setError(errorMessage(cause)); }
      finally { if (active) { setLoaded(true); if (kind === 'downloads') polling = window.setTimeout(() => void load(), 1000); } }
    };
    const timer = window.setTimeout(() => void load(), 120);
    return () => { active = false; window.clearTimeout(timer); window.clearTimeout(polling); };
  }, [kind, query, offset, revision, language]);
  const run = async (action: () => Promise<unknown> | unknown) => {
    setBusy(true); setError(''); setNotice('');
    try { await action(); setRevision(value => value + 1); }
    catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  const matches = bookmarks.filter(item => `${item.title} ${item.url} ${item.folder ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const count = kind === 'bookmarks' ? matches.length : total;
  const open = (address: string) => { onNavigate?.(address); onClose(); };
  return <dialog ref={dialog} className="browser-library-dialog" onCancel={dialogEventHandler(event => { if (busy) event.preventDefault(); else onClose(); })} aria-label={title}>
    <header><h2>{title}</h2><button type="button" disabled={busy} aria-label={uiText(language)('common.close')} onClick={onClose}><X size={18}/></button></header>
    {kind === 'import' ? <BrowserBookmarkImport language={language}/> : kind === 'clear' ? <div className="browser-clear-options">
      <p>{uiText(language)('browserLibraryDialog.chooseWhatToClearClearingDownloadHistory')}</p>
      {(['history', 'downloads', 'cache', 'site'] as const).map(key => <label key={key}><input type="checkbox" checked={clear[key]} disabled={busy || key === 'site' && (!guestId || !origin)} onChange={event => setClear(value => ({ ...value, [key]: event.target.checked }))}/>
        {({ history: uiText(language)('browserLibraryDialog.browsingHistory_88eae5d'), downloads: uiText(language)('browserLibraryDialog.finishedDownloadHistory'), cache: uiText(language)('browserLibraryDialog.cachedPageFiles'), site: uiText(language)('browserLibraryDialog.cookiesAndStorageForTheCurrentSite') })[key]}</label>)}
      {origin && <p className="browser-muted">{origin}{uiText(language)('browserLibraryDialog.clearingSiteDataMaySignYouOut')}</p>}
      <button type="button" disabled={busy || !Object.values(clear).some(Boolean)} onClick={() => void run(async () => {
        const api = window.cardbushDesktop?.browser; if (!api) throw Error(uiText(language)('browserLibraryDialog.browser_data_management_unavailable'));
        await api.clearData({ ...clear, guestId, origin }); setNotice(uiText(language)('browserLibraryDialog.selectedDataCleared'));
      })}>{busy ? (uiText(language)('browserLibraryDialog.clearing')) : (uiText(language)('browserLibraryDialog.clearSelectedData'))}</button>
    </div> : <>
      <input className="browser-library-search" autoFocus placeholder={uiText(language)('browserLibraryDialog.searchNamesUrlsOrFolders')} aria-label={uiText(language)('browserLibraryDialog.search')} value={query} onChange={event => { setQuery(event.target.value); setOffset(0); }}/>
      <div className="browser-library-list">
        {kind === 'bookmarks' ? matches.slice(offset, offset + 50).map(item => <div key={item.id} className="browser-library-row">
          <BrowserSiteIcon url={item.url}/><button className="browser-library-link" type="button" disabled={!onNavigate} onClick={() => open(item.url)}><strong>{item.title}</strong><small>{item.folder && `${item.folder} · `}{item.url}</small></button>
          <button type="button" disabled={busy} aria-label={`${uiText(language)('browserLibraryDialog.removeBookmark')} ${item.title}`} onClick={() => void run(() => toggleBrowserBookmark(item.url, item.title))}><Trash2 size={15}/></button>
        </div>) : rows.map(item => 'title' in item ? <div key={item.id} className="browser-library-row">
          <Globe size={16}/><button className="browser-library-link" type="button" disabled={!onNavigate} onClick={() => open(item.url)}><strong>{item.title}</strong><small>{new Date(item.visitedAt).toLocaleString()} · {item.url}</small></button>
          <button type="button" disabled={busy} aria-label={uiText(language)('browserLibraryDialog.removeVisit')} onClick={() => void run(() => window.cardbushDesktop?.browser?.removeVisit(item.id))}><Trash2 size={15}/></button>
        </div> : <div key={item.id} className="browser-library-row">
          <Download size={17}/><div className="browser-download-info"><strong>{item.name}</strong><small>{({ progressing: item.paused ? (uiText(language)('automationPanel.paused')) : (uiText(language)('browserLibraryDialog.downloading')), completed: uiText(language)('automationPanel.completed'), interrupted: uiText(language)('browserLibraryDialog.interrupted'), cancelled: uiText(language)('browserLibraryDialog.cancelled') })[item.state]} · {bytes(item.received)}{item.total > 0 ? ` / ${bytes(item.total)}` : ''}</small>
            {item.state === 'progressing' && <progress value={item.total > 0 ? item.received : undefined} max={item.total || 1}/>}<small title={item.url}>{item.url}</small></div>
          {item.state === 'progressing' && <><button type="button" disabled={busy} aria-label={item.paused ? (uiText(language)('browserLibraryDialog.resume')) : (uiText(language)('browserLibraryDialog.pause'))} onClick={() => void run(() => window.cardbushDesktop?.browser?.downloadAction(item.id, item.paused ? 'resume' : 'pause'))}>{item.paused ? <Play size={15}/> : <Pause size={15}/>}</button><button type="button" disabled={busy} aria-label={uiText(language)('browserLibraryDialog.cancelDownload')} onClick={() => void run(() => window.cardbushDesktop?.browser?.downloadAction(item.id, 'cancel'))}><X size={15}/></button></>}
          {item.path && <button type="button" aria-label={uiText(language)('browserLibraryDialog.showInFolder')} onClick={() => void run(() => window.cardbushDesktop?.browser?.downloadAction(item.id, 'show'))}><FolderOpen size={15}/></button>}
        </div>)}
        {!count && (kind === 'bookmarks' || loaded) && <p className="browser-muted">{query ? (uiText(language)('browserLibraryDialog.noMatches')) : (uiText(language)('browserLibraryDialog.noRecordsYet'))}</p>}
        {!loaded && kind !== 'bookmarks' && <p role="status">{uiText(language)('common.loading')}</p>}
      </div>
      <footer><small>{count} {uiText(language)('browserLibraryDialog.items')}</small><button type="button" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - 50))}>{uiText(language)('browserLibraryDialog.previous')}</button><button type="button" disabled={offset + 50 >= count} onClick={() => setOffset(value => value + 50)}>{uiText(language)('browserLibraryDialog.next')}</button></footer>
    </>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </dialog>;
}
