import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { modelRequestSchema } from '@cardbush/bush-protocol';
import { executeModelRound, FileSessionEventPersistence, InMemoryRuntimeHost, SessionStore, ToolRegistry, registerMcpDiscovery, projectMcpDiscoveryResult } from '@cardbush/bush-runtime';
import { InMemoryProviderCapabilityStore, normalizeResponseStreamEvent, OpenAIResponsesProvider, toResponsesCreateParams } from '../dist/index.js';

const scope = 'arbitrary-service', model = 'arbitrary-model-714';
const capability = { scope, model, capability: 'client_tool_search' };
const registry = new ToolRegistry(); registerMcpDiscovery(registry);
const request = overrides => modelRequestSchema.parse({
  protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model,
  tools: registry.definitions(), messages: [{ role: 'user', content: 'Find project documentation.' }],
  metadata: { mcpToolDiscovery: true }, ...overrides,
});
const textItem = (text = 'Done.') => ({ type: 'message', id: 'msg', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }] });
const searchItem = (id = 'search') => ({ type: 'tool_search_call', id: `ts_${id}`, call_id: id,
  execution: 'client', status: 'completed', arguments: { query: 'docs' } });
const functionItem = (id = 'read', name = 'mcp__docs__read') => ({ type: 'function_call', id: `fc_${id}`, call_id: id,
  name, arguments: '{}', status: 'completed' });
const assistant = round => ({ role: 'assistant', content: round.text, reasoningContent: round.reasoning,
  toolCalls: round.toolCalls, providerReplay: round.providerReplay });
const tool = { name: 'mcp__docs__read', description: 'Read docs', inputSchema: { type: 'object', properties: {} } };
const searchResult = matches => JSON.stringify({ protocol: 'bush.mcp_discovery.v1', sessionId: 's',
  matches: matches ?? [{ ...tool, server: 'docs', tool: 'read', revision: 'v1' }], total: 1, more: false });
const unsupported = { status: 400, error: { code: 'unsupported_value', param: 'tools[0].type',
  message: "The tool type 'tool_search' is not supported." } };
const isNative = body => body.tools?.some(tool => tool.type === 'tool_search');

function assertClosedToolBatches(items) {
  const pending = new Map();
  for (const item of items) {
    if (item.type === 'function_call' || item.type === 'tool_search_call') {
      assert.equal(pending.has(item.call_id), false, `Duplicate call ${item.call_id}`);
      pending.set(item.call_id, item.type);
    } else if (item.type === 'function_call_output' || item.type === 'tool_search_output') {
      assert.equal(pending.get(item.call_id), item.type === 'tool_search_output' ? 'tool_search_call' : 'function_call', `Unmatched output ${item.call_id}`);
      pending.delete(item.call_id);
    } else if ((item.type === 'message' && item.role !== 'assistant') || item.type === 'additional_tools') {
      assert.deepEqual([...pending.keys()], [], 'Context must not interrupt a pending tool result batch');
    }
  }
  assert.deepEqual([...pending.keys()], [], 'Every call must have an output');
}

function declaredNames(params) {
  return [...(params.tools ?? []), ...params.input.flatMap(item =>
    item.type === 'tool_search_output' || item.type === 'additional_tools' ? item.tools : [])]
    .filter(tool => tool.type === 'function').map(tool => tool.name);
}

function searchMessages(id, matches) {
  return [
    { role: 'assistant', content: '', toolCalls: [{ id, name: 'mcp_search', argumentsText: '{"query":"docs","reload":true}' }] },
    { role: 'tool', toolCallId: id, content: searchResult(matches) },
  ];
}

