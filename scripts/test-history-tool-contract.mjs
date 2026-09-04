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

const contextCompactionPresentationPath = path.join(
  process.cwd(),
  'src',
  'backend',
  'contextCompactionPresentation.ts',
);
const contextCompactionPresentationSource = fs.readFileSync(
  contextCompactionPresentationPath,
  'utf8',
);
const contextCompactionPresentationTranspiled = ts.transpileModule(
  contextCompactionPresentationSource,
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
);
const contextCompactionPresentationModule = { exports: {} };
vm.runInNewContext(contextCompactionPresentationTranspiled.outputText, {
  module: contextCompactionPresentationModule,
  exports: contextCompactionPresentationModule.exports,
  Date,
  Map,
  Number,
});
const { contextCompactionPresentationExecutions } =
  contextCompactionPresentationModule.exports;
const compactionEnvelope = {
  protocol: 'bush.runtime_event.v1',
  requestId: 'request-compaction',
  sessionId: 'session-compaction',
  turnId: 'turn-compaction',
};
const contextCompactionExecutions = contextCompactionPresentationExecutions([
  {
    ...compactionEnvelope,
    eventId: 'event-compaction-start',
    sequence: 8,
    createdAt: '2026-09-03T00:00:00.000Z',
    kind: 'context_compaction_started',
    payload: {
      compactionId: 'context_compaction:turn-compaction:1',
      round: 4,
      attempt: 1,
      assistantMessageId: 'assistant-before-compaction',
      assistantContentOffset: 24,
      thresholdRatio: 0.95,
      triggerRatio: 0.961,
      estimatedInputTokens: 238_100,
      usableInputTokens: 247_808,
      measurement: 'provider',
      precedingTurnCount: 3,
      activeTurnIncluded: true,
    },
  },
  {
    ...compactionEnvelope,
    eventId: 'event-compaction-completed',
    sequence: 10,
    createdAt: '2026-09-03T00:00:02.000Z',
    kind: 'context_compaction_completed',
    payload: {
      compactionId: 'context_compaction:turn-compaction:1',
      round: 4,
      attempt: 1,
      assistantMessageId: 'assistant-before-compaction',
      assistantContentOffset: 24,
      summarizedTurnCount: 3,
      activeTurnCheckpointed: true,
    },
  },
]);
assert.equal(contextCompactionExecutions.length, 1);
assert.equal(contextCompactionExecutions[0].state, 'completed');
assert.equal(contextCompactionExecutions[0].durationMs, 2_000);
assert.equal(contextCompactionExecutions[0].sequence, 8);
assert.equal(contextCompactionExecutions[0].contentOffset, 24);
assert.equal(contextCompactionExecutions[0].contentOffsetExplicit, true);
assert.equal(
  contextCompactionExecutions[0].assistantMessageId,
  'assistant-before-compaction',
);
assert.equal(contextCompactionExecutions[0].metadata.summarizedTurnCount, 3);
assert.equal('summary' in contextCompactionExecutions[0].metadata, false);

const retriedContextCompaction = contextCompactionPresentationExecutions([
  {
    ...compactionEnvelope,
    eventId: 'event-compaction-start-retry',
    sequence: 10,
    createdAt: '2026-09-03T00:01:00.000Z',
    kind: 'context_compaction_started',
    payload: {
      compactionId: 'context_compaction:turn-compaction:2',
      round: 5,
      attempt: 1,
      thresholdRatio: 0.95,
      triggerRatio: 0.97,
      estimatedInputTokens: 240_000,
      usableInputTokens: 247_808,
      measurement: 'provider',
      precedingTurnCount: 0,
      activeTurnIncluded: true,
      activeThroughMessageId: 'tool-result-4',
    },
  },
  {
    ...compactionEnvelope,
    eventId: 'event-compaction-retry',
    sequence: 11,
    createdAt: '2026-09-03T00:01:01.000Z',
    kind: 'context_compaction_retrying',
    payload: {
      compactionId: 'context_compaction:turn-compaction:2',
      round: 6,
      attempt: 2,
      reason: 'checkpoint_not_atomic',
      message: 'checkpoint_context must be called alone.',
    },
  },
  {
    ...compactionEnvelope,
    eventId: 'event-compaction-completed-retry',
    sequence: 12,
    createdAt: '2026-09-03T00:01:02.000Z',
    kind: 'context_compaction_completed',
    payload: {
      compactionId: 'context_compaction:turn-compaction:2',
      round: 6,
      attempt: 2,
      summarizedTurnCount: 0,
      activeTurnCheckpointed: true,
      activeThroughMessageId: 'tool-result-4',
    },
  },
]);
assert.equal(retriedContextCompaction[0].state, 'completed');
assert.equal(
  'message' in retriedContextCompaction[0].metadata,
  false,
  'A successful retry must not retain the prior correction as a failure message.',
);

