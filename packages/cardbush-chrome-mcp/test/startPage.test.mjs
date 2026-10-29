import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { BrowserConfigStore } from '@cardbush/product-host';
import { createCardbushBrowserServer } from '../dist/index.js';

test('new_page opens a blank tab independently of legacy home preferences and preserves explicit targets', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-chrome-start-page-'));
  t.after(async () => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-chrome-start-page-'));
    await rm(root, { recursive: true, force: true });
  });
  const browserConfigPath = join(root, 'browser.json'), requests = [];
  const server = createCardbushBrowserServer({ browserConfigPath, connector: async (method, params) => {
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
  assert.notEqual((await open({})).isError, true, 'new tabs do not depend on legacy configuration');
  assert.deepEqual(requests, ['about:blank', 'about:blank', 'about:blank', 'https://explicit.test/path?query=1', 'about:blank']);
});

test('new_page and select_page default to background control and forward explicit presentation requests', async t => {
  const calls = [];
  const server = createCardbushBrowserServer({connector: async (method, params) => {
    calls.push({method, ...params}); return {id:42, active:false};
  }});
  t.after(() => server.close());
  const context = {mcpReq:{signal:new AbortController().signal, _meta:{cardbush_session_id:'quiet-browser'}}};
  for (const [tool, input] of [['new_page', {}], ['select_page', {pageId:42}],
    ['new_page', {url:'https://example.com/', background:false}], ['select_page', {pageId:42, bringToFront:true}]]) {
    const result = await server._registeredTools[tool].handler(input, context);
    assert.notEqual(result.isError, true);
  }
  assert.deepEqual(calls.map(call => [call.method, call.background ?? call.bringToFront]),
    [['tabs.create',true], ['tabs.activate',false], ['tabs.create',false], ['tabs.activate',true]]);
});
