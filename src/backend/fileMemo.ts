import { RESOLVE_FILE_MEMO_COMMAND, fileMemoResolutionSchema, parseFileMemoReference } from '@cardbush/bush-protocol';
import { conversationRuntime, type ConversationRuntime } from './conversationRuntime';

export async function fetchFileMemo(reference: string, signal?: AbortSignal, scope: { sessionId?: string; turnId?: string; fileName?: string } = {}, runtimeOverride?: ConversationRuntime) {
  if (!parseFileMemoReference(reference)) return fileMemoResolutionSchema.parse({ status: 'unresolved', reason: 'invalid_reference' });
  const runtime = conversationRuntime(runtimeOverride);
  try {
    return await runtime.client.command({ kind: RESOLVE_FILE_MEMO_COMMAND, payload: { reference, ...scope } },
      value => fileMemoResolutionSchema.parse(value),
      AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]));
  } finally { runtime.dispose(); }
}
