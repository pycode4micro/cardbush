import { oauthServer } from './fixtures/oauthServer.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { ToolRegistry } from '@cardbush/bush-runtime';
import { McpClientManager, McpOAuthCoordinator, credentialKey } from '../dist/index.js';

function credentials() {
  const vault = new Map();
  return { vault, store: { read: async key => structuredClone(vault.get(key)), write: async (key, value) => {
    if (value) vault.set(key, structuredClone(value)); else vault.delete(key);
  } } };
}
function serverSnapshot(server) { return { protocol: 'bush.mcp_snapshot.v2', snapshotId: 'auth', revision: 1, servers: [server] }; }

test('private client credentials work without environment changes and refresh from the vault', async () => {
  const fixture = await oauthServer({ clientId: 'private-client', clientSecret: 'fixture-only-vault-secret' });
  const { vault, store } = credentials();
  const ref = 'c'.repeat(64);
  const server = { id: 'private', transport: { kind: 'streamable_http', url: fixture.url + '/mcp',
    oauth: { clientId: 'private-client', clientSecretRef: ref, clientSecretEnv: 'CARDBUSH_TEST_NONEXISTENT_PRIVATE_SECRET' } }, versionMode: 'legacy' };
  const oauth = new McpOAuthCoordinator(store, async url => { assert.equal((await fetch(url)).status, 200); });
  const manager = new McpClientManager({ registry: new ToolRegistry(), oauth });
  try {
    await assert.rejects(oauth.login(server), /saved client secret is missing/);
    await store.write(ref, { clientSecret: { value: 'fixture-only-vault-secret', url: fixture.url + '/mcp', clientId: 'private-client' } });
    await oauth.login(server);
    const state = await manager.apply(serverSnapshot(server));
    assert.equal(state.servers[0].health, 'ready');
    assert.equal(fixture.counters.codes, 1);
    assert.doesNotMatch(JSON.stringify(state), /fixture-only-vault-secret/);
    const provider = oauth.provider(server);
    await store.write(ref, { clientSecret: { value: 'rotated-fixture-value', url: fixture.url + '/mcp', clientId: 'private-client' } });
    assert.equal((await provider.clientInformation()).client_secret, 'rotated-fixture-value', 'private entries never inherit a stale process/cache value');
    await assert.rejects(oauth.provider({ ...server, transport: { ...server.transport, url: 'https://another.example/mcp' } }).clientInformation(), /different endpoint or client ID/);
    await assert.rejects(oauth.provider({ ...server, transport: { ...server.transport, oauth: { clientId: 'other-client', clientSecretRef: ref } } }).clientInformation(), /different endpoint or client ID/);
    await oauth.logout(server);
    assert.equal(vault.has(ref), true, 'sign-out removes tokens, not the configured client credential');
  } finally { await manager.close(); oauth.close(); await fixture.close(); }
});
function toolContext(value, signal = new AbortController().signal, id = 'call-auth') {
  return { requestId: 'request-auth', sessionId: 'task-auth', turnId: 'turn-auth', toolCall: { id }, input: { value }, signal,
    turn: { request: { metadata: {} }, contextMessages: [] } };
}

