import { dialogEventHandler } from '../../shared/dialogEvents';
import { useEffect, useRef, useState } from 'react';
import { Download, FolderOpen, Globe2, Pause, Play, Trash2, X } from 'lucide-react';
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
  const zh = language === 'zh', [profiles, setProfiles] = useState<BrowserProfile[]>([]), [selected, setSelected] = useState('');
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    const api = window.cardbushDesktop?.browser;
    if (!api) { setLoading(false); setError(zh ? '此环境不支持本地浏览器导入。' : 'Local browser import is unavailable.'); return; }
    api.profiles().then(items => { if (active) { setProfiles(items); setSelected(items[0]?.id ?? ''); } }, cause => { if (active) setError(errorMessage(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [zh]);
  const run = async (id?: string) => {
    const api = window.cardbushDesktop?.browser;
    if (!api) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const imported = await api.importBookmarks(id);
      if (!imported) return;
      const result = importBrowserBookmarks(imported.bookmarks);
      setNotice(zh ? `已导入 ${result.added} 个网址；跳过 ${result.duplicates + imported.skipped} 个重复或不支持的条目。` : `Imported ${result.added} bookmarks; skipped ${result.duplicates + imported.skipped} duplicate or unsupported entries.`);
    } catch (cause) { setError(errorMessage(cause)); }
    finally { setBusy(false); }
  };
  return <div className="browser-bookmark-import">
    <p>{zh ? '选择浏览器的个人配置，收藏夹会合并到 CardBush；相同网址只保留一份，保留目录名称。' : 'Merge bookmarks from a browser profile into CardBush, keeping folder names and skipping duplicate URLs.'}</p>
    <div className="browser-import-controls">
      <select aria-label={zh ? '浏览器个人配置' : 'Browser profile'} value={selected} disabled={loading || busy || !profiles.length} onChange={event => setSelected(event.target.value)}>
        {!profiles.length && <option value="">{loading ? (zh ? '正在查找…' : 'Looking for profiles…') : (zh ? '未找到本机收藏夹' : 'No local bookmarks found')}</option>}
        {profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.browser === 'chrome' ? 'Chrome' : 'Edge'} · {profile.name}</option>)}
      </select>
      <button type="button" disabled={busy || !selected} onClick={() => void run(selected)}>{zh ? '导入收藏夹' : 'Import bookmarks'}</button>
    </div>
    <button type="button" disabled={busy || !window.cardbushDesktop?.browser} onClick={() => void run()}>{zh ? '选择导出的 HTML / Bookmarks 文件…' : 'Choose an exported HTML / Bookmarks file…'}</button>
    <p className="browser-muted">{zh ? '找不到配置时，可在 Chrome / Edge 的收藏夹管理器中导出 HTML，再选择文件导入。' : 'You can also export HTML from Chrome / Edge’s bookmark manager and select that file here.'}</p>
    {busy && <p role="status">{zh ? '正在导入…' : 'Importing…'}</p>}{notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </div>;
}

