import assert from 'node:assert/strict';
import test from 'node:test';
import { IncrementalCheckpoint } from '../dist/incrementalCheckpoint.js';
import { ContextCompactionTransaction } from '../dist/contextCompactionTransaction.js';
import { locateContextCompactionSources } from '../dist/contextCompaction.js';
import { InMemoryRuntimeHost, SessionStore, assembleContext, InMemoryRuntimeCheckpointStore,
  InMemoryRuntimeEventLog } from '../dist/index.js';
import { toResponsesCreateParams } from '@cardbush/bush-provider-openai';

const now = '2026-09-16T09:00:00Z';
const notice = { role: 'developer', name: 'context_pressure', content: 'Choose pending sources.' };
const state = { revision: 3, totalTurns: 2, unsummarizedTurnIds: ['a', 'b'], activeTurn: { turnId: 'current', throughMessageId: 'last-tool' } };
const result = (id, input) => ({ status: 'completed', text: '', reasoning: 'Keep source facts distinct.', usage: {}, finishReason: 'tool_calls',
  toolCalls: [{ protocol: 'bush.tool_call.v1', id, name: 'checkpoint_context', argumentsText: typeof input === 'string' ? input : JSON.stringify(input) }] });
const receipt = loop => JSON.parse(loop.history.at(-1).content);
const event = (request, sequence, kind, payload = {}) => ({ protocol: 'bush.model_event.v1', requestId: request.requestId,
  sequence, kind, createdAt: now, ...payload });
function* checkpoint(request, id, updates) {
  yield event(request, 0, 'reasoning_delta', { delta: 'Only summarize selected original sources.' });
  yield event(request, 1, 'tool_call_delta', { index: 0, toolCallId: id, nameDelta: 'checkpoint_context', argumentsDelta: JSON.stringify({ updates }) });
  yield event(request, 2, 'response_completed', { finishReason: 'tool_calls' });
}
const user = content => ({ role: 'user', content });
const assistant = content => ({ role: 'assistant', content, toolCalls: [] });
const history = [
  [user('先做本地预览，不能发布。'), assistant('建议先写草稿。')],
  [user('可以，按这个来。'), assistant('draft.svg 已写入，发布未执行。')],
  [user('继续，草稿保留；仍然不要发布。'), assistant('发布未执行。')],
];
const summaries = ['用户要求本地预览，不授权发布。', '“可以”承接本地草稿方案。draft.svg 已写入，发布未执行。', '用户要求保留草稿并继续，发布仍未授权且未执行。'];
function seeded() {
  const journal = [];
  const store = new SessionStore({ persistence: { load: () => journal, append: event => journal.push(event) } });
  history.forEach((messages, index) => store.commitTurn('s', { turnId: `old_${index}`, turnSequence: index + 1,
    createdAt: now, completedAt: now, status: 'completed', reason: 'model_response_completed', usage: {},
    messages: messages.map((message, i) => ({ messageId: `old_${index}_${i}`, turnId: `old_${index}`, turnSequence: index + 1, messageIndex: i, createdAt: now, message })) }));
  return { store, journal };
}
const request = () => ({ protocol: 'bush.session_turn_request.v1', requestId: 'r', sessionId: 's', turnId: 'current', model: 'fixture',
  prefixMessages: [{ role: 'system', content: 'Stable instructions.' }], inputMessages: [{ messageId: 'new-user', message: user('继续检查。') }],
  maxOutputTokens: 128000, metadata: { contextWindowTokens: 400000 } });
const pressureCount = async request => ({ source: 'provider', inputTokens:
  request.messages.some(m => m.role === 'tool' && m.content.includes('summarized_turns')) ? 1000 : 260000 });
const isMaintenance = request => request.messages.some(m => m.name === 'context_pressure');

test('the model chooses order and batch size; valid entries survive mixed invalid entries without semantic rewriting', () => {
  const loop = new IncrementalCheckpoint(state, notice);
  assert.equal(loop.submit(result('one', { updates: [{ source: 2, summary: 'Current Tool returned error; retry unresolved.' }] })), false);
  assert.deepEqual(receipt(loop).remaining.map(item => item.source), [0, 1]);
  assert.equal(loop.submit(result('two', { updates: [
    { source: 0, summary: 'A model-authored interpretation is retained verbatim.' },
    { source: 1, summary: 42 }, { source: 99, summary: 'out of scope' },
    { source: 2, summary: 'Do not overwrite accepted facts.' },
  ] })), false);
  assert.deepEqual(receipt(loop).accepted, [0]);
  assert.equal(receipt(loop).rejected.length, 3);
  assert.deepEqual(receipt(loop).remaining.map(item => item.source), [1]);
  assert.equal(loop.submit(result('three', { updates: [{ source: 1, summary: 'The reply refers to the earlier preview-only authorization.' }] })), true);
  assert.deepEqual(loop.value.summaries, ['A model-authored interpretation is retained verbatim.',
    'The reply refers to the earlier preview-only authorization.', 'Current Tool returned error; retry unresolved.']);
  assert.equal(loop.checkpoint.activeTurn.throughMessageId, 'last-tool');
  assert.deepEqual(receipt(loop).summaries.map(item => item.summary), loop.value.summaries);
});

