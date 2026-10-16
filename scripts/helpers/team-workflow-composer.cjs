const assert = require('node:assert/strict');
const { writeFileSync } = require('node:fs');
const { resolve } = require('node:path');

module.exports = async ({ read, until, frame, key, pointerClick, capture, win }) => {
  const dock = '.team-flow-workspace .inspector-quick-input';
  const toggle = '.team-flow-workspace .inspector-cover-input-toggle';
  const graphHeight = await read('document.querySelector(".team-flow-body").getBoundingClientRect().height');
  await read(`if(document.querySelector('${toggle}').getAttribute('aria-expanded')!=='true')document.querySelector('${toggle}').click()`);
  await until(`!!document.querySelector('${dock} textarea')`);
  assert.equal(await read('document.querySelector(".team-flow-body").getBoundingClientRect().height'), graphHeight, 'floating input does not shrink the graph');
  const setStyle = async (style, placement) => {
    await read(`saveComponents({...componentState,items:componentState.items.map(item=>item.id==='system-input'?{...item,inputStyle:${JSON.stringify(style)}}:item),
      welcomeLayout:${placement ? `{items:[{componentId:'system-input',x:0,y:0,width:100,height:120,inputStyle:${JSON.stringify(placement)}}]}` : 'undefined'}},componentState.revision)`);
    await frame();
  };
  const draft = async value => {
    await read(`(()=>{const input=document.querySelector('${dock} textarea');input.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await frame();
  };
  const visible = selector => read(`(()=>{const node=document.querySelector(${JSON.stringify(selector)});return !!node&&node.checkVisibility()&&node.getBoundingClientRect().width>0})()`);
  const menuChoice = async label => {
    await read(`[...document.querySelectorAll('.composer-popover button')].find(node=>node.textContent.includes(${JSON.stringify(label)})).click()`);
    await frame();
  };
  await setStyle('standard');
  assert.equal(await read(`!!document.querySelector('${dock} .composer-stack.input-only,${dock} .composer-stack.simple')`), false);
  assert.ok(await visible(`${dock} .permission-center-button`), 'standard workspace composer includes the normal permission control');
  assert.ok(await visible(`${dock} .model-select`));
  assert.ok(await visible(`${dock} .composer-tools > :first-child`));
  await pointerClick(`${dock} .model-select`);
  await menuChoice('Other model');
  await until('creationControls.model==="test-other"');
  await pointerClick(`${dock} .permission-center-button`);
  await menuChoice('完全访问');
  await until('creationControls.permission==="all_free"');
  await pointerClick(`${dock} .permission-center-button`);
  await menuChoice('申请批准');
  await until('creationControls.permission==="task_free"');
  const permissions = await read('permissionChanges.length');
  await draft('检查流程草稿');
  await key('Escape'); await until(`!document.querySelector('${dock}')`);
  await pointerClick(toggle); await until(`!!document.querySelector('${dock} textarea')`);
  assert.equal(await read(`document.querySelector('${dock} textarea').value`), '检查流程草稿', 'closing the floating input preserves the draft');
  await read(`window.workflowInput=document.querySelector('${dock} textarea');workflowInput.setSelectionRange(2,4);window.workflowChat=creationInspector.sessionId`);
  await setStyle('simple');
  assert.ok(await visible(`${dock} .composer-stack.simple .model-select`));
  assert.ok(await visible(`${dock} .composer-tools > :first-child`));
  assert.equal(await read(`document.querySelector('${dock} textarea')===workflowInput`), true, 'switching style reuses the editor and its caret');
  assert.deepEqual(await read('[workflowInput.value,workflowInput.selectionStart,workflowInput.selectionEnd]'), ['检查流程草稿',2,4]);
  assert.deepEqual(await read('creationControls'), {model:'test-other',permission:'task_free'});
  assert.equal(await read('permissionChanges.length'), permissions, 'simple presentation never resets an existing workflow permission');
  await pointerClick(`${dock} .composer-tools > :first-child`);
  assert.ok(await read('document.querySelector(".composer-popover").textContent.includes("添加文件")'), 'simple composer keeps the existing attachment menu');
  await pointerClick(`${dock} textarea`);
  await until('!document.querySelector(".composer-popover")');
  await draft('');
  for (const style of ['standard', 'simple']) {
    await setStyle(style);
    writeFileSync(resolve(`tmp/team-composer-${style}.png`), (await capture()).toPNG());
  }
  await setStyle('standard', 'simple');
  assert.ok(await read(`!!document.querySelector('${dock} .composer-stack.simple')`), 'welcome layout override matches ordinary conversations');
  win.setSize(650,680); await frame();
  await draft('第一行草稿\n第二行输入需要完整宽度');
  assert.ok(await read(`(()=>{const surface=document.querySelector('${dock} .composer-surface'),input=surface.querySelector('textarea').getBoundingClientRect(),footer=surface.querySelector('.composer-footer').getBoundingClientRect();return surface.classList.contains('is-multiline')&&input.bottom<=footer.top+1&&surface.scrollWidth<=surface.clientWidth+1})()`), 'narrow multiline input uses the shared full-width row');
  await read(`window.workflowCover=document.createElement('div');workflowCover.className='inspector-quick-input';document.querySelector('.app').append(workflowCover);setCreationPortal(workflowCover)`);
  await until('!!workflowCover.querySelector(".composer-stack.input-only")');
  assert.equal(await read('document.querySelectorAll(".team-flow-workspace .inspector-cover-controls").length'), 0, 'the covered inspector owns the only floating entry');
  assert.equal(await read('workflowCover.querySelector("textarea").value'), '第一行草稿\n第二行输入需要完整宽度');
  await read('setCreationPortal(null)'); await until(`!!document.querySelector('${dock} .composer-stack.simple')`);
  await read('workflowCover.remove()');
  assert.equal(await read('creationInspector.sessionId===workflowChat'), true);
  assert.deepEqual(await read('creationControls'), {model:'test-other',permission:'task_free'});
  assert.equal(await read(`document.querySelector('${dock} textarea').value`), '第一行草稿\n第二行输入需要完整宽度');
  win.setSize(1120,1000); await frame();
  await draft('从共享输入框发送流程修改'); await key('Enter');
  await until('creationSubmitted?.text==="从共享输入框发送流程修改"');
  assert.ok(await read('creationSubmitted.context.some(item=>item.kind==="editing-location"&&item.content.includes(flowId))'), 'shared submission still captures the selected workflow');
  await until(`document.querySelector('${dock} textarea').value===''`);
  await setStyle('standard');
  await pointerClick('.team-flow-header h1'); await until(`!document.querySelector('${dock}')`);
  assert.ok(await read('document.querySelector(".inspector-cover-status")?.textContent.includes("已回复")'), 'collapsed shared input retains the conversation state');
  writeFileSync(resolve('tmp/team-input-collapsed.png'), (await capture()).toPNG());
  console.log('Workflow composer passed: shared floating Input, no Back, standard/simple settings, draft retention, controls, permissions, cover round trip and send.');
};
