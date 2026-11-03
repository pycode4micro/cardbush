import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { OpenAIResponsesProvider, OpenAIChatCompletionsProvider, AnthropicMessagesProvider } from '../dist/index.js';

for (const Provider of [OpenAIResponsesProvider, OpenAIChatCompletionsProvider, AnthropicMessagesProvider]) {
  test(`${Provider.name} refuses remote HTTP and does not forward credentials across redirects`, async t => {
    assert.throws(() => new Provider({ apiKey: 'fixture-secret', baseURL: 'http://remote.test/v1' }), /requires_https/);
    let redirected = 0, requested = 0;
    const target = createServer((_request, response) => { redirected++; response.end('{}'); });
    target.listen(0, '127.0.0.1'); await once(target, 'listening');
    const origin = createServer((request, response) => {
      requested++; assert.equal(request.headers['x-custom-key'], 'fixture-header');
      response.writeHead(307, { location: `http://127.0.0.1:${target.address().port}/capture` }); response.end();
    });
    origin.listen(0, '127.0.0.1'); await once(origin, 'listening');
    t.after(async () => { for (const server of [origin, target]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } });
    const provider = new Provider({ apiKey: 'fixture-secret', baseURL: `http://127.0.0.1:${origin.address().port}/v1`,
      defaultHeaders: { 'x-custom-key': 'fixture-header' }, timeoutMs: 3000 });
    try {
      for await (const _event of provider.stream({ protocol: 'bush.model_request.v1', requestId: 'request', sessionId: 'session', turnId: 'turn',
        model: 'fixture', messages: [{ role: 'user', content: 'hello' }], tools: [], metadata: {} })) { /* Failure may be a terminal provider event. */ }
    } catch (error) { assert.ok(error instanceof Error); }
    assert.ok(requested > 0); assert.equal(redirected, 0, 'neither body nor custom credentials may reach the redirect destination');
  });
}
