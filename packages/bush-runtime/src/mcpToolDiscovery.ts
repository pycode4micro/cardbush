import { createHash } from 'node:crypto';
import { withToolDisplayTitle } from './toolDisplay.js';
import { searchLimitParameter, searchResultLimitSchema, toolDefinitionSchema, type ModelMessage, type ModelRequest, type ToolDefinition } from '@cardbush/bush-protocol';
import type { ToolRegistry } from './toolRegistry.js';
import { MCP_HOST_CAPABILITIES } from './mcpHostCapabilities.js';
import { resolveSearchResultLimit, type SearchResultLimitProvider } from './searchResultLimit.js';
import { MCP_SEARCH_CURSOR_LIMIT, MCP_SEARCH_QUERY_LIMIT, mcpSearchFingerprint, rankMcpTools, readMcpSearchCursor, writeMcpSearchCursor, type McpSearchCursor } from './mcpToolSearch.js';

export const MCP_DISCOVERY_PROTOCOL = 'bush.mcp_discovery.v1';

/** Keep the index visible and only emit complete definitions. The native result
 * stays in the execution journal; this is its bounded model presentation. */
export function projectMcpDiscoveryResult(text: string, maxChars?: number): string | undefined {
  let result: any;
  try { result = JSON.parse(text); } catch { return undefined; }
  if (result?.protocol !== MCP_DISCOVERY_PROTOCOL || !Array.isArray(result.matches)) return undefined;
  // Search receipts stay compact; explicit loads contain complete definitions.
  // Oversized receipts use the ordinary immutable result archive.
  if (result.action === 'search' || result.action === 'load') {
    const { next_step: _next, ...receipt } = result;
    if (result.action === 'search') {
      delete receipt.protocol; delete receipt.sessionId;
      receipt.matches = result.matches.map(({ name, description, descriptionTruncated, loaded }: any) =>
        ({ name, description, ...(descriptionTruncated ? { descriptionTruncated } : {}), loaded }));
    }
    const compact = JSON.stringify(receipt);
    return compact.length <= (maxChars ?? (result.action === 'load' ? 128_000 : 16_000)) ? compact : undefined;
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
  return Object.assign(new Error('This MCP tool is available, but its current schema is not loaded in the model context. Call mcp_search with the action and exact query in details.load, read the returned schema, then retry the tool (using mcp_call when available). The tool has not executed; this does not indicate a service connection failure.'), {
    code: 'mcp_discovery_required',
    details: { toolName: name, load: { name: 'mcp_search', arguments: { action: 'load', query: name } } },
  });
}

/** Rebuild from the exact model context after restart or compaction, without rewriting history.
 * A summary, compact reference or archived preview cannot substitute for a full loaded schema.
 */
export function* mcpDiscoveryResults(messages: ModelMessage[], sessionId: string): Generator<{
  messageIndex: number;
  searchCallId: string;
  output: { protocol: string; sessionId: string; action: 'load'; matches: unknown[]; total?: number; more?: boolean };
}> {
  const calls = new Map<string, string>();
  const archives = new Map<string, { length: number; chunks: Map<number, string>; invalid?: boolean; emitted?: boolean }>();
  const archiveCalls = new Map<string, string>();
  for (const [messageIndex, message] of messages.entries()) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) if (call.name === 'mcp_search' || call.name === 'read_archived_tool_result') calls.set(call.id, call.name);
    } else if (message.role === 'tool') {
      const name = calls.get(message.toolCallId); calls.delete(message.toolCallId);
      let output: any, searchCallId = message.toolCallId;
      if (name === 'mcp_search') {
        try { output = JSON.parse(message.content); } catch { continue; }
        if (output?.archived === true && typeof output.locator === 'string' && Number.isSafeInteger(output.originalChars) && output.originalChars > 0) {
          archives.set(output.locator, { length: output.originalChars, chunks: new Map() });
          archiveCalls.set(output.locator, message.toolCallId);
          continue;
        }
      } else if (name === 'read_archived_tool_result') {
        const divider = '\n\n[text]\n', boundary = message.content.indexOf(divider);
        if (boundary < 0) continue;
        let chunk;
        try { chunk = JSON.parse(message.content.slice(0, boundary)); } catch { continue; }
        if (!chunk || typeof chunk !== 'object') continue;
        const archive = archives.get(chunk.locator), text = message.content.slice(boundary + divider.length);
        if (!archive || archive.invalid || archive.emitted || !Number.isSafeInteger(chunk.offset) || chunk.offset < 0 || chunk.next_offset !== chunk.offset + text.length || chunk.next_offset > archive.length) continue;
        for (const [offset, part] of archive.chunks) {
          const start = Math.max(offset, chunk.offset), end = Math.min(offset + part.length, chunk.next_offset);
          if (start < end && part.slice(start - offset, end - offset) !== text.slice(start - chunk.offset, end - chunk.offset)) {
            archive.invalid = true;
            break;
          }
        }
        if (archive.invalid) continue;
        if ((archive.chunks.get(chunk.offset)?.length ?? -1) < text.length) archive.chunks.set(chunk.offset, text);
        let combined = '';
        for (const [offset, part] of [...archive.chunks].sort(([a], [b]) => a - b)) {
          if (offset > combined.length) break;
          combined += part.slice(Math.max(0, combined.length - offset));
        }
        if (combined.length !== archive.length) continue;
        try { output = JSON.parse(combined); } catch { continue; }
        searchCallId = archiveCalls.get(chunk.locator)!;
        // An immutable archive contributes its schema at the first complete read.
        // Later duplicate reads must not inject the same large definitions again.
        archive.emitted = true;
      } else continue;
      if (output?.protocol === MCP_DISCOVERY_PROTOCOL && output.sessionId === sessionId && output.action === 'load' && Array.isArray(output.matches)) {
        yield { messageIndex, searchCallId, output };
      }
    }
  }
}

