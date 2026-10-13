import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import * as protocol from '@cardbush/bush-protocol';
const { returnedToolError } = protocol;

const require = createRequire(import.meta.url), modules = new Map();
function load(file) {
  file = path.resolve(file);
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} }; modules.set(file, module);
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  new Function('require', 'module', 'exports', outputText)(name => name.startsWith('.')
    ? load(path.resolve(path.dirname(file), name + '.ts')) : name === '@cardbush/bush-protocol' ? protocol : require(name), module, module.exports);
  return module.exports;
}
const { runtimeHistoryToolExecution } = load('src/backend/runtimeHistoryToolExecution.ts');
const { toolLifecycle } = load('src/backend/runtimeTranscriptEvents.ts');
const { RuntimeTurnProjection } = load('src/runtime-client/RuntimeTurnProjection.ts');

test('live lifecycle, full history and deferred summaries agree on a returned MCP failure', () => {
  const name = 'mcp__browser__read', result = { isError: true, content: [{ type: 'text', text: 'Page unavailable' }] };
  const resultError = returnedToolError(name, result);
  const record = { protocol: protocol.BUSH_TOOL_EXECUTION_RECORD_PROTOCOL, requestId: 'r', sessionId: 's', turnId: 't',
    round: 1, ordinal: 0, recordedAt: '2026-10-13T00:00:00Z', toolCall: { protocol: 'bush.tool_call.v1', id: 'c', name, argumentsText: '{}' },
    outcome: 'returned', workspaceChanges: [], result };
  const { result: omitted, ...compact } = record;
  const event = { protocol: 'bush.runtime_event.v1', eventId: 'e', requestId: 'r', sessionId: 's', turnId: 't', sequence: 1,
    createdAt: record.recordedAt, kind: 'tool_returned', payload: { toolCallId: 'c', toolName: name, ordinal: 0, round: 1, resultError } };
  for (const execution of [toolLifecycle(event), runtimeHistoryToolExecution(record),
    runtimeHistoryToolExecution({ ...compact, protocol: protocol.BUSH_TOOL_EXECUTION_SUMMARY_PROTOCOL, resultAvailable: true, resultError })]) {
    assert.equal(execution.state, 'failed');
    assert.equal(execution.success, false);
    assert.equal(execution.metadata.error.code, 'mcp_tool_error');
  }
  assert.deepEqual(runtimeHistoryToolExecution(record).metadata.nativeResult, result);
  const projection = new RuntimeTurnProjection();
  projection.apply(event);
  assert.equal(projection.snapshot().tools[0].phase, 'failed');
});
