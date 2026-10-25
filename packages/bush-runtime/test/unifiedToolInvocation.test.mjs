import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { ToolRegistry, RuntimeToolLoop, ToolExecutionStore, InMemoryRuntimeEventLog,
  registerMcpDiscovery, synchronizeMcpDiscovery, createToolNameScope, portableToolName, InMemoryRuntimeHost,
  FileSessionEventPersistence, SessionStore } from '../dist/index.js';
import { registerBuiltinToolDisclosure } from '../dist/builtinToolDisclosure.js';
import { modelToolDefinitions, mcpDiscoveryResults } from '../dist/mcpToolDiscovery.js';

const remote = 'mcp__plugin_video_editor_fixture__commerce_candidate_submit';
const native = 'native_save';
const manifest = { effect_kind: 'local_state', operation: 'fixture.save', risk: 'low', owner: 'fixture', dispatch_scope: 'session', mutating: true };
function fixture({ messages = [], mutate, options = {}, result } = {}) {
  const registry = new ToolRegistry(), store = new ToolExecutionStore(), events = new InMemoryRuntimeEventLog();
  const state = { calls: [], approvals: [], hooks: [], allow: true, locks: 0, active: 0, peak: 0, blocked: false };
  for (const name of [native, remote]) registry.register({
    definition: { name, description: `Save via ${name}`, inputSchema: {
      type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } },
    manifest, decodeInput: input => {
      if (typeof input.value !== 'string' || Object.keys(input).some(key => key !== 'value')) throw Error('Expected only value:string');
      return input;
    },
    authorize: () => ({ kind: 'ask', request: { reason: 'Save fixture', actions: ['fixture.save'], targets: [], capabilityIds: [] } }),
    resources: () => { state.locks++; return [{ key: 'unified-fixture-file', mode: 'write' }]; },
    execute: async context => {
      state.calls.push({ name, input: context.input, callId: context.toolCall.id });
      state.active++; state.peak = Math.max(state.peak, state.active);
      try { return mutate ? await mutate(context) : result ?? { saved: context.input.value }; }
      finally { state.active--; }
    },
    ...(name === remote ? { mcpHook: { server: 'fixture', tool: 'save', call: async () => ({}) } } : {}),
    ...options,
  });
  registerMcpDiscovery(registry); registerBuiltinToolDisclosure(registry);
  const request = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture',
    tools: registry.definitions(), messages, permissionMode: 'ask', metadata: { mcpToolDiscovery: true } };
  const loop = new RuntimeToolLoop({ registry, executionStore: store, eventLog: events,
    identity: { sessionId: 's', turnId: 't', requestId: 'r' },
    externalPermissions: { request: async value => { state.approvals.push(value); return { decision: state.allow ? 'allow_once' : 'deny', grantedCapabilityIds: [] }; } },
    hooks: {
      before: async ({ toolCall }) => {
        if ([native, remote].includes(toolCall.name)) {
          state.hooks.push(['before', toolCall.name]);
          if (state.blocked) return { blocked: 'Blocked by fixture hook', messages: [] };
        }
        return { messages: [] };
      },
      after: async ({ toolCall }) => { if ([native, remote].includes(toolCall.name)) state.hooks.push(['after', toolCall.name]); return { messages: [] }; },
    },
  });
  let round = 0;
  const batch = async (operations, extra = {}) => {
    const toolCalls = operations.map(([name, args], index) => ({ protocol: 'bush.tool_call.v1', id: `c${round + 1}-${index}`, name, argumentsText: JSON.stringify(args) }));
    const scope = createToolNameScope({ ...request, tools: modelToolDefinitions(registry, request), messages });
    const value = await loop.execute(toolCalls, { round: ++round, assistantMessageId: `a${round}`, request,
      contextMessages: messages, toolNameScope: scope, ...extra });
    messages.push({ role: 'assistant', content: '', toolCalls }, ...value.messages);
    synchronizeMcpDiscovery(registry, request, messages);
    return value.messages.map((message, i) => ({ text: message.content, model: JSON.parse(message.content.split('\n\n')[0]), record: store.get('s', 't', toolCalls[i].id), call: toolCalls[i] }));
  };
  const run = async (name, args, extra) => (await batch([[name, args]], extra))[0];
  const load = name => run('get_tool_schema', { name });
  const call = (name, value = 'value', extra) => run('call_tool', { name, arguments: { value } }, extra);
  return { registry, request, messages, state, store, loop, run, batch, load, call };
}

