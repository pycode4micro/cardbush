import { uiText, type MessageKey } from '../src/i18n';
import { useUiLanguage } from '../src/i18n/react';
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Building2, ChevronRight, Pencil, Plus, Search, Trash2, Users, X } from 'lucide-react';
import { api, type Company, type Department, type Organization, type User } from './api';
import { PluginAdmin } from './AgentWidgets';
import { ModelAdmin } from './ModelAdmin';
import { RemoteAgentAdmin } from './RemoteAgentAdmin';

type Scope = { kind: 'all' | 'unassigned' | 'company' | 'department'; id?: string };
type Editor = { kind: 'company'; item?: Company } | { kind: 'department'; item?: Department; companyId?: string } | { kind: 'user'; item?: User; companyId?: string; departmentId?: string };
type Removal = { kind: 'company' | 'department' | 'user'; id: string; name: string };
const roles: Record<string, MessageKey> = { admin: "web.systemAdministrator", department_admin: "web.departmentAdministrator", member: "conversationWorkSummary.member" };
const errorText = (error: unknown) => error instanceof Error ? error.message : uiText()("web.theOperationCouldNotBeCompletedPleaseTryAgain");

export function OrganizationAdmin({ currentUserId }: { currentUserId: string }) {
  const language = useUiLanguage();

  const [org,setOrg] = useState<Organization>({ companies:[],departments:[] }), [users,setUsers] = useState<User[]>([]), [deleted,setDeleted] = useState<User[]>([]);
  const [scope,setScope] = useState<Scope>({kind:'all'}), [query,setQuery] = useState(''), [status,setStatus] = useState('all'), [tab,setTab] = useState<'people'|'deleted'|'plugins'|'models'|'remote-agents'>('people');
  const [editor,setEditor] = useState<Editor|null>(null), [removal,setRemoval] = useState<Removal|null>(null), [busy,setBusy] = useState(false), [loading,setLoading] = useState(true), [error,setError] = useState(''), [notice,setNotice] = useState<MessageKey | ''>('');
  const refresh = useCallback(async () => {
    const [organization,people,removed] = await Promise.all([api<Organization>('/admin/organization'),api<User[]>('/admin/users'),api<User[]>('/admin/users?deleted=1')]);
    setOrg(organization);setUsers(people);setDeleted(removed);setLoading(false);
  },[]);
  useEffect(() => { void refresh().catch(reason => {setError(errorText(reason));setLoading(false);}); },[refresh]);
  async function perform(path:string, method:string, input:unknown, success:MessageKey, next?:(value:any)=>void) {
    setBusy(true);setError('');setNotice('');
    try { const value=await api(path,method,input);await refresh();setEditor(null);setRemoval(null);setNotice(success);next?.(value); }
    catch(reason) {setError(errorText(reason));} finally {setBusy(false);}
  }
  const company=org.companies.find(item=>scope.kind==='company'&&item.id===scope.id);
  const department=org.departments.find(item=>scope.kind==='department'&&item.id===scope.id);
  const companyId=company?.id || department?.company_id;
  const title=tab==='deleted'?uiText(language)("web.deletedMembers"):company?.name || department?.name || (scope.kind==='unassigned'?uiText(language)("web.unassignedMembers"):uiText(language)("web.allMembers"));
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
    void perform(`/admin/${resource}${editor.item?'/'+editor.item.id:''}`,editor.item?'PATCH':'POST',input,creating?"web.added":"web.saved",value=>{
      if(kind==='company')select({kind:'company',id:value.id});
      if(kind==='department')select({kind:'department',id:value.id});
    });
  }
  return <section className="admin-panel organization-admin"><div className="admin-heading"><div><span className="eyebrow">{uiText(language)("web.organizationAndAccess")}</span><h1>{uiText(language)("web.administration")}</h1><p className="muted">{uiText(language)("web.manageMembersByCompanyAndDepartmentEveryoneKeepsTheirOwnConversationSpace")}</p></div></div>
    <div className="admin-tabs" role="tablist" aria-label={uiText(language)("web.administrationSections")}>{(['people','deleted','plugins','models','remote-agents'] as const).map(value=><button key={value} role="tab" aria-selected={tab===value} onClick={()=>{setTab(value);setQuery('');setStatus('all');setError('');setNotice('');}}>{value==='people'?uiText(language)("web.organizationAndMembers"):value==='deleted'?uiText(language)("web.deleted", { count: deleted.length }):value==='plugins'?uiText(language)("web.pluginManagement"):value==='models'?uiText(language)("settingsNavigation.models"):uiText(language)("web.remoteAgents")}</button>)}</div>
    {error&&!editor&&!removal&&<p className="form-error" role="alert">{error}</p>}{notice&&<p className="form-notice" role="status">{uiText(language)(notice)}</p>}
    {tab==='models'?<ModelAdmin/>:loading?<p className="status-line">{uiText(language)("web.loadingOrganization")}</p>:tab==='remote-agents'?<RemoteAgentAdmin users={users}/>:tab==='plugins'?<PluginAdmin users={users}/>:<div className={`organization-layout ${tab==='deleted'?'without-tree':''}`}>
      {tab==='people'&&<nav className="organization-tree" aria-label={uiText(language)("web.companiesAndDepartments")}><header><strong>{uiText(language)("web.organizationStructure")}</strong><button className="icon-button" aria-label={uiText(language)("web.addCompany")} title={uiText(language)("web.addCompany")} onClick={()=>edit({kind:'company'})}><Plus size={17}/></button></header>
        <button className={`org-tree-row ${scope.kind==='all'?'selected':''}`} onClick={()=>select({kind:'all'})}><Users size={15}/>{uiText(language)("web.allMembers")}<span>{users.length}</span></button>
        <button className={`org-tree-row ${scope.kind==='unassigned'?'selected':''}`} onClick={()=>select({kind:'unassigned'})}><Users size={15}/>{uiText(language)("web.unassigned")}<span>{users.filter(user=>!user.department_id).length}</span></button>
        {org.companies.map(item=><div className="org-tree-company" key={item.id}><button className={`org-tree-row ${scope.kind==='company'&&scope.id===item.id?'selected':''}`} onClick={()=>select({kind:'company',id:item.id})}><Building2 size={15}/><strong>{item.name}</strong><span>{item.member_count}</span></button>
          {org.departments.filter(value=>value.company_id===item.id).map(value=><button key={value.id} className={`org-tree-row org-tree-department ${scope.kind==='department'&&scope.id===value.id?'selected':''}`} onClick={()=>select({kind:'department',id:value.id})}><ChevronRight size={13}/>{value.name}<span>{value.member_count}</span></button>)}
        </div>)}{!org.companies.length&&<p className="org-empty">{uiText(language)("web.addACompanyThenCreateDepartmentsAssignExistingAccountsFromTheUnassigned")}</p>}
      </nav>}
      <div className="organization-content"><div className="org-content-heading"><div>{department&&<span className="eyebrow">{department.company_name}</span>}<h2>{title}</h2>{(company?.description||department?.description)&&<p className="muted">{company?.description||department?.description}</p>}{tab==='deleted'&&<p className="muted">{uiText(language)("web.accountsAreDisabledTheirConversationsAndFilesAreRetainedAfterRestoringAn")}</p>}</div>
        <div className="org-actions">{company&&tab==='people'&&<><button aria-label={uiText(language)("web.editCompany2", { name: company.name })} onClick={()=>edit({kind:'company',item:company})}><Pencil size={14}/>{uiText(language)("web.editCompany")}</button><button className="danger" aria-label={uiText(language)("web.deleteCompany2", { name: company.name })} onClick={()=>remove({kind:'company',id:company.id,name:company.name})}><Trash2 size={14}/>{uiText(language)("web.deleteCompany")}</button><button onClick={()=>edit({kind:'department',companyId:company.id})}><Plus size={15}/>{uiText(language)("web.addDepartment")}</button></>}
          {department&&tab==='people'&&<><button aria-label={uiText(language)("web.editDepartment2", { name: department.name })} onClick={()=>edit({kind:'department',item:department})}><Pencil size={14}/>{uiText(language)("web.editDepartment")}</button><button className="danger" aria-label={uiText(language)("web.deleteDepartment2", { name: department.name })} onClick={()=>remove({kind:'department',id:department.id,name:department.name})}><Trash2 size={14}/>{uiText(language)("web.deleteDepartment")}</button></>}
          {tab==='people'&&<button className="primary" onClick={()=>edit({kind:'user',companyId,departmentId:department?.id})}><Plus size={15}/>{uiText(language)("web.addMember")}</button>}</div></div>
        {company&&tab==='people'&&<div className="department-cards">{org.departments.filter(item=>item.company_id===company.id).map(item=><button key={item.id} onClick={()=>select({kind:'department',id:item.id})}><strong>{item.name}</strong><span>{uiText(language)("web.members", { count: item.member_count })}<ChevronRight size={14}/></span></button>)}{!company.department_count&&<p className="org-empty">{uiText(language)("web.thisCompanyHasNoDepartmentsYetSelectAddDepartmentToGetStarted")}</p>}</div>}
        <div className="people-toolbar"><label className="people-search"><Search size={16}/><input aria-label={uiText(language)("web.searchMembers")} placeholder={uiText(language)("web.searchNameUsernameCompanyOrDepartment")} value={query} onChange={event=>setQuery(event.target.value)}/></label>{tab==='people'&&<select aria-label={uiText(language)("web.memberStatus")} value={status} onChange={event=>setStatus(event.target.value)}><option value="all">{uiText(language)("web.allStatuses")}</option><option value="enabled">{uiText(language)("automationPanel.active")}</option><option value="disabled">{uiText(language)("web.pendingDisabled")}</option></select>}<span>{uiText(language)("web.members", { count: filtered.length })}</span></div>
        <div className="user-table"><table><thead><tr><th>{uiText(language)("web.member")}</th><th>{uiText(language)("web.companyDepartment")}</th><th>{uiText(language)("web.role")}</th><th>{uiText(language)("agentDefinitionInspector.status")}</th><th>{uiText(language)("web.actions")}</th></tr></thead><tbody>{filtered.map(user=><tr key={user.id}><td><strong>{user.display_name}</strong><small>{user.username}</small></td><td>{user.company_name||uiText(language)("web.unassigned")}<small>{user.department_name||uiText(language)("web.noDepartmentAssigned")}</small></td><td>{roles[user.role] ? uiText(language)(roles[user.role]) : user.role}</td><td><span className={`user-status ${user.is_active?'enabled':''}`}>{user.deleted_at?uiText(language)("web.deleted2"):user.is_active?uiText(language)("automationPanel.active"):uiText(language)("web.pendingDisabled")}</span></td><td>{tab==='deleted'?<button disabled={busy} onClick={()=>void perform(`/admin/users/${user.id}/restore`,'POST',{},"web.accountRestoredAsPendingAssignADepartmentAndEnableItInThe")}>{uiText(language)("web.restoreMember")}</button>:<>
          <button aria-label={uiText(language)("web.editMember2", { username: user.username })} disabled={busy} onClick={()=>edit({kind:'user',item:user})}>{uiText(language)("common.edit")}</button><button disabled={busy||user.id===currentUserId} onClick={()=>void perform(`/admin/users/${user.id}`,'PATCH',{is_active:!user.is_active},user.is_active?"web.accountDisabled":"web.accountEnabled")}>{user.is_active?uiText(language)("pluginMcpSettings.disable"):uiText(language)("automationPanel.enable")}</button><button className="danger" aria-label={uiText(language)("web.deleteMember", { username: user.username })} disabled={busy||user.id===currentUserId} onClick={()=>remove({kind:'user',id:user.id,name:`${user.display_name} (${user.username})`})}>{uiText(language)("appCenter.delete")}</button></>}</td></tr>)}</tbody></table>{!filtered.length&&<p className="org-empty">{query?uiText(language)("web.noMatchingMembers"):tab==='deleted'?uiText(language)("web.noDeletedMembers"):uiText(language)("web.noMembersInThisScopeAddMembersOrEditAnExistingMember")}</p>}</div>
      </div>
    </div>}
    {editor&&<EditorDialog key={editor.kind+('item' in editor?editor.item?.id||'new':'new')} editor={editor} org={org} currentUserId={currentUserId} busy={busy} error={error} close={()=>{if(!busy)setEditor(null);}} save={save}/>}
    {removal&&<Dialog title={(removal.kind === 'company' ? uiText(language)("web.deleteCompany") : removal.kind === 'department' ? uiText(language)("web.deleteDepartment") : uiText(language)("speakerLockPanel.deletePerson"))} close={()=>{if(!busy)setRemoval(null);}}><p>{uiText(language)("web.delete", { name: removal.name })}</p><p>{removal.kind==='user'?uiText(language)("web.theAccountWillBeDisabledImmediatelyLoseSignInAndPluginAccess"):removal.kind==='company'?uiText(language)("web.moveOrDeleteThisCompanySDepartmentsBeforeDeletingIt"):uiText(language)("web.reassignThisDepartmentSMembersBeforeDeletingIt")}</p>{error&&<p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button disabled={busy} onClick={()=>setRemoval(null)}>{uiText(language)("agentConnectionForm.cancel")}</button><button className="primary destructive" disabled={busy} onClick={()=>void perform(`/admin/${removal.kind==='company'?'companies':removal.kind==='department'?'departments':'users'}/${removal.id}`,'DELETE',undefined,"web.deleted3",()=>{if(removal.kind!=='user')setScope({kind:'all'});})}>{busy?uiText(language)("web.deleting"):uiText(language)("teamGraphWorkspace.delete")}</button></div></Dialog>}
  </section>;
}

