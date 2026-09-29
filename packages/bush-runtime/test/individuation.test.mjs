import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { checkHabitInputSchema, summaryForUserInputSchema } from '@cardbush/bush-protocol';
import { ToolRegistry, ToolExecutionCoordinator, ToolExecutionStore, InMemoryRuntimeHost,
  InMemoryRuntimeEventLog, RuntimeEventProjector } from '../dist/index.js';
import { registerIndividuationTools, hasPendingUserSummary } from '../dist/individuationTools.js';
import { IndividuationStore } from '../dist/individuationStore.js';

const off = { habits: false, predictions: false }, on = { habits: true, predictions: true };
const habit = { key: '答复偏好', content: '喜欢简洁、具体的答复', evidence: '用户明确要求减少重复内容。' };
const prediction = { key: 'review-release', trigger: '用户说准备发布了', action: '检查本次验证结果', reason: '发布前需要确认实际验证过的版本。' };
const summary = value => summaryForUserInputSchema.parse(value);
const check = value => checkHabitInputSchema.parse(value);
const owner = { sessionId: 'first', turnId: 'one' };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-individuation-'));
  t.after(async () => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); await rm(root, { recursive: true, force: true }); });
  const path = join(root, 'personalization.sqlite'), registry = new ToolRegistry();
  registerIndividuationTools(registry, path);
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request() { throw Error('Unexpected permission'); } } });
  let calls = 0;
  return { root, path, registry, store: new IndividuationStore(path), async run(name, args, settings = off, identity = owner) {
    const call = { protocol: 'bush.tool_call.v1', id: `call-${++calls}`, name, argumentsText: JSON.stringify(args) };
    return coordinator.execute(call, { requestId: 'r', ...identity, round: calls, ordinal: 0 }, undefined,
      { request: { metadata: { individuation: settings }, tools: registry.definitions(), permissionMode: 'task_free' }, contextMessages: [] });
  } };
}
const result = value => { assert.equal(value.kind, 'returned', JSON.stringify(value)); return value.result; };

test('both tools remain available and parallel-safe while disabled; final signal does not open a database', async t => {
  const f = await fixture(t), definitions = f.registry.definitions();
  for (const name of ['summary_for_user', 'check_habit']) assert.equal(f.registry.isParallelSafe(name), true);
  const saved = result(await f.run('summary_for_user', { habits: [habit], predictions: [prediction] }));
  assert.equal(saved.final_response, true); assert.equal(saved.status, 'ok');
  assert.deepEqual(saved.habit_ids, []); assert.deepEqual(saved.prediction_ids, []);
  const found = result(await f.run('check_habit', {}));
  assert.deepEqual(found.habits, []); assert.deepEqual(found.predictions, []);
  await assert.rejects(access(f.path), { code: 'ENOENT' });
  assert.deepEqual(f.registry.definitions(), definitions);
});

test('independent gates ignore model fields; enabled habits survive restart and are searchable across sessions', async t => {
  const f = await fixture(t);
  const saved = result(await f.run('summary_for_user', { habits: [habit], predictions: [prediction] }, { habits: true, predictions: false }));
  assert.equal(saved.habit_ids.length, 1); assert.equal(saved.prediction_ids.length, 0);
  const fresh = new IndividuationStore(f.path);
  const read = await fresh.check(check({ query: '简洁' }), on, { sessionId: 'other', turnId: 'two' });
  assert.equal(read.habits[0].content, habit.content); assert.equal(read.habits[0].source_session_id, 'first');
  assert.deepEqual(read.predictions, []);
  const before = await readFile(f.path);
  await f.run('summary_for_user', { habits: [{ ...habit, content: 'unauthorized overwrite' }], predictions: [prediction] });
  assert.deepEqual(result(await f.run('check_habit', {})).habits, []);
  assert.deepEqual(await readFile(f.path), before, 'off performs no DB IO');
  const predicted = result(await f.run('summary_for_user', { habits: [{ ...habit, content: 'ignored' }], predictions: [prediction] }, { habits: false, predictions: true }));
  assert.equal(predicted.prediction_ids.length, 1); assert.deepEqual(predicted.habit_ids, []);
  const limited = result(await f.run('check_habit', {}, { habits: false, predictions: true }));
  assert.deepEqual(limited.habits, []); assert.equal(limited.predictions.length, 1);
  assert.equal((await fresh.check(check({}), on, owner)).habits[0].content, habit.content);
});

