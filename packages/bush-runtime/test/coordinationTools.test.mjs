import assert from "node:assert/strict";
import test from "node:test";
import { fromJsonSchema } from '@modelcontextprotocol/client';

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

test('plan schema and decoder agree on action requirements, optional defaults and unknown fields', async () => {
  const registry = new ToolRegistry(); registerCoordinationTools(registry, new CoordinationStore());
  const tool = registry.resolve('update_task_plan'), nodes = [{ id: 'one', step: 'Inspect', status: 'pending' }];
  const valid = [{ nodes }, { action: 'replace', nodes }, { nodes, explanation: '' }, { nodes, active: false },
    { action: 'get' }, { action: 'patch', expected_revision: 0 }, { action: 'patch', expected_revision: 2, updates: [{ id: 'one', status: 'completed' }] }];
  const invalid = [{}, { action: 'replace' }, { nodes, explanation: 1 }, { nodes, active: null },
    { action: 'get', nodes }, { action: 'get', expected_revision: 0 }, { action: 'patch', updates: [] },
    { action: 'patch', expected_revision: 0, nodes }, { nodes, updates: [] }, { nodes, unknown: true },
    { nodes: [{ ...nodes[0], unknown: true }] }, { nodes, scopeChangeReason: false }, { action: null, nodes },
    { action: 'patch', expected_revision: 1, updates: null }, { action: 'patch', expected_revision: 1, append_nodes: [{ ...nodes[0], id: '' }] },
    { action: 'patch', expected_revision: 1, updates: [{ id: 'one', status: ['pending'] }] },
    { action: 'patch', expected_revision: -1 }, { action: 'patch', expected_revision: 1, append_nodes: [{ ...nodes[0], unknown: true }] }];
  for (const input of valid) {
    const parsed = await fromJsonSchema(tool.definition.inputSchema)['~standard'].validate(input);
    assert.equal(parsed.issues, undefined, JSON.stringify({ input, issues: parsed.issues }));
    assert.doesNotThrow(() => tool.decodeInput(input));
  }
  for (const input of invalid) {
    const parsed = await fromJsonSchema(tool.definition.inputSchema)['~standard'].validate(input);
    assert.ok(parsed.issues, JSON.stringify(input));
    assert.throws(() => tool.decodeInput(input), JSON.stringify(input));
  }
  assert.equal(tool.decodeInput({ nodes }).explanation, '');
  assert.equal(tool.decodeInput({ nodes }).active, true);
  assert.equal(tool.decodeInput({ nodes: [{ step: 'Done', status: 'completed' }] }).active, false);
  assert.equal(tool.decodeInput({ action: 'patch', expected_revision: 0 }).active, undefined);
});

test('minimal replace works, get is read-only, patch preserves omitted fields, and stale updates are atomic', async () => {
  const registry = new ToolRegistry(), store = new CoordinationStore(); registerCoordinationTools(registry, store);
  const coordinator = new ToolExecutionCoordinator({ registry }), nodes = [{ id: 'one', step: 'Inspect', status: 'pending' }];
  let ordinal = 0;
  const run = input => coordinator.execute(toolCall('plan-' + ++ordinal, 'update_task_plan', input), identity(ordinal));
  const first = await run({ nodes });
  assert.equal(first.kind, 'returned'); assert.equal(first.result.plan.active, true); assert.equal(first.result.plan.explanation, '');
  const replaced = await run({ action: 'replace', nodes: [{ ...nodes[0], status: 'completed' }], explanation: 'Retained', active: false, expected_revision: 1 });
  assert.equal(replaced.kind, 'returned', JSON.stringify(replaced));
  assert.deepEqual((await run({ action: 'get' })).result, replaced.result);
  const patch = await run({ action: 'patch', expected_revision: 2, updates: [{ id: 'one', step: 'Checked' }] });
  assert.equal(patch.kind, 'returned'); assert.equal(patch.result.plan.explanation, 'Retained'); assert.equal(patch.result.plan.active, false);
  for (const input of [{ nodes, expected_revision: 2 }, { action: 'replace', nodes, expected_revision: 2 },
    { action: 'patch', expected_revision: 2, explanation: 'Stale' }]) {
    const failed = await run(input); assert.equal(failed.kind, 'failed'); assert.match(failed.error.message, /revision conflict/);
    assert.deepEqual(store.getPlan('session_1'), patch.result);
  }
  const reopened = await run({ action: 'replace', nodes });
  assert.equal(reopened.kind, 'returned'); assert.equal(reopened.result.plan.active, true); assert.equal(reopened.result.plan.explanation, '');
  const completed = await run({ nodes: [{ ...nodes[0], status: 'completed' }] });
  assert.equal(completed.kind, 'returned'); assert.equal(completed.result.plan.active, false);
});
