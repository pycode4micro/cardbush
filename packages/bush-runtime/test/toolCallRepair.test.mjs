import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryRuntimeHost, ToolRegistry, InMemoryRuntimeEventLog, InMemoryRuntimeCheckpointStore, SessionStore } from '../dist/index.js';

const request = { protocol: 'bush.model_request.v1', requestId: 'repair', sessionId: 'repair', turnId: 'repair',
  model: 'fixture', messages: [{ role: 'system', content: 'Stable rules' }, { role: 'user', content: 'Finish the task' }],
  tools: [], maxOutputTokens: 8192, permissionMode: 'all_free' };
const event = (sequence, kind, fields = {}) => ({ protocol: 'bush.model_event.v1', requestId: 'repair', sequence,
  createdAt: '2026-09-22T00:00:00Z', kind, ...fields });

for (const code of ['provider_tool_call_incomplete', 'provider_tool_call_changed', 'provider_tool_search_invalid', 'incomplete_tool_call']) {
  test(`repairs ${code} once by appending guidance without repeating completed work`, async () => {
    const observed = [];
    let executed = 0;
    const registry = new ToolRegistry().register({
      definition: { name: 'write_once', description: 'Fixture mutation', inputSchema: { type: 'object' } },
      manifest: { effect_kind: 'mutation', operation: 'fixture.write', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: true },
      decodeInput: value => value, execute: () => ({ writes: ++executed }),
    });
    const host = new InMemoryRuntimeHost({ maxAttempts: null, toolRegistry: registry, provider: { async *stream(input) {
      observed.push(structuredClone(input));
      if (observed.length === 1) {
        yield event(0, 'tool_call_delta', { index: 0, toolCallId: 'written', nameDelta: 'write_once', argumentsDelta: '{}' });
        yield event(1, 'response_completed', { finishReason: 'tool_calls' });
      } else if (observed.length === 2) {
        yield event(0, 'text_delta', { delta: 'Checking the result.' });
        yield event(1, 'tool_call_delta', { index: 0, toolCallId: 'rejected', nameDelta: 'write_once', argumentsDelta: '{' });
        yield event(2, 'response_failed', { code, message: 'Invalid call', retryable: false });
      } else {
        assert.equal(observed.length, 3);
        yield event(0, 'text_delta', { delta: 'Finished.' });
        yield event(1, 'response_completed', { finishReason: 'stop' });
      }
    } } });
    try {
      const result = await host.runModelTurn({ ...request, tools: registry.definitions() });
      assert.equal(result.payload.status, 'completed');
      assert.equal(executed, 1);
      const repair = observed[2], previous = observed[1];
      assert.deepEqual(repair.messages.slice(0, previous.messages.length), previous.messages);
      assert.deepEqual(repair.tools, previous.tools);
      assert.equal(repair.maxOutputTokens, previous.maxOutputTokens);
      assert.equal(repair.messages.at(-1).role, 'developer');
      assert.equal(repair.messages.at(-1).name, 'tool_call_repair');
      assert.match(repair.messages.at(-1).content, /No tool from that response was executed/);
      assert.match(repair.messages.at(-1).content, /never repeat completed side effects/);
      assert.equal(repair.messages.at(-2).content, 'Checking the result.');
      assert.deepEqual(repair.messages.at(-2).toolCalls, []);
      assert.ok(!JSON.stringify(repair.messages).includes('rejected'));
      assert.ok(host.events('repair', 'repair').filter(e => e.kind === 'cache_chain_observed').every(e => !e.payload.frozenPrefixBreak));
    } finally { await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); }
  });
}

test('a second invalid repair stops even when transport retries are unlimited', async () => {
  let calls = 0;
  const host = new InMemoryRuntimeHost({ maxAttempts: null, provider: { async *stream() {
    assert.ok(++calls <= 2);
    yield event(0, 'response_failed', { code: 'incomplete_tool_call', message: 'Missing identity', retryable: true });
  } } });
  try {
    const result = await host.runModelTurn(request);
    assert.equal(calls, 2);
    assert.equal(result.payload.reason, 'incomplete_tool_call');
    assert.equal(result.payload.details.repairAttempts, 1);
  } finally { await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); }
});

test('cancellation at a validation failure prevents a corrective request', async () => {
  const controller = new AbortController(); let calls = 0;
  const host = new InMemoryRuntimeHost({ provider: { async *stream() {
    calls++; controller.abort();
    yield event(0, 'response_failed', { code: 'provider_tool_call_incomplete', message: 'Incomplete', retryable: false });
  } } });
  try {
    const result = await host.runModelTurn(request, { signal: controller.signal });
    assert.equal(result.payload.status, 'stopped'); assert.equal(calls, 1);
  } finally { await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); }
});

test('a persisted repair keeps its one-attempt budget and append-only prefix after restart', async t => {
  const journal = [], eventLog = new InMemoryRuntimeEventLog(), checkpoints = new InMemoryRuntimeCheckpointStore();
  const sessions = new SessionStore({ persistence: { load: () => structuredClone(journal), append: value => journal.push(structuredClone(value)) } });
  const controller = new AbortController(); let ready, calls = 0;
  const repairing = new Promise(resolve => { ready = resolve; });
  const first = new InMemoryRuntimeHost({ eventLog, checkpointStore: checkpoints, sessionStore: sessions, registerDefaultWorkspaceTools: false,
    provider: { async *stream() {
      if (++calls === 1) yield event(0, 'response_failed', { code: 'provider_tool_call_incomplete', message: 'Incomplete', retryable: false });
      else { ready(); await new Promise(() => {}); }
    } } });
  t.after(() => first.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const running = first.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: 'repair', sessionId: 'repair', turnId: 'repair',
    model: 'fixture', tools: [], prefixMessages: [request.messages[0]], inputMessages: [{ messageId: 'user', message: request.messages[1] }] }, { signal: controller.signal });
  await repairing;
  const saved = structuredClone(checkpoints.load('repair', 'repair'));
  const savedEvents = structuredClone(eventLog.replay('repair', 'repair')), savedSessions = structuredClone(journal);
  assert.equal(saved.sessionCommit.toolCallRepairAttempts, 1);
  controller.abort(); await running;
  const restored = new InMemoryRuntimeCheckpointStore(); restored.save(saved);
  let retried = 0;
  const second = new InMemoryRuntimeHost({ checkpointStore: restored, maxAttempts: null, registerDefaultWorkspaceTools: false,
    eventLog: new InMemoryRuntimeEventLog({ persistence: { load: () => structuredClone(savedEvents), append: value => savedEvents.push(structuredClone(value)) } }),
    sessionStore: new SessionStore({ persistence: { load: () => structuredClone(savedSessions), append: value => savedSessions.push(structuredClone(value)) } }),
    provider: { async *stream(input) {
      assert.equal(++retried, 1);
      assert.deepEqual(input.messages, saved.request.messages);
      yield event(0, 'response_failed', { code: 'incomplete_tool_call', message: 'Invalid again', retryable: true });
    } } });
  t.after(() => second.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const result = await second.resumeModelTurn('repair', 'repair');
  assert.equal(result.payload.reason, 'incomplete_tool_call');
  assert.equal(result.payload.details.repairAttempts, 1);
  assert.ok(second.events('repair', 'repair').filter(event => event.kind === 'cache_chain_observed').every(event => !event.payload.frozenPrefixBreak));
});
