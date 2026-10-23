import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionStore, ToolRegistry } from '../dist/index.js';
import { assembleContextProjection } from '../dist/contextAssembler.js';
import { conversationHistoryLocator, readConversationHistory, registerConversationHistoryTool } from '../dist/conversationHistory.js';
import { selectContextCompactionScope } from '../dist/contextCompactionScope.js';
import { ContextCompactionTransaction } from '../dist/contextCompactionTransaction.js';
import { stripToolDisplayTitle } from '../dist/toolDisplay.js';

const now = '2026-10-23T12:00:00Z';
const user = content => ({ role: 'user', content });
const assistant = content => ({ role: 'assistant', content, toolCalls: [] });
function seed(store, id, sequence, messages) {
  store.commitTurn('s', { turnId: id, turnSequence: sequence, createdAt: now, completedAt: now,
    status: 'completed', reason: 'fixture', usage: {}, messages: messages.map((message, i) => ({
      messageId: `${id}-${i}`, turnId: id, turnSequence: sequence, messageIndex: i, createdAt: now, message })) });
}
const read = (session, locator, args = {}) => readConversationHistory(session, { locator, offset: 0, maxChars: 50000, ...args });

test('history locators read immutable originals in bounded revision-checked pages and survive forks', () => {
  const store = new SessionStore();
  seed(store, 'first', 1, [user('Original scope. '.repeat(100)), { ...assistant('Visible result.'), reasoningContent: 'PRIVATE_REASONING',
    providerReplay: { format: 'opaque', model: 'fixture', messageHash: '0'.repeat(64), data: { secret: 'PRIVATE_REPLAY' } } }]);
  seed(store, 'last', 2, [user('Correction: cancel publication.')]);
  store.summarizeTurns({ sessionId: 's', expectedRevision: store.snapshot('s').revision,
    summaries: [{ turnId: 'first', summary: 'Compressed, original details available.' }] });
  const session = store.snapshot('s'), locator = conversationHistoryLocator('first', 'last');
  const whole = read(session, locator);
  assert.match(whole.text, /Original scope/); assert.match(whole.text, /cancel publication/);
  assert.doesNotMatch(whole.text, /PRIVATE_|reasoningContent|providerReplay/);
  let offset = 0, joined = '';
  do { const page = read(session, locator, { offset, maxChars: 500, revision: whole.revision });
    assert.ok(page.text.length <= 500); joined += page.text; offset = page.next_offset;
  } while (offset !== null);
  assert.equal(joined, whole.text);
  store.ensureSession('fork');
  assert.equal(read(store.fork('s', 'fork'), locator).text, whole.text);
  assert.throws(() => read(session, locator, { revision: session.revision + 1 }), /changed/);
  assert.throws(() => read(session, conversationHistoryLocator('other-session')), /unavailable/);
  assert.throws(() => read(session, 'file:///C:/private'), /exact/);
  assert.equal(read(session, locator, { offset: whole.total_chars + 1 }).next_offset, null);
});

test('history tool is deferred, session-scoped and validates page bounds', async () => {
  const store = new SessionStore(); seed(store, 'one', 1, [user('Read only this session.')]);
  const registry = new ToolRegistry(); registerConversationHistoryTool(registry, id => store.snapshot(id));
  const registration = registry.resolve('read_conversation_history');
  assert.equal(registration.deferredSchema, true);
  assert.equal(registration.manifest.dispatch_scope, 'session');
  const locator = conversationHistoryLocator('one');
  assert.throws(() => registration.decodeInput({ locator, max_chars: 50001 }), /bounds/);
  assert.throws(() => registration.decodeInput({ locator, session_id: 's' }), /exact/);
  const input = registration.decodeInput({ locator });
  const displayed = { locator, _display_title: { zh: '回看原始记录', en: 'Read original records' } };
  assert.deepEqual(registration.decodeInput(stripToolDisplayTitle(displayed, registration.definition)), input);
  assert.ok(displayed._display_title, 'normalization must not rewrite the recorded native call');
  assert.equal((await registration.execute({ sessionId: 's', input })).session_id, 's');
  await assert.rejects(async () => registration.execute({ sessionId: 'unrelated', input }), /available/);
});

