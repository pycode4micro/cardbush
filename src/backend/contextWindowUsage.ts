export interface PersistedTurnUsage {
  model?: string;
  contextWindowTokens?: number;
  inputTokens?: number;
  lastRequestInputTokens?: number;
}

export interface ContextWindowMetrics {
  usedTokens?: number;
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
): ContextWindowMetrics {
  const usedTokens = nonnegativeInteger(usage?.lastRequestInputTokens);
  const maxTokens = positiveInteger(usage?.contextWindowTokens ?? configuredMaxTokens);
  return {
    ...(usedTokens !== undefined ? { usedTokens } : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(usedTokens !== undefined && maxTokens !== undefined
      ? {
          remainingTokens: Math.max(0, maxTokens - usedTokens),
          usageRatio: usedTokens / maxTokens,
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
