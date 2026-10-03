import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProductModelConfigStore } from '@cardbush/product-host';
import { ModelProviderRegistry } from '@cardbush/bush-provider-openai';
import { ElectronProductHostController } from '../dist-electron/productHostController.mjs';

test('model configuration, subagents and automations resolve the same immutable account reference without token persistence', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-siwc-model-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep)); await rm(root, { recursive: true, force: true }); });
  const dataRoot = join(root, 'product'), file = join(dataRoot, 'config', 'models.json');
  const store = new ProductModelConfigStore(file), accountId = randomUUID(), commands = [];
  const authentication = { kind: 'chatgpt', accountId };
  const model = { id: 'plan-model', provider: 'openai', model: 'gpt-fixture', authentication, apiKey: '', apiProtocol: 'openai_responses', maxContextTokens: 400000 };
  await store.write({ defaultModelId: model.id, models: [model, { id: 'key-model', model: 'gpt-fixture', provider: 'openai', apiKey: 'API_KEY_FIXTURE' }] });
  let stored = await new ProductModelConfigStore(file).read();
  assert.deepEqual(stored.models[0].authentication, authentication);
  const publicSnapshot = store.publicPayload(stored);
  assert.equal(publicSnapshot.models[0].hasApiKey, false); assert.doesNotMatch(JSON.stringify(publicSnapshot), /API_KEY_FIXTURE/);
  await store.write(publicSnapshot);
  assert.equal((await store.read()).models[1].apiKey, 'API_KEY_FIXTURE');
  assert.equal(await store.migrateMissingCredentials({ models: [{ ...model, apiKey: 'LEGACY_FIXTURE_SECRET' }] }), 0);
  const before = await readFile(file, 'utf8');
  for (const override of [{ apiProtocol: 'openai_chat_completions' }, { baseURL: 'https://other.example' }, { maxOutputTokens: 123 }, { defaultHeaders: { authorization: 'wrong' } }]) {
    await assert.rejects(store.write({ models: [{ ...model, ...override }] }), /ChatGPT models/);
    assert.equal(await readFile(file, 'utf8'), before);
  }
  const providers = new ModelProviderRegistry({ chatGptAccess: async () => 'HOST_ONLY_REFRESHED_TOKEN' });
  const host = new ElectronProductHostController({ dataRoot, runtimeStateRoot: join(root, 'runtime'), bundledSkillRoot: join(root, 'skills'), userSkillRoot: join(root, 'user-skills'), bundledPluginRoot: join(root, 'plugins'), userPluginRoot: join(root, 'user-plugins'),
    runtimeBridge: { command: async request => {
      commands.push(request.command);
      return { protocol: 'bush.runtime_ipc.v1', type: 'command_response', operationId: request.operationId, ok: true, result: providers.upsert(request.command.payload) };
    }, cancelOperation: async () => {} },
  });
  const child = await host.resolveSubagentModel(model.id), automation = await host.resolveAutomationModel(model.id);
  assert.deepEqual(child.binding, automation.binding);
  assert.deepEqual(commands[0].payload.authentication, authentication); assert.equal(commands[0].payload.apiKey, '');
  assert.doesNotMatch(JSON.stringify([child, automation, await host.subagentModels()]), /HOST_ONLY|API_KEY|accountId/);
  assert.doesNotMatch(await readFile(file, 'utf8'), /HOST_ONLY|LEGACY_FIXTURE/);
  await store.write({ models: [{ ...model, authentication: { kind: 'api_key' }, apiKey: 'NEW_KEY' }] });
  stored = await store.read(); assert.equal(stored.models[0].authentication.kind, 'api_key'); assert.equal(stored.models[0].apiKey, 'NEW_KEY');
});
