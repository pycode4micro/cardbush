import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { SIWC } from '@cardbush/bush-protocol';
import { SiwcAccounts } from '../dist-electron/siwcAccounts.mjs';
import { SiwcOAuth } from '../dist-electron/siwcOAuth.mjs';

// Synthetic accounts/tokens only. Signing keys are generated per run; no real
// OpenAI credentials, account files or external OAuth requests are used.
const pair = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(pair.publicKey), kid: 'fixture-key', alg: 'RS256' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { resolve, promise }; };
async function fixture(t, options = {}) {
  let data, now = Date.now(), nonce, count = 0, client = 'oaiapp_fixture1';
  const requests = [], authorizations = [], invalidated = [];
  const state = { subject: 'subject-1', scope: SIWC.scopes, refreshBarrier: undefined, ...options };
  const fetcher = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url === SIWC.discovery) return Response.json({ issuer: SIWC.issuer, jwks_uri: `${SIWC.issuer}/.well-known/jwks.json`, revocation_endpoint: `${SIWC.issuer}/oauth/revoke` });
    if (url.endsWith('/jwks.json')) return Response.json({ keys: [jwk] });
    if (url.endsWith('/oauth/revoke')) return new Response(null, { status: state.revokeFailed ? 503 : 200 });
    if (url === `${SIWC.resource}/models`) return Response.json({ models: [
      { slug: 'gpt-fixture-latest', display_name: 'Fixture GPT', visibility: 'list' }, { slug: 'hidden', visibility: 'hide' },
      { slug: 'gpt-fixture-next', visibility: 'list' },
    ] });
    assert.equal(url, SIWC.token); assert.equal(init.redirect, 'error');
    const body = init.body, refresh = body.get('grant_type') === 'refresh_token';
    assert.equal(body.get('resource'), SIWC.resource); assert.notEqual(body.get('client_id'), SIWC.registrationClient);
    if (state.exchangeFailed) return Response.json({ error: 'invalid_grant', error_description: 'PRIVATE_TOKEN_DATA' }, { status: 400 });
    if (refresh) { assert.equal(body.has('scope'), false); await state.refreshBarrier?.promise; }
    else { assert.equal(body.get('client_id'), client); assert.equal(body.get('redirect_uri'), authorizations.at(-1).searchParams.get('redirect_uri')); }
    count++;
    return Response.json({ access_token: `PRIVATE_ACCESS_${count}`, refresh_token: `PRIVATE_REFRESH_${count}`, expires_in: 3600,
      token_type: 'Bearer', scope: state.scope,
      ...(!refresh ? { id_token: await new SignJWT({ nonce: state.badNonce ? 'wrong' : nonce, email: 'same@example.test' })
        .setProtectedHeader({ alg: 'RS256', kid: jwk.kid }).setIssuer(SIWC.issuer).setAudience(client)
        .setSubject(state.subject).setIssuedAt().setExpirationTime('1h').sign(pair.privateKey) } : {}),
    });
  };
  const oauth = new SiwcOAuth(fetcher);
  const account = new SiwcAccounts({ read: async () => structuredClone(data), write: async value => {
    if (state.writeBarrier && value.accounts.some(item => item.tokens)) { state.writeStarted.resolve(); await state.writeBarrier.promise; }
    data = structuredClone(value);
  }, now: () => now, fetch: fetcher, oauth, changed() {}, invalidated: id => invalidated.push(id),
    openUrl: async raw => {
      const url = new URL(raw); authorizations.push(url); nonce = url.searchParams.get('nonce');
      assert.equal(url.origin + url.pathname, SIWC.authorization);
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      assert.ok(url.searchParams.get('ext_agent_host_id').startsWith('urn:uuid:'));
      const callback = new URL(url.searchParams.get('redirect_uri'));
      assert.equal(callback.hostname, '127.0.0.1'); assert.equal(callback.pathname, SIWC.callbackPath);
      if (state.holdCallback) { state.opened.resolve(callback); return; }
      callback.search = new URLSearchParams({ state: 'invalid' }).toString();
      assert.equal((await fetch(callback)).status, 400, 'stray callbacks cannot consume a transaction');
      const dynamic = url.searchParams.get('client_id') === SIWC.registrationClient;
      client = dynamic ? state.reuseClient ?? `oaiapp_fixture${authorizations.length}` : url.searchParams.get('client_id');
      callback.search = new URLSearchParams({ state: url.searchParams.get('state'), code: 'fixture-code',
        ...(dynamic ? { client_id: client } : {}), ...(state.callbackClient ? { client_id: state.callbackClient } : {}) }).toString();
      const response = await fetch(callback); assert.ok([200, 400].includes(response.status));
    },
  });
  t.after(() => account.close());
  return { account, state, requests, authorizations, invalidated, stored: () => data, expire: () => { now += 3_600_000; } };
}

