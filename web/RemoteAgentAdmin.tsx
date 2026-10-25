import { useEffect, useState, type FormEvent } from 'react';
import { Plus, RefreshCw, X, PlugZap } from 'lucide-react';
import { api, requestId, type User } from './api';

type Ssh = { host: string; port: number; username: string; authentication: 'key' | 'password'; fingerprint: string; remotePort: number; hasPrivateKey: boolean; hasPassphrase: boolean; hasPassword: boolean };
type Agent = { id: string; name: string; description: string; url: string; transport?: 'http' | 'ssh'; ssh?: Ssh; enabled: boolean; userIds: string[]; agentId: string; hasToken: boolean; verifiedAt: string; boundUserId?: string };
type Settings = { revision: number; agents: Agent[] };
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试。';
const sshInput = (ssh: Ssh) => ({ host: ssh.host, port: ssh.port, username: ssh.username, authentication: ssh.authentication, fingerprint: ssh.fingerprint, remotePort: ssh.remotePort });
const editable = (agent: Agent) => ({ id: agent.id, name: agent.name, description: agent.description, url: agent.url, transport: agent.transport ?? 'http', ...(agent.ssh ? { ssh: sshInput(agent.ssh) } : {}), enabled: agent.enabled, userIds: agent.userIds });

export function RemoteAgentAdmin({ users }: { users: User[] }) {
  const [settings, setSettings] = useState<Settings | null>(null), [busy, setBusy] = useState(false);
  const [editor, setEditor] = useState<Agent | 'new' | null>(null), [removal, setRemoval] = useState<Agent | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
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
      setEditor(null); setRemoval(null); setNotice('已保存。授权人员可在对话中使用此远程 Agent。');
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }
  return <section className="model-admin remote-agent-admin"><div className="org-content-heading"><div><h2>远程 Agent</h2><p className="muted">通过 SSH 隧道或 HTTP(S) 连接独立的 CardBush 服务，按人员开放异步子任务。</p></div><div className="org-actions">
    <button disabled={busy} onClick={() => void refresh()}><RefreshCw size={14}/>刷新列表</button>
    <button className="primary" disabled={!settings || busy} onClick={() => { setError(''); setNotice(''); setEditor('new'); }}><Plus size={15}/>注册远程 Agent</button></div></div>
    <p className="muted org-help">同一远程 Agent 可授权给多名人员，网站按账号隔离任务和会话。仅发送任务文字，模型、插件和文件由远程服务自行管理。</p>
    {error && !editor && !removal && <p className="form-error" role="alert">{error}</p>}{notice && <p className="form-notice" role="status">{notice}</p>}
    {!settings ? <p className="status-line">{error ? '加载失败，可点击刷新重试。' : '正在加载远程 Agent…'}</p> : <div className="model-cards">{settings.agents.map(agent => <article className="model-card" key={agent.id}><header><div><h3>{agent.name}</h3><code>{agent.id}</code></div><span className={`user-status ${agent.enabled && agent.userIds.length ? 'enabled' : ''}`}>{!agent.enabled ? '已停用' : agent.userIds.length ? '已授权' : '待授权'}</span></header>
      {agent.description && <p>{agent.description}</p>}<p className="model-endpoint">{agent.transport === 'ssh' && agent.ssh ? `SSH · ${agent.ssh.username}@${agent.ssh.host}:${agent.ssh.port} → 127.0.0.1:${agent.ssh.remotePort}` : agent.url}</p>
      <dl><div><dt>授权人员（{agent.userIds.length}）</dt><dd>{agent.userIds.map(id => users.find(user => user.id === id)?.display_name ?? '已删除人员').join('、') || '尚未授权'}</dd></div><div><dt>连接验证</dt><dd>{new Date(agent.verifiedAt).toLocaleString()}</dd></div></dl>
      <footer><span className="muted">连接凭据已加密保存</span><div className="org-actions"><button disabled={busy} aria-label={`编辑远程 Agent ${agent.name}`} onClick={() => { setError(''); setEditor(agent); }}>编辑 / 授权</button><button disabled={busy} onClick={() => void change({ action: 'save', agent: { ...editable(agent), enabled: !agent.enabled } })}>{agent.enabled ? '停用' : '启用'}</button><button className="danger" disabled={busy} onClick={() => { setError(''); setRemoval(agent); }}>删除</button></div></footer>
    </article>)}{!settings.agents.length && <p className="org-empty">尚未注册远程 Agent。先启动远程服务并配置其默认模型，再填写服务地址与访问令牌。</p>}</div>}
    {editor && <RemoteEditor value={editor === 'new' ? null : editor} users={users} busy={busy} error={error}
      close={() => { if (!busy) { setEditor(null); setError(''); } }} save={agent => change({ action: 'save', agent })}/>}
    {removal && <div className="modal-backdrop"><section className="modal organization-modal" role="dialog" aria-modal="true" aria-label="删除远程 Agent"><h2>删除远程 Agent</h2><p>确定移除“{removal.name}”？将撤销网站访问权限，远程服务及其数据保留。</p>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button disabled={busy} onClick={() => setRemoval(null)}>取消</button><button className="primary destructive" disabled={busy} onClick={() => void change({ action: 'delete', id: removal.id })}>确认删除</button></div></section></div>}
  </section>;
}