const transcriptPresentationPath = path.join(
  process.cwd(),
  'src',
  'features',
  'chatMessages',
  'assistantTranscriptPresentation.ts',
);
const transcriptPresentationSource = fs.readFileSync(
  transcriptPresentationPath,
  'utf8',
);
const transcriptPresentationTranspiled = ts.transpileModule(
  transcriptPresentationSource,
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  },
);
const transcriptPresentationModule = { exports: {} };
vm.runInNewContext(transcriptPresentationTranspiled.outputText, {
  module: transcriptPresentationModule,
  exports: transcriptPresentationModule.exports,
  Array,
  Map,
  Math,
  Number,
});
const { coalesceStoppedAssistantTranscript } = transcriptPresentationModule.exports;

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

const stoppedTranscript = [
  {
    id: 'stopped-segment-1',
    role: 'assistant',
    turnId: 'turn-stopped-presentation',
    content: '先查看截图：',
    toolExecutions: [{
      ...baseTool,
      id: 'stopped-tool-1',
      contentOffset: 6,
    }],
  },
  {
    id: 'stopped-segment-2',
    role: 'assistant',
    turnId: 'turn-stopped-presentation',
    content: '',
    toolExecutions: [{
      ...baseTool,
      id: 'stopped-tool-2',
      contentOffset: 0,
    }],
  },
  {
    id: 'stopped-segment-3',
    role: 'assistant',
    turnId: 'turn-stopped-presentation',
    content: '',
    toolExecutions: [{
      ...baseTool,
      id: 'stopped-tool-3',
      contentOffset: 0,
    }],
  },
  {
    id: 'stopped-segment-4',
    role: 'assistant',
    turnId: 'turn-stopped-presentation',
    content: '换一种方式：',
    toolExecutions: [{
      ...baseTool,
      id: 'stopped-tool-4',
      contentOffset: 6,
    }],
  },
  {
    id: 'stopped-segment-5',
    role: 'assistant',
    turnId: 'turn-stopped-presentation',
    content: '',
    toolExecutions: [{
      ...baseTool,
      id: 'stopped-tool-5',
      contentOffset: 0,
    }],
  },
];
const compactStoppedTranscript = coalesceStoppedAssistantTranscript(stoppedTranscript);
assert.equal(
  compactStoppedTranscript.length,
  2,
  'Stopping must retain the live narration groups instead of rendering one history row per tool-only round.',
);
assert.deepEqual(
  Array.from(compactStoppedTranscript[0].toolExecutions, (execution) => execution.id),
  ['stopped-tool-1', 'stopped-tool-2', 'stopped-tool-3'],
);
assert.deepEqual(
  Array.from(compactStoppedTranscript[1].toolExecutions, (execution) => execution.id),
  ['stopped-tool-4', 'stopped-tool-5'],
);
assert.equal(
  compactStoppedTranscript[0].toolExecutions[1].contentOffset,
  stoppedTranscript[0].content.length,
  'A folded tool-only round must stay after the narration that preceded it.',
);
assert.equal(
  stoppedTranscript[1].toolExecutions[0].contentOffset,
  0,
  'Stopped presentation compaction must not mutate the archived transcript projection.',
);
const isolatedStoppedTranscript = coalesceStoppedAssistantTranscript([
  stoppedTranscript[0],
  {
    ...stoppedTranscript[1],
    id: 'different-turn-tool-round',
    turnId: 'different-turn',
  },
]);
assert.equal(
  isolatedStoppedTranscript.length,
  2,
  'Presentation compaction must not cross Turn boundaries.',
);
const attachmentBoundaryTranscript = coalesceStoppedAssistantTranscript([
  stoppedTranscript[0],
  {
    ...stoppedTranscript[1],
    id: 'attachment-tool-round',
    attachments: [{ id: 'artifact', name: 'result.png', type: 'image' }],
  },
]);
assert.equal(
  attachmentBoundaryTranscript.length,
  2,
  'Presentation compaction must not hide an attachment-bearing round.',
);

