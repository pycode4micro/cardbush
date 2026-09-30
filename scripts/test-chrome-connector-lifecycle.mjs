import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { ChromeConnectorLifecycle, acquireConnectorLease } from '../dist-electron/chromeConnectorLifecycle.js';
import { ChromeConnectorRegistration } from '../dist-electron/chromeConnectorRegistration.js';
import { ChromeConnectorBroker } from '../dist-electron/chromeConnectorBroker.js';
import { pairedClient } from './helpers/chrome-paired-client.mjs';

const nativeHostPath = process.platform === 'win32' ? path.resolve('dist-native/chrome-connector-test/CardBushBrowserHost.exe') : process.execPath;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cardbush-connector-lifecycle-'));
  const values = new Map();
  const operations = [];
  const registry = {
    read: view => values.get(view) ?? null,
    write(view, value) { operations.push(['write', view]); values.set(view, value); },
    remove(view, expected) { assert.equal(values.get(view), expected); operations.push(['remove', view]); values.delete(view); },
  };
  const input = { userDataPath: root, nativeHostPath, msixPackage: false };
  const instances = [];
  const create = (extra = {}) => {
    const lifecycle = new ChromeConnectorLifecycle(input, () => {}, {
      registry, acquireLease: async () => () => {}, supported: () => true,
      createBroker: () => new ChromeConnectorBroker(root, { nativeHostPath }), ...extra,
    });
    instances.push(lifecycle); return lifecycle;
  };
  t.after(async () => { instances.forEach(instance => instance.dispose()); await delay(30); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, values, operations, registry, input, create,
    state: () => JSON.parse(fs.readFileSync(path.join(root, 'browser-connector/preference.json'), 'utf8')),
  };
}

test('first startup has no broker or external writes; enable, app exit, disable and restart preserve user intent', async t => {
  const f = fixture(t); const a = f.create();
  await a.restore(); assert.equal(a.broker, null); assert.deepEqual(f.operations, []);
  await a.setEnabled(true); assert.equal(a.state, 'enabled'); assert.equal(f.state().enabled, true);
  const oldConfig = JSON.parse(fs.readFileSync(a.broker.configPath, 'utf8'));
  a.dispose(); await delay(30);
  assert.equal(f.state().enabled, true); assert.equal(f.values.size, 0);
  const b = f.create(); await b.restore();
  const config = JSON.parse(fs.readFileSync(b.broker.configPath, 'utf8'));
  assert.notEqual(config.token, oldConfig.token); assert.notEqual(config.endpoint, oldConfig.endpoint);
  await b.setEnabled(false); assert.equal(b.broker, null); assert.equal(f.values.size, 0);
  assert.equal(f.state().enabled, false); assert.equal(fs.existsSync(path.join(f.root, 'browser-connector/bridge.json')), false);
  const c = f.create(); await c.restore(); assert.equal(c.broker, null);
  await c.setEnabled(false, true); await c.setEnabled(false, true);
  assert.equal(f.state().removed, true); assert.equal(f.values.size, 0);
});

test('foreign registration is never overwritten or removed', async t => {
  const f = fixture(t); f.values.set('32', 'C:\\OtherApplication\\host.json');
  const app = f.create();
  await app.setEnabled(true);
  await app.setEnabled(false, true);
  assert.equal(f.values.get('32'), 'C:\\OtherApplication\\host.json');
  assert.deepEqual(f.operations, []); assert.equal(app.broker, null);
  assert.equal(f.state().enabled, false);
});

test('temporary desktop disable preserves credentials and routing; only remove revokes them', async t => {
  const f = fixture(t), app = f.create();
  await app.setEnabled(true);
  const code = app.broker.createPairing().code;
  const first = await pairedClient(code);
  t.after(() => first.destroy());
  const pairingPath = path.join(f.root, 'browser-connector/pairing.json');
  const routesPath = path.join(f.root, 'browser-connector/routes.json');
  const credentials = fs.readFileSync(pairingPath, 'utf8');
  const routes = JSON.stringify({ version: 1, bindings: [['fixture-session', code.split('.')[2]]] });
  fs.writeFileSync(routesPath, routes);
  const controls = [];
  first.on('data', data => controls.push(String(data)));
  await app.setEnabled(false);
  await delay(30);
  assert.equal(first.destroyed, true);
  assert.equal(controls.some(value => value.includes('connector.disable')), false, 'temporary disable must preserve extension enable intent');
  assert.equal(fs.readFileSync(pairingPath, 'utf8'), credentials);
  assert.equal(fs.existsSync(routesPath), true);
  assert.equal(fs.readFileSync(routesPath, 'utf8'), routes);
  assert.equal(f.state().enabled, false);
  app.dispose();
  const restarted = f.create(); await restarted.restore();
  assert.equal(restarted.broker, null, 'desktop must stay off until explicitly re-enabled');
  await restarted.setEnabled(true);
  const second = await pairedClient(code);
  t.after(() => second.destroy());
  assert.equal(restarted.broker.status().connections.length, 1, 'reuse pairing instead of creating duplicate profiles');
  await restarted.setEnabled(false, true);
  assert.equal(fs.existsSync(pairingPath), false);
  assert.equal(fs.existsSync(routesPath), false);
  await restarted.setEnabled(true);
  await assert.rejects(pairedClient(code), 'removed credentials cannot authenticate');
});

test('corrupt preferences show a repair state without starting or registering a connector', async t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'browser-connector'));
  const statePath = path.join(f.root, 'browser-connector/preference.json');
  for (const contents of ['{broken', '{"version":1,"enabled":"true"}', 'null']) {
    fs.writeFileSync(statePath, contents);
    const app = f.create(); await assert.rejects(app.restore());
    assert.equal(app.state, 'needs_repair'); assert.notEqual(app.error, '');
    assert.equal(app.broker, null); assert.equal(f.operations.length, 0);
  }
  const app = f.create(); await app.setEnabled(false, true);
  assert.equal(app.state, 'disabled'); assert.equal(f.state().enabled, false);
});

