const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ read, until, fill, click, pause, win, directory }) => {
  const reference = { tabId: 'test-tab', pageId: '3', url: 'https://example.com/dashboard?selected=' + '中文页面'.repeat(25), title: '达人首页' };
  const markdown = `[@${reference.title}](cardbush-reference://browser?${new URLSearchParams(reference)})`;
  const prompt = markdown + ' 帮我整理下当前页面的信息';
  await fill('.assistant-composer-dock textarea', prompt);
  await until('document.querySelector(".composer-context-token")?.textContent.includes("达人首页")');
  assert.equal(await read('document.querySelector(".composer-prompt-editor").textContent.includes("cardbush-reference://")'), false, 'editor renders a chip, not the encoded URI');
  await click('.assistant-composer-dock .send-button[aria-label="发送"]');
  await until(`fixture.sent.at(-1).text===${JSON.stringify(prompt)}`);
  await until('document.querySelector(".assistant-messages .assistant-message-user .context-reference-token")');
  const authored = await read('fixture.entries.at(-1).content');
  assert.equal(authored, prompt, 'original reference identity survives sending');
  await read(`fixture.entries.push({id:'bubble-result',role:'assistant',content:${JSON.stringify('## 页面信息\n\n执行助手已读取当前页面。\n\n- 数据概览\n- 待办事项')},source:'page',visibility:'conversation',createdAt:new Date().toISOString()});void 0`);
  await until('document.querySelector("[data-message-id=bubble-result]")');
  await pause(450);
  for (const theme of ['dark', 'bright']) {
    await read(`fixture.theme('${theme}');fixture.portal(false);void 0`);
    await until('document.querySelector(".assistant-composer-dock textarea")');
    const full = await read(`(()=>{const bubble=document.querySelector('.assistant-messages .assistant-message-assistant:last-child>div')??document.querySelector('[data-message-id=bubble-result] article>div');return {bubble:getComputedStyle(bubble).backgroundColor,container:getComputedStyle(document.querySelector('.assistant-view')).backgroundColor};})()`);
    assert.notEqual(full.bubble, full.container, theme + ' full reply bubble remains distinct');
    await read('fixture.portal(true);void 0'); await until('document.querySelector(".quick-input-status")');
    await click('.quick-input-status'); await until('document.querySelector(".quick-input-transcript .context-reference-token")');
    await pause(150);
    const preview = await read(`(()=>{const transcript=document.querySelector('.quick-input-transcript'),bubble=transcript.querySelector('[data-message-id=bubble-result] article>div'),user=Array.from(transcript.querySelectorAll('.assistant-message-user')).at(-1),input=document.querySelector('.inspector-quick-input .composer-surface'),container=document.querySelector('.inspector-quick-input');return {text:user.textContent,href:user.querySelector('a').getAttribute('href'),bubble:getComputedStyle(bubble).backgroundColor,container:getComputedStyle(container).backgroundColor,border:getComputedStyle(bubble).borderTopWidth,transcript:transcript.getBoundingClientRect().toJSON(),input:input.getBoundingClientRect().toJSON(),containerRect:container.getBoundingClientRect().toJSON(),statusDisplay:getComputedStyle(document.querySelector('.quick-input-status')).display,overflow:transcript.scrollWidth>transcript.clientWidth};})()`);
    assert.equal(preview.text.includes('cardbush-reference://'), false);
    assert.equal(preview.text.includes('%'), false);
    assert.ok(preview.text.includes('达人首页'));
    assert.equal(new URL(preview.href).searchParams.get('pageId'), '3');
    assert.notEqual(preview.bubble, preview.container, theme + ' floating reply bubble remains distinct');
    assert.notEqual(preview.container, 'rgba(0, 0, 0, 0)', 'fixture uses the real floating container styles');
    assert.equal(preview.statusDisplay, 'flex');
    assert.ok(preview.transcript.height > 0 && preview.transcript.height <= 340);
    assert.ok(preview.input.bottom <= preview.containerRect.bottom + 1, 'input stays inside the floating container');
    assert.equal(preview.border, '1px'); assert.equal(preview.overflow, false);
    assert.ok(preview.transcript.bottom <= preview.input.top + 1, 'preview and input cannot overlap: ' + JSON.stringify(preview));
    win.webContents.invalidate(); await pause(180);
    fs.writeFileSync(path.join(directory, `assistant-reference-${theme}.png`), (await win.webContents.capturePage()).toPNG());
  }
  await read('fixture.portal(false);void 0');
};
