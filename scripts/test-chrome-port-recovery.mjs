import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { randomBytes, webcrypto } from 'node:crypto';
import { ChromeConnectorWebSocket } from '../dist-electron/chromeConnectorWebSocket.js';
import { chromeConnectorDiscoveryPorts } from '../dist-electron/chromeConnectorConstants.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) { assert.ok(Date.now() < deadline, 'port recovery timed out'); await delay(10); }
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cardbush-port-recovery-'));
  const credential = { id: randomBytes(16).toString('hex'), secret: randomBytes(32).toString('hex'), browser: 'chrome', label: 'Existing browser' };
  const saved = { version: 3, port: 60123, credentials: [credential], defaultConnectionId: credential.id };
  const file = path.join(root, 'pairing.json');
  fs.writeFileSync(file, JSON.stringify(saved));
  const server = new ChromeConnectorWebSocket(root, () => {});
  t.after(async () => { server.stop(); await delay(20); fs.rmSync(root, { recursive: true, force: true }); });
  return { server, saved, file };
}

for (const code of ['EACCES', 'EADDRINUSE']) test(`${code}: a saved endpoint recovers without replacing pairing or accumulating listen callbacks`, async t => {
  const f = fixture(t), original = http.Server.prototype.listen, attempts = [];
  let listenerCounts;
  t.mock.method(http.Server.prototype, 'listen', function(port, ...args) {
    attempts.push(port);
    const counts = { listening: this.listenerCount('listening'), error: this.listenerCount('error') };
    listenerCounts ??= counts;
    assert.deepEqual(counts, listenerCounts, 'each rejected listen must remove its callbacks');
    if (port === f.saved.port || port === chromeConnectorDiscoveryPorts[0]) {
      process.nextTick(() => this.emit('error', Object.assign(new Error('fixture bind conflict'), { code })));
      return this;
    }
    return original.call(this, port, ...args);
  });
  await f.server.start();
  assert.equal(attempts[0], f.saved.port);
  assert.equal(attempts[1], chromeConnectorDiscoveryPorts[0]);
  assert.ok(chromeConnectorDiscoveryPorts.includes(f.server.port));
  assert.deepEqual(f.server.portRecovery, { previousPort: f.saved.port, port: f.server.port, reason: code });
  const saved = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  assert.deepEqual(saved.credentials, f.saved.credentials);
  assert.equal(saved.defaultConnectionId, f.saved.defaultConnectionId);
  assert.equal(saved.port, f.server.port);
});

test('unavailable candidate set fails once with useful diagnostics and leaves saved credentials untouched', async t => {
  const f = fixture(t), before = fs.readFileSync(f.file, 'utf8'), attempts = [];
  t.mock.method(http.Server.prototype, 'listen', function(port) {
    attempts.push(port);
    process.nextTick(() => this.emit('error', Object.assign(new Error('fixture reserved port'), { code: 'EACCES' })));
    return this;
  });
  await assert.rejects(f.server.start(), error => {
    assert.equal(error.code, 'connector_ports_unavailable');
    assert.equal(error.cause.code, 'EACCES');
    assert.deepEqual(error.attemptedPorts, [f.saved.port, ...chromeConnectorDiscoveryPorts]);
    return true;
  });
  assert.equal(attempts.length, chromeConnectorDiscoveryPorts.length + 1);
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});

test('unrelated listener failures are not hidden or retried', async t => {
  const f = fixture(t), attempts = [];
  t.mock.method(http.Server.prototype, 'listen', function(port) {
    attempts.push(port);
    process.nextTick(() => this.emit('error', Object.assign(new Error('fixture resource exhaustion'), { code: 'EMFILE' })));
    return this;
  });
  await assert.rejects(f.server.start(), { code: 'EMFILE' });
  assert.deepEqual(attempts, [f.saved.port]);
});

function transport(t, mode = 'silent') {
  const attempts = [], active = new Set(), messages = [], timers = new Set();
  let maximumActive = 0, disconnects = 0, sent = 0;
  class Candidate {
    static OPEN = 1;
    constructor(url) {
      this.readyState = 1; attempts.push(url); active.add(this);
      maximumActive = Math.max(maximumActive, active.size);
      if (mode === 'untrusted') queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({
        type: 'connector_ready', protocol: 'cardbush.chrome_connector.v1',
      }) }));
    }
    send() { sent++; }
    close() { this.readyState = 3; active.delete(this); }
  }
  const sandbox = vm.createContext({ WebSocket: Candidate, navigator: { userAgent: 'Chrome/153' },
    crypto: webcrypto, TextEncoder, Uint8Array, setInterval, clearInterval,
    setTimeout: (fn, ms) => { const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer); return timer; },
    clearTimeout: timer => { timers.delete(timer); clearTimeout(timer); },
  });
  vm.runInContext(fs.readFileSync('assets/plugins/chrome/extension/connector-transport.js', 'utf8'), sandbox);
  assert.deepEqual(Array.from(vm.runInContext('CONNECTOR_DISCOVERY_PORTS', sandbox)), chromeConnectorDiscoveryPorts);
  const pairing = { port: 60123, id: '1'.repeat(32), secret: '2'.repeat(64) };
  const port = vm.runInContext(`createConnectorPort(${JSON.stringify(pairing)}, { attemptTimeoutMs: 30 })`, sandbox);
  port.onMessage.addListener(value => messages.push(value));
  port.onDisconnect.addListener(() => { disconnects++; });
  t.after(() => port.disconnect());
  return { port, attempts, active, messages, timers, state: () => ({ maximumActive, disconnects, sent }) };
}

for (const mode of ['silent', 'untrusted']) test(`${mode} endpoints cannot stall discovery or authorize browser control`, async t => {
  const f = transport(t, mode);
  await until(() => f.state().disconnects === 1);
  assert.ok(f.attempts.length > 1);
  assert.ok(f.attempts.length <= chromeConnectorDiscoveryPorts.length + 1);
  assert.ok(f.state().maximumActive <= 4);
  assert.equal(new Set(f.attempts).size, f.attempts.length);
  for (const endpoint of f.attempts) {
    const url = new URL(endpoint);
    assert.equal(url.hostname, '127.0.0.1');
    assert.ok([60123, ...chromeConnectorDiscoveryPorts].includes(Number(url.port)));
  }
  assert.equal(f.messages.length, 1, 'intermediate probe failures do not produce repeated user errors');
  assert.equal(f.messages[0].code, 'connector_unavailable');
  assert.equal(f.port.endpointPort, null);
  f.port.postMessage({ type: 'request', method: 'tabs.list' });
  assert.equal(f.state().sent, 0);
  assert.equal(f.active.size, 0);
  assert.equal(f.timers.size, 0);
});

test('explicit disconnect cancels discovery, sockets and deadlines without further probes', async t => {
  const f = transport(t);
  await until(() => f.attempts.length > 1);
  f.port.disconnect();
  const count = f.attempts.length;
  await delay(100);
  assert.equal(f.attempts.length, count);
  assert.equal(f.active.size, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.state().disconnects, 1);
  assert.equal(f.messages.length, 0);
});
