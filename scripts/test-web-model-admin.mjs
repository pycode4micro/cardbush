import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebModelSettings } from '../dist-electron/webModelSettings.mjs';
import { serveWeb } from '../dist-electron/webServer.mjs';
import { csrfToken, modelToken } from '../dist-electron/webCommon.mjs';

class Repository {
  row;
  async initialize(payload) { this.row ??= { revision: 1, payload }; }
  async read() { return structuredClone(this.row); }
  async replace(revision, payload) { if (this.row.revision !== revision) return null; return this.row = { revision: revision + 1, payload }; }
}
const config = () => ({ modelSecret: 'm'.repeat(64), defaultModelId: 'doubao', models: [{ id: 'doubao', name: 'DeepSeek', model: 'deepseek-model', baseURL: 'https://provider.test/v3', apiKey: 'private-model-key' }], imageModel: { model: 'seedream-model', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', apiKey: 'private-image-key' } });
const input = (settings, extra = {}) => { const { hasApiKey: _, ...model } = settings.view().models[0]; return { ...model, ...extra }; };
const save = (settings, model) => settings.update({ action: 'save', revision: settings.view().revision, model });
async function fixture() { const target = config(), repository = new Repository(), settings = new WebModelSettings(target, repository); await settings.initialize(); return { target, repository, settings }; }

test('imports deployed defaults once, encrypts secrets and persists edits across restarts', async () => {
  const { target, repository, settings } = await fixture();
  assert.equal(target.models[0].maxOutputTokens, 128000); assert.equal(target.models[0].reasoningEffort, 'medium');
  assert.equal(target.models[0].maxContextTokens, 530000);
  assert.ok(!JSON.stringify(settings.view()).includes('private-'));
  assert.ok(!repository.row.payload.includes('private-'));
  await save(settings, input(settings, { name: 'Updated', maxOutputTokens: 64000, reasoningEffort: 'low', apiKey: '' }));
  assert.equal(target.models[0].apiKey, 'private-model-key');
  const restored = config(), restarted = new WebModelSettings(restored, repository); await restarted.initialize();
  assert.equal(restored.models[0].name, 'Updated'); assert.equal(restored.models[0].maxOutputTokens, 64000);
  assert.equal(restored.models[0].apiKey, 'private-model-key');
  assert.equal(restored.imageModel.apiKey, 'private-image-key');
  repository.row.payload = repository.row.payload.slice(0, -8) + 'aaaaaaaa';
  await assert.rejects(restarted.refresh(true));
});

test('new models can be enabled, selected as default, disabled and deleted without an empty catalog', async () => {
  const { target, settings } = await fixture();
  const second = input(settings, { id: 'second', name: 'Second', model: 'second-model', apiKey: 'second-key', enabled: false });
  await save(settings, second); assert.equal(target.models.length, 1);
  await assert.rejects(settings.update({ action: 'default', id: 'second', revision: settings.view().revision }), /默认模型/);
  await save(settings, { ...second, enabled: true });
  await settings.update({ action: 'default', id: 'second', revision: settings.view().revision });
  assert.equal(target.defaultModelId, 'second');
  await save(settings, input(settings, { enabled: false })); assert.deepEqual(target.models.map(model => model.id), ['second']);
  await settings.update({ action: 'delete', id: 'doubao', revision: settings.view().revision });
  assert.equal(settings.view().models.length, 1);
  await assert.rejects(settings.update({ action: 'delete', id: 'second', revision: settings.view().revision }), /默认模型/);
});

test('rejects invalid budgets, unknown settings, unsafe endpoints and credential reuse on a changed origin', async () => {
  const { settings } = await fixture();
  await assert.rejects(save(settings, input(settings, { maxOutputTokens: 530000 })), /最大输出/);
  await assert.rejects(save(settings, input(settings, { baseURL: 'https://elsewhere.test/v1', apiKey: '' })), /重新填写密钥/);
  for (const baseURL of ['file:///etc/passwd', 'https://user:pass@provider.test', 'https://provider.test/?secret=1']) await assert.rejects(save(settings, input(settings, { baseURL })));
  await assert.rejects(save(settings, { ...input(settings), toolsEnabled: true }));
  await assert.rejects(save(settings, input(settings, { id: 'new-without-key' })), /API 密钥/);
  assert.equal(settings.view().revision, 1);
});

test('optimistic concurrency rejects stale administrator writes and keeps the winning configuration', async () => {
  const { target, repository, settings } = await fixture();
  const second = new WebModelSettings(config(), repository); await second.initialize();
  const change = (manager, name) => manager.update({ action: 'save', revision: 1, model: input(manager, { name }) });
  const results = await Promise.allSettled([change(settings, 'First'), change(second, 'Second')]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  await settings.refresh(true); await second.refresh(true);
  assert.equal(settings.view().revision, 2); assert.deepEqual(settings.view(), second.view());
  assert.equal(target.models[0].name, settings.view().models[0].name);
});

test('image model updates preserve the fixed image service and never expose its secret', async () => {
  const { settings, target } = await fixture();
  await settings.update({ action: 'image', revision: 1, model: 'new-seedream', apiKey: '' });
  assert.equal(target.imageModel.apiKey, 'private-image-key');
  assert.equal(target.imageModel.model, 'new-seedream');
  assert.equal(target.imageModel.baseURL, 'https://ark.cn-beijing.volces.com/api/v3');
  assert.deepEqual(settings.view().imageModel, { model: 'new-seedream', hasApiKey: true });
});

test('only admins with valid CSRF can manage models; public identity and hot routing use the saved catalog', async t => {
  let received;
  const upstream = createServer(async (request, response) => { let text = ''; for await (const part of request) text += part; received = { authorization: request.headers.authorization, body: JSON.parse(text) }; response.end('{}'); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const { settings, target } = await fixture();
  const user = { id: 'user', role: 'member', is_active: true }, admin = { id: 'admin', role: 'admin', is_active: true };
  const store = { async authenticate(token) { return token.startsWith('admin') ? admin : token.startsWith('member') ? user : null; }, async user(id) { return id === 'user' ? user : admin; } };
  Object.assign(target, { origin: 'http://fixture.test', port: 0, host: '127.0.0.1', staticRoot: 'dist-web' });
  const live = await serveWeb(target, store, { get() { throw Error('No tenant calls'); }, close() {} }, settings);
  t.after(async () => { await live.close(); upstream.closeAllConnections(); await new Promise(resolve => upstream.close(resolve)); });
  const base = `http://127.0.0.1:${live.port}`;
  const request = (who, path, body, csrf = true) => { const token = who.padEnd(54, '_'); return fetch(base + '/api/web/v1' + path, { method: body ? 'POST' : 'GET', headers: { Cookie: 'cardbush_web=' + token, Origin: 'http://fixture.test', ...(csrf ? { 'X-CSRF-Token': csrfToken(token) } : {}), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); };
  assert.equal((await request('member', '/admin/models')).status, 403);
  assert.equal((await request('absent', '/admin/models')).status, 401);
  const change = { action: 'save', revision: 1, model: input(settings, { name: 'Managed', model: 'managed-model', baseURL: `http://127.0.0.1:${upstream.address().port}`, apiKey: 'new-private-key' }) };
  assert.equal((await request('admin', '/admin/models', change, false)).status, 403);
  assert.equal((await request('member', '/admin/models', change)).status, 403);
  const saved = await request('admin', '/admin/models', change); assert.equal(saved.status, 200); assert.ok(!(await saved.text()).includes('private-key'));
  const identity = await (await request('member', '/auth/me')).json(); assert.deepEqual(identity.models, [{ id: 'doubao', name: 'Managed' }]);
  const routed = await fetch(base + '/internal/model/user/doubao/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + modelToken(target.modelSecret, 'user'), 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'spoofed', input: 'fixture' }) });
  assert.equal(routed.status, 200); assert.equal(received.authorization, 'Bearer new-private-key'); assert.equal(received.body.model, 'managed-model');
});
