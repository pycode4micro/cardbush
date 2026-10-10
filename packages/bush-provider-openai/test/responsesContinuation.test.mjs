import assert from 'node:assert/strict';
import test from 'node:test';
import { modelRequestSchema } from '@cardbush/bush-protocol';
import { executeModelRound, InMemoryRuntimeHost, ToolRegistry, registerMcpDiscovery, modelReplayMessageHash } from '@cardbush/bush-runtime';
import { InMemoryProviderCapabilityStore, OpenAIResponsesProvider } from '../dist/index.js';
import { executeBufferedModelRound } from '../../bush-runtime/dist/bufferedModelRetry.js';

const scope = 'continuation-fixture';
const model = 'fixture-model';
const missing = { code: 'InvalidParameter.PreviousResponseNotFound',
  message: 'Previous response with id resp_previous not found.' };
const text = value => ({ type: 'message', id: 'msg', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: value, annotations: [] }] });
const call = id => ({ type: 'function_call', id: `item_${id}`, call_id: id, name: 'inspect', arguments: '{}', status: 'completed' });
const stream = frames => new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join(''),
  { headers: { 'content-type': 'text/event-stream' } });
const rejected = (error = missing, status = 400) => Response.json({ error },
  { status, headers: { 'x-request-id': 'rejected-request' } });
const completed = (body, id, output = [text('Recovered')]) => {
  const response = { id, model: body.model, created_at: 1, store: Boolean(body.store), tools: body.tools, output: [] };
  return stream([{ type: 'response.created', response: { ...response, status: 'in_progress' } },
    { type: 'response.completed', response: { ...response, status: 'completed', output } }]);
};

function fixture(handler) {
  const calls = [];
  const store = new InMemoryProviderCapabilityStore();
  store.observe({ scope, model, capability: 'response_continuation' }, { status: 'supported', reason: 'response_stored' });
  const provider = new OpenAIResponsesProvider({ apiKey: 'fixture', baseURL: 'https://fixture.invalid/v1',
    capabilityScope: scope, capabilityStore: store, fetch: async (url, init) => {
      if (String(url).endsWith('/input_tokens')) return Response.json({ input_tokens: 100 });
      const body = JSON.parse(init.body); calls.push(body);
      return handler(body, calls.length);
    } });
  return { provider, calls, store };
}

const registry = new ToolRegistry(); registerMcpDiscovery(registry);
const priorAssistant = { role: 'assistant', content: 'Inspecting', reasoningContent: 'Preserved reasoning',
  toolCalls: [{ id: 'inspected', name: 'inspect', argumentsText: '{}' }] };
priorAssistant.providerReplay = { format: 'openai.responses.output.v1', model, messageHash: modelReplayMessageHash(priorAssistant),
  data: { toolSearchMode: 'native', items: [
    { type: 'reasoning', id: 'rs_previous', summary: [], encrypted_content: 'opaque-reasoning' }, text('Inspecting'), call('inspected'),
  ] } };
const request = overrides => modelRequestSchema.parse({
  protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model,
  messages: [{ role: 'system', content: 'Stable instructions' }, { role: 'user', content: 'Inspect' },
    priorAssistant,
    { role: 'tool', toolCallId: 'inspected', content: 'Saved tool result',
      images: [{ url: 'data:image/png;base64,aW1hZ2U=', detail: 'high' }] }],
  tools: registry.definitions(), metadata: { mcpToolDiscovery: true }, reasoningEffort: 'high', maxOutputTokens: 8192,
  providerState: { strategy: 'response_chain', previousResponseId: 'resp_previous', inputMessageOffset: 3 },
  ...overrides,
});

