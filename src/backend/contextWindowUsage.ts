import { resolveContextBudget } from '@cardbush/bush-protocol';
import type { RuntimeContextCompactionEvent } from '@cardbush/bush-protocol';

export interface PersistedTurnUsage {
  model?: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  inputTokens?: number;
  conversationInputTokens?: number;
  lastRequestInputTokens?: number;
}

export interface ContextWindowMetrics {
  usedTokens?: number;
  totalTokens?: number;
  /** Conversation budget at which Runtime compacts, not the total window. */
  maxTokens?: number;
  remainingTokens?: number;
  usageRatio?: number;
}

/** Older failed turns stored only the last maintenance request's usage. The
 * matching lifecycle start measured the full conversation before that attempt. */
export function failedCompactionInputTokens(events: RuntimeContextCompactionEvent[]): number | undefined {
  const failed = [...events].reverse().find(event => event.kind === 'context_compaction_failed');
  if (!failed) return undefined;
  const start = events.find(event => event.kind === 'context_compaction_started' && event.payload.compactionId === failed.payload.compactionId);
  return start?.kind === 'context_compaction_started' ? start.payload.estimatedInputTokens : undefined;
}

/**
 * Isolated maintenance jobs have their own request size. Older snapshots only
 * recorded the last provider request. `inputTokens` remains cost accounting.
 */
export function contextWindowMetrics(
  usage: PersistedTurnUsage | undefined,
  configuredMaxTokens?: number,
  configuredMaxOutputTokens?: number,
): ContextWindowMetrics {
  const usedTokens = nonnegativeInteger(usage?.conversationInputTokens ?? usage?.lastRequestInputTokens);
  const totalTokens = positiveInteger(usage?.contextWindowTokens ?? configuredMaxTokens);
  let maxTokens: number | undefined;
  if (totalTokens !== undefined) {
    try { maxTokens = resolveContextBudget(totalTokens, usage?.maxOutputTokens ?? configuredMaxOutputTokens).compactionTriggerTokens; }
    catch { /* Invalid or incomplete model limits must not masquerade as a usable conversation window. */ }
  }
  return {
    ...(usedTokens !== undefined ? { usedTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(usedTokens !== undefined && maxTokens !== undefined
      ? {
          remainingTokens: Math.max(0, maxTokens - usedTokens),
          ...(maxTokens > 0 ? { usageRatio: usedTokens / maxTokens } : {}),
        }
      : {}),
  };
}

function nonnegativeInteger(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : undefined;
}
