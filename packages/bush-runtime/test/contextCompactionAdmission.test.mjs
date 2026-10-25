import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryRuntimeHost, SessionStore, InMemoryRuntimeCheckpointStore, InMemoryRuntimeEventLog,
  assembleContext } from '../dist/index.js';
import { ContextCompactionTransaction } from '../dist/contextCompactionTransaction.js';
import { IncrementalCheckpoint } from '../dist/incrementalCheckpoint.js';
import { validateConversation } from '../dist/sessionStore.js';
import { orderedCheckpointTool } from './helpers/orderedCheckpoint.mjs';

const now = '2026-10-18T04:00:00Z';
const user = content => ({ role: 'user', content });
const assistant = content => ({ role: 'assistant', content, toolCalls: [] });
const event = (request, sequence, kind, payload = {}) => ({ protocol: 'bush.model_event.v1', requestId: request.requestId,
  sequence, kind, createdAt: now, ...payload });
const rows = input => input.messages.findLast(m => m.name === 'context_pressure').content.split('\n')
  .filter(line => line.startsWith('{')).map(JSON.parse);
const maintenance = input => input.messages.some(m => m.name === 'context_pressure');
const applied = input => input.messages.some(m => m.role === 'tool' && m.content.includes('summarized_turns'));
// Deterministic serialized-size fixture, not a provider tokenizer approximation.
const tokens = input => Math.ceil(JSON.stringify(input.messages).length / 4);
const count = async input => ({ source: 'provider', inputTokens: tokens(input) });
const short = source => `Source ${source}: verified locally; publication not authorized; continue checking.`;
const oversized = (source, ordered = false) => `Source ${source}: ` + 'verified fact; '.repeat(ordered ? 350 : 210);
const request = (overrides = {}) => ({ protocol: 'bush.session_turn_request.v1', requestId: 'r', sessionId: 's', turnId: 'current', model: 'fixture',
  prefixMessages: [{ role: 'system', content: 'Preserve user constraints and continue the task.' }],
  inputMessages: [{ messageId: 'current-user', message: user('Continue checking.') }],
  maxOutputTokens: 4000, metadata: { contextWindowTokens: 8000 }, ...overrides });

function seed(total = 3, size = 450) {
  const journal = [], store = new SessionStore({ persistence: { load: () => structuredClone(journal), append: item => journal.push(structuredClone(item)) } });
  for (let source = 0; source < total; source++) {
    const turnId = `old_${source}`;
    store.commitTurn('s', { turnId, turnSequence: source + 1, createdAt: now, completedAt: now,
      status: 'completed', reason: 'model_response_completed', usage: {},
      messages: [user(`Task ${source}: inspect, do not publish.`), assistant('Recorded facts: ' + 'record '.repeat(size))]
        .map((message, index) => ({ messageId: `${turnId}_${index}`, turnId, turnSequence: source + 1, messageIndex: index, createdAt: now, message })) });
  }
  return { store, journal, original: structuredClone(store.snapshot('s').turns) };
}
function* checkpoint(input, id, values, ordered = false) {
  const args = ordered ? { summaries: values.map(value => value.summary) } : { updates: values };
  assert.ok(Math.ceil(JSON.stringify(args).length / 4) < input.maxOutputTokens, 'test output fits its configured allowance');
  yield event(input, 0, 'tool_call_delta', { index: 0, toolCallId: id, nameDelta: 'checkpoint_context', argumentsDelta: JSON.stringify(args) });
  yield event(input, 1, 'response_completed', { finishReason: 'tool_calls' });
}
function* done(input) {
  yield event(input, 0, 'text_delta', { delta: 'Verification resumed.' });
  yield event(input, 1, 'response_completed', { finishReason: 'stop' });
}
const shutdown = host => host.sendCommand({ kind: 'runtime.shutdown', payload: {} });

for (const total of [63, 64, 128]) test(`${total} long sources fit through isolated source requests in a 530000-token window`, async t => {
  // Remain larger than the input capacity after reserving the conversation output allowance.
  const { store, original } = seed(total, 5000), batches = [];
  let normal = 0;
  const input = request({ maxOutputTokens: 128000, metadata: { contextWindowTokens: 530000 } });
  const host = new InMemoryRuntimeHost({ sessionStore: store, registerDefaultWorkspaceTools: false, provider: { countInputTokens: count,
    async *stream(next) {
      validateConversation(next.messages);
      assert.ok(tokens(next) + next.maxOutputTokens <= 530000, 'every real dispatch fits its input and output allowances, including consolidation');
      if (maintenance(next)) {
        assert.deepEqual(store.snapshot('s').turns, original);
        const sources = rows(next).filter(row => row.source !== undefined);
        batches.push(sources.map(row => row.source));
        yield* checkpoint(next, `batch-${batches.length}`, sources.map(row => ({ source: row.source, summary: short(row.source) })));
      } else {
        normal++;
        const receipt = JSON.parse(next.messages.findLast(m => m.role === 'tool').content);
        assert.deepEqual(receipt.summaries.map(item => item.source), Array.from({ length: total - 1 }, (_, i) => i));
        assert.ok(next.messages.some(message => message.content === original.at(-1).messages.at(-1).message.content),
          'the newest complete Turn stays verbatim instead of being summarized again');
        yield* done(next);
      }
    } } });
  t.after(() => shutdown(host));
  const terminal = await host.runSessionTurn(input);
  assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal.payload));
  assert.equal(normal, 1);
  assert.equal(batches.length, total - 1, 'one request per selected source, with no extra consolidation');
  assert.ok(batches.every(batch => batch.length === 1));
  assert.deepEqual(store.snapshot('s').turns.slice(0, total), original);
});

