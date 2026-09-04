import assert from "node:assert/strict";
import test from "node:test";

import {
  ANSWER_RUNTIME_PERMISSION_COMMAND,
  BUSH_MODEL_EVENT_PROTOCOL,
  BUSH_MODEL_REQUEST_PROTOCOL,
  BUSH_RUNTIME_GUIDANCE_PROTOCOL,
  BUSH_RUNTIME_PERMISSION_ANSWER_PROTOCOL,
  BUSH_RUNTIME_TOOL_CANCEL_RECEIPT_PROTOCOL,
  CANCEL_RUNTIME_TOOL_COMMAND,
  ENQUEUE_RUNTIME_GUIDANCE_COMMAND,
  GET_RUNTIME_TOOL_EXECUTION_COMMAND,
  LIST_RUNTIME_TURN_TOOL_EXECUTIONS_COMMAND,
} from "@cardbush/bush-protocol";
import { InMemoryRuntimeHost, ToolRegistry } from "../dist/index.js";

const toolDefinition = {
  name: "fixture_tool",
  description: "Returns an explicit fixture result.",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
};

const manifest = {
  effect_kind: "observation",
  operation: "fixture.read",
  risk: "low",
  owner: "fixture_runtime",
  dispatch_scope: "turn",
  mutating: false,
};

test("executes a registered tool and continues the same Turn to a final model response", async () => {
  const provider = providerWithRounds([toolRound(), answerRound("done")]);
  const registry = registryWithExecution();
  const host = createHost(provider, registry);

  const terminal = await host.runModelTurn(request());
  const events = host.events("session_tools", "turn_tools");

  assert.equal(terminal.payload.status, "completed");
  assert.equal(terminal.payload.details.rounds, 2);
  assert.deepEqual(
    events
      .filter((event) => event.kind.startsWith("tool_"))
      .map((event) => event.kind),
    ["tool_queued", "tool_running", "tool_returned"],
  );
  const completed = events.find((event) => event.kind === "tool_returned");
  assert.equal(completed.payload.toolCallId, "call_fixture");
  assert.equal(provider.requests.length, 2);
  assert.deepEqual(provider.requests[0].providerState, {
    strategy: "response_chain",
  });
  assert.deepEqual(provider.requests[1].providerState, {
    strategy: "response_chain",
    previousResponseId: "resp_tool_round",
    inputMessageOffset: 2,
  });
  assert.equal(provider.requests[1].messages.at(-2).role, "assistant");
  assert.equal(provider.requests[1].messages.at(-1).role, "tool");
  assert.match(provider.requests[1].messages.at(-1).content, /fixture-result/);
});

test("cancels one active Tool without stopping the Turn", async () => {
  const provider = providerWithRounds([toolRound(), answerRound("continued")]);
  const registry = registryWithExecution({
    execute(context) {
      return new Promise((_resolve, reject) => {
        const cancel = () => reject(
          context.signal?.reason ?? new DOMException("cancelled", "AbortError"),
        );
        if (context.signal?.aborted) cancel();
        else context.signal?.addEventListener("abort", cancel, { once: true });
      });
    },
  });
  const host = createHost(provider, registry);
  const running = host.runModelTurn(request());
  await waitForEvent(host, "tool_running");

  const receipt = await host.sendCommand({
    kind: CANCEL_RUNTIME_TOOL_COMMAND,
    payload: {
      sessionId: "session_tools",
      turnId: "turn_tools",
      toolCallId: "call_fixture",
    },
  });
  const terminal = await running;

  assert.equal(receipt.protocol, BUSH_RUNTIME_TOOL_CANCEL_RECEIPT_PROTOCOL);
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.reason, "tool_cancel_accepted");
  assert.equal(terminal.payload.status, "completed");
  assert.equal(terminal.payload.reason, "model_response_completed");
  assert.ok(host.events("session_tools", "turn_tools")
    .some((event) => event.kind === "tool_cancelled"));
});

