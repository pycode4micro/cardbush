import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { AgentSharedConfiguration, packSharedConfiguration, sendSharedConfiguration, recoverSharedConfiguration } from '../dist-electron/agentSharedConfiguration.mjs';
import { ProductModelConfigStore } from '../packages/cardbush-product-host/dist/index.js';

const base = resolve('tmp/shared-configuration-tests');
const digest = data => createHash('sha256').update(data).digest('hex');
async function fixture(t) {
  await mkdir(base, {recursive:true}); const root=await mkdtemp(join(base,'test-'));
  t.after(async()=>{assert.ok(resolve(root).startsWith(base)); await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});});
  const local=join(root,'local'), remote=join(root,'remote'), bundled=join(root,'bundled');
  await Promise.all([mkdir(local,{recursive:true}),mkdir(remote,{recursive:true}),mkdir(bundled,{recursive:true})]);
  const roots=[{source:join(local,'plugins'),target:'plugins'},{source:join(local,'skills'),target:'skills'}];
  let active=false, fail=false, refreshes=0;
  const receiver=new AgentSharedConfiguration(remote,bundled,()=>{if(active)throw Error('running tasks');},async()=>{refreshes++;if(fail)throw Error('fixture-secret must not leak');return {applicationState:'applied'};});
  const payload={roots,models:{defaultModelId:'fixture',models:[{id:'fixture',provider:'openai',model:'fixture',apiKey:'fixture-secret'}]},
    apps:{serviceEnabled:true,plugins:[]},mcp:{servers:[]},subagents:{},instructions:'Shared rules.',network:{mode:'none',httpProxy:'',httpsProxy:'',noProxy:''},sandbox:{version:1,enabled:true}};
  return {root,local,remote,bundled,payload,receiver,pack:()=>packSharedConfiguration(payload,local),call:input=>receiver.call(input),get refreshes(){return refreshes;},set active(v){active=v;},set fail(v){fail=v;}};
}

test('syncs private model credentials, instructions, plugin files/config and skills; unchanged settings do no writes', async t=>{
  const f=await fixture(t);
  await mkdir(join(f.local,'plugins','fixture-plugin','.codex-plugin'),{recursive:true});
  await writeFile(join(f.local,'plugins','fixture-plugin','.codex-plugin','plugin.json'),JSON.stringify({name:'fixture-plugin',version:'1.0.0',description:'Shared fixture'}));
  await mkdir(join(f.local,'skills','fixture'),{recursive:true});
  await writeFile(join(f.local,'skills','fixture','SKILL.md'),'---\nname: fixture\ndescription: fixture\n---\nTest');
  f.payload.apps.plugins=[{id:'fixture-plugin',installed:true,enabled:true,config:{env:{TOKEN:'plugin-secret',DATA:join(f.local,'plugins','fixture-plugin','file.json')}}}];
  const archive=await f.pack();
  assert.deepEqual(archive,await f.pack(),'source archive is stable');
  const receipt=await sendSharedConfiguration(f.call,archive);
  assert.equal(receipt.digest,archive.digest);assert.doesNotMatch(JSON.stringify(receipt),/fixture-secret|plugin-secret/);
  const models=await new ProductModelConfigStore(join(f.remote,'config','models.json')).read();
  assert.equal(models.models[0].apiKey,'fixture-secret');
  assert.equal(await readFile(join(f.remote,'AGENTS.md'),'utf8'),'Shared rules.');
  assert.deepEqual(JSON.parse(await readFile(join(f.remote,'config','sandbox.json'),'utf8')),f.payload.sandbox);
  assert.deepEqual(JSON.parse(await readFile(join(f.remote,'config','network.json'),'utf8')),f.payload.network);
  assert.equal(await readFile(join(f.remote,'plugins','fixture-plugin','.codex-plugin','plugin.json'),'utf8'),await readFile(join(f.local,'plugins','fixture-plugin','.codex-plugin','plugin.json'),'utf8'));
  const apps=JSON.parse(await readFile(join(f.remote,'config','apps.json'),'utf8'));
  assert.equal(apps.plugins.find(p=>p.id==='fixture-plugin').config.env.DATA,join(f.remote,'plugins','fixture-plugin','file.json'));
  assert.equal(apps.plugins.find(p=>p.id==='fixture-plugin').config.env.TOKEN,'plugin-secret');
  assert.ok((await readFile(join(f.remote,'skills','fixture','SKILL.md'),'utf8')).includes('Test'));
  const before=f.refreshes;f.active=true;
  await sendSharedConfiguration(f.call,archive);assert.equal(f.refreshes,before,'identical config remains usable while another task runs');
});

test('changed settings wait for idle; failed activation rolls everything back without leaking secrets', async t=>{
  const f=await fixture(t);const initial=await f.pack();await sendSharedConfiguration(f.call,initial);
  const original=await readFile(join(f.remote,'config','models.json'),'utf8');
  f.payload.models.models[0].apiKey='changed-secret';f.payload.instructions='Changed';
  const changed=await f.pack();f.active=true;
  await assert.rejects(sendSharedConfiguration(f.call,changed),/running tasks/);
  assert.equal(await readFile(join(f.remote,'config','models.json'),'utf8'),original);
  f.active=false;f.fail=true;
  const revision=JSON.parse(await readFile(join(f.remote,'config','mcp-servers.json'),'utf8')).revision;
  await assert.rejects(sendSharedConfiguration(f.call,changed),error=>{assert.doesNotMatch(error.message,/fixture-secret|changed-secret/);return true;});
  assert.equal(await readFile(join(f.remote,'config','models.json'),'utf8'),original);
  assert.equal(await readFile(join(f.remote,'AGENTS.md'),'utf8'),'Shared rules.');
  assert.equal(await f.call({action:'status'}),null,'failed runtime restoration must retry rather than report a valid configuration');
  const rollbackRevision=JSON.parse(await readFile(join(f.remote,'config','mcp-servers.json'),'utf8')).revision;
  assert.ok(rollbackRevision>revision,'rollback must also advance the MCP revision');
  f.fail=false;await sendSharedConfiguration(f.call,changed);
  assert.equal(await readFile(join(f.remote,'AGENTS.md'),'utf8'),'Changed');
  assert.ok(JSON.parse(await readFile(join(f.remote,'config','mcp-servers.json'),'utf8')).revision>rollbackRevision);
});

