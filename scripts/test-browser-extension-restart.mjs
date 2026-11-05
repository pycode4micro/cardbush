import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { WebSocket } from 'ws';
import { BrowserConnectorBroker } from '../dist-electron/browserConnectorBroker.js';
import { extensionRoot } from './build-browser-extension.mjs';
import { extensionOrigin, pairedClient } from './helpers/chrome-paired-client.mjs';
import { requestBrowserConnector } from '../packages/cardbush-chrome-mcp/dist/bridgeClient.js';

const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, removeListener(fn) { this.listeners = this.listeners.filter(value => value !== fn); }, emit(value) { for (const fn of [...this.listeners]) fn(value); } });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition) {
  const deadline = Date.now() + 5000;
  while (!condition()) { assert.ok(Date.now() < deadline, 'connector state transition timed out'); await delay(10); }
}

function worker(local, browser, beforeLocalWrite = async () => {}, options = {}) {
  local.cardbushCredentialCacheVersion ??= 1;
  let clockOffset = 0;
  assert.equal(typeof options.reachablePorts, 'function', 'fixture probes must never reach a user connector');
  const session = {}, timers = new Map(), alarms = new Map(), sockets = new Set(), attempts = [], consentWindows = [];
  const storage = data => ({
    setAccessLevel: async ({ accessLevel }) => assert.equal(accessLevel, 'TRUSTED_CONTEXTS'),
    get: async keys => Object.fromEntries(keys.map(key => [key, data[key]])),
    set: async values => { if (data === local) await beforeLocalWrite(values); Object.assign(data, structuredClone(values)); },
    remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  });
  const chrome = {
    runtime: { id: extensionOrigin.split('://')[1], onInstalled: event(), onStartup: event(), onMessage: event(), getManifest: () => ({ version: 'integration-test' }), getURL: file => extensionOrigin + '/' + file },
    storage: { local: storage(local), session: storage(session) },
    alarms: { onAlarm: event(), create: async (name, options) => alarms.set(name, options), clear: async name => alarms.delete(name) },
    tabs: { onRemoved: event(), query: async () => [], remove: async () => {}, create: async value => {
      consentWindows.push(value);
      setImmediate(() => message({ action: 'confirm_connection', token: new URL(value.url).hash.slice(1), allow: true },
        { id: chrome.runtime.id, tab: { id: 12 }, url: value.url }));
      return { id: 12, windowId: 2 };
    } },
    tabGroups: { onRemoved: event() }, debugger: { onDetach: event() },
    windows: { onRemoved: event(), remove: async () => {}, update: async () => {}, create: async value => {
      if (options.popupFailure) throw new Error('Popup unavailable');
      if (options.emptyPopup) return { id: 1, tabs: [] };
      consentWindows.push(value);
      setImmediate(async () => {
        const allowed = typeof options.browserConsent === 'function' ? await options.browserConsent() : options.browserConsent !== false;
        await message({ action: 'confirm_connection', token: new URL(value.url).hash.slice(1), allow: allowed },
          { id: chrome.runtime.id, tab: { id: 10 }, url: value.url });
      });
      return { id: 1, tabs: [{ id: 10 }] };
    } },
  };
  // Only Chrome APIs and alarm scheduling are substituted. Execute the shipped
  // transport and background against a real loopback broker/HMAC handshake.
  const context = vm.createContext({ chrome, console, URL, TextEncoder, AbortController, crypto: webcrypto, structuredClone,
    Date: class extends Date { static now() { return Date.now() + clockOffset; } },
    navigator: { userAgentData: { brands: [{ brand: browser === 'edge' ? 'Microsoft Edge' : 'Google Chrome' }] } },
    WebSocket: class extends WebSocket {
      constructor(url, protocols) {
        attempts.push(url);
        if (!options.reachablePorts().includes(Number(new URL(url).port))) throw new Error('Outside this test fixture');
        super(url, protocols, { origin: extensionOrigin }); sockets.add(this);
      }
    },
    setTimeout: (fn, ms) => { const id = Symbol(); timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id),
    setInterval: (fn, ms) => { const id = Symbol(); timers.set(id, { fn, ms }); return id; },
    clearInterval: id => timers.delete(id),
    importScripts: (...names) => { for (const name of names) vm.runInContext(fs.readFileSync(path.join(extensionRoot, name), 'utf8'), context); },
  });
  vm.runInContext(fs.readFileSync(path.join(extensionRoot, 'background.js'), 'utf8'), context);
  const message = (value, sender) => new Promise(resolve => chrome.runtime.onMessage.listeners[0](value, sender, resolve));
  return { alarms, timers, local, attempts, consentWindows, message,
    advanceClock(ms) { clockOffset += ms; },
    closeConsent() { chrome.windows.onRemoved.emit(1); },
    state: () => vm.runInContext('({ nativeReady, connected: nativePort !== null, connectorEnabled, connectionFailures, reconnectPaused, reconnectWaiting, runtimeBuild })', context),
    status: () => vm.runInContext('popupState()', context),
    action: message => vm.runInContext('handlePopupMessage', context)(message),
    retry() { chrome.alarms.onAlarm.emit({ name: 'cardbush-native-reconnect' }); },
    stop() { vm.runInContext('connectorEnabled = false; pairingController?.abort(); nativePort?.disconnect()', context); for (const socket of sockets) { socket.on('error', () => {}); socket.terminate(); } timers.clear(); },
  };
}

