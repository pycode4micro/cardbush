import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';

const api = await loadChatTranscript({ source: [
  'src/features/chatMessages/assistantTranscriptPresentation.ts',
  'src/features/chatMessages/assistantTurnTiming.ts',
  'src/features/chatMessages/transcript/loopHistory.ts',
].map(file => `export * from ${JSON.stringify(path.resolve(file))};`).join('\n') });
const tool = (id, extra = {}) => ({ id, name: 'terminal_exec', state: 'completed', success: true,
  output: '', summary: 'Checked', durationMs: 20, contentOffset: 0, contentOffsetExplicit: true, metadata: {}, ...extra });
const message = (id, content = '', extra = {}) => ({ id, role: 'assistant', content,
  turnId: 'turn', conversationId: 'session', toolExecutions: [tool('tool-' + id)], ...extra });
const plain = value => JSON.parse(JSON.stringify(value));

test('unchanged narration groups retain identity while a long tail grows', () => {
  const project = api.createAssistantTranscriptProjector();
  const messages = Array.from({ length: 500 }, (_, index) => message('round-' + index,
    index % 9 === 0 ? `Narration ${index}` : '', {
      toolExecutions: [tool('tool-' + index, { contentOffset: index % 9 === 0 ? `Narration ${index}`.length : 0 })],
    }));
  const before = project(messages);
  const unchanged = project([...messages]);
  assert.ok(before.every((group, index) => group === unchanged[index]));
  const after = project([...messages, message('new-tail')]);
  assert.ok(before.slice(0, -1).every((group, index) => group === after[index]));
  assert.notStrictEqual(before.at(-1), after.at(-1));
  assert.equal(after.flatMap(group => group.toolExecutions).length, 501);
  assert.deepEqual(plain(after), plain(api.coalesceAssistantTranscript([...messages, message('new-tail')])));
  project([]);
  assert.notStrictEqual(project(messages)[0], before[0], 'clearing a view discards its retained groups');
});

test('late tool results, attachments and plans invalidate their group without losing narration or provenance', () => {
  const project = api.createAssistantTranscriptProjector();
  const messages = [message('intro', 'Inspect'), message('first'), message('second'),
    message('next', 'Next', { toolExecutions: [tool('next-tool', { contentOffset: 4 })] }), message('third')];
  const before = project(messages);
  const changed = { ...messages[1], taskPlan: { active: true, steps: [] },
    toolExecutions: [tool('tool-first', { output: 'late result', metadata: { source: 'receipt-1' },
      artifacts: [{ type: 'image', path: 'D:/fixture/result.png', name: 'Result' }] })] };
  const after = project([messages[0], changed, ...messages.slice(2)]);
  assert.notStrictEqual(after[0], before[0]);
  assert.strictEqual(after[1], before[1]);
  assert.strictEqual(after[0].taskPlan, changed.taskPlan);
  const updated = after[0].toolExecutions.find(item => item.id === 'tool-first');
  assert.equal(updated.output, 'late result');
  assert.equal(updated.metadata.source, 'receipt-1');
  assert.equal(updated.artifacts[0].path, 'D:/fixture/result.png');
  assert.equal(before[0].toolExecutions.find(item => item.id === 'tool-first').output, '');
  assert.equal(messages[1].toolExecutions[0].contentOffset, 0, 'source offsets stay unchanged');
});

test('streamed narration after offset-zero tools preserves both boundaries and identity on a later update', () => {
  const project = api.createAssistantTranscriptProjector();
  const intro = message('intro', 'Inspect', { toolExecutions: [] });
  const later = message('later', 'New narration', { toolExecutions: [tool('before'), tool('after', { contentOffset: 13 })] });
  const first = project([intro, later]);
  assert.deepEqual(plain(first.map(group => group.toolExecutions.map(item => item.id))), [['before'], ['after']]);
  const next = project([intro, later, message('tail')]);
  assert.strictEqual(first[0], next[0]);
  assert.equal(next[1].content, 'New narration');
  assert.deepEqual(plain(next[1].toolExecutions.map(item => item.id)), ['after', 'tool-tail']);
});

test('tool-only continuation does not repeatedly traverse the entire accumulated tool prefix', () => {
  let visits = 0;
  const accumulated = Array.from({ length: 1000 }, (_, i) => ({ ...tool('existing-' + i),
    get id() { visits++; return 'existing-' + i; },
  }));
  const rounds = Array.from({ length: 1000 }, (_, i) => message('large-' + i));
  const result = api.coalesceAssistantTranscript([message('accumulated', 'Inspect', { toolExecutions: accumulated }), ...rounds]);
  assert.equal(result.length, 1);
  assert.equal(result[0].toolExecutions.length, 2000);
  assert.ok(visits < accumulated.length * 5, `earlier tool records must not be revisited per appended round (${visits} visits)`);
});

test('history snapshots reuse immutable sources and accept replacement facts', () => {
  const original = message('snapshot');
  const snapshot = api.snapshotLoopHistoryMessage(original);
  assert.strictEqual(api.snapshotLoopHistoryMessage(original), snapshot);
  assert.strictEqual(api.snapshotLoopHistoryMessage(snapshot), snapshot);
  assert.notStrictEqual(snapshot.toolExecutions[0], original.toolExecutions[0], 'snapshot keeps its initial defensive copy');
  const replacement = { ...original, toolExecutions: [tool('tool-snapshot', { output: 'new result' })] };
  assert.equal(api.snapshotLoopHistoryMessage(replacement).toolExecutions[0].output, 'new result');
  assert.equal(snapshot.toolExecutions[0].output, '');
});

test('timing is derived once per turn and keeps unchanged message identities', () => {
  let timestampReads = 0;
  const messages = Array.from({ length: 500 }, (_, i) => ({ ...message('timed-' + i),
    get createdAt() { timestampReads++; return new Date(Date.UTC(2026, 9, 18, 0, 0, i)).toISOString(); },
  }));
  const before = api.hydrateAssistantTurnTiming(messages);
  assert.ok(timestampReads < messages.length * 5, `turn timing should not rescan all messages per segment (${timestampReads} reads)`);
  const after = api.hydrateAssistantTurnTiming([...messages]);
  assert.ok(before.every((item, index) => item === after[index]));
  const longer = api.hydrateAssistantTurnTiming([...messages, { ...message('later'), createdAt: '2026-10-18T01:00:00Z' }]);
  assert.equal(longer[0].metadata.cardbush_turn_duration_ms, 3600000, 'a later history timestamp refreshes the derived timing');
});

test('appending live rounds does not fabricate a completion time on every old message', () => {
  const messages = [message('live-1', 'Working', { status: 'streaming', createdAt: '2026-10-18T00:00:00Z' }),
    message('live-2', '', { status: 'streaming', createdAt: '2026-10-18T00:00:10Z' })];
  const before = api.hydrateAssistantTurnTiming(messages);
  const after = api.hydrateAssistantTurnTiming([...messages,
    message('live-3', '', { status: 'streaming', createdAt: '2026-10-18T00:00:20Z' })]);
  assert.strictEqual(before[0], after[0]);
  assert.strictEqual(before[1], after[1]);
  assert.equal(after[0].metadata.cardbush_turn_completed_at, undefined);
});
