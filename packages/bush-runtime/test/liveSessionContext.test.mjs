import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeRecoveryCoordinator } from '../dist/runtimeRecoveryCoordinator.js';
import { sessionSnapshotSchema } from '@cardbush/bush-protocol';

const time = '2026-11-06T00:00:00.000Z';
const facts = (turnId, messages, turnSequence = 1) => messages.map((message, messageIndex) => ({
  messageId: `${turnId}-${messageIndex}`, createdAt: time, turnId, turnSequence, messageIndex, message,
}));
const source = () => sessionSnapshotSchema.parse({ protocol: 'bush.session_snapshot.v1', sessionId: 'source',
  revision: 2, createdAt: time, updatedAt: time, supersededMessageIds: [], turns: [{ turnId: 'old', turnSequence: 1,
    createdAt: time, completedAt: time, status: 'completed', reason: 'done',
    messages: facts('old', [{ role: 'user', content: 'Original question' }, { role: 'assistant', content: 'Huge old evidence', toolCalls: [] }]),
    contextSummary: 'Compact historical evidence', usage: {},
  }] });
const recovery = commit => new RuntimeRecoveryCoordinator({ eventLog: {}, checkpoints: {
  load: () => structuredClone({ sessionCommit: commit }),
} });
const active = generatedMessages => ({ turnSequence: 2, createdAt: time, initialMessageCount: 1,
  inputMessages: facts('live-input', [{ role: 'user', content: 'Live question' }], 2), generatedMessages,
});

test('live model context honors committed and active compaction, without the parent system policy', () => {
  const generated = facts('live', [
    { role: 'assistant', content: '', toolCalls: [{ id: 'read', name: 'read_file', argumentsText: '{}' }] },
    { role: 'tool', toolCallId: 'read', content: 'Huge obsolete current evidence' },
    { role: 'assistant', content: 'Current continuation', toolCalls: [] },
  ], 2);
  const commit = { ...active(generated), prefixMessages: [{ role: 'system', content: 'Parent-only policy' }],
    activeContextCheckpoint: { projectionVersion: 'stable_v1', inputMessageCount: 1, throughMessageId: 'live-1', summary: 'Compact current evidence' } };
  const frozen = recovery(commit).readSessionContext(source(), 'live', 'live');
  const context = JSON.stringify(frozen.modelContext);
  assert.match(context, /Compact historical evidence/);
  assert.match(context, /Compact current evidence/);
  assert.match(context, /Current continuation/);
  assert.doesNotMatch(context, /Huge old evidence|Huge obsolete current evidence|Parent-only policy/);
  assert.equal(frozen.activeTurn.messages.length, 4, 'UI retains the frozen canonical transcript');
  commit.generatedMessages[2].message.content = 'Later mutation';
  assert.match(JSON.stringify(frozen.modelContext), /Current continuation/);
});

test('live exchange checkpoints cover earlier turns and retain complete recent tool receipts', () => {
  const generated = facts('live', [
    { role: 'assistant', content: '', toolCalls: [{ id: 'read', name: 'read_file', argumentsText: '{}' }] },
    { role: 'tool', toolCallId: 'read', content: 'Old current bytes' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'compact', name: 'checkpoint_context', argumentsText: '{"summary":"Compact both turns"}' }] },
    { role: 'tool', toolCallId: 'compact', content: 'Applied checkpoint' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'pending', name: 'read_file', argumentsText: '{}' }] },
  ], 2);
  const commit = { ...active(generated), activeContextCheckpoint: { projectionVersion: 'exchange_v1',
    inputMessageCount: 1, throughMessageId: 'live-3', exchangeMessageIds: ['live-2', 'live-3'], coveredTurnIds: ['old'] } };
  const frozen = recovery(commit).readSessionContext(source(), 'live');
  assert.match(JSON.stringify(frozen.modelContext), /Compact both turns/);
  assert.doesNotMatch(JSON.stringify(frozen.modelContext), /Huge old|Compact historical|Old current bytes|pending/);
  assert.equal(frozen.activeTurn.messages.length, 5, 'unfinished calls do not enter the frozen transcript');
});

test('historical selection excludes active input and invalid boundaries never return another context', () => {
  const read = recovery(active([])), session = source();
  const old = read.readSessionContext(session, 'live', 'old');
  assert.equal(old.activeTurn, undefined);
  assert.doesNotMatch(JSON.stringify(old.modelContext), /Live question/);
  assert.match(JSON.stringify(old.modelContext), /Compact historical evidence/);
  assert.deepEqual(read.readSessionContext(session, 'live', 'unknown'), {});
});
