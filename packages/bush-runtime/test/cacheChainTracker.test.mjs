import assert from "node:assert/strict";
import test from "node:test";

import {
  BUSH_MODEL_REQUEST_PROTOCOL,
  modelRequestSchema,
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

test("treats tool schema changes as stable request input breaks without tool semantics", () => {
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

  assert.equal(observation.frozenPrefixBreak, true);
  assert.equal(observation.breakIndex, 0);
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
  assert.equal(changed.frozenPrefixBreak, true); assert.equal(changed.breakIndex, 0);
  assert.equal(changed.sharedPrefixMessages, 1); assert.equal(changed.messageBreakIndex, 1);
  const wire = tracker.observeProviderInput({ format: 'fixture', transport: 'full', parameterDigests: { tools: 'tools-after' }, inputDigests: ['system', 'replaced', 'appended'] });
  assert.deepEqual(wire.changedParameters, ['tools']); assert.equal(wire.breakIndex, 0);
  assert.equal(wire.sharedPrefixMessages, 1); assert.equal(wire.messageBreakIndex, 1);
  const onlyParameters = tracker.observeProviderInput({ format: 'fixture', transport: 'full', parameterDigests: { tools: 'tools-new' }, inputDigests: ['system', 'replaced', 'appended'] });
  assert.equal(onlyParameters.frozenPrefixBreak, true); assert.equal(onlyParameters.sharedPrefixMessages, 3);
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

  assert.equal(observation.frozenPrefixBreak, true);
  assert.equal(observation.breakIndex, 0);
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
