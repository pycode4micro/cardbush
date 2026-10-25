import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { AgentSharedConfiguration, packSharedConfiguration, sendSharedConfiguration, recoverSharedConfiguration } from '../dist-electron/agentSharedConfiguration.mjs';
import { ProductModelConfigStore, ProductMcpConfigStore } from '../packages/cardbush-product-host/dist/index.js';
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
  return {root,local,remote,bundled,payload,receiver,pack:()=>packSharedConfiguration(payload,local),call:input=>receiver.call(input),get refreshes(){return refreshes;},set active(v){active=v;},set fail(v){fail=v;}};
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
    await assert.rejects(manager.call(connection.id, 'chat.send', { sessionId: 'new', requestId: randomUUID(), text: 'test' }), /Update the Agent service/);
  } finally { await manager?.close();await server?.close();await service.close(); }
});

test('settings archive never reads plugin roots, states or MCP credentials, including old opt-in options', async t => {
  const f = await fixture(t);
  for (const key of ['roots', 'apps', 'mcp']) Object.defineProperty(f.payload, key, {
    get() { throw Error('Retired plugin export was accessed: ' + key); }, enumerable: true,
  });
  const archive = await packSharedConfiguration(f.payload, f.local, { syncPlugins: true, syncSkills: true });
  const payload = JSON.parse(gunzipSync(archive.data));
  assert.equal(payload.syncPlugins, false);
  assert.deepEqual(payload.packages, []); assert.deepEqual(payload.roots, []);
  assert.deepEqual(payload.apps, {}); assert.deepEqual(payload.mcp, {});
  assert.equal(archive.packages, undefined);
  assert.deepEqual(archive, await f.pack());
  await sendSharedConfiguration(f.call, archive);
  assert.equal(await readFile(join(f.remote, 'AGENTS.md'), 'utf8'), 'Shared rules.');
});

test('shared settings preserve target plugins, enabled state, dependencies, connections and standalone skills across restart', async t => {
  const f = await fixture(t);
  const preserved = {
    'plugins/custom/plugin.json': '{"name":"custom","version":"1.0.0"}',
    'plugins/custom/.venv/ready': 'target-only-environment',
    'skills/custom/SKILL.md': 'Target instructions',
    'config/apps.json': JSON.stringify({ revision: 9, plugins: [{ id: 'custom', installed: true, enabled: true, config: { token: 'target-token' } }] }),
    'config/mcp-servers.json': await readFile(join(f.remote, 'config/mcp-servers.json'), 'utf8'),
  };
  for (const [path, value] of Object.entries(preserved)) {
    await mkdir(join(f.remote, path, '..'), { recursive: true });
    await writeFile(join(f.remote, path), value);
  }
  f.payload.models.models[0].apiProtocol = 'anthropic_messages';
  f.payload.models.models[0].defaultHeaders = { 'x-session-id': '{{sessionId}}' };
  f.payload.apps.plugins = [{ id: 'custom', installed: false, enabled: false, config: { token: 'source-token' } }];
  const archive = await f.pack();
  assert.doesNotMatch(gunzipSync(archive.data).toString(), /source-token|target-token/);
  const requests = [];
  await sendSharedConfiguration(input => { requests.push(input); return f.call(input); }, archive);
  assert.ok(requests.every(input => input.action !== 'packages' && input.kind !== 'package'));
  const models = await new ProductModelConfigStore(join(f.remote, 'config/models.json')).read();
  assert.equal(models.models[0].apiKey, 'fixture-secret');
  assert.equal(models.models[0].apiProtocol, 'anthropic_messages');
  assert.deepEqual(models.models[0].defaultHeaders, { 'x-session-id': '{{sessionId}}' });
  for (const name of ['network', 'sandbox']) assert.deepEqual(JSON.parse(await readFile(join(f.remote, 'config', name + '.json'), 'utf8')), f.payload[name]);
  for (const [path, value] of Object.entries(preserved)) assert.equal(await readFile(join(f.remote, path), 'utf8'), value);
  const restarted = new AgentSharedConfiguration(f.remote, f.bundled, () => {}, async () => assert.fail('unchanged settings must not apply again'));
  assert.equal((await restarted.call({ action: 'status' })).digest, archive.digest);
  await writeFile(join(f.remote, 'plugins/custom/plugin.json'), 'independently updated plugin');
  await writeFile(join(f.remote, 'skills/custom/SKILL.md'), 'independently updated skill');
  await sendSharedConfiguration(input => restarted.call(input), archive);
  f.payload.instructions = 'New shared rules';
  await sendSharedConfiguration(f.call, await f.pack());
  assert.equal(await readFile(join(f.remote, 'plugins/custom/plugin.json'), 'utf8'), 'independently updated plugin');
  assert.equal(await readFile(join(f.remote, 'skills/custom/SKILL.md'), 'utf8'), 'independently updated skill');
  assert.equal(await readFile(join(f.remote, 'config/apps.json'), 'utf8'), preserved['config/apps.json']);
});

