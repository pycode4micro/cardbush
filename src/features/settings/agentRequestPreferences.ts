import type { ManagedModelConfig, PermissionMode, ReferencePlanMode, SubagentPermissionRouting, ReasoningLevel } from '../../types';
import { resolveModelReasoningEffort } from '@cardbush/bush-protocol';
import { readConversationModel, selectConversationModel } from './conversationModel';
import { resolveConversationSource } from './conversationSource';
import { normalizePermissionMode } from '../../shared/permissionModes';

export function readInitialReferencePlanMode(storage: Pick<Storage, 'getItem'> = window.localStorage): ReferencePlanMode {
  if (storage.getItem('cardbush.reference_plan_mode_explicit') !== 'true') {
    return 'auto';
  }
  return normalizeReferencePlanMode(
    storage.getItem('cardbush.reference_plan_mode') ?? 'auto',
  );
}

export function readInitialPermissionMode(storage: Pick<Storage, 'getItem'> = window.localStorage): PermissionMode {
  return normalizePermissionMode(
    storage.getItem('cardbush.permission_mode') ?? 'task_free',
  );
}

export function readInitialSubagentPermissionRouting(storage: Pick<Storage, 'getItem'> = window.localStorage): SubagentPermissionRouting {
  return normalizeSubagentPermissionRouting(
    storage.getItem('cardbush.subagent_permission_routing') ?? 'user',
  );
}

export function normalizeReferencePlanMode(value: string): ReferencePlanMode {
  return value.trim() === 'off' ? 'off' : 'auto';
}

export function normalizeSubagentPermissionRouting(value: string): SubagentPermissionRouting {
  return value.trim() === 'user' ? 'user' : 'parent';
}

export function modelConfigFor(configs: ManagedModelConfig[], selectedModel: string) {
  const normalized = selectedModel.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const exactId = configs.find(
    (config) => config.id.trim().toLowerCase() === normalized,
  );

  if (exactId) {
    return exactId;
  }
  return configs.find(
    (config) => config.modelName.trim().toLowerCase() === normalized,
  );
}

export function selectedModelName(configs: ManagedModelConfig[], selectedModel: string) {
  return modelConfigFor(configs, selectedModel)?.modelName.trim() || selectedModel.trim();
}

export function conversationAgentModel(configs: ManagedModelConfig[], modelId: string, sessionId: string) {
  const modelConfig = modelConfigFor(configs, modelId);
  const reasoningLevel: ReasoningLevel = resolveModelReasoningEffort(modelConfig ?? {}) ?? 'default';
  if (!readConversationModel(sessionId)) selectConversationModel(modelId, sessionId);
  return { sessionId, userInput: '', model: selectedModelName(configs, modelId), modelConfig, reasoningLevel,
    sourceEnabled: resolveConversationSource(sessionId) };
}
