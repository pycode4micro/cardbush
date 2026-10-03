import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { modelRequestSchema, runtimeProviderBindingConfigSchema, SIWC } from '@cardbush/bush-protocol';
import { executeModelRound, ToolRegistry, registerMcpDiscovery } from '@cardbush/bush-runtime';
import { OpenAIResponsesProvider, ModelProviderRegistry, toResponsesCreateParams } from '../dist/index.js';
import { siwcFetch } from '../dist/siwc.js';

const registry = new ToolRegistry(); registerMcpDiscovery(registry);
const request = overrides => modelRequestSchema.parse({ protocol: 'bush.model_request.v1', requestId: 'request1', sessionId: 'parent',
  turnId: 'turn1', model: 'gpt-fixture-latest', tools: registry.definitions(), metadata: { mcpToolDiscovery: true },
  messages: [{ role: 'system', content: 'Stable agent instructions.' }, { role: 'user', content: 'Look up the project.' }],
  reasoningEffort: 'high', maxOutputTokens: 20000, temperature: .4, topP: .5, ...overrides });
function stream(output, id = 'response1') {
  const response = { id, object: 'response', model: 'gpt-fixture-latest', created_at: 1, status: 'completed', store: false,
    output, usage: { input_tokens: 400, output_tokens: 20, input_tokens_details: { cached_tokens: 300 } } };
  return new Response(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}
const text = { type: 'message', id: 'msg1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.', annotations: [] }] };

test('SIWC preserves local tool execution and append-only replay/cache projection through multiple rounds', async () => {
  const wires = [], fingerprints = [];
  const reasoning = { type: 'reasoning', id: 'rs1', summary: [], encrypted_content: 'opaque-reasoning-fixture' };
  const tool = { type: 'function_call', id: 'fc1', call_id: 'search1', name: 'mcp_search', arguments: '{"query":"docs"}', status: 'completed' };
  const provider = new OpenAIResponsesProvider({ apiKey: '', chatGpt: { accountId: randomUUID(), access: async () => 'oauth-fixture' }, fetch: async (url, init) => {
    assert.equal(String(url), `${SIWC.resource}/responses`); assert.equal(new Headers(init.headers).get('authorization'), 'Bearer oauth-fixture');
    const body = JSON.parse(init.body); wires.push(body);
    return stream(wires.length === 1 ? [reasoning, tool] : [text], `response${wires.length}`);
  } });
  const first = request();
  assert.equal(await provider.countInputTokens(first), undefined, 'unsupported count endpoint must not be probed');
  assert.ok(await provider.estimateInputTokens(first) > 0); assert.equal(wires.length, 0);
  const round = await executeModelRound(provider, first, { onInputProjection: value => fingerprints.push(value) });
  assert.equal(round.status, 'completed'); assert.equal(round.toolCalls[0].name, 'mcp_search');
  const history = [...first.messages, { role: 'assistant', content: round.text, reasoningContent: round.reasoning, toolCalls: round.toolCalls, providerReplay: round.providerReplay },
    { role: 'tool', toolCallId: 'search1', content: 'No matching tools.' }];
  const originalHistory = structuredClone(history);
  const second = request({ messages: history, providerState: { strategy: 'response_chain', previousResponseId: 'stale-stored-id', inputMessageOffset: 2 } });
  assert.equal((await executeModelRound(provider, second)).text, 'Done.');
  assert.deepEqual(history, originalHistory);
  for (const wire of wires) {
    assert.equal(wire.store, false); assert.equal(wire.stream, true); assert.equal(wire.reasoning.effort, 'high');
    for (const name of ['previous_response_id', 'max_output_tokens', 'temperature', 'top_p', 'tools']) assert.equal(name in wire, false, name);
    assert.equal(wire.input[0].type, 'additional_tools'); assert.ok(wire.input[0].tools.some(item => item.name === 'mcp_search'));
    assert.ok(wire.input[0].tools.every(item => item.type === 'function'));
    assert.equal(wire.input[1].role, 'developer');
    assert.equal(JSON.stringify(wire).includes('oauth-fixture'), false);
  }
  assert.deepEqual(wires[1].input.slice(0, wires[0].input.length), wires[0].input, 'second round keeps the full unchanged prefix');
  assert.deepEqual(wires[1].input.find(item => item.type === 'function_call'), tool);
  assert.deepEqual(wires[1].input.find(item => item.type === 'reasoning'), reasoning, 'stateless reasoning survives tool execution intact');
  assert.equal(wires[1].input.at(-1).call_id, 'search1');
  const ordinary = toResponsesCreateParams(first);
  assert.equal(ordinary.max_output_tokens, 20000); assert.equal(ordinary.temperature, .4); assert.equal(ordinary.input[0].role, 'system');
  assert.ok(ordinary.tools.length); assert.equal(fingerprints.length, 1);
});

