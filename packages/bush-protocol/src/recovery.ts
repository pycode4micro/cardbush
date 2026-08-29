import { z } from "zod";

import { modelRequestSchema } from "./model.js";
import { cacheChainStateSchema } from "./cacheChain.js";
import { runtimeSessionCommitCheckpointSchema } from "./session.js";

export const BUSH_RUNTIME_CHECKPOINT_PROTOCOL =
  "bush.runtime_checkpoint.v1" as const;
export const BUSH_RUNTIME_RECOVERY_INSPECTION_PROTOCOL =
  "bush.runtime_recovery_inspection.v1" as const;
export const INSPECT_RUNTIME_RECOVERY_COMMAND =
  "runtime.inspect_recovery" as const;
export const RESUME_MODEL_TURN_COMMAND = "runtime.resume_model_turn" as const;
export const STOP_RUNTIME_TURN_COMMAND = "runtime.stop_turn" as const;
export const BUSH_RUNTIME_STOP_RECEIPT_PROTOCOL =
  "bush.runtime_stop_receipt.v1" as const;

export const runtimeTurnIdentitySchema = z.object({
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
});

export type RuntimeTurnIdentity = z.infer<typeof runtimeTurnIdentitySchema>;

export const runtimeStopReceiptSchema = runtimeTurnIdentitySchema.extend({
  protocol: z.literal(BUSH_RUNTIME_STOP_RECEIPT_PROTOCOL),
  accepted: z.boolean(),
  terminal: z.boolean(),
  reason: z.string().min(1),
});

export type RuntimeStopReceipt = z.infer<typeof runtimeStopReceiptSchema>;

export const runtimeCheckpointSchema = z.object({
  protocol: z.literal(BUSH_RUNTIME_CHECKPOINT_PROTOCOL),
  request: modelRequestSchema,
  nextRound: z.number().int().positive(),
  lastEventSequence: z.number().int().nonnegative(),
  lastEventId: z.string().min(1),
  completedReceiptIds: z.array(z.string().min(1)),
  cacheChainState: cacheChainStateSchema,
  sessionCommit: runtimeSessionCommitCheckpointSchema.optional(),
  createdAt: z.string().min(1),
});

export type RuntimeCheckpoint = z.infer<typeof runtimeCheckpointSchema>;

export const runtimeRecoveryInspectionSchema = z.object({
  protocol: z.literal(BUSH_RUNTIME_RECOVERY_INSPECTION_PROTOCOL),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  status: z.enum(["none", "terminal", "resumable", "blocked"]),
  reason: z.string().min(1),
  checkpointSequence: z.number().int().nonnegative().optional(),
  nextRound: z.number().int().positive().optional(),
  eventsAfterCheckpoint: z.array(z.string().min(1)).default([]),
});

export type RuntimeRecoveryInspection = z.infer<
  typeof runtimeRecoveryInspectionSchema
>;
