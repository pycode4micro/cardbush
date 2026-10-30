const assert = require('node:assert/strict');
const { writeFile } = require('node:fs/promises');
const { resolve } = require('node:path');

module.exports = async ({ run, until, win, delay, pointer, readCanvas, path, childFrame }) => {
  await delay(500);
  const before = await readCanvas(path), originalFrame = childFrame().routingId;
  const viewport = await run(`(()=>{const r=document.querySelector('.canvas-plane').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()`);
  const click = label => run(`document.querySelector('.canvas-presentation [aria-label=${JSON.stringify(label)}]').click()`);
  const mode = text => run(`Array.from(document.querySelectorAll('.canvas-presentation-modes button')).find(b=>b.textContent===${JSON.stringify(text)}).click()`);
  const visible = () => run(`Array.from(document.querySelectorAll('.canvas-presentation-page')).filter(p=>!p.hidden).map(p=>p.dataset.presentationItem)`);
  const key = keyCode => { win.webContents.sendInputEvent({ type: 'keyDown', keyCode }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode }); };
  const frame = () => run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  const screenshot = async name => { await frame(); await writeFile(resolve('tmp/' + name + '.png'), (await win.webContents.capturePage()).toPNG()); };
  const fit = async () => {
    await frame();
    assert.equal(await run(`Array.from(document.querySelectorAll('.canvas-presentation-page:not([hidden])')).every(page=>{const body=page.querySelector('.canvas-presentation-page-body').getBoundingClientRect(),paper=page.querySelector('.canvas-presentation-paper').getBoundingClientRect();return paper.width>0&&paper.height>0&&paper.left>=body.left-.5&&paper.right<=body.right+.5&&paper.top>=body.top-.5&&paper.bottom<=body.bottom+.5})`), true, 'each region fits entirely within its page');
  };

  // Selection alone must not leave controls floating over (or above) a region.
  await run(`document.querySelector('[data-canvas-item=interactive]').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}));document.activeElement?.blur()`);
  pointer('mouseMove', { x: 20, y: 20 }); await delay(180);
  assert.equal(await run(`getComputedStyle(document.querySelector('[data-canvas-item=interactive] .canvas-item-tools')).opacity`), '0');
  assert.equal(await run(`getComputedStyle(document.querySelector('[data-canvas-item=interactive] .canvas-item-tools')).pointerEvents`), 'none');
  const hover = await run(`(()=>{const r=document.querySelector('[data-canvas-item=interactive]').getBoundingClientRect();return{x:Math.round(r.x+10),y:Math.round(r.y+10)}})()`);
  pointer('mouseMove', hover); await delay(180);
  assert.equal(await run(`getComputedStyle(document.querySelector('[data-canvas-item=interactive] .canvas-item-tools')).opacity`), '1');
  assert.equal(await run(`(()=>{const item=document.querySelector('[data-canvas-item=interactive]'),a=item.getBoundingClientRect(),b=item.querySelector('.canvas-item-tools').getBoundingClientRect();return b.left>=a.left&&b.right<=a.right&&b.top>=a.top&&b.bottom<=a.bottom})()`), true, 'toolbar is inside its region');
  await screenshot('canvas-toolbar-inside');
  pointer('mouseMove', { x: 20, y: 20 }); await delay(180);
  assert.equal(await run(`getComputedStyle(document.querySelector('[data-canvas-item=interactive] .canvas-item-tools')).opacity`), '0');

  await run(`document.querySelector('.canvas-present-button').focus();document.querySelector('.canvas-present-button').click()`);
  await until(`!!document.querySelector('.canvas-presentation[open]')`);
  assert.deepEqual(await visible(), ['interactive'], 'presentation starts at the selected region');
  await fit();
  await until(`!!document.querySelector('.canvas-presentation [data-presentation-item=interactive] iframe')`);
  const deadline = Date.now() + 10000;
  let presentationFrame;
  while (Date.now() < deadline) {
    presentationFrame = win.webContents.mainFrame.frames.find(f => f.url.startsWith('about:srcdoc') && f.routingId !== originalFrame);
    if (presentationFrame && await presentationFrame.executeJavaScript('!!document.querySelector("button")').catch(() => false)) break;
    await delay(60);
  }
  assert.ok(presentationFrame, 'presentation HTML loaded');
  await presentationFrame.executeJavaScript('document.querySelector("button").click()');
  await screenshot('canvas-presentation-pages');
  await click('下一页'); await until(`!document.querySelector('[data-presentation-item=alignment]').hidden`);
  assert.deepEqual(await visible(), ['alignment']); await fit();
  assert.equal(await run(`document.querySelector('.canvas-presentation [aria-label=下一页]').disabled`), true);
  key('Home'); await until(`!document.querySelector('[data-presentation-item=interactive]').hidden`);
  assert.equal(await presentationFrame.executeJavaScript('document.querySelector("button").textContent'), '1', 'page changes preserve interactive state');
  key('PageDown'); await until(`!document.querySelector('[data-presentation-item=alignment]').hidden`);
  await mode('连续整页'); await until(`document.querySelector('.canvas-presentation').dataset.mode==='continuous'`);
  assert.deepEqual(await visible(), ['interactive', 'alignment']); await fit();
  assert.equal(await run(`document.querySelector('.canvas-presentation [role=status]').textContent`), '第 2 / 2 页');
  await click('上一页'); await until(`document.querySelector('.canvas-presentation-viewport').scrollTop===0`);
  await run(`document.querySelector('.canvas-presentation-viewport').scrollTop=100000`);
  await until(`document.querySelector('.canvas-presentation [role=status]').textContent==='第 2 / 2 页'`);
  await screenshot('canvas-presentation-continuous');

  // Language changes must update the mounted dialog; narrow windows and light theme use the same layout.
  const size = win.getContentSize(); win.setContentSize(620, 820);
  await run(`canvasAppearance('en','bright')`);
  await until(`!!document.querySelector('.canvas-presentation [aria-label="Exit presentation"]') && window.innerWidth===620`);
  await fit(); await mode('Pages'); await fit();
  assert.equal(await run(`getComputedStyle(document.querySelector('.canvas-presentation')).backgroundColor`), 'rgb(255, 255, 255)');
  assert.equal(await run(`getComputedStyle(document.querySelector('.canvas-presentation-page:not([hidden]) .markdown-content h1')).color`), 'rgb(229, 229, 229)', 'dark paper keeps readable headings under the light App theme');
  assert.equal(await run(`document.querySelector('.canvas-presentation [role=status]').textContent`), 'Page 2 of 2');
  assert.equal(await run(`(()=>{const r=document.querySelector('.canvas-presentation-toolbar').getBoundingClientRect();return [...document.querySelectorAll('.canvas-presentation-toolbar button')].every(b=>{const q=b.getBoundingClientRect();return q.left>=r.left&&q.right<=r.right})})()`), true, 'translated controls fit a narrow window');
  await screenshot('canvas-presentation-narrow-light');
  await run(`canvasAppearance('zh','dark')`); win.setContentSize(...size);
  await until(`window.innerWidth===${size[0]} && !!document.querySelector('.canvas-presentation [aria-label=退出演示]')`);
  await fit();
  await run(`document.querySelector('.canvas-presentation [aria-label=进入全屏]').click()`, true);
  await until(`!!document.fullscreenElement && !!document.querySelector('.canvas-presentation [aria-label=退出全屏]')`);
  assert.equal(await run('document.fullscreenElement.classList.contains("canvas-presentation-screen")'), true);
  await click('退出全屏'); await until(`!document.fullscreenElement && !!document.querySelector('.canvas-presentation [aria-label=进入全屏]')`);
  await run(`document.querySelector('.canvas-presentation [aria-label=进入全屏]').click()`, true);
  await until('!!document.fullscreenElement');
  await click('退出演示');
  await until(`!document.querySelector('.canvas-presentation') && !document.fullscreenElement && innerWidth===${size[0]} && innerHeight===${size[1]}`);
  console.log('Canvas presentation passed: native fullscreen entry, exit and close cleanup.');
  assert.equal((await readCanvas(path)).revision, before.revision, 'presenting never writes to the canvas');
  assert.equal(childFrame().routingId, originalFrame);
  assert.equal(await childFrame().executeJavaScript('document.querySelector("button").textContent'), '2', 'editor HTML state is unchanged');
  await delay(500); await frame();
  assert.deepEqual(await run(`(()=>{const r=document.querySelector('.canvas-plane').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()`), viewport, 'exiting restores the editor viewport: ' + JSON.stringify(await run('({w:innerWidth,h:innerHeight,stage:document.querySelector(".canvas-stage").getBoundingClientRect().toJSON()})')));
  assert.equal(await run(`document.activeElement===document.querySelector('.canvas-present-button')`), true, 'focus returns to presentation launcher');
  await run(`document.querySelector('.canvas-present-button').click()`); await until(`!!document.querySelector('.canvas-presentation[open]')`);
  await run(`document.querySelector('.canvas-presentation-viewport').focus()`); key('Escape'); await until(`!document.querySelector('.canvas-presentation')`);
  console.log('Canvas presentation passed: hover-only controls, fitting, pagination, continuous scrolling, language, theme, narrow window and state preservation.');
};
