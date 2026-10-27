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

function fixture({ autoAck = true, actionTimeoutMs, ownerVisible, presentation = page => page } = {}) {
  const owners = [11, 22].map(id => ({ id, isDestroyed: () => false })), guests = new Map();
  const actions = [];
  let nextId = 100;
  function register(tabId, owner = owners[0], url = 'https://example.com/') {
    const destroyed = [];
    const guest = { id: ++nextId, tabId, hostWebContents: owner, closed: false,
      isDestroyed() { return this.closed; }, getType: () => 'webview', getURL: () => url, getTitle: () => 'Same URL',
      once(event, callback) { if (event === 'destroyed') destroyed.push(callback); },
      debugger: { isAttached: () => false },
      destroy() { this.closed = true; destroyed.forEach(callback => callback()); } };
    guests.set(guest.id, guest);
    browser.register(owner, { tabId, guestWebContentsId: guest.id });
    return { tabId, id: guest.id, guest };
  }
  const response = action => ({ requestId: action.requestId, pages: (action.tabIds ?? [action.tabId]).map(tabId => {
    const guest = [...guests.values()].find(guest => guest.tabId === tabId && !guest.closed);
    return presentation({ tabId, guestWebContentsId: action.action === 'close' ? null : guest?.id ?? null,
      inWorkspace: Boolean(guest), active: true, visible: true });
  }) });
  const browser = new IntegratedBrowser({ defaultOwner: () => owners[0], getContents: id => guests.get(id), actionTimeoutMs, ownerVisible,
    action(ownerId, action) {
      actions.push(action);
      if (action.action === 'open') register(action.tabId, owners.find(owner => owner.id === ownerId), action.url);
      if (action.requestId && autoAck) browser.acknowledge(ownerId, response(action));
    } });
  const call = (scopeId, method, params = {}) => browser.request(method, { ...params, scopeId });
  const create = scopeId => { browser.select(scopeId); return call(scopeId, 'tabs.create', { url: 'https://example.com/' }); };
  const list = async scopeId => (await call(scopeId, 'tabs.list')).pages;
  const bind = (scopeId, page, owner = owners[0]) => browser.bind(owner, scopeId, [{ tabId: page.tabId, pageId: String(page.id) }]);
  return { browser, owners, guests, register, call, create, list, bind, actions, response };
}

