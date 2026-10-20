import { toolSchemaReceipts } from './toolSchemaReceipts.js';
import { createHash } from 'node:crypto';
import { withToolDisplayTitle } from './toolDisplay.js';
import { projectBuiltinDefinitions, synchronizeBuiltinSchemas } from './builtinToolDisclosure.js';
import { repairLegacyToolScriptSchema } from './toolScriptSchema.js';
import { searchLimitParameter, searchResultLimitSchema, toolDefinitionSchema, type ModelMessage, type ModelRequest, type ToolDefinition } from '@cardbush/bush-protocol';
import type { ToolHandlerContext, ToolRegistry } from './toolRegistry.js';
import { MCP_HOST_CAPABILITIES } from './mcpHostCapabilities.js';
import { resolveToolReferenceName, unknownToolReferenceError, wrongToolRouteError } from './toolReferenceNames.js';
import { withToolFailureFacts } from './toolFailureFacts.js';
import { DEFAULT_TOOL_RESULT_MAX_CHARS, fitToolResultPage } from './toolResultBudget.js';
import { discoveryDescription } from './catalogPage.js';
import { resolveSearchResultLimit, type SearchResultLimitProvider } from './searchResultLimit.js';
import { MCP_SEARCH_CURSOR_LIMIT, MCP_SEARCH_QUERY_LIMIT, mcpSearchFingerprint, rankMcpTools, readMcpSearchCursor, writeMcpSearchCursor, type McpSearchCursor } from './mcpToolSearch.js';

export const MCP_DISCOVERY_PROTOCOL = 'bush.mcp_discovery.v1';
export function mcpToolInvocation(request: ModelRequest, name = 'Use the exact name from matches.') {
  if (request.tools.some(tool => tool.name === 'mcp_call')) return {
    tool: 'mcp_call', arguments: { name, arguments: 'Use the loaded inputSchema fields here.' },
    note: 'Call mcp_call directly. Do not wrap it in call_tool or invoke MCP targets through call_tool. Loading and invoking are sequential.',
  };
  return request.metadata.mcpToolDiscovery
    ? { tool: null, note: 'mcp_call is not exposed in this scope. Use an available execution interface; schema loading does not add a gateway or grant access.' }
    : { tool: name, arguments: 'Use the loaded inputSchema fields directly.' };
}

/** Keep the index visible and only emit complete definitions. The native result
 * stays in the execution journal; this is its bounded model presentation. */
