import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { inspectLocalApplication, launchLocalApplication, localApplicationDialog, validateLocalApplication } from '../dist-electron/localApplications.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'cardbush-local-app-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(path.resolve(tmpdir()) + path.sep + 'cardbush-local-app-'));
    await rm(root, { recursive: true, force: true });
  });
  const appPath = path.join(root, '本地 编辑器.exe');
  const shortcutPath = path.join(root, '桌面 快捷方式.lnk');
  await writeFile(appPath, 'fixture, never execute'); await writeFile(shortcutPath, 'fixture shortcut');
  return { root, appPath, shortcutPath };
}

test('local app picker offers applications and shortcuts without selecting arbitrary scripts', () => {
  const options = localApplicationDialog('zh', 'win32');
  assert.equal(options.title, '添加本地应用');
  assert.deepEqual(options.filters[0].extensions, ['lnk', 'url']);
  assert.deepEqual(options.filters[1].extensions, ['exe']);
  assert.ok(options.properties.includes('openFile'));
});

test('native validation rejects URLs, commands and relative paths', async () => {
  for (const value of [null, {}, 'editor.exe', 'C:editor.exe', '\\editor.exe', 'https://example.test/app.exe', 'file:///C:/app.exe', 'C:\\app.exe\n--run']) {
    await assert.rejects(validateLocalApplication(value, 'win32'));
  }
});

test('Windows app and shortcut metadata preserve the chosen path and native icon without executing', { skip: process.platform !== 'win32' }, async t => {
  const { root, appPath, shortcutPath } = await fixture(t), inspected = [];
  const icon = 'data:image/png;base64,aWNvbg==';
  const readIcon = async target => { inspected.push(target); return icon; };
  const app = await inspectLocalApplication(appPath, readIcon);
  assert.equal(app.title, '本地 编辑器'); assert.equal(app.path, appPath); assert.equal(app.icon, icon);
  assert.match(app.id, /^local:[a-f0-9]{32}$/);
  assert.equal((await inspectLocalApplication(appPath.toUpperCase(), readIcon)).id, app.id, 'path casing cannot duplicate an app');
  const shortcut = await inspectLocalApplication(shortcutPath, readIcon);
  assert.equal(shortcut.path, shortcutPath, 'keep shortcut arguments and Shell-managed targets intact');
  assert.equal(shortcut.title, '桌面 快捷方式');
  assert.deepEqual(inspected, [appPath, appPath.toUpperCase(), shortcutPath]);
  assert.equal((await inspectLocalApplication(appPath, async () => { throw Error('no icon'); })).icon, undefined);
  const folder = path.join(root, 'folder.exe'); await mkdir(folder);
  const script = path.join(root, 'script.ps1'); await writeFile(script, 'never execute');
  for (const target of [folder, script, path.join(root, 'missing.exe')]) await assert.rejects(inspectLocalApplication(target, readIcon));
});

test('launch uses the exact selected path, reports OS errors and rejects missing apps before opening', { skip: process.platform !== 'win32' }, async t => {
  const { appPath, shortcutPath } = await fixture(t), opened = [];
  const open = async target => { opened.push(target); return ''; };
  await launchLocalApplication(appPath, open); await launchLocalApplication(shortcutPath, open);
  assert.deepEqual(opened, [appPath, shortcutPath]);
  await assert.rejects(launchLocalApplication(appPath, async () => 'Application could not start'), /could not start/);
  await rm(appPath);
  await assert.rejects(launchLocalApplication(appPath, open), /不存在/);
  assert.equal(opened.length, 2);
});
