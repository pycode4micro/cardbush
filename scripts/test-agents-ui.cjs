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
      import {SettingsView} from ${JSON.stringify(path.join(root, 'src/features/SettingsView.tsx'))};
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
      function Fixture(){const agents=useAgentConnections();const tabs=useInspectorTabs();const registry=useConversationInspectorOutlets();const[width,setWidth]=useState(440);const[setting,setSetting]=useState(null);const[viewActive,setViewActive]=useState(true);const[preferences,setPreferences]=useState({conversationStyle:{mode:'natural',customTone:''},thinking:{visible:true},guidance:{deliveryMode:'queue'},managedModelConfigs:[]});
        window.refreshAgentConnections=agents.refresh;
        window.openFixtureSettings=(id,section='mcp')=>setSetting({id,section});
        const open=useCallback((id,title)=>tabs.openTab({id,title,kind:'conversation'}),[tabs.openTab]);const close=useCallback(id=>tabs.closeTabs(new Set([id])),[tabs.closeTabs]);
        return <ConversationInspectorContext.Provider value={{open,close,outlets:registry.outlets,visible:tabs.tabs.length>0}}> <div className="app theme-dark fixture-shell"><nav className="fixture-nav" hidden><button onClick={()=>agents.select('a')}>Select A</button><button onClick={()=>agents.select('b')}>Select B</button><button onClick={()=>agents.select('')}>Overview</button><button onClick={()=>setViewActive(false)}>Local view</button><button onClick={()=>setViewActive(true)}>Agent view</button>{['a1','a2','a3'].map(id=><button key={id} onClick={()=>agents.select('a',id)}>{id}</button>)}</nav>
        <ChatSidebar language="zh" section="agents" activeConversationId="" projects={[]} conversations={[]} changeReportsByConversation={{}} agents={agents.connections} activeAgentId={agents.selectedId} agentSessions={agents} onAgentSelect={agents.select} onSectionChange={()=>agents.select('')} onConversationChange={noop} onCreateConversation={noop} onAddProject={noop} onProjectAction={noop} onDeleteConversation={noop} onRenameConversation={async()=>true} onOpenConversationChanges={noop} onOpenSettings={noop} onOpenPlugins={noop} onOpenSearch={noop}/>
        <main className="main-stage" hidden={!!setting}><AgentsView active={viewActive} language="zh" agents={agents} onOpenSettings={(id,section)=>setSetting({id,section})}/></main>
        {setting&&<SettingsView active onReady={noop} language="zh" languageMode="zh" systemLanguage="zh" themePreference="dark"
          agentConnections={agents.connections} agentId={setting.id} onAgentChange={id=>setSetting({...setting,id})}
          initialSection={setting.section} initialPluginTab="plugins" settings={preferences} onSettingsChange={fn=>setPreferences(fn)}
          selectedModel="" availableModels={[]} backendCapabilities={{reasoningStream:true}} runtimeBusy={false} conversations={[]} skills={[]} disabledSkillNames={new Set()}
          onBack={()=>setSetting(null)} onThemePreferenceChange={noop} onLanguageModeChange={noop} onUseModel={noop}
          sidebarCollapsed={false} sidebarPresence={{mounted:true,visible:true}} sidebarWidth={260} onSidebarCollapse={noop} onSidebarWidthChange={noop}
          onToggleSkill={noop} onReloadSkills={async()=>[]} onLoadSkillDetail={async()=>null}
          visualInputAvailable visualInputEnabled={false} onVisualInputEnabledChange={noop}/>}
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
      window.snapshots={a:[],b:[],c:[]};window.jobs={a:[],b:[],c:[]};window.readers=[];window.models={defaultModelId:'model',models:[{id:'model',provider:'openai',modelName:'Fixture Model',apiKey:'',baseUrl:'https://api.deepseek.com/v1',hasApiKey:true}]};
      window.cardbushDesktop={runtime:{command(){throw Error('Local Runtime must not be called')}},agents:{watchEvents:(id,request,listener)=>{const reader={id,request,listener,stopped:false};readers.push(reader);calls.push({id,operation:'watch',input:request});return()=>{reader.stopped=true}},list:async()=>connections,connect:async id=>{if(id==='a'&&delayA)await new Promise(r=>setTimeout(r,300));return {protocol:'cardbush.agent.v1',apiVersion:1,eventStreams:['sse','ndjson'],id:'agent-'+id,name:id.toUpperCase(),platform:'linux',capabilities:{durableQueue:true,conversationUi:true}}},disconnect:async id=>calls.push({id,operation:'disconnect'}),save:async input=>{calls.push({operation:'save',input});if(input.id){connections=connections.map(item=>item.id===input.id?{...item,...input}:item)}else connections.push({...input,id:'c'});return connections},remove:async id=>connections=connections.filter(c=>c.id!==id),call:async(id,operation,input={})=>{calls.push({id,operation,input});if(operation==='conversation.catalog')return {skills:[{name:'remote-skill',description:'Remote skill',path:'/srv/skills/test/SKILL.md'}],pluginCommands:[]};if(operation==='product.command'&&input.kind==='apps.get')return {plugins:[]};if(operation==='runtime.command'&&['runtime.list_subagent_tasks','runtime.list_turn_tool_execution_summaries','runtime.list_turn_tool_executions'].includes(input.kind))return [];if(operation==='sessions.list')return structuredClone(snapshots[id]);if(operation==='product.command'&&input.kind==='models.get')return models;if(operation==='projects.list')return {projects:[{id:'project-'+id,name:'Project '+id,path:'/srv/'+id}],defaultProjectId:'project-'+id};if(operation==='sessions.create'){const value={sessionId:'same-session',revision:1,metadata:{title:input.title||'新对话',projectId:'project-'+id},turns:[]};snapshots[id].push(value);return value}if(operation==='sessions.get')return structuredClone(snapshots[id].find(s=>s.sessionId===input.sessionId));if(operation==='chat.jobs')return structuredClone(jobs[id]);if(operation==='chat.send'){if(failSend){failSend=false;throw Error('Fixture disconnected')}const job={id:input.requestId,sessionId:input.sessionId,turnId:'turn-'+id,status:'queued',text:input.text};if(!jobs[id].some(j=>j.id===job.id))jobs[id].push(job);return job}if(operation==='sessions.rename'){snapshots[id].find(s=>s.sessionId===input.sessionId).metadata.title=input.title;return null}if(operation==='sessions.delete'){snapshots[id]=snapshots[id].filter(s=>s.sessionId!==input.sessionId);return null}if(operation==='chat.stop'){jobs[id].find(j=>j.id===input.id).status='stopped';return null}if(operation==='instructions.get')return {content:'# Rules for '+id,revision:'revision-'+id};if(operation==='instructions.save')return input;if(operation==='product.command'&&input.kind==='models.update'){models=input.config;return models}throw Error('Unexpected fixture operation '+operation)}}};undefined;`);
    await run(`window.baseWatch=cardbushDesktop.agents.watchEvents;cardbushDesktop.agents.watchEvents=(id,request,listener)=>baseWatch(id,request,frame=>{
      if(frame.type==='event'){const event=frame.event;frame={...frame,event:{protocol:'bush.runtime_event.v1',requestId:'request-'+request.turnId,sessionId:request.sessionId,turnId:request.turnId,eventId:'event-'+event.sequence,createdAt:new Date(Date.UTC(2026,8,22,0,0,event.sequence)).toISOString(),...event,payload:{...(/^(assistant|reasoning)_segment_/.test(event.kind)?{messageId:'msg-live',ordinal:1}:{}),...(/^tool_/.test(event.kind)?{assistantMessageId:'msg-live',ordinal:0}:{}),...event.payload}}};}listener(frame);
    });window.remoteGuidance=new Map();window.failGuidance=false;window.baseConnect=cardbushDesktop.agents.connect;cardbushDesktop.agents.connect=async id=>{const info=await baseConnect(id);if(id==='c')delete info.capabilities.conversationUi;else {info.capabilities.sharedConversation=true;info.capabilities.sharedSettings=true;}if(id==='b')info.capabilities.conversationManagement=true;return info};
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
    await run(`localStorage.clear();sessionStorage.clear();localStorage.setItem('cardbush_conversation_style',JSON.stringify({mode:'concise',customTone:''}));localStorage.setItem('cardbush-agent-preferences:c',JSON.stringify({visionEnabled:true}));window.fixtureSelections=[];
      var validatedBase=cardbushDesktop.agents.call;
      var normalizeSession=s=>s?{protocol:'bush.session_snapshot.v1',createdAt:'2026-09-22T00:00:00Z',updatedAt:'2026-09-22T00:00:00Z',supersededMessageIds:[],...s,
        turns:s.turns.map((t,i)=>({protocol:'bush.session_turn_record.v1',sessionId:s.sessionId,requestId:'r-'+i,turnSequence:i+1,status:'completed',reason:'completed',createdAt:'2026-09-22T00:00:00Z',completedAt:'2026-09-22T00:00:03Z',usage:{},...t}))}:null;
      window.internalSessions=Object.fromEntries(['a','b'].map(id=>[id,[
        {sessionId:'child-'+id,revision:1,metadata:{title:'Internal child '+id,agentRole:'child',parentSessionId:'same-session'},turns:[]},
        {sessionId:'archived-child-'+id,revision:1,metadata:{title:'Pinned archived child '+id,agentRole:'child',parentSessionId:'same-session',pinned:true,archived:true},turns:[]},
        {sessionId:'hidden-'+id,revision:1,metadata:{title:'Hidden internal '+id,hidden:true},turns:[]},
      ]]));
      cardbushDesktop.agents.call=async(id,operation,input={})=>{
        if(id==='c'&&operation==='chat.send'&&('visionEnabled' in input||'conversationStyle' in input))throw Error('Unrecognized key: visionEnabled');
        if(operation==='conversation.extracts'&&input.action==='list'){calls.push({id,operation,input});return {permanent:[],pending:[]}}
        if(operation==='runtime.command'){
          if(input.kind==='runtime.list_user_prompts'){calls.push({id,operation,input});return []}
          if(['runtime.get_goal','runtime.get_tool_execution'].includes(input.kind)){calls.push({id,operation,input});return null}
          if(input.kind==='runtime.list_turn_context_compactions'){calls.push({id,operation,input});return []}
          if(input.kind==='runtime.list_solution_selections'){calls.push({id,operation,input});return fixtureSelections}
        }
        var result=await validatedBase(id,operation,input);
        if(operation==='sessions.get')return normalizeSession(result??internalSessions[id]?.find(s=>s.sessionId===input.sessionId));
        if(operation==='sessions.create')return normalizeSession(result);
        if(operation==='sessions.list')return [...result,...(internalSessions[id]??[])].map(normalizeSession);
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
    if (!process.argv.includes('--images')) await run("localStorage.setItem('a:cardbush.permission_mode','user_free');localStorage.setItem('b:cardbush.permission_mode','all_free');undefined;");
    await run(js + '\n;undefined;');
    await until("document.querySelectorAll('.agents-card').length===3",'Agent overview renders');
    if (process.argv.includes('--welcome')) {
      await require('./helpers/agent-welcome.cjs')({ run, until, pause, win, root });
      assert.deepEqual(errors, []); return;
    }
    if (process.argv.includes('--marketplace')) {
      await require('./helpers/agent-marketplace.cjs')({ run, until, pause, win, root });
      assert.deepEqual(errors, []); return;
    }
    if (process.argv.includes('--connection-status')) {
      await require('./helpers/agent-connection-status.cjs')({ run, until, pause, win, root });
      assert.deepEqual(errors, []); return;
    }
    if (process.argv.includes('--recovery')) {
      await require('./helpers/agent-connection-recovery.cjs')({ run, until, pause });
      assert.deepEqual(errors, []); return;
    }
    if (process.argv.includes('--switching')) {
      await require('./helpers/agent-session-switching.cjs')({ run, until, pause });
      assert.deepEqual(errors, []); return;
    }
    if (process.argv.includes('--images')) {
      await require('./helpers/agent-chat-regressions.cjs')({ run, until, pause, win, root });
      assert.deepEqual(errors, []); return;
    }
    await run("cardbushDesktop.sshConnections={list:async()=>[{id:'ssh-fixture',name:'Server',username:'test',host:'fixture.invalid',port:22}]};document.querySelector('.agents-add').click();undefined;");
    await until("document.querySelectorAll('[role=dialog] select').length===2",'new Agent defaults to SSH');
    assert.equal(await run("document.querySelector('[role=dialog] select').value"),'ssh');
    await until("document.querySelectorAll('[role=dialog] select')[1].value==='ssh-fixture'",'single SSH connection is preselected');
    assert.equal(await run("!!document.querySelector('[role=dialog] input[type=url]')"),false);
    assert.equal(await run("!!document.querySelector('.agent-remove-action')"),false,'new connections have no removal action');
    await pause(120); fs.writeFileSync(path.join(root,'tmp/agents-add-ssh-default.png'),(await win.webContents.capturePage()).toPNG());
    await run("var mode=document.querySelector('[role=dialog] select');mode.value='direct';mode.dispatchEvent(new Event('change',{bubbles:true}));undefined;");
    await until("!!document.querySelector('[role=dialog] input[type=url]')",'HTTP remains available explicitly');
    await run("[...document.querySelectorAll('[role=dialog] button')].find(b=>b.textContent==='取消').click()");
    await run(`window.originalConnect=cardbushDesktop.agents.connect;cardbushDesktop.agents.connect=async()=>{throw Error("Error invoking remote method 'agents:command': Error: 无法连接 Agent（http://127.0.0.1:14780）：连接被拒绝，请先启动本机隧道。 [ECONNREFUSED]")};undefined;`);
    await run("document.querySelector('.agents-card').click()");
    await until("document.querySelector('.agents-view [role=alert]')?.textContent.includes('ECONNREFUSED')",'actionable connection failure');
    assert.equal(await run("document.body.textContent.includes(\"Error invoking remote method\")"),false,'IPC details stay out of the view and sidebar errors');
    await run("cardbushDesktop.sshConnections={list:async()=>[{id:'ssh-fixture',name:'Server',username:'test',host:'fixture.invalid',port:22}]};[...document.querySelectorAll('.agents-view [role=alert] button')].find(b=>b.textContent==='连接设置').click();undefined;");
    await until("!!document.querySelector('[role=dialog]')",'offline connection settings open');
    assert.equal(await run("document.querySelector('[role=dialog] select').value"),'direct','existing HTTP connections retain their mode');
    assert.equal(await run("[...document.querySelectorAll('.agents-view > .agents-error button')].some(b=>b.textContent==='移除此连接')"),false,'removal is no longer mixed into connection errors');
    await run("document.querySelector('.agent-remove-action').click()");
    await until("document.querySelector('.agent-connection-removal')?.textContent.includes('运行任务都会保留')",'removal explains the effect without touching remote work');
    await run("[...document.querySelectorAll('.agent-connection-removal button')].find(b=>b.textContent==='取消移除').click()");
    await run("var mode=document.querySelector('[role=dialog] select');mode.value='ssh';mode.dispatchEvent(new Event('change',{bubbles:true}));undefined;");
    await until("document.querySelectorAll('[role=dialog] select').length===2",'SSH settings appear');
    await run("var host=document.querySelectorAll('[role=dialog] select')[1];host.value='ssh-fixture';host.dispatchEvent(new Event('change',{bubbles:true}));undefined;");
    assert.equal(await run("!!document.querySelector('[role=dialog] input[type=url]')"),false,'SSH direct does not ask for a local address');
    assert.equal(await run("document.querySelector('[role=dialog] input[type=password]').required"),false,'saved token is retained without exposing it');
    await pause(150);
    fs.writeFileSync(path.join(root,'tmp/agents-tunnel-settings.png'),(await win.webContents.capturePage()).toPNG());
    await pause(30); await run("document.querySelector('[role=dialog]').requestSubmit()");
    await until("!document.querySelector('[role=dialog]')&&!!document.querySelector('.agents-view [role=alert]')",'offline settings saved');
    const tunnelSave=await run("calls.find(c=>c.operation==='save').input");
    assert.equal(tunnelSave.id,'a'); assert.deepEqual(tunnelSave.sshTunnel,{connectionId:'ssh-fixture',remoteHost:'127.0.0.1',remotePort:4780});
    assert.equal(tunnelSave.token,undefined);
    assert.equal(tunnelSave.url,undefined,'SSH settings only submit the remote target');
    await run("cardbushDesktop.agents.connect=originalConnect;[...document.querySelectorAll('.agents-view [role=alert] button')].find(b=>b.textContent==='重试').click()");
    await until("!document.querySelector('.agents-view [role=alert]')&&!!document.querySelector('.agents-empty h2')",'connection retry recovers');
    await until("!!document.querySelector('.agent-sidebar-row.active .row-new-chat')",'connect A');
    await until("!!document.querySelector('[data-agent-id=a] .agent-sidebar-empty')",'an Agent with only internal sessions still offers a new conversation');
    assert.equal(await run("document.querySelectorAll('[data-agent-id=a] .remote-conversation').length"),0,'saved child sessions never become sidebar conversations');
    await run("document.querySelector('.agent-sidebar-row.active .row-new-chat').click()");
    await until("!!document.querySelector('.agent-chat .composer-stack textarea')",'create session on A');
    assert.equal(await run("document.querySelector('.agent-chat .permission-center-button').textContent.trim()"),'申请批准','legacy home access migrates to approval mode');
    await run("document.querySelector('.agent-chat .permission-center-button').click()");
    await until("document.querySelectorAll('.permission-mode-row').length===2",'only two permission modes are offered');
    assert.deepEqual(await run("[...document.querySelectorAll('.permission-mode-row strong')].map(item=>item.textContent)"),['申请批准','完全访问']);
    await run("document.querySelector('.permission-mode-row.mode-all_free').click()");
    await until("localStorage.getItem('a:cardbush.permission_mode')==='all_free'",'full access persists on the selected Agent');
    await run("document.querySelector('.agent-chat .permission-center-button').click()");
    await until("!!document.querySelector('.permission-mode-row.mode-all_free.active')",'full access remains selected when reopening');
    await until("document.querySelector('.agent-chat .permission-center-button').textContent.trim()==='完全访问'",'composer reflects the selected mode');
    await pause(200);
    await new Promise(resolve => { win.webContents.once('paint', resolve); win.webContents.invalidate(); });
    fs.writeFileSync(path.join(root,'tmp/agents-permission-modes.png'),(await win.webContents.capturePage()).toPNG());
    await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await until("document.querySelectorAll('[data-agent-id=a] .remote-conversation').length===1",'refresh lists only the new user conversation');
    assert.equal(await run("document.querySelector('[data-agent-id=a]').textContent.includes('Internal child')"),false);
    assert.equal(await run("cardbushDesktop.agents.call('a','sessions.get',{sessionId:'child-a'}).then(session=>session.metadata.agentRole)"),'child','child records remain available to task details');
    const setDraft = async text => { await run(`var field=document.querySelector('.agent-chat .composer-stack textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,${JSON.stringify(text)});field.dispatchEvent(new Event('input',{bubbles:true}));undefined;`); await pause(30); };
    await run("document.querySelector('.agent-chat .model-select').click()");
    await run("[...document.querySelectorAll('.model-picker-row')].find(button=>button.textContent.includes('管理模型')).click()");
    await until("!!document.querySelector('.settings-shell [name=agent-vision-mode] + button')",'remote model settings expose the shared vision switch');
    assert.equal(await run("document.querySelectorAll('.settings-shell .model-row').length"),1,'remote settings reuse the compact model list');
    assert.equal(await run("document.querySelector('.settings-shell .model-form-disclosure').getAttribute('aria-expanded')"),'false');
    assert.equal(await run("document.querySelectorAll('.settings-shell .model-form').length"),0,'model credentials and add form start collapsed');
    assert.equal(await run("document.querySelector('.settings-shell').textContent.includes('移除此连接')"),false,'model settings do not contain connection removal');
    await pause(120); fs.writeFileSync(path.join(root,'tmp/agents-models-progressive.png'),(await win.webContents.capturePage()).toPNG());
    await run("document.querySelector('.settings-shell .model-form-disclosure').click()");
    await until("!!document.querySelector('.settings-shell .model-form input[aria-label=\"模型名称\"]')",'adding opens the shared settings inputs');
    assert.equal(await run("!!document.querySelector('.settings-shell .model-form input[aria-label=\"上下文上限\"]')"),false,'advanced limits are progressively disclosed');
    await run("[...document.querySelectorAll('.settings-shell .model-form button')].find(b=>b.textContent==='取消').click()");
    assert.equal(await run("document.querySelector('.settings-shell [name=agent-vision-mode] + button').value==='on'"),false,'vision is opt-in per Agent');
    assert.equal(await run("document.querySelector('.settings-shell [name=agent-vision-mode] + button').disabled"),false,'current services support vision');
    await run("document.querySelector('.settings-shell [name=agent-vision-mode] + button').click();setTimeout(()=>document.querySelector('.settings-dropdown-popover:popover-open [value=on]').click(),30)");
    await until("JSON.parse(localStorage.getItem('cardbush-agent-preferences:a'))?.visionEnabled===true",'vision is saved without submitting model credentials');
    assert.equal(await run("calls.some(c=>c.operation==='product.command'&&c.input.kind==='models.update')"),false,'vision is a conversation preference');
    await pause(200);
    fs.writeFileSync(path.join(root,'tmp/agents-vision-settings.png'),(await win.webContents.capturePage()).toPNG());
    await run("(document.querySelector('.settings-shell .back-button')??document.querySelector('.agent-manage')).click()");
    await until("!!document.querySelector('.agent-chat .composer-stack textarea')",'return after enabling vision');
    await run("document.querySelector('.agent-chat .model-select').click()");
    await until("!!document.querySelector('.model-reasoning-primary-options button:last-child')",'cloud reasoning uses the shared picker');
    await run("document.querySelector('.model-reasoning-primary-options button:last-child').click()");
    await until("localStorage.getItem('a:cardbush.reasoning_level')==='max'",'reasoning choice persists on A');
    await run("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
    await setDraft('A 的工作');
    await run("failSend=true;document.querySelector('.agent-chat .composer-stack .send-button').click()");
    await until("document.querySelector('[role=alert]')?.textContent.includes('Fixture disconnected')",'uncertain send is visible');
    assert.deepEqual(await run("calls.find(c=>c.operation==='chat.send').input.conversationStyle"),{mode:'concise',customTone:''},'cloud send inherits the local response style when supported');
    const failedId = await run("calls.filter(c=>c.operation==='chat.send').at(-1).input.requestId");
    await run("[...document.querySelectorAll('.fixture-nav button')].find(b=>b.textContent==='Select B').click()");
    await until("document.querySelector('.agent-sidebar-row.active .project-title')?.textContent==='Research Agent' && !!document.querySelector('.agent-sidebar-row.active .row-new-chat')",'switch to B');
    await run("document.querySelector('.agent-sidebar-row.active .row-new-chat').click()");
    await until("!!document.querySelector('.agent-chat .composer-stack textarea')",'B session');
    assert.equal(await run("document.querySelector('.agent-chat .permission-center-button').textContent.trim()"),'完全访问','existing full access survives on another Agent');
    assert.equal(await run("document.querySelector('.agent-chat .composer-stack textarea').value"),'','same session ID cannot share drafts across Agents');
    assert.equal(await run("localStorage.getItem('b:cardbush.reasoning_level')||'medium'"),'medium','Agents keep independent reasoning preferences');
    assert.equal(await run("JSON.parse(localStorage.getItem('cardbush-agent-preferences:b'))?.visionEnabled"),undefined,'B keeps inheriting the global default instead of A’s override');
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
    assert.equal(await run("calls.filter(c=>c.operation==='chat.send').at(-1).input.permissionMode"),'all_free','the shared picker controls the actual server request');
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
    assert.equal(await run("(document.querySelector('.agent-chat .message-list').textContent.match(/A 的工作/g)||[]).length"), 1, 'durable retry replaces its failed optimistic bubble');
    assert.ok(await run("var content=document.querySelector('.agent-chat .message-list').textContent;content.indexOf('A 的工作')<content.indexOf('实时第一段')"), 'initial input remains before streamed events despite remote clock skew');
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
    assert.ok(await run("var content=document.querySelector('.agent-chat .message-list').textContent;content.indexOf('第二轮正文')<content.indexOf('请调整执行方向')&&content.indexOf('请调整执行方向')<content.indexOf('已按引导调整')"), await run("document.querySelector('.agent-chat .message-list').textContent"));
    assert.equal(await run("document.querySelectorAll('.guidance-delivery-status').length"),1,'guidance receipt and applied event do not duplicate the user bubble');

    await run("(document.querySelector('.settings-shell .back-button')??document.querySelector('.agent-manage')).click()");
    await until("!!document.querySelector('.settings-shell')",'leave active guided conversation');
    const readersBeforeReplay=await run('readers.length');
    await run("sessionStorage.removeItem('cardbush-agent-guidance:a:same-session');(document.querySelector('.settings-shell .back-button')??document.querySelector('.agent-manage')).click()");
    assert.equal(await run('readers.length'), readersBeforeReplay, 'settings keep the existing stream reader alive');
    await run("[...document.querySelectorAll('.fixture-nav button')].find(b=>b.textContent==='Select B').click()");
    await until("document.querySelector('.agent-chat h1')?.textContent !== 'A 的工作'", 'leave A for replay');
    await run("[...document.querySelectorAll('.fixture-nav button')].find(b=>b.textContent==='Select A').click()");
    await until("document.querySelector('.agent-chat .message-list')?.textContent.includes('已按引导调整')", 'guided transcript survives switching Agents');
    assert.equal(await run('readers.length'), readersBeforeReplay, 'switching Agents preserves the existing event reader');
    assert.equal(await run('readers.at(-1).stopped'), false);
    await run("readers.at(-1).listener({type:'error',error:'transport interruption after navigation'})");
    await until(`readers.length>${readersBeforeReplay} && readers.at(-1).id==='a'`, 'transport interruption still reconnects after switching Agents');
    assert.equal(await run('readers.at(-1).request.afterSequence'), 28, 'reconnection retains the cursor across navigation');
    await run(`readers.at(-1).listener({type:'event',event:{kind:'assistant_segment_completed',sequence:25,payload:{messageId:'msg-second',segmentId:'second',ordinal:1,content:'第二轮正文'}}});readers.at(-1).listener({type:'event',event:{kind:'tool_returned',sequence:26,payload:{assistantMessageId:'msg-second',toolCallId:'second-tool',toolName:'terminal_exec'}}});readers.at(-1).listener({type:'event',event:{kind:'guidance_applied',sequence:27,payload:{messageId:${JSON.stringify(originalGuidance.messageId)},previousAssistantMessageId:'msg-second',queueDepth:0,afterRound:2}}});readers.at(-1).listener({type:'event',event:{kind:'assistant_segment_completed',sequence:28,payload:{messageId:'msg-after-guide',segmentId:'after-guide',ordinal:1,content:'已按引导调整'}}});undefined;`);
    await until("document.querySelector('.agent-chat .message-list').textContent.includes('请调整执行方向')&&!!document.querySelector('.guidance-delivery-status.sent')",'replay restores the applied guidance body from the remote service without local storage');
    assert.equal(await run("calls.filter(c=>c.input?.kind==='runtime.enqueue_guidance').length"),2,'history reconstruction never resubmits guidance');

    fs.writeFileSync(path.join(root,'tmp/agents-chat-sidebar.png'),(await win.webContents.capturePage()).toPNG());
    assert.equal(await run("document.querySelectorAll('.agent-conversations,.agent-tabs,.lucide-bot').length"),0,'no nested sidebar, duplicate navigation or robot avatar');
    assert.equal(await run("document.querySelector('.remote-conversation').draggable"),false,'remote conversations cannot be dragged into local projects');
    await until("!!document.querySelector('.agent-chat .composer-stack .send-button:not(:disabled)')",'stop is ready after the interaction closes');
    await run("document.querySelector('.agent-chat .composer-stack .send-button').click()");
    await until("calls.some(c=>c.operation==='chat.stop'&&c.id==='a')",'explicit stop routes to A');
    await run("(document.querySelector('.settings-shell .back-button')??document.querySelector('.agent-manage')).click()");
    await until("!!document.querySelector('.settings-shell')",'Agent settings');
    assert.ok(await run("!!document.querySelector('.agent-chat')"),'opening settings preserves the mounted chat');
    await run("document.querySelector('[data-settings-section=profile]').click()");
    await until("document.querySelector('#global-agent-instructions')?.value==='# Rules for a'",'instructions belong to A');
    fs.mkdirSync(path.join(root,'tmp'),{recursive:true});fs.writeFileSync(path.join(root,'tmp/agents-settings-ui.png'),(await win.webContents.capturePage()).toPNG());
    await run("(document.querySelector('.settings-shell .back-button')??document.querySelector('.agent-manage')).click()");
    await until("!!document.querySelector('.agent-chat .composer-stack')",'return chat');
    await run("document.querySelector('.agent-chat .model-select').click()");
    assert.equal(await run("document.querySelector('.model-reasoning-primary-options button:last-child').classList.contains('active')"),true,'reasoning selection survives settings and session remount');
    await run("[...document.querySelectorAll('.model-picker-row')].find(button=>button.textContent.includes('管理模型')).click()");
    await until("!!document.querySelector('.settings-shell .model-row')",'Manage models opens the remote model list directly');
    assert.equal(await run("document.querySelector('.settings-shell [name=agent-vision-mode] + button').value==='on'"),true,'vision preference is restored after switching Agents and views');
    await run("document.querySelector('.settings-shell [name=agent-vision-mode] + button').click();setTimeout(()=>document.querySelector('.settings-dropdown-popover:popover-open [value=off]').click(),30)");
    await until("JSON.parse(localStorage.getItem('cardbush-agent-preferences:a'))?.visionEnabled===false",'vision can be disabled independently of saving model configuration');
    const setLimit = async (label, value) => { await run(`var field=document.querySelector('input[aria-label=${JSON.stringify(label)}]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(String(value))});field.dispatchEvent(new Event('input',{bubbles:true}));undefined;`); await pause(30); };
    await run("document.querySelector('.model-row-disclosure').click()");
    await until("!!document.querySelector('.agent-model-editor')",'model details expand on request');
    assert.equal(await run("document.querySelector('.agent-model-editor input[type=password]').placeholder"),'已保存，留空保留');
    await run("document.querySelector('.model-advanced-disclosure').click()");
    await setLimit('上下文上限',64000); await setLimit('最大输出 tokens',64000);
    await run("document.querySelector('.settings-shell form').requestSubmit()");
    await until("document.querySelector('.settings-shell [role=alert]')?.textContent.includes('必须小于')",'invalid output limit is rejected before saving');
    assert.equal(await run("calls.filter(c=>c.operation==='product.command'&&c.input.kind==='models.update').length"),0);
    await setLimit('最大输出 tokens',16384);
    await run("document.querySelector('.settings-shell form').requestSubmit()");
    await until("document.querySelector('.settings-shell [role=status]')?.textContent.includes('已保存')",'output limit saved on the remote Agent');
    assert.deepEqual(await run("calls.find(c=>c.operation==='product.command'&&c.input.kind==='models.update')"),{id:'a',operation:'product.command',input:{kind:'models.update',config:{defaultModelId:'model',models:[{id:'model',provider:'openai',modelName:'Fixture Model',apiKey:'',baseUrl:'https://api.deepseek.com/v1',hasApiKey:true,maxContextTokens:64000,maxCompletionTokens:16384}]}}});
    await until("!document.querySelector('.agent-model-editor')",'saved model details collapse');
    await setLimit('Fixture Model 最大输出 token',12000);
    await run("document.querySelector('.model-row button[aria-label=\"保存输出上限\"]').click()");
    await until("models.models[0].maxCompletionTokens===12000",'shared inline token control saves to the selected Agent');
    await until("!document.querySelector('.model-form-disclosure').disabled",'model save has settled');
    const chooseProvider = async value => {
      await run("document.querySelector('.settings-shell [role=combobox][aria-label=\"模型商\"]').scrollIntoView({block:'center'})");
      await pause(100);
      await run("document.querySelector('.settings-shell [role=combobox][aria-label=\"模型商\"]').click()");
      await until("!!document.querySelector('.settings-dropdown-popover:popover-open')",'provider choices open');
      await run(`[...document.querySelectorAll('.settings-dropdown-popover:popover-open [role=option]')].find(option=>option.value===${JSON.stringify(value)}).click()`);
    };
    await run("document.querySelector('.model-row-disclosure').click()");
    await until("!!document.querySelector('.agent-model-editor')",'reopen model to change provider');
    await chooseProvider('deepseek');
    assert.equal(await run("models.models[0].provider"),'openai','provider changes remain a draft until saved');
    await run("document.querySelector('.settings-shell .model-form').requestSubmit()");
    await until("!document.querySelector('.agent-model-editor')&&models.models[0].provider==='deepseek'",'save provider selection');
    assert.equal(await run("document.querySelector('.model-provider-group > header strong').textContent"),'deepseek','model moves into the selected provider group');
    assert.deepEqual(await run("models"),{defaultModelId:'model',models:[{id:'model',provider:'deepseek',modelName:'Fixture Model',apiKey:'',baseUrl:'https://api.deepseek.com/v1',hasApiKey:true,maxContextTokens:64000,maxCompletionTokens:12000}]},'changing provider retains model identity, endpoint, credentials and limits');
    await run("document.querySelector('.model-row-disclosure').click()");
    await until("document.querySelector('.agent-model-editor [role=combobox]')?.value==='deepseek'",'saved provider is selected when reopened');
    await chooseProvider('anthropic');
    await run("[...document.querySelectorAll('.agent-model-editor button')].find(b=>b.textContent==='取消').click()");
    await until("!document.querySelector('.agent-model-editor')",'cancel provider edit');
    assert.equal(await run("models.models[0].provider"),'deepseek','cancel leaves the saved provider unchanged');
    await run("document.querySelector('.model-form-disclosure').click()");
    await setLimit('模型名称','Second Model');
    await chooseProvider('__custom_provider__');
    assert.equal(await run("document.querySelector('.settings-shell .model-form button[type=submit]').disabled"),true,'custom provider needs a name');
    await setLimit('模型商名称',' My Provider ');
    await run("document.querySelector('.settings-shell .model-form').requestSubmit()");
    await until("document.querySelectorAll('.settings-shell .model-row').length===2",'new model is saved without expanding existing models');
    await until("!document.querySelector('.model-form-disclosure').disabled",'add model has settled');
    assert.equal(await run("models.models[1].provider"),'my-provider','custom names use the native normalization');
    await run("document.querySelector('button[aria-label=\"编辑 Second Model\"]').click()");
    await until("document.querySelector('.agent-model-editor [role=combobox]')?.value==='my-provider'",'custom saved provider is offered in the same dropdown');
    await run("document.querySelector('.agent-model-editor').scrollIntoView({block:'center'})");
    await pause(100);
    fs.writeFileSync(path.join(root,'tmp/agents-model-provider.png'),(await win.webContents.capturePage()).toPNG());
    await run("[...document.querySelectorAll('.agent-model-editor button')].find(b=>b.textContent==='取消').click()");
    await until("!document.querySelector('.agent-model-editor')",'close custom provider editor');
    await run("document.querySelector('.model-use-button').click()");
    await until("models.defaultModelId!== 'model'",'default model can be selected from its row');
    await until("!document.querySelector('.model-form-disclosure').disabled",'default model save has settled');
    await run("document.querySelector('button[aria-label=\"删除 Second Model\"]').click()");
    await until("models.defaultModelId==='model'&&models.models.length===1",'removing the default model keeps a valid remaining default');
    await until("!document.querySelector('.model-form-disclosure').disabled",'remove model has settled');
    await run("(document.querySelector('.settings-shell .back-button')??document.querySelector('.agent-manage')).click()");
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
    assert.deepEqual(await run("Array.from(document.querySelector('[role=dialog] select').options,option=>option.value)"),['ssh','direct'],'SSH is the default, with explicit HTTP support');
    await run("var mode=document.querySelector('[role=dialog] select');mode.value='direct';mode.dispatchEvent(new Event('change',{bubbles:true}));undefined;");
    await until("!!document.querySelector('[role=dialog] input[type=url]')",'select direct HTTP when adding an HTTP Agent');
    await run("var fields=document.querySelectorAll('[role=dialog] input');['HTTP Agent','http://127.0.0.1:4782','fixture-token'].forEach((value,i)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(fields[i],value);fields[i].dispatchEvent(new Event('input',{bubbles:true}))});undefined;");
    await pause(30); await run("document.querySelector('[role=dialog]').requestSubmit()");
    await until("!document.querySelector('[role=dialog]')&&document.querySelector('.agent-sidebar-row.active .project-title')?.textContent==='HTTP Agent'",'HTTP connection is saved');
    const saved = await run("calls.find(c=>c.operation==='save'&&c.input.name==='HTTP Agent').input");
    assert.equal(saved.transport,'http'); assert.equal(saved.url,'http://127.0.0.1:4782'); assert.ok(!('command' in saved));
    await run("delayA=true;[...document.querySelectorAll('.fixture-nav button')].find(b=>b.textContent==='Select B').click()");
    await until("document.querySelector('.agent-sidebar-row.active .project-title')?.textContent==='Research Agent' && !!document.querySelector('.agent-sidebar-group:has(.agent-sidebar-row.active) .remote-conversation')",'B returns');
    await run("document.querySelector('.agent-sidebar-group:has(.agent-sidebar-row.active) .remote-conversation').click()");
    await until("document.querySelector('.agent-chat .composer-stack textarea')?.value==='B 的草稿'",'B draft preserved');
    assert.equal(await run("document.querySelector('.agent-chat').textContent.includes('A 的工作')"),false,'A transcript never appears on B');
    assert.equal(await run("!!document.querySelector('.agent-chat .welcome-composer')"),true,'empty B restores its draft on the shared welcome page');
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
    const hoverSidebar = async selector => {
      const point = await run(`(() => { const element=document.querySelector(${JSON.stringify(selector)}); element.scrollIntoView({block:'nearest'}); const r=element.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`);
      win.webContents.sendInputEvent({type:'mouseMove',...point}); await pause(150); return point;
    };
    const clickSidebar = async selector => {
      const point=await hoverSidebar(selector);
      win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
      win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
    };
    win.webContents.sendInputEvent({type:'mouseMove',x:600,y:20}); await pause(150);
    assert.equal(await run("getComputedStyle(document.querySelector('[data-agent-id=b] .agent-tree-chevron')).opacity"),'0','Agent arrow is hidden at rest');
    await hoverSidebar('[data-agent-id=b] .agent-sidebar-row');
    assert.equal(await run("getComputedStyle(document.querySelector('[data-agent-id=b] .agent-tree-chevron')).opacity"),'1','Agent arrow appears on hover');
    assert.notEqual(await run("getComputedStyle(document.querySelector('[data-agent-id=b] .agent-sidebar-row')).backgroundColor"),'rgba(0, 0, 0, 0)','Agent hover has a background even when its chat is active');
    assert.ok(await run("(() => { const row=document.querySelector('[data-agent-id=b] .agent-sidebar-row'); return row.querySelector('.row-new-chat').getBoundingClientRect().right<=row.querySelector('.row-archive').getBoundingClientRect().left && row.querySelector('.row-archive').getBoundingClientRect().right<=row.querySelector('.agent-tree-chevron').getBoundingClientRect().left; })()"),'new chat, settings and trailing arrow have separate hit areas');
    await hoverSidebar('[data-agent-id=b] .remote-conversation');
    assert.equal(await run("getComputedStyle(document.querySelector('[data-agent-id=b] .agent-tree-chevron')).opacity"),'0','Agent arrow disappears when pointer leaves');
    assert.equal(await run("getComputedStyle(document.querySelector('[data-agent-id=b] .conversation-pin')).opacity"),'1','remote rows reveal native pin action');
    assert.equal(await run("getComputedStyle(document.querySelector('[data-agent-id=b] .conversation-archive')).opacity"),'1','remote rows reveal native archive action');
    assert.equal(await run("!!document.querySelector('[data-agent-id=a] .conversation-pin')"),false,'older services without management do not show inert actions');
    fs.writeFileSync(path.join(root,'tmp/agent-sidebar-hover.png'),(await win.webContents.capturePage()).toPNG());
    await clickSidebar('[data-agent-id=b] .conversation-pin'); await until("snapshots.b[0].metadata.pinned===true",'inline pin persists on B');
    await remoteMenu('取消置顶'); await until("snapshots.b[0].metadata.pinned===false",'context menu shares inline pin state');
    await remoteMenu('置顶对话'); await until("snapshots.b[0].metadata.pinned===true",'pin remains available from context menu');
    await remoteMenu('标记为未读'); await until("!!document.querySelector('[data-agent-id=b] .conversation-unread-indicator')",'remote unread indicator');
    await hoverSidebar('[data-agent-id=b] .remote-conversation');
    await clickSidebar('[data-agent-id=b] .conversation-archive'); await until("!document.querySelector('[data-agent-id=b] .remote-conversation')",'inline archive removes chat from ordinary list');
    assert.equal(await run("document.querySelector('[data-agent-id=b]').textContent.includes('已归档对话')"),false,'archive collection is absent from the sidebar');
    assert.ok(await run("!!document.querySelector('[data-agent-id=b] .agent-sidebar-empty')"),'an Agent with only archived chats still offers a new conversation');
    await run("localStorage.setItem('cardbush_archived_conversation_ids',JSON.stringify(['same-session']));document.querySelector('.agent-manage').click()");
    await until("!!document.querySelector('.settings-shell [data-settings-section=cache]')",'open Agent settings');
    await run("document.querySelector('.settings-shell [data-settings-section=cache]').click()");
    await until("document.querySelectorAll('.archive-manager-row').length===1",'settings list the archived user conversation');
    assert.equal(await run("document.querySelector('.archive-manager').textContent.includes('child')"),false,'archive settings exclude internal child sessions');
    assert.equal(await run("document.querySelectorAll('.archive-manager-tabs button').length"),1,'remote settings only offer the supported archive type');
    await pause(100); fs.writeFileSync(path.join(root,'tmp/agent-archives-settings.png'),(await win.webContents.capturePage()).toPNG());
    await run(`window.archiveRestoreCall=cardbushDesktop.agents.call;window.failArchiveRestore=true;
      cardbushDesktop.agents.call=async(id,operation,input)=>{
        if(failArchiveRestore&&operation==='sessions.update'&&input.archived===false)throw Error('Fixture restore failed');
        return archiveRestoreCall(id,operation,input);
      };undefined;`);
    await run("document.querySelector('.archive-manager-row button').click()");
    await until("document.querySelector('.archive-manager [role=alert]')?.textContent.includes('Fixture restore failed')",'failed restore remains retryable');
    assert.equal(await run("snapshots.b[0].metadata.archived"),true,'failed restoration does not remove the archive');
    await run("failArchiveRestore=false;document.querySelector('.archive-manager-row button').click()");
    await until("snapshots.b[0].metadata.archived===false && !!document.querySelector('[data-agent-id=b] .remote-conversation')",'settings restore refreshes the matching sidebar');
    assert.equal(await run("document.querySelectorAll('.archive-manager-row').length"),0);
    assert.deepEqual(await run("JSON.parse(localStorage.getItem('cardbush_archived_conversation_ids'))"),['same-session'],'remote restoration does not modify local archives with the same ID');
    await run("cardbushDesktop.agents.call=archiveRestoreCall;document.querySelector('.settings-shell .back-button').click()");
    await until("!document.querySelector('.settings-shell')",'return from archive settings');
    assert.equal(await run("snapshots.a[0].metadata.pinned"),undefined,'same raw session ID on A stays unaffected');
    await run("document.querySelector('[data-agent-id=b] .project-row').click()");
    assert.equal(await run("document.querySelector('[data-agent-id=b] .project-row').getAttribute('aria-expanded')"),'false','collapse Agent');
    await run("document.querySelector('[data-agent-id=b] .project-row').click()");
    await until("!!document.querySelector('[data-agent-id=b] .remote-conversation')",'expand Agent');
    assert.equal(await run("document.querySelectorAll('[data-agent-id=b] .remote-conversation').length"),1,'reloading the Agent keeps child sessions out of the sidebar');
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
    await until("!!document.querySelector('.settings-shell [name=agent-vision-mode] + button')",'legacy service still shows vision setting');
    assert.equal(await run("document.querySelector('.settings-shell [name=agent-vision-mode] + button').disabled"),true,'legacy service cannot turn vision on');
    assert.equal(await run("document.querySelector('.settings-shell [name=agent-vision-mode] + button').value==='on'"),false,'unsupported stored preference is not shown as enabled');
    assert.ok(await run("document.querySelector('.settings-shell .settings-select-row').textContent.includes('更新 Agent')"),'legacy capability has an actionable explanation');
    await run("(document.querySelector('.settings-shell .back-button')??document.querySelector('.agent-manage')).click()");
    await until("!!document.querySelector('.agent-chat .composer-stack textarea')",'return to legacy service chat');
    await run("window.originalCall=cardbushDesktop.agents.call;window.rejectRefresh=true;cardbushDesktop.agents.call=async(id,operation,input)=>{if(id==='c'&&operation==='sessions.list'&&rejectRefresh){rejectRefresh=false;throw Error('Fixture list refresh failed')}return originalCall(id,operation,input)};undefined;");
    await setDraft('刷新失败也已发送'); await run("document.querySelector('.agent-chat .composer-stack .send-button').click()");
    await until("(window.refreshErrorText=document.querySelector('.agent-chat [role=alert]')?.textContent)?.includes('会话列表刷新失败')",'refresh failure is reported separately');
    assert.equal(await run("refreshErrorText.includes('可重试发送')"),false,'refresh failure must not request resending');
    assert.equal(await run("jobs.c.length"),1,'one message accepted');
    assert.equal(await run("'reasoningEffort' in calls.find(c=>c.id==='c'&&c.operation==='chat.send').input"),false,'old services receive the original compatible request');
    assert.equal(await run("'visionEnabled' in calls.find(c=>c.id==='c'&&c.operation==='chat.send').input"),false,'old services never receive the unsupported vision field even with a stored enabled preference');
    assert.equal(await run("calls.filter(c=>c.operation==='local-runtime').length"),0,'remote components never call the local Runtime');
    assert.equal(await run("sessionStorage.getItem('cardbush-agent-draft:c:same-session:submission')"),null,'accepted submission is cleared despite refresh error');
    assert.equal(await run("document.querySelector('.agent-chat .composer-stack textarea').value"),'','accepted draft stays cleared');
    await run("[...document.querySelectorAll('.agent-header-actions button')].find(b=>b.textContent==='连接设置').click()");
    await until("!!document.querySelector('.agent-remove-action')",'connection removal lives in connection settings');
    await run("window.removeCalls=[];window.originalRemove=cardbushDesktop.agents.remove;cardbushDesktop.agents.remove=async id=>{removeCalls.push(id);return originalRemove(id)};document.querySelector('.agent-remove-action').click();undefined;");
    await until("!!document.querySelector('.agent-connection-removal')",'removal requires explicit confirmation');
    assert.equal(await run('removeCalls.length'),0);
    const callsBeforeRemoval=await run('calls.length');
    await pause(120); fs.writeFileSync(path.join(root,'tmp/agents-remove-connection.png'),(await win.webContents.capturePage()).toPNG());
    await run("[...document.querySelectorAll('.agent-connection-removal button')].find(b=>b.textContent==='确认移除').click()");
    await until("!document.querySelector('[role=dialog]')&&!!document.querySelector('.agents-overview')",'removal returns to Agent overview');
    assert.deepEqual(await run('removeCalls'),['c']);
    assert.equal(await run(`calls.slice(${callsBeforeRemoval}).some(c=>['chat.stop','sessions.delete'].includes(c.operation)||(c.operation==='product.command'&&['models.update','apps.update'].includes(c.input?.kind)))`),false,'removing a connection does not stop tasks or delete server data');
    assert.ok(await run('snapshots.c.length>0&&jobs.c.length>0'),'remote history and jobs are preserved');
    assert.deepEqual(errors,[]);
    console.log('Agents UI passed: shared scroll/rail/alignment/fade, right inspector, native timing/copy/review/revert/restore, sidebar pin/unread/archive/restore, scoped drafts/retries/settings, SSE reconnect, remote file isolation and narrow layouts.');
  } finally { win.destroy(); }
}).then(()=>app.exit(0)).catch(error=>{console.error(error);app.exit(1)});
