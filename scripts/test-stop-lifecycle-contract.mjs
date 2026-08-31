import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const types = read('src', 'types.ts');
const api = read('src', 'backend', 'api.ts');
const runtimeChat = read('src', 'backend', 'runtimeChat.ts');
const runtimeBridge = read('src', 'runtime-client', 'RuntimeInteractionBridge.ts');
const hook = read('src', 'hooks', 'useCardbushChat.ts');
const app = read('src', 'App.tsx');
const composer = read('src', 'features', 'composer', 'Composer.tsx');
const bubble = read('src', 'features', 'chatMessages', 'MessageBubble.tsx');

assert.match(types, /export interface TurnTerminalSnapshot/);
assert.match(api, /export interface StopTurnResult/);
assert.match(api, /const receipt = await stopActiveRuntimeTurn\(normalized\)/);
assert.match(api, /accepted: receipt\.accepted/);
assert.match(runtimeBridge, /export async function stopActiveRuntimeTurn/);
assert.match(runtimeBridge, /return active\.stop\(\)/);
assert.match(api, /onDone\?: \(terminal: TurnTerminalSnapshot\) => void/);
assert.match(runtimeChat, /request\.onDone\?\.\(terminalSnapshot\(terminal\)\)/);
assert.match(runtimeChat, /case 'turn_terminal'/);

const cancelStart = hook.indexOf('const cancelSending = useCallback');
const cancelEnd = hook.indexOf('const clearError', cancelStart);
assert.ok(cancelStart >= 0 && cancelEnd > cancelStart, 'missing cancelSending lifecycle');
const cancel = hook.slice(cancelStart, cancelEnd);
assert.match(cancel, /markSessionStopping\(sessionId, true\)/);
assert.match(cancel, /const result = await stopTurn\(turnId\)/);
assert.doesNotMatch(
  cancel.slice(0, cancel.indexOf('const result = await stopTurn(turnId)')),
  /\.abort\(\)|clearSessionRunning|delete controllersRef/,
  'Stop acceptance must not abort the SSE stream or clear the active turn',
);
assert.match(hook, /applyTurnTerminalSnapshot/);
assert.match(hook, /cardbush_terminal_stopped/);
assert.match(hook, /retainedTerminalAssistants/);
assert.match(hook, /createdAt: source\.createdAt \?\? message\.createdAt/);
assert.match(hook, /terminalTurnIdsRef\.current\.has\(terminalTurnId\)/);
assert.match(hook, /const reconcileTerminalTurn = useCallback/);
assert.match(hook, /reconcileTerminalTurn\(sessionId, turnId, 20, 750\)/);
assert.match(hook, /!isRunningSessionTurn\(latestTurn\)/);

assert.match(app, /stopping=\{chat\.stopping\}/);
assert.match(composer, /正在停止/);
assert.match(composer, /cancelReady && !stopping/);
assert.doesNotMatch(bubble, /reason: reason \|\| 'user_stop'/);
assert.doesNotMatch(bubble, /工具记录和文件变更仍保留/);
assert.match(bubble, /const preserveStoppedExecutionRecord =/);
assert.match(
  bubble,
  /isActiveAssistantTurn \|\|[\s\S]*?guidanceBoundaryRound \|\|[\s\S]*?preserveStoppedExecutionRecord/,
);
assert.match(bubble, /message\.metadata\?\.cardbush_terminal_stopped === true/);
assert.match(bubble, /const stoppedAssistantRound = isStoppedAssistantMessage\(message\)/);
assert.match(
  bubble,
  /const freezeStoppedTranscript = stoppedAssistantRound && loopHistory\.length > 0/,
  'A stopped multi-segment Turn must keep the continuous transcript presentation it had when Stop settled.',
);
assert.match(
  bubble,
  /isActiveAssistantTurn \|\| freezeStoppedTranscript\s*\? activeAssistantTranscriptMessages/,
  'Stopped transcript segments must render inside one assistant bubble with one action row.',
);
assert.match(
  bubble,
  /showAssistantProgress\s*=\s*[\s\S]*?!stoppedAssistantRound/,
  'Stopped turns must not retain the processed/working progress header',
);
assert.match(
  bubble,
  /guidanceBoundaryRound \? \([\s\S]*?\) : stoppedAssistantRound \? \([\s\S]*?assistantBody/,
  'Stopped turns must render their preserved transcript directly instead of entering completed disclosure',
);

const hookTranspiled = ts.transpileModule(hook, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
  },
});
const hookModule = { exports: {} };
vm.runInNewContext(hookTranspiled.outputText, {
  module: hookModule,
  exports: hookModule.exports,
  require: (specifier) => {
    if (specifier.endsWith('/assistantTurnTiming')) {
      return {
        assistantTurnTimingFingerprint: () => '',
        hydrateAssistantTurnTiming: (messages) => messages,
        persistAssistantTurnTiming: () => undefined,
      };
    }
    if (specifier.endsWith('/goalState')) {
      return {
        applyGoalToolUpdate: () => null,
        goalToolUpdateFromExecution: () => null,
        isGoalSelfCheckMessage: () => false,
      };
    }
    if (specifier.endsWith('/toolArtifacts')) {
      return {
        mergeToolArtifacts: (current = [], incoming = []) => [
          ...current,
          ...incoming.filter(
            (artifact) => !current.some((item) => item.id === artifact.id),
          ),
        ],
      };
    }
    return {};
  },
  Date,
  Map,
  Set,
  window: { setTimeout, clearTimeout },
});
const {
  applyTurnTerminalSnapshot,
  mergeFinalStreamMessages,
  mergeLoadedMessagesPreservingLocalState,
  normalizeChatMessagesForDisplay,
} = hookModule.exports;

