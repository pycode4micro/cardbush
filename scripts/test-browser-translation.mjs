import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { translateBrowserTexts } from '../dist-electron/browserTranslationModel.mjs';
import { createBrowserTranslator } from '../dist-electron/browserTranslationBridge.js';
import { ProductHost } from '@cardbush/product-host';

const input = () => ({ model: { model: 'test-model', providerBinding: { bindingId: 'test', revision: 'one' }, reasoningEffort: 'low' },
  language: 'zh', jobId: randomUUID(), texts: [{ id: '0', text: 'Hello' }, { id: '1', text: 'World' }] });
const provider = (reply, inspect = () => {}, finishReason = 'stop') => ({ async *stream(request, options) {
  inspect(request, options);
  const common = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
  yield { ...common, sequence: 0, kind: 'text_delta', delta: JSON.stringify({ texts: reply }) };
  yield { ...common, sequence: 1, kind: 'response_completed', finishReason };
} });

test('translation uses the shared model protocol, stable page session, configured reasoning, and no tools', async () => {
  const source = input(), signal = new AbortController().signal, requests = [];
  const texts = [{ id: '1', text: '世界' }, { id: '0', text: '你好' }];
  const model = provider(texts, (request, options) => {
    requests.push(request);
    assert.equal(options.signal, signal);
    assert.deepEqual(request.tools, []);
    assert.equal(request.reasoningEffort, 'low');
    assert.deepEqual(request.providerBinding, source.model.providerBinding);
    assert.match(request.messages[0].content, /untrusted data/);
    assert.match(request.messages[0].content, /Simplified Chinese/);
    assert.deepEqual(JSON.parse(request.messages[1].content).texts, source.texts);
  });
  assert.deepEqual(await translateBrowserTexts(model, source, signal), texts);
  await translateBrowserTexts(model, source, signal);
  assert.equal(requests[0].sessionId, requests[1].sessionId);
  assert.notEqual(requests[0].requestId, requests[1].requestId);
});

test('English target and the configured output limit are respected', async () => {
  const source = input(); source.language = 'en'; source.model.maxOutputTokens = 2048;
  await translateBrowserTexts(provider(source.texts, request => {
    assert.match(request.messages[0].content, /into English/);
    assert.equal(request.maxOutputTokens, 2048);
  }), source, new AbortController().signal);
});

for (const [name, reply] of [
  ['missing ID', [{ id: '0', text: '你好' }]],
  ['duplicate ID', [{ id: '0', text: '你好' }, { id: '0', text: '世界' }]],
  ['unknown ID', [{ id: '0', text: '你好' }, { id: '2', text: '世界' }]],
  ['blank text', [{ id: '0', text: '你好' }, { id: '1', text: ' ' }]],
]) test(`rejects ${name} without accepting a partial translation`, async () => {
  await assert.rejects(translateBrowserTexts(provider(reply), input(), new AbortController().signal));
});

test('truncated responses, oversized requests and cancelled jobs are rejected', async () => {
  const source = input();
  await assert.rejects(translateBrowserTexts(provider(source.texts, undefined, 'length'), source, new AbortController().signal));
  source.texts = [{ id: '0', text: 'a'.repeat(4000) }, { id: '1', text: 'b'.repeat(4000) }];
  await assert.rejects(translateBrowserTexts({ stream() { throw Error('Must not call the model'); } }, source, new AbortController().signal), /too large/);
  await assert.rejects(translateBrowserTexts(provider(input().texts), input(), AbortSignal.abort()));
});

test('desktop bridge resolves the real default model once and carries it through the shared model request', async () => {
  let defaultModelId = 'configured-default';
  const resolved = [], requests = [];
  const product = new ProductHost({
    get: async () => ({ defaultModelId, models: [{ id: 'other' }, { id: 'configured-default' }] }),
    update: async () => ({}),
    resolve: async modelId => { resolved.push(modelId); return { model: modelId, binding: { bindingId: modelId, revision: 'v1' } }; },
  });
  const signal = new AbortController().signal, source = input();
  const translate = createBrowserTranslator(async () => ({ product, runtime: {
    cancelOperation: async () => {},
    command: async request => {
      requests.push(request);
      const result = await translateBrowserTexts(provider(source.texts), request.command.payload, signal);
      return { ok: true, result };
    },
  } }));
  await translate(source.texts, 'zh', source.jobId, signal);
  defaultModelId = 'other';
  await translate(source.texts, 'zh', source.jobId, signal);
  assert.deepEqual(resolved, ['configured-default']);
  assert.ok(requests.every(request => request.command.payload.model.model === 'configured-default'));
  await translate(source.texts, 'en', randomUUID(), new AbortController().signal);
  assert.deepEqual(resolved, ['configured-default', 'other'], 'a new page job follows the new default');
});

test('missing models fail before model execution and in-flight bridge cancellation reaches the worker', async () => {
  const product = new ProductHost({ get: async () => ({ models: [] }), update: async () => ({}), resolve: async () => ({}) });
  const unavailable = createBrowserTranslator(async () => ({ product, runtime: { command: async () => { throw Error('must not run'); }, cancelOperation: async () => {} } }));
  await assert.rejects(unavailable(input().texts, 'zh', randomUUID(), new AbortController().signal), /translation_model_unavailable/);
  const abort = new AbortController(), sent = [];
  let rejectRequest;
  const translate = createBrowserTranslator(async () => ({
    product: new ProductHost({ get: async () => ({ defaultModelId: 'default' }), update: async () => ({}), resolve: async () => ({ model: 'default' }) }),
    runtime: {
      command: request => { sent.push(request); return new Promise((_, reject) => { rejectRequest = reject; }); },
      cancelOperation: async request => { sent.push(request); rejectRequest(new Error('cancelled')); },
    },
  }));
  const request = translate(input().texts, 'zh', randomUUID(), abort.signal);
  await new Promise(resolve => setImmediate(resolve)); abort.abort();
  await assert.rejects(request);
  assert.equal(sent[1].type, 'cancel_operation');
  assert.equal(sent[1].operationId, sent[0].operationId);
});
