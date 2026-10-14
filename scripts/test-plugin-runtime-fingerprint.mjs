import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fsPromises from 'node:fs/promises';
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pluginRuntimeFingerprint, pluginRuntimeSource } from '../dist-electron/pluginRuntimeFingerprint.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-plugin-fingerprint-'));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(root.includes('cardbush-plugin-fingerprint-'));
    await rm(root, { recursive: true, force: true });
  });
  const put = async (name, content) => { const path = join(root, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); return path; };
  return { root, put, hash: (version = '1.0.0') => pluginRuntimeFingerprint(root, version) };
}

test('implementation identity changes on version, Python/JS module edits, additions, deletions and dependency updates', async t => {
  const f = await fixture(t);
  await f.put('src/server.py', 'version = 1\n');
  const first = await f.hash();
  assert.equal(await f.hash(), first);
  assert.notEqual(await f.hash('1.1.0'), first, 'a package version bump can refresh external installed modules');
  await f.put('src/server.py', 'version = 2\n');
  const second = await f.hash();
  assert.notEqual(second, first);
  await f.put('lib/music.mjs', 'export const music = true;');
  const third = await f.hash();
  assert.notEqual(third, second);
  await rm(join(f.root, 'lib/music.mjs'));
  assert.equal(await f.hash(), second);
  await f.put('requirements.txt', 'fixture-package==2.0');
  assert.notEqual(await f.hash(), second);
  await f.put('src/contracts/music.json', '{"tools":["music"]}');
  const schema = await f.hash();
  await f.put('src/contracts/music.json', '{"tools":["music","lyrics"]}');
  assert.notEqual(await f.hash(), schema);
});

test('content identity survives touches and atomic same-byte replacements; metadata restoration cannot hide changed code', async t => {
  const f = await fixture(t);
  const path = await f.put('server.mjs', 'export const value = 1;');
  const first = await f.hash();
  const original = await stat(path);
  await utimes(path, original.atime, new Date(original.mtimeMs + 5000));
  assert.equal(await f.hash(), first, 'touches do not restart services');
  await f.put('server.mjs.next', await readFile(path));
  await rename(join(f.root, 'server.mjs.next'), path);
  assert.equal(await f.hash(), first, 'atomic reinstall of identical source is stable');
  await f.put('server.mjs', 'export const value = 2;');
  await utimes(path, original.atime, original.mtime);
  assert.notEqual(await f.hash(), first);
});

test('docs, icons, generated state and dependency directories cannot trigger implementation changes', async t => {
  const f = await fixture(t);
  await f.put('server.py', 'print("server")');
  const first = await f.hash();
  for (const name of ['README.md', 'skills/music/SKILL.md', 'skills/music/scripts/helper.py', 'docs/example.js',
    'assets/logo.png', 'cache/state.json', 'outputs/generated.py', 'logs/run.json', '__pycache__/server.pyc',
    'node_modules/fixture/index.js', '.venv/lib/site-packages/helper.py', '.codex-plugin/plugin.json']) {
    await f.put(name, 'changed');
    assert.equal(await f.hash(), first, name);
  }
  assert.equal(pluginRuntimeSource('plugin\\src\\music.py'), true);
  assert.equal(pluginRuntimeSource('plugin\\.venv\\lib\\music.py'), false);
  assert.equal(pluginRuntimeSource('plugin/dist/server.mjs'), true);
});

test('runtime source scan does not follow linked trees outside the package', async t => {
  const f = await fixture(t);
  const other = await fixture(t);
  await other.put('private.py', 'external source');
  const first = await f.hash();
  await symlink(other.root, join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await f.hash(), first);
  await other.put('private.py', 'changed external source');
  assert.equal(await f.hash(), first);
});

for (const unpack of [false, true]) {
  test(`ASAR sources ${unpack ? 'with unpacked sidecars' : 'inside the archive'} have stable content identity`, async t => {
    const source = await fixture(t);
    const packed = await fixture(t);
    await source.put('server.cjs', 'module.exports = "packaged plugin";');
    await source.put('lib/worker.mjs', 'export const ready = true;');
    const archive = join(packed.root, 'plugin.asar');
    const { createPackageWithOptions } = await import('@electron/asar');
    await createPackageWithOptions(source.root, archive, unpack ? { unpack: '**/*.cjs' } : {});
    const expected = await source.hash();
    const require = createRequire(import.meta.url);
    const code = `
      const { pluginRuntimeFingerprint } = require(process.argv[1]);
      (async () => {
        const first = await pluginRuntimeFingerprint(process.argv[2], '1.0.0');
        const second = await pluginRuntimeFingerprint(process.argv[2], '1.0.0');
        let changed = null;
        if (process.argv[3] === 'true') {
          await require('node:fs/promises').writeFile(require('node:path').join(process.argv[2] + '.unpacked', 'server.cjs'), 'module.exports = "updated sidecar";');
          changed = await pluginRuntimeFingerprint(process.argv[2], '1.0.0');
        }
        process.stdout.write(JSON.stringify({ first, second, changed }));
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `;
    const run = spawnSync(require('electron'), ['-e', code, resolve('dist-electron/pluginRuntimeFingerprint.js'), archive, String(unpack)], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true, timeout: 15_000,
    });
    assert.equal(run.status, 0, run.error?.message || run.stderr);
    const { first, second, changed } = JSON.parse(run.stdout);
    assert.deepEqual({ first, second }, { first: expected, second: expected });
    if (unpack) assert.notEqual(changed, first, 'sidecar edits invalidate the archive entry cache');
  });
}

for (const change of ['write', 'replace']) {
  test(`a ${change} during hashing is rejected and cannot populate the cache`, async t => {
    const f = await fixture(t);
    const path = await f.put('server.cjs', 'module.exports = 1;');
    const replacement = join(f.root, 'server.next');
    await writeFile(replacement, 'module.exports = 200;');
    const originalOpen = fsPromises.open;
    let changed = false;
    const openMock = t.mock.method(fsPromises, 'open', async (...args) => {
      // Replace between path stat and open; Windows does not permit replacing
      // the destination while a read handle is already open.
      if (change === 'replace' && args[0] === path && !changed) {
        changed = true;
        await rename(replacement, path);
      }
      const handle = await originalOpen(...args);
      if (args[0] === path) {
        const originalRead = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
          const result = await originalRead(...readArgs);
          if (!changed && result.bytesRead) {
            changed = true;
            await writeFile(path, 'module.exports = 200;');
          }
          return result;
        };
      }
      return handle;
    });
    await assert.rejects(f.hash(), /Plugin source changed while refreshing/);
    openMock.mock.restore();
    const updated = await f.hash();
    assert.equal(await f.hash(), updated);
    const expected = await fixture(t);
    await expected.put('server.cjs', 'module.exports = 200;');
    assert.equal(updated, await expected.hash());
  });
}