test('all-summary scope merges only the oldest two thirds, freezes recovery and exposes inherited provenance', () => {
  const store = new SessionStore();
  for (let i = 0; i < 6; i++) seed(store, `turn-${i}`, i + 1, [user(`Original task ${i}`), assistant(`Original result ${i}`)]);
  store.summarizeTurns({ sessionId: 's', expectedRevision: store.snapshot('s').revision,
    summaries: Array.from({ length: 6 }, (_, i) => ({ turnId: `turn-${i}`, summary: `Topic ${i}; ` + 'known evidence. '.repeat(200) })) });
  const projection = assembleContextProjection({ session: store.snapshot('s') });
  assert.ok(projection.turns.every(t => t.summaryOnly && t.history.kind === 'turn_summary'));
  let start = 0;
  const sources = projection.turns.map((turn, index) => { const result = { turnId: turn.turnId, target: `source ${index}`,
    startMessage: start, endMessageExclusive: start + turn.messages.length, history: turn.history, summaryOnly: turn.summaryOnly };
    start = result.endMessageExclusive; return result; });
  const input = { messages: projection.context.messages, sources,
    state: { revision: 2, totalTurns: 6, unsummarizedTurnIds: sources.map(s => s.turnId) }, format: 'incremental',
    pressure: { estimatedPromptTokens: 40000, usableInputTokens: 40000, reservedOutputTokens: 4000, ratio: 1 },
    activeTurnId: 'new', activeInputCount: 0, messageIds: new Map() };
  const scope = selectContextCompactionScope(input);
  assert.deepEqual(scope.summaryGroupTurnIds, ['turn-0', 'turn-1', 'turn-2', 'turn-3']);
  assert.deepEqual(scope.state.unsummarizedTurnIds, ['turn-3']);
  assert.equal(scope.sources[0].history.locator, conversationHistoryLocator('turn-0', 'turn-3'));
  assert.equal(scope.sources[0].history.kind, 'merged_history');
  assert.deepEqual(scope.sources.slice(1).map(s => s.turnId), ['turn-4', 'turn-5']);
  assert.ok(scope.sources.slice(1).every(s => s.target === 'not_requested'));
  const restored = selectContextCompactionScope({ ...input, pressure: { ...input.pressure, estimatedPromptTokens: 70000 },
    savedRanges: scope.sourceRanges, savedSummaryGroupTurnIds: scope.summaryGroupTurnIds });
  assert.deepEqual(restored.sources, scope.sources);
  assert.throws(() => selectContextCompactionScope({ ...input, savedRanges: scope.sourceRanges,
    savedSummaryGroupTurnIds: [...scope.summaryGroupTurnIds].reverse() }), /chronological prefix/);
  const inherited = structuredClone(input);
  inherited.sources[2].history = { kind: 'checkpoint', locator: conversationHistoryLocator('ancestor', 'turn-2'),
    turnCount: 3, firstTurnSequence: 0 };
  assert.equal(selectContextCompactionScope(inherited).sources[0].history.locator,
    conversationHistoryLocator('ancestor', 'turn-3'), 'a later carrier can own history older than the first visible source');
  const tx = new ContextCompactionTransaction({ ...input, state: scope.state, sources: scope.sources, prefixMessageCount: 0,
    outputTokens: 4000, maximumOutputTokens: 4000, inputFormat: 'incremental', isolateSources: true });
  const rows = () => tx.job().messages.findLast(m => m.name === 'context_pressure').content.split('\n')
    .filter(line => line.startsWith('{')).map(JSON.parse);
  assert.equal(rows()[0].history.kind, 'merged_history');
  assert.doesNotMatch(JSON.stringify(tx.job().messages), /Topic 4;/);
  tx.partition();
  assert.equal(rows()[0].history.kind, 'merged_history', 'partitioning cannot erase inherited responsibility');
  const restoredTx = new ContextCompactionTransaction({ ...input, state: scope.state, sources: scope.sources, prefixMessageCount: 0,
    outputTokens: 4000, maximumOutputTokens: 4000, inputFormat: 'incremental', isolateSources: true, continuation: tx.incremental.history });
  assert.deepEqual(restoredTx.job(), tx.job());
  const lateCarrier = structuredClone(input);
  lateCarrier.sources[5].history = { kind: 'checkpoint', locator: conversationHistoryLocator('ancestor', 'turn-5'),
    turnCount: 9, firstTurnSequence: 0 };
  const lateScope = selectContextCompactionScope(lateCarrier);
  assert.deepEqual(lateScope.summaryGroupTurnIds, ['turn-5', 'turn-0', 'turn-1', 'turn-2'],
    'inherited history age, not carrier position, controls which memories are oldest');
  assert.deepEqual(lateScope.coveredTurnIds, ['turn-0', 'turn-1', 'turn-2', 'turn-5']);
  for (const inputFormat of ['incremental', 'ordered']) {
    const options = { ...lateCarrier, sources: lateScope.sources, state: lateScope.state, prefixMessageCount: 0,
      outputTokens: 4000, maximumOutputTokens: 4000, inputFormat, isolateSources: true };
    const noncontiguous = new ContextCompactionTransaction(options);
    const projected = JSON.stringify(noncontiguous.job().messages);
    assert.match(projected, /Topic 5;/); assert.match(projected, /Topic 2;/);
    assert.doesNotMatch(projected, /Topic [34];/, 'retained intervening sources must not leak into the merged source');
    assert.ok(noncontiguous.partition());
    if (inputFormat === 'incremental') {
      const recovered = new ContextCompactionTransaction({ ...options, continuation: noncontiguous.incremental.history });
      assert.deepEqual(recovered.job(), noncontiguous.job(), 'partition recovery preserves gaps and complete exchanges');
    }
  }
});

test('a checkpoint that covers only part of an older turn still points back to that older original', () => {
  const store = new SessionStore(); seed(store, 'original', 1, [user('Original requirement.'), assistant('Recent retained answer.')]);
  const messages = [user('Pause.'), { role: 'assistant', content: '', toolCalls: [{ id: 'cp', name: 'checkpoint_context', argumentsText: '{}' }] },
    { role: 'tool', toolCallId: 'cp', content: '{"summaries":[{"summary":"Original requirement still applies."}]}' }, assistant('Paused.')];
  store.commitTurn('s', { turnId: 'carrier', turnSequence: 2, createdAt: now, completedAt: now, status: 'completed', reason: 'fixture', usage: {},
    contextCheckpoint: { projectionVersion: 'exchange_v1', inputMessageCount: 1, throughMessageId: 'carrier-2',
      exchangeMessageIds: ['carrier-1', 'carrier-2'], coveredTurnIds: [], coveredMessageIds: ['original-0'] },
    messages: messages.map((message, i) => ({ messageId: `carrier-${i}`, turnId: 'carrier', turnSequence: 2, messageIndex: i, createdAt: now, message })) });
  const carrier = assembleContextProjection({ session: store.snapshot('s') }).turns.find(t => t.turnId === 'carrier');
  assert.equal(carrier.history.locator, conversationHistoryLocator('original', 'carrier'));
  assert.equal(carrier.history.turnCount, 2);
  assert.equal(carrier.history.firstTurnSequence, 1);
});
