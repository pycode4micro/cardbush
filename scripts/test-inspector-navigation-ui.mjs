import assert from 'node:assert/strict';
import { build } from 'vite';
import ts from 'typescript';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const sourceModule = { exports: {} };
const compiled = ts.transpileModule(await readFile('src/features/inspector/inspectorTabs.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
new Function('module', 'exports', compiled)(sourceModule, sourceModule.exports);
const { inspectorTabsReducer: reduce, workSummaryInspectorTab: summaryTab } = sourceModule.exports;
let state = { tabs: [], activeId: '' };
assert.equal(reduce(state, { type: 'activate', id: 'missing' }), state);
for (const tab of [
  { id: 'file', kind: 'resource', detail: { target: 'C:/file.md', title: 'Notes' } },
  { id: 'review', kind: 'review', conversationId: 'a' },
  { id: 'shadow', kind: 'shadow', context: { sessionId: 'a' } },
  summaryTab({ kind: 'turn-history', sessionId: 'a', turnId: 'one' }, 'zh'),
  summaryTab({ kind: 'subagent-task', sessionId: 'a', task: { toolCallId: 'call' } }, 'zh'),
]) state = reduce(state, { type: 'open', tab });
assert.equal(state.tabs.length, 5);
const childId = state.activeId;
state = reduce(state, { type: 'open', tab: summaryTab({ kind: 'subagent-task', sessionId: 'a', task: { taskId: 'assigned', toolCallId: 'call' } }, 'zh') });
assert.equal(state.activeId, childId, 'assigned task identity must not duplicate or remount an open child page');
assert.equal(state.tabs.length, 5);
state = reduce(state, { type: 'open', tab: summaryTab({ kind: 'turn-history', sessionId: 'a' }, 'zh') });
assert.equal(state.tabs.length, 5, 'single and all-turn entry points share the session history tab');
state = reduce(state, { type: 'open', tab: summaryTab({ kind: 'turn-history', sessionId: 'b' }, 'en') });
assert.equal(state.tabs.length, 6, 'different sessions keep separate history');
state = reduce(state, { type: 'close', ids: new Set(['history:b']) });
assert.equal(state.activeId, childId, 'closing the last tab selects its neighbor');
state = reduce(state, { type: 'open', tab: { id: 'file', kind: 'resource', detail: { target: 'C:/file.md' } } });
assert.equal(state.tabs[0].detail.title, 'Notes');
state = reduce(state, { type: 'close', ids: new Set(['file', 'review', 'shadow']) });
assert.equal(state.activeId, 'history:a', 'batch close leaves a valid selected page');
state = reduce(state, { type: 'close', ids: new Set(state.tabs.map(tab => tab.id)) });
assert.deepEqual(state, { tabs: [], activeId: '' });
const appSource = await readFile('src/App.tsx', 'utf8');
assert.doesNotMatch(appSource, /\[workSummaryInspector|displayedWorkSummaryInspector|active && displayedReviewConversation/);
assert.match(appSource, /<InspectorTabPages tabs=\{displayedInspectorTabs\}/);
assert.match(appSource, /reviewConversationsById\.get\(tab\.conversationId\)/);

const parent = resolve('tmp');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'inspector-navigation-'));
const local = file => resolve(file).replaceAll('\\', '/');
const source = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { useInspectorTabs } from '${local('src/hooks/useInspectorTabs.ts')}';
import { workSummaryInspectorTab } from '${local('src/features/inspector/inspectorTabs.ts')}';
import { InspectorTabPages } from '${local('src/features/inspector/InspectorTabPages.tsx')}';
import { InspectorActions } from '${local('src/features/inspector/InspectorActions.tsx')}';
import { InspectorWebview } from '${local('src/features/inspector/InspectorWebview.tsx')}';
import { WorkSummaryInspector } from '${local('src/features/chat/WorkSummaryInspector.tsx')}';
import { ConversationChangeDialog } from '${local('src/features/sidebar/ChatSidebar.tsx')}';
import { ShadowWindow } from '${local('src/ShadowWindow.tsx')}';
import '${local('src/styles/theme.css')}';
import '${local('src/styles/app.css')}';
const messages = Array.from({length:9},(_,i) => [
  {id:'u'+i,role:'user',content:'第 '+i+' 轮：检查构建与输出结果',turnId:'turn-'+i},
  {id:'m'+i,role:'assistant',content:'已完成',turnId:'turn-'+i,createdAt:'2026-09-11T15:26:00Z',
    loopHistory:[{id:'l'+i,role:'assistant',content:('执行记录 '+i+'：检查文件、验证构建、整理结果。\\n\\n').repeat(8)}]}
]).flat();
const reports = [{id:'report',messageId:'m',turnId:'turn-1',createdAt:'2026-09-11T15:26:00Z',fileCount:2,additions:2,deletions:0,
  files:['first.ts','second.ts'].map(path=>({path,additions:1,deletions:0,diff:'@@ -0,0 +1 @@\\n+const value = 1;',lines:[{kind:'addition',text:'const value = 1;'}]}))}];
window.taskReads=0; window.fileReads=0; window.shadowCreates=0; window.shadowDeletes=0;
window.runtimeTask = {protocol:'bush.subagent_task.v1',taskId:'child',parentSessionId:'a',parentTurnId:'first',childSessionId:'child-session',
  status:'running',revision:1,prompt:'独立任务',inheritContext:true,inheritedMessageCount:0,usage:{},createdAt:'2026-09-11T14:00:00Z',updatedAt:'2026-09-11T14:00:00Z'};
window.fixtureClient = {
  listSessions:async()=>[{sessionId:'a',turns:[{turnId:'first',status:'completed'}]}],
  getSubagentTask:async()=>{window.taskReads++;return structuredClone(window.runtimeTask);},
  getSession:async id=>({sessionId:id,revision:1,metadata:{title:'源会话'},turns:[],supersededMessageIds:[]}),
  createSession:async()=>{window.shadowCreates++;}, deleteSession:async()=>{window.shadowDeletes++;},
  getConversationSession:async()=>null,
};
window.cardbushDesktop = { readTextPreview:async()=>{window.fileReads++;return {content:'# 本地文件\\n\\n预览内容',truncated:false,encoding:'utf-8'};} };
const noop=()=>{};
function Harness() {
  const tabs=useInspectorTabs();
  const [language,setLanguage]=React.useState('zh');
  const [currentSession,setSession]=React.useState('a');
  const [liveReports,setReports]=React.useState(reports);
  const [menu,setMenu]=React.useState(false);
  const openHistory=(turnId,sessionId=currentSession)=>tabs.openTab(workSummaryInspectorTab({kind:'turn-history',sessionId,turnId},language));
  const openReview=(initialFilePath='')=>tabs.openTab({id:'review:a',kind:'review',conversationId:'a',title:'审查',initialFilePath,selectionRequestId:crypto.randomUUID()});
  const openShadow=()=>tabs.openTab({id:'shadow:a',kind:'shadow',title:'Shadow',context:{windowId:'shadow:a',sessionId:'a',sourceTurnId:'',title:'源会话',language:'zh',theme:'dark',accentColor:'#6699ff',themeVariables:{},modelConfig:{id:'fixture'},reasoningLevel:'medium',projectDir:'',initialMode:'readonly'}});
  const openResource=(id,target)=>tabs.openTab({id,kind:'resource',detail:{target,title:id}});
  window.navigation={...tabs,openHistory,openReview,openShadow,openResource,setLanguage,setSession,refreshReports:()=>setReports(current=>structuredClone(current))};
  return <div className="app theme-dark" style={{display:'flex',height:'100vh'}}>
    <main id="conversation-scroll" style={{flex:1,overflow:'auto',height:'100%'}}><button id="outside">会话区</button><div style={{height:2400}}>当前会话：{currentSession}</div></main>
    <aside className="right-inspector" style={{width:520,flex:'0 0 520px','--side-panel-width':'520px'}}>
      <div className="right-inspector-viewport"><div className="right-inspector-content">
      <header className="right-inspector-toolbar with-tabs">
        <div className="right-inspector-tabs" role="tablist">{tabs.tabs.map(tab=><button key={tab.id} data-tab={tab.id} role="tab" aria-selected={tab.id===tabs.activeId} onClick={()=>{tabs.activateTab(tab.id);setMenu(false);}}>{tab.kind}</button>)}</div>
        <div className="right-inspector-add-tab"><button id="add" onClick={()=>setMenu(!menu)}>+</button>{menu&&<InspectorActions menu language={language} filesAvailable shadowUnavailableReason=""
          onOpenHistory={()=>{openHistory();setMenu(false);}} onOpenReview={()=>{openReview();setMenu(false);}}
          onOpenFiles={()=>{openResource('file','C:/fixture.md');setMenu(false);}} onOpenBrowser={()=>{openResource('browser','about:blank');setMenu(false);}}
          onOpenShadow={()=>{openShadow();setMenu(false);}}/>}</div>
      </header>
      <div className="right-inspector-body"><InspectorTabPages tabs={tabs.tabs} activeId={tabs.activeId}>{(tab,active)=>
        tab.kind==='history'||tab.kind==='subagent'?<WorkSummaryInspector active={active} language={language} detail={tab.detail} messages={messages}/>
        :tab.kind==='resource'?<InspectorWebview identity={tab.id} target={tab.detail.target} source={tab.detail.target} language={language} onOpenTarget={noop} onNavigationStateChange={noop}/>
        :tab.kind==='shadow'?<ShadowWindow embedded context={tab.context}/>
        :<ConversationChangeDialog embedded language={language} conversation={{id:tab.conversationId,title:'审查源会话',preview:'',updatedAt:''}} reports={liveReports}
           initialFilePath={tab.initialFilePath} selectionRequestId={tab.selectionRequestId}
           notice="" revertingChangeId="" revertedChangeIds={new Set()} onClose={noop} onRevert={async()=>{}} onRevertAll={async()=>{}}/>
      }</InspectorTabPages></div>
      </div></div>
    </aside>
  </div>;
}
createRoot(document.getElementById('root')).render(<React.StrictMode><Harness/></React.StrictMode>);
`;
try {
  const result = await build({configFile:false,logLevel:'silent',define:{'process.env.NODE_ENV':'"development"'},plugins:[{
    name:'inspector-navigation-fixture',enforce:'pre',
    resolveId(id) {
      if(id.endsWith('__inspector_navigation__.tsx')) return '\0inspector-navigation.tsx';
      if(id.endsWith('runtime-client/ElectronRuntimeSession')) return '\0inspector-runtime';
    },
    load(id) {
      if(id==='\0inspector-navigation.tsx') return source;
      if(id==='\0inspector-runtime') return 'export function createDesktopRuntimeSession(){return {dispose(){},client:window.fixtureClient};}';
    },
  }],build:{outDir:directory,emptyOutDir:true,minify:false,lib:{entry:resolve('__inspector_navigation__.tsx'),formats:['es']}}});
  const outputs=(Array.isArray(result)?result:[result]).flatMap(item=>item.output);
  const entry=outputs.find(item=>item.type==='chunk'&&item.isEntry);
  assert.ok(entry);
  const css=outputs.filter(item=>item.type==='asset'&&item.fileName.endsWith('.css'));
  await writeFile(join(directory,'index.html'),`<!doctype html><html lang="zh"><head><meta charset="utf-8">${css.map(item=>`<link rel="stylesheet" href="${item.fileName}">`).join('')}</head><body><div id="root"></div><script type="module" src="${entry.fileName}"></script></body></html>`);
  const require=createRequire(import.meta.url);
  const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const run=spawnSync(require('electron'),['scripts/test-inspector-navigation-ui-worker.cjs',directory],{env,windowsHide:true,stdio:'inherit',timeout:45_000});
  assert.equal(run.status,0,String(run.error??'Inspector navigation UI failed'));
} finally {
  assert.ok(directory.startsWith(parent+sep+'inspector-navigation-'));
  await rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
