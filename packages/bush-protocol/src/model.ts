import { z } from "zod";

import { toolDefinitionSchema } from "./tool.js";
import { runtimeProviderBindingRefSchema } from "./providerBinding.js";

export const BUSH_MODEL_REQUEST_PROTOCOL = "bush.model_request.v1" as const;
export const BUSH_MODEL_EVENT_PROTOCOL = "bush.model_event.v1" as const;

export const modelImageInputSchema = z.object({
  url: z.string().min(1),
  detail: z.enum(["auto", "low", "high"]).optional(),
});

export type ModelImageInput = z.infer<typeof modelImageInputSchema>;

const instructionModelMessageSchema = z.object({
  role: z.enum(["system", "developer"]),
  content: z.string(),
  name: z.string().optional(),
});

const userModelMessageSchema = z.object({
  role: z.literal("user"),
  content: z.string(),
  name: z.string().optional(),
  images: z.array(modelImageInputSchema).max(4).optional(),
});

const assistantModelMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.string(),
  toolCalls: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        argumentsText: z.string(),
      }),
    )
    .default([]),
});

const toolModelMessageSchema = z.object({
  role: z.literal("tool"),
  content: z.string(),
  toolCallId: z.string().min(1),
});

export const modelMessageSchema = z.union([
  instructionModelMessageSchema,
  userModelMessageSchema,
  assistantModelMessageSchema,
  toolModelMessageSchema,
]);

export type ModelMessage = z.infer<typeof modelMessageSchema>;

export const modelRequestSchema = z.object({
  protocol: z.literal(BUSH_MODEL_REQUEST_PROTOCOL),
  requestId: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  model: z.string().min(1),
  providerBinding: runtimeProviderBindingRefSchema.optional(),
  messages: z.array(modelMessageSchema),
  tools: z.array(toolDefinitionSchema).default([]),
  toolChoice: z.enum(["auto", "none", "required"]).default("auto"),
  maxOutputTokens: z.number().int().positive().optional(),
  temperature: z.number().finite().optional(),
  topP: z.number().finite().optional(),
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type ModelRequest = z.infer<typeof modelRequestSchema>;

const eventBaseSchema = z.object({
  protocol: z.literal(BUSH_MODEL_EVENT_PROTOCOL),
  requestId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
});

export const modelEventSchema = z.discriminatedUnion("kind", [
  eventBaseSchema.extend({
    kind: z.literal("response_started"),
    providerResponseId: z.string().optional(),
  }),
  eventBaseSchema.extend({
    kind: z.literal("text_delta"),
    delta: z.string(),
  }),
  eventBaseSchema.extend({
    kind: z.literal("reasoning_delta"),
    delta: z.string(),
  }),
  eventBaseSchema.extend({
    kind: z.literal("tool_call_delta"),
    index: z.number().int().nonnegative(),
    toolCallId: z.string().optional(),
    nameDelta: z.string().optional(),
    argumentsDelta: z.string().optional(),
  }),
  eventBaseSchema.extend({
    kind: z.literal("usage"),
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
  }),
  eventBaseSchema.extend({
    kind: z.literal("response_completed"),
    finishReason: z.string().optional(),
  }),
  eventBaseSchema.extend({
    kind: z.literal("response_failed"),
    code: z.string().min(1),
    message: z.string(),
    retryable: z.boolean(),
    status: z.number().int().optional(),
    providerRequestId: z.string().optional(),
  }),
]);

export type ModelEvent = z.infer<typeof modelEventSchema>;
