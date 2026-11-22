import { toolFailureFacts, withToolFailureFacts } from './toolFailureFacts.js';

type Phase = 'validation_rejected' | 'before_commit' | 'commit_receipt_lost' | 'after_commit';

/** These facts describe publication of the target, independent of staging and review metadata. */
export function workspaceWriteFailure(error: unknown, phase: Phase, path: string): Error {
  const failure = (error instanceof Error ? error : new Error(String(error))) as Error & { details?: Record<string, unknown> };
  if (toolFailureFacts(failure) && failure.details?.phase) return failure;
  const targetCommitted = phase === 'commit_receipt_lost' ? null : phase === 'after_commit';
  failure.details = { ...failure.details, path, phase, targetCommitted };
  return withToolFailureFacts(failure, {
    ...toolFailureFacts(failure),
    effects: targetCommitted === false ? 'none' : 'possible',
    result: targetCommitted === null ? 'unknown' : 'known',
    recovery: targetCommitted === false ? 'correct_input' : 'inspect_existing',
  });
}