test('SIWC loopback + PKCE + signed OIDC identity persists per-client registrations without publishing tokens', async t => {
  const f = await fixture(t);
  await f.account.login();
  const first = (await f.account.snapshot()).accounts[0];
  assert.equal(first.state, 'signed_in'); assert.equal(first.planEnabled, true);
  assert.doesNotMatch(JSON.stringify(await f.account.snapshot()), /PRIVATE_|id_token|clientId|hostId/);
  assert.deepEqual((await f.account.models(first.id)).map(item => item.id), ['gpt-fixture-latest', 'gpt-fixture-next']);
  const hostId = f.stored().hostId;
  await f.account.login(first.id);
  const secondAuth = f.authorizations[1].searchParams;
  assert.equal(secondAuth.get('client_id'), 'oaiapp_fixture1'); assert.equal(secondAuth.has('agent_name_hint'), false);
  assert.equal(secondAuth.get('ext_agent_host_id'), hostId);
  assert.notEqual(secondAuth.get('state'), f.authorizations[0].searchParams.get('state'));
  assert.notEqual(secondAuth.get('nonce'), f.authorizations[0].searchParams.get('nonce'));
  f.state.subject = 'another-workspace'; await f.account.login();
  const snapshot = await f.account.snapshot(); assert.equal(snapshot.accounts.length, 2);
  assert.notEqual(snapshot.accounts[0].id, snapshot.accounts[1].id, 'same email must not merge workspace registrations');
  assert.notEqual(f.stored().accounts[0].clientId, f.stored().accounts[1].clientId);
  await f.account.logout(first.id);
  assert.equal(f.stored().accounts[0].clientId, 'oaiapp_fixture1'); assert.equal(f.stored().hostId, hostId);
  assert.equal(f.stored().accounts[0].tokens, undefined); assert.ok(f.stored().accounts[1].tokens);
  await assert.rejects(f.account.access(first.id), /Continue with ChatGPT/);
  assert.ok(await f.account.access(snapshot.accounts[1].id));
  const revoke = f.requests.find(item => item.url.endsWith('/revoke'));
  assert.equal(revoke.init.body.get('client_id'), 'oaiapp_fixture1'); assert.equal(revoke.init.body.get('token_type_hint'), 'refresh_token');
  const restored = new SiwcAccounts({ read: async () => f.stored(), write: async () => {}, openUrl: async () => {}, changed() {}, invalidated() {} });
  t.after(() => restored.close());
  assert.equal((await restored.snapshot()).accounts[0].state, 'signed_out');
});

test('parallel parent/child refreshes rotate once; one cancelled caller does not cancel the other', async t => {
  const f = await fixture(t); await f.account.login(); const id = (await f.account.snapshot()).accounts[0].id;
  f.expire(); f.state.refreshBarrier = deferred();
  t.after(() => f.state.refreshBarrier.resolve());
  const abort = new AbortController();
  const cancelled = f.account.access(id, { signal: abort.signal });
  const other = Array.from({ length: 8 }, () => f.account.access(id));
  await new Promise(resolve => setImmediate(resolve));
  abort.abort(); await assert.rejects(cancelled, /cancel|abort/i);
  f.state.refreshBarrier.resolve();
  const tokens = await Promise.all(other); assert.ok(tokens.every(token => token === 'PRIVATE_ACCESS_2'));
  assert.equal(f.requests.filter(item => item.init?.body?.get?.('grant_type') === 'refresh_token').length, 1);
  assert.equal(f.stored().accounts[0].tokens.refresh_token, 'PRIVATE_REFRESH_2');
  assert.equal(await f.account.access(id, { rejectedToken: 'PRIVATE_ACCESS_1' }), 'PRIVATE_ACCESS_2', 'late 401 cannot rotate the replacement again');
});

