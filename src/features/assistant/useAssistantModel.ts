import { useCallback } from 'react';
import { PERSONAL_ASSISTANT_SESSION, resolveModelReasoningEffort, type ReasoningEffort } from '@cardbush/bush-protocol';
import type { AppLanguage, ManagedModelConfig, ReasoningLevel } from '../../types';
import { showUiError } from '../../shared/showUiError';
import { resolveConversationModelId, selectConversationModel, useConversationModel } from '../settings/conversationModel';

/** The composer and prepareAssistantRequest read the same assistant-owned selection. */
export function useAssistantModel(models: ManagedModelConfig[], defaultModelId: string,
  saveReasoning: (id: string, effort: ReasoningEffort | null) => Promise<unknown>, language: AppLanguage) {
  useConversationModel(PERSONAL_ASSISTANT_SESSION);
  const selectedModel = resolveConversationModelId(models, PERSONAL_ASSISTANT_SESSION, '', defaultModelId);
  const config = models.find(model => model.id === selectedModel);
  const reasoningLevel: ReasoningLevel = resolveModelReasoningEffort(config ?? {}) ?? 'default';
  const onModelChange = useCallback((id: string) => {
    if (models.some(model => model.id === id)) selectConversationModel(id, PERSONAL_ASSISTANT_SESSION);
  }, [models]);
  const onReasoningLevelChange = useCallback((level: ReasoningLevel) => {
    if (!config) return;
    const effort = resolveModelReasoningEffort(config, level) ?? null;
    void Promise.resolve().then(() => saveReasoning(config.id, effort)).catch(error => {
      void showUiError(language === 'zh' ? '思考强度保存失败' : 'Unable to save reasoning effort', String(error instanceof Error ? error.message : error));
    });
  }, [config, saveReasoning, language]);
  return { selectedModel, onModelChange, reasoningLevel, onReasoningLevelChange };
}
