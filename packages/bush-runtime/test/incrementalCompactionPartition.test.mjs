import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextCompactionTransaction } from '../dist/contextCompactionTransaction.js';
import { validateConversation } from '../dist/sessionStore.js';
import { InMemoryRuntimeHost, SessionStore, assembleContext, InMemoryRuntimeCheckpointStore,
  InMemoryRuntimeEventLog } from '../dist/index.js';

const now = '2026-10-06T03:25:00Z';
const user = content => ({ role: 'user', content });
const assistant = content => ({ role: 'assistant', content, toolCalls: [] });
const result = (id, updates) => ({ status: 'completed', text: '', reasoning: 'Preserve verified facts.', usage: {}, finishReason: 'tool_calls',
  toolCalls: [{ protocol: 'bush.tool_call.v1', id, name: 'checkpoint_context', argumentsText: JSON.stringify({ updates }) }] });
const rows = messages => messages.findLast(m => m.name === 'context_pressure').content.split('\n')
  .filter(line => line.startsWith('{')).map(JSON.parse).filter(row => row.source !== undefined);
const updates = job => rows(job.messages).map(row => ({ source: row.source, summary: `Source ${row.source}: local draft only; publication not authorized.` }));
function fixture(history = [[user('Draft A.'), assistant('Draft prepared.')], [user('Check B.'), assistant('Verification pending.')]]) {
  const messages = [{ role: 'system', content: 'Stable rules.' }, ...history.flat()];
  let start = 1;
  const sources = history.map((messages, source) => {
    const range = { turnId: `old_${source}`, target: `source ${source}`, startMessage: start, endMessageExclusive: start + messages.length };
    start = range.endMessageExclusive; return range;
  });
  return { messages, sources, prefixMessageCount: 1, state: { revision: 2, totalTurns: history.length, unsummarizedTurnIds: sources.map(s => s.turnId) },
    pressure: { ratio: 0.96 }, outputTokens: 16384, maximumOutputTokens: 128000, inputFormat: 'incremental' };
}

test('partitioned incremental jobs retain global source numbers, reject unseen sources and commit only after consolidation', () => {
  const input = fixture(), tx = new ContextCompactionTransaction(input);
  assert.equal(tx.partition(), true);
  assert.deepEqual(rows(tx.job().messages).map(r => r.source), [0]);
  assert.equal(tx.accept(result('foreign', [{ source: 1, summary: 'Unseen source.' }])), false);
  assert.equal(JSON.parse(tx.canonicalMessages.at(-1).content).rejected.length, 1);
  assert.equal(tx.accept(result('a', updates(tx.job()))), false);
  assert.equal(tx.incremental.hasAccepted(0), false, 'fragment completion is not whole-source acceptance');
  assert.deepEqual(rows(tx.job().messages).map(r => r.source), [1]);
  assert.equal(tx.accept(result('b', updates(tx.job()))), false);
  assert.equal(tx.job().id, 'root');
  assert.equal(tx.incremental.complete, false);
  for (const row of rows(tx.job().messages)) {
    const locator = row.checkpointSummaries[0];
    const receipt = JSON.parse(tx.job().messages[locator.message].content);
    assert.equal(receipt.summaries.find(item => item.source === row.source).summary, updates(tx.job())[row.source].summary);
  }
  const consolidation = tx.job().messages;
  assert.equal(tx.accept(result('root-a', [{ source: 0, summary: 'Consolidated A.' }])), false);
  assert.deepEqual(tx.job().messages.slice(0, consolidation.length), consolidation, 'partial consolidation keeps the dispatch prefix stable');
  assert.equal(tx.accept(result('root-b', [{ source: 1, summary: 'Consolidated B.' }])), true);
  assert.deepEqual(tx.incremental.value.summaries, ['Consolidated A.', 'Consolidated B.']);
  assert.deepEqual(tx.canonicalMessages.slice(0, input.messages.length), input.messages);
  validateConversation(tx.canonicalMessages);
});

