import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { modelRequestSchema } from '@cardbush/bush-protocol';
import { executeModelRound, InMemoryRuntimeHost, ToolRegistry, registerMcpDiscovery } from '@cardbush/bush-runtime';
import { normalizeResponseStreamEvent, OpenAIResponsesProvider, toResponsesCreateParams } from '../dist/index.js';

const registry = new ToolRegistry(); registerMcpDiscovery(registry);
const request = overrides => modelRequestSchema.parse({ protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't',
  model: 'protocol-fixture', messages: [{ role: 'user', content: 'Inspect fixture' }], tools: registry.definitions(), metadata: { mcpToolDiscovery: true }, ...overrides });
const fn = (overrides = {}) => ({ type: 'function_call', id: 'item_read', call_id: 'call_read', name: 'read_file', arguments: '{"path":"safe.txt"}', status: 'completed', ...overrides });
const search = (overrides = {}) => ({ type: 'tool_search_call', id: 'item_search', call_id: 'call_search', execution: 'client', arguments: { query: 'docs' }, status: 'completed', ...overrides });
const itemEvent = (item, type = 'done', output_index = 0) => ({ type: `response.output_item.${type}`, output_index, item });
const argsEvent = (item, type = 'done', output_index = 0) => ({ type: `response.function_call_arguments.${type}`, output_index, item_id: item.id, name: item.name,
  ...(type === 'delta' ? { delta: item.arguments } : { arguments: item.arguments }) });
const terminal = (output, type = 'completed') => ({ type: `response.${type}`, response: { id: 'response_fixture', created_at: 1, store: false, output, usage: null,
  status: type, ...(type === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}) } });
const provider = (frames, toolAliases) => ({ async *stream(req) {
  const state = { requestId: req.requestId, sequence: 0, started: false, toolSearchMode: 'native', toolAliases };
  for (const frame of frames) yield* normalizeResponseStreamEvent(frame, state);
} });
const round = frames => executeModelRound(provider(frames), request());
const assistant = result => ({ role: 'assistant', content: result.text, reasoningContent: result.reasoning, toolCalls: result.toolCalls, providerReplay: result.providerReplay });
const message = (text, id = 'item_text') => ({ type: 'message', id, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });

test('adversarial stream variants recover completed function calls exactly once with the real call ID', async t => {
  const call = fn();
  for (const [name, frames] of [
    ['terminal snapshot only', [terminal([call])]],
    ['item completion only', [itemEvent(call), terminal([call])]],
    ['arguments done before identity', [argsEvent(call), itemEvent(call), terminal([call])]],
    ['duplicate lifecycle events', [itemEvent(call, 'added'), itemEvent(call, 'added'), argsEvent(call), argsEvent(call), itemEvent(call), itemEvent(call), terminal([call])]],
    ['terminal snapshot omits preceding items', [itemEvent(call, 'added', 3), argsEvent(call, 'done', 3), terminal([call])]],
  ]) await t.test(name, async () => {
    const result = await round(frames);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.toolCalls.map(c => ({ id: c.id, name: c.name, argumentsText: c.argumentsText })), [{ id: call.call_id, name: call.name, argumentsText: call.arguments }]);
    const replay = toResponsesCreateParams(request({ messages: [assistant(result)] })).input;
    assert.deepEqual(replay, [call]);
  });
});

test('conflicting function arguments, call identities and mixed output indices fail before execution', async t => {
  const call = fn();
  for (const [name, frames] of [
    ['changed arguments', [itemEvent(call, 'added'), argsEvent(call, 'delta'), argsEvent(fn({ arguments: '{"path":"other.txt"}' })), terminal([call])]],
    ['changed call ID', [itemEvent(call, 'added'), argsEvent(call), itemEvent(fn({ call_id: 'call_other' })), terminal([call])]],
    ['changed item ID', [itemEvent(call, 'added'), argsEvent(fn({ id: 'item_other' })), terminal([call])]],
    ['duplicate call ID at another index', [itemEvent(call), itemEvent(fn({ id: 'item_other' }), 'done', 1), terminal([call])]],
    ['search and function at same index', [itemEvent(call), itemEvent(search()), terminal([search()])]],
    ['search and function share call ID', [itemEvent(call), itemEvent(search({ call_id: call.call_id }), 'done', 1), terminal([call])]],
    ['duplicate terminal snapshot call', [itemEvent(call), terminal([call, call])]],
  ]) await t.test(name, async () => {
    const result = await round(frames);
    assert.equal(result.status, 'failed', name);
    assert.equal(result.error.retryable, false);
  });
});

