import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, readFile, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { InMemoryRuntimeHost, TaskWorkspaceManager, ToolExecutionCoordinator, ToolRegistry, registerWorkspaceTools, registerSkillTools } from '../dist/index.js';
import { parseSshWorkspace, sshWorkspace } from '@cardbush/bush-protocol';
import { protectedPosixTerminalDeletion } from '../dist/terminalCommandSafety.js';

const remote=sshWorkspace('test-connection','/home/user/My Project');
async function storage(t){const root=await realpath(await mkdtemp(join(tmpdir(),'cardbush-ssh-runtime-')));t.after(async()=>{assert.equal(dirname(root).toLowerCase(),(await realpath(tmpdir())).toLowerCase());await rm(root,{recursive:true,force:true,maxRetries:5});});return root;}
test('SSH identities preserve case, Unicode and reserved characters',()=>{
  const path='/home/项目/A #100%';assert.deepEqual(parseSshWorkspace(sshWorkspace('abc',path)),{connectionId:'abc',path});
  for(const invalid of ['ssh://user@host/path','ssh://abc/%00','ssh://abc/%broken'])assert.throws(()=>parseSshWorkspace(invalid));
});
test('remote workspace persists, switches case-sensitive paths and rebinds locally without local remote-path access',async t=>{
  const root=await storage(t),manager=new TaskWorkspaceManager(join(root,'states'));
  const first=await manager.create('chat',remote,'auto');assert.equal(first.versioning,'none');assert.equal(first.mode,'direct');
  assert.equal(await manager.beginTurn('chat','turn'),false);
  const other=sshWorkspace('test-connection','/home/user/my project');await manager.rebind('chat',other);
  assert.equal((await new TaskWorkspaceManager(join(root,'states')).descriptor('chat')).workspaceDir,other);
  await assert.rejects(manager.create('copy',remote,'worktree'),/directly/);
  const local=join(root,'local');await mkdir(local);assert.equal((await manager.rebind('chat',local)).workspaceDir,local);
  await manager.rebind('chat',remote);assert.equal((await manager.descriptor('chat')).workspaceDir,remote);
});
test('Runtime validates SSH directories, rejects switching while remote processes run, and retains prior binding on failure',async t=>{
  const root=await storage(t);let busy=false,fail=false;const requests=[];
  const host=new InMemoryRuntimeHost({dataRoot:root,remoteWorkspace:{async request(action,payload){requests.push({action,payload});if(fail&&action==='directory')throw Error('SSH offline');if(action==='directory')return {uri:payload.uri};return {running:busy};}}});
  const command=(kind,payload)=>host.sendCommand({kind:'runtime.'+kind,payload});
  await command('create_session',{sessionId:'chat',workspace:{sourceDir:remote,mode:'direct'}});
  const next=sshWorkspace('test-connection','/another');
  async function switchTo(){const snapshot=await command('get_session',{sessionId:'chat'});return command('switch_workspace',{sessionId:'chat',expectedRevision:snapshot.revision,projectDir:next,projectId:'next'});}
  busy=true;await assert.rejects(switchTo(),/运行|终端|terminal/i);busy=false;fail=true;await assert.rejects(switchTo(),/offline/);
  assert.equal((await command('get_workspace',{sessionId:'chat'})).workspace.workspaceDir,remote);
  fail=false;await switchTo();assert.equal((await command('get_workspace',{sessionId:'chat'})).workspace.workspaceDir,next);
  assert.ok(requests.some(item=>item.payload.name==='workspace_busy'));
});
test('the next SSH turn uses the switched directory even with stale caller metadata',async t=>{
  const root=await storage(t),next=sshWorkspace('test-connection','/home/user/my project');
  const reads=[],modelRequests=[];let round=0;
  const host=new InMemoryRuntimeHost({dataRoot:root,remoteWorkspace:{async request(action,payload){
    if(action==='directory')return {uri:payload.uri};
    if(action==='authorize')return {path:payload.uri+'/package.json',root:payload.uri,inside:true,home:'/home/user'};
    if(payload.name==='workspace_busy')return {running:false};
    assert.equal(payload.name,'read_file');reads.push(payload);return {path:payload.uri+'/package.json',content:'{"name":"new-project"}'};
  }},provider:{async *stream(request){
    modelRequests.push(request);
    const base={protocol:'bush.model_event.v1',requestId:request.requestId,createdAt:new Date().toISOString()};
    if(round++===0){
      yield {...base,sequence:0,kind:'tool_call_delta',index:0,toolCallId:'read-new-project',nameDelta:'read_file',argumentsDelta:'{"path":"package.json"}'};
      yield {...base,sequence:1,kind:'response_completed',finishReason:'tool_calls'};
    }else{
      yield {...base,sequence:0,kind:'text_delta',delta:'Read the new project.'};
      yield {...base,sequence:1,kind:'response_completed',finishReason:'stop'};
    }
  }}});
  const command=(kind,payload)=>host.sendCommand({kind:'runtime.'+kind,payload});
  await command('create_session',{sessionId:'chat',workspace:{sourceDir:remote,mode:'direct'},metadata:{project_id:'old-project'}});
  const before=await command('get_session',{sessionId:'chat'});
  const switched=await command('switch_workspace',{sessionId:'chat',expectedRevision:before.revision,projectDir:next,projectId:'new-project'});
  assert.equal(switched.metadata.project_id,'new-project');assert.equal(switched.metadata.project_dir,next);
  const tools=(await command('get_tool_catalog',{})).filter(tool=>tool.name==='read_file');
  await host.runSessionTurn({protocol:'bush.session_turn_request.v1',requestId:'request',sessionId:'chat',turnId:'after-switch',model:'fixture',tools,
    metadata:{workspaceDir:remote,projectDir:remote},inputMessages:[{messageId:'user',message:{role:'user',content:'Read the selected project.'}}]});
  assert.equal(reads.length,1);assert.equal(reads[0].uri,next);
  assert.ok(modelRequests.length>0);assert.ok(modelRequests.every(request=>request.metadata.workspaceDir===next&&request.metadata.projectDir===next));
});

