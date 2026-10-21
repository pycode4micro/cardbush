import { useEffect, useState, type FormEvent } from 'react';
import { Plus, RefreshCw, X, PlugZap } from 'lucide-react';
import { api, requestId, type User } from './api';

type Agent = { id: string; name: string; description: string; url: string; enabled: boolean; userIds: string[]; agentId: string; hasToken: boolean; verifiedAt: string; boundUserId?: string };
type Settings = { revision: number; agents: Agent[] };
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试。';
const editable = (agent: Agent) => ({ id: agent.id, name: agent.name, description: agent.description, url: agent.url, enabled: agent.enabled, userIds: agent.userIds });

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
  return <section className="model-admin remote-agent-admin"><div className="org-content-heading"><div><h2>远程 Agent</h2><p className="muted">注册独立的 CardBush HTTP 服务，按人员开放子任务委派。保留原生异步执行、等待结果及继续任务。</p></div><div className="org-actions">
    <button disabled={busy} onClick={() => void refresh()}><RefreshCw size={14}/>刷新列表</button>
    <button className="primary" disabled={!settings || busy} onClick={() => { setError(''); setNotice(''); setEditor('new'); }}><Plus size={15}/>注册远程 Agent</button></div></div>
    <p className="muted org-help">每个远程实例绑定一名人员；多人使用时，请分别部署独立实例和数据目录。仅发送任务文字，模型、插件和文件由远程服务自行管理。此处不创建或自动装配本地 Agent。</p>
    {error && !editor && !removal && <p className="form-error" role="alert">{error}</p>}{notice && <p className="form-notice" role="status">{notice}</p>}
    {!settings ? <p className="status-line">{error ? '加载失败，可点击刷新重试。' : '正在加载远程 Agent…'}</p> : <div className="model-cards">{settings.agents.map(agent => <article className="model-card" key={agent.id}><header><div><h3>{agent.name}</h3><code>{agent.id}</code></div><span className={`user-status ${agent.enabled && agent.userIds.length ? 'enabled' : ''}`}>{!agent.enabled ? '已停用' : agent.userIds.length ? '已授权' : '待授权'}</span></header>
      {agent.description && <p>{agent.description}</p>}<p className="model-endpoint">{agent.url}</p>
      <dl><div><dt>授权人员</dt><dd>{users.find(user => user.id === agent.userIds[0])?.display_name ?? '尚未授权'}</dd></div><div><dt>连接验证</dt><dd>{new Date(agent.verifiedAt).toLocaleString()}</dd></div></dl>
      <footer><span className="muted">令牌已加密保存</span><div className="org-actions"><button disabled={busy} aria-label={`编辑远程 Agent ${agent.name}`} onClick={() => { setError(''); setEditor(agent); }}>编辑 / 授权</button><button disabled={busy} onClick={() => void change({ action: 'save', agent: { ...editable(agent), enabled: !agent.enabled } })}>{agent.enabled ? '停用' : '启用'}</button><button className="danger" disabled={busy} onClick={() => { setError(''); setRemoval(agent); }}>删除</button></div></footer>
    </article>)}{!settings.agents.length && <p className="org-empty">尚未注册远程 Agent。先启动远程服务并配置其默认模型，再填写服务地址与访问令牌。</p>}</div>}
    {editor && <RemoteEditor value={editor === 'new' ? null : editor} users={users} busy={busy} error={error}
      close={() => { if (!busy) { setEditor(null); setError(''); } }} save={agent => change({ action: 'save', agent })}/>}
    {removal && <div className="modal-backdrop"><section className="modal organization-modal" role="dialog" aria-modal="true" aria-label="删除远程 Agent"><h2>删除远程 Agent</h2><p>确定移除“{removal.name}”？将撤销网站访问权限，远程服务及其数据保留。</p>{error && <p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button disabled={busy} onClick={() => setRemoval(null)}>取消</button><button className="primary destructive" disabled={busy} onClick={() => void change({ action: 'delete', id: removal.id })}>确认删除</button></div></section></div>}
  </section>;
}

