import { z } from 'zod';

/** A saved forecast for an editable draft, never a queued request or authorization. */
export const nextStepPredictionSchema = z.object({
  id: z.string().min(1),
  text: z.string().trim().min(1).max(1600),
  expiresAt: z.number().finite(),
});
export type NextStepPrediction = z.infer<typeof nextStepPredictionSchema>;

export const NEXT_STEP_PREDICTION_TEXT_DESCRIPTION = 'One short message the USER could send next to the assistant, in the user\'s voice and language (at most 320 characters). Ground it in the latest exchange. Example: "帮我运行这个示例流程。" / "Run this example workflow for me." Never write "用户可能…" / "The user may…", an assistant plan ("I will…"), explanations, role labels or alternative next steps. Put applicability conditions in applies_when. Do not invent missing requirements or approvals. If no single useful next request is clear, omit prediction entirely; do not use an empty object.';

/** A conservative presentation check, not an inference of intent or permission.
 * Historical memory may legitimately contain narration. Keep that record, but
 * never rewrite its perspective or pick an alternative on the user's behalf. */
export function nextStepPredictionTextIssue(text: string): 'too_long' | 'not_user_message' | 'multiple_options' | 'formatting' | undefined {
  const value = text.trim();
  if (value.length > 320) return 'too_long';
  if (!value || /[\r\n]|```|^\s*(?:[-*•]\s|\d+[.)、]\s*|[\[{]\s*["{]|<(?:analysis|thinking)>)/i.test(value)) return 'formatting';
  const start = value.replace(/^["'“‘「『]+/, '');
  if (/^(?:(?:该|这个|此)?用户|使用者)(?:可能|或许|大概|预计|应该|接下来|下一步|会|将|想|希望|需要|要求)/.test(start)
    || /^(?:the\s+)?user\s+(?:may|might|could|will|would|should|probably|likely|wants?|needs?|is likely|is expected)\b/i.test(start)
    || /^(?:可能|或许|也许)(?:还|会|想|需要|要)/.test(start)
    || /^(?:我(?:来|会|将|接下来)|让我来|接下来我)/.test(start)
    || /^(?:I(?:['’]ll|\s+(?:will|can|am going to))|let me)\b/i.test(start)
    || /^(?:预测|下一步(?:预测|建议)|建议的下一步|分析|用户|助手|prediction|next[- ]step(?: prediction| suggestion)?|suggested (?:prompt|request)|analysis|reasoning|user|assistant)\s*[:：]/i.test(start)) return 'not_user_message';
  if (/[，,；;。.!?！？]\s*(?:或(?:者)?|也可以)|\b(?:alternatively|or (?:ask|request|have|let|run|replace))\b|[,;]\s*or\b/i.test(value)) return 'multiple_options';
}

/** Validate at the display boundary without tightening the persisted wire schema. */
export function usableNextStepPrediction(value: unknown): NextStepPrediction | undefined {
  const parsed = nextStepPredictionSchema.safeParse(value);
  return parsed.success && !nextStepPredictionTextIssue(parsed.data.text) ? parsed.data : undefined;
}

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
    return usableNextStepPrediction({ id: `${call.id}:${write.id}`, text: note?.text,
      expiresAt: note?.expires_at ? Date.parse(note.expires_at) : Date.parse(createdAt) + 7 * 86400_000 });
  } catch { return; }
}
