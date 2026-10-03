import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryRuntimeHost, ToolRegistry } from '../dist/index.js';
import { RuntimeEventProjector } from '../dist/runtimeEventProjector.js';
import { InMemoryRuntimeEventLog } from '../dist/runtimeEventLog.js';

const now = '2026-10-03T00:00:00.000Z';
const request = () => ({ protocol: 'bush.session_turn_request.v1', requestId: 'request', sessionId: 'session', turnId: 'turn', model: 'fixture',
  prefixMessages: [{ role: 'system', content: 'Stable context' }],
  inputMessages: [{ messageId: 'user', createdAt: now, message: { role: 'user', content: 'Original task' } }], tools: [], metadata: {} });
const event = (id, sequence, kind, values = {}) => ({ protocol: 'bush.model_event.v1', requestId: id, sequence, createdAt: now, kind, ...values });
const guide = (host, id = 'guide', mode = 'interrupt_and_continue') => host.sendCommand({ kind: 'runtime.enqueue_guidance', payload: {
  protocol: 'bush.runtime_guidance.v1', sessionId: 'session', turnId: 'turn', messageId: id, content: `Correction ${id}`, createdAt: now, ...(mode ? { mode } : {}),
} });
const facts = host => host.events('session', 'turn');
const snapshot = host => host.sendCommand({ kind: 'runtime.get_session', payload: { sessionId: 'session' } });
const waitFor = async predicate => { const deadline = Date.now() + 2500; while (!predicate()) {
  if (Date.now() > deadline) throw Error('Timed out waiting for continuation'); await new Promise(resolve => setTimeout(resolve, 5));
} };

