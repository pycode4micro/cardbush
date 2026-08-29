import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

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
  hydrateAssistantTurnTiming,
  persistAssistantTurnTiming,
} = loaded.exports;

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

const apiSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'backend', 'api.ts'),
  'utf8',
);
assert.match(
  apiSource,
  /cardbush_turn_started_at\s*=\s*turn\.createdAt/,
  'assistant history should project the Runtime-owned Turn start timestamp',
);
assert.match(
  apiSource,
  /cardbush_turn_completed_at\s*=\s*turn\.completedAt/,
  'assistant history should project the Runtime-owned Turn completion timestamp',
);
assert.match(
  apiSource,
  /cardbush_turn_duration_ms\s*=\s*completedAt\s*-\s*startedAt/,
  'assistant history should derive duration only from committed Runtime timestamps',
);

console.log('assistant turn timing persistence contract tests passed');

