const assert = require('node:assert/strict');

module.exports = async ({ run, until, pause, window, theme = 'theme-bright' }) => {
  // Keep real Chromium layout, and replay its unchanged measurements in
  // different batches. Focus alone does not necessarily issue a resize.
  await run(`
    window.windowScrollSaved = { props: { ...chatProps }, theme: viewTheme };
    window.windowScrollObservers = new Map();
    window.NativeResizeObserver = ResizeObserver;
    window.ResizeObserver = class extends NativeResizeObserver {
      constructor(callback) {
        const latest = new Map();
        super((entries, observer) => {
          for (const entry of entries) latest.set(entry.target, entry);
          callback(entries, observer);
        });
        windowScrollObservers.set(this, { callback, latest });
      }
      disconnect() { windowScrollObservers.delete(this); super.disconnect(); }
    };
    window.viewTheme = ${JSON.stringify(theme)};
    updateChat({ activeConversationId: 'window-scroll-' + viewTheme, sending: false, activeTurnId: '',
      messages: Array.from({ length: 32 }, (_, i) => ({
        id: 'window-scroll-' + i, role: i % 2 ? 'assistant' : 'user',
        content: ('Window switching, message ' + i + '.\\n\\n').repeat(8),
        turnId: 'window-turn-' + Math.floor(i / 2),
      })), draft: '' });
    window.windowScrollFrames = [];
    window.windowScrollSample = () => {
      const list = document.querySelector('.message-list');
      const anchor = list?.querySelector('[data-message-id="' + window.windowScrollAnchor + '"]');
      return { top: list?.scrollTop, height: list?.scrollHeight, client: list?.clientHeight,
        anchor: anchor?.getBoundingClientRect().top, listTop: list?.getBoundingClientRect().top,
        dock: document.querySelector('.composer-dock')?.getBoundingClientRect().top,
        ancestors: ['.app', '.chat-panel', '.chat-body', '.chat-content-frame'].map(selector => document.querySelector(selector)?.scrollTop),
        focused: document.hasFocus(), active: document.activeElement?.tagName };
    };
    window.windowScrollRecord = () => {
      const frame = windowScrollSample();
      if (JSON.stringify(frame) !== JSON.stringify(windowScrollFrames.at(-1))) windowScrollFrames.push(frame);
      window.windowScrollFrame = requestAnimationFrame(windowScrollRecord);
    };
    void 0;
  `);
  await until("!!document.querySelector('[data-message-id=window-scroll-31]')", 'window scroll fixture');
  await pause(600);
  const contentSize = window.getContentSize();
  window.webContents.debugger.attach('1.3');
  const focus = enabled => window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled });
  try {
    await focus(true);
    for (const mode of ['tail', 'near-tail', 'history', 'draft']) {
      if (mode === 'near-tail') {
        await run(`{ const list = document.querySelector('.message-list'); list.scrollTop = list.scrollHeight - list.clientHeight - 24; }`);
        await pause(600);
      }
      if (mode === 'history') {
        await run(`{ const list = document.querySelector('.message-list');
          list.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true, cancelable: true }));
          list.scrollTop = 1500; }`);
      }
      if (mode === 'draft') await run("updateChat({ draft: 'Draft text\\n'.repeat(9) })");
      await pause(350);
      await run(`
        window.windowScrollAnchor = [...document.querySelectorAll('.message-list-item')].find(item => item.getBoundingClientRect().bottom > document.querySelector('.message-list').getBoundingClientRect().top).dataset.messageId;
        windowScrollFrames = []; window.windowScrollReplays = 0; windowScrollRecord();
        document.querySelector('[data-composer-input]').focus();
      `);
      for (let i = 0; i < 2; i++) {
        await focus(false); await pause(120);
        await focus(true); await pause(120);
        await run("dispatchEvent(new Event('resize')); updateChat({ skills: [], availableModels: [] })");
        await pause(120);
        await run(`for (const [observer, { callback, latest }] of windowScrollObservers) {
          const entry = [...latest.values()].find(entry => entry.target.matches('.message-list-content'));
          if (entry) { callback([...latest.values()], observer); callback([entry], observer); windowScrollReplays++; }
        }`);
        await pause(250);
      }
      await run('cancelAnimationFrame(windowScrollFrame)');
      const frames = await run('windowScrollFrames');
      assert.ok(await run('windowScrollReplays') > 0, 'exercise the real chat layout observer');
      assert.ok(frames.some(frame => frame.focused) && frames.some(frame => !frame.focused), 'exercise real document focus transitions');
      for (const frame of frames) {
        for (const key of ['top', 'height', 'client', 'anchor', 'listTop', 'dock']) {
          assert.ok(Math.abs(frame[key] - frames[0][key]) < 1,
            `${theme}/${mode}: unchanged layout must preserve ${key}: ${JSON.stringify(frames)}`);
        }
        assert.deepEqual(frame.ancestors, frames[0].ancestors, 'focus must not scroll enclosing panels');
      }
    }
    // A genuine resize must still follow the tail; disabling the observer
    // altogether would otherwise incorrectly satisfy the stability assertions.
    await run("document.querySelector('.scroll-bottom').click(); updateChat({ draft: '' })");
    await pause(550);
    const listHeight = await run("document.querySelector('.message-list').clientHeight");
    window.setContentSize(contentSize[0], contentSize[1] - 80);
    await until(`document.querySelector('.message-list').clientHeight < ${listHeight - 40}`, 'resized viewport');
    await pause(550);
    assert.ok(await run(`(() => { const list = document.querySelector('.message-list');
      return Math.abs(list.scrollHeight - list.clientHeight - list.scrollTop) < 2; })()`), 'real resize still follows the tail');
    console.log('Window scroll passed (' + theme + '): focus/blur, repeated resize delivery, tail/history/draft anchors and actual viewport resize.');
  } finally {
    await run('cancelAnimationFrame(windowScrollFrame); window.ResizeObserver = NativeResizeObserver; window.viewTheme = windowScrollSaved.theme; updateChat(windowScrollSaved.props); void 0');
    window.webContents.debugger.detach();
    window.setContentSize(...contentSize);
    await pause(200);
  }
};
