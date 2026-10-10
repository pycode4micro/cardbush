/** Private, bounded, best-effort browser storage. Authentication always happens first. */
export type CacheKind = 'state' | 'image' | 'list' | 'selection';
export type CacheEntry = { id: string; owner: string; key: string; kind: CacheKind; value: unknown; bytes: number; expires: number; touched: number };
export interface CacheDisk {
  read(owner: string, key: string): Promise<CacheEntry | undefined>;
  write(entry: CacheEntry, valid: () => boolean): Promise<void>;
  remove(owner: string, key: string): Promise<void>;
  clear(): Promise<void>;
}
const MB = 1024 * 1024;
export const cacheLimits = { memoryBytes: 24 * MB, diskBytes: 128 * MB, stateCount: 40, imageCount: 160, textBytes: 12 * MB, stateBytes: 2 * MB, imageBytes: 16 * MB, ttl: 7 * 86400_000 };
export function cacheEvictions(entries: CacheEntry[], now: number) {
  let bytes = 0, textBytes = 0, states = 0, images = 0;
  return [...entries].sort((a, b) => b.touched - a.touched).filter(entry => {
    if (entry.expires <= now) return true;
    const nextBytes = bytes + entry.bytes, nextText = textBytes + (entry.kind === 'image' ? 0 : entry.bytes);
    const nextStates = states + Number(entry.kind === 'state'), nextImages = images + Number(entry.kind === 'image');
    if (nextBytes > cacheLimits.diskBytes || nextText > cacheLimits.textBytes || nextStates > cacheLimits.stateCount || nextImages > cacheLimits.imageCount) return true;
    bytes = nextBytes; textBytes = nextText; states = nextStates; images = nextImages; return false;
  }).map(entry => entry.id);
}
let database: Promise<IDBDatabase> | undefined;
function openDatabase() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('cardbush-private-cache-v1', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('entries', { keyPath: 'id' });
    request.onsuccess = () => { request.result.onversionchange = () => { request.result.close(); database = undefined; }; resolve(request.result); };
    request.onerror = () => { database = undefined; reject(request.error); };
    request.onblocked = () => reject(new Error('Browser cache is busy'));
  });
}
function transactionDone(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = transaction.onabort = () => reject(transaction.error); });
}
const entryId = (owner: string, key: string) => JSON.stringify([owner, key]);
export class IndexedCacheDisk implements CacheDisk {
  async read(owner: string, key: string) {
    const db = await openDatabase();
    return new Promise<CacheEntry | undefined>((resolve, reject) => { const request = db.transaction('entries').objectStore('entries').get(entryId(owner, key)); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
  }
  async write(entry: CacheEntry, valid: () => boolean) {
    const db = await openDatabase(); if (!valid()) return;
    const transaction = db.transaction('entries', 'readwrite'), done = transactionDone(transaction), store = transaction.objectStore('entries');
    store.put(entry);
    const request = store.getAll();
    request.onsuccess = () => { for (const id of cacheEvictions(request.result, Date.now())) store.delete(id); };
    await done;
  }
  async remove(owner: string, key: string) { const db = await openDatabase(), transaction = db.transaction('entries', 'readwrite'), done = transactionDone(transaction); transaction.objectStore('entries').delete(entryId(owner, key)); await done; }
  async clear() { const db = await openDatabase(), transaction = db.transaction('entries', 'readwrite'), done = transactionDone(transaction); transaction.objectStore('entries').clear(); await done; }
}

export class AccountCache {
  private entries = new Map<string, CacheEntry>();
  private versions = new Map<string, number>();
  private alive = true;
  private writes = Promise.resolve();
  private allowedSessions: Set<string> | null = null;
  private cleanups = new Set<() => void>();
  constructor(readonly owner: string, private disk: CacheDisk, private guard: () => boolean = () => true, private now = () => Date.now()) {}
  valid() { return this.alive && this.guard(); }
  private permits(key: string) { return this.valid() && (!key.startsWith('state:') || !this.allowedSessions || this.allowedSessions.has(key.slice(6))); }
  private remember(entry: CacheEntry) {
    this.entries.delete(entry.key); this.entries.set(entry.key, entry);
    let size = [...this.entries.values()].reduce((sum, value) => sum + value.bytes, 0);
    for (const [key, value] of this.entries) { if (size <= cacheLimits.memoryBytes && this.entries.size <= 200) break; this.entries.delete(key); size -= value.bytes; }
  }
  peek<T>(key: string): T | undefined {
    if (!this.permits(key)) return;
    const entry = this.entries.get(key);
    if (!entry || entry.expires <= this.now()) { this.entries.delete(key); return; }
    entry.touched = this.now(); this.remember(entry); return entry.value as T;
  }
  async get<T>(key: string): Promise<T | undefined> {
    const cached = this.peek<T>(key); if (cached !== undefined || !this.permits(key)) return cached;
    const version = this.versions.get(key);
    try {
      const entry = await this.disk.read(this.owner, key);
      if (!this.permits(key)) return;
      if (version !== this.versions.get(key)) return this.peek<T>(key);
      if (entry?.owner !== this.owner || entry?.key !== key || entry.expires <= this.now()) return;
      entry.touched = this.now(); this.remember(entry); this.enqueue(() => this.disk.write(entry, () => this.permits(key) && version === this.versions.get(key)));
      return entry.value as T;
    } catch { return; } // Private mode / quota denial must never break the conversation.
  }
  put(key: string, value: unknown, kind: CacheKind) {
    if (!this.permits(key)) return;
    let bytes: number;
    try { bytes = value instanceof Blob ? value.size : new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { return; }
    if (bytes > (kind === 'image' ? cacheLimits.imageBytes : cacheLimits.stateBytes)) { this.forget(key); return; }
    const version = (this.versions.get(key) ?? 0) + 1; this.versions.set(key, version);
    const entry: CacheEntry = { id: entryId(this.owner, key), owner: this.owner, key, kind, value, bytes, touched: this.now(), expires: this.now() + cacheLimits.ttl };
    this.remember(entry); this.enqueue(() => this.disk.write(entry, () => this.permits(key) && this.versions.get(key) === version));
  }
  forget(key: string) {
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1); this.entries.delete(key);
    this.enqueue(() => this.disk.remove(this.owner, key));
  }
  reconcileSessions(ids: string[]) {
    this.allowedSessions = new Set(ids);
    for (const key of new Set([...this.entries.keys(), ...this.versions.keys()])) if (key.startsWith('state:') && !this.allowedSessions.has(key.slice(6))) this.forget(key);
  }
  allowSession(id: string) { this.allowedSessions?.add(id); }
  removeSession(id: string) { this.allowedSessions?.delete(id); this.forget(`state:${id}`); }
  private enqueue(work: () => Promise<void>) { this.writes = this.writes.then(work).catch(() => {}); }
  settled() { return this.writes; }
  onClose(cleanup: () => void) { this.cleanups.add(cleanup); return () => { this.cleanups.delete(cleanup); }; }
  close() { this.alive = false; this.entries.clear(); this.versions.clear(); for (const cleanup of this.cleanups) cleanup(); this.cleanups.clear(); }
}

// The fence also invalidates requests still in flight in another tab. It contains no credentials.
const fenceKey = 'cardbush-cache-identity-v1';
let current: AccountCache | null = null, fence = '';
const disk = new IndexedCacheDisk();
function readFence() { try { return localStorage.getItem(fenceKey) ?? ''; } catch { return fence; } }
export function activateBrowserCache(owner: string | null) {
  if (current?.owner === owner && current.valid()) return current;
  current?.close(); current = null;
  let previous: { owner?: string; token?: string } = {};
  try { previous = JSON.parse(readFence()); } catch { /* First visit. */ }
  if (!owner || previous.owner !== owner) {
    fence = JSON.stringify({ owner, token: `${Date.now()}-${Math.random()}` });
    try { localStorage.setItem(fenceKey, fence); } catch { /* Memory-only fence. */ }
    void disk.clear().catch(() => {});
  } else fence = readFence();
  if (!owner) return null;
  const expected = fence;
  current = new AccountCache(owner, disk, () => readFence() === expected);
  return current;
}
