import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { get } from 'node:http';
import { z } from 'zod';
import { createCardbushAppsServer } from '@cardbush/apps-mcp';
import { McpServer } from '@modelcontextprotocol/server';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startDesktopMcpServer } from '../dist-electron/desktopMcpServer.mjs';
import { readAgentDesktopBridge, agentDesktopBridgeTransport, inspectAgentDesktopBridge, syncAgentDesktopBridgePolicy, readAgentDesktopBridgePolicy } from '../dist-electron/agentDesktopBridge.mjs';
import { probeAgentDesktop } from '../dist-electron/agentDesktopProbe.mjs';
import { AgentService } from '../dist-electron/agentService.mjs';
const base = resolve('tmp/agent-desktop-bridge-tests');
async function fixture(t) {
  await mkdir(base,{recursive:true}); const root=await mkdtemp(join(base,'case-'));
  t.after(async()=>{assert.ok(resolve(root).startsWith(base+sep));await rm(root,{recursive:true,force:true,maxRetries:3});});
  return root;
}
const setup={state:'needs_setup',environment:'ready',backend:'not_configured',checkedAt:new Date().toISOString(),checks:[{id:'windows_session',state:'ok',code:'1'}],summary:'fixture desktop',remediation:[]};
async function bridge(t, state = ()=>setup, existing) {
  const calls=[]; const token=existing?.token??randomBytes(32).toString('hex');
  const config={protocol:'cardbush.agent.desktop-bridge.v1',agentId:'fixture-agent',port:0,token,...existing};
  const server=await startDesktopMcpServer(()=>{
    const mcp=new McpServer({name:'cardbush_apps',version:'0.1.0'});
    mcp.registerTool('computer_use',{inputSchema:z.object({action:z.string()})},async(input,context)=>{
      calls.push({input,meta:context.mcpReq._meta});
      return {content:[{type:'text',text:JSON.stringify({fixture:true,input})}]};
    });return mcp;
  },{token,port:config.port,status:async()=>({agentId:config.agentId,setup:state()})});
  t.after(()=>server.close());
  config.port=Number(new URL(server.url).port);
  return {server,calls,config};
}

test('bridge configuration is isolated by Agent, accepts only loopback ports and redacts invalid secrets',async t=>{
  const root=await fixture(t),path=join(root,'bridge.json'),token=randomBytes(32).toString('hex');
  assert.equal(readAgentDesktopBridge(path,'a'),undefined);
  const valid={protocol:'cardbush.agent.desktop-bridge.v1',agentId:'a',port:4782,token};
  for(const value of [{...valid,agentId:'b'},{...valid,port:80},{...valid,port:65536},{...valid,port:4782.2},
    {...valid,token:'short'},{...valid,url:'https://another-machine.invalid/mcp'},null]){
    await writeFile(path,JSON.stringify(value));assert.throws(()=>readAgentDesktopBridge(path,'a'),error=>!error.message.includes(token));
  }
  await writeFile(path,JSON.stringify(valid));assert.deepEqual(readAgentDesktopBridge(path,'a'),valid);
  assert.equal(agentDesktopBridgeTransport(valid).url,'http://127.0.0.1:4782/mcp');
});

test('interactive helper retains standard MCP tool name, arguments and turn safety metadata',async t=>{
  const f=await bridge(t), client=new Client({name:'test',version:'1'});
  const transport=new StreamableHTTPClientTransport(new URL(f.server.url),{requestInit:{headers:{Authorization:`Bearer ${f.config.token}`}}});
  await client.connect(transport);t.after(()=>client.close());
  assert.deepEqual((await client.listTools()).tools.map(tool=>tool.name),['computer_use']);
  const meta={cardbush_session_id:'s',cardbush_turn_id:'t'};
  const result=await client.callTool({name:'computer_use',arguments:{action:'observe'},_meta:meta});
  assert.equal(result.isError,undefined);assert.deepEqual(f.calls,[{input:{action:'observe'},meta}]);
});