async function fixture(t, handler) {
  const calls = [], failures = [];
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw); calls.push({ path: req.url, body });
      const result = await handler(body, req.url);
      if (result?.error) {
        res.writeHead(result.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: result.error })); return;
      }
      if (req.url.endsWith('/input_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'response.input_tokens', input_tokens: 100 })); return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      let sequence = 0;
      const emit = event => res.write(`data: ${JSON.stringify({ sequence_number: sequence++, ...event })}\n\n`);
      const output = result?.output ?? [textItem()];
      const response = { id: `resp_${calls.length}`, object: 'response', model: body.model,
        created_at: 1, status: 'in_progress', store: result?.store ?? false,
        tools: result?.echoTools === false ? [] : body.tools, output: [], usage: null };
      emit({ type: 'response.created', response });
      for (const [output_index, item] of output.entries()) {
        emit({ type: 'response.output_item.added', output_index,
          item: item.type === 'tool_search_call' ? { ...item, status: 'in_progress', arguments: {} } : item });
        if (item.type === 'message') emit({ type: 'response.output_text.delta', delta: item.content[0].text });
        if (item.type === 'function_call') emit(result?.argumentsDoneOnly
          ? { type: 'response.function_call_arguments.done', output_index, item_id: item.id, name: item.name, arguments: item.arguments }
          : { type: 'response.function_call_arguments.delta', output_index, delta: item.arguments });
        if (!result?.terminalOnlySearch) emit({ type: 'response.output_item.done', output_index, item });
      }
      if (result?.streamError) emit({ type: 'error', ...result.streamError });
      else emit({ type: 'response.completed', response: { ...response, status: 'completed', output: result?.snapshotOutput ?? output } });
      res.end();
    } catch (error) { failures.push(error); res.writeHead(500); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.deepEqual(failures, []); });
  const store = new InMemoryProviderCapabilityStore();
  const config = { apiKey: 'fixture-only', baseURL: `http://127.0.0.1:${server.address().port}/v1`, capabilityScope: scope, capabilityStore: store };
  return { calls, store, config, provider: new OpenAIResponsesProvider(config) };
}

test('unknown services negotiate native search, preserve output and append callable schemas', async t => {
  const f = await fixture(t, () => ({ output: [searchItem()] }));
  const first = request();
  const round = await executeModelRound(f.provider, first);
  assert.equal(round.status, 'completed');
  assert.deepEqual(round.toolCalls.map(call => [call.name, call.argumentsText]), [['mcp_search', '{"query":"docs"}']]);
  assert.equal(f.store.read(capability).status, 'supported');
  assert.equal(round.providerReplay.data.toolSearchMode, 'native');
  assert.equal(f.calls[0].body.tools.some(tool => tool.name === 'mcp_call'), false);
  const messages = [...first.messages, assistant(round), { role: 'tool', toolCallId: 'search', content: searchResult() }];
  const original = structuredClone(messages);
  const params = toResponsesCreateParams(request({ messages }));
  assert.deepEqual(params.input[1], searchItem());
  assert.equal(params.input[2].type, 'tool_search_output');
  assert.equal(params.input[2].tools[0].name, tool.name);
  assert.equal(params.input[2].tools[0].defer_loading, true);
  assert.equal(params.input[3].content.includes('inputSchema'), false);
  const delta = toResponsesCreateParams(request({ messages, providerState: {
    strategy: 'response_chain', previousResponseId: 'stored', inputMessageOffset: 2,
  } }));
  assert.deepEqual(delta.input, params.input.slice(2));
  assert.deepEqual(messages, original);
});

test('native tool_search keeps the compact hit directory and publishes only complete budgeted definitions', async t => {
  const f = await fixture(t, () => ({ output: [searchItem()] }));
  const first = request(), round = await executeModelRound(f.provider, first);
  const large = { ...tool, name: 'mcp__docs__large', description: 'x'.repeat(20000), server: 'docs', tool: 'large', revision: 'v2' };
  const content = projectMcpDiscoveryResult(searchResult([{ ...tool, server: 'docs', tool: 'read', revision: 'v1' }, large]));
  const messages = [...first.messages, assistant(round), { role: 'tool', toolCallId: 'search', content }];
  const original = structuredClone(messages), params = toResponsesCreateParams(request({ messages }));
  const output = params.input.find(item => item.type === 'tool_search_output');
  assert.deepEqual(output.tools.map(tool => tool.name), [tool.name]);
  const receipt = params.input.find(item => item.type === 'message' && typeof item.content === 'string' && item.content.startsWith('[tool_search_result data]'));
  assert.ok(receipt.content.includes(large.name));
  assert.ok(receipt.content.includes('unloaded'));
  assert.ok(receipt.content.includes('catalog'));
  assertClosedToolBatches(params.input);
  assert.deepEqual(messages, original);
});

