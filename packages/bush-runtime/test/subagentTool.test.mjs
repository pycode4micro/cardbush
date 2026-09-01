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

test("forks the pre-dispatch context, hides root-only tools and returns the native child result", async () => {
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
    metadata: {
      subagentChildPrefixMessages: [
        { role: "system", content: "child-only system" },
        { role: "user", content: "must be rejected from child prefix" },
      ],
      childAgentPolicy: {
        model: {
          mode: "fixed",
          modelId: "reviewer",
          model: "reviewer-model",
          providerBinding: { bindingId: "binding_reviewer", revision: "1" },
        },
      },
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

  assert.equal(outcome.kind, "returned", JSON.stringify(outcome.result));
  assert.deepEqual(childRequest.prefixMessages.map((message) => message.content), [
    "child-only system",
    "original objective",
    "evidence",
  ]);
  assert.deepEqual(childRequest.inputMessages.map((item) => item.message.content), [
    "bounded assignment",
  ]);
  assert.deepEqual(childRequest.tools.map((tool) => tool.name), ["update_task_plan"]);
  assert.equal(childRequest.model, "reviewer-model");
  assert.equal(childRequest.providerBinding.bindingId, "binding_reviewer");
  assert.equal(childRequest.metadata.childAgentModelId, "reviewer");
  assert.ok(childRequest.metadata.disabledTools.includes("subagent"));
  assert.ok(childRequest.metadata.disabledTools.includes("update_goal"));
  assert.equal(outcome.result.status, "completed");
  assert.equal(outcome.result.finalResponse, "child result");
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
        metadata: {},
      },
      contextMessages: [],
    },
  );
  assert.equal(outcome.error.code, "tool_not_exposed");
  assert.equal(invoked, false);
});

test("freezes the configured parent/child permission route into each child Turn", async () => {
  for (const fixture of [
    {
      policy: { permissionRouting: "user", childPermissionMode: "task_free" },
      parentMode: "all_free",
      expectedMode: "all_free",
      expectedScope: "parent_session",
      expectedRouting: "user",
    },
    {
      policy: { permissionRouting: "parent", childPermissionMode: "user_free" },
      parentMode: "all_free",
      expectedMode: "user_free",
      expectedScope: "child_session",
      expectedRouting: "parent",
    },
    {
      policy: { permissionRouting: "parent", childPermissionMode: "user_free" },
      requestedRouting: "user",
      parentMode: "all_free",
      expectedMode: "all_free",
      expectedScope: "parent_session",
      expectedRouting: "user",
    },
    {
      policy: { permissionRouting: "user", childPermissionMode: "task_free" },
      requestedRouting: "parent",
      parentMode: "all_free",
      expectedMode: "task_free",
      expectedScope: "child_session",
      expectedRouting: "parent",
    },
  ]) {
    let childRequest;
    const registry = new ToolRegistry();
    const tasks = new SubagentTaskStore({ now: () => NOW });
    registerSubagentTool(
      registry,
      tasks,
      async (request) => {
        childRequest = request;
        return childResult(request, "done");
      },
      { ...deterministicIds(), permissionPolicy: fixture.policy },
    );
    const coordinator = new ToolExecutionCoordinator({
      registry,
      permissions: { request: async () => { throw new Error("unexpected permission"); } },
    });
    await coordinator.execute(
      {
        protocol: "bush.tool_call.v1",
        id: "subagent_call",
        name: "subagent",
        argumentsText: JSON.stringify({ prompt: "bounded assignment" }),
      },
      {
        requestId: "parent_request",
        sessionId: "parent_session",
        turnId: "parent_turn",
        round: 1,
        ordinal: 0,
      },
      undefined,
      {
        request: {
          protocol: "bush.model_request.v1",
          requestId: "parent_request",
          sessionId: "parent_session",
          turnId: "parent_turn",
          model: "fixture-model",
          messages: [],
          tools: registry.definitions(),
          permissionMode: fixture.parentMode,
          metadata: fixture.requestedRouting
            ? { subagentPermissionRouting: fixture.requestedRouting }
            : {},
        },
        contextMessages: [],
      },
    );
    assert.equal(childRequest.permissionMode, fixture.expectedMode);
    assert.equal(childRequest.metadata.permissionRouting, fixture.expectedRouting);
    assert.equal(childRequest.metadata.permissionScopeSessionId, fixture.expectedScope);
    assert.equal(childRequest.metadata.permissionEventSessionId, "parent_session");
    assert.equal(childRequest.metadata.permissionEventTurnId, "parent_turn");
  }
});

