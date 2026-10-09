import test from 'node:test';
import assert from 'node:assert/strict';
import { McpOAuthCoordinator, credentialKey } from '../dist/index.js';
import { oauthServer } from './fixtures/oauthServer.mjs';

function vault() {
  const values = new Map();
  return { values, store: {
    read: async key => structuredClone(values.get(key)),
    write: async (key, value) => { if (value) values.set(key, structuredClone(value)); else values.delete(key); },
  } };
}

test('discovery cannot relabel a preset secret for another authorization server', async t => {
  const fixture = await oauthServer({ clientId: 'private', clientSecret: 'must-not-be-sent' });
  t.after(() => fixture.close());
  const { values, store } = vault(), ref = 'a'.repeat(64);
  const server = { id: 'issuer-check', transport: { kind: 'streamable_http', url: fixture.url + '/mcp',
    oauth: { clientId: 'private', clientSecretRef: ref, expectedIssuer: 'https://trusted.example' } } };
  values.set(ref, { clientSecret: { value: 'must-not-be-sent', url: server.transport.url, clientId: 'private' } });
  let opened = 0;
  const requests = [];
  const oauth = new McpOAuthCoordinator(store, async () => { opened++; }, () => async (url, init) => {
    requests.push(String(init?.body ?? ''));
    return fetch(url, init);
  });
  t.after(() => oauth.close());
  await assert.rejects(oauth.login(server), /does not match.*expectedIssuer/);
  assert.equal(opened, 0);
  assert.equal(fixture.counters.codes, 0);
  assert.equal(fixture.counters.registrations, 0);
  assert.ok(requests.length > 0, 'exercise real SDK discovery');
  assert.ok(requests.every(body => !body.includes('must-not-be-sent')));
  const provider = oauth.provider(server);
  await assert.rejects(provider.clientInformation({ issuer: fixture.url }), /does not match/);
  assert.equal((await provider.clientInformation({ issuer: 'https://trusted.example/' })).issuer, 'https://trusted.example');
  const unbound = { ...server, transport: { ...server.transport, oauth: { clientId: 'private', clientSecretRef: ref } } };
  await assert.rejects(oauth.login(unbound), /Configure the trusted.*expectedIssuer/);
});

test('stored tokens and registered clients require their own issuer stamp on reads and writes', async () => {
  const { values, store } = vault();
  const issuer = 'https://auth.example/tenant';
  const server = { id: 'stamped', transport: { kind: 'streamable_http', url: 'https://resource.example/mcp' } };
  values.set(credentialKey(server), { issuer, tokens: { [issuer]: { access_token: 'unstamped', token_type: 'Bearer' } },
    clients: { [issuer]: { client_id: 'unstamped', client_secret: 'unstamped-secret' } } });
  const provider = new McpOAuthCoordinator(store, async () => {}).provider(server, { redirectUrl: 'http://127.0.0.1/callback', state: 'test' });
  assert.equal(await provider.tokens(), undefined);
  assert.equal(await provider.clientInformation({ issuer }), undefined);
  await assert.rejects(provider.saveTokens({ access_token: 'no-stamp', token_type: 'Bearer' }, { issuer }), /matching issuer/);
  await assert.rejects(provider.saveClientInformation({ client_id: 'wrong-stamp', issuer: 'https://other.example' }, { issuer }), /matching issuer/);
  const tokens = { access_token: 'bound-access', refresh_token: 'bound-refresh', token_type: 'Bearer', issuer };
  const client = { client_id: 'bound-client', client_secret: 'bound-secret', issuer };
  await provider.saveTokens(tokens, { issuer });
  await provider.saveClientInformation(client, { issuer });
  assert.deepEqual(await provider.tokens(), tokens, 'ordinary transport requests still get the last selected token');
  assert.deepEqual(await provider.clientInformation({ issuer: issuer + '/' }), client);
  assert.equal(await provider.tokens({ issuer: 'https://other.example' }), undefined);
  assert.equal(await provider.clientInformation({ issuer: issuer + '/other' }), undefined);
  await provider.invalidateCredentials('all');
  assert.equal(await provider.tokens(), undefined);
});