test('mixed native search and function batches remain complete before search receipts in full and incremental requests', async t => {
  const archived = JSON.stringify({ archived: true, locator: 'tool-result://s/t/search', originalChars: 50000, preview: 'Search results' });
  for (const [label, content] of [['complete', searchResult()], ['archived', archived], ['error', '{"error":"Search unavailable"}']]) {
    await t.test(label, async t => {
      const output = [functionItem('skills', 'search_skills'), searchItem(), functionItem('terminal', 'terminal_exec')];
      let firstRequest = true;
      const f = await fixture(t, body => {
        if (firstRequest) { firstRequest = false; return { output, store: true }; }
        assertClosedToolBatches([...(body.previous_response_id ? output : []), ...body.input]);
        return { store: true };
      });
      const first = request({ providerState: { strategy: 'response_chain' } });
      const round = await executeModelRound(f.provider, first);
      assert.equal(round.status, 'completed');
      const messages = [...first.messages, assistant(round),
        { role: 'tool', toolCallId: 'skills', content: 'Skills found' },
        { role: 'tool', toolCallId: 'search', content },
        { role: 'tool', toolCallId: 'terminal', content: 'Command exited successfully' }];
      const original = structuredClone(messages);
      assert.equal((await executeModelRound(f.provider, request({ messages }))).status, 'completed');
      assert.equal((await executeModelRound(f.provider, request({ messages, providerState: {
        strategy: 'response_chain', previousResponseId: 'resp_1', inputMessageOffset: 2,
      } }))).status, 'completed');
      const full = f.calls[1].body.input, tail = f.calls[2].body.input;
      assert.deepEqual(tail, full.slice(1 + output.length));
      assert.deepEqual(tail.map(item => item.type), ['function_call_output', 'tool_search_output', 'function_call_output', 'message']);
      assert.equal(tail[2].output, messages.at(-1).content);
      assert.equal(tail[1].tools.length, label === 'complete' ? 1 : 0);
      assert.ok(tail[3].content.includes('call_id: "search"'));
      assert.deepEqual(messages, original);
      const extended = toResponsesCreateParams(request({ messages: [...messages, { role: 'user', content: 'Continue' }] })).input;
      assert.deepEqual(extended.slice(0, full.length), full);
    });
  }
});

test('multiple search receipts wait for the entire batch, preserve attribution and append after a partial snapshot', () => {
  const messages = [{ role: 'assistant', content: '', toolCalls: [
    { id: 'first-search', name: 'mcp_search', argumentsText: '{}' },
    { id: 'local', name: 'local_read', argumentsText: '{}' },
    { id: 'second-search', name: 'mcp_search', argumentsText: '{}' },
  ] },
  { role: 'tool', toolCallId: 'second-search', content: '{"error":"Second search unavailable"}' },
  { role: 'tool', toolCallId: 'first-search', content: searchResult() }];
  const project = overrides => toResponsesCreateParams(request({ messages, ...overrides }), { toolSearchMode: 'native' }).input;
  const partial = project();
  assert.equal(partial.some(item => item.type === 'message'), false);
  messages.push({ role: 'tool', toolCallId: 'local', content: 'Read completed' });
  const complete = project();
  assertClosedToolBatches(complete);
  assert.deepEqual(complete.slice(0, partial.length), partial);
  assert.deepEqual(complete.slice(-3).map(item => item.type), ['function_call_output', 'message', 'message']);
  assert.match(complete.at(-2).content, /call_id: "second-search"/);
  assert.match(complete.at(-1).content, /call_id: "first-search"/);
  assert.deepEqual(project({ providerState: { strategy: 'response_chain', previousResponseId: 'stored', inputMessageOffset: 3 } }), complete.slice(partial.length));
});

test('terminal-only search calls are normalized once and preserve call identity', async t => {
  const f = await fixture(t, () => ({ output: [searchItem()], terminalOnlySearch: true }));
  const round = await executeModelRound(f.provider, request());
  assert.equal(round.status, 'completed'); assert.equal(round.toolCalls.length, 1);
  assert.equal(round.toolCalls[0].id, 'search');
});

test('incomplete terminal snapshots retain the accepted protocol without inventing replay output', async t => {
  const f = await fixture(t, () => ({ output: [textItem()], snapshotOutput: [] }));
  const first = request(), round = await executeModelRound(f.provider, first);
  assert.equal(round.status, 'completed');
  assert.deepEqual(round.providerReplay.data.items, []);
  const next = request({ messages: [...first.messages, assistant(round), { role: 'user', content: 'Continue' }] });
  await executeModelRound(new OpenAIResponsesProvider({ ...f.config, capabilityStore: new InMemoryProviderCapabilityStore() }), next);
  assert.equal(isNative(f.calls[1].body), true);
  assert.equal(f.calls[1].body.input[1].content, 'Done.');
});

