import { orderedCheckpointTool } from '../../bush-runtime/test/helpers/orderedCheckpoint.mjs';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import { InMemoryRuntimeHost, SessionStore } from '@cardbush/bush-runtime';
import { OpenAIResponsesProvider, toResponsesCreateParams } from '../dist/index.js';

const request = messages => ({ protocol: 'bush.model_request.v1', requestId: 'bytes', sessionId: 'bytes',
  turnId: 'current', model: 'fixture', messages, tools: [], metadata: {}, maxOutputTokens: 8192 });

test('measures the full UTF-8 JSON body, without counting base64 as vision tokens or sending an oversized request', async t => {
  let networkCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { networkCalls++; throw new Error('Network is forbidden.'); });
  const provider = new OpenAIResponsesProvider({ apiKey: 'fixture', maxRequestBodyBytes: 10_000 });
  const input = request([{ role: 'user', content: '图片诊断'.repeat(100),
    images: [{ url: 'data:image/png;base64,' + 'A'.repeat(20_000) }] }]);
  input.tools.push({ name: 'test', description: '说明'.repeat(100), inputSchema: { type: 'object' } });
  let budget;
  const options = { onRequestBodyBudget: value => { budget = value; } };
  const tokens = await provider.estimateInputTokens(input, options);
  assert.ok(tokens < 5000, 'byte pressure must not inflate the token estimate');
  assert.equal(budget.bytes, Buffer.byteLength(JSON.stringify(toResponsesCreateParams(input)), 'utf8'));
  assert.equal(budget.maxBytes, 10_000);
  assert.equal(await provider.countInputTokens(input, options), undefined);
  const events = []; for await (const event of provider.stream(input)) events.push(event);
  assert.equal(events.at(-1).code, 'provider_request_body_too_large');
  assert.equal(events.at(-1).retryable, false);
  assert.equal(networkCalls, 0, 'neither the count endpoint nor generation receives an oversized body');
});