for (const browser of ['chrome', 'edge']) for (const failure of ['popupFailure', 'emptyPopup']) {
  test(`${browser}: ${failure} falls back to a nonce-bound extension tab`, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cardbush-consent-fallback-'));
    const broker = new BrowserConnectorBroker(root, { nativeHostPath: path.resolve('dist-native/chrome-connector-test/CardBushBrowserHost.exe'), allowLocalPairing: () => true });
    let w;
    t.after(async () => { w?.stop(); broker.stop(); await delay(40); fs.rmSync(root, { recursive: true, force: true }); });
    await broker.start();
    const port = JSON.parse(fs.readFileSync(path.join(root, 'browser-connector/pairing.json'), 'utf8')).port;
    w = worker({ cardbushConnectorEnabled: true }, browser, undefined, { reachablePorts: () => [port], [failure]: true });
    await until(() => w.state().nativeReady);
    assert.equal(w.consentWindows.length, 1);
    assert.equal(broker.status().connections[0].browser, browser);
  });
}

test('one profile rotates in place across local/manual repair, revocation and restart, without crossing another Chrome profile', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cardbush-stable-profile-'));
  const nativeHostPath=process.platform==='win32'?path.resolve('dist-native/chrome-connector-test/CardBushBrowserHost.exe'):process.execPath;
  const brokers=[],workers=[];
  t.after(async()=>{workers.forEach(w=>w.stop());brokers.forEach(b=>b.stop());await delay(60);fs.rmSync(root,{recursive:true,force:true});});
  const start=async()=>{const b=new BrowserConnectorBroker(root,{nativeHostPath,allowLocalPairing:()=>true,approvalCooldownMs:0});brokers.push(b);await b.start();return b;};
  let broker=await start();
  const saved=()=>JSON.parse(fs.readFileSync(path.join(root,'browser-connector/pairing.json'),'utf8'));
  const options={reachablePorts:()=>[saved().port]};
  const local={cardbushConnectorEnabled:true,allowedOrigins:['https://example.test']}, other={cardbushConnectorEnabled:true};
  let first=worker(local,'chrome',undefined,options);workers.push(first);
  await until(()=>first.state().nativeReady);
  const id=local.cardbushLocalBrowserIdentity.id,key=local.cardbushLocalBrowserIdentity.publicKey;
  const second=worker(other,'chrome',undefined,options);workers.push(second);await until(()=>second.state().nativeReady);
  const otherId=other.cardbushLocalBrowserIdentity.id;
  assert.notEqual(id,otherId);assert.notEqual(key,other.cardbushLocalBrowserIdentity.publicKey);
  broker.setDefaultConnection(id);
  const call=(method,params={})=>requestBrowserConnector(method,{scopeId:'bound-task',...params},{configPath:broker.configPath,timeoutMs:2500});
  await call('browser.select',{connectionId:id});
  const routes=fs.readFileSync(path.join(root,'browser-connector/routes.json'),'utf8');
  for(const manual of [false,true,false,true]) {
    const old=local.cardbushConnectorPairingV2;
    if(manual) {
      const ticket=broker.createPairing({browser:'chrome',label:'replacement ticket'}).code;
      await first.action({action:'pair',code:ticket});
      assert.equal(broker.status().pendingPairingId,null);
    } else {
      await first.action({action:'disable_connector'});
      await first.action({action:'request_local_connection'});
    }
    await until(()=>first.state().nativeReady&&local.cardbushConnectorPairingV2!==old);
    assert.equal(local.cardbushLocalBrowserIdentity.id,id);
    assert.equal(local.cardbushLocalBrowserIdentity.publicKey,key);
    assert.equal(local.cardbushConnectorPairingV2.split('.')[2],id);
    assert.equal(broker.status().defaultConnectionId,id);
    assert.equal((await call('browser.list')).selectedConnectionId,id);
    assert.equal(fs.readFileSync(path.join(root,'browser-connector/routes.json'),'utf8'),routes);
    assert.equal(saved().credentials.length,2);assert.equal(saved().profiles.length,2);assert.deepEqual(saved().revoked,[]);
    assert.ok(!JSON.stringify(saved()).includes(old.split('.').at(-1)),'old secrets are not retained');
    await assert.rejects(pairedClient(old));
    assert.equal(second.state().nativeReady,true,'another Chrome profile remains connected');
  }
  for(let i=0;i<3;i++) {
    broker.revokeConnection(id);await until(()=>!first.state().connectorEnabled);
    const denied= saved();assert.deepEqual(denied.revoked,[id]);assert.equal(denied.profiles.length,2);
    await first.action({action:'request_local_connection'});await until(()=>first.state().nativeReady);
    assert.equal(saved().credentials.length,2);assert.equal(saved().profiles.length,2);assert.deepEqual(saved().revoked,[]);
    assert.equal((await call('browser.list')).selectedConnectionId,id);
    assert.deepEqual(local.allowedOrigins,['https://example.test']);
  }
  broker.setDefaultConnection(id);
  const code=local.cardbushConnectorPairingV2;
  first.stop();broker.stop();await until(()=>!second.state().connected);await delay(50);
  broker=await start();first=worker(local,'chrome',undefined,options);workers.push(first);
  await until(()=>first.state().nativeReady);second.retry();await until(()=>second.state().nativeReady);
  assert.equal(local.cardbushConnectorPairingV2,code);assert.equal(broker.status().defaultConnectionId,id);
  assert.equal((await call('browser.list')).selectedConnectionId,id);
  assert.equal(saved().credentials.length,2);assert.equal(saved().profiles.length,2);
});