test("isolates non-parallel-safe tools by execution channel", async () => {
  let releaseChrome;
  const chromeGate = new Promise((resolve) => {
    releaseChrome = resolve;
  });
  let fallbackStarted = false;
  const definitions = ["chrome_wait", "computer_fallback"].map((name) => ({
    name,
    description: name,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  }));
  const registry = new ToolRegistry();
  registry.register({
    definition: definitions[0],
    manifest: { ...manifest, operation: "fixture.chrome_wait", owner: "mcp:chrome" },
    parallelSafe: false,
    executionChannel: "mcp:chrome_devtools",
    decodeInput: (input) => input,
    async execute(context) {
      await chromeGate;
      return result(context.toolCall.id, context.actionManifest);
    },
  });
  registry.register({
    definition: definitions[1],
    manifest: { ...manifest, operation: "fixture.computer_fallback", owner: "mcp:apps" },
    parallelSafe: false,
    executionChannel: "mcp:cardbush_apps",
    decodeInput: (input) => input,
    execute(context) {
      fallbackStarted = true;
      releaseChrome();
      return result(context.toolCall.id, context.actionManifest);
    },
  });
  const provider = providerWithRounds([channelToolRound(), answerRound("done")]);
  const host = createHost(provider, registry);
  const terminal = await Promise.race([
    host.runModelTurn({ ...request(), tools: definitions }),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("cross-channel fallback was blocked")),
      500,
    )),
  ]);

  assert.equal(terminal.payload.status, "completed");
  assert.equal(fallbackStarted, true);
  assert.equal(
    host.events("session_tools", "turn_tools")
      .filter((event) => event.kind === "tool_returned").length,
    2,
  );
  assert.deepEqual(
    provider.requests[1].messages.slice(-2).map((message) => message.toolCallId),
    ["call_chrome", "call_fallback"],
    "tool result messages must preserve provider ordinal order",
  );
});

test("does not issue desktop input while another Tool permission is pending", async () => {
  let desktopInputIssued = false;
  const definitions = ["permission_tool", "desktop_tool"].map((name) => ({
    name,
    description: name,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  }));
  const registry = new ToolRegistry();
  registry.register({
    definition: definitions[0],
    manifest: { ...manifest, operation: "fixture.permission", owner: "mcp:permission" },
    executionChannel: "mcp:permission",
    decodeInput: (input) => input,
    authorize() {
      return {
        kind: "ask",
        request: {
          reason: "Allow the fixture operation.",
          actions: ["read"],
          targets: [{ kind: "opaque", value: "fixture://permission" }],
          capabilityIds: ["fixture_permission"],
        },
      };
    },
    execute(context) {
      return result(context.toolCall.id, context.actionManifest);
    },
  });
  registry.register({
    definition: definitions[1],
    manifest: {
      ...manifest,
      effect_kind: "desktop_control",
      operation: "desktop.control",
      risk: "medium",
      owner: "mcp:desktop",
      dispatch_scope: "process",
      mutating: true,
    },
    executionChannel: "mcp:desktop",
    decodeInput: (input) => input,
    execute(context) {
      if (context.signal?.aborted) throw context.signal.reason;
      desktopInputIssued = true;
      return result(context.toolCall.id, context.actionManifest);
    },
  });
  const provider = providerWithRounds([
    twoNamedToolRound("permission_tool", "desktop_tool"),
    answerRound("continued"),
  ]);
  const host = createHost(provider, registry, {
    createPermissionId: () => "permission_desktop_race",
  });
  const running = host.runModelTurn({ ...request(), tools: definitions });
  await waitForEvent(host, "permission_requested");
  await host.sendCommand({
    kind: ANSWER_RUNTIME_PERMISSION_COMMAND,
    payload: {
      protocol: BUSH_RUNTIME_PERMISSION_ANSWER_PROTOCOL,
      permissionId: "permission_desktop_race",
      answerId: "answer_desktop_race",
      decision: "allow_once",
      grantedCapabilityIds: ["fixture_permission"],
    },
  });
  const terminal = await running;
  const events = host.events("session_tools", "turn_tools");

  assert.equal(terminal.payload.status, "completed");
  assert.equal(desktopInputIssued, false);
  assert.ok(events.some((event) =>
    event.kind === "tool_cancelled" && event.payload.toolCallId === "call_second"
  ));
  assert.ok(events.some((event) =>
    event.kind === "tool_returned" && event.payload.toolCallId === "call_first"
  ));
});

