import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import test from 'node:test';
const exports = {};
new Function('exports', ts.transpileModule(readFileSync('src/features/appCenter/appCenterModel.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(exports);
const { normalizeAppCenterPreferences, applicationLink, applicationCatalog, applicationReference, moveApplication } = exports;
test('app preferences validate external links and preserve shortcut order independently of plugin availability', () => {
  const normalized = normalizeAppCenterPreferences({ display: 'hover', shortcuts: ['builtin:settings', 'plugin:demo:canvas', 'builtin:settings'], links: [
    { id: 'external:local', title: ' Preview ', url: 'http://localhost:8888' },
    { id: 'external:local', title: 'Duplicate', url: 'https://example.test' },
    { id: 'builtin:settings', title: 'Impersonated', url: 'https://example.test' },
    { id: 'external:bad', title: 'Script', url: 'javascript:alert(1)' },
  ] });
  assert.deepEqual(normalized, { display: 'hover', shortcuts: ['builtin:settings', 'plugin:demo:canvas'], links: [{ id: 'external:local', title: 'Preview', url: 'http://localhost:8888/' }] });
  for (const address of ['file:///C:/program.exe', 'data:text/html,x', 'https://user:secret@example.test', 'app:run', {}, null]) assert.equal(applicationLink(address), undefined);
  assert.equal(applicationLink('https://example.test/apps?q=test'), 'https://example.test/apps?q=test');
  assert.equal(normalizeAppCenterPreferences({ display: 'unknown' }).display, 'always');
});
test('only explicit launchable pages enter the app center; connectors, tools and settings renderers do not', () => {
  const canvas = { kind: 'app', id: 'canvas', name: 'Canvas', app: { kind: 'url', url: 'https://example.test/designer' } };
  const plugins = [{ id: 'demo', name: 'Demo', installed: true, enabled: true, components: [canvas, { kind: 'app', id: 'slack', mcp: { registeredAppId: 'slack' } }, { kind: 'mcp', id: 'tools' }, { kind: 'runtime', id: 'demo', runtime: { settings: true } }] },
    { id: 'absent', installed: false, enabled: true, components: [canvas] },
    { id: 'disabled', installed: true, enabled: false, components: [canvas] },
    { id: 'removing', installed: true, enabled: true, removalPending: true, components: [canvas] },
    { id: 'invalid', installed: true, enabled: true, components: [{ ...canvas, app: { kind: 'url', url: 'javascript:alert(1)' } }] }];
  const entries = applicationCatalog('zh', plugins, normalizeAppCenterPreferences(null));
  assert.equal(entries.length, 4); assert.deepEqual(entries.slice(0, 3).map(app => app.id), ['builtin:plugins', 'builtin:automations', 'builtin:settings']);
  const app = entries[3]; assert.equal(app.id, 'plugin:demo:canvas'); assert.equal(app.launch.url, canvas.app.url);
  assert.deepEqual(applicationReference(app), { kind: 'application', id: app.id, title: 'Canvas', applicationKind: 'plugin', target: 'demo', componentId: 'canvas' });
  assert.ok(entries.every(app => !('command' in app) && !('toolCallId' in app)));
});
test('drag reorder supports moving before an item, appending and adding without duplication', () => {
  assert.deepEqual(moveApplication(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
  assert.deepEqual(moveApplication(['a', 'b', 'c'], 'a'), ['b', 'c', 'a']);
  assert.deepEqual(moveApplication(['a', 'b'], 'c', 'b'), ['a', 'c', 'b']);
  assert.deepEqual(moveApplication(['a', 'b'], 'a', 'a'), ['a', 'b']);
  const prefs = normalizeAppCenterPreferences({ order: ['builtin:settings', 'builtin:plugins', 'builtin:settings'] });
  assert.deepEqual(applicationCatalog('zh', [], prefs).map(app => app.id), ['builtin:settings', 'builtin:plugins', 'builtin:automations']);
});
