import { z } from 'zod';

export const DEFAULT_SUMMARY_TOKEN_THRESHOLD = 10_000;
export const MAX_MEMORY_NOTE_TOKENS = 400;
export const summaryTokenThresholdSchema = z.number().int().min(1000).max(200_000);
export const individuationSettingsSchema = z.object({
  habits: z.boolean().default(false),
  predictions: z.boolean().default(false),
  summaryTokenThreshold: summaryTokenThresholdSchema.default(DEFAULT_SUMMARY_TOKEN_THRESHOLD),
  recallMode: z.enum(['context', 'hint']).default('context'),
});
export type IndividuationSettings = z.infer<typeof individuationSettingsSchema>;

export function normalizeIndividuation(value: unknown): IndividuationSettings {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return { habits: input.habits === true, predictions: input.predictions === true,
    summaryTokenThreshold: summaryTokenThresholdSchema.safeParse(input.summaryTokenThreshold).data ?? DEFAULT_SUMMARY_TOKEN_THRESHOLD,
    recallMode: input.recallMode === 'hint' ? 'hint' : 'context' };
}

export function individuationPreferenceText(value: unknown): string {
  const state = normalizeIndividuation(value);
  const summaryNote = state.habits || state.predictions
    ? 'Use the optional habit field only for supported, reusable user preferences and the optional prediction field only for uncertain next-step needs. Each field follows its own enabled category; do not mix them or fill both unnecessarily. If there is nothing new, use {} for the final-display signal.'
    : 'Memory storage is disabled: use {} for the final-display signal without saving a note.';
  return `Individuation for this turn: habits ${state.habits ? 'enabled' : 'disabled'}; next-step prediction ${state.predictions ? 'enabled' : 'disabled'}. Relevant historical memory may be supplied as internal reference. Use check_habit only if more context would help. When summary_for_user is available, call it once before the final reply after other Tool work. ${summaryNote} Ordinary conversation without Tool work may reply directly without calling it. Current user instructions take priority; memories and predictions do not authorize actions.`;
}

// Only text is required within an optional entry. Provenance is supplied by the host.
export const memoryNoteSchema = z.object({
  text: z.string().trim().min(1).max(1600),
  applies_when: z.string().trim().max(240).optional(),
  expires_at: z.string().datetime({ offset: true }).optional(),
}).strict();
export const summaryForUserInputSchema = z.object({
  habit: memoryNoteSchema.optional(),
  prediction: memoryNoteSchema.optional(),
}).strict();
export const checkHabitInputSchema = z.object({
  topics: z.array(z.string().trim().min(1).max(180)).min(1).max(3).optional(),
  ids: z.array(z.string().trim().min(1).max(120)).min(1).max(3).optional(),
  count_only: z.boolean().optional(),
}).strict().refine(value => !value.ids || !value.topics && !value.count_only, 'Use ids alone to read full records.');
export type SummaryForUserInput = z.infer<typeof summaryForUserInputSchema>;
export type CheckHabitInput = z.infer<typeof checkHabitInputSchema>;
export type MemoryNote = z.infer<typeof memoryNoteSchema>;

export const memoryChangeSchema = z.object({
  id: z.string().min(1).max(120), revision: z.number().int().positive(),
  action: z.enum(['retract', 'dispute', 'supersede', 'confirm']),
  reason: z.string().trim().min(1).max(300),
  user_quote: z.string().trim().min(4).max(400).optional(),
  replacement: memoryNoteSchema.extend({kind:z.enum(['habit','prediction'])}).optional(),
}).strict().refine(value => (value.action === 'supersede') === Boolean(value.replacement), 'Only supersede requires replacement.');
export type MemoryChange = z.infer<typeof memoryChangeSchema>;

export const memoryRecordSchema = z.object({
  id:z.string(),kind:z.enum(['habit','prediction','note','evidence']),text:z.string(),revision:z.number(),
  state:z.enum(['active','expired','retracted','disputed','superseded','consolidated']),origin:z.enum(['agent','user','summary']),
  applies_when:z.string(),created_at:z.number(),age_days:z.number(),expires_at:z.number().nullable(),
  last_confirmed_at:z.number().nullable(),last_rejected_at:z.number().nullable(),
  source:z.object({session_id:z.string(),turn_id:z.string()}).nullable(),
  replaced_by:z.array(z.string()),source_ids:z.array(z.string()),content_cleared:z.boolean(),truncated:z.boolean(),hits:z.number(),misses:z.number(),
});
export type MemoryRecord = z.infer<typeof memoryRecordSchema>;
export const memoryListSchema=z.object({records:z.array(memoryRecordSchema),next_cursor:z.number().nullable()});
export type MemoryList=z.infer<typeof memoryListSchema>;
export const memoryMutationSchema=z.object({status:z.string(),reason:z.string().optional(),change_id:z.string().optional(),id:z.string().optional(),replacement_id:z.string().optional()});
export type MemoryMutation=z.infer<typeof memoryMutationSchema>;
export const memoryReadSchema = z.object({
  status:z.enum(['ok','no_match','disabled','unavailable','already_supplied','budget_limited','not_found']),
  memories:z.array(memoryRecordSchema),matched_count:z.number(),count_capped:z.boolean(),
  disabled_categories:z.array(z.enum(['habit','prediction'])),
  omitted:z.array(z.object({id:z.string(),reason:z.enum(['not_found','disabled'])})).optional(),
});
export type MemoryRead = z.infer<typeof memoryReadSchema>;
export const memoryHistorySchema = z.object({
  changes:z.array(z.object({id:z.string(),created_at:z.number(),actor:z.string(),reason:z.string(),
    before:z.array(memoryRecordSchema),after:z.array(memoryRecordSchema),undo_of:z.string().nullable(),can_undo:z.boolean()})),
  next_cursor:z.number().nullable(),
});
export type MemoryHistory = z.infer<typeof memoryHistorySchema>;

export const PERSONALIZATION_COMMAND = 'runtime.personalization' as const;
export const personalizationCommandSchema = z.object({
  action: z.enum(['status', 'summarize', 'list', 'history', 'change', 'undo', 'purge_history']),
  settings: individuationSettingsSchema.default(() => normalizeIndividuation(undefined)),
  modelId: z.string().trim().min(1).max(300).optional(),
  cursor:z.number().int().nonnegative().optional(),
  includeInactive:z.boolean().optional(),
  change:memoryChangeSchema.optional(),
  changeId:z.string().max(120).optional(),
  operationId:z.string().min(1).max(120).optional(),
}).strict();
export const personalizationStatusSchema = z.object({
  estimatedTokens: z.number().nonnegative(), records: z.number().nonnegative(),
  habits: z.number().nonnegative(), predictions: z.number().nonnegative(), notes: z.number().nonnegative(),
  hits: z.number().nonnegative(), misses: z.number().nonnegative(),
  running: z.boolean(), lastSummaryAt: z.number().nullable(), lastError: z.string().nullable(),
  inactiveRecords:z.number().nonnegative().default(0),historyChanges:z.number().nonnegative().default(0),
});
export type PersonalizationStatus = z.infer<typeof personalizationStatusSchema>;

const memorySummaryItemSchema = memoryNoteSchema.extend({ sources:z.array(z.string()).min(1).max(100) }).strict();
export const memorySummarySchema = z.object({
  habits:z.array(memorySummaryItemSchema).max(60), predictions:z.array(memorySummaryItemSchema).max(30),
  reviews:z.array(z.object({prediction:z.string(),evidence:z.string(),outcome:z.enum(['hit','miss']),reason:z.string().max(300)}).strict()).max(100),
}).strict();
