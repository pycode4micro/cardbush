import { uiText } from '../../i18n';
import { CheckCircle2, Pencil, Trash2 } from 'lucide-react';
import type { AppLanguage, ManagedModelConfig } from '../../types';
import { modelProtocols } from './modelProtocols';
import { modelReasoningLabel } from './modelReasoning';

export function ModelConfigRow({ config, language, selected, onUse, onDelete, disabled = false, onEdit, defaultSelection = false }: {
  config: ManagedModelConfig; language: AppLanguage; selected: boolean; onUse: () => void; onDelete: () => void;
  disabled?: boolean; onEdit: () => void; defaultSelection?: boolean;
}) {

  const protocol = modelProtocols.find(item => item.value === (config.apiProtocol ?? 'openai_responses'))!;
  return <div className="model-row model-row-compact">
    <button type="button" className="model-row-summary model-row-edit" disabled={disabled} aria-label={(uiText(language)('conversationStyleSettings.edit')) + config.modelName} onClick={onEdit}>
      <strong>{config.modelName}</strong>
      <span>{protocol.label}{' · '}{uiText(language)('modelConfigRow.reasoning')}{modelReasoningLabel(config.reasoningEffort ?? 'default', language)}{' · '}{config.authentication?.kind === 'chatgpt' ? uiText(language)('modelConfigRow.chatgptPlan') : config.apiKey || config.hasApiKey ? uiText(language)('modelConfigRow.credentialSaved') : uiText(language)('modelConfigRow.noCredential')}</span>
      <small>{config.baseUrl || protocol.baseUrl}</small>
    </button>
    <div className="model-row-actions">
      {selected ? <span className="current-badge"><CheckCircle2 size={13}/>{defaultSelection ? uiText(language)('agentDataSettings.default') : uiText(language)('modelConfigRow.current')}</span>
        : <button className="secondary-button model-use-button" type="button" disabled={disabled} onClick={onUse}>{defaultSelection ? uiText(language)('browserConnectionSettings.setDefault') : uiText(language)('modelConfigRow.use')}</button>}
      <button className="icon-button" type="button" disabled={disabled} title={uiText(language)('modelConfigRow.editModel')} aria-label={uiText(language)('modelConfigRow.editModel')} onClick={onEdit}><Pencil size={14}/></button>
      <button className="icon-button model-delete-button" type="button" disabled={disabled} title={uiText(language)('modelConfigRow.deleteModel')} aria-label={(uiText(language)('conversationStyleSettings.delete')) + config.modelName} onClick={onDelete}><Trash2 size={14}/></button>
    </div>
  </div>;
}

export function normalizeMaxContextTokens(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}
export const normalizeMaxCompletionTokens = normalizeMaxContextTokens;