const failedTerminalTranscript = applyTurnTerminalSnapshot(
  {
    session: [{
      id: 'user-failed',
      role: 'user',
      content: '打开网页',
      turnId: 'turn-failed',
      createdAt: '2026-08-30T12:00:00.000Z',
    }],
  },
  'session',
  'assistant-failed',
  {
    turnId: 'turn-failed',
    status: 'failed',
    stopped: false,
    stopReason: 'invalid_request_error',
    stopDetails: { message: 'The provider rejected this request.' },
    completedAt: '2026-08-30T12:00:01.000Z',
    raw: {},
  },
).session;
assert.deepEqual(
  Array.from(failedTerminalTranscript, (message) => message.role),
  ['user', 'assistant'],
  'A failed turn without model text must create a visible assistant failure record',
);
assert.equal(failedTerminalTranscript[1].status, 'failed');

const finalStreamFailedTerminal = mergeFinalStreamMessages(
  { session: failedTerminalTranscript },
  'session',
  [{
    id: 'user-server-failed',
    role: 'user',
    content: '打开网页',
    turnId: 'turn-failed',
    createdAt: '2026-08-30T12:00:00.000Z',
  }],
  {
    turnId: 'turn-failed',
    temporaryMessageIds: ['user-failed', 'assistant-failed'],
    toolSourceMessageId: 'assistant-failed',
  },
).session;
assert.deepEqual(
  Array.from(finalStreamFailedTerminal, (message) => message.role),
  ['user', 'assistant'],
  'The final stream snapshot must not erase a terminal failure when it has no assistant row',
);
assert.equal(finalStreamFailedTerminal[1].status, 'failed');

const reconciledFailedTerminal = mergeLoadedMessagesPreservingLocalState(
  failedTerminalTranscript,
  [{
    id: 'user-server-failed',
    role: 'user',
    content: '打开网页',
    turnId: 'turn-failed',
    createdAt: '2026-08-30T12:00:00.000Z',
  }],
);
assert.deepEqual(
  Array.from(reconciledFailedTerminal, (message) => message.role),
  ['user', 'assistant'],
  'A user-only Runtime snapshot must not erase the terminal failure presentation',
);
assert.equal(
  reconciledFailedTerminal[1].metadata.stop_details.message,
  'The provider rejected this request.',
);

const stoppedTranscript = mergeLoadedMessagesPreservingLocalState(
  [
    {
      id: 'user-local',
      clientMessageId: 'client-user',
      role: 'user',
      content: '我说的是视觉效果',
      turnId: 'turn-stop',
      createdAt: '2026-08-23T10:00:00.000Z',
    },
    {
      id: 'assistant-local',
      role: 'assistant',
      content: '正在检查视觉效果',
      turnId: 'turn-stop',
      createdAt: '2026-08-23T10:00:01.000Z',
      status: 'stopped',
      metadata: {
        cardbush_terminal_snapshot: true,
        cardbush_terminal_stopped: true,
      },
      toolExecutions: [{ id: 'tool-1', state: 'completed', metadata: {} }],
    },
  ],
  [
    {
      id: 'assistant-local',
      role: 'assistant',
      content: '正在检查视觉效果',
      turnId: 'turn-stop',
      createdAt: '2026-08-23T09:59:58.000Z',
      status: 'stopped',
      metadata: { stopped: true },
    },
    {
      id: 'user-server',
      clientMessageId: 'client-user',
      role: 'user',
      content: '我说的是视觉效果',
      turnId: 'turn-stop',
      createdAt: '2026-08-23T10:00:03.000Z',
    },
  ],
);
assert.deepEqual(
  Array.from(stoppedTranscript, (message) => message.role),
  ['user', 'assistant'],
  'Stop reconciliation must retain the established user → assistant transcript order',
);
assert.equal(stoppedTranscript[1].toolExecutions[0].id, 'tool-1');

