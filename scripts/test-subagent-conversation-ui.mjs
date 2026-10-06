import { build } from 'vite';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const directory = resolve('tmp/subagent-conversation-ui');
await mkdir(directory, { recursive: true });
const local = path => resolve(path).replaceAll('\\', '/');
const source = `
import React from 'react'; import { createRoot } from 'react-dom/client';
import { SubagentConversationView, childConversationMessages } from '${local('src/features/subagents/SubagentConversation.tsx')}';
import {setConversationSource} from '${local('src/features/settings/conversationSource.ts')}'; window.setSource=setConversationSource;
import '${local('src/styles/theme.css')}'; import '${local('src/styles/app.css')}';
window.addEventListener('error',event=>console.error(event.error?.stack)); window.calls=[]; window.reads=[]; window.streams=new Map();
window.projectChild=childConversationMessages;
const now=()=>new Date().toISOString(), root=createRoot(document.getElementById('root'));
const tasks={}, histories={}, selectedTasks={}; let render;
const taskFor=id=>tasks[id]??(tasks[id]={protocol:'bush.subagent_task.v1',taskId:'task-'+id,parentSessionId:'parent',parentTurnId:'parent-turn',childSessionId:id,childTurnId:'initial-'+id,requestPrompt:'主 Agent 派发：检查布局 '+id,status:'running',terminal:false,createdAt:now(),updatedAt:now(),usage:{},raw:{}});
const history=id=>histories[id]??=[{id:'previous-'+id,role:'assistant',conversationId:id,turnId:'previous-turn-'+id,content:'上一轮已核对文件范围。',status:'completed',createdAt:now()}];
const conversation=id=>({id,title:'Child '+id,preview:'',updatedAt:now(),projectDir:'C:/fixture'});
const runtime={client:{getSession:async id=>({sessionId:id,turns:[],supersededMessageIds:[],metadata:{title:'Child '+id,agentRole:'child',parentSessionId:'parent'},updatedAt:now()}),getCapabilities:async()=>({features:['subagent_conversations']}),
  stopTurn:async input=>{window.calls.push({kind:'stop',...input});window.finish(input.sessionId,'stopped');return {accepted:true,terminal:false,reason:'stop_accepted'};},revertWorkspaceChanges:async()=>{},restoreWorkspaceChanges:async()=>{}},answerPermission:async()=>{},dispose(){}};
const load=async id=>{window.reads.push(id);return {conversation:conversation(id),messages:structuredClone(history(id)),toolExecutions:[]};};
const stream=async request=>{const {sessionId,turnId}=request; window.calls.push({kind:'watch',sessionId,turnId});
  request.onStart?.({sessionId,turnId,createdAt:now()}); const emit=()=>{request.onDelta?.('正在检查布局。',{turnId,messageId:'live-'+turnId,channel:'assistant',assistantSegmentIndex:1,createdAt:now(),sequence:2});
  request.onToolExecution?.({id:'tool-'+turnId,name:'read_file',state:'completed',success:true,summary:'读取布局文件',output:'width: 100%',durationMs:12,createdAt:now(),turnId,
    metadata:{displayTitles:{zh:'读取布局文件',en:'Read layout file'},turnId}});};
  if(turnId.startsWith('parent-followup-'))window.releaseParentOutput=emit;else emit();
  await new Promise(resolve=>{const entry={request,resolve};window.streams.set(sessionId,entry);request.signal?.addEventListener('abort',()=>{if(window.streams.get(sessionId)===entry)window.streams.delete(sessionId);resolve();},{once:true});});};
const base={
  fetchConversations:async()=>[],fetchSessionMessages:load,fetchMessages:async id=>(await load(id)).messages,
  fetchSessionWorkspaceChanges:async()=>[],fetchSessionContextWindowUsage:async id=>({sessionId:id}),
  fetchExperimentalGoals:async()=>[],fetchGoalRuntimeStatus:async()=>({enabled:false}),fetchPendingInteraction:async()=>null,
  onRuntimeInteractionsChanged:()=>()=>{},fetchSkills:async()=>[],fetchSkillDetail:async()=>null,
  fetchTeamFlow:async()=>null,updateExperimentalGoal:async()=>{},replyInteraction:async()=>{},cancelInteraction:async()=>{},
  updateConversation:async input=>conversation(input.sessionId),
  streamTurnEvents:stream,
  streamChat:async request=>{window.calls.push({kind:'send',sessionId:request.sessionId,text:request.userInput,sourceEnabled:request.sourceEnabled});
    const turnId='human-'+crypto.randomUUID(),createdAt=now(),messageId='user-'+turnId;
    history(request.sessionId).push({id:messageId,role:'user',conversationId:request.sessionId,turnId,content:request.userInput,createdAt});
    request.onStart?.({sessionId:request.sessionId,turnId,userMessageId:messageId,createdAt});
    await stream({...request,turnId});},
  sendGuidance:async input=>{window.calls.push({kind:'guide',sessionId:input.sessionId,turnId:input.turnId,text:input.guidance,sourceEnabled:input.sourceEnabled});
    history(input.sessionId).push({id:input.clientMessageId,role:'user',conversationId:input.sessionId,turnId:input.turnId,content:input.guidance,createdAt:now(),metadata:{turn_guidance:true,guidance_delivery:'sent',subagent_author:'user'}});
    return {continuationQueued:true,willContinueAfterCurrentRound:true,guidance:{clientMessageId:input.clientMessageId,mode:'append_context'}};},
  editMessage:async input=>window.calls.push({kind:'edit',...input}), createConversation:async()=>{throw Error('Must reuse child session');}, deleteConversationApi:async()=>true, switchConversationWorkspace:async()=>{},sendTeamFlowAction:async()=>{},stopTurn:async()=>{},
};
window.finish=(id,status='completed')=>{
  const task=taskFor(id);tasks[id]={...task,status,terminal:true,updatedAt:now()};
  if(!history(id).some(message=>message.turnId===task.childTurnId && message.metadata?.subagent_author==='parent'))history(id).push({id:'assignment-'+task.childTurnId,role:'user',conversationId:id,turnId:task.childTurnId,content:task.requestPrompt,createdAt:task.createdAt,metadata:{subagent_author:'parent'}});
  const entry=window.streams.get(id); if(entry){const turnId=entry.request.turnId;history(id).push({id:'answer-'+turnId,role:'assistant',content:status==='stopped'?'已停止':'检查完成，布局正常。',status,conversationId:id,turnId,createdAt:now()});entry.request.onFinalAssistantText?.(status==='stopped'?'已停止':'检查完成，布局正常。',{turnId,messageId:'answer-'+turnId,createdAt:now(),channel:'assistant',assistantSegmentIndex:1,sequence:3});entry.request.onDone?.({turnId,status,stopped:status==='stopped',completedAt:now(),raw:{}});entry.request.onMessages?.(structuredClone(history(id)),true);window.streams.delete(id);entry.resolve();}render();};
const models={defaultModelId:'fixture',models:[{id:'fixture',modelName:'fixture',provider:'openai',apiKey:'',baseUrl:'https://api.example.invalid/v1',hasApiKey:true,maxContextTokens:400000,maxCompletionTokens:8000}]};
const call=async()=>models;
let current='a',language='zh',theme='dark';
const readTasks=async()=>Object.values(tasks);
window.parentFollowup=(id,notify)=>{const previous=taskFor(id);selectedTasks[id]??=previous;tasks[id]={...previous,taskId:'resumed-'+crypto.randomUUID(),childTurnId:'parent-followup-'+crypto.randomUUID(),requestPrompt:'父代理追加：请在报告后补充操作建议。',status:'running',terminal:false,createdAt:now(),updatedAt:now(),raw:{resumedFromTaskId:previous.taskId}};render();if(notify)window.dispatchEvent(new CustomEvent('cardbush:subagent-dispatch',{detail:{parentSessionId:'parent',childSessionId:id,taskId:tasks[id].taskId}}));};
window.show=(id,lang='zh',mode='dark')=>{current=id;language=lang;theme=mode;taskFor(id);render();};
render=()=>root.render(<div className={'app theme-'+theme} style={{height:'100vh',width:'100%',display:'flex'}}><main style={{flex:1,padding:32}}>主会话保持在这里</main><aside style={{width:620,height:'100%',borderLeft:'1px solid var(--border)'}}><SubagentConversationView key={current} task={selectedTasks[current]??taskFor(current)} parentSessionId="parent" language={language} active theme={theme} refresh={async()=>render()} refreshing={false} error="" runtime={runtime} base={base} call={call} readTasks={readTasks}/></aside></div>);
window.show('a');
`;
const result = await build({ configFile:false,logLevel:'warn',esbuild:{jsx:'automatic'},define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'subagent-conversation-fixture',resolveId(id){if(id.endsWith('__child_fixture__.tsx'))return '\0child-fixture.tsx';},load(id){if(id==='\0child-fixture.tsx')return source;}}],build:{outDir:directory,emptyOutDir:false,minify:false,lib:{entry:resolve('__child_fixture__.tsx'),formats:['es'],fileName:()=> 'fixture.js'}}});
const outputs=(Array.isArray(result)?result:[result]).flatMap(item=>item.output);
await writeFile(join(directory,'index.html'),`<!doctype html><html><head><meta charset="utf-8">${outputs.filter(item=>item.type==='asset'&&item.fileName.endsWith('.css')).map(item=>`<link rel="stylesheet" href="${item.fileName}">`).join('')}</head><body><div id="root"></div><script type="module" src="fixture.js"></script></body></html>`);
const require=createRequire(import.meta.url),env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
const run=spawnSync(require('electron'),['scripts/test-subagent-conversation-ui-worker.cjs',directory],{env,windowsHide:true,stdio:'inherit',timeout:60000});
assert.equal(run.status,0,String(run.error??'Subagent conversation UI failed'));
