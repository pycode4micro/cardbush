import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeToolLoop, ToolRegistry, ToolExecutionStore, InMemoryRuntimeEventLog, registerMcpDiscovery, synchronizeMcpDiscovery } from '../dist/index.js';

const identity = { requestId: 'r', sessionId: 's', turnId: 't' };
const manifest = { effect_kind: 'observation', operation: 'fixture', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: false };
const name = 'mcp__fixture__work';
const call = (id, name, input = {}) => ({ protocol: 'bush.tool_call.v1', id, name, argumentsText: JSON.stringify(input) });
const deferred = () => Promise.withResolvers();
function registration(name, execute, extra = {}) {
  return { definition: { name, inputSchema: { type: 'object' } }, manifest, decodeInput: x => x, execute, ...extra };
}
async function fixture(execute, options = {}) {
  const registry = new ToolRegistry(), store = new ToolExecutionStore(), eventLog = new InMemoryRuntimeEventLog();
  registerMcpDiscovery(registry);
  registry.register(registration(name, execute, { mcpHook: { server: 'fixture', tool: 'work', call: async () => ({}) }, ...options.tool }));
  const request = { protocol: 'bush.model_request.v1', ...identity, model: 'fixture', tools: registry.definitions(), metadata: { mcpToolDiscovery: true } };
  const contextMessages = [];
  const load = registry.resolve('mcp_search');
  const receipt = await load.execute({ input: { action: 'load', query: name }, turn: { request, contextMessages } });
  contextMessages.push({ role: 'assistant', content: '', toolCalls: [call('load', 'mcp_search')] }, { role: 'tool', toolCallId: 'load', content: JSON.stringify(receipt) });
  synchronizeMcpDiscovery(registry, request, contextMessages);
  const loop = new RuntimeToolLoop({ registry, executionStore: store, eventLog, identity, ...options.loop });
  return { registry, store, eventLog, loop, request, contextMessages,
    execute: (gateway, signal) => loop.execute([gateway ? call('root', 'mcp_call', { name, arguments: {} }) : call('root', name)],
      { round: 1, assistantMessageId: 'a', request, contextMessages, signal }),
    events: () => eventLog.replay('s', 't').filter(e => e.kind.startsWith('tool_')) };
}

for (const gateway of [false, true]) for (const outcome of ['success', 'failure', 'cancel']) {
  test(`${gateway ? 'mcp_call' : 'native'} ${outcome} settles the visible receipt while the turn remains active`, async () => {
    const started = deferred(), finished = deferred(), controller = new AbortController();
    let calls = 0;
    const f = await fixture(async ({ signal }) => {
      calls++; started.resolve();
      signal.addEventListener('abort', () => finished.reject(new DOMException('cancelled', 'AbortError')), { once: true });
      await finished.promise;
      if (outcome === 'failure') throw Error('fixture failed');
      return { saved: true };
    });
    const pending = f.execute(gateway, controller.signal);
    await started.promise;
    assert.deepEqual([...new Set(f.events().map(e => e.payload.toolCallId))], ['root'], 'internal calls cannot create phantom rows');
    if (outcome === 'cancel') controller.abort(); else finished.resolve();
    const result = await pending;
    const expected = { success: 'tool_returned', failure: 'tool_failed', cancel: 'tool_cancelled' }[outcome];
    assert.equal(f.events().at(-1).kind, expected);
    assert.equal(f.events().filter(e => ['tool_returned', 'tool_failed', 'tool_cancelled'].includes(e.kind)).length, 1);
    assert.equal(f.store.get('s', 't', 'root').outcome, { success: 'returned', failure: 'failed', cancel: 'cancelled' }[outcome]);
    assert.equal(f.store.get('s', 't', 'root:child:0'), undefined);
    assert.equal(result.messages.length, 1); assert.equal(result.messages[0].toolCallId, 'root');
    assert.equal(calls, 1, 'settlement must never re-execute the tool');
    assert.equal(f.eventLog.isTerminal('s', 't'), false, 'settle the operation before model thinking continues');
  });
}

for (const source of ['authorize', 'hook']) for (const decision of ['allow_once', 'deny', 'cancel']) {
  test(`delegated ${source} permission ${decision} remains attached to the visible caller`, async () => {
    const entered = deferred(), answer = deferred(); let calls = 0;
    const permission = { reason: 'fixture approval', actions: ['fixture.read'], targets: [{ kind: 'filesystem_path', value: '/fixture' }], capabilityIds: ['read'] };
    const f = await fixture(() => { calls++; return { saved: true }; }, {
      tool: source === 'authorize' ? { authorize: () => ({ kind: 'ask', request: permission }) } : {},
      loop: { externalPermissions: { request: input => { entered.resolve(input); return answer.promise; } },
        ...(source === 'hook' ? { hooks: { before: async ({ toolCall }) => ({ messages: [], ...(toolCall.name === name ? { ask: permission.reason } : {}) }), after: async () => ({ messages: [] }) } } : {}) },
    });
    const pending = f.execute(true);
    const requested = await entered.promise;
    assert.equal(requested.toolCallId, 'root');
    if (source === 'authorize') assert.deepEqual(requested.targets, permission.targets);
    answer.resolve({ decision, grantedCapabilityIds: decision === 'allow_once' ? ['read'] : [] });
    await pending;
    assert.equal(calls, decision === 'allow_once' ? 1 : 0);
    assert.deepEqual([...new Set(f.events().map(e => e.payload.toolCallId))], ['root']);
    assert.equal(f.events().at(-1).kind, decision === 'allow_once' ? 'tool_returned' : decision === 'cancel' ? 'tool_cancelled' : 'tool_failed');
  });
}

