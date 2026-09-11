import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { ToolRegistry, ToolExecutionStore, McpAppsHost } from '../dist/index.js';

async function fixture(t, configure = () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-mcp-app-'));
  t.after(async () => { await host.close(); assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-mcp-app-')); await rm(root, { recursive: true, force: true }); });
  const registry = new ToolRegistry(), executions = new ToolExecutionStore(); let calls = 0, reads = 0, before = 0;
  const register = (name, server, options = {}) => registry.register({ definition: { name, description: 'App', inputSchema: { type: 'object' } }, manifest: { effect_kind: 'external_action', operation: 'fixture', risk: 'low', owner: 'runtime', dispatch_scope: 'parent_session', mutating: true },
    decodeInput: x => x, execute: () => { calls++; return { content: [], structuredContent: { saved: true }, _meta: { hidden: 'UI only' } }; },
    authorize: () => ({ kind: 'ask', request: { reason: 'Confirm change', actions: ['write'], targets: [{ kind: 'mcp_resource', value: `mcp://${server}/save` }], capabilityIds: ['write'] } }),
    mcpHook: { server, tool: 'save', call: async () => ({}), ...options },
    mcpApp: { resourceUri: 'ui://fixture', readResource: async uri => { reads++; return { contents: [{ uri, mimeType: 'text/html;profile=mcp-app', text: '<h1>Fixture</h1>', _meta: { ui: { csp: { resourceDomains: ['https://example.com'] } } } }] }; } },
  });
  register('mcp__demo__save', 'demo'); register('mcp__hidden__save', 'hidden');
  const req = { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: 's', turnId: 't', model: 'm', permissionMode: 'task_free', tools: [registry.resolve('mcp__demo__save').definition], messages: [], metadata: { providerSecret: 'must not persist' } };
  configure({ registry, req, register });
  executions.record({ protocol: 'bush.tool_call.v1', id: 'original', name: 'mcp_call', argumentsText: JSON.stringify({ name: 'mcp__demo__save', arguments: { query: 'original' } }) }, { ...req, round: 1, ordinal: 0 }, { kind: 'returned', workspaceChanges: [], result: { mcp: { name: 'mcp__demo__save' }, result: { content: [], _meta: { uiOnly: true } } } });
  const host = new McpAppsHost(root, registry, executions, undefined, () => ({ before: async () => { before++; return { messages: [] }; }, after: async () => ({ messages: [] }) }));
  await host.remember(req);
  const view = await host.command({ action: 'open', sessionId: 's', turnId: 't', toolCallId: 'original' });
  return { root, registry, executions, host, view, req, counts: () => ({ calls, reads, before }) };
}
async function permission(host, token) { for (let i = 0; i < 100; i++) { const state = await host.command({ action: 'status', token }); if (state.permission) return state.permission; await new Promise(resolve => setTimeout(resolve, 5)); } throw Error('Permission did not arrive'); }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function answer(host, token, decision = 'allow_once') {
  const ask = await permission(host, token);
  await host.command({ action: 'answer', token, permissionId: ask.permissionId, decision });
  return ask;
}

test('short and full interface names invoke the same scoped tool with native results, permissions and audit identity', async t => {
  const { host, view, counts, executions } = await fixture(t, ({ registry }) => {
    registry.resolve('mcp__demo__save').mcpHook.tool = 'studio.save';
  });
  for (const name of ['save', 'studio.save']) {
    const pending = host.command({ action: 'call', token: view.token, name, arguments: { value: name } });
    const before = counts().calls; await permission(host, view.token);
    assert.equal(counts().calls, before, 'name resolution does not grant execution permission');
    await answer(host, view.token);
    assert.deepEqual(await pending, { content: [], structuredContent: { saved: true }, _meta: { hidden: 'UI only' } });
    const record = executions.listTurn('s', 't').at(-1);
    assert.equal(record.toolCall.name, 'mcp__demo__save');
    assert.deepEqual(JSON.parse(record.toolCall.argumentsText), { value: name });
  }
  assert.equal(counts().calls, 2); assert.equal(counts().before, 2);
});

test('exact remote names win over short-name aliases and ambiguous aliases never dispatch', async t => {
  const { host, view, registry, executions, counts } = await fixture(t, ({ registry, req, register }) => {
    for (const prefix of ['studio', 'editor']) {
      const name = `mcp__demo__${prefix}_save`; register(name, 'demo', { tool: `${prefix}.save` });
      req.tools.push(registry.resolve(name).definition);
    }
  });
  const exact = host.command({ action: 'call', token: view.token, name: 'save', arguments: {} });
  await answer(host, view.token); await exact;
  assert.equal(executions.listTurn('s', 't').at(-1).toolCall.name, 'mcp__demo__save');
  registry.resolve('mcp__demo__save').mcpHook.tool = 'open';
  await assert.rejects(host.command({ action: 'call', token: view.token, name: 'save', arguments: {} }), { code: 'mcp_app_tool_ambiguous' });
  assert.equal(counts().calls, 1); assert.equal(counts().before, 1, 'ambiguous names never enter execution hooks');
  const qualified = host.command({ action: 'call', token: view.token, name: 'editor.save', arguments: {} });
  await answer(host, view.token); await qualified;
  assert.equal(executions.listTurn('s', 't').at(-1).toolCall.name, 'mcp__demo__editor_save');
});

test('short-name resolution cannot widen the task, service or Agent session scope', async t => {
  const { host, view, counts } = await fixture(t, ({ registry, req, register }) => {
    registry.resolve('mcp__hidden__save').mcpHook.tool = 'other.hidden';
    req.tools.push(registry.resolve('mcp__hidden__save').definition);
    register('mcp__demo__outside', 'demo', { tool: 'studio.outside' });
    register('mcp__demo__private', 'demo', { tool: 'studio.private' });
    registry.resolve('mcp__demo__private').sessionScope = 'another-agent';
    req.tools.push(registry.resolve('mcp__demo__private').definition);
  });
  for (const name of ['hidden', 'other.hidden', 'outside', 'studio.outside', 'private', 'studio.private', 'mcp__demo__save']) {
    await assert.rejects(host.command({ action: 'call', token: view.token, name, arguments: {} }), { code: 'mcp_app_tool_unavailable' }, name);
  }
  assert.equal(counts().calls, 0); assert.equal(counts().before, 0);
});

test('interface-only tools support short names while explicit app visibility denials cannot fall through', async t => {
  const { host, view, counts, registry, executions } = await fixture(t, ({ registry, req, register }) => {
    register('mcp__demo__poll', 'demo', { tool: 'studio.poll', modelVisible: false, appCallable: true });
    register('mcp__demo__private_save', 'demo', { tool: 'save', appCallable: false });
    registry.resolve('mcp__demo__save').mcpHook.tool = 'studio.save';
    req.tools.push(registry.resolve('mcp__demo__poll').definition, registry.resolve('mcp__demo__private_save').definition);
  });
  await assert.rejects(host.command({ action: 'call', token: view.token, name: 'save', arguments: {} }), { code: 'mcp_app_tool_not_exposed' });
  assert.equal(counts().calls, 0, 'a denied exact name cannot fall through to the allowed namespaced tool');
  const pending = host.command({ action: 'call', token: view.token, name: 'poll', arguments: { job: 'fixture' } });
  await answer(host, view.token); await pending;
  assert.equal(executions.listTurn('s', 't').at(-1).toolCall.name, 'mcp__demo__poll');
  registry.resolve('mcp__demo__poll').mcpHook.appCallable = false;
  for (const name of ['poll', 'studio.poll']) await assert.rejects(host.command({ action: 'call', token: view.token, name, arguments: {} }), { code: 'mcp_app_tool_not_exposed' });
  assert.equal(counts().calls, 1);
});

test('interface aliases remove only one namespace and preserve case and punctuation', async t => {
  const { host, view, counts, executions } = await fixture(t, ({ registry }) => {
    registry.resolve('mcp__demo__save').mcpHook.tool = 'suite.image.Export-Design';
  });
  for (const name of ['Export-Design', 'image.export-design', 'image.Export_Design', 'other.image.Export-Design']) {
    await assert.rejects(host.command({ action: 'call', token: view.token, name, arguments: {} }), { code: 'mcp_app_tool_unavailable' }, name);
  }
  await assert.rejects(host.command({ action: 'call', token: view.token, name: '', arguments: {} }), /Invalid interface tool call/);
  for (const name of ['image.Export-Design', 'suite.image.Export-Design']) {
    const pending = host.command({ action: 'call', token: view.token, name, arguments: {} });
    await answer(host, view.token); await pending;
    assert.equal(executions.listTurn('s', 't').at(-1).toolCall.name, 'mcp__demo__save');
  }
  assert.equal(counts().calls, 2);
});

test('overlapping interface calls and resource reads queue in order with independent permissions and results', async t => {
  const { host, view, counts, executions } = await fixture(t);
  const head = host.command({ action: 'call', token: view.token, name: 'save', arguments: { n: 1 } });
  const denied = assert.rejects(head, /permission was rejected/);
  const resource = host.command({ action: 'resource', token: view.token, uri: 'ui://queued' });
  const tail = host.command({ action: 'call', token: view.token, name: 'save', arguments: { n: 3 } });
  await host.command({ action: 'context', token: view.token, context: { structuredContent: { waiting: true } } });
  assert.match(await host.context('s'), /waiting/, 'context updates bypass the action queue');
  const firstAsk = await answer(host, view.token, 'deny'); await denied;
  const secondAsk = await permission(host, view.token);
  assert.notEqual(secondAsk.permissionId, firstAsk.permissionId);
  assert.equal(counts().calls, 0);
  assert.match(secondAsk.targets[0].value, /resources/);
  await host.command({ action: 'answer', token: view.token, permissionId: secondAsk.permissionId, decision: 'allow_once' });
  assert.equal((await resource).contents[0].uri, 'ui://queued');
  const thirdAsk = await answer(host, view.token);
  assert.notEqual(thirdAsk.permissionId, secondAsk.permissionId);
  assert.equal((await tail).structuredContent.saved, true);
  assert.equal(counts().calls, 1);
  assert.equal(counts().before, 3);
  assert.equal((await host.command({ action: 'status', token: view.token })).busy, false);
  const records = executions.listTurn('s', 't').slice(1);
  assert.deepEqual(records.map(r => r.toolCall.name), ['mcp__demo__save', 'mcp_app_resource_read', 'mcp__demo__save']);
  assert.equal(new Set(records.map(r => r.toolCall.id)).size, 3);
  assert.deepEqual(records.map(r => r.round), [2, 3, 4], 'each action records once in dispatch order');
});

test('a slow interface action preserves FIFO and each caller receives its own result', async t => {
  const { host, registry, view } = await fixture(t);
  const gate = deferred(), started = deferred(), calls = [];
  registry.resolve('mcp__demo__save').execute = async context => {
    calls.push(context.input.n);
    if (context.input.n === 1) { started.resolve(); await gate.promise; }
    return { structuredContent: { n: context.input.n } };
  };
  const first = host.command({ action: 'call', token: view.token, name: 'save', arguments: { n: 1 } });
  const queued = { action: 'call', token: view.token, name: 'save', arguments: { n: 2 } };
  const second = host.command(queued); queued.arguments.n = 99;
  await answer(host, view.token); await started.promise;
  assert.deepEqual(calls, [1]);
  assert.equal((await host.command({ action: 'status', token: view.token })).permission, null);
  gate.resolve(); assert.equal((await first).structuredContent.n, 1);
  await answer(host, view.token); assert.equal((await second).structuredContent.n, 2);
  assert.deepEqual(calls, [1, 2]);
});

test('cancelling a queued request settles it while the head awaits authorization and does not poison later work', async t => {
  const { host, view, counts, executions } = await fixture(t);
  const first = host.command({ action: 'call', token: view.token, name: 'save', arguments: { n: 1 } });
  const denied = assert.rejects(first, /permission was rejected/);
  const firstAsk = await permission(host, view.token);
  const controller = new AbortController();
  const cancelled = assert.rejects(host.command({ action: 'call', token: view.token, name: 'save', arguments: { n: 2 } }, controller.signal), /cancelled|abort/i);
  const third = host.command({ action: 'call', token: view.token, name: 'save', arguments: { n: 3 } });
  controller.abort(); await cancelled;
  assert.equal((await host.command({ action: 'status', token: view.token })).permission.permissionId, firstAsk.permissionId);
  assert.equal(counts().calls, 0);
  await host.command({ action: 'answer', token: view.token, permissionId: firstAsk.permissionId, decision: 'deny' }); await denied;
  await answer(host, view.token); await third;
  assert.equal(counts().calls, 1);
  assert.equal(executions.listTurn('s', 't').length, 3, 'a cancelled queued action was never dispatched');
});

test('closing an interface cancels its active permission and all queued actions', async t => {
  const { host, view, counts } = await fixture(t);
  const work = Promise.allSettled([
    host.command({ action: 'call', token: view.token, name: 'save', arguments: {} }),
    host.command({ action: 'resource', token: view.token, uri: 'ui://queued' }),
    host.command({ action: 'call', token: view.token, name: 'save', arguments: {} }),
  ]);
  await permission(host, view.token); await host.close(view.token);
  assert.ok((await work).every(result => result.status === 'rejected'));
  assert.equal(counts().calls, 0); assert.equal(counts().reads, 1);
});

test('closing during a non-cooperative operation settles queued callers without dispatching them', async t => {
  const { host, registry, view } = await fixture(t);
  const started = deferred(); let calls = 0;
  registry.resolve('mcp__demo__save').execute = () => { calls++; started.resolve(); return new Promise(() => {}); };
  const work = Promise.allSettled([
    host.command({ action: 'call', token: view.token, name: 'save', arguments: {} }),
    host.command({ action: 'call', token: view.token, name: 'save', arguments: {} }),
  ]);
  await answer(host, view.token); await started.promise; await host.close(view.token);
  assert.ok((await work).every(result => result.status === 'rejected')); assert.equal(calls, 1);
});

test('queued work rechecks the live connection after the preceding action finishes', async t => {
  const { host, registry, view } = await fixture(t);
  const gate = deferred(), started = deferred(); let calls = 0;
  const registration = registry.resolve('mcp__demo__save'); registration.registrationOwner = 'queue-connection';
  registration.execute = async () => { calls++; started.resolve(); await gate.promise; return { content: [] }; };
  const first = host.command({ action: 'call', token: view.token, name: 'save', arguments: {} });
  const queued = assert.rejects(host.command({ action: 'call', token: view.token, name: 'save', arguments: {} }), { code: 'mcp_app_connection_changed' });
  await answer(host, view.token); await started.promise;
  registry.replaceOwned('queue-connection', [{ ...registration }]); gate.resolve(); await first; await queued;
  assert.equal(calls, 1, 'the queued action cannot execute against the replacement account');
});
test('MCP Apps open only bound executions and preserve native UI data', async t => {
  const { host, view, counts } = await fixture(t);
  assert.match(view.html, /Fixture/); assert.deepEqual(view.input, { query: 'original' }); assert.equal(view.result._meta.uiOnly, true);
  assert.equal(counts().reads, 1);
  await assert.rejects(host.command({ action: 'open', sessionId: 'other', turnId: 't', toolCallId: 'original' }), /completed/);
  await assert.rejects(host.command({ action: 'call', token: 'forged', name: 'save', arguments: {} }), /expired/);
  await assert.rejects(host.command({ action: 'call', token: view.token, name: 'shell', arguments: {} }), { code: 'mcp_app_tool_unavailable' });
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
  const restarted = new McpAppsHost(root, registry, executions);
  assert.match(await restarted.context('s'), /selected/);
  const reopened = await restarted.command({ action: 'open', sessionId: 's', turnId: 't', toolCallId: 'original' }); assert.match(reopened.html, /Fixture/);
  registry.removeOwned('runtime_mcp'); // Unrelated removal cannot change the persisted authority.
  await assert.rejects(restarted.command({ action: 'call', token: reopened.token, name: 'not-in-scope', arguments: {} }), { code: 'mcp_app_tool_unavailable' });
  await restarted.close();
});

test('declarations, resource loads, frame loads and handshakes remain distinct observations', async t => {
  const { host, view, counts, registry, executions, root } = await fixture(t);
  const found = await host.command({ action: 'describe', sessionId: 's', turnId: 't', toolCallIds: ['original'] });
  assert.equal(found.interfaces.length, 1); assert.equal(counts().reads, 1, 'lookup does not load a resource');
  assert.equal(found.interfaces[0].activeViews[0].frameLoaded, false);
  assert.deepEqual((await host.observations.since('s')).events.map(event => event.event), ['resource_loading', 'resource_loaded']);
  await host.command({ action: 'observe', token: view.token, event: 'frame_loaded' });
  assert.equal((await host.describe('s', 't'))[0].activeViews[0].initialized, false, 'iframe load is not a protocol handshake');
  await host.command({ action: 'observe', token: view.token, event: 'initialized' });
  await host.command({ action: 'observe', token: view.token, event: 'initialized' });
  assert.equal((await host.observations.since('s', 3)).events.length, 1, 'duplicate handshake is not another observation');
  await assert.rejects(host.command({ action: 'observe', token: view.token, event: 'task_completed' }), /Invalid/);
  await host.command({ action: 'close', token: view.token });
  const restarted = new McpAppsHost(root, registry, executions);
  assert.equal((await restarted.describe('s', 't'))[0].activeViews.length, 0, 'historical load must not imply a live view');
  const history = await restarted.observations.since('s');
  assert.deepEqual(history.events.map(event => event.event), ['resource_loading', 'resource_loaded', 'frame_loaded', 'initialized', 'closed']);
  assert.equal(JSON.stringify(history).includes(view.token), false);
  assert.equal((await restarted.observations.since('other')).events.length, 0);
});

test('failed resource loading remains visible and can be retried', async t => {
  const { host, view, registry } = await fixture(t);
  await host.command({ action: 'close', token: view.token });
  registry.resolve('mcp__demo__save').mcpApp.readResource = async () => { throw Error('Resource unavailable'); };
  await assert.rejects(host.command({ action: 'open', sessionId: 's', turnId: 't', toolCallId: 'original' }), /Resource unavailable/);
  const history = await host.observations.since('s');
  assert.equal(history.events.at(-1).event, 'failed'); assert.equal(history.events.at(-1).detail, 'Resource unavailable');
  assert.equal((await host.describe('s', 't'))[0].activeViews.length, 0);
});

test('automatic UI opens reserve capacity before downloads and cancelled loads never create instances', async t => {
  const { host, view, registry } = await fixture(t); await host.close(view.token);
  let release, started, reads = 0;
  const gate = new Promise(resolve => { release = resolve; }), begun = new Promise(resolve => { started = resolve; });
  registry.resolve('mcp__demo__save').mcpApp.readResource = async uri => {
    if (++reads === 16) started(); await gate; return { contents: [{ uri, mimeType: 'text/html', text: '<h1>Capacity</h1>' }] };
  };
  const opens = Array.from({ length: 17 }, () => host.command({ action: 'open', sessionId: 's', turnId: 't', toolCallId: 'original' }));
  const outcomes = Promise.allSettled(opens); await begun; assert.equal(reads, 16); release();
  const done = await outcomes; assert.equal(done.filter(result => result.status === 'fulfilled').length, 16);
  assert.equal(done.filter(result => result.status === 'rejected').length, 1); await host.close();
  let reading;
  const readingStarted = new Promise(resolve => { reading = resolve; });
  registry.resolve('mcp__demo__save').mcpApp.readResource = async () => { reading(); return new Promise(() => {}); };
  const controller = new AbortController();
  const opening = host.command({ action: 'open', sessionId: 's', turnId: 't', toolCallId: 'original' }, controller.signal);
  const rejected = assert.rejects(opening, /cancelled/i); await readingStarted; controller.abort(); await rejected;
  assert.equal((await host.describe('s', 't'))[0].activeViews.length, 0);
  assert.equal((await host.observations.since('s')).events.at(-1).event, 'closed');
});

test('a UI from an old connection cannot call a newly registered account connection', async t => {
  const { host, view, registry, counts } = await fixture(t);
  const old = registry.resolve('mcp__demo__save'); old.registrationOwner = 'fixture-connection';
  registry.replaceOwned('fixture-connection', [{ ...old }]);
  await assert.rejects(host.command({ action: 'call', token: view.token, name: 'save', arguments: {} }), /connection changed/);
  assert.equal(counts().calls, 0); assert.equal((await host.describe('s', 't'))[0].activeViews.length, 0);
});

test('republishing the same live MCP connection keeps open interfaces valid', async t => {
  const { host, registry, view } = await fixture(t); await host.close(view.token);
  const original = registry.resolve('mcp__demo__save');
  original.registrationOwner = 'fixture-connection'; original.mcpApp.connectionIdentity = {};
  const opened = await host.command({ action: 'open', sessionId: 's', turnId: 't', toolCallId: 'original' });
  registry.replaceOwned('fixture-connection', [{ ...original, mcpApp: { ...original.mcpApp } }]);
  await host.command({ action: 'observe', token: opened.token, event: 'initialized' });
  assert.equal((await host.describe('s', 't'))[0].activeViews[0].initialized, true);
  assert.equal((await host.command({ action: 'status', token: opened.token })).busy, false);
});

test('reconnecting a client inside the same registration revokes its existing views', async t => {
  const { host, registry, view, counts } = await fixture(t); await host.close(view.token);
  const registration = registry.resolve('mcp__demo__save'); registration.mcpApp.connectionIdentity = {};
  const opened = await host.command({ action: 'open', sessionId: 's', turnId: 't', toolCallId: 'original' });
  registration.mcpApp.connectionIdentity = {};
  await assert.rejects(host.command({ action: 'call', token: opened.token, name: 'save', arguments: {} }), { code: 'mcp_app_connection_changed' });
  assert.equal(counts().calls, 0);
  assert.equal((await host.describe('s', 't'))[0].activeViews.length, 0);
});

test('resource loads accept same-connection publication but reject an actual replacement', async t => {
  const { host, registry, view } = await fixture(t); await host.close(view.token);
  const registration = registry.resolve('mcp__demo__save'); registration.registrationOwner = 'fixture-connection'; registration.mcpApp.connectionIdentity = {};
  const read = registration.mcpApp.readResource;
  let replaceConnection = false;
  registration.mcpApp.readResource = async uri => {
    const current = registry.resolve('mcp__demo__save');
    registry.replaceOwned('fixture-connection', [{ ...current, mcpApp: { ...current.mcpApp, connectionIdentity: replaceConnection ? {} : current.mcpApp.connectionIdentity } }]);
    return read(uri);
  };
  const opened = await host.command({ action: 'open', sessionId: 's', turnId: 't', toolCallId: 'original' }); await host.close(opened.token);
  replaceConnection = true;
  await assert.rejects(host.command({ action: 'open', sessionId: 's', turnId: 't', toolCallId: 'original' }), { code: 'mcp_app_connection_changed' });
  assert.equal((await host.describe('s', 't'))[0].activeViews.length, 0);
});

test('UI declarations expose the server isError fact and original text without interpreting the result', async t => {
  const { host, executions, req, counts } = await fixture(t);
  const record = (id, result, wrapped = false) => executions.record({ protocol: 'bush.tool_call.v1', id, name: wrapped ? 'mcp_call' : 'mcp__demo__save', argumentsText: '{}' }, { ...req, round: 2, ordinal: 0 }, { kind: 'returned', workspaceChanges: [], result: wrapped ? { mcp: { name: 'mcp__demo__save' }, result } : result });
  const native = { isError: true, content: [{ type: 'text', text: 'Invalid arguments: unsupported design_type' }], _meta: { privateData: 'UI only' } };
  record('rejected', native); record('wrapped-rejected', native, true);
  record('empty', { isError: false, content: [], structuredContent: { items: [] } });
  record('unflagged', { content: [{ type: 'text', text: 'error: a literal word in a normal response' }] });
  const declarations = await host.describe('s', 't');
  for (const id of ['rejected', 'wrapped-rejected']) assert.deepEqual(declarations.find(view => view.toolCallId === id).resultError, { text: 'Invalid arguments: unsupported design_type', truncated: false });
  for (const id of ['empty', 'unflagged']) assert.equal(declarations.find(view => view.toolCallId === id).resultError, undefined);
  assert.equal(JSON.stringify(declarations).includes('privateData'), false);
  assert.equal(counts().reads, 1, 'describing an error does not load a widget');
  assert.deepEqual(executions.get('s', 't', 'rejected').result, native, 'the recorded response is unchanged');
});
