import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { ProductModelConfigStore } from '@cardbush/product-host';
import { ElectronProductHostController } from '../dist-electron/productHostController.mjs';

test('clean model options use configured models and resolve an exact private binding without exposing credentials', async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-subagent-models-'));
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'cardbush-subagent-models-')); await rm(root, { recursive: true, force: true }); });
  const dataRoot = join(root, 'product'), commands = [];
  const store = new ProductModelConfigStore(join(dataRoot, 'config', 'models.json'));
  await store.write({ defaultModelId: 'main', models: [
    { id: 'main', model: 'main-model', provider: 'fixture', apiKey: 'FIXTURE_MAIN_KEY', baseURL: 'https://main.example.invalid/v1', maxContextTokens: 32000, maxOutputTokens: 4000 },
    { id: 'review', model: 'review-model', provider: 'fixture', apiKey: 'FIXTURE_REVIEW_KEY', baseURL: 'https://review.example.invalid/v1', defaultHeaders: { 'X-Private': 'FIXTURE_PRIVATE_HEADER' }, maxContextTokens: 64000, maxOutputTokens: 8000 },
  ] });
  const host = new ElectronProductHostController({ dataRoot, runtimeStateRoot: join(root, 'runtime'), bundledSkillRoot: join(root, 'skills'), userSkillRoot: join(root, 'user-skills'), bundledPluginRoot: join(root, 'plugins'), userPluginRoot: join(root, 'user-plugins'),
    runtimeBridge: { command: async request => {
      commands.push(request.command);
      assert.equal(request.command.kind, 'runtime.upsert_provider_binding');
      return { protocol: 'bush.runtime_ipc.v1', type: 'command_response', operationId: request.operationId, ok: true,
        result: { protocol: 'bush.provider_binding_result.v1', status: 'configured', binding: { bindingId: request.command.payload.bindingId, revision: '2' } } };
    }, cancelOperation: async () => {} },
  });
  assert.deepEqual(await host.subagentModels(), [
    { id: 'main', model: 'main-model', maxContextTokens: 32000, maxOutputTokens: 4000 },
    { id: 'review', model: 'review-model', maxContextTokens: 64000, maxOutputTokens: 8000 },
  ]);
  assert.equal(commands.length, 0);
  const selected = await host.resolveSubagentModel('review');
  assert.equal(selected.modelId, 'review');
  assert.equal(selected.model, 'review-model');
  assert.deepEqual(selected.binding, { bindingId: 'review', revision: '2' });
  assert.equal(selected.maxOutputTokens, 8000);
  assert.ok(!JSON.stringify(selected).includes('FIXTURE_'));
  assert.equal(commands[0].payload.apiKey, 'FIXTURE_REVIEW_KEY');
  assert.equal(commands[0].payload.baseURL, 'https://review.example.invalid/v1');
  await assert.rejects(host.resolveSubagentModel('removed-model'), /not configured/);
  assert.equal(commands.length, 1, 'an unknown model must not silently resolve to the default');
});
