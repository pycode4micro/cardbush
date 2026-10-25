import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { loadProductPluginCatalog, loadEnabledProductRuntimeExtensions, loadEnabledProductPluginMcpServers } from '../dist-electron/productPlugins.js';
import { RuntimePluginState } from '../dist-electron/runtimePluginState.mjs';
import { ToolRegistry, InMemoryRuntimeHost } from '@cardbush/bush-runtime';

test('bundled AgentChatroom installs by default, wins over the old external package, and preserves disabled preferences', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cardbush-chatroom-package-'));
  t.after(async () => { assert.ok(directory.startsWith(tmpdir() + sep)); await rm(directory, { recursive: true, force: true }); });
  const userRoot = join(directory, 'plugins'); await mkdir(join(userRoot, 'agentchatroom/.codex-plugin'), { recursive: true });
  await writeFile(join(userRoot, 'agentchatroom/.codex-plugin/plugin.json'), JSON.stringify({ name: 'agentchatroom', version: '0.1.1', mcpServers: './mcp.json' }));
  await writeFile(join(userRoot, 'agentchatroom/mcp.json'), JSON.stringify({ mcpServers: { agentchatroom: { command: 'node', args: ['old-service.mjs'] } } }));
  const roots = [{ path: resolve('assets/plugins'), source: 'bundled' }, { path: userRoot, source: 'user' }];
  const config = join(directory, 'apps.json'), catalog = await loadProductPluginCatalog(roots);
  assert.equal(catalog.filter(plugin => plugin.id === 'agentchatroom').length, 1);
  const plugin = catalog.find(plugin => plugin.id === 'agentchatroom');
  assert.equal(plugin.source, 'bundled'); assert.equal(plugin.installation, 'INSTALLED_BY_DEFAULT');
  assert.deepEqual(plugin.components.map(component => component.kind), ['runtime', 'skill']);
  const enabled = (await loadEnabledProductRuntimeExtensions(roots, config)).find(plugin => plugin.id === 'agentchatroom');
  assert.ok(enabled);
  const loaded = await import(`data:text/javascript;base64,${Buffer.from(enabled.source).toString('base64')}`);
  assert.equal(loaded.apiVersion, 1); assert.equal(typeof loaded.default, 'function');
  const servers = await loadEnabledProductPluginMcpServers(roots, config, [], join(directory, 'data'));
  assert.equal(servers.some(server => JSON.stringify(server).includes('old-service.mjs')), false);
  await writeFile(config, JSON.stringify({ serviceEnabled: true, plugins: [{ id: 'agentchatroom', installed: true, enabled: false }] }));
  assert.equal((await loadEnabledProductRuntimeExtensions(roots, config)).some(plugin => plugin.id === 'agentchatroom'), false);
});

test('portable packaged bundle loads through the actual Runtime plugin loader and unloads without native tool injection', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cardbush-chatroom-loader-'));
  const registry = new ToolRegistry(), errors = [];
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, registerDefaultWorkspaceTools: false });
  const config = join(directory, 'apps.json'), roots = [{ path: resolve('assets/plugins'), source: 'bundled' }];
  const state = new RuntimePluginState({ host, dataRoot: directory, loadEnabled: () => loadEnabledProductRuntimeExtensions(roots, config), reportError: error => errors.push(error) });
  t.after(async () => {
    await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
    // The writer's close is asynchronous but always starts before the next event-loop tick.
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.ok(directory.startsWith(tmpdir() + sep)); await rm(directory, { recursive: true, force: true });
  });
  await state.refresh();
  assert.equal(host.capabilities().features.includes('workspace_agent_coordination'), true);
  assert.equal(registry.resolve('agentchatroom').visibleToChild, true);
  assert.equal(registry.resolve('agentchatroom').deferredSchema, true);
  await state.refresh(); assert.deepEqual(registry.definitions().filter(tool => tool.name.startsWith('agentchatroom')).map(tool => tool.name), ['agentchatroom']);
  await writeFile(config, JSON.stringify({ plugins: [{ id: 'agentchatroom', installed: true, enabled: false }] }));
  await state.refresh(); assert.equal(registry.resolve('agentchatroom'), undefined);
  assert.deepEqual(errors, []);
});
