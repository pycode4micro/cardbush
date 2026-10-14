const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  await window.webContents.insertCSS('.app { width:100%!important; }');
  await run(`
    renderView(null);
    crypto.randomUUID ??= () => 'fixture-' + Math.random().toString(36).slice(2);
    views.saveIndividuation({habits:true,predictions:true});
    window.predSends=[]; window.predSendOptions=[]; window.predCancels=0; window.predStyle='standard'; window.predAssistant=false;
    window.prediction={id:'summary:memory',text:'帮我把这次创作的优化和滚动闪烁修复一起提交 push',expiresAt:Date.now()+600000};
    window.predMessages=[{id:'u',role:'user',content:'先检查编辑体验',conversationId:'predict-session',turnId:'t'},
      {id:'a',role:'assistant',content:'检查完成',conversationId:'predict-session',turnId:'t',status:'completed',toolExecutions:[
        {id:'summary',name:'summary_for_user',state:'completed',success:true,turnId:'t',metadata:{nextStepPrediction:prediction}}]}];
    window.predContext={sessionId:'predict-session',browserTabs:[],messages:predMessages};
    window.predProps={...chatProps,language:'zh',compact:true,draft:'',sending:false,stopping:false,queuedMessageCount:0,submissionPending:false,inputReadOnly:false,
      onDraftChange:draft=>{predProps.draft=draft;renderPrediction();},onCancel:async()=>{predCancels++;},
      onSend:async(text,options)=>{predSends.push(text);predSendOptions.push(options??null);predProps.draft='';renderPrediction();}};
    window.renderPrediction=()=>renderView(h('div',{style:{width:'min(760px,100%)',padding:20,margin:'140px auto'}}, predAssistant
      ? h(views.AssistantComposer,{controls:predProps,language:'zh',draft:predProps.draft,onDraftChange:predProps.onDraftChange,ready:true,submitting:false,
        onSend:predProps.onSend,messages:[],fileDropTarget:{current:null},browserTabs:[],nextStepPrediction:prediction,predictionPending:predContext.predictionPending})
      : h(views.ComposerReferenceContext.Provider,{value:predContext},h(views.ComposerPresentationContext.Provider,{value:{style:predStyle,preservePermissions:true}},h(views.Composer,predProps)))));
    window.predKey=(key='Enter',options={})=>{const input=document.querySelector('[data-composer-input]');input.focus();
      const event=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...options});input.dispatchEvent(event);return event.defaultPrevented;};
    window.predType=text=>{const input=document.querySelector('textarea[data-composer-input]');input.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,text);input.dispatchEvent(new Event('input',{bubbles:true}));};
    renderPrediction();
  `);
  await until('!!document.querySelector(".composer-prediction-accept")', 'forecast appears in the empty input');
  assert.equal(await run('document.querySelector("textarea").placeholder'), await run('prediction.text'));
  assert.equal(await run('document.querySelector("textarea").value'), '', 'suggestion is not an authored draft');
  assert.deepEqual(await run('predSends'), []);
  for (const key of ['Enter', 'Tab']) for (const options of [{isComposing:true}, {keyCode:229}, {shiftKey:true}, {ctrlKey:true}, {metaKey:true}, {altKey:true}, {repeat:true}]) {
    const prevented = await run(`predKey('${key}',${JSON.stringify(options)})`);
    if (key === 'Tab' && !options.repeat) assert.equal(prevented, false, 'IME and modified Tab retain their native behavior');
    assert.equal(await run('predProps.draft'), '', 'only an unmodified non-IME key accepts');
    assert.deepEqual(await run('predSends'), []);
  }
  for (const theme of ['theme-dark','theme-bright']) {
    await run(`document.body.classList.remove('theme-dark','theme-bright');document.body.classList.add('${theme}');renderPrediction();`);
    await pause(80);
    await fs.writeFile(path.join(root, 'tmp', 'composer-prediction-' + theme + '.png'), (await window.capturePage()).toPNG());
  }
  await run('predKey()');
  await until('predProps.draft===prediction.text && document.querySelector("textarea").value===prediction.text', 'first Enter inserts exact editable text');
  assert.deepEqual(await run('predSends'), [], 'first Enter never sends');
  await until('document.querySelector("textarea").selectionStart===prediction.text.length', 'caret moves to the end');
  await run('predKey("Enter",{repeat:true})');
  assert.deepEqual(await run('predSends'), [], 'holding Enter cannot confirm and send in one press');
  await run('predType(prediction.text+"，先检查改动");predKey()');
  await until('predSends.length===1', 'second Enter sends the edited draft');
  assert.equal(await run('predSends[0]'), await run('prediction.text+"，先检查改动"'));
  await until('!document.querySelector(".composer-prediction-accept")', 'accepted suggestion stays dismissed');

  await run('predContext={...predContext,sessionId:"predict-tab",nextStepPrediction:{...prediction,id:"tab-standard"}};renderPrediction();');
  await until('!!document.querySelector(".composer-prediction-accept")', 'Tab prediction in standard composer');
  assert.equal(await run('predKey("Tab")'), true, 'Tab fills the draft instead of moving focus');
  await until('predProps.draft===prediction.text && document.querySelector("textarea").selectionStart===prediction.text.length', 'Tab inserts the exact editable text with the caret at the end');
  assert.equal(await run('predSends.length'), 1, 'Tab inserts without sending');
  assert.equal(await run('predKey("Tab")'), false, 'a populated draft restores normal Tab navigation');
  await run('predType("")');

  await run('predContext={sessionId:"other",browserTabs:[],messages:[]};renderPrediction();');
  await pause(50);
  await run('predKey()');
  assert.equal(await run('predSends.length'), 1, 'empty Enter without a prediction has no effect');
  assert.equal(await run('predKey("Tab")'), false, 'empty input without a prediction keeps normal Tab navigation');
  await run('predContext={sessionId:"predict-session",browserTabs:[],messages:predMessages.map(m=>({...m,turnId:"new",toolExecutions:m.toolExecutions?.map(t=>({...t,turnId:"new"}))}))};renderPrediction();');
  await until('!!document.querySelector(".composer-prediction-accept")', 'new turn may suggest the same need again');
  await run('predType("我自己的消息")');
  await until('!document.querySelector(".composer-prediction-accept")', 'typing keeps the user draft');
  await run('predKey()');
  await until('predSends.length===2', 'normal Enter still sends authored text');
  assert.equal(await run('predSends[1]'), '我自己的消息');

  for (const patch of [{sending:true},{submissionPending:true},{inputReadOnly:true},{queuedMessageCount:1}]) {
    await run(`Object.assign(predProps,${JSON.stringify(patch)});renderPrediction();`);
    await until('!document.querySelector(".composer-prediction-accept")', 'busy/queued/readonly composer hides suggestions');
    assert.equal(await run('predKey("Tab")'), false, 'unavailable prediction does not intercept Tab');
    assert.equal(await run('predProps.draft'), '', 'Tab cannot insert an unavailable prediction');
    assert.equal(await run('predSends.length'), 2, 'Tab cannot submit while suggestions are unavailable');
    await run('Object.assign(predProps,{sending:false,submissionPending:false,inputReadOnly:false,queuedMessageCount:0});renderPrediction();');
    await until('!!document.querySelector(".composer-prediction-accept")', 'idle composer restores unaccepted suggestion');
  }
  await run('views.saveIndividuation({habits:true,predictions:false})');
  await until('!document.querySelector(".composer-prediction-accept")', 'prediction switch disables suggestions immediately');
  await run('views.saveIndividuation({habits:true,predictions:true})');
  await until('!!document.querySelector(".composer-prediction-accept")', 'prediction switch restores suggestions');

  await run('predProps.sending=true;renderPrediction();');
  await until('!document.querySelector(".composer-prediction-accept")', 'loop start withdraws the idle prediction');
  await run('predKey()');
  assert.equal(await run('predCancels'), 0, 'empty Enter does not cancel while the loop starts');
  await until('!!document.querySelector(".send-button .lucide-square") && !document.querySelector(".send-button").disabled', 'explicit stop becomes available');
  for (const text of ['', ' \n\t']) {
    await run(`predType(${JSON.stringify(text)})`);
    for (const key of ['Enter', 'Tab']) for (const options of [{}, {repeat:true}, {ctrlKey:true}]) await run(`predKey('${key}',${JSON.stringify(options)})`);
    assert.equal(await run('predCancels'), 0, 'empty or whitespace Enter/Tab must never stop a running loop');
    assert.equal(await run('predProps.draft'), text, 'a running loop must not fill a prediction');
    assert.equal(await run('predSends.length'), 2, 'empty input does not send guidance');
  }
  await run('views.saveIndividuation({habits:true,predictions:false});predType("");');
  await pause(30);
  await run('predKey()');
  assert.equal(await run('predCancels'), 0, 'empty Enter is harmless even with predictions disabled');
  await run('predType("先继续检查，不要停止");');
  await pause(30);
  await run('predKey()');
  await until('predSends.length===3', 'authored guidance still queues during a loop');
  assert.equal(await run('predSendOptions[2]'), null);
  await run('predType("立即检查这部分");');
  await pause(30);
  await run('predKey("Enter",{ctrlKey:true})');
  await until('predSends.length===4', 'explicit immediate guidance still works');
  assert.deepEqual(await run('predSendOptions[3]'), {immediate:true});
  assert.equal(await run('predCancels'), 0, 'guidance does not use the stop action');
  await run('document.querySelector(".send-button").click()');
  assert.equal(await run('predCancels'), 1, 'the explicit stop button still cancels');
  await run('predProps.stopping=true;renderPrediction();');
  await until('document.querySelector(".send-button").disabled', 'stop is disabled while stopping');
  await run('predKey();document.querySelector(".send-button").click()');
  assert.equal(await run('predCancels'), 1, 'empty Enter cannot request another cancellation');
  await run('Object.assign(predProps,{sending:false,stopping:false});views.saveIndividuation({habits:true,predictions:true});renderPrediction();');
  await until('!!document.querySelector(".composer-prediction-accept")', 'idle prediction remains available after loop ends');

  await run(`window.cardbushDesktop.pickAttachments=async()=>['D:/fixture/report.md'];
    document.querySelector('.tool-chip[title=添加]').click();`);
  await until('!!document.querySelector(".composer-add-menu")', 'attachment menu');
  await run(`[...document.querySelectorAll('.composer-add-menu button')].find(button=>button.textContent.includes('文件')).click()`);
  await until('!!document.querySelector(".composer-file-attachment")', 'attachment mounted');
  assert.equal(await run('!!document.querySelector(".composer-prediction-accept")'), false);
  await run('predKey()');
  await until('predSends.length===5', 'attachment-only request keeps normal Enter behavior');
  assert.match(await run('predSends[4]'), /report\.md/);
  assert.doesNotMatch(await run('predSends[4]'), /提交 push/);

  await run('predAssistant=true;renderPrediction();');
  await until('!!document.querySelector(".composer-stack.simple .composer-prediction-accept")', 'assistant uses the shared prediction input');
  assert.notEqual(await run('getComputedStyle(document.querySelector(".composer-prediction-accept")).display'), 'none');
  window.setContentSize(430, 720); await pause(80);
  assert.equal(await run('(()=>{const a=document.querySelector("textarea").getBoundingClientRect(),b=document.querySelector(".composer-actions").getBoundingClientRect();return a.bottom<=b.top+1})()'), true,
    'narrow simple input keeps suggested text above the controls');
  await fs.writeFile(path.join(root, 'tmp', 'composer-prediction-assistant.png'), (await window.capturePage()).toPNG());
  await run('predContext.predictionPending=true;renderPrediction();');
  await until('!document.querySelector(".composer-prediction-accept")', 'assistant busy state hides old suggestion');
  await run('predKey();predKey("Enter",{repeat:true});');
  assert.equal(await run('predKey("Tab")'), false, 'busy assistant retains normal Tab navigation');
  assert.equal(await run('predSends.length'), 5, 'busy assistant empty Enter/Tab does not send');
  assert.equal(await run('predProps.draft'), '', 'busy assistant does not accept the idle prediction');
  await run('predContext.predictionPending=false;renderPrediction();');
  await until('!!document.querySelector(".composer-prediction-accept")', 'assistant idle');
  await run('document.querySelector(".composer-prediction-accept").click()');
  await until('predProps.draft===prediction.text', 'pointer confirmation also only inserts');
  assert.equal(await run('predSends.length'), 5);
  await run('prediction={...prediction,id:"tab-assistant"};predType("");renderPrediction();');
  await until('!!document.querySelector(".composer-prediction-accept")', 'new prediction in the simple assistant composer');
  assert.equal(await run('predKey("Tab")'), true);
  await until('predProps.draft===prediction.text', 'assistant Tab also inserts without sending');
  assert.equal(await run('predSends.length'), 5);
  await run('renderView(null);views.saveIndividuation({habits:false,predictions:false})');
  console.log('Prediction composer: Tab/Enter insert without sending, empty loop never cancels, native Tab navigation, IME/modifier/repeat guards, draft/attachment priority, assistant and narrow layout passed.');
};
