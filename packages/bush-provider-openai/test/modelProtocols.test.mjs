import assert from 'node:assert/strict';
import test from 'node:test';
import { modelEventSchema, modelRequestSchema, modelRequestHeaders, modelHeadersSchema } from '@cardbush/bush-protocol';
import { modelReplayMessageHash, InMemoryRuntimeHost, ToolRegistry } from '@cardbush/bush-runtime';
import { OpenAIChatCompletionsProvider, AnthropicMessagesProvider, OpenAIResponsesProvider,
  ModelProviderRegistry, createModelProvider, toChatCompletionsParams, toAnthropicMessagesParams } from '../dist/index.js';

const req = (extra = {}) => modelRequestSchema.parse({ protocol: 'bush.model_request.v1', requestId: 'request-1',
  sessionId: 'conversation-A', turnId: 'turn-1', model: 'fixture', messages: [{ role: 'user', content: '你好' }],
  tools: [{ name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }], ...extra });
const collect = async stream => { const out = []; for await (const event of stream) { modelEventSchema.parse(event); out.push(event); }
  assert.deepEqual(out.map(e => e.sequence), out.map((_, i) => i)); return out; };
const sse = (events, done = false) => new Response(new ReadableStream({ start(controller) {
  const data = new TextEncoder().encode(events.map(e => `${e.type ? `event: ${e.type}\n` : ''}data: ${JSON.stringify(e)}\n\n`).join('') + (done ? 'data: [DONE]\n\n' : ''));
  // Include split UTF-8, event boundaries and JSON tokens.
  for (let i = 0; i < data.length; i += 11) controller.enqueue(data.slice(i, i + 11));
  controller.close();
} }), { headers: { 'content-type': 'text/event-stream' } });
const chunk = (delta = {}, finish_reason = null) => ({ id: 'completion-1', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] });
const chatEvents = (finish = 'tool_calls', args = '{"path":"file.txt"}') => [
  chunk({ content: '检查', reasoning_content: '分析' }),
  chunk({ tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read_', arguments: args.slice(0, 7) } }] }),
  chunk({ tool_calls: [{ index: 0, function: { name: 'file', arguments: args.slice(7) } }] }),
  chunk({}, finish), { ...chunk(), choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 60 } } },
];
const anthropicEvents = (stop = 'tool_use', args = '{"path":"file.txt"}') => [
  { type: 'message_start', message: { id: 'msg-1', role: 'assistant', type: 'message', content: [], model: 'fixture', stop_reason: null, usage: { input_tokens: 20, output_tokens: 1, cache_creation_input_tokens: 30, cache_read_input_tokens: 50 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '分析' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed-thinking' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '检查' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'call-1', name: 'read_file', input: {} } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: args.slice(0, 7) } },
  { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: args.slice(7) } },
  { type: 'content_block_stop', index: 2 },
  { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 10 } },
  { type: 'message_stop' },
];

test('session headers are per request, case-insensitive and confined to the OpenCode host', () => {
  const defaults = { 'User-Agent': 'CardBush-Test/1.0', 'x-session-id': '{{sessionId}}', 'X-OpenCode-Session': 'old-fixed-id' };
  assert.equal(modelRequestHeaders('https://opencode.ai/zen/go/v1', defaults, 'A')['x-opencode-session'], 'A');
  assert.equal(modelRequestHeaders('https://opencode.ai/zen/go/v1', defaults, 'B')['x-session-id'], 'B');
  assert.equal(defaults['X-OpenCode-Session'], 'old-fixed-id');
  assert.equal(modelRequestHeaders('https://opencode.ai.evil.invalid/v1', {}, 'A')['x-opencode-session'], undefined);
  assert.equal(modelRequestHeaders(undefined, {}, 'A')['user-agent'], 'CardBush/1.0');
  for (const invalid of [{ host: 'example.com' }, { A: 'one', a: 'two' }, { 'bad name': 'x' }, { A: 'x\r\ninjected: value' }]) assert.equal(modelHeadersSchema.safeParse(invalid).success, false);
});

test('Responses includes stable session headers for counting, follow-ups and concurrent conversations', async () => {
  const requests = [];
  const provider = new OpenAIResponsesProvider({ apiKey: 'fixture-key', baseURL: 'https://opencode.ai/zen/go/v1', fetch: async (url, init) => {
    const headers = new Headers(init.headers), body = JSON.parse(init.body); requests.push({ url: String(url), headers, body });
    if (String(url).endsWith('/input_tokens')) return Response.json({ input_tokens: 12 });
    const response = { id: 'resp-1', object: 'response', model: 'fixture', created_at: 1, status: 'completed', output: [], tools: [], store: false };
    return sse([{ type: 'response.completed', response }]);
  } });
  assert.equal((await provider.countInputTokens(req())).inputTokens, 12);
  await Promise.all([collect(provider.stream(req())), collect(provider.stream(req({ sessionId: 'conversation-B' })))]);
  await collect(provider.stream(req({ requestId: 'request-2', turnId: 'turn-2' })));
  assert.deepEqual(requests.map(r => r.headers.get('x-opencode-session')), ['conversation-A', 'conversation-A', 'conversation-B', 'conversation-A']);
  assert.ok(requests.every(r => r.headers.get('user-agent') === 'CardBush/1.0'));
});

test('Responses compatibility retry reuses the conversation ID', async () => {
  const seen = [];
  const provider = new OpenAIResponsesProvider({ apiKey: 'fixture-key', baseURL: 'https://opencode.ai/zen/go/v1', fetch: async (_url, init) => {
    seen.push(new Headers(init.headers).get('x-opencode-session'));
    if (seen.length === 1) return Response.json({ error: { message: 'unsupported Responses field', code: 'unsupported_value' } }, { status: 400 });
    return sse([{ type: 'response.completed', response: { id: 'resp-1', model: 'fixture', created_at: 1, status: 'completed', output: [], tools: [], store: false } }]);
  } });
  assert.equal((await collect(provider.stream(req()))).at(-1).kind, 'response_completed');
  assert.deepEqual(seen, ['conversation-A', 'conversation-A']);
});

for (const [adapter, Provider, events, path] of [
  ['openai_chat_completions', OpenAIChatCompletionsProvider, chatEvents, '/chat/completions'],
  ['anthropic_messages', AnthropicMessagesProvider, anthropicEvents, '/messages'],
]) {
  test(`${adapter}: Runtime executes one tool and resumes on the same conversation`, async t => {
    let rounds = 0, executed = 0;
    const provider = new Provider({ apiKey: 'fixture', baseURL: 'https://opencode.ai/zen/go/v1', fetch: async (_url, init) => {
      assert.equal(new Headers(init.headers).get('x-opencode-session'), 'runtime-protocol');
      const body = JSON.parse(init.body); rounds++;
      if (rounds === 1) return sse(events());
      assert.equal(rounds, 2); assert.equal(executed, 1);
      assert.match(JSON.stringify(body.messages), /verified-fixture/);
      if (adapter === 'openai_chat_completions') return sse([chunk({ content: 'Done' }, 'stop')], true);
      return sse([anthropicEvents()[0], { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Done' } },
        { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }]);
    } });
    const tools = new ToolRegistry();
    tools.register({ definition: req().tools[0],
      manifest: { effect_kind: 'observation', operation: 'test.read', risk: 'low', owner: 'test', dispatch_scope: 'parent_session', mutating: false },
      decodeInput: value => value, execute: ({ input }) => { executed++; assert.equal(input.path, 'file.txt'); return { text: 'verified-fixture' }; } });
    const host = new InMemoryRuntimeHost({ toolRegistry: tools, registerDefaultWorkspaceTools: false, provider });
    t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
    const terminal = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: 'turn', sessionId: 'runtime-protocol', turnId: 'turn',
      model: 'fixture', tools: tools.definitions(), prefixMessages: [], inputMessages: [{ messageId: 'human', message: { role: 'user', content: 'Read a file' } }] });
    assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal));
    assert.equal(executed, 1); assert.equal(rounds, 2);
  });
  test(`${adapter}: real SDK request, fragmented SSE, tools, usage and opaque replay`, async () => {
    const requests = [], projections = [], budgets = [];
    const provider = new Provider({ apiKey: 'fixture-key', baseURL: 'https://opencode.ai/zen/go/v1', defaultHeaders: { 'x-custom-session': '{{sessionId}}' },
      fetch: async (url, init) => { requests.push({ url: String(url), headers: new Headers(init.headers), body: JSON.parse(init.body) }); return sse(events(), adapter === 'openai_chat_completions'); } });
    const input = req(), opts = { onInputProjection: p => projections.push(p), onRequestBodyBudget: b => budgets.push(b) };
    assert.ok(await provider.estimateInputTokens(input, opts) > 0);
    const result = await collect(provider.stream(input, opts));
    assert.equal(requests[0].url, `https://opencode.ai/zen/go/v1${path}`);
    assert.equal(requests[0].headers.get('x-opencode-session'), 'conversation-A');
    assert.equal(requests[0].headers.get('x-custom-session'), 'conversation-A');
    assert.equal(requests[0].headers.get('user-agent'), 'CardBush/1.0');
    assert.equal(requests[0].headers.get(adapter === 'anthropic_messages' ? 'x-api-key' : 'authorization'), adapter === 'anthropic_messages' ? 'fixture-key' : 'Bearer fixture-key');
    if (adapter === 'anthropic_messages') assert.equal(requests[0].headers.get('anthropic-version'), '2023-06-01');
    assert.equal(result.find(e => e.kind === 'text_delta').delta, '检查');
    assert.equal(result.find(e => e.kind === 'reasoning_delta').delta, '分析');
    const call = result.find(e => e.kind === 'tool_call_delta');
    assert.equal(call.nameDelta, 'read_file'); assert.equal(call.argumentsDelta, '{"path":"file.txt"}');
    assert.equal(result.at(-1).finishReason, 'tool_calls');
    const usage = result.findLast(e => e.kind === 'usage');
    assert.equal(usage.inputTokens, 100); assert.equal(usage.outputTokens, 10);
    assert.deepEqual(projections[0], projections[1], 'estimate and actual dispatch must have the same input');
    assert.equal(budgets[1].bytes, Buffer.byteLength(JSON.stringify(requests[0].body)));
    const assistant = { role: 'assistant', content: '检查', reasoningContent: '分析', toolCalls: [{ id: 'call-1', name: 'read_file', argumentsText: call.argumentsDelta }] };
    assistant.providerReplay = { ...result.at(-1).providerReplay, model: input.model, messageHash: modelReplayMessageHash(assistant) };
    const follow = req({ messages: [...input.messages, assistant, { role: 'tool', toolCallId: 'call-1', content: 'file content' }] });
    await collect(provider.stream(follow));
    const second = requests[1].body;
    if (adapter === 'anthropic_messages') {
      assert.equal(second.messages[1].content[0].signature, 'signed-thinking');
      assert.equal(second.messages[2].content[0].tool_use_id, 'call-1');
    } else {
      assert.equal(second.messages[1].reasoning_content, '分析'); assert.equal(second.messages[2].tool_call_id, 'call-1');
    }
    assert.equal(requests[1].headers.get('x-opencode-session'), 'conversation-A');
    const switched = req({ ...follow, model: 'another-model' });
    const switchedBody = adapter === 'anthropic_messages' ? toAnthropicMessagesParams(switched) : toChatCompletionsParams(switched);
    assert.ok(!JSON.stringify(switchedBody).includes('signed-thinking'), 'opaque replay must not cross models');
  });

  test(`${adapter}: confirmed malformed arguments are passed to the common tool validator`, async () => {
    const provider = new Provider({ apiKey: 'fixture', fetch: async () => sse(events(undefined, '{"path":')) });
    const result = await collect(provider.stream(req()));
    assert.equal(result.at(-1).kind, 'response_completed');
    assert.equal(result.find(e => e.kind === 'tool_call_delta').argumentsDelta, '{"path":');
    if (adapter === 'anthropic_messages') assert.equal(result.at(-1).providerReplay, undefined, 'Cannot replay an invalid JSON input object');
  });

  for (const failure of ['truncated', 'missing_terminal', 'cancelled', 'http_429', 'transport', 'budget']) {
    test(`${adapter}: ${failure} cannot execute an unconfirmed tool call`, async () => {
      let network = 0;
      const controller = new AbortController();
      if (failure === 'cancelled') controller.abort();
      const provider = new Provider({ apiKey: 'fixture', maxRequestBodyBytes: failure === 'budget' ? 10 : undefined, fetch: async () => {
        network++;
        if (failure === 'transport') throw Object.assign(new Error('socket broken'), { code: 'ECONNRESET' });
        if (failure === 'http_429') return Response.json({ error: { type: 'rate_limit_error', message: 'too many requests' } }, { status: 429, headers: { 'retry-after': '2' } });
        const data = failure === 'truncated' ? events(adapter === 'anthropic_messages' ? 'max_tokens' : 'length', '{"path":')
          : events();
        if (failure === 'missing_terminal') data.splice(adapter === 'anthropic_messages' ? -2 : -2);
        return sse(data);
      } });
      const result = await collect(provider.stream(req(), { signal: controller.signal }));
      assert.equal(result.filter(e => e.kind === 'tool_call_delta').length, 0);
      const last = result.at(-1);
      if (failure === 'truncated') { assert.equal(last.finishReason, 'length'); assert.deepEqual(last.completedToolCallIndices, []); assert.equal(last.providerReplay, undefined); }
      else { assert.equal(last.kind, 'response_failed');
        if (failure === 'http_429') { assert.equal(last.status, 429); assert.equal(last.retryAfterMs, 2000); assert.equal(last.retryable, true); }
        if (failure === 'transport') assert.equal(last.retryable, true);
        if (failure === 'cancelled') assert.equal(last.code, 'request_aborted');
        if (failure === 'budget') assert.equal(last.code, 'provider_request_body_too_large');
      }
      assert.equal(network, ['cancelled', 'budget'].includes(failure) ? 0 : 1, 'SDK must not silently retry the whole call');
    });
  }
}

