import { FolderOpen, Globe, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AppLanguage } from '../../types';
import { useBrowserBookmarks } from '../inspector/useBrowserBookmarks';
import { BrowserSiteIcon } from './BrowserSiteIcon';
import { useFrequentSites } from './useFrequentSites';

/** A bounded, directly navigable collection below the new tab's shortcuts. */
export function BrowserStartBookmarks({ language, onNavigate, onImport, onManage }: {
  language: AppLanguage; onNavigate: (url: string) => void; onImport: () => void; onManage: () => void;
}) {
  const zh = language === 'zh', bookmarks = useBrowserBookmarks();
  const frequent = useFrequentSites();
  const [view, setView] = useState<'frequent' | 'bookmarks'>('frequent');
  const [query, setQuery] = useState(''), [limit, setLimit] = useState(24);
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return bookmarks.filter(item => `${item.title}\n${item.url}\n${item.folder ?? ''}`.toLocaleLowerCase().includes(needle));
  }, [bookmarks, query]);
  return <section className="inspector-bookmark-library" aria-label={zh ? '网站' : 'Sites'}>
    <header>
      <div className="inspector-site-views" role="group" aria-label={zh ? '网站来源' : 'Site collection'}>
        <button type="button" data-site-view="frequent" aria-pressed={view === 'frequent'} onClick={() => setView('frequent')}>{zh ? '常用网站' : 'Frequent sites'}</button>
        <button type="button" data-site-view="bookmarks" aria-pressed={view === 'bookmarks'} onClick={() => setView('bookmarks')}>
          {zh ? '收藏夹' : 'Bookmarks'}{bookmarks.length > 0 && <span>{bookmarks.length}</span>}
        </button>
      </div>
      <div className="inspector-site-actions"><button type="button" onClick={onImport}>{zh ? '导入' : 'Import'}</button>
        {view === 'bookmarks' && bookmarks.length > 0 && <button type="button" onClick={onManage}>{zh ? '管理' : 'Manage'}</button>}</div>
    </header>
    {view === 'frequent' ? <>
      {frequent.loading ? <p className="inspector-bookmarks-empty" role="status">{zh ? '正在加载常用网站…' : 'Loading frequent sites…'}</p>
        : frequent.failed ? <p className="inspector-bookmarks-empty" role="status">{zh ? '常用网站暂时无法加载。' : 'Frequent sites could not be loaded.'}
          <button type="button" className="inspector-sites-retry" onClick={frequent.retry}>{zh ? '重试' : 'Retry'}</button>
        </p> : <>
          <div className="inspector-start-sites">
            {(frequent.sites.length ? frequent.sites : [{ url: 'https://www.google.com/', title: 'Google' }]).map(site =>
              <button type="button" key={site.url} className="inspector-bookmark-entry" onClick={() => onNavigate(site.url)}>
                {frequent.sites.length ? <BrowserSiteIcon url={site.url} size={24}/> : <Globe size={24} aria-hidden="true"/>}<strong>{site.title}</strong>
              </button>)}
          </div>
          {!frequent.sites.length && <p className="inspector-bookmarks-empty">{zh ? '访问网站后会自动出现在这里。' : 'Sites you visit will appear here automatically.'}</p>}
        </>}
    </> : bookmarks.length > 0 ? <>
      {(bookmarks.length > 8 || query) && <label className="inspector-bookmark-search"><Search size={15} aria-hidden="true"/>
        <input type="search" value={query} placeholder={zh ? '搜索收藏名称、网址或文件夹' : 'Search bookmarks, URLs or folders'}
          aria-label={zh ? '搜索收藏夹' : 'Search bookmarks'} onChange={event => { setQuery(event.target.value); setLimit(24); }}/>
      </label>}
      <div className="inspector-bookmark-grid">
        {matches.slice(0, limit).map(item => <button type="button" key={item.id} className="inspector-bookmark-link"
          title={`${item.title}\n${item.folder ? `${item.folder}\n` : ''}${item.url}`} onClick={() => onNavigate(item.url)}>
          <BrowserSiteIcon url={item.url} size={22}/>
          <span className="inspector-bookmark-label"><strong>{item.title}</strong>
            <small>{item.folder && <FolderOpen size={12} aria-hidden="true"/>}{item.folder || new URL(item.url).host}</small>
          </span>
        </button>)}
      </div>
      {!matches.length && <p className="inspector-bookmarks-empty">{zh ? '没有匹配的收藏。' : 'No matching bookmarks.'}</p>}
      {matches.length > limit && <button type="button" className="inspector-bookmarks-more" onClick={() => setLimit(value => value + 24)}>
        {zh ? `显示更多（${limit} / ${matches.length}）` : `Show more (${limit} / ${matches.length})`}
      </button>}
    </> : <p className="inspector-bookmarks-empty">{zh ? '点击地址栏的星标收藏网页，或从 Chrome / Edge 导入收藏夹。' : 'Bookmark a page with the address bar star, or import bookmarks from Chrome / Edge.'}</p>}
  </section>;
}
