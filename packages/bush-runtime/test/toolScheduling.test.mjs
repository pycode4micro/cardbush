import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ToolRegistry, ToolExecutionCoordinator, ToolExecutionStore, RuntimeToolLoop, InMemoryRuntimeEventLog,
  registerMcpDiscovery, synchronizeMcpDiscovery, createToolNameScope, portableToolName } from '../dist/index.js';
import { modelToolDefinitions } from '../dist/mcpToolDiscovery.js';
import { executeToolScript, registerToolScript } from '../dist/toolScript.js';
import { ToolResourceScheduler } from '../dist/toolResourceScheduler.js';
import { RuntimeAsyncJobs } from '../dist/runtimeAsyncJobs.js';
import { BackgroundToolCalls } from '../dist/backgroundToolCalls.js';

const manifest = { effect_kind: 'observation', operation: 'fixture', owner: 'fixture', risk: 'low', dispatch_scope: 'session', mutating: false };
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
async function until(predicate) {
  const start = performance.now();
  while (!predicate()) {
    assert.ok(performance.now() - start < 2500, 'expected scheduler progress');
    await delay(2);
  }
}
function fixture(t) {
  const registry = new ToolRegistry(), store = new ToolExecutionStore(), messages = [], controller = new AbortController();
  t.after(() => controller.abort());
  const request = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't',
    model: 'fixture', tools: [], messages: [], permissionMode: 'all_free', metadata: { mcpToolDiscovery: true } };
  const hooks = { before: async () => ({ messages: [] }), after: async () => ({ messages: [] }) };
  const permissions = { request: async () => { throw Error('Unexpected permission request'); } };
  const newCoordinator = () => new ToolExecutionCoordinator({ registry, permissions, hooks,
    observer: { completed: (call, identity, outcome) => store.record(call, identity, outcome) } });
  const coordinator = newCoordinator();
  let ordinal = 0;
  const scope = () => createToolNameScope({ ...request, tools: modelToolDefinitions(registry, request), messages });
  const add = (name, execute, extra = {}) => {
    registry.register({ definition: { name, description: 'Offline fixture', inputSchema: { type: 'object' } },
      manifest, decodeInput: value => value, execute, ...extra });
    request.tools = registry.definitions();
    return name;
  };
  registerMcpDiscovery(registry);
  add('compose_fixture', c => executeToolScript(c.input.code, c, registry, c.signal), { delegatesToolExecution: true });
  const run = async (name, args = {}, signal = controller.signal, executor = coordinator) => {
    const id = 'call-' + ++ordinal, call = { protocol: 'bush.tool_call.v1', id, name, argumentsText: JSON.stringify(args) };
    const identity = { requestId: 'r', sessionId: 's', turnId: 't', round: ordinal, ordinal };
    const outcome = await executor.execute(call, identity, signal, { request, contextMessages: messages, toolNameScope: scope() });
    store.record(call, identity, outcome);
    return outcome;
  };
  const load = async names => {
    const args = { action: 'load', names }, outcome = await run('mcp_search', args);
    assert.equal(outcome.kind, 'returned', JSON.stringify(outcome));
    const id = 'load-' + ordinal;
    messages.push({ role: 'assistant', content: '', toolCalls: [{ id, name: 'mcp_search', argumentsText: JSON.stringify(args) }] },
      { role: 'tool', toolCallId: id, content: JSON.stringify(outcome.result) });
    synchronizeMcpDiscovery(registry, request, messages);
  };
  const mcp = (server, name, execute, extra = {}) => add(name, execute, {
    registrationOwner: 'runtime_mcp',
    executionChannel: `mcp:${server}`,
    mcpHook: { server, tool: name, readOnly: true, call: async () => ({}) }, ...extra,
  });
  const script = (code, signal) => run('compose_fixture', { code }, signal);
  const gate = () => { const value = Promise.withResolvers(); t.after(() => value.resolve({})); return value; };
  return { registry, store, request, messages, hooks, permissions, controller, scope, add, run, load, mcp, script, gate, newCoordinator };
}
function result(outcome) {
  assert.equal(outcome.kind, 'returned', JSON.stringify(outcome));
  return outcome.result;
}