test('manual tickets refresh the same profile on a standalone broker without enabling automatic enrollment', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'cardbush-manual-profile-'));
  const broker=new BrowserConnectorBroker(root,{nativeHostPath:path.resolve('dist-native/chrome-connector-test/CardBushBrowserHost.exe'),approvalCooldownMs:0});
  const workers=[];t.after(async()=>{workers.forEach(w=>w.stop());broker.stop();await delay(50);fs.rmSync(root,{recursive:true,force:true});});
  await broker.start();
  const saved=()=>JSON.parse(fs.readFileSync(path.join(root,'browser-connector/pairing.json'),'utf8'));
  const local={cardbushConnectorEnabled:false};
  const w=worker(local,'edge',undefined,{reachablePorts:()=>[saved().port]});workers.push(w);
  let id;
  for(let i=0;i<3;i++) {
    const old=local.cardbushConnectorPairingV2;
    await w.action({action:'pair',code:broker.createPairing({browser:'edge'}).code});await until(()=>w.state().nativeReady);
    id??=local.cardbushLocalBrowserIdentity.id;
    assert.equal(local.cardbushLocalBrowserIdentity.id,id);assert.equal(saved().credentials.length,1);assert.equal(saved().profiles.length,1);
    assert.equal(saved().defaultConnectionId,id);assert.deepEqual(saved().revoked,[]);
    if(old)await assert.rejects(pairedClient(old,{browser:'edge'}));
  }
  assert.equal(w.consentWindows.length,0,'entering an explicit manual ticket is the confirmation');
});

