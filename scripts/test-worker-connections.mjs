import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { AgentConnectionManager } from '../dist-electron/agentConnections.mjs';
import { AgentHttpClient, AgentHttpError } from '../dist-electron/agentHttpClient.mjs';
import { callRemoteWorker } from '../dist-electron/remoteWorkers.mjs';
import { ToolRegistry, ToolExecutionCoordinator } from '../packages/bush-runtime/dist/index.js';
import { registerWorkerConnectionTool } from '../packages/bush-runtime/dist/workerConnectionTool.js';

const cipher = { encrypt: value => Buffer.from(value).toString('base64'), decrypt: value => Buffer.from(value, 'base64').toString() };
async function until(check) { for (let i = 0; i < 200; i++) { if (await check()) return; await pause(10); } assert.fail('Connection state did not settle'); }
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'cardbush-worker-state-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.match(directory, /cardbush-worker-state-/);
    await rm(directory, { recursive: true, force: true });
  });
  const token = 'isolated-secret-token'; let requests = 0, identity = 'worker-instance', reject = false, hold = false;
  const responses = [];
  const server = createServer((req, res) => {
    requests++;
    const respond = () => {
      if (res.destroyed) return;
      res.setHeader('content-type', 'application/json');
      if (reject || req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401).end(JSON.stringify({ error: { message: `Server echoed sensitive input ${token}` } })); return;
      }
      res.setHeader('x-cardbush-agent-id', identity);
      res.end(JSON.stringify({ protocol: 'cardbush.agent.v1', apiVersion: 1, eventStreams: ['sse', 'ndjson'],
        id: identity, name: 'Fixture', platform: 'test', capabilities: { durableQueue: true } }));
    };
    if (hold) responses.push(respond); else respond();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const path = join(directory, 'workers.json');
  const manager = new AgentConnectionManager(path, cipher, { healthIntervalMs: 60_000, ...options });
  t.after(() => manager.close());
  const [saved] = await manager.save({ name: 'Fixture', transport: 'http', url: `http://127.0.0.1:${server.address().port}/`, token });
  return { manager, saved, path, token, count: () => requests, state: async () => (await manager.list())[0],
    reject: value => { reject = value; }, identity: value => { identity = value; }, hold: value => { hold = value; if (!value) responses.splice(0).forEach(fn => fn()); } };
}

test('unverified is not disconnected, fresh verification probes HTTP and only safe receipts reach the model', async t => {
  const f = await fixture(t), registry = new ToolRegistry();
  registerWorkerConnectionTool(registry);
  assert.equal(registry.resolve('worker_connection'), undefined, 'a host without management does not advertise the tool');
  registerWorkerConnectionTool(registry, { connection: (input, signal) => callRemoteWorker(f.manager, `agents.${input.action}`, { connectionId: input.connectionId }, signal) });
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: async () => assert.fail('No extra permission') } });
  const invoke = async (action, extra = {}, metadata = {}) => coordinator.execute({ protocol: 'bush.tool_call.v1', id: crypto.randomUUID(), name: 'worker_connection',
    argumentsText: JSON.stringify({ action, connection_id: f.saved.id, ...extra }) }, { requestId: 'r', sessionId: 's', turnId: 't', round: 1, ordinal: 0 }, undefined,
    { request: { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture',
      messages: [], tools: registry.definitions(), permissionMode: 'all_free', metadata }, contextMessages: [] });
  assert.equal((await f.state()).connectionState, 'unverified'); assert.equal(f.count(), 0);
  const first = await invoke('verify');
  assert.equal(first.kind, 'returned', JSON.stringify(first)); assert.equal(first.result.connectionState, 'connected');
  assert.ok(first.result.lastCheckedAt); assert.equal(first.result.lastCheckedAt, first.result.verifiedAt);
  const before = f.count(); f.reject(true);
  const failed = await invoke('verify');
  assert.equal(f.count(), before + 1);
  assert.equal(failed.result.connectionState, 'failed');
  assert.equal(failed.result.connectionErrorCode, 'authentication_failed');
  assert.equal(failed.result.connected, false);
  assert.equal(failed.result.verifiedAt, first.result.verifiedAt);
  assert.doesNotMatch(JSON.stringify(failed.result), /isolated-secret|Server echoed|127\.0\.0\.1|token|url/i);
  f.reject(false);
  assert.equal((await invoke('reconnect')).result.connectionState, 'connected');
  assert.equal((await invoke('verify', { token: 'untrusted-override' })).kind, 'failed');
  await assert.rejects(callRemoteWorker(f.manager, 'agents.verify', { connectionId: 'missing' }), /Unknown/);
  assert.equal((await callRemoteWorker(f.manager, 'agents.list', {}))[0].connectionState, 'connected');
  assert.equal((await invoke('verify', {}, { agentRole: 'child' })).kind, 'returned');
  const checked = f.count();
  assert.equal((await invoke('reconnect', {}, { agentRole: 'child', registeredAgentReadOnly: true })).error.code, 'registered_agent_read_only');
  assert.equal(f.count(), checked, 'read-only child policy is enforced before host dispatch');
});