test('native search validates completed identities and treats argument property order as equivalent', () => {
  const state = { requestId: 'r', sequence: 0, started: false, toolSearchMode: 'native' };
  const first = { ...searchItem(), arguments: { server: 'docs', query: '*' } };
  normalizeResponseStreamEvent({ type: 'response.output_item.done', output_index: 0, item: first }, state);
  const completed = normalizeResponseStreamEvent({ type: 'response.completed', response: {
    output: [{ ...first, arguments: { query: '*', server: 'docs' } }], created_at: 1,
  } }, state);
  assert.equal(completed.at(-1).kind, 'response_completed');
  assert.equal(completed.some(event => event.kind === 'tool_call_delta'), false);
  for (const item of [{ ...searchItem(), arguments: 'invalid' }, { ...searchItem(), execution: 'server' },
    { ...searchItem(), call_id: null }, { ...searchItem(), status: 'incomplete' }]) {
    const events = normalizeResponseStreamEvent({ type: 'response.output_item.done', output_index: 0, item },
      { requestId: 'r', sequence: 0, started: false, toolSearchMode: 'native' });
    assert.equal(events.at(-1).kind, 'response_failed');
    assert.equal(events.some(event => event.kind === 'tool_call_delta'), false);
  }
});

test('cancellation and an ignored tool declaration do not establish support', async t => {
  const f = await fixture(t, () => ({ echoTools: false }));
  const controller = new AbortController(); controller.abort();
  assert.equal((await executeModelRound(f.provider, request(), { signal: controller.signal })).status, 'failed');
  assert.equal(f.calls.length, 0); assert.equal(f.store.read(capability).status, 'unknown');
  assert.equal((await executeModelRound(f.provider, request())).status, 'completed');
  assert.equal(f.store.read(capability).status, 'unknown');
});

test('explicit rejection falls back once, caches the fact, and pins portable history beyond TTL', async t => {
  const f = await fixture(t, body => isNative(body) ? unsupported : {});
  let now = 0;
  const capabilities = new InMemoryProviderCapabilityStore({ now: () => now, ttlMs: 1000 });
  const provider = new OpenAIResponsesProvider({ ...f.config, capabilityStore: capabilities });
  const first = request(), round = await executeModelRound(provider, first);
  assert.equal(round.status, 'completed');
  assert.deepEqual(f.calls.map(call => isNative(call.body)), [true, false]);
  assert.equal(capabilities.read(capability).status, 'unsupported');
  const history = [...first.messages, assistant(round), { role: 'user', content: 'Continue' }];
  now = 2000;
  const restarted = new OpenAIResponsesProvider({ ...f.config, capabilityStore: capabilities });
  assert.equal((await executeModelRound(restarted, request({ turnId: 'next', messages: history }))).status, 'completed');
  assert.equal(isNative(f.calls.at(-1).body), false);
  assert.deepEqual(f.calls.at(-1).body.input.slice(0, f.calls[1].body.input.length), f.calls[1].body.input);
  await executeModelRound(restarted, request({ sessionId: 'new-context' }));
  assert.deepEqual(f.calls.slice(-2).map(call => isNative(call.body)), [true, false]);
  const freshProvider = new OpenAIResponsesProvider({ ...f.config, capabilityStore: capabilities });
  await executeModelRound(freshProvider, request({ sessionId: 'another-context' }));
  assert.equal(isNative(f.calls.at(-1).body), false);
});

test('authentication, rate limits, outages and schema mistakes never become unsupported capability facts', async t => {
  for (const failure of [
    ...[401, 403, 429, 500].map(status => ({ ...unsupported, status })),
    { status: 400, error: { code: 'invalid_value', param: 'tools[0].parameters', message: 'Invalid tool_search schema: unsupported property' } },
    { status: 400, error: { code: 'invalid_request_error', message: 'Invalid context' } },
  ]) {
    await t.test(`${failure.status} ${failure.error.param ?? ''}`, async t => {
      const f = await fixture(t, () => failure);
      assert.equal((await executeModelRound(f.provider, request())).status, 'failed');
      assert.equal(f.calls.length, 1); assert.equal(f.store.read(capability).status, 'unknown');
    });
  }
});

