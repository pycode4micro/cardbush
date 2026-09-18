import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, open, readdir, unlink } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

/** Owners describe their disposable data; this collector never guesses directories. */
export interface CacheEntry {
  category: string;
  keys: string[];
  owner?: string;
  bytes: number;
  file?: string;
  scan(visit: (text: string) => void, signal?: AbortSignal): Promise<void>;
  remove(): Promise<void>;
}
export interface CacheMaintenanceResult {
  counts: Record<string, number>;
  errors: string[];
}
export const sessionCacheKey = (id: string) => createHash('sha256').update(id).digest('hex');
export const sessionCacheKeys = (id: string) => [id, sessionCacheKey(id), sessionCacheKey(JSON.stringify([id, 'context']))];

/** Flat, owned directories only. Never follow a directory or file symlink. */
export async function cacheFiles(root: string, accept: (name: string) => boolean) {
  root = resolve(root);
  const info = await lstat(root).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!info) return [];
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Cache root is not an owned directory: ${root}`);
  const files = [];
  for (const item of await readdir(root, { withFileTypes: true })) {
    if (!item.isFile() || !accept(item.name)) continue;
    const path = join(root, item.name), stat = await lstat(path);
    if (stat.isFile() && !stat.isSymbolicLink()) files.push({ path, bytes: stat.size, mtimeMs: stat.mtimeMs });
  }
  return files;
}

export function fileCacheEntry(file: { path: string; bytes: number }, category: string, keys: string[], owner?: string, beforeRemove?: () => void): CacheEntry {
  return { category, keys, owner, bytes: file.bytes, file: file.path,
    async scan(visit, signal) {
      // Bounded reads; a large execution journal must never be loaded just to clean it.
      for await (const chunk of createReadStream(file.path, { encoding: 'utf8', highWaterMark: 64 * 1024, signal })) visit(chunk);
    },
    async remove() {
      const stat = await lstat(file.path).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (!stat) return;
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Cache file changed type: ${file.path}`);
      beforeRemove?.();
      await unlink(file.path);
    },
  };
}

export function memoryCacheEntry(category: string, owner: string, rows: unknown[], remove: () => void): CacheEntry {
  return { category, owner, keys: [owner], bytes: 0,
    async scan(visit, signal) { for (const row of rows) { signal?.throwIfAborted(); visit(JSON.stringify(row)); } },
    async remove() { remove(); },
  };
}

async function firstRecord(path: string) {
  const file = await open(path, 'r');
  try {
    let text = '';
    const buffer = Buffer.alloc(64 * 1024);
    for (let position = 0; position < 4 * 1024 * 1024;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      const end = buffer.subarray(0, bytesRead).indexOf(10);
      // Decode only after joining bytes so multibyte characters cannot corrupt the checksum.
      if (end >= 0) {
        const full = Buffer.alloc(position - bytesRead + end);
        await file.read(full, 0, full.length, 0);
        return JSON.parse(full.toString('utf8'));
      }
      text = 'nonempty';
    }
    if (!text) return undefined;
    throw new Error(`Cache journal identity is incomplete or too large: ${path}`);
  } finally { await file.close(); }
}

export async function journalCacheEntries(root: string, category: string, protocol: string, field: 'event' | 'record', ownerField: 'sessionId' | 'parentSessionId', close: (path: string) => void, perTurn = false): Promise<CacheEntry[]> {
  const result: CacheEntry[] = [];
  for (const file of await cacheFiles(root, name => /^[a-f0-9]{64}\.jsonl$/.test(name))) {
    const row = await firstRecord(file.path);
    if (!row) { result.push(fileCacheEntry(file, category, [], undefined, () => close(file.path))); continue; }
    const record = row[field], owner = record?.[ownerField];
    const identity = perTurn ? JSON.stringify([owner, record?.turnId]) : owner;
    if (row.protocol !== protocol || typeof owner !== 'string' || !owner ||
        row.checksum !== createHash('sha256').update(JSON.stringify(record)).digest('hex') ||
        basename(file.path) !== `${sessionCacheKey(identity)}.jsonl`) {
      throw new Error(`Cannot safely identify cache journal: ${file.path}`);
    }
    result.push(fileCacheEntry(file, category, [owner], owner, () => close(file.path)));
  }
  return result;
}

export async function blobCacheEntries(root: string, category: string, accept: (name: string) => boolean, graceMs = 0): Promise<CacheEntry[]> {
  const before = Date.now() - graceMs;
  return (await cacheFiles(root, accept)).filter(file => graceMs <= 0 || file.mtimeMs <= before).map(file => {
    const entry = fileCacheEntry(file, category, [basename(file.path), basename(file.path).split('.')[0]!]);
    if (!file.path.endsWith('.json')) entry.scan = async () => {};
    return entry;
  });
}

export function temporaryCacheEntries(root: string) {
  return blobCacheEntries(root, 'temporary_files', name => /^(?:[a-f0-9]{64}(?:\.json)?\.)?[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.tmp$/.test(name), 24 * 60 * 60_000);
}

/** Mark all references first, then sweep. Failure to read any retained source aborts the sweep. */
export async function collectUnreferencedCache(entries: CacheEntry[], roots: unknown[], locators: Array<{ number: number; sessionId: string }> = [], signal?: AbortSignal): Promise<CacheMaintenanceResult> {
  signal?.throwIfAborted();
  const byKey = new Map<string, Set<CacheEntry>>();
  const add = (key: string, entry: CacheEntry) => { let values = byKey.get(key); if (!values) byKey.set(key, values = new Set()); values.add(entry); };
  for (const entry of entries) {
    for (const key of entry.keys) add(key, entry);
    if (entry.owner) add(sessionCacheKey(entry.owner), entry);
  }
  for (const locator of locators) for (const entry of byKey.get(locator.sessionId) ?? []) add(`cardbush-memo:${locator.number}`, entry);
  const keys = [...byKey.keys()];
  const width = keys.reduce((max, key) => Math.max(max, key.length), 1);
  const retained = new Set<CacheEntry>(), pending: CacheEntry[] = [];
  const mark = (key: string) => { for (const entry of byKey.get(key) ?? []) if (!retained.has(entry)) { retained.add(entry); pending.push(entry); if (entry.owner) for (const alias of sessionCacheKeys(entry.owner)) mark(alias); } };
  // Longest alternatives first avoid matching memo 1 inside memo 12.
  const pattern = keys.length ? new RegExp(keys.sort((a, b) => b.length - a.length).map(key => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : undefined;
  const scan = () => {
    let carry = '';
    return (text: string) => {
      const chunk = carry + text;
      if (pattern) { pattern.lastIndex = 0; for (const match of chunk.matchAll(pattern)) mark(match[0]); }
      carry = chunk.slice(-width);
    };
  };
  const visit = scan();
  for (const root of roots) { signal?.throwIfAborted(); visit(JSON.stringify(root)); }
  while (pending.length) {
    signal?.throwIfAborted();
    await pending.pop()!.scan(scan(), signal);
  }
  const result: CacheMaintenanceResult = { counts: { files: 0, bytes: 0 }, errors: [] };
  for (const entry of entries) {
    signal?.throwIfAborted();
    if (retained.has(entry)) continue;
    try {
      await entry.remove();
      if (entry.file) result.counts.files!++;
      result.counts.bytes! += entry.bytes;
      result.counts[entry.category] = (result.counts[entry.category] ?? 0) + (entry.file ? 1 : 0);
    } catch (error) { result.errors.push(`${entry.category}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return result;
}