test("keeps non-parallel-safe tools serialized inside one execution channel", async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let secondStarted = false;
  const definitions = ["chrome_wait", "computer_fallback"].map((name) => ({
    name,
    description: name,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  }));
  const registry = new ToolRegistry();
  registry.register({
    definition: definitions[0],
    manifest: { ...manifest, operation: "fixture.channel_first" },
    parallelSafe: false,
    executionChannel: "mcp:same_service",
    decodeInput: (input) => input,
    async execute(context) {
      await firstGate;
      return result(context.toolCall.id, context.actionManifest);
    },
  });
  registry.register({
    definition: definitions[1],
    manifest: { ...manifest, operation: "fixture.channel_second" },
    parallelSafe: false,
    executionChannel: "mcp:same_service",
    decodeInput: (input) => input,
    execute(context) {
      secondStarted = true;
      return result(context.toolCall.id, context.actionManifest);
    },
  });
  const host = createHost(
    providerWithRounds([channelToolRound(), answerRound("done")]),
    registry,
  );

  const running = host.runModelTurn({ ...request(), tools: definitions });
  await waitForEvent(host, "tool_running");
  assert.equal(secondStarted, false);
  releaseFirst();
  const terminal = await running;
  assert.equal(terminal.payload.status, "completed");
  assert.equal(secondStarted, true);
});

test("preserves hidden reasoning on assistant tool-call messages for provider replay", async () => {
  const firstRound = toolRound();
  firstRound.splice(1, 0, event(1, "reasoning_delta", {
    delta: "I should use the fixture tool.",
  }));
  firstRound[2].sequence = 2;
  firstRound[3].sequence = 3;
  const provider = providerWithRounds([firstRound, answerRound("done")]);
  const host = createHost(provider, registryWithExecution());

  const terminal = await host.runModelTurn(request());

  assert.equal(terminal.payload.status, "completed");
  assert.equal(
    provider.requests[1].messages.at(-2).reasoningContent,
    "I should use the fixture tool.",
  );
});

test("applies queued user guidance immediately after an in-flight tool round", async () => {
  let releaseTool;
  const toolGate = new Promise((resolve) => {
    releaseTool = resolve;
  });
  const provider = providerWithRounds([toolRound(), answerRound("stopped as guided")]);
  const registry = registryWithExecution({
    async execute(context) {
      await toolGate;
      return result(context.toolCall.id, context.actionManifest);
    },
  });
  const host = createHost(provider, registry);

  const running = host.runModelTurn(request());
  await waitForEvent(host, "tool_running");
  const receipt = await host.sendCommand({
    kind: ENQUEUE_RUNTIME_GUIDANCE_COMMAND,
    payload: {
      protocol: BUSH_RUNTIME_GUIDANCE_PROTOCOL,
      sessionId: "session_tools",
      turnId: "turn_tools",
      messageId: "guidance_stop_now",
      content: "Stop the browser work now; no more actions are needed.",
      createdAt: "2026-08-29T00:00:01.000Z",
    },
  });
  assert.equal(receipt.queueDepth, 1);
  releaseTool();

  const terminal = await running;
  const nextMessages = provider.requests[1].messages;
  assert.equal(terminal.payload.status, "completed");
  assert.deepEqual(nextMessages.slice(-3).map((message) => message.role), [
    "assistant",
    "tool",
    "user",
  ]);
  assert.equal(nextMessages.at(-1).name, "turn_guidance");
  assert.match(nextMessages.at(-1).content, /no more actions/);
  const applied = host.events("session_tools", "turn_tools").find(
    (event) => event.kind === "guidance_applied",
  );
  assert.equal(applied.payload.messageId, "guidance_stop_now");
  assert.equal(applied.payload.queueDepth, 0);
  assert.equal(applied.payload.afterRound, 1);
});

test("returns malformed JSON as one factual tool failure and lets the model recover", async () => {
  let executions = 0;
  const registry = registryWithExecution({
    execute() {
      executions += 1;
      throw new Error("should not execute");
    },
  });
  const provider = providerWithRounds([
    toolRound({ argumentsText: '{"value":' }),
    answerRound("recovered"),
  ]);
  const host = createHost(provider, registry);

  const terminal = await host.runModelTurn(request());
  const failed = host
    .events("session_tools", "turn_tools")
    .find((event) => event.kind === "tool_failed");

  assert.equal(terminal.payload.status, "completed");
  assert.equal(executions, 0);
  assert.equal(failed.payload.error.code, "tool_arguments_invalid_json");
  assert.doesNotMatch(failed.payload.error.message, /fixture_tool/);
});

