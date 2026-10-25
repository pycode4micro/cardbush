import { createHash } from 'node:crypto';
import { z } from 'zod';
import { toolDefinitionSchema, type ModelMessage, type ModelRequest, type ToolDefinition } from '@cardbush/bush-protocol';
import type { ToolRegistry } from './toolRegistry.js';
import { toolSchemaReceipts, TOOL_SCHEMA_PROTOCOL } from './toolSchemaReceipts.js';
import { withToolDisplayTitle } from './toolDisplay.js';
import { resolveToolReferenceName, unknownToolReferenceError } from './toolReferenceNames.js';
import { loadMcpToolSchema, mcpInvocationTarget, synchronizeMcpDiscovery } from './mcpToolDiscovery.js';

const protocol = TOOL_SCHEMA_PROTOCOL;
const revision = (definition: ToolDefinition) => createHash('sha256').update(JSON.stringify(definition)).digest('hex');
function available(registry: ToolRegistry, request: ModelRequest, name: string) {
  return registry.resolve(name)?.modelAvailable?.(request) !== false;
}

/** Bind presentation from each registration once; never refresh a frozen catalog. */
export function projectBuiltinDefinitions(registry: ToolRegistry, request: ModelRequest, definitions: ToolDefinition[]) {
  const hasTool = (name: string) => definitions.some(tool => tool.name === name);
  const scope = { hasTool, canRecall: hasTool('get_tool_schema') && hasTool('call_tool') };
  return definitions.flatMap(definition => {
    if (!available(registry, request, definition.name)) return [];
    const project = registry.resolve(definition.name)?.projectModelDefinition;
    const presented = project ? project(structuredClone(definition), scope) : definition;
    return presented ? [presented] : [];
  });
}

/** Rebuild invocation prerequisites from delivered results, never change provider declarations. */
export function synchronizeBuiltinSchemas(registry: ToolRegistry, request: ModelRequest, messages: ModelMessage[]) {
  const loaded: Record<string, string> = {};
  for (const { output } of toolSchemaReceipts(messages, request.sessionId, 'get_tool_schema', protocol)) {
    for (const candidate of output.matches) {
      const receipt = candidate as { name?: string; revision?: string; source?: string };
      if (receipt.source !== 'native') continue;
      const parsed = toolDefinitionSchema.safeParse(receipt);
      const definition = registry.resolve(receipt.name ?? '')?.definition;
      if (definition && request.tools.some(tool => tool.name === definition.name) && receipt.revision === revision(definition) &&
        parsed.success && JSON.stringify(parsed.data) === JSON.stringify(definition)) loaded[definition.name] = receipt.revision;
    }
  }
  request.metadata.builtinToolSchemas = loaded;
}

export function builtinSchemaRequiredError(name: string) {
  return Object.assign(new Error('Load the current definition with get_tool_schema, then call it through call_tool using the returned full arguments. No tool was executed.'), {
    code: 'builtin_schema_required',
    details: { toolName: name, load: { name: 'get_tool_schema', arguments: { name } } },
  });
}

/** A live extension can change while its provider declaration remains frozen. */
export function nativeToolSchemaIsCurrent(registry: ToolRegistry, request: ModelRequest, name: string): boolean {
  const registration = registry.resolve(name);
  if (!registration?.registrationOwner?.startsWith('extension:') || registration.mcpHook) return true;
  if (registration.deferredSchema) return (request.metadata.builtinToolSchemas as Record<string, string> | undefined)?.[name] === revision(registration.definition);
  const snapshot = request.metadata.mcpModelToolSnapshot as { tools?: ToolDefinition[] } | undefined;
  if (!snapshot?.tools) return true;
  const declared = snapshot.tools.find(tool => tool.name === name);
  return !!declared && revision(declared) === revision(withToolDisplayTitle(registration.definition)) ||
    (request.metadata.builtinToolSchemas as Record<string, string> | undefined)?.[name] === revision(registration.definition);
}

/** Discovery may describe direct entry points; invocation must not wrap them. */
export function nativeToolInvocation(registry: ToolRegistry, name: string, request?: ModelRequest) {
  return registry.resolve(name)?.forwardToolCall || registry.resolve(name)?.directInvocation || request && !request.tools.some(tool => tool.name === 'call_tool')
    ? { tool: name, arguments: 'Use the loaded inputSchema fields directly. Do not wrap this call in call_tool.' }
    : { tool: 'call_tool', arguments: { name, arguments: 'Use the loaded inputSchema fields here.' } };
}

