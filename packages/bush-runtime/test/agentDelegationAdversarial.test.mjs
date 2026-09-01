import assert from "node:assert/strict";
import test from "node:test";

import { teamSnapshotSchema } from "@cardbush/bush-protocol";
import {
  SubagentTaskStore,
  TeamSnapshotStore,
  ToolExecutionCoordinator,
  ToolRegistry,
  buildChildTurnRequest,
  inheritedChildMessages,
  projectSubagentTasks,
  registerSubagentTool,
  registerTeamTool,
  resolveChildTurn,
} from "../dist/index.js";

test("adversarial: inherited context cannot smuggle parent system or developer authority", () => {
  const context = turnContext({
    contextMessages: [
      { role: "system", content: "root secret" },
      { role: "developer", content: "root policy" },
      { role: "user", content: "shared objective" },
      { role: "assistant", content: "shared evidence", toolCalls: [] },
    ],
  });

  assert.deepEqual(
    inheritedChildMessages(context, true).map((message) => message.content),
    ["shared objective", "shared evidence"],
  );
  assert.deepEqual(inheritedChildMessages(context, false), []);
});

test("adversarial: child tool exposure is the strict intersection of registry, parent and policy", () => {
  const registry = new ToolRegistry();
  registerFixtureTool(registry, "shared", true);
  registerFixtureTool(registry, "root_only", false);
  registerFixtureTool(registry, "not_exposed_by_parent", true);
  const context = turnContext({
    tools: registry.definitions().filter((tool) => tool.name !== "not_exposed_by_parent"),
    metadata: {
      childAgentPolicy: { disabledTools: ["shared"] },
    },
  });

  const request = buildChildTurnRequest({
    context,
    registry,
    ids: childIds(),
    prompt: "bounded work",
    inherited: [],
    metadata: {},
  });
  assert.deepEqual(request.tools, []);

  assert.throws(
    () => buildChildTurnRequest({
      context,
      registry,
      ids: childIds(),
      prompt: "try escalation",
      inherited: [],
      metadata: {},
      allowedToolNames: ["root_only", "not_exposed_by_parent"],
    }),
    /not exposed by the parent Turn/,
  );
});

test("adversarial: malformed child policy fails closed instead of widening authority", () => {
  const registry = new ToolRegistry();
  registerFixtureTool(registry, "shared", true);
  for (const childAgentPolicy of [
    "all_free",
    { permissionRouting: "model_decides" },
    { childPermissionMode: "unrestricted" },
    { disabledTools: ["shared", ""] },
    { unknownPolicyField: true },
    { model: { mode: "fixed", modelId: "missing-binding" } },
  ]) {
    const context = turnContext({
      tools: registry.definitions(),
      metadata: { childAgentPolicy },
    });
    assert.throws(() => buildChildTurnRequest({
      context,
      registry,
      ids: childIds(),
      prompt: "work",
      inherited: [],
      metadata: {},
    }));
  }
});

test("adversarial: forged child terminal facts cannot produce a successful task", () => {
  const valid = childResult("child_turn", "answer", "trusted result");
  assert.equal(resolveChildTurn(valid, "child_turn").status, "completed");

  const missingCommittedTurn = childResult("different_turn", "answer", "forged result");
  assert.deepEqual(resolveChildTurn(missingCommittedTurn, "child_turn"), {
    status: "failed",
    finalResponse: "",
    errorMessage: "child_turn_produced_no_terminal_response",
    usage: {},
  });

  const wrongFinalMessage = childResult("child_turn", "different_answer", "uncommitted result");
  assert.equal(resolveChildTurn(wrongFinalMessage, "child_turn").status, "failed");

  assert.throws(
    () => resolveChildTurn({ ...valid, terminal: { kind: "assistant_delta", payload: {} } }, "child_turn"),
    /non-terminal Runtime event/,
  );
});

test("adversarial: Subagent abort becomes stopped and never completed", async () => {
  const registry = new ToolRegistry();
  const tasks = new SubagentTaskStore({ now: () => NOW });
  let markChildStarted;
  const childStarted = new Promise((resolve) => { markChildStarted = resolve; });
  registerSubagentTool(registry, tasks, async (_request, signal) => {
    markChildStarted();
    await new Promise((_, reject) => signal?.addEventListener(
      "abort",
      () => reject(new Error("runner observed cancellation boundary")),
      { once: true },
    ));
    throw new Error("unreachable");
  }, deterministicIds());
  const controller = new AbortController();

  const running = coordinator(registry).execute(
    toolCall("subagent", { prompt: "must stop" }),
    executionIdentity(),
    controller.signal,
    turnContext({ tools: registry.definitions() }).turn,
  );
  await childStarted;
  controller.abort("parent stopped");
  const outcome = await running;

  assert.equal(outcome.kind, "returned");
  assert.equal(outcome.result.status, "stopped");
  assert.match(outcome.result.errorMessage, /cancellation boundary/);
  assert.equal(tasks.get("parent_session", "task_1")?.status, "stopped");
});