test('native and MCP tools use one loader and gateway, with one approval, hook pair and target receipt per call', async () => {
  const f = fixture(), frozen = JSON.stringify(modelToolDefinitions(f.registry, f.request));
  assert.equal(JSON.parse(frozen).some(tool => tool.name === 'mcp_call'), false);
  assert.equal(f.registry.resolve('mcp_call'), undefined);
  for (const name of [native, remote]) {
    const loaded = await f.load(name);
    assert.equal(loaded.model.invocation.tool, 'call_tool');
    const saved = await f.call(name, name);
    assert.deepEqual(saved.model, { saved: name });
    assert.equal(saved.record.toolCall.name, name);
    assert.equal(saved.record.toolCall.id, saved.call.id);
    assert.deepEqual(JSON.parse(saved.record.toolCall.argumentsText), { value: name });
    assert.equal(f.state.approvals.at(-1).toolCallId, saved.call.id);
    assert.equal(f.messages.at(-1).toolCallId, saved.call.id);
    assert.equal(f.messages.at(-2).toolCalls[0].name, 'call_tool', 'wire history is unchanged');
  }
  assert.equal(f.state.calls.length, 2); assert.equal(f.state.approvals.length, 2); assert.equal(f.state.locks, 2);
  assert.deepEqual(f.state.hooks, [['before', native], ['after', native], ['before', remote], ['after', remote]]);
  assert.equal(JSON.stringify(modelToolDefinitions(f.registry, f.request)), frozen);
});

test('retired entries and search-load mode fail explicitly without target execution', async () => {
  const f = fixture(); await f.load(remote);
  for (const name of ['mcp_call', 'parallel_tools', 'manage_tool_calls', 'manage_plugin_agents', 'await_subagents', 'read_subagent_conversation', 'request_permission', 'solution_selection']) {
    assert.equal(f.registry.resolve(name), undefined);
    assert.ok((await f.run(name, { name: remote, arguments: { value: 'never' } })).model.runtimeError);
    assert.ok((await f.run('get_tool_schema', { name })).model.runtimeError);
  }
  assert.ok((await f.run('mcp_search', { action: 'load', names: [remote] })).model.runtimeError);
  assert.equal(f.state.calls.length, 0);
  const scoped = fixture(); scoped.request.tools = scoped.request.tools.filter(tool => tool.name !== 'call_tool');
  assert.equal((await scoped.load(remote)).model.invocation.tool, null);
  assert.equal(scoped.registry.resolve('mcp_call'), undefined);
});

test('batch loading produces receipts usable by the same gateway and aliases', async () => {
  const f = fixture();
  const loaded = await f.run('get_tool_schema', { names: [remote] });
  assert.equal(loaded.model.invocation.tool, 'call_tool');
  assert.equal((await f.call(remote)).model.saved, 'value');
  await f.load(remote);
  assert.equal((await f.call(portableToolName(remote), 'literal_' + portableToolName(remote))).model.saved, 'literal_' + portableToolName(remote));
  assert.equal(f.state.calls.at(-1).name, remote);
  assert.equal([...mcpDiscoveryResults(f.messages, 's')].length, 2);
});

test('one mixed native/MCP schema batch retains both definitions and isolates missing names', async () => {
  const f = fixture();
  const loaded = await f.run('get_tool_schema', { names: [native, remote, 'missing', native] });
  assert.deepEqual(loaded.model.matches.map(tool => [tool.name, tool.source]), [[native, 'native'], [remote, 'mcp']]);
  assert.deepEqual(loaded.model.errors.map(error => error.name), ['missing']);
  assert.equal(f.state.calls.length, 0);
  assert.deepEqual([...mcpDiscoveryResults(f.messages, 's')][0].output.matches.map(tool => tool.name), [native, remote]);
  assert.equal((await f.call(native, 'local')).model.saved, 'local');
  assert.equal((await f.call(remote, 'remote')).model.saved, 'remote');
  assert.equal(f.state.approvals.length, 2);
});

test('loading and invocation in the same parallel batch cannot skip the delivered-schema prerequisite', async () => {
  const f = fixture();
  const results = await f.batch([['get_tool_schema', { name: remote }], ['call_tool', { name: remote, arguments: { value: 'not yet' } }]]);
  assert.equal(results[1].model.runtimeError.code, 'mcp_discovery_required');
  assert.equal(f.state.calls.length, 0); assert.equal(f.state.approvals.length, 0);
  assert.equal((await f.call(remote)).model.saved, 'value');
});