test('partition work is bounded by complete source units, not a 64-node ceiling; recovery keeps exact ranges', () => {
  const messages = [user('Stable prefix.')], sources = [];
  for (let source = 0; source < 70; source++) {
    sources.push({ turnId: `old_${source}`, target: `source ${source}`, startMessage: messages.length, endMessageExclusive: messages.length + 1 });
    messages.push(user(`Source ${source}: preserve this fact.`));
  }
  const input = { messages, sources, prefixMessageCount: 1, state: { revision: 70, totalTurns: 70, unsummarizedTurnIds: sources.map(s => s.turnId) },
    pressure: { ratio: 1.1 }, outputTokens: 4000, maximumOutputTokens: 4000, inputFormat: 'incremental' };
  let tx = new ContextCompactionTransaction(input), calls = 0, splits = 0;
  for (;;) {
    if (tx.job().sourceRanges.length > 1 && tx.partition()) { splits++; continue; }
    const job = tx.job(), args = { updates: rows(job).map(row => ({ source: row.source, summary: short(row.source) })) };
    const complete = tx.accept({ status: 'completed', text: '', usage: {}, finishReason: 'tool_calls',
      toolCalls: [{ protocol: 'bush.tool_call.v1', id: `split-${++calls}`, name: 'checkpoint_context', argumentsText: JSON.stringify(args) }] });
    if (complete) break;
    if (calls === 60) {
      const pending = tx.job();
      tx = new ContextCompactionTransaction({ ...input, continuation: structuredClone(tx.incremental.history) });
      assert.deepEqual(tx.job(), pending);
    }
    assert.ok(calls < 140);
  }
  assert.equal(splits, 69);
  assert.equal(calls, 139);
  assert.equal(tx.incremental.value.summaries.length, 70);
  validateConversation(tx.canonicalMessages);
});

for (const ordered of [false, true]) test(`a complete checkpoint is refined before admission when its next input is too large (ordered=${ordered})`, async t => {
  // Leave room for a refinement notice without invoking source partitioning.
  const { store, original } = seed(3, 400), observed = [];
  let calls = 0, host;
  host = new InMemoryRuntimeHost({ sessionStore: store, registerDefaultWorkspaceTools: false, provider: { countInputTokens: async input => maintenance(input) ? { source: 'provider', inputTokens: 3000 } : count(input),
    async *stream(input) {
      observed.push(structuredClone(input));
      if (!maintenance(input)) assert.ok(tokens(input) <= 4000, 'never admit an oversized candidate');
      if (maintenance(input)) {
        calls++;
        assert.equal(host.events('s', 'current').filter(e => e.kind === 'context_compaction_completed').length, 0);
        assert.deepEqual(store.snapshot('s').turns, original);
        const sources = rows(input).filter(row => row.source !== undefined || row.target.startsWith('summaries[')).map((row, i) => row.source ?? i);
        yield* checkpoint(input, `candidate-${calls}`, sources.map(source => ({ source,
          summary: calls <= (ordered ? 1 : 3) ? oversized(source, ordered) : short(source) })), ordered);
      } else {
        assert.equal(calls, ordered ? 2 : 6);
        assert.doesNotMatch(JSON.stringify(input.messages), /verified fact; verified fact;/);
        yield* done(input);
      }
    } } });
  t.after(() => shutdown(host));
  const terminal = await host.runSessionTurn(request(ordered ? { tools: [orderedCheckpointTool] } : {}));
  assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal.payload));
  assert.equal(calls, ordered ? 2 : 6);
  const events = host.events('s', 'current');
  assert.equal(events.filter(e => e.kind === 'context_compaction_completed').length, 1);
  assert.equal(events.filter(e => e.kind === 'context_compaction_retrying' && e.payload.reason === 'checkpoint_result_over_budget').length, 1);
  assert.deepEqual(store.snapshot('s').turns.slice(0, 3), original);
  assert.deepEqual(assembleContext({ session: store.snapshot('s'), prefix: request().prefixMessages }).messages.slice(0, observed.at(-1).messages.length), observed.at(-1).messages);
});

