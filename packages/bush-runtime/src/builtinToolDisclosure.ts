import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ModelMessage, ModelRequest, ToolDefinition } from '@cardbush/bush-protocol';
import type { ToolRegistry } from './toolRegistry.js';
import { toolSchemaReceipts } from './toolSchemaReceipts.js';
import { withToolDisplayTitle } from './toolDisplay.js';

const protocol = 'bush.builtin_schema.v1';
const revision = (definition: ToolDefinition) => createHash('sha256').update(JSON.stringify(definition)).digest('hex');
const runFields: Record<string, string[]> = {
  subagent: ['action', 'prompt', 'agent_id', 'agent_type', 'task_id', 'target_agent', 'mode', 'run_in_background'],
  team: ['action', 'team_id', 'run_id', 'input', 'section', 'query', 'offset', 'limit', 'yield_time_ms', 'node_ids'],
};
const replacements: Record<string, string> = {
  parallel_tools: 'run_tools', manage_tool_calls: 'tasks', manage_plugin_agents: 'tasks',
  await_subagents: 'tasks', solution_selection: 'request_user_input_async',
};
const commandTools = new Set(['list_plugin_commands', 'run_plugin_command']);
// These calls are recognized at their own history boundary by discovery and
// context maintenance. Keep their declared entry points and receipt identities.
const directTools = new Set(['get_tool_schema', 'mcp_search', 'mcp_call', 'read_archived_tool_result', 'checkpoint_context', 'summary_for_user']);

function available(request: ModelRequest, name: string) {
  // Unknown capability state is not evidence of an empty catalog. Never hide Skills here.
  return !commandTools.has(name) || request.metadata.builtinPluginCommandsAvailable !== false;
}

/** Return guidance for the caller's actual catalog, including restricted/legacy hosts. */
export function taskManagementTool(request: ModelRequest | undefined, fallback: string) {
  return request?.tools.some(tool => tool.name === 'tasks') ? 'tasks' : fallback;
}

function taskDescription(definition: ToolDefinition, unified: boolean): ToolDefinition {
  if (!unified) return definition;
  // Only descriptions authored by these built-ins need compatibility-name rewriting.
  // Keep native schemas, parameter names and extension-authored text unchanged.
  if (!['terminal_exec', 'terminal_poll', 'start_mcp_tool', 'subagent'].includes(definition.name)) return definition;
  return { ...definition, description: definition.description.replace(/\b(manage_tool_calls|manage_plugin_agents|await_subagents)\b/g, 'tasks') };
}

