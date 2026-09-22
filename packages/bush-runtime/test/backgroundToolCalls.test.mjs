import test from 'node:test';
import assert from 'node:assert/strict';
import { BackgroundToolCalls } from '../dist/backgroundToolCalls.js';
import { InMemoryRuntimeHost, ToolRegistry, ToolExecutionCoordinator, registerMcpDiscovery, synchronizeMcpDiscovery } from '../dist/index.js';

const manifest = { effect_kind: 'observation', operation: 'fixture', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: false };
const remoteName = 'mcp__fixture__wait';
function remote(registry, execute, authorize) {
  registry.register({ definition: { name: remoteName, description: 'Wait for a signal', inputSchema: { type: 'object' } },
    manifest, decodeInput: value => value, execute, authorize,
    mcpHook: { server: 'fixture', tool: 'wait', readOnly: true, call: async () => ({}) } });
}
function* response(request, call, text = 'done') {
  const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
  yield { ...base, sequence: 0, kind: 'response_started' };
  if (call) yield { ...base, sequence: 1, kind: 'tool_call_delta', index: 0, toolCallId: crypto.randomUUID(), nameDelta: call.name, argumentsDelta: JSON.stringify(call.args) };
  else yield { ...base, sequence: 1, kind: 'text_delta', delta: text };
  yield { ...base, sequence: 2, kind: 'response_completed', finishReason: call ? 'tool_calls' : 'stop' };
}

test('background MCP waiting permits independent work, renews without model polling and delivers once', async () => {
  const registry = new ToolRegistry(); let attempts = 0, parentWorked = false, complete = false, rounds = 0, delivered;
  remote(registry, async () => {
    attempts++;
    if (attempts < 3) return { structuredContent: { status: 'timeout' } };
    assert.equal(parentWorked, true); complete = true;
    return { structuredContent: { status: 'messages', text: 'external message' } };
  });
  registry.register({ definition: { name: 'independent', inputSchema: { type: 'object' } }, manifest, decodeInput: v => v,
    execute: () => { assert.equal(complete, false); parentWorked = true; return { done: true }; } });
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, provider: { async *stream(request) {
    rounds++;
    if (rounds === 1) yield* response(request, { name: 'mcp_search', args: { action: 'load', query: remoteName } });
    else if (rounds === 2) yield* response(request, { name: 'start_mcp_tool', args: { name: remoteName, arguments: {}, max_wait_ms: 3000, repeat_while: { path: ['structuredContent', 'status'], equals: 'timeout' } } });
    else if (rounds === 3) yield* response(request, { name: 'independent', args: {} });
    else { delivered = request.messages.filter(m => m.name === 'background_tool_result'); yield* response(request); }
  } } });
  const terminal = await host.runModelTurn({ protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture',
    messages: [{ role: 'user', content: 'wait and keep working' }], tools: registry.definitions() });
  assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal));
  assert.equal(attempts, 3); assert.equal(rounds, 5); assert.equal(delivered.length, 1);
  assert.equal(delivered[0].visibility, 'internal'); assert.match(delivered[0].content, /external message/);
});

async function fixture(execute, extra = {}) {
  const registry = new ToolRegistry(); registerMcpDiscovery(registry); remote(registry, execute, extra.authorize);
  const completions = []; const jobs = new BackgroundToolCalls(registry, (_s, _t, id, promise) => completions.push({ id, promise })); jobs.register();
  const request = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture', tools: registry.definitions(), metadata: { mcpToolDiscovery: true } };
  const messages = [];
  const load = registry.resolve('mcp_search');
  const receipt = await load.execute({ input: load.decodeInput({ action: 'load', query: remoteName }), turn: { request, contextMessages: [] } });
  messages.push({ role: 'assistant', content: '', toolCalls: [{ id: 'load', name: 'mcp_search', argumentsText: '{}' }] }, { role: 'tool', toolCallId: 'load', content: JSON.stringify(receipt) });
  synchronizeMcpDiscovery(registry, request, messages);
  const controller = new AbortController();
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: async () => { throw Error('unexpected approval'); } }, ...extra.coordinator });
  const run = (name, args, overrides = {}) => coordinator.execute({ protocol: 'bush.tool_call.v1', id: crypto.randomUUID(), name, argumentsText: JSON.stringify(args) },
    { requestId: 'r', sessionId: 's', turnId: 't', round: 1, ordinal: 0, ...overrides }, undefined,
    { request, contextMessages: messages, signal: controller.signal });
  return { registry, jobs, run, completions, controller };
}

test('cancel and turn abort stop pending requests; another turn cannot manage them', async () => {
  let cancellations = 0;
  const f = await fixture(({ signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => { cancellations++; reject(new DOMException('cancelled', 'AbortError')); }, { once: true })));
  const started = await f.run('start_mcp_tool', { name: remoteName, arguments: {} });
  await new Promise(resolve => setTimeout(resolve, 10));
  const id = started.result.task_id;
  const foreign = await f.run('manage_tool_calls', { action: 'cancel', task_ids: [id] }, { sessionId: 'other' });
  assert.equal(foreign.kind, 'failed'); assert.equal(cancellations, 0);
  await f.run('manage_tool_calls', { action: 'cancel', task_ids: [id] });
  assert.match((await f.completions[0].promise).content, /cancelled/);
  await f.run('start_mcp_tool', { name: remoteName, arguments: {} });
  await new Promise(resolve => setTimeout(resolve, 10)); f.controller.abort();
  assert.match((await f.completions[1].promise).content, /cancelled/);
  assert.equal(cancellations, 2); f.jobs.endTurn('s', 't');
});

test('read-only hints do not bypass authorization, hooks or input errors, and failures are never renewed', async () => {
  let executed = 0;
  const denied = await fixture(() => { executed++; return {}; }, { authorize: () => ({ kind: 'deny', code: 'denied', message: 'permission denied' }) });
  await denied.run('start_mcp_tool', { name: remoteName, arguments: {}, repeat_while: { path: ['structuredContent', 'status'], equals: 'timeout' } });
  assert.match((await denied.completions[0].promise).content, /permission denied/); assert.equal(executed, 0);
  const hooked = await fixture(() => ({ structuredContent: { status: 'timeout' } }), { coordinator: { hooks: {
    before: async () => ({ messages: [] }), after: async () => ({ messages: ['stop feedback'], stopTurn: 'stop now' }),
  } } });
  await hooked.run('start_mcp_tool', { name: remoteName, arguments: {} });
  await hooked.completions[0].promise; assert.equal(hooked.jobs.stopReason('s', 't'), 'stop now');
  const budget = await fixture(() => ({ structuredContent: { status: 'timeout' } }));
  await budget.run('start_mcp_tool', { name: remoteName, arguments: {}, max_wait_ms: 150, repeat_while: { path: ['structuredContent', 'status'], equals: 'timeout' } });
  assert.match((await budget.completions[0].promise).content, /"status":"timeout"/);
});
