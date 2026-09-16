import assert from 'node:assert/strict';
import path from 'node:path';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';

const source = ['src/features/chatMessages/assistantRunActivity.ts', 'src/features/chatMessages/mcpActivation.ts',
  'src/backend/mcpConfigurationFact.ts', 'src/features/chatMessages/modelFailurePresentation.ts'].map(file => `export * from ${JSON.stringify(path.resolve(file))};`).join('\n');
const { turnActivityExecutions, mcpActivations, mcpActivationState, configuredMcpServerId, modelFailurePresentation } =
  await loadChatTranscript({ source });
const execution = (id, state, metadata = {}, time = 0) => ({ id, name: 'terminal_exec', state,
  summary: id, output: '', createdAt: new Date(1788883200000 + time).toISOString(), metadata });
const background = execution('download', 'completed', { nativeResult: { terminalSessionId: 'terminal', state: 'running' } });
const waiting = execution('configure', 'awaiting_permission', {}, 1000);
const running = execution('inspect', 'running', {}, 2000);
const turn = { toolExecutions: [waiting, running], loopHistory: [{ toolExecutions: [background] }] };
assert.equal(turnActivityExecutions(turn).map(item => item.id).join(','), 'download,configure,inspect');
const settled = execution('configure', 'completed', {}, 4000);
const merged = turnActivityExecutions({ toolExecutions: [settled], loopHistory: [{ toolExecutions: [waiting] }] });
assert.equal(merged.length, 1);
assert.equal(merged[0].state, 'completed');

const initial = { protocol: 'bush.mcp_snapshot_result.v1', snapshotId: 'snapshot', revision: 1, pendingRevision: 2,
  applicationState: 'pending', servers: [{ id: 'blender', health: 'ready', tools: [] }] };
const fact = { ...execution('configure', 'completed'), name: 'mcp__cardbush_management__configure_mcp_server',
  metadata: { mcpServerId: 'blender', nativeResult: { content: [{ type: 'text', text: JSON.stringify({ saved: true, runtime: initial }) }] } } };
const [target] = mcpActivations([fact]);
assert.equal(target.revision, 2);
assert.equal(mcpActivationState(target, initial), 'pending', 'old ready connection cannot verify queued configuration');
assert.equal(mcpActivationState(target, { ...initial, pendingServerIds: ['other'] }), 'connected', 'an independently published service does not wait for an unrelated connection');
assert.equal(mcpActivationState(target, { ...initial, servers: [{ id: 'blender', updateState: 'connecting', health: 'auth_required', tools: [] }] }), 'pending', 'the previous sign-in state does not override a new connection attempt');
assert.equal(mcpActivationState(target, { ...initial, servers: [{ id: 'blender', updateState: 'waiting_for_catalog', health: 'unavailable', tools: [] }] }), 'failed', 'a background failure is observable before catalog publication');
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
const originalError = '400 Tool names must be unique.';
const duplicateFailure = modelFailurePresentation('invalid_request_error', originalError, 'zh', 400);
assert.match(duplicateFailure.detail, /工具名称重复/);
assert.equal(duplicateFailure.detail.includes(originalError), false);
assert.ok(duplicateFailure.technicalDetails.endsWith(originalError), 'provider diagnostics remain verbatim and separate from the localized explanation');
assert.match(modelFailurePresentation('invalid_request_error', originalError, 'en', 400).detail, /Duplicate tool names/);
const unknownFailure = modelFailurePresentation('unknown_provider_error', 'Unexpected upstream failure', 'zh');
assert.match(unknownFailure.detail, /本轮执行未能完成/);
assert.ok(unknownFailure.technicalDetails.includes('Unexpected upstream failure'));
assert.match(modelFailurePresentation('invalid_request_error', 'Invalid parameters', 'zh', 400).detail, /请求参数/);
assert.match(modelFailurePresentation('rate_limit_exceeded', 'Rate limited', 'zh', 429).detail, /限制了请求/);
assert.match(modelFailurePresentation('insufficient_quota', 'Quota exhausted', 'zh', 429).detail, /额度或计费/);
const legacyPlanNotice = modelFailurePresentation('open_task_plan_not_resolved', '', 'zh');
assert.equal(legacyPlanNotice.tone, 'neutral');
assert.equal(legacyPlanNotice.title, '计划仍有未完成标记');
assert.equal(modelFailurePresentation('open_task_plan_not_resolved', '', 'en').tone, 'neutral');
assert.equal(legacyPlanNotice.technicalDetails, undefined);
assert.equal(duplicateFailure.tone, 'error');
console.log('Run activity and MCP activation facts passed (concurrency, history, stale revisions and failures).');