test("stores native tool output and Runtime-owned workspace changes separately", async () => {
  const registry = registryWithExecution({
    execute({ recordWorkspaceChange }) {
      recordWorkspaceChange({
        change_id: "change_fixture",
        path: "src/fixture.ts",
        status: "modified",
        additions: 2,
        deletions: 1,
        metadata: { diff: "@@ -1 +1 @@\n-old\n+new" },
      });
      return {
        value: "fixture-result",
        artifacts: [{
          artifact_id: "artifact_fixture",
          type: "image",
          path: "C:\\tmp\\fixture.png",
          media_type: "image/png",
          display: "inline",
          metadata: {},
        }],
      };
    },
  });
  const host = createHost(
    providerWithRounds([toolRound(), answerRound("done")]),
    registry,
  );
  await host.runModelTurn(request());
  const record = await host.sendCommand({
    kind: GET_RUNTIME_TOOL_EXECUTION_COMMAND,
    payload: {
      sessionId: "session_tools",
      turnId: "turn_tools",
      toolCallId: "call_fixture",
    },
  });
  const listed = await host.sendCommand({
    kind: LIST_RUNTIME_TURN_TOOL_EXECUTIONS_COMMAND,
    payload: { sessionId: "session_tools", turnId: "turn_tools" },
  });
  const summaries = await host.sendCommand({
    kind: LIST_RUNTIME_TURN_TOOL_EXECUTIONS_COMMAND,
    payload: {
      sessionId: "session_tools",
      turnId: "turn_tools",
      detail: "summary",
    },
  });

  assert.equal(record.result.artifacts[0].path, "C:\\tmp\\fixture.png");
  assert.deepEqual(record.workspaceChanges.map((change) => change.change_id), ["change_fixture"]);
  assert.match(record.workspaceChanges[0].metadata.diff, /\+new/);
  assert.equal(listed.length, 1);
  assert.deepEqual(summaries, [{
    protocol: "bush.tool_execution_summary.v1",
    requestId: record.requestId,
    sessionId: record.sessionId,
    turnId: record.turnId,
    round: record.round,
    ordinal: record.ordinal,
    recordedAt: record.recordedAt,
    toolCall: {
      protocol: record.toolCall.protocol,
      id: record.toolCall.id,
      name: record.toolCall.name,
    },
    outcome: "returned",
    actionManifest: record.actionManifest,
    resultAvailable: true,
    workspaceChanges: [{
      change_id: "change_fixture",
      path: "src/fixture.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
      detailAvailable: true,
    }],
    error: undefined,
  }]);
});

test("archives only the model projection while retaining the complete native result", async () => {
  const largeText = "原生结果-😀-".repeat(3_000);
  const registry = registryWithExecution({
    execute() {
      return {
        content: largeText,
        semantic_success: false,
        nested: { retained: true },
      };
    },
  });
  const provider = providerWithRounds([toolRound(), answerRound("read archive if needed")]);
  const host = createHost(provider, registry);

  await host.runModelTurn(request());
  const record = await host.sendCommand({
    kind: GET_RUNTIME_TOOL_EXECUTION_COMMAND,
    payload: { sessionId: "session_tools", turnId: "turn_tools", toolCallId: "call_fixture" },
  });
  const projected = JSON.parse(provider.requests[1].messages.at(-1).content);

  assert.equal(record.outcome, "returned");
  assert.equal(record.result.content, largeText);
  assert.equal(record.result.semantic_success, false);
  assert.equal(projected.archived, true);
  assert.match(projected.locator, /^tool-result:\/\/session_tools\/turn_tools\/call_fixture$/);
  assert.ok(projected.originalChars > 16_000);
  assert.ok(projected.preview.length < projected.originalChars);
});

test("preserves tool-owned fields without applying Runtime semantic validation", async () => {
  const registry = registryWithExecution({
    execute() {
      return {
        action_manifest_id: "attempt:someone-else",
        execution_success: false,
        semantic_success: true,
        verification_state: "verified",
      };
    },
  });
  const host = createHost(
    providerWithRounds([toolRound(), answerRound("handled")]),
    registry,
  );

  await host.runModelTurn(request());
  const record = await host.sendCommand({
    kind: GET_RUNTIME_TOOL_EXECUTION_COMMAND,
    payload: { sessionId: "session_tools", turnId: "turn_tools", toolCallId: "call_fixture" },
  });
  assert.equal(record.outcome, "returned");
  assert.equal(record.result.action_manifest_id, "attempt:someone-else");
  assert.equal(record.result.execution_success, false);
  assert.equal(record.result.semantic_success, true);
});

