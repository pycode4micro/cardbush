import { FolderOpen, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AppLanguage } from '../../types';
import { useBrowserBookmarks } from '../inspector/useBrowserBookmarks';
import { BrowserSiteIcon } from './BrowserSiteIcon';

/** A bounded, directly navigable collection below the new tab's shortcuts. */
export function BrowserStartBookmarks({ language, onNavigate, onImport, onManage }: {
  language: AppLanguage; onNavigate: (url: string) => void; onImport: () => void; onManage: () => void;
}) {
  const zh = language === 'zh', bookmarks = useBrowserBookmarks();
  const [query, setQuery] = useState(''), [limit, setLimit] = useState(24);
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return bookmarks.filter(item => `${item.title}\n${item.url}\n${item.folder ?? ''}`.toLocaleLowerCase().includes(needle));
  }, [bookmarks, query]);
  return <section className="inspector-bookmark-library" aria-label={zh ? '收藏夹' : 'Bookmarks'}>
    <header><h2>{zh ? '收藏夹' : 'Bookmarks'}{bookmarks.length > 0 && <span>{bookmarks.length}</span>}</h2>
      <div><button type="button" onClick={onImport}>{zh ? '导入' : 'Import'}</button>
        {bookmarks.length > 0 && <button type="button" onClick={onManage}>{zh ? '管理' : 'Manage'}</button>}</div>
    </header>
    {bookmarks.length > 0 ? <>
      <label className="inspector-bookmark-search"><Search size={15} aria-hidden="true"/>
        <input type="search" value={query} placeholder={zh ? '搜索收藏名称、网址或文件夹' : 'Search bookmarks, URLs or folders'}
          aria-label={zh ? '搜索收藏夹' : 'Search bookmarks'} onChange={event => { setQuery(event.target.value); setLimit(24); }}/>
      </label>
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