export function BrowserLibraryDialog({ kind, language, guestId, url = '', onClose, onNavigate }: {
  kind: BrowserDialogKind; language: AppLanguage; guestId?: number; url?: string; onClose: () => void; onNavigate?: (url: string) => void;
}) {
  const zh = language === 'zh', dialog = useRef<HTMLDialogElement>(null), bookmarks = useBrowserBookmarks();
  const [query, setQuery] = useState(''), [offset, setOffset] = useState(0), [revision, setRevision] = useState(0);
  const [rows, setRows] = useState<Array<BrowserVisit | BrowserDownload>>([]), [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [loaded, setLoaded] = useState(false), [notice, setNotice] = useState('');
  const [clear, setClear] = useState({ history: true, downloads: false, cache: false, site: false });
  const title = ({ import: zh ? '导入收藏夹' : 'Import bookmarks', bookmarks: zh ? '收藏夹' : 'Bookmarks', history: zh ? '浏览历史' : 'Browsing history', downloads: zh ? '下载' : 'Downloads', clear: zh ? '清除浏览数据' : 'Clear browsing data' })[kind];
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
        if (!api) throw Error(zh ? '此环境不支持浏览器记录。' : 'Browser records are unavailable.');
        const result = await api[kind](query, offset);
        if (active) { setRows(result.items); setTotal(result.total); setError(''); }
      } catch (cause) { if (active) setError(errorMessage(cause)); }
      finally { if (active) { setLoaded(true); if (kind === 'downloads') polling = window.setTimeout(() => void load(), 1000); } }
    };
    const timer = window.setTimeout(() => void load(), 120);
    return () => { active = false; window.clearTimeout(timer); window.clearTimeout(polling); };
  }, [kind, query, offset, revision, zh]);
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
    <header><h2>{title}</h2><button type="button" disabled={busy} aria-label={zh ? '关闭' : 'Close'} onClick={onClose}><X size={18}/></button></header>
    {kind === 'import' ? <BrowserBookmarkImport language={language}/> : kind === 'clear' ? <div className="browser-clear-options">
      <p>{zh ? '选择要清除的项目。下载记录不会删除已保存的文件。' : 'Choose what to clear. Clearing download history keeps the downloaded files.'}</p>
      {(['history', 'downloads', 'cache', 'site'] as const).map(key => <label key={key}><input type="checkbox" checked={clear[key]} disabled={busy || key === 'site' && (!guestId || !origin)} onChange={event => setClear(value => ({ ...value, [key]: event.target.checked }))}/>
        {({ history: zh ? '浏览历史记录' : 'Browsing history', downloads: zh ? '已结束的下载记录' : 'Finished download history', cache: zh ? '缓存的网页文件' : 'Cached page files', site: zh ? '当前网站的 Cookie 和站点存储' : 'Cookies and storage for the current site' })[key]}</label>)}
      {origin && <p className="browser-muted">{origin}{zh ? ' · 清理站点数据后可能需要重新登录。' : ' · Clearing site data may sign you out.'}</p>}
      <button type="button" disabled={busy || !Object.values(clear).some(Boolean)} onClick={() => void run(async () => {
        const api = window.cardbushDesktop?.browser; if (!api) throw Error('Browser data management unavailable.');
        await api.clearData({ ...clear, guestId, origin }); setNotice(zh ? '所选数据已清除。' : 'Selected data cleared.');
      })}>{busy ? (zh ? '正在清除…' : 'Clearing…') : (zh ? '清除所选数据' : 'Clear selected data')}</button>
    </div> : <>
      <input className="browser-library-search" autoFocus placeholder={zh ? '搜索名称、网址或目录' : 'Search names, URLs or folders'} aria-label={zh ? '搜索' : 'Search'} value={query} onChange={event => { setQuery(event.target.value); setOffset(0); }}/>
      <div className="browser-library-list">
        {kind === 'bookmarks' ? matches.slice(offset, offset + 50).map(item => <div key={item.id} className="browser-library-row">
          <BrowserSiteIcon url={item.url}/><button className="browser-library-link" type="button" disabled={!onNavigate} onClick={() => open(item.url)}><strong>{item.title}</strong><small>{item.folder && `${item.folder} · `}{item.url}</small></button>
          <button type="button" disabled={busy} aria-label={`${zh ? '删除收藏' : 'Remove bookmark'} ${item.title}`} onClick={() => void run(() => toggleBrowserBookmark(item.url, item.title))}><Trash2 size={15}/></button>
        </div>) : rows.map(item => 'title' in item ? <div key={item.id} className="browser-library-row">
          <Globe2 size={16}/><button className="browser-library-link" type="button" disabled={!onNavigate} onClick={() => open(item.url)}><strong>{item.title}</strong><small>{new Date(item.visitedAt).toLocaleString()} · {item.url}</small></button>
          <button type="button" disabled={busy} aria-label={zh ? '删除此记录' : 'Remove visit'} onClick={() => void run(() => window.cardbushDesktop?.browser?.removeVisit(item.id))}><Trash2 size={15}/></button>
        </div> : <div key={item.id} className="browser-library-row">
          <Download size={17}/><div className="browser-download-info"><strong>{item.name}</strong><small>{({ progressing: item.paused ? (zh ? '已暂停' : 'Paused') : (zh ? '下载中' : 'Downloading'), completed: zh ? '已完成' : 'Completed', interrupted: zh ? '已中断' : 'Interrupted', cancelled: zh ? '已取消' : 'Cancelled' })[item.state]} · {bytes(item.received)}{item.total > 0 ? ` / ${bytes(item.total)}` : ''}</small>
            {item.state === 'progressing' && <progress value={item.total > 0 ? item.received : undefined} max={item.total || 1}/>}<small title={item.url}>{item.url}</small></div>
          {item.state === 'progressing' && <><button type="button" disabled={busy} aria-label={item.paused ? (zh ? '继续下载' : 'Resume') : (zh ? '暂停下载' : 'Pause')} onClick={() => void run(() => window.cardbushDesktop?.browser?.downloadAction(item.id, item.paused ? 'resume' : 'pause'))}>{item.paused ? <Play size={15}/> : <Pause size={15}/>}</button><button type="button" disabled={busy} aria-label={zh ? '取消下载' : 'Cancel download'} onClick={() => void run(() => window.cardbushDesktop?.browser?.downloadAction(item.id, 'cancel'))}><X size={15}/></button></>}
          {item.path && <button type="button" aria-label={zh ? '在文件夹中显示' : 'Show in folder'} onClick={() => void run(() => window.cardbushDesktop?.browser?.downloadAction(item.id, 'show'))}><FolderOpen size={15}/></button>}
        </div>)}
        {!count && (kind === 'bookmarks' || loaded) && <p className="browser-muted">{query ? (zh ? '没有匹配的记录。' : 'No matches.') : (zh ? '暂无记录。' : 'No records yet.')}</p>}
        {!loaded && kind !== 'bookmarks' && <p role="status">{zh ? '正在加载…' : 'Loading…'}</p>}
      </div>
      <footer><small>{count} {zh ? '条' : 'items'}</small><button type="button" disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - 50))}>{zh ? '上一页' : 'Previous'}</button><button type="button" disabled={offset + 50 >= count} onClick={() => setOffset(value => value + 50)}>{zh ? '下一页' : 'Next'}</button></footer>
    </>}
    {notice && <p role="status">{notice}</p>}{error && <p role="alert">{error}</p>}
  </dialog>;
}
