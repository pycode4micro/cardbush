import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { ModelFormDialog } from './ModelFormDialog';
import type { DiscoverModels } from './modelProtocols';
import './modelConfiguration.css';
import { DEFAULT_MAX_CONTEXT_TOKENS } from '@cardbush/bush-product-agent';
import type { AppLanguage, ManagedModelConfig } from '../../types';
import { ModelConfigRow } from './ModelConfigRow';
import { collectProviderOptions } from './ModelProviderSelect';
import { SettingsCard, SettingsSwitch } from './SettingsControls';
import { agentErrorText } from '../agents/agentErrorText';
import { confirmAction } from '../../components/confirmAction';

export type ModelSettingsConfig = { defaultModelId: string; models: ManagedModelConfig[] };
type Models = ModelSettingsConfig;

export function ModelsSettingsPanel({ language, models, onSave, onRefresh, visualInputAvailable, visualInputEnabled, onVisualInputEnabledChange, scopeName, visionControl, discoverModels, onSelect }: {
  language: AppLanguage; models: Models; onSave: (config: Models) => Promise<Models>; onRefresh: () => Promise<void>;
  visualInputAvailable: boolean; visualInputEnabled: boolean; onVisualInputEnabledChange: (enabled: boolean) => void;
  scopeName?: string; visionControl?: ReactNode; discoverModels?: DiscoverModels; onSelect?: (id: string) => void;
}) {
  const zh = language === 'zh';
  const [config, setConfig] = useState(models);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState('');
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => setConfig(models), [models]);
  async function save(next: Models): Promise<boolean> {
    if (saving.current) return false;
    saving.current = true; setBusy(true); setError(''); setNotice('');
    try {
      for (const model of next.models) {
        for (const limit of [model.maxContextTokens, model.maxCompletionTokens]) {
          if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw Error(zh ? 'Token 上限请输入正整数。' : 'Token limits must be positive integers.');
        }
        if (model.maxCompletionTokens !== undefined && model.maxCompletionTokens >= (model.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS)) {
          throw Error(zh ? '最大输出 tokens 必须小于上下文上限。' : 'Maximum output tokens must be below the context limit.');
        }
      }
      setConfig(await onSave(next));
      setNotice(scopeName ? (zh ? `已保存到 ${scopeName}` : `Saved to ${scopeName}`) : (zh ? '已保存' : 'Saved'));
      try { await onRefresh(); }
      catch (error) { setError(`${zh ? '已保存，但刷新失败：' : 'Saved, but refresh failed: '}${agentErrorText(error)}`); }
      return true;
    } catch (error) { setError(agentErrorText(error)); return false; }
    finally { saving.current = false; setBusy(false); }
  }
  const update = (model: ManagedModelConfig) => save({ ...config, models: config.models.map(item => item.id === model.id ? model : item) });
  const groups = new Map<string, ManagedModelConfig[]>();
  const providerOptions = collectProviderOptions(config.models);
  for (const model of config.models) groups.set(model.provider, [...(groups.get(model.provider) ?? []), model]);
  return <div className="settings-stack model-settings-stack agent-model-settings">
    {error && <p className="settings-inline-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <SettingsCard title={zh ? '模型输入' : 'Model input'}>{visionControl ?? <SettingsSwitch title={zh ? '视觉功能' : 'Vision input'}
      subtitle={visualInputAvailable
        ? (zh ? '允许模型直接接收图片。请使用支持视觉输入的模型；关闭后仍可通过文件工具处理图片。' : 'Allow native image input with a vision-capable model. File tools remain available when disabled.')
        : (zh ? '更新此 Agent 服务后可开启视觉输入。关闭时仍可通过文件工具处理图片。' : 'Update this Agent service to enable vision input. File tools can still process images while it is off.')}
      checked={visualInputEnabled} disabled={!visualInputAvailable} onChange={onVisualInputEnabledChange}/>}</SettingsCard>
    <SettingsCard title={zh ? '已配置模型' : 'Configured models'} subtitle={zh ? config.models.length + ' 个模型' : config.models.length + ' models'}
      headerAction={<div className="settings-actions">
        {config.models.length > 0 && <button type="button" className="secondary-button" disabled={busy} onClick={async () => {
          if (await confirmAction({ title: zh ? '清空模型配置' : 'Clear model configurations', message: zh ? '删除此环境的所有模型配置？' : 'Delete every model configuration in this environment?', confirmLabel: zh ? '清空' : 'Clear all', cancelLabel: zh ? '取消' : 'Cancel' })) void save({ defaultModelId: '', models: [] });
        }}>{zh ? '清空' : 'Clear all'}</button>}
        <button type="button" className="primary-button" disabled={busy} onClick={() => { setAdding(true); setEditing(''); setError(''); setNotice(''); }}><Plus size={14}/>{zh ? '添加模型' : 'Add model'}</button>
      </div>}>
      {config.models.length === 0 ? <p className="settings-empty-state">{zh ? '添加模型后即可开始对话。' : 'Add a model to start chatting.'}</p> :
        <div className="model-provider-list">{[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([provider, entries]) => <section className="model-provider-group" key={provider}>
          <header><strong>{provider}</strong><span>{entries.length}</span></header>
          {entries.map(model => <div className="agent-model-entry" key={model.id}>
            <ModelConfigRow config={model} language={language} disabled={busy} selected={config.defaultModelId === model.id} defaultSelection={Boolean(scopeName)}
              onEdit={() => { setEditing(model.id); setAdding(false); setError(''); setNotice(''); }}
              onUse={() => onSelect ? onSelect(model.id) : void save({ ...config, defaultModelId: model.id })}
              onDelete={() => {
                const remaining = config.models.filter(item => item.id !== model.id);
                void save({ models: remaining, defaultModelId: config.defaultModelId === model.id ? remaining[0]?.id ?? '' : config.defaultModelId });
              }}
              />
          </div>)}
        </section>)}</div>}
    </SettingsCard>
    {(adding || editing) && <ModelFormDialog key={editing || 'new'} model={config.models.find(model => model.id === editing)} language={language} providerOptions={providerOptions}
      busy={busy} error={error} discoverModels={discoverModels} onCancel={() => { setAdding(false); setEditing(''); }} onSave={async model => {
        const saved = adding ? await save({ models: [...config.models, model], defaultModelId: config.defaultModelId || model.id }) : await update(model);
        if (saved) { setAdding(false); setEditing(''); }
      }}/>}
  </div>;
}
