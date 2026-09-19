const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

module.exports = async ({ win, run, until, pause, root }) => {
  if (process.platform !== 'win32') return;
  let systemMenuEvents = 0;
  const onSystemMenu = event => { systemMenuEvents++; event.preventDefault(); };
  win.on('system-context-menu', onSystemMenu);
  // A hidden native window does not continuously paint CSS animations. Those
  // animations have their own offscreen renderer tests; freeze them here.
  const animationStyle = await win.webContents.insertCSS('.window-sidebar-toggle { transition: none !important; }');
  const nativeProbe = (points, command) => new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
      path.join(root, 'scripts/helpers/window-native-hit.ps1')], { windowsHide: true, timeout: 8000 });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error(`Native probe failed: ${stderr}`));
      else { try { resolve(JSON.parse(stdout)); } catch (error) { reject(error); } }
    });
    const handle = win.getNativeWindowHandle();
    child.stdin.end(JSON.stringify({ handle: (handle.length === 8 ? handle.readBigUInt64LE() : BigInt(handle.readUInt32LE())).toString(),
      ownerPid: process.pid, points, zoom: win.webContents.getZoomFactor(), menu: command === undefined, command }));
  });
  const check = async label => {
    const points = await run(`(() => {
      const center = (selector, name, fraction = .5) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { name, x: rect.x + rect.width * fraction, y: rect.y + rect.height / 2 };
      };
      if (document.querySelector('.window-button')) throw Error('Windows must not render duplicate DOM caption buttons');
      const area = navigator.windowControlsOverlay?.getTitlebarAreaRect();
      if (!area || area.width <= 0 || area.right >= innerWidth) throw Error('Native titlebar safe area is unavailable');
      const width = (innerWidth - area.right) / 3;
      return [center('.window-spacer', 'drag-left', .1), center('.window-spacer', 'drag-center'),
        center('.window-spacer', 'drag-right', .9), center('.window-sidebar-toggle', 'sidebar-button'),
        center('.frame-chip', 'menu-button'),
        ...['minimize', 'maximize', 'close'].map((name, index) => ({
          name: 'caption-' + name, x: area.right + width * (index + .5), y: area.y + area.height / 2,
        }))];
    })()`);
    const before = systemMenuEvents;
    const result = await nativeProbe(points);
    const captionHits = { 'caption-minimize': 8, 'caption-maximize': 9, 'caption-close': 20 };
    for (const sample of result.hits) assert.equal(sample.hit, captionHits[sample.name] ?? (sample.name.startsWith('drag') ? 2 : 1), `${label}: ${sample.name} native hit-test`);
    for (const command of [0xf120, 0xf010, 0xf000, 0xf020, 0xf030, 0xf060]) {
      assert.ok(result.commands.includes(command), `${label}: native system menu retains command ${command}`);
    }
    await pause(40);
    assert.ok(systemMenuEvents > before, `${label}: Windows system menu reaches Electron`);
  };
  const waitForNative = async (condition, label) => {
    for (let i = 0; i < 100; i++) { if (condition()) return; await pause(25); }
    throw Error('Native window command timed out: ' + label);
  };
  try {
    await run(`openFixtureSettings(false); void 0`);
    await until("!!document.querySelector('.main-stage')", 'titlebar fixture surface');
    // The startup brand contracts after three seconds. Sample settled controls
    // so their centers cannot move during the native probe's process startup.
    await until("document.querySelector('.window-sidebar-toggle')?.dataset.brandVisible === 'false' && document.querySelector('.window-sidebar-toggle').getBoundingClientRect().width <= 29", 'settled titlebar controls');
    await run(`
      const scroller = document.createElement('div'); scroller.id = 'native-titlebar-scroll-test';
      Object.assign(scroller.style, { position:'absolute', inset:'0', overflow:'auto', background:'var(--bg)' });
      scroller.innerHTML = Array.from({length:160}, (_, i) => '<div style="height:40px"><button style="height:36px;width:100%">Tool '+i+'</button><input><select><option>mode</option></select><textarea></textarea></div>').join('');
      document.querySelector('.main-stage').append(scroller);
    `);
    await pause(120);
    await check('before scrolling');
    for (const offset of [200, 550, 900, 1700]) {
      await run(`document.getElementById('native-titlebar-scroll-test').scrollTop = ${offset}; void 0`);
      await pause(60);
      await check(`scroll ${offset}`);
    }
    await run("openFixtureSettings(true); void 0");
    await until("!!document.querySelector('.settings-content')", 'titlebar settings surface');
    await check('settings switch');
    win.webContents.setZoomFactor(1.25);
    await pause(120);
    await check('125% zoom');
    win.webContents.setZoomFactor(.8);
    await pause(120);
    await check('80% zoom');
    win.webContents.setZoomFactor(1);
    await run('openFixtureSettings(false); void 0');
    await until("!!document.querySelector('textarea[data-composer-input]')", 'composer before native resize');
    await run("window.nativeResizeInput = document.querySelector('textarea[data-composer-input]'); void 0");
    const composerHeight = await run('nativeResizeInput.getBoundingClientRect().height');

    // Only the isolated HWND receives these commands. Keep it invisible and
    // unfocusable even when Windows maximizes/restores it during the check.
    win.setOpacity(0);
    win.setFocusable(false);
    win.setSkipTaskbar(true);
    let closeObserved = false;
    const closeToTray = event => { event.preventDefault(); closeObserved = true; win.hide(); };
    win.on('close', closeToTray);
    try {
      await nativeProbe([], 0xf030);
      await waitForNative(() => win.isMaximized(), 'maximize');
      await pause(120);
      await check('maximized');
      await nativeProbe([], 0xf120);
      await waitForNative(() => !win.isMaximized() && !win.isMinimized(), 'restore');
      await until(`Math.abs(nativeResizeInput.getBoundingClientRect().height - ${composerHeight}) <= 1`, 'composer height after native restore');
      assert.equal(await run("nativeResizeInput === document.querySelector('textarea[data-composer-input]')"), true, 'native maximize/restore must not remount the input');
      await nativeProbe([], 0xf020);
      await waitForNative(() => win.isMinimized(), 'minimize');
      await nativeProbe([], 0xf120);
      await waitForNative(() => !win.isMinimized(), 'restore from taskbar');
      await until(`Math.abs(nativeResizeInput.getBoundingClientRect().height - ${composerHeight}) <= 1`, 'composer height after taskbar restore');
      await nativeProbe([], 0xf060);
      await waitForNative(() => closeObserved && !win.isVisible(), 'close to tray');
      assert.equal(win.isDestroyed(), false, 'native close retains close-to-tray behavior');
    } finally {
      win.hide();
      win.removeListener('close', closeToTray);
      win.setOpacity(1);
      win.setFocusable(true);
      win.setSkipTaskbar(false);
    }
  } finally {
    win.webContents.setZoomFactor(1);
    win.removeListener('system-context-menu', onSystemMenu);
    await win.webContents.removeInsertedCSS(animationStyle);
    await run("document.getElementById('native-titlebar-scroll-test')?.remove(); openFixtureSettings(false); void 0");
  }
  console.log('Native titlebar passed: native caption hit targets after scrolling, drag regions, settings, 80%/125% zoom, maximize/restore/minimize, system menu and close to tray.');
};
