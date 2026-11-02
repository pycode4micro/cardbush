import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { BotGateway } from '../dist-electron/botGateway.mjs';
import { serveBotGatewayHttp } from '../dist-electron/botGatewayHttp.mjs';
import { parseBotGatewayConfig } from '../dist-electron/botGatewayConfig.mjs';
import { AgentHttpClient, AgentNetworkError } from '../dist-electron/agentHttpClient.mjs';
import { AgentService } from '../dist-electron/agentService.mjs';
import { serveAgentHttp } from '../dist-electron/agentServer.mjs';
import { openLocalChatClient } from '../dist-electron/agentLocalChat.mjs';

const token = 'synthetic-bot-token-12345678901234567890';
const secret = 'synthetic-callback-secret-12345678901234567890';
const base = resolve('tmp/bot-gateway-tests');
const config = (extra = {}) => ({ version: 1, host: '127.0.0.1', port: 0, language: 'en',
  channels: [{ id: 'fixture', token }], ...extra });
const message = (messageId, extra = {}) => ({ messageId, conversationId: 'chat', senderId: 'alice', text: 'hello', ...extra });
async function waitFor(work, predicate = value => value?.status === 'completed') {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) { const value = await work(); if (predicate(value)) return value; await delay(20); }
  throw new Error('fixture_timeout');
}
class Client {
  id = 'fixture-agent'; sessions = new Map(); jobs = new Map(); sends = 0; lostAck = false; interruptedStream = false; hold = false;
  async info() { return { id: this.id }; }
  async call(operation, input) {
    if (operation === 'product.command') return { defaultModelId: 'fixture-model', models: [{ id: 'fixture-model' }] };
    if (operation === 'sessions.get') return this.sessions.get(input.sessionId) ?? null;
    if (operation === 'sessions.create') { assert.equal(input.projectId, null); this.sessions.set(input.sessionId, input); return input; }
    if (operation === 'chat.jobs') return [...this.jobs.values()].filter(job => job.sessionId === input.sessionId);
    if (operation === 'chat.send') {
      const old = this.jobs.get(input.requestId);
      if (old) { assert.deepEqual(old.input, input); return old; }
      this.sends++;
      const job = { id: input.requestId, sessionId: input.sessionId, turnId: `turn-${this.sends}`, status: 'running', input };
      this.jobs.set(job.id, job);
      if (this.lostAck) { this.lostAck = false; throw new AgentNetworkError('lost_ack'); }
      return job;
    }
    throw Error(operation);
  }
  async *events(input, signal) {
    const job = [...this.jobs.values()].find(job => job.turnId === input.turnId);
    if (this.hold) await delay(60_000, undefined, { signal });
    const frame = (sequence, kind, payload) => ({ type: 'event', event: { protocol: 'bush.runtime_event.v1',
      eventId: `event-${sequence}`, requestId: job.id, sessionId: input.sessionId, turnId: input.turnId,
      sequence, createdAt: new Date().toISOString(), kind, payload } });
    const segment = { messageId: 'answer', segmentId: 'text', ordinal: 0, finalResponse: true };
    const frames = [frame(1, 'reasoning_segment_completed', { ...segment, content: 'PRIVATE REASONING' }),
      frame(2, 'assistant_segment_delta', { ...segment, delta: 'hello ' }),
      frame(3, 'assistant_segment_completed', { ...segment, content: 'hello world' }),
      frame(4, 'turn_terminal', { status: 'completed', reason: 'done', finalMessageId: 'answer' })];
    for (const value of frames) {
      if (value.event.sequence <= input.afterSequence) continue;
      yield value;
      if (value.event.sequence === 2 && this.interruptedStream) { this.interruptedStream = false; throw new AgentNetworkError('stream_cut'); }
    }
    job.status = 'completed';
    yield { type: 'end', afterSequence: 4 };
  }
}
async function fixture(t, settings = config(), client = new Client(), options = {}) {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'case-'));
  const f = { root, client, gateway: await BotGateway.open(join(root, 'receipts'), settings, client, { retryMs: 20, ...options }), http: undefined };
  t.after(async () => { await f.http?.close(); await f.gateway.close(); assert.ok(root.startsWith(base + sep)); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  return f;
}

test('message retries are idempotent, conflicts fail, and routing isolates users/connections/threads', async t => {
  const f = await fixture(t, config({ channels: [{ id: 'fixture', token }, { id: 'another', token: token + '2' }] }));
  const first = await f.gateway.accept('fixture', message('1'));
  await Promise.all(Array.from({ length: 12 }, () => f.gateway.accept('fixture', message('1'))));
  await waitFor(() => f.gateway.get('fixture', '1'));
  assert.equal(f.client.sends, 1);
  await assert.rejects(f.gateway.accept('fixture', message('1', { text: 'changed' })), { code: 'message_id_conflict' });
  const same = await f.gateway.accept('fixture', message('2'));
  const other = await f.gateway.accept('fixture', message('3', { senderId: 'bob' }));
  const thread = await f.gateway.accept('fixture', message('4', { threadId: 'topic' }));
  const channel = await f.gateway.accept('another', message('5'));
  assert.equal(same.sessionId, first.sessionId);
  assert.equal(new Set([first.sessionId, other.sessionId, thread.sessionId, channel.sessionId]).size, 4);
  assert.throws(() => f.gateway.get('another', '1'), { code: 'message_not_found' });
  await waitFor(() => f.gateway.get('fixture', '2'));
  assert.equal(f.client.jobs.get(first.requestId).input.permissionMode, 'task_free');
});
test('lost submission acknowledgements and event reconnects do not repeat inference or text', async t => {
  const client = new Client(); client.lostAck = client.interruptedStream = true;
  const f = await fixture(t, config(), client);
  const seen = []; f.gateway.subscribe(value => seen.push(value));
  await f.gateway.accept('fixture', message('lost'));
  const result = await waitFor(() => f.gateway.get('fixture', 'lost'));
  assert.equal(result.reply, 'hello world'); assert.equal(client.sends, 1);
  assert.ok(seen.some(value => value.status === 'reconnecting'));
  assert.ok(!JSON.stringify(seen).includes('PRIVATE REASONING'));
});
test('a temporary Windows file lock does not fail an accepted message', async t => {
  const f = await fixture(t), rename = fs.rename;
  let locked = false;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (!locked && /[a-f0-9]{64}\.json$/.test(to)) { locked = true; throw Object.assign(new Error('synthetic_file_lock'), { code: 'EPERM' }); }
    return rename(from, to);
  });
  await f.gateway.accept('fixture', message('locked'));
  assert.equal((await waitFor(() => f.gateway.get('fixture', 'locked'))).reply, 'hello world');
  assert.ok(locked); assert.equal(f.client.sends, 1);
});
test('stopping the gateway preserves running jobs and restart observes the same turn', async t => {
  const client = new Client(); client.hold = true;
  const f = await fixture(t, config(), client);
  await f.gateway.accept('fixture', message('restart'));
  await waitFor(() => f.gateway.get('fixture', 'restart'), result => result.status === 'running');
  await f.gateway.close(); assert.equal([...client.jobs.values()][0].status, 'running');
  client.hold = false;
  f.gateway = await BotGateway.open(join(f.root, 'receipts'), config(), client, { retryMs: 20 });
  const result = await waitFor(() => f.gateway.get('fixture', 'restart'));
  assert.equal(result.reply, 'hello world'); assert.equal(client.sends, 1);
});
test('saved receipts cannot be rebound to a different Agent, and only one gateway owns a directory', async t => {
  const f = await fixture(t);
  await assert.rejects(BotGateway.open(join(f.root, 'receipts'), config(), f.client));
  await f.gateway.close();
  const another = new Client(); another.id = 'different-agent';
  await assert.rejects(BotGateway.open(join(f.root, 'receipts'), config(), another), { code: 'agent_identity_changed' });
});
test('queued messages preserve arrival order across restart', async t => {
  const client = new Client(); client.hold = true;
  const f = await fixture(t, config(), client);
  for (let i = 0; i < 6; i++) await f.gateway.accept('fixture', message(`order-${i}`, { text: String(i) }));
  await waitFor(() => f.gateway.get('fixture', 'order-0'), value => value.status === 'running');
  await f.gateway.close(); client.hold = false;
  f.gateway = await BotGateway.open(join(f.root, 'receipts'), config(), client);
  await waitFor(() => f.gateway.get('fixture', 'order-5'));
  assert.deepEqual([...client.jobs.values()].map(job => job.input.text), ['0', '1', '2', '3', '4', '5']);
});
test('permission requests require local handling and never forward private tool details', async t => {
  const client = new Client();
  client.events = async function* (input, signal) {
    yield { type: 'event', event: { protocol: 'bush.runtime_event.v1', eventId: 'permission-event', sequence: 1,
      requestId: 'fixture', sessionId: input.sessionId, turnId: input.turnId, createdAt: new Date().toISOString(),
      kind: 'permission_requested', payload: { permissionId: 'permission-1', reason: 'PRIVATE COMMAND', actions: ['write'],
        targets: [{ kind: 'filesystem_path', value: 'PRIVATE PATH' }], requestedCapabilityIds: ['file:write'] } } };
    await delay(60_000, undefined, { signal });
  };
  const f = await fixture(t, config(), client);
  await f.gateway.accept('fixture', message('approval'));
  const result = await waitFor(() => f.gateway.get('fixture', 'approval'), value => value.status === 'needs_input');
  assert.deepEqual(result.attention, { kind: 'permission', id: 'permission-1' });
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  assert.equal([...client.jobs.values()][0].status, 'running');
});
test('a reconnect cannot silently move a task to a replacement Runtime', async t => {
  const client = new Client(); client.interruptedStream = true;
  client.reconnect = async () => { client.id = 'replacement-agent'; };
  const f = await fixture(t, config(), client);
  await f.gateway.accept('fixture', message('identity'));
  const result = await waitFor(() => f.gateway.get('fixture', 'identity'), value => value.status === 'failed');
  assert.equal(result.errorCode, 'agent_identity_changed'); assert.equal(client.sends, 1);
});
test('oversized model replies fail explicitly and keep bounded receipts', async t => {
  const client = new Client();
  client.events = async function* (input) {
    yield { type: 'event', event: { protocol: 'bush.runtime_event.v1', eventId: 'large', sequence: 1,
      requestId: 'fixture', sessionId: input.sessionId, turnId: input.turnId, createdAt: new Date().toISOString(),
      kind: 'assistant_segment_completed', payload: { messageId: 'answer', segmentId: 'large', ordinal: 0, content: 'x'.repeat(256_001) } } };
  };
  const f = await fixture(t, config(), client);
  await f.gateway.accept('fixture', message('large'));
  const result = await waitFor(() => f.gateway.get('fixture', 'large'), value => value.status === 'failed');
  assert.equal(result.errorCode, 'reply_too_large'); assert.ok(result.reply.length < 1000);
});
test('callbacks use signed stable delivery IDs, survive restart, and never restart the model', async t => {
  const settings = config({ channels: [{ id: 'fixture', token, callback: { url: 'http://127.0.0.1/fixture', secret } }] });
  const requests = [];
  const failed = async (url, options) => { requests.push(options); return new Response('', { status: 503 }); };
  const f = await fixture(t, settings, new Client(), { fetch: failed });
  await f.gateway.accept('fixture', message('callback'));
  await waitFor(() => requests.length, value => value > 0);
  await f.gateway.close();
  const delivered = [];
  f.gateway = await BotGateway.open(join(f.root, 'receipts'), settings, f.client, { retryMs: 20,
    fetch: async (url, options) => { delivered.push(options); return new Response('', { status: 200 }); } });
  await waitFor(() => delivered.length, value => value > 0);
  const first = requests[0], last = delivered[0];
  assert.equal(first.body, last.body); assert.equal(first.headers['X-CardBush-Delivery-ID'], last.headers['X-CardBush-Delivery-ID']);
  assert.equal(last.redirect, 'error');
  assert.equal(last.headers['X-CardBush-Signature'], 'v1=' + createHmac('sha256', secret).update(`${last.headers['X-CardBush-Timestamp']}.${last.body}`).digest('hex'));
  assert.equal(f.client.sends, 1);
  assert.equal(JSON.parse(last.body).reply, 'hello world');
});
test('HTTP webhook authentication, strict input, durable 202 receipts and cross-channel isolation', async t => {
  const client = new Client(); client.hold = true;
  const f = await fixture(t, config(), client); f.http = await serveBotGatewayHttp(f.gateway);
  const endpoint = `http://127.0.0.1:${f.http.port}/api/bots/v1/fixture/messages`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  assert.equal((await fetch(endpoint, { method: 'POST', body: '{}' })).status, 401);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, Origin: 'https://example.test' }, body: '{}' })).status, 401);
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ ...message('bad'), callbackUrl: 'http://127.0.0.1/untrusted' }) })).status, 400);
  assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(message('huge', { text: 'a'.repeat(200_000) })) })).status, 413);
  const reply = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(message('http')) });
  assert.equal(reply.status, 202); const receipt = await reply.json(); assert.equal(receipt.status, 'accepted');
  const current = await fetch(`http://127.0.0.1:${f.http.port}${reply.headers.get('location')}`, { headers });
  assert.equal((await current.json()).requestId, receipt.requestId);
  assert.equal(f.client.sends, 1);
});
test('WebSocket watches resume with full snapshots and publish no unrelated conversations', async t => {
  const f = await fixture(t); f.http = await serveBotGatewayHttp(f.gateway);
  const url = `ws://127.0.0.1:${f.http.port}/api/bots/v1/fixture/events`;
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  t.after(() => socket.terminate()); const frames = [];
  socket.on('message', data => frames.push(JSON.parse(data.toString()))); await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'message', message: message('socket') }));
  const final = await waitFor(() => frames.find(frame => frame.status === 'completed'));
  assert.equal(final.reply, 'hello world');
  await f.gateway.accept('fixture', message('unwatched', { senderId: 'bob' }));
  await waitFor(() => f.gateway.get('fixture', 'unwatched'));
  assert.ok(!frames.some(frame => frame.messageId === 'unwatched'));
  const second = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
  t.after(() => second.terminate()); const replay = [];
  second.on('message', data => replay.push(JSON.parse(data.toString()))); await once(second, 'open');
  second.send(JSON.stringify({ type: 'watch', messageId: 'socket' }));
  const recovered = await waitFor(() => replay.find(frame => frame.status === 'completed'));
  assert.deepEqual(recovered, final); assert.equal(f.client.sends, 2);
});
test('configuration validates environment references, callback transport and allowed senders', async t => {
  const input = { version: 1, channels: [{ id: 'generic', tokenEnv: 'BOT_TOKEN', allowedSenders: ['alice'],
    callback: { url: 'https://bot.example.test/replies', secretEnv: 'BOT_SECRET' } }] };
  const parsed = parseBotGatewayConfig(input, { BOT_TOKEN: token, BOT_SECRET: secret });
  assert.equal(parsed.channels[0].token, token);
  assert.throws(() => parseBotGatewayConfig(input, {}), { code: 'missing_or_invalid_secret' });
  assert.throws(() => parseBotGatewayConfig({ ...input, channels: [...input.channels, ...input.channels] }), { code: 'invalid_config' });
  assert.throws(() => parseBotGatewayConfig({ ...input, channels: [{ ...input.channels[0], callback: { ...input.channels[0].callback, url: 'http://remote.example/reply' } }] }, { BOT_TOKEN: token, BOT_SECRET: secret }), { code: 'invalid_callback_url' });
  const f = await fixture(t, parsed);
  await assert.rejects(f.gateway.accept('generic', message('unauthorized', { senderId: 'bob' })), { code: 'sender_not_allowed' });
  assert.equal(f.client.sends, 0);
});
test('public CLI validates an isolated config without launching a Runtime or printing secrets', async t => {
  const f = await fixture(t);
  const path = join(f.root, 'bot.json');
  await writeFile(path, JSON.stringify({ version: 1, language: 'zh', channels: [{ id: 'test', tokenEnv: 'BOT_TEST_TOKEN' }] }));
  const run = promisify(execFile);
  const result = await run(process.execPath, [resolve('bin/cardbush.mjs'), 'bots', '--config', path, '--check'],
    { env: { ...process.env, BOT_TEST_TOKEN: token }, windowsHide: true, timeout: 30_000 });
  assert.match(result.stdout, /配置有效/); assert.ok(!result.stdout.includes(token)); assert.equal(f.client.sends, 0);
  const help = await run(process.execPath, [resolve('bin/cardbush.mjs'), 'bots', '--help', '--language', 'en'], { windowsHide: true });
  assert.match(help.stdout, /generic Bot gateway/);
});

