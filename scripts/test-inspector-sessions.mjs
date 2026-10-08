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

test('browser actions carry their root conversation through nested delegation', async () => {
  const { IntegratedBrowser } = load('electron/integratedBrowser.ts');
  const actions = [], guests = new Map();
  const owner = { id: 11, isDestroyed: () => false };
  let nextId = 30;
  const browser = new IntegratedBrowser({ defaultOwner: () => owner, getContents: id => guests.get(id), action: (_ownerId, action) => {
    actions.push(action);
    if (action.action === 'open') {
      const guest = { id: ++nextId, hostWebContents: owner, isDestroyed: () => false, getType: () => 'webview', getURL: () => action.url,
        getTitle: () => 'Background', once() {}, debugger: { isAttached: () => false } };
      guests.set(guest.id, guest); browser.register(owner, { tabId: action.tabId, guestWebContentsId: guest.id });
    }
  } });
  browser.select('parent'); browser.inheritScope('parent', 'child'); browser.inheritScope('child', 'grandchild');
  const page = await browser.request('tabs.create', { scopeId: 'grandchild', url: 'https://example.com/' });
  await browser.request('tabs.activate', { scopeId: 'grandchild', tabId: page.id });
  await browser.request('tabs.close', { scopeId: 'grandchild', tabId: page.id });
  assert.deepEqual(actions.map(action => [action.action, action.sessionId]), [['open', 'parent'], ['activate', 'parent'], ['close', 'parent']]);
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
