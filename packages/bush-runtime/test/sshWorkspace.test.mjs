import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, rm, readFile, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { InMemoryRuntimeHost, TaskWorkspaceManager, ToolExecutionCoordinator, ToolRegistry, registerWorkspaceTools } from '../dist/index.js';
import { parseSshWorkspace, sshWorkspace } from '@cardbush/bush-protocol';
import { protectedPosixTerminalDeletion, protectedTerminalDeletion } from '../dist/terminalCommandSafety.js';

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
for (const [platform, next] of [
  ['posix', sshWorkspace('test-connection', '/home/user/my project')],
  ['windows', sshWorkspace('test-connection', 'C:\\Users\\111')],
]) test(`the next ${platform} SSH turn uses the switched directory even with stale caller metadata`,async t=>{
  const root=await storage(t);
  const reads=[],modelRequests=[];let round=0;
  const host=new InMemoryRuntimeHost({dataRoot:root,remoteWorkspace:{async request(action,payload){
    if(action==='directory')return {uri:payload.uri};
    if(action==='authorize')return {path:payload.uri,root:payload.uri,inside:true,platform,home:platform==='windows'?'/C:/Users/111':'/home/user'};
    if(payload.name==='workspace_busy')return {running:false};
    assert.equal(payload.name,'terminal_exec');reads.push(payload);return {terminalSessionId:'remote-command',state:'completed',exitCode:0,stdout:'new-project'};
  }},provider:{async *stream(request){
    modelRequests.push(request);
    const base={protocol:'bush.model_event.v1',requestId:request.requestId,createdAt:new Date().toISOString()};
    if(round++===0){
      yield {...base,sequence:0,kind:'tool_call_delta',index:0,toolCallId:'read-new-project',nameDelta:'terminal_exec',argumentsDelta:'{"command":"pwd","cwd":".","yield_time_ms":1}'};
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
  const tools=await command('get_tool_catalog',{});
  const permissions=(async()=>{
    for await(const event of host.openEventStream({sessionId:'chat',turnId:'after-switch'})) {
      if(event.kind==='permission_requested')await command('answer_permission',{
        protocol:'bush.runtime_permission_answer.v1',permissionId:event.payload.permissionId,answerId:'fixture-answer',
        decision:'allow_once',grantedCapabilityIds:event.payload.requestedCapabilityIds});
    }
  })();
  await host.runSessionTurn({protocol:'bush.session_turn_request.v1',requestId:'request',sessionId:'chat',turnId:'after-switch',model:'fixture',tools,permissionMode:'task_free',
    metadata:{workspaceDir:remote,projectDir:remote},inputMessages:[{messageId:'user',message:{role:'user',content:'Read the selected project.'}}]});
  await permissions;
  assert.equal(reads.length,1);assert.equal(reads[0].uri,next);
  assert.ok(modelRequests.length>0);assert.ok(modelRequests.every(request=>request.metadata.workspaceDir===next&&request.metadata.projectDir===next));
  for (const request of modelRequests) {
    assert.deepEqual(request.tools.map(tool=>tool.name).sort(), ['terminal_exec','terminal_list','terminal_poll','terminal_stop','terminal_write']);
    assert.ok(request.tools.every(tool=>!Object.hasOwn(tool.inputSchema.properties,'environment')));
    assert.ok(request.tools.every(tool=>Object.hasOwn(tool.inputSchema.properties,'_display_title')), 'terminal actions retain localized UI titles');
  }
  const binding = modelRequests[0].messages.find(message => message.name === 'ssh_workspace_binding')?.content;
  assert.ok(binding?.includes(parseSshWorkspace(next).path));
  assert.match(binding, /Omit shell for the detected remote default/);
  assert.match(binding, /powershell\/cmd on Windows and posix on Linux/);
  assert.doesNotMatch(binding, /Use POSIX paths and shell="posix" remotely/);
});

test('built-in files/terminals route via SSH, permissions name remote paths, and absent adapter fails closed',async()=>{
  const requests=[],permissions=[];
  const bridge={async request(action,payload){requests.push({action,payload});return action==='authorize'?{path:payload.path,root:remote,inside:!payload.path.endsWith('/outside'),home:'/home/user'}:{content:'remote',state:'completed'};}};
  function setup(adapter){const registry=new ToolRegistry();registerWorkspaceTools(registry,undefined,{remote:adapter});const coordinator=new ToolExecutionCoordinator({registry,permissions:{async request(input){permissions.push(input);return {protocol:'bush.runtime_permission_answer.v1',permissionId:'p',answerId:'a',decision:'allow_once',grantedCapabilityIds:input.capabilityIds};}}});return(name,input)=>coordinator.execute({protocol:'bush.tool_call.v1',id:'call-'+Math.random(),name,argumentsText:JSON.stringify(input)},{requestId:'r',sessionId:'chat',turnId:'t',round:1,ordinal:0},undefined,{request:{protocol:'bush.model_request.v1',requestId:'r',sessionId:'chat',turnId:'t',model:'test',messages:[],tools:registry.definitions(),metadata:{workspaceDir:remote}},contextMessages:[]});}
  const execute=setup(bridge);assert.equal((await execute('read_file',{path:'file.txt'})).kind,'returned');
  assert.equal((await execute('terminal_exec',{cwd:'.',command:'pwd',shell:'posix',yield_time_ms:1})).kind,'returned');
  assert.ok(permissions[0].targets[0].value.startsWith('ssh://'));
  const before=requests.filter(item=>item.action==='execute').length;
  const permissionCount=permissions.length;
  assert.match(JSON.stringify(await execute('terminal_exec',{cwd:'.',command:'pwd',shell:'posix',yield_time_ms:1,exclusive_resources:['host:gpu']})),/terminal_resource_coordination_unavailable/);
  assert.equal(permissions.length,permissionCount,'unsupported coordination must fail before asking permission');
  assert.equal(requests.filter(item=>item.action==='execute').length,before,'never silently drop the resource declaration on SSH');
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

test('Windows remote deletion protection uses the remote home, native paths and shell', () => {
  const check = (command, shell = 'powershell') => protectedTerminalDeletion({
    command, shell, cwd: 'D:\\Users\\111\\Project', projectRoots: ['D:\\Users\\111\\Project'],
    remoteWindows: { home: 'D:\\Users\\111' },
  });
  for (const command of ['Remove-Item -LiteralPath D:\\ -Recurse', 'Remove-Item $HOME -Recurse',
    'Remove-Item -LiteralPath d:\\users\\111\\project -Recurse', 'Set-Location ..; Remove-Item . -Recurse',
    'Push-Location child; Pop-Location; Remove-Item . -Recurse']) assert.ok(check(command), command);
  for (const command of ['rd /s /q D:\\', 'rd /s /q "%USERPROFILE%"', 'cd /d D:\\Users\\111\\Project & rd /s /q .']) assert.ok(check(command, 'cmd'), command);
  assert.equal(check('Remove-Item -LiteralPath .\\build -Recurse'), null);
  assert.equal(check('rd /s /q build', 'cmd'), null);
});

test('Windows SSH routes native paths, binds permissions and leaves tool schemas fixed', async () => {
  const workspace = sshWorkspace('windows-host', '/C:/Users/111/Project'), requests = [];
  const setup = routedTools({ async request(action, payload) {
    requests.push({ action, payload });
    if (action === 'authorize') return { platform: 'windows', home: '/C:/Users/111', root: workspace,
      path: payload.path.startsWith('ssh:') ? payload.path : sshWorkspace('windows-host', payload.path), inside: true };
    return { terminalSessionId: 'windows-owned', state: 'completed', exitCode: 0 };
  } }, { workspaceDir: workspace, taskRoots: [workspace] });
  const schemas = JSON.stringify(setup.registry.definitions());
  assert.equal(setup.registry.definitions().find(tool => tool.name === 'terminal_exec').inputSchema.properties.shell.default, undefined);
  const base = { command: 'echo test', cwd: 'C:\\Users\\111\\Project', yield_time_ms: 1 };
  assert.equal((await setup.execute('terminal_exec', base)).kind, 'returned');
  assert.equal(requests.at(-1).payload.input.shell, 'powershell');
  assert.equal((await setup.execute('terminal_exec', { ...base, shell: 'cmd' })).kind, 'returned');
  assert.equal(requests.at(-1).payload.input.shell, 'cmd');
  assert.equal(JSON.stringify(setup.registry.definitions()), schemas);
  assert.deepEqual(setup.permissions.at(-1).scope.roots, [workspace]);
  assert.equal(setup.permissions.at(-1).targets[0].value, workspace);
  const dispatched = () => requests.filter(item => item.action === 'execute').length;
  const before = dispatched();
  const blocked = await setup.execute('terminal_exec', { ...base, command: 'Remove-Item C:\\Users\\111 -Recurse' });
  assert.equal(blocked.error.code, 'protected_path_delete_denied');
  assert.notEqual((await setup.execute('terminal_exec', { ...base, shell: 'posix' })).kind, 'returned');
  assert.notEqual((await setup.execute('terminal_exec', { ...base, additional_permissions: { network: true } })).kind, 'returned');
  assert.equal(dispatched(), before, 'protected deletion, wrong shell and sandbox extensions never run');
});

test('SSH workspaces reject local and other-host overrides before permission or execution', async t => {
  const root = await storage(t), local = join(root, 'local.txt'); await writeFile(local, 'private');
  const calls = [], bridge = { async request(action, payload) {
    calls.push({ action, payload });
    if (action === 'authorize') return { path: payload.path, root: payload.uri, inside: true, home: '/home/user' };
    throw Error('SSH offline');
  } };
  const setup = routedTools(bridge, { workspaceDir: remote, taskRoots: [remote] });
  const other = sshWorkspace('another-connection', '/srv/project');
  for (const environment of ['local', other]) {
    for (const [name, input] of [
      ['read_file', {path:local}], ['edit_file', {path:local,old_text:'private',new_text:'changed'}],
      ['terminal_exec', {command:'echo blocked',cwd:root,yield_time_ms:1}], ['terminal_list', {}],
    ]) assert.notEqual((await setup.execute(name, {...input,environment})).kind, 'returned');
  }
  assert.equal(calls.length, 0); assert.equal(setup.permissions.length, 0);
  assert.equal(await readFile(local, 'utf8'), 'private');
  const offline = await setup.execute('terminal_exec', {command:'pwd',cwd:'.',yield_time_ms:1});
  assert.match(JSON.stringify(offline), /SSH offline/);
  const fromLocal = routedTools(bridge, {workspaceDir:root});
  const before = calls.length;
  assert.notEqual((await fromLocal.execute('terminal_exec', {command:'pwd',environment:other})).kind,'returned');
  assert.equal(calls.length,before,'local workspace cannot select a remote host through arguments');
  for (const invalid of [false, '', 'remote', 'ssh://user@host/path']) {
    assert.notEqual((await fromLocal.execute('read_file', {path:local,environment:invalid})).kind,'returned');
  }
});

test('same-host SSH subdirectories do not expand the selected project permission root', async () => {
  const calls = [], bridge = { async request(action,payload) {
    calls.push({action,payload});
    if(action==='authorize')return {path:payload.path,root:payload.uri,inside:false,home:'/home/user'};
    return {state:'completed',exitCode:0};
  } };
  const setup=routedTools(bridge,{workspaceDir:remote}), outside=sshWorkspace('test-connection','/outside');
  assert.equal((await setup.execute('terminal_exec',{command:'pwd',cwd:'.',environment:outside,yield_time_ms:1})).kind,'returned');
  assert.equal(calls[0].payload.uri,remote);
  assert.equal(parseSshWorkspace(calls[0].payload.path).path,'/outside');
  assert.deepEqual(setup.permissions[0].scope.roots,[remote]);
});

test('terminal handles and lists are restricted to the selected host and owner', async t => {
  const root=await storage(t), calls=[], other=sshWorkspace('other-host','/work');
  const bridge={async request(action,payload){
    calls.push({action,payload});
    if(action==='terminals')return {sessions:payload.owner==='chat'?[
      {terminalSessionId:'current',uri:remote,state:'running'},
      {terminalSessionId:'other',uri:other,state:'running'},
    ]:[]};
    assert.equal(payload.uri,remote);
    return {terminalSessionId:payload.input.sessionId,state:'running',stdout:'remote output'};
  }};
  const local=routedTools(bridge,{workspaceDir:root});
  assert.deepEqual((await local.execute('terminal_list',{})).result.sessions,[]);
  assert.notEqual((await local.execute('terminal_poll',{session_id:'current',yield_time_ms:1})).kind,'returned');
  assert.equal(calls.length,0,'local mode never queries remote handles');
  const setup=routedTools(bridge,{workspaceDir:remote});
  assert.equal((await setup.execute('terminal_poll',{session_id:'current',yield_time_ms:1})).kind,'returned');
  const before=calls.filter(c=>c.action==='execute').length;
  for(const name of ['terminal_poll','terminal_write','terminal_stop']) {
    assert.notEqual((await setup.execute(name,{session_id:'other',chars:'x',yield_time_ms:1})).kind,'returned');
    assert.notEqual((await setup.execute(name,{session_id:'current',chars:'x',yield_time_ms:1},'other-session')).kind,'returned');
  }
  assert.equal(calls.filter(c=>c.action==='execute').length,before);
  assert.deepEqual((await setup.execute('terminal_list',{})).result.sessions.map(s=>s.terminalSessionId),['current']);
});

test('local to SSH to local changes actual provider schemas, blocks stale tools and suppresses local plugins', async t => {
  const root=await storage(t), work=join(root,'work'); await mkdir(work);
  const seen=[], remoteCalls=[]; let pluginLoads=0, sshRounds=0;
  const host=new InMemoryRuntimeHost({dataRoot:join(root,'data'),
    loadPluginExtensions:async()=>{pluginLoads++;return {hooks:[],agents:[],commands:[],skills:[]};},
    remoteWorkspace:{async request(action,payload){remoteCalls.push({action,payload});
      if(action==='directory')return {uri:payload.uri};
      if(payload.name==='workspace_busy')return {running:false};
      throw Error('Unexpected remote execution');
    }},provider:{async *stream(request){
      seen.push(structuredClone(request));
      const base={protocol:'bush.model_event.v1',requestId:request.requestId,createdAt:new Date().toISOString()};
      if(request.turnId==='ssh'&&sshRounds++===0){
        // An old conversation/tool snapshot must not authorize a local write.
        yield {...base,sequence:0,kind:'tool_call_delta',index:0,toolCallId:'stale-local-write',nameDelta:'write_file',
          argumentsDelta:JSON.stringify({path:join(work,'blocked.txt'),content:'must not exist',environment:'local'})};
        yield {...base,sequence:1,kind:'response_completed',finishReason:'tool_calls'};
      }else{
        yield {...base,sequence:0,kind:'text_delta',delta:'Done.'};
        yield {...base,sequence:1,kind:'response_completed',finishReason:'stop'};
      }
    }}});
  const command=(kind,payload)=>host.sendCommand({kind:'runtime.'+kind,payload});
  await command('create_session',{sessionId:'switching',workspace:{sourceDir:work,mode:'direct'}});
  const tools=await command('get_tool_catalog',{});
  const turn=turnId=>host.runSessionTurn({protocol:'bush.session_turn_request.v1',requestId:'r-'+turnId,
    sessionId:'switching',turnId,model:'fixture',tools,
    prefixMessages:[{role:'system',content:'Fixture system policy.'}],
    metadata:{workspaceDir:work,systemPolicy:{id:'fixture',version:'1'},mcpCatalogUpdates:'additions'},
    inputMessages:[{messageId:'u-'+turnId,message:{role:'user',content:'Continue.'}}]});
  const switchTo=async projectDir=>command('switch_workspace',{sessionId:'switching',
    expectedRevision:(await command('get_session',{sessionId:'switching'})).revision,projectDir,projectId:projectDir});
  await turn('local-before');
  const localNames=seen[0].tools.map(tool=>tool.name).sort();
  assert.ok(localNames.includes('read_file'));
  await switchTo(remote); const loadsBefore=pluginLoads;
  await turn('ssh');
  assert.equal(pluginLoads,loadsBefore,'SSH must not load or execute local plugin hooks/commands');
  const sshRequests=seen.filter(request=>request.turnId==='ssh');
  assert.equal(sshRequests.length,2);
  for(const request of sshRequests)assert.deepEqual(request.tools.map(tool=>tool.name).sort(),
    ['terminal_exec','terminal_list','terminal_poll','terminal_stop','terminal_write']);
  assert.match(JSON.stringify(sshRequests[1].messages),/tool_not_exposed/);
  await assert.rejects(readFile(join(work,'blocked.txt')), {code:'ENOENT'});
  assert.ok(!remoteCalls.some(call=>call.action==='execute'));
  await switchTo(work); await turn('local-after');
  assert.deepEqual(seen.at(-1).tools.map(tool=>tool.name).sort(),localNames);
  assert.ok(pluginLoads>loadsBefore,'local plugin behavior resumes after switching back');
});

test('direct model requests use the saved SSH binding and respect no-tool policies', async t=>{
  const root=await storage(t), seen=[];
  const host=new InMemoryRuntimeHost({dataRoot:root,
    remoteWorkspace:{async request(action,payload){assert.equal(action,'directory');return {uri:payload.uri};}},
    provider:{async *stream(request){seen.push(request);
      const base={protocol:'bush.model_event.v1',requestId:request.requestId,createdAt:new Date().toISOString()};
      yield {...base,sequence:0,kind:'text_delta',delta:'Done.'};
      yield {...base,sequence:1,kind:'response_completed',finishReason:'stop'};
    }}});
  await host.sendCommand({kind:'runtime.create_session',payload:{sessionId:'direct',workspace:{sourceDir:remote,mode:'direct'}}});
  const tools=await host.sendCommand({kind:'runtime.get_tool_catalog',payload:{}});
  for(const policy of ['normal','none']){
    const result=await host.runModelTurn({protocol:'bush.model_request.v1',requestId:policy,sessionId:'direct',turnId:policy,
      model:'fixture',tools,messages:[{role:'user',content:'Continue.'}],metadata:{workspaceDir:root,toolExecutionPolicy:policy}});
    assert.equal(result.payload.status,'completed');
    assert.equal(seen.at(-1).metadata.workspaceDir,remote);
    assert.deepEqual(seen.at(-1).tools.map(tool=>tool.name).sort(),policy==='none'?[]:
      ['terminal_exec','terminal_list','terminal_poll','terminal_stop','terminal_write']);
  }
});

test('human terminal controls cannot access handles on another selected host', async t=>{
  const root=await storage(t), calls=[], other=sshWorkspace('other','/work');
  const host=new InMemoryRuntimeHost({dataRoot:root,remoteWorkspace:{async request(action,payload){
    calls.push({action,payload});
    if(action==='directory')return {uri:payload.uri};
    if(action==='terminals')return {sessions:[{terminalSessionId:'current',uri:remote,state:'running'},
      {terminalSessionId:'other',uri:other,state:'running'}]};
    assert.equal(payload.uri,remote);return {state:'stopped'};
  }}});
  await host.sendCommand({kind:'runtime.create_session',payload:{sessionId:'controls',workspace:{sourceDir:remote,mode:'direct'}}});
  const control=(sessionId,terminalSessionId,action)=>host.sendCommand({kind:'runtime.terminal_control',payload:{sessionId,terminalSessionId,action}});
  assert.equal((await control('controls','current','status')).state,'running');
  for(const action of ['status','stop']){
    await assert.rejects(control('controls','other',action),{code:'terminal_session_not_found'});
    await assert.rejects(control('local','current',action),{code:'terminal_session_not_found'});
  }
  assert.ok(!calls.some(call=>call.action==='execute'));
  assert.equal((await control('controls','current','stop')).state,'stopped');
});
