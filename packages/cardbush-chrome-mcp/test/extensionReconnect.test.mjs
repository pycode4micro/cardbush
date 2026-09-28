import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../../../assets/plugins/chrome/extension/', import.meta.url);
const source = await readFile(new URL('downloads.js', root), 'utf8') + '\n' + await readFile(new URL('background.js', root), 'utf8');
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { this.listeners.forEach(fn => fn(...args)); } });
const flush = () => new Promise(resolve => setImmediate(resolve));
async function worker(saved = { cardbushConnectorEnabled: true }, local = { cardbushConnectorEnabled: true }) {
  const ports = [], alarms = [], timers = new Map();
  const storage = values => ({ get: async keys => Object.fromEntries(keys.map(key => [key, values[key]])), set: async value => Object.assign(values, structuredClone(value)) });
  const chrome = {
    runtime: { onInstalled: event(), onStartup: event(), onMessage: event(), getManifest: () => ({ version: 'test' }),
      connectNative: () => { const port = { onMessage: event(), onDisconnect: event(), postMessage() {}, disconnect() {} }; ports.push(port); return port; } },
    alarms: { onAlarm: event(), clear: async () => {}, create: (name, options) => alarms.push({ name, ...options }) },
    storage: { session: storage(saved), local: storage(local) },
    tabs: { onRemoved: event(), query: async () => [] }, tabGroups: { onRemoved: event() }, debugger: { onDetach: event() },
  };
  const context = vm.createContext({ chrome, console, URL, structuredClone, importScripts() {},
    parseConnectorPairing: () => ({ port: 12345, id: 'fixture', secret: 'fixture' }),
    createConnectorPort: () => chrome.runtime.connectNative(),
    setTimeout: (fn, ms) => { const id = Symbol(); timers.set(id, { fn, ms }); return id; }, clearTimeout: id => timers.delete(id) });
  vm.runInContext(source, context);
  await flush();
  return { chrome, ports, alarms, saved, local, context, state: () => vm.runInContext('({connectorEnabled, reconnectPaused, connectionFailures, lastError})', context),
    fail: async message => { chrome.runtime.lastError = { message }; ports.at(-1).onDisconnect.emit(); chrome.runtime.lastError = undefined; await flush(); },
    retry: async () => { chrome.alarms.onAlarm.emit({ name: 'cardbush-native-reconnect' }); await flush(); },
    manual: async () => { vm.runInContext('connectNative(true)', context); await flush(); } };
}

test('connector startup failures back off and stop after three attempts, including worker restarts', async () => {
  const f = await worker();
  await f.fail('Native host has exited.');
  assert.equal(f.alarms.at(-1).delayInMinutes, 0.5);
  await f.retry(); await f.fail('Native host has exited.');
  assert.equal(f.alarms.at(-1).delayInMinutes, 1);
  await f.retry(); await f.fail('Native host has exited.');
  assert.equal(f.ports.length, 3);
  assert.equal(f.state().reconnectPaused, true);
  assert.equal(f.alarms.length, 2);
  await f.retry(); assert.equal(f.ports.length, 3);
  const restarted = await worker(f.saved);
  assert.equal(restarted.ports.length, 0);
  assert.equal(restarted.state().lastError, 'Native host has exited.');
  await restarted.manual(); assert.equal(restarted.ports.length, 1);
  assert.equal(restarted.state().reconnectPaused, false);
});

test('a delayed pairing read cannot connect after a newer disable', async () => {
  const f = await worker({}, {}), original = f.chrome.storage.local.get;
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

test('first install, a fresh browser session and a disabled connector never auto-connect', async () => {
  for (const [session, local] of [[{}, {}], [{}, { cardbushConnectorEnabled: true }],
    [{ cardbushConnectorEnabled: true }, { cardbushConnectorEnabled: false }]]) {
    const f = await worker(session, local);
    f.chrome.runtime.onInstalled.emit(); f.chrome.runtime.onStartup.emit();
    await f.retry();
    assert.equal(f.ports.length, 0);
    await f.manual(); assert.equal(f.ports.length, 1);
  }
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
