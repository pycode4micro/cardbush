import { CheckCircle2, Pencil, Trash2 } from 'lucide-react';
import type { AppLanguage, ManagedModelConfig } from '../../types';
import { modelProtocols } from './modelProtocols';

export function ModelConfigRow({ config, language, selected, onUse, onDelete, disabled = false, onEdit, defaultSelection = false }: {
  config: ManagedModelConfig; language: AppLanguage; selected: boolean; onUse: () => void; onDelete: () => void;
  disabled?: boolean; onEdit: () => void; defaultSelection?: boolean;
}) {
  const zh = language === 'zh';
  const protocol = modelProtocols.find(item => item.value === (config.apiProtocol ?? 'openai_responses'))!;
  return <div className="model-row model-row-compact">
    <button type="button" className="model-row-summary model-row-edit" disabled={disabled} aria-label={(zh ? '编辑 ' : 'Edit ') + config.modelName} onClick={onEdit}>
      <strong>{config.modelName}</strong>
      <span>{protocol.label}{' · '}{config.apiKey || config.hasApiKey ? zh ? '凭证已保存' : 'Credential saved' : zh ? '未设置凭证' : 'No credential'}</span>
      <small>{config.baseUrl || protocol.baseUrl}</small>
    </button>
    <div className="model-row-actions">
      {selected ? <span className="current-badge"><CheckCircle2 size={13}/>{defaultSelection ? zh ? '默认' : 'Default' : zh ? '当前' : 'Current'}</span>
        : <button className="secondary-button model-use-button" type="button" disabled={disabled} onClick={onUse}>{defaultSelection ? zh ? '设为默认' : 'Set default' : zh ? '使用' : 'Use'}</button>}
      <button className="icon-button" type="button" disabled={disabled} title={zh ? '编辑模型' : 'Edit model'} aria-label={zh ? '编辑模型' : 'Edit model'} onClick={onEdit}><Pencil size={14}/></button>
      <button className="icon-button model-delete-button" type="button" disabled={disabled} title={zh ? '删除模型' : 'Delete model'} aria-label={(zh ? '删除 ' : 'Delete ') + config.modelName} onClick={onDelete}><Trash2 size={14}/></button>
    </div>
  </div>;
}

export function normalizeMaxContextTokens(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}
export const normalizeMaxCompletionTokens = normalizeMaxContextTokens;
