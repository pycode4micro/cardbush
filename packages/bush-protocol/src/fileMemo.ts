import { z } from 'zod';

export const FILE_MEMO_PROTOCOL = 'bush.file_memo.v1' as const;
export const FILE_MEMO_SCHEME = 'cardbush-memo:';
export const RESOLVE_FILE_MEMO_COMMAND = 'runtime.resolve_file_memo';
const shortLine = (max: number) => z.string().trim().min(1).max(max).regex(/^[^\r\n]+$/);
export const fileMemoInputSchema = z.object({
  path: z.string().min(1).max(32768),
  purpose: shortLine(120),
  points: z.array(shortLine(160)).max(3).default([]),
}).strict();
export const fileMemoSchema = z.object({
  protocol: z.literal(FILE_MEMO_PROTOCOL),
  id: z.string().regex(/^file_[a-f0-9]{32}$/),
  reference: z.string().startsWith(FILE_MEMO_SCHEME),
  file: z.object({ path: z.string().min(1), name: z.string().min(1), size: z.number().nonnegative(), mtimeMs: z.number() }),
  note: fileMemoInputSchema.omit({ path: true }),
});
export type FileMemo = z.infer<typeof fileMemoSchema>;
export const fileMemoResolutionSchema = z.object({
  memo: fileMemoSchema,
  status: z.enum(['available', 'changed', 'unavailable']),
});
export type FileMemoResolution = z.infer<typeof fileMemoResolutionSchema>;

/** Reference one immutable execution record; notes need no second database. */
export function fileMemoReference(identity: { sessionId: string; turnId: string; toolCallId: string }): string {
  return FILE_MEMO_SCHEME + [identity.sessionId, identity.turnId, identity.toolCallId].map(encodeURIComponent).join('/');
}
export function parseFileMemoReference(value: string): { sessionId: string; turnId: string; toolCallId: string } | undefined {
  if (!value.startsWith(FILE_MEMO_SCHEME) || value.length > 2048) return undefined;
  try {
    const parts = value.slice(FILE_MEMO_SCHEME.length).split('/').map(decodeURIComponent);
    if (parts.length !== 3 || parts.some(part => !part || /[\r\n\0]/.test(part))) return undefined;
    const identity = { sessionId: parts[0]!, turnId: parts[1]!, toolCallId: parts[2]! };
    return fileMemoReference(identity) === value ? identity : undefined;
  } catch { return undefined; }
}
