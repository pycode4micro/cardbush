const assert = require('node:assert/strict');
const { writeFile } = require('node:fs/promises');
const { resolve } = require('node:path');

module.exports = async ({ run, until, win, delay, pointer, point, readCanvas, path }) => {
  const frame = () => run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await until('window.canvasPendingWrites===0'); await frame();
  const initialSize = win.getContentSize(), before = await readCanvas(path);
  // The previous implementation permanently froze the camera after either edit.
  // Exercise real window resizing after the worker's pointer move and resize.
  for (const [width, height] of [[1920, 1032], [680, 860], initialSize]) {
    win.setContentSize(width, height);
    await until(`innerWidth===${width} && innerHeight===${height}`); await delay(150); await frame();
    const layout = await run(`(()=>{
      const stage=document.querySelector('.canvas-stage'),r=stage.getBoundingClientRect(),w=document.querySelector('.canvas-workspace').getBoundingClientRect();
      const items=[...document.querySelectorAll('[data-canvas-item]')].map(item=>item.getBoundingClientRect());
      const left=Math.min(...items.map(r=>r.left)),right=Math.max(...items.map(r=>r.right)),top=Math.min(...items.map(r=>r.top)),bottom=Math.max(...items.map(r=>r.bottom));
      return {stage:r.toJSON(),workspace:w.toJSON(),left,right,top,bottom,inset:parseFloat(getComputedStyle(stage).getPropertyValue('--canvas-inset')),zoom:new DOMMatrix(getComputedStyle(document.querySelector('.canvas-plane')).transform).a};
    })()`);
    const { stage, workspace, left, right, top, bottom, inset, zoom } = layout;
    assert.ok(Math.abs(stage.width - workspace.width) < 1 && Math.abs(stage.height - workspace.height) < 1, 'canvas surface fills the available workspace');
    assert.ok(left >= stage.left + inset - 1 && right <= stage.right - inset + 1 && top >= stage.top + inset - 1 && bottom <= stage.bottom - inset - 44 + 1, 'all regions remain visible');
    assert.ok(Math.abs((left + right) / 2 - (stage.left + stage.right) / 2) < 1, `editing does not leave the old viewport anchored on the left: ${JSON.stringify(layout)}`);
    assert.ok(Math.abs((top + bottom) / 2 - (stage.top + stage.bottom - 44) / 2) < 1, 'auto-fit remains vertically centred after editing');
    assert.ok(Math.abs(right - left - (stage.width - inset * 2)) < 1 || Math.abs(bottom - top - (stage.height - inset * 2 - 44)) < 1 || Math.abs(zoom - 2) < .001, 'content uses the available space up to the readable zoom limit');
    assert.equal(await run('document.querySelector("[aria-label=适应窗口]").getAttribute("aria-pressed")'), 'true');
    if (width === 1920) await writeFile(resolve('tmp/canvas-auto-fit-wide.png'), (await win.webContents.capturePage()).toPNG());
  }
  assert.equal((await readCanvas(path)).revision, before.revision, 'window resizing never rewrites saved frames');

  const oldFrame = before.document.items.find(item => item.id === 'interactive').frame;
  await run('document.querySelector("[data-canvas-item=interactive] .canvas-item-move").focus()');
  for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Right' });
  await until(`testBridge.creationCanvas({action:'read',path:${JSON.stringify(path)}}).then(s=>s.document.items.find(i=>i.id==='interactive').frame.x===${oldFrame.x + 1})`);
  await until('window.canvasPendingWrites===0'); await frame();
  assert.equal(await run('document.querySelector("[aria-label=适应窗口]").getAttribute("aria-pressed")'), 'true', 'keyboard edits also preserve auto-fit');

  const beforeCancel = await readCanvas(path), handle = await point('[data-canvas-item=interactive] .canvas-item-move');
  pointer('mouseDown', handle); pointer('mouseMove', { x: handle.x + 35, y: handle.y + 20 }); await delay(80);
  for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'Escape' });
  pointer('mouseUp', { x: handle.x + 35, y: handle.y + 20 }); await until('!document.querySelector(".canvas-drag-shield")'); await frame();
  assert.equal((await readCanvas(path)).revision, beforeCancel.revision, 'cancelled edits do not write to the document');
  assert.equal(await run('document.querySelector("[aria-label=适应窗口]").getAttribute("aria-pressed")'), 'true', 'cancel releases the temporary camera lock');
  console.log('Canvas auto-fit passed: full workspace surface, move/resize/keyboard edits, cancellation, wide and narrow windows, and unchanged document geometry during window resizing.');
};