test('oversized candidates exhaust a bounded refinement budget without a false completion or source replacement', async t => {
  const { store, original } = seed(3, 400); let calls = 0;
  const host = new InMemoryRuntimeHost({ sessionStore: store, registerDefaultWorkspaceTools: false, provider: { countInputTokens: async input => maintenance(input) ? { source: 'provider', inputTokens: 3000 } : count(input),
    async *stream(input) {
      assert.ok(maintenance(input));
      yield* checkpoint(input, `oversized-${++calls}`, rows(input).map(row => ({ source: row.source, summary: oversized(row.source, true) })));
    } } });
  t.after(() => shutdown(host));
  const terminal = await host.runSessionTurn(request());
  assert.equal(terminal.payload.reason, 'context_compaction_result_limit_exceeded', JSON.stringify(terminal.payload));
  assert.equal(calls, 9, 'three candidate attempts, each with three isolated sources');
  assert.equal(store.snapshot('s').turns.at(-1).contextCheckpoint, undefined);
  assert.deepEqual(store.snapshot('s').turns.slice(0, 3), original);
  assert.equal(host.events('s', 'current').some(e => e.kind === 'context_compaction_completed'), false);
  assert.equal(host.events('s', 'current').filter(e => e.kind === 'context_compaction_failed').length, 1);
});

test('refinement preserves call identities and its retry limit across recovery', () => {
  const state = { revision: 1, totalTurns: 1, unsummarizedTurnIds: ['old'] };
  const notice = { role: 'developer', name: 'context_pressure', content: 'Summarize source 0.' };
  const accepted = id => ({ status: 'completed', text: '', usage: {}, finishReason: 'tool_calls',
    toolCalls: [{ protocol: 'bush.tool_call.v1', id, name: 'checkpoint_context', argumentsText: JSON.stringify({ updates: [{ source: 0, summary: 'Keep this verified fact.' }] }) }] });
  let loop = new IncrementalCheckpoint(state, notice);
  for (let attempt = 0; attempt < 3; attempt++) {
    assert.equal(loop.submit(accepted(`draft-${attempt}`)), true);
    const previous = structuredClone(loop.history);
    assert.equal(loop.refine('The complete input is too large. Resubmit a shorter checkpoint.'), attempt < 2);
    assert.deepEqual(loop.history.slice(0, previous.length), previous, 'acceptance receipts are immutable');
    loop = new IncrementalCheckpoint(state, notice, structuredClone(loop.history));
    assert.throws(() => loop.submit(accepted('draft-0')), /unique identities/);
    assert.equal(loop.complete, attempt === 2);
  }
  assert.equal(loop.history.filter(m => m.role === 'tool').length, 3);
});

test('admission also enforces the provider request-body limit when the token count fits', async t => {
  // Leave room for the maintenance/correction instructions. This case isolates
  // candidate admission; source partitioning has separate large-input tests.
  const { store, original } = seed(3, 250); let calls = 0, normal = 0;
  const host = new InMemoryRuntimeHost({ sessionStore: store, registerDefaultWorkspaceTools: false, provider: {
    countInputTokens: async (input, options) => {
      const bytes = Buffer.byteLength(JSON.stringify(input.messages));
      options.onRequestBodyBudget({ bytes, maxBytes: 16000 });
      return { source: 'provider', inputTokens: applied(input) ? 1000 : 3000 };
    },
    async *stream(input) {
      assert.ok(Buffer.byteLength(JSON.stringify(input.messages)) <= 16000);
      if (maintenance(input)) {
        yield* checkpoint(input, `body-${++calls}`, rows(input).filter(row => row.target !== 'not_requested').map((row, source) => ({ source,
          summary: calls === 1 ? `Source ${source}: ` + 'verified fact; '.repeat(380) : short(source) })), true);
      } else { normal++; yield* done(input); }
    } } });
  t.after(() => shutdown(host));
  const terminal = await host.runSessionTurn(request({ tools: [orderedCheckpointTool], maxOutputTokens: 6000, metadata: { contextWindowTokens: 10000 } }));
  assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal.payload));
  assert.equal(calls, 2); assert.equal(normal, 1);
  const rejected = host.events('s', 'current').find(e => e.kind === 'context_compaction_retrying' && e.payload.reason === 'checkpoint_result_over_budget');
  assert.ok(rejected, JSON.stringify(host.events('s', 'current').filter(e => e.kind === 'context_compaction_retrying')));
  assert.equal(rejected.payload.diagnostics.estimatedPromptTokens, 1000);
  assert.ok(rejected.payload.diagnostics.requestBody.bytes > 16000);
  assert.deepEqual(store.snapshot('s').turns.slice(0, 3), original);
});