test('401 refresh happens once before output; quota or grant errors never cause protocol fallback', async () => {
  const accessCalls = [], wires = []; const id = randomUUID();
  const provider = new OpenAIResponsesProvider({ apiKey: '', chatGpt: { accountId: id, access: async (accountId, input) => {
    accessCalls.push({ accountId, rejected: input.rejectedToken }); return input.rejectedToken ? 'new-token' : 'old-token';
  } }, fetch: async (_url, init) => {
    wires.push(new Headers(init.headers).get('authorization'));
    return wires.length === 1 ? Response.json({ error: { code: 'invalid_token' } }, { status: 401 }) : stream([text]);
  } });
  assert.equal((await executeModelRound(provider, request())).status, 'completed');
  assert.deepEqual(wires, ['Bearer old-token', 'Bearer new-token']);
  assert.deepEqual(accessCalls, [{ accountId: id, rejected: undefined }, { accountId: id, rejected: 'old-token' }]);
  let calls = 0;
  const denied = new OpenAIResponsesProvider({ apiKey: '', chatGpt: { accountId: id, access: async () => 'token' }, fetch: async () => {
    calls++; return Response.json({ error: { code: 'plan_not_authorized', message: 'Enable plan access.' } }, { status: 403 });
  } });
  assert.equal((await executeModelRound(denied, request())).status, 'failed'); assert.equal(calls, 1);
});

test('quota exhaustion and temporary usage failures preserve HTTP/stream errors without false completion', async () => {
  for (const transport of ['http', 'stream']) for (const [code, status, retryable] of [
    ['subscription_sharing_usage_limit_exceeded', 429, false], ['subscription_sharing_usage_unavailable', 503, true],
  ]) {
    let calls = 0;
    const provider = new OpenAIResponsesProvider({ apiKey: '', chatGpt: { accountId: randomUUID(), access: async () => 'token' }, fetch: async () => {
      calls++;
      const error = { code, message: 'Plan usage could not be granted.' };
      if (transport === 'http') return Response.json({ error }, { status, headers: { 'x-request-id': 'request-quota' } });
      const response = { id: 'response-quota', model: 'gpt-fixture-latest', created_at: 1, output: [] };
      const events = [
        { type: 'response.created', response: { ...response, status: 'in_progress' } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg-quota', delta: 'Partial output' },
        { type: 'response.failed', response: { ...response, status: 'failed', error } },
      ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    } });
    const result = await executeModelRound(provider, request());
    assert.equal(result.status, 'failed'); assert.equal(result.error.code, code); assert.equal(result.error.retryable, retryable);
    assert.equal(calls, 1, 'provider must not switch protocols or retry the body itself');
    assert.equal(result.error.providerRequestId, transport === 'http' ? 'request-quota' : 'response-quota');
    if (transport === 'http') assert.equal(result.error.status, status);
    else assert.equal(result.text, 'Partial output');
  }
});

test('immutable account bindings isolate parent/child requests; logout aborts only that account', async () => {
  const firstId = randomUUID(), secondId = randomUUID(), authorizations = [];
  const providers = new ModelProviderRegistry({ chatGptAccess: async id => `token-${id}`, createProvider: config => new OpenAIResponsesProvider({ ...config,
    fetch: async (_url, init) => { authorizations.push(new Headers(init.headers).get('authorization')); return stream([text]); },
  }) });
  const config = id => ({ protocol: 'bush.provider_binding_config.v1', bindingId: 'shared-model-name', adapter: 'openai_responses', authentication: { kind: 'chatgpt', accountId: id }, defaultHeaders: {} });
  const a = providers.upsert(config(firstId)).binding, b = providers.upsert(config(secondId)).binding;
  assert.notEqual(a.revision, b.revision); assert.doesNotMatch(JSON.stringify([a, b]), /token-/);
  const results = await Promise.all([executeModelRound(providers, request({ providerBinding: a })), executeModelRound(providers, request({ sessionId: 'child', providerBinding: b }))]);
  assert.ok(results.every(item => item.status === 'completed'));
  assert.deepEqual(authorizations.sort(), [`Bearer token-${firstId}`, `Bearer token-${secondId}`].sort());
  providers.invalidateChatGptAccount(firstId);
  assert.equal((await executeModelRound(providers, request({ providerBinding: a }))).status, 'failed');
  assert.equal((await executeModelRound(providers, request({ providerBinding: b }))).status, 'completed');
  const fresh = providers.upsert(config(firstId)).binding;
  assert.equal((await executeModelRound(providers, request({ providerBinding: fresh }))).status, 'completed');
  assert.throws(() => new ModelProviderRegistry().upsert(config(firstId)), /local desktop/);
  for (const override of [{ adapter: 'anthropic_messages' }, { baseURL: 'https://other.example/v1' }, { apiKey: 'api-secret' }, { defaultHeaders: { authorization: 'secret' } }]) {
    assert.equal(runtimeProviderBindingConfigSchema.safeParse({ ...config(firstId), ...override }).success, false);
  }
});

test('OAuth fetch does not send credentials to other endpoints or follow redirects', async () => {
  let accessCalls = 0;
  const fetcher = siwcFetch(randomUUID(), async () => { accessCalls++; return 'secret'; }, async (_url, init) => {
    assert.equal(init.redirect, 'error'); return Response.json({ error: 'redirected' }, { status: 307 });
  });
  await assert.rejects(fetcher('https://evil.example/responses', { method: 'POST' }), /public Responses/);
  assert.equal(accessCalls, 0);
  assert.equal((await fetcher(`${SIWC.resource}/responses`, { method: 'POST', body: '{}' })).status, 307);
});
