import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
const parent = resolve('tmp'); await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'automation-conversation-'));
const local = file => resolve(file).replaceAll('\\', '/');
const source = `
import React, {useState} from 'react'; import {createRoot} from 'react-dom/client';
import {AutomationRunPanel} from '${local('src/features/automations/AutomationRunPanel.tsx')}';
import '${local('src/styles/theme.css')}'; import '${local('src/styles/app.css')}'; import '${local('src/styles/themes/cyberpunk.css')}';
const now=new Date().toISOString();
window.calls=[];window.listeners=new Set();window.observers=new Set();window.aborts=0;window.opened=[];
window.detail={job:{id:'plan',name:'每日简报',prompt:'检查最新结果',sessionId:'source',runs:[]},run:{id:'run',turnId:'scheduled-turn',sessionId:'scheduled-session',status:'completed',queuedAt:now,finishedAt:now},sessionId:'scheduled-session',model:'fixture-model',permissionMode:'task_free',allowedTools:['read_file'],interactiveRequests:true,vision:true};
window.historyMessages=[{id:'scheduled-user',role:'user',turnId:'scheduled-turn',content:'检查最新结果',createdAt:now,conversationId:'scheduled-session'},{id:'scheduled-answer',role:'assistant',turnId:'scheduled-turn',content:'**简报已完成**。还有两项需要确认。\\n\\n| 项目 | 状态 |\\n| --- | --- |\\n| 构建 | 通过 |',createdAt:now,conversationId:'scheduled-session',status:'completed'}];
window.notify=()=>{for(const fn of listeners)fn()};
window.cardbushDesktop={automationCommand:async command=>{calls.push(command);if(command.action==='conversation')return structuredClone(detail);if(command.action==='mark_read')detail.run.readAt=now;if(command.action==='mark_unread')delete detail.run.readAt;notify();return{}},onAutomationChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}};
const start=request=>{request.onStart?.({sessionId:'scheduled-session',turnId:'follow-up',userMessageId:'follow-user',userMessageMetadata:{automationReminder:{asOf:now,total:1,items:[{jobId:'plan',runId:'run',title:'每日简报',status:'completed'}]}}});request.onDelta?.('正在解释结果',{messageId:'follow-answer',turnId:'follow-up',createdAt:now});};
window.fixture={
fetchSessionMessages:async sessionId=>{calls.push({fetch:sessionId});return{messages:structuredClone(historyMessages.filter(message=>!window.inFlight||message.turnId!=='follow-up')),conversation:{id:sessionId}}},fetchPendingInteraction:async()=>null,
streamChat:async request=>{window.inFlight=true;window.lastRequest=request;calls.push({sent:request.sessionId,model:request.model,allowedTools:request.allowedTools});historyMessages.push({id:'follow-user',role:'user',turnId:'follow-up',conversationId:request.sessionId,content:request.userInput,createdAt:now});if(window.deferStart)await new Promise(resolve=>{window.begin=resolve});start(request);await new Promise((resolve,reject)=>{window.finish=()=>{window.inFlight=false;historyMessages.push({id:'follow-answer',role:'assistant',turnId:'follow-up',conversationId:request.sessionId,content:'追问答复已保存',status:'completed',createdAt:now});request.onDone?.({turnId:'follow-up',status:'completed'});for(const observer of observers)observer();resolve();};request.signal.addEventListener('abort',()=>{aborts++;reject(new Error('stopped'));},{once:true});});},
streamTurnEvents:async request=>{calls.push({observed:request.turnId});start(request);await new Promise((resolve,reject)=>{const done=()=>{request.onMessages?.(structuredClone(historyMessages),true);request.onDone?.({turnId:'follow-up',status:'completed'});observers.delete(done);resolve();};observers.add(done);request.signal.addEventListener('abort',()=>{observers.delete(done);reject(new Error('observer detached'));},{once:true});});},
stopTurn:async()=>{},replyInteraction:async()=>{},cancelInteraction:async()=>{},recordAssistantLogicFeedback:async()=>{}
};
function Fixture(){const[open,setOpen]=useState(true);return <div className="app theme-cyberpunk" style={{height:'100vh',width:'100%',minWidth:0,display:'flex',flexDirection:'column'}}><button id="toggle" onClick={()=>setOpen(!open)}>{open?'关闭侧栏':'打开侧栏'}</button><div style={{flex:1,minHeight:0}}>{open&&<AutomationRunPanel jobId="plan" runId="run" language="zh" onOpenConversation={id=>opened.push(id)}/>}</div></div>};
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
try {
  const result = await build({ configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{
    name: 'automation-conversation-fixture', enforce: 'pre',
    resolveId(id, importer) {
      if (id.endsWith('__automation_conversation__.tsx')) return '\0automation-conversation.tsx';
      if (id === '../../backend/api' && importer?.replaceAll('\\', '/').endsWith('/automations/AutomationRunPanel.tsx')) return '\0automation-api.ts';
    },
    load(id) {
      if (id === '\0automation-conversation.tsx') return source;
      if (id === '\0automation-api.ts') return ['fetchSessionMessages','fetchPendingInteraction','streamChat','streamTurnEvents','stopTurn','replyInteraction','cancelInteraction','recordAssistantLogicFeedback'].map(name=>
        'export const '+name+'=(...args)=>window.fixture.'+name+'(...args);').join('\n');
    },
  }], build: { outDir: directory, emptyOutDir: true, minify: false, lib: { entry: resolve('__automation_conversation__.tsx'), formats: ['iife'], name: 'AutomationConversation' } } });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
  const entry = outputs.find(item => item.type === 'chunk' && item.isEntry);
  await writeFile(join(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">${outputs.filter(item=>item.type==='asset'&&item.fileName.endsWith('.css')).map(item=>`<link rel="stylesheet" href="${item.fileName}">`).join('')}</head><body><div id="root"></div><script src="${entry.fileName}"></script></body></html>`);
  const require = createRequire(import.meta.url), env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const run = spawnSync(require('electron'), ['scripts/test-automation-conversation-ui-worker.cjs', directory], { env, windowsHide: true, stdio: 'inherit', timeout: 30000 });
  assert.equal(run.status, 0, String(run.error ?? 'Automation conversation UI failed'));
} finally {
  assert.ok(directory.startsWith(parent + sep + 'automation-conversation-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
