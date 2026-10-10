import assert from 'node:assert/strict';
import test from 'node:test';
import { modelRequestSchema, protocolReasoningEffort, reasoningEffortsForProtocol } from '@cardbush/bush-protocol';
import { CacheChainTracker, InMemoryRuntimeHost, SessionStore, modelReplayMessageHash } from '@cardbush/bush-runtime';
import { isContextLengthFailure } from '../../bush-runtime/dist/contextCompactionTransaction.js';
import { executeBufferedModelRound } from '../../bush-runtime/dist/bufferedModelRetry.js';
import { orderedCheckpointTool } from '../../bush-runtime/test/helpers/orderedCheckpoint.mjs';
import { AnthropicMessagesProvider, OpenAIChatCompletionsProvider, InMemoryProviderCapabilityStore,
  toAnthropicMessagesParams, toChatCompletionsParams, toResponsesCreateParams } from '../dist/index.js';

const req = (extra = {}) => modelRequestSchema.parse({ protocol: 'bush.model_request.v1', requestId: 'request', sessionId: 'session',
  turnId: 'turn', model: 'fixture', messages: [{ role: 'system', content: 'Stable rules.' }, { role: 'user', content: 'Inspect the file.' }], tools: [], ...extra });
const collect = async iterable => { const events = []; for await (const event of iterable) events.push(event); return events; };
const sse = events => new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
const events = (reason = 'end_turn', blocks = [{ type: 'text', text: 'Done.' }]) => [
  { type: 'message_start', message: { id: 'message', role: 'assistant', type: 'message', model: 'fixture', content: [],
    usage: { input_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 50, output_tokens: 0 } } },
  ...blocks.flatMap((content_block, index) => [{ type: 'content_block_start', index, content_block }, { type: 'content_block_stop', index }]),
  { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 10 } }, { type: 'message_stop' },
];
const reject = (message, status = 400, type = 'invalid_request_error') => Response.json({ type: 'error', error: { type, message } }, { status });

