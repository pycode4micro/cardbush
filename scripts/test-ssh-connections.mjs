import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, posix } from 'node:path';
import { once } from 'node:events';
import ssh2 from 'ssh2';
import { SshConnectionManager } from '../dist-electron/sshConnections.mjs';
import { sshWorkspace } from '@cardbush/bush-protocol';
import { ToolExecutionCoordinator, ToolRegistry, registerWorkspaceTools } from '@cardbush/bush-runtime';

// A real loopback SSH transport, with deterministic remote SFTP/process fixtures.
// This runs on Windows without requiring a Linux host or touching user SSH settings.
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'cardbush-ssh-test-'));
  const key = generateKeyPairSync('rsa', { modulusLength:2048 }).privateKey.export({format:'pem',type:'pkcs1'});
  const files = new Map([['/work/file.txt',Buffer.from('first\n中文\nlast')],['/home/test/outside.txt',Buffer.from('outside')]]);
  const directories = new Set(['/','/work','/work/child','/home','/home/test']);
  const clients=new Set(), jobs=new Map(), commands=[]; let authCount=0, pid=700;
  const canonical = path => path === '.' ? '/home/test' : path.replace('/work/link','/home/test');
  const server = new ssh2.Server({hostKeys:[key]},client => {
    clients.add(client);client.on('error',()=>{});client.on('close',()=>clients.delete(client));
    client.on('authentication',ctx=>{authCount++; if(ctx.method==='password'&&ctx.username==='test'&&ctx.password==='secret-test-password')ctx.accept();else ctx.reject();});
    client.on('ready',()=>client.on('session',accept=>{
      const session=accept();
      session.on('exec',(accept,_reject,info)=>{
        commands.push(info.command);const stream=accept();stream.on('error',()=>{});stream.resume();
        const kill=/^kill -(TERM|KILL) -(\d+)$/.exec(info.command);
        if(kill){const target=jobs.get(Number(kill[2]));if(target){target.exit(143);target.end();jobs.delete(Number(kill[2]));}stream.exit(0);stream.end();return;}
        const current=++pid;jobs.set(current,stream);stream.on('close',()=>jobs.delete(current));
        const marker=/CARDBUSH_PID_[a-z0-9]+:/.exec(info.command)?.[0];assert.ok(marker);
        if(info.command.includes('fixture-stream')) {
          let pending='';
          stream.on('data',chunk=>{
            pending+=chunk.toString();
            while(pending.includes('\n')) {
              const end=pending.indexOf('\n'),input=pending.slice(0,end);pending=pending.slice(end+1);
              if(input==='start') { stream.stderr.write(marker+current+'\n');stream.write('first 中文\n');stream.stderr.write('first warning\n'); }
              if(input==='finish') { stream.write('last chunk\n');stream.stderr.write('last warning\n');stream.exit(7);stream.end(); }
            }
          });
          return;
        }
        stream.stderr.write(marker+current+'\n');
        if(info.command.includes('fixture-sleep'))return;
        // Delayed multiple writes catch implementations that confuse first output with completion.
        if(info.command.includes("'rg'")){stream.write('file.txt:1:1:first\n');setTimeout(()=>{stream.write('file.txt:3:1:last\n');stream.exit(0);stream.end();},60);}
        else if(info.command.includes('branch')&&info.command.includes('--show-current')){stream.write('main\n');stream.exit(0);stream.end();}
        else if(info.command.includes('--porcelain=v1')){stream.write(' M spaced file.txt\0R  new.txt\0old.txt\0');stream.exit(0);stream.end();}
        else {stream.write('remote only\n');stream.exit(0);stream.end();}
      });
      session.on('sftp',accept=>{
        const sftp=accept(), handles=new Map();let index=0;
        // ssh2's test server has no public extension-advertisement API. Advertise
        // the OpenSSH rename extension on the wire that this fixture implements.
        const send=sftp._protocol.channelData.bind(sftp._protocol);
        sftp._protocol.channelData=(id,packet)=>{if(id===sftp.outgoing.id&&packet.length===9&&packet[4]===2){
          const name=Buffer.from('posix-rename@openssh.com'),extra=Buffer.alloc(4+name.length+5);extra.writeUInt32BE(name.length);name.copy(extra,4);extra.writeUInt32BE(1,4+name.length);extra[extra.length-1]=49;packet=Buffer.concat([packet,extra]);packet.writeUInt32BE(packet.length-4);
        }return send(id,packet);};
        const status=(id,code=0)=>sftp.status(id,code);
        const attrs=path=>({mode:directories.has(path)?0o40755:0o100644,size:files.get(path)?.length??0,uid:1,gid:1,atime:1,mtime:1});
        const handle=(id,entry)=>{const buffer=Buffer.alloc(4);buffer.writeUInt32BE(++index);handles.set(index,entry);sftp.handle(id,buffer);};
        const stat=(id,path)=>{path=canonical(path);files.has(path)||directories.has(path)?sftp.attrs(id,attrs(path)):status(id,2);};
        sftp.on('REALPATH',(id,path)=>{path=canonical(path);files.has(path)||directories.has(path)?sftp.name(id,[{filename:path,longname:path,attrs:attrs(path)}]):status(id,2);});
        sftp.on('STAT',stat).on('LSTAT',stat);
        sftp.on('OPENDIR',(id,path)=>directories.has(path)?handle(id,{path,read:false}):status(id,2));
        sftp.on('READDIR',(id,h)=>{const entry=handles.get(h.readUInt32BE());if(entry.read)return status(id,1);entry.read=true;const names=[...directories,...files.keys()].filter(path=>path!==entry.path&&posix.dirname(path)===entry.path).map(path=>({filename:posix.basename(path),longname:posix.basename(path),attrs:attrs(path)}));sftp.name(id,names);});
        sftp.on('OPEN',(id,path,flags)=>{path=canonical(path);if((flags&32)&&files.has(path))return status(id,4);if(!files.has(path)){if(!(flags&8))return status(id,2);files.set(path,Buffer.alloc(0));}handle(id,{path});});
        sftp.on('READ',(id,h,offset,length)=>{const bytes=files.get(handles.get(h.readUInt32BE()).path);offset>=bytes.length?status(id,1):sftp.data(id,bytes.subarray(offset,offset+length));});
        sftp.on('WRITE',(id,h,offset,data)=>{const path=handles.get(h.readUInt32BE()).path,old=files.get(path),bytes=Buffer.alloc(Math.max(old.length,offset+data.length));old.copy(bytes);data.copy(bytes,offset);files.set(path,bytes);status(id);});
        sftp.on('FSTAT',(id,h)=>sftp.attrs(id,attrs(handles.get(h.readUInt32BE()).path)));
        sftp.on('CLOSE',(id,h)=>{handles.delete(h.readUInt32BE());status(id);});
        sftp.on('MKDIR',(id,path)=>{directories.add(path);status(id);});
        sftp.on('REMOVE',(id,path)=>{files.delete(path);status(id);});
        const rename=(id,from,to,overwrite)=>{if(!files.has(from)||(!overwrite&&files.has(to)))return status(id,4);files.set(to,files.get(from));files.delete(from);status(id);};
        sftp.on('RENAME',(id,from,to)=>rename(id,from,to,false));
        sftp.on('EXTENDED',(id,name,data)=>{if(name!=='posix-rename@openssh.com')return status(id,8);const length=data.readUInt32BE(0),from=data.subarray(4,4+length).toString(),end=4+length;rename(id,from,data.subarray(end+4,end+4+data.readUInt32BE(end)).toString(),true);});
      });
    }));
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const manager=new SshConnectionManager(join(directory,'connections.json'),{encrypt:value=>Buffer.from(value).toString('base64'),decrypt:value=>Buffer.from(value,'base64').toString()});
  const input={name:'Test server',host:'127.0.0.1',port:server.address().port,username:'test',authentication:'password',password:'secret-test-password',defaultDirectory:'/work'};
  const [connection]=await manager.save(input);
  t.after(async()=>{await manager.close();for(const client of clients)client.end();await new Promise(resolve=>server.close(resolve));assert.equal(dirname(resolve(directory)),resolve(tmpdir()));await rm(directory,{recursive:true,force:true,maxRetries:5});});
  async function trust(){const response=await manager.test(connection.id);assert.equal(response.needsTrust,true);assert.match(response.fingerprint,/^SHA256:/);await manager.save({...connection,fingerprint:response.fingerprint});assert.equal((await manager.test(connection.id)).ok,true);}
  return {manager,connection,input,trust,files,commands,clients,jobs,directory,uri:sshWorkspace(connection.id,'/work'),authCount:()=>authCount};
}

// Exercise the actual workspace-tool decoding, SSH bridge and result validator.
// JSON.stringify alone would silently drop undefined fields and hide this bug.
function runtimeTools(f) {
  const registry=new ToolRegistry();
  registerWorkspaceTools(registry,undefined,{remote:{request(action,payload,signal) {
    if(action==='terminals')return Promise.resolve(f.manager.listTerminals(payload.owner));
    if(action==='authorize')return f.manager.authorize(payload.uri,payload.path,payload.write);
    if(action==='execute')return f.manager.execute(payload.uri,payload.owner,payload.name,payload.input,signal);
    throw Error('Unexpected bridge action: '+action);
  }}});
  const coordinator=new ToolExecutionCoordinator({registry,permissions:{async request(input) {
    return {protocol:'bush.runtime_permission_answer.v1',permissionId:'permission',answerId:'answer',decision:'allow_once',grantedCapabilityIds:input.capabilityIds};
  }}});
  let ordinal=0;
  return async(name,input,workspace=f.uri)=>{
    const identity={requestId:'request',sessionId:'runtime-test',turnId:'turn',round:1,ordinal:ordinal++};
    const outcome=await coordinator.execute({protocol:'bush.tool_call.v1',id:'call-'+identity.ordinal,name,argumentsText:JSON.stringify(input)},identity,undefined,
      {request:{protocol:'bush.model_request.v1',requestId:identity.requestId,sessionId:identity.sessionId,turnId:identity.turnId,model:'fixture',messages:[],tools:registry.definitions(),metadata:{workspaceDir:workspace}},contextMessages:[]});
    assert.equal(outcome.kind,'returned',name+': '+JSON.stringify(outcome.error));
    return outcome.result;
  };
}

test('one SSH conversation reads local source, uploads it, and routes both terminal hosts by handle', { timeout: 20_000 }, async t => {
  const f = await fixture(t); await f.trust(); const execute = runtimeTools(f);
  const source = join(f.directory, 'local-source.txt'); await writeFile(source, '本机源码');
  const read = await execute('read_file', { path: source, environment: 'local' });
  assert.equal(read.executionEnvironment.kind, 'local');
  const uploaded = await execute('write_file', { path: 'uploaded.txt', content: read.content });
  assert.equal(uploaded.executionEnvironment.connectionId, f.connection.id);
  assert.equal(f.files.get('/work/uploaded.txt').toString(), '本机源码');
  assert.equal((await execute('read_file', { path: 'uploaded.txt', environment: f.uri }, f.directory)).content, '本机源码');

  const command = process.platform === 'win32'
    ? "[Console]::WriteLine('LOCAL-READY'); [Console]::Out.Flush(); [Console]::ReadLine() | Out-Null"
    : "printf 'LOCAL-READY\\n'; read answer";
  let local = await execute('terminal_exec', { environment: 'local', cwd: f.directory, command, shell: process.platform === 'win32' ? 'powershell' : 'posix', yield_time_ms: 100 });
  t.after(async () => { if (local.state === 'running') await execute('terminal_stop', { session_id: local.terminalSessionId }).catch(() => {}); });
  const remote = await execute('terminal_exec', { cwd: '.', command: 'fixture-sleep', shell: 'posix', yield_time_ms: 100 });
  const listed = await execute('terminal_list', {});
  assert.ok(listed.sessions.some(item => item.terminalSessionId === local.terminalSessionId && item.executionEnvironment.kind === 'local'));
  assert.ok(listed.sessions.some(item => item.terminalSessionId === remote.terminalSessionId && item.executionEnvironment.connectionId === f.connection.id));
  assert.ok((await execute('terminal_list', { environment: 'local' })).sessions.every(item => item.executionEnvironment.kind === 'local'));
  assert.ok((await execute('terminal_list', { environment: f.uri })).sessions.every(item => item.executionEnvironment.kind === 'ssh'));
  local = await execute('terminal_write', { session_id: local.terminalSessionId, chars: 'finish\n', yield_time_ms: 100 });
  let output = local.stdout;
  for (let tries = 0; local.state === 'running' && tries < 30; tries++) {
    local = await execute('terminal_poll', { session_id: local.terminalSessionId, yield_time_ms: 100 }); output += local.stdout;
  }
  assert.notEqual(local.state, 'running'); assert.match(output, /LOCAL-READY/);
  const stopped = await execute('terminal_stop', { session_id: remote.terminalSessionId }, f.directory);
  assert.equal(stopped.state, 'stopped'); assert.equal(stopped.executionEnvironment.connectionId, f.connection.id);
  assert.ok(!f.commands.some(command => command.includes('LOCAL-READY')), 'local code must never reach SSH');
});

test('SSH terminal results pass runtime validation before PID, while streaming and after nonzero exit',async t=>{
  const f=await fixture(t);await f.trust();const execute=runtimeTools(f);
  let terminal=await execute('terminal_exec',{cwd:'.',command:'fixture-stream',shell:'posix',yield_time_ms:1});
  const sessionId=terminal.terminalSessionId;
  assert.equal(terminal.state,'running');assert.equal(terminal.pid,null);assert.equal(terminal.exitCode,null);
  const outputs=[terminal];
  const collect=result=>{assert.equal(result.terminalSessionId,sessionId);outputs.push(result);terminal=result;};
  const stdout=()=>outputs.map(item=>item.stdout).join('');
  const stderr=()=>outputs.map(item=>item.stderr).join('');
  async function pollUntil(predicate) {
    const deadline=Date.now()+5000;
    while(!predicate()) {
      assert.ok(Date.now()<deadline,'SSH fixture did not reach the expected state');
      collect(await execute('terminal_poll',{session_id:sessionId,yield_time_ms:100}));
    }
  }
  collect(await execute('terminal_write',{session_id:sessionId,chars:'start\n',yield_time_ms:100}));
  await pollUntil(()=>terminal.pid!==null&&stdout().includes('first 中文\n')&&stderr().includes('first warning\n'));
  assert.equal(terminal.state,'running');assert.equal(terminal.exitCode,null);
  collect(await execute('terminal_poll',{session_id:sessionId,yield_time_ms:1}));
  assert.equal(terminal.stdout,'');assert.equal(terminal.stderr,'');
  collect(await execute('terminal_write',{session_id:sessionId,chars:'finish\n',yield_time_ms:100}));
  await pollUntil(()=>terminal.state!=='running');
  assert.equal(terminal.state,'completed');assert.equal(terminal.exitCode,7);
  assert.equal(stdout(),'first 中文\nlast chunk\n');assert.equal(stderr(),'first warning\nlast warning\n');
  collect(await execute('terminal_poll',{session_id:sessionId,yield_time_ms:1}));
  assert.equal(terminal.stdout,'');assert.equal(terminal.stderr,'');assert.equal(terminal.exitCode,7);
  assert.equal(f.commands.filter(command=>command.includes('fixture-stream')).length,1);
});

test('SSH running and stopped terminal results pass runtime validation',async t=>{
  const f=await fixture(t);await f.trust();const execute=runtimeTools(f);
  const terminal=await execute('terminal_exec',{cwd:'.',command:'fixture-sleep',shell:'posix',yield_time_ms:100});
  assert.equal(terminal.state,'running');assert.equal(terminal.exitCode,null);
  const stopped=await execute('terminal_stop',{session_id:terminal.terminalSessionId});
  assert.equal(stopped.state,'stopped');assert.equal(stopped.exitCode,143);
  assert.equal((await f.manager.execute(f.uri,'runtime-test','workspace_busy',{})).running,false);
});

test('host trust gates authentication; credentials stay private; pinned-key mismatch is rejected',async t=>{
  const f=await fixture(t);assert.equal((await f.manager.test(f.connection.id)).needsTrust,true);assert.equal(f.authCount(),0);
  assert.ok(!(await readFile(join(f.directory,'connections.json'),'utf8')).includes(f.input.password));
  assert.ok(!JSON.stringify(await f.manager.list()).includes(f.input.password));await f.trust();
  await assert.rejects(f.manager.save({...f.connection,host:'another-host'}),/新增连接/);
  await f.manager.save({...f.connection,fingerprint:'SHA256:'+'A'.repeat(43)});
  const result=await f.manager.test(f.connection.id);assert.equal(result.ok,false);assert.equal(result.needsTrust,false);assert.match(result.error,/指纹已变化/);
});

test('remote paths, observed writes, stale revisions, cross-connection rejection and Unicode',async t=>{
  const f=await fixture(t);await f.trust();const exec=(name,input,owner='one')=>f.manager.execute(f.uri,owner,name,input);
  assert.equal((await f.manager.directory(f.uri)).entries[0].name,'child');
  assert.equal((await f.manager.authorize(f.uri,'link/outside.txt')).inside,false);
  await assert.rejects(exec('write_file',{path:'file.txt',content:'oops'}),/尚未读取/);
  const read=await exec('read_file',{path:'file.txt',range:{startLine:2,lineCount:1}});assert.equal(read.content,'中文\n');
  await exec('edit_file',{path:'file.txt',oldText:'中文',newText:'更新'});assert.match(f.files.get('/work/file.txt').toString(),/更新/);
  const current = await exec('read_file', { path: 'file.txt' });
  await exec('edit_file', { path: 'file.txt', range: { start: 2, end: 2, sha256: current.sha256 }, newText: '按行更新\n' });
  assert.equal(f.files.get('/work/file.txt').toString(), 'first\n按行更新\nlast');
  await assert.rejects(exec('edit_file', { path: 'file.txt', range: { start: 2, end: 2, sha256: current.sha256 }, newText: '' }), /版本/);
  await assert.rejects(exec('write_file',{path:'file.txt',content:'oops'},'two'),/尚未读取/);
  f.files.set('/work/file.txt',Buffer.from('external'));await assert.rejects(exec('write_file',{path:'file.txt',content:'oops'}),/变化/);
  await exec('write_file',{path:'nested/new.txt',content:'新文件'});assert.equal(f.files.get('/work/nested/new.txt').toString(),'新文件');
  await assert.rejects(exec('read_file',{path:'ssh://other/work/file.txt'}),/另一条/);
  await assert.rejects(exec('read_file',{path:'C:\\local.txt'}),/POSIX/);
  await f.manager.remove(f.connection.id);assert.equal(f.files.get('/work/nested/new.txt').toString(),'新文件');
});

test('search drains all chunks; Git status retains spaces and renamed paths; terminal ownership and stop',async t=>{
  const f=await fixture(t);await f.trust();
  const result=await f.manager.execute(f.uri,'one','search_file_content',{path:'.',query:'needle',contextBefore:2,contextAfter:3});assert.match(result.output,/first/);assert.match(result.output,/last/);
  assert.ok(f.commands.some(command => /--before-context.+2.+--after-context.+3/.test(command)), 'both context limits reach the SSH command');
  const info=await f.manager.git(f.uri,'info');assert.equal(info.branch,'main');assert.deepEqual(info.changedFiles,[{status:'M',path:'spaced file.txt'},{status:'R',path:'new.txt'}]);
  let terminal=await f.manager.execute(f.uri,'one','terminal_exec',{cwd:'/work',command:'fixture-sleep',shell:'posix',yieldTimeMs:30});
  assert.equal(terminal.state,'running');assert.ok(terminal.pid);assert.equal((await f.manager.execute(f.uri,'one','workspace_busy',{})).running,true);
  await assert.rejects(f.manager.execute(f.uri,'two','terminal_poll',{sessionId:terminal.terminalSessionId,yieldTimeMs:1}),/不属于/);
  await assert.rejects(f.manager.remove(f.connection.id),/运行任务/);
  terminal=await f.manager.execute(f.uri,'one','terminal_stop',{sessionId:terminal.terminalSessionId});assert.equal(terminal.state,'stopped');
  assert.equal((await f.manager.execute(f.uri,'one','workspace_busy',{})).running,false);
  assert.ok(f.commands.some(command=>command.startsWith('kill -TERM -')));
});

test('SSH completion observer waits for exit, preserves readable logs and cancels without stopping the process', async t => {
  const f = await fixture(t); await f.trust();
  const started = await f.manager.execute(f.uri, 'one', 'terminal_exec', { cwd: '/work', command: 'fixture-sleep', shell: 'posix', yieldTimeMs: 1 });
  const input = { sessionId: started.terminalSessionId, yieldTimeMs: 1000 };
  await assert.rejects(f.manager.execute(f.uri, 'other', 'terminal_observe', input), /不属于/);
  const controller = new AbortController();
  const cancelled = f.manager.execute(f.uri, 'one', 'terminal_observe', input, controller.signal);
  controller.abort(new Error('cancel observer'));
  await assert.rejects(cancelled, /cancel observer/);
  assert.equal(f.manager.listTerminals('one').sessions[0].state, 'running');
  let settled = false;
  const completion = f.manager.execute(f.uri, 'one', 'terminal_observe', input).then(result => { settled = true; return result; });
  const stream = [...f.jobs.values()][0];
  stream.write('progress line\n');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(settled, false, 'output events must not be mistaken for exit');
  stream.write('last line\n'); stream.exit(7); stream.end();
  const finished = await completion;
  assert.equal(finished.state, 'completed'); assert.equal(finished.exitCode, 7); assert.match(finished.stdout, /last line/);
  const manual = await f.manager.execute(f.uri, 'one', 'terminal_poll', { ...input, yieldTimeMs: 1 });
  assert.equal(manual.stdout, finished.stdout, 'observer does not drain output');
});

test('disconnect marks running command uncertain without replaying it',async t=>{
  const f=await fixture(t);await f.trust();const execute=runtimeTools(f);
  const task=await execute('terminal_exec',{cwd:'/work',command:'fixture-sleep',shell:'posix',yield_time_ms:1});
  for(const client of f.clients)client.end();await new Promise(resolve=>setTimeout(resolve,60));
  const result=await execute('terminal_poll',{session_id:task.terminalSessionId,yield_time_ms:1});assert.equal(result.state,'disconnected');
  assert.equal(result.exitCode,null);
  assert.equal(f.commands.filter(command=>command.includes('fixture-sleep')).length,1);
});
