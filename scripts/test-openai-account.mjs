import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { OpenAiAccount, OPENAI_ACCOUNT_CREDENTIAL_KEY } from '../dist-electron/openAiAccount.mjs';
import { McpDesktopHost } from '../dist-electron/mcpDesktopHost.js';
import { McpHostBridge, handleMcpHostRequest } from '../dist-electron/mcpHostBridge.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const fixtureTokens = { access_token: 'FIXTURE_ACCESS', refresh_token: 'FIXTURE_REFRESH', expires_in: 3600 };
function fixture(options = {}) {
  let data = options.initial, openCount = 0, changes = 0;
  const account = new OpenAiAccount({ read: async () => structuredClone(data), write: async value => { data = structuredClone(value); },
    openUrl: async () => { openCount++; }, changed: () => { changes++; }, now: () => 1000,
    startLogin: async () => ({ authorizationUrl: 'https://auth.openai.com/fixture', redirectUri: 'http://localhost:0/auth/callback', result: Promise.resolve(fixtureTokens), close: async () => {} }),
    ...options });
  return { account, data: () => data, openCount: () => openCount, changes: () => changes };
}

test('OpenAI account shares the encrypted desktop vault while public state and host errors omit credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-openai-vault-'));
  t.after(() => { assert.ok(resolve(root).startsWith(resolve(tmpdir()))); return rm(root, { recursive: true, force: true }); });
  const path = join(root, 'vault.bin'), key = randomBytes(32);
  const desktop = new McpDesktopHost({ path, encrypt: text => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]);
  }, decrypt: blob => { const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, 12)); decipher.setAuthTag(blob.subarray(12, 28));
    return Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString('utf8'); }, openUrl: async () => {}, changed: () => {} });
  const host = (operation, payload) => desktop.handle(operation, payload, new AbortController().signal);
  await host('credentials.write', { key: 'a'.repeat(64), value: { unrelated: 'MCP_SECRET' } });
  const options = { read: () => host('credentials.read', { key: OPENAI_ACCOUNT_CREDENTIAL_KEY }),
    write: value => host('credentials.write', { key: OPENAI_ACCOUNT_CREDENTIAL_KEY, value }) };
  const { account } = fixture(options); t.after(() => account.close());
  await account.login();
  assert.equal((await account.status()).state, 'signed_in');
  assert.equal((await account.access()).accessToken, 'FIXTURE_ACCESS');
  assert.doesNotMatch(JSON.stringify(await account.status()), /FIXTURE_|auth\.openai/);
  assert.doesNotMatch((await readFile(path)).toString('utf8'), /FIXTURE_|MCP_SECRET/);
  const reloaded = fixture(options).account; t.after(() => reloaded.close());
  assert.equal((await reloaded.status()).state, 'signed_in');
  assert.equal((await reloaded.access()).accessToken, 'FIXTURE_ACCESS');
  await account.logout();
  assert.equal(await options.read(), undefined);
  assert.deepEqual(await host('credentials.read', { key: 'a'.repeat(64) }), { unrelated: 'MCP_SECRET' });
  let bridge;
  bridge = new McpHostBridge(async message => bridge.receive(await handleMcpHostRequest(message, new AbortController().signal, () => account.access())));
  await assert.rejects(bridge.request('openai.access-token', {}), error => error.code === 'mcp_auth_required' && !error.message.includes('FIXTURE_'));
});