for (const count of [12, 32]) test(`script queues ${count} independent calls with at most eight admitted`, { timeout: 8000 }, async t => {
  const f = fixture(t), gate = f.gate();
  let started = 0, active = 0, maximum = 0;
  f.add('read_item', async c => {
    started++; maximum = Math.max(maximum, ++active);
    try { await gate.promise; return c.input.index; } finally { active--; }
  }, { parallelSafe: true });
  const pending = f.script(`return await Promise.all(Array.from({length:${count}}, (_,index) => tools.read_item({index})));`);
  await until(() => started === 8); await flush();
  assert.equal(started, 8);
  gate.resolve();
  const output = result(await pending);
  assert.deepEqual(output.result, Array.from({ length: count }, (_, i) => i));
  assert.equal(output.calls, count); assert.equal(output.failed_calls, 0); assert.equal(maximum, 8);
  const records = f.store.listTurn('s', 't').filter(r => r.toolCall.name === 'read_item');
  assert.equal(records.length, count); assert.ok(records.every(r => r.outcome === 'returned'));
});

test('waiting on one channel does not consume all script slots', { timeout: 8000 }, async t => {
  const f = fixture(t), gate = f.gate();
  let blocked = 0, independent = false;
  f.add('serial_read', async () => { blocked++; await gate.promise; return {}; }, { executionChannel: 'fixture:serial' });
  f.add('independent_read', () => { independent = true; return {}; }, { executionChannel: 'fixture:other' });
  const pending = f.script('return await Promise.all([...Array.from({length:12}, () => tools.serial_read({})), tools.independent_read({})]);');
  await until(() => independent);
  assert.equal(blocked, 1);
  gate.resolve(); result(await pending); assert.equal(blocked, 12);
});

test('partial batch failures retain successful results and never replay completed actions', { timeout: 8000 }, async t => {
  const f = fixture(t), executed = [];
  f.add('read_item', c => {
    executed.push(c.input.index);
    if ([3, 9].includes(c.input.index)) throw Object.assign(Error('Fixture unavailable'), { code: 'fixture_unavailable' });
    return { index: c.input.index };
  }, { parallelSafe: true });
  const outcome = result(await f.script(`const results = await Promise.allSettled(
    Array.from({length:12}, (_,index) => tools.read_item({index})));
    return results.map(r => r.status === 'fulfilled' ? r.value : {error:r.reason.code});`));
  assert.equal(outcome.failed_calls, 2);
  assert.deepEqual(outcome.result[3], { error: 'fixture_unavailable' });
  assert.deepEqual(outcome.result[9], { error: 'fixture_unavailable' });
  assert.deepEqual(outcome.result[11], { index: 11 });
  assert.deepEqual(executed.sort((a,b) => a-b), Array.from({ length: 12 }, (_, i) => i));
  assert.equal(f.store.listTurn('s', 't').filter(r => r.toolCall.name === 'read_item' && r.outcome === 'failed').length, 2);
});

test('cancellation removes queued calls before Hooks or handlers and journals every item', { timeout: 8000 }, async t => {
  const f = fixture(t), gate = f.gate(), cancel = new AbortController();
  let started = 0, hooks = 0;
  f.hooks.before = async ({ toolCall }) => { if (toolCall.name === 'serial_write') hooks++; return { messages: [] }; };
  f.add('serial_write', async () => { started++; await gate.promise; return {}; },
    { manifest: { ...manifest, mutating: true }, executionChannel: 'fixture:serial' });
  const pending = f.script('return await Promise.allSettled(Array.from({length:32}, () => tools.serial_write({})));', cancel.signal);
  await until(() => started === 1); cancel.abort();
  assert.equal((await pending).kind, 'cancelled');
  await until(() => f.store.listTurn('s', 't').filter(r => r.toolCall.name === 'serial_write').length === 32);
  const records = f.store.listTurn('s', 't').filter(r => r.toolCall.name === 'serial_write');
  assert.equal(records.filter(r => r.error?.details?.execution?.dispatch === 'not_started').length, 31);
  assert.ok(records.every(r => r.outcome === 'cancelled'));
  gate.resolve(); await flush();
  assert.equal(started, 1); assert.equal(hooks, 1);
});

test('a Hook stop prevents the next queued call from starting', { timeout: 8000 }, async t => {
  const f = fixture(t);
  let started = 0;
  f.add('serial_read', () => { started++; return {}; });
  f.hooks.after = async ({ toolCall }) => toolCall.name === 'serial_read'
    ? { messages: ['Stop this batch'], stopTurn: 'Fixture stop' } : { messages: [] };
  const outcome = result(await f.script('return await Promise.allSettled(Array.from({length:12}, () => tools.serial_read({})));'));
  assert.equal(started, 1);
  assert.equal(outcome.failed_calls, 11);
  assert.equal(f.store.listTurn('s', 't').filter(r => r.error?.code === 'plugin_hook_stopped').length, 11);
});

