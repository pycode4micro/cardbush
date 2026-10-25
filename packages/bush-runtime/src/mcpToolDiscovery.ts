import { toolSchemaReceipts, TOOL_SCHEMA_PROTOCOL } from './toolSchemaReceipts.js';
import { createHash } from 'node:crypto';
import { withToolDisplayTitle } from './toolDisplay.js';
import { projectBuiltinDefinitions, synchronizeBuiltinSchemas } from './builtinToolDisclosure.js';
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
  const gateway = 'call_tool';
  if (request.tools.some(tool => tool.name === gateway)) return {
    tool: gateway, arguments: { name, arguments: 'Use the loaded inputSchema fields here.' },
    note: 'Load and read the schema before invoking the target. Put the target name here, never another invocation gateway.',
  };
  return request.metadata.mcpToolDiscovery
    ? { tool: null, note: 'No tool invocation gateway is exposed in this scope. Use an available execution interface; schema loading does not add a gateway or grant access.' }
    : { tool: name, arguments: 'Use the loaded inputSchema fields directly.' };
}

/** Keep the index visible and only emit complete definitions. The native result
 * stays in the execution journal; this is its bounded model presentation. */
export function projectMcpDiscoveryResult(text: string, maxChars = DEFAULT_TOOL_RESULT_MAX_CHARS): string | undefined {
  let result: any;
  try { result = JSON.parse(text); } catch { return undefined; }
  if (!((result?.protocol === MCP_DISCOVERY_PROTOCOL && result.action === 'search') ||
        (result?.protocol === TOOL_SCHEMA_PROTOCOL && result.action === 'load')) || !Array.isArray(result.matches)) return undefined;
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
    registration.modelAvailable?.(request) === false ||
    (registration.sessionScope && registration.sessionScope !== request.sessionId) ||
    !(visible ? visible.has(name) : request.tools.some(tool => tool.name === name))) return undefined;
  return registration.definition;
}

/** MCP definitions use the same receipt as native definitions. */
export function loadMcpToolSchema(registry: ToolRegistry, request: ModelRequest, name: string) {
  const definition = available(registry, request, name);
  if (!definition) throw Object.assign(new Error('This tool is not available to this turn. Loading a schema grants no access.'), { code: 'tool_not_exposed' });
  const registration = registry.resolve(name)!, mcp = registration.mcpHook!, app = registration.mcpApp;
  return { protocol: TOOL_SCHEMA_PROTOCOL, sessionId: request.sessionId, action: 'load' as const,
    matches: [{ ...definition, source: 'mcp', server: mcp.server, tool: mcp.tool, revision: revision(registry, definition),
      declarationSource: 'server', ...(app ? { interface: { resourceUri: app.resourceUri, state: 'declared' } } : {}) }],
    invocation: mcpToolInvocation(request, name), ...(app ? { hostCapabilities: MCP_HOST_CAPABILITIES } : {}) };
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
  const load = { name: 'get_tool_schema', arguments: { name } };
  return withToolFailureFacts(Object.assign(new Error('This tool is available, but its current schema is not loaded in the model context. Follow details.load, read the complete schema, then call the target through call_tool. Do not run the dependent call in parallel with loading. The tool has not executed; this does not indicate a service connection failure.'), {
    code: 'mcp_discovery_required',
    details: { toolName: name, load },
  }), { effects: 'none', result: 'known' });
}