for (const outcome of ['success', 'failure', 'cancel']) for (const late of [false, true]) test(`explicit background ${outcome} receipts stay independent and durable (after terminal: ${late})`, async () => {
  const registry = new ToolRegistry(), store = new ToolExecutionStore(), eventLog = new InMemoryRuntimeEventLog();
  const gate = deferred(), started = deferred(), controller = new AbortController(); let pending, calls = 0;
  registry.register(registration('work', async () => { calls++; started.resolve(); await gate.promise; return { saved: true }; }));
  registry.register(registration('bridge', c => c.invokeTool('work', {})));
  registry.register(registration('launch', c => {
    pending = c.invokeTool('bridge', {}, { record: true, signal: controller.signal }).then(value => ({ value }), error => ({ error }));
    return { started: true };
  }));
  const loop = new RuntimeToolLoop({ registry, executionStore: store, eventLog, identity, hooks: {
    before: async ({ toolCall }) => ({ messages: [], ...(toolCall.name === 'bridge' ? { updatedInput: { checked: true } } : {}) }),
    after: async () => ({ messages: [] }),
  } });
  await loop.execute([call('root', 'launch')], { round: 1, assistantMessageId: 'a' });
  await started.promise;
  const before = eventLog.replay('s', 't');
  assert.equal(before.findLast(e => e.payload.toolCallId === 'root').kind, 'tool_returned');
  assert.equal(before.findLast(e => e.payload.toolCallId === 'root:child:0').kind, 'tool_running');
  assert.equal(before.some(e => e.payload.toolCallId === 'root:child:0:child:0'), false);
  if (late) eventLog.append(identity, { kind: 'turn_terminal', payload: { status: 'completed', reason: 'fixture', details: {} } });
  if (outcome === 'cancel') controller.abort();
  else if (outcome === 'failure') gate.reject(Error('fixture failure'));
  else gate.resolve();
  const delivered = await pending;
  if (outcome === 'cancel') { gate.resolve(); assert.equal(delivered.error.name, 'AbortError'); }
  if (outcome === 'failure') assert.match(delivered.error.message, /fixture failure/);
  const record = store.get('s', 't', 'root:child:0');
  assert.equal(record.outcome, { success: 'returned', failure: 'failed', cancel: 'cancelled' }[outcome]);
  if (outcome === 'success') assert.deepEqual(record.result, { saved: true });
  assert.deepEqual(JSON.parse(record.toolCall.argumentsText), { checked: true });
  assert.equal(eventLog.replay('s', 't').at(-1).kind, late ? 'turn_terminal' : { success: 'tool_returned', failure: 'tool_failed', cancel: 'tool_cancelled' }[outcome]);
  assert.equal(calls, 1);
});

for (const cancelOne of [false, true]) test(`parallel delegated calls share an approval without sharing cancellation (cancel one: ${cancelOne})`, async () => {
  const registry = new ToolRegistry(), store = new ToolExecutionStore(), eventLog = new InMemoryRuntimeEventLog();
  const controller = new AbortController(); let calls = 0;
  registry.register(registration('protected', () => { calls++; return { saved: true }; }, {
    authorize: () => ({ kind: 'ask', request: { reason: 'fixture access', actions: ['read'], targets: [{ kind: 'opaque', value: 'fixture://target' }], capabilityIds: ['read'] } }),
  }));
  registry.register(registration('parallel', c => Promise.all([
    c.invokeTool('protected', {}, { signal: controller.signal }).catch(error => ({ cancelled: error.name === 'AbortError' })),
    c.invokeTool('protected', {}),
  ])));
  const loop = new RuntimeToolLoop({ registry, executionStore: store, eventLog, identity });
  const pending = loop.execute([call('root', 'parallel')], { round: 1, assistantMessageId: 'a' });
  await new Promise(setImmediate);
  const requests = eventLog.replay('s', 't').filter(e => e.kind === 'permission_requested');
  assert.equal(requests.length, 1); assert.equal(requests[0].payload.toolCallId, 'root');
  if (cancelOne) {
    controller.abort(); await new Promise(setImmediate);
    assert.equal(eventLog.replay('s', 't').some(e => e.kind === 'permission_cancelled'), false, 'the other operation still needs the user decision');
  }
  loop.answerPermission({ protocol: 'bush.runtime_permission_answer.v1', permissionId: requests[0].payload.permissionId,
    answerId: 'answer', decision: 'allow_once', grantedCapabilityIds: ['read'] });
  await pending;
  assert.equal(calls, cancelOne ? 1 : 2);
  assert.equal(store.get('s', 't', 'root').outcome, 'returned');
  assert.deepEqual(store.get('s', 't', 'root').result, [cancelOne ? { cancelled: true } : { saved: true }, { saved: true }]);
  assert.deepEqual([...new Set(eventLog.replay('s', 't').filter(e => e.kind.startsWith('tool_')).map(e => e.payload.toolCallId))], ['root']);
});
