const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { resolve, join, sep } = require('node:path');
const { tmpdir } = require('node:os');
const electron = require('electron');

const parent = resolve(tmpdir());
if (typeof electron === 'string') {
  const root = mkdtempSync(join(parent, 'mcp-management-worker-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = require('node:child_process').spawnSync(electron, [__filename, root], {
    env, stdio: 'inherit', windowsHide: true, timeout: 50_000,
  });
  assert.ok(root.startsWith(parent + sep));
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (child.error) console.error(child.error);
  process.exit(child.status ?? 1);
}
const { app } = electron;
const root = resolve(process.argv[2]);
assert.ok(root.startsWith(parent + sep + 'mcp-management-worker-'));
const userData = join(root, 'electron-data');
mkdirSync(userData);
app.setPath('userData', userData);
const deadline = setTimeout(() => { console.error('MCP management worker test timed out'); app.exit(1); }, 45_000);

void run().then(() => app.exit(0), error => { console.error(error); app.exit(1); });

async function run() {
  const { Client, StreamableHTTPClientTransport } = await import('@modelcontextprotocol/client');
  const { RuntimeUtilityProcessController } = await import('../dist-electron/runtimeHostController.mjs');
  const { ElectronProductHostController } = await import('../dist-electron/productHostController.mjs');
  const { startProductMcpManagement } = await import('../dist-electron/productMcpManagement.mjs');
  await app.whenReady();
  let host;
  const endpoint = await startProductMcpManagement(() => host);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('CARDBUSH_')));
  const appsConfig = join(root, 'apps.json');
  writeFileSync(appsConfig, JSON.stringify({ protocol: 'cardbush.apps_config.v1', revision: 1, serviceEnabled: false, plugins: [] }));
  const controller = new RuntimeUtilityProcessController({
    modulePath: resolve('dist-electron/runtimeHostWorker.mjs'),
    env: { ...env,
      CARDBUSH_RUNTIME_STATE_ROOT: join(root, 'runtime'),
      CARDBUSH_APPS_CONFIG_PATH: appsConfig,
      CARDBUSH_RUNTIME_SKILL_ROOTS: '[]', CARDBUSH_RUNTIME_PLUGIN_ROOTS: '[]',
      CARDBUSH_MCP_MANAGEMENT_URL: endpoint.url, CARDBUSH_MCP_MANAGEMENT_TOKEN: endpoint.token,
    },
  });
  host = new ElectronProductHostController({
    dataRoot: join(root, 'product'), runtimeStateRoot: join(root, 'runtime'),
    bundledSkillRoot: join(root, 'skills'), userSkillRoot: join(root, 'user-skills'),
    bundledPluginRoot: join(root, 'plugins'), userPluginRoot: join(root, 'user-plugins'), runtimeBridge: controller,
  });
  const client = new Client({ name: 'worker-management-test', version: '1.0.0' });
  let observation = 0;
  const observe = async () => {
    const response = await controller.command({ protocol: 'bush.runtime_ipc.v1', type: 'command', operationId: `observe-${++observation}`,
      command: { kind: 'runtime.get_mcp_snapshot', payload: {} } });
    assert.equal(response.ok, true); return response.result;
  };
  const applied = async () => {
    for (let i = 0; i < 200; i++) {
      const current = await observe();
      if (current.applicationState === 'applied') return current;
      assert.notEqual(current.applicationState, 'failed', current.applicationError);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail('background MCP update did not finish');
  };
  const gate = join(root, 'allow-connect');
  try {
    await controller.start();
    const initial = await host.refreshMcp();
    assert.equal(initial.applicationState, 'pending');
    assert.equal(initial.configurationRevision, 1);
    assert.deepEqual(initial.servers.map(s => s.id), ['cardbush_management'], 'management remains available when Apps plugins are disabled');
    await applied();
    await client.connect(new StreamableHTTPClientTransport(new URL(endpoint.url), {
      requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } },
    }));
    const fixture = join(root, 'echo.mjs');
    writeFileSync(fixture, `
      import { existsSync } from 'node:fs';
      import { createRequire } from 'node:module';
      const require = createRequire(${JSON.stringify(resolve('package.json'))});
      const { McpServer } = require('@modelcontextprotocol/server');
      const { serveStdio } = require('@modelcontextprotocol/server/stdio');
      while (!existsSync(${JSON.stringify(gate)})) await new Promise(resolve => setTimeout(resolve, 25));
      await serveStdio(() => {
        const server = new McpServer({ name: 'worker-echo', version: '1.0.0' });
        server.registerTool('echo', { inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'worker connected' }] }));
        return server;
      });
    `);
    const added = await client.callTool({ name: 'configure_mcp_server', arguments: {
      id: 'worker_echo', transport: 'stdio', command: process.execPath, args: [fixture], env: { ELECTRON_RUN_AS_NODE: '1' },
    } });
    assert.notEqual(added.isError, true, JSON.stringify(added));
    const status = JSON.parse(added.content[0].text);
    assert.equal(status.saved, true);
    assert.equal(status.runtime.applicationState, 'pending', 'configuration returns while the stdio child is deliberately blocked');
    assert.equal(status.runtime.configurationRevision, 2);
    const reconnected = await controller.command({ protocol: 'bush.runtime_ipc.v1', type: 'command', operationId: 'reconnect-existing',
      command: { kind: 'runtime.mcp_reconnect', payload: { serverId: 'cardbush_management' } } });
    assert.equal(reconnected.ok, true, 'another connection request is accepted before the blocked child is released');
    assert.equal(reconnected.result.applicationState, 'pending');
    writeFileSync(gate, 'ready');
    const settled = await applied();
    const observed = await controller.command({ protocol: 'bush.runtime_ipc.v1', type: 'command', operationId: 'observe-mcp',
      command: { kind: 'runtime.get_mcp_snapshot', payload: {} } });
    assert.equal(observed.ok, true);
    assert.equal(observed.result.configurationRevision, 2);
    assert.equal(observed.result.revision, settled.revision, 'read-only observation preserves runtime revision');
    assert.equal(settled.servers.find(s => s.id === 'worker_echo').tools[0].runtimeName, 'mcp__worker_echo__echo');
    const catalog = await controller.command({ protocol: 'bush.runtime_ipc.v1', type: 'command', operationId: 'catalog',
      command: { kind: 'runtime.get_tool_catalog', payload: {} } });
    assert.equal(catalog.ok, true, JSON.stringify(catalog));
    assert.ok(catalog.result.some(tool => tool.name === 'mcp__worker_echo__echo'));
    assert.ok(catalog.result.some(tool => tool.name === 'mcp__cardbush_management__configure_mcp_server'));
    console.log('Real Electron worker passed: management MCP -> Product Host -> persistent config -> Runtime worker -> discovered stdio tool.');
  } finally {
    writeFileSync(gate, 'ready');
    clearTimeout(deadline);
    await client.close();
    await host.shutdown();
    controller.stop();
    await endpoint.close();
    assert.ok(root.startsWith(parent + sep));
    // The Node parent removes this isolated directory after Electron releases it.
  }
}
