import { z } from "zod";

export const ENQUEUE_RUNTIME_GUIDANCE_COMMAND =
  "runtime.enqueue_guidance" as const;
export const BUSH_RUNTIME_GUIDANCE_PROTOCOL =
  "bush.runtime_guidance.v1" as const;

export const runtimeGuidanceRequestSchema = z.object({
  protocol: z.literal(BUSH_RUNTIME_GUIDANCE_PROTOCOL),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  messageId: z.string().min(1),
  content: z.string().trim().min(1),
  createdAt: z.string().min(1),
});

export const runtimeGuidanceReceiptSchema = z.object({
  protocol: z.literal(BUSH_RUNTIME_GUIDANCE_PROTOCOL),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  messageId: z.string().min(1),
  accepted: z.boolean(),
  queueDepth: z.number().int().nonnegative(),
});

export type RuntimeGuidanceRequest = z.infer<typeof runtimeGuidanceRequestSchema>;
export type RuntimeGuidanceReceipt = z.infer<typeof runtimeGuidanceReceiptSchema>;
