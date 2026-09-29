import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir, stat, truncate } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { AgentSharedConfiguration, packSharedConfiguration, sendSharedConfiguration, recoverSharedConfiguration } from '../dist-electron/agentSharedConfiguration.mjs';
import { ProductModelConfigStore } from '../packages/cardbush-product-host/dist/index.js';
import { packSharedPackage, sharedPluginCompatibility } from '../dist-electron/agentSharedPackages.mjs';
import { resolvePluginManifest } from '../dist-electron/pluginManifest.js';

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
  f.payload.models.models[0].apiProtocol = 'anthropic_messages';
  f.payload.models.models[0].defaultHeaders = { 'x-session-id': '{{sessionId}}' };
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
  assert.equal(models.models[0].apiProtocol, 'anthropic_messages');
  assert.deepEqual(models.models[0].defaultHeaders, { 'x-session-id': '{{sessionId}}' });
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
  for(const change of [p=>p.packages.push({path:'plugins/../../outside',digest:'f'.repeat(64)}),p=>{p.sourceId=randomUUID();}]){
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
test('desktop connection synchronizes before cloud reads; unsupported sync never blocks existing catalogs', async t=>{
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
    assert.equal((await manager.call(connection.id,'product.command',{kind:'models.get'})).defaultModelId,'fixture');
    assert.ok((await manager.list())[0].configurationError.includes('Update the Agent service'));
    await assert.rejects(manager.syncConfiguration(connection.id), /Update the Agent service/);
  } finally { await manager?.close();await server?.close();await service.close(); }
});

test('transfers multi-chunk archives and disables incompatible executable MCP declarations', async t=>{
  const f=await fixture(t);
  await mkdir(join(f.local,'skills','large'),{recursive:true});
  const {randomBytes}=await import('node:crypto');
  await writeFile(join(f.local,'skills','large','blob.bin'),randomBytes(900000));
  let archive=await f.pack();assert.ok(archive.data.length<512*1024);
  assert.ok((await packSharedPackage(archive.packages[0].root)).data.length>512*1024);
  const payload=JSON.parse(gunzipSync(archive.data).toString());payload.sourcePlatform=process.platform==='win32'?'linux':'win32';
  payload.mcp.servers=[{id:'local-command',enabled:true,transport:'stdio',command:'C:\\local\\app.exe',args:[]}];
  const data=gzipSync(JSON.stringify(payload));archive={...archive,data,digest:digest(data)};
  const receiver=new AgentSharedConfiguration(f.remote,f.bundled,()=>{},async()=>({applicationState:'applied'}),{platform:'linux',capabilities:{}});
  const requests=[];
  const receipt=await sendSharedConfiguration(input=>{requests.push(input);return receiver.call(input);},archive);
  assert.ok(requests.filter(item=>item.action==='chunk').length>=3);
  assert.ok(receipt.warnings.length);assert.equal(JSON.parse(await readFile(join(f.remote,'config','mcp-servers.json'),'utf8')).servers[0].enabled,false);
});

async function plugin(f, name, manifest = {}) {
  const root=join(f.local,'plugins',name);await mkdir(join(root,'.codex-plugin'),{recursive:true});
  await writeFile(join(root,'.codex-plugin','plugin.json'),JSON.stringify({name,version:'1.0.0',description:'Fixture',...manifest}));
  f.payload.apps.plugins.push({id:name,installed:true,enabled:true,config:{token:name+'-private'}});
  return root;
}
test('generated Windows environments never enter archives or invalidate package identity', async t=>{
  const f=await fixture(t), root=await plugin(f,'video-fixture');
  for (const folder of ['.venv/Lib','.tools','node_modules/large','src','dist','models']) await mkdir(join(root,folder),{recursive:true});
  for (const path of ['.tools/uv.exe','.venv/Lib/dependency.dll','node_modules/large/native.node']) {
    await writeFile(join(root,path),'');await truncate(join(root,path),40*1024*1024);
  }
  await writeFile(join(root,'src','main.py'),'print("fixture")');
  await writeFile(join(root,'dist','main.js'),'console.log("fixture")');
  await writeFile(join(root,'models','reference.tflite'),'keep this resource');
  await writeFile(join(root,'.gitignore'),'dist/\nmodels/\n');
  const packed=await packSharedPackage(root), files=JSON.parse(gunzipSync(packed.data)).files;
  assert.ok(files.some(file=>file.path==='models/reference.tflite'));assert.ok(files.some(file=>file.path==='dist/main.js'));
  assert.ok(!files.some(file=>/\.venv|\.tools|node_modules/.test(file.path)));
  await writeFile(join(root,'.runtime-ready.json'),'local marker');
  assert.equal(await packSharedPackage(root),packed,'unchanged package reuses the compressed buffer');
  const archive=await f.pack();await sendSharedConfiguration(f.call,archive);
  const remote=join(f.remote,'plugins','video-fixture');
  await mkdir(join(remote,'.venv'),{recursive:true});await writeFile(join(remote,'.venv','ready'),'target dependency');
  assert.equal((await f.call({action:'status'})).digest,archive.digest,'target bootstrap does not cause sync drift');
});

