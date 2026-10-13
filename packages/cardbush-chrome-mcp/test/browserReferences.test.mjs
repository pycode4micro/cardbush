import assert from 'node:assert/strict';
import test from 'node:test';
import { browserTabReferenceHref, parseBrowserTabReference } from '@cardbush/bush-protocol';
import { createCardbushChromeServer } from '../dist/index.js';

const context = { mcpReq: { signal: new AbortController().signal, _meta: { cardbush_session_id: 'references' } } };
const external = { id: 42, browser: 'edge', connectionId: 'a'.repeat(32), targetKey: 'external:11111111-1111-4111-8111-111111111111:42', title: 'AA [榜单]', url: 'https://example.test/a?q=(榜单)#details', active: true };

test('tab references round trip and reject unsupported addresses or incomplete external identities', () => {
  const ref = { connectionId: 'cardbush', tabId: 'browser:opaque-tab', title: 'AA [榜单]', url: external.url };
  assert.deepEqual(parseBrowserTabReference(browserTabReferenceHref(ref)), ref);
  assert.equal(browserTabReferenceHref(ref).includes(')'), false);
  for (const patch of [{ url: 'javascript:alert(1)' }, { url: 'file:///C:/private.txt' }, { url: 'https://user:secret@example.test' },
    { title: '' }, { tabId: '\n' }, { connectionId: 'chrome' }, { connectionId: external.connectionId, tabId: '42' }]) {
    assert.equal(parseBrowserTabReference(browserTabReferenceHref({ ...ref, ...patch })), null);
  }
  assert.equal(parseBrowserTabReference(browserTabReferenceHref(ref) + '#ignored'), null);
});

for (const page of [external, { ...external, browser: 'cardbush', tabId: 'browser:aa', targetKey: 'cardbush:11111111-1111-4111-8111-111111111111' }]) {
  test(`${page.browser}: page tools return ready-to-cite identities, including the original internal tabId`, async () => {
    const calls = [];
    const server = createCardbushChromeServer({ connector: async (method, params) => {
      calls.push({ method, params });
      return method === 'tabs.list' ? [page] : { ...page };
    } });
    for (const [name, args] of [['new_page', { url: page.url }], ['list_pages', {}], ['select_page', { pageId: page.id }], ['navigate_page', { type: 'reload' }]]) {
      const result = await server._registeredTools[name].handler(args, context);
      assert.notEqual(result.isError, true, result.content[0]?.text);
      const entry = name === 'list_pages' ? result.structuredContent.pages[0] : result.structuredContent;
      const reference = parseBrowserTabReference(entry.reference);
      assert.ok(reference);
      assert.equal(reference.tabId, page.browser === 'cardbush' ? page.tabId : String(page.id));
      assert.equal(reference.connectionId, page.browser === 'cardbush' ? 'cardbush' : page.connectionId);
      assert.equal(reference.url, page.url);
      assert.ok(result.content[0].text.includes(entry.reference));
      if (page.browser === 'cardbush') assert.equal(entry.tabId, page.tabId);
    }
    assert.equal(calls.filter(call => call.method === 'tabs.create').length, 1);
  });
}
