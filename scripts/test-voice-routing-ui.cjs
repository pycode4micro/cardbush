// Application-level voice ownership with mounted but hidden chat surfaces.
// Real pointer gestures and fake-device capture; no external service or user profile.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),electron=require('electron');
if(typeof electron==='string'){
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const result=require('node:child_process').spawnSync(electron,[__filename],{env,windowsHide:true,stdio:'inherit',timeout:45000});
  if(result.error)console.error(result.error);process.exit(result.status??1);
}
const {app,BrowserWindow}=electron,directory=fs.mkdtempSync(path.resolve('tmp/voice-routing-ui-'));
app.setPath('userData',path.join(directory,'profile'));app.disableHardwareAcceleration();
app.commandLine.appendSwitch('use-fake-device-for-media-stream');app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deadline=setTimeout(()=>app.exit(1),40000);
app.whenReady().then(async()=>{
  const {build}=await import('vite'),{default:react}=await import('@vitejs/plugin-react');
  const {defaultVoiceSettings}=require('../dist-electron/voiceTypes.js');
  const file=name=>JSON.stringify(path.resolve(name).replaceAll('\\','/'));
  const result=await build({configFile:false,logLevel:'error',define:{'process.env.NODE_ENV':'"production"'},plugins:[react(),{
    name:'voice-routing-fixture',resolveId:id=>id.endsWith('__voice_routing_fixture__.tsx')?'\0voice-routing-fixture.tsx':undefined,
    load:id=>id==='\0voice-routing-fixture.tsx'?`
      import React,{useState,useEffect,useSyncExternalStore} from 'react';import {createRoot} from 'react-dom/client';
      import {ApplicationVoiceHost,VoiceConversation,VoiceButton,applicationVoiceSession} from ${file('src/features/voice/VoiceConversation.tsx')};
      import ${file('src/styles/theme.css')};import ${file('src/styles/app.css')};
      window.fixture={sent:[],tracks:[],started:[],closed:[],frames:0,spoken:0};
      const settings=${JSON.stringify({...defaultVoiceSettings,engine:'cloud',recognitionEngine:'cloud',hasApiKey:true,speakerLockEnabled:false})};
      window.cardbushDesktop={voice:{settings:async()=>{await new Promise(r=>setTimeout(r,60));return settings;},
        setCallActive:async()=>{},cancel:async()=>{},
        transcribe:async()=>{if(fixture.holdTranscription)await new Promise(r=>fixture.releaseTranscription=r);return{text:'这是录音测试',speakerVerified:true};},
        speak:async()=>fixture.spoken++,onAudio:()=>()=>{},
        realtime:{settings:async()=>({mode:'realtime',hasApiKey:true}),start:async data=>fixture.started.push(data),audio:async()=>fixture.frames++,
          control:async()=>{},playback:async()=>{},close:async id=>fixture.closed.push(id),onEvent:()=>()=>{}}}};
      const getMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia=async options=>{const stream=await getMedia(options);fixture.tracks.push(...stream.getTracks());return stream;};
      fixture.state=()=>applicationVoiceSession().snapshot();
      const target=(owner,environment='local')=>({environment,sessionId:owner,messages:[],sending:false,
        send:async text=>{fixture.sent.push({owner,text});return true;}});
      function BackgroundAssistant({active}){
        const session=applicationVoiceSession();useSyncExternalStore(session.subscribe,session.snapshot);
        const [,tick]=useState(0);useEffect(()=>{const timer=setInterval(()=>tick(i=>i+1),40);return()=>clearInterval(timer);},[]);
        return <section hidden={!active} data-view="assistant"><VoiceConversation active={active} language="zh"
          target={{...target('personal-assistant'),assistant:{name:'assistant',persona:''},audioPreferences:()=>({microphoneMuted:true,outputMuted:true})}}>
          <VoiceButton language="zh"/><VoiceButton language="zh" callOnly/>
        </VoiceConversation></section>;
      }
      function Fixture(){const [view,setView]=useState('assistant'),[mounted,setMounted]=useState(true),[chat,setChat]=useState('chat-a');
        fixture.navigate=setView;fixture.mountChat=setMounted;fixture.changeChat=setChat;
        return <div className="app theme-dark" style={{padding:40}}><ApplicationVoiceHost language="zh">
          <BackgroundAssistant active={view==='assistant'}/>
          {mounted&&<section hidden={view!=='chat'} data-view="chat"><VoiceConversation active={view==='chat'} language="zh" target={target(chat)}>
            <VoiceButton language="zh"/><VoiceButton language="zh" callOnly/>
          </VoiceConversation></section>}
          <section hidden={view!=='agent'} data-view="agent"><VoiceConversation active={view==='agent'} language="zh" target={target('remote-chat','ssh-host')}>
            <VoiceButton language="zh"/>
          </VoiceConversation></section>
        </ApplicationVoiceHost></div>;
      }createRoot(document.getElementById('root')).render(<Fixture/>);
    `:undefined,
  }],build:{write:false,minify:false,lib:{entry:path.resolve('src/__voice_routing_fixture__.tsx'),name:'VoiceRoutingFixture',formats:['iife']}}});
  const output=(Array.isArray(result)?result[0]:result).output;
  fs.mkdirSync(path.join(directory,'voice'));fs.copyFileSync('public/voice/realtime-capture-worklet.js',path.join(directory,'voice/realtime-capture-worklet.js'));
  fs.writeFileSync(path.join(directory,'index.html'),`<html><meta charset="utf-8"><style>${output.filter(item=>item.type==='asset'&&item.fileName.endsWith('.css')).map(item=>item.source).join('\n')}</style><div id="root"></div><script>${output.find(item=>item.type==='chunk').code.replaceAll('</script','<\\/script')}</script></html>`);
  const win=new BrowserWindow({show:false,width:900,height:720,webPreferences:{sandbox:true,contextIsolation:true,backgroundThrottling:false}});
  win.webContents.setAudioMuted(true);
  win.webContents.session.setPermissionCheckHandler((_,permission)=>permission==='media');
  win.webContents.session.setPermissionRequestHandler((_,permission,callback)=>callback(permission==='media'));
  win.webContents.session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)}));
  const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
  const read=code=>win.webContents.executeJavaScript(code);
  const until=async code=>{for(let i=0;i<160;i++){if(await read(code))return;await pause(25);}throw Error('Timed out: '+code+'\n'+await read('JSON.stringify(fixture.state())')+'\n'+errors.join('\n'));};
  const click=label=>read(`Array.from(document.querySelectorAll('button')).find(button=>button.getAttribute('aria-label')===${JSON.stringify(label)}).click();void 0`);
  const pointer=async(view,hold=0)=>{const point=await read(`(()=>{const rect=document.querySelector('[data-view="${view}"] .send-button').getBoundingClientRect();return{x:Math.round(rect.x+rect.width/2),y:Math.round(rect.y+rect.height/2)};})()`);
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});if(hold)await pause(hold);win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});};
  const navigate=async view=>{await read(`fixture.navigate(${JSON.stringify(view)});void 0`);await until(`!document.querySelector('[data-view="${view}"]').hidden`);};
  try{
    await win.loadFile(path.join(directory,'index.html'));await until('typeof fixture.navigate==="function"');
    await navigate('chat');await pointer('chat');await until('fixture.state().phase==="recording"');
    await pause(250);assert.equal(await read('fixture.state().mode'),'recording','hidden assistant polling must not cancel recording');
    assert.equal(await read('fixture.state().muted'),false,'assistant mute must not leak into ordinary chats');
    await click('发送录音');await until('fixture.sent.length===1 && fixture.state().mode==="idle"');
    assert.deepEqual(await read('fixture.sent'),[{owner:'chat-a',text:'这是录音测试'}]);assert.equal(await read('fixture.spoken'),0);
    await navigate('agent');await pointer('agent');await until('fixture.state().phase==="recording"');await pause(250);
    await click('发送录音');await until('fixture.sent.length===2 && fixture.state().mode==="idle"');
    assert.equal(await read('fixture.sent[1].owner'),'remote-chat');
    await navigate('chat');await pointer('chat',650);await until('fixture.state().mode==="call" && fixture.state().phase==="listening"');
    const callFrames=await read('fixture.frames');await navigate('assistant');await until('fixture.frames>'+callFrames+'+5');
    assert.equal(await read('fixture.state().sessionId'),'chat-a');assert.equal(await read('fixture.state().assistant'),false);
    assert.equal(await read('fixture.started.length'),1,'long press starts exactly one call');await click('结束通话');
    await pointer('assistant',650);await until('fixture.state().mode==="call" && fixture.state().phase==="listening"');
    assert.equal(await read('fixture.state().muted'),true);assert.equal(await read('fixture.state().outputMuted'),true);
    await navigate('chat');assert.equal(await read('fixture.state().sessionId'),'personal-assistant');await click('结束通话');
    await pointer('chat');await until('fixture.state().phase==="recording"');await read('fixture.changeChat("chat-b");void 0');await until('fixture.state().mode==="idle"');
    await pointer('chat');await until('fixture.state().phase==="recording"');await read('fixture.mountChat(false);void 0');await until('fixture.state().mode==="idle"');
    await read('fixture.mountChat(true);void 0');await until('document.querySelector(\'[data-view="chat"]\')');
    await pointer('chat');await until('fixture.state().phase==="recording"');await pause(200);
    await read('fixture.holdTranscription=true;void 0');await click('发送录音');await until('typeof fixture.releaseTranscription==="function"');
    await navigate('assistant');await until('fixture.state().mode==="idle"');await read('fixture.releaseTranscription();void 0');await pause(100);
    assert.equal(await read('fixture.sent.length'),2,'leaving a recording never sends late text to another chat');
    assert.ok(await read('fixture.tracks.every(track=>track.readyState==="ended")'));assert.deepEqual(errors,[]);
    console.log('Voice routing UI passed: real click/hold, hidden assistant/Agent views, local/remote recording, call continuity, microphone preferences, navigation and late-transcript cancellation.');
  }finally{win.destroy();clearTimeout(deadline);}
  app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
