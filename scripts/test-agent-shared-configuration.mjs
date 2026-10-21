import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir, stat, truncate } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { AgentSharedConfiguration, packSharedConfiguration, sendSharedConfiguration, recoverSharedConfiguration } from '../dist-electron/agentSharedConfiguration.mjs';
import { ProductModelConfigStore, ProductMcpConfigStore } from '../packages/cardbush-product-host/dist/index.js';
import { packSharedPackage, sharedPluginCompatibility } from '../dist-electron/agentSharedPackages.mjs';
import { resolvePluginManifest } from '../dist-electron/pluginManifest.js';
import { McpClientManager } from '../packages/bush-mcp-client/dist/index.js';
import { ToolRegistry } from '../packages/bush-runtime/dist/index.js';
import { BUSH_MCP_SNAPSHOT_PROTOCOL } from '../packages/bush-protocol/dist/index.js';

const base = resolve('tmp/shared-configuration-tests');
const digest = data => createHash('sha256').update(data).digest('hex');
async function fixture(t) {
  await mkdir(base, {recursive:true}); const root=await mkdtemp(join(base,'test-'));
  t.after(async()=>{assert.ok(resolve(root).startsWith(base)); await rm(root,{recursive:true,force:true,maxRetries:3,retryDelay:100});});
  const local=join(root,'local'), remote=join(root,'remote'), bundled=join(root,'bundled');
  await Promise.all([mkdir(local,{recursive:true}),mkdir(remote,{recursive:true}),mkdir(bundled,{recursive:true})]);
  await new ProductMcpConfigStore(join(remote,'config/mcp-servers.json')).write({servers:[]});
  const roots=[{source:join(local,'plugins'),target:'plugins'},{source:join(local,'skills'),target:'skills'}];
  let active=false, fail=false, refreshes=0;
  const receiver=new AgentSharedConfiguration(remote,bundled,()=>{if(active)throw Error('running tasks');},async()=>{refreshes++;if(fail)throw Error('fixture-secret must not leak');return {applicationState:'applied'};});
  const payload={roots,models:{defaultModelId:'fixture',models:[{id:'fixture',provider:'openai',model:'fixture',apiKey:'fixture-secret'}]},
    apps:{serviceEnabled:true,plugins:[]},mcp:{servers:[]},subagents:{},instructions:'Shared rules.',network:{mode:'none',httpProxy:'',httpsProxy:'',noProxy:''},sandbox:{version:1,enabled:true}};
  return {root,local,remote,bundled,payload,receiver,pack:()=>packSharedConfiguration(payload,local,{syncPlugins:true}),call:input=>receiver.call(input),get refreshes(){return refreshes;},set active(v){active=v;},set fail(v){fail=v;}};
}

test('real asynchronous MCP submission with zero plugins commits after pending resolves and remains idempotent', async t => {
  const f = await fixture(t);
  const manager = new McpClientManager({ registry: new ToolRegistry() });
  let submits = 0, reads = 0;
  const receiver = new AgentSharedConfiguration(f.remote, f.bundled, () => {}, async () => {
    submits++;
    const { revision } = JSON.parse(await readFile(join(f.remote, 'config/mcp-servers.json'), 'utf8'));
    const initial = manager.submit({ protocol: BUSH_MCP_SNAPSHOT_PROTOCOL, snapshotId: 'async-sync', revision, servers: [] });
    assert.equal(initial.applicationState, 'pending');
    assert.equal(initial.applicationError, undefined);
    return initial;
  }, undefined, { read: async () => { reads++; return manager.snapshot(); }, pollMs: 1 });
  try {
    const archive = await f.pack();
    await sendSharedConfiguration(input => receiver.call(input), archive);
    assert.equal(manager.snapshot().applicationState, 'applied');
    assert.equal(await readFile(join(f.remote, 'AGENTS.md'), 'utf8'), 'Shared rules.');
    assert.equal((await receiver.call({ action: 'status' })).digest, archive.digest);
    await sendSharedConfiguration(input => receiver.call(input), archive);
    assert.equal(submits, 1); assert.equal(reads, 0, 'optional connection readiness does not delay configuration commit');
  } finally { await manager.close(); }
});

