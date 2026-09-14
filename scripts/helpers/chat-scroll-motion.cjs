const assert = require('node:assert/strict');

module.exports = async ({ run, until, pause, window }) => {
  await run(`
    window.scrollMotionSaved = { ...chatProps };
    updateChat({ activeConversationId: 'scroll-motion', sending: true, activeTurnId: 'motion-last', draft: '',
      messages: Array.from({ length: 32 }, (_, i) => ({
        id: 'motion-' + i, role: i % 2 ? 'assistant' : 'user',
        turnId: i === 31 ? 'motion-last' : 'motion-turn-' + Math.floor(i / 2),
        content: ('Scroll motion, message ' + i + '.\\n\\n').repeat(6),
      })) });
    window.motionList = () => document.querySelector('.message-list');
    window.motionBottom = () => motionList().scrollHeight - motionList().clientHeight;
    window.motionWheel = deltaY => motionList().dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
    window.motionAppend = () => updateChat({ messages: chatProps.messages.map((message, i) =>
      i === 31 ? { ...message, content: message.content + '\\n\\nNew streamed paragraph.' } : message) });
    void 0;
  `);
  await until("!!document.querySelector('[data-message-id=motion-31]')", 'scroll motion fixture');
  await pause(650);
  try {
    await run('motionWheel(-24); motionList().scrollTop = motionBottom() - 24');
    await pause(90);
    const reading = await run('motionList().scrollTop');
    await run('motionAppend()');
    await pause(420);
    const after = await run('motionList().scrollTop');
    assert.ok(Math.abs(after - reading) < 2,
      `A small upward gesture must stay detached even while the latest message is visible: ${reading} -> ${after}`);

    // Lazy content/layout corrections may emit a later downward scroll without
    // a matching downward gesture. That must not undo the reader's detach.
    await run('motionList().scrollTop = motionBottom()');
    await pause(140);
    const correctedReading = await run('motionList().scrollTop');
    await run('motionAppend()');
    await pause(420);
    assert.ok(Math.abs(await run('motionList().scrollTop') - correctedReading) < 2,
      'A delayed layout correction must not turn automatic follow back on after scrolling upward');

    await run("document.querySelector('.scroll-bottom').click()");
    await pause(550);
    await run(`{ const edge = motionList().getBoundingClientRect();
      motionList().dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 7, clientX: edge.right - 2, clientY: edge.top + 60, bubbles: true }));
      motionList().scrollTop = motionBottom() - 24;
      dispatchEvent(new PointerEvent('pointerup', { pointerId: 7 })); }`);
    await pause(90);
    const dragReading = await run('motionList().scrollTop');
    await run('motionAppend()');
    await pause(420);
    assert.ok(Math.abs(await run('motionList().scrollTop') - dragReading) < 2, 'A short scrollbar drag upward must not reattach because the tail is visible');

    await run('motionWheel(-220); motionList().scrollTop = motionBottom() - 1300');
    await pause(80);
    await until("!document.querySelector('.scroll-bottom').classList.contains('hidden')", 'bottom button visible');
    const beforeWheel = await run('motionList().scrollTop');
    await run("document.querySelector('.scroll-bottom').dispatchEvent(new WheelEvent('wheel', { deltaY: -70, bubbles: true, cancelable: true }))");
    assert.ok(Math.abs(await run('motionList().scrollTop') - beforeWheel + 70) < 2, 'Wheel input on the floating button must scroll the conversation');
    const fs = require('node:fs');
    const path = require('node:path');
    const preview = path.resolve(__dirname, '../../tmp/scroll-motion-preview.png');
    fs.mkdirSync(path.dirname(preview), { recursive: true });
    fs.writeFileSync(preview, (await window.capturePage()).toPNG());
    await run(`{ window.motionFrames = []; const sample = () => {
      motionFrames.push({ time: performance.now(), top: motionList().scrollTop, bottom: motionBottom() });
      window.motionFrame = requestAnimationFrame(sample);
    }; sample(); document.querySelector('.scroll-bottom').click(); }`);
    await pause(550);
    const frames = await run('cancelAnimationFrame(motionFrame); motionFrames');
    const unique = new Set(frames.map(frame => Math.round(frame.top)));
    assert.ok(unique.size >= 4, 'Bottom jump must animate through real intermediate positions, not snap twice');
    assert.ok(frames.slice(1).every((frame, i) => frame.top >= frames[i].top - 1), 'Bottom animation must not reverse direction: ' + JSON.stringify(frames));
    const final = frames.at(-1);
    assert.ok(Math.abs(final.bottom - final.top) < 2, 'Bottom animation must finish at the actual latest content');

    await run('motionWheel(-500); motionList().scrollTop = motionBottom() - 2000');
    await pause(80);
    await run("document.querySelector('.scroll-bottom').click()");
    await pause(80);
    await run('motionWheel(-12)');
    const interrupted = await run('motionList().scrollTop');
    await run('motionAppend()');
    await pause(450);
    assert.ok(Math.abs(await run('motionList().scrollTop') - interrupted) < 2, 'Upward input must cancel an in-flight jump and later stream updates');

    for (const gesture of ["new KeyboardEvent('keydown', { key: 'PageUp', bubbles: true })", "new Event('touchstart', { bubbles: true })"]) {
      await run("document.querySelector('.scroll-bottom').click()");
      await pause(70);
      const top = await run(`motionList().dispatchEvent(${gesture}); motionList().scrollTop`);
      await pause(420);
      assert.ok(Math.abs(await run('motionList().scrollTop') - top) < 2, 'Keyboard and touch must also interrupt active motion');
    }

    await run("document.querySelector('.scroll-bottom').click()");
    await pause(550);
    const button = await run(`(() => { const button = document.querySelector('.scroll-bottom'); const icon = button.querySelector('svg');
      const a = button.getBoundingClientRect(), b = icon.getBoundingClientRect();
      return { hidden: button.getAttribute('aria-hidden'), tab: button.tabIndex, label: button.getAttribute('aria-label'),
        x: Math.abs(a.x + a.width / 2 - b.x - b.width / 2), y: Math.abs(a.y + a.height / 2 - b.y - b.height / 2) }; })()`);
    assert.equal(button.hidden, 'true');
    assert.equal(button.tab, -1, 'Hidden bottom button must not take keyboard focus');
    assert.ok(button.x < 1 && button.y < 1, 'Bottom arrow must be centered without independent subpixel transforms');

    window.webContents.debugger.attach('1.3');
    try {
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await run('motionWheel(-300); motionList().scrollTop = motionBottom() - 1200');
      await pause(60);
      assert.ok(await run(`document.querySelector('.scroll-bottom').click(); Math.abs(motionBottom() - motionList().scrollTop) < 2`), 'Reduced motion must land immediately');
    } finally {
      await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
      window.webContents.debugger.detach();
    }
    await run(`updateChat({ activeConversationId: 'motion-long-history', sending: false, activeTurnId: '', messages:
      Array.from({ length: 128 }, (_, i) => ({ id: 'motion-history-' + i, role: i % 2 ? 'assistant' : 'user',
        turnId: 'motion-history-turn-' + Math.floor(i / 2), content: ('History ' + i + '\\n\\n').repeat(6) })) });`);
    await until("!!document.querySelector('[data-message-id=motion-history-127]')", 'long history mounted');
    await pause(550);
    await run(`{ window.motionGeometryOriginal = HTMLElement.prototype.getBoundingClientRect;
      window.motionGeometryReads = 0; window.motionReadFrames = [];
      HTMLElement.prototype.getBoundingClientRect = function(...args) {
        if (this.dataset.messageRole === 'user') motionGeometryReads++;
        return motionGeometryOriginal.apply(this, args);
      };
      const sample = () => { motionReadFrames.push(motionGeometryReads); motionGeometryReads = 0;
        window.motionReadFrame = requestAnimationFrame(sample); }; sample();
      motionWheel(-220); motionList().scrollTop = motionBottom() - 900; }`);
    await pause(300);
    const reads = await run(`cancelAnimationFrame(motionReadFrame);
      HTMLElement.prototype.getBoundingClientRect = motionGeometryOriginal; motionReadFrames`);
    assert.ok(Math.max(...reads) > 0 && Math.max(...reads) <= 12,
      'Turn tracking must not measure all 64 user messages each scrolling frame: ' + JSON.stringify(reads));
    console.log('Scroll motion passed: small wheel/scrollbar detach, animated jump, wheel/keyboard/touch interruption, button wheel routing, centered accessible arrow, reduced motion and bounded history measurements.');
  } finally {
    await run(`cancelAnimationFrame(window.motionFrame); cancelAnimationFrame(window.motionReadFrame);
      if (window.motionGeometryOriginal) HTMLElement.prototype.getBoundingClientRect = motionGeometryOriginal;
      updateChat(scrollMotionSaved)`);
  }
};
