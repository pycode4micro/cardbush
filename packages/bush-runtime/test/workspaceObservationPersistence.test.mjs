import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { WorkspaceObservationStore } from '../dist/index.js';
import { withWorkspaceFileAccess, openWorkspaceFile } from '../dist/workspaceFileAccess.js';
import { WorkspacePathGuard } from '../dist/workspacePathGuard.js';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'cardbush-observation-persist-')));
  t.after(async () => {
    t.mock.restoreAll(); syncBuiltinESMExports();
    assert.equal(dirname(root), await fs.realpath(tmpdir()));
    assert.ok(basename(root).startsWith('cardbush-observation-persist-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const path = join(root, 'project-cognition.json');
  const store = new WorkspaceObservationStore({ persistencePath: path });
  return { root, path, store };
}

test('overlapping workspace and state directory persist only after sandbox pins close, including failed tools', async t => {
  const { root, path, store } = await fixture(t);
  const source = join(root, 'source.txt'); await fs.writeFile(source, 'verified');
  await store.record('previous', source, 'old', root);
  const before = await fs.readFile(path, 'utf8');
  const failure = new Error('tool failed after its completed read');
  await assert.rejects(withWorkspaceFileAccess([source], false, async () => {
    const handle = await openWorkspaceFile(source);
    try {
      const buffer = Buffer.alloc(8);
      assert.equal((await handle.read(buffer, 0, buffer.length, 0)).bytesRead, 8);
      assert.equal(buffer.toString(), 'verified');
    }
    finally { await handle.close(); }
    await store.record('reader', source, 'new', root);
    assert.equal(await fs.readFile(path, 'utf8'), before, 'no state rename while this scope pins the parent');
    throw failure;
  }), error => error === failure);
  const restored = new WorkspaceObservationStore({ persistencePath: path });
  assert.equal(restored.matches('resumed', source, 'new', undefined, root), true);
  assert.equal(restored.matches('resumed', source, 'old', undefined, root), false);
  assert.ok(!(await fs.readdir(root)).some(name => name.includes('.tmp-')));
});

test('concurrent file scopes and sessions keep every completed observation on restart', async t => {
  const { root, path, store } = await fixture(t);
  const files = Array.from({ length: 6 }, (_, i) => join(root, `file-${i}.txt`));
  await Promise.all(files.map(file => fs.writeFile(file, 'source')));
  const results = await Promise.allSettled(files.map((file, i) => withWorkspaceFileAccess([file], false,
    () => store.record(`session-${i}`, file, `hash-${i}`, root))));
  assert.deepEqual(results.map(result => result.status), files.map(() => 'fulfilled'), JSON.stringify(results));
  const restored = new WorkspaceObservationStore({ persistencePath: path });
  files.forEach((file, i) => assert.equal(restored.matches('new-session', file, `hash-${i}`, undefined, root), true));
  assert.ok(!(await fs.readdir(root)).some(name => name.includes('.tmp-')));
});

test('failed atomic publication preserves the old state and does not poison the next save', async t => {
  const { root, path, store } = await fixture(t);
  const source = join(root, 'source.txt');
  await store.record('first', source, 'old', root);
  const before = await fs.readFile(path, 'utf8');
  const original = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === path) throw Object.assign(new Error('simulated storage failure'), { code: 'EIO' });
    return original(from, to);
  }); syncBuiltinESMExports();
  await assert.rejects(store.record('second', source, 'new', root), { code: 'EIO' });
  assert.equal(await fs.readFile(path, 'utf8'), before);
  assert.ok(!(await fs.readdir(root)).some(name => name.includes('.tmp-')));
  t.mock.restoreAll(); syncBuiltinESMExports();
  await store.record('third', source, 'latest', root);
  assert.equal(new WorkspaceObservationStore({ persistencePath: path }).matches('resume', source, 'latest', undefined, root), true);
});

test('a different Windows path pin delays only state publication, without weakening the guard', { skip: process.platform !== 'win32' }, async t => {
  const { root, path, store } = await fixture(t);
  const guard = new WorkspacePathGuard(); t.after(() => guard.close());
  await guard.pin(root);
  let blocked = 0, attempts = 0;
  const original = fs.rename;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to !== path) return original(from, to);
    attempts++;
    try { return await original(from, to); }
    catch (error) {
      assert.equal(error.code, 'EBUSY'); blocked++;
      await guard.close();
      throw error;
    }
  }); syncBuiltinESMExports();
  await store.record('reader', join(root, 'source.txt'), 'verified', root);
  assert.equal(blocked, 1); assert.equal(attempts, 2);
  assert.equal(new WorkspaceObservationStore({ persistencePath: path }).matches('resumed', join(root, 'source.txt'), 'verified', undefined, root), true);
});
