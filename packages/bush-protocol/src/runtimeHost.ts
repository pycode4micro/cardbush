import { z } from "zod";

import { cacheChainObservationPayloadSchema } from "./cacheChain.js";
import { toolErrorKindSchema } from "./tool.js";

export const BUSH_RUNTIME_EVENT_PROTOCOL = "bush.runtime_event.v1" as const;
export const BUSH_RUNTIME_CAPABILITIES_PROTOCOL =
  "bush.runtime_capabilities.v1" as const;
export const GET_RUNTIME_CAPABILITIES_COMMAND =
  "runtime.get_capabilities" as const;
export const RUN_MODEL_TURN_COMMAND = "runtime.run_model_turn" as const;
export const ANSWER_RUNTIME_PERMISSION_COMMAND =
  "runtime.answer_permission" as const;
export const SHUTDOWN_RUNTIME_COMMAND = "runtime.shutdown" as const;
export const LIST_RUNTIME_TURN_CONTEXT_COMPACTIONS_COMMAND =
  "runtime.list_turn_context_compactions" as const;
export const BUSH_RUNTIME_PERMISSION_ANSWER_PROTOCOL =
  "bush.runtime_permission_answer.v1" as const;

const runtimePermissionAnswerBaseSchema = z.object({
  protocol: z.literal(BUSH_RUNTIME_PERMISSION_ANSWER_PROTOCOL),
  permissionId: z.string().min(1),
  answerId: z.string().min(1),
});

export const runtimePermissionAnswerSchema = z.discriminatedUnion("decision", [
  runtimePermissionAnswerBaseSchema.extend({
    decision: z.enum(["allow_once", "allow_session"]),
    grantedCapabilityIds: z.array(z.string().min(1)).min(1),
  }),
  runtimePermissionAnswerBaseSchema.extend({
    decision: z.enum(["deny", "cancel"]),
    grantedCapabilityIds: z.array(z.string().min(1)).default([]),
  }),
]);

export type RuntimePermissionAnswer = z.infer<
  typeof runtimePermissionAnswerSchema
>;

export const runtimeEventKindSchema = z.enum([
  "turn_accepted",
  "turn_started",
  "reasoning_segment_started",
  "reasoning_segment_delta",
  "reasoning_segment_completed",
  "assistant_segment_started",
  "assistant_segment_delta",
  "assistant_segment_completed",
  "guidance_applied",
  "tool_queued",
  "tool_running",
  "tool_returned",
  "tool_failed",
  "tool_cancelled",
  "permission_requested",
  "permission_answered",
  "permission_rejected",
  "permission_expired",
  "permission_cancelled",
  "cache_chain_observed",
  "model_request_usage",
  "context_compaction_started",
  "context_compaction_retrying",
  "context_compaction_completed",
  "context_compaction_failed",
  "context_compaction_cancelled",
  "provider_retry",
  "connection_interrupted",
  "stream_resumed",
  "replay_reset",
  "turn_terminal",
]);

export type RuntimeEventKind = z.infer<typeof runtimeEventKindSchema>;

export const runtimeEventCursorSchema = z.object({
  afterSequence: z.number().int().nonnegative().optional(),
  lastEventId: z.string().min(1).optional(),
});

export type RuntimeEventCursorValue = z.infer<typeof runtimeEventCursorSchema>;

const runtimeEventEnvelopeSchema = z.object({
  protocol: z.literal(BUSH_RUNTIME_EVENT_PROTOCOL),
  eventId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  createdAt: z.string().min(1),
});

const segmentIdentitySchema = z.object({
  messageId: z.string().min(1),
  segmentId: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
});

const segmentStartedPayloadSchema = segmentIdentitySchema;
const segmentDeltaPayloadSchema = segmentIdentitySchema.extend({
  delta: z.string(),
});
const segmentCompletedPayloadSchema = segmentIdentitySchema.extend({
  content: z.string(),
});

const toolIdentitySchema = z.object({
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  assistantMessageId: z.string().min(1).optional(),
  display: z
    .object({
      title: z.string().min(1),
      summary: z.string().optional(),
    })
    .optional(),
});

const contextCompactionIdentitySchema = z.object({
  compactionId: z.string().min(1),
  round: z.number().int().positive(),
  attempt: z.number().int().positive(),
  assistantMessageId: z.string().min(1).optional(),
  assistantContentOffset: z.number().int().nonnegative().optional(),
});

