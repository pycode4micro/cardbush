import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ModelMessage, ModelRequest, ToolDefinition } from '@cardbush/bush-protocol';
import type { ToolRegistry } from './toolRegistry.js';
import { toolSchemaReceipts } from './toolSchemaReceipts.js';

const protocol = 'bush.builtin_schema.v1';
const revision = (definition: ToolDefinition) => createHash('sha256').update(JSON.stringify(definition)).digest('hex');
const runFields: Record<string, string[]> = {
  subagent: ['action', 'prompt', 'agent_id', 'task_id', 'target_agent', 'mode', 'run_in_background'],
  team: ['action', 'team_id', 'run_id', 'input', 'section', 'query', 'offset', 'limit', 'yield_time_ms', 'node_ids'],
};

/** Provider presentation only: the authoritative scope and decoders are unchanged. */
export function projectBuiltinDefinitions(registry: ToolRegistry, request: ModelRequest, definitions: ToolDefinition[]) {
  if (!request.tools.some(tool => tool.name === 'get_tool_schema')) return definitions;
  const loaded = request.metadata.builtinToolSchemas as Record<string, string> | undefined;
  const replacements: Record<string, string> = { parallel_tools: 'run_tools', manage_tool_calls: 'tasks', await_subagents: 'tasks', solution_selection: 'request_user_input_async' };
  return definitions.filter(definition => {
    const replacement = replacements[definition.name], original = registry.resolve(definition.name)?.definition;
    return !replacement || !definitions.some(tool => tool.name === replacement) || original && loaded?.[definition.name] === revision(original);
  }).map(definition => {
    const original = registry.resolve(definition.name)?.definition;
    const fields = runFields[definition.name];
    if (!original || !fields || loaded?.[definition.name] === revision(original)) return definition;
    const properties = Object.fromEntries(Object.entries(definition.inputSchema.properties as Record<string, unknown> ?? {})
      .filter(([name]) => fields.includes(name) || name === '_display_title'));
    if (properties.action) properties.action = { type: 'string', enum: definition.name === 'subagent' ? ['run'] : ['list', 'get', 'run', 'status', 'wait', 'stop', 'resume'] };
    const description = definition.name === 'subagent'
      ? 'Dispatch a task with prompt; optionally use a saved agent_id or follow up with task_id. Returns a task handle. Continue independent work; use tasks to inspect or briefly wait when results are needed. For registering employees or configuring a new clean agent, load get_tool_schema(name="subagent") first.'
      : 'Find and run saved workflows. list/get discover teams; run starts independently. Use tasks to inspect/wait/stop a run; status/wait remain supported here. To save or delete workflow definitions, load get_tool_schema(name="team") first.';
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
        registration.sessionScope && registration.sessionScope !== context.sessionId) throw new Error('Built-in tool is not available in this conversation.');
      return { protocol, sessionId: context.sessionId, action: 'load', matches: [{ name: registration.definition.name, revision: revision(registration.definition), definition: registration.definition }] };
    },
  });
}