for (const browser of ['chrome', 'edge']) test(`${browser}: real extension transport reconnects after app and browser restarts with the same pairing`, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cardbush-worker-restart-'));
  const nativeHostPath = process.platform === 'win32' ? path.resolve('dist-native/chrome-connector-test/CardBushBrowserHost.exe') : process.execPath;
  const brokers = [], workers = [];
  t.after(async () => {
    workers.forEach(w => w.stop()); brokers.forEach(b => b.stop()); await delay(40);
    fs.rmSync(root, { recursive: true, force: true });
  });
  async function start() { const b = new BrowserConnectorBroker(root, { nativeHostPath }); brokers.push(b); await b.start(); return b; }
  let broker = await start();
  const pairing = broker.createPairing({ browser }).code;
  const legacyPeer = await pairedClient(pairing, { browser }); legacyPeer.destroy(); broker.stop();
  const pairingPath = path.join(root, 'browser-connector/pairing.json');
  const legacy = JSON.parse(fs.readFileSync(pairingPath, 'utf8'));
  delete legacy.profiles;
  fs.writeFileSync(pairingPath, JSON.stringify(legacy));
  broker = await start();
  const local = { cardbushConnectorEnabled: true, cardbushConnectorPairingV2: pairing, allowAllSites: true, allowedOrigins: ['https://example.test'] };
  const options = { reachablePorts: () => [Number(local.cardbushConnectorPairingV2.split('.')[1]),
    JSON.parse(fs.readFileSync(path.join(root, 'browser-connector/pairing.json'), 'utf8')).port] };
  let w = worker(local, browser, undefined, options); workers.push(w);
  await until(() => w.state().nativeReady && broker.status().extensionConnected);
  assert.match(w.state().runtimeBuild, /^[a-f0-9]{64}$/);
  assert.equal(local.cardbushLocalBrowserIdentity.id, pairing.split('.')[2]);
  assert.equal(JSON.parse(fs.readFileSync(pairingPath, 'utf8')).profiles[0].key, local.cardbushLocalBrowserIdentity.publicKey);

  for (let cycle = 0; cycle < 3; cycle++) {
    broker.stop(); await until(() => !w.state().connected);
    // A long app outage exhausts fast retries but retains authenticated recovery.
    for (let attempt = 0; attempt < 6; attempt++) {
      w.retry(); await delay(25); await until(() => !w.state().connected);
    }
    assert.equal(w.state().reconnectPaused, false);
    assert.equal(w.state().reconnectWaiting, true);
    assert.ok(w.alarms.get('cardbush-native-reconnect').when >= Date.now());
    if (cycle === 2) {
      w.stop();
      w = worker(local, browser, undefined, options); workers.push(w);
      await until(() => w.state().reconnectWaiting);
      assert.equal(w.attempts.length, 0, 'worker restart preserves the slow recovery delay');
    }
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
    const requests = w.attempts.length;
    await w.action({ action: 'status', reconnect: true });
    assert.equal(w.attempts.length, requests, 'popup polling does not bypass the recovery delay');
    w.retry();
    if (occupant) {
      await until(() => !w.state().connected);
      assert.equal(w.state().nativeReady, false, 'recent discovery stays in cooldown even after another port change');
      w.advanceClock(5 * 60_000);
      w.retry();
    }
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
    assert.equal(w.consentWindows.length, 0, 'ordinary recovery never asks for another authorization');
  }
  w.stop(); await until(() => !broker.status().extensionConnected);
  const restarted = worker(local, browser, undefined, options); workers.push(restarted);
  await until(() => restarted.state().nativeReady && broker.status().extensionConnected);
  const status = await restarted.status();
  assert.equal(status.hasPairing, true);
  assert.equal(status.allowAllSites, true);
  assert.equal(status.allowedSiteCount, undefined, 'connection consent replaces individual site grants');
  assert.equal(local.cardbushConnectorEnabled, true);
  assert.equal(local.cardbushConnectorPairingV2.split('.').slice(2).join('.'), pairing.split('.').slice(2).join('.'));
});

