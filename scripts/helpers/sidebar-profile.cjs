const assert = require('node:assert/strict');

module.exports = async ({ read, frame, win, sidebar }) => {
  const size = win.getSize(), initialWidth = await read("document.querySelector('.app').style.getPropertyValue('--sidebar-width')");
  const measure = () => read(`(()=>{const side=document.querySelector('${sidebar}'),trigger=side.querySelector('.profile-trigger'),r=trigger.getBoundingClientRect();
    return {top:r.top,height:r.height,gap:side.getBoundingClientRect().bottom-r.bottom,scroll:side.scrollTop,
      point:{x:r.x,y:r.y,width:r.width,height:r.height},overflow:trigger.scrollWidth-trigger.clientWidth};})()`);
  for (const [width, height, sidebarWidth] of [[1120,760,240],[760,520,192]]) {
    win.setSize(width, height);
    await read(`document.querySelector('.app').style.setProperty('--sidebar-width','${sidebarWidth}px')`); await frame();
    const baseline = await measure();
    assert.ok(baseline.height >= 34, 'profile control has a usable hit target');
    assert.equal(await read(`!!document.querySelector('${sidebar} .app-center-dock')`),false,'profile replaces the sidebar dock');
    assert.equal(baseline.gap, 7, 'same bottom inset as the conversation sidebar');
    assert.ok(baseline.overflow <= 1, 'the profile fits without horizontal scrolling');
    await read(`document.querySelector('${sidebar} details').open=true`); await frame();
    assert.equal((await measure()).top, baseline.top, 'More expands above the anchored footer');
    await read(`document.querySelector('${sidebar} .profile-trigger').focus()`); await frame();
    assert.equal((await measure()).top, baseline.top, 'keyboard focus cannot scroll the footer upward');
    assert.equal((await measure()).scroll, 0);
    const p = baseline.point;
    win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(p.x+p.width/2),y:Math.round(p.y+p.height/2)}); await frame();
    assert.equal((await measure()).top, baseline.top, 'hover does not change the vertical position');
    await read(`document.querySelector('${sidebar} details').open=false`); await frame();
    assert.equal((await measure()).top, baseline.top);
  }
  win.setSize(...size);
  await read(`document.querySelector('.app').style.setProperty('--sidebar-width',${JSON.stringify(initialWidth)});`);
  await frame();
};
