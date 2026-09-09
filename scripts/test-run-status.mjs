import assert from 'node:assert/strict';
import path from 'node:path';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';

const source = ['src/features/chatMessages/assistantRunActivity.ts', 'src/features/chatMessages/mcpActivation.ts',
  'src/backend/mcpConfigurationFact.ts'].map(file => `export * from ${JSON.stringify(path.resolve(file))};`).join('\n');
const { assistantRunActivity, turnActivityExecutions, mcpActivations, mcpActivationState, configuredMcpServerId } =
  await loadChatTranscript({ source });
const execution = (id, state, metadata = {}, time = 0) => ({ id, name: 'terminal_exec', state,
  summary: id, output: '', createdAt: new Date(1788883200000 + time).toISOString(), metadata });
const background = execution('download', 'completed', { nativeResult: { terminalSessionId: 'terminal', state: 'running' } });
const waiting = execution('configure', 'awaiting_permission', {}, 1000);
const running = execution('inspect', 'running', {}, 2000);
const turn = { toolExecutions: [waiting, running], loopHistory: [{ toolExecutions: [background] }] };
const activity = assistantRunActivity(turnActivityExecutions(turn));
assert.equal(activity.waiting.length, 1);
assert.equal(activity.running.length, 1);
assert.equal(activity.observedRunningTerminals, 1, 'a completed tool call may leave its terminal running');
assert.equal(activity.lastToolEventAt, running.createdAt);
const exit = { ...execution('poll', 'completed', { nativeResult: { terminalSessionId: 'terminal', state: 'exited' } }, 3000), name: 'terminal_poll' };
assert.equal(assistantRunActivity(turnActivityExecutions({ ...turn, toolExecutions: [exit] })).observedRunningTerminals, 0);
const listing = { ...exit, name: 'terminal_list', metadata: { nativeResult: { sessions: [] } } };
assert.equal(assistantRunActivity([background, listing]).observedRunningTerminals, 0);
assert.equal(assistantRunActivity([{ ...background, name: 'other_tool' }]).observedRunningTerminals, 0, 'do not infer downloads from arbitrary output');
const settled = execution('configure', 'completed', {}, 4000);
assert.equal(assistantRunActivity(turnActivityExecutions({ toolExecutions: [settled], loopHistory: [{ toolExecutions: [waiting] }] })).waiting.length, 0);

const initial = { protocol: 'bush.mcp_snapshot_result.v1', snapshotId: 'snapshot', revision: 1, pendingRevision: 2,
  applicationState: 'pending', servers: [{ id: 'blender', health: 'ready', tools: [] }] };
const fact = { ...execution('configure', 'completed'), name: 'mcp__cardbush_management__configure_mcp_server',
  metadata: { mcpServerId: 'blender', nativeResult: { content: [{ type: 'text', text: JSON.stringify({ saved: true, runtime: initial }) }] } } };
const [target] = mcpActivations([fact]);
assert.equal(target.revision, 2);
assert.equal(mcpActivationState(target, initial), 'pending', 'old ready connection cannot verify queued configuration');
const applied = { ...initial, applicationState: 'applied', revision: 2, pendingRevision: undefined };
assert.equal(mcpActivationState(target, applied), 'connected');
assert.equal(mcpActivationState(target, { ...applied, servers: [] }), 'unknown', 'applied alone is not connected');
assert.equal(mcpActivationState(target, { ...applied, servers: [{ id: 'blender', health: 'unavailable', tools: [] }] }), 'failed');
assert.equal(mcpActivationState(target, { ...applied, revision: 3 }), 'superseded');
assert.equal(mcpActivationState(target, { ...applied, revision: 1 }), 'unknown');
assert.equal(mcpActivationState(target, null), 'unknown');
assert.equal(mcpActivations([{ ...fact, metadata: { ...fact.metadata, nativeResult: { isError: true } } }]).length, 0);
assert.equal(configuredMcpServerId({ name: fact.name, argumentsText: '{"id":"blender","env":{"SECRET":"private"}}' }), 'blender');
assert.equal(configuredMcpServerId({ name: fact.name, argumentsText: '{"id":"blender","enabled":false}' }), undefined);
assert.equal(configuredMcpServerId({ name: 'other_tool', argumentsText: '{"id":"blender"}' }), undefined);
console.log('Run activity and MCP activation facts passed (concurrency, history, stale revisions and failures).');
