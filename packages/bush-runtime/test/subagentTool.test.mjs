import assert from "node:assert/strict";
import test from "node:test";

import {
  SubagentTaskStore,
  InMemoryRuntimeHost,
  ToolExecutionCoordinator,
  ToolRegistry,
  registerCoordinationTools,
  registerSubagentTool,
} from "../dist/index.js";

test("forks the pre-dispatch context, hides root-only tools and returns user guidance", async () => {
  let childRequest;
  const registry = new ToolRegistry();
  registerCoordinationTools(registry, new (await import("../dist/index.js")).CoordinationStore());
  const tasks = new SubagentTaskStore({ now: () => NOW });
  registerSubagentTool(
    registry,
    tasks,
    async (request) => {
      childRequest = request;
      return childResult(request, "child result");
    },
    deterministicIds(),
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
    model: "fixture-model",
    messages: [],
    tools: registry.definitions(),
    toolChoice: "auto",
    metadata: {
      subagentChildPrefixMessages: [
        { role: "system", content: "child-only system" },
        { role: "user", content: "must be rejected from child prefix" },
      ],
    },
  };
  const contextMessages = [
    { role: "system", content: "root delegation instructions" },
    { role: "user", content: "original objective" },
    { role: "assistant", content: "evidence", toolCalls: [] },
  ];

  const outcome = await coordinator.execute(
    {
      protocol: "bush.tool_call.v1",
      id: "subagent_call",
      name: "subagent",
      argumentsText: JSON.stringify({ prompt: "bounded assignment" }),
    },
    {
      requestId: parentRequest.requestId,
      sessionId: parentRequest.sessionId,
      turnId: parentRequest.turnId,
      round: 1,
      ordinal: 0,
    },
    undefined,
    { request: parentRequest, contextMessages },
  );

  assert.equal(outcome.kind, "completed", JSON.stringify(outcome.result));
  assert.deepEqual(childRequest.prefixMessages.map((message) => message.content), [
    "child-only system",
    "original objective",
    "evidence",
  ]);
  assert.deepEqual(childRequest.inputMessages.map((item) => item.message.content), [
    "bounded assignment",
  ]);
  assert.deepEqual(childRequest.tools.map((tool) => tool.name), ["update_task_plan"]);
  assert.deepEqual(outcome.result.guidance, [{
    role: "user",
    name: "subagent_result",
    content: "child result",
  }]);
  assert.equal(tasks.get("parent_session", "task_1").status, "completed");
});

test("a child Turn cannot invoke a root-only tool even by fabricating its name", async () => {
  let invoked = false;
  const registry = new ToolRegistry();
  registry.register({
    definition: { name: "root_only", description: "", inputSchema: { type: "object" } },
    manifest: manifest(),
    visibleToChild: false,
    decodeInput: (input) => input,
    execute: ({ toolCall, actionManifest }) => {
      invoked = true;
      return success(toolCall.id, actionManifest.manifest_id);
    },
  });
  const coordinator = new ToolExecutionCoordinator({
    registry,
    permissions: { request: async () => { throw new Error("unexpected"); } },
  });
  const outcome = await coordinator.execute(
    { protocol: "bush.tool_call.v1", id: "call_1", name: "root_only", argumentsText: "{}" },
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
        tools: [],
        toolChoice: "auto",
        metadata: {},
      },
      contextMessages: [],
    },
  );
  assert.equal(outcome.result.error.code, "tool_not_exposed");
  assert.equal(invoked, false);
});

