import { useEffect, useState, type FormEvent } from 'react';
import { Plus, RefreshCw, X } from 'lucide-react';
import { DEFAULT_MAX_CONTEXT_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS } from '@cardbush/bush-protocol';
import { api, requestId } from './api';

type Model = { id: string; name: string; model: string; baseURL: string; apiProtocol: string; enabled: boolean;
  maxContextTokens: number; maxOutputTokens: number; reasoningEffort: string | null; hasApiKey: boolean };
type Settings = { revision: number; defaultModelId: string; models: Model[]; imageModel: { model: string; hasApiKey: boolean } | null };
const errorText = (error: unknown) => error instanceof Error ? error.message : '保存未完成，请重试。';
const efforts: Record<string, string> = { default: '由服务商决定', none: '不思考', low: '低', medium: '中', high: '高', xhigh: '更高', max: '最高' };
const protocols: Record<string, string> = { openai_responses: 'OpenAI Responses', openai_chat_completions: 'OpenAI Chat Completions', anthropic_messages: 'Anthropic Messages' };
const editable = ({ hasApiKey: _, ...model }: Model) => model;

export function ModelAdmin() {
  const [settings, setSettings] = useState<Settings | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [editor, setEditor] = useState<Model | 'new' | null>(null), [removal, setRemoval] = useState<Model | null>(null);
  async function refresh() {
    setError('');
    try { setSettings(await api<Settings>('/admin/models')); setEditor(null); setRemoval(null); }
    catch (reason) { setError(errorText(reason)); }
  }
  useEffect(() => { void refresh(); }, []);
  async function change(input: Record<string, unknown>) {
    if (!settings) return false;
    setBusy(true); setError(''); setNotice('');
    try {
      setSettings(await api<Settings>('/admin/models', 'POST', { ...input, revision: settings.revision }));
      setEditor(null); setRemoval(null); setNotice('已保存，后续请求将使用新配置。');
      window.dispatchEvent(new Event('cardbush:models-changed')); return true;
    } catch (reason) { setError(errorText(reason)); return false; }
    finally { setBusy(false); }
  }
  return <section className="model-admin"><div className="org-content-heading"><div><h2>模型管理</h2><p className="muted">统一配置对话与生图模型。API 密钥仅保存在服务端，留空表示沿用已有密钥。</p></div><div className="org-actions"><button disabled={busy} onClick={() => void refresh()}><RefreshCw size={14}/>刷新列表</button><button className="primary" disabled={!settings || busy} onClick={() => { setError(''); setEditor('new'); }}><Plus size={15}/>新增模型</button></div></div>
    {error && !editor && !removal && <p className="form-error" role="alert">{error}</p>}{notice && <p className="form-notice" role="status">{notice}</p>}
    {!settings ? <p className="status-line">正在加载模型…</p> : <>
      <div className="model-cards">{settings.models.map(model => <article className="model-card" key={model.id}><header><div><h3>{model.name}</h3><code>{model.model}</code></div><span className={`user-status ${model.enabled ? 'enabled' : ''}`}>{settings.defaultModelId === model.id ? '默认模型' : model.enabled ? '已启用' : '已停用'}</span></header>
        <dl><div><dt>接口协议</dt><dd>{protocols[model.apiProtocol]}</dd></div><div><dt>上下文窗口</dt><dd>{model.maxContextTokens.toLocaleString()} tokens</dd></div><div><dt>最大输出</dt><dd>{model.maxOutputTokens.toLocaleString()} tokens</dd></div><div><dt>思考强度</dt><dd>{efforts[model.reasoningEffort ?? 'default']}</dd></div></dl>
        <p className="model-endpoint">{model.baseURL}</p><footer><span className="muted">密钥{model.hasApiKey ? '已配置' : '未配置'}</span><div className="org-actions"><button disabled={busy} aria-label={`编辑模型 ${model.name}`} onClick={() => { setError(''); setEditor(model); }}>编辑</button>
          {settings.defaultModelId !== model.id && <><button disabled={busy} onClick={() => void change({ action: 'save', model: { ...editable(model), enabled: !model.enabled } })}>{model.enabled ? '停用' : '启用'}</button>{model.enabled && <button disabled={busy} onClick={() => void change({ action: 'default', id: model.id })}>设为默认</button>}<button className="danger" disabled={busy} aria-label={`删除模型 ${model.name}`} onClick={() => { setError(''); setRemoval(model); }}>删除</button></>}</div></footer>
      </article>)}</div>
      <section className="image-model-settings"><h2>生图模型</h2><p className="muted">使用火山图片服务；账号能否生图仍由插件授权决定。</p><ImageModelForm key={`${settings.revision}`} value={settings.imageModel} busy={busy} save={change}/></section>
    </>}
    {editor && <ModelEditor key={typeof editor === 'string' ? editor : editor.id} value={editor === 'new' ? null : editor} isDefault={editor !== 'new' && editor.id === settings?.defaultModelId} busy={busy} error={error} close={() => { if (!busy) { setEditor(null); setError(''); } }} save={model => change({ action: 'save', model })}/>}
    {removal && <div className="modal-backdrop"><section className="modal organization-modal" role="dialog" aria-modal="true" aria-label="删除模型"><h2>删除模型</h2><p>确定删除“{removal.name}”？历史对话仍会保留。</p>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button disabled={busy} onClick={() => setRemoval(null)}>取消</button><button className="primary destructive" disabled={busy} onClick={() => void change({ action: 'delete', id: removal.id })}>确认删除</button></div></section></div>}
  </section>;
}