test('OAuth discovery, DCR, state/issuer, PKCE, refresh and logout work against a real loopback MCP server', async () => {
  const fixture = await oauthServer();
  const vault = new Map();
  const store = { read: async key => structuredClone(vault.get(key)), write: async (key, value) => { if (value) vault.set(key, structuredClone(value)); else vault.delete(key); } };
  let opened = 0;
  const oauth = new McpOAuthCoordinator(store, async link => {
    opened++;
    const authorize = new URL(link);
    const bad = new URL(authorize.searchParams.get('redirect_uri'));
    bad.searchParams.set('state', 'wrong');
    assert.equal((await fetch(bad)).status, 400);
    const result = await fetch(link);
    assert.equal(result.status, 200);
  });
  const registry = new ToolRegistry();
  const manager = new McpClientManager({ registry, oauth });
  const server = { id: 'authorized', transport: { kind: 'streamable_http', url: fixture.url + '/mcp' }, versionMode: 'legacy' };
  const snapshot = revision => ({ protocol: 'bush.mcp_snapshot.v2', snapshotId: 'oauth-fixture', revision, servers: [server] });
  try {
    const before = await manager.apply(snapshot(1));
    assert.equal(before.servers[0].health, 'auth_required');
    assert.equal(opened, 0, 'background tool discovery never opens a browser');
    await oauth.login(server);
    assert.equal(opened, 1);
    assert.equal(fixture.counters.registrations, 1);
    assert.equal(fixture.counters.codes, 1);
    assert.equal(vault.size, 1);
    const ready = await manager.refresh('authorized', snapshot(2));
    assert.equal(ready.servers[0].health, 'ready');
    assert.ok(registry.resolve('mcp__authorized__echo'));
    const tool = registry.mcpHook('authorized', 'echo');
    const result = await tool.call({ value: 'hello' }, { timeoutMs: 1000, request: { requestId: 'r', sessionId: 's', turnId: 't', metadata: {} } });
    assert.equal(result.content[0].text, 'hello');
    fixture.expire();
    const refreshed = await tool.call({ value: 'refreshed' }, { timeoutMs: 1000, request: { requestId: 'r', sessionId: 's', turnId: 't', metadata: {} } });
    assert.equal(refreshed.content[0].text, 'refreshed');
    assert.equal(fixture.counters.refreshes, 1);
    assert.equal(opened, 1);
    assert.ok(!JSON.stringify(manager.snapshot()).includes('fixture-access'));
    assert.notEqual(credentialKey(server), credentialKey({ ...server, transport: { ...server.transport, url: fixture.url + '/other' } }));
    await oauth.logout(server);
    assert.equal(vault.size, 0);
    assert.equal((await manager.refresh('authorized', snapshot(3))).servers[0].health, 'auth_required');
  } finally { await manager.close(); await fixture.close(); }
});

test('cancelled OAuth closes its listener without saving a token', async () => {
  const fixture = await oauthServer();
  const vault = new Map();
  let callback;
  const oauth = new McpOAuthCoordinator({ read: async key => vault.get(key), write: async (key, value) => vault.set(key, value) }, async url => {
    callback = new URL(url).searchParams.get('redirect_uri');
    oauth.cancel('cancelled');
  });
  try {
    await assert.rejects(oauth.login({ id: 'cancelled', transport: { kind: 'streamable_http', url: fixture.url + '/mcp' } }), /cancelled/);
    assert.equal(fixture.counters.codes, 0);
    assert.ok([...vault.values()].every(value => !value.tokens));
    await assert.rejects(fetch(callback));
  } finally { oauth.close(); await fixture.close(); }
});

test('preset OAuth client, secret, fixed callback port, scopes and resource work for a required connection', async () => {
  const fixture = await oauthServer({ clientId: 'preset-client', clientSecret: 'fixture-only-secret', scopes: ['tools:read', 'tools:write'] });
  const listener = createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const variable = 'CARDBUSH_TEST_OAUTH_CLIENT_SECRET', previous = process.env[variable];
  process.env[variable] = 'fixture-only-secret';
  const { vault, store } = credentials();
  let opened = 0;
  const oauth = new McpOAuthCoordinator(store, async url => { opened++; assert.equal((await fetch(url)).status, 200); });
  const server = { id: 'preset', required: true, versionMode: 'legacy', transport: { kind: 'streamable_http', url: fixture.url + '/mcp',
    oauth: { clientId: 'preset-client', clientSecretEnv: variable, callbackPort: port, scopes: ['tools:read'], resourceUrl: fixture.url + '/mcp' } } };
  const registry = new ToolRegistry(), manager = new McpClientManager({ registry, oauth });
  try {
    assert.equal((await manager.apply(serverSnapshot(server))).servers[0].health, 'auth_required', 'a required connection can wait for sign-in without rolling back the snapshot');
    assert.equal(opened, 0);
    await oauth.login(server);
    assert.equal(fixture.observations.redirectUri, `http://127.0.0.1:${port}/callback`);
    assert.equal(fixture.observations.scope, 'tools:read');
    assert.equal(fixture.counters.registrations, 0, 'preset clients do not need dynamic registration');
    assert.equal((await manager.refresh(server.id, { ...serverSnapshot(server), revision: 2 })).servers[0].health, 'ready');
    const result = await registry.resolve('mcp__preset__echo').execute(toolContext('authorized'));
    assert.equal(result.content[0].text, 'authorized');
    assert.ok(vault.size > 0);
    assert.ok(!JSON.stringify(manager.snapshot()).includes('fixture-only-secret'));
  } finally {
    if (previous === undefined) delete process.env[variable]; else process.env[variable] = previous;
    await manager.close(); await fixture.close();
  }
});

