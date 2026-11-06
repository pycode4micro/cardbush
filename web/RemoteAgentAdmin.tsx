import { uiText, formatMessageList, type MessageKey } from '../src/i18n';
import { useUiLanguage } from '../src/i18n/react';
import { useEffect, useState, type FormEvent } from 'react';
import { Plus, RefreshCw, X, PlugZap } from 'lucide-react';
import { api, requestId, type User } from './api';

type Ssh = { host: string; port: number; username: string; authentication: 'key' | 'password'; fingerprint: string; remotePort: number; hasPrivateKey: boolean; hasPassphrase: boolean; hasPassword: boolean };
type Agent = { id: string; name: string; description: string; url: string; transport?: 'http' | 'ssh'; ssh?: Ssh; enabled: boolean; userIds: string[]; agentId: string; hasToken: boolean; verifiedAt: string; boundUserId?: string };
type Settings = { revision: number; agents: Agent[] };
const errorText = (error: unknown) => error instanceof Error ? error.message : uiText()("web.theOperationFailedPleaseTryAgainLater");
const sshInput = (ssh: Ssh) => ({ host: ssh.host, port: ssh.port, username: ssh.username, authentication: ssh.authentication, fingerprint: ssh.fingerprint, remotePort: ssh.remotePort });
const editable = (agent: Agent) => ({ id: agent.id, name: agent.name, description: agent.description, url: agent.url, transport: agent.transport ?? 'http', ...(agent.ssh ? { ssh: sshInput(agent.ssh) } : {}), enabled: agent.enabled, userIds: agent.userIds });

