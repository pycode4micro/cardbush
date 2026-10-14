import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { WebSocket } from 'ws';
import { ChromeConnectorBroker } from '../dist-electron/chromeConnectorBroker.js';
import { extensionRoot } from './build-browser-extension.mjs';
import { extensionOrigin } from './helpers/chrome-paired-client.mjs';

const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(value) { for (const fn of this.listeners) fn(value); } });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition) {
  const deadline = Date.now() + 5000;
  while (!condition()) { assert.ok(Date.now() < deadline, 'connector state transition timed out'); await delay(10); }
}

function worker(local, browser, beforeLocalWrite = async () => {}) {
  const session = {}, timers = new Map(), alarms = new Map(), sockets = new Set();
  const storage = data => ({
    get: async keys => Object.fromEntries(keys.map(key => [key, data[key]])),
    set: async values => { if (data === local) await beforeLocalWrite(values); Object.assign(data, structuredClone(values)); },
  });
  const chrome = {
    runtime: { onInstalled: event(), onStartup: event(), onMessage: event(), getManifest: () => ({ version: 'integration-test' }) },
    storage: { local: storage(local), session: storage(session) },
    alarms: { onAlarm: event(), create: async (name, options) => alarms.set(name, options), clear: async name => alarms.delete(name) },
    tabs: { onRemoved: event(), query: async () => [] },
    tabGroups: { onRemoved: event() }, debugger: { onDetach: event() },
  };
  // Only Chrome APIs and alarm scheduling are substituted. Execute the shipped
  // transport and background against a real loopback broker/HMAC handshake.
  const context = vm.createContext({ chrome, console, URL, TextEncoder, crypto: webcrypto, structuredClone,
    navigator: { userAgentData: { brands: [{ brand: browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome' }] } },
    WebSocket: class extends WebSocket {
      constructor(url, protocols) { super(url, protocols, { origin: extensionOrigin }); sockets.add(this); }
    },
    setTimeout: (fn, ms) => { const id = Symbol(); timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => { const id = Symbol(); timers.set(id, { fn, ms }); return id; },
    clearInterval: id => timers.delete(id),
    importScripts: (...names) => { for (const name of names) vm.runInContext(fs.readFileSync(path.join(extensionRoot, name), 'utf8'), context); },
  });
  vm.runInContext(fs.readFileSync(path.join(extensionRoot, 'background.js'), 'utf8'), context);
  return { alarms, timers, local,
    state: () => vm.runInContext('({ nativeReady, connected: nativePort !== null, connectorEnabled, connectionFailures, runtimeBuild })', context),
    status: () => vm.runInContext('popupState()', context),
    retry() { chrome.alarms.onAlarm.emit({ name: 'cardbush-native-reconnect' }); },
    stop() { vm.runInContext('connectorEnabled = false; nativePort?.disconnect()', context); for (const socket of sockets) { socket.on('error', () => {}); socket.terminate(); } timers.clear(); },
  };
}

for (const browser of ['chrome', 'edge']) test(`${browser}: real extension transport reconnects after app and browser restarts with the same pairing`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cardbush-worker-restart-'));
  const nativeHostPath = process.platform === 'win32' ? path.resolve('dist-native/chrome-connector-test/CardBushBrowserHost.exe') : process.execPath;
  const brokers = [], workers = [];
  t.after(async () => {
    workers.forEach(w => w.stop()); brokers.forEach(b => b.stop()); await delay(40);
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function start() { const b = new ChromeConnectorBroker(root, { nativeHostPath }); brokers.push(b); await b.start(); return b; }
  let broker = await start();
  const pairing = broker.createPairing({ browser }).code;
  const local = { cardbushConnectorEnabled: true, cardbushConnectorPairingV2: pairing, allowAllSites: true, allowedOrigins: ['https://example.test'] };
  const w = worker(local, browser); workers.push(w);
  await until(() => w.state().nativeReady && broker.status().extensionConnected);
  assert.match(w.state().runtimeBuild, /^[a-f0-9]{64}$/);

  for (let cycle = 0; cycle < 3; cycle++) {
    broker.stop(); await until(() => !w.state().connected);
    // Exceed the old worker's retry limit before bringing the app back.
    for (let attempt = 0; attempt < 6; attempt++) {
      w.retry(); await delay(25); await until(() => !w.state().connected);
    }
    assert.equal(w.alarms.get('cardbush-native-reconnect').periodInMinutes, 0.5);
    const previousCode = local.cardbushConnectorPairingV2;
    let occupant;
    if (cycle === 1) {
      occupant = net.createServer(socket => socket.destroy());
      t.after(() => occupant.close());
      await new Promise((resolve, reject) => {
        occupant.once('error', reject);
        occupant.listen(Number(previousCode.split('.')[1]), '127.0.0.1', resolve);
      });
    }
    broker = await start();
    w.retry();
    await until(() => w.state().nativeReady && broker.status().extensionConnected);
    assert.equal(broker.status().connections.length, 1);
    assert.equal(broker.status().connections[0].id, pairing.split('.')[2]);
    if (occupant) {
      await until(() => local.cardbushConnectorPairingV2 !== previousCode);
      assert.equal(broker.status().portRecovery.previousPort, Number(previousCode.split('.')[1]));
      assert.equal(Number(local.cardbushConnectorPairingV2.split('.')[1]), broker.status().portRecovery.port);
      await new Promise(resolve => occupant.close(resolve));
    } else {
      const currentPort = JSON.parse(fs.readFileSync(path.join(root, 'browser-connector/pairing.json'), 'utf8')).port;
      await until(() => Number(local.cardbushConnectorPairingV2.split('.')[1]) === currentPort);
    }
    assert.equal(local.cardbushConnectorPairingV2.split('.').slice(2).join('.'), pairing.split('.').slice(2).join('.'), 'recovery retains the exact credential');
    assert.equal(local.allowAllSites, true);
    assert.deepEqual(local.allowedOrigins, ['https://example.test']);
  }
  w.stop(); await until(() => !broker.status().extensionConnected);
  const restarted = worker(local, browser); workers.push(restarted);
  await until(() => restarted.state().nativeReady && broker.status().extensionConnected);
  const status = await restarted.status();
  assert.equal(status.hasPairing, true);
  assert.equal(status.allowAllSites, true);
  assert.equal(status.allowedSiteCount, 1);
  assert.equal(local.cardbushConnectorEnabled, true);
  assert.equal(local.cardbushConnectorPairingV2.split('.').slice(2).join('.'), pairing.split('.').slice(2).join('.'));
});

test('revoking a pairing during endpoint persistence cannot restore it after removal', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cardbush-recovery-revoke-'));
  const nativeHostPath = process.platform === 'win32' ? path.resolve('dist-native/chrome-connector-test/CardBushBrowserHost.exe') : process.execPath;
  const brokers = [];
  let releaseWrite, writeWaiting = false, occupant, w;
  const pendingWrite = new Promise(resolve => { releaseWrite = resolve; });
  t.after(async () => {
    releaseWrite(); w?.stop(); brokers.forEach(b => b.stop()); occupant?.close(); await delay(40);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const start = async () => { const b = new ChromeConnectorBroker(root, { nativeHostPath }); brokers.push(b); await b.start(); return b; };
  let broker = await start();
  const pairing = broker.createPairing().code;
  const local = { cardbushConnectorEnabled: true, cardbushConnectorPairingV2: pairing, allowedOrigins: ['https://example.test'] };
  w = worker(local, 'chrome', async values => {
    if (values.cardbushConnectorPairingV2 && values.cardbushConnectorPairingV2 !== pairing) {
      writeWaiting = true; await pendingWrite;
    }
  });
  await until(() => w.state().nativeReady);
  broker.stop(); await until(() => !w.state().connected);
  occupant = net.createServer(socket => socket.destroy());
  await new Promise((resolve, reject) => { occupant.once('error', reject); occupant.listen(Number(pairing.split('.')[1]), '127.0.0.1', resolve); });
  broker = await start(); w.retry();
  await until(() => writeWaiting && w.state().nativeReady);
  broker.revokeConnection(pairing.split('.')[2]);
  await until(() => !w.state().connectorEnabled);
  releaseWrite();
  await until(() => local.cardbushConnectorPairingV2 === '');
  w.retry(); await delay(100);
  assert.equal(local.cardbushConnectorPairingV2, '');
  assert.equal(local.cardbushConnectorEnabled, false);
  assert.deepEqual(local.allowedOrigins, ['https://example.test']);
  assert.equal(w.state().connected, false);
});
