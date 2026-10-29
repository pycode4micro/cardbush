import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { browserTabReferenceHref } from '@cardbush/bush-protocol';
import { BrowserUseRouter } from '../dist-electron/browserUseHost.mjs';

const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(value) { this.listeners.forEach(fn => fn(value)); } });
function worker(session, tabs) {
  const calls = [], root = path.resolve('assets/plugins/browser/extension');
  const storage = data => ({ get: async keys => Object.fromEntries(keys.map(key => [key, data[key]])), set: async values => Object.assign(data, structuredClone(values)) });
  const chrome = {
    runtime: { onInstalled: event(), onStartup: event(), onMessage: event(), getManifest: () => ({ version: 'test' }) },
    storage: { local: storage({}), session: storage(session) }, alarms: { onAlarm: event(), clear: async () => {}, create: async () => {} },
    tabs: { onRemoved: event(), query: async () => [...tabs.values()],
      get: async id => { if (!tabs.has(id)) throw Error('Closed'); return { ...tabs.get(id) }; },
      update: async (id, patch) => { calls.push(['activate', id, patch]); if (!tabs.has(id)) throw Error('Closed'); return Object.assign(tabs.get(id), patch); },
      create: async options => { calls.push(['create', options]); const tab = { id: 100 + tabs.size, windowId: 5, groupId: -1, title: '', ...options }; tabs.set(tab.id, tab); return tab; } },
    windows: { update: async (id, patch) => { calls.push(['window', id, patch]); } },
    tabGroups: { onRemoved: event(), update: async (id, patch) => { calls.push(['group', id, patch]); } },
    debugger: { onDetach: event() },
  };
  const context = vm.createContext({ chrome, console, URL, TextEncoder, crypto: webcrypto, structuredClone,
    navigator: { userAgentData: { brands: [{ brand: 'Google Chrome' }] } },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    importScripts: (...names) => names.forEach(name => vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), context)),
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  return { chrome, calls, run: source => vm.runInContext(source, context) };
}

test('extension references preserve the worker identity, focus without control, and reject removed/reused tabs', async () => {
  const session = {}, tabs = new Map([[42, { id: 42, windowId: 9, groupId: 7, title: 'AA', url: 'https://example.test/current' }]]);
  const first = worker(session, tabs);
  await first.run('managedScopesReady');
  const page = first.run('publicTab({id:42,title:"AA",url:"https://example.test"})');
  await first.run('persistTabReferenceKeys()');
  const restarted = worker(session, tabs);
  await restarted.run('managedScopesReady');
  await restarted.run(`activeScope={id:'still-running'};dispatch('tabs.reveal',{tabId:42,expectedTargetKey:${JSON.stringify(page.targetKey)}})`);
  assert.equal(restarted.run('activeScope.id'), 'still-running');
  assert.equal(restarted.run('attachedTabs.size'), 0);
  assert.equal(restarted.run('sessionGrants.size'), 0);
  assert.deepEqual(restarted.calls.map(call => call[0]), ['group', 'activate', 'window']);
  assert.equal(tabs.get(42).url, 'https://example.test/current');
  restarted.chrome.tabs.onRemoved.emit(42);
  await restarted.run('managedScopesReady');
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(restarted.run(`dispatch('tabs.reveal',{tabId:42,expectedTargetKey:${JSON.stringify(page.targetKey)}})`), error => error.code === 'browser_tab_missing');
  assert.equal(restarted.calls.length, 3);
  const replacement = restarted.run('publicTab({id:42,title:"new"})');
  assert.notEqual(replacement.targetKey, page.targetKey);
  await restarted.run("dispatch('tabs.reopen',{url:'https://example.test/original'})");
  assert.equal(restarted.calls.filter(call => call[0] === 'create').length, 1);
  assert.equal(restarted.run('activeScope.id'), 'still-running');
});

test('desktop reference actions use the cited connection and never enter agent routing or implicit reopen', async () => {
  const calls = [];
  const router = new BrowserUseRouter({}, { external: async (method, params) => {
    calls.push({ method, params });
    if (method === 'tabs.reveal') throw Object.assign(Error('Closed'), { code: 'browser_tab_missing' });
    return {};
  } });
  const href = browserTabReferenceHref({ connectionId: 'b'.repeat(32), tabId: '42', targetKey: 'external:11111111-1111-4111-8111-111111111111:42', url: 'https://example.test', title: 'AA' });
  assert.equal((await router.openReference(href)).status, 'missing');
  assert.deepEqual(calls.map(call => call.method), ['tabs.reveal']);
  assert.equal(calls[0].params.connectionId, 'b'.repeat(32));
  assert.equal((await router.openReference(href, true)).status, 'opened');
  assert.deepEqual(calls.map(call => call.method), ['tabs.reveal', 'tabs.reopen']);
  assert.equal((await router.openReference('https://example.test', true)).status, 'unavailable');
  assert.equal(calls.length, 2);
});