test('Python plugin transfer keeps package instructions and never prepares or infers a dependency runtime', async t => {
  const f=await fixture(t),root=join(f.local,'plugins','python-fixture'),venv=join(f.local,'runtime');
  await mkdir(join(root,'.claude-plugin'),{recursive:true});await mkdir(join(venv,'Scripts'),{recursive:true});
  await writeFile(join(venv,'pyvenv.cfg'),'version = 3.12.10\n');
  await writeFile(join(root,'.claude-plugin/plugin.json'),JSON.stringify({name:'python-fixture',version:'1.0.0',description:'Fixture'}));
  await writeFile(join(root,'.mcp.json'),JSON.stringify({mcpServers:{example:{command:join(venv,'Scripts/python.exe'),args:['-m','fixture']}}}));
  await writeFile(join(root,'pyproject.toml'),'[project]\nname="fixture"\nversion="1.0.0"');
  f.payload.apps.plugins=[{id:'python-fixture',installed:true,enabled:true,config:{mcp_servers:{example:{default_tools_approval_mode:'ask'}}}}];
  const original=structuredClone(f.payload.apps);
  const archive=await f.pack();await sendSharedConfiguration(f.call,archive);
  const apps=JSON.parse(await readFile(join(f.remote,'config/apps.json'),'utf8'));
  assert.deepEqual(apps.plugins.find(p=>p.id==='python-fixture').config,{});
  assert.equal(await readFile(join(f.remote,'plugins/python-fixture/.mcp.json'),'utf8'),await readFile(join(root,'.mcp.json'),'utf8'));
  assert.equal(await stat(join(f.remote,'runtime-state')).then(()=>true,()=>false),false);
  assert.deepEqual(f.payload.apps,original);
  assert.equal((await f.pack()).digest,archive.digest);
  const before=f.refreshes;await sendSharedConfiguration(f.call,archive);assert.equal(f.refreshes,before);
  assert.ok(!JSON.stringify(apps).includes('staging'),'runtime plan must not retain staging paths');
});

test('changed desktop readiness invalidates cached sync warnings without changing capability booleans', async t => {
  const f=await fixture(t); let issue='interactive session is not accessible';
  const receiver=new AgentSharedConfiguration(f.remote,f.bundled,()=>{},async()=>({applicationState:'applied'}),
    {platform:'win32',capabilities:{computerUse:false},capabilityIssue:()=>issue});
  const archive=await f.pack(); await sendSharedConfiguration(input=>receiver.call(input),archive);
  assert.equal((await receiver.call({action:'status'})).digest,archive.digest);
  issue='desktop detected; backend awaits configuration';
  assert.equal(await receiver.call({action:'status'}),null);
  await sendSharedConfiguration(input=>receiver.call(input),archive);
  assert.equal((await receiver.call({action:'status'})).digest,archive.digest);
});

test('slow optional MCP startup commits configuration without claiming tools are ready or waiting for the connection deadline', async t => {
  const f = await fixture(t), registry = new ToolRegistry();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const manager = new McpClientManager({ registry, createTransport: () => ({ async send() {} }),
    createClient: () => ({ async connect() { await gate; }, async close() {},
      async listTools() { return { tools: [] }; }, getNegotiatedProtocolVersion() { return '2025-11-25'; } }) });
  let reads = 0;
  const receiver = new AgentSharedConfiguration(f.remote, f.bundled, () => {}, async () => manager.submit({
    protocol: BUSH_MCP_SNAPSHOT_PROTOCOL, snapshotId: 'background-sync', revision: 1,
    servers: Array.from({ length: 12 }, (_, i) => ({ id: 'slow-'+i, transport: { kind: 'stdio', command: 'fixture', args: [], env: {} } })),
  }), undefined, { timeoutMs: 25, pollMs: 1, read: async () => { reads++; return manager.snapshot(); } });
  try {
    const archive = await f.pack();
    const receipt = await sendSharedConfiguration(input => receiver.call(input), archive);
    assert.equal(receipt.digest, archive.digest);
    assert.equal(reads, 0, 'configuration commit does not poll optional connections');
    assert.equal(manager.snapshot().applicationState, 'pending', 'tool readiness remains explicit');
    assert.equal(manager.snapshot().backgroundConnectionPending, true);
    assert.equal(registry.definitions().length, 0, 'no invented ready tools');
    assert.equal((await receiver.call({ action: 'status' })).digest, archive.digest);
    assert.equal(await readFile(join(f.remote, 'AGENTS.md'), 'utf8'), 'Shared rules.');
  } finally { release(); await manager.close(); }
});

