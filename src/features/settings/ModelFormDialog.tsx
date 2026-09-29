import { useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, Download, X } from 'lucide-react';
import { modelApiBaseURL, modelHeadersSchema, type ModelApiProtocol } from '@cardbush/bush-protocol';
import { DEFAULT_MAX_CONTEXT_TOKENS } from '@cardbush/bush-product-agent';
import type { AppLanguage, ManagedModelConfig } from '../../types';
import { ModelProviderSelect, customProviderValue, normalizeProvider } from './ModelProviderSelect';
import { SettingsInput } from './SettingsControls';
import { SettingsDropdown } from './SettingsDropdown';
import { agentErrorText } from '../agents/agentErrorText';
import { modelProtocols, type DiscoverModels } from './modelProtocols';

export function ModelFormDialog({ model, language, providerOptions, busy, error, onCancel, onSave, discoverModels }: {
  model?: ManagedModelConfig; language: AppLanguage; providerOptions: string[]; busy: boolean; error: string;
  onCancel: () => void; onSave: (model: ManagedModelConfig) => Promise<void>; discoverModels?: DiscoverModels;
}) {
  const zh = language === 'zh', titleId = useId(), dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(model?.modelName ?? '');
  const [providerSelection, setProviderSelection] = useState(normalizeProvider(model?.provider ?? 'openai'));
  const [customProvider, setCustomProvider] = useState('');
  const provider = normalizeProvider(providerSelection === customProviderValue ? customProvider : providerSelection);
  const [apiProtocol, setApiProtocol] = useState<ModelApiProtocol>(model?.apiProtocol ?? 'openai_responses');
  const [anthropicThinkingMode, setAnthropicThinkingMode] = useState<'adaptive' | 'budget'>(model?.anthropicThinkingMode ?? 'adaptive');
  const protocol = modelProtocols.find(item => item.value === apiProtocol)!;
  const [baseUrl, setBaseUrl] = useState(model?.baseUrl ?? '');
  const [key, setKey] = useState('');
  const [context, setContext] = useState(String(model?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS));
  const [completion, setCompletion] = useState(String(model?.maxCompletionTokens ?? ''));
  const [headers, setHeaders] = useState(Object.keys(model?.defaultHeaders ?? {}).length ? JSON.stringify(model!.defaultHeaders, null, 2) : '');
  const [advanced, setAdvanced] = useState(false), [formError, setFormError] = useState('');
  const [discovered, setDiscovered] = useState<string[]>([]), [discovering, setDiscovering] = useState(false);
  const discoveryVersion = useRef(0), mounted = useRef(true);
  useLayoutEffect(() => {
    const node = dialog.current!, previous = document.activeElement as HTMLElement | null;
    mounted.current = true; node.showModal();
    return () => { mounted.current = false; node.close();
      // The opener may still be disabled while React commits the saved state.
      queueMicrotask(() => { if (previous?.isConnected) previous.focus({ preventScroll: true }); }); };
  }, []);
  const readHeaders = () => modelHeadersSchema.parse(headers.trim() ? JSON.parse(headers) : {});
  const changedConnection = () => { discoveryVersion.current++; setDiscovered([]); setFormError(''); };
  const hasKey = model?.hasApiKey || model?.apiKey;
  const submit = async () => {
    setFormError('');
    try {
      modelApiBaseURL(apiProtocol, baseUrl);
      await onSave({ ...model, id: model?.id ?? crypto.randomUUID(), modelName: name.trim(), provider,
        apiProtocol, baseUrl: baseUrl.trim(), apiKey: key.trim(), defaultHeaders: readHeaders(),
        ...(apiProtocol === 'anthropic_messages' ? { anthropicThinkingMode } : {}),
        maxContextTokens: context.trim() ? Number(context) : undefined, maxCompletionTokens: completion.trim() ? Number(completion) : undefined });
    } catch (failure) { setFormError(agentErrorText(failure)); }
  };
  return <dialog ref={dialog} className="model-config-dialog" aria-labelledby={titleId}
    onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }} onKeyDown={event => event.stopPropagation()}>
    <header className="model-dialog-header"><div><h2 id={titleId}>{model ? zh ? '编辑模型' : 'Edit model' : zh ? '添加模型' : 'Add model'}</h2>
      <p>{zh ? '选择接入协议，填写服务地址和模型信息。' : 'Choose an API protocol and configure the model connection.'}</p></div>
      <button type="button" className="icon-button" disabled={busy} aria-label={zh ? '关闭' : 'Close'} onClick={onCancel}><X size={18}/></button></header>
    <form className="model-form" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <fieldset disabled={busy} className="agent-model-fields model-dialog-body">
        <div className="model-form-grid"><ModelProviderSelect language={language} value={providerSelection} options={providerOptions} onChange={setProviderSelection}/>
          <label className="settings-field"><span>{zh ? '接入协议' : 'API protocol'}</span><SettingsDropdown label={zh ? '接入协议' : 'API protocol'} value={apiProtocol} options={modelProtocols}
            onChange={value => { setApiProtocol(value as ModelApiProtocol); changedConnection(); }}/></label></div>
        {providerSelection === customProviderValue && <SettingsInput label={zh ? '模型商名称' : 'Provider name'} value={customProvider} placeholder="myprovider" onChange={setCustomProvider}/>}
        <SettingsInput label={zh ? 'API 地址' : 'API base URL'} type="url" value={baseUrl} placeholder={protocol.baseUrl} onChange={value => { setBaseUrl(value); changedConnection(); }}/>
        <p className="model-field-hint">{zh ? `填写 API 根地址，请求会发送到 ${protocol.path}。` : `Enter the API root; requests will use ${protocol.path}.`}</p>
        <SettingsInput label="API Key" type="password" value={key} placeholder={hasKey ? zh ? '已保存，留空保留' : 'Saved; leave blank to keep' : zh ? '模型服务的 API Key' : 'Provider API key'} onChange={value => { setKey(value); changedConnection(); }}/>
        <div className="model-name-row"><SettingsInput label={zh ? '模型名称' : 'Model name'} value={name} placeholder={apiProtocol === 'anthropic_messages' ? 'claude-sonnet-4-6' : 'gpt-6-luna'} onChange={setName}/>
          {discoverModels && <button type="button" className="secondary-button model-fetch-button" disabled={discovering || !key.trim()} title={hasKey && !key.trim() ? zh ? '获取列表需要重新输入 API Key' : 'Re-enter the API key to fetch models' : undefined}
            onClick={async () => {
              const version = discoveryVersion.current; setDiscovering(true); setFormError('');
              try { const result = await discoverModels(modelApiBaseURL(apiProtocol, baseUrl), key.trim(), { apiProtocol, defaultHeaders: readHeaders() });
                if (mounted.current && version === discoveryVersion.current) { setDiscovered(result.models); if (!result.models.length) setFormError(zh ? '没有返回模型，请手动填写名称。' : 'No models returned. Enter a model name manually.'); } }
              catch (failure) { if (mounted.current && version === discoveryVersion.current) setFormError(agentErrorText(failure)); }
              finally { if (mounted.current) setDiscovering(false); }
            }}><Download size={14}/>{discovering ? zh ? '获取中…' : 'Fetching…' : zh ? '获取列表' : 'Fetch models'}</button>}</div>
        {discovered.length > 0 && <SettingsDropdown label={zh ? '选择模型' : 'Choose model'} value={name} options={discovered.map(value => ({ value, label: value }))} onChange={setName}/>}
        {/^https?:\/\/opencode\.ai(?:[/:]|$)/i.test(baseUrl.trim()) && <p className="model-connection-note">{zh ? '已支持 OpenCode：自动传入当前对话的会话 ID 和 CardBush 标识，无需手动填写。' : 'OpenCode: the conversation ID and CardBush user agent are sent automatically.'}</p>}
        <button type="button" className="model-advanced-disclosure" aria-expanded={advanced} onClick={() => setAdvanced(value => !value)}><ChevronDown size={14}/>{zh ? '高级选项' : 'Advanced options'}</button>
        {advanced && <div className="model-advanced-fields">
          {apiProtocol === 'anthropic_messages' && <label className="settings-field"><span>{zh ? '思考参数模式' : 'Thinking parameters'}</span>
            <SettingsDropdown label={zh ? '思考参数模式' : 'Thinking parameters'} value={anthropicThinkingMode} onChange={value => setAnthropicThinkingMode(value as 'adaptive' | 'budget')}
              options={[{ value: 'adaptive', label: zh ? '自适应（较新模型）' : 'Adaptive (newer models)' }, { value: 'budget', label: zh ? 'Token 预算（旧模型）' : 'Token budget (older models)' }]}/>
            <small className="model-field-hint">{zh ? '选择推理强度时使用；未指定强度时遵循服务商默认。' : 'Used when a reasoning effort is selected; otherwise provider defaults apply.'}</small></label>}
          <div className="model-form-grid"><SettingsInput label={zh ? '上下文上限' : 'Context tokens'} type="number" value={context} onChange={setContext}/>
            <SettingsInput label={zh ? '最大输出 tokens' : 'Maximum output tokens'} type="number" value={completion} placeholder={apiProtocol === 'anthropic_messages' ? '8192' : zh ? '供应商默认' : 'Provider default'} onChange={setCompletion}/></div>
          <label className="settings-field"><span>{zh ? '自定义请求头（JSON）' : 'Custom headers (JSON)'}</span><textarea rows={4} value={headers} spellCheck={false} placeholder={'{\n  "x-session-id": "{{sessionId}}"\n}'} onChange={event => { setHeaders(event.currentTarget.value); changedConnection(); }}/></label>
          <p className="model-field-hint">{zh ? '可使用 {{sessionId}} 引用当前对话 ID；同一对话的后续请求保持一致。' : 'Use {{sessionId}} for the stable ID of the current conversation.'}</p>
        </div>}
        {(formError || error) && <p className="settings-inline-error" role="alert">{formError || error}</p>}
      </fieldset>
      <footer className="model-dialog-footer"><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>{zh ? '取消' : 'Cancel'}</button>
        <button type="submit" className="primary-button" disabled={busy || !name.trim() || !provider}>{busy ? zh ? '保存中…' : 'Saving…' : zh ? '保存模型' : 'Save model'}</button></footer>
    </form>
  </dialog>;
}
