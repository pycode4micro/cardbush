import assert from 'node:assert/strict';
import test from 'node:test';
import { modelRequestSchema, providerInputProjectionSchema } from '@cardbush/bush-protocol';
import { executeModelRound, InMemoryRuntimeHost, ToolRegistry } from '@cardbush/bush-runtime';
import { OpenAIResponsesProvider, OpenAIChatCompletionsProvider, toResponsesCreateParams,
  toResponsesInputTokenCountParams, toChatCompletionsParams, toAnthropicMessagesParams } from '../dist/index.js';
import { responsesInputFingerprint } from '../dist/responsesInputFingerprint.js';
import { imageFixture, png } from '../../bush-runtime/test/helpers/modelImages.mjs';

const ARK = 'https://ark.cn-beijing.volces.com/api/v3';
const request = (extra = {}) => modelRequestSchema.parse({ protocol: 'bush.model_request.v1', requestId: 'request-1',
  sessionId: 'conversation-A', turnId: 'turn-1', model: 'fixture', messages: [{ role: 'user', content: 'Hello' }], tools: [], ...extra });
const sse = events => new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
  { headers: { 'content-type': 'text/event-stream' } });
const completed = (output = [{ type: 'message', id: 'answer', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done', annotations: [] }] }], usage = {}) => sse([{ type: 'response.completed', response: { id: 'response-1', model: 'fixture',
  created_at: 1, status: 'completed', store: false, output, tools: [],
  usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 80 }, ...usage } } }]);
