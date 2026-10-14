import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { ProductMcpConfigStore } from '@cardbush/product-host';
import { ToolRegistry } from '@cardbush/bush-runtime';
import { McpClientManager } from '@cardbush/bush-mcp-client';
import { ElectronProductHostController } from '../dist-electron/productHostController.mjs';
import { startProductMcpManagement, mergeMcpServer } from '../dist-electron/productMcpManagement.mjs';
import { mcpManagementView } from '../dist-electron/productMcpManagementView.mjs';

test('compact MCP observations retain failures, pending state and unavailable-runtime distinctions', () => {
  const tools = Array.from({ length: 400 }, (_, i) => ({ remoteName: `tool_${i}`, runtimeName: `mcp__other__tool_${i}` }));
  const source = { configuration: { revision: 9, servers: [{ id: 'broken', enabled: true }, { id: 'disabled', enabled: false }] },
    runtime: { protocol: 'bush.mcp_snapshot_result.v1', snapshotId: 'fixture', revision: 12, configurationRevision: 8,
      applicationState: 'pending', applicationPhase: 'waiting_for_calls', pendingRevision: 13, pendingServerIds: ['broken'],
      servers: [{ id: 'other', health: 'ready', tools }, { id: 'broken', health: 'unavailable', lastError: 'ENOENT', updateState: 'failed', tools: [],
        lastFailure: { code: 'ENOENT', message: 'Executable unavailable', occurredAt: '2026-10-14T07:29:00.000Z', details: { diagnostic: 'Full detail' } } }] } };
  const original = JSON.stringify(source), summary = mcpManagementView(source);
  assert.ok(JSON.stringify(summary).length < original.length / 10, 'bulk tool names stay out of the default view');
  assert.equal(summary.runtime.servers[0].toolCount, 400);
  assert.equal(summary.runtime.servers[1].lastError, 'ENOENT');
  assert.equal(summary.runtime.servers[1].updateState, 'failed');
  assert.equal(summary.runtime.servers[1].lastFailure.details, undefined);
  assert.equal(summary.configuration.revision, 9); assert.equal(summary.runtime.configurationRevision, 8);
  assert.equal(summary.runtime.applicationPhase, 'waiting_for_calls');
  assert.deepEqual(summary.runtime.pendingServerIds, ['broken']);
  const detail = mcpManagementView(source, { serverId: 'broken', detail: true });
  assert.equal(detail.matched, true); assert.equal(detail.runtime.servers.length, 1);
  assert.deepEqual(detail.runtime.servers[0], source.runtime.servers[1]);
  const disabled = mcpManagementView(source, { serverId: 'disabled' });
  assert.equal(disabled.matched, true); assert.equal(disabled.configuration.servers[0].enabled, false);
  assert.deepEqual(disabled.runtime.servers, []);
  const offline = mcpManagementView({ configuration: source.configuration, runtime: null, runtimeError: 'Host unavailable' }, { serverId: 'broken' });
  assert.equal(offline.matched, true); assert.equal(offline.runtime, null); assert.equal(offline.runtimeError, 'Host unavailable');
  assert.equal(JSON.stringify(source), original, 'presentation does not alter the host snapshot');
});

test('plugin observation summaries filter services and keep full editable settings behind detail', () => {
  const connections = ['a', 'b'].map(componentId => ({ pluginId: 'fixture', componentId, serverId: `plugin_fixture_${componentId}`,
    name: componentId, pluginEnabled: true, source: 'direct', availableSources: ['direct'],
    settings: { tools: { run: { approval_mode: 'prompt' } } }, effective: { transport: 'stdio' } }));
  const source = { configurationRevision: 14, connections,
    runtime: { revision: 18, applicationState: 'applied', servers: connections.map(c => ({ id: c.serverId, health: 'ready', tools: [] })) } };
  const options = { serverId: 'plugin_fixture_b' }, summary = mcpManagementView(source, options);
  assert.equal(summary.configurationRevision, 14); assert.equal(summary.matched, true);
  assert.deepEqual(summary.connections.map(c => c.componentId), ['b']);
  assert.deepEqual(summary.runtime.servers.map(s => s.id), ['plugin_fixture_b']);
  assert.equal(summary.connections[0].settings, undefined);
  assert.deepEqual(mcpManagementView(source, { ...options, detail: true }).connections, [connections[1]]);
  const missing = mcpManagementView(source, { serverId: 'missing' });
  assert.equal(missing.matched, false); assert.deepEqual(missing.connections, []); assert.deepEqual(missing.runtime.servers, []);
});

