import { z } from "zod";

import { modelMessageSchema, modelRequestSchema } from "./model.js";

export const BUSH_SESSION_EVENT_PROTOCOL = "bush.session_event.v1" as const;
export const BUSH_SESSION_SNAPSHOT_PROTOCOL = "bush.session_snapshot.v1" as const;
export const BUSH_CONTEXT_SNAPSHOT_PROTOCOL = "bush.context_snapshot.v1" as const;
export const BUSH_SESSION_TURN_REQUEST_PROTOCOL =
  "bush.session_turn_request.v1" as const;
export const GET_RUNTIME_SESSION_COMMAND = "runtime.get_session" as const;
export const RUN_RUNTIME_SESSION_TURN_COMMAND = "runtime.run_session_turn" as const;
export const ASSEMBLE_RUNTIME_SESSION_CONTEXT_COMMAND =
  "runtime.assemble_session_context" as const;

export const sessionTurnStatusSchema = z.enum([
  "completed",
  "failed",
  "stopped",
  "awaiting_user_action",
]);

export const sessionUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
});

export const sessionMessageSchema = z.object({
  messageId: z.string().min(1),
  turnId: z.string().min(1),
  turnSequence: z.number().int().positive(),
  messageIndex: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  message: modelMessageSchema,
});

export type SessionMessage = z.infer<typeof sessionMessageSchema>;

export const committedTurnSchema = z.object({
  turnId: z.string().min(1),
  turnSequence: z.number().int().positive(),
  createdAt: z.string().min(1),
  completedAt: z.string().min(1),
  status: sessionTurnStatusSchema,
  reason: z.string().min(1),
  messages: z.array(sessionMessageSchema).min(1),
  usage: sessionUsageSchema.default({}),
});

export type CommittedTurn = z.infer<typeof committedTurnSchema>;

const sessionEventEnvelopeSchema = z.object({
  protocol: z.literal(BUSH_SESSION_EVENT_PROTOCOL),
  eventId: z.string().min(1),
  sequence: z.number().int().positive(),
  sessionId: z.string().min(1),
  createdAt: z.string().min(1),
});

export const sessionEventSchema = z.discriminatedUnion("kind", [
  sessionEventEnvelopeSchema.extend({
    kind: z.literal("session_created"),
    payload: z.object({}),
  }),
  sessionEventEnvelopeSchema.extend({
    kind: z.literal("turn_committed"),
    payload: committedTurnSchema,
  }),
  sessionEventEnvelopeSchema.extend({
    kind: z.literal("messages_superseded"),
    payload: z.object({
      messageIds: z.array(z.string().min(1)).min(1),
      reason: z.string().min(1),
      replacementTurnId: z.string().min(1).optional(),
    }),
  }),
]);

export type SessionEvent = z.infer<typeof sessionEventSchema>;

export const sessionSnapshotSchema = z.object({
  protocol: z.literal(BUSH_SESSION_SNAPSHOT_PROTOCOL),
  sessionId: z.string().min(1),
  revision: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  turns: z.array(committedTurnSchema),
  supersededMessageIds: z.array(z.string().min(1)),
});

export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>;

export function decodeSessionSnapshot(input: unknown): SessionSnapshot {
  return sessionSnapshotSchema.parse(input);
}

export const contextSnapshotSchema = z.object({
  protocol: z.literal(BUSH_CONTEXT_SNAPSHOT_PROTOCOL),
  sessionId: z.string().min(1),
  sessionRevision: z.number().int().nonnegative(),
  throughTurnSequence: z.number().int().nonnegative(),
  sourceMessageIds: z.array(z.string().min(1)),
  messages: z.array(modelMessageSchema),
});

export type ContextSnapshot = z.infer<typeof contextSnapshotSchema>;

export function decodeContextSnapshot(input: unknown): ContextSnapshot {
  return contextSnapshotSchema.parse(input);
}

export const runtimeSessionIdentitySchema = z.object({
  sessionId: z.string().min(1),
});

export const runtimeSessionInputMessageSchema = z.object({
  messageId: z.string().min(1),
  createdAt: z.string().min(1).optional(),
  message: modelMessageSchema,
});

export const runtimeSessionCheckpointMessageSchema = z.object({
  messageId: z.string().min(1),
  createdAt: z.string().min(1),
  message: modelMessageSchema,
});

export const runtimeSessionCommitCheckpointSchema = z.object({
  turnSequence: z.number().int().positive(),
  createdAt: z.string().min(1),
  initialMessageCount: z.number().int().positive(),
  inputMessages: z.array(runtimeSessionCheckpointMessageSchema).min(1),
  generatedMessages: z.array(runtimeSessionCheckpointMessageSchema).default([]),
  usage: sessionUsageSchema.default({}),
});

export type RuntimeSessionCommitCheckpoint = z.infer<
  typeof runtimeSessionCommitCheckpointSchema
>;

export const runtimeSessionTurnRequestSchema = modelRequestSchema
  .omit({ protocol: true, messages: true })
  .extend({
    protocol: z.literal(BUSH_SESSION_TURN_REQUEST_PROTOCOL),
    prefixMessages: z.array(modelMessageSchema).default([]),
    inputMessages: z.array(runtimeSessionInputMessageSchema).min(1),
  });

export type RuntimeSessionTurnRequest = z.infer<
  typeof runtimeSessionTurnRequestSchema
>;

export const assembleRuntimeSessionContextRequestSchema = z.object({
  sessionId: z.string().min(1),
  prefixMessages: z.array(modelMessageSchema).default([]),
  currentMessages: z.array(modelMessageSchema).default([]),
  throughTurnSequence: z.number().int().nonnegative().optional(),
});
