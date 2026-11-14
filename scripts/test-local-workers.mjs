import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { openLocalWorkers } from '../dist-electron/localWorkerStore.mjs';
import { AgentConnectionManager } from '../dist-electron/agentConnections.mjs';
import { AgentService } from '../dist-electron/agentService.mjs';
import { ProcessResourceGovernor, defaultProcessResourceLimits, spawnResourceManagedProcess } from '../packages/bush-runtime/dist/processResourceGuard.js';

const run = promisify(execFile), root = resolve(import.meta.dirname, '..');
const cipher = { encrypt: text => Buffer.from(text).toString('base64'), decrypt: text => Buffer.from(text, 'base64').toString() };
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cardbush-local-workers-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.match(directory, /cardbush-local-workers-/);
    await rm(directory, { recursive: true, force: true });
  });
  const token = 'isolated-worker-token-not-for-production'; let instance = 'worker-instance';
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end(); return; }
    res.setHeader('X-CardBush-Agent-ID', instance);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ protocol: 'cardbush.agent.v1', apiVersion: 1, eventStreams: ['sse', 'ndjson'],
      id: instance, name: 'Fixture worker', platform: 'linux', capabilities: { durableQueue: true,
        workerInteraction: { profile: 'subagent-remote-proton', version: '0.1', operations: ['observe', 'queue', 'insert', 'respond', 'cancel'] } } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { directory, token, url: `http://127.0.0.1:${server.address().port}/`, profile: join(directory, 'profile'), legacyRoot: join(directory, 'cli'),
    changeIdentity() { instance = 'changed-instance'; } };
}

test('App and CLI discard retired caches, share newly authorized workers and do not resurrect removals', async t => {
  const f = await fixture(t);
  await mkdir(join(f.legacyRoot, 'workers'), { recursive: true });
  await writeFile(join(f.legacyRoot, 'workers', 'credentials.key'), Buffer.alloc(32, 5));
  await writeFile(join(f.legacyRoot, 'workers', 'connections.json'), '[]');
  const desktop = new AgentConnectionManager(join(f.profile, 'agents', 'connections.json'), cipher);
  const [desktopOld] = await desktop.save({ name: 'App worker', transport: 'http', url: f.url, token: f.token });
  await desktop.close();
  const app = await openLocalWorkers(f.profile, { legacyRoot: f.legacyRoot });
  const cli = await openLocalWorkers(f.profile, { legacyRoot: f.legacyRoot });
  t.after(() => Promise.all([app.close(), cli.close()]));
  assert.deepEqual(await cli.list(), []);
  for (const file of [join(f.legacyRoot, 'workers', 'credentials.key'), join(f.legacyRoot, 'workers', 'connections.json'), join(f.profile, 'agents', 'connections.json')]) await assert.rejects(lstat(file), { code: 'ENOENT' });
  await assert.rejects(cli.connect(desktopOld.id), /Unknown Agent connection/);
  const [old] = await app.save({ name: 'New worker', transport: 'http', url: f.url, token: f.token });
  const verified = await Promise.all([cli.connect(old.id), app.connect(old.id)]);
  assert.ok(verified.every(info => info.id === 'worker-instance'));
  assert.equal((await app.list()).find(x => x.id === old.id).agentId, 'worker-instance');
  const stored = await readFile(join(f.profile, 'workers', 'connections.json'), 'utf8');
  assert.ok(!stored.includes(f.token)); assert.ok(!JSON.stringify(await cli.list()).includes(f.token));
  await cli.remove(old.id);
  await assert.rejects(app.connect(old.id), /Unknown Agent connection/);
  const reopened = await openLocalWorkers(f.profile, { legacyRoot: f.legacyRoot });
  assert.ok(!(await reopened.list()).some(x => x.id === old.id)); await reopened.close();
  const separate = await openLocalWorkers(join(f.directory, 'other-profile'), { legacyRoot: join(f.directory, 'other-cli') });
  assert.deepEqual(await separate.list(), []); await separate.close();
  const [fresh] = await app.save({ name: 'Identity check', transport: 'http', url: f.url, token: f.token });
  await app.connect(fresh.id); await app.disconnect(fresh.id); f.changeIdentity();
  await assert.rejects(app.connect(fresh.id), /identity changed/i);
});

test('simultaneous independent processes preserve every saved connection', async t => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 5 }, (_, i) => run(process.execPath, ['--input-type=module', '-e',
    `import {openLocalWorkers} from './dist-electron/localWorkerStore.mjs';
     const w=await openLocalWorkers(process.env.TEST_PROFILE,{legacyRoot:process.env.TEST_LEGACY});
     try{await w.save({name:'Worker ${i}',transport:'http',url:process.env.TEST_URL,token:'fixture-token'})}finally{await w.close()}`],
  { cwd: root, windowsHide: true, env: { ...process.env, TEST_PROFILE: f.profile, TEST_LEGACY: f.legacyRoot, TEST_URL: f.url }, timeout: 30_000 })));
  const store = await openLocalWorkers(f.profile, { legacyRoot: f.legacyRoot });
  assert.equal((await store.list()).length, 5); await store.close();
});

