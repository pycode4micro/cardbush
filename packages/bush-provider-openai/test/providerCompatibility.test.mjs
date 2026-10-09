import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelRequestSchema } from '@cardbush/bush-protocol';
import { executeModelRound, FileRuntimeEventPersistence, InMemoryRuntimeHost, ToolRegistry, registerMcpDiscovery } from '@cardbush/bush-runtime';
import { FileProviderCapabilityStore, InMemoryProviderCapabilityStore, OpenAIResponsesProvider, ModelProviderRegistry,
  modelProviderCapabilityScope, toResponsesCreateParams } from '../dist/index.js';

const model = 'fixture-model';
const scope = 'fixture-endpoint';
const profile = { scope, model, capability: 'responses_generation_compatibility' };
const registry = new ToolRegistry(); registerMcpDiscovery(registry);
const request = overrides => modelRequestSchema.parse({
  protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model,
  messages: [{ role: 'user', content: 'Hello' }], tools: registry.definitions(),
  metadata: { mcpToolDiscovery: true }, ...overrides,
});
const text = value => ({ type: 'message', id: 'msg', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: value, annotations: [] }] });
const native = body => body.tools?.some(tool => tool.type === 'tool_search');
const assistant = round => ({ role: 'assistant', content: round.text, reasoningContent: round.reasoning,
  toolCalls: round.toolCalls, providerReplay: round.providerReplay });

async function fixture(t, handler, store = new InMemoryProviderCapabilityStore()) {
  const calls = [], errors = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); calls.push({ path: req.url, body });
      const result = await handler(body, req.url, calls.length) ?? {};
      if (result.disconnect) { req.socket.destroy(); return; }
      if (result.status) {
        res.writeHead(result.status, { 'content-type': 'application/json', 'x-request-id': 'fixture-original-request' });
        res.end(JSON.stringify({ error: result.error })); return;
      }
      if (req.url.endsWith('/input_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: result.inputTokens ?? 100 })); return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
      const response = { id: `resp_${calls.length}`, created_at: 1, object: 'response', model: body.model,
        status: 'in_progress', store: Boolean(body.store), tools: body.tools, output: [], usage: null };
      emit({ type: 'response.created', response });
      if (result.partial) emit({ type: 'response.output_text.delta', delta: result.partial, item_id: 'msg', output_index: 0 });
      if (result.toolPartial) emit({ type: 'response.output_item.done', output_index: 0, item: {
        type: 'function_call', id: 'call_item', call_id: 'call_once', name: 'inspect', arguments: '{}', status: 'completed',
      } });
      if (result.sseError) emit({ type: 'error', code: 'custom_gateway_error', message: result.sseError });
      else if (!result.emptyStream) emit({ type: 'response.completed', response: {
        ...response, status: 'completed', output: result.output ?? [text('Recovered')],
      } });
      res.end();
    } catch (error) { errors.push(error); res.destroy(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); assert.deepEqual(errors, []); });
  const config = { apiKey: 'fixture-secret', baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    capabilityScope: scope, capabilityStore: store, timeoutMs: 2000 };
  return { calls, store, config, provider: new OpenAIResponsesProvider(config) };
}

