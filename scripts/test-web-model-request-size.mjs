import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { serveWeb } from '../dist-electron/webServer.mjs';
import { modelToken } from '../dist-electron/webCommon.mjs';
import { WebModelRequests, WEB_MODEL_REQUEST_MAX_BYTES } from '../dist-electron/webModelRequests.mjs';
import { requestBodyBudget } from '../packages/bush-provider-openai/dist/requestBodyBudget.js';

async function fixture(t, handle) {
  const calls = [];
  const provider = createServer(async (request, response) => {
    let raw = ''; for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    calls.push({ bytes: Buffer.byteLength(raw), path: request.url, model: body.model, store: body.store,
      textLength: body.input?.length, key: request.headers.authorization });
    if (handle) return handle(request, response);
    response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
  });
  provider.listen(0, '127.0.0.1'); await once(provider, 'listening');
  const store = { async user(id) { return { id, is_active: id !== 'inactive' }; } };
  const web = await serveWeb({ origin: 'http://fixture.test', host: '127.0.0.1', port: 0, staticRoot: resolve('dist-web'),
    modelSecret: 'm'.repeat(64), defaultModelId: 'fixture', models: [{ id: 'fixture', name: 'Fixture', model: 'fixture',
      apiKey: 'private-fixture-key', baseURL: `http://127.0.0.1:${provider.address().port}` }] }, store, { close() {} });
  t.after(async () => { await web.close(); provider.closeAllConnections(); await new Promise(done => provider.close(done)); });
  const url = `http://127.0.0.1:${web.port}/internal/model/alice/fixture/`;
  const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${modelToken('m'.repeat(64), 'alice')}` };
  return { url, headers, calls, post: (body, endpoint = 'responses', extra = {}) => fetch(url + endpoint, {
    method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body), ...extra }) };
}

test('gateway wire budget matches native provider and accepts 17–40 MB requests', async t => {
  assert.equal(WEB_MODEL_REQUEST_MAX_BYTES, requestBodyBudget({}).maxBytes);
  const f = await fixture(t);
  for (const [bytes, endpoint] of [[17_000_000, 'responses'], [23_000_000, 'chat/completions'], [40_000_000, 'responses/input_tokens']]) {
    const shape = { model: 'fixture', store: false, input: '' };
    shape.input = 'x'.repeat(bytes - Buffer.byteLength(JSON.stringify(shape)));
    const body = JSON.stringify(shape); assert.equal(Buffer.byteLength(body), bytes);
    const response = await f.post(body, endpoint);
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), { ok: true });
    assert.equal(f.calls.at(-1).bytes, bytes); assert.equal(f.calls.at(-1).textLength, shape.input.length);
    assert.equal(f.calls.at(-1).key, 'Bearer private-fixture-key');
  }
});

test('oversized known-length and chunked bodies fail before provider dispatch; next request works', async t => {
  const f = await fixture(t);
  const oversized = JSON.stringify({ input: 'x'.repeat(WEB_MODEL_REQUEST_MAX_BYTES) });
  let response = await f.post(oversized);
  assert.equal(response.status, 413); assert.match((await response.json()).error, /40 MB/);
  const chunked = await new Promise((resolve, reject) => {
    const request = httpRequest(f.url + 'responses', { method: 'POST', headers: f.headers }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => body += chunk);
      response.on('end', () => resolve({ status: response.statusCode, body }));
    });
    request.on('error', reject);
    void (async () => {
      request.write('{"input":"');
      const chunk = 'x'.repeat(100_000);
      for (let i = 0; i < 401; i++) if (!request.write(chunk)) await once(request, 'drain');
      request.end('"}');
    })().catch(reject);
  });
  assert.equal(chunked.status, 413); assert.match(chunked.body, /40 MB/);
  assert.equal(f.calls.length, 0);
  response = await f.post({ input: 'next request' }); assert.equal(response.status, 200); await response.text();
  assert.equal(f.calls.length, 1);
});

test('open model response streams do not serialize other accounts or later requests', async t => {
  let first;
  const f = await fixture(t, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/event-stream' }); response.flushHeaders();
    if (!first) { first = response; response.write('data: first\n\n'); }
    else response.end('data: second\n\n');
  });
  const response = await f.post({ input: 'first' }); const reader = response.body.getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /first/);
  const second = await f.post({ input: 'second' }, 'responses', { signal: AbortSignal.timeout(3000) });
  assert.match(await second.text(), /second/);
  assert.equal(first.writableEnded, false);
  first.end('data: done\n\n'); while (!(await reader.read()).done) {};
});

test('bounded preparation queue releases canceled waiters without blocking others', async () => {
  const slots = new WebModelRequests();
  const release = await slots.acquire(new AbortController().signal);
  const cancel = new AbortController();
  const canceled = slots.acquire(cancel.signal); const rejected = assert.rejects(canceled, /cancel fixture/);
  let acquired = false;
  const next = slots.acquire(new AbortController().signal).then(release => { acquired = true; return release; });
  cancel.abort(new Error('cancel fixture')); await rejected;
  assert.equal(acquired, false); release(); release();
  (await next)(); (await slots.acquire(new AbortController().signal))();
});

test('larger proxy body budget retains account, origin and tool authorization', async t => {
  const f = await fixture(t);
  const body = JSON.stringify({ input: 'x'.repeat(17_000_000), tools: [{ type: 'function', name: 'terminal_exec' }] });
  let response = await f.post(body); assert.equal(response.status, 403); await response.text();
  response = await f.post({}, 'responses', { headers: { ...f.headers, Origin: 'http://fixture.test' } });
  assert.equal(response.status, 404); await response.text();
  response = await fetch(f.url.replace('/alice/', '/bob/') + 'responses', { method: 'POST', headers: f.headers, body: '{}' });
  assert.equal(response.status, 401); await response.text();
  response = await fetch(f.url.replace('/alice/', '/inactive/') + 'responses', { method: 'POST', headers: {
    ...f.headers, Authorization: `Bearer ${modelToken('m'.repeat(64), 'inactive')}` }, body: '{}' });
  assert.equal(response.status, 401); await response.text();
  assert.equal(f.calls.length, 0);
});
