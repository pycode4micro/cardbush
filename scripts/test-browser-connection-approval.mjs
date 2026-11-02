import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createECDH, createHash, randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { connectorProof } from '../dist-electron/browserConnectorWebSocket.js';
import { BrowserConnectorBroker } from '../dist-electron/browserConnectorBroker.js';
import { approvalClient } from './helpers/browser-approval-client.mjs';
import { pairedClient, extensionOrigin } from './helpers/chrome-paired-client.mjs';

const nativeHostPath = resolve('dist-native/chrome-connector-test/CardBushBrowserHost.exe');
const identity = () => ({ id: randomBytes(16).toString('hex') });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(20); } assert.fail('Timed out'); }
async function fixture(t, options) {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-browser-approval-'));
  const broker = new BrowserConnectorBroker(root, { nativeHostPath, ...options });
  t.after(async () => { broker.stop(); await delay(100); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  await broker.start();
  const saved = () => readFile(join(root, 'browser-connector/pairing.json'), 'utf8').then(JSON.parse);
  return { broker, root, saved, port: (await saved()).port };
}

test('approval is required before pairing or control, and concurrent requests do not stack dialogs', async t => {
  let settle, count = 0;
  const f = await fixture(t, { allowLocalPairing: () => true });
  const request = identity(), pending = approvalClient(f.port, request, { confirm: async () => { count++; return new Promise(resolve => { settle = resolve; }); } });
  await until(() => settle);
  assert.equal(f.broker.status().paired, false);
  assert.deepEqual((await f.saved()).credentials, []);
  await assert.rejects(pairedClient(request.pending));
  await assert.rejects(approvalClient(f.port, identity()), error => error.code === 'approval_busy');
  assert.equal(count, 1);
  settle(true); const result = await pending;
  const peer = await pairedClient(result.code); t.after(() => peer.destroy());
  assert.equal(f.broker.status().extensionConnected, true);
  assert.equal((await approvalClient(f.port, request)).code, result.code);
  assert.equal(count, 1, 'lost approval replies do not ask twice');
});

test('denial survives restart and background retries cannot reopen the dialog', async t => {
  let count = 0;
  const approve = async () => { count++; return false; };
  const f = await fixture(t, { allowLocalPairing: () => true });
  const request = identity();
  await assert.rejects(approvalClient(f.port, request, { confirm: approve }), error => error.code === 'connection_denied');
  assert.equal((await f.saved()).credentials.length, 0);
  f.broker.stop(); await delay(80);
  const restarted = new BrowserConnectorBroker(f.root, { nativeHostPath, allowLocalPairing: () => true });
  t.after(() => restarted.stop()); await restarted.start();
  await assert.rejects(approvalClient(f.port, request), error => error.code === 'connection_revoked');
  await assert.rejects(approvalClient(f.port, identity()), error => error.code === 'approval_busy');
  assert.equal(count, 1); restarted.stop();
});

test('disconnecting cancels browser consent and a late approval cannot grant access', async t => {
  let settle, receivedSignal;
  const f = await fixture(t, { allowLocalPairing: () => true });
  const abort = new AbortController(), request = identity();
  const pending = approvalClient(f.port, request, { signal: abort.signal, confirm: async signal => {
    receivedSignal = signal; return new Promise(resolve => { settle = resolve; });
  } });
  await until(() => settle); abort.abort();
  await assert.rejects(pending, error => error.code === 'cancelled');
  await until(() => receivedSignal.aborted); settle(true); await delay(50);
  assert.deepEqual((await f.saved()).credentials, []);
  await assert.rejects(pairedClient(request.pending));
});

test('timed out consent fails closed even when the dialog callback returns later', async t => {
  let settle, receivedSignal;
  const f = await fixture(t, { approvalTimeoutMs: 100, allowLocalPairing: () => true });
  await assert.rejects(approvalClient(f.port, identity(), { confirm: async signal => {
    receivedSignal = signal; return new Promise(resolve => { settle = resolve; });
  } }), error => error.code === 'connection_denied');
  assert.equal(receivedSignal.aborted, true); settle(true); await delay(30);
  assert.deepEqual((await f.saved()).credentials, []);
});

test('remote or standalone brokers have no automatic enrollment endpoint', async t => {
  const f = await fixture(t, {});
  await assert.rejects(approvalClient(f.port, identity()), error => error.code === 'connector_unavailable');
  assert.equal(f.broker.status().paired, false);
});

test('an enabled connector alone never grants access when the extension declines', async t => {
  const f = await fixture(t, { allowLocalPairing: () => true });
  const request = identity();
  await assert.rejects(approvalClient(f.port, request, { confirm: async () => false }), error => error.code === 'connection_denied');
  assert.equal((await f.saved()).credentials.length, 0);
  await assert.rejects(pairedClient(request.pending));
});

test('a fake local service cannot skip browser-owned consent by fabricating approval', async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  t.after(() => { for (const client of server.clients) client.terminate(); server.close(); });
  await new Promise(resolve => server.once('listening', resolve));
  let confirmations = 0;
  server.on('connection', client => {
    let request, secret;
    client.on('message', bytes => {
      const message = JSON.parse(String(bytes));
      if (message.type === 'pair_request') {
        request = message;
        const key = createECDH('prime256v1'); key.generateKeys();
        const publicKey = key.getPublicKey('hex');
        secret = createHash('sha256').update(key.computeSecret(Buffer.from(message.key, 'hex')))
          .update(`cardbush-pair-v3:${message.id}:${message.browser}:${message.key}:${publicKey}:${message.ticketId ?? ''}:${message.rotate === true}`).digest('hex');
        client.send(JSON.stringify({ type: 'pair_challenge', key: publicKey }));
      } else if (message.type === 'pair_confirm') {
        client.send(JSON.stringify({ type: 'pair_approved', proof: connectorProof(secret, `approved:${request.id}:${request.nonce}`) }));
      }
    });
  });
  await assert.rejects(approvalClient(server.address().port, identity(), { approvalTimeoutMs: 100,
    confirm: async () => { confirmations++; return true; } }), error => error.code === 'connection_denied');
  assert.equal(confirmations, 0);
});

test('an untrusted candidate cannot approve a saved identity or learn its secret', async t => {
  const f = await fixture(t, { approvalCooldownMs: 0, allowLocalPairing: () => true });
  const request = identity(), result = await approvalClient(f.port, request);
  await assert.rejects(approvalClient(f.port, { id: request.id }), error => error.code === 'identity_conflict');
  const peer = await pairedClient(result.code); t.after(() => peer.destroy());
  assert.ok(!JSON.stringify(f.broker.status()).includes(result.code.split('.').at(-1)));
});

test('disabling Browser Use while the confirmation is open rejects even an explicit accept', async t => {
  let enabled = true, settle;
  const f = await fixture(t, { allowLocalPairing: () => enabled });
  const request = identity();
  const pending = approvalClient(f.port, request, { confirm: () => new Promise(resolve => { settle = resolve; }) });
  await until(() => settle);
  assert.equal(f.broker.status().connectionAttempt.stage, 'awaiting_browser_approval');
  enabled = false; settle(true);
  await assert.rejects(pending, error => error.code === 'connector_disabled');
  assert.deepEqual((await f.saved()).credentials, []);
  await assert.rejects(pairedClient(request.pending));
});

test('old enrollment clients receive an update requirement, while saved pairings remain usable', async t => {
  const f = await fixture(t, { allowLocalPairing: () => true });
  const old = new WebSocket(`ws://127.0.0.1:${f.port}/request-connection`, 'cardbush-pair-v1', { origin: extensionOrigin });
  t.after(() => old.terminate());
  const message = await new Promise((resolve, reject) => { old.once('message', data => resolve(JSON.parse(String(data)))); old.once('error', reject); });
  assert.deepEqual(message, { type: 'pair_error', code: 'extension_update_required' });
  assert.equal(f.broker.status().paired, false);
  const pairing = f.broker.createPairing();
  const connected = await pairedClient(pairing.code); t.after(() => connected.destroy());
  assert.equal(f.broker.status().extensionConnected, true);
});

test('refresh replaces the live credential, closes old sockets and resumes a lost receipt without another approval', async t => {
  const f=await fixture(t,{allowLocalPairing:()=>true,approvalCooldownMs:0});
  const request=identity(), first=await approvalClient(f.port,request);
  const peer=await pairedClient(first.code);t.after(()=>peer.destroy());
  const before=f.broker.status().defaultConnectionId;
  request.refresh=true;
  let confirmations=0;
  const next=await approvalClient(f.port,request,{confirm:async()=>{confirmations++;return true;}});
  await until(()=>peer.destroyed);
  assert.notEqual(first.code,next.code);assert.equal(first.code.split('.')[2],next.code.split('.')[2]);
  await assert.rejects(pairedClient(first.code));
  assert.equal(f.broker.status().defaultConnectionId,before);
  assert.equal((await f.saved()).credentials.length,1);assert.equal((await f.saved()).profiles.length,1);
  const resumed=await approvalClient(f.port,request,{confirm:async()=>{assert.fail('receipt recovery cannot prompt again');}});
  assert.equal(resumed.code,next.code);assert.equal(confirmations,1);
  const active=await pairedClient(next.code);t.after(()=>active.destroy());
});

test('profile ids and labels alone cannot replace or resurrect another profile, even with a manual ticket', async t => {
  const f=await fixture(t,{allowLocalPairing:()=>true,approvalCooldownMs:0});
  const owner=identity(), first=await approvalClient(f.port,owner);
  const attacker={id:owner.id,refresh:true};
  await assert.rejects(approvalClient(f.port,attacker),error=>error.code==='identity_conflict');
  const ticket=f.broker.createPairing().code;
  await assert.rejects(approvalClient(f.port,attacker,{pairingCode:ticket}),error=>error.code==='identity_conflict');
  f.broker.revokeConnection(owner.id);
  await assert.rejects(approvalClient(f.port,attacker,{pairingCode:ticket}),error=>error.code==='identity_conflict');
  owner.refresh=true;
  const recovered=await approvalClient(f.port,owner,{pairingCode:ticket});
  assert.equal(recovered.code.split('.')[2],owner.id);
  assert.deepEqual((await f.saved()).revoked,[]);
  await assert.rejects(pairedClient(first.code));
});

test('declined refresh leaves the current credential intact; revocation during refresh wins over late consent', async t => {
  const f=await fixture(t,{allowLocalPairing:()=>true,approvalCooldownMs:0});
  const owner=identity(), first=await approvalClient(f.port,owner);
  owner.refresh=true;
  await assert.rejects(approvalClient(f.port,owner,{confirm:async()=>false}),error=>error.code==='connection_denied');
  assert.deepEqual((await f.saved()).revoked,[]);
  const peer=await pairedClient(first.code);t.after(()=>peer.destroy());
  let settle;owner.refresh=true;
  const replacing=approvalClient(f.port,owner,{confirm:()=>new Promise(resolve=>{settle=resolve;})});
  await until(()=>settle);f.broker.revokeConnection(owner.id);settle(true);
  await assert.rejects(replacing,error=>error.code==='identity_conflict');
  assert.equal((await f.saved()).credentials.length,0);
  assert.deepEqual((await f.saved()).revoked,[owner.id]);
  assert.equal((await f.saved()).profiles.length,1);
});

test('a full connection list still permits in-place renewal but cannot admit a ninth profile', async t => {
  const f=await fixture(t,{allowLocalPairing:()=>true,approvalCooldownMs:0});
  const owners=[];
  for(let i=0;i<8;i++){const owner=identity();await approvalClient(f.port,owner);owners.push(owner);}
  const ticket=f.broker.createPairing().code;
  await assert.rejects(approvalClient(f.port,identity(),{pairingCode:ticket}),error=>error.code==='connection_limit');
  owners[0].refresh=true;
  await approvalClient(f.port,owners[0],{pairingCode:ticket});
  assert.equal((await f.saved()).credentials.length,8);assert.equal((await f.saved()).profiles.length,8);
  assert.deepEqual((await f.saved()).revoked,[]);
});
