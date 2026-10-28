// Real shared Composer in both presentations, with fake-device audio and isolated settings.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),electron=require('electron');
if(typeof electron==='string'){
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const result=require('node:child_process').spawnSync(electron,[__filename],{env,windowsHide:true,stdio:'inherit',timeout:90000});
  if(result.error)console.error(result.error);process.exit(result.status??1);
}
const {app,BrowserWindow}=electron,directory=fs.mkdtempSync(path.resolve('tmp/voice-composer-ui-'));
app.setPath('userData',path.join(directory,'profile'));app.disableHardwareAcceleration();
app.commandLine.appendSwitch('use-fake-device-for-media-stream');app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),deadline=setTimeout(()=>app.exit(1),85000);
app.whenReady().then(async()=>{
  const {build}=await import('vite'),{default:react}=await import('@vitejs/plugin-react');
  const {defaultVoiceSettings}=require('../dist-electron/voiceTypes.js');
  const file=name=>JSON.stringify(path.resolve(name).replaceAll('\\','/'));
  const result=await build({configFile:false,logLevel:'error',define:{'process.env.NODE_ENV':'"production"'},plugins:[react(),{
    name:'voice-composer-fixture',resolveId:id=>id.endsWith('__voice_composer_fixture__.tsx')?'\0voice-composer-fixture.tsx':undefined,
    load:id=>id==='\0voice-composer-fixture.tsx'?`
      import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
      import {ApplicationVoiceHost,VoiceConversation,applicationVoiceSession} from ${file('src/features/voice/VoiceConversation.tsx')};
      import {Composer} from ${file('src/features/composer/Composer.tsx')};
      import {ComposerPresentationContext} from ${file('src/features/composer/ComposerPresentationContext.ts')};
      import {ComposerPortalContext} from ${file('src/features/composer/ComposerPortalContext.ts')};
      import ${file('src/styles/theme.css')};import ${file('src/styles/app.css')};
      window.fixture={cancelled:0,sent:[],frames:0,started:0,closed:0,captures:0,transcriptions:0,tracks:[]};
      const getMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia=async options=>{fixture.captures++;const stream=await getMedia(options);fixture.tracks.push(...stream.getTracks());return stream;};
      const settings=${JSON.stringify({...defaultVoiceSettings,engine:'cloud',recognitionEngine:'cloud',hasApiKey:true,speakerLockEnabled:false})};
      window.cardbushDesktop={pickAttachments:async()=>['C:/fixture/report.txt'],inspectAttachments:async paths=>paths.map(path=>({path,name:'report.txt',kind:'file',size:100})),voice:{settings:async()=>settings,setCallActive:async()=>{},cancel:async()=>{},
        transcribe:async()=>{fixture.transcriptions++;if(fixture.holdTranscription)await new Promise(resolve=>fixture.releaseTranscription=resolve);if(fixture.failTranscription){fixture.failTranscription=false;throw Error('fixture transcription failed');}return{text:'这是录音测试',speakerVerified:true};},speak:async()=>{},onAudio:()=>()=>{},
        realtime:{settings:async()=>({mode:'realtime',hasApiKey:true}),start:async()=>{fixture.started++;if(fixture.failStart)throw Error('fixture connection failed');},audio:async()=>fixture.frames++,control:async()=>{},playback:async()=>{},close:async()=>fixture.closed++,onEvent:()=>()=>{}}}};
      fixture.state=()=>applicationVoiceSession().snapshot();
      const noop=()=>{},controls={selectedModel:'fixture',availableModels:[],onModelChange:noop,onConfigureModels:noop,referencePlanMode:'off',onReferencePlanModeChange:noop,permissionMode:'task_free',onPermissionModeChange:noop,subagentPermissionRouting:'inherit',onSubagentPermissionRoutingChange:noop,reasoningLevel:'medium',reasoningLevels:['medium'],reasoningLevelAvailable:false,onReasoningLevelChange:noop,skills:[],disabledSkillNames:new Set(),onToggleSkill:noop};
      function Fixture(){const [style,setStyle]=useState('standard'),[draft,setDraft]=useState(''),[view,setView]=useState('chat'),[theme,setTheme]=useState('dark'),[sending,setSending]=useState(false),[portal,setPortal]=useState(false),[portalTarget,setPortalTarget]=useState(null);
        fixture.sending=setSending;fixture.draft=setDraft;fixture.style=setStyle;fixture.view=setView;fixture.theme=setTheme;fixture.portal=setPortal;
        const target={environment:'local',sessionId:view,messages:[],sending,...(view==='assistant'?{assistant:{name:'assistant',persona:''}}:{}),send:async text=>{if(fixture.failSend){fixture.failSend=false;throw Error('fixture send failed');}fixture.sent.push(text);return true;}};
        return <div className={'app theme-'+theme} style={{minHeight:'100vh',padding:'90px 20px'}}><ApplicationVoiceHost language="zh">
          <div style={{width:'min(704px,100%)',margin:'0 auto'}}><VoiceConversation language="zh" target={target} active={view!=='hidden'}>
            <ComposerPresentationContext.Provider value={{style,preservePermissions:true}}><ComposerPortalContext.Provider value={portal?portalTarget:null}>
              <Composer {...controls} compact language="zh" draft={draft} onDraftChange={setDraft} sending={sending} referencePlanAvailable={false} onSend={target.send} onCancel={async()=>{fixture.cancelled++;}}/>
            </ComposerPortalContext.Provider></ComposerPresentationContext.Provider>
          </VoiceConversation></div>
          <aside ref={setPortalTarget} className="inspector-quick-input" style={{width:'min(450px,100%)',margin:'0 auto'}}/>
        </ApplicationVoiceHost></div>;
      }createRoot(document.getElementById('root')).render(<Fixture/>);
    `:undefined,
  }],build:{write:false,minify:false,lib:{entry:path.resolve('src/__voice_composer_fixture__.tsx'),name:'VoiceComposerFixture',formats:['iife']}}});
  const output=(Array.isArray(result)?result[0]:result).output;
  fs.mkdirSync(path.join(directory,'voice'));fs.copyFileSync('public/voice/realtime-capture-worklet.js',path.join(directory,'voice/realtime-capture-worklet.js'));
  fs.writeFileSync(path.join(directory,'index.html'),`<html><meta charset="utf-8"><style>${output.filter(item=>item.type==='asset'&&item.fileName.endsWith('.css')).map(item=>item.source).join('\n')}</style><div id="root"></div><script>${output.find(item=>item.type==='chunk').code.replaceAll('</script','<\\/script')}</script></html>`);
  const win=new BrowserWindow({show:false,width:900,height:600,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false,offscreen:true}});
  win.webContents.setAudioMuted(true);
  win.webContents.session.setPermissionCheckHandler((_,permission)=>permission==='media');
  win.webContents.session.setPermissionRequestHandler((_,permission,callback)=>callback(permission==='media'));
  win.webContents.session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)}));
  const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
  const read=code=>win.webContents.executeJavaScript(code);
  const until=async code=>{for(let i=0;i<200;i++){if(await read(code))return;await pause(25);}throw Error('Timed out: '+code+'\n'+await read('document.body.innerText')+'\n'+errors.join('\n'));};
  const click=selector=>read(`document.querySelector(${JSON.stringify(selector)}).click();void 0`);
  const fill=value=>read(`(()=>{const n=document.querySelector('.composer-surface textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(n,${JSON.stringify(value)});n.dispatchEvent(new Event('input',{bubbles:true}));})();`);
  const pointer=async(hold=false)=>{
    const point=await read(`(()=>{const r=document.querySelector('.composer-surface .send-button').getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
    if(hold)await pause(600);
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
  };
  const screenshot=async name=>{win.webContents.invalidate();await pause(300);fs.writeFileSync(path.join(directory,name+'.png'),(await win.webContents.capturePage()).toPNG());};
  try{
    await win.loadFile(path.join(directory,'index.html'));await until('document.querySelector(".voice-dictation-button")');
    const rect=selector=>read('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};})()');
    const point=await rect('.voice-call-trigger');
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:Math.round(point.x+14),y:Math.round(point.y+14)});await pause(100);
    await read('fixture.view("hidden");void 0');await pause(600);
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:Math.round(point.x+14),y:Math.round(point.y+14)});
    assert.equal(await read('fixture.state().mode'),'idle','leaving during a hold must not start a call');
    await read('fixture.view("chat");void 0');await pause(100);
    for(const [index,style] of ['standard','simple'].entries()){
      await read('fixture.style('+JSON.stringify(style)+');fixture.view('+JSON.stringify(index?'assistant':'chat')+');fixture.draft("");void 0');await pause(150);
      const mic=await rect('.voice-dictation-button'),initialCaptures=await read('fixture.captures');
      await screenshot(style+'-idle');
      await pointer();await pause(250);
      assert.equal(await read('fixture.captures'),initialCaptures,'short click on empty primary must not record');
      await fill('保留草稿');await pause(150);
      assert.deepEqual(await rect('.voice-dictation-button'),mic,'typing must not move the microphone');
      await read('fixture.sending(true);void 0');await pause(100);
      assert.deepEqual(await rect('.voice-dictation-button'),mic,'an Agent turn must not move the microphone');
      const sent=await read('fixture.sent.length');
      await click('.voice-dictation-button');await until('fixture.state().phase==="recording"');
      assert.ok(await read('document.querySelector(".voice-dictation-button").classList.contains("is-active")'));
      assert.equal(await read('!!document.querySelector(".voice-mini,.voice-dialog,.voice-composer-call")'),false);
      assert.deepEqual(await rect('.voice-dictation-button'),mic);
      await screenshot(style+'-dictation');await pause(200);
      await read('fixture.holdTranscription=true;fixture.releaseTranscription=undefined;fixture.failTranscription=true;void 0');
      await click('.voice-dictation-button');await until('typeof fixture.releaseTranscription==="function"');
      await fill('识别期间继续编辑');assert.equal(await read('fixture.tracks.every(t=>t.readyState==="ended")'),true);
      await read('fixture.holdTranscription=false;fixture.releaseTranscription();void 0');await until('document.querySelector(".voice-dictation-error")');
      const captures=await read('fixture.captures');
      await click('.voice-dictation-button');await until('fixture.state().mode==="idle"');
      await until('document.querySelector(".composer-surface textarea").value==="识别期间继续编辑 这是录音测试"');
      assert.equal(await read('fixture.sent.length'),sent,'dictation never sends to a running Agent');
      assert.equal(await read('fixture.captures'),captures,'ASR retry reuses the recording');
      await pointer(true);assert.equal(await read('fixture.started'),index,'a hold while the Agent works must not join a call');
      await read('fixture.sending(false);fixture.draft("请保留这段草稿");void 0');await pause(100);
      await click('.composer-tools .tool-chip');
      await read('Array.from(document.querySelectorAll(".composer-popover button")).find(n=>n.textContent.includes("文件和文件夹")).click();void 0');
      await until('document.querySelector(".composer-file-strip")');
      const beforeCall=await rect('.composer-surface .send-button'),beforeSent=await read('fixture.sent.length');
      await pointer(true);await until('fixture.state().phase==="listening"&&document.querySelector(".voice-call-active")');
      assert.equal(await read('fixture.started'),index+1,'one call per long press');
      assert.equal(await read('fixture.sent.length'),beforeSent,'releasing a call hold must not submit the draft');
      assert.equal(await read('document.querySelector(".composer-surface textarea").value'),'请保留这段草稿');
      assert.ok(await read('document.querySelector(".composer-file-strip").textContent.includes("report.txt")'));
      assert.equal(await read('!!document.querySelector(".voice-mini,.voice-dialog,.voice-call-overlay,.voice-floating-composer,.voice-call-undocked")'),false);
      const stop=await rect('.voice-composer-end');assert.ok(Math.abs(stop.x-beforeCall.x)<.5,'stop replaces the same right-hand control');
      assert.ok(await read('getComputedStyle(document.querySelector(".composer-tools")).visibility==="hidden"'));
      assert.ok(await read('document.querySelector(".voice-call-wave path").getAttribute("d").startsWith("M")'));
      await screenshot(style+'-call');
      const startedAt=await read('fixture.state().startedAt'),frames=await read('fixture.frames');
      await read('fixture.view("other");void 0');await until('document.querySelector(".voice-call-undocked")&&!document.querySelector(".voice-call-active")');
      await until('fixture.frames>'+frames+'+4');assert.equal(await read('fixture.state().startedAt'),startedAt);
      await read('fixture.view('+JSON.stringify(index?'assistant':'chat')+');void 0');
      await until('document.querySelector(".voice-call-active")&&!document.querySelector(".voice-call-undocked")');
      await read('fixture.portal(true);void 0');await until('document.querySelector(".inspector-quick-input .voice-call-active")');
      await screenshot(style+'-portal');await read('fixture.portal(false);void 0');
      await until('!document.querySelector(".inspector-quick-input .composer-stack")');
      win.setSize(360,600);await read('fixture.theme("light");void 0');await pause(100);
      assert.ok(await read('document.documentElement.scrollWidth<=innerWidth'));
      assert.ok(await read('(()=>{const a=document.querySelector(".voice-call-signal").getBoundingClientRect(),b=document.querySelector(".voice-composer-end").getBoundingClientRect();return a.width>100&&a.right<=b.left&&b.right<=innerWidth;})()'));
      await screenshot(style+'-call-narrow-light');win.setSize(900,600);
      await click('.voice-composer-end');await until('fixture.state().mode==="idle"&&!document.querySelector(".voice-composer-call")');
      assert.equal(await read('fixture.cancelled'),0,'ending voice must not cancel the Agent');
      assert.equal(await read('document.querySelector(".composer-surface textarea").value'),'请保留这段草稿');
      await click('.send-button');await until('document.querySelector(".composer-surface textarea").value===""');
      assert.ok(await read('fixture.sent.at(-1).includes("@C:/fixture/report.txt")'));
      await read('fixture.theme("dark");void 0');
      await click('.voice-dictation-button');await until('fixture.state().phase==="recording"');await pause(200);
      await read('fixture.holdTranscription=true;fixture.releaseTranscription=undefined;void 0');await click('.voice-dictation-button');await until('typeof fixture.releaseTranscription==="function"');
      await click('.voice-dictation-button');await until('fixture.state().mode==="idle"');
      await fill('取消后新草稿');await read('fixture.holdTranscription=false;fixture.releaseTranscription();void 0');await pause(100);
      assert.equal(await read('document.querySelector(".composer-surface textarea").value'),'取消后新草稿');
    }
    const beforeKeyboard=await read('fixture.sent.length');
    await read('document.querySelector(".voice-call-trigger").focus();void 0');
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'ENTER'});await pause(100);
    assert.equal(await read('document.querySelector(".voice-call-trigger").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",repeat:true,bubbles:true,cancelable:true}))'),false,'key repeat must not submit the draft');
    await until('fixture.state().mode==="call"');win.webContents.sendInputEvent({type:'keyUp',keyCode:'ENTER'});
    assert.equal(await read('fixture.sent.length'),beforeKeyboard);
    await click('.voice-composer-end');await until('fixture.state().mode==="idle"');
    await click('.voice-dictation-button');
    await read('document.querySelector(".voice-dictation-button").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}));void 0');
    await pause(800);assert.equal(await read('fixture.state().mode'),'idle','Escape during the cue must cancel capture');
    await read('fixture.failStart=true;void 0');await pointer(true);await until('fixture.state().error.includes("fixture connection failed")');
    assert.ok(await read('document.querySelector(".voice-call-error").textContent.includes("fixture connection failed")'));
    await click('.voice-composer-end');await until('fixture.state().mode==="idle"');
    assert.ok(await read('fixture.tracks.every(t=>t.readyState==="ended")'));
    assert.deepEqual(errors,[]);console.log('Voice Composer UI passed: fixed dictation control, draft-only ASR/retry/cancel, running Agent, call hold/stop, draft and attachments, navigation, portal, themes and narrow layout. Screenshots: '+directory);
  }finally{win.destroy();clearTimeout(deadline);}
  app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
