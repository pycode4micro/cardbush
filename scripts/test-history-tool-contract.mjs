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

const toolCallAttached = attachHistoryToolExecutions([
  { id: 'user-tool-call', role: 'user', content: '读取文件', turnId: 'turn-tool-call' },
  {
    id: 'assistant-tool-call',
    role: 'assistant',
    content: '先读取文件。',
    turnId: 'turn-tool-call',
    metadata: { toolCalls: [{ id: 'tool-by-call-id', name: 'read_file' }] },
  },
  {
    id: 'assistant-tool-final',
    role: 'assistant',
    content: '读取完成。',
    turnId: 'turn-tool-call',
  },
], [{
  ...baseTool,
  id: 'tool-by-call-id',
  turnId: 'turn-tool-call',
  sequence: 1,
}]);
assert.equal(
  toolCallAttached[1].toolExecutions[0].id,
  'tool-by-call-id',
  'Persisted tools must reattach to the assistant message that issued the tool call.',
);
assert.equal(toolCallAttached[2].toolExecutions, undefined);

const historyProjectionPath = path.join(
  process.cwd(),
  'src',
  'features',
  'chat',
  'workSummaryHistory.ts',
);
const historyProjectionSource = fs.readFileSync(historyProjectionPath, 'utf8');
const historyProjectionTranspiled = ts.transpileModule(historyProjectionSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const historyProjectionModule = { exports: {} };
vm.runInNewContext(historyProjectionTranspiled.outputText, {
  module: historyProjectionModule,
  exports: historyProjectionModule.exports,
  Date,
  Intl,
  Map,
  Set,
  Number,
});
const { groupWorkSummaryHistoryByTurn, historyTurnLabel } = historyProjectionModule.exports;
const persistedGroups = groupWorkSummaryHistoryByTurn(toolCallAttached);
assert.equal(persistedGroups.length, 1, 'Raw persisted assistant rounds must be replayable.');
assert.equal(persistedGroups[0].turnId, 'turn-tool-call');
assert.equal(persistedGroups[0].history.length, 1);
assert.equal(persistedGroups[0].history[0].id, 'assistant-tool-call');
assert.equal(persistedGroups[0].toolCount, 1);
assert.equal(persistedGroups[0].prompt, '读取文件');
assert.equal(
  historyTurnLabel(persistedGroups[0], 'zh'),
  '读取文件',
  'History navigation must use the user instruction instead of a numeric Turn label.',
);

const collapsedGroups = groupWorkSummaryHistoryByTurn([
  { id: 'user-collapsed', role: 'user', content: '检查项目', turnId: 'turn-collapsed' },
  {
    id: 'assistant-collapsed-final',
    role: 'assistant',
    content: '完成。',
    turnId: 'turn-collapsed',
    loopHistory: [{
      id: 'assistant-collapsed-process',
      role: 'assistant',
      content: '正在检查。',
      turnId: 'turn-collapsed',
    }],
  },
]);
assert.equal(collapsedGroups.length, 1, 'Live collapsed loop history must remain supported.');
assert.equal(collapsedGroups[0].history.length, 1);
assert.equal(collapsedGroups[0].history[0].id, 'assistant-collapsed-process');

const guidedGroups = groupWorkSummaryHistoryByTurn([
  { id: 'user-original', role: 'user', content: '检查并修复项目', turnId: 'turn-guided' },
  {
    id: 'user-guidance',
    role: 'user',
    content: '再检查测试',
    turnId: 'turn-guided',
    metadata: { name: 'turn_guidance' },
  },
  {
    id: 'assistant-guided-process',
    role: 'assistant',
    content: '正在处理。',
    turnId: 'turn-guided',
  },
  {
    id: 'assistant-guided-final',
    role: 'assistant',
    content: '完成。',
    turnId: 'turn-guided',
  },
]);
assert.equal(guidedGroups[0].prompt, '检查并修复项目');

const apiSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'backend', 'api.ts'),
  'utf8',
);
assert.match(apiSource, /runtime\.client\.listTurnToolExecutions\(\{/);
assert.match(apiSource, /messages:\s*attachHistoryToolExecutions\(messages, toolExecutions\)/);
assert.match(apiSource, /options\.includeSuperseded === false \? snapshot\.supersededMessageIds : \[\]/);
assert.match(
  apiSource,
  /\{ status: turn\.status \}/,
  'Persisted Runtime Turn status must be projected without a compatibility alias.',
);
assert.doesNotMatch(apiSource, /assistantDisplayTurnStatus/);
assert.match(
  apiSource,
  /\.filter\(\(message\) => !isInternalRuntimeMessage\(message\)\)/,
  'Internal model-only messages must not enter the visible conversation transcript.',
);

const visibilitySource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'backend', 'runtimeMessageVisibility.ts'),
  'utf8',
);
const visibilityTranspiled = ts.transpileModule(visibilitySource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const visibilityModule = { exports: {} };
vm.runInNewContext(visibilityTranspiled.outputText, {
  module: visibilityModule,
  exports: visibilityModule.exports,
  Set,
  Boolean,
});
const { isInternalRuntimeMessage } = visibilityModule.exports;
const sessionMessage = (message) => ({
  messageId: 'message',
  turnId: 'turn',
  turnSequence: 1,
  messageIndex: 0,
  createdAt: '2026-08-30T00:00:00.000Z',
  message,
});
assert.equal(
  isInternalRuntimeMessage(sessionMessage({
    role: 'user',
    content: 'model-only image follow-up',
    name: 'tool_image_observation',
    visibility: 'internal',
  })),
  true,
);
assert.equal(
  isInternalRuntimeMessage(sessionMessage({
    role: 'user',
    content: 'legacy model-only image follow-up',
    name: 'tool_image_observation',
  })),
  true,
  'Already persisted image follow-ups must also be hidden.',
);
assert.equal(
  isInternalRuntimeMessage(sessionMessage({
    role: 'user',
    content: 'real user guidance',
    name: 'turn_guidance',
  })),
  false,
  'User-authored turn guidance must remain visible.',
);

const bubbleSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'chatMessages', 'MessageBubble.tsx'),
  'utf8',
);
const appSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'App.tsx'),
  'utf8',
);
assert.match(
  appSource,
  /changeReportsFromMessages\(\s*normalizeChatMessagesForDisplay\(messages\)\s*,?\s*\)/m,
  'Review availability must use the normalized transcript shown in the conversation.',
);
assert.match(
  appSource,
  /className="topbar-inspector-action"[\s\S]*?onClick=\{\(\) => onOpenReview\(\)\}/,
  'The top-bar review button must not forward its React click event as a file path.',
);
assert.match(
  appSource,
  /typeof filePath === 'string' \? filePath\.trim\(\) : ''/,
  'The review opener must reject non-string event payloads at its boundary.',
);
const chatHookSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'hooks', 'useCardbushChat.ts'),
  'utf8',
);
const stylesSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'styles', 'app.css'),
  'utf8',
);
assert.match(bubbleSource, /AssistantChangedFilesSummary/);
assert.match(bubbleSource, /completedAssistantChangeReport/);
assert.match(
  bubbleSource,
  /className="assistant-changed-file"[\s\S]*?onOpenReview\(file\.path\)/,
  'Changed file rows must open the selected file in the diff review',
);
assert.match(
  bubbleSource,
  /className="assistant-changed-files-more"[\s\S]*?aria-expanded=\{expanded\}/,
  'Changed file overflow must expand progressively',
);
assert.match(
  bubbleSource,
  /className="assistant-changed-files-review"[\s\S]*?onClick=\{\(\) => onOpenReview\(\)\}/,
  'The final change summary must expose the conversation review panel',
);
assert.match(
  bubbleSource,
  /className="assistant-changed-files-revert"[\s\S]*?await onRevert\(\)/,
  'The final change summary must expose the same safe revert action as review',
);
assert.match(
  appSource,
  /onOpenChangeReview=\{onOpenChangeReview\}/,
  'Chat messages must receive the existing right-side review action',
);
assert.match(
  bubbleSource,
  /function resolveChangedFilePath[\s\S]*?isAbsoluteLocalPath\(path\)/,
  'Relative change paths must resolve against the active workspace',
);
assert.match(
  stylesSource,
  /\.assistant-changed-files-summary[\s\S]*?border-radius:\s*12px/,
);
assert.match(
  stylesSource,
  /\.assistant-changed-files-summary\s*\{[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*none;/,
  'The final change summary must align to the full conversation track',
);
assert.match(
  bubbleSource,
  /function assistantTurnCompletedAt[\s\S]*?message\.createdAt,[\s\S]*?\]\);/,
);
assert.match(
  bubbleSource,
  /function visibleTopLevelToolExecutions\([\s\S]*?return visible \? executions : \[\];[\s\S]*?\n}/,
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
  /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.assistant-thinking-model\.fallback svg,[\s\S]*?\.composer-runtime-screen\.running \.runtime-screen-line\.processing > svg[\s\S]*?animation-iteration-count:\s*infinite !important;/,
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
const toolStateSource = fs.readFileSync(
  path.join(
    process.cwd(),
    'src',
    'features',
    'tools',
    'toolExecutionState.ts',
  ),
  'utf8',
);
const toolStateTranspiled = ts.transpileModule(toolStateSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const toolStateModule = { exports: {} };
vm.runInNewContext(toolStateTranspiled.outputText, {
  module: toolStateModule,
  exports: toolStateModule.exports,
});
const {
  activeToolStatusLabel,
  isToolCancelled,
  isToolRunning,
  runningToolLabel,
} = toolStateModule.exports;
const awaitingPermissionTool = {
  ...baseTool,
  id: 'tool-awaiting-permission',
  state: 'awaiting_permission',
  success: false,
};
assert.equal(isToolRunning(awaitingPermissionTool), true);
assert.equal(activeToolStatusLabel(awaitingPermissionTool, 'zh'), '等待授权');
assert.equal(
  runningToolLabel([awaitingPermissionTool], 'zh'),
  'read_file 等待授权',
);
assert.equal(
  activeToolStatusLabel({ ...awaitingPermissionTool, state: 'queued' }, 'zh'),
  '排队中',
);
assert.equal(
  isToolCancelled({ ...awaitingPermissionTool, state: 'cancelled' }),
  true,
);

const pendingQueueSource = fs.readFileSync(
  path.join(
    process.cwd(),
    'src',
    'features',
    'interactions',
    'pendingInteractionQueue.ts',
  ),
  'utf8',
);
const pendingQueueTranspiled = ts.transpileModule(pendingQueueSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const pendingQueueModule = { exports: {} };
vm.runInNewContext(pendingQueueTranspiled.outputText, {
  module: pendingQueueModule,
  exports: pendingQueueModule.exports,
});
const { keepFirstPendingInteraction } = pendingQueueModule.exports;
const firstPermission = { id: 'permission-a', sessionId: 'session-a', raw: {} };
const secondPermission = { id: 'permission-b', sessionId: 'session-a', raw: {} };
assert.equal(
  keepFirstPendingInteraction(null, firstPermission, 'session-a').id,
  'permission-a',
);
assert.equal(
  keepFirstPendingInteraction(firstPermission, secondPermission, 'session-a').id,
  'permission-a',
  'Parallel permissions must not replace the request already visible to the user.',
);
assert.equal(
  keepFirstPendingInteraction(
    firstPermission,
    { id: 'permission-background', sessionId: 'session-b', raw: {} },
    'session-a',
  ).id,
  'permission-a',
  'A background session permission must not replace the active session dialog.',
);

const runtimeChatSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'backend', 'runtimeChat.ts'),
  'utf8',
);
assert.match(
  runtimeChatSource,
  /case 'permission_requested':[\s\S]*?state: 'awaiting_permission'/,
  'A permission request must project an explicit waiting state for its tool.',
);
assert.match(
  runtimeChatSource,
  /case 'tool_completed':[\s\S]*?const terminalExecution = toolLifecycle\(event\);[\s\S]*?onToolExecution\?\.\(terminalExecution\);[\s\S]*?loadToolExecutionWithTimeout/,
  'A terminal Tool event must settle the UI before optional record enrichment.',
);
assert.match(
  runtimeChatSource,
  /function loadToolExecutionWithTimeout[\s\S]*?timeoutMs = 5_000/,
  'Tool record enrichment must have a bounded local timeout.',
);
assert.match(
  chatHookSource,
  /setPendingInteraction\(\(current\) => keepFirstPendingInteraction\(/,
  'Runtime interaction events must preserve the first visible permission.',
);
assert.match(
  chatHookSource,
  /const nextInteraction = await fetchPendingInteraction\(sessionId\)/,
  'Answering one permission must immediately advance to the next pending request.',
);
assert.match(
  chatHookSource,
  /onDone: \(terminal\) => \{\s*setPendingInteraction\(\(current\) =>\s*current\?\.sessionId === sessionId \? null : current,/,
  'A terminal Turn must remove its obsolete permission card.',
);
const toolLogoSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'tools', 'ToolLogo.tsx'),
  'utf8',
);
const styleSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'styles', 'app.css'),
  'utf8',
);
assert.match(toolBlockSource, /历史执行记录 · \$\{runSummary\}/);
assert.match(toolBlockSource, /writeToolExecutionDisclosure\(browserStorage\(\), disclosureId, next\)/);
assert.equal((toolBlockSource.match(/<ToolLogo /g) ?? []).length, 2);
assert.match(toolLogoSource, /normalized\.startsWith\('mcp__'\)/);
assert.match(toolLogoSource, /read_file: \{ icon: FileText/);
assert.match(toolLogoSource, /subagent: \{ icon: GitFork/);
assert.match(
  styleSource,
  /\.assistant-thinking-model \{[\s\S]*?background: transparent;[\s\S]*?border: 0;[\s\S]*?box-shadow: none;/,
);
assert.match(
  styleSource,
  /\.tool-logo \{[\s\S]*?background: transparent;[\s\S]*?border: 0;/,
);
assert.match(
  bubbleSource,
  /<AssistantCompletedDisclosure[\s\S]*?\{assistantBody\}[\s\S]*?<\/AssistantCompletedDisclosure>/,
);
assert.match(
  bubbleSource,
  /guidanceBoundaryRound \? \([\s\S]*?assistantBody[\s\S]*?\) : finalAssistantRound/,
  'Turn-guidance interruption segments must stay visible instead of entering the processed disclosure',
);
assert.match(
  bubbleSource,
  /isActiveAssistantTurn \|\|[\s\S]*?guidanceBoundaryRound \|\|[\s\S]*?preserveStoppedExecutionRecord/,
  'Visible guidance segments must retain their inline tool execution order',
);
assert.match(
  bubbleSource,
  /finalAssistantRound \? \([\s\S]*?<AssistantRunHeader[\s\S]*?\{finalAnswerBody\}/,
  'The terminal turn must keep the processed header and final answer in chat',
);
assert.match(bubbleSource, /status === 'completed'/);
assert.doesNotMatch(bubbleSource, /status === 'complete'/);
assert.match(chatHookSource, /function isAssistantFinalTranscript[\s\S]*?status === 'completed'/);
const finalTranscriptStart = chatHookSource.indexOf('function isAssistantFinalTranscript');
const finalTranscriptEnd = chatHookSource.indexOf('\nfunction ', finalTranscriptStart + 1);
assert.doesNotMatch(
  chatHookSource.slice(finalTranscriptStart, finalTranscriptEnd),
  /status === 'complete'/,
);
assert.doesNotMatch(
  bubbleSource,
  /finalProcessBody/,
  'Loop details must move to the work summary after the terminal turn',
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

const changeReportSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'tools', 'toolChangeReports.ts'),
  'utf8',
);
const changeReportTranspiled = ts.transpileModule(changeReportSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const changeReportModule = { exports: {} };
vm.runInNewContext(changeReportTranspiled.outputText, {
  module: changeReportModule,
  exports: changeReportModule.exports,
  require: () => ({
    displayToolName: (value) => value,
    isToolRunning: () => false,
  }),
  Map,
  Set,
  Number,
});
const { changeReportsFromMessages, groupChangeReportsByTurn } = changeReportModule.exports;
const changeExecution = (id, pathValue) => ({
  id,
  name: 'apply_patch',
  state: 'completed',
  summary: '',
  output: '',
  success: true,
  durationMs: 10,
  createdAt: '2026-08-15T08:00:00Z',
  contentOffset: 0,
  metadata: {
    kind: 'file_change',
    files: [{ path: pathValue, additions: 1, deletions: 0, diff: '+changed' }],
  },
});
const reviewReports = changeReportsFromMessages([
  { id: 'user-a', role: 'user', content: '第一轮', turnId: 'turn-a' },
  {
    id: 'assistant-a',
    role: 'assistant',
    content: '',
    turnId: 'turn-a',
    toolExecutions: [changeExecution('change-a', 'src/style.css')],
  },
  { id: 'user-b', role: 'user', content: '第二轮', turnId: 'turn-b' },
  {
    id: 'assistant-b1',
    role: 'assistant',
    content: '',
    turnId: 'turn-b',
    toolExecutions: [changeExecution('change-b1', 'src/style.css')],
  },
  {
    id: 'assistant-b2',
    role: 'assistant',
    content: '',
    turnId: 'turn-b',
    toolExecutions: [changeExecution('change-b2', 'SRC\\STYLE.CSS')],
  },
]);
assert.equal(reviewReports[0].userPrompt, '第一轮');
assert.equal(reviewReports[1].userPrompt, '第二轮');
const runtimeWorkspaceReports = changeReportsFromMessages([
  { id: 'user-runtime', role: 'user', content: '修改 Runtime 文件', turnId: 'turn-runtime' },
  {
    id: 'assistant-runtime',
    role: 'assistant',
    content: '',
    turnId: 'turn-runtime',
    toolExecutions: [{
      id: 'runtime-change',
      name: 'edit_file',
      state: 'completed',
      summary: 'edit_file',
      output: '{"path":"src/runtime.ts"}',
      success: true,
      durationMs: 10,
      createdAt: '2026-08-15T08:00:00Z',
      contentOffset: 0,
      metadata: {
        workspaceChanges: [{
          change_id: 'change-runtime',
          path: 'src/runtime.ts',
          status: 'modified',
          additions: 1,
          deletions: 1,
          metadata: { diff: '@@ -1,1 +1,1 @@\n-before\n+after' },
        }],
      },
    }],
  },
]);
assert.equal(runtimeWorkspaceReports.length, 1, 'Native Runtime workspace_changes must reach review');
assert.equal(runtimeWorkspaceReports[0].files[0].path, 'src/runtime.ts');
assert.equal(runtimeWorkspaceReports[0].additions, 1);
assert.equal(runtimeWorkspaceReports[0].deletions, 1);
const reviewGroups = groupChangeReportsByTurn(reviewReports);
assert.equal(reviewGroups.length, 2, 'Change history must group reports by conversation turn');
assert.equal(reviewGroups[0].id, 'turn:turn-b', 'The latest turn must appear first');
assert.equal(reviewGroups[0].items.length, 2, 'Reports from the same turn stay inside one group');
assert.equal(reviewGroups[0].uniqueFileCount, 1, 'Path casing and separators must not inflate file totals');

const nestedReviewReports = changeReportsFromMessages([
  { id: 'user-nested', role: 'user', content: '嵌套修改', turnId: 'turn-nested' },
  {
    id: 'assistant-final',
    role: 'assistant',
    content: '完成',
    turnId: 'turn-nested',
    loopHistory: [
      {
        id: 'assistant-process',
        role: 'assistant',
        content: '正在修改',
        turnId: 'turn-nested',
        toolExecutions: [changeExecution('change-nested', 'src/nested.css')],
      },
    ],
  },
]);
assert.equal(nestedReviewReports.length, 1, 'Loop-history changes must reach conversation review');
assert.equal(nestedReviewReports[0].files[0].path, 'src/nested.css');

const sidebarReviewSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'sidebar', 'ChatSidebar.tsx'),
  'utf8',
);
assert.match(sidebarReviewSource, /groupChangeReportsByTurn\(reports\)/);
assert.match(sidebarReviewSource, /new Set\(reviewGroups\[0\] \? \[reviewGroups\[0\]\.id\]/);
assert.match(sidebarReviewSource, /className="change-review-group-toggle"[\s\S]*?aria-expanded=\{expanded\}/);
assert.match(sidebarReviewSource, /initialFilePath[\s\S]*?setSelectedKey\(item\.key\)/);
assert.match(
  appSource,
  /if \(changeReviewReports\.length === 0\) return null;[\s\S]*?id: changeReviewConversationId/,
  'review must remain mountable before a newly created conversation reaches the sidebar list',
);
assert.match(stylesSource, /\.change-review-group-files\s*\{/);

console.log('history tool association and timestamp contract tests passed');
