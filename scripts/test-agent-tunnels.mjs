import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer as httpServer } from 'node:http';
import { createServer, connect, Server } from 'node:net';
import { PassThrough } from 'node:stream';
import { once, EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ssh2 from 'ssh2';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import { AgentConnectionManager } from '../dist-electron/agentConnections.mjs';
import { SshConnectionManager } from '../dist-electron/sshConnections.mjs';
import { openSshTunnel } from '../dist-electron/sshTunnel.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) { for (let i = 0; i < 200; i++) { if (await check()) return; await pause(20); } assert.fail(label); }
const listen = async (server, port = 0) => { server.listen(port, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };
const freePort = async () => { const server = createServer(); const port = await listen(server); await new Promise(resolve => server.close(resolve)); return port; };
const cipher = { encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() };

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-tunnel-'));
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs1' });
  const fingerprint = 'SHA256:' + createHash('sha256').update(ssh2.utils.parseKey(key).getPublicSSH()).digest('base64').replace(/=+$/, '');
  const clients = new Set(), peers = new Set(), forwards = [], events = new Set();
  let connections = 0, reads = 0, mutations = 0, remoteId = 'stable-agent', holdInfo = false, loseReply = false;
  const token = 'fixture-agent-token-that-must-not-leak';
  const http = httpServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401).end(); return; }
    if (req.headers['x-cardbush-agent-id'] && req.headers['x-cardbush-agent-id'] !== remoteId) {
      res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Agent identity changed.' } })); return;
    }
    res.setHeader('content-type', 'application/json'); res.setHeader('x-cardbush-agent-id', remoteId);
    if (req.url.includes('/events?')) {
      const query = new URL(req.url, 'http://fixture').searchParams;
      const sse = req.headers.accept === 'text/event-stream';
      res.setHeader('content-type', sse ? 'text/event-stream' : 'application/x-ndjson');
      const send = frame => res.write(sse ? `data: ${JSON.stringify(frame)}\n\n` : JSON.stringify(frame) + '\n');
      send({ type: 'ready', agentId: remoteId });
      const finish = () => {
        send({ type: 'event', event: { sessionId: query.get('sessionId'), turnId: query.get('turnId'), sequence: Number(query.get('afterSequence') || 0) + 1, payload: { text: '通道回复' } } });
        send({ type: 'end' }); res.end();
      };
      events.add(finish); res.once('close', () => events.delete(finish)); return;
    }
    if (req.url.endsWith('/info')) {
      reads++;
      if (holdInfo) return;
      res.end(JSON.stringify({ protocol: 'cardbush.agent.v1', apiVersion: 1, eventStreams: ['sse', 'ndjson'], id: remoteId, name: 'Fixture', platform: 'test', capabilities: { durableQueue: true } })); return;
    }
    req.setEncoding('utf8');
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    if (input.operation === 'sessions.create') { mutations++; if (loseReply) { req.socket.destroy(); return; } }
    if (input.operation === 'files.upload') res.setHeader('connection', 'close');
    res.end(JSON.stringify({ result: input.operation === 'files.upload' ? input.input.content : [] }));
  });
  const remotePort = await listen(http);
  const server = new ssh2.Server({ hostKeys: [key] }, client => {
    connections++; clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', context => { if (options.holdAuthentication) return; if (context.method === 'password' && context.password === 'fixture-password') context.accept(); else context.reject(); });
    client.on('ready', () => client.on('tcpip', (accept, reject, info) => {
      forwards.push(info);
      const peer = connect(info.destPort, info.destIP); peers.add(peer); peer.once('close', () => peers.delete(peer));
      peer.once('error', () => { reject(); peer.destroy(); });
      peer.once('connect', () => {
        const stream = accept(); stream.on('error', () => peer.destroy()); stream.once('close', () => peer.destroy());
        // pipe() drains pending writes before forwarding a clean EOF to SSH.
        peer.on('error', () => stream.destroy()); stream.pipe(peer).pipe(stream);
      });
    }));
  });
  const sshPort = await listen(server);
  const ssh = new SshConnectionManager(join(root, 'ssh.json'), cipher);
  const [connection] = await ssh.save({ name: 'Fixture', host: '127.0.0.1', port: sshPort, username: 'test', authentication: 'password', password: 'fixture-password', defaultDirectory: '/', ...(options.untrusted ? {} : { fingerprint }) });
  const localPort = await freePort(), store = join(root, 'agents.json');
  const managers = [];
  const manager = () => { const value = new AgentConnectionManager(store, cipher, { ssh, reconnectDelayMs: 20, healthIntervalMs: options.healthIntervalMs ?? 60_000 }); managers.push(value); return value; };
  const first = manager();
  const [agent] = await first.save({ name: 'Agent', transport: 'http', token,
    sshTunnel: { connectionId: connection.id, remoteHost: '127.0.0.1', remotePort } });
  t.after(async () => {
    await Promise.all(managers.map(item => item.close())); await ssh.close();
    for (const client of clients) client.end(); for (const peer of peers) peer.destroy();
    http.closeAllConnections(); await Promise.all([new Promise(resolve => http.close(resolve)), new Promise(resolve => server.close(resolve))]);
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, token, ssh, agent, first, manager, localPort, remotePort, forwards,
    finishEvents: () => { for (const finish of events) finish(); },
    stats: () => ({ connections, reads, mutations }), drop: () => { for (const client of clients) client.end(); },
    hold: value => { holdInfo = value; }, loseReply: () => { loseReply = true; }, identity: value => { remoteId = value; },
    connected: async (value = first) => (await value.list())[0]?.connected };
}