function RemoteEditor({ value, users, busy, error, close, save }: { value: Agent | null; users: User[]; busy: boolean; error: string; close: () => void; save: (agent: unknown) => Promise<void> }) {
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
      else if (result.ok) setTestResult(`连接成功：${result.name}，支持远程子任务委派。`);
      else setTestError('未能验证连接，请检查配置。');
    } catch (reason) { setTestError(errorText(reason)); }
    finally { setTesting(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void save(input(event.currentTarget)); }
  return <div className="modal-backdrop" onClick={() => { if (!testing) close(); }} onKeyDown={event => { if (event.key === 'Escape' && !testing) close(); }}><section className="modal organization-modal model-modal" role="dialog" aria-modal="true" aria-label={value ? '编辑远程 Agent' : '注册远程 Agent'} onClick={event => event.stopPropagation()}><header><h2>{value ? '编辑远程 Agent' : '注册远程 Agent'}</h2><button className="icon-button" aria-label="关闭远程 Agent 表单" disabled={busy || testing} onClick={close}><X size={18}/></button></header>
    <form onSubmit={submit} onChange={() => { setTestResult(''); setTestError(''); setObserved(''); }}><fieldset disabled={busy || testing}>
      <label>名称<input name="name" autoFocus required maxLength={120} defaultValue={value?.name} placeholder="如：商品资料助手"/></label>
      <label>能力说明<textarea name="description" rows={2} maxLength={1000} defaultValue={value?.description} placeholder="说明此 Agent 可处理的任务，便于招财选择"/></label>
      <label>连接方式<select aria-label="连接方式" value={transport} disabled={Boolean(value)} onChange={event => { setTransport(event.target.value as 'http' | 'ssh'); setFingerprint(''); }}><option value="ssh">SSH 隧道</option><option value="http">HTTP(S) 直连</option></select></label>
      {transport === 'http' ? <label>远程服务地址<input name="url" type="url" required readOnly={Boolean(value)} maxLength={2048} defaultValue={value?.url} placeholder="https://agent.example.com/ 或 http://192.168.1.20:4780/"/></label> : <>
        <label>SSH 服务器<input name="host" required readOnly={Boolean(value)} maxLength={253} defaultValue={value?.ssh?.host} placeholder="远程服务器 IP 或域名" onChange={() => setFingerprint('')}/></label>
        <label>SSH 端口<input name="port" type="number" required readOnly={Boolean(value)} min={1} max={65535} defaultValue={value?.ssh?.port ?? 22} onChange={() => setFingerprint('')}/></label>
        <label>SSH 用户名<input name="username" required readOnly={Boolean(value)} maxLength={128} autoComplete="off" defaultValue={value?.ssh?.username}/></label>
        <label>认证方式<select aria-label="认证方式" value={authentication} onChange={event => setAuthentication(event.target.value as 'key' | 'password')}><option value="key">私钥</option><option value="password">密码</option></select></label>
        {authentication === 'key' ? <>
          <label>SSH 私钥<textarea name="privateKey" rows={4} required={!(sameAuth && value?.ssh?.hasPrivateKey)} maxLength={32000} autoComplete="off" spellCheck={false} placeholder={sameAuth && value?.ssh?.hasPrivateKey ? '已配置；留空保留原私钥' : '粘贴完整 OpenSSH / PEM 私钥内容'}/></label>
          <label>私钥口令<input name="passphrase" type="password" autoComplete="new-password" maxLength={8192} placeholder="无口令可留空；更换私钥时填写对应口令"/></label>
        </> : <label>SSH 登录密码<input name="password" type="password" autoComplete="new-password" required={!(sameAuth && value?.ssh?.hasPassword)} maxLength={8192} placeholder={sameAuth && value?.ssh?.hasPassword ? '已配置；留空保留原密码' : '远程 SSH 用户的登录密码'}/></label>}
        <label>远端 Agent 端口<input name="remotePort" type="number" required readOnly={Boolean(value)} min={1} max={65535} defaultValue={value?.ssh?.remotePort ?? 4780}/></label>
        <p className="muted org-help">隧道仅转发到远端 127.0.0.1 的 Agent 端口。请先在远端启动服务；此处不会执行 SSH 命令或安装 Agent。</p>
        <label>SSH 服务器指纹<input aria-label="SSH 服务器指纹" value={fingerprint} readOnly={Boolean(value)} maxLength={50} pattern="SHA256:[A-Za-z0-9+/]{43}" onChange={event => setFingerprint(event.target.value)} placeholder="首次可留空，点击检测连接获取"/></label>
      </>}
      <label>访问令牌<input name="token" type="password" autoComplete="new-password" required={!value?.hasToken} maxLength={8192} placeholder={value?.hasToken ? '已配置；留空保留原令牌' : '远程服务数据目录 access-token 的内容'}/></label>
      <div className="remote-grants" role="group" aria-label="授权人员">
        <label>授权人员（已选 {selectedUsers.length} 人）<input type="search" aria-label="搜索授权人员" placeholder="搜索姓名、账号、公司或部门" value={userQuery} onChange={event => setUserQuery(event.target.value)}/></label>
        <div className="org-actions remote-grant-actions"><button type="button" disabled={!visibleUsers.length || visibleUsers.every(user => selectedUsers.includes(user.id))} onClick={() => selectUsers([...new Set([...selectedUsers, ...visibleIds])])}>全选当前结果</button><button type="button" disabled={!selectedUsers.some(id => visibleIds.has(id))} onClick={() => selectUsers(selectedUsers.filter(id => !visibleIds.has(id)))}>取消当前结果</button><button type="button" disabled={!selectedUsers.length} onClick={() => selectUsers([])}>清空选择</button></div>
        <div className="remote-grant-list">{visibleUsers.map(user => <label className="org-checkbox" key={user.id}><input type="checkbox" checked={selectedUsers.includes(user.id)} onChange={event => selectUsers(event.target.checked ? [...selectedUsers, user.id] : selectedUsers.filter(id => id !== user.id))}/><span>{user.display_name}（{user.username}）{user.is_active ? '' : ' · 已停用'}<small className="muted">{[user.company_name, user.department_name].filter(Boolean).join(' / ')}</small></span></label>)}{!visibleUsers.length && <p className="muted">没有匹配人员</p>}</div>
      </div>
      <p className="muted org-help">保存后统一更新授权。网站任务按账号隔离；同一远程服务的工作目录、插件和登录状态仍由远端管理，需要独立资源时可分别注册实例。</p>
      <label className="org-checkbox"><input type="checkbox" name="enabled" defaultChecked={value?.enabled ?? true}/>启用此连接</label>
      {(error || testError) && <p className="form-error" role="alert">{testError || error}</p>}{testResult && <p className="form-notice" role="status">{testResult}</p>}
      {observed && <div className="org-help" role="status"><p>请与远端管理员提供的 SSH 主机指纹核对：</p><code style={{ overflowWrap: 'anywhere' }}>{observed}</code><p>确认一致后再信任，随后重新检测连接。</p><button type="button" onClick={() => { setFingerprint(observed); setObserved(''); setTestResult('指纹已填入，请再次检测连接。'); }}>指纹一致，确认信任</button></div>}
    </fieldset><div className="modal-actions"><button type="button" disabled={busy || testing} onClick={close}>取消</button><button type="button" disabled={busy || testing} onClick={event => { const form = event.currentTarget.closest('form'); if (form) void test(form); }}><PlugZap size={14}/>{testing ? '正在检测…' : '检测连接'}</button><button className="primary" type="submit" disabled={busy || testing || (transport === 'ssh' && !fingerprint)}>{busy ? '验证并保存中…' : '验证并保存'}</button></div></form>
  </section></div>;
}