test('restart during refinement preserves prior receipts and accepted new summaries without resetting its budget', async t => {
  const { store, journal, original } = seed();
  const checkpoints = new InMemoryRuntimeCheckpointStore(), events = new InMemoryRuntimeEventLog(), controller = new AbortController();
  let reached; const ready = new Promise(resolve => { reached = resolve; });
  const seen = [];
  // Exercise refinement/restart, independently of maintenance wording size.
  // Dispatch-size partitioning is covered by the large-source tests above.
  const refinementCount = input => maintenance(input) ? { source: 'provider', inputTokens: 3000 } : count(input);
  const first = new InMemoryRuntimeHost({ sessionStore: store, checkpointStore: checkpoints, eventLog: events, registerDefaultWorkspaceTools: false,
    provider: { countInputTokens: refinementCount, async *stream(input) {
      seen.push(structuredClone(input));
      if (seen.length <= 3) yield* checkpoint(input, seen.length === 1 ? 'large-original' : `large-${seen.length}`,
        rows(input).map(({ source }) => ({ source, summary: oversized(source) })));
      else if (seen.length === 4) yield* checkpoint(input, 'small-accepted', [{ source: 0, summary: short(0) }]);
      else { reached(); await new Promise(() => {}); }
    } } });
  t.after(() => shutdown(first));
  const running = first.runSessionTurn(request({ metadata: { contextWindowTokens: 8000, peerMessageWake: true, pluginAgentMaxTurns: 1 } }), { signal: controller.signal });
  await ready;
  const saved = structuredClone(checkpoints.load('s', 'current')), savedEvents = structuredClone(events.replay('s', 'current')), savedJournal = structuredClone(journal);
  assert.equal(saved.sessionCommit.taskModelRounds, 0);
  controller.abort(); await running;
  const restoredCheckpoints = new InMemoryRuntimeCheckpointStore(); restoredCheckpoints.save(saved);
  const restoredStore = new SessionStore({ persistence: { load: () => savedJournal, append: item => savedJournal.push(item) } });
  const restoredEvents = new InMemoryRuntimeEventLog({ persistence: { load: () => savedEvents, append: item => savedEvents.push(item) } });
  let calls = 0;
  const second = new InMemoryRuntimeHost({ sessionStore: restoredStore, checkpointStore: restoredCheckpoints, eventLog: restoredEvents,
    registerDefaultWorkspaceTools: false, provider: { countInputTokens: refinementCount, async *stream(input) {
      calls++;
      if (maintenance(input)) {
        if (calls === 1) {
          assert.deepEqual(input.messages, seen.at(-1).messages);
          assert.deepEqual(JSON.parse(input.messages.findLast(m => m.role === 'tool').content).accepted_sources, [0]);
        }
        yield* checkpoint(input, `remaining-small-${calls}`, rows(input).map(({ source }) => ({ source, summary: short(source) })));
      } else yield* done(input);
    } } });
  t.after(() => shutdown(second));
  const terminal = await second.resumeModelTurn('s', 'current');
  assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal.payload));
  assert.equal(calls, 3);
  const session = restoredStore.snapshot('s');
  assert.deepEqual(session.turns.slice(0, 3), original);
  assert.equal(session.turns.at(-1).messages.filter(m => m.message.role === 'tool' && m.message.toolCallId === 'large-original').length, 1);
  assert.equal(second.events('s', 'current').filter(e => e.kind === 'context_compaction_completed').length, 1);
});

for (const failure of ['count', 'abort']) test(`candidate admission ${failure} leaves coverage and completion unchanged`, async t => {
  const { store, original } = seed(), controller = new AbortController(); let calls = 0;
  const host = new InMemoryRuntimeHost({ sessionStore: store, registerDefaultWorkspaceTools: false, provider: {
    countInputTokens: async input => {
      if (applied(input)) {
        if (failure === 'abort') controller.abort();
        throw new Error('Fixture token counter unavailable.');
      }
      return count(input);
    },
    async *stream(input) {
      calls++;
      yield* checkpoint(input, `valid-before-admission-${calls}`, rows(input).map(row => ({ source: row.source, summary: short(row.source) })));
    } } });
  t.after(() => shutdown(host));
  const terminal = await host.runSessionTurn(request(), { signal: controller.signal });
  assert.equal(terminal.payload.status, failure === 'abort' ? 'stopped' : 'failed', JSON.stringify(terminal.payload));
  if (failure === 'count') assert.equal(terminal.payload.reason, 'provider_input_token_count_failed');
  assert.equal(calls, 3);
  assert.equal(store.snapshot('s').turns.at(-1).contextCheckpoint, undefined);
  assert.deepEqual(store.snapshot('s').turns.slice(0, 3), original);
  assert.equal(host.events('s', 'current').some(e => e.kind === 'context_compaction_completed'), false);
});