const permissionIdentitySchema = z.object({
  permissionId: z.string().min(1),
  toolCallId: z.string().min(1).optional(),
  sourceSessionId: z.string().min(1).optional(),
  sourceTurnId: z.string().min(1).optional(),
  parentSessionId: z.string().min(1).optional(),
  parentTurnId: z.string().min(1).optional(),
  subagentTaskId: z.string().min(1).optional(),
  permissionRouting: z.enum(["user", "parent"]).optional(),
});

export const runtimePermissionTargetSchema = z.object({
  kind: z.enum([
    "filesystem_path",
    "process",
    "network",
    "mcp_resource",
    "opaque",
  ]),
  value: z.string().min(1),
  label: z.string().min(1).optional(),
});

export const runtimePermissionScopeSchema = z.object({
  mode: z.enum(["task_free", "user_free", "all_free"]),
  roots: z.array(z.string().min(1)),
});

export const runtimePermissionRequestSchema = z.object({
  reason: z.string().min(1),
  actions: z.array(z.string().min(1)).min(1),
  targets: z.array(runtimePermissionTargetSchema).min(1),
  requestedCapabilityIds: z.array(z.string().min(1)).min(1),
  scope: runtimePermissionScopeSchema.optional(),
});

export type RuntimePermissionTarget = z.infer<typeof runtimePermissionTargetSchema>;
export type RuntimePermissionScope = z.infer<typeof runtimePermissionScopeSchema>;
export type RuntimePermissionRequest = z.infer<typeof runtimePermissionRequestSchema>;

// Event journals are append-only. Decode the earlier v1 string-resource shape
// at the protocol boundary as opaque targets, without guessing path/process
// semantics. New producers must emit RuntimePermissionRequest directly.
const legacyRuntimePermissionRequestSchema = z.object({
  reason: z.string().min(1),
  actions: z.array(z.string().min(1)).min(1),
  resources: z.array(z.string().min(1)).min(1),
  requestedCapabilityIds: z.array(z.string().min(1)).default([]),
});

const permissionRequestedPayloadSchema = z.union([
  permissionIdentitySchema.merge(runtimePermissionRequestSchema),
  permissionIdentitySchema.merge(legacyRuntimePermissionRequestSchema).transform(
    ({ resources, ...request }) => ({
      ...request,
      targets: resources.map((value) => ({ kind: "opaque" as const, value })),
      scope: undefined,
    }),
  ),
]);

