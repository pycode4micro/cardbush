// Driver for the pinned, official MCP client scenarios. The manager, transport,
// tool registry and OAuth flow are CardBush's production implementations.
import assert from 'node:assert/strict';
import { ToolRegistry } from '@cardbush/bush-runtime';
import { mcpServerSnapshotSchema } from '@cardbush/bush-protocol';
import { McpClientManager, McpOAuthCoordinator } from '@cardbush/bush-mcp-client';

const scenario = process.env.MCP_CONFORMANCE_SCENARIO;
const endpoint = process.argv[2];
function loopback(value) {
  const url = new URL(value);
  assert.equal(url.protocol, 'http:', 'Conformance traffic must use local HTTP fixtures.');
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Conformance cannot access external services.');
  assert.ok(!url.username && !url.password);
  return url;
}
loopback(endpoint);
assert.ok(scenario, 'MCP_CONFORMANCE_SCENARIO is required.');
const deadline = AbortSignal.timeout(25_000);
// Independent deadline ensures the official runner's shell timeout cannot leave
// a client with a live OAuth listener behind on Windows.
const watchdog = setTimeout(() => process.exit(2), 28_000);
watchdog.unref();
async function localFetch(input, init = {}) {
  const url = loopback(input instanceof Request ? input.url : input);
  const signal = AbortSignal.any([deadline, ...(init.signal ? [init.signal] : [])]);
  return fetch(url, { ...init, redirect: 'error', signal });
}

const vault = new Map();
const store = {
  read: async key => structuredClone(vault.get(key)),
  write: async (key, value) => { if (value) vault.set(key, structuredClone(value)); else vault.delete(key); },
};
const oauthOptions = scenario === 'auth/basic-cimd'
  ? { clientMetadataUrl: 'https://conformance-test.local/client-metadata.json' } : {};
if (scenario === 'auth/pre-registration') {
  const context = JSON.parse(process.env.MCP_CONFORMANCE_CONTEXT ?? '{}');
  assert.equal(context.name, scenario);
  assert.equal(typeof context.client_id, 'string');
  assert.equal(typeof context.client_secret, 'string');
  // The harness owns both endpoints and supplies the credentials. Resolve its
  // local issuer solely to configure CardBush's existing trusted-issuer setting.
  const metadata = await (await localFetch(new URL('/.well-known/oauth-protected-resource/mcp', endpoint))).json();
  const issuer = loopback(metadata.authorization_servers[0]).href.replace(/\/$/, '');
  const ref = 'c'.repeat(64);
  await store.write(ref, { clientSecret: { value: context.client_secret, clientId: context.client_id, url: endpoint } });
  Object.assign(oauthOptions, { clientId: context.client_id, clientSecretRef: ref, expectedIssuer: issuer });
}
const server = mcpServerSnapshotSchema.parse({
  id: 'conformance', transport: { kind: 'streamable_http', url: endpoint, oauth: oauthOptions },
  // Use the product's default negotiation, including fallback to released MCP.
  startupTimeoutMs: 10_000, toolTimeoutMs: 12_000,
  defaultToolPolicy: { permission: 'allow' },
});
const oauth = new McpOAuthCoordinator(store, async authorizationUrl => {
  // Simulate the human accepting only the official local authorization page.
  // The returned code still goes through the real loopback callback/state check.
  const response = await fetch(loopback(authorizationUrl), { redirect: 'manual', signal: deadline });
  assert.ok(response.status >= 300 && response.status < 400, 'Fixture must redirect to the OAuth callback.');
  const callback = loopback(new URL(response.headers.get('location'), authorizationUrl));
  assert.equal((await localFetch(callback)).status, 200);
}, () => localFetch);
const registry = new ToolRegistry();
const manager = new McpClientManager({
  registry, oauth, network: async () => ({ fetch: localFetch, env: {} }),
  onAuthenticationRequired: async () => true,
  onElicitation: async () => ({ action: 'accept', content: {} }),
});
let revision = 0;
const snapshot = () => ({ protocol: 'bush.mcp_snapshot.v2', snapshotId: 'conformance', revision: ++revision, servers: [server] });
try {
  let state = await manager.apply(snapshot());
  if (state.servers[0]?.health === 'auth_required') {
    await manager.login(server, deadline);
    state = await manager.refresh(server.id, snapshot());
  }
  if (scenario === 'auth/scope-retry-limit') {
    // This official scenario always rejects the token. Requiring the specific
    // bounded auth state prevents an arbitrary driver crash being called a pass.
    assert.equal(state.servers[0]?.health, 'auth_required');
  } else assert.equal(state.servers[0]?.health, 'ready', state.servers[0]?.lastError ?? JSON.stringify(state));
  const name = scenario === 'tools_call' ? 'add_numbers'
    : scenario === 'sse-retry' ? 'test_reconnection'
      : scenario === 'elicitation-sep1034-client-defaults' ? 'test_client_elicitation_defaults'
        : scenario.startsWith('auth/') && scenario !== 'auth/scope-retry-limit' ? 'test-tool' : undefined;
  if (name) {
    const hook = registry.mcpHook(server.id, name);
    assert.ok(hook, `Missing official fixture tool: ${name}`);
    const tool = registry.definitions().map(item => registry.resolve(item.name))
      .find(item => item.mcpHook?.server === server.id && item.mcpHook?.tool === name);
    assert.ok(tool, `Missing product registration: ${name}`);
    const input = tool.decodeInput(name === 'add_numbers' ? { a: 2, b: 3 } : {});
    const result = await tool.execute({ input, signal: deadline,
      requestId: 'conformance-request', sessionId: 'conformance-session', turnId: 'conformance-turn',
      toolCall: { protocol: 'bush.tool_call.v1', id: 'conformance-call', name: tool.definition.name, argumentsText: JSON.stringify(input) },
      turn: { request: { metadata: {} }, contextMessages: [] },
    });
    assert.notEqual(result.isError, true, 'The official fixture tool returned an error.');
    if (name === 'add_numbers') assert.match(result.content[0].text, /is 5$/);
  }
  console.log(JSON.stringify({ scenario, completed: true, ...(scenario === 'auth/scope-retry-limit' ? { expectedRejection: true } : {}) }));
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await manager.close();
  oauth.close();
  clearTimeout(watchdog);
}