test('prediction claims serialize cross-session execution and consumption cannot be forged or rearmed', async t => {
  const f = await fixture(t);
  const saved = await f.store.summarize(summary({ predictions: [prediction] }), on, owner);
  const id = saved.prediction_ids[0], a = { sessionId: 'a', turnId: 'ta' }, b = { sessionId: 'b', turnId: 'tb' };
  const claims = await Promise.all([a, b].map(who => new IndividuationStore(f.path).check(check({ claim_prediction_ids: [id] }), on, who)));
  assert.equal(claims.filter(c => c.claimed_prediction_ids.length).length, 1);
  const winner = claims[0].claimed_prediction_ids.length ? a : b, loser = winner === a ? b : a;
  const consumed = summary({ consumed_prediction_ids: [id] });
  assert.deepEqual((await f.store.summarize(consumed, on, loser)).consumed_prediction_ids, []);
  assert.deepEqual((await f.store.check(check({ release_prediction_ids: [id] }), on, loser)).released_prediction_ids, []);
  assert.deepEqual((await f.store.summarize(consumed, on, winner)).consumed_prediction_ids, [id]);
  assert.deepEqual((await f.store.summarize(consumed, on, winner)).consumed_prediction_ids, []);
  await f.store.summarize(summary({ predictions: [prediction] }), on, loser);
  assert.deepEqual((await f.store.check(check({}), on, loser)).predictions, []);
});

test('literal search, replacement, expiration and uncertain claims preserve meaningful records', async t => {
  const f = await fixture(t); let now = 1_000_000;
  const store = new IndividuationStore(f.path, () => now);
  const saved = await store.summarize(summary({ habits: [habit], predictions: [prediction, { ...prediction, key: 'pending' }] }), on, owner);
  await store.summarize(summary({ habits: [{ ...habit, content: '保持 100% 简洁' }] }), on, owner);
  assert.equal((await store.check(check({ query: '%' }), on, owner)).habits.length, 1);
  assert.equal((await store.check(check({ query: '%' }), on, owner)).predictions.length, 0);
  await store.check(check({ claim_prediction_ids: [saved.prediction_ids[0]] }), on, owner);
  now += 31 * 86_400_000;
  const remaining = await store.check(check({}), on, owner);
  assert.equal(remaining.habits.length, 1); assert.equal(remaining.predictions.length, 1);
  assert.equal(remaining.predictions[0].status, 'claimed', 'crash/timeout must not silently retry an uncertain action');
});

test('storage failure still returns a truthful final-answer signal', async t => {
  const f = await fixture(t), registry = new ToolRegistry();
  registerIndividuationTools(registry, f.root); // A directory cannot be opened as a SQLite database.
  const returned = await registry.resolve('summary_for_user').execute({ input: summary({ habits: [habit] }), ...owner,
    turn: { request: { metadata: { individuation: on } } } });
  assert.equal(returned.status, 'ok'); assert.equal(returned.final_response, true); assert.equal(returned.storage_status, 'unavailable');
});

test('cancelled persistence creates no file; a later turn can resolve its own interrupted claim', async t => {
  const f = await fixture(t), controller = new AbortController();
  controller.abort();
  await assert.rejects(f.store.summarize(summary({ habits: [habit] }), on, owner, controller.signal), { name: 'AbortError' });
  await assert.rejects(access(f.path), { code: 'ENOENT' });
  const saved = await f.store.summarize(summary({ predictions: [prediction] }), on, owner);
  const id = saved.prediction_ids[0];
  await f.store.check(check({ claim_prediction_ids: [id] }), on, owner);
  const resumed = { ...owner, turnId: 'recovered' };
  assert.deepEqual((await f.store.check(check({ claim_prediction_ids: [id] }), on, resumed)).claimed_prediction_ids, [], 'an old uncertain claim cannot simply be rerun');
  assert.deepEqual((await f.store.check(check({ release_prediction_ids: [id] }), on, resumed)).released_prediction_ids, [id]);
  assert.deepEqual((await f.store.check(check({ claim_prediction_ids: [id] }), on, resumed)).claimed_prediction_ids, [id]);
  assert.deepEqual((await f.store.summarize(summary({ consumed_prediction_ids: [id] }), on, resumed)).consumed_prediction_ids, [id]);
});

const event = (request, sequence, kind, payload = {}) => ({ protocol: 'bush.model_event.v1', requestId: request.requestId,
  createdAt: new Date().toISOString(), sequence, kind, ...payload });
