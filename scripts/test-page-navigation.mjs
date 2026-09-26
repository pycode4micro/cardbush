import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import test from 'node:test';
const exports = {};
new Function('exports', ts.transpileModule(readFileSync('src/features/navigation/pageHistory.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(exports);
const { PageHistory } = exports;
const settle = () => new Promise(resolve => queueMicrotask(resolve));

test('one window history traverses conversations, plugin details, settings and calendar selections', async () => {
  const restores = [], chat = { section: 'chat', id: 'a' }, plugins = { section: 'plugins' }, settings = { section: 'settings', tab: 'appearance' };
  const history = new PageHistory(chat, route => { restores.push(route); history.observe(route); });
  history.observe(plugins); await settle();
  history.update('plugins:page', 'catalog', 'details'); await settle();
  history.observe(settings); await settle();
  history.observe({ section: 'automations' }); await settle();
  history.update('calendar:date', '2026-09-26', '2026-10-01'); history.update('calendar:view', 'month', 'day'); await settle();
  history.back(); assert.equal(history.read('calendar:date', ''), '2026-09-26'); assert.equal(history.read('calendar:view', ''), 'month');
  history.back(); assert.deepEqual(restores.at(-1), settings);
  history.back(); assert.deepEqual(restores.at(-1), plugins); assert.equal(history.read('plugins:page', ''), 'details');
  history.back(); assert.equal(history.read('plugins:page', ''), 'catalog');
  history.back(); assert.deepEqual(restores.at(-1), chat); assert.equal(history.canGoBack, false);
  history.forward(); history.forward(); assert.equal(history.read('plugins:page', ''), 'details'); assert.equal(history.canGoForward, true);
});
test('rapid cross-page back/forward ignores stale renders and never adds duplicate visits', async () => {
  const restored = [], history = new PageHistory('chat', route => restored.push(route));
  history.observe('plugins'); await settle(); history.observe('settings'); await settle();
  history.back(); history.back(); history.observe('settings'); history.observe('plugins'); await settle();
  assert.equal(history.canGoBack, false); assert.equal(history.canGoForward, true);
  history.observe('chat'); await settle(); history.forward(); history.observe('plugins'); await settle();
  history.forward(); history.observe('settings'); await settle();
  assert.equal(history.canGoForward, false); assert.deepEqual(restored, ['plugins', 'chat', 'plugins', 'settings']);
});
test('a new visit after Back drops the old forward branch; repeated renders do not', async () => {
  const history = new PageHistory('chat', route => history.observe(route));
  history.observe('plugins'); await settle(); history.observe('settings'); await settle(); history.back();
  history.observe('plugins'); await settle(); assert.equal(history.canGoForward, true);
  history.observe('automations'); await settle(); assert.equal(history.canGoForward, false);
  history.back(); history.back(); assert.equal(history.canGoBack, false);
});
test('removed conversations or remote connections are skipped without disturbing remaining visits', async () => {
  const available = new Set(['a', 'b', 'cloud', 'settings']), restored = [];
  const history = new PageHistory('a', route => { restored.push(route); history.observe(route); }, route => available.has(route));
  for (const page of ['b', 'cloud', 'settings']) { history.observe(page); await settle(); }
  available.delete('b'); available.delete('cloud'); history.back();
  assert.equal(restored.at(-1), 'a'); history.forward(); assert.equal(restored.at(-1), 'settings');
});
test('equal state and repeated mount observations do not create navigation; first-state fallback survives Back', async () => {
  const history = new PageHistory('plugins', route => history.observe(route));
  history.update('tab', 'plugins', 'plugins'); history.observe('plugins'); await settle(); assert.equal(history.canGoBack, false);
  history.update('tab', 'plugins', 'skills'); await settle(); history.back();
  assert.equal(history.read('tab', 'wrong'), 'plugins'); history.forward(); assert.equal(history.read('tab', 'wrong'), 'skills');
});
