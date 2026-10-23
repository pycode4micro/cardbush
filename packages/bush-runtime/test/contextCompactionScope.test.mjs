import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryRuntimeHost, SessionStore, ToolRegistry, assembleContext, projectActiveTurnContext,
  InMemoryRuntimeCheckpointStore, InMemoryRuntimeEventLog } from '../dist/index.js';
import { validateConversation } from '../dist/sessionStore.js';
import { selectContextCompactionScope } from '../dist/contextCompactionScope.js';
import { orderedCheckpointTool } from './helpers/orderedCheckpoint.mjs';

const now = '2026-10-23T08:00:00Z';
const user = content => ({ role: 'user', content });
const assistant = content => ({ role: 'assistant', content, toolCalls: [] });
const event = (input, sequence, kind, payload = {}) => ({ protocol: 'bush.model_event.v1',
  requestId: input.requestId, sequence, createdAt: now, kind, ...payload });
const maintenance = input => input.messages.some(message => message.name === 'context_pressure');
const rows = input => input.messages.findLast(message => message.name === 'context_pressure').content.split('\n')
  .filter(line => line.startsWith('{')).map(JSON.parse).filter(row => row.target !== 'not_requested');
const tokens = input => Math.ceil(JSON.stringify(input.messages).length / 4);
const count = async input => ({ source: 'provider', inputTokens: tokens(input) });
const input = (id = 'current', overrides = {}) => ({ protocol: 'bush.session_turn_request.v1',
  requestId: id, sessionId: 'scope', turnId: id, model: 'fixture', reasoningEffort: 'high', maxOutputTokens: 4000,
  prefixMessages: [{ role: 'system', content: 'Stable instructions.' }],
  inputMessages: [{ messageId: `${id}-user`, message: user('Verify only; do not publish. Keep the latest correction.') }],
  metadata: { contextWindowTokens: 20000 }, ...overrides });
function seed(store, id, messages, contextCheckpoint) {
  const sequence = (store.snapshot('scope')?.turns.length ?? 0) + 1;
  store.commitTurn('scope', { turnId: id, turnSequence: sequence, createdAt: now, completedAt: now,
    status: 'completed', reason: 'model_response_completed', usage: {},
    ...(contextCheckpoint ? { contextCheckpoint } : {}),
    messages: messages.map((message, index) => ({ messageId: `${id}-${index}`, turnId: id,
      turnSequence: sequence, messageIndex: index, createdAt: now, message })) });
}
const longHistory = marker => [user('Original scope: verify only; publication was not authorized.'),
  ...Array.from({ length: 10 }, (_, i) => assistant(`Old evidence ${i}: ` + 'record '.repeat(1000))),
  user(`Latest correction: ${marker}`), assistant(`Exact recent response: ${marker}`)];
function* checkpoint(request, id, summary = 'Verified older evidence. Publication is not authorized. Continue from the retained recent correction.') {
  const selected = rows(request);
  const args = request.tools.find(tool => tool.name === 'checkpoint_context').inputSchema.required.includes('updates')
    ? { updates: selected.map(row => ({ source: row.source, summary })) }
    : { summaries: selected.map(() => summary) };
  yield event(request, 0, 'reasoning_delta', { delta: 'Only the selected ranges are summarized.' });
  yield event(request, 1, 'tool_call_delta', { index: 0, toolCallId: id, nameDelta: 'checkpoint_context', argumentsDelta: JSON.stringify(args) });
  yield event(request, 2, 'response_completed', { finishReason: 'tool_calls' });
}
function* done(request) {
  yield event(request, 0, 'text_delta', { delta: 'Verification continued.' });
  yield event(request, 1, 'response_completed', { finishReason: 'stop' });
}
const shutdown = host => host.sendCommand({ kind: 'runtime.shutdown', payload: {} });

test('range selection keeps parallel receipts, image bytes and native replay intact', () => {
  const messages = [user('Goal.'), assistant('Old evidence. '.repeat(12000)),
    { role: 'assistant', content: '', reasoningContent: 'Inspect both results.', providerReplay: { format: 'fixture', data: { opaque: 'keep-original' } },
      toolCalls: [{ id: 'image', name: 'capture', argumentsText: '{}' }, { id: 'file', name: 'read', argumentsText: '{}' }] },
    { role: 'tool', toolCallId: 'file', content: 'VERSION_2 exact file result.' },
    { role: 'tool', toolCallId: 'image', content: 'Image delivered.', images: [{ url: `data:image/png;base64,${'A'.repeat(100000)}`, detail: 'high' }] }];
  const original = structuredClone(messages), ids = messages.map((_, i) => `current-${i}`);
  const pressure = { estimatedPromptTokens: 80000, usableInputTokens: 100000, reservedOutputTokens: 20000,
    measurement: 'provider', fallbackPromptTokens: 80000, fallbackScale: 1, ratio: 0.8 };
  const scope = selectContextCompactionScope({ messages, sources: [{ turnId: 'current', target: 'source 0', startMessage: 0, endMessageExclusive: 5 }],
    state: { revision: 1, totalTurns: 0, unsummarizedTurnIds: [], activeTurn: { turnId: 'current', throughMessageId: 'current-4' } },
    format: 'incremental', pressure, activeTurnId: 'current', activeInputCount: 1, messageIds: new Map([['current', ids]]) });
  assert.deepEqual(scope.retainedMessageIds, ids.slice(2));
  assert.equal(scope.state.activeTurn.throughMessageId, 'current-1');
  assert.equal(scope.sources[0].endMessageExclusive, 2);
  assert.deepEqual(messages, original);
  validateConversation(messages.slice(2));
});

