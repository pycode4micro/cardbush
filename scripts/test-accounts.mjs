import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountManager, accountProviders, openAiAccountSummary } from '../dist-electron/accountManager.mjs';
import { accountCommandSchema } from '@cardbush/bush-protocol';

test('account registry serves existing OpenAI state without owning or duplicating credentials', async () => {
  let state = 'signed_out'; const calls = [];
  const manager = new AccountManager([{ providerId: 'openai', list: async () => [openAiAccountSummary({ state, experimental: true })],
    action: async (id, action) => { calls.push({ id, action }); state = action === 'login' ? 'signed_in' : 'signed_out'; } }]);
  assert.equal((await manager.snapshot()).providers.length, 5);
  const loggedIn = await manager.action({ providerId: 'openai', accountId: 'openai:default', action: 'login' });
  assert.equal(loggedIn.accounts[0].state, 'signed_in'); assert.equal(calls[0].id, 'openai:default');
  for (const providerId of ['claude','qq','wechat','bilibili']) await assert.rejects(manager.action({ providerId, accountId: 'default', action: 'login' }), /not connected/);
  await assert.rejects(manager.action({ providerId: 'openai', accountId: 'unknown', action: 'logout' }), /selected account/);
  await assert.rejects(manager.action({ providerId: 'openai', accountId: 'openai:default', action: 'cancel_login' }), /unavailable/);
  assert.equal(calls.length, 1);
  assert.throws(() => accountCommandSchema.parse({ providerId: 'openai', accountId: 'openai:default', action: 'login', token: 'secret' }));
});

test('two providers and multiple accounts stay isolated and one unavailable adapter does not hide the others', async () => {
  const providers = ['first','second'].map(id => ({ ...accountProviders[0], id, name: id }));
  const calls = []; let failed = false;
  const manager = new AccountManager(providers.map(provider => ({ providerId: provider.id,
    list: async () => { if (provider.id === 'first' && failed) throw Error('PRIVATE_FAILURE');
      return ['one','two'].map(id => ({ id, providerId: provider.id, label: id, state: 'signed_in', actions: ['logout'] })); },
    action: async (id, action) => calls.push({ provider: provider.id, id, action }),
  })), providers);
  await manager.action({ providerId: 'second', accountId: 'two', action: 'logout' });
  assert.deepEqual(calls, [{ provider: 'second', id: 'two', action: 'logout' }]);
  failed = true; const snapshot = await manager.snapshot();
  assert.deepEqual(snapshot.errors, [{ providerId: 'first', code: 'unavailable' }]);
  assert.deepEqual(snapshot.accounts.map(account=>account.providerId), ['second','second']);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_FAILURE/);
});

test('public account validation rejects token fields and cross-provider identities', async () => {
  const contaminated = new AccountManager([{ providerId: 'openai', list: async () => [{ ...openAiAccountSummary({ state: 'signed_in', experimental: true }), access_token: 'PRIVATE_TOKEN' }], action: async () => {} }]);
  assert.equal((await contaminated.snapshot()).accounts.length, 0);
  assert.doesNotMatch(JSON.stringify(await contaminated.snapshot()), /PRIVATE_TOKEN/);
  await assert.rejects(contaminated.action({ providerId: 'openai', accountId: 'openai:default', action: 'logout' }));
  const wrong = new AccountManager([{ providerId: 'openai', list: async () => [{ ...openAiAccountSummary({ state: 'signed_in', experimental: true }), providerId: 'claude' }], action: async () => {} }]);
  assert.equal((await wrong.snapshot()).accounts.length, 0);
  assert.throws(() => new AccountManager([{ providerId: 'qq', list: async () => [], action: async () => {} }]), /Invalid/);
});

test('cancel login remains available during sign-in and logout remains available for failed secure storage', async () => {
  assert.deepEqual(openAiAccountSummary({ state: 'signing_in', experimental: true }).actions, ['cancel_login']);
  assert.deepEqual(openAiAccountSummary({ state: 'unavailable', experimental: true }).actions, ['logout']);
});
