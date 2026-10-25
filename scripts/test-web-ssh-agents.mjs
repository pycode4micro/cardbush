import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import ssh2 from 'ssh2';
import { connectSshRemoteClient, createSshRemoteClient, reconnectingSshRemoteClient, RemoteSshTrustRequired } from '../dist-electron/webRemoteSsh.mjs';
import { WebRemoteAgents } from '../dist-electron/webRemoteAgents.mjs';
import { registerSkillTools, ToolRegistry, ToolExecutionCoordinator } from '../packages/bush-runtime/dist/index.js';
import { webToolDenial } from '../packages/bush-runtime/dist/webToolPolicy.js';
import { resolve } from 'node:path';

const info = { protocol: 'cardbush.agent.v1', apiVersion: 1, id: 'ssh-agent', name: 'SSH slicing agent', platform: 'linux', eventStreams: ['sse', 'ndjson'], capabilities: { durableQueue: true, delegation: true } };
const sshInput = { host: '192.168.1.45', port: 22, username: 'worker', authentication: 'password', password: 'sensitive-ssh-password', fingerprint: 'SHA256:' + 'a'.repeat(43), remotePort: 4780 };
const agentInput = { id: 'remote-ssh', name: '切片助手', transport: 'ssh', ssh: sshInput, token: 'sensitive-agent-token', enabled: true, userIds: ['alice'] };
const users = new Set(['alice', 'bob']);
class Repository {
  row;
  async initialize(payload) { this.row ??= { revision: 1, payload }; }
  async read() { return structuredClone(this.row); }
  async replace(revision, payload) { if (revision !== this.row.revision) return null; return this.row = { revision: revision + 1, payload }; }
}
const save = (registry, agent = agentInput) => registry.update({ action: 'save', revision: registry.view().revision, agent }, users);

test('SSH registry encrypts and redacts credentials, preserves edits and offline revocation', async () => {
  const repository = new Repository(); let last, offline = false;
  const factory = async connection => { last = connection; if (offline) throw Error('sensitive-ssh-password'); return { info: async () => info, close() {} }; };
  const registry = new WebRemoteAgents('test-secret'.repeat(8), repository, factory); await registry.initialize();
  await save(registry);
  assert.equal(last.ssh.password, sshInput.password);
  assert.doesNotMatch(repository.row.payload + JSON.stringify(registry.view()), /sensitive-/);
  const view = registry.view().agents[0]; assert.equal(view.ssh.hasPassword, true); assert.equal(view.ssh.password, undefined);
  assert.deepEqual((await registry.list('alice'))[0], { id: agentInput.id, name: agentInput.name, description: '', agentId: info.id });
  assert.equal((await registry.list('bob')).length, 0);
  await save(registry, { ...agentInput, token: '', ssh: { ...sshInput, password: '' } });
  assert.equal(last.ssh.password, sshInput.password);
  offline = true;
  await save(registry, { ...agentInput, enabled: false, token: '', ssh: { ...sshInput, password: '' } });
  await assert.rejects(registry.authorized('alice', agentInput.id), /授权/);
  await assert.rejects(save(registry), error => error.status === 502 && !error.message.includes('sensitive'));
  const restored = new WebRemoteAgents('test-secret'.repeat(8), repository, factory); await restored.initialize();
  assert.equal(restored.view().agents[0].ssh.hasPassword, true);
});

test('SSH targets, identity, secret replacement and trust remain pinned with multiple authorized people', async () => {
  const registry = new WebRemoteAgents('test-secret'.repeat(8), new Repository(), async () => ({ info: async () => info, close() {} })); await registry.initialize(); await save(registry);
  for (const patch of [{ host: '192.168.1.46' }, { remotePort: 4790 }, { username: 'other' }, { fingerprint: 'SHA256:' + 'b'.repeat(43) }])
    await assert.rejects(save(registry, { ...agentInput, ssh: { ...sshInput, ...patch } }), /不可替换/);
  await save(registry, { ...agentInput, userIds: ['alice', 'bob'] });
  assert.equal((await registry.list('bob')).length, 1);
  await assert.rejects(save(registry, { ...agentInput, transport: 'http', url: 'https://example.test' }), /连接方式/);
  await assert.rejects(save(registry, { ...agentInput, ssh: { ...sshInput, privateKeyPath: '/secrets/key' } }));
  await save(registry, { ...agentInput, ssh: { ...sshInput, authentication: 'key', privateKey: 'secret-new-key', passphrase: 'secret-passphrase' } });
  const connection = await registry.authorized('alice', agentInput.id);
  assert.equal(connection.ssh.password, undefined); assert.equal(connection.ssh.privateKey, 'secret-new-key');
  assert.doesNotMatch(JSON.stringify(registry.view()), /secret-new|secret-pass/);
  await save(registry, { ...agentInput, ssh: { ...sshInput, authentication: 'key', privateKey: 'replacement-unencrypted-key', passphrase: '' } });
  assert.equal((await registry.authorized('alice', agentInput.id)).ssh.passphrase, '');
  await registry.update({ action: 'delete', revision: registry.view().revision, id: agentInput.id }, users);
  await save(registry, { ...agentInput, id: 'replacement', userIds: ['bob'] });
  await assert.rejects(save(registry, { ...agentInput, id: 'replacement', ssh: { ...sshInput, fingerprint: '' } }), /指纹/);
});

