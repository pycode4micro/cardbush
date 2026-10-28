import { uiText } from '../../i18n';
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
  const bookmarks = useBrowserBookmarks();
  const frequent = useFrequentSites();
  const [view, setView] = useState<'frequent' | 'bookmarks'>('frequent');
  const [query, setQuery] = useState(''), [limit, setLimit] = useState(24);
  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return bookmarks.filter(item => `${item.title}\n${item.url}\n${item.folder ?? ''}`.toLocaleLowerCase().includes(needle));
  }, [bookmarks, query]);
  return <section className="inspector-bookmark-library" aria-label={uiText(language)('browserStartBookmarks.sites')}>
    <header>
      <div className="inspector-site-views" role="group" aria-label={uiText(language)('browserStartBookmarks.siteCollection')}>
        <button type="button" data-site-view="frequent" aria-pressed={view === 'frequent'} onClick={() => setView('frequent')}>{uiText(language)('browserStartBookmarks.frequentSites')}</button>
        <button type="button" data-site-view="bookmarks" aria-pressed={view === 'bookmarks'} onClick={() => setView('bookmarks')}>
          {uiText(language)('browserLibraryDialog.bookmarks')}{bookmarks.length > 0 && <span>{bookmarks.length}</span>}
        </button>
      </div>
      <div className="inspector-site-actions"><button type="button" onClick={onImport}>{uiText(language)('browserStartBookmarks.import')}</button>
        {view === 'bookmarks' && bookmarks.length > 0 && <button type="button" onClick={onManage}>{uiText(language)('browserStartBookmarks.manage')}</button>}</div>
    </header>
    {view === 'frequent' ? <>
      {frequent.loading ? <p className="inspector-bookmarks-empty" role="status">{uiText(language)('browserStartBookmarks.loadingFrequentSites')}</p>
        : frequent.failed ? <p className="inspector-bookmarks-empty" role="status">{uiText(language)('browserStartBookmarks.frequentSitesCouldNotBeLoaded')}
          <button type="button" className="inspector-sites-retry" onClick={frequent.retry}>{uiText(language)('common.retry')}</button>
        </p> : <>
          <div className="inspector-start-sites">
            {(frequent.sites.length ? frequent.sites : [{ url: 'https://www.google.com/', title: 'Google' }]).map(site =>
              <button type="button" key={site.url} className="inspector-bookmark-entry" onClick={() => onNavigate(site.url)}>
                {frequent.sites.length ? <BrowserSiteIcon url={site.url} size={24}/> : <Globe size={24} aria-hidden="true"/>}<strong>{site.title}</strong>
              </button>)}
          </div>
          {!frequent.sites.length && <p className="inspector-bookmarks-empty">{uiText(language)('browserStartBookmarks.sitesYouVisitWillAppearHereAutomatically')}</p>}
        </>}
    </> : bookmarks.length > 0 ? <>
      {(bookmarks.length > 8 || query) && <label className="inspector-bookmark-search"><Search size={15} aria-hidden="true"/>
        <input type="search" value={query} placeholder={uiText(language)('browserStartBookmarks.searchBookmarksUrlsOrFolders')}
          aria-label={uiText(language)('browserStartBookmarks.searchBookmarks')} onChange={event => { setQuery(event.target.value); setLimit(24); }}/>
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
      {!matches.length && <p className="inspector-bookmarks-empty">{uiText(language)('browserStartBookmarks.noMatchingBookmarks')}</p>}
      {matches.length > limit && <button type="button" className="inspector-bookmarks-more" onClick={() => setLimit(value => value + 24)}>
        {uiText(language)('browserStartBookmarks.showMore', { limit, value2: matches.length })}
      </button>}
    </> : <p className="inspector-bookmarks-empty">{uiText(language)('browserStartBookmarks.bookmarkAPageWithTheAddressBar')}</p>}
  </section>;
}
