import { z } from "zod";

export const BUSH_RUNTIME_INTERACTION_PROTOCOL =
  "bush.runtime_interaction.v1" as const;
export const GET_PENDING_RUNTIME_INTERACTIONS_COMMAND =
  "runtime.get_pending_interactions" as const;
export const ANSWER_RUNTIME_INTERACTION_COMMAND =
  "runtime.answer_interaction" as const;

export const interactionOptionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
});

export const interactionQuestionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  question: z.string().min(1),
  selectionMode: z.enum(["single", "multiple", "input"]),
  needInput: z.boolean().default(false),
  required: z.boolean().default(true),
  options: z.array(interactionOptionSchema).max(7).default([]),
});

export const runtimeInteractionSchema = z.object({
  protocol: z.literal(BUSH_RUNTIME_INTERACTION_PROTOCOL),
  interactionId: z.string().min(1),
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  toolCallId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().default(""),
  reason: z.string().default(""),
  questions: z.array(interactionQuestionSchema).min(1).max(3),
  submitLabel: z.string().default("Submit"),
  cancelLabel: z.string().default("Cancel"),
  createdAt: z.string().min(1),
  expiresAt: z.string().min(1),
});

export const interactionReplyAnswerSchema = z.object({
  questionId: z.string().min(1),
  selectedOptionId: z.string().min(1).optional(),
  selectedOptionIds: z.array(z.string().min(1)).optional(),
  inputText: z.string().min(1).optional(),
});

export const runtimeInteractionAnswerSchema = z.object({
  protocol: z.literal(BUSH_RUNTIME_INTERACTION_PROTOCOL),
  interactionId: z.string().min(1),
  answerId: z.string().min(1),
  decision: z.enum(["submit", "cancel"]),
  answers: z.array(interactionReplyAnswerSchema).max(3).default([]),
  rawText: z.string().optional(),
});

export const pendingRuntimeInteractionsRequestSchema = z.object({
  sessionId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
});

export type RuntimeInteraction = z.infer<typeof runtimeInteractionSchema>;
export type RuntimeInteractionAnswer = z.infer<typeof runtimeInteractionAnswerSchema>;
