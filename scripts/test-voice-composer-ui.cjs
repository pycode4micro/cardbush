// Real shared Composer in both presentations, with fake-device audio and isolated settings.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),electron=require('electron');
if(typeof electron==='string'){
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const result=require('node:child_process').spawnSync(electron,[__filename],{env,windowsHide:true,stdio:'inherit',timeout:55000});
  if(result.error)console.error(result.error);process.exit(result.status??1);
}
const {app,BrowserWindow}=electron,directory=fs.mkdtempSync(path.resolve('tmp/voice-composer-ui-'));
app.setPath('userData',path.join(directory,'profile'));app.disableHardwareAcceleration();
app.commandLine.appendSwitch('use-fake-device-for-media-stream');app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms)),deadline=setTimeout(()=>app.exit(1),50000);
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
      window.fixture={sent:[],frames:0,started:0,closed:0,captures:0,transcriptions:0,tracks:[]};
      const getMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia=async options=>{fixture.captures++;const stream=await getMedia(options);fixture.tracks.push(...stream.getTracks());return stream;};
      const settings=${JSON.stringify({...defaultVoiceSettings,engine:'cloud',recognitionEngine:'cloud',hasApiKey:true,speakerLockEnabled:false})};
      window.cardbushDesktop={pickAttachments:async()=>['C:/fixture/report.txt'],inspectAttachments:async paths=>paths.map(path=>({path,name:'report.txt',kind:'file',size:100})),voice:{settings:async()=>settings,setCallActive:async()=>{},cancel:async()=>{},
        transcribe:async()=>{fixture.transcriptions++;if(fixture.holdTranscription)await new Promise(resolve=>fixture.releaseTranscription=resolve);if(fixture.failTranscription){fixture.failTranscription=false;throw Error('fixture transcription failed');}return{text:'这是录音测试',speakerVerified:true};},speak:async()=>{},onAudio:()=>()=>{},
        realtime:{settings:async()=>({mode:'realtime',hasApiKey:true}),start:async()=>{fixture.started++;if(fixture.failStart)throw Error('fixture connection failed');},audio:async()=>fixture.frames++,control:async()=>{},playback:async()=>{},close:async()=>fixture.closed++,onEvent:()=>()=>{}}}};
      fixture.state=()=>applicationVoiceSession().snapshot();
      const noop=()=>{},controls={selectedModel:'fixture',availableModels:[],onModelChange:noop,onConfigureModels:noop,referencePlanMode:'off',onReferencePlanModeChange:noop,permissionMode:'task_free',onPermissionModeChange:noop,subagentPermissionRouting:'inherit',onSubagentPermissionRoutingChange:noop,reasoningLevel:'medium',reasoningLevels:['medium'],reasoningLevelAvailable:false,onReasoningLevelChange:noop,skills:[],disabledSkillNames:new Set(),onToggleSkill:noop};
      function Fixture(){const [style,setStyle]=useState('standard'),[draft,setDraft]=useState(''),[view,setView]=useState('chat'),[theme,setTheme]=useState('dark'),[portal,setPortal]=useState(false),[portalTarget,setPortalTarget]=useState(null);
        fixture.style=setStyle;fixture.view=setView;fixture.theme=setTheme;fixture.portal=setPortal;
        const target={environment:'local',sessionId:view,messages:[],sending:false,...(view==='assistant'?{assistant:{name:'assistant',persona:''}}:{}),send:async text=>{if(fixture.failSend){fixture.failSend=false;throw Error('fixture send failed');}fixture.sent.push(text);return true;}};
        return <div className={'app theme-'+theme} style={{minHeight:'100vh',padding:'90px 20px'}}><ApplicationVoiceHost language="zh">
          <div style={{width:'min(704px,100%)',margin:'0 auto'}}><VoiceConversation language="zh" target={target} active={view!=='hidden'}>
            <ComposerPresentationContext.Provider value={{style,preservePermissions:true}}><ComposerPortalContext.Provider value={portal?portalTarget:null}>
              <Composer {...controls} compact language="zh" draft={draft} onDraftChange={setDraft} sending={false} referencePlanAvailable={false} onSend={target.send} onCancel={async()=>{}}/>
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
    if(hold){await pause(150);assert.ok(await read('!!document.querySelector(".voice-hold-progress")'));await pause(450);}
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
  };
  const screenshot=async name=>{win.webContents.invalidate();await pause(300);fs.writeFileSync(path.join(directory,name+'.png'),(await win.webContents.capturePage()).toPNG());};
  try{
    await win.loadFile(path.join(directory,'index.html'));await until('document.querySelector(".voice-trigger")');
    const cancelledPoint=await read('(()=>{const r=document.querySelector(".voice-trigger").getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()');
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...cancelledPoint});await pause(100);
    await read('fixture.view("hidden");void 0');await pause(600);win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...cancelledPoint});
    assert.equal(await read('fixture.state().mode'),'idle','leaving during a hold must not start a call');await read('fixture.view("chat");void 0');await until('document.querySelector(".voice-trigger")');
    for(const [index,style] of ['standard','simple'].entries()){
      await read(`fixture.style(${JSON.stringify(style)});fixture.view(${JSON.stringify(index?'assistant':'chat')});void 0`);await pause(100);await until('document.querySelector(".composer-surface").getAnimations().every(a=>a.playState==="finished")');
      const baseHeight=await read('document.querySelector(".composer-surface").getBoundingClientRect().height');
      await pointer();await until('fixture.state().phase==="recording"&&document.querySelector(".voice-call-active")');
      assert.equal(await read('!!document.querySelector(".voice-mini,.voice-dialog,.voice-floating-composer")'),false,'recording uses the shared composer, not the old overlay');
      assert.ok(await read('document.querySelector(".voice-composer-label").textContent.includes("正在录音")'));
      await screenshot(style+'-recording');
      const captures=await read('fixture.captures'),sent=await read('fixture.sent.length');
      await click('.voice-composer-return');await until('!document.querySelector(".voice-call-active")&&document.querySelector(".voice-floating-composer")');
      await fill('录音期间的草稿');await click('.voice-call-entry');await until('document.querySelector(".voice-call-active")&&!document.querySelector(".voice-floating-composer")');
      assert.equal(await read('fixture.captures'),captures,'returning to recording does not acquire another microphone');
      win.setSize(360,600);await read('fixture.theme("light");void 0');await screenshot(style+'-recording-narrow-light');
      assert.ok(await read('document.documentElement.scrollWidth<=innerWidth'));
      assert.ok(await read('(()=>{const a=document.querySelector(".voice-composer-return").getBoundingClientRect(),b=document.querySelector(".voice-composer-status").getBoundingClientRect(),c=document.querySelector(".voice-composer-actions").getBoundingClientRect();return a.right<=b.left&&b.right<=c.left;})()'));
      win.setSize(900,600);await read('fixture.theme("dark");fixture.holdTranscription=true;fixture.releaseTranscription=undefined;void 0');
      await read(`fixture.${index?'failSend':'failTranscription'}=true;void 0`);
      await read('fixture.recordingSurface=document.querySelector(".voice-composer-call");void 0');
      await click('.voice-composer-send');await until('fixture.releaseTranscription&&document.querySelector(".voice-call-active")');
      assert.equal(await read('document.querySelector(".voice-composer-call")===fixture.recordingSurface'),true,'transcription preserves the same recording controls');
      assert.equal(await read('!!document.querySelector(".voice-floating-composer,.voice-dialog,.voice-mini")'),false,'no automatic background UI during transcription');
      assert.equal(await read('document.querySelector(".composer-surface textarea").value'),'录音期间的草稿','recording retains the existing text draft');
      assert.equal(await read('document.querySelector(".voice-composer-send").disabled'),true);
      assert.equal(await read('fixture.tracks.every(track=>track.readyState==="ended")'),true);
      await read('fixture.holdTranscription=false;fixture.releaseTranscription();void 0');await until('document.querySelector(".voice-composer-note [role=alert]")');
      await screenshot(style+'-recording-retry');
      const transcriptions=await read('fixture.transcriptions');await click('.voice-composer-send');await until('fixture.state().mode==="idle"&&!document.querySelector(".voice-floating-composer")');
      await until('document.activeElement===document.querySelector(".composer-surface textarea")');
      assert.equal(await read('fixture.sent.length'),sent+1);assert.equal(await read('fixture.sent.at(-1)'),'这是录音测试');
      assert.equal(await read('fixture.transcriptions'),transcriptions+(index?0:1),'send retry preserves the recognized text');
      assert.equal(await read('fixture.captures'),captures);await fill('');
      await pointer();await until('fixture.state().phase==="recording"');await click('.voice-composer-end');await until('fixture.state().mode==="idle"');
      assert.equal(await read('fixture.sent.length'),sent+1,'cancel does not send a recording');
      await pointer(true);await until('fixture.state().phase==="listening"&&document.querySelector(".voice-call-active")');await until('document.querySelector(".composer-surface").getAnimations().every(a=>a.playState==="finished")');
      assert.equal(await read('fixture.started'),index+1,'one call per long press');
      assert.equal(await read('document.querySelector(".composer-surface").getBoundingClientRect().height'),64,JSON.stringify(await read('(()=>{const e=document.querySelector(".composer-surface"),s=getComputedStyle(e);return{style:e.getAttribute("style"),height:s.height,min:s.minHeight,padding:s.padding,box:s.boxSizing,animation:e.getAnimations().map(a=>a.effect.getKeyframes())}})()')));
      assert.equal(await read('!!document.querySelector(".voice-mini")'),false,'no duplicate floating control');
      await screenshot(style+'-call');
      const startedAt=await read('fixture.state().startedAt');
      await click('.voice-composer-return');await until('!document.querySelector(".voice-call-active")');await until('document.querySelector(".composer-surface").getAnimations().every(a=>a.playState==="finished")');
      assert.equal(await read('document.querySelector(".composer-surface").getBoundingClientRect().height'),baseHeight,'original input layout restored');
      assert.equal(await read('document.activeElement.tagName'),'TEXTAREA');
      await fill('请保留这段草稿');await click('.composer-tools .tool-chip');
      await read('Array.from(document.querySelectorAll(".composer-popover button")).find(n=>n.textContent.includes("文件和文件夹")).click();void 0');await until('document.querySelector(".composer-file-strip")');
      await click('.voice-call-entry');await until('document.querySelector(".voice-call-active")');
      await click('.voice-composer-actions [aria-label="麦克风静音"]');assert.equal(await read('fixture.state().muted'),true);
      await click('.voice-composer-return');await until('!document.querySelector(".voice-call-active")');
      assert.equal(await read('document.querySelector(".composer-surface textarea").value'),'请保留这段草稿');assert.ok(await read('document.querySelector(".composer-file-strip").textContent.includes("report.txt")'));
      await screenshot(style+'-text');await click('.voice-call-entry');await click('.voice-composer-actions [aria-label="麦克风静音"]');
      const frames=await read('fixture.frames');await read('fixture.view("other");void 0');await until('document.querySelector(".voice-mini")&&!document.querySelector(".voice-call-active")');
      await until('fixture.frames>'+frames+'+4');assert.equal(await read('fixture.state().startedAt'),startedAt);
      await read(`fixture.view(${JSON.stringify(index?'assistant':'chat')});void 0`);await until('document.querySelector(".voice-call-active")&&!document.querySelector(".voice-mini")');
      await click('.voice-composer-status');await until('document.querySelector(".voice-dialog")');
      await click('.voice-dialog button[aria-label="收起为悬浮按钮"]');await until('!document.querySelector(".voice-dialog,.voice-mini")');
      await read('fixture.portal(true);void 0');await until('document.querySelector(".inspector-quick-input .voice-call-active")');
      await read('fixture.portal(false);void 0');await until('!document.querySelector(".inspector-quick-input .composer-stack")');assert.equal(await read('fixture.started'),index+1,'portal does not restart the call');
      await read('fixture.theme("light");void 0');await screenshot(style+'-light');
      win.setSize(360,600);await pause(100);assert.ok(await read('document.documentElement.scrollWidth<=innerWidth'));
      assert.ok(await read('(()=>{const a=document.querySelector(".voice-composer-return").getBoundingClientRect(),b=document.querySelector(".voice-composer-status").getBoundingClientRect(),c=document.querySelector(".voice-composer-actions").getBoundingClientRect();return a.right<=b.left&&b.right<=c.left;})()'));
      await screenshot(style+'-narrow');win.setSize(900,600);await read('fixture.theme("dark");void 0');
      await click('.voice-composer-end');await until('fixture.state().mode==="idle"&&!document.querySelector(".voice-composer-call")');
      assert.equal(await read('document.querySelector(".composer-surface textarea").value'),'请保留这段草稿');
      await click('.send-button');await until('document.querySelector(".composer-surface textarea").value===""');assert.ok(await read('fixture.sent.at(-1).includes("@C:/fixture/report.txt")'));
    }
    await read('fixture.failStart=true;void 0');await pointer(true);await until('fixture.state().error.includes("fixture connection failed")');
    assert.ok(await read('document.querySelector(".voice-composer-label").textContent.includes("需要处理")'));await click('.voice-composer-status');await until('document.querySelector(".voice-dialog .voice-error")');await click('.voice-dialog .voice-end');
    assert.deepEqual(errors,[]);console.log('Voice Composer UI passed: standard/simple, real click/hold, draft/attachments, text/call switching, mute, background audio, details, portal, themes, narrow window and connection errors. Screenshots: '+directory);
  }finally{win.destroy();clearTimeout(deadline);}
  app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