test('a missing or expired response replays full local history once without changing model capabilities', async t => {
  for (const [status, error] of [
    [400, missing],
    [404, { code: 'previous_response_not_found', param: 'previous_response_id', message: 'Response is unavailable.' }],
    [400, { code: 'invalid_request_error', param: 'previous_response_id', message: "No response found with id 'resp_previous'." }],
    [400, { code: 'invalid_request_error', message: 'Previous response with id resp_previous has expired.' }],
  ]) await t.test(`${status}: ${error.code}: ${error.message}`, async () => {
    const f = fixture((body, n) => n === 1 ? rejected(error, status) : completed(body, 'resp_recovered'));
    const req = request(); const original = structuredClone(req);
    const diagnostics = [], projections = [], events = [];
    const result = await executeModelRound(f.provider, req, { onCompatibilityDiagnostic: value => diagnostics.push(value),
      onInputProjection: value => projections.push(value), onEvent: value => events.push(value) });
    assert.equal(result.status, 'completed'); assert.equal(result.text, 'Recovered');
    assert.equal(result.providerResponseId, 'resp_recovered');
    assert.deepEqual(req, original, 'recovery cannot modify persisted history or the frozen request');
    assert.equal(f.calls.length, 2);
    const [continued, replayed] = f.calls;
    assert.equal(continued.previous_response_id, 'resp_previous');
    assert.equal(replayed.previous_response_id, undefined); assert.equal(replayed.store, true);
    assert.ok(replayed.input.length > continued.input.length);
    assert.equal(replayed.input[0].content, 'Stable instructions');
    assert.equal(replayed.input.find(item => item.type === 'reasoning').encrypted_content, 'opaque-reasoning');
    assert.ok(replayed.input.some(item => item.type === 'function_call' && item.call_id === 'inspected'));
    assert.deepEqual(replayed.input.at(-1), continued.input.at(-1), 'tool result and image remain intact');
    const { input: _input1, previous_response_id: _id1, ...before } = continued;
    const { input: _input2, ...after } = replayed;
    assert.deepEqual(after, before, 'tools, reasoning, limits and prompt-cache routing must stay unchanged');
    assert.ok(replayed.tools.some(tool => tool.type === 'tool_search'));
    assert.equal(result.providerReplay.data.compatibilityMode, undefined);
    assert.equal(f.store.read({ scope, model, capability: 'responses_generation_compatibility' }).status, 'unknown');
    assert.equal(f.store.read({ scope, model, capability: 'response_continuation' }).status, 'supported');
    assert.deepEqual(diagnostics.map(value => value.action), ['retry', 'recovered']);
    assert.equal(diagnostics[0].error.code, error.code);
    assert.equal(diagnostics[0].error.providerRequestId, 'rejected-request');
    assert.deepEqual(projections.map(value => value.transport), ['continuation', 'full']);
    assert.deepEqual(projections[1].inputDigests, projections[0].inputDigests);
    assert.equal(events.filter(event => event.kind === 'response_started').length, 1);
    assert.deepEqual(events.map(event => event.sequence), events.map((_, i) => i));
  });
});

test('early streamed missing-response errors discard only the pending start before replay', async t => {
  for (const kind of ['error', 'response.failed']) await t.test(kind, async () => {
    const response = { id: 'rejected-response', model, store: true, output: [] };
    const f = fixture((body, n) => n === 1 ? stream([
      { type: 'response.created', response: { ...response, status: 'in_progress' } },
      kind === 'error' ? { type: 'error', ...missing }
        : { type: 'response.failed', response: { ...response, status: 'failed', error: missing } },
    ]) : completed(body, 'new-response'));
    const events = [];
    const result = await executeModelRound(f.provider, request(), { onEvent: event => events.push(event) });
    assert.equal(result.status, 'completed'); assert.equal(f.calls.length, 2);
    assert.equal(result.providerResponseId, 'new-response');
    assert.equal(events.filter(event => event.kind === 'response_started').length, 1);
    assert.deepEqual(events.map(event => event.sequence), events.map((_, i) => i));
  });
});

