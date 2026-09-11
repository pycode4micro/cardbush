import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { gzipSync } from 'node:zlib';
import { Header } from 'tar';
import JSZip from 'jszip';
import { extractPluginArchive, extractLocalPluginArchive, extractNpmPluginArchive } from '../dist-electron/pluginArchives.js';

const file = (path, data = 'original', mode = 0o644) => ({ path, type: 'File', data: Buffer.from(data), mode });
const link = (path, linkpath, type = 'SymbolicLink') => ({ path, type, linkpath });
const directory = path => ({ path, type: 'Directory' });
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-archive-links-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-archive-links-'));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return root;
}
async function zip(entries, prefix = '') {
  const archive = new JSZip();
  for (const entry of entries) {
    if (entry.type === 'Directory') archive.folder(prefix + entry.path);
    else archive.file(prefix + entry.path, entry.data ?? entry.linkpath ?? '', {
      unixPermissions: (entry.type === 'SymbolicLink' ? 0o120000 : entry.type === 'FIFO' ? 0o010000 : 0o100000) | (entry.mode ?? 0o644),
    });
  }
  return archive.generateAsync({ type: 'nodebuffer', platform: 'UNIX', compression: 'DEFLATE' });
}
function tar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const data = entry.data ?? Buffer.alloc(0);
    const header = new Header({ path: `package/${entry.path}`, type: entry.type, size: data.length, mode: entry.mode ?? 0o644, linkpath: entry.linkpath });
    header.encode();
    blocks.push(header.block, data, Buffer.alloc((512 - data.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
async function extract(format, root, entries, name = 'output') {
  const destination = join(root, name);
  if (format === 'zip') await extractLocalPluginArchive(await zip(entries), destination);
  else {
    const path = join(root, `${name}.tgz`);
    await writeFile(path, tar(entries));
    await extractNpmPluginArchive(path, destination);
  }
  return destination;
}

for (const format of ['zip', 'tar']) {
  test(`${format}: forward links, directory aliases and chains materialize without filesystem links`, async t => {
    const root = await fixture(t);
    const entries = [link('README.md', 'AGENTS.md'), link('.editor/skills', '../skills'), link('chained', 'README.md'),
      link('through-alias', '.editor/skills/task/SKILL.md'), link('alias', 'assets/deep'), link('parent-after-alias', 'alias/../value'),
      file('AGENTS.md', 'Shared instructions'), file('skills/task/SKILL.md', 'Use this skill'), directory('skills/empty'),
      directory('assets/deep'), file('assets/value', 'Resolved parent'), file('executable', 'command', 0o755), link('run', 'executable')];
    if (format === 'tar') entries.unshift(link('hard', 'package/README.md', 'Link'));
    const destination = await extract(format, root, entries);
    for (const name of ['README.md', 'chained', ...(format === 'tar' ? ['hard'] : [])]) {
      assert.equal(await readFile(join(destination, name), 'utf8'), 'Shared instructions');
      assert.equal((await lstat(join(destination, name))).isSymbolicLink(), false);
    }
    assert.equal(await readFile(join(destination, '.editor/skills/task/SKILL.md'), 'utf8'), 'Use this skill');
    assert.equal((await lstat(join(destination, '.editor/skills'))).isDirectory(), true);
    assert.deepEqual(await readdir(join(destination, '.editor/skills/empty')), []);
    assert.equal(await readFile(join(destination, 'through-alias'), 'utf8'), 'Use this skill');
    assert.equal(await readFile(join(destination, 'parent-after-alias'), 'utf8'), 'Resolved parent');
    if (process.platform !== 'win32') assert.equal((await lstat(join(destination, 'run'))).mode & 0o111, 0o111);
    await writeFile(join(destination, 'chained'), 'Changed copy');
    assert.equal(await readFile(join(destination, 'AGENTS.md'), 'utf8'), 'Shared instructions', 'installed aliases are independent copies');
  });

  const bad = [
    ['outside', [link('bad', '../outside')], /bad.*outside the plugin package/],
    ['absolute', [link('bad', '/etc/passwd')], /bad.*outside the plugin package/],
    ['drive', [link('bad', 'C:/outside')], /bad.*outside the plugin package/],
    ['backslash', [link('bad', '..\\outside')], /bad.*invalid link/],
    ['empty', [link('bad', '')], /bad.*(?:empty|invalid|linkpath required)/],
    ['dangling', [link('bad', 'missing')], /bad.*missing.*does not exist/],
    ['case-sensitive target', [link('bad', 'ORIGINAL')], /bad.*case-sensitive/],
    ['self cycle', [link('bad', 'bad')], /bad.*cyclic/],
    ['chain cycle', [link('bad', 'other'), link('other', 'bad')], /cyclic link/],
    ['directory cycle', [link('bad', '.')], /bad.*directory link creates a cycle/],
    ['nested cycle', [link('a/link', '../b'), link('b/link', '../a')], /directory link creates a cycle/],
    ['file traversal', [link('bad', 'original/../original')], /bad.*traverses a file/],
    ['special file', [{ path: 'pipe', type: 'FIFO' }], /pipe.*(?:special file|FIFO)/],
    ['link as parent', [link('alias', 'target'), file('alias/child'), directory('target')], /conflicting paths.*alias/],
    ['case collision', [file('folder/one'), file('Folder/two')], /conflicting paths/],
    ['alias escapes after resolution', [directory('dir'), link('dir/alias', '..'), link('bad', 'dir/alias/../original')], /outside the plugin package|directory link creates a cycle/],
  ];
  if (format === 'tar') bad.push(
    ['hardlink outside', [link('bad', 'other-package/original', 'Link')], /bad.*outside the plugin package/],
    ['hardlink directory', [directory('target'), link('bad', 'package/target', 'Link')], /bad.*regular file/],
    ['duplicate file', [file('duplicate'), file('duplicate')], /conflicting paths.*duplicate/],
  );
  for (const [name, entries, pattern] of bad) test(`${format}: reject ${name} before writing the destination`, async t => {
    const root = await fixture(t);
    await assert.rejects(extract(format, root, [file('original'), ...entries]), pattern);
    await assert.rejects(lstat(join(root, 'output')), { code: 'ENOENT' });
  });

  test(`${format}: alias expansion counts copied bytes and files`, async t => {
    const root = await fixture(t);
    const bytes = [file('original', Buffer.alloc(14 * 1024 * 1024)), ...Array.from({ length: 4 }, (_, i) => link(`copy${i}`, 'original'))];
    await assert.rejects(extract(format, root, bytes, 'bytes'), /size limit/);
    const files = [...Array.from({ length: 500 }, (_, i) => file(`data/f${i}`)), ...Array.from({ length: 4 }, (_, i) => link(`copy${i}`, 'data'))];
    await assert.rejects(extract(format, root, files, 'files'), /2000 file limit/);
    for (const name of ['bytes', 'files']) await assert.rejects(lstat(join(root, name)), { code: 'ENOENT' });
  });
}

test('repository links stay inside the selected plugin even when a sibling target exists', async t => {
  const root = await fixture(t);
  const archive = await zip([file('plugin/original'), file('sibling/data'), link('plugin/bad', '../sibling/data')], 'repo/');
  await assert.rejects(extractPluginArchive(archive, 'plugin', join(root, 'outside')), /bad.*outside the plugin package/);
  // Links outside the selected package are not part of its validation or installation.
  const valid = await zip([file('plugin/AGENTS.md'), link('plugin/README.md', 'AGENTS.md'), link('unused', '/outside')], 'repo/');
  const destination = join(root, 'selected');
  await extractPluginArchive(valid, 'plugin', destination);
  assert.equal(await readFile(join(destination, 'README.md'), 'utf8'), 'original');
});

test('local ZIP retains enclosing folders and never overwrites an existing tree', async t => {
  const root = await fixture(t), entries = [file('release/AGENTS.md'), link('release/README.md', './AGENTS.md')];
  const destination = await extract('zip', root, entries);
  assert.equal(await readFile(join(destination, 'release/README.md'), 'utf8'), 'original');
  await assert.rejects(extract('zip', root, [file('release/AGENTS.md', 'changed')]), /empty staging directory/);
  assert.equal(await readFile(join(destination, 'release/AGENTS.md'), 'utf8'), 'original');
});

test('ZIP link targets preserve literal UTF-8 names and reject invalid encoding', async t => {
  const root = await fixture(t);
  const destination = await extract('zip', root, [file('\uFEFFname', 'exact target'), file('name', 'different target'), link('alias', '\uFEFFname')]);
  assert.equal(await readFile(join(destination, 'alias'), 'utf8'), 'exact target');
  await assert.rejects(extract('zip', root, [{ ...link('bad', ''), data: Buffer.from([0xff]) }], 'invalid'), /bad.*invalid UTF-8 target/);
  await assert.rejects(lstat(join(root, 'invalid')), { code: 'ENOENT' });
});

test('truncated tar entries reject through the promise before writing files', async t => {
  const root = await fixture(t), archive = join(root, 'truncated.tgz');
  const header = new Header({ path: 'package/truncated', type: 'File', size: 4096, mode: 0o644 });
  header.encode();
  await writeFile(archive, gzipSync(Buffer.concat([header.block, Buffer.from('partial')])));
  await assert.rejects(extractNpmPluginArchive(archive, join(root, 'output')), /truncated.*(?:Truncated|size)/);
  await assert.rejects(lstat(join(root, 'output')), { code: 'ENOENT' });
});
