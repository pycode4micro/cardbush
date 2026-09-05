import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { loadChatTranscript, transcriptDirectory, transcriptModules } from './helpers/load-chat-transcript.mjs';

// Keep a one-way dependency graph, not six files importing a shared mega-Hook.
const allowed = {
  assistantStreamBuffer: [],
  messageFacts: [],
  toolExecutionMerge: ['messageFacts'],
  loopHistory: ['messageFacts', 'toolExecutionMerge'],
  liveMessageUpdates: ['assistantStreamBuffer', 'messageFacts', 'loopHistory', 'toolExecutionMerge'],
  messageProjection: ['messageFacts', 'loopHistory', 'toolExecutionMerge'],
};
const adapters = new Set([
  '../assistantTurnTiming', '../../../shared/goalState',
  '../../../backend/toolArtifacts', '../../../backend/historyToolAssociation',
]);
const ownedFunctions = new Set();
for (const name of transcriptModules) {
  const source = ts.createSourceFile(name + '.ts', fs.readFileSync(path.join(transcriptDirectory, name + '.ts'), 'utf8'), 99, true);
  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      assert.ok(!ownedFunctions.has(statement.name.text), 'Each transcript function must have one owner');
      ownedFunctions.add(statement.name.text);
    }
    if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
    if (statement.importClause?.namedBindings?.elements?.every(e => e.isTypeOnly)) continue;
    const target = statement.moduleSpecifier.text;
    assert.ok(adapters.has(target) || allowed[name].some(dep => target === './' + dep),
      `${name} must not import React, the Hook, Runtime clients or a higher-layer module: ${target}`);
  }
}
const hook = ts.createSourceFile('hook.ts', fs.readFileSync('src/hooks/useCardbushChat.ts', 'utf8'), 99, true);
for (const statement of hook.statements) {
  if (ts.isFunctionDeclaration(statement)) {
    assert.ok(!ownedFunctions.has(statement.name.text), 'The Hook must use the module, not retain a second implementation');
  }
}
for (const [file, importer] of [
  ['src/ShadowWindow.tsx', './hooks/useCardbushChat'],
  ['src/features/pre_test/LoopHistoryPreTest.tsx', '../../hooks/useCardbushChat'],
]) {
  assert.ok(!fs.readFileSync(file, 'utf8').includes(`from '${importer}'`), 'Read-only transcript consumers must not depend on the chat Hook');
}

const timers = new Map();
let nextTimer = 0;
const window = {
  setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; },
  clearTimeout(id) { timers.delete(id); },
  matchMedia: () => ({ matches: false }),
};
const flush = () => {
  let count = 0;
  while (timers.size) {
    assert.ok(++count < 1000, 'Reveal must have a bounded commit count');
    const [id, fn] = timers.entries().next().value;
    timers.delete(id); fn();
  }
};
const api = await loadChatTranscript({ globals: { window, document: { visibilityState: 'visible' } } });
const plain = value => JSON.parse(JSON.stringify(value));
const freeze = value => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
};
const route = (messageId, assistantSegmentIndex, turnId = 'turn') => ({ messageId, assistantSegmentIndex, turnId });

// Two concurrent segment buffers retain their routes and do not release each other.
const emitted = [];
const buffers = api.createSegmentedAssistantStreamBuffers((delta, target, release) => {
  emitted.push({ delta, target, release });
}, { shouldAnimate: () => false });
const a = route('a', 1), b = route('b', 2);
buffers.push('第一段 🧪', a); buffers.push('第二段', b);
assert.equal(emitted.length, 0);
await buffers.completeSegment('第一段 🧪', { ...a, segmentId: 'segment-a' });
assert.equal(emitted.length, 1);
assert.equal(emitted[0].target.messageId, 'a');
await buffers.completeSegment('第一段 🧪', { ...a, segmentId: 'segment-a' });
assert.equal(emitted.length, 1, 'Repeated completion must not duplicate text');
const finalDrain = buffers.completeRoute('第二段，完成', b);
await buffers.releaseTerminal(); await finalDrain;
assert.equal(emitted[1].target.messageId, 'b');
assert.equal(emitted[1].delta, '第二段，完成');
buffers.dispose();

