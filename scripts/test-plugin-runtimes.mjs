import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { activePluginRuntime, pluginRuntimeExecutable } from '@cardbush/platform';
import { managePluginRuntime } from '../dist-electron/pluginRuntimeManager.mjs';
import { resolveRuntimeBuild } from '../dist-electron/pluginRuntimeCatalog.mjs';

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