test('one oversized source splits only between complete parallel exchanges and keeps reasoning and replay intact', () => {
  const native = { role: 'assistant', content: '', reasoningContent: 'Signed reasoning.',
    providerReplay: { provider: 'fixture', format: 'opaque', payload: { signed: 'UNCHANGED' } },
    toolCalls: ['a', 'b'].map(id => ({ id, name: 'read', argumentsText: '{}' })) };
  const input = fixture([[user('Local preview only.'), native,
    { role: 'tool', toolCallId: 'b', content: 'Read B.' }, { role: 'tool', toolCallId: 'a', content: 'Read A.' }, assistant('Verify next.')]]);
  const tx = new ContextCompactionTransaction(input);
  assert.equal(tx.partition(), true);
  const staged = [];
  while (!tx.isRoot) {
    const job = tx.job(); validateConversation(job.messages);
    const originalAssistant = job.messages.find(m => m.role === 'assistant' && m.toolCalls.some(c => c.id === 'a'));
    if (originalAssistant) {
      assert.deepEqual(originalAssistant, native);
      assert.equal(job.messages.filter(m => m.role === 'tool' && ['a', 'b'].includes(m.toolCallId)).length, 2);
    }
    staged.push(job); tx.accept(result(`fragment-${staged.length}`, updates(job)));
  }
  assert.equal(staged.length, 2);
  assert.deepEqual(staged.map(job => rows(job.messages)[0].source), [0, 0]);
  assert.equal(rows(tx.job().messages)[0].checkpointSummaries.length, 2);
  assert.equal(tx.accept(result('consolidate', [{ source: 0, summary: 'Read A and B; local preview only. Verify next.' }])), true);
  assert.deepEqual(tx.canonicalMessages.slice(0, input.messages.length), input.messages);
});

test('recovery restores nested partitions, accepted fragment receipts and the exact pending dispatch', () => {
  const input = fixture([[user('A.'), assistant('B.'), user('C.'), assistant('D.')], [user('E.'), assistant('F.')]]);
  const first = new ContextCompactionTransaction(input);
  first.partition(); first.partition();
  first.accept(result('first-fragment', updates(first.job())));
  first.retry('Keep the selected source distinct.', true);
  const before = first.job();
  const restored = new ContextCompactionTransaction({ ...input, continuation: structuredClone(first.incremental.history),
    restoredFailures: new Map([[before.id, { failures: before.failures, outputTokens: before.outputTokens }]]) });
  assert.deepEqual(restored.job(), before);
  assert.equal(restored.incremental.hasAccepted(0), false);
  let calls = 0;
  while (!restored.accept(result(`resumed-${++calls}`, updates(restored.job())))) assert.ok(calls < 8);
  assert.equal(restored.incremental.complete, true);
  assert.equal(restored.canonicalMessages.filter(m => m.role === 'tool' && m.toolCallId === 'first-fragment').length, 1);
});

test('sources accepted before a budget split are retained and never restaged or overwritten', () => {
  const tx = new ContextCompactionTransaction(fixture());
  tx.accept(result('already', [{ source: 0, summary: 'Accepted A.' }]));
  assert.equal(tx.partition(), true);
  assert.deepEqual(rows(tx.job().messages).map(row => row.source), [1]);
  tx.accept(result('pending', updates(tx.job())));
  assert.equal(tx.job().id, 'root');
  assert.deepEqual(rows(tx.job().messages).map(row => row.source), [1]);
  assert.equal(tx.accept(result('done', [{ source: 1, summary: 'Consolidated B.' }])), true);
  assert.deepEqual(tx.incremental.value.summaries, ['Accepted A.', 'Consolidated B.']);
});

const event = (request, sequence, kind, payload = {}) => ({ protocol: 'bush.model_event.v1', requestId: request.requestId,
  sequence, kind, createdAt: now, ...payload });
function* checkpoint(request, id) {
  yield event(request, 0, 'tool_call_delta', { index: 0, toolCallId: id, nameDelta: 'checkpoint_context', argumentsDelta: JSON.stringify({ updates: updates(request) }) });
  yield event(request, 1, 'response_completed', { finishReason: 'tool_calls' });
}
const request = { protocol: 'bush.session_turn_request.v1', requestId: 'budget', sessionId: 's', turnId: 'current', model: 'fixture',
  prefixMessages: [{ role: 'system', content: 'Preserve user authorization.' }], inputMessages: [{ messageId: 'new-user', message: user('Continue checking.') }],
  maxOutputTokens: 128000, metadata: { contextWindowTokens: 400000 } };
const count = async request => ({ source: 'provider', inputTokens: JSON.stringify(request.messages).length > 60_000 ? 400000 : 1000 });
const maintenance = input => input.messages.some(m => m.name === 'context_pressure');
function seeded() {
  const journal = [], store = new SessionStore({ persistence: { load: () => structuredClone(journal), append: value => journal.push(structuredClone(value)) } });
  for (let i = 0; i < 2; i++) {
    const messages = [user(`Local draft ${i}; do not publish. ` + 'x'.repeat(40_000)), assistant('Draft prepared.')];
    store.commitTurn('s', { turnId: `old_${i}`, turnSequence: i + 1, createdAt: now, completedAt: now, status: 'completed',
      reason: 'model_response_completed', usage: {}, messages: messages.map((message, j) => ({ messageId: `${i}_${j}`, messageIndex: j,
        turnId: `old_${i}`, turnSequence: i + 1, createdAt: now, message })) });
  }
  return { journal, store };
}

