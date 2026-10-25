import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { InMemoryRuntimeHost, ModelImageStore, ModelRequestAttempts, ToolRegistry } from '@cardbush/bush-runtime';
import { WorkspacePathGuard } from '../../bush-runtime/dist/workspacePathGuard.js';
import { imageFixture, png } from '../../bush-runtime/test/helpers/modelImages.mjs';
import { OpenAIResponsesProvider, OpenAIChatCompletionsProvider, AnthropicMessagesProvider,
  resolveLocalImageInputs } from '../dist/index.js';

const request = urls => ({ protocol: 'bush.model_request.v1', requestId: 'image_request',
  sessionId: 'image_session', turnId: 'image_turn', model: 'fixture', tools: [], metadata: {},
  messages: urls.map(url => ({ role: 'user', content: 'observed image', images: [{ url, detail: 'high' }] })) });
const memoryPressure = () => Object.assign(new Error('Process admission blocked by system_memory; no process was started.'),
  { code: 'resource_memory_pressure', details: { headroomBytes: 0, startupMemoryBytes: 64 * 1024 ** 2 } });

test('14 historical observations use the request-scoped immutable reader, deduplicate, and leave history intact', async t => {
  const { root } = await imageFixture(t), store = new ModelImageStore(root);
  const path = await store.snapshot(`data:image/png;base64,${png.toString('base64')}`);
  const input = request(Array(14).fill(path)), before = structuredClone(input);
  const scoped = store.readerFor([path]);
  let reads = 0, sandboxReads = 0;
  t.mock.method(WorkspacePathGuard.prototype, 'pin', async () => { sandboxReads++; throw memoryPressure(); });
  const result = await resolveLocalImageInputs(input, { readImage: async (...args) => { reads++; return scoped(...args); } });
  assert.equal(reads, 1);
  assert.equal(sandboxReads, 0);
  assert.deepEqual(input, before);
  assert.ok(result.messages.every(message => message.images[0].url === `data:image/png;base64,${png.toString('base64')}`));
  assert.ok(result.messages.every(message => message.images[0].detail === 'high'));
});

test('local preparation waits and retries only the failed read, without parallel image reads', async () => {
  let active = 0, maximum = 0;
  const calls = [], signal = new AbortController().signal;
  const result = await resolveLocalImageInputs(request(['first', 'second', 'second']), {
    signal, readImage: async (path, observedSignal) => {
      assert.equal(observedSignal, signal);
      active++; maximum = Math.max(maximum, active); calls.push(path);
      try {
        await delay(1);
        if (calls.length === 2) throw memoryPressure();
        return { content: png, mime: 'image/png' };
      } finally { active--; }
    },
  });
  assert.deepEqual(calls, ['first', 'second', 'second']);
  assert.equal(maximum, 1);
  assert.equal(result.messages.length, 3);
});

test('cancellation stops a pending admission retry before another read', async () => {
  const controller = new AbortController();
  let reads = 0;
  const pending = resolveLocalImageInputs(request(['first', 'second']), {
    signal: controller.signal, readImage: async () => { reads++; throw memoryPressure(); },
  });
  await delay(10);
  controller.abort(new Error('cancel image preparation'));
  await assert.rejects(pending, /cancel image preparation|aborted/);
  assert.equal(reads, 1);
});

for (const Provider of [OpenAIResponsesProvider, OpenAIChatCompletionsProvider, AnthropicMessagesProvider]) {
  test(`${Provider.name} preserves admission failure and never dispatches or falls back`, async () => {
    let fetches = 0, reads = 0;
    const provider = new Provider({ apiKey: 'offline-fixture', baseURL: 'http://127.0.0.1:1/v1',
      fetch: async () => { fetches++; throw new Error('unexpected network'); } });
    const attempts = new ModelRequestAttempts();
    const events = [];
    for await (const event of provider.stream(request(['not-a-host-readable-path']), { attempts,
      readImage: async () => { reads++; throw memoryPressure(); } })) events.push(event);
    assert.equal(fetches, 0);
    assert.equal(reads, 3);
    assert.equal(attempts.snapshot().providerAttempts, 0);
    assert.equal(events.at(-1).code, 'resource_memory_pressure');
    assert.equal(events.at(-1).retryable, true);
    assert.doesNotMatch(events.at(-1).message, /inject|authorization/i);
  });

  test(`${Provider.name} uses the same image reader for counting and estimation`, async t => {
    const { root } = await imageFixture(t), store = new ModelImageStore(root);
    const path = await store.snapshot(`data:image/png;base64,${png.toString('base64')}`);
    let reads = 0;
    const provider = new Provider({ apiKey: 'offline-fixture', baseURL: 'http://127.0.0.1:1/v1',
      fetch: async () => new Response(JSON.stringify({ input_tokens: 42 }), { headers: { 'Content-Type': 'application/json' } }) });
    const reader = store.readerFor([path]);
    const options = { readImage: async (...args) => { reads++; return reader(...args); } };
    t.mock.method(WorkspacePathGuard.prototype, 'pin', async () => { throw memoryPressure(); });
    assert.ok(await provider.estimateInputTokens(request([path]), options) > 0);
    if (provider.countInputTokens) assert.equal((await provider.countInputTokens(request([path]), options)).inputTokens, 42);
    assert.equal(reads, provider.countInputTokens ? 2 : 1);
  });
}

