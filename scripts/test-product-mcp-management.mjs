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

test('MCP management uses the Product Host store and real Runtime MCP discovery', { timeout: 30_000 }, async (t) => {
  const parent = resolve('tmp');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'product-mcp-management-'));
  const registry = new ToolRegistry();
  let idle = true;
  let runtimeUnavailable = false;
  let revision = 0;
  let lastContent = '';
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
          result = await manager.apply({ ...source, revision, servers });
          break;
        }
        case 'runtime.get_mcp_snapshot': result = manager.snapshot() ?? null; break;
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
      assert.deepEqual(tools.tools.map(t => t.name).sort(), ['configure_mcp_server', 'list_mcp_servers', 'remove_mcp_server']);
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
    await t.test('connection failure is saved/failed with old working tools preserved', async () => {
      const result = await invoke('configure_mcp_server', { id: 'broken', transport: 'stdio', command: join(root, 'missing-executable') });
      assert.equal(result.saved, true);
      assert.equal(result.runtime.applicationState, 'failed');
      assert.ok(result.applicationError);
      assert.equal(result.runtime.servers.some(s => s.id === 'broken'), false);
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