test('Anthropic in-stream overload is retryable but never a completed response', async () => {
  const provider = new AnthropicMessagesProvider({ apiKey: 'fixture', fetch: async () => sse([
    anthropicEvents()[0], { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
  ]) });
  const result = await collect(provider.stream(req()));
  assert.equal(result.at(-1).code, 'overloaded_error'); assert.equal(result.at(-1).retryable, true);
  assert.equal(result.some(e => e.kind === 'response_completed'), false);
});

test('Messages projects rejected argument history as text without inventing input or orphaning tool results', () => {
  const input = req({ messages: [{ role: 'user', content: 'Write once' },
    { role: 'assistant', content: 'Try these', toolCalls: [
      { id: 'rejected', name: 'read_file', argumentsText: '{"incomplete":' },
      { id: 'valid', name: 'read_file', argumentsText: '{"path":"file.txt"}' },
    ] },
    { role: 'tool', toolCallId: 'rejected', content: 'tool_arguments_invalid_json' },
    { role: 'tool', toolCallId: 'valid', content: 'verified result' },
    { role: 'user', content: 'Continue' },
  ] });
  const before = structuredClone(input), wire = toAnthropicMessagesParams(input);
  assert.deepEqual(input, before);
  const calls = wire.messages[1].content.filter(block => block.type === 'tool_use');
  assert.deepEqual(calls.map(call => call.id), ['valid']);
  assert.equal(wire.messages[2].content[0].tool_use_id, 'valid');
  assert.match(JSON.stringify(wire.messages[1].content), /incomplete/);
  assert.match(JSON.stringify(wire.messages[2].content), /tool_arguments_invalid_json/);
  assert.match(JSON.stringify(wire.messages[2].content), /Continue/);
});

test('protocol projections preserve image batches without breaking tool-result adjacency', () => {
  const png = 'data:image/png;base64,YQ==';
  const input = req({ messages: [{ role: 'system', content: 'system' }, { role: 'developer', content: 'developer' }, { role: 'user', content: 'inspect', images: [{ url: png }] },
    { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'read_file', argumentsText: '{}' }, { id: 'b', name: 'read_file', argumentsText: '{}' }] },
    { role: 'tool', toolCallId: 'a', content: 'A', images: [{ url: png }] }, { role: 'tool', toolCallId: 'b', content: 'B' }] });
  const chat = toChatCompletionsParams(input), anthropic = toAnthropicMessagesParams(input);
  assert.deepEqual(chat.messages.slice(-3).map(m => m.role), ['tool', 'tool', 'user']);
  assert.equal(chat.messages.at(-1).content.at(-1).image_url.url, png);
  assert.equal(anthropic.system, 'system\n\ndeveloper');
  assert.equal(anthropic.messages.at(-1).content.length, 2);
  assert.equal(anthropic.messages.at(-1).content[0].content[1].source.data, 'YQ==');
  assert.equal(anthropic.max_tokens, 8192);
});