test('accepted streams never retry under another protocol, and native history cannot silently downgrade', async t => {
  let reject = false;
  const f = await fixture(t, () => reject ? unsupported : { output: [searchItem()] });
  const first = request(), round = await executeModelRound(f.provider, first);
  reject = true;
  const next = request({ messages: [...first.messages, assistant(round), { role: 'tool', toolCallId: 'search', content: searchResult() }] });
  assert.equal((await executeModelRound(f.provider, next)).status, 'failed');
  assert.equal(f.calls.length, 2);
  assert.equal(isNative(f.calls[1].body), true);
  assert.equal(f.store.read(capability).status, 'unsupported');
  const g = await fixture(t, () => ({ output: [textItem('Partial')], streamError: { code: 'unsupported_tool_type', message: 'tool_search is unsupported' } }));
  assert.equal((await executeModelRound(g.provider, request())).status, 'failed');
  assert.equal(g.calls.length, 1);
});

test('token counting and generation negotiate independently without an extra model probe', async t => {
  const f = await fixture(t, body => isNative(body) ? unsupported : {});
  assert.equal(await f.provider.countInputTokens(request()), undefined);
  assert.equal(f.calls.length, 1); assert.ok(f.calls.every(call => call.path.endsWith('/input_tokens')));
  assert.equal(f.store.read(capability).status, 'unknown');
  assert.equal(await f.provider.countInputTokens(request()), undefined);
  assert.equal(f.calls.length, 1);
  assert.equal((await executeModelRound(f.provider, request())).status, 'completed');
  assert.equal(f.calls.length, 3); assert.equal(isNative(f.calls.at(-1).body), false);
  const g = await fixture(t, (_body, path) => path.endsWith('/input_tokens') ? unsupported : { output: [searchItem()] });
  assert.equal(await g.provider.countInputTokens(request()), undefined);
  assert.equal((await executeModelRound(g.provider, request())).status, 'completed');
  assert.equal(g.calls.length, 2); assert.equal(g.store.read(capability).status, 'supported');
});

test('archived search definitions are injected only after all exact chunks, preserving earlier input', () => {
  const messages = [
    { role: 'assistant', content: '', toolCalls: [{ id: 'search', name: 'mcp_search', argumentsText: '{"query":"docs"}' }] },
    { role: 'tool', toolCallId: 'search', content: '' },
  ];
  const text = searchResult(), midpoint = Math.floor(text.length / 2), locator = 'tool-result://s/t/search';
  messages[1].content = JSON.stringify({ archived: true, locator, originalChars: text.length, preview: text.slice(0, 40) });
  const project = () => toResponsesCreateParams(request({ messages }), { toolSearchMode: 'native' }).input;
  const initial = project(); assert.deepEqual(initial[1].tools, []);
  for (const [offset, end] of [[0, midpoint], [midpoint, text.length]]) {
    messages.push({ role: 'assistant', content: '', toolCalls: [{ id: `page-${offset}`, name: 'read_archived_tool_result', argumentsText: '{}' }] },
      { role: 'tool', toolCallId: `page-${offset}`, content: JSON.stringify({ locator, offset, next_offset: end }) + '\n\n[text]\n' + text.slice(offset, end) });
    const items = project();
    assert.deepEqual(items.slice(0, initial.length), initial);
    assert.equal(items.filter(item => item.type === 'additional_tools').length, end === text.length ? 1 : 0);
  }
  assert.equal(project().at(-1).tools[0].name, tool.name);
  messages.splice(2, 2);
  assert.equal(project().some(item => item.type === 'additional_tools'), false);
});

