import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const root = new URL('../../../assets/plugins/chrome/extension/', import.meta.url);
const source = await readFile(new URL('downloads.js', root), 'utf8') + '\n' + await readFile(new URL('background.js', root), 'utf8');
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, removeListener(fn) { this.listeners = this.listeners.filter(value => value !== fn); }, emit(...args) { this.listeners.forEach(fn => fn(...args)); } });
const flush = () => new Promise(resolve => setImmediate(resolve));
const pairingKey = 'cardbushConnectorPairingV2';
const pairing = 'CB2.12345.' + 'a'.repeat(32) + '.' + 'b'.repeat(64);
async function worker(saved = { cardbushConnectorEnabled: true }, local = { cardbushConnectorEnabled: true, [pairingKey]: pairing }, requestPairing) {
  const ports = [], alarms = [], timers = new Map(), activeAlarms = new Map();
  const storage = values => ({ get: async keys => Object.fromEntries(keys.map(key => [key, values[key]])), set: async value => Object.assign(values, structuredClone(value)), remove: async key => { delete values[key]; } });
  const chrome = {
    runtime: { onInstalled: event(), onStartup: event(), onMessage: event(), getManifest: () => ({ version: 'test' }), getURL: file => `chrome-extension://fixture/${file}`,
      connectNative: () => { const port = { onMessage: event(), onDisconnect: event(), postMessage() {}, disconnect() {} }; ports.push(port); return port; } },
    alarms: { onAlarm: event(), clear: async name => activeAlarms.delete(name), create: (name, options) => { alarms.push({ name, ...options }); activeAlarms.set(name, options); } },
    storage: { session: storage(saved), local: storage(local) },
    tabs: { onRemoved: event(), query: async () => [] }, tabGroups: { onRemoved: event() }, debugger: { onDetach: event() },
    windows: { onRemoved: event(), create: async () => ({ id: 99, tabs: [{ id: 123 }] }), remove: async () => {} },
  };
  const context = vm.createContext({ chrome, console, URL, structuredClone, AbortController, importScripts() {},
    requestConnectorPairing: requestPairing ?? (async () => { throw new Error('Local App is offline'); }),
    crypto: webcrypto, connectorHex: bytes => Buffer.from(bytes).toString('hex'), connectorBrowser: () => 'chrome',
    parseConnectorPairing: code => {
      if (code !== pairing) throw new Error('Pairing is required.');
      return { port: 12345, id: 'fixture', secret: 'fixture' };
    },
    createConnectorPort: () => chrome.runtime.connectNative(),
    setTimeout: (fn, ms) => { const id = Symbol(); timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(source, context);
  await flush();
  return { chrome, ports, alarms, timers, activeAlarms, saved, local, context, state: () => vm.runInContext('({connectorEnabled, pairingRequired, connectionFailures, lastError})', context),
    fail: async message => { chrome.runtime.lastError = { message }; ports.at(-1).onDisconnect.emit(); chrome.runtime.lastError = undefined; await flush(); },
    retry: async () => { chrome.alarms.onAlarm.emit({ name: 'cardbush-native-reconnect' }); await flush(); },
    manual: async () => { vm.runInContext('connectNative(true)', context); await flush(); } };
}

test('offline apps keep a durable 30-second alarm and saved pairing, including formerly paused workers', async () => {
  const f = await worker();
  for (let attempt = 0; attempt < 8; attempt++) {
    await f.fail('App is closed.');
    assert.equal(f.alarms.at(-1).delayInMinutes, 0.5);
    assert.equal(f.alarms.at(-1).periodInMinutes, 0.5);
    await f.retry();
  }
  assert.equal(f.ports.length, 9);
  assert.equal(f.local[pairingKey], pairing);
  assert.equal(f.state().connectorEnabled, true);
  const restarted = await worker({ cardbushNativeReconnect: { failures: 3, lastError: 'App is closed.' } }, f.local);
  assert.equal(restarted.ports.length, 1);
  assert.equal(restarted.state().pairingRequired, false);
});

test('short outages retry after 1, 2 and 4 seconds; successful handshake resets that bounded burst', async () => {
  const f = await worker();
  for (const ms of [1000, 2000, 4000]) {
    await f.fail('App restarting');
    assert.equal(f.timers.size, 1);
    const [id, timer] = [...f.timers][0]; assert.equal(timer.ms, ms);
    f.timers.delete(id); timer.fn(); await flush();
    assert.equal(f.activeAlarms.size, 1, 'worker suspension during handshake still has a wake-up alarm');
  }
  await f.fail('Still offline'); assert.equal(f.timers.size, 0);
  await f.retry();
  f.ports.at(-1).onMessage.emit({ type: 'connector_ready', protocol: 'cardbush.chrome_connector.v1' });
  await flush(); assert.equal(f.activeAlarms.size, 0);
  await f.fail('Another restart'); assert.equal([...f.timers.values()][0].ms, 1000);
  await vm.runInContext('disableConnector()', f.context);
  assert.equal(f.timers.size, 0); assert.equal(f.activeAlarms.size, 0);
  const count = f.ports.length; await f.retry(); assert.equal(f.ports.length, count);
});

test('a delayed pairing read cannot connect after a newer disable', async () => {
  const f = await worker({}, {}), original = f.chrome.storage.local.get;
  f.local[pairingKey] = pairing;
  let unblock;
  f.chrome.storage.local.get = async keys => {
    if (keys.includes('cardbushConnectorPairingV2')) await new Promise(resolve => { unblock = resolve; });
    return original(keys);
  };
  const connect = vm.runInContext('connectNative(true)', f.context);
  await flush(); assert.equal(typeof unblock, 'function');
  await vm.runInContext('disableConnector()', f.context);
  unblock(); await connect;
  assert.equal(f.ports.length, 0); assert.equal(f.state().connectorEnabled, false);
});

test('explicitly disabled extensions never auto-connect after install or restart', async () => {
  for (const [session, local] of [[{}, { cardbushConnectorEnabled: false }],
    [{ cardbushConnectorEnabled: true }, { cardbushConnectorEnabled: false }]]) {
    const f = await worker(session, local);
    f.chrome.runtime.onInstalled.emit(); f.chrome.runtime.onStartup.emit();
    await f.retry();
    assert.equal(f.ports.length, 0);
    f.local[pairingKey] = pairing;
    await f.manual(); assert.equal(f.ports.length, 1);
  }
});

test('a fresh browser session reconnects using local intent and preserves all-site authorization', async () => {
  const local = { cardbushConnectorEnabled: true, [pairingKey]: pairing, allowAllSites: true, allowedOrigins: ['https://example.test'] };
  const f = await worker({}, local);
  assert.equal(f.ports.length, 1);
  const status = await vm.runInContext('popupState()', f.context);
  assert.equal(status.hasPairing, true);
  assert.equal(status.allowAllSites, true);
  assert.equal(status.allowedSiteCount, 1);
  assert.equal(JSON.stringify(status).includes(pairing), false);
  assert.equal(status.activeScope, null, 'persistent consent never imports personal tabs or previous browser tab IDs');
});

test('missing pairing waits for the local App with the bounded reconnect schedule', async () => {
  const f = await worker({}, { cardbushConnectorEnabled: true });
  assert.equal(f.state().pairingRequired, false);
  await f.retry();
  assert.equal(f.ports.length, 0);
  assert.ok(f.alarms.length > 0);
});

test('first install requests consent once, persists the same profile and does not expose credentials in status', async () => {
  const calls = [];
  const f = await worker({}, {}, async (identity, options) => { calls.push({ identity }); await options.onPrepared(pairing); return { code: pairing }; });
  assert.equal(f.ports.length, 1); assert.equal(calls.length, 1);
  assert.match(calls[0].identity.id, /^[a-f0-9]{32}$/);
  assert.equal(f.local[pairingKey], pairing);
  const state = await vm.runInContext('popupState()', f.context);
  assert.ok(!JSON.stringify(state).includes(pairing));
  const restarted = await worker({}, f.local, async () => { throw new Error('No second approval expected'); });
  assert.equal(restarted.ports.length, 1);
});

test('a late approval cannot undo disable and denied/revoked identities require explicit reconnect', async () => {
  let release;
  const f = await worker({}, {}, () => new Promise(resolve => { release = resolve; }));
  await vm.runInContext('disableConnector()', f.context); release({ code: pairing }); await flush();
  assert.equal(f.local[pairingKey], undefined); assert.equal(f.ports.length, 0);
  const revoked = await worker({}, {}, async () => { throw Object.assign(new Error('Revoked'), { code: 'connection_revoked' }); });
  assert.equal(revoked.state().connectorEnabled, false); assert.equal(revoked.state().pairingRequired, true);
  await revoked.retry(); assert.equal(revoked.ports.length, 0);
  const oldIdentity = revoked.local.cardbushLocalBrowserIdentity.id;
  revoked.context.requestConnectorPairing = async () => ({ code: pairing });
  await revoked.manual();
  assert.notEqual(revoked.local.cardbushLocalBrowserIdentity.id, oldIdentity);
  assert.equal(revoked.ports.length, 1);
  const denied = await worker({}, {}, async () => { throw Object.assign(new Error('Denied'), { code: 'connection_denied' }); });
  assert.equal(denied.state().connectorEnabled, false);
  await denied.retry(); assert.equal(denied.ports.length, 0);
});

test('browser consent requires its own confirmation tab and cancellation stays effective', async () => {
  const f = await worker();
  const controller = new AbortController(); f.context.consentSignal = controller.signal;
  const pending = vm.runInContext('confirmLocalBrowserConnection(consentSignal)', f.context); await flush();
  const token = vm.runInContext('browserConnectionConsent.token', f.context);
  let reply;
  f.chrome.runtime.onMessage.emit({ action: 'confirm_connection', token, allow: true },
    { tab: { id: 999 }, url: 'chrome-extension://fixture/connection.html' }, value => { reply = value; });
  assert.equal(reply.ok, false); assert.ok(vm.runInContext('browserConnectionConsent', f.context));
  f.chrome.runtime.onMessage.emit({ action: 'confirm_connection', token, allow: true },
    { tab: { id: 123 }, url: 'https://example.test' }, value => { reply = value; });
  assert.equal(reply.ok, false);
  controller.abort(); assert.equal(await pending, false);
  f.chrome.runtime.onMessage.emit({ action: 'confirm_connection', token, allow: true },
    { tab: { id: 123 }, url: 'chrome-extension://fixture/connection.html' }, value => { reply = value; });
  assert.equal(reply.ok, false, 'a stale Allow click cannot revive a cancelled request');
  const second = new AbortController(); f.context.consentSignal = second.signal;
  const approved = vm.runInContext('confirmLocalBrowserConnection(consentSignal)', f.context); await flush();
  const secondToken = vm.runInContext('browserConnectionConsent.token', f.context);
  f.chrome.runtime.onMessage.emit({ action: 'confirm_connection', token: secondToken, allow: true },
    { tab: { id: 123 }, url: 'chrome-extension://fixture/connection.html#' + secondToken }, value => { reply = value; });
  assert.equal(reply.ok, true); assert.equal(await approved, true);
});

test('popup status and Disable remain responsive while native consent is pending', async () => {
  let release;
  const f = await worker({}, {}, () => new Promise(resolve => { release = resolve; }));
  const state = await vm.runInContext('handlePopupMessage({ action: "status", reconnect: true })', f.context);
  assert.equal(state.nativeConnecting, true);
  await vm.runInContext('handlePopupMessage({ action: "disable_connector" })', f.context);
  release({ code: pairing }); await flush();
  assert.equal(f.state().connectorEnabled, false); assert.equal(f.ports.length, 0);
});

test('desktop disable persists before disconnect and late alarms, ports and upgrades cannot revive it', async () => {
  const f = await worker();
  const port = f.ports[0];
  port.onMessage.emit({ type: 'connector_ready', protocol: 'cardbush.chrome_connector.v1' });
  port.onMessage.emit({ type: 'control', method: 'connector.disable' });
  await flush();
  assert.equal(f.local.cardbushConnectorEnabled, false);
  assert.equal(f.saved.cardbushConnectorEnabled, false);
  port.onDisconnect.emit(); await f.retry();
  f.chrome.runtime.onInstalled.emit(); await flush();
  assert.equal(f.ports.length, 1);
  const restarted = await worker(f.saved, f.local);
  assert.equal(restarted.ports.length, 0);
  await restarted.manual(); assert.equal(restarted.ports.length, 1);
});

test('a verified handshake resets consecutive failures and old ports cannot mutate the new connection', async () => {
  const f = await worker();
  const oldPort = f.ports[0];
  await f.fail('Failed to start native messaging host.'); await f.retry();
  f.ports.at(-1).onMessage.emit({ type: 'connector_ready', protocol: 'cardbush.chrome_connector.v1' });
  await flush(); assert.equal(f.state().connectionFailures, 0);
  oldPort.onDisconnect.emit(); await flush(); assert.equal(f.state().connectionFailures, 0);
  await f.fail('Closed'); assert.equal(f.alarms.at(-1).delayInMinutes, 0.5);
});

test('a delayed enable write cannot outlive a later disable or revive a restarted worker', async () => {
  const f = await worker({}, {});
  const original = f.chrome.storage.local.set;
  let unblock;
  f.chrome.storage.local.set = async value => {
    if (value.cardbushConnectorEnabled === true) await new Promise(resolve => { unblock = resolve; });
    return original(value);
  };
  const enable = vm.runInContext('connectNative(true)', f.context);
  await flush(); assert.equal(typeof unblock, 'function');
  const disable = vm.runInContext('disableConnector()', f.context);
  await flush(); unblock(); await Promise.all([enable, disable]);
  assert.equal(f.local.cardbushConnectorEnabled, false);
  assert.equal(f.saved.cardbushConnectorEnabled, false);
  assert.equal(f.ports.length, 0);
  const restarted = await worker(f.saved, f.local);
  assert.equal(restarted.ports.length, 0);
});

test('explicit removal forgets pairing but only revoke clears persistent site permissions', async () => {
  const f = await worker();
  f.local.allowAllSites = true;
  f.ports[0].onMessage.emit({ type: 'connector_ready', protocol: 'cardbush.chrome_connector.v1' });
  f.ports[0].onMessage.emit({ type: 'control', method: 'connector.disable', reason: 'pairing_removed' });
  await flush();
  assert.equal(f.local[pairingKey], '');
  assert.equal(f.local.cardbushConnectorEnabled, false);
  assert.equal(f.local.allowAllSites, true);
  assert.match(f.state().lastError, /恢复本机连接.*点击「连接 CardBush」重新申请/);
  assert.match(f.state().lastError, /手动连接或远程 Agent 配对/);
  assert.doesNotMatch(f.state().lastError, /请在 CardBush 中重新配对/);
  await f.retry(); await f.manual();
  assert.equal(f.ports.length, 1);
  assert.equal(f.state().pairingRequired, false, 'explicit Connect requests a new automatic identity and waits for the native host');
  await vm.runInContext('handlePopupMessage({action: "revoke"})', f.context);
  assert.equal(f.local.allowAllSites, false);
});

test('opening the popup retries immediately while polling and disabled extensions do not', async () => {
  const f = await worker();
  await f.fail('App closed');
  await vm.runInContext('handlePopupMessage({action: "status"})', f.context);
  assert.equal(f.ports.length, 1);
  await vm.runInContext('handlePopupMessage({action: "status", reconnect: true})', f.context);
  assert.equal(f.ports.length, 2);
  await vm.runInContext('disableConnector()', f.context);
  await vm.runInContext('handlePopupMessage({action: "status", reconnect: true})', f.context);
  assert.equal(f.ports.length, 2);
});

test('a cleanup failure cannot permanently poison later connection attempts', async () => {
  const f = await worker();
  vm.runInContext('suspendAll = async () => { throw new Error("Tab already closed"); }', f.context);
  await f.fail('App closed');
  await f.retry();
  assert.equal(f.ports.length, 2);
  f.ports[1].onMessage.emit({ type: 'connector_ready', protocol: 'cardbush.chrome_connector.v1' });
  assert.equal((await vm.runInContext('popupState()', f.context)).nativeConnected, true);
});

test('a stale rejected pairing read cannot disconnect a newer connection', async () => {
  const f = await worker();
  await f.fail('App closed');
  const original = f.chrome.storage.local.get;
  let rejectRead;
  f.chrome.storage.local.get = keys => keys.includes(pairingKey)
    ? new Promise((_, reject) => { rejectRead = reject; }) : original(keys);
  const oldAttempt = vm.runInContext('connectNative()', f.context);
  await flush();
  f.chrome.storage.local.get = original;
  await f.manual();
  f.ports.at(-1).onMessage.emit({ type: 'connector_ready', protocol: 'cardbush.chrome_connector.v1' });
  rejectRead(new Error('Stale storage failure')); await oldAttempt;
  assert.equal((await vm.runInContext('popupState()', f.context)).nativeConnected, true);
});
