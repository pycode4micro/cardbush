const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  window.setContentSize(1280, 960);
  const click = text => run(`[...document.querySelectorAll('button')].find(button=>button.textContent===${JSON.stringify(text)}).click()`);
  // Offscreen Electron tracks activeElement but does not dispatch native focusin
  // while its window is hidden. Deliver that event explicitly for keyboard tests.
  const focusRow = text => run(`(()=>{const button=[...document.querySelectorAll('.welcome-component-picker button')].find(x=>x.textContent===${JSON.stringify(text)});button.focus();button.dispatchEvent(new FocusEvent('focusin',{bubbles:true}));})()`);
  const bounds = selector => run(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}})()`);
  const center = rect => ({ x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) });
  const mouse = (type, point, alt = false) => window.webContents.sendInputEvent({ type, x: Math.round(point.x), y: Math.round(point.y),
    ...(type === 'mouseDown' || type === 'mouseUp' ? { button: 'left', clickCount: 1 } : {}), ...(alt ? { modifiers: ['alt'] } : {}) });
  const grab = async (selector, alt = false) => { const at = center(await bounds(selector)); mouse('mouseMove', at); await pause(60); mouse('mouseDown', at, alt); await pause(30); return at; };
  const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 2, `${message}: ${actual} vs ${expected}`);
  await run(`
    (()=>{const state=JSON.parse(localStorage.getItem('cardbush.html_components.v1'));views.saveComponents({...state,welcomeLayout:{items:[
      {componentId:'system-digital-clock',x:10,y:100,width:22,height:150},
      {componentId:'system-calendar',x:55,y:300,width:30,height:220},
      {componentId:'system-brand',x:15,y:1100,width:70,height:120}
    ]}},state.revision)})();showWelcomeLibrary();
  `);
  await until('!!document.querySelector(".components-app")', 'interaction library');
  await click('编辑布局'); await until('!!document.querySelector(".welcome-layout-editor")', 'interaction editor');
  await run(`Object.assign(document.querySelector('.main-stage').style,{zoom:'1.25',width:'80%',height:'80%',flex:'none'});void 0`);
  await pause();
  await until('Number(document.querySelector(".welcome-layout-bottom-hint")?.dataset.layoutOverflow)>0', 'long layout reports content beyond the viewport');
  const overflow = await run('Number(document.querySelector(".welcome-layout-bottom-hint").dataset.layoutOverflow)');
  await run('document.querySelector(".welcome-layout-surface").style.scrollbarWidth="none"');
  await pause();
  assert.equal(await run('document.querySelector(".welcome-layout-bottom-hint").classList.contains("is-overflow")'),true,'warning remains when the scrollbar is hidden');
  window.setContentSize(1280,800);
  await until(`Number(document.querySelector('.welcome-layout-bottom-hint').dataset.layoutOverflow)>${overflow}`, 'window height updates overflow');
  window.setContentSize(1280,960);
  await until(`Number(document.querySelector('.welcome-layout-bottom-hint').dataset.layoutOverflow)===${overflow}`, 'restored window restores overflow measurement');
  const clock = '[data-welcome-component=system-digital-clock]', calendar = '[data-welcome-component=system-calendar]';
  const first = await bounds(clock), start = await grab(clock, true), end = { x: start.x + 43, y: start.y + 61 };
  mouse('mouseMove', end, true); await pause(40); mouse('mouseUp', end, true); await pause();
  let moved = await bounds(clock);
  close(moved.x - first.x, 43, '125% zoom drag keeps horizontal grab point');
  close(moved.y - first.y, 61, '125% zoom drag keeps vertical grab point');
  const peer = await bounds(calendar), beforeSnap = moved, snapStart = await grab(clock);
  const snapEnd = { x: snapStart.x + peer.x - beforeSnap.right + 3, y: snapStart.y + peer.y - beforeSnap.y + 3 };
  mouse('mouseMove', snapEnd); await pause();
  assert.equal(await run('document.querySelectorAll(".welcome-alignment-guide").length>=2'), true, 'guides appear during drag');
  moved = await bounds(clock); close(moved.right, peer.x, 'moving snaps right edge to peer left'); close(moved.y, peer.y, 'moving snaps top edges');
  fs.writeFileSync(path.join(root, 'tmp', 'welcome-layout-alignment.png'), (await window.webContents.capturePage()).toPNG());
  mouse('mouseUp', snapEnd); await pause();
  assert.equal(await run('document.querySelectorAll(".welcome-alignment-guide").length'), 0, 'release clears guides');
  const sizeStart = await grab('.welcome-layout-resize[aria-label$=数字时钟]');
  const sizeEnd = { x: sizeStart.x + peer.right - moved.right - 3, y: sizeStart.y + peer.bottom - moved.bottom - 3 };
  mouse('mouseMove', sizeEnd); await pause();
  const resized = await bounds(clock); close(resized.right, peer.right, 'resizing snaps right edge'); close(resized.bottom, peer.bottom, 'resizing snaps bottom edge');
  mouse('mouseUp', sizeEnd); await pause();
  // The overlapped peer covers the right side; use the clock's left quarter.
  const beforeScroll = await bounds(clock), scrollStart = { x: beforeScroll.x + 30, y: beforeScroll.y + 30 };
  mouse('mouseMove', scrollStart); mouse('mouseDown', scrollStart, true); await pause(30);
  await run('document.querySelector(".welcome-layout-surface").scrollTop+=80;void 0'); await pause();
  close((await bounds(clock)).y, beforeScroll.y, 'scrolling while captured keeps component under pointer');
  const scrollEnd = { x: scrollStart.x + 15, y: scrollStart.y + 25 };
  mouse('mouseMove', scrollEnd, true); mouse('mouseUp', scrollEnd, true); await pause();
  close((await bounds(clock)).y, beforeScroll.y + 25, 'scroll and final pointer movement are both applied');
  const beforeCancel = await bounds(clock), cancelStart = { x: beforeCancel.x + 30, y: beforeCancel.y + 30 };
  assert.equal(await run(`document.elementFromPoint(${cancelStart.x},${cancelStart.y})?.closest('[data-welcome-component]')?.dataset.welcomeComponent`), 'system-digital-clock', 'cancel grab is on the clock');
  mouse('mouseMove', cancelStart); mouse('mouseDown', cancelStart, true); await pause(30);
  assert.equal(await run('document.body.classList.contains("component-layout-editing")'), true, 'cancel drag has pointer capture');
  mouse('mouseMove', { x: cancelStart.x + 20, y: cancelStart.y + 20 }, true); await pause(30);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); await pause();
  mouse('mouseUp', cancelStart, true);
  close((await bounds(clock)).y, beforeCancel.y, 'Escape restores drag and releases capture');
  assert.equal(await run('document.body.classList.contains("component-layout-editing")'), false);

  const bar = await bounds('.welcome-layout-toolbar'), editor = await bounds('.welcome-layout-editor'), handle = await grab('.welcome-toolbar-drag');
  const barEnd = { x: handle.x - 90, y: editor.bottom - 45 };
  mouse('mouseMove', barEnd); mouse('mouseUp', barEnd); await pause();
  const barMoved = await bounds('.welcome-layout-toolbar');
  close(barMoved.x - bar.x, -90, 'toolbar drag follows scaled pointer');
  assert.ok(barMoved.bottom <= editor.bottom && barMoved.y > editor.y + editor.height / 2, 'toolbar can rest near the bottom');
  await click('组件'); await until('!!document.querySelector(".welcome-component-picker")', 'component picker');
  const menu = await bounds('.welcome-component-picker'); assert.ok(menu.bottom < barMoved.y, 'low toolbar opens menu upward');
  await focusRow('日历');
  await until('!!document.querySelector(".welcome-component-preview .builtin-calendar")', 'keyboard focus previews calendar');
  const preview = await bounds('.welcome-component-preview');
  assert.ok(preview.x >= editor.x && preview.right <= editor.right && preview.y >= editor.y && preview.bottom <= editor.bottom, 'preview remains inside editor');
  assert.ok(preview.bottom < barMoved.y, 'preview does not cover Cancel or Save');
  fs.writeFileSync(path.join(root, 'tmp', 'welcome-component-preview.png'), (await window.webContents.capturePage()).toPNG());
  const digitalRow = await run('(()=>{const r=[...document.querySelectorAll(".welcome-component-picker button")].find(x=>x.textContent==="数字时钟").getBoundingClientRect();return {x:r.x+30,y:r.y+r.height/2}})()');
  mouse('mouseMove', digitalRow); await until('!!document.querySelector(".welcome-component-preview .builtin-digital-time")', 'pointer hover previews digital clock');
  await focusRow('HTML test');
  await until('!!document.querySelector(".welcome-component-preview iframe")', 'HTML hover preview'); await pause();
  const guest = window.webContents.mainFrame.framesInSubtree.find(frame => frame.url === 'about:srcdoc'); assert.ok(guest);
  const previous = await run('localStorage.getItem("cardbush.component-state.welcome-html")'), events = await run('componentEvents.length');
  assert.equal(await guest.executeJavaScript('cardbush.state.write({preview:true}).then(()=>"bad",error=>error.message)'), 'INACTIVE_SURFACE');
  assert.equal(await guest.executeJavaScript('cardbush.invoke("conversation.send",{text:"preview must not send"}).then(()=>"bad",error=>error.message)'), 'INACTIVE_SURFACE');
  assert.equal(await run('localStorage.getItem("cardbush.component-state.welcome-html")'), previous);
  assert.equal(await run('componentEvents.length'), events);
  await focusRow('输入框');
  await until('!!document.querySelector(".welcome-component-preview [data-composer-input]")', 'actual composer preview');
  assert.equal(await run('document.activeElement.textContent'), '输入框', 'preview does not steal keyboard focus');
  assert.equal(await run('document.querySelector(".welcome-component-preview [data-composer-input]").closest("[inert]")!==null'), true);
  await click('组件'); await until('!document.querySelector(".welcome-component-preview")', 'closing picker clears preview');
  const scrolled = await run('(()=>{const c=document.querySelector(".welcome-layout-surface");c.scrollTop=480;return c.scrollTop})()');
  assert.equal(await run('Number(document.querySelector(".welcome-layout-bottom-hint").dataset.layoutOverflow)'),overflow,'scrolling does not hide the total layout overflow');
  assert.equal(await run('(()=>{const hint=document.querySelector(".welcome-layout-bottom-hint").getBoundingClientRect(),page=document.querySelector(".welcome-editor-page").getBoundingClientRect();return hint.top>=page.top&&hint.bottom<=page.bottom&&hint.left>=page.left&&hint.right<=page.right})()'),true,'bottom hint stays visible outside the scrolled canvas');
  const placementsBeforeAdd = await run('[...document.querySelectorAll("[data-welcome-component]")].map(s=>({id:s.dataset.welcomeComponent,left:s.style.left,top:s.style.top,width:s.style.width,height:s.style.height}))');
  await click('组件'); await click('时钟'); await pause();
  assert.equal(await run('document.querySelector(".welcome-layout-surface").scrollTop'),scrolled,'adding does not jump away from the scrolled viewport');
  assert.equal(await run('(()=>{const c=document.querySelector(".welcome-layout-surface").getBoundingClientRect(),s=document.querySelector("[data-welcome-component=system-clock]").getBoundingClientRect();return s.top>=c.top&&s.bottom<=c.bottom&&s.left>=c.left&&s.right<=c.right})()'),true,'new component stays visible in a long layout at 125% zoom');
  assert.deepEqual(await run('[...document.querySelectorAll("[data-welcome-component]")].filter(s=>s.dataset.welcomeComponent!=="system-clock").map(s=>({id:s.dataset.welcomeComponent,left:s.style.left,top:s.style.top,width:s.style.width,height:s.style.height}))'),placementsBeforeAdd,'adding preserves all existing placements');
  await run('Object.assign(document.querySelector(".main-stage").style,{zoom:"1",width:"340px",height:"100%"});void 0'); await pause();
  const narrow = await bounds('.welcome-layout-editor'), bounded = await bounds('.welcome-layout-toolbar');
  assert.ok(bounded.x >= narrow.x && bounded.right <= narrow.right, 'moved toolbar is clamped when window narrows');
  await click('取消');
  await run('renderView(null);void 0');
  console.log('Welcome interactions passed: real 125% pointer drag/resize, scroll during capture, snap guides, Alt bypass, Escape rollback, movable/clamped toolbar, upward menu, keyboard/hover previews and read-only HTML/composer.');
};