test('built-in files/terminals route via SSH, permissions name remote paths, and absent adapter fails closed',async()=>{
  const requests=[],permissions=[];
  const bridge={async request(action,payload){requests.push({action,payload});return action==='authorize'?{path:payload.path,root:remote,inside:!payload.path.endsWith('/outside'),home:'/home/user'}:{content:'remote',state:'completed'};}};
  function setup(adapter){const registry=new ToolRegistry();registerWorkspaceTools(registry,undefined,{remote:adapter});const coordinator=new ToolExecutionCoordinator({registry,permissions:{async request(input){permissions.push(input);return {protocol:'bush.runtime_permission_answer.v1',permissionId:'p',answerId:'a',decision:'allow_once',grantedCapabilityIds:input.capabilityIds};}}});return(name,input)=>coordinator.execute({protocol:'bush.tool_call.v1',id:'call-'+Math.random(),name,argumentsText:JSON.stringify(input)},{requestId:'r',sessionId:'chat',turnId:'t',round:1,ordinal:0},undefined,{request:{protocol:'bush.model_request.v1',requestId:'r',sessionId:'chat',turnId:'t',model:'test',messages:[],tools:registry.definitions(),metadata:{workspaceDir:remote}},contextMessages:[]});}
  const execute=setup(bridge);assert.equal((await execute('read_file',{path:'file.txt'})).kind,'returned');
  assert.equal((await execute('terminal_exec',{cwd:'.',command:'pwd',shell:'posix',yield_time_ms:1})).kind,'returned');
  assert.ok(permissions[0].targets[0].value.startsWith('ssh://'));
  const before=requests.filter(item=>item.action==='execute').length;
  assert.match(JSON.stringify(await execute('terminal_exec',{cwd:'.',command:'rm -rf .',shell:'posix',yield_time_ms:1})),/protected_path_delete_denied/);
  assert.equal(requests.filter(item=>item.action==='execute').length,before);
  const unavailable=await setup(undefined)('read_file',{path:'package.json'});assert.notEqual(unavailable.kind,'returned');assert.match(JSON.stringify(unavailable),/SSH/);
});
test('remote deletion protection uses POSIX roots and remote home on a Windows desktop',()=>{
  const check=command=>protectedPosixTerminalDeletion({command,cwd:'/home/user/project',root:'/home/user/project',home:'/home/user'});
  for(const command of ['rm -rf /','rm -rf .','cd ..; rm -rf project','rm -rf "$HOME"'])assert.ok(check(command),command);
  assert.equal(check('rm -rf build'),null);assert.equal(check('rm -rf /home/user/Project'),null);
});

