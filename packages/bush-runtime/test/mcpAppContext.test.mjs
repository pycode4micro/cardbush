import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { InMemoryRuntimeHost, ToolRegistry, ToolExecutionStore, RuntimeToolLoop, InMemoryRuntimeEventLog, modelFacingNativeToolResult } from '../dist/index.js';

const manifest = { effect_kind: 'observation', operation: 'fixture', risk: 'low', owner: 'runtime', dispatch_scope: 'parent_session', mutating: false };
test('UI observations append once at round boundaries without changing earlier context or tools', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-ui-context-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-ui-context-')); await rm(root, { recursive: true, force: true }); });
  const registry = new ToolRegistry(), requests = []; let calls = 0, reads = 0, token;
  registry.register({ definition: { name: 'mcp__fixture__view', description: 'Fixture view', inputSchema: { type: 'object' } },
    manifest, decodeInput: x => x, execute: () => { calls++; return { content: [], structuredContent: { selected: 1 } }; },
    mcpHook: { server: 'fixture', tool: 'view', call: async () => ({}) },
    mcpApp: { resourceUri: 'ui://fixture', readResource: async uri => { reads++; return { contents: [{ uri, mimeType: 'text/html', text: '<h1>View</h1>' }] }; } } });
  registry.register({ definition: { name: 'fixture_read', description: 'Fixture read', inputSchema: { type: 'object' } }, manifest, decodeInput: x => x, execute: () => ({ value: 1 }) });
  const host = new InMemoryRuntimeHost({ dataRoot: root, toolRegistry: registry, provider: { async *stream(request) {
    const round = requests.length; requests.push(structuredClone(request));
    const event = (sequence, kind, fields = {}) => ({ protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: '2026-09-10T00:00:00Z', sequence, kind, ...fields });
    yield event(0, 'response_started');
    if (round === 1) {
      const view = await host.sendCommand({ kind: 'runtime.mcp_app', payload: { action: 'open', sessionId: 's', turnId: 't', toolCallId: 'c0' } }); token = view.token;
      await host.sendCommand({ kind: 'runtime.mcp_app', payload: { action: 'observe', token, event: 'frame_loaded' } });
      await host.sendCommand({ kind: 'runtime.mcp_app', payload: { action: 'observe', token, event: 'initialized' } });
      await host.sendCommand({ kind: 'runtime.mcp_app', payload: { action: 'context', token, context: { structuredContent: { selected: 'B' } } } });
    }
    if (round < 3) {
      yield event(1, 'tool_call_delta', { index: 0, toolCallId: 'c' + round, nameDelta: round === 0 ? 'mcp__fixture__view' : round === 1 ? 'mcp_app_status' : 'fixture_read', argumentsDelta: '{}' });
      yield event(2, 'response_completed', { finishReason: 'tool_calls' });
    } else { yield event(1, 'text_delta', { delta: '根据观察继续，由模型决定何时结束。' }); yield event(2, 'response_completed', { finishReason: 'stop' }); }
  } } });
  const terminal = await host.runModelTurn({ protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture',
    messages: [{ role: 'system', content: 'Stable prefix' }, { role: 'user', content: 'Open the fixture' }],
    tools: registry.definitions().filter(tool => !['mcp_search', 'mcp_call'].includes(tool.name)) });
  assert.equal(terminal.payload.status, 'completed'); assert.equal(requests.length, 4); assert.equal(calls, 1); assert.equal(reads, 1);
  const observations = requests[2].messages.filter(message => message.name === 'mcp_app_observations');
  assert.equal(observations.length, 1); assert.equal(observations[0].visibility, 'internal');
  assert.deepEqual(JSON.parse(observations[0].content).events.map(event => event.event), ['resource_loading', 'resource_loaded', 'frame_loaded', 'initialized']);
  assert.equal(requests[3].messages.filter(message => message.name === 'mcp_app_observations').length, 1, 'unchanged observations do not get resent');
  const pluginContext = requests[2].messages.filter(message => message.name === 'mcp_app_context');
  assert.equal(pluginContext.length, 1); assert.equal(pluginContext[0].visibility, 'internal'); assert.match(pluginContext[0].content, /"selected":"B"/);
  assert.equal(requests[3].messages.filter(message => message.name === 'mcp_app_context').length, 1, 'unchanged plugin context remains one immutable message');
  for (let i = 1; i < requests.length; i++) {
    assert.deepEqual(requests[i].tools, requests[0].tools);
    assert.deepEqual(requests[i].messages.slice(0, requests[i - 1].messages.length), requests[i - 1].messages, 'old context is unchanged');
  }
  await host.sendCommand({ kind: 'runtime.mcp_app', payload: { action: 'close', token } });
  assert.equal(requests.length, 4, 'UI lifecycle events never force another model turn');
});

test('failed client validation keeps native raw data while projecting UI metadata out of model errors', async () => {
  const registry = new ToolRegistry(), store = new ToolExecutionStore();
  const raw = { structuredContent: null, content: [{ type: 'text', text: 'Provider result' }], _meta: { private: 'UI-only' } };
  registry.register({ definition: { name: 'fixture_error', description: 'Fixture', inputSchema: { type: 'object' } }, manifest,
    decodeInput: x => x, execute: () => { throw Object.assign(new Error('Client validation failed'), { code: 'mcp_protocol_error', details: { resultValidationFailed: true, rawResult: raw } }); } });
  const loop = new RuntimeToolLoop({ registry, executionStore: store, eventLog: new InMemoryRuntimeEventLog(), identity: { sessionId: 's', turnId: 't', requestId: 'r' } });
  const result = await loop.execute([{ protocol: 'bush.tool_call.v1', id: 'c', name: 'fixture_error', argumentsText: '{}' }], { round: 1, assistantMessageId: 'a' });
  assert.equal(JSON.stringify(result.messages).includes('UI-only'), false);
  assert.match(JSON.stringify(result.messages), /Provider result/);
  assert.deepEqual(store.get('s', 't', 'c').error.details.rawResult, raw);
  const malformed = { runtimeError: { details: { resultValidationFailed: true, rawResult: ['unusual server payload'] } } };
  assert.deepEqual(modelFacingNativeToolResult(malformed, 'fixture_error'), malformed, 'invalid arrays are retained without reshaping them into objects');
});
