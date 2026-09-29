const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  await window.webContents.insertCSS('.app { width:100%!important; }');
  await run(`
    window.componentNow=new Date(2028,1,29,12,34,56).getTime();
    window.RealDate=Date;
    window.Date=class extends RealDate { constructor(...args){if(args.length)super(...args);else super(componentNow);}static now(){return componentNow;} };
    window.builtinSends=[];window.builtinStops=0;window.builtinPermissions=[];
    function BuiltinFixture(){
      const [draft,setDraft]=React.useState('保留这段草稿'),[sending,setSending]=React.useState(false);
      const [model,setModel]=React.useState('fixture'),[permission,setPermission]=React.useState('task_free');
      window.setBuiltinPermission=setPermission;window.builtinPermission=permission;
      const host={...componentHost,draft,running:sending,selectSuggestion:item=>setDraft(item.text),composer:
        h(views.ComposerReferenceContext.Provider,{value:{sessionId:'builtin-session',browserTabs:[{kind:'browser',tabId:'fixture',url:'https://example.test/',title:'Reference page'}],messages:[]}},
          h(views.Composer,{compact:true,portalCommands:true,language:'zh',draft,onDraftChange:setDraft,sending,cancelEnabled:true,
            selectedModel:model,availableModels:[{id:'fixture',provider:'test',modelName:'Test model',apiProtocol:'openai_responses',enabled:true},{id:'messages',provider:'another',modelName:'Other model',apiProtocol:'anthropic_messages',enabled:true}],
            referencePlanAvailable:false,referencePlanMode:'off',permissionMode:permission,subagentPermissionRouting:'user',reasoningLevelAvailable:true,reasoningLevel:'high',reasoningLevels:['low','medium','high'],contextWindow:{usedTokens:1000,maxTokens:10000},
            skills:[],disabledSkillNames:new Set(),onModelChange:setModel,onReferencePlanModeChange:()=>{},onPermissionModeChange:mode=>{builtinPermissions.push(mode);setPermission(mode);},onSubagentPermissionRoutingChange:()=>{},onReasoningLevelChange:()=>{},onConfigureModels:()=>{},onToggleSkill:()=>{},
            onSend:async text=>{builtinSends.push(text);window.builtinSendPermission=permission;setSending(true);},onCancel:async()=>{builtinStops++;setSending(false);}}))};
      return h(views.HtmlComponentContext.Provider,{value:host},h(views.ComponentsApp,{language:'zh'}));
    }
    renderView(h(BuiltinFixture));
  `);
  await until('document.querySelectorAll("[data-builtin]").length===7','all built-ins appear without import');
  assert.equal(await run('[...document.querySelectorAll("button")].filter(x=>x.textContent==="自定义组件").length'),1,'one custom component entry');
  assert.equal(await run('document.querySelector(".components-empty")'),null);
  assert.equal(await run('document.querySelector(".builtin-digital-time").textContent'),'12:34:56');
  assert.equal(await run('document.querySelector(".builtin-clock-face").getAttribute("aria-label")'),'12:34:56');
  assert.equal(await run('document.querySelector(".builtin-calendar-grid [aria-current=date]").textContent'),'29');
  await run('componentNow+=1000;document.dispatchEvent(new Event("visibilitychange"));void 0');
  await until('document.querySelector(".builtin-digital-time").textContent==="12:34:57"','clock updates');
  await run('document.querySelector("[aria-label=下个月]").click()');
  await until('document.querySelector(".builtin-calendar-heading strong").textContent==="2028年3月"','calendar moves month');
  assert.equal(await run('Array.from(document.querySelectorAll(".builtin-calendar-grid [role=cell]")).filter(x=>x.textContent).length'),31);
  await run('[...document.querySelectorAll(".builtin-calendar button")].find(x=>x.textContent==="今天").click()');
  await until('document.querySelector(".builtin-calendar-grid [aria-current=date]")?.textContent==="29"','calendar returns to leap day');
  await run('[...document.querySelectorAll("button")].find(x=>x.textContent==="编辑布局").click()');
  await until('!!document.querySelector(".welcome-layout-editor")','edit new conversation layout');
  assert.equal(await run('document.querySelectorAll("[data-builtin] button[title=移除组件]").length'),0,'built-ins have no delete action');
  assert.equal(await run('document.querySelectorAll(".welcome-layout-resize").length'),4,'current welcome components can resize');
  await run('[...document.querySelectorAll("button")].find(x=>x.textContent==="取消").click()');
  await pause();
  fs.writeFileSync(path.join(root,'tmp','builtin-components.png'),(await window.webContents.capturePage()).toPNG());
  await run('document.querySelector("[data-builtin=input]").scrollIntoView();window.originalBuiltinInput=document.querySelector("[data-composer-input]");void 0');
  assert.deepEqual(await run('builtinPermissions'),[],'standard presentation preserves the existing permission');
  assert.equal(await run('document.querySelector(".builtin-input .model-select span").textContent'),'Test model','closed standard selector only shows model name');
  const choose = style => run(`[...document.querySelectorAll('.component-input-choices button')].find(x=>x.textContent===${JSON.stringify(style)}).click()`);
  await choose('精简');
  await until('!!document.querySelector(".builtin-input.simple")','simple style applied');
  assert.equal(await run('JSON.parse(localStorage.getItem("cardbush.html_components.v1")).items.find(x=>x.id==="system-input").inputStyle'),'simple','style persisted');
  assert.equal(await run('document.querySelector("[data-composer-input]")===originalBuiltinInput'),true,'style switch keeps the same Composer and input');
  assert.equal(await run('originalBuiltinInput.value'),'保留这段草稿');
  assert.equal(await run('originalBuiltinInput.placeholder'),"let's talk");
  await until('builtinPermission==="all_free"','simple presentation applies full access to conversation state');
  assert.deepEqual(await run('builtinPermissions'),['all_free']);
  await run('document.querySelector(".builtin-input .model-select").click()');
  await until('!!document.querySelector(".model-picker-menu")','simple model menu opens');
  assert.equal(await run('document.querySelectorAll(".model-context-section,.model-reasoning-section,.model-picker-row.secondary,.model-picker-divider").length'),0,'simple menu only has model choices');
  assert.deepEqual(await run('[...document.querySelectorAll(".model-picker-provider")].map(x=>x.textContent)'),['test','another']);
  assert.deepEqual(await run('[...document.querySelectorAll(".model-picker-protocol")].map(x=>x.textContent)'),['Responses','Messages']);
  await run('document.querySelectorAll(".model-picker-row")[1].click()');
  await until('!document.querySelector(".model-picker-menu") && document.querySelector(".builtin-input .model-select span").textContent==="Other model"','model switch updates simple selector and closes menu');
  assert.deepEqual(await run('builtinPermissions'),['all_free'],'model changes do not reapply permissions');
  await run('setBuiltinPermission("task_free");void 0');
  await pause();
  assert.equal(await run('builtinPermission'),'task_free','later explicit permission changes are preserved');
  const layout = await run(`(()=>{const bounds=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}};
    return {input:bounds('[data-composer-input]'),add:bounds('.builtin-input .composer-tools > :first-child'),model:bounds('.builtin-input .model-select'),send:bounds('.builtin-input .send-button'),surface:bounds('.builtin-input .composer-surface')};})()`);
  assert.ok(layout.add.x < layout.input.x && layout.input.x+layout.input.w <= layout.model.x+1 && layout.model.x+layout.model.w <= layout.send.x+1,'single row: add, input, model, send');
  assert.ok(layout.surface.h<80,'simple composer has capsule height');
  await pause();
  fs.writeFileSync(path.join(root,'tmp','builtin-input-simple.png'),(await window.webContents.capturePage()).toPNG());
  await choose('标准');
  await until('!!document.querySelector(".builtin-input.standard")','standard style restored');
  assert.notEqual(await run('originalBuiltinInput.placeholder'),"let's talk");
  assert.equal(await run('document.querySelector(".builtin-input .model-select span").textContent'),'Other model');
  await run('document.querySelector(".builtin-input .model-select").click()');
  await until('!!document.querySelector(".model-reasoning-section")','standard reasoning controls retained');
  assert.equal(await run('document.querySelectorAll(".model-context-section,.model-picker-row.secondary").length'),2,'standard meter and settings retained');
  await run('document.querySelector(".builtin-input .model-select").click()');
  await choose('精简');
  await until('builtinPermission==="all_free"','entering simple reapplies its default');
  assert.equal(await run('originalBuiltinInput.value'),'保留这段草稿');
  const type = text => run(`(()=>{const input=document.querySelector('[data-composer-input]');input.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.setSelectionRange(input.value.length,input.value.length);input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  for (const command of ['/', '@', '$']) {
    await type(command); await until('!!document.querySelector(".composer-command-list")',command+' works in simple composer');
    await pause(30);
    assert.equal(await run(`(()=>{const row=document.querySelector('.composer-command-row,.composer-command-empty'),r=row.getBoundingClientRect();return !!document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('.composer-command-list');})()`),true,command+' command list is visible and clickable beyond the card');
  }
  await type('组件发起的消息');
  await run('originalBuiltinInput.dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",isComposing:true,bubbles:true,cancelable:true}));void 0');
  assert.deepEqual(await run('builtinSends'),[],'IME does not submit');
  await run('document.querySelector(".builtin-input .send-button").click()');
  await until('builtinSends.length===1 && !!document.querySelector(".builtin-input .send-button .lucide-square")','send uses original Composer path and switches to stop');
  assert.deepEqual(await run('builtinSends'),['组件发起的消息']);
  assert.equal(await run('builtinSendPermission'),'all_free','send receives actual full-access state');
  assert.deepEqual(await run('builtinPermissions'),['all_free','all_free'],'typing and sending do not reset permission');
  await run('document.querySelector(".builtin-input .send-button").click()');
  await until('builtinStops===1','stop callback');
  await run(`(()=>{const state=JSON.parse(localStorage.getItem('cardbush.html_components.v1'));views.saveComponents({...state,items:state.items.map(item=>item.id==='system-input'?{...item,width:3}:item)},state.revision);})()`);
  await pause();
  assert.equal(await run(`(()=>{const input=document.querySelector('.builtin-input'),surface=input.querySelector('.composer-surface');return input.scrollWidth<=input.clientWidth+1&&surface.scrollWidth<=surface.clientWidth+1&&surface.querySelector('[data-composer-input]').getBoundingClientRect().width>20;})()`),true,'simple input remains usable at minimum component width');
  const originalSize=window.getSize();window.setSize(540,780);await pause();
  assert.equal(await run('document.querySelector(".components-app").scrollWidth<=document.querySelector(".components-app").clientWidth+1'),true,'narrow window has no horizontal canvas overflow');
  window.setSize(...originalSize);
  await run('renderView(null);window.Date=RealDate;void 0');
  console.log('Built-in components passed: default gallery, protected definitions, live clocks, leap-day calendar, editable sizes, one custom entry, persistent two-style Composer, same input/draft, commands, IME, send and stop.');
};