test('200 deterministic parallel stream interleavings retain call identity and argument bytes', async () => {
  const calls = [fn(), search(), fn({ id: 'item_two', call_id: 'call_two', name: 'second_read', arguments: '{"query":"中文🙂"}' })];
  for (let seed = 1; seed <= 200; seed++) {
    let random = seed;
    const choose = length => { random = (Math.imul(random, 1664525) + 1013904223) >>> 0; return random % length; };
    const streams = calls.map((call, index) => call.type === 'tool_search_call'
      ? [itemEvent({ ...call, arguments: {}, status: 'in_progress' }, 'added', index), itemEvent(call, 'done', index)]
      : [itemEvent({ ...call, arguments: '', status: 'in_progress' }, 'added', index),
        ...call.arguments.split('').map(delta => argsEvent({ ...call, arguments: delta }, 'delta', index)), argsEvent(call, 'done', index), itemEvent(call, 'done', index)]);
    const frames = [];
    while (streams.some(s => s.length)) {
      const active = streams.filter(s => s.length);
      frames.push(active[choose(active.length)].shift());
    }
    const result = await round([...frames, terminal(calls)]);
    assert.equal(result.status, 'completed', `seed ${seed}`);
    assert.deepEqual(result.toolCalls.map(c => [c.id, c.name, c.argumentsText]), calls.map(c => [c.call_id, c.type === 'tool_search_call' ? 'mcp_search' : c.name,
      typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments)]));
  }
});

test('all 120 mixed result orders close batches before receipts and preserve incremental prefixes', () => {
  const calls = ['mcp_search', 'local_read', 'mcp_search', 'local_read', 'local_read'].map((name, index) => ({ id: `call_${index}`, name, argumentsText: '{}' }));
  const outputs = calls.map(call => ({ role: 'tool', toolCallId: call.id, content: call.name === 'mcp_search'
    ? JSON.stringify({ protocol: 'bush.mcp_discovery.v1', sessionId: 's', matches: [], total: 0, more: false }) : `result ${call.id}` }));
  const permutations = function* (remaining, prefix = []) {
    if (!remaining.length) yield prefix;
    else for (let index = 0; index < remaining.length; index++) yield* permutations(remaining.filter((_, i) => i !== index), [...prefix, remaining[index]]);
  };
  let count = 0;
  for (const results of permutations(outputs)) {
    const messages = [{ role: 'assistant', content: '', toolCalls: calls }, ...results];
    const project = length => toResponsesCreateParams(request({ messages: messages.slice(0, length) }), { toolSearchMode: 'native' }).input;
    const input = project(messages.length);
    assert.ok(input.slice(5, 10).every(item => item.type.endsWith('_output')));
    assert.ok(input.slice(10).every(item => item.type === 'message'));
    for (let length = 1; length < messages.length; length++) {
      const prefix = project(length);
      assert.deepEqual(input.slice(0, prefix.length), prefix);
      const incremental = toResponsesCreateParams(request({ messages, providerState: { strategy: 'response_chain', previousResponseId: 'stored', inputMessageOffset: length } }), { toolSearchMode: 'native' }).input;
      assert.deepEqual(incremental, input.slice(prefix.length));
    }
    count++;
  }
  assert.equal(count, 120);
});

test('unfinished calls fail a completed response while output limits retain Runtime continuation semantics', async t => {
  for (const [name, frames] of [
    ['announced search disappeared', [itemEvent(search({ status: 'in_progress', arguments: {} }), 'added'), terminal([])]],
    ['truncated function in completed response', [itemEvent(fn({ status: 'in_progress' }), 'added'), argsEvent(fn(), 'delta'), terminal([fn({ status: 'incomplete' })])]],
    ['incomplete search in completed response', [terminal([search({ status: 'incomplete' })])]],
  ]) await t.test(name, async () => assert.equal((await round(frames)).status, 'failed'));
  const completeSearch = await round([terminal([search()], 'incomplete')]);
  assert.equal(completeSearch.status, 'completed');
  assert.equal(completeSearch.toolCalls.length, 0);
  assert.equal(completeSearch.finishReason, 'length');
});

