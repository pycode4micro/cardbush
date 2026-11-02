const assert = require('node:assert/strict');

module.exports = async ({ run, until, window }) => {
  const points = await run(`(() => {
    const area = document.querySelector('.quick-context-ticks').getBoundingClientRect();
    return [...document.querySelectorAll('.quick-context-tick')].filter(node => {
      const r = node.getBoundingClientRect(); return r.top >= area.top && r.bottom <= area.bottom;
    }).slice(1, 5).map(node => {
      const r = node.getBoundingClientRect();
      return { id: node.dataset.turnMessageId, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
  })()`);
  assert.equal(points.length, 4);
  await run(`(() => {
    const first = document.querySelector('[data-turn-message-id="${points[0].id}"]');
    window.contextTickFrames = []; window.contextTickMotionDone = false;
    first.addEventListener('pointerenter', () => {
      const start = performance.now();
      const sample = now => {
        contextTickFrames.push({ time: now - start, width: parseFloat(getComputedStyle(first, '::before').width),
          preview: first.classList.contains('previewing') });
        if (now - start < 480) requestAnimationFrame(sample); else contextTickMotionDone = true;
      };
      requestAnimationFrame(sample);
    }, { once: true });
  })()`);
  window.webContents.sendInputEvent({ type: 'mouseMove', x: points[0].x, y: points[0].y });
  await until('contextTickMotionDone && !!document.querySelector(".turn-hover-preview")', 'single tick expansion');
  const frames = await run('contextTickFrames');
  const settled = frames.filter(frame => frame.time >= 160);
  assert.ok(settled.some(frame => !frame.preview) && settled.some(frame => frame.preview), 'observe both sides of delayed preview opening');
  const finalWidth = settled.at(-1).width;
  assert.ok(settled.every(frame => Math.abs(frame.width - finalWidth) < .1),
    'the initial hover reaches its final width before the preview opens, without a second expansion: ' + JSON.stringify(settled));
  await run('window.contextRetainedHover = document.querySelector(".turn-hover-preview"); void 0');
  for (const point of [points[1], points[2], points[3], points[0]]) {
    await run(`(() => {
      window.contextSwitchFrame = null;
      document.querySelector('[data-turn-message-id="${point.id}"]').addEventListener('pointerenter', () => {
        const start = performance.now();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          contextSwitchFrame = { id: document.querySelector('.quick-context-tick.previewing')?.dataset.turnMessageId,
            sameCard: contextRetainedHover === document.querySelector('.turn-hover-preview'), elapsed: performance.now() - start };
        }));
      }, { once: true });
    })()`);
    window.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y });
    await until('contextSwitchFrame !== null', 'adjacent tick follows pointer');
    const next = await run('contextSwitchFrame');
    assert.equal(next.id, point.id, 'preview follows the new tick on the next frames: ' + JSON.stringify(next));
    assert.equal(next.sameCard, true, 'switching keeps the card mounted instead of replaying its entrance');
  }
  window.webContents.sendInputEvent({ type: 'mouseMove', x: 10, y: 10 });
  await until('!document.querySelector(".turn-hover-preview")', 'leave motion fixture');
  console.log('Context tick motion passed: one expansion across delayed opening and immediate preview switching without remounts.');
};