test('bridge rejects unauthenticated, browser-origin and wrong-host requests before dispatch',async t=>{
  const f=await bridge(t);
  for(const headers of [{},{Authorization:'Bearer wrong'},{Authorization:`Bearer ${f.config.token}`,Origin:'http://localhost'},
    {Authorization:`Bearer ${f.config.token}`,Host:'evil.invalid'}]){
    const status=await new Promise((resolve,reject)=>get(f.server.url,{headers},response=>{response.resume();resolve(response.statusCode);}).on('error',reject));
    assert.equal(status,403);
  }
  assert.equal(f.calls.length,0);
  assert.equal((await inspectAgentDesktopBridge(f.config)).environment,'ready');
  await assert.rejects(inspectAgentDesktopBridge({...f.config,agentId:'another-agent'}),/verified/);
});

test('desktop probe reports the helper session without using Session 0 or falsely enabling the built-in preview',async t=>{
  const root=await fixture(t);let available=true;const f=await bridge(t,()=>({...setup,environment:available?'ready':'blocked'}));
  const path=join(root,'bridge.json');await writeFile(path,JSON.stringify(f.config));
  const seams={platform:'win32',find:()=>{throw Error('must not probe the service desktop')}};
  const env={CARDBUSH_AGENT_DESKTOP_BRIDGE:path,CARDBUSH_SERVICE_ID:'fixture-agent'};
  const ready=await probeAgentDesktop(env,seams);
  assert.equal(ready.environment,'ready');assert.equal(ready.backend,'not_configured');
  assert.equal(ready.checks.find(c=>c.id==='windows_session').code,'1');
  assert.equal(ready.checks.find(c=>c.id==='interactive_mcp_bridge').state,'ok');
  available=false;assert.equal((await probeAgentDesktop(env,seams)).environment,'blocked');
  await f.server.close();f.server.close=async()=>{};
  assert.equal((await probeAgentDesktop(env,seams)).state,'probe_failed');
});