function ModelEditor({ value, isDefault, busy, error, close, save }: { value: Model | null; isDefault: boolean; busy: boolean; error: string; close: () => void; save: (model: unknown) => Promise<boolean> }) {
  const [id] = useState(value?.id ?? `model_${requestId().replaceAll('-', '').slice(0, 16)}`);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    void save({ id, name: form.get('name'), model: form.get('model'), baseURL: form.get('baseURL'), apiKey: form.get('apiKey'), apiProtocol: form.get('apiProtocol'),
      maxContextTokens: Number(form.get('maxContextTokens')), maxOutputTokens: Number(form.get('maxOutputTokens')),
      reasoningEffort: form.get('reasoningEffort') === 'default' ? null : form.get('reasoningEffort'), enabled: isDefault || form.get('enabled') === 'on' });
  }
  return <div className="modal-backdrop" onClick={close} onKeyDown={event => { if (event.key === 'Escape') close(); }}><section className="modal organization-modal model-modal" role="dialog" aria-modal="true" aria-label={value ? '编辑模型' : '新增模型'} onClick={event => event.stopPropagation()}><header><h2>{value ? '编辑模型' : '新增模型'}</h2><button className="icon-button" aria-label="关闭模型表单" disabled={busy} onClick={close}><X size={18}/></button></header><form onSubmit={submit}><fieldset disabled={busy}>
    <div className="org-form-grid"><label>显示名称<input name="name" autoFocus required maxLength={120} defaultValue={value?.name} placeholder="如：DeepSeek · V4.1 Flash"/></label><label>模型 ID<input name="model" required maxLength={160} defaultValue={value?.model} placeholder="服务商提供的模型 ID"/></label></div>
    <label>API 地址<input name="baseURL" type="url" required maxLength={2048} defaultValue={value?.baseURL ?? 'https://ark.cn-beijing.volces.com/api/v3'}/></label>
    <label>接口协议<select name="apiProtocol" aria-label="接口协议" defaultValue={value?.apiProtocol ?? 'openai_responses'}>{Object.entries(protocols).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    <label>API 密钥<input name="apiKey" type="password" autoComplete="new-password" required={!value?.hasApiKey} maxLength={8192} placeholder={value?.hasApiKey ? '已配置；留空不修改' : '填写服务商密钥'}/></label>
    <div className="org-form-grid"><label>上下文窗口（tokens）<input name="maxContextTokens" type="number" min={2048} max={2000000} step={1} required defaultValue={value?.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS}/></label><label>最大输出（tokens）<input name="maxOutputTokens" type="number" min={1} max={1000000} step={1} required defaultValue={value?.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS}/></label></div>
    <p className="muted org-help">请按模型实际能力填写；最大输出需小于上下文窗口。系统会预留输出空间，并在接近上下文容量时自动整理历史。</p>
    <label>思考强度<select name="reasoningEffort" aria-label="思考强度" defaultValue={value ? value.reasoningEffort ?? 'default' : 'medium'}>{Object.entries(efforts).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
    <label className="org-checkbox"><input name="enabled" type="checkbox" defaultChecked={value?.enabled ?? true} disabled={isDefault}/>启用模型{isDefault && '（当前默认）'}</label>
    {error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" onClick={close}>取消</button><button className="primary" type="submit">{busy ? '正在保存…' : '保存模型'}</button></div>
  </fieldset></form></section></div>;
}

function ImageModelForm({ value, busy, save }: { value: Settings['imageModel']; busy: boolean; save: (input: Record<string, unknown>) => Promise<boolean> }) {
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget);
    void save({ action: 'image', model: form.get('model'), apiKey: form.get('apiKey') });
  }
  return <form onSubmit={submit}><fieldset disabled={busy}><div className="org-form-grid"><label>生图模型 ID<input name="model" required maxLength={160} defaultValue={value?.model ?? 'doubao-seedream-5-0-flash-260915'}/></label><label>生图 API 密钥<input name="apiKey" type="password" autoComplete="new-password" maxLength={8192} required={!value?.hasApiKey} placeholder={value?.hasApiKey ? '已配置；留空不修改' : '填写火山服务密钥'}/></label></div><button className="primary" type="submit">{busy ? '正在保存…' : '保存生图配置'}</button></fieldset></form>;
}
