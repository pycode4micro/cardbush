import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const parent = resolve('tmp');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'agent-registration-ui-'));
const local = file => resolve(file).replaceAll('\\', '/');
const source = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {agentToolActivity, toolExecutionSummarySchema} from '@cardbush/bush-protocol';
import {runtimeHistoryToolExecution} from '${local('src/backend/api.ts')}';
import {ConversationHostContext} from '${local('src/features/conversationHost.ts')}';
import {ConversationWorkSummary} from '${local('src/features/chat/ConversationWorkSummary.tsx')}';
import {LoopExecutionPreviews} from '${local('src/features/tools/LoopExecutionPreviews.tsx')}';
import {WorkSummaryInspector} from '${local('src/features/chat/WorkSummaryInspector.tsx')}';
import {workSummaryInspectorTab} from '${local('src/features/inspector/inspectorTabs.ts')}';
import {conversationRegistrations} from '${local('src/features/team/toolAgentActivity.ts')}';
import '${local('src/styles/theme.css')}';
import '${local('src/styles/app.css')}';
window.reads=[]; window.taskReads=0; window.detailReads=0; window.disposals=0;
window.roles=['策划','关键词分析师','编辑'].map((name,index)=>({revision:1,updatedAt:'2026-10-09',definition:{
  id:'employee-'+index,name,description:'独立完成'+name+'职责',system_prompt:'PRIVATE_ROLE_PROMPT',guards:['read_only'],hooks:['audit-hook'],memory:'user',enabled:true}}));
window.team={revision:1,updatedAt:'2026-10-09',definition:{id:'launch',name:'品牌宣传团队',description:'并行策划、分析，再汇总文案',max_parallel:2,
  nodes:roles.map((role,index)=>({id:'step-'+index,agent_id:role.definition.id,prompt:'PRIVATE_NODE_PROMPT',depends_on:index===2?['step-0','step-1']:[]}))}};
const now='2026-10-09T10:00:00Z';
function record(id,name,args,result,outcome='returned') {return {protocol:'bush.tool.execution_record.v2',requestId:id,sessionId:'parent',turnId:'turn',round:1,ordinal:0,recordedAt:now,
  toolCall:{protocol:'bush.tool_call.v1',id,name,argumentsText:JSON.stringify(args)},result,outcome,workspaceChanges:[],
  ...(outcome==='failed'?{error:{code:'fixture',message:'Validation failed'}}:{})};}
window.registrationRecords=roles.map(role=>record('register-'+role.definition.id,'subagent',{action:'save',agent:role.definition},
  {agent_id:role.definition.id,name:role.definition.name,revision:1}));
registrationRecords.push(record('register-team','team',{action:'save',definition:team.definition},{team_id:'launch',name:team.definition.name,revision:1}));
window.rawTask=(employee)=>({protocol:'bush.subagent_task.v1',taskId:employee?'employee-task':'fork-task',parentSessionId:'parent',parentTurnId:'turn',
  childSessionId:employee?'employee-session':'fork-session',childTurnId:'child-turn',prompt:'完成文案',inheritContext:!employee,inheritedMessageCount:0,
  ...(employee?{agentProfileId:'registered:employee-0',agentName:'策划'}:{}),status:'completed',finalResponse:'已完成',errorMessage:'',usage:{},createdAt:now,updatedAt:now,revision:1});
window.client={command:async (command,decode)=>{reads.push(command); if(window.blockRead) await new Promise(resolve=>window.releaseRead=resolve);
  if(command.payload.action!=='get') throw Error('Unexpected bulk read');
  const value=command.kind==='runtime.agent_registry'?roles.find(role=>role.definition.id===command.payload.agent_id):team;
  if(window.missing || !value) throw Error('Definition is unavailable.'); return decode(structuredClone(value));},
  listSubagentTasks:async()=>{taskReads++;return [rawTask(true),rawTask(false)];},getSubagentTask:async({taskId})=>rawTask(taskId==='employee-task')};