test('Agent uses the installed bridge through existing MCP permissions and never launches a Session 0 fallback',async t=>{
  const root=await fixture(t), f=await bridge(t);
  await mkdir(join(root,'config'));await mkdir(join(root,'desktop-bridge'));
  // Let the service allocate its normal identity, then install its bridge and reopen.
  let service=await AgentService.open({dataRoot:root,bundledRoot:resolve('assets'),toolsEnabled:false});
  const id=service.info().id;await service.close();
  f.config.agentId=id;
  await writeFile(join(root,'desktop-bridge','connection.json'),JSON.stringify({...f.config,agentId:id}));
  await writeFile(join(root,'config','apps.json'),JSON.stringify({protocol:'cardbush.apps.config.v1',revision:1,serviceEnabled:true,
    plugins:[{id:'computer-use',installed:true,enabled:true,config:{screenshotDirectory:'',allowOpenApp:true,allowWindowClose:true,yieldToUser:true,restorePointer:true}}]}));
  service=await AgentService.open({dataRoot:root,bundledRoot:resolve('assets')});
  try {
  let snapshot;
  for(let i=0;i<100;i++){
    snapshot=(await service.call('mcp.list',{})).runtime;
    if(snapshot.servers?.some(server=>server.id==='cardbush_apps'&&server.health==='ready'))break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  const server=snapshot.servers.find(server=>server.id==='cardbush_apps');
  assert.equal(server.health,'ready',JSON.stringify(snapshot));assert.deepEqual(server.tools.map(tool=>tool.remoteName),['computer_use']);
  assert.equal(service.info().capabilities.desktop,false);
  const desktop=await service.call('desktop.status');
  assert.equal(desktop.available,false,'the built-in preview still requires its own backend');
  assert.equal(desktop.setup.checks.find(c=>c.id==='windows_session').code,'1');
  assert.equal(desktop.setup.checks.find(c=>c.id==='interactive_mcp_bridge').state,'ok');
  assert.equal(f.calls.length,0,'catalog discovery does not capture or input');
  await f.server.close();
  await service.call('runtime.command',{kind:'runtime.mcp_reconnect',payload:{serverId:'cardbush_apps'}});
  let offline;
  for(let i=0;i<100;i++){
    offline=(await service.call('mcp.list',{})).runtime.servers.find(server=>server.id==='cardbush_apps');
    if(offline.updateState==='failed' || offline.health==='unavailable')break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.ok(offline.updateState==='failed' || offline.health==='unavailable',JSON.stringify(offline));
  t.mock.timers.enable({apis:['Date'],now:Date.now()+31000});
  assert.equal((await service.call('desktop.status')).setup.state,'probe_failed');
  await bridge(t,()=>setup,f.config);
  t.mock.timers.tick(31000);
  assert.equal((await service.call('desktop.status')).setup.environment,'ready');
  let recovered;
  for(let i=0;i<100;i++){
    recovered=(await service.call('mcp.list',{})).runtime.servers.find(server=>server.id==='cardbush_apps');
    if(recovered.health==='ready')break;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  assert.equal(recovered.health,'ready','login after service startup must restore discovery without replaying a tool');
  } finally { await service.close(); }
});

test('installer and helper preserve a separate limited interactive logon and native resource guard',async()=>{
  const installer=await readFile('deploy/agent/install-windows-desktop.ps1','utf8');
  assert.match(installer,/-LogonType Interactive -RunLevel Limited/);
  assert.match(installer,/-WindowStyle Hidden/);assert.doesNotMatch(installer,/-RunLevel Highest|-Password|sc\.exe.*config|schtasks.*\/RP/);
  const helper=await readFile('electron/agentInteractiveDesktopCli.mts','utf8');
  assert.match(helper,/verifyProcessResourceHost/);assert.match(helper,/runResourceManagedCommand/);
  assert.match(helper,/lifetime: 'service'/);assert.match(helper,/setup.environment !== 'ready'/);
});

test('policy projection follows config replacement and excludes every unrelated plugin or credential',async t=>{
  const root=await fixture(t),bridge=join(root,'connection.json'),apps=join(root,'host-apps.json');
  assert.throws(()=>readAgentDesktopBridgePolicy(join(root,'apps.json')), {code:'ENOENT'});
  const value={serviceEnabled:true,plugins:[{id:'other',config:{apiKey:'private-key'}},
    {id:'computer-use',installed:true,enabled:true,config:{allowOpenApp:true,allowWindowClose:false,unknownSecret:'do-not-share'}}]};
  await writeFile(apps,JSON.stringify(value));syncAgentDesktopBridgePolicy(bridge,apps);
  let policy=await readFile(join(root,'apps.json'),'utf8');assert.doesNotMatch(policy,/private-key|do-not-share|other/);
  assert.equal(JSON.parse(policy).plugins[0].config.allowWindowClose,false);
  assert.equal(readAgentDesktopBridgePolicy(join(root,'apps.json')).computerUse.enabled,true);
  value.plugins[1].enabled=false;await writeFile(apps,JSON.stringify(value));syncAgentDesktopBridgePolicy(bridge,apps);
  policy=JSON.parse(await readFile(join(root,'apps.json'),'utf8'));assert.equal(policy.plugins[0].enabled,false);
  assert.equal(readAgentDesktopBridgePolicy(join(root,'apps.json')).computerUse.enabled,false);
  await writeFile(join(root,'apps.json'),'{}');assert.throws(()=>readAgentDesktopBridgePolicy(join(root,'apps.json')),/policy/);
});

test('the existing MCP connection obeys an updated disable policy without executing desktop input',async t=>{
  const root=await fixture(t), policy=join(root,'apps.json');
  const config={serviceEnabled:true,plugins:[{id:'computer-use',installed:true,enabled:true,
    config:{screenshotDirectory:'',allowOpenApp:false,allowWindowClose:false,yieldToUser:true,restorePointer:true}}]};
  await writeFile(policy,JSON.stringify(config));
  const server=await startDesktopMcpServer(()=>createCardbushAppsServer(readAgentDesktopBridgePolicy(policy)));
  const client=new Client({name:'policy-test',version:'1'});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url),{requestInit:{headers:{Authorization:`Bearer ${server.token}`}}}));
    assert.equal((await client.listTools()).tools.length,1);
    config.plugins[0].enabled=false;await writeFile(policy,JSON.stringify(config));
    await assert.rejects(client.listTools(),{code:-32601});
    await assert.rejects(client.callTool({name:'computer_use',arguments:{action:'observe'}}),{code:-32601});
  } finally { await client.close();await server.close(); }
});
