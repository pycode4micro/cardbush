import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const protocolPath = path.join(process.cwd(), 'src', 'backend', 'streamProtocol.ts');
const source = fs.readFileSync(protocolPath, 'utf8');
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const module = { exports: {} };
vm.runInNewContext(transpiled.outputText, { module, exports: module.exports });

const { assistantStreamChunkFromPayload, executionUpdateFromPayload } = module.exports;

assert.deepEqual(
  plain(assistantStreamChunkFromPayload({
    message_id: 'msg:assistant:session:turn:2',
    assistant_segment_index: 2,
    turn_id: 'turn-1',
    sequence: 41,
    request_id: 'request-1',
    event_id: 'event-41',
    created_at: '2026-08-12T08:00:00Z',
  })),
  {
    messageId: 'msg:assistant:session:turn:2',
    assistantSegmentIndex: 2,
    turnId: 'turn-1',
    sequence: 41,
    requestId: 'request-1',
    eventId: 'event-41',
    createdAt: '2026-08-12T08:00:00Z',
  },
);

assert.deepEqual(
  plain(executionUpdateFromPayload({
    kind: 'loop_transition',
    reason: 'turn_guidance_pending',
    pending_guidance_count: 1,
    guidance_round_index: 1,
    previous_assistant_segment_index: 1,
    next_assistant_segment_index: 2,
    next_round: 2,
    message_id: 'msg:assistant:session:turn:2',
    assistant_segment_index: 2,
    turn_id: 'turn-1',
  })),
  {
    kind: 'loop_transition',
    reason: 'turn_guidance_pending',
    pendingGuidanceCount: 1,
    guidanceRoundIndex: 1,
    previousAssistantSegmentIndex: 1,
    nextAssistantSegmentIndex: 2,
    nextRound: 2,
    messageId: 'msg:assistant:session:turn:2',
    assistantSegmentIndex: 2,
    turnId: 'turn-1',
  },
);

const apiSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'backend', 'api.ts'),
  'utf8',
);
assert.match(apiSource, /message_id:\s*request\.clientMessageId\.trim\(\)/);
assert.match(apiSource, /source:\s*'frontend'/);
assert.match(apiSource, /request\.onDelta\?\.\(delta, assistantStreamChunkFromPayload\(decoded\)\)/);
assert.match(apiSource, /request\.onFinalAssistantText\(text, assistantStreamChunkFromPayload\(decoded\)\)/);
assert.match(apiSource, /throw new BushServerHttpError\(response\.status, responseText\)/);

const hookSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'hooks', 'useCardbushChat.ts'),
  'utf8',
);
assert.match(hookSource, /optimisticGuidanceMessage\(/);
assert.match(hookSource, /caught\.code === 'turn_guidance_closed'/);
assert.match(hookSource, /caught\.code === 'turn_not_active'/);
assert.doesNotMatch(hookSource, /\|\|\s*isBushServerHttpError\(caught, 404\)/);
assert.match(hookSource, /createSegmentedAssistantStreamBuffers\(/);
assert.equal(
  (hookSource.match(/streamBuffer\.flushToolBoundary\(\);\s*streamBuffer\.reset\(/g) ?? []).length,
  2,
  'both send paths must drain token text before an assistant revision resets the buffer',
);

const bubbleSource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'chatMessages', 'MessageBubble.tsx'),
  'utf8',
);
assert.match(bubbleSource, /guidance-delivery-status/);
assert.match(bubbleSource, /发送中/);
assert.match(bubbleSource, /已排队/);
assert.match(bubbleSource, /发送失败/);
assert.match(bubbleSource, /guidance-retry-button/);
assert.match(bubbleSource, /onRetryGuidance\(message\)/);
assert.match(bubbleSource, /等待本轮完成后/);
assert.doesNotMatch(bubbleSource, /让当前回合停在这里/);
assert.doesNotMatch(
  bubbleSource,
  /finalProcessBody/,
  'Terminal assistant replies must clear loop details from the conversation surface',
);

const summarySource = fs.readFileSync(
  path.join(process.cwd(), 'src', 'features', 'chat', 'ConversationWorkSummary.tsx'),
  'utf8',
);
assert.match(summarySource, /data-testid="work-summary-history"/);
assert.match(summarySource, /<AssistantLoopHistoryBlock/);

const hookTranspiled = ts.transpileModule(hookSource, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const hookModule = { exports: {} };
vm.runInNewContext(hookTranspiled.outputText, {
  module: hookModule,
  exports: hookModule.exports,
  require: (specifier) => specifier.endsWith('/goalState')
    ? {
        applyGoalToolUpdate: () => null,
        goalToolUpdateFromExecution: () => null,
        isGoalSelfCheckMessage: (message) =>
          message?.role === 'user' &&
          message?.metadata?.runtime_user_label === 'goal_self_check',
      }
    : {},
  Date,
  Map,
  Set,
  window: { setTimeout, clearTimeout },
});
const {
  appendAssistantDelta,
  appendAssistantTextAfterToolBoundary,
  appendToolExecution,
  applyAssistantRevision,
  applyAssistantSegmentBoundary,
  createAssistantStreamDeltaBuffer,
  mergeFinalStreamMessages,
  markOptimisticChatRequestAccepted,
  markOptimisticChatRequestFailed,
  normalizeActiveTurnTranscriptForDisplay,
  normalizeChatMessagesForDisplay,
  optimisticGuidanceMessage,
  reconcileOptimisticGuidance,
} = hookModule.exports;

const optimisticChatState = {
  'chat-session': [
    {
      id: 'chat-user-local',
      role: 'user',
      content: '还在吗',
      status: 'pending',
      metadata: { message_delivery: 'pending' },
    },
    {
      id: 'chat-assistant-local',
      role: 'assistant',
      content: '',
      metadata: { optimistic_request_id: 'chat-user-local' },
    },
  ],
};
const acceptedChatState = markOptimisticChatRequestAccepted(
  optimisticChatState,
  'chat-session',
  'chat-user-local',
);
assert.equal(acceptedChatState['chat-session'][0].status, 'sent');
assert.equal(
  acceptedChatState['chat-session'][0].metadata.message_delivery,
  'accepted',
);
const failedChatState = markOptimisticChatRequestFailed(
  optimisticChatState,
  'chat-session',
  'chat-user-local',
  'chat-assistant-local',
);
assert.equal(failedChatState['chat-session'].length, 1);
assert.equal(failedChatState['chat-session'][0].status, 'failed');
assert.equal(
  failedChatState['chat-session'][0].metadata.message_delivery,
  'failed',
);

assert.deepEqual(
  plain(normalizeChatMessagesForDisplay([
    {
      id: 'runtime-goal-check',
      role: 'user',
      content: 'call update_goal',
      metadata: { runtime_user_label: 'goal_self_check' },
    },
    { id: 'assistant-final', role: 'assistant', content: 'done' },
  ])),
  [{ id: 'assistant-final', role: 'assistant', content: 'done' }],
  'runtime goal self-check prompts must not be rendered as real user messages',
);

const streamedAtBoundary = [];
const boundaryBuffer = createAssistantStreamDeltaBuffer((delta) => {
  streamedAtBoundary.push(delta);
});
boundaryBuffer.push('先说明我要读取配置。');
boundaryBuffer.flushToolBoundary();
assert.equal(streamedAtBoundary.join(''), '先说明我要读取配置。');
boundaryBuffer.push('工具完成后继续解释。');
assert.equal(streamedAtBoundary.join(''), '先说明我要读取配置。');
boundaryBuffer.flushToolBoundary();
assert.equal(
  streamedAtBoundary.join(''),
  '先说明我要读取配置。工具完成后继续解释。',
);
boundaryBuffer.dispose();

const sessionId = 'session-1';
const initialAssistantId = 'assistant-local';
const guidance = optimisticGuidanceMessage({
  clientMessageId: 'client-guidance-1',
  conversationId: sessionId,
  turnId: 'turn-1',
  content: '请补充风险说明',
  mode: 'append_context',
});
let state = {
  [sessionId]: [
    { id: 'user-1', role: 'user', content: '原始问题', turnId: 'turn-1' },
    {
      id: initialAssistantId,
      messageId: 'assistant-segment-1',
      assistantMessageId: 'assistant-segment-1',
      role: 'assistant',
      content: '第一轮',
      turnId: 'turn-1',
      metadata: { assistant_segment_index: 1 },
    },
    guidance,
  ],
};
state = appendAssistantDelta(state, sessionId, initialAssistantId, '第二轮', {
  messageId: 'assistant-segment-2',
  assistantSegmentIndex: 2,
  turnId: 'turn-1',
});
state = appendAssistantDelta(state, sessionId, initialAssistantId, '继续', {
  messageId: 'assistant-segment-2',
  assistantSegmentIndex: 2,
  turnId: 'turn-1',
});
assert.deepEqual(
  plain(state[sessionId].map((message) => [message.role, message.content])),
  [
    ['user', '原始问题'],
    ['assistant', '第一轮'],
    ['user', '请补充风险说明'],
    ['assistant', '第二轮继续'],
  ],
);
state = reconcileOptimisticGuidance(
  state,
  sessionId,
  'client-guidance-1',
  'client-guidance-1',
);
assert.equal(state[sessionId][2].status, 'queued');
assert.equal(state[sessionId][2].metadata.guidance_delivery, 'queued');

state = applyAssistantSegmentBoundary(
  state,
  sessionId,
  initialAssistantId,
  {
    kind: 'loop_transition',
    reason: 'turn_guidance_pending',
    turnId: 'turn-1',
    messageId: 'assistant-segment-2',
    assistantSegmentIndex: 2,
    previousAssistantSegmentIndex: 1,
    nextAssistantSegmentIndex: 2,
  },
);
assert.equal(state[sessionId][1].status, 'complete');
assert.equal(state[sessionId][1].metadata.segment_complete, true);
assert.equal(state[sessionId][3].messageId, 'assistant-segment-2');

state = appendToolExecution(state, sessionId, initialAssistantId, {
  id: 'tool-segment-2',
  name: 'read_file',
  state: 'completed',
  summary: 'read',
  output: 'ok',
  success: true,
  durationMs: 12,
  createdAt: '2026-08-12T08:00:01Z',
  contentOffset: 0,
  turnId: 'turn-1',
  assistantMessageId: 'assistant-segment-2',
  assistantSegmentIndex: 2,
  metadata: {},
});
assert.equal(state[sessionId][1].toolExecutions, undefined);
assert.equal(state[sessionId][3].toolExecutions[0].id, 'tool-segment-2');
assert.equal(
  state[sessionId][3].toolExecutions[0].contentOffset,
  state[sessionId][3].content.length,
);
assert.equal(state[sessionId][3].toolExecutions[0].contentOffsetExplicit, true);

state = appendAssistantDelta(
  state,
  sessionId,
  initialAssistantId,
  '工具完成后继续说明。',
  {
    messageId: 'assistant-segment-2',
    assistantSegmentIndex: 2,
    turnId: 'turn-1',
  },
);
assert.equal(
  state[sessionId][3].toolExecutions[0].contentOffset,
  '第二轮继续'.length,
);
assert.equal(
  state[sessionId][3].content,
  '第二轮继续\n\n工具完成后继续说明。',
);

assert.equal(
  appendAssistantTextAfterToolBoundary(
    {
      id: 'assistant-progress',
      role: 'assistant',
      content: '我先读取入口文件。',
      toolExecutions: [{ contentOffset: 9 }],
    },
    '现在继续读取样式文件。',
  ),
  '我先读取入口文件。\n\n现在继续读取样式文件。',
);

state = mergeFinalStreamMessages(
  state,
  sessionId,
  [
    {
      id: 'msg-user-1',
      messageId: 'msg-user-1',
      role: 'user',
      content: '原始问题',
      turnId: 'turn-1',
      messageIndex: 0,
    },
    {
      id: 'assistant-segment-1',
      messageId: 'assistant-segment-1',
      role: 'assistant',
      content: '第一轮',
      turnId: 'turn-1',
      messageIndex: 1,
      metadata: { assistant_segment_index: 1, transcript_kind: 'assistant_segment' },
    },
    {
      id: 'msg-guidance-1',
      messageId: 'msg-guidance-1',
      clientMessageId: 'client-guidance-1',
      role: 'user',
      content: '请补充风险说明',
      turnId: 'turn-1',
      messageIndex: 2,
      metadata: { turn_guidance: true, client_message_id: 'client-guidance-1' },
    },
    {
      id: 'assistant-segment-2',
      messageId: 'assistant-segment-2',
      role: 'assistant',
      content: '第二轮继续',
      turnId: 'turn-1',
      messageIndex: 3,
      metadata: { assistant_segment_index: 2, transcript_kind: 'assistant_final' },
    },
  ],
  {
    turnId: 'turn-1',
    temporaryMessageIds: [initialAssistantId],
    toolSourceMessageId: initialAssistantId,
  },
);
assert.deepEqual(
  plain(state[sessionId].map((message) => [message.role, message.content])),
  [
    ['user', '原始问题'],
    ['assistant', '第一轮'],
    ['user', '请补充风险说明'],
    ['assistant', '第二轮继续'],
  ],
);
assert.equal(state[sessionId][3].toolExecutions[0].id, 'tool-segment-2');

const loopSessionId = 'loop-history-session';
const loopTurnId = 'loop-history-turn';
const archivedLoopMessages = [1, 2, 3].map((index) => ({
  id: `persisted-loop-${index}`,
  messageId: `persisted-loop-${index}`,
  role: 'assistant',
  content: `历史 loop ${index}`,
  turnId: loopTurnId,
  status: 'superseded',
  loopIndex: index,
  sequence: index,
  metadata: {
    transcript_kind: 'assistant_loop',
    assistant_segment_index: index,
  },
}));
const temporaryLoopMessage = {
  id: 'temporary-loop-4',
  role: 'assistant',
  content: '当前 loop 4',
  turnId: loopTurnId,
  status: 'superseded',
  loopIndex: 4,
  sequence: 4,
  metadata: {
    transcript_kind: 'assistant_loop',
    assistant_segment_index: 4,
  },
  loopHistory: archivedLoopMessages,
};
const loopState = mergeFinalStreamMessages(
  { [loopSessionId]: [temporaryLoopMessage] },
  loopSessionId,
  [{
    id: 'persisted-final-loop-answer',
    messageId: 'persisted-final-loop-answer',
    role: 'assistant',
    content: '最终答案',
    turnId: loopTurnId,
    status: 'complete',
    metadata: {
      transcript_kind: 'assistant_final',
      assistant_segment_index: 5,
    },
  }],
  {
    turnId: loopTurnId,
    temporaryMessageIds: [temporaryLoopMessage.id],
  },
);

assert.match(hookSource, /onToolExecution: \(execution\) => \{\s*streamBuffer\.flushToolBoundary\(\);/);
assert.doesNotMatch(
  hookSource,
  /onToolExecution: \(execution\) => \{\s*void streamBuffer\.flushAllStreaming\(\)\.then/,
);
assert.deepEqual(
  plain(loopState[loopSessionId][0].loopHistory.map((message) => message.content)),
  ['历史 loop 1', '历史 loop 2', '历史 loop 3', '当前 loop 4'],
);

const reloadedLoopState = normalizeChatMessagesForDisplay([
  {
    id: 'persisted-user-reload',
    role: 'user',
    content: '历史重载',
    turnId: loopTurnId,
    messageIndex: 0,
  },
  ...[1, 2].map((index) => ({
    id: `persisted-segment-${index}`,
    messageId: `persisted-segment-${index}`,
    role: 'assistant',
    content: `历史 message ${index}`,
    turnId: loopTurnId,
    status: 'complete',
    messageIndex: index,
    metadata: {
      transcript_kind: 'assistant_segment',
      history_visibility: 'ephemeral',
      assistant_segment_index: index,
    },
  })),
  {
    id: 'persisted-final-reload',
    messageId: 'persisted-final-reload',
    role: 'assistant',
    content: '历史最终回答',
    turnId: loopTurnId,
    status: 'complete',
    messageIndex: 3,
    metadata: {
      transcript_kind: 'assistant_final',
      assistant_segment_index: 3,
    },
  },
]);
assert.deepEqual(
  plain(reloadedLoopState.map((message) => [message.role, message.content])),
  [['user', '历史重载'], ['assistant', '历史最终回答']],
);
assert.deepEqual(
  plain(reloadedLoopState[1].loopHistory.map((message) => message.content)),
  ['历史 message 1', '历史 message 2'],
);

const displayed = normalizeChatMessagesForDisplay(state[sessionId]);
assert.deepEqual(
  plain(displayed.map((message) => [message.role, message.content])),
  [
    ['user', '原始问题'],
    ['user', '请补充风险说明'],
    ['assistant', '第二轮继续'],
  ],
);
assert.equal(displayed[2].loopHistory[0].content, '第一轮');
assert.equal(displayed[2].loopHistory[0].metadata.assistant_segment_index, 1);

let revisionState = {
  'revision-session': [{
    id: 'revision-assistant',
    role: 'assistant',
    content: '先读取入口文件。',
    turnId: 'revision-turn',
    status: 'streaming',
    toolExecutions: [{
      id: 'revision-tool-1',
      name: 'read_file',
      state: 'completed',
      summary: '入口文件读取完成',
      output: 'ok',
      success: true,
      durationMs: 4,
      createdAt: '2026-08-14T00:00:01Z',
      contentOffset: '先读取入口文件。'.length,
      metadata: {},
    }],
  }],
};
revisionState = applyAssistantRevision(
  revisionState,
  'revision-session',
  'revision-assistant',
  {
    action: 'replace',
    reason: 'tool_preamble',
    turnId: 'revision-turn',
    content: '继续检查样式文件。',
  },
);
revisionState = appendToolExecution(
  revisionState,
  'revision-session',
  'revision-assistant',
  {
    id: 'revision-tool-2',
    name: 'read_file',
    state: 'completed',
    summary: '样式文件读取完成',
    output: 'ok',
    success: true,
    durationMs: 5,
    createdAt: '2026-08-14T00:00:02Z',
    contentOffset: 0,
    metadata: {},
  },
);
revisionState = applyAssistantRevision(
  revisionState,
  'revision-session',
  'revision-assistant',
  {
    action: 'replace',
    reason: 'tool_preamble',
    turnId: 'revision-turn',
    content: '最后执行验证。',
  },
);
assert.deepEqual(
  plain(revisionState['revision-session'][0].loopHistory.map((message) => message.content)),
  ['先读取入口文件。', '继续检查样式文件。'],
  'every pre-tool assistant segment must remain visible until the terminal turn',
);
assert.equal(revisionState['revision-session'][0].loopHistory[0].toolExecutions[0].id, 'revision-tool-1');
assert.equal(revisionState['revision-session'][0].loopHistory[1].toolExecutions[0].id, 'revision-tool-2');
assert.equal(revisionState['revision-session'][0].metadata.transcript_kind, 'assistant_segment');

const beforeEmptyPreamble = revisionState;
revisionState = applyAssistantRevision(
  revisionState,
  'revision-session',
  'revision-assistant',
  {
    action: 'replace',
    reason: 'tool_preamble',
    turnId: 'revision-turn',
    content: '',
  },
);
assert.equal(
  revisionState,
  beforeEmptyPreamble,
  'an empty bookkeeping preamble must not erase visible assistant text',
);

const activeProjection = normalizeActiveTurnTranscriptForDisplay([
  {
    id: 'active-segment-1',
    role: 'assistant',
    content: '第一段惯性回复',
    turnId: 'active-turn',
    taskPlan: {
      protocol: 'bush.task_plan.v1',
      planId: 'active-plan',
      sessionId: 'active-session',
      nodes: [{ step: '执行第一步', status: 'in_progress' }],
      explanation: '',
      active: true,
    },
  },
  {
    id: 'active-segment-2',
    role: 'assistant',
    content: '第二段惯性回复',
    turnId: 'active-turn',
  },
], 'active-turn');
assert.equal(activeProjection.length, 1);
assert.equal(activeProjection[0].content, '第二段惯性回复');
assert.deepEqual(
  plain(activeProjection[0].loopHistory.map((message) => message.content)),
  ['第一段惯性回复'],
);
assert.equal(activeProjection[0].taskPlan.planId, 'active-plan');

console.log('turn guidance contract tests passed');

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
