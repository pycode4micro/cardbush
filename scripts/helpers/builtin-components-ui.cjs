const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  await window.webContents.insertCSS('.app { width:100%!important; }');
  await run(`
    window.componentNow=new Date(2028,1,29,12,34,56).getTime();
    window.RealDate=Date;
    window.Date=class extends RealDate { constructor(...args){if(args.length)super(...args);else super(componentNow);}static now(){return componentNow;} };
    window.builtinSends=[];window.builtinStops=0;window.builtinPermissions=[];window.builtinSelections=[];window.previewHistoryReads=0;
    window.previewTestHost={id:'builtin-session',plugins:[],pluginCommands:[],uploadFiles:async()=>[],openFile:()=>{},toolDetails:async()=>[],
      welcomeHistory:async()=>{previewHistoryReads++;return [];}};
    function BuiltinFixture({live=false}){
      const [draft,setDraft]=React.useState('保留这段草稿'),[sending,setSending]=React.useState(true);
      const [model,setModel]=React.useState('fixture'),[permission,setPermission]=React.useState('task_free');
      window.builtinState={draft,sending,model,permission};window.setBuiltinSending=setSending;window.setBuiltinDraft=setDraft;
      const host={...componentHost,draft,running:sending,notice:'真实会话通知',selectSuggestion:item=>{builtinSelections.push(item);setDraft(item.text);},composer:
        h(views.ComposerReferenceContext.Provider,{value:{sessionId:'builtin-session',browserTabs:[{kind:'browser',tabId:'fixture',url:'https://example.test/',title:'Reference page'}],messages:[]}},
          h(views.Composer,{compact:true,portalCommands:true,language:'zh',draft,onDraftChange:setDraft,sending,cancelEnabled:true,
            selectedModel:model,availableModels:[{id:'fixture',provider:'test',modelName:'Test model',apiProtocol:'openai_responses',enabled:true},{id:'messages',provider:'another',modelName:'Other model',apiProtocol:'anthropic_messages',enabled:true}],
            referencePlanAvailable:false,referencePlanMode:'off',permissionMode:permission,subagentPermissionRouting:'user',reasoningLevelAvailable:true,reasoningLevel:'high',reasoningLevels:['low','medium','high'],contextWindow:{usedTokens:1000,maxTokens:10000},
            skills:[],disabledSkillNames:new Set(),onModelChange:setModel,onReferencePlanModeChange:()=>{},onPermissionModeChange:mode=>{builtinPermissions.push(mode);setPermission(mode);},onSubagentPermissionRoutingChange:()=>{},onReasoningLevelChange:()=>{},onConfigureModels:()=>{},onToggleSkill:()=>{},
            onSend:async text=>{builtinSends.push(text);setSending(true);},onCancel:async()=>{builtinStops++;setSending(false);}}))};
      return h(views.ConversationHostContext.Provider,{value:previewTestHost},h(views.HtmlComponentContext.Provider,{value:host},
        live?h(views.BuiltinComponentSurface,{language:'zh',component:JSON.parse(localStorage.getItem('cardbush.html_components.v1')).items.find(x=>x.id==='system-input')})
          :h(views.ComponentsApp,{language:'zh'})));
    }
    window.showBuiltinFixture=live=>renderView(h(BuiltinFixture,{live}));
    showBuiltinFixture(false);
  `);
  await until('document.querySelectorAll("[data-builtin]").length===7','all built-ins appear without import');
  assert.equal(await run('[...document.querySelectorAll("button")].filter(x=>x.textContent==="自定义组件").length'),1);
  assert.equal(await run('document.querySelector(".builtin-digital-time").textContent'),'12:34:56');
  assert.equal(await run('document.querySelector(".builtin-clock-face").getAttribute("aria-label")'),'12:34:56');
  assert.equal(await run('document.querySelector(".builtin-calendar-grid [aria-current=date]").textContent'),'29');
  await run('componentNow+=1000;document.dispatchEvent(new Event("visibilitychange"));void 0');
  await until('document.querySelector(".builtin-digital-time").textContent==="12:34:57"','clock preview updates');
  assert.equal(await run('[...document.querySelectorAll(".html-component-content")].every(x=>x.inert)'),true);
  assert.equal(await run('document.querySelector("[data-composer-input]").value'),'');
  assert.equal(await run('document.querySelector("[data-composer-input]").readOnly'),true);
  assert.equal(await run('document.querySelector(".builtin-input .lucide-square")'),null,'running conversation does not expose a stop action in preview');
  assert.equal(await run('document.querySelector(".builtin-input-notice")'),null,'live notice is not mounted');
  assert.equal(await run('document.querySelector(".builtin-input .model-select").textContent.includes("Test model")'),false);
  assert.equal(await run('previewHistoryReads'),0,'preview does not fetch real conversation suggestions');
  assert.equal(await run('[...document.querySelectorAll(".welcome-suggestion")].every(x=>x.disabled)'),true);

  const click = async selector => {
    const point = await run(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});element.scrollIntoView({block:'center'});const r=element.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    window.webContents.sendInputEvent({type:'mouseMove',...point});
    window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
    window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
    await pause(50);
  };
  for (const selector of ['.welcome-suggestion','.builtin-input .model-select','.builtin-input .send-button','[data-composer-input]']) await click(selector);
  window.webContents.sendInputEvent({type:'keyDown',keyCode:'Return'});
  await pause();
  assert.equal(await run('document.activeElement.matches("[data-composer-input]")'),false,'preview cannot take editing focus');
  assert.equal(await run('document.querySelector(".model-picker-menu")'),null,'real pointer cannot open preview controls');
  assert.deepEqual(await run('({sends:builtinSends,stops:builtinStops,selections:builtinSelections,permissions:builtinPermissions})'),{sends:[],stops:0,selections:[],permissions:[]});
  assert.deepEqual(await run('builtinState'),{draft:'保留这段草稿',sending:true,model:'fixture',permission:'task_free'});

  await run('window.originalBuiltinInput=document.querySelector("[data-composer-input]");void 0');
  const choose = style => run(`[...document.querySelectorAll('.component-input-choices button')].find(x=>x.textContent===${JSON.stringify(style)}).click()`);
  await choose('精简');
  await until('!!document.querySelector(".builtin-input.simple")','simple style applied');
  assert.equal(await run('JSON.parse(localStorage.getItem("cardbush.html_components.v1")).items.find(x=>x.id==="system-input").inputStyle'),'simple');
  assert.equal(await run('document.querySelector("[data-composer-input]")===originalBuiltinInput'),true,'style switch retains preview input DOM');
  assert.equal(await run('originalBuiltinInput.placeholder'),"let's talk");
  assert.deepEqual(await run('builtinPermissions'),[],'style preview cannot change real permissions');
  const layout = await run(`(()=>{const bounds=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,w:r.width,h:r.height}};
    return {input:bounds('[data-composer-input]'),add:bounds('.builtin-input .composer-tools > :first-child'),model:bounds('.builtin-input .model-select'),send:bounds('.builtin-input .send-button'),surface:bounds('.builtin-input .composer-surface')};})()`);
  assert.ok(layout.add.x<layout.input.x && layout.input.x+layout.input.w<=layout.model.x+1 && layout.model.x+layout.model.w<=layout.send.x+1,'simple preview keeps single-row layout');
  assert.ok(layout.surface.h<80,'simple preview has capsule height');
  fs.writeFileSync(path.join(root,'tmp','builtin-input-simple.png'),(await window.webContents.capturePage()).toPNG());
  await run(`(()=>{const state=JSON.parse(localStorage.getItem('cardbush.html_components.v1'));views.saveComponents({...state,items:state.items.map(item=>item.id==='system-input'?{...item,width:3}:item)},state.revision);})()`);
  await pause();
  assert.equal(await run(`(()=>{const input=document.querySelector('.builtin-input'),surface=input.querySelector('.composer-surface');return input.scrollWidth<=input.clientWidth+1&&surface.scrollWidth<=surface.clientWidth+1&&surface.querySelector('[data-composer-input]').getBoundingClientRect().width>20;})()`),true,'simple preview fits minimum component width');
  const originalSize=window.getSize();window.setSize(540,780);await pause();
  assert.equal(await run('document.querySelector(".components-app").scrollWidth<=document.querySelector(".components-app").clientWidth+1'),true,'narrow gallery has no horizontal overflow');
  window.setSize(...originalSize);
  await choose('标准');
  await run('[...document.querySelectorAll("button")].find(x=>x.textContent==="编辑布局").click()');
  await until('!!document.querySelector(".welcome-layout-editor")','layout editing remains available');
  assert.equal(await run('document.querySelector("[data-composer-input]").value'),'');
  assert.equal(await run('document.querySelector("[data-composer-input]").readOnly'),true);
  assert.equal(await run('document.querySelector(".builtin-input .lucide-square")'),null);
  assert.equal(await run('document.querySelectorAll(".welcome-layout-resize").length'),4);
  await run('[...document.querySelectorAll("button")].find(x=>x.textContent==="取消").click()');
  await until('!!document.querySelector(".components-app")','cancel returns to gallery');
  assert.deepEqual(await run('builtinState'),{draft:'保留这段草稿',sending:true,model:'fixture',permission:'task_free'});
  assert.equal(await run('previewHistoryReads'),0,'editor and gallery remain disconnected from history');
  fs.writeFileSync(path.join(root,'tmp','builtin-components.png'),(await window.webContents.capturePage()).toPNG());

  // Leaving preview must retain the real composer and all its existing actions.
  await run('setBuiltinSending(false);showBuiltinFixture(true);void 0');
  await until('document.querySelector("[data-composer-input]")?.value==="保留这段草稿"','live composer restores original draft');
  assert.equal(await run('document.querySelector("[data-composer-input]").readOnly'),false);
  assert.equal(await run('document.querySelector(".builtin-input .model-select span").textContent'),'Test model');
  await run('document.querySelector(".builtin-input .model-select").click()');
  await until('!!document.querySelector(".model-reasoning-section")','live model controls still open');
  await run('document.querySelectorAll(".model-picker-row")[1].click()');
  await until('builtinState.model==="messages"','live model selection still works');
  await run('document.querySelector(".builtin-input .send-button").click()');
  await until('builtinSends.length===1 && !!document.querySelector(".builtin-input .send-button .lucide-square")','live send and running status work');
  assert.deepEqual(await run('builtinSends'),['保留这段草稿']);
  await run('document.querySelector(".builtin-input .send-button").click()');
  await until('builtinStops===1','live stop still works');
  await run('renderView(null);window.Date=RealDate;void 0');
  console.log('Built-in components passed: isolated draft, running state, settings, suggestions and pointer actions; persistent style/layout editing; responsive preview; live composer send/stop retained.');
};
