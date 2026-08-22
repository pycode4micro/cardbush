import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

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
assert.match(hook, /terminalTurnIdsRef\.current\.has\(terminalTurnId\)/);
assert.match(hook, /const reconcileTerminalTurn = useCallback/);
assert.match(hook, /reconcileTerminalTurn\(sessionId, turnId, 20, 750\)/);
assert.match(hook, /!isRunningSessionTurn\(latestTurn\)/);

assert.match(app, /stopping=\{chat\.stopping\}/);
assert.match(composer, /正在停止/);
assert.match(composer, /cancelReady && !stopping/);
assert.match(bubble, /本轮已停止/);
assert.match(bubble, /工具记录和文件变更仍保留/);

console.log('Stop lifecycle frontend contract tests passed');
