import { useEffect, useRef, useState } from 'react';
import type { McpUserRequest } from '../../../electron/mcpDesktopHost';
import './mcp-integration.css';

export function McpUserRequests({ language }: { language: 'zh' | 'en' }) {
  const [requests, setRequests] = useState<McpUserRequest[]>([]);
  useEffect(() => {
    const bridge = window.cardbushDesktop;
    if (!bridge?.mcpRequests) return;
    let disposed = false, revision = 0;
    const refresh = () => { const next = ++revision; void bridge.mcpRequests().then(value => { if (!disposed && revision === next) setRequests(value); }).catch(() => undefined); };
    const unsubscribe = bridge.onMcpRequestsChanged(refresh);
    refresh();
    return () => { disposed = true; unsubscribe(); };
  }, []);
  return requests[0] ? <McpRequestForm key={requests[0].id} request={requests[0]} zh={language === 'zh'} /> : null;
}

function McpRequestForm({ request, zh }: { request: McpUserRequest; zh: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const schema = object(request.params.requestedSchema);
  const properties = object(schema.properties);
  const required = new Set(Array.isArray(schema.required) ? schema.required as string[] : []);
  const authentication = request.params.mode === 'authentication';
  const credentials = request.params.mode === 'client_credentials';
  const [values, setValues] = useState<Record<string, unknown>>(() => Object.fromEntries(Object.entries(properties)
    .filter(([, value]) => object(value).default !== undefined).map(([name, value]) => [name, object(value).default])));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { dialog.current?.showModal(); }, []);
  const answer = async (action: 'accept' | 'decline' | 'cancel') => {
    if (action === 'accept' && !form.current?.reportValidity()) return;
    setBusy(true); setError('');
    try { await window.cardbushDesktop!.answerMcpRequest(request.id, { action, content: values }); }
    catch (caught) { setError(String(caught)); }
    finally { setBusy(false); }
  };
  const update = (name: string, value: unknown) => setValues(current => { const next = { ...current }; if (value === undefined) delete next[name]; else next[name] = value; return next; });
  return <dialog className="mcp-request-dialog" ref={dialog} aria-labelledby="mcp-request-title" onCancel={event => { event.preventDefault(); void answer('cancel'); }}>
    <form ref={form} onSubmit={event => { event.preventDefault(); void answer('accept'); }}>
      <h2 id="mcp-request-title">{credentials ? (zh ? '保存插件 OAuth 凭据' : 'Save plugin OAuth credentials') : authentication ? (zh ? '插件需要登录' : 'Plugin sign-in required') : (zh ? '插件需要你的输入' : 'Plugin needs your input')}</h2>
      <p className="mcp-request-origin">{request.serverId}{request.sessionId && <> · {zh ? '会话' : 'Task'} {request.sessionId.slice(-12)}</>}</p>
      {credentials && <p>{zh ? '密钥保存在本机加密存储中，不会作为工具结果发送给模型。' : 'The secret is encrypted on this device and is not returned to the model.'}<br />{String(request.params.endpoint)}</p>}
      <p>{authentication ? (zh ? '当前工具需要授权。继续后将在浏览器中登录，成功后恢复本次调用。' : 'This tool needs authorization. Continue to sign in in your browser, then resume the pending call.') : String(request.params.message ?? '')}</p>
      {request.params.mode === 'url' ? <div className="mcp-request-url"><code>{String(request.params.url)}</code>
        <button type="button" onClick={() => void window.cardbushDesktop!.openMcpRequestUrl(request.id).catch(caught => setError(String(caught)))}>{zh ? '在浏览器中继续' : 'Continue in browser'}</button>
        <small>{zh ? '完成网页中的操作后，再点击完成。' : 'After completing the browser flow, select Done.'}</small></div>
        : Object.entries(properties).map(([name, raw]) => {
          const field = object(raw);
          const options = choices(field);
          return <label className="mcp-form-field" key={name}><span>{String(field.title ?? name)}{required.has(name) ? ' *' : ''}</span>
            {field.description ? <small>{String(field.description)}</small> : null}
            {field.type === 'boolean' ? <select value={values[name] === undefined ? '' : String(values[name])} required={required.has(name)} onChange={event => update(name, event.target.value === '' ? undefined : event.target.value === 'true')}>
              <option value="">{zh ? '请选择' : 'Select'}</option><option value="true">{zh ? '是' : 'Yes'}</option><option value="false">{zh ? '否' : 'No'}</option></select>
              : field.type === 'array' ? <select multiple value={Array.isArray(values[name]) ? values[name] as string[] : []} required={required.has(name)} onChange={event => update(name, [...event.target.selectedOptions].map(item => item.value))}>
                {(choices(object(field.items)) ?? []).map(item => <option key={String(item.value)} value={String(item.value)}>{String(item.title ?? item.value)}</option>)}</select>
              : options ? <select value={String(values[name] ?? '')} required={required.has(name)} onChange={event => update(name, event.target.value || undefined)}>
                <option value="">{zh ? '请选择' : 'Select'}</option>{options.map(item => <option key={String(item.value)} value={String(item.value)}>{String(item.title ?? item.value)}</option>)}</select>
              : <input type={credentials && name === 'clientSecret' ? 'password' : field.type === 'number' || field.type === 'integer' ? 'number' : field.format === 'email' ? 'email' : field.format === 'uri' ? 'url' : 'text'} autoComplete={credentials ? 'off' : undefined}
                value={String(values[name] ?? '')} required={required.has(name)} min={typeof field.minimum === 'number' ? field.minimum : undefined}
                max={typeof field.maximum === 'number' ? field.maximum : undefined} step={field.type === 'integer' ? 1 : 'any'}
                minLength={typeof field.minLength === 'number' ? field.minLength : undefined} maxLength={typeof field.maxLength === 'number' ? field.maxLength : undefined}
                onChange={event => update(name, event.target.value === '' ? undefined : field.type === 'number' || field.type === 'integer' ? Number(event.target.value) : event.target.value)} />}
          </label>;
        })}
      {error && <p role="alert">{error}</p>}
      <footer><button type="button" disabled={busy} onClick={() => void answer('cancel')}>{zh ? '取消' : 'Cancel'}</button>
        <button type="button" disabled={busy} onClick={() => void answer('decline')}>{zh ? '拒绝' : 'Decline'}</button>
        <button type="submit" disabled={busy}>{authentication ? (zh ? '继续登录' : 'Continue to sign in') : (zh ? '完成' : 'Done')}</button></footer>
    </form>
  </dialog>;
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function choices(schema: Record<string, unknown>) {
  if (Array.isArray(schema.enum)) return schema.enum.map((value, i) => ({ value, title: (Array.isArray(schema.enumNames) ? schema.enumNames[i] : undefined) ?? value }));
  const variants = schema.oneOf ?? schema.anyOf;
  return Array.isArray(variants) ? variants.map(item => ({ value: object(item).const, title: object(item).title })) : undefined;
}