function routedTools(bridge, metadata, permitted = () => true) {
  const registry = new ToolRegistry(), permissions = [];
  registerWorkspaceTools(registry, undefined, { remote: bridge });
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { async request(input) {
    permissions.push(input);
    return { protocol: 'bush.runtime_permission_answer.v1', permissionId: 'p', answerId: 'a',
      decision: permitted(input) ? 'allow_once' : 'deny', grantedCapabilityIds: permitted(input) ? input.capabilityIds : [] };
  } } });
  return { registry, permissions, execute: (name, input, owner = 'chat') => coordinator.execute({ protocol: 'bush.tool_call.v1',
    id: 'call-' + Math.random(), name, argumentsText: JSON.stringify(input) },
    { requestId: 'r', sessionId: owner, turnId: 't', round: 1, ordinal: 0 }, undefined,
    { request: { protocol: 'bush.model_request.v1', requestId: 'r', sessionId: owner, turnId: 't', model: 'fixture', messages: [],
      tools: registry.definitions(), metadata }, contextMessages: [] }) };
}

test('SSH defaults coexist with local skill resources and observed local edits in one session', async t => {
  const root = await storage(t), skill = join(root, 'deploy'), main = join(skill, 'SKILL.md');
  await mkdir(join(skill, 'references'), { recursive: true });
  await writeFile(main, '---\nname: deploy\ndescription: Deploy service\n---\nRead references/guide.md.');
  await writeFile(join(skill, 'references/guide.md'), 'local reference');
  const requests = [], bridge = { async request(action, payload) {
    requests.push({ action, payload });
    if (action === 'authorize') return { path: payload.path, root: payload.uri, inside: true, home: '/home/user' };
    return { content: 'remote source', path: remote + '/file.txt' };
  } };
  const metadata = { workspaceDir: remote, projectDir: remote, taskRoots: [remote] }, setup = routedTools(bridge, metadata);
  registerSkillTools(setup.registry, [root]);
  const discovery = await setup.execute('search_skills', { query: 'deploy' });
  const match = discovery.result.matches[0];
  assert.equal(match.environment, 'local');
  const loaded = await setup.execute('read_file', { path: match.mainResource, environment: match.environment });
  assert.equal(loaded.kind, 'returned', JSON.stringify(loaded));
  assert.match(loaded.result.content, /Read references/);
  assert.equal(loaded.result.executionEnvironment.kind, 'local');
  assert.equal((await setup.execute('read_file', { path: join(skill, 'references/guide.md'), environment: 'local' })).result.content, 'local reference');
  assert.equal(requests.length, 0, 'local resources never reach the SSH bridge');
  const edited = await setup.execute('edit_file', { path: join(skill, 'references/guide.md'), old_text: 'local', new_text: 'updated', environment: 'local' });
  assert.equal(edited.kind, 'returned', JSON.stringify(edited));
  assert.equal(await readFile(join(skill, 'references/guide.md'), 'utf8'), 'updated reference');
  const readRemote = await setup.execute('read_file', { path: 'file.txt' });
  assert.equal(readRemote.result.content, 'remote source');
  assert.equal(readRemote.result.executionEnvironment.connectionId, 'test-connection');
  assert.equal(metadata.workspaceDir, remote, 'per-call routing cannot rebind the conversation');
  assert.ok(setup.permissions.every(p => p.scope.roots.every(value => !value.includes('ssh:'))), 'remote task roots never become local permissions');
  assert.notEqual((await setup.execute('read_file', { path: 'SKILL.md', environment: 'local' })).kind, 'returned', 'local relative paths cannot inherit remote cwd');
});

