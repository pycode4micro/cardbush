import { uiText } from '../../i18n';
import { dialogEventHandler } from '../../shared/dialogEvents';
import { useEffect, useRef, useState } from 'react';
import type { McpUserRequest } from '../../../electron/mcpDesktopHost';
import './mcp-integration.css';

export function McpUserRequests({ language }: { language: string }) {
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
  return requests[0] ? <McpRequestForm key={requests[0].id} request={requests[0]} uiLanguage={language} /> : null;
}

function McpRequestForm({ request, uiLanguage }: { request: McpUserRequest; uiLanguage: string }) {
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
  return <dialog className="mcp-request-dialog" ref={dialog} aria-labelledby="mcp-request-title" onCancel={dialogEventHandler(event => { event.preventDefault(); void answer('cancel'); })}>
    <form ref={form} onSubmit={event => { event.preventDefault(); void answer('accept'); }}>
      <h2 id="mcp-request-title">{credentials ? (uiText(uiLanguage)('mcpUserRequests.savePluginOauthCredentials')) : authentication ? (uiText(uiLanguage)('mcpUserRequests.pluginSignInRequired')) : (uiText(uiLanguage)('mcpUserRequests.pluginNeedsYourInput'))}</h2>
      <p className="mcp-request-origin">{request.serverId}{request.sessionId && <> · {uiText(uiLanguage)('mcpUserRequests.task')} {request.sessionId.slice(-12)}</>}</p>
      {credentials && <p>{uiText(uiLanguage)('mcpUserRequests.theSecretIsEncryptedOnThisDevice')}<br />{String(request.params.endpoint)}</p>}
      <p>{authentication ? (uiText(uiLanguage)('mcpUserRequests.thisToolNeedsAuthorizationContinueToSign')) : String(request.params.message ?? '')}</p>
      {request.params.mode === 'url' ? <div className="mcp-request-url"><code>{String(request.params.url)}</code>
        <button type="button" onClick={() => void window.cardbushDesktop!.openMcpRequestUrl(request.id).catch(caught => setError(String(caught)))}>{uiText(uiLanguage)('mcpUserRequests.continueInBrowser')}</button>
        <small>{uiText(uiLanguage)('mcpUserRequests.afterCompletingTheBrowserFlowSelectDone')}</small></div>
        : Object.entries(properties).map(([name, raw]) => {
          const field = object(raw);
          const options = choices(field);
          return <label className="mcp-form-field" key={name}><span>{String(field.title ?? name)}{required.has(name) ? ' *' : ''}</span>
            {field.description ? <small>{String(field.description)}</small> : null}
            {field.type === 'boolean' ? <select value={values[name] === undefined ? '' : String(values[name])} required={required.has(name)} onChange={event => update(name, event.target.value === '' ? undefined : event.target.value === 'true')}>
              <option value="">{uiText(uiLanguage)('mcpUserRequests.select')}</option><option value="true">{uiText(uiLanguage)('subagentAuditSignalsPanel.yes')}</option><option value="false">{uiText(uiLanguage)('subagentAuditSignalsPanel.no')}</option></select>
              : field.type === 'array' ? <select multiple value={Array.isArray(values[name]) ? values[name] as string[] : []} required={required.has(name)} onChange={event => update(name, [...event.target.selectedOptions].map(item => item.value))}>
                {(choices(object(field.items)) ?? []).map(item => <option key={String(item.value)} value={String(item.value)}>{String(item.title ?? item.value)}</option>)}</select>
              : options ? <select value={String(values[name] ?? '')} required={required.has(name)} onChange={event => update(name, event.target.value || undefined)}>
                <option value="">{uiText(uiLanguage)('mcpUserRequests.select')}</option>{options.map(item => <option key={String(item.value)} value={String(item.value)}>{String(item.title ?? item.value)}</option>)}</select>
              : <input type={credentials && name === 'clientSecret' ? 'password' : field.type === 'number' || field.type === 'integer' ? 'number' : field.format === 'email' ? 'email' : field.format === 'uri' ? 'url' : 'text'} autoComplete={credentials ? 'off' : undefined}
                value={String(values[name] ?? '')} required={required.has(name)} min={typeof field.minimum === 'number' ? field.minimum : undefined}
                max={typeof field.maximum === 'number' ? field.maximum : undefined} step={field.type === 'integer' ? 1 : 'any'}
                minLength={typeof field.minLength === 'number' ? field.minLength : undefined} maxLength={typeof field.maxLength === 'number' ? field.maxLength : undefined}
                onChange={event => update(name, event.target.value === '' ? undefined : field.type === 'number' || field.type === 'integer' ? Number(event.target.value) : event.target.value)} />}
          </label>;
        })}
      {error && <p role="alert">{error}</p>}
      <footer><button type="button" disabled={busy} onClick={() => void answer('cancel')}>{uiText(uiLanguage)('agentConnectionForm.cancel')}</button>
        <button type="button" disabled={busy} onClick={() => void answer('decline')}>{uiText(uiLanguage)('mcpUserRequests.decline')}</button>
        <button type="submit" disabled={busy}>{authentication ? (uiText(uiLanguage)('mcpUserRequests.continueToSignIn')) : (uiText(uiLanguage)('composerLayoutSettings.done'))}</button></footer>
    </form>
  </dialog>;
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function choices(schema: Record<string, unknown>) {
  if (Array.isArray(schema.enum)) return schema.enum.map((value, i) => ({ value, title: (Array.isArray(schema.enumNames) ? schema.enumNames[i] : undefined) ?? value }));
  const variants = schema.oneOf ?? schema.anyOf;
  return Array.isArray(variants) ? variants.map(item => ({ value: object(item).const, title: object(item).title })) : undefined;
}
