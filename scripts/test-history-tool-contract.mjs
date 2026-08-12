import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const modulePath = path.join(
  process.cwd(),
  'src',
  'backend',
  'historyToolAssociation.ts',
);
const source = fs.readFileSync(modulePath, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const loaded = { exports: {} };
vm.runInNewContext(transpiled.outputText, {
  module: loaded,
  exports: loaded.exports,
  Date,
  Map,
  Set,
  Number,
});
const { attachHistoryToolExecutions } = loaded.exports;

const messages = [
  { id: 'user-1', role: 'user', content: '检查项目', turnId: 'turn-1' },
  {
    id: 'assistant-1',
    messageId: 'assistant-1',
    role: 'assistant',
    content: '第一段',
    turnId: 'turn-1',
    metadata: { assistant_segment_index: 1 },
  },
  {
    id: 'assistant-2',
    messageId: 'assistant-2',
    role: 'assistant',
    content: '第二段',
    turnId: 'turn-1',
    metadata: { assistant_segment_index: 2 },
  },
];
const baseTool = {
  name: 'read_file',
  state: 'completed',
  summary: 'read',
  output: '',
  success: true,
  durationMs: 20,
  createdAt: '2026-08-12T08:00:00Z',
  contentOffset: 0,
  metadata: {},
};
const attached = attachHistoryToolExecutions(messages, [
  {
    ...baseTool,
    id: 'tool-exact',
    turnId: 'turn-1',
    assistantMessageId: 'assistant-1',
    assistantSegmentIndex: 1,
    sequence: 1,
  },
  {
    ...baseTool,
    id: 'tool-segment',
    turnId: 'turn-1',
    assistantSegmentIndex: 2,
    sequence: 2,
  },
]);

assert.equal(attached[1].toolExecutions[0].id, 'tool-exact');
assert.equal(attached[2].toolExecutions[0].id, 'tool-segment');

const apiSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'backend', 'api.ts'),
  'utf8',
);
assert.match(apiSource, /root\.tool_executions \?\? root\.toolExecutions/);
assert.match(apiSource, /messages:\s*attachHistoryToolExecutions\(parsedMessages, toolExecutions\)/);

const bubbleSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'chatMessages', 'MessageBubble.tsx'),
  'utf8',
);
assert.match(
  bubbleSource,
  /function assistantTurnCompletedAt[\s\S]*?message\.createdAt,[\s\S]*?\]\);/,
);

console.log('history tool association and timestamp contract tests passed');
