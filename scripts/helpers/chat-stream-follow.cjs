const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  await run(`
    window.followReports = [];
    window.followSegments = [{ id: 'follow-answer', role: 'assistant', turnId: 'follow-turn',
      content: Array.from({length: 32}, (_, i) => '已完成检查 ' + i + '，继续处理后续内容。').join('\\n\\n') }];
    window.renderFollow = () => updateChat({ activeConversationId: 'follow-fixture',
      messages: [{ id: 'follow-user', role: 'user', content: '检查连续输出', turnId: 'follow-turn' }, ...followSegments],
      sending: true, activeTurnId: 'follow-turn', activeGoal: null, changeReports: followReports });
    renderFollow();
  `);
  await until("!!document.querySelector('.message-row.streaming .assistant-activity-line')", 'stream tail');
  await pause(700);
  const beforeEmpty = await run("document.querySelector('.message-list').scrollHeight");
  await run(`window.followStatus = document.querySelector('.assistant-activity-line');
    followSegments = [...followSegments, { id: 'follow-empty', role: 'assistant', turnId: 'follow-turn', content: '' }];
    renderFollow();`);
  await pause(650);
  assert.equal(await run("document.querySelector('.message-list').scrollHeight"), beforeEmpty,
    'an empty new assistant segment must not reserve a blank row');
  assert.equal(await run("followStatus === document.querySelector('.assistant-activity-line')"), true, 'empty rounds retain the existing activity slot');
  await run(`
    window.followList = document.querySelector('.message-list');
    window.followParagraph = document.querySelector('.assistant-active-transcript .markdown-content p');
    window.followFrames = [];
    window.sampleFollow = () => {
      followFrames.push({ top: followList.scrollTop, height: followList.scrollHeight,
        motion: followList.dataset.scrollAnimating || '', connected: followParagraph.isConnected });
      window.followFrame = requestAnimationFrame(sampleFollow);
    };
    sampleFollow();
    followSegments = [...followSegments, {id: 'follow-tool', role: 'assistant', content: '',
      turnId: 'follow-turn', toolExecutions: [{ id: 'new-tool', name: 'terminal_exec', state: 'running',
      summary: '检查新增工具', output: '', metadata: {}, contentOffset: 0, contentOffsetExplicit: true }] }];
    renderFollow();
  `);
  await pause(550);
  await run(`
    followSegments = [...followSegments, {id: 'follow-next', role: 'assistant', turnId: 'follow-turn',
      content: '这是一段新增的说明。\\n\\n内容应自然进入可见区域，不能先跳到底部再调整位置。' }];
    renderFollow();
  `);
  await pause(550);
  await run('cancelAnimationFrame(followFrame)');
  const frames = await run('followFrames');
  const jumps = frames.slice(1).map((frame, i) => ({ delta: frame.top - frames[i].top, ...frame }));
  assert.ok(frames.every(frame => frame.connected), 'existing prose remains mounted');
  assert.ok(jumps.every(frame => frame.delta >= -2), 'append never bounces upward');
  assert.ok(frames.every(frame => !frame.motion), 'stream growth never starts a scrolling animation');
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].height === frames[i - 1].height) {
      assert.ok(Math.abs(frames[i].top - frames[i - 1].top) < 2,
        'unchanged layout must not be chased by delayed follow frames: ' + JSON.stringify(frames.slice(Math.max(0, i - 2), i + 2)));
    }
  }
  const bottomGap = await run('followList.scrollHeight - followList.clientHeight - followList.scrollTop');
  assert.ok(Math.abs(bottomGap) <= 1, 'stream following reaches the native bottom, not just the visible last line: gap=' + bottomGap);
  // State-only transitions use the same tool row and consume no new line.
  const height = await run('followList.scrollHeight');
  await run(`window.followToolRow = document.querySelector('.tool-execution-block');
    followSegments = followSegments.map(segment => segment.id === 'follow-tool' ? { ...segment,
      toolExecutions: segment.toolExecutions.map(tool => ({ ...tool, state: 'completed', success: true })) } : segment);
    renderFollow();`);
  await pause(650);
  assert.equal(await run('followToolRow.isConnected'), true, 'tool completion retains its row');
  assert.equal(await run('followList.scrollHeight'), height, 'tool completion does not reserve another row');
  // File-change capsules, composer height and zoom all change the footer.
  // The native bottom must stay attached across many growing and shrinking rows.
  await run(`window.followFileReports = views.changeReportsFromMessages([{
    id: 'follow-file-edit', role: 'assistant', turnId: 'follow-turn', content: '',
    toolExecutions: [{id: 'follow-edit', name: 'workspace_checkpoint', state: 'completed', success: true,
      summary: 'Workspace changes', output: '', turnId: 'follow-turn', metadata: {
        kind: 'file_change', workspaceCheckpoint: true,
        workspaceChanges: [{path: 'src/example.ts', status: 'modified', additions: 143, deletions: 0}]
      }}]
  }]);
  window.followMetrics = () => ({top: followList.scrollTop,
    gap: followList.scrollHeight - followList.clientHeight - followList.scrollTop,
    space: parseFloat(followList.querySelector('.assistant-response-spacer').style.height) || 0,
    footer: followList.querySelector('.message-list-footer').getBoundingClientRect().height,
    capsule: !!document.querySelector('.composer-top-accessory .turn-change-review')});
  void 0;`);
  let maxGap = 0;
  for (const zoom of [1, 0.8, 1.25]) {
    await run(`document.querySelector('.app').style.zoom = '${zoom}';`);
    for (let i = 0; i < 8; i++) {
      await run(`followReports = ${i % 2 ? '[]' : 'followFileReports'};
        followSegments = followSegments.map(segment => segment.id === 'follow-next'
          ? { ...segment, content: '连续输出内容应保持跟随。\\n\\n'.repeat(${8 + i * 2}) } : segment);
        renderFollow();`);
      await pause(160);
      const current = await run('followMetrics()');
      maxGap = Math.max(maxGap, Math.abs(current.gap));
      assert.equal(current.capsule, i % 2 === 0, 'file capsule toggled during live output');
      // At CSS zoom Chromium rounds scrollHeight/clientHeight independently;
      // compare with its actual clamped bottom rather than demanding an
      // unattainable fractional scrollTop (e.g. a 1.25px residual at 80%).
      const native = Math.abs(current.gap) > 1 ? await run(`(() => {
        const previous = followList.scrollTop;
        followList.scrollTop = followList.scrollHeight;
        const actualBottom = followList.scrollTop;
        followList.scrollTop = previous;
        return actualBottom;
      })()`) : null;
      assert.ok(native === null || Math.abs(native - current.top) <= 0.5,
        'no bottom drift across output/capsule/zoom changes: ' + JSON.stringify({zoom, i, ...current, native}));
      if (zoom === 1 && i === 6) {
        await fs.writeFile(path.join(root, 'tmp', 'chat-bottom-follow-20261020.png'), (await window.webContents.capturePage()).toPNG());
      }
    }
    // Shrinking the already-overflowing reply can clamp scrollTop before its
    // scroll event arrives; that must not detach the next stream update.
    await run(`followSegments = followSegments.map(segment => segment.id === 'follow-next'
      ? { ...segment, content: '缩短输出。' } : segment); renderFollow();`);
    await pause(160);
    await run(`followSegments = [...followSegments, {id: 'follow-after-shrink-${zoom}', role: 'assistant',
      turnId: 'follow-turn', content: '缩短后继续输出。\\n\\n'.repeat(6)}]; renderFollow();`);
    await pause(160);
    const current = await run('followMetrics()');
    assert.ok(Math.abs(current.gap) <= 2 / zoom, 'a content shrink does not detach following: ' + JSON.stringify(current));
  }
  await run("document.querySelector('.app').style.removeProperty('zoom'); followReports = []; renderFollow();");
  await pause(200);
  console.log('Repeated stream/capsule/zoom updates: maximum native bottom gap ' + maxGap + 'px.');
  await run(`document.querySelector('[data-work-summary-toggle]').dispatchEvent(
    new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));`);
  await until("!!document.querySelector('.conversation-work-summary.soft-panel-visible')", 'summary hover during streaming');
  await run(`document.querySelector('.work-summary-overview').dispatchEvent(
    new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));`);
  const beforeSummaryRead = await run('followList.scrollTop');
  await run(`followSegments = [...followSegments, { id: 'follow-summary-reading', role: 'assistant', turnId: 'follow-turn',
    content: '查看摘要的滚轮不应误判为正文上翻，正文仍然继续跟随新内容。' }]; renderFollow();`);
  await pause(700);
  assert.ok(await run('followList.scrollTop') > beforeSummaryRead + 10, 'scrolling the summary does not detach transcript following');
  await run("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))");
  await until("!document.querySelector('.conversation-work-summary')", 'summary closed');
  await run(`followList.dispatchEvent(new WheelEvent('wheel', { deltaY: -240, bubbles: true, cancelable: true }));
    followList.scrollTop -= 300;`);
  await pause(300);
  const readingTop = await run('followList.scrollTop');
  await run(`followSegments = [...followSegments, { id: 'follow-reading', role: 'assistant', turnId: 'follow-turn',
    content: '历史阅读时到来的新内容。' }]; renderFollow();`);
  await pause(650);
  assert.ok(Math.abs(await run('followList.scrollTop') - readingTop) < 2, 'manual history reading remains undisturbed');
  // Submit through the real composer: a single response reservation is spent
  // by later rows, not re-created for each tool/assistant fragment.
  await run(`
    window.followSavedSend = chatProps.onSend;
    window.reserveMessages = Array.from({length: 12}, (_, i) => ({
      id: 'reserve-history-' + i, role: i % 2 ? 'assistant' : 'user',
      content: ('之前的记录 ' + i + '\\n\\n').repeat(5), turnId: 'reserve-history-turn-' + i
    }));
    updateChat({ activeConversationId: 'reserve-fixture', messages: reserveMessages,
      sending: false, activeTurnId: '', draft: '验证回复留白', onSend: async () => {
        reserveMessages = [...reserveMessages,
          { id: 'reserve-user', role: 'user', content: '验证回复留白', turnId: 'reserve-turn' },
          { id: 'reserve-assistant', role: 'assistant', content: '', turnId: 'reserve-turn' }];
        updateChat({ messages: reserveMessages, sending: true, activeTurnId: 'reserve-turn', draft: '' });
      } });
    window.readReserve = () => {
      const list = document.querySelector('.message-list'), tail = list.querySelector('.message-list-item:last-child');
      return { top: list.scrollTop, height: list.scrollHeight,
        space: parseFloat(list.querySelector('.assistant-response-spacer').style.height),
        contentHeight: list.querySelector('.message-list-content').getBoundingClientRect().height,
        userHeight: list.querySelector('[data-message-id="reserve-user"]').getBoundingClientRect().height,
        tailHeight: tail.getBoundingClientRect().height,
        userY: list.querySelector('[data-message-id="reserve-user"]').getBoundingClientRect().top,
        bottom: tail.getBoundingClientRect().bottom, visibleBottom: document.querySelector('.composer-surface').getBoundingClientRect().top - 18,
        motion: list.dataset.scrollAnimating || '' };
    };
    window.setReserveText = text => {
      reserveMessages = reserveMessages.map(m => m.id === 'reserve-assistant' ? {...m, content: text} : m);
      updateChat({messages: reserveMessages});
    };
    void 0;
  `);
  await until("!!document.querySelector('[data-message-id=reserve-history-11]')", 'reservation history');
  await pause(300);
  await run("document.querySelector('.send-button').click()");
  await until("!!document.querySelector('[data-message-id=reserve-user]')", 'reservation submitted');
  await pause(650);
  const reserved = await run('readReserve()');
  assert.ok(reserved.space > 80, 'submission provides actual response space');
  await run("setReserveText('在预留空间内自然显示的第一段。')");
  await pause(220);
  const filled = await run('readReserve()');
  assert.ok(filled.space < reserved.space, 'content consumes the existing response space');
  assert.ok(Math.abs(filled.top - reserved.top) < 2 && Math.abs(filled.height - reserved.height) < 2,
    'filled space keeps scroll geometry constant: ' + JSON.stringify({reserved, filled}));
  assert.ok(Math.abs(filled.userY - reserved.userY) < 2, 'the submitted reading position stays fixed');
  // Completion must not remove still-visible reserve and clamp scrollTop.
  await run(`window.completeFrames = []; window.completeSample = () => {
    completeFrames.push(readReserve()); window.completeFrame = requestAnimationFrame(completeSample);
  }; completeSample(); updateChat({sending: false, activeTurnId: ''})`);
  await pause(200);
  const completed = await run('readReserve()');
  const completionFrames = await run('cancelAnimationFrame(completeFrame); completeFrames');
  assert.ok(completionFrames.every(frame => Math.abs(frame.userY - filled.userY) < 2),
    'completion must be stable on every frame, including the first commit');
  assert.ok(Math.abs(completed.top - filled.top) < 2 && Math.abs(completed.userY - filled.userY) < 2,
    'a short completed answer retains its reading position: ' + JSON.stringify({filled, completed}));
  await run("updateChat({sending: true, activeTurnId: 'reserve-turn'}); setReserveText('持续输出的内容。\\n\\n'.repeat(32))");
  await pause(250);
  const overflowed = await run('readReserve()');
  assert.ok(overflowed.space < 1 && overflowed.top > filled.top, 'overflow follows after spending the reserve');
  assert.ok(Math.abs(await run("document.querySelector('.message-list').scrollHeight - document.querySelector('.message-list').clientHeight - document.querySelector('.message-list').scrollTop")) <= 1,
    'a submitted turn reaches the native bottom after consuming its reserve');
  assert.equal(overflowed.motion, '', 'overflow is a layout correction, not an animation');
  // An async image/tool body can resize without updating ChatPanel props.
  await run(`window.asyncBody = document.createElement('div');
    asyncBody.style.height = '90px';
    document.querySelector('.message-list-item.streaming .assistant-active-transcript').append(asyncBody);`);
  await pause(150);
  const asyncGrowth = await run('readReserve()');
  assert.ok(Math.abs((asyncGrowth.top - overflowed.top) - (asyncGrowth.height - overflowed.height)) < 2,
    'child-only growth is compensated by ResizeObserver before paint: ' + JSON.stringify({overflowed, asyncGrowth}));
  await pause(180);
  assert.ok(Math.abs((await run('readReserve()')).top - asyncGrowth.top) < 2, 'async growth leaves no delayed follow');
  await run(`const list = document.querySelector('.message-list');
    list.dispatchEvent(new WheelEvent('wheel', {deltaY: -240, bubbles: true, cancelable: true}));
    list.scrollTop -= 240;`);
  await pause(120);
  const manual = await run('readReserve()');
  await run("asyncBody.style.height = '180px'");
  await pause(200);
  assert.ok(Math.abs((await run('readReserve()')).top - manual.top) < 2,
    'child-only growth does not move a detached reader');
  await run('asyncBody.remove(); updateChat({onSend: followSavedSend})');
  console.log('Stream layout passed: stable DOM, no delayed chase, reserve consumption/completion, async growth and manual reading.');
};
