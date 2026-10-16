import { z } from 'zod';
import { WebError, type WebConversation } from './webCommon.mjs';
import type { SessionSnapshot } from '@cardbush/bush-protocol';

export const conversationPageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(60).default(30),
  archived: z.enum(['true', 'false']).default('false').transform(value => value === 'true'),
  q: z.string().trim().max(120).default(''), cursor: z.string().max(2048).optional(),
});
export type ConversationPageQuery = z.infer<typeof conversationPageQuery>;
export type ConversationPage = { items: WebConversation[]; nextCursor: string | null };
const cursorSchema = z.object({ pinned: z.boolean(), updatedAt: z.string().min(1).max(60), id: z.string().max(64), archived: z.boolean(), q: z.string().max(120) });
export function conversationCursor(query: ConversationPageQuery) {
  if (!query.cursor) return null;
  try {
    const value = cursorSchema.parse(JSON.parse(Buffer.from(query.cursor, 'base64url').toString()));
    if (value.archived !== query.archived || value.q !== query.q) throw new Error('Different filter');
    return value;
  } catch { throw new WebError(400, '会话列表已变化，请重新查询。'); }
}
export function nextConversationCursor(row: WebConversation, exactTimestamp: string, query: ConversationPageQuery) {
  return Buffer.from(JSON.stringify({ pinned: row.pinned, updatedAt: exactTimestamp, id: row.id, archived: query.archived, q: query.q })).toString('base64url');
}
export function historyPage(snapshot: SessionSnapshot | null, limit: number, before?: string | null) {
  const turns = snapshot?.turns ?? [];
  const end = before ? turns.findIndex(turn => turn.turnId === before) : turns.length;
  if (end < 0) throw new WebError(409, '历史记录已变化，请重新打开会话。');
  const start = Math.max(0, end - limit), page = turns.slice(start, end);
  return { snapshot: snapshot ? { ...snapshot, turns: page } : null,
    history: { nextCursor: start > 0 ? page[0].turnId : null } };
}

/** Gateway-only cache: never shared across account keys, bounded by bytes and concurrent reads.
 * The deployed runtime still exposes full snapshots; page them here without migrating tenant runtimes. */
export class WebReadCache {
  private entries = new Map<string, { value?: unknown; pending?: Promise<unknown>; until: number; bytes: number }>();
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private now = () => Date.now(), private budget = 24 * 1024 * 1024) {}
  invalidate(prefix: string) { for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key); }
  private async run<T>(load: () => Promise<T>) {
    if (this.active >= 4) {
      if (this.waiting.length >= 128) throw new WebError(429, '正在加载的会话较多，请稍后重试。');
      await new Promise<void>(resolve => this.waiting.push(resolve));
    } else this.active++;
    try { return await load(); }
    finally { const next = this.waiting.shift(); if (next) next(); else this.active--; }
  }
  async get<T>(key: string, ttl: number, load: () => Promise<T>): Promise<T> {
    const previous = this.entries.get(key);
    if (previous?.pending) return previous.pending as Promise<T>;
    if (previous && previous.until > this.now()) { this.entries.delete(key); this.entries.set(key, previous); return previous.value as T; }
    const entry = { until: 0, bytes: 0 } as { value?: T; pending?: Promise<T>; until: number; bytes: number };
    this.entries.set(key, entry);
    const pending = this.run(load).then(value => {
      if (this.entries.get(key) !== entry) return value;
      entry.value = value; entry.bytes = Buffer.byteLength(JSON.stringify(value) ?? 'null'); entry.until = this.now() + ttl;
      let total = [...this.entries.values()].reduce((sum, item) => sum + item.bytes, 0);
      for (const [id, item] of this.entries) {
        if (item.pending && id !== key) continue;
        if (item.until <= this.now() || total > this.budget || this.entries.size > 256) { this.entries.delete(id); total -= item.bytes; }
      }
      return value;
    }).catch(error => { if (this.entries.get(key) === entry) this.entries.delete(key); throw error; })
      .finally(() => { delete entry.pending; });
    entry.pending = pending; return pending;
  }
}
