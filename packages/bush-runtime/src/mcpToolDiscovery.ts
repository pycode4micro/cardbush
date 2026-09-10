import { createHash } from 'node:crypto';
import { toolDefinitionSchema, type ModelMessage, type ModelRequest, type ToolDefinition } from '@cardbush/bush-protocol';
import type { ToolRegistry } from './toolRegistry.js';

const DISCOVERY_PROTOCOL = 'bush.mcp_discovery.v1';
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

/** Rebuild from the exact model context after restart or compaction, without rewriting history.
 * A summary, compact reference or archived preview cannot substitute for a full loaded schema.
 */
export function synchronizeMcpDiscovery(registry: ToolRegistry, request: ModelRequest, messages: ModelMessage[]): void {
  if (!request.metadata.mcpToolDiscovery) return;
  const calls = new Map<string, string>(), loaded: LoadedTools = new Map();
  const visible = new Set(request.tools.map(tool => tool.name));
  const archives = new Map<string, { length: number; chunks: Map<number, string> }>();
  const accept = (output: any) => {
    if (output?.protocol !== DISCOVERY_PROTOCOL || output.sessionId !== request.sessionId || !Array.isArray(output.matches)) return;
    for (const match of output.matches) {
      if (!match || typeof match.name !== 'string' || typeof match.revision !== 'string') continue;
      const current = available(registry, request, match.name, visible);
      if (!current || revision(registry, current) !== match.revision) continue;
      const definition = toolDefinitionSchema.safeParse(match);
      if (definition.success && revision(registry, definition.data) === match.revision) loaded.set(match.name, match.revision);
    }
  };
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls) if (call.name === 'mcp_search' || call.name === 'read_archived_tool_result') calls.set(call.id, call.name);
    } else if (message.role === 'tool') {
      const name = calls.get(message.toolCallId); calls.delete(message.toolCallId);
      if (name === 'mcp_search') {
        let output;
        try { output = JSON.parse(message.content); } catch { continue; }
        if (output?.archived === true && typeof output.locator === 'string' && Number.isSafeInteger(output.originalChars) && output.originalChars > 0) {
          archives.set(output.locator, { length: output.originalChars, chunks: new Map() });
        } else accept(output);
      } else if (name === 'read_archived_tool_result') {
        // Tool-owned text presentation: metadata followed by an exact, unquoted text chunk.
        const divider = '\n\n[text]\n', boundary = message.content.indexOf(divider);
        if (boundary < 0) continue;
        let chunk;
        try { chunk = JSON.parse(message.content.slice(0, boundary)); } catch { continue; }
        if (!chunk || typeof chunk !== 'object') continue;
        const archive = archives.get(chunk.locator), text = message.content.slice(boundary + divider.length);
        if (!archive || !Number.isSafeInteger(chunk.offset) || chunk.offset < 0 || chunk.next_offset !== chunk.offset + text.length || chunk.next_offset > archive.length) continue;
        archive.chunks.set(chunk.offset, text);
        let combined = '';
        for (const [offset, part] of [...archive.chunks].sort(([a], [b]) => a - b)) {
          if (offset > combined.length) break;
          combined += part.slice(Math.max(0, combined.length - offset));
        }
        if (combined.length === archive.length) { try { accept(JSON.parse(combined)); } catch { /* incomplete/overridden text */ } }
      }
    }
  }
  remember(registry, request, loaded);
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
    (!request.metadata.mcpToolDiscovery || !registry.resolve(tool.name)?.mcpHook));
  // Keep discovery entry points when the catalog is empty, so connect/disconnect preserves them.
  request.metadata.mcpModelToolSnapshot = { identity: key(request), tools: structuredClone(tools) };
  return tools;
}

export function registerMcpDiscovery(registry: ToolRegistry): void {
  const manifest = { effect_kind: 'observation' as const, operation: 'mcp.search', risk: 'low' as const, owner: 'runtime', dispatch_scope: 'parent_session' as const, mutating: false };
  registry.register<{ query: string; server?: string; limit: number; reload: boolean }>({
    definition: { name: 'mcp_search', description: 'Find MCP tools by capability, server or exact name. Returns schemas for new/changed tools; unchanged tools already visible in this conversation return compact references. Reuse loaded tools with mcp_call across turns. Set reload to true for full schemas. If archived, read the complete result with read_archived_tool_result. Search does not execute tools or grant permission.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, server: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 }, reload: { type: 'boolean', default: false } }, required: ['query'], additionalProperties: false } },
    manifest, parallelSafe: true,
    decodeInput: input => {
      const value = input as Record<string, unknown>;
      if (!value || typeof value.query !== 'string' || !value.query.trim() || (value.server !== undefined && typeof value.server !== 'string') || (value.reload !== undefined && typeof value.reload !== 'boolean')) throw new Error('MCP search needs a non-empty query, optional server and boolean reload.');
      return { query: value.query.trim(), server: value.server as string | undefined, limit: Math.min(10, Math.max(1, Number(value.limit) || 5)), reload: value.reload === true };
    },
    execute: context => {
      if (!context.turn) throw new Error('MCP discovery requires a task.');
      const request = context.turn.request;
      const visible = new Set(request.tools.map(tool => tool.name));
      const terms = [...new Set(context.input.query.toLocaleLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? [])];
      const candidates = request.tools.flatMap(tool => {
        const definition = available(registry, request, tool.name, visible);
        if (!definition) return [];
        const mcp = registry.resolve(tool.name)!.mcpHook!;
        if (context.input.server && mcp.server !== context.input.server) return [];
        const text = [mcp.server, mcp.tool, definition.name, definition.description].join(' ').toLocaleLowerCase();
        const score = terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
        return score || context.input.server || context.input.query === '*' ? [{ definition, server: mcp.server, tool: mcp.tool, score }] : [];
      }).sort((a, b) => b.score - a.score || a.definition.name.localeCompare(b.definition.name));
      const loaded = loadedTools(registry, request);
      const matches = candidates.slice(0, context.input.limit).map(candidate => {
        const version = revision(registry, candidate.definition);
        const reference = { name: candidate.definition.name, server: candidate.server, tool: candidate.tool, revision: version };
        const alreadyLoaded = loaded.get(candidate.definition.name) === version;
        loaded.set(candidate.definition.name, version);
        return !context.input.reload && alreadyLoaded ? { ...reference, loaded: true } : { ...candidate.definition, ...reference };
      });
      remember(registry, request, loaded);
      return { protocol: DISCOVERY_PROTOCOL, sessionId: request.sessionId, matches, total: candidates.length, more: candidates.length > matches.length };
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
      if (!context.turn || !mcp || !available(registry, context.turn.request, context.input.name) ||
        !mcpToolWasDiscovered(registry, { ...context.turn.request, metadata: { ...context.turn.request.metadata, mcpToolDiscovery: true } }, context.input.name)) {
        throw Object.assign(new Error('Load the current schema with mcp_search first. It may have changed, become unavailable, or left context after compaction.'), { code: 'mcp_discovery_required' });
      }
      return { mcp: { server: mcp.server, tool: mcp.tool, name: context.input.name }, result: await context.invokeTool(context.input.name, context.input.arguments) };
    },
    renderModelResult: value => {
      const output = value as { mcp: { name: string }; result: unknown };
      return registry.renderModelResult(output.mcp.name, output.result) ?? JSON.stringify(output.result);
    },
  });
}
