// Exercise the actual rail inside ChatPanel, including its measured composer boundary.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async function testQuickContextLayout({ run, until, pause, window, root }) {
  await window.webContents.insertCSS(
    fs.readFileSync(path.join(root, 'src/styles/themes/cyberpunk.css'), 'utf8') + '\n' + [
      'body[data-context-layout-test] .app { position: fixed; inset: 0; display: block; width: 100vw !important; height: 100vh !important; --chat-track-width: 780px; --chat-inline-gutter: clamp(18px, calc(3vw + 10px), 46px); }',
      '@media (max-width: 760px) { body[data-context-layout-test] .app { --chat-inline-gutter: 12px; } }',
      'body[data-context-layout-test] .chat-panel { position: absolute; left: var(--test-chat-left); top: 30px; width: var(--test-chat-width); height: calc(100% - 30px); min-width: 0; }',
      '.context-layout-inspector { position: fixed; top: 30px; bottom: 0; left: calc(var(--test-chat-left) + var(--test-chat-width)); right: 0; z-index: 9; padding: 30px; background: #252a2e; color: #b9c0c5; font-size: 18px; border-left: 1px solid #666; }',
    ].join('\n'),
  );
  await run(`
    document.body.dataset.contextLayoutTest = '';
    document.body.style.setProperty('--test-chat-left', '120px');
    document.body.style.setProperty('--test-chat-width', '960px');
    const contextMessages = Array.from({ length: 65 }, (_, index) => [
      { id: 'context-user-' + index, role: 'user', turnId: 'context-turn-' + index, createdAt: '2026-09-05T00:00:00Z',
        content: '检查项目缺口与截图问题，这是第 ' + (index + 1) + ' 轮请求。' + 'very-long-unbroken-filename-'.repeat(8) },
      { id: 'context-assistant-' + index, role: 'assistant', turnId: 'context-turn-' + index, createdAt: '2026-09-05T00:00:01Z',
        content: '我先全面盘点项目现状，找出所有缺口再补。\\n\\n' +
          ('项目文档挺完整。检查代码里是否有未完成部分，以及最近一次改动是什么。继续读取后台、数据结构和实际页面，验证后再更新结论。\\n\\n').repeat(24) },
    ]).flat();
    updateChat({ language: 'zh', activeConversationId: 'session-context-layout', turnHistoryAvailable: false,
      loading: false, historyLoading: false, messages: contextMessages, draft: '' });
    const inspector = document.createElement('div');
    inspector.className = 'context-layout-inspector';
    inspector.textContent = '右侧浏览器区域\\n\\n预览浮层不应侵入这里';
    document.body.append(inspector);
    window.contextGeometry = (selector = '.quick-context-panel') => {
      const popup = document.querySelector(selector);
      const body = document.querySelector('.chat-body');
      const region = document.querySelector('.quick-context-popovers');
      const rect = element => element?.getBoundingClientRect().toJSON();
      const contentTop = Number.parseFloat(getComputedStyle(body).getPropertyValue('--composer-content-top'));
      const buttons = [...(popup?.querySelectorAll('header button, footer button') ?? [])].map(button => {
        const bounds = button.getBoundingClientRect();
        const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        return { rect: bounds.toJSON(), reachable: hit === button || button.contains(hit) };
      });
      return { popup: rect(popup), region: rect(region), body: rect(body), composerTop: body.getBoundingClientRect().top + contentTop, buttons };
    };
    undefined;
  `);
  await until("document.querySelectorAll('.quick-context-tick').length > 3", 'context rail fixture');
  await run("document.querySelector('.quick-context-tick').click()");
  await until("document.querySelector('.quick-context-panel.detail')?.textContent.includes('我先全面')", 'full turn preview');
  await run("window.retainedContextPanel = document.querySelector('.quick-context-panel'); undefined");
  await run("updateChat({ draft: '输入新问题时继续回看这轮会话' })");
  await pause(1100);
  assert.equal(await run("document.querySelector('.quick-context-panel.detail') === retainedContextPanel"), true, 'typing must keep the selected turn open');
  await run(`updateChat({ draft: '', messages: [...chatProps.messages,
    { id: 'context-new-user', role: 'user', content: '追加一个新的问题', createdAt: '2026-09-05T00:01:00Z' }] });`);
  await until("document.querySelector('.message-list')?.textContent.includes('追加一个新的问题')", 'new user turn');
  assert.equal(await run("document.querySelector('.quick-context-panel.detail') === retainedContextPanel"), true, 'new messages must preserve the selected turn');
  assert.equal(await run("!!document.querySelector('.quick-context-back, .quick-context-request-list')"), false, 'turn previews have no related-request navigation');

  const assertFits = async (label, selector) => {
    await pause(220);
    const state = await run('contextGeometry(' + JSON.stringify(selector) + ')');
    const { popup, region, body, composerTop } = state;
    assert.ok(popup?.width > 100 && popup.height > 0, label + ': visible popup');
    assert.ok(popup.left >= body.left && popup.right <= body.right - 8, label + ': inside conversation width');
    assert.ok(popup.top >= region.top - 1 && popup.bottom <= region.bottom + 1, label + ': inside available height');
    assert.ok(popup.bottom <= composerTop - 8, label + ': clear of composer');
    for (const button of state.buttons) {
      assert.ok(button.rect.left >= popup.left && button.rect.right <= popup.right + 1, label + ': control fits horizontally');
      assert.ok(button.rect.top >= popup.top && button.rect.bottom <= popup.bottom + 1, label + ': control fits vertically');
      assert.ok(button.reachable, label + ': control is not covered by another surface');
    }
    return state;
  };

  for (const [width, height, chatWidth, left] of [
    [1200, 800, 960, 120],
    [1200, 800, 959, 120],
    [1024, 700, 760, 240],
    [720, 650, 680, 10],
    [680, 520, 640, 10],
    [680, 520, 639, 10],
    [1200, 800, 440, 256],
    [980, 700, 330, 256],
    [780, 500, 300, 120],
    [1200, 800, 820, 10],
    [1200, 800, 1160, 10],
  ]) {
    window.setContentSize(width, height);
    await run("document.body.style.setProperty('--test-chat-width', '" + chatWidth + "px'); document.body.style.setProperty('--test-chat-left', '" + left + "px')");
    if (chatWidth < 640) {
      await until("getComputedStyle(document.querySelector('.quick-context-handle')).display === 'none'", 'narrow conversation hides rail');
      assert.equal(await run("document.querySelector('.quick-context-panel').getClientRects().length"), 0, 'narrow conversation also hides the open preview');
      assert.equal(await run("document.querySelector('.quick-context-tick').getClientRects().length"), 0, 'hidden ticks cannot overlap or intercept the transcript');
    } else {
      await until("getComputedStyle(document.querySelector('.quick-context-handle')).display !== 'none'", 'wide conversation restores rail');
      assert.ok(await run("document.querySelector('.quick-context-handle').getBoundingClientRect().left - document.querySelector('.chat-body').getBoundingClientRect().left >= 20"), 'rail keeps a visible inset from the conversation edge');
      await until("document.querySelector('.quick-context-handle').getBoundingClientRect().right + 2 <= document.querySelector('.message-row').getBoundingClientRect().left", 'rail hit area stays clear of message text');
      assert.ok(await run("(() => {const message=document.querySelector('.message-row').getBoundingClientRect(),composer=document.querySelector('.composer-surface').getBoundingClientRect();return Math.abs(message.left-composer.left)<2&&Math.abs(message.right-composer.right)<2})()"), 'composer and transcript keep the same reading column');
      await assertFits('viewport ' + width + ' / pane ' + chatWidth);
    }
    assert.equal(await run("retainedContextPanel === document.querySelector('.quick-context-panel')"), true, 'resize must not remount or clear the selected turn');
  }
  await run("window.contextPanelClasses = document.querySelector('.chat-panel').className; document.querySelector('.chat-panel').classList.add('work-summary-docked', 'work-summary-visible'); undefined;");
  await pause(400);
  assert.notEqual(await run("getComputedStyle(document.querySelector('.quick-context-handle')).display"), 'none', 'rail stays available when the docked summary leaves enough room');
  await assertFits('docked summary with a compact rail');
  await run("document.body.style.setProperty('--test-chat-width', '960px')");
  await until("getComputedStyle(document.querySelector('.quick-context-handle')).display === 'none'", 'docked summary reduces the usable conversation width');
  await run("document.querySelector('.chat-panel').className = contextPanelClasses; undefined;");
  await until("getComputedStyle(document.querySelector('.quick-context-handle')).display !== 'none'", 'closing summary restores rail without a window resize');
  assert.ok(await run("document.querySelector('.quick-context-turn').scrollHeight > document.querySelector('.quick-context-turn').clientHeight"), 'long preview scrolls internally');
  // The main transcript restores its reading anchor with a smooth scroll after resize.
  await pause(1200);
  await run("window.contextMainScrollBefore = document.querySelector('.message-list').scrollTop");
  const point = await run("(() => { const r = document.querySelector('.quick-context-turn').getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()");
  window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  window.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaY: -160, deltaX: 0 });
  await pause(250);
  assert.ok(await run("document.querySelector('.quick-context-turn').scrollTop > 0"), 'wheel scrolls preview content');
  const scrollState = await run("({ before: contextMainScrollBefore, after: document.querySelector('.message-list').scrollTop })");
  assert.equal(scrollState.after, scrollState.before, 'preview wheel must not move the conversation behind it');

  await run("document.querySelector('.composer-surface').style.minHeight = '260px'");
  await assertFits('expanded composer');
  await run("document.querySelector('.composer-surface').style.minHeight = ''");
  for (const theme of ['theme-light', 'theme-cyberpunk', 'theme-dark']) {
    await run("document.querySelector('.app').className = 'app " + theme + "'");
    await assertFits(theme);
  }
  if (process.env.CARDBUSH_QUICK_CONTEXT_SCREENSHOT) {
    fs.writeFileSync(process.env.CARDBUSH_QUICK_CONTEXT_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    console.log('Context preview screenshot: ' + process.env.CARDBUSH_QUICK_CONTEXT_SCREENSHOT);
  }
  await run(`window.contextClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async text => { window.copiedContextReply = text; },
  } });
  [...document.querySelectorAll('.quick-context-panel footer button')].find(button => button.textContent.includes('复制')).click();`);
  await until("document.querySelector('.quick-context-panel footer')?.textContent.includes('已复制')", 'copy reply confirmation');
  assert.equal(await run('copiedContextReply'), await run("chatProps.messages.find(message => message.role === 'assistant').content.trim()"), 'copy retains the complete assistant reply');
  await run("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await until("!document.querySelector('.quick-context-panel')", 'close context panel');
  window.webContents.sendInputEvent({ type: 'mouseMove', x: 10, y: 10 });
  await pause(80);
  for (const edge of ['first', 'last']) {
    const tickPoint = await run("(() => { const ticks = [...document.querySelectorAll('.quick-context-tick')]; const r = ticks[" + (edge === 'first' ? '0' : 'ticks.length - 1') + "].getBoundingClientRect(); return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }; })()");
    window.webContents.sendInputEvent({ type: 'mouseMove', ...tickPoint });
    await until("!!document.querySelector('.quick-context-turn-preview')", 'edge tooltip');
    await assertFits(edge + ' tick tooltip', '.quick-context-turn-preview');
    window.webContents.sendInputEvent({ type: 'mouseMove', x: 10, y: 10 });
    await until("!document.querySelector('.quick-context-turn-preview')", 'leave tooltip');
  }
  await run("document.querySelector('.quick-context-tick').click()");
  await until("!!document.querySelector('.quick-context-panel')", 'reopen');
  await run("document.querySelector('.message-list').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))");
  await until("!document.querySelector('.quick-context-panel')", 'outside click still closes panel');
  await run("document.querySelector('.quick-context-tick').click()");
  await until("!!document.querySelector('.quick-context-panel.detail')", 'reopen before jump');
  await run(`window.contextJump = null;
    window.contextJumpScroller = document.querySelector('.message-list');
    window.contextOriginalScrollTo = contextJumpScroller.scrollTo;
    contextJumpScroller.scrollTo = options => { window.contextJump = options; };
    [...document.querySelectorAll('.quick-context-panel footer button')].find(button => button.textContent.includes('跳转')).click();`);
  await until("contextJump !== null && !document.querySelector('.quick-context-panel')", 'jump closes preview and scrolls the transcript');
  assert.ok(await run('contextJump.top >= 0'), 'jump targets a valid transcript position');
  await run('contextJumpScroller.scrollTo = contextOriginalScrollTo; undefined');
  await run("document.querySelector('.quick-context-tick').click()");
  await until("!!document.querySelector('.quick-context-panel.detail')", 'reopen before session switch');
  await run("updateChat({ activeConversationId: 'session-context-other' })");
  await until("!document.querySelector('.quick-context-panel')", 'session switch closes the previous turn preview');
  await run(`document.querySelector('.context-layout-inspector').remove(); delete document.body.dataset.contextLayoutTest;
    if (contextClipboardDescriptor) Object.defineProperty(navigator, 'clipboard', contextClipboardDescriptor);
    else delete navigator.clipboard;`);
  console.log('Quick context layout passed: retained turn previews, copy, jump, session isolation, split-pane widths, live resize, short window, expanded composer, themes, scroll isolation and edge tooltips.');
};