test('managed tunnels coalesce concurrent connects, reconnect after SSH loss and restore after app restart', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 8 }, () => f.first.connect(f.agent.id)));
  assert.equal(results.every(info => info.id === 'stable-agent'), true);
  assert.equal(f.stats().connections, 1);
  assert.equal(f.stats().reads, 1);
  assert.ok(f.forwards.every(item => item.destIP === '127.0.0.1' && item.destPort === f.remotePort));
  assert.doesNotMatch(JSON.stringify(await f.first.list()), /fixture-agent-token|fixture-password/);
  assert.doesNotMatch(await readFile(f.store, 'utf8'), /fixture-agent-token/);
  f.drop();
  await until(async () => f.stats().connections >= 2 && await f.connected(), 'automatic reconnect');
  await f.first.close();
  assert.equal((await f.ssh.list())[0].status, 'connected', 'closing an Agent keeps the shared SSH connection');
  const restarted = f.manager(); await restarted.restore();
  await until(() => f.connected(restarted), 'restore saved tunnel');
  assert.equal((await restarted.list())[0].agentId, 'stable-agent');
  assert.equal(f.stats().mutations, 0);
});

test('legacy local forwarding addresses are migrated without listening or sending credentials to that port', async t => {
  const f = await fixture(t); let requests = 0;
  const saved = JSON.parse(await readFile(f.store, 'utf8'));
  saved[0].url = 'http://127.0.0.1:' + f.localPort + '/agent-a/';
  saved[0].agentId = 'stable-agent';
  await writeFile(f.store, JSON.stringify(saved));
  const occupied = httpServer((_req, res) => { requests++; res.end('{}'); }); await listen(occupied, f.localPort);
  const listenGuard = t.mock.method(Server.prototype, 'listen', () => assert.fail('Agent must not create a local listener'));
  try {
    assert.equal((await f.first.connect(f.agent.id)).id, 'stable-agent');
    assert.deepEqual(await f.first.call(f.agent.id, 'sessions.list'), []);
    assert.equal(requests, 0);
    const [migrated] = JSON.parse(await readFile(f.store, 'utf8'));
    assert.equal(migrated.url, `http://127.0.0.1:${f.remotePort}/agent-a/`);
    assert.equal(migrated.token, saved[0].token);
  } finally { listenGuard.mock.restore(); await new Promise(resolve => occupied.close(resolve)); }
});

test('closing while the HTTP handshake is pending closes channels and cancels reconnects', async t => {
  const f = await fixture(t); f.hold(true);
  const pending = assert.rejects(f.first.connect(f.agent.id));
  await until(() => f.stats().reads === 1, 'handshake reached');
  await f.first.close(); await pending;
  const stats = f.stats(); await pause(100); assert.deepEqual(f.stats(), stats);
  const port = createServer(); await listen(port, f.localPort); await new Promise(resolve => port.close(resolve));
});

test('an uncertain mutation is never replayed when the tunnel reconnects', async t => {
  const f = await fixture(t); await f.first.connect(f.agent.id); f.loseReply();
  await assert.rejects(f.first.call(f.agent.id, 'sessions.create', { title: 'once' }));
  await until(() => f.connected(), 'connection recovers'); await pause(80);
  assert.equal(f.stats().mutations, 1);
});

