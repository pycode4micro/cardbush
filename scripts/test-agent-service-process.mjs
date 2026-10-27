import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile,spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,mkdtemp,readFile,writeFile,rm,realpath,access} from 'node:fs/promises';
import {join,resolve,relative,sep} from 'node:path';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {inspectServiceProcess,processExists,serviceUrl} from '../dist-electron/agentServiceProcess.mjs';

const exec=promisify(execFile),base=resolve('tmp/agent-service-process-tests'),bin=resolve('bin/cardbush.mjs');
const cli=(args,options={})=>exec(process.execPath,[bin,...args],{cwd:process.cwd(),windowsHide:true,timeout:80000,maxBuffer:128*1024,...options});
const record=root=>readFile(join(root,'service-process.json'),'utf8').then(JSON.parse);
async function fixture(t){
  await mkdir(base,{recursive:true});const root=await mkdtemp(join(base,"服务 O'Brien "));
  t.after(async()=>{
    const current=await record(root).catch(()=>undefined);
    if(current?.pid&&current.pid!==process.pid&&processExists(current.pid)){
      await cli(['serve','--stop','--data-dir',root]);assert.equal(processExists(current.pid),false);
    }
    assert.ok((await realpath(root)).startsWith(await realpath(base)+sep));await rm(root,{recursive:true,force:true,maxRetries:3});
  });return root;
}
const start=root=>['serve','--background','--data-dir',relative(process.cwd(),root),'--port','0','--disable-tools'];

test('npm command entry points retain version and foreground service help',async()=>{
  const info=await cli(['serve','--help']);assert.match(info.stdout,/--background/);assert.match(info.stdout,/--stop/);assert.match(info.stdout,/PowerShell 7/);
  assert.match((await cli(['--version'])).stdout,/CardBush \d/);
  const alias=await exec(process.execPath,['bin/cardbush-agent.mjs','--help'],{windowsHide:true});assert.equal(alias.stdout,info.stdout);
});

test('status of an unstarted instance does not create data or a Runtime',async t=>{
  const root=join(await fixture(t),'not-created');assert.match((await cli(['serve','--status','--data-dir',root])).stdout,/Stopped/);
  await assert.rejects(access(root),{code:'ENOENT'});
});

test('background launch detaches, authenticates, survives the CLI, and stops without orphaning its owner',async t=>{
  const root=await fixture(t),output=await cli(start(root)),first=await record(root);
  assert.match(output.stdout,/Started:/);assert.equal(first.pid>0,true);assert.notEqual(first.pid,process.pid);
  const token=(await readFile(join(root,'access-token'),'utf8')).trim();assert.equal(output.stdout.includes(token),false);
  assert.equal((await inspectServiceProcess(root)).pid,first.pid);
  for(const headers of [{},{authorization:'Bearer incorrect'},{authorization:'Bearer '+token,origin:'null'}]){
    const response=await fetch(serviceUrl(first)+'api/agent/v1/local/stop',{method:'POST',headers});assert.equal(response.status,401);
  }
  assert.equal((await inspectServiceProcess(root)).pid,first.pid);
  const again=await cli(start(root));assert.match(again.stdout,/Already running/);assert.equal((await record(root)).pid,first.pid);
  await cli(['--url',serviceUrl(first),'--token-file',join(root,'access-token'),'--sessions']);
  const stopped=await cli(['serve','--stop','--data-dir',root]);assert.match(stopped.stdout,/Stopped/);assert.equal(processExists(first.pid),false);
  await assert.rejects(access(join(root,'agent.lock')),{code:'ENOENT'});await assert.rejects(access(join(root,'service-process.json')),{code:'ENOENT'});
  await cli(start(root));const second=await record(root);assert.equal(second.agentId,first.agentId);assert.notEqual(second.pid,first.pid);
  assert.equal((await readFile(join(root,'access-token'),'utf8')).trim(),token);
});

