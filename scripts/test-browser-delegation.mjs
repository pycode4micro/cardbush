import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const exports = {};
const code = ts.transpileModule(readFileSync('electron/integratedBrowser.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function('exports', 'require', code)(exports, createRequire(import.meta.url));
const { IntegratedBrowser } = exports;

function fixture() {
  const owners = [11, 22].map(id => ({ id, isDestroyed: () => false })), guests = new Map();
  let nextId = 100;
  function register(tabId, owner = owners[0], url = 'https://example.com/') {
    const destroyed = [];
    const guest = { id: ++nextId, hostWebContents: owner, closed: false,
      isDestroyed() { return this.closed; }, getType: () => 'webview', getURL: () => url, getTitle: () => 'Same URL',
      once(event, callback) { if (event === 'destroyed') destroyed.push(callback); },
      debugger: { isAttached: () => false },
      destroy() { this.closed = true; destroyed.forEach(callback => callback()); } };
    guests.set(guest.id, guest);
    browser.register(owner, { tabId, guestWebContentsId: guest.id });
    return { tabId, id: guest.id, guest };
  }
  const browser = new IntegratedBrowser({ defaultOwner: () => owners[0], getContents: id => guests.get(id),
    action(ownerId, action) { if (action.action === 'open') register(action.tabId, owners.find(owner => owner.id === ownerId), action.url); } });
  const call = (scopeId, method, params = {}) => browser.request(method, { ...params, scopeId });
  const create = scopeId => { browser.select(scopeId); return call(scopeId, 'tabs.create', { url: 'https://example.com/' }); };
  const list = scopeId => call(scopeId, 'tabs.list');
  const bind = (scopeId, page, owner = owners[0]) => browser.bind(owner, scopeId, [{ tabId: page.tabId, pageId: String(page.id) }]);
  return { browser, owners, guests, register, call, create, list, bind };
}

test('returned pages preserve independent parent and sibling selections during continuations', async () => {
  const f = fixture(), original = await f.create('parent');
  for (const child of ['child-a', 'child-b']) f.browser.inheritScope('parent', child);
  const a = await f.create('child-a'), b = await f.create('child-b');
  assert.equal((await f.list('parent')).find(page => page.selected).id, original.id);
  for (const [child, selected] of [['child-a', a], ['child-b', b]]) {
    f.browser.inheritScope('parent', child);
    const pages = await f.list(child);
    assert.deepEqual(pages.map(page => page.id).sort(), [original.id, a.id, b.id].sort());
    assert.equal(pages.find(page => page.selected).id, selected.id);
  }
  // A new explicit parent @ reference still reaches an existing child.
  f.bind('parent', original);
  f.browser.inheritScope('parent', 'child-a');
  assert.equal((await f.list('child-a')).find(page => page.selected).id, original.id);
});

test('delegation returns only pages created after the trusted relation, not prior pages or child references', async () => {
  const f = fixture(), prior = await f.create('child'), referenced = f.register('private-reference');
  f.browser.registerDelegation('parent', 'child');
  f.bind('child', referenced);
  assert.equal(f.browser.hasScope('parent'), false);
  const created = await f.create('child');
  assert.deepEqual((await f.list('parent')).map(page => page.id), [created.id]);
  for (const page of [prior, referenced]) {
    await assert.rejects(f.call('parent', 'tabs.activate', { tabId: page.id }), { code: 'cardbush_page_not_authorized' });
  }
  f.browser.select('unrelated');
  await assert.rejects(f.call('unrelated', 'tabs.activate', { tabId: created.id }), { code: 'cardbush_page_not_authorized' });
});

test('a parent bound in another window stops upward grants at that boundary', async () => {
  const f = fixture(), rootPage = await f.create('root'), otherWindow = f.register('window-two', f.owners[1]);
  f.browser.registerDelegation('root', 'parent');
  f.bind('parent', otherWindow, f.owners[1]);
  f.browser.registerDelegation('parent', 'child');
  const created = await f.create('child');
  assert.deepEqual((await f.list('parent')).map(page => page.id), [otherWindow.id]);
  assert.deepEqual((await f.list('root')).map(page => page.id), [rootPage.id]);
  assert.deepEqual((await f.list('child')).map(page => page.id), [created.id]);
  await assert.rejects(f.call('parent', 'tabs.activate', { tabId: created.id }), { code: 'cardbush_page_not_authorized' });
});

test('closing a returned page clears grants while keeping other selected pages', async () => {
  const f = fixture(), original = await f.create('parent');
  f.browser.inheritScope('parent', 'child');
  f.browser.inheritScope('child', 'grandchild');
  const created = await f.create('grandchild');
  await f.call('parent', 'tabs.close', { tabId: created.id });
  for (const scope of ['parent', 'child', 'grandchild']) {
    assert.deepEqual((await f.list(scope)).map(page => page.id), [original.id]);
    await assert.rejects(f.call(scope, 'tabs.activate', { tabId: created.id }), { code: 'cardbush_page_not_authorized' });
  }
  assert.equal((await f.list('parent')).find(page => page.selected).id, original.id);
});

test('UI closure and replacement never retarget returned grants to a new guest at the same URL', async () => {
  const f = fixture();
  f.browser.registerDelegation('parent', 'child');
  const created = await f.create('child');
  f.guests.get(created.id).destroy();
  const replacement = f.register(created.tabId);
  for (const scope of ['parent', 'child']) {
    await assert.rejects(f.list(scope), { code: 'cardbush_page_unavailable' });
    await assert.rejects(f.call(scope, 'tabs.activate', { tabId: replacement.id }), { code: 'cardbush_page_not_authorized' });
  }
});
