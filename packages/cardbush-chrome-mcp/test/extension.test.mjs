import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const SCOPE_A = { scopeId: 'session-a', scopeTitle: 'Login check' };
const SCOPE_B = { scopeId: 'session-b', scopeTitle: 'Billing check' };

test('MV3 worker hard-isolates CardBush sessions in named Chrome tab groups', async () => {
  const workerPath = path.resolve(
    import.meta.dirname,
    '../../../assets/plugins/chrome/extension/background.js',
  );
  const source = await readFile(workerPath, 'utf8');
  const nativeMessages = event();
  const nativeDisconnects = event();
  const runtimeMessages = event();
  const posted = [];
  const alarms = [];
  const stored = {};
  const sessionStored = {};
  const attached = new Set();
  const groups = new Map();
  const tabs = [
    tab(11, 1, false, 'Other window', 'https://other.example/'),
    tab(22, 2, true, 'Personal tab', 'https://focused.example/path'),
  ];
  let activeTabId = 22;
  let nextTabId = 33;
  let nextGroupId = 100;
  let nativeDisconnectCalled = false;
  const nativePort = {
    onMessage: nativeMessages,
    onDisconnect: nativeDisconnects,
    postMessage: (message) => posted.push(structuredClone(message)),
    disconnect: () => { nativeDisconnectCalled = true; },
  };

  const chrome = {
    runtime: {
      lastError: undefined,
      connectNative: (name) => {
        assert.equal(name, 'com.cardbush.browser_connector');
        return nativePort;
      },
      getManifest: () => ({ version: 'test-version' }),
      onInstalled: event(),
      onStartup: event(),
      onMessage: runtimeMessages,
    },
    alarms: {
      onAlarm: event(),
      clear: async () => true,
      create: (name, options) => alarms.push({ name, options }),
    },
    tabs: {
      onRemoved: event(),
      query: async (query) => query?.active && (query.lastFocusedWindow || query.currentWindow)
        ? tabs.filter((candidate) => candidate.id === activeTabId)
        : tabs,
      get: async (tabId) => requiredTab(tabs, tabId),
      update: async (tabId, update) => {
        const candidate = requiredTab(tabs, tabId);
        if (update.active) setActiveTab(tabs, candidate, (value) => { activeTabId = value; });
        Object.assign(candidate, update);
        return candidate;
      },
      create: async ({ url }) => {
        const candidate = tab(nextTabId++, 2, true, '', url);
        tabs.push(candidate);
        setActiveTab(tabs, candidate, (value) => { activeTabId = value; });
        return candidate;
      },
      duplicate: async (tabId) => {
        const sourceTab = requiredTab(tabs, tabId);
        const candidate = {
          ...sourceTab,
          id: nextTabId++,
          active: true,
          groupId: -1,
          title: `${sourceTab.title} copy`,
        };
        tabs.push(candidate);
        setActiveTab(tabs, candidate, (value) => { activeTabId = value; });
        return candidate;
      },
      group: async ({ groupId, tabIds }) => {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
        const candidates = ids.map((tabId) => requiredTab(tabs, tabId));
        const targetGroupId = groupId ?? nextGroupId++;
        const windowId = candidates[0].windowId;
        if (!groups.has(targetGroupId)) {
          groups.set(targetGroupId, {
            id: targetGroupId,
            windowId,
            title: '',
            color: 'grey',
            collapsed: false,
          });
        }
        for (const candidate of candidates) {
          assert.equal(candidate.windowId, windowId);
          candidate.groupId = targetGroupId;
        }
        return targetGroupId;
      },
      remove: async (tabId) => {
        const index = tabs.findIndex((candidate) => candidate.id === tabId);
        if (index >= 0) tabs.splice(index, 1);
      },
      goBack: async () => undefined,
      goForward: async () => undefined,
      reload: async () => undefined,
    },
    tabGroups: {
      onRemoved: event(),
      get: async (groupId) => requiredGroup(groups, groupId),
      update: async (groupId, update) => Object.assign(requiredGroup(groups, groupId), update),
    },
    windows: { update: async () => undefined },
    debugger: {
      onDetach: event(),
      attach: async ({ tabId }) => { attached.add(tabId); },
      detach: async ({ tabId }) => { attached.delete(tabId); },
      sendCommand: async (_target, command) => ({ command, accepted: true }),
    },
    storage: {
      local: storageArea(stored),
      session: storageArea(sessionStored),
    },
  };

  vm.runInNewContext(source, {
    chrome,
    URL,
    setTimeout,
    clearTimeout,
    structuredClone,
    console,
  }, { filename: workerPath });
  await flush();

  const missingScope = await nativeRequest(nativeMessages, posted, 'tabs.list', {});
  assert.equal(missingScope.error.code, 'browser_scope_missing');

  const initiallyListed = await nativeRequest(nativeMessages, posted, 'tabs.list', SCOPE_A);
  assert.deepEqual(initiallyListed.result, []);

  stored.allowAllSites = true;
  const unmanagedDespiteGlobalGrant = await nativeRequest(nativeMessages, posted, 'debugger.command', {
    ...SCOPE_A,
    tabId: 22,
    command: 'Runtime.evaluate',
  });
  assert.equal(unmanagedDespiteGlobalGrant.error.code, 'unmanaged_tab');
  assert.equal(attached.size, 0);
  stored.allowAllSites = false;

  const createdA = await nativeRequest(nativeMessages, posted, 'tabs.create', {
    ...SCOPE_A,
    url: 'https://a.example/',
  });
  const tabA = requiredTab(tabs, createdA.result.id);
  const groupA = requiredGroup(groups, tabA.groupId);
  assert.equal(groupA.color, 'cyan');
  assert.match(groupA.title, /^CardBush · Login check · sion-a$/);

  const createdB = await nativeRequest(nativeMessages, posted, 'tabs.create', {
    ...SCOPE_B,
    url: 'https://b.example/',
  });
  const tabB = requiredTab(tabs, createdB.result.id);
  const groupB = requiredGroup(groups, tabB.groupId);
  assert.notEqual(groupA.id, groupB.id);
  assert.match(groupB.title, /^CardBush · Billing check · sion-b$/);

  const listA = await nativeRequest(nativeMessages, posted, 'tabs.list', SCOPE_A);
  assert.deepEqual(listA.result.map((candidate) => candidate.id), [tabA.id]);
  const listB = await nativeRequest(nativeMessages, posted, 'tabs.list', SCOPE_B);
  assert.deepEqual(listB.result.map((candidate) => candidate.id), [tabB.id]);

  const crossScopeActivate = await nativeRequest(nativeMessages, posted, 'tabs.activate', {
    ...SCOPE_B,
    tabId: tabA.id,
  });
  assert.equal(crossScopeActivate.error.code, 'unmanaged_tab');

  const forbiddenGlobalRelease = await nativeRequest(
    nativeMessages,
    posted,
    'debugger.detachAll',
    SCOPE_A,
  );
  assert.equal(forbiddenGlobalRelease.error.code, 'unsupported_method');

  assert.equal((await debug(nativeMessages, posted, SCOPE_A, tabA.id)).result.accepted, true);
  assert.equal((await debug(nativeMessages, posted, SCOPE_B, tabB.id)).result.accepted, true);
  assert.deepEqual([...attached].sort((left, right) => left - right), [tabA.id, tabB.id]);

  const releasedA = await nativeRequest(nativeMessages, posted, 'debugger.detachScope', SCOPE_A);
  assert.equal(releasedA.result.scopeId, SCOPE_A.scopeId);
  assert.deepEqual([...attached], [tabB.id]);
  assert.equal(groupA.collapsed, true);
  assert.equal(groupB.collapsed, false);
  const expiredA = await debug(nativeMessages, posted, SCOPE_A, tabA.id);
  assert.equal(expiredA.error.code, 'site_permission_required');

  await nativeRequest(nativeMessages, posted, 'tabs.list', SCOPE_A);
  setActiveTab(tabs, requiredTab(tabs, 22), (value) => { activeTabId = value; });
  const copied = await popupRequest(runtimeMessages, 'allow_once');
  assert.equal(copied.ok, true);
  assert.equal(copied.access, 'once');
  assert.equal(requiredTab(tabs, 22).groupId, -1);
  const copiedTab = requiredTab(tabs, copied.copiedTabId);
  assert.equal(copiedTab.groupId, groupA.id);
  assert.equal(groupA.collapsed, false);
  assert.equal((await debug(nativeMessages, posted, SCOPE_A, copiedTab.id)).result.accepted, true);

  const listAfterCopy = await nativeRequest(nativeMessages, posted, 'tabs.list', SCOPE_A);
  assert.deepEqual(
    listAfterCopy.result.map((candidate) => candidate.id).sort((left, right) => left - right),
    [tabA.id, copiedTab.id].sort((left, right) => left - right),
  );
  assert.ok(!listAfterCopy.result.some((candidate) => candidate.id === 22));

  nativeMessages.emit({ type: 'control', method: 'debugger.detachAll' });
  await eventually(() => attached.size === 0 && groupA.collapsed && groupB.collapsed);
  assert.equal(groupA.collapsed, true);
  assert.equal(groupB.collapsed, true);
  assert.ok(Array.isArray(sessionStored.cardbushManagedScopes));

  const stopped = await popupRequest(runtimeMessages, 'disconnect');
  assert.equal(stopped.nativeConnected, true);
  assert.equal(stopped.controlledTabCount, 0);
  assert.equal(nativeDisconnectCalled, false);

  nativeDisconnects.emit();
  await eventually(() => alarms.length > 0);
  assert.equal(alarms.at(-1).name, 'cardbush-native-reconnect');
  assert.equal(alarms.at(-1).options.delayInMinutes, 0.5);
});

