import assert from "node:assert/strict";
import test from "node:test";

import {
  actionManifestSchema,
  BUSH_CACHE_CHAIN_STATE_PROTOCOL,
  BUSH_SESSION_ENVIRONMENT_PROTOCOL,
  BUSH_ACTION_MANIFEST_PROTOCOL,
  BUSH_MODEL_EVENT_PROTOCOL,
  BUSH_MODEL_REQUEST_PROTOCOL,
  BUSH_MCP_SNAPSHOT_PROTOCOL,
  BUSH_TEAM_SNAPSHOT_PROTOCOL,
  BUSH_RUNTIME_CAPABILITIES_PROTOCOL,
  BUSH_RUNTIME_EVENT_PROTOCOL,
  BUSH_RUNTIME_PERMISSION_ANSWER_PROTOCOL,
  BUSH_RUNTIME_RECOVERY_INSPECTION_PROTOCOL,
  BUSH_RUNTIME_TOOL_CANCEL_RECEIPT_PROTOCOL,
  BUSH_PROVIDER_BINDING_CONFIG_PROTOCOL,
  cacheChainStateSchema,
  coordinationEventSchema,
  createRuntimeGoalRequestSchema,
  decodeRuntimeCapabilities,
  decodeRuntimeEvent,
  decodeSessionEnvironmentFact,
  encodeSessionEnvironmentFact,
  modelEventSchema,
  modelRequestSchema,
  mcpSnapshotSchema,
  runtimePermissionAnswerSchema,
  runtimeRecoveryInspectionSchema,
  runtimeToolCancelReceiptSchema,
  runtimeProviderBindingConfigSchema,
  runtimeProviderBindingResultSchema,
  taskPlanSchema,
  setRuntimePlanRequestSchema,
  subagentTaskSchema,
  teamSnapshotSchema,
  toolExecutionRecordSchema,
  updateRuntimeGoalRequestSchema,
} from "../dist/index.js";

test("session environment facts are structured append-only epochs", () => {
  const encoded = encodeSessionEnvironmentFact({
    protocol: BUSH_SESSION_ENVIRONMENT_PROTOCOL,
    kind: "update",
    localDate: "2026-09-02",
    effectiveAt: "2026-09-02T00:00:00.000Z",
  });
  assert.deepEqual(decodeSessionEnvironmentFact(encoded), {
    protocol: BUSH_SESSION_ENVIRONMENT_PROTOCOL,
    kind: "update",
    localDate: "2026-09-02",
    effectiveAt: "2026-09-02T00:00:00.000Z",
  });
  assert.throws(() => decodeSessionEnvironmentFact(JSON.stringify({
    protocol: BUSH_SESSION_ENVIRONMENT_PROTOCOL,
    kind: "snapshot",
    localDate: "09/02/2026",
    effectiveAt: "2026-09-02T00:00:00.000Z",
  })));
});

test("Tool execution records preserve native results without semantic normalization", () => {
  const base = {
    protocol: "bush.tool.execution_record.v2",
    requestId: "request_1",
    sessionId: "session_1",
    turnId: "turn_1",
    round: 1,
    ordinal: 0,
    recordedAt: "2026-09-01T00:00:00.000Z",
    toolCall: {
      protocol: "bush.tool_call.v1",
      id: "call_consistency",
      name: "fixture",
      argumentsText: "{}",
    },
    outcome: "returned",
    result: { providerField: "preserved", success: false },
    workspaceChanges: [],
  };
  assert.deepEqual(toolExecutionRecordSchema.parse(base).result, base.result);
  assert.throws(() => toolExecutionRecordSchema.parse({
    ...base,
    outcome: "failed",
  }));
  assert.throws(() => toolExecutionRecordSchema.parse({
    ...base,
    error: {
      kind: "tool",
      code: "unexpected_error",
      message: "contradiction",
    },
  }));
});

test("runtime event decoder keeps reasoning separate from assistant content", () => {
  const event = decodeRuntimeEvent({
    protocol: BUSH_RUNTIME_EVENT_PROTOCOL,
    eventId: "evt_1",
    sequence: 3,
    requestId: "req_1",
    sessionId: "session_1",
    turnId: "turn_1",
    createdAt: "2026-08-29T00:00:00.000Z",
    kind: "reasoning_segment_delta",
    payload: {
      messageId: "message_1",
      segmentId: "reasoning_1",
      ordinal: 0,
      delta: "private reasoning",
    },
  });

  assert.equal(event.kind, "reasoning_segment_delta");
  assert.equal(event.payload.delta, "private reasoning");
});

