import assert from "node:assert/strict";
import test from "node:test";

import {
  actionManifestSchema,
  BUSH_CACHE_CHAIN_STATE_PROTOCOL,
  BUSH_ACTION_MANIFEST_PROTOCOL,
  BUSH_MODEL_EVENT_PROTOCOL,
  BUSH_MODEL_REQUEST_PROTOCOL,
  BUSH_RUNTIME_CAPABILITIES_PROTOCOL,
  BUSH_RUNTIME_EVENT_PROTOCOL,
  BUSH_RUNTIME_PERMISSION_ANSWER_PROTOCOL,
  BUSH_RUNTIME_RECOVERY_INSPECTION_PROTOCOL,
  BUSH_PROVIDER_BINDING_CONFIG_PROTOCOL,
  cacheChainStateSchema,
  coordinationEventSchema,
  createRuntimeGoalRequestSchema,
  decodeRuntimeCapabilities,
  decodeRuntimeEvent,
  modelEventSchema,
  modelRequestSchema,
  outcomeFinalizerSchema,
  runtimePermissionAnswerSchema,
  runtimeRecoveryInspectionSchema,
  runtimeProviderBindingConfigSchema,
  runtimeProviderBindingResultSchema,
  taskPlanSchema,
  setRuntimePlanRequestSchema,
  subagentTaskSchema,
  updateRuntimeGoalRequestSchema,
} from "../dist/index.js";

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
    kind: "tool_completed",
    payload: {
      toolCallId: "call_1",
      toolName: "write_file",
      ordinal: 0,
      receiptIds: ["receipt_1"],
      executionFactIds: ["fact_1"],
      artifactIds: [],
      workspaceChangeIds: ["change_1"],
    },
  });
  assert.equal(completed.payload.receiptIds[0], "receipt_1");

  assert.throws(() =>
    decodeRuntimeEvent({
      ...envelope,
      eventId: "evt_permission",
      kind: "permission_requested",
      payload: {
        reason: "outside workspace",
        actions: ["read"],
        resources: ["C:/outside.txt"],
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
    dispatch_phase: "execution",
    dispatch_scope: "turn",
    dispatch_side_effect: "none",
    dispatch_mutating: false,
    dispatch_source: "registered_tool",
    stage_modes: ["execute"],
    output_kinds: ["structured_data"],
    handoff_exports: [],
    evidence_hints: ["observation"],
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

  assert.equal(request.toolChoice, "auto");
  assert.equal(request.tools[0].name, "read_file");
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

test("outcome finalizer accepts only reference statuses", () => {
  assert.throws(() =>
    outcomeFinalizerSchema.parse({
      protocol: "bush.outcome_finalizer.v1",
      status: "guessed_complete",
      result_intent: "deliverable",
      required_evidence: [],
      observed_evidence: [],
      missing_evidence: [],
      blocking_facts: [],
      reason: "",
      required_acceptance: [],
      passed_acceptance: [],
      failed_acceptance: [],
      stale_acceptance: [],
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

test("provider binding commands validate secrets but return only opaque references", () => {
  const config = runtimeProviderBindingConfigSchema.parse({
    protocol: BUSH_PROVIDER_BINDING_CONFIG_PROTOCOL,
    bindingId: "model_config_1",
    adapter: "openai_compatible",
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