/** Shared preflight only; execution still re-enters the normal coordinator for every call. */
export function mcpInvocationTarget(registry: ToolRegistry, turn: ToolHandlerContext['turn'], reference: string, readOnly = false) {
  const name = resolveToolReferenceName(reference, turn), registration = registry.resolve(name);
  if (!registration) throw unknownToolReferenceError(reference, 'mcp');
  if (!turn || !turn.request.tools.some(tool => tool.name === name) || registration.mcpHook?.modelVisible === false ||
    registration.modelAvailable?.(turn.request) === false ||
    registration.sessionScope && registration.sessionScope !== turn.request.sessionId) {
    throw withToolFailureFacts(Object.assign(new Error('This MCP tool is not available to this turn. Use mcp_search to check the current catalog; loading a schema cannot restore an unavailable tool.'), { code: 'tool_not_exposed' }), { effects: 'none', result: 'known' });
  }
  if (!registration.mcpHook) throw wrongToolRouteError(name, 'native');
  if (readOnly && !registration.mcpHook.readOnly) throw withToolFailureFacts(Object.assign(
    new Error('Only MCP tools declared read-only can run through start_mcp_tool. Invoke this tool normally after loading its schema; its permissions still apply. No tool was executed.'),
    { code: 'mcp_background_read_only_required', details: { toolName: name, invoke: mcpToolInvocation(turn.request, name).tool } },
  ), { effects: 'none', result: 'known' });
  if (!mcpToolWasDiscovered(registry, { ...turn.request, metadata: { ...turn.request.metadata, mcpToolDiscovery: true } }, name)) throw mcpSchemaRequiredError(name);
  return { name, registration };
}

/** Rebuild from the exact model context after restart or compaction, without rewriting history.
 * A summary, compact reference or archived preview cannot substitute for a full loaded schema.
 */
export function* mcpDiscoveryResults(messages: ModelMessage[], sessionId: string) {
  for (const receipt of toolSchemaReceipts(messages, sessionId, 'get_tool_schema', TOOL_SCHEMA_PROTOCOL)) {
    if (receipt.output.matches.some(match => (match as { source?: string })?.source === 'mcp')) yield receipt;
  }
}

export function synchronizeMcpDiscovery(registry: ToolRegistry, request: ModelRequest, messages: ModelMessage[]): void {
  synchronizeBuiltinSchemas(registry, request, messages);
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
  const current = registry.definitions().filter(definition => {
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
    message: 'Plugin capabilities changed during this conversation. Load new or changed tool definitions with get_tool_schema, then use call_tool with the target name. Find MCP names with mcp_search; batch-load definitions with get_tool_schema names. Top-level declarations stay unchanged; removed tools are unavailable. Already dispatched operations are not replayed.',
  }) };
}

/** Freeze only the provider projection. Execution always checks the authoritative live scope. */
export function modelToolDefinitions(registry: ToolRegistry, request: ModelRequest): ToolDefinition[] {
  if (request.metadata.toolExecutionPolicy === 'none') return [];
  const saved = request.metadata.mcpModelToolSnapshot as { identity?: string; tools?: unknown[] } | undefined;
  if (saved?.identity === key(request) && Array.isArray(saved.tools)) {
    const parsed = toolDefinitionSchema.array().safeParse(saved.tools);
    // A read must never upgrade or rewrite an established conversation contract.
    if (parsed.success) return parsed.data;
  }

  const tools = request.tools.filter(tool => registry.resolve(tool.name)?.mcpHook?.modelVisible !== false &&
    !registry.resolve(tool.name)?.deferredSchema &&
    (!request.metadata.mcpToolDiscovery || !registry.resolve(tool.name)?.mcpHook)).map(withToolDisplayTitle);
  // Keep discovery entry points when the catalog is empty, so connect/disconnect preserves them.
  const projected = projectBuiltinDefinitions(registry, request, tools);
  request.metadata.mcpModelToolSnapshot = { identity: key(request), tools: structuredClone(projected) };
  return projected;
}

