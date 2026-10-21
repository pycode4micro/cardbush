import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ModelMessage, ModelRequest, ToolDefinition } from '@cardbush/bush-protocol';
import type { ToolRegistry } from './toolRegistry.js';
import { toolSchemaReceipts } from './toolSchemaReceipts.js';
import { withToolDisplayTitle } from './toolDisplay.js';
import { resolveToolReferenceName, unknownToolReferenceError, wrongToolRouteError } from './toolReferenceNames.js';

const protocol = 'bush.builtin_schema.v1';
const revision = (definition: ToolDefinition) => createHash('sha256').update(JSON.stringify(definition)).digest('hex');
function available(registry: ToolRegistry, request: ModelRequest, name: string) {
  return registry.resolve(name)?.modelAvailable?.(request) !== false;
}

/** Return guidance for the caller's actual catalog, including restricted/legacy hosts. */
export function taskManagementTool(request: ModelRequest | undefined, fallback: string) {
  return request?.tools.some(tool => tool.name === 'tasks') ? 'tasks' : fallback;
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
      const receipt = candidate as { name?: string; revision?: string; definition?: ToolDefinition };
      const definition = registry.resolve(receipt.name ?? '')?.definition;
      if (definition && request.tools.some(tool => tool.name === definition.name) && receipt.revision === revision(definition) &&
        JSON.stringify(receipt.definition) === JSON.stringify(definition)) loaded[definition.name] = receipt.revision;
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
    ? { tool: name, arguments: 'Use definition.inputSchema fields directly. Do not wrap this call in call_tool.' }
    : { tool: 'call_tool', arguments: { name, arguments: 'Use definition.inputSchema fields here.' } };
}

function callableDefinition(registry: ToolRegistry, request: ModelRequest | undefined, name: string, discovery = false) {
  const registration = registry.resolve(name);
  if (!registration) throw unknownToolReferenceError(name, 'native');
  if (!request || !request.tools.some(tool => tool.name === name) || registration.mcpHook?.modelVisible === false ||
    !available(registry, request, name) || registration.sessionScope && registration.sessionScope !== request.sessionId) {
    throw Object.assign(new Error('This native tool is not available to this turn. Loading a schema grants no access.'), { code: 'tool_not_exposed' });
  }
  if (registration.mcpHook) throw wrongToolRouteError(name, 'mcp');
  if (!discovery && (registration.forwardToolCall || registry.resolve(name)?.directInvocation)) {
    throw Object.assign(new Error(`Call ${name} directly using its declared schema. Do not put it inside call_tool.`), {
      code: 'tool_requires_direct_call', details: { invocation: nativeToolInvocation(registry, name), definition: registration.definition },
    });
  }
  return registration.definition;
}

export function registerBuiltinToolDisclosure(registry: ToolRegistry) {
  const schema = z.object({ name: z.string().min(1).max(200) }).strict();
  registry.register({
    directInvocation: true,
    definition: { name: 'get_tool_schema', description: 'Load the complete definition and invocation route of a native tool, including direct entry points such as mcp_call. Follow the returned invocation: some tools must be called directly, others through call_tool. Top-level tools stay unchanged. Common subagent/Team calls remain directly callable. This grants no permissions. For MCP target schemas use mcp_search.', inputSchema: z.toJSONSchema(schema) },
    manifest: { effect_kind: 'observation', operation: 'tools.schema', risk: 'low', owner: 'runtime', dispatch_scope: 'session', mutating: false },
    parallelSafe: true, decodeInput: value => schema.parse(value),
    execute: context => {
      const definition = callableDefinition(registry, context.turn?.request, resolveToolReferenceName(context.input.name, context.turn), true);
      return { protocol, sessionId: context.sessionId, action: 'load', matches: [{ name: definition.name, revision: revision(definition), definition }],
        invocation: { ...nativeToolInvocation(registry, definition.name, context.turn?.request), name: definition.name } };
    },
  });
  const callSchema = z.object({ name: z.string().min(1).max(200), arguments: z.record(z.string(), z.unknown()) }).strict();
  registry.register({
    definition: { name: 'call_tool', description: 'Call a native tool using the full schema returned by get_tool_schema. Pass its exact name and fields inside arguments. Reuse a loaded definition while it remains in context; reload after a definition change or compaction. Uses the selected tool\'s ordinary execution, permissions, hooks, cancellation and result handling. For MCP tools use mcp_call.', inputSchema: z.toJSONSchema(callSchema) },
    manifest: { effect_kind: 'observation', operation: 'tools.invoke', risk: 'low', owner: 'runtime', dispatch_scope: 'session', mutating: false },
    delegatesToolExecution: true, nestedCallable: false,
    decodeInput: value => callSchema.parse(value),
    forwardToolCall: context => {
      const name = resolveToolReferenceName(context.input.name, context.turn);
      let definition: ToolDefinition;
      try { definition = callableDefinition(registry, context.turn?.request, name); }
      catch (error) {
        if (error && typeof error === 'object' && 'code' in error &&
          ['tool_requires_direct_call', 'tool_route_mismatch'].includes(String(error.code))) {
          const failure = error as Error & { code: string; details: Record<string, unknown> };
          failure.details = { ...failure.details, corrected_call: failure.code === 'tool_requires_direct_call'
            ? { name, arguments: context.input.arguments }
            : { name: 'mcp_call', arguments: { name, arguments: context.input.arguments } },
            note: 'This is a suggested call only. No target was executed; schema loading, scope, permissions and Hooks still apply.' };
        }
        throw error;
      }
      synchronizeBuiltinSchemas(registry, context.turn!.request, context.turn!.contextMessages);
      if ((context.turn!.request.metadata.builtinToolSchemas as Record<string, string>)[definition.name] !== revision(definition)) throw builtinSchemaRequiredError(definition.name);
      return { name: definition.name, input: context.input.arguments };
    },
    execute: () => { throw new Error('call_tool must use the shared Tool execution coordinator.'); },
  });
}