test('unrelated failures and requests without a continuation are never replayed', async t => {
  for (const [name, status, error, overrides] of [
    ['generic validation', 400, { code: 'invalid_request', message: 'request rejected' }],
    ['wrong parameter', 400, { ...missing, param: 'tools[0].parameters' }],
    ['authentication', 401, missing],
    ['server error', 500, missing],
    ['missing model', 404, { code: 'model_not_found', message: 'Model not found' }],
    ['no previous ID', 400, missing, { providerState: { strategy: 'response_chain' } }],
  ]) await t.test(name, async () => {
    const f = fixture(() => rejected(error, status));
    const result = await executeModelRound(f.provider, request(overrides));
    assert.equal(result.status, 'failed'); assert.equal(f.calls.length, 1);
    assert.equal(result.error.code, error.code);
  });
});

test('a failed full-history retry reports its error and cannot loop', async () => {
  const f = fixture(() => rejected());
  const diagnostics = [];
  const result = await executeModelRound(f.provider, request(), { onCompatibilityDiagnostic: value => diagnostics.push(value) });
  assert.equal(result.status, 'failed'); assert.equal(result.error.code, missing.code);
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].previous_response_id, undefined);
  assert.deepEqual(diagnostics.map(value => value.action), ['retry', 'failed']);
});

test('partial text, reasoning or tool output prevents a hidden replay', async t => {
  for (const frame of [
    { type: 'response.output_text.delta', delta: 'Visible text', item_id: 'msg', output_index: 0 },
    { type: 'response.reasoning_text.delta', delta: 'Visible reasoning', item_id: 'reason', output_index: 0, content_index: 0 },
    { type: 'response.output_item.done', output_index: 0, item: call('visible-call') },
  ]) await t.test(frame.type, async () => {
    const f = fixture(() => stream([frame, { type: 'error', ...missing }]));
    const result = await executeModelRound(f.provider, request());
    assert.equal(result.status, 'failed'); assert.equal(f.calls.length, 1);
  });
});

test('cancellation before recovery does not send a full replay', async () => {
  const controller = new AbortController();
  const f = fixture(() => rejected());
  const result = await executeModelRound(f.provider, request(), { signal: controller.signal,
    onCompatibilityDiagnostic: value => { if (value.action === 'retry') controller.abort(); } });
  assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'request_aborted');
  assert.equal(f.calls.length, 1);
});

test('outer transport retries retain the recovered projection and share its single recovery budget', async t => {
  for (const succeeds of [true, false]) await t.test(succeeds ? 'recovers' : 'exhausts budget', async () => {
    const f = fixture((body, n) => body.previous_response_id ? rejected()
      : succeeds && n === 3 ? completed(body, 'resp_recovered') : rejected({ code: 'server_error', message: 'Unavailable' }, 503));
    const retries = [], waits = [];
    const result = await executeBufferedModelRound(f.provider, request(), { signal: new AbortController().signal,
      wait: async ms => { waits.push(ms); }, onRetry: event => retries.push(event) });
    assert.equal(result.status, succeeds ? 'completed' : 'failed');
    assert.equal(f.calls.length, succeeds ? 3 : 4, 'transport cap plus one shared protocol recovery, never multiplied');
    assert.equal(f.calls.filter(body => body.previous_response_id).length, 1, 'the missing ID cannot return after backoff');
    for (const body of f.calls.slice(2)) assert.deepEqual(body, f.calls[1], 'the recovered wire input stays frozen');
    assert.deepEqual(retries.map(event => [event.attempt, event.providerAttempts, event.recoveryAttempts]),
      succeeds ? [[2, 2, 1]] : [[2, 2, 1], [3, 3, 1]]);
    assert.deepEqual(waits, succeeds ? [1000] : [1000, 2000]);
  });
});

test('different wire recovery actions share one budget instead of chaining fallbacks', async () => {
  const f = fixture((_body, n) => n === 1 ? rejected() : rejected({ code: 'unsupported_parameter',
    param: 'store', message: 'Unsupported parameter: store' }));
  const result = await executeBufferedModelRound(f.provider, request(), { signal: new AbortController().signal,
    wait: async () => assert.fail('A permanent feature rejection is not a transport retry') });
  assert.equal(result.status, 'failed'); assert.equal(result.error.code, 'unsupported_parameter');
  assert.equal(f.calls.length, 2); assert.equal(f.calls[1].previous_response_id, undefined);
  assert.equal(f.calls[1].store, true, 'The continuation repair cannot silently become a capability downgrade');
});

