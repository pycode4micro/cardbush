import { createHash } from 'node:crypto';
import { toolDefinitionSchema, type ModelMessage, type ModelRequest, type ToolDefinition } from '@cardbush/bush-protocol';
import type { ToolRegistry } from './toolRegistry.js';

export const MCP_DISCOVERY_PROTOCOL = 'bush.mcp_discovery.v1';

/** Keep the index visible and only emit complete definitions. The native result
 * stays in the execution journal; this is its bounded model presentation. */
export function projectMcpDiscoveryResult(text: string, maxChars?: number): string | undefined {
  let result: any;
  try { result = JSON.parse(text); } catch { return undefined; }
  if (result?.protocol !== MCP_DISCOVERY_PROTOCOL || !Array.isArray(result.matches)) return undefined;
  const catalog = result.matches.map((item: any) => ({ name: item.name, server: item.server, tool: item.tool,
    revision: item.revision, ...(typeof item.description === 'string' ? { summary: item.description.slice(0, 160) } : {}) }));
  const output = { protocol: result.protocol, sessionId: result.sessionId, catalog,
    matches: [] as unknown[], total: result.total, more: result.more, next_offset: result.next_offset,
    unloaded: result.matches.map((item: any) => item.name) as string[] };
  const serialize = () => JSON.stringify({ ...output, ...(output.unloaded.length ? {
    load: 'These definitions were not included in this result. Search the exact tool name with reload=true and limit=1 to load a complete definition. A definition that still exceeds the available context remains unloaded.',
  } : {}) });
  // An exact, single-tool load may exceed the ordinary log preview limit.
  const budget = maxChars ?? (result.matches.length === 1 ? 128_000 : 16_000);
  for (const item of result.matches) {
    const index = output.unloaded.indexOf(item.name);
    output.unloaded.splice(index, 1);
    output.matches.push(item);
    if (serialize().length > budget) {
      output.matches.pop(); output.unloaded.splice(index, 0, item.name);
    }
  }
  return serialize();
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

/** Rebuild from the exact model context after restart or compaction, without rewriting history.
 * A summary, compact reference or archived preview cannot substitute for a full loaded schema.
 */
export function* mcpDiscoveryResults(messages: ModelMessage[], sessionId: string): Generator<{
  messageIndex: number;
  searchCallId: string;
  output: { protocol: string; sessionId: string; matches: unknown[]; total?: number; more?: boolean };
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
      if (output?.protocol === MCP_DISCOVERY_PROTOCOL && output.sessionId === sessionId && Array.isArray(output.matches)) {
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
  registry.register<{ query: string; server?: string; limit: number; offset: number; reload: boolean }>({
    definition: { name: 'mcp_search', description: 'Find MCP tools by capability, server or exact name. Returns schemas for new/changed tools; unchanged tools already visible in this conversation return compact references. Reuse loaded tools with mcp_call across turns. Set reload to true for full schemas. The result includes a compact catalog; unloaded lists definitions that did not fit. Load one with its exact name, reload=true and limit=1. Use next_offset for more matches. Legacy archived results can be read with read_archived_tool_result. Search does not execute tools or grant permission.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, server: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10, default: 5 }, reload: { type: 'boolean', default: false }, offset: { type: 'integer', minimum: 0, default: 0 } }, required: ['query'], additionalProperties: false } },
    manifest, parallelSafe: true,
    decodeInput: input => {
      const value = input as Record<string, unknown>;
      if (!value || typeof value.query !== 'string' || !value.query.trim() || (value.server !== undefined && typeof value.server !== 'string') || (value.reload !== undefined && typeof value.reload !== 'boolean')) throw new Error('MCP search needs a non-empty query, optional server and boolean reload.');
      if (value.offset !== undefined && (!Number.isSafeInteger(value.offset) || Number(value.offset) < 0)) throw new Error('offset must be a nonnegative integer.');
      return { query: value.query.trim(), server: value.server as string | undefined, limit: Math.min(10, Math.max(1, Number(value.limit) || 5)), offset: Number(value.offset) || 0, reload: value.reload === true };
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
        const exact = [mcp.tool, definition.name].some(name => name.toLocaleLowerCase() === context.input.query.toLocaleLowerCase());
        const score = (exact ? terms.length + 1 : 0) + terms.reduce((sum, term) => sum + (text.includes(term) ? 1 : 0), 0);
        return score || context.input.server || context.input.query === '*' ? [{ definition, server: mcp.server, tool: mcp.tool, score }] : [];
      }).sort((a, b) => b.score - a.score || a.definition.name.localeCompare(b.definition.name));
      const loaded = loadedTools(registry, request);
      const matches = candidates.slice(context.input.offset, context.input.offset + context.input.limit).map(candidate => {
        const version = revision(registry, candidate.definition);
        const reference = { name: candidate.definition.name, server: candidate.server, tool: candidate.tool, revision: version };
        const alreadyLoaded = loaded.get(candidate.definition.name) === version;
        return !context.input.reload && alreadyLoaded ? { ...reference, loaded: true } : { ...candidate.definition, ...reference };
      });
      remember(registry, request, loaded);
      const next = context.input.offset + matches.length;
      return { protocol: MCP_DISCOVERY_PROTOCOL, sessionId: request.sessionId, matches, total: candidates.length,
        more: candidates.length > next, ...(candidates.length > next ? { next_offset: next } : {}) };
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
