import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryRuntimeHost, SessionStore, assembleContext, projectActiveTurnContext } from '../dist/index.js';

const now = '2026-09-11T00:00:00Z';
function turn(id, sequence, messages, contextCheckpoint) {
  return { turnId: id, turnSequence: sequence, createdAt: now, completedAt: now, status: 'completed', reason: 'model_response_completed', usage: {},
    ...(contextCheckpoint ? { contextCheckpoint } : {}),
    messages: messages.map((message, index) => ({ messageId: `${id}_${index}`, turnId: id, turnSequence: sequence, messageIndex: index, createdAt: now, message })) };
}
const call = (id, summary) => ({ role: 'assistant', content: '', reasoningContent: 'Preserve the verified facts.',
  toolCalls: [{ id, name: 'checkpoint_context', argumentsText: JSON.stringify({ summaries: [summary], active_summary: '' }) }] });
const receipt = id => ({ role: 'tool', toolCallId: id, content: '{"summarized_turns":["old"]}' });

test('legacy summaries are explicitly compacted, never silently dropped at the 20-turn fallback', async t => {
  const events = [];
  const persistence = { load: () => structuredClone(events), append: event => events.push(structuredClone(event)) };
  const store = new SessionStore({ persistence });
  const ids = Array.from({ length: 25 }, (_, index) => `old_${index}`);
  for (const [index, id] of ids.entries()) store.commitTurn('s', turn(id, index + 1, [
    { role: 'user', content: `Original request ${index}` }, { role: 'assistant', content: `Original answer ${index}`, toolCalls: [] },
  ]));
  store.summarizeTurns({ sessionId: 's', expectedRevision: store.snapshot('s').revision,
    summaries: ids.map((turnId, index) => ({ turnId, summary: `VERIFIED_FACT_${index}` })) });
  const original = structuredClone(store.snapshot('s').turns);
  const observed = []; let shouldCompact = true, compactions = 0;
  const provider = {
    async countInputTokens() { return { inputTokens: shouldCompact ? 2860 : 100, source: 'provider' }; },
    async *stream(request) {
      observed.push(structuredClone(request));
      const event = (sequence, kind, payload) => ({ protocol: 'bush.model_event.v1', requestId: request.requestId, sequence, createdAt: now, kind, ...payload });
      yield event(0, 'response_started', {});
      if (request.messages.some(message => message.name === 'context_pressure')) {
        compactions++;
        // First summarize every legacy source; then summarize the retained
        // checkpoint and final reply as one source in the following Turn.
        const summaries = compactions === 1 ? ids.map((_, i) => `VERIFIED_FACT_${i}`) : [ids.map((_, i) => `VERIFIED_FACT_${i}`).join(' ') + '; first follow-up completed.'];
        shouldCompact = false;
        yield event(1, 'reasoning_delta', { delta: 'Summarize the authorized sources.' });
        yield event(2, 'tool_call_delta', { index: 0, toolCallId: `checkpoint_${compactions}`, nameDelta: 'checkpoint_context',
          argumentsDelta: JSON.stringify({ summaries, active_summary: '' }) });
        yield event(3, 'response_completed', { finishReason: 'tool_calls' });
      } else {
        yield event(1, 'text_delta', { delta: 'Follow-up completed.' });
        yield event(2, 'response_completed', { finishReason: 'stop' });
      }
    },
  };
  const host = new InMemoryRuntimeHost({ provider, sessionStore: store, registerDefaultWorkspaceTools: false });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const request = id => ({ protocol: 'bush.session_turn_request.v1', requestId: id, sessionId: 's', turnId: id,
    model: 'fixture', prefixMessages: [{ role: 'system', content: 'fixed' }], inputMessages: [{ messageId: `${id}_user`, message: { role: 'user', content: 'Follow up.' } }],
    maxOutputTokens: 1000, metadata: { contextWindowTokens: 4000 } });
  assert.equal((await host.runSessionTurn(request('one'))).payload.status, 'completed');
  assert.deepEqual(store.snapshot('s').turns.slice(0, 25), original);
  assert.deepEqual(store.snapshot('s').turns[25].contextCheckpoint.coveredTurnIds, ids);
  assert.equal(observed[0].messages.filter(message => message.name === 'turn_context_summary').length, 25);
  assert.equal(observed[1].messages.filter(message => message.name === 'turn_context_summary').length, 0);
  for (let i = 0; i < 25; i++) assert.equal(JSON.stringify(observed[1].messages).match(new RegExp(`VERIFIED_FACT_${i}(?=\\\\?"| )`, 'g'))?.length, 1);
  assert.equal(events.filter(event => event.kind === 'turn_context_summarized').length, 1, 'no partial summary write precedes the checkpoint commit');
  const restored = new SessionStore({ persistence }).snapshot('s');
  const expectedPrefix = assembleContext({ session: restored, prefix: request('one').prefixMessages }).messages;
  shouldCompact = true;
  assert.equal((await host.runSessionTurn(request('two'))).payload.status, 'completed');
  assert.deepEqual(observed[2].messages.slice(0, expectedPrefix.length), expectedPrefix);
  const snapshot = store.snapshot('s');
  assert.deepEqual(new Set(snapshot.turns.at(-1).contextCheckpoint.coveredTurnIds), new Set([...ids, 'one']));
  const active = observed.at(-1).messages;
  const committed = assembleContext({ session: snapshot, prefix: request('two').prefixMessages }).messages;
  assert.deepEqual(committed.slice(0, active.length), active);
  assert.equal(committed.filter(message => message.role === 'assistant' && message.toolCalls.length).length, 1);
  assert.equal(compactions, 2);
});

test('checkpoint references cannot point to missing, mismatched or future facts', () => {
  const messages = [{ role: 'user', content: 'Continue' }, call('cp', 'Kept facts'), receipt('cp')];
  const checkpoint = { projectionVersion: 'exchange_v1', throughMessageId: 'new_2', inputMessageCount: 1,
    exchangeMessageIds: ['new_1', 'new_2'], coveredTurnIds: ['old'] };
  const current = turn('new', 2, messages, checkpoint);
  const store = new SessionStore();
  store.commitTurn('s', turn('old', 1, [{ role: 'user', content: 'Old' }]));
  for (const variant of [
    { ...checkpoint, exchangeMessageIds: ['missing', 'new_2'] },
    { ...checkpoint, coveredTurnIds: ['future'] },
    { ...checkpoint, coveredTurnIds: ['old', 'old'] },
    { ...checkpoint, coveredTurnIds: ['new'] },
  ]) assert.throws(() => store.commitTurn('s', { ...current, contextCheckpoint: variant }), /checkpoint/i);
  const wrongPair = structuredClone(current); wrongPair.messages[2].message.toolCallId = 'other';
  assert.throws(() => projectActiveTurnContext({ turnId: 'new', inputMessages: wrongPair.messages.slice(0, 1),
    generatedMessages: wrongPair.messages.slice(1), checkpoint }), /complete canonical/);
  assert.equal(store.snapshot('s').turns.length, 1, 'rejected projections do not mutate history');
  assert.equal(store.commitTurn('s', current).turns.length, 2);
});