for (const route of ['script', 'round']) test(`${route}: Hook stops also reach calls already waiting on a shared MCP lease`, { timeout: 8000 }, async t => {
  const f = fixture(t), gate = f.gate();
  let started = 0, stopped = false;
  const name = f.mcp('shared', 'mcp__shared__read', async () => { started++; await gate.promise; return {}; });
  f.add('stop_now', () => ({}), { parallelSafe: true, executionChannel: 'fixture:stop' });
  f.hooks.after = async ({ toolCall }) => {
    if (toolCall.name === 'stop_now') { stopped = true; return { messages: [], stopTurn: 'Fixture stop' }; }
    return { messages: [] };
  };
  await f.load([name]);
  const held = f.run(name);
  await until(() => started === 1);
  let pending;
  if (route === 'script') {
    pending = f.script(`return await Promise.allSettled([tools.mcp_call({name:${JSON.stringify(name)}, arguments:{}}), tools.stop_now({})]);`);
  } else {
    const loop = new RuntimeToolLoop({ registry: f.registry, eventLog: new InMemoryRuntimeEventLog(), executionStore: f.store, hooks: f.hooks,
      identity: { requestId: 'r', sessionId: 's', turnId: 't' } });
    const calls = [['mcp_call', { name, arguments: {} }], ['stop_now', {}]].map(([name, args], i) => ({
      protocol: 'bush.tool_call.v1', id: `round-${i}`, name, argumentsText: JSON.stringify(args),
    }));
    pending = loop.execute(calls, { round: 3, assistantMessageId: 'a-3', request: f.request,
      contextMessages: f.messages, toolNameScope: f.scope(), signal: f.controller.signal });
  }
  await until(() => stopped); await flush(); gate.resolve();
  result(await held); await pending;
  assert.equal(started, 1, 'the queued target must not execute after another call stops its batch');
});

test('the 32-call limit still rejects additional calls', { timeout: 8000 }, async t => {
  const f = fixture(t);
  let count = 0;
  f.add('read_item', () => { count++; return {}; }, { parallelSafe: true });
  const outcome = await f.script('return await Promise.all(Array.from({length:33}, () => tools.read_item({})));');
  assert.equal(outcome.kind, 'failed');
  assert.match(outcome.error.message, /32 calls total/);
  assert.ok(count <= 32);
});

test('wall time includes queued work and cancels it on expiry', { timeout: 8000 }, async t => {
  const f = fixture(t), gate = f.gate(), clock = Date.now;
  let offset = 0, started = 0;
  t.mock.method(Date, 'now', () => clock() + offset);
  f.add('serial_read', async () => { started++; await gate.promise; return {}; });
  const pending = f.script('return await Promise.all(Array.from({length:12}, () => tools.serial_read({})));');
  await until(() => started === 1); offset = 300_001;
  const outcome = await pending;
  assert.equal(outcome.kind, 'failed'); assert.match(outcome.error.message, /time budget exceeded/);
  await until(() => f.store.listTurn('s', 't').filter(r => r.toolCall.name === 'serial_read').length === 12);
  assert.equal(started, 1);
});

for (const route of ['round', 'script']) test(`${route}: MCP wrappers and visible aliases use the target server channel`, { timeout: 8000 }, async t => {
  const f = fixture(t), gate = f.gate(), entered = [];
  const first = f.mcp('a', 'mcp__fixture_a__' + 'read_'.repeat(15), async () => { entered.push('a'); await gate.promise; return { server: 'a' }; });
  const second = f.mcp('b', 'mcp__fixture_b__' + 'read_'.repeat(15), () => { entered.push('b'); gate.resolve(); return { server: 'b' }; });
  await f.load([first, second]);
  const frozen = JSON.stringify(modelToolDefinitions(f.registry, f.request));
  const args = [first, second].map(name => ({ name: portableToolName(name), arguments: {} }));
  if (route === 'script') {
    const output = result(await f.script(`return await Promise.all(${JSON.stringify(args)}.map(args => tools.mcp_call(args)));`));
    assert.deepEqual(output.result.map(r => r.result.server), ['a', 'b']);
  } else {
    const calls = args.map((input, i) => ({ protocol: 'bush.tool_call.v1', id: `round-${i}`, name: 'mcp_call', argumentsText: JSON.stringify(input) }));
    const loop = new RuntimeToolLoop({ registry: f.registry, eventLog: new InMemoryRuntimeEventLog(), executionStore: f.store,
      identity: { requestId: 'r', sessionId: 's', turnId: 't' } });
    const output = await loop.execute(calls, { round: 3, assistantMessageId: 'a-3', request: f.request,
      contextMessages: f.messages, toolNameScope: f.scope(), signal: f.controller.signal });
    assert.deepEqual(output.messages.map(m => m.toolCallId), ['round-0', 'round-1']);
    assert.deepEqual(output.messages.map(m => JSON.parse(m.content).server), ['a', 'b']);
  }
  assert.deepEqual(entered, ['a', 'b']);
  assert.equal(JSON.stringify(modelToolDefinitions(f.registry, f.request)), frozen);
});

