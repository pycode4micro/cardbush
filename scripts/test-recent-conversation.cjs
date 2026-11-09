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
  // Match the desktop launcher: Windows may suppress the first show of a child started with SW_HIDE.
  const result = require('node:child_process').spawnSync(electron, [__filename, root, ...process.argv.slice(2)], { cwd: project, env, windowsHide: false, stdio: 'inherit', timeout: 100000 });
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
  const materialTest = process.argv.includes('--sidebar-material');
  if (materialTest) require('./helpers/sidebar-material.cjs').seedWallpaper(root);
  const journal = new FileSessionEventPersistence({ root: path.join(root, 'runtime-state', 'sessions') });
  const store = new SessionStore({ persistence: journal });
  const { ConversationJournal } = await import('../packages/bush-runtime/dist/conversationJournal.js');
  const { PERSONAL_ASSISTANT_SESSION } = await import('@cardbush/bush-protocol');
  const assistantJournal = new ConversationJournal(path.join(root, 'runtime-state', 'conversation-journal'));
  for (const [id, role, source, visibility] of [
    ['assistant-question', 'user', 'page', 'conversation'],
    ['assistant-answer', 'assistant', 'text', 'conversation'],
    ['assistant-private', 'user', 'text', 'internal'],
    ['assistant-call', 'user', 'voice', 'conversation'],
  ]) assistantJournal.append(PERSONAL_ASSISTANT_SESSION, {
    id, content: role === 'assistant' ? Array(90).fill(id).join('\n\n') : id, role, source, visibility, createdAt: new Date().toISOString(),
  });
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
  // Hold real runtime replies until the workspace is mounted, including on fast machines.
  let releaseData;
  const dataGate = new Promise(resolve => { releaseData = resolve; });
  const { ipcMain } = electron;
  const register = ipcMain.handle;
  let requested = false;
  ipcMain.handle = function(channel, handler) {
    if (channel !== 'bush-runtime:command') return register.call(this, channel, handler);
    ipcMain.handle = register;
    return register.call(this, channel, async (...args) => {
      requested = true;
      await dataGate;
      return handler(...args);
    });
  };
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
  await wait(() => requested, 'runtime request held');
  await read('document.fonts.ready.then(() => true)');
  await pause(300);
  const positions = () => read(`Array.from(document.querySelectorAll('.recent-bar-chat,.recent-bar-list,.desktop-covers > *'), el => {
    const r=el.getBoundingClientRect();return [r.x,r.y,r.width,r.height].map(Math.round);
  })`);
  assert.ok(await read("!!document.querySelector('.recent-bar-chat:disabled') && !!document.querySelector('.recent-bar-list:enabled')"));
  assert.equal(await read("document.querySelectorAll('.desktop-covers > *').length"), 4);
  assert.ok(await read("!!document.querySelector('.desktop-covers[aria-busy=true]')"));
  await wait(() => win.isVisible(), 'native window visible before data arrives');
  assert.equal(await read("getComputedStyle(document.querySelector('#cardbush-startup-splash')).display"), 'none');
  const initialPositions = await positions();
  fs.writeFileSync(path.join(project, 'tmp/workspace-awaiting-data.png'), (await win.webContents.capturePage()).toPNG());
  releaseData();
  await wait(() => read("document.querySelector('.recent-chat-copy strong')?.textContent === '设计评审记录' && !!document.querySelector('.desktop-covers[aria-busy=false]')"), 'conversation and events arrived');
  assert.deepEqual(await positions(), initialPositions, 'real data fills the initial toolbar and card slots without reflow');
  if (process.argv.includes('--home-components')) {
    await require('./helpers/home-component-publish.cjs')({root,project,win,read,visible,click,wait});
    app.quit(); return;
  }
  if (materialTest) {
    await click('.recent-bar-chat');
    await visible('.chat-panel[role=region] .message-list');
    await require('./helpers/sidebar-material.cjs').inspect({ win, read, click, wait, pause, project });
    app.quit();
    return;
  }
  assert.equal(await read("document.querySelector('.recent-chat-copy strong').textContent"), '设计评审记录');
  assert.equal(await read("document.querySelector('.recent-chat-copy').textContent"), '设计评审记录', 'the title bar omits assistant output');
  assert.equal(await read("Boolean(document.querySelector('.recent-turn-scroll'))"), false);
  assert.deepEqual(await read("Array.from(document.querySelectorAll('.window-frame [data-nav-section]'), el => el.dataset.navSection)"), ['chat','projects','assistant'], 'new chat and Assistant live in the title bar');
  assert.equal(await read("!!document.querySelector('.sidebar :is([data-nav-section=chat],[data-nav-section=assistant])')"), false);
  assert.equal(await read("document.querySelectorAll('.recent-bar button.no-drag').length"), 5, 'home toolbar includes both navigation buttons, the title and the list');
  const bounds = () => read("Array.from(document.querySelectorAll('.recent-bar button.no-drag')).every(button => {const r=button.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.width>=24;})");
  assert.ok(await bounds());
  fs.writeFileSync(path.join(project, 'tmp/conversation-glass-bar.png'), (await win.webContents.capturePage()).toPNG());
  win.setContentSize(1400, 600); await pause(180);
  await read("document.querySelector('.desktop-library').scrollTop=270;void 0");
  await pause(120);
  assert.ok(await read("document.querySelector('.window-frame').getBoundingClientRect().top===0 && document.querySelector('.desktop-library').getBoundingClientRect().top<2"));
  fs.writeFileSync(path.join(project, 'tmp/conversation-glass-scrolled.png'), (await win.webContents.capturePage()).toPNG());
  win.setContentSize(1160, 620);
  await visible('.desktop-shell[data-sidebar-layout=drawer].sidebar-is-collapsed');
  await read("document.querySelector('.desktop-library').scrollTop=260;void 0");
  await pause(350);
  const captureMaterial = async name => fs.writeFileSync(path.join(project, 'tmp', 'workspace-material-' + name + '.png'),
    (await win.webContents.capturePage()).toPNG());
  assert.equal(await read("document.querySelector('.recent-bar-chat img') === null"), true, 'the title bar contains only the title');
  await captureMaterial('toolbar');
  await click('.window-sidebar-toggle');
  await wait(() => read("document.querySelector('.sidebar').getBoundingClientRect().width>265"), 'expanded navigation is over the artwork');
  await pause(350);
  await captureMaterial('sidebar');
  const material = () => read("({bar:getComputedStyle(document.querySelector('.window-frame'),'::before').backdropFilter, drawer:getComputedStyle(document.querySelector('.sidebar')).backdropFilter})");
  if (!await read("matchMedia('(prefers-reduced-transparency: reduce), (forced-colors: active)').matches")) {
    const glass = await material();
    assert.match(glass.bar, /blur\(/);
    assert.match(glass.drawer, /blur\(/);
    const continuous = await read(`(() => {
      const color = selector => getComputedStyle(document.querySelector(selector)).backgroundColor;
      const stage = color('.main-stage'), library = color('.desktop-library');
      return stage === color('.desktop-shell') && (library === stage || library === 'rgba(0, 0, 0, 0)');
    })()`);
    assert.ok(continuous, 'drawer blur has a continuous backing across the rail');
    assert.equal(await read("!!document.querySelector('.recent-art-tint')"), false, 'only page content contributes to the header backdrop');
  }
  win.webContents.debugger.attach('1.3');
  try {
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{name:'prefers-reduced-transparency',value:'reduce'}],
    });
    await wait(() => read("matchMedia('(prefers-reduced-transparency: reduce)').matches"), 'reduced transparency');
    assert.deepEqual(await material(), {bar:'none',drawer:'none'});
  } finally { win.webContents.debugger.detach(); }
  await click('.window-sidebar-toggle');
  win.setContentSize(1180, 760);
  await read("document.querySelector('.desktop-library').scrollTop=0;void 0");
  await require('./helpers/recent-featured-shelf.cjs')({win, read, wait, visible, project});
  win.setContentSize(1400, 800);
  await click('.recent-bar-list');
  await visible('[data-recent-tab=pinned][aria-selected=true]');
  await click('[data-recent-tab=sessions]'); await click('[data-recent-session=local-navigation-test]');
  await visible('.recent-turn-text');
  assert.equal(await read("document.querySelectorAll('.recent-turn-text').length"), 20, 'only the tail page is loaded initially');
  assert.equal(await read("document.querySelector('.recent-turn-text').textContent"), examples.get(45)[0]);
  await visible('[data-desktop-page="overview"]');
  await wait(() => read("document.querySelector('.recent-turn-attachment')?.naturalWidth > 0"), 'user attachment thumbnail');
  assert.equal(await read("document.querySelector('[data-turn-message]').firstElementChild.classList.contains('recent-turn-text')"), true);
  assert.ok(!(await read("document.querySelector('.recent-turn-scroll').textContent")).includes(examples.get(45)[1]), 'turn list omits assistant replies');
  assert.equal(await read("document.querySelector('.recent-bar-chat img') === null"), true, 'turn thumbnails stay in the turn list');
  fs.writeFileSync(path.join(project, 'tmp/recent-conversation-drawer.png'), (await win.webContents.capturePage()).toPNG());
  await click('.recent-turn-more');
  await wait(() => read("document.querySelectorAll('.recent-turn-text').length === 40"), 'previous page');
  const targetId = await read("Array.from(document.querySelectorAll('.recent-turn-scroll li button')).find(b => b.querySelector('.recent-turn-text').textContent === '评审方案 9').dataset.turnMessage");
  await click('[data-turn-message="' + targetId + '"]');
  const offset = () => read("(() => { const t=document.querySelector('[data-message-id=\"" + targetId + "\"]'); return t?.checkVisibility() ? t.getBoundingClientRect().top - t.closest('.message-list').getBoundingClientRect().top : null; })()");
  await wait(async () => { const value = await offset(); return typeof value === 'number' && value >= -3 && value < 80; }, 'selected older turn visible').catch(async error => {
    const details = await read("({page:document.querySelector('[data-desktop-page]')?.dataset.desktopPage,title:document.querySelector('.recent-chat-copy strong')?.textContent,scroll:document.querySelector('.message-list')?.scrollTop,first:document.querySelector('[data-message-role=user]')?.dataset.messageId,rows:document.querySelectorAll('[data-message-role=user]').length,focus:document.activeElement?.className})");
    throw new Error(JSON.stringify({ targetId, offset: await offset(), ...details }), { cause: error });
  });
  await pause(300);
  assert.ok(Math.abs((await offset()) - 16) < 30, 'the target stays in view after layout settles');
  await visible('.main-stage .chat-panel[role=region]');
  assert.equal(await read("!!document.querySelector('.main-stage .chat-panel[role=region] > .topbar')"), false, 'the transcript starts directly below the window toolbar');
  const summary = '.window-frame [data-work-summary-toggle]', inspector = '.window-frame [data-inspector-toggle]';
  const toolbarFits = () => read(`(() => {
    const bounds = selector => document.querySelector(selector)?.getBoundingClientRect();
    const summary = bounds('.window-frame [data-work-summary-toggle]');
    const inspector = bounds('.window-frame [data-inspector-toggle]');
    const list = bounds('.recent-bar-list');
    const title = bounds('.recent-bar-chat');
    const bar = bounds('.recent-bar');
    if (!title?.width || !summary?.width || !inspector?.width || !list?.width) return false;
    const topGap = title.top - bar.top, bottomGap = bar.bottom - title.bottom;
    if (Math.min(topGap, bottomGap) < 7.5 || Math.abs(topGap - bottomGap) > 1) return false;
    const projects = bounds('.window-frame [data-nav-section=projects]');
    const newChat = bounds('.window-frame [data-nav-section=chat]');
    const assistant = bounds('.window-frame [data-nav-section=assistant]');
    const shortcuts = [...document.querySelectorAll('.workspace-chat-navigation button')];
    if (shortcuts.length !== 3 || shortcuts.some(button =>
      button.textContent.trim() || !button.getAttribute('aria-label') || !button.querySelector('svg,img'))) return false;
    if (!newChat || !assistant || newChat.width < 24 || assistant.width < 24 || newChat.left < bar.left - 1 ||
        newChat.right > projects.left + 1 || projects.right > assistant.left + 1 || assistant.right > title.left + 1 || title.right > summary.left + 1) return false;
    const actions = [...document.querySelectorAll('.recent-bar-actions button')]
      .map(button => button.getBoundingClientRect()).filter(rect => rect.width > 0);
    if (!actions.length || Math.abs((title.left - assistant.right) - (actions[0].left - title.right)) > 1) return false;
    const buttonGaps = [projects.left - newChat.right, assistant.left - projects.right,
      ...actions.slice(1).map((rect, i) => rect.left - actions[i].right)];
    if (Math.min(...buttonGaps) <= 0 || Math.max(...buttonGaps) - Math.min(...buttonGaps) > 1) return false;
    const centerY = rect => rect.top + rect.height / 2;
    return summary.right <= inspector.left + 1 && inspector.right <= list.left + 1 &&
      Math.abs(centerY(inspector) - centerY(list)) < 2 && list.right <= innerWidth;
  })()`);
  assert.ok(await toolbarFits(), 'summary and inspector sit immediately before the list');
  await click(summary);
  await visible('.conversation-work-summary');
  await click(summary);
  await click(inspector);
  await visible('.right-inspector');
  await wait(() => read("document.querySelector('.window-frame [data-inspector-toggle]')?.getAttribute('aria-expanded') === 'true'"), 'title bar controls the real inspector');
  await click(inspector);
  win.maximize();
  await wait(() => win.isMaximized() && read('innerWidth === ' + win.getContentSize()[0]), 'native window maximized');
  await wait(toolbarFits, 'matching gaps on both sides of the title and between icons when maximized');
  win.unmaximize();
  await wait(() => !win.isMaximized() && read('innerWidth === ' + win.getContentSize()[0]), 'native window restored');
  await wait(toolbarFits, 'matching title and icon spacing after restoring the window');
  for (const width of [1180, 900, 640, 480]) {
    win.setContentSize(width, 720);
    await wait(() => read('innerWidth === ' + width), 'chat window resized to ' + width);
    await wait(toolbarFits, 'chat controls fit at ' + width + ' pixels');
  }
  const checkChatMargins = async (label, selector) => {
    const chat = '.main-stage > .chat-panel[role=region]';
    await visible(chat + ' .composer-surface');
    await wait(() => read("document.querySelector('.sidebar').getAnimations().every(animation => animation.playState !== 'running')"), 'sidebar settles');
    const sample = () => read(`(() => {
      const rail = document.querySelector('.sidebar').getBoundingClientRect();
      const stage = document.querySelector('.main-stage').getBoundingClientRect();
      return Array.from(document.querySelector(${JSON.stringify(chat)}).querySelectorAll(${JSON.stringify(selector)}), el => {
        const rect = el.getBoundingClientRect();
        return {element: el.className, width: rect.width, left: rect.left - rail.right, right: stage.right - rect.right};
      }).filter(box => box.width > 0);
    })()`);
    const centered = boxes => boxes.every(box => box.left >= 0 && Math.abs(box.left - box.right) < 2);
    const margins = await wait(async () => {
      const boxes = await sample();
      return boxes.length && centered(boxes) && boxes[0];
    }, label).catch(async error => { throw Error(label + ': ' + JSON.stringify((await sample()).slice(-5)), {cause: error}); });
    console.log(label, margins);
  };
  win.setContentSize(1180, 760);
  await visible('.desktop-shell[data-sidebar-layout=drawer].sidebar-is-collapsed');
  await checkChatMargins('Transcript centers beside the rail', '.composer-surface,.message-row');
  await click('.window-sidebar-toggle');
  await wait(() => read("document.querySelector('.sidebar').getBoundingClientRect().width > 240"), 'chat drawer opens');
  await checkChatMargins('Transcript centers beside the expanded drawer', '.composer-surface,.message-row');
  await click('.window-sidebar-toggle');
  win.setContentSize(1160, 740);
  await pause(400);
  fs.writeFileSync(path.join(project, 'tmp/chat-titlebar-actions.png'), (await win.webContents.capturePage()).toPNG());
  win.setContentSize(1400, 800);
  await click('[data-nav-section=assistant]');
  await visible('.assistant-view:not([hidden]) [data-message-id=assistant-question]');
  assert.equal(await read("document.querySelector('.window-frame [data-nav-section=assistant]').getAttribute('aria-current')"), 'page');
  const titleText = () => read("document.querySelector('.recent-chat-copy strong').textContent");
  assert.equal(await titleText(), 'assistant');
  assert.equal(await read("!!document.querySelector('.assistant-view > .topbar')"), false, 'Assistant has a single desktop title bar');
  await visible('.window-chat-actions [data-manage-hosts]');
  await click(summary); await visible('.assistant-view .conversation-work-summary'); await click(summary);
  await click(inspector); await visible('.right-inspector'); await click(inspector);
  await read("document.querySelector('[data-nav-section=assistant]').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, clientX:72, clientY:120}));void 0");
  await click('[data-sidebar-menu-item=assistant-rename]');
  await visible('.assistant-rename-dialog:modal');
  const customName = 'Nova · Atlas '.repeat(4).trim();
  await win.webContents.insertText(customName);
  await click('.assistant-rename-dialog button[type=submit]');
  await wait(async () => await titleText() === customName, 'rename updates the window title immediately and preserves the full name');
  win.setContentSize(480, 720);
  await wait(toolbarFits, 'Assistant actions fit beside a long name in a narrow window');
  assert.ok(await read("document.querySelector('.recent-bar-chat').getBoundingClientRect().right <= document.querySelector('.window-chat-actions [data-manage-hosts]').getBoundingClientRect().left"));
  await click('.recent-bar-chat'); await visible('.assistant-view:not([hidden])');
  await click('.recent-bar-list'); await click('[data-recent-tab=sessions]'); await click('[data-recent-session=personal-assistant]'); await visible('[data-turn-message=assistant-question]');
  assert.equal(await read("document.querySelector('.recent-turn-drawer h2').textContent"), customName);
  assert.deepEqual(await read("Array.from(document.querySelectorAll('[data-turn-message]'), row => row.dataset.turnMessage)"), ['assistant-question']);
  await click('[data-turn-message=assistant-question]');
  await visible('.assistant-view [data-message-id=assistant-question] [data-quote-highlight=true]');
  win.setContentSize(1400, 800);
  await wait(() => read("innerWidth === 1400 && document.activeElement.closest('[data-message-id]')?.dataset.messageId === 'assistant-question' && document.querySelector('.assistant-messages').scrollTop < 8"), 'selected Assistant turn keeps its reading position after resize');
  await click('[data-nav-section=explore]');
  assert.equal(await read("!!document.querySelector('.window-chat-actions')"), false, 'chat-only controls leave with the conversation');
  assert.equal(await titleText(), '设计评审记录', 'visiting Assistant preserves the last ordinary conversation');
  await click('.recent-bar-list');
  await visible('[data-desktop-page=explore]');
  await visible('[data-recent-tab=pinned][aria-selected=true]');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await wait(() => read("!document.querySelector('.recent-turn-drawer:popover-open')"), 'dismiss with Escape');
  await click('.recent-bar-chat');
  await visible('[data-message-id="' + targetId + '"]');
  assert.equal(await read("document.querySelector('.main-stage .chat-panel[role=region]').getAttribute('aria-label')"), await read("document.querySelector('.recent-chat-copy strong').textContent"), 'the active chat and title agree');
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
  await require('./helpers/recent-session-menu.cjs')({win, read, wait, visible, click, row: earlierRow});
  await click('[data-recent-tab=pinned]');
  await visible(earlierRow);
  assert.equal(await read("document.querySelector('.sidebar .conversation-row') === null"), true);
  await click('[data-recent-tab=sessions]');
  await click(earlierRow);
  await visible('[data-desktop-page=overview]');
  await click('[data-turn-message=other-user]');
  await visible('[data-message-id=other-user]');
  await wait(() => read("document.querySelector('.recent-chat-copy strong')?.textContent === 'Earlier conversation'"), 'last visit overrides background activity');
  await click('[data-nav-section=home]');
  await read("localStorage.setItem('cardbush_projects',JSON.stringify([{id:'fixture-project', rootPath:"+JSON.stringify(root)+",title:'Pinned project',pinned:true}]));void 0");
  win.webContents.reload();
  await visible('[data-desktop-page="overview"]');
  await wait(() => read("document.querySelector('.recent-chat-copy strong')?.textContent === 'Earlier conversation'"), 'last visit survives reload');
  await click('.recent-bar-list');
  await visible('[data-recent-tab=pinned][aria-selected=true]');
  await visible('.recent-session-rows [data-workspace-drop=fixture-project]');
  await click('[data-recent-session=local-earlier]');
  await visible('[data-message-id=other-user]');
  await click('[data-nav-section=home]');
  win.setSize(480, 650); await pause(200); assert.ok(await bounds(), 'toolbar controls fit at minimum width');
  win.setSize(590, 650);
  await click('.recent-bar-list'); await click('[data-recent-tab=sessions]'); await click('[data-recent-session=local-earlier]');
  await visible('[data-turn-message=other-user]');
  await wait(() => read("(() => {const p=document.querySelector('.recent-turn-drawer').getBoundingClientRect();const a=document.querySelector('.recent-bar-chat').getBoundingClientRect(),b=document.querySelector('.recent-bar-list').getBoundingClientRect();return p.left>=0 && p.right<=innerWidth && a.width>0 && a.right<=b.left})()"), 'the open drawer settles within the narrow viewport');
  await click('.recent-bar-list');
  await read("localStorage.setItem('cardbush_archived_conversation_ids',JSON.stringify(['local-earlier']));window.dispatchEvent(new Event('cardbush-conversation-archives-changed'));void 0");
  await wait(() => read("document.querySelector('.recent-chat-copy strong')?.textContent === '设计评审记录'"), 'archived and hidden sessions are excluded');
  win.setContentSize(1084, 760);
  await pause(300);
  await read("window.pageEntrances=[];document.addEventListener('animationstart',event=>{if(event.animationName==='workspace-page-entrance') pageEntrances.push(event.target.className)});void 0");
  await click('[data-nav-section=explore]');
  await visible('[data-desktop-page=explore]');
  await wait(()=>read("pageEntrances.includes('main-stage')"),'Explore enters with the Windows page transition');
  assert.ok(await read("document.querySelector('.desktop-explore > h1')?.nextElementSibling?.matches('.desktop-filter')"),'Explore has a title followed directly by search');
  assert.equal(await read("!!document.querySelector('.desktop-explore button[aria-haspopup=dialog]')"),false,'no app management button on Explore');
  assert.equal(await read("!!document.querySelector('.desktop-menu-toggle')"),false);
  await wait(() => read("(()=>{const r=document.querySelector('.recent-bar-chat').getBoundingClientRect();return Math.abs((r.left+r.right)/2-innerWidth/2)<9})()"),'compact-rail summary is centered in the window').catch(async error => {
    const rects = await read("Object.fromEntries(['.window-navigation','.recent-bar','.workspace-chat-navigation','.recent-bar-chat','.recent-bar-actions'].map(selector=>[selector,document.querySelector(selector).getBoundingClientRect().toJSON()]))");
    throw Error('Title alignment: '+JSON.stringify(rects),{cause:error});
  });
  await click('.window-sidebar-toggle'); await visible('.desktop-menu-toggle');
  await pause(300);
  assert.ok(await read("document.querySelector('.desktop-menu-toggle').getBoundingClientRect().right <= document.querySelector('.sidebar').getBoundingClientRect().right+1"),'menu remains within the expanded sidebar');
  await click('.desktop-menu-toggle');
  await click('[data-menu-item=file]');
  await click('[data-menu-item=applications]');
  await click('[data-menu-item=manageApps]');
  await visible('.app-center-drawer:modal');
  await click('.app-center-content>header button:last-child.app-center-icon');
  await wait(()=>read("!document.querySelector('.app-center-drawer')"),'manager dismissed');
  await click('.window-sidebar-toggle'); await pause(300);
  fs.writeFileSync(path.join(project,'tmp','explore-titlebar-alignment.png'),(await win.webContents.capturePage()).toPNG());
  await click('.sidebar-footer .profile-trigger');
  await click('.profile-popover:popover-open [data-profile-action=settings]');
  await visible('.settings-directory');
  await wait(()=>read("pageEntrances.includes('settings-track')"),'opening settings animates the retained page');
  await read('pageEntrances.length=0;void 0');
  await click('[data-settings-target=preferences]');
  await wait(()=>read("pageEntrances.includes('settings-track')"),'entering a category animates its contents');
  await pause(300); await read('pageEntrances.length=0;void 0');
  await click('[data-settings-section=notifications]'); await pause(100);
  assert.deepEqual(await read("Array.from(document.querySelectorAll('[data-settings-section][aria-expanded=true]'), node=>node.dataset.settingsSection)"), ['notifications']);
  assert.deepEqual(await read('pageEntrances'),[],'editing or disclosing settings does not replay navigation');
  win.webContents.debugger.attach('1.3');
  try {
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await click('[data-nav-section=home]'); await visible('[data-desktop-page=overview]'); await pause(300);
    assert.deepEqual(await read('pageEntrances'),[], 'reduced motion skips the transition');
  } finally { win.webContents.debugger.detach(); }
  await read("localStorage.setItem('cardbush_archived_conversation_ids',JSON.stringify(['local-navigation-test','local-earlier','local-empty']));window.dispatchEvent(new Event('cardbush-conversation-archives-changed'));void 0");
  await click('[data-nav-section=chat]');
  await visible(inspector);
  assert.equal(await read("!!document.querySelector('.recent-bar-chat:disabled') && !!document.querySelector('.recent-bar-list:enabled')"), true, 'empty history keeps the controls in place and the inspector available');
  await click(inspector);
  await visible('.right-inspector');
  await click(inspector);
  win.setContentSize(1180, 760);
  await visible('.new-chat-input .composer-surface');
  await visible('.desktop-shell[data-sidebar-layout=drawer].sidebar-is-collapsed');
  await checkChatMargins('Welcome input centers beside the rail', '.new-chat-input .composer-surface');
  await click('.window-sidebar-toggle');
  await wait(() => read("document.querySelector('.sidebar').getBoundingClientRect().width > 240"), 'welcome drawer opens');
  await checkChatMargins('Welcome input centers beside the expanded drawer', '.new-chat-input .composer-surface');
  await click('[data-nav-section=assistant]');
  await visible('.recent-bar-chat:enabled');
  assert.equal(await titleText(), customName, 'Assistant keeps its saved name after reload even with no ordinary chats');
  await click('.recent-bar-list'); await click('[data-recent-tab=sessions]'); await click('[data-recent-session=personal-assistant]'); await visible('[data-turn-message=assistant-question]');
  await click('.recent-bar-list');
  win.setContentSize(480, 700);
  await wait(() => read('innerWidth === 480'), 'narrow workspace');
  await click('.window-sidebar-toggle');
  await visible('.desktop-shell[data-sidebar-layout=drawer]:not(.sidebar-is-collapsed)');
  await wait(() => read("['chat','projects','assistant'].every(section => { const b = document.querySelector('.window-frame [data-nav-section='+section+']'); const r = b.getBoundingClientRect(); return r.width>=24 && b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)); })"), 'both title bar buttons remain reachable above the open sidebar');
  await click('.window-frame [data-nav-section=chat]');
  await visible('.desktop-shell.sidebar-is-collapsed .new-chat-input .composer-surface');
  await click('.window-frame [data-nav-section=projects]');
  await visible('[data-desktop-page=projects] .project-list-actions');
  await visible('[data-desktop-page=projects] [data-workspace-drop=fixture-project] .project-row');
  await click('.sidebar [data-nav-section=tabs]');
  await visible('.desktop-shell.inspector-covered .right-inspector-tab-page.active');
  const tab = await read("document.querySelector('.right-inspector-tab-page.active').getAttribute('data-inspector-page-id')");
  await click('.sidebar [data-nav-section=tabs]');
  await wait(() => read("!document.querySelector('.desktop-shell.inspector-covered')"), 'return from tab workspace');
  await visible('[data-desktop-page=projects]');
  assert.ok(tab);
  await click('.sidebar [data-nav-section=tabs]');
  await visible('.desktop-shell.inspector-covered .right-inspector-tab-page.active');
  assert.equal(await read("document.querySelector('.right-inspector-tab-page.active').getAttribute('data-inspector-page-id')"), tab);
  console.log('Workspace navigation passed: compact rail and caption alignment, Explore without a management button, section/category entrance and reduced motion.');
  console.log('Recent conversation navigation passed: Home and Explore, paging and exact turn, resume, Escape, reload, empty state, archive and narrow layout.');
  app.quit();
}
