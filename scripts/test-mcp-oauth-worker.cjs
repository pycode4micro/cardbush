const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { resolve, join, sep } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const electron = require('electron');

const parent = resolve(tmpdir());
if (typeof electron === 'string') {
  const root = mkdtempSync(join(parent, 'cardbush-oauth-worker-'));
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawnSync(electron, [__filename, root], { env, stdio: 'inherit', windowsHide: true, timeout: 55_000 });
  assert.ok(root.startsWith(parent + sep + 'cardbush-oauth-worker-'));
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (child.error) console.error(child.error);
  process.exit(child.status ?? 1);
}
const { app, safeStorage } = electron;
const root = resolve(process.argv[2]);
assert.ok(root.startsWith(parent + sep + 'cardbush-oauth-worker-'));
const userData = join(root, 'electron-data'); mkdirSync(userData); app.setPath('userData', userData);
const deadline = setTimeout(() => { console.error('MCP OAuth worker test timed out'); app.exit(1); }, 50_000);
void run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });

async function run() {
  await app.whenReady();
  assert.equal(safeStorage.isEncryptionAvailable(), true, 'OS credential encryption is required for this integration test');
  const { RuntimeUtilityProcessController } = await import('../dist-electron/runtimeHostController.mjs');
  const { McpDesktopHost } = await import('../dist-electron/mcpDesktopHost.js');
  const { oauthServer } = await import('../packages/bush-mcp-client/test/fixtures/oauthServer.mjs');
  const fixture = await oauthServer();
  const publicFixture = await oauthServer({ publicDiscovery: true, resourceMetadataPath: '/.well-known/oauth-protected-resource/echo' });
  const modelRequests = [];
  const modelServer = require('node:http').createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (request.url.endsWith('/input_tokens')) { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ input_tokens: 20 })); return; }
    modelRequests.push(body);
    const completed = modelRequests.length > 1;
    const item = { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'mcp__public__echo', arguments: '{"value":"worker-resumed"}', status: 'completed' };
    const result = { id: `resp_${modelRequests.length}`, object: 'response', model: 'fixture', created_at: 1, status: 'completed', store: false,
      output: completed ? [{ type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Verified.', annotations: [] }] }] : [item] };
    const events = [{ type: 'response.created', response: { ...result, status: 'in_progress', output: [] } },
      ...(completed ? [{ type: 'response.output_text.delta', item_id: 'msg_fixture', output_index: 0, content_index: 0, delta: 'Verified.' }]
        : [{ type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', status: 'in_progress' } },
          { type: 'response.function_call_arguments.delta', output_index: 0, item_id: item.id, delta: item.arguments },
          { type: 'response.function_call_arguments.done', output_index: 0, item_id: item.id, name: item.name, arguments: item.arguments }]),
      { type: 'response.completed', response: result }];
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const [sequence_number, event] of events.entries()) response.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`);
    response.end();
  });
  await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
  const vault = join(root, 'mcp-oauth.bin'); let opened = 0;
  const consents = [];
  const desktop = new McpDesktopHost({ path: vault,
    encrypt: text => safeStorage.encryptString(text), decrypt: bytes => safeStorage.decryptString(bytes), changed: () => {},
    openUrl: async url => { opened++; assert.equal((await fetch(url)).status, 200); },
  });
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CARDBUSH_')));
  const appsConfig = join(root, 'apps.json');
  writeFileSync(appsConfig, JSON.stringify({ protocol: 'cardbush.apps_config.v1', revision: 1, serviceEnabled: false, plugins: [] }));
  const controller = new RuntimeUtilityProcessController({ modulePath: resolve('dist-electron/runtimeHostWorker.mjs'),
    env: { ...env, CARDBUSH_RUNTIME_STATE_ROOT: join(root, 'runtime'), CARDBUSH_APPS_CONFIG_PATH: appsConfig,
      CARDBUSH_RUNTIME_SKILL_ROOTS: '[]', CARDBUSH_RUNTIME_PLUGIN_ROOTS: '[]', CARDBUSH_MCP_DESKTOP_BRIDGE: '1' },
    onMcpHostRequest: (operation, payload, signal) => {
      if (operation === 'network.configuration') return Promise.resolve({ default: { mode: 'none', httpProxy: '', httpsProxy: '', noProxy: '' }, plugins: {} });
      if (operation === 'network.route') return Promise.resolve('');
      const pending = desktop.handle(operation, payload, signal);
      if (operation === 'authentication') {
        consents.push(payload);
        const request = desktop.requests().find(item => item.params.mode === 'authentication');
        assert.ok(request); void desktop.answer(request.id, { action: 'accept' });
      }
      return pending;
    },
  });
  const command = async (kind, payload = {}) => {
    const response = await controller.command({ protocol: 'bush.runtime_ipc.v1', type: 'command', operationId: randomUUID(), command: { kind, payload } });
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.ok(!JSON.stringify(response).includes('fixture-access'), 'runtime public responses never carry credentials');
    let result = response.result;
    const until = Date.now() + 8000;
    while (result?.applicationState === 'pending') {
      assert.ok(Date.now() < until, 'MCP connection should settle');
      await new Promise(resolve => setTimeout(resolve, 20));
      const state = await controller.command({ protocol: 'bush.runtime_ipc.v1', type: 'command', operationId: randomUUID(), command: { kind: 'runtime.get_mcp_snapshot', payload: {} } });
      assert.equal(state.ok, true, JSON.stringify(state)); result = state.result;
    }
    return result;
  };
  const apply = () => command('runtime.apply_mcp_snapshot', { protocol: 'bush.mcp_snapshot.v2', snapshotId: 'oauth-worker', revision: 1,
    servers: [{ id: 'fixture', versionMode: 'legacy', transport: { kind: 'streamable_http', url: fixture.url + '/mcp' } }] });
  try {
    assert.equal((await apply()).servers[0].health, 'auth_required');
    assert.equal(opened, 0, 'tool discovery does not open a login window');
    const signedIn = await command('runtime.mcp_login', { serverId: 'fixture' });
    assert.equal(signedIn.servers[0].health, 'ready', signedIn.servers[0].lastError);
    assert.equal(opened, 1);
    assert.ok(!readFileSync(vault).includes(Buffer.from('fixture-access')));
    assert.ok(safeStorage.decryptString(readFileSync(vault)).includes('fixture-refresh'));
    assert.ok((await command('runtime.get_tool_catalog')).some(tool => tool.name === 'mcp__fixture__echo'));
    controller.stop();
    assert.equal((await apply()).servers[0].health, 'ready', 'a new worker restores tokens only through the encrypted desktop vault');
    assert.equal(opened, 1, 'persisted sign-in does not reopen the browser');
    assert.equal((await command('runtime.mcp_logout', { serverId: 'fixture' })).servers[0].health, 'auth_required');
    assert.ok(!safeStorage.decryptString(readFileSync(vault)).includes('fixture-refresh'));
    assert.equal((await command('runtime.get_tool_catalog')).some(tool => tool.name === 'mcp__fixture__echo'), false);
    assert.equal((await command('runtime.apply_mcp_snapshot', { protocol: 'bush.mcp_snapshot.v2', snapshotId: 'public-worker', revision: 1,
      servers: [{ id: 'public', versionMode: 'legacy', transport: { kind: 'streamable_http', url: publicFixture.url + '/mcp' } }] })).servers[0].health, 'ready');
    const binding = await command('runtime.upsert_provider_binding', { protocol: 'bush.provider_binding_config.v1', bindingId: 'fixture-model',
      adapter: 'openai_responses', apiKey: 'fixture-local-only', baseURL: `http://127.0.0.1:${modelServer.address().port}/v1`, timeoutMs: 5000 });
    const tools = (await command('runtime.get_tool_catalog')).filter(tool => tool.name === 'mcp__public__echo');
    const terminal = await command('runtime.run_model_turn', { protocol: 'bush.model_request.v1', requestId: 'request-first-use', sessionId: 'session-first-use',
      turnId: 'turn-first-use', model: 'fixture', providerBinding: binding.binding, permissionMode: 'all_free',
      messages: [{ role: 'user', content: 'Call the fixture tool.' }], tools });
    assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal));
    assert.deepEqual(consents, [{ serverId: 'public', sessionId: 'session-first-use', turnId: 'turn-first-use', toolCallId: 'call_fixture' }],
      JSON.stringify({ calls: publicFixture.counters.calls, result: modelRequests[1]?.input?.filter(item => item.type === 'function_call_output') }));
    assert.equal(modelRequests.length, 2, 'login resumes the pending tool without another model decision');
    assert.ok(JSON.stringify(modelRequests[1].input).includes('worker-resumed'));
    assert.equal(publicFixture.counters.calls, 2); assert.equal(opened, 2); assert.equal(desktop.requests().length, 0);
    assert.equal((await command('runtime.get_mcp_snapshot')).servers[0].health, 'ready');
    assert.equal((await command('runtime.apply_mcp_snapshot', { protocol: 'bush.mcp_snapshot.v2', snapshotId: 'unconfigured-worker', revision: 1,
      servers: [{ id: 'unconfigured', versionMode: 'legacy', transport: { kind: 'streamable_http', url: publicFixture.url + '/mcp', oauth: { clientId: '<CLIENT_ID>' } } }] })).servers[0].health, 'ready');
    const failedLogin = await controller.command({ protocol: 'bush.runtime_ipc.v1', type: 'command', operationId: randomUUID(),
      command: { kind: 'runtime.mcp_login', payload: { serverId: 'unconfigured' } } });
    assert.equal(failedLogin.ok, false);
    assert.equal((await command('runtime.get_mcp_snapshot')).servers[0].health, 'configuration_required', 'manual login failure updates the actual runtime state');
    assert.equal(opened, 2, 'an unconfigured client cannot start browser authorization');
    console.log('Real Electron OAuth bridge passed: discovery, login, encrypted vault, worker restore, logout, first-use consent/resumption and manual login failure state.');
  } finally {
    controller.stop(); await fixture.close(); await publicFixture.close();
    await new Promise(resolve => { modelServer.close(resolve); modelServer.closeAllConnections(); }); clearTimeout(deadline);
  }
}
