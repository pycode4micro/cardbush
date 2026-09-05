import assert from "node:assert/strict";
import test from "node:test";
import { STOP_RUNTIME_TURN_COMMAND, modelEventSchema, runtimeEventSchema } from "@cardbush/bush-protocol";
import { InMemoryRuntimeHost, ToolRegistry, defaultRuntimeRetryDelayMs } from "../dist/index.js";

const definition = { name: "retry_fixture", description: "Count one tool execution", inputSchema: { type: "object" } };
const request = {
  protocol: "bush.model_request.v1", requestId: "retry-test", sessionId: "retry-test", turnId: "retry-test",
  model: "fixture", messages: [{ role: "user", content: "perform the fixture" }], tools: [definition],
};
const event = (sequence, kind, fields = {}) => ({
  protocol: "bush.model_event.v1", requestId: request.requestId, sequence,
  createdAt: "2026-09-05T00:00:00.000Z", kind, ...fields,
});
const failed = (fields = {}) => event(2, "response_failed", {
  code: "ECONNRESET", message: "Connection error. (ECONNRESET)", retryable: true,
  diagnostics: { errorName: "APIConnectionError", causeNames: ["TypeError", "Error"], causeCodes: ["ECONNRESET"] },
  ...fields,
});

test("retry protocol retains old finite caps and represents sustained retries explicitly", () => {
  for (const maxAttempts of [5, null]) {
    const value = {
      protocol: "bush.runtime_event.v1", eventId: "retry-event", sequence: 1,
      requestId: request.requestId, sessionId: request.sessionId, turnId: request.turnId,
      createdAt: "2026-09-05T00:00:00.000Z", kind: "provider_retry",
      payload: { attempt: 2, maxAttempts, nextRetryMs: 1000, code: "ECONNRESET", message: "connection", diagnostics: failed().diagnostics },
    };
    assert.deepEqual(runtimeEventSchema.parse(value), value);
  }
  assert.deepEqual(modelEventSchema.parse(failed({ retryAfterMs: 3000 })), failed({ retryAfterMs: 3000 }));
});

test("default backoff grows to 30s and honors a bounded server retry delay", () => {
  const delay = (nextAttempt, retryAfterMs) => defaultRuntimeRetryDelayMs({ nextAttempt, maxAttempts: null, code: "ECONNRESET", retryAfterMs });
  assert.deepEqual([2, 3, 4, 5, 6, 7, 8, 10000].map(attempt => delay(attempt)), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  assert.equal(delay(2, 12000), 12000);
  assert.equal(delay(2, 99999999), 300000);
  for (const value of [undefined, -500, NaN, Infinity]) assert.equal(delay(2, value), 1000);
});

test("retries past five attempts without replaying tools or changing the frozen request", async () => {
  let executions = 0;
  const registry = new ToolRegistry().register({
    definition, decodeInput: value => value,
    manifest: { effect_kind: "observation", operation: "fixture.count", risk: "low", owner: "fixture", dispatch_scope: "turn", mutating: false },
    execute() { executions += 1; return { result: "already executed" }; },
  });
  const requests = [], waits = [];
  const host = new InMemoryRuntimeHost({
    maxAttempts: null, toolRegistry: registry,
    wait: async delay => { waits.push(delay); },
    provider: {
      async *stream(input) {
        requests.push(structuredClone(input));
        yield event(0, "response_started");
        if (requests.length === 1) {
          yield event(1, "tool_call_delta", { index: 0, toolCallId: "call-once", nameDelta: definition.name, argumentsDelta: "{}" });
          yield event(2, "response_completed", { finishReason: "tool_calls" });
        } else if (requests.length <= 8) {
          yield event(1, "text_delta", { delta: "unfinished attempt" });
          yield failed();
        } else {
          yield event(1, "text_delta", { delta: "recovered" });
          yield event(2, "response_completed", { finishReason: "stop" });
        }
      },
    },
  });
  const terminal = await host.runModelTurn(request);
  assert.equal(terminal.payload.status, "completed");
  assert.equal(terminal.payload.details.rounds, 2);
  assert.equal(executions, 1);
  assert.equal(requests.length, 9);
  for (const retried of requests.slice(2)) assert.deepEqual(retried, requests[1]);
  assert.deepEqual(waits, [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  const events = host.events(request.sessionId, request.turnId);
  assert.equal(events.filter(item => item.kind === "tool_returned").length, 1);
  const toolEvent = events.find(item => item.kind === "tool_returned");
  assert.ok(events.filter(item => item.kind === "replay_reset").every(item => !item.payload.supersededEventIds.includes(toolEvent.eventId)));
  assert.ok(events.filter(item => item.kind === "cache_chain_observed").every(item => !item.payload.frozenPrefixBreak));
  const retries = events.filter(item => item.kind === "provider_retry");
  assert.equal(retries.length, 7);
  assert.equal(retries.at(-1).payload.attempt, 8);
  assert.equal(retries.at(-1).payload.maxAttempts, null);
  assert.deepEqual(retries[0].payload.diagnostics, failed().diagnostics);
  assert.equal(events.filter(item => item.kind === "turn_terminal").length, 1);
  assert.equal(events.filter(item => item.kind === "assistant_segment_completed").at(-1).payload.content, "recovered");
});

test("Stop interrupts a long backoff immediately and prevents another request", { timeout: 3000 }, async (context) => {
  let calls = 0;
  const host = new InMemoryRuntimeHost({
    maxAttempts: null,
    provider: { async *stream() { calls += 1; yield failed({ retryAfterMs: 300000 }); } },
  });
  context.after(() => host.sendCommand({ kind: STOP_RUNTIME_TURN_COMMAND, payload: { sessionId: request.sessionId, turnId: request.turnId } }));
  const running = host.runModelTurn(request);
  for (let index = 0; index < 100 && !host.events(request.sessionId, request.turnId).some(item => item.kind === "provider_retry"); index += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(host.events(request.sessionId, request.turnId).some(item => item.kind === "provider_retry"));
  const start = Date.now();
  await host.sendCommand({ kind: STOP_RUNTIME_TURN_COMMAND, payload: { sessionId: request.sessionId, turnId: request.turnId } });
  const terminal = await running;
  assert.equal(terminal.payload.status, "stopped");
  assert.equal(calls, 1);
  assert.ok(Date.now() - start < 1000);
});

test("non-retryable failures stop even with no attempt cap, retaining diagnostics", async () => {
  let calls = 0;
  const host = new InMemoryRuntimeHost({
    maxAttempts: null,
    provider: { async *stream() { calls += 1; yield failed({ code: "invalid_api_key", status: 401, retryable: false }); } },
  });
  const terminal = await host.runModelTurn(request);
  assert.equal(calls, 1);
  assert.equal(terminal.payload.status, "failed");
  assert.equal(terminal.payload.details.status, 401);
  assert.deepEqual(terminal.payload.details.diagnostics, failed().diagnostics);
  assert.equal(host.events(request.sessionId, request.turnId).filter(item => item.kind === "provider_retry").length, 0);
});
