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
  const completions = []; const jobs = new BackgroundToolCalls(registry, (_s, _t, id, promise) => completions.push({ id, promise }), undefined, extra.hasGuidance); jobs.register();
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
  return { registry, jobs, run, completions, controller, request };
}

test('a bounded wait yields to independent work without cancelling or duplicating the background call', async t => {
  let release, calls = 0, signal;
  const f = await fixture(context => { calls++; signal = context.signal; return new Promise(resolve => { release = resolve; }); });
  t.after(() => f.jobs.endTurn('s', 't'));
  const started = await f.run('start_mcp_tool', { name: remoteName, arguments: {} });
  assert.match(started.result.next_step, /Continue independent work/);
  const yielded = await f.run('manage_tool_calls', { action: 'wait', yield_time_ms: 10 });
  assert.equal(yielded.result.wake_reason, 'yield_timeout');
  assert.equal(yielded.result.tasks[0].status, 'running');
  assert.equal(signal.aborted, false);
  // The model can execute another tool after the wait receipt, while the same job is pending.
  f.registry.register({ definition: { name: 'independent', inputSchema: { type: 'object' } }, manifest,
    decodeInput: v => v, execute: () => { assert.equal(signal.aborted, false); release({ structuredContent: { text: 'ready' } }); return 'worked'; } });
  f.request.tools = f.registry.definitions();
  assert.equal((await f.run('independent', {})).result, 'worked');
  const completed = await f.run('manage_tool_calls', { action: 'wait', task_ids: [started.result.task_id] });
  assert.equal(completed.result.wake_reason, 'task_completed');
  assert.equal(calls, 1);
  assert.equal(f.completions.length, 1);
});

test('new and already queued user guidance wake observers without stopping the job', async t => {
  let release, queued = false, signal;
  const f = await fixture(context => { signal = context.signal; return new Promise(resolve => { release = resolve; }); }, { hasGuidance: () => queued });
  t.after(() => f.jobs.endTurn('s', 't'));
  await f.run('start_mcp_tool', { name: remoteName, arguments: {} });
  const waiting = f.run('manage_tool_calls', { action: 'wait', yield_time_ms: 30_000 });
  await new Promise(resolve => setImmediate(resolve));
  queued = true;
  f.jobs.wakeForGuidance('s', 't');
  assert.equal((await waiting).result.wake_reason, 'user_message');
  assert.equal((await f.run('manage_tool_calls', { action: 'wait' })).result.wake_reason, 'user_message');
  assert.equal(signal.aborted, false);
  queued = false; release({ structuredContent: { text: 'finished' } });
  assert.match((await f.completions[0].promise).content, /finished/);
});

test('user guidance resumes the model from an implicit join; pending work then completes exactly once', { timeout: 5000 }, async t => {
  let release, jobSignal, waiting, wake;
  const joining = new Promise(resolve => { waiting = resolve; });
  const registry = new ToolRegistry(); let rounds = 0, handledGuidance = false;
  remote(registry, ({ signal }) => { jobSignal = signal; return new Promise(resolve => { release = resolve; }); });
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, provider: { async *stream(request) {
    rounds++;
    if (rounds === 1) yield* response(request, { name: 'mcp_search', args: { action: 'load', query: remoteName } });
    else if (rounds === 2) yield* response(request, { name: 'start_mcp_tool', args: { name: remoteName, arguments: {} } });
    else if (rounds === 3) { yield* response(request); setImmediate(waiting); }
    else if (rounds === 4) {
      assert.equal(jobSignal.aborted, false);
      assert.equal(request.messages.filter(m => m.content === 'do this independent step first').length, 1);
      handledGuidance = true;
      release({ structuredContent: { text: 'final background result' } });
      yield* response(request);
    } else {
      assert.equal(handledGuidance, true);
      assert.equal(request.messages.filter(m => m.name === 'background_tool_result').length, 1);
      yield* response(request);
    }
  } } });
  const controller = new AbortController();
  t.after(() => controller.abort());
  const turn = host.runModelTurn({ protocol: 'bush.model_request.v1', requestId: 'wake-r', sessionId: 'wake-s', turnId: 'wake-t', model: 'fixture',
    messages: [{ role: 'user', content: 'wait and work' }], tools: registry.definitions() }, { signal: controller.signal });
  await joining;
  wake = await host.sendCommand({ kind: 'runtime.enqueue_guidance', payload: {
    protocol: 'bush.runtime_guidance.v1', sessionId: 'wake-s', turnId: 'wake-t', messageId: 'wake-guidance',
    content: 'do this independent step first', createdAt: new Date().toISOString(), mode: 'append_context', metadata: {},
  } });
  assert.equal(wake.accepted, true);
  assert.equal((await turn).payload.status, 'completed');
  assert.equal(rounds, 5);
});

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
