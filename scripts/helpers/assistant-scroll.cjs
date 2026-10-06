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
  const append = async (id, content) => {
    await read(`fixture.entries.push({id:${JSON.stringify(id)},role:'assistant',content:${JSON.stringify(content)},source:'page',visibility:'conversation',createdAt:new Date().toISOString()});void 0`);
    await until(`document.querySelector('[data-message-id="${id}"]')`);
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
  await append('long-result-continuation', '## 后续补充\n\n这是同一轮的另一条结果，不应抢走正在阅读的开头。');
  assert.ok(Math.abs((await bounds('long-result')).top - long.top) < 2, 'multi-part results keep the first unread section visible');

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
};
