import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { decodeRuntimeFixture } from '@cardbush/bush-protocol/runtime-fixture';
import { InMemoryRuntimeEventLog } from '@cardbush/bush-runtime';

const root = process.cwd();
const read = (...parts) => readFileSync(join(root, ...parts), 'utf8');

const provider = read('packages', 'bush-provider-openai', 'src', 'responses.ts');
assert.doesNotMatch(provider, /providerStateCompatibilityError|retryableProviderCode/);
assert.match(provider, /continuation === "supported"/);
assert.match(provider, /code: "provider_client_error"[\s\S]*?retryable: false/);

const ipc = read('packages', 'bush-protocol', 'src', 'runtimeIpc.ts');
assert.match(ipc, /kind: runtimeErrorKindSchema/);
assert.match(ipc, /"protocol"[\s\S]*?"transport"[\s\S]*?"runtime"[\s\S]*?"cancelled"/);

const hook = read('src', 'hooks', 'useCardbushChat.ts');
assert.match(hook, /error\.fact\.kind === 'transport'/);
assert.doesNotMatch(hook, /failed to fetch\|networkerror|econnreset|socket hang up/i);
assert.doesNotMatch(hook, /function isRunningSessionTurn/);

const subagentRuntime = read('src', 'backend', 'runtimeChat.ts');
const subagentApi = read('src', 'backend', 'api.ts');
assert.match(subagentRuntime, /subagentTaskStatusSchema\.parse\(statusValue\)/);
assert.doesNotMatch(subagentRuntime, /decodeSubagentTaskStatus/);
assert.doesNotMatch(subagentApi, /subagentTaskFromPayload|decodeSubagentTaskStatus/);

const toolState = read('src', 'features', 'tools', 'toolExecutionState.ts');
for (const alias of ['pending', 'using', 'started', 'complete', 'succeeded', 'success', 'done', 'canceled', 'stopped']) {
  assert.doesNotMatch(toolState, new RegExp(`['\"]${alias}['\"]`));
}

assert.equal(
  existsSync(join(root, 'src', 'features', 'tools', 'PlanVerificationPanel.tsx')),
  false,
  'The removed Execution Fact classifier UI must not be restored',
);

const fixture = decodeRuntimeFixture(JSON.parse(read(
  'packages',
  'bush-protocol',
  'reference-fixtures',
  'single-turn-stream.v1.json',
)));
const events = fixture.events.map((entry) => entry.event);
const identity = events[0];
const log = new InMemoryRuntimeEventLog({
  persistence: {
    load(sessionId, turnId) {
      return sessionId === identity.sessionId && turnId === identity.turnId ? events : [];
    },
    append() {},
  },
});
const replay = log.replay(identity.sessionId, identity.turnId);
assert.deepEqual(replay.map((event) => event.sequence), events.map((event) => event.sequence));
assert.equal(replay.at(-1)?.kind, 'turn_terminal');
assert.equal(replay.at(-1)?.payload.status, 'completed');
const afterReasoning = log.replay(identity.sessionId, identity.turnId, {
  lastEventId: replay.find((event) => event.kind === 'reasoning_segment_completed').eventId,
});
assert.equal(afterReasoning[0]?.kind, 'assistant_segment_started');

console.log(`nonsemantic root contract and replay passed (${replay.length} events)`);
