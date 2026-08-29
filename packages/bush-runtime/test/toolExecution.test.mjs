import assert from "node:assert/strict";
import test from "node:test";

import {
  ANSWER_RUNTIME_PERMISSION_COMMAND,
  BUSH_EXECUTION_FACT_PROTOCOL,
  BUSH_MODEL_EVENT_PROTOCOL,
  BUSH_MODEL_REQUEST_PROTOCOL,
  BUSH_RUNTIME_PERMISSION_ANSWER_PROTOCOL,
  BUSH_TOOL_RESULT_PROTOCOL,
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
  dispatch_phase: "execution",
  dispatch_scope: "turn",
  dispatch_side_effect: "none",
  dispatch_mutating: false,
  dispatch_source: "registered_tool",
  stage_modes: ["execute"],
  output_kinds: ["structured_data"],
  handoff_exports: [],
  evidence_hints: ["observation"],
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
    ["tool_queued", "tool_running", "tool_completed"],
  );
  const completed = events.find((event) => event.kind === "tool_completed");
  assert.deepEqual(completed.payload.receiptIds, ["receipt_call_fixture"]);
  assert.deepEqual(completed.payload.executionFactIds, ["receipt_call_fixture"]);
  assert.equal(provider.requests.length, 2);
  assert.equal(provider.requests[1].messages.at(-2).role, "assistant");
  assert.equal(provider.requests[1].messages.at(-1).role, "tool");
  assert.match(provider.requests[1].messages.at(-1).content, /receipt_call_fixture/);
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

test("accepts effect_complete only when a cited successful manifest declares an effect", async () => {
  const provider = providerWithRounds([
    toolRound(),
    outcomeRound({
      callId: "call_outcome",
      disposition: "effect_complete",
      receiptIds: ["receipt_call_fixture"],
      finalResponse: "effect delivered",
    }),
  ]);
  const registry = registryWithExecution({
    manifest: {
      ...manifest,
      effect_kind: "fixture_effect",
      dispatch_side_effect: "fixture_effect",
      dispatch_mutating: true,
    },
  });
  const host = createHost(provider, registry, { requireOutcomeDeclaration: true });
  const catalog = await host.sendCommand({
    kind: "runtime.get_tool_catalog",
    payload: {},
  });
  const outcomeTool = catalog.find((definition) => definition.name === "declare_turn_outcome");
  assert.ok(outcomeTool);

  const terminal = await host.runModelTurn({
    ...request(),
    tools: [toolDefinition, outcomeTool],
  });

  assert.equal(terminal.payload.status, "completed");
  assert.equal(terminal.payload.reason, "model_declared_effect_complete");
  assert.deepEqual(terminal.payload.details.receiptIds, ["receipt_call_fixture"]);
});

test("rejects effect_complete when cited receipts are observations only", async () => {
  const provider = providerWithRounds([
    toolRound(),
    outcomeRound({
      callId: "call_invalid_outcome",
      disposition: "effect_complete",
      receiptIds: ["receipt_call_fixture"],
      finalResponse: "unsupported effect claim",
    }),
    outcomeRound({
      callId: "call_answer_outcome",
      disposition: "answer",
      receiptIds: [],
      finalResponse: "observation reported",
    }),
  ]);
  const host = createHost(provider, registryWithExecution(), {
    requireOutcomeDeclaration: true,
  });
  const catalog = await host.sendCommand({
    kind: "runtime.get_tool_catalog",
    payload: {},
  });
  const outcomeTool = catalog.find((definition) => definition.name === "declare_turn_outcome");
  assert.ok(outcomeTool);

  const terminal = await host.runModelTurn({
    ...request(),
    tools: [toolDefinition, outcomeTool],
  });
  const failed = host.events("session_tools", "turn_tools")
    .find((event) => event.kind === "tool_failed" && event.payload.toolName === "declare_turn_outcome");

  assert.equal(failed?.payload.error.code, "tool_execution_exception");
  assert.match(failed?.payload.error.message ?? "", /declares an effect/);
  assert.equal(terminal.payload.reason, "model_declared_answer");
});

