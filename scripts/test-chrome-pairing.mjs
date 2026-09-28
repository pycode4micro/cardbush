import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import { webcrypto, randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { ChromeConnectorBroker } from '../dist-electron/chromeConnectorBroker.js';
import { ChromeConnectorWebSocket, connectorProof } from '../dist-electron/chromeConnectorWebSocket.js';
import { pairedClient, extensionOrigin } from './helpers/chrome-paired-client.mjs';
import { requestChromeConnector } from '../packages/cardbush-chrome-mcp/dist/bridgeClient.js';

const nativeHostPath = path.resolve('dist-native/chrome-connector-validation/CardBushBrowserHost.exe');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async predicate => { for (let n = 0; n < 100; n++) { if (predicate()) return; await delay(20); } assert.fail('Timed out'); };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cardbush-pairing-'));
  const brokers = [];
  t.after(async () => { for (const broker of brokers) broker.stop(); await delay(30); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, create: () => { const broker = new ChromeConnectorBroker(root, { nativeHostPath }); brokers.push(broker); return broker; } };
}

test('real loopback pairing, MCP routing, restart and replacement preserve security boundaries', async t => {
  const f = fixture(t), broker = f.create(); await broker.start();
  const firstCode = broker.createPairing().code;
  assert.equal(JSON.stringify(broker.status()).includes(firstCode.split('.').at(-1)), false);
  await assert.rejects(pairedClient(firstCode, { origin: 'https://evil.example' }));
  await assert.rejects(pairedClient(firstCode, { origin: 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }));
  await assert.rejects(pairedClient(firstCode.replace(/[a-f0-9]{64}$/, '0'.repeat(64))));
  const extension = await pairedClient(firstCode);
  assert.equal(broker.status().paired, true); assert.equal(broker.status().extensionConnected, true);
  const gotRequest = new Promise(resolve => extension.once('data', value => resolve(JSON.parse(value))));
  const result = requestChromeConnector('tabs.list', { scopeId: 'one' }, { configPath: broker.configPath });
  const request = await gotRequest;
  extension.write(JSON.stringify({ type: 'response', clientId: request.clientId, id: request.id, result: { tabs: [42] } }));
  assert.deepEqual(await result, { tabs: [42] });
  const code = broker.createPairing().code;
  const replacement = await pairedClient(code);
  await until(() => extension.destroyed);
  await assert.rejects(pairedClient(firstCode), 'a successful new pairing revokes the old credential');
  broker.stop(); await until(() => replacement.destroyed);
  await assert.rejects(pairedClient(code), 'a stopped connector has no loopback listener');
  const restarted = f.create(); await restarted.start();
  const afterRestart = await pairedClient(code);
  assert.equal(restarted.status().extensionConnected, true);
  const config = JSON.parse(fs.readFileSync(restarted.configPath));
  const pipe = net.createConnection(config.endpoint); pipe.on('error', () => {});
  await new Promise(resolve => pipe.once('connect', resolve));
  pipe.write(JSON.stringify({ type: 'hello', protocol: config.protocol, role: 'extension', token: config.token }) + '\n');
  await until(() => pipe.destroyed);
  assert.equal(restarted.status().extensionConnected, true, 'MCP secret cannot impersonate the extension');
  afterRestart.destroy();
});

test('pairing expires, superseded offers fail, and incomplete challenge cannot authorize a browser', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cardbush-pair-expiry-'));
  let connected = 0;
  const server = new ChromeConnectorWebSocket(directory, () => connected++, { pairingTtlMs: 50, handshakeTimeoutMs: 100 });
  t.after(async () => { server.stop(); await delay(20); fs.rmSync(directory, { recursive: true, force: true }); });
  await server.start();
  const expired = server.createPairing().code;
  await delay(70); await assert.rejects(pairedClient(expired));
  const old = server.createPairing().code; const code = server.createPairing().code;
  await assert.rejects(pairedClient(old));
  const [, port, id, secret] = code.split('.'), nonce = randomBytes(32).toString('hex');
  const protocols = ['cardbush-v2', `auth.${id}.${nonce}.${connectorProof(secret, `upgrade:${id}:${nonce}`)}`];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/connect`, protocols, { origin: extensionOrigin });
  socket.on('error', () => {});
  const closed = new Promise(resolve => socket.on('close', resolve));
  await new Promise(resolve => socket.once('message', resolve));
  socket.send(JSON.stringify({ type: 'authenticate', proof: '0'.repeat(64) }));
  await closed; assert.equal(connected, 0);
  const replay = new WebSocket(`ws://127.0.0.1:${port}/connect`, protocols, { origin: extensionOrigin });
  replay.on('error', () => {}); await new Promise(resolve => replay.on('close', resolve));
  assert.equal(connected, 0);
});

test('actual extension transport verifies the broker before enabling browser commands', async t => {
  const f = fixture(t), broker = f.create(); await broker.start();
  const code = broker.createPairing().code;
  const source = fs.readFileSync('assets/plugins/chrome/extension/connector-transport.js', 'utf8');
  class BrowserSocket extends WebSocket { constructor(url, protocols) { super(url, protocols, { origin: extensionOrigin }); } }
  const sandbox = vm.createContext({ WebSocket: BrowserSocket, crypto: webcrypto, TextEncoder, Uint8Array, setInterval, clearInterval });
  vm.runInContext(source, sandbox);
  const open = value => vm.runInContext(`createConnectorPort(parseConnectorPairing(${JSON.stringify(value)}))`, sandbox);
  const port = open(code); t.after(() => port.disconnect());
  const messages = [];
  port.onMessage.addListener(message => messages.push(message));
  await until(() => messages.some(message => message.type === 'connector_ready'));
  port.postMessage({ type: 'status', controlledTabCount: 1, version: 'actual-transport' });
  await until(() => broker.status().extensionVersion === 'actual-transport');
  port.disconnect(); await until(() => !broker.status().extensionConnected);

  const impostor = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => impostor.once('listening', resolve));
  t.after(() => { for (const client of impostor.clients) client.terminate(); impostor.close(); });
  let leaked = false;
  impostor.on('connection', socket => {
    socket.on('message', () => { leaked = true; });
    socket.send(JSON.stringify({ type: 'challenge', protocol: 'cardbush.chrome_connector.v1', nonce: '0'.repeat(64), proof: '0'.repeat(64) }));
  });
  const fakePort = open(code.replace(/^CB2\.\d+/, `CB2.${impostor.address().port}`));
  let disconnected = false; fakePort.onDisconnect.addListener(() => { disconnected = true; });
  await until(() => disconnected); assert.equal(leaked, false, 'a port hijacker receives neither secret nor browser messages');
});
