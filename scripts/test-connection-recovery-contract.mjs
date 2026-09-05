import { readAppViewSources } from './helpers/app-view-sources.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');
const types = read('src', 'types.ts');
const runtimeChat = read('src', 'backend', 'runtimeChat.ts');
const runtimeProtocol = read('packages', 'bush-protocol', 'src', 'runtimeHost.ts');
const hook = read('src', 'hooks', 'useCardbushChat.ts');
const app = readAppViewSources();
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
assert.match(app, /\[retryStatus, update\.message \|\| update\.reason, keepTrying\]/);
assert.match(app, /update\.maxAttempts === null/);
assert.match(app, /将持续重试，可点击停止/);
assert.match(app, /window\.clearInterval\(timer\)/);
assert.doesNotMatch(app, />连接已恢复</);
assert.match(styles, /\.conversation-connection-notice\s*\{/);
assert.match(styles, /\.conversation-connection-notice\.working > svg/);

// Exercise the actual event consumer with an isolated stream, not a copied UI reducer.
const sourceFile = ts.createSourceFile('runtimeChat.ts', runtimeChat, ts.ScriptTarget.Latest, true);
const consumerNode = sourceFile.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'consumeRuntimeEvents');
assert.ok(consumerNode);
const consumerSource = ts.transpileModule(consumerNode.getText(sourceFile), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const consumeEvents = new Function('thinking', 'assistantStreamChunk', 'toolLifecycle',
  consumerSource + '\nreturn consumeRuntimeEvents;'
)((event, phase) => ({ phase }), event => ({ messageId: event.payload.messageId }), event => event);
const replay = async kinds => {
  const states = [], deltas = [];
  const events = kinds.map((kind, index) => ({
    kind, sessionId: 'fixture-session', turnId: 'fixture-turn', sequence: index,
    eventId: String(index), createdAt: new Date().toISOString(),
    payload: kind === 'provider_retry'
      ? { attempt: 8, maxAttempts: null, nextRetryMs: 30000, code: 'ECONNRESET', message: 'Connection error.' }
      : { messageId: 'fixture-message', delta: 'visible' },
  }));
  await consumeEvents(
    { client: { async *events() { yield* events; } } },
    { sessionId: 'fixture-session', turnId: 'fixture-turn' },
    {
      onConnectionState: update => states.push(update),
      onDelta: delta => deltas.push(delta),
    },
    new Set(), () => {}, () => {}, new AbortController().signal,
  );
  return { states, deltas };
};
const waiting = await replay(['provider_retry', 'cache_chain_observed', 'replay_reset']);
assert.deepEqual(waiting.states.map(update => update.state), ['retrying'], 'local activity must not dismiss a failed connection');
assert.equal(waiting.states[0].maxAttempts, null);
const recovered = await replay([
  'provider_retry', 'cache_chain_observed', 'assistant_segment_started', 'assistant_segment_delta',
  'assistant_segment_delta', 'provider_retry', 'reasoning_segment_started',
]);
assert.deepEqual(recovered.states.map(update => update.state), ['retrying', 'recovered', 'retrying', 'recovered']);
assert.deepEqual(recovered.deltas, ['visible', 'visible'], 'recovery notices must not consume transcript events');
assert.ok(recovered.states.every(update => update.source === 'provider'));
assert.deepEqual((await replay(['assistant_segment_delta'])).states.map(update => update.state), ['recovered'], 'cursor reattachment clears a retained retry notice on real provider activity');
assert.deepEqual((await replay(['provider_retry', 'tool_queued'])).states.map(update => update.state), ['retrying', 'recovered'], 'tool-only model responses recover too');

console.log('Connection recovery frontend contract tests passed');
