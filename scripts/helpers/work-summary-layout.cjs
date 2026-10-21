const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  const originalSize = window.getContentSize();
  const fixtureCss = await window.webContents.insertCSS(
    fs.readFileSync(path.join(root, 'src/styles/appearance.css'), 'utf8') +
    '\n.app:has(.work-summary-layout-fixture) { width: 100% !important; }',
  );
  window.setContentSize(1456, 760);
  await run(`
    window.summaryOriginal = { props: { ...chatProps }, theme: window.viewTheme };
    window.summaryReviews = [];
    window.summaryPaneWidth = 1224;
    window.renderSummaryLayout = patch => {
      Object.assign(chatProps, patch);
      renderView(h('div', { className: 'work-summary-layout-fixture', style: { height: '100%', display: 'flex', width: '1456px' } },
        h('aside', { style: { width: '232px', padding: '24px', flexShrink: 0 } }, 'CardBush'),
        h('main', { className: 'main-stage', style: { width: summaryPaneWidth + 'px', flex: '0 0 auto' } }, h(views.ChatPanel, chatProps))));
    };
    renderSummaryLayout({ activeConversationId: 'summary-layout', language: 'zh',
      title: '工作摘要布局', loading: false, historyLoading: false, inspectorOpen: false,
      windowMaximized: false, draft: '保留尚未发送的内容',
      onOpenChangeReview: path => { summaryReviews.push(path ?? null); },
      messages: [
        { id: 'summary-user', role: 'user', content: '整理项目的输出与执行记录', turnId: 'summary-turn' },
        { id: 'summary-answer', role: 'assistant', turnId: 'summary-turn',
          content: '已整理完成。摘要展开时，正文和输入框应一起调整宽度，便于同时查看执行记录和继续对话。\\n\\n' +
            '较窄的聊天区域使用浮层，打开侧栏或拖动宽度时自动切换显示方式。',
          createdAt: '2026-09-19T01:37:00Z' },
      ],
      changeReports: [{ id: 'summary-change', messageId: 'summary-answer', fileCount: 1, additions: 24, deletions: 3,
        files: [{ path: 'src/features/chat/ChatPanel.tsx', additions: 24, deletions: 3, diff: '', lines: [] }] }],
    });
    window.summaryBounds = () => {
      const rect = selector => {
        const element = document.querySelector(selector);
        if (!element) return null;
        const value = element.getBoundingClientRect();
        return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width };
      };
      const list = document.querySelector('.message-list');
      return { classes: document.querySelector('.chat-panel').className,
        inset: parseFloat(getComputedStyle(document.querySelector('.message-list-content')).marginRight),
        scrollbar: list.offsetWidth - list.clientWidth,
        list: rect('.message-list'), content: rect('.message-list-content'), message: rect('.message-row'),
        body: rect('.chat-body'), frame: rect('.chat-content-frame'), summary: rect('.conversation-work-summary'),
        toggle: rect('[data-work-summary-toggle]'), toolbar: rect('.topbar'), composer: rect('.composer-surface') };
    };
    void 0;
  `);
  const open = async () => {
    await run(`if (document.querySelector('[data-work-summary-toggle]').getAttribute('aria-expanded') !== 'true') document.querySelector('[data-work-summary-toggle]').click()`);
    await until("!!document.querySelector('.conversation-work-summary.soft-panel-visible')", 'summary visible');
    await pause(300);
  };
  const assertCentered = bounds => {
    for (const name of ['message', 'composer']) {
      const left = bounds[name].left - bounds.body.left;
      const right = bounds.body.right - bounds.inset - bounds[name].right;
      assert.ok(Math.abs(left - right) <= 1,
        `${name} has equal outer margins, including the native scrollbar: ${JSON.stringify({ left, right, bounds })}`);
    }
  };
  const assertLayout = async docked => {
    await until("document.querySelector('.chat-body')?.clientWidth === summaryPaneWidth", 'pane resize committed');
    await until(`document.querySelector('.chat-panel').classList.contains('work-summary-docked') === ${docked}`, 'resize observer updates the layout mode');
    await until("[...document.querySelectorAll('.chat-content-frame, .conversation-work-summary')].every(element => element.getAnimations().every(animation => animation.playState !== 'running'))", 'layout transitions settled');
    const b = await run('summaryBounds()');
    assertCentered(b);
    assert.ok(Math.abs(b.summary.right - b.toggle.right) <= 1, `summary aligns with its button: ${JSON.stringify(b)}`);
    assert.ok(Math.abs(b.summary.top - b.toolbar.bottom - 8) <= 1, 'consistent space below the toolbar');
    assert.ok(b.summary.left >= b.body.left && b.summary.bottom <= b.body.bottom, 'summary stays inside its pane');
    assert.ok(Math.abs(b.list.right - b.body.right) <= 1 && Math.abs(b.list.left - b.body.left) <= 1,
      'native scroll viewport spans the pane, keeping its scrollbar at the outer right edge');
    assert.ok(Math.abs(b.message.left - b.composer.left) <= 1 && Math.abs(b.message.right - b.composer.right) <= 1,
      'message and composer tracks stay aligned: ' + JSON.stringify(b));
    assert.equal(await run(`(() => {
      const panel = document.querySelector('.conversation-work-summary');
      const rect = panel.getBoundingClientRect();
      return panel.contains(document.elementFromPoint(rect.right - 20, rect.top + 30));
    })()`), true, 'summary is visible and interactive, not clipped by an ancestor');
    if (docked) {
      assert.ok(b.content.right <= b.summary.left - 11, 'wide pane reserves a separate summary column: ' + JSON.stringify(b));
      assert.ok(b.composer.right < b.summary.left, 'composer shrinks with the conversation');
      assert.ok(b.content.width + b.scrollbar >= 680, 'remaining conversation stays readable at the breakpoint');
    } else {
      assert.ok(Math.abs(b.content.width + b.scrollbar - b.body.width) <= 1, 'overlay preserves conversation width');
      assert.ok(b.summary.left < b.frame.right, 'narrow summary overlays the content');
    }
    assert.equal(await run("document.querySelector('.composer-surface textarea').value"), '保留尚未发送的内容');
  };
  try {
    await until("!!document.querySelector('[data-work-summary-toggle]')", 'summary toolbar');
    await run(`window.summaryPlan = { protocol: 'bush.task_plan.v1', planId: 'summary-plan',
      sessionId: 'summary-layout', active: true, explanation: '计划通过摘要查看，更新不会挤压正文。',
      nodes: Array.from({ length: 11 }, (_, i) => ({ step: '验证步骤 ' + (i + 1),
        status: i < 3 ? 'completed' : i === 3 ? 'in_progress' : 'pending' })) };
      window.summaryPlanMessages = chatProps.messages;
      renderSummaryLayout({ sending: true, activeTurnId: 'summary-turn',
        messages: chatProps.messages.map(message => message.role === 'assistant'
          ? { ...message, taskPlan: summaryPlan } : message) });`);
    await pause(650);
    const beforeHover = await run(`({ ...summaryBounds(), scrollTop: document.querySelector('.message-list').scrollTop,
      scrollHeight: document.querySelector('.message-list').scrollHeight })`);
    await run(`document.querySelector('[data-work-summary-toggle]').dispatchEvent(
      new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))`);
    await until("!!document.querySelector('.conversation-work-summary.soft-panel-visible .runtime-plan-detail')", 'hover opens plan without clicking');
    await pause(250);
    const hovered = await run(`({ ...summaryBounds(), scrollTop: document.querySelector('.message-list').scrollTop,
      scrollHeight: document.querySelector('.message-list').scrollHeight })`);
    assert.equal(hovered.inset, 0, 'hover preview never docks or reflows the reading track');
    assert.equal(hovered.content.width, beforeHover.content.width);
    assert.equal(hovered.scrollTop, beforeHover.scrollTop);
    assert.equal(hovered.scrollHeight, beforeHover.scrollHeight);
    assert.equal(await run("document.querySelector('.message-list .runtime-plan-detail')"), null);
    window.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(hovered.toggle.left + 12),
      y: Math.round(hovered.toggle.bottom + 3) });
    await pause(300);
    assert.equal(await run("!!document.querySelector('.conversation-work-summary.soft-panel-visible')"), true,
      'slow travel through the toolbar gap retains the hover preview');
    window.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(hovered.toggle.left + 12),
      y: Math.round(hovered.summary.top + 20) });
    await pause(350);
    assert.equal(await run("!!document.querySelector('.conversation-work-summary.soft-panel-visible')"), true,
      'the summary stays open when moving from its button into the panel');
    await run(`renderSummaryLayout({ messages: chatProps.messages.map(message => message.role === 'assistant'
      ? { ...message, taskPlan: { ...summaryPlan, nodes: summaryPlan.nodes.map(node => ({ ...node, status: 'completed' })) } } : message) });`);
    await until("document.querySelectorAll('.work-summary-plan li.completed').length === 11", 'live plan updates inside hover');
    assert.equal(await run("document.querySelector('.message-list').scrollHeight"), beforeHover.scrollHeight, 'plan updates add no transcript height');
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tmp', 'summary-plan-hover.png'), (await window.capturePage()).toPNG());
    await run(`window.summaryMenuOriginal = cardbushDesktop.showFileContextMenu;
      window.summaryReportsOriginal = chatProps.changeReports;
      cardbushDesktop.showFileContextMenu = () => new Promise(resolve => { window.finishSummaryMenu = resolve; });
      renderSummaryLayout({ changeReports: chatProps.changeReports.map(report => ({ ...report,
        files: report.files.map(file => ({ ...file, path: 'C:/fixture/ChatPanel.tsx' })) })) });`);
    await until("document.querySelector('.work-summary-file-list button')?.title === 'C:/fixture/ChatPanel.tsx'", 'native menu fixture');
    await run(`document.querySelector('.work-summary-file-list button').dispatchEvent(
      new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      document.querySelector('.conversation-work-summary').dispatchEvent(
      new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' }));
      dispatchEvent(new Event('blur'));`);
    await pause(300);
    assert.equal(await run("!!document.querySelector('.conversation-work-summary.soft-panel-visible')"), true,
      'a native file menu retains its parent summary');
    await run(`finishSummaryMenu(''); cardbushDesktop.showFileContextMenu = summaryMenuOriginal;
      renderSummaryLayout({ changeReports: summaryReportsOriginal });`);
    await run("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await until("!document.querySelector('.conversation-work-summary')", 'Escape dismisses hover');
    await run(`document.querySelector('[data-work-summary-toggle]').dispatchEvent(
      new PointerEvent('pointerout', { bubbles: true, pointerType: 'mouse' }));
      renderSummaryLayout({ sending: false, activeTurnId: '', messages: summaryPlanMessages });`);
    await pause(200);
    await open();
    assert.equal(await run("document.querySelector('.work-summary-header h2').textContent"), '工作摘要');
    assert.equal(await run("document.querySelector('.work-summary-file-name').textContent"), 'ChatPanel.tsx');
    assert.deepEqual(await run("[...document.querySelectorAll('.work-summary-file-list small > *')].map(node => node.textContent)"), ['+24', '-3']);
    await run("document.querySelector('.work-summary-file-list button').click()");
    await until("summaryReviews[0] === 'src/features/chat/ChatPanel.tsx'", 'summary opens the selected file review');
    await run("document.querySelector('.work-summary-output-actions button').click()");
    await until('summaryReviews.length === 2 && summaryReviews[1] === null', 'summary opens all changes');
    await run("window.summaryComposer = document.querySelector('.composer-surface textarea'); window.summaryScroller = document.querySelector('.message-list'); void 0;");
    for (const theme of ['theme-bright', 'theme-dark']) {
      for (const maximized of [false, true]) {
        await run(`window.viewTheme = ${JSON.stringify(theme)}; summaryPaneWidth = 1224; renderSummaryLayout({ windowMaximized: ${maximized}, inspectorOpen: false });`);
        await assertLayout(true);
        // No window resize: opening/dragging another pane must still switch modes.
        await run('summaryPaneWidth = 860; renderSummaryLayout({ inspectorOpen: true });');
        await assertLayout(false);
        await run('summaryPaneWidth = 1100; renderSummaryLayout({ inspectorOpen: false });');
        await assertLayout(true);
        await run('summaryPaneWidth = 1099; renderSummaryLayout({});');
        await assertLayout(false);
      }
    }
    assert.equal(await run("document.querySelector('.composer-surface textarea') === summaryComposer"), true, 'layout changes never remount the composer');
    assert.equal(await run("document.querySelector('.message-list') === summaryScroller"), true, 'layout changes keep the native scroll element');
    await run("document.querySelector('.chat-content-frame').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))");
    await until("!document.querySelector('.conversation-work-summary')", 'outside click dismisses overlay');
    await open();
    await run("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
    await until("!document.querySelector('.conversation-work-summary')", 'Escape dismisses overlay');
    await run('summaryPaneWidth = 1224; renderSummaryLayout({});');
    await open();
    await run("document.querySelector('.chat-content-frame').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))");
    await pause(300);
    await assertLayout(true);
    await run("document.querySelector('[data-work-summary-toggle]').click()");
    await until("!!document.querySelector('.conversation-work-summary.soft-panel-hidden')", 'exit starts');
    await pause(100);
    const duringExit = await run('summaryBounds()');
    assert.ok(duringExit.inset > 0 && duringExit.inset < 390, 'chat expands during the summary exit, not after unmount');
    assert.equal(duringExit.list.right, duringExit.body.right, 'scrollbar stays at the outer edge throughout the exit');
    await until("!document.querySelector('.conversation-work-summary')", 'exit unmounts the summary');
    await pause(80);
    assert.equal(await run("parseFloat(getComputedStyle(document.querySelector('.message-list-content')).marginRight)"), 0);

    await run(`renderSummaryLayout({ windowMaximized: false, messages: [
      ...Array.from({ length: 12 }, (_, i) => ({ id: 'summary-history-' + i,
        role: i % 2 ? 'assistant' : 'user', turnId: 'summary-history-turn-' + Math.floor(i / 2),
        content: i % 2 ? '正文在左侧保留独立的阅读空间，工作摘要在右侧固定显示。\\n\\n滚动聊天记录时，摘要和输入框保持原位。' : '查看第 ' + (Math.floor(i / 2) + 1) + ' 条执行记录',
      })), ...chatProps.messages,
    ] });`);
    await open();
    await window.webContents.debugger.attach('1.3');
    try {
      await until('summaryScroller.scrollHeight > summaryScroller.clientHeight * 2', 'long conversation can scroll');
      const layout = await run('summaryBounds()');
      const before = await run('summaryScroller.scrollTop');
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: Math.round(layout.composer.left + 60), y: Math.round(layout.list.top + 180), deltaX: 0, deltaY: -240,
      });
      await until(`summaryScroller.scrollTop < ${before - 50}`, 'native wheel scrolls the conversation');
      await run('summaryScroller.scrollTop = 0');
      await pause(200);
      const bar = await run(`(() => { const rect = summaryScroller.getBoundingClientRect();
        const width = summaryScroller.offsetWidth - summaryScroller.clientWidth;
        const track = summaryScroller.clientHeight - width * 2;
        return { x: Math.floor(rect.right - width / 2), width,
          y: Math.round(rect.top + width + Math.max(36, track * summaryScroller.clientHeight / summaryScroller.scrollHeight) / 2),
          endY: Math.round(rect.top + summaryScroller.clientHeight * 0.7) };
      })()`);
      assert.ok(bar.width > 0 && bar.x > layout.summary.right, 'visible native scrollbar is to the right of the summary');
      for (const event of [
        { type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1, y: bar.y },
        { type: 'mouseMoved', button: 'left', buttons: 1, y: bar.endY },
        { type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1, y: bar.endY },
      ]) await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { x: bar.x, ...event });
      await until('summaryScroller.scrollTop > 200', 'dragging the outer native scrollbar scrolls the conversation');
      await assertLayout(true);
      const after = await run('summaryBounds()');
      assert.deepEqual(after.composer, layout.composer, 'composer stays fixed while the transcript scrolls');
      assert.deepEqual(after.summary, layout.summary, 'summary stays fixed while the transcript scrolls');
      assert.equal(await run("document.querySelector('.chat-body').scrollTop"), 0, 'outer pane never scrolls');
    } finally {
      window.webContents.debugger.detach();
    }

    await run("document.querySelector('[data-work-summary-toggle]').click()");
    await until("!document.querySelector('.conversation-work-summary')", 'summary closes over long conversation');
    await run("viewTheme = 'theme-dark'; summaryPaneWidth = 1170; renderSummaryLayout({});");
    await until("document.querySelector('.chat-body').clientWidth === 1170", 'closed summary layout settles');
    await pause(300);
    const centered = await run('summaryBounds()');
    assert.ok(centered.scrollbar > 0, 'centering includes a real native scrollbar');
    assertCentered(centered);
    assert.equal(await run('summaryScroller.scrollWidth <= summaryScroller.clientWidth'), true,
      'scrollbar compensation does not create hidden horizontal overflow');
    console.log('Centered conversation margins:', JSON.stringify({
      left: centered.message.left - centered.body.left,
      right: centered.body.right - centered.message.right,
      scrollbar: centered.scrollbar,
    }));
    fs.writeFileSync(path.join(root, 'tmp', 'chat-centered-dark.png'), (await window.webContents.capturePage({
      x: Math.round(centered.body.left), y: 0, width: 1170, height: 760,
    })).toPNG());
    await run('summaryPaneWidth = 1224; renderSummaryLayout({});');

    for (const theme of ['theme-bright', 'theme-dark']) {
      await run(`viewTheme = ${JSON.stringify(theme)}; renderSummaryLayout({ windowMaximized: false });`);
      await open();
      fs.writeFileSync(path.join(root, 'tmp', 'work-summary-layout-' + theme + '.png'), (await window.webContents.capturePage()).toPNG());
    }
    window.setContentSize(1456, 400);
    await run('summaryPaneWidth = 500; renderSummaryLayout({});');
    await assertLayout(false);
    fs.writeFileSync(path.join(root, 'tmp', 'work-summary-layout-overlay.png'), (await window.webContents.capturePage()).toPNG());
    await run('summaryPaneWidth = 320; renderSummaryLayout({});');
    await assertLayout(false);
    await window.webContents.debugger.attach('1.3');
    try {
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await run("document.querySelector('[data-work-summary-toggle]').click()");
      await until("!document.querySelector('.conversation-work-summary')", 'reduced motion closes summary');
      await open();
      assert.equal(await run("getComputedStyle(document.querySelector('.chat-content-frame')).transitionDuration"), '0s');
    } finally {
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
      window.webContents.debugger.detach();
    }
    console.log('Work summary: output details and review actions, outer native scrollbar wheel/drag, container breakpoint, track alignment, composer preservation, themes, dismissal and motion passed.');
  } finally {
    await run('window.viewTheme = summaryOriginal.theme; Object.assign(chatProps, summaryOriginal.props); updateChat({});');
    window.setContentSize(...originalSize);
    await window.webContents.removeInsertedCSS(fixtureCss);
  }
};