test('archived definitions loaded during a mixed batch follow every function result', () => {
  const content = searchResult(), locator = 'tool-result://s/t/search';
  const messages = [
    { role: 'assistant', content: '', toolCalls: [{ id: 'search', name: 'mcp_search', argumentsText: '{}' }] },
    { role: 'tool', toolCallId: 'search', content: JSON.stringify({ archived: true, locator, originalChars: content.length, preview: '' }) },
    { role: 'assistant', content: '', toolCalls: [
      { id: 'archive', name: 'read_archived_tool_result', argumentsText: '{}' },
      { id: 'local', name: 'local_read', argumentsText: '{}' },
    ] },
    { role: 'tool', toolCallId: 'archive', content: JSON.stringify({ locator, offset: 0, next_offset: content.length }) + '\n\n[text]\n' + content },
    { role: 'tool', toolCallId: 'local', content: 'Read completed' },
  ];
  const input = toResponsesCreateParams(request({ messages }), { toolSearchMode: 'native' }).input;
  assertClosedToolBatches(input);
  assert.deepEqual(input.slice(-3).map(item => item.type), ['function_call_output', 'function_call_output', 'additional_tools']);
  assert.equal(input.at(-1).tools[0].name, tool.name);
});

test('portable history and malformed discovery data never acquire invented native definitions', () => {
  const messages = [{ role: 'assistant', content: '', toolCalls: [{ id: 'search', name: 'mcp_search', argumentsText: '{}' }] },
    { role: 'tool', toolCallId: 'search', content: searchResult() }];
  assert.equal(toResponsesCreateParams(request({ messages })).input[1].type, 'function_call_output');
  for (const content of ['not json', '{"error":"permission denied"}', searchResult([{ name: 'bad' }]), searchResult().replace('"s"', '"other-session"')]) {
    const native = toResponsesCreateParams(request({ messages: [messages[0], { ...messages[1], content }] }), { toolSearchMode: 'native' });
    assert.deepEqual(native.input[1].tools, []);
  }
});

test('native calls use the authoritative execution pipeline and survive durable restart with stable wire prefixes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-native-discovery-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-native-discovery-')); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  let round = 0, executed = 0, revoked = false, loadedName;
  const longTool = { ...tool, name: `mcp__${'plugin_identifier_'.repeat(5)}__read_docs` };
  const f = await fixture(t, (body, path) => {
    if (path.endsWith('/input_tokens')) return {};
    round++;
    if (round === 1) return { output: [searchItem()] };
    loadedName ??= body.input.find(item => item.type === 'tool_search_output')?.tools[0]?.name;
    if ([2, 4, 6].includes(round)) return { output: [functionItem(`read-${round}`, loadedName)], argumentsDoneOnly: true };
    return { output: [textItem()] };
  });
  const create = (extra = false) => {
    const tools = new ToolRegistry();
    const registration = { definition: longTool, manifest: { effect_kind: 'observation', operation: 'test.read', risk: 'low', owner: 'test', dispatch_scope: 'parent_session', mutating: false },
      decodeInput: value => value, execute: () => { executed++; return { value: 'docs' }; },
      authorize: () => revoked ? { kind: 'deny', code: 'revoked', message: 'Permission revoked' } : { kind: 'allow' },
      mcpHook: { server: 'docs', tool: 'read', call: async () => ({}) } };
    tools.register(registration);
    if (extra) tools.register({ ...registration, definition: { ...tool, name: 'mcp__other__read' }, mcpHook: { ...registration.mcpHook, server: 'other' } });
    const persistence = new FileSessionEventPersistence({ root: join(root, 'sessions') });
    const host = new InMemoryRuntimeHost({ dataRoot: root, toolRegistry: tools, registerDefaultWorkspaceTools: false,
      sessionStore: new SessionStore({ persistence }), provider: new OpenAIResponsesProvider({ ...f.config, capabilityStore: new InMemoryProviderCapabilityStore() }) });
    const turn = id => host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: `r-${id}`,
      sessionId: 's', turnId: id, model, tools: tools.definitions(), prefixMessages: [],
      inputMessages: [{ messageId: `u-${id}`, message: { role: 'user', content: 'Read docs' } }] });
    const close = async () => { await host.sendCommand({ kind: 'runtime.shutdown', payload: {} }); persistence.close(); };
    t.after(close);
    return { turn, host, close };
  };
  const first = create(); assert.equal((await first.turn('one')).payload.status, 'completed');
  assert.equal(executed, 1); await first.close();
  const next = create(true); assert.equal((await next.turn('two')).payload.status, 'completed');
  assert.equal(executed, 2);
  revoked = true; assert.equal((await next.turn('three')).payload.status, 'completed');
  assert.equal(executed, 2);
  const requests = f.calls.filter(call => !call.path.endsWith('/input_tokens')).map(call => call.body);
  assert.equal(requests.length, 7);
  assert.match(loadedName, /^[A-Za-z0-9_-]{1,64}$/); assert.notEqual(loadedName, longTool.name);
  for (const [index, current] of requests.entries()) {
    assert.equal(isNative(current), true);
    assert.deepEqual(current.tools, requests[0].tools);
    if (index) assert.deepEqual(current.input.slice(0, requests[index - 1].input.length), requests[index - 1].input);
  }
  assert.equal(requests[1].input.filter(item => item.type === 'tool_search_output').length, 1);
  assert.match(requests[6].input.find(item => item.type === 'function_call_output' && item.call_id === 'read-6').output, /revoked/);
  assert.ok(next.host.events('s', 'two').filter(event => event.kind === 'cache_chain_observed').every(event => !event.payload.frozenPrefixBreak));
});

