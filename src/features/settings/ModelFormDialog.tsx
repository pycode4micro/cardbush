import { uiText } from '../../i18n';
import { useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, Download } from 'lucide-react';
import { SettingsFormDialog } from './SettingsFormDialog';
import { modelApiBaseURL, modelApiGateway, modelHeadersSchema, resolveModelReasoningEffort, reasoningEffortsForProtocol, type ModelApiProtocol } from '@cardbush/bush-protocol';
import { DEFAULT_MAX_CONTEXT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS } from '@cardbush/bush-protocol';
import type { AppLanguage, ManagedModelConfig, ReasoningLevel } from '../../types';
import { modelReasoningLabel } from './modelReasoning';
import { ModelProviderSelect, customProviderValue, normalizeProvider } from './ModelProviderSelect';
import { SettingsInput } from './SettingsControls';
import { ModelContextWindow } from './ModelContextWindow';
import { SettingsDropdown } from './SettingsDropdown';
import { agentErrorText } from '../agents/agentErrorText';
import { modelProtocols, type DiscoverModels } from './modelProtocols';
import { SiwcModelConnection } from './SiwcModelConnection';
import { SIWC } from '@cardbush/bush-protocol';

export function ModelFormDialog({ model, language, providerOptions, busy, error, onCancel, onSave, discoverModels, allowChatGpt = true }: {
  model?: ManagedModelConfig; language: AppLanguage; providerOptions: string[]; busy: boolean; error: string;
  onCancel: () => void; onSave: (model: ManagedModelConfig) => Promise<void>; discoverModels?: DiscoverModels;
  allowChatGpt?: boolean;
}) {

  const [name, setName] = useState(model?.modelName ?? '');
  const [authentication, setAuthentication] = useState<'api_key' | 'chatgpt'>(model?.authentication?.kind ?? 'api_key');
  const [accountId, setAccountId] = useState(model?.authentication?.kind === 'chatgpt' ? model.authentication.accountId : '');
  const chatGpt = authentication === 'chatgpt';
  const [providerSelection, setProviderSelection] = useState(normalizeProvider(model?.provider ?? 'openai'));
  const [customProvider, setCustomProvider] = useState('');
  const provider = normalizeProvider(providerSelection === customProviderValue ? customProvider : providerSelection);
  const [apiProtocol, setApiProtocol] = useState<ModelApiProtocol>(model?.apiProtocol ?? 'openai_responses');
  const [anthropicThinkingMode, setAnthropicThinkingMode] = useState<'adaptive' | 'budget'>(model?.anthropicThinkingMode ?? 'adaptive');
  const [reasoning, setReasoning] = useState<ReasoningLevel>(model?.reasoningEffort ?? 'default');
  const effectiveReasoning = resolveModelReasoningEffort({ apiProtocol }, reasoning) ?? 'default';
  const protocol = modelProtocols.find(item => item.value === apiProtocol)!;
  const [baseUrl, setBaseUrl] = useState(model?.baseUrl ?? '');
  const gateway = modelApiGateway(baseUrl.trim());
  const [key, setKey] = useState('');
  const [context, setContext] = useState(String(model?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS));
  const [completion, setCompletion] = useState(String(model?.maxCompletionTokens ?? ''));
  const [headers, setHeaders] = useState(Object.keys(model?.defaultHeaders ?? {}).length ? JSON.stringify(model!.defaultHeaders, null, 2) : '');
  const [advanced, setAdvanced] = useState(false), [formError, setFormError] = useState('');
  const [discovered, setDiscovered] = useState<string[]>([]), [discovering, setDiscovering] = useState(false);
  const discoveryVersion = useRef(0), mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const readHeaders = () => modelHeadersSchema.parse(headers.trim() ? JSON.parse(headers) : {});
  const changedConnection = () => { discoveryVersion.current++; setDiscovered([]); setFormError(''); };
  const hasKey = model?.hasApiKey || model?.apiKey;
  const submit = async () => {
    setFormError('');
    try {
      if (!chatGpt) modelApiBaseURL(apiProtocol, baseUrl);
      if (chatGpt && (!allowChatGpt || !accountId)) throw Error(uiText(language)('modelFormDialog.selectALocalChatgptAccountFirst'));
      await onSave({ ...model, id: model?.id ?? crypto.randomUUID(), modelName: name.trim(), provider: chatGpt ? 'openai' : provider,
        authentication: chatGpt ? { kind: 'chatgpt', accountId } : { kind: 'api_key' },
        apiProtocol, baseUrl: chatGpt ? SIWC.resource : baseUrl.trim(), apiKey: chatGpt ? '' : key.trim(), defaultHeaders: chatGpt ? {} : readHeaders(),
        reasoningEffort: resolveModelReasoningEffort({ apiProtocol }, reasoning) ?? null,
        ...(apiProtocol === 'anthropic_messages' ? { anthropicThinkingMode } : {}),
        maxContextTokens: context.trim() ? Number(context) : undefined, maxCompletionTokens: !chatGpt && completion.trim() ? Number(completion) : undefined });
    } catch (failure) { setFormError(agentErrorText(failure)); }
  };
  return <SettingsFormDialog className="model-config-dialog" language={language} busy={busy} onCancel={onCancel} onSubmit={submit}
    title={model ? uiText(language)('modelConfigRow.editModel') : uiText(language)('modelFormDialog.addModel')}
    description={uiText(language)('modelFormDialog.chooseAnApiProtocolAndConfigureThe')}
    footer={<><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>{uiText(language)('agentConnectionForm.cancel')}</button>
      <button type="submit" className="primary-button" disabled={busy || !name.trim() || !provider}>{busy ? uiText(language)('automationPanel.saving') : uiText(language)('modelFormDialog.saveModel')}</button></>}>
      <fieldset disabled={busy} className="agent-model-fields">
        {(allowChatGpt && window.cardbushDesktop?.siwcSnapshot || chatGpt) && <label className="settings-field"><span>{uiText(language)('modelFormDialog.authentication')}</span>
          <SettingsDropdown label={uiText(language)('modelFormDialog.authentication')} value={authentication} options={[{ value: 'api_key', label: uiText(language)('modelFormDialog.api_key_0533a4d') }, { value: 'chatgpt', label: 'ChatGPT · SIWC', disabled: !allowChatGpt }]}
            onChange={value => { setAuthentication(value as 'api_key' | 'chatgpt'); if (value === 'chatgpt') setApiProtocol('openai_responses'); changedConnection(); }}/></label>}
        {chatGpt ? allowChatGpt ? <SiwcModelConnection language={language} accountId={accountId} onAccountChange={setAccountId} modelName={name} onModelChange={setName}/>
          : <p className="model-connection-note">{uiText(language)('modelFormDialog.chatgptAccountsStayOnThisDeviceChoose')}</p> : <>
        <div className="model-form-grid"><ModelProviderSelect language={language} value={providerSelection} options={providerOptions} onChange={value => {
          setProviderSelection(value);
          // Do not overwrite an existing connection when only changing its label.
          if (!model && !baseUrl.trim() && value === 'openrouter') {
            setBaseUrl('https://openrouter.ai/api/v1'); setApiProtocol('openai_chat_completions');
          }
          changedConnection();
        }}/>
          <label className="settings-field"><span>{uiText(language)('modelFormDialog.apiProtocol')}</span><SettingsDropdown label={uiText(language)('modelFormDialog.apiProtocol')} value={apiProtocol} options={modelProtocols}
            onChange={value => { setApiProtocol(value as ModelApiProtocol); changedConnection(); }}/></label></div>
        {providerSelection === customProviderValue && <SettingsInput label={uiText(language)('modelFormDialog.providerName')} value={customProvider} placeholder={uiText(language)('modelFormDialog.myprovider')} onChange={setCustomProvider}/>}
        <SettingsInput label={uiText(language)('modelFormDialog.apiBaseUrl')} type="url" value={baseUrl} placeholder={protocol.baseUrl} onChange={value => { setBaseUrl(value); changedConnection(); }}/>
        <p className="model-field-hint">{uiText(language)('modelFormDialog.enterTheApiRootRequestsWillUse', { value1: protocol.path })}</p>
        <SettingsInput label={uiText(language)('modelFormDialog.api_key')} type="password" value={key} placeholder={hasKey ? uiText(language)('modelFormDialog.savedLeaveBlankToKeep') : uiText(language)('modelFormDialog.providerApiKey')} onChange={value => { setKey(value); changedConnection(); }}/>
        </>}
        <div className="model-name-row"><SettingsInput label={uiText(language)('modelFormDialog.modelName')} value={name} placeholder={gateway === 'openrouter' ? 'provider/model-id' : apiProtocol === 'anthropic_messages' ? 'claude-sonnet-4-6' : 'gpt-6-luna'} onChange={setName}/>
          {!chatGpt && discoverModels && <button type="button" className="secondary-button model-fetch-button" disabled={discovering || !key.trim()} title={hasKey && !key.trim() ? uiText(language)('modelFormDialog.reEnterTheApiKeyToFetch') : undefined}
            onClick={async () => {
              const version = discoveryVersion.current; setDiscovering(true); setFormError('');
              try { const result = await discoverModels(modelApiBaseURL(apiProtocol, baseUrl), key.trim(), { apiProtocol, defaultHeaders: readHeaders() });
                if (mounted.current && version === discoveryVersion.current) { setDiscovered(result.models); if (!result.models.length) setFormError(uiText(language)('modelFormDialog.noModelsReturnedEnterAModelName')); } }
              catch (failure) { if (mounted.current && version === discoveryVersion.current) setFormError(agentErrorText(failure)); }
              finally { if (mounted.current) setDiscovering(false); }
            }}><Download size={14}/>{discovering ? uiText(language)('modelFormDialog.fetching') : uiText(language)('modelFormDialog.fetchModels')}</button>}</div>
        {discovered.length > 0 && <SettingsDropdown label={uiText(language)('modelFormDialog.chooseModel')} value={name} options={discovered.map(value => ({ value, label: value }))} onChange={setName}/>}
        <label className="settings-field"><span>{uiText(language)('modelFormDialog.reasoningEffort')}</span>
          <SettingsDropdown label={uiText(language)('modelFormDialog.reasoningEffort')} value={effectiveReasoning}
            options={(['default', ...reasoningEffortsForProtocol(apiProtocol)] as ReasoningLevel[]).map(value => ({ value, label: modelReasoningLabel(value, language) }))}
            onChange={value => setReasoning(value as ReasoningLevel)}/>
          <small className="model-field-hint">{uiText(language)('modelFormDialog.savedForThisModelAndRestoredWhen')}</small>
        </label>
        {gateway === 'opencode' && <p className="model-connection-note">{uiText(language)('modelFormDialog.opencodeTheConversationIdAndCardbushUser')}</p>}
        {gateway === 'openrouter' && <p className="model-connection-note">{uiText(language)('modelFormDialog.openrouterTheCurrentConversationIdAndCardbush')}</p>}
        <button type="button" className="model-advanced-disclosure" aria-expanded={advanced} onClick={() => setAdvanced(value => !value)}><ChevronDown size={14}/>{uiText(language)('modelFormDialog.advancedOptions')}</button>
        {advanced && <div className="model-advanced-fields">
          {apiProtocol === 'anthropic_messages' && <label className="settings-field"><span>{uiText(language)('modelFormDialog.thinkingParameters')}</span>
            <SettingsDropdown label={uiText(language)('modelFormDialog.thinkingParameters')} value={anthropicThinkingMode} onChange={value => setAnthropicThinkingMode(value as 'adaptive' | 'budget')}
              options={[{ value: 'adaptive', label: uiText(language)('modelFormDialog.adaptiveNewerModels') }, { value: 'budget', label: uiText(language)('modelFormDialog.tokenBudgetOlderModels') }]}/>
            <small className="model-field-hint">{uiText(language)('modelFormDialog.usedWhenAReasoningEffortIsSelected')}</small></label>}
          <div className="model-form-grid"><SettingsInput label={uiText(language)('modelFormDialog.totalContextWindowTokens')} type="number" value={context} placeholder={String(DEFAULT_MAX_CONTEXT_TOKENS)} onChange={setContext}/>
            {!chatGpt && <SettingsInput label={uiText(language)('modelFormDialog.maximumOutputTokens')} type="number" value={completion} placeholder={String(DEFAULT_MAX_OUTPUT_TOKENS)} onChange={setCompletion}/>}</div>
          <ModelContextWindow language={language} contextTokens={context.trim() ? Number(context) : DEFAULT_MAX_CONTEXT_TOKENS}
            outputTokens={!chatGpt && completion.trim() ? Number(completion) : undefined}/>
          {!chatGpt && <><label className="settings-field"><span>{uiText(language)('modelFormDialog.customHeadersJson')}</span><textarea rows={4} value={headers} spellCheck={false} placeholder={'{\n  "x-session-id": "{{sessionId}}"\n}'} onChange={event => { setHeaders(event.currentTarget.value); changedConnection(); }}/></label>
          <p className="model-field-hint">{uiText(language)('modelFormDialog.useForTheStableIdOfThe')}</p></>}
        </div>}
        {(formError || error) && <p className="settings-inline-error" role="alert">{formError || error}</p>}
      </fieldset>
  </SettingsFormDialog>;
}
