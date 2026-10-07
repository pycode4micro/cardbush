export type BrowserBookmark = { id: string; title: string; url: string; folder?: string };
export const browserBookmarksKey = 'cardbush.browser_bookmarks.v1';

export function bookmarkUrl(input: unknown): string | undefined {
  if (typeof input !== 'string' || input.length > 4096) return;
  try {
    const url = new URL(input);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* Only navigable web addresses may be bookmarked. */ }
}

export function normalizeBookmarks(input: unknown): BrowserBookmark[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  return input.flatMap(item => {
    const url = bookmarkUrl(item?.url);
    if (!url || seen.has(url)) return [];
    seen.add(url);
    return [{ id: url, url, title: typeof item.title === 'string' && item.title.trim()
      ? item.title.trim().slice(0, 300) : new URL(url).host,
      ...(typeof item.folder === 'string' && item.folder.trim() ? { folder: item.folder.trim().slice(0, 1000) } : {}) }];
  });
}