test('explicit generation feature rejections fall back once with original diagnostics', async t => {
  for (const [status, code, message, param = 'tool.type'] of [
    [400, 'InvalidParameter', 'The parameter `tool.type` specified in the request are not valid: unknown tool type: tool_search.'],
    [422, 'UnrecognizedVendorCode', 'Unsupported tool type: tool_search. fixture-secret'],
    [400, 'unsupported_value', 'Unsupported request value', 'tools[0].type'],
  ]) await t.test(String(status), async t => {
    const f = await fixture(t, (_body, _path, count) => count === 1 ? { status, error: { code, param, message } } : {});
    f.store.observe({ scope, model, capability: 'response_continuation' }, { status: 'supported' });
    const diagnostics = [];
    const req = request({ providerState: { strategy: 'response_chain', previousResponseId: 'old-response', inputMessageOffset: 0 } });
    const round = await executeModelRound(f.provider, req, { onCompatibilityDiagnostic: event => diagnostics.push(event) });
    assert.equal(round.status, 'completed'); assert.equal(round.text, 'Recovered');
    assert.deepEqual(f.calls.map(call => native(call.body)), [true, false]);
    assert.equal(f.calls[0].body.previous_response_id, 'old-response');
    assert.equal(f.calls[1].body.previous_response_id, undefined); assert.equal(f.calls[1].body.store, false);
    assert.deepEqual(diagnostics.map(event => event.action), ['retry', 'recovered']);
    assert.equal(diagnostics[0].error.code, code); assert.equal(diagnostics[0].error.status, status);
    assert.equal(diagnostics[0].error.providerRequestId, 'fixture-original-request');
    assert.equal(JSON.stringify(diagnostics).includes('fixture-secret'), false);
    assert.equal(f.store.read(profile).status, 'supported');
    assert.equal(round.providerReplay.data.compatibilityMode, true);
    const peer = new OpenAIResponsesProvider(f.config);
    assert.equal((await peer.countInputTokens(req)).inputTokens, 100, 'generation compatibility does not disable a working counter');
    assert.equal(f.calls.length, 3);
    assert.equal(native(f.calls[2].body), false, 'count the actual compatible generation input');
    await executeModelRound(peer, request({ sessionId: 'another-session' }));
    assert.equal(native(f.calls[3].body), false);
    await executeModelRound(peer, request({ model: 'independent-model' }));
    await executeModelRound(new OpenAIResponsesProvider({ ...f.config, capabilityScope: 'other-endpoint' }), request());
    assert.equal(native(f.calls[4].body), true); assert.equal(native(f.calls[5].body), true);
  });
});

test('a failed compatible retry preserves both errors, never loops, and stays provisional', async t => {
  let now = 0;
  const store = new InMemoryProviderCapabilityStore({ now: () => now, ttlMs: 1000 });
  const f = await fixture(t, (_body, _path, count) => ({ status: [1, 4].includes(count) ? 400 : 401,
    error: { code: [1, 4].includes(count) ? 'InvalidParameter' : 'invalid_api_key', message: 'Unknown tool type: tool_search' } }), store);
  const diagnostics = [];
  const round = await executeModelRound(f.provider, request(), { onCompatibilityDiagnostic: event => diagnostics.push(event) });
  assert.equal(round.status, 'failed'); assert.equal(round.error.code, 'invalid_api_key');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(diagnostics.map(event => [event.action, event.error.code]), [['retry', 'InvalidParameter'], ['failed', 'invalid_api_key']]);
  await executeModelRound(f.provider, request());
  assert.equal(f.calls.length, 3, 'already compatible requests must not have an identical provider fallback retry');
  assert.equal(store.read(profile).expiresAt, new Date(1000).toISOString());
  now = 1001;
  assert.equal(store.read(profile).status, 'unknown');
  await executeModelRound(new OpenAIResponsesProvider(f.config), request({ sessionId: 'fresh-session' }));
  assert.deepEqual(f.calls.slice(3).map(call => native(call.body)), [true, false]);
});