export function RemoteAgentAdmin({ users }: { users: User[] }) {
  const language = useUiLanguage();

  const [settings, setSettings] = useState<Settings | null>(null), [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<Agent | 'new' | null>(null), [removal, setRemoval] = useState<Agent | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState<MessageKey | ''>('');
  async function refresh() {
    setError('');
    try { setSettings(await api<Settings>('/admin/remote-agents')); }
    catch (reason) { setError(errorText(reason)); }
  }
  useEffect(() => { void refresh(); }, []);
  async function change(input: Record<string, unknown>) {
    if (!settings) return;
    setBusy(true); setError(''); setNotice('');
    try {
      setSettings(await api<Settings>('/admin/remote-agents', 'POST', { ...input, revision: settings.revision }));
      setEditor(null); setRemoval(null); setNotice("web.savedAuthorizedMembersCanUseThisRemoteAgentInConversations");
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }
  return <section className="model-admin remote-agent-admin"><div className="org-content-heading"><div><h2>{uiText(language)("web.remoteAgents")}</h2><p className="muted">{uiText(language)("web.connectToAnIndependentCardbushServiceOverSshOrHttpSAnd")}</p></div><div className="org-actions">
    <button disabled={busy} onClick={() => void refresh()}><RefreshCw size={14}/>{uiText(language)("web.refreshList")}</button>
    <button className="primary" disabled={!settings || busy} onClick={() => { setError(''); setNotice(''); setEditor('new'); }}><Plus size={15}/>{uiText(language)("web.registerRemoteAgent")}</button></div></div>
    <p className="muted org-help">{uiText(language)("web.multipleMembersCanShareARemoteAgentThisWebsiteIsolatesTasksAnd")}</p>
    {error && !editor && !removal && <p className="form-error" role="alert">{error}</p>}{notice && <p className="form-notice" role="status">{uiText(language)(notice)}</p>}
    {!settings ? <p className="status-line">{error ? uiText(language)("web.loadingFailedSelectRefreshToTryAgain") : uiText(language)("web.loadingRemoteAgents")}</p> : <div className="model-cards">{settings.agents.map(agent => <article className="model-card" key={agent.id}><header><div><h3>{agent.name}</h3><code>{agent.id}</code></div><span className={`user-status ${agent.enabled && agent.userIds.length ? 'enabled' : ''}`}>{!agent.enabled ? uiText(language)("pluginManagementPanel.disabled") : agent.userIds.length ? uiText(language)("web.authorized") : uiText(language)("web.notAuthorized")}</span></header>
      {agent.description && <p>{agent.description}</p>}<p className="model-endpoint">{agent.transport === 'ssh' && agent.ssh ? `SSH · ${agent.ssh.username}@${agent.ssh.host}:${agent.ssh.port} → 127.0.0.1:${agent.ssh.remotePort}` : agent.url}</p>
      <dl><div><dt>{uiText(language)("web.authorizedMembers", { count: agent.userIds.length })}</dt><dd>{formatMessageList(language, agent.userIds.map(id => users.find(user => user.id === id)?.display_name ?? uiText(language)("web.deletedMembers"))) || uiText(language)("web.noAccessGranted")}</dd></div><div><dt>{uiText(language)("web.connectionVerification")}</dt><dd>{new Date(agent.verifiedAt).toLocaleString(language)}</dd></div></dl>
      <footer><span className="muted">{uiText(language)("web.connectionCredentialsAreStoredEncrypted")}</span><div className="org-actions"><button disabled={busy} aria-label={uiText(language)("web.editRemoteAgent", { name: agent.name })} onClick={() => { setError(''); setEditor(agent); }}>{uiText(language)("web.editAuthorize")}</button><button disabled={busy} onClick={() => void change({ action: 'save', agent: { ...editable(agent), enabled: !agent.enabled } })}>{agent.enabled ? uiText(language)("pluginMcpSettings.disable") : uiText(language)("automationPanel.enable")}</button><button className="danger" disabled={busy} onClick={() => { setError(''); setRemoval(agent); }}>{uiText(language)("appCenter.delete")}</button></div></footer>
    </article>)}{!settings.agents.length && <p className="org-empty">{uiText(language)("web.noRemoteAgentsRegisteredStartTheRemoteServiceAndConfigureItsDefault")}</p>}</div>}
    {editor && <RemoteEditor value={editor === 'new' ? null : editor} users={users} busy={busy} error={error}
      close={() => { if (!busy) { setEditor(null); setError(''); } }} save={agent => change({ action: 'save', agent })}/>}
    {removal && <div className="modal-backdrop"><section className="modal organization-modal" role="dialog" aria-modal="true" aria-label={uiText(language)("web.deleteRemoteAgent")}><h2>{uiText(language)("web.deleteRemoteAgent")}</h2><p>{uiText(language)("web.removeWebsiteAccessWillBeRevokedTheRemoteServiceAndItsData", { name: removal.name })}</p>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button disabled={busy} onClick={() => setRemoval(null)}>{uiText(language)("agentConnectionForm.cancel")}</button><button className="primary destructive" disabled={busy} onClick={() => void change({ action: 'delete', id: removal.id })}>{uiText(language)("teamGraphWorkspace.delete")}</button></div></section></div>}
  </section>;
}

function RemoteEditor({ value, users, busy, error, close, save }: { value: Agent | null; users: User[]; busy: boolean; error: string; close: () => void; save: (agent: unknown) => Promise<void> }) {
  const language = useUiLanguage();

  const [id] = useState(value?.id ?? 'remote_' + requestId().replaceAll('-', '').slice(0, 20));
  const [testing, setTesting] = useState(false), [testResult, setTestResult] = useState(''), [testError, setTestError] = useState('');
  const [transport, setTransport] = useState<'http' | 'ssh'>(value?.transport ?? (value ? 'http' : 'ssh'));
  const [authentication, setAuthentication] = useState<'key' | 'password'>(value?.ssh?.authentication ?? 'key');
  const [fingerprint, setFingerprint] = useState(value?.ssh?.fingerprint ?? ''), [observed, setObserved] = useState('');
  const [selectedUsers, setSelectedUsers] = useState<string[]>(value?.userIds ?? []), [userQuery, setUserQuery] = useState('');
  const query = userQuery.trim().toLocaleLowerCase();
  const visibleUsers = users.filter(user => !query || [user.display_name, user.username, user.company_name, user.department_name].some(text => text?.toLocaleLowerCase().includes(query)));
  const visibleIds = new Set(visibleUsers.map(user => user.id));
  function selectUsers(next: string[]) { setSelectedUsers(next); setTestResult(''); setTestError(''); }
  const sameAuth = authentication === value?.ssh?.authentication;
  function input(form: HTMLFormElement) {
    const data = new FormData(form);
    return { id, name: String(data.get('name')), description: String(data.get('description') || ''), transport,
      ...(transport === 'ssh' ? { ssh: { host: String(data.get('host') || ''), port: Number(data.get('port')), username: String(data.get('username') || ''), authentication,
        remotePort: Number(data.get('remotePort')), fingerprint, ...(authentication === 'password' ? { password: String(data.get('password') || '') }
          : { privateKey: String(data.get('privateKey') || ''), passphrase: String(data.get('passphrase') || '') }) } } : { url: String(data.get('url') || '') }),
      token: String(data.get('token') || ''), enabled: data.get('enabled') === 'on', userIds: selectedUsers };
  }
  async function test(form: HTMLFormElement) {
    if (!form.reportValidity()) return;
    const agent = input(form); setTesting(true); setTestError(''); setTestResult(''); setObserved('');
    try {
      const result = await api<{ ok: boolean; name?: string; agentId?: string; needsTrust?: boolean; fingerprint?: string }>('/admin/remote-agents', 'POST', { action: 'test', agent });
      if (result.needsTrust && result.fingerprint) setObserved(result.fingerprint);
      else if (result.ok) setTestResult(uiText(language)("web.connectedToRemoteTaskDelegationIsAvailable", { name: result.name ?? result.agentId ?? "" }));
      else setTestError(uiText(language)("web.couldNotVerifyTheConnectionCheckYourConfiguration"));
    } catch (reason) { setTestError(errorText(reason)); }
    finally { setTesting(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void save(input(event.currentTarget)); }
  return <div className="modal-backdrop" onClick={() => { if (!testing) close(); }} onKeyDown={event => { if (event.key === 'Escape' && !testing) close(); }}><section className="modal organization-modal model-modal" role="dialog" aria-modal="true" aria-label={value ? uiText(language)("web.editRemoteAgent2") : uiText(language)("web.registerRemoteAgent")} onClick={event => event.stopPropagation()}><header><h2>{value ? uiText(language)("web.editRemoteAgent2") : uiText(language)("web.registerRemoteAgent")}</h2><button className="icon-button" aria-label={uiText(language)("web.closeRemoteAgentForm")} disabled={busy || testing} onClick={close}><X size={18}/></button></header>
    <form onSubmit={submit} onChange={() => { setTestResult(''); setTestError(''); setObserved(''); }}><fieldset disabled={busy || testing}>
      <label>{uiText(language)("agentConnectionForm.name")}<input name="name" autoFocus required maxLength={120} defaultValue={value?.name} placeholder={uiText(language)("web.forExampleProductResearchAssistant")}/></label>
      <label>{uiText(language)("web.capabilities")}<textarea name="description" rows={2} maxLength={1000} defaultValue={value?.description} placeholder={uiText(language)("web.describeTheTasksThisAgentCanHandleToHelpTheAssistantChoose")}/></label>
      <label>{uiText(language)("agentConnectionForm.connectionMethod")}<select aria-label={uiText(language)("agentConnectionForm.connectionMethod")} value={transport} disabled={Boolean(value)} onChange={event => { setTransport(event.target.value as 'http' | 'ssh'); setFingerprint(''); }}><option value="ssh">{uiText(language)("web.sshTunnel")}</option><option value="http">{uiText(language)("web.directHttpS")}</option></select></label>
      {transport === 'http' ? <label>{uiText(language)("web.remoteServiceAddress")}<input name="url" type="url" required readOnly={Boolean(value)} maxLength={2048} defaultValue={value?.url} placeholder={uiText(language)("web.httpsAgentExampleComOrHttp1921681204780")}/></label> : <>
        <label>{uiText(language)("web.sshServer")}<input name="host" required readOnly={Boolean(value)} maxLength={253} defaultValue={value?.ssh?.host} placeholder={uiText(language)("web.remoteServerIpOrHostname")} onChange={() => setFingerprint('')}/></label>
        <label>{uiText(language)("web.sshPort")}<input name="port" type="number" required readOnly={Boolean(value)} min={1} max={65535} defaultValue={value?.ssh?.port ?? 22} onChange={() => setFingerprint('')}/></label>
        <label>{uiText(language)("web.sshUsername")}<input name="username" required readOnly={Boolean(value)} maxLength={128} autoComplete="off" defaultValue={value?.ssh?.username}/></label>
        <label>{uiText(language)("sshConnectionsPanel.authentication")}<select aria-label={uiText(language)("sshConnectionsPanel.authentication")} value={authentication} onChange={event => setAuthentication(event.target.value as 'key' | 'password')}><option value="key">{uiText(language)("web.privateKey")}</option><option value="password">{uiText(language)("sshConnectionsPanel.password")}</option></select></label>
        {authentication === 'key' ? <>
          <label>{uiText(language)("main.ssh_private_key")}<textarea name="privateKey" rows={4} required={!(sameAuth && value?.ssh?.hasPrivateKey)} maxLength={32000} autoComplete="off" spellCheck={false} placeholder={sameAuth && value?.ssh?.hasPrivateKey ? uiText(language)("web.configuredLeaveBlankToKeepThePrivateKey") : uiText(language)("web.pasteTheCompleteOpensshPemPrivateKey")}/></label>
          <label>{uiText(language)("web.privateKeyPassphrase")}<input name="passphrase" type="password" autoComplete="new-password" maxLength={8192} placeholder={uiText(language)("web.leaveBlankIfThereIsNoPassphraseWhenReplacingTheKeyEnter")}/></label>
        </> : <label>{uiText(language)("web.sshPassword")}<input name="password" type="password" autoComplete="new-password" required={!(sameAuth && value?.ssh?.hasPassword)} maxLength={8192} placeholder={sameAuth && value?.ssh?.hasPassword ? uiText(language)("web.configuredLeaveBlankToKeepThePassword") : uiText(language)("web.passwordForTheRemoteSshUser")}/></label>}
        <label>{uiText(language)("web.remoteAgentPort")}<input name="remotePort" type="number" required readOnly={Boolean(value)} min={1} max={65535} defaultValue={value?.ssh?.remotePort ?? 4780}/></label>
        <p className="muted org-help">{uiText(language)("web.theTunnelForwardsOnlyToTheRemoteAgentPortOn1270")}</p>
        <label>{uiText(language)("web.sshHostFingerprint")}<input aria-label={uiText(language)("web.sshHostFingerprint")} value={fingerprint} readOnly={Boolean(value)} maxLength={50} pattern="SHA256:[A-Za-z0-9+/]{43}" onChange={event => setFingerprint(event.target.value)} placeholder={uiText(language)("web.leaveBlankInitiallyAndSelectTestConnectionToRetrieveIt")}/></label>
      </>}
      <label>{uiText(language)("agentConnectionForm.accessToken")}<input name="token" type="password" autoComplete="new-password" required={!value?.hasToken} maxLength={8192} placeholder={value?.hasToken ? uiText(language)("web.configuredLeaveBlankToKeepTheToken") : uiText(language)("web.contentsOfAccessTokenInTheRemoteServiceSDataDirectory")}/></label>
      <div className="remote-grants" role="group" aria-label={uiText(language)("web.authorizedMembers2")}>
        <label>{uiText(language)("web.authorizedMembersSelected", { count: selectedUsers.length })}<input type="search" aria-label={uiText(language)("web.searchAuthorizedMembers")} placeholder={uiText(language)("web.searchNameAccountCompanyOrDepartment")} value={userQuery} onChange={event => setUserQuery(event.target.value)}/></label>
        <div className="org-actions remote-grant-actions"><button type="button" disabled={!visibleUsers.length || visibleUsers.every(user => selectedUsers.includes(user.id))} onClick={() => selectUsers([...new Set([...selectedUsers, ...visibleIds])])}>{uiText(language)("web.selectAllResults")}</button><button type="button" disabled={!selectedUsers.some(id => visibleIds.has(id))} onClick={() => selectUsers(selectedUsers.filter(id => !visibleIds.has(id)))}>{uiText(language)("web.deselectAllResults")}</button><button type="button" disabled={!selectedUsers.length} onClick={() => selectUsers([])}>{uiText(language)("conversationExtraction.clear_selection")}</button></div>
        <div className="remote-grant-list">{visibleUsers.map(user => <label className="org-checkbox" key={user.id}><input type="checkbox" checked={selectedUsers.includes(user.id)} onChange={event => selectUsers(event.target.checked ? [...selectedUsers, user.id] : selectedUsers.filter(id => id !== user.id))}/><span>{uiText(language)("web.", { name: user.display_name, username: user.username })}{!user.is_active && <small>{uiText(language)("pluginManagementPanel.disabled")}</small>}<small className="muted">{[user.company_name, user.department_name].filter(Boolean).join(' / ')}</small></span></label>)}{!visibleUsers.length && <p className="muted">{uiText(language)("web.noMatchingMembers2")}</p>}</div>
      </div>
      <p className="muted org-help">{uiText(language)("web.savingUpdatesAllGrantsWebsiteTasksAreIsolatedByAccountTheRemote")}</p>
      <label className="org-checkbox"><input type="checkbox" name="enabled" defaultChecked={value?.enabled ?? true}/>{uiText(language)("web.enableThisConnection")}</label>
      {(error || testError) && <p className="form-error" role="alert">{testError || error}</p>}{testResult && <p className="form-notice" role="status">{testResult}</p>}
      {observed && <div className="org-help" role="status"><p>{uiText(language)("web.compareThisSshHostFingerprintWithTheOneProvidedByTheRemote")}</p><code className="remote-fingerprint">{observed}</code><p>{uiText(language)("web.trustItOnlyIfItMatchesThenTestTheConnectionAgain")}</p><button type="button" onClick={() => { setFingerprint(observed); setObserved(''); setTestResult(uiText(language)("web.fingerprintFilledInTestTheConnectionAgain")); }}>{uiText(language)("web.fingerprintMatchesTrustThisHost")}</button></div>}
    </fieldset><div className="modal-actions"><button type="button" disabled={busy || testing} onClick={close}>{uiText(language)("agentConnectionForm.cancel")}</button><button type="button" disabled={busy || testing} onClick={event => { const form = event.currentTarget.closest('form'); if (form) void test(form); }}><PlugZap size={14}/>{testing ? uiText(language)("sandboxSettingsPanel.checking") : uiText(language)("web.testConnection")}</button><button className="primary" type="submit" disabled={busy || testing || (transport === 'ssh' && !fingerprint)}>{busy ? uiText(language)("web.verifyingAndSaving") : uiText(language)("web.verifyAndSave")}</button></div></form>
  </section></div>;
}
