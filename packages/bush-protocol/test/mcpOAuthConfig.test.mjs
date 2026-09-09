import test from 'node:test';
import assert from 'node:assert/strict';
import { mcpOAuthFromConfig } from '../dist/index.js';

test('private references override legacy environment configuration and null clears either alias', () => {
  const ref = 'c'.repeat(64);
  assert.deepEqual(mcpOAuthFromConfig({ client_secret_env: 'OLD' }, { client_secret_ref: ref }), { clientSecretRef: ref });
  assert.deepEqual(mcpOAuthFromConfig({ clientSecretRef: ref }, { client_secret_env: 'NEW' }), { clientSecretEnv: 'NEW' });
  assert.deepEqual(mcpOAuthFromConfig({ clientSecretEnv: 'OLD' }, { client_secret_env: null }), {});
  assert.deepEqual(mcpOAuthFromConfig({ clientSecretRef: ref }, { client_secret_ref: null }), {});
  assert.throws(() => mcpOAuthFromConfig({ client_secret_ref: '../credentials' }));
});

test('OAuth configuration normalizes aliases per layer before applying user overrides', () => {
  const value = mcpOAuthFromConfig(
    { scopes: ['package:read'], oauth_resource: 'https://service.example/mcp' },
    { client_id: 'package-client', callback_port: 12798 },
    { clientId: 'user-client', scopes: ['user:read'], callbackUrl: 'http://127.0.0.1:12345/accepted' },
  );
  assert.deepEqual(value, { clientId: 'user-client', callbackUrl: 'http://127.0.0.1:12345/accepted', resourceUrl: 'https://service.example/mcp', scopes: ['user:read'] });
  assert.deepEqual(mcpOAuthFromConfig({ clientId: 'old', callbackUrl: 'http://localhost:80/old' }, { client_id: 'new', callback_port: 43210 }), { clientId: 'new', callbackPort: 43210 });
  assert.deepEqual(mcpOAuthFromConfig({ scopes: ['default'] }, { scopes: undefined }), { scopes: ['default'] });
  assert.deepEqual(mcpOAuthFromConfig({ scopes: ['default'] }, { scopes: [] }), { scopes: [] });
  assert.equal(mcpOAuthFromConfig({ client_secret: 'PRIVATE_FIXTURE' }).clientSecret, undefined, 'inline secrets never enter public runtime snapshots');
  for (const port of [-1, 65536, 1.5, '12798']) assert.throws(() => mcpOAuthFromConfig({ callback_port: port }));
});
