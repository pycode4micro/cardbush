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
  await writeFile(join(plugin, 'server.mjs'), `
    import { McpServer } from '@modelcontextprotocol/server';
    import { serveStdio } from '@modelcontextprotocol/server/stdio';
    await serveStdio(() => {
      const server = new McpServer({ name: 'hot-reload-fixture', version: '1.0.0' });
      server.registerTool('echo', { description: 'Echo fixture', inputSchema: {} }, async () => ({
        content: [{ type: 'text', text: process.env.FIXTURE_VALUE || 'first' }],
      }));
      return server;
    });
  `);
  const mcpConfig = { mcpServers: { echo: { type: 'stdio', command: process.execPath,
    args: ['${CARDBUSH_PLUGIN_ROOT}/server.mjs'], env: { FIXTURE_VALUE: 'first' } } } };
  await writeFile(join(plugin, '.mcp.json'), JSON.stringify(mcpConfig));
  await writeFile(join(plugin, '.codex-plugin', 'plugin.json'), JSON.stringify({
    name: 'live', version: '1.0.0', description: 'Fixture plugin', author: { name: 'Fixture' },
    mcpServers: './.mcp.json', interface: { displayName: 'Live', shortDescription: 'Fixture',
      longDescription: 'Fixture', developerName: 'Fixture', category: 'Tests', logo: './logo.svg' },
  }));
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
  console.log('Capability hot reload passed: missing roots, Skill add/delete, real plugin stdio call, atomic edits, busy deferral, enable/disable, uninstall/reinstall, malformed config recovery and watcher cleanup.');
} finally {
  dispose();
  await updates;
  await manager.close();
  assert.ok(resolve(root).startsWith(tmp + sep));
  await rm(root, { recursive: true, force: true });
}