test('configuration-only updates send no package bytes and preserve target dependencies; source changes repair incrementally', async t=>{
  const f=await fixture(t), root=await plugin(f,'incremental');
  await writeFile(join(root,'main.js'),'version 1');
  const requests=[], call=input=>{requests.push(input);return f.call(input);};
  await sendSharedConfiguration(call,await f.pack());
  const remote=join(f.remote,'plugins','incremental'), before=await stat(join(remote,'main.js'));
  await mkdir(join(remote,'.venv'),{recursive:true});await writeFile(join(remote,'.venv','ready'),'keep target installation');
  f.payload.apps.plugins[0].config.token='updated-private';f.payload.models.models[0].apiKey='new-private';requests.length=0;
  await sendSharedConfiguration(call,await f.pack());
  assert.equal(requests.filter(item=>item.action==='begin'&&item.kind==='package').length,0);
  assert.equal((await stat(join(remote,'main.js'))).mtimeMs,before.mtimeMs);
  assert.equal(await readFile(join(remote,'.venv','ready'),'utf8'),'keep target installation');
  await writeFile(join(root,'main.js'),'version 2');requests.length=0;
  await sendSharedConfiguration(call,await f.pack());
  assert.equal(requests.filter(item=>item.action==='begin'&&item.kind==='package').length,1);
  assert.equal(await readFile(join(remote,'main.js'),'utf8'),'version 2');
  await writeFile(join(remote,'main.js'),'remote drift');requests.length=0;
  await sendSharedConfiguration(call,await f.pack());
  assert.equal(requests.filter(item=>item.action==='begin'&&item.kind==='package').length,0,'repair reuses the verified Agent package cache');
  assert.equal(await readFile(join(remote,'main.js'),'utf8'),'version 2');
});

test('oversized plugin keeps its working package/config while unrelated plugins and models update', async t=>{
  const f=await fixture(t), broken=await plugin(f,'broken'), healthy=await plugin(f,'healthy');
  await writeFile(join(broken,'main.js'),'working');await writeFile(join(healthy,'main.js'),'old');
  await sendSharedConfiguration(f.call,await f.pack());
  await writeFile(join(broken,'large.bin'),'');await truncate(join(broken,'large.bin'),17*1024*1024);
  await writeFile(join(healthy,'main.js'),'new');
  f.payload.apps.plugins[0].config.token='must-not-replace';f.payload.models.models[0].model='new-model';
  const receipt=await sendSharedConfiguration(f.call,await f.pack());
  assert.match(receipt.warnings.join(),/broken.*large\.bin.*17\.0 MiB/);
  assert.doesNotMatch(JSON.stringify(receipt),/private|must-not-replace/);
  assert.equal(await readFile(join(f.remote,'plugins','healthy','main.js'),'utf8'),'new');
  assert.equal(await readFile(join(f.remote,'plugins','broken','main.js'),'utf8'),'working');
  assert.equal(JSON.parse(await readFile(join(f.remote,'config','apps.json'))).plugins.find(p=>p.id==='broken').config.token,'broken-private');
  assert.equal((await new ProductModelConfigStore(join(f.remote,'config','models.json')).read()).models[0].model,'new-model');
});

