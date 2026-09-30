const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  await window.webContents.insertCSS('.app { width:100%!important; }');
  await run(`
    window.saveFlow=(afterSend,output)=>{
      const saved=JSON.parse(localStorage.getItem(views.componentStorageKey))||views.defaultComponents;
      views.saveComponents({...saved,items:saved.items.map(item=>item.id==='system-input'?{...item,inputStyle:'simple'}:item),
        welcomeLayout:{items:[{componentId:'system-input',x:10,y:260,width:80,height:120,composerFlow:{afterSend,output}}]}},saved.revision);
    };
    window.longReply=Array.from({length:28},(_,i)=>'Paragraph '+i+': '+('This is a readable paragraph with a stable layout. '.repeat(4))).join('\\n\\n');
    window.reply=(content=longReply,status='running')=>updateChat({messages:[chatProps.messages[0],{id:'layout-assistant',role:'assistant',content,turnId:'layout-turn',status}]});
    window.startFlow=async(afterSend,output,id)=>{
      saveFlow(afterSend,output);
      updateChat({loading:false,historyLoading:false,activeConversationId:id,welcomeEnabled:true,embedded:false,
        messages:[],sending:false,activeTurnId:'',draft:'Start this conversation',availableModels:[{id:'fixture',modelName:'Test model',provider:'fixture',enabled:true}],
        onDraftChange:draft=>updateChat({draft}),onSend:async text=>{const count=chatProps.messages.filter(m=>m.role==='user').length,turnId=count?'layout-turn-'+count:'layout-turn';updateChat({draft:'',sending:true,activeTurnId:turnId,messages:[...chatProps.messages,{id:count?'layout-user-'+count:'layout-user',role:'user',content:text,turnId}]});return true;}});
    };
    window.layoutRect=selector=>{const a=document.querySelector(selector).getBoundingClientRect(),b=document.querySelector('.chat-body').getBoundingClientRect();return {top:a.top-b.top,left:a.left-b.left,width:a.width,bottom:a.bottom-b.top};};
    startFlow('keep','below','layout-below');
  `);
  await until('!!document.querySelector(".welcome-composer .composer-stack")','welcome composer');
  await pause();
  const original = await run('layoutRect(".welcome-composer .composer-stack")');
  await run('document.querySelector(".send-button").click()');
  await until('!!document.querySelector(".message-list")','first send'); await pause();
  const sent = await run('layoutRect(".composer-dock .composer-stack")');
  assert.ok(Math.abs(original.top-sent.top)<=2, `keep composer at ${original.top}, got ${sent.top}`);
  assert.ok(Math.abs(original.left-sent.left)<=2 && Math.abs(original.width-sent.width)<=2,`keep horizontal placement: ${JSON.stringify({original,sent})}`);
  assert.equal(await run('document.querySelector(".message-list").scrollTop'),0,'first send does not jump');
  assert.ok(await run('layoutRect(".message-list-item").top>=layoutRect(".composer-dock").bottom+12'),'output begins below input');
  await run('reply()'); await pause();
  assert.equal(await run('document.querySelector(".message-list").scrollTop'),0,'growing output does not scroll');
  assert.ok(Math.abs((await run('layoutRect(".composer-dock")')).top-original.top)<=2,'growing output does not push composer up');
  assert.ok(await run('document.querySelector(".message-list").scrollHeight>document.querySelector(".message-list").clientHeight'),'content stays scrollable');
  await run('updateChat({draft:Array(5).fill("A multiline draft").join("\\n")})'); await pause();
  assert.ok(await run('layoutRect(".message-list-item").top>=layoutRect(".composer-dock").bottom+12'),'growing input still leaves output below');
  await run('updateChat({draft:""})'); await pause();
  await run('document.querySelector(".message-list").scrollTop=650'); await pause();
  assert.ok(Math.abs((await run('layoutRect(".composer-dock")')).top-12)<=1,'scroll pins with top space');
  const scroll = await run('document.querySelector(".message-list").scrollTop');
  await run('reply(longReply+"\\n\\nMore output");updateChat({draft:"Keep my input"});window.layoutInput=document.querySelector("[data-composer-input]");void 0;'); await pause();
  assert.ok(Math.abs((await run('document.querySelector(".message-list").scrollTop'))-scroll)<=1,'stream does not hijack manual scroll');
  assert.equal(await run('document.querySelector("[data-composer-input]")===layoutInput'),true,'stream keeps one input');
  await run('document.querySelector(".composer-surface").dispatchEvent(new WheelEvent("wheel",{bubbles:true,cancelable:true,deltaY:80}));'); await pause();
  const afterWheel = await run('document.querySelector(".message-list").scrollTop');
  assert.ok(afterWheel>scroll+60,'wheel over composer scrolls transcript');
  await run('document.querySelector(".message-list").scrollTop='+scroll); await pause();
  fs.writeFileSync(path.join(root,'tmp','composer-layout-below.png'),(await window.webContents.capturePage()).toPNG());
  await run('updateChat({activeConversationId:"other-layout",messages:[{id:"other",role:"user",content:"other"}],sending:false});'); await pause();
  await run('updateChat({activeConversationId:"layout-below",messages:[{id:"layout-user",role:"user",content:"Start this conversation",turnId:"layout-turn"},{id:"layout-assistant",role:"assistant",content:longReply,turnId:"layout-turn",status:"running"}],sending:true,activeTurnId:"layout-turn"})'); await pause();
  assert.ok(Math.abs((await run('document.querySelector(".message-list").scrollTop'))-scroll)<=2,'switching preserves reading position');

  await run('startFlow("keep","above","layout-above")'); await until('!!document.querySelector(".welcome-composer")','above welcome'); await pause();
  await run('document.querySelector(".send-button").click()'); await until('!!document.querySelector(".message-list")','above first send');
  await run('reply()'); await pause();
  assert.ok(await run('layoutRect(".message-list-item").top<layoutRect(".composer-dock").top'),'output starts above');
  assert.equal(await run('document.querySelectorAll("[data-composer-clearance]").length'),1,'one clearance at composer crossing');
  assert.equal(await run('document.querySelectorAll(".message-list").length'),1,'one scrollable transcript');
  assert.equal(await run('document.querySelectorAll("[data-composer-input]").length'),1,'one composer');
  const checkClearance = () => run(`(()=>{const d=layoutRect('.composer-dock'),s=document.querySelector('.message-list'),vp=s.getBoundingClientRect();
    return [...s.querySelectorAll('.markdown-content p')].every(p=>{const r=document.createRange();r.selectNodeContents(p);const a=r.getBoundingClientRect(),y=a.top-vp.top+s.scrollTop,h=a.height;
      return y+h<=d.top-10||y>=d.bottom+10;});})()`);
  assert.equal(await checkClearance(),true,'no paragraph text hidden under composer');
  await run('reply("# Heading\\n\\n"+longReply+"\\n\\n");updateChat({draft:"Stable draft"});window.layoutInput=document.querySelector("[data-composer-input]");void 0;'); await pause();
  assert.equal(await checkClearance(),true,'updated markdown remains clear');
  assert.equal(await run('document.querySelector(".message-list").scrollTop'),0,'above stream stays in place');
  assert.equal(await run('document.querySelector("[data-composer-input]")===layoutInput'),true,'reflow does not remount input');
  fs.writeFileSync(path.join(root,'tmp','composer-layout-above.png'),(await window.webContents.capturePage()).toPNG());
  await run('document.querySelector(".chat-content-frame").style.setProperty("--work-summary-content-inset","300px");updateChat({draft:"Keep clear of the summary"})');
  await until('parseFloat(getComputedStyle(document.querySelector(".message-list-content")).marginRight)>299 && layoutRect(".composer-dock").left+layoutRect(".composer-dock").width<=document.querySelector(".message-list").clientWidth-300', 'docked summary transition settles');
  const summary = await run('({dock:layoutRect(".composer-dock"),width:document.querySelector(".message-list").clientWidth,margin:getComputedStyle(document.querySelector(".message-list-content")).marginRight,bodyStyle:document.querySelector(".chat-body").getAttribute("style")})');
  assert.ok(summary.dock.left+summary.dock.width<=summary.width-300,`docked summary cannot cover the composer: ${JSON.stringify(summary)}`);
  await run('document.querySelector(".chat-content-frame").style.removeProperty("--work-summary-content-inset");updateChat({draft:"Stable draft"})');
  await until('parseFloat(getComputedStyle(document.querySelector(".message-list-content")).marginRight)<1', 'summary closes'); await pause();
  await run('updateChat({composerAccessory:h("div",{style:{height:30}},"Connection status")});'); await pause();
  assert.ok(Math.abs((await run('layoutRect(".composer-dock .composer-stack")')).top-original.top)<=2,'accessories do not move kept input');
  await run('updateChat({interactionContent:h("div",{className:"interaction-card"},"Please confirm")})'); await pause();
  assert.equal(await run('document.querySelectorAll(".composer-dock.interaction-only").length'),1,'confirmation uses original dock');
  assert.ok(await run('Math.abs(layoutRect(".composer-dock").bottom-document.querySelector(".chat-body").clientHeight)<2'),'confirmation remains at bottom');
  await run('updateChat({interactionContent:null,composerAccessory:undefined})'); await pause();
  assert.ok(Math.abs((await run('layoutRect(".composer-dock .composer-stack")')).top-original.top)<=2,'input returns to kept position after confirmation');
  await run('reply(longReply+"\\n\\nAfter confirmation")'); await pause();
  assert.equal(await checkClearance(),true,'clearance continues after confirmation');
  await run('window.layoutInput=document.querySelector("[data-composer-input]");void 0;');
  await run('reply("# Heading\\n\\nFirst paragraph.\\n\\n"+String.fromCharCode(96).repeat(3)+"js\\n"+Array.from({length:12},(_,i)=>"const value"+i+" = "+i+";").join("\\n")+"\\n"+String.fromCharCode(96).repeat(3)+"\\n\\n| Column | Value |\\n|---|---|\\n| One | Two |\\n\\n"+longReply)'); await pause();
  assert.equal(await run(`(()=>{const d=layoutRect('.composer-dock'),s=document.querySelector('.message-list'),v=s.getBoundingClientRect();return [...s.querySelectorAll('pre code,table')].every(n=>{
    const r=document.createRange();r.selectNodeContents(n);const a=r.getBoundingClientRect(),y=a.top-v.top+s.scrollTop;return y+a.height<=d.top-10||y>=d.bottom+10;});})()`),true,'code and tables move intact around composer');

  await run('saveFlow("bottom","above")'); await pause();
  assert.equal(await run('document.querySelector(".chat-panel").classList.contains("composer-anchored")'),false,'default uses existing dock');
  assert.equal(await run('document.querySelector(".message-list-content").style.paddingTop'),'','default removes custom geometry');
  assert.equal(await run('document.querySelectorAll("[data-composer-clearance]").length'),0,'default removes clearance');
  assert.equal(await run('document.querySelector("[data-composer-input]")===layoutInput'),true,'options do not replace composer');
  await run('startFlow("bottom","below","layout-bottom-below")'); await pause();
  await run('document.querySelector(".send-button").click()'); await until('!!document.querySelector(".message-list")','bottom below first send'); await pause();
  await until('document.querySelector(".composer-dock").getAnimations().every(a=>a.playState!=="running")','bottom arrival motion finishes');
  assert.ok(await run('Math.abs(layoutRect(".composer-dock").bottom-(document.querySelector(".chat-body").clientHeight-20))<2'),'bottom below begins at bottom');
  assert.equal(await run('document.querySelector(".message-list").scrollTop'),0,'bottom below does not auto scroll');
  await run('reply();'); await pause();
  await run('document.querySelector(".message-list").scrollTop=650;updateChat({sending:false,activeTurnId:"",draft:"A follow-up message"})'); await pause();
  await run('document.querySelector(".send-button").click()'); await pause();
  assert.ok(await run('Math.abs(layoutRect(".composer-dock").bottom-(document.querySelector(".chat-body").clientHeight-20))<2'),'follow-up send returns bottom-mode input to bottom');
  assert.equal(await run('chatProps.messages.filter(m=>m.role==="user").length'),2,'follow-up preserves earlier messages');
  await run('document.querySelector(".app").style.zoom="1.25";startFlow("keep","below","layout-scaled")'); await until('!!document.querySelector(".welcome-composer")','scaled welcome'); await pause();
  const scaled = await run('layoutRect(".welcome-composer .composer-stack")');
  await run('document.querySelector(".send-button").click()'); await until('!!document.querySelector(".message-list")','scaled send'); await pause();
  assert.ok(Math.abs((await run('layoutRect(".composer-dock .composer-stack")')).top-scaled.top)<2,'125% keeps coordinate scale');
  await run('document.querySelector(".app").style.zoom="";saveFlow("bottom","below")'); await pause();

  // Use the real editor and save/reopen path, including undo of each option.
  await run('renderView(h(views.ComponentsApp,{language:"zh"}));');
  await until('!!document.querySelector(".components-app")','library');
  await run('[...document.querySelectorAll("button")].find(b=>b.textContent==="编辑布局").click()');
  await until('!!document.querySelector(".welcome-layout-editor")','editor');
  await run('document.querySelector(".composer-layout-settings-button").click()');
  await until('document.querySelector(".composer-layout-dialog")?.open','layout options');
  fs.writeFileSync(path.join(root,'tmp','composer-layout-options.png'),(await window.webContents.capturePage()).toPNG());
  await run('const fields=document.querySelectorAll(".composer-layout-dialog select");fields[0].value="keep";fields[0].dispatchEvent(new Event("change",{bubbles:true}));'); await pause();
  await run('document.querySelectorAll(".composer-layout-dialog select")[1].value="above";document.querySelectorAll(".composer-layout-dialog select")[1].dispatchEvent(new Event("change",{bubbles:true}));'); await pause();
  await run('document.querySelector(".composer-layout-done").click();[...document.querySelectorAll("button")].find(b=>b.textContent==="保存").click()');
  await until('!!document.querySelector(".components-app")','saved');
  assert.deepEqual(await run('views.welcomeComposerFlow(JSON.parse(localStorage.getItem(views.componentStorageKey)))'),{afterSend:'keep',output:'above'});
  await run('updateChat({language:"en",sending:false,messages:[],draft:"Narrow conversation",activeConversationId:"layout-options-reopened"});'); await pause();
  window.setSize(420,620); await pause();
  await run('document.querySelector(".send-button").click();'); await until('!!document.querySelector(".message-list")','narrow send'); await pause();
  assert.ok(await run('(()=>{const r=document.querySelector(".composer-dock").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1;})()'),'narrow composer stays inside viewport');
  await run('renderView(null);localStorage.removeItem(views.componentStorageKey);');
  console.log('Composer layout passed: saved options, real send, above/below clearance, growth, sticky space, single input, scroll restoration, default recovery and narrow view.');
};
