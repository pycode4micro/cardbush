import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ToolRegistry } from '@cardbush/bush-runtime';
import { BUSH_MCP_SNAPSHOT_PROTOCOL, mcpSnapshotResultSchema } from '@cardbush/bush-protocol';
import { McpClientManager } from '../dist/index.js';

const server = (id, extra = {}) => ({ id, transport: { kind: 'stdio', command: 'fixture', args: [], env: {} }, ...extra });
const snapshot = (servers, revision = 1) => ({ protocol: BUSH_MCP_SNAPSHOT_PROTOCOL, snapshotId: 'scheduling', revision, servers });
function client(connect = async () => {}) {
  return { closeCalls: 0, connect, async callTool() { return { content: [] }; }, async close() { this.closeCalls++; },
    async listTools() { return { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] }; },
    getNegotiatedProtocolVersion() { return '2025-11-25'; } };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('cancelling async network setup cannot start a late child or block manager shutdown', async () => {
  const gate = deferred(); let began = false, clients = 0, signal;
  const manager = new McpClientManager({ registry: new ToolRegistry(),
    network: async (_server, abort) => { began = true; signal = abort; await gate.promise; return { fetch, env: {} }; },
    createClient: () => { clients++; return client(); } });
  manager.submit(snapshot([server('late')])); await until(() => began);
  await manager.close(); assert.equal(signal.aborted, true); gate.resolve(); await delay(10);
  assert.equal(clients, 0); assert.equal(manager.snapshot(), undefined);
});

test('effective proxy changes reconnect only that service and preserve an unchanged tool catalog', async t => {
  const attempts = {}, registry = new ToolRegistry();
  const manager = new McpClientManager({ registry, createTransport: () => ({ async send() {} }),
    createClient: s => client(async () => { attempts[s.id] = (attempts[s.id] ?? 0) + 1; }) });
  t.after(() => manager.close());
  const none = { mode: 'none', httpProxy: '', httpsProxy: '', noProxy: '' }, system = { ...none, mode: 'system' };
  const before = [server('changed', { pluginId: 'first', networkProxy: none }), server('preserved', { pluginId: 'second', networkProxy: none })];
  await manager.apply(snapshot(before)); const definitions = registry.definitions();
  await manager.apply(snapshot([{ ...before[0], networkProxy: system }, before[1]], 2));
  assert.deepEqual(attempts, { changed: 2, preserved: 1 });
  assert.deepEqual(registry.definitions(), definitions, 'network routes never enter model-visible tool definitions');
});
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(2); }
  assert.ok(predicate(), 'expected connection progress');
}

test('independent transports start concurrently with a bound and publish in configuration order', async t => {
  const gates = Array.from({ length: 5 }, deferred), started = [], registry = new ToolRegistry();
  let active = 0, peak = 0;
  const manager = new McpClientManager({ registry, maxConcurrentConnections: 2,
    createTransport: () => ({ async send() {} }), createClient: s => client(async () => {
      const index = Number(s.id.slice(1)); started.push(index); active++; peak = Math.max(peak, active);
      await gates[index].promise; active--;
    }) });
  const update = manager.apply(snapshot(gates.map((_, i) => server(`s${i}`))));
  t.after(async () => { gates.forEach(gate => gate.resolve()); await update; await manager.close(); });
  await until(() => started.length === 2);
  assert.deepEqual(started, [0, 1]);
  assert.equal(registry.definitions().length, 0, 'partial discovery is not a committed tool catalog');
  gates[1].resolve(); await until(() => started.includes(2));
  gates[2].resolve(); await until(() => started.includes(3));
  gates[3].resolve(); await until(() => started.includes(4));
  gates[4].resolve(); gates[0].resolve();
  assert.deepEqual((await update).servers.map(s => s.id), ['s0', 's1', 's2', 's3', 's4']);
  assert.equal(peak, 2);
  assert.equal(registry.definitions().length, 5);
});

