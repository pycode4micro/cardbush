import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ToolRegistry, ToolExecutionCoordinator } from '@cardbush/bush-runtime';
import { McpClientManager } from '../dist/index.js';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
const config = (id, version = 1) => ({ id, transport: { kind: 'streamable_http', url: `https://fixture.invalid/${id}/${version}`, auth: 'none' },
  defaultToolPolicy: { permission: 'allow', parallelSafe: true } });
const snapshot = (servers, revision = 1) => ({ protocol: 'bush.mcp_snapshot.v2', snapshotId: 'hot', revision, servers });
const context = { requestId: 'r', sessionId: 's', turnId: 't', toolCall: { id: 'c', name: 'echo' }, input: {}, capabilityIds: [] };
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < deadline, 'hot update timed out'); await delay(5); }
}
function fixture(t, operation, options = {}) {
  const registry = new ToolRegistry(), clients = [];
  const manager = new McpClientManager({ registry, createTransport: () => ({ async send() {}, async close() {} }),
    createClient: server => {
      const client = { server, calls: [], closed: 0, async connect() {}, async close() { this.closed++; },
        getNegotiatedProtocolVersion: () => '2026-07-28', getServerVersion: () => ({ name: 'fixture' }),
        async listTools() { return { tools: [{ name: 'echo', description: server.transport.url,
          inputSchema: { type: 'object', properties: {}, additionalProperties: false }, _meta: { ui: { resourceUri: 'ui://fixture' } } }] }; },
        async callTool(input) { this.calls.push(input); return operation?.(client, 'tool') ?? server.transport.url; },
        async readResource() { return operation?.(client, 'resource') ?? { contents: [] }; },
      };
      clients.push(client); return client;
    }, ...options });
  t.after(() => manager.close());
  return { registry, manager, clients };
}

test('hot replacement publishes new tools while old calls finish exactly once on their original connection', async t => {
  const gate = deferred();
  const { registry, manager, clients } = fixture(t, client => client.server.transport.url.endsWith('/changed/1') ? gate.promise : undefined);
  t.after(() => gate.resolve('old result'));
  await manager.apply(snapshot([config('changed'), config('steady')]));
  const old = registry.resolve('mcp__changed__echo'), steady = registry.resolve('mcp__steady__echo');
  const running = old.execute(context);
  manager.submit(snapshot([config('changed', 2), config('steady')], 2));
  await until(() => manager.snapshot().applicationState === 'applied');
  assert.equal(clients[0].closed, 0, 'publication must not interrupt a dispatched call');
  assert.equal(registry.resolve('mcp__steady__echo'), steady);
  assert.equal(await registry.resolve('mcp__changed__echo').execute(context), 'https://fixture.invalid/changed/2');
  assert.equal(await steady.execute(context), 'https://fixture.invalid/steady/1');
  await assert.rejects(old.execute(context), error => error.code === 'tool_definition_changed' && error.details.inputDispatched === false);
  gate.resolve('old result'); assert.equal(await running, 'old result');
  await until(() => clients[0].closed > 0);
  assert.equal(clients[0].calls.length, 1); assert.equal(clients[2].calls.length, 1, 'no replay on the new generation');
});

test('trusted hooks and app resource reads also keep their connection alive until both settle', async t => {
  const tool = deferred(), resource = deferred();
  const { registry, manager, clients } = fixture(t, (_client, kind) => kind === 'tool' ? tool.promise : resource.promise);
  t.after(() => { tool.resolve({}); resource.resolve({}); });
  await manager.apply(snapshot([config('app')]));
  const registration = registry.resolve('mcp__app__echo');
  const hook = registration.mcpHook.call({}, { timeoutMs: 5000, request: { requestId: 'r', sessionId: 's', turnId: 't', metadata: {} } });
  const read = registration.mcpApp.readResource('ui://fixture');
  const removal = manager.apply(snapshot([], 2)); let completed = false; void removal.then(() => { completed = true; });
  await until(() => !registry.resolve('mcp__app__echo'));
  assert.equal(clients[0].closed, 0); assert.equal(completed, false);
  assert.equal(registration.mcpApp.connectionIdentity, undefined);
  resource.resolve({ contents: [] }); await read;
  assert.equal(clients[0].closed, 0);
  tool.resolve({ content: [] }); await hook; await removal;
  assert.ok(clients[0].closed > 0);
});

test('shutdown closes a draining connection without waiting for an uncooperative call', async t => {
  const gate = deferred(); const { registry, manager, clients } = fixture(t, () => gate.promise);
  await manager.apply(snapshot([config('slow')]));
  const call = registry.resolve('mcp__slow__echo').execute(context);
  manager.submit(snapshot([], 2));
  await until(() => !registry.resolve('mcp__slow__echo'));
  await manager.close(); assert.ok(clients[0].closed > 0);
  gate.resolve('finished'); await call;
});

test('replacement invalidates an old pending permission without dispatch or replay', async t => {
  const permission = deferred(); const { registry, manager, clients } = fixture(t);
  const server = config('ask'); server.defaultToolPolicy.permission = 'ask';
  await manager.apply(snapshot([server]));
  let waiting = false;
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: () => { waiting = true; return permission.promise; } } });
  const call = coordinator.execute({ protocol: 'bush.tool_call.v1', id: 'c', name: 'mcp__ask__echo', argumentsText: '{}' },
    { requestId: 'r', sessionId: 's', turnId: 't', round: 1, ordinal: 0 });
  await until(() => waiting);
  await manager.apply(snapshot([{ ...server, transport: config('ask', 2).transport }], 2));
  permission.resolve({ decision: 'allow_once', grantedCapabilityIds: [] });
  const result = await call;
  assert.equal(result.kind, 'failed'); assert.equal(result.error.code, 'tool_definition_changed');
  assert.equal(result.error.details.inputDispatched, false);
  assert.ok(clients.every(client => client.calls.length === 0));
});

test('hot updates dismiss obsolete sign-in waits without replaying an authentication rejection', async t => {
  const prompted = deferred(); let logins = 0;
  const { registry, manager, clients } = fixture(t, client => {
    if (client.server.transport.url.endsWith('/1')) throw Object.assign(new Error('Sign-in required'), { code: 'mcp_auth_required' });
  }, { oauth: { async login() { logins++; }, close() {} },
    onAuthenticationRequired: async (_request, signal) => {
      prompted.resolve();
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } });
  await manager.apply(snapshot([config('auth')]));
  const waiting = registry.resolve('mcp__auth__echo').execute(context);
  const rejected = assert.rejects(waiting, /configuration changed during sign-in/);
  await prompted.promise;
  await manager.apply(snapshot([config('auth', 2)], 2));
  await rejected;
  assert.equal(logins, 0); assert.equal(clients[0].calls.length, 1); assert.equal(clients[1].calls.length, 0);
  assert.equal(await registry.resolve('mcp__auth__echo').execute(context), 'https://fixture.invalid/auth/2');
});

test('physical package replacement waits only for isolated scopes that pin that plugin', async t => {
  const { manager } = fixture(t);
  const own = manager.fork(new ToolRegistry()), peer = manager.fork(new ToolRegistry());
  await own.apply(snapshot([{ ...config('private'), pluginId: 'changed' }]));
  await peer.apply(snapshot([{ ...config('peer'), pluginId: 'other' }]));
  let ready = false;
  const waiting = manager.waitForPluginScopes('changed').then(() => { ready = true; });
  await delay(10); assert.equal(ready, false);
  await own.close(); await waiting;
  assert.equal(ready, true); assert.equal(peer.snapshot().applicationState, 'applied');
});
