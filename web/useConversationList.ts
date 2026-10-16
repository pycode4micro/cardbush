import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Conversation, type ConversationPage } from './api';
import { useAccountCache } from './BrowserCacheProvider';

export function useConversationList(archive: boolean, query: string, onError: (message: string) => void) {
  const cache = useAccountCache();
  const [items, setItems] = useState<Conversation[]>([]), [nextCursor, setNextCursor] = useState<string | null>(null), [loading, setLoading] = useState(false);
  const scope = useRef(''), revision = useRef(0), cursor = useRef<string | null>(null);
  const request = useRef<{ controller: AbortController; promise: Promise<void> } | null>(null);
  const filter = useRef({ archive, query }); filter.current = { archive, query };
  const read = useCallback(async (more = false) => {
    if (more && (request.current || !cursor.current)) return;
    request.current?.controller.abort();
    const controller = new AbortController(), version = ++revision.current;
    const params = new URLSearchParams({ limit: '30', archived: String(filter.current.archive), q: filter.current.query.trim() });
    const key = `list:v2:${params}`; scope.current = key;
    if (more) params.set('cursor', cursor.current!);
    setLoading(true);
    const promise = api<ConversationPage>(`/sessions?${params}`, 'GET', undefined, controller.signal).then(page => {
      if (controller.signal.aborted || !cache.valid() || version !== revision.current) return;
      cursor.current = page.nextCursor; setNextCursor(page.nextCursor);
      setItems(previous => more ? [...new Map([...previous, ...page.items].map(item => [item.id, item])).values()] : page.items);
      if (!more) cache.put(key, page, 'list');
      for (const item of page.items) cache.allowSession(item.id);
    }).catch(error => { if (!controller.signal.aborted && cache.valid() && version === revision.current) onError(error instanceof Error ? error.message : '会话列表读取失败。'); })
      .finally(() => { if (request.current?.controller === controller) { request.current = null; setLoading(false); } });
    request.current = { controller, promise }; await promise;
  }, [cache, onError]);
  useEffect(() => {
    request.current?.controller.abort(); request.current = null;
    const version = ++revision.current;
    const key = `list:v2:${new URLSearchParams({ limit: '30', archived: String(archive), q: query.trim() })}`;
    scope.current = key; cursor.current = null; setNextCursor(null); setItems([]); setLoading(true);
    void cache.get<ConversationPage>(key).then(page => {
      if (page && cache.valid() && version === revision.current) { setItems(page.items); cursor.current = page.nextCursor; setNextCursor(page.nextCursor); }
    });
    const timer = setTimeout(() => void read(), query ? 250 : 0);
    return () => { clearTimeout(timer); revision.current++; request.current?.controller.abort(); request.current = null; };
  }, [archive, query, cache, read]);
  const refresh = useCallback(async (_force = false) => { await read(); }, [read]);
  return { items, setItems, nextCursor, loading, refresh, more: () => read(true) };
}
