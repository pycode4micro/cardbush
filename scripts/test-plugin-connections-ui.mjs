import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const parent = resolve('tmp');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'plugin-connections-ui-'));
const local = file => resolve(file).replaceAll('\\', '/');
const source = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import {PluginManagementPanel} from '${local('src/features/plugins/PluginManagementPanel.tsx')}';
import {Composer} from '${local('src/features/composer/Composer.tsx')}';
import {MessageBubble} from '${local('src/features/chatMessages/MessageBubble.tsx')}';
import {McpUserRequests} from '${local('src/features/plugins/McpUserRequests.tsx')}';
import {accountProviders,openAiAccountSummary} from '${local('electron/accountManager.mts')}';
import '${local('src/styles/app.css')}';
import '${local('src/styles/themes/cyberpunk.css')}';
const plugin=(id,name,component,source='bundled')=>({id,name,source,version:'1.0.0',manifestPath:'C:/Fixture Plugins/'+id+'/.codex-plugin/plugin.json',description:name+' tools',longDescription:'',category:'Tools',keywords:id==='personal.tools'?['个人工具']:[],capabilities:[],defaultPrompts:['查看当前状态并说明结果'],config:{},installed:true,enabled:true,brandColor:'#74d2f7',components:[{kind:'mcp',id:component,name,description:'MCP service'}]});
window.fixtureApps={revision:1,serviceEnabled:true,plugins:[plugin('computer-use','Computer Use','cardbush_apps'),plugin('chrome','Chrome','chrome-devtools'),plugin('personal.tools','Personal Tools','echo','user')]};
window.fixtureApps.plugins[1].components[0].name='Chrome Devtools';
for(const plugin of window.fixtureApps.plugins)plugin.logoPath='C:/Fixture Icons/'+plugin.id+'.svg';
window.fixtureApps.plugins[1].components.push({kind:'app',id:'chrome',name:'Chrome',description:'Registered MCP connection',mcp:{registeredAppId:'cardbush_chrome'}});
window.fixtureApps.plugins[2].components[0].mcp={transport:'http',url:'https://fixture.invalid/mcp'};
window.fixtureApps.plugins[2].components.push(...['command','prompt'].map((type,index)=>({kind:'hook',id:'hook-'+type,name:type==='command'?'SessionStart':'Stop',description:'Hook fixture',hook:{definitionHash:'hash-'+index,definition:{event:type==='command'?'SessionStart':'Stop',handler:{type,command:'echo reviewed'}},executable:type==='command'}})));
window.fixtureOverview={revision:2,servers:[{id:'blender',name:'Blender MCP',description:'Blender tools',enabled:true,transport:'stdio'}],snapshot:{protocol:'bush.mcp_snapshot_result.v1',snapshotId:'cardbush-product-mcp',revision:2000001,configurationRevision:2,applicationState:'applied',servers:[{id:'blender',health:'ready',tools:Array.from({length:26},(_,i)=>({remoteName:'tool'+i,runtimeName:'mcp__blender__tool'+i}))}]}};
window.fixtureOverview.snapshot.servers.push({id:'chrome_devtools',health:'ready',tools:Array.from({length:15},(_,i)=>({remoteName:'tool'+i,runtimeName:'mcp__chrome_devtools__tool'+i}))});
window.fixtureReads=0;window.fixtureFailure=false;window.listeners=new Set();window.opened=[];window.externalUrls=[];window.externalOpenFails=false;
window.cardbushDesktop={onCapabilityCatalogChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},openExternal:async url=>{if(externalOpenFails)throw Error('fixture browser unavailable');externalUrls.push(url)}};
window.localInstalls=[];window.localNotifications=[];
window.cardbushDesktop.installLocalPlugin=kind=>new Promise((resolve,reject)=>{localInstalls.push(kind);window.finishLocalInstall=resolve;window.failLocalInstall=reject});
window.accountStatus={state:'signed_out',experimental:true};window.accountListeners=new Set();window.accountActions=[];window.accountFailure=false;window.deferCancelledAccount=false;
window.publishAccount=state=>{accountStatus={state,experimental:true};for(const fn of accountListeners)fn()};
Object.assign(window.cardbushDesktop,{
 openAiAccountStatus:async()=>structuredClone(accountStatus),
 onOpenAiAccountChanged:fn=>{accountListeners.add(fn);return()=>accountListeners.delete(fn)},
 openAiAccountAction:async action=>{accountActions.push(action);if(accountFailure)throw Error('OpenAI fixture unavailable');
  if(action==='login'){publishAccount('signing_in');await new Promise((resolve,reject)=>{window.finishOpenAiLogin=resolve;window.failOpenAiLogin=()=>reject(Error('late account failure'))});}
  if(action==='cancel_login'){publishAccount('signed_out');if(!deferCancelledAccount)window.finishOpenAiLogin?.();}
  if(action==='logout')publishAccount('signed_out');return structuredClone(accountStatus);},
});
Object.assign(window.cardbushDesktop,{
 accountsSnapshot:async()=>({providers:accountProviders,accounts:[openAiAccountSummary(accountStatus)],errors:[]}),
 onAccountsChanged:fn=>{accountListeners.add(fn);return()=>accountListeners.delete(fn)},
 accountsAction:async command=>{if(command.providerId!=='openai'||command.accountId!=='openai:default')throw Error('Wrong account');await window.cardbushDesktop.openAiAccountAction(command.action);return window.cardbushDesktop.accountsSnapshot()},
});
window.fixtureCommands=[{id:'native-demo:review',description:'原生命令审查',argumentHint:'[file] [mode]'}];window.sentCommands=[];
window.cardbushDesktop.pluginCommands=async()=>fixtureCommands;
window.mcpRequests=[];window.mcpAnswers=[];window.mcpListeners=new Set();window.authCalls=[];window.authUrls=[];window.fixtureLoginError=false;window.fixtureReconnectWait=false;
Object.assign(window.cardbushDesktop,{
 savePluginConnections:async({pluginId,expectedRevision,connections,secrets})=>{if(window.marketSaveFails)throw Error('fixture activation failed');if(expectedRevision!==fixtureApps.revision)throw Error('revision conflict');const saved=structuredClone(connections);for(const [name,secret] of Object.entries(secrets??{})){saved[name]??={};saved[name].oauth??={};if(secret===null)delete saved[name].oauth.clientSecretRef;else saved[name].oauth.clientSecretRef='a'.repeat(64);}fixtureApps={...fixtureApps,revision:fixtureApps.revision+1,plugins:fixtureApps.plugins.map(item=>item.id===pluginId?{...item,config:{...item.config,mcp_servers:saved}}:item)};return{saved:true,configurationRevision:fixtureApps.revision,connections:saved}},
 mcpRequests:async()=>window.mcpRequests,
 onMcpRequestsChanged:fn=>{mcpListeners.add(fn);return()=>mcpListeners.delete(fn)},
 answerMcpRequest:async(id,answer)=>{mcpAnswers.push({id,answer});window.mcpRequests=window.mcpRequests.filter(item=>item.id!==id);for(const fn of mcpListeners)fn();return true},
 openMcpRequestUrl:async id=>authUrls.push(id),
 mcpConnectionAction:async(id,action)=>{authCalls.push({id,action});if(action==='reconnect'&&fixtureReconnectWait)return new Promise((resolve,reject)=>{window.finishReconnect=resolve;window.failReconnect=()=>reject(Error('late cancelled reconnect failure'))});if(action==='login'&&fixtureLoginError){fixtureOverview={...fixtureOverview,snapshot:{...fixtureOverview.snapshot,servers:fixtureOverview.snapshot.servers.map(server=>server.id===id?{...server,health:'configuration_required',lastError:'Client ID placeholder'}:server)}};throw Error('Client ID placeholder');}if(action==='login')return new Promise(resolve=>{window.finishLogin=resolve});if(action==='cancel_login')window.finishLogin?.();return{}},
 pluginMarketPresentation:async()=>({displayName:'',description:'',logo:'data:image/svg+xml;base64,'+btoa('<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36"><rect width="36" height="36" rx="8" fill="teal"/></svg>'),logoDark:''}),
});
window.showMcpRequests=value=>{window.mcpRequests=value;for(const fn of mcpListeners)fn()};
window.marketSources=[{id:'builtin',kind:'local',location:'bundled',builtin:true}];
window.marketInstalls=0;window.marketSaveFails=false;window.marketSlow=false;window.marketCached=false;window.marketAddFails=false;
window.marketRateLimitUntil=0;window.marketPreviewReads=0;
Object.assign(window.cardbushDesktop,{
 pluginMarketSources:async()=>marketSources,
 addPluginMarket:async value=>{if(marketAddFails)throw Error("Error invoking remote method 'plugins:market-add': Error: net::ERR_CONNECTION_RESET");const source={id:'remote',kind:'github',location:value,ref:'HEAD'};marketSources.push(source);return source},
 removePluginMarket:async id=>{marketSources=marketSources.filter(source=>source.id!==id)},
 pluginMarketCatalog:async id=>({source:marketSources.find(source=>source.id===id),name:id,displayName:id==='builtin'?'CardBush 精选':'示例市场',fetchedAt:'2026-09-09',cached:marketCached,error:marketCached?'fixture offline':undefined,entries:id==='builtin'?[{name:'chrome',description:'Browser',category:'Tools',available:true}]:[
 {name:'claude-example',description:'Claude Skills 与 MCP',category:'Tools',available:true},
 {name:'hook-example',description:'依赖 Hooks 的插件',category:'Tools',available:true},
 {name:'unavailable',description:'发布者未开放安装',category:'Tools',available:false,unavailableReason:'policy'}]}),
 previewMarketPlugin:async(id,name)=>{marketPreviewReads++;if(marketRateLimitUntil>Date.now())throw Error("Error invoking remote method 'plugins:market-preview': Error: codeload.github.com: Marketplace requests are temporarily rate limited (HTTP 429). [market-rate-limit:"+marketRateLimitUntil+"]");const value={token:'token-'+name,id:name,name,description:'示例插件',version:'1.0.0',developerName:'Fixture',source:'https://github.com/fixture/plugins',revision:'a'.repeat(40),format:'claude',components:[{kind:'skill',name:'Example',description:'示例技能'},{kind:'mcp',name:'Echo',description:'MCP service'}],requirements:['node'],issues:name==='hook-example'?[{code:'components',detail:'hooks'}]:[],updating:false};if(marketSlow)return new Promise(resolve=>{window.finishMarketPreview=()=>resolve(value)});return value},
 installMarketPlugin:async token=>{marketInstalls++;fixtureApps={...fixtureApps,plugins:[...fixtureApps.plugins,plugin('claude-example','Claude Example','echo','user')]};return{id:'claude-example',manifestPath:'fixture'}},
});
window.refreshFixture=()=>{for(const fn of listeners)fn()};
window.fixtureCatalogReads=0;window.inspectedPaths=[];
window.cardbushDesktop.inspectLocalReference=async path=>{window.inspectedPaths.push(path);return{path,name:path.split('/').at(-1),kind:'file'}};
if(location.hash==='#transcript')window.deferNextAppsRead=true;
const skill={name:'compat:manual',displayName:'手动审查',description:'检查当前修改',defaultPrompt:'请审查当前修改并说明依据。',invocationMode:'manual',path:'fixture/skills/manual/SKILL.md',source:'plugin',sourceId:'compat',sourceLabel:'Compatibility',content:'Review evidence.',packageDir:'fixture',routingHidden:true,requires:[],conflictsWith:[],companionTools:[],blockedTools:[],requiredReads:[],conditionalReads:[],resourceQuickRefs:[]};
const props={language:'zh',initialTab:'plugins',skills:[skill],disabledSkillNames:new Set(),onToggleSkill:()=>{},onReloadSkills:async()=>[skill],onLoadSkillDetail:async()=>skill,onOpenMcp:id=>opened.push(id??'new'),onOpenNetwork:()=>opened.push('proxy'),onNotify:message=>localNotifications.push(message)};
function Fixture(){const [composer,setComposer]=React.useState(false);const [draft,setDraft]=React.useState('');const [transcript,setTranscript]=React.useState(location.hash==='#transcript'?JSON.parse(sessionStorage.getItem('transcript-fixture')??'[]'):null);window.showTranscript=messages=>{sessionStorage.setItem('transcript-fixture',JSON.stringify(messages));setTranscript(messages)};window.showComposer=()=>setComposer(true);window.showPlugins=()=>setComposer(false);window.setFixtureDraft=setDraft;window.fixtureDraft=draft;
if(transcript)return <div className="app theme-dark" style={{'--accent':'#78a9ef','--text':'#ecebe5','--text-mid':'#c5c3b9','--text-soft':'#a4a195','--border':'#44433e',background:'#1e1e1b',padding:24,minHeight:'100vh',boxSizing:'border-box'}}>{transcript.map((content,index)=><MessageBubble key={index} message={{id:'fixture-user-'+index,role:'user',content,createdAt:'2026-09-11T12:00:00Z'}} language="zh" sending={false} activeTurnId="" activeAssistantMessageId="" onRegenerate={async()=>{}} onEditUserMessage={async()=>{}} onRetryGuidance={async()=>{}} onRevertChangeReport={async()=>{}} onOpenScene={()=>{}}/>)}</div>;
return <div className="app theme-cyberpunk" style={{minWidth:0,width:'100%',height:'100vh',overflow:'auto'}}><main style={{padding:26,width:'100%',boxSizing:'border-box'}}>{composer?<Composer language="zh" autoFocus draft={draft} onDraftChange={setDraft} sending={false} selectedModel="fixture" availableModels={[{id:'fixture',name:'Fixture',model:'fixture',enabled:true}]} referencePlanAvailable={false} referencePlanMode="off" permissionMode="task_free" subagentPermissionRouting="parent" reasoningLevelAvailable={false} reasoningLevel="medium" reasoningLevels={[]} onModelChange={()=>{}} onReferencePlanModeChange={()=>{}} onPermissionModeChange={()=>{}} onSubagentPermissionRoutingChange={()=>{}} onReasoningLevelChange={()=>{}} onSend={async text=>{sentCommands.push(text);setDraft('')}} onCancel={async()=>{}} disabledSkillNames={new Set()} visualInputAvailable={false} visualInputEnabled={false} onConfigureModels={()=>{}} onToggleSkill={()=>{}} onVisualInputEnabledChange={()=>{}}/>:<PluginManagementPanel {...props} onOpenPrompt={prompt=>{window.openedPrompt=prompt;setDraft(prompt);setComposer(true)}}/>}</main><McpUserRequests language="zh"/></div>}
let fixtureRoot=createRoot(document.getElementById('root'));
fixtureRoot.render(<Fixture/>);
window.remountPlugins=()=>{fixtureRoot.unmount();fixtureRoot=createRoot(document.getElementById('root'));fixtureRoot.render(<Fixture/>)};
`;
try {
  const result = await build({configFile:false,logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'},plugins:[{
    name:'plugin-connections-fixture',enforce:'pre',
    resolveId(id,importer){
      if(id.endsWith('__plugin_connections_fixture__.tsx'))return '\0plugin-fixture.tsx';
      if(id==='../../backend/api'&&/(?:Plugin(?:ManagementPanel|McpSettings)\.tsx|pluginCatalog\.ts)$/.test(importer??''))return '\0plugin-fixture-api';
    },
    load(id){
      if(id==='\0plugin-fixture.tsx')return source;
      if(id==='\0plugin-fixture-api')return `
        export async function fetchCardbushAppsConfiguration(){window.fixtureCatalogReads++;if(window.fixtureAppsFailure)throw Error('catalog offline');const value=structuredClone(window.fixtureApps);if(window.deferNextAppsRead){window.deferNextAppsRead=false;await new Promise(resolve=>window.releaseAppsRead=resolve);}return value;}
        export async function saveCardbushAppsConfiguration(value){if(window.marketSaveFails)throw Error('fixture activation failed');if(value.revision!==window.fixtureApps.revision)throw Error('revision conflict');window.fixtureApps={...value,revision:value.revision+1};if(window.proxySyncFails)throw Error('fixture runtime refresh failed');return window.fixtureApps;}
        export async function savePluginSearchResultLimit(limit){window.searchSaveCalls=(window.searchSaveCalls??0)+1;if(window.searchSaveFails)throw Error('fixture search setting failed');if(window.deferSearchSave)await new Promise(resolve=>window.finishSearchSave=resolve);window.fixtureApps={...window.fixtureApps,revision:window.fixtureApps.revision+1,searchResultLimit:limit};return structuredClone(window.fixtureApps);}
        export async function fetchMcpConnectionOverview(){window.fixtureReads++;if(window.fixtureFailure)throw Error('fixture offline');const value=structuredClone(window.fixtureOverview);if(window.fixtureReadDelay)await new Promise(resolve=>setTimeout(resolve,window.fixtureReadDelay));return value;}
        export async function setMcpServerProxy(id,proxy){if(window.proxySaveFails)throw Error('fixture proxy save failed');window.fixtureOverview={...window.fixtureOverview,servers:window.fixtureOverview.servers.map(item=>item.id===id?{...item,proxy}:item)};}
        export async function resetMcpServerProxies(){if(window.proxySaveFails)throw Error('fixture proxy save failed');window.fixtureOverview={...window.fixtureOverview,servers:window.fixtureOverview.servers.map(item=>({...item,proxy:undefined}))};}
        export async function uninstallCardbushPlugin(id){window.uninstallCalls??=[];window.uninstallCalls.push(id);if(window.uninstallFails)throw Error('fixture uninstall failed');if(window.deferUninstall)await new Promise(resolve=>window.finishUninstall=resolve);window.fixtureApps={...window.fixtureApps,revision:window.fixtureApps.revision+1,plugins:window.fixtureApps.plugins.map(plugin=>plugin.id===id?{...plugin,installed:false,enabled:false}:plugin)};return{configuration:window.fixtureApps,pending:!!window.uninstallPending||!!window.uninstallApplyError,applicationError:window.uninstallApplyError?'fixture runtime unavailable':undefined};}
      `;
    },
  }],build:{outDir:directory,emptyOutDir:true,minify:false,lib:{entry:resolve('__plugin_connections_fixture__.tsx'),formats:['iife'],name:'PluginFixture'}}});
  const outputs=(Array.isArray(result)?result:[result]).flatMap(item=>item.output);
  const entry=outputs.find(item=>item.type==='chunk'&&item.isEntry);
  const css=outputs.filter(item=>item.type==='asset'&&item.fileName.endsWith('.css'));
  await writeFile(join(directory,'index.html'),`<!doctype html><html><head><meta charset="utf-8">${css.map(item=>`<link rel="stylesheet" href="${item.fileName}">`).join('')}</head><body><div id="root"></div><script src="${entry.fileName}"></script></body></html>`);
  const require=createRequire(import.meta.url),env={...process.env};
  delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
  const run=spawnSync(require('electron'),['scripts/test-plugin-connections-ui-worker.cjs',directory],{env,windowsHide:true,stdio:'inherit',timeout:55000});
  assert.equal(run.status,0,String(run.error??'Plugin UI fixture failed'));
} finally {
  assert.ok(directory.startsWith(parent+sep+'plugin-connections-ui-'));
  await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