function RemoteEditor({ value, users, busy, error, close, save }: { value: Agent | null; users: User[]; busy: boolean; error: string; close: () => void; save: (agent: unknown) => Promise<void> }) {
  const [id] = useState(value?.id ?? 'remote_' + requestId().replaceAll('-', '').slice(0, 20));
  const [testing, setTesting] = useState(false), [testResult, setTestResult] = useState(''), [testError, setTestError] = useState('');
  function input(form: HTMLFormElement) {
    const data = new FormData(form), userId = String(data.get('userId') || '');
    return { id, name: String(data.get('name')), description: String(data.get('description') || ''), url: String(data.get('url')), token: String(data.get('token') || ''), enabled: data.get('enabled') === 'on', userIds: userId ? [userId] : [] };
  }
  async function test(form: HTMLFormElement) {
    if (!form.reportValidity()) return;
    const agent = input(form); setTesting(true); setTestError(''); setTestResult('');
    try {
      const result = await api<{ name: string; agentId: string }>('/admin/remote-agents', 'POST', { action: 'test', agent });
      setTestResult(`连接成功：${result.name}，支持远程子任务委派。`);
    } catch (reason) { setTestError(errorText(reason)); }
    finally { setTesting(false); }
  }
  function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); void save(input(event.currentTarget)); }
  return <div className="modal-backdrop" onClick={() => { if (!testing) close(); }} onKeyDown={event => { if (event.key === 'Escape' && !testing) close(); }}><section className="modal organization-modal model-modal" role="dialog" aria-modal="true" aria-label={value ? '编辑远程 Agent' : '注册远程 Agent'} onClick={event => event.stopPropagation()}><header><h2>{value ? '编辑远程 Agent' : '注册远程 Agent'}</h2><button className="icon-button" aria-label="关闭远程 Agent 表单" disabled={busy || testing} onClick={close}><X size={18}/></button></header>
    <form onSubmit={submit} onChange={() => { setTestResult(''); setTestError(''); }}><fieldset disabled={busy || testing}>
      <label>名称<input name="name" autoFocus required maxLength={120} defaultValue={value?.name} placeholder="如：商品资料助手"/></label>
      <label>能力说明<textarea name="description" rows={2} maxLength={1000} defaultValue={value?.description} placeholder="说明此 Agent 可处理的任务，便于招财选择"/></label>
      <label>远程服务地址<input name="url" type="url" required readOnly={Boolean(value)} maxLength={2048} defaultValue={value?.url} placeholder="https://agent.example.com/ 或 http://192.168.1.20:4780/"/></label>
      <label>访问令牌<input name="token" type="password" autoComplete="new-password" required={!value?.hasToken} maxLength={8192} placeholder={value?.hasToken ? '已配置；留空保留原令牌' : '远程服务数据目录 access-token 的内容'}/></label>
      <label>授权人员<select name="userId" aria-label="授权人员" defaultValue={value?.userIds[0] ?? ''}><option value="">暂不授权</option>{users.filter(user => !value?.boundUserId || user.id === value.boundUserId).map(user => <option key={user.id} value={user.id}>{user.display_name} ({user.username}){user.is_active ? '' : ' · 已停用'}</option>)}</select></label>
      <p className="muted org-help">首次授权后绑定该人员，防止不同账号复用远程工作目录。服务需要在远程机器独立运行，并已设置默认模型。本机地址、SSH 命令、本地进程和自动装配均不支持。</p>
      <label className="org-checkbox"><input type="checkbox" name="enabled" defaultChecked={value?.enabled ?? true}/>启用此连接</label>
      {(error || testError) && <p className="form-error" role="alert">{testError || error}</p>}{testResult && <p className="form-notice" role="status">{testResult}</p>}
    </fieldset><div className="modal-actions"><button type="button" disabled={busy || testing} onClick={close}>取消</button><button type="button" disabled={busy || testing} onClick={event => { const form = event.currentTarget.closest('form'); if (form) void test(form); }}><PlugZap size={14}/>{testing ? '正在检测…' : '检测连接'}</button><button className="primary" type="submit" disabled={busy || testing}>{busy ? '验证并保存中…' : '验证并保存'}</button></div></form>
  </section></div>;
}