function Dialog({title,close,children}:{title:string;close:()=>void;children:ReactNode}) {
  const language = useUiLanguage();

  return <div className="modal-backdrop" onClick={close} onKeyDown={event=>{if(event.key==='Escape')close();}}><section className="modal organization-modal" role="dialog" aria-modal="true" aria-label={title} onClick={event=>event.stopPropagation()}><header><h2>{title}</h2><button className="icon-button" aria-label={uiText(language)("web.closeForm")} onClick={close}><X size={18}/></button></header>{children}</section></div>;
}
function EditorDialog({editor,org,currentUserId,busy,error,close,save}:{editor:Editor;org:Organization;currentUserId:string;busy:boolean;error:string;close:()=>void;save:(input:Record<string,unknown>)=>void}) {
  const language = useUiLanguage();

  const [companyId,setCompanyId]=useState(editor.kind==='company'?'':editor.item?.company_id||editor.companyId||'');
  const [departmentId,setDepartmentId]=useState(editor.kind==='user'?editor.item?.department_id||editor.departmentId||'':'');
  const person=editor.kind==='user'?editor.item:undefined;
  const title=(editor.kind === 'company' ? (editor.item ? uiText(language)("web.editCompany") : uiText(language)("web.addCompany")) : editor.kind === 'department' ? (editor.item ? uiText(language)("web.editDepartment") : uiText(language)("web.addDepartment")) : (editor.item ? uiText(language)("web.editMember") : uiText(language)("web.addMember")));
  function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();const form=new FormData(event.currentTarget);
    if(editor.kind==='user') {
      const password=String(form.get('password')||'');
      save({username:String(form.get('username')),display_name:String(form.get('display_name')),role:person?.id===currentUserId?person.role:String(form.get('role')),is_active:person?.id===currentUserId?person.is_active:form.get('is_active')==='on',department_id:departmentId||null,...(editor.item?(password?{new_password:password}:{}):{password})});
    } else save({name:String(form.get('name')),description:String(form.get('description')||''),...(editor.kind==='department'?{company_id:companyId}:{})});
  }
  return <Dialog title={title} close={close}><form onSubmit={submit}><fieldset disabled={busy}>
    {editor.kind==='user'?<div className="org-form-grid"><label>{uiText(language)("web.name")}<input autoFocus name="display_name" defaultValue={person?.display_name||''} required maxLength={120}/></label><label>{uiText(language)("web.username")}<input name="username" defaultValue={person?.username||''} required minLength={3} maxLength={80} pattern="[A-Za-z0-9_.-]+" autoComplete="off"/></label></div>:<label>{editor.kind==='company'?uiText(language)("web.companyName"):uiText(language)("web.departmentName")}<input autoFocus name="name" defaultValue={editor.item?.name||''} required maxLength={120}/></label>}
    {editor.kind!=='company'&&<div className="org-form-grid"><label>{uiText(language)("web.company")}<select aria-label={uiText(language)("web.company")} required={editor.kind==='department'} value={companyId} onChange={event=>{setCompanyId(event.target.value);setDepartmentId('');}}><option value="">{editor.kind==='user'?uiText(language)("web.unassigned"):uiText(language)("web.selectACompany")}</option>{org.companies.map(company=><option key={company.id} value={company.id}>{company.name}</option>)}</select></label>{editor.kind==='user'&&<label>{uiText(language)("web.department")}<select aria-label={uiText(language)("web.department")} required={Boolean(companyId)} disabled={!companyId} value={departmentId} onChange={event=>setDepartmentId(event.target.value)}><option value="">{companyId?uiText(language)("web.selectADepartment"):uiText(language)("web.unassigned")}</option>{org.departments.filter(department=>department.company_id===companyId&&department.is_active).map(department=><option key={department.id} value={department.id}>{department.name}</option>)}</select></label>}</div>}
    {editor.kind==='user'?<><label>{uiText(language)("web.role")}<select name="role" defaultValue={person?.role||'member'} disabled={person?.id===currentUserId}>{Object.entries(roles).map(([value,label])=><option value={value} key={value}>{uiText(language)(label)}</option>)}</select></label><label>{person?uiText(language)("web.resetPasswordLeaveBlankToKeepIt"):uiText(language)("web.initialPassword")}<input name="password" type="password" autoComplete="new-password" required={!person} minLength={8} maxLength={128} placeholder={uiText(language)("web.atLeast8Characters")}/></label><label className="org-checkbox"><input name="is_active" type="checkbox" defaultChecked={person?person.is_active:true} disabled={person?.id===currentUserId}/>{uiText(language)("web.enableAccountAndAllowSignIn")}</label><p className="muted org-help">{uiText(language)("web.systemAdministratorsManageTheOrganizationAndAccountsDepartmentMembershipDoesNotGrant")}</p></>:<label>{uiText(language)("web.description")}<textarea name="description" rows={3} maxLength={500} defaultValue={editor.item?.description||''}/></label>}
    {error&&<p className="form-error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" onClick={close}>{uiText(language)("agentConnectionForm.cancel")}</button><button className="primary" type="submit">{busy?uiText(language)("networkProxySettings.saving"):uiText(language)("appCenter.save")}</button></div></fieldset></form></Dialog>;
}
