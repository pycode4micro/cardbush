const assert = require('node:assert/strict');

module.exports = async ({ run, until, pause, window }) => {
  await run(`
    window.leftResizeCommits = [];
    window.LeftResizeFixture = function () {
      const React = require('react');
      const [open, setOpen] = React.useState(true);
      const [width, setWidth] = React.useState(280);
      const presence = views.useSoftPanelPresence(open);
      window.setLeftOpen = setOpen;
      window.leftResizeState = { open, width, ...presence };
      const noop = () => {};
      return h('div', { className: 'desktop-shell' + (open ? '' : ' sidebar-is-collapsed') },
        presence.mounted && h(views.ChatSidebar, {
          language: 'zh', section: 'chat', activeConversationId: null,
          runningConversationIds: new Set(), attentionByConversation: {}, projects: [], conversations: [],
          changeReportsByConversation: {}, onlyTalkMode: false, onOnlyTalkModeChange: noop,
          onSectionChange: noop, onConversationChange: noop, onCreateConversation: noop,
          onAddProject: noop, onProjectAction: noop, onDeleteConversation: noop, onRenameConversation: noop,
          onOpenConversationChanges: noop, onOpenSettings: noop, softVisible: presence.visible,
        }),
        presence.mounted && h(views.SidebarResizer, {
          language: 'zh', width, softVisible: presence.visible,
          onWidthChange: next => { leftResizeCommits.push(next); setWidth(next); },
          onCollapse: () => setOpen(false),
        }),
        h('section', { className: 'main-stage' }, h('button', { onClick: () => setOpen(!open) }, 'Toggle')),
        h('aside', { className: 'right-inspector', style: { '--right-inspector-width': '600px' } }));
    };
    window.leftRect = () => document.querySelector('.sidebar')?.getBoundingClientRect().toJSON();
    window.leftMotionFrames = () => new Promise(resolve => {
      const frames = [], start = performance.now();
      const sample = () => {
        const panel = document.querySelector('.sidebar');
        const content = panel?.querySelector('.sidebar-panel-content');
        if (content) frames.push([panel.getBoundingClientRect().width, content.getBoundingClientRect().width]);
        if (performance.now() - start < 300) requestAnimationFrame(sample);
        else resolve(frames);
      };
      requestAnimationFrame(sample);
    });
    renderView(h(LeftResizeFixture));
  `);
  await until('window.leftResizeState?.visible && Math.abs((leftRect()?.width ?? 0) - 280) < 1', 'left panel at saved width');
  await pause(320);
  const frames = await run('setLeftOpen(false); leftMotionFrames()');
  assert.equal(new Set(frames.map(frame => Math.round(frame[1]))).size, 1, 'left sidebar content does not rewrap during collapse');
  assert.ok(new Set(frames.map(frame => Math.round(frame[0]))).size > 2, 'left border animates through intermediate widths');
  const opening = await run('setLeftOpen(true); leftMotionFrames()');
  assert.equal(new Set(opening.map(frame => Math.round(frame[1]))).size, 1, 'left sidebar content does not rewrap during expansion');
  await until('leftResizeState.visible && Math.abs(leftRect().width - 280) < 1', 'left panel reopened');

  let point, initialWidth, endX;
  const begin = async offset => {
    const bounds = await run('leftRect()');
    initialWidth = bounds.width;
    point = { x: Math.round(bounds.right + offset), y: Math.round(bounds.top + 90) };
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    await until("document.body.classList.contains('sidebar-resizing')", 'expanded left hit area accepts the pointer');
  };
  const move = width => {
    endX = Math.round(point.x + width - initialWidth);
    window.webContents.sendInputEvent({ type: 'mouseMove', x: endX, y: point.y, modifiers: ['leftButtonDown'] });
  };
  const release = () => window.webContents.sendInputEvent({ type: 'mouseUp', x: endX, y: point.y, button: 'left', clickCount: 1 });
  for (const offset of [-6, 6]) {
    await begin(offset);
    move(320);
    await until('Math.abs(leftRect().width - 320) < 1', 'left drag previews at the pointer');
    assert.equal(await run("getComputedStyle(document.querySelector('.right-inspector')).transitionProperty"), 'none', 'the opposite edge does not lag behind a left drag');
    release();
    await until('leftResizeState.width === 320', 'left width committed');
    await pause(30);
  }
  // Releasing below minimum must restore the DOM even when the saved value is unchanged.
  for (let attempt = 0; attempt < 2; attempt++) {
    await begin(6); move(200);
    await until('Math.abs(leftRect().width - 200) < 1', 'left below-minimum preview');
    release();
    await until('leftResizeState.width === 220 && Math.abs(leftRect().width - 220) < 1', 'left release restores minimum');
  }
  const commits = await run('leftResizeCommits.slice()');
  await begin(6); move(170);
  await until('!leftResizeState.open', 'left drag snaps closed');
  release();
  // Interrupt the exit, then wait beyond the former 260ms reset timer.
  await run('setLeftOpen(true)');
  await until('leftResizeState.visible && Math.abs(leftRect().width - 220) < 1', 'left snap reopen restores saved width');
  await pause(350);
  assert.equal(Math.round(await run('leftRect().width')), 220);
  assert.deepEqual(await run('leftResizeCommits'), commits, 'snap preview never replaces the saved width');
  await begin(-6); move(250);
  await until('Math.abs(leftRect().width - 250) < 1', 'left cancellation preview');
  await run("window.dispatchEvent(new Event('blur'))");
  release();
  await until('Math.abs(leftRect().width - 220) < 1', 'left cancellation restores width');
  await run('renderView(null)');
  await pause();
  console.log('Left sidebar passed: stable content during motion, enlarged hit area on both sides, coordinated drag, minimum release, snap/reopen and cancellation.');
};
