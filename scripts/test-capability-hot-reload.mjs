import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { watchCapabilityCatalog } from '../dist-electron/capabilityCatalogWatcher.js';
import { loadEnabledProductPluginMcpServers, loadProductPluginCatalog } from '../dist-electron/productPlugins.js';
import { listProductSkills } from '../dist-electron/productSkills.js';
import { CardbushAppsConfigStore } from '@cardbush/product-host';
import { McpClientManager } from '@cardbush/bush-mcp-client';
import { ToolRegistry } from '@cardbush/bush-runtime';

const tmp = resolve('tmp');
await mkdir(tmp, { recursive: true });
const root = await mkdtemp(join(tmp, 'capability-hot-reload-'));
const plugins = join(root, 'plugins');
const skills = join(root, 'skills');
const config = join(root, 'config');
await mkdir(config);
const configPath = join(config, 'apps.json');
const roots = [{ path: plugins, source: 'user' }];
const registry = new ToolRegistry();
let idle = true;
const manager = new McpClientManager({ registry, canApply: () => idle });
let revision = 0;
let changes = 0;
let listedSkills = [];
let errors = [];
let updates = Promise.resolve();
const update = () => {
  changes++;
  updates = updates.then(async () => {
    listedSkills = await listProductSkills([skills]);
    await manager.apply({ protocol: 'bush.mcp_snapshot.v2', snapshotId: 'fixture', revision: ++revision,
      servers: await loadEnabledProductPluginMcpServers(roots, configPath) });
  }).catch(error => errors.push(error));
};
const dispose = watchCapabilityCatalog([plugins, skills, config], update);
const until = async (predicate, label) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`${label}: ${errors.map(error => error.message).join('; ')}`);
};
try {
  await until(() => manager.snapshot()?.applicationState === 'applied', 'initial empty catalog');
  await mkdir(join(skills, 'live-skill'), { recursive: true });
  await writeFile(join(skills, 'live-skill', 'SKILL.md'), '---\nname: live-skill\ndescription: live fixture\n---\nHello');
  await until(() => listedSkills.some(skill => skill.name === 'live-skill'), 'new Skill in previously missing root');

  const plugin = join(plugins, 'live');
  await mkdir(join(plugin, '.codex-plugin'), { recursive: true });
  await writeFile(join(plugin, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const source = (withMusic = false) => `
    import { McpServer } from '@modelcontextprotocol/server';
    import { serveStdio } from '@modelcontextprotocol/server/stdio';
    await serveStdio(() => {
      const server = new McpServer({ name: 'hot-reload-fixture', version: '1.0.0' });
      server.registerTool('echo', { description: 'Echo fixture', inputSchema: {} }, async () => ({
        content: [{ type: 'text', text: process.env.FIXTURE_VALUE || 'first' }],
      }));
      server.registerTool('identity', { description: 'Process identity fixture', inputSchema: {} }, async () => ({
        content: [{ type: 'text', text: String(process.pid) }],
      }));
      ${withMusic ? "server.registerTool('music', { description: 'New music fixture', inputSchema: {} }, async () => ({ content: [{ type: 'text', text: 'music' }] }));" : ''}
      return server;
    });
  `;
  await writeFile(join(plugin, 'server.mjs'), source());
  const mcpConfig = { mcpServers: { echo: { type: 'stdio', command: process.execPath,
    args: ['${CARDBUSH_PLUGIN_ROOT}/server.mjs'], env: { FIXTURE_VALUE: 'first' } } } };
  await writeFile(join(plugin, '.mcp.json'), JSON.stringify(mcpConfig));
  const manifest = {
    name: 'live', version: '1.0.0', description: 'Fixture plugin', author: { name: 'Fixture' },
    mcpServers: './.mcp.json', interface: { displayName: 'Live', shortDescription: 'Fixture',
      longDescription: 'Fixture', developerName: 'Fixture', category: 'Tests', logo: './logo.svg' },
  };
  await writeFile(join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify(manifest));
  const name = 'mcp__plugin_live_echo__echo';
  await until(() => registry.resolve(name), 'new plugin tool connected without restarting manager');
  const execute = () => registry.resolve(name).execute({ requestId: 'fixture', sessionId: 'fixture', turnId: 'fixture',
    toolCall: { id: 'echo', name }, input: {}, capabilityIds: [] });
  assert.equal((await execute()).content[0].text, 'first');

  idle = false;
  mcpConfig.mcpServers.echo.env.FIXTURE_VALUE = 'second';
  await writeFile(join(plugin, '.mcp.json.tmp'), JSON.stringify(mcpConfig));
  await rename(join(plugin, '.mcp.json.tmp'), join(plugin, '.mcp.json'));
  await until(() => manager.snapshot()?.applicationState === 'pending', 'atomic config replacement queued');
  assert.equal((await execute()).content[0].text, 'first', 'in-flight turn keeps old connection');
  idle = true;
  await until(() => manager.snapshot()?.applicationState === 'applied', 'queued update applied automatically');
  assert.equal((await execute()).content[0].text, 'second');

  const store = new CardbushAppsConfigStore(configPath, { loadCatalog: () => loadProductPluginCatalog(roots) });
  await store.write({ serviceEnabled: true, plugins: [{ id: 'live', installed: true, enabled: false, config: {} }] });
  await until(() => !registry.resolve(name), 'disabled plugin tools removed');
  await store.write({ serviceEnabled: true, plugins: [{ id: 'live', installed: true, enabled: true, config: {} }] });
  await until(() => registry.resolve(name), 'enabled plugin reconnects');
  const connectionBeforeSearchEdit = registry.resolve(name), changesBeforeSearchEdit = changes;
  await store.write({ ...await store.read(), searchResultLimit: 13 });
  await until(async () => { if (changes <= changesBeforeSearchEdit) return false; await updates; return true; }, 'search preference observed');
  assert.equal(registry.resolve(name), connectionBeforeSearchEdit, 'search preferences preserve the existing MCP registration and connection');
  assert.equal((await execute()).content[0].text, 'second');

  const steady = join(plugins, 'steady');
  await mkdir(join(steady, '.codex-plugin'), { recursive: true });
  await writeFile(join(steady, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(steady, 'server.mjs'), source());
  await writeFile(join(steady, '.mcp.json'), JSON.stringify(mcpConfig));
  await writeFile(join(steady, '.codex-plugin', 'plugin.json'), JSON.stringify({ ...manifest, name: 'steady' }));
  const identity = async (pluginId = 'live') => (await registry.resolve(`mcp__plugin_${pluginId}_echo__identity`).execute({
    requestId: 'fixture', sessionId: 'fixture', turnId: 'fixture', toolCall: { id: 'identity', name: 'identity' }, input: {}, capabilityIds: [],
  })).content[0].text;
  await until(() => registry.resolve('mcp__plugin_steady_echo__identity'), 'unrelated service connected');
  const steadyPid = await identity('steady');
  const beforeCodePid = await identity();
  const beforeCodeConfig = (await loadEnabledProductPluginMcpServers(roots, configPath)).find(server => server.pluginId === 'live');
  assert.match(beforeCodeConfig.implementationFingerprint, /^[a-f0-9]{64}$/);
  idle = false;
  await writeFile(join(plugin, 'server.mjs'), source(true));
  await until(() => manager.snapshot()?.applicationState === 'pending', 'source-only edit queued with identical launch arguments');
  assert.equal(await identity(), beforeCodePid, 'active turns retain the old process');
  assert.equal(registry.resolve('mcp__plugin_live_echo__music'), undefined);
  idle = true;
  await until(() => registry.resolve('mcp__plugin_live_echo__music') && manager.snapshot()?.applicationState === 'applied', 'new tool published after idle');
  const afterCodePid = await identity();
  assert.notEqual(afterCodePid, beforeCodePid);
  assert.equal(await identity('steady'), steadyPid, 'another plugin is not restarted');
  const afterCodeConfig = (await loadEnabledProductPluginMcpServers(roots, configPath)).find(server => server.pluginId === 'live');
  assert.deepEqual(afterCodeConfig.transport, beforeCodeConfig.transport);
  assert.notEqual(afterCodeConfig.implementationFingerprint, beforeCodeConfig.implementationFingerprint);

  manifest.version = '1.1.0';
  await writeFile(join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify(manifest));
  await until(async () => { await updates; return manager.snapshot()?.applicationState === 'applied' && (await identity()) !== afterCodePid; }, 'version-only update refreshes installed external modules');
  const afterVersionPid = await identity();
  const beforeDocs = changes;
  await writeFile(join(plugin, 'README.md'), 'Updated documentation');
  await writeFile(join(plugin, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><title>New logo</title></svg>');
  await mkdir(join(plugin, 'cache'), { recursive: true });
  await writeFile(join(plugin, 'cache', 'generated.py'), 'generated data');
  await writeFile(join(plugin, 'server.mjs'), source(true));
  await until(async () => { if (changes <= beforeDocs) return false; await updates; return true; }, 'presentation and same-content edits observed');
  assert.equal(await identity(), afterVersionPid, 'docs, icons, cache writes and same-content touches do not reconnect');
  assert.equal(await identity('steady'), steadyPid);
  idle = false;
  await store.write({ serviceEnabled: true, plugins: [{ id: 'live', installed: false, enabled: false, config: {} }] });
  await until(() => manager.snapshot()?.applicationState === 'pending', 'uninstall waits for the active turn boundary');
  assert.equal((await execute()).content[0].text, 'second', 'an active turn keeps its published tool until uninstall applies');
  idle = true;
  await until(() => !registry.resolve(name), 'uninstalled plugin tool leaves discovery without restarting the host');
  assert.equal((await store.read()).plugins[0].installed, false, 'uninstall is distinct from disabling an installed plugin');
  await store.write({ serviceEnabled: true, plugins: [{ id: 'live', installed: true, enabled: true, config: {} }] });
  await until(() => registry.resolve(name), 'retained package reconnects after reinstall');
  await writeFile(join(plugin, '.mcp.json'), '{');
  await until(() => errors.length > 0, 'malformed edit reported');
  assert.equal((await execute()).content[0].text, 'second', 'malformed edit preserves working catalog');
  errors = [];
  await writeFile(join(plugin, '.mcp.json'), JSON.stringify(mcpConfig));
  await until(async () => { await updates; return manager.snapshot()?.applicationState === 'applied'; }, 'repair');
  await rm(join(skills, 'live-skill', 'SKILL.md'));
  await until(() => listedSkills.length === 0, 'Skill deletion reflected');
  dispose();
  await updates;
  const stoppedAt = changes;
  await writeFile(join(skills, 'live-skill', 'SKILL.md'), '---\nname: stopped\n---');
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(changes, stoppedAt, 'watcher disposed without late notifications');
  console.log('Capability hot reload passed: source/version updates, new tool discovery after idle, stable unrelated processes, ignored presentation/cache edits, missing roots, Skill add/delete, atomic edits, enable/disable, uninstall/reinstall, malformed config recovery and watcher cleanup.');
} finally {
  dispose();
  await updates;
  await manager.close();
  assert.ok(resolve(root).startsWith(tmp + sep));
  await rm(root, { recursive: true, force: true });
}