for (const ordered of [false, true]) test(`three compactions retain exact recent corrections and only cover selected ranges (ordered=${ordered})`, async t => {
  const journal = [];
  const persistence = { load: () => structuredClone(journal), append: item => journal.push(structuredClone(item)) };
  const store = new SessionStore({ persistence });
  let serial = 0, marker, normal;
  const host = new InMemoryRuntimeHost({ sessionStore: store, registerDefaultWorkspaceTools: false,
    provider: { countInputTokens: count, async *stream(request) {
      validateConversation(request.messages);
      assert.equal(request.reasoningEffort, 'high'); assert.equal(request.maxOutputTokens, 4000);
      if (maintenance(request)) yield* checkpoint(request, `summary-${++serial}`);
      else { normal = structuredClone(request); yield* done(request); }
    } } });
  t.after(() => shutdown(host));
  for (let cycle = 0; cycle < 3; cycle++) {
    marker = `CORRECTION_${cycle}: volume=-16 LUFS; opening remains unapproved.`;
    seed(store, `history-${cycle}`, longHistory(marker));
    const before = structuredClone(store.snapshot('scope').turns);
    const request = input(`run-${cycle}`, ordered ? { tools: [orderedCheckpointTool] } : {});
    const result = await host.runSessionTurn(request);
    assert.equal(result.payload.status, 'completed', JSON.stringify(result.payload));
    assert.deepEqual(store.snapshot('scope').turns.slice(0, -1), before, 'canonical history is never rewritten');
    const checkpoint = store.snapshot('scope').turns.at(-1).contextCheckpoint;
    assert.ok(checkpoint.coveredMessageIds.includes(`history-${cycle}-0`));
    assert.ok(!checkpoint.coveredMessageIds.includes(`history-${cycle}-11`));
    assert.ok(!checkpoint.coveredTurnIds.includes(`history-${cycle}`), 'a partial source must not be marked wholly covered');
    assert.ok(normal.messages.some(message => message.content === `Latest correction: ${marker}`));
    assert.ok(normal.messages.some(message => message.content === `Exact recent response: ${marker}`));
    assert.ok(!normal.messages.some(message => message.content.startsWith('Old evidence 0:')));
    assert.ok(normal.messages.filter(message => message.content.startsWith('Old evidence')).length <= 1,
      'only evidence inside the recent budget can remain verbatim');
    const restored = new SessionStore({ persistence }).snapshot('scope');
    const projected = assembleContext({ session: restored, prefix: request.prefixMessages }).messages;
    assert.deepEqual(projected.slice(0, normal.messages.length), normal.messages, 'live, committed and replayed projections agree');
    validateConversation(projected);
    const completed = host.events('scope', `run-${cycle}`).find(event => event.kind === 'context_compaction_completed').payload;
    assert.ok(completed.inputTokensAfter <= completed.targetInputTokens);
    assert.ok(completed.inputTokensBefore > completed.inputTokensAfter);
  }
});

