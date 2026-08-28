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
