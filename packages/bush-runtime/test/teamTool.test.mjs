import assert from "node:assert/strict";
import test from "node:test";

import {
  SubagentTaskStore,
  TeamSnapshotStore,
  ToolExecutionCoordinator,
  ToolRegistry,
  registerTeamTool,
} from "../dist/index.js";

test("runs configured Team discussion and execution as concurrent immutable phases", async () => {
  const registry = new ToolRegistry();
  const teams = new TeamSnapshotStore();
  teams.apply(snapshot());
  const tasks = new SubagentTaskStore({ now: () => NOW });
  let serial = 0;
  let active = 0;
  let peak = 0;
  const requests = [];
  registerTeamTool(
    registry,
    teams,
    tasks,
    async (request) => {
      requests.push(request);
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      const phase = request.metadata.teamPhase;
      const member = request.metadata.teamMemberId;
      return childResult(request, `${phase}:${member}`);
    },
    {
      createTaskId: () => `task_${++serial}`,
      createRequestId: () => `request_${serial}`,
      createSessionId: () => `session_${serial}`,
      createTurnId: () => `turn_${serial}`,
      createMessageId: () => `message_${serial}`,
      createReceiptId: () => "receipt_team",
    },
  );
  const coordinator = new ToolExecutionCoordinator({
    registry,
    permissions: { request: async () => { throw new Error("unexpected permission"); } },
  });
  const parentRequest = {
    protocol: "bush.model_request.v1",
    requestId: "parent_request",
    sessionId: "parent_session",
    turnId: "parent_turn",
    model: "fixture",
    messages: [],
    tools: registry.definitions(),
    toolChoice: "auto",
    metadata: {},
  };
  const outcome = await coordinator.execute(
    {
      protocol: "bush.tool_call.v1",
      id: "team_call",
      name: "team_delegate",
      argumentsText: JSON.stringify({
        team_id: "delivery",
        shared_brief: "Complete the release.",
        assignments: [
          { member_id: "builder", prompt: "Build it." },
          { member_id: "reviewer", prompt: "Review it." },
        ],
      }),
    },
    {
      requestId: parentRequest.requestId,
      sessionId: parentRequest.sessionId,
      turnId: parentRequest.turnId,
      round: 1,
      ordinal: 0,
    },
    undefined,
    {
      request: parentRequest,
      contextMessages: [
        { role: "system", content: "root-only" },
        { role: "user", content: "objective" },
      ],
    },
  );

  assert.equal(outcome.kind, "completed");
  assert.equal(outcome.result.success, true);
  assert.equal(peak, 2);
  assert.equal(requests.length, 4);
  assert.deepEqual(requests.map((request) => request.metadata.teamPhase), [
    "discussion", "discussion", "execution", "execution",
  ]);
  const executionPrompts = requests.slice(2).map((request) => request.inputMessages[0].message.content);
  const frozen = executionPrompts.map((prompt) => prompt.match(/\[\{.*\}\]/s)?.[0]);
  assert.equal(frozen[0], frozen[1]);
  assert.match(frozen[0], /discussion:builder/);
  assert.match(frozen[0], /discussion:reviewer/);
  assert.deepEqual(outcome.result.guidance.map((message) => message.name), [
    "team_result_builder", "team_result_reviewer",
  ]);
  assert.deepEqual(tasks.list("parent_session").map((task) => [task.origin, task.phase]), [
    ["team", "discussion"],
    ["team", "discussion"],
    ["team", "execution"],
    ["team", "execution"],
  ]);
});

test("rejects unknown or duplicate member assignments without dispatching children", async () => {
  const registry = new ToolRegistry();
  const teams = new TeamSnapshotStore();
  teams.apply(snapshot());
  let children = 0;
  registerTeamTool(
    registry,
    teams,
    new SubagentTaskStore(),
    async () => { children += 1; throw new Error("must not run"); },
  );
  const coordinator = new ToolExecutionCoordinator({
    registry,
    permissions: { request: async () => { throw new Error("unexpected permission"); } },
  });
  for (const assignments of [
    [{ member_id: "missing", prompt: "work" }],
    [{ member_id: "builder", prompt: "one" }, { member_id: "builder", prompt: "two" }],
  ]) {
    const outcome = await coordinator.execute(
      {
        protocol: "bush.tool_call.v1",
        id: `call_${assignments.length}_${assignments[0].member_id}`,
        name: "team_delegate",
        argumentsText: JSON.stringify({ team_id: "delivery", shared_brief: "brief", assignments }),
      },
      { requestId: "r", sessionId: "s", turnId: "t", round: 1, ordinal: 0 },
      undefined,
      {
        request: {
          protocol: "bush.model_request.v1",
          requestId: "r",
          sessionId: "s",
          turnId: "t",
          model: "m",
          messages: [],
          tools: registry.definitions(),
          toolChoice: "auto",
          metadata: {},
        },
        contextMessages: [],
      },
    );
    assert.equal(outcome.result.success, false);
  }
  assert.equal(children, 0);
});

function snapshot() {
  return {
    protocol: "bush.team_snapshot.v1",
    snapshotId: "teams",
    revision: 1,
    teams: [{
      teamId: "delivery",
      name: "Delivery",
      instructions: "Share only facts.",
      conference: { enabled: true, instructions: "Resolve conflicts." },
      members: [
        { memberId: "builder", name: "Builder", role: "build", instructions: "", toolNames: [] },
        { memberId: "reviewer", name: "Reviewer", role: "review", instructions: "", toolNames: [] },
      ],
    }],
  };
}

function childResult(request, text) {
  return {
    terminal: {
      kind: "turn_terminal",
      payload: {
        status: "completed",
        reason: "model_response_completed",
        finalMessageId: `answer_${request.turnId}`,
        details: {},
      },
    },
    session: {
      protocol: "bush.session_snapshot.v1",
      sessionId: request.sessionId,
      revision: 2,
      createdAt: NOW,
      updatedAt: NOW,
      supersededMessageIds: [],
      turns: [{
        turnId: request.turnId,
        turnSequence: 1,
        createdAt: NOW,
        completedAt: NOW,
        status: "completed",
        reason: "model_response_completed",
        usage: { inputTokens: 2, outputTokens: 1 },
        messages: [{
          messageId: `answer_${request.turnId}`,
          turnId: request.turnId,
          turnSequence: 1,
          messageIndex: 0,
          createdAt: NOW,
          message: { role: "assistant", content: text, toolCalls: [] },
        }],
      }],
    },
  };
}

const NOW = "2026-08-29T00:00:00.000Z";