test('Chat picker and wire use three levels while Responses and Messages retain their levels', () => {
  assert.deepEqual(reasoningEffortsForProtocol('openai_chat_completions'), ['low', 'medium', 'high']);
  for (const [level, chatLevel] of [['none', 'low'], ['low', 'low'], ['medium', 'medium'], ['high', 'high'], ['xhigh', 'high'], ['max', 'high']]) {
    const input = req({ reasoningEffort: level });
    assert.equal(toChatCompletionsParams(input).reasoning_effort, chatLevel);
    assert.equal(protocolReasoningEffort('openai_chat_completions', level), chatLevel);
    assert.equal(toResponsesCreateParams(input).reasoning.effort, level);
    assert.equal(protocolReasoningEffort('anthropic_messages', level), level);
    const messages = toAnthropicMessagesParams(input);
    assert.deepEqual(messages.thinking, { type: level === 'none' ? 'disabled' : 'adaptive' });
    assert.deepEqual(messages.output_config, level === 'none' ? undefined : { effort: level });
  }
  assert.equal(toChatCompletionsParams(req()).reasoning_effort, undefined);
  assert.deepEqual(reasoningEffortsForProtocol(), ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
});

for (const ending of ['user', 'assistant', 'tool']) {
  test(`Anthropic notices after ${ending} preserve the system and cached content prefix`, async () => {
    const messages = req().messages;
    if (ending === 'assistant') messages.push({ role: 'assistant', content: 'Partial response.', toolCalls: [] });
    if (ending === 'tool') messages.push({ role: 'assistant', content: '', toolCalls: [{ id: 'read', name: 'read_file', argumentsText: '{}' }] },
      { role: 'tool', toolCallId: 'read', content: 'file contents' });
    const before = req({ messages }), original = structuredClone(before);
    const after = req({ messages: [...messages, { role: 'developer', name: 'tool_call_repair', content: 'Continue with valid arguments.' }] });
    const provider = new AnthropicMessagesProvider({ apiKey: 'fixture' }), tracker = new CacheChainTracker();
    tracker.observe(before);
    await provider.estimateInputTokens(before, { onInputProjection: value => tracker.observeProviderInput(value) });
    assert.equal(tracker.observe(after).frozenPrefixBreak, false);
    let observation;
    await provider.estimateInputTokens(after, { onInputProjection: value => { observation = tracker.observeProviderInput(value); } });
    assert.equal(observation.frozenPrefixBreak, false);
    assert.deepEqual(observation.changedParameters, []);
    const wire = toAnthropicMessagesParams(after);
    assert.equal(wire.system, toAnthropicMessagesParams(before).system);
    assert.equal(wire.messages.at(-1).role, 'user');
    assert.match(wire.messages.at(-1).content.at(-1).text, /Runtime developer instruction:\n\[tool_call_repair\]/);
    if (ending === 'tool') assert.equal(wire.messages.at(-1).content[0].type, 'tool_result');
    assert.deepEqual(before, original, 'Projection must not mutate canonical history');
  });
}

test('runtime notices preserve signed thinking replay and tool-result adjacency', async () => {
  const provider = new AnthropicMessagesProvider({ apiKey: 'fixture', fetch: async () => sse(events('tool_use', [
    { type: 'thinking', thinking: 'Evidence.', signature: 'exact-signature' },
    { type: 'redacted_thinking', data: 'exact-opaque-data' },
    { type: 'tool_use', id: 'call', name: 'read_file', input: { path: 'test.txt' } },
  ])) });
  const output = await collect(provider.stream(req()));
  const assistant = { role: 'assistant', content: '', reasoningContent: 'Evidence.',
    toolCalls: [{ id: 'call', name: 'read_file', argumentsText: '{"path":"test.txt"}' }] };
  assistant.providerReplay = { ...output.at(-1).providerReplay, model: 'fixture', messageHash: modelReplayMessageHash(assistant) };
  const wire = toAnthropicMessagesParams(req({ messages: [...req().messages, assistant, { role: 'tool', toolCallId: 'call', content: 'result' },
    { role: 'developer', name: 'plugin_hook_feedback', content: 'Proceed to verification.' }] }));
  assert.deepEqual(wire.messages[1].content, output.at(-1).providerReplay.data.content);
  assert.equal(wire.messages[2].content[0].tool_use_id, 'call');
  assert.equal(wire.system, 'Stable rules.');
});

test('Anthropic enables automatic caching and reports normalized cached usage', async () => {
  const input = req(), projections = [];
  const provider = new AnthropicMessagesProvider({ apiKey: 'fixture', fetch: async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body).cache_control, { type: 'ephemeral' });
    return sse(events());
  } });
  await provider.estimateInputTokens(input, { onInputProjection: p => projections.push(p) });
  const output = await collect(provider.stream(input, { onInputProjection: p => projections.push(p) }));
  assert.deepEqual(projections[0], projections[1]);
  const usage = output.findLast(event => event.kind === 'usage');
  assert.equal(usage.inputTokens, 100); assert.equal(usage.cachedInputTokens, 50);
});

test('only explicit unsupported cache errors retry once, retaining scope and stable request content', async () => {
  const bodies = [], projections = [], diagnostics = [], store = new InMemoryProviderCapabilityStore();
  const config = { apiKey: 'fixture-secret', capabilityStore: store, baseURL: 'https://opencode.ai/zen/go/v1', fetch: async (_url, init) => {
    assert.equal(new Headers(init.headers).get('x-opencode-session'), 'session');
    const body = JSON.parse(init.body); bodies.push(body);
    return bodies.length === 1 ? reject('cache_control: Extra inputs are not permitted') : sse(events());
  } };
  const input = req(), original = structuredClone(input), provider = new AnthropicMessagesProvider(config);
  const output = await collect(provider.stream(input, { onInputProjection: p => projections.push(p), onCompatibilityDiagnostic: d => diagnostics.push(d) }));
  assert.equal(output.at(-1).kind, 'response_completed');
  assert.equal(bodies.length, 2);
  const { cache_control, ...withoutCache } = bodies[0];
  assert.deepEqual(cache_control, { type: 'ephemeral' }); assert.deepEqual(bodies[1], withoutCache);
  assert.deepEqual(diagnostics.map(event => event.action), ['retry', 'recovered']);
  assert.equal(diagnostics[0].error.code, 'anthropic_prompt_cache_unsupported');
  assert.equal(diagnostics[1].providerAttempts, 2); assert.equal(diagnostics[1].recoveryAttempts, 1);
  let estimate;
  await provider.estimateInputTokens(input, { onInputProjection: p => { estimate = p; } });
  assert.deepEqual(estimate, projections[1]);
  await collect(new AnthropicMessagesProvider(config).stream(input));
  assert.equal(bodies[2].cache_control, undefined, 'Capability persists across providers for the same connection');
  await collect(provider.stream(req({ model: 'another-model' })));
  assert.deepEqual(bodies[3].cache_control, { type: 'ephemeral' }, 'Capability is scoped to model');
  assert.deepEqual(input, original);
});

