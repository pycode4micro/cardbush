import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChromeConnectorBroker } from '../dist-electron/chromeConnectorBroker.js';
import { pairedClient } from './helpers/chrome-paired-client.mjs';
import { requestChromeConnector } from '../packages/cardbush-chrome-mcp/dist/bridgeClient.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 150; i++) { if (fn()) return; await delay(10); } assert.fail('Condition did not complete'); }
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cardbush-browser-routing-'));
  const brokers = [], clients = [];
  const create = async () => {
    const broker = new ChromeConnectorBroker(root, { nativeHostPath: path.resolve('dist-native/chrome-connector-validation/CardBushBrowserHost.exe') });
    brokers.push(broker); await broker.start(); return broker;
  };
  const connect = async (broker, browser, code) => {
    const pairing = code ?? broker.createPairing({ browser, label: `${browser} work` }).code;
    const socket = await pairedClient(pairing, { browser }); clients.push(socket);
    const calls = [];
    const peer = { id: pairing.split('.')[2], code: pairing, socket, calls, hold: false, failRelease: false };
    socket.on('data', raw => {
      const request = JSON.parse(raw); if (request.type !== 'request') return;
      calls.push(request);
      if (peer.hold) return;
      socket.write(JSON.stringify({ type: 'response', id: request.id, clientId: request.clientId,
        ...(request.method === 'debugger.detachScope' && peer.failRelease ? { error: { code: 'release_failed', message: 'Fixture release failed' } }
          : { result: { browser, tabId: 42, scope: request.params.scopeId } }) }));
    });
    return peer;
  };
  t.after(async () => { for (const peer of clients) peer.destroy(); for (const broker of brokers) broker.stop(); await delay(50); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, create, connect, call: (broker, scopeId, method = 'tabs.list', params = {}) =>
    requestChromeConnector(method, { ...params, scopeId, scopeTitle: scopeId }, { configPath: broker.configPath, timeoutMs: 2500 }) };
}

test('Chrome and Edge coexist; defaults, session bindings and restart never cross-route matching tab ids', async t => {
  const f = fixture(t), broker = await f.create();
  const chrome = await f.connect(broker, 'chrome'), edge = await f.connect(broker, 'edge');
  assert.equal(broker.status().connections.filter(c => c.connected).length, 2);
  assert.equal((await f.call(broker, 'a')).browser, 'chrome');
  await f.call(broker, 'b', 'browser.select', { connectionId: edge.id });
  assert.equal((await f.call(broker, 'b')).browser, 'edge');
  broker.setDefaultConnection(edge.id);
  const values = await Promise.all([f.call(broker, 'a'), f.call(broker, 'b'), f.call(broker, 'c')]);
  assert.deepEqual(values.map(value => value.browser), ['chrome', 'edge', 'edge']);
  assert.ok(chrome.calls.every(request => request.params.scopeId === 'a'));
  assert.ok(edge.calls.every(request => ['b', 'c'].includes(request.params.scopeId)));
  const status = await f.call(broker, 'a', 'browser.list');
  assert.equal(status.selectedConnectionId, chrome.id);
  assert.equal(status.defaultConnectionId, edge.id);
  assert.equal(JSON.stringify(status).includes(chrome.code.split('.').at(-1)), false);
  broker.stop(); await until(() => chrome.socket.destroyed && edge.socket.destroyed);
  const restarted = await f.create();
  await f.connect(restarted, 'edge', edge.code);
  await assert.rejects(f.call(restarted, 'a'), error => error.code === 'browser_unavailable');
  await f.connect(restarted, 'chrome', chrome.code);
  assert.equal((await f.call(restarted, 'a')).browser, 'chrome');
  assert.equal((await f.call(restarted, 'b')).browser, 'edge');
});

