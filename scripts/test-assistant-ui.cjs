// Production React controls/theme in an isolated hidden Electron renderer. No accounts or real microphone.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const directory = fs.mkdtempSync(path.resolve('tmp/assistant-ui-'));
  // Keep the native bundler in Node so Electron can close its Windows I/O loop cleanly.
  buildFixture(directory).then(() => {
    const result = require('node:child_process').spawnSync(electron, [__filename, directory], { env, windowsHide: true, stdio: 'inherit', timeout: 60000 });
    if (result.error) console.error(result.error); process.exitCode = result.status ?? 1;
  }).catch(error => { console.error(error); process.exitCode = 1; });
} else {
  runRendererFixture();
}

async function buildFixture(directory) {
  const { build } = await import('vite'), { default: react } = await import('@vitejs/plugin-react');
  const file = value => JSON.stringify(path.resolve(value).replaceAll('\\', '/'));
  const result = await build({ configFile: false, logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [react(), {
    name: 'assistant-fixture', enforce: 'pre', resolveId(source, importer) {
      if (source.endsWith('__assistant_fixture__.tsx')) return '\0assistant-fixture.tsx';
      if (source === './assistantBackend' || source.endsWith('/assistantBackend.ts')) return '\0assistant-backend.ts';
      if (source === '../appCenter/AppCenter' && importer?.endsWith('ChatSidebar.tsx')) return '\0assistant-dock.ts';
      if (source === '../automations/useAutomationUnreadCount') return '\0assistant-unread.ts';
      if (source === '../subagents/useLoopSubagentTasks' && importer?.endsWith('AssistantView.tsx')) return '\0assistant-tasks.ts';
    }, load(id) {
      if (id === '\0assistant-dock.ts') return 'export const AppCenterDock=()=>null;';
      if (id === '\0assistant-unread.ts') return 'export const useAutomationUnreadCount=()=>0;';
      if (id === '\0assistant-tasks.ts') return `import {useEffect,useState} from 'react';export function useLoopSubagentTasks(){const [,update]=useState(0);useEffect(()=>{const refresh=()=>update(v=>v+1);window.addEventListener('fixture-tasks',refresh);return()=>window.removeEventListener('fixture-tasks',refresh);},[]);return fixture.tasks??[];}`;
      if (id === '\0assistant-backend.ts') return `
        import {splitStreamAttachmentMentions,chatAttachmentsFromOutbound} from ${file('src/shared/chatAttachments.ts')};
        export const assistantBackend={ensure:async()=>({id:'personal-assistant'}),contextVersion:()=>fixture.generation??0,voice:()=>({list:async()=>[],execute:async()=>({})}),
          read:async(after=0)=>({entries:fixture.entries.slice(after),cursor:fixture.entries.length,busy:fixture.busy,error:'',workingTasks:0,generation:fixture.generation??0}),
          reset:async()=>{fixture.resetCount=(fixture.resetCount??0)+1;fixture.generation=(fixture.generation??0)+1;fixture.entries=[];window.dispatchEvent(new Event('cardbush:assistant-reset'));},
          send:async(text,config,spoken)=>{if(fixture.failSend)throw Error('fixture send failed');fixture.sent.push({text,spoken});const input=splitStreamAttachmentMentions(text);fixture.entries.push({id:'user-'+fixture.sent.length,role:'user',content:input.userInput,attachments:await chatAttachmentsFromOutbound(input),createdAt:new Date().toISOString(),source:'text',visibility:'conversation'});}};`;
      if (id === '\0assistant-fixture.tsx') return `
        import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
        import {AssistantView} from ${file('src/features/assistant/AssistantView.tsx')};
        import {saveComponents,useComponents} from ${file('src/features/components/componentStore.ts')};
        import {AssistantBulb} from ${file('src/features/assistant/AssistantBulb.tsx')};
        import {ChatSidebar} from ${file('src/features/sidebar/ChatSidebar.tsx')};
        import {ApplicationVoiceHost,applicationVoiceSession} from ${file('src/features/voice/VoiceConversation.tsx')};
        import {realtimeConversationContext} from ${file('src/features/voice/realtimeAgentBridge.ts')};
        import {useAssistantProfile} from ${file('src/features/assistant/assistantProfile.ts')};
        import ${file('src/styles/theme.css')};import ${file('src/styles/app.css')};import ${file('src/features/voice/voice.css')};
        window.cardbushDesktop={pickAttachments:async()=>['C:/fixture/report.txt'],inspectAttachments:async paths=>paths.map(path=>({path,name:'report.txt',kind:'file',size:100})),
          voice:{settings:async()=>({engine:'cloud',recognitionEngine:'cloud',hasApiKey:true,voice:'female',language:'zh-CN'}),
            cancel:async()=>{},setCallActive:async()=>{},transcribe:async()=>{if(fixture.holdTranscription)await new Promise(resolve=>fixture.releaseTranscription=resolve);return{text:'录音发送也应定位到最新消息'};}}};
        const noop=()=>{};const controls={selectedModel:'fixture',availableModels:[],onModelChange:noop,onConfigureModels:()=>fixture.configure=true,
          referencePlanMode:'off',onReferencePlanModeChange:noop,permissionMode:'task_free',onPermissionModeChange:()=>fixture.permissionChanged=true,
          subagentPermissionRouting:'inherit',onSubagentPermissionRoutingChange:noop,reasoningLevel:'medium',reasoningLevels:['medium'],reasoningLevelAvailable:false,onReasoningLevelChange:noop,
          skills:[],disabledSkillNames:new Set(),onToggleSkill:noop};
        window.fixture={sent:[],entries:[
          {id:'u',role:'user',content:'帮我整理一下重点。',source:'text',visibility:'conversation',createdAt:new Date().toISOString()},
          {id:'legacy-speech',role:'user',content:'不应显示的旧版用户转写',source:'voice',visibility:'conversation',createdAt:new Date().toISOString()},
          {id:'hidden-speech',role:'user',content:'不应显示的新版用户转写',source:'voice',visibility:'internal',createdAt:new Date().toISOString()},
          {id:'speech',role:'assistant',content:'这是不应出现在页面上的口头回复。',source:'voice',visibility:'internal',createdAt:new Date().toISOString()},
          {id:'p',role:'assistant',content:'## 今日重点\\n\\n先确认方向，再逐步推进。\\n\\n- 保留关键资料\\n- 后台任务可以继续执行',source:'page',visibility:'conversation',createdAt:new Date().toISOString()},
          {id:'loop',role:'user',content:'不应显示的工具日志',source:'task',visibility:'internal',createdAt:new Date().toISOString()}
        ],busy:false};
        fixture.callContext=()=>realtimeConversationContext(applicationVoiceSession().target);
        function Fixture(){const [active,setActive]=useState(true),[theme,setTheme]=useState('dark'),[inspector,setInspector]=useState(false),[portal,setPortal]=useState(false),[target,setTarget]=useState(null);const profile=useAssistantProfile(),collection=useComponents();
          fixture.setLayout=(width,flow={afterSend:'bottom',output:'above'})=>saveComponents({...collection,welcomeLayout:width?{viewportHeight:752,items:[{componentId:'system-input',x:(100-width)/2,y:260,width,height:52,inputStyle:'simple',composerFlow:flow}]}:undefined},collection.revision);
          fixture.hide=()=>setActive(false);fixture.show=()=>setActive(true);fixture.theme=setTheme;fixture.portal=setPortal;fixture.inspector=setInspector;
          return <div className={'app theme-'+theme} style={{height:'100vh',display:'flex'}}><ApplicationVoiceHost language="zh">
            <ChatSidebar language="zh" section="assistant" activeConversationId="" projects={[]} conversations={[]} changeReportsByConversation={{}}
              onSectionChange={noop} onConversationChange={noop} onCreateConversation={noop} onAddProject={noop} onProjectAction={noop}
              onDeleteConversation={noop} onRenameConversation={async()=>true} onOpenConversationChanges={noop} onOpenSettings={noop} onOpenSearch={noop}/>
            <section className="main-stage"><AssistantView active={active} language="zh" connections={[{id:'ssh-1',name:'测试服务器',sshTunnel:{connectionId:'ssh'}}]}
              composerControls={controls} prepare={async()=>({sessionId:'personal-assistant',model:'fixture',userInput:''})} onManageHosts={()=>fixture.managed=true} inspectorOpen={inspector} onToggleInspector={()=>{fixture.inspected=true;setInspector(value=>!value);}}
              composerPortalTarget={portal?target:null} browserTabs={[{kind:"browser",tabId:"test-tab",url:"https://example.com",title:"网页参考"}]}/></section>
            {portal&&<aside ref={setTarget} className="inspector-quick-input" style={{position:"fixed",bottom:20,left:300,width:450,zIndex:30}}/>}
          </ApplicationVoiceHost></div>;
        }createRoot(document.getElementById('root')).render(<Fixture/>);`;
    },
  }], build: { write: false, minify: false, lib: { entry: path.resolve('src/__assistant_fixture__.tsx'), name: 'AssistantFixture', formats: ['iife'] } } });
  const output = Array.isArray(result) ? result[0].output : result.output;
  fs.writeFileSync(path.join(directory, 'index.html'), `<html><meta charset="utf-8"><style>${output.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => item.source).join('\n')}</style><div id="root"></div><script>${output.find(item => item.type === 'chunk').code.replaceAll('</script', '<\\/script')}</script></html>`);
}