test('concurrent verification shares a live probe; disconnect supersedes its late response', async t => {
  const f = await fixture(t); await f.manager.verify(f.saved.id);
  f.hold(true); const before = f.count();
  const probes = Promise.allSettled([f.manager.verify(f.saved.id), f.manager.verify(f.saved.id)]);
  await until(() => f.count() === before + 1);
  assert.equal((await f.state()).connectionState, 'verifying');
  await f.manager.disconnect(f.saved.id); f.hold(false);
  assert.ok((await probes).every(result => result.status === 'rejected'));
  assert.equal((await f.state()).connectionState, 'disconnected');
  assert.equal((await f.state()).connected, false);
  assert.equal(f.count(), before + 1);
});

test('HTTP health checks invalidate stale success and manual reconnect reuses the pinned identity', async t => {
  const f = await fixture(t, { healthIntervalMs: 20 }); await f.manager.connect(f.saved.id);
  f.reject(true);
  await until(async () => (await f.state()).connectionState === 'failed');
  assert.equal((await f.state()).connectionErrorCode, 'authentication_failed');
  const before = f.count(); await pause(65); assert.equal(f.count(), before, 'auth failures are not retried in a loop');
  f.reject(false); f.identity('another-instance');
  const changed = await callRemoteWorker(f.manager, 'agents.reconnect', { connectionId: f.saved.id });
  assert.equal(changed.connectionState, 'failed'); assert.equal(changed.connectionErrorCode, 'identity_changed');
  assert.equal(changed.agentId, 'worker-instance');
  f.identity('worker-instance');
  assert.equal((await callRemoteWorker(f.manager, 'agents.reconnect', { connectionId: f.saved.id })).connectionState, 'connected');
});

test('a concurrent disconnect cancels reconnect and registration removal cannot be resurrected', async t => {
  const f = await fixture(t); await f.manager.connect(f.saved.id);
  const before = f.count();
  const reconnect = f.manager.reconnect(f.saved.id);
  assert.equal(f.manager.reconnect(f.saved.id), reconnect, 'one host operation owns reconnect');
  const settled = Promise.allSettled([reconnect]);
  await f.manager.disconnect(f.saved.id);
  assert.equal((await settled)[0].status, 'rejected');
  assert.equal((await f.state()).connectionState, 'disconnected'); assert.equal(f.count(), before);
  f.hold(true);
  const pending = Promise.allSettled([f.manager.verify(f.saved.id)]);
  await until(() => f.count() === before + 1);
  await f.manager.remove(f.saved.id); f.hold(false);
  assert.equal((await pending)[0].status, 'rejected'); assert.deepEqual(await f.manager.list(), []);
});

test('App and CLI share authority while keeping honest host-local verification state', async t => {
  const f = await fixture(t), other = new AgentConnectionManager(f.path, cipher);
  t.after(() => other.close());
  await other.verify(f.saved.id);
  assert.equal((await f.state()).connectionState, 'unverified');
  assert.equal((await f.state()).agentId, 'worker-instance');
  await f.manager.verify(f.saved.id);
  assert.equal((await f.state()).connectionState, 'connected');
});

test('a superseded failed probe cannot leak its raw server body or overwrite disconnected state', async t => {
  const f = await fixture(t); await f.manager.verify(f.saved.id);
  const probe = Promise.withResolvers();
  t.mock.method(AgentHttpClient.prototype, 'info', () => probe.promise);
  const pending = Promise.allSettled([f.manager.verify(f.saved.id)]);
  await until(async () => (await f.state()).connectionState === 'verifying');
  await f.manager.disconnect(f.saved.id);
  probe.reject(new AgentHttpError(`private server body ${f.token}`, 401));
  const [result] = await pending;
  assert.equal(result.status, 'rejected');
  assert.doesNotMatch(result.reason.message, /private server body|isolated-secret/);
  assert.equal((await f.state()).connectionState, 'disconnected');
  assert.equal((await f.state()).connectionErrorCode, undefined);
});
