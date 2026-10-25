import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { InMemoryRuntimeHost, ToolRegistry, ToolExecutionCoordinator } from '../dist/index.js';
import { registerBuiltinToolDisclosure, synchronizeBuiltinSchemas } from '../dist/builtinToolDisclosure.js';
import { modelToolDefinitions } from '../dist/mcpToolDiscovery.js';
import { toolDefinitionUsage } from '../dist/toolDefinitionUsage.js';

const manifest = { effect_kind: 'observation', operation: 'fixture', risk: 'low', owner: 'runtime', dispatch_scope: 'session', mutating: false };
// Fixtures keep test executors but use metadata authored by the real tool owners.
const nativeRegistry = new ToolRegistry();
const catalogHost = new InMemoryRuntimeHost({ toolRegistry: nativeRegistry,
  loadPluginExtensions: async () => ({ hooks: [], agents: [], commands: [], skills: [] }) });
after(() => catalogHost.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
function fixture(names) {
  const registry = new ToolRegistry();
  for (const name of names) {
    const native = nativeRegistry.resolve(name);
    registry.register({ definition: structuredClone(native?.definition ?? { name, description: `Inspect ${name}`,
      inputSchema: { type: 'object', properties: {}, additionalProperties: false } }),
      projectModelDefinition: native?.projectModelDefinition, modelAvailable: native?.modelAvailable, directInvocation: native?.directInvocation,
      manifest, decodeInput: x => x, execute: () => ({ inspected: name }) });
  }
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

test('retired handlers are absent from the actual registry and cannot be recalled', async () => {
  for (const name of ['mcp_call', 'parallel_tools', 'manage_tool_calls', 'manage_plugin_agents', 'await_subagents', 'read_subagent_conversation', 'solution_selection', 'request_permission']) {
    assert.equal(nativeRegistry.resolve(name), undefined, name);
    const f = fixture(['tasks']);
    assert.equal((await f.run('get_tool_schema', { name })).kind, 'failed');
    assert.equal((await f.run(name)).kind, 'failed');
  }
  for (const name of ['tasks', 'run_tools', 'request_user_input_async', 'update_task_plan', 'terminal_list', 'read_file_memos', 'mcp_app_status']) assert.ok(nativeRegistry.resolve(name), name);
});

test('schema loading preserves the frozen presentation and execution admission', async () => {
  const f = fixture(['tasks', 'native_fixture']), original = structuredClone(f.definitions());
  const receipt = await f.load('native_fixture');
  assert.equal(receipt.matches[0].name, 'native_fixture'); assert.equal(receipt.matches[0].source, 'native');
  f.registry.resolve('native_fixture').authorize = () => ({ kind: 'deny', code: 'fixture_denied', message: 'Denied' });
  assert.equal((await f.run('call_tool', { name: 'native_fixture', arguments: {} })).error.code, 'fixture_denied');
  delete f.registry.resolve('native_fixture').authorize;
  assert.equal((await f.run('call_tool', { name: 'native_fixture', arguments: {} })).kind, 'returned');
  assert.deepEqual(f.definitions(), original);
  f.messages.length = 0; synchronizeBuiltinSchemas(f.registry, f.request, []);
  assert.equal((await f.run('call_tool', { name: 'native_fixture', arguments: {} })).error.code, 'builtin_schema_required');
});

test('Team definition editing stays discoverable; execution observations only use tasks', async () => {
  const f = fixture(['tasks', 'team', 'subagent']);
  const initial = structuredClone(f.definitions());
  assert.deepEqual(initial.find(tool => tool.name === 'team').inputSchema.properties.action.enum, ['list', 'get', 'run', 'resume']);
  const receipt = await f.load('team'), full = receipt.matches[0].inputSchema;
  for (const action of ['status', 'wait', 'stop']) assert.ok(!full.properties.action.enum.includes(action));
  assert.ok(full.properties.definition); assert.ok(full.properties.expected_revision);
  assert.equal(receipt.invocation.tool, 'call_tool'); assert.deepEqual(f.definitions(), initial);
  const scoped = { ...f.request, turnId: 'restricted', metadata: {}, tools: f.request.tools.filter(tool => tool.name !== 'tasks') };
  assert.deepEqual(modelToolDefinitions(f.registry, scoped).find(tool => tool.name === 'team').inputSchema.properties.action.enum, ['list', 'get', 'run', 'resume']);
});

test('task guidance has no alternate legacy observer even in restricted scopes', () => {
  for (const name of ['terminal_exec', 'terminal_poll', 'start_mcp_tool']) {
    assert.match(nativeRegistry.resolve(name).definition.description, /tasks/);
    assert.doesNotMatch(nativeRegistry.resolve(name).definition.description, /manage_tool_calls|await_subagents/);
  }
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
  assert.ok(registry.resolve('run_plugin_command') && !registry.resolve('manage_plugin_agents'));
  const observations = host.events('s', 't').filter(event => event.kind === 'cache_chain_observed');
  assert.equal(observations.length, 3);
  assert.ok(observations.every(event => !event.payload.frozenPrefixBreak));
  for (let index = 0; index < requests.length; index++) {
    assert.deepEqual(observations[index].payload.toolDefinitions, toolDefinitionUsage(registry, requests[index].tools));
    assert.doesNotMatch(JSON.stringify(observations[index].payload.toolDefinitions), /private fixture request|Advance fixture/);
    assert.ok(!requests[index].messages.some(message => message.content?.includes('runtime-tool-json-chars-v1')));
  }
});