for (const alteration of ['foreign-session', 'partial-archive', 'forged-schema', 'user-summary', 'wrong-tool-receipt', 'old-protocol', 'old-loader', 'compacted']) {
  test(`${alteration}: MCP schema evidence cannot be manufactured through the unified loader`, async () => {
    const f = fixture(); await f.load(remote);
    const receipt = f.messages.at(-1), original = receipt.content;
    if (alteration === 'foreign-session') receipt.content = original.replace('"sessionId":"s"', '"sessionId":"foreign"');
    if (alteration === 'partial-archive') receipt.content = JSON.stringify({ archived: true, locator: 'tool-result://s/t/load', originalChars: original.length, preview: original });
    if (alteration === 'forged-schema') { const data = JSON.parse(original); data.matches[0].inputSchema.properties.extra = { type: 'string' }; receipt.content = JSON.stringify(data); }
    if (alteration === 'user-summary') f.messages.splice(0, 2, { role: 'user', content: original });
    if (alteration === 'wrong-tool-receipt') f.messages[0].toolCalls[0].name = native;
    if (alteration === 'old-protocol') receipt.content = original.replace('bush.tool_schema.v1', 'bush.mcp_discovery.v1');
    if (alteration === 'old-loader') f.messages[0].toolCalls[0].name = 'mcp_search';
    if (alteration === 'compacted') f.messages.length = 0;
    const failure = await f.call(remote);
    assert.equal(failure.model.runtimeError.code, 'mcp_discovery_required');
    assert.deepEqual(failure.model.runtimeError.details.load, { name: 'get_tool_schema', arguments: { name: remote } });
    assert.equal(f.state.calls.length, 0); assert.equal(f.state.approvals.length, 0);
  });
}

test('restarting from serialized unified receipts restores schemas without replaying previous actions', async () => {
  for (const loader of ['get_tool_schema']) {
    const before = fixture();
    await before.run(loader, { name: remote });
    await before.run('call_tool', { name: remote, arguments: { value: 'already saved' } });
    const history = JSON.parse(JSON.stringify(before.messages));
    const after = fixture({ messages: history });
    assert.equal(after.state.calls.length, 0);
    const next = await after.call(remote, 'new request');
    assert.deepEqual(next.model, { saved: 'new request' });
    assert.deepEqual(after.state.calls.map(call => call.input.value), ['new request']);
  }
});

test('a changed MCP schema must be reloaded; caller parameters are never silently repaired or retried', async () => {
  const f = fixture(); await f.load(remote);
  f.registry.resolve(remote).definition.description = 'Updated contract';
  assert.equal((await f.call(remote)).model.runtimeError.code, 'mcp_discovery_required');
  assert.equal(f.state.calls.length, 0);
  await f.load(remote);
  const invalid = await f.run('call_tool', { name: remote, arguments: { value: 'v', extra: 'do not discard' } });
  assert.equal(invalid.model.runtimeError.code, 'tool_arguments_schema_invalid');
  assert.equal(f.state.calls.length, 0);
  assert.equal((await f.call(remote)).model.saved, 'value');
});

for (const restriction of ['foreign-tool', 'interface-only', 'not-exposed', 'unavailable', 'child', 'hook', 'denied', 'web']) {
  test(`${restriction}: unified invocation keeps the actual target boundary`, async () => {
    const f = fixture(); await f.load(remote);
    const registration = f.registry.resolve(remote);
    if (restriction === 'foreign-tool') registration.sessionScope = 'another-session';
    if (restriction === 'interface-only') registration.mcpHook.modelVisible = false;
    if (restriction === 'not-exposed') f.request.tools = f.request.tools.filter(tool => tool.name !== remote);
    if (restriction === 'unavailable') registration.modelAvailable = () => false;
    if (restriction === 'child') Object.assign(f.request.metadata, { agentRole: 'child', disabledTools: [remote] });
    if (restriction === 'hook') f.state.blocked = true;
    if (restriction === 'denied') f.state.allow = false;
    if (restriction === 'web') f.request.metadata.toolExecutionPolicy = 'web_restricted';
    const failure = await f.call(remote);
    assert.ok(failure.model.runtimeError, JSON.stringify(failure.model));
    assert.equal(f.state.calls.length, 0);
    assert.equal(f.state.approvals.length, restriction === 'denied' ? 1 : 0);
    if (['foreign-tool', 'interface-only', 'not-exposed', 'unavailable'].includes(restriction)) {
      assert.equal((await f.load(remote)).model.runtimeError.code, 'tool_not_exposed');
    }
  });
}

test('mutations through the native and MCP unified calls share the same resource lock', async () => {
  const f = fixture({ mutate: async ({ input }) => { await new Promise(resolve => setTimeout(resolve, 10)); return { saved: input.value }; } });
  await f.load(remote); await f.load(native);
  const results = await f.batch([native, remote].map(name => ['call_tool', { name, arguments: { value: name } }]));
  assert.ok(results.every(result => !result.model.runtimeError));
  assert.equal(f.state.calls.length, 2); assert.equal(f.state.peak, 1);
});