for (const stage of ['waiting', 'reasoning', 'text', 'partial-tool']) test(`immediate guidance interrupts ${stage}, ignores late provider events and stays in the same Turn`, { timeout: 6000 }, async t => {
  const old = Promise.withResolvers(), finish = Promise.withResolvers(); const requests = [], signals = []; let options;
  const host = new InMemoryRuntimeHost({ provider: { async *stream(input, streamOptions) {
    requests.push(structuredClone(input)); signals.push(streamOptions.signal);
    const index = requests.length;
    if (index === 1) {
      options = streamOptions;
      yield event(input.requestId, 0, 'response_started', { providerResponseId: 'cancelled-response' });
      if (stage === 'reasoning') yield event(input.requestId, 1, 'reasoning_delta', { delta: 'Unfinished reasoning' });
      if (stage === 'text') yield event(input.requestId, 1, 'text_delta', { delta: 'Already visible.' });
      if (stage === 'partial-tool') yield event(input.requestId, 1, 'tool_call_delta', { index: 0, toolCallId: 'never-run', nameDelta: 'unknown', argumentsDelta: '{"partial":' });
      await old.promise; // Deliberately ignores AbortSignal, as a faulty adapter could.
      yield event(input.requestId, 2, 'text_delta', { delta: 'STALE OUTPUT' });
      yield event(input.requestId, 3, 'response_completed', { finishReason: 'stop' });
    } else {
      await finish.promise;
      yield event(input.requestId, 0, 'text_delta', { delta: 'Updated answer' });
      yield event(input.requestId, 1, 'response_completed', { finishReason: 'stop' });
    }
  } } });
  const running = host.runSessionTurn(request());
  t.after(async () => { old.resolve(); finish.resolve(); await running; });
  await waitFor(() => requests.length === 1);
  const receipt = await guide(host); assert.equal(receipt.modelRequestInterrupted, true);
  await guide(host, 'second'); await guide(host); // Burst messages, then transport retry.
  await waitFor(() => requests.length === 2);
  assert.equal(signals[0].aborted, true); assert.equal(signals[1].aborted, false);
  assert.deepEqual(requests[1].messages.filter(m => m.name === 'turn_guidance').map(m => m.content), ['Correction guide', 'Correction second']);
  assert.equal(requests[1].providerState.previousResponseId, undefined);
  assert.equal(requests[1].messages.some(m => m.reasoningContent || m.providerReplay || m.toolCalls?.length), false);
  await guide(host); assert.equal(signals[1].aborted, false, 'retrying applied guidance cannot interrupt the new request');
  options.onStreamDiagnostic?.({ stage: 'late-diagnostic' });
  old.resolve(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(JSON.stringify(facts(host)).includes('STALE OUTPUT'), false);
  assert.equal(JSON.stringify(facts(host)).includes('late-diagnostic'), false);
  finish.resolve(); assert.equal((await running).payload.status, 'completed');
  assert.equal(facts(host).filter(e => e.kind === 'turn_terminal').length, 1);
  assert.equal(facts(host).filter(e => e.kind.startsWith('tool_')).length, 0);
  assert.equal(facts(host).filter(e => e.kind === 'guidance_applied').length, 2);
  const history = await snapshot(host); assert.equal(history.turns.length, 1);
  assert.equal(history.turns[0].messages.filter(m => m.message.name === 'turn_guidance').length, 2);
  if (stage === 'text') {
    const partial = history.turns[0].messages.find(m => m.message.content === 'Already visible.');
    assert.equal(partial.metadata.interruptedByGuidance, true);
  }
});

for (const mode of [undefined, 'append_context']) test(`ordinary append still waits for the round (${mode ?? 'old client'})`, async t => {
  const release = Promise.withResolvers(); const requests = [], signals = [];
  const host = new InMemoryRuntimeHost({ provider: { async *stream(input, options) {
    requests.push(input); signals.push(options.signal); if (requests.length === 1) await release.promise;
    yield event(input.requestId, 0, 'text_delta', { delta: 'answer' }); yield event(input.requestId, 1, 'response_completed', { finishReason: 'stop' });
  } } });
  const running = host.runSessionTurn(request()); t.after(async () => { release.resolve(); await running; });
  await waitFor(() => requests.length === 1); await guide(host, 'append', mode ?? null);
  assert.equal(signals[0].aborted, false); assert.equal(requests.length, 1);
  release.resolve(); assert.equal((await running).payload.status, 'completed');
  assert.equal(requests.length, 2); assert.equal(requests[1].messages.at(-1).content, 'Correction append');
});

test('guidance does not cancel an in-flight tool or repeat its effect after interrupting the next model request', async t => {
  const releaseTool = Promise.withResolvers(), releaseModel = Promise.withResolvers(); let executions = 0, toolSignal; const requests = [];
  const definition = { name: 'fixture', description: 'Test action', inputSchema: { type: 'object', properties: {} } };
  const registry = new ToolRegistry(); registry.register({
    definition,
    manifest: { effect_kind: 'observation', operation: 'test.read', risk: 'low', owner: 'test', dispatch_scope: 'turn', mutating: false },
    decodeInput: value => value,
    async execute(context) { executions++; toolSignal = context.signal; await releaseTool.promise;
      return { kind: 'returned', result: { content: [{ type: 'text', text: 'Real receipt' }] } }; },
  });
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, provider: { async *stream(input) {
    requests.push(input);
    if (requests.length === 1) yield event(input.requestId, 0, 'tool_call_delta', { index: 0, toolCallId: 'action', nameDelta: 'fixture', argumentsDelta: '{}' });
    else {
      if (requests.length === 2) await releaseModel.promise;
      yield event(input.requestId, 0, 'text_delta', { delta: 'Finished' });
    }
    yield event(input.requestId, 1, 'response_completed', { finishReason: requests.length === 1 ? 'tool_calls' : 'stop' });
  } } });
  const running = host.runSessionTurn({ ...request(), tools: [definition] }); t.after(async () => { releaseTool.resolve(); releaseModel.resolve(); await running; });
  await waitFor(() => executions === 1).catch(error => { throw Error(`${error.message}: ${JSON.stringify(facts(host))}`); });
  assert.equal((await guide(host, 'during-tool')).modelRequestInterrupted, false); assert.equal(toolSignal.aborted, false);
  releaseTool.resolve(); await waitFor(() => requests.length === 2);
  assert.equal(requests[1].messages.at(-1).content, 'Correction during-tool');
  assert.equal(requests[1].messages.filter(m => m.role === 'tool').length, 1);
  await guide(host, 'during-thinking'); assert.equal((await running).payload.status, 'completed');
  assert.equal(requests.length, 3); assert.equal(executions, 1);
  assert.equal(requests[2].messages.filter(m => m.role === 'tool').length, 1);
});

test('an explicit Turn stop wins a race with immediate guidance', async t => {
  const release = Promise.withResolvers(); let calls = 0;
  const host = new InMemoryRuntimeHost({ provider: { async *stream(input) { calls++; await release.promise;
    yield event(input.requestId, 0, 'response_completed', { finishReason: 'stop' }); } } });
  const running = host.runSessionTurn(request()); t.after(async () => { release.resolve(); await running; });
  await waitFor(() => calls === 1); await guide(host);
  await host.sendCommand({ kind: 'runtime.stop_turn', payload: { sessionId: 'session', turnId: 'turn' } });
  assert.equal((await running).payload.status, 'stopped'); assert.equal(calls, 1);
});

