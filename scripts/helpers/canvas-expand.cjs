const assert = require('node:assert/strict');
const { writeFile } = require('node:fs/promises');
const { resolve, dirname } = require('node:path');
const { fileURLToPath } = require('node:url');
const { BrowserWindow } = require('electron');

module.exports = async ({ run, until, win, delay, pointer, point, readCanvas, design, path, childFrame }) => {
  const before = await readCanvas(path), initialSize = win.getContentSize(), frameId = childFrame().routingId;
  const settled = async () => { await until('window.canvasPendingWrites===0'); await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); };
  const rect = id => run(`document.querySelector('[data-canvas-item=${id}]').getBoundingClientRect().toJSON()`);
  const manualView = async (zoom, x, y) => {
    await run(`(()=>{const stage=document.querySelector('.canvas-stage'),r=stage.getBoundingClientRect(),z=new DOMMatrix(getComputedStyle(document.querySelector('.canvas-plane')).transform).a;stage.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,ctrlKey:true,deltaY:-Math.log(${zoom}/z)/.002,clientX:r.left,clientY:r.top}))})()`);
    await settled();
    await run(`(()=>{const stage=document.querySelector('.canvas-stage'),r=stage.getBoundingClientRect(),p=document.querySelector('.canvas-plane').getBoundingClientRect();stage.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaX:p.left-r.left-${x},deltaY:p.top-r.top-${y}}))})()`);
    await settled();
  };
  const drag = async (dx, dy, selector = '.canvas-item-move') => {
    const saved = await readCanvas(path), peer = await rect('alignment'), item = await rect('interactive');
    const start = await point('[data-canvas-item=interactive] ' + selector), end = { x: start.x + dx, y: start.y + dy };
    pointer('mouseDown', start, ['alt']); pointer('mouseMove', end, ['alt']); await delay(100); pointer('mouseUp', end, ['alt']);
    await until(`testBridge.creationCanvas({action:'read',path:${JSON.stringify(path)}}).then(s=>s.revision!==${JSON.stringify(saved.revision)})`);
    await settled();
    const afterPeer = await rect('alignment'), afterItem = await rect('interactive');
    assert.ok(Math.abs(peer.x - afterPeer.x) < 1 && Math.abs(peer.y - afterPeer.y) < 1, 'growing/rebasing must not shift unrelated regions on screen');
    if (selector === '.canvas-item-move') {
      assert.ok(Math.abs(afterItem.x - item.x - dx) < 1 && Math.abs(afterItem.y - item.y - dy) < 1, 'the region follows the pointer into formerly blocked grid space');
    }
    return (await readCanvas(path)).document;
  };

  // Match the reported layout: a region touches the top and right of a 1440x960 document.
  const interactive = before.document.items.find(item => item.id === 'interactive');
  const alignment = before.document.items.find(item => item.id === 'alignment');
  await design({ action: 'update', path, expected_revision: before.revision, layout: true,
    canvas: { width: 1440, height: 960 }, upsert: [
      { ...interactive, frame: { x: 692, y: 0, width: 748, height: 430 } },
      { ...alignment, frame: { x: 20, y: 20, width: 620, height: 300 } },
    ] });
  await until('document.querySelector("[data-canvas-item=interactive]").style.top==="0px"');
  win.setContentSize(1060, 780); await until('innerWidth===1060'); await delay(150);
  await manualView(.63, 10, 300);
  win.maximize();
  for (let i = 0; i < 100 && !win.isMaximized(); i++) await delay(50);
  assert.equal(win.isMaximized(), true, 'exercise native maximize, not only setContentSize');
  await until('document.querySelector("[aria-label=适应窗口]").getAttribute("aria-pressed")==="true"'); await delay(400); await settled();
  assert.equal(await run(`(()=>{const s=document.querySelector('.canvas-stage').getBoundingClientRect(),items=[...document.querySelectorAll('[data-canvas-item]')].map(e=>e.getBoundingClientRect());return items.every(r=>r.left>=s.left&&r.right<=s.right&&r.top>=s.top&&r.bottom<=s.bottom-44)&&Math.abs((Math.min(...items.map(r=>r.left))+Math.max(...items.map(r=>r.right)))/2-(s.left+s.right)/2)<1})()`), true, 'maximizing replaces the old small, panned view with a centred fit');
  await writeFile(resolve('tmp/canvas-native-maximized.png'), (await win.webContents.capturePage()).toPNG());

  await manualView(.63, 20, 390);
  const up = await drag(0, -170);
  assert.ok(up.height > 960 && up.items.find(item => item.id === 'alignment').frame.y > 20, 'top expansion is saved using compatible nonnegative coordinates');
  const right = await drag(250, 0);
  assert.ok(right.width > 1440, 'right expansion grows the saved document');
  await writeFile(resolve('tmp/canvas-drag-past-old-boundaries.png'), (await win.webContents.capturePage()).toPNG());

  await manualView(.63, 250, 180);
  const moved = right.items.find(item => item.id === 'interactive');
  const left = await drag(-Math.round((moved.frame.x + 60) * .63), 0);
  assert.equal(left.items.find(item => item.id === 'interactive').frame.x, 0);
  assert.ok(left.items.find(item => item.id === 'alignment').frame.x > 20, 'left expansion rebases the saved coordinates');

  await manualView(.35, 180, 20);
  const current = left.items.find(item => item.id === 'interactive').frame;
  const down = await drag(0, Math.round((left.height - current.height - current.y + 120) * .35));
  assert.ok(down.height > left.height, 'bottom expansion grows the saved document');
  const resized = await drag(70, 35, '[data-resize-handle=se]');
  assert.ok(resized.height > down.height, 'resizing also crosses the old bottom edge');
  assert.equal(childFrame().routingId, frameId);
  assert.equal(await childFrame().executeJavaScript('document.querySelector("button").textContent'), '2', 'coordinate rebasing preserves interactive HTML state');

  // Open the saved manifest through a fresh renderer without disturbing the original iframe.
  const reopened = new BrowserWindow({ show: false, width: 1440, height: 1020,
    webPreferences: { preload: resolve(dirname(fileURLToPath(win.webContents.getURL())), '../preload.cjs'),
      webviewTag: true, contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: true, backgroundThrottling: false } });
  try {
    await reopened.loadURL(win.webContents.getURL());
    await reopened.webContents.executeJavaScript(`testBridge.creationCanvas({action:'read',path:${JSON.stringify(path)}}).then(snapshot=>canvasStore.acceptCanvas(snapshot))`);
    let rendered;
    for (let i = 0; i < 200; i++) {
      rendered = await reopened.webContents.executeJavaScript(`(()=>{const e=document.querySelector('[data-canvas-item=interactive]');return e&&{x:parseFloat(e.style.left),y:parseFloat(e.style.top),width:parseFloat(e.style.width),height:parseFloat(e.style.height)}})()`);
      if (rendered) break; await delay(50);
    }
    assert.deepEqual(rendered, resized.items.find(item => item.id === 'interactive').frame, 'expanded layout reopens from disk: ' + await reopened.webContents.executeJavaScript('document.body.innerText.slice(0,500)'));
  } finally { reopened.destroy(); }

  const latest = await readCanvas(path);
  await design({ action: 'update', path, expected_revision: latest.revision, layout: true,
    canvas: { width: before.document.width, height: before.document.height }, upsert: before.document.items });
  await until(`document.querySelector('[data-canvas-item=interactive]').style.top===${JSON.stringify(interactive.frame.y + 'px')}`);
  win.unmaximize(); win.setContentSize(...initialSize);
  await until(`innerWidth===${initialSize[0]} && innerHeight===${initialSize[1]}`); await settled();
  console.log('Canvas expansion passed: native maximize after manual pan/zoom, pointer movement past all four edges, resizing, stable peer/iframe state, and reopening saved geometry.');
};