test('public discovery is followed by scoped first-use consent, login and one replay on the existing connection', async () => {
  const fixture = await oauthServer({ publicDiscovery: true, resourceMetadataPath: '/.well-known/oauth-protected-resource/echo' });
  const { store } = credentials(); let opened = 0, prompts = 0, active = false;
  const oauth = new McpOAuthCoordinator(store, async url => { opened++; assert.equal((await fetch(url)).status, 200); });
  const registry = new ToolRegistry();
  const manager = new McpClientManager({ registry, oauth, canApply: () => !active,
    onAuthenticationRequired: async (request, signal) => {
      prompts++;
      assert.deepEqual(request, { serverId: 'first-use', sessionId: 'task-auth', turnId: 'turn-auth', toolCallId: 'call-auth' });
      assert.equal(signal.aborted, false);
      assert.equal(manager.snapshot().servers[0].health, 'auth_required');
      return true;
    } });
  const server = { id: 'first-use', versionMode: 'legacy', transport: { kind: 'streamable_http', url: fixture.url + '/mcp' } };
  try {
    assert.equal((await manager.apply(serverSnapshot(server))).servers[0].health, 'ready');
    assert.equal(opened, 0); assert.equal(prompts, 0);
    const handler = registry.resolve('mcp__first-use__echo');
    active = true;
    const result = await handler.execute(toolContext('original argument'));
    assert.equal(result.content[0].text, 'original argument');
    assert.equal(prompts, 1); assert.equal(opened, 1);
    assert.equal(fixture.counters.calls, 2);
    assert.deepEqual(fixture.observations.calls[0], fixture.observations.calls[1]);
    assert.equal(manager.snapshot().servers[0].health, 'ready');
    assert.equal(registry.resolve('mcp__first-use__echo'), handler, 'authentication does not replace the active tool registry');
    await handler.execute(toolContext('next call'));
    assert.equal(prompts, 1); assert.equal(opened, 1);
  } finally { await manager.close(); await fixture.close(); }
});

for (const action of ['no-bridge', 'decline', 'cancel']) test(`first-use authentication ${action} stops without browser navigation or replay`, async () => {
  const fixture = await oauthServer({ publicDiscovery: true });
  const { store } = credentials(); const abort = new AbortController(); let prompts = 0, opened = 0;
  const oauth = new McpOAuthCoordinator(store, async () => { opened++; });
  const registry = new ToolRegistry();
  const manager = new McpClientManager({ registry, oauth, ...(action === 'no-bridge' ? {} : { onAuthenticationRequired: async () => {
    prompts++; if (action === 'cancel') abort.abort(new DOMException('Task stopped', 'AbortError')); return false;
  } }) });
  try {
    await manager.apply(serverSnapshot({ id: 'stopped', versionMode: 'legacy', transport: { kind: 'streamable_http', url: fixture.url + '/mcp' } }));
    await assert.rejects(registry.resolve('mcp__stopped__echo').execute(toolContext('never authorized', abort.signal)),
      error => action === 'cancel' ? error.name === 'AbortError' : error.code === 'mcp_auth_required');
    assert.equal(manager.snapshot().servers[0].health, 'auth_required');
    assert.equal(opened, 0); assert.equal(prompts, action === 'no-bridge' ? 0 : 1); assert.equal(fixture.counters.calls, 1);
  } finally { await manager.close(); await fixture.close(); }
});

