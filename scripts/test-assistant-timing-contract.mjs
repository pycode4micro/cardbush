import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';

const source = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'chatMessages', 'assistantTurnTiming.ts'),
  'utf8',
);
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const values = new Map();
const localStorage = {
  getItem(key) {
    return values.get(key) ?? null;
  },
  setItem(key, value) {
    values.set(key, value);
  },
};
const loaded = { exports: {} };
vm.runInNewContext(transpiled.outputText, {
  module: loaded,
  exports: loaded.exports,
  localStorage,
  Date,
  JSON,
  Math,
  Number,
  Object,
});

const {
  assistantTurnTimingFingerprint,
  formatCompactDuration,
  hydrateAssistantTurnTiming,
  persistAssistantTurnTiming,
} = loaded.exports;

const projection = await loadChatTranscript({
  source: [
    'src/backend/runtimeSessionMessageProjection.ts',
    'src/features/chatMessages/transcript/liveMessageUpdates.ts',
    'src/features/chatMessages/transcript/messageFacts.ts',
    'src/features/chatMessages/transcript/messageProjection.ts',
  ].map(file => `export * from ${JSON.stringify(path.resolve(file))};`).join('\n'),
});

assert.equal(formatCompactDuration(null), '');
const continuationProjection = projection.projectRuntimeTurnMessages({
  turnId: 'continued', createdAt: '2026-09-06T00:00:00Z', completedAt: '2026-09-06T00:01:00Z', status: 'completed',
  messages: [
    { messageId: 'internal-continue', createdAt: '2026-09-06T00:00:20Z', message: {
      role: 'developer', name: 'output_limit_continuation', content: 'Internal continuation instruction',
    } },
    { messageId: 'internal-repair', createdAt: '2026-09-06T00:00:30Z', message: {
      role: 'developer', name: 'tool_call_repair', content: 'Internal tool validation correction',
    } },
    { messageId: 'final-answer', createdAt: '2026-09-06T00:01:00Z', message: {
      role: 'assistant', content: 'Complete answer', toolCalls: [],
    } },
  ],
}, 'continued');
assert.equal(continuationProjection.length, 1, 'internal developer continuation is not a chat message');
assert.equal(continuationProjection[0].content, 'Complete answer');
assert.equal(formatCompactDuration(999), '1s');
assert.equal(formatCompactDuration(59_000), '59s');
assert.equal(formatCompactDuration(60_000), '1m');
assert.equal(formatCompactDuration(61_000), '1m 1s');
assert.equal(formatCompactDuration(3_600_000), '1h');
assert.equal(formatCompactDuration((4 * 3600 + 26 * 60 + 57) * 1000), '4h 26m 57s');

const derived = hydrateAssistantTurnTiming([
  {
    id: 'user-derived',
    role: 'user',
    content: '检查耗时',
    conversationId: 'session-derived',
    turnId: 'turn-derived',
    createdAt: '2026-08-21T10:00:00Z',
  },
  {
    id: 'assistant-derived',
    role: 'assistant',
    content: '完成',
    conversationId: 'session-derived',
    turnId: 'turn-derived',
    createdAt: '2026-08-21T10:00:42Z',
  },
]);
assert.equal(derived[1].metadata.cardbush_turn_duration_ms, 42_000);
assert.equal(
  derived[1].metadata.cardbush_turn_timing_source,
  'derived_from_transcript',
);

const completed = {
  id: 'assistant-exact',
  role: 'assistant',
  content: '已完成',
  conversationId: 'session-exact',
  turnId: 'turn-exact',
  createdAt: '2026-08-21T11:00:45Z',
  metadata: {
    cardbush_turn_started_at: '2026-08-21T11:00:00Z',
    cardbush_turn_completed_at: '2026-08-21T11:00:45Z',
  },
};
persistAssistantTurnTiming({ 'session-exact': [completed] });
const reloaded = hydrateAssistantTurnTiming([
  {
    id: 'assistant-exact',
    role: 'assistant',
    content: '已完成',
    conversationId: 'session-exact',
    turnId: 'turn-exact',
    createdAt: '2026-08-21T11:00:45Z',
  },
]);
assert.equal(reloaded[0].metadata.cardbush_turn_duration_ms, 45_000);
assert.equal(
  reloaded[0].metadata.cardbush_turn_started_at,
  '2026-08-21T11:00:00Z',
);
assert.ok(
  assistantTurnTimingFingerprint({ 'session-exact': [completed] }).includes('turn-exact'),
);

const projectionSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'backend', 'runtimeSessionMessageProjection.ts'),
  'utf8',
);
assert.match(
  projectionSource,
  /cardbush_turn_started_at\s*=\s*startedAt/,
  'assistant history should project the Runtime-owned Turn start timestamp',
);
assert.match(
  projectionSource,
  /cardbush_turn_completed_at\s*=\s*completedAt/,
  'assistant history should project the Runtime-owned Turn completion timestamp',
);
assert.match(
  projectionSource,
  /cardbush_turn_duration_ms\s*=\s*durationMs/,
  'assistant history should derive duration only from committed Runtime timestamps',
);
assert.match(
  projectionSource,
  /runtimeMessageAttachments\(message\.metadata\)/,
  'history projection must restore durable attachment metadata for user bubbles',
);

