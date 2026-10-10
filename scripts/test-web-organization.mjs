import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { PostgresWebStore, hashWebPassword } from '../dist-electron/webStore.mjs';
import { serveWeb } from '../dist-electron/webServer.mjs';
import { tenantKey } from '../dist-electron/webCommon.mjs';

const connection = process.env.CARDBUSH_TEST_DATABASE_URL;
assert.ok(connection, 'Set CARDBUSH_TEST_DATABASE_URL to an isolated PostgreSQL test database.');
assert.equal(new URL(connection).pathname, '/cardbush_web_organization_test', 'Never run this suite on a product database.');
const store = new PostgresWebStore(connection);
const origin='http://web-org.test', password='organization-test-only';
let web,admin,adminActor,legacyHash,agentStarts=0;
function client() {
  let cookie='',csrf='';
  return {async request(path,method='GET',body,expected=200) {
    const response=await fetch(`http://127.0.0.1:${web.port}/api/web/v1${path}`,{method,headers:{Origin:origin,Cookie:cookie,'X-CSRF-Token':csrf,...(body===undefined?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:JSON.stringify(body)});
    const value=await response.json(); assert.equal(response.status,expected,JSON.stringify(value));
    if(response.headers.get('set-cookie'))cookie=response.headers.get('set-cookie').split(';')[0];
    if(value.csrf)csrf=value.csrf;return value;
  }};
}
before(async()=>{
  // Deliberately create the old schema first: this verifies a real upgrade, not only an empty install.
  await store.pool.query(`CREATE TABLE departments (id varchar(64) PRIMARY KEY,name varchar(120) UNIQUE NOT NULL,description varchar(500),is_active boolean NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL);
    CREATE TABLE user_accounts (id varchar(64) PRIMARY KEY,username varchar(80) UNIQUE NOT NULL,display_name varchar(120) NOT NULL,password_hash varchar(300) NOT NULL,role varchar(40) NOT NULL,department_id varchar(64) REFERENCES departments(id),module_permissions json NOT NULL,is_active boolean NOT NULL,created_at timestamptz NOT NULL,updated_at timestamptz NOT NULL,last_login_at timestamptz);
    INSERT INTO departments(id,name,is_active,created_at,updated_at) VALUES('legacy_department','原有部门',true,now(),now());`);
  legacyHash=await hashWebPassword(password);
  await store.pool.query("INSERT INTO user_accounts(id,username,display_name,password_hash,role,department_id,is_active,module_permissions,created_at,updated_at) VALUES('admin','admin','管理员',$1,'admin',NULL,true,'[]',now(),now()),('legacy','legacy','原有人员',$1,'member','legacy_department',true,'[]',now(),now())",[legacyHash]);
  await store.migrate();
  web=await serveWeb({origin,host:'127.0.0.1',port:0,staticRoot:resolve('dist-web'),modelSecret:'m'.repeat(64),defaultModelId:'test',models:[{id:'test',name:'test',model:'test',apiKey:'fixture-only',baseURL:'http://127.0.0.1:1'}]},store,{get(){agentStarts++;throw new Error('Organization operations must not start tenant runtimes');},close(){}});
  admin=client();adminActor=(await admin.request('/auth/login','POST',{username:'admin',password})).user;
});
after(async()=>{await web?.close();await store.pool.end();});

test('migration preserves original identities and departments and is repeatable',async()=>{
  await store.migrate();
  const original=(await store.pool.query("SELECT * FROM user_accounts WHERE id='legacy'")).rows[0];
  assert.equal(original.password_hash,legacyHash);assert.equal(original.department_id,'legacy_department');assert.equal(original.is_active,true);
  const org=await admin.request('/admin/organization');assert.equal(org.companies.length,1);assert.equal(org.departments[0].company_id,'company_legacy');
  assert.equal((await store.user('admin')).department_id,null);
});

test('company, department and person CRUD preserve identity during transfers and enforce empty deletion',async()=>{
  const a=await admin.request('/admin/companies','POST',{name:'甲公司',description:'验收'},201);
  const b=await admin.request('/admin/companies','POST',{name:'乙公司'},201);
  await admin.request('/admin/companies','POST',{name:'甲公司'},409);
  const da=await admin.request('/admin/departments','POST',{name:'设计部',company_id:a.id},201);
  const db=await admin.request('/admin/departments','POST',{name:'设计部',company_id:b.id},201);
  await admin.request('/admin/departments','POST',{name:'设计部',company_id:a.id},409);
  const person=await admin.request('/admin/users','POST',{username:'transfer_user',display_name:'调动人员',password,department_id:da.id,is_active:false,role:'department_admin'},201);
  const key=tenantKey(person.id);
  const edited=await admin.request('/admin/users/'+person.id,'PATCH',{display_name:'改名人员'});
  assert.equal(edited.is_active,false);assert.equal(edited.role,'department_admin'); // Partial edits must not apply creation defaults.
  await admin.request('/admin/companies/'+a.id,'DELETE',undefined,409);
  await admin.request('/admin/departments/'+da.id,'DELETE',undefined,409);
  await admin.request('/admin/users/'+person.id,'PATCH',{department_id:'missing'},400);
  const moved=await admin.request('/admin/users/'+person.id,'PATCH',{department_id:db.id});assert.equal(moved.company_id,b.id);assert.equal(tenantKey(moved.id),key);
  await admin.request('/admin/departments/'+da.id,'PATCH',{name:'设计部',company_id:b.id},409);
  await admin.request('/admin/departments/'+da.id,'PATCH',{name:'设计二部',company_id:b.id,description:'移到乙公司'});
  assert.equal((await admin.request('/admin/departments/'+da.id)).company_id,b.id);
  await admin.request('/admin/companies/'+a.id,'PATCH',{name:'甲公司已改名',description:'新说明'});
  assert.equal((await admin.request('/admin/companies/'+a.id)).name,'甲公司已改名');
  await admin.request('/admin/companies/'+a.id,'DELETE');
  await admin.request('/admin/users/'+person.id,'DELETE');
  await admin.request('/admin/departments/'+da.id,'DELETE');await admin.request('/admin/departments/'+db.id,'DELETE');await admin.request('/admin/companies/'+b.id,'DELETE');
});

test('account deletion revokes login and plugins, reserves its username and retains private history',async()=>{
  const user=await admin.request('/admin/users','POST',{username:'recover_user',display_name:'恢复人员',password,department_id:'legacy_department'},201);
  const owner=client();await owner.request('/auth/login','POST',{username:user.username,password});
  await store.create(user.id,'web-'+'a'.repeat(40),'private original conversation');
  await admin.request('/admin/plugins','POST',{action:'install'});await admin.request('/admin/plugins/volcengine_images/users/'+user.id,'PUT',{enabled:true});assert.equal(await store.imageAllowed(user.id),true);
  await admin.request('/admin/users/'+user.id,'DELETE');
  await owner.request('/auth/me','GET',undefined,401);await client().request('/auth/login','POST',{username:user.username,password},401);
  assert.equal(await store.imageAllowed(user.id),false);assert.equal((await store.list(user.id)).length,1);assert.equal(await store.user(user.id),null);
  assert.ok((await admin.request('/admin/users?deleted=1')).some(row=>row.id===user.id));assert.ok(!(await admin.request('/admin/users')).some(row=>row.id===user.id));
  await client().request('/auth/register','POST',{username:user.username,display_name:'不能重用',password},409);
  const restored=await admin.request('/admin/users/'+user.id+'/restore','POST',{});assert.equal(restored.is_active,false);assert.equal(restored.department_id,null);
  await client().request('/auth/login','POST',{username:user.username,password},403);
  await admin.request('/admin/users/'+user.id,'PATCH',{is_active:true,department_id:'legacy_department'});
  const again=client();await again.request('/auth/login','POST',{username:user.username,password});assert.equal((await again.request('/sessions'))[0].title,'private original conversation');
  assert.equal(await store.imageAllowed(user.id),false);await owner.request('/auth/me','GET',undefined,401);
});

test('username and password changes invalidate old sessions without exposing password hashes',async()=>{
  const user=await admin.request('/admin/users','POST',{username:'rename_user',display_name:'重命名',password},201);
  const owner=client();await owner.request('/auth/login','POST',{username:user.username,password});
  await admin.request('/admin/users/'+user.id,'PATCH',{username:user.username,role:user.role,display_name:'改姓名并保留登录',department_id:'legacy_department'});
  assert.equal((await owner.request('/auth/me')).user.id,user.id);
  const changed=await admin.request('/admin/users/'+user.id,'PATCH',{username:'renamed_user',new_password:'new-fixture-password'});
  assert.equal(changed.id,user.id);assert.ok(!JSON.stringify(changed).includes('scrypt'));
  await owner.request('/auth/me','GET',undefined,401);await client().request('/auth/login','POST',{username:'renamed_user',password},401);
  await client().request('/auth/login','POST',{username:'renamed_user',password:'new-fixture-password'});
  await admin.request('/admin/users/'+user.id,'PATCH',{password_hash:'forged'},400);
});

test('all management endpoints reject members and department admins and protect current admin',async()=>{
  const delegated=await admin.request('/admin/users','POST',{username:'department_manager',display_name:'部门管理员',password,role:'department_admin',department_id:'legacy_department'},201);
  for(const username of ['legacy',delegated.username]) {
    const member=client();await member.request('/auth/login','POST',{username,password});
    for(const [path,method,body] of [['/admin/organization','GET'],['/admin/companies','POST',{name:'forbidden'}],['/admin/companies/company_legacy','DELETE'],['/admin/departments','POST',{name:'forbidden',company_id:'company_legacy'}],['/admin/users','POST',{username:'bad',password}],['/admin/users/admin','GET'],['/admin/users/admin','PATCH',{role:'member'}],['/admin/users/admin','DELETE'],['/admin/users/admin/restore','POST',{}]]) await member.request(path,method,body,403);
  }
  await admin.request('/admin/users/admin','DELETE',undefined,409);await admin.request('/admin/users/admin','PATCH',{role:'member'},409);await admin.request('/admin/users/admin','PATCH',{is_active:false},409);
  assert.equal(agentStarts,0);
});

test('serialized authority checks prevent two stale administrators changing each other',async()=>{
  const a=await store.createUser(adminActor,{username:'race_admin_a',display_name:'A',password,role:'admin'}),b=await store.createUser(adminActor,{username:'race_admin_b',display_name:'B',password,role:'admin'});
  const results=await Promise.allSettled([store.updateUser(a,b.id,{role:'member'}),store.updateUser(b,a.id,{role:'member'})]);
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);assert.equal(results.find(result=>result.status==='rejected').reason.status,403);
});

test('registration presents company-qualified departments and keeps new people pending approval',async()=>{
  const publicClient=client();const choices=await publicClient.request('/auth/departments');assert.ok(choices.every(row=>row.company_id&&row.company_name));
  await publicClient.request('/auth/register','POST',{username:'registered_person',display_name:'新注册',password,department_id:'legacy_department'},201);
  const user=(await store.users()).find(row=>row.username==='registered_person');assert.equal(user.company_id,'company_legacy');assert.equal(user.is_active,false);
  await publicClient.request('/auth/register','POST',{username:'bad_department',display_name:'不存在部门',password,department_id:'missing'},400);
  await admin.request('/admin/users/'+user.id,'PATCH',{is_active:true});await publicClient.request('/auth/login','POST',{username:'registered_person',password});
});