test('opt out sends no plugin secrets or files; deselection preserves remote plugins and Windows plugins remain selectable', async t=>{
  const f=await fixture(t), a=await plugin(f,'selected'), b=await plugin(f,'unchecked');
  await writeFile(join(a,'main.js'),'selected');await writeFile(join(b,'main.js'),'original');
  const initial=await f.pack();await sendSharedConfiguration(f.call,initial);
  const disabled=await packSharedConfiguration(f.payload,f.local,{syncPlugins:false});
  const payload=JSON.parse(gunzipSync(disabled.data));
  assert.deepEqual(payload.apps,{});assert.deepEqual(payload.mcp,{});assert.deepEqual(disabled.packages,[]);
  assert.doesNotMatch(gunzipSync(disabled.data).toString(),/selected-private|unchecked-private/);
  await sendSharedConfiguration(f.call,disabled);
  await writeFile(join(b,'main.js'),'do not copy');f.payload.apps.plugins[1].config.token='do not copy';
  const selected=await packSharedConfiguration(f.payload,f.local,{syncPlugins:true,excludedPluginIds:['unchecked']});
  assert.equal(selected.packages.length,1);
  await sendSharedConfiguration(f.call,selected);
  assert.equal(await readFile(join(f.remote,'plugins','unchecked','main.js'),'utf8'),'original');
  assert.equal(JSON.parse(await readFile(join(f.remote,'config','apps.json'))).plugins.find(p=>p.id==='unchecked').config.token,'unchecked-private');
  const requirements={cardbush:{runtime:{platforms:['win32'],requires:['computerUse']}}};
  assert.equal(sharedPluginCompatibility(requirements,{},'win32',{computerUse:true}),undefined);
  assert.match(sharedPluginCompatibility(requirements,{},'win32',{computerUse:false}),/computerUse/);
  assert.match(sharedPluginCompatibility(requirements,{},'linux',{computerUse:true}),/linux/);
});

test('platform launchers are resolved consistently and Windows-only packages are disabled with settings preserved', async t=>{
  const f=await fixture(t);
  await plugin(f,'windows-only',{mcpServers:{worker:{command:'powershell.exe',args:['-File','${PLUGIN_ROOT}/start.ps1']}}});
  const portable=await plugin(f,'portable',{mcpServers:{worker:{command:'powershell.exe',args:['-File','start.ps1']}},
    cardbush:{runtime:{mcpServersByPlatform:{linux:{worker:{command:'uv',args:['run','--frozen','worker.py']}}}}}});
  const linux=(await resolvePluginManifest(portable,'linux')).manifest;
  assert.equal(linux.mcpServers.worker.command,'uv');assert.equal(sharedPluginCompatibility(linux,{},'linux',{}),undefined);
  const receiver=new AgentSharedConfiguration(f.remote,f.bundled,()=>{},async()=>({applicationState:'applied'}),{platform:'linux',capabilities:{}});
  const receipt=await sendSharedConfiguration(input=>receiver.call(input),await f.pack());
  const apps=JSON.parse(await readFile(join(f.remote,'config','apps.json'))).plugins;
  assert.equal(apps.find(p=>p.id==='windows-only').enabled,false);
  assert.equal(apps.find(p=>p.id==='windows-only').config.token,'windows-only-private');
  assert.equal(apps.find(p=>p.id==='portable').enabled,true);
  assert.match(receipt.warnings.join(),/windows-only.*Windows/);
});

