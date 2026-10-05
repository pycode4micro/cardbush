import { z } from 'zod';
import { modelRequestSchema } from './model.js';

export const REALTIME_TASK_SUMMARY_COMMAND = 'runtime.realtime_task_summary' as const;
export const realtimeTaskSummaryRequestSchema = z.object({
  sessionId: z.string().min(1).max(200), taskId: z.string().min(1).max(200),
  language: z.enum(['zh', 'en']),
  model: modelRequestSchema.pick({ model: true, providerBinding: true, reasoningEffort: true, metadata: true }),
}).strict();
export type RealtimeTaskSummaryRequest = z.infer<typeof realtimeTaskSummaryRequestSchema>;
export const realtimeTaskSummaryResultSchema = z.object({ speech: z.string().trim().min(1).max(500) }).strict();
