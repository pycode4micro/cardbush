import { z } from 'zod';
import { modelRequestSchema } from './model.js';

export const REALTIME_TASK_SUMMARY_COMMAND = 'runtime.realtime_task_summary' as const;
export const realtimeTaskSummaryRequestSchema = z.object({
  sessionId: z.string().min(1).max(200), taskId: z.string().min(1).max(200),
  language: z.string().trim().min(1).max(64).refine(value => { try { return Intl.getCanonicalLocales(value).length === 1; } catch { return false; } }, 'Invalid language tag'),
  model: modelRequestSchema.pick({ model: true, providerBinding: true, reasoningEffort: true, maxOutputTokens: true, metadata: true }),
}).strict();
export type RealtimeTaskSummaryRequest = z.infer<typeof realtimeTaskSummaryRequestSchema>;
export const realtimeTaskSummaryResultSchema = z.object({ speech: z.string().trim().min(1).max(500) }).strict();
