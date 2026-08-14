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
assert.match(apiSource, /options\.includeSuperseded !== false \? '\?include_superseded=true'/);

const bubbleSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'chatMessages', 'MessageBubble.tsx'),
  'utf8',
);
const chatHookSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'hooks', 'useCardbushChat.ts'),
  'utf8',
);
const stylesSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'styles', 'app.css'),
  'utf8',
);
assert.match(
  bubbleSource,
  /function assistantTurnCompletedAt[\s\S]*?message\.createdAt,[\s\S]*?\]\);/,
);
assert.match(
  bubbleSource,
  /function visibleTopLevelToolExecutions\([\s\S]*?return active \? executions : \[\];[\s\S]*?\n}/,
);
assert.doesNotMatch(
  bubbleSource,
  /if \(active \|\| loopHistory\.length === 0\)/,
);
assert.doesNotMatch(
  chatHookSource,
  /fetch(?:Session)?Messages\([^,\n)]+\)(?:\.catch|;|,)/,
  'Every history load must request superseded assistant process segments',
);
assert.match(
  chatHookSource,
  /includeSuperseded:\s*true/,
  'History loads must include intermediate assistant process segments',
);
assert.match(
  chatHookSource,
  /function shouldArchiveAssistantSegment[\s\S]*?message\.id === final\.id[\s\S]*?turnTranscriptKey\(message\) !== turnTranscriptKey\(final\)[\s\S]*?return true;/,
  'Every non-final assistant message in the same turn must be archived as processed history even without segment metadata',
);
assert.doesNotMatch(
  chatHookSource,
  /function shouldArchiveAssistantSegment[\s\S]{0,900}segment != null && finalSegment != null/,
  'Missing assistant segment metadata must not leak process messages into the final answer area',
);
assert.match(
  stylesSource,
  /\.app \.assistant-completed-summary:active\s*\{\s*transform:\s*none;/,
  'The full-width processed disclosure must not inherit the global button press scale',
);
assert.match(
  stylesSource,
  /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.assistant-thinking-process svg,[\s\S]*?\.processing-context-tab > svg[\s\S]*?animation-iteration-count:\s*infinite !important;/,
  'Functional execution spinners must remain visibly active when the OS reduces motion',
);

const disclosureSource = fs.readFileSync(
  path.join(
    process.cwd(),
    'src',
    'features',
    'tools',
    'toolExecutionDisclosure.ts',
  ),
  'utf8',
);
const disclosureTranspiled = ts.transpileModule(disclosureSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const disclosureModule = { exports: {} };
vm.runInNewContext(disclosureTranspiled.outputText, {
  module: disclosureModule,
  exports: disclosureModule.exports,
  Date,
  JSON,
  Object,
  Number,
});
const {
  defaultToolExecutionExpanded,
  readToolExecutionDisclosure,
  toolExecutionDisclosureId,
  toolExecutionDisclosureStorageKey,
  writeToolExecutionDisclosure,
} = disclosureModule.exports;
assert.equal(defaultToolExecutionExpanded(false, undefined), false);
assert.equal(defaultToolExecutionExpanded(true, undefined), false);
assert.equal(defaultToolExecutionExpanded(false, false), false);
const disclosureId = toolExecutionDisclosureId(
  {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    conversationId: 'session-1',
    turnId: 'turn-1',
  },
  [{ id: 'tool-1', contentOffset: 12 }],
);
const storageValues = new Map();
const storage = {
  getItem(key) {
    return storageValues.get(key) ?? null;
  },
  setItem(key, value) {
    storageValues.set(key, value);
  },
};
assert.equal(readToolExecutionDisclosure(storage, disclosureId), undefined);
writeToolExecutionDisclosure(storage, disclosureId, false);
assert.equal(readToolExecutionDisclosure(storage, disclosureId), false);
assert.ok(storageValues.has(toolExecutionDisclosureStorageKey));

const toolBlockSource = fs.readFileSync(
  path.join(
    process.cwd(),
    'src',
    'features',
    'tools',
    'ToolExecutionBlock.tsx',
  ),
  'utf8',
);
assert.match(toolBlockSource, /历史执行记录 · \$\{runSummary\}/);
assert.match(toolBlockSource, /writeToolExecutionDisclosure\(browserStorage\(\), disclosureId, next\)/);
assert.match(
  bubbleSource,
  /<AssistantCompletedDisclosure[\s\S]*?\{assistantBody\}[\s\S]*?<\/AssistantCompletedDisclosure>/,
);
assert.match(
  bubbleSource,
  /finalAssistantRound \? \([\s\S]*?\{finalProcessBody\}[\s\S]*?<\/AssistantCompletedDisclosure>[\s\S]*?\{finalAnswerBody\}/,
  'The final assistant answer must remain outside the processed disclosure',
);
assert.match(
  bubbleSource,
  /function AssistantCompletedDisclosure[\s\S]*?aria-expanded=\{expanded\}[\s\S]*?assistant-completed-content/,
  'Completed assistant content must be controlled by the processed disclosure',
);
assert.doesNotMatch(
  bubbleSource,
  /assistant-loop-history-summary[\s\S]{0,240}aria-expanded/,
  'Process messages inside the processed disclosure must not require a second expansion',
);
assert.match(
  bubbleSource,
  /function AssistantCompletedDisclosure[\s\S]*?preserveScrollPositionForToggle\(blockRef\.current,[\s\S]*?setExpanded\(opening\)/,
  'Opening and closing processed content must use the same stable anchor update',
);
assert.doesNotMatch(
  bubbleSource,
  /revealCompletedDisclosureAboveComposer|requestAnimationFrame\(\(\) => \{\s*window\.requestAnimationFrame/,
  'Processed content must not schedule a delayed second scroll after clicking',
);
const preserveScrollSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'preserveScrollPosition.ts'),
  'utf8',
);
assert.doesNotMatch(
  preserveScrollSource,
  /frame\s*<\s*12|requestAnimationFrame\(restore\)/,
  'Disclosure anchoring must not fight browser clamping across repeated frames',
);
assert.match(
  preserveScrollSource,
  /flushSync\(update\)[\s\S]*?scroller\.scrollTop = Math\.max[\s\S]*?requestAnimationFrame\(\(\) => \{[\s\S]*?delete scroller\.dataset\.cardbushPreserveScroll/,
  'Disclosure anchoring must perform one synchronous correction and only clean up later',
);

console.log('history tool association and timestamp contract tests passed');