test("classifies handler rejections as Tool failures with stable codes", async () => {
  const registry = registryWithExecution({
    execute() {
      throw Object.assign(new Error("The requested edit target is stale."), {
        code: "edit_old_text_not_found",
      });
    },
  });
  const host = createHost(
    providerWithRounds([toolRound(), answerRound("recovered")]),
    registry,
  );

  await host.runModelTurn(request());
  const failed = host
    .events("session_tools", "turn_tools")
    .find((event) => event.kind === "tool_failed");

  assert.equal(failed.payload.error.kind, "tool");
  assert.equal(failed.payload.error.code, "edit_old_text_not_found");
});

test("does not interpret duplicate identities inside native tool results", async () => {
  const registry = registryWithExecution({
    execute() {
      return { receipt_id: "receipt_shared" };
    },
  });
  const host = createHost(
    providerWithRounds([twoToolRound(), answerRound("handled")]),
    registry,
  );

  await host.runModelTurn(request());
  const toolEvents = host
    .events("session_tools", "turn_tools")
    .filter((event) => event.kind === "tool_returned" || event.kind === "tool_failed");

  assert.equal(toolEvents[0].kind, "tool_returned");
  assert.equal(toolEvents[1].kind, "tool_returned");
});

test("rejects invalid input against the registration decoder without invoking admission", async () => {
  let admissions = 0;
  const registry = registryWithExecution({
    authorize() {
      admissions += 1;
      return { kind: "allow" };
    },
  });
  const host = createHost(
    providerWithRounds([
      toolRound({ argumentsText: '{"value":42}' }),
      answerRound("corrected"),
    ]),
    registry,
  );

  await host.runModelTurn(request());
  const failed = host
    .events("session_tools", "turn_tools")
    .find((event) => event.kind === "tool_failed");

  assert.equal(admissions, 0);
  assert.equal(failed.payload.error.code, "tool_arguments_schema_invalid");
  assert.equal(failed.payload.error.kind, "protocol");
});

test("rejects incomplete manifests when a tool is registered", () => {
  assert.throws(() =>
    new ToolRegistry().register({
      definition: toolDefinition,
      manifest: { ...manifest, owner: "" },
      decodeInput: (input) => input,
      execute() {
        throw new Error("not reached");
      },
    }),
  );
});

test("requires an explicit permission answer before running a protected tool", async () => {
  let executionCapabilities;
  const registry = registryWithExecution({
    authorize() {
      return {
        kind: "ask",
        request: {
          reason: "Read the selected external fixture.",
          actions: ["read"],
          targets: [{ kind: "filesystem_path", value: "file:///external/fixture.txt" }],
          capabilityIds: ["capability_fixture"],
        },
      };
    },
    execute(context) {
      executionCapabilities = context.capabilityIds;
      return result(context.toolCall.id, context.actionManifest);
    },
  });
  const host = createHost(
    providerWithRounds([toolRound(), answerRound("granted")]),
    registry,
    { createPermissionId: () => "permission_fixture" },
  );

  const running = host.runModelTurn(request());
  await waitForEvent(host, "permission_requested");
  await assert.rejects(
    host.sendCommand({
      kind: ANSWER_RUNTIME_PERMISSION_COMMAND,
      payload: {
        protocol: BUSH_RUNTIME_PERMISSION_ANSWER_PROTOCOL,
        permissionId: "permission_fixture",
        answerId: "answer_wrong",
        decision: "allow_once",
        grantedCapabilityIds: ["capability_wrong"],
      },
    }),
    /exactly the requested capabilities/,
  );
  await host.sendCommand({
    kind: ANSWER_RUNTIME_PERMISSION_COMMAND,
    payload: {
      protocol: BUSH_RUNTIME_PERMISSION_ANSWER_PROTOCOL,
      permissionId: "permission_fixture",
      answerId: "answer_fixture",
      decision: "allow_once",
      grantedCapabilityIds: ["capability_fixture"],
    },
  });
  const terminal = await running;
  const events = host.events("session_tools", "turn_tools");

  assert.equal(terminal.payload.status, "completed");
  assert.deepEqual(executionCapabilities, ["capability_fixture"]);
  assert.deepEqual(
    events.find((event) => event.kind === "permission_requested").payload.requestedCapabilityIds,
    ["capability_fixture"],
  );
  assert.ok(events.find((event) => event.kind === "permission_answered"));
  assert.ok(events.find((event) => event.kind === "tool_running"));
});