test('missing client setup is distinct from missing sign-in, including when discovery succeeds', async () => {
  for (const publicDiscovery of [false, true]) {
    const fixture = await oauthServer({ publicDiscovery });
    const { store } = credentials(); let opened = 0, prompts = 0;
    const oauth = new McpOAuthCoordinator(store, async () => { opened++; });
    const registry = new ToolRegistry(), manager = new McpClientManager({ registry, oauth, onAuthenticationRequired: async () => { prompts++; return true; } });
    const server = { id: 'unconfigured', required: true, versionMode: 'legacy', transport: { kind: 'streamable_http', url: fixture.url + '/mcp', oauth: { clientId: '<SERVICE_CLIENT_ID>' } } };
    try {
      const applied = await manager.apply(serverSnapshot(server));
      if (publicDiscovery) {
        assert.equal(applied.servers[0].health, 'ready');
        await assert.rejects(registry.resolve('mcp__unconfigured__echo').execute(toolContext('setup required')), { code: 'mcp_oauth_configuration_required' });
      }
      assert.equal(manager.snapshot().servers[0].health, 'configuration_required');
      await assert.rejects(oauth.login(server), { code: 'mcp_oauth_configuration_required' });
      assert.equal(opened, 0); assert.equal(prompts, 0);
    } finally { await manager.close(); await fixture.close(); }
  }
});

test('manual login failure updates a publicly discoverable service and cannot change a replacement connection', async () => {
  const fixture = await oauthServer({ publicDiscovery: true }); const { store } = credentials(); let opened = 0;
  const oauth = new McpOAuthCoordinator(store, async () => { opened++; });
  const manager = new McpClientManager({ registry: new ToolRegistry(), oauth });
  const server = { id: 'manual', versionMode: 'legacy', transport: { kind: 'streamable_http', url: fixture.url + '/mcp', oauth: { clientId: '<CLIENT_ID>' } } };
  try {
    assert.equal((await manager.apply(serverSnapshot(server))).servers[0].health, 'ready');
    await assert.rejects(manager.login(server), { code: 'mcp_oauth_configuration_required' });
    assert.equal(manager.snapshot().servers[0].health, 'configuration_required');
    assert.equal(opened, 0);
    const replacement = { ...server, transport: { ...server.transport, oauth: {} } };
    assert.equal((await manager.apply({ ...serverSnapshot(replacement), revision: 2 })).servers[0].health, 'ready');
    await assert.rejects(manager.login(server), { code: 'mcp_oauth_configuration_required' });
    assert.equal(manager.snapshot().servers[0].health, 'ready', 'a failure from the previous OAuth config is stale');
  } finally { await manager.close(); await fixture.close(); }
});

test('existing providers see credentials saved during login and cleared during logout', async () => {
  const fixture = await oauthServer(); const { store } = credentials();
  const oauth = new McpOAuthCoordinator(store, async url => { assert.equal((await fetch(url)).status, 200); });
  const server = { id: 'shared-vault', transport: { kind: 'streamable_http', url: fixture.url + '/mcp' } };
  try {
    assert.equal(credentialKey({ ...server, transport: { ...server.transport, oauth: { scopes: ['read'], clientId: 'preset' } } }),
      credentialKey({ ...server, transport: { ...server.transport, oauth: { clientId: 'preset', scopes: ['read'] } } }), 'configuration key ordering cannot split a connection into different credential stores');
    const original = oauth.provider(server);
    assert.equal(await original.tokens(), undefined);
    await oauth.login(server);
    assert.equal((await original.tokens()).access_token, 'fixture-access-1');
    await oauth.logout(server);
    assert.equal(await original.tokens(), undefined);
  } finally { oauth.close(); await fixture.close(); }
});

