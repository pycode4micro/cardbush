import { createHash } from 'node:crypto';
import { searchLimitParameter, searchResultLimitSchema, type ModelRequest } from '@cardbush/bush-protocol';
import { z } from 'zod';
import { discoveryDescription } from './catalogPage.js';
import { MCP_SEARCH_CURSOR_LIMIT, MCP_SEARCH_QUERY_LIMIT } from './mcpToolSearch.js';
import { rankPluginText } from './pluginTextSearch.js';
import { resolveSearchResultLimit, type SearchResultLimitProvider } from './searchResultLimit.js';
import type { ToolAdmissionContext, ToolRegistry } from './toolRegistry.js';
import { fitToolResultPage } from './toolResultBudget.js';

const modeSchema = z.enum(['mcp', 'skill', 'plugins', 'all']);
const querySchema = z.string().trim().min(1).max(MCP_SEARCH_QUERY_LIMIT);
const serverSchema = z.string().trim().min(1).max(512);
const args = z.object({ query: querySchema.optional(), mode: modeSchema.optional(),
  server: serverSchema.optional(), limit: searchResultLimitSchema.optional(),
  cursor: z.string().min(1).max(MCP_SEARCH_CURSOR_LIMIT).optional() }).strict();
const cursorSchema = z.object({ query: querySchema, mode: modeSchema, server: serverSchema.optional(),
  offset: z.number().int().nonnegative(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type Page = z.infer<typeof cursorSchema>;
const prefix = 'plugin-search:1:';
function continuation(page: Page) { return prefix + Buffer.from(JSON.stringify(page)).toString('base64url'); }
function decode(input: unknown) {
  const { query, mode, server, limit, cursor } = args.parse(input);
  if (cursor) {
    if (query || mode || server) throw new Error('Continue with cursor only; optionally change limit.');
    if (!cursor.startsWith(prefix)) throw new Error('Invalid plugin search cursor.');
    const page = cursorSchema.parse(JSON.parse(Buffer.from(cursor.slice(prefix.length), 'base64url').toString('utf8')));
    if (!page.offset || (page.server && page.mode !== 'mcp')) throw new Error('Invalid plugin search cursor.');
    return { query: page.query, mode: page.mode, server: page.server, limit, page };
  }
  if (!query) throw new Error('Start a search with query. Use * to browse.');
  if (server && mode && mode !== 'mcp') throw new Error('A server filter requires mode=mcp.');
  return { query, mode: mode ?? (server ? 'mcp' : 'all'), server, limit, page: undefined };
}

type BaseCard = { name: string; description: string; descriptionTruncated?: boolean };
type SkillCard = BaseCard & { kind: 'skill'; mainResource: string; environment: 'local'; invocation?: string };
type McpCard = BaseCard & { kind: 'mcp'; server: string; tool: string; loaded: boolean };
export type PluginPackage = BaseCard & { displayName: string; source: 'bundled' | 'user'; keywords?: string;
  version: string; installed: boolean; enabled: boolean };
type PackageCard = Omit<PluginPackage, 'keywords'> & { kind: 'plugin' };
type Card = SkillCard | McpCard | PackageCard;
type Ranked<T> = { score: number; card: T };
export type PluginPackageSource = () => Promise<{ packages: PluginPackage[] }>;
type Server = { server: string; description: string };
export interface PluginSearchSources {
  skills?: (context: Pick<ToolAdmissionContext, 'turn'>, query: string) => Promise<Ranked<SkillCard>[]>;
  mcp?: (request: ModelRequest, query: string, server?: string, signal?: AbortSignal) => Promise<{ matches: Ranked<McpCard>[]; standby: Server[] }>;
  packages?: PluginPackageSource;
  loadSearchResultLimit?: SearchResultLimitProvider;
}

const sourcesByRegistry = new WeakMap<ToolRegistry, PluginSearchSources>();
type Result = { query: string; mode: Page['mode']; total: number; matches: Card[]; available_servers?: Server[];
  unavailable_modes?: string[]; _page: Page };
function present({ _page, ...result }: Result, count: number) {
  const next = _page.offset + count, more = next < result.total;
  return { ...result, ...(_page.server ? { server: _page.server } : {}), matches: result.matches.slice(0, count), more,
    ...(more ? { next_cursor: continuation({ ..._page, offset: next }) } : {}) };
}
function scopeAllows(request: ModelRequest, mode: 'skill' | 'mcp' | 'plugins') {
  const meta = request.metadata;
  if (meta.toolExecutionPolicy === 'none' || (meta.toolExecutionPolicy === 'web_restricted' && mode !== 'skill')) return false;
  if (Array.isArray(meta.pluginSearchModes) && !meta.pluginSearchModes.includes(mode)) return false;
  const old = mode === 'skill' ? 'search_skills' : mode === 'mcp' ? 'mcp_search' : undefined;
  return !(old && [meta.disabledTools, meta.pluginCommandDisallowedTools].some(list => Array.isArray(list) &&
    (list.includes(old) || (mode === 'skill' && list.includes('Skill')))));
}

/** Each host supplies only its own catalogs; never route a search to another host. */
export function configurePluginSearch(registry: ToolRegistry, options: PluginSearchSources) {
  const existing = sourcesByRegistry.get(registry);
  const sources = existing ?? {};
  for (const [key, value] of Object.entries(options)) if (value !== undefined) Object.assign(sources, { [key]: value });
  if (existing) return;
  sourcesByRegistry.set(registry, sources);
  registry.register({
    directInvocation: true, parallelSafe: true,
    definition: { name: 'search_plugins',
      description: "Discover plugins by capability or name. Default all searches MCP tools, installed Skills and plugin packages together; choose mcp, skill or plugins to narrow. Use * to browse. For a Skill, read mainResource with read_file in environment=local on this Runtime host, even in an SSH workspace. Inspect references/ and read relevant documents even if unlinked; run_skill accepts its invocation ID. MCP matches are summaries, not schemas. For MCP, get_tool_schema loads an exact name before call_tool. In mcp mode, pass an available_servers ID as server to load that server on demand. Package matches cover bundled and user-installed packages on this host, including disabled packages. Continue with next_cursor as cursor alone. Searching grants no execution permission.",
      inputSchema: { ...z.toJSONSchema(args), properties: { ...z.toJSONSchema(args).properties, limit: { ...searchLimitParameter } } } },
    manifest: { effect_kind: 'observation', operation: 'plugins.search', risk: 'low', owner: 'runtime', dispatch_scope: 'parent_session', mutating: false },
    decodeInput: decode,
    projectModelPage: (value, budget) => {
      const result = value as Result;
      const matches = result.matches.map(card => {
        if (card.kind !== 'mcp') return card;
        const { server, tool, ...summary } = card;
        return summary;
      });
      return fitToolResultPage(matches.length, budget, count =>
        JSON.stringify({ ...present(result, count), matches: matches.slice(0, count) }));
    },
    execute: async context => {
      if (!context.turn) throw new Error('Plugin discovery requires a task.');
      const { request } = context.turn, { query, mode, page, server } = context.input;
      const limit = await resolveSearchResultLimit(context.input.limit, sources.loadSearchResultLimit);
      const selected = (kind: 'mcp' | 'skill' | 'plugins') => (mode === 'all' || mode === kind) && scopeAllows(request, kind);
      const ranked: Ranked<Card>[] = [], unavailable: string[] = [];
      let standby: Server[] = [];
      const jobs: { mode: string; run: () => Promise<void> }[] = [];
      if (selected('skill') && sources.skills) jobs.push({ mode: 'skill', run: async () => {
        ranked.push(...await sources.skills!(context, query));
      } });
      if (selected('plugins') && sources.packages) jobs.push({ mode: 'plugins', run: async () => {
        const inventory = await sources.packages!();
        const rank = rankPluginText(query);
        for (const { keywords, ...plugin } of inventory.packages) {
          const score = rank(plugin.name, [plugin.displayName, plugin.description, keywords].filter(Boolean).join(' '));
          if (score > 0) ranked.push({ score, card: { ...plugin, kind: 'plugin', description: discoveryDescription(plugin.description) } });
        }
      } });
      if (selected('mcp') && sources.mcp) jobs.push({ mode: 'mcp', run: async () => {
        const result = await sources.mcp!(request, query, server, context.signal);
        standby = result.standby;
        ranked.push(...result.matches);
      } });
      const outcomes = await Promise.allSettled(jobs.map(job => job.run()));
      context.signal?.throwIfAborted();
      outcomes.forEach((outcome, i) => {
        if (outcome.status === 'rejected') {
          if (mode !== 'all') throw outcome.reason;
          unavailable.push(jobs[i]!.mode);
        }
      });
      ranked.sort((a, b) => b.score - a.score || a.card.name.localeCompare(b.card.name) ||
        a.card.kind.localeCompare(b.card.kind) || (a.card.kind === 'plugin' && b.card.kind === 'plugin' ? a.card.source.localeCompare(b.card.source) : 0));
      // Loading a schema between pages does not change catalog membership or ranking.
      const fingerprint = createHash('sha256').update(JSON.stringify([request.sessionId, mode, query, server,
        unavailable, ranked.map(({ card }) => card.kind === 'mcp' ? { ...card, loaded: undefined } : card)])).digest('hex');
      if (page && (page.fingerprint !== fingerprint || page.offset >= ranked.length)) throw Object.assign(
        new Error('Plugin search results changed or belong to another conversation. Restart with query.'), { code: 'plugin_search_cursor_stale' });
      const offset = page?.offset ?? 0;
      const result: Result = { query, mode, matches: ranked.slice(offset, offset + limit).map(item => item.card), total: ranked.length,
        ...(standby.length && !server ? { available_servers: standby } : {}), ...(unavailable.length ? { unavailable_modes: unavailable } : {}),
        _page: { query, mode, ...(server ? { server } : {}), offset, fingerprint } };
      return { ...present(result, result.matches.length), _page: result._page };
    },
  });
}
