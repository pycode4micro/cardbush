import assert from 'node:assert/strict';
import test from 'node:test';
import { websiteApplication, normalizeWebApplications, webApplicationMatches } from '../dist/index.js';

test('web manifest launch, identity, scope and icon resolve independently of the install page', () => {
  const info = websiteApplication('https://example.test/shop/product/1', 'Product', {
    manifestUrl: 'https://example.test/metadata/app.json', manifest: {
      id: 'shop#section', name: ' Shop ', start_url: '../shop/start', scope: '../shop/',
      icons: [{ src: 'small.png', sizes: '48x48' }, { src: 'large.png', sizes: '192x192' }],
    },
  });
  assert.deepEqual(info, { identity: 'https://example.test/shop', title: 'Shop', url: 'https://example.test/shop/start', scope: 'https://example.test/shop/', icon: 'https://example.test/metadata/large.png', manifestUrl: 'https://example.test/metadata/app.json' });
  const [app] = normalizeWebApplications([{ ...info, id: 'web:shop' }]);
  assert.equal(webApplicationMatches(app, 'https://example.test/shop/orders'), true);
  assert.equal(webApplicationMatches(app, 'https://example.test/shop-other'), false);
  assert.equal(webApplicationMatches(app, 'https://other.test/shop/'), false);
});

test('host metadata rejects executable URLs and cross-origin launch/identity/scope', () => {
  assert.equal(websiteApplication('file:///C:/private/page.html', 'Local'), null);
  assert.equal(websiteApplication('https://user:secret@example.test/', 'Credentials'), null);
  const info = websiteApplication('https://example.test/path/page', 'Safe title', {
    manifestUrl: 'https://cdn.example.test/app.json', manifest: { start_url: 'https://other.test/', id: 'https://other.test/', scope: 'https://other.test/', icons: [{ src: 'javascript:alert(1)' }] },
  });
  assert.equal(info.url, 'https://example.test/path/page');
  assert.equal(info.identity, info.url); assert.equal(info.scope, 'https://example.test/path/'); assert.equal(info.icon, undefined);
  const [fallback] = normalizeWebApplications([{ ...websiteApplication(info.url, 'Page'), id: 'web:page' }]);
  assert.equal(webApplicationMatches(fallback, info.url + '#part'), true);
  assert.equal(webApplicationMatches(fallback, 'https://example.test/path/other'), false, 'ordinary page installs do not claim neighboring apps');
});

test('persisted web apps survive normalization, deduplicate by app identity and never become builtin or native apps', () => {
  const info = { ...websiteApplication('https://example.test/app/start', 'App'), identity: 'https://example.test/app', id: 'web:one' };
  const apps = normalizeWebApplications([info, { ...info, id: 'web:two', url: 'https://example.test/app/new' },
    { ...info, id: 'builtin:plugins' }, { ...info, id: 'web:bad', url: 'javascript:alert(1)' }]);
  assert.deepEqual(apps, [info]);
  assert.deepEqual(normalizeWebApplications(JSON.parse(JSON.stringify(apps))), apps);
});
