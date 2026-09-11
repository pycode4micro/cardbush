import assert from 'node:assert/strict';
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import { installLocalProductPlugin, localPluginInstallDialog } from '../dist-electron/localPluginInstall.js';
import { loadProductPluginCatalog, loadEnabledProductPluginMcpServers } from '../dist-electron/productPlugins.js';

const id = 'seedream-mcp';
const manifest = { name: id, version: '0.1.0', mcpServers: { fixture: { command: process.execPath, args: ['${PLUGIN_ROOT}/server.js'] } } };
const sourceText = 'throw new Error("Installation must never execute the plugin");';
const manifestNames = { openai: '.codex-plugin/plugin.json', claude: '.claude-plugin/plugin.json', portable: 'plugin.json' };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-local-plugin-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-local-plugin-'));
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { root, installed: join(root, 'installed') };
}
async function save(file, content) { await mkdir(dirname(file), { recursive: true }); await writeFile(file, content); }
async function zipFile(root, zip, filename = '下载的插件-0.1.0.ZIP') {
  const file = join(root, filename);
  await writeFile(file, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX', compression: 'DEFLATE' }));
  return file;
}
function packageZip(format = 'openai', prefix = '') {
  const zip = new JSZip();
  zip.file(prefix + manifestNames[format], JSON.stringify(format === 'portable'
    ? { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name: id, version: '0.1.0' } : manifest));
  if (format === 'portable') zip.file(prefix + 'mcp.json', JSON.stringify({ $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: { fixture: { type: 'stdio', ...manifest.mcpServers.fixture } } }));
  zip.file(prefix + 'server.js', sourceText);
  zip.folder(prefix + 'skills');
  return zip;
}
async function assertNoStage(root) {
  assert.equal((await readdir(root)).some(name => name.startsWith('.cardbush-plugin-')), false, 'temporary import and install directories are cleaned');
}

test('folder imports derive identity from the manifest and preserve the source', async t => {
  const { root, installed } = await fixture(t), source = join(root, 'seedream-mcp-0.1.0');
  const raw = JSON.stringify(manifest, null, 2);
  await save(join(source, '.codex-plugin/plugin.json'), raw);
  await save(join(source, 'server.js'), sourceText);
  const result = await installLocalProductPlugin(source, installed);
  assert.deepEqual(result, { id, manifestPath: join(installed, id, '.codex-plugin/plugin.json') });
  assert.equal(await readFile(join(source, '.codex-plugin/plugin.json'), 'utf8'), raw);
  assert.equal(await readFile(result.manifestPath, 'utf8'), raw);
  assert.deepEqual(await readdir(installed), [id]);
  await assertNoStage(root);
});

for (const format of Object.keys(manifestNames)) for (const prefix of ['', 'seedream-mcp-0.1.0/', 'download/release-0.1.0/']) {
  test(`${format} ZIP installs from ${prefix || 'archive root'} using canonical paths`, async t => {
    const { root, installed } = await fixture(t), zip = packageZip(format, prefix);
    if (prefix) { zip.file('.DS_Store', 'metadata'); zip.file('__MACOSX/._plugin', 'metadata'); }
    const path = await zipFile(root, zip), original = await readFile(path);
    const result = await installLocalProductPlugin(path, installed);
    assert.deepEqual(result, { id, manifestPath: join(installed, id, manifestNames[format]) });
    assert.deepEqual(await readFile(path), original, 'import never rewrites the user archive');
    assert.equal(await readFile(join(installed, id, 'server.js'), 'utf8'), sourceText);
    assert.deepEqual(await readdir(join(installed, id, 'skills')), [], 'empty component folders are retained');
    assert.deepEqual((await loadProductPluginCatalog([{ path: installed, source: 'user' }])).map(plugin => plugin.id), [id]);
    const servers = await loadEnabledProductPluginMcpServers([{ path: installed, source: 'user' }], join(root, 'missing-config.json'));
    assert.equal(servers[0].transport.args[0], join(installed, id) + '/server.js', 'runtime paths use the installed root');
    await assertNoStage(root);
  });
}

test('invalid packages leave the existing installation intact and clean staging', async t => {
  const { root, installed } = await fixture(t);
  await installLocalProductPlugin(await zipFile(root, packageZip()), installed);
  const cases = [
    ['missing manifest', () => new JSZip().file('README.md', 'No plugin')],
    ['multiple plugins', () => new JSZip().file('one/.codex-plugin/plugin.json', JSON.stringify(manifest)).file('two/.codex-plugin/plugin.json', JSON.stringify(manifest))],
    ['invalid manifest JSON', () => packageZip().file('.codex-plugin/plugin.json', '{')],
    ['invalid identity', () => packageZip().file('.codex-plugin/plugin.json', JSON.stringify({ ...manifest, name: '../escape' }))],
    ['Windows reserved identity', () => packageZip().file('.codex-plugin/plugin.json', JSON.stringify({ ...manifest, name: 'CON' }))],
    ['path traversal', () => packageZip().file('../escape.txt', 'no')],
    ['absolute path', () => packageZip().file('/escape.txt', 'no')],
    ['Windows drive path', () => packageZip().file('C:/escape.txt', 'no')],
    ['Windows reserved file', () => packageZip().file('CON.txt', 'no')],
    ['Windows alternate stream', () => packageZip().file('server.js:stream', 'no')],
    ['Windows trailing dot', () => packageZip().file('server.js.', 'no')],
    ['backslash path', () => packageZip().file('..\\escape.txt', 'no')],
    ['link outside package', () => packageZip().file('link', '../outside', { unixPermissions: 0o120777 })],
    ['special file', () => packageZip().file('pipe', 'no', { unixPermissions: 0o010644 })],
    ['case collision', () => packageZip().file('SERVER.JS', 'no')],
    ['file-directory collision', () => packageZip().file('conflict', 'no').file('conflict/nested', 'no')],
    ['oversized file', () => packageZip().file('large', Buffer.alloc(17 * 1024 * 1024))],
    ['expanded size limit', () => { const zip = packageZip(); for (let i = 0; i < 5; i++) zip.file(`large-${i}`, Buffer.alloc(14 * 1024 * 1024)); return zip; }],
    ['file count limit', () => { const zip = packageZip(); for (let i = 0; i < 2000; i++) zip.file(`file-${i}`, 'no'); return zip; }],
  ];
  for (const [name, create] of cases) await t.test(name, async () => {
    await assert.rejects(installLocalProductPlugin(await zipFile(root, create(), 'invalid.zip'), installed));
    assert.equal(await readFile(join(installed, id, 'server.js'), 'utf8'), sourceText);
    assert.deepEqual(await readdir(installed), [id]);
    await assertNoStage(root);
  });
  await t.test('corrupt ZIP', async () => {
    const path = join(root, 'corrupt.zip'); await writeFile(path, 'Not a ZIP');
    await assert.rejects(installLocalProductPlugin(path, installed));
    await assertNoStage(root);
  });
  await t.test('compressed size limit is checked before loading the archive', async () => {
    const path = join(root, 'oversized.zip'), handle = await open(path, 'w');
    try { await handle.truncate(32 * 1024 * 1024 + 1); } finally { await handle.close(); }
    await assert.rejects(installLocalProductPlugin(path, installed), /size limit/);
    await assertNoStage(root);
  });
});

test('ZIP installation preserves file and directory link contents through the install transaction', async t => {
  const { root, installed } = await fixture(t);
  const zip = packageZip().file('AGENTS.md', 'Shared instructions')
    .file('CLAUDE.md', 'AGENTS.md', { unixPermissions: 0o120777 })
    .file('.editor/skills', '../skills', { unixPermissions: 0o120777 });
  await installLocalProductPlugin(await zipFile(root, zip), installed);
  assert.equal(await readFile(join(installed, id, 'CLAUDE.md'), 'utf8'), 'Shared instructions');
  assert.deepEqual(await readdir(join(installed, id, '.editor/skills')), []);
  await assertNoStage(root);
});

test('file and folder pickers are separate and reject unsupported source types', () => {
  assert.deepEqual(localPluginInstallDialog().properties, ['openDirectory']);
  assert.deepEqual(localPluginInstallDialog('zip').properties, ['openFile']);
  assert.deepEqual(localPluginInstallDialog('zip').filters[0].extensions, ['zip']);
  assert.throws(() => localPluginInstallDialog('arbitrary-path'));
});
