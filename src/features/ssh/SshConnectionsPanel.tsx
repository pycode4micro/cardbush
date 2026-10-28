import { uiText } from '../../i18n';
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
  const connections=useSshConnections();
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
  return <div className={compact ? 'ssh-settings ssh-settings-compact' : 'ssh-settings settings-surface'}>
    {!compact ? <div className="ssh-section-heading"><div><h3>{uiText(language)('sshConnectionsPanel.savedConnections')}</h3><p>{uiText(language)('sshConnectionsPanel.saveConnectionsForProjectsAndReferencesSupports')}</p></div><button className="ssh-add-connection" type="button" disabled={busy||!api} onClick={startNew}><Plus size={15}/><span>{uiText(language)('sshConnectionsPanel.addConnection')}</span></button></div>
      : !form && <button className="ssh-compact-add" type="button" disabled={busy||!api} onClick={startNew}><Plus size={16}/><span>{uiText(language)('sshConnectionsPanel.addConnection')}</span></button>}
    {error&&<p className="ssh-error" role="alert">{error}</p>}
    {!api&&<p>{uiText(language)('sshConnectionsPanel.sshConnectionsRequireTheDesktopApp')}</p>}
    {connections.length===0&&!form&&<div className="ssh-empty">{!compact&&<Server size={28}/>}<p>{compact?(uiText(language)('sshConnectionsPanel.addAConnectionToChooseARemote')):(uiText(language)('sshConnectionsPanel.noSshConnectionsYet'))}</p></div>}
    {(!compact||!form)&&connections.map(connection=><div className="ssh-connection" key={connection.id}>
      <Server size={20}/><div className="ssh-connection-info"><strong>{connection.name}</strong><span>{connection.username}@{connection.host}:{connection.port}</span><small>{connection.status==='connected'?(uiText(language)('browserConnectionSettings.connected')):(uiText(language)('pluginMcpSettings.disconnected'))} · {projects.filter(project=>project.rootPath.startsWith(`ssh://${connection.id}/`)).length} {uiText(language)('sshConnectionsPanel.projects')}</small></div>
      <div className="ssh-actions"><button type="button" disabled={busy} onClick={()=>void test(connection.id)}><RefreshCw size={14}/>{uiText(language)('sshConnectionsPanel.test')}</button><button type="button" disabled={busy} onClick={()=>{setForm({...connection});setResult(null);setError('');}}>{uiText(language)('common.edit')}</button><button type="button" disabled={busy} aria-label={uiText(language)('browserConnectionSettings.removeConnection')} onClick={()=>setRemoving(connection.id)}><Trash2 size={14}/></button></div>
      {removing===connection.id&&<div className="ssh-wide"><p>{uiText(language)('sshConnectionsPanel.linkedProjectsWillNeedAnotherConnectionRemote')}</p><button type="button" disabled={busy} onClick={()=>void run(async()=>{await api!.remove(connection.id);setRemoving('');if(form?.id===connection.id)setForm(null);})}>{uiText(language)('browserConnectionSettings.removeConnection')}</button><button type="button" onClick={()=>setRemoving('')}>{uiText(language)('agentConnectionForm.cancel')}</button></div>}
      {result?.id===connection.id&&<div className="ssh-wide" role="status">{result.value.ok?<p>{uiText(language)('sshConnectionsPanel.connected')}{result.value.directory}</p>:<><p className="ssh-error">{result.value.error}</p>{result.value.fingerprint&&<code>{result.value.fingerprint}</code>}{result.value.needsTrust&&<button type="button" disabled={busy} onClick={()=>void run(async()=>{await api!.save({...connection,fingerprint:result.value.fingerprint});await testConnection(connection.id);})}>{uiText(language)('sshConnectionsPanel.trustThisHostFingerprintAndConnect')}</button>}</>}</div>}
    </div>)}
    {form&&<form className="ssh-form" onSubmit={event=>{event.preventDefault();void run(async()=>{await api!.save(form);setForm(null);});}}>
      <div className="ssh-form-heading">{compact&&<button type="button" disabled={busy} aria-label={uiText(language)('sshConnectionsPanel.backToConnections')} onClick={()=>{setForm(null);setError('');}}><ArrowLeft size={16}/></button>}<h4>{form.id?(uiText(language)('sshConnectionsPanel.editConnection')):(uiText(language)('sshConnectionsPanel.addConnection'))}</h4></div>
      <label>{uiText(language)('agentConnectionForm.name')}<input autoFocus required value={form.name} onChange={event=>change({name:event.target.value})} placeholder={uiText(language)('sshConnectionsPanel.developmentServer')}/></label>
      <div className="ssh-form-pair"><label>{uiText(language)('sshConnectionsPanel.host')}<input required disabled={!!form.id} value={form.host} onChange={event=>change({host:event.target.value})} placeholder={uiText(language)('sshConnectionsPanel.192_168_1_10')}/></label><label>{uiText(language)('sshConnectionsPanel.port')}<input required disabled={!!form.id} type="number" min="1" max="65535" value={form.port} onChange={event=>change({port:Number(event.target.value)})}/></label></div>
      <label>{uiText(language)('pluginManagementPanel.user')}<input required disabled={!!form.id} value={form.username} onChange={event=>change({username:event.target.value})} autoComplete="off"/></label>
      <label>{uiText(language)('sshConnectionsPanel.authentication')}<select value={form.authentication} onChange={event=>change({authentication:event.target.value as SshConnectionInput['authentication']})}><option value="agent">{uiText(language)('sshConnectionsPanel.ssh_agent')}</option><option value="key">{uiText(language)('sshConnectionsPanel.privateKey')}</option><option value="password">{uiText(language)('sshConnectionsPanel.password')}</option></select></label>
      {form.authentication==='key'&&<><label>{uiText(language)('sshConnectionsPanel.privateKeyPath')}<div className="ssh-input-action"><input required value={form.privateKeyPath??''} onChange={event=>change({privateKeyPath:event.target.value})}/><button type="button" aria-label={uiText(language)('sshConnectionsPanel.choosePrivateKeyFile')} onClick={()=>void api?.pickKey().then(path=>{if(path)change({privateKeyPath:path});})}><Folder size={16}/></button></div></label><label>{form.id?(uiText(language)('sshConnectionsPanel.passphraseLeaveEmptyToKeep')):(uiText(language)('sshConnectionsPanel.passphraseOptional'))}<input type="password" autoComplete="new-password" value={form.passphrase??''} onChange={event=>change({passphrase:event.target.value||undefined})}/></label></>}
      {form.authentication==='password'&&<label>{form.id?(uiText(language)('sshConnectionsPanel.passwordLeaveEmptyToKeep')):(uiText(language)('sshConnectionsPanel.password'))}<input type="password" autoComplete="new-password" required={!form.id} value={form.password??''} onChange={event=>change({password:event.target.value||undefined})}/></label>}
      <label>{uiText(language)('sshConnectionsPanel.defaultRemoteDirectory')}<input required value={form.defaultDirectory} onChange={event=>change({defaultDirectory:event.target.value})} placeholder={uiText(language)('sshConnectionsPanel.homeUserProjectsOrCUsersName')}/></label>
      {form.fingerprint&&<label>{uiText(language)('sshConnectionsPanel.trustedHostFingerprint')}<code>{form.fingerprint}</code></label>}
      <div className="ssh-actions ssh-form-actions"><button type="button" disabled={busy} onClick={()=>{setForm(null);setError('');}}>{uiText(language)('agentConnectionForm.cancel')}</button><button className="ssh-primary" disabled={busy} type="submit">{busy?(uiText(language)('automationPanel.saving')):(uiText(language)('sshConnectionsPanel.saveConnection'))}</button></div>
    </form>}
  </div>;
}
