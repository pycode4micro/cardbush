import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { SharedBrowserConnector, assertLegacyBrowserConnectorStopped } from '../dist-electron/sharedBrowserConnector.js';
import { BrowserConnectorBroker } from '../dist-electron/browserConnectorBroker.js';
import { BrowserConnectorLifecycle } from '../dist-electron/browserConnectorLifecycle.js';
import { requestBrowserConnector } from '../packages/cardbush-chrome-mcp/dist/bridgeClient.js';
import { pairedClient } from './helpers/chrome-paired-client.mjs';
import { approvalClient } from './helpers/browser-approval-client.mjs';

const nativeHostPath = resolve('dist-native/chrome-connector-test/CardBushBrowserHost.exe');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { for (let n = 0; n < 100; n++) { if (await predicate()) return; await delay(50); } assert.fail('Timed out'); }
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-shared-browser-'));
  const handles = [], peers = [];
  t.after(async () => { handles.forEach(handle => handle.stop()); peers.forEach(peer => peer.destroy()); await delay(120);
    await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); });
  return { root, peers, create() { const handle = new SharedBrowserConnector(root, nativeHostPath); handles.push(handle); return handle; } };
}

test('App and CLI share pairing, route by conversation and take over after owner exit', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), app = f.create(), cli = f.create();
  await app.start(); await cli.start();
  const old = JSON.parse(await readFile(app.configPath));
  const pairing = await cli.createPairing({ browser: 'edge', label: 'Shared Edge' });
  const extension = await pairedClient(pairing.code, { browser: 'edge' }); f.peers.push(extension);
  await until(() => app.status().extensionConnected && cli.status().extensionConnected);
  assert.deepEqual(app.status(), cli.status());
  assert.ok(!JSON.stringify(app.status()).includes(pairing.code.split('.').at(-1)));
  await requestBrowserConnector('browser.select', { scopeId: 'cli-session', connectionId: pairing.id }, { configPath: cli.configPath });
  assert.equal((await requestBrowserConnector('browser.list', { scopeId: 'app-session' }, { configPath: app.configPath })).selectedConnectionId, null);
  app.stop(); await until(() => extension.destroyed);
  await until(async () => cli.status().bridgeRunning && await readFile(cli.configPath).then(bytes => JSON.parse(bytes).token !== old.token, () => false));
  const reconnected = await pairedClient(pairing.code, { browser: 'edge' }); f.peers.push(reconnected);
  const result = await requestBrowserConnector('browser.list', { scopeId: 'cli-session' }, { configPath: cli.configPath });
  assert.equal(result.selectedConnectionId, pairing.id);
  assert.equal(result.connections[0].connected, true);
  await cli.revokeConnection(pairing.id);
  await until(() => reconnected.destroyed);
  await assert.rejects(pairedClient(pairing.code, { browser: 'edge' }));
});

test('shared owner loss has one bounded recovery loop and waits for explicit retry after exhaustion', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), owner = f.create(), follower = f.create();
  await owner.start(); await follower.start(); owner.stop();
  await writeFile(follower.configPath, JSON.stringify({ protocol: 'invalid', endpoint: 'invalid' }));
  await until(() => follower.status().recoveryPaused);
  await rm(follower.configPath);
  await delay(1300);
  assert.equal((await follower.refresh()).recoveryPaused, true, 'the permission watcher cannot bypass exhaustion');
  assert.equal(follower.status().bridgeRunning, false);
  assert.equal((await follower.refresh(true)).bridgeRunning, true);
});

test('simultaneous clients elect one endpoint and explicit disable is observed by all', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), handles = [f.create(), f.create(), f.create()];
  await Promise.all(handles.map(handle => handle.start()));
  assert.ok(handles.every(handle => handle.status().bridgeRunning));
  await writeFile(join(f.root, 'browser-connector/preference.json'), JSON.stringify({ version: 2, enabled: false }));
  await until(() => handles.every(handle => !handle.status().bridgeRunning));
  await assert.rejects(handles[0].createPairing(), /disabled/);
  await writeFile(join(f.root, 'browser-connector/preference.json'), JSON.stringify({ version: 2, enabled: true }));
  await until(() => handles.every(handle => handle.status().bridgeRunning));
});

test('consent pairs without a copied code and preserves revocation across shared owners', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); let approvals = 0;
  const broker = new BrowserConnectorBroker(f.root, { nativeHostPath, shared: true, allowLocalPairing: () => true });
  t.after(() => broker.stop()); await broker.start();
  const app = f.create(); await app.start();
  const port = JSON.parse(await readFile(join(f.root, 'browser-connector/pairing.json'))).port;
  const identity = { id: randomBytes(16).toString('hex') };
  await assert.rejects(approvalClient(port, identity, { origin: 'chrome-extension://wrong' })); assert.equal(approvals, 0);
  const result = await approvalClient(port, identity, { confirm: async () => { approvals++; return true; } }); assert.equal(approvals, 1);
  const peer = await pairedClient(result.code); f.peers.push(peer);
  await until(() => app.status().extensionConnected);
  assert.equal((await approvalClient(port, identity)).code, result.code, 'a lost reply resumes the approved identity');
  assert.equal(approvals, 1);
  await app.revokeConnection(identity.id);
  await assert.rejects(approvalClient(port, identity), error => error.code === 'connection_revoked');
  app.stop(); broker.stop(); await delay(100);
  const restarted = f.create(); await restarted.start();
  await assert.rejects(approvalClient(port, identity), error => error.code === 'connection_revoked');
  assert.equal(restarted.status().connections.length, 0);
});

