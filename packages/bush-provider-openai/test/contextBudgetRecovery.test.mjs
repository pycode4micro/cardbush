import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { InMemoryRuntimeHost, SessionStore } from '@cardbush/bush-runtime';
import { OpenAIResponsesProvider } from '../dist/index.js';
import { responsesInputFingerprint } from '../dist/responsesInputFingerprint.js';
import { inputTokenBasis, calibrateInputTokens } from '../../bush-runtime/dist/inputTokenBasis.js';

test('Responses wire input keeps count calibration when only the output limit changes', () => {
  const model = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't',
    model: 'fixture', messages: [{ role: 'user', content: 'facts' }], tools: [], maxOutputTokens: 128000 };
  const before = { model: 'fixture', stream: true, input: [{ role: 'user', content: 'facts' }], max_output_tokens: 128000 };
  const after = { ...before, max_output_tokens: 16384 };
  const first = responsesInputFingerprint(before, before);
  const second = responsesInputFingerprint(after, after);
  const usage = { lastRequestInputTokens: 40, lastRequestInputBasis: { ...inputTokenBasis(model), projection: first } };
  assert.equal(calibrateInputTokens(usage, { ...model, maxOutputTokens: 16384 }, second).inputTokens, 40);
  assert.notEqual(first.parameterDigests.max_output_tokens, second.parameterDigests.max_output_tokens);
  const changed = { ...after, tools: [{ type: 'function', name: 'new', parameters: { type: 'object' } }] };
  assert.equal(calibrateInputTokens(usage, model, responsesInputFingerprint(changed, changed)), undefined);
});

test('real SDK HTTP rejection and incomplete terminal events recover without partial call replay', async t => {
  const requests = [], failures = [];
  let counts = 0;
  const server = createServer(async (req, res) => {
    try {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (req.url.endsWith('/input_tokens')) {
        counts++;
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Counter unavailable.', type: 'not_found' } }));
        return;
      }
      requests.push(body);
      const ordinal = requests.length;
      assert.ok(ordinal <= 4, 'recovery must remain bounded');
      if (ordinal === 1) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'context_length_exceeded', type: 'invalid_request_error', message: 'Context exceeds the input limit.' } }));
        return;
      }
      let output, status = 'completed';
      if (ordinal === 2) {
        assert.equal(body.max_output_tokens, 16384);
        status = 'incomplete';
        output = [{ type: 'reasoning', id: 'rs_partial', summary: [], content: [{ type: 'reasoning_text', text: 'PARTIAL_MAINTENANCE_REASONING' }] },
          { type: 'function_call', id: 'fc_partial', call_id: 'cp_partial', name: 'checkpoint_context', arguments: '{"summaries":[' }];
      } else if (ordinal === 3) {
        assert.equal(body.max_output_tokens, 32768);
        assert.deepEqual(body.input.slice(0, requests[1].input.length), requests[1].input);
        assert.doesNotMatch(JSON.stringify(body.input), /PARTIAL_MAINTENANCE_REASONING|cp_partial/);
        output = [{ type: 'reasoning', id: 'rs_valid', summary: [], content: [{ type: 'reasoning_text', text: 'Verified checkpoint reasoning.' }] },
          { type: 'function_call', id: 'fc_valid', call_id: 'cp_valid', name: 'checkpoint_context',
            arguments: JSON.stringify({ summaries: ['The earlier work completed; verification remains.'], active_summary: '' }) }];
      } else {
        assert.equal(body.max_output_tokens, 128000);
        assert.equal(body.input.filter(item => item.type === 'function_call' && item.call_id === 'cp_valid').length, 1);
        assert.equal(body.input.filter(item => item.type === 'function_call_output' && item.call_id === 'cp_valid').length, 1);
        assert.equal(body.input.filter(item => item.type === 'reasoning' && item.id === 'rs_valid').length, 1);
        assert.doesNotMatch(JSON.stringify(body.input), /cp_partial|PARTIAL_MAINTENANCE_REASONING/);
        output = [{ type: 'message', id: 'msg_final', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'Verification complete.', annotations: [] }] }];
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ type: `response.${status}`, response: { id: `resp_${ordinal}`, status,
        store: false, output, ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
        usage: { input_tokens: 1500, output_tokens: ordinal === 2 ? 16384 : 50 } } })}\n\n`);
    } catch (error) { failures.push(error); res.destroy(); }
  });
  let host;
  t.after(async () => {
    if (host) await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.deepEqual(failures, []);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const store = new SessionStore();
  const time = '2026-09-11T12:00:00Z';
  store.commitTurn('sdk', { turnId: 'old', turnSequence: 1, createdAt: time, completedAt: time,
    status: 'completed', reason: 'model_response_completed', usage: {},
    messages: [{ role: 'user', content: 'Do the work.' }, { role: 'assistant', content: 'Work completed.', reasoningContent: 'Verified work.', toolCalls: [] }]
      .map((message, index) => ({ messageId: `old_${index}`, turnId: 'old', turnSequence: 1, messageIndex: index, createdAt: time, message })) });
  host = new InMemoryRuntimeHost({ sessionStore: store, maxAttempts: 1, registerDefaultWorkspaceTools: false,
    provider: new OpenAIResponsesProvider({ apiKey: 'fixture-only', baseURL: `http://127.0.0.1:${server.address().port}/v1`, timeoutMs: 2000 }) });
  const result = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: 'sdk', sessionId: 'sdk', turnId: 'current',
    model: 'fixture', maxOutputTokens: 128000, reasoningEffort: 'high', metadata: { contextWindowTokens: 400000 },
    prefixMessages: [{ role: 'system', content: 'Stable rules.' }],
    inputMessages: [{ messageId: 'current_user', message: { role: 'user', content: 'Verify the result.' } }] });
  assert.equal(result.payload.status, 'completed');
  assert.equal(requests.length, 4);
  assert.equal(counts, 1);
  assert.equal(host.events('sdk', 'current').filter(event => event.kind === 'context_compaction_completed').length, 1);
});
