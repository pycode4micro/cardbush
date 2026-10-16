const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function testConversationTitleRendering({ run, until, pause, window }) {
  await window.webContents.insertCSS(fs.readFileSync(path.join(__dirname, '../../src/components/hover-preview.css'), 'utf8'));
  await run(`
    window.titleNoop = () => {};
    window.titleRenames = [];
    window.titleSelections = [];
    window.titleRenameFail = false;
    window.titleFixtures = [
      { id: 'legacy', title: '[$video-face-stylizer](<C...', expected: 'video-face-stylizer' },
      { id: 'complete', title: '[$face-tools](<C:/plugins/face-tools/plugin.json>) 检查连接', expected: 'face-tools 检查连接' },
      { id: 'long', title: '[$a-very-long-plugin-name-for-testing-layout](<C:/plugins/long/plugin.json>) 验证渲染与省略', expected: 'a-very-long-plugin-name-for-testing-layout 验证渲染与省略' },
      { id: 'plain', title: '普通标题 [待办]', expected: '普通标题 [待办]' },
    ];
    window.titleConversations = titleFixtures.map(item => ({ ...item, preview: '', updatedAt: '2026-09-12T00:00:00Z' }));
    window.showTitleFixture = index => renderView(h('div', { className: 'desktop-shell' },
      h(views.ChatSidebar, {
        language: 'zh', section: 'chat', activeConversationId: titleFixtures[index].id,
        projects: [], conversations: titleConversations, changeReportsByConversation: {},
        runningConversationIds: new Set(['legacy']),
        onSectionChange: titleNoop, onConversationChange: id => titleSelections.push(id),
        onCreateConversation: titleNoop, onAddProject: titleNoop, onProjectAction: titleNoop,
        onDeleteConversation: titleNoop, onRenameConversation: async (id, title) => {
          titleRenames.push({ id, title });
          if (titleRenameFail) return false;
          titleConversations = titleConversations.map(item => item.id === id ? { ...item, title } : item);
          showTitleFixture(index);
          return true;
        },
        onOpenConversationChanges: titleNoop, onOpenSettings: titleNoop,
      }),
      h('main', { className: 'main-stage' }, h('div', { className: 'chat-panel' },
        h(views.TopBar, { title: titleFixtures[index].title, language: 'zh', inspectorOpen: false, onToggleInspector: titleNoop }))),
    ));
    showTitleFixture(0);
    undefined;
  `);
  for (const theme of ['theme-bright', 'theme-dark']) {
    for (const width of [760, 1180]) {
      window.setSize(width, 760);
      for (let index = 0; index < 4; index++) {
        await run(`window.viewTheme = '${theme}'; showTitleFixture(${index}); undefined;`);
        await until(`document.querySelector('.topbar h1')?.textContent === titleFixtures[${index}].expected`, 'clean header title');
        await run(`document.querySelector('.app').style.width = '${width}px'; undefined;`);
        await pause(30);
        const state = await run(`(() => {
          const title = document.querySelector('.conversation-row.active .conversation-title');
          const header = document.querySelector('.topbar h1');
          const action = document.querySelector('.topbar button');
          return { sidebar: title.textContent, label: title.getAttribute('aria-label'), tooltip: title.title,
            header: header.textContent, headerTooltip: header.title,
            overlaps: header.getBoundingClientRect().right > action.getBoundingClientRect().left,
            visible: header.getBoundingClientRect().top >= 0 && header.getBoundingClientRect().bottom < innerHeight && header.clientWidth > 0,
            links: title.querySelectorAll('a').length + header.querySelectorAll('a').length };
        })()`);
        const expected = await run(`titleFixtures[${index}].expected`);
        assert.equal(state.sidebar, expected);
        assert.equal(state.label, expected);
        assert.equal(state.tooltip, '', 'sidebar titles retain hover scrolling without a native tooltip');
        assert.equal(state.headerTooltip, expected);
        assert.equal(state.links, 0);
        assert.equal(state.overlaps, false, 'long titles must leave room for toolbar actions');
        assert.equal(state.visible, true, 'the header must remain inside the viewport');
      }
    }
  }
  await run('showTitleFixture(0)');
  await until("document.querySelector('.conversation-row.active .conversation-title')?.textContent === 'video-face-stylizer' && !!document.querySelector('.conversation-row.active .conversation-archive')", 'legacy conversation');
  await run("document.querySelector('.conversation-row.active').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 160, clientY: 240 }))");
  await until("!!document.querySelector('.sidebar-context-menu')", 'rename menu');
  await run("[...document.querySelectorAll('.sidebar-context-menu button')].find(button => button.textContent.includes('重命名')).click()");
  await until("!!document.querySelector('.conversation-row input')", 'rename editor');
  assert.equal(await run("document.querySelector('.conversation-row input').value"), 'video-face-stylizer');
  await run("document.querySelector('[aria-label=保存标题]').click()");
  await until("!document.querySelector('.conversation-row input')", 'unchanged rename closes');
  assert.deepEqual(await run('titleRenames'), [], 'opening and saving a cleaned title must not silently rewrite history');
  const pointOf = selector => run(`(() => { const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:Math.round(r.x+Math.min(40,r.width/2)),y:Math.round(r.y+r.height/2)}; })()`);
  const mouse = (type, point, button = 'none') => window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type, ...point, button, clickCount: button === 'none' ? 0 : 1 });
  const previewRename = async () => {
    await mouse('mouseMoved', { x: 700, y: 600 });
    await until("!document.querySelector('.conversation-hover-preview')", 'leaving the row and card closes the preview');
    const start = await pointOf('.conversation-row.active');
    await mouse('mouseMoved', start);
    await until("!!document.querySelector('.conversation-hover-preview:popover-open')", 'rename hover preview');
    const gap = await run(`(() => { const row=document.querySelector('.conversation-row.active').getBoundingClientRect(), card=document.querySelector('.conversation-hover-preview').getBoundingClientRect(); return { x: Math.round((row.right+card.left)/2), y: Math.round(row.y+row.height/2) }; })()`);
    for (let x = start.x + 6; x < gap.x; x += 6) {
      await mouse('mouseMoved', { x, y: start.y });
      await pause(12);
      assert.equal(await run("!!document.querySelector('.conversation-hover-preview:popover-open')"), true, 'continuous sideways movement must not dismiss the preview');
    }
    for (const selector of ['.conversation-row.active .conversation-pin', '.conversation-row.active .conversation-archive']) {
      await mouse('mouseMoved', await pointOf(selector));
      await pause(180);
      assert.equal(await run("!!document.querySelector('.conversation-hover-preview:popover-open')"), true, 'crossing row actions must keep the edit preview open');
    }
    await mouse('mouseMoved', gap);
    await pause(400);
    assert.equal(await run("!!document.querySelector('.conversation-hover-preview:popover-open')"), true, 'the gap is part of the hover area, even during a slow crossing');
    const point = await pointOf('.conversation-hover-preview-rename');
    await mouse('mouseMoved', point);
    await pause(160);
    assert.equal(await run("!!document.querySelector('.conversation-hover-preview:popover-open')"), true, 'moving into the card keeps its action available');
    await mouse('mousePressed', point, 'left');
    await mouse('mouseReleased', point, 'left');
    await until("document.activeElement === document.querySelector('.conversation-row.active input')", 'preview action focuses the existing rename editor');
    assert.equal(await run("!!document.querySelector('.conversation-hover-preview')"), false, 'editing dismisses the preview');
  };
  window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const key = async (value, code) => {
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code: value, windowsVirtualKeyCode: code, ...(value === 'Enter' ? { text: '\r' } : {}) });
    await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code: value, windowsVirtualKeyCode: code });
  };
  await previewRename();
  assert.equal(await run("document.activeElement.selectionEnd - document.activeElement.selectionStart"), 'video-face-stylizer'.length, 'select the current readable title');
  await key('Escape', 27);
  await until("!document.querySelector('.conversation-row input')", 'cancel preview rename');
  assert.deepEqual(await run('titleRenames'), [], 'cancel does not save');
  await previewRename();
  await window.webContents.insertText('百应切片自动化流程');
  await run('titleRenameFail = true');
  await key('Enter', 13);
  await until("!!document.querySelector('.conversation-rename-form.invalid input')", 'failed save keeps the draft editable');
  assert.equal(await run("document.querySelector('.conversation-row input').value"), '百应切片自动化流程');
  await run('titleRenameFail = false');
  await key('Enter', 13);
  await until("document.querySelector('.conversation-row.active .conversation-title')?.textContent === '百应切片自动化流程'", 'saved name updates the sidebar');
  assert.deepEqual(await run('titleRenames'), Array(2).fill({ id: 'legacy', title: '百应切片自动化流程' }));
  assert.deepEqual(await run('titleSelections'), [], 'renaming never switches conversations or interrupts the running session');
  assert.equal(await run("!!document.querySelector('.conversation-row.active .conversation-running-indicator')"), true);
  await mouse('mouseMoved', { x: 700, y: 600 });
  await until("!document.querySelector('.conversation-hover-preview')", 'leaving after save closes the preview');
  await mouse('mouseMoved', await pointOf('.conversation-row.active'));
  await until("!!document.querySelector('.conversation-hover-preview:popover-open')", 'preview before row action');
  const pinPoint = await pointOf('.conversation-row.active .conversation-pin');
  await mouse('mouseMoved', pinPoint);
  await mouse('mousePressed', pinPoint, 'left');
  await mouse('mouseReleased', pinPoint, 'left');
  await until("!document.querySelector('.conversation-hover-preview')", 'clicking row actions still dismisses the preview');
  assert.equal(await run("document.querySelector('.conversation-row.active .conversation-pin').getAttribute('aria-pressed')"), 'true', 'hover continuity must not block row action clicks');
  window.webContents.debugger.detach();
  await run('titleConversations[0].title = titleFixtures[0].title; showTitleFixture(0)');
  if (process.env.CARDBUSH_CONVERSATION_TITLE_SCREENSHOT) {
    await run("window.viewTheme = 'theme-bright'; showTitleFixture(0)");
    await pause();
    await run("document.querySelector('.app').style.width = '1180px'");
    fs.writeFileSync(process.env.CARDBUSH_CONVERSATION_TITLE_SCREENSHOT,
      (await window.webContents.capturePage({ x: 0, y: 0, width: 1180, height: 330 })).toPNG());
  }
  await run(`renderView(h(views.ConversationSearchDialog, {
    language: 'zh', conversations: titleConversations, projects: [], onClose: titleNoop,
    onCreateConversation: titleNoop, onOpenConversation: titleNoop,
  })); undefined;`);
  await until("document.querySelectorAll('[data-search-conversation] .conversation-search-title').length === 4", 'search title results');
  assert.deepEqual(await run("[...document.querySelectorAll('[data-search-conversation] .conversation-search-title')].map(node => node.textContent)"),
    await run('titleFixtures.map(item => item.expected)'));
  console.log('Conversation titles passed: legacy references, themes/layouts, continuous hover crossing, slow gap crossing, row actions, rename/cancel/retry, running-session isolation and search.');
};
