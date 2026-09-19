import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { CardbushAppsConfigStore, ProductMcpConfigStore } from '@cardbush/product-host';
import { McpClientManager } from '@cardbush/bush-mcp-client';
import { ToolRegistry } from '@cardbush/bush-runtime';
import { ElectronProductHostController } from '../dist-electron/productHostController.mjs';
import { installProductPlugin, removeProductPlugin, loadProductPluginCatalog, loadEnabledProductPluginMcpServers, loadEnabledProductPluginSkillRoots, loadEnabledProductPluginExtensions } from '../dist-electron/productPlugins.js';
import { loadChatTranscript } from './helpers/load-chat-transcript.mjs';
import { PluginHookRunner } from '../packages/bush-runtime/dist/pluginHookRunner.js';

async function fixture(t) {
  const parent = resolve('tmp'); await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, 'plugin-uninstall-'));
  const state = { commands: [], phase: 'applied', failRuntime: false, closed: [] };
  const manager = new McpClientManager({ registry: new ToolRegistry() });
  t.after(async () => {
    await manager.close();
    assert.ok(root.startsWith(parent + sep + 'plugin-uninstall-'));
    await rm(root, { recursive: true, force: true });
  });
  const server = join(root, 'server.mjs');
  await writeFile(server, `import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const input=createInterface({input:process.stdin});
input.on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;
const result=r.method==='initialize'?{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:r.method==='tools/list'?{tools:[]}:{};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});
input.on('close',()=>{appendFileSync(process.argv[2],process.argv[3]+'\\n');process.exit(0);});`);
  for (const id of ['alpha', 'beta']) {
    const directory = join(root, 'plugins', id);
    await mkdir(join(directory, '.codex-plugin'), { recursive: true });
    await mkdir(join(directory, 'skills', 'read'), { recursive: true });
    await writeFile(join(directory, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: id, version: '1.0.0', description: 'fixture', skills: './skills', mcpServers: './.mcp.json' }));
    await writeFile(join(directory, 'skills', 'read', 'SKILL.md'), '---\nname: read\ndescription: fixture\n---\nRead only.');
    await writeFile(join(directory, '.mcp.json'), JSON.stringify({ mcpServers: { echo: { type: 'stdio', command: process.execPath, args: [server, join(root, 'closed.txt'), id] } } }));
    for (const data of [join(root, 'plugin-data', id), join(root, 'runtime', 'plugin-data', createHash('sha256').update(id).digest('hex').slice(0, 24))]) {
      await mkdir(data, { recursive: true }); await writeFile(join(data, 'settings.json'), '{"old":true}');
    }
  }
  await cp(join(root, 'plugins', 'alpha'), join(root, 'source-alpha'), { recursive: true });
  const roots = [{ path: join(root, 'plugins'), source: 'user' }], path = join(root, 'product', 'config', 'apps.json');
  const store = new CardbushAppsConfigStore(path, { loadCatalog: excluded => loadProductPluginCatalog(roots, excluded) });
  const initial = await store.read(), alphaSecret = 'a'.repeat(64), betaSecret = 'b'.repeat(64), sharedSecret = 'c'.repeat(64);
  const vault = new Map([alphaSecret, betaSecret, sharedSecret, 'shared-openai-account'].map(key => [key, { value: 'fixture' }]));
  await store.write({ ...initial, proxy: { mode: 'system' }, plugins: initial.plugins.map(plugin => ({ ...plugin,
    config: { keep: plugin.id, mcp_servers: { echo: { enabled: true, oauth: { clientSecretRef: plugin.id === 'alpha' ? alphaSecret : betaSecret } }, shared: { oauth: { clientSecretRef: sharedSecret } } } } })) });
  const mcp = new ProductMcpConfigStore(join(root, 'product', 'config', 'mcp-servers.json'));
  await mcp.updateServer('independent', () => ({ id: 'independent', name: 'Independent', enabled: false, transport: 'stdio', command: process.execPath, args: [], env: { KEEP: 'yes' } }));
  let revision = 0;
  const host = new ElectronProductHostController({ dataRoot: join(root, 'product'), runtimeStateRoot: join(root, 'runtime'),
    bundledSkillRoot: join(root, 'skills'), userSkillRoot: join(root, 'user-skills'), bundledPluginRoot: join(root, 'bundled'), userPluginRoot: join(root, 'plugins'),
    credentials: { read: async key => vault.get(key), write: async (key, value) => value ? vault.set(key, value) : vault.delete(key) },
    runtimeBridge: { command: async request => {
      state.commands.push(request.command.kind);
      if (state.failRuntime) throw Error('fixture runtime unavailable');
      assert.ok(['runtime.apply_mcp_snapshot', 'runtime.prepare_plugin_uninstall', 'runtime.prepare_plugin_update'].includes(request.command.kind));
      const servers = await loadEnabledProductPluginMcpServers(roots, path);
      const result = await manager.apply({ ...request.command.payload, revision: ++revision, servers });
      if (request.command.kind === 'runtime.prepare_plugin_uninstall' || request.command.kind === 'runtime.prepare_plugin_update') {
        // Retrying a partial delete may have no package left.
        state.closed = (await readFile(join(root, 'closed.txt'), 'utf8').catch(() => '')).trim().split('\n');
      }
      return { protocol: 'bush.runtime_ipc.v1', type: 'command_response', operationId: request.operationId, ok: true,
        result: { ...result, applicationState: state.phase, ...(state.phase === 'failed' ? { applicationError: 'fixture apply failed' } : {}) } };
    }, cancelOperation: async () => {} },
  });
  const api = await loadChatTranscript({ source: `export { uninstallCardbushPlugin } from ${JSON.stringify(resolve('src/backend/api.ts'))};`, globals: {
    structuredClone, AbortController, TextEncoder, TextDecoder, console, process: { env: { NODE_ENV: 'production' } },
    window: { setTimeout, clearTimeout, localStorage: { getItem: () => null }, cardbushDesktop: { uninstallPlugin: id => host.uninstallPlugin(id) } },
  } });
  return { api, host, state, store, mcp, manager, roots, path, root, vault, alphaSecret, betaSecret, sharedSecret };
}