test('logout waits for rotation, revokes the replacement, and blocks all new requests', async t => {
  const f = await fixture(t); await f.account.login(); const id = (await f.account.snapshot()).accounts[0].id;
  f.expire(); f.state.refreshBarrier = deferred();
  const refresh = f.account.access(id); void refresh.catch(() => {});
  await new Promise(resolve => setImmediate(resolve));
  const logout = f.account.logout(id); await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.account.access(id), /Continue/);
  f.state.refreshBarrier.resolve(); await logout; await assert.rejects(refresh);
  assert.equal(f.stored().accounts[0].tokens, undefined);
  assert.equal(f.requests.find(item => item.url.endsWith('/revoke')).init.body.get('token'), 'PRIVATE_REFRESH_2');
});

test('a declined plan scope cannot be used for inference and bad nonce/client/identity cannot replace a saved account', async t => {
  const denied = await fixture(t, { scope: 'openid profile email' }); await denied.account.login();
  const account = (await denied.account.snapshot()).accounts[0]; assert.equal(account.planEnabled, false);
  await assert.rejects(denied.account.access(account.id), /not authorized/);
  const f = await fixture(t); await f.account.login(); const saved = structuredClone(f.stored().accounts[0]);
  f.state.badNonce = true; await assert.rejects(f.account.login(saved.id), /invalid identity/);
  assert.deepEqual(f.stored().accounts[0], saved);
  f.state.badNonce = false; f.state.subject = 'wrong-subject'; await assert.rejects(f.account.login(saved.id), /different ChatGPT account/);
  assert.deepEqual(f.stored().accounts[0], saved);
  f.state.callbackClient = 'oaiapp_wrong'; await assert.rejects(f.account.login(saved.id), /invalid client/);
  assert.deepEqual(f.stored().accounts[0], saved);
});

test('failed exchange retains issued client; cancel during persistence rolls credentials back', async t => {
  const f = await fixture(t, { exchangeFailed: true }); await assert.rejects(f.account.login(), /expired or was rejected/);
  assert.equal(f.stored().accounts[0].clientId, 'oaiapp_fixture1'); assert.equal(f.stored().accounts[0].tokens, undefined);
  assert.doesNotMatch(JSON.stringify(await f.account.snapshot()), /PRIVATE_TOKEN_DATA/);
  f.state.exchangeFailed = false;
  f.state.writeStarted = deferred(); f.state.writeBarrier = deferred();
  const login = f.account.login(f.stored().accounts[0].id); await f.state.writeStarted.promise;
  f.account.cancelLogin(); f.state.writeBarrier.resolve(); await assert.rejects(login, /cancelled/);
  assert.equal(f.stored().accounts[0].tokens, undefined);
});

test('revocation failure still clears local tokens and reports that remote sign-out is unconfirmed', async t => {
  const f = await fixture(t, { revokeFailed: true }); await f.account.login(); const id = (await f.account.snapshot()).accounts[0].id;
  await f.account.logout(id); const account = (await f.account.snapshot()).accounts[0];
  assert.equal(account.state, 'signed_out'); assert.match(account.lastError, /Remote revocation was not confirmed/);
  assert.equal(f.stored().accounts[0].tokens, undefined);
});

test('repeated bootstrap for the same validated registration reuses the model account ID', async t => {
  const f = await fixture(t); await f.account.login(); const id = (await f.account.snapshot()).connectedAccountId;
  f.state.reuseClient = f.stored().accounts[0].clientId;
  await f.account.login(); const snapshot = await f.account.snapshot();
  assert.equal(snapshot.connectedAccountId, id); assert.equal(snapshot.accounts.length, 1);
  assert.equal(f.stored().accounts[0].tokens.access_token, 'PRIVATE_ACCESS_2');
});
