const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ read, until, fill, click, pause, win, directory }) => {
  const send = async text => {
    await fill('.assistant-composer-dock textarea', text);
    await click('.assistant-composer-dock .send-button[aria-label="发送"]');
    await until(`fixture.sent.at(-1).text===${JSON.stringify(text)}`);
    await until('document.querySelector(".scroll-bottom").getAttribute("aria-hidden")==="true"');
  };
  const append = async (id, content, immediate = false) => {
    await read(`fixture.entries.push({id:${JSON.stringify(id)},role:'assistant',content:${JSON.stringify(content)},source:'page',visibility:'conversation',createdAt:new Date().toISOString()});void 0`);
    await until(`document.querySelector('[data-message-id="${id}"]')`);
    if (immediate) {
      await read('new Promise(resolve=>requestAnimationFrame(resolve))');
      const result = await bounds(id);
      assert.ok(result.row.top >= result.list.top && result.row.bottom < result.input.top,
        'new short bubble is visible at its first rendered frame: ' + JSON.stringify(result));
    }
    await pause(500);
  };
  const bounds = id => read(`(()=>{
    const list=document.querySelector('.assistant-messages'),row=document.querySelector('[data-message-id="${id}"]');
    const user=Array.from(document.querySelectorAll('[data-message-role=user]')).at(-1);
    return {row:row.getBoundingClientRect().toJSON(),user:user.getBoundingClientRect().toJSON(),
      list:list.getBoundingClientRect().toJSON(),input:document.querySelector('.composer-surface').getBoundingClientRect().toJSON(),
      top:list.scrollTop,remaining:list.scrollHeight-list.clientHeight-list.scrollTop};
  })()`);

  await send('短回复应完整展示，并保留这条提问。');
  await append('short-result', '## 简短结果\n\n已经完成核对。\n\n- 第一点\n- 第二点\n- 第三点');
  const short = await bounds('short-result');
  assert.ok(short.remaining < 2 && short.user.top >= short.list.top && short.row.bottom < short.input.top,
    'a fitting question and result both remain visible: ' + JSON.stringify(short));

  await send('这份长结果请从开头展示，我会自己向下阅读。');
  await append('long-result', '## 长结果的开头\n\n' + Array.from({ length: 34 }, (_, i) => `第 ${i + 1} 段：保留完整结果，超过屏幕时从开头阅读，后续内容通过滚动查看。`).join('\n\n'));
  const long = await bounds('long-result');
  assert.ok(long.user.top >= long.list.top - 2 && long.row.top > long.list.top && long.row.top < long.input.top - 200,
    'long results start with the question and the beginning, not their final paragraphs: ' + JSON.stringify(long));
  assert.ok(long.remaining > 500 && long.row.bottom > long.input.top);
  fs.writeFileSync(path.join(directory, 'assistant-long-result.png'), (await win.webContents.capturePage()).toPNG());
  await append('long-result-continuation', '## 后续补充\n\n这是同一轮新到达的短回复，应完整显示。', true);
  const continuation = await bounds('long-result-continuation');
  assert.ok(continuation.row.top >= continuation.list.top && continuation.row.bottom < continuation.input.top && continuation.remaining < 2,
    'a new short reply is revealed even after a long reply: ' + JSON.stringify(continuation));

  await click('.scroll-bottom');
  await until('document.querySelector(".scroll-bottom").getAttribute("aria-hidden")==="true"');
  assert.ok((await bounds('long-result-continuation')).remaining < 2, 'explicit bottom navigation still reaches the end');

  // A long question must not consume the whole viewport at the expense of a short answer.
  await send('较长的用户背景。'.repeat(200));
  await append('after-long-question', '## 答案\n\n这条短答案应完整出现在输入框上方。');
  const answer = await bounds('after-long-question');
  assert.ok(answer.row.top >= answer.list.top && answer.row.bottom < answer.input.top && answer.remaining < 2,
    'long user input does not hide a short result: ' + JSON.stringify(answer));

  // Content growth can emit a native scroll event without any user navigation.
  // It must not turn off automatic following before ResizeObserver runs.
  await read(`(()=>{const list=document.querySelector('.assistant-messages');
    const spacer=document.createElement('div');spacer.id='assistant-late-layout';spacer.style.height='140px';
    document.querySelector('[data-message-id="after-long-question"]>article>div').append(spacer);
    list.dispatchEvent(new Event('scroll'));})();`);
  await pause(450);
  assert.ok((await bounds('after-long-question')).remaining < 2, 'layout-only scroll events preserve following');
  await read('document.getElementById("assistant-late-layout").remove();void 0');

  // Real pointer events used to detach on any click, including task/answer clicks.
  await read(`(()=>{const row=document.querySelector('[data-message-id="after-long-question"]');
    row.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,pointerId:1,pointerType:'mouse'}));
    row.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerId:1,pointerType:'mouse'}));})();`);
  await append('after-click', '点击气泡后收到的新回复，也应完整显示。\n\n' + '这是整理后的重点。'.repeat(40), true);
  assert.ok((await bounds('after-click')).remaining < 2, 'ordinary content clicks do not disable following');

  await read(`document.querySelector('.assistant-messages').dispatchEvent(new WheelEvent('wheel',{deltaY:100,bubbles:true}));void 0`);
  await append('after-bottom-wheel', '在底部向下滚动过，新回复仍应自动出现。', true);
  assert.ok((await bounds('after-bottom-wheel')).remaining < 2, 'wheel at the bottom does not strand the next result');

  // Actual history navigation wins over both new replies and asynchronous layout.
  await read(`(()=>{const list=document.querySelector('.assistant-messages');
    list.dispatchEvent(new WheelEvent('wheel',{deltaY:-300,bubbles:true}));list.scrollTop-=300;})();`);
  const reading = (await bounds('after-bottom-wheel')).top;
  await append('while-manually-reading', '手动查看历史时保持位置。');
  assert.ok(Math.abs((await bounds('after-bottom-wheel')).top - reading) < 2, 'manual history reading is preserved');
  await click('.scroll-bottom');
  await until('document.querySelector(".scroll-bottom").getAttribute("aria-hidden")==="true"');
  await append('after-resuming', '回到底部后恢复跟随。', true);

  for (const theme of ['dark', 'light']) {
    await read(`fixture.theme(${JSON.stringify(theme)});void 0`); await pause(100);
    await require('./composer-backdrop.cjs').check(read);
    fs.writeFileSync(path.join(directory, 'assistant-scroll-' + theme + '.png'), (await win.webContents.capturePage()).toPNG());
  }
};