export const runtimeEventSchema = z.discriminatedUnion("kind", [
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("turn_accepted"),
    payload: z.object({ status: z.literal("accepted") }),
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("turn_started"),
    payload: z.object({ status: z.literal("running") }),
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("reasoning_segment_started"),
    payload: segmentStartedPayloadSchema,
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("reasoning_segment_delta"),
    payload: segmentDeltaPayloadSchema,
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("reasoning_segment_completed"),
    payload: segmentCompletedPayloadSchema,
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("assistant_segment_started"),
    payload: segmentStartedPayloadSchema,
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("assistant_segment_delta"),
    payload: segmentDeltaPayloadSchema,
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("assistant_segment_completed"),
    payload: segmentCompletedPayloadSchema,
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("guidance_applied"),
    payload: z.object({
      messageId: z.string().min(1),
      queueDepth: z.number().int().nonnegative(),
      afterRound: z.number().int().positive(),
      previousAssistantMessageId: z.string().min(1).optional(),
    }),
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("tool_queued"),
    payload: toolIdentitySchema,
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("tool_running"),
    payload: toolIdentitySchema,
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("tool_returned"),
    payload: toolIdentitySchema,
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("tool_failed"),
    payload: toolIdentitySchema.extend({
      error: z.object({
        kind: toolErrorKindSchema.default("tool"),
        code: z.string().min(1),
        message: z.string(),
        details: z.record(z.string(), z.unknown()).default({}),
      }),
    }),
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("tool_cancelled"),
    payload: toolIdentitySchema.extend({ reason: z.string().min(1) }),
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("permission_requested"),
    payload: permissionRequestedPayloadSchema,
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("permission_answered"),
    payload: permissionIdentitySchema.extend({
      answerId: z.string().min(1),
      grantedCapabilityIds: z.array(z.string().min(1)),
    }),
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("permission_rejected"),
    payload: permissionIdentitySchema.extend({ reason: z.string().min(1) }),
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("permission_expired"),
    payload: permissionIdentitySchema.extend({ reason: z.string().min(1) }),
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("permission_cancelled"),
    payload: permissionIdentitySchema.extend({ reason: z.string().min(1) }),
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("cache_chain_observed"),
    payload: cacheChainObservationPayloadSchema,
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("model_request_usage"),
    payload: z.object({
      round: z.number().int().positive(),
      attempt: z.number().int().positive(),
      model: z.string().min(1),
      contextWindowTokens: z.number().int().positive().optional(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative().optional(),
      cachedInputTokens: z.number().int().nonnegative().optional(),
      providerResponseId: z.string().min(1).optional(),
      preflightInputTokens: z.number().int().nonnegative().optional(),
      preflightMeasurement: z.enum(["provider", "fallback_estimate"]).optional(),
      usableInputTokens: z.number().int().positive().optional(),
    }),
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("context_compaction_started"),
    payload: contextCompactionIdentitySchema.extend({
      thresholdRatio: z.number().positive(),
      triggerRatio: z.number().nonnegative(),
      estimatedInputTokens: z.number().int().nonnegative(),
      usableInputTokens: z.number().int().positive(),
      measurement: z.enum(["provider", "fallback_estimate"]),
      precedingTurnCount: z.number().int().nonnegative(),
      activeTurnIncluded: z.boolean(),
      activeThroughMessageId: z.string().min(1).optional(),
    }),
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("context_compaction_retrying"),
    payload: contextCompactionIdentitySchema.extend({
      reason: z.string().min(1),
      message: z.string(),
    }),
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("context_compaction_completed"),
    payload: contextCompactionIdentitySchema.extend({
      summarizedTurnCount: z.number().int().nonnegative(),
      activeTurnCheckpointed: z.boolean(),
      activeThroughMessageId: z.string().min(1).optional(),
    }),
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("context_compaction_failed"),
    payload: contextCompactionIdentitySchema.extend({
      reason: z.string().min(1),
      message: z.string(),
    }),
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("context_compaction_cancelled"),
    payload: contextCompactionIdentitySchema.extend({
      reason: z.string().min(1),
    }),
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("provider_retry"),
    payload: z.object({
      attempt: z.number().int().positive(),
      maxAttempts: z.number().int().positive(),
      nextRetryMs: z.number().int().nonnegative(),
      code: z.string().min(1),
      message: z.string(),
    }),
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("connection_interrupted"),
    payload: z.object({
      source: z.string().min(1),
      code: z.string().min(1),
      message: z.string(),
      resumable: z.boolean(),
    }),
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("stream_resumed"),
    payload: z.object({
      afterSequence: z.number().int().nonnegative().optional(),
      lastEventId: z.string().min(1).optional(),
    }),
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("replay_reset"),
    payload: z.object({
      reason: z.string().min(1),
      supersededEventIds: z.array(z.string().min(1)),
    }),
  }),
  runtimeEventEnvelopeSchema.extend({
    kind: z.literal("turn_terminal"),
    payload: z.object({
      status: z.enum([
        "completed",
        "failed",
        "stopped",
        "awaiting_user_action",
      ]),
      reason: z.string().min(1),
      finalMessageId: z.string().min(1).optional(),
      details: z.record(z.string(), z.unknown()).default({}),
    }),
  }),
]);

export type RuntimeEvent = z.infer<typeof runtimeEventSchema>;

export type RuntimeContextCompactionEvent = Extract<
  RuntimeEvent,
  {
    kind:
      | "context_compaction_started"
      | "context_compaction_retrying"
      | "context_compaction_completed"
      | "context_compaction_failed"
      | "context_compaction_cancelled";
  }
>;

export function decodeRuntimeEvent(input: unknown): RuntimeEvent {
  return runtimeEventSchema.parse(input);
}

export const runtimeCapabilitiesSchema = z.object({
  protocol: z.literal(BUSH_RUNTIME_CAPABILITIES_PROTOCOL),
  hostId: z.string().min(1),
  runtimeVersion: z.string().min(1),
  eventProtocol: z.literal(BUSH_RUNTIME_EVENT_PROTOCOL),
  supportedEvents: z.array(runtimeEventKindSchema),
  supportedCommands: z.array(z.string().min(1)),
  features: z.array(z.string().min(1)),
});

export type RuntimeCapabilities = z.infer<typeof runtimeCapabilitiesSchema>;

export function decodeRuntimeCapabilities(input: unknown): RuntimeCapabilities {
  return runtimeCapabilitiesSchema.parse(input);
}
