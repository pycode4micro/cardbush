import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer as httpServer } from 'node:http';
import { createServer, connect } from 'node:net';
import { once, EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  const clients = new Set(), peers = new Set(), forwards = [];
  let connections = 0, reads = 0, mutations = 0, remoteId = 'stable-agent', holdInfo = false, loseReply = false;
  const token = 'fixture-agent-token-that-must-not-leak';
  const http = httpServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401).end(); return; }
    if (req.headers['x-cardbush-agent-id'] && req.headers['x-cardbush-agent-id'] !== remoteId) {
      res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'Agent identity changed.' } })); return;
    }
    res.setHeader('content-type', 'application/json'); res.setHeader('x-cardbush-agent-id', remoteId);
    if (req.url.endsWith('/info')) {
      reads++;
      if (holdInfo) return;
      res.end(JSON.stringify({ protocol: 'cardbush.agent.v1', apiVersion: 1, eventStreams: ['sse', 'ndjson'], id: remoteId, name: 'Fixture', platform: 'test', capabilities: { durableQueue: true } })); return;
    }
    let body = ''; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body);
    if (input.operation === 'sessions.create') { mutations++; if (loseReply) { req.socket.destroy(); return; } }
    res.end(JSON.stringify({ result: [] }));
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
        peer.on('error', () => stream.destroy()); peer.once('close', () => stream.destroy()); stream.pipe(peer).pipe(stream);
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
  const [agent] = await first.save({ name: 'Agent', transport: 'http', url: 'http://127.0.0.1:' + localPort, token,
    sshTunnel: { connectionId: connection.id, remoteHost: '127.0.0.1', remotePort } });
  t.after(async () => {
    await Promise.all(managers.map(item => item.close())); await ssh.close();
    for (const client of clients) client.end(); for (const peer of peers) peer.destroy();
    http.closeAllConnections(); await Promise.all([new Promise(resolve => http.close(resolve)), new Promise(resolve => server.close(resolve))]);
    await rm(root, { recursive: true, force: true });
  });
  return { root, store, token, ssh, agent, first, manager, localPort, remotePort, forwards,
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
  await assert.rejects(fetch(f.agent.url, { signal: AbortSignal.timeout(1000) }));
  const restarted = f.manager(); await restarted.restore();
  await until(() => f.connected(restarted), 'restore saved tunnel');
  assert.equal((await restarted.list())[0].agentId, 'stable-agent');
  assert.equal(f.stats().mutations, 0);
});

test('occupied local ports are rejected without sending credentials to another listener', async t => {
  const f = await fixture(t); let requests = 0;
  const occupied = httpServer((_req, res) => { requests++; res.end('{}'); }); await listen(occupied, f.localPort);
  try { await assert.rejects(f.first.connect(f.agent.id), /端口.*已被占用/); assert.equal(requests, 0); }
  finally { await new Promise(resolve => occupied.close(resolve)); }
  await until(() => f.connected(), 'recover after conflicting listener exits');
});

test('closing while the HTTP handshake is pending releases its port and cancels reconnects', async t => {
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

test('disconnect and remove cancel reconnect attempts and release listening ports', async t => {
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
  await f.first.save({ id: before.id, name: before.name, transport: 'http', url: before.url, sshTunnel: before.sshTunnel });
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

test('Agents share SSH authentication but own independent local listeners', async t => {
  const f = await fixture(t), port = await freePort();
  const second = (await f.first.save({ name: 'Second', transport: 'http', url: 'http://127.0.0.1:' + port, token: f.token, sshTunnel: f.agent.sshTunnel })).at(-1);
  await Promise.all([f.first.connect(f.agent.id), f.first.connect(second.id)]);
  assert.equal(f.stats().connections, 1);
  await f.first.disconnect(f.agent.id);
  assert.equal((await f.first.list()).find(item => item.id === second.id).connected, true);
  assert.deepEqual(await f.first.call(second.id, 'sessions.list'), []);
});

test('managed tunnels can change their local port while retaining the bound Agent identity', async t => {
  const f = await fixture(t); await f.first.connect(f.agent.id);
  const port = await freePort();
  await f.first.save({ id: f.agent.id, name: f.agent.name, transport: 'http', url: 'http://127.0.0.1:' + port, sshTunnel: f.agent.sshTunnel });
  assert.equal((await f.first.connect(f.agent.id)).id, 'stable-agent');
  const listener = createServer(); await listen(listener, f.localPort); await new Promise(resolve => listener.close(resolve));
  await assert.rejects(f.first.save({ name: 'bad', transport: 'http', url: 'https://remote.invalid', token: f.token, sshTunnel: f.agent.sshTunnel }), /本机回环/);
});

test('a socket arriving as SSH closes cannot throw out of the main process listener', async t => {
  const client = Object.assign(new EventEmitter(), { forwardOut() { throw Error('Not connected'); } });
  const port = await freePort();
  const tunnel = await openSshTunnel(client, 'http://127.0.0.1:' + port, '127.0.0.1', 4780, new AbortController().signal);
  t.after(() => tunnel.close());
  const socket = connect(port, '127.0.0.1'); socket.on('error', () => {});
  await new Promise(resolve => socket.once('close', resolve)); await tunnel.closed;
  const server = createServer(); await listen(server, port); await new Promise(resolve => server.close(resolve));
  await assert.rejects(openSshTunnel(client, 'http://127.0.0.1:0', '127.0.0.1', 4780, new AbortController().signal), /端口/);
});
