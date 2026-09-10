import { z } from 'zod';

export const AUTOMATION_COMMAND = 'runtime.automation' as const;
export const automationTriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: z.iso.datetime({ offset: true }) }).strict(),
  z.object({ kind: z.literal('interval'), at: z.iso.datetime({ offset: true }), seconds: z.number().int().min(60).max(31_536_000) }).strict(),
  z.object({ kind: z.literal('event'), event: z.enum(['Stop', 'PostToolUse', 'PostToolUseFailure']), tool: z.string().max(256).default(''), cooldownSeconds: z.number().int().min(60).max(86400).default(60) }).strict(),
]);
export const automationDefinitionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  sessionId: z.string().min(1),
  prompt: z.string().trim().min(1).max(32000),
  trigger: automationTriggerSchema,
  timeZone: z.string().max(100).default('UTC').refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'Invalid time zone'),
}).strict();
export const automationCommandSchema = z.object({
  action: z.enum(['list', 'create', 'update', 'pause', 'resume', 'delete', 'run', 'stop']),
  id: z.string().min(1).optional(),
  expectedRevision: z.number().int().positive().optional(),
  definition: automationDefinitionSchema.optional(),
}).strict();
export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>;
export type AutomationCommand = z.infer<typeof automationCommandSchema>;
export type AutomationRun = {
  id: string; turnId: string; queuedAt: string; startedAt?: string; finishedAt?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted' | 'awaiting_user_action';
  reason: string; error?: string;
};
export type AutomationJob = AutomationDefinition & {
  id: string; revision: number; state: 'active' | 'paused' | 'completed'; createdAt: string;
  nextRunAt?: string; lastEventAt?: string; lastEventIds: string[]; runs: AutomationRun[];
  plugin?: { id: string; hookId: string; definitionHash: string };
};
export type AutomationOverview = {
  jobs: AutomationJob[];
  sessions: Array<{ id: string; title: string; model: string }>;
  available: boolean;
};
