import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const types = read('src', 'types.ts');
const api = read('src', 'backend', 'api.ts');
const hook = read('src', 'hooks', 'useCardbushChat.ts');
const app = read('src', 'App.tsx');
const styles = read('src', 'styles', 'app.css');

assert.match(types, /export interface RuntimeConnectionUpdate/);
for (const state of ['retrying', 'syncing', 'recovered', 'failed']) {
  assert.match(types, new RegExp(`'${state}'`));
}

for (const event of ['connection_state', 'provider_retry', 'provider_recovered']) {
  assert.match(api, new RegExp(`'${event}'`));
}
assert.match(api, /onConnectionState\?: \(update: RuntimeConnectionUpdate\) => void/);
assert.match(api, /function runtimeConnectionUpdateFromPayload/);
assert.match(api, /payload\.next_retry_ms/);
assert.match(api, /line\.startsWith\('id:'\)/);
assert.match(api, /SSE connection closed before the done event/);

const recoveryStart = hook.indexOf('const recoverInterruptedSession');
const recoveryEnd = hook.indexOf('const sendMessage', recoveryStart);
assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart, 'missing recovery routine');
const recovery = hook.slice(recoveryStart, recoveryEnd);
assert.match(recovery, /fetchSessionMessages\(sessionId/);
assert.match(recovery, /failedAttempts >= 5/);
assert.match(recovery, /isRunningSessionTurn/);
assert.doesNotMatch(
  recovery,
  /streamChat\(|sendMessage\(/,
  'transport recovery must never submit the original turn again',
);
assert.match(hook, /isNetworkTransportError\(caught\)/);
assert.match(hook, /onConnectionState: \(update\)/);

assert.match(app, /<ConversationConnectionNotice/);
assert.match(app, /连接异常，正在恢复/);
assert.match(app, /连接已建立，正在同步运行状态/);
assert.match(app, /正在重试/);
assert.doesNotMatch(app, />连接已恢复</);
assert.match(styles, /\.conversation-connection-notice\s*\{/);
assert.match(styles, /\.conversation-connection-notice\.working > svg/);

console.log('Connection recovery frontend contract tests passed');
