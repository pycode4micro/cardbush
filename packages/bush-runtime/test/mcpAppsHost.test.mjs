import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { ToolRegistry, ToolExecutionStore, McpAppsHost } from '../dist/index.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-mcp-app-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-mcp-app-')); await rm(root, { recursive: true, force: true }); });
  const registry = new ToolRegistry(), executions = new ToolExecutionStore(); let calls = 0, reads = 0, before = 0;
  const register = (name, server, options = {}) => registry.register({ definition: { name, description: 'App', inputSchema: { type: 'object' } }, manifest: { effect_kind: 'external_action', operation: 'fixture', risk: 'low', owner: 'runtime', dispatch_scope: 'parent_session', mutating: true },
    decodeInput: x => x, execute: () => { calls++; return { content: [], structuredContent: { saved: true }, _meta: { hidden: 'UI only' } }; },
    authorize: () => ({ kind: 'ask', request: { reason: 'Confirm change', actions: ['write'], targets: [{ kind: 'mcp_resource', value: `mcp://${server}/save` }], capabilityIds: ['write'] } }),
    mcpHook: { server, tool: 'save', call: async () => ({}), ...options },
    mcpApp: { resourceUri: 'ui://fixture', readResource: async uri => { reads++; return { contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: '<h1>Fixture</h1>', _meta: { ui: { csp: { resourceDomains: ['https://example.com'] } } } }] }; } },
  });
  register('mcp__demo__save', 'demo'); register('mcp__hidden__save', 'hidden');
  const req = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'm', permissionMode: 'task_free', tools: [registry.resolve('mcp__demo__save').definition], messages: [], metadata: { providerSecret: 'must not persist' } };
  executions.record({ protocol: 'bush.tool_call.v1', id: 'original', name: 'mcp_call', argumentsText: JSON.stringify({ name: 'mcp__demo__save', arguments: { query: 'original' } }) }, { ...req, round: 1, ordinal: 0 }, { kind: 'returned', workspaceChanges: [], result: { mcp: { name: 'mcp__demo__save' }, result: { content: [], _meta: { uiOnly: true } } } });
  const host = new McpAppsHost(root, registry, executions, undefined, () => ({ before: async () => { before++; return { messages: [] }; }, after: async () => ({ messages: [] }) }));
  t.after(() => host.close()); await host.remember(req);
  const view = await host.command({ action: 'open', sessionId: 's', turnId: 't', toolCallId: 'original' });
  return { root, registry, executions, host, view, req, counts: () => ({ calls, reads, before }) };
}
async function permission(host, token) { for (let i = 0; i < 100; i++) { const state = await host.command({ action: 'status', token }); if (state.permission) return state.permission; await new Promise(resolve => setTimeout(resolve, 5)); } throw Error('Permission did not arrive'); }
test('MCP Apps open only bound executions and preserve native UI data', async t => {
  const { host, view, counts } = await fixture(t);
  assert.match(view.html, /Fixture/); assert.deepEqual(view.input, { query: 'original' }); assert.equal(view.result._meta.uiOnly, true);
  assert.equal(counts().reads, 1);
  await assert.rejects(host.command({ action: 'open', sessionId: 'other', turnId: 't', toolCallId: 'original' }), /completed/);
  await assert.rejects(host.command({ action: 'call', token: 'forged', name: 'save', arguments: {} }), /expired/);
  await assert.rejects(host.command({ action: 'call', token: view.token, name: 'shell', arguments: {} }), /not available/);
});
test('UI tool calls use Hook/permission coordinator and persist audit records', async t => {
  const { host, view, counts, executions } = await fixture(t);
  const first = host.command({ action: 'call', token: view.token, name: 'save', arguments: { n: 1 } });
  const denied = assert.rejects(first, /permission was rejected/);
  const ask = await permission(host, view.token);
  assert.equal(counts().calls, 0); await host.command({ action: 'answer', token: view.token, permissionId: ask.permissionId, decision: 'deny' }); await denied;
  const second = host.command({ action: 'call', token: view.token, name: 'save', arguments: { n: 2 } });
  const allow = await permission(host, view.token);
  await assert.rejects(host.command({ action: 'answer', token: view.token, permissionId: ask.permissionId, decision: 'allow_once' }), /no longer pending/);
  await host.command({ action: 'answer', token: view.token, permissionId: allow.permissionId, decision: 'allow_once' });
  assert.equal((await second).structuredContent.saved, true); assert.equal(counts().calls, 1); assert.equal(counts().before, 2);
  assert.equal(executions.listTurn('s', 't').length, 3);
});
test('Closing an interface cancels pending authorization and revokes its token', async t => {
  const { host, view, counts } = await fixture(t);
  const pending = host.command({ action: 'call', token: view.token, name: 'save', arguments: {} });
  const rejected = assert.rejects(pending, /cancelled/i); await permission(host, view.token); await host.command({ action: 'close', token: view.token }); await rejected;
  assert.equal(counts().calls, 0); await assert.rejects(host.command({ action: 'status', token: view.token }), /expired/);
});

test('App resource reads require a scoped permission and are recorded like tool actions', async t => {
  const { host, view, executions } = await fixture(t);
  const pending = host.command({ action: 'resource', token: view.token, uri: 'ui://fixture' });
  const ask = await permission(host, view.token); assert.match(ask.targets[0].value, /mcp:\/\/demo\/resources\//);
  await host.command({ action: 'answer', token: view.token, permissionId: ask.permissionId, decision: 'allow_once' });
  assert.equal((await pending).contents[0].uri, 'ui://fixture'); assert.equal(executions.listTurn('s', 't').at(-1).toolCall.name, 'mcp_app_resource_read');
});
test('Interface model context persists for subsequent turns and scopes survive restart', async t => {
  const { host, view, registry, executions, root } = await fixture(t);
  await host.command({ action: 'context', token: view.token, context: { structuredContent: { selected: 42 } } });
  const restarted = new McpAppsHost(root, registry, executions); t.after(() => restarted.close());
  assert.match(await restarted.context('s'), /selected/);
  const reopened = await restarted.command({ action: 'open', sessionId: 's', turnId: 't', toolCallId: 'original' }); assert.match(reopened.html, /Fixture/);
  registry.removeOwned('runtime_mcp'); // Unrelated removal cannot change the persisted authority.
  await assert.rejects(restarted.command({ action: 'call', token: reopened.token, name: 'not-in-scope', arguments: {} }), /not available/);
});
