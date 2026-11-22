import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { activePluginRuntime, pluginRuntimeExecutable } from '@cardbush/platform';
import { managePluginRuntime } from '../dist-electron/pluginRuntimeManager.mjs';
import { resolveRuntimeBuild } from '../dist-electron/pluginRuntimeCatalog.mjs';
import { installedPluginDependencyRuntime, pluginDependencyDirectory, preparePluginDependencies } from '../dist-electron/pluginDependencies.mjs';

const arch = process.arch, platform = process.platform;
const nodeFile = platform === 'win32' ? `win-${arch}-zip` : platform === 'darwin' ? `osx-${arch}-tar` : `linux-${arch}`;
const nodeArchive = v => `node-v${v}-${platform === 'win32' ? 'win' : platform}-${arch}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
const badChecksum = '0'.repeat(64);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-runtimes-'));
  t.after(() => rm(root, {recursive:true, force:true}));
  return root;
}
async function seed(kind, version, root) {
  const executable = pluginRuntimeExecutable(kind, version, root);
  await mkdir(dirname(executable), {recursive:true});
  await writeFile(executable, 'fixture');
}
const offline = () => { throw Error('Unexpected network access'); };

test('plugin dependency staging installs and launches with the same managed runtime', async t => {
  const root = await fixture(t), plugin = join(root, 'plugin');
  await mkdir(plugin);
  await writeFile(join(plugin, 'pyproject.toml'), '[project]\nname = "plugin-test"\nversion = "1.0.0"\n');
  const servers = { main: { command: 'python', args: ['-m', 'plugin_test'] } };
  await assert.rejects(preparePluginDependencies(plugin, servers, undefined, () => undefined, offline), /CardBush-managed python/);
  assert.equal(installedPluginDependencyRuntime(plugin, 'python', root), undefined);
  const staged = join(root, 'staged');
  await mkdir(staged);
  await writeFile(join(staged, 'pyproject.toml'), await readFile(join(plugin, 'pyproject.toml')));
  await seed('python', '3.12.1', root);
  const executable = pluginRuntimeExecutable('python', '3.12.1', root);
  const userBase = join(staged, pluginDependencyDirectory, 'python');
  const site = join(userBase, 'site-layout-from-interpreter', 'site-packages');
  const invocations = [];
  await preparePluginDependencies(staged, servers, undefined, kind => {
    assert.equal(kind, 'python'); return { executable, version: '3.12.1' };
  }, async invocation => {
    assert.equal(invocation.executable, executable);
    assert.equal(invocation.cwd, staged);
    invocations.push(invocation);
    if (invocation.args[1] === '-S') {
      assert.equal(invocation.env.PYTHONUSERBASE, userBase);
      assert.deepEqual(invocation.args, ['-I', '-S', '-c', 'import site; print(site.getusersitepackages())']);
      return { exitCode: 0, stdout: site + '\n', stderr: '', outputTruncated: false };
    }
    assert.deepEqual(invocation.args.slice(0, 5), ['-I', '-m', 'pip', '--isolated', 'install']);
    assert.equal(invocation.args.at(-2), site);
    return { exitCode: 0, stdout: '', stderr: '', outputTruncated: false };
  });
  assert.equal(invocations.length, 2);
  assert.deepEqual(installedPluginDependencyRuntime(staged, 'python', root), {
    executable, env: { PYTHONUSERBASE: userBase, PYTHONPATH: '', PYTHONNOUSERSITE: '' },
  });
  assert.equal(installedPluginDependencyRuntime(staged, process.execPath, root), undefined);
});

test('Node packages with a lock file stage production dependencies under managed npm', async t => {
  const root = await fixture(t), plugin = join(root, 'plugin');
  await mkdir(plugin);
  await writeFile(join(plugin, 'package.json'), '{}');
  await writeFile(join(plugin, 'package-lock.json'), '{}');
  await seed('node', '24.2.0', root);
  const executable = pluginRuntimeExecutable('node', '24.2.0', root);
  const npm = join(dirname(executable), ...(platform === 'win32' ? [] : ['..', 'lib']), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await mkdir(dirname(npm), { recursive: true });
  await writeFile(npm, 'fixture');
  await preparePluginDependencies(plugin, { main: { command: 'node', args: ['index.js'] } }, undefined,
    kind => { assert.equal(kind, 'node'); return { executable, version: '24.2.0' }; }, async invocation => {
      assert.equal(invocation.executable, executable);
      assert.deepEqual(invocation.args, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
      assert.equal(invocation.cwd, plugin);
      return { exitCode: 0, stdout: '', stderr: '', outputTruncated: false };
    });
  assert.deepEqual(installedPluginDependencyRuntime(plugin, 'node', root), { executable, env: {} });
});

test('opening settings is offline, activation validates installed versions and rollback survives restart', async t => {
  const root = await fixture(t);
  assert.deepEqual((await managePluginRuntime('list', undefined, undefined, root, offline)).map(x => x.versions), [[], []]);
  assert.deepEqual(await readdir(root), []);
  for (const version of ['3.11.1','3.12.1']) await seed('python', version, root);
  await managePluginRuntime('install','python','3.12.1',root,offline);
  await managePluginRuntime('use','python','3.11.1',root,offline);
  assert.equal(activePluginRuntime('python',root).version, '3.11.1');
  await assert.rejects(managePluginRuntime('use','python','3.10.1',root,offline), /not installed/);
  await assert.rejects(managePluginRuntime('install','python','../other',root,offline), /numeric/);
  await assert.rejects(managePluginRuntime('install','../outside','3.12',root,offline), /runtime --help/);
});

test('updating selects a numeric version in the active series and leaves the current interpreter intact on download failure', async t => {
  const root = await fixture(t);
  await seed('node','24.2.0',root);
  await managePluginRuntime('use','node','24.2.0',root,offline);
  const request = async url => {
    if (url.endsWith('/index.json')) return Response.json(['25.0.0','24.8.0','24.12.0'].map(version => ({version:'v' + version, files:[nodeFile]})));
    if (url.endsWith('/SHASUMS256.txt')) return new Response(badChecksum + '  ' + nodeArchive('24.12.0'));
    assert.ok(url.endsWith('/v24.12.0/' + nodeArchive('24.12.0')));
    return new Response('corrupt archive');
  };
  assert.equal((await resolveRuntimeBuild('node','24',request)).version,'24.12.0');
  await assert.rejects(managePluginRuntime('update','node',undefined,root,request), /checksum mismatch/);
  assert.equal(await readFile(join(root,'node','active'),'utf8'),'24.2.0\n');
  assert.deepEqual((await readdir(join(root,'node'))).sort(), ['24.2.0','active']);
});
