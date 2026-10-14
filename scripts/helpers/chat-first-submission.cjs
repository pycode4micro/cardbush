const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  await window.webContents.insertCSS('.app { width:100%!important; }');
  await window.webContents.insertCSS(fs.readFileSync(path.join(root, 'src/styles/composer.css'), 'utf8'));
  await run(`
    window.updateChat=patch=>{Object.assign(chatProps,patch);renderView(h('section',{className:'main-stage',style:{height:'100%'}},h(views.ChatPanel,chatProps)));};
    window.firstFrames=[]; window.firstNodes=new Set();
    window.sampleFirst=()=>{
      const input=document.querySelector('[data-composer-input]'),surface=document.querySelector('.composer-surface');
      const button=document.querySelector('.scroll-bottom'),dock=document.querySelector('.composer-dock');
      if(input)firstNodes.add(input);
      firstFrames.push({input:!!input,focus:document.activeElement===input,welcome:!!document.querySelector('.welcome-composer'),
        surfaceTop:surface?.getBoundingClientRect().top, surfaceHeight:surface?.getBoundingClientRect().height,
        buttonBottom:button?.getBoundingClientRect().bottom,dockTop:dock?.getBoundingClientRect().top,
        voice:!!document.querySelector('.voice-idle-button'),actionsWidth:document.querySelector('.composer-actions')?.getBoundingClientRect().width});
      window.firstFrame=requestAnimationFrame(sampleFirst);
    };
    window.startFirst=(style,custom,long,completeAtAdmission)=>{
      const saved=JSON.parse(localStorage.getItem(views.componentStorageKey))||views.defaultComponents;
      views.saveComponents({...saved,items:saved.items.map(item=>item.id==='system-input'?{...item,inputStyle:style}:item),
        welcomeLayout:custom?{viewportHeight:750,items:[{componentId:'system-input',x:10,y:260,width:80,height:120,inputStyle:style,composerFlow:{afterSend:'bottom',output:'above'}}]}:undefined},saved.revision);
      window.firstSends=0;
      updateChat({language:'zh',activeConversationId:'',messages:[],loading:false,historyLoading:false,sending:false,activeTurnId:'',draft:long?('第一条消息的多行内容\\n'.repeat(10)):'第一条消息',
        availableModels:[{id:'fixture',modelName:'Test model',provider:'fixture',enabled:true}],
        onDraftChange:draft=>updateChat({draft}),onSend:async text=>{
          firstSends++;
          await new Promise(resolve=>setTimeout(resolve,160));
          updateChat({activeConversationId:'first-'+style+custom,sending:true,activeTurnId:'first-turn',messages:[
            {id:'first-user',role:'user',content:text,turnId:'first-turn'},
            {id:'first-assistant',role:'assistant',content:'处理中',turnId:'first-turn'}]});
          if(completeAtAdmission)return true;
          await new Promise(resolve=>window.finishFirstTurn=resolve);
        }});
    };
    void 0;
  `);
  const results=[];
  const cases = ['standard','simple'].flatMap(style => [
    {style,custom:false,zoom:1}, {style,custom:true,zoom:1},
    {style,custom:false,zoom:1,long:true}, {style,custom:true,zoom:1.25},
  ]).concat({style:'standard',custom:false,zoom:1,completeAtAdmission:true});
  for(const {style,custom,zoom,long=false,completeAtAdmission=false} of cases) {
    await run(`document.querySelector('.app').style.zoom=${zoom};startFirst(${JSON.stringify(style)},${custom},${long},${completeAtAdmission})`);
    await until('!!document.querySelector(".welcome-composer [data-composer-input]")','welcome input'); await pause(180);
    await run('firstFrames=[];firstNodes=new Set();document.querySelector("[data-composer-input]").focus();sampleFirst();for(let n=0;n<2;n++)document.querySelector("[data-composer-input]").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}));');
    await until('!!document.querySelector(".message-list")','first transcript'); await pause(600);
    const state=await run('cancelAnimationFrame(firstFrame);({frames:firstFrames,nodes:firstNodes.size})');
    results.push({style,custom,zoom,long,completeAtAdmission,...state});
    assert.equal(state.nodes,1,'first admission keeps the mounted input');
    assert.ok(state.frames.every(frame=>frame.input&&frame.focus),'input and focus remain available on every frame');
    const widths=state.frames.map(frame=>frame.actionsWidth);
    assert.ok(Math.max(...widths)-Math.min(...widths)<1,'the action bar never shrinks to idle controls during admission');
    const settled=state.frames.at(-1);
    assert.ok(Math.abs(settled.surfaceTop-settled.buttonBottom-8*zoom)<2,'bottom shortcut follows the final composer position, including zoom');
    const transcriptFrames=state.frames.filter(frame=>!frame.welcome);
    assert.ok(Math.max(...transcriptFrames.map(f=>f.dockTop))-Math.min(...transcriptFrames.map(f=>f.dockTop))<2,'the transcript backdrop stays at its final position');
    if(!custom)assert.ok(state.frames.every((frame,index)=>index===0||frame.surfaceTop>=state.frames[index-1].surfaceTop-1),'a docked welcome input never jumps up to replay its old multiline height');
    assert.equal(await run('firstSends'),1,'repeated confirmation cannot submit twice before admission');
    assert.notEqual(await run('document.querySelector(".send-button")?.getAttribute("aria-label")'),'正在提交','running turns release the local submission lock without waiting for their completion');
    if(!completeAtAdmission)await run('finishFirstTurn();void 0');
  }
  await run(`window.admittedInput=document.querySelector('[data-composer-input]');
    updateChat({activeConversationId:'another-existing-session',sending:false,activeTurnId:'',draft:'另一会话草稿'});`);
  await until('document.querySelector("[data-composer-input]") !== admittedInput','switching sessions resets transient composer state');
  await run(`updateChat({activeConversationId:'',messages:[],draft:'未被接受的消息',onSend:async()=>false});`);
  await until('!!document.querySelector(".welcome-composer [data-composer-input]")','welcome for rejected submission');
  await run(`window.rejectedInput=document.querySelector('[data-composer-input]'); rejectedInput.focus();
    rejectedInput.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));`);
  await until('document.querySelector("[data-composer-input]").value === "" && !document.querySelector("[aria-label=正在提交]")','rejected submission settles');
  await run(`updateChat({activeConversationId:'opened-after-rejection',messages:[{id:'existing-user',role:'user',content:'已有会话'}]});`);
  await until('document.querySelector("[data-composer-input]") !== rejectedInput','failed submission cannot adopt a later unrelated session');
  fs.writeFileSync(path.join(root,'tmp','first-submission-frames.json'),JSON.stringify(results,null,2));
  console.log('First submission passed: stable input/focus, admission controls, duplicate guard, fixed backdrop and bottom shortcut across 9 standard/simple, multiline, custom, zoom and early-acknowledgement cases; session switching and rejection remain isolated.');
};