for (const failure of [false, true]) test(`Runtime token pressure stages incremental sources and preserves history (failure=${failure})`, async t => {
  const { store } = seeded(), original = structuredClone(store.snapshot('s').turns), observed = [];
  const host = new InMemoryRuntimeHost({ sessionStore: store, registerDefaultWorkspaceTools: false, provider: { countInputTokens: count,
    async *stream(input) {
      validateConversation(input.messages); observed.push(structuredClone(input));
      assert.ok(JSON.stringify(input.messages).length <= 60_000, 'no oversized model dispatch');
      if (maintenance(input)) {
        assert.deepEqual(store.snapshot('s').turns, original, 'no partial source replacement');
        if (failure && observed.length === 2) {
          yield event(input, 0, 'response_failed', { code: 'fixture_unavailable', message: 'Interrupted source.', retryable: false }); return;
        }
        yield* checkpoint(input, `stage-${observed.length}`);
      } else {
        yield event(input, 0, 'text_delta', { delta: 'Checked.' }); yield event(input, 1, 'response_completed', { finishReason: 'stop' });
      }
    } } });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const terminal = await host.runSessionTurn(request);
  assert.equal(terminal.payload.status, failure ? 'failed' : 'completed', JSON.stringify(terminal.payload));
  assert.equal(observed.length, failure ? 2 : 4);
  const session = store.snapshot('s');
  assert.deepEqual(session.turns.slice(0, 2), original);
  assert.equal(Boolean(session.turns.at(-1).contextCheckpoint), !failure);
  if (failure) assert.equal(assembleContext({ session, prefix: [] }).messages.some(m => m.name === 'context_compaction_progress'), false);
});

test('Runtime restart resumes the pending staged job without redoing completed sources or rewriting canonical history', async t => {
  const { store, journal } = seeded(), original = structuredClone(store.snapshot('s').turns);
  const eventLog = new InMemoryRuntimeEventLog(), checkpoints = new InMemoryRuntimeCheckpointStore(), controller = new AbortController();
  let reached; const ready = new Promise(resolve => { reached = resolve; });
  const seen = [];
  const first = new InMemoryRuntimeHost({ sessionStore: store, eventLog, checkpointStore: checkpoints,
    registerDefaultWorkspaceTools: false, provider: { countInputTokens: count, async *stream(input) {
      seen.push(structuredClone(input));
      if (seen.length === 1) yield* checkpoint(input, 'completed-stage');
      else { reached(); await new Promise(() => {}); }
    } } });
  t.after(() => first.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const running = first.runSessionTurn(request, { signal: controller.signal });
  await ready;
  const saved = structuredClone(checkpoints.load('s', 'current')), savedJournal = structuredClone(journal), savedEvents = structuredClone(eventLog.replay('s', 'current'));
  assert.ok(JSON.stringify(saved.request.messages).length > 80_000, 'recovery journals the canonical full sources, not the smaller dispatch');
  controller.abort(); await running;
  const restoredCheckpoints = new InMemoryRuntimeCheckpointStore(); restoredCheckpoints.save(saved);
  const restoredStore = new SessionStore({ persistence: { load: () => savedJournal, append: value => savedJournal.push(value) } });
  const restoredLog = new InMemoryRuntimeEventLog({ persistence: { load: () => savedEvents, append: value => savedEvents.push(value) } });
  const resumed = [];
  const second = new InMemoryRuntimeHost({ sessionStore: restoredStore, eventLog: restoredLog, checkpointStore: restoredCheckpoints,
    registerDefaultWorkspaceTools: false, provider: { countInputTokens: count, async *stream(input) {
      resumed.push(structuredClone(input));
      if (resumed.length === 1) assert.deepEqual(input.messages, seen[1].messages);
      if (maintenance(input)) yield* checkpoint(input, `resumed-stage-${resumed.length}`);
      else { yield event(input, 0, 'text_delta', { delta: 'Restored.' }); yield event(input, 1, 'response_completed', { finishReason: 'stop' }); }
    } } });
  t.after(() => second.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const terminal = await second.resumeModelTurn('s', 'current');
  assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal.payload));
  assert.equal(resumed.length, 3, 'only the pending source, consolidation and normal response');
  const session = restoredStore.snapshot('s');
  assert.deepEqual(session.turns.slice(0, 2), original);
  assert.equal(session.turns.at(-1).messages.filter(m => m.message.role === 'tool' && m.message.toolCallId === 'completed-stage').length, 1);
});
