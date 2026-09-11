import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { CardbushAppsConfigStore } from '@cardbush/product-host';
import { loadProductPluginCatalog, loadEnabledProductPluginMcpServers, loadEnabledProductPluginSkillRoots, loadEnabledProductPluginExtensions } from '../dist-electron/productPlugins.js';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';

async function fixture(t) {
  const parent = resolve('tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'plugin-uninstall-'));
  t.after(async () => { assert.ok(root.startsWith(parent + sep + 'plugin-uninstall-')); await rm(root, { recursive: true, force: true }); });
  for (const id of ['alpha', 'beta']) {
    const directory = join(root, 'plugins', id);
    await mkdir(join(directory, '.codex-plugin'), { recursive: true });
    await mkdir(join(directory, 'skills', 'read'), { recursive: true });
    await writeFile(join(directory, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: id, version: '1.0.0', description: 'fixture', skills: './skills', mcpServers: './.mcp.json' }));
    await writeFile(join(directory, 'skills', 'read', 'SKILL.md'), '---\nname: read\ndescription: fixture\n---\nRead only.');
    await writeFile(join(directory, '.mcp.json'), JSON.stringify({ mcpServers: { echo: { type: 'stdio', command: process.execPath, args: ['-e', ''] } } }));
  }
  const roots = [{ path: join(root, 'plugins'), source: 'user' }], path = join(root, 'apps.json');
  const store = new CardbushAppsConfigStore(path, { loadCatalog: () => loadProductPluginCatalog(roots) });
  const initial = await store.read();
  await store.write({ ...initial, proxy: { mode: 'system' }, plugins: initial.plugins.map(plugin => ({ ...plugin, config: { keep: plugin.id, proxy: { mode: 'none' }, mcp_servers: { echo: { enabled: true } } } })) });
  const state = { commands: [], runtimeFailure: false, phase: 'applied', conflict: false };
  const standalone = { id: 'independent', name: 'Independent', enabled: true, transport: 'stdio', command: process.execPath, args: ['-e', ''], env: { KEEP: 'yes' } };
  const api = await loadChatTranscript({ source: `export { uninstallCardbushPlugin, saveCardbushAppsConfiguration } from ${JSON.stringify(resolve('src/backend/api.ts'))};`, globals: {
    structuredClone, AbortController, TextEncoder, TextDecoder, console, process: { env: { NODE_ENV: 'production' } },
    window: { setTimeout, clearTimeout, localStorage: { getItem: () => null }, cardbushDesktop: {
      productHostCommand: async command => {
        let value;
        if (command.kind === 'apps.get') value = await store.read();
        else if (command.kind === 'apps.update') {
          if (state.conflict) { state.conflict = false; await store.write({ ...await store.read(), serviceEnabled: false }); }
          value = await store.write(command.config);
        } else if (command.kind === 'mcp.get') value = { revision: 1, servers: [standalone] };
        else throw Error(`Unexpected command ${command.kind}`);
        return { protocol: 'cardbush.product_host_ipc.v1', ok: true, value };
      },
      runtime: { command: async request => {
        state.commands.push(request.command);
        if (state.runtimeFailure) throw Error('fixture runtime unavailable');
        return { protocol: 'bush.runtime_ipc.v1', type: 'command_response', operationId: request.operationId, ok: true,
          result: { protocol: 'bush.mcp_snapshot_result.v1', snapshotId: 'cardbush-product-mcp', revision: 1, applicationState: state.phase,
            ...(state.phase === 'failed' ? { applicationError: 'fixture apply failure' } : {}), servers: [] } };
      }, cancelOperation: async () => {} },
    } },
  } });
  return { api, state, store, roots, path, root, standalone };
}

test('uninstall preserves settings and removes only owned skills, MCP and extensions; reinstall restores them', async t => {
  const { api, state, store, roots, path, root, standalone } = await fixture(t);
  const before = await store.read();
  assert.equal((await loadEnabledProductPluginSkillRoots(roots, path)).length, 2);
  const result = await api.uninstallCardbushPlugin('alpha');
  assert.equal(result.pending, false); assert.equal(result.applicationError, undefined);
  const after = await store.read(), target = after.plugins.find(plugin => plugin.id === 'alpha');
  assert.equal(target.installed, false); assert.equal(target.enabled, false);
  assert.deepEqual(target.config, before.plugins[0].config);
  assert.deepEqual(after.plugins[1], before.plugins[1]); assert.deepEqual(after.proxy, before.proxy);
  assert.equal(after.serviceEnabled, before.serviceEnabled);
  assert.deepEqual((await loadEnabledProductPluginMcpServers(roots, path)).map(server => server.id), ['plugin_beta_echo']);
  assert.equal((await loadEnabledProductPluginSkillRoots(roots, path)).length, 1);
  assert.equal((await loadEnabledProductPluginExtensions(roots, path)).skills.length, 1);
  assert.equal(state.commands.at(-1).payload.servers[0].id, standalone.id);
  assert.ok(await readFile(join(root, 'plugins', 'alpha', '.codex-plugin', 'plugin.json'), 'utf8'), 'retained package allows reinstall');
  await api.uninstallCardbushPlugin('alpha'); assert.equal((await store.read()).revision, after.revision, 'repeated uninstall does not rewrite settings');
  await api.saveCardbushAppsConfiguration({ ...after, plugins: after.plugins.map(plugin => ({ ...plugin, installed: true, enabled: true })) });
  assert.equal((await loadEnabledProductPluginMcpServers(roots, path)).length, 2);
  assert.equal((await loadEnabledProductPluginSkillRoots(roots, path)).length, 2);
});

test('pending, transport failure and runtime failure remain distinct from the saved uninstall', async t => {
  const { api, state, store } = await fixture(t);
  state.phase = 'pending';
  const pending = await api.uninstallCardbushPlugin('alpha'); assert.equal(pending.pending, true); assert.equal(pending.applicationError, undefined);
  state.runtimeFailure = true;
  const failed = await api.uninstallCardbushPlugin('beta'); assert.equal(failed.pending, true); assert.match(failed.applicationError, /fixture runtime unavailable/);
  assert.ok((await store.read()).plugins.every(plugin => !plugin.installed && !plugin.enabled));
  state.runtimeFailure = false; state.phase = 'failed';
  const receipt = await api.uninstallCardbushPlugin('alpha'); assert.equal(receipt.pending, true); assert.equal(receipt.applicationError, 'fixture apply failure');
});

test('unknown plugin and revision conflict do not overwrite another change', async t => {
  const { api, state, store } = await fixture(t);
  const before = await store.read(); await assert.rejects(api.uninstallCardbushPlugin('missing')); assert.deepEqual(await store.read(), before);
  state.conflict = true; await assert.rejects(api.uninstallCardbushPlugin('alpha'), /configuration changed/);
  const after = await store.read(); assert.equal(after.serviceEnabled, false); assert.equal(after.plugins[0].installed, true);
  assert.equal(state.commands.length, 0);
});