test('a long active turn retains its latest complete tool exchange without repeating side effects', async t => {
  const store = new SessionStore(), executed = [], observed = [];
  const registry = new ToolRegistry().register({ definition: { name: 'record_once', description: 'Record fixture work.', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'mutation', operation: 'fixture.write', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: true },
    decodeInput: value => value, execute: ({ input: value }) => { executed.push(value.id); return { id: value.id,
      result: value.id.startsWith('old') ? 'A'.repeat(13000) : 'LATEST_EXACT_RECEIPT ' + 'B'.repeat(2000) }; } });
  let calls = 0;
  const host = new InMemoryRuntimeHost({ sessionStore: store, toolRegistry: registry, registerDefaultWorkspaceTools: false,
    provider: { countInputTokens: count, async *stream(request) {
      observed.push(structuredClone(request));
      if (maintenance(request)) { yield* checkpoint(request, 'active-summary'); return; }
      if (calls < 3) {
        const id = calls < 2 ? `old-${calls++}` : (calls++, 'latest');
        yield event(request, 0, 'reasoning_delta', { delta: `Reasoning for ${id}.` });
        yield event(request, 1, 'tool_call_delta', { index: 0, toolCallId: id, nameDelta: 'record_once', argumentsDelta: JSON.stringify({ id }) });
        yield event(request, 2, 'usage', { inputTokens: tokens(request), outputTokens: 60 });
        yield event(request, 3, 'response_completed', { finishReason: 'tool_calls' });
      } else yield* done(request);
    } } });
  t.after(() => shutdown(host));
  const request = input('active', { permissionMode: 'all_free', tools: registry.definitions(), metadata: { contextWindowTokens: 12300 } });
  const result = await host.runSessionTurn(request);
  assert.equal(result.payload.status, 'completed', JSON.stringify(result.payload));
  assert.deepEqual(executed, ['old-0', 'old-1', 'latest']);
  const turn = store.snapshot('scope').turns.at(-1);
  assert.ok(turn.contextCheckpoint?.retainedMessageIds?.length >= 2, JSON.stringify({ checkpoint: turn.contextCheckpoint,
    requests: observed.map(request => ({ tokens: tokens(request), maintenance: maintenance(request),
      receipts: request.messages.filter(message => message.role === 'tool').map(message => ({ id: message.toolCallId, length: message.content.length })) })) }));
  const final = observed.at(-1).messages;
  assert.ok(final.some(message => message.role === 'tool' && message.toolCallId === 'latest'));
  assert.ok(!final.some(message => message.role === 'tool' && message.toolCallId.startsWith('old-')));
  const recentCall = final.find(message => message.role === 'assistant' && message.toolCalls.some(call => call.id === 'latest'));
  assert.equal(recentCall.reasoningContent, 'Reasoning for latest.');
  const rawLatest = turn.messages.find(item => item.message.role === 'tool' && item.message.toolCallId === 'latest');
  assert.deepEqual(final.find(message => message.role === 'tool' && message.toolCallId === 'latest'), rawLatest.message);
  assert.deepEqual(assembleContext({ session: store.snapshot('scope'), prefix: request.prefixMessages }).messages.slice(0, final.length), final);
  validateConversation(final);
});

for (const ordered of [false, true]) test(`a fitting but ineffective checkpoint stops after bounded refinement (ordered=${ordered})`, async t => {
  const store = new SessionStore(); seed(store, 'old', longHistory('KEEP THIS CORRECTION'));
  const before = structuredClone(store.snapshot('scope').turns);
  let calls = 0, normal = 0;
  const host = new InMemoryRuntimeHost({ sessionStore: store, registerDefaultWorkspaceTools: false,
    provider: { countInputTokens: async request => ({ source: 'provider', inputTokens: 13000 }),
      async *stream(request) {
        if (maintenance(request)) yield* checkpoint(request, `no-progress-${++calls}`);
        else { normal++; yield* done(request); }
      } } });
  t.after(() => shutdown(host));
  const result = await host.runSessionTurn(input('blocked', ordered ? { tools: [orderedCheckpointTool] } : {}));
  assert.equal(result.payload.reason, 'context_compaction_no_progress');
  assert.equal(calls, 3); assert.equal(normal, 0);
  assert.deepEqual(store.snapshot('scope').turns.slice(0, -1), before);
  assert.equal(store.snapshot('scope').turns.at(-1).contextCheckpoint, undefined);
  assert.equal(host.events('scope', 'blocked').filter(event => event.kind === 'context_compaction_started').length, 1);
  assert.equal(host.events('scope', 'blocked').filter(event => event.kind === 'context_compaction_completed').length, 0);
});

test('invalid retained facts and partial parallel-tool coverage fail closed', () => {
  const messages = [user('Work.'), { role: 'assistant', content: '', toolCalls: [
    { id: 'a', name: 'read', argumentsText: '{}' }, { id: 'b', name: 'read', argumentsText: '{}' }] },
    { role: 'tool', toolCallId: 'a', content: 'A' }, { role: 'tool', toolCallId: 'b', content: 'B' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'cp', name: 'checkpoint_context', argumentsText: '{}' }] },
    { role: 'tool', toolCallId: 'cp', content: 'Summary.' }].map((message, i) => ({ messageId: `m${i}`, message }));
  const checkpoint = { projectionVersion: 'exchange_v1', inputMessageCount: 1, throughMessageId: 'm5',
    exchangeMessageIds: ['m4', 'm5'], coveredTurnIds: [] };
  const project = retainedMessageIds => projectActiveTurnContext({ turnId: 'turn', inputMessages: messages.slice(0, 1),
    generatedMessages: messages.slice(1), checkpoint: { ...checkpoint, retainedMessageIds } });
  for (const ids of [['missing'], ['m0'], ['m4'], ['m2', 'm2'], ['m1', 'm2']]) assert.throws(() => project(ids));
  validateConversation(project(['m1', 'm2', 'm3']));
  const store = new SessionStore(); seed(store, 'old', messages.slice(0, 4).map(item => item.message));
  const current = [user('Continue.'), messages[4].message, messages[5].message];
  for (const coveredMessageIds of [['missing'], ['old-0', 'old-0'], ['old-2']]) {
    assert.throws(() => seed(store, 'new', current, { ...checkpoint, throughMessageId: 'new-2',
      exchangeMessageIds: ['new-1', 'new-2'], coveredMessageIds }));
  }
  assert.equal(store.snapshot('scope').turns.length, 1);
  seed(store, 'new', current, { ...checkpoint, throughMessageId: 'new-2', exchangeMessageIds: ['new-1', 'new-2'],
    coveredMessageIds: ['old-1', 'old-2', 'old-3'] });
  validateConversation(assembleContext({ session: store.snapshot('scope') }).messages);
});

