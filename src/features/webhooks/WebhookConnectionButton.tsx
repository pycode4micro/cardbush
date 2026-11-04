import { useEffect, useRef, useState } from 'react';
import { Copy, Plus, Webhook } from 'lucide-react';
import { uiText } from '../../i18n';
import type { ChatStreamRequest } from '../../backend/api';
import type { ContextWebhookApi, ContextWebhookConfig, ContextWebhookConnection, ContextWebhookSnapshot, WebhookBinding } from '../../../electron/contextWebhookTypes';
import { SettingsFormDialog } from '../settings/SettingsFormDialog';
import { prepareWebhookBinding } from './webhookBinding';
import './webhooks.css';

const defaultBody = { protocol: 'cardbush.webhook.v1', type: '{{type}}', eventId: '{{eventId}}', sequence: '{{sequence}}', messageId: '{{messageId}}', sessionId: '{{sessionId}}',
  conversationId: '{{conversationId}}', senderId: '{{senderId}}', status: '{{status}}', reply: '{{reply}}', errorCode: '{{errorCode}}' };
const defaults = (): ContextWebhookConfig => ({ name: 'Webhook', enabled: true, url: '', headers: {}, parameters: {}, body: defaultBody,
  incoming: { messageId: 'messageId', text: 'text', senderId: 'senderId', conversationId: 'conversationId' } });
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
type Props = { language: string; sessionId: string; title: string; kind: WebhookBinding['kind']; prepare?: () => Promise<ChatStreamRequest> };
export function WebhookConnectionButton(props: Props) {
  const [open, setOpen] = useState(false), t = uiText(props.language);
  const available = Boolean(props.sessionId && props.prepare && window.cardbushDesktop?.webhooks);
  useEffect(() => setOpen(false), [props.sessionId]);
  return <>
    <button type="button" className="topbar-inspector-action icon-only webhook-connect-button" data-webhook-connect
      disabled={!available} aria-label={t('webhook.open')} title={t(available ? 'webhook.open' : 'webhook.unavailable')}
      onClick={() => setOpen(true)}><Webhook aria-hidden="true"/></button>
    {open && available && <WebhookConnectionDialog key={props.sessionId} {...props} onClose={() => setOpen(false)}/>}
  </>;
}
export function WebhookConnectionDialog({ language, sessionId, title, kind, prepare, onClose }: Props & { onClose(): void }) {
  const t = uiText(language), mounted = useRef(true), operation = useRef(false);
  const [snapshot, setSnapshot] = useState<ContextWebhookSnapshot>();
  const [config, setConfig] = useState<ContextWebhookConfig>(defaults);
  const [headers, setHeaders] = useState('{}'), [parameters, setParameters] = useState('{}');
  const [body, setBody] = useState(pretty(defaultBody)), [mapping, setMapping] = useState(pretty(defaults().incoming));
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [notice, setNotice] = useState<Parameters<typeof t>[0] | ''>('');
  const [host, setHost] = useState('127.0.0.1'), [port, setPort] = useState('4791');
  const selected = snapshot?.connections.find(c => c.id === config.id);
  const command = (input: Parameters<ContextWebhookApi['command']>[0]) => window.cardbushDesktop!.webhooks!.command(input);
  const choose = (connection?: ContextWebhookConnection) => {
    const value = connection ?? defaults();
    setConfig({ id: value.id, name: value.name, enabled: value.enabled, url: value.url, headers: value.headers,
      parameters: value.parameters, body: value.body, incoming: value.incoming });
    setHeaders(pretty(value.headers)); setParameters(pretty(value.parameters)); setBody(pretty(value.body)); setMapping(pretty(value.incoming));
    setError(''); setNotice('');
  };
  useEffect(() => {
    mounted.current = true;
    let initial = true;
    const refresh = async () => {
      try {
        const next = await command({ action: 'read', sessionId }) as ContextWebhookSnapshot;
        if (!mounted.current) return;
        setSnapshot(next);
        if (initial) { initial = false; choose(next.connections[0]); setHost(next.host); setPort(String(next.port)); }
      } catch { if (mounted.current) setError('load_failed'); }
      finally { if (mounted.current) setLoading(false); }
    };
    void refresh(); const timer = setInterval(() => void refresh(), 3000);
    return () => { mounted.current = false; clearInterval(timer); };
  }, [sessionId]);
  const draft = (): ContextWebhookConfig => {
    try { return { ...config, headers: JSON.parse(headers), parameters: JSON.parse(parameters), body: JSON.parse(body), incoming: JSON.parse(mapping) }; }
    catch { throw Error('invalid_json'); }
  };
  const perform = async (work: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true;
    setBusy(true); setError(''); setNotice('');
    try { await work(); }
    catch (error) { if (mounted.current) setError(error instanceof Error && /[a-z_0-9]+$/.exec(error.message)?.[0] || 'request_failed'); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  };
  const save = () => perform(async () => {
    const value = draft(); const binding = await prepareWebhookBinding(prepare!, kind, sessionId, title);
    const next = await command({ action: 'save', config: value, binding }) as ContextWebhookSnapshot;
    if (!mounted.current) return;
    const connection = next.connections.find(c => c.id === value.id) ?? next.connections.at(-1);
    setSnapshot(next); choose(connection); setNotice('webhook.saved');
  });
  const copy = (value: string) => perform(async () => { await navigator.clipboard.writeText(value); setNotice('webhook.copied'); });
  return <SettingsFormDialog className="webhook-dialog" title={t('webhook.title')} description={t('webhook.binding', { title })}
    language={language} busy={busy} onCancel={onClose} onSubmit={save} footer={<>
      {selected && <button type="button" className="webhook-delete" disabled={busy || loading} onClick={() => void perform(async () => {
        const next = await command({ action: 'delete', id: selected.id, sessionId }) as ContextWebhookSnapshot;
        setSnapshot(next); choose(next.connections[0]); setNotice('webhook.deleted');
      })}>{t('webhook.delete')}</button>}
      <button type="button" disabled={busy || loading || !config.url} onClick={() => void perform(async () => {
        await command({ action: 'test', config: draft(), text: t('webhook.testMessage') }); setNotice('webhook.testPassed');
      })}>{t('webhook.test')}</button>
      <button type="submit" disabled={busy || loading}>{t(busy ? 'webhook.saving' : 'webhook.save')}</button>
    </>}>
    {loading && <p role="status">{t('common.loading')}</p>}
    <fieldset disabled={busy || loading}>
      <div className="webhook-name-row"><label>{t('webhook.name')}<input name="webhook-name" value={config.name} maxLength={80} required onChange={event => setConfig({ ...config, name: event.target.value })}/></label>
        <label className="webhook-toggle"><input type="checkbox" role="switch" checked={config.enabled} onChange={event => setConfig({ ...config, enabled: event.target.checked })}/><span>{t('webhook.enabled')}</span></label></div>
      <label>{t('webhook.replyUrl')}<input name="webhook-url" type="url" value={config.url} onChange={event => setConfig({ ...config, url: event.target.value })}/></label>
      <p className="webhook-note">{t('webhook.replyHelp')}</p>
      {selected && <section className="webhook-endpoint">
        <div className="webhook-status" data-active={Boolean(snapshot?.listening && selected.enabled)} role="status"><span>{t(snapshot?.listening && selected.enabled ? 'webhook.listening' : 'webhook.paused')}</span>
          {selected.pending > 0 && <span>{t('webhook.pending', { count: new Intl.NumberFormat(language).format(selected.pending) })}</span>}</div>
        <label>{t('webhook.receiveUrl')}<div className="webhook-copy"><input readOnly value={selected.endpoint}/><button type="button" aria-label={t('webhook.copyUrl')} onClick={() => void copy(selected.endpoint)}><Copy/></button></div></label>
        <label>{t('webhook.token')}<div className="webhook-copy"><input readOnly type="password" value={selected.token}/><button type="button" aria-label={t('webhook.copyToken')} onClick={() => void copy(selected.token)}><Copy/></button></div></label>
        <p className="webhook-note">{t('webhook.receiveHelp')}</p>
        {(snapshot?.error || selected.lastError) && <p role="alert">{t('webhook.operationFailed', { code: snapshot?.error || selected.lastError || '' })}</p>}
      </section>}
      {!selected && <p className="webhook-note">{t('webhook.saveToReceive')}</p>}
      <details><summary>{t('webhook.advanced')}</summary><div className="webhook-advanced">
        {!!snapshot?.connections.length && <div className="webhook-selector"><label>{t('webhook.connection')}<select value={config.id ?? ''} onChange={event => choose(snapshot?.connections.find(c => c.id === event.target.value))}>
          <option value="">{t('webhook.new')}</option>{snapshot?.connections.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select></label><button type="button" aria-label={t('webhook.new')} onClick={() => choose()}><Plus/></button></div>}
        <p className="webhook-note">{t('webhook.scope')}</p>
        <p className="webhook-note">{t('webhook.authHelp')}</p>
        <label>{t('webhook.headers')}<textarea name="webhook-headers" rows={3} spellCheck={false} value={headers} onChange={event => setHeaders(event.target.value)}/></label>
        <label>{t('webhook.parameters')}<textarea name="webhook-parameters" rows={3} spellCheck={false} value={parameters} onChange={event => setParameters(event.target.value)}/></label>
        <label>{t('webhook.body')}<textarea name="webhook-body" rows={6} spellCheck={false} value={body} onChange={event => setBody(event.target.value)}/></label>
        <p className="webhook-note">{t('webhook.templateHelp')}</p>
        <label>{t('webhook.mapping')}<textarea name="webhook-mapping" rows={5} spellCheck={false} value={mapping} onChange={event => setMapping(event.target.value)}/></label>
        <p className="webhook-note">{t('webhook.mappingHelp')}</p>
        <div className="webhook-listener"><label>{t('webhook.host')}<select value={host} onChange={event => setHost(event.target.value)}>
          <option value="127.0.0.1">127.0.0.1</option><option value="0.0.0.0">0.0.0.0</option><option value="::1">::1</option>
        </select></label><label>{t('webhook.port')}<input type="number" min={1024} max={65535} value={port} onChange={event => setPort(event.target.value)}/></label></div>
        <button type="button" onClick={() => void perform(async () => {
          const next = await command({ action: 'listener', sessionId, host, port: Number(port) }) as ContextWebhookSnapshot;
          setSnapshot(next); setNotice('webhook.listenerSaved');
        })}>{t('webhook.applyListener')}</button>
        <p className="webhook-note">{t('webhook.networkHelp')}</p>
        <details><summary>{t('webhook.example')}</summary><pre>{pretty({ messageId: 'm-001', conversationId: 'chat-001', senderId: 'user-001', text: t('webhook.exampleText') })}</pre><p className="webhook-note">{t('webhook.protocolHelp')}</p></details>
      </div></details>
    </fieldset>
    {error && <p className="webhook-error" role="alert">{error === 'load_failed' ? t('webhook.loadFailed') : t('webhook.operationFailed', { code: error })}</p>}
    {notice && <p role="status">{t(notice)}</p>}
  </SettingsFormDialog>;
}
