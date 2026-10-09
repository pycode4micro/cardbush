import { createHash } from 'node:crypto';
import type { ToolDefinition } from '@cardbush/bush-protocol';

export type McpSearchEntry = { definition: ToolDefinition; server: string; tool: string };
export type McpSearchCursor = { query: string; server?: string; offset: number; fingerprint: string };
export const MCP_SEARCH_QUERY_LIMIT = 2048;
export const MCP_SEARCH_CURSOR_LIMIT = 16_384;

const stopWords = new Set('a an the and or of for to in on at by with from as is are was were be been being this that these those it its i me my you your we our can could would should please do does did how what which who where when'.split(' '));
const segmenter = new Intl.Segmenter('en', { granularity: 'word' });
const normalize = (text: string) => text.normalize('NFKC').toLowerCase();
function words(text: string, identifier = false): Set<string> {
  // Split camelCase identifiers, not format names such as WebP in prose.
  const input = normalize((identifier ? text.replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z][a-z]|[A-Z]{2,})/g, '$1 $2') : text).replace(/[_-]+/g, ' '));
  return new Set([...segmenter.segment(input)].filter(part => part.isWordLike).map(part => part.segment));
}

/** Whole words prevent web/webp and read/thread false positives. Coverage comes
 * before field weights; exact tool identities always win over prose mentions. */
export function rankMcpTools(entries: McpSearchEntry[], query: string) {
  const normalized = normalize(query);
  const terms = [...words(query)].filter(term => !stopWords.has(term));
  return entries.flatMap(entry => {
    const exact = [entry.definition.name, entry.tool].some(name => normalize(name) === normalized);
    if (exact) return [{ ...entry, score: Number.MAX_SAFE_INTEGER }];
    if (query === '*') return [{ ...entry, score: 0 }];
    if (!terms.length) return [];
    const name = words(entry.tool, true), server = words(entry.server, true), description = words(entry.definition.description);
    let coverage = 0, weight = 0;
    for (const term of terms) {
      const fieldWeight = name.has(term) ? 8 : server.has(term) ? 4 : description.has(term) ? 1 : 0;
      if (fieldWeight) { coverage++; weight += fieldWeight; }
    }
    return coverage ? [{ ...entry, score: coverage + weight / (terms.length * 10) }] : [];
  }).sort((a, b) => b.score - a.score || a.definition.name.localeCompare(b.definition.name));
}

/** The cursor carries the original query and binds the ordered search catalog
 * to its conversation. It grants no visibility or execution permission. */
export function mcpSearchFingerprint(sessionId: string, query: string, server: string | undefined, entries: McpSearchEntry[]) {
  return createHash('sha256').update(JSON.stringify([sessionId, query, server,
    entries.map(entry => [entry.definition.name, entry.definition.description, entry.server, entry.tool])])).digest('hex');
}
export function writeMcpSearchCursor(cursor: McpSearchCursor): string {
  return 'mcp-search:1:' + Buffer.from(JSON.stringify(cursor)).toString('base64url');
}
export function readMcpSearchCursor(value: unknown): McpSearchCursor {
  if (typeof value !== 'string' || value.length > MCP_SEARCH_CURSOR_LIMIT || !/^mcp-search:1:[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error('Invalid MCP search cursor. Start a new search with query.');
  }
  let data;
  try { data = JSON.parse(Buffer.from(value.slice('mcp-search:1:'.length), 'base64url').toString('utf8')); } catch {}
  if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.query !== 'string' ||
    !data.query.trim() || data.query.length > MCP_SEARCH_QUERY_LIMIT ||
    (data.server !== undefined && (typeof data.server !== 'string' || data.server.length > 512)) ||
    !Number.isSafeInteger(data.offset) || data.offset <= 0 || !/^[a-f0-9]{64}$/.test(data.fingerprint ?? '')) {
    throw new Error('Invalid MCP search cursor. Start a new search with query.');
  }
  return { query: data.query, ...(data.server !== undefined ? { server: data.server } : {}), offset: data.offset, fingerprint: data.fingerprint };
}
