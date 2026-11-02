import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { browserPageIcons, readBrowserIcon, readBrowserSiteIcon } from '../dist-electron/browserIcon.js';

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

test('offline app icons survive native favicon updates, serialization and shared cache eviction', () => {
  const icons = fixture(), image = 'data:image/png;base64,AAAA';
  icons.rememberBrowserSiteIconImage('https://example.com/app', image);
  icons.rememberBrowserSiteIcon('https://example.com/new', 'https://example.com/native-icon.svg');
  assert.equal(icons.cachedBrowserSiteIcon('https://example.com/app'), image);
  assert.equal(icons.browserSiteIcon('https://example.com'), 'https://example.com/native-icon.svg');
  assert.equal(fixture(icons.storage).cachedBrowserSiteIcon('https://example.com'), image);
  icons.rememberBrowserSiteIconImage('https://example.com', 'data:image/svg+xml;base64,AAAA');
  assert.equal(icons.cachedBrowserSiteIcon('https://example.com'), image, 'only decoded PNGs enter the offline store');
  for (let i = 0; i < 140; i++) icons.rememberBrowserSiteIconImage(`https://site-${i}.example`, 'data:image/png;base64,' + 'A'.repeat(10_000));
  assert.ok(icons.storage.get(key).length <= 262_144);
  assert.equal(icons.cachedBrowserSiteIcon('https://example.com'), '', 'metadata and image are evicted together');
});

test('native icon reads accept only bounded web images, including ICO and SVG', async () => {
  let calls = 0;
  const reader = async (_url, options) => { calls++; assert.equal(options.credentials, 'omit'); return new Response('icon', { headers: { 'content-type': 'image/x-icon' } }); };
  for (const url of ['file:///C:/secret', 'data:text/html,x', 'https://u:p@example.com']) assert.equal(await readBrowserIcon(url, reader), '');
  assert.equal(calls, 0);
  assert.equal(await readBrowserIcon('https://example.com/favicon.ico', reader), 'data:image/x-icon;base64,aWNvbg==');
  assert.equal(await readBrowserIcon('https://example.com/logo.svg', async () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml; charset=utf-8' } })), 'data:image/svg+xml;base64,PHN2Zy8+');
  assert.equal(await readBrowserIcon('https://example.com', async () => new Response('<html/>', { headers: { 'content-type': 'text/html' } })), '');
  assert.equal(await readBrowserIcon('https://example.com', async () => new Response(new Uint8Array(262_145), { headers: { 'content-type': 'image/png' } })), '');
});

test('homepage metadata resolves declared CDN/relative icons, entities and base URLs without active content', () => {
  const html = `<head><base href="https://cdn.example.test/assets/">
    <!-- <link rel="icon" href="https://ignored.test/comment"> -->
    <script>const sample = '<link rel="icon" href="https://ignored.test/script">';</script>
    <link rel="apple-touch-icon" href="touch.png">
    <link data-href="https://ignored.test/data" REL='shortcut ICON' href='brand.svg?a=1&amp;b=2'>
    <link rel=icon href=//static.example.test/favicon.png>
    <link rel=icon href="file:///private/icon.png"><link rel=icon href="https://u:p@example.test/icon.png">
    <link rel=icon href='brand.svg?a=1&#38;b=2'></head><link rel=icon href="https://ignored.test/body">`;
  assert.deepEqual(browserPageIcons(html, 'https://example.test/redirected/'), [
    'https://cdn.example.test/assets/brand.svg?a=1&b=2', 'https://static.example.test/favicon.png', 'https://cdn.example.test/assets/touch.png',
  ]);
});

test('site icon discovery reads only the public homepage, follows its metadata base, and skips invalid images', async () => {
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push(url); assert.equal(options.credentials, 'omit'); assert.ok(options.signal);
    if (url === 'https://example.test/') {
      const response = new Response('<head><link rel="icon" href="broken.svg"><link rel="icon" href="../brand.png"></head>', {headers:{'content-type':'text/html'}});
      Object.defineProperty(response, 'url', { value:'https://cdn.example.test/en/home' }); return response;
    }
    if (url.endsWith('broken.svg')) return new Response('<html>404</html>', {headers:{'content-type':'text/html'}});
    return new Response('PNG', {headers:{'content-type':'image/png'}});
  };
  assert.equal(await readBrowserSiteIcon('https://example.test/private/delete?id=secret', fetcher), 'data:image/png;base64,UE5H');
  assert.deepEqual(calls, ['https://example.test/', 'https://cdn.example.test/en/broken.svg', 'https://cdn.example.test/brand.png']);
  for (const bad of ['file:///private', 'javascript:alert(1)', 'https://u:p@example.test/']) assert.equal(await readBrowserSiteIcon(bad, fetcher), '');
  assert.equal(calls.length,3);
});

test('homepage discovery stops after head/byte limits and rejects non-HTML responses', async () => {
  let pulls = 0, cancelled = false;
  const result = await readBrowserSiteIcon('https://example.test/', async () => new Response(new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode('x'.repeat(32_768))); },
    cancel() { cancelled = true; },
  }), {headers:{'content-type':'text/html'}}));
  assert.equal(result,''); assert.ok(cancelled); assert.ok(pulls<=9,'only a bounded head prefix is consumed');
  let image = false;
  assert.equal(await readBrowserSiteIcon('https://example.test/', async url => {
    if (url !== 'https://example.test/') image=true;
    return new Response('<link rel="icon" href="/fake.png">', {headers:{'content-type':'application/json'}});
  }), '');
  assert.equal(image,false);
});
