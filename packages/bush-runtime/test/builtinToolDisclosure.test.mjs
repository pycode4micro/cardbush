import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { InMemoryRuntimeHost, ToolRegistry, ToolExecutionCoordinator } from '../dist/index.js';
import { registerBuiltinToolDisclosure, synchronizeBuiltinSchemas } from '../dist/builtinToolDisclosure.js';
import { modelToolDefinitions } from '../dist/mcpToolDiscovery.js';
import { toolDefinitionUsage } from '../dist/toolDefinitionUsage.js';

const manifest = { effect_kind: 'observation', operation: 'fixture', risk: 'low', owner: 'runtime', dispatch_scope: 'session', mutating: false };
function fixture(names) {
  const registry = new ToolRegistry();
  for (const name of names) registry.register({ definition: { name, description: `Inspect ${name}`, inputSchema: {
    type: 'object', properties: {}, additionalProperties: false } }, manifest, decodeInput: x => x, execute: () => ({ inspected: name }) });
  registerBuiltinToolDisclosure(registry);
  const request = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture',
    tools: registry.definitions(), messages: [], permissionMode: 'all_free', metadata: {} };
  const coordinator = new ToolExecutionCoordinator({ registry }); let ordinal = 0;
  const messages = [];
  const run = (name, args = {}) => coordinator.execute({ protocol: 'bush.tool_call.v1', id: `c${++ordinal}`, name, argumentsText: JSON.stringify(args) },
    { requestId: 'r', sessionId: 's', turnId: 't', round: 1, ordinal }, undefined, { request, contextMessages: messages });
  const load = async name => {
    const outcome = await run('get_tool_schema', { name }); assert.equal(outcome.kind, 'returned', JSON.stringify(outcome));
    const id = `load-${ordinal}`;
    messages.push({ role: 'assistant', content: '', toolCalls: [{ id, name: 'get_tool_schema', argumentsText: JSON.stringify({ name }) }] },
      { role: 'tool', toolCallId: id, content: JSON.stringify(outcome.result) });
    synchronizeBuiltinSchemas(registry, request, messages);
    return outcome.result;
  };
  return { registry, request, messages, run, load, definitions: () => modelToolDefinitions(registry, request) };
}

test('default entry points converge without removing native handlers, plans or small low-frequency tools', async () => {
  const f = fixture(['tasks', 'manage_plugin_agents', 'manage_tool_calls', 'await_subagents', 'run_tools', 'parallel_tools',
    'request_user_input_async', 'solution_selection', 'update_task_plan', 'terminal_list', 'read_file_memos', 'mcp_app_status']);
  const original = structuredClone(f.request.tools);
  const legacy = ['manage_plugin_agents', 'manage_tool_calls', 'await_subagents', 'parallel_tools', 'solution_selection'];
  const names = f.definitions().map(tool => tool.name);
  for (const name of legacy) assert.ok(!names.includes(name), name);
  for (const name of ['update_task_plan', 'terminal_list', 'read_file_memos', 'mcp_app_status']) assert.ok(names.includes(name), name);
  assert.deepEqual(f.request.tools, original); assert.deepEqual(f.registry.definitions(), original);
  assert.equal((await f.run('manage_plugin_agents')).result.inspected, 'manage_plugin_agents', 'saved/internal calls retain their native executor');
  f.registry.resolve('manage_plugin_agents').authorize = () => ({ kind: 'deny', code: 'fixture_denied', message: 'Denied' });
  assert.equal((await f.run('manage_plugin_agents')).error.code, 'fixture_denied', 'hiding never skips admission');
  await f.load('manage_plugin_agents');
  assert.deepEqual(f.definitions().map(tool => tool.name), names, 'loading never adds a top-level schema');
  assert.equal((await f.run('call_tool', { name: 'manage_plugin_agents', arguments: {} })).error.code, 'fixture_denied');
  delete f.registry.resolve('manage_plugin_agents').authorize;
  assert.equal((await f.run('call_tool', { name: 'manage_plugin_agents', arguments: {} })).result.inspected, 'manage_plugin_agents');
  f.messages.length = 0;
  synchronizeBuiltinSchemas(f.registry, f.request, []);
  assert.deepEqual(f.definitions().map(tool => tool.name), names, 'compaction does not change declarations');
  assert.equal((await f.run('call_tool', { name: 'manage_plugin_agents', arguments: {} })).error.code, 'builtin_schema_required');
});

