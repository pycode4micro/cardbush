const assert = require('node:assert/strict');

module.exports = async ({ run, until, pause, window, root, theme = 'theme-dark' }) => {
  await run(`
    window.viewTheme = ${JSON.stringify(theme)};
    window.appendHistory = Array.from({ length: 12 }, (_, i) => ({
      id: 'history-' + i, role: i % 2 ? 'assistant' : 'user',
      content: ('Earlier message ' + i + '\\n\\n').repeat(8), turnId: 'history-turn-' + i,
    }));
    window.appendSegments = [{ id: 'append-first', role: 'assistant', turnId: 'append-turn',
      content: 'Existing paragraph must remain mounted.' }];
    window.renderAppend = () => updateChat({ activeConversationId: 'append-' + viewTheme,
      messages: [...appendHistory, { id: 'append-user', role: 'user', content: 'Continue', turnId: 'append-turn' }, ...appendSegments],
      sending: true, activeTurnId: 'append-turn' });
    renderAppend();
  `);
  await until("document.querySelector('.message-row.streaming .markdown-content p')?.textContent === 'Existing paragraph must remain mounted.'", 'initial streaming paragraph');
  await pause(400);
  await run(`
    window.appendList = document.querySelector('.message-list');
    window.appendRow = document.querySelector('.message-row.streaming');
    window.appendParagraph = appendRow.querySelector('.markdown-content p');
    window.appendItem = appendRow.closest('.message-list-item');
    window.appendSnapshots = [];
    window.recordAppendFrame = () => {
      appendSnapshots.push({ top: appendList.scrollTop, height: appendList.scrollHeight,
        connected: appendParagraph.isConnected, rowConnected: appendRow.isConnected });
      window.appendFrame = requestAnimationFrame(recordAppendFrame);
    };
    recordAppendFrame();
    appendSegments = [{ ...appendSegments[0], toolExecutions: [{
      id: 'append-tool', name: 'terminal_exec', state: 'completed', summary: 'Read fixture',
      output: 'done', success: true, durationMs: 12, contentOffset: appendSegments[0].content.length,
      contentOffsetExplicit: true, createdAt: '2026-09-06T00:00:00Z', metadata: {},
    }] }];
    renderAppend();
  `);
  await pause(180);
  assert.equal(await run('appendParagraph.isConnected'), true, 'adding a tool must retain the existing paragraph DOM');
  for (let i = 1; i <= 5; i++) {
    await run(`appendSegments = [...appendSegments, { id: 'append-round-${i}', role: 'assistant', turnId: 'append-turn', content: 'New round ${i} appended below.' }]; renderAppend();`);
    await pause(100);
    assert.equal(await run('appendRow === document.querySelector(".message-row.streaming")'), true, 'next segment retains the assistant row');
    assert.equal(await run('appendParagraph.isConnected'), true, 'previous segment remains mounted');
  }
  await run(`window.appendTail = document.querySelector('[data-segment-id="append-round-5"] .markdown-content p'); void 0;`);
  for (let i = 0; i < 8; i++) {
    await run(`appendSegments = appendSegments.map((segment, index) => index === appendSegments.length - 1 ? { ...segment, content: segment.content + ' More streamed text.' } : segment); renderAppend();`);
    await pause(40);
    assert.equal(await run('appendTail.isConnected && appendParagraph.isConnected'), true, 'token updates keep both current and historical paragraph nodes');
  }
  await run('cancelAnimationFrame(appendFrame)');
  assert.equal(await run('appendList === document.querySelector(".message-list")'), true);
  const frames = await run('appendSnapshots');
  assert.ok(frames.every(frame => frame.connected && frame.rowConnected), 'no frame loses existing content');
  for (let i = 1; i < frames.length; i++) {
    assert.ok(frames[i].height >= frames[i - 1].height - 2, 'append-only output must not collapse list height');
    assert.ok(frames[i].top >= frames[i - 1].top - 2, 'automatic append must not jump back up the transcript');
  }
  assert.equal(await run('getComputedStyle(appendItem).contentVisibility'), 'visible', 'active output must use its real height');
  const fs = require('node:fs/promises');
  const path = require('node:path');
  await fs.mkdir(path.join(root, 'tmp'), { recursive: true });
  await fs.writeFile(path.join(root, 'tmp/chat-stream-append-' + theme + '.png'), (await window.capturePage()).toPNG());
  await run(`
    appendList.dispatchEvent(new WheelEvent('wheel', { deltaY: -250, bubbles: true, cancelable: true }));
    appendList.scrollTop = Math.max(0, appendList.scrollTop - 500);
  `);
  await pause(180);
  const detachedTop = await run('appendList.scrollTop');
  await run(`appendSegments = [...appendSegments, { id: 'append-detached', role: 'assistant', turnId: 'append-turn', content: 'Do not move a reader viewing history.' }]; renderAppend();`);
  await pause(250);
  assert.ok(Math.abs(await run('appendList.scrollTop') - detachedTop) < 2, 'appending respects a reader detached from the bottom');
  await run(`
    window.appendImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
    appendSegments = [{ id: 'append-media', role: 'assistant', turnId: 'append-turn', content: '', attachments: [
      { id: 'image', name: 'fixture.png', type: 'image', path: appendImage },
      { id: 'video', name: 'fixture.mp4', type: 'video', path: 'data:video/mp4;base64,' },
      { id: 'audio', name: 'fixture.wav', type: 'audio', path: 'data:audio/wav;base64,' },
    ] }];
    renderAppend();
  `);
  await until("Boolean(document.querySelector('[data-segment-id=append-media] img') && document.querySelector('[data-segment-id=append-media] video') && document.querySelector('[data-segment-id=append-media] audio'))", 'attachment-only active segment');
  await run(`
    window.appendMediaNodes = [...document.querySelectorAll('[data-segment-id=append-media] img, [data-segment-id=append-media] video, [data-segment-id=append-media] audio')];
    appendSegments = [...appendSegments, { id: 'append-after-media', role: 'assistant', turnId: 'append-turn', content: 'The attachment remains above.' }];
    renderAppend();
  `);
  await until("Boolean(document.querySelector('[data-segment-id=append-after-media]'))", 'round after attachment');
  assert.equal(await run('appendMediaNodes.every(node => node.isConnected)'), true, 'media survives the next assistant segment');
  // Exercise the live update functions as well as the component: a runtime
  // round with no assistant text keeps its runtime owner while joining the
  // latest visual package until the next assistant narration.
  await run(`
    window.loopState = { s: [{ id: 'loop-placeholder', role: 'assistant', content: '', turnId: 'loop-fixture' }] };
    window.loopTool = (id, owner, state = 'running') => ({ id, name: 'terminal_exec', assistantMessageId: owner,
      turnId: 'loop-fixture', state, summary: id, output: '', metadata: {}, success: state === 'completed', durationMs: 0,
      contentOffset: 0, createdAt: '2026-09-08T00:00:00Z' });
    window.renderLoop = () => updateChat({ conversation: { id: 'loop-fixture', title: 'Loop fixture' },
      messages: loopState.s, loading: false, historyLoading: false, sending: true, activeTurnId: 'loop-fixture' });
    loopState = views.appendAssistantDelta(loopState, 's', 'loop-placeholder', 'Original loop narration.', { messageId: 'msg_intro', turnId: 'loop-fixture' });
    renderLoop();
  `);
  await until("document.querySelector('.message-row.streaming .markdown-content p')?.textContent === 'Original loop narration.'", 'loop initial text');
  await run(`
    window.originalLoopParagraph = document.querySelector('.message-row.streaming .markdown-content p');
    loopState = views.appendToolExecution(loopState, 's', 'loop-placeholder', loopTool('round-tool', 'msg_tools'));
    renderLoop();
  `);
  await until("Boolean(document.querySelector('[data-segment-id=loop-placeholder] .tool-execution-block'))", 'tool-only round joins the latest narration package');
  assert.equal(await run('originalLoopParagraph.isConnected'), true);
  await run(`
    window.originalLoopTool = document.querySelector('[data-segment-id=loop-placeholder] .tool-execution-block');
    loopState = views.appendAssistantDelta(loopState, 's', 'loop-placeholder', 'Following loop narration.', { messageId: 'msg_after', turnId: 'loop-fixture' });
    renderLoop();
  `);
  await until("Boolean(document.querySelector('[data-segment-id=msg_after] .markdown-content p'))", 'narration follows tool-only round');
  await run(`
    loopState = views.appendToolExecution(loopState, 's', 'loop-placeholder', loopTool('round-tool', 'msg_tools', 'completed'));
    renderLoop();
  `);
  await pause(100);
  assert.equal(await run('originalLoopParagraph.isConnected && originalLoopTool.isConnected'), true, 'late Tool completion retains the original DOM');
  assert.deepEqual(await run("[...document.querySelectorAll('.message-row.streaming [data-segment-id]')].map(node => node.dataset.segmentId)"),
    ['loop-placeholder', 'msg_after'], 'the merged package remains before new assistant text');
  assert.equal(await run("loopState.s.find(message => message.assistantMessageId === 'msg_tools').toolExecutions[0].id"), 'round-tool', 'grouping does not change the runtime owner');
  await run(`
    loopState = views.appendAssistantDelta(loopState, 's', 'loop-placeholder', 'Text received after the tool.', { messageId: 'msg_tools', turnId: 'loop-fixture' });
    renderLoop();
  `);
  await until("document.querySelector('[data-segment-id=msg_tools] p')?.textContent === 'Text received after the tool.'", 'late narration retains its factual boundary');
  assert.equal(await run('originalLoopParagraph.isConnected && originalLoopTool.isConnected'), true, 'late narration cannot pull an earlier tool out of its established package');
  assert.equal(await run("originalLoopTool.closest('[data-segment-id]').dataset.segmentId"), 'loop-placeholder');
  assert.equal(await run("document.querySelectorAll('.message-row.streaming .tool-execution-block').length"), 1);
  console.log('Streaming append passed (' + theme + '): paragraph and row identity, tool insertion, segment/token append, frame height/scroll stability and detached reading.');
};