const legacyTurn = {
  turnId: 'turn-with-legacy-file',
  turnSequence: 1,
  createdAt: '2026-09-01T00:00:00Z',
  completedAt: '2026-09-01T00:00:01Z',
  status: 'completed',
  reason: 'complete',
  usage: {},
  messages: [
    {
      messageId: 'legacy-context',
      turnId: 'turn-with-legacy-file',
      turnSequence: 1,
      messageIndex: 0,
      createdAt: '2026-09-01T00:00:00Z',
      message: {
        role: 'user',
        name: 'turn_runtime_context',
        visibility: 'internal',
        content: '<turn_runtime_context>\nAttached files:\nC:\\work\\brief.xlsx\n</turn_runtime_context>',
      },
    },
    {
      messageId: 'legacy-user',
      turnId: 'turn-with-legacy-file',
      turnSequence: 1,
      messageIndex: 1,
      createdAt: '2026-09-01T00:00:00Z',
      message: { role: 'user', content: '分析这个文件' },
    },
  ],
};
const restoredLegacyTurn = projection.restoreRuntimeTurnAttachmentMetadata(legacyTurn);
assert.equal(restoredLegacyTurn.messages[1].metadata.attachments[0].name, 'brief.xlsx');
assert.equal(restoredLegacyTurn.messages[1].metadata.attachments[0].type, 'document');
assert.equal(restoredLegacyTurn.messages[1].metadata.attachments[0].path, 'C:\\work\\brief.xlsx');

const projectedLoopTurn = projection.projectRuntimeTurnMessages({
  turnId: 'turn-with-loop',
  turnSequence: 2,
  createdAt: '2026-09-01T01:00:02Z',
  completedAt: '2026-09-01T01:02:05Z',
  status: 'completed',
  reason: 'complete',
  usage: {},
  messages: [
    {
      messageId: 'loop-user',
      turnId: 'turn-with-loop',
      turnSequence: 2,
      messageIndex: 0,
      createdAt: '2026-09-01T01:00:00Z',
      message: { role: 'user', content: '完成整个任务' },
    },
    {
      messageId: 'loop-preamble',
      turnId: 'turn-with-loop',
      turnSequence: 2,
      messageIndex: 1,
      createdAt: '2026-09-01T01:01:20Z',
      message: { role: 'assistant', content: '我先检查文件。' },
    },
    {
      messageId: 'loop-final',
      turnId: 'turn-with-loop',
      turnSequence: 2,
      messageIndex: 2,
      createdAt: '2026-09-01T01:02:01Z',
      message: { role: 'assistant', content: '任务已完成。' },
    },
  ],
}, 'session-with-loop');
assert.equal(
  projectedLoopTurn[2].metadata.cardbush_turn_started_at,
  '2026-09-01T01:00:02Z',
  'the final assistant must start timing at Runtime execution, not user submission',
);
assert.equal(
  projectedLoopTurn[2].metadata.cardbush_turn_completed_at,
  '2026-09-01T01:02:05Z',
  'the final assistant must stop timing at committed done',
);
assert.equal(projectedLoopTurn[2].metadata.cardbush_turn_duration_ms, 123_000);
assert.equal(projectedLoopTurn[2].metadata.cardbush_segment_duration_ms, 45_000);

// Queue waiting and execution have different clocks, without changing message
// chronology. Exercise the actual live reducers and committed-history merge.
const enqueuedAt = '2026-10-22T10:00:00.000Z';
const startedAt = '2026-10-22T10:02:20.000Z';
const completedAt = '2026-10-22T10:02:40.000Z';
const queuedUser = { id: 'queued-user', role: 'user', content: '检查耗时',
  conversationId: 'queue-session', turnId: 'queued-turn', createdAt: enqueuedAt };
const queuedAssistant = { id: 'queued-assistant', role: 'assistant', content: '', status: 'streaming',
  conversationId: 'queue-session', turnId: 'queued-turn', createdAt: enqueuedAt,
  metadata: { cardbush_turn_started_at: enqueuedAt } };
let queued = { 'queue-session': [queuedUser, queuedAssistant] };
queued = projection.assignTurnToLocalMessages(queued, 'queue-session', 'queued-turn',
  ['queued-user', 'queued-assistant'], { messageId: '', turnId: 'queued-turn', createdAt: startedAt });
assert.equal(queued['queue-session'][0].createdAt, enqueuedAt, 'keep the authored timestamp');
assert.equal(queued['queue-session'][1].createdAt, enqueuedAt, 'keep placeholder ordering stable');
assert.equal(queued['queue-session'][1].metadata.cardbush_turn_started_at, startedAt);
assert.equal(projection.chatTurnStartedAt(queued['queue-session'], 'queued-turn'), startedAt);
queued = projection.appendAssistantDelta(queued, 'queue-session', 'queued-assistant', '先检查。',
  { turnId: 'queued-turn', messageId: 'queued-loop-1', createdAt: '2026-10-22T10:02:21.000Z' });