test('scoped catalogs keep compatibility tools when a replacement or the schema loader is unavailable', async () => {
  const f = fixture(['manage_plugin_agents']);
  assert.ok(f.definitions().some(tool => tool.name === 'manage_plugin_agents'));
  const restricted = fixture(['tasks', 'manage_plugin_agents']);
  restricted.request.metadata = { agentRole: 'child', disabledTools: [], childToolAllowlist: ['manage_plugin_agents', 'get_tool_schema'] };
  restricted.request.tools = restricted.request.tools.filter(tool => restricted.request.metadata.childToolAllowlist.includes(tool.name));
  assert.ok(restricted.definitions().some(tool => tool.name === 'manage_plugin_agents'), 'a scoped-out tasks tool cannot replace an allowed legacy tool');
  assert.equal((await restricted.run('tasks')).error.code, 'tool_not_exposed');
  assert.equal((await restricted.run('manage_plugin_agents')).kind, 'returned');
  const noLoader = fixture(['tasks', 'manage_plugin_agents']);
  noLoader.request.tools = noLoader.request.tools.filter(tool => tool.name !== 'get_tool_schema');
  assert.ok(noLoader.definitions().some(tool => tool.name === 'manage_plugin_agents'));
  const unavailable = fixture(['tasks']);
  assert.equal((await unavailable.run('get_tool_schema', { name: 'manage_plugin_agents' })).kind, 'failed');
});

test('common Team calls use tasks, selected node outputs stay loadable, and plugin roles need no advanced load', async () => {
  const f = fixture(['tasks', 'team', 'subagent']);
  const team = f.registry.resolve('team').definition, subagent = f.registry.resolve('subagent').definition;
  team.inputSchema.properties = Object.fromEntries(['action', 'team_id', 'run_id', 'input', 'yield_time_ms', 'node_ids', 'definition'].map(name => [name, { type: 'string' }]));
  subagent.inputSchema.properties = Object.fromEntries(['action', 'prompt', 'agent_id', 'agent_type', 'system_prompt', 'settings'].map(name => [name, { type: 'string' }]));
  f.request.tools = f.registry.definitions();
  let definitions = f.definitions();
  assert.deepEqual(definitions.find(tool => tool.name === 'team').inputSchema.properties.action.enum, ['list', 'get', 'run', 'resume']);
  assert.ok(!definitions.find(tool => tool.name === 'team').inputSchema.properties.node_ids);
  assert.ok(definitions.find(tool => tool.name === 'subagent').inputSchema.properties.agent_type);
  const receipt = await f.load('team');
  assert.ok(receipt.matches[0].definition.inputSchema.properties.node_ids);
  assert.ok(receipt.matches[0].definition.inputSchema.properties.definition);
  assert.equal(receipt.invocation.tool, 'call_tool');
  assert.deepEqual(f.definitions(), definitions, 'advanced arguments are delivered only in the result');
  f.request = { ...f.request, turnId: 'restricted', metadata: {}, tools: f.request.tools.filter(tool => tool.name !== 'tasks') };
  definitions = modelToolDefinitions(f.registry, f.request);
  assert.ok(definitions.find(tool => tool.name === 'team').inputSchema.properties.action.enum.includes('wait'));
  assert.ok(definitions.find(tool => tool.name === 'team').inputSchema.properties.node_ids);
});

test('task guidance matches the exposed interface without altering parameter or native schema names', () => {
  const f = fixture(['tasks', 'terminal_exec', 'terminal_poll', 'start_mcp_tool']);
  for (const name of ['terminal_exec', 'terminal_poll', 'start_mcp_tool']) f.registry.resolve(name).definition.description = 'Wait with manage_tool_calls.';
  f.request.tools = f.registry.definitions();
  for (const definition of f.definitions().filter(tool => ['terminal_exec', 'terminal_poll', 'start_mcp_tool'].includes(tool.name))) assert.match(definition.description, /Wait with tasks/);
  assert.match(f.registry.resolve('terminal_exec').definition.description, /manage_tool_calls/);
  const scoped = { ...f.request, turnId: 'no-tasks', metadata: {}, tools: f.request.tools.filter(tool => tool.name !== 'tasks') };
  assert.match(modelToolDefinitions(f.registry, scoped).find(tool => tool.name === 'terminal_exec').description, /manage_tool_calls/);
});

test('only confirmed empty plugin command catalogs hide command tools; Skills and native scope remain intact', async () => {
  const f = fixture(['list_plugin_commands', 'run_plugin_command', 'run_skill']);
  f.request.metadata.builtinPluginCommandsAvailable = false;
  const visible = f.definitions();
  assert.ok(!f.definitions().some(tool => tool.name === 'list_plugin_commands' || tool.name === 'run_plugin_command'));
  assert.ok(f.definitions().some(tool => tool.name === 'run_skill'));
  assert.equal((await f.run('get_tool_schema', { name: 'run_plugin_command' })).kind, 'failed');
  assert.equal((await f.run('list_plugin_commands')).kind, 'returned', 'presentation is not an execution permission');
  f.request.metadata.builtinPluginCommandsAvailable = true;
  assert.deepEqual(f.definitions(), visible, 'hot enable keeps the frozen names/order/schemas');
  await f.load('list_plugin_commands');
  assert.equal((await f.run('call_tool', { name: 'list_plugin_commands', arguments: {} })).kind, 'returned');
  delete f.request.metadata.builtinPluginCommandsAvailable;
  assert.deepEqual(f.definitions(), visible, 'a temporary capability observation does not rewrite the prefix');
});

