import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { promises as fsPromises } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { ToolRegistry, ToolExecutionCoordinator, ToolExecutionStore, InMemoryRuntimeEventLog, InMemoryRuntimeHost, registerWorkspaceTools, registerExtendedBuiltins } from '../dist/index.js';
import { ToolResourceScheduler } from '../dist/toolResourceScheduler.js';
import { RuntimeTaskTools } from '../dist/taskTools.js';
import { RuntimeAsyncJobs } from '../dist/runtimeAsyncJobs.js';
import { registerAsyncInteraction } from '../dist/interactionTools.js';
import { RuntimeSolutionBroker } from '../dist/runtimeSolutionBroker.js';
import { registerToolScript } from '../dist/toolScript.js';
import { BackgroundToolCalls } from '../dist/backgroundToolCalls.js';
import { registerBuiltinToolDisclosure, synchronizeBuiltinSchemas } from '../dist/builtinToolDisclosure.js';
import { modelToolDefinitions } from '../dist/mcpToolDiscovery.js';
import { SubagentTaskStore } from '../dist/subagentTaskStore.js';
import { withToolFailureFacts } from '../dist/toolFailureFacts.js';
import { toolExecutionError } from '@cardbush/bush-protocol';
import { summarizeExecution } from '../dist/executionHistory.js';

const manifest = { effect_kind: 'observation', operation: 'fixture', owner: 'runtime', risk: 'low', dispatch_scope: 'session', mutating: false };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'cardbush-tools-unified-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-tools-unified-')); rmSync(root, { recursive: true, force: true }); });
  const registry = new ToolRegistry(), store = new ToolExecutionStore(), deliveries = [], controller = new AbortController();
  t.after(() => controller.abort());
  const jobs = new RuntimeAsyncJobs(store, (_s, _t, id, message) => deliveries.push({ id, message }));
  const broker = new RuntimeSolutionBroker(new InMemoryRuntimeEventLog());
  const background = new BackgroundToolCalls(registry, () => {});
  const tasks = new RuntimeTaskTools((ctx, promises, mode, signal, duration) => background.waitForWork(ctx.sessionId, ctx.turnId, promises, mode, signal, duration));
  tasks.addSource(jobs.source); tasks.register(registry);
  registerWorkspaceTools(registry); registerExtendedBuiltins(registry, { dataRoot: root });
  registerToolScript(registry, jobs); registerAsyncInteraction(registry, broker, jobs); registerBuiltinToolDisclosure(registry);
  const request = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture', tools: [], messages: [], metadata: { workspaceDir: root }, permissionMode: 'all_free', requestCapabilities: { interactiveRequests: true } };
  const coordinator = new ToolExecutionCoordinator({ registry, observer: { completed: (call, identity, outcome) => store.record(call, identity, outcome) } });
  let ordinal = 0;
  const run = async (name, input, signal, sessionId = 's') => {
    const call = { protocol: 'bush.tool_call.v1', id: 'call-' + (++ordinal), name, argumentsText: JSON.stringify(input) };
    const identity = { requestId: 'r', sessionId, turnId: 't', round: 1, ordinal };
    request.tools = registry.definitions();
    const outcome = await coordinator.execute(call, identity, signal, { request: { ...request, sessionId }, contextMessages: [], signal: controller.signal });
    store.record(call, identity, outcome); return outcome;
  };
  const add = (name, execute, extra = {}) => registry.register({ definition: { name, description: 'Fixture', inputSchema: { type: 'object' } }, manifest, decodeInput: x => x, execute, ...extra });
  const script = async code => {
    const start = await run('run_tools', { code }); assert.equal(start.kind, 'returned', JSON.stringify(start));
    const completion = JSON.parse((await deliveries.find(item => item.id === start.result.task_id).message).content);
    return { start, completion };
  };
  return { root, registry, store, jobs, deliveries, broker, tasks, background, controller, request, run, add, script };
}