test('uninstall stops its process, deletes package/data/settings/secrets, and reinstalls cleanly', async t => {
  const f = await fixture(t); const { api, host, state, store, roots, path, root, mcp, vault } = f;
  await host.refreshMcp();
  const before = await store.read(), independent = await mcp.read();
  const result = await api.uninstallCardbushPlugin('alpha');
  assert.ok(state.closed.includes('alpha'), 'owned MCP process exited before deleting files');
  assert.ok(!state.closed.includes('beta'), 'another plugin stays running');
  assert.equal(result.configuration.plugins.some(p => p.id === 'alpha'), false);
  for (const directory of [join(root, 'plugins', 'alpha'), join(root, 'plugin-data', 'alpha'), join(root, 'runtime', 'plugin-data', createHash('sha256').update('alpha').digest('hex').slice(0, 24))]) await assert.rejects(stat(directory), { code: 'ENOENT' });
  assert.ok(!(await readFile(path, 'utf8')).includes(f.alphaSecret));
  assert.equal(vault.has(f.alphaSecret), false); assert.ok(vault.has(f.betaSecret) && vault.has(f.sharedSecret) && vault.has('shared-openai-account'));
  const after = await store.read(); assert.deepEqual(after.plugins[0], before.plugins[1]); assert.deepEqual(after.proxy, before.proxy);
  assert.deepEqual(await mcp.read(), independent);
  assert.equal((await loadEnabledProductPluginSkillRoots(roots, path)).length, 1);
  assert.equal((await loadEnabledProductPluginExtensions(roots, path)).skills.length, 1);
  assert.deepEqual((await loadEnabledProductPluginMcpServers(roots, path)).map(s => s.id), ['plugin_beta_echo']);
  await installProductPlugin(join(root, 'source-alpha'), join(root, 'plugins'));
  const reinstalled = (await store.read()).plugins.find(p => p.id === 'alpha');
  assert.equal(reinstalled.installed, true); assert.equal(reinstalled.enabled, true); assert.deepEqual(reinstalled.config, {});
  assert.ok(await readFile(join(root, 'source-alpha', '.codex-plugin', 'plugin.json')), 'source package is preserved');
});

