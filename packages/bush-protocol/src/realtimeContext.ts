import { z } from 'zod';
import { modelRequestSchema } from './model.js';

export const REALTIME_CONTEXT_COMPACTION_COMMAND = 'runtime.realtime_context_compaction' as const;
export const realtimeContextJobSchema = z.object({
  jobId: z.string().min(1).max(100),
  sessionId: z.string().min(1).max(200),
  revision: z.number().int().nonnegative(),
  through: z.number().int().positive(),
  previousSummary: z.string().max(6000),
  maxSummaryCharacters: z.number().int().min(300).max(2000).default(2000),
  pairs: z.array(z.object({ user: z.string().max(32000), assistant: z.string().max(32000) }).strict()).min(1).max(80),
}).strict().refine(value => JSON.stringify(value).length <= 100_000, 'Voice checkpoint input is too large.');
export type RealtimeContextJob = z.infer<typeof realtimeContextJobSchema>;
export const realtimeContextRequestSchema = z.object({
  job: realtimeContextJobSchema,
  model: modelRequestSchema.pick({ model: true, providerBinding: true, reasoningEffort: true, metadata: true }),
}).strict();
export type RealtimeContextRequest = z.infer<typeof realtimeContextRequestSchema>;
export const realtimeContextResultSchema = z.object({
  jobId: z.string().min(1).max(100), revision: z.number().int().nonnegative(),
  through: z.number().int().positive(), summary: z.string().trim().min(1).max(6000),
}).strict();
export type RealtimeContextResult = z.infer<typeof realtimeContextResultSchema>;