function runRendererFixture() {
const { app, BrowserWindow } = electron;
const directory = process.argv[2];
if (!directory) throw Error('Run this fixture with node scripts/test-assistant-ui.cjs');
app.setPath('userData', path.join(directory, 'profile')); app.disableHardwareAcceleration();
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => app.exit(1), 55000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1120, height: 800, webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false, offscreen: true } });
  win.webContents.setAudioMuted(true);
  win.webContents.session.setPermissionCheckHandler((_,permission)=>permission==='media');
  win.webContents.session.setPermissionRequestHandler((_,permission,callback)=>callback(permission==='media'));
  const errors = []; win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const read = code => win.webContents.executeJavaScript(code).catch(error => { throw Error(code + '\n' + error + '\n' + errors.join('\n')); });
  const until = async code => { for (let i = 0; i < 150; i++) { if (await read(code)) return; await pause(30); } throw Error('UI timed out: ' + await read('document.body.innerText') + errors.join('\n')); };
  const click = selector => read(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
  const fill = (selector, value) => read(`(()=>{const n=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(n instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})();`);
  try {
    await win.loadFile(path.join(directory, 'index.html')); await until('document.querySelectorAll(".assistant-message").length===2');
    assert.equal(await read('document.body.innerText.includes("口头回复")||document.body.innerText.includes("工具日志")||document.body.innerText.includes("用户转写")'), false);
    await until('document.querySelector(".assistant-message-assistant h2")');
    assert.equal(await read('!!document.querySelector(".assistant-composer-dock .composer-stack.simple")'), true);
    assert.equal(await read('!!document.querySelector(".assistant-composer-dock .assistant-actions")'), false);
    assert.equal(await read('fixture.permissionChanged'), undefined);
    assert.equal(await read('document.querySelector(".assistant-view .topbar").getBoundingClientRect().height'),48,'shared header height');
    assert.ok(await read('Math.abs(document.querySelector(".composer-surface").getBoundingClientRect().width-704)<1'),'shared default input width');
    assert.ok(await read('Math.abs(innerHeight-document.querySelector(".composer-surface").getBoundingClientRect().bottom-20)<1'),'shared bottom inset');
    await click('[data-inspector-toggle]');assert.equal(await read('fixture.inspected'),true);await until('!document.querySelector("[data-inspector-toggle]")');
    await read('fixture.inspector(false);void 0');await until('document.querySelector("[data-inspector-toggle]")');
    await click('[data-work-summary-toggle]');await until('document.querySelector(".conversation-work-summary.soft-panel-visible")');
    await read('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));void 0');await until('!document.querySelector(".conversation-work-summary")');
    await fill('.assistant-composer-dock textarea','@网页参考');await until('document.querySelector(".composer-command-palette")?.textContent.includes("网页参考")');
    await fill('.assistant-composer-dock textarea','');
    await fill('.assistant-composer-dock textarea','快速输入仍属于助手');await read('fixture.portal(true);void 0');
    await until('document.querySelector(".inspector-quick-input textarea")');
    assert.equal(await read('document.querySelectorAll(".composer-stack").length'),1,'quick input moves the same composer');
    assert.equal(await read('document.querySelector(".inspector-quick-input textarea").value'),'快速输入仍属于助手');
    await read('fixture.portal(false);void 0');await until('document.querySelector(".assistant-composer-dock textarea")');
    assert.equal(await read('document.querySelector(".assistant-composer-dock textarea").value'),'快速输入仍属于助手');
    await fill('.assistant-composer-dock textarea','');

    assert.equal(await read('document.querySelectorAll(".assistant-message-arriving").length'), 0, 'history does not animate on load');
    await read(`fixture.entries.push(
      {id:'call-user',role:'user',content:'通话记忆用户内容',source:'voice',visibility:'internal',createdAt:new Date().toISOString()},
      {id:'call-reply',role:'assistant',content:'通话记忆回答内容',source:'voice',visibility:'internal',createdAt:new Date().toISOString()});void 0`);
    await until('fixture.callContext().some(item=>item.text.includes("通话记忆回答内容"))');
    assert.equal(await read('document.body.innerText.includes("通话记忆")'), false);
    assert.equal(await read('fixture.callContext().some(item=>item.text.includes("通话记忆用户内容"))'), true);
    assert.equal(await read('document.querySelectorAll(".assistant-message").length'), 2);
    assert.equal(await read('document.querySelectorAll(".assistant-message-arriving").length'), 0, 'private transcripts do not animate the page');
    await fill('.assistant-composer-dock textarea', '继续聊聊'); await click('.assistant-composer-dock .send-button[aria-label="发送"]');
    await until('document.querySelectorAll(".assistant-message-user").length===2'); assert.equal(await read('fixture.sent.length'), 1);
    assert.equal(await read('getComputedStyle(document.querySelector(".assistant-message-row:last-child .assistant-message-user>div")).animationName'), 'assistant-bubble-send');
    const settingsButton = 'button[title="助手设置"]', dialog = '.assistant-settings-dialog';
    const bounds = await read('document.querySelector(".composer-surface").getBoundingClientRect().toJSON()');
    await read('document.querySelector(\'button[title="助手设置"]\').focus();void 0');
    await click(settingsButton); await until('document.querySelector(".assistant-settings-dialog:modal")');
    assert.equal(await read('document.activeElement.name'), 'assistant-name');
    assert.deepEqual(await read('document.querySelector(".composer-surface").getBoundingClientRect().toJSON()'), bounds, 'modal does not move the conversation/composer');
    await fill(dialog+' input[name="assistant-name"]', '尚未保存的名称');
    await fill(dialog+' textarea', '尚未保存的交流方式');
    const cancelAvatarPicker = () => read('document.querySelector(".assistant-settings-dialog input[type=file]").dispatchEvent(new Event("cancel",{bubbles:true}));void 0');
    await cancelAvatarPicker();
    assert.ok(await read('document.querySelector(".assistant-settings-dialog:modal")'),'cancelling the file picker must not close assistant settings');
    assert.equal(await read('document.querySelector("input[name=assistant-name]").value'),'尚未保存的名称');
    assert.equal(await read('document.querySelector("textarea[name=assistant-persona]").value'),'尚未保存的交流方式');
    assert.equal(await read('document.querySelector(".assistant-view .topbar h1").textContent'),'assistant','file-picker cancellation does not save drafts');
    const selectAvatar = async (kind = 'image') => {
      await read(`(async()=>{const canvas=document.createElement('canvas');canvas.width=420;canvas.height=300;const ctx=canvas.getContext('2d');ctx.fillStyle='#7596ab';ctx.fillRect(0,0,420,300);ctx.fillStyle='#e9cc85';ctx.beginPath();ctx.arc(210,150,80,0,Math.PI*2);ctx.fill();const blob=await new Promise(resolve=>canvas.toBlob(resolve));const data=new DataTransfer();data.items.add(new File([${kind === 'image' ? 'blob' : kind === 'oversized' ? 'new Uint8Array(8*1024*1024+1)' : "'corrupted'"}], 'avatar.png',{type:'image/png'}));const input=document.querySelector('.assistant-settings-dialog input[type=file]');input.files=data.files;input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    };
    await selectAvatar('corrupted'); await until('document.querySelector(".assistant-settings-error")?.textContent.includes("无法读取")');
    await selectAvatar('oversized'); await until('document.querySelector(".assistant-settings-error")?.textContent.includes("8 MB")');
    await selectAvatar(); await until('document.querySelector(".assistant-avatar-preview img")');
    assert.equal(await read('!!localStorage.cardbush_personal_assistant_avatar_v1'), false, 'selection remains a draft');
    const draftAvatar = await read('document.querySelector(".assistant-avatar-preview img").src');
    await cancelAvatarPicker();
    assert.equal(await read('document.querySelector(".assistant-avatar-preview img").src'),draftAvatar,'cancelling another selection retains the draft avatar');
    await fill(dialog+' input[name="assistant-name"]', 'Cancelled');
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await until('!document.querySelector(".assistant-settings-dialog")');
    assert.equal(await read('document.activeElement.title'), '助手设置', 'closing returns keyboard focus');
    assert.equal(await read('document.querySelector(".assistant-view .topbar h1").textContent'), 'assistant');
    await click(settingsButton); await selectAvatar(); await until('document.querySelector(".assistant-avatar-preview img")');
    await fill(dialog+' input[name="assistant-name"]', 'Lumi'); await fill(dialog+' textarea', '温和、可靠');
    win.webContents.invalidate(); await pause(250);
    fs.writeFileSync(path.join(directory, 'assistant-settings-dark.png'), (await win.webContents.capturePage()).toPNG());
    await read('fixture.theme("bright");void 0'); win.webContents.invalidate(); await pause(250);
    fs.writeFileSync(path.join(directory, 'assistant-settings-light.png'), (await win.webContents.capturePage()).toPNG());
    await read('fixture.theme("dark");void 0'); await click(dialog+' button[type=submit]');
    await until('document.querySelector(".assistant-view .topbar h1").textContent==="Lumi"');
    await until('document.querySelectorAll(".assistant-avatar img").length===2');
    assert.equal(await read('document.querySelector(".assistant-avatar img").src'), await read('localStorage.cardbush_personal_assistant_avatar_v1'));
    assert.equal(await read('JSON.stringify(JSON.parse(localStorage.cardbush_personal_assistant_v1)).includes("data:image")'), false, 'avatar stays out of the inference profile');
    await click(settingsButton); await click('.assistant-avatar-reset'); await click(dialog+' .assistant-settings-close');
    assert.equal(await read('document.querySelectorAll(".assistant-avatar img").length'), 2, 'cancelled restore preserves saved avatar');
    await click(settingsButton); assert.equal(await read('!!document.querySelector(".assistant-avatar-preview img")'), true);
    await click('.assistant-avatar-reset'); await click(dialog+' button[type=submit]');
    await until('!document.querySelector(".assistant-avatar")'); assert.equal(await read('localStorage.cardbush_personal_assistant_avatar_v1'), undefined);
    await click(settingsButton); await read('fixture.hide();void 0'); await until('!document.querySelector(".assistant-settings-dialog")');
    await read('fixture.show();void 0'); await until('!document.querySelector(".assistant-view").hidden');
    assert.equal(await read('!!document.querySelector(\'.nav-row[title="Lumi"]\')'), true);
    await click('.assistant-actions [role=combobox]'); await click('[role=option][data-value="ssh-1"]'.replace('[data-value="ssh-1"]', ':last-child'));
    await until('document.querySelector(".assistant-actions [role=combobox]").textContent.includes("测试服务器")');
    await read('fixture.hide();void 0'); await until('document.querySelector(".assistant-view").hidden');
    await read('fixture.show();fixture.busy=true;void 0'); await until('document.querySelector(".assistant-bulb[data-state=working]")');
    assert.equal(await read('document.querySelectorAll(".assistant-message").length'), 3);
    const dark = await read('getComputedStyle(document.querySelector(".assistant-view")).color');
    await read('fixture.theme("bright");void 0'); await until(`getComputedStyle(document.querySelector('.assistant-view')).color!==${JSON.stringify(dark)}`);
    assert.ok(await read('document.querySelector(".assistant-composer-dock").getBoundingClientRect().bottom<=innerHeight'));
    win.webContents.invalidate(); await pause(500);
    fs.writeFileSync(path.join(directory, 'assistant-light.png'), (await win.webContents.capturePage()).toPNG());
    await read('fixture.theme("dark");void 0'); win.webContents.invalidate(); await pause(500);
    fs.writeFileSync(path.join(directory, 'assistant-dark.png'), (await win.webContents.capturePage()).toPNG());
    await read('fixture.entries=[];fixture.busy=false;void 0');
    await until('document.querySelectorAll(".assistant-message").length===0');
    await fill('.assistant-composer-dock textarea', '清空后继续'); await click('.assistant-composer-dock .send-button[aria-label="发送"]');
    await until('document.querySelectorAll(".assistant-message-user").length===1');
    await click('.assistant-composer-dock .model-select'); assert.equal(await read('fixture.configure'), true);
    await click('.assistant-composer-dock .composer-tools .tool-chip');
    await read('Array.from(document.querySelectorAll(".composer-popover button")).find(n=>n.textContent.includes("文件和文件夹")).click();void 0');
    await until('document.querySelector(".composer-file-strip")?.textContent.includes("report.txt")');
    await fill('.assistant-composer-dock textarea', '看看这个文件');
    await read('fixture.failSend=true;void 0'); await click('.assistant-composer-dock .send-button[aria-label="发送"]');
    await until('document.querySelector(".assistant-view .runtime-status-banner")?.textContent.includes("fixture send failed")');
    assert.equal(await read('document.querySelector(".assistant-composer-dock textarea").value'), '看看这个文件');
    assert.ok(await read('document.querySelector(".composer-file-strip")?.textContent.includes("report.txt")'), 'failed send retains attachments');
    await read('fixture.failSend=false;void 0'); await click('.assistant-composer-dock .send-button[aria-label="发送"]');
    await until('document.querySelectorAll(".assistant-message-user").length===2');
    assert.ok(await read('fixture.sent.at(-1).text.includes("@C:/fixture/report.txt")'));
    assert.equal(await read('document.querySelector(".assistant-message-row:last-child .assistant-message-user .message-file-attachment strong").textContent'), 'report.txt');
    assert.equal(await read('document.querySelector(".assistant-composer-dock textarea").value'), '');
    await read('fixture.entries.push({id:"received",role:"assistant",content:"已读文件。",createdAt:new Date().toISOString(),source:"page",visibility:"conversation"});void 0');
    await until('document.querySelector(".assistant-message-assistant.assistant-message-arriving")');
    assert.equal(await read('getComputedStyle(document.querySelector(".assistant-message-assistant>div")).animationName'), 'assistant-bubble-receive');
    win.setSize(640, 720); await pause(150);
    assert.ok(await read('document.documentElement.scrollWidth<=innerWidth'));
    assert.ok(await read('document.querySelector(".assistant-composer-dock").getBoundingClientRect().bottom<=innerHeight'));
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name:'prefers-reduced-motion', value:'reduce' }] });
    await read('document.querySelector(".assistant-message-assistant").classList.add("assistant-message-arriving");void 0');
    assert.equal(await read('getComputedStyle(document.querySelector(".assistant-message-assistant>div")).animationName'), 'none');
    win.webContents.debugger.detach();
    win.setSize(1120,800);await until('innerWidth===1120');await pause(150);
    const menu=async()=>{await read(`document.querySelector('.nav-row[title="'+document.querySelector('.assistant-view .topbar h1').textContent+'"]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:100,clientY:95}));void 0`);await until('document.querySelector(".sidebar-context-menu")');};
    const choose=label=>read(`Array.from(document.querySelectorAll('.sidebar-context-menu button')).find(button=>button.textContent.trim()===${JSON.stringify(label)}).click();void 0`);
    await menu();assert.equal(await read('document.querySelectorAll(".sidebar-context-menu button").length'),4);
    await choose('麦克风静音');assert.equal(await read('JSON.parse(localStorage.cardbush_personal_assistant_v1).microphoneMuted'),true);
    await menu();await choose('播报静音');assert.equal(await read('JSON.parse(localStorage.cardbush_personal_assistant_v1).outputMuted'),true);
    await menu();assert.ok(await read('document.querySelector(".sidebar-context-menu").textContent.includes("恢复播报")'));
    await choose('取消麦克风静音');assert.equal(await read('JSON.parse(localStorage.cardbush_personal_assistant_v1).microphoneMuted'),false);
    assert.equal(await read('JSON.parse(localStorage.cardbush_personal_assistant_v1).outputMuted'),true,'mute controls are independent');
    await menu();await choose('重命名');await until('document.querySelector(".assistant-rename-dialog[open]")');
    await fill('.assistant-rename-dialog input','Nova');await click('.assistant-rename-dialog button[type=submit]');
    await until('document.querySelector(".assistant-view .topbar h1").textContent==="Nova"');
    assert.ok(await read('!!document.querySelector(\'.nav-row[title="Nova"]\')'));
    await menu();win.webContents.invalidate();await pause(100);
    fs.writeFileSync(path.join(directory,'assistant-context-menu.png'),(await win.webContents.capturePage()).toPNG());
    await choose('重置上下文');await until('document.querySelector(".confirm-action-dialog[open]")');
    await click('.confirm-action-dialog .secondary-button');assert.equal(await read('fixture.resetCount??0'),0);
    await menu();await choose('重置上下文');await until('document.querySelector(".confirm-action-dialog[open]")');
    await click('.confirm-action-dialog .danger');await until('document.querySelectorAll(".assistant-message").length===0');
    assert.equal(await read('fixture.resetCount'),1);
    assert.equal(await read('fixture.callContext().length'),0);
    assert.equal(await read('JSON.parse(localStorage.cardbush_personal_assistant_v1).name'),'Nova');
    assert.equal(await read('JSON.parse(localStorage.cardbush_personal_assistant_v1).targetAgent'),'ssh-1');
    assert.equal(await read('JSON.parse(localStorage.cardbush_personal_assistant_v1).outputMuted'),true);

    await read('fixture.entries.push(...Array.from({length:18},(_,i)=>({id:"history-"+i,role:i%2?"assistant":"user",content:"历史测试段落 "+i+"\\n\\n"+"用于检查滚动和输入框避让。".repeat(12),source:i%2?"page":"text",visibility:"conversation",createdAt:new Date().toISOString()})));void 0');
    await until('document.querySelectorAll(".assistant-message").length===18');await pause(400);
    await read('const list=document.querySelector(".assistant-messages");list.dispatchEvent(new WheelEvent("wheel",{deltaY:-500,bubbles:true}));list.scrollTop=0;void 0');
    await until('document.querySelector(".scroll-bottom").getAttribute("aria-hidden")==="false"');
    await read('fixture.entries.push({id:"while-reading",role:"assistant",content:"新到达的资料",source:"page",visibility:"conversation",createdAt:new Date().toISOString()});void 0');
    await until('document.querySelectorAll(".assistant-message").length===19');await pause(100);
    assert.ok(await read('document.querySelector(".assistant-messages").scrollTop<5'),'incoming messages do not pull the reader away');
    // Recording must use the same explicit-send positioning as text, even after reading history.
    await fill('.assistant-composer-dock textarea','文字发送定位');await click('.assistant-composer-dock .send-button[aria-label="发送"]');
    await until('fixture.sent.at(-1).text==="文字发送定位"');
    await until('document.querySelector(".scroll-bottom").getAttribute("aria-hidden")==="true"');
    await read('(()=>{const list=document.querySelector(".assistant-messages");list.dispatchEvent(new WheelEvent("wheel",{deltaY:-500,bubbles:true}));list.scrollTop=0;fixture.holdTranscription=true;})()');
    await until('document.querySelector(".scroll-bottom").getAttribute("aria-hidden")==="false"');
    await click('.assistant-composer-dock .voice-trigger');await until('document.querySelector(".voice-composer-label")?.textContent==="正在录音"');
    await pause(200);await click('.voice-composer-send');await until('typeof fixture.releaseTranscription==="function"');
    assert.equal(await read('!!document.querySelector(".voice-call-active")'),true,'transcription stays in the recording composer');
    assert.equal(await read('!!document.querySelector(".voice-floating-composer,.voice-mini,.voice-dialog")'),false,'transcription does not switch to an overlay');
    await read('fixture.holdTranscription=false;fixture.releaseTranscription();void 0');
    await until('fixture.sent.at(-1).text==="录音发送也应定位到最新消息"');
    assert.equal(await read('fixture.sent.at(-1).spoken'),false);
    await until('document.querySelector(".scroll-bottom").getAttribute("aria-hidden")==="true"');
    await until('document.activeElement===document.querySelector(".assistant-composer-dock textarea")');
    assert.ok(await read('document.querySelector(".assistant-message-row:last-child").getBoundingClientRect().bottom<document.querySelector(".composer-surface").getBoundingClientRect().top'),'recorded message clears the input after layout settles');
    await click('.scroll-bottom');await until('document.querySelector(".scroll-bottom").getAttribute("aria-hidden")==="true"');
    assert.ok(await read('document.querySelector(".assistant-message-row:last-child").getBoundingClientRect().bottom<document.querySelector(".composer-surface").getBoundingClientRect().top'),'last bubble clears the input');
    await require('./helpers/assistant-scroll.cjs')({ read, until, fill, click, pause, win, directory });
    await read('fixture.setLayout(65);void 0');await pause(150);
    for(const width of [1440,800,1120]){
      win.setSize(width,800);await until('innerWidth==='+width);await pause(200);
      assert.ok(await read('(()=>{const body=document.querySelector(".chat-body").getBoundingClientRect(),input=document.querySelector(".composer-surface").getBoundingClientRect();return Math.abs(input.width-Math.max(280,body.width*.65))<2 && Math.abs((input.left+input.width/2)-(body.left+body.width/2))<2;})()'),'saved input width stays centered on resize: '+JSON.stringify(await read('(()=>{const body=document.querySelector(".chat-body").getBoundingClientRect(),input=document.querySelector(".composer-surface").getBoundingClientRect();return {body:body.toJSON(),input:input.toJSON(),css:document.querySelector(".chat-body").getAttribute("style")};})()')));
    }
    await read('fixture.setLayout(65,{afterSend:"keep",output:"below"});void 0');await until('document.querySelector(".assistant-view.composer-anchored")');
    await read('document.querySelector(".assistant-messages").scrollTop=0;void 0');await pause(100);
    assert.ok(await read('document.querySelector(".assistant-message-row").getBoundingClientRect().top>=document.querySelector(".composer-surface").getBoundingClientRect().bottom'),'saved below-input layout reserves transcript space');
    await read('fixture.setLayout(null);void 0');await until('!document.querySelector(".assistant-view.composer-anchored")');
    await read('fixture.portal(true);void 0');await until('document.querySelector(".inspector-quick-input textarea")');
    await fill('.inspector-quick-input textarea','覆盖模式继续向助手发送');await click('.inspector-quick-input .send-button[aria-label="发送"]');
    await until('fixture.sent.at(-1).text==="覆盖模式继续向助手发送"');
    assert.equal(await read('fixture.sent.at(-1).spoken'),false);
    await read('fixture.portal(false);void 0');await until('document.querySelector(".assistant-composer-dock textarea")');
    assert.equal(await read('document.querySelector(".assistant-composer-dock textarea").value'),'');
    await read(`fixture.tasks=[{taskId:'task-visible',origin:'subagent',parentSessionId:'personal-assistant',childSessionId:'child-execution',parentTurnId:'voice_turn_fixture',requestPrompt:'整理桌面应用清单',status:'running',terminal:false,createdAt:new Date().toISOString(),remote:{agentId:'ssh-1',taskId:'remote-task'}}];window.addEventListener('cardbush:open-work-summary-inspector',e=>fixture.taskDetail=e.detail);window.dispatchEvent(new Event('fixture-tasks'));void 0`);
    await until('document.querySelector(".assistant-task-bubble[data-status=running]")');
    assert.match(await read('document.querySelector(".assistant-task-bubble").textContent'),/整理桌面应用清单/);
    await click('.assistant-task-bubble');
    assert.equal(await read('fixture.taskDetail.kind'),'subagent-task');
    assert.equal(await read('fixture.taskDetail.task.childSessionId'),'child-execution');
    assert.equal(await read('fixture.taskDetail.task.remote.agentId'),'ssh-1','execution inspector receives remote routing unchanged');
    for (const theme of ['dark','bright']) {
      await read(`fixture.theme('${theme}');void 0`);await pause(100);
      assert.notEqual(await read('getComputedStyle(document.querySelector(".assistant-task-bubble")).backgroundColor'),'rgba(0, 0, 0, 0)');
      await click('.scroll-bottom');await pause(150);
      fs.writeFileSync(path.join(directory,'assistant-task-'+theme+'.png'),(await win.webContents.capturePage()).toPNG());
    }
    await read(`fixture.tasks=[{...fixture.tasks[0],status:'completed',terminal:true}];window.dispatchEvent(new Event('fixture-tasks'));void 0`);
    await until('document.querySelector(".assistant-task-bubble[data-status=completed]")');
    await menu();await choose('重置上下文');await until('document.querySelector(".confirm-action-dialog[open]")');
    await click('.confirm-action-dialog .danger');await until('document.querySelectorAll(".assistant-message,.assistant-task-bubble").length===0');
    await read(`fixture.entries.push({id:'after-task-reset',role:'user',content:'重新开始',source:'text',visibility:'conversation',createdAt:new Date().toISOString()});void 0`);
    await until('document.querySelectorAll(".assistant-message").length===1');
    assert.equal(await read('document.querySelectorAll(".assistant-task-bubble").length'),0,'reset does not resurrect earlier tasks');
    assert.deepEqual(errors, []);
    console.log('Assistant UI passed: shared header/docking, inspector/summary, browser references, portal draft, saved layout/resize, scroll follow, simple Composer, host selection, file picker/send/retry, Markdown, private speech, model settings, history, bubble/reduced-motion animations and responsive themes. Screenshots: ' + directory);
  } finally { win.destroy(); clearTimeout(deadline); }
  app.quit();
}).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
}