test('saved recovery never enrolls an unknown identity; explicit local repair requires browser confirmation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cardbush-worker-repair-'));
  const nativeHostPath = process.platform === 'win32' ? path.resolve('dist-native/chrome-connector-test/CardBushBrowserHost.exe') : process.execPath;
  let approvals = 0, settle;
  const broker = new BrowserConnectorBroker(root, { nativeHostPath, approvalCooldownMs: 0,
    allowLocalPairing: () => true });
  const workers = [];
  t.after(async () => { settle?.(false); workers.forEach(w => w.stop()); broker.stop(); await delay(40); fs.rmSync(root, { recursive: true, force: true }); });
  await broker.start();
  const port = JSON.parse(fs.readFileSync(path.join(root, 'browser-connector/pairing.json'), 'utf8')).port;
  const original = `CB2.${port}.${'1'.repeat(32)}.${'2'.repeat(64)}`;
  const local = { cardbushConnectorEnabled: true, cardbushConnectorPairingV2: original, allowAllSites: true,
    cardbushNativeReconnect: { failures: 3, lastError: 'offline' } };
  let reachable = true;
  const options = { reachablePorts: () => reachable ? [port] : [],
    browserConsent: () => { approvals++; return new Promise(resolve => { settle = resolve; }); } };
  const w = worker(local, 'chrome', undefined, options); workers.push(w);
  await until(() => w.state().reconnectWaiting);
  await w.action({ action: 'status', reconnect: true });
  assert.equal(w.attempts.length, 0); assert.equal(approvals, 0);
  w.retry();
  await until(() => w.state().reconnectWaiting && w.attempts.length > 0);
  assert.equal(approvals, 0, 'background recovery cannot open enrollment for an unknown saved credential');
  assert.ok(w.attempts.every(url => new URL(url).pathname === '/connect'));
  await w.action({ action: 'reconnect' });
  await until(() => w.state().connectionFailures === 1);
  assert.equal(approvals, 0, 'ordinary retry never changes the saved identity or starts consent');
  assert.equal(local.cardbushConnectorPairingV2, original);
  assert.equal(broker.status().connectionAttempt.reason, 'pairing_not_found');
  reachable = false;
  const repairStart = w.attempts.length;
  await w.action({ action: 'request_local_connection' });
  await until(() => w.attempts.length > repairStart && w.state().connectionFailures === 1);
  assert.equal(approvals, 0);
  reachable = true; w.retry();
  await until(() => approvals === 1);
  assert.equal(local.cardbushConnectorPairingV2, original, 'old pairing remains until consent succeeds');
  settle(false); await until(() => !w.state().connectorEnabled);
  assert.equal(local.cardbushConnectorPairingV2, original); assert.equal(local.allowAllSites, true);
  await w.action({ action: 'request_local_connection' });
  await until(() => approvals === 2); settle(true);
  await until(() => w.state().nativeReady && broker.status().extensionConnected);
  assert.notEqual(local.cardbushConnectorPairingV2, original);
  assert.equal(local.allowAllSites, true); assert.equal(w.state().connectionFailures, 0);
  assert.equal(w.state().reconnectPaused, false);
  assert.equal(broker.status().connectionAttempt.stage, 'connected');
  assert.equal(w.consentWindows.length, 2, 'each explicit application opens one confirmation, including the declined attempt');
  assert.ok(!JSON.stringify(broker.status()).includes(local.cardbushConnectorPairingV2.split('.').at(-1)));
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
  const start = async () => { const b = new BrowserConnectorBroker(root, { nativeHostPath }); brokers.push(b); await b.start(); return b; };
  let broker = await start();
  const pairing = broker.createPairing().code;
  const local = { cardbushConnectorEnabled: true, cardbushConnectorPairingV2: pairing, allowedOrigins: ['https://example.test'] };
  w = worker(local, 'chrome', async values => {
    if (values.cardbushConnectorPairingV2 && values.cardbushConnectorPairingV2 !== pairing) {
      writeWaiting = true; await pendingWrite;
    }
  }, { reachablePorts: () => [Number(pairing.split('.')[1]), JSON.parse(fs.readFileSync(path.join(root, 'browser-connector/pairing.json'), 'utf8')).port] });
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

