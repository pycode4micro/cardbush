import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { loadProductPluginCatalog, loadEnabledProductRuntimeExtensions, loadEnabledProductRuntimeRenderers, installProductPlugin } from '../dist-electron/productPlugins.js';
import { RuntimePluginState } from '../dist-electron/runtimePluginState.mjs';
import { InMemoryRuntimeHost, ToolRegistry } from '@cardbush/bush-runtime';
import { installRuntimePluginFixture } from './fixtures/runtime-plugin.mjs';

const root = await mkdtemp(join(tmpdir(), 'cardbush-independent-plugin-'));
after(async () => { assert.ok(root.startsWith(tmpdir() + sep)); await rm(root, { recursive: true, force: true }); });
let sequence = 0;
async function fixture() {
  const directory = join(root, String(++sequence)); await mkdir(directory);
  const installed = join(directory, 'plugins'), config = join(directory, 'apps.json');
  await installRuntimePluginFixture(directory, installed);
  const roots = [{ path: installed, source: 'user' }];
  const save = (installed = true, enabled = true) => writeFile(config, JSON.stringify({ serviceEnabled: true, plugins: [{ id: 'fixture-runtime', installed, enabled }] }));
  await save();
  const registry = new ToolRegistry();
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, registerDefaultWorkspaceTools: false });
  const errors = [];
  const state = new RuntimePluginState({ host, dataRoot: join(directory, 'plugin-data'), loadEnabled: () => loadEnabledProductRuntimeExtensions(roots, config), reportError: error => errors.push(error) });
  return { directory, installed, config, roots, save, registry, host, errors, state };
}

