import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, stat, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { ElectronProductHostController } from '../dist-electron/productHostController.mjs';
import { PluginMarketplaceService } from '../dist-electron/pluginMarketplaces.js';
import { collectTemporaryDirectories, leaseTemporaryDirectory, clearDiagnosticFiles, clearBrowserCaches } from '../dist-electron/cacheMaintenance.js';
import { appendRotatingLog } from '../dist-electron/rotatingLog.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
const exists = async path => Boolean(await stat(path).catch(() => undefined));
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-maintenance-test-'));
  t.after(async () => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(root.includes('cardbush-maintenance-test-')); await rm(root, { recursive: true, force: true }); });
  return root;
}
const controllerOptions = root => ({ dataRoot: join(root, 'product-host'), runtimeStateRoot: join(root, 'runtime'), bundledSkillRoot: join(root, 'bundled-skills'), userSkillRoot: join(root, 'skills'), bundledPluginRoot: join(root, 'bundled-plugins'), userPluginRoot: join(root, 'plugins'), runtimeBridge: { command: async () => { throw Error('Unexpected runtime command'); } } });

test('log cleanup and diagnostics use the actual app roots and preserve adjacent data', async t => {
  const root = await fixture(t), actual = join(root, 'logs'), legacy = join(root, 'product-host', 'logs');
  for (const directory of [actual, legacy, join(root, 'plugins')]) await mkdir(directory, { recursive: true });
  await writeFile(join(actual, 'renderer.log'), 'actual log'); await writeFile(join(legacy, 'old.log'), 'legacy');
  await writeFile(join(root, 'plugins', 'user-data.json'), 'keep');
  const host = new ElectronProductHostController({ ...controllerOptions(root), logRoots: [actual, actual] });
  const result = await host.execute({ protocol: 'cardbush.product_host_ipc.v1', kind: 'maintenance.clear_logs_cache' });
  assert.equal(result.ok, true); assert.equal(result.value.counts.files, 2); assert.deepEqual(result.value.errors, []);
  assert.deepEqual(await readdir(actual), []); assert.deepEqual(await readdir(legacy), []);
  assert.equal(await readFile(join(root, 'plugins', 'user-data.json'), 'utf8'), 'keep');
  const empty = await host.execute({ protocol: 'cardbush.product_host_ipc.v1', kind: 'maintenance.clear_logs_cache' });
  assert.equal(empty.value.cleared, false);
});

test('restart preview sweep removes expired directories and protects live leases and recent previews', async t => {
  const root = await fixture(t), marketRoot = join(root, 'market'), previews = join(marketRoot, 'previews');
  const stale = join(previews, 'preview-stale'), active = join(previews, 'preview-active'), recent = join(previews, 'preview-new');
  for (const dir of [stale, active, recent]) { await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'plugin.json'), '{}'); }
  const release = await leaseTemporaryDirectory(active); t.after(release);
  for (const dir of [stale, active]) await utimes(dir, new Date(0), new Date(0));
  const market = new PluginMarketplaceService({ dataRoot: marketRoot, userPluginRoot: join(root, 'plugins'), bundledPluginRoot: join(root, 'bundled'), fetch: async () => { throw Error('offline'); } });
  const result = await market.collectCache();
  assert.deepEqual(result.errors, []); assert.equal(await exists(stale), false); assert.equal(await exists(active), true); assert.equal(await exists(recent), true);
  release(); await market.collectCache(); assert.equal(await exists(active), false);
});

test('temporary sweeping protects rollback backups, foreign directories and running process owners', async t => {
  const root = await fixture(t);
  const stale = join(root, '.cardbush-plugin-install-old'), backup = join(root, '.cardbush-plugin-install-backup'), foreign = join(root, 'user-files');
  for (const dir of [stale, backup, foreign]) { await mkdir(dir); await writeFile(join(dir, 'data'), 'keep unless expired staging'); }
  await mkdir(join(backup, 'previous')); await writeFile(join(backup, 'previous', 'user-config'), 'only backup');
  for (const dir of [stale, backup, foreign]) await utimes(dir, new Date(0), new Date(0));
  const result = await collectTemporaryDirectories(root, '.cardbush-plugin-install-', 1000);
  assert.deepEqual(result.errors, []); assert.equal(await exists(stale), false);
  assert.equal(await readFile(join(backup, 'previous', 'user-config'), 'utf8'), 'only backup'); assert.equal(await exists(foreign), true);
});

test('symlink roots and children never authorize cleanup outside an owned directory', async t => {
  const root = await fixture(t), external = join(root, 'external'), owned = join(root, 'owned'), linked = join(root, 'linked');
  await mkdir(external); await mkdir(owned); await writeFile(join(external, 'important.log'), 'keep');
  await symlink(external, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(external, join(owned, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(clearDiagnosticFiles(linked), /linked/);
  await clearDiagnosticFiles(owned);
  assert.equal(await readFile(join(external, 'important.log'), 'utf8'), 'keep');
});

test('browser cleanup calls only cache APIs, reports partial failures and does not clear user storage', async () => {
  const calls = []; let size = 100;
  const session = { getCacheSize: async () => size,
    clearCache: async () => { calls.push('http'); size = 0; },
    clearCodeCaches: async options => { calls.push(['code', options]); throw Error('code cache busy'); },
    clearStorageData: async options => { calls.push(['storage', options]); },
  };
  const result = await clearBrowserCaches([session, session]);
  assert.deepEqual(calls, ['http', ['code', {}], ['storage', { storages: ['shadercache'] }]]);
  assert.equal(result.counts.browser_sessions, 1); assert.equal(result.counts.http_cache_bytes, 100); assert.match(result.errors[0], /busy/);
});

test('diagnostic log rotation keeps a fixed number of bounded files', async t => {
  const root = await fixture(t), file = join(root, 'logs', 'renderer.log');
  for (let index = 0; index < 24; index++) appendRotatingLog(file, { index, payload: 'x'.repeat(110) }, 300);
  assert.equal((await readdir(dirname(file))).length, 4);
  for (const name of await readdir(dirname(file))) assert.ok((await stat(join(dirname(file), name))).size <= 300);
  assert.match(await readFile(file, 'utf8'), /"index":23/);
});

test('history clear is one runtime command and cache failure never reports unconditional success', async t => {
  const root = await fixture(t), commands = [];
  const options = controllerOptions(root);
  options.runtimeBridge = { command: async input => { commands.push(input.command.kind); return { protocol: input.protocol, type: 'command_response', operationId: input.operationId, ok: true, result: { target: 'conversation-history', cleared: true, counts: { sessions: 1 }, errors: ['one locked file'] } }; } };
  const host = new ElectronProductHostController(options);
  const result = await host.execute({ protocol: 'cardbush.product_host_ipc.v1', kind: 'maintenance.clear_conversations' });
  assert.equal(result.ok, true); assert.deepEqual(commands, ['runtime.clear_sessions']); assert.deepEqual(result.value.errors, ['one locked file']);
});

test('real Chromium cache clear preserves login, localStorage and IndexedDB in an isolated profile', { timeout: 30000 }, async t => {
  const root = await fixture(t), env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const electron = createRequire(import.meta.url)('electron');
  const result = await promisify(execFile)(electron, ['scripts/test-cache-maintenance-electron.cjs', root], { env, windowsHide: true, timeout: 25000 });
  assert.match(result.stdout, /CACHE_PROFILE_PRESERVED/);
});