test("a rejected permission never invokes the tool handler", async () => {
  let executions = 0;
  const registry = registryWithExecution({
    authorize() {
      return {
        kind: "ask",
        request: {
          reason: "Read the selected external fixture.",
          actions: ["read"],
          targets: [{ kind: "filesystem_path", value: "file:///external/fixture.txt" }],
          capabilityIds: ["capability_fixture"],
        },
      };
    },
    execute(context) {
      executions += 1;
      return result(context.toolCall.id, context.actionManifest);
    },
  });
  const host = createHost(
    providerWithRounds([toolRound(), answerRound("denied")]),
    registry,
    { createPermissionId: () => "permission_denied" },
  );

  const running = host.runModelTurn(request());
  await waitForEvent(host, "permission_requested");
  await host.sendCommand({
    kind: ANSWER_RUNTIME_PERMISSION_COMMAND,
    payload: {
      protocol: BUSH_RUNTIME_PERMISSION_ANSWER_PROTOCOL,
      permissionId: "permission_denied",
      answerId: "answer_denied",
      decision: "deny",
    },
  });
  await running;
  const events = host.events("session_tools", "turn_tools");

  assert.equal(executions, 0);
  assert.ok(events.find((event) => event.kind === "permission_rejected"));
  assert.equal(
    events.find((event) => event.kind === "tool_failed").payload.error.code,
    "permission_rejected",
  );
  assert.equal(
    events.find((event) => event.kind === "tool_failed").payload.error.kind,
    "permission",
  );
});

test("reuses allow_session only for the exact capability in the same Session", async () => {
  let permissions = 0;
  let executions = 0;
  const registry = registryWithExecution({
    authorize() {
      return {
        kind: "ask",
        request: {
          reason: "Read the selected external fixture.",
          actions: ["read"],
          targets: [{ kind: "filesystem_path", value: "file:///external/fixture.txt" }],
          capabilityIds: ["capability_fixture"],
        },
      };
    },
    execute(context) {
      executions += 1;
      return result(context.toolCall.id, context.actionManifest);
    },
  });
  const provider = {
    async *stream(modelRequest) {
      const events = modelRequest.messages.at(-1)?.role === "tool"
        ? answerRound("done")
        : toolRound();
      for (const candidate of events) {
        yield {
          ...candidate,
          requestId: modelRequest.requestId,
          ...(candidate.kind === "tool_call_delta"
            ? { toolCallId: `call_fixture_${modelRequest.turnId}` }
            : {}),
        };
      }
    },
  };
  const host = createHost(provider, registry, {
    createPermissionId: () => `permission_${++permissions}`,
  });
  const first = host.runModelTurn(request());
  await waitForEvent(host, "permission_requested");
  await host.sendCommand({
    kind: ANSWER_RUNTIME_PERMISSION_COMMAND,
    payload: {
      protocol: BUSH_RUNTIME_PERMISSION_ANSWER_PROTOCOL,
      permissionId: "permission_1",
      answerId: "answer_session",
      decision: "allow_session",
      grantedCapabilityIds: ["capability_fixture"],
    },
  });
  await first;
  await host.runModelTurn({
    ...request(),
    requestId: "request_tools_2",
    turnId: "turn_tools_2",
  });
  assert.equal(permissions, 1);
  assert.equal(executions, 2);
  assert.equal(
    host.events("session_tools", "turn_tools_2").some((event) => event.kind === "permission_requested"),
    false,
  );
});

test("cancelling while permission is pending closes both permission and Turn facts", async () => {
  const controller = new AbortController();
  const registry = registryWithExecution({
    authorize() {
      return {
        kind: "ask",
        request: {
          reason: "Read the selected external fixture.",
          actions: ["read"],
          targets: [{ kind: "filesystem_path", value: "file:///external/fixture.txt" }],
          capabilityIds: ["capability_fixture"],
        },
      };
    },
  });
  const host = createHost(providerWithRounds([toolRound()]), registry, {
    createPermissionId: () => "permission_cancelled",
  });

  const running = host.runModelTurn(request(), { signal: controller.signal });
  await waitForEvent(host, "permission_requested");
  controller.abort();
  const terminal = await running;
  const events = host.events("session_tools", "turn_tools");

  assert.equal(terminal.payload.status, "stopped");
  assert.ok(events.find((event) => event.kind === "permission_cancelled"));
  assert.ok(events.find((event) => event.kind === "tool_cancelled"));
});

