// Real Agent views, with isolated service fixtures and no real profile or network.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const { build } = await import('vite'); const { default: react } = await import('@vitejs/plugin-react');
  const entry = '\0agents-ui.tsx';
  const result = await build({ configFile: false, logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [react(), {
    name: 'agents-fixture', enforce: 'pre', resolveId: id => id.endsWith('__agents_fixture__.tsx') ? entry : undefined,
    load: id => id === entry ? `import React,{useState,useCallback} from 'react';import{createRoot}from'react-dom/client';
      import {AgentsView} from ${JSON.stringify(path.join(root, 'src/features/agents/AgentsView.tsx'))};
      import {useAgentConnections} from ${JSON.stringify(path.join(root, 'src/features/agents/useAgentConnections.ts'))};
      import {ChatSidebar} from ${JSON.stringify(path.join(root, 'src/features/sidebar/ChatSidebar.tsx'))};
      import ${JSON.stringify(path.join(root, 'src/styles/theme.css'))};
      import ${JSON.stringify(path.join(root, 'src/styles/app.css'))};
      import {ConversationInspectorContext,ConversationInspectorOutlet,useConversationInspectorOutlets} from ${JSON.stringify(path.join(root,'src/features/inspector/ConversationInspector.tsx'))};
      import {useInspectorTabs} from ${JSON.stringify(path.join(root,'src/hooks/useInspectorTabs.ts'))};
      import {InspectorTabPages} from ${JSON.stringify(path.join(root,'src/features/inspector/InspectorTabPages.tsx'))};
      import {RightInspectorResizer} from ${JSON.stringify(path.join(root,'src/components/RightInspectorResizer.tsx'))};
      const noop=()=>{};
      function Fixture(){const agents=useAgentConnections();const tabs=useInspectorTabs();const registry=useConversationInspectorOutlets();const[width,setWidth]=useState(440);
        const open=useCallback((id,title)=>tabs.openTab({id,title,kind:'conversation'}),[tabs.openTab]);const close=useCallback(id=>tabs.closeTabs(new Set([id])),[tabs.closeTabs]);
        return <ConversationInspectorContext.Provider value={{open,close,outlets:registry.outlets,visible:tabs.tabs.length>0}}> <div className="app theme-dark fixture-shell"><nav className="fixture-nav" hidden><button onClick={()=>agents.select('a')}>Select A</button><button onClick={()=>agents.select('b')}>Select B</button><button onClick={()=>agents.select('')}>Overview</button></nav>
        <ChatSidebar language="zh" section="agents" activeConversationId="" projects={[]} conversations={[]} changeReportsByConversation={{}} agents={agents.connections} activeAgentId={agents.selectedId} agentSessions={agents} onAgentSelect={agents.select} onSectionChange={()=>agents.select('')} onConversationChange={noop} onCreateConversation={noop} onAddProject={noop} onProjectAction={noop} onDeleteConversation={noop} onRenameConversation={async()=>true} onOpenConversationChanges={noop} onOpenSettings={noop} onOpenPlugins={noop} onOpenSearch={noop}/>
        <main className="main-stage"><AgentsView language="zh" agents={agents}/></main>
        {tabs.tabs.length>0&&<aside id="right-inspector" className="right-inspector soft-panel-visible" style={{'--right-inspector-width':width+'px'}}>
          <RightInspectorResizer width={width} windowMaximized={false} onWidthChange={setWidth} label="调整右侧栏"/>
          <div className="right-inspector-viewport"><div className="right-inspector-content"><header className="right-inspector-toolbar"><span>审查</span><button aria-label="关闭审查" onClick={()=>close(tabs.activeId)}>×</button></header>
          <div className="right-inspector-body"><InspectorTabPages tabs={tabs.tabs} activeId={tabs.activeId}>{tab=><ConversationInspectorOutlet id={tab.id} register={registry.register}/>}</InspectorTabPages></div></div></div>
        </aside>}</div></ConversationInspectorContext.Provider>};createRoot(document.getElementById('root')).render(<Fixture/>);` : undefined,
  }], build: { write: false, minify: false, lib: { entry: path.join(root, '__agents_fixture__.tsx'), formats: ['iife'], name: 'AgentsFixture' }, rollupOptions: { output: { inlineDynamicImports: true } } } });
  const output = Array.isArray(result) ? result.flatMap(item => item.output) : result.output; const js = output.find(item => item.type === 'chunk').code; const css = output.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => item.source).join('\n');
  const win = new BrowserWindow({ show: false, width: 1100, height: 820, webPreferences: { contextIsolation: false, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  const errors = []; win.webContents.on('console-message', event => { if (event.level === 'error') { errors.push(event.message); console.error(event.message); } });
  const run = source => win.webContents.executeJavaScript(source, true).catch(error => { console.error(source.slice(0, 500)); throw error; });
  const until = async (expression, label, timeout = 3500) => { for (let i=0;i<Math.ceil(timeout/35);i++) { if (await run(expression)) return; await pause(35); } console.error(await run("JSON.stringify({body:document.querySelector('.agents-view')?.innerText.slice(-6000),calls:calls.slice(-10)})")); assert.fail(label); };
  try {
    const fixture = path.join(root, 'tmp/agents-ui-fixture.html'); fs.mkdirSync(path.dirname(fixture), { recursive: true }); fs.writeFileSync(fixture, '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>'); await win.loadFile(fixture);
    await run(`document.body.innerHTML='<div id="root"></div>';document.head.innerHTML='<style>html,body,#root{height:100%;margin:0}body{background:#191919;color:#ededed;font:14px system-ui;--surface:#202020;--surface-strong:#2b2b2b;--text:#eee;--text-soft:#aaa;--border:#ffffff25}#root{display:flex;flex-direction:column}.fixture-shell{display:flex;height:100vh;--sidebar-width:260px;--layout-sidebar-space:260px;--conversation-pane-min-width:440px;--wallpaper-accent-rgb:40 32 28}.fixture-nav{display:none}.main-stage{height:100%}.fixture-shell .sidebar{position:relative;inset:auto}.fixture-shell.narrow .sidebar{display:none}</style>';var style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.append(style);var layout=document.createElement('style');layout.textContent='.fixture-shell{display:flex;height:100vh;--sidebar-width:260px;--layout-sidebar-space:260px;--conversation-pane-min-width:440px}.fixture-nav{display:none}.main-stage{height:100%;flex:1}.fixture-shell .sidebar{position:relative;inset:auto}.fixture-shell.narrow .sidebar{display:none}';document.head.append(layout);window.calls=[];window.failSend=false;window.delayA=false;
      window.connections=[{id:'a',name:'Build Agent',transport:'http',url:'https://a.invalid',hasToken:true,connected:false},{id:'b',name:'Research Agent',transport:'http',url:'http://127.0.0.1:4780',hasToken:true,connected:false}];
      window.snapshots={a:[],b:[],c:[]};window.jobs={a:[],b:[],c:[]};window.readers=[];window.models={defaultModelId:'model',models:[{id:'model',provider:'openai',modelName:'Fixture Model',apiKey:'',baseUrl:'',hasApiKey:true}]};
      window.cardbushDesktop={runtime:{command(){throw Error('Local Runtime must not be called')}},agents:{watchEvents:(id,request,listener)=>{const reader={id,request,listener,stopped:false};readers.push(reader);calls.push({id,operation:'watch',input:request});return()=>{reader.stopped=true}},list:async()=>connections,connect:async id=>{if(id==='a'&&delayA)await new Promise(r=>setTimeout(r,300));return {protocol:'cardbush.agent.v1',apiVersion:1,eventStreams:['sse','ndjson'],id:'agent-'+id,name:id.toUpperCase(),platform:'linux',capabilities:{durableQueue:true,conversationUi:true}}},disconnect:async id=>calls.push({id,operation:'disconnect'}),save:async input=>{calls.push({operation:'save',input});if(input.id){connections=connections.map(item=>item.id===input.id?{...item,...input}:item)}else connections.push({...input,id:'c'});return connections},remove:async id=>connections=connections.filter(c=>c.id!==id),call:async(id,operation,input={})=>{calls.push({id,operation,input});if(operation==='conversation.catalog')return {skills:[{name:'remote-skill',description:'Remote skill',path:'/srv/skills/test/SKILL.md'}],pluginCommands:[]};if(operation==='product.command'&&input.kind==='apps.get')return {plugins:[]};if(operation==='runtime.command'&&['runtime.list_subagent_tasks','runtime.list_turn_tool_execution_summaries','runtime.list_turn_tool_executions'].includes(input.kind))return [];if(operation==='sessions.list')return structuredClone(snapshots[id]);if(operation==='product.command'&&input.kind==='models.get')return models;if(operation==='projects.list')return {projects:[{id:'project-'+id,name:'Project '+id,path:'/srv/'+id}],defaultProjectId:'project-'+id};if(operation==='sessions.create'){const value={sessionId:'same-session',revision:1,metadata:{title:input.title||'新对话',projectId:'project-'+id},turns:[]};snapshots[id].push(value);return value}if(operation==='sessions.get')return structuredClone(snapshots[id].find(s=>s.sessionId===input.sessionId));if(operation==='chat.jobs')return structuredClone(jobs[id]);if(operation==='chat.send'){if(failSend){failSend=false;throw Error('Fixture disconnected')}const job={id:input.requestId,sessionId:input.sessionId,turnId:'turn-'+id,status:'queued',text:input.text};if(!jobs[id].some(j=>j.id===job.id))jobs[id].push(job);return job}if(operation==='sessions.rename'){snapshots[id].find(s=>s.sessionId===input.sessionId).metadata.title=input.title;return null}if(operation==='sessions.delete'){snapshots[id]=snapshots[id].filter(s=>s.sessionId!==input.sessionId);return null}if(operation==='chat.stop'){jobs[id].find(j=>j.id===input.id).status='stopped';return null}if(operation==='instructions.get')return {content:'# Rules for '+id,revision:'revision-'+id};if(operation==='instructions.save')return input;if(operation==='product.command'&&input.kind==='models.update'){models=input.config;return models}throw Error('Unexpected fixture operation '+operation)}}};undefined;`);
    await run(`window.baseWatch=cardbushDesktop.agents.watchEvents;cardbushDesktop.agents.watchEvents=(id,request,listener)=>baseWatch(id,request,frame=>{
      if(frame.type==='event'){const event=frame.event;frame={...frame,event:{protocol:'bush.runtime_event.v1',requestId:'request-'+request.turnId,sessionId:request.sessionId,turnId:request.turnId,eventId:'event-'+event.sequence,createdAt:new Date(Date.UTC(2026,8,22,0,0,event.sequence)).toISOString(),...event,payload:{...(/^(assistant|reasoning)_segment_/.test(event.kind)?{messageId:'msg-live',ordinal:1}:{}),...(/^tool_/.test(event.kind)?{assistantMessageId:'msg-live',ordinal:0}:{}),...event.payload}}};}listener(frame);
    });window.remoteGuidance=new Map();window.failGuidance=false;window.baseConnect=cardbushDesktop.agents.connect;cardbushDesktop.agents.connect=async id=>{const info=await baseConnect(id);if(id==='c')delete info.capabilities.conversationUi;else info.capabilities.sharedConversation=true;if(id==='b')info.capabilities.conversationManagement=true;return info};
      cardbushDesktop.runtime.command=()=>{calls.push({operation:'local-runtime'});throw Error('Local Runtime must not be called')};
      window.baseAgentCall=cardbushDesktop.agents.call;cardbushDesktop.agents.call=async(id,operation,input={})=>{
      if(operation==='runtime.command'&&input.kind==='runtime.enqueue_guidance'){
        calls.push({id,operation,input});if(failGuidance){failGuidance=false;throw Error('Guidance connection interrupted')}
        remoteGuidance.set(input.payload.messageId,input.payload);return {...input.payload,accepted:true,queueDepth:1};
      }
      if(operation==='runtime.command'&&input.kind==='runtime.get_user_message'){
        calls.push({id,operation,input});const value=remoteGuidance.get(input.payload.messageId);return value?{messageId:value.messageId,createdAt:value.createdAt,message:{role:'user',name:'turn_guidance',content:value.content}}:null;
      }
      if(operation==='files.upload'){calls.push({id,operation,input});return {path:'/srv/'+id+'/uploads/'+input.name,name:input.name,nextOffset:input.offset+atob(input.content).length}}
      if(operation==='files.read'){calls.push({id,operation,input});return {name:'note.txt',content:btoa('remote file content'),size:19,offset:0,done:true}}
      if(operation==='files.list'){calls.push({id,operation,input});return {entries:[{name:'note.txt',path:'/srv/b/note.txt',kind:'file'}]}}
      if(operation==='sessions.update'){calls.push({id,operation,input});Object.assign(snapshots[id].find(s=>s.sessionId===input.sessionId).metadata,Object.fromEntries(Object.entries(input).filter(([key])=>key!=='sessionId')));return null}
      if(id==='b'&&operation==='runtime.command'&&window.reviewRecord){
        if(input.kind==='runtime.list_turn_tool_executions'&&input.payload.detail==='summary'){calls.push({id,operation,input});return [{...reviewRecord,protocol:'bush.tool_execution_summary.v1',resultAvailable:true,workspaceChanges:reviewRecord.workspaceChanges.map(({metadata,...change})=>({...change,detailAvailable:true}))}]}
        if(input.kind==='runtime.list_turn_tool_executions'){calls.push({id,operation,input});return [reviewRecord]}
        if(['runtime.revert_workspace_changes','runtime.restore_workspace_changes'].includes(input.kind)){calls.push({id,operation,input});var reverted=input.kind==='runtime.revert_workspace_changes';snapshots.b[0].metadata.revertedWorkspaceChangeIds=reverted?['change-b']:[];return {...input.payload,revertedFiles:1,revertedChangeIds:['change-b'],revertedAt:new Date().toISOString(),restoredFiles:1,restoredChangeIds:['change-b'],restoredAt:new Date().toISOString()}}
      }
      if(operation==='runtime.command'&&['runtime.answer_permission','runtime.answer_solution_selection'].includes(input.kind)){calls.push({id,operation,input});return null}
      return baseAgentCall(id,operation,input);
    };undefined;`);
    await run(`localStorage.clear();sessionStorage.clear();localStorage.setItem('cardbush-agent-preferences:c',JSON.stringify({visionEnabled:true}));window.fixtureSelections=[];
      var validatedBase=cardbushDesktop.agents.call;
      var normalizeSession=s=>s?{protocol:'bush.session_snapshot.v1',createdAt:'2026-09-22T00:00:00Z',updatedAt:'2026-09-22T00:00:00Z',supersededMessageIds:[],...s,
        turns:s.turns.map((t,i)=>({protocol:'bush.session_turn_record.v1',sessionId:s.sessionId,requestId:'r-'+i,turnSequence:i+1,status:'completed',reason:'completed',createdAt:'2026-09-22T00:00:00Z',completedAt:'2026-09-22T00:00:03Z',usage:{},...t}))}:null;
      cardbushDesktop.agents.call=async(id,operation,input={})=>{
        if(id==='c'&&operation==='chat.send'&&'visionEnabled' in input)throw Error('Unrecognized key: visionEnabled');
        if(operation==='conversation.extracts'&&input.action==='list'){calls.push({id,operation,input});return {permanent:[],pending:[]}}
        if(operation==='runtime.command'){
          if(['runtime.get_goal','runtime.get_tool_execution'].includes(input.kind)){calls.push({id,operation,input});return null}
          if(input.kind==='runtime.list_turn_context_compactions'){calls.push({id,operation,input});return []}
          if(input.kind==='runtime.list_solution_selections'){calls.push({id,operation,input});return fixtureSelections}
        }
        var result=await validatedBase(id,operation,input);
        if(operation==='sessions.get'||operation==='sessions.create')return normalizeSession(result);
        if(operation==='sessions.list')return result.map(normalizeSession);
        if(operation==='chat.send'){var job=jobs[id].find(j=>j.id===result.id);Object.assign(job,{createdAt:'2026-09-22T00:00:00Z',modelId:input.modelId});return structuredClone(job)}
        if(operation==='chat.stop')return {accepted:true};
        return result;
      };
      var selectedWatch=cardbushDesktop.agents.watchEvents;
      cardbushDesktop.agents.watchEvents=(id,request,listener)=>selectedWatch(id,request,frame=>{
        if(frame.type==='event'&&frame.event.kind==='solution_selection_requested')fixtureSelections=[frame.event.payload];
        if(frame.type==='event'&&frame.event.kind==='solution_selection_answered')fixtureSelections=[];
        listener(frame);
      });undefined;`);
    await run(js + '\n;undefined;');
    await until("document.querySelectorAll('.agents-card').length===3",'Agent overview renders');
    await run(`window.originalConnect=cardbushDesktop.agents.connect;cardbushDesktop.agents.connect=async()=>{throw Error("Error invoking remote method 'agents:command': Error: 无法连接 Agent（http://127.0.0.1:14780）：连接被拒绝，请先启动本机隧道。 [ECONNREFUSED]")};undefined;`);
    await run("document.querySelector('.agents-card').click()");
    await until("document.querySelector('.agents-view [role=alert]')?.textContent.includes('ECONNREFUSED')",'actionable connection failure');
    assert.equal(await run("document.body.textContent.includes(\"Error invoking remote method\")"),false,'IPC details stay out of the view and sidebar errors');
    await run("cardbushDesktop.sshConnections={list:async()=>[{id:'ssh-fixture',name:'Server',username:'test',host:'fixture.invalid',port:22}]};[...document.querySelectorAll('.agents-view [role=alert] button')].find(b=>b.textContent==='连接设置').click();undefined;");
    await until("!!document.querySelector('[role=dialog]')",'offline connection settings open');
    await run("var mode=document.querySelector('[role=dialog] select');mode.value='ssh';mode.dispatchEvent(new Event('change',{bubbles:true}));undefined;");
    await until("document.querySelectorAll('[role=dialog] select').length===2",'SSH settings appear');
    await run("var host=document.querySelectorAll('[role=dialog] select')[1];host.value='ssh-fixture';host.dispatchEvent(new Event('change',{bubbles:true}));var address=document.querySelector('[role=dialog] input[type=url]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(address,'http://127.0.0.1:14780');address.dispatchEvent(new Event('input',{bubbles:true}));undefined;");
    assert.equal(await run("document.querySelector('[role=dialog] input[type=password]').required"),false,'saved token is retained without exposing it');
    await pause(150);
    fs.writeFileSync(path.join(root,'tmp/agents-tunnel-settings.png'),(await win.webContents.capturePage()).toPNG());
    await pause(30); await run("document.querySelector('[role=dialog]').requestSubmit()");
    await until("!document.querySelector('[role=dialog]')&&!!document.querySelector('.agents-view [role=alert]')",'offline settings saved');
    const tunnelSave=await run("calls.find(c=>c.operation==='save').input");
    assert.equal(tunnelSave.id,'a'); assert.deepEqual(tunnelSave.sshTunnel,{connectionId:'ssh-fixture',remoteHost:'127.0.0.1',remotePort:4780});
    assert.equal(tunnelSave.token,undefined);
    await run("cardbushDesktop.agents.connect=originalConnect;[...document.querySelectorAll('.agents-view [role=alert] button')].find(b=>b.textContent==='重试').click()");
    await until("!document.querySelector('.agents-view [role=alert]')&&!!document.querySelector('.agents-empty h2')",'connection retry recovers');
    await until("!!document.querySelector('.agent-sidebar-row.active .row-new-chat')",'connect A');
    await run("document.querySelector('.agent-sidebar-row.active .row-new-chat').click()");
    await until("!!document.querySelector('.agent-chat .composer-stack textarea')",'create session on A');
    const setDraft = async text => { await run(`var field=document.querySelector('.agent-chat .composer-stack textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,${JSON.stringify(text)});field.dispatchEvent(new Event('input',{bubbles:true}));undefined;`); await pause(30); };
    await run("document.querySelector('.agent-chat .model-select').click()");
    await run("[...document.querySelectorAll('.model-picker-row')].find(button=>button.textContent.includes('管理模型')).click()");
    await until("!!document.querySelector('.agent-settings .settings-switch input')",'remote model settings expose the shared vision switch');
    assert.equal(await run("document.querySelector('.agent-settings .settings-switch input').checked"),false,'vision is opt-in per Agent');
    assert.equal(await run("document.querySelector('.agent-settings .settings-switch input').disabled"),false,'current services support vision');
    await run("document.querySelector('.agent-settings .settings-switch input').click()");
    await until("JSON.parse(localStorage.getItem('cardbush-agent-preferences:a')).visionEnabled===true",'vision is saved without submitting model credentials');
    assert.equal(await run("calls.some(c=>c.operation==='product.command'&&c.input.kind==='models.update')"),false,'vision is a conversation preference');
    await pause(200);
    fs.writeFileSync(path.join(root,'tmp/agents-vision-settings.png'),(await win.webContents.capturePage()).toPNG());
    await run("document.querySelector('.agent-manage').click()");
    await until("!!document.querySelector('.agent-chat .composer-stack textarea')",'return after enabling vision');
    await run("document.querySelector('.agent-chat .model-select').click()");
    await until("!!document.querySelector('.model-reasoning-primary-options button:last-child')",'cloud reasoning uses the shared picker');
    await run("document.querySelector('.model-reasoning-primary-options button:last-child').click()");
    await until("localStorage.getItem('a:cardbush.reasoning_level')==='max'",'reasoning choice persists on A');
    await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await setDraft('A 的工作');
    await run("failSend=true;document.querySelector('.agent-chat .composer-stack .send-button').click()");
    await until("document.querySelector('[role=alert]')?.textContent.includes('Fixture disconnected')",'uncertain send is visible');
    const failedId = await run("calls.filter(c=>c.operation==='chat.send').at(-1).input.requestId");
    await run("[...document.querySelectorAll('.fixture-nav button')].find(b=>b.textContent==='Select B').click()");
    await until("document.querySelector('.agent-sidebar-row.active .project-title')?.textContent==='Research Agent' && !!document.querySelector('.agent-sidebar-row.active .row-new-chat')",'switch to B');
    await run("document.querySelector('.agent-sidebar-row.active .row-new-chat').click()");
    await until("!!document.querySelector('.agent-chat .composer-stack textarea')",'B session');
    assert.equal(await run("document.querySelector('.agent-chat .composer-stack textarea').value"),'','same session ID cannot share drafts across Agents');
    assert.equal(await run("localStorage.getItem('b:cardbush.reasoning_level')||'medium'"),'medium','Agents keep independent reasoning preferences');
    assert.equal(await run("JSON.parse(localStorage.getItem('cardbush-agent-preferences:b')).visionEnabled"),false,'A vision setting cannot enable vision on B');
    await setDraft('B 的草稿');
    await run("[...document.querySelectorAll('.fixture-nav button')].find(b=>b.textContent==='Select A').click()");
    await until("document.querySelector('.agent-sidebar-row.active .project-title')?.textContent==='Build Agent' && !!document.querySelector('.agent-sidebar-group:has(.agent-sidebar-row.active) .remote-conversation')",'return to A');
    await run("document.querySelector('.agent-sidebar-group:has(.agent-sidebar-row.active) .remote-conversation').click()");
    await until("document.querySelector('.agent-chat .composer-stack textarea')?.value==='A 的工作'",'A draft survives switching');
    await run("document.querySelector('.agent-chat .composer-stack .send-button').click()");
    await until("document.querySelector('.agent-chat .runtime-screen-line')?.textContent.includes('排队') || document.querySelector('.agent-chat .composer-stack').textContent.includes('排队1')",'server queue shown');
    await until("!document.querySelector('.agent-chat .composer-stack textarea').readOnly",'send settles');
    assert.equal(await run("!!document.querySelector('.agent-chat [role=alert]')"),false,'accepted send must not become a metadata error');
    assert.ok(await run("calls.findIndex(c=>c.id==='a'&&c.operation==='sessions.rename') < calls.findIndex(c=>c.id==='a'&&c.operation==='chat.send')"),'initial title is saved before execution can start');
    assert.equal(await run("calls.filter(c=>c.id==='a'&&c.operation==='sessions.rename').length"),1,'uncertain retry does not rename the session again');
    assert.equal(await run("calls.filter(c=>c.operation==='chat.send').at(-1).input.requestId"),failedId,'uncertain retry keeps durable request identity across view unmount');
    assert.equal(await run("calls.filter(c=>c.operation==='chat.send').at(-1).input.reasoningEffort"),'max','queued retry retains the original reasoning choice');
    assert.equal(await run("calls.filter(c=>c.operation==='chat.send').at(-1).input.visionEnabled"),true,'the vision switch controls actual submissions and survives remount');
    assert.equal(await run("calls.filter(c=>c.operation==='chat.send').at(-1).id"),'a');
    assert.equal(await run("calls.filter(c=>c.operation==='disconnect').length"),0,'navigation cannot stop a service');
    await run("jobs.a[0].status='running'");
    await until("readers.some(r=>r.id==='a'&&!r.stopped)",'SSE subscription starts for the active turn');
    await run("readers.at(-1).listener({type:'event',event:{kind:'assistant_segment_delta',sequence:1,payload:{segmentId:'live',delta:'实时第一段'}}})");
    await until("document.querySelector('.agent-chat .message-list').textContent.includes('实时第一段')",'SSE text renders before task completion');
    await run("readers.at(-1).listener({type:'error',error:'stream interrupted'})");
    await until("readers.length===2",'event stream reconnects');
    assert.equal(await run("readers.at(-1).request.afterSequence"),1,'SSE reconnect resumes from the last displayed sequence');
    await run("readers.at(-1).listener({type:'event',event:{kind:'assistant_segment_delta',sequence:1,payload:{segmentId:'live',delta:'重复'}}});readers.at(-1).listener({type:'event',event:{kind:'assistant_segment_delta',sequence:2,payload:{segmentId:'live',delta:'第二段'}}})");
    await until("document.querySelector('.agent-chat .message-list').textContent.includes('实时第一段第二段')",'stream resumes without duplicate content');
    assert.equal(await run("calls.filter(c=>c.operation==='chat.events').length"),0,'UI uses event streaming instead of event polling');
    await run("readers.at(-1).listener({type:'event',event:{kind:'assistant_segment_delta',sequence:3,payload:{segmentId:'live',delta:'\\n\\n[远程文件](/srv/project/README.md) ![远程图片](file:///C:/private.png) [网页](https://example.com)'}}})");
    await until("!!document.querySelector('.agent-chat .message-list a[href=\"https://example.com\"]')",'shared Markdown displays web links');
    assert.equal(await run("document.querySelectorAll('.agent-chat .message-list img,.agent-chat .message-list iframe,.agent-chat .message-list a[href^=\"file:\"],.agent-chat .message-list a[href^=\"/srv\"]').length"),0,'remote content cannot access local file previews');
    await run("window.thinkingFrames=[];window.addEventListener('cardbush:thinking',event=>thinkingFrames.push(event.detail));readers.at(-1).listener({type:'event',event:{kind:'reasoning_segment_started',turnId:'turn-a',createdAt:new Date().toISOString(),sequence:4,payload:{segmentId:'reasoning-a'}}})");
    await pause(35);
    await run("readers.at(-1).listener({type:'event',event:{kind:'reasoning_segment_delta',turnId:'turn-a',createdAt:new Date().toISOString(),sequence:5,payload:{segmentId:'reasoning-a',delta:'正在核对服务器环境'}}})");
    assert.equal(await run("thinkingFrames.at(-1)?.phase"),'delta','remote reasoning is forwarded after its start');
    await until("document.querySelector('.runtime-screen-line.thinking')?.textContent.includes('正在核对服务器环境')",'remote thinking renders in the same local Runtime rail',7000);
    await run("readers.at(-1).listener({type:'event',event:{kind:'model_request_usage',turnId:'turn-a',createdAt:new Date().toISOString(),sequence:6,payload:{round:1,attempt:1,contextWindowTokens:400000,model:'Fixture Model',inputTokens:12000,outputTokens:100}}});document.querySelector('.agent-chat .model-select').click()");
    await until("document.querySelector('.model-context-progress')?.getAttribute('aria-valuenow')==='3'",'cloud context usage reaches the shared meter (12000 / 400000)');
    await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");

    await run("[...document.querySelectorAll('.agent-chat .message-list .markdown-file-link')].find(b=>b.textContent==='远程文件').click()");
    await until("document.querySelector('.conversation-host-preview')?.textContent.includes('remote file content')",'file preview reads the server');
    assert.equal(await run("calls.find(c=>c.operation==='files.read').id"),'a');
    await run("document.querySelector('[aria-label=关闭审查]').click()");
    await run("var transfer=new DataTransfer();transfer.items.add(new File(['attachment'], 'note.txt',{type:'text/plain'}));document.querySelector('.agent-chat .composer-stack textarea').dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:transfer}));undefined;");
    await until("!!document.querySelector('.composer-file-attachment')",'shared composer uploads pasted files');
    assert.equal(await run("calls.find(c=>c.operation==='files.upload').id"),'a');
    await run("document.querySelector('.composer-file-remove').click()");
    await run(`readers.at(-1).listener({type:'event',event:{kind:'permission_requested',sequence:7,payload:{permissionId:'permission-1',reason:'Read a server file',actions:['read'],targets:[{kind:'filesystem_path',value:'/srv/private.txt'}],requestedCapabilityIds:['filesystem.read']}}});undefined;`);
    await until("!!document.querySelector('.permission-request-card')",'native permission card');
    await run("[...document.querySelectorAll('.permission-request-card button')].find(b=>b.textContent.includes('本次会话')).click()");
    await until("calls.some(c=>c.input?.kind==='runtime.answer_permission')",'permission sent');
    assert.equal(await run("calls.find(c=>c.input?.kind==='runtime.answer_permission').input.payload.decision"),'allow_session');
    await run(`readers.at(-1).listener({type:'event',event:{kind:'permission_answered',sequence:8,payload:{permissionId:'permission-1',answerId:'answer-1',grantedCapabilityIds:['filesystem.read']}}});readers.at(-1).listener({type:'event',event:{kind:'solution_selection_requested',sequence:9,payload:{toolCallId:'selection-tool',createdAt:'2026-09-22T00:00:00Z',selectionId:'selection-1',sessionId:'same-session',turnId:'turn-a',prompt:'Choose approach',options:['A','B']}}});undefined;`);
    await until("!!document.querySelector('.solution-selection-custom textarea')",'native solution card');
    await run("var field=document.querySelector('.solution-selection-custom textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'My alternative');field.dispatchEvent(new Event('input',{bubbles:true}));undefined;");
    await pause(30); await run("document.querySelector('.solution-selection-custom').requestSubmit()");
    await until("calls.some(c=>c.input?.kind==='runtime.answer_solution_selection')",'custom solution sent');
    assert.equal(await run("calls.find(c=>c.input?.kind==='runtime.answer_solution_selection').input.payload.text"),'My alternative');
    await run(`readers.at(-1).listener({type:'event',event:{kind:'solution_selection_answered',sequence:10,payload:{sessionId:'same-session',turnId:'turn-a',selectionId:'selection-1',kind:'text',text:'My alternative'}}});for(let i=0;i<7;i++){readers.at(-1).listener({type:'event',event:{kind:'tool_running',sequence:11+i*2,createdAt:'2026-09-22T00:00:00Z',payload:{toolCallId:'tool-'+i,toolName:'read_file'}}});readers.at(-1).listener({type:'event',event:{kind:'tool_returned',sequence:12+i*2,createdAt:'2026-09-22T00:00:00Z',payload:{toolCallId:'tool-'+i,toolName:'read_file'}}})}undefined;`);
    await until("document.querySelector('.tool-execution-summary')?.textContent.includes('已处理 7 项操作')",'all tool operations shown with final state');

    await run(`readers.at(-1).listener({type:'event',event:{kind:'assistant_segment_completed',sequence:25,payload:{messageId:'msg-second',segmentId:'second',ordinal:1,content:'第二轮正文'}}});readers.at(-1).listener({type:'event',event:{kind:'tool_returned',sequence:26,payload:{assistantMessageId:'msg-second',toolCallId:'second-tool',toolName:'terminal_exec'}}});undefined;`);
    await until("document.querySelectorAll('.agent-chat .tool-execution-summary').length===2",'interleaved text owns separate tool groups');
    assert.deepEqual(await run("[...document.querySelectorAll('.agent-chat .tool-execution-summary')].map(e=>e.textContent.match(/\\d+/)[0])"),['7','1']);
    assert.ok(await run("var paragraphs=[...document.querySelectorAll('.agent-chat .markdown-content p')];var second=paragraphs.find(e=>e.textContent==='第二轮正文');var tools=[...document.querySelectorAll('.agent-chat .tool-execution-summary')];!!second&&!!(tools[0].compareDocumentPosition(second)&Node.DOCUMENT_POSITION_FOLLOWING)&&!!(second.compareDocumentPosition(tools[1])&Node.DOCUMENT_POSITION_FOLLOWING)"),'DOM alternates narration, tools, narration, tools');
    const sendsBeforeGuidance=await run("calls.filter(c=>c.operation==='chat.send').length");
    await setDraft('请调整执行方向');
    await run("failGuidance=true;document.querySelector('.agent-chat .composer-stack textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}))");
    await until("!!document.querySelector('.guidance-retry-button:not([hidden])')",'remote guidance failure exposes the shared retry action');
    assert.equal(await run("calls.filter(c=>c.operation==='chat.send').length"),sendsBeforeGuidance,'immediate guidance cannot silently become another queued turn');
    const originalGuidance=await run("calls.find(c=>c.input?.kind==='runtime.enqueue_guidance').input.payload");
    await run("document.querySelector('.guidance-retry-button').click()");
    await until("!!document.querySelector('.guidance-delivery-status.queued')",'guidance is accepted by the remote Runtime');
    assert.deepEqual(await run("calls.filter(c=>c.input?.kind==='runtime.enqueue_guidance').at(-1).input.payload"),originalGuidance,'retry retains message identity, timestamp, turn and content');
    assert.equal(await run("document.querySelector('.agent-chat .composer-stack textarea').value"),'','successful guidance retry clears only its matching draft');
    await run(`readers.at(-1).listener({type:'event',event:{kind:'guidance_applied',sequence:27,payload:{messageId:${JSON.stringify(originalGuidance.messageId)},previousAssistantMessageId:'msg-second',queueDepth:0,afterRound:2}}});readers.at(-1).listener({type:'event',event:{kind:'assistant_segment_completed',sequence:28,payload:{messageId:'msg-after-guide',segmentId:'after-guide',ordinal:1,content:'已按引导调整'}}});undefined;`);
    await until("!!document.querySelector('.guidance-delivery-status.sent')&&document.querySelector('.agent-chat .message-list').textContent.includes('已按引导调整')",'applied guidance renders between assistant rounds');
    assert.ok(await run("var content=document.querySelector('.agent-chat .message-list').textContent;content.indexOf('第二轮正文')<content.indexOf('请调整执行方向')&&content.indexOf('请调整执行方向')<content.indexOf('已按引导调整')"));
    assert.equal(await run("document.querySelectorAll('.guidance-delivery-status').length"),1,'guidance receipt and applied event do not duplicate the user bubble');

    await run("document.querySelector('.agent-manage').click()");
    await until("!!document.querySelector('.agent-settings')",'leave active guided conversation');
    const readersBeforeReplay=await run('readers.length');
    await run("sessionStorage.removeItem('cardbush-agent-guidance:a:same-session');document.querySelector('.agent-manage').click()");
    await until(`readers.length>${readersBeforeReplay}`, 'guided conversation reconnects from its journal');
    await run(`readers.at(-1).listener({type:'event',event:{kind:'assistant_segment_completed',sequence:25,payload:{messageId:'msg-second',segmentId:'second',ordinal:1,content:'第二轮正文'}}});readers.at(-1).listener({type:'event',event:{kind:'tool_returned',sequence:26,payload:{assistantMessageId:'msg-second',toolCallId:'second-tool',toolName:'terminal_exec'}}});readers.at(-1).listener({type:'event',event:{kind:'guidance_applied',sequence:27,payload:{messageId:${JSON.stringify(originalGuidance.messageId)},previousAssistantMessageId:'msg-second',queueDepth:0,afterRound:2}}});readers.at(-1).listener({type:'event',event:{kind:'assistant_segment_completed',sequence:28,payload:{messageId:'msg-after-guide',segmentId:'after-guide',ordinal:1,content:'已按引导调整'}}});undefined;`);
    await until("document.querySelector('.agent-chat .message-list').textContent.includes('请调整执行方向')&&!!document.querySelector('.guidance-delivery-status.sent')",'replay restores the applied guidance body from the remote service without local storage');
    assert.equal(await run("calls.filter(c=>c.input?.kind==='runtime.enqueue_guidance').length"),2,'history reconstruction never resubmits guidance');

    fs.writeFileSync(path.join(root,'tmp/agents-chat-sidebar.png'),(await win.webContents.capturePage()).toPNG());
    assert.equal(await run("document.querySelectorAll('.agent-conversations,.agent-tabs,.lucide-bot').length"),0,'no nested sidebar, duplicate navigation or robot avatar');
    assert.equal(await run("document.querySelector('.remote-conversation').draggable"),false,'remote conversations cannot be dragged into local projects');
    await until("!!document.querySelector('.agent-chat .composer-stack .send-button:not(:disabled)')",'stop is ready after the interaction closes');
    await run("document.querySelector('.agent-chat .composer-stack .send-button').click()");
    await until("calls.some(c=>c.operation==='chat.stop'&&c.id==='a')",'explicit stop routes to A');
    await run("document.querySelector('.agent-manage').click()");
    await until("!!document.querySelector('.agent-settings')",'Agent settings');
    assert.ok(await run("readers.every(r=>r.stopped)"),'leaving chat closes event readers');
    await run("[...document.querySelectorAll('.agent-settings > nav button')].find(b=>b.textContent==='AGENTS.md').click()");
    await until("document.querySelector('textarea[aria-label=\"AGENTS.md\"]')?.value==='# Rules for a'",'instructions belong to A');
    fs.mkdirSync(path.join(root,'tmp'),{recursive:true});fs.writeFileSync(path.join(root,'tmp/agents-settings-ui.png'),(await win.webContents.capturePage()).toPNG());
    await run("document.querySelector('.agent-manage').click()");
    await until("!!document.querySelector('.agent-chat .composer-stack')",'return chat');
    await run("document.querySelector('.agent-chat .model-select').click()");
    assert.equal(await run("document.querySelector('.model-reasoning-primary-options button:last-child').classList.contains('active')"),true,'reasoning selection survives settings and session remount');
    await run("[...document.querySelectorAll('.model-picker-row')].find(button=>button.textContent.includes('管理模型')).click()");
    await until("!!document.querySelector('input[aria-label=\"最大输出 tokens\"]')",'Manage models opens the remote model settings directly');
    assert.equal(await run("document.querySelector('.agent-settings .settings-switch input').checked"),true,'vision preference is restored after switching Agents and views');
    await run("document.querySelector('.agent-settings .settings-switch input').click()");
    await until("JSON.parse(localStorage.getItem('cardbush-agent-preferences:a')).visionEnabled===false",'vision can be disabled independently of saving model configuration');
    const setLimit = async (label, value) => { await run(`var field=document.querySelector('input[aria-label=${JSON.stringify(label)}]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(String(value))});field.dispatchEvent(new Event('input',{bubbles:true}));undefined;`); await pause(30); };
    await setLimit('上下文上限',64000); await setLimit('最大输出 tokens',64000);
    await run("document.querySelector('.agent-settings form').requestSubmit()");
    await until("document.querySelector('.agent-settings [role=alert]')?.textContent.includes('必须小于')",'invalid output limit is rejected before saving');
    assert.equal(await run("calls.filter(c=>c.operation==='product.command'&&c.input.kind==='models.update').length"),0);
    await setLimit('最大输出 tokens',16384);
    await run("document.querySelector('.agent-settings form').requestSubmit()");
    await until("document.querySelector('.agent-settings [role=status]')?.textContent.includes('已保存')",'output limit saved on the remote Agent');
    assert.deepEqual(await run("calls.find(c=>c.operation==='product.command'&&c.input.kind==='models.update')"),{id:'a',operation:'product.command',input:{kind:'models.update',config:{defaultModelId:'model',models:[{id:'model',provider:'openai',modelName:'Fixture Model',apiKey:'',baseUrl:'',hasApiKey:true,maxContextTokens:64000,maxCompletionTokens:16384}]}}});
    await run("document.querySelector('.agent-manage').click()");
    await until("!!document.querySelector('.agent-chat .composer-stack')",'return from model settings');
    win.setSize(540,720); await run("document.querySelector('.fixture-shell').classList.add('narrow')"); await pause(200);
    assert.ok(await run("document.documentElement.scrollWidth<=innerWidth"),'narrow layout has no horizontal overflow');
    await run("document.querySelector('.agent-chat .composer-stack .model-select').click()");
    assert.ok(await run("[...document.querySelectorAll('[role=listbox]')].filter(e=>e.matches(':popover-open')).every(e=>e.getBoundingClientRect().bottom<=innerHeight && e.getBoundingClientRect().right<=innerWidth)"),'native model picker fits viewport');
    await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    fs.writeFileSync(path.join(root,'tmp/agents-chat-narrow.png'),(await win.webContents.capturePage()).toPNG());
    await run("[...document.querySelectorAll('.fixture-nav button')].find(b=>b.textContent==='Overview').click()");
    await until("!!document.querySelector('.agents-add')",'overview before add');
    await run("document.querySelector('.agents-add').click()");
    await until("!!document.querySelector('[role=dialog]')",'connection form opens');
    assert.ok(await run("document.querySelector('[role=dialog]').getBoundingClientRect().bottom<=innerHeight"),'dialog fits narrow window');
    assert.deepEqual(await run("Array.from(document.querySelector('[role=dialog] select').options,option=>option.value)"),['direct','ssh'],'direct HTTP and managed SSH are the only connection methods');
    await run("var fields=document.querySelectorAll('[role=dialog] input');['HTTP Agent','http://127.0.0.1:4782','fixture-token'].forEach((value,i)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(fields[i],value);fields[i].dispatchEvent(new Event('input',{bubbles:true}))});undefined;");
    await pause(30); await run("document.querySelector('[role=dialog]').requestSubmit()");
    await until("!document.querySelector('[role=dialog]')&&document.querySelector('.agent-sidebar-row.active .project-title')?.textContent==='HTTP Agent'",'HTTP connection is saved');
    const saved = await run("calls.find(c=>c.operation==='save'&&c.input.name==='HTTP Agent').input");
    assert.equal(saved.transport,'http'); assert.equal(saved.url,'http://127.0.0.1:4782'); assert.ok(!('command' in saved));
    await run("delayA=true;[...document.querySelectorAll('.fixture-nav button')].find(b=>b.textContent==='Select B').click()");
    await until("document.querySelector('.agent-sidebar-row.active .project-title')?.textContent==='Research Agent' && !!document.querySelector('.agent-sidebar-group:has(.agent-sidebar-row.active) .remote-conversation')",'B returns');
    await run("document.querySelector('.agent-sidebar-group:has(.agent-sidebar-row.active) .remote-conversation').click()");
    await until("document.querySelector('.agent-chat .composer-stack textarea')?.value==='B 的草稿'",'B draft preserved');
    assert.equal(await run("document.querySelector('.agent-chat .message-list').textContent.includes('A 的工作')"),false,'A transcript never appears on B');
    win.setSize(1100,820);await run("document.querySelector('.fixture-shell').classList.remove('narrow')");
    await run("document.querySelector('[data-agent-id=b] .remote-conversation').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))");
    await until("!!document.querySelector('.conversation-rename-form input')",'native inline rename');
    await run("var field=document.querySelector('.conversation-rename-form input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,'远程会话改名');field.dispatchEvent(new Event('input',{bubbles:true}));undefined;");
    await pause(30);await run("document.querySelector('.conversation-rename-form').requestSubmit()");
    await until("document.querySelector('.topbar h1')?.textContent==='远程会话改名'",'remote rename updates title');
    assert.equal(await run("snapshots.a[0].metadata.title"),'A 的工作','rename is scoped to B');
    await run(`window.reviewRecord={protocol:'bush.tool.execution_record.v2',requestId:'request-b',sessionId:'same-session',turnId:'completed-b',round:1,ordinal:0,recordedAt:'2026-09-22T01:00:05.000Z',toolCall:{protocol:'bush.tool_call.v1',id:'edit-b',name:'write_file',argumentsText:'{}'},outcome:'returned',result:{ok:true},workspaceChanges:[{change_id:'change-b',path:'/srv/b/note.txt',status:'added',additions:1,deletions:0,metadata:{diff:'@@ -0,0 +1 @@\\n+server-only-line'}}]};
      snapshots.b[0].updatedAt='2026-09-22T01:00:12.000Z';snapshots.b[0].supersededMessageIds=[];snapshots.b[0].metadata.runtimeWorkspace={workspaceDir:'/srv/b',mode:'direct',versioning:'none'};
      snapshots.b[0].turns=[{turnId:'completed-b',turnSequence:1,createdAt:'2026-09-22T01:00:00.000Z',completedAt:'2026-09-22T01:00:12.000Z',status:'completed',reason:'done',messages:[
        {messageId:'user-b',createdAt:'2026-09-22T01:00:00.000Z',message:{role:'user',content:'创建服务器文件'}},
        {messageId:'answer-b',createdAt:'2026-09-22T01:00:12.000Z',message:{role:'assistant',content:'服务器文件已创建。',toolCalls:[]}}]}];
      snapshots.b[0].turns[0].messages.forEach((message,index)=>Object.assign(message,{turnId:'completed-b',turnSequence:1,messageIndex:index}));
      window.dispatchEvent(new CustomEvent('cardbush:agent-session-updated',{detail:{connectionId:'b',sessionId:'same-session'}}));undefined;`);
    await until("!!document.querySelector('.assistant-completed-at')&&!!document.querySelector('.assistant-changed-files-summary')",'native completed message and changes');
    assert.ok(await run("document.querySelector('.assistant-run-header')?.textContent.includes('12s')"),'native processing duration from server timestamps');
    assert.equal(await run("document.querySelector('.assistant-completed-at').dateTime"),'2026-09-22T01:00:12.000Z');
    assert.equal(await run("document.querySelectorAll('.message-actions button[title=复制]').length"),2,'both user and assistant have copy actions');
    await run("window.copied=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{copied.push(text)}}});[...document.querySelectorAll('.message-actions button[title=复制]')].at(-1).click()");
    await until("copied.includes('服务器文件已创建。')",'native copy preserves the reply');
    await require('./helpers/agent-conversation-layout.cjs')({run,until,pause,win,root});
    await run("document.querySelector('.assistant-changed-files-review').click()");
    await until("document.querySelector('.change-review-dialog')?.textContent.includes('server-only-line')",'native lazy diff reads remote execution evidence');
    assert.ok(await run("!!document.querySelector('#right-inspector .change-review-dialog.embedded') && !document.querySelector('.modal-backdrop')"),'review lives inside the shared right inspector');
    assert.ok(await run("document.querySelector('#right-inspector').getBoundingClientRect().left >= document.querySelector('.main-stage').getBoundingClientRect().right - 1"),'review does not cover the conversation');
    assert.ok(await run("document.querySelector('#right-inspector').getBoundingClientRect().width >= 380"),'review uses the shared minimum width');
    assert.ok(await run("calls.some(c=>c.id==='b'&&c.operation==='files.list')"),'review tree reads B workspace');
    await run("document.querySelector('.change-review-revert').click()");
    await until("document.querySelector('.change-review-revert')?.textContent.includes('取消撤回')",'reverted state refreshed');
    assert.deepEqual(await run("calls.find(c=>c.input?.kind==='runtime.revert_workspace_changes').input.payload"),{sessionId:'same-session',turnIds:['completed-b']});
    await run("document.querySelector('.change-review-revert').click()");
    await until("calls.some(c=>c.input?.kind==='runtime.restore_workspace_changes')",'restore targets server');
    await pause(180); fs.writeFileSync(path.join(root,'tmp/agents-review-ui.png'),(await win.webContents.capturePage()).toPNG());
    await until("!!document.querySelector('.review-add-comment')",'native line comments');
    await run("document.querySelector('.review-add-comment').click()");
    await until("!!document.querySelector('textarea[aria-label=代码评论]')",'review comment editor');
    await run("var field=document.querySelector('textarea[aria-label=代码评论]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'请补充服务端校验');field.dispatchEvent(new Event('input',{bubbles:true}));undefined;");
    await pause(30); await run("document.querySelector('.review-comment-editor').requestSubmit()");
    await until("!!document.querySelector('.review-comment-compose:not(:disabled)')",'review comment saved');
    await run("document.querySelector('.review-comment-compose').click()");
    await until("document.querySelector('.agent-chat .composer-stack textarea')?.value.includes('请补充服务端校验')&&!document.querySelector('.change-review-dialog')",'review comments enter B draft without auto-sending');
    assert.ok(await run("document.querySelector('.agent-chat .composer-stack textarea').value.includes('/srv/b/note.txt')"),'comment retains server path');
    await run("document.querySelector('.assistant-changed-files-review').click()");
    await until("!!document.querySelector('#right-inspector .change-review-dialog')",'reopen remote review');
    await run("[...document.querySelectorAll('.fixture-nav button')].find(b=>b.textContent==='Select A').click()");
    await until("!document.querySelector('#right-inspector') && document.querySelector('.agent-sidebar-row.active .project-title')?.textContent==='Build Agent'",'leaving the remote session closes its scoped review');
    await run("[...document.querySelectorAll('.fixture-nav button')].find(b=>b.textContent==='Select B').click()");
    await until("document.querySelector('.agent-chat .composer-stack textarea')?.value.includes('请补充服务端校验')",'return to B preserves its comment draft');
    const remoteMenu = async label => {
      await run("document.querySelector('[data-agent-id=b] .remote-conversation').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:260}))");
      await until("!!document.querySelector('[role=menuitem]')",'remote context menu');
      await run(`[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent.includes(${JSON.stringify(label)})).click()`);
    };
    await remoteMenu('置顶对话'); await until("snapshots.b[0].metadata.pinned===true",'pin persists on B');
    await remoteMenu('标记为未读'); await until("!!document.querySelector('[data-agent-id=b] .conversation-unread-indicator')",'remote unread indicator');
    await remoteMenu('归档对话'); await until("!document.querySelector('[data-agent-id=b] .remote-conversation')",'archived chat leaves ordinary list');
    await run("[...document.querySelectorAll('[data-agent-id=b] button')].find(b=>b.textContent.includes('查看已归档')).click()");
    await until("!!document.querySelector('[data-agent-id=b] .remote-conversation')",'archived conversation accessible');
    await remoteMenu('恢复对话'); await until("snapshots.b[0].metadata.archived===false",'restore archived chat');
    assert.equal(await run("snapshots.a[0].metadata.pinned"),undefined,'same raw session ID on A stays unaffected');
    await run("document.querySelector('[data-agent-id=b] .project-row').click()");
    assert.equal(await run("document.querySelector('[data-agent-id=b] .project-row').getAttribute('aria-expanded')"),'false','collapse Agent');
    await run("document.querySelector('[data-agent-id=b] .project-row').click()");
    await until("!!document.querySelector('[data-agent-id=b] .remote-conversation')",'expand Agent');
    await run("document.querySelector('[data-agent-id=b] .remote-conversation').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:100,clientY:260}))");
    await until("!!document.querySelector('[role=menuitem]')",'native sidebar context menu');
    await run("[...document.querySelectorAll('[role=menuitem]')].find(b=>b.textContent.includes('删除对话')).click()");
    await until("!document.querySelector('[data-agent-id=b] .remote-conversation')&&!document.querySelector('.agent-chat .composer-stack')",'delete selected B session');
    assert.equal(await run("snapshots.a.length"),1,'deleting B preserves A');
    // A sidebar refresh may fail after acknowledgement; it must not turn a
    // delivered message back into an uncertain submission or a retry warning.
    await run("[...document.querySelectorAll('.fixture-nav button')].find(b=>b.textContent==='Overview').click()");
    await until("!!document.querySelector('.agents-card')",'overview before refresh regression');
    await run("[...document.querySelectorAll('.agents-card')].find(b=>b.textContent.includes('HTTP Agent')).click()");
    await until("!!document.querySelector('.agents-empty h2')",'C connected');
    await run("document.querySelector('.agent-sidebar-row.active .row-new-chat').click()");
    await until("!!document.querySelector('.agent-chat .composer-stack textarea')",'C session');
    await until("calls.some(c=>c.id==='c'&&c.operation==='sessions.get')",'C snapshot loaded');
    await run("document.querySelector('.agent-chat .model-select').click()");
    await run("[...document.querySelectorAll('.model-picker-row')].find(button=>button.textContent.includes('管理模型')).click()");
    await until("!!document.querySelector('.agent-settings .settings-switch input')",'legacy service still shows vision setting');
    assert.equal(await run("document.querySelector('.agent-settings .settings-switch input').disabled"),true,'legacy service cannot turn vision on');
    assert.equal(await run("document.querySelector('.agent-settings .settings-switch input').checked"),false,'unsupported stored preference is not shown as enabled');
    assert.ok(await run("document.querySelector('.agent-settings .settings-switch').textContent.includes('更新此 Agent')"),'legacy capability has an actionable explanation');
    await run("document.querySelector('.agent-manage').click()");
    await until("!!document.querySelector('.agent-chat .composer-stack textarea')",'return to legacy service chat');
    await run("window.originalCall=cardbushDesktop.agents.call;window.rejectRefresh=true;cardbushDesktop.agents.call=async(id,operation,input)=>{if(id==='c'&&operation==='product.command'&&input?.kind==='models.get'&&rejectRefresh){rejectRefresh=false;throw Error('Fixture list refresh failed')}return originalCall(id,operation,input)};undefined;");
    await setDraft('刷新失败也已发送'); await run("document.querySelector('.agent-chat .composer-stack .send-button').click()");
    await until("(window.refreshErrorText=document.querySelector('.agent-chat [role=alert]')?.textContent)?.includes('会话列表刷新失败')",'refresh failure is reported separately');
    assert.equal(await run("refreshErrorText.includes('可重试发送')"),false,'refresh failure must not request resending');
    assert.equal(await run("jobs.c.length"),1,'one message accepted');
    assert.equal(await run("'reasoningEffort' in calls.find(c=>c.id==='c'&&c.operation==='chat.send').input"),false,'old services receive the original compatible request');
    assert.equal(await run("'visionEnabled' in calls.find(c=>c.id==='c'&&c.operation==='chat.send').input"),false,'old services never receive the unsupported vision field even with a stored enabled preference');
    assert.equal(await run("calls.filter(c=>c.operation==='local-runtime').length"),0,'remote components never call the local Runtime');
    assert.equal(await run("sessionStorage.getItem('cardbush-agent-draft:c:same-session:submission')"),null,'accepted submission is cleared despite refresh error');
    assert.equal(await run("document.querySelector('.agent-chat .composer-stack textarea').value"),'','accepted draft stays cleared');
    assert.deepEqual(errors,[]);
    console.log('Agents UI passed: shared scroll/rail/alignment/fade, right inspector, native timing/copy/review/revert/restore, sidebar pin/unread/archive/restore, scoped drafts/retries/settings, SSE reconnect, remote file isolation and narrow layouts.');
  } finally { win.destroy(); }
}).then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1)});