test('pending/failed runtime cannot report success or delete files; retry remains available', async t => {
  const { api, state, store, root } = await fixture(t);
  for (const phase of ['pending', 'failed', 'unavailable']) {
    state.phase = phase === 'unavailable' ? 'applied' : phase; state.failRuntime = phase === 'unavailable';
    await assert.rejects(api.uninstallCardbushPlugin('alpha'));
    const entry = (await store.read()).plugins.find(p => p.id === 'alpha');
    assert.equal(entry.installed, true); assert.equal(entry.enabled, false); assert.equal(entry.removalPending, true);
    assert.ok(await readFile(join(root, 'plugins', 'alpha', '.codex-plugin', 'plugin.json')));
  }
  state.phase = 'applied'; state.failRuntime = false;
  await api.uninstallCardbushPlugin('alpha');
  assert.equal((await store.read()).plugins.some(p => p.id === 'alpha'), false);
});

test('update stops only the old service before replacement and preserves settings, data and credentials', async t => {
  const f = await fixture(t), { host, state, store, root, vault } = f;
  await host.refreshMcp();
  const before = await store.read(), secrets = [...vault];
  const source = join(root, 'source-alpha'), sourceManifest = join(source, '.codex-plugin', 'plugin.json');
  await writeFile(sourceManifest, JSON.stringify({ ...JSON.parse(await readFile(sourceManifest, 'utf8')), version: '2.0.0' }));
  await installProductPlugin(source, join(root, 'plugins'), (id, replace) => host.replacePlugin(id, async () => {
    assert.ok(state.closed.includes('alpha'), 'old MCP exited before the first rename');
    assert.ok(!state.closed.includes('beta'), 'unrelated MCP remains connected');
    assert.equal(JSON.parse(await readFile(f.path, 'utf8')).plugins.find(p => p.id === id).enabled, false);
    return replace();
  }));
  const after = await store.read();
  assert.equal(after.plugins.find(p => p.id === 'alpha').version, '2.0.0');
  assert.equal(after.plugins.find(p => p.id === 'alpha').enabled, true);
  assert.deepEqual(after.plugins.find(p => p.id === 'alpha').config, before.plugins.find(p => p.id === 'alpha').config);
  assert.deepEqual(after.plugins.find(p => p.id === 'beta'), before.plugins.find(p => p.id === 'beta'));
  assert.deepEqual([...vault], secrets);
  assert.equal(await readFile(join(root, 'plugin-data', 'alpha', 'settings.json'), 'utf8'), '{"old":true}');
  assert.deepEqual((await loadEnabledProductPluginMcpServers(f.roots, f.path)).map(s => s.id), ['plugin_alpha_echo', 'plugin_beta_echo']);
});

test('a failed or busy update leaves old files and restores the enabled state', async t => {
  const { host, state, store, root } = await fixture(t);
  const before = await store.read();
  for (const phase of ['pending', 'failed', 'unavailable']) {
    state.phase = phase === 'unavailable' ? 'applied' : phase; state.failRuntime = phase === 'unavailable';
    let replaced = false;
    await assert.rejects(installProductPlugin(join(root, 'source-alpha'), join(root, 'plugins'),
      (id, replace) => host.replacePlugin(id, async () => { replaced = true; return replace(); })));
    assert.equal(replaced, false);
    const after = await store.read();
    assert.deepEqual(after.plugins, before.plugins);
    assert.ok(await readFile(join(root, 'plugins', 'alpha', '.codex-plugin', 'plugin.json')));
  }
  state.phase = 'applied'; state.failRuntime = false;
  await assert.rejects(host.replacePlugin('alpha', async () => { throw new Error('fixture replacement failed'); }), /fixture replacement failed/);
  assert.deepEqual((await store.read()).plugins, before.plugins);
});

test('updating a disabled plugin does not enable it or lose concurrent settings writes', async t => {
  const { host, store } = await fixture(t);
  const initial = await store.read();
  await store.write({ ...initial, plugins: initial.plugins.map(p => ({ ...p, enabled: p.id !== 'alpha' })) });
  const before = await store.read();
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const updating = host.replacePlugin('alpha', async () => { enter(); await new Promise(resolve => { release = resolve; }); });
  await entered;
  const staleWrite = assert.rejects(store.write({ ...before, expectedRevision: before.revision }), /configuration changed/);
  release(); await updating; await staleWrite;
  assert.deepEqual((await store.read()).plugins, before.plugins);
});