test('cancellation after target dispatch retains uncertain effects and never retries', async () => {
  const started = Promise.withResolvers(), finished = Promise.withResolvers();
  const f = fixture({ mutate: async () => { started.resolve(); await finished.promise; return { saved: true }; } });
  await f.load(remote);
  const controller = new AbortController();
  const pending = f.call(remote, 'one mutation', { signal: controller.signal });
  await started.promise; controller.abort();
  const failed = await pending; finished.resolve();
  assert.equal(failed.model.runtimeError.details.execution.effects, 'possible');
  assert.equal(failed.model.runtimeError.details.execution.result, 'unknown');
  assert.equal(failed.model.runtimeError.details.execution.recovery, 'do_not_retry');
  assert.equal(f.state.calls.length, 1);
});

test('MCP error receipts remain failures with the target result intact', async () => {
  const nativeResult = { isError: true, content: [{ type: 'text', text: 'Write failed; inspect existing state.' }] };
  const f = fixture({ result: nativeResult }); await f.load(remote);
  const failed = await f.call(remote);
  assert.equal(failed.model.runtimeError.code, 'mcp_tool_error');
  assert.equal(failed.model.runtimeError.details.execution.recovery, 'inspect_existing');
  assert.deepEqual(failed.record.result, nativeResult);
  assert.equal(f.state.calls.length, 1);
});

test('real host restart resumes unified receipts through call_tool without replay', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-unified-restart-')), calls = [], observed = [];
  let host, persistence;
  t.after(async () => {
    await host?.sendCommand({ kind: 'runtime.shutdown', payload: {} });
    persistence?.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-unified-restart-'));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const open = () => {
    const registry = new ToolRegistry();
    registry.register({ definition: { name: remote, description: 'Save fixture', inputSchema: { type: 'object', properties: { value: { type: 'string' } } } },
      manifest, decodeInput: x => x, execute: ({ input }) => { calls.push(input.value); return { saved: input.value }; },
      mcpHook: { server: 'fixture', tool: 'save', call: async () => ({}) } });
    const rounds = new Map();
    persistence = new FileSessionEventPersistence({ root: join(root, 'sessions') });
    host = new InMemoryRuntimeHost({ dataRoot: root, toolRegistry: registry, sessionStore: new SessionStore({ persistence }), provider: { async *stream(request) {
      observed.push(structuredClone(request));
      const round = rounds.get(request.turnId) ?? 0; rounds.set(request.turnId, round + 1);
      const operations = request.turnId === 'before'
        ? [['get_tool_schema', { name: remote }],
          ['call_tool', { name: remote, arguments: { value: 'already saved' } }]]
        : [['call_tool', { name: remote, arguments: { value: 'after restart' } }]];
      const operation = operations[round];
      const event = (sequence, kind, extra) => ({ protocol: 'bush.model_event.v1', requestId: request.requestId, sequence,
        createdAt: new Date().toISOString(), kind, ...extra });
      if (operation) yield event(0, 'tool_call_delta', { index: 0, toolCallId: `${request.turnId}-${round}`, nameDelta: operation[0], argumentsDelta: JSON.stringify(operation[1]) });
      else yield event(0, 'text_delta', { delta: 'Done' });
      yield event(1, 'response_completed', { finishReason: operation ? 'tool_calls' : 'stop' });
    } } });
    return turnId => host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: `r-${turnId}`, sessionId: 's', turnId,
      model: 'fixture', tools: registry.definitions(), permissionMode: 'all_free', metadata: {}, prefixMessages: [],
      inputMessages: [{ messageId: `user-${turnId}`, message: { role: 'user', content: turnId } }] });
  };
  let run = open();
  assert.equal((await run('before')).payload.status, 'completed');
  const history = structuredClone(observed.at(-1).messages);
  await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
  persistence.close();
  run = open();
  assert.deepEqual(calls, ['already saved']);
  assert.equal((await run('after')).payload.status, 'completed');
  const continued = observed.filter(request => request.turnId === 'after');
  const failures = continued.at(-1).messages.filter(message => message.role === 'tool' && message.content.includes('runtimeError'));
  assert.deepEqual(failures, []);
  assert.deepEqual(calls, ['already saved', 'after restart']);
  assert.equal(continued.length, 2, 'restored receipt requires no extra discovery or recovery round');
  assert.deepEqual(continued[0].messages.slice(0, history.length), history);
});
