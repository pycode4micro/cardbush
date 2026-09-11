import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import vm from 'node:vm';

const source = readFileSync('src/backend/runtimeSessionMessageProjection.ts', 'utf8');
const transpiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
const module = { exports: {} };
vm.runInNewContext(transpiled.outputText, { module, exports: module.exports, Set, Array, Object, String, Number, Date });
const createdAt = '2026-09-11T00:00:00Z';
const raw = [
  { role: 'user', content: 'Continue the analysis.' },
  { role: 'assistant', content: 'Maintenance prose', reasoningContent: 'Maintenance reasoning', toolCalls: [{ id: 'cp', name: 'checkpoint_context', argumentsText: '{}' }] },
  { role: 'tool', toolCallId: 'cp', content: 'Checkpoint applied.' },
  { role: 'assistant', content: 'The final analysis.', toolCalls: [] },
];
const turn = { turnId: 't', turnSequence: 1, createdAt, completedAt: createdAt, status: 'completed', reason: 'model_response_completed', usage: {},
  messages: raw.map((message, index) => ({ messageId: `m${index}`, turnId: 't', turnSequence: 1, messageIndex: index, createdAt, message,
    ...([1, 2].includes(index) ? { metadata: { runtimeMaintenance: 'context_compaction' } } : {}) })) };
const original = structuredClone(turn);
const visible = module.exports.projectRuntimeTurnMessages(turn, 's');
assert.deepEqual(Array.from(visible, message => message.content), ['Continue the analysis.', 'The final analysis.']);
assert.equal(visible[1].metadata.assistant_segment_index, 1);
assert.equal(visible[1].metadata.transcript_kind, 'assistant_final');
assert.deepEqual(turn, original, 'UI filtering cannot mutate model history');
console.log('Checkpoint exchange UI projection passed.');
