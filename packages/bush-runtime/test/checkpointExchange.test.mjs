import { orderedCheckpointTool } from './helpers/orderedCheckpoint.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryRuntimeHost, SessionStore, assembleContext, projectActiveTurnContext } from '../dist/index.js';
import { extractSessionSource } from '../dist/sessionExtraction.js';
import { checkpointReceiptEntries, referenceSingleCheckpointSummary } from '../dist/checkpointReceipt.js';
import { hasInheritedCheckpointSkillConstraints } from '../dist/checkpointSkillConstraints.js';
import { collectCheckpointSkillExcerpts } from '../dist/checkpointSkillEvidence.js';
import { ToolRegistry } from '../dist/toolRegistry.js';

const now = '2026-09-11T00:00:00Z';
function turn(id, sequence, messages, contextCheckpoint) {
  return { turnId: id, turnSequence: sequence, createdAt: now, completedAt: now, status: 'completed', reason: 'model_response_completed', usage: {},
    ...(contextCheckpoint ? { contextCheckpoint } : {}),
    messages: messages.map((message, index) => ({ messageId: `${id}_${index}`, turnId: id, turnSequence: sequence, messageIndex: index, createdAt: now, message })) };
}
const call = (id, summary) => ({ role: 'assistant', content: '', reasoningContent: 'Preserve the verified facts.',
  toolCalls: [{ id, name: 'checkpoint_context', argumentsText: JSON.stringify({ summaries: [summary], active_summary: '' }) }] });
const receipt = id => ({ role: 'tool', toolCallId: id, content: '{"summarized_turns":["old"]}' });

