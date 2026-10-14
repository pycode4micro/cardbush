import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join, sep } from 'node:path';
import { spawnSync } from 'node:child_process';

const parent = resolve('tmp');
await mkdir(parent, { recursive: true });
const directory = await mkdtemp(join(parent, 'native-team-ui-'));
const local = path => resolve(path).replaceAll('\\', '/');
const source = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { TeamWorkspace } from '${local('src/features/team/TeamWorkspace.tsx')}';
import { NativeTeamSidebar } from '${local('src/features/team/TeamSidebar.tsx')}';
import { MdPresentationApp } from '${local('src/features/mdPresentation/MdPresentationApp.tsx')}';
import { BushItSidebar } from '${local('src/features/mdPresentation/BushItSidebar.tsx')}';
import * as pages from '${local('src/features/mdPresentation/bushItPageStore.ts')}';
import { publishFileEditEvent } from '${local('src/backend/fileEditEvents.ts')}';
import { useTeamWorkspace } from '${local('src/features/team/teamWorkspaceStore.ts')}';
import '${local('src/styles/theme.css')}';
import '${local('src/styles/app.css')}';
window.pages=pages; window.publishFileEditEvent=publishFileEditEvent; window.records = { agents: [], teams: [], runs: [] }; window.calls = [];
window.fileResult=null; window.fileCalls=[]; window.cardbushDesktop={markdownFile:async input=>{fileCalls.push(input);if(input.action==='save')return {path:'D:/workflow.md',text:input.text,revision:'file-v1'};return fileResult;}};
window.command = async ({kind,payload:input}) => {
  window.calls.push({kind, input:structuredClone(input)});
  const list = kind==='runtime.agent_registry' ? records.agents : records.teams;
  if(input.action==='list') return structuredClone(kind==='runtime.agent_registry' ? list : {teams:list,runs:records.runs});
  if(input.action==='save') {
    if(window.deferSave) await new Promise(resolve=>window.finishSave=resolve);
    const prior=list.find(record=>record.definition.id===input.definition.id);
    if((prior?.revision??0)!==input.expected_revision) throw Error('Definition changed. Read its current revision before saving.');
    const receipt={revision:input.expected_revision+1,updatedAt:new Date().toISOString(),definition:structuredClone(input.definition)};
    if(prior) list.splice(list.indexOf(prior),1,receipt); else list.push(receipt);
    return structuredClone(receipt);
  }
  if(input.action==='delete') { const index=list.findIndex(record=>record.definition.id===(input.agent_id||input.team_id)); list.splice(index,1); return {deleted:true}; }
  throw Error('Unexpected command: '+JSON.stringify(input));
};
function Fixture(){ window.teamState=useTeamWorkspace(); window.pageState=pages.useBushItPages(); const [mode,setMode]=React.useState('team'); window.setApp=setMode;
  React.useEffect(()=>{const listener=event=>setMode(event.detail.id==='builtin:md-presentation'?'md':'team');window.addEventListener('cardbush-open-application',listener);return()=>window.removeEventListener('cardbush-open-application',listener);},[]);
  const practice=team=>window.practiced=structuredClone(team);
  const [portal,setPortal]=React.useState(null);window.setCreationPortal=setPortal;
  const [inspector,setInspector]=React.useState(null);
  const inspectorContext=React.useCallback(value=>{window.creationInspector=value;setInspector(value);},[]);
  return <div className="app theme-dark" data-inspector-session={inspector?.sessionId} style={{display:'flex',height:'100vh',background:'var(--surface)',overflow:'hidden','--sidebar-width':'240px'}}>{mode==='team'?<><NativeTeamSidebar language="zh" onBack={()=>setMode('md')}/><TeamWorkspace language="zh"/></>:<><BushItSidebar language="zh" onBack={()=>setMode('team')}/><MdPresentationApp language="zh" onPractice={practice} onToggleInspector={()=>window.inspectorOpened=true} onInspectorContext={inspectorContext} composerPortalTarget={portal}/></>}</div>; }