test('cache negotiation stays applied across transport retries even if its capability record expires', async () => {
  let now = 1_000;
  const store = new InMemoryProviderCapabilityStore({ now: () => now, ttlMs: 1 }), bodies = [], retries = [];
  const provider = new AnthropicMessagesProvider({ apiKey: 'fixture', capabilityStore: store, fetch: async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return bodies.length === 1 ? reject('cache_control: Extra inputs are not permitted')
      : bodies.length === 2 ? reject('Temporary overload', 503, 'overloaded_error') : sse(events());
  } });
  const result = await executeBufferedModelRound(provider, req(), { signal: new AbortController().signal,
    wait: async () => { now += 10_000; }, onRetry: value => retries.push(value) });
  assert.equal(result.status, 'completed'); assert.equal(bodies.length, 3);
  assert.deepEqual(bodies[0].cache_control, { type: 'ephemeral' });
  assert.equal(bodies[1].cache_control, undefined); assert.deepEqual(bodies[2], bodies[1]);
  assert.equal(retries.length, 1); assert.equal(retries[0].providerAttempts, 2); assert.equal(retries[0].recoveryAttempts, 1);
});

for (const [status, type, message, recovery] of [
  [400, 'invalid_request_error', 'prompt is too long: 200001 tokens > 200000 maximum', true],
  [400, 'invalid_request_error', 'prompt is too long', true],
  [401, 'invalid_request_error', 'prompt is too long: 200001 tokens > 200000 maximum', false],
  [400, 'authentication_error', 'prompt is too long', false],
  [400, 'invalid_request_error', 'max_tokens must be positive', false],
  [400, 'invalid_request_error', 'message text includes prompt is too long', false],
  [400, 'invalid_request_error', 'thinking is unsupported; cache_control is present', false],
]) {
  test(`Anthropic error classification is bounded: ${status} ${type} ${message}`, async () => {
    let requests = 0;
    const provider = new AnthropicMessagesProvider({ apiKey: 'fixture', fetch: async () => { requests++; return reject(message, status, type); } });
    const failure = (await collect(provider.stream(req()))).at(-1);
    assert.equal(failure.kind, 'response_failed'); assert.equal(failure.status, status);
    assert.equal(isContextLengthFailure(failure), recovery);
    assert.equal(requests, 1, 'Unrelated failures must not negotiate cache support');
  });
}

test('Chat errors mentioning prompt length do not inherit Anthropic-specific classification', async () => {
  const provider = new OpenAIChatCompletionsProvider({ apiKey: 'fixture', fetch: async () => reject('prompt is too long') });
  const failure = (await collect(provider.stream(req()))).at(-1);
  assert.equal(failure.code, 'invalid_request_error');
  assert.equal(isContextLengthFailure(failure), false);
});

test('cache negotiation is bounded and cancellation prevents its second request', async () => {
  for (const cancel of [false, true]) {
    let requests = 0;
    const controller = new AbortController();
    const provider = new AnthropicMessagesProvider({ apiKey: 'fixture', fetch: async () => {
      requests++; return reject('cache_control: Extra inputs are not permitted');
    } });
    const output = await collect(provider.stream(req(), { signal: controller.signal,
      onCompatibilityDiagnostic: () => { if (cancel) controller.abort(); } }));
    assert.equal(requests, cancel ? 1 : 2);
    assert.equal(output.at(-1).kind, 'response_failed');
    assert.equal(output.at(-1).code, cancel ? 'request_aborted' : 'invalid_request_error');
  }
});

test('a cache-shaped validation error inside an already-started stream never restarts generation', async () => {
  let requests = 0;
  const provider = new AnthropicMessagesProvider({ apiKey: 'fixture', fetch: async () => {
    requests++;
    return sse([...events().slice(0, -2), { type: 'error', error: { type: 'invalid_request_error', message: 'cache_control: Extra inputs are not permitted' } }]);
  } });
  const output = await collect(provider.stream(req()));
  assert.equal(requests, 1); assert.equal(output.at(-1).kind, 'response_failed');
  assert.ok(output.some(event => event.kind === 'text_delta'));
});

