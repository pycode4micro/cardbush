// Real renderer controls and production theme CSS, with no microphone, network or user profile access.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const result = require('node:child_process').spawnSync(electron, [__filename], { env, windowsHide: true, stdio: 'inherit', timeout: 60000 });
  if (result.error) console.error(result.error);
  process.exit(result.status ?? 1);
}
const { app, BrowserWindow } = electron;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const directory = fs.mkdtempSync(path.resolve('tmp/voice-settings-render-'));
app.setPath('userData', path.join(directory, 'profile')); app.disableHardwareAcceleration();
const deadline = setTimeout(() => app.exit(1), 55000);
app.whenReady().then(async () => {
  const { build } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const file = name => JSON.stringify(path.resolve(name).replaceAll('\\', '/'));
  const built = await build({ configFile: false, logLevel: 'error', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [react(), {
    name: 'voice-settings-render', resolveId: id => id.endsWith('__voice_settings_render__.tsx') ? '\0voice-settings-render.tsx' : undefined,
    load: id => id === '\0voice-settings-render.tsx' ? `
      import React, { useState } from 'react';import { createRoot } from 'react-dom/client';
      import ${file('src/styles/theme.css')};import ${file('src/styles/app.css')};import ${file('src/styles/appearance.css')};
      import { VoiceConversation, VoiceButton } from ${file('src/features/voice/VoiceConversation.tsx')};
      import { SettingsDropdown } from ${file('src/features/settings/SettingsDropdown.tsx')};
      import { defaultVoiceSettings } from ${file('electron/voiceTypes.ts')};
      let settings={...defaultVoiceSettings};
      window.cardbushDesktop={voice:{settings:async()=>settings,saveSettings:async value=>(settings=value),
        chooseSpeechPath:async kind=>window.nextSpeechPath??null,
        inspectSpeechModel:async directory=>({kind:'qwen3-customvoice',name:'Qwen3-TTS CustomVoice (1.7B)',directory,
          voices:['serena','vivian','uncle_fu','ryan','aiden','ono_anna','sohee','eric','dylan'].map(id=>({id,name:id})),
          defaultFemaleVoice:'serena',defaultMaleVoice:'uncle_fu',supportsInstructions:true,runtimeAvailable:true,suggestedPythonPath:'/models/.venv/bin/python'}),
        capabilities:async()=>({available:false,voices:[],recognizers:[],error:'UI test: no microphone or speech engine is used.'}),
        modelStatus:async()=>({supported:true,state:'not-installed',totalBytes:0,downloadedBytes:0,sources:[]}),
        speakerStatus:async()=>({enabled:false,mode:'strict',enrolled:false,profiles:[]}),cancel:async()=>{},onAudio:()=>()=>{}}};
      function Fixture(){const [theme,setTheme]=useState('dark'),[font,setFont]=useState(1),[custom,setCustom]=useState(false);
        window.fixture={theme:setTheme,font:setFont,custom:setCustom};
        return <div className={'app theme-'+theme} style={{'--ui-font-scale':font,...(custom?{'--surface':'#203442','--surface-strong':'#284557','--text':'#fff2cc','--accent':'#a7e8bd'}:{})}}>
          <VoiceConversation language="zh" target={{environment:'local',sessionId:'render-test',messages:[],sending:false,submit:async()=>{}}}>
            <VoiceButton language="zh" callOnly/>
            <div className="settings-shell" style={{position:'fixed',right:16,bottom:16,width:210}}><SettingsDropdown label="Long choices" value="59" onChange={()=>{}} options={Array.from({length:60},(_,i)=>({value:String(i),label:'Local voice '+i+' — 中英文自然音色与语音识别模型（需要安装）'}))}/></div>
          </VoiceConversation>
        </div>;
      }
      createRoot(document.getElementById('root')).render(<Fixture/>);
    ` : undefined,
  }], build: { write:false, minify:false, lib:{ entry:path.resolve('src/__voice_settings_render__.tsx'),name:'VoiceSettingsRender',formats:['iife'] } } });
  const output = Array.isArray(built) ? built[0].output : built.output;
  for(const asset of output.filter(item=>item.type==='asset')) { const target=path.join(directory,asset.fileName);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,asset.source); }
  fs.writeFileSync(path.join(directory,'index.html'),`<html><meta charset="utf-8"><style>${output.filter(item=>item.type==='asset'&&item.fileName.endsWith('.css')).map(item=>item.source).join('\n')}</style><div id="root"></div><script>${output.find(item=>item.type==='chunk').code.replaceAll('</script','<\\/script')}</script></html>`);
  const win = new BrowserWindow({show:false,width:920,height:850,webPreferences:{contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false}});
  const errors=[];
  win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
  win.webContents.session.webRequest.onBeforeRequest((details,callback)=>callback({cancel:/^https?:/.test(details.url)}));
  const read = code => win.webContents.executeJavaScript(code);
  const until = async code => {for(let i=0;i<100;i++){if(await read(code))return;await pause(25);}throw Error('Timed out: '+code+'\n'+await read('document.body.innerText'));};
  const click = label => read(`Array.from(document.querySelectorAll('button')).find(b=>b.getAttribute('aria-label')===${JSON.stringify(label)}||b.textContent===${JSON.stringify(label)}).click();void 0`);
  const key = async keyCode => { win.webContents.sendInputEvent({type:'keyDown',keyCode});win.webContents.sendInputEvent({type:'keyUp',keyCode});await pause(40); };
  const openChoice = async label => {await read(`(()=>{const b=document.querySelector('[role=combobox][aria-label="${label}"]');b.scrollIntoView({block:'center'});b.focus();})()`);await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await click(label);await until(`document.querySelector('[role=listbox][aria-label="${label}"]').matches(':popover-open')`);await pause(160);};
  const snapshot = async name => {await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');await pause(150);fs.writeFileSync(path.resolve('tmp/'+name+'.png'),(await win.webContents.capturePage(undefined,{stayHidden:true})).toPNG());};
  const geometry = () => read(`(()=>{const m=document.querySelector('.settings-dropdown-popover:popover-open'),r=m.getBoundingClientRect();const rows=[...m.children].map(n=>{const r=n.getBoundingClientRect(),s=getComputedStyle(n);return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,display:s.display,border:s.borderTopWidth};});return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight,scroll:m.scrollWidth>m.clientWidth,rows,bg:getComputedStyle(m).backgroundColor,color:getComputedStyle(m).color,scheme:getComputedStyle(m).colorScheme};})()`);
  try {
    await win.loadFile(path.join(directory,'index.html'));await until('document.querySelector(".voice-call-entry,button[aria-label=语音通话]")');
    await click('语音通话');await until('document.querySelector(".voice-mini")');
    assert.equal(await read('!!document.querySelector(".app .voice-mini")'),true,'floating control inherits application theme');
    await click('展开语音通话');await click('语音设置');await until('document.querySelector(".voice-settings-dialog")');
    assert.equal(await read('!!document.querySelector(".app .voice-settings-dialog")'),true,'dialog inherits application theme');
    for(const [theme,width,scale] of [['dark',920,1],['bright',500,1],['dark',500,1.5]]) {
      win.setSize(width,850);await read(`fixture.theme(${JSON.stringify(theme)});fixture.font(${scale});void 0`);await pause(100);
      await openChoice('音色');const g=await geometry();
      assert.equal(g.rows.length,2);assert.equal(g.scroll,false);assert.ok(g.rows[0].bottom<=g.rows[1].top+.5,'options do not overlap');
      assert.ok(g.rows.every(row=>row.display==='flex'&&row.border==='0px'&&row.left>=g.left&&row.right<=g.right),'options stay flat and inside the menu');
      assert.ok(g.left>=0&&g.top>=0&&g.right<=g.width&&g.bottom<=g.height,'menu fits viewport');
      assert.equal(g.scheme,theme==='dark'?'dark':'light');assert.notEqual(g.bg,'rgba(0, 0, 0, 0)','opaque menu hides controls behind it');
      await snapshot('voice-dropdown-'+theme+'-'+scale);
      await key('ESCAPE');await until('!document.querySelector(".settings-dropdown-popover:popover-open")');
      assert.equal(await read('!!document.querySelector(".voice-settings-dialog")'),true,'Escape closes only the list');
      await openChoice('音色');await key('END');await key('ENTER');
      assert.equal(await read('document.querySelector("[role=combobox][aria-label=音色]").value'),'male');
      await openChoice('音色');await key('TAB');
      assert.equal(await read('document.activeElement.getAttribute("role")'), 'combobox');
      assert.equal(await read('document.activeElement.getAttribute("aria-label")'),'语速','Tab skips hidden options and hidden input');
      assert.equal(await read('document.querySelector(".voice-settings-dialog").scrollWidth<=document.querySelector(".voice-settings-dialog").clientWidth'),true);
    }
    await openChoice('声纹严格程度');const match=await geometry();assert.ok(match.rows.every(row=>row.border==='0px'&&row.display==='flex'),'speaker panel does not restyle its options');await key('ESCAPE');
    await openChoice('音色');await read('fixture.custom(true);void 0');await pause(100);
    const custom=await geometry();assert.equal(custom.bg,'rgb(40, 69, 87)');assert.equal(custom.color,'rgb(255, 242, 204)','open menu updates with imported theme');await key('ESCAPE');
    // All voices are already in the installed bank; theme/scrolling applies to
    // the real 45-option male selector as well as the generic dropdown fixture.
    await openChoice('朗读方式');await read('document.querySelector("[role=listbox][aria-label=朗读方式] [value=kokoro]").click();void 0');
    await openChoice('本地音色');assert.equal((await geometry()).rows.length,45);
    await key('END');await key('ENTER');await click('保存');
    assert.equal((await read('cardbushDesktop.voice.settings()')).kokoroMaleVoice,102);
    assert.ok(await read('document.querySelector("[role=combobox][aria-label=本地音色]").textContent.includes("zm_100")'));
    await openChoice('音色');await key('HOME');await key('ENTER');
    await openChoice('本地音色');assert.equal((await geometry()).rows.length,55);await key('ESCAPE');
    assert.ok(await read('document.querySelector("[role=combobox][aria-label=本地音色]").textContent.includes("zf_001")'));
    assert.equal(await read('document.querySelector("input[name=kokoro-style]").value'),'warm');
    await snapshot('voice-kokoro-presets');
    await openChoice('通话停顿等待');await key('END');await key('ENTER');await click('保存');
    assert.equal((await read('cardbushDesktop.voice.settings()')).turnEndPause,'patient');
    await openChoice('朗读方式');
    assert.equal(await read('document.querySelector("[role=listbox][aria-label=朗读方式] [role=option]").getAttribute("value")'),'qwen','Qwen is the primary recommended option');
    await read('document.querySelector("[role=listbox][aria-label=朗读方式] [value=qwen]").click();void 0');
    await click('选择目录');assert.equal(await read('document.querySelector("input[aria-label=模型目录]").value'),'','cancelled chooser preserves the draft');
    await read('window.nextSpeechPath="/models/Qwen3-TTS-CustomVoice";void 0');await click('选择目录');
    await until('document.querySelector("[role=combobox][aria-label=男声使用的音色]")');
    assert.ok(await read('document.querySelector(".voice-custom-model").textContent.includes("9 个音色")'));
    assert.equal(await read('!!document.querySelector("[role=combobox][aria-label=语速]")'),false,'Qwen does not advertise unsupported rate changes');
    await openChoice('男声使用的音色');assert.equal((await geometry()).rows.length,9);
    await read('document.querySelector("[role=listbox][aria-label=男声使用的音色] [value=ryan]").click();void 0');
    await read('window.nextSpeechPath="/models/.venv/bin/python";void 0');await click('选择 Python');
    await click('保存');
    const imported=await read('cardbushDesktop.voice.settings()');assert.equal(imported.engine,'qwen');assert.equal(imported.speed,1);assert.equal(imported.customSpeech.maleVoice,'ryan');assert.equal(imported.customSpeech.pythonPath,'/models/.venv/bin/python');
    assert.ok(!await read('document.querySelector(".voice-settings").textContent.includes("Kokoro v1.1")'),'Qwen does not display the legacy installer');
    assert.equal(await read('document.querySelector(".voice-settings-dialog").scrollWidth<=document.querySelector(".voice-settings-dialog").clientWidth'),true,'custom settings fit narrow scaled windows');
    await read('document.querySelector(".voice-custom-model").scrollIntoView({block:"start"});void 0');await snapshot('voice-custom-model');
    await click('关闭');await until('!document.querySelector(".voice-settings-dialog")');
    await click('语音设置');await until('document.querySelector("[role=combobox][aria-label=男声使用的音色]")');
    assert.equal(await read('document.querySelector("input[aria-label=模型目录]").value'),'/models/Qwen3-TTS-CustomVoice');
    assert.equal(await read('document.querySelector("[role=combobox][aria-label=男声使用的音色]").value'),'ryan');
    assert.equal(await read('document.querySelector("[role=combobox][aria-label=通话停顿等待]").value'),'patient');
    await click('关闭');await until('!document.querySelector(".voice-settings-dialog")');
    await openChoice('Long choices');const long=await geometry();assert.equal(long.scroll,false);assert.ok(long.top>=0&&long.bottom<=long.height);assert.ok(long.rows[0].bottom-long.rows[0].top>40,'long names wrap');
    assert.equal(await read('(()=>{const m=document.querySelector(".settings-dropdown-popover:popover-open"),o=m.querySelector("[aria-selected=true]");return o.offsetTop>=m.scrollTop&&o.offsetTop+o.offsetHeight<=m.scrollTop+m.clientHeight;})()'),true,'selected item in a long list is scrolled into view');
    await key('HOME');await key('ARROWDOWN');await key('END');await key('ESCAPE');
    assert.deepEqual(errors,[]);
    console.log('Voice settings rendering passed: themed portals, flat options, keyboard selection/Escape/Tab, long lists, narrow windows, font scaling and live custom themes.');
  } finally {win.destroy();}
}).then(()=>{clearTimeout(deadline);app.exit(0);},error=>{console.error(error);clearTimeout(deadline);app.exit(1);});
