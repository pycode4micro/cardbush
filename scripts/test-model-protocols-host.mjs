import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { AgentService } from '../dist-electron/agentService.mjs';

test('Agent worker resolves saved protocols, headers and model credentials through the Product Host', async () => {
  const base = resolve('tmp/model-protocol-host');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'run-')), calls = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    calls.push({ path: request.url, headers: request.headers, body });
    if (request.url.endsWith('/input_tokens')) { response.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":1000}'); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = event => response.write(`${event.type ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`);
    if (request.url.endsWith('/chat/completions')) {
      emit({ id: 'c1', model: body.model, choices: [{ index: 0, delta: { content: 'Configured chat works.' }, finish_reason: 'stop' }] });
      response.end('data: [DONE]\n\n');
    } else if (request.url.endsWith('/messages')) {
      emit({ type: 'message_start', message: { id: 'm1', model: body.model, role: 'assistant', content: [], usage: { input_tokens: 1000, output_tokens: 1 } } });
      emit({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Configured Messages works.' } });
      emit({ type: 'content_block_stop', index: 0 });
      emit({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } });
      emit({ type: 'message_stop' }); response.end();
    } else {
      emit({ type: 'response.completed', response: { id: 'r1', model: body.model, status: 'completed', store: false, output: [
        { type: 'message', id: 'text1', role: 'assistant', content: [{ type: 'output_text', text: 'Configured Responses works.', annotations: [] }] },
      ] } }); response.end();
    }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let service;
  try {
    service = await AgentService.open({ dataRoot: root, name: 'protocol-fixture', env: { CARDBUSH_RUNTIME_PROVIDER_MAX_ATTEMPTS: '1' } });
    const protocols = [['openai_responses', '/responses', 'max'], ['openai_chat_completions', '/chat/completions', 'low'], ['anthropic_messages', '/messages', 'high']];
    await service.call('product.command', { kind: 'models.update', config: { defaultModelId: 'openai_responses', models: protocols.map(([apiProtocol, , reasoningEffort]) => ({ id: apiProtocol, provider: 'custom', model: 'fixture',
        apiKey: 'fixture-secret', baseURL: `http://127.0.0.1:${server.address().port}/gateway/v1`, apiProtocol, reasoningEffort,
        defaultHeaders: { 'x-conversation': '{{sessionId}}' }, maxContextTokens: 400000, maxOutputTokens: 8192,
      })) } });
    const run = async (sessionId, modelId, override) => {
      await service.call('sessions.create', { sessionId });
      const job = await service.call('chat.send', { sessionId, requestId: sessionId, modelId, text: 'Say hello.', language: 'en', permissionMode: 'task_free', ...override });
      let state;
      for (let i = 0; i < 150; i++) {
        state = (await service.call('chat.jobs', { sessionId })).find(item => item.id === job.id);
        if (state && ['completed', 'failed', 'cancelled'].includes(state.status)) break;
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      assert.equal(state?.status, 'completed', JSON.stringify(state));
    };
    for (const [apiProtocol, endpoint, effort] of protocols) {
      await run(apiProtocol, apiProtocol);
      const wire = calls.find(call => call.path === `/gateway/v1${endpoint}` && call.headers['x-conversation'] === apiProtocol);
      assert.ok(wire, `${apiProtocol} must use its actual protocol in the worker`);
      assert.equal(wire.headers['user-agent'], 'CardBush/1.0');
      if (apiProtocol === 'anthropic_messages') {
        assert.equal(wire.headers['x-api-key'], 'fixture-secret'); assert.deepEqual(wire.body.thinking, { type: 'adaptive' }); assert.equal(wire.body.output_config.effort, 'high');
      } else {
        assert.equal(wire.headers.authorization, 'Bearer fixture-secret');
        assert.equal(apiProtocol === 'openai_responses' ? wire.body.reasoning.effort : wire.body.reasoning_effort, effort);
      }
      await run(`${apiProtocol}-default`, apiProtocol, { reasoningEffort: null });
      const defaultWire = calls.find(call => call.path === `/gateway/v1${endpoint}` && call.headers['x-conversation'] === `${apiProtocol}-default`);
      for (const field of ['reasoning', 'reasoning_effort', 'thinking', 'output_config']) assert.equal(defaultWire.body[field], undefined, `${apiProtocol} provider default must omit ${field}`);
    }
    const updated = await service.call('product.command', { kind: 'model.reasoning.update', modelId: 'openai_responses', reasoningEffort: 'medium' });
    assert.deepEqual(updated.models.map(model => model.reasoningEffort), ['medium', 'low', 'high']);
    await run('saved-update', 'openai_responses');
    assert.equal(calls.find(call => call.path.endsWith('/responses') && call.headers['x-conversation'] === 'saved-update').body.reasoning.effort, 'medium');
  } finally {
    await service?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.ok(resolve(root).startsWith(base + '\\') || resolve(root).startsWith(base + '/'));
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