export function registerMcpDiscovery(registry: ToolRegistry, loadSearchResultLimit?: SearchResultLimitProvider): void {
  const manifest = { effect_kind: 'observation' as const, operation: 'mcp.search', risk: 'low' as const, owner: 'runtime', dispatch_scope: 'parent_session' as const, mutating: false };
  registry.register<{ query: string; server?: string; limit?: number; cursor?: McpSearchCursor }>({
    directInvocation: true,
    definition: { name: 'mcp_search', description: 'Find MCP tool names and short summaries, not schemas. Start with query (keywords or *); optionally narrow by server. Continue with next_cursor as cursor, without query/server. A changed query starts a new search. Partial or empty matches do not prove a capability unavailable: try alternate keywords or its server. Use get_tool_schema with an exact name or names batch before invoking. Discovery executes no target and grants no permission.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 1, maxLength: MCP_SEARCH_QUERY_LIMIT }, server: { type: 'string', maxLength: 512 }, limit: { ...searchLimitParameter }, cursor: { type: 'string', minLength: 1, maxLength: MCP_SEARCH_CURSOR_LIMIT } }, additionalProperties: false } },
    manifest, parallelSafe: true,
    decodeInput: input => {
      const value = input as Record<string, unknown>;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected MCP search arguments.');
      const unknown = Object.keys(value).filter(key => !['query', 'server', 'limit', 'cursor'].includes(key));
      if (unknown.length) throw new Error(`Unknown MCP search fields: ${unknown.join(', ')}. Use get_tool_schema to load definitions.`);
      if (value.server !== undefined && (typeof value.server !== 'string' || value.server.length > 512)) throw new Error('server must be a string of at most 512 characters.');
      if (value.cursor !== undefined) {
        if (value.query !== undefined || value.server !== undefined) throw new Error('cursor continues its original search; omit query and server.');
        const cursor = readMcpSearchCursor(value.cursor);
        return { query: cursor.query, server: cursor.server, cursor, limit: searchResultLimitSchema.optional().parse(value.limit) };
      }
      if (typeof value.query !== 'string' || !value.query.trim() || value.query.length > MCP_SEARCH_QUERY_LIMIT) throw new Error('query must be nonempty and within the query length limit.');
      return { query: value.query.trim(), server: value.server as string | undefined, limit: searchResultLimitSchema.optional().parse(value.limit) };
    },
    execute: async context => {
      if (!context.turn) throw new Error('MCP discovery requires a task.');
      const request = context.turn.request, limit = await resolveSearchResultLimit(context.input.limit, loadSearchResultLimit);
      const visible = new Set(request.tools.map(tool => tool.name));
      const catalog = request.tools.flatMap(tool => {
        const definition = available(registry, request, tool.name, visible);
        if (!definition) return [];
        const mcp = registry.resolve(tool.name)!.mcpHook!;
        return context.input.server && mcp.server !== context.input.server ? [] : [{ definition, server: mcp.server, tool: mcp.tool }];
      });
      const candidates = rankMcpTools(catalog, context.input.query);
      const fingerprint = mcpSearchFingerprint(request.sessionId, context.input.query, context.input.server, candidates);
      if (context.input.cursor && context.input.cursor.fingerprint !== fingerprint) throw Object.assign(new Error('This MCP search cursor belongs to another conversation or its results changed. Start a new search; no page was skipped.'), { code: 'mcp_search_cursor_stale' });
      const loaded = loadedTools(registry, request), offset = context.input.cursor?.offset ?? 0;
      if (context.input.cursor && offset >= candidates.length) throw new Error('Invalid MCP search cursor position.');
      const matches = candidates.slice(offset, offset + limit).map(candidate => {
        const description = discoveryDescription(candidate.definition.description);
        return { name: candidate.definition.name, description, ...(description !== candidate.definition.description ? { descriptionTruncated: true } : {}),
          server: candidate.server, tool: candidate.tool, loaded: loaded.get(candidate.definition.name) === revision(registry, candidate.definition) };
      });
      remember(registry, request, loaded);
      const next = offset + matches.length;
      return { protocol: MCP_DISCOVERY_PROTOCOL, sessionId: request.sessionId, action: 'search', matches, total: candidates.length,
        more: candidates.length > next, query: context.input.query,
        _searchPage: { query: context.input.query, ...(context.input.server ? { server: context.input.server } : {}), offset, fingerprint },
        ...(candidates.length > next ? { next_cursor: writeMcpSearchCursor({ query: context.input.query, server: context.input.server, offset: next, fingerprint }) } : {}) };
    },
  });
}