test('wrong browser cannot consume a pairing; revocation does not affect another browser', async t => {
  const f = fixture(t), broker = await f.create();
  const code = broker.createPairing({ browser: 'edge' }).code;
  await assert.rejects(pairedClient(code, { browser: 'chrome' }));
  const edge = await f.connect(broker, 'edge', code), chrome = await f.connect(broker, 'chrome');
  await f.call(broker, 'edge-session', 'browser.select', { connectionId: edge.id });
  broker.revokeConnection(edge.id); await until(() => edge.socket.destroyed);
  await assert.rejects(pairedClient(code, { browser: 'edge' }));
  await assert.rejects(f.call(broker, 'edge-session'), error => error.code === 'browser_unavailable');
  assert.equal(chrome.socket.destroyed, false);
  await f.call(broker, 'other', 'browser.select', { connectionId: chrome.id });
  assert.equal((await f.call(broker, 'other')).browser, 'chrome');
  await assert.rejects(f.call(broker, 'unbound'), error => error.code === 'browser_selection_required');
});

test('explicit switch releases the old scope; failed release and concurrent work preserve its binding', async t => {
  const f = fixture(t), broker = await f.create();
  const chrome = await f.connect(broker, 'chrome'), edge = await f.connect(broker, 'edge');
  await f.call(broker, 'a'); chrome.failRelease = true;
  await assert.rejects(f.call(broker, 'a', 'browser.select', { connectionId: edge.id }), error => error.code === 'release_failed');
  assert.equal((await f.call(broker, 'a')).browser, 'chrome');
  chrome.failRelease = false; chrome.hold = true;
  const priorCount = chrome.calls.length;
  const switching = f.call(broker, 'a', 'browser.select', { connectionId: edge.id });
  await until(() => chrome.calls.length > priorCount && chrome.calls.at(-1)?.method === 'debugger.detachScope');
  await assert.rejects(f.call(broker, 'a'), error => error.code === 'browser_session_busy');
  const request = chrome.calls.at(-1);
  chrome.socket.write(JSON.stringify({ type: 'response', id: request.id, clientId: request.clientId, result: {} }));
  await switching;
  assert.equal((await f.call(broker, 'a')).browser, 'edge');
});

test('responses are correlated to their browser; disconnect returns promptly without replaying a mutation', async t => {
  const f = fixture(t), broker = await f.create();
  const chrome = await f.connect(broker, 'chrome'), edge = await f.connect(broker, 'edge'); chrome.hold = true;
  const pending = f.call(broker, 'a', 'debugger.command', { tabId: 42, command: 'Input.dispatchMouseEvent' });
  const rejected = assert.rejects(pending, error => error.code === 'browser_disconnected');
  await until(() => chrome.calls.length === 1);
  const request = chrome.calls[0];
  edge.socket.write(JSON.stringify({ type: 'response', id: request.id, clientId: request.clientId, result: 'forged' }));
  await delay(30); chrome.socket.destroy();
  await rejected;
  assert.equal(edge.calls.length, 0); assert.equal(chrome.calls.length, 1);
  await assert.rejects(f.call(broker, 'a'), error => error.code === 'browser_unavailable');
});

test('caller timeout does not unlock switching while the browser command is still unacknowledged', async t => {
  const f = fixture(t), broker = await f.create();
  const chrome = await f.connect(broker, 'chrome'), edge = await f.connect(broker, 'edge'); chrome.hold = true;
  await assert.rejects(requestChromeConnector('debugger.command', { scopeId: 'a', tabId: 42, command: 'Input.dispatchMouseEvent' },
    { configPath: broker.configPath, timeoutMs: 100 }), error => error.code === 'browser_connector_timeout');
  await assert.rejects(f.call(broker, 'a', 'browser.select', { connectionId: edge.id }), error => error.code === 'browser_session_busy');
  const pending = chrome.calls[0];
  chrome.socket.write(JSON.stringify({ type: 'response', clientId: pending.clientId, id: pending.id, result: {} }));
  chrome.hold = false;
  // A list request provides a round trip after the delayed acknowledgement.
  await f.call(broker, 'a');
  await f.call(broker, 'a', 'browser.select', { connectionId: edge.id });
  assert.equal((await f.call(broker, 'a')).browser, 'edge');
});
