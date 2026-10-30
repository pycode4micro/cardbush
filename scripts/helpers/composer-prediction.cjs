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
      ? h(views.AssistantComposer,{controls:predProps,language:predProps.language,draft:predProps.draft,onDraftChange:predProps.onDraftChange,ready:true,submitting:false,
        onSend:predProps.onSend,messages:[],fileDropTarget:{current:null},browserTabs:[],nextStepPrediction:prediction,predictionPending:predContext.predictionPending})
      : h(views.ComposerReferenceContext.Provider,{value:predContext},h(views.ComposerPresentationContext.Provider,{value:{style:predStyle,preservePermissions:true}},h(views.Composer,predProps)))));
    window.predKey=(key='Enter',options={})=>{const input=document.querySelector('[data-composer-input]');input.focus();
      const event=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...options});input.dispatchEvent(event);return event.defaultPrevented;};
    window.predType=text=>{const input=document.querySelector('textarea[data-composer-input]');input.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,text);input.dispatchEvent(new Event('input',{bubbles:true}));};
    renderPrediction();
  `);
  await until('!!document.querySelector(".composer-surface.has-next-step")', 'forecast appears in the empty input');
  assert.equal(await run('!!document.querySelector(".composer-prediction-accept")'),false,'keyboard hints do not appear on the toolbar');
  assert.equal(await run('document.querySelector("textarea").placeholder'), await run('prediction.text'));
  assert.equal(await run('document.querySelector("textarea").value'), '', 'suggestion is not an authored draft');
  assert.deepEqual(await run('predSends'), []);
  await run(`window.badPrediction={...prediction,id:'narrative',text:'用户可能接下来要求运行这个示例流程，或把其中的节点替换为自己注册的员工。'};`);
  for (const style of ['standard','simple']) for (const supplied of [false,true]) {
    await run(`predStyle='${style}';predContext={sessionId:'predict-session',browserTabs:[],messages:predMessages.map(message=>({...message,toolExecutions:message.toolExecutions?.map(tool=>({...tool,metadata:{nextStepPrediction:badPrediction}}))})),${supplied ? 'nextStepPrediction:badPrediction' : ''}};renderPrediction();`);
    await until('!document.querySelector(".composer-surface.has-next-step")','narrative forecasts are hidden in all shared inputs');
    assert.equal(await run('predKey("Tab")'),false,'rejected prediction leaves normal Tab navigation');
    await run('predKey()');
    assert.equal(await run('predProps.draft'),'','empty Enter does not insert a rejected prediction');
    assert.deepEqual(await run('predSends'),[]);
  }
  await run('predStyle="standard";predContext={sessionId:"predict-session",browserTabs:[],messages:predMessages};renderPrediction();');
  await until('!!document.querySelector(".composer-surface.has-next-step")','valid suggestion remains usable');
  for (const key of ['Enter', 'Tab']) for (const options of [{isComposing:true}, {keyCode:229}, {shiftKey:true}, {ctrlKey:true}, {metaKey:true}, {altKey:true}, {repeat:true}]) {
    const prevented = await run(`predKey('${key}',${JSON.stringify(options)})`);
    if (key === 'Tab' && !options.repeat) assert.equal(prevented, false, 'IME and modified Tab retain their native behavior');
    assert.equal(await run('predProps.draft'), '', 'only an unmodified non-IME key accepts');
    assert.deepEqual(await run('predSends'), []);
  }
  for (const theme of ['theme-dark','theme-bright']) {
    await run(`window.viewTheme='${theme}';renderPrediction();`);
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
  await until('!document.querySelector(".composer-surface.has-next-step")', 'accepted suggestion stays dismissed');

  await run('predContext={...predContext,sessionId:"predict-tab",nextStepPrediction:{...prediction,id:"tab-standard"}};renderPrediction();');
  await until('!!document.querySelector(".composer-surface.has-next-step")', 'Tab prediction in standard composer');
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
  await until('!!document.querySelector(".composer-surface.has-next-step")', 'new turn may suggest the same need again');
  await run('predType("我自己的消息")');
  await until('!document.querySelector(".composer-surface.has-next-step")', 'typing keeps the user draft');
  await run('predKey()');
  await until('predSends.length===2', 'normal Enter still sends authored text');
  assert.equal(await run('predSends[1]'), '我自己的消息');

  for (const patch of [{sending:true},{submissionPending:true},{inputReadOnly:true},{queuedMessageCount:1}]) {
    await run(`Object.assign(predProps,${JSON.stringify(patch)});renderPrediction();`);
    await until('!document.querySelector(".composer-surface.has-next-step")', 'busy/queued/readonly composer hides suggestions');
    assert.equal(await run('predKey("Tab")'), false, 'unavailable prediction does not intercept Tab');
    assert.equal(await run('predProps.draft'), '', 'Tab cannot insert an unavailable prediction');
    assert.equal(await run('predSends.length'), 2, 'Tab cannot submit while suggestions are unavailable');
    await run('Object.assign(predProps,{sending:false,submissionPending:false,inputReadOnly:false,queuedMessageCount:0});renderPrediction();');
    await until('!!document.querySelector(".composer-surface.has-next-step")', 'idle composer restores unaccepted suggestion');
  }
  await run('views.saveIndividuation({habits:true,predictions:false})');
  await until('!document.querySelector(".composer-surface.has-next-step")', 'prediction switch disables suggestions immediately');
  await run('views.saveIndividuation({habits:true,predictions:true})');
  await until('!!document.querySelector(".composer-surface.has-next-step")', 'prediction switch restores suggestions');

  await run('predProps.sending=true;renderPrediction();');
  await until('!document.querySelector(".composer-surface.has-next-step")', 'loop start withdraws the idle prediction');
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
  await until('!!document.querySelector(".composer-surface.has-next-step")', 'idle prediction remains available after loop ends');

  await run(`window.cardbushDesktop.pickAttachments=async()=>['D:/fixture/report.md'];
    document.querySelector('.tool-chip[title=添加]').click();`);
  await until('!!document.querySelector(".composer-add-menu")', 'attachment menu');
  await run(`[...document.querySelectorAll('.composer-add-menu button')].find(button=>button.textContent.includes('文件')).click()`);
  await until('!!document.querySelector(".composer-file-attachment")', 'attachment mounted');
  assert.equal(await run('!!document.querySelector(".composer-surface.has-next-step")'), false);
  await run('predKey()');
  await until('predSends.length===5', 'attachment-only request keeps normal Enter behavior');
  assert.match(await run('predSends[4]'), /report\.md/);
  assert.doesNotMatch(await run('predSends[4]'), /提交 push/);

  await run('predAssistant=true;renderPrediction();');
  await until('!!document.querySelector(".composer-stack.simple .composer-surface.has-next-step")', 'assistant uses the shared prediction input');
  await run('window.validPrediction=prediction;prediction=badPrediction;renderPrediction();');
  await until('!document.querySelector(".composer-surface.has-next-step")','assistant also filters supplied narrative forecasts');
  assert.equal(await run('predKey("Tab")'),false);
  await run('predKey()');
  assert.equal(await run('predProps.draft'),'');assert.equal(await run('predSends.length'),5);
  await run('prediction=validPrediction;renderPrediction();');
  await until('!!document.querySelector(".composer-surface.has-next-step")','assistant restores a valid forecast');
  assert.notEqual(await run('getComputedStyle(document.querySelector(".composer-surface.has-next-step")).display'), 'none');
  const geometry = `(()=>{const s=document.querySelector('.composer-surface'),i=s.querySelector('textarea'),a=s.querySelector('.composer-actions'),r=s.getBoundingClientRect(),ir=i.getBoundingClientRect(),ar=a.getBoundingClientRect();return {height:r.height,radius:getComputedStyle(s).borderRadius,inputHeight:ir.height,inputTop:ir.top-r.top,actionsTop:ar.top-r.top,actionsHeight:ar.height,stacked:s.classList.contains('is-multiline'),contained:ir.right<=ar.left+1&&ar.right<=r.right,overflow:document.documentElement.scrollWidth>innerWidth}})()`;
  const themeColors = new Map();
  for (const [theme,language] of [['theme-dark','zh'],['theme-bright','en']]) for (const width of [1000,430]) {
    window.setContentSize(width, 720);
    await run(`window.viewTheme='${theme}';predProps.language='${language}';views.saveIndividuation({habits:true,predictions:false});renderPrediction();`);
    await until('!document.querySelector(".composer-surface.has-next-step")', 'baseline empty input');await pause(80);
    const baseline = await run(geometry);
    themeColors.set(theme, await run('getComputedStyle(document.querySelector(".composer-surface")).backgroundColor'));
    for (const text of ['我想每天固定时间收到一个提醒。','帮我把这次创作的优化和滚动闪烁修复一起提交 push，并整理一份完整的检查报告']) {
      await run(`prediction={...validPrediction,id:'layout-'+${JSON.stringify(theme+width+text)},text:${JSON.stringify(text)}};views.saveIndividuation({habits:true,predictions:true});renderPrediction();`);
      await until('!!document.querySelector(".composer-surface.has-next-step")', 'suggestion placeholder');await pause(80);
      assert.deepEqual(await run(geometry),baseline,'short/long suggestions keep the empty input geometry, toolbar and radius in '+theme+' at '+width);
      assert.equal(await run('document.querySelector("textarea").value'),'','suggestion is still not authored text');
      assert.equal(await run('document.querySelector("textarea").placeholder'),text,'the complete suggestion remains available for acceptance');
      assert.equal(baseline.stacked,false);assert.equal(baseline.contained,true);assert.equal(baseline.overflow,false);
    }
    await fs.writeFile(path.join(root,'tmp',`composer-prediction-assistant-${theme}-${width}.png`),(await window.capturePage()).toPNG());
  }
  assert.notEqual(themeColors.get('theme-dark'),themeColors.get('theme-bright'),'both actual App themes were exercised');
  await run('prediction=validPrediction;predProps.language="zh";renderPrediction();');
  await fs.writeFile(path.join(root, 'tmp', 'composer-prediction-assistant.png'), (await window.capturePage()).toPNG());
  await run('predContext.predictionPending=true;renderPrediction();');
  await until('!document.querySelector(".composer-surface.has-next-step")', 'assistant busy state hides old suggestion');
  await run('predKey();predKey("Enter",{repeat:true});');
  assert.equal(await run('predKey("Tab")'), false, 'busy assistant retains normal Tab navigation');
  assert.equal(await run('predSends.length'), 5, 'busy assistant empty Enter/Tab does not send');
  assert.equal(await run('predProps.draft'), '', 'busy assistant does not accept the idle prediction');
  await run('predContext.predictionPending=false;renderPrediction();');
  await until('!!document.querySelector(".composer-surface.has-next-step")', 'assistant idle');
  await run('predKey("Enter")');
  await until('predProps.draft===prediction.text', 'keyboard confirmation only inserts');
  await until('!!document.querySelector(".composer-surface.is-multiline")','accepted long text expands as authored content');
  assert.equal(await run('predSends.length'), 5);
  await run('prediction={...prediction,id:"tab-assistant"};predType("");renderPrediction();');
  await until('!!document.querySelector(".composer-surface.has-next-step")', 'new prediction in the simple assistant composer');
  assert.equal(await run('predKey("Tab")'), true);
  await until('predProps.draft===prediction.text', 'assistant Tab also inserts without sending');
  assert.equal(await run('predSends.length'), 5);
  await run('predType("短句")');
  await until('!document.querySelector(".composer-surface.is-multiline")','shortening the authored text restores the compact row');
  await run('predType(badPrediction.text);');
  await pause(30);await run('predKey()');
  await until('predSends.length===6','prediction checks never block the user\'s own text');
  assert.equal(await run('predSends[5]'),await run('badPrediction.text'));
  await run('renderView(null);views.saveIndividuation({habits:false,predictions:false})');
  console.log('Prediction composer: Tab/Enter insert without sending, empty loop never cancels, native Tab navigation, IME/modifier/repeat guards, draft/attachment priority, assistant and narrow layout passed.');
};
