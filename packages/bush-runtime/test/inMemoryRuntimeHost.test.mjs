import assert from "node:assert/strict";
import test from "node:test";

import {
  BUSH_MODEL_EVENT_PROTOCOL,
  BUSH_MODEL_REQUEST_PROTOCOL,
  CREATE_RUNTIME_GOAL_COMMAND,
  GET_RUNTIME_CAPABILITIES_COMMAND,
  GET_RUNTIME_GOAL_COMMAND,
  GET_RUNTIME_PLAN_COMMAND,
  GET_RUNTIME_TOOL_CATALOG_COMMAND,
  SET_RUNTIME_PLAN_COMMAND,
  UPDATE_RUNTIME_GOAL_COMMAND,
} from "@cardbush/bush-protocol";
import { InMemoryRuntimeHost } from "../dist/index.js";

const request = {
  protocol: BUSH_MODEL_REQUEST_PROTOCOL,
  requestId: "req_host",
  sessionId: "session_host",
  turnId: "turn_host",
  model: "model",
  messages: [{ role: "user", content: "hello" }],
  tools: [],
};

const base = {
  protocol: BUSH_MODEL_EVENT_PROTOCOL,
  requestId: request.requestId,
  createdAt: "2026-08-29T00:00:00.000Z",
};

test("publishes a complete live Turn without mixing reasoning and assistant output", async () => {
  const host = hostWithAttempts([
    [
      { ...base, sequence: 0, kind: "response_started" },
      { ...base, sequence: 1, kind: "reasoning_delta", delta: "think" },
      { ...base, sequence: 2, kind: "text_delta", delta: "answer" },
      { ...base, sequence: 3, kind: "response_completed", finishReason: "stop" },
    ],
  ]);
  const streamPromise = collect(
    host.openEventStream({ sessionId: request.sessionId, turnId: request.turnId }),
  );
  const terminal = await host.runModelTurn(request);
  const events = await streamPromise;

  assert.equal(terminal.kind, "turn_terminal");
  assert.equal(terminal.payload.status, "completed");
  assert.deepEqual(events.map((event) => event.kind), [
    "turn_accepted",
    "turn_started",
    "cache_chain_observed",
    "reasoning_segment_started",
    "reasoning_segment_delta",
    "reasoning_segment_completed",
    "assistant_segment_started",
    "assistant_segment_delta",
    "assistant_segment_completed",
    "turn_terminal",
  ]);
  assert.equal(
    events.find((event) => event.kind === "reasoning_segment_completed")?.payload.content,
    "think",
  );
  assert.equal(
    events.find((event) => event.kind === "assistant_segment_completed")?.payload.content,
    "answer",
  );
  assert.equal(
    terminal.payload.finalMessageId,
    events.find((event) => event.kind === "assistant_segment_started")?.payload.messageId,
  );
  assert.ok(
    host.capabilities().supportedCommands.includes(
      GET_RUNTIME_CAPABILITIES_COMMAND,
    ),
  );
});

test("is structurally usable as the product RuntimeTransport", async () => {
  const host = hostWithAttempts([]);
  const capabilities = await host.sendCommand({
    kind: GET_RUNTIME_CAPABILITIES_COMMAND,
    payload: {},
  });

  assert.equal(capabilities.eventProtocol, "bush.runtime_event.v1");
  assert.ok(capabilities.supportedEvents.includes("permission_requested"));
  await assert.rejects(() =>
    host.sendCommand({ kind: "runtime.unknown", payload: {} }),
  );
});

test("exposes Plan and Goal as explicit typed command facts", async () => {
  const host = hostWithAttempts([]);
  const plan = await host.sendCommand({
    kind: SET_RUNTIME_PLAN_COMMAND,
    payload: {
      sessionId: "session_coordination",
      expectedRevision: 0,
      plan: {
        protocol: "bush.task_plan.v1",
        plan_id: "plan_1",
        session_id: "session_coordination",
        nodes: [{ step: "inspect", status: "in_progress" }],
        explanation: "",
        active: true,
      },
    },
  });
  assert.equal(plan.revision, 1);
  assert.ok(plan.plan.nodes[0].id);
  assert.equal(
    (await host.sendCommand({
      kind: GET_RUNTIME_PLAN_COMMAND,
      payload: { sessionId: "session_coordination" },
    })).revision,
    1,
  );

  const goal = await host.sendCommand({
    kind: CREATE_RUNTIME_GOAL_COMMAND,
    payload: {
      goalId: "goal_1",
      sessionId: "session_coordination",
      objective: "finish",
      linkedA2ATaskIds: [],
    },
  });
  const updated = await host.sendCommand({
    kind: UPDATE_RUNTIME_GOAL_COMMAND,
    payload: {
      goalId: goal.goalId,
      sessionId: goal.sessionId,
      expectedRevision: goal.revision,
      status: "complete",
      statusReason: "declared by the caller",
      consumedTokens: 1,
      linkedA2ATaskIds: [],
    },
  });
  assert.equal(updated.status, "complete");
  assert.equal(
    (await host.sendCommand({
      kind: GET_RUNTIME_GOAL_COMMAND,
      payload: { sessionId: "session_coordination" },
    })).revision,
    2,
  );
  assert.ok(host.capabilities().features.includes("explicit_goal_facts"));
  const catalog = await host.sendCommand({
    kind: GET_RUNTIME_TOOL_CATALOG_COMMAND,
    payload: {},
  });
  assert.deepEqual(catalog.map((definition) => definition.name), [
    "update_task_plan",
    "update_goal",
    "read_file",
    "search_file_content",
    "write_file",
    "edit_file",
    "terminal_exec",
    "subagent",
    "team_delegate",
  ]);
});