const chatCompleted = () => sse([{ id: 'completion-1', object: 'chat.completion.chunk', created: 1, model: 'fixture',
  choices: [{ index: 0, delta: { content: 'Done' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80 } } }]);

test('cache routing is opt-in by supported endpoint, never inferred from an OpenAI-compatible protocol', () => {
  for (const baseURL of [undefined, 'https://api.openai.com/v1', ARK, 'https://ark.cn-shanghai.volces.com/api/v3']) {
    const responses = toResponsesCreateParams(request(), { baseURL });
    const chat = toChatCompletionsParams(request(), baseURL);
    assert.match(responses.prompt_cache_key, /^cb-[a-f0-9]{48}$/);
    assert.equal(chat.prompt_cache_key, responses.prompt_cache_key);
    assert.equal(JSON.stringify(toResponsesInputTokenCountParams(responses)).includes('prompt_cache_key'), false);
  }
  for (const baseURL of ['https://opencode.ai/zen/go/v1', 'https://openrouter.ai/api/v1', 'http://localhost:1234/v1',
    'https://custom.invalid/v1', 'https://api.openai.com.evil.invalid/v1', 'https://ark.cn-beijing.volces.com.evil.invalid/v1',
    'https://other.volces.com/v1', 'http://api.openai.com/v1', 'invalid']) {
    assert.equal('prompt_cache_key' in toResponsesCreateParams(request(), { baseURL }), false, baseURL);
    assert.equal('prompt_cache_key' in toChatCompletionsParams(request(), baseURL), false, baseURL);
  }
  assert.equal('prompt_cache_key' in toResponsesCreateParams(request(), { chatGpt: true }), false);
  assert.equal('prompt_cache_key' in toAnthropicMessagesParams(request()), false);
});

test('session routing survives follow-ups, retry, maintenance, response chaining and settings changes', () => {
  const initial = request(), expected = toResponsesCreateParams(initial, { baseURL: ARK }).prompt_cache_key;
  const snapshot = structuredClone(initial);
  for (const next of [initial, { ...initial, requestId: 'retry', turnId: 'later' },
    { ...initial, messages: [...initial.messages, { role: 'assistant', content: 'Done', toolCalls: [] }, { role: 'user', content: 'Continue' }] },
    { ...initial, maxOutputTokens: 16384, messages: [{ role: 'user', content: 'Summarize the history' }] },
    { ...initial, maxOutputTokens: 32768, reasoningEffort: 'max', model: 'other-model' },
    { ...initial, providerState: { strategy: 'response_chain', previousResponseId: 'previous', inputMessageOffset: 1 } }]) {
    assert.equal(toResponsesCreateParams(next, { baseURL: ARK }).prompt_cache_key, expected);
    assert.equal(toChatCompletionsParams(next, ARK).prompt_cache_key, expected);
  }
  assert.equal(toResponsesCreateParams(initial, { baseURL: ARK, compatibilityMode: true }).prompt_cache_key, expected);
  assert.notEqual(toResponsesCreateParams(request({ sessionId: 'conversation-B' }), { baseURL: ARK }).prompt_cache_key, expected);
  assert.equal(expected.includes(initial.sessionId), false);
  assert.deepEqual(initial, snapshot);
  const params = toResponsesCreateParams(initial, { baseURL: ARK });
  const routed = responsesInputFingerprint(params, params);
  const { prompt_cache_key: _key, ...unrouted } = params;
  const original = responsesInputFingerprint(unrouted, unrouted);
  assert.deepEqual(routed.tokenEstimate, original.tokenEstimate, 'routing hints do not consume prompt tokens');
  assert.deepEqual(routed.parameterDigests, original.parameterDigests, 'routing is reported separately from prompt changes');
  assert.equal(routed.cacheRouting.mode, 'session');
  assert.equal(original.cacheRouting.mode, 'provider_default');
});

for (const [Provider, response] of [[OpenAIResponsesProvider, completed], [OpenAIChatCompletionsProvider, chatCompleted]]) {
  test(`${Provider.name}: actual SDK bodies use isolated session keys and the preflight matches dispatch`, async () => {
    const wires = [], estimates = [], dispatches = [];
    const provider = new Provider({ apiKey: 'fixture-only', baseURL: ARK, fetch: async (_url, init) => {
      wires.push(JSON.parse(init.body)); return response();
    } });
    const a = request(), b = request({ sessionId: 'conversation-B' });
    await provider.estimateInputTokens(a, { onInputProjection: value => estimates.push(value) });
    await Promise.all([executeModelRound(provider, a, { onInputProjection: value => dispatches.push(value) }), executeModelRound(provider, b)]);
    await executeModelRound(provider, request({ requestId: 'next', turnId: 'turn-2' }));
    const restarted = new Provider({ apiKey: 'rotated-fixture-key', baseURL: ARK, fetch: async (_url, init) => {
      wires.push(JSON.parse(init.body)); return response();
    } });
    await executeModelRound(restarted, a);
    const key = toResponsesCreateParams(a, { baseURL: ARK }).prompt_cache_key;
    assert.deepEqual(wires.map(wire => wire.prompt_cache_key), [key, toResponsesCreateParams(b, { baseURL: ARK }).prompt_cache_key, key, key]);
    assert.deepEqual(estimates, dispatches);
    assert.equal(providerInputProjectionSchema.parse(dispatches[0]).cacheRouting.mode, 'session');
    assert.equal(JSON.stringify(dispatches).includes(key), false, 'diagnostics retain only key digests');
    assert.ok(wires.every(wire => !('caching' in wire)), 'do not implicitly enable billable explicit caching');
  });
}

test('Responses compatibility fallback keeps the routing key and usage points to the successful dispatch', async t => {
  const wires = [];
  const provider = new OpenAIResponsesProvider({ apiKey: 'fixture', baseURL: ARK, fetch: async (_url, init) => {
    wires.push(JSON.parse(init.body));
    return wires.length === 1 ? Response.json({ error: { message: 'Unsupported tool shape', code: 'unsupported_value' } }, { status: 400 }) : completed();
  } });
  const host = new InMemoryRuntimeHost({ provider, registerDefaultWorkspaceTools: false });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const terminal = await host.runSessionTurn(turn());
  assert.equal(terminal.payload.status, 'completed');
  assert.equal(wires.length, 2);
  assert.equal(wires[0].prompt_cache_key, wires[1].prompt_cache_key);
  const events = host.events('conversation-A', 'turn-1');
  const dispatches = events.filter(event => event.kind === 'provider_input_observed');
  const usage = events.find(event => event.kind === 'model_request_usage');
  assert.equal(dispatches.length, 2);
  assert.equal(usage.payload.providerInputSequence, dispatches[1].sequence);
  assert.equal(usage.payload.cachedInputTokens, 80);
});

test('shared Runtime loop preserves tool images and associates image additions with real provider usage', async t => {
  const { root } = await imageFixture(t);
  const registry = new ToolRegistry(), wires = [];
  const imageData = png.toString('base64');
  registry.register({ definition: { name: 'capture', description: 'Capture fixture', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'observation', operation: 'fixture.capture', risk: 'low', owner: 'test', dispatch_scope: 'parent_session', mutating: false },
    decodeInput: value => value, execute: () => ({ content: [{ type: 'image', mimeType: 'image/png', data: imageData, _meta: { 'codex/imageDetail': 'original' } }] }),
    renderModelResult: value => JSON.stringify(value) });
  const provider = new OpenAIResponsesProvider({ apiKey: 'fixture', baseURL: ARK, fetch: async (_url, init) => {
    wires.push(JSON.parse(init.body));
    return wires.length === 1 ? completed([{ type: 'function_call', id: 'fc-1', call_id: 'capture-1', name: 'capture', arguments: '{}' }])
      : completed(undefined, { input_tokens: 200, input_tokens_details: { cached_tokens: 40 } });
  } });
  const host = new InMemoryRuntimeHost({ dataRoot: root, provider, toolRegistry: registry, registerDefaultWorkspaceTools: false });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const terminal = await host.runSessionTurn({ ...turn(), tools: registry.definitions(), requestCapabilities: { vision: true } });
  assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal));
  assert.equal(wires.length, 2);
  assert.equal(wires[1].prompt_cache_key, wires[0].prompt_cache_key);
  assert.deepEqual(wires[1].input.slice(0, wires[0].input.length), wires[0].input);
  assert.ok(JSON.stringify(wires[1].input).includes(`data:image/png;base64,${imageData}`), JSON.stringify(wires[1].input));
  const events = host.events('conversation-A', 'turn-1');
  const dispatches = events.filter(event => event.kind === 'provider_input_observed');
  const usage = events.filter(event => event.kind === 'model_request_usage');
  assert.equal(dispatches[1].payload.frozenPrefixBreak, false);
  assert.deepEqual(dispatches[1].payload.images, { count: 1, remoteCount: 0, comparisonAvailable: true, previousCount: 0, addedCount: 1, removedCount: 0 });
  assert.deepEqual(usage.map(event => event.payload.providerInputSequence), dispatches.map(event => event.sequence));
  assert.equal(usage[1].payload.cachedInputTokens, 40, 'diagnostics never replace provider cache facts');
  assert.equal(JSON.stringify(dispatches).includes(imageData), false);
});

function turn() {
  return { protocol: 'bush.session_turn_request.v1', requestId: 'request-1', sessionId: 'conversation-A', turnId: 'turn-1',
    model: 'fixture', prefixMessages: [], tools: [], inputMessages: [{ messageId: 'user-1', message: { role: 'user', content: 'Inspect the image' } }] };
}
