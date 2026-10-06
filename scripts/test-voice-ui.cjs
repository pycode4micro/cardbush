const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createServer } = require('node:http');
const { once } = require('node:events');
const electron = require('electron');
if (typeof electron === 'string') {
  // Run the same branded development executable as `npm run gui`: Electron reports
  // isPackaged=true for it, so raw Electron detection cannot locate our native assets.
  import('./cardbush-electron-runtime.mjs').then(({ resolveCardbushElectronExecutable, cardbushElectronEnvironment }) => {
    const executable = resolveCardbushElectronExecutable(path.resolve(__dirname, '..'));
    const env = cardbushElectronEnvironment({ CARDBUSH_DEVELOPMENT_RUNTIME: '1' }); delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(executable, [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit', timeout: process.argv.includes('--local-model') || process.argv.includes('--speech-model') || process.argv.includes('--speaker-model') ? 240000 : 90000 });
    if (result.error) console.error(result.error); process.exit(result.status ?? 1);
  }).catch(error => { console.error(error); process.exit(1); });
  return;
}
const { app, BrowserWindow, net } = electron;
const testLocalModel = process.argv.includes('--local-model'), testSpeechModel = process.argv.includes('--speech-model'), testSpeakerModel = process.argv.includes('--speaker-model');
let artifactRequests = 0;
if (testLocalModel || testSpeechModel || testSpeakerModel) {
  // Explicit integration test only: official archives already present in the dev
  // cache go through the production installer and all of its integrity checks.
  // Never download large assets or modify the user's real model/settings here.
  const { Readable } = require('node:stream');
  const originalFetch = net.fetch.bind(net);
  net.fetch = (input, init) => {
    const url = String(input);
    if (url.startsWith('https://github.com/k2-fsa/sherpa-onnx/releases/download/')) {
      artifactRequests++;
      if (testSpeakerModel && (url.endsWith('3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx') || url.includes('win-x64-shared-MT-Release-no-tts'))) {
        const artifact = path.resolve('tmp/voice-speaker-research', url.endsWith('.onnx') ? 'campplus.onnx' : 'runtime.tar.bz2');
        return Promise.resolve(new Response(Readable.toWeb(fs.createReadStream(artifact)), { headers: { 'content-length': String(fs.statSync(artifact).size) } }));
      }
      const isSpeech = url.includes('kokoro') || url.includes('win-x64-shared-MT-Release.tar');
      const archive = isSpeech ? path.resolve('tmp/kokoro-upstream', url.includes('tts-models') ? 'model.tar.bz2' : 'runtime.tar.bz2') : path.resolve('tmp/sensevoice-upstream', url.includes('2024-07-17') ? 'model-2024.tar.bz2' : process.platform === 'win32' ? 'runtime.tar.bz2' : 'linux-runtime.tar.bz2');
      return Promise.resolve(new Response(Readable.toWeb(fs.createReadStream(archive)), { headers: { 'content-length': String(fs.statSync(archive).size) } }));
    }
    return originalFetch(input, init);
  };
}
const directory = fs.mkdtempSync(path.resolve('tmp/voice-ui-'));
app.setPath('userData', path.join(directory, 'profile')); app.disableHardwareAcceleration();
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// A deterministic microphone: two phrases separated by a thinking pause, then silence.
// A single pure tone is intentionally rejected by the activity gate.
// Two seconds between phrases must not create two turns. The final gap permits one send.
const rate = 48000, frames = rate * 12, wav = Buffer.alloc(44 + frames * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(frames * 2, 40);
for (let i = 0; i < frames; i++) {
  const sample = i < rate || i >= rate * 3 && i < rate * 4 ? [1, 2, 3, 4, 5, 6, 7].reduce((sum, harmonic) => sum + Math.sin(i * 2 * Math.PI * 170 * harmonic / rate) / Math.sqrt(harmonic), 0) * 2400 : 0;
  wav.writeInt16LE(Math.round(sample), 44 + i * 2);
}
const microphone = path.join(directory, 'microphone.wav'); fs.writeFileSync(microphone, wav);
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', microphone);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deadline = setTimeout(() => { console.error('Voice UI fixture timed out'); app.exit(1); }, testLocalModel || testSpeechModel || testSpeakerModel ? 230000 : 80000);

app.whenReady().then(async () => {
  const { build } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const entry = '\0voice-fixture.tsx';
  const built = await build({ configFile: false, root: process.cwd(), logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [react(), {
    name: 'voice-fixture', resolveId: id => id.endsWith('__voice_fixture__.tsx') ? entry : undefined,
    load: id => id === entry ? `
      import React, { useState } from 'react'; import { createRoot } from 'react-dom/client';
      import { VoiceConversation, VoiceButton } from ${JSON.stringify(path.resolve('src/features/voice/VoiceConversation.tsx').replaceAll('\\','/'))};
      import { VoiceSettingsPanel } from ${JSON.stringify(path.resolve('src/features/voice/VoiceSettingsPanel.tsx').replaceAll('\\','/'))};
      import { prepareVoiceRecording } from ${JSON.stringify(path.resolve('src/features/voice/voiceRecording.ts').replaceAll('\\','/'))};
      import { VoiceActivity } from ${JSON.stringify(path.resolve('src/features/voice/voiceActivity.ts').replaceAll('\\','/'))};
      import ${JSON.stringify(path.resolve('src/styles/settings-controls.css').replaceAll('\\','/'))};
      import ${JSON.stringify(path.resolve('src/styles/settings.css').replaceAll('\\','/'))};
      import ${JSON.stringify(path.resolve('src/features/settings/settingsLayout.css').replaceAll('\\','/'))};
      window.fixture = { sent: [], settings: false };
      window.fixture.convert = prepareVoiceRecording;
      window.fixture.activity = async base64 => {
        const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));
        const decoder=new AudioContext(), audio=await decoder.decodeAudioData(bytes.buffer);await decoder.close();
        const context=new OfflineAudioContext(1,audio.length,audio.sampleRate), source=context.createBufferSource();source.buffer=audio;
        const analyser=context.createAnalyser();analyser.fftSize=2048;source.connect(analyser);analyser.connect(context.destination);
        const gate=new VoiceActivity(), samples=new Float32Array(2048), spectrum=new Float32Array(1024);let starts=0,voiced=0;
        const checks=[];
        for(let t=.06;t<audio.duration-.06;t+=.06) checks.push(context.suspend(t).then(()=>{
          analyser.getFloatTimeDomainData(samples);analyser.getFloatFrequencyData(spectrum);
          const rms=Math.sqrt(samples.reduce((s,v)=>s+v*v,0)/samples.length), result=gate.update(rms,spectrum,context.sampleRate,context.currentTime*1000);
          if(result.started)starts++;if(result.voiced)voiced++;return context.resume();
        }));
        source.start();await context.startRendering();await Promise.all(checks);return {starts,voiced};
      };
      window.fixture.tracks = [];
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => {
        const stream = await getUserMedia(constraints); window.fixture.tracks.push(...stream.getTracks()); return stream;
      };
      function Fixture() {
        const [messages, setMessages] = useState([]), [sessionId,setSessionId] = useState(''), [sending,setSending] = useState(false), [settings,setSettings] = useState(false);
        window.fixture.messages = setMessages; window.fixture.session = setSessionId; window.fixture.sending = setSending; window.fixture.settings = setSettings;
        return <><VoiceConversation language="zh" target={{environment:'local',sessionId,messages,sending,activeTurnId:sending?'turn':null,
          send:async(text,options)=>{window.fixture.sent.push({text,options});setSessionId('created');return true;}}}>
          <div style={{padding:50}}><VoiceButton language="zh"/><VoiceButton language="zh" callOnly/><button onClick={()=>setSettings(!settings)}>配置</button><input aria-label="消息" /></div>
        </VoiceConversation>{settings && <VoiceSettingsPanel language="zh"/>}</>;
      }
      createRoot(document.getElementById('root')).render(<Fixture/>);
    ` : undefined,
  }], build: { write: false, minify: false, lib: { entry: path.resolve('src/__voice_fixture__.tsx'), name: 'VoiceFixture', formats: ['iife'] } } });
  const output = Array.isArray(built) ? built[0].output : built.output;
  fs.writeFileSync(path.join(directory, 'index.html'), `<html><meta charset="utf-8"><style>body{margin:0;background:#181818;color:#eee;font:14px system-ui;--surface:#222;--border:#444;--text:#eee;--text-muted:#aaa;--accent:#9abaff}button{color:inherit} .settings-field{display:grid;gap:8px} .settings-field input{background:#303030;color:#eee;border:1px solid #555;padding:10px;border-radius:10px}.settings-card{padding:12px;border:1px solid #444;border-radius:14px;margin:12px}</style><style>${output.filter(v=>v.type==='asset'&&v.fileName.endsWith('.css')).map(v=>v.source).join('\n')}</style><div id="root"></div><script>${output.find(v=>v.type==='chunk').code.replaceAll('</script','<\\/script')}</script></html>`);
  const requests = [];
  let holdTranscription = false, completeTranscription;
  const server = createServer(async (req,res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks); requests.push({ url:req.url, body, authorization:req.headers.authorization });
    if (req.url.endsWith('/transcriptions')) {
      const complete = (status = 200) => { res.statusCode = status; res.setHeader('Content-Type','application/json'); res.end(JSON.stringify({text:'这是麦克风转写测试'})); };
      if (holdTranscription) completeTranscription = complete; else complete();
    }
    else { res.setHeader('Content-Type','audio/pcm'); res.write(Buffer.alloc(2400)); setTimeout(()=>res.end(Buffer.alloc(2400)),30); }
  }); server.listen(0,'127.0.0.1'); await once(server,'listening');
  const { registerVoiceIpc } = require('../dist-electron/voiceIpc.js');
  const { installAppSessionPermissions } = require('../dist-electron/appSessionPermissions.js');
  const win = new BrowserWindow({ show:false, width:850, height:950, webPreferences:{ preload:path.resolve('dist-electron/preload.js'), sandbox:true, contextIsolation:true, nodeIntegration:false, backgroundThrottling:false } });
  if (process.platform === 'win32') assert.equal(app.isPackaged, true, 'branded development runtime exercises packaged-detection mismatch');
  const runtime = { packaged: app.isPackaged && process.env.CARDBUSH_DEVELOPMENT_RUNTIME?.trim() !== '1',
    appPath: path.resolve(__dirname, '..'), resourcesPath: process.resourcesPath };
  registerVoiceIpc(()=>win, runtime, { realtimeProxy:async()=>'', download:(input,init)=>net.fetch(input instanceof URL ? input.toString() : input,init), speech:(input,init)=>net.fetch(input instanceof URL ? input.toString() : input,init) }); installAppSessionPermissions(win); win.webContents.setAudioMuted(true);
  const errors=[]; win.webContents.on('console-message',event=>{ if(event.level==='error') errors.push(event.message); });
  const read = code => win.webContents.executeJavaScript(code);
  const until = async (code, timeout = 6500) => { const end=Date.now()+timeout; while(!await read(code)){if(Date.now()>end)throw Error('Timed out: '+code+'\n'+await read('document.body.innerText')+'\n'+errors.join('\n'));await pause(30);} };
  const click = async label => read(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(label)} || b.getAttribute('aria-label')===${JSON.stringify(label)}).click();void 0`);
  const point = async selector => read(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  try {
    await win.loadFile(path.join(directory,'index.html'));
    await until('document.querySelector(".send-button")');
    await read('(async()=>{const api=cardbushDesktop.voice.realtime;await api.saveSettings({...await api.settings(),mode:"chained"});})()');
    assert.equal(await read('(async()=> (await cardbushDesktop.voice.settings()).engine)()'), 'system');
    assert.equal((await read('cardbushDesktop.voice.modelStatus()')).state, 'not-installed');
    assert.equal(fs.existsSync(path.join(app.getPath('userData'), 'voice-models')), false);
    assert.equal(await read('typeof cardbushDesktop.voice.chooseSpeechPath'), 'function');
    assert.equal(await read('typeof cardbushDesktop.voice.inspectSpeechModel'), 'function');
    assert.match(await read('cardbushDesktop.voice.inspectSpeechModel("relative-folder").then(()=>"unexpected",e=>e.message)'), /完整模型/);
    // Actual decoded speech must survive the noise gate, including bilingual audio.
    for (const relative of ['mixed.wav','sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/test_wavs/zh.wav','sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/test_wavs/en.wav']) {
      const sample=path.resolve('tmp/sensevoice-upstream',relative);if(!fs.existsSync(sample))continue;
      const activity=await read(`fixture.activity(${JSON.stringify(fs.readFileSync(sample).toString('base64'))})`);
      assert.ok(activity.starts>0, `${relative}: ${JSON.stringify(activity)}`);
      console.log(`Speech activity verified: ${path.basename(relative)}, ${activity.voiced} voiced frames.`);
    }
    const native = await read('cardbushDesktop.voice.capabilities()');
    if (native.available && native.recognizers.some(v=>v.language==='zh-CN') && native.voices.some(v=>v.language==='zh-CN'&&v.gender==='female')) {
      // Fresh local mode works before any key exists, through the real preload and native helper.
      await read('fixture.settings(true);void 0'); await until('document.body.innerText.includes("本地识别：已安装")');
      assert.equal(await read('!!document.querySelector("input[type=password]")'), false);
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      fs.writeFileSync(path.resolve('tmp/voice-system-settings.png'), (await win.webContents.capturePage()).toPNG());
      await read('fixture.settings(false);window.nativeChunks=[];window.nativeUnsub=cardbushDesktop.voice.onAudio(chunk=>nativeChunks.push(chunk));void 0');
      await read('document.querySelector(".send-button").click()'); await until('document.querySelector(".voice-composer-label")?.textContent.includes("正在录音")');
      await click('取消录音'); assert.equal(requests.length,0);
      await read('document.querySelector("button[aria-label=语音通话]").click()'); await until('document.querySelector(".voice-mini-status")?.textContent.includes("正在聆听")');
      await read('document.querySelector("button[aria-label=麦克风静音]").click();fixture.sending(true);fixture.messages([{id:"local-answer",role:"assistant",turnId:"turn",content:"今天天气很好。"}]);void 0');
      await until('nativeChunks.length>0'); await click('结束通话');
      assert.equal(requests.length,0);
      await read('fixture.sending(false);fixture.messages([]);nativeUnsub();void 0');
      // Browser MediaRecorder -> on-device WAV conversion -> real Windows dictation.
      const { WindowsVoice } = require('../dist-electron/windowsVoice.js');
      const { defaultVoiceSettings } = require('../dist-electron/voiceTypes.js');
      const chunks=[]; await new WindowsVoice(path.resolve('dist-native/voice/CardBushVoiceHost.exe')).speak({id:'fixture',text:'今天天气很好，我们一起去公园散步。'},defaultVoiceSettings,AbortSignal.timeout(15000),value=>chunks.push(value));
      const pcm=Buffer.concat(chunks.map(value=>Buffer.from(value.pcm,'base64'))), audioRate=chunks[0].sampleRate;
      await read(`window.nativePcm=${JSON.stringify(pcm.toString('base64'))};window.nativeRate=${audioRate};void 0`);
      const recognized=await read(`(async()=>{
        const bytes=Uint8Array.from(atob(nativePcm),c=>c.charCodeAt(0)), view=new DataView(bytes.buffer);
        const context=new AudioContext(), buffer=context.createBuffer(1,bytes.length/2,nativeRate);
        for(let i=0;i<buffer.length;i++)buffer.getChannelData(0)[i]=view.getInt16(i*2,true)/32768;
        const stream=context.createMediaStreamDestination(), source=context.createBufferSource();source.buffer=buffer;source.connect(stream);
        const recording=new MediaRecorder(stream.stream,{mimeType:'audio/webm;codecs=opus'}), chunks=[];
        recording.ondataavailable=e=>chunks.push(e.data);
        const stopped=new Promise(resolve=>recording.onstop=resolve);
        source.onended=()=>recording.stop();recording.start();source.start();await stopped;
        stream.stream.getTracks().forEach(track=>track.stop());await context.close();
        const converted=await fixture.convert(new Blob(chunks,{type:recording.mimeType}),'system');
        return cardbushDesktop.voice.transcribe({id:'local-browser-recording',...converted});
      })()`);
      assert.match(recognized.text,/天气|公园/); assert.equal(requests.length,0);
    }
    const config={engine:'cloud',language:'zh-CN',systemFemaleVoice:'',systemMaleVoice:'',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,transcriptionModel:'test-transcribe',speechModel:'test-speech',voice:'female',femaleVoice:'nova',maleVoice:'onyx',speed:1,apiKey:'fixture-key'};
    await read(`window.cardbushDesktop.voice.saveSettings(${JSON.stringify(config)})`);
    // Click records; cancel never uploads or submits.
    await read('document.querySelector(".send-button").click()'); await until('document.querySelector(".voice-composer-label")?.textContent.includes("正在录音")');
    assert.equal(await read('!!document.querySelector(".voice-dialog")'),false,'recording starts compact');
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.resolve('tmp/voice-recording-mini.png'),(await win.webContents.capturePage()).toPNG());
    await click('查看录音状态');await until('document.querySelector(".voice-composer-note")');
    assert.equal(await read('!!document.querySelector(".voice-dialog,.voice-mini")'),false,'no legacy recording UI');
    await click('查看录音状态');await until('!document.querySelector(".voice-composer-note")');
    const miniBefore=await read('document.querySelector(".voice-floating-composer").getBoundingClientRect().x');
    await read('document.querySelector(".voice-floating-composer .voice-drag-handle").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowLeft",bubbles:true}));void 0');
    await pause(50);assert.equal(await read('document.querySelector(".voice-floating-composer").getBoundingClientRect().x'),miniBefore-16);
    await click('取消录音'); assert.equal(requests.length,0);
    await read('document.querySelector(".send-button").click()'); await until('document.querySelector(".voice-composer-label")?.textContent.includes("正在录音")');
    holdTranscription = true;
    await pause(500); await click('发送录音'); await until('!document.querySelector(".voice-overlay") && document.querySelector(".voice-floating-composer")');
    assert.equal(await read('fixture.sent.length'), 0);
    await until('fixture.tracks.every(track=>track.readyState==="ended")');
    // Background transcription must leave typing/focus/Escape alone.
    await read('document.querySelector("input[aria-label=消息]").focus();window.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",cancelable:true}));window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",cancelable:true}));void 0');
    assert.equal(await read('document.activeElement.getAttribute("aria-label")'), '消息');
    for(let i=0;i<100&&!completeTranscription;i++)await pause(30); assert.ok(completeTranscription);
    completeTranscription(503); holdTranscription = false;
    await until('document.querySelector(".voice-composer-label")?.textContent==="语音需要处理"');
    assert.equal(await read('document.querySelector(".voice-composer-status").title'), '语音服务请求失败（HTTP 503）。');
    assert.equal(await read('!!document.querySelector(".voice-overlay")'), false);
    assert.equal(await read('fixture.sent.length'), 0);
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await pause(100);
    fs.writeFileSync(path.resolve('tmp/voice-background-retry.png'), (await win.webContents.capturePage()).toPNG());
    await click('重试发送'); await until('fixture.sent.length===1');
    assert.equal(await read('fixture.sent[0].options===undefined'),true); assert.ok(requests[0].body.length>500); assert.equal(requests[0].authorization,'Bearer fixture-key');
    await until('!document.querySelector(".voice-overlay,.voice-mini,.voice-floating-composer")');
    // Actual pointer hold and release: one call, never a second recording overlay.
    const transcriptionsBeforeCall=requests.filter(r=>r.url.endsWith('/transcriptions')).length;
    const position=await point('.send-button'); win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...position});
    await pause(650); win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...position});
    await until('document.querySelector(".voice-mini") && !document.querySelector(".voice-dialog")');
    await until('document.querySelector(".voice-mini-status")?.textContent.includes("正在聆听")');
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.writeFileSync(path.resolve('tmp/voice-call.png'),(await win.webContents.capturePage()).toPNG());
    // Real MediaRecorder + VAD + IPC: merged speech sends without confirmation.
    await until('document.querySelector(".voice-mini-status")?.textContent.includes("还在听，可以继续")');
    assert.equal(await read('fixture.sent.length'),1,'a live utterance does not interrupt or submit');
    await until('fixture.sent.length===2',10000);
    assert.equal(requests.filter(r=>r.url.endsWith('/transcriptions')).length-transcriptionsBeforeCall,2,'both recording segments are transcribed');
    assert.equal(await read('fixture.tracks.filter(t=>t.readyState==="live").every(t=>t.enabled)'),true);
    await click('展开语音通话');await until('document.querySelector(".voice-dialog")');
    assert.equal(await read('!!document.querySelector(".voice-review")'),false);
    assert.equal(await read('fixture.sent[1].text'),'这是麦克风转写测试 这是麦克风转写测试','thinking pause preserves one complete turn');
    assert.ok(await read('document.querySelector(".voice-lock-status").textContent.includes("未开启")'));
    await click('收起为悬浮按钮');
    assert.equal(await read('fixture.sent[1].options.immediate'),true);
    await read('document.querySelector("button[aria-label=麦克风静音]").click()');
    await read('fixture.sending(true);fixture.messages([{id:"answer",role:"assistant",turnId:"turn",content:"第一句话。后半句"}]);void 0');
    const speechCount=()=>requests.filter(v=>v.url.endsWith('/speech')).length;
    for(let i=0;i<100&&speechCount()<1;i++)await pause(30); assert.equal(speechCount(),1);
    assert.equal(JSON.parse(requests.find(v=>v.url.endsWith('/speech')).body).voice,'nova');
    await until('!document.querySelector(".voice-mini-status")?.textContent.includes("正在播报")');
    await click('展开语音通话'); await until('document.querySelector(".voice-dialog")');
    await read('document.querySelector("[role=combobox][aria-label=音色]").click();void 0');
    await until('document.querySelector("[role=listbox][aria-label=音色]").matches(":popover-open")');
    await read('document.querySelector("[role=listbox][aria-label=音色] [value=male]").click();void 0');
    await until('(async()=> (await window.cardbushDesktop.voice.settings()).voice==="male")()');
    await read('fixture.messages([{id:"answer",role:"assistant",turnId:"turn",content:"第一句话。后半句。"}]);void 0');
    for(let i=0;i<100&&speechCount()<2;i++)await pause(30); assert.equal(speechCount(),2);
    assert.equal(JSON.parse(requests.filter(v=>v.url.endsWith('/speech'))[1].body).voice,'onyx');
    // Drag uses viewport coordinates; minimize preserves the active call and tool progress.
    const beforeDrag = await read('(()=>{const r=document.querySelector(".voice-dialog").getBoundingClientRect();return {x:r.x,y:r.y}})()');
    const dragStart = await read('(()=>{const r=document.querySelector(".voice-dialog-title").getBoundingClientRect();return {x:Math.round(r.x+50),y:Math.round(r.y+12)}})()');
    win.webContents.sendInputEvent({type:'mouseMove',...dragStart});
    win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...dragStart});
    win.webContents.sendInputEvent({type:'mouseMove',x:dragStart.x-60,y:dragStart.y-110});
    win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:dragStart.x-60,y:dragStart.y-110});await pause(100);
    const afterDrag = await read('(()=>{const r=document.querySelector(".voice-dialog").getBoundingClientRect();return {x:r.x,y:r.y}})()');
    assert.ok(Math.abs(afterDrag.x-beforeDrag.x+60)<2,JSON.stringify({beforeDrag,afterDrag}));assert.ok(Math.abs(afterDrag.y-beforeDrag.y+110)<2);
    await read('document.querySelector("button[aria-label=收起为悬浮按钮]").click();void 0');await until('document.querySelector(".voice-mini") && !document.querySelector(".voice-dialog")');
    assert.equal(await read('fixture.tracks.some(track=>track.readyState==="live")'),true);
    await read('fixture.messages([{id:"progress",role:"assistant",turnId:"turn",content:"",toolExecutions:[{id:"browser-call",name:"browser",state:"running",metadata:{displayTitles:{zh:"核对最新行情",en:"Check the latest market"}}}]}]);void 0');
    await until('document.querySelector(".voice-mini-status")?.textContent==="已静音"');
    await pause(250);assert.equal(speechCount(),2,'tool reasons must stay silent');
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await pause(100);
    fs.writeFileSync(path.resolve('tmp/voice-mini.png'),(await win.webContents.capturePage()).toPNG());
    await read('document.querySelector("button[aria-label=展开语音通话]").click();void 0');await until('document.querySelector(".voice-agent-progress")?.textContent.includes("核对最新行情")');
    // Shrink a moved dialog: it remains reachable, with no horizontal overflow.
    win.setSize(520,680);await pause(150);
    assert.equal(await read('(()=>{const r=document.querySelector(".voice-dialog").getBoundingClientRect();return r.left>=7 && r.top>=7 && r.right<=innerWidth-7 && r.bottom<=innerHeight-7})()'),true);
    fs.writeFileSync(path.resolve('tmp/voice-loop-progress.png'),(await win.webContents.capturePage()).toPNG());
    await read('document.querySelector("input[aria-label=消息]").focus();window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",cancelable:true}));void 0');
    assert.equal(await read('!!document.querySelector(".voice-dialog")'),true,'background Escape must not affect the call');
    win.setSize(850,950);
    await read('fixture.session("different-conversation");void 0');
    assert.equal(await read('!!document.querySelector(".voice-dialog")'), true, 'navigation preserves the call');
    assert.equal(await read('fixture.tracks.some(track=>track.readyState==="live")'), true);
    await click('结束通话'); await until('!document.querySelector(".voice-overlay")');
    // Settings use real persistence and remain usable at narrow sizes.
    await read('fixture.settings(true);void 0'); await until('document.querySelector(".voice-settings")');
    await until('!Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="保存").disabled');
    assert.equal(artifactRequests, 0, 'opening settings and starting voice never install a model');
    assert.equal(await read('!!document.querySelector("input[name=voice-microphone]")'), true);
    assert.equal(await read('document.querySelector("input[type=password]").value'), '');
    await click('保存并试听'); for(let i=0;i<100&&speechCount()<3;i++)await pause(30); assert.equal(speechCount(),3);
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await pause(180);
    fs.writeFileSync(path.resolve('tmp/voice-settings.png'),(await win.webContents.capturePage()).toPNG());
    win.setSize(500,800);await pause(150);
    assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'),true);
    await read('document.body.style.setProperty("--surface","#fff");document.body.style.setProperty("--text","#222");document.body.style.setProperty("--text-mid","#666");document.body.style.setProperty("--text-soft","#666");document.body.style.setProperty("--border","#ddd");document.body.style.color="#222";document.body.style.background="#f5f3ef";void 0');
    await pause(100); assert.equal(await read('document.documentElement.scrollWidth<=innerWidth'),true);
    // Embedded content cannot acquire the app microphone.
    const denied=await read(`new Promise(resolve=>{const frame=document.createElement('iframe');frame.srcdoc='<script>navigator.mediaDevices.getUserMedia({audio:true}).then(()=>parent.postMessage("granted","*"),()=>parent.postMessage("denied","*"))<\/script>';addEventListener('message',e=>resolve(e.data),{once:true});document.body.append(frame)})`);
    assert.equal(denied,'denied');
    if (testLocalModel) {
      win.setSize(850,950);
      await click('下载并安装');
      await until('document.querySelector(".voice-model-panel progress")');
      await until('document.querySelector(".voice-model-panel [role=status]").textContent.includes("已安装")', 85000);
      assert.equal(artifactRequests, 2);
      assert.equal((await read('cardbushDesktop.voice.settings()')).recognitionEngine, 'cloud', 'install does not select the model');
      assert.equal(await read('document.querySelector("input[name=voice-recognition]").value'), 'cloud');
      await click('选用此模型');
      assert.equal((await read('cardbushDesktop.voice.settings()')).recognitionEngine, 'cloud', 'draft selection is saved explicitly');
      await click('保存');
      await until('(async()=> (await cardbushDesktop.voice.settings()).recognitionEngine==="sensevoice")()');
      const requestCount = requests.length;
      const sample = fs.readFileSync(path.resolve('tmp/sensevoice-upstream/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17/test_wavs/zh.wav'));
      const result = await read(`cardbushDesktop.voice.transcribe({id:'optional-model',mimeType:'audio/wav',audio:Uint8Array.from(atob(${JSON.stringify(sample.toString('base64'))}),c=>c.charCodeAt(0)).buffer})`);
      assert.match(result.text, /9点|九点/); assert.equal(requests.length, requestCount, 'local recognition does not upload audio');
      await read('document.querySelector(".voice-model-panel").scrollIntoView({block:"center"});void 0'); await pause(150);
      fs.writeFileSync(path.resolve('tmp/voice-optional-model-settings.png'), (await win.webContents.capturePage()).toPNG());
      // Switch back and remove only the isolated fixture install through the UI.
      await read('document.querySelector("button[role=combobox][aria-label=识别方式]").click();void 0');
      await until('document.querySelector("[role=listbox][aria-label=识别方式]").matches(":popover-open")');
      await read('document.querySelector("[role=listbox][aria-label=识别方式] button[value=system]").click();void 0');
      await click('保存'); await until('(async()=> (await cardbushDesktop.voice.settings()).recognitionEngine==="system")()');
      await click('卸载'); await until('(async()=> (await cardbushDesktop.voice.modelStatus()).state==="not-installed")()');
      assert.equal(artifactRequests, 2);
      console.log('Optional-model UI passed: explicit install, pinned extraction, no auto selection, explicit save, offline native IPC and uninstall.');
    }
    if (testSpeechModel) {
      win.setSize(850,950);
      const previousEngine = (await read('cardbushDesktop.voice.settings()')).engine;
      const beforeInstall = artifactRequests;
      const result = await read('cardbushDesktop.voice.installModel("speech")');assert.equal(result.state,'installed',result.error);assert.equal(artifactRequests,beforeInstall+2);
      assert.equal((await read('cardbushDesktop.voice.settings()')).engine,previousEngine,'speech install must not select it');
      await read('fixture.settings(false);void 0');await pause(40);await read('fixture.settings(true);void 0');
      await until('Array.from(document.querySelectorAll(".voice-model-panel")).find(p=>p.textContent.includes("Kokoro"))?.textContent.includes("已安装")');
      await read('Array.from(document.querySelectorAll(".voice-model-panel")).find(p=>p.textContent.includes("Kokoro")).querySelector("button").click();void 0');await click('保存');
      await until('(async()=> (await cardbushDesktop.voice.settings()).engine==="kokoro")()');
      const count = requests.length;
      const chunks = await read('(async()=>{const audio=[];const off=cardbushDesktop.voice.onAudio(chunk=>audio.push(chunk));try{await cardbushDesktop.voice.speak({id:"kokoro-ipc",text:"你好，我先看一下。",voice:"female"});return audio.map(c=>({id:c.id,sampleRate:c.sampleRate,bytes:atob(c.pcm).length}));}finally{off();}})()');
      assert.ok(chunks.length);assert.ok(chunks.every(c=>c.id==='kokoro-ipc'&&c.sampleRate===24000));assert.equal(requests.length,count,'neural speech stays offline');
      const blocked = await read('cardbushDesktop.voice.removeModel("speech").then(()=>false,()=>true)');assert.equal(blocked,true,'cannot remove selected speech engine');
      await read('(async()=>{const s=await cardbushDesktop.voice.settings();await cardbushDesktop.voice.saveSettings({...s,engine:"system"});return cardbushDesktop.voice.removeModel("speech")})()');
      assert.equal((await read('cardbushDesktop.voice.modelStatus("speech")')).state,'not-installed');
      console.log('Kokoro UI/IPC passed: optional isolated installation, explicit selection, offline real PCM and protected uninstall.');
    }
    if (testSpeakerModel) {
      assert.equal((await read('cardbushDesktop.voice.speakerStatus()')).enabled, false);
      const beforeInstall = artifactRequests;
      await read(`Array.from(document.querySelectorAll('.voice-model-panel')).find(p=>p.textContent.includes('CAMPPlus')).querySelector('button').click();void 0`);
      await until('(async()=> (await cardbushDesktop.voice.modelStatus("speaker")).state==="installed")()', 60000);
      assert.equal(artifactRequests, beforeInstall + 2);
      // Enroll from the live call's settings too: releasing its microphone must
      // not unmount the settings panel or cancel the new enrollment recording.
      await read('fixture.settings(false);fixture.sending(false);fixture.messages([]);fixture.session("created");void 0');await pause(30);
      await click('语音通话');await until('document.querySelector(".voice-mini-status")?.textContent.includes("正在聆听")');
      await click('展开语音通话');await click('语音设置');
      await until('!Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="保存").disabled');
      const fillName = async name => { await read(`(()=>{const input=document.querySelector('.speaker-name-form input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(name)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`); };
      await click('添加人员'); await fillName('测试本人'); await click('保存人员');
      await until('document.querySelector(".speaker-person")?.textContent.includes("测试本人")');
      const ownerId = (await read('cardbushDesktop.voice.speakerStatus()')).activeProfileId;
      await click('准备第一段');
      assert.ok((await read('document.querySelector(".speaker-recorder").innerText')).includes('不会自动录音'));
      await click('开始本段录音'); await until('document.querySelector(".speaker-recorder.is-recording")');
      await pause(120);
      assert.equal(await read('!!document.querySelector(".voice-settings-dialog .speaker-enrollment")'),true);
      assert.equal(await read('fixture.tracks.filter(track=>track.readyState==="live").length'),1);
      await click('取消本段'); await until('!document.querySelector(".speaker-recorder")');
      assert.equal(await read('fixture.tracks.every(track=>track.readyState==="ended")'),true);
      assert.equal((await read('cardbushDesktop.voice.speakerStatus()')).enrolled, false);
      await click('关闭');await until('!document.querySelector(".voice-overlay")');
      await read('fixture.settings(true);void 0');await until('document.querySelector(".voice-settings")');
      const sample = name => fs.readFileSync(path.resolve('tmp/voice-speaker-research', name));
      const pcm = wav => { for(let at=12;at+8<=wav.length;){const n=wav.readUInt32LE(at+4);if(wav.toString('ascii',at,at+4)==='data')return wav.subarray(at+8,at+8+n);at+=8+n+n%2;}throw Error('No PCM'); };
      const joined = names => {const data=Buffer.concat(names.map(name=>pcm(sample(name)))),wav=Buffer.alloc(44+data.length);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(data.length,40);data.copy(wav,44);return wav.toString('base64');};
      // Public upstream samples only. Join short enrollment clips to meet our
      // minimum duration; the verification clip is separate from enrollment.
      const clips = [['fangjun-sr-1.wav','fangjun-sr-2.wav'],['fangjun-sr-2.wav','fangjun-sr-3.wav'],['fangjun-sr-3.wav','fangjun-sr-1.wav']].map(joined);
      // Feed public speech through the real browser capture / preview / save UI,
      // without opening a physical microphone or persisting captured user audio.
      await read(`window.speakerBytes=value=>Uint8Array.from(atob(value),c=>c.charCodeAt(0)).buffer;
        navigator.mediaDevices.getUserMedia=async()=>{const context=new AudioContext();const source=context.createBufferSource();source.buffer=await context.decodeAudioData(speakerBytes(fixture.enrollmentAudio));const destination=context.createMediaStreamDestination();source.connect(destination);source.start();for(const track of destination.stream.getTracks()){const stop=track.stop.bind(track);track.stop=()=>{stop();source.stop();void context.close();};fixture.tracks.push(track);}return destination.stream;};void 0`);
      const snapshot = async name => { await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await pause(180);fs.writeFileSync(path.resolve(`tmp/${name}.png`),(await win.webContents.capturePage()).toPNG()); };
      win.setSize(850,950);
      const theme = async dark => read(`(()=>{const s=document.body.style;s.setProperty('--surface',${JSON.stringify(dark ? '#222' : '#fff')});s.setProperty('--text',${JSON.stringify(dark ? '#eee' : '#222')});s.setProperty('--text-soft',${JSON.stringify(dark ? '#aaa' : '#666')});s.setProperty('--text-mid',${JSON.stringify(dark ? '#bbb' : '#666')});s.setProperty('--border',${JSON.stringify(dark ? '#444' : '#ddd')});s.color=${JSON.stringify(dark ? '#eee' : '#222')};s.background=${JSON.stringify(dark ? '#181818' : '#f5f3ef')};})()`);
      await theme(true);
      for(let index=0;index<clips.length;index++) {
        await read(`fixture.enrollmentAudio=${JSON.stringify(clips[index])};void 0`);
        await click(index===0?'准备第一段':'录制下一段');
        await click('开始本段录音'); await until('document.querySelector(".speaker-recorder.is-recording")');
        if(index===0) await snapshot('voice-speaker-recording');
        await until('document.querySelector(".speaker-recorder.is-preview")',18000);
        assert.equal(await read('fixture.tracks.every(track=>track.readyState==="ended")'),true);
        assert.equal((await read('cardbushDesktop.voice.speakerStatus()')).profiles[0].samples.length,index,'preview is not saved automatically');
        if(index===0) {
          await snapshot('voice-speaker-preview');
          assert.equal(await read('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="使用这一段").getBoundingClientRect().bottom<=innerHeight'),true,'save action stays visible after preview grows');
        }
        await click('使用这一段');
        await until(`document.querySelectorAll('.speaker-sample').length===${index+1}`,15000);
        assert.equal(await read('!!document.querySelector(".speaker-recorder")'),false,'no automatic next clip');
      }
      const stored=fs.readFileSync(path.join(app.getPath('userData'),'voice-speaker-profile.json'),'utf8');assert.ok(!stored.includes('vectors'));assert.ok(!stored.includes('campplus'));assert.ok(!stored.includes('测试本人'));assert.ok(!stored.includes('今天'));
      assert.equal((await read('cardbushDesktop.voice.speakerStatus()')).enabled,false);
      await read('fixture.settings(false);void 0');await pause(30);await read('fixture.settings(true);void 0');
      await until('Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="开启声纹锁定"&&!b.disabled)');
      await click('开启声纹锁定');await until('(async()=> (await cardbushDesktop.voice.speakerStatus()).enabled)()');
      await click('添加人员');await fillName('另一位使用者');await click('保存人员');
      await until('document.querySelectorAll(".speaker-person").length===2');
      assert.equal((await read('cardbushDesktop.voice.speakerStatus()')).activeProfileId,ownerId,'browsing another person never authorizes them');
      assert.equal(await read('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="使用此人").disabled'),true,'incomplete person cannot be selected');
      await read('document.querySelector(".speaker-lock").scrollIntoView({block:"start"});void 0');await snapshot('voice-speaker-profiles');
      win.setSize(500,800);await theme(false);
      await snapshot('voice-speaker-profiles-narrow');
      assert.equal(await read('document.querySelector(".voice-settings").scrollWidth<=document.querySelector(".voice-settings").clientWidth'),true,'no horizontal overflow in narrow settings');
      await read('window.confirm=()=>true;void 0');await click('删除人员');await until('document.querySelectorAll(".speaker-person").length===1');
      assert.equal((await read('cardbushDesktop.voice.speakerStatus()')).enabled,true,'deleting an inactive person preserves lock');
      await click('管理第 2 段');await click('收起');
      assert.equal((await read('cardbushDesktop.voice.speakerStatus()')).profiles[0].samples.length,3,'cancelled replacement keeps all samples');
      win.setSize(850,950);await theme(true);await read('document.querySelector(".speaker-lock").scrollIntoView({block:"start"});void 0');await snapshot('voice-speaker-lock');
      const beforeForeign=requests.length;
      for(const name of ['leijun-test-sr-1.wav','liudehua-test-sr-1.wav']) {
        const result=await read(`cardbushDesktop.voice.transcribe({id:crypto.randomUUID(),audio:speakerBytes(${JSON.stringify(sample(name).toString('base64'))}),mimeType:'audio/wav'})`);
        assert.deepEqual(result,{text:'',speaker:'rejected'});
      }
      assert.equal(requests.length,beforeForeign,'foreign speech must never reach the cloud API');
      const accepted=await read(`cardbushDesktop.voice.transcribe({id:'speaker-allowed',audio:speakerBytes(${JSON.stringify(sample('fangjun-test-sr-1.wav').toString('base64'))}),mimeType:'audio/wav'})`);
      assert.equal(accepted.text,'这是麦克风转写测试');assert.equal(requests.length,beforeForeign+1);
      await click('删除人员');await until('(async()=> !(await cardbushDesktop.voice.speakerStatus()).enrolled)()');
      assert.equal((await read('cardbushDesktop.voice.speakerStatus()')).enabled,false);
      assert.equal((await read('cardbushDesktop.voice.speakerStatus()')).profiles.length,0);
      await read('cardbushDesktop.voice.removeModel("speaker")');
      console.log('Speaker UI/IPC passed: optional installation, live-call microphone cleanup, manual per-clip capture/preview/save, encrypted named profiles, single-person authorization, narrow layout, real owner/foreign verification and deletion.');
    }
    assert.deepEqual(errors.filter(value=>!/Permissions policy|permissions policy/.test(value)),[]);
    console.log('Voice UI passed: local mode without a key, browser audio conversion and native Chinese dictation, system/cloud playback, fake-device microphone/VAD, click/hold, cancellation, settings and frame permissions.');
  } finally { win.destroy(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
}).then(()=>{clearTimeout(deadline);app.exit(0)},error=>{console.error(error);clearTimeout(deadline);app.exit(1)});