const detailedWorkspaceExecution = {
  ...baseTool,
  id: 'tool-workspace-detail',
  name: 'edit_file',
  turnId: 'turn-workspace-detail',
  sequence: 3,
  metadata: {
    workspaceChanges: [{
      change_id: 'change-workspace-detail',
      path: 'src/detail.ts',
      status: 'modified',
      additions: 1,
      deletions: 1,
      metadata: { diff: '@@ -1,1 +1,1 @@\n-before\n+after' },
    }],
  },
};
const upgradedWorkspaceDetails = attachHistoryToolExecutions([
  { id: 'user-workspace-detail', role: 'user', content: '修改文件', turnId: 'turn-workspace-detail' },
  {
    id: 'assistant-workspace-detail',
    role: 'assistant',
    content: '正在修改。',
    turnId: 'turn-workspace-detail',
    metadata: { toolCalls: [{ id: 'tool-workspace-detail', name: 'edit_file' }] },
    toolExecutions: [{
      ...baseTool,
      id: 'tool-workspace-detail',
      name: 'edit_file',
      turnId: 'turn-workspace-detail',
      sequence: 3,
      metadata: {
        workspaceChangeDetailsDeferred: true,
        workspaceChanges: [{
          change_id: 'change-workspace-detail',
          path: 'src/detail.ts',
          status: 'modified',
          additions: 1,
          deletions: 1,
          detailAvailable: true,
        }],
      },
    }],
  },
  {
    id: 'assistant-workspace-final',
    role: 'assistant',
    content: '完成。',
    turnId: 'turn-workspace-detail',
  },
], [detailedWorkspaceExecution]);
assert.equal(
  upgradedWorkspaceDetails[1].toolExecutions.length,
  1,
  'Full Workspace Change details must replace the summary without creating a duplicate.',
);
assert.equal(
  upgradedWorkspaceDetails[1].toolExecutions[0].metadata.workspaceChanges[0].metadata.diff,
  '@@ -1,1 +1,1 @@\n-before\n+after',
  'A historical diff must stay on the assistant segment that issued the Tool call.',
);
assert.equal(
  upgradedWorkspaceDetails[2].toolExecutions,
  undefined,
  'Full details must not be detached onto the final assistant segment.',
);

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
assert.match(apiSource, /runtime\.client\.listTurnToolExecutions\(\s*\{/);
assert.match(
  apiSource,
  /runtime\.client\.listTurnContextCompactions\(\{[\s\S]*?contextCompactionPresentationExecutions\(compactionEvents\)/,
  'Session replay must restore durable context-maintenance rows.',
);
assert.match(apiSource, /messages:\s*attachHistoryToolExecutions\(messages, toolExecutions\)/);
assert.match(apiSource, /const superseded = new Set\(snapshot\.supersededMessageIds\)/);
assert.match(apiSource, /const excludedSuperseded = options\.includeSuperseded === false/);
assert.match(apiSource, /markRuntimeSupersededMessages\(projected, superseded\)/);
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
  /className="topbar-inspector-action icon-only"[\s\S]*?onClick=\{\(\) => onOpenReview\(\)\}/,
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
assert.match(
  chatHookSource,
  /function mergeWorkspaceChangeExecutions[\s\S]*?attachHistoryToolExecutions\(messages, workspaceChanges\)/,
  'Historical Workspace Change details must upgrade the original Tool-call segment.',
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
  bubbleSource,
  /<AssistantLoopHistoryBlock[\s\S]*?active=\{isActiveAssistantTurn\}/,
  'Archived execution segments must inherit the active Turn state so they cannot expose stale revert controls mid-loop',
);
assert.match(
  appSource,
  /const openChangeReview = useCallback\(\(filePath\?: string\) => \{[\s\S]*?onOpenChangeReview\(filePath\);[\s\S]*?onOpenChangeReview=\{openChangeReview\}/,
  'Chat messages must receive the guarded right-side review action',
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
  /case 'tool_returned':[\s\S]*?const terminalExecution = toolLifecycle\(event\);[\s\S]*?onToolExecution\?\.\(terminalExecution\);[\s\S]*?loadToolExecutionWithTimeout/,
  'A terminal Tool event must settle the UI before optional record enrichment.',
);
assert.match(
  runtimeChatSource,
  /function loadToolExecutionWithTimeout[\s\S]*?timeoutMs = 5_000/,
  'Tool record enrichment must have a bounded local timeout.',
);
assert.match(
  runtimeChatSource,
  /case 'context_compaction_started':[\s\S]*?case 'context_compaction_completed':[\s\S]*?contextCompactionPresentationExecution\(event, current\)[\s\S]*?onToolExecution\?\.\(execution\)/,
  'Context maintenance lifecycle must reach the live transcript through the shared execution-row boundary.',
);
assert.match(
  chatHookSource,
  /setPendingInteraction\(\(current\) => keepFirstPendingInteraction\(/,
  'Runtime permission events must preserve the first visible permission.',
);
assert.match(
  chatHookSource,
  /const nextInteraction = await fetchPendingInteraction\(sessionId\)/,
  'Answering one permission must immediately advance to the next pending request.',
);
assert.match(
  chatHookSource,
  /onDone: \(terminal\) => \{[\s\S]{0,120}?setPendingInteraction\(\(current\) =>\s*current\?\.sessionId === sessionId \? null : current,/,
  'A terminal Turn must remove its obsolete permission card.',
);
assert.equal(
  (chatHookSource.match(/onDone: \(terminal\) => \{\s*markSessionDone\(/g) ?? []).length,
  3,
  'Every Runtime stream path must end the sidebar processing marker from the canonical done callback.',
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
assert.match(
  toolBlockSource,
  /historyLabel = !active[\s\S]*?historyLabel && !running/,
  'Execution activity and historical labeling must remain independent presentation facts.',
);
assert.match(toolBlockSource, /正在压缩上下文/);
assert.match(toolBlockSource, /已压缩上下文/);
assert.match(
  bubbleSource,
  /!isContextCompactionPresentationExecution\(execution\)[\s\S]*?!previous\.executions\.some\(isContextCompactionPresentationExecution\)/,
  'A context-maintenance row must not merge into an adjacent ordinary Tool group.',
);
assert.match(
  toolBlockSource,
  /原始会话与工具记录保持不变/,
  'Context maintenance must explain that canonical history remains intact',
);
assert.match(
  bubbleSource,
  /coalesceStoppedAssistantTranscript\(transcript\)/,
  'A stopped Turn must rebuild the compact live-loop narration groups.',
);
assert.match(
  bubbleSource,
  /activeTranscriptMessages\.length > 1 \|\|[\s\S]*?freezeStoppedTranscript && activeTranscriptMessages\.length > 0/,
  'A stopped transcript that compacts to one group must still render that merged group.',
);
assert.match(
  bubbleSource,
  /<AssistantActiveTranscript[\s\S]*?function AssistantActiveTranscript[\s\S]*?historyLabel=\{false\}/,
  'The live-style transcript must not relabel stopped execution groups as history.',
);
assert.match(toolBlockSource, /writeToolExecutionDisclosure\(browserStorage\(\), disclosureId, next\)/);
assert.match(
  toolBlockSource,
  /onRevert=\{active\s*\? undefined\s*:\s*\(\) => onRevertChangeReport/,
  'Workspace-change cards must keep diff viewing available but omit revert while the Turn is active',
);
assert.ok(
  (toolBlockSource.match(/<ToolLogo /g) ?? []).length >= 2,
  'Tool and Runtime-maintenance rows must use the shared Tool logo renderer',
);
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
const {
  changeReportsFromMessages,
  groupChangeReportsByTurn,
  hydrateConversationChangeReport,
} = changeReportModule.exports;
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
const deferredWorkspaceReports = changeReportsFromMessages([
  { id: 'user-deferred', role: 'user', content: '继续修改', turnId: 'turn-deferred' },
  {
    id: 'assistant-deferred',
    role: 'assistant',
    content: '',
    turnId: 'turn-deferred',
    toolExecutions: [{
      id: 'runtime-deferred-target',
      name: 'edit_file',
      state: 'completed',
      summary: 'edit_file',
      output: '',
      success: true,
      durationMs: 10,
      createdAt: '2026-08-15T08:00:00Z',
      contentOffset: 0,
      metadata: {
        workspaceChangeDetailsDeferred: true,
        workspaceChanges: [{
          change_id: 'change-deferred-target',
          path: 'src/repeated.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          detailAvailable: true,
        }],
      },
    }],
  },
]);
assert.deepEqual(
  Array.from(deferredWorkspaceReports[0].executionIds),
  ['runtime-deferred-target'],
  'Review summaries must retain their exact Tool execution identity for lazy hydration.',
);
assert.equal(deferredWorkspaceReports[0].detailsDeferred, true);
assert.equal(deferredWorkspaceReports[0].files[0].lines.length, 0);
const hydratedDeferredReport = hydrateConversationChangeReport(
  deferredWorkspaceReports[0],
  [
    {
      id: 'runtime-deferred-other',
      name: 'edit_file',
      state: 'completed',
      summary: 'edit_file',
      output: '',
      success: true,
      durationMs: 10,
      createdAt: '2026-08-15T08:00:01Z',
      contentOffset: 0,
      metadata: {
        workspaceChanges: [{
          change_id: 'change-deferred-other',
          path: 'src/repeated.ts',
          status: 'modified',
          additions: 9,
          deletions: 9,
          metadata: { diff: '@@ -1,1 +1,1 @@\n-wrong\n+also-wrong' },
        }],
      },
    },
    {
      id: 'runtime-deferred-target',
      name: 'edit_file',
      state: 'completed',
      summary: 'edit_file',
      output: '',
      success: true,
      durationMs: 10,
      createdAt: '2026-08-15T08:00:00Z',
      contentOffset: 0,
      metadata: {
        workspaceChanges: [{
          change_id: 'change-deferred-target',
          path: 'src/repeated.ts',
          status: 'modified',
          additions: 1,
          deletions: 0,
          metadata: { diff: '@@ -1,1 +1,2 @@\n stable\n+target' },
        }],
      },
    },
  ],
);
assert.equal(hydratedDeferredReport.files[0].additions, 1);
assert.equal(hydratedDeferredReport.files[0].deletions, 0);
assert.match(hydratedDeferredReport.files[0].diff, /\+target/);
assert.doesNotMatch(
  hydratedDeferredReport.files[0].diff,
  /wrong/,
  'Repeated edits of one path must hydrate the selected execution, not a neighboring revision.',
);
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
assert.match(sidebarReviewSource, /groupChangeReportsByTurn\(resolvedReports\)/);
assert.match(sidebarReviewSource, /new Set\(reviewGroups\[0\] \? \[reviewGroups\[0\]\.id\]/);
assert.match(sidebarReviewSource, /className="change-review-group-toggle"[\s\S]*?aria-expanded=\{expanded\}/);
assert.match(sidebarReviewSource, /initialFilePath[\s\S]*?setSelectedKey\(item\.key\)/);
assert.match(
  sidebarReviewSource,
  /fetchRuntimeTurnToolExecutionDetails\([\s\S]*?hydrateConversationChangeReport\(candidate, details\)/,
  'Review must lazily hydrate a compact historical change even while another Turn is active.',
);
assert.match(
  sidebarReviewSource,
  /detailRetryRevision,[\s\S]*?selectedDetailRequestKey,[\s\S]*?selectedDetailStatus,[\s\S]*?selectedDetailTurnId,[\s\S]*?\]\);/,
  'Review detail loading must track its immutable Runtime request identity and current terminal state.',
);
assert.match(
  sidebarReviewSource,
  /detailRequestsInFlightRef\.current\.has\(selectedDetailRequestKey\)[\s\S]*?detailRequestsInFlightRef\.current\.delete\(selectedDetailRequestKey\)/,
  'StrictMode effect replay must share one in-flight review detail request.',
);
assert.doesNotMatch(
  sidebarReviewSource,
  /let cancelled = false;/,
  'A render-state change must not invalidate an already dispatched detail request.',
);
assert.match(
  sidebarReviewSource,
  /\.catch\(\(\) => \{[\s\S]*?for \(const key of turnDetailKeys\) next\.set\(key, 'failed'\)/,
  'Every report covered by a failed turn-detail request must leave loading state.',
);
assert.match(
  sidebarReviewSource,
  /selectedDetailStatus === 'failed'[\s\S]*?onClick=\{retrySelectedDetails\}/,
  'Review detail failures must remain visible and retryable.',
);
assert.match(
  sidebarReviewSource,
  /<FileTypeIcon path=\{selectedItem\.file\.path\} \/>/,
  'The selected review file must use the shared extension-aware file icon',
);
assert.match(
  sidebarReviewSource,
  /<FileTypeIcon path=\{item\.file\.path\} \/>/,
  'Review navigation entries must use the shared extension-aware file icon',
);
assert.equal(
  (sidebarReviewSource.match(/\{revertAvailable && \(/g) ?? []).length,
  2,
  'The review panel must hide both single-set and all-changes revert actions during an active Turn',
);
assert.equal(
  (appSource.match(/if \(chat\.processingConversationIds\.has\(conversationId\)\) \{/g) ?? []).length,
  2,
  'Both revert mutation paths must reject stale UI actions while that conversation is running',
);
assert.match(
  appSource,
  /revertAvailable=\{!chat\.processingConversationIds\.has\([\s\S]*?displayedReviewConversation\.id/,
  'The review panel must follow the target conversation lifecycle',
);
assert.match(
  appSource,
  /if \(changeReviewReports\.length === 0\) return null;[\s\S]*?id: changeReviewConversationId/,
  'review must remain mountable before a newly created conversation reaches the sidebar list',
);
assert.match(stylesSource, /\.change-review-group-files\s*\{/);

console.log('history tool association and timestamp contract tests passed');