test('real Cardbush Runtime: generic webhook -> model -> signed callback, with conversation continuity', { timeout: 60_000 }, async t => {
  await mkdir(base, { recursive: true }); const root = await mkdtemp(join(base, 'real-'));
  const calls = [], callbacks = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (req.url === '/replies') { callbacks.push({ headers: req.headers, raw, body: JSON.parse(raw) }); res.writeHead(200).end('{}'); return; }
    const input = JSON.parse(raw);
    if (req.url.endsWith('/input_tokens')) { res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"input_tokens":100}'); return; }
    calls.push(input); const n = calls.length;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const item = { id: `message-${n}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: `synthetic-answer-${n}`, annotations: [] }] };
    const response = { id: `response-${n}`, object: 'response', model: input.model, status: 'in_progress', output: [] };
    for (const event of [{ type: 'response.created', response },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
      { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: `synthetic-answer-${n}` },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage: { input_tokens: 100, output_tokens: 5, total_tokens: 105 } } }]) res.write(`data: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); const origin = `http://127.0.0.1:${server.address().port}`;
  let service, agent, client, gateway, http, localClient, localGateway;
  const localRoot = join(root, 'local-runtime');
  try {
    service = await AgentService.open({ dataRoot: join(root, 'agent'), toolsEnabled: false, env: { CARDBUSH_RUNTIME_PROVIDER_MAX_ATTEMPTS: '1' } });
    await service.call('product.command', { kind: 'models.update', config: { defaultModelId: 'fixture-model', models: [
      { id: 'fixture-model', provider: 'openai', model: 'fixture', apiKey: 'synthetic', baseURL: `${origin}/v1` }] } });
    agent = await serveAgentHttp(service, { token, port: 0 }); client = new AgentHttpClient(`http://127.0.0.1:${agent.port}`, token);
    gateway = await BotGateway.open(join(root, 'receipts'), config({ channels: [{ id: 'fixture', token, callback: { url: `${origin}/replies`, secret } }] }), client);
    http = await serveBotGatewayHttp(gateway);
    const endpoint = `http://127.0.0.1:${http.port}/api/bots/v1/fixture/messages`;
    const send = input => fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(input) });
    assert.equal((await send(message('real-1', { text: 'Remember the synthetic word olive.' }))).status, 202);
    await waitFor(() => callbacks.find(value => value.body.messageId === 'real-1'), value => value?.body.status === 'completed');
    await send(message('real-1', { text: 'Remember the synthetic word olive.' }));
    await send(message('real-2', { text: 'What word did I provide?' }));
    const final = await waitFor(() => callbacks.find(value => value.body.messageId === 'real-2'), value => value?.body.status === 'completed');
    assert.equal(final.body.reply, 'synthetic-answer-2'); assert.equal(calls.length, 2);
    assert.equal(callbacks[0].body.sessionId, final.body.sessionId);
    assert.match(JSON.stringify(calls[1].input), /olive/);
    assert.match(JSON.stringify(calls[1].input), /synthetic-answer-1/);
    assert.equal(final.headers['x-cardbush-signature'], 'v1=' + createHmac('sha256', secret).update(`${final.headers['x-cardbush-timestamp']}.${final.raw}`).digest('hex'));
    // The default local route reads the selected App profile's configuration,
    // with a separate CLI Runtime. No user profile or real model is touched.
    const profile = join(root, 'profile'), modelPath = join(profile, 'product-host/config/models.json');
    await mkdir(join(profile, 'product-host/config'), { recursive: true });
    const modelText = await readFile(join(service.root, 'config/models.json'), 'utf8');
    await writeFile(modelPath, modelText);
    localClient = await openLocalChatClient({ dataRoot: localRoot, profileRoot: profile });
    localGateway = await BotGateway.open(join(root, 'local-receipts'), config(), localClient);
    await localGateway.accept('fixture', message('local', { text: 'A synthetic local profile message.' }));
    const localReply = await waitFor(() => localGateway.get('fixture', 'local'));
    assert.equal(localReply.reply, 'synthetic-answer-3');
    assert.equal(await readFile(modelPath, 'utf8'), modelText);
    await assert.rejects(readFile(join(localRoot, 'config/models.json')), { code: 'ENOENT' });
  } finally {
    await localGateway?.close(); await localClient?.close();
    if (localClient) await waitFor(() => readFile(join(localRoot, 'agent.lock'), 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return null; }), value => value === null);
    await http?.close(); await gateway?.close(); client?.close(); await agent?.close(); await service?.close();
    server.closeAllConnections(); await new Promise(done => server.close(done));
    assert.ok(root.startsWith(base + sep)); await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});
