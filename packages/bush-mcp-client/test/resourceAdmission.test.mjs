import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { ToolRegistry } from '@cardbush/bush-runtime';
import { configureProcessResourceClient, defaultProcessResourceLimits, ProcessResourceGovernor } from '@cardbush/bush-runtime/processes';
import { McpClientManager } from '../dist/index.js';

const MiB = 1024 ** 2;
const snapshot = (servers, revision = 1) => ({ protocol: 'bush.mcp_snapshot.v2', snapshotId: 'resource-test', revision, servers });
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'cardbush-mcp-resource-'));
  let available = 4 * 1024 ** 3;
  const limits = { ...defaultProcessResourceLimits(8 * 1024 ** 3), maxConcurrentServices: 1, taskMemoryBytes: 256 * MiB, totalMemoryBytes: 512 * MiB };
  const governor = new ProcessResourceGovernor({ limits, availableMemory: () => available });
  configureProcessResourceClient({ acquire: async (lifetime, _signal, replace) => governor.acquire(lifetime, replace) });
  const clients = [];
  const manager = new McpClientManager({ registry: new ToolRegistry(), createClient: () => {
    const client = new Client({ name: 'resource-test', version: '1' }); clients.push(client); return client;
  } });
  const receipts = join(dir, 'starts.jsonl');
  const server = { id: 'fixture', required: true, startupTimeoutMs: 750, restartBackoffMs: 1,
    transport: { kind: 'stdio', command: process.execPath, args: [fileURLToPath(new URL('./fixtures/managedServer.mjs', import.meta.url))], env: { FIXTURE_RECEIPTS: receipts } } };
  const records = async () => (await readFile(receipts, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  t.after(async () => {
    await manager.close(); configureProcessResourceClient();
    assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.match(dir, /cardbush-mcp-resource-/);
    await rm(dir, { recursive: true, force: true, maxRetries: 5 });
  });
  return { manager, clients, server, records, setMemory: value => { available = value; } };
}
async function until(check) {
  const deadline = Date.now() + 8_000;
  while (!await check() && Date.now() < deadline) await delay(20);
  assert.ok(await check());
}

test('memory wait preserves the old connection and recovers once outside handshake timeout', { timeout: 20_000 }, async t => {
  const f = await setup(t);
  assert.equal((await f.manager.apply(snapshot([f.server]))).servers[0].health, 'ready');
  const [old] = await f.records();
  f.setMemory(64 * MiB);
  const next = { ...f.server, transport: { ...f.server.transport, env: { ...f.server.transport.env, FIXTURE_PORT: String(old.port) } } };
  const pending = await f.manager.apply(snapshot([next], 2));
  assert.equal(pending.applicationPhase, 'waiting_for_resources');
  assert.equal(pending.servers[0].updateState, 'waiting_for_resources');
  assert.equal(pending.servers[0].health, 'ready');
  assert.equal(pending.servers[0].lastError, undefined);
  await delay(1_100); // Longer than handshake timeout, but no handshake has started.
  assert.equal((await f.records()).length, 1);
  const result = await f.clients[0].callTool({ name: 'echo', arguments: { value: 'old connection still usable' } });
  assert.match(result.content[0].text, /old connection still usable/);
  f.setMemory(4 * 1024 ** 3);
  await until(() => f.manager.snapshot()?.applicationState === 'applied');
  assert.equal(f.manager.snapshot().servers[0].health, 'ready');
  assert.equal((await f.records()).length, 2);
});

test('cancelling a queued required service does not start it when memory returns', { timeout: 15_000 }, async t => {
  const f = await setup(t); f.setMemory(64 * MiB);
  const pending = await f.manager.apply(snapshot([f.server]));
  assert.equal(pending.applicationState, 'pending');
  assert.equal(pending.applicationError, undefined);
  assert.equal((await f.records()).length, 0);
  await f.manager.apply(snapshot([], 2));
  f.setMemory(4 * 1024 ** 3); await delay(2_200);
  assert.equal((await f.records()).length, 0);
  assert.deepEqual(f.manager.snapshot().servers, []);
});

test('a resource error after connection begins remains a real failure, not an endless admission retry', async () => {
  const manager = new McpClientManager({ registry: new ToolRegistry(), createClient: () => {
    const client = new Client({ name: 'failed-startup', version: '1' });
    client.connect = async () => { throw Object.assign(new Error('Process stopped after startup began.'), { code: 'resource_memory_pressure' }); };
    return client;
  }, createTransport: () => ({ async start() {}, async close() {}, async send() {} }) });
  try {
    await assert.rejects(manager.apply(snapshot([{ id: 'failed', required: true, transport: { kind: 'stdio', command: process.execPath } }])), /after startup began/);
    assert.equal(manager.snapshot().applicationState, 'failed');
    assert.notEqual(manager.snapshot().servers[0].updateState, 'waiting_for_resources');
  } finally { await manager.close(); }
});
