import assert from 'node:assert/strict';
import test from 'node:test';
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
