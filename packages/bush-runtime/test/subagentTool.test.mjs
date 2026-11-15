import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { createProductAgentTurnRequest } from '@cardbush/bush-product-agent';
import { renderPromptTemplate } from '@cardbush/platform/prompts';

import {
  SubagentTaskStore,
  InMemoryRuntimeHost,
  ToolExecutionCoordinator,
  ToolRegistry,
  registerCoordinationTools,
  registerSubagentTool,
} from "../dist/index.js";

for (const clean of [false, true]) test(`ordinary conversation ${clean ? 'recalls clean configuration' : 'delegates with compact defaults'} without a correction round`, async t => {
  const root = await mkdtemp(join(tmpdir(), 'cardbush-clean-delegation-'));
  const registry = new ToolRegistry(), tasks = new SubagentTaskStore(), parents = [], children = [];
  const systemPrompt = 'You independently verify the assigned inventory.';
  const host = new InMemoryRuntimeHost({ dataRoot: root, toolRegistry: registry, subagentTaskStore: tasks,
    provider: { async *stream(request) {
      const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: new Date().toISOString() };
      if (request.metadata.agentRole === 'child') {
        children.push(structuredClone(request));
        yield { ...base, sequence: 0, kind: 'text_delta', delta: 'Inventory verified.' };
        yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'stop' }; return;
      }
      parents.push(structuredClone(request));
      const step = parents.length;
      const args = { prompt: 'Verify the inventory.', name: 'Inventory check', ...(clean ? { mode: 'clean', system_prompt: systemPrompt } : {}) };
      const call = clean && step === 1 ? { name: 'get_tool_schema', input: { name: 'subagent' } }
        : step === (clean ? 2 : 1) ? { name: clean ? 'call_tool' : 'subagent', input: clean ? { name: 'subagent', arguments: args } : args } : undefined;
      if (call) yield { ...base, sequence: 0, kind: 'tool_call_delta', index: 0, toolCallId: `dispatch-${step}`, nameDelta: call.name, argumentsDelta: JSON.stringify(call.input) };
      else yield { ...base, sequence: 0, kind: 'text_delta', delta: 'Dispatched.' };
      yield { ...base, sequence: 1, kind: 'response_completed', finishReason: call ? 'tool_calls' : 'stop' };
    } },
  });
  t.after(async () => {
    await host.sendCommand({ kind: 'runtime.shutdown', payload: {} });
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); await rm(root, { recursive: true, force: true });
  });
  const result = await host.runSessionTurn(createProductAgentTurnRequest({
    requestId: 'ordinary-request', sessionId: 'ordinary', turnId: 'ordinary-turn', messageId: 'ordinary-input', createdAt: new Date().toISOString(),
    userText: 'Delegate the inventory check.', model: 'fixture', tools: registry.definitions(), workspaceDir: root,
    permissionMode: 'task_free', planEnabled: false, individuation: { habits: false, predictions: false },
  }));
  assert.equal(result.payload.status, 'completed', JSON.stringify(result));
  const completionRequests = parents.filter(request => request.messages.some(message => message.name === 'subagent_result'));
  assert.equal(completionRequests.length, 1, 'the child result triggers one normal completion round');
  assert.equal(completionRequests[0].messages.filter(message => message.name === 'subagent_result').length, 1);
  assert.equal(parents.length - completionRequests.length, clean ? 3 : 2, 'schema lookup is the only extra foreground round');
  assert.equal(children.length, 1); assert.equal(tasks.list('ordinary').length, 1);
  assert.equal(parents[0].tools.find(tool => tool.name === 'subagent').inputSchema.properties.mode, undefined);
  assert.ok(parents[0].messages.some(message => message.role === 'system' && message.content.includes(renderPromptTemplate('coordination-tool-boundaries'))));
  assert.deepEqual(parents.at(-1).tools, parents[0].tools);
  if (clean) {
    const receipt = JSON.parse(parents[1].messages.findLast(message => message.role === 'tool').content);
    assert.ok(receipt.matches[0].inputSchema.properties.mode.enum.includes('clean'));
    assert.equal(receipt.matches[0].inputSchema.properties.system_prompt.minLength, 1);
    assert.ok(children[0].messages.some(message => message.role === 'system' && message.content === systemPrompt));
  }
  assert.equal(children[0].metadata.subagentMode, clean ? 'clean' : 'fork');
  assert.ok(!host.events('ordinary', 'ordinary-turn').some(event => event.kind === 'tool_failed'));
});

