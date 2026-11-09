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
import React, {useEffect} from 'react'; import {createRoot} from 'react-dom/client';
import {MarkdownContent} from '${local('src/features/chatMessages/MessageBubble.tsx')}';
import {AutomationReminderCard} from '${local('src/features/automations/AutomationReminderCard.tsx')}';
import {ConversationEventInbox,ConversationEventToast} from '${local('src/features/automations/ConversationEventInbox.tsx')}';
import {useConversationEventInbox,observeConversationEvents} from '${local('src/features/automations/conversationEventResults.ts')}';
import {projectRuntimeTurnMessages} from '${local('src/backend/runtimeSessionMessageProjection.ts')}';
import '${local('src/styles/theme.css')}'; import '${local('src/styles/app.css')}'; import '${local('src/styles/appearance.css')}';
const now=new Date().toISOString();
window.calls=[];window.listeners=new Set();window.opened=[];
const sentMessages=[{role:'user',content:'检查最新结果'}, {role:'user',name:'automation_unread_reminder',visibility:'internal',content:'HIDDEN_INBOX_SNAPSHOT'}, {role:'assistant',content:"Published result",toolCalls:[]}];
const projected=projectRuntimeTurnMessages({turnId:'scheduled-turn',turnSequence:1,status:'completed',reason:'done',createdAt:now,completedAt:now,usage:{},messages:sentMessages.map((message,index)=>({messageId:'projection-'+index,turnId:'scheduled-turn',turnSequence:1,messageIndex:index,createdAt:now,message}))},'scheduled-session');
if(projected.length!==2||projected.some(message=>message.content==='HIDDEN_INBOX_SNAPSHOT'))throw Error('Internal observations must remain hidden in the conversation projection');
window.notify=()=>{for(const fn of listeners)fn()};
window.cardbushDesktop={onAutomationChanged:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}};
const root=createRoot(document.getElementById('root'));
window.notified=[];
const attention = item => window.notified.push([item.sourceId,item.runId]);
function InboxFixture({source}) {
  const {receive,unreadEventResults,latestEventArrival}=useConversationEventInbox(attention);
  useEffect(()=>observeConversationEvents(async overview=>receive(overview)),[receive]);
  const latest=unreadEventResults.find(item=>item.runId===latestEventArrival);
  return <div className="app theme-dark"><ConversationEventInbox key={source} items={unreadEventResults} sessionId={source} language="zh"/>
    {latest && <ConversationEventToast key={latest.runId} item={latest} language="zh" onOpen={()=>window.opened.push(latest.sourceId)}/>}</div>;
}
window.setupInbox = () => {
  const saved={id:'saved',turnId:'turn',sessionId:'hidden',queuedAt:now,finishedAt:now,status:'completed',summary:'已保存的提醒',result:'**Complete saved result**\\n\\n| Check | Status |\\n| --- | --- |\\n| Build | Passed |'};
  const live={...saved,id:'new',status:'running',summary:undefined};
  const job={id:'plan',sessionId:'source',name:'每日简报',prompt:'PRIVATE_SCHEDULER_INSTRUCTION',runs:[saved,live]};
  window.overview={jobs:[job],sessions:[{id:'source',title:'来源会话'}]};
  window.cardbushDesktop.automationCommand=async command=>{
    calls.push(command);
    if(command.action==='list'){
      const snapshot=structuredClone(overview);
      if(window.holdList){window.holdList=false;await new Promise(resolve=>{window.releaseList=resolve})}
      return snapshot;
    }
    if(command.action==='results')return {results:job.runs.filter(run=>command.id===job.id&&command.runIds.includes(run.id)).map(run=>({...run,jobId:job.id}))};
    if(command.action==='mark_read'){
      const target=job.runs.find(run=>run.id===command.runIds[0]);target.readAt=now;notify();return {};
    }
    throw Error('Unexpected inbox command');
  };
};
window.showReceipt=()=>root.render(<AutomationReminderCard language="en" ResultContent={MarkdownContent} value={{total:1,items:[{jobId:'plan',runId:'saved',title:'Saved reminder'}]}}/>);
window.showInbox=(source='source',key=0)=>root.render(<InboxFixture key={key} source={source}/>);
`;
try {
  const result = await build({ configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{
    name: 'automation-conversation-fixture', enforce: 'pre',
    resolveId(id, importer) {
      if (id.endsWith('__automation_conversation__.tsx')) return '\0automation-conversation.tsx';
    },
    load(id) {
      if (id === '\0automation-conversation.tsx') return source;
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
