import { DEFAULT_MAX_OUTPUT_TOKENS } from './modelLimits.js';

export const CONTEXT_COMPACTION_HARD_PRESSURE = 0.95;
const CONTEXT_MAINTENANCE_RESERVE_MAX_TOKENS = 2_048;
const CONTEXT_MAINTENANCE_RESERVE_MIN_TOKENS = 128;

export interface ContextBudget {
  contextWindowTokens: number;
  normalOutputTokens: number;
  compactionOutputTokens: number;
  safetyTokens: number;
  normalInputLimit: number;
  compactionInputLimit: number;
  compactionTriggerTokens: number;
}

/** Shared by dispatch and presentation. The conversation window is the
 * compaction trigger, not the model's total window or its hard input limit.
 * Maintenance inherits the full output allowance, including reasoning.
 */
export function resolveContextBudget(contextWindowTokens: number, configuredOutputTokens?: number): ContextBudget {
  const normalOutputTokens = resolveContextOutputTokens(contextWindowTokens, configuredOutputTokens);
  const normalInputLimit = contextWindowTokens - normalOutputTokens;
  const compactionOutputTokens = normalOutputTokens;
  const safetyTokens = contextMaintenanceInputReserveTokens(normalInputLimit);
  return { contextWindowTokens, normalOutputTokens, compactionOutputTokens, safetyTokens,
    normalInputLimit,
    compactionInputLimit: Math.max(0, contextWindowTokens - compactionOutputTokens - safetyTokens),
    compactionTriggerTokens: Math.max(0, Math.min(
      Math.floor(normalInputLimit * CONTEXT_COMPACTION_HARD_PRESSURE),
      // Large output allowances must not cause endless compaction on an empty
      // conversation. Oversized maintenance snapshots use Runtime's partitioner.
      Math.max(Math.floor(normalInputLimit * 0.5), normalInputLimit - compactionOutputTokens - safetyTokens),
    )) };
}

export function resolveContextOutputTokens(contextWindowTokens: number, configuredOutputTokens?: number): number {
  if (!Number.isInteger(contextWindowTokens) || contextWindowTokens <= 0) {
    throw new Error('contextWindowTokens must be a positive integer.');
  }
  if (configuredOutputTokens !== undefined && (!Number.isInteger(configuredOutputTokens) || configuredOutputTokens <= 0)) {
    throw new Error('maxOutputTokens must be a positive integer when provided.');
  }
  const resolved = configuredOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  if (resolved >= contextWindowTokens) {
    throw new Error(`Invalid model token limits: maxOutputTokens (${resolved}) must be less than contextWindowTokens (${contextWindowTokens}).`);
  }
  return resolved;
}

export function contextMaintenanceInputReserveTokens(usableInputTokens: number): number {
  return Math.min(CONTEXT_MAINTENANCE_RESERVE_MAX_TOKENS,
    Math.max(CONTEXT_MAINTENANCE_RESERVE_MIN_TOKENS, Math.trunc(usableInputTokens * 0.01)));
}
