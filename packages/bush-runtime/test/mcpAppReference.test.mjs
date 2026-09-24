import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { RuntimeToolLoop, ToolRegistry, ToolExecutionStore, InMemoryRuntimeEventLog, registerMcpDiscovery, synchronizeMcpDiscovery, InMemoryRuntimeHost } from '../dist/index.js';
import { parseMcpAppReference } from '@cardbush/bush-protocol';

const manifest = { effect_kind: 'observation', operation: 'fixture', risk: 'low', owner: 'runtime', dispatch_scope: 'parent_session', mutating: false };
function setup(result = { content: [{ type: 'text', text: 'Saved revision 3' }], _meta: { secret: 'ui-only-value' } }) {
  const registry = new ToolRegistry(), store = new ToolExecutionStore(); let calls = 0, reads = 0;
  registry.register({ definition: { name: 'mcp__fixture__view', description: 'Fixture', inputSchema: { type: 'object' } }, manifest,
    decodeInput: x => x, execute: () => { calls++; return result; }, renderModelResult: value => JSON.stringify({ content: value.content, isError: value.isError ?? false }),
    mcpHook: { server: 'fixture', tool: 'view', call: async () => ({}) },
    mcpApp: { title: 'Design [v3]', resourceUri: 'ui://fixture', readResource: async () => { reads++; return { contents: [] }; } } });
  return { registry, store, result, counts: () => ({ calls, reads }) };
}
const receipt = content => JSON.parse(content.split('\n\n').at(-1)).runtime_app_reference;

for (const gateway of [false, true]) for (const budget of [undefined, 0]) {
  test(`App links accompany actual ${gateway ? 'mcp_call' : 'native'} results, including budget ${budget}`, async () => {
    const fixture = setup({ content: [{ type: 'text', text: 'Saved revision 3. '.repeat(1500) }], _meta: { secret: 'ui-only-value' } });
    const { registry, store } = fixture;
    registerMcpDiscovery(registry);
    const request = { sessionId: 's', turnId: 't', requestId: 'r', tools: registry.definitions(), metadata: { mcpToolDiscovery: gateway } };
    const context = [];
    if (gateway) {
      const search = registry.resolve('mcp_search');
      const loaded = await search.execute({ input: { action: 'load', query: 'mcp__fixture__view' }, turn: { request, contextMessages: context } });
      context.push({ role: 'assistant', content: '', toolCalls: [{ id: 'load', name: 'mcp_search', argumentsText: '{}' }] }, { role: 'tool', toolCallId: 'load', content: JSON.stringify(loaded) });
      synchronizeMcpDiscovery(registry, request, context);
    }
    const definitions = structuredClone(registry.definitions());
    const loop = new RuntimeToolLoop({ registry, executionStore: store, eventLog: new InMemoryRuntimeEventLog(), identity: { sessionId: 's', turnId: 't', requestId: 'r' } });
    const call = { protocol: 'bush.tool_call.v1', id: 'c', name: gateway ? 'mcp_call' : 'mcp__fixture__view', argumentsText: gateway ? JSON.stringify({ name: 'mcp__fixture__view', arguments: {} }) : '{}' };
    const output = await loop.execute([call], { round: 1, assistantMessageId: 'a', request, contextMessages: context, modelContextIngressBudgetTokens: budget });
    const link = receipt(output.messages[0].content);
    assert.deepEqual(parseMcpAppReference(link.reference), { sessionId: 's', turnId: 't', toolCallId: 'c' });
    assert.match(link.markdown, /^\[Design \\\[v3\\\]\]\(cardbush-app:/);
    assert.match(link.usage, /UI has not been loaded or checked/);
    assert.doesNotMatch(output.messages[0].content, /ui-only-value/);
    assert.deepEqual(fixture.counts(), { calls: 1, reads: 0 }, 'issuing a reference does not read HTML or replay the generating tool');
    const record = store.get('s', 't', 'c');
    assert.deepEqual(gateway ? record.result.result : record.result, fixture.result, 'native records are unchanged');
    assert.equal(receipt(record.modelText).reference, link.reference, 'archived model text preserves the same reference');
    assert.deepEqual(registry.definitions(), definitions, 'no tool schema is mutated by citation delivery');
  });
}

test('failed tool results do not promise an App result', async () => {
  const { registry, store } = setup({ isError: true, content: [{ type: 'text', text: 'No design was created' }] });
  const loop = new RuntimeToolLoop({ registry, executionStore: store, eventLog: new InMemoryRuntimeEventLog(), identity: { sessionId: 's', turnId: 't', requestId: 'r' } });
  const output = await loop.execute([{ protocol: 'bush.tool_call.v1', id: 'c', name: 'mcp__fixture__view', argumentsText: '{}' }], { round: 1, assistantMessageId: 'a' });
  assert.doesNotMatch(output.messages[0].content, /cardbush-app:|runtime_app_reference/);
});

test('model-authored App links preserve append-only request prefixes across rounds', async t => {
  const dataRoot = await mkdtemp(join(tmpdir(), 'cardbush-app-reference-'));
  t.after(async () => { assert.ok(resolve(dataRoot).startsWith(resolve(tmpdir()) + sep + 'cardbush-app-reference-')); await rm(dataRoot, { recursive: true, force: true }); });
  const { registry, counts } = setup(); const requests = [];
  const host = new InMemoryRuntimeHost({ dataRoot, toolRegistry: registry, provider: { async *stream(request) {
    const round = requests.length; requests.push(structuredClone(request));
    const event = (sequence, kind, fields = {}) => ({ protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: '2026-09-24T00:00:00Z', sequence, kind, ...fields });
    yield event(0, 'response_started');
    if (round < 2) {
      yield event(1, 'tool_call_delta', { index: 0, toolCallId: 'c' + round, nameDelta: 'mcp__fixture__view', argumentsDelta: '{}' });
      yield event(2, 'response_completed', { finishReason: 'tool_calls' });
    } else {
      const link = receipt(request.messages.findLast(message => message.role === 'tool').content);
      yield event(1, 'text_delta', { delta: 'Saved revision 3. ' + link.markdown });
      yield event(2, 'response_completed', { finishReason: 'stop' });
    }
  } } });
  const terminal = await host.runModelTurn({ protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture', tools: [registry.resolve('mcp__fixture__view').definition], messages: [{ role: 'system', content: 'Stable instructions' }, { role: 'user', content: 'Create a design' }] });
  assert.equal(terminal.payload.status, 'completed'); assert.equal(requests.length, 3);
  for (let index = 1; index < requests.length; index++) {
    assert.deepEqual(requests[index].tools, requests[0].tools);
    assert.deepEqual(requests[index].messages.slice(0, requests[index - 1].messages.length), requests[index - 1].messages);
  }
  assert.deepEqual(counts(), { calls: 2, reads: 0 });
});
