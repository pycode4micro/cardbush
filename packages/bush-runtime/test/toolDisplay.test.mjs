import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeToolLoop, ToolRegistry, ToolExecutionStore, InMemoryRuntimeEventLog, registerMcpDiscovery, synchronizeMcpDiscovery } from '../dist/index.js';
import { modelToolDefinitions } from '../dist/mcpToolDiscovery.js';
import { withToolDisplayTitle, toolCallDisplay } from '../dist/toolDisplay.js';
import { toolExecutionRecordSchema, toolExecutionSummarySchema } from '../../bush-protocol/dist/index.js';

const identity = { requestId: 'r', sessionId: 's', turnId: 't' };
const manifest = { effect_kind: 'observation', operation: 'fixture', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: false };
const call = (id, name, input) => ({ protocol: 'bush.tool_call.v1', id, name, argumentsText: JSON.stringify(input) });
const definition = { name: 'read_fixture', description: 'Read fixture', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } };
const strictInput = input => { assert.deepEqual(Object.keys(input), ['path']); return input; };

test('display schema is optional, immutable, idempotent and frozen across rounds', () => {
  const registry = new ToolRegistry();
  registry.register({ definition, manifest, decodeInput: strictInput, execute: () => ({}) });
  const original = structuredClone(registry.definitions());
  const request = { ...identity, tools: registry.definitions(), metadata: {} };
  const first = modelToolDefinitions(registry, request);
  assert.equal(first[0].inputSchema.properties._display_title.type, 'string');
  assert.deepEqual(first[0].inputSchema.required, ['path']);
  assert.deepEqual(registry.definitions(), original, 'native schemas must stay untouched');
  assert.deepEqual(request.tools, original);
  assert.deepEqual(first.map(withToolDisplayTitle), first);
  request.tools = first;
  request.messages = [{ role: 'user', content: 'next' }];
  assert.deepEqual(modelToolDefinitions(registry, request), first, 'no per-round schema changes to the cache prefix');
});

for (const title of ['核对产品资料', undefined, '', null, { reason: 'not a title' }, '  核对\n产品资料\u202e  ', '界'.repeat(500)]) {
  test(`title is presentation only, including invalid/long values: ${String(title).slice(0, 25)}`, async () => {
    const registry = new ToolRegistry(), store = new ToolExecutionStore(), eventLog = new InMemoryRuntimeEventLog();
    let executions = 0, before = 0, after = 0, authorizations = 0;
    registry.register({ definition, manifest, decodeInput: strictInput,
      authorize: context => { authorizations++; strictInput(context.input); strictInput(JSON.parse(context.toolCall.argumentsText)); return { kind: 'allow' }; },
      execute: context => { executions++; strictInput(context.input); strictInput(JSON.parse(context.toolCall.argumentsText)); return { taskId: 'job-1', state: 'queued' }; },
    });
    const toolCall = call('one', definition.name, { path: '/fixture', ...(title === undefined ? {} : { _display_title: title }) });
    const raw = JSON.stringify(toolCall);
    const loop = new RuntimeToolLoop({ registry, executionStore: store, eventLog, identity, hooks: {
      before: async context => { before++; strictInput(context.input); return { messages: [] }; },
      after: async context => { after++; strictInput(context.input); return { messages: [] }; },
    } });
    const result = await loop.execute([toolCall], { round: 1, assistantMessageId: 'a' });
    assert.equal(JSON.stringify(toolCall), raw, 'assistant tool-call history must remain byte-for-byte unchanged');
    assert.deepEqual([executions, authorizations, before, after], [1, 1, 1, 1]);
    assert.deepEqual(JSON.parse(result.messages[0].content), { taskId: 'job-1', state: 'queued' }, 'do not change native model receipts or invent completion');
    const expected = toolCallDisplay(toolCall, definition);
    for (const event of eventLog.replay('s', 't').filter(e => e.kind.startsWith('tool_'))) assert.deepEqual(event.payload.display, expected);
    const record = store.get('s', 't', 'one');
    assert.deepEqual(toolExecutionRecordSchema.parse(record).display, expected);
    assert.deepEqual(toolExecutionSummarySchema.parse(store.listTurnSummaries('s', 't')[0]).display, expected);
    const reloaded = new ToolExecutionStore({ persistence: { load: () => [JSON.parse(JSON.stringify(record))], append() {} } });
    assert.deepEqual(reloaded.listTurnSummaries('s', 't')[0].display, expected, 'restarts and compact cloud history retain the same title');
    assert.ok(!expected || Array.from(expected.title).length <= 80);
  });
}

