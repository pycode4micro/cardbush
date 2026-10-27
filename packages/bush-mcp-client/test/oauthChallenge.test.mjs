import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolRegistry } from '@cardbush/bush-runtime';
import { McpClientManager, McpOAuthCoordinator } from '../dist/index.js';
import { oauthServer } from './fixtures/oauthServer.mjs';

function credentials() {
  const values = new Map();
  return { read: async key => structuredClone(values.get(key)), write: async (key, value) => {
    if (value) values.set(key, structuredClone(value)); else values.delete(key);
  } };
}

test('an interactive step-up keeps the server challenge and obtains consent instead of refreshing an insufficient token', async t => {
  const fixture = await oauthServer({ challengeScope: 'tools:read', callScope: 'tools:write',
    resourceMetadataPath: '/.well-known/oauth-protected-resource/custom' });
  t.after(() => fixture.close());
  const registry = new ToolRegistry(), consents = [], scopes = [];
  const oauth = new McpOAuthCoordinator(credentials(), async link => {
    scopes.push(new URL(link).searchParams.get('scope'));
    assert.equal((await fetch(link)).status, 200);
  });
  const manager = new McpClientManager({ registry, oauth, onAuthenticationRequired: async request => { consents.push(request); return true; } });
  t.after(() => manager.close());
  const server = { id: 'scope', versionMode: 'legacy', transport: { kind: 'streamable_http', url: fixture.url + '/mcp' } };
  const snapshot = revision => ({ protocol: 'bush.mcp_snapshot.v2', snapshotId: 'scope', revision, servers: [server] });
  assert.equal((await manager.apply(snapshot(1))).servers[0].health, 'auth_required');
  assert.equal(scopes.length, 0, 'background discovery must not authorize');
  await manager.login(server);
  assert.equal((await manager.refresh(server.id, snapshot(2))).servers[0].health, 'ready');
  const tool = registry.resolve('mcp__scope__echo');
  const result = await tool.execute({ input: { value: 'delivered' }, signal: AbortSignal.timeout(5000),
    sessionId: 'session', turnId: 'turn', requestId: 'request', toolCall: { id: 'call' },
    turn: { request: { metadata: {} } },
  });
  assert.equal(result.content[0].text, 'delivered');
  assert.deepEqual(scopes.map(scope => scope.split(' ').sort()), [['tools:read'], ['tools:read', 'tools:write']]);
  assert.equal(consents.length, 1, 'scope escalation is still explicitly approved');
  assert.equal(fixture.counters.refreshes, 0, 'a refresh cannot grant the missing scope');
  assert.equal(fixture.counters.calls, 2, 'one rejected request and one authorized retry');
  assert.equal(consents[0].toolCallId, 'call');
});

test('challenge state is isolated by endpoint/configuration and ignores token endpoint challenges', async t => {
  const fixture = await oauthServer();
  t.after(() => fixture.close());
  const observed = [];
  const oauth = new McpOAuthCoordinator(credentials(), async link => {
    observed.push(new URL(link).searchParams.get('scope'));
    await fetch(link);
  });
  t.after(() => oauth.close());
  const server = { id: 'one', transport: { kind: 'streamable_http', url: fixture.url + '/mcp' } };
  const otherConfig = { ...server, transport: { ...server.transport, oauth: { clientId: 'different-client' } } };
  const response = () => new Response('', { status: 401, headers: { 'WWW-Authenticate': 'Bearer scope="tools:admin"' } });
  await oauth.fetchForTransport(otherConfig, async () => response())(otherConfig.transport.url);
  await oauth.fetchForTransport(server, async () => response())(fixture.url + '/token');
  await oauth.login(server);
  assert.deepEqual(observed, ['tools:read'], 'unrelated challenges cannot influence sign-in scope');
  await oauth.fetchForTransport(server, async () => response())(server.transport.url);
  await oauth.logout(server);
  await oauth.login(server);
  assert.deepEqual(observed, ['tools:read', 'tools:read'], 'sign-out removes deferred challenges');
});
