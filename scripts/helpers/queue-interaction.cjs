const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  await run(`
    window.queueOriginalProps = { ...chatProps };
    window.queueOrders = [];
    window.queueGuided = [];
    window.queueFixture = [
      { id: 'q1', text: '第一条：保留清楚的提示词。\\n第二行：验证换行与完整内容。\\n第三行：这里不能被两行截断。', createdAt: '2026-09-11T00:00:00Z' },
      { id: 'q2', text: '第二条：先完善拖拽排序，再核对显示效果。', createdAt: '2026-09-11T00:00:01Z' },
      { id: 'q3', text: '第三条：排队时保留完整提示词，完成后再运行下一条。', createdAt: '2026-09-11T00:00:02Z' },
    ];
    window.setQueueFixture = items => {
      queueFixture = items;
      updateChat({ queuedMessages: items, queuedMessageCount: items.length, queuedMessagePreview: items[0]?.text ?? '' });
    };
    updateChat({ language: 'zh', sending: true, activeTurnId: 'queue-turn', permissionMode: 'all_free',
      onReorderQueuedMessage: (sourceId, targetId) => {
        setQueueFixture(views.reorderScopedQueue(queueFixture, sourceId, targetId, item => item.id, () => 'session-a'));
        queueOrders.push(queueFixture.map(item => item.id));
      },
      onGuideQueuedMessage: async id => { queueGuided.push(id); setQueueFixture(queueFixture.filter(item => item.id !== id)); },
      onRemoveQueuedMessage: id => setQueueFixture(queueFixture.filter(item => item.id !== id)),
    });
    setQueueFixture(queueFixture);
    window.queuePoint = (id, handle = true, fraction = 0.5) => {
      const row = document.querySelector('[data-queue-item-id="' + id + '"]');
      const target = handle ? row.querySelector('.runtime-queue-drag-handle') : row;
      const r = target.getBoundingClientRect();
      return { x: Math.round(r.left + (handle ? r.width / 2 : 20)), y: Math.round(r.top + r.height * fraction) };
    };
    void 0;
  `);
  await until("!!document.querySelector('.composer-queue-button')", 'queue shortcut appears');
  assert.equal(await run("document.querySelector('.permission-center-button').nextElementSibling.className"), 'composer-queue-button');
  assert.equal(await run("document.querySelector('.composer-queue-button').textContent"), '3');
  assert.equal(await run("document.querySelectorAll('.composer-queue-row').length"), 0, 'no duplicate queue summary above input');
  await run("document.querySelector('.composer-queue-button').click()");
  await until("!!document.querySelector('.composer-runtime-rail.context-visible .queue-context-panel')", 'queue shortcut opens details');
  await until("!!document.querySelector('.composer-runtime-screen.queue.open')", 'status reel switches to queue');
  await pause(200);
  const prompt = await run(`(() => {
    const p = document.querySelector('.runtime-queue-prompt'); const style = getComputedStyle(p);
    return { text: p.textContent, whiteSpace: style.whiteSpace, lines: p.clientHeight / parseFloat(style.lineHeight), clamp: style.webkitLineClamp };
  })()`);
  assert.equal(prompt.text, await run('queueFixture[0].text'));
  assert.equal(prompt.whiteSpace, 'pre-wrap');
  assert.ok(prompt.lines >= 3 && prompt.clamp === 'none', 'the full multiline prompt is visible');
  assert.equal(await run("document.querySelector('.runtime-queue-position')"), null, 'order labels do not duplicate the visible sequence');
  const rowRect = id => run(`(() => { const r = document.querySelector('[data-queue-item-id="${id}"]').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  const previewRect = () => run(`(() => { const r = document.querySelector('.runtime-queue-drag-preview').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
  const native = (type, point, extra = {}) => window.webContents.sendInputEvent({ type, ...point, ...extra });
  const startDrag = async (id, handle = true) => {
    const point = await run(`queuePoint(${JSON.stringify(id)}, ${handle})`);
    native('mouseMove', point);
    native('mouseDown', point, { button: 'left', clickCount: 1 });
    return point;
  };
  const moveDrag = point => native('mouseMove', point, { modifiers: ['leftButtonDown'] });
  const endDrag = point => native('mouseUp', point, { button: 'left', clickCount: 1 });
  const original = await rowRect('q1');
  const neighbour = await rowRect('q2');
  const start = await startDrag('q1', false);
  await until("!!document.querySelector('.runtime-queue-drag-preview')", 'holding the card body lifts the full card');
  const lifted = await previewRect();
  assert.ok(Math.abs(lifted.width - original.width) < 1 && Math.abs(lifted.height - original.height) < 1, 'the drag preview keeps the full card dimensions');
  assert.equal(await run("document.querySelector('.runtime-queue-drag-preview').inert"), true);
  moveDrag({ x: start.x + 16, y: start.y + 9 });
  await pause(60);
  const following = await previewRect();
  assert.ok(Math.abs(following.x - original.x - 16) < 2 && Math.abs(following.y - original.y - 9) < 2, 'the card follows small pointer movements before any order change');
  assert.equal(await run('queueOrders.length'), 0, 'lifting and moving do not persist the queue');
  let drop = await run("queuePoint('q2', false, 0.8)");
  moveDrag(drop);
  await until("!!document.querySelector('[data-queue-item-id=q1].dragging')", 'the source leaves a full-height placeholder');
  await pause(180);
  assert.equal(await run('queueOrders.length'), 0, 'moving only previews the insertion');
  const shifted = await rowRect('q2');
  assert.ok(shifted.y < neighbour.y - 20, 'neighbours make room before the pointer is released');
  const moving = await previewRect();
  assert.ok(Math.abs(moving.x - original.x - (drop.x - start.x)) < 2 && Math.abs(moving.y - original.y - (drop.y - start.y)) < 2, 'the preview stays anchored to the pointer across an insertion boundary');
  await pause(180);
  assert.ok(Math.abs((await rowRect('q2')).y - shifted.y) < 1, 'a stationary pointer does not make rows oscillate');
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tmp', 'composer-queue-drag.png'), (await window.webContents.capturePage()).toPNG());
  await run("window.queueSavedTheme = document.querySelector('.app').className; document.querySelector('.app').className = 'app theme-light'");
  await pause(60);
  fs.writeFileSync(path.join(root, 'tmp', 'composer-queue-drag-light.png'), (await window.webContents.capturePage()).toPNG());
  await run("document.querySelector('.app').className = queueSavedTheme");
  endDrag(drop);
  await until('queueOrders.length === 1', 'drop commits exactly once');
  assert.deepEqual(await run('queueFixture.map(item => item.id)'), ['q2', 'q1', 'q3']);
  assert.equal(await run("document.querySelector('.runtime-queue-drag-preview')"), null, 'dropping removes the visual copy');
  // Reverse direction and preserve the same order shown by the live preview.
  await startDrag('q1');
  drop = await run("queuePoint('q2', false, 0.1)");
  moveDrag(drop); endDrag(drop);
  await until('queueOrders.length === 2', 'reverse drop');
  assert.deepEqual(await run('queueFixture.map(item => item.id)'), ['q1', 'q2', 'q3']);
  for (const mode of ['escape', 'blur', 'outside']) {
    await startDrag('q1');
    drop = await run("queuePoint('q2', false, 0.8)");
    moveDrag(drop);
    await until("!!document.querySelector('.runtime-queue-item.dragging')", 'cancel fixture');
    if (mode === 'escape') await run("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))");
    if (mode === 'blur') await run("window.dispatchEvent(new Event('blur'))");
    if (mode === 'outside') { drop = { x: 2, y: 2 }; moveDrag(drop); }
    endDrag(drop);
    await until("!document.querySelector('.runtime-queue-item.dragging')", 'drag cancel cleanup');
    assert.equal(await run("document.querySelector('.runtime-queue-drag-preview')"), null);
    assert.equal(await run("document.body.classList.contains('queue-reordering')"), false);
    assert.equal(await run('queueOrders.length'), 2, mode + ' does not change order');
  }
  await run(`document.querySelector('[data-queue-item-id=q2] .runtime-queue-drag-handle').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }))`);
  await until('queueOrders.length === 3', 'keyboard reorder');
  assert.deepEqual(await run('queueFixture.map(item => item.id)'), ['q2', 'q1', 'q3']);
  // Appended messages should not close the panel while the user is reading it.
  await run("setQueueFixture([...queueFixture, ...Array.from({ length: 9 }, (_, i) => ({ id: 'extra-' + i, text: '新增排队消息 ' + i + '。'.repeat(55), createdAt: '2026-09-11T00:00:03Z' }))])");
  await until("document.querySelector('.composer-queue-button')?.textContent === '12'", 'live queue count');
  assert.ok(await run("Boolean(document.querySelector('.queue-context-panel'))"), 'appending keeps the queue open');
  await startDrag('q2');
  drop = await run("(() => { const r = document.querySelector('.runtime-queue-list').getBoundingClientRect(); return { x: Math.round(r.x + 20), y: Math.round(r.bottom - 6) }; })()");
  moveDrag(drop);
  await until("document.querySelector('.runtime-queue-list').scrollTop > 30", 'edge autoscroll');
  await run("window.dispatchEvent(new Event('blur'))");
  endDrag(drop);
  assert.equal(await run('queueOrders.length'), 3, 'autoscroll alone does not reorder');
  await run("document.querySelector('.runtime-queue-list').scrollTop = 0; setQueueFixture(queueFixture.slice(0, 3))");
  await pause(200);
  const screenshot = await window.webContents.capturePage();
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tmp', 'composer-queue.png'), screenshot.toPNG());
  for (const width of [440, 330]) {
    await run(`document.querySelector('.chat-panel').style.width = '${width}px'`);
    await pause(220);
    const layout = await run(`(() => {
      const panel = document.querySelector('.queue-context-panel').getBoundingClientRect();
      const body = document.querySelector('.chat-body').getBoundingClientRect();
      const icon = document.querySelector('.composer-queue-button').getBoundingClientRect();
      const permission = document.querySelector('.permission-center-button').getBoundingClientRect();
      const iconNode = document.querySelector('.composer-queue-button');
      const hit = document.elementFromPoint(icon.left + icon.width / 2, icon.top + icon.height / 2);
      return { inside: panel.left >= body.left && panel.right <= body.right + 1 && panel.top >= body.top,
        iconRight: icon.left >= permission.right - 1,
        iconReachable: hit === iconNode || iconNode.contains(hit),
        textFits: [...document.querySelectorAll('.runtime-queue-prompt')].every(p => p.scrollWidth <= p.clientWidth + 1) };
    })()`);
    assert.deepEqual(layout, { inside: true, iconRight: true, iconReachable: true, textFits: true }, width + 'px queue layout');
  }
  await run("document.querySelector('.chat-panel').style.width = ''");
  const guidePoint = await run("(() => { const r = document.querySelector('.runtime-queue-guide').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()");
  native('mouseMove', guidePoint);
  native('mouseDown', guidePoint, { button: 'left', clickCount: 1 });
  native('mouseUp', guidePoint, { button: 'left', clickCount: 1 });
  await until('queueGuided.length === 1', 'guidance action still uses selected queue item');
  assert.equal(await run('queueGuided[0]'), 'q2');
  await until("document.querySelector('[data-queue-item-id=q1] .runtime-queue-drag-handle')?.disabled === false && document.querySelector('.composer-queue-button')?.textContent === '2'", 'guidance finishes updating the queue');
  await pause(250);
  await startDrag('q1');
  drop = await run("queuePoint('q3', false, 0.8)");
  moveDrag(drop);
  await until("!!document.querySelector('.runtime-queue-item.dragging')", 'session switch fixture');
  await run("updateChat({ activeConversationId: 'different-queue-session', queuedMessages: [], queuedMessageCount: 0, queuedMessagePreview: '' })");
  await until("!document.querySelector('.composer-queue-button') && !document.querySelector('.queue-context-panel')", 'session switch clears queue controls')
    .catch(async error => { throw new Error(error.message + '\nRenderer failures: ' + JSON.stringify(await run('failures'))); });
  endDrag(drop);
  assert.equal(await run('queueOrders.length'), 3, 'switching sessions cancels the active drag');
  assert.equal(await run("document.querySelector('.runtime-queue-drag-preview')"), null, 'switching sessions also removes the floating card');
  await run('window.queueLeavingList = document.querySelector(".message-list"); updateChat(queueOriginalProps)');
  await until('document.querySelector(".message-list") !== queueLeavingList', 'restored session has committed before the next view test');
  console.log('Queue interaction passed: full-card hold and pointer tracking, live gap, drop-only commit, cancel, keyboard, autoscroll, guidance, session isolation and narrow layout.');
};