test('overlapping parallel searches pass a strict provider and execute the discovered tool once', async t => {
  let round = 0, executed = 0;
  const f = await fixture(t, (body, path) => {
    const names = declaredNames(body);
    if (names.length !== new Set(names).size) return { status: 400,
      error: { code: 'invalid_request_error', message: 'Tool names must be unique.' } };
    if (path.endsWith('/input_tokens')) return {};
    round++;
    if (round === 1) return { output: [searchItem('one'), searchItem('two')] };
    if (round === 2) {
      const results = body.input.filter(item => item.type === 'tool_search_output');
      assert.deepEqual(results.map(item => item.call_id), ['one', 'two']);
      assert.deepEqual(results.map(item => item.tools.length), [1, 0]);
      assertClosedToolBatches(body.input);
      return { output: [functionItem()] };
    }
    return { output: [textItem()] };
  });
  const tools = new ToolRegistry();
  tools.register({ definition: tool,
    manifest: { effect_kind: 'observation', operation: 'test.read', risk: 'low', owner: 'test', dispatch_scope: 'parent_session', mutating: false },
    decodeInput: value => value, execute: () => { executed++; return { value: 'docs' }; },
    mcpHook: { server: 'docs', tool: 'read', call: async () => ({}) } });
  const host = new InMemoryRuntimeHost({ toolRegistry: tools, registerDefaultWorkspaceTools: false, provider: f.provider });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const terminal = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: 'overlap',
    sessionId: 's', turnId: 'overlap', model, tools: tools.definitions(), prefixMessages: [],
    inputMessages: [{ messageId: 'human', message: { role: 'user', content: 'Read docs' } }] });
  assert.equal(terminal.payload.status, 'completed');
  assert.equal(round, 3);
  assert.equal(executed, 1);
});

test('reloads keep the first declaration, exact call receipts and incremental cache prefixes', () => {
  const definition = { ...tool, inputSchema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'number' } } } };
  const match = { ...definition, server: 'docs', tool: 'read', revision: 'v1' };
  const messages = searchMessages('initial', [match]);
  const initial = toResponsesCreateParams(request({ messages }), { toolSearchMode: 'native' });
  const offset = messages.length;
  messages.push(...searchMessages('reload', [match, { ...match, inputSchema: {
    properties: { b: { type: 'number' }, a: { type: 'string' } }, type: 'object',
  } }]));
  const original = structuredClone(messages);
  const full = toResponsesCreateParams(request({ messages }), { toolSearchMode: 'native' });
  assert.deepEqual(declaredNames(full).filter(name => name === tool.name), [tool.name]);
  assert.deepEqual(full.input.slice(0, initial.input.length), initial.input);
  assert.equal(full.input.filter(item => item.type === 'tool_search_output').length, 2);
  assert.match(full.input.at(-1).content, /reload/);
  assertClosedToolBatches(full.input);
  const delta = toResponsesCreateParams(request({ messages, providerState: {
    strategy: 'response_chain', previousResponseId: 'stored', inputMessageOffset: offset,
  } }), { toolSearchMode: 'native' });
  assert.equal(delta.previous_response_id, 'stored');
  assert.deepEqual(delta.input, full.input.slice(initial.input.length));
  assert.deepEqual(messages, original);
  // Once the first definition leaves context, the retained full reload owns it.
  const compacted = toResponsesCreateParams(request({ messages: messages.slice(offset) }), { toolSearchMode: 'native' });
  assert.deepEqual(compacted.input.find(item => item.type === 'tool_search_output').tools.map(item => item.name), [tool.name]);
});

