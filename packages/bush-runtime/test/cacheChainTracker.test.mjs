import assert from "node:assert/strict";
import test from "node:test";

import {
  BUSH_MODEL_REQUEST_PROTOCOL,
  modelRequestSchema,
  cacheChainChanges,
  cacheChainStateSchema,
  cacheChainObservationPayloadSchema,
  providerInputObservationSchema,
} from "@cardbush/bush-protocol";
import { CacheChainTracker } from "../dist/index.js";

test("observes append-only messages and identical retries without changing input", () => {
  const tracker = new CacheChainTracker();
  const initial = request();
  const first = tracker.observe(initial);
  const extended = request({
    messages: [
      ...initial.messages,
      { role: "assistant", content: "", toolCalls: [] },
      { role: "tool", content: "{}", toolCallId: "call_1" },
    ],
  });
  const second = tracker.observe(extended);
  const retry = tracker.observe(extended);

  assert.equal(first.frozenPrefixBreak, false);
  assert.equal(first.prefixComparisonAvailable, false);
  assert.equal(first.parametersChanged, false);
  assert.deepEqual(first.changedParameters, []);
  assert.equal(first.appendedMessages, 1);
  assert.equal(second.sharedPrefixMessages, 1);
  assert.equal(second.appendedMessages, 2);
  assert.equal(second.frozenPrefixBreak, false);
  assert.equal(retry.sharedPrefixMessages, 3);
  assert.equal(retry.appendedMessages, 0);
  assert.equal(retry.frozenPrefixBreak, false);
});

test("reports a frozen prefix break when an existing message changes", () => {
  const tracker = new CacheChainTracker();
  tracker.observe(request());

  const observation = tracker.observe(
    request({ messages: [{ role: "user", content: "changed" }] }),
  );

  assert.equal(observation.frozenPrefixBreak, true);
  assert.equal(observation.breakIndex, 0);
  assert.equal(observation.sharedPrefixMessages, 0);
});

test("reports tool schema changes separately from the historical message prefix", () => {
  const tracker = new CacheChainTracker();
  tracker.observe(request());
  const previousStableInputDigest = tracker.snapshot().stableInputDigest;

  const observation = tracker.observe(
    request({
      tools: [
        {
          name: "arbitrary_capability",
          description: "An arbitrary capability",
          inputSchema: { type: "object", properties: { value: { type: "string" } } },
        },
      ],
    }),
  );

  assert.equal(observation.frozenPrefixBreak, false);
  assert.equal(observation.breakIndex, undefined);
  assert.equal(observation.parametersChanged, true);
  assert.deepEqual(observation.changedParameters, ['tools']);
  assert.notEqual(observation.stableInputDigest, previousStableInputDigest);
  assert.equal(observation.sharedPrefixMessages, 1);
  assert.equal(observation.messageBreakIndex, undefined);
});

test('parameter changes do not mask an independent historical message rewrite', () => {
  const tracker = new CacheChainTracker();
  const messages = [{ role: 'system', content: 'fixed' }, { role: 'user', content: 'original' }];
  tracker.observe(request({ messages }));
  tracker.observeProviderInput({ format: 'fixture', transport: 'full', parameterDigests: { tools: 'tools-before' }, inputDigests: ['system', 'original'] });
  const changed = tracker.observe(request({ messages: [messages[0], { role: 'user', content: 'replaced' }], temperature: 0.5 }));
  assert.equal(changed.frozenPrefixBreak, true); assert.equal(changed.breakIndex, 1);
  assert.equal(changed.parametersChanged, true); assert.deepEqual(changed.changedParameters, ['temperature']);
  assert.equal(changed.sharedPrefixMessages, 1); assert.equal(changed.messageBreakIndex, 1);
  const wire = tracker.observeProviderInput({ format: 'fixture', transport: 'full', parameterDigests: { tools: 'tools-after' }, inputDigests: ['system', 'replaced', 'appended'] });
  assert.deepEqual(wire.changedParameters, ['tools']); assert.equal(wire.breakIndex, 1);
  assert.equal(wire.parametersChanged, true); assert.equal(wire.frozenPrefixBreak, true);
  assert.equal(wire.sharedPrefixMessages, 1); assert.equal(wire.messageBreakIndex, 1);
  const onlyParameters = tracker.observeProviderInput({ format: 'fixture', transport: 'full', parameterDigests: { tools: 'tools-new' }, inputDigests: ['system', 'replaced', 'appended'] });
  assert.equal(onlyParameters.frozenPrefixBreak, false); assert.equal(onlyParameters.sharedPrefixMessages, 3);
  assert.equal(onlyParameters.parametersChanged, true); assert.equal(onlyParameters.breakIndex, undefined);
  assert.equal(onlyParameters.messageBreakIndex, undefined);
});

