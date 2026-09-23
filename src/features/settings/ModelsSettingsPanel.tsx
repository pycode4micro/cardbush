import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronUp, Plus } from 'lucide-react';
import { DEFAULT_MAX_CONTEXT_TOKENS } from '@cardbush/bush-product-agent';
import type { AppLanguage, ManagedModelConfig } from '../../types';
import { ModelConfigRow } from './ModelConfigRow';
import { ModelProviderSelect, collectProviderOptions, customProviderValue, normalizeProvider } from './ModelProviderSelect';
import { SettingsCard, SettingsInput, SettingsSwitch } from './SettingsControls';
import { agentErrorText } from '../agents/agentErrorText';

export type ModelSettingsConfig = { defaultModelId: string; models: ManagedModelConfig[] };
type Models = ModelSettingsConfig;
type DiscoverModels = (baseUrl: string, apiKey: string) => Promise<{ models: string[] }>;

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
    <SettingsCard title={zh ? '添加模型' : 'Add model'} subtitle={zh ? '配置当前环境使用的模型服务。' : 'Configure a model provider for this environment.'} bodyHidden={!adding}
      headerAction={<button type="button" className="secondary-button model-form-disclosure" disabled={busy} aria-expanded={adding} onClick={() => { setAdding(value => !value); setEditing(''); }}>
        {adding ? <ChevronUp size={14}/> : <Plus size={14}/>} {adding ? zh ? '收起' : 'Collapse' : zh ? '添加模型' : 'Add model'}</button>}>
      {adding && <ModelForm language={language} providerOptions={providerOptions} busy={busy} discoverModels={discoverModels} onCancel={() => setAdding(false)} onSave={async model => {
        const next = { models: [...config.models, model], defaultModelId: config.defaultModelId || model.id };
        if (await save(next)) setAdding(false);
      }}/>}</SettingsCard>
    <SettingsCard title={zh ? '已配置模型' : 'Configured models'} subtitle={zh ? `${config.models.length} 个模型` : `${config.models.length} models`}
      headerAction={config.models.length > 0 && <button type="button" className="secondary-button danger model-clear-all-button" disabled={busy} onClick={() => {
        if (window.confirm(zh ? `确定清空${scopeName ? ` ${scopeName} 的` : ''}全部 ${config.models.length} 个模型配置吗？此操作无法撤销。` : `Clear all ${config.models.length} model configurations${scopeName ? ` on ${scopeName}` : ''}? This cannot be undone.`)) void save({ models: [], defaultModelId: '' });
      }}>{zh ? '清空全部' : 'Clear all'}</button>}>
      {config.models.length === 0 ? <p className="settings-muted">{zh ? '暂无模型，点击“添加模型”开始配置。' : 'No models yet. Choose Add model to get started.'}</p> :
        <div className="model-provider-list">{[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([provider, entries]) => <section className="model-provider-group" key={provider}>
          <header><strong>{provider}</strong><span>{entries.length}</span></header>
          {entries.map(model => <div className="agent-model-entry" key={model.id}>
            <ModelConfigRow config={model} language={language} disabled={busy} selected={config.defaultModelId === model.id} defaultSelection={Boolean(scopeName)}
              expanded={editing === model.id} onEdit={() => { setEditing(current => current === model.id ? '' : model.id); setAdding(false); }}
              onUse={() => onSelect ? onSelect(model.id) : void save({ ...config, defaultModelId: model.id })}
              onDelete={() => {
                const remaining = config.models.filter(item => item.id !== model.id);
                void save({ models: remaining, defaultModelId: config.defaultModelId === model.id ? remaining[0]?.id ?? '' : config.defaultModelId });
              }}
              onSaveContextTokens={value => void update({ ...model, maxContextTokens: value.trim() ? Number(value) : undefined })}
              onSaveCompletionTokens={value => void update({ ...model, maxCompletionTokens: value.trim() ? Number(value) : undefined })}/>
            {editing === model.id && <div className="agent-model-editor"><ModelForm key={model.id} model={model} language={language} providerOptions={providerOptions} busy={busy} discoverModels={discoverModels} onCancel={() => setEditing('')}
              onSave={async value => { if (await update(value)) setEditing(''); }}/></div>}
          </div>)}
        </section>)}</div>}
    </SettingsCard>
  </div>;
}

