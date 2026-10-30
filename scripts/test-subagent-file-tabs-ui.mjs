import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const parent = resolve('tmp');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'subagent-file-tabs-'));
const local = path => resolve(path).replaceAll('\\', '/');
// Use the real remote child host, preview, links and inspector lifecycle. The
// conversation UI/streaming suite covers the chat controller; no live service or
// user configuration is involved in this navigation regression.
const source = `
import React from 'react'; import { createRoot } from 'react-dom/client';
import { SubagentConversation } from '${local('src/features/subagents/SubagentConversation.tsx')}';
import { useInspectorTabs } from '${local('src/hooks/useInspectorTabs.ts')}';
import { InspectorTabPages } from '${local('src/features/inspector/InspectorTabPages.tsx')}';
import { ConversationInspectorContext, ConversationInspectorOutlet, useConversationInspectorActions, useConversationInspectorOutlets } from '${local('src/features/inspector/ConversationInspector.tsx')}';
import '${local('src/styles/theme.css')}'; import '${local('src/styles/app.css')}';
const now='2026-10-30T05:44:59.651Z';
window.fileCalls=[]; window.restored=false; window.missingPath='/tmp/'+'temporary-'.repeat(24)+'/missing.txt';
const noop=()=>{}, asyncNoop=async()=>{};
window.fixtureRuntime={client:{listUserPrompts:async()=>[]},dispose:noop};
window.fixtureChat={activeMessages:[],activeConversation:null,skills:[],queuedMessages:[],refreshActiveSession:asyncNoop,setSelectedModel:noop};
window.cardbushDesktop={agents:{call:async(connectionId,operation,input)=>{
  if(operation==='conversation.catalog')return {skills:[],pluginCommands:[]};
  if(operation==='product.command')return input.kind==='models.get'?{models:[],defaultModelId:''}:{plugins:[]};
  if(operation==='conversation.extracts')return {name:'extract.md',content:'# Saved extract'};
  if(operation==='files.read'){
    window.fileCalls.push({connectionId,...input});
    if(input.path.startsWith('/tmp/')&&!window.restored)throw Error("Error invoking remote method 'agents:command': Error: ENOENT: no such file or directory, realpath '"+input.path+"'");
    if(input.path==='/workspace/denied.txt')throw Error("Error invoking remote method 'agents:command': Error: File is outside this conversation workspace.");
    const text='Report from '+connectionId+' / '+input.sessionId;
    return {content:btoa(text),name:input.path.split('/').at(-1),size:text.length,offset:0,done:true};
  }
  throw Error('Unexpected operation '+operation);
}}};
const task=id=>({taskId:'task-'+id,parentSessionId:'parent',childSessionId:'child-'+id,childTurnId:'turn-'+id,
  remote:{connectionId:'remote-'+id},status:'completed',terminal:true,createdAt:now,updatedAt:now,raw:{}});
function Harness(){
  const tabs=useInspectorTabs(); const {outlets,register}=useConversationInspectorOutlets();
  const [language,setLanguage]=React.useState('zh');
  const actions=useConversationInspectorActions({open:(id,title)=>tabs.openTab({id,title,kind:'conversation'}),close:id=>tabs.disposeTabs(new Set([id]))});
  const openChild=id=>tabs.openTab({id:'child-'+id,kind:'subagent',title:'Agent '+id,detail:{task:task(id)}});
  React.useEffect(()=>{openChild('a');},[]);
  window.navigation={...tabs,setLanguage,openChild};
  return <ConversationInspectorContext.Provider value={{...actions,outlets,visible:true}}>
    <div className="app theme-dark" style={{height:'100vh',display:'flex'}}>
      <aside className="right-inspector" style={{width:'100%',flex:1}}><div className="right-inspector-content">
        <header className="right-inspector-toolbar with-tabs"><div className="right-inspector-tabs" role="tablist">
          {tabs.tabs.map(tab=><div key={tab.id} style={{display:'flex'}}><button role="tab" data-tab={tab.id} aria-selected={tab.id===tabs.activeId} onClick={()=>tabs.activateTab(tab.id)}>{tab.title}</button>
            <button data-close={tab.id} aria-label={'Close '+tab.title} onClick={()=>tabs.closeTabs(new Set([tab.id]))}>×</button></div>)}
        </div></header>
        <div className="right-inspector-body"><InspectorTabPages tabs={tabs.allTabs} activeId={tabs.activeId}>{(tab,active)=>tab.kind==='subagent'
          ?<SubagentConversation task={tab.detail.task} parentSessionId="parent" language={language} active={active} refresh={asyncNoop} refreshing={false} error=""/>
          :<ConversationInspectorOutlet id={tab.id} register={register}/>}</InspectorTabPages></div>
      </div></aside>
    </div>
  </ConversationInspectorContext.Provider>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><Harness/></React.StrictMode>);
`;
try {
  const result=await build({configFile:false,logLevel:'warn',esbuild:{jsx:'automatic'},define:{'process.env.NODE_ENV':'"development"'},plugins:[{
    name:'subagent-file-tabs-fixture',enforce:'pre',resolveId(id){
      if(id.endsWith('__subagent_file_tabs__.tsx'))return '\0file-tabs.tsx';
      if(id.endsWith('/agentConversationBackend'))return '\0file-tabs-backend';
      if(id.endsWith('/useCardbushChat'))return '\0file-tabs-chat';
      if(id.endsWith('/ChatPanel'))return '\0file-tabs-panel.tsx';
    },load(id){
      if(id==='\0file-tabs.tsx')return source;
      if(id==='\0file-tabs-backend')return 'export const agentRuntimeClient=()=>window.fixtureRuntime.client; export const createAgentConversationBackend=()=>({runtime:window.fixtureRuntime,backend:{}});';
      if(id==='\0file-tabs-chat')return 'export const useCardbushChat=()=>window.fixtureChat;';
      if(id==='\0file-tabs-panel.tsx')return `import React from 'react';
        import {ConversationHostContext} from '${local('src/features/conversationHost.ts')}';
        import {ConversationFileReference} from '${local('src/features/chatMessages/ConversationFileReference.tsx')}';
        export function ChatPanel({language}){const host=React.useContext(ConversationHostContext);return <div>
          {['/tmp/em_out.txt','/workspace/report.txt','/workspace/denied.txt',window.missingPath].map(path=><div key={path} data-file={path}><ConversationFileReference path={path} language={language}/></div>)}
          <button data-extract onClick={()=>host.openExtract('saved')}>Saved extract</button></div>;}`;
    },
  }],build:{outDir:directory,emptyOutDir:false,minify:false,lib:{entry:resolve('__subagent_file_tabs__.tsx'),formats:['es'],fileName:()=> 'fixture.js'}}});
  const outputs=(Array.isArray(result)?result:[result]).flatMap(item=>item.output);
  await writeFile(join(directory,'index.html'),`<!doctype html><html lang="zh"><head><meta charset="utf-8">${outputs.filter(item=>item.type==='asset'&&item.fileName.endsWith('.css')).map(item=>`<link rel="stylesheet" href="${item.fileName}">`).join('')}</head><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>`);
  const require=createRequire(import.meta.url),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
  const run=spawnSync(require('electron'),['scripts/test-subagent-file-tabs-ui-worker.cjs',directory],{env,windowsHide:true,stdio:'inherit',timeout:45000});
  assert.equal(run.status,0,String(run.error??'Subagent file tabs UI failed'));
} finally {
  assert.ok(directory.startsWith(parent+sep+'subagent-file-tabs-'));
  await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
