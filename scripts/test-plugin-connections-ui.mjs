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
import '${local('src/styles/app.css')}';
import '${local('src/styles/themes/cyberpunk.css')}';
const plugin=(id,name,component,source='bundled')=>({id,name,source,description:name+' tools',longDescription:'',category:'Tools',keywords:[],capabilities:[],defaultPrompts:[],config:{},installed:true,enabled:true,brandColor:'#74d2f7',components:[{kind:'mcp',id:component,name,description:'MCP service'}]});
window.fixtureApps={serviceEnabled:true,plugins:[plugin('computer-use','Computer Use','cardbush_apps'),plugin('chrome','Chrome','chrome-devtools'),plugin('personal.tools','Personal Tools','echo','user')]};
window.fixtureOverview={revision:2,servers:[{id:'blender',name:'Blender MCP',description:'Blender tools',enabled:true,transport:'stdio'}],snapshot:{protocol:'bush.mcp_snapshot_result.v1',snapshotId:'cardbush-product-mcp',revision:2000001,configurationRevision:2,applicationState:'applied',servers:[{id:'blender',health:'ready',tools:Array.from({length:26},(_,i)=>({remoteName:'tool'+i,runtimeName:'mcp__blender__tool'+i}))}]}};
window.fixtureReads=0;window.fixtureFailure=false;window.listeners=new Set();window.opened=[];
window.cardbushDesktop={onCapabilityCatalogChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}};
window.fixtureCommands=[{id:'native-demo:review',description:'原生命令审查',argumentHint:'[file] [mode]'}];window.sentCommands=[];
window.cardbushDesktop.pluginCommands=async()=>fixtureCommands;
window.marketSources=[{id:'builtin',kind:'local',location:'bundled',builtin:true}];
window.marketInstalls=0;window.marketSaveFails=false;window.marketSlow=false;window.marketCached=false;window.marketAddFails=false;
Object.assign(window.cardbushDesktop,{
 pluginMarketSources:async()=>marketSources,
 addPluginMarket:async value=>{if(marketAddFails)throw Error("Error invoking remote method 'plugins:market-add': Error: net::ERR_CONNECTION_RESET");const source={id:'remote',kind:'github',location:value,ref:'HEAD'};marketSources.push(source);return source},
 removePluginMarket:async id=>{marketSources=marketSources.filter(source=>source.id!==id)},
 pluginMarketCatalog:async id=>({source:marketSources.find(source=>source.id===id),name:id,displayName:id==='builtin'?'CardBush 精选':'示例市场',fetchedAt:'2026-09-09',cached:marketCached,error:marketCached?'fixture offline':undefined,entries:id==='builtin'?[{name:'chrome',description:'Browser',category:'Tools',available:true}]:[
 {name:'claude-example',description:'Claude Skills 与 MCP',category:'Tools',available:true},
 {name:'hook-example',description:'依赖 Hooks 的插件',category:'Tools',available:true},
 {name:'unavailable',description:'发布者未开放安装',category:'Tools',available:false,unavailableReason:'policy'}]}),
 previewMarketPlugin:async(id,name)=>{const value={token:'token-'+name,id:name,name,description:'示例插件',version:'1.0.0',developerName:'Fixture',source:'https://github.com/fixture/plugins',revision:'a'.repeat(40),format:'claude',components:[{kind:'skill',name:'Example',description:'示例技能'},{kind:'mcp',name:'Echo',description:'MCP service'}],requirements:['node'],issues:name==='hook-example'?[{code:'components',detail:'hooks'}]:[],updating:false};if(marketSlow)return new Promise(resolve=>{window.finishMarketPreview=()=>resolve(value)});return value},
 installMarketPlugin:async token=>{marketInstalls++;fixtureApps={...fixtureApps,plugins:[...fixtureApps.plugins,plugin('claude-example','Claude Example','echo','user')]};return{id:'claude-example',manifestPath:'fixture'}},
});
window.refreshFixture=()=>{for(const fn of listeners)fn()};
const props={language:'zh',initialTab:'plugins',skills:[],disabledSkillNames:new Set(),onToggleSkill:()=>{},onReloadSkills:async()=>[],onLoadSkillDetail:async()=>null,onOpenMcp:id=>opened.push(id??'new'),onOpenNetwork:()=>opened.push('proxy'),onNotify:()=>{}};
function Fixture(){const [composer,setComposer]=React.useState(false);const [draft,setDraft]=React.useState('');window.showComposer=()=>setComposer(true);return <div className="app theme-cyberpunk" style={{minWidth:0,width:'100%',height:'100vh',overflow:'auto'}}><main style={{padding:26,width:'100%',boxSizing:'border-box'}}>{composer?<Composer language="zh" draft={draft} onDraftChange={setDraft} sending={false} selectedModel="fixture" availableModels={[{id:'fixture',name:'Fixture',model:'fixture',enabled:true}]} referencePlanAvailable={false} referencePlanMode="off" permissionMode="task_free" subagentPermissionRouting="parent" reasoningLevelAvailable={false} reasoningLevel="medium" reasoningLevels={[]} onModelChange={()=>{}} onReferencePlanModeChange={()=>{}} onPermissionModeChange={()=>{}} onSubagentPermissionRoutingChange={()=>{}} onReasoningLevelChange={()=>{}} onSend={async text=>{sentCommands.push(text);setDraft('')}} onCancel={async()=>{}} disabledSkillNames={new Set()} visualInputAvailable={false} visualInputEnabled={false} onConfigureModels={()=>{}} onToggleSkill={()=>{}} onVisualInputEnabledChange={()=>{}}/>:<PluginManagementPanel {...props}/>}</main></div>}
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
try {
  const result = await build({configFile:false,logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'},plugins:[{
    name:'plugin-connections-fixture',enforce:'pre',
    resolveId(id,importer){
      if(id.endsWith('__plugin_connections_fixture__.tsx'))return '\0plugin-fixture.tsx';
      if(id==='../../backend/api'&&importer?.endsWith('PluginManagementPanel.tsx'))return '\0plugin-fixture-api';
    },
    load(id){
      if(id==='\0plugin-fixture.tsx')return source;
      if(id==='\0plugin-fixture-api')return `
        export async function fetchCardbushAppsConfiguration(){return window.fixtureApps;}
        export async function saveCardbushAppsConfiguration(value){if(window.marketSaveFails)throw Error('fixture activation failed');window.fixtureApps=value;return value;}
        export async function fetchMcpConnectionOverview(){window.fixtureReads++;if(window.fixtureFailure)throw Error('fixture offline');return window.fixtureOverview;}
      `;
    },
  }],build:{outDir:directory,emptyOutDir:true,minify:false,lib:{entry:resolve('__plugin_connections_fixture__.tsx'),formats:['iife'],name:'PluginFixture'}}});
  const outputs=(Array.isArray(result)?result:[result]).flatMap(item=>item.output);
  const entry=outputs.find(item=>item.type==='chunk'&&item.isEntry);
  const css=outputs.filter(item=>item.type==='asset'&&item.fileName.endsWith('.css'));
  await writeFile(join(directory,'index.html'),`<!doctype html><html><head><meta charset="utf-8">${css.map(item=>`<link rel="stylesheet" href="${item.fileName}">`).join('')}</head><body><div id="root"></div><script src="${entry.fileName}"></script></body></html>`);
  const require=createRequire(import.meta.url),env={...process.env};
  delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
  const run=spawnSync(require('electron'),['scripts/test-plugin-connections-ui-worker.cjs',directory],{env,windowsHide:true,stdio:'inherit',timeout:30000});
  assert.equal(run.status,0,String(run.error??'Plugin UI fixture failed'));
} finally {
  assert.ok(directory.startsWith(parent+sep+'plugin-connections-ui-'));
  await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
