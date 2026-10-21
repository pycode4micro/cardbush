import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { connect } from 'node:net';
import { AgentConnectionManager } from '../dist-electron/agentConnections.mjs';
import { AgentBusyError, agentBusyMessage } from '../dist-electron/agentErrors.mjs';
import { AgentHttpClient, AgentHttpError, isAgentBusyError } from '../dist-electron/agentHttpClient.mjs';
import { AgentSharedConfiguration, packSharedConfiguration } from '../dist-electron/agentSharedConfiguration.mjs';
import { serveAgentHttp } from '../dist-electron/agentServer.mjs';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await pause(10); }
  assert.fail('Timed out waiting for offline sync fixture.');
}

// Real HTTP transport and archive transaction; jobs are controlled fixtures, with no model provider.
async function fixture(t, options = {}) {
  const base = resolve('tmp/agent-configuration-deferral');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, 'test-')), local = join(root, 'local'), remote = join(root, 'remote');
  await Promise.all([mkdir(local), mkdir(remote)]);
  const state = { jobs: [], calls: [], packs: [], refreshes: 0, reads: 0, legacy: false, failPack: false };
  const payload = { roots: [], models: { models: [] }, apps: { serviceEnabled: true, plugins: [] },
    mcp: { servers: [] }, subagents: {}, instructions: 'Original configuration.' };
  const receiver = new AgentSharedConfiguration(remote, join(root, 'bundled'), () => {
    if (state.jobs.some(job => ['queued', 'running'].includes(job.status))) {
      throw state.legacy ? new Error(agentBusyMessage) : new AgentBusyError();
    }
  }, async () => { state.refreshes++; return { applicationState: 'applied' }; });
  const info = { protocol: 'cardbush.agent.v1', apiVersion: 1, id: 'fixture-agent', name: 'Offline Agent',
    platform: process.platform, eventStreams: ['sse', 'ndjson'],
    capabilities: { durableQueue: true, sharedConfiguration: true, sharedConfigurationVersion: 2 } };
  const service = {
    info: () => info,
    async call(operation, input) {
      state.calls.push({ operation, input });
      if (operation === 'chat.jobs') {
        state.reads++; await state.beforeJobs?.();
        return state.jobs.filter(job => !input.sessionId || job.sessionId === input.sessionId);
      }
      if (operation === 'configuration.sync') { await state.beforeSync?.(input); return receiver.call(input); }
      if (operation === 'conversation.catalog') return { skills: [] };
      if (operation === 'product.command' && input.kind === 'models.get') return { models: [] };
      if (operation === 'chat.send' || operation === 'delegation.submit') {
        const id = input.requestId ?? input.taskId;
        const previous = state.jobs.find(job => job.id === id); if (previous) return previous;
        const job = { id, sessionId: input.sessionId, status: 'queued' }; state.jobs.push(job); return job;
      }
      throw new Error('Unexpected operation: ' + operation);
    },
    async *eventStream() {},
  };
  const token = 'offline-fixture-'.repeat(4), server = await serveAgentHttp(service, { token, port: 0 });
  state.connections = 0;
  const ssh = { async list() { return [{ id: 'offline-tunnel' }]; }, async tunnel() {
    state.connections++;
    let finish; const closed = new Promise(resolve => { finish = resolve; }), peers = new Set();
    state.dropTransport = () => { for (const peer of peers) peer.destroy(); };
    return { closed, async close() { finish(); for (const peer of peers) peer.destroy(); },
      connect(_options, callback) {
        const peer = connect(server.port, '127.0.0.1'); peers.add(peer);
        const failed = error => callback(error, null); peer.once('error', failed);
        peer.once('close', () => peers.delete(peer));
        peer.once('connect', () => { peer.removeListener('error', failed); callback(null, peer); });
      },
    };
  } };
  const manager = new AgentConnectionManager(join(local, 'connections.json'), { encrypt: v => v, decrypt: v => v }, {
    ...(options.tunnel ? { ssh, reconnectDelayMs: 20, healthIntervalMs: 60_000 } : {}),
    configurationRetryMs: options.retryMs ?? 20,
    sharedConfiguration: async settings => {
      state.packs.push(settings); await state.beforePack?.();
      if (state.failPack) throw new Error('fixture configuration invalid');
      return packSharedConfiguration(payload, local, settings);
    },
  });
  t.after(async () => {
    await manager.close(); await server.close();
    assert.ok(root.startsWith(base + sep)); await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  const [connection] = await manager.save({ name: info.name, transport: 'http', url: 'http://127.0.0.1:' + server.port, token,
    ...(options.tunnel ? { sshTunnel: { connectionId: 'offline-tunnel', remoteHost: '127.0.0.1', remotePort: server.port } } : {}),
    autoSyncPlugins: options.autoSyncPlugins ?? false, excludedPluginIds: ['excluded'], syncSkills: false });
  return { state, payload, manager, connection, token, remote,
    read: () => manager.call(connection.id, 'conversation.catalog'),
    error: async () => (await manager.list())[0]?.configurationError,
    rules: () => readFile(join(remote, 'AGENTS.md'), 'utf8'),
  };
}

test('automatic sync waits for all running and queued jobs, coalesces reads and applies the latest settings without another UI request', async t => {
  const f = await fixture(t, { autoSyncPlugins: true }), { state, manager, connection } = f;
  state.jobs = [{ id: 'running', sessionId: 'one', status: 'running' }, { id: 'queued', sessionId: 'two', status: 'queued' }];
  await Promise.all([f.read(), f.read(), manager.call(connection.id, 'product.command', { kind: 'models.get' })]);
  await until(() => state.reads >= 3);
  assert.equal(state.packs.length, 0); assert.equal(await f.error(), undefined);
  assert.equal(state.calls.filter(call => call.operation === 'configuration.sync').length, 0);
  state.jobs[0].status = 'completed';
  const reads = state.reads; await until(() => state.reads >= reads + 2);
  assert.equal(state.packs.length, 0, 'another session still has a queued task');
  f.payload.instructions = 'Latest configuration, changed while waiting.';
  state.jobs[1].status = 'stopped';
  await until(() => state.refreshes === 1);
  assert.equal(await f.rules(), f.payload.instructions);
  assert.deepEqual(state.packs, [{ syncPlugins: true, excludedPluginIds: ['excluded'], syncSkills: false }]);
  assert.equal(await f.error(), undefined);
  await pause(70); assert.equal(state.packs.length, 1, 'successful sync removes the deferred retry');
  assert.ok(state.calls.every(call => call.operation !== 'chat.stop'), 'sync never interrupts a task');
});

test('busy automatic sync does not reject queued messages, guidance or delegated work and acknowledged retries stay idempotent', async t => {
  const f = await fixture(t), { state, manager, connection } = f;
  state.jobs = [{ id: 'active', sessionId: 'one', status: 'running' }];
  await f.read();
  const send = { sessionId: 'one', requestId: 'queued-message', text: 'Follow-up', modelId: 'fixture' };
  assert.equal((await manager.call(connection.id, 'chat.send', send)).status, 'queued');
  await manager.call(connection.id, 'chat.send', send);
  await manager.call(connection.id, 'delegation.submit', { sessionId: 'two', taskId: 'child' });
  assert.equal(state.jobs.length, 3); assert.equal(state.jobs[0].status, 'running');
  assert.equal(await f.error(), undefined); assert.equal(state.packs.length, 0);
  state.jobs.forEach(job => { job.status = 'completed'; });
  await until(() => state.refreshes === 1);
});

for (const phase of ['begin', 'apply']) for (const legacy of [false, true]) {
  test(`a task starting at configuration ${phase} retains old files and retries after completion (${legacy ? 'legacy' : 'coded'} busy response)`, async t => {
    const f = await fixture(t), { state, manager, connection } = f;
    await manager.syncConfiguration(connection.id);
    const original = await f.rules(); f.payload.instructions = 'Replacement'; state.legacy = legacy;
    state.beforeSync = async input => {
      if (input.action === phase) {
        state.beforeSync = undefined;
        state.jobs = [{ id: 'raced', sessionId: 'race', status: 'running' }];
      }
    };
    await f.read();
    assert.equal(await f.rules(), original); assert.equal(state.refreshes, 1);
    assert.equal(await f.error(), undefined);
    const packs = state.packs.length; await Promise.all([f.read(), f.read()]);
    assert.equal(state.packs.length, packs, 'busy catalog reads reuse one deferred request');
    f.payload.instructions = 'Newer replacement'; state.jobs[0].status = 'completed';
    await until(() => state.refreshes === 2);
    assert.equal(await f.rules(), 'Newer replacement'); assert.equal(await f.error(), undefined);
  });
}

test('genuine retry failures remain visible, back off and block new tasks; manual sync can recover', async t => {
  const f = await fixture(t), { state, manager, connection } = f;
  state.jobs = [{ status: 'running' }]; await f.read(); state.failPack = true; state.jobs = [];
  await until(async () => (await f.error())?.includes('fixture configuration invalid'));
  await pause(60); assert.equal(state.packs.length, 1);
  await assert.rejects(manager.call(connection.id, 'chat.send', { requestId: 'new', sessionId: 'one' }), /fixture configuration invalid/);
  assert.ok(state.calls.every(call => call.operation !== 'chat.send'));
  state.failPack = false; await manager.syncConfiguration(connection.id);
  assert.equal(await f.error(), undefined); assert.equal(state.packs.at(-1).syncPlugins, true);
});

for (const action of ['disconnect', 'remove', 'close']) {
  test(`${action} cancels a deferred sync even while its job check is in flight`, async t => {
    const f = await fixture(t), { state, manager, connection } = f;
    state.jobs = [{ status: 'running' }]; await f.read();
    let release, entered = false;
    const gate = new Promise(resolve => { release = resolve; });
    state.beforeJobs = async () => { entered = true; await gate; };
    try {
      await until(() => entered);
      await manager[action](connection.id); state.jobs = []; release();
      await pause(70);
      assert.equal(state.packs.length, 0); assert.equal(await f.error(), undefined);
      const reads = state.reads; await pause(60); assert.equal(state.reads, reads);
    } finally { release(); }
  });
}

test('disconnect during packaging prevents uploads and stale error publication', async t => {
  const f = await fixture(t), { state, manager, connection } = f;
  let release; const gate = new Promise(resolve => { release = resolve; }); state.beforePack = () => gate;
  const read = f.read().catch(() => undefined);
  try {
    await until(() => state.packs.length === 1);
    await manager.disconnect(connection.id); release(); await read;
    assert.equal(state.calls.filter(call => call.operation === 'configuration.sync').length, 0);
    assert.equal(await f.error(), undefined);
  } finally { release(); await read; }
});

test('manual success supersedes the pending automatic sync and keeps manual plugin selection', async t => {
  const f = await fixture(t, { retryMs: 100 }), { state, manager, connection } = f;
  state.jobs = [{ status: 'running' }]; await f.read(); state.jobs = [];
  await manager.syncConfiguration(connection.id);
  await pause(150);
  assert.equal(state.packs.length, 1); assert.equal(state.packs[0].syncPlugins, true);
  assert.equal(await f.error(), undefined);
});

test('a finished event stream wakes the deferred retry without waiting for the poll interval', async t => {
  const f = await fixture(t, { retryMs: 60_000 }), { state, manager, connection } = f;
  state.jobs = [{ status: 'running' }]; await f.read(); state.jobs = [];
  const frames = [];
  for await (const frame of manager.events(connection.id, { sessionId: 'one', turnId: 'turn-one' }, new AbortController().signal)) frames.push(frame);
  assert.ok(frames.some(frame => frame.type === 'end'));
  await until(() => state.refreshes === 1);
});

test('busy codes survive HTTP, manual sync retains task protection, and unrelated conflicts are not deferred', async t => {
  const f = await fixture(t), { state, manager, connection } = f;
  const client = new AgentHttpClient(connection.url, f.token); t.after(() => client.close());
  state.jobs = [{ status: 'running' }];
  await assert.rejects(client.call('configuration.sync', { action: 'begin', digest: 'a'.repeat(64), size: 1 }),
    error => error instanceof AgentHttpError && error.status === 409 && error.code === 'agent_busy' && isAgentBusyError(error));
  await assert.rejects(manager.syncConfiguration(connection.id), isAgentBusyError);
  assert.equal(state.refreshes, 0);
  assert.equal(isAgentBusyError(new AgentHttpError('Agent identity changed.', 409, 'agent_identity_changed')), false);
  assert.equal(isAgentBusyError(new Error(agentBusyMessage)), false, 'local packaging errors do not masquerade as remote busy');
});

for (const phase of ['job-check', 'upload']) {
  test(`a transient tunnel loss during ${phase} resumes the deferred sync after reconnection`, async t => {
    const f = await fixture(t, { tunnel: true }), { state } = f;
    state.jobs = [{ status: 'running' }]; await f.read();
    if (phase === 'job-check') state.beforeJobs = async () => { state.beforeJobs = undefined; state.dropTransport(); };
    else {
      state.beforeSync = async input => {
        if (input.action === 'begin') { state.beforeSync = undefined; state.dropTransport(); }
      };
      state.jobs = [];
    }
    await until(() => state.connections === 2);
    state.jobs = [];
    await until(() => state.refreshes === 1);
    assert.equal(await f.rules(), f.payload.instructions); assert.equal(await f.error(), undefined);
    assert.ok(state.calls.every(call => call.operation !== 'chat.stop'));
  });
}