test('model or binding changes keep historical function names valid for the portable protocol', async () => {
  const longName = `mcp__${'long_plugin_name_'.repeat(6)}__read`;
  const first = request({ tools: [{ name: longName, description: 'Read', inputSchema: { type: 'object' } }] });
  const wireName = toResponsesCreateParams(first, { toolSearchMode: 'native' }).tools[0].name;
  const result = await executeModelRound(provider([terminal([fn({ name: wireName })])], new Map([[wireName, longName]])), first);
  assert.equal(result.status, 'completed');
  const messages = [...first.messages, assistant(result), { role: 'tool', toolCallId: 'call_read', content: 'read result' }];
  const original = structuredClone(messages);
  for (const change of [{ model: 'different-model' }, { providerBinding: { bindingId: 'new-binding', revision: 'new-revision' } }]) {
    const params = toResponsesCreateParams(request({ ...first, messages, ...change }));
    const call = params.input.find(item => item.type === 'function_call');
    assert.match(call.name, /^[A-Za-z0-9_-]{1,64}$/);
    assert.equal(call.name, params.tools[0].name);
    assert.equal(call.name, wireName);
  }
  assert.deepEqual(messages, original);
  assert.equal(messages[1].toolCalls[0].name, longName);
});

test('text available only in done events or terminal snapshots is retained once in original order', async t => {
  const text = '检查完成🙂', item = message(text);
  for (const [name, frames] of [
    ['terminal only', [terminal([item])]],
    ['text done only', [{ type: 'response.output_text.done', output_index: 0, content_index: 0, item_id: item.id, text }, itemEvent(item), terminal([item])]],
    ['missing trailing delta', [{ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: '检查' }, itemEvent(item), terminal([item])]],
    ['duplicate done events', [itemEvent(item), itemEvent(item), terminal([item])]],
    ['snapshot omits earlier text', [itemEvent(message('Earlier. ', 'earlier'), 'done', 0), itemEvent(item, 'done', 2), terminal([item])]],
    ['snapshot omits completed tool', [itemEvent(fn(), 'done', 0), itemEvent(item, 'done', 1), terminal([item])]],
  ]) await t.test(name, async () => {
    const result = await round(frames);
    assert.equal(result.status, 'completed');
    assert.equal(result.text, name === 'snapshot omits earlier text' ? `Earlier. ${text}` : text);
  });
  const events = [];
  const result = await executeModelRound(provider([terminal([message('One. ', 'one'), fn(), message('Two.', 'two')])]), request(), { onEvent: event => { events.push(event); } });
  assert.equal(result.text, 'One. Two.');
  assert.deepEqual(events.filter(e => ['text_delta', 'tool_call_delta'].includes(e.kind)).map(e => e.kind), ['text_delta', 'tool_call_delta', 'text_delta']);
  assert.deepEqual(toResponsesCreateParams(request({ messages: [assistant(result)] })).input, [message('One. ', 'one'), fn(), message('Two.', 'two')]);
});

test('text snapshot contradictions are explicit failures rather than silent substitutions', async () => {
  const result = await round([{ type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'item_text', delta: 'Original' }, terminal([message('Changed')])]);
  assert.equal(result.status, 'failed');
});

test('text, reasoning and functions cannot reuse each other\'s identities or output indices', async () => {
  for (const frames of [
    [itemEvent(message('Original'), 'added'), itemEvent(fn())],
    [itemEvent(message('Original'), 'added'), itemEvent(message('Changed', 'other'))],
    [itemEvent(message('Original'), 'added'), itemEvent(message('Original'), 'done', 1)],
  ]) assert.equal((await round([...frames, terminal([])])).status, 'failed');
});

async function localEndpoint(t, framesFor) {
  const requests = [], failures = [];
  const server = createServer(async (req, res) => {
    try {
      let content = ''; for await (const chunk of req) content += chunk;
      const body = JSON.parse(content);
      if (req.url.endsWith('/input_tokens')) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"error":{"code":"not_found","message":"No token counter"}}'); return;
      }
      requests.push(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [sequence_number, event] of (await framesFor(body, requests.length)).entries()) {
        res.write(typeof event === 'string' ? event : `data: ${JSON.stringify({ sequence_number, ...event })}\n\n`);
      }
      res.end();
    } catch (error) { failures.push(error); res.destroy(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); assert.deepEqual(failures, []); });
  return { requests, provider: new OpenAIResponsesProvider({ apiKey: 'fixture-only', baseURL: `http://127.0.0.1:${server.address().port}/v1`, timeoutMs: 1000 }) };
}

