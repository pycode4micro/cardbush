import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { InMemoryRuntimeHost, ToolRegistry, executeModelRound } from '@cardbush/bush-runtime';
import { InMemoryProviderCapabilityStore, OpenAIResponsesProvider, normalizeResponseStreamEvent } from '../dist/index.js';

const call = (id, overrides = {}) => ({ type: 'function_call', id: `item_${id}`, call_id: id,
  name: 'write_once', arguments: JSON.stringify({ value: id }), status: 'completed', ...overrides });
const text = value => ({ type: 'message', id: 'message', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: value, annotations: [] }] });
const done = (item, output_index = 0) => ({ type: 'response.output_item.done', output_index, item });
const terminal = (output, status = 'completed') => ({ type: `response.${status}`, response: {
  id: 'fixture', status, store: false, output, usage: { input_tokens: 300, output_tokens: 8192, total_tokens: 8492 },
  ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
} });
const request = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture',
  messages: [{ role: 'system', content: 'Stable instructions' }, { role: 'user', content: 'Write two files' }], tools: [], maxOutputTokens: 8192 };

for (const mode of ['native-full', 'native-stored', 'compatible']) {
  test(`${mode}: correcting a rejected batch preserves wire input, tools and the successful response anchor`, async t => {
    const requests = [], writes = [], failures = [];
    const stored = mode === 'native-stored';
    const capabilities = new InMemoryProviderCapabilityStore();
    if (mode === 'compatible') capabilities.observe({ scope: mode, model: 'fixture', capability: 'responses_compatibility' }, { status: 'supported' });
    const server = createServer(async (req, res) => {
      try {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        if (req.url.endsWith('/input_tokens')) {
          res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":300}'); return;
        }
        requests.push(body); const n = requests.length;
        assert.ok(n <= 4, 'one corrective request, without a hidden compatibility retry');
        const output = n === 1 ? [call('first')] : n === 2 ? [text('Preparing the next file.'), call('must_not_execute'), call('rejected', { status: 'incomplete', arguments: '{' })]
          : n === 3 ? [call('second')] : [text('Finished')];
        const response = { id: `response_${n}`, status: 'in_progress', store: stored, output: [], tools: body.tools };
        const frames = [{ type: 'response.created', response }, ...output.map((item, index) => done(item, index)),
          { type: 'response.completed', response: { ...response, status: 'completed', output } }];
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const [sequence_number, frame] of frames.entries()) res.write(`data: ${JSON.stringify({ sequence_number, ...frame })}\n\n`);
        res.end();
      } catch (error) { failures.push(error); res.destroy(); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); assert.deepEqual(failures, []); });
    const registry = new ToolRegistry();
    registry.register({ definition: { name: 'write_once', description: 'Write one fixture file', inputSchema: {
      type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } },
      manifest: { effect_kind: 'mutation', operation: 'fixture.write', risk: 'low', owner: 'test', dispatch_scope: 'turn', mutating: true },
      decodeInput: input => input, execute: ({ input }) => { writes.push(input.value); return { saved: input.value }; } });
    const host = new InMemoryRuntimeHost({ toolRegistry: registry, registerDefaultWorkspaceTools: false, maxAttempts: null,
      provider: new OpenAIResponsesProvider({ apiKey: 'fixture', baseURL: `http://127.0.0.1:${server.address().port}/v1`,
        capabilityStore: capabilities, capabilityScope: mode }) });
    t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
    const result = await host.runModelTurn({ ...request, tools: registry.definitions(), permissionMode: 'all_free',
      metadata: { mcpToolDiscovery: true }, reasoningEffort: 'high' });
    assert.equal(result.payload.status, 'completed'); assert.deepEqual(writes, ['first', 'second']);
    assert.equal(requests.length, 4);
    const failed = requests[1], repaired = requests[2];
    assert.deepEqual(repaired.input.slice(0, failed.input.length), failed.input, 'correction is append-only on the wire');
    assert.equal(repaired.input.at(-1).role, 'developer');
    assert.match(repaired.input.at(-1).content, /No tool from that response was executed/);
    assert.match(JSON.stringify(repaired.input), /Preparing the next file/);
    assert.ok(!JSON.stringify(repaired.input).includes('must_not_execute'));
    assert.ok(!JSON.stringify(repaired.input).includes('rejected'));
    for (const body of requests) {
      assert.deepEqual(body.tools, requests[0].tools); assert.deepEqual(body.reasoning, { effort: 'high' });
      assert.equal(body.max_output_tokens, 8192);
      assert.equal(body.tools.some(tool => tool.type === 'tool_search'), mode !== 'compatible');
    }
    assert.equal(failed.previous_response_id, stored ? 'response_1' : undefined);
    assert.equal(repaired.previous_response_id, failed.previous_response_id, 'the failed response cannot anchor continuation');
    assert.equal(requests[3].previous_response_id, stored ? 'response_3' : undefined);
    const observations = host.events('s', 't').filter(event => ['cache_chain_observed', 'provider_input_observed'].includes(event.kind));
    assert.equal(observations.filter(event => event.kind === 'provider_input_observed').length, 4);
    assert.ok(observations.every(event => !event.payload.frozenPrefixBreak), JSON.stringify(observations));
  });
}

test('incomplete item completion waits for the response terminal, including search and arguments.done', async t => {
  for (const item of [call('truncated', { arguments: '{', status: 'incomplete' }),
    { type: 'tool_search_call', id: 'search', call_id: 'search', execution: 'client', arguments: {}, status: 'incomplete' }]) {
    const frames = [done(item)];
    if (item.type === 'function_call') frames.push({ type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, arguments: item.arguments });
    for (const ending of [terminal([item], 'incomplete'), terminal([]),
      { type: 'response.failed', response: { id: 'fixture', status: 'failed', output: [], error: { code: 'server_error', message: 'Provider failure' } } }]) {
      await t.test(`${item.type}: ${ending.type}`, async () => {
        const provider = { async *stream() {
          const state = { requestId: 'r', sequence: 0, started: false, toolSearchMode: 'native' };
          for (const frame of [...frames, ending]) yield* normalizeResponseStreamEvent(frame, state);
        } };
        const result = await executeModelRound(provider, request);
        if (ending.type === 'response.incomplete') {
          assert.equal(result.status, 'completed'); assert.equal(result.finishReason, 'length');
          assert.equal(result.usage.outputTokens, 8192);
        } else {
          assert.equal(result.status, 'failed');
          assert.equal(result.error.code, ending.type === 'response.completed' ? 'provider_tool_call_incomplete' : 'server_error');
        }
      });
    }
  }
});