test('untrusted SSH test returns a fingerprint without saving a connection or exposing credentials', async () => {
  const registry = new WebRemoteAgents('test-secret'.repeat(8), new Repository(), async () => { throw new RemoteSshTrustRequired(sshInput.fingerprint); });
  await registry.initialize();
  const result = await registry.update({ action: 'test', agent: { ...agentInput, ssh: { ...sshInput, fingerprint: '' } } }, users);
  assert.deepEqual(result, { ok: false, needsTrust: true, fingerprint: sshInput.fingerprint });
  assert.equal(registry.view().agents.length, 0); assert.equal(registry.view().revision, 1);
  for (const host of ['127.0.0.1', 'localhost', '169.254.169.254', '::1', '::ffff:127.0.0.1', '0.0.0.0'])
    await assert.rejects(createSshRemoteClient({ token: 'secret', ssh: { ...sshInput, host } }), undefined, host);
});

async function fixture(t) {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs1' });
  const loginKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ format: 'pem', type: 'pkcs1', cipher: 'aes-256-cbc', passphrase: 'key-passphrase' });
  const parsedLoginKey = ssh2.utils.parseKey(loginKey, 'key-passphrase');
  const fingerprint = 'SHA256:' + createHash('sha256').update(ssh2.utils.parseKey(key).getPublicSSH()).digest('base64').replace(/=+$/, '');
  const clients = new Set(), peers = new Set(), authentication = [], forwards = [], operations = [];
  let sessions = 0;
  const http = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer sensitive-agent-token');
    response.setHeader('x-cardbush-agent-id', info.id); response.setHeader('content-type', 'application/json');
    if (request.url.endsWith('/info')) { response.end(JSON.stringify(info)); return; }
    if (request.url.includes('/events?')) {
      response.setHeader('content-type', 'application/x-ndjson');
      const query = new URL(request.url, 'http://test').searchParams;
      response.write(JSON.stringify({ type: 'ready', agentId: info.id }) + '\n');
      response.write(JSON.stringify({ type: 'event', event: { sessionId: query.get('sessionId'), turnId: query.get('turnId'), sequence: Number(query.get('afterSequence')) + 1 } }) + '\n');
      response.end(JSON.stringify({ type: 'end' }) + '\n'); return;
    }
    let body = ''; for await (const chunk of request) body += chunk;
    const input = JSON.parse(body); operations.push(input); response.end(JSON.stringify({ result: { received: input.operation } }));
  });
  http.listen(0, '127.0.0.1'); await once(http, 'listening'); const remotePort = http.address().port;
  const server = new ssh2.Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('error', () => {}); client.once('close', () => clients.delete(client));
    client.on('authentication', context => {
      authentication.push(context.method);
      if (context.username === 'worker' && context.method === 'password' && context.password === sshInput.password) context.accept();
      else if (context.username === 'worker' && context.method === 'publickey' && context.key.data.equals(parsedLoginKey.getPublicSSH()) &&
        (!context.signature || parsedLoginKey.verify(context.blob, context.signature, context.hashAlgo))) context.accept();
      else context.reject();
    });
    client.on('session', (_accept, reject) => { sessions++; reject(); });
    client.on('ready', () => client.on('tcpip', (accept, reject, input) => {
      forwards.push(input); if (input.destIP !== '127.0.0.1' || input.destPort !== remotePort) { reject(); return; }
      const socket = connect(remotePort, '127.0.0.1'); peers.add(socket); socket.on('error', () => {}); socket.once('close', () => peers.delete(socket));
      socket.once('connect', () => { const channel = accept(); channel.on('error', () => socket.destroy()); channel.once('close', () => socket.destroy()); socket.pipe(channel).pipe(socket); });
    }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { for (const client of clients) client.end(); for (const peer of peers) peer.destroy(); http.closeAllConnections(); await Promise.all([new Promise(r => http.close(r)), new Promise(r => server.close(r))]); });
  return { ssh: { ...sshInput, host: '127.0.0.1', port: server.address().port, remotePort, fingerprint }, loginKey, authentication, forwards, operations, sessions: () => sessions, clients };
}