test('tab binding waits for the owning window to acknowledge the exact referenced guest', async () => {
  const f = fixture({ autoAck: false }), page = f.register('original');
  let settled = false;
  const pending = f.bind('conversation', page).then(result => { settled = true; return result; });
  const receipt = f.response(f.actions.at(-1));
  f.browser.acknowledge(f.owners[1].id, receipt);
  f.browser.acknowledge(f.owners[0].id, { ...receipt, requestId: 'unrelated' });
  f.browser.acknowledge(f.owners[0].id, { ...receipt, pages: [null] });
  f.browser.acknowledge(f.owners[0].id, { ...receipt, pages: [{ ...receipt.pages[0], tabId: 'another-tab' }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'foreign, stale or malformed receipts cannot report success');
  f.browser.acknowledge(f.owners[0].id, receipt);
  assert.equal((await pending)[0].id, page.id);
});

test('missing UI acknowledgement fails without opening a replacement', async () => {
  const f = fixture({ autoAck: false, actionTimeoutMs: 20 });
  await assert.rejects(f.bind('conversation', f.register('original')), { code: 'cardbush_presentation_timeout' });
  assert.deepEqual(f.actions.map(action => action.action), ['bind']);
});

test('binding rejects a replacement guest or an unattached page', async () => {
  for (const change of [{ guestWebContentsId: 9000 }, { inWorkspace: false }]) {
    const f = fixture({ presentation: page => ({ ...page, ...change }) });
    await assert.rejects(f.bind('conversation', f.register('original')), { code: 'cardbush_page_not_presented' });
  }
});

test('selected background pages and minimized windows never dispatch a screenshot', async () => {
  for (const options of [{ presentation: page => ({ ...page, active: false, visible: false }) }, { ownerVisible: () => false }]) {
    const f = fixture(options), page = await f.create('conversation');
    assert.equal(page.selected, true);
    assert.equal(page.visible, false);
    await assert.rejects(f.call('conversation', 'debugger.command', { tabId: page.id, command: 'Page.captureScreenshot' }), error =>
      error.code === 'cardbush_page_not_visible' && error.details.inputDispatched === false);
    for (const command of ['Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText']) {
      await assert.rejects(f.call('conversation', 'debugger.command', {tabId:page.id, command}), error =>
        error.code === 'cardbush_page_not_interactive' && error.details.inputDispatched === false);
    }
  }
});

test('background creation and selection do not request inspector activation', async () => {
  const f = fixture({ presentation: page => ({ ...page, active: false, visible: false }) });
  const a = await f.create('conversation'), b = await f.create('conversation');
  assert.ok(f.actions.filter(action => action.action === 'open').every(action => action.background === true));
  const selected = await f.call('conversation', 'tabs.activate', {tabId:a.id});
  assert.equal(selected.selected, true);
  assert.equal(selected.active, false);
  assert.equal(selected.visible, false);
  assert.equal(f.actions.at(-1).action, 'inspect');
  await f.call('conversation', 'tabs.activate', {tabId:b.id, bringToFront:true});
  assert.equal(f.actions.at(-1).action, 'activate');
  await f.call('conversation', 'tabs.create', {url:'https://example.com/show', background:false});
  assert.equal(f.actions.findLast(action => action.action === 'open').background, false);
});

test('concurrent integrated commands wait for background renderer initialization and detach clears control', async () => {
  const f = fixture(), page = await f.create('conversation'), calls = [], onDetach = [];
  let attached = false, ready;
  f.guests.get(page.id).debugger = {
    isAttached: () => attached, attach() { attached = true; },
    once(event, callback) { assert.equal(event, 'detach'); onDetach.push(callback); },
    detach() { attached = false; onDetach.splice(0).forEach(callback => callback()); },
    sendCommand(command) {
      calls.push(command);
      return command === 'Emulation.setFocusEmulationEnabled' ? new Promise(resolve => { ready = resolve; }) : Promise.resolve({value:'read'});
    },
  };
  const first = f.call('conversation', 'debugger.command', {tabId:page.id, command:'Runtime.evaluate'});
  const second = f.call('conversation', 'debugger.command', {tabId:page.id, command:'Runtime.evaluate'});
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['Emulation.setFocusEmulationEnabled']);
  ready({});
  await Promise.all([first,second]);
  assert.deepEqual(calls, ['Emulation.setFocusEmulationEnabled','Runtime.evaluate','Runtime.evaluate']);
  await f.call('conversation','debugger.detachScope');
  assert.equal(attached,false);
});

test('cancelling a presentation wait ignores a late reply and allows the next request', async () => {
  const f = fixture({ autoAck: false }), page = f.register('original');
  const binding = f.bind('conversation', page);
  f.browser.acknowledge(f.owners[0].id, f.response(f.actions.at(-1)));
  await binding;
  const abort = new AbortController();
  const pending = f.browser.request('tabs.activate', { scopeId: 'conversation', tabId: page.id }, abort.signal);
  const late = f.response(f.actions.at(-1));
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  f.browser.acknowledge(f.owners[0].id, late);
  const next = f.list('conversation');
  f.browser.acknowledge(f.owners[0].id, f.response(f.actions.at(-1)));
  assert.equal((await next)[0].id, page.id);
});

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
  await f.bind('parent', original);
  f.browser.inheritScope('parent', 'child-a');
  assert.equal((await f.list('child-a')).find(page => page.selected).id, original.id);
});

test('delegation returns only pages created after the trusted relation, not prior pages or child references', async () => {
  const f = fixture(), prior = await f.create('child'), referenced = f.register('private-reference');
  f.browser.registerDelegation('parent', 'child');
  await f.bind('child', referenced);
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
  await f.bind('parent', otherWindow, f.owners[1]);
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
    await assert.rejects(f.call(scope, 'tabs.activate', { tabId: created.id }), {
      code: scope === 'grandchild' ? 'cardbush_page_unavailable' : 'cardbush_page_not_authorized',
    });
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
    const snapshot = await f.call(scope, 'tabs.list');
    assert.deepEqual(snapshot.pages, []);
    assert.equal(snapshot.selectedPageId, created.id);
    assert.equal(snapshot.selectionState, 'missing');
    await assert.rejects(f.call(scope, 'tabs.activate', { tabId: created.id }), { code: 'cardbush_page_unavailable' });
    await assert.rejects(f.call(scope, 'tabs.activate', { tabId: replacement.id }), { code: 'cardbush_page_not_authorized' });
  }
});
