import { fitToolResultPage } from './toolResultBudget.js';

/** Discovery receipts are bounded summaries; callers keep full records for explicit reads. */
export interface CatalogQuery { query?: string; offset?: number; limit?: number }
export const catalogPageProperties = {
  query: { type: 'string', minLength: 1, maxLength: 200, description: 'Case-insensitive text filter. Retain the same query when paging.' },
  offset: { type: 'integer', minimum: 0, description: 'next_offset from the preceding page.' },
  limit: { type: 'integer', minimum: 1, maximum: 50, default: 20, description: 'Maximum entries. The output budget may return fewer; continue using next_offset.' },
};
export function decodeCatalogQuery(input: Record<string, unknown>): CatalogQuery {
  if (input.query !== undefined && (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 200)) throw new Error('query must contain 1 to 200 characters.');
  if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || Number(input.offset) < 0)) throw new Error('offset must be a nonnegative integer.');
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 50)) throw new Error('limit must be an integer from 1 to 50.');
  return { query: (input.query as string | undefined)?.trim(), offset: input.offset as number | undefined, limit: input.limit as number | undefined };
}
export function briefText(text: string, maximum = 320) {
  if (text.length <= maximum) return text;
  const end = maximum - 1;
  return text.slice(0, /[\uD800-\uDBFF]/.test(text[end - 1] ?? '') ? end - 1 : end) + '…';
}
/** Compact discovery text only; search ranking continues to use the full text. */
export function discoveryDescription(text: string) { return briefText(text.replace(/\s+/g, ' ').trim(), 180); }

/** Final delivery pagination, after the Runtime has shared its ingress budget.
 * Collections must follow the same order as the native page. No offset means an
 * explicit detail read, which must never be silently converted into a list. */
export function projectCatalogPage(value: unknown, maxChars: number, collections: string[], totalKey = 'total',
  mapPage: (page: Record<string, unknown>) => Record<string, unknown> = page => page): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = value as Record<string, unknown>, offset = result.offset, total = result[totalKey];
  if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(total) || Number(total) < 0) return undefined;
  const keys = collections.filter(key => Array.isArray(result[key]));
  if (!keys.length) return undefined;
  const entries = keys.flatMap(key => (result[key] as unknown[]).map(item => ({ key, item })));
  return fitToolResultPage(entries.length, maxChars, count => {
    const selected = entries.slice(0, count);
    const next = Number(offset) + count;
    return JSON.stringify(mapPage({ ...result, ...Object.fromEntries(keys.map(key => [key, selected.filter(entry => entry.key === key).map(entry => entry.item)])),
      next_offset: next < Number(total) ? next : null }));
  });
}
export function catalogPage<T>(source: T[], query: CatalogQuery = {}, searchable: (item: T) => string = item => JSON.stringify(item)) {
  const needle = query.query?.toLowerCase();
  const matches = needle ? source.filter(item => searchable(item).toLowerCase().includes(needle)) : source;
  const offset = query.offset ?? 0, limit = query.limit ?? 20;
  const items: T[] = []; let chars = 0;
  for (const item of matches.slice(offset, offset + limit)) {
    const size = JSON.stringify(item).length + 1;
    if (items.length && chars + size > 6000) break;
    items.push(item); chars += size;
  }
  const next = offset + items.length;
  return { items, total: matches.length, offset, next_offset: next < matches.length ? next : null };
}
