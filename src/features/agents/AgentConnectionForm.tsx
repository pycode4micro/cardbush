import { useState, type FormEvent } from 'react';
import { LoaderCircle, X } from 'lucide-react';
import type { AgentConnection, AgentConnectionInput } from '../../../electron/agentTypes';
import type { AppLanguage } from '../../types';
import { SshConnectionsPanel, useSshConnections } from '../ssh/SshConnectionsPanel';
import { agentErrorText } from './agentErrorText';

export function AgentConnectionForm({ language, initial, onClose, onSave }: {
  language: AppLanguage; initial?: AgentConnection; onClose: () => void; onSave: (value: AgentConnectionInput) => Promise<void>;
}) {
  const zh = language === 'zh';
  const [name, setName] = useState(initial?.name ?? '');
  const [url, setUrl] = useState(initial?.url ?? '');
  const [token, setToken] = useState('');
  const [tunneled, setTunneled] = useState(Boolean(initial?.sshTunnel));
  const [connectionId, setConnectionId] = useState(initial?.sshTunnel?.connectionId ?? '');
  const [remotePort, setRemotePort] = useState(initial?.sshTunnel?.remotePort ?? 4780);
  const [managingSsh, setManagingSsh] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const connections = useSshConnections();
  const title = initial ? zh ? '连接设置' : 'Connection settings' : zh ? '添加 Agent' : 'Add Agent';
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await onSave({ id: initial?.id, name, transport: 'http', url, token: token || undefined,
      sshTunnel: tunneled ? { connectionId, remoteHost: initial?.sshTunnel?.remoteHost ?? '127.0.0.1', remotePort } : null }); }
    catch (error) { setError(agentErrorText(error)); } finally { setBusy(false); }
  }
  if (managingSsh) return <div className="agents-modal-backdrop"><div className="agents-modal agents-form" role="dialog" aria-modal="true" aria-label="SSH">
    <header><h2>{zh ? 'SSH 连接' : 'SSH connections'}</h2><button type="button" onClick={() => setManagingSsh(false)}>{zh ? '返回 Agent 设置' : 'Back to Agent settings'}</button></header>
    <SshConnectionsPanel language={language} compact onConnected={id => { setConnectionId(id); setManagingSsh(false); }}/>
  </div></div>;
  return <div className="agents-modal-backdrop"><form className="agents-modal agents-form" role="dialog" aria-modal="true" aria-label={title} onSubmit={submit}>
    <header><h2>{title}</h2><button type="button" disabled={busy} onClick={onClose} aria-label={zh ? '关闭' : 'Close'}><X size={18}/></button></header>
    <label>{zh ? '名称' : 'Name'}<input autoFocus required value={name} onChange={event => setName(event.target.value)} placeholder="Agent A"/></label>
    <label>{zh ? '连接方式' : 'Connection method'}<select value={tunneled ? 'ssh' : 'direct'} onChange={event => {
      const enabled = event.target.value === 'ssh'; setTunneled(enabled);
      if (!initial && !url && enabled) setUrl('http://127.0.0.1:14780');
      if (enabled && !connectionId && connections.length === 1) setConnectionId(connections[0].id);
    }}><option value="direct">HTTP / HTTPS</option><option value="ssh">{zh ? 'SSH 隧道（自动连接）' : 'SSH tunnel (automatic)'}</option></select></label>
    {tunneled && <>
      <label>{zh ? 'SSH 连接' : 'SSH connection'}<select required value={connectionId} onChange={event => setConnectionId(event.target.value)}>
        <option value="">{zh ? '选择服务器' : 'Select server'}</option>
        {connections.map(item => <option key={item.id} value={item.id}>{item.name} · {item.username}@{item.host}</option>)}
      </select></label>
      <button type="button" onClick={() => setManagingSsh(true)}>{zh ? '管理 SSH 连接' : 'Manage SSH connections'}</button>
      <label>{zh ? '服务器上的 Agent 端口' : 'Agent port on the server'}<input required type="number" min="1" max="65535" value={remotePort} onChange={event => setRemotePort(Number(event.target.value))}/></label>
    </>}
    <label>{tunneled ? zh ? '本机转发地址' : 'Local forwarding address' : zh ? '服务地址' : 'Service address'}<input required type="url" disabled={Boolean(initial) && !tunneled} value={url} onChange={event => setUrl(event.target.value)} placeholder={tunneled ? 'http://127.0.0.1:14780' : 'https://agent.example.com'}/></label>
    <label>{initial ? zh ? '访问令牌（留空保留）' : 'Access token (leave empty to keep)' : zh ? '访问令牌' : 'Access token'}<input type="password" required={!initial?.hasToken} autoComplete="off" value={token} onChange={event => setToken(event.target.value)}/></label>
    <p>{tunneled
      ? zh ? 'CardBush 会自动建立隧道、断线重连，并在下次启动时恢复。关闭应用仅结束本机隧道，服务器上的任务继续运行。' : 'CardBush creates and reconnects the tunnel, including after restarting the app. Closing the app only closes the local tunnel; remote tasks continue.'
      : zh ? '填写 Agent 的 HTTP(S) 地址和 access-token。本机服务可使用 HTTP，远程服务使用 HTTPS。' : 'Enter the Agent HTTP(S) address and access-token. Use HTTP locally or HTTPS remotely.'}</p>
    {error && <p className="agents-error" role="alert">{error}</p>}
    <footer><button type="button" disabled={busy} onClick={onClose}>{zh ? '取消' : 'Cancel'}</button><button className="agents-primary" disabled={busy}>{busy && <LoaderCircle className="spin" size={16}/>} {zh ? '保存并连接' : 'Save and connect'}</button></footer>
  </form></div>;
}
