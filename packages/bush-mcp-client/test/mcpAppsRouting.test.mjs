import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { McpAppsHost, ToolRegistry, ToolExecutionStore } from '@cardbush/bush-runtime';
import { McpClientManager } from '../dist/index.js';

for (const [format, meta] of [
  ['MCP Apps', { ui: { resourceUri: 'ui://fixture', visibility: ['app'] } }],
  ['legacy widget', { 'openai/outputTemplate': 'ui://fixture', 'openai/widgetAccessible': true }],
]) test(`${format} short names route through the MCP client using the service's original name`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-mcp-routing-'));
  const calls = [], reads = [];
  const native = { content: [{ type: 'text', text: '{"job":"fixture-job"}' }], structuredContent: null, isError: false, _meta: { widgetData: true }, extension: 'native' };
  const transport = {
    async start() {}, async close() {}, async send(message) {
      if (!('id' in message)) return;
      let response;
      if (message.method === 'server/discover') response = { error: { code: -32601, message: 'Legacy fixture' } };
      else if (message.method === 'initialize') response = { result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: 'Fixture', version: '1' } } };
      else if (message.method === 'tools/list') response = { result: { tools: [{ name: 'studio.prepare', inputSchema: { type: 'object' }, outputSchema: { type: 'object', required: ['job'] }, _meta: meta }] } };
      else if (message.method === 'resources/read') { const { uri } = message.params; reads.push(uri); response = { result: { contents: [{ uri, mimeType: 'text/html', text: '<h1>Fixture</h1>' }] } }; }
      else if (message.method === 'tools/call') { calls.push(message.params); response = { result: native }; }
      else throw Error('Unexpected method: ' + message.method);
      queueMicrotask(() => transport.onmessage?.({ jsonrpc: '2.0', id: message.id, ...response }));
    },
  };
  const registry = new ToolRegistry(), executions = new ToolExecutionStore();
  const manager = new McpClientManager({ registry, createTransport: () => transport });
  const host = new McpAppsHost(root, registry, executions);
  t.after(async () => {
    await host.close(); await manager.close();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-mcp-routing-'));
    await rm(root, { recursive: true, force: true });
  });
  const state = await manager.apply({ protocol: 'bush.mcp_snapshot.v2', snapshotId: 'fixture', revision: 1, servers: [{
    id: 'fixture', versionMode: 'auto', transport: { kind: 'streamable_http', url: 'http://127.0.0.1:3000/mcp' },
    defaultToolPolicy: { permission: 'ask', parallelSafe: false, visibleToChild: true },
  }] });
  assert.equal(state.servers[0].health, 'ready');
  const registration = registry.resolve('mcp__fixture__studio_prepare');
  assert.equal(registration.mcpHook.appCallable, true);
  if (format === 'MCP Apps') assert.equal(registration.mcpHook.modelVisible, false);
  const request = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'fixture', permissionMode: 'task_free', tools: [registration.definition], messages: [], metadata: {} };
  executions.record({ protocol: 'bush.tool_call.v1', id: 'initial', name: registration.definition.name, argumentsText: '{}' },
    { ...request, round: 1, ordinal: 0 }, { kind: 'returned', result: native, workspaceChanges: [] });
  await host.remember(request);
  const view = await host.command({ action: 'open', sessionId: 's', turnId: 't', toolCallId: 'initial' });
  assert.equal(view.tool.name, 'studio.prepare');
  assert.deepEqual(view.result, native);
  assert.deepEqual(reads, ['ui://fixture']); assert.equal(calls.length, 0);
  for (const name of ['prepare', 'studio.prepare']) {
    const pending = host.command({ action: 'call', token: view.token, name, arguments: { topic: 'Fixture', intent: 'generation' } });
    let permission;
    for (let i = 0; i < 100; i++) {
      permission = (await host.command({ action: 'status', token: view.token })).permission;
      if (permission) break;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.ok(permission, 'the resolved tool still requests its original permission');
    assert.ok(permission.targets.some(target => target.value === 'mcp://fixture/tools/studio.prepare'));
    await host.command({ action: 'answer', token: view.token, permissionId: permission.permissionId, decision: 'allow_once' });
    assert.deepEqual(await pending, native);
  }
  assert.deepEqual(calls.map(call => ({ name: call.name, arguments: call.arguments })), [
    { name: 'studio.prepare', arguments: { topic: 'Fixture', intent: 'generation' } },
    { name: 'studio.prepare', arguments: { topic: 'Fixture', intent: 'generation' } },
  ]);
  assert.deepEqual(executions.listTurn('s', 't').slice(1).map(record => record.toolCall.name), ['mcp__fixture__studio_prepare', 'mcp__fixture__studio_prepare']);
  for (const record of executions.listTurn('s', 't').slice(1)) {
    assert.deepEqual(record.result, native);
    const { _meta, ...modelVisible } = native;
    assert.deepEqual(JSON.parse(registration.renderModelResult(record.result)), modelVisible);
  }
});
