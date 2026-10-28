import { uiText } from '../../i18n';
import { Star } from 'lucide-react';
import type { AppLanguage } from '../../types';
import { bookmarkUrl } from './browserBookmarks';
import { toggleBrowserBookmark, useBrowserBookmarks } from './useBrowserBookmarks';
import { showUiError } from '../../shared/showUiError';

export function BrowserBookmarkButton({ address, title, language }: { address: string; title: string; language: AppLanguage }) {
  const items = useBrowserBookmarks(), url = bookmarkUrl(address), saved = items.some(item => item.url === url);
  const label = (saved ? uiText(language)('browserBookmarkButton.removeBookmark') : uiText(language)('browserBookmarkButton.bookmarkThisPage'));
  return <button type="button" className="inspector-bookmark-button" disabled={!url} aria-label={label} title={label} aria-pressed={saved}
    onClick={() => { try { toggleBrowserBookmark(address, title); } catch (error) { void showUiError(uiText(language)('browserBookmarkButton.unableToSaveBookmark'), String(error)); } }}>
    <Star size={15} fill={saved ? 'currentColor' : 'none'} aria-hidden="true" />
  </button>;
}
