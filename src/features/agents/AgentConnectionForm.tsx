import { uiText } from '../../i18n';
import { useEffect, useState, type FormEvent } from 'react';
import { LoaderCircle, Unplug, X } from 'lucide-react';
import type { AgentConnection, AgentConnectionInput } from '../../../electron/agentTypes';
import type { AppLanguage } from '../../types';
import { SshConnectionsPanel, useSshConnections } from '../ssh/SshConnectionsPanel';
import { agentErrorText } from './agentErrorText';

export function AgentConnectionForm({ language, initial, onClose, onSave, onRemove }: {
  language: AppLanguage; initial?: AgentConnection; onClose: () => void; onSave: (value: AgentConnectionInput) => Promise<void>;
  onRemove?: () => Promise<void>;
}) {

  const [name, setName] = useState(initial?.name ?? '');
  const [url, setUrl] = useState(initial?.sshTunnel ? '' : initial?.url ?? '');
  const [token, setToken] = useState('');
  const [tunneled, setTunneled] = useState(initial ? Boolean(initial.sshTunnel) : true);
  const [connectionId, setConnectionId] = useState(initial?.sshTunnel?.connectionId ?? '');
  const [remotePort, setRemotePort] = useState(initial?.sshTunnel?.remotePort ?? 4780);
  const [managingSsh, setManagingSsh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const connections = useSshConnections();
  useEffect(() => { if (!initial && connections.length === 1) setConnectionId(current => current || connections[0].id); }, [connections, initial]);
  const title = initial ? uiText(language)('agentConnectionForm.connectionSettings') : uiText(language)('agentConnectionForm.addAgent');
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await onSave({ id: initial?.id, name, transport: 'http', url: tunneled ? undefined : url, token: token || undefined,
      sshTunnel: tunneled ? { connectionId, remoteHost: initial?.sshTunnel?.remoteHost ?? '127.0.0.1', remotePort } : null }); }
    catch (error) { setError(agentErrorText(error)); } finally { setBusy(false); }
  }
  if (managingSsh) return <div className="agents-modal-backdrop"><div className="agents-modal agents-form" role="dialog" aria-modal="true" aria-label={uiText(language)('agentConnectionForm.ssh')}>
    <header><h2>{uiText(language)('agentConnectionForm.sshConnections')}</h2><button type="button" onClick={() => setManagingSsh(false)}>{uiText(language)('agentConnectionForm.backToAgentSettings')}</button></header>
    <div className="agents-modal-body"><SshConnectionsPanel language={language} compact onConnected={id => { setConnectionId(id); setManagingSsh(false); }}/></div>
  </div></div>;
  return <div className="agents-modal-backdrop"><form className="agents-modal agents-form" role="dialog" aria-modal="true" aria-label={title} onSubmit={submit}>
    <header><h2>{title}</h2><button type="button" disabled={busy} onClick={onClose} aria-label={uiText(language)('common.close')}><X size={18}/></button></header>
    <div className="agents-modal-body">
    <label>{uiText(language)('agentConnectionForm.name')}<input autoFocus required value={name} onChange={event => setName(event.target.value)} placeholder={uiText(language)('agentConnectionForm.agent_a')}/></label>
    <label>{uiText(language)('agentConnectionForm.connectionMethod')}<select value={tunneled ? 'ssh' : 'direct'} onChange={event => {
      const enabled = event.target.value === 'ssh'; setTunneled(enabled);
      if (enabled && !connectionId && connections.length === 1) setConnectionId(connections[0].id);
    }}><option value="ssh">{uiText(language)('agentConnectionForm.sshDirectAutomaticReconnect')}</option><option value="direct">{uiText(language)('agentConnectionForm.http_https')}</option></select></label>
    {tunneled && <>
      <label>{uiText(language)('workspace.connection')}<select required value={connectionId} onChange={event => setConnectionId(event.target.value)}>
        <option value="">{uiText(language)('agentConnectionForm.selectServer')}</option>
        {connections.map(item => <option key={item.id} value={item.id}>{item.name} · {item.username}@{item.host}</option>)}
      </select></label>
      <button type="button" onClick={() => setManagingSsh(true)}>{uiText(language)('workspace.manageConnections')}</button>
      <label>{uiText(language)('agentConnectionForm.agentPortOnTheServer')}<input required type="number" min="1" max="65535" value={remotePort} onChange={event => setRemotePort(Number(event.target.value))}/></label>
    </>}
    {!tunneled && <label>{uiText(language)('agentConnectionForm.serviceAddress')}<input required type="url" disabled={Boolean(initial) && !initial?.sshTunnel} value={url} onChange={event => setUrl(event.target.value)} placeholder={uiText(language)('agentConnectionForm.https_agent_example_com')}/></label>}
    <label>{initial ? uiText(language)('agentConnectionForm.accessTokenLeaveEmptyToKeep') : uiText(language)('agentConnectionForm.accessToken')}<input type="password" required={!initial?.hasToken} autoComplete="off" value={token} onChange={event => setToken(event.target.value)}/></label>
    <p>{uiText(language)('agentConnectionForm.toInstallOrUpdatePluginsAndTheir')}</p>
    <p>{tunneled
      ? uiText(language)('agentConnectionForm.connectDirectlyToTheAgentThroughSsh')
      : uiText(language)('agentConnectionForm.enterTheAgentHttpSAddressAnd')}</p>
    {error && <p className="agents-error" role="alert">{error}</p>}
    </div>
    <footer>{initial && onRemove && <button className="agent-remove-action" type="button" disabled={busy} aria-expanded={confirmRemove} onClick={() => setConfirmRemove(value => !value)}><Unplug size={15}/>{uiText(language)('agentConnectionForm.removeConnection')}</button>}
      <button type="button" disabled={busy} onClick={onClose}>{uiText(language)('agentConnectionForm.cancel')}</button>
      <button type="submit" className="agents-primary" disabled={busy}>{busy && <LoaderCircle className="spin" size={16}/>} {uiText(language)('agentConnectionForm.saveAndConnect')}</button>
    {confirmRemove && onRemove && <div className="agent-connection-removal"><p>{uiText(language)('agentConnectionForm.removeThisConnectionFromThisDeviceThe')}</p>
      <div className="settings-actions"><button type="button" disabled={busy} onClick={() => setConfirmRemove(false)}>{uiText(language)('agentConnectionForm.keepConnection')}</button><button type="button" className="danger" disabled={busy} onClick={() => {
        setBusy(true); setError(''); void onRemove().catch(error => setError(agentErrorText(error))).finally(() => setBusy(false));
      }}>{uiText(language)('agentConnectionForm.confirmRemoval')}</button></div></div>}
    </footer>
  </form></div>;
}