test('partial removal remains retryable after restart and cannot reload broken capabilities', async t => {
  const { host, state, root, roots, path } = await fixture(t);
  state.failRuntime = true; await assert.rejects(host.uninstallPlugin('alpha'));
  const packageRoot = resolve(root, 'plugins', 'alpha'); assert.equal(packageRoot, join(root, 'plugins', 'alpha'));
  await rm(packageRoot, { recursive: true });
  const restarted = new CardbushAppsConfigStore(path, { loadCatalog: excluded => loadProductPluginCatalog(roots, excluded) });
  assert.equal((await restarted.read()).plugins.find(p => p.id === 'alpha').removalPending, true);
  assert.equal((await loadEnabledProductPluginSkillRoots(roots, path)).length, 1);
  state.failRuntime = false; await host.uninstallPlugin('alpha');
  assert.equal((await restarted.read()).plugins.some(p => p.id === 'alpha'), false);
});

test('junction escape is rejected before deletion and unrelated files remain intact', async t => {
  const { api, root, store } = await fixture(t);
  const data = resolve(root, 'plugin-data', 'alpha'); assert.equal(data, join(root, 'plugin-data', 'alpha'));
  await rm(data, { recursive: true });
  await symlink(join(root, 'source-alpha'), data, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(api.uninstallCardbushPlugin('alpha'), /owned installation directory/);
  assert.ok(await readFile(join(root, 'source-alpha', '.codex-plugin', 'plugin.json')));
  assert.ok(await readFile(join(root, 'plugins', 'alpha', '.codex-plugin', 'plugin.json')));
  assert.equal((await store.read()).plugins.find(p => p.id === 'alpha').removalPending, true);
});

test('unknown/bundled plugins are protected and last user package can leave an empty catalog', async t => {
  const { api, store, host, root } = await fixture(t);
  const before = await store.read(); await assert.rejects(api.uninstallCardbushPlugin('missing')); assert.deepEqual(await store.read(), before);
  await host.uninstallPlugin('beta'); await host.uninstallPlugin('alpha');
  assert.deepEqual((await store.read()).plugins, []);
  await cp(join(root, 'source-alpha'), join(root, 'bundled', 'alpha'), { recursive: true });
  await assert.rejects(host.uninstallPlugin('alpha'), /Bundled components/);
  assert.ok(await readFile(join(root, 'bundled', 'alpha', '.codex-plugin', 'plugin.json')));
});

test('file removal is serialized with a concurrent reinstall and stale configuration writes fail', async t => {
  const { store, root } = await fixture(t), before = await store.read();
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const removing = store.uninstall('alpha', (plugin, commit) => removeProductPlugin(plugin, join(root, 'plugins'), [], async () => {
    entered(); await new Promise(resolve => { release = resolve; }); return commit();
  }));
  await started;
  const installing = installProductPlugin(join(root, 'source-alpha'), join(root, 'plugins'));
  const stale = assert.rejects(store.write({ ...before, expectedRevision: before.revision }), /configuration changed/);
  release(); await removing; await installing; await stale;
  assert.deepEqual((await store.read()).plugins.find(p => p.id === 'alpha').config, {});
});

test('uninstall cancels active/queued hooks and removes only its future session hooks', async t => {
  const { root } = await fixture(t), invoked = [], observations = [];
  const runner = new PluginHookRunner(root, { evaluate: async hook => {
    invoked.push(hook.id);
    return hook.pluginId === 'alpha' ? new Promise(() => {}) : { ok: true };
  } });
  t.after(() => runner.close());
  const context = { request: { sessionId: 'hooks', turnId: 'turn', metadata: { workspaceDir: root } } };
  const hooks = Array.from({ length: 9 }, (_, i) => ({ id: `alpha-${i}`, pluginId: 'alpha', root, dialect: 'claude', event: 'Stop', type: 'prompt', prompt: 'fixture', async: true, timeout: 5 }));
  hooks.push({ ...hooks[0], id: 'beta', pluginId: 'beta' }, { ...hooks[0], id: 'alpha-end', event: 'SessionEnd' });
  await runner.run(hooks, 'Stop', context, item => observations.push(item));
  await runner.removePlugin('alpha');
  await runner.closeSession('hooks');
  assert.equal(invoked.filter(id => id.startsWith('alpha')).length, 8, 'queued ninth hook and session-end hook never execute');
  assert.ok(invoked.includes('beta'), 'unrelated queued hook is allowed to run');
  assert.equal(observations.filter(item => item.hook.pluginId === 'alpha' && item.phase === 'cancelled').length, 9);
});
