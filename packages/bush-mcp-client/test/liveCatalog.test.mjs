import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { ToolRegistry, ToolExecutionCoordinator, registerMcpDiscovery, synchronizeMcpDiscovery, mcpToolWasDiscovered } from '@cardbush/bush-runtime';
import { synchronizeMcpCatalog } from '../../bush-runtime/dist/mcpToolDiscovery.js';
import { McpClientManager } from '../dist/index.js';

const remote = (name, properties = {}) => ({ name, description: name, inputSchema: { type: 'object', properties, additionalProperties: false } });
const snapshot = servers => ({ protocol: 'bush.mcp_snapshot.v2', snapshotId: 's', revision: 1, servers: servers.map(id => ({ id,
  transport: { kind: 'stdio', command: 'fixture' }, defaultToolPolicy: { permission: 'allow', parallelSafe: true } })) });
function fake(catalog) {
  return { calls: [], async connect() {}, async close() {}, getNegotiatedProtocolVersion: () => '2026-07-28',
    async listTools() { return { tools: catalog }; },
    async callTool(input) { this.calls.push(input); return { content: [{ type: 'text', text: 'ok' }] }; },
  };
}
async function until(check) {
  const end = Date.now() + 5000;
  while (!check()) { assert.ok(Date.now() < end, 'catalog update timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
const execute = (coordinator, name, input) => coordinator.execute({ protocol: 'bush.tool_call.v1', id: 'c', name, argumentsText: JSON.stringify(input) },
  { requestId: 'r', sessionId: 's', turnId: 't', round: 1, ordinal: 0 });

test('service recovery publishes additions, removals and fresh schemas without replay or unrelated registration churn', async t => {
  const registry = new ToolRegistry(); registerMcpDiscovery(registry);
  const first = fake([remote('old'), remote('edit', { value: { type: 'string' } })]);
  const recovered = fake([remote('upload_file', { filePaths: { type: 'array', items: { type: 'string' } } }), remote('edit', { value: { type: 'integer' } }), remote('disabled')]);
  const steady = fake([remote('steady')]), clients = [first, recovered];
  const manager = new McpClientManager({ registry, createClient: config => config.id === 'browser' ? clients.shift() : steady,
    createTransport: () => ({ async send() {} }), wait: async () => {} });
  t.after(() => manager.close());
  const config = snapshot(['browser', 'steady']); config.servers[0].disabledTools = ['disabled'];
  await manager.apply(config);
  const unchanged = registry.resolve('mcp__steady__steady');
  const request = { sessionId: 's', turnId: 't', tools: registry.definitions(), metadata: { mcpToolDiscovery: true, mcpCatalogUpdates: 'additions' } };
  const search = registry.resolve('mcp_search');
  const loaded = await search.execute({ input: search.decodeInput({ action: 'load', query: 'mcp__browser__edit' }), turn: { request, contextMessages: [] } });
  const messages = [{ role: 'assistant', content: '', toolCalls: [{ id: 'load', name: 'mcp_search', argumentsText: '{}' }] },
    { role: 'tool', toolCallId: 'load', content: JSON.stringify(loaded) }];
  synchronizeMcpDiscovery(registry, request, messages);
  assert.equal(mcpToolWasDiscovered(registry, request, 'mcp__browser__edit'), true);
  first.onclose();
  await until(() => manager.snapshot().servers.find(server => server.id === 'browser').health === 'ready');
  assert.equal(registry.resolve('mcp__browser__old'), undefined);
  assert.equal(registry.resolve('mcp__browser__disabled'), undefined);
  assert.ok(registry.resolve('mcp__browser__upload_file'));
  assert.equal(registry.resolve('mcp__steady__steady'), unchanged);
  assert.equal(mcpToolWasDiscovered(registry, request, 'mcp__browser__edit'), false, 'old schema receipts cannot authorize the changed tool');
  synchronizeMcpCatalog(registry, request);
  assert.ok(request.tools.some(tool => tool.name === 'mcp__browser__upload_file'));
  assert.equal(recovered.calls.length, 0);
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: async () => { throw Error('unexpected approval'); } } });
  assert.equal((await execute(coordinator, 'mcp__browser__edit', { value: 'old format' })).kind, 'failed');
  assert.equal(recovered.calls.length, 0);
  assert.equal((await execute(coordinator, 'mcp__browser__edit', { value: 3 })).kind, 'returned');
  assert.equal(recovered.calls.length, 1);
});

