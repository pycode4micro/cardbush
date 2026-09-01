import assert from "node:assert/strict";
import test from "node:test";

import {
  CoordinationStore,
  ToolExecutionCoordinator,
  ToolRegistry,
  registerCoordinationTools,
} from "../dist/index.js";

test("model-facing Plan and Goal tools return their native coordination records", async () => {
  const store = new CoordinationStore({
    now: () => "2026-08-29T00:00:00.000Z",
    createNodeId: () => "node_runtime",
  });
  store.createGoal({
    goalId: "goal_runtime",
    sessionId: "session_1",
    objective: "finish",
    linkedA2ATaskIds: [],
  });
  const registry = new ToolRegistry();
  registerCoordinationTools(registry, store, { createPlanId: () => "plan_runtime" });
  const coordinator = new ToolExecutionCoordinator({
    registry,
    permissions: { request: async () => { throw new Error("unexpected permission"); } },
  });

  const planOutcome = await coordinator.execute(
    toolCall("call_plan", "update_task_plan", {
      nodes: [{ step: "inspect", status: "in_progress" }],
      explanation: "",
      active: true,
    }),
    identity(0),
  );
  assert.equal(planOutcome.kind, "returned");
  assert.equal(planOutcome.result.plan.plan_id, "plan_runtime");
  assert.equal(planOutcome.result.plan.nodes[0].id, "node_runtime");

  const goalOutcome = await coordinator.execute(
    toolCall("call_goal", "update_goal", {
      status: "complete",
      statusReason: "declared complete",
    }),
    identity(1),
  );
  assert.equal(goalOutcome.kind, "returned");
  assert.equal(goalOutcome.result.goalId, "goal_runtime");
  assert.equal(goalOutcome.result.status, "complete");
  assert.equal(store.getGoal("session_1").revision, 2);
});

test("Tool Catalog exposes the coordination schemas registered by the Host", async () => {
  const registry = new ToolRegistry();
  registerCoordinationTools(registry, new CoordinationStore());
  assert.deepEqual(
    registry.definitions().map((definition) => definition.name),
    ["update_task_plan", "update_goal"],
  );
  assert.equal(registry.definitions()[0].inputSchema.additionalProperties, false);
});

function toolCall(id, name, input) {
  return {
    protocol: "bush.tool_call.v1",
    id,
    name,
    argumentsText: JSON.stringify(input),
  };
}

function identity(ordinal) {
  return {
    requestId: "request_1",
    sessionId: "session_1",
    turnId: "turn_1",
    round: 1,
    ordinal,
  };
}
