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
  const inboxTest = process.argv.includes('--notifications');
  if (inboxTest) require('./helpers/workspace-inbox.cjs').seed(root, sessionId);
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
  const read = code => win.webContents.executeJavaScript(code, true);
  const visible = selector => wait(() => read('Boolean(document.querySelector(' + JSON.stringify(selector) + ')?.checkVisibility())'), selector);
  const click = async selector => { await visible(selector); await read('document.querySelector(' + JSON.stringify(selector) + ').click();void 0'); };
  await visible('[data-desktop-page="overview"]');
  const quick = '.recent-bar-list';
  const drawer = '.recent-turn-drawer:popover-open';
  const showQuickPanel = async () => {
    if (!await read("!!document.querySelector('.recent-turn-drawer:popover-open')")) {
      await read("document.querySelector('.recent-bar-list').focus({preventScroll:true})");
      win.webContents.sendInputEvent({type:'keyDown', keyCode:'Down'});
      win.webContents.sendInputEvent({type:'keyUp', keyCode:'Down'});
    }
    await visible(drawer);
    await wait(() => read("document.querySelector('.recent-turn-drawer:popover-open')?.getAnimations().length === 0"), 'Quick access has settled');
  };
  await visible(quick);
  const enterChatFromList = async id => {
    await showQuickPanel(); await click('[data-recent-tab=sessions]'); await click('[data-recent-session='+id+']');
  };
  await wait(() => requested, 'runtime request held');
  await read('document.fonts.ready.then(() => true)');
  await pause(300);
  const positions = () => read(`Array.from(document.querySelectorAll('.recent-bar-list,.desktop-covers > *'), el => {
    const r=el.getBoundingClientRect();return [r.x,r.y,r.width,r.height].map(Math.round);
  })`);
  assert.ok(await read("!!document.querySelector('.recent-bar-list:enabled') && !document.querySelector('.window-frame .recent-bar-chat,.window-frame .recent-bar-list')"));
  assert.equal(await read("document.querySelectorAll('.desktop-covers > *').length"), 4);
  assert.ok(await read("!!document.querySelector('.desktop-covers[aria-busy=true]')"));
  await wait(() => win.isVisible(), 'native window visible before data arrives');
  assert.equal(await read("getComputedStyle(document.querySelector('#cardbush-startup-splash')).display"), 'none');
  const initialPositions = await positions();
  fs.writeFileSync(path.join(project, 'tmp/workspace-awaiting-data.png'), (await win.webContents.capturePage()).toPNG());
  releaseData();
  await wait(() => read("!!document.querySelector('.desktop-covers[aria-busy=false]')"), 'conversation and events arrived');
  assert.deepEqual(await positions(), initialPositions, 'real data fills the initial toolbar and card slots without reflow');
  // Measure cold start at the actual launch size. A resize also changes the
  // native caption and rail breakpoint, independently of runtime hydration.
  win.setContentSize(1400, 800);
  await visible('.desktop-shell[data-sidebar-layout=docked]');
  if (process.argv.includes('--pdf-navigation')) {
    win.setContentSize(1184, 756);
    const pdf = await require('pdf-lib').PDFDocument.create();
    for (let number = 1; number <= 200; number++) pdf.addPage().drawText('Navigation fixture page ' + number);
    const filename = path.join(root, 'navigation.pdf');
    fs.writeFileSync(filename, await pdf.save());
    await enterChatFromList(sessionId);
    await visible('[data-message-id="turn-45-0"]');
    await read(`window.dispatchEvent(new CustomEvent('cardbush:open-inspector', {detail:{target:${JSON.stringify(filename)}}}));void 0`);
    const pageText = '[data-region-page="1"]:not([data-region-loading]) .pdf-region-text span';
    await wait(() => read('!!document.querySelector(' + JSON.stringify(pageText) + ')'), 'PDF first page painted');
    await wait(() => read("!document.querySelector('.right-inspector').getAnimations().length"), 'manual sidebar entrance settled');
    const splitWidth = await read("document.querySelector('.right-inspector').offsetWidth");
    await read('window.originalPageText=document.querySelector(' + JSON.stringify(pageText) + ');void 0');
    for (const viaList of [false, true]) {
      await click('.sidebar-footer [data-nav-section=assistant]');
      await visible('[data-page=assistant]');
      if (viaList) { await showQuickPanel(); await click('[data-recent-tab=sessions]'); }
      const entry = viaList ? '[data-recent-session=local-navigation-test]' : quick;
      const firstFrame = await read(`new Promise(resolve => {
        document.querySelector(${JSON.stringify(entry)}).click();
        requestAnimationFrame(() => resolve({
          chat: !!document.querySelector('.chat-panel [data-message-id="turn-45-0"]'),
          width: document.querySelector('.right-inspector').offsetWidth,
          samePage: document.querySelector(${JSON.stringify(pageText)}) === originalPageText,
        }));
      })`);
      assert.deepEqual(firstFrame, {chat:true, width:splitWidth, samePage:true}, 'return paints chat and its existing PDF together');
    }
    assert.equal(await read("!!document.querySelector('[data-message-id=\"turn-41-0\"]')"), false);
    await click('.conversation-history-paging button');
    await visible('[data-message-id="turn-41-0"]');
    console.log('Fast and recent list both restore the PDF split on the first frame; earlier turns remain available.');
    app.quit(); return;
  }
  if (inboxTest) {
    await require('./helpers/workspace-inbox.cjs').verify({ win, read, wait, visible, click, sessionId, showQuickPanel });
    app.quit(); return;
  }
  if (process.argv.includes('--home-components')) {
    await require('./helpers/home-component-publish.cjs')({root,project,win,read,visible,click,wait});
    app.quit(); return;
  }
  if (process.argv.includes('--workspace-headings')) {
    win.setContentSize(1112, 760);
    await click('[data-nav-section=explore]');
    const toggle = '.recent-panel-header [data-inspector-toggle]';
    for (const [key, selector] of [
      ['components', '.components-app > header h1'], ['plugins', '.plugin-catalog-heading h2'],
      ['workflows', '.team-flow-header h1'], ['create', '.canvas-toolbar input'],
    ]) {
      await visible('.desktop-explore .desktop-row');
      const labels = ['zh', 'en'].map(locale => require('../src/i18n/locales/' + locale + '.json').messages['appCenterModel.' + key]);
      await read(`[...document.querySelectorAll('.desktop-explore .desktop-row')]
        .find(row => ${JSON.stringify(labels)}.includes(row.querySelector('strong').textContent)).click()`);
      await visible('.feature-panel ' + selector);
      assert.equal(await read("document.querySelector('.feature-panel .topbar') !== null"), false, key + ' has one content header');
      await showQuickPanel(); await visible(toggle);
      if (key === 'components') {
        await click(toggle);
        await showQuickPanel(); await visible(toggle + '[aria-expanded=true]');
        await click(toggle);
        await showQuickPanel(); await visible(toggle + '[aria-expanded=false]');
      }
      await click('.recent-panel-close'); await click('[data-history-action=back]:enabled');
    }
    await visible('.desktop-explore');
    console.log('Workspace headings and title bar inspector passed for all built-in feature pages.');
    app.quit(); return;
  }
  if (materialTest) {
    await enterChatFromList(sessionId);
    await visible('.chat-panel[role=region] .message-list');
    await require('./helpers/sidebar-material.cjs').inspect({ win, read, click, wait, pause, project });
    app.quit();
    return;
  }
  const checkWorkspaceNavigation = async () => {
    win.setContentSize(1400, 800);
    await visible('.desktop-shell[data-sidebar-layout=docked]');
    await click('[data-nav-section=explore]');
    await visible('.desktop-explore');
    const selected = () => read("Array.from(document.querySelectorAll('.sidebar-nav .nav-row[aria-current=page]'), b => b.dataset.navSection)");
    const tabs = '.sidebar-nav [data-nav-section=tabs]';
    await click(tabs);
    await visible('[data-page=tabs] [role=region] .right-inspector-tab-page.active');
    assert.deepEqual(await selected(), ['tabs'], 'only the full-page workspace is selected');
    const tabId = () => read("document.querySelector('.right-inspector-tab-page.active')?.dataset.inspectorPageId");
    const originalTab = await tabId();
    await click('.sidebar-more-apps');
    await click('[data-sidebar-app="builtin:plugins"]');
    await wait(() => read("(() => {const h=document.querySelector('.plugin-catalog-heading h2'); if (!h) return false; const r=h.getBoundingClientRect(); return h.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()"), 'Plugins is the visible, hit-testable page without closing the inspector');
    await click('[data-history-action=back]:enabled');
    await visible(tabs + '[aria-current=page]');
    assert.equal(await tabId(), originalTab, 'Back restores the exact tab workspace');
    await click('[data-history-action=back]:enabled');
    await visible('[data-page=explore] .desktop-explore');
    await read("window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',altKey:true,bubbles:true}));void 0");
    await visible('[data-page=tabs]');
    await click(tabs);
    await visible('.desktop-explore');
    assert.deepEqual(await selected(), ['explore'], 'closing the workspace restores its source page');
    const toggleSplit = () => read("window.dispatchEvent(new KeyboardEvent('keydown',{key:'b',ctrlKey:true,altKey:true,bubbles:true}));void 0");
    await toggleSplit();
    await visible('.desktop-shell:not(.inspector-covered) .right-inspector-tab-page.active');
    assert.deepEqual(await selected(), ['explore'], 'the right-side split keeps Explore selected');
    await click(tabs);
    await visible('[data-page=tabs]');
    assert.deepEqual(await selected(), ['tabs']);
    assert.equal(await tabId(), originalTab, 'the same tab is shown in both presentations');
    await click('.right-inspector-new-tab');
    await wait(async () => (await tabId()) !== originalTab, 'created a second tab in the workspace');
    win.setContentSize(720, 700);
    await wait(() => read('innerWidth === 720'), 'narrow workspace');
    await click('.sidebar-more-apps');
    await click('[data-sidebar-app="builtin:components"]');
    await visible('[data-page=components] .components-app');
    assert.equal(await read("document.querySelector('#right-inspector').inert"), true, 'the previous split cannot overlay a different page in a narrow window');
    await click('[data-history-action=back]:enabled');
    await visible('[data-page=tabs]');
    await click(tabs);
    await visible('[data-page=explore] .right-inspector.soft-panel-visible');
    win.setContentSize(1400, 800);
    await wait(() => read('innerWidth === 1400'), 'wide workspace restored');
    await click(tabs);
    await click('[data-nav-section=home]');
    await visible('[data-desktop-page=overview]');
    assert.deepEqual(await selected(), ['home'], 'navigating away from full-page tabs selects Home');
    const assistant = '.sidebar-footer [data-nav-section=assistant]';
    await click(assistant);
    await visible(assistant + '[aria-current=page]');
    await click(tabs);
    await visible('[data-page=tabs]');
    assert.equal(await read("document.querySelector('[data-nav-section=assistant]').hasAttribute('aria-current')"), false);
    await click(assistant);
    await visible('.assistant-view:not([hidden])');
    await visible(assistant + '[aria-current=page]');
    assert.deepEqual(await selected(), [], 'returning to Assistant clears the workspace selection');
    console.log('Tab workspace navigation passed: plugin hit testing, page history, narrow applications, retained tabs, split restoration, Home and Assistant.');
  };
  if (process.argv.includes('--workspace-selection')) {
    await checkWorkspaceNavigation();
    app.quit(); return;
  }
  assert.equal(await read("!!document.querySelector('.recent-chat-copy')"), false, 'idle Assistant has no activity title');
  assert.ok(await read("!!document.querySelector('.sidebar-footer .assistant-sprite[data-state=idle]') && !document.querySelector('.window-frame .recent-chat-copy')"), 'the Assistant entry shows its identity and activity');
  assert.equal(await read("Boolean(document.querySelector('.recent-turn-scroll'))"), false);
  assert.equal(await read("!!document.querySelector('.window-frame .assistant-stage')"), false, 'the title bar leaves the character in the sidebar');
  assert.ok(await read("document.querySelectorAll('[data-nav-section=assistant]').length===1 && !!document.querySelector('.sidebar-footer .sidebar-assistant + .profile-menu')"), 'the Assistant sits directly above the profile');
  assert.deepEqual(await read("Array.from(document.querySelectorAll('.sidebar :is([data-nav-section=chat],[data-nav-section=projects],[data-nav-section=assistant])'), b => b.dataset.navSection)"), ['chat','projects','assistant']);
  const bounds = () => read(`(() => {
    const quick=document.querySelector('.sidebar-nav .recent-bar-list'), home=document.querySelector('[data-nav-section=home]');
    const r=quick.getBoundingClientRect(), h=home.getBoundingClientRect();
    return r.width>=24 && Math.abs(r.x-h.x)<2 && r.y>=h.bottom && r.y<h.bottom+10;
  })()`);
  assert.ok(await bounds(), 'Quick access follows Home in the navigation');
  await wait(() => read("document.querySelector('.sidebar').getAnimations().every(a=>a.playState !== 'running')"), 'sidebar has settled after the startup resize');
  const point = await read("(()=>{const r=document.querySelector('.recent-bar-list').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()");
  const away = {x:820,y:135};
  const move = p => win.webContents.sendInputEvent({type:'mouseMove', ...p});
  const isOpen = () => read("document.querySelector('.recent-turn-drawer').matches(':popover-open')");
  const contentWidth = () => read("document.querySelector('.desktop-shell').getBoundingClientRect().width");
  const originalWidth = await contentWidth();
  win.focus(); win.webContents.focus();
  const rightEdge = await read("({x:innerWidth-16,y:Math.floor(innerHeight/2)})");
  move(rightEdge); await pause(550);
  assert.equal(await isOpen(), false, 'the right edge leaves the page alone');
  move(point); await pause(60); move(away); await pause(500);
  assert.equal(await isOpen(), false, 'moving past Quick does not interrupt navigation');
  move(point); await visible(drawer);
  await wait(()=>read("!document.querySelector('.recent-turn-drawer').getAnimations().length"),'Quick preview settles');
  const popup = await read("(()=>{const p=document.querySelector('.recent-turn-drawer').getBoundingClientRect(), b=document.querySelector('.recent-bar-list').getBoundingClientRect();return {x:Math.round(p.left+32), y:Math.round(p.top+40), beside:p.left>=b.right && p.left-b.right<16}})()");
  assert.ok(popup.beside, 'the flyout is anchored to the sidebar button');
  move({x:popup.x,y:popup.y}); await pause(480);
  assert.equal(await isOpen(),true,'the preview remains interactive as the pointer enters it');
  assert.equal(await contentWidth(), originalWidth, 'Quick does not resize the workspace');
  move(away); await wait(async()=>!await isOpen(),'leaving Quick closes the preview');
  if (process.argv.includes('--quick-access')) {
    console.log('Sidebar Quick access hover, position, hit testing and dismissal passed.');
    app.quit(); return;
  }
  const titleColors = [];
  win.webContents.debugger.attach('1.3');
  try {
    for (const scheme of ['light','dark']) {
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-color-scheme',value:scheme}]});
      await visible('.app.theme-'+(scheme==='light'?'bright':'dark')+' .recent-bar-list');
      await read("document.querySelector('.assistant-stage-actor img').decode().then(()=>true)");
      titleColors.push(await read("getComputedStyle(document.querySelector('.recent-turn-drawer')).color"));
      assert.ok(await read("['.assistant-stage','.window-spacer'].every(sel=>{const c=getComputedStyle(document.querySelector(sel));return c.backgroundImage==='none' && c.backgroundColor==='rgba(0, 0, 0, 0)'})"), 'the title bar spacer and sidebar robot have no opaque backing');
      const rect = await read("(()=>{const r=document.querySelector('.sidebar-assistant').getBoundingClientRect();return {x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)};})()");
      fs.writeFileSync(path.join(project,'tmp','assistant-scene-'+scheme+'.png'),(await win.webContents.capturePage(rect)).toPNG());
    }
    assert.notEqual(...titleColors, 'identity and status follow the native theme');
  } finally { win.webContents.debugger.detach(); }
  fs.writeFileSync(path.join(project, 'tmp/conversation-glass-bar.png'), (await win.webContents.capturePage()).toPNG());
  win.setContentSize(1400, 600); await pause(180);
  const scrollbar = await read(`(() => {
    const page = document.querySelector('.desktop-library'), rect = page.getBoundingClientRect();
    const gutter = rect.width - page.clientWidth;
    const trackTop = parseFloat(getComputedStyle(page, '::-webkit-scrollbar-track').marginTop);
    return { x:Math.floor(rect.right - gutter/2), y:Math.floor(innerHeight/2), gutter,
      trackTop, caption:document.querySelector('.window-frame').getBoundingClientRect().bottom };
  })()`);
  assert.ok(scrollbar.gutter > 0 && scrollbar.gutter <= 10 && scrollbar.trackTop >= scrollbar.caption,
    'the slim native scrollbar track starts below the window controls: ' + JSON.stringify(scrollbar));
  move({x:scrollbar.x, y:scrollbar.y}); await pause(450);
  assert.equal(await isOpen(), false, 'resting on the scrollbar does not preview the drawer');
  await read("document.querySelector('.desktop-library').scrollTop=0;void 0");
  const grip = {x:scrollbar.x, y:Math.ceil(scrollbar.caption)+12};
  move(grip);
  win.webContents.sendInputEvent({type:'mouseDown', button:'left', clickCount:1, ...grip});
  move({x:grip.x, y:grip.y+80});
  win.webContents.sendInputEvent({type:'mouseUp', button:'left', clickCount:1, x:grip.x, y:grip.y+80});
  await wait(()=>read("document.querySelector('.desktop-library').scrollTop > 0"),'dragging the thumb scrolls the home page');
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
  assert.ok(await read("document.querySelector('.sidebar-assistant .assistant-sprite img').naturalWidth > 0"), 'the packaged pixel character loads');
  assert.ok(await read(`(() => {
    const button = document.querySelector('.sidebar-assistant'), stage = button.querySelector('.assistant-stage');
    const bounds = button.getBoundingClientRect(), scene = stage.getBoundingClientRect(), actor = stage.querySelector('.assistant-stage-actor').getBoundingClientRect();
    const profile = document.querySelector('.profile-trigger').getBoundingClientRect();
    return scene.width > 0 && scene.left >= bounds.left && scene.right <= bounds.right && bounds.bottom <= profile.top &&
      actor.left >= scene.left && actor.right <= scene.right && actor.top >= scene.top && actor.bottom <= scene.bottom;
  })()`), 'the transparent stage contains the robot above the profile');
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
  await showQuickPanel();
  await visible('[data-recent-tab=sessions][aria-selected=true]');
  const hoverCategory = async tab => {
    const selector = '[data-recent-tab=' + tab + ']';
    await visible(selector);
    await wait(() => read(`(() => {const el=document.querySelector('${selector}'), r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()`), 'category reachable');
    const point = await read(`(() => {const r=document.querySelector('${selector}').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    win.webContents.sendInputEvent({type:'mouseMove',...point});
    await visible(selector+'[aria-selected=true]');
  };
  await hoverCategory('notifications');
  await hoverCategory('sessions');
  await visible('[data-desktop-page="overview"]');
  assert.equal(await read("!!document.querySelector('.recent-tabs button, [data-turn-message]')"), false);
  fs.writeFileSync(path.join(project, 'tmp/recent-conversation-drawer.png'), (await win.webContents.capturePage()).toPNG());
  await click('[data-recent-session=local-navigation-test]');
  const targetId = 'turn-45-0';
  await visible('[data-message-id="' + targetId + '"]');
  await wait(() => read("!document.querySelector('.recent-turn-drawer:popover-open')"), 'one click enters the chat');
  await visible('.main-stage .chat-panel[role=region]');
  assert.equal(await read("!!document.querySelector('.main-stage .chat-panel[role=region] > .topbar')"), false, 'the transcript starts directly below the window toolbar');
  const summary = '.recent-panel-header [data-work-summary-toggle]', inspector = '.recent-panel-header [data-inspector-toggle]';
  const toggleTool = async selector => {
    await showQuickPanel();
    await click(selector);
    await wait(() => read("!document.querySelector('.recent-turn-drawer:popover-open')"), 'workspace tool replaces the drawer: ' + selector)
      .catch(async error => { throw Error(error.message + ' ' + await read(`JSON.stringify({
        focused:document.activeElement?.className, visible:document.querySelector('.recent-bar-list')?.getAttribute('aria-expanded'),
        inspector:document.querySelector('[data-inspector-toggle]')?.getAttribute('aria-expanded'),
        summary:document.querySelector('[data-work-summary-toggle]')?.getAttribute('aria-expanded')
      })`), {cause:error}); });
  };
  const toolbarFits = async () => {
    await showQuickPanel();
    return read(`(() => {
      const controls = document.querySelector('.recent-bar-actions');
      const summary = controls.querySelector('[data-work-summary-toggle]').getBoundingClientRect();
      const inspector = controls.querySelector('[data-inspector-toggle]').getBoundingClientRect();
      const close = controls.querySelector('.recent-panel-close').getBoundingClientRect();
      const panel = controls.closest('aside').getBoundingClientRect();
      return summary.width >= 24 && panel.left <= summary.left && close.right <= panel.right &&
        Math.abs(summary.top - inspector.top) <= 1 && summary.right <= inspector.left && inspector.right <= close.left;
    })()`);
  };
  assert.ok(await toolbarFits(), 'summary and inspector are grouped in Quick access');
  const summaryPoint = await read(`(() => {const r=document.querySelector('${summary}').getBoundingClientRect();
    return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)};})()`);
  move(summaryPoint);
  const preview = '.recent-summary-preview > .conversation-work-summary';
  await visible(preview+'.soft-panel-visible');
  await wait(()=>read(`!document.querySelector('${preview}')?.getAnimations().length`),'work summary reveal settles');
  const previewPoint = await read(`(() => {
    const el=document.querySelector('${preview}'), r=el.getBoundingClientRect(), panel=el.closest('.recent-turn-drawer').getBoundingClientRect();
    const y=Math.round(r.top+25);
    return {x:Math.round(r.x+r.width/2), y, rect:r.toJSON(), panel:panel.toJSON(),
      hits:[r.left+4,r.right-4].map(x=>document.elementFromPoint(x,y)?.className), fits:r.left>=panel.left && r.right<=panel.right && r.bottom<=panel.bottom &&
      [r.left+4,r.right-4].every(x=>el.contains(document.elementFromPoint(x,y)))};
  })()`);
  assert.ok(previewPoint.fits, 'both sides of the summary are visible and reachable inside the drawer: '+JSON.stringify(previewPoint));
  move({x:previewPoint.x,y:previewPoint.y}); await pause(440);
  await visible(preview);
  await toggleTool(summary); await visible('.conversation-work-summary');
  await toggleTool(summary); await wait(() => read("!document.querySelector('.conversation-work-summary')"), 'summary closes from the same group');
  await toggleTool(inspector); await visible('.right-inspector');
  await wait(() => read("document.querySelector('.recent-panel-header [data-inspector-toggle]')?.getAttribute('aria-expanded') === 'true'"), 'Quick access controls the real inspector');
  await toggleTool(inspector);
  win.maximize();
  await wait(() => win.isMaximized() && read('innerWidth === ' + win.getContentSize()[0]), 'native window maximized');
  await wait(toolbarFits, 'title and action spacing and stacked rail shortcuts when maximized');
  await click('.recent-panel-close');
  win.unmaximize();
  await wait(() => !win.isMaximized() && read('innerWidth === ' + win.getContentSize()[0]), 'native window restored');
  await wait(toolbarFits, 'matching title and icon spacing after restoring the window');
  for (const width of [1180, 900, 640, 480]) {
    win.setContentSize(width, 720);
    await wait(() => read('innerWidth === ' + width), 'chat window resized to ' + width);
    await wait(toolbarFits, 'chat controls fit at ' + width + ' pixels');
  }
  await click('.recent-panel-close');
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
  assert.equal(await read("document.querySelector('.sidebar-footer [data-nav-section=assistant]').getAttribute('aria-current')"), 'page');
  const titleText = () => read("document.querySelector('.recent-chat-copy strong')?.textContent ?? null");
  const titleStatus = () => read("document.querySelector('.recent-chat-copy small')?.textContent ?? null");
  const sidebarName = () => read("document.querySelector('.sidebar-assistant-name').textContent");
  assert.equal(await titleText(), await sidebarName());
  assert.equal(await titleStatus(), null, 'an idle Assistant only shows its name');
  assert.equal(await read("!!document.querySelector('.assistant-view > .topbar')"), false, 'Assistant has a single desktop title bar');
  await showQuickPanel(); await visible(summary);
  assert.deepEqual(await read("Array.from(document.querySelectorAll('.window-chat-actions button'), button => [button.hasAttribute('data-work-summary-toggle'),button.hasAttribute('data-inspector-toggle')])"),
    [[true,false],[false,true]], 'Assistant toolbar offers work summary and inspector only');
  await toggleTool(summary); await visible('.assistant-view .conversation-work-summary');
  await toggleTool(summary);
  await toggleTool(inspector); await visible('.right-inspector'); await toggleTool(inspector);
  await read("document.querySelector('[data-nav-section=assistant]').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, clientX:72, clientY:120}));void 0");
  await click('[data-sidebar-menu-item=assistant-rename]');
  await visible('.assistant-rename-dialog:modal');
  const customName = 'Nova · Atlas '.repeat(4).trim();
  await win.webContents.insertText(customName);
  await click('.assistant-rename-dialog button[type=submit]');
  await wait(async () => await sidebarName() === customName, 'rename updates the Assistant identity immediately and preserves the full name');
  assert.equal(await titleText(), customName);
  win.setContentSize(480, 720);
  await wait(toolbarFits, 'Assistant actions fit in the narrow Quick panel');
  await click('.recent-panel-close'); await visible('.assistant-view:not([hidden])');
  await showQuickPanel(); await click('[data-recent-tab=sessions]');
  await click('[data-recent-session=personal-assistant]');
  await visible('.assistant-view [data-message-id=assistant-answer]');
  assert.equal(await read("!!document.querySelector('.recent-turn-drawer:popover-open,[data-turn-message]')"), false);
  win.setContentSize(1400, 800);
  await click('[data-nav-section=explore]');
  assert.equal(await read("!!document.querySelector('.window-chat-actions')"), false, 'chat-only controls leave with the conversation');
  assert.equal(await titleText(), null, 'exploring after an idle Assistant does not advertise active work');
  await showQuickPanel();
  await visible('[data-desktop-page=explore]');
  await visible('[data-recent-tab=sessions][aria-selected=true]');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await wait(() => read("!document.querySelector('.recent-turn-drawer:popover-open')"), 'dismiss with Escape');
  await click('[data-nav-section=assistant]'); await visible('.assistant-view:not([hidden])');
  await enterChatFromList(sessionId);
  await visible('[data-message-id="' + targetId + '"]');
  assert.equal(await titleText(), '设计评审记录');
  assert.equal(await titleStatus(), null, 'a completed reply leaves the conversation title without a running status');
  assert.equal(await read("document.querySelector('.main-stage .chat-panel[role=region]').getAttribute('aria-label')"), '设计评审记录', 'the chat retains its own accessible title');
  // Recent rows open even an empty conversation in one step.
  await click('[data-nav-section=home]');
  assert.equal(await read("document.querySelectorAll('.sidebar .conversation-row').length"), 0);
  await showQuickPanel(); await click('[data-recent-tab=sessions]');
  await visible('[data-recent-session=local-earlier]');
  assert.equal(await read("document.querySelectorAll('[data-recent-session]').length"), 3);
  await click('[data-recent-session=local-empty]');
  await wait(() => read("document.querySelector('.main-stage .chat-panel[role=region]')?.getAttribute('aria-label')==='Empty conversation' && !document.querySelector('.recent-turn-drawer:popover-open')"), 'empty chat opens directly');
  assert.equal(await titleText(), 'Empty conversation');
  await click('[data-nav-section=home]'); await showQuickPanel();
  await click('[data-recent-tab=sessions]');
  const earlierRow = '[data-recent-session=local-earlier]';
  await visible(earlierRow);
  await require('./helpers/recent-session-menu.cjs')({win, read, wait, visible, click, showQuickPanel, row: earlierRow});
  await visible('[data-recent-group=pinned] ' + earlierRow);
  await visible('[data-workspace-drop=recent] [data-recent-session=local-navigation-test]');
  assert.equal(await read("document.querySelectorAll('[data-recent-session=local-earlier]').length"), 1);
  assert.equal(await read("[...document.querySelectorAll('.sidebar .conversation-row')].every(row => row.closest('.recent-turn-drawer'))"), true);
  const latestTitle = await read("document.querySelector('[data-workspace-drop=recent] .recent-row-copy').textContent");
  assert.notEqual(latestTitle, 'Earlier conversation');
  await wait(() => read("innerWidth === 1400 && document.querySelector('.desktop-shell').dataset.sidebarLayout === 'docked' && !document.querySelector('.sidebar').getAnimations().length"), 'Quick hit target settled after resizing');
  const quickPoint = await read("(()=>{const r=document.querySelector('.recent-bar-list').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
  move(quickPoint);
  for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({type,button:'left',clickCount:1,...quickPoint});
  await wait(async () => await titleText() === latestTitle && !await isOpen(), 'Quick opens the latest visible chat even when an older chat is pinned').catch(async error => {
    const hit = await read(`document.elementFromPoint(${quickPoint.x}, ${quickPoint.y})?.closest('button')?.className`);
    throw new Error(`${error.message} (expected ${latestTitle}, got ${await titleText()}, panel open ${await isOpen()}, hit ${hit})`);
  });
  move(away);
  await showQuickPanel();
  await click('[data-recent-tab=sessions]');
  await click(earlierRow);
  await visible('[data-message-id=other-user]');
  assert.equal(await titleText(), 'Earlier conversation', 'the title follows the selected chat');
  assert.equal(await titleStatus(), null);
  assert.equal(await read("document.querySelector('.sidebar-assistant-name').textContent"), customName);
  await click('[data-nav-section=explore]');
  assert.equal(await titleText(), null);
  await enterChatFromList('local-earlier');
  await visible('[data-page=chat] [data-message-id=other-user]');
  await click('[data-nav-section=home]');
  await read("localStorage.setItem('cardbush_projects',JSON.stringify([{id:'fixture-project', rootPath:"+JSON.stringify(root)+",title:'Pinned project',pinned:true}]));void 0");
  win.webContents.reload();
  await visible('[data-desktop-page="overview"]');
  await wait(async () => await sidebarName() === customName, 'the Assistant identity survives reload');
  await showQuickPanel();
  await visible('[data-recent-tab=sessions][aria-selected=true]');
  await visible('.recent-session-rows [data-workspace-drop=fixture-project]');
  await click('[data-recent-session=local-earlier]');
  await visible('[data-message-id=other-user]');
  await click('[data-nav-section=home]');
  win.setSize(480, 650); await pause(200); assert.ok(await bounds(), 'toolbar controls fit at minimum width');
  win.setSize(590, 650);
  await showQuickPanel(); await click('[data-recent-tab=sessions]');
  await visible('[data-recent-session=local-earlier]');
  await wait(() => read("(() => {const p=document.querySelector('.recent-turn-drawer').getBoundingClientRect();const close=document.querySelector('.recent-panel-close').getBoundingClientRect();return p.left>=0 && p.right<=innerWidth && close.width>0 && close.right<=p.right})()"), 'the open drawer settles within the narrow viewport');
  await click('[data-recent-session=local-earlier]'); await visible('[data-message-id=other-user]');
  await click('[data-nav-section=home]');
  await read("localStorage.setItem('cardbush_archived_conversation_ids',JSON.stringify(['local-earlier']));window.dispatchEvent(new Event('cardbush-conversation-archives-changed'));void 0");
  await showQuickPanel(); await click('[data-recent-tab=sessions]');
  await wait(() => read("!!document.querySelector('[data-recent-session=local-navigation-test]') && !document.querySelector('[data-recent-session=local-earlier],[data-recent-session=local-hidden]')"), 'archived and hidden sessions are excluded');
  await click('.recent-panel-close');
  win.setContentSize(1084, 760);
  await pause(300);
  await read("window.pageEntrances=[];document.addEventListener('animationstart',event=>{if(event.animationName==='workspace-page-entrance') pageEntrances.push(event.target.className)});void 0");
  await click('[data-nav-section=explore]');
  await visible('[data-desktop-page=explore]');
  await wait(()=>read("pageEntrances.includes('main-stage')"),'Explore enters with the Windows page transition');
  assert.ok(await read("document.querySelector('.desktop-explore > h1')?.nextElementSibling?.matches('.desktop-filter')"),'Explore has a title followed directly by search');
  assert.equal(await read("!!document.querySelector('.desktop-explore button[aria-haspopup=dialog]')"),false,'no app management button on Explore');
  assert.equal(await read("!!document.querySelector('.desktop-menu-toggle')"),false);
  assert.ok(await bounds(), 'Quick stays aligned below Home in the compact sidebar');
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
    assert.ok(await read("Array.from(document.querySelectorAll('.assistant-stage img'), img=>getComputedStyle(img).animationName).every(name=>name==='none')"), 'reduced motion shows still frames across the stage');
    await click('[data-nav-section=home]'); await visible('[data-desktop-page=overview]'); await pause(300);
    assert.deepEqual(await read('pageEntrances'),[], 'reduced motion skips the transition');
  } finally { win.webContents.debugger.detach(); }
  await read("localStorage.setItem('cardbush_archived_conversation_ids',JSON.stringify(['local-navigation-test','local-earlier','local-empty']));window.dispatchEvent(new Event('cardbush-conversation-archives-changed'));void 0");
  await click('[data-nav-section=chat]');
  await click(quick); await visible(drawer); await visible(inspector);
  assert.equal(await titleText(), null, 'empty history has no task title and the inspector remains available');
  await toggleTool(inspector); await visible('.right-inspector'); await toggleTool(inspector);
  win.setContentSize(1180, 760);
  await visible('.new-chat-input .composer-surface');
  await showQuickPanel(); assert.equal(await titleText(), null, 'an unsent draft does not advertise running work');
  await click('.recent-panel-close');
  await visible('.desktop-shell[data-sidebar-layout=drawer].sidebar-is-collapsed');
  await checkChatMargins('Welcome input centers beside the rail', '.new-chat-input .composer-surface');
  await click('.window-sidebar-toggle');
  await wait(() => read("document.querySelector('.sidebar').getBoundingClientRect().width > 240"), 'welcome drawer opens');
  await checkChatMargins('Welcome input centers beside the expanded drawer', '.new-chat-input .composer-surface');
  await click('[data-nav-section=assistant]');
  await visible(quick);
  assert.equal(await sidebarName(), customName, 'Assistant keeps its saved name after reload even with no ordinary chats');
  await showQuickPanel(); await click('[data-recent-tab=sessions]'); await click('[data-recent-session=personal-assistant]'); await visible('.assistant-view [data-message-id=assistant-answer]');
  win.setContentSize(480, 700);
  await wait(() => read('innerWidth === 480'), 'narrow workspace');
  await click('.window-sidebar-toggle');
  await visible('.desktop-shell[data-sidebar-layout=drawer]:not(.sidebar-is-collapsed)');
  await wait(() => read("['chat','projects'].every(section => { const b = document.querySelector('.sidebar [data-nav-section='+section+']'); const r = b.getBoundingClientRect(); return b.lastElementChild.checkVisibility() && r.width>=24 && b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)); })"), 'both expanded rail rows show labels and accept clicks');
  await click('.sidebar [data-nav-section=chat]');
  await visible('.desktop-shell.sidebar-is-collapsed .new-chat-input .composer-surface');
  await wait(() => read("['chat','projects'].every(section => !document.querySelector('.sidebar [data-nav-section='+section+']').lastElementChild.checkVisibility())"), 'collapsed navigation shows only icons');
  await click('.sidebar [data-nav-section=projects]');
  await visible('[data-desktop-page=projects] .project-list-actions');
  await visible('[data-desktop-page=projects] [data-workspace-drop=fixture-project] .project-row');
  assert.deepEqual(await read("Array.from(document.querySelectorAll('.sidebar [data-nav-section][aria-current=page]'), b => b.dataset.navSection)"), ['projects'], 'projects is the only selected sidebar page');
  await click('.sidebar [data-nav-section=tabs]');
  await visible('[data-page=tabs] .right-inspector-tab-page.active');
  assert.deepEqual(await read("Array.from(document.querySelectorAll('[data-nav-section][aria-current=page]'), b => b.dataset.navSection)"), ['tabs'], 'the covered projects page and its sidebar shortcut are inactive');
  const tab = await read("document.querySelector('.right-inspector-tab-page.active').getAttribute('data-inspector-page-id')");
  await click('.sidebar [data-nav-section=tabs]');
  await wait(() => read("!document.querySelector('[data-page=tabs]')"), 'return from tab workspace');
  await visible('[data-desktop-page=projects]');
  assert.ok(tab);
  await click('.sidebar [data-nav-section=tabs]');
  await visible('[data-page=tabs] .right-inspector-tab-page.active');
  assert.equal(await read("document.querySelector('.right-inspector-tab-page.active').getAttribute('data-inspector-page-id')"), tab);
  console.log('Workspace navigation passed: compact rail and caption alignment, Explore without a management button, section/category entrance and reduced motion.');
  console.log('Recent conversation navigation passed: hover categories, direct chat entry, resume, Escape, reload, empty state, archive and narrow layout.');
  await checkWorkspaceNavigation();
  app.quit();
}