test('the same compacted input cannot start a second compaction without new work', async t => {
  const store = new SessionStore(); seed(store, 'old', longHistory('UNCHANGED_INPUT'));
  let admitted = false, calls = 0;
  const host = new InMemoryRuntimeHost({ sessionStore: store, registerDefaultWorkspaceTools: false,
    provider: { countInputTokens: async request => {
      const applied = request.messages.some(message => message.role === 'tool' && message.content.includes('summarized_turns'));
      if (applied && !admitted) { admitted = true; return { source: 'provider', inputTokens: 1000 }; }
      return { source: 'provider', inputTokens: 13000 };
    }, async *stream(request) { yield* checkpoint(request, `once-${++calls}`); } } });
  t.after(() => shutdown(host));
  const result = await host.runSessionTurn(input('unchanged'));
  assert.equal(result.payload.reason, 'context_compaction_no_progress');
  assert.match(result.payload.details.message, /unchanged compacted request/);
  assert.equal(calls, 1);
  assert.equal(host.events('scope', 'unchanged').filter(event => event.kind === 'context_compaction_started').length, 1);
  assert.ok(store.snapshot('scope').turns.at(-1).contextCheckpoint, 'the one accepted checkpoint remains durable');
});

test('restart preserves the selected scope even when token counts change', async t => {
  const journal = [], checkpoints = new InMemoryRuntimeCheckpointStore(), events = new InMemoryRuntimeEventLog();
  const persistence = { load: () => structuredClone(journal), append: item => journal.push(structuredClone(item)) };
  const store = new SessionStore({ persistence });
  seed(store, 'old', longHistory('EXACT_RESTART_CORRECTION'));
  const controller = new AbortController(); let reached;
  const ready = new Promise(resolve => { reached = resolve; }); let lastRequest;
  const first = new InMemoryRuntimeHost({ sessionStore: store, checkpointStore: checkpoints, eventLog: events,
    registerDefaultWorkspaceTools: false, provider: { countInputTokens: count, async *stream(request) {
      lastRequest = structuredClone(request); reached(); await new Promise(() => {});
    } } });
  t.after(() => shutdown(first));
  const running = first.runSessionTurn(input('restart'), { signal: controller.signal });
  await ready;
  const saved = structuredClone(checkpoints.load('scope', 'restart'));
  const savedEvents = structuredClone(events.replay('scope', 'restart'));
  const savedJournal = structuredClone(journal);
  controller.abort(); await running;
  const restoredCheckpoints = new InMemoryRuntimeCheckpointStore(); restoredCheckpoints.save(saved);
  const restoredEvents = new InMemoryRuntimeEventLog({ persistence: { load: () => savedEvents, append: item => savedEvents.push(item) } });
  const restoredStore = new SessionStore({ persistence: { load: () => savedJournal, append: item => savedJournal.push(item) } });
  let serial = 0, normal;
  const second = new InMemoryRuntimeHost({ sessionStore: restoredStore, checkpointStore: restoredCheckpoints, eventLog: restoredEvents,
    registerDefaultWorkspaceTools: false, provider: { countInputTokens: async request => ({ source: 'provider', inputTokens: tokens(request) + 50 }),
      async *stream(request) {
        if (maintenance(request)) {
          if (serial === 0) assert.deepEqual(request.messages, lastRequest.messages, 'an interrupted dispatch uses its frozen source selection');
          yield* checkpoint(request, `resumed-${++serial}`);
        } else { normal = request; yield* done(request); }
      } } });
  t.after(() => shutdown(second));
  const result = await second.resumeModelTurn('scope', 'restart');
  assert.equal(result.payload.status, 'completed', JSON.stringify(result.payload));
  assert.ok(normal.messages.some(message => message.content === 'Latest correction: EXACT_RESTART_CORRECTION'));
  assert.equal(second.events('scope', 'restart').filter(event => event.kind === 'context_compaction_started').length, 1);
});