// Terminal may arrive just before a final delta; dispose cancels visual work only.
const lateChunks = [];
const late = api.createAssistantStreamDeltaBuffer(delta => lateChunks.push(delta));
await late.releaseTerminal(); late.push('最后的回答');
flush(); await late.flushAllStreaming();
assert.equal(lateChunks.join(''), '最后的回答');
late.dispose();
const cancelledChunks = [];
const cancelled = api.createAssistantStreamDeltaBuffer(delta => cancelledChunks.push(delta));
cancelled.push('需要逐步展示的文本'.repeat(80));
const drain = cancelled.releaseTerminal();
assert.ok(timers.size > 0);
const beforeDispose = cancelledChunks.join('');
cancelled.dispose(); flush(); await drain;
assert.equal(cancelledChunks.join(''), beforeDispose);
assert.equal(timers.size, 0, 'Unmount must not leave timers or unresolved drain work');

// Reset affects only its own route, including when a reveal is in progress.
const resetChunks = [];
const reset = api.createSegmentedAssistantStreamBuffers((delta, target) => resetChunks.push([target.messageId, delta]));
reset.push('旧文本'.repeat(80), a); reset.push('独立段落', b);
const oldDrain = reset.completeSegment('旧文本'.repeat(80), { ...a, segmentId: 'reset-a' });
reset.reset(a); const afterReset = resetChunks.length;
flush(); await oldDrain;
assert.equal(resetChunks.length, afterReset);
await reset.completeSegment('独立段落', { ...b, segmentId: 'reset-b' });
assert.deepEqual(plain(resetChunks.at(-1)), ['b', '独立段落']);
reset.dispose();

// Live updates do not mutate caller-owned facts or cross session boundaries.
const initial = freeze({
  s: [{ id: 'a', role: 'assistant', content: '开始', turnId: 'turn', metadata: { assistant_segment_index: 1 } }],
  other: [{ id: 'other-user', role: 'user', content: '保持不变' }],
});
const updated = api.appendAssistantDelta(initial, 's', 'a', '继续', a);
assert.equal(initial.s[0].content, '开始');
assert.equal(updated.s[0].content, '开始继续');
assert.strictEqual(updated.other, initial.other);
assert.strictEqual(api.applyTaskPlanUpdate(updated, 's', 'a', { plan: { sessionId: 'other' } }), updated);

const execution = {
  id: 'tool-1', name: 'edit_file', state: 'completed', success: true,
  summary: 'edited', output: 'done', metadata: {}, durationMs: 25,
  contentOffset: 2, createdAt: '2026-09-01T00:00:00.000Z',
  artifacts: [{ id: 'image', name: 'result.png', path: 'C:/result.png', type: 'image' }],
};
const settled = api.mergeToolExecutionUpdate(freeze(execution), { ...execution, state: 'running', success: false, durationMs: 0, artifacts: [] });
assert.equal(settled.state, 'completed');
assert.equal(settled.success, true);
assert.equal(settled.durationMs, 25);
assert.equal(settled.artifacts.length, 1);

// Array-identity caching remains shared and does not mutate persisted messages.
const history = freeze([
  { id: 'message_user', role: 'user', content: '请求', turnId: 'turn', createdAt: '2026-09-01T00:00:00.000Z' },
  { id: 'message_assistant', role: 'assistant', content: '完成', turnId: 'turn', status: 'completed', createdAt: '2026-09-01T00:00:01.000Z' },
]);
const normalized = api.normalizeChatMessagesForDisplay(history);
assert.strictEqual(api.normalizeChatMessagesForDisplay(history), normalized);
assert.equal(history[1].metadata, undefined);
assert.deepEqual(plain(normalized.map(m => [m.id, m.content])), plain(history.map(m => [m.id, m.content])));
assert.strictEqual(api.normalizeActiveTurnTranscriptForDisplay(history, ''), history);
assert.equal(api.persistedChatMessageId({ id: 'optimistic', metadata: { message_id: 'message_durable' } }), 'message_durable');

console.log('Chat transcript module boundaries, buffering, mutation and identity tests passed.');
