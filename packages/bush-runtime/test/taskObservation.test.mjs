import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolRegistry, InMemoryRuntimeEventLog } from '../dist/index.js';
import { RuntimeTaskTools } from '../dist/taskTools.js';
import { RuntimeTurnSignals } from '../dist/turnSignals.js';
import { RuntimeTaskActivity } from '../dist/runtimeTaskProgress.js';

const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
test('default task wait survives many former timeout windows and remains interruptible without stopping work', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const signals = new RuntimeTurnSignals(), work = Promise.withResolvers(), registry = new ToolRegistry();
  let done = false, settled = false, duration;
  const tasks = new RuntimeTaskTools((ctx, promises, mode, signal, ms) => { duration = ms; return signals.wait(ctx.sessionId, ctx.turnId, promises, mode, signal, ms); });
  tasks.addSource(() => [{ task_id: 'child', kind: 'subagent', status: done ? 'completed' : 'running', revision: done ? '2' : '1', wait: () => work.promise }]);
  tasks.register(registry);
  const tool = registry.resolve('tasks'), context = { sessionId: 'parent', turnId: 'turn', input: tool.decodeInput({ action: 'wait', task_ids: ['child'] }) };
  const waiting = tool.execute(context).then(result => { settled = true; return result; });
  await flush();
  assert.equal(duration, undefined);
  for (let i = 0; i < 18; i++) { t.mock.timers.tick(30000); await flush(); assert.equal(settled, false); }
  signals.wake('parent', 'turn', 'user_message');
  assert.equal((await waiting).wake_reason, 'user_message'); assert.equal(done, false);
  const resumed = tool.execute(context); await flush(); done = true; work.resolve();
  assert.equal((await resumed).tasks[0].status, 'completed');
});

test('explicit timeouts, cancellation, snapshots and progress retain the task lifecycle', async () => {
  const registry = new ToolRegistry(), signals = new RuntimeTurnSignals(), work = Promise.withResolvers();
  const tasks = new RuntimeTaskTools((c, p, m, s, ms) => signals.wait(c.sessionId, c.turnId, p, m, s, ms));
  const progress = { phase: 'tools', model_requests: 2, completed_tool_calls: 8, failed_tool_calls: 1, active_tool_calls: 1 };
  tasks.addSource(() => [{ task_id: 'child', kind: 'subagent', status: 'running', revision: '1', progress, result: 'private result', wait: () => work.promise }]);
  tasks.register(registry); const tool = registry.resolve('tasks');
  const run = (input, signal) => tool.execute({ sessionId: 'p', turnId: 't', signal, input: tool.decodeInput(input) });
  const snapshot = await run({ action: 'wait', task_ids: ['child'], yield_time_ms: 0, after: { child: '1' } });
  assert.equal(snapshot.wake_reason, 'snapshot'); assert.deepEqual(snapshot.tasks[0].progress, progress); assert.equal(snapshot.tasks[0].result, undefined);
  assert.equal((await run({ action: 'wait', yield_time_ms: 1 })).wake_reason, 'yield_timeout');
  const controller = new AbortController(); const waiting = run({ action: 'wait' }, controller.signal);
  await flush(); controller.abort(); await assert.rejects(waiting, /abort/i);
  work.resolve('still runs'); assert.equal(await work.promise, 'still runs');
});

test('task progress counts activity, approvals, errors and compaction without retaining private payloads', () => {
  const activity = new RuntimeTaskActivity();
  const emit = (kind, payload = {}) => activity.observe({ kind, payload, createdAt: '2026-10-27T00:00:00Z' });
  emit('provider_input_observed', { secret: 'provider credentials' });
  emit('tool_queued', { toolCallId: 'one' }); emit('tool_queued', { toolCallId: 'two' });
  emit('permission_requested', { permissionId: 'p' }); assert.equal(activity.snapshot().phase, 'waiting_user');
  emit('permission_answered', { permissionId: 'p' });
  emit('tool_returned', { toolCallId: 'one', result: 'private file', resultError: { code: 'failed' } });
  emit('tool_failed', { toolCallId: 'two', error: 'private error' });
  emit('tool_returned', { toolCallId: 'one', result: 'async completion receipt', resultError: { code: 'failed' } });
  assert.equal(activity.snapshot().completed_tool_calls, 2, 'async receipts are not additional invocations');
  emit('solution_selection_requested', { selectionId: 'q', question: 'private question' });
  assert.equal(activity.snapshot().phase, 'waiting_user');
  emit('solution_selection_answered', { selectionId: 'q' });
  emit('context_compaction_started'); assert.equal(activity.snapshot().phase, 'compacting');
  emit('context_compaction_completed');
  emit('turn_terminal', { status: 'completed' });
  assert.deepEqual(activity.snapshot(), { phase: 'completed', last_activity_at: '2026-10-27T00:00:00Z', model_requests: 1, completed_tool_calls: 2, failed_tool_calls: 2, active_tool_calls: 0 });
});

test('progress is restored from journal once and returned as an independent snapshot', () => {
  const identity = { requestId: 'r', sessionId: 's', turnId: 't' }, first = new InMemoryRuntimeEventLog();
  first.append(identity, { kind: 'turn_accepted', payload: { status: 'accepted' } });
  let loads = 0;
  const log = new InMemoryRuntimeEventLog({ persistence: { load: () => { loads++; return first.replay('s', 't'); }, append: () => {} } });
  const p = log.taskProgress('s', 't'); p.model_requests = 999;
  assert.equal(log.taskProgress('s', 't').model_requests, 0); assert.equal(loads, 1);
  assert.equal(new InMemoryRuntimeEventLog().taskProgress('missing', 'missing'), undefined);
});

test('task pagination and explicit selection do not load unrelated child event histories', async () => {
  const registry = new ToolRegistry(), reads = [];
  const tasks = new RuntimeTaskTools(async () => 'task_completed');
  tasks.addSource(() => Array.from({ length: 100 }, (_, i) => ({
    task_id: String(i), kind: 'subagent', status: 'completed', revision: '1',
    readProgress: () => { reads.push(i); return { phase: 'completed', model_requests: i, completed_tool_calls: 0, failed_tool_calls: 0, active_tool_calls: 0 }; },
  })));
  tasks.register(registry); const tool = registry.resolve('tasks');
  const run = input => tool.execute({ sessionId: 's', turnId: 't', input: tool.decodeInput(input) });
  const page = await run({ action: 'list', offset: 20, limit: 2 });
  assert.deepEqual(reads, [20, 21]); assert.equal(page.total, 100);
  const selected = await run({ action: 'inspect', task_ids: ['98'], after: { 98: '1' } });
  assert.deepEqual(reads, [20, 21, 98]); assert.equal(selected.tasks[0].progress.model_requests, 98);
  assert.equal(selected.tasks[0].unchanged, true);
});
