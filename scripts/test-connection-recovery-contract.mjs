import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const types = read('src', 'types.ts');
const runtimeChat = read('src', 'backend', 'runtimeChat.ts');
const runtimeProtocol = read('packages', 'bush-protocol', 'src', 'runtimeHost.ts');
const hook = read('src', 'hooks', 'useCardbushChat.ts');
const app = read('src', 'App.tsx');
const styles = read('src', 'styles', 'app.css');

assert.match(types, /export interface RuntimeConnectionUpdate/);
for (const state of ['retrying', 'syncing', 'recovered', 'failed']) {
  assert.match(types, new RegExp(`'${state}'`));
}

for (const event of ['provider_retry', 'connection_interrupted', 'stream_resumed']) {
  assert.ok(
    runtimeProtocol.includes(`kind: z.literal("${event}")`),
    `runtime protocol must decode ${event}`,
  );
  assert.match(runtimeChat, new RegExp(`case '${event}'`));
}
assert.match(runtimeChat, /onConnectionState\?\./);
assert.match(runtimeChat, /maxAttempts: event\.payload\.maxAttempts/);
assert.match(runtimeChat, /nextRetryMs: event\.payload\.nextRetryMs/);
assert.match(runtimeChat, /event\.payload\.resumable \? 'retrying' : 'failed'/);
assert.match(runtimeChat, /state: 'recovered'/);

const recoveryStart = hook.indexOf('const recoverInterruptedSession');
const recoveryEnd = hook.indexOf('const sendMessage', recoveryStart);
assert.ok(recoveryStart >= 0 && recoveryEnd > recoveryStart, 'missing recovery routine');
const recovery = hook.slice(recoveryStart, recoveryEnd);
assert.match(recovery, /fetchSessionMessages\(sessionId/);
assert.match(recovery, /failedAttempts >= 5/);
assert.doesNotMatch(recovery, /isRunningSessionTurn/);
assert.doesNotMatch(
  recovery,
  /streamChat\(|sendMessage\(/,
  'transport recovery must never submit the original turn again',
);
assert.match(hook, /isNetworkTransportError\(caught\)/);
assert.match(hook, /error\.fact\.kind === 'transport'/);
assert.doesNotMatch(hook, /failed to fetch\|networkerror|econnreset|socket hang up/i);
assert.match(hook, /onConnectionState: \(update\)/);
assert.match(hook, /const clearConnectionRecovery = useCallback/);
assert.equal(
  (hook.match(/clearConnectionRecovery\((?:normalizedSessionId|sessionId)\);/g) ?? []).length,
  3,
  'Every terminal stream path must clear a stale provider retry notice.',
);

assert.match(app, /<ConversationConnectionNotice/);
assert.match(app, /连接异常，正在恢复/);
assert.match(app, /连接已建立，正在同步运行状态/);
assert.match(app, /正在重试/);
assert.match(app, /retryDelay \|\| update\.message \|\| update\.reason \|\| ''/);
assert.doesNotMatch(app, />连接已恢复</);
assert.match(styles, /\.conversation-connection-notice\s*\{/);
assert.match(styles, /\.conversation-connection-notice\.working > svg/);

console.log('Connection recovery frontend contract tests passed');
