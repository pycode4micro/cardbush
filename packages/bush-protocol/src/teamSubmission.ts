import { z } from 'zod';

/** Agent-authored declarations. The host never interprets or verifies their content. */
export const teamSubmissionSchema = z.object({
  status: z.enum(['submitted', 'blocked']),
  summary: z.string().trim().min(1).max(16000),
  artifacts: z.array(z.string().min(1).max(8192)).max(128).default([]),
  checks: z.array(z.object({
    criterion: z.string().min(1).max(4000),
    result: z.enum(['passed', 'failed', 'not_checked']),
    evidence: z.string().max(8000),
  }).strict()).max(128).default([]),
}).strict();
export type TeamSubmission = z.infer<typeof teamSubmissionSchema>;

export const childExecutionFactsSchema = z.object({
  turnId: z.string(), status: z.string(), reason: z.string(),
  startedAt: z.string(), completedAt: z.string(),
  toolCalls: z.number().int().nonnegative(), toolReceipts: z.number().int().nonnegative(),
  inputTokens: z.number().nonnegative().optional(), outputTokens: z.number().nonnegative().optional(),
  finishReason: z.string().optional(), rounds: z.number().int().nonnegative().optional(),
}).strict();
export type ChildExecutionFacts = z.infer<typeof childExecutionFactsSchema>;

export const teamDeliverySchema = z.object({
  status: z.enum(['unsubmitted', 'submitted', 'blocked', 'invalidated']),
  submission: teamSubmissionSchema.optional(),
}).strict();