test('explicit environments retain host permissions and never fall back on errors', async t => {
  const root = await storage(t), local = join(root, 'local.txt'); await writeFile(local, 'private');
  const calls = [], bridge = { async request(action, payload) {
    calls.push({ action, payload });
    if (action === 'authorize') return { path: payload.path, root: payload.uri, inside: true, home: '/home/user' };
    throw Error('SSH offline');
  } };
  const setup = routedTools(bridge, { workspaceDir: remote, taskRoots: [remote] }, () => false);
  assert.notEqual((await setup.execute('read_file', { path: local, environment: 'local' })).kind, 'returned');
  assert.equal(calls.length, 0);
  assert.match(setup.permissions[0].reason, /Local host/);
  const other = sshWorkspace('another-connection', '/srv/project');
  assert.notEqual((await setup.execute('read_file', { path: 'secret', environment: other })).kind, 'returned');
  assert.equal(calls.filter(c => c.action === 'execute').length, 0);
  assert.deepEqual(setup.permissions.at(-1).scope.roots, [], 'a tool-selected remote root is not an implicit grant');
  const allowed = routedTools(bridge, { workspaceDir: root });
  const offline = await allowed.execute('read_file', { path: 'local.txt', environment: other });
  assert.match(JSON.stringify(offline), /SSH offline/);
  assert.equal(await readFile(local, 'utf8'), 'private');
  for (const invalid of [false, '', 'remote', 'ssh://user@host/path']) {
    assert.notEqual((await allowed.execute('read_file', { path: local, environment: invalid })).kind, 'returned');
  }
  assert.notEqual((await allowed.execute('read_file', { path: other + '/secret', environment: 'local' })).kind, 'returned');
  assert.notEqual((await allowed.execute('terminal_exec', { environment: 'local', cwd: root, command: 'echo invalid-shell', shell: process.platform === 'win32' ? 'posix' : 'powershell', yield_time_ms: 1 })).kind, 'returned');
});

test('explicit SSH subdirectories do not expand the selected project permission root', async t => {
  const root = await storage(t), calls = [];
  const bridge = { async request(action, payload) {
    calls.push({ action, payload });
    if (action === 'authorize') return { path: payload.path, root: payload.uri, inside: false, home: '/home/user' };
    return { content: 'authorized remote file' };
  } };
  const setup = routedTools(bridge, { workspaceDir: remote });
  const outside = sshWorkspace('test-connection', '/outside');
  assert.equal((await setup.execute('read_file', { path: 'file.txt', environment: outside })).kind, 'returned');
  assert.equal(calls[0].payload.uri, remote);
  assert.equal(parseSshWorkspace(calls[0].payload.path).path, '/outside/file.txt');
  assert.deepEqual(setup.permissions[0].scope.roots, [remote]);
  const fromLocal = routedTools(bridge, { workspaceDir: root });
  await fromLocal.execute('read_file', { path: 'file.txt', environment: outside });
  assert.deepEqual(fromLocal.permissions[0].scope.roots, []);
});

test('terminal handles select their original host, reject host conflicts and remain owner scoped', async t => {
  const root = await storage(t), calls = [], uri = sshWorkspace('other-host', '/work');
  const bridge = { async request(action, payload) {
    calls.push({ action, payload });
    if (action === 'terminals') return { sessions: payload.owner === 'chat' ? [{ terminalSessionId: 'ssh-terminal-owned', uri, state: 'running' }] : [] };
    assert.equal(payload.uri, uri);
    return { terminalSessionId: payload.input.sessionId, state: 'running', stdout: 'remote output' };
  } };
  const setup = routedTools(bridge, { workspaceDir: root });
  const polled = await setup.execute('terminal_poll', { session_id: 'ssh-terminal-owned', yield_time_ms: 1 });
  assert.equal(polled.kind, 'returned'); assert.equal(polled.result.executionEnvironment.connectionId, 'other-host');
  const before = calls.filter(c => c.action === 'execute').length;
  assert.notEqual((await setup.execute('terminal_stop', { session_id: 'ssh-terminal-owned', environment: 'local' })).kind, 'returned');
  assert.notEqual((await setup.execute('terminal_write', { session_id: 'ssh-terminal-owned', chars: 'x', yield_time_ms: 1 }, 'other-session')).kind, 'returned');
  assert.equal(calls.filter(c => c.action === 'execute').length, before);
  assert.equal((await setup.execute('terminal_list', {})).result.sessions[0].executionEnvironment.connectionId, 'other-host');
  assert.deepEqual((await setup.execute('terminal_list', { environment: 'local' })).result.sessions, []);
});