test('existing CLI pairing and session route migrate without undoing a later revocation', { skip: process.platform !== 'win32' }, async t => {
  const legacy = await fixture(t), shared = await fixture(t);
  const old = new BrowserConnectorBroker(legacy.root, { nativeHostPath });
  t.after(() => old.stop()); await old.start();
  const pairing = old.createPairing(); const peer = await pairedClient(pairing.code); legacy.peers.push(peer);
  await requestBrowserConnector('browser.select', { scopeId: 'existing-cli', connectionId: pairing.id }, { configPath: old.configPath });
  old.stop();
  const current = shared.create(); await current.start(); await current.importLegacy(legacy.root);
  const restored = await pairedClient(pairing.code); shared.peers.push(restored);
  const state = await requestBrowserConnector('browser.list', { scopeId: 'existing-cli' }, { configPath: current.configPath });
  assert.equal(state.selectedConnectionId, pairing.id); assert.equal(state.connections[0].connected, true);
  await current.revokeConnection(pairing.id); await current.importLegacy(legacy.root);
  assert.equal((await current.refresh()).connections.length, 0, 'legacy data cannot restore revoked access');
});

test('removing configuration while offline revokes old pairings before re-enabling', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), client = f.create(); await client.start();
  const code = (await client.createPairing()).code, peer = await pairedClient(code); f.peers.push(peer);
  await until(() => client.status().extensionConnected); client.stop(); await delay(100);
  const lifecycle = new BrowserConnectorLifecycle({ userDataPath: f.root, nativeHostPath, shared: true }, () => {}, {
    registry: { read: () => null, remove() {} }, supported: () => true,
  });
  t.after(() => lifecycle.dispose());
  await lifecycle.setEnabled(false, true); await lifecycle.setEnabled(true);
  assert.equal(lifecycle.broker.status().connections.length, 0);
  await assert.rejects(pairedClient(code));
  const [, port, id] = code.split('.');
  await assert.rejects(approvalClient(port, { id }), error => error.code === 'connection_revoked');
});

test('an older running App is not overwritten during a partial upgrade', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), old = new BrowserConnectorBroker(f.root, { nativeHostPath });
  t.after(() => old.stop()); await old.start();
  const original = await readFile(old.configPath, 'utf8');
  await assert.rejects(f.create().start(), /older CardBush process/);
  assert.equal(await readFile(old.configPath, 'utf8'), original);
});

test('session 19c2 replay: stale legacy endpoint recovers despite a recycled PID or Windows EPERM, retaining pairing', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t), old = new BrowserConnectorBroker(f.root, { nativeHostPath });
  t.after(() => old.stop()); await old.start();
  const code = old.createPairing().code, descriptor = await readFile(old.configPath, 'utf8');
  f.peers.push(await pairedClient(code));
  old.stop(); await delay(100);
  await writeFile(old.configPath, descriptor);
  const kill = process.kill;
  t.mock.method(process, 'kill', function(pid, signal) {
    if (pid === process.pid && signal === 0) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
    return kill.call(process, pid, signal);
  });
  const shared = f.create(); await shared.start();
  assert.equal(shared.status().bridgeRunning, true);
  assert.notEqual(JSON.parse(await readFile(shared.configPath)).endpoint, JSON.parse(descriptor).endpoint);
  const peer = await pairedClient(code); f.peers.push(peer);
  const result = await requestBrowserConnector('browser.list', { scopeId: 'recovered' }, { configPath: shared.configPath });
  assert.equal(result.connections[0].id, code.split('.')[2]);
  assert.equal(result.connections[0].connected, true);
});

test('legacy endpoint permission failures and invalid paths never authorize takeover', async t => {
  const root = resolve('tmp'), endpoint = process.platform === 'win32'
    ? '\\\\.\\pipe\\cardbush-browser-connector-' + 'a'.repeat(24) : join(root, 'browser-connector', 'bridge.sock');
  let attempts = 0;
  t.mock.method(net, 'createConnection', () => {
    attempts++; const socket = new PassThrough();
    queueMicrotask(() => socket.emit('error', Object.assign(new Error('denied'), { code: 'EACCES' })));
    return socket;
  });
  await assert.rejects(assertLegacyBrowserConnectorStopped({ protocol: 'cardbush.chrome_connector.v1', endpoint }, root), /Cannot verify.*EACCES/);
  assert.equal(attempts, 1);
  await assert.rejects(assertLegacyBrowserConnectorStopped({ protocol: 'cardbush.chrome_connector.v1', endpoint: '\\\\.\\pipe\\unrelated-application' }, root), /Invalid previous/);
  assert.equal(attempts, 1, 'never probe an unrelated endpoint');
});