test('compatibility binds to provider configuration and model for seven days across new sessions and restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-compatibility-binding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'capabilities.json');
  let now = 0;
  const options = { now: () => now };
  const store = new FileProviderCapabilityStore(path, options);
  const f = await fixture(t, (_body, _route, count) => count === 1 || count === 5
    ? { status: count === 1 ? 400 : 500, error: { code: 'GatewayFailure', message: 'Unknown tool type: tool_search' } } : {}, store);
  const config = { protocol: 'bush.provider_binding_config.v1', adapter: 'openai_responses',
    bindingId: 'first-binding', apiKey: f.config.apiKey, baseURL: f.config.baseURL, timeoutMs: 2000 };
  const firstRegistry = new ModelProviderRegistry({ capabilityStore: store });
  const initial = request({ providerBinding: firstRegistry.upsert(config).binding });
  assert.equal((await executeModelRound(firstRegistry, initial)).status, 'completed');
  assert.deepEqual(f.calls.map(call => native(call.body)), [true, false]);
  const identity = { ...profile, scope: modelProviderCapabilityScope(config) };
  const expiresAt = new Date(7 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(store.read(identity).expiresAt, expiresAt);

  now = Date.parse(expiresAt) - 1;
  const restartedStore = new FileProviderCapabilityStore(path, options);
  const restartedRegistry = new ModelProviderRegistry({ capabilityStore: restartedStore });
  const fresh = request({ sessionId: 'fresh-session',
    providerBinding: restartedRegistry.upsert({ ...config, bindingId: 'new-binding-same-provider' }).binding });
  assert.equal((await restartedRegistry.countInputTokens(fresh)).inputTokens, 100);
  assert.equal(f.calls.length, 3, 'the independent counting endpoint remains available');
  assert.equal((await executeModelRound(restartedRegistry, fresh)).status, 'completed');
  assert.equal(f.calls.length, 4, 'a fresh session must generate immediately without a fallback attempt');
  assert.equal(native(f.calls[3].body), false);
  assert.equal(f.calls[3].body.store, false);

  assert.equal((await executeModelRound(restartedRegistry, fresh)).status, 'failed');
  assert.equal(restartedStore.read(identity).expiresAt, expiresAt, 'reuse and service failures must not extend the seven-day expiry');
  assert.equal((await executeModelRound(restartedRegistry, request({ ...fresh, model: 'other-model' }))).status, 'completed');
  for (const [index, overrides] of [
    { apiKey: 'different-credential' },
    { baseURL: f.config.baseURL.replace('/v1', '/v2') },
    { defaultHeaders: { 'x-provider-route': 'other-backend' } },
  ].entries()) {
    const binding = restartedRegistry.upsert({ ...config, ...overrides, bindingId: `other-provider-${index}` }).binding;
    assert.equal((await executeModelRound(restartedRegistry, request({ providerBinding: binding }))).status, 'completed');
  }
  assert.deepEqual(f.calls.slice(4).map(call => native(call.body)), [false, true, true, true, true]);

  now += 1;
  const expiredStore = new FileProviderCapabilityStore(path, options);
  const expiredRegistry = new ModelProviderRegistry({ capabilityStore: expiredStore });
  const afterExpiry = request({ sessionId: 'after-expiry', providerBinding: expiredRegistry.upsert(config).binding });
  assert.equal(expiredStore.read(identity).status, 'unknown');
  assert.equal((await expiredRegistry.countInputTokens(afterExpiry)).inputTokens, 100);
  assert.equal((await executeModelRound(expiredRegistry, afterExpiry)).status, 'completed');
  assert.deepEqual(f.calls.slice(9).map(call => [call.path, native(call.body)]), [
    ['/v1/responses/input_tokens', true], ['/v1/responses', true],
  ]);
});

test('a missing counting endpoint is persisted independently across sessions and restart', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-compatibility-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'capabilities.json');
  let now = 0;
  const options = { now: () => now };
  const store = new FileProviderCapabilityStore(path, options);
  const f = await fixture(t, (_body, route) => route.endsWith('/input_tokens')
    ? { status: 404, error: { code: 'RouteMissing', message: 'no such route' } } : {}, store);
  const diagnostics = [];
  assert.equal(await f.provider.countInputTokens(request(), { onCompatibilityDiagnostic: event => diagnostics.push(event) }), undefined);
  assert.equal(diagnostics[0].action, 'local_estimate'); assert.equal(diagnostics[0].error.status, 404);
  const restarted = new OpenAIResponsesProvider({ ...f.config, capabilityStore: new FileProviderCapabilityStore(path, options) });
  assert.equal(await restarted.countInputTokens(request()), undefined);
  assert.ok(await restarted.estimateInputTokens(request()) > 0);
  assert.equal((await executeModelRound(restarted, request())).status, 'completed');
  assert.equal(f.calls.length, 2); assert.equal(native(f.calls[1].body), true);
  assert.equal(store.read(profile).status, 'unknown');
  now += 6 * 24 * 60 * 60 * 1000;
  const verifiedStore = new FileProviderCapabilityStore(path, options);
  assert.equal(verifiedStore.read({ scope, model, capability: 'input_token_count' }).expiresAt, new Date(7 * 24 * 60 * 60 * 1000).toISOString());
  const peer = new OpenAIResponsesProvider({ ...f.config, capabilityStore: verifiedStore });
  const fresh = request({ sessionId: 'fresh-session' });
  assert.equal(await peer.countInputTokens(fresh), undefined);
  assert.equal((await executeModelRound(peer, fresh)).status, 'completed');
  assert.equal(f.calls.length, 3); assert.equal(native(f.calls[2].body), true);
});

