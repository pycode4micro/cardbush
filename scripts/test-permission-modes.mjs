import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { InMemoryRuntimeHost, ToolRegistry } from '@cardbush/bush-runtime';
import { createProductAgentTurnRequest } from '@cardbush/bush-product-agent';
import { toResponsesCreateParams } from '@cardbush/bush-provider-openai';
import { responsesInputFingerprint } from '../packages/bush-provider-openai/dist/responsesInputFingerprint.js';

function sourceModule(path) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports });
  return exports;
}
const { normalizePermissionMode, permissionModeOptions } = sourceModule('src/shared/permissionModes.ts');
const { selectRuntimeToolDefinitions } = sourceModule('src/backend/runtimeToolCatalog.ts');

test('saved full access survives, legacy home access migrates conservatively, and only two modes are offered', () => {
  for (const value of [undefined, null, '', 'user_free', 'task_free', 'invalid']) assert.equal(normalizePermissionMode(value), 'task_free');
  assert.equal(normalizePermissionMode('all_free'), 'all_free');
  for (const language of ['zh', 'en']) assert.deepEqual(structuredClone(permissionModeOptions(language).map(item => item.id)), ['task_free', 'all_free']);
});

for (const compatibilityMode of [false, true]) test(`approval switches and rejection feedback keep the ${compatibilityMode ? 'compatibility' : 'native'} wire prefix intact`, async t => {
  const registry = new ToolRegistry(), records = [], rounds = new Map();
  let executions = 0;
  registry.register({
    definition: { name: 'approval_fixture', description: 'Requires approval', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'observation', operation: 'fixture.read', risk: 'low', owner: 'fixture', dispatch_scope: 'resource', mutating: false },
    decodeInput: input => input,
    authorize: () => ({ kind: 'ask', request: { reason: 'Read a fixture outside the workspace', actions: ['read'],
      targets: [{ kind: 'opaque', value: 'fixture://external' }], capabilityIds: ['fixture.read'] } }),
    execute: () => { executions++; return { content: 'fixture result' }; },
  });
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, provider: { async *stream(request, options) {
    const params = toResponsesCreateParams(request, { toolSearchMode: 'native', compatibilityMode, disableProviderState: true });
    records.push({ request: structuredClone(request), params });
    options.onInputProjection?.(responsesInputFingerprint(params, params, request.providerBinding));
    const round = (rounds.get(request.turnId) ?? 0) + 1; rounds.set(request.turnId, round);
    const event = (sequence, kind, payload) => ({ protocol: 'bush.model_event.v1', requestId: request.requestId,
      sequence, kind, createdAt: '2026-09-23T00:00:00Z', ...payload });
    if (round === 1) {
      yield event(0, 'tool_call_delta', { index: 0, toolCallId: `call-${request.turnId}`, nameDelta: 'approval_fixture', argumentsDelta: '{}' });
      yield event(1, 'response_completed', { finishReason: 'tool_calls' });
    } else {
      yield event(0, 'text_delta', { delta: 'Done.' });
      yield event(1, 'response_completed', { finishReason: 'stop' });
    }
  } } });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const catalog = registry.definitions().map(definition => ({ definition, manifest: registry.resolve(definition.name).manifest }));
  const tools = structuredClone(selectRuntimeToolDefinitions(catalog, {
    interactiveRequests: true, vision: false, goalAvailable: false, referencePlanMode: 'off',
  }));
  assert.ok(tools.some(tool => tool.name === 'request_permission'));
  let firstTurn;
  for (const [index, permissionMode] of ['all_free', 'task_free', 'all_free'].entries()) {
    const turnId = `mode-${index}`;
    const request = createProductAgentTurnRequest({ requestId: turnId, sessionId: 'permission-cache', turnId,
      messageId: `user-${index}`, createdAt: '2026-09-23T00:00:00Z', userText: `Continue ${index}`,
      model: 'fixture', tools, permissionMode, planEnabled: false, interactiveRequestsEnabled: true,
      maxContextTokens: 100000, maxOutputTokens: 1000 });
    const running = host.runSessionTurn(request);
    if (permissionMode === 'task_free') {
      let pending;
      for (let attempts = 0; attempts < 300; attempts++) {
        pending = host.events('permission-cache', turnId).find(event => event.kind === 'permission_requested');
        if (pending) break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.ok(pending, 'approval mode actually blocks for a decision');
      await host.sendCommand({ kind: 'runtime.answer_permission', payload: {
        protocol: 'bush.runtime_permission_answer.v1', permissionId: pending.payload.permissionId,
        answerId: 'reject-fixture', decision: 'deny',
      } });
    }
    assert.equal((await running).payload.status, 'completed');
    const snapshot = await host.sendCommand({ kind: 'runtime.get_session', payload: { sessionId: 'permission-cache' } });
    if (!firstTurn) firstTurn = structuredClone(snapshot.turns[0]);
    else assert.deepEqual(snapshot.turns[0], firstTurn, 'changing policy never rewrites a completed turn');
    for (const event of host.events('permission-cache', turnId).filter(event => ['cache_chain_observed', 'provider_input_observed'].includes(event.kind))) {
      assert.equal(event.payload.frozenPrefixBreak, false);
    }
  }
  assert.equal(executions, 2, 'full access executes and the rejected approval does not');
  assert.equal(records.length, 6);
  assert.ok(records.some(record => record.request.messages.some(message => message.role === 'tool' && message.content.includes('Do not retry it through another tool'))));
  for (let index = 1; index < records.length; index++) {
    const before = records[index - 1], after = records[index];
    assert.deepEqual(after.params.tools, before.params.tools);
    assert.deepEqual(after.params.input.slice(0, before.params.input.length), before.params.input);
  }
});
