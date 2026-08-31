import assert from "node:assert/strict";
import test from "node:test";

import {
  BUSH_MODEL_EVENT_PROTOCOL,
  BUSH_MODEL_REQUEST_PROTOCOL,
} from "@cardbush/bush-protocol";
import { executeModelRound } from "../dist/index.js";

const request = {
  protocol: BUSH_MODEL_REQUEST_PROTOCOL,
  requestId: "req_1",
  sessionId: "session_1",
  turnId: "turn_1",
  model: "model",
  messages: [{ role: "user", content: "inspect" }],
  tools: [],
};

const base = {
  protocol: BUSH_MODEL_EVENT_PROTOCOL,
  requestId: "req_1",
  createdAt: "2026-08-29T00:00:00.000Z",
};

class FakeProvider {
  constructor(events) {
    this.events = events;
  }

  async *stream() {
    yield* this.events;
  }
}

test("collects visible and reasoning channels without mixing them", async () => {
  const events = [
    { ...base, sequence: 0, kind: "response_started", providerResponseId: "resp_round_1" },
    { ...base, sequence: 1, kind: "reasoning_delta", delta: "private analysis" },
    { ...base, sequence: 2, kind: "text_delta", delta: "visible answer" },
    { ...base, sequence: 3, kind: "response_completed", finishReason: "stop" },
    { ...base, sequence: 4, kind: "usage", inputTokens: 20, outputTokens: 4 },
  ];
  const observed = [];
  const result = await executeModelRound(new FakeProvider(events), request, {
    onEvent: (event) => observed.push(event.kind),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.providerResponseId, "resp_round_1");
  assert.equal(result.text, "visible answer");
  assert.equal(result.reasoning, "private analysis");
  assert.equal(result.usage.inputTokens, 20);
  assert.deepEqual(observed, events.map((event) => event.kind));
});

test("collects interleaved parallel tool calls", async () => {
  const result = await executeModelRound(
    new FakeProvider([
      { ...base, sequence: 0, kind: "response_started" },
      { ...base, sequence: 1, kind: "tool_call_delta", index: 0, toolCallId: "a", nameDelta: "read_file", argumentsDelta: '{"path":' },
      { ...base, sequence: 2, kind: "tool_call_delta", index: 1, toolCallId: "b", nameDelta: "search_file_content", argumentsDelta: '{"query":"x"}' },
      { ...base, sequence: 3, kind: "tool_call_delta", index: 0, argumentsDelta: '"a.ts"}' },
      { ...base, sequence: 4, kind: "response_completed", finishReason: "tool_calls" },
    ]),
    request,
  );

  assert.equal(result.status, "completed");
  assert.deepEqual(result.toolCalls.map((call) => call.name), ["read_file", "search_file_content"]);
});

test("rejects missing terminal events and sequence regressions mechanically", async () => {
  const missing = await executeModelRound(
    new FakeProvider([{ ...base, sequence: 0, kind: "response_started" }]),
    request,
  );
  assert.equal(missing.status, "failed");
  assert.equal(missing.error.code, "provider_terminal_event_missing");

  const regression = await executeModelRound(
    new FakeProvider([
      { ...base, sequence: 2, kind: "response_started" },
      { ...base, sequence: 1, kind: "text_delta", delta: "late" },
    ]),
    request,
  );
  assert.equal(regression.status, "failed");
  assert.equal(regression.error.code, "provider_event_sequence_regression");
});

test("does not expose provider events emitted after completion", async () => {
  const observed = [];
  const result = await executeModelRound(
    new FakeProvider([
      { ...base, sequence: 0, kind: "response_started" },
      { ...base, sequence: 1, kind: "text_delta", delta: "valid" },
      { ...base, sequence: 2, kind: "response_completed", finishReason: "stop" },
      { ...base, sequence: 3, kind: "text_delta", delta: "invalid trailing text" },
    ]),
    request,
    { onEvent: (event) => observed.push(event.kind) },
  );

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "provider_event_after_completion");
  assert.deepEqual(observed, [
    "response_started",
    "text_delta",
    "response_completed",
  ]);
});