test('CLI Runtime discovers the App registry and validates remote roles through its host bridge', async t => {
  const f = await fixture(t), app = await openLocalWorkers(f.profile, { legacyRoot: f.legacyRoot });
  const [connection] = await app.save({ name: 'Shared worker', transport: 'http', url: f.url, token: f.token });
  await app.connect(connection.id);
  const service = await AgentService.open({ dataRoot: f.legacyRoot, local: true, localProfileRoot: f.profile });
  try {
    assert.equal((await service.call('workers.command', { action: 'list' }))[0].id, connection.id);
    const tools = await service.call('runtime.command', { kind: 'runtime.get_tool_catalog', payload: {} });
    assert.ok(tools.some(tool => tool.name === 'worker_connection'));
    for (const action of ['verify', 'reconnect']) {
      const receipt = await service.call('runtime.command', { kind: 'runtime.realtime_agent_tool', payload: {
        sessionId: 'connection-parent', callId: `fixture-${action}`, action: 'worker_connection',
        nativeArguments: { action, connection_id: connection.id },
        parent: { protocol: 'bush.session_turn_request.v1', requestId: 'fixture', sessionId: 'connection-parent', turnId: 'fixture-turn', model: 'fixture',
          prefixMessages: [], inputMessages: [{ messageId: 'fixture-user', message: { role: 'user', content: 'Verify the saved worker' } }],
          tools, permissionMode: 'all_free', metadata: {} },
      } });
      assert.equal(receipt.connectionState, 'connected'); assert.ok(receipt.lastCheckedAt);
      assert.equal(receipt.agentId, 'worker-instance'); assert.equal(receipt.url, undefined);
      assert.doesNotMatch(JSON.stringify(receipt), /isolated-worker-token/);
    }
    const saved = await service.call('runtime.command', { kind: 'runtime.agent_registry', payload: { action: 'save', expected_revision: 0,
      definition: { id: 'shared-role', name: 'Shared role', system_prompt: 'Read-only verification', remote: { connection_id: connection.id, agent_id: 'worker-instance' } } } });
    assert.equal(saved.definition.remote.connection_id, connection.id);
    await service.call('workers.command', { action: 'remove', id: connection.id });
    assert.deepEqual(await app.list(), []);
    await assert.rejects(app.connect(connection.id), /Unknown Agent connection/);
  } finally { await service.close(); await app.close(); }
});

test('worker CLI verifies a real HTTP service without starting the Agent Runtime, within a narrow memory budget', async t => {
  const f = await fixture(t), w = await openLocalWorkers(f.profile, { legacyRoot: f.legacyRoot });
  const [item] = await w.save({ name: 'CLI smoke', transport: 'http', url: f.url, token: f.token }); await w.close();
  const env = { ...process.env, CARDBUSH_CLI_PROFILE_DIR: f.profile, CARDBUSH_CLI_DATA_DIR: f.legacyRoot };
  const args = ['bin/cardbush.mjs', 'worker', 'verify', item.id];
  if (process.platform === 'win32') {
    const MiB = 1024 ** 2;
    const limits = { ...defaultProcessResourceLimits(), taskMemoryBytes: 384 * MiB, totalMemoryBytes: 768 * MiB, startupMemoryBytes: 32 * MiB };
    const p = await spawnResourceManagedProcess({ executable: process.execPath, args, cwd: root, env,
      governor: new ProcessResourceGovernor({ limits, availableMemory: () => 2 * 1024 ** 3 }) });
    let text = ''; p.child.stdout.on('data', x => text += x); p.child.stderr.on('data', x => text += x);
    const timeout = setTimeout(() => p.stop(), 25_000);
    const [code] = await once(p.child, 'exit'); const report = await p.complete(); clearTimeout(timeout);
    assert.equal(code, 0, JSON.stringify({ text, report })); assert.equal(report.code, '');
    assert.ok(report.peakMemoryBytes < limits.taskMemoryBytes); assert.match(text, /Verified Fixture worker/);
  } else {
    const { stdout } = await run(process.execPath, args, { cwd: root, env }); assert.match(stdout, /Verified Fixture worker/);
  }
  assert.equal(await lstat(join(f.legacyRoot, 'local-runtime', 'host.json')).then(() => true, () => false), false);
});

test('redirected worker directories cannot redirect the private credential store', async t => {
  const f = await fixture(t), elsewhere = join(f.directory, 'elsewhere');
  await mkdir(f.profile); await mkdir(elsewhere);
  await symlink(elsewhere, join(f.profile, 'workers'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(openLocalWorkers(f.profile, { legacyRoot: f.legacyRoot }), /belong to this profile/);
  if (process.platform !== 'win32') {
    const isolated = await openLocalWorkers(join(f.directory, 'private'), { legacyRoot: f.legacyRoot }); await isolated.close();
    assert.equal((await lstat(join(f.directory, 'private', 'workers'))).mode & 0o777, 0o700);
  }
});
