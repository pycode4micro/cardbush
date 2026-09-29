import { Star } from 'lucide-react';
import type { AppLanguage } from '../../types';
import { bookmarkUrl } from './browserBookmarks';
import { toggleBrowserBookmark, useBrowserBookmarks } from './useBrowserBookmarks';
import { showUiError } from '../../shared/showUiError';

export function BrowserBookmarkButton({ address, title, language }: { address: string; title: string; language: AppLanguage }) {
  const items = useBrowserBookmarks(), url = bookmarkUrl(address), saved = items.some(item => item.url === url);
  const label = language === 'zh' ? saved ? '取消收藏' : '收藏此页面' : saved ? 'Remove bookmark' : 'Bookmark this page';
  return <button type="button" className="inspector-bookmark-button" disabled={!url} aria-label={label} title={label} aria-pressed={saved}
    onClick={() => { try { toggleBrowserBookmark(address, title); } catch (error) { void showUiError(language === 'zh' ? '无法保存收藏' : 'Unable to save bookmark', String(error)); } }}>
    <Star size={15} fill={saved ? 'currentColor' : 'none'} aria-hidden="true" />
  </button>;
}
