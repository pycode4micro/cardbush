import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry, ToolExecutionCoordinator, InMemoryRuntimeHost, ToolExecutionStore } from '../dist/index.js';
import { registerBuiltinToolDisclosure, synchronizeBuiltinSchemas } from '../dist/builtinToolDisclosure.js';
import { modelToolDefinitions } from '../dist/mcpToolDiscovery.js';

const manifest = { effect_kind: 'local_state', operation: 'fixture.save', risk: 'low', owner: 'fixture', dispatch_scope: 'session', mutating: true };
function fixture(options = {}) {
  const registry = new ToolRegistry(), messages = [], observed = [], hooks = [], approvals = [];
  let executed = 0, resourceLocks = 0;
  registry.register({ definition: { name: 'fixture_save', description: 'Save a value', inputSchema: {
    type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } },
    manifest, nestedCallable: false,
    decodeInput: value => { if (typeof value?.value !== 'string') throw new Error('value must be a string'); return value; },
    authorize: () => ({ kind: 'ask', request: { reason: 'Confirm save', actions: ['fixture.save'], targets: [], capabilityIds: [] } }),
    resources: () => { resourceLocks++; return [{ key: 'fixture:file', mode: 'write' }]; },
    execute: ({ input, toolCall }) => { executed++; return { saved: input.value, id: toolCall.id }; },
    ...options,
  });
  registerBuiltinToolDisclosure(registry);
  const request = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture',
    tools: registry.definitions(), messages: [], permissionMode: 'all_free', metadata: {} };
  const coordinator = new ToolExecutionCoordinator({ registry,
    permissions: { request: async permission => { approvals.push(permission); return { decision: 'allow', grantedCapabilityIds: [] }; } },
    hooks: { before: async ({ toolCall }) => { hooks.push(['before', toolCall.name]); return { messages: [] }; },
      after: async ({ toolCall }) => { hooks.push(['after', toolCall.name]); return { messages: [] }; } },
    observer: { running: (wire, identity, native) => observed.push({ wire, identity, native }) },
  });
  let ordinal = 0;
  const run = async (name, input, signal) => {
    const call = { protocol: 'bush.tool_call.v1', id: `c${++ordinal}`, name, argumentsText: JSON.stringify(input) };
    const outcome = await coordinator.execute(call, { requestId: 'r', sessionId: 's', turnId: 't', round: ordinal, ordinal }, signal,
      { request, contextMessages: messages });
    if (outcome.kind === 'returned') messages.push({ role: 'assistant', content: '', toolCalls: [call] },
      { role: 'tool', toolCallId: call.id, content: JSON.stringify(outcome.result) });
    return outcome;
  };
  const call = input => run('call_tool', { name: 'fixture_save', arguments: input });
  return { registry, request, messages, observed, hooks, approvals, run, call, counts: () => ({ executed, resourceLocks }) };
}

test('loaded invocation forwards through native validation, permissions, hooks, resources and identity exactly once', async () => {
  const f = fixture(), before = modelToolDefinitions(f.registry, f.request);
  f.request.permissionMode = 'ask';
  assert.equal((await f.call({ value: 'unloaded' })).error.code, 'builtin_schema_required');
  assert.equal((await f.run('get_tool_schema', { name: 'fixture_save' })).kind, 'returned');
  const invalid = await f.call({});
  assert.equal(invalid.error.code, 'tool_arguments_schema_invalid');
  f.hooks.length = 0;
  const result = await f.call({ value: 'kept' });
  assert.equal(result.kind, 'returned');
  assert.deepEqual(result.result, { saved: 'kept', id: 'c4' });
  assert.deepEqual(f.counts(), { executed: 1, resourceLocks: 1 });
  assert.deepEqual(f.hooks, [['before', 'fixture_save'], ['after', 'fixture_save']]);
  assert.equal(f.approvals.length, 1); assert.equal(f.approvals[0].toolCallId, 'c4');
  assert.equal(f.observed.at(-1).wire.name, 'call_tool'); assert.equal(f.observed.at(-1).native.name, 'fixture_save');
  assert.equal(f.observed.at(-1).native.id, 'c4');
  assert.equal(result.actionManifest.operation, 'fixture.save');
  assert.equal(result.execution.effects, 'possible');
  assert.deepEqual(modelToolDefinitions(f.registry, f.request), before);
});

test('foreign, incomplete, stale or compacted schemas never authorize the invocation', async () => {
  const f = fixture();
  await f.run('get_tool_schema', { name: 'fixture_save' });
  const receipt = f.messages.at(-1), complete = receipt.content;
  for (const content of [complete.replace('"sessionId":"s"', '"sessionId":"other"'),
    JSON.stringify({ archived: true, locator: 'tool-result://s/t/load', originalChars: complete.length, preview: complete }), '{}']) {
    receipt.content = content;
    assert.equal((await f.call({ value: 'rejected' })).error.code, 'builtin_schema_required');
  }
  receipt.content = complete;
  f.registry.resolve('fixture_save').definition.description = 'Updated contract';
  assert.equal((await f.call({ value: 'stale' })).error.code, 'builtin_schema_required');
  await f.run('get_tool_schema', { name: 'fixture_save' });
  assert.equal((await f.call({ value: 'current' })).kind, 'returned');
  f.messages.length = 0;
  assert.equal((await f.call({ value: 'compacted' })).error.code, 'builtin_schema_required');
  assert.equal(f.counts().executed, 1);
});

