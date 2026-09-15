import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRegistry, RuntimeToolLoop, InMemoryRuntimeEventLog, ToolExecutionStore,
  registerMcpDiscovery, synchronizeMcpDiscovery } from '../dist/index.js';

const toolName = 'mcp__browser_fixture__list_pages';
const manifest = { effect_kind: 'observation', operation: 'fixture.read', risk: 'low', owner: 'fixture', dispatch_scope: 'parent_session', mutating: false };
function fixture() {
  const registry = new ToolRegistry(); registerMcpDiscovery(registry);
  const state = { executed: 0, asked: 0, allow: false, hooks: [], failure: undefined };
  registry.register({ definition: { name: toolName, description: 'List session pages', inputSchema: { type: 'object', properties: {} } },
    manifest, decodeInput: value => value,
    authorize: () => ({ kind: 'ask', request: { reason: 'Read pages', actions: ['read'], targets: [], capabilityIds: ['pages'] } }),
    execute: () => { state.executed++; if (state.failure) throw state.failure; return { pages: [] }; },
    mcpHook: { server: 'browser_fixture', tool: 'list_pages', call: async () => ({}) } });
  const request = { requestId: 'r', sessionId: 's', turnId: 't', permissionMode: 'task_free', tools: registry.definitions(), metadata: { mcpToolDiscovery: true } };
  const store = new ToolExecutionStore(), messages = [];
  const loop = new RuntimeToolLoop({ registry, executionStore: store, eventLog: new InMemoryRuntimeEventLog(),
    identity: { requestId: 'r', sessionId: 's', turnId: 't' },
    externalPermissions: { request: async () => { state.asked++; return { decision: state.allow ? 'allow_once' : 'deny', grantedCapabilityIds: [] }; } },
    hooks: { before: async ({ toolCall }) => { if (toolCall.name === toolName) state.hooks.push('before'); return { messages: [] }; },
      after: async ({ toolCall }) => { if (toolCall.name === toolName) state.hooks.push('after'); return { messages: [] }; } } });
  let round = 0;
  const call = async (name, args = {}) => {
    const id = 'call-' + ++round;
    const toolCall = { protocol: 'bush.tool_call.v1', id, name, argumentsText: JSON.stringify(args) };
    const result = await loop.execute([toolCall], { round, assistantMessageId: 'a-' + round, request, contextMessages: messages });
    messages.push({ role: 'assistant', content: '', toolCalls: [toolCall] }, ...result.messages);
    synchronizeMcpDiscovery(registry, request, messages);
    return { model: JSON.parse(result.messages[0].content), record: store.get('s', 't', id) };
  };
  const invoke = route => route === 'direct' ? call(toolName) : call('mcp_call', { name: toolName, arguments: {} });
  return { registry, request, messages, state, call, invoke };
}

for (const route of ['direct', 'mcp_call']) test(`${route}: omitted load returns executable recovery instructions and preserves approvals and hooks`, async () => {
  const f = fixture();
  const search = await f.call('mcp_search', { query: 'list_pages' });
  assert.equal(search.model.matches[0].loaded, false);
  const failed = await f.invoke(route);
  const error = failed.model.runtimeError;
  assert.equal(error.code, 'mcp_discovery_required');
  assert.equal(error.details.toolName, toolName);
  assert.deepEqual(error.details.load, { name: 'mcp_search', arguments: { action: 'load', query: toolName } });
  assert.deepEqual(failed.record.error.details, error.details, 'model feedback and execution journal describe the same recovery');
  assert.match(error.message, /has not executed/);
  assert.equal(f.state.executed, 0); assert.equal(f.state.asked, 0); assert.deepEqual(f.state.hooks, []);

  // Follow exactly the structured action delivered to the model, without
  // changing scope, discovery receipts or the caller's original arguments.
  const { load } = error.details;
  const loaded = await f.call(load.name, load.arguments);
  assert.equal(loaded.model.matches[0].name, toolName);
  assert.deepEqual(loaded.model.matches[0].inputSchema, { type: 'object', properties: {} });
  assert.equal(f.state.executed, 0, 'loading a schema never runs the browser tool');
  assert.equal((await f.call('mcp_search', { query: toolName })).model.matches[0].loaded, true);
  assert.equal((await f.invoke(route)).model.runtimeError.code, 'permission_rejected');
  assert.equal(f.state.asked, 1); assert.equal(f.state.executed, 0);
  f.state.hooks.length = 0; f.state.allow = true;
  const success = await f.invoke(route);
  assert.deepEqual(success.model, { pages: [] });
  assert.equal(f.state.executed, 1); assert.equal(f.state.asked, 2);
  assert.deepEqual(f.state.hooks, ['before', 'after'], 'the original tool hooks run exactly once');
});

for (const change of ['other-session', 'interface-only', 'removed-from-turn']) test(`${change}: unavailable tools never suggest that loading grants access`, async () => {
  const f = fixture();
  if (change === 'other-session') f.registry.resolve(toolName).sessionScope = 'other';
  if (change === 'interface-only') f.registry.resolve(toolName).mcpHook.modelVisible = false;
  if (change === 'removed-from-turn') f.request.tools = f.request.tools.filter(tool => tool.name !== toolName);
  for (const route of ['direct', 'mcp_call']) {
    const error = (await f.invoke(route)).model.runtimeError;
    assert.equal(error.code, 'tool_not_exposed'); assert.equal(error.details.load, undefined);
  }
  assert.equal((await f.call('mcp_search', { query: toolName })).model.total, 0);
  assert.equal(f.state.executed, 0); assert.equal(f.state.asked, 0);
});

for (const change of ['compaction', 'schema-revision']) test(`${change}: stale definitions return the same precise recovery and can be reloaded`, async () => {
  const f = fixture(); f.state.allow = true;
  await f.call('mcp_search', { action: 'load', query: toolName });
  if (change === 'compaction') f.messages.length = 0;
  else f.registry.resolve(toolName).definition.inputSchema = { type: 'object', properties: { extra: { type: 'string' } } };
  synchronizeMcpDiscovery(f.registry, f.request, f.messages);
  assert.equal((await f.call('mcp_search', { query: toolName })).model.matches[0].loaded, false);
  const { load } = (await f.invoke('direct')).model.runtimeError.details;
  await f.call(load.name, load.arguments);
  assert.deepEqual((await f.invoke('direct')).model, { pages: [] });
  assert.equal(f.state.executed, 1);
});

test('real browser errors remain service failures after successful schema loading', async () => {
  const f = fixture(); f.state.allow = true;
  f.state.failure = Object.assign(new Error('Browser connector is disconnected.'), { code: 'browser_disconnected' });
  await f.call('mcp_search', { action: 'load', query: toolName });
  const error = (await f.invoke('mcp_call')).model.runtimeError;
  assert.equal(error.code, 'browser_disconnected'); assert.equal(error.details.load, undefined);
  assert.equal(f.state.executed, 1);
});