for (const failure of ['failed', 'timeout', 'superseded', 'read-rejected', 'read-stalled']) {
  test(`pending configuration ${failure} restores previous files and awaits asynchronous rollback without leaking credentials`, async t => {
    const f = await fixture(t);
    await sendSharedConfiguration(f.call, await f.pack());
    const original = await readFile(join(f.remote, 'config/models.json'), 'utf8');
    f.payload.models.models[0].apiKey = 'new-secret-value';
    f.payload.instructions = 'Replacement rules.';
    let refreshes = 0, reads = 0;
    const state = (applicationState, revision = refreshes, extra = {}) => ({ snapshotId: 'pending-sync', revision, applicationState, ...extra });
    const receiver = new AgentSharedConfiguration(f.remote, f.bundled, () => {}, async () => {
      refreshes++; return state('pending', refreshes - 1, { pendingRevision: refreshes });
    }, undefined, { timeoutMs: 35, pollMs: 1, read: async () => {
      reads++;
      if (refreshes > 1) return state('applied');
      if (failure === 'read-rejected') throw Error('failed with fixture-secret and new-secret-value');
      if (failure === 'read-stalled') return new Promise(() => {});
      if (failure === 'failed') return state('failed', 0, { pendingRevision: 1, applicationError: 'launch failed: fixture-secret new-secret-value Bearer opaque-secret' });
      if (failure === 'superseded') return state('applied', 99);
      return state('pending', 0, { pendingRevision: 1, applicationPhase: 'waiting_for_resources' });
    } });
    await assert.rejects(sendSharedConfiguration(input => receiver.call(input), await f.pack()), error => {
      assert.match(error.message, /Agent configuration was not applied/);
      assert.doesNotMatch(error.message, /fixture-secret|new-secret-value|opaque-secret/);
      return true;
    });
    assert.equal(refreshes, 2); assert.ok(reads >= 2);
    assert.equal(await readFile(join(f.remote, 'config/models.json'), 'utf8'), original);
    assert.equal(await readFile(join(f.remote, 'AGENTS.md'), 'utf8'), 'Shared rules.');
    const receipt = JSON.parse(await readFile(join(f.remote, 'shared-configuration/current.json'), 'utf8'));
    assert.notEqual(receipt.recoveryRequired, true);
  });
}

test('failed rollback remains marked for recovery instead of claiming runtime restoration', async t => {
  const f = await fixture(t); await sendSharedConfiguration(f.call, await f.pack());
  f.payload.instructions = 'Replacement rules.';
  const receiver = new AgentSharedConfiguration(f.remote, f.bundled, () => {}, async () => ({ applicationState: 'pending' }),
    undefined, { timeoutMs: 10, pollMs: 1, read: async () => ({ applicationState: 'pending' }) });
  await assert.rejects(sendSharedConfiguration(input => receiver.call(input), await f.pack()), /Timed out/);
  assert.equal(await receiver.call({ action: 'status' }), null);
  assert.equal(await readFile(join(f.remote, 'AGENTS.md'), 'utf8'), 'Shared rules.');
  assert.equal(JSON.parse(await readFile(join(f.remote, 'shared-configuration/current.json'), 'utf8')).recoveryRequired, true);
});