test("forks the exact pre-dispatch context and tool declarations and returns the native child result", async () => {
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
    "root delegation instructions",
    "original objective",
    "evidence",
  ]);
  assert.deepEqual(childRequest.inputMessages.filter(item => item.message.visibility !== 'internal').map((item) => item.message.content), [
    "You are currently a child Agent.\n\nbounded assignment",
  ]);
  assert.equal(childRequest.inputMessages.at(-1).message.content, 'You are currently a child Agent.\n\nbounded assignment');
  assert.match(childRequest.inputMessages.find(item => item.message.name === 'individuation_preference').message.content,
    /habits disabled; user message prediction disabled/);
  assert.deepEqual(childRequest.tools, parentRequest.tools);
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
      expectedMode: "all_free",
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
      expectedMode: "all_free",
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
    permissionMode: "task_free",
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
  const taskTool = registry.resolve('tasks');
  const readTasks = scope => taskTool.execute({ sessionId: 'parent', turnId: 'parent_turn', input: taskTool.decodeInput({ action: 'list', ...(scope ? { scope } : {}) }) });
  const pendingTask = (await readTasks()).tasks.find(task => task.kind === 'subagent');
  assert.equal(pendingTask.progress.phase, 'waiting_user', 'parent-routed approvals remain visible in child progress');
  assert.equal(pendingTask.progress.active_tool_calls, 1);
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
  assert.equal((await readTasks()).tasks.some(task => task.task_id === pendingTask.task_id), false, 'completed work leaves the default active list');
  assert.equal((await readTasks('all')).tasks.find(task => task.kind === 'subagent').progress.phase, 'completed');
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
          delta: request.messages.at(-1).content.replace(/^You are currently a child Agent.\n\n/, '').replace("task", "result"),
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
  assert.ok(parentFollowups.length >= 2 && parentFollowups.length <= 3);
  assert.equal(
    parentFollowups[0].messages.some((message) => message.name === "subagent_result"),
    false,
    "the parent should receive another model round before unfinished children settle",
  );
  const reconciledResults = parentFollowups.at(-1).messages
    .filter((message) => message.name === "subagent_result")
    .map((message) => message.content);
  assert.equal(reconciledResults.length, 2);
  assert.ok(parentFollowups.at(-1).messages.filter(message => message.name === 'subagent_result')
    .every(message => message.visibility === 'internal'), 'child results reach the model as internal context');
  assert.ok(reconciledResults.some(result => /status="completed">\nresult A\n/.test(result)));
  assert.ok(reconciledResults.some(result => /status="completed">\nresult B\n/.test(result)));
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

test("joins outstanding children explicitly through await without polling", async () => {
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
          nameDelta: "await",
          argumentsDelta: '{}',
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

test('a short child join returns pending so the parent can execute independent work before reconciliation', { timeout: 5000 }, async t => {
  const gate = Promise.withResolvers(), registry = new ToolRegistry(); let rounds = 0, worked = false, childCalls = 0, finalRequest;
  t.after(() => gate.resolve());
  registry.register({ definition: { name: 'independent_step', inputSchema: { type: 'object' } },
    manifest: { effect_kind: 'observation', operation: 'fixture', risk: 'low', owner: 'fixture', dispatch_scope: 'turn', mutating: false },
    decodeInput: value => value, execute: () => { worked = true; gate.resolve(); return 'independent step done'; } });
  const host = new InMemoryRuntimeHost({ toolRegistry: registry, provider: { async *stream(request) {
    const base = { protocol: 'bush.model_event.v1', requestId: request.requestId, createdAt: NOW };
    if (request.sessionId.startsWith('subagent_session_')) {
      childCalls++; await gate.promise; assert.equal(worked, true);
      yield { ...base, sequence: 0, kind: 'text_delta', delta: 'child reconciled' };
      yield { ...base, sequence: 1, kind: 'response_completed', finishReason: 'stop' }; return;
    }
    rounds++;
    const call = rounds === 1 ? { name: 'subagent', args: { prompt: 'independent child' } }
      : rounds === 2 ? { name: 'await', args: { yield_time_ms: 10 } }
      : rounds === 3 ? { name: 'independent_step', args: {} } : undefined;
    if (rounds === 2) {
      const submitted = JSON.parse(request.messages.findLast(message => message.role === 'tool').content);
      assert.equal(submitted.status, 'running'); assert.ok(submitted.taskId);
      assert.equal(submitted.next_step, undefined);
    }
    if (rounds === 3) {
      const joined = JSON.parse(request.messages.findLast(message => message.role === 'tool').content);
      assert.equal(joined.wake_reason, 'yield_timeout'); assert.equal(joined.tasks.filter(task => task.status === 'running').length, 1);
      assert.equal(joined.next_step, undefined);
    }
    if (call) yield { ...base, sequence: 0, kind: 'tool_call_delta', index: 0, toolCallId: `call-${rounds}`, nameDelta: call.name, argumentsDelta: JSON.stringify(call.args) };
    else { finalRequest = request; yield { ...base, sequence: 0, kind: 'text_delta', delta: 'parent done' }; }
    yield { ...base, sequence: 1, kind: 'response_completed', finishReason: call ? 'tool_calls' : 'stop' };
  } } });
  const terminal = await host.runModelTurn({ protocol: 'bush.model_request.v1', requestId: 'parent-request', sessionId: 'parent', turnId: 'parent-turn', model: 'fixture',
    tools: registry.definitions(), messages: [{ role: 'user', content: 'delegate and keep working' }] });
  assert.equal(terminal.payload.status, 'completed', JSON.stringify(terminal));
  assert.equal(worked, true); assert.equal(childCalls, 1);
  assert.equal(finalRequest.messages.filter(message => message.name === 'subagent_result').length, 1);
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
