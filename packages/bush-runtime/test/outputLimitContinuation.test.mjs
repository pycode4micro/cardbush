import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryRuntimeHost, ToolRegistry } from '../dist/index.js';

const request = { protocol: 'bush.model_request.v1', requestId: 'limit', sessionId: 'limit', turnId: 'limit',
  model: 'fixture', messages: [{ role: 'user', content: 'Finish the task' }], tools: [], maxOutputTokens: 8192 };
const event = (sequence, kind, fields = {}) => ({ protocol: 'bush.model_event.v1', requestId: 'limit', sequence,
  createdAt: '2026-09-06T00:00:00Z', kind, ...fields });

for (const output of ['reasoning_delta', 'text_delta', 'partial_tool', 'missing_tool_identity']) {
  test(`continues ${output} truncation with a developer instruction and unchanged limits`, async () => {
    const observed = [];
    const host = new InMemoryRuntimeHost({ provider: { async *stream(input) {
      observed.push(input);
      yield event(0, 'response_started');
      if (observed.length === 1) {
        yield output === 'partial_tool' || output === 'missing_tool_identity'
          ? event(1, 'tool_call_delta', { index: 0, ...(output === 'partial_tool' ? { toolCallId: 'partial', nameDelta: 'never_execute' } : {}), argumentsDelta: '{"x":' })
          : event(1, output, { delta: 'partial work' });
        yield event(2, 'response_completed', { finishReason: 'length' });
      } else {
        yield event(1, 'text_delta', { delta: 'Complete final answer' });
        yield event(2, 'response_completed', { finishReason: 'stop' });
      }
    } } });
    const terminal = await host.runModelTurn(request);
    assert.equal(terminal.payload.status, 'completed');
    assert.equal(observed.length, 2);
    assert.equal(observed[1].maxOutputTokens, 8192);
    assert.equal(observed[1].messages.at(-1).role, 'developer');
    assert.equal(observed[1].messages.at(-1).name, 'output_limit_continuation');
    assert.ok(observed[1].messages.filter(m => m.role === 'assistant').every(m => m.toolCalls.length === 0));
    assert.equal(host.events('limit', 'limit').filter(e => e.kind === 'tool_running').length, 0);
  });
}

test('stops after two unsuccessful continuations instead of looping forever', async () => {
  let calls = 0;
  const host = new InMemoryRuntimeHost({ provider: { async *stream() {
    calls++;
    yield event(0, 'reasoning_delta', { delta: 'Still reasoning' });
    yield event(1, 'response_completed', { finishReason: 'length' });
  } } });
  const terminal = await host.runModelTurn(request);
  assert.equal(calls, 3);
  assert.equal(terminal.payload.reason, 'model_output_limit_exceeded');
  assert.equal(terminal.payload.details.continuationAttempts, 2);
});

test('continuation preserves prior tool results without repeating the side effect', async () => {
  let executed = 0;
  let calls = 0;
  const observed = [];
  const registry = new ToolRegistry().register({
    definition: { name: 'write_once', description: 'Fixture mutation', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'mutation', operation: 'fixture.write', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: true },
    decodeInput: value => value, execute: () => ({ writes: ++executed }),
  });
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, provider: { async *stream(input) {
    calls++; observed.push(input);
    if (calls === 1) {
      yield event(0, 'tool_call_delta', { index: 0, toolCallId: 'written', nameDelta: 'write_once', argumentsDelta: '{}' });
      yield event(1, 'response_completed', { finishReason: 'tool_calls' });
    } else if (calls === 2) {
      yield event(0, 'reasoning_delta', { delta: 'Inspect the saved result' });
      yield event(1, 'response_completed', { finishReason: 'length' });
    } else {
      yield event(0, 'text_delta', { delta: 'Done' });
      yield event(1, 'response_completed', { finishReason: 'stop' });
    }
  } } });
  const terminal = await host.runModelTurn({ ...request, tools: registry.definitions(), permissionMode: 'all_free' });
  assert.equal(terminal.payload.status, 'completed');
  assert.equal(executed, 1);
  assert.ok(observed[2].messages.some(m => m.role === 'tool' && m.content.includes('writes')));
});

test('user cancellation at the continuation boundary prevents another model call', async () => {
  const controller = new AbortController();
  let calls = 0;
  const host = new InMemoryRuntimeHost({ provider: { async *stream() {
    calls++;
    yield event(0, 'reasoning_delta', { delta: 'partial' });
    yield event(1, 'response_completed', { finishReason: 'length' });
    controller.abort();
  } } });
  const terminal = await host.runModelTurn(request, { signal: controller.signal });
  assert.equal(terminal.payload.status, 'stopped');
  assert.equal(calls, 1);
});
