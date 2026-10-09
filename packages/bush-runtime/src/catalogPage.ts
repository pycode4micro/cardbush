/** Discovery receipts are bounded summaries; callers keep full records for explicit reads. */
export interface CatalogQuery { query?: string; offset?: number; limit?: number }
export const catalogPageProperties = {
  query: { type: 'string', minLength: 1, maxLength: 200, description: 'Case-insensitive text filter. Retain the same query when paging.' },
  offset: { type: 'integer', minimum: 0, description: 'next_offset from the preceding page.' },
  limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
};
export function decodeCatalogQuery(input: Record<string, unknown>): CatalogQuery {
  if (input.query !== undefined && (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 200)) throw new Error('query must contain 1 to 200 characters.');
  if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || Number(input.offset) < 0)) throw new Error('offset must be a nonnegative integer.');
  if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 50)) throw new Error('limit must be an integer from 1 to 50.');
  return { query: (input.query as string | undefined)?.trim(), offset: input.offset as number | undefined, limit: input.limit as number | undefined };
}
export function briefText(text: string, maximum = 320) { return text.length > maximum ? text.slice(0, maximum - 1) + '…' : text; }
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