test("runtime guidance application is an explicit delivery fact", () => {
  const event = decodeRuntimeEvent({
    protocol: BUSH_RUNTIME_EVENT_PROTOCOL,
    eventId: "evt_guidance_applied",
    sequence: 4,
    requestId: "req_1",
    sessionId: "session_1",
    turnId: "turn_1",
    createdAt: "2026-08-29T00:00:01.000Z",
    kind: "guidance_applied",
    payload: {
      messageId: "guidance_1",
      queueDepth: 0,
      afterRound: 1,
      previousAssistantMessageId: "message_1",
    },
  });

  assert.equal(event.kind, "guidance_applied");
  assert.equal(event.payload.messageId, "guidance_1");
  assert.equal(event.payload.queueDepth, 0);
});

test("runtime capability decoder rejects undeclared protocol versions", () => {
  assert.throws(() =>
    decodeRuntimeCapabilities({
      protocol: BUSH_RUNTIME_CAPABILITIES_PROTOCOL,
      hostId: "runtime_1",
      runtimeVersion: "0.1.0",
      eventProtocol: "bush.runtime_event.v2",
      supportedEvents: ["turn_terminal"],
      supportedCommands: [],
      features: ["turn_stream"],
    }),
  );
});

test("tool and permission lifecycle facts require stable associations", () => {
  const envelope = {
    protocol: BUSH_RUNTIME_EVENT_PROTOCOL,
    eventId: "evt_lifecycle",
    sequence: 4,
    requestId: "req_1",
    sessionId: "session_1",
    turnId: "turn_1",
    createdAt: "2026-08-29T00:00:00.000Z",
  };
  const completed = decodeRuntimeEvent({
    ...envelope,
    kind: "tool_returned",
    payload: {
      toolCallId: "call_1",
      toolName: "write_file",
      ordinal: 0,
    },
  });
  assert.equal(completed.payload.toolCallId, "call_1");

  const permission = decodeRuntimeEvent({
    ...envelope,
    eventId: "evt_permission_valid",
    kind: "permission_requested",
    payload: {
      permissionId: "permission_1",
      toolCallId: "call_1",
      reason: "outside workspace",
      actions: ["read"],
      targets: [{ kind: "filesystem_path", value: "C:/outside.txt" }],
      requestedCapabilityIds: ["read:C:/outside.txt"],
      scope: { mode: "task_free", roots: ["C:/workspace"] },
    },
  });
  assert.equal(permission.payload.targets[0].kind, "filesystem_path");
  assert.deepEqual(permission.payload.scope.roots, ["C:/workspace"]);

  const historicalPermission = decodeRuntimeEvent({
    ...envelope,
    eventId: "evt_permission_historical",
    kind: "permission_requested",
    payload: {
      permissionId: "permission_legacy",
      reason: "legacy request",
      actions: ["read"],
      resources: ["legacy://resource"],
      requestedCapabilityIds: ["legacy:read"],
    },
  });
  assert.deepEqual(historicalPermission.payload.targets, [{
    kind: "opaque",
    value: "legacy://resource",
  }]);

  assert.throws(() =>
    decodeRuntimeEvent({
      ...envelope,
      eventId: "evt_permission",
      kind: "permission_requested",
      payload: {
        reason: "outside workspace",
        actions: ["read"],
        targets: [{ kind: "filesystem_path", value: "C:/outside.txt" }],
        requestedCapabilityIds: ["read:C:/outside.txt"],
      },
    }),
  );
});

test("action manifests and permission answers enforce only explicit protocol facts", () => {
  const parsed = actionManifestSchema.parse({
    protocol: BUSH_ACTION_MANIFEST_PROTOCOL,
    manifest_id: "attempt:turn_1:1:call_1",
    effect_kind: "observation",
    operation: "fixture.read",
    risk: "low",
    owner: "fixture_runtime",
    dispatch_scope: "turn",
    mutating: false,
  });
  assert.equal(parsed.operation, "fixture.read");

  assert.throws(() =>
    runtimePermissionAnswerSchema.parse({
      protocol: BUSH_RUNTIME_PERMISSION_ANSWER_PROTOCOL,
      permissionId: "permission_1",
      answerId: "answer_1",
      decision: "allow_once",
      grantedCapabilityIds: [],
    }),
  );
});