test("restores hash-only state and preserves continuity across Runtime restart", () => {
  const first = new CacheChainTracker();
  const input = request();
  first.observe(input);
  const restored = new CacheChainTracker(first.snapshot());

  const observation = restored.observe(input);

  assert.equal(observation.requestOrdinal, 2);
  assert.equal(observation.sharedPrefixMessages, 1);
  assert.equal(observation.frozenPrefixBreak, false);
});

test("observes an explicit provider binding revision change mechanically", () => {
  const tracker = new CacheChainTracker();
  tracker.observe(
    request({
      providerBinding: { bindingId: "provider_1", revision: "revision_1" },
    }),
  );

  const observation = tracker.observe(
    request({
      providerBinding: { bindingId: "provider_1", revision: "revision_2" },
    }),
  );

  assert.equal(observation.frozenPrefixBreak, false);
  assert.equal(observation.breakIndex, undefined);
  assert.equal(observation.parametersChanged, true);
  assert.deepEqual(observation.changedParameters, ['providerBinding']);
});

function request(overrides = {}) {
  return modelRequestSchema.parse({
    protocol: BUSH_MODEL_REQUEST_PROTOCOL,
    requestId: "request_cache",
    sessionId: "session_cache",
    turnId: "turn_cache",
    model: "fixture-model",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    ...overrides,
  });
}

test('image observations count additions/removals by occurrence and survive tracker persistence', () => {
  const projection = (digests, inputDigests = ['prefix']) => ({ format: 'images-fixture', transport: 'full', parameterDigests: {}, inputDigests,
    images: { digests, remoteCount: 0 }, cacheRouting: { mode: 'session', keyDigest: 'hashed-key' } });
  const first = new CacheChainTracker(); first.observe(request());
  assert.deepEqual(first.observeProviderInput(projection(['one'])).images, { count: 1, remoteCount: 0, comparisonAvailable: false });
  const tracker = new CacheChainTracker(JSON.parse(JSON.stringify(first.snapshot())));
  tracker.observe(request());
  const appended = tracker.observeProviderInput(projection(['one', 'one', 'two'], ['prefix', 'append']));
  assert.deepEqual(appended.images, { count: 3, remoteCount: 0, comparisonAvailable: true, previousCount: 1, addedCount: 2, removedCount: 0 });
  assert.equal(appended.frozenPrefixBreak, false);
  assert.deepEqual(appended.cacheRouting, { mode: 'session', keyDigest: 'hashed-key' });
  const retry = tracker.observeProviderInput(projection(['one', 'one', 'two'], ['prefix', 'append']));
  assert.equal(retry.images.addedCount, 0); assert.equal(retry.images.removedCount, 0);
  const replaced = tracker.observeProviderInput(projection(['one', 'changed'], ['rewritten']));
  assert.equal(replaced.images.addedCount, 1); assert.equal(replaced.images.removedCount, 2);
  assert.equal(replaced.frozenPrefixBreak, true);
  const compacted = tracker.observeProviderInput(projection([], ['summary']));
  assert.equal(compacted.images.addedCount, 0); assert.equal(compacted.images.removedCount, 2);
});

test('legacy state and protocol switches do not misclassify historical images as new', () => {
  const tracker = new CacheChainTracker(); tracker.observe(request());
  const legacy = { format: 'legacy', transport: 'full', parameterDigests: {}, inputDigests: ['prefix'] };
  tracker.observeProviderInput(legacy);
  const current = { ...legacy, images: { digests: ['old-image'], remoteCount: 1 } };
  assert.deepEqual(tracker.observeProviderInput(current).images, { count: 1, remoteCount: 1, comparisonAvailable: false });
  const switched = tracker.observeProviderInput({ ...current, format: 'another-protocol' });
  assert.equal(switched.images.comparisonAvailable, false);
  assert.equal(switched.images.addedCount, undefined);
  assert.equal(switched.frozenPrefixBreak, false);
  assert.equal(switched.projectionFormatChanged, true);
  assert.equal(switched.prefixComparisonAvailable, false);
  assert.equal(switched.breakIndex, undefined);
  assert.equal(switched.messageBreakIndex, undefined);
  assert.deepEqual(cacheChainChanges(switched), { prefixBreak: undefined, parametersChanged: false, projectionFormatChanged: true });
  const resumed = tracker.observeProviderInput({ ...current, format: 'another-protocol', inputDigests: ['prefix', 'next'] });
  assert.equal(resumed.prefixComparisonAvailable, true);
  assert.equal(resumed.projectionFormatChanged, false);
  assert.equal(resumed.frozenPrefixBreak, false);
});

