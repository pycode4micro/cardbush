import { resolveContextBudget } from '@cardbush/bush-protocol';

export interface PersistedTurnUsage {
  model?: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  inputTokens?: number;
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

/**
 * Context occupancy is the latest provider request, never the sum of every
 * request made by a multi-round Turn. `inputTokens` remains cost accounting.
 */
export function contextWindowMetrics(
  usage: PersistedTurnUsage | undefined,
  configuredMaxTokens?: number,
  configuredMaxOutputTokens?: number,
): ContextWindowMetrics {
  const usedTokens = nonnegativeInteger(usage?.lastRequestInputTokens);
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