test('malformed JSON, empty arrays, duplicate and foreign sources produce real receipts; only progress resets the retry counter', () => {
  const loop = new IncrementalCheckpoint(state, notice);
  loop.submit(result('bad-json', '{"updates":[，=None}'));
  assert.equal(loop.failures, 1);
  assert.match(receipt(loop).rejected[0].reason, /JSON/);
  loop.submit(result('empty', { updates: [] }));
  assert.equal(loop.failures, 2);
  loop.submit(result('valid', { updates: [{ source: 1, summary: 'verified' }] }));
  assert.equal(loop.failures, 0);
  loop.submit(result('duplicate', { updates: [{ source: 1, summary: 'replacement' }] }));
  assert.equal(loop.failures, 1);
  assert.deepEqual(receipt(loop).accepted_sources, [1]);
  const copy = new IncrementalCheckpoint(state, notice, structuredClone(loop.history));
  assert.deepEqual(copy.history, loop.history);
  assert.equal(copy.failures, 1);
  assert.throws(() => copy.value, /Pending/);
  const newHints = new IncrementalCheckpoint(state, notice, structuredClone(loop.history), [
    { turnId: 'a', target: 'source 0', startMessage: 1, endMessageExclusive: 3, first: { role: 'user', excerpt: 'Newly displayed locator.' } },
  ]);
  assert.deepEqual(newHints.history, loop.history, 'Changing receipt hints must never rewrite prior acceptance facts or cached receipts.');
});

test('same-loop partial submissions keep native input and wire prefixes stable, then persist all accepted texts in the final receipt', async t => {
  const { store, journal } = seeded();
  const original = structuredClone(store.snapshot('s').turns);
  const observed = [];
  let round = 0;
  const host = new InMemoryRuntimeHost({ sessionStore: store, registerDefaultWorkspaceTools: false, provider: {
    countInputTokens: pressureCount,
    async *stream(input) {
      observed.push(structuredClone(input));
      if (!isMaintenance(input)) {
        yield event(input, 0, 'text_delta', { delta: '已继续检查。' });
        yield event(input, 1, 'response_completed', { finishReason: 'stop' }); return;
      }
      round++;
      assert.equal(input.messages.findLast(m => m.name === 'context_pressure').role, 'developer');
      assert.deepEqual(store.snapshot('s').turns, original, 'No partial history replacement.');
      const updates = round === 1 ? [{ source: 2, summary: summaries[2] }]
        : round === 2 ? [{ source: 0, summary: summaries[0] }, { source: 1, summary: '' }]
          : [{ source: 1, summary: summaries[1] }];
      yield* checkpoint(input, `checkpoint_${round}`, updates);
    },
  } });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const terminal = await host.runSessionTurn(request());
  assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal.payload));
  assert.equal(observed.length, 4, 'No extra consolidation call.');
  for (let index = 1; index < 3; index++) {
    assert.deepEqual(observed[index].messages.slice(0, observed[index - 1].messages.length), observed[index - 1].messages);
    assert.deepEqual(observed[index].tools, observed[0].tools);
    const before = toResponsesCreateParams(observed[index - 1]);
    const after = toResponsesCreateParams(observed[index]);
    assert.deepEqual(after.input.slice(0, before.input.length), before.input, 'Provider wire prefix must remain identical too.');
  }
  const last = observed.at(-1).messages.findLast(m => m.role === 'tool');
  assert.deepEqual(JSON.parse(last.content).summaries.map(item => item.summary), summaries);
  assert.deepEqual(store.snapshot('s').turns.slice(0, 3), original);
  const projection = assembleContext({ session: new SessionStore({ persistence: { load: () => journal, append() {} } }).snapshot('s'), prefix: request().prefixMessages }).messages;
  assert.deepEqual(projection.slice(0, observed.at(-1).messages.length), observed.at(-1).messages);
  const calls = store.snapshot('s').turns.at(-1).messages.flatMap(m => m.message.role === 'assistant' ? m.message.toolCalls : []);
  assert.deepEqual(calls.map(call => call.id), ['checkpoint_1', 'checkpoint_2', 'checkpoint_3']);
  assert.equal(host.events('s', 'current').filter(e => e.kind === 'tool_running').length, 0);
});