test('health checks detect a changed remote Agent identity and never adopt it', async t => {
  const f = await fixture(t, { healthIntervalMs: 20 }); await f.first.connect(f.agent.id); f.identity('other-agent');
  await until(async () => (await f.first.list())[0].connectionState === 'disconnected', 'identity failure stops automatic retries');
  await assert.rejects(f.first.connect(f.agent.id), /identity changed/);
  assert.equal((await f.first.list())[0].agentId, 'stable-agent'); assert.equal(f.stats().mutations, 0);
});

test('disconnect and remove cancel reconnect attempts and close Agent channels', async t => {
  const f = await fixture(t); await f.first.connect(f.agent.id); f.drop();
  await f.first.disconnect(f.agent.id); const count = f.stats().connections; await pause(100);
  assert.equal(f.stats().connections, count); assert.equal((await f.first.list())[0].connectionState, 'disconnected');
  await f.first.connect(f.agent.id); await f.first.remove(f.agent.id); await pause(100);
  assert.deepEqual(await f.first.list(), []);
  const port = createServer(); await listen(port, f.localPort); await new Promise(resolve => port.close(resolve));
});

test('unknown host keys are not implicitly trusted by automatic tunnels', async t => {
  const f = await fixture(t, { untrusted: true });
  await assert.rejects(f.first.connect(f.agent.id), /主机指纹/);
  const count = f.stats().connections; await pause(100); assert.equal(f.stats().connections, count);
  await f.first.disconnect(f.agent.id);
  assert.equal(f.stats().reads, 0); assert.equal(f.forwards.length, 0);
});

test('an existing direct connection can enable a tunnel without losing token or Agent identity', async t => {
  const f = await fixture(t); await f.first.connect(f.agent.id);
  const before = (await f.first.list())[0];
  await f.first.save({ id: before.id, name: before.name, transport: 'http', url: before.url, sshTunnel: null });
  assert.equal((await f.first.list())[0].sshTunnel, undefined);
  assert.equal((await f.first.connect(before.id)).id, before.agentId, 'plain HTTP still connects');
  await f.first.save({ id: before.id, name: before.name, transport: 'http', sshTunnel: before.sshTunnel });
  await f.first.connect(before.id);
  const after = (await f.first.list())[0]; assert.equal(after.agentId, before.agentId); assert.equal(after.hasToken, true);
});

test('local tunneled requests bypass the process proxy dispatcher', async t => {
  const f = await fixture(t), previous = getGlobalDispatcher(), blocked = new MockAgent(); blocked.disableNetConnect();
  setGlobalDispatcher(blocked);
  try { assert.equal((await f.first.connect(f.agent.id)).id, 'stable-agent'); }
  finally { setGlobalDispatcher(previous); await blocked.close(); }
});

test('shutdown cancels a pending SSH handshake without waiting for its timeout', async t => {
  const f = await fixture(t, { holdAuthentication: true });
  const pending = assert.rejects(f.first.connect(f.agent.id));
  await until(() => f.stats().connections === 1, 'SSH handshake pending');
  await Promise.race([f.first.close(), pause(1000).then(() => assert.fail('Agent shutdown waited for SSH timeout'))]);
  await pending;
  await Promise.race([f.ssh.close(), pause(1000).then(() => assert.fail('SSH shutdown waited for handshake timeout'))]);
  assert.equal(f.stats().reads, 0);
});

test('Agents share SSH authentication but own independent channel pools without local ports', async t => {
  const f = await fixture(t);
  const second = (await f.first.save({ name: 'Second', transport: 'http', token: f.token, sshTunnel: f.agent.sshTunnel })).at(-1);
  await Promise.all([f.first.connect(f.agent.id), f.first.connect(second.id)]);
  assert.equal(f.stats().connections, 1);
  await f.first.disconnect(f.agent.id);
  assert.equal((await f.first.list()).find(item => item.id === second.id).connected, true);
  assert.deepEqual(await f.first.call(second.id, 'sessions.list'), []);
});

test('SSH connection edits retain identity and validate the remote target', async t => {
  const f = await fixture(t); await f.first.connect(f.agent.id);
  await f.first.save({ id: f.agent.id, name: 'Renamed', transport: 'http', sshTunnel: f.agent.sshTunnel });
  assert.equal((await f.first.connect(f.agent.id)).id, 'stable-agent');
  await assert.rejects(f.first.save({ name: 'bad', transport: 'http', token: f.token, sshTunnel: { ...f.agent.sshTunnel, remoteHost: 'remote.invalid' } }));
  await assert.rejects(f.first.save({ name: 'bad', transport: 'http', token: f.token, sshTunnel: { ...f.agent.sshTunnel, remotePort: 0 } }));
  await assert.rejects(f.first.save({ name: 'bad', transport: 'http', token: f.token }), /服务地址/);
});