test("model request keeps provider-independent tool definitions", () => {
  const request = modelRequestSchema.parse({
    protocol: BUSH_MODEL_REQUEST_PROTOCOL,
    requestId: "req_1",
    sessionId: "session_1",
    turnId: "turn_1",
    model: "compatible-model",
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        name: "read_file",
        description: "Read one file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
    ],
  });

  assert.equal(request.tools[0].name, "read_file");

  for (const reasoningEffort of ["none", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal(
      modelRequestSchema.parse({ ...request, reasoningEffort }).reasoningEffort,
      reasoningEffort,
    );
  }
  for (const unsupported of ["minimal", "middle"]) {
    assert.throws(() => modelRequestSchema.parse({ ...request, reasoningEffort: unsupported }));
  }
  const continued = modelRequestSchema.parse({
    ...request,
    providerState: {
      strategy: "response_chain",
      previousResponseId: "resp_1",
      inputMessageOffset: 1,
    },
  });
  assert.equal(continued.providerState.previousResponseId, "resp_1");
  assert.throws(() => modelRequestSchema.parse({
    ...request,
    providerState: {
      strategy: "response_chain",
      previousResponseId: "resp_1",
    },
  }));
});

test("targeted Tool cancellation receipts retain the exact Tool identity", () => {
  const receipt = runtimeToolCancelReceiptSchema.parse({
    protocol: BUSH_RUNTIME_TOOL_CANCEL_RECEIPT_PROTOCOL,
    sessionId: "session_1",
    turnId: "turn_1",
    toolCallId: "call_1",
    accepted: true,
    reason: "tool_cancel_accepted",
  });
  assert.equal(receipt.toolCallId, "call_1");
});

test("model events are transport-neutral and mechanically validated", () => {
  const event = modelEventSchema.parse({
    protocol: BUSH_MODEL_EVENT_PROTOCOL,
    requestId: "req_1",
    sequence: 2,
    createdAt: "2026-08-29T00:00:00.000Z",
    kind: "tool_call_delta",
    index: 0,
    toolCallId: "call_1",
    nameDelta: "read_file",
    argumentsDelta: '{"path":"README.md"}',
  });

  assert.equal(event.kind, "tool_call_delta");
});

test("task plan preserves the reference runtime invariants", () => {
  assert.throws(() =>
    taskPlanSchema.parse({
      protocol: "bush.task_plan.v1",
      plan_id: "plan_1",
      session_id: "session_1",
      nodes: [
        { id: "a", step: "A", status: "in_progress" },
        { id: "b", step: "B", status: "in_progress" },
      ],
      explanation: "",
      active: true,
    }),
  );
});

test("cache chain state contains only structural request hashes", () => {
  const parsed = cacheChainStateSchema.parse({
    protocol: BUSH_CACHE_CHAIN_STATE_PROTOCOL,
    requestOrdinal: 2,
    stableInputDigest: "stable-hash",
    messageDigests: ["message-hash-1", "message-hash-2"],
    taskKind: "code_change",
    toolNames: ["read_file"],
  });

  assert.deepEqual(Object.keys(parsed).sort(), [
    "messageDigests",
    "protocol",
    "requestOrdinal",
    "stableInputDigest",
  ]);
});

test("public recovery inspection never exposes checkpoint messages", () => {
  const parsed = runtimeRecoveryInspectionSchema.parse({
    protocol: BUSH_RUNTIME_RECOVERY_INSPECTION_PROTOCOL,
    sessionId: "session_1",
    turnId: "turn_1",
    status: "resumable",
    reason: "stable_checkpoint_available",
    checkpointSequence: 4,
    nextRound: 2,
    eventsAfterCheckpoint: ["event_5"],
    checkpoint: {
      request: {
        messages: [{ role: "user", content: "private user content" }],
      },
    },
  });

  assert.equal("checkpoint" in parsed, false);
  assert.equal("messages" in parsed, false);
});

test("coordination commands carry explicit identities and revisions", () => {
  const setPlan = setRuntimePlanRequestSchema.parse({
    sessionId: "session_1",
    expectedRevision: 0,
    plan: {
      protocol: "bush.task_plan.v1",
      plan_id: "plan_1",
      session_id: "session_1",
      nodes: [{ id: "node_1", step: "inspect", status: "in_progress" }],
      explanation: "",
      active: true,
    },
  });
  const createGoal = createRuntimeGoalRequestSchema.parse({
    goalId: "goal_1",
    sessionId: "session_1",
    objective: "finish",
  });
  const updateGoal = updateRuntimeGoalRequestSchema.parse({
    goalId: "goal_1",
    sessionId: "session_1",
    expectedRevision: 1,
    status: "active",
    statusReason: "",
    consumedTokens: 0,
    linkedA2ATaskIds: [],
  });

  assert.equal(setPlan.scopeChangeReason, "");
  assert.deepEqual(createGoal.linkedA2ATaskIds, []);
  assert.equal(updateGoal.expectedRevision, 1);
  assert.throws(() => coordinationEventSchema.parse({
    protocol: "bush.coordination_event.v1",
    eventId: "event_1",
    sequence: 0,
    sessionId: "session_1",
    createdAt: "2026-08-29T00:00:00.000Z",
    kind: "goal_set",
    payload: {},
  }));
});