test('changed schemas replace stale declarations with one full replay, then resume chaining', () => {
  const messages = searchMessages('old');
  const offset = messages.length;
  const updated = { ...tool, description: 'Read the updated docs',
    inputSchema: { type: 'object', properties: { revision: { type: 'string' } } },
    server: 'docs', tool: 'read', revision: 'v2' };
  messages.push(...searchMessages('updated', [updated]));
  const original = structuredClone(messages);
  const providerState = { strategy: 'response_chain', previousResponseId: 'old-response', inputMessageOffset: offset };
  const params = toResponsesCreateParams(request({ messages, providerState }), { toolSearchMode: 'native' });
  assert.equal(params.previous_response_id, undefined, 'a stored old declaration cannot be replaced by an incremental input');
  assert.equal(params.store, true, 'the new root can still be used for subsequent chaining');
  const results = params.input.filter(item => item.type === 'tool_search_output');
  assert.deepEqual(results.map(item => item.tools.length), [0, 1]);
  assert.deepEqual(results[1].tools[0].parameters, updated.inputSchema);
  assertClosedToolBatches(params.input);
  const next = toResponsesCreateParams(request({ messages: [...messages, { role: 'user', content: 'Continue' }],
    providerState: { ...providerState, previousResponseId: 'updated-response', inputMessageOffset: messages.length },
  }), { toolSearchMode: 'native' });
  assert.equal(next.previous_response_id, 'updated-response');
  assert.deepEqual(next.input, [{ type: 'message', role: 'user', content: 'Continue' }]);
  assert.deepEqual(messages, original, 'stored historical schemas must not be rewritten');
});

test('direct exposure, long aliases and portable results retain their own declaration rules', () => {
  const long = { ...tool, name: `mcp__${'plugin'.repeat(15)}__read` };
  const matches = [{ ...long, server: 'docs', tool: 'read', revision: 'v1' }];
  const messages = [...searchMessages('one', matches), ...searchMessages('two', matches)];
  const req = request({ messages, tools: [...registry.definitions(), long, { ...long }] });
  const native = toResponsesCreateParams(req, { toolSearchMode: 'native' });
  const names = declaredNames(native);
  assert.equal(names.length, new Set(names).size);
  assert.equal(names.filter(name => name.startsWith('cb_mcp_')).length, 1);
  assert.ok(native.input.filter(item => item.type === 'tool_search_output').every(item => !item.tools.length));
  const portable = toResponsesCreateParams(req, { toolSearchMode: 'function' });
  assert.equal(portable.input.filter(item => item.type === 'function_call_output').length, 2);
  assert.equal(portable.input.find(item => item.type === 'function_call_output').output, messages[1].content);
  assert.throws(() => toResponsesCreateParams(request({ tools: [tool, { ...tool, description: 'conflict' }] })), /Conflicting tool definitions/);
});

test('archive and direct rediscovery share declarations without breaking pending batches', () => {
  const content = searchResult(), locator = 'tool-result://s/t/search';
  const messages = searchMessages('archived');
  messages[1].content = JSON.stringify({ archived: true, locator, originalChars: content.length, preview: '' });
  messages.push({ role: 'assistant', content: '', toolCalls: [{ id: 'page', name: 'read_archived_tool_result', argumentsText: '{}' }] },
    { role: 'tool', toolCallId: 'page', content: JSON.stringify({ locator, offset: 0, next_offset: content.length }) + '\n\n[text]\n' + content });
  const initial = toResponsesCreateParams(request({ messages }), { toolSearchMode: 'native' });
  messages.push(...searchMessages('direct'));
  const params = toResponsesCreateParams(request({ messages }), { toolSearchMode: 'native' });
  assert.deepEqual(params.input.slice(0, initial.input.length), initial.input);
  assert.equal(declaredNames(params).filter(name => name === tool.name).length, 1);
  assertClosedToolBatches(params.input);
  // The same two sources in reverse order must not append empty additional_tools.
  const reversed = toResponsesCreateParams(request({ messages: [...searchMessages('first'), ...messages.slice(0, 4)] }), { toolSearchMode: 'native' });
  assert.equal(reversed.input.some(item => item.type === 'additional_tools'), false);
  assert.equal(declaredNames(reversed).filter(name => name === tool.name).length, 1);
  assertClosedToolBatches(reversed.input);
});
