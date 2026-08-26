import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

import ts from 'typescript';

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const types = read('src', 'types.ts');
const api = read('src', 'backend', 'api.ts');
const hook = read('src', 'hooks', 'useCardbushChat.ts');
const app = read('src', 'App.tsx');
const composer = read('src', 'features', 'composer', 'Composer.tsx');
const bubble = read('src', 'features', 'chatMessages', 'MessageBubble.tsx');

assert.match(types, /export interface TurnTerminalSnapshot/);
assert.match(api, /export interface StopTurnResult/);
assert.match(api, /accepted: payload\.accepted === true \|\| payload\.stopped === true/);
assert.match(api, /onDone\?: \(terminal: TurnTerminalSnapshot\) => void/);
assert.match(api, /request\.onDone\?\.\(terminal\)/);
assert.match(api, /if \(sawDoneEvent\) \{\s*return;\s*\}/);
assert.match(api, /await reader\.cancel\(\)\.catch\(\(\) => undefined\)/);

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
assert.match(hook, /retainedStoppedAssistants/);
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
    return {};
  },
  Date,
  Map,
  Set,
  window: { setTimeout, clearTimeout },
});
const { mergeLoadedMessagesPreservingLocalState } = hookModule.exports;

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

console.log('Stop lifecycle frontend contract tests passed');
