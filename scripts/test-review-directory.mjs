import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { join, relative, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createRequire } from 'node:module';
const { readWorkspaceDirectory } = createRequire(import.meta.url)('../dist-electron/workspaceFiles.js');

test('workspace directory pages preserve the real hierarchy without recursively reading a project', async t => {
  const temporary = await realpath(await mkdtemp(join(tmpdir(), 'cardbush-review-tree-')));
  t.after(async () => {
    const delta = relative(await realpath(tmpdir()), temporary);
    assert.ok(delta && !delta.startsWith('..') && !isAbsolute(delta));
    await rm(temporary, { recursive: true, force: true });
  });
  const root = join(temporary, 'project');
  await mkdir(root);
  await Promise.all(['.git', '.config', 'node_modules', 'src'].map(name => mkdir(join(root, name))));
  await writeFile(join(root, '.env.example'), 'PUBLIC_SETTING=value');
  await writeFile(join(root, 'src', 'unchanged.ts'), 'Unchanged content');
  await Promise.all(Array.from({ length: 240 }, (_, index) => writeFile(join(root, `file-${index}.ts`), `${index}`)));
  const first = await readWorkspaceDirectory({ rootPath: root });
  assert.equal(first.entries.length, 200);
  assert.equal(first.nextOffset, 200);
  const second = await readWorkspaceDirectory({ rootPath: root, offset: first.nextOffset });
  const names = [...first.entries, ...second.entries].map(entry => entry.name);
  assert.equal(new Set(names).size, 244);
  assert.ok(names.includes('.env.example') && names.includes('.config') && names.includes('node_modules'));
  assert.ok(!names.includes('.git') && !names.includes('unchanged.ts'));
  const child = await readWorkspaceDirectory({ rootPath: root, directoryPath: join(root, 'src') });
  assert.deepEqual(child.entries.map(entry => entry.name), ['unchanged.ts']);
  await assert.rejects(readWorkspaceDirectory({ rootPath: root, directoryPath: temporary }), /outside/);
  await mkdir(join(temporary, 'outside'));
  await symlink(join(temporary, 'outside'), join(root, '.linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(readWorkspaceDirectory({ rootPath: root, directoryPath: join(root, '.linked') }), /outside/);
  assert.equal((await readWorkspaceDirectory({ rootPath: root })).entries.find(entry => entry.name === '.linked').kind, 'file');
});