test('unclassified stream errors do not select compatibility or replay exposed text and tools', async t => {
  for (const first of [{ sseError: 'early failure' }]) await t.test(JSON.stringify(first), async t => {
    const f = await fixture(t, (_body, _path, count) => count === 1 ? first : {});
    const events = [];
    const round = await executeModelRound(f.provider, request(), { onEvent: event => events.push(event) });
    assert.equal(round.status, 'failed'); assert.equal(f.calls.length, 1);
    assert.equal(events.filter(event => event.kind === 'response_failed').length, 1);
    assert.equal(f.store.read(profile).status, 'unknown');
  });
  const f = await fixture(t, () => ({ partial: 'Already visible', sseError: 'late failure' }));
  const diagnostics = [];
  const round = await executeModelRound(f.provider, request(), { onCompatibilityDiagnostic: event => diagnostics.push(event) });
  assert.equal(round.status, 'failed'); assert.equal(round.text, 'Already visible');
  assert.equal(f.calls.length, 1); assert.equal(diagnostics[0].action, 'failed');
  assert.equal(f.store.read(profile).status, 'unknown');
  const g = await fixture(t, () => ({ toolPartial: true, sseError: 'tool stream failed' }));
  assert.equal((await executeModelRound(g.provider, request())).status, 'failed');
  assert.equal(g.calls.length, 1, 'an exposed tool call must not be replayed by compatibility retry');
});

test('temporary HTTP, socket and incomplete-stream failures retain the protocol for runtime retries', async t => {
  for (const first of [{ status: 429, error: { code: 'rate_limit', message: 'busy' } },
    { status: 503, error: { code: 'unavailable', message: 'busy' } }, { disconnect: true }, { emptyStream: true }]) {
    await t.test(JSON.stringify(first), async t => {
      const f = await fixture(t, (_body, _path, count) => count === 1 ? first : {});
      const diagnostics = [];
      const initial = request();
      const failed = await executeModelRound(f.provider, initial, { onCompatibilityDiagnostic: event => diagnostics.push(event) });
      assert.equal(failed.status, 'failed'); assert.equal(failed.error.retryable, true);
      assert.equal(f.calls.length, 1); assert.deepEqual(diagnostics, []);
      assert.equal(f.store.read(profile).status, 'unknown');
      assert.equal((await executeModelRound(f.provider, initial)).status, 'completed');
      assert.deepEqual(f.calls[1].body, f.calls[0].body, 'recovery must not change the tool schema or request prefix');
    });
  }
});

test('a temporary token-count outage does not downgrade generation', async t => {
  const f = await fixture(t, (_body, route) => route.endsWith('/input_tokens')
    ? { status: 503, error: { code: 'upstream_down', message: 'try later' } } : {});
  assert.equal(await f.provider.countInputTokens(request()), undefined);
  assert.equal(f.store.read(profile).status, 'unknown');
  assert.equal((await executeModelRound(f.provider, request())).status, 'completed');
  assert.ok(native(f.calls.at(-1).body));
});

