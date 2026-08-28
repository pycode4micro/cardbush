import assert from "node:assert/strict";
import test from "node:test";

import {
  BUSH_MODEL_EVENT_PROTOCOL,
  BUSH_MODEL_REQUEST_PROTOCOL,
  modelEventSchema,
  modelRequestSchema,
  outcomeFinalizerSchema,
  taskPlanSchema,
} from "../dist/index.js";

test("model request keeps provider-independent tool definitions", () => {
  const request = modelRequestSchema.parse({
    protocol: BUSH_MODEL_REQUEST_PROTOCOL,
    requestId: "req_1",
    sessionId: "session_1",
    turnId: "turn_1",
    model: "compatible-model",
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        name: "read_file",
        description: "Read one file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
    ],
  });

  assert.equal(request.toolChoice, "auto");
  assert.equal(request.tools[0].name, "read_file");
});

test("model events are transport-neutral and mechanically validated", () => {
  const event = modelEventSchema.parse({
    protocol: BUSH_MODEL_EVENT_PROTOCOL,
    requestId: "req_1",
    sequence: 2,
    createdAt: "2026-08-29T00:00:00.000Z",
    kind: "tool_call_delta",
    index: 0,
    toolCallId: "call_1",
    nameDelta: "read_file",
    argumentsDelta: '{"path":"README.md"}',
  });

  assert.equal(event.kind, "tool_call_delta");
});

test("task plan preserves the reference runtime invariants", () => {
  assert.throws(() =>
    taskPlanSchema.parse({
      protocol: "bush.task_plan.v1",
      plan_id: "plan_1",
      session_id: "session_1",
      nodes: [
        { id: "a", step: "A", status: "in_progress" },
        { id: "b", step: "B", status: "in_progress" },
      ],
      explanation: "",
      active: true,
    }),
  );
});

test("outcome finalizer accepts only reference statuses", () => {
  assert.throws(() =>
    outcomeFinalizerSchema.parse({
      protocol: "bush.outcome_finalizer.v1",
      status: "guessed_complete",
      result_intent: "deliverable",
      required_evidence: [],
      observed_evidence: [],
      missing_evidence: [],
      blocking_facts: [],
      reason: "",
      required_acceptance: [],
      passed_acceptance: [],
      failed_acceptance: [],
      stale_acceptance: [],
    }),
  );
});
