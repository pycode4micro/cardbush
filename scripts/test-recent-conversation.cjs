// Production window and real paged Runtime history, using an isolated desktop profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');
const project = path.resolve(__dirname, '..');

if (typeof electron === 'string') {
  const base = path.join(project, 'tmp');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'recent-conversation-'));
  const env = { ...process.env, APPDATA: root, LOCALAPPDATA: root, USERPROFILE: root, HOME: root,
    CARDBUSH_DEVELOPMENT_RUNTIME: '1', CARDBUSH_ELECTRON_DEV_SERVER_URL: '' };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
  const result = require('node:child_process').spawnSync(electron, [__filename, root], { cwd: project, env, windowsHide: true, stdio: 'inherit', timeout: 100000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} else {
  run().catch(error => { console.error(error); electron.app.exit(1); });
}

async function run() {
  const { app, BrowserWindow } = electron;
  const root = process.argv[2];
  app.setPath('appData', root); app.setPath('userData', root); app.setAppPath(project);
  const { FileSessionEventPersistence, SessionStore } = await import('@cardbush/bush-runtime');
  const journal = new FileSessionEventPersistence({ root: path.join(root, 'runtime-state', 'sessions') });
  const store = new SessionStore({ persistence: journal });
  const sessionId = 'local-navigation-test';
  store.ensureSession('local-empty', { title: 'Empty conversation' });
  store.ensureSession('local-earlier', { title: 'Earlier conversation' });
  const earlierStamp = new Date(Date.now() - 86400000).toISOString();
  store.commitTurn('local-earlier', { turnId: 'other-turn', turnSequence: 1, createdAt: earlierStamp, completedAt: earlierStamp,
    status: 'completed', reason: 'stop', usage: {}, messages: [{ messageId: 'other-user', turnId: 'other-turn', turnSequence: 1,
      messageIndex: 0, createdAt: earlierStamp, message: { role: 'user', content: '另一份评审' } }] });
  store.ensureSession(sessionId, { title: '设计评审记录' });
  const examples = new Map([
    [45, ['这张封面放在首页效果怎么样？','可以放在首屏，标题留在左下角。','tide.jpg']],
    [44, ['整理本周的评审结论','三项已确认，两项留到周五复查。']],
    [43, ['看一下这个配色','绿色和深色背景的层次比较清楚。','fern.jpg']],
    [42, ['把讨论整理成一页清单','清单已按负责人和截止日期整理。']],
    [41, ['对比一下这张参考图','这版主体更突出，适合窄窗口。','fold.jpg']],
    [40, ['还有哪些细节要确认？','需要确认字号和图片裁切范围。']],
  ]);
  for (let i = 1; i <= 45; i++) {
    const stamp = new Date(Date.now() - (46 - i) * 60000).toISOString();
    const turnId = 'turn-' + i;
    const [prompt, reply, image] = examples.get(i) ?? ['评审方案 ' + i, '评审记录 '.repeat(90)];
    const messages = [
      { role: 'user', content: prompt },
      { role: 'assistant', content: reply, toolCalls: [] },
    ].map((message, index) => ({ messageId: turnId + '-' + index, turnId, turnSequence: i, messageIndex: index, createdAt: stamp, message,
      ...(index === 0 && image ? { metadata: { attachments: [{ id: 'cover-' + i, name: image, type: 'image',
        path: path.join(project, 'src/features/desktop/art', image) }] } } : {}) }));
    if (i === 45) messages.push({messageId:'tool-call',turnId,turnSequence:i,messageIndex:2,createdAt:stamp,
      message:{role:'assistant',content:'',toolCalls:[{id:'receipt',name:'fixture',argumentsText:'{}'}]}},
      {messageId:'tool-receipt',turnId,turnSequence:i,messageIndex:3,createdAt:stamp,
      message:{role:'tool',name:'fixture',toolCallId:'receipt',content:'Internal tool receipt'}});
    store.commitTurn(sessionId, { turnId, turnSequence: i, createdAt: stamp, completedAt: stamp, status: 'completed', reason: 'stop', usage: {}, messages });
  }
  store.ensureSession('local-hidden', { title: 'Hidden session', hidden: true });
  journal.close();
  require(path.join(project, 'dist-electron/bootstrap.js'));
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const wait = async (check, label) => {
    const deadline = Date.now() + 18000;
    while (Date.now() < deadline) { const result = await check(); if (result) return result; await pause(60); }
    throw Error('Timed out: ' + label);
  };
  const win = await wait(() => BrowserWindow.getAllWindows().find(w => !w.isDestroyed()), 'workspace');
  win.setContentSize(1400, 800);
  const read = code => win.webContents.executeJavaScript(code, true);
  const visible = selector => wait(() => read('Boolean(document.querySelector(' + JSON.stringify(selector) + ')?.checkVisibility())'), selector);
  const click = async selector => { await visible(selector); await read('document.querySelector(' + JSON.stringify(selector) + ').click();void 0'); };
  await visible('[data-desktop-page="overview"]');
  await visible('.recent-bar-chat');
  assert.equal(await read("document.querySelector('.recent-chat-copy strong').textContent"), '设计评审记录');
  await wait(() => read("document.querySelector('.recent-chat-copy small')?.textContent === " + JSON.stringify(examples.get(45)[1])), 'latest assistant output appears before opening the navigator').catch(async cause => {
    throw Error('Unexpected assistant preview: ' + await read("document.querySelector('.recent-chat-copy')?.textContent"), {cause});
  });
  assert.equal(await read("Boolean(document.querySelector('.recent-turn-scroll'))"), false);
  const title = () => read("document.querySelector('.recent-chat-copy strong').textContent");
  const direction = await read("document.querySelector('[data-recent-step=previous]').disabled ? 'next' : 'previous'");
  await click('[data-recent-step=' + direction + ']');
  await wait(async () => await title() !== '设计评审记录', 'previous or next selects an adjacent chat');
  await visible('[data-desktop-page=overview]');
  assert.equal(await read("!!document.querySelector('.recent-chat-copy small')"), false, 'a chat with no assistant output shows only its title');
  await click('[data-recent-step=' + (direction === 'previous' ? 'next' : 'previous') + ']');
  await wait(async () => await title() === '设计评审记录', 'opposite navigation restores the chat');
  await visible('.recent-chat-copy small');
  const bounds = () => read("Array.from(document.querySelectorAll('.recent-bar button.no-drag')).every(button => {const r=button.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.width>=24;})");
  assert.ok(await bounds());
  fs.writeFileSync(path.join(project, 'tmp/conversation-glass-bar.png'), (await win.webContents.capturePage()).toPNG());
  win.setContentSize(1400, 600); await pause(180);
  await read("document.querySelector('.desktop-library').scrollTop=270;void 0");
  await pause(120);
  assert.ok(await read("document.querySelector('.window-frame').getBoundingClientRect().top===0 && document.querySelector('.desktop-library').getBoundingClientRect().top<2"));
  fs.writeFileSync(path.join(project, 'tmp/conversation-glass-scrolled.png'), (await win.webContents.capturePage()).toPNG());
  win.setContentSize(1400, 800);
  await read("document.querySelector('.desktop-library').scrollTop=0;void 0");
  await click('.recent-bar-list');
  await visible('.recent-turn-text');
  assert.equal(await read("document.querySelectorAll('.recent-turn-text').length"), 20, 'only the tail page is loaded initially');
  assert.equal(await read("document.querySelector('.recent-turn-text').textContent"), examples.get(45)[0]);
  await visible('[data-desktop-page="overview"]');
  await wait(() => read("document.querySelector('.recent-tile img')?.naturalWidth > 0"), 'real image thumbnail');
  fs.writeFileSync(path.join(project, 'tmp/recent-conversation-drawer.png'), (await win.webContents.capturePage()).toPNG());
  await click('.recent-turn-more');
  await wait(() => read("document.querySelectorAll('.recent-turn-text').length === 40"), 'previous page');
  const targetId = await read("Array.from(document.querySelectorAll('.recent-turn-scroll li button')).find(b => b.querySelector('.recent-turn-text').textContent === '评审方案 9').dataset.turnMessage");
  await click('[data-turn-message="' + targetId + '"]');
  const offset = () => read("(() => { const t=document.querySelector('[data-message-id=\"" + targetId + "\"]'); return t?.checkVisibility() ? t.getBoundingClientRect().top - t.closest('.message-list').getBoundingClientRect().top : null; })()");
  await wait(async () => { const value = await offset(); return typeof value === 'number' && value >= -3 && value < 80; }, 'selected older turn visible').catch(async error => {
    const details = await read("({page:document.querySelector('[data-desktop-page]')?.dataset.desktopPage,title:document.querySelector('.topbar h1')?.textContent,scroll:document.querySelector('.message-list')?.scrollTop,first:document.querySelector('[data-message-role=user]')?.dataset.messageId,rows:document.querySelectorAll('[data-message-role=user]').length,focus:document.activeElement?.className})");
    throw new Error(JSON.stringify({ targetId, offset: await offset(), ...details }), { cause: error });
  });
  await pause(300);
  assert.ok(Math.abs((await offset()) - 16) < 30, 'the target stays in view after layout settles');
  await click('[data-nav-section=explore]');
  await click('.recent-bar-list');
  await visible('[data-desktop-page=explore]');
  await visible('.recent-turn-text');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await wait(() => read("!document.querySelector('.recent-turn-drawer:popover-open')"), 'dismiss with Escape');
  await click('.recent-bar-chat');
  await visible('[data-message-id="' + targetId + '"]');
  await click('[data-recent-step=' + direction + ']');
  await wait(async () => await title() !== '设计评审记录', 'in chat, transport switches the active conversation');
  const otherTitle = await title();
  await wait(() => read("Array.from(document.querySelectorAll('.main-stage .topbar h1')).some(h => h.checkVisibility() && h.textContent === " + JSON.stringify(otherTitle) + ")"), 'the conversation and title bar agree').catch(async cause => {
    throw Error('Expected ' + otherTitle + ', got ' + await read("Array.from(document.querySelectorAll('.topbar h1')).map(h=>h.textContent).join(', ')"), {cause});
  });
  await click('[data-recent-step=' + (direction === 'previous' ? 'next' : 'previous') + ']');
  await wait(async () => await title() === '设计评审记录', 'return to the original conversation');
  // Browsing another session does not change the page or register it as visited.
  await click('[data-nav-section=home]');
  assert.equal(await read("document.querySelectorAll('.sidebar .conversation-row').length"), 0);
  await click('.recent-bar-list'); await click('[data-recent-tab=sessions]');
  await visible('[data-recent-session=local-earlier]');
  assert.equal(await read("document.querySelectorAll('[data-recent-session]').length"), 3);
  await click('[data-recent-session=local-empty]');
  await visible('[data-desktop-page=overview]');
  await wait(() => read("!!document.querySelector('.recent-turn-scroll p:not([role])')"), 'empty chat has no turns');
  assert.equal(await read("document.querySelector('.recent-chat-copy strong').textContent"), '设计评审记录');
  await click('[data-recent-tab=sessions]');
  const earlierRow = '[data-recent-session=local-earlier]';
  await visible(earlierRow);
  await read("document.querySelector('[data-recent-session=local-earlier]').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:1010,clientY:150}));void 0");
  await click('[data-sidebar-menu-item=pin]');
  await visible('.sidebar .conversation-row .conversation-title');
  await click(earlierRow);
  await visible('[data-desktop-page=overview]');
  await click('[data-turn-message=other-user]');
  await visible('[data-message-id=other-user]');
  await wait(() => read("document.querySelector('.recent-chat-copy strong')?.textContent === 'Earlier conversation'"), 'last visit overrides background activity');
  await click('[data-nav-section=home]');
  win.webContents.reload();
  await visible('[data-desktop-page="overview"]');
  await wait(() => read("document.querySelector('.recent-chat-copy strong')?.textContent === 'Earlier conversation'"), 'last visit survives reload');
  win.setSize(480, 650); await pause(200); assert.ok(await bounds(), 'toolbar controls fit at minimum width');
  win.setSize(590, 650);
  await click('.recent-bar-list');
  await visible('[data-turn-message=other-user]');
  assert.ok(await read("(() => {const p=document.querySelector('.recent-turn-drawer').getBoundingClientRect();const a=document.querySelector('.recent-bar-chat').getBoundingClientRect(),b=document.querySelector('.recent-bar-list').getBoundingClientRect();return p.left>=0 && p.right<=innerWidth && a.width>0 && a.right<=b.left})()"));
  await click('.recent-bar-list');
  await read("localStorage.setItem('cardbush_archived_conversation_ids',JSON.stringify(['local-earlier']));window.dispatchEvent(new Event('cardbush-conversation-archives-changed'));void 0");
  await wait(() => read("document.querySelector('.recent-chat-copy strong')?.textContent === '设计评审记录'"), 'archived and hidden sessions are excluded');
  console.log('Recent conversation navigation passed: Home and Explore, paging and exact turn, resume, Escape, reload, empty state, archive and narrow layout.');
  app.quit();
}