test('legacy package upload and cache discovery fail closed before writing any files', async t => {
  const f = await fixture(t), before = await readdir(f.remote);
  for (const input of [
    { action: 'packages', digests: ['a'.repeat(64)] },
    { action: 'begin', digest: 'b'.repeat(64), size: 100, kind: 'package' },
  ]) await assert.rejects(f.call(input), /cardbush-docs/);
  await assert.rejects(f.call({ action: 'chunk', digest: 'b'.repeat(64), offset: 0, data: 'YQ==' }), /expired/);
  await assert.rejects(sendSharedConfiguration(() => assert.fail('must not send legacy packages'), {
    ...await f.pack(), packages: [{ digest: 'a'.repeat(64), root: f.local }],
  }), /cardbush-docs/);
  assert.deepEqual(await readdir(f.remote), before);
  assert.equal(f.refreshes, 0);
});

for (const field of ['switch', 'package', 'skill', 'state']) test(`legacy ${field} payload cannot install files or change plugin state`, async t => {
  const f = await fixture(t), archive = await f.pack();
  await sendSharedConfiguration(f.call, archive);
  const before = await readFile(join(f.remote, 'config/models.json'));
  const payload = JSON.parse(gunzipSync(archive.data));
  payload.instructions = 'This must not be applied';
  if (field === 'switch') payload.syncPlugins = true;
  if (field === 'package') payload.packages = [{ path: 'plugins/injected', pluginId: 'injected', digest: 'f'.repeat(64) }];
  if (field === 'skill') payload.packages = [{ path: 'skills/injected', digest: 'f'.repeat(64) }];
  if (field === 'state') payload.apps = { plugins: [{ id: 'injected', installed: true, enabled: true }] };
  const data = gzipSync(JSON.stringify(payload));
  await assert.rejects(sendSharedConfiguration(f.call, { data, digest: digest(data) }), /cardbush-docs/);
  assert.equal(f.refreshes, 1);
  assert.deepEqual(await readFile(join(f.remote, 'config/models.json')), before);
  assert.equal(await readFile(join(f.remote, 'AGENTS.md'), 'utf8'), 'Shared rules.');
  assert.equal(await stat(join(f.remote, 'plugins')).then(() => true, () => false), false);
  assert.equal(await stat(join(f.remote, 'skills')).then(() => true, () => false), false);
  assert.equal((await f.call({ action: 'status' })).digest, archive.digest);
});

test('multi-chunk settings transfer keeps legacy standalone MCP entries isolated', async t => {
  const f = await fixture(t);
  f.payload.instructions = randomBytes(650_000).toString('base64');
  const payload = JSON.parse(gunzipSync((await f.pack()).data));
  payload.mcp = { servers: [{ id: 'source-only', transport: 'stdio', command: 'source-machine.exe' }] };
  const data = gzipSync(JSON.stringify(payload)), calls = [];
  assert.ok(data.length > 512 * 1024);
  await sendSharedConfiguration(input => { calls.push(input); return f.call(input); }, { data, digest: digest(data) });
  assert.equal(calls.filter(input => input.action === 'chunk').length, 2);
  assert.equal(await readFile(join(f.remote, 'AGENTS.md'), 'utf8'), f.payload.instructions);
  assert.deepEqual(JSON.parse(await readFile(join(f.remote, 'config/mcp-servers.json'), 'utf8')).servers, []);
});

