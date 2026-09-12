const assert = require('node:assert/strict');

module.exports = async ({ run, until, pause, window, theme = 'theme-dark' }) => {
  await run(`
    window.referenceScrollSaved = { props: { ...chatProps }, theme: viewTheme };
    window.viewTheme = ${JSON.stringify(theme)};
    window.referenceScrollPath = 'D:/window-reference-fixture/' + 'long-project-directory/'.repeat(8) + 'result.md';
    updateChat({ activeConversationId: 'reference-scroll-' + viewTheme, projectPathAliases: [],
      sending: false, activeTurnId: '', draft: '', messages: [
        { id: 'reference-question', role: 'user', content: 'Show the result.', turnId: 'reference-turn' },
        { id: 'reference-answer', role: 'assistant', turnId: 'reference-turn', status: 'completed',
          metadata: { transcript_kind: 'assistant_final' }, content:
            ('The completed result is ready.\\n\\n').repeat(9) + '- Output file: \\x60' + referenceScrollPath + '\\x60\\n\\n' +
            '\\x60\\x60\\x60text\\n' + 'Preserve code wrapping and resolved file links. '.repeat(8) + '\\n\\x60\\x60\\x60' },
        { id: 'reference-followup', role: 'user', content: 'Can I use it now?', turnId: 'reference-followup-turn' },
        { id: 'reference-final', role: 'assistant', content: 'Yes, the local result is ready.\\n\\nNo changes are pending.', turnId: 'reference-followup-turn' },
      ] });
  `);
  await until("document.querySelector('.local-file-reference')?.textContent.includes('result.md')", 'resolved file reference');
  await until("!!document.querySelector('.markdown-code-block button')", 'code block');
  await run("document.querySelector('.markdown-code-block button').click()");
  await until("!!document.querySelector('.markdown-code-block.wrapped')", 'wrapped code');
  await pause(600);
  window.webContents.debugger.attach('1.3');
  const focus = enabled => window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled });
  try {
    await focus(true);
    for (const mode of ['tail', 'history']) {
      if (mode === 'history') {
        await run(`{ const list = document.querySelector('.message-list');
          list.dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true, cancelable: true }));
          list.scrollTop = 150; }`);
      }
      await pause(350);
      await run(`
        window.referenceScrollLink = document.querySelector('.local-file-reference');
        window.referenceScrollCode = document.querySelector('.markdown-code-block');
        window.referenceScrollFrames = [];
        window.referenceScrollRemoved = 0;
        window.referenceScrollSample = () => {
          const list = document.querySelector('.message-list');
          return { top: list.scrollTop, height: list.scrollHeight,
            anchor: document.querySelector('[data-message-id=reference-followup]').getBoundingClientRect().top,
            title: document.querySelector('.topbar').getBoundingClientRect().top,
            dock: document.querySelector('.composer-dock').getBoundingClientRect().top,
            focused: document.hasFocus() };
        };
        window.referenceScrollRecord = () => {
          referenceScrollFrames.push(referenceScrollSample());
          window.referenceScrollFrame = requestAnimationFrame(referenceScrollRecord);
        };
        window.referenceScrollObserver = new MutationObserver(entries => {
          for (const entry of entries) for (const removed of entry.removedNodes) {
            if (removed === referenceScrollLink || removed.contains(referenceScrollLink) ||
                removed === referenceScrollCode || removed.contains(referenceScrollCode)) referenceScrollRemoved++;
          }
        });
        referenceScrollObserver.observe(document.querySelector('.message-list'), { childList: true, subtree: true });
        referenceScrollRecord();
      `);
      for (let i = 0; i < 3; i++) {
        await focus(false); await pause(100);
        await focus(true); await pause(100);
        // Focus refresh returns a new conversation/alias array even when no
        // project mappings changed, as seen in the captured native app trace.
        await run('updateChat({ projectPathAliases: chatProps.projectPathAliases.map(alias => ({ ...alias })) })');
        await pause(200);
      }
      await run('cancelAnimationFrame(referenceScrollFrame); referenceScrollObserver.disconnect()');
      const frames = await run('referenceScrollFrames');
      const stable = await run(`({ link: referenceScrollLink === document.querySelector('.local-file-reference'),
        code: referenceScrollCode === document.querySelector('.markdown-code-block'),
        wrapped: !!document.querySelector('.markdown-code-block.wrapped'), removed: referenceScrollRemoved })`);
      assert.deepEqual(stable, { link: true, code: true, wrapped: true, removed: 0 }, `${theme}/${mode}: refreshing conversation metadata must retain resolved links and code state`);
      assert.ok(frames.some(frame => frame.focused) && frames.some(frame => !frame.focused), 'real browser focus transitions');
      for (const key of ['top', 'height', 'anchor', 'title', 'dock']) {
        const values = frames.map(frame => frame[key]);
        assert.ok(Math.max(...values) - Math.min(...values) < 1, `${theme}/${mode}: ${key} moved: ${JSON.stringify(frames)}`);
      }
    }
    // A real mapping change must still update the destination; stable component
    // types must not capture the initial context and leave stale file links.
    await run("updateChat({ projectPathAliases: [{ from: 'D:/window-reference-fixture', to: 'D:/relocated-reference-fixture' }] })");
    await until("document.querySelector('.local-file-reference')?.getAttribute('title')?.startsWith('D:/relocated-reference-fixture/')", 'updated file destination');
    assert.equal(await run("!!document.querySelector('.markdown-code-block.wrapped')"), true, 'mapping updates preserve code wrapping');
    console.log('Window reference scroll passed (' + theme + '): repeated focus/metadata refresh, retained file DOM and code state, stable tail/history, live path remapping.');
  } finally {
    await run('cancelAnimationFrame(window.referenceScrollFrame); window.referenceScrollObserver?.disconnect(); window.viewTheme = referenceScrollSaved.theme; updateChat(referenceScrollSaved.props); void 0');
    window.webContents.debugger.detach();
    await pause(200);
  }
};
