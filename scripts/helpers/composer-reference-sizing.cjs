const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  await window.webContents.insertCSS('.app { width:100%!important; }');
  const key = async (keyCode, modifiers = []) => {
    window.webContents.sendInputEvent({type:'keyDown',keyCode,modifiers});
    window.webContents.sendInputEvent({type:'keyUp',keyCode,modifiers});
    await pause(50);
  };
  await run(`
    renderView(null);
    window.referenceSends=[];
    window.referenceOpens=[];
    window.addEventListener('cardbush-open-application',event=>referenceOpens.push(event.detail));
    const previous=JSON.parse(localStorage.getItem(views.componentStorageKey))||views.defaultComponents;
    views.saveComponents({...previous,items:previous.items.map(item=>item.id==='system-input'?{...item,inputStyle:'simple'}:item),
      welcomeLayout:{items:[{componentId:'system-input',x:10,y:460,width:80,height:100,inputStyle:'simple'}]}},previous.revision);
    window.referenceInput=()=>document.querySelector('[data-composer-input]');
    window.selectReferenceInput=(end=false)=>{
      const input=referenceInput();input.focus();const range=document.createRange();range.selectNodeContents(input);
      if(end)range.collapse(false);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);
    };
    window.referenceGeometry=()=>{
      const input=referenceInput(),surface=document.querySelector('.composer-surface'),style=getComputedStyle(input);
      return {height:surface.getBoundingClientRect().height,width:surface.getBoundingClientRect().width,inputHeight:input.getBoundingClientRect().height,
        tag:input.tagName,minHeight:style.minHeight,lineHeight:style.lineHeight,sizing:style.fieldSizing,draft:chatProps.draft};
    };
    updateChat({loading:false,historyLoading:false,language:'zh',activeConversationId:'reference-sizing',welcomeEnabled:true,
      messages:[],draft:'',sending:false,activeTurnId:'',permissionMode:'all_free',
      availableModels:[{id:'fixture',modelName:'Test model',provider:'fixture',enabled:true}],
      onDraftChange:draft=>updateChat({draft}),onSend:async text=>{referenceSends.push(text);updateChat({draft:''});}});
  `);
  await until('!!document.querySelector(".custom-layout .composer-stack.simple textarea")', 'custom simple welcome composer');
  const baseline = await run('referenceGeometry()');
  await run('referenceInput().focus()'); await window.webContents.insertText('@插件');
  await until('!!document.querySelector("[data-command-id=\\"application:builtin:plugins\\"]")', 'plugin application in mention menu');
  await run('document.querySelector("[data-command-id=\\"application:builtin:plugins\\"]").dispatchEvent(new MouseEvent("mousedown",{bubbles:true,cancelable:true}))');
  await until('!!document.querySelector(".composer-context-token button")', 'application token');
  const withToken = await run('referenceGeometry()');
  await run('document.querySelector(".composer-context-token button").click()');
  await until('!!document.querySelector("textarea[data-composer-input]")', 'plain input restored after deleting last reference');
  const removed = await run('referenceGeometry()');
  assert.ok(Math.abs(removed.height - baseline.height) < 1 && Math.abs(removed.height - withToken.height) < 1,
    'removing a single-line token must restore the same capsule height');
  assert.equal(removed.width, baseline.width);
  await run(`updateChat({draft:${JSON.stringify(withToken.draft)}})`);
  await until('!!document.querySelector(".composer-context-token")', 'reference for native keyboard deletion');
  await run('selectReferenceInput(true)');
  await key('Backspace');
  assert.equal(await run('chatProps.draft'),withToken.draft.trimEnd(),'native caret filler is not an authored newline');
  await run('document.querySelector(".composer-context-token button").click()');
  await until('!!document.querySelector("textarea[data-composer-input]")', 'delete chip after native editing');
  assert.equal(await run('chatProps.draft'),'');
  assert.equal(await run('referenceGeometry().height'),baseline.height,'native editing must not leave a synthetic blank line');
  await until('document.activeElement===referenceInput()', 'focus restored after deleting last chip');

  // Fully native Backspace and select-all deletion use the same normalization.
  for (const selectAll of [false, true]) {
    await run(`updateChat({draft:${JSON.stringify(withToken.draft)}})`);
    await until('!!document.querySelector(".composer-context-token")','reference ready for native clear');
    await run(`selectReferenceInput(${!selectAll})`);
    await key('Backspace');
    if (!selectAll) await key('Backspace');
    await until('referenceInput().tagName==="TEXTAREA" && chatProps.draft===""','native deletion clears the token');
    assert.equal(await run('referenceGeometry().height'),baseline.height);
  }
  await run(`updateChat({draft:${JSON.stringify(withToken.draft.trimEnd())}})`);
  await until('!!document.querySelector(".composer-context-token")','reference ready for forward deletion');
  await run('selectReferenceInput();getSelection().collapseToStart()');
  await key('Delete');
  await until('referenceInput().tagName==="TEXTAREA" && chatProps.draft===""','Delete removes the next atomic chip');
  assert.equal(await run('referenceGeometry().height'),baseline.height);

  // Intentional line breaks are kept, including blank trailing lines and copy.
  await run(`updateChat({draft:${JSON.stringify(withToken.draft.trimEnd())}})`);
  await until('!!document.querySelector(".composer-context-token")','reference ready for multiline editing');
  await run('selectReferenceInput(true)');
  for (let lines = 1; lines <= 2; lines++) {
    await key('Enter',['shift']);
    assert.equal(await run('chatProps.draft'),withToken.draft.trimEnd()+'\n'.repeat(lines),'Shift+Enter adds exactly one real newline');
  }
  await run('selectReferenceInput();const data=new DataTransfer();referenceInput().dispatchEvent(new ClipboardEvent("copy",{bubbles:true,cancelable:true,clipboardData:data}));window.referenceCopied=data.getData("text/plain")');
  assert.equal(await run('referenceCopied'),await run('chatProps.draft'));
  await run('document.querySelector(".composer-context-token button").click()');
  await until('referenceInput().tagName==="TEXTAREA"','multiline reference removed');
  assert.equal(await run('chatProps.draft'),'\n\n','removing a chip retains authored empty lines');

  await run('updateChat({draft:""})');
  await until('referenceInput().value===""','clean draft before components mention');
  await run('referenceInput().focus()'); await window.webContents.insertText('@组件');
  await until('!!document.querySelector("[data-command-id=\\"application:builtin:components\\"]")', 'components application in mention menu');
  await key('Enter');
  await until('document.querySelector(".composer-context-token > span")?.textContent==="组件"', 'components selection becomes a real chip');
  assert.deepEqual(await run('referenceOpens'),[],'selecting an @ reference does not launch or execute the application');
  fs.writeFileSync(path.join(root,'tmp','composer-components-reference.png'),(await window.webContents.capturePage()).toPNG());
  await run('document.querySelector(".send-button").click()');
  await until('referenceSends.length===1', 'components reference is sent');
  assert.equal(await run('views.promptReferenceParts(referenceSends[0])[0].reference.target'), 'components');
  assert.deepEqual(await run('referenceOpens'),[],'sending an @ reference does not launch the app');
  assert.equal(await run('referenceGeometry().height'),baseline.height,'sending resets the capsule size');

  // Continue after deleting in a narrow pane and a different theme.
  window.setContentSize(430,740);
  await run(`window.viewTheme='theme-light';updateChat({draft:${JSON.stringify(withToken.draft)}})`);
  await until('!!document.querySelector(".composer-context-token")','narrow reference input');
  await until('innerWidth === 430 && referenceGeometry().width < 430', 'native resize reaches the narrow composer before measuring');
  const narrow = await run('referenceGeometry()');
  await run('selectReferenceInput()'); await key('Backspace');
  await until('referenceInput().tagName==="TEXTAREA"','narrow input restored');
  assert.equal(await run('referenceGeometry().height'),narrow.height);
  assert.equal(await run('referenceGeometry().width'),narrow.width);
  await window.webContents.insertText('继续输入');
  await until('chatProps.draft==="继续输入"','typing works immediately after clear');
  await pause();
  fs.writeFileSync(path.join(root,'tmp','composer-reference-sizing.png'),(await window.webContents.capturePage()).toPNG());
  await run('renderView(h(views.PromptReferenceLink,{reference:views.promptReferenceParts(referenceSends[0])[0].reference}))');
  await until('!!document.querySelector("a.context-reference-token")','historical component reference');
  await run('document.querySelector("a.context-reference-token").click()');
  assert.equal(await run('referenceOpens[0].id'),'builtin:components','clicking a historical reference requests the components application');
  console.log('Composer references passed: native deletion size/focus, real newlines, copy, narrow layout, components @ selection/send/reopen.');
};