export function synchronizeMcpDiscovery(registry: ToolRegistry, request: ModelRequest, messages: ModelMessage[]): void {
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

/** Add host-published optional MCP tools at a product turn's round boundary. */
export function synchronizeMcpCatalog(registry: ToolRegistry, request: ModelRequest): void {
  // Only ordinary product conversations opt in. Child roles and scheduled
  // tasks retain their explicit, inherited tool scope.
  if (request.metadata.mcpCatalogUpdates !== 'additions' || !request.metadata.mcpToolDiscovery ||
    request.metadata.agentRole === 'child' || request.metadata.pluginAgentId || request.metadata.automationRunId) return;
  const known = new Set(request.tools.map(tool => tool.name));
  for (const definition of registry.definitions()) {
    const registration = registry.resolve(definition.name)!;
    if (!known.has(definition.name) && registration.registrationOwner === 'runtime_mcp' &&
      registration.mcpHook && registration.mcpHook.modelVisible !== false) request.tools.push(definition);
  }
}

/** Freeze only the provider projection. Execution always checks the authoritative live scope. */
export function modelToolDefinitions(registry: ToolRegistry, request: ModelRequest): ToolDefinition[] {
  const saved = request.metadata.mcpModelToolSnapshot as { identity?: string; tools?: unknown[] } | undefined;
  if (saved?.identity === key(request) && Array.isArray(saved.tools)) {
    const parsed = toolDefinitionSchema.array().safeParse(saved.tools);
    if (parsed.success) return parsed.data;
  }
  const tools = request.tools.filter(tool => registry.resolve(tool.name)?.mcpHook?.modelVisible !== false &&
    (!tool.name.startsWith('agent_memory_') || request.metadata.pluginAgentMemoryActive === true) &&
    (!request.metadata.mcpToolDiscovery || !registry.resolve(tool.name)?.mcpHook)).map(withToolDisplayTitle);
  // Keep discovery entry points when the catalog is empty, so connect/disconnect preserves them.
  request.metadata.mcpModelToolSnapshot = { identity: key(request), tools: structuredClone(tools) };
  return tools;
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
        const matches: Record<string, unknown>[] = [], errors: Array<{ name: string; error: string }> = [], deferred: string[] = [];
        let chars = 0;
        for (const name of context.input.names) {
          context.signal?.throwIfAborted();
          try {
            const result = await registry.resolve('mcp_search')!.execute({ ...context, input: { ...context.input, names: undefined, query: name } }) as { matches: Record<string, unknown>[] };
            const size = JSON.stringify(result.matches).length;
            if (matches.length && chars + size > 96_000) { deferred.push(name); continue; }
            matches.push(...result.matches); chars += size;
          } catch (error) { context.signal?.throwIfAborted(); errors.push({ name, error: error instanceof Error ? error.message : String(error) }); }
        }
        return { protocol: MCP_DISCOVERY_PROTOCOL, sessionId: context.turn.request.sessionId, action: 'load', matches,
          ...(matches.some(match => 'interface' in match) ? { hostCapabilities: MCP_HOST_CAPABILITIES } : {}),
          ...(errors.length ? { errors } : {}), ...(deferred.length ? { deferred } : {}) };
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
      const candidates = context.input.action === 'load' ? catalog.flatMap(entry => [entry.definition.name, entry.tool].includes(context.input.query)
        ? [{ ...entry, score: entry.definition.name === context.input.query ? 2 : 1 }] : []).sort((a, b) => b.score - a.score)
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
        if (context.input.action !== 'load') return {
          name: candidate.definition.name, description: candidate.definition.description.slice(0, 512),
          ...(candidate.definition.description.length > 512 ? { descriptionTruncated: true } : {}),
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
        ...(context.input.action === 'load' && matches.some(match => 'interface' in match) ? { hostCapabilities: MCP_HOST_CAPABILITIES } : {}),
        matches, total: context.input.action === 'load' ? 1 : candidates.length,
        more: context.input.action !== 'load' && candidates.length > next,
        ...(context.input.action !== 'load' ? { query: context.input.query,
          ...(candidates.length > next ? { next_cursor: writeMcpSearchCursor({ query: context.input.query, server: context.input.server, offset: next, fingerprint }) } : {}) } : {}) };
    },
  });
  registry.register<{ name: string; arguments: Record<string, unknown> }>({
    definition: { name: 'mcp_call', description: 'Call an MCP tool whose current schema was loaded by mcp_search in this conversation. Reuse its exact name and schema across turns. Search again if its definition changed or left context. The selected tool retains its own approvals, Hooks, timeout and cancellation.', inputSchema: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object', additionalProperties: true } }, required: ['name', 'arguments'], additionalProperties: false } },
    manifest: { ...manifest, operation: 'mcp.invoke' }, delegatesToolExecution: true,
    decodeInput: input => {
      const value = input as Record<string, unknown>;
      if (!value || typeof value.name !== 'string' || !value.arguments || typeof value.arguments !== 'object' || Array.isArray(value.arguments)) throw new Error('MCP call requires a tool name and argument object.');
      return { name: value.name, arguments: value.arguments as Record<string, unknown> };
    },
    execute: async context => {
      const mcp = registry.resolve(context.input.name)?.mcpHook;
      if (!context.turn || !mcp || !available(registry, context.turn.request, context.input.name)) {
        throw Object.assign(new Error('This MCP tool is not available to this turn. Use mcp_search to check the current catalog; loading a schema cannot restore an unavailable tool.'), { code: 'tool_not_exposed' });
      }
      if (!mcpToolWasDiscovered(registry, { ...context.turn.request, metadata: { ...context.turn.request.metadata, mcpToolDiscovery: true } }, context.input.name)) {
        throw mcpSchemaRequiredError(context.input.name);
      }
      return { mcp: { server: mcp.server, tool: mcp.tool, name: context.input.name }, result: await context.invokeTool(context.input.name, context.input.arguments) };
    },
    renderModelResult: value => {
      const output = value as { mcp: { name: string }; result: unknown };
      return registry.renderModelResult(output.mcp.name, output.result) ?? JSON.stringify(output.result);
    },
  });
}