test('Anthropic context-limit termination never confirms calls or an incomplete final answer', async t => {
  const provider = new AnthropicMessagesProvider({ apiKey: 'fixture', fetch: async () => sse(events('model_context_window_exceeded', [
    { type: 'text', text: 'PARTIAL_OVERFLOW' }, { type: 'tool_use', id: 'partial', name: 'write_file', input: {} },
  ])) });
  const output = await collect(provider.stream(req()));
  assert.equal(output.at(-1).code, 'context_length_exceeded');
  assert.equal(output.some(event => event.kind === 'tool_call_delta' || event.kind === 'response_completed'), false);
  const host = new InMemoryRuntimeHost({ provider, registerDefaultWorkspaceTools: false });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const outcome = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: 'limited', sessionId: 'limited', turnId: 'limited',
    model: 'fixture', tools: [], prefixMessages: [], inputMessages: [{ messageId: 'user', message: { role: 'user', content: 'Write the file.' } }] });
  assert.equal(outcome.payload.status, 'failed'); assert.equal(outcome.payload.reason, 'context_length_exceeded');
});

for (const overflow of ['http', 'stream']) {
  test(`Anthropic ${overflow} context overflow uses shared compaction and resumes the task`, async t => {
    const requests = [], store = new SessionStore(), now = '2026-09-29T00:00:00Z';
    store.commitTurn('sdk', { turnId: 'old', turnSequence: 1, createdAt: now, completedAt: now, status: 'completed', reason: 'model_response_completed', usage: {},
      messages: [{ role: 'user', content: 'Do the work.' }, { role: 'assistant', content: 'Work completed.', toolCalls: [] }]
        .map((message, index) => ({ messageId: `old_${index}`, turnId: 'old', turnSequence: 1, messageIndex: index, createdAt: now, message })) });
    const provider = new AnthropicMessagesProvider({ apiKey: 'fixture', fetch: async (_url, init) => {
      const body = JSON.parse(init.body); requests.push(body);
      assert.ok(requests.length <= 3, 'Recovery must not loop or silently use transport retries');
      assert.equal(body.messages.at(-1).role, 'user', 'Maintenance must be a legal continuation');
      if (requests.length === 1) return overflow === 'http' ? reject('prompt is too long: 400001 tokens > 400000 maximum')
        : sse(events('model_context_window_exceeded', [{ type: 'text', text: 'PARTIAL_OVERFLOW' }]));
      assert.equal(body.system, requests[0].system);
      if (requests.length === 2) {
        assert.equal(body.max_tokens, 16384);
        assert.match(JSON.stringify(body.messages.at(-1)), /context_pressure/);
        return sse(events('tool_use', [{ type: 'tool_use', id: 'cp_valid', name: 'checkpoint_context', input: { summaries: ['The work completed; verification remains.'] } }]));
      }
      assert.match(JSON.stringify(body.messages), /cp_valid/);
      assert.doesNotMatch(JSON.stringify(body.messages), /PARTIAL_OVERFLOW/);
      return sse(events('end_turn', [{ type: 'text', text: 'Verification complete.' }]));
    } });
    const host = new InMemoryRuntimeHost({ sessionStore: store, provider, maxAttempts: 1, registerDefaultWorkspaceTools: false });
    t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
    const result = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: 'sdk', sessionId: 'sdk', turnId: 'current',
      model: 'fixture', maxOutputTokens: 128000, reasoningEffort: 'high', metadata: { contextWindowTokens: 400000 }, tools: [orderedCheckpointTool],
      prefixMessages: [{ role: 'system', content: 'Stable rules.' }], inputMessages: [{ messageId: 'user', message: { role: 'user', content: 'Verify the result.' } }] });
    assert.equal(result.payload.status, 'completed', JSON.stringify(result));
    assert.equal(requests.length, 3);
    const log = host.events('sdk', 'current');
    assert.equal(log.filter(event => event.kind === 'context_compaction_completed').length, 1);
    assert.equal(log.filter(event => event.kind === 'provider_retry' && event.payload.code === 'context_length_recovery').length, 1);
    if (overflow === 'stream') assert.ok(log.some(event => event.kind === 'replay_reset' && event.payload.reason === 'provider_attempt_failed'));
    assert.doesNotMatch(JSON.stringify(store.snapshot('sdk')), /PARTIAL_OVERFLOW/);
  });
}
