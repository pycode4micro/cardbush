import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryRuntimeHost, ToolRegistry, InMemoryRuntimeCheckpointStore, InMemoryRuntimeEventLog, SessionStore } from '../dist/index.js';

const request = { protocol: 'bush.model_request.v1', requestId: 'limit', sessionId: 'limit', turnId: 'limit',
  model: 'fixture', messages: [{ role: 'user', content: 'Finish the task' }], tools: [], maxOutputTokens: 8192 };
const event = (sequence, kind, fields = {}) => ({ protocol: 'bush.model_event.v1', requestId: 'limit', sequence,
  createdAt: '2026-09-06T00:00:00Z', kind, ...fields });

for (const output of ['reasoning_delta', 'text_delta', 'partial_tool', 'missing_tool_identity']) {
  test(`stops ${output} truncation without retrying when no complete call is confirmed`, async () => {
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
    assert.equal(terminal.payload.reason, 'model_output_limit_exceeded');
    assert.equal(terminal.payload.details.maxOutputTokens, 8192);
    assert.equal(observed.length, 1);
    assert.equal(host.events('limit', 'limit').filter(e => e.kind === 'provider_retry').length, 0);
    assert.equal(host.events('limit', 'limit').filter(e => e.kind === 'tool_running').length, 0);
  });
}