test('real SDK and Runtime execute a recovered call once and execute nothing after conflicting or interrupted streams', async t => {
  for (const [name, frames, expected, completed = Boolean(expected)] of [
    ['snapshot only', [terminal([fn()])], 1],
    ['duplicate lifecycle', [itemEvent(fn(), 'added'), itemEvent(fn(), 'added'), argsEvent(fn()), itemEvent(fn()), itemEvent(fn()), terminal([fn()])], 1],
    ['contradictory arguments', [itemEvent(fn(), 'added'), argsEvent(fn()), itemEvent(fn({ arguments: '{"path":"other.txt"}' })), terminal([fn()])], 0],
    ['stream ends before terminal', [itemEvent(fn(), 'added'), argsEvent(fn()), itemEvent(fn())], 0],
    ['output limit continuation', [itemEvent(fn(), 'added'), argsEvent(fn(), 'delta'), terminal([fn({ status: 'incomplete' })], 'incomplete')], 0, true],
  ]) await t.test(name, async t => {
    const root = await mkdtemp(join(tmpdir(), 'cardbush-adversarial-'));
    t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-adversarial-')); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
    let executed = 0;
    const tools = new ToolRegistry();
    tools.register({ definition: { name: 'read_file', description: 'Read fixture', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
      manifest: { effect_kind: 'observation', operation: 'fixture.read', risk: 'low', owner: 'test', dispatch_scope: 'parent_session', mutating: false },
      decodeInput: input => input, execute: () => { executed++; return { text: 'fixture content' }; } });
    const endpoint = await localEndpoint(t, (_body, ordinal) => ordinal === 1 ? frames : [terminal([message('Finished')])]);
    const host = new InMemoryRuntimeHost({ dataRoot: root, provider: endpoint.provider, toolRegistry: tools, registerDefaultWorkspaceTools: false, maxAttempts: 1 });
    t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
    const result = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture',
      tools: tools.definitions(), prefixMessages: [], inputMessages: [{ messageId: 'u', message: { role: 'user', content: 'Inspect fixture' } }] });
    assert.equal(executed, expected);
    assert.equal(result.payload.status, completed ? 'completed' : 'failed');
    assert.equal(endpoint.requests.length, completed ? 2 : 1);
    if (expected) assert.equal(endpoint.requests[1].input.filter(i => i.type === 'function_call_output' && i.call_id === 'call_read').length, 1);
    if (name === 'output limit continuation') assert.equal(endpoint.requests[1].input.some(i => i.call_id === 'call_read'), false);
  });
});

test('portable requests resolve long wire aliases back to canonical tools through the real SDK', async t => {
  const name = `mcp__${'plugin_'.repeat(12)}__read`;
  const endpoint = await localEndpoint(t, body => [terminal([fn({ name: body.tools[0].name })])]);
  const result = await executeModelRound(endpoint.provider, request({ metadata: {}, tools: [{ name, description: 'Read', inputSchema: { type: 'object' } }] }));
  assert.equal(result.status, 'completed');
  assert.equal(result.toolCalls[0].name, name);
  assert.match(endpoint.requests[0].tools[0].name, /^[A-Za-z0-9_-]{1,64}$/);
});

test('cancellation between a snapshot tool call and its completion does not accept the batch', async t => {
  const endpoint = await localEndpoint(t, () => [terminal([fn()])]);
  const controller = new AbortController();
  const result = await executeModelRound(endpoint.provider, request({ metadata: {} }), { signal: controller.signal,
    onEvent: event => { if (event.kind === 'tool_call_delta') controller.abort(); } });
  assert.equal(result.status, 'failed');
  assert.equal(result.error.code, 'request_aborted');
  assert.equal(endpoint.requests.length, 1);
});

test('late malformed frames cannot overturn a completed response', async t => {
  const endpoint = await localEndpoint(t, () => [terminal([message('Finished')]), 'data: not-json\n\n']);
  const result = await executeModelRound(endpoint.provider, request({ metadata: {} }));
  assert.equal(result.status, 'completed');
  assert.equal(result.text, 'Finished');
});