test("projects only tool-declared Artifact and Workspace Change references", async () => {
  const registry = registryWithExecution({
    execute({ toolCall, actionManifest }) {
      const base = result(toolCall.id, actionManifest);
      return {
        ...base,
        artifacts: [{
          artifact_id: "artifact_fixture",
          type: "image",
          path: "C:\\tmp\\fixture.png",
          media_type: "image/png",
          display: "inline",
          metadata: {},
        }],
        workspace_changes: [{
          change_id: "change_fixture",
          path: "src/fixture.ts",
          status: "modified",
          additions: 2,
          deletions: 1,
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
  const completed = host.events("session_tools", "turn_tools").find(
    (event) => event.kind === "tool_completed",
  );
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

  assert.deepEqual(completed.payload.artifactIds, ["artifact_fixture"]);
  assert.deepEqual(completed.payload.workspaceChangeIds, ["change_fixture"]);
  assert.equal(record.result.artifacts[0].path, "C:\\tmp\\fixture.png");
  assert.equal(listed.length, 1);
});

test("rejects a mismatched Execution Fact instead of trusting tool output prose", async () => {
  const registry = registryWithExecution({
    execute({ toolCall, actionManifest }) {
      return result(toolCall.id, actionManifest, {
        action_manifest_id: "attempt:someone-else",
      });
    },
  });
  const host = createHost(
    providerWithRounds([toolRound(), answerRound("handled")]),
    registry,
  );

  await host.runModelTurn(request());
  const failed = host
    .events("session_tools", "turn_tools")
    .find((event) => event.kind === "tool_failed");

  assert.equal(failed.payload.error.code, "execution_fact_manifest_mismatch");
  assert.deepEqual(failed.payload.receiptIds, []);
});

test("rejects duplicate receipt identities across separate tool executions", async () => {
  const registry = registryWithExecution({
    execute({ toolCall, actionManifest }) {
      return result(toolCall.id, actionManifest, { receipt_id: "receipt_shared" });
    },
  });
  const host = createHost(
    providerWithRounds([twoToolRound(), answerRound("handled")]),
    registry,
  );

  await host.runModelTurn(request());
  const toolEvents = host
    .events("session_tools", "turn_tools")
    .filter((event) => event.kind === "tool_completed" || event.kind === "tool_failed");

  assert.equal(toolEvents[0].kind, "tool_completed");
  assert.equal(toolEvents[1].kind, "tool_failed");
  assert.equal(
    toolEvents[1].payload.error.code,
    "execution_fact_identity_conflict",
  );
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
          resources: ["file:///external/fixture.txt"],
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
          resources: ["file:///external/fixture.txt"],
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
          resources: ["file:///external/fixture.txt"],
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
          resources: ["file:///external/fixture.txt"],
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

function result(toolCallId, actionManifest, factOverrides = {}) {
  return {
    protocol: BUSH_TOOL_RESULT_PROTOCOL,
    tool_call_id: toolCallId,
    success: true,
    output: { value: "fixture-result" },
    facts: [
      {
        protocol: BUSH_EXECUTION_FACT_PROTOCOL,
        receipt_id: `receipt_${toolCallId}`,
        action_manifest_id: actionManifest.manifest_id,
        status: "succeeded",
        operation: actionManifest.operation,
        effect_kind: actionManifest.effect_kind,
        owner: actionManifest.owner,
        dispatch_scope: actionManifest.dispatch_scope,
        categories: ["observation"],
        paths: [],
        execution_success: true,
        semantic_success: true,
        verification_state: "unverified",
        error_code: "",
        ...factOverrides,
      },
    ],
  };
}

function toolRound(overrides = {}) {
  return [
    event(0, "response_started"),
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

function outcomeRound({ callId, disposition, receiptIds, finalResponse }) {
  return [
    event(0, "response_started"),
    event(1, "tool_call_delta", {
      index: 0,
      toolCallId: callId,
      nameDelta: "declare_turn_outcome",
      argumentsDelta: JSON.stringify({
        disposition,
        receipt_ids: receiptIds,
        final_response: finalResponse,
      }),
    }),
    event(2, "response_completed", { finishReason: "tool_calls" }),
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
    requireOutcomeDeclaration: options.requireOutcomeDeclaration,
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