test('concurrent tool calls share one sign-in and a second task can cancel its wait independently', async () => {
  const fixture = await oauthServer({ publicDiscovery: true }); const { store } = credentials();
  const consent = Promise.withResolvers(), prompted = Promise.withResolvers(); let prompts = 0, opened = 0;
  const oauth = new McpOAuthCoordinator(store, async url => { opened++; assert.equal((await fetch(url)).status, 200); });
  const registry = new ToolRegistry(), manager = new McpClientManager({ registry, oauth,
    onAuthenticationRequired: async () => { prompts++; prompted.resolve(); return consent.promise; } });
  try {
    await manager.apply(serverSnapshot({ id: 'shared', versionMode: 'legacy', transport: { kind: 'streamable_http', url: fixture.url + '/mcp' } }));
    const tool = registry.resolve('mcp__shared__echo');
    const first = tool.execute(toolContext('first'));
    await prompted.promise;
    const secondAbort = new AbortController();
    const second = tool.execute(toolContext('cancelled', secondAbort.signal, 'second'));
    const rejected = assert.rejects(second, { name: 'AbortError' });
    secondAbort.abort(); await rejected;
    const third = tool.execute(toolContext('third', undefined, 'third'));
    consent.resolve(true);
    assert.deepEqual((await Promise.all([first, third])).map(result => result.content[0].text), ['first', 'third']);
    assert.equal(prompts, 1); assert.equal(opened, 1); assert.equal(fixture.counters.calls, 3);
  } finally { consent.resolve(false); await manager.close(); await fixture.close(); }
});

test('resource and callback configuration errors fail before opening a browser, and do not leave a login active', async () => {
  const fixture = await oauthServer(); const { store } = credentials(); let opened = 0;
  const oauth = new McpOAuthCoordinator(store, async url => { opened++; assert.equal((await fetch(url)).status, 200); });
  const server = { id: 'configuration', transport: { kind: 'streamable_http', url: fixture.url + '/mcp' } };
  try {
    for (const options of [{ resourceUrl: 'https://other.example/mcp' }, { callbackUrl: 'https://other.example/callback' }, { clientSecretEnv: 'CARDBUSH_TEST_MISSING_SECRET' }]) {
      await assert.rejects(oauth.login({ ...server, transport: { ...server.transport, oauth: options } }), { code: 'mcp_oauth_configuration_required' });
    }
    assert.equal(opened, 0);
    await oauth.login(server);
    assert.equal(opened, 1);
  } finally { oauth.close(); await fixture.close(); }
});

for (const failure of ['second-auth-rejection', 'server-error']) test(`${failure} never starts an authorization retry loop`, async () => {
  const fixture = await oauthServer({ publicDiscovery: true, ...(failure === 'server-error' ? { callStatus: 500 } : { rejectCalls: true }) });
  const { store } = credentials(); let prompts = 0, opened = 0;
  const oauth = new McpOAuthCoordinator(store, async url => { opened++; assert.equal((await fetch(url)).status, 200); });
  const registry = new ToolRegistry(), manager = new McpClientManager({ registry, oauth, onAuthenticationRequired: async () => { prompts++; return true; } });
  try {
    await manager.apply(serverSnapshot({ id: 'failing', versionMode: 'legacy', transport: { kind: 'streamable_http', url: fixture.url + '/mcp' } }));
    await assert.rejects(registry.resolve('mcp__failing__echo').execute(toolContext('no loop')));
    assert.equal(prompts, failure === 'server-error' ? 0 : 1); assert.equal(opened, prompts);
    if (failure === 'server-error') assert.equal(fixture.counters.calls, 1);
    else { assert.ok(fixture.counters.calls <= 3); assert.equal(manager.snapshot().servers[0].health, 'auth_required'); }
  } finally { await manager.close(); await fixture.close(); }
});