for (const incremental of [false, true]) test(`all-summary history merges the oldest two thirds with a locator and keeps the recent third verbatim across repeated compaction (${incremental ? 'incremental' : 'ordered'})`, async t => {
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
        const sources = request.messages.findLast(m => m.name === 'context_pressure').content.split('\n')
          .filter(line => line.startsWith('{')).map(JSON.parse).filter(row => row.target !== 'not_requested');
        assert.equal(sources.length, 1);
        assert.equal(sources[0].history.kind, 'merged_history');
        const summaries = sources.map(source => [...new Set(JSON.stringify(request.messages.slice(source.startMessage, source.endMessageExclusive))
          .match(/VERIFIED_FACT_\d+/g))].join(' '));
        shouldCompact = false;
        yield event(1, 'reasoning_delta', { delta: 'Summarize the authorized sources.' });
        yield event(2, 'tool_call_delta', { index: 0, toolCallId: `checkpoint_${compactions}`, nameDelta: 'checkpoint_context',
          argumentsDelta: JSON.stringify(incremental ? { updates: summaries.map((summary, source) => ({ source, summary })) } : { summaries }) });
        yield event(3, 'response_completed', { finishReason: 'tool_calls' });
      } else {
        yield event(1, 'text_delta', { delta: 'Follow-up completed.' });
        yield event(2, 'response_completed', { finishReason: 'stop' });
      }
    },
  };
  const registry = new ToolRegistry();
  const host = new InMemoryRuntimeHost({ provider, sessionStore: store, toolRegistry: registry, registerDefaultWorkspaceTools: false });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const request = id => ({ protocol: 'bush.session_turn_request.v1', requestId: id, sessionId: 's', turnId: id,
    model: 'fixture', tools: [incremental ? registry.resolve('checkpoint_context').definition : orderedCheckpointTool], prefixMessages: [{ role: 'system', content: 'fixed' }], inputMessages: [{ messageId: `${id}_user`, message: { role: 'user', content: 'Follow up.' } }],
    maxOutputTokens: 1000, metadata: { contextWindowTokens: 4000 } });
  assert.equal((await host.runSessionTurn(request('one'))).payload.status, 'completed');
  assert.deepEqual(store.snapshot('s').turns.slice(0, 25), original);
  const covered = store.snapshot('s').turns[25].contextCheckpoint.coveredTurnIds;
  assert.deepEqual(covered, ids.slice(0, 17));
  assert.equal(observed[0].messages.filter(message => message.name === 'turn_context_summary').length, 17);
  assert.equal(observed[1].messages.filter(message => message.name === 'turn_context_summary').length, 8);
  for (let i = 0; i < 25; i++) assert.equal([...JSON.stringify(observed[1].messages).matchAll(/VERIFIED_FACT_\d+/g)]
    .filter(match => match[0] === `VERIFIED_FACT_${i}`).length, 1);
  assert.equal(events.filter(event => event.kind === 'turn_context_summarized').length, 1, 'no partial summary write precedes the checkpoint commit');
  const restored = new SessionStore({ persistence }).snapshot('s');
  const expectedPrefix = assembleContext({ session: restored, prefix: request('one').prefixMessages }).messages;
  shouldCompact = true;
  assert.equal((await host.runSessionTurn(request('two'))).payload.status, 'completed');
  for (const message of expectedPrefix.filter(m => m.name === 'turn_context_summary')) {
    assert.ok(observed[2].messages.some(m => m.content === message.content) || observed[3].messages.some(m => m.content === message.content), 'selected or retained summaries remain verbatim');
  }
  const snapshot = store.snapshot('s');
  assert.deepEqual(snapshot.turns.slice(0, 25), original);
  const active = observed.at(-1).messages;
  const committed = assembleContext({ session: snapshot, prefix: request('two').prefixMessages }).messages;
  assert.deepEqual(committed.slice(0, active.length), active);
  for (const id of ids.map((_, i) => `VERIFIED_FACT_${i}`)) assert.equal(
    [...JSON.stringify(committed).matchAll(/VERIFIED_FACT_\d+/g)].filter(match => match[0] === id).length, 1,
    'each fact is represented once, either in a retained original summary or merged memory');
  const marker = committed.filter(m => m.role === 'tool').map(m => JSON.parse(m.content)).find(m => m.merged_history);
  assert.match(marker.merged_history.locator, /^conversation-history:\/\/turns\//);
  if (incremental) {
    assert.equal(marker.summaries, undefined, 'the single merged summary is not duplicated in its receipt');
    assert.equal(marker.summary_from_call.argument, 'updates[0].summary');
    assert.ok(extractSessionSource(snapshot).units.some(unit => unit.summarized && unit.text.includes('VERIFIED_FACT_0')));
  }
  assert.ok(committed.some(message => message.content === 'Follow-up completed.'), 'the recent final response remains verbatim');
  assert.equal(compactions, 2);
});

test('single-summary references preserve inherited Skill evidence and reject mismatched calls', () => {
  const summary = 'Facts <skill_constraints>Keep the scope. Read C:/task/SKILL.md before resuming.</skill_constraints>';
  const nativeCall = { id: 'merge', name: 'checkpoint_context', argumentsText: JSON.stringify({ updates: [{ source: 0, summary }] }) };
  const original = { complete: true, accepted: [0], summarized_turns: ['old'], summaries: [{ source: 0, turn_id: 'old', current: false, summary }] };
  const lean = referenceSingleCheckpointSummary(original, nativeCall);
  assert.deepEqual(checkpointReceiptEntries(lean, nativeCall), original.summaries);
  const messages = [{ role: 'assistant', content: '', toolCalls: [nativeCall] }, { role: 'tool', toolCallId: nativeCall.id, content: JSON.stringify(lean) }];
  assert.equal(hasInheritedCheckpointSkillConstraints(messages), true);
  assert.equal(collectCheckpointSkillExcerpts(messages)[0].text, summary);
  assert.deepEqual(checkpointReceiptEntries(lean, { ...nativeCall, id: 'wrong' }), []);
  assert.deepEqual(checkpointReceiptEntries({ ...lean, complete: false }, nativeCall), []);
  assert.deepEqual(referenceSingleCheckpointSummary(original, { ...nativeCall, argumentsText: '{}' }), original);
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
