const assert = require('node:assert/strict');

module.exports = async ({ read, frame, win, sidebar }) => {
  const key = 'cardbush_app_center_v1', initial = await read(`localStorage.getItem('${key}')`), size = win.getSize();
  const initialWidth = await read("document.querySelector('.app').style.getPropertyValue('--sidebar-width')");
  await read(`localStorage.setItem('${key}',JSON.stringify({shortcuts:['builtin:plugins','builtin:components','builtin:automations','builtin:settings'],display:'hover',links:[]}));window.dispatchEvent(new StorageEvent('storage',{key:'${key}'}));`);
  await frame();
  const measure = () => read(`(()=>{
    const side=document.querySelector('${sidebar}'), dock=side.querySelector('.app-center-dock'), r=dock.getBoundingClientRect();
    return {top:r.top,height:r.height,gap:side.getBoundingClientRect().bottom-r.bottom,scroll:side.scrollTop,
      buttons:[...dock.querySelectorAll('button')].map(b=>{const v=b.getBoundingClientRect();return{x:v.x,y:v.y,width:v.width,height:v.height};}),
      overflow:dock.querySelector('.app-center-shortcuts').scrollWidth-dock.querySelector('.app-center-shortcuts').clientWidth};
  })()`);
  for (const [width, height, sidebarWidth] of [[1120,760,240],[760,520,192]]) {
    win.setSize(width, height);
    await read(`document.querySelector('.app').style.setProperty('--sidebar-width','${sidebarWidth}px')`); await frame();
    const baseline = await measure();
    assert.equal(baseline.height, 36, 'dock has a stable height');
    assert.equal(baseline.buttons.length, 5, 'launcher and all four shortcuts are retained');
    assert.equal(baseline.gap, 7, 'same bottom inset as the conversation sidebar');
    assert.ok(baseline.overflow <= 1, 'shortcuts fit without horizontal scrolling');
    await read(`document.querySelector('${sidebar} details').open=true`); await frame();
    assert.equal((await measure()).top, baseline.top, 'More expands above the anchored footer');
    await read(`document.querySelector('${sidebar} .app-center-shortcuts button:last-child').focus()`); await frame();
    assert.equal((await measure()).top, baseline.top, 'keyboard focus cannot scroll the footer upward');
    assert.equal((await measure()).scroll, 0);
    const p = baseline.buttons[0];
    win.webContents.sendInputEvent({type:'mouseMove',x:Math.round(p.x+p.width/2),y:Math.round(p.y+p.height/2)}); await frame();
    assert.equal((await measure()).top, baseline.top, 'hover expansion does not change the vertical position');
    await read(`document.querySelector('${sidebar} details').open=false`); await frame();
    assert.equal((await measure()).top, baseline.top);
  }
  win.setSize(...size);
  await read(`document.querySelector('.app').style.setProperty('--sidebar-width',${JSON.stringify(initialWidth)});${initial === null ? `localStorage.removeItem('${key}')` : `localStorage.setItem('${key}',${JSON.stringify(initial)})`};window.dispatchEvent(new StorageEvent('storage',{key:'${key}'}));`);
  await frame();
};
