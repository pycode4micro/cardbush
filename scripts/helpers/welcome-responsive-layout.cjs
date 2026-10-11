const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root }) => {
  const close = (a, b, label, tolerance = 2) => assert.ok(Math.abs(a - b) < tolerance, `${label}: ${a} vs ${b}`);
  await window.webContents.insertCSS(fs.readFileSync(path.join(root, 'src/features/automations/calendarSurface.css'), 'utf8'));
  window.setContentSize(1000, 760);
  await run(`startFlow('keep','above','responsive-welcome');updateChat({language:'zh'});`);
  await until('!!document.querySelector(".welcome-layout-surface")', 'responsive welcome'); await pause();
  await run(`(()=>{
    const state=JSON.parse(localStorage.getItem(views.componentStorageKey)), height=document.querySelector('.welcome-layout-surface').clientHeight;
    // A real legacy layout: migration must adopt this size without moving it.
    views.saveComponents({...state,welcomeLayout:{items:[
      {componentId:'system-calendar',x:10,y:height*.18,width:36,height:height*.42},
      {componentId:'system-digital-clock',x:54,y:height*.18,width:36,height:height*.42},
      {componentId:'system-input',x:10,y:height*.8,width:80,height:52,inputStyle:'simple',composerFlow:{afterSend:'keep',output:'above'}}
    ]}},state.revision);
    window.welcomeMetrics=()=>{
      const pane=document.querySelector('.welcome-layout-surface'), box=pane.getBoundingClientRect();
      return {height:pane.clientHeight, width:pane.clientWidth, items:[...pane.querySelectorAll('[data-welcome-component]')].map(item=>{
        const r=item.getBoundingClientRect();return {id:item.dataset.welcomeComponent,x:(r.left-box.left)/box.width,y:(r.top-box.top)/box.height,
          width:r.width/box.width,height:r.height/box.height,top:r.top-box.top};})};
    };
  })()`);
  await until('!!JSON.parse(localStorage.getItem(views.componentStorageKey)).welcomeLayout.viewportHeight', 'legacy reference saved'); await pause();
  const baseline = await run('welcomeMetrics()');
  close(baseline.items[0].y, .18, 'legacy calendar does not jump', .003);
  close(baseline.items[2].y, .8, 'legacy input does not jump', .003);
  const stored = await run('localStorage.getItem(views.componentStorageKey)');
  const verify = async (label, expected = baseline) => {
    const current = await run('welcomeMetrics()');
    for (let index = 0; index < expected.items.length; index++) {
      for (const key of ['x', 'y', 'width', ...(index < 2 ? ['height'] : [])]) {
        close(current.items[index][key], expected.items[index][key], `${label} ${expected.items[index].id} ${key}`, .003);
      }
    }
    const input = await run(`(()=>{const r=document.querySelector('.welcome-slot-input .composer-stack').getBoundingClientRect(),
      slot=document.querySelector('.welcome-slot-input').getBoundingClientRect();return {left:r.left,width:r.width,slotLeft:slot.left,slotWidth:slot.width};})()`);
    close(input.left,input.slotLeft,`${label} actual input left`);
    close(input.width,input.slotWidth,`${label} actual input width`);
    return current;
  };
  window.setContentSize(1540, 1020); await pause();
  await verify('maximized');
  fs.writeFileSync(path.join(root, 'tmp', 'welcome-layout-maximized.png'), (await window.webContents.capturePage()).toPNG());
  await run('document.querySelector(".chat-panel").style.maxWidth="760px"'); await pause();
  await verify('right pane opens');
  // CSS zoom represents mixed-DPI/app scaling; comparisons use actual client rects.
  await run('document.querySelector(".app").style.zoom="1.25"'); await pause();
  await verify('125% scale');
  await run('document.querySelector(".app").style.zoom="";document.querySelector(".chat-panel").style.maxWidth=""');
  window.setContentSize(1000, 760); await pause();
  await verify('restored');
  assert.equal(await run('localStorage.getItem(views.componentStorageKey)'), stored, 'resizing never rewrites the saved geometry');
  fs.writeFileSync(path.join(root, 'tmp', 'welcome-layout-restored.png'), (await window.webContents.capturePage()).toPNG());

  // Splitting the pane must not squeeze the monthly calendar into a tiny
  // percentage-sized box or apply generic component-button padding to dates.
  for (const [width, zoom] of [[375, 1], [300, 1.25]]) {
    await run(`document.querySelector('.chat-panel').style.maxWidth='${width}px';document.querySelector('.app').style.zoom='${zoom}'`);
    await until('document.querySelector(".welcome-layout-surface").dataset.compactWidgets==="true"', 'compact widgets'); await pause();
    const compact = await run(`(()=>{
      const surface=document.querySelector('.welcome-layout-surface'),calendar=surface.querySelector('.builtin-calendar'),
        clock=surface.querySelector('.builtin-clock'),widgets=surface.querySelector('.welcome-layout-widgets'),
        input=surface.querySelector('.welcome-slot-input'),box=calendar.getBoundingClientRect();
      return {width:calendar.clientWidth, horizontal:calendar.scrollWidth-calendar.clientWidth, vertical:calendar.scrollHeight-calendar.clientHeight,
        clockAbove:clock.getBoundingClientRect().bottom<=box.top, avoidsInput:widgets.getBoundingClientRect().bottom<input.getBoundingClientRect().top,
        dayPadding:getComputedStyle(calendar.querySelector('.calendar-day-button')).padding,
        visibleControls:[...calendar.querySelectorAll('.calendar-month-heading button')].every(b=>{const r=b.getBoundingClientRect();return r.left>=box.left&&r.right<=box.right;}),
        scrollWidth:widgets.scrollWidth-widgets.clientWidth};
    })()`);
    assert.ok(compact.width >= 240, 'calendar retains a readable width');
    assert.ok(compact.horizontal <= 1 && compact.vertical <= 1 && compact.scrollWidth <= 1, JSON.stringify(compact));
    assert.ok(compact.clockAbove && compact.avoidsInput && compact.visibleControls, JSON.stringify(compact));
    assert.equal(compact.dayPadding, '0px', 'date buttons do not inherit component-toolbar padding');
    assert.equal(await run('localStorage.getItem(views.componentStorageKey)'), stored, 'narrow presentation does not overwrite the saved layout');
    if (width === 375) fs.writeFileSync(path.join(root, 'tmp', 'welcome-layout-narrow.png'), (await window.webContents.capturePage()).toPNG());
  }
  await run('document.querySelector(".app").style.zoom="";document.querySelector(".chat-panel").style.maxWidth=""'); await pause();
  await verify('restored after compact widgets');
  assert.equal(await run('document.querySelector(".welcome-layout-surface").dataset.compactWidgets'), 'false');

  // Keep-mode uses the same reference after sending and after returning to the chat.
  window.setContentSize(1540, 1020); await pause();
  const before = await run('layoutRect(".welcome-composer .composer-stack")');
  await run('document.querySelector(".send-button").click()');
  await until('!!document.querySelector(".composer-dock .composer-stack")', 'responsive send'); await pause();
  close((await run('layoutRect(".composer-dock .composer-stack")')).top, before.top, 'send keeps the visible input');
  window.setContentSize(1000, 760); await pause();
  close((await run('layoutRect(".composer-dock .composer-stack")')).top, baseline.items[2].top, 'sent input restores to the same position');
  await run('renderView(null);updateChat({})'); await pause();
  close((await run('layoutRect(".composer-dock .composer-stack")')).top, baseline.items[2].top, 'remount preserves responsive anchor');

  // Saving from a different size captures the visible geometry, not stale pixels.
  window.setContentSize(1540, 1020);
  await run('openCenteredEditor()');
  const click = text => run(`[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`);
  await until('!!document.querySelector(".components-app")', 'responsive library'); await click('编辑布局');
  await until('!!document.querySelector(".welcome-layout-editor")', 'responsive editor'); await pause();
  const edited = await verify('editor at maximum');
  await click('保存'); await until('!!document.querySelector(".components-app")', 'responsive saved');
  close(await run('JSON.parse(localStorage.getItem(views.componentStorageKey)).welcomeLayout.viewportHeight'), edited.height, 'save records current canvas');
  await click('编辑布局'); await until('!!document.querySelector(".welcome-layout-editor")', 'responsive editor reopened'); await pause();
  await verify('saved and reopened');
  window.setContentSize(1000, 760); await pause();
  await verify('editor restored after save');
  await click('取消');
  await run('renderView(null);localStorage.removeItem(views.componentStorageKey)');
  console.log('Responsive welcome passed: legacy migration, maximize/restore, pane resizing, 125% scaling, saved/reopened layout and post-send input position.');
};