const root=createRoot(document.getElementById('root'));
function Fixture(){
  const [mode,setMode]=useState('history'), [opened,setOpened]=useState(), [language,setLanguage]=useState('zh');
  window.setMode=setMode;window.setLanguage=setLanguage; window.closeDetail=()=>setOpened(undefined);
  const records=[...registrationRecords];
  if(mode==='mixed') for(const employee of [true,false]) {const task=rawTask(employee); records.push(record(task.taskId,'subagent',employee?{agent_id:'employee-0'}:{},task));}
  if(mode==='failed') records.push(record('failed-save','subagent',{action:'save',agent:{id:'bad',name:'失败员工'}},undefined,'failed'));
  const executions=records.map(record=>runtimeHistoryToolExecution(mode==='live'?record:toolExecutionSummarySchema.parse({
    ...record,protocol:'bush.tool_execution_summary.v1',toolCall:{protocol:record.toolCall.protocol,id:record.toolCall.id,name:record.toolCall.name},
    agentActivity:agentToolActivity(record),resultAvailable:record.outcome==='returned'})));
  const message={id:'reply',conversationId:'parent',turnId:'turn',role:'assistant',content:'员工与团队已注册',toolExecutions:executions};
  window.executions=executions;window.currentRegistrations=conversationRegistrations([message]);
  const host=React.useMemo(()=>({id:'remote:fixture',sessionId:'parent',runtime:{client,dispose(){window.disposals++;}},
    plugins:[],pluginCommands:[],uploadFiles:async()=>[],openFile(){},toolDetails:async()=>{detailReads++;return records.map(runtimeHistoryToolExecution);},
    openWorkSummary:detail=>{window.opened=detail; window.openedTab=workSummaryInspectorTab(detail,'zh');setOpened(detail);}}),[mode]);
  return <ConversationHostContext.Provider value={host}><div className="app theme-dark fixture-app">
    <main><h2>给我演示下 Team 功能</h2><p>员工注册与团队流程</p><LoopExecutionPreviews executions={executions} message={message} language={language} active={false}/>
      <div className="chat-panel work-summary-requested fixture-summary"><ConversationWorkSummary messages={[message]} sessionId="parent" language={language}
        changeReports={[]} onOpenChangeReview={()=>{}} subagentObservabilityAvailable={mode==='mixed'}/></div></main>
    <aside className="fixture-inspector">{opened?.kind==='agent-definition' && <WorkSummaryInspector detail={opened} messages={[message]} language={language}/>}</aside>
  </div></ConversationHostContext.Provider>;
}
root.render(<Fixture/>);
`;
try {
  const result = await build({ configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{
    name: 'agent-registration-fixture', enforce: 'pre',
    resolveId(id) {
      if (id.endsWith('__agent_registration_fixture__.tsx')) return '\0agent-registration-fixture.tsx';
      if (id.endsWith('runtime-client/ElectronRuntimeSession')) return '\0registration-local-runtime';
    },
    load(id) {
      if (id === '\0agent-registration-fixture.tsx') return source;
      if (id === '\0registration-local-runtime') return 'export function createDesktopRuntimeSession(){throw Error("Unexpected local host access");}';
    },
  }], build: { outDir: directory, emptyOutDir: true, minify: false, lib: { entry: resolve('__agent_registration_fixture__.tsx'), formats: ['es'] } } });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
  const entry = outputs.find(item => item.type === 'chunk' && item.isEntry);
  const css = outputs.filter(item => item.type === 'asset' && item.fileName.endsWith('.css'));
  await writeFile(join(directory, 'index.html'), `<!doctype html><html lang="zh"><head><meta charset="utf-8">${css.map(item => `<link rel="stylesheet" href="${item.fileName}">`).join('')}
    <style>body{margin:0}.fixture-app{display:grid;grid-template-columns:minmax(0, 1.7fr) minmax(0,1fr);height:100vh;background:var(--surface);color:var(--text)}
    main{padding:28px;min-width:0;overflow:auto}.fixture-summary{margin-top:28px}.fixture-summary .conversation-work-summary{position:static;display:grid;width:100%;height:auto;max-height:none}
    .fixture-inspector{display:flex;min-width:0;min-height:0;border-left:1px solid var(--border)}
    @media(max-width:650px){.fixture-app{grid-template-columns:minmax(0,1fr);height:auto}.fixture-inspector{min-height:500px}}
    </style></head><body><div id="root"></div><script type="module" src="${entry.fileName}"></script></body></html>`);
  const require = createRequire(import.meta.url), env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const run = spawnSync(require('electron'), ['scripts/test-agent-registration-ui-worker.cjs', directory], { env, windowsHide: true, stdio: 'inherit', timeout: 40000 });
  assert.equal(run.status, 0, String(run.error ?? 'Agent registration UI failed'));
} finally {
  assert.ok(directory.startsWith(parent + sep + 'agent-registration-ui-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