test('syncs models, instructions, plugin files and skills without desktop plugin settings; unchanged settings do no writes', async t=>{
  const f=await fixture(t);
  f.payload.models.models[0].apiProtocol = 'anthropic_messages';
  f.payload.models.models[0].defaultHeaders = { 'x-session-id': '{{sessionId}}' };
  await mkdir(join(f.local,'plugins','fixture-plugin','.codex-plugin'),{recursive:true});
  await writeFile(join(f.local,'plugins','fixture-plugin','.codex-plugin','plugin.json'),JSON.stringify({name:'fixture-plugin',version:'1.0.0',description:'Shared fixture',skills:'./skills',interface:{logo:'./icon.svg'}}));
  await mkdir(join(f.local,'plugins','fixture-plugin','skills','example'),{recursive:true});
  await writeFile(join(f.local,'plugins','fixture-plugin','skills','example','SKILL.md'),'---\nname: example\ndescription: fixture\n---\nFixture');
  await writeFile(join(f.local,'plugins','fixture-plugin','icon.svg'),'<svg xmlns="http://www.w3.org/2000/svg"/>');
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
  assert.deepEqual(apps.plugins.find(p=>p.id==='fixture-plugin').config,{});
  const plugin = apps.plugins.find(p=>p.id==='fixture-plugin');
  assert.equal(plugin.manifestPath,join(f.remote,'plugins','fixture-plugin','.codex-plugin','plugin.json'));
  assert.equal(plugin.logoPath,join(f.remote,'plugins','fixture-plugin','icon.svg'));
  assert.ok(plugin.skillRoots.length);
  for(const path of [plugin.manifestPath,plugin.logoPath,...plugin.skillRoots]) await stat(path);
  assert.doesNotMatch(JSON.stringify(plugin),/shared-configuration[\\\\/]staging/);
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
  assert.equal(rollbackRevision,revision,'rollback does not change untouched target MCP settings');
  f.fail=false;await sendSharedConfiguration(f.call,changed);
  assert.equal(await readFile(join(f.remote,'AGENTS.md'),'utf8'),'Changed');
  assert.equal(JSON.parse(await readFile(join(f.remote,'config','mcp-servers.json'),'utf8')).revision,rollbackRevision);
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
    server=await serveAgentHttp(service,{token:'x'.repeat(48),port:0});
    manager=new AgentConnectionManager(join(f.local,'connections.json'),{encrypt:v=>v,decrypt:v=>v},{sharedConfiguration:f.pack});
    const [connection]=await manager.save({name:'Cloud fixture',transport:'http',url:'http://127.0.0.1:'+server.port,token:'x'.repeat(48)});
    const models=await manager.call(connection.id,'product.command',{kind:'models.get'});
    assert.equal(models.defaultModelId,'fixture');assert.equal(models.models[0].hasApiKey,true);
    assert.doesNotMatch(JSON.stringify(models),/fixture-secret/);
    assert.equal((await service.instructions.read()).content,'Shared rules.');
    assert.equal((await manager.list())[0].configurationError,undefined);
    f.payload.models.models[0].model='updated-fixture';f.payload.instructions='Updated shared rules.';
    await manager.call(connection.id,'conversation.catalog');
    assert.equal((await manager.list())[0].configurationError,undefined);
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

test('transfers multi-chunk archives and ignores standalone MCP settings from legacy senders', async t=>{
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
  assert.deepEqual(receipt.warnings,[]);
  assert.deepEqual(JSON.parse(await readFile(join(f.remote,'config','mcp-servers.json'),'utf8')).servers,[]);
});

async function plugin(f, name, manifest = {}) {
  const root=join(f.local,'plugins',name);await mkdir(join(root,'.codex-plugin'),{recursive:true});
  await writeFile(join(root,'.codex-plugin','plugin.json'),JSON.stringify({name,version:'1.0.0',description:'Fixture',...manifest}));
  f.payload.apps.plugins.push({id:name,installed:true,enabled:true,config:{token:name+'-private'}});
  return root;
}

async function remotePluginSettings(f,id,config) {
  const path=join(f.remote,'config/apps.json'),apps=JSON.parse(await readFile(path,'utf8'));
  apps.plugins.find(p=>p.id===id).config=config;apps.revision++;
  await writeFile(path,JSON.stringify(apps));
}

test('plugin transfer never exports local settings or env and preserves target parameters even against legacy senders', async t => {
  const f=await fixture(t),root=await plugin(f,'parameters');
  await writeFile(join(root,'.mcp.json'),JSON.stringify({mcpServers:{server:{command:'node',args:['server.js'],env_vars:['CARDBUSH_TEST_SYNC_ENV']}}}));
  const pluginConfig=f.payload.apps.plugins.find(p=>p.id==='parameters');
  f.payload.mcp={servers:[{id:'private-server',transport:{kind:'stdio',command:'node',args:[],env:{TOKEN:'remote-mcp-key'}}}]};
  await sendSharedConfiguration(f.call,await f.pack());
  await remotePluginSettings(f,'parameters',{saved:'remote-value',mcp_servers:{server:{connection:{command:'target-python',env:{KEY:'remote-key'}},tools:{write:{approval_mode:'deny'}}}}});
  await new ProductMcpConfigStore(join(f.remote,'config/mcp-servers.json')).write(f.payload.mcp);
  const remoteMcp=await readFile(join(f.remote,'config/mcp-servers.json'),'utf8');
  pluginConfig.config={saved:'local-secret',mcp_servers:{server:{connection:{env:{KEY:'local-key'}}}}};
  f.payload.mcp.servers[0].transport.env.TOKEN='local-mcp-key';
  process.env.CARDBUSH_TEST_SYNC_ENV='inherited-secret';t.after(()=>{delete process.env.CARDBUSH_TEST_SYNC_ENV});
  await writeFile(join(root,'updated.txt'),'new package version');
  const off=await packSharedConfiguration(f.payload,f.local,{syncPlugins:true});
  const snapshot=gunzipSync(off.data).toString('utf8');
  for(const secret of ['local-secret','local-key','local-mcp-key','inherited-secret']) assert.ok(!snapshot.includes(secret));
  await sendSharedConfiguration(f.call,off);
  const kept=JSON.parse(await readFile(join(f.remote,'config/apps.json'),'utf8')).plugins.find(p=>p.id==='parameters');
  assert.equal(kept.config.saved,'remote-value');assert.equal(kept.config.mcp_servers.server.connection.env.KEY,'remote-key');
  assert.equal(await readFile(join(f.remote,'config/mcp-servers.json'),'utf8'),remoteMcp);
  assert.equal(await readFile(join(f.remote,'plugins/parameters/updated.txt'),'utf8'),'new package version');
  assert.equal(kept.config.mcp_servers.server.connection.command,'target-python');
  assert.equal(kept.config.mcp_servers.server.tools.write.approval_mode,'deny');
  const legacy=JSON.parse(snapshot);legacy.apps.plugins[0].config=pluginConfig.config;legacy.mcp=f.payload.mcp;
  const data=gzipSync(JSON.stringify(legacy));
  await sendSharedConfiguration(f.call,{...off,data,digest:digest(data)});
  const final=JSON.parse(await readFile(join(f.remote,'config/apps.json'),'utf8')).plugins.find(p=>p.id==='parameters');
  assert.deepEqual(final.config,kept.config);
  assert.equal(await readFile(join(f.remote,'config/mcp-servers.json'),'utf8'),remoteMcp);
});

async function holdPluginDirectory(t, directory) {
  const child = spawn(process.execPath, ['-e', 'process.stdin.resume();process.stdout.write("ready");'], {
    cwd: directory, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = once(child, 'close');
  await once(child.stdout, 'data');
  const stop = async () => { if (child.exitCode === null) child.stdin.end(); await exited; };
  t.after(stop);
  return { child, stop };
}

test('shared package updates release all changed processes before swapping directories and keep unrelated plugins running', async t => {
  const f = await fixture(t);
  for (const name of ['alpha', 'beta', 'unrelated']) await plugin(f, name);
  await sendSharedConfiguration(f.call, await f.pack());
  const processes = new Map();
  for (const name of ['alpha', 'beta', 'unrelated']) processes.set(name, await holdPluginDirectory(t, join(f.remote, 'plugins', name)));
  for (const name of ['alpha', 'beta']) await writeFile(join(f.local, 'plugins', name, 'updated.txt'), 'updated');
  f.payload.apps.plugins[0].config.token = 'updated-secret';
  f.payload.apps.plugins[1].enabled = false;
  const released = [];
  const receiver = new AgentSharedConfiguration(f.remote, f.bundled, () => {}, async () => {
    assert.notEqual(processes.get('alpha').child.exitCode, null);
    assert.notEqual(processes.get('beta').child.exitCode, null);
    assert.equal(processes.get('unrelated').child.exitCode, null);
    return { applicationState: 'applied' };
  }, undefined, { read: async () => ({}), preparePluginUpdate: async id => {
    const apps = JSON.parse(await readFile(join(f.remote, 'config/apps.json'), 'utf8'));
    for (const name of ['alpha', 'beta']) assert.equal(apps.plugins.find(p => p.id === name).enabled, false);
    assert.equal(apps.plugins.find(p => p.id === 'unrelated').enabled, true);
    assert.ok(JSON.parse(await readFile(join(f.remote, 'shared-configuration/transaction.json'))).id);
    // Neither replacement has started, even when the second process is released.
    for (const name of ['alpha', 'beta']) await assert.rejects(stat(join(f.remote, 'plugins', name, 'updated.txt')), { code: 'ENOENT' });
    await processes.get(id).stop(); released.push(id);
    return { applicationState: 'applied' };
  } });
  const archive = await f.pack();
  await sendSharedConfiguration(input => receiver.call(input), archive);
  assert.deepEqual(released, ['alpha', 'beta']);
  const apps = JSON.parse(await readFile(join(f.remote, 'config/apps.json'), 'utf8'));
  assert.equal(apps.plugins.find(p => p.id === 'alpha').enabled, true);
  assert.deepEqual(apps.plugins.find(p => p.id === 'alpha').config, {});
  assert.equal(apps.plugins.find(p => p.id === 'beta').enabled, false);
  for (const name of ['alpha', 'beta']) assert.equal(await readFile(join(f.remote, 'plugins', name, 'updated.txt'), 'utf8'), 'updated');
  await sendSharedConfiguration(input => receiver.call(input), archive);
  assert.deepEqual(released, ['alpha', 'beta'], 'unchanged sync neither stops nor reconnects plugins');
  // Stop before fixture cleanup (test cleanup hooks run in registration order).
  await processes.get('unrelated').stop();
});

test('a directory held outside MCP reports the relative target and filesystem code and restores prior configuration', { skip: process.platform !== 'win32' }, async t => {
  const f = await fixture(t); await plugin(f, 'locked');
  await sendSharedConfiguration(f.call, await f.pack());
  const original = await readFile(join(f.remote, 'config/apps.json'), 'utf8');
  const held = await holdPluginDirectory(t, join(f.remote, 'plugins/locked'));
  await writeFile(join(f.local, 'plugins/locked/new.txt'), 'replacement');
  try {
    await assert.rejects(sendSharedConfiguration(f.call, await f.pack()), error => {
      assert.match(error.message, /configuration replacement.*plugins\/locked.*E(?:PERM|ACCES|BUSY)/);
      assert.doesNotMatch(error.message, /fixture-secret|locked-private/);
      return true;
    });
    assert.equal(await readFile(join(f.remote, 'config/apps.json'), 'utf8'), original);
    await assert.rejects(stat(join(f.remote, 'plugins/locked/new.txt')), { code: 'ENOENT' });
  } finally { await held.stop(); }
});

test('pending teardown cannot replace a package and restores temporary disabled settings', async t => {
  const f = await fixture(t); await plugin(f, 'waiting'); await sendSharedConfiguration(f.call, await f.pack());
  const original = await readFile(join(f.remote, 'config/apps.json'), 'utf8');
  await writeFile(join(f.local, 'plugins/waiting/new.txt'), 'replacement');
  const receiver = new AgentSharedConfiguration(f.remote, f.bundled, () => {}, async () => ({ applicationState: 'applied' }), undefined,
    { read: async () => ({}), preparePluginUpdate: async () => ({ applicationState: 'pending' }) });
  await assert.rejects(sendSharedConfiguration(input => receiver.call(input), await f.pack()), /Plugin processes have not been released/);
  assert.equal(await readFile(join(f.remote, 'config/apps.json'), 'utf8'), original);
  await assert.rejects(stat(join(f.remote, 'plugins/waiting/new.txt')), { code: 'ENOENT' });
  await assert.rejects(stat(join(f.remote, 'shared-configuration/transaction.json')), { code: 'ENOENT' });
});

test('sync leaves unresolved package interpreter paths for the receiving Agent to configure', async t => {
  const f = await fixture(t);
  const server = { command: join(f.local, 'not-installed/python.exe'), args: ['server.py'], cwd: join(f.local, 'missing-runtime') };
  await plugin(f, 'missing-launch', { mcpServers: { worker: server } });
  f.payload.apps.plugins[0].config.mcp_servers = { worker: { enabled: true, default_tools_approval_mode: 'ask' } };
  const receipt = await sendSharedConfiguration(f.call, await f.pack());
  assert.deepEqual(receipt.warnings, []);
  const saved = JSON.parse(await readFile(join(f.remote, 'config/apps.json'), 'utf8')).plugins.find(p => p.id === 'missing-launch');
  assert.equal(saved.enabled, true);
  assert.deepEqual(saved.config, {});
  const manifest = JSON.parse(await readFile(join(f.remote, 'plugins/missing-launch/.codex-plugin/plugin.json'), 'utf8'));
  assert.deepEqual(manifest.mcpServers.worker, server);
  assert.equal((await new ProductModelConfigStore(join(f.remote, 'config/models.json')).read()).defaultModelId, 'fixture');
});

test('failed activation releases replacement processes before rollback and restores original enabled settings', async t => {
  const f = await fixture(t); await plugin(f, 'rollback'); await sendSharedConfiguration(f.call, await f.pack());
  const directory = join(f.remote, 'plugins/rollback');
  const original = await readFile(join(f.remote, 'config/apps.json'), 'utf8');
  await writeFile(join(f.local, 'plugins/rollback/new.txt'), 'replacement');
  let held = await holdPluginDirectory(t, directory), refreshes = 0, releases = 0;
  const receiver = new AgentSharedConfiguration(f.remote, f.bundled, () => {}, async () => {
    if (++refreshes === 1) {
      held = await holdPluginDirectory(t, directory);
      return { applicationState: 'failed', applicationError: 'fixture-secret activation failed' };
    }
    return { applicationState: 'applied' };
  }, undefined, { read: async () => ({}), preparePluginUpdate: async () => {
    await held.stop(); releases++; return { applicationState: 'applied' };
  } });
  await assert.rejects(sendSharedConfiguration(input => receiver.call(input), await f.pack()), error => {
    assert.match(error.message, /activation failed/); assert.doesNotMatch(error.message, /fixture-secret/); return true;
  });
  assert.equal(releases, 2); assert.equal(refreshes, 2);
  assert.equal(await readFile(join(f.remote, 'config/apps.json'), 'utf8'), original);
  await assert.rejects(stat(join(directory, 'new.txt')), { code: 'ENOENT' });
});

test('interrupted rollback retains recovery journal until a process-free startup restores original settings', async t => {
  const f = await fixture(t); await plugin(f, 'recovery'); await sendSharedConfiguration(f.call, await f.pack());
  const original = await readFile(join(f.remote, 'config/apps.json'), 'utf8');
  await writeFile(join(f.local, 'plugins/recovery/new.txt'), 'replacement');
  let releases = 0;
  const receiver = new AgentSharedConfiguration(f.remote, f.bundled, () => {}, async () => ({ applicationState: 'failed' }), undefined,
    { read: async () => ({}), preparePluginUpdate: async () => ({ applicationState: ++releases === 1 ? 'applied' : 'failed' }) });
  await assert.rejects(sendSharedConfiguration(input => receiver.call(input), await f.pack()), /journal and backups retained/);
  assert.ok(JSON.parse(await readFile(join(f.remote, 'shared-configuration/transaction.json'), 'utf8')).id);
  await recoverSharedConfiguration(f.remote);
  assert.equal(await readFile(join(f.remote, 'config/apps.json'), 'utf8'), original);
  await assert.rejects(stat(join(f.remote, 'plugins/recovery/new.txt')), { code: 'ENOENT' });
});

test('Agent service shared sync tears down a real stdio MCP before replacing its working directory and reconnects the new version', async t => {
  const { AgentService } = await import('../dist-electron/agentService.mjs');
  const f = await fixture(t), log = join(f.root, 'mcp-lifecycle.jsonl');
  const source = await plugin(f, 'live-mcp', { mcpServers: { echo: { type: 'stdio', command: process.execPath,
    args: ['${PLUGIN_ROOT}/server.mjs', log], cwd: '${PLUGIN_ROOT}' } } });
  const serverSource = version => `import {createInterface} from 'node:readline';
import {appendFileSync} from 'node:fs';
const log=event=>appendFileSync(process.argv[2],JSON.stringify({event,version:${JSON.stringify(version)},pid:process.pid})+'\\n');
log('start');const input=createInterface({input:process.stdin});
input.on('line',line=>{const r=JSON.parse(line);if(r.id===undefined)return;
const result=r.method==='initialize'?{protocolVersion:r.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:${JSON.stringify(version)}}}:r.method==='tools/list'?{tools:[]}:{};
process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:r.id,result})+'\\n');});
input.on('close',()=>{log('close');process.exit(0);});`;
  await writeFile(join(source, 'server.mjs'), serverSource('1'));
  const service = await AgentService.open({ dataRoot: f.remote, bundledRoot: f.bundled });
  const entries = async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const waitFor = async predicate => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const values = await entries(); if (predicate(values)) return values; await new Promise(resolve => setTimeout(resolve, 30)); }
    assert.fail('Fixture MCP lifecycle did not settle: ' + JSON.stringify(await entries()));
  };
  try {
    const call = input => service.call('configuration.sync', input);
    await sendSharedConfiguration(call, await f.pack());
    const first = (await waitFor(values => values.some(v => v.version === '1' && v.event === 'start')))[0];
    await writeFile(join(source, 'server.mjs'), serverSource('2'));
    const archive = await f.pack();
    await sendSharedConfiguration(call, archive);
    const events = await waitFor(values => values.some(v => v.version === '2' && v.event === 'start'));
    const closed = events.findIndex(v => v.pid === first.pid && v.event === 'close');
    const started = events.findIndex(v => v.version === '2' && v.event === 'start');
    assert.ok(closed >= 0 && closed < started, 'old MCP exits before replacement MCP starts');
    assert.equal(await readFile(join(f.remote, 'plugins/live-mcp/server.mjs'), 'utf8'), serverSource('2'));
    assert.equal(JSON.parse(await readFile(join(f.remote, 'config/apps.json'), 'utf8')).plugins.find(p => p.id === 'live-mcp').enabled, true);
    assert.equal((await call({ action: 'status' })).digest, archive.digest);
  } finally { await service.close(); }
});
test('generated Windows environments never enter archives or invalidate package identity', async t=>{
  const f=await fixture(t), root=await plugin(f,'video-fixture');
  for (const folder of ['.venv/Lib','.tools','node_modules/large','.gpu-cache','src','dist','models']) await mkdir(join(root,folder),{recursive:true});
  for (const path of ['.tools/uv.exe','.venv/Lib/dependency.dll','node_modules/large/native.node','.gpu-cache/11082869686020692436.blob']) {
    await writeFile(join(root,path),'');await truncate(join(root,path),40*1024*1024);
  }
  await writeFile(join(root,'src','main.py'),'print("fixture")');
  await writeFile(join(root,'dist','main.js'),'console.log("fixture")');
  await writeFile(join(root,'models','reference.tflite'),'keep this resource');
  await writeFile(join(root,'.gitignore'),'dist/\nmodels/\n');
  const packed=await packSharedPackage(root), files=JSON.parse(gunzipSync(packed.data)).files;
  assert.ok(files.some(file=>file.path==='models/reference.tflite'));assert.ok(files.some(file=>file.path==='dist/main.js'));
  assert.ok(!files.some(file=>/\.venv|\.tools|node_modules|\.gpu-cache/.test(file.path)));
  await writeFile(join(root,'.runtime-ready.json'),'local marker');
  await writeFile(join(root,'.gpu-cache/another.blob'),'generated locally');
  assert.equal(await packSharedPackage(root),packed,'unchanged package reuses the compressed buffer');
  const archive=await f.pack();await sendSharedConfiguration(f.call,archive);
  const remote=join(f.remote,'plugins','video-fixture');
  await mkdir(join(remote,'.venv'),{recursive:true});await writeFile(join(remote,'.venv','ready'),'target dependency');
  await mkdir(join(remote,'.gpu-cache'),{recursive:true});await writeFile(join(remote,'.gpu-cache/compiled.blob'),'target GPU cache');
  assert.equal((await f.call({action:'status'})).digest,archive.digest,'target bootstrap does not cause sync drift');
  await writeFile(join(root,'models/too-large.bin'),''); await truncate(join(root,'models/too-large.bin'),17*1024*1024);
  await assert.rejects(packSharedPackage(root),/exceeds file limit/,'actual model assets retain the file size protection');
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
  await remotePluginSettings(f,'broken',{token:'broken-private'});
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
  await remotePluginSettings(f,'unchecked',{token:'unchecked-private'});
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
  assert.equal(sharedPluginCompatibility(requirements,{},'win32',{computerUse:false}),undefined);
  assert.match(sharedPluginCompatibility(requirements,{},'linux',{computerUse:true}),/linux/);
});

test('sync honors declared platform support without inferring restrictions from launcher paths', async t=>{
  const f=await fixture(t);
  await plugin(f,'windows-only',{mcpServers:{worker:{command:'powershell.exe',args:['-File','${PLUGIN_ROOT}/start.ps1']}},cardbush:{runtime:{platforms:['win32']}}});
  await plugin(f,'unresolved-launcher',{mcpServers:{worker:{command:'C:/missing/python.exe',args:['server.py']}}});
  const portable=await plugin(f,'portable',{mcpServers:{worker:{command:'powershell.exe',args:['-File','start.ps1']}},
    cardbush:{runtime:{mcpServersByPlatform:{linux:{worker:{command:'uv',args:['run','--frozen','worker.py']}}}}}});
  const linux=(await resolvePluginManifest(portable,'linux')).manifest;
  assert.equal(linux.mcpServers.worker.command,'uv');assert.equal(sharedPluginCompatibility(linux,{},'linux',{}),undefined);
  const receiver=new AgentSharedConfiguration(f.remote,f.bundled,()=>{},async()=>({applicationState:'applied'}),{platform:'linux',capabilities:{}});
  const receipt=await sendSharedConfiguration(input=>receiver.call(input),await f.pack());
  const apps=JSON.parse(await readFile(join(f.remote,'config','apps.json'))).plugins;
  assert.equal(apps.find(p=>p.id==='windows-only').enabled,false);
  assert.deepEqual(apps.find(p=>p.id==='windows-only').config,{});
  assert.equal(apps.find(p=>p.id==='unresolved-launcher').enabled,true);
  assert.equal(apps.find(p=>p.id==='portable').enabled,true);
  assert.match(receipt.warnings.join(),/windows-only.*plugin platform mismatch/);
  assert.doesNotMatch(receipt.warnings.join(),/unresolved-launcher/);
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
    server=await serveAgentHttp(service,{token:'s'.repeat(48),port:0});
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

test('plugin desktop activation is independent of the host control backend and OS changes rebuild environments', async t=>{
  const f=await fixture(t);await plugin(f,'host-aware',{cardbush:{runtime:{requires:['desktop']}}});
  const host={platform:'win32',capabilities:{desktop:false}};
  const receiver=new AgentSharedConfiguration(f.remote,f.bundled,()=>{},async()=>({applicationState:'applied'}),host);
  const archive=await f.pack(), call=input=>receiver.call(input);
  await sendSharedConfiguration(call,archive);
  const enabled=async()=>JSON.parse(await readFile(join(f.remote,'config','apps.json'))).plugins.find(p=>p.id==='host-aware').enabled;
  assert.equal(await enabled(),true);
  host.capabilities.desktop=true;assert.equal(await call({action:'status'}),null);
  await sendSharedConfiguration(call,archive);assert.equal(await enabled(),true);
  const environment=join(f.remote,'plugins','host-aware','.venv');await mkdir(environment);await writeFile(join(environment,'windows'),'generated');
  host.platform='linux';
  await sendSharedConfiguration(call,await packSharedConfiguration(f.payload,f.local,{syncPlugins:false}));
  await sendSharedConfiguration(call,archive);
  assert.equal(await stat(environment).then(()=>true,()=>false),false,'a prior config-only sync cannot mark Windows dependencies portable');
});