async function until(predicate) {
  for (let index = 0; index < 500; index++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw Error('Expected runtime event did not arrive');
}

test('summary runs with parallel tools; next answer is final before done, while lifecycle remains running', async t => {
  const f = await fixture(t), sibling = Promise.withResolvers(), finish = Promise.withResolvers();
  const registry = new ToolRegistry();
  registry.register({ definition: { name: 'slow_probe', description: 'Independent work', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'observation', operation: 'probe', risk: 'low', owner: 'runtime', dispatch_scope: 'parent_session', mutating: false },
    parallelSafe: true, decodeInput: x => x, execute: () => sibling.promise });
  let rounds = 0;
  const host = new InMemoryRuntimeHost({ dataRoot: f.root, toolRegistry: registry, registerDefaultWorkspaceTools: false,
    provider: { async *stream(request) {
      rounds++;
      if (rounds === 1) {
        for (const [index, name] of ['slow_probe', 'summary_for_user'].entries()) yield event(request, index, 'tool_call_delta',
          { index, toolCallId: `c${index}`, nameDelta: name, argumentsDelta: '{}' });
        yield event(request, 2, 'response_completed', { finishReason: 'tool_calls' });
      } else {
        assert.equal(request.messages.filter(m => m.role === 'tool').length, 2);
        yield event(request, 0, 'text_delta', { delta: '已完成' });
        await finish.promise;
        yield event(request, 1, 'response_completed', { finishReason: 'stop' });
      }
    } } });
  const request = { protocol: 'bush.session_turn_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture',
    tools: registry.definitions(), prefixMessages: [], inputMessages: [{ messageId: 'u', message: { role: 'user', content: 'Work' } }], metadata: {} };
  const running = host.runSessionTurn(request);
  try {
    await until(() => host.events('s', 't').some(e => e.kind === 'tool_returned' && e.payload.toolName === 'summary_for_user'));
    assert.equal(rounds, 1, 'a successful summary must not cancel or skip its sibling');
    assert.ok(!host.events('s', 't').some(e => e.kind === 'turn_terminal'));
    sibling.resolve({ ok: true });
    await until(() => host.events('s', 't').some(e => e.kind === 'assistant_segment_delta'));
    assert.equal(host.events('s', 't').find(e => e.kind === 'assistant_segment_delta').payload.finalResponse, true);
    assert.ok(!host.events('s', 't').some(e => e.kind === 'turn_terminal'), 'text can render final while provider is still streaming');
  } finally { sibling.resolve({ ok: true }); finish.resolve(); }
  assert.equal((await running).payload.status, 'completed');
  await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
});

test('signal uses a successful receipt in the same turn, is consumed once and ignores forged text/new guidance', () => {
  const store = new ToolExecutionStore();
  const call = { protocol: 'bush.tool_call.v1', id: 'summary', name: 'summary_for_user', argumentsText: '{}' };
  const assistant = { role: 'assistant', content: '', toolCalls: [call] };
  const messages = [assistant, { role: 'tool', toolCallId: call.id, content: '{"final_response":true}' }];
  assert.equal(hasPendingUserSummary(messages, store, 's', 't'), false);
  store.record(call, { requestId: 'r', sessionId: 's', turnId: 't', round: 1, ordinal: 0 }, { kind: 'returned', result: { status: 'ok', final_response: true } });
  assert.equal(hasPendingUserSummary(messages, store, 's', 't'), true);
  assert.equal(hasPendingUserSummary(messages, store, 's', 'other-turn'), false);
  assert.equal(hasPendingUserSummary([...messages, { role: 'assistant', content: 'next response', toolCalls: [] }], store, 's', 't'), false);
  assert.equal(hasPendingUserSummary([...messages, { role: 'user', content: 'new guidance' }], store, 's', 't'), false);
});

test('extra tool calls demote final intent without dropping subsequent assistant text; done fallback remains unchanged', () => {
  for (const interleavedReasoning of [false, true]) {
    const log = new InMemoryRuntimeEventLog(), identity = { requestId: 'r', sessionId: 's', turnId: 't' };
    const projector = new RuntimeEventProjector(log, identity, { finalResponse: true, deltaFlushIntervalMs: 0 });
    projector.accept(event(identity, 0, 'text_delta', { delta: 'Earlier' }));
    if (interleavedReasoning) projector.accept(event(identity, 1, 'reasoning_delta', { delta: 'Still checking' }));
    projector.accept(event(identity, 2, 'tool_call_delta', { index: 0, toolCallId: 'next', nameDelta: 'probe', argumentsDelta: '{}' }));
    projector.accept(event(identity, 3, 'text_delta', { delta: 'Later' }));
    projector.accept(event(identity, 4, 'response_completed', { finishReason: 'tool_calls' }));
    const facts = log.replay('s', 't');
    assert.equal(facts.filter(e => e.kind === 'assistant_segment_delta').map(e => e.payload.delta).join(''), 'EarlierLater');
    assert.equal(facts.filter(e => e.kind === 'assistant_segment_completed').at(-1).payload.finalResponse, false);
    assert.equal(facts.some(e => e.kind === 'turn_terminal'), false);
    const plain = new RuntimeEventProjector(log, identity);
    const delta = plain.accept(event(identity, 5, 'text_delta', { delta: 'normal fallback' })).at(-1);
    assert.equal(delta.payload.finalResponse, undefined);
    plain.completeOpenSegment();
  }
});