const stoppedMultiSegmentTranscript = normalizeChatMessagesForDisplay([
  {
    id: 'stopped-user',
    role: 'user',
    content: '创建演示文稿',
    turnId: 'turn-stopped-multi-segment',
    messageIndex: 0,
  },
  {
    id: 'stopped-assistant-1',
    role: 'assistant',
    content: '先检查可用技能。',
    turnId: 'turn-stopped-multi-segment',
    messageIndex: 1,
    status: 'stopped',
    toolExecutions: [{
      id: 'tool-search',
      state: 'completed',
      summary: '搜索技能',
      output: '找到演示文稿技能',
      metadata: {},
    }],
  },
  {
    id: 'stopped-assistant-2',
    role: 'assistant',
    content: '继续读取技能指南。',
    turnId: 'turn-stopped-multi-segment',
    messageIndex: 2,
    status: 'stopped',
    toolExecutions: [{
      id: 'tool-read',
      state: 'failed',
      summary: '读取技能',
      output: '参数错误',
      metadata: {},
    }],
  },
  {
    id: 'stopped-assistant-3',
    role: 'assistant',
    content: '正在检查本地环境。',
    turnId: 'turn-stopped-multi-segment',
    messageIndex: 3,
    status: 'stopped',
    metadata: {
      cardbush_terminal_snapshot: true,
      cardbush_terminal_stopped: true,
    },
  },
]);
assert.deepEqual(
  Array.from(stoppedMultiSegmentTranscript, (message) => message.role),
  ['user', 'assistant'],
  'A stopped Turn must freeze as one assistant interaction unit.',
);
assert.equal(stoppedMultiSegmentTranscript[1].status, 'stopped');
assert.deepEqual(
  Array.from(
    stoppedMultiSegmentTranscript[1].loopHistory,
    (message) => [message.content, message.toolExecutions?.[0]?.id ?? ''],
  ),
  [
    ['先检查可用技能。', 'tool-search'],
    ['继续读取技能指南。', 'tool-read'],
  ],
  'Stopped process segments and their execution records must remain inside the single assistant unit.',
);

const aggregateExecutions = ['tool-loop-1', 'tool-loop-2', 'tool-loop-3'].map(
  (id, index) => ({
    id,
    state: index === 1 ? 'failed' : 'completed',
    summary: `执行 ${index + 1}`,
    output: `结果 ${index + 1}`,
    assistantMessageId: `persisted-stopped-segment-${index + 1}`,
    metadata: {},
  }),
);
const stoppedAggregateReconciliation = mergeLoadedMessagesPreservingLocalState(
  [{
    id: 'temporary-stopped-aggregate',
    role: 'assistant',
    content: '停止前的聚合显示消息',
    turnId: 'turn-stopped-aggregate',
    status: 'stopped',
    assistantMessageId: 'persisted-stopped-segment-3',
    metadata: {
      cardbush_terminal_snapshot: true,
      cardbush_terminal_stopped: true,
    },
    toolExecutions: aggregateExecutions,
    loopHistory: [{
      id: 'temporary-cumulative-history',
      role: 'assistant',
      content: '不应再次投射的累计历史',
      turnId: 'turn-stopped-aggregate',
      status: 'superseded',
      toolExecutions: aggregateExecutions,
      metadata: { transcript_kind: 'assistant_loop' },
    }],
  }],
  aggregateExecutions.map((execution, index) => ({
    id: `persisted-stopped-segment-${index + 1}`,
    messageId: `persisted-stopped-segment-${index + 1}`,
    role: 'assistant',
    content: index < 2 ? `过程 ${index + 1}` : '停止时的最后过程',
    turnId: 'turn-stopped-aggregate',
    messageIndex: index + 1,
    status: index < 2 ? 'superseded' : 'stopped',
    metadata: {
      assistant_segment_index: index + 1,
      transcript_kind: index < 2 ? 'assistant_loop' : 'assistant_final',
      ...(index === 2 ? { stopped: true } : {}),
    },
    toolExecutions: [execution],
  })),
);
const reconciledExecutionIds = stoppedAggregateReconciliation
  .flatMap((message) => [message, ...(message.loopHistory ?? [])])
  .flatMap((message) => message.toolExecutions ?? [])
  .map((execution) => execution.id);
assert.equal(
  reconciledExecutionIds.sort().join(','),
  aggregateExecutions.map((execution) => execution.id).sort().join(','),
  'Stop reconciliation must project each execution once instead of copying the aggregate list into every loop segment.',
);
assert.equal(
  stoppedAggregateReconciliation.length,
  1,
  'The stopped multi-loop transcript must still collapse into one assistant interaction unit.',
);

console.log('Stop lifecycle frontend contract tests passed');
