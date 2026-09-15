import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/client';
import { ToolRegistry } from '@cardbush/bush-runtime';
import { McpClientManager } from '../dist/index.js';

const fixture = fileURLToPath(new URL('./fixtures/managedServer.mjs', import.meta.url));
const snapshot = (servers, revision = 1) => ({ protocol: 'bush.mcp_snapshot.v2', snapshotId: 'managed', revision, servers });
const native = { skip: process.platform !== 'win32', timeout: 20_000 };
async function setup(t, options = {}, env = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'cardbush-mcp-lifecycle-'));
  const receipts = join(dir, 'starts.jsonl'), clients = [];
  const manager = new McpClientManager({ registry: new ToolRegistry(), createClient: () => {
    const client = new Client({ name: 'managed-test', version: '1' }); clients.push(client); return client;
  }, ...options });
  t.after(async () => { await manager.close(); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  const server = { id: 'fixture', startupTimeoutMs: 5000, restartBackoffMs: 1,
    transport: { kind: 'stdio', command: process.execPath, args: [fixture], env: { FIXTURE_RECEIPTS: receipts, ...env } } };
  const records = async () => (await readFile(receipts, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(JSON.parse);
  return { manager, clients, server, records, receipts };
}
async function until(check, message, timeout = 8000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  assert.ok(await check(), message);
}
async function gone(pid) {
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, `owned process ${pid} should exit`);
}
const ready = result => assert.equal(result.servers[0].health, 'ready', JSON.stringify(result));

test('MCP protocol round trips and disconnect reaps a detached child service', { timeout: 20_000 }, async t => {
  const f = await setup(t);
  ready(await f.manager.apply(snapshot([f.server])));
  const value = '中文😀 "quotes"\n' + 'x'.repeat(180_000);
  const response = await f.clients[0].callTool({ name: 'echo', arguments: { value } });
  assert.equal(JSON.parse(response.content[0].text).value, value, 'stdio framing survives chunks and Unicode');
  const [record] = await f.records();
  await f.manager.apply(snapshot([], 2));
  await gone(record.pid); await gone(record.childPid);
});

test('Windows .cmd launchers retain paths with spaces and plugin environment values', native, async t => {
  const f = await setup(t);
  const launcher = join(f.receipts, '..', 'service launcher.cmd');
  await writeFile(launcher, `@echo off\r\n"${process.execPath}" "${fixture}"\r\n`);
  const configured = { ...f.server, transport: { ...f.server.transport, command: launcher, args: [] } };
  ready(await f.manager.apply(snapshot([configured])));
  assert.ok((await f.clients[0].callTool({ name: 'echo', arguments: { value: '中文' } })).content.length);
  const [record] = await f.records(); await f.manager.close();
  await gone(record.pid); await gone(record.childPid);
});

test('refresh waits for idle and releases the old fixed-port service before replacement', { timeout: 25_000 }, async t => {
  let idle = true;
  const f = await setup(t, { canApply: () => idle });
  ready(await f.manager.apply(snapshot([f.server])));
  const [old] = await f.records();
  const changed = { ...f.server, transport: { ...f.server.transport, env: { ...f.server.transport.env, FIXTURE_PORT: String(old.port) } } };
  idle = false;
  const pending = await f.manager.refresh('fixture', snapshot([changed], 2));
  assert.equal(pending.applicationPhase, 'waiting_for_idle');
  await delay(100); assert.equal((await f.records()).length, 1);
  assert.ok((await f.clients[0].callTool({ name: 'echo', arguments: {} })).content.length);
  idle = true;
  ready(await f.manager.apply(snapshot([changed], 2)));
  const records = await f.records(); assert.equal(records.length, 2);
  assert.equal(records[1].port, old.port);
  await gone(old.pid); await gone(old.childPid);
});

test('a server ignoring EOF is force-closed, including its service, before close resolves', { timeout: 20_000 }, async t => {
  const f = await setup(t, {}, { FIXTURE_IGNORE_EOF: '1' });
  ready(await f.manager.apply(snapshot([f.server])));
  const [old] = await f.records(), start = performance.now();
  await Promise.all([f.manager.close(), f.manager.close()]);
  assert.ok(performance.now() - start < 5000, 'bounded graceful shutdown');
  await gone(old.pid); await gone(old.childPid);
});

test('cancelling startup releases descendants and prevents a superseded late startup', { timeout: 25_000 }, async t => {
  const f = await setup(t, {}, { FIXTURE_NO_HANDSHAKE: '1' });
  f.manager.submit(snapshot([f.server]));
  await until(async () => (await f.records()).length === 1, 'fixture has spawned its service');
  const [old] = await f.records();
  const changed = { ...f.server, transport: { ...f.server.transport, env: { ...f.server.transport.env,
    FIXTURE_NO_HANDSHAKE: '0', FIXTURE_PORT: String(old.port) } } };
  f.manager.submit(snapshot([changed], 2));
  f.manager.submit(snapshot([changed], 2));
  ready(await f.manager.apply(snapshot([changed], 2)));
  assert.equal((await f.records()).length, 2);
  await gone(old.pid); await gone(old.childPid);
});

test('rapid successful handshakes followed by crashes have a bounded restart budget', { timeout: 25_000 }, async t => {
  const f = await setup(t, { maxRestartAttempts: 2 }, { FIXTURE_CRASH_MS: '300' });
  ready(await f.manager.apply(snapshot([f.server])));
  await until(() => /stopped after 2 restart attempts/.test(f.manager.snapshot()?.servers[0].lastError ?? ''), 'recovery must stop');
  const records = await f.records(); assert.equal(records.length, 3);
  await delay(400); assert.equal((await f.records()).length, 3);
  for (const item of records) { await gone(item.pid); await gone(item.childPid); }
});

test('closing one Agent scope preserves sibling services; owner close releases remaining scopes', { timeout: 25_000 }, async t => {
  const f = await setup(t);
  const first = f.manager.fork(new ToolRegistry()), second = f.manager.fork(new ToolRegistry());
  ready(await first.apply(snapshot([f.server]))); ready(await second.apply(snapshot([f.server])));
  const [a, b] = await f.records();
  await first.close(); await gone(a.pid); await gone(a.childPid);
  assert.ok((await f.clients[1].callTool({ name: 'echo', arguments: {} })).content.length);
  await f.manager.close(); await gone(b.pid); await gone(b.childPid);
  assert.throws(() => f.manager.fork(new ToolRegistry()), /closed/);
});

test('Windows parent crash reaps owned MCP services without touching an external peer', native, async t => {
  const f = await setup(t);
  const external = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, stdio: 'ignore' });
  const owner = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/managedOwner.mjs', import.meta.url))], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, FIXTURE_SNAPSHOT: JSON.stringify(snapshot([f.server])) },
  });
  let stderr = ''; owner.stderr.on('data', chunk => { stderr += chunk; });
  t.after(() => { owner.kill(); external.kill(); });
  await Promise.race([once(owner, 'message'), once(owner, 'exit').then(() => { throw Error(stderr); })]);
  const [record] = await f.records(); owner.kill();
  await gone(record.pid); await gone(record.childPid);
  assert.doesNotThrow(() => process.kill(external.pid, 0));
});