test('failed broker startup rolls back registration and manifest and remains disabled', async t => {
  const f = fixture(t);
  const app = f.create({ createBroker: () => ({ start: async () => { throw new Error('fixture start failure'); }, stop() {} }) });
  await assert.rejects(app.setEnabled(true), /fixture start failure/);
  assert.equal(f.values.size, 0); assert.equal(f.state().enabled, false);
  assert.equal(fs.existsSync(path.join(f.root, 'browser-connector/com.cardbush.browser_connector.json')), false);
});

function legacy(f) {
  const registration = new ChromeConnectorRegistration(f.input, f.registry);
  fs.mkdirSync(registration.directory, { recursive: true });
  fs.writeFileSync(registration.manifestPath, JSON.stringify({ name: 'com.cardbush.browser_connector',
    type: 'stdio', path: registration.launchPath, allowed_origins: ['chrome-extension://iibaamkfgackofhhpadgnmgcjkhckeln/'],
    cardbush_owner: registration.owner }));
  f.values.set('64', fs.realpathSync.native(registration.manifestPath));
  return registration;
}

test('verified standalone legacy registration is removed without deleting unrelated files', async t => {
  const f = fixture(t); const registration = legacy(f);
  fs.writeFileSync(path.join(registration.directory, 'keep.txt'), 'unrelated');
  await f.create().restore();
  assert.equal(fs.existsSync(registration.manifestPath), false);
  assert.equal(fs.readFileSync(path.join(registration.directory, 'keep.txt'), 'utf8'), 'unrelated');
  assert.deepEqual(f.operations, [['remove', '64']]);
});

test('Store legacy external registration is preserved with an explicit migration warning', async t => {
  const f = fixture(t); f.input.msixPackage = true;
  const registration = legacy(f), previous = fs.readFileSync(registration.manifestPath, 'utf8');
  const app = f.create(); await app.restore();
  assert.equal(app.cleanupWarning, 'legacy_external_registration');
  assert.equal(app.enabled, false); assert.equal(app.broker, null);
  assert.equal(fs.readFileSync(registration.manifestPath, 'utf8'), previous);
  assert.deepEqual(f.operations, []);
  await app.setEnabled(true);
  assert.equal(app.state, 'enabled'); assert.deepEqual(f.operations, []);
});

test('redirected connector directory and a live legacy broker fail closed', async t => {
  const f = fixture(t); const target = fs.mkdtempSync(path.join(os.tmpdir(), 'cardbush-connector-foreign-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  fs.symlinkSync(target, path.join(f.root, 'browser-connector'), 'junction');
  assert.throws(() => f.create(), /redirected/);
  fs.unlinkSync(path.join(f.root, 'browser-connector'));
  fs.mkdirSync(path.join(f.root, 'browser-connector'));
  fs.writeFileSync(path.join(f.root, 'browser-connector/bridge.json'), JSON.stringify({ pid: process.pid, token: 'fixture' }));
  await assert.rejects(f.create().setEnabled(true), /previous CardBush process/);
  assert.equal(f.values.size, 0);
});

test('per-user OS lease excludes a second instance and is reusable after release', async () => {
  const identity = randomUUID(); const release = await acquireConnectorLease(identity);
  try { await assert.rejects(acquireConnectorLease(identity), /Another CardBush/); }
  finally { release(); }
  await delay(30); const next = await acquireConnectorLease(identity); next();
});

test('broker expires silent handshakes, caps connections and closes unauthenticated peers on stop', async t => {
  const f = fixture(t); const broker = new ChromeConnectorBroker(f.root, { nativeHostPath, handshakeTimeoutMs: 100, maximumPeers: 1 });
  t.after(() => broker.stop()); await broker.start();
  const connect = async () => {
    const socket = net.createConnection(broker.endpoint); socket.on('error', () => {});
    await new Promise(resolve => socket.once('connect', resolve)); return socket;
  };
  const first = await connect(); const second = await connect();
  await delay(40); assert.equal(second.destroyed, true);
  await delay(130); assert.equal(first.destroyed, true);
  const last = await connect(); broker.stop(); await delay(30); assert.equal(last.destroyed, true);
});

test('old broker shutdown cannot delete a replacement config and its token cannot authenticate there', async t => {
  const f = fixture(t); const old = new ChromeConnectorBroker(f.root, { nativeHostPath });
  const nextRoot = path.join(f.root, 'replacement'); fs.mkdirSync(nextRoot);
  const next = new ChromeConnectorBroker(nextRoot, { nativeHostPath });
  t.after(() => { old.stop(); next.stop(); });
  await old.start(); const oldConfig = JSON.parse(fs.readFileSync(old.configPath, 'utf8'));
  await next.start(); const nextConfig = JSON.parse(fs.readFileSync(next.configPath, 'utf8'));
  fs.copyFileSync(next.configPath, old.configPath);
  old.stop(); assert.equal(JSON.parse(fs.readFileSync(next.configPath, 'utf8')).token, nextConfig.token);
  const socket = net.createConnection(nextConfig.endpoint); socket.on('error', () => {});
  const closed = new Promise(resolve => socket.once('close', resolve));
  await new Promise(resolve => socket.once('connect', resolve));
  socket.write(JSON.stringify({ type: 'hello', protocol: nextConfig.protocol, role: 'mcp', token: oldConfig.token }) + '\n');
  await closed; assert.equal(next.status().extensionConnected, false);
});