test('MCP aliases retain desktop suppression while a parallel tool asks permission', { timeout: 8000 }, async t => {
  const f = fixture(t);
  let desktopCalls = 0, approvals = 0;
  f.add('needs_permission', () => ({}), { executionChannel: 'fixture:approval', authorize: () => ({ kind: 'ask',
    request: { reason: 'Fixture approval', actions: ['read'], targets: [], capabilityIds: ['fixture:allow'] } }) });
  const desktop = f.mcp('desktop', 'mcp__desktop__' + 'click_'.repeat(15), () => { desktopCalls++; return {}; },
    { manifest: { ...manifest, effect_kind: 'desktop_control', mutating: true } });
  await f.load([desktop]); f.request.permissionMode = 'task_free';
  const loop = new RuntimeToolLoop({ registry: f.registry, eventLog: new InMemoryRuntimeEventLog(), executionStore: f.store,
    identity: { requestId: 'r', sessionId: 's', turnId: 't' },
    externalPermissions: { request: async () => { approvals++; return { decision: 'allow_once', grantedCapabilityIds: ['fixture:allow'] }; } } });
  const calls = [['needs_permission', {}], ['mcp_call', { name: portableToolName(desktop), arguments: {} }]]
    .map(([name, args], i) => ({ protocol: 'bush.tool_call.v1', id: `desktop-${i}`, name, argumentsText: JSON.stringify(args) }));
  await loop.execute(calls, { round: 3, assistantMessageId: 'a-3', request: f.request,
    contextMessages: f.messages, toolNameScope: f.scope(), signal: f.controller.signal });
  assert.equal(approvals, 1); assert.equal(desktopCalls, 0);
  assert.equal(f.store.get('s', 't', 'desktop-1').outcome, 'cancelled');
});

test('two scripts and a direct call share the MCP server concurrency budget', { timeout: 8000 }, async t => {
  const f = fixture(t), gate = f.gate();
  let started = 0, active = 0, maximum = 0;
  const name = f.mcp('shared', 'mcp__shared__read', async () => {
    started++; maximum = Math.max(maximum, ++active);
    try { await gate.promise; return {}; } finally { active--; }
  }, { parallelSafe: true });
  await f.load([name]);
  const code = `return await Promise.all(Array.from({length:8}, () => tools.mcp_call({name:${JSON.stringify(name)},arguments:{}})));`;
  const one = f.script(code), two = f.script(code);
  await until(() => started === 8);
  const direct = f.run(name, {}, f.controller.signal, f.newCoordinator());
  await flush(); assert.equal(started, 8);
  gate.resolve();
  for (const outcome of await Promise.all([one, two, direct])) result(outcome);
  assert.equal(started, 17); assert.equal(maximum, 8);
});

test('real script task handles and background MCP waits share leases after a task is stopped', { timeout: 8000 }, async t => {
  const f = fixture(t), gate = f.gate(), completions = new Map(), backgroundResults = [];
  const jobs = new RuntimeAsyncJobs(f.store, (_s, _t, id, message) => completions.set(id, message));
  registerToolScript(f.registry, jobs);
  const background = new BackgroundToolCalls(f.registry, (_s, _t, _id, message) => backgroundResults.push(message));
  background.register();
  t.after(() => { jobs.endTurn('s', 't'); background.endTurn('s', 't'); });
  let started = 0, active = 0, maximum = 0;
  const name = f.mcp('shared', 'mcp__shared__read', async () => {
    started++; maximum = Math.max(maximum, ++active);
    try { await gate.promise; return { ok: true }; } finally { active--; }
  }, { parallelSafe: true });
  await f.load([name]);
  const code = count => `return await Promise.all(Array.from({length:${count}}, () => tools.call(${JSON.stringify(name)}, {})));`;
  const first = result(await f.run('run_tools', { code: code(12) }));
  await until(() => started === 8);
  const second = result(await f.run('run_tools', { code: code(8) }));
  const wait = result(await f.run('start_mcp_tool', { name, arguments: {} }));
  assert.ok(first.task_id); assert.ok(second.task_id); assert.ok(wait.task_id);
  await flush(); assert.equal(started, 8);
  const handle = jobs.source({ sessionId: 's', turnId: 't' }).find(job => job.task_id === first.task_id);
  await handle.stop();
  const cancelled = JSON.parse((await completions.get(first.task_id)).content);
  assert.equal(cancelled.status, 'cancelled');
  await until(() => f.store.listTurn('s', 't').filter(r => r.toolCall.name === name && r.outcome === 'cancelled').length === 12);
  assert.equal(started, 8, 'the stopped observer must not release active MCP executors');
  gate.resolve();
  assert.equal(JSON.parse((await completions.get(second.task_id)).content).status, 'completed');
  await backgroundResults[0];
  assert.equal(background.list('s', 't')[0].status, 'completed');
  assert.equal(started, 17, 'four cancelled queued operations must never run');
  assert.equal(maximum, 8);
});