test('MCP gateway title stays on its single receipt and never reaches strict native arguments', async () => {
  const registry = new ToolRegistry(), store = new ToolExecutionStore(), eventLog = new InMemoryRuntimeEventLog();
  const name = 'mcp__fixture__read'; let calls = 0;
  registerMcpDiscovery(registry);
  registry.register({ definition: { ...definition, name }, manifest, decodeInput: strictInput,
    mcpHook: { server: 'fixture', tool: 'read', call: async () => ({}) },
    execute: context => { strictInput(context.input); calls++; return { found: true }; },
  });
  const request = { ...identity, tools: registry.definitions(), metadata: { mcpToolDiscovery: true } }, messages = [];
  const receipt = await registry.resolve('mcp_search').execute({ input: { action: 'load', query: name }, turn: { request, contextMessages: messages } });
  assert.deepEqual(receipt.matches[0].inputSchema, definition.inputSchema, 'discovery receipts and their revisions keep the native schema');
  messages.push({ role: 'assistant', content: '', toolCalls: [call('load', 'mcp_search', { query: name })] }, { role: 'tool', toolCallId: 'load', content: JSON.stringify(receipt) });
  synchronizeMcpDiscovery(registry, request, messages);
  const loop = new RuntimeToolLoop({ registry, executionStore: store, eventLog, identity });
  const toolCall = call('outer', 'mcp_call', { name, arguments: { path: '/fixture' }, _display_title: '检索部门资料' });
  await loop.execute([toolCall], { round: 1, assistantMessageId: 'a', request, contextMessages: messages });
  const events = eventLog.replay('s', 't').filter(e => e.kind.startsWith('tool_'));
  assert.deepEqual([...new Set(events.map(e => e.payload.toolCallId))], ['outer']);
  for (const event of events) assert.equal(event.payload.display.title, '检索部门资料');
  assert.equal(store.listTurnSummaries('s', 't')[0].display.title, '检索部门资料');
  assert.equal(calls, 1);
});

test('business fields and composite native schemas cannot be overwritten by host metadata', async () => {
  const checkpoint = { ...definition, name: 'checkpoint_context' };
  assert.deepEqual(withToolDisplayTitle(checkpoint), checkpoint, 'strict context maintenance must keep its own exchange schema');
  for (const schema of [
    { type: 'object', properties: { _display_title: { type: 'number' } }, required: ['_display_title'] },
    { type: 'object', allOf: [{ properties: { path: { type: 'string' } }, additionalProperties: false }] },
    { $ref: '#/$defs/input', $defs: { input: { type: 'object' } } },
  ]) {
    const native = { ...definition, inputSchema: schema };
    assert.deepEqual(withToolDisplayTitle(native), native);
    assert.equal(toolCallDisplay(call('one', native.name, { _display_title: 12 }), native), undefined);
  }
  const registry = new ToolRegistry(), eventLog = new InMemoryRuntimeEventLog(); let seen;
  registry.register({ definition: { ...definition, inputSchema: { type: 'object', properties: { _display_title: { type: 'number' } } } }, manifest,
    decodeInput: x => x, execute: ({ input }) => { seen = input; return {}; } });
  await new RuntimeToolLoop({ registry, eventLog, identity }).execute([call('business', definition.name, { _display_title: 12 })], { round: 1, assistantMessageId: 'a' });
  assert.deepEqual(seen, { _display_title: 12 });
});

for (const kind of ['failed', 'cancelled']) test(`${kind} receipts retain the action title`, async () => {
  const registry = new ToolRegistry(), store = new ToolExecutionStore(), eventLog = new InMemoryRuntimeEventLog();
  registry.register({ definition, manifest, decodeInput: strictInput, execute: () => { throw kind === 'cancelled' ? new DOMException('stopped', 'AbortError') : Error('fixture failure'); } });
  await new RuntimeToolLoop({ registry, executionStore: store, eventLog, identity }).execute([call('one', definition.name, { path: '/fixture', _display_title: '核对产品资料' })], { round: 1, assistantMessageId: 'a' });
  assert.equal(store.get('s', 't', 'one').outcome, kind);
  assert.equal(eventLog.replay('s', 't').at(-1).payload.display.title, '核对产品资料');
});