test("adversarial: one failed Team member is isolated while siblings complete", async () => {
  const registry = new ToolRegistry();
  const teams = new TeamSnapshotStore();
  teams.apply(teamSnapshot());
  const tasks = new SubagentTaskStore({ now: () => NOW });
  let serial = 0;
  let successfulSiblingFinished = false;
  registerTeamTool(registry, teams, tasks, async (request) => {
    if (request.metadata.teamMemberId === "attacker") {
      throw new Error("member process failed");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    successfulSiblingFinished = true;
    return childResult(request.turnId, "answer", "verified evidence");
  }, {
    createTaskId: () => `task_${++serial}`,
    createRequestId: () => `request_${serial}`,
    createSessionId: () => `session_${serial}`,
    createTurnId: () => `turn_${serial}`,
    createMessageId: () => `message_${serial}`,
  });

  const outcome = await coordinator(registry).execute(
    toolCall("team_delegate", {
      team_id: "red_team",
      shared_brief: "test isolation",
      assignments: [
        { member_id: "attacker", prompt: "fail independently" },
        { member_id: "reviewer", prompt: "return evidence" },
      ],
    }),
    executionIdentity(),
    undefined,
    turnContext({ tools: registry.definitions() }).turn,
  );

  assert.equal(outcome.kind, "returned");
  assert.equal(successfulSiblingFinished, true);
  assert.deepEqual(outcome.result.members.map((member) => [member.memberId, member.status]), [
    ["attacker", "failed"],
    ["reviewer", "completed"],
  ]);
  assert.deepEqual(tasks.list("parent_session").map((task) => task.status), ["failed", "completed"]);
});

test("adversarial: Team schema rejects ambiguous fallback and duplicate identities", () => {
  const base = teamSnapshot();
  for (const members of [
    base.teams[0].members.map((member) => ({ ...member, fallback: false })),
    base.teams[0].members.map((member) => ({ ...member, fallback: true })),
    [base.teams[0].members[0], { ...base.teams[0].members[1], memberId: "attacker" }],
    [{ ...base.teams[0].members[0], toolNames: ["shared", "shared"] }],
  ]) {
    assert.equal(teamSnapshotSchema.safeParse({
      ...base,
      teams: [{ ...base.teams[0], members }],
    }).success, false);
  }
  assert.equal(teamSnapshotSchema.safeParse({
    ...base,
    teams: [base.teams[0], { ...base.teams[0] }],
  }).success, false);
});

test("adversarial: Subagent event projection rejects reordered, replayed and mutated facts", () => {
  const running = taskEvent(1, "event_1", {
    revision: 1,
    status: "running",
  });
  const completed = taskEvent(2, "event_2", {
    revision: 2,
    status: "completed",
    finalResponse: "done",
    completedAt: NOW,
  });
  assert.equal(projectSubagentTasks("parent_session", [running, completed]).get("task_1")?.status, "completed");

  for (const forged of [
    [{ ...running, sequence: 2 }],
    [running, { ...completed, eventId: "event_1" }],
    [running, { ...completed, task: { ...completed.task, prompt: "mutated" } }],
    [running, { ...completed, task: { ...completed.task, childTurnId: "foreign_turn" } }],
    [running, completed, taskEvent(3, "event_3", { revision: 3, status: "failed" })],
    [{ ...running, parentSessionId: "foreign_parent" }],
  ]) {
    assert.throws(() => projectSubagentTasks("parent_session", forged));
  }
});

function coordinator(registry) {
  return new ToolExecutionCoordinator({
    registry,
    permissions: { request: async () => { throw new Error("unexpected permission"); } },
  });
}

function turnContext({ contextMessages = [], tools = [], metadata = {} } = {}) {
  const request = {
    protocol: "bush.model_request.v1",
    requestId: "parent_request",
    sessionId: "parent_session",
    turnId: "parent_turn",
    model: "fixture-model",
    messages: [],
    tools,
    permissionMode: "task_free",
    metadata,
  };
  return {
    input: {},
    requestId: request.requestId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    turn: { request, contextMessages },
  };
}

function executionIdentity() {
  return {
    requestId: "parent_request",
    sessionId: "parent_session",
    turnId: "parent_turn",
    round: 1,
    ordinal: 0,
  };
}

function toolCall(name, input) {
  return {
    protocol: "bush.tool_call.v1",
    id: `call_${name}`,
    name,
    argumentsText: JSON.stringify(input),
  };
}

function registerFixtureTool(registry, name, visibleToChild) {
  registry.register({
    definition: { name, description: "fixture", inputSchema: { type: "object" } },
    manifest: {
      effect_kind: "observation",
      operation: `fixture.${name}`,
      risk: "low",
      owner: "fixture",
      dispatch_scope: "turn",
      mutating: false,
    },
    visibleToChild,
    decodeInput: (input) => input,
    execute: () => ({}),
  });
}

function childIds() {
  return {
    requestId: "child_request",
    sessionId: "child_session",
    turnId: "child_turn",
    messageId: "child_message",
  };
}

function deterministicIds() {
  return {
    createTaskId: () => "task_1",
    createRequestId: () => "child_request",
    createSessionId: () => "child_session",
    createTurnId: () => "child_turn",
    createMessageId: () => "child_message",
  };
}

function childResult(turnId, finalMessageId, content) {
  return {
    terminal: {
      protocol: "bush.runtime_event.v1",
      eventId: "terminal_event",
      requestId: "child_request",
      sessionId: "child_session",
      turnId,
      sequence: 1,
      createdAt: NOW,
      kind: "turn_terminal",
      payload: {
        status: "completed",
        reason: "model_response_completed",
        finalMessageId,
        details: {},
      },
    },
    session: {
      protocol: "bush.session_snapshot.v1",
      sessionId: "child_session",
      revision: 1,
      createdAt: NOW,
      updatedAt: NOW,
      supersededMessageIds: [],
      turns: [{
        turnId,
        turnSequence: 1,
        createdAt: NOW,
        completedAt: NOW,
        status: "completed",
        reason: "model_response_completed",
        usage: { inputTokens: 5, outputTokens: 2 },
        messages: [{
          messageId: "answer",
          turnId,
          turnSequence: 1,
          messageIndex: 0,
          createdAt: NOW,
          message: { role: "assistant", content, toolCalls: [] },
        }],
      }],
    },
  };
}

function teamSnapshot() {
  return {
    protocol: "bush.team_snapshot.v1",
    snapshotId: "adversarial_teams",
    revision: 1,
    teams: [{
      teamId: "red_team",
      name: "Red Team",
      instructions: "Return facts only.",
      members: [
        {
          memberId: "attacker",
          name: "Attacker",
          role: "adversarial worker",
          instructions: "Attempt the assigned boundary.",
          toolNames: [],
          agentProfileId: "attacker_profile",
          fallback: true,
          skills: [],
          hooks: [],
          guards: [],
          promptInstructions: "",
        },
        {
          memberId: "reviewer",
          name: "Reviewer",
          role: "independent verifier",
          instructions: "Verify independently.",
          toolNames: [],
          agentProfileId: "reviewer_profile",
          fallback: false,
          skills: [],
          hooks: [],
          guards: [],
          promptInstructions: "",
        },
      ],
    }],
  };
}

function taskEvent(sequence, eventId, overrides) {
  const status = overrides.status ?? "running";
  return {
    protocol: "bush.subagent_event.v1",
    eventId,
    sequence,
    parentSessionId: "parent_session",
    taskId: "task_1",
    createdAt: NOW,
    task: {
      protocol: "bush.subagent_task.v1",
      taskId: "task_1",
      parentSessionId: "parent_session",
      parentTurnId: "parent_turn",
      childSessionId: "child_session",
      childTurnId: "child_turn",
      prompt: "bounded task",
      inheritContext: true,
      inheritedMessageCount: 1,
      origin: "subagent",
      phase: "execution",
      status,
      finalResponse: overrides.finalResponse ?? "",
      errorMessage: status === "failed" ? "failed" : "",
      usage: {},
      revision: overrides.revision,
      createdAt: NOW,
      updatedAt: NOW,
      ...(overrides.completedAt ? { completedAt: overrides.completedAt } : {}),
    },
  };
}

const NOW = "2026-09-01T00:00:00.000Z";