test('concurrent starters recover a stale lock with one surviving Runtime',async t=>{
  const root=await fixture(t),dead=spawn(process.execPath,['-e','process.exit(0)'],{windowsHide:true,stdio:'ignore'});
  const deadPid=dead.pid;await once(dead,'exit');assert.equal(processExists(deadPid),false);
  await writeFile(join(root,'agent.lock'),String(deadPid));
  const results=await Promise.all([cli(start(root)),cli(start(root)),cli(start(root))]);
  const current=await record(root);
  for(const result of results)assert.match(result.stdout,new RegExp('PID: '+current.pid));
  assert.equal(Number(await readFile(join(root,'agent.lock'),'utf8')),current.pid);
});

test('a hostname listener publishes its actual address for status and stop',async t=>{
  const root=await fixture(t);
  await cli([...start(root),'--host','localhost']);
  const current=await record(root);
  assert.ok(['127.0.0.1','::1'].includes(current.host),current.host);
  assert.equal((await inspectServiceProcess(root)).pid,current.pid);
  assert.match((await cli(['serve','--status','--data-dir',root])).stdout,/Running:/);
  await cli(['serve','--stop','--data-dir',root]);assert.equal(processExists(current.pid),false);
});

test('a failed background worker retires its service instead of leaving an orphan',async t=>{
  const root=await fixture(t),trigger=join(root,'exit-worker');
  const preload=new URL('./helpers/local-runtime-fault.mjs',import.meta.url).href;
  await cli(start(root),{env:{...process.env,NODE_OPTIONS:`--import=${preload}`,CARDBUSH_TEST_WORKER_EXIT:trigger}});
  const current=await record(root);
  await writeFile(trigger,'stop this fixture worker');
  const deadline=Date.now()+20000;
  while(processExists(current.pid)&&Date.now()<deadline)await delay(50);
  assert.equal(processExists(current.pid),false);
  await assert.rejects(access(join(root,'agent.lock')),{code:'ENOENT'});
  await assert.rejects(access(join(root,'service-process.json')),{code:'ENOENT'});
  assert.match(await readFile(join(root,'logs','service.log'),'utf8'),/Runtime failed:/);
  await cli(start(root));assert.notEqual((await record(root)).pid,current.pid);
});

test('a busy HTTP port causes failed startup to release the data owner',async t=>{
  const root=await fixture(t),server=createServer((_req,res)=>res.end('fixture'));server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(()=>new Promise(done=>server.close(done)));
  await assert.rejects(cli(['serve','--background','--data-dir',root,'--port',String(server.address().port),'--disable-tools']),e=>{assert.match(e.stderr,/EADDRINUSE|address already in use/i);return true});
  await assert.rejects(access(join(root,'agent.lock')),{code:'ENOENT'});
  await assert.rejects(access(join(root,'service-process.json')),{code:'ENOENT'});
  await cli(start(root));assert.ok(await inspectServiceProcess(root));
});

test('stale PID records cannot stop an unrelated process or send credentials off-host',async t=>{
  const root=await fixture(t),token='offline-fixture-token-'.repeat(3);let calls=0;
  const server=createServer((_req,res)=>{calls++;res.writeHead(200,{'X-CardBush-Agent-ID':'unrelated'});res.end('{}')});
  server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>new Promise(done=>server.close(done)));
  const value={protocol:'cardbush.service-process.v1',instance:randomUUID(),pid:process.pid,agentId:'expected',host:'127.0.0.1',port:server.address().port,startedAt:new Date().toISOString()};
  await writeFile(join(root,'access-token'),token);await writeFile(join(root,'service-process.json'),JSON.stringify(value));
  await assert.rejects(cli(['serve','--stop','--data-dir',root]));assert.equal(calls,1);assert.equal(processExists(process.pid),true);
  value.host='203.0.113.1';await writeFile(join(root,'service-process.json'),JSON.stringify(value));
  await assert.rejects(cli(['serve','--stop','--data-dir',root]),e=>{assert.match(e.stderr,/local address/);return true});assert.equal(calls,1);
  await rm(join(root,'service-process.json'));
});