test('Team is native and the host has no dependency on its former plugin package', async () => {
  assert.equal((await loadProductPluginCatalog([{ path: resolve('assets/plugins'), source: 'bundled' }])).some(plugin => plugin.id === 'team'), false);
  for (const file of ['package.json', 'packages/bush-runtime/package.json']) {
    const pkg = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(Object.hasOwn(pkg.dependencies, '@cardbush/team-plugin'), false);
    if (file === 'package.json') assert.doesNotMatch(pkg.scripts['build:runtime'], /team-plugin/);
  }
  for (const file of ['src/plugins/team', 'electron/teamPlugin.ts']) await assert.rejects(access(file));
  for (const file of ['electron/runtimeHostWorker.mts', 'src/plugins/runtimeWorkspaces.tsx', 'src/plugins/runtimeExtensions.ts']) {
    assert.doesNotMatch(await readFile(file, 'utf8'), /@cardbush\/team-plugin|createTeamRuntimeExtension|import\(.+\/team/);
  }
});

test('an installed former Team package cannot replace the native tools or navigation', async () => {
  const installed = join(root, 'retired-team'), plugin = join(installed, 'team');
  await mkdir(join(plugin, '.codex-plugin'), { recursive: true });
  await writeFile(join(plugin, '.codex-plugin/plugin.json'), JSON.stringify({ name: 'team', version: '0.2.0' }));
  const config = join(installed, 'apps.json');
  await writeFile(config, JSON.stringify({ plugins: [{ id: 'team', installed: true, enabled: true }] }));
  const roots = [{ path: installed, source: 'user' }];
  assert.deepEqual(await loadProductPluginCatalog(roots), []);
  assert.deepEqual(await loadEnabledProductRuntimeExtensions(roots, config), []);
  assert.deepEqual(await loadEnabledProductRuntimeRenderers(roots, config), []);
  const host = new InMemoryRuntimeHost({ registerDefaultWorkspaceTools: false });
  assert.ok(host.capabilities().features.includes('native_team_workflows'));
  await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
});

test('ZIP installs a self-contained Runtime and UI; unchanged refresh keeps runtime state and file receipts', async () => {
  const f = await fixture();
  assert.ok(f.registry.definitions().some(tool => tool.name === 'subagent'));
  assert.equal(f.registry.definitions().some(tool => tool.name === 'fixture_read'), false);
  assert.deepEqual((await loadProductPluginCatalog(f.roots))[0].runtimeExtensions, ['fixture-runtime']);
  const renderers = await loadEnabledProductRuntimeRenderers(f.roots, f.config);
  assert.equal(renderers.length, 1); assert.match(renderers[0].source, /plugin\.fixture\.configuration/);
  assert.equal(await f.state.refresh(), undefined);
  assert.equal(f.registry.definitions().filter(tool => tool.name === 'fixture_read').length, 1);
  const call = (kind, payload = {}) => f.host.sendCommand({ kind, payload });
  const before = await call('plugin.fixture.configuration', { action: 'read' });
  assert.equal(before.path, join(f.directory, 'plugin-data/fixture-runtime/configuration.json'));
  await call('plugin.fixture.apply_snapshot', { revision: 1, items: [] });
  const snapshot = await call('plugin.fixture.get_snapshot');
  assert.deepEqual(await Promise.all([f.state.refresh(), f.state.refresh()]), [undefined, undefined]);
  assert.deepEqual(await call('plugin.fixture.get_snapshot'), snapshot);
  assert.deepEqual(await call('plugin.fixture.configuration', { action: 'read' }), before);
  assert.deepEqual(f.errors, []);
});

test('legacy loading flags, package replacement and restart preserve editable configuration and ordinary Subagent', async () => {
  const f = await fixture(); await f.state.refresh();
  const input = { kind: 'plugin.fixture.configuration', payload: { action: 'read' } };
  const before = await f.host.sendCommand(input);
  before.configuration.items[0].name = 'Preserved custom item';
  const saved = await f.host.sendCommand({ kind: input.kind, payload: { action: 'write', configuration: before.configuration, expectedHash: before.contentHash } });
  for (const installed of [true, false]) {
    await f.save(installed, false); await f.state.refresh();
    assert.equal(f.registry.definitions().some(tool => tool.name === 'fixture_read'), false);
    assert.ok(f.registry.definitions().some(tool => tool.name === 'subagent'));
    await assert.rejects(f.host.sendCommand(input));
    assert.deepEqual(await loadEnabledProductRuntimeRenderers(f.roots, f.config), []);
  }
  // Direct legacy state changes and package replacement are not full uninstall.
  // The desktop uninstall path also deletes plugin-data (test-plugin-uninstall).
  await rm(join(f.installed, 'fixture-runtime'), { recursive: true, force: true });
  assert.equal(JSON.parse(await readFile(saved.path, 'utf8')).configuration.items[0].name, 'Preserved custom item');
  await installRuntimePluginFixture(f.directory, f.installed);
  await f.save(); await f.state.refresh();
  assert.deepEqual(await f.host.sendCommand(input), saved);
  const restarted = new InMemoryRuntimeHost({ registerDefaultWorkspaceTools: false });
  const state = new RuntimePluginState({ host: restarted, dataRoot: join(f.directory, 'plugin-data'), loadEnabled: () => loadEnabledProductRuntimeExtensions(f.roots, f.config), reportError: () => {} });
  assert.equal(await state.refresh(), undefined);
  assert.deepEqual(await restarted.sendCommand(input), saved);
});

test('a broken updated plugin is disabled, leaves core usable and can recover without reloading the application', async () => {
  const f = await fixture(); await f.state.refresh();
  const file = join(f.installed, 'fixture-runtime/dist/runtime.mjs');
  const original = await readFile(file, 'utf8');
  await writeFile(file, 'throw new Error("fixture damaged bundle");');
  assert.match(await f.state.refresh(), /fixture damaged bundle/);
  await f.state.refresh(); assert.equal(f.errors.length, 1);
  assert.equal(f.registry.definitions().some(tool => tool.name === 'fixture_read'), false);
  assert.ok(f.registry.definitions().some(tool => tool.name === 'subagent'));
  await writeFile(file, original + '\n// repaired update\n');
  assert.equal(await f.state.refresh(), undefined);
  assert.equal(f.registry.definitions().filter(tool => tool.name === 'fixture_read').length, 1);
});

test('updating an in-use plugin defers replacement and does not block the core or admit old code to new turns', async () => {
  const f = await fixture(); await f.state.refresh();
  const file = join(f.installed, 'fixture-runtime/dist/runtime.mjs');
  const old = f.registry.resolve('fixture_read');
  const hasActiveTurns = f.host.hasActiveTurns.bind(f.host);
  f.host.hasActiveTurns = () => true;
  await writeFile(file, await readFile(file, 'utf8') + '\n// changed during a turn\n');
  assert.match(await f.state.refresh(), /update pending/);
  assert.equal(f.registry.resolve('fixture_read'), old);
  assert.equal(f.registry.definitions().some(tool => tool.name === 'fixture_read'), false);
  f.host.hasActiveTurns = hasActiveTurns;
  assert.equal(await f.state.refresh(), undefined);
  assert.notEqual(f.registry.resolve('fixture_read'), old);
  assert.equal(f.registry.definitions().filter(tool => tool.name === 'fixture_read').length, 1);
});

test('manifest API, entry existence and traversal checks reject invalid packages before installation', async () => {
  const directory = join(root, 'invalid'); await mkdir(join(directory, '.codex-plugin'), { recursive: true });
  const manifest = join(directory, '.codex-plugin/plugin.json');
  for (const runtimeExtension of ['fixture-runtime', { apiVersion: 2, entry: './entry.mjs' }, { apiVersion: 1, entry: '../escape.mjs' }, { apiVersion: 1, entry: './missing.mjs' }]) {
    await writeFile(manifest, JSON.stringify({ name: 'invalid', version: '1', cardbush: { runtimeExtension } }));
    await assert.rejects(installProductPlugin(directory, join(root, 'invalid-install')));
    await assert.rejects(access(join(root, 'invalid-install/invalid')));
  }
  const outside = join(root, 'outside'); await mkdir(outside); await writeFile(join(outside, 'entry.mjs'), 'export default () => ({})');
  await symlink(outside, join(directory, 'linked'), 'junction');
  await writeFile(manifest, JSON.stringify({ name: 'invalid', version: '1', cardbush: { runtimeExtension: { apiVersion: 1, entry: './linked/entry.mjs' } } }));
  await assert.rejects(installProductPlugin(directory, join(root, 'invalid-install')), /escapes|symbolic|symlink/i);
});

test('failed registration is atomic and cannot replace a core tool or command', () => {
  const registry = new ToolRegistry(); const host = new InMemoryRuntimeHost({ toolRegistry: registry, registerDefaultWorkspaceTools: false });
  const before = registry.catalog();
  const registration = name => ({ definition: { name, description: name, inputSchema: { type: 'object' } }, manifest: { effect_kind: 'observation', operation: 'fixture.read', risk: 'low', owner: 'fixture', dispatch_scope: 'parent_session', mutating: false }, decodeInput: v => v, execute: () => 'ok' });
  for (const create of [
    api => { api.tools.register(registration('partial')); throw new Error('factory failed'); },
    api => { api.tools.register(registration('partial')); return { id: 'bad', features: [], commands: { 'runtime.get_capabilities': () => null } }; },
    api => { api.tools.register(registration('subagent')); return { id: 'bad', features: [], commands: {} }; },
  ]) {
    assert.throws(() => host.installExtension(create, { id: 'bad', enabled: true }));
    assert.deepEqual(registry.catalog(), before);
  }
});

test('native loading uses package declarations for a non-Team plugin, including isolated errors and retained state', async () => {
  const host = new InMemoryRuntimeHost({ registerDefaultWorkspaceTools: false });
  const good = { id: 'example', hash: 'v1', source: 'export const apiVersion=1; export default ()=>{let n=0;return {id:"example",features:["example"],commands:{"plugin.example.counter":()=>++n}}}' };
  const bad = { id: 'broken', hash: 'v1', source: 'throw Error("fixture activation failure");' };
  let packages = [good, bad];
  const errors = [];
  const state = new RuntimePluginState({ host, dataRoot: root, loadEnabled: async () => packages, reportError: error => errors.push(error) });
  assert.match(await state.refresh(), /broken: fixture activation failure/);
  assert.equal(await host.sendCommand({ kind: 'plugin.example.counter', payload: {} }), 1);
  packages = [good]; await state.refresh();
  assert.equal(await host.sendCommand({ kind: 'plugin.example.counter', payload: {} }), 2);
  assert.equal(errors.length, 1);
});

test('configuration command in progress finishes safely while removal disables new access', async () => {
  const host = new InMemoryRuntimeHost({ registerDefaultWorkspaceTools: false });
  let finish;
  host.installExtension(() => ({ id: 'busy', features: [], commands: { 'plugin.busy.save': () => new Promise(resolve => { finish = resolve; }) } }), { enabled: true });
  const saving = host.sendCommand({ kind: 'plugin.busy.save', payload: {} });
  assert.equal(host.isExtensionBusy('busy'), true);
  host.removeExtension('busy');
  await assert.rejects(host.sendCommand({ kind: 'plugin.busy.save', payload: {} }), /not enabled/);
  finish('saved'); assert.equal(await saving, 'saved');
  host.removeExtension('busy');
  assert.equal(host.isExtensionCommand('plugin.busy.save'), false);
});