createRoot(document.getElementById('root')).render(<Fixture/>);
`;
try {
  const result = await build({ configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{
    name: 'native-team-fixture', enforce: 'pre',
    resolveId(id, importer) {
      if (id.endsWith('__native_team_fixture__.tsx')) return '\0native-team-fixture.tsx';
      if (id.includes('ElectronRuntimeSession') && importer?.endsWith('teamWorkspaceStore.ts')) return '\0native-team-transport';
      if (id === '../../backend/api' && importer?.endsWith('MdPresentationApp.tsx')) return '\0creation-api';
      if (id === '../../backend/api' && importer?.endsWith('CreationConversation.tsx')) return '\0creation-chat-api';
      if (id === '../../hooks/useCardbushChat' && importer?.endsWith('CreationConversation.tsx')) return '\0creation-chat-hook';
      // The shared ChatPanel/runtime has its own tests. Keep file-to-conversation
      // integration deterministic without calling a paid provider here.
      if (id === './CreationConversation' && importer?.endsWith('MdPresentationApp.tsx')) return '\0creation-chat';
    },
    load(id) {
      if (id === '\0native-team-fixture.tsx') return source;
      if (id === '\0native-team-transport') return 'export const createDesktopRuntimeSession=()=>({client:{command:async(input,decode)=>decode(await window.command(input))},dispose(){}});';
      if (id === '\0creation-api') return 'export async function createConversation(input){ window.creationSessionInput=input; return {id:input.sessionId}; }';
      if (id === '\0creation-chat') return `import React from 'react'; import {CreationConversation as View} from '${local('src/features/mdPresentation/CreationConversation.tsx')}'; export function CreationConversation(props){window.creationChatProps=props;return React.createElement(View,props);}`;
      if (id === '\0creation-chat-api') return `export async function fetchModelConfigs(){return {models:[{id:'test-model',provider:'test',apiKey:'',baseUrl:'https://example.invalid/v1',modelName:'Test model',apiProtocol:'openai-responses',maxContextTokens:400000,maxCompletionTokens:128000}],defaultModelId:'test-model'};}export async function saveModelReasoning(){}`;
      if (id === '\0creation-chat-hook') return `import {useMemo,useState} from 'react'; import {readUserPrompt,promptContextMetadata} from '@cardbush/bush-protocol'; const noop=()=>{},asyncNoop=async()=>{};
        export function useCardbushChat(models,available,options){const [messages,setMessages]=useState([]);const conversation=useMemo(()=>({id:options.activeConversationId,title:'创作',preview:'',updatedAt:''}),[options.activeConversationId]);return {
          activeMessages:messages,activeTurnId:'',loading:false,messagesLoading:false,sending:false,stopping:false,skills:[],activeConversation:conversation,
          selectedModel:'test-model',setSelectedModel:noop,permissionMode:'task_free',subagentPermissionRouting:'inherit',referencePlanMode:'off',reasoningLevel:'default',
          queuedMessageCount:0,queuedMessages:[],queuedMessagePreview:'',pendingInteraction:null,activeGoal:null,goalAvailable:false,
          error:null,notice:null,clearError:noop,clearNotice:noop,refreshActiveSession:asyncNoop,setPermissionMode:noop,setSubagentPermissionRouting:noop,setReferencePlanMode:noop,setReasoningLevel:noop,
          cancelSending:noop,retryFailedUserMessage:asyncNoop,regenerateAssistantMessage:asyncNoop,editUserMessageAndRegenerate:asyncNoop,
          sendTurnGuidance:asyncNoop,retryTurnGuidance:asyncNoop,sendQueuedMessageAsGuidance:asyncNoop,removeQueuedMessage:noop,reorderQueuedMessage:noop,
          replyToInteraction:asyncNoop,cancelPendingInteraction:noop,cancelActiveGoal:noop,toggleQueueLock:noop,
          sendMessage:async(text,...args)=>{window.creationSubmitted=text;const prompt=readUserPrompt(text);args[5]?.();setMessages([{id:'writing-user',role:'user',content:prompt.text,metadata:promptContextMetadata(prompt),createdAt:new Date().toISOString(),conversationId:options.activeConversationId},{id:'writing-reply',role:'assistant',content:'已更新文档，可以在左侧继续编辑。',status:'completed',createdAt:new Date().toISOString(),conversationId:options.activeConversationId}]);}
        };}`;
    },
  }], build: { outDir: directory, emptyOutDir: true, minify: false, lib: { entry: resolve('__native_team_fixture__.tsx'), formats: ['iife'], name: 'NativeTeamFixture' } } });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
  const entry = outputs.find(item => item.type === 'chunk' && item.isEntry);
  const styles = outputs.filter(item => item.type === 'asset' && item.fileName.endsWith('.css'));
  await writeFile(join(directory, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">${styles.map(item => `<link rel="stylesheet" href="${item.fileName}">`).join('')}</head><body><div id="root"></div><script src="${entry.fileName}"></script></body></html>`);
  const require = createRequire(import.meta.url), env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const run = spawnSync(require('electron'), ['scripts/test-native-team-ui-worker.cjs', directory], { env, windowsHide: true, stdio: 'inherit', timeout: 60000 });
  assert.equal(run.status, 0, String(run.error ?? 'Native Team UI failed'));
} finally {
  assert.ok(directory.startsWith(parent + sep + 'native-team-ui-'));
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
