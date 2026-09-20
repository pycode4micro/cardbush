import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(new URL('../src/features/sidebar/conversationArchives.ts', import.meta.url), 'utf8'),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const require = createRequire(import.meta.url);
const key = 'cardbush_archived_conversation_ids';
function fixture() {
  const values = new Map();
  const window = new EventTarget();
  window.localStorage = {
    getItem: name => values.get(name) ?? null,
    setItem: (name, value) => values.set(name, value),
  };
  function load() {
    const module = { exports: {} };
    new Function('require', 'module', 'exports', 'window', code)(require, module, module.exports, window);
    return module.exports;
  }
  return { values, window, load, ids: () => JSON.parse(values.get(key) ?? '[]') };
}

test('archive metadata survives a fresh store and restoration keeps other archives', () => {
  const f = fixture();
  f.load().setConversationsArchived(['first', 'second', 'first'], true);
  assert.deepEqual(f.ids(), ['first', 'second']);
  const restarted = f.load();
  restarted.setConversationsArchived(['first'], false);
  assert.deepEqual(f.ids(), ['second']);
  restarted.setConversationsArchived(['third'], true);
  assert.deepEqual(f.ids(), ['second', 'third']);
  restarted.setConversationsArchived(['second', 'third'], false);
  assert.deepEqual(f.ids(), []);
});

test('storage failure never publishes successful restoration or loses existing entries', () => {
  const f = fixture();
  const store = f.load();
  store.setConversationsArchived(['keep'], true);
  let changes = 0;
  f.window.addEventListener('cardbush-conversation-archives-changed', () => changes++);
  const write = f.window.localStorage.setItem;
  f.window.localStorage.setItem = () => { throw Error('Disk full'); };
  assert.throws(() => store.setConversationsArchived(['keep'], false), /Disk full/);
  assert.equal(changes, 0);
  assert.deepEqual(f.ids(), ['keep']);
  f.window.localStorage.setItem = write;
  store.setConversationsArchived(['new'], true);
  assert.deepEqual(f.ids(), ['keep', 'new']);
});

test('writes merge the latest persisted state and tolerate malformed legacy entries', () => {
  const f = fixture();
  const store = f.load();
  store.setConversationsArchived(['local'], true);
  f.values.set(key, JSON.stringify(['local', 'other-window', null, 4, '', '  ']));
  store.setConversationsArchived(['local'], false);
  assert.deepEqual(f.ids(), ['other-window']);
  for (const raw of ['invalid JSON', '{"unexpected":true}']) {
    f.values.set(key, raw);
    store.setConversationsArchived(['valid'], true);
    assert.deepEqual(f.ids(), ['valid']);
  }
});