test('manual retry after failed local enrollment keeps the local target across worker restarts', async t => {
  const original = `CB2.43120.${'1'.repeat(32)}.${'2'.repeat(64)}`;
  const local = { cardbushConnectorEnabled: true, cardbushConnectorPairingV2: original,
    cardbushNativeReconnect: { failures: 3, lastError: 'offline' } };
  const options = { reachablePorts: () => [] };
  const first = worker(local, 'chrome', undefined, options);
  const workers = [first]; t.after(() => workers.forEach(w => w.stop()));
  await until(() => first.state().reconnectWaiting);
  await first.action({ action: 'request_local_connection' });
  await until(() => first.state().connectionFailures === 1);
  for (const failures of [2, 3]) { first.retry(); await until(() => first.state().connectionFailures === failures); }
  await until(() => local.cardbushNativeReconnect.failures === 3);
  assert.equal(local.cardbushNativeReconnect.localConnectionRequested, true);
  assert.equal(local.cardbushConnectorPairingV2, original);
  first.stop();

  const restarted = worker(local, 'chrome', undefined, options); workers.push(restarted);
  await until(() => restarted.state().reconnectPaused);
  await restarted.action({ action: 'reconnect' });
  await until(() => restarted.state().connectionFailures === 1);
  assert.ok(restarted.attempts.length > 0);
  assert.ok(restarted.attempts.every(url => new URL(url).pathname === '/request-connection'),
    'Connect must continue the user-requested local enrollment, not silently revert to the old pairing');
  assert.equal((await restarted.status()).localConnectionRequested, true);
  assert.equal(local.cardbushConnectorPairingV2, original, 'failed enrollment still retains the original credential');

  const manualStart = restarted.attempts.length;
  await restarted.action({ action: 'pair', code: original });
  await until(() => restarted.state().connectionFailures === 1);
  assert.ok(restarted.attempts.length > manualStart);
  assert.ok(restarted.attempts.slice(manualStart).every(url => new URL(url).pathname === '/request-connection' && Number(new URL(url).port) === Number(original.split('.')[1])),
    'manual replacement exchanges its ticket only with the explicit target');
  assert.equal((await restarted.status()).localConnectionRequested, false);
});

test('declined local enrollment stays stopped after restart until an explicit user retry', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cardbush-worker-consent-retry-'));
  const nativeHostPath = process.platform === 'win32' ? path.resolve('dist-native/chrome-connector-test/CardBushBrowserHost.exe') : process.execPath;
  let approvals = 0;
  const broker = new BrowserConnectorBroker(root, { nativeHostPath, approvalCooldownMs: 0, allowLocalPairing: () => true });
  const workers = [];
  t.after(async () => { workers.forEach(w => w.stop()); broker.stop(); await delay(40); fs.rmSync(root, { recursive: true, force: true }); });
  await broker.start();
  const port = JSON.parse(fs.readFileSync(path.join(root, 'browser-connector/pairing.json'), 'utf8')).port;
  const original = `CB2.${port}.${'1'.repeat(32)}.${'2'.repeat(64)}`;
  const local = { cardbushConnectorEnabled: true, cardbushConnectorPairingV2: original,
    cardbushNativeReconnect: { failures: 3, lastError: 'offline' }, allowedOrigins: ['https://example.test'] };
  const options = { reachablePorts: () => [port], browserConsent: async () => ++approvals > 1 };
  const first = worker(local, 'chrome', undefined, options); workers.push(first);
  await until(() => first.state().reconnectWaiting);
  await first.action({ action: 'request_local_connection' });
  await until(() => !first.state().connectorEnabled && local.cardbushNativeReconnect.lastError.includes('未获同意'));
  const declinedId = local.cardbushLocalBrowserIdentity.id;
  first.stop();

  const restarted = worker(local, 'chrome', undefined, options); workers.push(restarted);
  const status = await restarted.action({ action: 'status', reconnect: true });
  assert.equal(status.connectorEnabled, false);
  assert.equal(status.localConnectionRequested, true);
  assert.match(status.lastError, /未获同意/);
  restarted.retry(); await delay(30);
  assert.equal(restarted.attempts.length, 0); assert.equal(approvals, 1);
  await restarted.action({ action: 'reconnect' });
  await until(() => restarted.state().nativeReady && broker.status().extensionConnected);
  assert.equal(approvals, 2);
  assert.equal(local.cardbushLocalBrowserIdentity.id, declinedId, 'explicit retry retains the same profile identity');
  assert.notEqual(local.cardbushConnectorPairingV2, original);
  assert.deepEqual(local.allowedOrigins, ['https://example.test']);
});

