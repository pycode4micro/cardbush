import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync('src/features/browser/browserSiteIcons.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const key = 'cardbush.browser_site_icons.v1';
function fixture(storage = new Map()) {
  const events = new Set(), exports = {};
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  vm.runInNewContext(code, { exports, URL, localStorage, window: {
    addEventListener: (_event, listener) => events.add(listener), removeEventListener: (_event, listener) => events.delete(listener),
  } });
  return { ...exports, events, storage, localStorage };
}

test('icon sources accept web and bounded image data, without local files or active content', () => {
  const icons = fixture();
  for (const value of ['javascript:alert(1)', 'file:///C:/private/icon.png', 'https://user:password@example.com/icon', 'data:text/html;base64,AAAA', 'blob:https://example.com/id']) {
    assert.equal(icons.browserIconUrl(value), '', value);
  }
  assert.equal(icons.browserIconUrl('https://example.com/icon.svg'), 'https://example.com/icon.svg');
  assert.equal(icons.browserIconUrl('data:image/png;base64,AAAA'), 'data:image/png;base64,AAAA');
  assert.equal(icons.browserIconUrl('data:image/png;base64,' + 'A'.repeat(32_768)), '');
  assert.equal(icons.browserSiteIcon('about:blank'), '');
  assert.equal(icons.browserSiteIcon('https://example.com/account?private=true'), 'https://example.com/favicon.ico');
});

test('visited icons persist by origin, notify mounted icons, and clean up subscriptions', () => {
  const icons = fixture(); let changes = 0;
  const first = icons.subscribeBrowserSiteIcons(() => changes++), second = icons.subscribeBrowserSiteIcons(() => changes++);
  assert.equal(icons.events.size, 1);
  icons.rememberBrowserSiteIcon('https://example.com/private/page', 'https://static.example.com/brand.svg');
  assert.equal(changes, 2);
  assert.equal(icons.browserSiteIcon('https://example.com/other'), 'https://static.example.com/brand.svg');
  assert.equal(fixture(icons.storage).browserSiteIcon('https://example.com'), 'https://static.example.com/brand.svg');
  assert.ok(!icons.storage.get(key).includes('/private/page'), 'cache retains no browsing path');
  icons.rememberBrowserSiteIcon('https://example.com/other', 'https://static.example.com/brand.svg');
  assert.equal(changes, 2, 'identical metadata does not rerender icons');
  first(); assert.equal(icons.events.size, 1); second(); assert.equal(icons.events.size, 0);
});

test('optional favicon metadata remains bounded and works when browser storage is unavailable', () => {
  const icons = fixture();
  for (let i = 0; i < 160; i++) icons.rememberBrowserSiteIcon(`https://site-${i}.example/`, `https://site-${i}.example/brand.png`);
  assert.equal(JSON.parse(icons.storage.get(key)).length, 128);
  for (let i = 0; i < 12; i++) icons.rememberBrowserSiteIcon(`https://large-${i}.example/`, 'data:image/png;base64,' + 'A'.repeat(30_000));
  assert.ok(icons.storage.get(key).length <= 262_144);
  icons.localStorage.setItem = () => { throw Error('Storage full'); };
  icons.rememberBrowserSiteIcon('https://latest.example/', 'https://latest.example/brand.png');
  assert.equal(icons.browserSiteIcon('https://latest.example/'), 'https://latest.example/brand.png');
  icons.localStorage.getItem = () => { throw Error('Storage disabled'); };
  assert.equal(icons.browserSiteIcon('https://latest.example/'), 'https://latest.example/brand.png');
});
