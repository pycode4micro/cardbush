import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { BrowserConfigStore } from '../dist/index.js';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-browser-config-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-browser-config-'));
    await rm(root, { recursive: true, force: true });
  });
  return { root, store: new BrowserConfigStore(join(root, 'config', 'browser.json')) };
}

test('defaults to Google and persists normalized home page across host instances', async t => {
  const { store } = await fixture(t);
  const initial = await store.read();
  assert.equal(initial.startPage, 'https://www.google.com/');
  const saved = await store.update({ startPage: ' www.example.com/start?q=中文 ', expectedRevision: initial.revision });
  assert.equal(saved.startPage, 'https://www.example.com/start?q=%E4%B8%AD%E6%96%87');
  assert.equal(saved.revision, initial.revision + 1);
  assert.deepEqual(await new BrowserConfigStore(store.path).read(), saved);
  assert.deepEqual(JSON.parse(await readFile(store.path, 'utf8')), saved);
  for (const startPage of ['http://localhost:3000/', 'about:blank', '']) {
    const before = await store.read();
    assert.equal((await store.update({ startPage, expectedRevision: before.revision })).startPage, startPage || initial.startPage);
  }
});

test('rejects unsafe home pages without replacing valid configuration', async t => {
  const { store } = await fixture(t);
  const saved = await store.update({ startPage: 'example.com', expectedRevision: 1 });
  for (const startPage of ['javascript:alert(1)', 'data:text/html,hello', 'file:///C:/private.txt',
    'chrome://settings', 'https://name:secret@example.com', 'https://', 'not a hostname', null]) {
    await assert.rejects(store.update({ startPage, expectedRevision: saved.revision }));
    assert.deepEqual(await store.read(), saved);
  }
  assert.throws(() => new BrowserConfigStore('relative.json'), /absolute/);
});

test('serializes competing writers, rejects stale revisions, and keeps corrupt config visible', async t => {
  const { store } = await fixture(t);
  const competing = new BrowserConfigStore(store.path);
  const results = await Promise.allSettled([
    store.update({ startPage: 'https://one.test/', expectedRevision: 1 }),
    competing.update({ startPage: 'https://two.test/', expectedRevision: 1 }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /changed/);
  assert.equal((await store.read()).revision, 2);
  assert.deepEqual(await readdir(join(store.path, '..')), ['browser.json']);
  await writeFile(store.path, '{broken');
  await assert.rejects(store.read(), SyntaxError);
  await assert.rejects(store.update({ startPage: '', expectedRevision: 2 }), SyntaxError);
  assert.equal(await readFile(store.path, 'utf8'), '{broken');
});
