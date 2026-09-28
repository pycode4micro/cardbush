import { z } from 'zod';

export const SOURCE_MEMO_SCHEME = 'cardbush-source:';
export const RESOLVE_SOURCE_MEMO_COMMAND = 'runtime.resolve_source_memo';
export function parseSourceMemoReference(value: string): number | undefined {
  const match = /^cardbush-source:([1-9]\d{0,8})-([a-f0-9]{16})$/.exec(value);
  return match ? Number(match[1]) : undefined;
}
const text = z.string().trim().min(1);
export const sourceLocatorSchema = z.object({
  line: z.number().int().positive().optional(), endLine: z.number().int().positive().optional(),
  page: z.number().int().positive().optional(), object: text.max(160).optional(),
  region: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), width: z.number().positive().max(1), height: z.number().positive().max(1) }).strict().optional(),
}).strict().refine(value => !value.endLine || Boolean(value.line && value.endLine >= value.line), 'endLine requires line and must not precede it');
const evidenceInput = z.object({
  target: text.max(32768), label: text.max(160).optional(), locator: sourceLocatorSchema.optional(),
}).strict();
export const sourceMemoInputSchema = z.object({
  explanation: text.max(600), sources: z.array(evidenceInput).max(8).default([]),
}).strict();
export const sourceEvidenceSchema = evidenceInput.extend({
  kind: z.enum(['file', 'url']),
  version: z.object({ size: z.number().nonnegative(), mtimeMs: z.number(), sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).optional(),
  excerpt: z.string().max(1600).optional(),
});
export const sourceMemoSchema = z.object({
  protocol: z.literal('bush.source_memo.v1'), reference: text.refine(value => parseSourceMemoReference(value) !== undefined),
  markdown: text, explanation: text.max(600), sources: z.array(sourceEvidenceSchema).max(8), createdAt: text,
});
export const sourceMemoResolutionSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('resolved'), memo: sourceMemoSchema,
    evidenceStatus: z.array(z.enum(['available', 'changed', 'unavailable', 'link'])).max(8) }),
  z.object({ status: z.literal('unresolved'), reason: z.enum(['invalid_reference', 'reference_not_found', 'reference_mismatch']) }),
]);
export type SourceMemo = z.infer<typeof sourceMemoSchema>;
export type SourceEvidence = z.infer<typeof sourceEvidenceSchema>;
export type SourceMemoResolution = z.infer<typeof sourceMemoResolutionSchema>;
