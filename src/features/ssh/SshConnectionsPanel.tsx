import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Folder, Plus, RefreshCw, Server, Trash2 } from 'lucide-react';
import type { SshConnection, SshConnectionInput, SshTestResult } from '@cardbush/bush-protocol';
import type { AppLanguage, ProjectItem } from '../../types';
import './ssh.css';

export const sshChanged = () => window.dispatchEvent(new Event('cardbush-ssh-changed'));
export function useSshConnections(enabled = true) {
  const [connections, setConnections] = useState<SshConnection[]>([]);
  useEffect(() => {
    if (!enabled) return;
    let active = true, generation = 0;
    const refresh = () => {
      const request = ++generation;
      void window.cardbushDesktop?.sshConnections?.list().then(items => {
        if (active && request === generation) setConnections(items);
      }).catch(() => {});
    };
    refresh();
    window.addEventListener('cardbush-ssh-changed', refresh);
    return () => { active = false; window.removeEventListener('cardbush-ssh-changed', refresh); };
  }, [enabled]);
  return enabled ? connections : [];
}
const empty: SshConnectionInput = { name: '', host: '', port: 22, username: '', authentication: 'agent', defaultDirectory: '/' };
export function SshConnectionsPanel({language,projects=[],compact=false,onEditingChange,onConnected}: {language: AppLanguage; projects?: ProjectItem[]; compact?: boolean; onEditingChange?: (editing: boolean) => void; onConnected?: (id: string, directory: string) => void}) {
  const zh=language==='zh', connections=useSshConnections();
  const [form,setForm]=useState<SshConnectionInput|null>(null), [busy,setBusy]=useState(false), [error,setError]=useState('');
  const [result,setResult]=useState<{id:string;value:SshTestResult}|null>(null), [removing,setRemoving]=useState('');
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const editing = form !== null;
  useEffect(() => { onEditingChange?.(editing); }, [editing, onEditingChange]);
  useEffect(() => () => onEditingChange?.(false), [onEditingChange]);
  const api=window.cardbushDesktop?.sshConnections;
  const change=(patch:Partial<SshConnectionInput>)=>setForm(value=>value?{...value,...patch}:value);
  async function run(operation:()=>Promise<void>) {setBusy(true);setError('');try{await operation();sshChanged();}catch(error){setError(String((error as Error).message));}finally{setBusy(false);}}
  async function testConnection(id: string) {
    if (!api) return;
    const value = await api.test(id);
    if (!mounted.current) return;
    setResult({ id, value });
    if (value.ok) onConnected?.(id, value.directory ?? connections.find(item => item.id === id)?.defaultDirectory ?? '/');
  }
  async function test(id:string) {if(!api)return;await run(()=>testConnection(id));}
  const startNew = () => { setForm({...empty}); setResult(null); setError(''); };
  return <div className={compact ? 'ssh-settings ssh-settings-compact' : 'ssh-settings'}>
    {!compact ? <div className="ssh-section-heading"><div><h3>{zh?'SSH 连接':'SSH connections'}</h3><p>{zh?'保存连接，在项目或输入框 @ 中选择远程环境。支持 Linux / POSIX 主机。':'Save connections for projects and @ references. Supports Linux / POSIX hosts.'}</p></div><button className="ssh-add-connection" type="button" disabled={busy||!api} onClick={startNew}><Plus size={15}/><span>{zh?'新增连接':'Add connection'}</span></button></div>
      : !form && <button className="ssh-compact-add" type="button" disabled={busy||!api} onClick={startNew}><Plus size={16}/><span>{zh?'新增连接':'Add connection'}</span></button>}
    {error&&<p className="ssh-error" role="alert">{error}</p>}
    {!api&&<p>{zh?'SSH 连接需要桌面客户端。':'SSH connections require the desktop app.'}</p>}
    {connections.length===0&&!form&&<div className="ssh-empty">{!compact&&<Server size={28}/>}<p>{compact?(zh?'添加连接后即可选择远程项目。':'Add a connection to choose a remote project.'):(zh?'尚未添加 SSH 连接':'No SSH connections yet')}</p></div>}
    {(!compact||!form)&&connections.map(connection=><div className="ssh-connection" key={connection.id}>
      <Server size={20}/><div className="ssh-connection-info"><strong>{connection.name}</strong><span>{connection.username}@{connection.host}:{connection.port}</span><small>{connection.status==='connected'?(zh?'已连接':'Connected'):(zh?'未连接':'Disconnected')} · {projects.filter(project=>project.rootPath.startsWith(`ssh://${connection.id}/`)).length} {zh?'个项目':'projects'}</small></div>
      <div className="ssh-actions"><button type="button" disabled={busy} onClick={()=>void test(connection.id)}><RefreshCw size={14}/>{zh?'测试':'Test'}</button><button type="button" disabled={busy} onClick={()=>{setForm({...connection});setResult(null);setError('');}}>{zh?'编辑':'Edit'}</button><button type="button" disabled={busy} aria-label={zh?'移除连接':'Remove connection'} onClick={()=>setRemoving(connection.id)}><Trash2 size={14}/></button></div>
      {removing===connection.id&&<div className="ssh-wide"><p>{zh?'移除后，关联项目需要重新选择连接。远程文件和聊天记录保留。':'Linked projects will need another connection. Remote files and chat history are retained.'}</p><button type="button" disabled={busy} onClick={()=>void run(async()=>{await api!.remove(connection.id);setRemoving('');if(form?.id===connection.id)setForm(null);})}>{zh?'移除连接':'Remove connection'}</button><button type="button" onClick={()=>setRemoving('')}>{zh?'取消':'Cancel'}</button></div>}
      {result?.id===connection.id&&<div className="ssh-wide" role="status">{result.value.ok?<p>{zh?'连接成功，目录：':'Connected: '}{result.value.directory}</p>:<><p className="ssh-error">{result.value.error}</p>{result.value.fingerprint&&<code>{result.value.fingerprint}</code>}{result.value.needsTrust&&<button type="button" disabled={busy} onClick={()=>void run(async()=>{await api!.save({...connection,fingerprint:result.value.fingerprint});await testConnection(connection.id);})}>{zh?'信任此主机指纹并连接':'Trust this host fingerprint and connect'}</button>}</>}</div>}
    </div>)}
    {form&&<form className="ssh-form" onSubmit={event=>{event.preventDefault();void run(async()=>{await api!.save(form);setForm(null);});}}>
      <div className="ssh-form-heading">{compact&&<button type="button" disabled={busy} aria-label={zh?'返回连接列表':'Back to connections'} onClick={()=>{setForm(null);setError('');}}><ArrowLeft size={16}/></button>}<h4>{form.id?(zh?'编辑连接':'Edit connection'):(zh?'新增连接':'Add connection')}</h4></div>
      <label>{zh?'名称':'Name'}<input autoFocus required value={form.name} onChange={event=>change({name:event.target.value})} placeholder={zh?'例如：开发服务器':'Development server'}/></label>
      <div className="ssh-form-pair"><label>{zh?'主机':'Host'}<input required disabled={!!form.id} value={form.host} onChange={event=>change({host:event.target.value})} placeholder="192.168.1.10"/></label><label>{zh?'端口':'Port'}<input required disabled={!!form.id} type="number" min="1" max="65535" value={form.port} onChange={event=>change({port:Number(event.target.value)})}/></label></div>
      <label>{zh?'用户':'User'}<input required disabled={!!form.id} value={form.username} onChange={event=>change({username:event.target.value})} autoComplete="off"/></label>
      <label>{zh?'认证方式':'Authentication'}<select value={form.authentication} onChange={event=>change({authentication:event.target.value as SshConnectionInput['authentication']})}><option value="agent">SSH Agent</option><option value="key">{zh?'私钥文件':'Private key'}</option><option value="password">{zh?'密码':'Password'}</option></select></label>
      {form.authentication==='key'&&<><label>{zh?'私钥路径':'Private key path'}<div className="ssh-input-action"><input required value={form.privateKeyPath??''} onChange={event=>change({privateKeyPath:event.target.value})}/><button type="button" aria-label={zh?'选择私钥文件':'Choose private key file'} onClick={()=>void api?.pickKey().then(path=>{if(path)change({privateKeyPath:path});})}><Folder size={16}/></button></div></label><label>{form.id?(zh?'密钥口令（留空保留）':'Passphrase (leave empty to keep)'):(zh?'密钥口令（可选）':'Passphrase (optional)')}<input type="password" autoComplete="new-password" value={form.passphrase??''} onChange={event=>change({passphrase:event.target.value||undefined})}/></label></>}
      {form.authentication==='password'&&<label>{form.id?(zh?'密码（留空保留）':'Password (leave empty to keep)'):(zh?'密码':'Password')}<input type="password" autoComplete="new-password" required={!form.id} value={form.password??''} onChange={event=>change({password:event.target.value||undefined})}/></label>}
      <label>{zh?'默认远程目录':'Default remote directory'}<input required value={form.defaultDirectory} onChange={event=>change({defaultDirectory:event.target.value})} placeholder="/home/user/projects"/></label>
      {form.fingerprint&&<label>{zh?'已信任的主机指纹':'Trusted host fingerprint'}<code>{form.fingerprint}</code></label>}
      <div className="ssh-actions ssh-form-actions"><button type="button" disabled={busy} onClick={()=>{setForm(null);setError('');}}>{zh?'取消':'Cancel'}</button><button className="ssh-primary" disabled={busy} type="submit">{busy?(zh?'保存中…':'Saving…'):(zh?'保存连接':'Save connection')}</button></div>
    </form>}
  </div>;
}
