const assert = require('node:assert/strict');

module.exports = async ({ read, until, fill, click, pause, win }) => {
  const input = '[data-composer-input]', send = '.composer-surface .send-button';
  await until(`!!document.querySelector('${input}')&&!document.querySelector('${input}').readOnly`);
  await fill(input, '`user_id` 和 ``含 `反引号` 的词``');
  await until('document.querySelectorAll(".assistant-composer-dock .composer-code-mark").length===2');
  assert.equal(await read('document.querySelector(".assistant-composer-dock textarea").value'), '`user_id` 和 ``含 `反引号` 的词``');
  await fill(input, '');
  await read(`fixture.dialogs=[];cardbushDesktop.showErrorDialog=async error=>{fixture.dialogs.push(error);};
    window.alert=message=>fixture.dialogs.push({message});void 0`);
  const binding = async value => {
    await read(`localStorage.setItem('cardbush_keyboard_shortcuts',JSON.stringify(${JSON.stringify(value)}));
      dispatchEvent(new StorageEvent('storage',{key:'cardbush_keyboard_shortcuts'}));void 0`);
    await pause(50);
  };
  const enter = async (modifiers = []) => {
    await read(`document.querySelector('${input}').focus();void 0`);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Enter',modifiers});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'Enter',modifiers});
  };
  const sent = async (count, text) => {
    await until(`fixture.sent.length===${count}||fixture.dialogs.length>0`);
    assert.deepEqual(await read('fixture.dialogs'), [], 'guidance options must never be interpreted as a failed Assistant message');
    assert.equal(await read('fixture.sent.at(-1).text'), text);
    await until(`!document.querySelector('${send}').disabled`);
    assert.equal(await read(`document.querySelector('${input}').value`), '');
  };

  await binding({guideNow:{key:'Enter',ctrl:true,shift:true}});
  await fill(input, '普通回车'); await enter(); await sent(1, '普通回车');

  await fill(input, '空闲时立即发送');
  await read('fixture.holdSend=true;fixture.releaseSend=null;void 0');
  await enter(['control','shift']);
  await until('typeof fixture.releaseSend==="function"||fixture.dialogs.length>0');
  assert.deepEqual(await read('fixture.dialogs'), [], 'the guidance shortcut while idle submits directly without an error dialog');
  assert.equal(await read(`document.querySelector('${input}').value`), '', 'shortcut clears the accepted draft optimistically');
  await enter(['control','shift']); await pause(80);
  assert.equal(await read('fixture.sendCalls.length'), 2, 'pending admission cannot duplicate a shortcut submission');
  await read('fixture.holdSend=false;fixture.releaseSend();void 0'); await sent(2, '空闲时立即发送');
  assert.equal(await read('fixture.sendCalls[1].identity.id!==fixture.sendCalls[0].identity.id'), true, 'a new input gets a new message identity');

  await read('fixture.busy=true;void 0'); await until('!!document.querySelector(".assistant-typing-bubble")');
  await fill(input, '工作时继续发送'); await enter(['control','shift']); await sent(3, '工作时继续发送');

  // A quote is new-message context, not the failed-message argument used by Retry.
  await read(`document.querySelector('[data-message-id="p"]').scrollIntoView({block:'center',behavior:'instant'});void 0`);
  await pause(200);
  await read(`document.querySelector('[data-message-id="p"] .assistant-text-bubble').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:400,clientY:180}));void 0`);
  await until('!!document.querySelector(".assistant-message-menu [data-menu-reply]")');
  await click('.assistant-message-menu [data-menu-reply]');
  await until('!!document.querySelector(".assistant-message-quote.is-draft")');
  await fill(input, '引用后立即发送'); await enter(['control','shift']); await sent(4, '引用后立即发送');
  assert.equal(await read('fixture.sendCalls[3].identity.replyTo.messageId'), 'p');

  await read('fixture.busy=false;fixture.failSend=true;void 0');
  await fill(input, '失败后仍可重试'); await enter(['control','shift']);
  await until('!!document.querySelector(".assistant-message-retry")');
  assert.equal(await read(`document.querySelector('${input}').value`), '失败后仍可重试', 'an unaccepted draft is restored');
  assert.deepEqual(await read('fixture.dialogs'), []);
  await read('fixture.failSend=false;void 0'); await click('.assistant-message-retry');
  await until('fixture.sent.length===5&&!document.querySelector(".assistant-message-retry")');
  assert.equal(await read('fixture.sendCalls[4].identity.id===fixture.sendCalls[5].identity.id'), true, 'explicit Retry preserves the failed message identity');

  await read('fixture.portal(true);void 0');
  await until('!!document.querySelector(".inspector-quick-input [data-composer-input]")');
  await fill(input, '侧栏快捷输入'); await enter(['control','shift']); await sent(6, '侧栏快捷输入');
  await enter(['control','shift']); await pause(80); assert.equal(await read('fixture.sent.length'), 6, 'empty input is a no-op');

  await binding({}); await fill(input, '默认引导快捷键'); await enter(['control']); await sent(7, '默认引导快捷键');
  assert.deepEqual(await read('fixture.dialogs'), []);
  console.log('Assistant shortcuts passed: native default/remapped guidance keys, idle/busy, quotes, portal, pending-send deduplication, empty input and explicit failed-message retry.');
};