export function projectMcpDiscoveryResult(text: string, maxChars = DEFAULT_TOOL_RESULT_MAX_CHARS): string | undefined {
  let result: any;
  try { result = JSON.parse(text); } catch { return undefined; }
  if (result?.protocol !== MCP_DISCOVERY_PROTOCOL || !Array.isArray(result.matches)) return undefined;
  // Search receipts stay compact; explicit loads contain complete definitions.
  // Search pages use their actual delivery budget; explicit oversized schemas
  // still use the ordinary immutable result archive.
  if (result.action === 'search' || result.action === 'load') {
    const { next_step: _next, ...receipt } = result;
    if (result.action === 'search') {
      if (result.matches.some((match: any) => !match || typeof match.name !== 'string' || typeof match.description !== 'string')) return undefined;
      delete receipt.protocol; delete receipt.sessionId; delete receipt._searchPage;
      receipt.matches = result.matches.map(({ name, description, descriptionTruncated, loaded }: any) => {
        const summary = discoveryDescription(description);
        return { name, description: summary, ...(descriptionTruncated || summary !== description ? { descriptionTruncated: true } : {}), loaded };
      });
      // Keep the native page start even on the last page: delivery can shorten
      // that page too. A continuation is always based on entries actually seen.
      let seed: McpSearchCursor | undefined = result._searchPage;
      if (!seed && typeof result.next_cursor === 'string') {
        try { const next = readMcpSearchCursor(result.next_cursor); seed = { ...next, offset: next.offset - result.matches.length }; } catch { /* Old/invalid receipts retain archive fallback. */ }
      }
      if (seed && Number.isSafeInteger(seed.offset) && seed.offset >= 0 && Number.isSafeInteger(result.total) &&
          result.total >= seed.offset + result.matches.length && typeof seed.query === 'string' && /^[a-f0-9]{64}$/.test(seed.fingerprint)) {
        const page = seed;
        return fitToolResultPage(receipt.matches.length, maxChars, count => {
          const next = page.offset + count, more = next < result.total;
          const { next_cursor: _cursor, ...overview } = receipt;
          return JSON.stringify({ ...overview, ...(page.server ? { server: page.server } : {}),
            matches: receipt.matches.slice(0, count), more,
            ...(more ? { next_cursor: writeMcpSearchCursor({ ...page, offset: next }) } : {}) });
        });
      }
    }
    const compact = JSON.stringify(receipt);
    if (compact.length <= maxChars) return compact;
    if (result.action !== 'load' || result.matches.length < 2) return undefined;
    // Only delivery knows the real budget, including competition from sibling
    // calls. Keep complete schemas; deferred names never become callable.
    const included = new Set<string>();
    const render = () => JSON.stringify({ ...receipt,
      matches: result.matches.filter((match: any) => included.has(match.name)),
      deferred: [...new Set([...(result.deferred ?? []), ...result.matches
        .filter((match: any) => !included.has(match.name)).map((match: any) => match.name)])] });
    for (const match of result.matches) {
      included.add(match.name);
      if (render().length > maxChars) included.delete(match.name);
    }
    return included.size ? render() : undefined;
  }
  return undefined;
}
type LoadedTools = Map<string, string>;
const selected = new WeakMap<ToolRegistry, Map<string, LoadedTools>>();
const key = (request: ModelRequest) => JSON.stringify([request.sessionId, request.turnId]);
function selections(registry: ToolRegistry) {
  let value = selected.get(registry);
  if (!value) { value = new Map(); selected.set(registry, value); }
  return value;
}
// Object key order is not a schema revision; array order remains significant.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, item]) => JSON.stringify(name) + ':' + canonical(item)).join(',') + '}';
  return JSON.stringify(value) ?? 'null';
}
function revision(registry: ToolRegistry, definition: ToolDefinition): string {
  const registration = registry.resolve(definition.name)!;
  return createHash('sha256').update(canonical({ definition, server: registration.mcpHook!.server,
    tool: registration.mcpHook!.tool, scope: registration.sessionScope ?? null })).digest('hex');
}
function available(registry: ToolRegistry, request: ModelRequest, name: string, visible?: Set<string>): ToolDefinition | undefined {
  const registration = registry.resolve(name);
  if (!registration?.mcpHook || registration.mcpHook.modelVisible === false ||
    (registration.sessionScope && registration.sessionScope !== request.sessionId) ||
    !(visible ? visible.has(name) : request.tools.some(tool => tool.name === name))) return undefined;
  return registration.definition;
}
function remember(registry: ToolRegistry, request: ModelRequest, loaded: LoadedTools) {
  selections(registry).set(key(request), loaded);
  // Checkpoint receipts belong to one turn; new turns rebuild from visible history.
  request.metadata.mcpDiscoveredToolVersions = { identity: key(request), tools: Object.fromEntries(loaded) };
}
function loadedTools(registry: ToolRegistry, request: ModelRequest): LoadedTools {
  const cached = selections(registry).get(key(request));
  if (cached) return cached;
  const receipt = request.metadata.mcpDiscoveredToolVersions as { identity?: string; tools?: Record<string, unknown> } | undefined;
  return receipt?.identity === key(request) && receipt.tools && typeof receipt.tools === 'object'
    ? new Map(Object.entries(receipt.tools).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : new Map();
}
export function mcpToolWasDiscovered(registry: ToolRegistry, request: ModelRequest, name: string): boolean {
  if (!request.metadata.mcpToolDiscovery || !registry.resolve(name)?.mcpHook) return true;
  const definition = available(registry, request, name);
  return !!definition && loadedTools(registry, request).get(name) === revision(registry, definition);
}
export function clearMcpDiscovery(registry: ToolRegistry, request: ModelRequest) { selections(registry).delete(key(request)); }

/** A recoverable schema prerequisite, derived from the existing discovery state. */
export function mcpSchemaRequiredError(name: string) {
  return withToolFailureFacts(Object.assign(new Error('This MCP tool is available, but its current schema is not loaded in the model context. Call mcp_search with the action and exact query in details.load, wait for and read the returned schema, then retry the tool (using mcp_call when available). Do not run the dependent call in parallel with loading. The tool has not executed; this does not indicate a service connection failure.'), {
    code: 'mcp_discovery_required',
    details: { toolName: name, load: { name: 'mcp_search', arguments: { action: 'load', query: name } } },
  }), { effects: 'none', result: 'known' });
}

/** Shared preflight only; execution still re-enters the normal coordinator for every call. */
export function mcpInvocationTarget(registry: ToolRegistry, turn: ToolHandlerContext['turn'], reference: string, readOnly = false) {
  const name = resolveToolReferenceName(reference, turn), registration = registry.resolve(name);
  if (!registration) throw unknownToolReferenceError(reference, 'mcp');
  if (!turn || !turn.request.tools.some(tool => tool.name === name) || registration.mcpHook?.modelVisible === false ||
    registration.sessionScope && registration.sessionScope !== turn.request.sessionId) {
    throw withToolFailureFacts(Object.assign(new Error('This MCP tool is not available to this turn. Use mcp_search to check the current catalog; loading a schema cannot restore an unavailable tool.'), { code: 'tool_not_exposed' }), { effects: 'none', result: 'known' });
  }
  if (!registration.mcpHook) throw wrongToolRouteError(name, 'native');
  if (readOnly && !registration.mcpHook.readOnly) throw withToolFailureFacts(Object.assign(
    new Error('Only MCP tools declared read-only can run through start_mcp_tool. Use mcp_call for this tool after loading its schema; its normal permissions still apply. No tool was executed.'),
    { code: 'mcp_background_read_only_required', details: { toolName: name, invoke: 'mcp_call' } },
  ), { effects: 'none', result: 'known' });
  if (!mcpToolWasDiscovered(registry, { ...turn.request, metadata: { ...turn.request.metadata, mcpToolDiscovery: true } }, name)) throw mcpSchemaRequiredError(name);
  return { name, registration };
}

/** Rebuild from the exact model context after restart or compaction, without rewriting history.
 * A summary, compact reference or archived preview cannot substitute for a full loaded schema.
 */
export function* mcpDiscoveryResults(messages: ModelMessage[], sessionId: string) {
  yield* toolSchemaReceipts(messages, sessionId, 'mcp_search', MCP_DISCOVERY_PROTOCOL);
}

export function synchronizeMcpDiscovery(registry: ToolRegistry, request: ModelRequest, messages: ModelMessage[]): void {
  synchronizeBuiltinSchemas(registry, request, messages);
  if (!request.metadata.mcpToolDiscovery) return;
  const loaded: LoadedTools = new Map();
  const visible = new Set(request.tools.map(tool => tool.name));
  for (const { output } of mcpDiscoveryResults(messages, request.sessionId)) {
    for (const value of output.matches) {
      const match = value as any;
      if (!match || typeof match.name !== 'string' || typeof match.revision !== 'string') continue;
      const current = available(registry, request, match.name, visible);
      if (!current || revision(registry, current) !== match.revision) continue;
      const definition = toolDefinitionSchema.safeParse(match);
      if (definition.success && revision(registry, definition.data) === match.revision) loaded.set(match.name, match.revision);
    }
  }
  remember(registry, request, loaded);
}

type CatalogState = { identity: string; tools: Record<string, string>; extensions: string[] };
function catalogState(value: unknown, identity: string): CatalogState | undefined {
  const state = value as Partial<CatalogState> | undefined;
  if (state?.identity !== identity || !state.tools || typeof state.tools !== 'object' || Array.isArray(state.tools) ||
    Object.values(state.tools).some(revision => typeof revision !== 'string') ||
    !Array.isArray(state.extensions) || state.extensions.some(name => typeof name !== 'string')) return;
  return state as CatalogState;
}

/** Synchronize optional plugin capabilities only between model requests. */
export function synchronizeMcpCatalog(registry: ToolRegistry, request: ModelRequest): ModelMessage | undefined {
  if (!request.metadata.mcpToolDiscovery || request.metadata.toolExecutionPolicy === 'none') return;
  // Only ordinary product conversations admit newly installed tools. Scoped
  // agents can refresh/revoke existing definitions without gaining capabilities.
  const allowAdditions = request.metadata.mcpCatalogUpdates === 'additions' &&
    request.metadata.agentRole !== 'child' && !request.metadata.pluginAgentId && !request.metadata.automationRunId;
  const visible = new Set(request.tools.map(tool => tool.name));
  const advertised = new Set(registry.definitions().map(tool => tool.name));
  const current = registry.definitions({ includeSuperseded: true }).filter(definition => {
    if (!allowAdditions && !visible.has(definition.name)) return false;
    const registration = registry.resolve(definition.name)!;
    if (!visible.has(definition.name) && !advertised.has(definition.name)) return false;
    return registration.registrationOwner?.startsWith('extension:') || registration.registrationOwner === 'runtime_mcp' &&
      registration.mcpHook && registration.mcpHook.modelVisible !== false;
  });
  const versions = (tools: ToolDefinition[]) => Object.fromEntries(tools.map(tool => [tool.name,
    createHash('sha256').update(canonical(tool)).digest('hex')]));
  const currentNames = new Set(current.map(tool => tool.name));
  const prior = catalogState(request.metadata.mcpLiveCatalogSnapshot, key(request)) ?? {
    identity: key(request), tools: versions(request.tools.filter(tool => currentNames.has(tool.name))), extensions: [],
  };
  const next: CatalogState = { identity: key(request), tools: versions(current), extensions: current.filter(tool =>
    registry.resolve(tool.name)?.registrationOwner?.startsWith('extension:')).map(tool => tool.name) };
  const added = current.filter(tool => !Object.hasOwn(prior.tools, tool.name)).map(tool => tool.name);
  const updated = current.filter(tool => Object.hasOwn(prior.tools, tool.name) && prior.tools[tool.name] !== next.tools[tool.name]).map(tool => tool.name);
  const removed = Object.keys(prior.tools).filter(name => !currentNames.has(name));
  const retained = request.tools.filter(tool => !Object.hasOwn(prior.tools, tool.name) && !currentNames.has(tool.name));
  request.tools = [...retained, ...current];
  request.metadata.mcpLiveCatalogSnapshot = next;
  // Refresh execution scope only. New/revised definitions are delivered by
  // discovery results; never rewrite a provider prefix already sent this turn.
  if (!added.length && !updated.length && !removed.length) return;
  return { role: 'user', name: 'mcp_catalog_update', visibility: 'internal', content: JSON.stringify({
    protocol: 'bush.plugin_catalog_update.v1',
    added: added.slice(0, 32), updated: updated.slice(0, 32), removed: removed.slice(0, 32),
    counts: { added: added.length, updated: updated.length, removed: removed.length },
    message: 'Plugin capabilities changed during this conversation. For new or changed MCP tools use mcp_search then mcp_call. For native extensions use get_tool_schema then call_tool. Top-level declarations stay unchanged; removed tools are unavailable. Already dispatched operations are not replayed.',
  }) };
}

/** Freeze only the provider projection. Execution always checks the authoritative live scope. */
export function modelToolDefinitions(registry: ToolRegistry, request: ModelRequest): ToolDefinition[] {
  if (request.metadata.toolExecutionPolicy === 'none') return [];
  const saved = request.metadata.mcpModelToolSnapshot as { identity?: string; tools?: unknown[] } | undefined;
  if (saved?.identity === key(request) && Array.isArray(saved.tools)) {
    const parsed = toolDefinitionSchema.array().safeParse(saved.tools);
    if (parsed.success) {
      let changed = false;
      const tools = parsed.data.map(definition => {
        const repaired = repairLegacyToolScriptSchema(definition);
        if (repaired === definition) return definition;
        changed = true;
        return withToolDisplayTitle(repaired);
      });
      if (changed) request.metadata.mcpModelToolSnapshot = { identity: key(request), tools: structuredClone(tools) };
      return tools;
    }
  }
  const tools = request.tools.filter(tool => registry.resolve(tool.name)?.mcpHook?.modelVisible !== false &&
    !registry.resolve(tool.name)?.deferredSchema &&
    (!tool.name.startsWith('agent_memory_') || request.metadata.pluginAgentMemoryActive === true) &&
    (!request.metadata.mcpToolDiscovery || !registry.resolve(tool.name)?.mcpHook)).map(repairLegacyToolScriptSchema).map(withToolDisplayTitle);
  // Keep discovery entry points when the catalog is empty, so connect/disconnect preserves them.
  const projected = projectBuiltinDefinitions(registry, request, tools);
  request.metadata.mcpModelToolSnapshot = { identity: key(request), tools: structuredClone(projected) };
  return projected;
}

export function registerMcpDiscovery(registry: ToolRegistry, loadSearchResultLimit?: SearchResultLimitProvider): void {
  const manifest = { effect_kind: 'observation' as const, operation: 'mcp.search', risk: 'low' as const, owner: 'runtime', dispatch_scope: 'parent_session' as const, mutating: false };
  registry.register<{ action: 'search' | 'load'; query: string; names?: string[]; server?: string; limit?: number; cursor?: McpSearchCursor }>({
    definition: { name: 'mcp_search', description: 'Discover MCP tools. action=search (default) returns short summaries, not schemas. Start with query (keywords or * to list), optionally server. Continue by passing next_cursor as cursor, without query/server; a changed query starts a new search. Partial or empty matches do not prove a capability unavailable: try alternate keywords or its server. action=load accepts one exact query OR names (up to 16 exact names) to load schemas together. Batch errors are per name; deferred names exceeded the result budget and still need loading. Load tools with loaded=false before calling via mcp_call; reuse visible schemas, reload only after change or compaction. Oversized single schemas use read_archived_tool_result. Discovery executes no tool and grants no permission.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['search', 'load'], default: 'search' }, query: { type: 'string', minLength: 1, maxLength: MCP_SEARCH_QUERY_LIMIT }, names: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', minLength: 1 } }, server: { type: 'string', maxLength: 512 }, limit: { ...searchLimitParameter }, cursor: { type: 'string', minLength: 1, maxLength: MCP_SEARCH_CURSOR_LIMIT } }, additionalProperties: false } },
    manifest, parallelSafe: true,
    decodeInput: input => {
      const value = input as Record<string, unknown>;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MCP search requires an object.');
      if ('offset' in value) throw new Error('MCP search no longer accepts offset. Continue with the returned next_cursor as cursor, or start a changed query from its first page.');
      const unknown = Object.keys(value).filter(key => !['action', 'query', 'names', 'server', 'limit', 'cursor'].includes(key));
      if (unknown.length) throw new Error(`Unknown MCP search fields: ${unknown.join(', ')}. Use action=search or action=load.`);
      if (value.server !== undefined && (typeof value.server !== 'string' || value.server.length > 512)) throw new Error('server must be a string of at most 512 characters.');
      const action = value.action ?? 'search';
      if (action !== 'search' && action !== 'load') throw new Error('action must be search or load.');
      if (value.cursor !== undefined) {
        if (action !== 'search' || value.query !== undefined || value.server !== undefined || value.names !== undefined) {
          throw new Error('cursor continues its original search; omit query, server and names. To change the query, omit cursor.');
        }
        const cursor = readMcpSearchCursor(value.cursor);
        return { action, query: cursor.query, server: cursor.server, cursor, limit: searchResultLimitSchema.optional().parse(value.limit) };
      }
      if (value.names !== undefined) {
        if (action !== 'load' || value.query !== undefined || !Array.isArray(value.names) || !value.names.length || value.names.length > 16 || !value.names.every(name => typeof name === 'string' && name.trim())) throw new Error('names requires action=load and 1–16 exact names, without query.');
      } else if (typeof value.query !== 'string' || !value.query.trim()) throw new Error('query must be nonempty.');
      if (typeof value.query === 'string' && value.query.length > MCP_SEARCH_QUERY_LIMIT) throw new Error(`query must be at most ${MCP_SEARCH_QUERY_LIMIT} characters.`);
      return { action, query: typeof value.query === 'string' ? value.query.trim() : '', ...(Array.isArray(value.names) ? { names: [...new Set(value.names.map(name => (name as string).trim()))] } : {}), server: value.server as string | undefined, limit: searchResultLimitSchema.optional().parse(value.limit) };
    },
    execute: async context => {
      if (!context.turn) throw new Error('MCP discovery requires a task.');
      if (context.input.names) {
        const matches: Record<string, unknown>[] = [], errors: Array<{ name: string; error: string }> = [];
        for (const name of context.input.names) {
          context.signal?.throwIfAborted();
          try {
            const result = await registry.resolve('mcp_search')!.execute({ ...context, input: { ...context.input, names: undefined, query: name } }) as { matches: Record<string, unknown>[] };
            matches.push(...result.matches);
          } catch (error) { context.signal?.throwIfAborted(); errors.push({ name, error: error instanceof Error ? error.message : String(error) }); }
        }
        return { protocol: MCP_DISCOVERY_PROTOCOL, sessionId: context.turn.request.sessionId, action: 'load', matches,
          invocation: mcpToolInvocation(context.turn.request, matches.length === 1 && typeof matches[0]!.name === 'string' ? matches[0]!.name : undefined),
          ...(matches.some(match => 'interface' in match) ? { hostCapabilities: MCP_HOST_CAPABILITIES } : {}),
          ...(errors.length ? { errors } : {}) };
      }
      const limit = context.input.action === 'load' ? 1 : await resolveSearchResultLimit(context.input.limit, loadSearchResultLimit);
      const request = context.turn.request;
      const visible = new Set(request.tools.map(tool => tool.name));
      const catalog = request.tools.flatMap(tool => {
        const definition = available(registry, request, tool.name, visible);
        if (!definition) return [];
        const mcp = registry.resolve(tool.name)!.mcpHook!;
        if (context.input.server && mcp.server !== context.input.server) return [];
        return [{ definition, server: mcp.server, tool: mcp.tool }];
      });
      const query = context.input.action === 'load' ? resolveToolReferenceName(context.input.query, context.turn) : context.input.query;
      const candidates = context.input.action === 'load' ? catalog.flatMap(entry => [entry.definition.name, entry.tool].includes(query)
        ? [{ ...entry, score: entry.definition.name === query ? 2 : 1 }] : []).sort((a, b) => b.score - a.score)
        : rankMcpTools(catalog, context.input.query);
      const fingerprint = context.input.action === 'search' ? mcpSearchFingerprint(request.sessionId, context.input.query, context.input.server, candidates) : '';
      if (context.input.cursor && context.input.cursor.fingerprint !== fingerprint) {
        throw Object.assign(new Error('This MCP search cursor belongs to another conversation or its results changed. Start a new search with query; no page was skipped.'), { code: 'mcp_search_cursor_stale' });
      }
      const loaded = loadedTools(registry, request);
      if (context.input.action === 'load' && (candidates.length === 0 || (candidates.length > 1 && candidates[0]!.score !== 2))) {
        throw new Error(candidates.length ? 'Tool name is ambiguous; use the exact qualified name returned by search.' : 'Tool not found or unavailable. Search for its current exact name.');
      }
      const offset = context.input.cursor?.offset ?? 0;
      if (context.input.cursor && offset >= candidates.length) throw new Error('Invalid MCP search cursor position. Start a new search with query.');
      const page = context.input.action === 'load' ? candidates.slice(0, 1) : candidates.slice(offset, offset + limit);
      const matches = page.map(candidate => {
        const version = revision(registry, candidate.definition);
        const description = discoveryDescription(candidate.definition.description);
        if (context.input.action !== 'load') return {
          name: candidate.definition.name, description,
          ...(description !== candidate.definition.description ? { descriptionTruncated: true } : {}),
          server: candidate.server, tool: candidate.tool,
          loaded: loaded.get(candidate.definition.name) === version,
        };
        const app = registry.resolve(candidate.definition.name)?.mcpApp;
        const reference = { name: candidate.definition.name, server: candidate.server, tool: candidate.tool, revision: version,
          declarationSource: 'server', ...(app ? { interface: { resourceUri: app.resourceUri, state: 'declared' } } : {}) };
        return { ...candidate.definition, ...reference };
      });
      remember(registry, request, loaded);
      const next = offset + matches.length;
      return { protocol: MCP_DISCOVERY_PROTOCOL, sessionId: request.sessionId, action: context.input.action,
        ...(context.input.action === 'load' ? { invocation: mcpToolInvocation(request, matches[0]?.name) } : {}),
        ...(context.input.action === 'load' && matches.some(match => 'interface' in match) ? { hostCapabilities: MCP_HOST_CAPABILITIES } : {}),
        matches, total: context.input.action === 'load' ? 1 : candidates.length,
        more: context.input.action !== 'load' && candidates.length > next,
        ...(context.input.action !== 'load' ? { query: context.input.query,
          _searchPage: { query: context.input.query, ...(context.input.server ? { server: context.input.server } : {}), offset, fingerprint },
          ...(candidates.length > next ? { next_cursor: writeMcpSearchCursor({ query: context.input.query, server: context.input.server, offset: next, fingerprint }) } : {}) } : {}) };
    },
  });
  registry.register<{ name: string; arguments: Record<string, unknown> }>({
    definition: { name: 'mcp_call', description: 'Call an MCP tool whose current schema was loaded by mcp_search in this conversation. Reuse its exact name and schema across turns. Search again if its definition changed or left context. The selected tool retains its own approvals, Hooks, timeout and cancellation.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } }, required: ['name', 'arguments'], additionalProperties: false } },
    manifest: { ...manifest, operation: 'mcp.invoke' }, delegatesToolExecution: true,
    decodeInput: input => {
      const value = input as Record<string, unknown>;
      if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.name !== 'string' || !value.name.trim() || !value.arguments || typeof value.arguments !== 'object' || Array.isArray(value.arguments)) throw new Error('MCP call requires {name: "exact tool name", arguments: {tool fields}}. No tool was executed.');
      const unknown = Object.keys(value).filter(key => key !== 'name' && key !== 'arguments');
      if (unknown.length) throw new Error(`Unknown mcp_call fields: ${unknown.join(', ')}. Put the selected tool's fields inside arguments. No tool was executed.`);
      return { name: value.name, arguments: value.arguments as Record<string, unknown> };
    },
    execute: async context => {
      const { name, registration } = mcpInvocationTarget(registry, context.turn, context.input.name);
      const mcp = registration.mcpHook!;
      return { mcp: { server: mcp.server, tool: mcp.tool, name }, result: await context.invokeTool(name, context.input.arguments) };
    },
    renderModelResult: value => {
      const output = value as { mcp: { name: string }; result: unknown };
      return registry.renderModelResult(output.mcp.name, output.result) ?? JSON.stringify(output.result);
    },
  });
}
