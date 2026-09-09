import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { create, Header } from 'tar';
import { PluginMarketplaceService } from '../dist-electron/pluginMarketplaces.js';
import { gitSource, npmSource, acquireNpmPlugin, runAcquisitionCommand } from '../dist-electron/pluginAcquisition.js';

const parent = resolve(tmpdir()), root = await mkdtemp(join(parent, 'cardbush-plugin-acquisition-'));
const repository = join(root, 'repository');
const calls = [];
const save = async (path, value) => { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value)); };
const manifest = name => ({ $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json', name, version: '1.0.0', description: name });
const policy = { installation: 'AVAILABLE', authentication: 'ON_INSTALL' };
let npmArchive;
const run = async (command, args, cwd) => {
  calls.push({ command, args: [...args] });
  if (args.includes('pack')) {
    assert.ok(args.includes('--ignore-scripts'));
    assert.ok(args.includes('fixture-plugin@^1.0.0'));
    const pack = args[args.indexOf('--pack-destination') + 1];
    await cp(npmArchive, join(pack, 'fixture.tgz'));
    return JSON.stringify([{ filename: 'fixture.tgz', version: '1.2.0', shasum: 'fixture-sha' }]);
  }
  // Exercise real Git against a temporary fixture, with no network or credentials.
  // Only this test runner substitutes the remote and permits a local transport.
  let local = args.map(arg => arg === 'protocol.file.allow=never' ? 'protocol.file.allow=always' : arg);
  if (args.includes('remote') && args.includes('add')) local = [...local.slice(0, -1), repository];
  return runAcquisitionCommand(command, local, cwd);
};
const git = args => runAcquisitionCommand('git', ['-C', repository, '-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', ...args], root);
try {
  assert.deepEqual(gitSource('git@github.com:owner/repo.git#release/v1'), { url: 'git@github.com:owner/repo.git', ref: 'release/v1' });
  assert.equal(gitSource('https://gitlab.example/team/plugins.git#main').ref, 'main');
  assert.equal(gitSource('ssh://git@example.test/team/repo.git').url, 'ssh://git@example.test/team/repo.git');
  for (const source of ['file:///outside', 'ext::shell command', 'https://user:secret@example.test/repo', 'https://example.test/repo#--upload-pack=bad']) assert.throws(() => gitSource(source));
  assert.equal(npmSource({ package: '@team/plugin', version: '^1.0.0' }).package, '@team/plugin');
  for (const version of ['1.0.0-beta.1', '1.0.0+build.2', '>=1.0.0-beta.1 <2.0.0', 'next']) assert.equal(npmSource({ package: 'plugin', version }).version, version);
  for (const version of ['file:../plugin', 'https://example.test/x.tgz', 'git+ssh://example.test/x', '--help']) assert.throws(() => npmSource({ package: 'plugin', version }));
  assert.throws(() => npmSource({ package: 'plugin', registry: 'https://user:secret@example.test' }));
  const utf8 = '插件市场';
  const splitOutput = `const text = Buffer.from(${JSON.stringify(utf8)}); process.stdout.write(text.subarray(0, 1)); setTimeout(() => process.stdout.write(text.subarray(1)), 50);`;
  assert.equal(await runAcquisitionCommand(process.execPath, ['-e', splitOutput], root), utf8, 'stream chunks must not corrupt UTF-8 catalog text');

  await mkdir(repository);
  await runAcquisitionCommand('git', ['init', '--template=', '-b', 'main', repository], root);
  await save(join(repository, '.agents/plugins/marketplace.json'), { name: 'fixture-market', plugins: [
    { name: 'git-plugin', source: { source: 'local', path: './plugins/git-plugin' }, policy },
    { name: 'npm-plugin', source: { source: 'npm', package: 'fixture-plugin', version: '^1.0.0' }, policy },
  ] });
  await save(join(repository, 'plugins/git-plugin/plugin.json'), manifest('git-plugin'));
  await save(join(repository, 'plugins/git-plugin/skills/greet/SKILL.md'), '---\nname: greet\ndescription: Greet\n---\nOriginal revision.');
  await git(['add', '.']);
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Fixture']);
  const original = (await git(['rev-parse', 'HEAD'])).trim();
  const packageRoot = join(root, 'npm-package');
  await save(join(packageRoot, 'package/plugin.json'), manifest('npm-plugin'));
  await save(join(packageRoot, 'package/skills/npm-skill/SKILL.md'), '---\nname: npm-skill\ndescription: Test npm\n---\nPackage fixture.');
  npmArchive = join(root, 'fixture.tgz');
  await create({ file: npmArchive, cwd: packageRoot, gzip: true }, ['package']);
  const options = { dataRoot: join(root, 'markets'), userPluginRoot: join(root, 'installed'), bundledPluginRoot: resolve('assets/plugins'),
    fetch: async () => { throw new Error('Unexpected network request'); }, runAcquisition: run };
  const service = new PluginMarketplaceService(options);
  const source = await service.addSource('ssh://git@fixture.example/team/plugins.git#main');
  assert.equal(source.kind, 'git');
  assert.equal((await service.catalog(source.id)).entries.filter(entry => entry.available).length, 2);
  // A changed branch must not alter a preview of the catalog's selected commit.
  await save(join(repository, 'plugins/git-plugin/skills/greet/SKILL.md'), 'Changed revision.');
  await git(['add', '.']); await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-m', 'Changed']);
  const preview = await service.preview(source.id, 'git-plugin');
  assert.equal(preview.revision, original);
  assert.equal(preview.format, 'agent-plugins');
  assert.deepEqual(preview.issues, []);
  await service.install(preview.token);
  assert.match(await readFile(join(options.userPluginRoot, 'git-plugin/skills/greet/SKILL.md'), 'utf8'), /Original revision/);
  assert.ok(calls.some(call => call.args.includes('fetch') && call.args.at(-1) === original));
  assert.ok(!calls.some(call => call.args.includes('checkout')), 'acquisition never checks out or runs repository hooks');
  const npmPreview = await service.preview(source.id, 'npm-plugin');
  assert.equal(npmPreview.revision, 'npm:1.2.0:fixture-sha');
  assert.equal(npmPreview.format, 'agent-plugins');
  await service.install(npmPreview.token);
  assert.ok(await readFile(join(options.userPluginRoot, 'npm-plugin/plugin.json'), 'utf8'));
  await service.remove(source.id);
  assert.deepEqual((await readdir(options.userPluginRoot)).sort(), ['git-plugin', 'npm-plugin']);
  assert.deepEqual(await readdir(join(options.dataRoot, 'acquisitions')), [], 'temporary Git snapshots are cleaned after reading');

  // Malformed archives fail through the promise and do not create a destination.
  const badHeader = new Header({ path: 'package/link', type: 'SymbolicLink', linkpath: '/outside', size: 0, mode: 0o777 });
  badHeader.encode();
  npmArchive = join(root, 'bad.tgz');
  await writeFile(npmArchive, gzipSync(Buffer.concat([badHeader.block, Buffer.alloc(1024)])));
  const stage = join(root, 'bad-stage'); await mkdir(stage);
  await assert.rejects(acquireNpmPlugin(npmSource({ package: 'fixture-plugin', version: '^1.0.0' }), stage, join(stage, 'plugin'), run), /links or special files/);
  assert.ok(!(await readdir(stage)).includes('plugin'));
  console.log('Plugin acquisition passed: Git/SSH/ref parsing, real pinned Git snapshots, npm range declarations, script-free pack arguments, staged installation, malformed tar rejection and source removal.');
} finally {
  assert.ok(root.startsWith(parent + sep + 'cardbush-plugin-acquisition-'));
  await rm(root, { recursive: true, force: true, maxRetries: 3 });
}