test('immediate guidance wakes provider retry backoff instead of waiting or retrying obsolete input', async () => {
  const requests = [];
  const host = new InMemoryRuntimeHost({ maxAttempts: 3, retryDelayMs: () => 30_000, provider: { async *stream(input) {
    requests.push(input);
    if (requests.length === 1) yield event(input.requestId, 0, 'response_failed', { code: 'busy', message: 'Retry later', retryable: true });
    else { yield event(input.requestId, 0, 'text_delta', { delta: 'Corrected' }); yield event(input.requestId, 1, 'response_completed', { finishReason: 'stop' }); }
  } } });
  const running = host.runSessionTurn(request());
  await waitFor(() => facts(host).some(e => e.kind === 'provider_retry'));
  await guide(host); await waitFor(() => requests.length === 2);
  assert.equal((await running).payload.status, 'completed'); assert.equal(requests[1].messages.at(-1).name, 'turn_guidance');
});

test('an interrupted final-intent segment is closed as non-final process text', () => {
  const log = new InMemoryRuntimeEventLog(), identity = { sessionId: 'session', turnId: 'turn', requestId: 'request' };
  const projector = new RuntimeEventProjector(log, identity, { finalResponse: true });
  projector.accept(event('request', 0, 'text_delta', { delta: 'Partial final' })); projector.interrupt();
  const last = log.replay('session', 'turn').at(-1);
  assert.equal(last.kind, 'assistant_segment_completed'); assert.equal(last.payload.finalResponse, false);
});

test('guidance during preflight reaches the first dispatched request instead of stale input', async t => {
  const release = Promise.withResolvers(); let counts = 0; const requests = [];
  const host = new InMemoryRuntimeHost({ provider: {
    async countInputTokens() { if (++counts === 1) await release.promise; return { inputTokens: 100, source: 'provider' }; },
    async *stream(input) { requests.push(input); yield event(input.requestId, 0, 'text_delta', { delta: 'Updated' });
      yield event(input.requestId, 1, 'response_completed', { finishReason: 'stop' }); },
  } });
  const running = host.runSessionTurn({ ...request(), metadata: { contextWindowTokens: 100_000 }, maxOutputTokens: 1000 });
  t.after(async () => { release.resolve(); await running; });
  await waitFor(() => counts === 1); await guide(host); release.resolve();
  assert.equal((await running).payload.status, 'completed'); assert.equal(requests.length, 1);
  assert.equal(requests[0].messages.at(-1).content, 'Correction guide');
});

test('interruption retains reported token usage without accepting a cancelled response as replay', async t => {
  const release = Promise.withResolvers(); let calls = 0;
  const host = new InMemoryRuntimeHost({ provider: { async *stream(input) {
    calls++;
    yield event(input.requestId, 0, 'usage', { inputTokens: 100, outputTokens: calls === 1 ? 12 : 3 });
    if (calls === 1) await release.promise;
    yield event(input.requestId, 1, 'text_delta', { delta: 'Answer' });
    yield event(input.requestId, 2, 'response_completed', { finishReason: 'stop' });
  } } });
  const running = host.runSessionTurn(request()); t.after(async () => { release.resolve(); await running; });
  await waitFor(() => calls === 1); await guide(host); await running;
  const history = await snapshot(host);
  assert.equal(history.turns[0].usage.inputTokens, 200); assert.equal(history.turns[0].usage.outputTokens, 15);
  assert.equal(facts(host).filter(e => e.kind === 'model_request_usage').length, 2);
});

test('guidance in one session never aborts another concurrent model request', async t => {
  const release = Promise.withResolvers(); const signals = new Map(); const counts = new Map();
  const host = new InMemoryRuntimeHost({ provider: { async *stream(input, options) {
    signals.set(input.sessionId, options.signal); const count = (counts.get(input.sessionId) ?? 0) + 1; counts.set(input.sessionId, count);
    if (count === 1) await release.promise;
    yield event(input.requestId, 0, 'text_delta', { delta: 'Answer' }); yield event(input.requestId, 1, 'response_completed', { finishReason: 'stop' });
  } } });
  const one = host.runSessionTurn(request()), two = host.runSessionTurn({ ...request(), sessionId: 'other', requestId: 'other-request' });
  t.after(async () => { release.resolve(); await Promise.all([one, two]); });
  await waitFor(() => signals.size === 2); await guide(host); await one;
  assert.equal(signals.get('other').aborted, false); assert.equal(counts.get('other'), 1);
});
