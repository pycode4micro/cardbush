// Isolated Electron renderer + real preload, AudioWorklet and loopback WebSocket.
// No real microphone, external speech service, account or user profile is used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(electron, [__filename], { env, windowsHide:true, stdio:'inherit', timeout:60000 });
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow, ipcMain } = electron;
const directory = fs.mkdtempSync(path.resolve('tmp/realtime-voice-ui-'));
app.setPath('userData', path.join(directory,'profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
const deadline = setTimeout(()=>app.exit(1),55000);
app.whenReady().then(async()=>{
  const { WebSocketServer } = require('ws');
  const { RealtimeVoiceService, connectRealtimeVoice } = require('../dist-electron/realtimeVoiceService.js');
  const { defaultRealtimeVoiceSettings } = require('../dist-electron/realtimeVoiceTypes.js');
  const { defaultVoiceSettings } = require('../dist-electron/voiceTypes.js');
  const wss = new WebSocketServer({host:'127.0.0.1',port:0}); await once(wss,'listening');
  const received=[]; let peer, audioFrames=0,reconnectDelay=0,connections=0;
  wss.on('connection',(socket,request)=>{
    assert.equal(request.headers['x-api-key'],'fixture-not-a-credential'); peer=socket;connections++;
    socket.on('message',data=>{
      const event=JSON.parse(data);received.push(event);
      if(event.type==='session.create')setTimeout(()=>{if(socket.readyState===1)socket.send(JSON.stringify({type:'session.created',session:{id:'fixture'}}));},reconnectDelay);
      if(event.type==='conversation.item.create' && event.items?.[0]?.role==='user')socket.send(JSON.stringify({type:'conversation.item.added',event_id:'provider-context-ack',items:event.items}));
      if(event.type==='input_audio_buffer.append'){assert.equal(Buffer.from(event.audio,'base64').length,640);audioFrames++;}
      if(event.type==='response.cancel')socket.send(JSON.stringify({type:'response.canceled'}));
      if(event.type==='session.close')socket.send(JSON.stringify({type:'session.closed'}));
    });
  });
  const service = new RealtimeVoiceService(path.join(directory,'settings.json'),{
    encrypt:key=>key,decrypt:key=>key,
    connect:(_url,headers)=>connectRealtimeVoice('',`ws://127.0.0.1:${wss.address().port}`,headers),
  });
  service.save({...defaultRealtimeVoiceSettings,apiKey:'fixture-not-a-credential'});
  let preferences={...defaultVoiceSettings};
  const diagnostics=[],heldAudio=[];let holdAudio=false;
  ipcMain.handle('debug:append-log',(_,scope,payload)=>{diagnostics.push({scope,payload});return 'fixture-log';});
  ipcMain.handle('voice:call-active',()=>{});
  ipcMain.handle('voice:settings',()=>preferences);
  ipcMain.handle('voice:save-settings',(_,settings)=>(preferences=settings));
  ipcMain.handle('voice:realtime-settings',()=>service.settings());
  ipcMain.handle('voice:realtime-save',(_,settings)=>service.save(settings));
  ipcMain.handle('voice:realtime-start',(event,input)=>service.start(event.sender.id,input,value=>event.sender.send('voice:realtime-event',value)));
  ipcMain.handle('voice:realtime-audio',async(event,id,pcm)=>{
    if(holdAudio)await new Promise(resolve=>heldAudio.push(resolve));
    return service.audio(event.sender.id,id,pcm);
  });
  ipcMain.handle('voice:realtime-control',(event,id,action)=>service.control(event.sender.id,id,action));
  ipcMain.handle('voice:realtime-results',(event,id,results)=>service.results(event.sender.id,id,results));
  ipcMain.handle('voice:realtime-notify',(event,id,result)=>service.notify(event.sender.id,id,result));
  ipcMain.handle('voice:realtime-compacted',(event,id,jobId,result)=>service.compacted(event.sender.id,id,jobId,result));
  ipcMain.handle('voice:realtime-playback',(event,id,speaking)=>service.playback(event.sender.id,id,speaking));
  ipcMain.handle('voice:realtime-voice',(event,id,voice)=>service.setVoice(event.sender.id,id,voice));
  ipcMain.handle('voice:realtime-close',(event,id)=>service.close(event.sender.id,id));
  const file=name=>JSON.stringify(path.resolve(name).replaceAll('\\','/'));
  const { build } = await import('vite');
  const { default:react } = await import('@vitejs/plugin-react');
  const built=await build({configFile:false,logLevel:'error',define:{'process.env.NODE_ENV':'"production"'},plugins:[react(),{
    name:'realtime-voice-fixture',resolveId:id=>id.endsWith('__realtime_voice_fixture__.tsx')?'\0realtime-voice-fixture.tsx':undefined,
    load:id=>id==='\0realtime-voice-fixture.tsx'?`
      import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
      import {VoiceConversation,VoiceButton,ApplicationVoiceHost,applicationVoiceSession} from ${file('src/features/voice/VoiceConversation.tsx')};
      import ${file('src/styles/theme.css')};import ${file('src/styles/app.css')};
      window.fixture={sent:[],tracks:[],tasks:[]};
      fixture.muteOutput=value=>applicationVoiceSession().setOutputMuted(value);
      fixture.outputLevel=()=>applicationVoiceSession().realtime.audio.outputGain.gain.value;
      const getMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia=async c=>{const s=await getMedia(c);fixture.tracks.push(...s.getTracks());return s;};
      function Fixture(){const [messages,setMessages]=useState([]),[sessionId,setSession]=useState(''),[sending,setSending]=useState(false),[visible,setVisible]=useState(true);fixture.hide=()=>setVisible(false);
        fixture.switch=()=>setSession('other');
        fixture.complete=()=>{for(const task of fixture.tasks){task.status='completed';task.finalResponse='测试任务完成';}};
        return <div className="app theme-dark"><ApplicationVoiceHost language="zh">{visible && <VoiceConversation language="zh" target={{environment:'local',sessionId,messages,sending,activeTurnId:sending?'own':null,
          agent:{list:async()=>fixture.tasks,summarize:async taskId=>{fixture.summaries=(fixture.summaries??0)+1;await new Promise(resolve=>setTimeout(resolve,200));return '桌面共有十五个应用，主要是开发工具和办公软件。';},execute:async(id,name,args)=>{fixture.sent.push(args.prompt);const task={taskId:id,childSessionId:'child-'+id,parentTurnId:'voice_turn_'+id,status:'running',finalResponse:'',errorMessage:''};fixture.tasks.push(task);setTimeout(()=>setSession('created'),30);return task;}},
          send:async text=>{fixture.sent.push(text);setSending(true);setMessages([{id:'u',role:'user',turnId:'own',content:text}]);setTimeout(()=>setSession('created'),30);return true;}}}>
          <VoiceButton language="zh" callOnly/>
        </VoiceConversation>}</ApplicationVoiceHost></div>;}
      createRoot(document.getElementById('root')).render(<Fixture/>);
    `:undefined,
  }],build:{write:false,minify:false,lib:{entry:path.resolve('src/__realtime_voice_fixture__.tsx'),name:'RealtimeVoiceFixture',formats:['iife']}}});
  const output=Array.isArray(built)?built[0].output:built.output;
  fs.mkdirSync(path.join(directory,'voice'));
  fs.copyFileSync('public/voice/realtime-capture-worklet.js',path.join(directory,'voice/realtime-capture-worklet.js'));
  fs.writeFileSync(path.join(directory,'index.html'),`<html><meta charset="utf-8"><style>${output.filter(v=>v.type==='asset'&&v.fileName.endsWith('.css')).map(v=>v.source).join('\n')}</style><div id="root"></div><script>${output.find(v=>v.type==='chunk').code.replaceAll('</script','<\\/script')}</script></html>`);
  const win=new BrowserWindow({show:false,width:900,height:760,webPreferences:{preload:path.resolve('dist-electron/preload.js'),contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  win.webContents.setAudioMuted(true);
  win.webContents.session.setPermissionCheckHandler((_wc,permission)=>permission==='media');
  win.webContents.session.setPermissionRequestHandler((_wc,permission,callback)=>callback(permission==='media'));
  win.webContents.session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)}));
  const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
  const read=code=>win.webContents.executeJavaScript(code);
  const until=async condition=>{const end=Date.now()+7000;while(!await condition()){if(Date.now()>end)throw Error('Timed out\n'+await read('document.body.innerText')+'\n'+errors.join('\n'));await pause(25);}};
  const dom=code=>until(()=>read(code));
  const click=label=>read(`Array.from(document.querySelectorAll('button')).find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)}||b.textContent===${JSON.stringify(label)}).click();void 0`);
  const event=value=>peer.send(JSON.stringify(value));
  const tools=id=>event({type:'response.function_call_arguments.done',items:[{call_id:id,name:'subagent',arguments:'{"prompt":"测试任务"}'}]});
  try{
    await win.loadFile(path.join(directory,'index.html'));await dom('document.querySelector("button[aria-label=语音通话]")');
    await click('语音通话');await dom('document.querySelector(".voice-mini-status")?.textContent==="正在聆听"');
    await until(()=>audioFrames>=5);
    assert.equal(received[0].session.tools.length,4);
    holdAudio=true;await pause(650);
    assert.equal(peer.readyState,1,'a brief IPC stall must not disconnect capture');
    assert.equal(heldAudio.length,4,'microphone IPC concurrency stays bounded');
    const beforeDrain=audioFrames;holdAudio=false;heldAudio.splice(0).forEach(resolve=>resolve());
    await until(()=>audioFrames>beforeDrain+20);
    // Only native duplex cancellation changes playback; ASR and unintelligible sound do not.
    for(let i=0;i<30;i++)event({type:'response.output_audio.delta',response_id:'r1',delta:Buffer.alloc(24000*2).toString('base64')});
    await dom('!!document.querySelector("button[aria-label=停止播报]")');
    const beforeOutputMute=audioFrames;
    await read('fixture.muteOutput(true);void 0');assert.equal(await read('fixture.outputLevel()'),0);
    await until(()=>audioFrames>beforeOutputMute+5);
    assert.equal(received.filter(e=>e.type==='response.cancel').length,0,'speech mute never cancels the response');
    await read('fixture.muteOutput(false);void 0');assert.equal(await read('fixture.outputLevel()'),1);
    event({type:'conversation.item.input_audio_transcription.delta',item_id:'noise',delta:'背景'});
    event({type:'conversation.item.input_audio_transcription.failed',item_id:'noise',error:{code:'audio_unintelligible'}});
    await pause(100);assert.equal(await read('!!document.querySelector("button[aria-label=停止播报]")'),true);
    assert.deepEqual(await read('fixture.sent'),[]);
    await click('停止播报');await dom('!document.querySelector("button[aria-label=停止播报]")');
    await click('麦克风静音');await until(()=>received.some(e=>e.type==='input_audio_mute.commit'));
    await pause(100);const count=audioFrames;await pause(150);assert.equal(audioFrames,count,'mute stops capture');
    await click('麦克风静音');await until(()=>received.some(e=>e.type==='input_audio_unmute.commit')&&audioFrames>count);
    tools('fc-2');await dom('fixture.sent.length===1');await pause(100);
    await dom('document.querySelector(".voice-mini-status")?.textContent.includes("可以继续说")');
    await click('展开语音通话');assert.equal(await read('!!document.querySelector(".voice-review")'),false);
    assert.equal(peer.readyState,1,'adopting the first created chat does not end the call');
    const whileWorking=audioFrames;await until(()=>audioFrames>whileWorking+5);
    event({type:'response.output_audio.delta',response_id:'while-working',delta:Buffer.alloc(24000*2*2).toString('base64')});
    event({type:'response.output_text.done',response_id:'while-working',text:'任务还在执行，我们可以继续聊。'});
    await dom('!Array.from(document.querySelectorAll("button")).find(b=>b.textContent.includes("停止播报"))?.disabled');
    await dom('document.querySelector(".voice-reply-preview")?.textContent.includes("我们可以继续聊")');
    tools('fc-busy');await until(()=>received.some(e=>e.items?.[0]?.call_id==='fc-busy'));
    assert.equal(JSON.parse(received.find(e=>e.items?.[0]?.call_id==='fc-busy').items[0].content[0].text).status,'running');
    assert.equal(await read('fixture.sent.length'),2);
    event({type:'response.function_call_arguments.done',items:[{call_id:'fc-2',name:'subagent',arguments:'{"prompt":"测试任务"}'}]});
    event({type:'response.done'});
    await read('fixture.complete();void 0');await until(()=>received.some(e=>e.items?.[0]?.role==='user' && e.items[0].content?.[0]?.text.includes('测试任务完成')));
    await until(()=>received.some(e=>e.type==='speech_text_buffer.commit'&&e.text.includes('十五个应用')));
    assert.equal(await read('fixture.summaries'),2,'each completed child gets one spoken summary');
    assert.ok(received.filter(e=>e.type==='speech_text_buffer.commit').every(e=>!e.text.includes('测试任务完成')),'raw output is not read aloud');
    assert.equal(JSON.parse(received.find(e=>e.items?.[0]?.call_id==='fc-2').items[0].content[0].text).status,'running');
    assert.equal(await read('fixture.sent.length'),2,'replayed tool calls execute once');
    const beforeRecovery=received.length,oldPeer=peer;reconnectDelay=6000;oldPeer.terminate();
    await dom('document.querySelector(".voice-status")?.textContent.includes("恢复通话")');
    await dom('document.body.innerText.includes("收音暂时暂停")');
    assert.ok(await read('fixture.tracks.some(t=>t.readyState==="live")'),'recovery retains the call and microphone resource');
    await dom('document.querySelector(".voice-status")?.textContent.includes("正在聆听")');
    assert.equal(connections,2);assert.equal(await read('fixture.sent.length'),2,'reconnect does not execute tasks again');
    assert.ok(received.slice(beforeRecovery).some(e=>e.type==='conversation.item.create'&&JSON.stringify(e).includes('测试任务完成')),'recovery restores the completed task context');
    const restoredAudio=audioFrames;await until(()=>audioFrames>restoredAudio+5);
    await read('fixture.switch();void 0');await pause(100);
    assert.equal(peer.readyState,1,'switching chats preserves the original call');
    await read('fixture.hide();void 0');await pause(100);
    assert.equal(peer.readyState,1,'unmounting chat keeps the app-level call');
    const beforeMinimize=audioFrames;win.minimize();await until(()=>audioFrames>beforeMinimize+5);
    assert.ok(await read('fixture.tracks.some(t=>t.readyState==="live")'));
    await click('结束通话');await dom('!document.querySelector(".voice-mini,.voice-call-overlay")');
    await until(()=>peer.readyState!==1);assert.ok(await read('fixture.tracks.every(t=>t.readyState==="ended")'));
    assert.deepEqual(errors,[]);
    assert.ok(diagnostics.some(item=>item.payload.event==='connected'));
    assert.equal(diagnostics.some(item=>item.payload.event==='failed'),false);
    for(const {scope,payload} of diagnostics){assert.equal(scope,'realtime-voice');assert.ok(Object.keys(payload).every(key=>['event','callId','reason','pendingFrames','queuedFrames'].includes(key)));}
    console.log('Realtime voice UI passed: real worklet/preload/WebSocket PCM, direct delegation, continuous capture/playback during execution, parallel task receipts, noise, mute, deduplication, first-chat adoption, background result notification, navigation/unmount/minimize continuity and explicit hangup cleanup.');
  }finally{service.closeAll();win.destroy();for(const client of wss.clients)client.terminate();wss.close();clearTimeout(deadline);}
  app.exit(0);
}).catch(error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
