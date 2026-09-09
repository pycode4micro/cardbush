// Public preflight only: no user credentials, browser navigation or remote writes.
import assert from 'node:assert/strict';
import { mcpOAuthFromConfig } from '@cardbush/bush-protocol';
import { McpClientManager, McpOAuthCoordinator } from '@cardbush/bush-mcp-client';
import { ToolRegistry } from '@cardbush/bush-runtime';

const revision = 'd416fd5a43426019986b1e489506db3db66dee3d';
const report = { checkedAt: new Date().toISOString(), repository: 'openai/plugins', revision, authenticatedAccountTest: false, services: [] };
for (const name of ['linear', 'gmail']) {
  const response = await fetch(`https://raw.githubusercontent.com/openai/plugins/${revision}/plugins/${name}/.mcp.json`, { signal: AbortSignal.timeout(20_000) });
  assert.equal(response.status, 200, `official ${name} package`);
  const declaration = (await response.json()).mcpServers[name];
  const oauthConfig = mcpOAuthFromConfig({ scopes: declaration.scopes, oauth_resource: declaration.oauth_resource }, declaration.oauth);
  const server = { id: name, versionMode: 'legacy', transport: { kind: 'streamable_http', url: declaration.url, oauth: oauthConfig } };
  const registry = new ToolRegistry(), vault = new Map();
  const oauth = new McpOAuthCoordinator({ read: async key => vault.get(key), write: async (key, value) => { vault.set(key, value); } },
    async () => { throw new Error('Public preflight must not open an authorization URL.'); });
  const manager = new McpClientManager({ registry, oauth });
  const result = { name, endpoint: declaration.url, configuration: {
    scopeCount: oauthConfig.scopes?.length ?? 0, resource: oauthConfig.resourceUrl,
    callbackPort: oauthConfig.callbackPort, clientIdPlaceholder: /^<[^<>]+>$/.test(oauthConfig.clientId ?? ''),
  } };
  try {
    const initial = await manager.apply({ protocol: 'bush.mcp_snapshot.v2', snapshotId: 'public-preflight', revision: 1, servers: [server] });
    result.discovery = { health: initial.servers[0].health, toolCount: initial.servers[0].tools.length };
    if (name === 'gmail') {
      const tool = registry.resolve('mcp__gmail__list_labels');
      assert.ok(tool, 'the official Gmail service exposes list_labels during public discovery');
      const abort = AbortSignal.timeout(20_000);
      await assert.rejects(tool.execute({ requestId: 'public-preflight', sessionId: 'public-preflight', turnId: name,
        toolCall: { id: 'preflight-labels' }, input: {}, signal: abort, turn: { request: { metadata: {} }, contextMessages: [] } }),
      { code: 'mcp_oauth_configuration_required' });
      result.call = { tool: 'list_labels', health: manager.snapshot().servers[0].health, authenticated: false };
      const challenge = await fetch(declaration.url, { method: 'POST', signal: AbortSignal.timeout(20_000),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_labels', arguments: {} } }) });
      assert.equal(challenge.status, 401);
      const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge.headers.get('www-authenticate') ?? '')?.[1];
      assert.ok(metadataUrl); assert.equal(new URL(metadataUrl).origin, new URL(declaration.url).origin);
      await challenge.body?.cancel();
      const metadata = await fetch(metadataUrl, { signal: AbortSignal.timeout(20_000) });
      assert.equal(metadata.status, 200);
      const body = await metadata.json();
      result.challenge = { status: 401, metadataUrl, resource: body.resource, authorizationServers: body.authorization_servers };
    } else {
      assert.equal(result.discovery.health, 'auth_required');
      const metadata = await fetch(new URL('/.well-known/oauth-authorization-server', declaration.url), { signal: AbortSignal.timeout(20_000) });
      assert.equal(metadata.status, 200);
      const body = await metadata.json();
      result.authorization = { issuer: body.issuer, dynamicClientRegistration: Boolean(body.registration_endpoint), pkceS256: body.code_challenge_methods_supported.includes('S256') };
    }
    assert.ok([...vault.values()].every(value => !value?.tokens), 'no account credentials may be obtained in a public preflight');
    report.services.push(result);
  } finally { await manager.close(); }
}
console.log(JSON.stringify(report, null, 2));