test('only the current extension confirmation window can approve its own request', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cardbush-worker-consent-origin-'));
  const nativeHostPath = process.platform === 'win32' ? path.resolve('dist-native/chrome-connector-test/CardBushBrowserHost.exe') : process.execPath;
  const broker = new BrowserConnectorBroker(root, { nativeHostPath, allowLocalPairing: () => true });
  let w, settle;
  t.after(async () => { settle?.(false); w?.stop(); broker.stop(); await delay(40); fs.rmSync(root, { recursive: true, force: true }); });
  await broker.start();
  const port = JSON.parse(fs.readFileSync(path.join(root, 'browser-connector/pairing.json'), 'utf8')).port;
  w = worker({}, 'edge', undefined, { reachablePorts: () => [port], browserConsent: () => new Promise(resolve => { settle = resolve; }) });
  await until(() => w.consentWindows.length === 1 && settle);
  const url = w.consentWindows[0].url, token = new URL(url).hash.slice(1);
  const sender = { id: extensionOrigin.split('://')[1], tab: { id: 10 }, url };
  for (const invalid of [{ ...sender, id: 'another-extension' }, { ...sender, tab: { id: 11 } },
    { ...sender, url: extensionOrigin + '/popup.html' }, { ...sender, url: 'https://example.test/connection.html' }]) {
    assert.equal((await w.message({ action: 'confirm_connection', token, allow: true }, invalid)).ok, false);
  }
  assert.equal((await w.message({ action: 'confirm_connection', token: 'wrong', allow: true }, sender)).ok, false);
  assert.equal(broker.status().paired, false);
  const state = await w.message({ action: 'connection_state', token }, sender);
  assert.equal(state.ok, true); assert.equal(state.browser, 'edge'); assert.ok(state.expiresAt > Date.now());
  assert.equal((await w.message({ action: 'confirm_connection', token, allow: true }, sender)).ok, true);
  await until(() => w.state().nativeReady);
  assert.equal((await w.message({ action: 'confirm_connection', token, allow: true }, sender)).ok, false, 'a used approval token cannot be replayed');
  assert.equal(w.consentWindows.length, 1);
});

test('closing the one confirmation window denies access and stops automatic requests', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cardbush-worker-consent-close-'));
  const nativeHostPath = process.platform === 'win32' ? path.resolve('dist-native/chrome-connector-test/CardBushBrowserHost.exe') : process.execPath;
  const broker = new BrowserConnectorBroker(root, { nativeHostPath, allowLocalPairing: () => true });
  let w, settle;
  t.after(async () => { settle?.(true); w?.stop(); broker.stop(); await delay(40); fs.rmSync(root, { recursive: true, force: true }); });
  await broker.start();
  const port = JSON.parse(fs.readFileSync(path.join(root, 'browser-connector/pairing.json'), 'utf8')).port;
  w = worker({}, 'chrome', undefined, { reachablePorts: () => [port], browserConsent: () => new Promise(resolve => { settle = resolve; }) });
  await until(() => w.consentWindows.length === 1 && settle);
  w.closeConsent();
  await until(() => !w.state().connectorEnabled);
  settle(true); w.retry(); await delay(40);
  assert.equal(broker.status().paired, false);
  assert.equal(w.consentWindows.length, 1);
  assert.equal(w.alarms.size, 0);
});
