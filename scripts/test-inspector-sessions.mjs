import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const cache = new Map();
function load(file) {
  file = resolve(file); if (cache.has(file)) return cache.get(file);
  const exports = {}; cache.set(file, exports);
  const code = ts.transpileModule(readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function('exports', 'require', code)(exports, spec => spec.startsWith('.') ? load(resolve(dirname(file), spec + '.ts')) : createRequire(file)(spec));
  return exports;
}
const { emptyInspectorSessions, inspectorSessionsReducer: reduce, inspectorSession: view, retainedInspectorTabs: retained,
  inspectorTabOwner: owner, localInspectorWorkspace: local, agentInspectorWorkspace: remote } = load('src/features/inspector/inspectorSessions.ts');
const resource = id => ({ id, kind: 'resource', detail: { target: 'https://example.com/' + id } });
const open = (state, workspaceId, id) => reduce(reduce(state, { type: 'tabs', workspaceId, action: { type: 'open', tab: resource(id) } }), { type: 'open-state', workspaceId, update: true });
const act = (state, workspaceId, action) => reduce(state, { type: 'tabs', workspaceId, action });

for (const collapsed of [false, true]) test(`first-send adoption retains draft tabs, selection and panel state (collapsed: ${collapsed})`, () => {
  const draft = local(''), session = local('created');
  let state = open(open(open(emptyInspectorSessions, draft, 'one'), draft, 'two'), local('other'), 'foreign');
  state = reduce(state, { type: 'toggle-lock', id: 'one' });
  state = act(state, draft, { type: 'activate', id: 'one' });
  state = reduce(state, { type: 'open-state', workspaceId: draft, update: !collapsed });
  state = open(state, session, 'early-background');
  const original = retained(state), other = state.workspaces[local('other')];
  state = reduce(state, { type: 'adopt-draft', from: draft, to: session });
  assert.deepEqual(view(state, session).tabs.map(tab => tab.id), ['one', 'two', 'early-background']);
  assert.equal(view(state, session).activeId, 'one');
  assert.equal(view(state, session).open, !collapsed);
  assert.equal(state.workspaces[draft], undefined, 'the next blank chat cannot inherit adopted pages');
  assert.equal(state.workspaces[local('other')], other);
  assert.equal(owner(state, 'one'), session, 'a draft-owned locked page also gets its real owner');
  for (const tab of original) assert.equal(retained(state).find(item => item.id === tab.id), tab, 'never recreate a guest');
  const repeated = reduce(state, { type: 'adopt-draft', from: draft, to: session });
  assert.equal(repeated, state, 'repeated preparation is a no-op once the draft was consumed');
});

test('draft adoption is scoped to its host and moves layout objects without copying them', () => {
  const { adoptInspectorSessionState } = load('src/features/inspector/inspectorSessions.ts');
  const draft = remote('host-a', ''), session = remote('host-a', 'created');
  let state = open(open(open(emptyInspectorSessions, local(''), 'local'), remote('host-b', ''), 'remote-b'), draft, 'remote-a');
  state = reduce(state, { type: 'adopt-draft', from: draft, to: session });
  assert.equal(owner(state, 'local'), local(''));
  assert.equal(owner(state, 'remote-b'), remote('host-b', ''));
  assert.equal(owner(state, 'remote-a'), session);
  const layout = { kind: 'page', id: 'remote-a' }, values = { [draft]: layout, [local('')]: null };
  const adopted = adoptInspectorSessionState(values, { from: draft, to: session });
  assert.equal(adopted[session], layout);
  assert.equal(Object.hasOwn(adopted, draft), false);
  assert.equal(adopted[local('')], null);
  assert.equal(values[draft], layout, 'state updates do not mutate earlier snapshots');
});

test('explicit browser references move original resources out of the draft and retain locked ownership', () => {
  let state = open(open(open(emptyInspectorSessions, local(''), 'referenced'), local(''), 'unrelated'), local('other'), 'locked');
  state = reduce(state, { type: 'toggle-lock', id: 'locked' });
  state = open(state, local('new-conversation'), 'blank');
  const original = retained(state).find(tab => tab.id === 'referenced');
  state = reduce(state, { type: 'bind-browser', workspaceId: local('new-conversation'), ids: ['referenced', 'locked'] });
  assert.equal(view(state, local('new-conversation')).activeId, 'referenced');
  assert.equal(view(state, local('new-conversation')).open, true);
  assert.equal(owner(state, 'referenced'), local('new-conversation'));
  assert.equal(retained(state).find(tab => tab.id === 'referenced'), original, 'same tab object, no recreated URL');
  assert.equal(owner(state, 'locked'), local('other'), 'locks retain their owner');
  assert.deepEqual(state.workspaces[local('')].tabs.map(tab => tab.id), ['unrelated']);
  assert.equal(retained(state).length, 4, 'binding creates no duplicate pages');
  state = reduce(state, { type: 'toggle-lock', id: 'locked' });
  assert.deepEqual(view(state, local('new-conversation')).tabs.map(tab => tab.id), ['blank', 'referenced']);
});

test('local, assistant and remote conversations keep independent tabs, selection and collapsed state', () => {
  const scopes = [local('a'), local('b'), local('personal-assistant'), remote('host-a', 'a'), remote('host-b', 'a')];
  assert.equal(new Set(scopes).size, scopes.length);
  let state = emptyInspectorSessions;
  scopes.forEach((scope, index) => { state = open(state, scope, 'page-' + index); });
  state = open(state, scopes[0], 'a-second');
  state = act(state, scopes[0], { type: 'activate', id: 'page-0' });
  state = reduce(state, { type: 'open-state', workspaceId: scopes[1], update: false });
  for (const [index, scope] of scopes.entries()) {
    assert.equal(view(state, scope).activeId, 'page-' + index);
    assert.equal(view(state, scope).open, index !== 1);
  }
  assert.equal(retained(state).length, 6);
  assert.equal(view(state, local('fresh')).tabs.length, 0);
});

test('locked pages cross conversations without moving ownership or duplicating their instance', () => {
  let state = open(emptyInspectorSessions, 'a', 'shared');
  state = reduce(state, { type: 'toggle-lock', id: 'shared' });
  assert.deepEqual(view(state, 'fresh').tabs.map(tab => tab.id), ['shared']);
  assert.equal(view(state, 'fresh').open, true);
  state = open(state, 'b', 'b-only');
  state = act(state, 'b', { type: 'open', tab: resource('shared') });
  assert.equal(owner(state, 'shared'), 'a');
  assert.equal(retained(state).length, 2);
  assert.equal(view(state, 'b').activeId, 'shared');
  state = reduce(state, { type: 'toggle-lock', id: 'shared' });
  assert.deepEqual(view(state, 'b').tabs.map(tab => tab.id), ['b-only']);
  assert.equal(view(state, 'b').activeId, 'b-only');
  assert.equal(view(state, 'a').activeId, 'shared');
  assert.equal(retained(state).length, 2, 'unlocking never disposes the original page');
});

test('background actions update their own workspace; close-all keeps other conversations alive', () => {
  let state = open(open(emptyInspectorSessions, 'a', 'a-only'), 'b', 'b-only');
  state = open(state, 'a', 'background');
  assert.equal(view(state, 'b').activeId, 'b-only');
  state = act(state, 'b', { type: 'close', ids: new Set(view(state, 'b').tabs.map(tab => tab.id)) });
  assert.equal(view(state, 'b').open, false);
  assert.deepEqual(view(state, 'a').tabs.map(tab => tab.id), ['a-only', 'background']);
  state = reduce(state, { type: 'toggle-lock', id: 'background' });
  assert.equal(view(state, 'b').open, false, 'an explicit collapse survives lock changes elsewhere');
  state = act(state, 'b', { type: 'close', ids: new Set(['background']) });
  assert.deepEqual(view(state, 'a').tabs.map(tab => tab.id), ['a-only']);
  assert.equal(state.lockedIds.size, 0);
});

test('a globally saved preset creates separate live panes per conversation and reuses locks', () => {
  const { restoreInspectorLayout } = load('src/features/inspector/savedInspectorLayouts.ts');
  const saved = { id: 'preset', name: 'Research', pages: ['one', 'two'].map(id => ({ id, detail: resource(id).detail })),
    layout: { kind: 'split', axis: 'x', ratio: .6, first: { kind: 'page', id: 'one' }, second: { kind: 'page', id: 'two' } } };
  const a = restoreInspectorLayout(saved, [], {}, local('a')), b = restoreInspectorLayout(saved, [], {}, local('b'));
  assert.equal(new Set([...a.tabs, ...b.tabs].map(tab => tab.id)).size, 4);
  const repeat = restoreInspectorLayout(saved, a.tabs, {}, local('a'));
  assert.equal(repeat.tabs[0], a.tabs[0]);
  const withLock = restoreInspectorLayout(saved, [a.tabs[0]], {}, local('b'));
  assert.equal(withLock.tabs[0], a.tabs[0], 'an explicitly shared page keeps its original live instance');
});

test('an explicitly opened host portal can be viewed from either conversation without duplicate mounts', () => {
  const portal = { id: 'ssh-desktop:host-a', kind: 'conversation', title: 'Desktop' };
  let state = act(emptyInspectorSessions, 'a', { type: 'open', tab: portal });
  assert.equal(view(state, 'b').tabs.length, 0, 'portals do not appear in other conversations automatically');
  state = act(state, 'b', { type: 'open', tab: portal });
  assert.equal(view(state, 'b').activeId, portal.id);
  assert.equal(retained(state).length, 1, 'the same context portal has a single DOM outlet');
  state = act(state, 'b', { type: 'close', ids: new Set([portal.id]) });
  assert.equal(view(state, 'a').activeId, portal.id);
  assert.equal(retained(state).length, 1);
  state = act(state, 'b', { type: 'open', tab: portal });
  state = reduce(state, { type: 'dispose', ids: new Set([portal.id]) });
  assert.equal(retained(state).length, 0, 'host teardown removes its portal from every referencing conversation');
});

for (const parentSelected of [true, false]) test(`browser actions belong to the root conversation when the ${parentSelected ? 'parent' : 'child'} first selects a browser`, async () => {
  const { IntegratedBrowser } = load('electron/integratedBrowser.ts');
  const actions = [], guests = new Map();
  let state = open(emptyInspectorSessions, local('unrelated'), 'unrelated-page');
  const owner = { id: 11, isDestroyed: () => false };
  let nextId = 30;
  const browser = new IntegratedBrowser({ defaultOwner: () => owner, getContents: id => guests.get(id), action: (_ownerId, action) => {
    actions.push(action);
    const workspace = local(action.sessionId);
    if (action.action === 'open') state = open(state, workspace, action.tabId);
    else if (action.action !== 'inspect') state = act(state, workspace, action.action === 'close'
      ? { type: 'close', ids: new Set([action.tabId]) } : { type: 'activate', id: action.tabId });
    if (action.action === 'open') {
      const guest = { id: ++nextId, tabId: action.tabId, hostWebContents: owner, isDestroyed: () => false, getType: () => 'webview', getURL: () => action.url,
        getTitle: () => 'Background', once() {}, debugger: { isAttached: () => false } };
      guests.set(guest.id, guest); browser.register(owner, { tabId: action.tabId, guestWebContentsId: guest.id });
    }
    if (action.requestId) browser.acknowledge(owner.id, { requestId: action.requestId, pages: (action.tabIds ?? [action.tabId]).map(tabId => {
      const exists = retained(state).some(tab => tab.id === tabId);
      return { tabId, guestWebContentsId: exists ? [...guests.values()].find(guest => guest.tabId === tabId)?.id ?? null : null,
        inWorkspace: view(state, workspace).tabs.some(tab => tab.id === tabId), active: view(state, workspace).activeId === tabId, visible: false };
    }) });
  } });
  if (parentSelected) browser.select('parent');
  assert.equal(browser.inheritScope('parent', 'child'), parentSelected);
  assert.equal(browser.inheritScope('child', 'grandchild'), parentSelected);
  browser.select('grandchild');
  assert.equal(browser.hasScope('parent'), parentSelected, 'UI ownership never creates parent browser grants');
  const page = await browser.request('tabs.create', { scopeId: 'grandchild', url: 'https://example.com/' });
  for (const scopeId of ['parent', 'child', 'grandchild']) {
    assert.deepEqual((await browser.request('tabs.list', { scopeId })).pages.map(page => page.id), [page.id], 'created pages return to every trusted ancestor');
  }
  assert.equal(view(state, local('parent')).activeId, page.tabId, 'the page appears in the root inspector');
  assert.equal(view(state, local('grandchild')).tabs.length, 0, 'no hidden child workspace is created');
  assert.equal(view(state, local('unrelated')).activeId, 'unrelated-page', 'background work does not take over another conversation');
  await browser.request('tabs.activate', { scopeId: 'grandchild', tabId: page.id });
  await browser.request('tabs.close', { scopeId: 'grandchild', tabId: page.id });
  for (const scopeId of ['parent', 'child', 'grandchild']) {
    assert.deepEqual((await browser.request('tabs.list', { scopeId })).pages, [], 'explicit close removes the shared page from all granted scopes');
  }
  assert.deepEqual(actions.filter(action => action.action !== 'inspect').map(action => [action.action, action.sessionId]), [['open', 'parent'], ['activate', 'parent'], ['close', 'parent']]);
  assert.equal(view(state, local('parent')).tabs.length, 0);
});

test('trusted browser delegation rejects reparenting and cycles without granting pages', () => {
  const { IntegratedBrowser } = load('electron/integratedBrowser.ts');
  const browser = new IntegratedBrowser({ defaultOwner: () => null, getContents: () => undefined, action() {} });
  browser.registerDelegation('parent', 'child');
  browser.registerDelegation('parent', 'child');
  browser.registerDelegation('child', 'grandchild');
  assert.throws(() => browser.registerDelegation('other', 'child'), { code: 'cardbush_scope_parent_changed' });
  assert.throws(() => browser.registerDelegation('grandchild', 'parent'), { code: 'cardbush_scope_cycle' });
  assert.throws(() => browser.registerDelegation('parent', 'parent'), /Invalid browser delegation/);
  for (const id of ['parent', 'child', 'grandchild', 'other']) assert.equal(browser.hasScope(id), false);
});

test('locking remote and task portals shares the same page and disposal removes all references', () => {
  const portal = { id: 'agent-review:host-a:session-a', kind: 'conversation', title: 'Remote review' };
  let state = act(emptyInspectorSessions, remote('host-a', 'session-a'), { type: 'open', tab: portal });
  state = reduce(state, { type: 'toggle-lock', id: portal.id });
  assert.equal(view(state, local('a')).activeId, portal.id);
  assert.equal(view(state, remote('host-b', 'session-a')).activeId, portal.id);
  assert.equal(retained(state).length, 1);
  state = act(state, local('a'), { type: 'open', tab: { ...portal, title: 'Updated remote review' } });
  assert.equal(retained(state)[0].title, 'Updated remote review');
  assert.equal(state.workspaces[local('a')].tabs.length, 0, 'selecting a lock never adopts the remote portal');
  state = reduce(state, { type: 'toggle-lock', id: portal.id });
  assert.equal(view(state, local('a')).tabs.length, 0);
  assert.equal(retained(state).length, 1, 'unlock retains the original remote portal');
  state = reduce(state, { type: 'toggle-lock', id: portal.id });
  state = act(state, local('a'), { type: 'close', ids: new Set([portal.id]) });
  assert.equal(retained(state).length, 0, 'closing a locked portal releases it everywhere');
  assert.equal(state.lockedIds.size, 0);
});