test('a rejected scoped reader never falls back to a readable source file', async t => {
  const { source } = await imageFixture(t);
  let reads = 0;
  const denied = Object.assign(new Error('outside the current image grant'), { code: 'image_snapshot_invalid' });
  await assert.rejects(resolveLocalImageInputs(request([source]), {
    readImage: async () => { reads++; throw denied; },
  }), error => error === denied);
  assert.equal(reads, 1);
});

test('preflight resource pressure retains a recoverable local reason and makes no provider request', async t => {
  const { root, source } = await imageFixture(t);
  let fetches = 0, admissions = 0;
  const provider = new OpenAIChatCompletionsProvider({ apiKey: 'offline-fixture', baseURL: 'http://127.0.0.1:1/v1',
    fetch: async () => { fetches++; throw new Error('unexpected network'); } });
  const host = new InMemoryRuntimeHost({ dataRoot: root, provider, registerDefaultWorkspaceTools: false });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  t.mock.method(WorkspacePathGuard.prototype, 'pin', async () => { admissions++; throw memoryPressure(); });
  const result = await host.runModelTurn({ ...request([source]), maxOutputTokens: 512, metadata: { contextWindowTokens: 32768 } });
  assert.equal(result.payload.reason, 'resource_memory_pressure');
  assert.equal(result.payload.details.retryable, true);
  assert.equal(result.payload.details.stage, 'model_input_preparation');
  assert.equal(admissions, 3);
  assert.equal(fetches, 0);
});

test('post-tool image preparation recovers through the same guard without replaying the tool', async t => {
  const { root } = await imageFixture(t), registry = new ToolRegistry();
  let tools = 0, projections = 0, reads = 0;
  registry.register({
    definition: { name: 'capture_once', description: 'fixture', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'local_state', operation: 'fixture.capture', risk: 'low', owner: 'test', dispatch_scope: 'process', mutating: true },
    decodeInput: input => input,
    execute: async () => { tools++; return { content: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }] }; },
  });
  const host = new InMemoryRuntimeHost({ dataRoot: root, toolRegistry: registry, registerDefaultWorkspaceTools: false,
    provider: { async *stream(input, options) {
      projections++;
      const resolved = await resolveLocalImageInputs(input, { ...options, readImage: async (...args) => {
        reads++;
        if (reads === 1) throw memoryPressure();
        return options.readImage(...args);
      } });
      const event = (sequence, payload) => ({ protocol: 'bush.model_event.v1', requestId: input.requestId,
        createdAt: '2026-10-25T00:00:00.000Z', sequence, ...payload });
      if (projections === 1) {
        yield event(0, { kind: 'tool_call_delta', index: 0, toolCallId: 'capture', nameDelta: 'capture_once', argumentsDelta: '{}' });
        yield event(1, { kind: 'response_completed', finishReason: 'tool_calls' });
      } else {
        assert.ok(resolved.messages.some(message => message.images?.[0]?.url.startsWith('data:image/png;base64,')));
        yield event(0, { kind: 'text_delta', delta: 'image observed' });
        yield event(1, { kind: 'response_completed', finishReason: 'stop' });
      }
    } } });
  t.after(() => host.sendCommand({ kind: 'runtime.shutdown', payload: {} }));
  const result = await host.runModelTurn({ ...request([]), messages: [{ role: 'user', content: 'capture once' }],
    tools: registry.definitions(), requestCapabilities: { vision: true }, metadata: { workspaceDir: root } });
  assert.equal(result.payload.status, 'completed');
  assert.equal(tools, 1);
  assert.equal(projections, 2);
  assert.equal(reads, 2);
});
