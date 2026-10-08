import type { ManagedModelConfig } from '../../types';

export type SubagentExecutionModel = { model: string; modelConfigId?: string; turnId?: string };

export function subagentExecutionModel(value: unknown): SubagentExecutionModel | undefined {
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (typeof record.model !== 'string' || !record.model.trim()) return;
  return { model: record.model.trim(),
    modelConfigId: typeof record.modelConfigId === 'string' ? record.modelConfigId : undefined,
    turnId: typeof record.turnId === 'string' ? record.turnId : undefined };
}

export function subagentModelConfig(models: ManagedModelConfig[], execution?: SubagentExecutionModel) {
  if (!execution) return;
  return models.find(model => model.id === execution.modelConfigId && model.modelName === execution.model) ??
    models.find(model => model.modelName === execution.model);
}