test('loaded definitions cannot bypass scope, child restrictions, native denial or recursive invocation rules', async () => {
  const f = fixture();
  await f.run('get_tool_schema', { name: 'fixture_save' });
  f.request.metadata.agentRole = 'child'; f.request.metadata.disabledTools = ['fixture_save'];
  assert.equal((await f.call({ value: 'child' })).error.code, 'child_agent_tool_unavailable');
  f.request.metadata = {};
  f.registry.resolve('fixture_save').authorize = () => ({ kind: 'deny', code: 'native_denied', message: 'Denied' });
  assert.equal((await f.call({ value: 'denied' })).error.code, 'native_denied');
  f.request.tools = f.request.tools.filter(tool => tool.name !== 'fixture_save');
  assert.equal((await f.call({ value: 'removed' })).error.code, 'tool_not_exposed');
  assert.equal((await f.run('get_tool_schema', { name: 'call_tool' })).error.code, 'tool_requires_direct_call');
  assert.equal((await f.run('call_tool', { name: 'call_tool', arguments: {} })).error.code, 'tool_requires_direct_call');
  assert.equal(f.counts().executed, 0);
});

test('discovery and maintenance preserve their direct call receipts', async () => {
  for (const name of ['mcp_search', 'mcp_call', 'read_archived_tool_result', 'checkpoint_context', 'summary_for_user']) {
    const f = fixture({ definition: { name, description: 'Direct receipt', inputSchema: { type: 'object' } } });
    assert.equal((await f.run('get_tool_schema', { name })).error.code, 'tool_requires_direct_call');
    assert.equal((await f.run('call_tool', { name, arguments: { value: 'wrong boundary' } })).error.code, 'tool_requires_direct_call');
    assert.equal(f.counts().executed, 0);
    assert.equal((await f.run(name, { value: 'direct' })).kind, 'returned');
  }
});

test('cancelling a forwarded operation preserves its native uncertain effects', async () => {
  const started = Promise.withResolvers(), finished = Promise.withResolvers();
  const f = fixture({ execute: async () => { started.resolve(); await finished.promise; return {}; } });
  await f.run('get_tool_schema', { name: 'fixture_save' });
  const controller = new AbortController();
  const pending = f.run('call_tool', { name: 'fixture_save', arguments: { value: 'pending' } }, controller.signal);
  await started.promise;
  controller.abort();
  const result = await pending;
  finished.resolve();
  assert.equal(result.kind, 'cancelled');
  assert.equal(result.actionManifest.operation, 'fixture.save');
  assert.equal(result.execution.dispatch, 'started');
  assert.equal(result.execution.effects, 'possible');
  assert.equal(result.execution.result, 'unknown');
});

test('native plugin additions and revisions are recalled through results while declarations stay byte-identical', async t => {
  const registry = new ToolRegistry(), journal = new ToolExecutionStore();
  let version = 0, executed = 0, round = 0, frozen;
  const replace = () => registry.replaceOwned('extension:fixture', [{
    definition: { name: 'native_save', description: `Version ${++version}`, inputSchema: { type: 'object' } }, manifest,
    decodeInput: x => x, execute: () => ({ version, executed: ++executed }),
  }]);
  registry.register({ definition: { name: 'install_fixture', description: 'Update fixture', inputSchema: { type: 'object' } }, manifest,
    decodeInput: x => x, execute: () => { replace(); return { version }; } });
  const operations = [['install_fixture', {}], ['get_tool_schema', { name: 'native_save' }], ['call_tool', { name: 'native_save', arguments: {} }],
    ['install_fixture', {}], ['call_tool', { name: 'native_save', arguments: {} }],
    ['get_tool_schema', { name: 'native_save' }], ['call_tool', { name: 'native_save', arguments: {} }]];
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, toolExecutionStore: journal, provider: { async *stream(request) {
    frozen ??= JSON.stringify(request.tools);
    assert.equal(JSON.stringify(request.tools), frozen);
    if (round === 5) assert.match(request.messages.at(-1).content, /builtin_schema_required/);
    const operation = operations[round++];
    const event = (sequence, kind, values) => ({ protocol: 'bush.model_event.v1', requestId: request.requestId, sequence, createdAt: new Date().toISOString(), kind, ...values });
    if (operation) yield event(0, 'tool_call_delta', { index: 0, toolCallId: `op${round}`, nameDelta: operation[0], argumentsDelta: JSON.stringify(operation[1]) });
    else yield event(0, 'text_delta', { delta: 'Done' });
    yield event(1, 'response_completed', { finishReason: operation ? 'tool_calls' : 'stop' });
  } } });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const terminal = await host.runModelTurn({ protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture',
    messages: [{ role: 'user', content: 'Update and invoke the extension' }], tools: registry.definitions(), permissionMode: 'all_free', metadata: { mcpCatalogUpdates: 'additions' } });
  assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal));
  assert.equal(executed, 2);
  assert.ok(host.events('s', 't').filter(e => e.kind === 'cache_chain_observed').every(e => !e.payload.frozenPrefixBreak));
  const saved = journal.get('s', 't', 'op3');
  assert.equal(saved.toolCall.name, 'native_save'); assert.deepEqual(saved.result, { version: 1, executed: 1 });
});