test("projects explicit cancellation as a stopped terminal fact", async () => {
  const controller = new AbortController();
  controller.abort();
  const host = hostWithAttempts([]);

  const terminal = await host.runModelTurn(request, { signal: controller.signal });
  assert.equal(terminal.payload.status, "stopped");
  assert.equal(terminal.payload.reason, "user_stop_requested");
});

test("records failed attempt supersession and an observable provider retry", async () => {
  const firstFailure = [
    { ...base, sequence: 0, kind: "response_started" },
    { ...base, sequence: 1, kind: "text_delta", delta: "partial" },
    { ...base, sequence: 2, kind: "response_failed", code: "provider_busy", message: "busy", retryable: true },
  ];
  const success = [
    { ...base, sequence: 0, kind: "response_started" },
    { ...base, sequence: 1, kind: "text_delta", delta: "final" },
    { ...base, sequence: 2, kind: "response_completed", finishReason: "stop" },
  ];
  const host = hostWithAttempts([firstFailure, success], { maxAttempts: 2 });

  const terminal = await host.runModelTurn(request);
  const events = host.events(request.sessionId, request.turnId);
  const reset = events.find((event) => event.kind === "replay_reset");
  const retry = events.find((event) => event.kind === "provider_retry");

  assert.equal(terminal.payload.status, "completed");
  assert.ok(reset);
  assert.ok(reset.payload.supersededEventIds.length >= 3);
  assert.equal(retry?.payload.attempt, 2);
  assert.equal(retry?.payload.maxAttempts, 2);
  assert.equal(events.filter((event) => event.kind === "turn_terminal").length, 1);
  assert.equal(
    events.filter((event) => event.kind === "assistant_segment_completed").at(-1)?.payload.content,
    "final",
  );
});

test("ends with an explicit failure after retries are exhausted", async () => {
  const failure = [
    { ...base, sequence: 0, kind: "response_started" },
    { ...base, sequence: 1, kind: "response_failed", code: "provider_busy", message: "busy", retryable: true },
  ];
  const host = hostWithAttempts([failure, failure], { maxAttempts: 2 });

  const terminal = await host.runModelTurn(request);
  assert.equal(terminal.kind, "turn_terminal");
  assert.equal(terminal.payload.status, "failed");
  assert.equal(terminal.payload.reason, "provider_busy");
  assert.equal(terminal.payload.details.attempts, 2);
});

test("turns an unexpected provider exception into one terminal fact", async () => {
  const host = new InMemoryRuntimeHost({
    provider: {
      async *stream() {
        throw new Error("socket exploded");
      },
    },
    eventLogOptions: deterministicEventLogOptions(),
  });

  const terminal = await host.runModelTurn(request);
  assert.equal(terminal.payload.status, "failed");
  assert.equal(terminal.payload.reason, "provider_stream_exception");
  assert.equal(
    host.events(request.sessionId, request.turnId).filter((event) => event.kind === "turn_terminal").length,
    1,
  );
});

function hostWithAttempts(attempts, options = {}) {
  let index = 0;
  return new InMemoryRuntimeHost({
    provider: {
      async *stream() {
        yield* attempts[index++] ?? [];
      },
    },
    maxAttempts: options.maxAttempts,
    retryDelayMs: () => 0,
    wait: async () => {},
    eventLogOptions: deterministicEventLogOptions(),
    projectorOptions: {
      createMessageId: counter("message"),
      createSegmentId: counter("segment"),
    },
  });
}

function deterministicEventLogOptions() {
  return {
    createEventId: ({ sequence }) => `event_${sequence}`,
    now: () => "2026-08-29T00:00:00.000Z",
  };
}

function counter(prefix) {
  let value = 0;
  return () => `${prefix}_${++value}`;
}

async function collect(events) {
  const values = [];
  for await (const event of events) values.push(event);
  return values;
}
