import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { InMemoryRuntimeHost, SessionStore, ToolRegistry, registerMcpDiscovery, requiresContextCompactionBeforeRound } from '@cardbush/bush-runtime';
import { OpenAIResponsesProvider, toResponsesCreateParams } from '../dist/index.js';
import { responsesInputFingerprint } from '../dist/responsesInputFingerprint.js';
import { inputTokenBasis, calibrateInputTokens } from '../../bush-runtime/dist/inputTokenBasis.js';

test('wire schema replacement and native fallback invalidate calibration even with an append-only Runtime history', () => {
  const registry = new ToolRegistry(); registerMcpDiscovery(registry);
  const discovery = (id, description) => [
    { role: 'assistant', content: '', toolCalls: [{ id, name: 'mcp_search', argumentsText: '{"query":"read"}' }] },
    { role: 'tool', toolCallId: id, content: JSON.stringify({ protocol: 'bush.mcp_discovery.v1', sessionId: 's',
      matches: [{ name: 'mcp__docs__read', description, inputSchema: { type: 'object' }, server: 'docs', tool: 'read', revision: description }], total: 1, more: false }) },
  ];
  const first = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture',
    tools: registry.definitions(), metadata: { mcpToolDiscovery: true }, messages: [{ role: 'user', content: 'Read facts' }, ...discovery('one', 'Read docs')] };
  const project = (r, mode = 'native') => { const p = toResponsesCreateParams(r, { toolSearchMode: mode });
    return responsesInputFingerprint(p, p, r.providerBinding); };
  const usage = { lastRequestInputTokens: 500, lastRequestInputBasis: { ...inputTokenBasis(first), projection: project(first) } };
  const appended = { ...first, messages: [...first.messages, ...discovery('two', 'Read docs')] };
  assert.ok(calibrateInputTokens(usage, appended, project(appended)));
  const changed = { ...first, messages: [...first.messages, ...discovery('two', 'Read updated schema')] };
  assert.equal(calibrateInputTokens(usage, changed, project(changed)), undefined);
  assert.equal(calibrateInputTokens(usage, appended, project(appended, 'function')), undefined);
});

test('SDK dispatch reuses measured prefixes across turns and restart without stripping reasoning or premature compaction', async t => {
  const requests = [], failures = [], journal = [], hosts = [];
  let countRequests = 0;
  const actualInputs = [20000, 70000, 71000];
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (req.url.endsWith('/input_tokens')) {
        countRequests++;
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Token counting is not supported by this fixture.', type: 'not_found' } }));
        return;
      }
      requests.push(body);
      const n = requests.length;
      assert.ok(n <= actualInputs.length, 'calibration must not introduce extra model requests');
      assert.equal(JSON.stringify(body.input).includes('context_pressure'), false);
      const output = [
        { type: 'reasoning', id: `rs_${n}`, status: 'completed', content: [{ type: 'reasoning_text', text: `Verified reasoning ${n}.` }], summary: [] },
        { type: 'message', id: `msg_${n}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `Finished ${n}.`, annotations: [] }] },
      ];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { id: `resp_${n}`, status: 'completed', store: false, output,
        usage: { input_tokens: actualInputs[n - 1], output_tokens: 15, input_tokens_details: { cached_tokens: 0 } } } })}\n\n`);
    } catch (error) { failures.push(error); res.destroy(); }
  });
  t.after(async () => {
    for (const host of hosts) await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
    server.closeAllConnections(); await new Promise(done => server.close(done));
    assert.deepEqual(failures, []);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const provider = new OpenAIResponsesProvider({ apiKey: 'fixture-only', baseURL: `http://127.0.0.1:${server.address().port}/v1`, timeoutMs: 2000 });
  const createHost = () => {
    const persistence = { load: () => JSON.parse(JSON.stringify(journal)), append: event => journal.push(JSON.parse(JSON.stringify(event))) };
    const host = new InMemoryRuntimeHost({ provider, sessionStore: new SessionStore({ persistence }), registerDefaultWorkspaceTools: false, maxAttempts: 1 });
    hosts.push(host); return host;
  };
  const turn = (id, content) => ({ protocol: 'bush.session_turn_request.v1', requestId: id, sessionId: 's', turnId: id, model: 'fixture',
    prefixMessages: [{ role: 'system', content: 'Stable instructions' }],
    inputMessages: [{ messageId: `user_${id}`, message: { role: 'user', content } }],
    reasoningEffort: 'high', maxOutputTokens: 10000, metadata: { contextWindowTokens: 140000 } });
  const first = createHost();
  assert.equal((await first.runSessionTurn(turn('one', 'A'.repeat(330000)))).payload.status, 'completed');
  assert.equal((await first.runSessionTurn(turn('two', 'B'.repeat(180000)))).payload.status, 'completed');
  const usage = first.events('s', 'two').find(e => e.kind === 'model_request_usage').payload;
  assert.equal(usage.preflightMeasurement, 'fallback_estimate');
  assert.equal(usage.inputCalibration.prefixInputTokens, 20000);
  assert.ok(usage.preflightInputTokens < 75000);
  const full = responsesInputFingerprint(requests[1], requests[1], undefined);
  assert.ok(full.tokenEstimate.tokens > 120000, 'the old full-prefix estimate would force compaction');
  assert.equal(requiresContextCompactionBeforeRound({ estimatedPromptTokens: full.tokenEstimate.tokens,
    reservedOutputTokens: 10000, usableInputTokens: 130000, ratio: full.tokenEstimate.tokens / 130000 }), true);
  assert.deepEqual(requests[1].input.slice(0, requests[0].input.length), requests[0].input);
  assert.equal(requests[1].input.find(item => item.type === 'reasoning').content[0].text, 'Verified reasoning 1.');
  assert.ok(requests.every(r => r.tools.some(tool => tool.name === 'checkpoint_context')));
  await first.sendCommand({ kind: 'runtime.shutdown', payload: {} }); hosts.shift();
  const restarted = createHost();
  assert.equal((await restarted.runSessionTurn(turn('three', 'C'.repeat(4000)))).payload.status, 'completed');
  const resumed = restarted.events('s', 'three').find(e => e.kind === 'model_request_usage').payload;
  assert.equal(resumed.inputCalibration.prefixInputTokens, 70000);
  assert.ok(resumed.preflightInputTokens < 73000);
  assert.equal(restarted.events('s', 'three').find(e => e.kind === 'provider_input_observed').payload.frozenPrefixBreak, false);
  assert.equal(countRequests, 1, 'unsupported counting capability is cached, estimation makes no network requests');
  assert.equal(requests.length, 3);
});