test("full control bypasses permission asks while preserving capability facts", async () => {
  let executionCapabilities;
  const registry = registryWithExecution({
    authorize() {
      return {
        kind: "ask",
        request: {
          reason: "Use the protected fixture.",
          actions: ["execute"],
          targets: [{ kind: "opaque", value: "fixture" }],
          capabilityIds: ["capability_fixture"],
        },
      };
    },
    execute(context) {
      executionCapabilities = context.capabilityIds;
      return result(context.toolCall.id, context.actionManifest);
    },
  });
  const host = createHost(
    providerWithRounds([toolRound(), answerRound("done")]),
    registry,
  );

  const terminal = await host.runModelTurn({
    ...request(),
    permissionMode: "all_free",
  });
  const events = host.events("session_tools", "turn_tools");

  assert.equal(terminal.payload.status, "completed");
  assert.deepEqual(executionCapabilities, ["capability_fixture"]);
  assert.equal(events.some((event) => event.kind === "permission_requested"), false);
  assert.ok(events.some((event) => event.kind === "tool_running"));
});

test("full control never overrides a hard admission denial", async () => {
  let executions = 0;
  const registry = registryWithExecution({
    authorize() {
      return {
        kind: "deny",
        code: "permanent_safety_denial",
        message: "This operation is permanently denied.",
      };
    },
    execute() {
      executions += 1;
      return {};
    },
  });
  const host = createHost(
    providerWithRounds([toolRound(), answerRound("done")]),
    registry,
  );

  await host.runModelTurn({
    ...request(),
    permissionMode: "all_free",
  });
  const events = host.events("session_tools", "turn_tools");

  assert.equal(executions, 0);
  assert.equal(events.some((event) => event.kind === "permission_requested"), false);
  assert.equal(
    events.find((event) => event.kind === "tool_failed")?.payload.error.code,
    "permanent_safety_denial",
  );
});

test("Stop settles an uncooperative Tool without waiting for its Promise", async () => {
  const registry = registryWithExecution({
    async execute() {
      await new Promise(() => {});
    },
  });
  const host = createHost(providerWithRounds([toolRound()]), registry);
  const running = host.runModelTurn(request());
  await waitForEvent(host, "tool_running");

  const receipt = await host.sendCommand({
    kind: "runtime.stop_turn",
    payload: { sessionId: "session_tools", turnId: "turn_tools" },
  });
  const terminal = await Promise.race([
    running,
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("Stop remained blocked by an uncooperative Tool.")),
      1_000,
    )),
  ]);
  const events = host.events("session_tools", "turn_tools");

  assert.equal(receipt.accepted, true);
  assert.equal(terminal.payload.status, "stopped");
  assert.equal(events.filter((event) => event.kind === "tool_cancelled").length, 1);
  assert.equal(events.at(-1).kind, "turn_terminal");
});

test("targeted Tool cancellation closes its pending permission and continues the Turn", async () => {
  const registry = registryWithExecution({
    authorize() {
      return {
        kind: "ask",
        request: {
          reason: "Control the selected desktop application.",
          actions: ["control"],
          targets: [{ kind: "process", value: "desktop://current" }],
          capabilityIds: ["desktop_control"],
        },
      };
    },
  });
  const host = createHost(
    providerWithRounds([toolRound(), answerRound("continued")]),
    registry,
    { createPermissionId: () => "permission_targeted_cancel" },
  );
  const running = host.runModelTurn(request());
  await waitForEvent(host, "permission_requested");

  const receipt = await host.sendCommand({
    kind: CANCEL_RUNTIME_TOOL_COMMAND,
    payload: {
      sessionId: "session_tools",
      turnId: "turn_tools",
      toolCallId: "call_fixture",
    },
  });
  const terminal = await running;
  const events = host.events("session_tools", "turn_tools");

  assert.equal(receipt.accepted, true);
  assert.equal(terminal.payload.status, "completed");
  assert.ok(events.some((event) => event.kind === "permission_cancelled"));
  assert.ok(events.some((event) => event.kind === "tool_cancelled"));
  assert.equal(events.at(-1).kind, "turn_terminal");
});

test("rejects permission answers that do not grant a concrete capability", async () => {
  const host = createHost(providerWithRounds([]), new ToolRegistry());
  await assert.rejects(
    host.sendCommand({
      kind: ANSWER_RUNTIME_PERMISSION_COMMAND,
      payload: {
        protocol: BUSH_RUNTIME_PERMISSION_ANSWER_PROTOCOL,
        permissionId: "permission_missing",
        answerId: "answer_missing",
        decision: "allow_once",
        grantedCapabilityIds: [],
      },
    }),
  );
});