test('legacy auto-sync connection flags are discarded on reconnect and cannot be re-enabled by a stale client', async t => {
  const { AgentService } = await import('../dist-electron/agentService.mjs');
  const { serveAgentHttp } = await import('../dist-electron/agentServer.mjs');
  const { AgentConnectionManager } = await import('../dist-electron/agentConnections.mjs');
  const f = await fixture(t), file = join(f.local, 'connections.json');
  const service = await AgentService.open({ dataRoot: f.remote, bundledRoot: f.bundled });
  let server, manager;
  try {
    server = await serveAgentHttp(service, { token: 's'.repeat(48), port: 0 });
    const old = { id: randomUUID(), name: 'Existing', transport: 'http', url: 'http://127.0.0.1:' + server.port,
      token: 's'.repeat(48), autoSyncPlugins: true, excludedPluginIds: [], syncSkills: true };
    await writeFile(file, JSON.stringify([old]));
    const observed = [];
    manager = new AgentConnectionManager(file, { encrypt: v => v, decrypt: v => v }, {
      sharedConfiguration: async (...args) => { observed.push(args); return f.pack(); },
    });
    assert.equal(manager.syncCatalog, undefined); assert.equal(manager.syncConfiguration, undefined);
    for (const key of ['autoSyncPlugins', 'excludedPluginIds', 'syncSkills']) assert.equal(key in (await manager.list())[0], false);
    await manager.connect(old.id);
    assert.equal(observed.length, 0, 'connecting alone does not package anything');
    await manager.call(old.id, 'conversation.catalog');
    assert.deepEqual(observed, [[]]);
    const saved = JSON.parse(await readFile(file, 'utf8'))[0];
    for (const key of ['autoSyncPlugins', 'excludedPluginIds', 'syncSkills']) assert.equal(key in saved, false);
    assert.equal(saved.id, old.id); assert.equal(saved.token, old.token); assert.equal(saved.agentId, service.info().id);
    await assert.rejects(manager.save({ id: old.id, name: old.name, transport: 'http', url: old.url, autoSyncPlugins: true }));
    await manager.save({ id: old.id, name: 'Renamed', transport: 'http', url: old.url });
    await manager.call(old.id, 'product.command', { kind: 'models.get' });
    assert.ok(observed.every(args => args.length === 0));
    assert.equal(await stat(join(f.remote, 'plugins')).then(() => true, () => false), false);
  } finally { await manager?.close(); await server?.close(); await service.close(); }
});

test('upgrade still recovers interrupted legacy plugin, skill and configuration replacements', async t => {
  const f = await fixture(t), id = randomUUID();
  const mcp = JSON.parse(await readFile(join(f.remote, 'config/mcp-servers.json'), 'utf8'));
  const paths = ['plugins/old/plugin.json', 'skills/old/SKILL.md', 'config/apps.json', 'config/mcp-servers.json'];
  const entries = [];
  for (const path of paths) {
    const content = path.endsWith('mcp-servers.json') ? JSON.stringify({ ...mcp, revision: 3 }) : 'original ' + path;
    const backup = join(f.remote, 'shared-configuration/backups', id, path);
    const target = join(f.remote, path);
    await mkdir(join(backup, '..'), { recursive: true }); await writeFile(backup, content);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, path.endsWith('mcp-servers.json') ? JSON.stringify({ ...mcp, revision: 7 }) : 'replacement');
    const entryPath = path.startsWith('config/') ? path : path.split('/').slice(0, 2).join('/');
    entries.push({ path: entryPath, existed: true });
  }
  await writeFile(join(f.remote, 'shared-configuration/transaction.json'), JSON.stringify({ id, entries }));
  await recoverSharedConfiguration(f.remote);
  for (const path of paths.filter(path => !path.endsWith('mcp-servers.json'))) assert.equal(await readFile(join(f.remote, path), 'utf8'), 'original ' + path);
  assert.equal(JSON.parse(await readFile(join(f.remote, 'config/mcp-servers.json'), 'utf8')).revision, 8);
  assert.equal(await stat(join(f.remote, 'shared-configuration/transaction.json')).then(() => true, () => false), false);
});
