const assert = require('node:assert/strict');

// Exercise real Markdown across many completed turns, not just a streaming tail.
module.exports = async ({ run, until, pause, window }) => {
  await run(`
    window.historyScrollSaved = { ...chatProps };
    window.historyScrollMessages = Array.from({ length: 100 }, (_, i) => [
      { id: 'history-user-' + i, role: 'user', turnId: 'history-turn-' + i,
        content: 'Inspect item ' + i + '. Preserve the existing results.' },
      { id: 'history-answer-' + i, role: 'assistant', turnId: 'history-turn-' + i, status: 'completed',
        metadata: { transcript_kind: 'assistant_final' },
        content: Array.from({ length: 18 }, (_, p) => 'Paragraph ' + p + ': ' + 'Verified evidence and the next action remain available. '.repeat(6)).join('\\n\\n') +
          '\\n\\n| Item | State |\\n| --- | --- |\\n' + Array.from({ length: 10 }, (_, r) => '| Result ' + r + ' | Verified |').join('\\n') },
    ]).flat();
    updateChat({ activeConversationId: 'history-scroll', messages: historyScrollMessages,
      activeTurnId: '', sending: false, loading: false, historyLoading: false, draft: '' });
  `);
  await until("!!document.querySelector('[data-message-id=history-answer-99]')", 'long history mounted');
  await pause(600);
  const point = await run(`(() => {
    const rect = document.querySelector('.message-list').getBoundingClientRect();
    return { x: Math.round(rect.left + 12), y: Math.round(rect.top + rect.height * 0.4) };
  })()`);
  window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
  window.webContents.debugger.attach('1.3');
  try {
    await window.webContents.debugger.sendCommand('Emulation.setCPUThrottlingRate', { rate: 4 });
    await run(`
      window.historyList = document.querySelector('.message-list');
      window.historyReads = { rects: 0, descendants: 0, hitTests: 0, rectMs: 0, hitMs: 0, scans: 0 };
      window.historyOriginalRect = Element.prototype.getBoundingClientRect;
      window.historyOriginalQuery = Element.prototype.querySelectorAll;
      window.historyOriginalCaret = document.caretPositionFromPoint.bind(document);
      Element.prototype.getBoundingClientRect = function(...args) {
        const start = performance.now(), value = historyOriginalRect.apply(this, args);
        historyReads.rects++; historyReads.rectMs += performance.now() - start;
        if (this.matches('p, li, pre, table, img, video')) historyReads.descendants++;
        return value;
      };
      Element.prototype.querySelectorAll = function(selector) {
        if (selector === '.message-list-item') historyReads.scans++;
        return historyOriginalQuery.call(this, selector);
      };
      document.caretPositionFromPoint = function(...args) {
        const start = performance.now(); const value = historyOriginalCaret(...args);
        historyReads.hitTests++; historyReads.hitMs += performance.now() - start; return value;
      };
      window.historyFrames = []; window.historyScrolling = true;
      window.historyStartTop = historyList.scrollTop;
      window.historyFrame = requestAnimationFrame(function sample(now) {
        historyFrames.push({ time: now, top: historyList.scrollTop });
        if (historyScrolling) historyFrame = requestAnimationFrame(sample);
      });
    `);
    // Only trusted input invokes the Chromium scroll default.
    for (let count = 0; count < 70; count++) {
      window.webContents.sendInputEvent({ type: 'mouseWheel', ...point, deltaX: 0, deltaY: 240 });
      await pause(24);
    }
    // Include the precise anchor once native scrolling and reading settle.
    // Timing is diagnostic; deterministic work counts catch regressions
    // without requiring a particular GPU or frame rate on the test machine.
    await pause(400);
    const result = await run(`(() => {
      historyScrolling = false; cancelAnimationFrame(historyFrame);
      const gaps = historyFrames.slice(1).map((f, i) => f.time - historyFrames[i].time).sort((a,b) => a-b);
      return { ...historyReads, frames: historyFrames.length, maxFrame: gaps.at(-1),
        p95Frame: gaps[Math.floor(gaps.length * .95)], slowFrames: gaps.filter(ms => ms > 40).length,
        moved: historyStartTop - historyList.scrollTop, rows: historyList.querySelectorAll('.message-list-item').length };
    })()`);
    console.log('History scroll:', JSON.stringify(result));
    assert.ok(result.moved > 14000, 'an upward wheel burst must cover the expected distance across turns');
    assert.equal(result.rows, 200, 'offscreen history remains available for navigation and selection');
    assert.ok(result.hitTests >= 1 && result.hitTests <= 6, 'precise text hit-testing resumes for settled reading, not each wheel/scroll event');
    assert.ok(result.scans <= 6, 'unchanged message rows must not be rediscovered by whole-DOM scans per frame');
    assert.ok(result.descendants < 150, 'scrolling must not repeatedly measure every paragraph above the reading point');
  } finally {
    await window.webContents.debugger.sendCommand('Emulation.setCPUThrottlingRate', { rate: 1 });
    window.webContents.debugger.detach();
    await run(`
      historyScrolling = false; cancelAnimationFrame(historyFrame);
      if (window.historyOriginalRect) Element.prototype.getBoundingClientRect = historyOriginalRect;
      if (window.historyOriginalQuery) Element.prototype.querySelectorAll = historyOriginalQuery;
      if (window.historyOriginalCaret) document.caretPositionFromPoint = historyOriginalCaret;
      updateChat(historyScrollSaved);
    `);
  }
};