test("tunnels a child permission request through the active parent Turn", async () => {
  let parentRounds = 0;
  let childRounds = 0;
  const provider = {
    async *stream(request) {
      const base = {
        protocol: "bush.model_event.v1",
        requestId: request.requestId,
        createdAt: NOW,
      };
      yield { ...base, sequence: 0, kind: "response_started" };
      if (request.sessionId === "parent") {
        parentRounds += 1;
        if (parentRounds === 1) {
          yield {
            ...base,
            sequence: 1,
            kind: "tool_call_delta",
            index: 0,
            toolCallId: "dispatch_child",
            nameDelta: "subagent",
            argumentsDelta: JSON.stringify({ prompt: "use guarded tool" }),
          };
          yield { ...base, sequence: 2, kind: "response_completed", finishReason: "tool_calls" };
          return;
        }
        yield { ...base, sequence: 1, kind: "text_delta", delta: "parent reconciled" };
        yield { ...base, sequence: 2, kind: "response_completed", finishReason: "stop" };
        return;
      }
      childRounds += 1;
      if (childRounds === 1) {
        yield {
          ...base,
          sequence: 1,
          kind: "tool_call_delta",
          index: 0,
          toolCallId: "guarded_call",
          nameDelta: "guarded_child_tool",
          argumentsDelta: "{}",
        };
        yield { ...base, sequence: 2, kind: "response_completed", finishReason: "tool_calls" };
        return;
      }
      yield { ...base, sequence: 1, kind: "text_delta", delta: "child completed" };
      yield { ...base, sequence: 2, kind: "response_completed", finishReason: "stop" };
    },
  };
  const registry = new ToolRegistry();
  registry.register({
    definition: { name: "guarded_child_tool", description: "", inputSchema: { type: "object" } },
    manifest: manifest(),
    visibleToChild: true,
    decodeInput: (input) => input,
    authorize: () => ({
      kind: "ask",
      request: {
        reason: "guarded child access",
        actions: ["read"],
        targets: [{ kind: "opaque", value: "fixture://child" }],
        capabilityIds: ["fixture:child"],
      },
    }),
    execute: ({ toolCall, actionManifest }) => success(toolCall.id, actionManifest.manifest_id),
  });
  const host = new InMemoryRuntimeHost({
    provider,
    toolRegistry: registry,
    createPermissionId: () => "permission_child",
    subagentPermissionPolicy: {
      permissionRouting: "parent",
      childPermissionMode: "task_free",
    },
  });
  const tools = await host.sendCommand({ kind: "runtime.get_tool_catalog", payload: {} });
  const running = host.runModelTurn({
    protocol: "bush.model_request.v1",
    requestId: "parent_request",
    sessionId: "parent",
    turnId: "parent_turn",
    model: "fixture",
    messages: [{ role: "user", content: "delegate" }],
    tools,
    permissionMode: "all_free",
  });
  let requested;
  for (let attempt = 0; attempt < 100 && !requested; attempt += 1) {
    requested = host.events("parent", "parent_turn")
      .find((event) => event.kind === "permission_requested");
    if (!requested) await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.ok(requested, "child permission should be visible in the parent event stream");
  assert.equal(requested.payload.permissionRouting, "parent");
  assert.equal(requested.payload.parentSessionId, "parent");
  assert.match(requested.payload.sourceSessionId, /^subagent_session_/);
  await host.sendCommand({
    kind: "runtime.answer_permission",
    payload: {
      protocol: "bush.runtime_permission_answer.v1",
      permissionId: "permission_child",
      answerId: "answer_child",
      decision: "allow_once",
      grantedCapabilityIds: ["fixture:child"],
    },
  });
  const terminal = await running;
  assert.equal(terminal.payload.status, "completed");
  assert.ok(host.events("parent", "parent_turn").some((event) =>
    event.kind === "permission_answered" && event.payload.sourceSessionId?.startsWith("subagent_session_")
  ));
});

test("keeps the parent non-blocking while sibling Subagents run and joins before finalizing", async () => {
  let activeChildren = 0;
  let peakChildren = 0;
  const parentFollowups = [];
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
      parentFollowups.push(request);
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
  assert.equal(parentFollowups.length, 2);
  assert.equal(
    parentFollowups[0].messages.some((message) => message.name === "subagent_result"),
    false,
    "the parent should receive another model round before unfinished children settle",
  );
  const reconciledResults = parentFollowups[1].messages
    .filter((message) => message.name === "subagent_result")
    .map((message) => message.content);
  assert.equal(reconciledResults.length, 2);
  assert.match(reconciledResults[0], /status="completed">\nresult A\n/);
  assert.match(reconciledResults[1], /status="completed">\nresult B\n/);
});

test("lets the parent execute independent work but prevents a terminal commit with an active Subagent", async () => {
  let parentRound = 0;
  let releaseChild;
  const childGate = new Promise((resolve) => { releaseChild = resolve; });
  let markParentWork;
  const parentWorked = new Promise((resolve) => { markParentWork = resolve; });
  let markFinalAttempt;
  const finalAttempted = new Promise((resolve) => { markFinalAttempt = resolve; });
  let reconciledRequest;
  const provider = {
    async *stream(request) {
      const base = {
        protocol: "bush.model_event.v1",
        requestId: request.requestId,
        createdAt: NOW,
      };
      yield { ...base, sequence: 0, kind: "response_started" };
      if (request.sessionId.startsWith("subagent_session_")) {
        await childGate;
        yield { ...base, sequence: 1, kind: "text_delta", delta: "child evidence" };
        yield { ...base, sequence: 2, kind: "response_completed", finishReason: "stop" };
        return;
      }
      parentRound += 1;
      if (parentRound === 1) {
        yield {
          ...base,
          sequence: 1,
          kind: "tool_call_delta",
          index: 0,
          toolCallId: "dispatch_child",
          nameDelta: "subagent",
          argumentsDelta: JSON.stringify({ prompt: "long child task" }),
        };
        yield { ...base, sequence: 2, kind: "response_completed", finishReason: "tool_calls" };
        return;
      }
      if (parentRound === 2) {
        yield {
          ...base,
          sequence: 1,
          kind: "tool_call_delta",
          index: 0,
          toolCallId: "parent_probe_call",
          nameDelta: "parent_probe",
          argumentsDelta: "{}",
        };
        yield { ...base, sequence: 2, kind: "response_completed", finishReason: "tool_calls" };
        return;
      }
      if (parentRound === 3) {
        markFinalAttempt();
        yield { ...base, sequence: 1, kind: "text_delta", delta: "premature final" };
        yield { ...base, sequence: 2, kind: "response_completed", finishReason: "stop" };
        return;
      }
      reconciledRequest = request;
      yield { ...base, sequence: 1, kind: "text_delta", delta: "final after reconciliation" };
      yield { ...base, sequence: 2, kind: "response_completed", finishReason: "stop" };
    },
  };
  const registry = new ToolRegistry();
  registry.register({
    definition: { name: "parent_probe", description: "", inputSchema: { type: "object" } },
    manifest: manifest(),
    parallelSafe: true,
    visibleToChild: false,
    decodeInput: (input) => input,
    execute: ({ toolCall, actionManifest }) => {
      markParentWork();
      return success(toolCall.id, actionManifest.manifest_id);
    },
  });
  const host = new InMemoryRuntimeHost({ provider, toolRegistry: registry });
  const tools = await host.sendCommand({ kind: "runtime.get_tool_catalog", payload: {} });
  let terminalSettled = false;
  const running = host.runModelTurn({
    protocol: "bush.model_request.v1",
    requestId: "parent_request",
    sessionId: "parent",
    turnId: "parent_turn",
    model: "fixture",
    messages: [{ role: "user", content: "delegate and keep working" }],
    tools,
  }).finally(() => { terminalSettled = true; });

  await withTimeout(parentWorked, "parent work stayed blocked behind the child");
  await withTimeout(finalAttempted, "parent did not reach the terminal barrier");
  assert.equal(terminalSettled, false);
  releaseChild();
  const terminal = await running;

  assert.equal(terminal.payload.status, "completed");
  assert.equal(parentRound, 4);
  assert.ok(reconciledRequest.messages.some((message) =>
    message.name === "subagent_result" && message.content.includes("child evidence")
  ));
});

test("joins outstanding children explicitly through await_subagents without polling", async () => {
  let parentRound = 0;
  let releaseChild;
  const childGate = new Promise((resolve) => { releaseChild = resolve; });
  let markAwaitStarted;
  const awaitStarted = new Promise((resolve) => { markAwaitStarted = resolve; });
  let finalRequest;
  const provider = {
    async *stream(request) {
      const base = {
        protocol: "bush.model_event.v1",
        requestId: request.requestId,
        createdAt: NOW,
      };
      yield { ...base, sequence: 0, kind: "response_started" };
      if (request.sessionId.startsWith("subagent_session_")) {
        await childGate;
        yield { ...base, sequence: 1, kind: "text_delta", delta: "joined evidence" };
        yield { ...base, sequence: 2, kind: "response_completed", finishReason: "stop" };
        return;
      }
      parentRound += 1;
      if (parentRound === 1) {
        yield {
          ...base,
          sequence: 1,
          kind: "tool_call_delta",
          index: 0,
          toolCallId: "dispatch_child",
          nameDelta: "subagent",
          argumentsDelta: JSON.stringify({ prompt: "background task" }),
        };
        yield { ...base, sequence: 2, kind: "response_completed", finishReason: "tool_calls" };
        return;
      }
      if (parentRound === 2) {
        markAwaitStarted();
        yield {
          ...base,
          sequence: 1,
          kind: "tool_call_delta",
          index: 0,
          toolCallId: "join_children",
          nameDelta: "await_subagents",
          argumentsDelta: "{}",
        };
        yield { ...base, sequence: 2, kind: "response_completed", finishReason: "tool_calls" };
        return;
      }
      finalRequest = request;
      yield { ...base, sequence: 1, kind: "text_delta", delta: "joined final" };
      yield { ...base, sequence: 2, kind: "response_completed", finishReason: "stop" };
    },
  };
  const host = new InMemoryRuntimeHost({ provider });
  const tools = await host.sendCommand({ kind: "runtime.get_tool_catalog", payload: {} });
  const running = host.runModelTurn({
    protocol: "bush.model_request.v1",
    requestId: "parent_request",
    sessionId: "parent",
    turnId: "parent_turn",
    model: "fixture",
    messages: [{ role: "user", content: "delegate then join" }],
    tools,
  });

  await withTimeout(awaitStarted, "parent did not choose the explicit join tool");
  releaseChild();
  const terminal = await running;

  assert.equal(terminal.payload.status, "completed");
  assert.equal(parentRound, 3);
  assert.ok(finalRequest.messages.some((message) =>
    message.role === "tool" && message.content.includes("joined evidence")
  ));
});

function deterministicIds() {
  return {
    createTaskId: () => "task_1",
    createRequestId: () => "child_request",
    createSessionId: () => "child_session",
    createTurnId: () => "child_turn",
    createMessageId: () => "child_message",
  };
}

async function withTimeout(promise, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 250);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
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
    dispatch_scope: "turn",
    mutating: false,
  };
}

function success(_toolCallId, _manifestId) {
  return {};
}

const NOW = "2026-08-29T00:00:00.000Z";