queued = projection.appendAssistantDelta(queued, 'queue-session', 'queued-assistant', '继续检查。',
  { turnId: 'queued-turn', messageId: 'queued-loop-2', createdAt: '2026-10-22T10:02:25.000Z' });
for (const row of queued['queue-session'].filter(message => message.role === 'assistant')) {
  assert.equal(row.metadata.cardbush_turn_started_at, startedAt, 'tool/model loops keep the execution clock');
}
assert.equal(projection.chatTurnStartedAt([
  ...queued['queue-session'],
  { ...queuedUser, id: 'later-user', turnId: 'later-turn' },
  { ...queuedAssistant, id: 'later-assistant', turnId: 'later-turn',
    metadata: { cardbush_turn_started_at: completedAt } },
], 'later-turn'), completedAt, 'each queued task starts its own clock');
for (const status of ['completed', 'failed', 'stopped']) {
  const terminal = projection.applyTurnTerminalSnapshot(queued, 'queue-session', 'queued-assistant', {
    turnId: 'queued-turn', status, stopped: status === 'stopped', completedAt,
  });
  const reply = terminal['queue-session'].filter(message => message.role === 'assistant').at(-1);
  assert.equal(reply.metadata.cardbush_turn_duration_ms, 20_000, `${status} excludes queue wait`);
}

// A replayed start can arrive after the background placeholder. Subsequent
// deltas/reconnects must neither discard its content nor restart its clock.
let background = projection.ensureBackgroundTurnAssistant(
  { 'queue-session': [queuedUser, { ...queuedAssistant, content: '已收到的内容' }] },
  'queue-session', 'queued-assistant', 'queued-turn', { createdAt: startedAt, startedAt });
assert.equal(background['queue-session'][1].metadata.cardbush_turn_started_at, startedAt);
assert.equal(background['queue-session'][1].content, '已收到的内容');
assert.equal(projection.ensureBackgroundTurnAssistant(background, 'queue-session', 'queued-assistant', 'queued-turn'), background);
assert.equal(projection.ensureBackgroundTurnAssistant(background, 'queue-session', 'queued-assistant', 'queued-turn', { startedAt }), background);
assert.equal(projection.ensureBackgroundTurnAssistant(background, 'queue-session', 'queued-assistant', 'queued-turn',
  { createdAt: completedAt }), background, 'stream/final segment timestamps cannot restart the execution clock');
background = projection.ensureBackgroundTurnAssistant({ 'queue-session': [queuedUser] },
  'queue-session', 'queued-assistant', 'queued-turn', { createdAt: startedAt, startedAt });
assert.equal(projection.chatTurnStartedAt(background['queue-session'], 'queued-turn'), startedAt);

const savedQueue = projection.projectRuntimeTurnMessages({
  turnId: 'queued-turn', turnSequence: 1, createdAt: startedAt, completedAt,
  status: 'completed', reason: 'complete', usage: {}, messages: [
    { messageId: 'queued-user', turnId: 'queued-turn', turnSequence: 1, messageIndex: 0,
      createdAt: enqueuedAt, message: { role: 'user', content: '检查耗时' } },
    { messageId: 'queued-final', turnId: 'queued-turn', turnSequence: 1, messageIndex: 1,
      createdAt: completedAt, message: { role: 'assistant', content: '检查完成。' } },
  ],
}, 'queue-session');
const mergedQueue = projection.mergeFinalStreamMessages(
  { 'queue-session': [queuedUser, queuedAssistant] }, 'queue-session', savedQueue,
  { turnId: 'queued-turn', temporaryMessageIds: ['queued-assistant'] });
const mergedFinal = mergedQueue['queue-session'].find(message => message.role === 'assistant');
assert.equal(mergedFinal.metadata.cardbush_turn_started_at, startedAt, 'committed history wins over a stale live placeholder');
assert.equal(mergedFinal.metadata.cardbush_turn_duration_ms, 20_000);
assert.equal(savedQueue[0].createdAt, enqueuedAt);

persistAssistantTurnTiming({ 'queue-session': [{ ...queuedAssistant, status: 'completed',
  metadata: { cardbush_turn_started_at: enqueuedAt, cardbush_turn_completed_at: completedAt,
    cardbush_turn_duration_ms: 160_000 } }] });
const correctedCache = hydrateAssistantTurnTiming([{ ...queuedAssistant, status: 'completed',
  metadata: { cardbush_turn_started_at: startedAt, cardbush_turn_completed_at: completedAt } }]);
assert.equal(correctedCache[0].metadata.cardbush_turn_duration_ms, 20_000, 'old cached queue wait cannot override Runtime timestamps');
persistAssistantTurnTiming({ 'queue-session': correctedCache });
assert.equal(hydrateAssistantTurnTiming([{ ...queuedAssistant, metadata: undefined, status: 'completed' }])[0]
  .metadata.cardbush_turn_duration_ms, 20_000, 'corrected timing survives reload');

console.log('assistant turn timing persistence contract tests passed');

