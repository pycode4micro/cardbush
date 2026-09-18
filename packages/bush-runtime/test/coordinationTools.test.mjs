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

test('a new task can replace a recorded completed plan without a scope-change workaround', async () => {
  const events = [];
  const persistence = { load: () => structuredClone(events), append: event => events.push(structuredClone(event)) };
  const store = new CoordinationStore({ persistence });
  const registry = new ToolRegistry();
  registerCoordinationTools(registry, store, { createPlanId: () => 'session-plan' });
  const coordinator = new ToolExecutionCoordinator({ registry,
    permissions: { request: async () => { throw new Error('unexpected permission'); } } });
  const completed = await coordinator.execute(toolCall('old-plan', 'update_task_plan', {
    nodes: Array.from({ length: 13 }, (_, index) => ({ id: `old-${index}`, step: `Old task ${index}`, status: 'completed' })),
    explanation: 'The prior task is complete.', active: false,
  }), identity(0));
  assert.equal(completed.kind, 'returned');
  const next = { nodes: [
    { id: 'download', step: 'Download the subtitle source', status: 'in_progress' },
    { id: 'locate', step: 'Locate the subtitles', status: 'pending' },
    { id: 'erase', step: 'Run subtitle removal', status: 'pending' },
    { id: 'verify', step: 'Download and verify the result', status: 'pending' },
  ], explanation: 'New subtitle-removal task.', active: true };
  const updated = await coordinator.execute(toolCall('new-plan', 'update_task_plan', next), { ...identity(1), turnId: 'next-turn' });
  assert.equal(updated.kind, 'returned');
  assert.equal(updated.result.revision, 2);
  assert.deepEqual(updated.result.plan.nodes, next.nodes);
  assert.equal(events[0].payload.plan.active, false, 'the previous Tool fact is unchanged');
  assert.equal(events[0].payload.plan.nodes.length, 13);
  assert.deepEqual(new CoordinationStore({ persistence }).getPlan('session_1'), updated.result);
  const stillActive = await coordinator.execute(toolCall('drop-unfinished', 'update_task_plan', {
    ...next, nodes: next.nodes.slice(0, 1),
  }), { ...identity(2), turnId: 'next-turn' });
  assert.equal(stillActive.kind, 'failed');
  assert.match(stillActive.error.message, /scopeChangeReason/);
  assert.equal(store.getPlan('session_1').revision, 2, 'failed updates do not change state');
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