for (const [parameter, value] of Object.entries({ maxOutputTokens: 512, temperature: 0.2, topP: 0.8, reasoningEffort: 'high', model: 'other-model' })) {
  test(`${parameter} changes survive persistence without a false prefix break`, () => {
    const first = new CacheChainTracker(); first.observe(request());
    const same = first.observe(request());
    const tracker = new CacheChainTracker(cacheChainStateSchema.parse(JSON.parse(JSON.stringify(first.snapshot()))));
    const next = request({ [parameter]: value });
    const changed = cacheChainObservationPayloadSchema.parse(tracker.observe(next));
    assert.equal(changed.frozenPrefixBreak, false);
    assert.equal(changed.breakIndex, undefined);
    assert.equal(changed.parametersChanged, true);
    assert.deepEqual(changed.changedParameters, [parameter]);
    assert.equal(changed.sharedPrefixDigest, same.sharedPrefixDigest);
    assert.equal(changed.prefixComparisonAvailable, true);
    const retry = tracker.observe(next);
    assert.equal(retry.parametersChanged, false); assert.deepEqual(retry.changedParameters, []);
    assert.equal(retry.frozenPrefixBreak, false);
    assert.equal(JSON.stringify(tracker.snapshot()).includes('hello'), false);
    assert.ok(Object.values(tracker.snapshot().parameterDigests).every(hash => /^[a-f0-9]{64}$/.test(hash)));
  });
}

test('legacy snapshots report aggregate parameter changes and learn names without rewriting the prefix', () => {
  const original = new CacheChainTracker(); original.observe(request());
  const { parameterDigests, ...legacy } = original.snapshot();
  const tracker = new CacheChainTracker(legacy);
  const changed = tracker.observe(request({ temperature: 0.4 }));
  assert.equal(changed.parametersChanged, true);
  assert.equal(changed.changedParameters, undefined, 'old snapshots do not identify which parameter changed');
  assert.equal(changed.frozenPrefixBreak, false);
  assert.deepEqual(tracker.observe(request({ temperature: 0.6 })).changedParameters, ['temperature']);
  const unchanged = new CacheChainTracker(legacy).observe(request());
  assert.equal(unchanged.parametersChanged, false); assert.deepEqual(unchanged.changedParameters, []);
});

test('provider parameter additions, removals and output changes preserve the input prefix and calibration data', () => {
  const tracker = new CacheChainTracker(); tracker.observe(request());
  const base = { format: 'fixture', transport: 'full', inputDigests: ['system', 'user'],
    parameterDigests: { max_tokens: 'old', temperature: 'warm' },
    tokenEstimate: { method: 'fixture', tokens: 100, inputParametersDigest: 'same-input' } };
  const initial = tracker.observeProviderInput(base);
  assert.equal(initial.prefixComparisonAvailable, false);
  const next = { ...base, parameterDigests: { max_tokens: 'new', top_p: 'new' }, inputDigests: [...base.inputDigests, 'assistant'] };
  const observation = providerInputObservationSchema.parse(tracker.observeProviderInput(next));
  assert.equal(observation.parametersChanged, true);
  assert.deepEqual(observation.changedParameters, ['max_tokens', 'temperature', 'top_p']);
  assert.equal(observation.sharedPrefixMessages, 2); assert.equal(observation.appendedMessages, 1);
  assert.equal(observation.frozenPrefixBreak, false); assert.equal(observation.breakIndex, undefined);
  assert.deepEqual(tracker.snapshot().providerInput, next, 'diagnostics must not alter the token-calibration projection');
});

test('truncation is a real prefix break even with simultaneous parameter changes', () => {
  const messages = [{ role: 'system', content: 'Keep' }, { role: 'user', content: 'Remove' }];
  const tracker = new CacheChainTracker(); tracker.observe(request({ messages }));
  tracker.observeProviderInput({ format: 'fixture', transport: 'full', parameterDigests: { output: 'old' }, inputDigests: ['keep', 'remove'] });
  const runtime = tracker.observe(request({ messages: [messages[0]], maxOutputTokens: 100 }));
  const provider = tracker.observeProviderInput({ format: 'fixture', transport: 'full', parameterDigests: { output: 'new' }, inputDigests: ['keep'] });
  for (const observation of [runtime, provider]) {
    assert.equal(observation.parametersChanged, true);
    assert.equal(observation.frozenPrefixBreak, true);
    assert.equal(observation.breakIndex, 1);
    assert.equal(observation.messageBreakIndex, 1);
    assert.equal(observation.appendedMessages, 0);
  }
});