test('MCP management uses the Product Host store and real Runtime MCP discovery', { timeout: 30_000 }, async (t) => {
  const parent = resolve('tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'product-mcp-management-'));
  const registry = new ToolRegistry();
  let idle = true;
  let runtimeUnavailable = false;
  let revision = 0;
  let lastContent = '';
  let activeSnapshot;
  const manager = new McpClientManager({ registry, canApply: () => idle });
  let host;
  const endpoint = await startProductMcpManagement(() => host);
  const managementServer = {
    id: 'cardbush_management',
    transport: { kind: 'streamable_http', url: endpoint.url, headers: { Authorization: `Bearer ${endpoint.token}` } },
  };
  const bridge = {
    async command(request) {
      if (runtimeUnavailable) throw new Error('fixture runtime unavailable');
      let result;
      switch (request.command.kind) {
        case 'runtime.apply_mcp_snapshot': {
          const source = request.command.payload;
          const servers = [managementServer, ...source.servers];
          const content = JSON.stringify(servers);
          if (content !== lastContent) { revision++; lastContent = content; }
          activeSnapshot = { ...source, revision, servers };
          result = await manager.apply(activeSnapshot);
          break;
        }
        case 'runtime.get_mcp_snapshot': result = manager.snapshot() ?? null; break;
        case 'runtime.mcp_reconnect': {
          const id = request.command.payload.serverId;
          if (!activeSnapshot?.servers.some(server => server.id === id)) throw new Error('This MCP service is not enabled.');
          activeSnapshot = { ...activeSnapshot, revision: ++revision };
          result = manager.submit(activeSnapshot, [id]);
          break;
        }
        default: throw new Error(`Unexpected Runtime command: ${request.command.kind}`);
      }
      return { protocol: 'bush.runtime_ipc.v1', type: 'command_response', operationId: request.operationId, ok: true, result };
    },
    cancelOperation: async () => {},
  };
  host = new ElectronProductHostController({
    dataRoot: join(root, 'product-host'), runtimeStateRoot: join(root, 'runtime-state'),
    bundledSkillRoot: join(root, 'skills'), userSkillRoot: join(root, 'user-skills'),
    bundledPluginRoot: join(root, 'plugins'), userPluginRoot: join(root, 'user-plugins'),
    runtimeBridge: bridge,
  });
  const client = new Client({ name: 'management-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(endpoint.url), {
    requestInit: { headers: { Authorization: `Bearer ${endpoint.token}` } },
  });
  const configPath = join(root, 'product-host', 'config', 'mcp-servers.json');
  const readConfig = async () => JSON.parse(await readFile(configPath, 'utf8'));
  const invoke = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    return JSON.parse(result.content[0].text);
  };
  const until = async (predicate) => {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('MCP state did not settle');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  try {
    await t.test('endpoint rejects unauthenticated and browser-origin requests', async () => {
      assert.equal((await fetch(endpoint.url)).status, 403);
      assert.equal((await fetch(endpoint.url, { headers: { Authorization: `Bearer ${endpoint.token}`, Origin: 'https://example.invalid' } })).status, 403);
    });
    await host.refreshMcp();
    await client.connect(transport);
    await t.test('management is discovered through the ordinary Runtime MCP registry', async () => {
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map(t => t.name).sort(), ['configure_mcp_server', 'configure_plugin_connection', 'list_mcp_servers', 'list_plugin_connections', 'reconnect_mcp_server', 'remove_mcp_server', 'request_plugin_credentials']);
      for (const tool of tools.tools) assert.ok(registry.resolve(`mcp__cardbush_management__${tool.name}`));
      const status = await invoke('list_mcp_servers');
      assert.equal(status.runtime.applicationState, 'applied');
      assert.deepEqual(status.configuration.servers, []);
    });
    const fixture = join(root, 'fixture.mjs');
    await writeFile(fixture, `
      import { McpServer } from '@modelcontextprotocol/server';
      import { serveStdio } from '@modelcontextprotocol/server/stdio';
      await serveStdio(() => {
        const server = new McpServer({ name: 'fixture', version: '1.0.0' });
        server.registerTool('echo', { inputSchema: {}, description: 'Read fixture process identity' }, async () => ({
          content: [{ type: 'text', text: JSON.stringify({ value: process.env.FIXTURE_VALUE, pid: process.pid }) }],
        }));
        return server;
      });
    `);
    const server = { id: 'fixture', transport: 'stdio', command: process.execPath, args: [fixture], env: { FIXTURE_VALUE: 'one', API_TOKEN: 'fixture-private-value' } };
    let firstPid;
    const echo = async () => {
      const registration = registry.resolve('mcp__fixture__echo');
      assert.ok(registration);
      const result = await registration.execute({
        requestId: 'test', sessionId: 'test', turnId: 'test', input: {}, capabilityIds: [],
        toolCall: { id: 'test', name: 'mcp__fixture__echo' },
      });
      return JSON.parse(result.content[0].text);
    };
    await t.test('configure persists, connects, discovers and executes the actual server', async () => {
      const result = await invoke('configure_mcp_server', server);
      assert.equal(result.saved, true);
      assert.equal(result.runtime.applicationState, 'applied');
      assert.equal(result.runtime.servers.find(s => s.id === 'fixture').health, 'ready');
      assert.deepEqual(result.runtime.servers.find(s => s.id === 'fixture').tools.map(t => t.runtimeName), ['mcp__fixture__echo']);
      assert.equal((await readConfig()).servers[0].command, process.execPath);
      const execution = await echo();
      assert.equal(execution.value, 'one');
      firstPid = execution.pid;
      assert.ok(!JSON.stringify(result).includes('fixture-private-value'));
      assert.deepEqual(result.configuration.servers[0].environmentKeys, ['FIXTURE_VALUE', 'API_TOKEN']);
    });
    await t.test('observations default to counts and expand one service without changing native snapshots', async () => {
      const summary = await invoke('list_mcp_servers', { serverId: 'fixture' });
      assert.equal(summary.view, 'summary'); assert.equal(summary.matched, true);
      assert.deepEqual(summary.runtime.servers.map(s => s.id), ['fixture']);
      assert.deepEqual(summary.configuration.servers.map(s => s.id), ['fixture']);
      assert.equal(summary.runtime.servers[0].toolCount, 1);
      assert.equal(summary.runtime.servers[0].tools, undefined);
      assert.equal(summary.runtime.protocol, undefined, 'summary does not claim to be a native protocol snapshot');
      const detail = await invoke('list_mcp_servers', { serverId: 'fixture', detail: true });
      assert.equal(detail.view, 'detail');
      assert.deepEqual(detail.runtime.servers[0].tools.map(t => t.runtimeName), ['mcp__fixture__echo']);
      assert.ok((await host.listMcpServers()).runtime.servers[0].tools, 'UI and host reads keep full snapshots');
      const missing = await invoke('list_mcp_servers', { serverId: 'missing' });
      assert.equal(missing.matched, false); assert.deepEqual(missing.runtime.servers, []);
      assert.doesNotMatch(JSON.stringify(detail), /fixture-private-value/);
    });
    await t.test('active turn returns pending and preserves the old connection until idle', async () => {
      idle = false;
      const result = await invoke('configure_mcp_server', { id: 'fixture', env: { FIXTURE_VALUE: 'two' } });
      assert.equal(result.runtime.applicationState, 'pending');
      assert.equal((await echo()).pid, firstPid);
      assert.equal((await echo()).value, 'one');
      assert.equal((await readConfig()).servers[0].env.API_TOKEN, 'fixture-private-value');
      idle = true;
      await until(() => manager.snapshot()?.applicationState === 'applied');
      assert.equal((await echo()).value, 'two');
    });
    await t.test('bad configuration leaves the saved configuration untouched', async () => {
      const before = await readFile(configPath, 'utf8');
      for (const args of [{ id: 'invalid', transport: 'stdio', command: '' }, { id: 'cardbush_management', enabled: false }, { id: 'plugin_blender_main', enabled: true }]) {
        assert.equal((await client.callTool({ name: 'configure_mcp_server', arguments: args })).isError, true);
      }
      assert.equal(await readFile(configPath, 'utf8'), before);
    });
    await t.test('targeted reconnect waits for idle, refreshes the process and does not alter saved settings', async () => {
      const before = await readFile(configPath, 'utf8');
      const pid = (await echo()).pid;
      idle = false;
      const result = await invoke('reconnect_mcp_server', { id: 'fixture' });
      assert.equal(result.serverId, 'fixture');
      assert.equal(result.runtime.applicationState, 'pending');
      assert.equal((await echo()).pid, pid);
      assert.equal(await readFile(configPath, 'utf8'), before);
      idle = true;
      await until(() => manager.snapshot()?.applicationState === 'applied');
      assert.notEqual((await echo()).pid, pid);
      assert.equal((await echo()).value, 'two');
      // The management connection stayed alive throughout the targeted reconnect.
      assert.equal((await invoke('list_mcp_servers')).runtime.applicationState, 'applied');
    });
    await t.test('reconnect rejects built-in, unknown and cancelled targets without changing configuration', async () => {
      const before = await readFile(configPath, 'utf8');
      const pid = (await echo()).pid;
      for (const id of ['cardbush_management', 'cardbush_apps', 'chrome_devtools', 'missing']) {
        assert.equal((await client.callTool({ name: 'reconnect_mcp_server', arguments: { id } })).isError, true);
      }
      await assert.rejects(host.reconnectMcpServer('fixture', AbortSignal.abort()));
      assert.equal((await echo()).pid, pid);
      assert.equal(await readFile(configPath, 'utf8'), before);
    });
    await t.test('connection failure is reported per server while working tools stay available', async () => {
      const result = await invoke('configure_mcp_server', { id: 'broken', transport: 'stdio', command: join(root, 'missing-executable') });
      assert.equal(result.saved, true);
      assert.equal(result.runtime.applicationState, 'applied');
      const broken = result.runtime.servers.find(s => s.id === 'broken');
      assert.equal(broken.health, 'unavailable');
      assert.ok(broken.lastError);
      assert.deepEqual(broken.tools, []);
      assert.equal((await echo()).value, 'two');
      const repaired = await invoke('remove_mcp_server', { id: 'broken' });
      assert.equal(repaired.runtime.applicationState, 'applied');
    });
    await t.test('concurrent targeted updates preserve unrelated servers and credentials', async () => {
      const storeA = new ProductMcpConfigStore(configPath);
      const storeB = new ProductMcpConfigStore(configPath);
      const staleUiSnapshot = await storeA.read();
      await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? storeA : storeB).updateServer(`extra_${i}`, current => mergeMcpServer(current, {
        id: `extra_${i}`, transport: 'stdio', command: process.execPath, enabled: false,
      }))));
      const config = await readConfig();
      assert.equal(config.servers.length, 9);
      assert.equal(config.servers.find(s => s.id === 'fixture').env.API_TOKEN, 'fixture-private-value');
      await assert.rejects(storeA.write({
        expectedRevision: staleUiSnapshot.revision, servers: staleUiSnapshot.servers,
      }), { code: 'mcp_configuration_conflict' }, 'a stale UI save cannot erase agent-added connections');
      await invoke('configure_mcp_server', { id: 'fixture', env: { API_TOKEN: null } });
      assert.equal((await readConfig()).servers.find(s => s.id === 'fixture').env.API_TOKEN, undefined);
    });
    await t.test('runtime read failure is returned separately from saved configuration', async () => {
      runtimeUnavailable = true;
      const result = await invoke('configure_mcp_server', { id: 'fixture', name: 'Updated name' });
      assert.equal(result.saved, true);
      assert.equal(result.runtime, null);
      assert.match(result.runtimeError, /fixture runtime unavailable/);
      assert.equal(result.configuration.servers.find(s => s.id === 'fixture').name, 'Updated name');
      runtimeUnavailable = false;
      await host.refreshMcp();
    });
    await t.test('cancelled mutation does not write; removal disconnects without deleting package files', async () => {
      const before = await readFile(configPath, 'utf8');
      await assert.rejects(host.configureMcpServer({ id: 'fixture', enabled: false }, AbortSignal.abort()));
      assert.equal(await readFile(configPath, 'utf8'), before);
      const removed = await invoke('remove_mcp_server', { id: 'fixture' });
      assert.equal(removed.runtime.applicationState, 'applied');
      assert.equal(registry.resolve('mcp__fixture__echo'), undefined);
      assert.ok((await readFile(fixture, 'utf8')).includes('serveStdio'));
      const config = await new ProductMcpConfigStore(configPath).read();
      assert.equal(config.servers.length, 8);
    });
  } finally {
    await client.close();
    await manager.close();
    await endpoint.close();
    assert.ok(root.startsWith(parent + sep));
    await rm(root, { recursive: true, force: true });
  }
});