function callableDefinition(registry: ToolRegistry, request: ModelRequest | undefined, name: string, discovery = false) {
  const registration = registry.resolve(name);
  if (!registration) throw unknownToolReferenceError(name, 'native');
  if (!request || !request.tools.some(tool => tool.name === name) || registration.mcpHook?.modelVisible === false ||
    !available(registry, request, name) || registration.sessionScope && registration.sessionScope !== request.sessionId) {
    throw Object.assign(new Error('This tool is not available to this turn. Loading a schema grants no access.'), { code: 'tool_not_exposed' });
  }
  if (!discovery && (registration.forwardToolCall || registry.resolve(name)?.directInvocation)) {
    throw Object.assign(new Error(`Call ${name} directly using its declared schema. Do not put it inside call_tool.`), {
      code: 'tool_requires_direct_call', details: { invocation: nativeToolInvocation(registry, name), definition: registration.definition },
    });
  }
  return registration.definition;
}

export function registerBuiltinToolDisclosure(registry: ToolRegistry) {
  const schema = z.object({
    name: z.string().min(1).optional(),
    names: z.array(z.string().min(1)).min(1).max(16).optional(),
  }).strict().refine(value => (value.name !== undefined) !== (value.names !== undefined), 'Provide name or names, not both.');
  registry.register({
    directInvocation: true,
    definition: { name: 'get_tool_schema', description: 'Load complete current tool definitions: name for one exact native/MCP name, or names for up to 16. Read the returned schemas before calling call_tool({name, arguments}); direct controls use their returned invocation. Use mcp_search only to discover names. Batch errors are per name; deferred definitions still need loading, and oversized schemas require a complete archive read. Loading executes no target and grants no permissions.', inputSchema: z.toJSONSchema(schema, { io: 'input' }) },
    manifest: { effect_kind: 'observation', operation: 'tools.schema', risk: 'low', owner: 'runtime', dispatch_scope: 'session', mutating: false },
    parallelSafe: true, decodeInput: value => schema.parse(value),
    execute: context => {
      const matches = [], errors = [];
      let hostCapabilities;
      for (const reference of new Set(context.input.names ?? [context.input.name!])) {
        try {
          const definition = callableDefinition(registry, context.turn?.request, resolveToolReferenceName(reference, context.turn), true);
          const loaded = registry.resolve(definition.name)?.mcpHook ? loadMcpToolSchema(registry, context.turn!.request, definition.name) : undefined;
          if (loaded?.hostCapabilities) hostCapabilities = loaded.hostCapabilities;
          matches.push(loaded ? { ...loaded.matches[0]!, invocation: loaded.invocation } : {
            ...definition, source: 'native', revision: revision(definition), invocation: nativeToolInvocation(registry, definition.name, context.turn?.request),
          });
        } catch (error) {
          if (!context.input.names) throw error;
          errors.push({ name: reference, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return { protocol, sessionId: context.sessionId, action: 'load', matches,
        ...(matches.length === 1 ? { invocation: matches[0]!.invocation } : {}), ...(errors.length ? { errors } : {}), ...(hostCapabilities ? { hostCapabilities } : {}) };
    },
  });
  const callSchema = z.object({ name: z.string().min(1).max(200), arguments: z.record(z.string(), z.unknown()) }).strict();
  registry.register({
    definition: { name: 'call_tool', description: 'Invoke a native or MCP business tool. Use the exact target name and put its fields inside arguments. First read its full current schema from get_tool_schema; reuse it while it remains in context. The target keeps its permissions, hooks, resource locks, cancellation and result handling. Never wrap call_tool, discovery or context-maintenance entry points.', inputSchema: z.toJSONSchema(callSchema) },
    manifest: { effect_kind: 'observation', operation: 'tools.invoke', risk: 'low', owner: 'runtime', dispatch_scope: 'session', mutating: false },
    delegatesToolExecution: true, nestedCallable: false,
    decodeInput: value => callSchema.parse(value),
    forwardToolCall: context => {
      const name = resolveToolReferenceName(context.input.name, context.turn);
      let definition: ToolDefinition;
      try { definition = callableDefinition(registry, context.turn?.request, name); }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error &&
          error.code === 'tool_requires_direct_call') {
          const failure = error as Error & { code: string; details: Record<string, unknown> };
          failure.details = { ...failure.details, corrected_call: { name, arguments: context.input.arguments },
            note: 'This is a suggested call only. No target was executed; schema loading, scope, permissions and Hooks still apply.' };
        }
        throw error;
      }
      synchronizeMcpDiscovery(registry, context.turn!.request, context.turn!.contextMessages);
      if (registry.resolve(name)?.mcpHook) mcpInvocationTarget(registry, context.turn, name);
      else if ((context.turn!.request.metadata.builtinToolSchemas as Record<string, string>)[definition.name] !== revision(definition)) throw builtinSchemaRequiredError(definition.name);
      return { name: definition.name, input: context.input.arguments };
    },
    execute: () => { throw new Error('call_tool must use the shared Tool execution coordinator.'); },
  });
}
