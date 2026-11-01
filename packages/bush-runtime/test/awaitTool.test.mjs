import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../dist/index.js';
import { RuntimeTaskTools } from '../dist/taskTools.js';
import { RuntimeTurnSignals } from '../dist/turnSignals.js';
import { withToolDisplayTitle, stripToolDisplayTitle } from '../dist/toolDisplay.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(source = () => [], pending) {
  const registry = new ToolRegistry(), signals = new RuntimeTurnSignals(pending);
  const tasks = new RuntimeTaskTools((ctx, promises, mode, signal, duration) =>
    signals.wait(ctx.sessionId, ctx.turnId, promises, mode, signal, duration));
  tasks.addSource(source); tasks.register(registry);
  const run = (input = {}, overrides = {}, name = 'await') => {
    const tool = registry.resolve(name);
    return tool.execute({ sessionId: 's', turnId: 't', ...overrides, input: tool.decodeInput(input) });
  };
  return { registry, signals, run };
}

test('new catalogs have one host wait entry and keep frozen tasks(wait) executable', async () => {
  const f = fixture(() => [{ task_id: 'team-run', kind: 'team', status: 'completed', revision: '2', result: { output: 'verified fixture' } }]);
  const tasks = f.registry.resolve('tasks').definition;
  assert.ok(!tasks.inputSchema.properties.action.enum.includes('wait'));
  assert.equal(tasks.inputSchema.properties.mode, undefined);
  assert.equal(tasks.inputSchema.properties.yield_time_ms, undefined);
  assert.deepEqual(Object.keys(f.registry.resolve('await').definition.inputSchema.properties).sort(), ['after', 'mode', 'task_ids', 'yield_time_ms']);
  assert.equal(f.registry.resolve('await').directInvocation, true);
  assert.equal(f.registry.resolve('await').nestedCallable, false);
  const definition = f.registry.resolve('await').definition;
  assert.equal(withToolDisplayTitle(definition).inputSchema.properties._display_title, undefined, 'passive waiting needs no model-generated bilingual action prose');
  assert.deepEqual(stripToolDisplayTitle({ task_ids: ['team-run'], _display_title: 'legacy title' }, definition), { task_ids: ['team-run'] });
  assert.match(definition.description, /Team task_id\/run_id/);
  assert.match(definition.description, /plugins without waits.*start_mcp_tool.*declared read-only.*repeat_while.*host task_id/);
  assert.match(definition.description, /Plugin-native waits remain available/);
  for (const name of ['await_subagents', 'await_team_result', 'manage_tool_calls']) assert.equal(f.registry.resolve(name), undefined);
  const current = await f.run({ task_ids: ['team-run'] });
  const legacy = await f.run({ action: 'wait', task_ids: ['team-run'] }, {}, 'tasks');
  assert.deepEqual(current, legacy);
  assert.equal(current.tasks[0].result.output, 'verified fixture');
  assert.equal((await fixture().run({ action: 'wait' }, {}, 'tasks')).wake_reason, 'no_pending_tasks');
});

test('mixed Team and plugin handles share any/all and already-read completion semantics', async t => {
  const first = Promise.withResolvers(), second = Promise.withResolvers();
  const rows = [
    { task_id: 'team-run', kind: 'team', status: 'running', revision: '1', wait: () => first.promise },
    { task_id: 'mcp-observer', kind: 'mcp', status: 'running', revision: '1', wait: () => second.promise },
  ];
  const f = fixture(() => rows), controller = new AbortController(); t.after(() => controller.abort());
  const input = { task_ids: rows.map(row => row.task_id) }, overrides = { signal: controller.signal };
  const any = f.run(input, overrides); await flush();
  Object.assign(rows[0], { status: 'completed', revision: '2', result: 'Team output' }); first.resolve();
  const result = await any;
  assert.equal(result.wake_reason, 'task_completed'); assert.equal(result.tasks[1].status, 'running');
  let settled = false;
  const next = f.run({ ...input, after: result.after }, overrides).then(value => { settled = true; return value; });
  const all = f.run({ ...input, mode: 'all' }, overrides);
  await flush(); assert.equal(settled, false, 'an observed completion cannot starve another pending result');
  Object.assign(rows[1], { status: 'completed', revision: '2', result: 'Plugin output' }); second.resolve();
  assert.equal((await next).tasks[1].result, 'Plugin output');
  assert.ok((await all).tasks.every(row => row.status === 'completed'));
});

test('message-only waits need no task and all mode cannot resolve an empty promise set', async t => {
  let snapshots = 0;
  const f = fixture(() => { snapshots++; return []; }), controller = new AbortController(); t.after(() => controller.abort());
  let settled = false;
  const wait = f.run({ task_ids: [], mode: 'all' }, { signal: controller.signal }).then(value => { settled = true; return value; });
  await flush(); assert.equal(settled, false); assert.equal(snapshots, 0);
  f.signals.wake('other', 't', 'peer_message'); await flush(); assert.equal(settled, false);
  f.signals.wake('s', 't', 'peer_message');
  assert.equal((await wait).wake_reason, 'peer_message');
  const fallback = f.run({}, { signal: controller.signal }); await flush();
  f.signals.wake('s', 't', 'user_message');
  assert.equal((await fallback).wake_reason, 'user_message');
  assert.equal((await f.run({ task_ids: [], yield_time_ms: 0 })).wake_reason, 'snapshot');
});

test('queued messages, timeouts and cancellation stop observation without stopping work', async t => {
  let pending = true, stopped = false;
  const work = Promise.withResolvers();
  const f = fixture(() => [{ task_id: 'child', kind: 'subagent', status: 'running', revision: '1', wait: () => work.promise,
    stop: () => { stopped = true; } }], () => pending ? 'peer_message' : undefined);
  assert.equal((await f.run({ task_ids: ['child'] })).wake_reason, 'peer_message');
  pending = false;
  assert.equal((await f.run({ task_ids: ['child'], yield_time_ms: 1 })).wake_reason, 'yield_timeout');
  const controller = new AbortController(); t.after(() => controller.abort());
  const waiting = f.run({ task_ids: ['child'] }, { signal: controller.signal });
  await flush(); controller.abort(); await assert.rejects(waiting, /abort/i);
  assert.equal(stopped, false); work.resolve('still running to completion');
  assert.equal(await work.promise, 'still running to completion');
});

test('await validates ownership and every handle before subscribing or reading results', async () => {
  let effects = 0;
  const f = fixture(ctx => ctx.sessionId === 's' ? [{ task_id: 'owned', kind: 'team', status: 'running', revision: '1',
    wait: () => { effects++; return new Promise(() => {}); }, readResult: () => { effects++; } }] : []);
  for (const id of ['plugin-job-id', 'employee-id', 'foreign-task']) {
    await assert.rejects(f.run({ task_ids: ['owned', id] }), /not available in this conversation/);
  }
  await assert.rejects(f.run({ task_ids: ['owned'] }, { sessionId: 'other' }), /not available in this conversation/);
  assert.equal(effects, 0);
  const broken = fixture(() => { throw Error('remote status unavailable'); });
  const result = await broken.run();
  assert.equal(result.wake_reason, 'sources_unavailable'); assert.equal(result.complete, false);
});