for (const format of ['ordered', 'incremental']) for (const singleSource of [false, true]) test(`${format}: byte pressure preserves image facts (${singleSource ? 'one split source' : 'whole sources'}) and resumes`, async t => {
  const maxBytes = 160_000;
  const errors = [], requests = [], counts = [], modelRequests = [];
  const facts = text => [...new Set(text.match(/\b[RFP]_[012]\b/g) ?? [])].sort();
  const expectedFacts = Array.from({ length: 3 }, (_, i) => [`R_${i}`, `F_${i}`, `P_${i}`]).flat().sort();
  const server = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      assert.ok(raw.length <= maxBytes, 'every actual SDK body, including maintenance, must fit');
      const body = JSON.parse(raw);
      if (req.url.endsWith('/input_tokens')) {
        counts.push(raw.length);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 1200 }));
        return;
      }
      requests.push(body);
      assert.ok(requests.length <= 12, 'compaction must make bounded progress');
      const notice = body.input.flatMap(item => Array.isArray(item.content) ? item.content
        : typeof item.content === 'string' ? [{ type: 'input_text', text: item.content }] : [])
        .find(item => item.type === 'input_text' && item.text.includes('<context_pressure'))?.text;
      let output;
      if (notice) {
        const sources = notice.split('\n').filter(line => line.startsWith('{')).map(line => JSON.parse(line));
        const messages = modelRequests.at(-1).messages;
        const summary = source => {
          // Model fixture derives its summary from the supplied evidence, not
          // from canned conclusions that could hide a dropped source.
          const retained = facts(JSON.stringify(messages.slice(source.startMessage, source.endMessageExclusive)));
          assert.ok(retained.length, 'each source has user requirements, findings or pending checks');
          return retained.join('; ') + '; Local preview only; verification remains pending.';
        };
        output = [{ type: 'function_call', id: 'fc_' + requests.length, call_id: 'cp_' + requests.length,
          name: 'checkpoint_context', arguments: JSON.stringify(format === 'incremental' ? {
            updates: sources.filter(source => source.source !== undefined).map(source => ({ source: source.source,
              summary: summary(source) })),
          } : {
            summaries: sources.filter(source => source.target.startsWith('summaries[')).map(summary),
          }) }];
      } else {
        output = [{ type: 'message', id: 'final', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'Verification complete.', annotations: [] }] }];
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ type: 'response.completed', response: {
        id: 'resp_' + requests.length, status: 'completed', store: false, output,
        usage: { input_tokens: 1200, output_tokens: 10, input_tokens_details: { cached_tokens: 100 } },
      } })}\n\n`);
    } catch (error) { errors.push(error); res.destroy(); }
  });
  let host;
  t.after(async () => {
    if (host) await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.deepEqual(errors, []);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const store = new SessionStore(), time = '2026-09-13T04:00:00Z';
  // Replay fixtures intentionally use opaque base64. No local image ingestion
  // occurs here: this exercises legacy observations at the provider boundary.
  const observations = Array.from({ length: 3 }, (_, i) => [{ role: 'user', content: `Inspect image ${i}; R_${i}: local preview only.`,
      images: [{ url: 'data:image/png;base64,' + 'A'.repeat(70_000) }] },
    { role: 'assistant', content: `F_${i}: image inspected; P_${i}: verification pending.`, toolCalls: [] }]);
  const history = singleSource ? [observations.flat()] : observations;
  for (const [i, messages] of history.entries()) {
    store.commitTurn('bytes', { turnId: 'old_' + i, turnSequence: i + 1, createdAt: time, completedAt: time,
      status: 'completed', reason: 'model_response_completed', usage: {},
      messages: messages.map((message, index) => ({ messageId: `${i}_${index}`, turnId: 'old_' + i,
        turnSequence: i + 1, messageIndex: index, createdAt: time, message })) });
  }
  const original = structuredClone(store.snapshot('bytes').turns);
  const provider = new OpenAIResponsesProvider({ apiKey: 'fixture', maxRequestBodyBytes: maxBytes,
    baseURL: `http://127.0.0.1:${server.address().port}/v1`, timeoutMs: 3000 });
  const stream = provider.stream.bind(provider);
  t.mock.method(provider, 'stream', (input, options) => {
    modelRequests.push(structuredClone(input)); return stream(input, options);
  });
  host = new InMemoryRuntimeHost({ sessionStore: store, registerDefaultWorkspaceTools: false, provider });
  const result = await host.runSessionTurn({ protocol: 'bush.session_turn_request.v1', requestId: 'bytes',
    sessionId: 'bytes', turnId: 'current', model: 'fixture', maxOutputTokens: 8192,
    tools: format === 'ordered' ? [orderedCheckpointTool] : [], prefixMessages: [{ role: 'system', content: 'Keep the verified facts.' }],
    inputMessages: [{ messageId: 'current', message: { role: 'user', content: 'Continue.' } }],
    metadata: { contextWindowTokens: 400000 } });
  assert.equal(result.payload.status, 'completed', JSON.stringify(result.payload));
  // Batches are bounded by bytes, not by turn count: two images may share one
  // fragment. Check complete source delivery rather than requiring extra calls.
  const imageMessages = body => body.input.filter(item => Array.isArray(item.content) &&
    item.content.some(part => part.type === 'input_image'));
  const fragments = requests.filter(body => imageMessages(body).length);
  assert.ok(fragments.length >= 2, 'oversized history must be split before dispatch');
  const sourceTexts = fragments.flatMap(imageMessages).flatMap(item => item.content)
    .filter(part => part.type === 'input_text').map(part => part.text);
  assert.deepEqual(sourceTexts.sort(), observations.map(messages => messages[0].content),
    'every source image is delivered exactly once to the source summaries');
  if (format === 'incremental' && !singleSource) {
    assert.equal(requests.length, fragments.length + 1, 'complete sources need no redundant model merge');
  } else {
    assert.ok(requests.length >= fragments.length + 2, 'partial sources must be consolidated before resuming');
  }
  assert.deepEqual(facts(JSON.stringify(modelRequests.at(-1).messages)), expectedFacts,
    'all requirements, inspected findings and pending checks reach the next business request');
  assert.match(JSON.stringify(modelRequests.at(-1).messages), /Local preview only; verification remains pending/);
  assert.ok(counts.length > 0, 'also exercises the provider counting path');
  const events = host.events('bytes', 'current');
  const started = events.find(event => event.kind === 'context_compaction_started');
  assert.ok(started.payload.estimatedInputTokens < 10_000);
  assert.ok(started.payload.requestBody.bytes > maxBytes);
  assert.equal(events.filter(event => event.kind === 'context_compaction_completed').length, 1);
  const usage = events.filter(event => event.kind === 'model_request_usage');
  assert.ok(usage.every(event => event.payload.inputTokens === 1200));
  assert.deepEqual(store.snapshot('bytes').turns.slice(0, history.length), original, 'original observations remain intact');
  assert.ok(!JSON.stringify(requests.at(-1)).includes('data:image'), 'normal response continues with the committed summaries');
});