test('reconnecting one server does not retry unrelated unavailable or authentication-required servers', async t => {
  const registry = new ToolRegistry(), attempts = {}, servers = [server('local'), server('offline'), server('sign_in')];
  const manager = new McpClientManager({ registry, createTransport: () => ({ async send() {} }), createClient: s => client(async () => {
    attempts[s.id] = (attempts[s.id] || 0) + 1;
    if (s.id === 'offline') throw Error('Unavailable fixture');
    if (s.id === 'sign_in') throw Object.assign(Error('Sign-in fixture'), { code: 'mcp_auth_required' });
  }) });
  t.after(() => manager.close());
  await manager.apply(snapshot(servers));
  await manager.refresh('local', snapshot(servers, 2));
  assert.deepEqual(attempts, { local: 2, offline: 1, sign_in: 1 });
  await manager.refresh('offline', snapshot(servers, 3));
  assert.deepEqual(attempts, { local: 2, offline: 2, sign_in: 1 });
  await manager.apply(snapshot(servers.map(s => s.id === 'offline' ? { ...s, transport: { ...s.transport, command: 'changed' } } : s), 4));
  assert.equal(attempts.offline, 3, 'a changed transport retries with the new configuration');
});

test('pending connection scope identifies affected services without hiding healthy or signed-out peers', async t => {
  const gate = deferred(), registry = new ToolRegistry(), servers = [server('local'), server('other')];
  let hold = false;
  const manager = new McpClientManager({ registry, createTransport: () => ({ async send() {} }), createClient: s => client(() => hold && s.id === 'other' ? gate.promise : Promise.resolve()) });
  t.after(async () => { gate.resolve(); await manager.close(); });
  await manager.apply(snapshot(servers)); hold = true;
  const update = manager.refresh('other', snapshot(servers, 2));
  await until(() => manager.snapshot().applicationPhase === 'connecting');
  assert.deepEqual(manager.snapshot().pendingServerIds, ['other']);
  assert.deepEqual(mcpSnapshotResultSchema.parse(JSON.parse(JSON.stringify(manager.snapshot()))).pendingServerIds, ['other']);
  assert.ok(registry.resolve('mcp__local__echo'));
  gate.resolve(); assert.equal((await update).pendingServerIds, undefined);
});

test('failed required additions settle parallel work and preserve the previous catalog', async t => {
  const gate = deferred(), began = deferred(), clients = {}, registry = new ToolRegistry();
  const manager = new McpClientManager({ registry, maxConcurrentConnections: 2, createTransport: () => ({ async send() {} }),
    createClient: s => clients[s.id] = client(async () => {
      if (s.id === 'slow') { began.resolve(); await gate.promise; }
      if (s.id === 'bad') { await began.promise; throw Error('Required fixture failed'); }
    }) });
  t.after(async () => { gate.resolve(); await manager.close(); });
  await manager.apply(snapshot([server('old')]));
  const update = manager.apply(snapshot([server('old'), server('bad', { required: true }), server('slow'), server('never')], 2));
  const rejected = assert.rejects(update, /Required fixture failed/);
  await began.promise; await delay(5); gate.resolve(); await rejected;
  assert.equal(clients.never, undefined, 'queued connections stop after a required failure');
  assert.equal(clients.slow.closeCalls, 1, 'late successful connection is retired');
  assert.equal(clients.old.closeCalls, 0);
  assert.deepEqual(registry.definitions().map(tool => tool.name), ['mcp__old__echo']);
});

test('queued reconnect requests are not consumed by the previous apply', async t => {
  const gate = deferred(), started = deferred(), attempts = {};
  let hold = false;
  const manager = new McpClientManager({ registry: new ToolRegistry(), createTransport: () => ({ async send() {} }), createClient: s => client(async () => {
    attempts[s.id] = (attempts[s.id] || 0) + 1;
    if (hold && s.id === 'first') { started.resolve(); await gate.promise; }
  }) });
  t.after(async () => { gate.resolve(); await manager.close(); });
  const servers = [server('second'), server('first')];
  await manager.apply(snapshot(servers)); hold = true;
  const first = manager.refresh('first', snapshot(servers, 2)); await started.promise;
  const second = manager.refresh('second', snapshot(servers, 3));
  gate.resolve(); await first; await second;
  assert.deepEqual(attempts, { first: 2, second: 2 });
});

test('explicit reconnect still works with the same unchanged snapshot revision', async t => {
  let attempts = 0;
  const manager = new McpClientManager({ registry: new ToolRegistry(), createTransport: () => ({ async send() {} }), createClient: () => client(async () => { attempts++; }) });
  t.after(() => manager.close());
  const current = snapshot([server('local')]);
  await manager.apply(current); await manager.apply(current); assert.equal(attempts, 1);
  await manager.refresh('local', current); assert.equal(attempts, 2);
});