test("executes sibling Subagent calls concurrently and reconciles ordered user guidance", async () => {
  let activeChildren = 0;
  let peakChildren = 0;
  let parentFollowup;
  const provider = {
    async *stream(request) {
      const base = {
        protocol: "bush.model_event.v1",
        requestId: request.requestId,
        createdAt: NOW,
      };
      yield { ...base, sequence: 0, kind: "response_started" };
      if (request.sessionId === "parent" && !request.messages.some((message) => message.role === "tool")) {
        for (const [index, prompt] of ["task A", "task B"].entries()) {
          yield {
            ...base,
            sequence: index + 1,
            kind: "tool_call_delta",
            index,
            toolCallId: `call_${index}`,
            nameDelta: "subagent",
            argumentsDelta: JSON.stringify({ prompt }),
          };
        }
        yield { ...base, sequence: 3, kind: "response_completed", finishReason: "tool_calls" };
        return;
      }
      if (request.sessionId.startsWith("subagent_session_")) {
        activeChildren += 1;
        peakChildren = Math.max(peakChildren, activeChildren);
        await new Promise((resolve) => setTimeout(resolve, 15));
        activeChildren -= 1;
        yield {
          ...base,
          sequence: 1,
          kind: "text_delta",
          delta: request.messages.at(-1).content.replace("task", "result"),
        };
        yield { ...base, sequence: 2, kind: "response_completed", finishReason: "stop" };
        return;
      }
      parentFollowup = request;
      yield { ...base, sequence: 1, kind: "text_delta", delta: "reconciled" };
      yield { ...base, sequence: 2, kind: "response_completed", finishReason: "stop" };
    },
  };
  const host = new InMemoryRuntimeHost({ provider });
  const tools = await host.sendCommand({ kind: "runtime.get_tool_catalog", payload: {} });
  const terminal = await host.runModelTurn({
    protocol: "bush.model_request.v1",
    requestId: "parent_request",
    sessionId: "parent",
    turnId: "parent_turn",
    model: "fixture",
    messages: [{ role: "user", content: "original" }],
    tools,
  });

  assert.equal(
    terminal.payload.status,
    "completed",
    JSON.stringify(host.events("parent", "parent_turn"), null, 2),
  );
  assert.equal(peakChildren, 2);
  assert.deepEqual(
    parentFollowup.messages.slice(-4).map((message) => [message.role, message.content]),
    [
      ["tool", parentFollowup.messages.at(-4).content],
      ["tool", parentFollowup.messages.at(-3).content],
      ["user", "result A"],
      ["user", "result B"],
    ],
  );
});

function deterministicIds() {
  return {
    createTaskId: () => "task_1",
    createRequestId: () => "child_request",
    createSessionId: () => "child_session",
    createTurnId: () => "child_turn",
    createMessageId: () => "child_message",
    createReceiptId: () => "receipt_1",
  };
}

function childResult(request, text) {
  return {
    terminal: {
      kind: "turn_terminal",
      payload: {
        status: "completed",
        reason: "model_response_completed",
        finalMessageId: "child_answer",
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
        usage: { inputTokens: 10, outputTokens: 2 },
        messages: [{
          messageId: "child_answer",
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

function manifest() {
  return {
    effect_kind: "observation",
    operation: "fixture",
    risk: "low",
    owner: "fixture",
    dispatch_phase: "execution",
    dispatch_scope: "turn",
    dispatch_side_effect: "none",
    dispatch_mutating: false,
    dispatch_source: "registered_tool",
    stage_modes: ["execute"],
    output_kinds: ["structured_data"],
    handoff_exports: [],
    evidence_hints: [],
  };
}

function success(toolCallId, manifestId) {
  return {
    protocol: "bush.tool_result.v1",
    tool_call_id: toolCallId,
    success: true,
    output: {},
    facts: [{
      protocol: "bush.tool.execution_fact.v1",
      receipt_id: "receipt_root",
      action_manifest_id: manifestId,
      status: "succeeded",
      operation: "fixture",
      effect_kind: "observation",
      owner: "fixture",
      dispatch_scope: "turn",
      categories: [],
      paths: [],
      execution_success: true,
      semantic_success: true,
      verification_state: "verified",
      error_code: "",
    }],
    artifacts: [],
    workspace_changes: [],
    guidance: [],
  };
}

const NOW = "2026-08-29T00:00:00.000Z";
