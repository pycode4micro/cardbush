import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeTrace } from './analyze-trace.mjs';

test('diagnosis distinguishes over-escaping from an exact or unrelated edit', () => {
  const source = 'const rx = /\\d+/;\r\n';
  const oldText = source.replaceAll('\\', '\\\\');
  const trace = fixture(source, oldText);
  const before = structuredClone(trace);
  const result = analyzeTrace(trace).failedEdits[0];
  assert.deepEqual(result.comparisons, [{ name: 'reducedPairedBackslashes', line: 1 }]);
  assert.equal(result.readProjectionArchived, false);
  assert.deepEqual(trace, before, 'A diagnostic comparison never transforms execution evidence.');
  assert.equal(analyzeTrace(fixture(source, source)).failedEdits[0].comparisons[0].name, 'exact');
  assert.deepEqual(analyzeTrace(fixture(source, 'unrelated')).failedEdits[0].comparisons, []);
});

test('diagnosis recognizes both native JSON and literal-text archive receipts', () => {
  for (const content of [
    JSON.stringify({ archived: true, preview: 'partial' }),
    JSON.stringify({ archived: true, format: 'text' }) + '\n\npartial',
  ]) {
    const trace = fixture('source', 'missing');
    trace.requests[0].messages[0].content = content;
    assert.equal(analyzeTrace(trace).failedEdits[0].readProjectionArchived, true);
  }
});

function fixture(source, oldText) {
  return {
    taskId: 'fixture', sourceSnapshots: { revision: source }, runtimeEvents: [],
    requests: [{
      request: 1, sourceRevisions: { 'src/file.ts': 'revision' },
      outputToolCalls: [null, { id: 'edit', name: 'edit_file' }],
      messages: [{ role: 'tool', toolCallId: 'read', content: JSON.stringify({ content: source }) }],
    }],
    toolExecutions: [
      { round: 1, toolCall: { id: 'read', name: 'read_file' }, result: { sha256: 'revision', content: source } },
      { round: 1, outcome: 'failed', error: { code: 'edit_old_text_not_found' }, toolCall: {
        id: 'edit', name: 'edit_file', argumentsText: JSON.stringify({ path: 'src/file.ts', old_text: oldText, new_text: '' }),
      } },
    ],
  };
}