test('real SSH handshake rejects untrusted/changed keys before authentication; password and encrypted key forward only Agent HTTP', async t => {
  const f = await fixture(t);
  const open = ssh => connectSshRemoteClient({ ssh, token: agentInput.token }, '127.0.0.1');
  await assert.rejects(open({ ...f.ssh, fingerprint: '' }), e => e instanceof RemoteSshTrustRequired && e.fingerprint === f.ssh.fingerprint);
  await assert.rejects(open({ ...f.ssh, fingerprint: sshInput.fingerprint }), /指纹已改变/);
  assert.deepEqual(f.authentication, []);
  await assert.rejects(open({ ...f.ssh, password: 'wrong-password' }), e => e.status === 502 && !e.message.includes('wrong-password'));
  for (const auth of [{ authentication: 'password' }, { authentication: 'key', privateKey: f.loginKey.toString(), passphrase: 'key-passphrase', password: undefined }]) {
    const client = await open({ ...f.ssh, ...auth }); t.after(() => client.close());
    assert.equal((await client.info()).id, info.id);
    assert.deepEqual(await client.call('chat.jobs', { sessionId: 'parent' }), { received: 'chat.jobs' });
    const frames = []; for await (const frame of client.events({ sessionId: 's', turnId: 't', afterSequence: 7 }, new AbortController().signal, 'ndjson')) frames.push(frame);
    assert.equal(frames[1].event.sequence, 8); assert.equal(frames.at(-1).type, 'end');
    client.close(); client.close();
  }
  assert.equal(f.sessions(), 0); assert.ok(f.forwards.length >= 2);
  assert.ok(f.forwards.every(item => item.destIP === '127.0.0.1' && item.destPort === f.ssh.remotePort));
});

test('SSH recovery reopens on the next operation without replaying uncertain submissions', async () => {
  let opened = 0, mutations = 0;
  const client = await reconnectingSshRemoteClient(async () => {
    opened++; let closed = false;
    return { isClosed: () => closed, close() { closed = true; }, info: async () => info,
      async call(operation) { if (operation === 'delegation.submit') { mutations++; closed = true; throw new Error('lost acknowledgement'); } return []; },
      async *events(input) { yield { type: 'event', event: { sequence: input.afterSequence + 1 } }; },
    };
  });
  await assert.rejects(client.call('delegation.submit', {}), /SSH disconnected/);
  assert.equal(mutations, 1); assert.equal(opened, 1);
  await Promise.all([client.call('chat.jobs', {}), client.info()]); assert.equal(opened, 2);
  const frames = []; for await (const frame of client.events({ afterSequence: 12 }, new AbortController().signal)) frames.push(frame);
  assert.equal(frames[0].event.sequence, 13); assert.equal(mutations, 1);
  client.close(); await assert.rejects(client.info(), /closed/); assert.equal(opened, 2);
});

test('built-in slicing skill is discoverable while local execution and unrelated skills remain denied', async () => {
  const registry = new ToolRegistry(); registerSkillTools(registry, [resolve('assets/skills')]);
  const request = { protocol: 'bush.model_request.v1', requestId: 'req', sessionId: 's', turnId: 't', model: 'fixture', messages: [], tools: registry.definitions(), permissionMode: 'task_free', metadata: { toolExecutionPolicy: 'web_restricted', allowedSkills: ['auto-video-slicing'], webReadRoots: [resolve('assets/skills/auto-video-slicing')] } };
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: () => assert.fail('No permission needed') } });
  const result = await coordinator.execute({ protocol: 'bush.tool_call.v1', id: 'search', name: 'search_skills', argumentsText: JSON.stringify({ query: 'auto-video-slicing' }) }, { requestId: 'req', sessionId: 's', turnId: 't', round: 1, ordinal: 0 }, undefined, { request });
  assert.equal(result.kind, 'returned'); assert.equal(result.result.matches.length, 1);
  assert.equal(result.result.matches[0].name, 'auto-video-slicing');
  assert.equal(await webToolDenial(request, 'read_file', { path: result.result.matches[0].mainResource }), undefined);
  assert.ok(await webToolDenial(request, 'exec_command', { cmd: 'ssh host' }));
  assert.ok(await webToolDenial(request, 'subagent', { prompt: 'cut', mode: 'fork' }));
  const content = await readFile(result.result.matches[0].mainResource, 'utf8');
  for (const field of ['login_mobile', 'anchor_name', 'factory_style_code', 'product_id', 'qianchuan_account_id']) assert.ok(content.includes(field));
  assert.ok(content.includes('补齐前不委派')); assert.ok(content.includes('task_id'));
});
