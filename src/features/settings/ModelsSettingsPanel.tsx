import { uiText } from '../../i18n';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { ModelFormDialog } from './ModelFormDialog';
import type { DiscoverModels } from './modelProtocols';
import './modelConfiguration.css';
import { DEFAULT_MAX_CONTEXT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS } from '@cardbush/bush-protocol';
import type { AppLanguage, ManagedModelConfig } from '../../types';
import { ModelConfigRow } from './ModelConfigRow';
import { collectProviderOptions } from './ModelProviderSelect';
import { SettingsCard, SettingsSwitch } from './SettingsControls';
import { agentErrorText } from '../agents/agentErrorText';
import { confirmAction } from '../../components/confirmAction';

export type ModelSettingsConfig = { defaultModelId: string; models: ManagedModelConfig[] };
type Models = ModelSettingsConfig;

export function ModelsSettingsPanel({ language, models, onSave, onRefresh, visualInputAvailable, visualInputEnabled, onVisualInputEnabledChange, scopeName, visionControl, discoverModels, onSelect, defaultSelection = false }: {
  language: AppLanguage; models: Models; onSave: (config: Models) => Promise<Models>; onRefresh: () => Promise<void>;
  visualInputAvailable: boolean; visualInputEnabled: boolean; onVisualInputEnabledChange: (enabled: boolean) => void;
  scopeName?: string; visionControl?: ReactNode; discoverModels?: DiscoverModels; onSelect?: (id: string) => void;
  defaultSelection?: boolean;
}) {

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
          if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) throw Error(uiText(language)('modelsSettingsPanel.tokenLimitsMustBePositiveIntegers'));
        }
        if ((model.maxCompletionTokens ?? DEFAULT_MAX_OUTPUT_TOKENS) >= (model.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS)) {
          throw Error(uiText(language)('modelsSettingsPanel.maximumOutputTokensMustBeBelowThe'));
        }
      }
      setConfig(await onSave(next));
      setNotice(scopeName ? (uiText(language)('modelsSettingsPanel.savedTo', { scopeName })) : (uiText(language)('modelsSettingsPanel.saved')));
      try { await onRefresh(); }
      catch (error) { setError(`${uiText(language)('modelsSettingsPanel.savedButRefreshFailed')}${agentErrorText(error)}`); }
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
    <SettingsCard title={uiText(language)('modelsSettingsPanel.modelInput')}>{visionControl ?? <SettingsSwitch title={uiText(language)('modelsSettingsPanel.visionInput')}
      subtitle={visualInputAvailable
        ? (uiText(language)('modelsSettingsPanel.allowNativeImageInputWithAVision'))
        : (uiText(language)('modelsSettingsPanel.updateThisAgentServiceToEnableVision'))}
      checked={visualInputEnabled} disabled={!visualInputAvailable} onChange={onVisualInputEnabledChange}/>}</SettingsCard>
    <SettingsCard title={uiText(language)('modelsSettingsPanel.configuredModels')} subtitle={uiText(language)('modelsSettingsPanel.models', { value1: config.models.length })}
      headerAction={<div className="settings-actions">
        {config.models.length > 0 && <button type="button" className="secondary-button" disabled={busy} onClick={async () => {
          if (await confirmAction({ title: uiText(language)('modelsSettingsPanel.clearModelConfigurations'), message: uiText(language)('modelsSettingsPanel.deleteEveryModelConfigurationInThisEnvironment'), confirmLabel: uiText(language)('modelsSettingsPanel.clearAll'), cancelLabel: uiText(language)('agentConnectionForm.cancel') })) void save({ defaultModelId: '', models: [] });
        }}>{uiText(language)('modelsSettingsPanel.clearAll')}</button>}
        <button type="button" className="primary-button" disabled={busy} onClick={() => { setAdding(true); setEditing(''); setError(''); setNotice(''); }}><Plus size={14}/>{uiText(language)('modelFormDialog.addModel')}</button>
      </div>}>
      {config.models.length === 0 ? <p className="settings-empty-state">{uiText(language)('modelsSettingsPanel.addAModelToStartChatting')}</p> :
        <div className="model-provider-list">{[...groups].sort(([a], [b]) => a.localeCompare(b)).map(([provider, entries]) => <section className="model-provider-group" key={provider}>
          <header><strong>{provider}</strong><span>{entries.length}</span></header>
          {entries.map(model => <div className="agent-model-entry" key={model.id}>
            <ModelConfigRow config={model} language={language} disabled={busy} selected={config.defaultModelId === model.id} defaultSelection={defaultSelection || Boolean(scopeName)}
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
      busy={busy} error={error} discoverModels={discoverModels} allowChatGpt={!scopeName} onCancel={() => { setAdding(false); setEditing(''); }} onSave={async model => {
        const saved = adding ? await save({ models: [...config.models, model], defaultModelId: config.defaultModelId || model.id }) : await update(model);
        if (saved) { setAdding(false); setEditing(''); }
      }}/>}
  </div>;
}