test('resource scheduler allows independent work and readers, respects a queued writer, and removes aborted waiters', async () => {
  const scheduler = new ToolResourceScheduler();
  const a = await scheduler.acquire([{ key: 'a', mode: 'read' }]);
  const b = await scheduler.acquire([{ key: 'a', mode: 'read' }]);
  let writer = false, later = false;
  const writing = scheduler.acquire([{ key: 'a', mode: 'write' }]).then(release => { writer = true; return release; });
  const reading = scheduler.acquire([{ key: 'a', mode: 'read' }]).then(release => { later = true; return release; });
  const independent = await scheduler.acquire([{ key: 'b', mode: 'write' }]); independent();
  await delay(5); assert.equal(writer, false); assert.equal(later, false);
  a(); b(); const releaseWriter = await writing; assert.equal(later, false); releaseWriter(); (await reading)();
  const hold = await scheduler.acquire([{ key: 'a', mode: 'write' }]), cancel = new AbortController();
  const pending = scheduler.acquire([{ key: 'a', mode: 'write' }], cancel.signal); cancel.abort(); await assert.rejects(pending); hold();
  (await scheduler.acquire([{ key: 'a', mode: 'write' }]))();
});

test('abort reports uncertain effects and retains the resource lease until an ignored-abort executor actually ends', async t => {
  const f = fixture(t), gate = Promise.withResolvers(); let count = 0;
  f.add('writer', async () => { count++; await gate.promise; return {}; }, { manifest: { ...manifest, mutating: true }, resources: () => [{ key: 'shared', mode: 'write' }] });
  const controller = new AbortController(), first = f.run('writer', {}, controller.signal);
  await delay(5); controller.abort();
  const cancelled = await first; assert.equal(cancelled.execution.effects, 'possible'); assert.equal(cancelled.execution.result, 'unknown');
  const second = f.run('writer', {}); await delay(5); assert.equal(count, 1);
  gate.resolve(); assert.equal((await second).kind, 'returned'); assert.equal(count, 2);
});

test('parallel_tools refuses state-changing and non-nestable calls before any child runs', async t => {
  const f = fixture(t); let count = 0;
  f.add('mutator', () => { count++; return {}; }, { parallelSafe: true, manifest: { ...manifest, mutating: true } });
  f.add('reader', () => { count++; return {}; }, { parallelSafe: true });
  const result = await f.run('parallel_tools', { tool_calls: [{ name: 'mutator', arguments: {} }, { name: 'reader', arguments: {} }] });
  assert.equal(result.kind, 'failed'); assert.equal(count, 0); assert.match(result.error.message, /read-only/);
});

test('recovery facts distinguish read retries, permanent errors and uncertain nested mutations', async t => {
  const f = fixture(t);
  for (const [index, status, retryable, mutating, recovery] of [
    [0, 503, undefined, false, 'retry'], [1, 400, true, false, 'correct_input'],
    [2, 503, false, false, 'correct_input'], [3, 503, true, true, 'inspect_existing'],
  ]) {
    const name = `failure_${index}`;
    f.add(name, () => { throw Object.assign(new Error('Structured failure'), { status, ...(retryable === undefined ? {} : { retryable }) }); }, { manifest: { ...manifest, mutating } });
    const result = await f.run(name, {}); assert.equal(result.execution.recovery, recovery);
    assert.deepEqual(result.error.details.execution, result.execution);
  }
  f.add('delegate', context => context.invokeTool('failure_3', {}, { record: true }), { delegatesToolExecution: true });
  const delegated = await f.run('delegate', {});
  assert.equal(delegated.execution.effects, 'possible'); assert.equal(delegated.execution.recovery, 'inspect_existing');
});

test('completion journal failures settle the task and retain an explicit inspect-before-retry result', async t => {
  const f = fixture(t), receipts = [];
  const broken = new RuntimeAsyncJobs({ record() { throw new Error('Journal unavailable'); } }, (_s, _t, _id, message) => receipts.push(message));
  broken.start({ ...f.request, toolCall: { id: 'j' }, turn: { signal: f.controller.signal }, actionManifest: manifest }, 'script', async () => ({ saved: true }));
  const receipt = JSON.parse((await receipts[0]).content);
  assert.equal(receipt.status, 'failed'); assert.equal(receipt.result.recovery, 'inspect_existing');
  assert.match(receipt.result.note, /could not be saved/);
});

