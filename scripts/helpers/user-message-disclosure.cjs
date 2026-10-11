const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  const content = [
    '请检查插件的实际连接与工具目录，修复后重新验证。'.repeat(12), '',
    '```json', JSON.stringify({ application: 'CardBush', entries: Array.from({ length: 30 }, (_, i) => ({ name: 'entry-' + i, enabled: true })) }, null, 2),
    '```', '', '[最后一条参考](https://example.com/reference)', '', '这是消息末尾，复制和编辑必须保留。',
  ].join('\n');
  await run(`
    window.userDisclosureSaved = { ...chatProps };
    window.userDisclosureTheme = window.viewTheme;
    window.userDisclosureClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    window.userDisclosureCopied = '';
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { userDisclosureCopied = text; } } });
    window.userDisclosureContent = ${JSON.stringify(content)};
    window.userDisclosureMessage = { id: 'user-disclosure', role: 'user', content: userDisclosureContent, turnId: 'disclosure-turn',
      attachments: [{ id: 'log', kind: 'file', path: 'D:/fixture/log.json', name: 'log.json', size: 500 }] };
    window.showUserDisclosure = patch => {
      Object.assign(chatProps, { loading: false, historyLoading: false, sending: false, language: 'zh',
        activeConversationId: 'user-disclosure-session', draft: '', error: null, ...patch });
      renderView(h('section', { className: 'main-stage', style: { width: '900px', flex: '1 1 auto' } }, h(views.ChatPanel, chatProps)));
    };
    window.userDisclosureBubble = () => document.querySelector('[data-message-id="user-disclosure"]');
    window.userDisclosureToggle = () => userDisclosureBubble()?.querySelector('.user-message-toggle');
    showUserDisclosure({ messages: [{ ...userDisclosureMessage, content: '一句很短的提问。', attachments: [] }] });
  `);
  try {
    await until("userDisclosureBubble()?.textContent.includes('一句很短的提问。')", 'short question');
    await pause();
    assert.equal(await run('!!userDisclosureToggle()'), false, 'short questions remain complete without a toggle');
    for (const theme of ['theme-dark', 'theme-bright']) {
      await run(`viewTheme = ${JSON.stringify(theme)}; showUserDisclosure({ messages: [userDisclosureMessage] });`);
      await until("userDisclosureToggle()?.textContent === '展示更多' && !!userDisclosureBubble().querySelector('code.language-json')", 'long question after lazy Markdown');
      const preview = await run(`(() => {
        const bubble = userDisclosureBubble();
        const viewport = bubble.querySelector('.user-message-viewport');
        return { height: viewport.clientHeight, natural: bubble.querySelector('.user-message-body').clientHeight,
          overflow: getComputedStyle(viewport).overflowY,
          attachmentOutside: !viewport.contains(bubble.querySelector('.message-file-attachment')),
          controls: userDisclosureToggle().getAttribute('aria-controls') === viewport.id };
      })()`);
      assert.ok(preview.height > 100 && preview.height < 160 && preview.natural > 600, 'long text has a compact preview');
      assert.equal(preview.overflow, 'clip', 'the bubble never becomes an inner scrolling area');
      assert.equal(preview.attachmentOutside, true, 'attachments stay available outside folded prose');
      assert.equal(preview.controls, true);
      await run('document.querySelector(".message-list").scrollTop = 0');
      await pause(180);
      fs.writeFileSync(path.join(root, 'tmp', 'user-message-disclosure-' + theme + '.png'), (await window.capturePage()).toPNG());
      await run('userDisclosureBubble().querySelector(".message-actions button").click()');
      await until('userDisclosureCopied === userDisclosureContent', 'copy keeps the entire original message');
      await run('userDisclosureBubble().querySelector(".message-actions button:nth-child(2)").click()');
      await until('!!document.querySelector(".user-edit-card textarea")', 'edit opens');
      assert.equal(await run('document.querySelector(".user-edit-card textarea").value'), content, 'editing never receives a shortened prompt');
      await run('document.querySelector(".message-edit-actions button").click()');
      await until('!!userDisclosureToggle()', 'cancel returns to preview');

      // An actual conversation with enough following content to expose jumps.
      await run(`showUserDisclosure({ messages: [userDisclosureMessage,
        { id: 'disclosure-answer', role: 'assistant', content: '后续回答。\\n\\n'.repeat(50), status: 'completed' }] });`);
      await pause(350);
      await run(`
        window.userDisclosureList = document.querySelector('.message-list');
        userDisclosureList.scrollTop = 0;
        window.userDisclosureBefore = userDisclosureBubble().getBoundingClientRect().top;
        window.userDisclosureMarkdown = userDisclosureBubble().querySelector('.markdown-content');
        userDisclosureToggle().click();
        window.userDisclosureCommit = { before: userDisclosureBefore, after: userDisclosureBubble().getBoundingClientRect().top,
          scroll: userDisclosureList.scrollTop, height: userDisclosureList.scrollHeight, motion: userDisclosureList.dataset.scrollAnimating };
      `);
      await pause(250);
      assert.equal(await run('userDisclosureToggle().getAttribute("aria-expanded")'), 'true');
      assert.ok(await run('Math.abs(userDisclosureBubble().getBoundingClientRect().top - userDisclosureBefore) < 2'), 'expansion preserves the beginning of the question: ' + JSON.stringify(await run('({ ...userDisclosureCommit, finalTop: userDisclosureBubble().getBoundingClientRect().top, finalScroll: userDisclosureList.scrollTop })')));
      assert.equal(await run('userDisclosureMarkdown === userDisclosureBubble().querySelector(".markdown-content")'), true, 'expansion does not rebuild the Markdown');
      assert.ok(await run(`(() => { const v = userDisclosureBubble().querySelector('.user-message-viewport'); return v.clientHeight >= v.scrollHeight - 1; })()`), 'expanded text is fully visible');
      await run(`
        userDisclosureList.scrollTop += userDisclosureToggle().getBoundingClientRect().top - userDisclosureList.getBoundingClientRect().top - 300;
      `);
      await pause(180);
      await run('userDisclosureBefore = userDisclosureToggle().getBoundingClientRect().top; userDisclosureToggle().click();');
      await pause(250);
      assert.equal(await run('userDisclosureToggle().getAttribute("aria-expanded")'), 'false');
      assert.ok(await run('Math.abs(userDisclosureToggle().getBoundingClientRect().top - userDisclosureBefore) < 2'), 'collapse keeps the clicked control in view');
      assert.equal(await run('userDisclosureList.dataset.cardbushPreserveScroll'), undefined, 'scroll protection releases after toggling');
    }

    // The same text can fit on a wide pane and need folding on a narrow pane.
    await run(`showUserDisclosure({ messages: [{ ...userDisclosureMessage, attachments: [], content: '这是用于检查宽度变化的文本。'.repeat(9) }] });`);
    await until('!userDisclosureToggle()', 'medium question fits normally');
    await run('userDisclosureBubble().querySelector(".user-bubble").style.maxWidth = "220px"');
    await until('!!userDisclosureToggle()', 'narrow pane wraps into more lines');
    await run('userDisclosureToggle().click(); userDisclosureBubble().querySelector(".user-bubble").style.maxWidth = "465px";');
    await until('!userDisclosureToggle()', 'widening removes an unnecessary toggle');
    await run('userDisclosureBubble().querySelector(".user-bubble").style.maxWidth = "220px"');
    await until('userDisclosureToggle()?.getAttribute("aria-expanded") === "false"', 'overflow defaults back to a preview');
    await run(`showUserDisclosure({ messages: [userDisclosureMessage] }); userDisclosureBubble().querySelector('.user-bubble').style.maxWidth = '';`);
    await until(`!!userDisclosureBubble().querySelector('a[href="https://example.com/reference"]')`, 'reference near the end');
    const ownsDebugger = !window.webContents.debugger.isAttached();
    if (ownsDebugger) window.webContents.debugger.attach('1.3');
    try {
      await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
      await run(`userDisclosureBubble().querySelector('a[href="https://example.com/reference"]').focus()`);
      await until('userDisclosureToggle()?.getAttribute("aria-expanded") === "true"', 'keyboard focus reveals clipped controls');
      assert.ok(await run(`(() => {
        const focused = document.activeElement.getBoundingClientRect();
        const list = document.querySelector('.message-list').getBoundingClientRect();
        return focused.top >= list.top && focused.bottom <= list.bottom;
      })()`), 'keyboard focus must be visible after expanding');
    } finally {
      await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false });
      if (ownsDebugger) window.webContents.debugger.detach();
    }
    await run(`showUserDisclosure({ language: 'en', messages: [{ ...userDisclosureMessage, id: 'another-user-message' }] });`);
    await until('document.querySelector(".user-message-toggle")?.textContent === "Show more"', 'another message starts collapsed, with localized labels');
    console.log('User message disclosure passed: compact preview, full copy/edit, both themes, responsive wrapping, stable scroll and keyboard access.');
  } finally {
    await run(`
      if (userDisclosureClipboard) Object.defineProperty(navigator, 'clipboard', userDisclosureClipboard);
      else delete navigator.clipboard;
      viewTheme = userDisclosureTheme;
      Object.assign(chatProps, userDisclosureSaved);
      updateChat({});
    `);
  }
};
