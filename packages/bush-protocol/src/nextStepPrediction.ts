import { z } from 'zod';

/** A saved forecast for an editable draft, never a queued request or authorization. */
export const nextStepPredictionSchema = z.object({
  id: z.string().min(1),
  text: z.string().trim().min(1).max(1600),
  expiresAt: z.number().finite(),
});
export type NextStepPrediction = z.infer<typeof nextStepPredictionSchema>;

export function savedNextStepPrediction(
  call: { id: string; name: string; argumentsText: string }, result: unknown, createdAt: string,
): NextStepPrediction | undefined {
  if (call.name !== 'summary_for_user' || !result || typeof result !== 'object') return;
  const receipt = result as { status?: string; writes?: Array<{ category?: string; status?: string; id?: string }> };
  const write = Array.isArray(receipt.writes) ? receipt.writes.find(item => item?.category === 'prediction' &&
    ['created', 'deduplicated'].includes(item.status ?? '')) : undefined;
  if (receipt.status !== 'ok' || !write?.id) return;
  try {
    const note = JSON.parse(call.argumentsText)?.prediction;
    const parsed = nextStepPredictionSchema.safeParse({ id: `${call.id}:${write.id}`, text: note?.text,
      expiresAt: note?.expires_at ? Date.parse(note.expires_at) : Date.parse(createdAt) + 7 * 86400_000 });
    return parsed.success ? parsed.data : undefined;
  } catch { return; }
}
