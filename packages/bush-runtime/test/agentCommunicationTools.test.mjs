import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry, ToolExecutionCoordinator } from '../dist/index.js';
import { registerBuiltinToolDisclosure } from '../dist/builtinToolDisclosure.js';
import { synchronizeMcpCatalog, modelToolDefinitions } from '../dist/mcpToolDiscovery.js';
import { RuntimeTaskTools } from '../dist/taskTools.js';

const manifest = { effect_kind: 'observation', operation: 'fixture', risk: 'low', owner: 'fixture', dispatch_scope: 'session', mutating: false };
const definition = name => ({ name, inputSchema: { type: 'object', properties: {}, additionalProperties: false } });
const request = registry => ({ protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 'parent', turnId: 't', model: 'fixture',
  tools: registry.definitions(), messages: [], permissionMode: 'all_free', metadata: { mcpToolDiscovery: true, mcpCatalogUpdates: 'additions' } });

test('replacement catalogs retain legacy handlers and restore their entry when a replacement is disabled', () => {
  const registry = new ToolRegistry();
  registry.register({ definition: definition('old'), manifest, registrationOwner: 'extension:legacy', supersededBy: 'current', decodeInput: x => x, execute: () => 'legacy' });
  assert.deepEqual(registry.definitions().map(t => t.name), ['old']);
  registry.register({ definition: definition('current'), manifest, registrationOwner: 'extension:fixture', decodeInput: x => x, execute: () => 'current' });
  assert.deepEqual(registry.definitions().map(t => t.name), ['current']);
  assert.equal(registry.resolve('old').execute({}), 'legacy');
  const active = request(registry); synchronizeMcpCatalog(registry, active);
  registry.setOwnerEnabled('extension:fixture', false);
  assert.deepEqual(registry.definitions().map(t => t.name), ['old']);
  assert.deepEqual(registry.childDefinitions().map(t => t.name), ['old']);
  synchronizeMcpCatalog(registry, active);
  assert.deepEqual(active.tools.map(t => t.name), ['old']);
});

test('hot catalog refresh preserves previously exposed aliases but never advertises them to new conversations', () => {
  const registry = new ToolRegistry();
  const register = (name, supersededBy) => registry.register({ definition: definition(name), manifest, registrationOwner: 'extension:fixture',
    deferredSchema: true, supersededBy, decodeInput: x => x, execute: () => name });
  register('old', 'current'); const previous = request(registry);
  synchronizeMcpCatalog(registry, previous);
  const frozen = structuredClone(modelToolDefinitions(registry, previous));
  register('current');
  synchronizeMcpCatalog(registry, previous);
  assert.deepEqual(previous.tools.map(t => t.name), ['old', 'current']);
  assert.deepEqual(modelToolDefinitions(registry, previous), frozen);
  const fresh = request(registry); synchronizeMcpCatalog(registry, fresh);
  assert.deepEqual(fresh.tools.map(t => t.name), ['current']);
});

test('a frozen tasks declaration can load the current conversation action without rewriting its provider prefix', async () => {
  const registry = new ToolRegistry();
  const tasks = new RuntimeTaskTools(async () => 'task_completed');
  tasks.addSource(context => context.sessionId === 'parent' ? [{ task_id: 'child', kind: 'subagent', status: 'completed', revision: '1',
    readConversation: async (_context, cursor) => ({ messages: [{ content: 'verified final answer' }], nextCursor: cursor ? null : '1:0' }) }] : []);
  tasks.register(registry); registerBuiltinToolDisclosure(registry);
  const input = request(registry), observed = [];
  input.tools.find(t => t.name === 'tasks').inputSchema.properties.action.enum = ['list', 'inspect', 'wait', 'stop', 'cancel_observation'];
  const prefix = structuredClone(modelToolDefinitions(registry, input));
  const coordinator = new ToolExecutionCoordinator({ registry }); let ordinal = 0;
  const run = async (name, args) => {
    const id = `c${++ordinal}`, argumentsText = JSON.stringify(args);
    const result = await coordinator.execute({ protocol: 'bush.tool_call.v1', id, name, argumentsText },
      { requestId: 'r', sessionId: input.sessionId, turnId: 't', round: 1, ordinal }, undefined, { request: input, contextMessages: observed });
    if (result.kind === 'returned') observed.push({ role: 'assistant', content: '', toolCalls: [{ id, name, argumentsText }] },
      { role: 'tool', toolCallId: id, content: JSON.stringify(result.result) });
    return result;
  };
  assert.equal((await run('get_tool_schema', { name: 'tasks' })).kind, 'returned');
  const page = await run('call_tool', { name: 'tasks', arguments: { action: 'conversation', task_ids: ['child'] } });
  assert.equal(page.kind, 'returned', JSON.stringify(page));
  assert.equal(page.result.conversation.nextCursor, '1:0');
  assert.deepEqual(modelToolDefinitions(registry, input), prefix);
  assert.throws(() => registry.resolve('tasks').decodeInput({ action: 'conversation', task_ids: ['child'], cursor: '-1:0' }));
  const invalid = await run('tasks', { action: 'conversation', task_ids: ['child', 'foreign'] });
  assert.equal(invalid.kind, 'failed');
  input.sessionId = 'unrelated';
  assert.equal((await run('tasks', { action: 'conversation', task_ids: ['child'] })).kind, 'failed');
});