test('three calls without progress stop without changing original source history or inventing accepted summaries', async t => {
  const { store } = seeded();
  const original = structuredClone(store.snapshot('s').turns);
  let calls = 0;
  const host = new InMemoryRuntimeHost({ sessionStore: store, registerDefaultWorkspaceTools: false, provider: {
    countInputTokens: pressureCount,
    async *stream(input) { calls++; yield* checkpoint(input, `invalid_${calls}`, []); },
  } });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const terminal = await host.runSessionTurn(request());
  assert.equal(terminal.payload.status, 'failed');
  assert.equal(calls, 3);
  assert.deepEqual(store.snapshot('s').turns.slice(0, 3), original);
  assert.equal(store.snapshot('s').turns.at(-1).contextCheckpoint, undefined);
  const next = assembleContext({ session: store.snapshot('s'), prefix: request().prefixMessages }).messages;
  assert.equal(next.some(message => message.name === 'context_pressure'), false, 'Expired maintenance instructions cannot direct the next Turn.');
  assert.equal(next.filter(message => message.role === 'tool' && message.toolCallId.startsWith('invalid_')).length, 3, 'Actual Tool facts remain visible.');
});

test('restart keeps accepted entries and the exact dispatch prefix, then only requests remaining work', async t => {
  const { store, journal } = seeded();
  const checkpoints = new InMemoryRuntimeCheckpointStore();
  const eventLog = new InMemoryRuntimeEventLog();
  const controller = new AbortController();
  let reached;
  const paused = new Promise(resolve => { reached = resolve; });
  const seen = [];
  const first = new InMemoryRuntimeHost({ sessionStore: store, checkpointStore: checkpoints, eventLog,
    registerDefaultWorkspaceTools: false, provider: { countInputTokens: pressureCount, async *stream(input) {
      seen.push(structuredClone(input));
      if (seen.length === 1) yield* checkpoint(input, 'first-source', [{ source: 1, summary: summaries[1] }]);
      else { reached(); await new Promise(() => {}); }
    } } });
  t.after(() => first.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const running = first.runSessionTurn(request(), { signal: controller.signal });
  await paused;
  const saved = structuredClone(checkpoints.load('s', 'current'));
  const savedEvents = structuredClone(eventLog.replay('s', 'current'));
  const savedSessions = structuredClone(journal);
  assert.deepEqual(saved.request.messages, seen[1].messages);
  assert.equal(saved.request.messages.findLast(m => m.name === 'context_pressure').role, 'developer');
  controller.abort(); await running;
  const restoredCheckpoints = new InMemoryRuntimeCheckpointStore(); restoredCheckpoints.save(saved);
  const restoredStore = new SessionStore({ persistence: { load: () => savedSessions, append: item => savedSessions.push(item) } });
  const restoredLog = new InMemoryRuntimeEventLog({ persistence: { load: () => savedEvents, append: item => savedEvents.push(item) } });
  let resumed = 0;
  const second = new InMemoryRuntimeHost({ sessionStore: restoredStore, eventLog: restoredLog, checkpointStore: restoredCheckpoints,
    registerDefaultWorkspaceTools: false, provider: { countInputTokens: pressureCount, async *stream(input) {
      resumed++;
      if (isMaintenance(input)) {
        assert.deepEqual(input.messages, seen[1].messages);
        const remaining = JSON.parse(input.messages.at(-1).content).remaining;
        assert.deepEqual(remaining.map(item => item.source), [0, 2]);
        assert.equal(remaining[0].user_request, history[0][0].content);
        yield* checkpoint(input, 'remaining-sources', [{ source: 2, summary: summaries[2] }, { source: 0, summary: summaries[0] }]);
      } else {
        yield event(input, 0, 'text_delta', { delta: '恢复完成。' });
        yield event(input, 1, 'response_completed', { finishReason: 'stop' });
      }
    } } });
  t.after(() => second.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const terminal = await second.resumeModelTurn('s', 'current');
  assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal.payload));
  assert.equal(resumed, 2);
  const current = restoredStore.snapshot('s').turns.at(-1);
  assert.equal(current.messages.filter(item => item.message.role === 'tool' && item.message.toolCallId === 'first-source').length, 1);
  assert.deepEqual(JSON.parse(current.messages.find(item => item.message.role === 'tool' && item.message.toolCallId === 'remaining-sources').message.content).summaries.map(s => s.summary), summaries);
});