test("Subagent task facts keep parent and child identities explicit", () => {
  const task = subagentTaskSchema.parse({
    protocol: "bush.subagent_task.v1",
    taskId: "task_1",
    parentSessionId: "parent",
    parentTurnId: "parent_turn",
    childSessionId: "child",
    childTurnId: "child_turn",
    prompt: "work",
    inheritContext: true,
    inheritedMessageCount: 2,
    status: "running",
    finalResponse: "",
    errorMessage: "",
    usage: {},
    revision: 1,
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
  });
  assert.equal(task.parentTurnId, "parent_turn");
  assert.throws(() => subagentTaskSchema.parse({ ...task, status: "guessed" }));
});

test("Team snapshots keep Profile constraints and one fallback member explicit", () => {
  const snapshot = teamSnapshotSchema.parse({
    protocol: BUSH_TEAM_SNAPSHOT_PROTOCOL,
    snapshotId: "team-config",
    revision: 1,
    teams: [{
      teamId: "delivery",
      name: "Delivery",
      instructions: "Share verified facts.",
      members: [
        {
          memberId: "builder",
          name: "Builder",
          role: "implementation",
          instructions: "Own the assigned files.",
          toolNames: ["read_file", "edit_file"],
          agentProfileId: "builder",
          fallback: true,
          skills: ["implementation"],
          hooks: [],
          guards: ["verify"],
          promptInstructions: "Return evidence.",
        },
        {
          memberId: "reviewer",
          name: "Reviewer",
          role: "review",
          instructions: "Verify the result.",
          toolNames: ["read_file"],
          agentProfileId: "reviewer",
          fallback: false,
          skills: [],
          hooks: [],
          guards: [],
          promptInstructions: "",
        },
      ],
    }],
  });
  assert.equal(snapshot.teams[0].members[0].fallback, true);
  assert.equal(snapshot.teams[0].members[0].agentProfileId, "builder");
  assert.deepEqual(snapshot.teams[0].members[0].toolNames, ["read_file", "edit_file"]);
  assert.throws(() => teamSnapshotSchema.parse({
    ...snapshot,
    teams: [{ ...snapshot.teams[0], members: [snapshot.teams[0].members[0], snapshot.teams[0].members[0]] }],
  }));
});

test("provider binding commands validate secrets but return only opaque references", () => {
  const config = runtimeProviderBindingConfigSchema.parse({
    protocol: BUSH_PROVIDER_BINDING_CONFIG_PROTOCOL,
    bindingId: "model_config_1",
    adapter: "openai_responses",
    apiKey: "secret-value",
    baseURL: "https://provider.invalid/v1",
  });
  const result = runtimeProviderBindingResultSchema.parse({
    protocol: "bush.provider_binding_result.v1",
    status: "configured",
    binding: { bindingId: config.bindingId, revision: "revision_1" },
    apiKey: config.apiKey,
  });

  assert.equal(config.apiKey, "secret-value");
  assert.equal("apiKey" in result, false);
});

test("MCP snapshots carry explicit transport and Tool policy without task semantics", () => {
  const snapshot = mcpSnapshotSchema.parse({
    protocol: BUSH_MCP_SNAPSHOT_PROTOCOL,
    snapshotId: "product-config",
    revision: 1,
    servers: [{
      id: "desktop_tools",
      transport: {
        kind: "stdio",
        command: "desktop-mcp",
      },
    }],
  });

  assert.equal(snapshot.servers[0].versionMode, "auto");
  assert.equal(snapshot.servers[0].restartBackoffMs, 250);
  assert.equal(snapshot.servers[0].defaultToolPolicy.permission, "ask");
  assert.equal(snapshot.servers[0].defaultToolPolicy.parallelSafe, false);
  assert.throws(() => mcpSnapshotSchema.parse({
    ...snapshot,
    servers: [{ ...snapshot.servers[0], id: "invalid server id" }],
  }));
});