test('readOnlyHint alone does not opt a server into parallel execution', { timeout: 8000 }, async t => {
  const f = fixture(t), gate = f.gate();
  let started = 0;
  const name = f.mcp('shared', 'mcp__shared__read', async () => { started++; await gate.promise; return {}; });
  await f.load([name]);
  const one = f.run('mcp_call', { name, arguments: {} });
  await until(() => started === 1);
  const two = f.script(`return await tools.call(${JSON.stringify(name)}, {});`);
  await flush(); assert.equal(started, 1);
  gate.resolve(); result(await one); result(await two); assert.equal(started, 2);
});

test('a cancelled MCP observer retains its server lease until the actual executor ends', { timeout: 8000 }, async t => {
  const f = fixture(t), gate = f.gate(), cancel = new AbortController();
  let started = 0;
  const name = f.mcp('shared', 'mcp__shared__mutate', async () => { started++; await gate.promise; return {}; },
    { manifest: { ...manifest, mutating: true } });
  await f.load([name]);
  const one = f.run(name, {}, cancel.signal);
  await until(() => started === 1); cancel.abort();
  const cancelled = await one;
  assert.equal(cancelled.kind, 'cancelled'); assert.equal(cancelled.execution.effects, 'possible');
  const two = f.run('mcp_call', { name, arguments: {} }, f.controller.signal, f.newCoordinator());
  await flush(); assert.equal(started, 1);
  gate.resolve(); result(await two); assert.equal(started, 2);
});

test('MCP definitions are checked again after waiting on a server lease', { timeout: 8000 }, async t => {
  const f = fixture(t), gate = f.gate();
  let oldCalls = 0, newCalls = 0;
  const name = f.mcp('shared', 'mcp__shared__read', async () => { oldCalls++; await gate.promise; return {}; });
  await f.load([name]);
  const first = f.run(name), queued = f.run(name);
  await until(() => oldCalls === 1); await flush();
  f.registry.removeOwned('runtime_mcp');
  f.mcp('shared', name, () => { newCalls++; return {}; });
  gate.resolve(); result(await first);
  const outcome = await queued;
  assert.equal(outcome.kind, 'failed'); assert.equal(outcome.error.code, 'tool_definition_changed');
  assert.equal(outcome.execution.dispatch, 'not_started');
  assert.equal(oldCalls, 1); assert.equal(newCalls, 0);
});

test('capacity leases retain writer ordering, cancellation and independent resources', async () => {
  const scheduler = new ToolResourceScheduler();
  const read = { key: 'server', mode: 'read', capacity: 2 };
  const first = await scheduler.acquire([read]), second = await scheduler.acquire([read]);
  let writer = false, later = false;
  const pendingWriter = scheduler.acquire([{ key: 'server', mode: 'write' }]).then(release => { writer = true; return release; });
  const pendingRead = scheduler.acquire([read]).then(release => { later = true; return release; });
  const cancel = new AbortController();
  const cancelled = scheduler.acquire([read], cancel.signal); cancel.abort(); await assert.rejects(cancelled);
  (await scheduler.acquire([{ key: 'other', mode: 'write' }]))();
  first(); await flush(); assert.equal(writer, false); assert.equal(later, false);
  second(); const release = await pendingWriter; assert.equal(later, false);
  release(); (await pendingRead)(); assert.equal(later, true);
  assert.throws(() => scheduler.acquire([{ ...read, capacity: 0 }]), /positive integer/);
});