function ModelForm({ model, language, providerOptions, busy, onCancel, onSave, discoverModels }: {
  model?: ManagedModelConfig; language: AppLanguage; providerOptions: string[]; busy: boolean; onCancel: () => void; onSave: (model: ManagedModelConfig) => Promise<void>;
  discoverModels?: DiscoverModels;
}) {
  const zh = language === 'zh';
  const [name, setName] = useState(model?.modelName ?? '');
  const [providerSelection, setProviderSelection] = useState(normalizeProvider(model?.provider ?? 'openai'));
  const [customProvider, setCustomProvider] = useState('');
  const provider = normalizeProvider(providerSelection === customProviderValue ? customProvider : providerSelection);
  const [baseUrl, setBaseUrl] = useState(model?.baseUrl ?? '');
  const [key, setKey] = useState('');
  const [context, setContext] = useState(String(model?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS));
  const [completion, setCompletion] = useState(String(model?.maxCompletionTokens ?? ''));
  const [advanced, setAdvanced] = useState(false);
  const [discovered, setDiscovered] = useState<string[]>([]);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryError, setDiscoveryError] = useState('');
  return <form className="model-form" onSubmit={event => {
    event.preventDefault(); if (!name.trim() || !provider.trim()) return;
    void onSave({ ...model, id: model?.id ?? crypto.randomUUID(), modelName: name.trim(), provider: provider.trim(), baseUrl: baseUrl.trim(), apiKey: key.trim(),
      maxContextTokens: context.trim() ? Number(context) : undefined, maxCompletionTokens: completion.trim() ? Number(completion) : undefined });
  }}>
    <fieldset disabled={busy} className="agent-model-fields">
      <div className="model-form-grid"><SettingsInput label={zh ? '模型名称' : 'Model name'} value={name} placeholder="deepseek-chat" onChange={setName}/>
        <ModelProviderSelect language={language} value={providerSelection} options={providerOptions} disabled={busy} onChange={setProviderSelection}/></div>
      {providerSelection === customProviderValue && <SettingsInput label={zh ? '模型商名称' : 'Provider name'} value={customProvider} placeholder="myprovider" onChange={setCustomProvider}/>}
      <SettingsInput label={zh ? 'API 地址' : 'API base URL'} type="url" value={baseUrl} placeholder="https://api.openai.com/v1" onChange={setBaseUrl}/>
      <SettingsInput label="API Key" type="password" value={key} placeholder={(model?.hasApiKey || model?.apiKey) ? zh ? '已保存，留空保留' : 'Saved; leave blank to keep' : zh ? '模型服务的 API Key' : 'Provider API key'} onChange={setKey}/>
      {discoverModels && <button type="button" className="secondary-button model-fetch-button" disabled={discovering || !baseUrl.trim() || !key.trim()} onClick={async () => {
        setDiscovering(true); setDiscoveryError('');
        try { const result = await discoverModels(baseUrl.trim(), key.trim()); setDiscovered(result.models); if (!name.trim() && result.models[0]) setName(result.models[0]); }
        catch (error) { setDiscoveryError(agentErrorText(error)); } finally { setDiscovering(false); }
      }}>{zh ? '获取模型列表' : 'Fetch models'}</button>}
      {discoveryError && <p role="alert">{discoveryError}</p>}
      {discovered.length > 0 && <div className="model-discovery-list">{discovered.map(value => <button key={value} type="button" onClick={() => setName(value)}>{value}</button>)}</div>}
      <button type="button" className="secondary-button model-advanced-disclosure" aria-expanded={advanced} onClick={() => setAdvanced(value => !value)}>{zh ? '高级选项' : 'Advanced options'}</button>
      {advanced && <div className="model-form-grid"><SettingsInput label={zh ? '上下文上限' : 'Context tokens'} type="number" value={context} onChange={setContext}/>
        <SettingsInput label={zh ? '最大输出 tokens' : 'Maximum output tokens'} type="number" value={completion} placeholder={zh ? '供应商默认' : 'Provider default'} onChange={setCompletion}/></div>}
      <div className="settings-actions"><button type="button" className="secondary-button" onClick={onCancel}>{zh ? '取消' : 'Cancel'}</button>
        <button type="submit" className="primary-button" disabled={!name.trim() || !provider.trim()}>{model ? zh ? '保存修改' : 'Save changes' : zh ? '添加模型' : 'Add model'}</button></div>
    </fieldset>
  </form>;
}