test('definition diagnostics measure the sent projection and retain only names and sizes', () => {
  const f = fixture(['read_file', 'update_task_plan', 'extension_tool']);
  f.registry.resolve('extension_tool').registrationOwner = 'extension:fixture';
  const definitions = f.definitions(), usage = toolDefinitionUsage(f.registry, definitions);
  assert.equal(usage.count, definitions.length);
  assert.equal(usage.chars, JSON.stringify(definitions).length);
  assert.equal(usage.estimatedTokens, Math.ceil(usage.chars / 4));
  assert.equal(usage.builtinCount, definitions.length - 1);
  assert.equal(usage.descriptionChars, definitions.reduce((sum, tool) => sum + tool.description.length, 0));
  assert.equal(usage.schemaChars, definitions.reduce((sum, tool) => sum + JSON.stringify(tool.inputSchema).length, 0));
  assert.doesNotMatch(JSON.stringify(usage), /Inspect |inputSchema|_display_title/);
  assert.equal(toolDefinitionUsage(f.registry, []).estimatedTokens, 0);
});

test('real model rounds follow plugin capability changes and persist actual tool sizes without extra model context', async t => {
  const root = mkdtempSync(join(tmpdir(), 'cardbush-tool-presentation-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-tool-presentation-')); rmSync(root, { recursive: true, force: true }); });
  let commands = [], dispatches = 0; const requests = [], registry = new ToolRegistry();
  registry.register({ definition: { name: 'fixture_next', description: 'Advance fixture', inputSchema: { type: 'object' } }, manifest, decodeInput: x => x,
    execute: () => { commands = ++dispatches === 1 ? [{ id: 'fixture:hello', name: 'hello', pluginId: 'fixture', root, description: 'Say hello', argumentHint: '', prompt: 'Hello', userInvocable: true, disableModelInvocation: false }] : []; return { done: true }; } });
  const host = new InMemoryRuntimeHost({ dataRoot: root, toolRegistry: registry, loadPluginExtensions: async () => ({ hooks: [], agents: [], commands }),
    provider: { async *stream(request) {
      requests.push(request);
      const event = (sequence, kind, extra) => ({ protocol: 'bush.model_event.v1', requestId: request.requestId, sequence, kind, createdAt: new Date().toISOString(), ...extra });
      if (requests.length <= 2) {
        yield event(0, 'tool_call_delta', { index: 0, toolCallId: `c-${requests.length}`, nameDelta: 'fixture_next', argumentsDelta: '{}' });
        yield event(1, 'response_completed', { finishReason: 'tool_calls' });
      } else {
        yield event(0, 'text_delta', { delta: 'Done' }); yield event(1, 'response_completed', { finishReason: 'stop' });
      }
    } } });
  const terminal = await host.runModelTurn({ protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture',
    messages: [{ role: 'user', content: 'private fixture request' }], tools: registry.definitions(), permissionMode: 'all_free', metadata: { workspaceDir: root } });
  assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal));
  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(request => request.tools.some(tool => tool.name === 'run_plugin_command')), [false, false, false]);
  assert.ok(requests.every(request => JSON.stringify(request.tools) === JSON.stringify(requests[0].tools)), 'hot reload does not rewrite the prefix');
  assert.ok(requests.every(request => request.tools.some(tool => tool.name === 'run_skill')));
  assert.ok(requests.every(request => !request.tools.some(tool => tool.name === 'manage_plugin_agents')));
  assert.ok(requests.every(request => request.tools.some(tool => tool.name === 'update_task_plan')));
  assert.ok(registry.resolve('run_plugin_command') && registry.resolve('manage_plugin_agents'));
  const observations = host.events('s', 't').filter(event => event.kind === 'cache_chain_observed');
  assert.equal(observations.length, 3);
  assert.ok(observations.every(event => !event.payload.frozenPrefixBreak));
  for (let index = 0; index < requests.length; index++) {
    assert.deepEqual(observations[index].payload.toolDefinitions, toolDefinitionUsage(registry, requests[index].tools));
    assert.doesNotMatch(JSON.stringify(observations[index].payload.toolDefinitions), /private fixture request|Advance fixture/);
    assert.ok(!requests[index].messages.some(message => message.content?.includes('runtime-tool-json-chars-v1')));
  }
});
