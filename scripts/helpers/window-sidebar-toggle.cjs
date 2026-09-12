const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  await run(`
    window.viewTheme = 'theme-dark';
    window.sidebarToggleCalls = 0;
    window.frameKey = 'startup';
    window.frameProps = { language: 'zh', collapsed: false, onToggle: () => {
      sidebarToggleCalls++;
      frameProps.collapsed = !frameProps.collapsed;
      showFrame();
    } };
    window.showFrame = () => renderView(h('header', { className: 'window-frame window-drag' },
      h(views.WindowSidebarToggle, { ...frameProps, key: frameKey }),
      h('button', { className: 'frame-chip cache-chip no-drag' }, '缓存'),
      h('div', { className: 'window-spacer window-drag' })));
    window.readToggle = () => {
      const button = document.querySelector('.window-sidebar-toggle');
      const transform = selector => {
        const matrix = new DOMMatrixReadOnly(getComputedStyle(button.querySelector(selector)).transform);
        return { x: matrix.m41, y: matrix.m42 };
      };
      return { brand: button.dataset.brandVisible, expanded: button.getAttribute('aria-expanded'),
        label: button.getAttribute('aria-label'), width: button.getBoundingClientRect().width,
        neighbour: document.querySelector('.cache-chip').getBoundingClientRect().left,
        brandOffset: transform('.window-sidebar-track'), iconOffset: transform('.window-sidebar-icon-track'),
        iconWidth: button.querySelector('.window-sidebar-icon-viewport').getBoundingClientRect().width,
        drag: getComputedStyle(button).getPropertyValue('-webkit-app-region') };
    };
    window.toggleFrames = duration => new Promise(resolve => {
      const frames = [], start = performance.now();
      const sample = () => {
        frames.push(readToggle());
        if (performance.now() - start < duration) requestAnimationFrame(sample);
        else resolve(frames);
      };
      requestAnimationFrame(sample);
    });
    showFrame();
  `);
  await until("!!document.querySelector('.window-sidebar-toggle')", 'title bar sidebar control');
  const first = await run('readToggle()');
  assert.equal(first.brand, 'true');
  assert.equal(first.drag, 'no-drag', 'the old draggable logo area must accept clicks');
  assert.equal(first.expanded, 'true');
  assert.deepEqual(first.brandOffset, { x: 0, y: 0 });
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tmp/window-sidebar-brand.png'), (await window.webContents.capturePage()).toPNG());
  await pause(2400);
  await run('showFrame()');
  assert.equal(await run('readToggle().brand'), 'true', 'ordinary rerenders retain the startup brand');
  const startup = await run('toggleFrames(1100)');
  assert.equal(startup.at(-1).brand, 'false', 'the startup timer is not reset by a rerender');
  assert.ok(startup.some(frame => frame.brandOffset.x < -1 && frame.brandOffset.x > -frame.width + 1), 'brand replacement visibly rolls');
  assert.ok(startup.every(frame => frame.brandOffset.y === 0), 'brand replacement only scrolls horizontally');
  const compact = startup.at(-1);
  assert.ok(Math.abs(compact.width - compact.iconWidth) < .1, 'the settled slot only reserves the icon width');
  assert.ok(startup.some(frame => frame.width < first.width - 1 && frame.width > compact.width + 1), 'the brand slot contracts smoothly with the roll');
  assert.ok(Math.abs((first.neighbour - compact.neighbour) - (first.width - compact.width)) < .1, 'adjacent menus follow the contracted slot');
  assert.equal(startup.at(-1).label, '收起左侧栏');

  const clickToggle = async () => {
    const rect = await run("document.querySelector('.window-sidebar-toggle').getBoundingClientRect().toJSON()");
    const point = { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point });
  };
  await clickToggle();
  const collapsing = await run('toggleFrames(470)');
  assert.equal(collapsing.at(-1).expanded, 'false');
  assert.equal(collapsing.at(-1).label, '展开左侧栏');
  assert.ok(collapsing.some(frame => frame.iconOffset.x < -1 && frame.iconOffset.x > -frame.iconWidth + 1), 'collapse switches icons with a horizontal roll');
  assert.ok(collapsing.every(frame => frame.iconOffset.y === 0 && frame.brand === 'false' && frame.width === compact.width && frame.neighbour === compact.neighbour), 'sidebar toggles keep the compact header stable');
  assert.equal(await run("document.activeElement === document.querySelector('.window-sidebar-toggle')"), true, 'rolling icons retain keyboard focus');
  await clickToggle();
  const expanding = await run('toggleFrames(470)');
  assert.equal(expanding.at(-1).expanded, 'true');
  assert.ok(Math.abs(expanding.at(-1).iconOffset.x) < .1);

  // A drag-to-collapse update and rapid clicks use the actual sidebar state, not a queued animation state.
  await run("frameProps.collapsed = true; showFrame()");
  await pause(60);
  await clickToggle();
  await clickToggle();
  await pause(460);
  assert.equal(await run('readToggle().expanded'), 'false');
  assert.equal(await run('sidebarToggleCalls'), 4);
  assert.equal(await run('readToggle().brand'), 'false');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
  await until("readToggle().expanded === 'true'", 'keyboard sidebar toggle');
  await pause(460);

  window.webContents.debugger.attach('1.3');
  try {
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
    });
    await clickToggle();
    await pause(80);
    const reduced = await run('readToggle()');
    assert.equal(reduced.expanded, 'false');
    assert.ok(Math.abs(reduced.iconOffset.x + reduced.iconWidth) < .1, 'reduced motion immediately shows the correct icon');
  } finally {
    await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
    window.webContents.debugger.detach();
  }
  fs.writeFileSync(path.join(root, 'tmp/window-sidebar-toggle.png'), (await window.webContents.capturePage()).toPNG());

  await run("frameKey = 'early-interaction'; showFrame()");
  await until("readToggle().brand === 'true'", 'fresh startup for early input');
  await clickToggle();
  await until("readToggle().brand === 'false' && readToggle().expanded === 'true'", 'startup branding never delays user input');
  await run('renderView(null)');
  console.log('Title bar sidebar control passed: three-second brand, smooth compact width, horizontal rolls, native and keyboard clicks, external state, rapid reversal and reduced motion.');
};
