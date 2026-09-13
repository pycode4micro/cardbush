const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  const toggle = () => run("document.querySelector('.window-sidebar-toggle').click()");
  await until("settingsSidebarState.visible && document.querySelector('.settings-sidebar')?.getBoundingClientRect().width === 272");
  await pause(300);
  const frames = await run(`new Promise(resolve => {
    const frames = [], start = performance.now();
    document.querySelector('.window-sidebar-toggle').click();
    const sample = () => {
      const sidebar = document.querySelector('.settings-sidebar');
      if (sidebar) frames.push([sidebar.getBoundingClientRect().width, sidebar.firstElementChild.getBoundingClientRect().width]);
      if (performance.now() - start < 300) requestAnimationFrame(sample); else resolve(frames);
    };
    requestAnimationFrame(sample);
  })`);
  assert.ok(new Set(frames.map(frame => Math.round(frame[0]))).size > 2, 'settings sidebar animates through intermediate widths');
  assert.equal(new Set(frames.map(frame => Math.round(frame[1]))).size, 1, 'settings labels do not rewrap during collapse');
  await until("!document.querySelector('.settings-sidebar') && document.querySelector('.window-sidebar-toggle').getAttribute('aria-expanded') === 'false'");
  await toggle();
  await until("document.querySelector('.settings-sidebar')?.getBoundingClientRect().width === 272");

  let point, endX;
  const drag = async (offset, width) => {
    await until("settingsSidebarState.visible && new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.settings-sidebar')).transform).m41 === 0");
    const rect = await run("document.querySelector('.settings-sidebar').getBoundingClientRect().toJSON()");
    point = { x: Math.round(rect.right + offset), y: Math.round(rect.top + 100) };
    window.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    await until("document.body.classList.contains('sidebar-resizing')");
    endX = Math.round(point.x + width - rect.width);
    window.webContents.sendInputEvent({ type: 'mouseMove', x: endX, y: point.y, modifiers: ['leftButtonDown'] });
  };
  const release = () => window.webContents.sendInputEvent({ type: 'mouseUp', x: endX, y: point.y, button: 'left', clickCount: 1 });
  for (const [offset, width] of [[-6, 300], [6, 320]]) {
    await drag(offset, width);
    await until(`document.querySelector('.settings-sidebar').getBoundingClientRect().width === ${width}`);
    release();
    await until(`settingsSidebarState.width === ${width}`);
  }

  await run("document.querySelector('.settings-sidebar .back-button').click()");
  await until("!settingsSidebarState.active && document.querySelector('.desktop-shell .sidebar')?.getBoundingClientRect().width === 320");
  await toggle();
  await until('!settingsSidebarState.mounted');
  await run("document.querySelector('.main-stage button').click()");
  await until("settingsSidebarState.active && !document.querySelector('.settings-sidebar')");
  await toggle();
  await until("document.querySelector('.settings-sidebar')?.getBoundingClientRect().width === 320");

  await drag(6, 170);
  await until('settingsSidebarState.collapsed');
  release();
  await toggle();
  await until("document.querySelector('.settings-sidebar')?.getBoundingClientRect().width === 320");
  assert.equal(await run('settingsSidebarState.width'), 320, 'snap does not overwrite the saved width');

  await drag(-6, 350);
  await until("document.querySelector('.settings-sidebar').getBoundingClientRect().width === 350");
  await run('setSettingsActive(false)');
  await until("!document.body.classList.contains('sidebar-resizing') && document.querySelector('.desktop-shell .sidebar').getBoundingClientRect().width === 320");
  release();
  await run('setSettingsActive(true); restoreSidebarWidth()');
  await until("document.querySelector('.settings-sidebar')?.getBoundingClientRect().width === 272");
  await pause(300);
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(root, 'tmp/settings-sidebar-shared.png'), (await window.webContents.capturePage()).toPNG());
  console.log('Settings sidebar passed: shared title toggle and saved width, fixed content during animation, enlarged hit area, snap/reopen, page switching and drag cancellation.');
};
