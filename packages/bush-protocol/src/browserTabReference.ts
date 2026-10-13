/** A display reference identifies a tab; it grants no browser control. */
export type BrowserTabReference = {
  connectionId: string;
  tabId: string;
  targetKey?: string;
  title: string;
  url: string;
};

export type BrowserTabOpenResult = { status: 'opened' | 'missing' | 'unavailable'; message?: string };

export function browserTabReferenceHref(reference: BrowserTabReference): string {
  return `cardbush-browser://tab?${new URLSearchParams(Object.entries(reference).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))}`;
}

export function parseBrowserTabReference(href: string): BrowserTabReference | null {
  try {
    if (href.length > 16000) return null;
    const link = new URL(href);
    if (link.protocol !== 'cardbush-browser:' || link.hostname !== 'tab' || link.username || link.password || link.port || link.hash || link.pathname && link.pathname !== '/') return null;
    const value = (key: string) => link.searchParams.get(key) ?? '';
    const clean = (text: string, max: number) => !!text.trim() && text.length <= max && !/[\x00-\x1f\x7f]/.test(text);
    const connectionId = value('connectionId'), tabId = value('tabId'), title = value('title'), url = value('url'), targetKey = value('targetKey');
    if (!clean(tabId, 8192) || !clean(title, 1024) || !clean(url, 4096)) return null;
    const address = new URL(url);
    if (!['http:', 'https:'].includes(address.protocol) && url !== 'about:blank' || address.username || address.password) return null;
    if (connectionId !== 'cardbush' && (!/^[a-f0-9]{32}$/.test(connectionId) || !/^\d{1,10}$/.test(tabId) || !/^external:[a-f0-9-]{36}:\d{1,10}$/.test(targetKey) || !targetKey.endsWith(`:${tabId}`))) return null;
    if (connectionId === 'cardbush' && targetKey && !/^cardbush:[a-f0-9-]{36}$/.test(targetKey)) return null;
    return { connectionId, tabId, title, url, ...(targetKey ? { targetKey } : {}) };
  } catch { return null; }
}

/** Only host-returned identities become citations, never a URL guess. */
export function browserPageReference(page: Record<string, unknown>): string | undefined {
  const integrated = page.browser === 'cardbush';
  if (integrated && typeof page.targetKey !== 'string') return undefined;
  const reference: BrowserTabReference = {
    connectionId: integrated ? 'cardbush' : String(page.connectionId ?? ''),
    tabId: integrated ? String(page.tabId ?? '') : String(page.id ?? ''),
    title: String(page.title || page.url || 'Browser tab').replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 1024),
    url: String(page.url ?? ''),
    ...(typeof page.targetKey === 'string' ? { targetKey: page.targetKey } : {}),
  };
  const href = browserTabReferenceHref(reference);
  return parseBrowserTabReference(href) ? href : undefined;
}

export function browserPageLink(page: Record<string, unknown>): string {
  const title = String(page.title || page.url || '(untitled)').replace(/[\r\n]+/g, ' ').replace(/([\\\[\]])/g, '\\$1');
  return page.reference ? `[${title}](${page.reference})` : `${title} — ${String(page.url ?? '')}`;
}