test('404/405/501 counting facts preserve generation bytes, scope and expiry across restart', async t => {
  for (const status of [404, 405, 501]) await t.test(String(status), async t => {
    const root = await mkdtemp(join(tmpdir(), 'cardbush-count-capability-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 'capabilities.json');
    let now = 0;
    const options = { now: () => now, ttlMs: 1000 };
    const store = new FileProviderCapabilityStore(path, options);
    const f = await fixture(t, (_body, route) => route.endsWith('/input_tokens')
      ? { status, error: { code: 'counter_unavailable', message: 'Counting is unavailable' } } : {}, store);
    store.observe({ scope, model, capability: 'response_continuation' }, { status: 'supported' });
    const req = request({
      providerState: { strategy: 'response_chain', previousResponseId: 'retained-response', inputMessageOffset: 0 },
      messages: [...request().messages,
        { role: 'assistant', content: '', toolCalls: [{ id: 'image', name: 'view_image', argumentsText: '{}' }] },
        { role: 'tool', toolCallId: 'image', content: 'Screenshot', images: [{ url: 'https://example.test/image.png' }] }],
    });
    const original = structuredClone(req);
    assert.equal((await executeModelRound(f.provider, req)).status, 'completed');
    const before = structuredClone(f.calls.at(-1).body);
    assert.equal(await f.provider.countInputTokens(req), undefined);
    const counter = { scope, model, capability: 'input_token_count' };
    assert.equal(store.read(counter).status, 'unsupported');
    assert.equal(store.read(profile).status, 'unknown');

    const restartedStore = new FileProviderCapabilityStore(path, options);
    const restarted = new OpenAIResponsesProvider({ ...f.config, capabilityStore: restartedStore });
    now = 999;
    assert.equal(await restarted.countInputTokens(request({ sessionId: 'another-session' })), undefined);
    assert.equal(restartedStore.read(counter).expiresAt, new Date(1000).toISOString());
    assert.equal((await executeModelRound(restarted, req)).status, 'completed');
    assert.deepEqual(f.calls.at(-1).body, before, 'count failure must not alter native tools, continuation, store or prefix');
    assert.deepEqual(req, original);
    const probes = () => f.calls.filter(call => call.path.endsWith('/input_tokens')).length;
    assert.equal(probes(), 1);
    await restarted.countInputTokens(request({ model: 'other-model' }));
    await new OpenAIResponsesProvider({ ...f.config, capabilityStore: restartedStore, capabilityScope: 'other-endpoint' }).countInputTokens(req);
    assert.equal(probes(), 3, 'unrelated models and connections retain their own counter');
    now = 1000;
    await restarted.countInputTokens(req);
    assert.equal(probes(), 4, 'expiry allows a new probe without a cumulative cooldown');
  });
});

test('auth, temporary and input-specific counting errors remain recoverable without capability pollution', async t => {
  for (const status of [400, 401, 403, 408, 429, 500, 503]) await t.test(String(status), async t => {
    let recovered = false;
    const f = await fixture(t, (_body, route) => !recovered && route.endsWith('/input_tokens')
      ? { status, error: { code: 'counter_error', message: 'Unknown tool type: tool_search' } } : {});
    assert.equal(await f.provider.countInputTokens(request()), undefined);
    assert.equal(f.store.read({ scope, model, capability: 'input_token_count' }).status, 'unknown');
    assert.equal(f.store.read(profile).status, 'unknown');
    assert.equal((await executeModelRound(f.provider, request())).status, 'completed');
    assert.ok(native(f.calls.at(-1).body));
    recovered = true;
    assert.equal((await f.provider.countInputTokens(request())).inputTokens, 100);
  });
});

test('ordinary HTTP failures cannot establish generation incompatibility even with misleading error codes', async t => {
  for (const status of [400, 401, 403, 404, 422, 429, 500, 501, 505]) await t.test(String(status), async t => {
    const validation = status === 400 || status === 422;
    const f = await fixture(t, () => ({ status, error: { code: validation ? 'invalid_input' : 'unsupported_tool_type',
      message: validation ? 'Malformed request' : 'Unknown tool type: tool_search' } }));
    const round = await executeModelRound(f.provider, request());
    assert.equal(round.status, 'failed');
    assert.equal(f.calls.length, 1);
    assert.equal(f.store.read(profile).status, 'unknown');
  });
});

test('explicit continuation, storage and tool-image rejections require the feature on the wire', async t => {
  const cases = [
    { feature: 'previous_response_id', overrides: { providerState: { strategy: 'response_chain', previousResponseId: 'previous', inputMessageOffset: 0 } },
      verify: body => assert.equal(body.previous_response_id, undefined) },
    { feature: 'store', overrides: { providerState: { strategy: 'response_chain' } },
      verify: body => assert.equal(body.store, false) },
    { feature: 'input_image in function_call_output', overrides: { messages: [
      ...request().messages,
      { role: 'assistant', content: '', toolCalls: [{ id: 'image', name: 'view_image', argumentsText: '{}' }] },
      { role: 'tool', toolCallId: 'image', content: 'Screenshot', images: [{ url: 'https://example.test/image.png' }] },
    ] }, verify: body => {
      assert.equal(body.input.at(-2).output, 'Screenshot');
      assert.equal(body.input.at(-1).role, 'user');
      assert.equal(body.input.at(-1).content[1].image_url, 'https://example.test/image.png');
    } },
  ];
  for (const { feature, overrides, verify } of cases) await t.test(feature, async t => {
    const f = await fixture(t, (_body, _route, count) => count === 1
      ? { status: 400, error: { code: 'unsupported_parameter', message: `Unsupported ${feature}` } } : {});
    f.store.observe({ scope, model, capability: 'response_continuation' }, { status: 'supported' });
    const req = request({ tools: [], metadata: {}, ...overrides });
    const original = structuredClone(req);
    const round = await executeModelRound(f.provider, req);
    assert.equal(round.status, 'completed');
    assert.equal(f.calls.length, 2);
    assert.deepEqual(req, original);
    verify(f.calls.at(-1).body);

    const absent = await fixture(t, () => ({ status: 400,
      error: { code: 'unsupported_parameter', message: `Unsupported ${feature}` } }));
    assert.equal((await executeModelRound(absent.provider, request({ tools: [], metadata: {} }))).status, 'failed');
    assert.equal(absent.calls.length, 1, 'a rejected but absent feature cannot change the request');
    assert.equal(absent.store.read(profile).status, 'unknown');
  });
});

test('an explicit early stream rejection can fall back once without duplicating the start event', async t => {
  const f = await fixture(t, (_body, _route, count) => count === 1 ? { sseError: 'Unknown tool type: tool_search' } : {});
  const events = [];
  const round = await executeModelRound(f.provider, request(), { onEvent: event => events.push(event) });
  assert.equal(round.status, 'completed');
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls.map(call => native(call.body)), [true, false]);
  assert.equal(events.filter(event => event.kind === 'response_started').length, 1);
  assert.deepEqual(events.map(event => event.sequence), events.map((_, index) => index));
});

test('a feature rejection after visible text or tools affects only future requests', async t => {
  for (const exposed of [{ partial: 'Already visible' }, { toolPartial: true }]) await t.test(JSON.stringify(exposed), async t => {
    const f = await fixture(t, () => ({ ...exposed, sseError: 'Unknown tool type: tool_search' }));
    const diagnostics = [];
    assert.equal((await executeModelRound(f.provider, request(), { onCompatibilityDiagnostic: event => diagnostics.push(event) })).status, 'failed');
    assert.equal(f.calls.length, 1, 'never replay an attempt after exposing text or tools');
    assert.equal(f.store.read(profile).status, 'supported');
    assert.equal(diagnostics[0].action, 'next_request');
  });
});

test('native history converts losslessly, tool images follow complete batches, and compatibility pins across TTL', async t => {
  let now = 0;
  const store = new InMemoryProviderCapabilityStore({ now: () => now, ttlMs: 1000 });
  const search = { type: 'tool_search_call', id: 'search_item', call_id: 'search', execution: 'client', status: 'completed', arguments: { query: 'docs' } };
  const reasoning = { type: 'reasoning', id: 'reason', summary: [], encrypted_content: 'opaque-reasoning' };
  const f = await fixture(t, (_body, _path, count) => count === 1 ? { output: [reasoning, search] }
    : count === 2 ? { status: 400, error: { code: 'ChangedBackend', message: 'Unknown tool type: tool_search' } } : {}, store);
  const first = request();
  const round = await executeModelRound(f.provider, first);
  const messages = [...first.messages, assistant(round), { role: 'tool', toolCallId: 'search', content: JSON.stringify({
    protocol: 'bush.mcp_discovery.v1', sessionId: 's', action: 'load', matches: [], total: 0, more: false,
  }) }, { role: 'assistant', content: '', toolCalls: [
    { id: 'image', name: 'view_image', argumentsText: '{}' }, { id: 'other', name: 'inspect', argumentsText: '{}' },
  ] }, { role: 'tool', toolCallId: 'image', content: 'image receipt', images: [{ url: 'https://example.test/image.png', detail: 'high' }] },
  { role: 'tool', toolCallId: 'other', content: 'other receipt' }];
  const next = request({ messages }); const original = structuredClone(next);
  const recovered = await executeModelRound(f.provider, next);
  assert.equal(recovered.status, 'completed'); assert.deepEqual(next, original);
  const portable = f.calls[2].body;
  assert.ok(portable.input.every(item => !['tool_search_call', 'tool_search_output', 'additional_tools'].includes(item.type)));
  assert.deepEqual(portable.input.find(item => item.type === 'reasoning'), reasoning);
  assert.deepEqual(portable.input.find(item => item.type === 'function_call' && item.call_id === 'search'), {
    type: 'function_call', call_id: 'search', name: 'mcp_search', arguments: '{"query":"docs"}',
  });
  assert.deepEqual(portable.input.slice(-3).map(item => item.type), ['function_call_output', 'function_call_output', 'message']);
  assert.equal(portable.input.at(-3).output, 'image receipt');
  assert.match(portable.input.at(-1).content[0].text, /"call_id":"image"/);
  assert.equal(portable.input.at(-1).content[1].image_url, 'https://example.test/image.png');
  now = 2000;
  const continued = request({ messages: [...messages, assistant(recovered), { role: 'user', content: 'Continue' }] });
  await executeModelRound(new OpenAIResponsesProvider(f.config), continued);
  assert.deepEqual(f.calls[3].body.input.slice(0, portable.input.length), portable.input);
  assert.equal(native(f.calls[3].body), false);
  assert.equal(toResponsesCreateParams(continued).store, false);
});

test('cancellation and local validation never select compatibility or submit retries', async t => {
  const f = await fixture(t, () => ({}));
  const controller = new AbortController(); controller.abort();
  assert.equal((await executeModelRound(f.provider, request(), { signal: controller.signal })).status, 'failed');
  await assert.rejects(() => f.provider.countInputTokens(request(), { signal: controller.signal }));
  const bounded = new OpenAIResponsesProvider({ ...f.config, maxRequestBodyBytes: 1 });
  assert.equal((await executeModelRound(bounded, request())).status, 'failed');
  assert.equal(f.calls.length, 0); assert.equal(f.store.read(profile).status, 'unknown');
});

test('Runtime journals original failures and successful recovery for both counting and generation', async t => {
  for (const failAt of ['count', 'generation']) await t.test(failAt, async t => {
    const f = await fixture(t, (_body, path, count) => (failAt === 'count' ? path.endsWith('/input_tokens') : count === 2)
      ? { status: 400, error: { code: 'InvalidParameter', message: 'unknown tool type: tool_search' } } : {});
    const root = await mkdtemp(join(tmpdir(), 'cardbush-compatibility-journal-'));
    const persistence = new FileRuntimeEventPersistence({ root });
    const host = new InMemoryRuntimeHost({ provider: f.provider, eventLogOptions: { persistence }, maxAttempts: 1, registerDefaultWorkspaceTools: false });
    t.after(async () => { await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); await rm(root, { recursive: true, force: true }); });
    const result = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model, tools: registry.definitions(),
      inputMessages: [{ messageId: 'hello', message: { role: 'user', content: 'Hello' } }], prefixMessages: [],
      maxOutputTokens: 1000, metadata: { contextWindowTokens: 100000, mcpToolDiscovery: true } });
    assert.equal(result.payload.status, 'completed');
    const events = host.events('s', 't').filter(event => event.kind === 'provider_compatibility');
    assert.equal(events[0].payload.error.code, 'InvalidParameter');
    assert.equal(events[0].payload.error.status, 400);
    if (failAt === 'generation') assert.deepEqual(events.map(event => event.payload.action), ['retry', 'recovered']);
    const restored = new FileRuntimeEventPersistence({ root });
    assert.ok(restored.load('s', 't').some(event => event.kind === 'provider_compatibility'));
  });
});
