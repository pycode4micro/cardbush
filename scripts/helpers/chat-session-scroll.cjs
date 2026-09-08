const assert = require('node:assert/strict');

module.exports = async ({ run, until, pause, theme = 'theme-dark' }) => {
  await run(`
    window.viewTheme = ${JSON.stringify(theme)};
    window.scrollSessions = Object.fromEntries(['a', 'b'].map(name => [name, {
      activeConversationId: 'scroll-' + name + '-' + viewTheme,
      messages: Array.from({ length: 32 }, (_, i) => ({
        id: 'scroll-' + name + '-' + i, role: i % 2 ? 'assistant' : 'user',
        content: ('Conversation ' + name + ', message ' + i + '.\\n\\n').repeat(6),
        turnId: 'scroll-turn-' + name + '-' + Math.floor(i / 2),
      })), sending: name === 'a', activeTurnId: name === 'a' ? 'scroll-turn-a-15' : '',
    }]));
    window.selectScrollSession = name => updateChat({ ...scrollSessions[name], loading: false, historyLoading: false });
    window.scrollList = () => document.querySelector('.message-list');
    window.scrollReadings = {};
    window.rememberScrollReading = name => {
      const list = scrollList();
      const item = [...list.querySelectorAll('.message-list-item')].find(item => item.getBoundingClientRect().bottom > list.getBoundingClientRect().top);
      scrollReadings[name] = { id: item.dataset.messageId, offset: item.getBoundingClientRect().top - list.getBoundingClientRect().top };
    };
    window.readScrollHistory = top => {
      scrollList().dispatchEvent(new WheelEvent('wheel', { deltaY: -200, bubbles: true, cancelable: true }));
      scrollList().scrollTop = top;
    };
    window.scrollFrames = [];
    window.sampleScrollSession = name => {
      cancelAnimationFrame(window.scrollSampleFrame);
      scrollFrames = [];
      const sample = () => {
        const list = scrollList();
        if (list?.querySelector('[data-message-id="scroll-' + name + '-0"]')) {
          const reading = scrollReadings[name];
          const item = reading && list.querySelector('[data-message-id="' + reading.id + '"]');
          scrollFrames.push({ top: list.scrollTop, bottom: list.scrollHeight - list.clientHeight,
            offset: item ? item.getBoundingClientRect().top - list.getBoundingClientRect().top : null });
        }
        window.scrollSampleFrame = requestAnimationFrame(sample);
      };
      window.scrollSampleFrame = requestAnimationFrame(sample);
    };
    selectScrollSession('a');
  `);
  await until("!!document.querySelector('[data-message-id=scroll-a-31]')", 'scroll fixture mounted');
  await pause(500);
  await run('readScrollHistory(1400)');
  await pause(100);
  const aTop = await run('scrollList().scrollTop');
  await run("rememberScrollReading('a')");
  await run("selectScrollSession('b')");
  await until("!!document.querySelector('[data-message-id=scroll-b-31]')", 'other scroll session');
  await pause(500);
  await run('readScrollHistory(700)');
  await pause(100);
  const bTop = await run('scrollList().scrollTop');
  await run("rememberScrollReading('b')");

  async function assertRestored(name, expectedTop) {
    await run(`sampleScrollSession('${name}'); selectScrollSession('${name}')`);
    await until(`!!document.querySelector('[data-message-id=scroll-${name}-31]')`, 'return to ' + name);
    await pause(450);
    await run('cancelAnimationFrame(scrollSampleFrame)');
    const frames = await run('scrollFrames');
    const reading = await run(`scrollReadings['${name}']`);
    assert.ok(frames.length > 0, 'restoration samples real rendered frames');
    assert.ok(frames.every(frame => Math.abs(frame.offset - reading.offset) < 2),
      `Session ${name} must restore the same content before the first frame and keep it: expected offset ${reading.offset} (top ${expectedTop}), got ${JSON.stringify(frames)}`);
    assert.equal(await run('scrollList().hasAttribute("data-scroll-restoring")'), false, 'restoration must hand control back after layout');
    assert.equal(await run('getComputedStyle(scrollList().querySelector(".message-list-item")).contentVisibility'), 'auto', 'history returns to lazy layout after restoration');
  }

  await assertRestored('a', aTop);
  await assertRestored('b', bTop);
  // A keeps receiving output while its reader is in B.
  await run(`scrollSessions.a.messages = scrollSessions.a.messages.map((message, i) =>
    i === 31 ? { ...message, content: message.content + 'Background output.\\n\\n'.repeat(18) } : message)`);
  await assertRestored('a', aTop);
  const liveReadingTop = await run('scrollList().scrollTop');
  await run(`scrollSessions.a.messages = scrollSessions.a.messages.map((message, i) =>
    i === 31 ? { ...message, content: message.content + 'Visible output.\\n\\n'.repeat(8) } : message); selectScrollSession('a')`);
  await pause(200);
  assert.ok(Math.abs(await run('scrollList().scrollTop') - liveReadingTop) < 2, 'restored history stays detached during live output');

  // Remember the content anchor when earlier content reflows while away.
  const anchor = await run(`(() => {
    const list = scrollList();
    const item = [...list.querySelectorAll('.message-list-item')].find(item => item.getBoundingClientRect().bottom > list.getBoundingClientRect().top);
    return { id: item.dataset.messageId, offset: item.getBoundingClientRect().top - list.getBoundingClientRect().top };
  })()`);
  await assertRestored('b', bTop);
  await run(`scrollSessions.a.messages = scrollSessions.a.messages.map((message, i) =>
    i === 0 ? { ...message, content: message.content + 'Loaded earlier content.\\n\\n'.repeat(5) } : message);
    updateChat({ ...scrollSessions.a, messages: [], loading: true, historyLoading: true });`);
  await until("!!document.querySelector('.loading-view')", 'history loading between mounts');
  await pause(60);
  await run("selectScrollSession('a')");
  await until("!!document.querySelector('[data-message-id=scroll-a-31]')", 'history remount');
  await pause(350);
  const restoredOffset = await run(`document.querySelector('[data-message-id="${anchor.id}"]').getBoundingClientRect().top - scrollList().getBoundingClientRect().top`);
  assert.ok(Math.abs(restoredOffset - anchor.offset) < 2,
    'history reload restores the visible message anchor after reflow: ' + JSON.stringify({ anchor, restoredOffset, top: await run('scrollList().scrollTop') }));

  // A following reader returns directly to the current tail, even if the
  // background turn completed. B must retain its independent history position.
  await run("document.querySelector('.scroll-bottom').click()");
  await pause(180);
  await assertRestored('b', bTop);
  await run(`scrollSessions.a.messages = scrollSessions.a.messages.map((message, i) =>
    i === 31 ? { ...message, content: message.content + 'Completed while away.\\n\\n'.repeat(12) } : message);
    scrollSessions.a.sending = false; scrollSessions.a.activeTurnId = '';
    sampleScrollSession('a'); selectScrollSession('a');`);
  await until("!!document.querySelector('[data-message-id=scroll-a-31]')", 'completed background turn');
  await pause(500);
  await run('cancelAnimationFrame(scrollSampleFrame)');
  const tailFrames = await run('scrollFrames');
  assert.ok(tailFrames.length > 0 && tailFrames.every(frame => Math.abs(frame.top - frame.bottom) < 2),
    'a following reader must enter at the current bottom without replaying intermediate positions: ' + JSON.stringify(tailFrames));
  await assertRestored('b', bTop);

  await run("scrollSessions.a.sending = true; scrollSessions.a.activeTurnId = 'scroll-turn-a-15'; selectScrollSession('a')");
  await pause(180);
  const followingTop = await run('scrollList().scrollTop');
  await run(`scrollSessions.a.messages = scrollSessions.a.messages.map((message, i) =>
    i === 31 ? { ...message, content: message.content + 'Follow new live output.\\n\\n'.repeat(10) } : message); selectScrollSession('a')`);
  await pause(550);
  assert.ok(await run('scrollList().scrollTop') > followingTop + 100, 'a restored following reader keeps following new output');

  // Leave with a live-follow callback queued, then change again during the
  // next restoration. Neither callback may move the other conversation.
  await run(`sampleScrollSession('b');
    scrollSessions.a.messages = scrollSessions.a.messages.map((message, i) =>
      i === 31 ? { ...message, content: message.content + 'Pending follow.\\n\\n'.repeat(12) } : message);
    selectScrollSession('a'); requestAnimationFrame(() => selectScrollSession('b'));`);
  await until("!!document.querySelector('[data-message-id=scroll-b-31]')", 'leave scheduled live follow');
  await pause(150);
  await run("selectScrollSession('a'); requestAnimationFrame(() => selectScrollSession('b'))");
  await until("!!document.querySelector('[data-message-id=scroll-b-31]')", 'rapid return');
  await pause(150);
  await run('cancelAnimationFrame(scrollSampleFrame)');
  const rapidFrames = await run('scrollFrames');
  const bReading = await run('scrollReadings.b');
  assert.ok(rapidFrames.length > 0 && rapidFrames.every(frame => Math.abs(frame.offset - bReading.offset) < 2),
    'pending restoration and follow work must not affect another session');

  // Exercise the real composer submit path, including its reserved response
  // stage. Session restoration must not replace a fresh submission's anchor.
  await run(`
    window.previousScrollTestSend = chatProps.onSend;
    scrollSessions.a.sending = false; scrollSessions.a.activeTurnId = '';
    selectScrollSession('a');
    updateChat({ draft: 'New request anchor', onSend: async text => {
      scrollSessions.a.messages = [...scrollSessions.a.messages,
        { id: 'scroll-submitted-user', role: 'user', content: text, turnId: 'scroll-submitted-turn' },
        { id: 'scroll-submitted-assistant', role: 'assistant', content: '', turnId: 'scroll-submitted-turn' }];
      scrollSessions.a.sending = true; scrollSessions.a.activeTurnId = 'scroll-submitted-turn';
      updateChat({ ...scrollSessions.a, draft: '' });
    }});
  `);
  await until("document.querySelector('.composer textarea')?.value === 'New request anchor' || document.querySelector('textarea')?.value === 'New request anchor'", 'new request draft');
  await pause(150);
  await run("document.querySelector('.send-button').click()");
  await until("!!document.querySelector('[data-message-id=scroll-submitted-user]')", 'fresh submitted user');
  await pause(600);
  const submittedOffset = await run("document.querySelector('[data-message-id=scroll-submitted-user]').getBoundingClientRect().top - scrollList().getBoundingClientRect().top");
  const desiredOffset = await run('Math.round(Math.min(56, Math.max(34, scrollList().clientHeight * 0.07)))');
  assert.equal(await run("scrollList().style.getPropertyValue('--submitted-user-reading-anchor')"), desiredOffset + 'px',
    'new requests still use the submission focus path');
  assert.ok(submittedOffset >= 0 && submittedOffset < await run("document.querySelector('.composer-dock').getBoundingClientRect().top - scrollList().getBoundingClientRect().top"),
    'new requests remain visible above the composer');
  await assertRestored('b', bTop);
  await run("selectScrollSession('a')");
  await until("!!document.querySelector('[data-message-id=scroll-submitted-user]')", 'reserved response stage restored');
  await pause(250);
  const returnedSubmissionOffset = await run("document.querySelector('[data-message-id=scroll-submitted-user]').getBoundingClientRect().top - scrollList().getBoundingClientRect().top");
  assert.ok(Math.abs(returnedSubmissionOffset - submittedOffset) < 2, 'switching preserves the reserved response stage and reading anchor');
  await run("updateChat({ onSend: previousScrollTestSend }); void 0;");
  console.log('Session scroll passed (' + theme + '): first-frame restore, independent readers, background output/completion, loading/reflow, rapid switches and fresh submission.');
};
