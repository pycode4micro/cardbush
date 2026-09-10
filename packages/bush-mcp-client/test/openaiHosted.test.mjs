import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { McpClientManager, createOpenAiTransport, OpenAiAuthError } from '../dist/index.js';
import { ToolRegistry } from '@cardbush/bush-runtime';
import { mcpServerSnapshotSchema, OPENAI_HOSTED_PROTOCOL } from '@cardbush/bush-protocol';

const config = () => mcpServerSnapshotSchema.parse({ id: 'plugin_mail_gmail', versionMode: 'legacy', required: true,
  transport: { kind: 'streamable_http', url: OPENAI_HOSTED_PROTOCOL.mcpEndpoint, auth: 'openai', openaiAppId: 'gmail-app' } });
const profile = (name, id) => ({ name, inputSchema: { type: 'object', properties: {} }, outputSchema: {
  type: 'object', properties: { result: { type: 'object', properties: { email: { type: 'string' } }, required: ['email'] } }, required: ['result'] },
  _meta: { connector_id: id }, annotations: { readOnlyHint: true, destructiveHint: false } });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
function fixture(catalog, rawReply) {
  const calls = []; let generation = 0, authenticated = true;
  const token = async () => { if (!authenticated) throw new OpenAiAuthError(); return { accessToken: 'PRIVATE_OPENAI_TOKEN', generation }; };
  const fetch = async (url, init) => {
    assert.equal(String(url), OPENAI_HOSTED_PROTOCOL.mcpEndpoint); assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer PRIVATE_OPENAI_TOKEN');
    if (init.method === 'GET') return new Response(null, { status: 405 });
    const message = JSON.parse(init.body);
    if (!('id' in message)) return new Response(null, { status: 202 });
    let result;
    if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
    else if (message.method === 'tools/list') result = catalog ? catalog(message.params) : { tools: [profile('gmail_profile', 'gmail-app'), profile('other_profile', 'other-app'),
      { ...profile('app_only', 'gmail-app'), _meta: { connector_id: 'gmail-app', ui: { visibility: ['app'] } } }] };
    else if (message.method === 'tools/call') { calls.push(message.params.name); result = rawReply ?? { content: [{ type: 'text', text: 'ORIGINAL_REPLY' }], structuredContent: { result: { email: 'private@example.invalid' } } }; }
    else throw Error(`Unexpected method ${message.method}`);
    return json({ jsonrpc: '2.0', id: message.id, result });
  };
  return { token, fetch, calls, signOut: () => { authenticated = false; generation++; }, nextAccount: () => { generation++; } };
}
const snapshot = (server, revision = 1) => ({ protocol: 'bush.mcp_snapshot.v2', snapshotId: 'fixture', revision, servers: [server] });

test('empty hosted output declarations are compatible while their raw form and native results remain available', async t => {
  const raw = { ...profile('read_design', 'gmail-app'), outputSchema: {} };
  const f = fixture(() => ({ tools: [raw, { ...profile('unrelated', 'other-app'), outputSchema: { type: 'array' } }] }));
  const registry = new ToolRegistry(); let client;
  const manager = new McpClientManager({ registry, createClient: () => (client = new Client({ name: 'test', version: '1' })),
    createTransport: server => createOpenAiTransport(server, f.token, f.fetch) });
  t.after(() => manager.close());
  const result = await manager.apply(snapshot(config()));
  assert.equal(result.servers[0].health, 'ready');
  assert.deepEqual(result.servers[0].tools.map(tool => tool.remoteName), ['read_design']);
  const declared = (await client.listTools()).tools[0];
  assert.equal(declared.outputSchema, undefined);
  assert.deepEqual(declared._meta['cardbush/originalOutputSchema'], {});
  assert.equal(declared._meta['cardbush/outputSchemaNormalization'], 'empty_schema_omitted');
  assert.deepEqual(raw.outputSchema, {}, 'the upstream declaration is not mutated');
  const called = await client.callTool({ name: 'read_design', arguments: {} });
  assert.deepEqual(called.structuredContent, { result: { email: 'private@example.invalid' } });
  assert.deepEqual(called.content, [{ type: 'text', text: 'ORIGINAL_REPLY' }]);
  await assert.rejects(client.callTool({ name: 'unrelated', arguments: {} }), /does not belong/);
});

