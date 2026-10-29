import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { secureConnectorResourceAsync } from '../dist-electron/browserConnectorFiles.js';

const windows = process.platform === 'win32';
async function directory(t) {
  const parent = await realpath(tmpdir()), root = await mkdtemp(join(parent, 'cardbush-ipc-security-'));
  t.after(async () => { assert.equal(dirname(root), parent); await rm(root, { recursive: true, force: true }); });
  return root;
}

test('local IPC readiness still requires successful native ACL verification', { skip: !windows }, async t => {
  const root = await directory(t), host = resolve('dist-native/chrome-connector/CardBushBrowserHost.exe');
  const target = join(root, 'local-runtime'); await mkdir(target);
  await secureConnectorResourceAsync(host, 'directory', target);
  const invalid = join(root, 'other'); await mkdir(invalid);
  await assert.rejects(secureConnectorResourceAsync(host, 'directory', invalid), /Invalid private IPC directory/);
  await assert.rejects(secureConnectorResourceAsync(join(root, 'missing.exe'), 'directory', target), /ENOENT/);
});

test('helper exit settles readiness without waiting for a retained stderr pipe; failure still fails closed', { skip: !windows }, async t => {
  const root = await directory(t), helper = join(root, 'helper.exe');
  await promisify(execFile)(join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),
    ['/nologo', `/out:${helper}`, resolve('scripts/fixtures/retained-command-output.cs')], { windowsHide: true });
  for (const kind of ['directory', 'pipe']) {
    const target = join(root, kind); await mkdir(target);
    try {
      const began = performance.now(), pending = secureConnectorResourceAsync(helper, kind, target);
      if (kind === 'pipe') await assert.rejects(pending, /fixture verification rejected/); else await pending;
      assert.ok(performance.now() - began < 5000, 'must settle on verified exit, before the inherited pipe closes');
      assert.equal(await readFile(join(target, 'holding'), 'utf8'), 'ready');
      await assert.rejects(readFile(join(target, 'released')), { code: 'ENOENT' });
    } finally {
      await writeFile(join(target, 'release'), 'release');
      const until = Date.now() + 5000;
      while (!await readFile(join(target, 'released')).catch(() => null) && Date.now() < until) await delay(25);
    }
  }
});