function tab(id, windowId, active, title, url) {
  return { id, windowId, groupId: -1, active, title, url, status: 'complete' };
}

function setActiveTab(tabs, activeTab, onActive) {
  for (const candidate of tabs) {
    if (candidate.windowId === activeTab.windowId) candidate.active = candidate.id === activeTab.id;
  }
  activeTab.active = true;
  onActive(activeTab.id);
}

function storageArea(values) {
  return {
    get: async (keys) => Object.fromEntries(
      keys.filter((key) => key in values).map((key) => [key, values[key]]),
    ),
    set: async (updates) => Object.assign(values, structuredClone(updates)),
  };
}

function event() {
  const listeners = [];
  return {
    addListener(listener) { listeners.push(listener); },
    emit(...args) { return listeners.map((listener) => listener(...args)); },
  };
}

function requiredTab(tabs, tabId) {
  const candidate = tabs.find((tab) => tab.id === tabId);
  if (!candidate) throw new Error(`Missing test tab ${tabId}`);
  return candidate;
}

function requiredGroup(groups, groupId) {
  const group = groups.get(groupId);
  if (!group) throw new Error(`Missing test group ${groupId}`);
  return group;
}

async function debug(eventTarget, posted, scope, tabId) {
  return await nativeRequest(eventTarget, posted, 'debugger.command', {
    ...scope,
    tabId,
    command: 'Runtime.evaluate',
  });
}

async function nativeRequest(eventTarget, posted, method, params) {
  const id = `request-${posted.length}-${method}`;
  eventTarget.emit({ type: 'request', id, clientId: 'runtime-test', method, params });
  await eventually(() => posted.some((message) => message.id === id));
  return posted.find((message) => message.id === id);
}

async function popupRequest(eventTarget, action) {
  return await new Promise((resolve) => {
    const results = eventTarget.emit({ action }, {}, resolve);
    assert.equal(results.length, 1);
    assert.equal(results[0], true);
  });
}

async function eventually(predicate) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await flush();
  }
  assert.fail('Timed out waiting for the MV3 worker.');
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}