test('executor failure facts are trusted only in process and cannot erase nested effects', async t => {
  const f = fixture(t), noEffects = { effects: 'none', result: 'known' };
  f.add('preflight', () => { throw withToolFailureFacts(new Error('Invalid operation'), noEffects); }, { manifest: { ...manifest, mutating: true } });
  const known = await f.run('preflight', {});
  assert.deepEqual(known.execution, { dispatch: 'started', ...noEffects, recovery: 'correct_input' });
  f.add('untrusted', () => { throw Object.assign(new Error('Remote assertion'), { details: { execution: { ...noEffects, recovery: 'retry' } } }); }, { manifest: { ...manifest, mutating: true } });
  const unknown = await f.run('untrusted', {});
  assert.deepEqual(unknown.execution, { dispatch: 'started', effects: 'possible', result: 'unknown', recovery: 'inspect_existing' });
  assert.deepEqual(unknown.error.details.execution, unknown.execution);
  f.add('delegate_known_failure', async context => {
    try { await context.invokeTool('untrusted', {}); }
    catch (error) { throw withToolFailureFacts(error, noEffects); }
  }, { delegatesToolExecution: true });
  const nested = await f.run('delegate_known_failure', {});
  assert.deepEqual(nested.execution, unknown.execution, 'nested uncertainty wins over parent-local facts');
  f.add('delegate_recorded_write', async context => {
    await context.invokeTool('write_file', { path: 'recorded.md', content: 'saved' });
    throw withToolFailureFacts(new Error('Local validation failed after the child'), noEffects);
  }, { delegatesToolExecution: true });
  const written = await f.run('delegate_recorded_write', {});
  assert.equal(readFileSync(join(f.root, 'recorded.md'), 'utf8'), 'saved');
  assert.deepEqual(written.execution, { dispatch: 'started', effects: 'recorded', result: 'known', recovery: 'inspect_existing' });
});

test('pre-dispatch facts propagate through delegation and cannot erase earlier child execution', async t => {
  const f = fixture(t);
  const facts = { dispatch: 'not_started', effects: 'none', result: 'known', recovery: 'retry' };
  f.add('blocked_before_dispatch', () => { throw withToolFailureFacts(new Error('Admission blocked'), facts); }, { manifest: { ...manifest, mutating: true } });
  f.add('delegate_preflight', context => context.invokeTool('blocked_before_dispatch', {}), { delegatesToolExecution: true, manifest: { ...manifest, mutating: true } });
  assert.deepEqual((await f.run('delegate_preflight', {})).execution, facts);
  f.add('write_then_preflight', async context => {
    await context.invokeTool('write_file', { path: 'before-preflight.md', content: 'keep this change' }, { record: true });
    return context.invokeTool('blocked_before_dispatch', {});
  }, { delegatesToolExecution: true, manifest: { ...manifest, mutating: true } });
  assert.deepEqual((await f.run('write_then_preflight', {})).execution,
    { dispatch: 'started', effects: 'recorded', result: 'known', recovery: 'inspect_existing' });
  assert.equal(readFileSync(join(f.root, 'before-preflight.md'), 'utf8'), 'keep this change');
  f.add('read_only_child', () => ({ observed: true }));
  f.add('read_then_preflight', async context => {
    await context.invokeTool('read_only_child', {});
    throw withToolFailureFacts(new Error('Local preflight failed'), facts);
  }, { delegatesToolExecution: true });
  assert.equal((await f.run('read_then_preflight', {})).execution.dispatch, 'started');
  let localEffect = false;
  f.add('ordinary_mutator', context => {
    localEffect = true;
    return context.invokeTool('blocked_before_dispatch', {});
  }, { manifest: { ...manifest, mutating: true } });
  assert.deepEqual((await f.run('ordinary_mutator', {})).execution,
    { dispatch: 'started', effects: 'possible', result: 'unknown', recovery: 'inspect_existing' },
    'an ordinary executor may have its own effects before a child is rejected');
  assert.ok(localEffect);
});

test('async script failures keep task, native journal, summaries and history in agreement', async t => {
  const f = fixture(t);
  f.add('fail_after_write', () => { throw Object.assign(new Error('Fixture failure'), { code: 'fixture_failure' }); });
  const { start, completion } = await f.script('await tools.write_file({path:"partial.md",content:"saved"}); return await tools.fail_after_write({});');
  assert.equal(completion.status, 'failed');
  assert.equal(completion.result.value.error.code, 'fixture_failure');
  assert.equal(completion.result.value.recovery, 'inspect_existing');
  const record = f.store.get('s', 't', start.result.task_id);
  assert.equal(record.outcome, 'failed');
  assert.equal(record.error.code, 'fixture_failure');
  assert.equal(toolExecutionError(record).code, 'fixture_failure');
  assert.equal(record.error.details.recovery, 'inspect_existing');
  const summary = f.store.listTurnSummaries('s', 't').find(item => item.toolCall.id === start.result.task_id);
  assert.equal(summary.outcome, 'failed');
  assert.equal(summary.error.code, 'fixture_failure');
  assert.equal(summarizeExecution(record).outcome, 'failed');
  assert.match(summarizeExecution(record).summary, /fixture_failure/);
  assert.equal(readFileSync(join(f.root, 'partial.md'), 'utf8'), 'saved');
  const inspected = await f.run('tasks', { action: 'inspect', task_ids: [start.result.task_id] });
  assert.equal(inspected.result.tasks[0].status, 'failed');
  assert.equal(inspected.result.tasks[0].result.locator, completion.result.locator);
});