test('a busy same-revision reconnect stays pending until the turn is idle', async t => {
  let attempts = 0, idle = true;
  const manager = new McpClientManager({ registry: new ToolRegistry(), canApply: () => idle,
    createTransport: () => ({ async send() {} }), createClient: () => client(async () => { attempts++; }) });
  t.after(() => manager.close());
  const current = snapshot([server('local')]); await manager.apply(current);
  idle = false; await manager.refresh('local', current);
  await until(() => attempts === 2);
  assert.deepEqual(manager.snapshot().pendingServerIds, ['local']); assert.equal(attempts, 2, 'transport connects in the background while publication waits');
  idle = true; await manager.apply(current);
  assert.equal(attempts, 2); assert.equal(manager.snapshot().applicationState, 'applied');
});

test('completed discoveries are retained if a turn starts before catalog commit', async t => {
  const gates = [deferred(), deferred()], registry = new ToolRegistry(), clients = [];
  let idle = true;
  const manager = new McpClientManager({ registry, canApply: () => idle, createTransport: () => ({ async send() {} }),
    createClient: () => { const i = clients.length, c = client(() => gates[i].promise); clients.push(c); return c; } });
  t.after(async () => { gates.forEach(gate => gate.resolve()); await manager.close(); });
  const update = manager.apply(snapshot([server('first'), server('second')]));
  await until(() => clients.length === 2); idle = false; gates.forEach(gate => gate.resolve());
  assert.equal((await update).applicationPhase, 'waiting_for_idle');
  assert.equal(registry.definitions().length, 0); assert.deepEqual(clients.map(c => c.closeCalls), [0, 0]);
  idle = true; await manager.apply(snapshot([server('first'), server('second')]));
  assert.equal(clients.length, 2, 'publication reuses completed transports');
  assert.equal(registry.definitions().length, 2);
});

test('background submission returns before connection and publishes each optional service independently', async t => {
  const gate = deferred(), registry = new ToolRegistry();
  const manager = new McpClientManager({ registry, createTransport: () => ({ async send() {} }),
    createClient: s => client(() => s.id === 'slow' ? gate.promise : Promise.resolve()) });
  t.after(async () => { gate.resolve(); await manager.close(); });
  const accepted = manager.submit(snapshot([server('slow'), server('fast')]));
  assert.equal(accepted.applicationState, 'pending');
  assert.deepEqual(accepted.servers.map(s => s.updateState), ['queued', 'queued']);
  assert.equal(registry.definitions().length, 0);
  await until(() => !!registry.resolve('mcp__fast__echo'));
  assert.equal(registry.resolve('mcp__slow__echo'), undefined);
  const current = mcpSnapshotResultSchema.parse(manager.snapshot());
  assert.equal(current.servers.find(s => s.id === 'slow').updateState, 'connecting');
  assert.equal(current.servers.find(s => s.id === 'fast').updateState, undefined);
  assert.deepEqual(current.pendingServerIds, ['slow']);
  gate.resolve(); await manager.apply(snapshot([server('slow'), server('fast')]));
  assert.equal(registry.definitions().length, 2);
});

test('new submissions proceed while an unchanged server is still connecting', async t => {
  const gate = deferred(), registry = new ToolRegistry(), attempts = {};
  const manager = new McpClientManager({ registry, createTransport: () => ({ async send() {} }), createClient: s => client(async () => {
    attempts[s.id] = (attempts[s.id] || 0) + 1;
    if (s.id === 'slow') await gate.promise;
  }) });
  t.after(async () => { gate.resolve(); await manager.close(); });
  manager.submit(snapshot([server('slow')]));
  await until(() => attempts.slow === 1);
  manager.submit(snapshot([server('slow'), server('new')], 2));
  await until(() => !!registry.resolve('mcp__new__echo'));
  assert.deepEqual(attempts, { slow: 1, new: 1 });
  gate.resolve(); await manager.apply(snapshot([server('slow'), server('new')], 2));
});

