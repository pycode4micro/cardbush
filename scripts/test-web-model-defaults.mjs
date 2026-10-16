import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { AgentService } from '../dist-electron/agentService.mjs';
import { serveAgentHttp } from '../dist-electron/agentServer.mjs';
import { BrokerWebAgents } from '../dist-electron/webAgentPool.mjs';

test('web model defaults and explicit overrides reach the native model request after reconnect', async t => {
  const root = await mkdtemp(join(tmpdir(), 'web-model-defaults-'));
  const service = await AgentService.open({ dataRoot: root, webRestricted: true, env: { CARDBUSH_RUNTIME_PROVIDER_MAX_ATTEMPTS: '1' } });
  const token = 'fixture-agent-token-'.repeat(4);
  const agent = await serveAgentHttp(service, { host: '127.0.0.1', port: 0, token });
  const calls = [], pools = [];
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    if (request.url === '/ensure') {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ url: `http://127.0.0.1:${agent.port}`, token, containerId: 'fixture-container' })); return;
    }
    if (request.url.endsWith('/input_tokens')) {
      response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ input_tokens: 100 })); return;
    }
    calls.push(body);
    const n = calls.length;
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const emit = value => response.write(`data: ${JSON.stringify(value)}\n\n`);
    const item = { id: `msg-${n}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] };
    const result = { id: `resp-${n}`, object: 'response', model: body.model, status: 'in_progress', store: false, output: [] };
    emit({ type: 'response.created', response: result });
    emit({ type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } });
    emit({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: 'OK' });
    emit({ type: 'response.output_item.done', output_index: 0, item });
    emit({ type: 'response.completed', response: { ...result, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 1, total_tokens: 101 } } });
    response.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    for (const pool of pools) pool.close();
    await agent.close(); await service.close();
    server.closeAllConnections(); await new Promise(done => server.close(done));
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const reconnect = async overrides => {
    const pool = new BrokerWebAgents({ brokerURL: url, brokerSecret: 'b'.repeat(64), modelSecret: 'm'.repeat(64), internalURL: url,
      defaultModelId: 'fixture', models: [{ id: 'fixture', name: 'Fixture', model: 'fixture', baseURL: 'https://provider.invalid/v1', apiKey: 'vendor-secret', ...overrides }] }, async () => false);
    pools.push(pool); return pool.get('fixture-user');
  };
  const send = async (client, id, maximum, effort) => {
    const native = await client.call('product.command', { kind: 'models.get' });
    assert.equal(native.models[0].maxCompletionTokens, maximum);
    assert.equal(native.models[0].reasoningEffort, effort ?? null);
    await client.call('sessions.create', { sessionId: id });
    const job = await client.call('chat.send', { requestId: id, sessionId: id, modelId: 'fixture', text: 'Reply OK.' });
    let complete;
    for (let attempt = 0; attempt < 300; attempt++) {
      complete = (await client.call('chat.jobs', { sessionId: id })).find(item => item.id === job.id);
      if (!['queued', 'running'].includes(complete.status)) break;
      await new Promise(done => setTimeout(done, 40));
    }
    assert.equal(complete.status, 'completed');
    assert.equal(calls.at(-1).max_output_tokens, maximum);
    assert.equal(calls.at(-1).reasoning?.effort, effort);
  };
  await send(await reconnect({}), 'default-limits', 128000, 'medium');
  await send(await reconnect({ maxOutputTokens: 64000, reasoningEffort: 'low' }), 'explicit-limits', 64000, 'low');
  await send(await reconnect({}), 'restored-defaults', 128000, 'medium');
  await send(await reconnect({ reasoningEffort: null }), 'provider-default-reasoning', 128000, undefined);
  assert.equal(calls.length, 4);
  const hot = pools.at(-1);
  hot.config.models = hot.config.models.map(model => ({ ...model, model: 'fixture-updated', maxOutputTokens: 96000, reasoningEffort: 'high', maxContextTokens: 300000 }));
  await send(await hot.get('fixture-user'), 'hot-updated-limits', 96000, 'high');
  const updated = await (await hot.get('fixture-user')).call('product.command', { kind: 'models.get' });
  assert.equal(updated.models[0].modelName, 'fixture-updated');
  assert.equal(updated.models[0].maxContextTokens, 300000);
  assert.equal(calls.length, 5);
});