test('registry switches wire adapters and retains immutable old revisions', () => {
  const configs = [], registry = new ModelProviderRegistry({ createProvider: config => { configs.push(config); return createModelProvider(config); } });
  const binding = { protocol: 'bush.provider_binding_config.v1', bindingId: 'same-model', apiKey: 'fixture', baseURL: 'https://api.invalid/v1' };
  const first = registry.upsert({ ...binding, adapter: 'openai_responses' });
  const second = registry.upsert({ ...binding, adapter: 'openai_chat_completions' });
  const third = registry.upsert({ ...binding, adapter: 'anthropic_messages' });
  assert.equal(new Set([first, second, third].map(r => r.binding.revision)).size, 3);
  assert.deepEqual(configs.map(c => createModelProvider(c).constructor.name), ['OpenAIResponsesProvider', 'OpenAIChatCompletionsProvider', 'AnthropicMessagesProvider']);
});

test('Anthropic thinking is explicit, with adaptive and legacy budgets kept separate', () => {
  const input = req({ reasoningEffort: 'high', maxOutputTokens: 8192 });
  assert.deepEqual(toAnthropicMessagesParams(input).thinking, { type: 'adaptive' });
  assert.deepEqual(toAnthropicMessagesParams(input).output_config, { effort: 'high' });
  assert.deepEqual(toAnthropicMessagesParams(input, 'budget').thinking, { type: 'enabled', budget_tokens: 4096 });
  assert.deepEqual(toAnthropicMessagesParams(req({ reasoningEffort: 'none' })).thinking, { type: 'disabled' });
  assert.deepEqual(toAnthropicMessagesParams(req({ reasoningEffort: 'none' }), 'budget').thinking, { type: 'disabled' });
  assert.equal(toAnthropicMessagesParams(req()).thinking, undefined, 'unspecified effort still uses provider defaults');
  assert.equal(toAnthropicMessagesParams(req({ reasoningEffort: 'high', maxOutputTokens: 128 })).thinking.type, 'adaptive');
  assert.throws(() => toAnthropicMessagesParams(req({ reasoningEffort: 'high', maxOutputTokens: 1024 }), 'budget'), /greater than 1024/);
});