test('connection choices persist; parallel requests share one sync, failed reads back off, manual sync retries', async t=>{
  const {AgentService}=await import('../dist-electron/agentService.mjs');
  const {serveAgentHttp}=await import('../dist-electron/agentServer.mjs');
  const {AgentConnectionManager}=await import('../dist-electron/agentConnections.mjs');
  const f=await fixture(t);await plugin(f,'chosen');await plugin(f,'omitted');
  const service=await AgentService.open({dataRoot:f.remote,bundledRoot:f.bundled});
  let server, manager, fail=false, packs=0, release;
  let gate=new Promise(resolve=>{release=resolve;});const observed=[];
  try {
    server=await serveAgentHttp(service,{token:'s'.repeat(48)});
    manager=new AgentConnectionManager(join(f.local,'connections.json'),{encrypt:v=>v,decrypt:v=>v},{sharedConfiguration:async options=>{
      packs++;observed.push(options);await gate;if(fail)throw Error('fixture pack failed');return packSharedConfiguration(f.payload,f.local,options);
    }});
    const [connection]=await manager.save({name:'Selected',transport:'http',url:'http://127.0.0.1:'+server.port,token:'s'.repeat(48)});
    assert.equal(connection.autoSyncPlugins,false);assert.deepEqual(connection.excludedPluginIds,[]);
    const requests=[manager.call(connection.id,'conversation.catalog'),manager.call(connection.id,'product.command',{kind:'models.get'})];
    for(let i=0;packs<1&&i<100;i++)await new Promise(r=>setTimeout(r,10));
    assert.equal(packs,1);release();await Promise.all(requests);assert.equal(packs,1);
    assert.equal(observed[0].syncPlugins,false);
    assert.equal(await stat(join(f.remote,'plugins','chosen')).then(()=>true,()=>false),false);
    await manager.save({id:connection.id,name:'Selected',transport:'http',url:connection.url,excludedPluginIds:['omitted'],autoSyncPlugins:false});
    await manager.syncConfiguration(connection.id);
    assert.equal(observed.at(-1).syncPlugins,true);assert.deepEqual(observed.at(-1).excludedPluginIds,['omitted']);
    assert.equal(await stat(join(f.remote,'plugins','chosen')).then(()=>true,()=>false),true);
    assert.equal(await stat(join(f.remote,'plugins','omitted')).then(()=>true,()=>false),false);
    await manager.save({id:connection.id,name:'Renamed',transport:'http',url:connection.url});
    const saved=(await manager.list())[0];assert.equal(saved.autoSyncPlugins,false);assert.deepEqual(saved.excludedPluginIds,['omitted']);
    assert.equal(saved.syncSkills,true);
    fail=true;const before=packs;
    await manager.call(connection.id,'conversation.catalog');
    await manager.call(connection.id,'product.command',{kind:'models.get'});
    await manager.call(connection.id,'conversation.catalog');
    assert.equal(packs,before+1,'repeated failed reads do not repack');
    assert.match((await manager.list())[0].configurationError,/fixture pack failed/);
    fail=false;await manager.syncConfiguration(connection.id);assert.equal(packs,before+2,'manual sync bypasses backoff');
    assert.equal((await manager.list())[0].configurationError,undefined);
    await manager.save({id:connection.id,name:'Automatic',transport:'http',url:connection.url,autoSyncPlugins:true});
    await manager.call(connection.id,'conversation.catalog');assert.equal(observed.at(-1).syncPlugins,true);
  } finally { release();await manager?.close();await server?.close();await service.close(); }
});

test('file traversal inside a content-addressed package cannot escape staging or alter live configuration', async t=>{
  const f=await fixture(t);await sendSharedConfiguration(f.call,await f.pack());
  const original=await readFile(join(f.remote,'config','models.json'));
  const bad=gzipSync(JSON.stringify({files:[{path:'../../config/models.json',data:Buffer.from('bad').toString('base64'),mode:0o600}]}));
  const id=digest(bad);
  await f.call({action:'begin',digest:id,size:bad.length,kind:'package'});
  await f.call({action:'chunk',digest:id,offset:0,data:bad.toString('base64')});await f.call({action:'apply',digest:id});
  const payload=JSON.parse(gunzipSync((await f.pack()).data));payload.packages=[{path:'skills/hostile',digest:id}];
  const data=gzipSync(JSON.stringify(payload));
  await assert.rejects(sendSharedConfiguration(f.call,{data,digest:digest(data)}));
  assert.deepEqual(await readFile(join(f.remote,'config','models.json')),original);
});

test('changed host capabilities recheck activation and another OS cannot reuse a generated environment', async t=>{
  const f=await fixture(t);await plugin(f,'host-aware',{cardbush:{runtime:{requires:['desktop']}}});
  const host={platform:'win32',capabilities:{desktop:false}};
  const receiver=new AgentSharedConfiguration(f.remote,f.bundled,()=>{},async()=>({applicationState:'applied'}),host);
  const archive=await f.pack(), call=input=>receiver.call(input);
  await sendSharedConfiguration(call,archive);
  const enabled=async()=>JSON.parse(await readFile(join(f.remote,'config','apps.json'))).plugins.find(p=>p.id==='host-aware').enabled;
  assert.equal(await enabled(),false);
  host.capabilities.desktop=true;assert.equal(await call({action:'status'}),null);
  await sendSharedConfiguration(call,archive);assert.equal(await enabled(),true);
  const environment=join(f.remote,'plugins','host-aware','.venv');await mkdir(environment);await writeFile(join(environment,'windows'),'generated');
  host.platform='linux';
  await sendSharedConfiguration(call,await packSharedConfiguration(f.payload,f.local,{syncPlugins:false}));
  await sendSharedConfiguration(call,archive);
  assert.equal(await stat(environment).then(()=>true,()=>false),false,'a prior config-only sync cannot mark Windows dependencies portable');
});