/** Provider presentation only: the authoritative scope and decoders are unchanged. */
export function projectBuiltinDefinitions(registry: ToolRegistry, request: ModelRequest, definitions: ToolDefinition[]) {
  // Forks share a stable provider prefix with their parent. Execution-time child
  // restrictions must not rewrite that prefix; explicitly scoped catalogs still
  // retain a legacy entry when their replacement is absent.
  const exposed = (name: string) => definitions.some(tool => tool.name === name);
  const disclose = exposed('get_tool_schema') && exposed('call_tool');
  const unified = exposed('tasks');
  return definitions.filter(definition => {
    if (!available(request, definition.name)) return false;
    const replacement = replacements[definition.name];
    return !disclose || !replacement || !exposed(replacement);
  }).map(candidate => {
    const definition = taskDescription(candidate, unified);
    const original = registry.resolve(definition.name)?.definition;
    const fields = runFields[definition.name];
    if (!disclose || !original || !fields) return definition;
    const properties = Object.fromEntries(Object.entries(definition.inputSchema.properties as Record<string, unknown> ?? {})
      .filter(([name]) => (fields.includes(name) || name === '_display_title') &&
        !(definition.name === 'team' && unified && ['yield_time_ms', 'node_ids'].includes(name))));
    if (properties.action) properties.action = { type: 'string', enum: definition.name === 'subagent' ? ['run']
      : unified ? ['list', 'get', 'run', 'resume'] : ['list', 'get', 'run', 'status', 'wait', 'stop', 'resume'] };
    const description = definition.name === 'subagent'
      ? `Dispatch prompt to a saved agent_id, plugin agent_type or a fork; follow up with task_id. Continue independent work; use ${taskManagementTool(request, 'await_subagents')} when results are needed. For employee registration or a new clean agent's configuration, load get_tool_schema(name="subagent"), then use call_tool with its full arguments.`
      : `Find saved workflows with list/get; run starts independently; resume retries unfinished nodes. ${unified ? 'Use tasks to inspect/wait/stop runs.' : 'Use status/wait/stop to observe or stop runs.'} For definitions or selected node outputs, load get_tool_schema(name="team"), then use call_tool with its full arguments.`;
    return { ...definition, description, inputSchema: { ...definition.inputSchema, properties } };
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
  const snapshot = request.metadata.mcpModelToolSnapshot as { tools?: ToolDefinition[] } | undefined;
  if (!snapshot?.tools) return true;
  const declared = snapshot.tools.find(tool => tool.name === name);
  return !!declared && revision(declared) === revision(withToolDisplayTitle(registration.definition)) ||
    (request.metadata.builtinToolSchemas as Record<string, string> | undefined)?.[name] === revision(registration.definition);
}

function callableDefinition(registry: ToolRegistry, request: ModelRequest | undefined, name: string) {
  const registration = registry.resolve(name);
  if (!request || !registration || registration.mcpHook || !request.tools.some(tool => tool.name === name) ||
    !available(request, name) || registration.sessionScope && registration.sessionScope !== request.sessionId) {
    throw Object.assign(new Error('This native tool is not available to this turn. Loading a schema grants no access.'), { code: 'tool_not_exposed' });
  }
  if (registration.forwardToolCall || directTools.has(name)) {
    throw Object.assign(new Error(`Call ${name} directly using its declared schema.`), { code: 'tool_requires_direct_call' });
  }
  return registration.definition;
}

export function registerBuiltinToolDisclosure(registry: ToolRegistry) {
  const schema = z.object({ name: z.string().min(1).max(200) }).strict();
  registry.register({
    definition: { name: 'get_tool_schema', description: 'Load the complete definition of a native tool for advanced configuration or a newly available extension. The schema is returned only in this result; top-level tools stay unchanged. Use call_tool with the loaded name and full arguments. Common subagent/Team calls remain directly callable. This grants no permissions. For MCP tools use mcp_search and mcp_call.', inputSchema: z.toJSONSchema(schema) },
    manifest: { effect_kind: 'observation', operation: 'tools.schema', risk: 'low', owner: 'runtime', dispatch_scope: 'session', mutating: false },
    parallelSafe: true, decodeInput: value => schema.parse(value),
    execute: context => {
      const definition = callableDefinition(registry, context.turn?.request, context.input.name);
      return { protocol, sessionId: context.sessionId, action: 'load', matches: [{ name: definition.name, revision: revision(definition), definition }],
        invocation: { tool: 'call_tool', name: definition.name, arguments: 'Use the fields described by definition.inputSchema inside arguments.' } };
    },
  });
  const callSchema = z.object({ name: z.string().min(1).max(200), arguments: z.record(z.string(), z.unknown()) }).strict();
  registry.register({
    definition: { name: 'call_tool', description: 'Call a native tool using the full schema returned by get_tool_schema. Pass its exact name and fields inside arguments. Reuse a loaded definition while it remains in context; reload after a definition change or compaction. Uses the selected tool\'s ordinary execution, permissions, hooks, cancellation and result handling. For MCP tools use mcp_call.', inputSchema: z.toJSONSchema(callSchema) },
    manifest: { effect_kind: 'observation', operation: 'tools.invoke', risk: 'low', owner: 'runtime', dispatch_scope: 'session', mutating: false },
    delegatesToolExecution: true, nestedCallable: false,
    decodeInput: value => callSchema.parse(value),
    forwardToolCall: context => {
      const definition = callableDefinition(registry, context.turn?.request, context.input.name);
      synchronizeBuiltinSchemas(registry, context.turn!.request, context.turn!.contextMessages);
      if ((context.turn!.request.metadata.builtinToolSchemas as Record<string, string>)[definition.name] !== revision(definition)) throw builtinSchemaRequiredError(definition.name);
      return { name: definition.name, input: context.input.arguments };
    },
    execute: () => { throw new Error('call_tool must use the shared Tool execution coordinator.'); },
  });
}