test('a cumulative active source and earlier sources can be selected independently without splitting native exchanges', () => {
  const messages = [{ role: 'system', content: 'Stable prefix.' }, user('只允许本地预览。'), assistant('已准备草稿。'),
    user('继续这个。'), { role: 'assistant', content: '', reasoningContent: 'Read to verify.', toolCalls: [{ id: 'read', name: 'read_file', argumentsText: '{}' }] },
    { role: 'tool', toolCallId: 'read', content: '文件读取失败；没有执行写入。' }];
  const auth = { revision: 2, totalTurns: 1, unsummarizedTurnIds: ['old'], activeTurn: { turnId: 'current', throughMessageId: 'read-receipt' } };
  const transaction = new ContextCompactionTransaction({ messages, prefixMessageCount: 1, state: auth,
    sources: [{ turnId: 'old', target: 'source 0', startMessage: 1, endMessageExclusive: 3 },
      { turnId: 'current', target: 'source 1', startMessage: 3, endMessageExclusive: 6 }],
    pressure: { ratio: 0.96 }, outputTokens: 16384, maximumOutputTokens: 128000, inputFormat: 'incremental' });
  assert.equal(transaction.partition(), false);
  assert.deepEqual(transaction.job().messages.slice(0, messages.length), messages);
  assert.equal(transaction.accept(result('active', { updates: [{ source: 1, summary: '继续承接只做本地预览的授权。读取失败，没有写入，下一步检查路径。' }] })), false);
  assert.deepEqual(transaction.job().messages.slice(0, messages.length), messages);
  assert.equal(transaction.accept(result('past', { updates: [{ source: 0, summary: '用户只允许本地预览；草稿已准备。' }] })), true);
  assert.equal(transaction.incremental.checkpoint.activeTurn.throughMessageId, 'read-receipt');
  assert.match(transaction.incremental.checkpoint.activeTurn.summary, /读取失败/);
});

test('user guidance queued between partial checkpoints is applied before normal work resumes', async t => {
  const { store } = seeded();
  let entered, release;
  const paused = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  let continued;
  const host = new InMemoryRuntimeHost({ sessionStore: store, registerDefaultWorkspaceTools: false, provider: {
    countInputTokens: pressureCount,
    async *stream(input) {
      if (isMaintenance(input)) {
        if (++calls === 1) yield* checkpoint(input, 'first', [{ source: 0, summary: summaries[0] }]);
        else {
          entered(); await gate;
          yield* checkpoint(input, 'remaining', [{ source: 2, summary: summaries[2] }, { source: 1, summary: summaries[1] }]);
        }
      } else {
        continued = input;
        yield event(input, 0, 'text_delta', { delta: '按新范围继续。' });
        yield event(input, 1, 'response_completed', { finishReason: 'stop' });
      }
    },
  } });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const running = host.runSessionTurn(request());
  await paused;
  await host.sendCommand({ kind: 'runtime.enqueue_guidance', payload: { protocol: 'bush.runtime_guidance.v1',
    sessionId: 's', turnId: 'current', messageId: 'new-scope', content: '新要求：只核对文件路径，不再修改草稿。', createdAt: now } });
  release();
  const terminal = await running;
  assert.equal(terminal.payload.status, 'completed');
  assert.equal(continued.messages.at(-1).name, 'turn_guidance');
  assert.match(continued.messages.at(-1).content, /只核对文件路径/);
});

test('pending-source hints quote the actual user request instead of repeated internal runtime context', () => {
  const source = [{ role: 'user', name: 'turn_runtime_context', visibility: 'internal', content: 'Same runtime context on every Turn.' },
    user('保留草稿，但取消发布。'), assistant('尚未发布。')];
  const input = { messages: source, prefixMessageCount: 0, turns: [{ turnId: 'old', messages: source }], activeTurnId: 'new', activeMessages: [],
    state: { revision: 1, totalTurns: 1, unsummarizedTurnIds: ['old'] }, inputFormat: 'incremental' };
  const sources = locateContextCompactionSources(input);
  assert.deepEqual(sources[0].userRequest, { message: 1, excerpt: '保留草稿，但取消发布。' });
  const loop = new IncrementalCheckpoint(input.state, notice, [], sources);
  loop.submit(result('invalid', { updates: [] }));
  assert.equal(receipt(loop).remaining[0].user_request, '保留草稿，但取消发布。');
});