test('stops immediately instead of blindly retrying the same output limit', async () => {
  let calls = 0;
  const host = new InMemoryRuntimeHost({ provider: { async *stream() {
    calls++;
    yield event(0, 'reasoning_delta', { delta: 'Still reasoning' });
    yield event(1, 'response_completed', { finishReason: 'length' });
  } } });
  const terminal = await host.runModelTurn(request);
  assert.equal(calls, 1);
  assert.equal(terminal.payload.reason, 'model_output_limit_exceeded');
  assert.equal(terminal.payload.details.continuationAttempts, 0);
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
  assert.equal(terminal.payload.reason, 'model_output_limit_exceeded');
  assert.equal(executed, 1);
  assert.equal(observed.length, 2);
  assert.ok(observed[1].messages.some(m => m.role === 'tool' && m.content.includes('writes')));
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

const call = (sequence, index, id, args = '{}') => event(sequence, 'tool_call_delta', {
  index, toolCallId: id, nameDelta: 'write_once', argumentsDelta: args,
});
function registry(execute, overrides = {}) {
  return new ToolRegistry().register({
    definition: { name: 'write_once', description: 'Fixture mutation', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'mutation', operation: 'fixture.write', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: true },
    decodeInput: value => value, execute, ...overrides,
  });
}

test('parseable JSON without protocol completion never executes after truncation', async () => {
  const tools = registry(() => assert.fail('Unconfirmed tools cannot execute'));
  const host = new InMemoryRuntimeHost({ toolRegistry: tools, provider: { async *stream() {
    yield call(0, 0, 'unconfirmed');
    yield event(1, 'response_completed', { finishReason: 'length' });
  } } });
  assert.equal((await host.runModelTurn({ ...request, tools: tools.definitions() })).payload.reason, 'model_output_limit_exceeded');
});

test('a call-only truncation persists a failed assistant for cold history without its partial arguments', async () => {
  const sessions = new SessionStore();
  const host = new InMemoryRuntimeHost({ sessionStore: sessions, provider: { async *stream() {
    yield call(0, 0, 'discarded', '{"unfinished":');
    yield event(1, 'response_completed', { finishReason: 'length' });
  } } });
  const result = await host.runSessionTurn({ ...request, protocol: 'bush.session_turn_request.v1',
    inputMessages: [{ messageId: 'u', message: request.messages[0] }] });
  assert.equal(result.payload.reason, 'model_output_limit_exceeded');
  const turn = sessions.snapshot('limit').turns[0];
  const last = turn.messages.at(-1);
  assert.equal(turn.status, 'failed');
  assert.equal(turn.reason, result.payload.reason);
  assert.equal(last.messageId, result.payload.finalMessageId);
  assert.equal(last.message.role, 'assistant');
  assert.equal(last.message.content, '');
  assert.deepEqual(last.message.toolCalls, []);
  assert.doesNotMatch(JSON.stringify(turn.messages), /unfinished|discarded|output_limit_continuation/);
});

test('executes only the confirmed prefix and appends receipts before one short notification', async () => {
  const executed = [], observed = [];
  const tools = registry(({ toolCall }) => { executed.push(toolCall.id); return { saved: toolCall.id }; });
  const host = new InMemoryRuntimeHost({ toolRegistry: tools, provider: { async *stream(input) {
    observed.push(structuredClone(input));
    if (observed.length === 1) {
      yield event(0, 'response_started', { providerResponseId: 'unfinished-response' });
      yield event(1, 'text_delta', { delta: 'Save the parts.' });
      yield call(2, 0, 'a'); yield call(3, 1, 'b'); yield call(4, 2, 'cut', '{"unfinished":');
      yield call(5, 3, 'later');
      yield event(6, 'response_completed', { finishReason: 'length', completedToolCallIndices: [0, 1, 3] });
    } else {
      yield event(0, 'text_delta', { delta: 'Done' });
      yield event(1, 'response_completed', { finishReason: 'stop' });
    }
  } } });
  assert.equal((await host.runModelTurn({ ...request, permissionMode: 'all_free', tools: tools.definitions() })).payload.status, 'completed');
  assert.deepEqual(executed, ['a', 'b']);
  const next = observed[1];
  assert.deepEqual(next.messages.slice(0, observed[0].messages.length), observed[0].messages);
  assert.deepEqual(next.tools, observed[0].tools);
  assert.equal(next.maxOutputTokens, 8192);
  assert.equal(next.providerState.previousResponseId, undefined);
  assert.deepEqual(next.messages.filter(m => m.role === 'assistant').flatMap(m => m.toolCalls.map(c => c.id)), ['a', 'b']);
  assert.deepEqual(next.messages.slice(-3).map(m => m.role), ['tool', 'tool', 'developer']);
  assert.equal(next.messages.at(-1).name, 'output_limit_continuation');
  assert.doesNotMatch(JSON.stringify(next.messages), /unfinished|"later"/);
  assert.ok(host.events('limit', 'limit').filter(e => e.kind === 'cache_chain_observed').every(e => !e.payload.frozenPrefixBreak));
});

test('productive truncated batches continue, but a subsequent zero-progress response stops', async () => {
  const executed = [], observed = [];
  const tools = registry(({ toolCall }) => { executed.push(toolCall.id); return 'saved'; });
  const host = new InMemoryRuntimeHost({ toolRegistry: tools, provider: { async *stream(input) {
    observed.push(structuredClone(input));
    const n = observed.length;
    assert.ok(n <= 5, 'No-progress truncation cannot start another request');
    if (n <= 4) yield call(0, 0, `written-${n}`);
    else yield event(0, 'reasoning_delta', { delta: 'No executable output' });
    yield event(1, 'response_completed', { finishReason: 'length', completedToolCallIndices: n <= 4 ? [0] : [] });
  } } });
  const result = await host.runModelTurn({ ...request, tools: tools.definitions(), permissionMode: 'all_free' });
  assert.equal(result.payload.reason, 'model_output_limit_exceeded');
  assert.equal(observed.length, 5);
  assert.equal(executed.length, 4);
  assert.equal(new Set(executed).size, 4);
  for (let i = 1; i < observed.length; i++) assert.deepEqual(observed[i].messages.slice(0, observed[i - 1].messages.length), observed[i - 1].messages);
});

for (const failure of ['invalid_json', 'invalid_schema', 'permission_denied', 'side_effect_then_error']) {
  test(`confirmed calls retain normal validation, permissions and failure receipts: ${failure}`, async () => {
    const observed = []; let executed = 0;
    const tools = registry(() => { executed++; throw Error('Write happened before this failure'); }, {
      decodeInput: value => { if (failure === 'invalid_schema') throw Error('Invalid fixture schema'); return value; },
      ...(failure === 'permission_denied' ? { authorize: () => ({ kind: 'deny', code: 'fixture_denied', message: 'Not authorized' }) } : {}),
    });
    const host = new InMemoryRuntimeHost({ toolRegistry: tools, provider: { async *stream(input) {
      observed.push(structuredClone(input));
      if (observed.length === 1) {
        yield call(0, 0, 'a', failure === 'invalid_json' ? '{"x":' : '{}');
        yield event(1, 'response_completed', { finishReason: 'length', completedToolCallIndices: [0] });
      } else {
        yield event(0, 'text_delta', { delta: 'Report the failure without repeating the operation' });
        yield event(1, 'response_completed', { finishReason: 'stop' });
      }
    } } });
    await host.runModelTurn({ ...request, tools: tools.definitions(), permissionMode: 'all_free' });
    assert.equal(executed, failure === 'side_effect_then_error' ? 1 : 0);
    assert.ok(observed[1].messages.some(m => m.role === 'tool' && m.content.includes('runtimeError')));
    assert.equal(observed[1].messages.at(-1).name, 'output_limit_continuation');
  });
}

test('cancellation prevents execution of a confirmed truncated batch', async () => {
  const controller = new AbortController();
  const tools = registry(() => assert.fail('Cancelled tools cannot execute'));
  const host = new InMemoryRuntimeHost({ toolRegistry: tools, provider: { async *stream() {
    yield call(0, 0, 'a');
    yield event(1, 'response_completed', { finishReason: 'length', completedToolCallIndices: [0] });
    controller.abort();
  } } });
  assert.equal((await host.runModelTurn({ ...request, tools: tools.definitions() }, { signal: controller.signal })).payload.status, 'stopped');
});

test('restart resumes from saved truncated-batch receipts without repeating completed side effects', async t => {
  let executed = 0, calls = 0, started;
  const ready = new Promise(resolve => { started = resolve; });
  const checkpoints = new InMemoryRuntimeCheckpointStore();
  const eventLog = new InMemoryRuntimeEventLog();
  const sessionJournal = [];
  const sessions = new SessionStore({ persistence: { load: () => structuredClone(sessionJournal), append: event => sessionJournal.push(structuredClone(event)) } });
  const controller = new AbortController();
  const tools = registry(() => ({ writes: ++executed }));
  const first = new InMemoryRuntimeHost({ checkpointStore: checkpoints, eventLog, sessionStore: sessions, toolRegistry: tools,
    registerDefaultWorkspaceTools: false, provider: { async *stream() {
      if (++calls === 1) {
        yield call(0, 0, 'saved'); yield call(1, 1, 'discarded', '{"x":');
        yield event(2, 'response_completed', { finishReason: 'length', completedToolCallIndices: [0] });
      } else { started(); await new Promise(() => {}); }
    } } });
  t.after(() => first.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const running = first.runSessionTurn({ ...request, protocol: 'bush.session_turn_request.v1', permissionMode: 'all_free',
    tools: tools.definitions(), inputMessages: [{ messageId: 'u', message: request.messages[0] }] }, { signal: controller.signal });
  await ready;
  const saved = structuredClone(checkpoints.load('limit', 'limit'));
  const savedEvents = structuredClone(eventLog.replay('limit', 'limit'));
  const savedSessions = structuredClone(sessionJournal);
  assert.equal(executed, 1);
  assert.equal(saved.request.messages.at(-1).name, 'output_limit_continuation');
  assert.doesNotMatch(JSON.stringify(saved.request.messages), /discarded/);
  controller.abort(); await running;

  const restored = new InMemoryRuntimeCheckpointStore(); restored.save(saved);
  const restoredSessions = new SessionStore({ persistence: { load: () => savedSessions, append: event => savedSessions.push(structuredClone(event)) } });
  const restoredLog = new InMemoryRuntimeEventLog({ persistence: { load: () => savedEvents, append: event => savedEvents.push(structuredClone(event)) } });
  const seen = [];
  const second = new InMemoryRuntimeHost({ checkpointStore: restored, eventLog: restoredLog, sessionStore: restoredSessions,
    toolRegistry: registry(() => assert.fail('Previously completed tools cannot be replayed')), registerDefaultWorkspaceTools: false,
    provider: { async *stream(input) {
      seen.push(structuredClone(input));
      yield event(0, 'text_delta', { delta: 'Verified saved result' });
      yield event(1, 'response_completed', { finishReason: 'stop' });
    } } });
  t.after(() => second.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const result = await second.sendCommand({ kind: 'runtime.resume_model_turn', payload: { sessionId: 'limit', turnId: 'limit' } });
  assert.equal(result.payload.status, 'completed');
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].messages, saved.request.messages);
  assert.ok(seen[0].messages.some(message => message.role === 'tool' && message.toolCallId === 'saved'));
  assert.equal(restoredSessions.snapshot('limit').turns[0].messages.filter(message => message.message.role === 'tool').length, 1);
});