test('opening a channel as SSH closes reports an error instead of throwing from the connector', async t => {
  const client = Object.assign(new EventEmitter(), { forwardOut() { throw Error('Not connected'); } });
  const tunnel = await openSshTunnel(client, '127.0.0.1', 4780, new AbortController().signal);
  t.after(() => tunnel.close());
  await assert.rejects(new Promise((resolve, reject) => tunnel.connect({ protocol: 'http:', hostname: '127.0.0.1', port: '4780' }, (error, stream) => error ? reject(error) : resolve(stream))), /Not connected/);
  await tunnel.closed;
  await assert.rejects(openSshTunnel(client, '127.0.0.1', 0, new AbortController().signal), /端口/);
});

test('aborting a pending channel calls back once and destroys a late channel without closing shared SSH', async t => {
  let accept, ended = false, callbacks = 0;
  const client = Object.assign(new EventEmitter(), { forwardOut(_src, _port, _host, _remotePort, done) { accept = done; }, end() { ended = true; } });
  const abort = new AbortController();
  const tunnel = await openSshTunnel(client, '127.0.0.1', 4780, abort.signal);
  t.after(() => tunnel.close());
  tunnel.connect({ protocol: 'http:', hostname: '127.0.0.1', port: '4780' }, error => { callbacks++; assert.match(error.message, /已关闭/); });
  abort.abort(); await tunnel.closed;
  const late = new PassThrough(); accept(null, late);
  assert.equal(callbacks, 1); assert.equal(late.destroyed, true); assert.equal(ended, false);
  assert.equal(client.listenerCount('close'), 0); assert.equal(client.listenerCount('error'), 0);
});

test('SSH connector refuses requests for another destination without opening a channel', async t => {
  const client = Object.assign(new EventEmitter(), { forwardOut() { assert.fail('unexpected destination'); } });
  const tunnel = await openSshTunnel(client, '127.0.0.1', 4780, new AbortController().signal);
  t.after(() => tunnel.close());
  for (const options of [{ protocol: 'https:', hostname: '127.0.0.1', port: '4780' }, { protocol: 'http:', hostname: 'remote.invalid', port: '4780' }, { protocol: 'http:', hostname: '127.0.0.1', port: '80' }]) {
    await assert.rejects(new Promise((resolve, reject) => tunnel.connect(options, (error, stream) => error ? reject(error) : resolve(stream))), /目标/);
  }
});

for (const format of ['sse', 'ndjson']) test(`${format} over SSH supports simultaneous commands, channel cancellation and replay after reconnect`, async t => {
  const f = await fixture(t); await f.first.connect(f.agent.id);
  const events = f.first.events(f.agent.id, { sessionId: 'session', turnId: 'turn' }, new AbortController().signal, format);
  t.after(() => events.return());
  assert.equal((await events.next()).value.type, 'ready');
  const content = '大文件通道测试'.repeat(100_000);
  const echoed = await f.first.call(f.agent.id, 'files.upload', { content });
  assert.equal(createHash('sha256').update(echoed).digest('hex'), createHash('sha256').update(content).digest('hex'));
  assert.ok(f.forwards.length >= 2, 'commands have a channel independent of the event stream');
  const dropped = assert.rejects(events.next()); f.drop(); await dropped;
  await until(() => f.connected(), 'reconnect before event replay');
  const resumed = f.first.events(f.agent.id, { sessionId: 'session', turnId: 'turn', afterSequence: 4 }, new AbortController().signal, format);
  t.after(() => resumed.return());
  assert.equal((await resumed.next()).value.type, 'ready'); f.finishEvents();
  const frame = (await resumed.next()).value;
  assert.equal(frame.event.sequence, 5); assert.equal(frame.event.payload.text, '通道回复');
  assert.equal((await resumed.next()).value.type, 'end'); assert.equal((await resumed.next()).done, true);
  const abort = new AbortController();
  const cancelled = f.first.events(f.agent.id, { sessionId: 'session', turnId: 'other' }, abort.signal, format);
  t.after(() => cancelled.return());
  assert.equal((await cancelled.next()).value.type, 'ready');
  const pending = assert.rejects(cancelled.next()); abort.abort(); await pending;
  assert.deepEqual(await f.first.call(f.agent.id, 'sessions.list'), [], 'cancelling a stream leaves command channels usable');
});
