import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

function modules(storage = new Map()) {
  const cache = new Map(), localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  function load(file) {
    file = resolve(file); if (cache.has(file)) return cache.get(file);
    const exports = {}; cache.set(file, exports);
    const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function('exports', 'require', 'localStorage', 'window', code)(exports,
      spec => spec.startsWith('.') ? load(resolve(dirname(file), spec + '.ts')) : createRequire(file)(spec), localStorage, new EventTarget());
    return exports;
  }
  return { load, storage, localStorage };
}
const { load } = modules();
const model = load('src/features/inspector/savedInspectorLayouts.ts');
const panels = load('src/features/inspector/panelLayout.ts');
const tabs = [
  { id: 'a', kind: 'resource', detail: { target: 'https://example.com/start', title: 'Initial', newTab: true } },
  { id: 'b', kind: 'resource', detail: { target: 'C:/Work/notes.md', title: 'Notes' } },
];
const navigation = { a: { url: 'https://example.com/current?q=work', title: 'Current page' }, b: { url: 'cardbush-file://text-preview/?path=C:/Work/notes.md', title: 'Notes' } };
const layout = { kind: 'split', axis: 'y', ratio: .67, first: { kind: 'page', id: 'b' }, second: { kind: 'page', id: 'a' } };
const saved = { id: 'research', name: 'Research', ...model.captureInspectorLayout(layout, tabs, navigation) };

test('saved multipage captures live URLs, original file paths and rearranged proportions without runtime payloads', () => {
  assert.deepEqual(saved.pages.map(page => page.detail.target), ['C:/Work/notes.md', 'https://example.com/current?q=work']);
  assert.equal(saved.layout.ratio, .67); assert.equal(saved.layout.axis, 'y');
  assert.equal(saved.pages[1].detail.title, 'Current page');
  assert.equal('newTab' in saved.pages[1].detail, false);
  assert.deepEqual(model.normalizeSavedInspectorLayouts(JSON.parse(JSON.stringify([saved]))), [saved]);
  assert.equal(model.captureInspectorLayout(layout, [tabs[0], { id: 'b', kind: 'shadow', context: { secret: 'never serialize' } }], navigation), null);
});

test('restoring reuses live pages, keeps unrelated tabs and produces distinct panes even for repeated URLs', () => {
  const resumed = model.restoreInspectorLayout(saved, tabs, navigation);
  assert.equal(resumed.tabs[0], tabs[1]); assert.equal(resumed.tabs[1], tabs[0], 'original objects preserve mounted guest state');
  assert.deepEqual(resumed.layout, layout);
  const restarted = model.restoreInspectorLayout(saved, [], {});
  const repeated = model.restoreInspectorLayout(saved, restarted.tabs, {});
  assert.deepEqual(repeated.tabs.map(tab => tab.id), restarted.tabs.map(tab => tab.id));
  assert.ok(repeated.tabs.every((tab, i) => tab === restarted.tabs[i]));
  const duplicate = { ...saved, pages: saved.pages.map(page => ({ ...page, detail: { target: 'https://example.com/' } })) };
  const one = model.restoreInspectorLayout(duplicate, [], {});
  const partial = model.restoreInspectorLayout(duplicate, [one.tabs[1]], {});
  assert.equal(new Set(panels.panelIds(partial.layout)).size, 2, 'an existing second pane is not stolen for the first');
});

test('invalid saved trees and unsafe addresses are rejected without losing valid presets', () => {
  for (const mutate of [
    value => { value.layout.second.id = 'missing'; },
    value => { value.layout.second.id = value.layout.first.id; },
    value => { value.pages[0].detail.target = 'javascript:alert(1)'; },
    value => { value.pages[0].detail.target = 'https://user:password@example.com/'; },
    value => { value.layout.ratio = null; },
  ]) {
    const bad = structuredClone(saved); bad.id = 'bad'; mutate(bad);
    assert.deepEqual(model.normalizeSavedInspectorLayouts([bad, saved]), [saved]);
  }
});

test('layouts survive a fresh store, rename in place, reject duplicates, and preserve storage on quota failure', () => {
  const first = modules(), store = first.load('src/features/inspector/useSavedInspectorLayouts.ts');
  store.saveInspectorLayout(saved);
  const second = modules(first.storage), restarted = second.load('src/features/inspector/useSavedInspectorLayouts.ts');
  restarted.saveInspectorLayout({ ...saved, name: 'Renamed' });
  assert.equal(JSON.parse(first.storage.get(model.savedInspectorLayoutsKey)).length, 1);
  assert.throws(() => restarted.saveInspectorLayout({ ...saved, id: 'another', name: 'Renamed' }), /duplicate-name/);
  const before = first.storage.get(model.savedInspectorLayoutsKey);
  second.localStorage.setItem = () => { throw Error('quota'); };
  assert.throws(() => restarted.removeInspectorLayout(saved.id), /quota/);
  assert.equal(first.storage.get(model.savedInspectorLayoutsKey), before);
  store.removeInspectorLayout(saved.id);
  assert.equal(first.storage.get(model.savedInspectorLayoutsKey), '[]');
});