test('catalog notifications preserve policies, update schemas and ignore a retired client', async t => {
  const registry = new ToolRegistry(), callbacks = [], clients = [];
  const manager = new McpClientManager({ registry, createClient: (_config, options) => {
    callbacks.push(options.listChanged.tools.onChanged); const client = fake([remote('echo')]); clients.push(client); return client;
  }, createTransport: () => ({ async send() {} }), wait: async () => {} });
  t.after(() => manager.close());
  const config = snapshot(['browser']); config.servers[0].exposeTools = ['echo', 'upload'];
  await manager.apply(config);
  const old = registry.resolve('mcp__browser__echo');
  callbacks[0](null, [remote('echo'), remote('upload'), remote('unexposed')]);
  assert.equal(registry.resolve('mcp__browser__echo'), old);
  assert.ok(registry.resolve('mcp__browser__upload')); assert.equal(registry.resolve('mcp__browser__unexposed'), undefined);
  callbacks[0](null, [{ inputSchema: { additionalProperties: false, properties: {}, type: 'object' }, description: 'echo', name: 'echo' }, remote('upload')]);
  assert.equal(registry.resolve('mcp__browser__echo'), old, 'JSON property order alone is not a schema change');
  callbacks[0](null, [remote('echo', { value: { type: 'number' } })]);
  assert.notEqual(registry.resolve('mcp__browser__echo'), old);
  assert.equal(registry.resolve('mcp__browser__upload'), undefined);
  clients[0].onclose();
  await until(() => clients.length === 2 && manager.snapshot().servers[0].health === 'ready');
  callbacks[0](null, [remote('upload')]);
  assert.ok(registry.resolve('mcp__browser__echo')); assert.equal(registry.resolve('mcp__browser__upload'), undefined);
  await manager.close(); callbacks[1](null, [remote('upload')]);
  assert.equal(registry.resolve('mcp__browser__upload'), undefined);
});

test('the real MCP subscription refreshes the runtime catalog without reconnecting the service', async t => {
  const registry = new ToolRegistry(), server = new McpServer({ name: 'dynamic', version: '1' });
  const echo = server.registerTool('echo', { inputSchema: z.object({ value: z.string() }) }, async () => ({ content: [{ type: 'text', text: 'ok' }] }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const manager = new McpClientManager({ registry, createTransport: () => clientTransport });
  t.after(async () => { await manager.close(); await server.close(); });
  await manager.apply(snapshot(['browser']));
  const previous = registry.resolve('mcp__browser__echo');
  server.registerTool('upload_file', { inputSchema: z.object({ filePaths: z.array(z.string()) }) }, async () => ({ content: [] }));
  await until(() => !!registry.resolve('mcp__browser__upload_file'));
  assert.equal(registry.resolve('mcp__browser__echo'), previous);
  echo.disable();
  await until(() => !registry.resolve('mcp__browser__echo'));
  assert.ok(registry.resolve('mcp__browser__upload_file'));
});

test('adding a service preserves an unrelated tool that is awaiting approval', async t => {
  const registry = new ToolRegistry(), first = fake([remote('echo')]), second = fake([remote('new')]);
  const manager = new McpClientManager({ registry, createClient: config => config.id === 'first' ? first : second,
    createTransport: () => ({ async send() {} }) });
  t.after(() => manager.close());
  const config = snapshot(['first']); config.servers[0].defaultToolPolicy.permission = 'ask';
  await manager.apply(config);
  const entered = Promise.withResolvers(), answer = Promise.withResolvers();
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: async input => { entered.resolve(input); return answer.promise; } } });
  const pending = execute(coordinator, 'mcp__first__echo', {});
  const permission = await entered.promise;
  await manager.apply({ ...config, revision: 2, servers: [...config.servers, snapshot(['second']).servers[0]] });
  answer.resolve({ decision: 'allow', scope: 'once', grantedCapabilityIds: permission.capabilityIds });
  assert.equal((await pending).kind, 'returned');
  assert.equal(first.calls.length, 1); assert.equal(second.calls.length, 0);
});

test('notifications received before catalog publication survive the idle boundary', async t => {
  const registry = new ToolRegistry(); let idle = false, changed;
  const manager = new McpClientManager({ registry, canApply: () => idle, createClient: (_config, options) => {
    changed = options.listChanged.tools.onChanged; return fake([remote('echo')]);
  }, createTransport: () => ({ async send() {} }) });
  t.after(() => manager.close());
  const config = snapshot(['browser']); config.servers[0].required = true;
  manager.submit(config);
  await until(() => manager.snapshot().servers[0]?.updateState === 'waiting_for_catalog');
  changed(null, [remote('echo'), remote('upload_file')]);
  idle = true;
  await until(() => !!registry.resolve('mcp__browser__upload_file'));
  assert.ok(registry.resolve('mcp__browser__echo'));
});