test('stopped scripts keep cancelled receipts and completed children remain recorded', async t => {
  const f = fixture(t), waiting = Promise.withResolvers();
  f.add('wait_for_stop', context => new Promise((resolve, reject) => {
    const cancel = () => reject(context.signal.reason);
    context.signal.addEventListener('abort', cancel, { once: true });
    waiting.resolve();
  }));
  const start = await f.run('run_tools', { code: 'await tools.write_file({path:"before-stop.md",content:"saved"}); return await tools.wait_for_stop({});' });
  await waiting.promise;
  const stopped = await f.run('tasks', { action: 'stop', task_ids: [start.result.task_id] });
  assert.equal(stopped.result.controls[0].result.stop_requested, true);
  const completion = JSON.parse((await f.deliveries.find(item => item.id === start.result.task_id).message).content);
  assert.equal(completion.status, 'cancelled');
  assert.equal(completion.result.value.error.code, 'async_task_cancelled');
  const record = f.store.get('s', 't', start.result.task_id);
  assert.equal(record.outcome, 'cancelled');
  assert.equal(record.error.kind, 'cancelled');
  assert.equal(summarizeExecution(record).outcome, 'cancelled');
  assert.equal(f.store.listTurnSummaries('s', 't').find(item => item.toolCall.id === start.result.task_id).outcome, 'cancelled');
  assert.equal(readFileSync(join(f.root, 'before-stop.md'), 'utf8'), 'saved');
});

test('successful async scripts keep error-looking business values as ordinary results', async t => {
  const f = fixture(t);
  const { start, completion } = await f.script('return {error:{code:"business_value",message:"example"}};');
  assert.equal(completion.status, 'completed');
  const record = f.store.get('s', 't', start.result.task_id);
  assert.equal(record.outcome, 'returned');
  assert.equal(toolExecutionError(record), undefined);
  assert.equal(record.result.result.error.code, 'business_value');
  assert.equal(summarizeExecution(record).outcome, 'returned');
});

test('cancelling an unanswered async question persists cancellation without inferring an answer', async t => {
  const f = fixture(t);
  const start = await f.run('request_user_input_async', { prompt: 'Choose a fixture version', options: ['Current', 'Previous'] });
  await f.run('tasks', { action: 'stop', task_ids: [start.result.task_id] });
  const completion = JSON.parse((await f.deliveries.find(item => item.id === start.result.task_id).message).content);
  assert.equal(completion.status, 'cancelled');
  assert.equal(completion.result.value.recovery, 'do_not_retry');
  assert.equal(completion.result.value.error.kind, 'cancelled');
  const record = f.store.get('s', 't', start.result.task_id);
  assert.equal(record.outcome, 'cancelled');
  assert.equal(record.error.code, 'async_task_cancelled');
  assert.equal(summarizeExecution(record).outcome, 'cancelled');
  assert.equal(record.result, undefined);
});

test('patch preflight is all-or-none and a successful add/update/move/delete retains undo evidence', async t => {
  const f = fixture(t);
  writeFileSync(join(f.root, 'a.md'), '中文\r\nold\r\n'); writeFileSync(join(f.root, 'delete.md'), 'gone\n');
  for (const path of ['a.md', 'delete.md']) await f.run('read_file', { path });
  const invalid = await f.run('apply_patch', { patch: '*** Begin Patch\n*** Add File: untouched.md\n+new\n*** Update File: a.md\n@@\n-missing\n+new\n*** End Patch' });
  assert.equal(invalid.kind, 'failed'); assert.equal(existsSync(join(f.root, 'untouched.md')), false); assert.match(readFileSync(join(f.root, 'a.md'), 'utf8'), /old/);
  assert.deepEqual(invalid.execution, { dispatch: 'started', effects: 'none', result: 'known', recovery: 'correct_input' });
  assert.deepEqual(invalid.error.details.execution, invalid.execution);
  assert.deepEqual(f.store.listByTool('s', 'apply_patch')[0].execution, invalid.execution, 'journal preserves the same facts');
  const applied = await f.run('apply_patch', { patch: '*** Begin Patch\n*** Update File: a.md\n*** Move to: nested/moved.md\n@@\n 中文\n-old\n+新\n*** Delete File: delete.md\n*** Add File: add.md\n+added\n*** End Patch' });
  assert.equal(applied.kind, 'returned', JSON.stringify(applied)); assert.equal(applied.workspaceChanges.length, 4);
  assert.equal(readFileSync(join(f.root, 'nested/moved.md'), 'utf8'), '中文\r\n新\r\n');
  assert.equal(existsSync(join(f.root, 'a.md')), false); assert.equal(existsSync(join(f.root, 'delete.md')), false);
  assert.equal(applied.workspaceChanges.find(item => item.path.endsWith('a.md')).metadata.beforeContentBase64, Buffer.from('中文\r\nold\r\n').toString('base64'));
});