test('superseded connections release capacity and cannot overwrite a newer configuration', async t => {
  const gate = deferred(), registry = new ToolRegistry(), clients = [];
  const manager = new McpClientManager({ registry, maxConcurrentConnections: 1, createTransport: () => ({ async send() {} }), createClient: s => {
    const c = client(() => s.transport.command === 'old' ? gate.promise : Promise.resolve());
    c.listTools = async () => ({ tools: [{ name: s.transport.command, inputSchema: { type: 'object' } }] });
    clients.push(c); return c;
  } });
  t.after(async () => { gate.resolve(); await manager.close(); });
  const config = command => server('local', { transport: { kind: 'stdio', command, args: [], env: {} } });
  manager.submit(snapshot([config('old')])); await until(() => clients.length === 1);
  manager.submit(snapshot([config('new')], 2));
  await until(() => !!registry.resolve('mcp__local__new'));
  assert.ok(clients[0].closeCalls >= 1, 'a superseded startup is closed without waiting for its result');
  gate.resolve(); await delay(5);
  assert.equal(registry.resolve('mcp__local__old'), undefined);
  assert.equal(manager.snapshot().revision, 2);
});

test('cancelling a background replacement keeps the active turn catalog until publication is allowed', async t => {
  const gate = deferred(), registry = new ToolRegistry(), clients = [];
  let idle = true;
  const manager = new McpClientManager({ registry, canApply: () => idle, createTransport: () => ({ async send() {} }), createClient: () => {
    const c = client(() => clients.length > 1 ? gate.promise : Promise.resolve()); clients.push(c); return c;
  } });
  t.after(async () => { gate.resolve(); await manager.close(); });
  await manager.apply(snapshot([server('local')])); idle = false;
  manager.submit(snapshot([server('local')], 2), ['local']); await until(() => clients.length === 2);
  manager.submit(snapshot([], 3)); await until(() => clients[1].closeCalls > 0);
  assert.ok(registry.resolve('mcp__local__echo'), 'an active turn retains its original tool registration');
  idle = true; await manager.apply(snapshot([], 3)); gate.resolve(); await delay(5);
  assert.equal(registry.definitions().length, 0);
  assert.equal(manager.snapshot().revision, 3);
});

test('background connection failures remain observable without rejecting unrelated submissions', async t => {
  const registry = new ToolRegistry();
  const manager = new McpClientManager({ registry, createTransport: () => ({ async send() {} }), createClient: s => client(async () => {
    if (s.id === 'bad') throw Error('fixture handshake failed');
  }) });
  t.after(() => manager.close());
  manager.submit(snapshot([server('bad'), server('good')]));
  await until(() => manager.snapshot().applicationState === 'applied');
  assert.ok(registry.resolve('mcp__good__echo'));
  const failed = manager.snapshot().servers.find(s => s.id === 'bad');
  assert.equal(failed.health, 'unavailable'); assert.match(failed.lastError, /fixture handshake failed/);
});

test('transport construction failures are local to one service and are not retried by unrelated updates', async t => {
  let attempts = 0;
  const registry = new ToolRegistry();
  const manager = new McpClientManager({ registry, createClient: () => client(), createTransport: s => {
    if (s.id === 'bad') { attempts++; throw Error('fixture transport configuration failed'); }
    return { async send() {} };
  } });
  t.after(() => manager.close());
  await manager.apply(snapshot([server('bad'), server('good')]));
  assert.ok(registry.resolve('mcp__good__echo'));
  assert.match(manager.snapshot().servers.find(s => s.id === 'bad').lastError, /transport configuration failed/);
  await manager.refresh('good', snapshot([server('bad'), server('good')], 2));
  assert.equal(attempts, 1);
  await manager.refresh('bad', snapshot([server('bad'), server('good')], 3));
  assert.equal(attempts, 2);
});

test('shutdown stops queued launches and retires every already-started transport', async t => {
  const gates = [deferred(), deferred()], registry = new ToolRegistry(), clients = [];
  const manager = new McpClientManager({ registry, maxConcurrentConnections: 2, createTransport: () => ({ async send() {} }),
    createClient: () => { const i = clients.length, c = client(() => gates[i]?.promise); clients.push(c); return c; } });
  t.after(async () => { gates.forEach(gate => gate.resolve()); await manager.close(); });
  const update = manager.apply(snapshot([server('first'), server('second'), server('queued')]));
  await until(() => clients.length === 2); const closed = manager.close();
  gates.forEach(gate => gate.resolve()); await update; await closed;
  assert.equal(clients.length, 2); assert.deepEqual(clients.map(c => c.closeCalls), [1, 1]);
  assert.equal(registry.definitions().length, 0); assert.equal(manager.snapshot(), undefined);
});
