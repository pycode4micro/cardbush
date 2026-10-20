import { createHash } from 'node:crypto';
import type { ModelRequest, UsageCapability } from '@cardbush/bush-protocol';
import type { ToolRegistry } from './toolRegistry.js';
import { nativeToolInvocation } from './builtinToolDisclosure.js';
import { mcpToolInvocation } from './mcpToolDiscovery.js';
import { rankMcpTools } from './mcpToolSearch.js';

export function usageAvailableTools(registry: ToolRegistry, request: ModelRequest | undefined) {
  const exposed = new Set(request?.tools.map(item => item.name) ?? []);
  return registry.definitions().filter(definition => {
    const tool = registry.resolve(definition.name)!;
    return exposed.has(definition.name) && tool.mcpHook?.modelVisible !== false && (!tool.sessionScope || tool.sessionScope === request?.sessionId);
  });
}

/** Names are discovered from the student's catalog, never inferred authority. */
export function usageToolHint(registry: ToolRegistry, request: ModelRequest | undefined, capability: { tool: string; purpose: string }, available?: ReadonlySet<string>) {
  const name = capability.tool, registration = registry.resolve(name);
  if (!registration || !(available ?? new Set(usageAvailableTools(registry, request).map(item => item.name))).has(name)) return { ...capability, available: false,
    note: 'Not available in this turn. Observe the current catalog; choose an available alternative or explain the dependency.' };
  const loader = registration.mcpHook ? 'mcp_search' : 'get_tool_schema';
  const invocation = registration.mcpHook ? mcpToolInvocation(request!, name) : nativeToolInvocation(registry, name, request);
  const load = invocation.tool !== name && request?.tools.some(tool => tool.name === loader)
    ? { name: loader, arguments: registration.mcpHook ? { action: 'load', query: name } : { name } } : undefined;
  return { ...capability, available: true, schema_revision: createHash('sha256').update(JSON.stringify(registration.definition)).digest('hex').slice(0, 16),
    description: registration.definition.description.slice(0, 120), invocation,
    ...(load ? { load, note: 'Load only if the current schema is missing or changed. This hint does not mark it as loaded.' }
      : { note: 'Use the current exposed schema and ordinary invocation route.' }) };
}

export function recommendUsageCapability(registry: ToolRegistry, request: ModelRequest | undefined, capability: UsageCapability) {
  const definitions = usageAvailableTools(registry, request), available = new Set(definitions.map(item => item.name));
  const searchName = capability.kind === 'skill' ? 'search_skills' : 'mcp_search';
  const discovery = available.has(searchName)
    ? { tool: searchName, arguments: { ...(capability.kind === 'tool' ? { action: 'search' } : {}), query: capability.query } } : null;
  const candidates = capability.kind === 'skill' ? [] : rankMcpTools(definitions
    .map(definition => { const hook = registry.resolve(definition.name)?.mcpHook;
      return { definition, server: hook?.server ?? '', tool: hook?.tool ?? definition.name }; }), capability.query)
    .slice(0, 4).map(item => usageToolHint(registry, request, { tool: item.definition.name, purpose: capability.purpose }, available));
  return { capability, candidates, discovery,
    note: 'Candidates are keyword-ranked suggestions from the current scope, not semantic proof of compatibility or automatic bindings. Inspect their current schemas and the capability contract, then choose a suitable implementation. Skill recommendations must be discovered/read normally. No plugin or Skill name is required by this recommendation; no tool was loaded or executed.' };
}