test('parallel refresh rotates once, preserves refresh tokens omitted by the issuer and avoids a second stale-token refresh', async t => {
  const entered = deferred(), release = deferred(); let refreshes = 0;
  const { account, data } = fixture({ initial: { tokens: fixtureTokens, expiresAt: 900 }, fetch: async (url, init) => {
    refreshes++; assert.equal(url, 'https://auth.openai.com/oauth/token'); assert.equal(init.redirect, 'error');
    assert.equal(init.body.get('grant_type'), 'refresh_token'); assert.equal(init.body.get('refresh_token'), 'FIXTURE_REFRESH');
    entered.resolve(); await release.promise; return json({ access_token: 'FIXTURE_ROTATED', expires_in: 3600 });
  } }); t.after(() => account.close());
  const calls = Array.from({ length: 8 }, () => account.access()); await entered.promise; release.resolve();
  const results = await Promise.all(calls);
  assert.equal(refreshes, 1); assert.ok(results.every(value => value.accessToken === 'FIXTURE_ROTATED'));
  assert.equal(data().tokens.refresh_token, 'FIXTURE_REFRESH');
  await account.access({ rejectedToken: 'FIXTURE_ACCESS' }); assert.equal(refreshes, 1);
});

test('a late refresh cannot restore credentials after logout', async t => {
  const entered = deferred(), release = deferred();
  const { account, data } = fixture({ initial: { tokens: fixtureTokens, expiresAt: 900 }, fetch: async () => {
    entered.resolve(); await release.promise; return json({ access_token: 'LATE_SECRET', expires_in: 3600 });
  } }); t.after(() => account.close());
  const refresh = account.access(); await entered.promise; await account.logout(); release.resolve();
  await assert.rejects(refresh); assert.equal(data(), undefined); assert.equal((await account.status()).state, 'signed_out');
});

test('cancelling a login while secure storage is writing restores the prior credential state', async t => {
  const entered = deferred(), release = deferred(); let data;
  const { account } = fixture({ write: async value => { data = value; if (value) { entered.resolve(); await release.promise; } } });
  t.after(() => account.close());
  const login = account.login(); await entered.promise; account.cancelLogin(); release.resolve();
  await assert.rejects(login, /cancelled/); assert.equal(data, undefined); assert.equal((await account.status()).state, 'signed_out');
});

test('a newer login supersedes an in-flight refresh and changes the connection generation', async t => {
  const entered = deferred(), release = deferred();
  const { account, data } = fixture({ initial: { tokens: fixtureTokens, expiresAt: 900 }, fetch: async () => {
    entered.resolve(); await release.promise; return json({ access_token: 'OLD_ACCOUNT_TOKEN', expires_in: 3600 });
  } }); t.after(() => account.close());
  const refresh = account.access(); await entered.promise; await account.login(); release.resolve();
  await assert.rejects(refresh); assert.equal(data().tokens.access_token, 'FIXTURE_ACCESS');
  assert.equal((await account.access()).generation, 1);
});

test('refresh rejection requires sign-in; other caller cancellation does not cancel shared refresh', async t => {
  const expired = fixture({ initial: { tokens: fixtureTokens, expiresAt: 900 }, fetch: async () => json({ error: 'SENSITIVE_UPSTREAM_ERROR' }, 400) }).account;
  t.after(() => expired.close());
  await assert.rejects(expired.access()); assert.equal((await expired.status()).state, 'reauth_required');
  assert.doesNotMatch(JSON.stringify(await expired.status()), /SENSITIVE_/);
  const entered = deferred(), release = deferred(), caller = new AbortController();
  const concurrent = fixture({ initial: { tokens: fixtureTokens, expiresAt: 900 }, fetch: async () => {
    entered.resolve(); await release.promise; return json({ access_token: 'ROTATED', expires_in: 3600 });
  } }).account; t.after(() => concurrent.close());
  const first = concurrent.access({ signal: caller.signal }), second = concurrent.access();
  await entered.promise; caller.abort(); await assert.rejects(first); release.resolve();
  assert.equal((await second).accessToken, 'ROTATED');
});

test('failed secure storage never falls back to plaintext or exposes its error contents', async t => {
  const { account } = fixture({ write: async () => { throw Error('FIXTURE_PRIVATE_STORAGE_ERROR'); } }); t.after(() => account.close());
  await assert.rejects(account.login(), error => !error.message.includes('FIXTURE_PRIVATE'));
  await assert.rejects(account.access()); assert.equal((await account.status()).state, 'signed_out');
  assert.doesNotMatch(JSON.stringify(await account.status()), /FIXTURE_PRIVATE/);
});