test('hosted application discovery follows later pages even when its first scoped page is empty', async t => {
  const pages = [];
  const f = fixture(params => {
    pages.push(params?.cursor);
    return params?.cursor === 'page-2'
      ? { tools: [profile('gmail_profile', 'gmail-app')] }
      : { tools: [profile('other_profile', 'other-app')], nextCursor: 'page-2' };
  });
  const manager = new McpClientManager({ registry: new ToolRegistry(), createTransport: server => createOpenAiTransport(server, f.token, f.fetch) });
  t.after(() => manager.close());
  const result = await manager.apply(snapshot(config()));
  assert.equal(result.servers[0].health, 'ready');
  assert.deepEqual(pages, [undefined, 'page-2']);
  assert.deepEqual(result.servers[0].tools.map(tool => tool.remoteName), ['gmail_profile']);
});

test('nonempty invalid hosted schemas still fail validation instead of being discarded', async t => {
  const f = fixture(() => ({ tools: [{ ...profile('bad_schema', 'gmail-app'), outputSchema: { type: 'array', items: { type: 'string' } } }] }));
  const manager = new McpClientManager({ registry: new ToolRegistry(), createTransport: server => createOpenAiTransport(server, f.token, f.fetch) });
  t.after(() => manager.close());
  await assert.rejects(manager.apply(snapshot(config())), /Invalid result for tools\/list/);
});

test('opaque pagination cursors retain callable tools from every scoped page', async t => {
  const pages = [];
  const f = fixture(params => {
    pages.push(params?.cursor);
    return params?.cursor === undefined
      ? { tools: [profile('first_profile', 'gmail-app')], nextCursor: '' }
      : { tools: [profile('last_profile', 'gmail-app')] };
  });
  const registry = new ToolRegistry();
  const manager = new McpClientManager({ registry, createTransport: server => createOpenAiTransport(server, f.token, f.fetch) });
  t.after(() => manager.close());
  const result = await manager.apply(snapshot(config()));
  assert.equal(result.servers[0].health, 'ready');
  assert.deepEqual(pages, [undefined, '']);
  for (const tool of result.servers[0].tools) {
    await registry.resolve(tool.runtimeName).execute({ requestId: 'r', sessionId: 's', turnId: 't', capabilityIds: [], input: {},
      toolCall: { id: 'c', name: tool.runtimeName } });
  }
  assert.deepEqual(f.calls, ['first_profile', 'last_profile']);
});

test('native OpenAI transport uses the ordinary registry, approval and output validation with exact app scoping', async t => {
  const f = fixture(), registry = new ToolRegistry(); let client;
  const manager = new McpClientManager({ registry, createClient: () => (client = new Client({ name: 'test', version: '1' })),
    createTransport: server => createOpenAiTransport(server, f.token, f.fetch) }); t.after(() => manager.close());
  const state = await manager.apply(snapshot(config()));
  assert.deepEqual(state.servers[0].tools.map(tool => tool.remoteName), ['gmail_profile', 'app_only']);
  assert.equal(registry.resolve('mcp__plugin_mail_gmail__app_only').mcpHook.modelVisible, false);
  assert.equal(registry.resolve('mcp__plugin_mail_gmail__app_only').mcpHook.appCallable, true);
  assert.equal(state.servers[0].health, 'ready');
  const registration = registry.resolve('mcp__plugin_mail_gmail__gmail_profile');
  assert.ok(registration); assert.equal(registration.authorize({}).kind, 'ask');
  assert.equal(registry.resolve('mcp__plugin_mail_gmail__other_profile'), undefined);
  await assert.rejects(client.callTool({ name: 'other_profile', arguments: {} }), /does not belong/);
  await assert.rejects(client.readResource({ uri: 'ui://another-app/private' }), /does not belong/);
  const result = await registration.execute({ requestId: 'r', sessionId: 's', turnId: 't', capabilityIds: [], input: {}, toolCall: { id: 'c', name: registration.definition.name } });
  assert.equal(result.isError, undefined); assert.equal(result.structuredContent.result.email, 'private@example.invalid');
  assert.equal(result.content[0].text, 'ORIGINAL_REPLY');
  assert.equal(result._meta?.['cardbush/outputNormalization'], undefined);
  assert.deepEqual(f.calls, ['gmail_profile']);
  assert.doesNotMatch(JSON.stringify(manager.snapshot()), /PRIVATE_OPENAI_TOKEN|private@example/);
  f.nextAccount();
  await assert.rejects(client.callTool({ name: 'gmail_profile', arguments: {} }), /account changed/);
  assert.equal(f.calls.length, 1, 'new-account credentials are not sent over the prior account session');
});

