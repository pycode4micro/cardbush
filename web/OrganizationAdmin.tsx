import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Building2, ChevronRight, Pencil, Plus, Search, Trash2, Users, X } from 'lucide-react';
import { api, type Company, type Department, type Organization, type User } from './api';
import { PluginAdmin } from './AgentWidgets';

type Scope = { kind: 'all' | 'unassigned' | 'company' | 'department'; id?: string };
type Editor = { kind: 'company'; item?: Company } | { kind: 'department'; item?: Department; companyId?: string } | { kind: 'user'; item?: User; companyId?: string; departmentId?: string };
type Removal = { kind: 'company' | 'department' | 'user'; id: string; name: string };
const roles: Record<string,string> = { admin: '系统管理员', department_admin: '部门管理员', member: '成员' };
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作未完成，请重试。';

export function OrganizationAdmin({ currentUserId }: { currentUserId: string }) {
  const [org,setOrg] = useState<Organization>({ companies:[],departments:[] }), [users,setUsers] = useState<User[]>([]), [deleted,setDeleted] = useState<User[]>([]);
  const [scope,setScope] = useState<Scope>({kind:'all'}), [query,setQuery] = useState(''), [status,setStatus] = useState('all'), [tab,setTab] = useState<'people'|'deleted'|'plugins'>('people');
  const [editor,setEditor] = useState<Editor|null>(null), [removal,setRemoval] = useState<Removal|null>(null), [busy,setBusy] = useState(false), [loading,setLoading] = useState(true), [error,setError] = useState(''), [notice,setNotice] = useState('');
  const refresh = useCallback(async () => {
    const [organization,people,removed] = await Promise.all([api<Organization>('/admin/organization'),api<User[]>('/admin/users'),api<User[]>('/admin/users?deleted=1')]);
    setOrg(organization);setUsers(people);setDeleted(removed);setLoading(false);
  },[]);
  useEffect(() => { void refresh().catch(reason => {setError(errorText(reason));setLoading(false);}); },[refresh]);
  async function perform(path:string, method:string, input:unknown, success:string, next?:(value:any)=>void) {
    setBusy(true);setError('');setNotice('');
    try { const value=await api(path,method,input);await refresh();setEditor(null);setRemoval(null);setNotice(success);next?.(value); }
    catch(reason) {setError(errorText(reason));} finally {setBusy(false);}
  }
  const company=org.companies.find(item=>scope.kind==='company'&&item.id===scope.id);
  const department=org.departments.find(item=>scope.kind==='department'&&item.id===scope.id);
  const companyId=company?.id || department?.company_id;
  const title=tab==='deleted'?'已删除人员':company?.name || department?.name || (scope.kind==='unassigned'?'待分配人员':'全部人员');
  const filtered=useMemo(()=>(tab==='deleted'?deleted:users).filter(user=>{
    if(tab!=='deleted' && ((scope.kind==='company'&&user.company_id!==scope.id)||(scope.kind==='department'&&user.department_id!==scope.id)||(scope.kind==='unassigned'&&user.department_id))) return false;
    if(status==='enabled'&&!user.is_active || status==='disabled'&&user.is_active)return false;
    return [user.display_name,user.username,user.company_name,user.department_name].join(' ').toLowerCase().includes(query.trim().toLowerCase());
  }),[users,deleted,scope,query,status,tab]);
  const select=(next:Scope)=>{setScope(next);setTab('people');setQuery('');setStatus('all');setError('');setNotice('');};
  const edit=(value:Editor)=>{setError('');setEditor(value);};
  const remove=(value:Removal)=>{setError('');setRemoval(value);};
  function save(input:Record<string,unknown>) {
    if(!editor)return;
    const resource=editor.kind==='company'?'companies':editor.kind==='department'?'departments':'users';
    const kind=editor.kind,creating=!editor.item;
    void perform(`/admin/${resource}${editor.item?'/'+editor.item.id:''}`,editor.item?'PATCH':'POST',input,creating?'已新增。':'已保存。',value=>{
      if(kind==='company')select({kind:'company',id:value.id});
      if(kind==='department')select({kind:'department',id:value.id});
    });
  }
  return <section className="admin-panel organization-admin"><div className="admin-heading"><div><span className="eyebrow">组织与访问权限</span><h1>管理中心</h1><p className="muted">按公司、部门管理人员，保留每个人独立的对话空间。</p></div></div>
    <div className="admin-tabs" role="tablist" aria-label="管理功能">{(['people','deleted','plugins'] as const).map(value=><button key={value} role="tab" aria-selected={tab===value} onClick={()=>{setTab(value);setQuery('');setStatus('all');setError('');setNotice('');}}>{value==='people'?'组织与人员':value==='deleted'?`已删除 (${deleted.length})`:'插件管理'}</button>)}</div>
    {error&&!editor&&!removal&&<p className="form-error" role="alert">{error}</p>}{notice&&<p className="form-notice" role="status">{notice}</p>}
    {loading?<p className="status-line">正在加载组织…</p>:tab==='plugins'?<PluginAdmin users={users}/>:<div className={`organization-layout ${tab==='deleted'?'without-tree':''}`}>
      {tab==='people'&&<nav className="organization-tree" aria-label="公司和部门"><header><strong>组织架构</strong><button className="icon-button" aria-label="新增公司" title="新增公司" onClick={()=>edit({kind:'company'})}><Plus size={17}/></button></header>
        <button className={`org-tree-row ${scope.kind==='all'?'selected':''}`} onClick={()=>select({kind:'all'})}><Users size={15}/>全部人员<span>{users.length}</span></button>
        <button className={`org-tree-row ${scope.kind==='unassigned'?'selected':''}`} onClick={()=>select({kind:'unassigned'})}><Users size={15}/>待分配<span>{users.filter(user=>!user.department_id).length}</span></button>
        {org.companies.map(item=><div className="org-tree-company" key={item.id}><button className={`org-tree-row ${scope.kind==='company'&&scope.id===item.id?'selected':''}`} onClick={()=>select({kind:'company',id:item.id})}><Building2 size={15}/><strong>{item.name}</strong><span>{item.member_count}</span></button>
          {org.departments.filter(value=>value.company_id===item.id).map(value=><button key={value.id} className={`org-tree-row org-tree-department ${scope.kind==='department'&&scope.id===value.id?'selected':''}`} onClick={()=>select({kind:'department',id:value.id})}><ChevronRight size={13}/>{value.name}<span>{value.member_count}</span></button>)}
        </div>)}{!org.companies.length&&<p className="org-empty">先新增公司，再建立部门。原有账号可在“待分配”中调整归属。</p>}
      </nav>}
      <div className="organization-content"><div className="org-content-heading"><div>{department&&<span className="eyebrow">{department.company_name}</span>}<h2>{title}</h2>{(company?.description||department?.description)&&<p className="muted">{company?.description||department?.description}</p>}{tab==='deleted'&&<p className="muted">账号已停用，原有对话和文件保留。恢复后需重新分配部门并启用，插件权限需重新授权。</p>}</div>
        <div className="org-actions">{company&&tab==='people'&&<><button aria-label={`编辑公司 ${company.name}`} onClick={()=>edit({kind:'company',item:company})}><Pencil size={14}/>编辑公司</button><button className="danger" aria-label={`删除公司 ${company.name}`} onClick={()=>remove({kind:'company',id:company.id,name:company.name})}><Trash2 size={14}/>删除公司</button><button onClick={()=>edit({kind:'department',companyId:company.id})}><Plus size={15}/>新增部门</button></>}
          {department&&tab==='people'&&<><button aria-label={`编辑部门 ${department.name}`} onClick={()=>edit({kind:'department',item:department})}><Pencil size={14}/>编辑部门</button><button className="danger" aria-label={`删除部门 ${department.name}`} onClick={()=>remove({kind:'department',id:department.id,name:department.name})}><Trash2 size={14}/>删除部门</button></>}
          {tab==='people'&&<button className="primary" onClick={()=>edit({kind:'user',companyId,departmentId:department?.id})}><Plus size={15}/>新增人员</button>}</div></div>
        {company&&tab==='people'&&<div className="department-cards">{org.departments.filter(item=>item.company_id===company.id).map(item=><button key={item.id} onClick={()=>select({kind:'department',id:item.id})}><strong>{item.name}</strong><span>{item.member_count} 人<ChevronRight size={14}/></span></button>)}{!company.department_count&&<p className="org-empty">该公司暂无部门，点击“新增部门”开始建立组织。</p>}</div>}
        <div className="people-toolbar"><label className="people-search"><Search size={16}/><input aria-label="搜索人员" placeholder="搜索姓名、用户名、公司或部门" value={query} onChange={event=>setQuery(event.target.value)}/></label>{tab==='people'&&<select aria-label="人员状态" value={status} onChange={event=>setStatus(event.target.value)}><option value="all">全部状态</option><option value="enabled">已启用</option><option value="disabled">待启用 / 已停用</option></select>}<span>{filtered.length} 人</span></div>
        <div className="user-table"><table><thead><tr><th>人员</th><th>公司 / 部门</th><th>角色</th><th>状态</th><th>操作</th></tr></thead><tbody>{filtered.map(user=><tr key={user.id}><td><strong>{user.display_name}</strong><small>{user.username}</small></td><td>{user.company_name||'待分配'}<small>{user.department_name||'尚未分配部门'}</small></td><td>{roles[user.role]||user.role}</td><td><span className={`user-status ${user.is_active?'enabled':''}`}>{user.deleted_at?'已删除':user.is_active?'已启用':'待启用 / 已停用'}</span></td><td>{tab==='deleted'?<button disabled={busy} onClick={()=>void perform(`/admin/users/${user.id}/restore`,'POST',{},'已恢复为待启用账号，请到人员列表分配部门并启用。')}>恢复人员</button>:<>
          <button aria-label={`编辑人员 ${user.username}`} disabled={busy} onClick={()=>edit({kind:'user',item:user})}>编辑</button><button disabled={busy||user.id===currentUserId} onClick={()=>void perform(`/admin/users/${user.id}`,'PATCH',{is_active:!user.is_active},user.is_active?'账号已停用。':'账号已启用。')}>{user.is_active?'停用':'启用'}</button><button className="danger" aria-label={`删除人员 ${user.username}`} disabled={busy||user.id===currentUserId} onClick={()=>remove({kind:'user',id:user.id,name:`${user.display_name} (${user.username})`})}>删除</button></>}</td></tr>)}</tbody></table>{!filtered.length&&<p className="org-empty">{query?'没有匹配的人员。':tab==='deleted'?'没有已删除人员。':'该范围暂无人员，可新增人员或在编辑中调整已有人员归属。'}</p>}</div>
      </div>
    </div>}
    {editor&&<EditorDialog key={editor.kind+('item' in editor?editor.item?.id||'new':'new')} editor={editor} org={org} currentUserId={currentUserId} busy={busy} error={error} close={()=>{if(!busy)setEditor(null);}} save={save}/>}
    {removal&&<Dialog title={`删除${removal.kind==='company'?'公司':removal.kind==='department'?'部门':'人员'}`} close={()=>{if(!busy)setRemoval(null);}}><p>确定删除“{removal.name}”？</p><p>{removal.kind==='user'?'账号将立即停用，登录与插件授权失效，并移入“已删除”。对话和文件保留，可恢复后重新分配部门。':removal.kind==='company'?'公司下有部门时不能删除，请先转移或删除部门。':'部门内有人员时不能删除，请先调整人员归属。'}</p>{error&&<p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button disabled={busy} onClick={()=>setRemoval(null)}>取消</button><button className="primary destructive" disabled={busy} onClick={()=>void perform(`/admin/${removal.kind==='company'?'companies':removal.kind==='department'?'departments':'users'}/${removal.id}`,'DELETE',undefined,'已删除。',()=>{if(removal.kind!=='user')setScope({kind:'all'});})}>{busy?'正在删除…':'确认删除'}</button></div></Dialog>}
  </section>;
}

function Dialog({title,close,children}:{title:string;close:()=>void;children:ReactNode}) {
  return <div className="modal-backdrop" onClick={close} onKeyDown={event=>{if(event.key==='Escape')close();}}><section className="modal organization-modal" role="dialog" aria-modal="true" aria-label={title} onClick={event=>event.stopPropagation()}><header><h2>{title}</h2><button className="icon-button" aria-label="关闭表单" onClick={close}><X size={18}/></button></header>{children}</section></div>;
}
function EditorDialog({editor,org,currentUserId,busy,error,close,save}:{editor:Editor;org:Organization;currentUserId:string;busy:boolean;error:string;close:()=>void;save:(input:Record<string,unknown>)=>void}) {
  const [companyId,setCompanyId]=useState(editor.kind==='company'?'':editor.item?.company_id||editor.companyId||'');
  const [departmentId,setDepartmentId]=useState(editor.kind==='user'?editor.item?.department_id||editor.departmentId||'':'');
  const person=editor.kind==='user'?editor.item:undefined;
  const title=`${editor.item?'编辑':'新增'}${editor.kind==='company'?'公司':editor.kind==='department'?'部门':'人员'}`;
  function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();const form=new FormData(event.currentTarget);
    if(editor.kind==='user') {
      const password=String(form.get('password')||'');
      save({username:String(form.get('username')),display_name:String(form.get('display_name')),role:person?.id===currentUserId?person.role:String(form.get('role')),is_active:person?.id===currentUserId?person.is_active:form.get('is_active')==='on',department_id:departmentId||null,...(editor.item?(password?{new_password:password}:{}):{password})});
    } else save({name:String(form.get('name')),description:String(form.get('description')||''),...(editor.kind==='department'?{company_id:companyId}:{})});
  }
  return <Dialog title={title} close={close}><form onSubmit={submit}><fieldset disabled={busy}>
    {editor.kind==='user'?<div className="org-form-grid"><label>姓名<input autoFocus name="display_name" defaultValue={person?.display_name||''} required maxLength={120}/></label><label>用户名<input name="username" defaultValue={person?.username||''} required minLength={3} maxLength={80} pattern="[A-Za-z0-9_.-]+" autoComplete="off"/></label></div>:<label>{editor.kind==='company'?'公司名称':'部门名称'}<input autoFocus name="name" defaultValue={editor.item?.name||''} required maxLength={120}/></label>}
    {editor.kind!=='company'&&<div className="org-form-grid"><label>所属公司<select aria-label="所属公司" required={editor.kind==='department'} value={companyId} onChange={event=>{setCompanyId(event.target.value);setDepartmentId('');}}><option value="">{editor.kind==='user'?'待分配':'请选择公司'}</option>{org.companies.map(company=><option key={company.id} value={company.id}>{company.name}</option>)}</select></label>{editor.kind==='user'&&<label>所属部门<select aria-label="所属部门" required={Boolean(companyId)} disabled={!companyId} value={departmentId} onChange={event=>setDepartmentId(event.target.value)}><option value="">{companyId?'请选择部门':'待分配'}</option>{org.departments.filter(department=>department.company_id===companyId&&department.is_active).map(department=><option key={department.id} value={department.id}>{department.name}</option>)}</select></label>}</div>}
    {editor.kind==='user'?<><label>角色<select name="role" defaultValue={person?.role||'member'} disabled={person?.id===currentUserId}>{Object.entries(roles).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label><label>{person?'重置密码（留空不修改）':'初始密码'}<input name="password" type="password" autoComplete="new-password" required={!person} minLength={8} maxLength={128} placeholder="至少 8 位字符"/></label><label className="org-checkbox"><input name="is_active" type="checkbox" defaultChecked={person?person.is_active:true} disabled={person?.id===currentUserId}/>启用账号，允许登录</label><p className="muted org-help">系统管理员可维护组织和账号；部门归属不开放其他人的会话或文件。</p></>:<label>说明<textarea name="description" rows={3} maxLength={500} defaultValue={editor.item?.description||''}/></label>}
    {error&&<p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" onClick={close}>取消</button><button className="primary" type="submit">{busy?'正在保存…':'保存'}</button></div></fieldset></form></Dialog>;
}