test('rejects incomplete/corrupt archives, traversal and another desktop source', async t=>{
  const f=await fixture(t), archive=await f.pack();await sendSharedConfiguration(f.call,archive);
  await f.call({action:'begin',digest:archive.digest,size:archive.data.length});
  await assert.rejects(f.call({action:'apply',digest:archive.digest}),/incomplete|corrupt/);
  for(const change of [p=>p.files.push({path:'plugins/../../outside',data:'eA==',mode:0o600}),p=>{p.sourceId=randomUUID();}]){
    const payload=JSON.parse(gunzipSync(archive.data).toString());change(payload);const data=gzipSync(JSON.stringify(payload));
    await assert.rejects(sendSharedConfiguration(f.call,{data,digest:digest(data)}));
  }
  assert.equal((await f.call({action:'status'})).digest,archive.digest);
  assert.equal((await readdir(f.root)).includes('outside'),false);
});

test('recovers interrupted replacement before runtime startup and preserves original files', async t=>{
  const f=await fixture(t);await sendSharedConfiguration(f.call,await f.pack());
  const id=randomUUID(), directory=join(f.remote,'shared-configuration','backups',id,'config');await mkdir(directory,{recursive:true});
  const original=await readFile(join(f.remote,'config','models.json'));
  await writeFile(join(directory,'models.json'),original);await writeFile(join(f.remote,'config','models.json'),'bad replacement');
  await writeFile(join(f.remote,'shared-configuration','transaction.json'),JSON.stringify({id,entries:[{path:'config/models.json',existed:true}]}));
  await recoverSharedConfiguration(f.remote);
  assert.deepEqual(await readFile(join(f.remote,'config','models.json')),original);
});

// Exercise the authenticated HTTP path used by the desktop, including credential redaction.
test('desktop connection synchronizes before cloud model/catalog reads and refuses unsupported services', async t=>{
  const { AgentService }=await import('../dist-electron/agentService.mjs');
  const { serveAgentHttp }=await import('../dist-electron/agentServer.mjs');
  const { AgentConnectionManager }=await import('../dist-electron/agentConnections.mjs');
  const f=await fixture(t);
  const service=await AgentService.open({dataRoot:f.remote,bundledRoot:f.bundled});
  let server, manager;
  try {
    server=await serveAgentHttp(service,{token:'x'.repeat(48)});
    manager=new AgentConnectionManager(join(f.local,'connections.json'),{encrypt:v=>v,decrypt:v=>v},{sharedConfiguration:f.pack});
    const [connection]=await manager.save({name:'Cloud fixture',transport:'http',url:'http://127.0.0.1:'+server.port,token:'x'.repeat(48)});
    const models=await manager.call(connection.id,'product.command',{kind:'models.get'});
    assert.equal(models.defaultModelId,'fixture');assert.equal(models.models[0].hasApiKey,true);
    assert.doesNotMatch(JSON.stringify(models),/fixture-secret/);
    assert.equal((await service.instructions.read()).content,'Shared rules.');
    assert.equal((await manager.list())[0].configurationError,undefined);
    f.payload.models.models[0].model='updated-fixture';f.payload.instructions='Updated shared rules.';
    await manager.call(connection.id,'conversation.catalog');
    assert.equal((await service.instructions.read()).content,'Updated shared rules.');
    assert.equal((await service.call('product.command',{kind:'models.get'})).models[0].modelName,'updated-fixture');
    // Remote drift is repaired even though the desktop source did not change.
    const prior=await service.instructions.read();await service.instructions.save('remote drift',prior.revision);
    await manager.call(connection.id,'product.command',{kind:'models.get'});
    assert.equal((await service.instructions.read()).content,'Updated shared rules.');
    await manager.disconnect(connection.id);
    const info=service.info.bind(service);service.info=()=>{const value=info();return {...value,capabilities:{...value.capabilities,sharedConfiguration:false}};};
    await assert.rejects(manager.call(connection.id,'product.command',{kind:'models.get'}),/Update the Agent service/);
    assert.ok((await manager.list())[0].configurationError.includes('Update the Agent service'));
  } finally { await manager?.close();await server?.close();await service.close(); }
});

test('transfers multi-chunk archives and disables incompatible executable MCP declarations', async t=>{
  const f=await fixture(t);
  await mkdir(join(f.local,'skills','large'),{recursive:true});
  const {randomBytes}=await import('node:crypto');
  await writeFile(join(f.local,'skills','large','blob.bin'),randomBytes(900000));
  let archive=await f.pack();assert.ok(archive.data.length>512*1024);
  const payload=JSON.parse(gunzipSync(archive.data).toString());payload.sourcePlatform=process.platform==='win32'?'linux':'win32';
  payload.mcp.servers=[{id:'local-command',enabled:true,transport:'stdio',command:'C:\\local\\app.exe',args:[]}];
  const data=gzipSync(JSON.stringify(payload));archive={data,digest:digest(data)};
  const receipt=await sendSharedConfiguration(f.call,archive);
  assert.ok(receipt.warnings.length);assert.equal(JSON.parse(await readFile(join(f.remote,'config','mcp-servers.json'),'utf8')).servers[0].enabled,false);
});