test('patch rejects stale revisions, duplicate aliases and ambiguous hunks without writing', async t => {
  const f = fixture(t), path = join(f.root, 'a.md'); writeFileSync(path, 'one\none\n'); await f.run('read_file', { path });
  const ambiguous = await f.run('apply_patch', { patch: '*** Begin Patch\n*** Update File: a.md\n@@\n-one\n+two\n*** End Patch' });
  assert.equal(ambiguous.kind, 'failed'); assert.match(ambiguous.error.message, /ambiguous/);
  const duplicate = await f.run('apply_patch', { patch: '*** Begin Patch\n*** Delete File: a.md\n*** Delete File: ./a.md\n*** End Patch' });
  assert.equal(duplicate.kind, 'failed'); assert.equal(readFileSync(path, 'utf8'), 'one\none\n');
  writeFileSync(path, 'changed'); const stale = await f.run('apply_patch', { patch: '*** Begin Patch\n*** Delete File: a.md\n*** End Patch' });
  assert.equal(stale.kind, 'failed'); assert.equal(readFileSync(path, 'utf8'), 'changed');
  for (const result of [ambiguous, duplicate, stale]) assert.deepEqual(result.execution,
    { dispatch: 'started', effects: 'none', result: 'known', recovery: 'correct_input' });
});