function request() {
  return {
    protocol: BUSH_MODEL_REQUEST_PROTOCOL,
    requestId: "request_tools",
    sessionId: "session_tools",
    turnId: "turn_tools",
    model: "fixture-model",
    messages: [{ role: "user", content: "Use the fixture and report the result." }],
    tools: [toolDefinition],
  };
}

function registryWithExecution(overrides = {}) {
  return new ToolRegistry().register({
    definition: toolDefinition,
    manifest: overrides.manifest ?? manifest,
    decodeInput(input) {
      if (!input || typeof input !== "object" || typeof input.value !== "string") {
        throw new Error("value must be a string");
      }
      return { value: input.value };
    },
    authorize: overrides.authorize,
    execute:
      overrides.execute ??
      ((context) => result(context.toolCall.id, context.actionManifest)),
  });
}

function result(_toolCallId, _actionManifest, overrides = {}) {
  return { value: "fixture-result", ...overrides };
}

function toolRound(overrides = {}) {
  return [
    event(0, "response_started", { providerResponseId: "resp_tool_round" }),
    event(1, "tool_call_delta", {
      index: 0,
      toolCallId: "call_fixture",
      nameDelta: "fixture_tool",
      argumentsDelta: overrides.argumentsText ?? '{"value":"fixture"}',
    }),
    event(2, "response_completed", { finishReason: "tool_calls" }),
  ];
}

function answerRound(text) {
  return [
    event(0, "response_started"),
    event(1, "text_delta", { delta: text }),
    event(2, "response_completed", { finishReason: "stop" }),
  ];
}

function twoToolRound() {
  return [
    event(0, "response_started"),
    event(1, "tool_call_delta", {
      index: 0,
      toolCallId: "call_first",
      nameDelta: "fixture_tool",
      argumentsDelta: '{"value":"first"}',
    }),
    event(2, "tool_call_delta", {
      index: 1,
      toolCallId: "call_second",
      nameDelta: "fixture_tool",
      argumentsDelta: '{"value":"second"}',
    }),
    event(3, "response_completed", { finishReason: "tool_calls" }),
  ];
}

function twoNamedToolRound(firstName, secondName) {
  return [
    event(0, "response_started"),
    event(1, "tool_call_delta", {
      index: 0,
      toolCallId: "call_first",
      nameDelta: firstName,
      argumentsDelta: "{}",
    }),
    event(2, "tool_call_delta", {
      index: 1,
      toolCallId: "call_second",
      nameDelta: secondName,
      argumentsDelta: "{}",
    }),
    event(3, "response_completed", { finishReason: "tool_calls" }),
  ];
}

function channelToolRound() {
  return [
    event(0, "response_started"),
    event(1, "tool_call_delta", {
      index: 0,
      toolCallId: "call_chrome",
      nameDelta: "chrome_wait",
      argumentsDelta: "{}",
    }),
    event(2, "tool_call_delta", {
      index: 1,
      toolCallId: "call_fallback",
      nameDelta: "computer_fallback",
      argumentsDelta: "{}",
    }),
    event(3, "response_completed", { finishReason: "tool_calls" }),
  ];
}

function event(sequence, kind, fields = {}) {
  return {
    protocol: BUSH_MODEL_EVENT_PROTOCOL,
    requestId: "request_tools",
    sequence,
    createdAt: "2026-08-29T00:00:00.000Z",
    kind,
    ...fields,
  };
}

function providerWithRounds(rounds) {
  let index = 0;
  return {
    requests: [],
    async *stream(modelRequest) {
      this.requests.push(structuredClone(modelRequest));
      yield* rounds[index++] ?? [];
    },
  };
}

function createHost(provider, registry, options = {}) {
  return new InMemoryRuntimeHost({
    provider,
    toolRegistry: registry,
    createPermissionId: options.createPermissionId,
    eventLogOptions: {
      createEventId: ({ turnId, sequence }) => `event_${turnId}_${sequence}`,
      now: () => "2026-08-29T00:00:00.000Z",
    },
    projectorOptions: {
      createMessageId: counter("message"),
      createSegmentId: counter("segment"),
    },
  });
}

async function waitForEvent(host, kind) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const found = host
      .events("session_tools", "turn_tools")
      .find((event) => event.kind === kind);
    if (found) return found;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${kind}.`);
}

function counter(prefix) {
  let value = 0;
  return () => `${prefix}_${++value}`;
}
