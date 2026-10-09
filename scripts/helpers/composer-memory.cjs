const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  await window.webContents.insertCSS('.app { width:100%!important; }');
  await run(`
    renderView(null); localStorage.removeItem(views.individuationStorageKey);
    window.memorySends=[];
    window.memoryCalls=[];
    window.memoryStats={estimatedTokens:1200,eventTokens:800,habitTokens:400,records:8,habits:2,predictions:2,notes:4,hits:3,misses:1,running:false,lastSummaryAt:null,lastError:null};
    window.memoryCall=async(input,connection)=>{memoryCalls.push({input,connection});if(input.action==='summarize'){
      if(window.failMemorySummary)throw Error('fixture model unavailable');
      if(window.holdMemorySummary)return new Promise(resolve=>window.finishMemorySummary=resolve);
      return {...memoryStats,estimatedTokens:300,eventTokens:100,habitTokens:200,notes:0,lastSummaryAt:Date.now()};}return memoryStats;};
    window.memoryRows=[{id:'habit_fixture',kind:'habit',text:'查看股市走势时默认关注 A 股。',revision:1,state:'active',origin:'agent',applies_when:'股市分析',
      created_at:Date.now()-86400000,age_days:1,expires_at:null,last_confirmed_at:null,last_rejected_at:null,source:{session_id:'fixture-session',turn_id:'first'},source_ids:[],replaced_by:[],content_cleared:false,truncated:false,hits:0,misses:0}];
    window.memoryHistory=[];window.memoryManagementCalls=[];window.memoryListCalls=0;
    window.memoryApi={
      list:async(settings,connection,cursor,inactive)=>{memoryListCalls++;return {records:memoryRows.filter(row=>(row.kind==='habit'?settings.habits:settings.predictions)&&(inactive||row.state==='active')),next_cursor:null};},
      history:async()=>({changes:memoryHistory,next_cursor:null}),
      change:async(settings,connection,input)=>{
        memoryManagementCalls.push({connection,input});const row=memoryRows.find(row=>row.id===input.id),before=structuredClone(row);
        if(input.revision!==row.revision)return {status:'conflict'};
        row.revision++;
        if(input.action==='confirm'){row.origin='user';row.last_confirmed_at=Date.now();}
        else if(input.action==='retract')row.state='retracted';
        else if(input.action==='supersede'){
          row.state='superseded';const next={...structuredClone(row),...input.replacement,id:'habit_corrected',revision:1,state:'active',origin:'user',applies_when:input.replacement.applies_when||''};
          memoryRows.push(next);row.replaced_by=[next.id];
        }
        const id='change-'+memoryHistory.length;memoryHistory.unshift({id,created_at:Date.now(),actor:'user',reason:input.reason,before:[before],after:[structuredClone(row)],undo_of:null,can_undo:true});
        return {status:'ok',change_id:id};
      },
      undo:async(settings,connection,id)=>{const change=memoryHistory.find(row=>row.id===id);memoryRows=change.before.map(row=>({...row,revision:row.revision+2}));change.can_undo=false;return {status:'ok'};},
      purge:async()=>{memoryHistory=[];return memoryStats;},
    };
    Object.assign(chatProps,{loading:false,historyLoading:false,language:'zh',welcomeEnabled:false,
      draft:'保留我的草稿',referencePlanAvailable:true,onSend:async text=>memorySends.push(text)});
    window.memoryInstructions={read:async()=>({path:'fixture',content:'',revision:'fixture'}),save:async()=>({path:'fixture',content:'',revision:'fixture'})};
    window.MemoryPreferences=()=>{
      const [settings,update]=views.useAppSettings(); window.memorySettings=settings;
      const onSettingsChange=updater=>update(current=>{const next=views.normalizeAppSettings(updater(current));views.persistAppSettings(next);return next;});
      window.updateMemorySettings=onSettingsChange;
      return h(views.SettingsSummaryPanel,{language:chatProps.language,settings,onSettingsChange,
        modelId:'fixture-model',call:memoryCall,memoryApi,connections:[{id:'remote-memory',name:'Test Agent'}]});
    };
    window.renderMemoryFixture=()=>renderView(h('div',{style:{display:'grid',gridTemplateColumns:'1fr 1fr',height:'100%'}},
      h(views.ChatPanel,chatProps),h('div',{className:'memory-settings',style:{overflow:'auto'}},h(MemoryPreferences))));
    window.memoryButton=()=>document.querySelector('.composer-add-action[aria-label="'+(chatProps.language==='zh'?'个性化记忆':'Personalization memory')+'"]');
    window.habitInput=()=>[...document.querySelectorAll('.memory-settings .settings-switch')].find(row=>row.textContent.includes(chatProps.language==='zh'?'记住并参考用户习惯':'Remember and use habits')).querySelector('input');
    window.predictionInput=()=>[...document.querySelectorAll('.memory-settings .settings-switch')].find(row=>row.textContent.includes(chatProps.language==='zh'?'预测下一步行为':'Predict next actions')).querySelector('input');
    renderMemoryFixture();
  `);
  await until('!!document.querySelector(".tool-chip[title=添加]") && !!habitInput()', 'composer and real settings mounted');
  await run('document.querySelector(".tool-chip[title=添加]").click()');
  await until('!!memoryButton()', 'memory shortcut in Add menu');
  assert.equal(await run('memoryButton().getAttribute("aria-checked")'), 'false', 'default stays off');
  await run('memoryButton().click()');
  await until('habitInput().checked && memoryButton().getAttribute("aria-checked")==="true"', 'shortcut synchronizes settings');
  assert.deepEqual(await run('views.readIndividuation()'), { habits: true, predictions: false, eventTokenThreshold:10000, habitTokenThreshold:10000, recallMode:'context' }, 'next-turn metadata reads the persisted flags');
  assert.equal(await run('document.querySelector("[data-composer-input]").value'), '保留我的草稿');
  assert.deepEqual(await run('memorySends'), [], 'memory change does not send the draft');
  await run('predictionInput().click();habitInput().click()');
  await until('memoryButton().getAttribute("aria-checked")==="false" && predictionInput().checked', 'settings synchronize shortcut without coupling prediction');
  // Keyboard activation uses the native button while leaving the menu open.
  await run('memoryButton().focus()');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
  await until('memoryButton().getAttribute("aria-checked")==="true"', 'keyboard activation');
  assert.deepEqual(await run('views.readIndividuation()'), { habits: true, predictions: true, eventTokenThreshold:10000, habitTokenThreshold:10000, recallMode:'context' }, 'shortcut preserves independently enabled prediction');
  await run(`views.saveIndividuation({habits:false,predictions:true});updateMemorySettings(current=>({...current,thinking:{visible:true}}));`);
  await until('memorySettings.thinking.visible && !habitInput().checked', 'unrelated save uses latest preferences');
  assert.deepEqual(await run('views.readIndividuation()'), { habits: false, predictions: true, eventTokenThreshold:10000, habitTokenThreshold:10000, recallMode:'context' }, 'immediate settings save cannot restore stale memory');
  await run(`localStorage.setItem(views.individuationStorageKey,JSON.stringify({habits:true,predictions:false}));
    window.dispatchEvent(Object.assign(new Event('storage'),{key:views.individuationStorageKey,storageArea:localStorage}));`);
  await until('habitInput().checked && !predictionInput().checked && memoryButton().getAttribute("aria-checked")==="true"', 'other-window storage updates both surfaces');
  await run('chatProps.language="en";renderMemoryFixture()');
  await until('memoryButton()?.textContent.includes("Remember and use habits")', 'English label and explanation');
  await run('document.querySelector(".tool-chip[title=Add]").click();document.querySelector(".tool-chip[title=Add]").click()');
  await until('memoryButton()?.getAttribute("aria-checked")==="true"', 'reopened menu keeps saved state');
  await run(`renderView(null);const components=JSON.parse(localStorage.getItem(views.componentStorageKey)||'null')||views.defaultComponents;views.saveComponents({...components,items:components.items.map(item=>item.id==='system-input'?{...item,inputStyle:'simple'}:item)},components.revision);
    chatProps.embedded=true;renderView(h(views.ChatPanel,chatProps));`);
  await until('!!document.querySelector(".composer-stack.simple .tool-chip[title=Add]")', 'embedded simple composer');
  window.setSize(420,360); await pause();
  await run('document.querySelector(".app").classList.replace("theme-dark","theme-light");document.querySelector(".tool-chip[title=Add]").click()');
  await until('!!memoryButton()', 'shortcut on narrow simple composer');
  await run('memoryButton().scrollIntoView({block:"nearest"})'); await pause();
  assert.ok(await run('(()=>{const menu=document.querySelector(".composer-add-menu").getBoundingClientRect(),button=memoryButton().getBoundingClientRect();return button.top>=menu.top-1&&button.bottom<=menu.bottom+1&&button.left>=0&&button.right<=innerWidth})()'), 'scrolling keeps the shortcut reachable in a short window');
  fs.writeFileSync(path.join(root,'tmp','composer-memory-shortcut.png'),(await window.webContents.capturePage()).toPNG());
  await run('memoryButton().click()');
  await until('memoryButton().getAttribute("aria-checked")==="false"', 'simple composer can disable memory');
  assert.deepEqual(await run('views.readIndividuation()'), { habits: false, predictions: false, eventTokenThreshold:10000, habitTokenThreshold:10000, recallMode:'context' });
  window.setSize(820,780);await pause();
  await run(`views.saveIndividuation({habits:true,predictions:true});renderView(h('div',{className:'memory-settings',style:{height:'100%',overflow:'auto',padding:24}},h(MemoryPreferences)));void 0;`);
  await until('!!document.querySelector(".summary-memory-status strong")','independent summary settings');
  await run('document.querySelector(".summary-threshold input").focus();document.querySelector(".summary-threshold input").select()');
  await window.webContents.insertText('999');await pause();await run('document.querySelector(".summary-threshold input").blur()');
  // Hidden windows do not always emit focusout when HTMLElement.blur() is called.
  await run('document.querySelector(".summary-threshold input").dispatchEvent(new FocusEvent("focusout",{bubbles:true}))');
  await until('document.querySelector(".summary-settings [role=alert]")?.textContent.includes("1,000")','invalid threshold rejected');
  assert.equal(await run('views.readIndividuation().eventTokenThreshold'),10000);
  await run('document.querySelector(".summary-threshold input").focus();document.querySelector(".summary-threshold input").select()');
  await window.webContents.insertText('12345');await pause();await run('document.querySelector(".summary-threshold input").blur()');
  await run('document.querySelector(".summary-threshold input").dispatchEvent(new FocusEvent("focusout",{bubbles:true}))');
  await until('views.readIndividuation().eventTokenThreshold===12345','custom threshold persisted');
  await run('document.querySelectorAll(".summary-threshold input")[1].focus();document.querySelectorAll(".summary-threshold input")[1].select()');
  await window.webContents.insertText('23456');await pause();
  await run('document.querySelectorAll(".summary-threshold input")[1].dispatchEvent(new FocusEvent("focusout",{bubbles:true}))');
  await until('views.readIndividuation().habitTokenThreshold===23456','independent habit threshold persisted');
  assert.equal(await run('views.readIndividuation().eventTokenThreshold'),12345);
  assert.deepEqual(await run('[...document.querySelectorAll(".summary-memory-status progress")].map(p=>p.max)'),[12345,23456]);
  await run('window.listCallsBeforeSummary=memoryListCalls;document.querySelector(".summary-memory-actions .primary-button").click()');
  await until('document.querySelector(".summary-memory-status strong")?.textContent.startsWith("300")','manual summary result replaces status');
  await until('memoryListCalls>listCallsBeforeSummary','manual summary refreshes memory records');
  assert.deepEqual(await run('memoryCalls.find(c=>c.input.action==="summarize").input'),{action:'summarize',modelId:'fixture-model',settings:{habits:true,predictions:true,eventTokenThreshold:12345,habitTokenThreshold:23456,recallMode:'context'}});
  await run('window.failMemorySummary=true;document.querySelector(".summary-memory-actions .primary-button").click()');
  await until('document.querySelector(".summary-settings [role=alert]")?.textContent.includes("did not fully complete")','failure is visible and retry remains available');
  assert.equal(await run('document.querySelector(".summary-memory-actions .primary-button").disabled'),false);
  await run(`window.failMemorySummary=false;document.querySelector('.summary-memory-actions .secondary-button').click();
    window.memoryAction=(label,scope=document)=>[...scope.querySelectorAll('button')].find(button=>button.textContent.trim()===label);void 0;`);
  await until('!!document.querySelector("[data-memory-id=habit_fixture]") && !document.querySelector("[data-memory-id=habit_fixture] button").disabled','records loaded with provenance');
  await require('./summary-memory-stability.cjs')({run,until,pause});
  await run(`document.querySelector('[role=combobox][aria-label="Memory recall mode"]').click()`);
  await run(`document.querySelector('[role=option][value=hint]').click()`);
  await until('views.readIndividuation().recallMode==="hint"','counts-only recall setting persists');
  await run(`memoryAction('Confirm and pin',document.querySelector('[data-memory-id=habit_fixture]')).click()`);
  await until('document.querySelector("[data-memory-id=habit_fixture]")?.textContent.includes("User pinned")','pin is visible');
  assert.equal(await run('memoryManagementCalls.at(-1).input.action'),'confirm');
  await run(`memoryAction('Retract',document.querySelector('[data-memory-id=habit_fixture]')).click()`);
  await until('!document.querySelector("[data-memory-id=habit_fixture]")','retracted record leaves active list');
  await run(`memoryAction('History',document.querySelector('.memory-record-toolbar')).click()`);
  await until('document.querySelectorAll(".memory-change").length===2','both changes are visible in history');
  await run(`document.querySelector('.memory-change summary').click();memoryAction('Undo this change',document.querySelector('.memory-change')).click()`);
  await until('document.querySelector(".memory-change button")?.disabled===true','undo receipt refreshes history');
  await run(`memoryAction('Records',document.querySelector('.memory-record-toolbar')).click()`);
  await until('!!document.querySelector("[data-memory-id=habit_fixture]")','undo restores active record');
  await run(`memoryAction('Correct',document.querySelector('[data-memory-id=habit_fixture]')).click()`);
  await until('!!document.querySelector(".memory-record-editor textarea")','correction editor opens');
  await run(`document.querySelector('.memory-record-editor textarea').focus();document.querySelector('.memory-record-editor textarea').select()`);
  await window.webContents.insertText('只在用户明确要求时提供 XLSX。');
  await run(`document.querySelector('.memory-record-editor').requestSubmit()`);
  await until('!!document.querySelector("[data-memory-id=habit_corrected]") && !document.querySelector(".memory-record-editor")','correction saves a replacement');
  assert.equal(await run('memoryManagementCalls.at(-1).input.replacement.applies_when'),'股市分析');
  assert.equal(await run('memoryManagementCalls.at(-1).input.revision'),4,'the loaded current revision is sent');
  await run(`document.querySelector('.memory-record-toolbar input[type=checkbox]').click()`);
  await until('document.querySelectorAll("article.memory-record").length===2','inactive original remains inspectable');
  await run(`document.querySelector('[data-memory-id=habit_fixture]').scrollIntoView({block:'start'})`);await pause();
  fs.writeFileSync(path.join(root,'tmp','summary-memory-settings.png'),(await window.webContents.capturePage()).toPNG());
  window.setSize(420,680);await pause();
  assert.ok(await run('document.querySelector(".summary-settings").getBoundingClientRect().right<=innerWidth'),'summary controls fit narrow window');
  assert.ok(await run('[...document.querySelectorAll(".memory-record")].every(row=>row.getBoundingClientRect().right<=innerWidth && row.scrollWidth<=row.clientWidth+1)'),'record IDs and source metadata wrap without horizontal overflow');
  await run(`chatProps.language='zh';renderView(h('div',{className:'memory-settings',style:{height:'100%',overflow:'auto',padding:24}},h(MemoryPreferences)));`);
  await until('document.querySelector(".memory-record-toolbar")?.textContent.includes("变更历史")','Chinese memory controls');
  await run(`document.querySelector('.memory-record-toolbar').scrollIntoView({block:'start'})`);await pause();
  fs.writeFileSync(path.join(root,'tmp','summary-memory-records-narrow.png'),(await window.webContents.capturePage()).toPNG());
  await run('renderView(null);localStorage.removeItem(views.componentStorageKey);localStorage.removeItem(views.individuationStorageKey)');
  console.log('Memory settings and shortcut passed: shared switches, threshold validation/persistence, manual summary, failure recovery, keyboard, drafts, storage events and narrow layout.');
};