test('an I/O failure after the first patch write restores prior bytes and retains no phantom changes', async t => {
  const f = fixture(t), path = join(f.root, 'a.md'); writeFileSync(path, 'before\n'); await f.run('read_file', { path });
  const original = fsPromises.writeFile; let sawFirstWrite = false;
  const mocked = t.mock.method(fsPromises, 'writeFile', async (target, ...args) => {
    if (String(target).endsWith('b.md')) { sawFirstWrite = readFileSync(path, 'utf8') === 'after\n'; throw Object.assign(new Error('Disk rejected the second write'), { code: 'EIO' }); }
    return original(target, ...args);
  });
  syncBuiltinESMExports();
  try {
    const result = await f.run('apply_patch', { patch: '*** Begin Patch\n*** Update File: a.md\n@@\n-before\n+after\n*** Add File: b.md\n+new\n*** End Patch' });
    assert.ok(sawFirstWrite); assert.equal(result.kind, 'failed'); assert.match(result.error.message, /rolled back/);
    assert.equal(readFileSync(path, 'utf8'), 'before\n'); assert.equal(existsSync(join(f.root, 'b.md')), false); assert.equal(result.workspaceChanges.length, 0);
    assert.deepEqual(result.execution, { dispatch: 'started', effects: 'possible', result: 'unknown', recovery: 'inspect_existing' });
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test('a patch that cannot restore a write keeps recorded effects and requires inspection', async t => {
  const f = fixture(t), path = join(f.root, 'a.md'); writeFileSync(path, 'before\n'); await f.run('read_file', { path });
  const original = fsPromises.writeFile;
  const mocked = t.mock.method(fsPromises, 'writeFile', async (target, ...args) => {
    if (String(target).endsWith('b.md')) {
      writeFileSync(path, 'changed externally\n');
      throw Object.assign(new Error('Second write failed'), { code: 'EIO' });
    }
    return original(target, ...args);
  });
  syncBuiltinESMExports();
  try {
    const result = await f.run('apply_patch', { patch: '*** Begin Patch\n*** Update File: a.md\n@@\n-before\n+after\n*** Add File: b.md\n+new\n*** End Patch' });
    assert.equal(result.error.code, 'patch_partial_failure');
    assert.equal(readFileSync(path, 'utf8'), 'changed externally\n');
    assert.equal(result.workspaceChanges.length, 1);
    assert.deepEqual(result.error.details.remaining_paths, [path]);
    assert.deepEqual(result.execution, { dispatch: 'started', effects: 'recorded', result: 'unknown', recovery: 'inspect_existing' });
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
});

test('async question yields immediately, independent tools run, answer arrives once, and other sessions cannot inspect it', async t => {
  const f = fixture(t); f.add('independent', () => ({ done: true }));
  const start = await f.run('request_user_input_async', { prompt: '请确认这份报告中应该保留哪个版本的数据？', options: ['保留当前版本', '采用已校验的新版本'] });
  assert.equal(start.kind, 'returned'); const id = start.result.task_id;
  assert.equal(f.broker.list('s')[0].blocking, false);
  assert.equal((await f.run('independent', {})).result.done, true);
  const waiting = await f.run('tasks', { action: 'wait', task_ids: [id], yield_time_ms: 5 });
  assert.equal(waiting.kind, 'returned', JSON.stringify(waiting)); assert.equal(waiting.result.tasks[0].status, 'waiting_user');
  assert.equal((await f.run('tasks', { action: 'inspect', task_ids: [id] }, undefined, 'other')).kind, 'failed');
  const request = f.broker.list('s')[0]; f.broker.answer({ selectionId: request.selectionId, sessionId: 's', turnId: 't', kind: 'option', optionIndex: 1 });
  await f.deliveries[0].message;
  const result = await f.run('tasks', { action: 'inspect', task_ids: [id] });
  assert.equal(result.result.tasks[0].result.value.text, '采用已校验的新版本');
  const repeat = await f.run('tasks', { action: 'inspect', task_ids: [id], after: result.result.after });
  assert.equal(repeat.result.tasks[0].unchanged, true); assert.equal('result' in repeat.result.tasks[0], false);
  assert.equal(f.deliveries.length, 1);
});

test('task waits yield and abort without stopping work; stopping and cancelling observation are distinct', async t => {
  const f = fixture(t), gate = Promise.withResolvers(); let status = 'running', stopped = 0, unwatched = 0;
  f.tasks.addSource(() => [{ task_id: 'manual', kind: 'terminal', status, revision: status, wait: () => gate.promise,
    stop: async () => { stopped++; status = 'stopped'; gate.resolve(); return { stopped: true }; }, cancelObservation: () => { unwatched++; } }]);
  assert.equal((await f.run('tasks', { action: 'wait', yield_time_ms: 5 })).result.wake_reason, 'yield_timeout');
  const controller = new AbortController(), pending = f.run('tasks', { action: 'wait', yield_time_ms: 30000 }, controller.signal);
  await delay(5); controller.abort(); assert.equal((await pending).kind, 'cancelled'); assert.equal(stopped, 0);
  await f.run('tasks', { action: 'cancel_observation', task_ids: ['manual'] }); assert.equal(unwatched, 1); assert.equal(stopped, 0);
  await f.run('tasks', { action: 'stop', task_ids: ['manual'] }); assert.equal(stopped, 1);
});

test('progressive schemas stay fixed while complete receipts enable invocation until compaction', async t => {
  const f = fixture(t);
  f.add('subagent', () => ({}));
  // Replace fixture with a realistic large config schema.
  const definition = f.registry.resolve('subagent').definition;
  definition.inputSchema.properties = { action: {}, prompt: {}, agent: { description: 'config '.repeat(500) }, settings: {} };
  f.request.tools = f.registry.definitions();
  const compact = modelToolDefinitions(f.registry, f.request);
  assert.equal(compact.find(tool => tool.name === 'subagent').inputSchema.properties.agent, undefined);
  assert.equal(compact.some(tool => tool.name === 'parallel_tools'), false);
  const receipt = (await f.run('get_tool_schema', { name: 'subagent' })).result;
  synchronizeBuiltinSchemas(f.registry, f.request, [{ role: 'assistant', content: '', toolCalls: [{ id: 'load', name: 'get_tool_schema', argumentsText: '{"name":"subagent"}' }] }, { role: 'tool', toolCallId: 'load', content: JSON.stringify(receipt) }]);
  assert.ok(f.request.metadata.builtinToolSchemas.subagent);
  assert.deepEqual(modelToolDefinitions(f.registry, f.request), compact);
  synchronizeBuiltinSchemas(f.registry, f.request, []);
  assert.equal(f.request.metadata.builtinToolSchemas.subagent, undefined);
  assert.deepEqual(modelToolDefinitions(f.registry, f.request), compact);
  const serialized = JSON.stringify(receipt), locator = 'tool-result://s/t/load', middle = Math.floor(serialized.length / 2);
  const messages = [{ role: 'assistant', content: '', toolCalls: [{ id: 'load', name: 'get_tool_schema', argumentsText: '{}' }] },
    { role: 'tool', toolCallId: 'load', content: JSON.stringify({ archived: true, locator, originalChars: serialized.length }) }];
  for (const [index, start, end] of [[0, 0, middle], [1, middle, serialized.length]]) {
    messages.push({ role: 'assistant', content: '', toolCalls: [{ id: `chunk-${index}`, name: 'read_archived_tool_result', argumentsText: '{}' }] },
      { role: 'tool', toolCallId: `chunk-${index}`, content: JSON.stringify({ locator, offset: start, next_offset: end }) + '\n\n[text]\n' + serialized.slice(start, end) });
    synchronizeBuiltinSchemas(f.registry, f.request, messages);
    assert.equal(!!f.request.metadata.builtinToolSchemas.subagent, index === 1, 'only a completely read archive enables invocation');
    assert.deepEqual(modelToolDefinitions(f.registry, f.request), compact);
  }
});

test('scripts transform data without exposing host APIs and nested calls retain normal receipts', async t => {
  const f = fixture(t); f.add('rows', () => ({ rows: [3, 7, 1] }), { parallelSafe: true });
  const { completion } = await f.script('const data = await tools.rows({}); return {top: data.rows.sort((a,b)=>b-a).slice(0,2), host: [typeof process, typeof require, typeof fetch]};');
  assert.equal(completion.status, 'completed', JSON.stringify(completion));
  assert.deepEqual(completion.result.value.result, { top: [7, 3], host: ['undefined', 'undefined', 'undefined'] });
  assert.equal(completion.result.value.calls, 1);
  assert.ok(f.store.listTurn('s', 't').some(record => record.toolCall.name === 'rows'));
});

test('script requests do not bypass exposure, permissions or non-nestable tools', async t => {
  const f = fixture(t); let writes = 0;
  f.add('denied', () => { writes++; return {}; }, { manifest: { ...manifest, mutating: true }, authorize: () => ({ kind: 'deny', code: 'fixture_denied', message: 'Denied' }) });
  const denied = await f.script('return await tools.denied({});'); assert.equal(denied.completion.status, 'failed'); assert.equal(writes, 0);
  const nested = await f.script('return await tools.run_tools({code:"return 1"});'); assert.equal(nested.completion.status, 'failed');
  const scope = await f.script('return await tools.does_not_exist({});'); assert.equal(scope.completion.status, 'failed');
});

test('script CPU and promise limits fail promptly; independent work proceeds during tool waits', async t => {
  const f = fixture(t), gate = Promise.withResolvers(); f.add('slow', () => gate.promise, { parallelSafe: true });
  const before = Date.now(), infinite = await f.script('for (;;) {}');
  assert.equal(infinite.completion.status, 'failed'); assert.ok(Date.now() - before < 2000);
  const stalled = await f.script('await new Promise(() => {});'); assert.equal(stalled.completion.status, 'failed');
  const start = await f.run('run_tools', { code: 'return await tools.slow({});' });
  const snapshot = await f.run('tasks', { action: 'wait', task_ids: [start.result.task_id], yield_time_ms: 0 });
  assert.equal(snapshot.result.tasks[0].status, 'running');
  gate.resolve({ ready: true }); await f.deliveries.at(-1).message;
});

test('subagent completion subscriptions are cancelled independently and do not consume results', async () => {
  const store = new SubagentTaskStore(); store.start({ taskId: 'a', parentSessionId: 'p', parentTurnId: 't', childSessionId: 'c', childTurnId: 'u', prompt: 'work', inheritContext: false, inheritedMessageCount: 0 });
  const controller = new AbortController(), pending = store.waitForCompletion('p', 'a', controller.signal); controller.abort(); await assert.rejects(pending);
  assert.equal(store.get('p', 'a').status, 'running');
  const next = store.waitForCompletion('p', 'a', new AbortController().signal);
  store.finish({ parentSessionId: 'p', taskId: 'a', status: 'completed', finalResponse: 'done', errorMessage: '', usage: {} });
  await next; assert.equal(store.get('p', 'a').finalResponse, 'done');
});

test('unavailable task sources do not prevent inspecting independent tasks, and guidance cleans up waiters', async t => {
  const f = fixture(t); f.tasks.addSource(() => { throw new Error('Remote connection unavailable'); });
  f.tasks.addSource(() => [{ task_id: 'done', kind: 'script', status: 'completed', revision: '1', result: { answer: 42 } }]);
  const result = await f.run('tasks', { action: 'inspect', task_ids: ['done'] });
  assert.equal(result.kind, 'returned'); assert.equal(result.result.complete, false); assert.equal(result.result.tasks[0].result.answer, 42);
  const store = new SubagentTaskStore(); store.start({ taskId: 'a', parentSessionId: 's', parentTurnId: 't', childSessionId: 'c', childTurnId: 'u', prompt: 'work', inheritContext: false, inheritedMessageCount: 0 });
  const immediateGuidance = new RuntimeTaskTools(async () => 'user_message');
  const registry = new ToolRegistry(); immediateGuidance.addSource(() => [{ task_id: 'a', kind: 'subagent', status: 'running', revision: '1', wait: signal => store.waitForCompletion('s', 'a', signal) }]); immediateGuidance.register(registry);
  const tool = registry.resolve('tasks');
  assert.equal((await tool.execute({ input: tool.decodeInput({ action: 'wait' }) })).wake_reason, 'user_message');
  await delay(5); // No unhandled rejection from the abandoned completion subscription.
});

for (const mode of ['question', 'script']) test(`host model loop continues independent work while ${mode} is pending and delivers its result`, async t => {
  const f = fixture(t), gate = Promise.withResolvers(); let host, independent = false, round = 0; const requests = [];
  const registry = new ToolRegistry();
  registry.register({ definition: { name: 'fixture_data', description: 'Fixture data', inputSchema: { type: 'object' } }, manifest, parallelSafe: true, decodeInput: x => x, execute: () => gate.promise });
  registry.register({ definition: { name: 'independent', description: 'Independent operation', inputSchema: { type: 'object' } }, manifest, decodeInput: x => x, execute: () => { independent = true; gate.resolve({ rows: [9, 2, 5] }); return { done: true }; } });
  host = new InMemoryRuntimeHost({ dataRoot: f.root, toolRegistry: registry, provider: { async *stream(request) {
    requests.push(request); round++;
    const event = (sequence, kind, rest = {}) => ({ protocol: 'bush.model_event.v1', requestId: request.requestId, sequence, kind, createdAt: new Date().toISOString(), ...rest });
    if (round <= 2) {
      const name = round === 2 ? 'independent' : mode === 'question' ? 'request_user_input_async' : 'run_tools';
      const input = round === 2 ? {} : mode === 'question' ? { prompt: '报告采用哪个已核实的数据版本？', options: ['最新版本', '上个版本'] } : { code: 'const r = await tools.fixture_data({}); return r.rows.sort((a,b)=>b-a).slice(0,2);' };
      yield event(0, 'tool_call_delta', { index: 0, toolCallId: `call-${round}`, nameDelta: name, argumentsDelta: JSON.stringify(input) });
      yield event(1, 'response_completed', { finishReason: 'tool_calls' }); return;
    }
    assert.ok(independent);
    if (mode === 'question') {
      const pending = await host.sendCommand({ kind: 'runtime.list_solution_selections', payload: { sessionId: 'host-session' } });
      if (pending.length) await host.sendCommand({ kind: 'runtime.answer_solution_selection', payload: { selectionId: pending[0].selectionId, sessionId: 'host-session', turnId: 'host-turn', kind: 'option', optionIndex: 0 } });
    }
    yield event(0, 'text_delta', { delta: '完成。' }); yield event(1, 'response_completed', { finishReason: 'stop' });
  } } });
  const terminal = await host.runModelTurn({ protocol: 'bush.model_request.v1', requestId: 'host-request', sessionId: 'host-session', turnId: 'host-turn', model: 'fixture',
    messages: [{ role: 'user', content: '同时处理独立工作。' }], tools: registry.definitions(), permissionMode: 'all_free', requestCapabilities: { interactiveRequests: true }, metadata: { workspaceDir: f.root } });
  assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal));
  assert.ok(requests.some(request => request.messages.some(message => message.name === 'background_tool_result' && message.content.includes(mode === 'script' ? '9,5' : '最新版本'))));
  assert.equal(requests[0].tools.some(tool => tool.name === 'solution_selection'), false);
});
