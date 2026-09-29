import { z } from 'zod';

export const individuationSettingsSchema = z.object({
  habits: z.boolean().default(false),
  predictions: z.boolean().default(false),
});
export type IndividuationSettings = z.infer<typeof individuationSettingsSchema>;

export function normalizeIndividuation(value: unknown): IndividuationSettings {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return { habits: input.habits === true, predictions: input.predictions === true };
}

export function individuationPreferenceText(value: unknown): string {
  const state = normalizeIndividuation(value);
  return `Individuation for this turn: habits ${state.habits ? 'enabled' : 'disabled'}; next-step prediction ${state.predictions ? 'enabled' : 'disabled'}.`;
}

const key = z.string().trim().min(1).max(120);
const note = z.string().trim().min(1).max(1200);
export const summaryForUserInputSchema = z.object({
  habits: z.array(z.object({ key, content: note, evidence: note }).strict()).max(12).default([]),
  predictions: z.array(z.object({
    key, trigger: note, action: note, reason: note,
    expires_in_days: z.number().int().min(1).max(90).default(30),
  }).strict()).max(12).default([]),
  consumed_prediction_ids: z.array(key).max(20).default([]),
}).strict();
export const checkHabitInputSchema = z.object({
  query: z.string().trim().max(300).default(''),
  limit: z.number().int().min(1).max(20).default(10),
  claim_prediction_ids: z.array(key).max(20).default([]),
  release_prediction_ids: z.array(key).max(20).default([]),
}).strict();
export type SummaryForUserInput = z.infer<typeof summaryForUserInputSchema>;
export type CheckHabitInput = z.infer<typeof checkHabitInputSchema>;
