import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ModelMessage, ModelRequest, ToolDefinition } from '@cardbush/bush-protocol';
import type { ToolRegistry } from './toolRegistry.js';
import { toolSchemaReceipts } from './toolSchemaReceipts.js';

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
  const disclose = exposed('get_tool_schema');
  const unified = exposed('tasks');
  const loaded = request.metadata.builtinToolSchemas as Record<string, string> | undefined;
  return definitions.filter(definition => {
    if (!available(request, definition.name)) return false;
    const replacement = replacements[definition.name], original = registry.resolve(definition.name)?.definition;
    return !disclose || !replacement || !exposed(replacement) || original && loaded?.[definition.name] === revision(original);
  }).map(candidate => {
    const definition = taskDescription(candidate, unified);
    const original = registry.resolve(definition.name)?.definition;
    const fields = runFields[definition.name];
    if (!disclose || !original || !fields || loaded?.[definition.name] === revision(original)) return definition;
    const properties = Object.fromEntries(Object.entries(definition.inputSchema.properties as Record<string, unknown> ?? {})
      .filter(([name]) => (fields.includes(name) || name === '_display_title') &&
        !(definition.name === 'team' && unified && ['yield_time_ms', 'node_ids'].includes(name))));
    if (properties.action) properties.action = { type: 'string', enum: definition.name === 'subagent' ? ['run']
      : unified ? ['list', 'get', 'run', 'resume'] : ['list', 'get', 'run', 'status', 'wait', 'stop', 'resume'] };
    const description = definition.name === 'subagent'
      ? `Dispatch prompt to a saved agent_id, plugin agent_type or a fork; follow up with task_id. Continue independent work; use ${taskManagementTool(request, 'await_subagents')} when results are needed. For employee registration or a new clean agent's configuration, load get_tool_schema(name="subagent").`
      : `Find saved workflows with list/get; run starts independently; resume retries unfinished nodes. ${unified ? 'Use tasks to inspect/wait/stop runs.' : 'Use status/wait/stop to observe or stop runs.'} For definitions or selected node outputs, load get_tool_schema(name="team").`;
    return { ...definition, description, inputSchema: { ...definition.inputSchema, properties } };
  });
}

/** Rebuild from actual delivered schemas, so compaction and new turns shrink the catalog again. */
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

export function registerBuiltinToolDisclosure(registry: ToolRegistry) {
  const schema = z.object({ name: z.string().min(1).max(200) }).strict();
  registry.register({
    definition: { name: 'get_tool_schema', description: 'Load one complete built-in tool definition for advanced configuration. Common subagent/Team calls already have compact schemas. This only explains parameters; it grants no permissions. For MCP tools use mcp_search.', inputSchema: z.toJSONSchema(schema) },
    manifest: { effect_kind: 'observation', operation: 'tools.schema', risk: 'low', owner: 'runtime', dispatch_scope: 'session', mutating: false },
    parallelSafe: true, decodeInput: value => schema.parse(value),
    execute: context => {
      const registration = registry.resolve(context.input.name);
      if (!registration || registration.mcpHook || !context.turn?.request.tools.some(tool => tool.name === context.input.name) ||
        !available(context.turn.request, context.input.name) ||
        registration.sessionScope && registration.sessionScope !== context.sessionId) throw new Error('Built-in tool is not available in this conversation.');
      return { protocol, sessionId: context.sessionId, action: 'load', matches: [{ name: registration.definition.name, revision: revision(registration.definition), definition: registration.definition }] };
    },
  });
}
