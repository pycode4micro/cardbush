import { createContext, useContext, useEffect, useState } from 'react';
import { AccountCache, cacheLimits } from './browserCache';
import { personalFilePath } from './personalFiles';

export const BrowserCacheContext = createContext<AccountCache | null>(null);
export function useAccountCache() {
  const cache = useContext(BrowserCacheContext);
  if (!cache) throw new Error('An authenticated cache scope is required.');
  return cache;
}
type ImageEntry = { src: string; bytes: number; users: number; touched: number };
class PersonalImages {
  private urls = new Map<string, ImageEntry>();
  private pending = new Map<string, Promise<ImageEntry>>();
  private abort = new AbortController();
  constructor(private cache: AccountCache) {
    cache.onClose(() => { this.abort.abort(); for (const value of this.urls.values()) URL.revokeObjectURL(value.src); this.urls.clear(); this.pending.clear(); });
  }
  peek(path: string) { return this.cache.valid() ? this.urls.get(path)?.src : undefined; }
  private remember(path: string, blob: Blob) {
    const existing = this.urls.get(path); if (existing) return existing;
    const entry = { src: URL.createObjectURL(blob), bytes: blob.size, users: 0, touched: Date.now() }; this.urls.set(path, entry); return entry;
  }
  seed(path: string, blob: Blob) {
    if (!this.cache.valid() || !personalFilePath(path) || !/^image\/(png|jpeg|webp)$/.test(blob.type) || blob.size > cacheLimits.imageBytes) return;
    this.cache.put(`image:${path}`, blob, 'image'); this.remember(path, blob); this.trim();
  }
  private async load(path: string) {
    let blob = await this.cache.get<Blob>(`image:${path}`);
    if (!blob) {
      const response = await fetch(`/api/web/v1/files/view?path=${encodeURIComponent(path)}`, { credentials: 'same-origin', cache: 'no-store', signal: this.abort.signal, headers: { 'X-CardBush-User': this.cache.owner } });
      if (response.status === 401 && this.cache.valid()) window.dispatchEvent(new Event('cardbush:logged-out'));
      if (!response.ok || !/^image\/(png|jpeg|webp)$/.test(response.headers.get('Content-Type') ?? '') || Number(response.headers.get('Content-Length')) > cacheLimits.imageBytes) throw new Error('图片暂时无法读取');
      blob = await response.blob();
      if (blob.size > cacheLimits.imageBytes) throw new Error('图片过大');
      this.cache.put(`image:${path}`, blob, 'image');
    }
    if (!this.cache.valid()) throw new Error('Account changed');
    return this.remember(path, blob);
  }
  async acquire(path: string) {
    if (!personalFilePath(path) || !this.cache.valid()) throw new Error('Invalid image scope');
    let entry = this.urls.get(path);
    if (!entry) {
      let pending = this.pending.get(path);
      if (!pending) { pending = this.load(path).finally(() => this.pending.delete(path)); this.pending.set(path, pending); }
      entry = await pending;
    }
    if (!this.cache.valid()) throw new Error('Account changed');
    entry.users++; entry.touched = Date.now(); this.trim();
    let released = false;
    return { src: entry.src, release: () => { if (released) return; released = true; entry!.users--; this.trim(); } };
  }
  private trim() {
    let bytes = [...this.urls.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    for (const [path, entry] of [...this.urls].sort((a, b) => a[1].touched - b[1].touched)) {
      if (bytes <= cacheLimits.memoryBytes) break;
      if (entry.users) continue;
      this.urls.delete(path); URL.revokeObjectURL(entry.src); bytes -= entry.bytes;
    }
  }
}
const imageStores = new WeakMap<AccountCache, PersonalImages>();
function images(cache: AccountCache) { let value = imageStores.get(cache); if (!value) { value = new PersonalImages(cache); imageStores.set(cache, value); } return value; }
export function seedCachedImage(cache: AccountCache, path: string, blob: Blob) { images(cache).seed(path, blob); }
export function peekCachedImage(cache: AccountCache, source: string) { const path = personalFilePath(source); return path ? images(cache).peek(path) : undefined; }
export async function acquireCachedImage(cache: AccountCache, source: string) {
  const path = personalFilePath(source);
  if (!path) throw new Error('只能查看当前账号的个人图片。');
  const result = await images(cache).acquire(path);
  return { source: result.src, dispose: result.release };
}
export function useCachedImage(source: string) {
  const cache = useAccountCache(), path = personalFilePath(source), store = images(cache);
  const [value, setValue] = useState<{ path: string; src?: string; failed?: boolean } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!path) return;
    let alive = true, release: (() => void) | undefined;
    void store.acquire(path).then(result => { if (!alive) { result.release(); return; } release = result.release; setValue({ path, src: result.src }); }).catch(() => { if (alive) setValue({ path, failed: true }); });
    return () => { alive = false; release?.(); };
  }, [store, path, attempt]);
  return { src: path ? store.peek(path) ?? (value?.path === path ? value.src : undefined) : undefined, failed: value?.path === path && value.failed, retry: () => { setValue(null); setAttempt(value => value + 1); } };
}
