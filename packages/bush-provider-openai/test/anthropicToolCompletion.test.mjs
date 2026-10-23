import test from 'node:test';
import assert from 'node:assert/strict';
import { modelEventSchema, modelRequestSchema } from '@cardbush/bush-protocol';
import { InMemoryRuntimeHost, ToolRegistry } from '@cardbush/bush-runtime';
import { AnthropicMessagesProvider } from '../dist/index.js';

const gateway = 'https://opencode.ai/zen/go/v1';
const tool = { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } };
const request = () => modelRequestSchema.parse({ protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture',
  messages: [{ role: 'user', content: 'Inspect the files.' }], tools: [tool] });
const collect = async iterable => { const events = []; for await (const event of iterable) events.push(modelEventSchema.parse(event)); return events; };
const call = (id = 'read-1', args = '{"path":"文件.txt"}') => ({ id, args, name: 'read_file' });
function events(reason = 'end_turn', calls = [call()]) {
  return [
    { type: 'message_start', message: { id: 'response', role: 'assistant', type: 'message', model: 'fixture', content: [], usage: { input_tokens: 20, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'Inspect the files first.', signature: 'original-signature' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'content_block_start', index: 1, content_block: { type: 'text', text: calls.length ? 'Checking.' : 'Verified.' } },
    { type: 'content_block_stop', index: 1 },
    ...calls.flatMap((value, n) => [
      { type: 'content_block_start', index: n + 2, content_block: { type: 'tool_use', id: value.id, name: value.name, input: {} } },
      { type: 'content_block_delta', index: n + 2, delta: { type: 'input_json_delta', partial_json: value.args.slice(0, 6) } },
      { type: 'content_block_delta', index: n + 2, delta: { type: 'input_json_delta', partial_json: value.args.slice(6) } },
      { type: 'content_block_stop', index: n + 2 },
    ]),
    { type: 'message_delta', delta: { stop_reason: reason }, usage: { output_tokens: 10 } }, { type: 'message_stop' },
  ];
}
function sse(values) {
  return new Response(new ReadableStream({ start(controller) {
    const bytes = new TextEncoder().encode(values.map(value => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`).join(''));
    for (let n = 0; n < bytes.length; n += 11) controller.enqueue(bytes.slice(n, n + 11));
    controller.close();
  } }), { headers: { 'content-type': 'text/event-stream' } });
}

test('OpenCode complete client tools with end_turn retain all original calls without another provider request', async () => {
  const calls = [call(), call('read-2', '{ "path": "two.txt" }'), call('read-3', '{"path":"three.txt"}')], diagnostics = [];
  let requests = 0;
  const provider = new AnthropicMessagesProvider({ apiKey: 'fixture', baseURL: gateway, fetch: async () => { requests++; return sse(events('end_turn', calls)); } });
  const output = await collect(provider.stream(request(), { onCompatibilityDiagnostic: value => diagnostics.push(value) }));
  assert.equal(requests, 1); assert.equal(output.at(-1).kind, 'response_completed'); assert.equal(output.at(-1).finishReason, 'tool_calls');
  assert.deepEqual(output.filter(value => value.kind === 'tool_call_delta').map(value => [value.toolCallId, value.nameDelta, value.argumentsDelta]),
    calls.map(value => [value.id, value.name, value.args]));
  assert.deepEqual(output.at(-1).providerReplay.data.content.filter(value => value.type === 'tool_use').map(value => [value.id, value.input]),
    calls.map(value => [value.id, JSON.parse(value.args)]));
  assert.equal(output.at(-1).providerReplay.data.content[0].signature, 'original-signature');
  assert.equal(diagnostics.length, 1); assert.equal(diagnostics[0].error.code, 'anthropic_tool_stop_reason_normalized');
  assert.equal(diagnostics[0].providerAttempts, 1); assert.equal(diagnostics[0].recoveryAttempts, 0);
});

test('Runtime executes recovered calls exactly once, returns receipts and finishes with a stable context prefix', async t => {
  const tools = new ToolRegistry(), executed = [], bodies = [];
  tools.register({ definition: tool,
    manifest: { effect_kind: 'observation', operation: 'test.read', risk: 'low', owner: 'test', dispatch_scope: 'parent_session', mutating: false },
    decodeInput: value => value, execute: ({ input }) => { executed.push(input.path); return { text: `verified-${input.path}` }; } });
  const calls = [call(), call('read-2', '{"path":"two.txt"}'), call('read-3', '{"path":"three.txt"}')];
  const provider = new AnthropicMessagesProvider({ apiKey: 'fixture', baseURL: gateway, fetch: async (_url, init) => {
    const body = JSON.parse(init.body); bodies.push(body);
    if (bodies.length === 1) return sse(events('end_turn', calls));
    assert.equal(bodies.length, 2); assert.equal(executed.length, 3);
    assert.deepEqual(body.messages.slice(0, bodies[0].messages.length), bodies[0].messages);
    assert.deepEqual(body.tools, bodies[0].tools); assert.deepEqual(body.system, bodies[0].system);
    const receipts = body.messages.flatMap(message => message.content).filter(block => block.type === 'tool_result');
    assert.deepEqual(receipts.map(value => value.tool_use_id), calls.map(value => value.id));
    for (const name of executed) assert.ok(JSON.stringify(receipts).includes(`verified-${name}`));
    assert.ok(body.messages.flatMap(message => message.content).some(value => value.signature === 'original-signature'));
    return sse(events('end_turn', []));
  } });
  const host = new InMemoryRuntimeHost({ toolRegistry: tools, registerDefaultWorkspaceTools: false, provider });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const result = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: 'r', sessionId: 's', turnId: 't',
    model: 'fixture', tools: tools.definitions(), permissionMode: 'all_free', prefixMessages: [],
    inputMessages: [{ messageId: 'user', message: { role: 'user', content: 'Inspect the files.' } }] });
  assert.equal(result.payload.status, 'completed', JSON.stringify(result));
  assert.deepEqual(executed, ['文件.txt', 'two.txt', 'three.txt']); assert.equal(bodies.length, 2);
  const observations = host.events('s', 't').filter(value => ['cache_chain_observed', 'provider_input_observed'].includes(value.kind));
  assert.ok(observations.length > 0); assert.ok(observations.every(value => !value.payload.frozenPrefixBreak));
});

for (const [name, values, baseURL = gateway] of [
  ['official endpoint', events(), 'https://api.anthropic.com'],
  ['gateway lookalike', events(), 'https://opencode.ai.example.org/zen/go/v1'],
  ['unfinished block', events().filter(value => !(value.type === 'content_block_stop' && value.index === 2))],
  ['missing message_stop', events().slice(0, -1)],
  ['missing stop reason', events(undefined).filter(value => value.type !== 'message_delta')],
  ['duplicate call identity', events('end_turn', [call(), call()])],
  ['missing tool name', events('end_turn', [{ ...call(), name: '' }])],
  ['malformed arguments', events('end_turn', [call('read', '{"path":')])],
  ['non-object arguments', events('end_turn', [call('read', '[]')])],
  ['refusal', events('refusal')], ['paused response', events('pause_turn')], ['stop sequence', events('stop_sequence')],
  ['tool_use without a call', events('tool_use', [])], ['context overflow', events('model_context_window_exceeded')],
]) test(`${name} cannot be promoted into tool execution`, async () => {
  const provider = new AnthropicMessagesProvider({ apiKey: 'fixture', baseURL, fetch: async () => sse(values) });
  const output = await collect(provider.stream(request()));
  assert.equal(output.at(-1).kind, 'response_failed'); assert.equal(output.some(value => value.kind === 'tool_call_delta'), false);
});

test('truncation never executes tools, even when the argument object happens to be complete', async () => {
  const provider = new AnthropicMessagesProvider({ apiKey: 'fixture', baseURL: gateway, fetch: async () => sse(events('max_tokens')) });
  const output = await collect(provider.stream(request()));
  assert.equal(output.at(-1).finishReason, 'length'); assert.deepEqual(output.at(-1).completedToolCallIndices, []);
  assert.equal(output.some(value => value.kind === 'tool_call_delta'), false);
});

test('ordinary tool_use still passes malformed arguments to Runtime for factual repair', async () => {
  const provider = new AnthropicMessagesProvider({ apiKey: 'fixture', baseURL: gateway, fetch: async () => sse(events('tool_use', [call('read', '{"path":')])) });
  const output = await collect(provider.stream(request()));
  assert.equal(output.at(-1).finishReason, 'tool_calls'); assert.equal(output.find(value => value.kind === 'tool_call_delta').argumentsDelta, '{"path":');
  assert.equal(output.at(-1).providerReplay, undefined);
});