test('sign-out immediately disconnects hosted clients while snapshot replacement waits for active tasks', async t => {
  const f = fixture(), registry = new ToolRegistry(); let idle = true;
  const manager = new McpClientManager({ registry, canApply: () => idle, createTransport: server => createOpenAiTransport(server, f.token, f.fetch) });
  t.after(() => manager.close()); await manager.apply(snapshot(config()));
  idle = false; f.signOut(); await manager.invalidateOpenAiConnections();
  const state = await manager.refreshServers([config().id], snapshot(config(), 2));
  assert.equal(state.applicationState, 'pending'); assert.equal(manager.snapshot().servers[0].health, 'auth_required');
  idle = true;
  const applied = await manager.apply(snapshot(config(), 2));
  assert.equal(applied.servers[0].health, 'auth_required');
});

test('401 forces one private refresh and does not replay other failures', async () => {
  let requests = 0; const tokens = [];
  const transport = createOpenAiTransport(config(), async input => { tokens.push(input); return { accessToken: input.rejectedToken ? 'NEW' : 'OLD', generation: 0 }; }, async (_url, init) => {
    requests++; return json({}, new Headers(init.headers).get('authorization') === 'Bearer OLD' ? 401 : 202);
  });
  await transport.start(); await transport.send({ jsonrpc: '2.0', method: 'notifications/test' }); await transport.close();
  assert.equal(requests, 2); assert.equal(tokens[1].rejectedToken, 'OLD');
  requests = 0;
  const denied = createOpenAiTransport(config(), async () => ({ accessToken: 'OLD' }), async () => { requests++; return json({ message: 'PRIVATE_UPSTREAM_ERROR' }, 403); });
  await denied.start(); await assert.rejects(denied.send({ jsonrpc: '2.0', method: 'notifications/test' }), error => /HTTP 403/.test(error.message) && !error.message.includes('PRIVATE_'));
  await denied.close(); assert.equal(requests, 1);
});

test('expired shared OpenAI authorization reports settings login without retrying or resuming the old account session', async t => {
  const f = fixture(), registry = new ToolRegistry(); let prompts = 0;
  const manager = new McpClientManager({ registry, oauth: { close() {} }, onAuthenticationRequired: async () => { prompts++; return true; },
    createTransport: server => createOpenAiTransport(server, f.token, f.fetch) });
  t.after(() => manager.close()); await manager.apply(snapshot(config()));
  f.signOut();
  const registration = registry.resolve('mcp__plugin_mail_gmail__gmail_profile');
  const context = { requestId: 'r', sessionId: 's', turnId: 't', capabilityIds: [], input: {}, toolCall: { id: 'c', name: registration.definition.name } };
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(registration.execute(context), error => error.code === 'mcp_auth_required' && /plugin settings/.test(error.message));
  assert.equal(prompts, 0); assert.deepEqual(f.calls, []); assert.equal(manager.snapshot().servers[0].health, 'auth_required');
});

test('OpenAI authentication cannot target arbitrary endpoints or use plugin-provided headers', () => {
  for (const patch of [{ url: 'https://untrusted.invalid/mcp' }, { headers: { Authorization: 'bad' } }, { headersHelper: { command: 'bad', env: {} } }, { openaiAppId: undefined }, { oauth: { clientId: 'bad' } }, { kind: 'sse' }]) {
    assert.equal(mcpServerSnapshotSchema.safeParse({ ...config(), transport: { ...config().transport, ...patch } }).success, false);
    assert.throws(() => createOpenAiTransport({ ...config(), transport: { ...config().transport, ...patch } }), /Invalid OpenAI/);
  }
});