test('Runtime applies the same recovery budget before retrying a transient failure', async t => {
  const f = fixture((body, n) => n === 1 ? completed(body, 'resp_1', [call('call_1')])
    : body.previous_response_id ? rejected()
    : n === 3 ? rejected({ code: 'server_error', message: 'Unavailable' }, 503) : completed(body, 'resp_4'));
  const tools = new ToolRegistry(); let executed = 0;
  tools.register({ definition: { name: 'inspect', description: 'One authorized operation', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'mutation', operation: 'fixture.inspect', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: true },
    decodeInput: value => value, execute: () => ({ saved: ++executed }) });
  const host = new InMemoryRuntimeHost({ provider: f.provider, toolRegistry: tools, maxAttempts: 2,
    registerDefaultWorkspaceTools: false, wait: async () => {} });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const result = await host.runModelTurn(request({ tools: tools.definitions(), metadata: {}, permissionMode: 'all_free',
    messages: [{ role: 'user', content: 'Perform an operation' }], providerState: undefined }));
  assert.equal(result.payload.status, 'completed'); assert.equal(executed, 1); assert.equal(f.calls.length, 4);
  assert.deepEqual(f.calls[3], f.calls[2]);
  const events = host.events('s', 't');
  const retry = events.find(event => event.kind === 'provider_retry');
  assert.equal(retry.payload.attempt, 2); assert.equal(retry.payload.providerAttempts, 2); assert.equal(retry.payload.recoveryAttempts, 1);
  const recovered = events.find(event => event.kind === 'provider_compatibility' && event.payload.action === 'recovered');
  assert.equal(recovered.payload.providerAttempts, 3); assert.equal(recovered.payload.recoveryAttempts, 1);
  assert.equal(events.filter(event => event.kind === 'tool_returned').length, 1);
});

test('Runtime reuses completed tool results and continues from the recovered response ID', async t => {
  const f = fixture((body, n) => n === 2 ? rejected()
    : completed(body, `resp_${n}`, n === 1 || n === 3 ? [call(`call_${n}`)] : [text('Done')]));
  const tools = new ToolRegistry(); let executed = 0;
  tools.register({ definition: { name: 'inspect', description: 'Record an authorized operation', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'mutation', operation: 'fixture.inspect', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: true },
    decodeInput: value => value, execute: () => ({ completedOperation: ++executed }) });
  const host = new InMemoryRuntimeHost({ provider: f.provider, toolRegistry: tools, maxAttempts: 1, registerDefaultWorkspaceTools: false });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const result = await host.runModelTurn(request({ tools: tools.definitions(), metadata: {}, permissionMode: 'all_free',
    messages: [{ role: 'user', content: 'Perform two operations' }], providerState: undefined }));
  assert.equal(result.payload.status, 'completed'); assert.equal(executed, 2);
  assert.equal(f.calls.length, 4);
  assert.deepEqual(f.calls.map(body => body.previous_response_id), [undefined, 'resp_1', undefined, 'resp_3']);
  assert.ok(f.calls[2].input.some(item => item.type === 'function_call_output' && item.call_id === 'call_1' &&
    item.output.includes('"completedOperation":1')));
  const events = host.events('s', 't');
  assert.equal(events.filter(event => event.kind === 'tool_returned').length, 2);
  assert.deepEqual(events.filter(event => event.kind === 'provider_compatibility').map(event => event.payload.action), ['retry', 'recovered']);
  assert.deepEqual(events.filter(event => event.kind === 'provider_input_observed').map(event => event.payload.transport),
    ['full', 'continuation', 'full', 'continuation']);
});
