import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { BrowserConfigStore } from '@cardbush/product-host';
import { createCardbushChromeServer } from '../dist/index.js';

test('new_page reads live host preferences and preserves explicit targets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-chrome-start-page-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-chrome-start-page-'));
    await rm(root, { recursive: true, force: true });
  });
  const browserConfigPath = join(root, 'browser.json'), requests = [];
  const server = createCardbushChromeServer({ browserConfigPath, connector: async (method, params) => {
    assert.equal(method, 'tabs.create'); requests.push(params.url);
    return { id: requests.length, url: params.url };
  } });
  const open = input => server._registeredTools.new_page.handler(input, {
    mcpReq: { signal: new AbortController().signal, _meta: { cardbush_session_id: 'homepage-test' } },
  });
  assert.notEqual((await open({})).isError, true);
  const store = new BrowserConfigStore(browserConfigPath);
  await store.update({ startPage: 'example.com/start', expectedRevision: 1 });
  assert.notEqual((await open({})).isError, true);
  await store.update({ startPage: 'about:blank', expectedRevision: 2 });
  assert.notEqual((await open({})).isError, true);
  await writeFile(browserConfigPath, '{broken');
  assert.notEqual((await open({ url: 'https://explicit.test/path?query=1' })).isError, true);
  assert.equal((await open({})).isError, true, 'failed config reads are reported, not silently replaced');
  assert.deepEqual(requests, ['https://www.google.com/', 'https://example.com/start', 'about:blank', 'https://explicit.test/path?query=1']);
});
