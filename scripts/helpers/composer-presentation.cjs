const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  await window.webContents.insertCSS('.app { width:100%!important; }');
  await window.webContents.insertCSS(fs.readFileSync(path.join(root,'src/features/inspector/inspectorWorkspace.css'),'utf8'));
  await run(`
    window.presentationPermissions=[];window.presentationSends=[];
    window.saveInputStyle=(catalog,placement)=>{
      const previous=JSON.parse(localStorage.getItem(views.componentStorageKey))||views.defaultComponents;
      views.saveComponents({...previous,items:previous.items.map(item=>item.id==='system-input'?{...item,inputStyle:catalog}:item),
        welcomeLayout:placement?{items:[{componentId:'system-input',x:10,y:200,width:80,height:120,inputStyle:placement}]}:undefined},previous.revision);
    };
    saveInputStyle('simple');
    updateChat({loading:false,historyLoading:false,language:'zh',activeConversationId:'presentation',welcomeEnabled:true,
      messages:[],draft:'第一条消息',sending:false,activeTurnId:'',permissionMode:'task_free',
      availableModels:[{id:'fixture',modelName:'Test model',provider:'fixture',apiProtocol:'openai_responses',enabled:true}],
      onDraftChange:draft=>updateChat({draft}),onPermissionModeChange:permissionMode=>{presentationPermissions.push(permissionMode);updateChat({permissionMode});},
      onSend:async text=>{presentationSends.push(text);updateChat({draft:'',sending:true,activeTurnId:'presentation-turn',messages:[{id:'presentation-user',role:'user',content:text,turnId:'presentation-turn'}]});},
      onCancel:async()=>updateChat({sending:false,activeTurnId:''})});
  `);
  await until('!!document.querySelector(".welcome-composer .composer-stack.simple")','welcome uses saved simple style');
  await until('chatProps.permissionMode==="all_free"','new simple conversation sets its default permission');
  const checkSimpleWelcome = async () => {
    assert.equal(await run('getComputedStyle(document.querySelector(".welcome-input-stack.simple")).boxShadow'),'none','simple welcome has no painted outer card');
    assert.equal(await run('getComputedStyle(document.querySelector(".welcome-input-stack.simple")).backgroundColor'),'rgba(0, 0, 0, 0)','simple layout spacing is transparent');
    assert.equal(await run('getComputedStyle(document.querySelector(".composer-surface")).borderRadius'),'30px','only the input capsule keeps its rounded surface');
  };
  await run('updateChat({draft:""})'); await until('document.querySelector("[data-composer-input]").value===""','empty welcome draft');
  await checkSimpleWelcome();
  await run('document.querySelector(".app").classList.replace("theme-dark","theme-light");saveInputStyle("simple","simple");');
  await until('!!document.querySelector(".custom-layout .welcome-input-stack.simple")','custom simple welcome layout');
  await checkSimpleWelcome(); await pause();
  fs.writeFileSync(path.join(root,'tmp','welcome-input-simple-light.png'),(await window.webContents.capturePage()).toPNG());
  await run('updateChat({draft:"第一条消息"});document.querySelector(".app").classList.replace("theme-light","theme-dark");');
  await checkSimpleWelcome();
  // A later explicit permission choice must survive the first-message remount.
  await run('updateChat({permissionMode:"task_free"});document.querySelector(".send-button").click()');
  await until('!document.querySelector(".welcome-composer") && !!document.querySelector(".composer-dock .composer-stack.simple")','sending preserves simple style in actual ChatPanel');
  await until('!!document.querySelector(".send-button .lucide-square")','running turn exposes stop');
  assert.deepEqual(await run('presentationSends'),['第一条消息']);
  assert.equal(await run('document.querySelector("[data-composer-input]").placeholder'),"let's talk");
  assert.equal(await run('getComputedStyle(document.querySelector(".composer-surface")).display'),'grid');
  assert.ok(await run('document.querySelector(".composer-surface").getBoundingClientRect().height<85'),'continuing composer retains capsule height');
  assert.equal(await run('chatProps.permissionMode'),'task_free','conversation transition preserves explicit permission');
  await run('document.querySelector(".model-select").click()');
  await until('!!document.querySelector(".model-picker-menu")','model menu opens');
  assert.equal(await run('document.querySelectorAll(".model-context-section,.model-reasoning-section,.model-picker-row.secondary").length'),0,'continuing simple menu only shows models');
  await run('document.querySelector(".model-select").click();document.querySelector(".send-button").click()');
  await until('!chatProps.sending','stop works after transition');
  await run('updateChat({draft:"保留后续草稿"});window.continuingInput=document.querySelector("[data-composer-input]");saveInputStyle("simple","standard");');
  await until('!document.querySelector(".composer-stack.simple")','saved layout can override catalog with standard');
  assert.equal(await run('document.querySelector("[data-composer-input]")===continuingInput'),true,'style updates keep the input mounted');
  assert.equal(await run('continuingInput.value'),'保留后续草稿');
  await run('document.querySelector(".model-select").click()');await until('!!document.querySelector(".model-context-section")','standard menu restores context controls');
  await run('document.querySelector(".model-select").click();saveInputStyle("standard","simple");');
  await until('!!document.querySelector(".composer-stack.simple")','layout simple override applies to existing conversation');
  assert.deepEqual(await run('presentationPermissions'),['all_free'],'presentation updates never escalate existing session permission');
  await run('renderView(null)');await until('!document.querySelector(".chat-panel")','unmounted');
  await run('updateChat({activeConversationId:"reopened"})');
  await until('!!document.querySelector(".composer-dock .composer-stack.simple")','reopened conversations use saved style');
  await run('updateChat({embedded:true,welcomeEnabled:false})');
  await until('!!document.querySelector(".composer-dock .composer-stack.simple")','embedded conversations use shared style');
  window.setSize(420,820);await pause();
  assert.ok(await run('(()=>{const s=document.querySelector(".composer-surface"),t=s.querySelector("[data-composer-input]"),r=s.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&s.scrollWidth<=s.clientWidth+1&&t.getBoundingClientRect().width>20})()'),'simple conversation composer fits a narrow panel');
  fs.writeFileSync(path.join(root,'tmp','conversation-input-simple.png'),(await window.webContents.capturePage()).toPNG());
  await run(`window.presentationTarget=document.createElement('div');presentationTarget.className='inspector-quick-input';document.body.append(presentationTarget);
    renderView(h(views.ComposerPortalContext.Provider,{value:presentationTarget},h(views.ChatPanel,chatProps)));`);
  await until('!!document.querySelector(".inspector-quick-input .composer-stack.input-only")','cover quick input remains available');
  assert.equal(await run('document.querySelectorAll(".composer-stack.simple").length'),0,'input-only capsule retains its own minimal layout');
  await run('renderView(null);presentationTarget.remove();localStorage.removeItem(views.componentStorageKey);');
  console.log('Composer presentation passed: real welcome/send/stop transition, saved layout precedence, menu parity, drafts, explicit permissions, reopen, embedded/narrow and cover input.');
};
