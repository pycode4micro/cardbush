import { useSyncExternalStore } from 'react';
import { bookmarkUrl, browserBookmarksKey, normalizeBookmarks, type BrowserBookmark } from './browserBookmarks';

const changed = 'cardbush:browser-bookmarks';
let previous = '', cached: BrowserBookmark[] = [];
function snapshot() {
  let raw = '';
  try { raw = localStorage.getItem(browserBookmarksKey) ?? ''; } catch { /* Keep the last readable snapshot. */ }
  if (raw !== previous) {
    previous = raw;
    try { cached = normalizeBookmarks(JSON.parse(raw)); } catch { cached = []; }
  }
  return cached;
}
function subscribe(listener: () => void) {
  const storage = (event: StorageEvent) => { if (!event.key || event.key === browserBookmarksKey) listener(); };
  window.addEventListener(changed, listener); window.addEventListener('storage', storage);
  return () => { window.removeEventListener(changed, listener); window.removeEventListener('storage', storage); };
}
export function importBrowserBookmarks(items: Array<{ url: string; title: string; folder?: string }>) {
  const current = snapshot(), next = normalizeBookmarks([...current, ...items]);
  // localStorage writes are atomic: quota failures preserve the old collection.
  localStorage.setItem(browserBookmarksKey, JSON.stringify(next));
  window.dispatchEvent(new Event(changed));
  return { added: next.length - current.length, duplicates: items.length - (next.length - current.length) };
}
export function toggleBrowserBookmark(address: string, title: string) {
  const url = bookmarkUrl(address);
  if (!url) return;
  const current = snapshot();
  const next = current.some(item => item.url === url) ? current.filter(item => item.url !== url)
    : normalizeBookmarks([...current, { url, title }]);
  localStorage.setItem(browserBookmarksKey, JSON.stringify(next));
  window.dispatchEvent(new Event(changed));
}
export function useBrowserBookmarks() { return useSyncExternalStore(subscribe, snapshot, snapshot); }
