const assert = require('node:assert/strict');

module.exports = async ({ run, until, pause, window }) => {
  await run(`
    window.inspectorResizeCalls = [];
    window.inspectorSnapCount = 0;
    window.InspectorResizeFixture = function () {
      const React = require('react');
      const [open, setOpen] = React.useState(true);
      const [width, setWidth] = React.useState(420);
      const presence = views.useSoftPanelPresence(open);
      window.setResizeOpen = setOpen;
      window.inspectorResizeState = { open, width, ...presence };
      return h('div', { className: 'desktop-shell sidebar-is-collapsed' },
        h('section', { className: 'main-stage' }, h(views.TopBar, {
          title: 'Resize fixture', language: 'zh', inspectorOpen: open, onToggleInspector: () => setOpen(true),
        })),
        presence.mounted && h('aside', {
          id: 'right-inspector', className: 'right-inspector soft-panel-motion ' + (presence.visible ? 'soft-panel-visible' : 'soft-panel-hidden'),
          style: { '--right-inspector-width': width + 'px' },
        }, h(views.RightInspectorResizer, {
          width, windowMaximized: false, softVisible: presence.visible, label: 'Resize inspector',
          onWidthChange: next => { const committed = Math.round(next); inspectorResizeCalls.push(committed); setWidth(committed); },
          onCollapse: () => { inspectorSnapCount++; setOpen(false); },
        }), h('div', { className: 'right-inspector-viewport' }, h('div', { className: 'right-inspector-content' },
          h('header', { className: 'right-inspector-toolbar' },
          h('strong', null, 'Inspector'), h('button', { onClick: () => setOpen(false) }, 'Close')),
          h('div', { className: 'right-inspector-body' }, h('p', null, 'Retained tab '.repeat(80)))))));
    };
    window.inspectorRect = () => document.querySelector('#right-inspector')?.getBoundingClientRect().toJSON();
    window.inspectorSnapFrames = () => new Promise(resolve => {
      const frames = [], start = performance.now();
      const sample = () => {
        frames.push(inspectorRect()?.width ?? 0);
        if (performance.now() - start < 300) requestAnimationFrame(sample);
        else resolve(frames);
      };
      requestAnimationFrame(sample);
    });
    renderView(h(InspectorResizeFixture));
  `);
  await until('window.inspectorResizeState?.visible && Math.abs((inspectorRect()?.width ?? 0) - 420) < 1', 'inspector fully expanded');
  await pause(320);
  assert.equal(await run("document.querySelector('[data-inspector-toggle]')"), null, 'expanded sidebar has no duplicate conversation button');
  assert.equal(await run("document.querySelectorAll('.right-inspector-toolbar button').length"), 1);

  // Measure the expensive content viewport, not a synthetic FPS target: text
  // and browser surfaces must not be laid out at every intermediate width.
  await run(`
    window.contentWidthFrames = () => new Promise(resolve => {
      const frames = [], start = performance.now();
      const sample = () => {
        const panel = document.querySelector('#right-inspector');
        const content = panel?.querySelector('.right-inspector-content');
        if (content) frames.push([panel.getBoundingClientRect().width, content.getBoundingClientRect().width]);
        if (performance.now() - start < 300) requestAnimationFrame(sample);
        else resolve(frames);
      };
      requestAnimationFrame(sample);
    });
    window.legacyContentSizing = document.createElement('style');
    legacyContentSizing.textContent = '.right-inspector-content { width: 100% !important; }';
    document.head.append(legacyContentSizing);
  `);
  await pause();
  const legacyFrames = await run('setResizeOpen(false); contentWidthFrames()');
  await run('legacyContentSizing.remove(); setResizeOpen(true)');
  await until('inspectorResizeState.visible && Math.abs(inspectorRect().width - 420) < 1', 'content sizing comparison reopened');
  await pause(320);
  const fixedFrames = await run('setResizeOpen(false); contentWidthFrames()');
  const widths = frames => new Set(frames.map(frame => Math.round(frame[1]))).size;
  assert.ok(widths(legacyFrames) > 2, 'the old percentage content sizing repeatedly reflows content during a collapse');
  assert.equal(widths(fixedFrames), 1, 'the content retains one width throughout collapse');
  assert.ok(new Set(fixedFrames.map(frame => Math.round(frame[0]))).size > 2, 'the outer panel still animates smoothly through intermediate widths');
  const expandedFrames = await run('setResizeOpen(true); contentWidthFrames()');
  assert.equal(widths(expandedFrames), 1, 'the content also retains one width throughout expansion');
  console.log('Inspector animation content widths: ' + widths(legacyFrames) + ' with old sizing; ' + widths(fixedFrames) + ' after clipping optimization.');
  await until('inspectorResizeState.visible && Math.abs(inspectorRect().width - 420) < 1', 'content sizing comparison complete');

  let origin;
  const begin = async () => {
    origin = await run('inspectorRect()');
    const point = { x: Math.round(origin.left - 6), y: Math.round(origin.top + 85) };
    origin.pointerX = point.x;
    origin.pointerY = point.y;
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    await until("document.body.classList.contains('right-inspector-resizing')", 'native drag starts outside the panel in the enlarged edge handle');
  };
  const move = width => {
    origin.endX = Math.round(origin.pointerX + origin.width - width);
    window.webContents.sendInputEvent({ type: 'mouseMove', x: origin.endX, y: origin.pointerY, modifiers: ['leftButtonDown'] });
  };
  const release = () => window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1,
    x: origin.endX, y: origin.pointerY });
  const reopen = async expected => {
    await run("document.querySelector('[data-inspector-toggle]').click()");
    await until(`inspectorResizeState.visible && Math.abs(inspectorRect().width - ${expected}) < 1`, 'reopen uses saved width');
    assert.equal(await run("document.querySelector('[data-inspector-toggle]')"), null);
  };

  // Preview can shrink below the ordinary minimum; releasing above the snap point restores the minimum.
  for (let attempt = 0; attempt < 2; attempt++) {
    await begin(); move(250);
    await until('Math.abs(inspectorRect().width - 250) < 1', 'preview is not blocked by the 380px minimum');
    release();
    await until('Math.abs(inspectorRect().width - 380) < 1', 'release restores the minimum even when the saved width is unchanged');
    assert.equal(await run('inspectorResizeState.width'), 380);
  }
  assert.deepEqual(await run('inspectorResizeCalls'), [380, 380]);
  await begin(); move(420);
  await until('Math.abs(inspectorRect().width - 420) < 1', 'ordinary resize preview');
  release();
  await until('inspectorResizeState.width === 420', 'ordinary resize saves the chosen width');
  const expectedCommits = [380, 380, 420];

  // Cross the snap point while still holding the pointer, then let the same presence animation finish.
  await begin(); move(240);
  await until('Math.abs(inspectorRect().width - 240) < 1', 'approach the snap edge');
  move(170);
  const frames = await run('inspectorSnapFrames()');
  release();
  assert.equal(await run('inspectorSnapCount'), 1);
  assert.equal(await run('inspectorResizeState.width'), 420, 'snap does not replace the preferred width');
  assert.deepEqual(await run('inspectorResizeCalls'), expectedCommits, 'snap never commits a transient width');
  assert.ok(frames.some(width => width > 0 && width < 230), 'collapse animates toward the edge');
  assert.ok(frames.every(width => width < 245), 'collapse never jumps back to the normal minimum');
  assert.equal(frames.at(-1), 0);
  assert.equal(await run("document.body.classList.contains('right-inspector-resizing')"), false);
  await until("document.querySelectorAll('[data-inspector-toggle]').length === 1", 'closed sidebar restores its entry button');
  await reopen(420);

  // Reopening during the exit must not leave the saved panel stuck at the 170px drag preview.
  await begin(); move(240);
  await until('Math.abs(inspectorRect().width - 240) < 1', 'second preview');
  move(170);
  await until('!inspectorResizeState.open', 'snap without waiting for pointer release');
  release();
  await reopen(420);
  assert.equal(await run('inspectorSnapCount'), 2);

  // Closing from another UI action cancels the active drag rather than committing it after exit.
  await begin(); move(250);
  await until('Math.abs(inspectorRect().width - 250) < 1', 'manual close preview');
  await run('setResizeOpen(false)');
  await until("!document.body.classList.contains('right-inspector-resizing')", 'hidden panel cancels drag capture');
  release();
  await reopen(420);
  assert.deepEqual(await run('inspectorResizeCalls'), expectedCommits);

  window.setContentSize(900, 800);
  await pause(100);
  await begin(); move(240);
  await until('Math.abs(inspectorRect().width - 240) < 1', 'overlay layout preview');
  move(170);
  await until('!inspectorResizeState.mounted', 'narrow overlay collapses');
  release();
  await reopen(420);
  await run('renderView(null)');
  window.setContentSize(1200, 800);
  await pause();
  console.log('Inspector resize passed: single toggle, native edge drag, below-minimum preview, snap animation, preserved width, interrupted reopen, cancellation and narrow overlay.');
};
