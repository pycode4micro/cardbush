const assert = require('node:assert/strict');

// Exercise the actual React boundaries and native guests, including the frames
// between pointer-down and pointer-up (where a completed-drag test misses jumps).
module.exports = async ({ window, read, waitFor, until, pause, original, guestIds }) => {
  const originalSize=window.getSize();
  window.setSize(1500,760); await pause(300);
  const geometry = () => read(`(()=>{
    const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,width:r.width,height:r.height};};
    return {shell:rect('.desktop-shell'),main:rect('.main-stage'),panel:rect('.right-inspector'),
      content:rect('.right-inspector-content'),draft:rect('#conversation-draft'),handle:rect('.right-inspector-resizer')};
  })()`);
  const pointer = (type,x,y) => {
    const zoom=window.webContents.getZoomFactor();
    window.webContents.sendInputEvent({type,button:'left',clickCount:1,x:Math.round(x*zoom),y:Math.round(y*zoom)});
  };
  const start = async () => {
    const before=await geometry(),x=before.handle.left+before.handle.width/2,y=before.handle.top+100;
    pointer('mouseDown',x,y);
    await waitFor('document.body.classList.contains("right-inspector-resizing")');
    const pressed=await geometry();
    assert.ok(Math.abs(pressed.main.width-before.main.width)<2,'pressing boundary must not expand the conversation behind the inspector');
    return {before,x,y,offset:x-before.panel.left};
  };
  const assertDock = async (x,offset=0) => {
    const g=await geometry();
    assert.ok(Math.abs(g.panel.left-(x-offset))<2,`boundary follows pointer: ${JSON.stringify({x,offset,g})}`);
    assert.ok(Math.abs(g.main.right-g.panel.left)<2,'conversation and inspector share one boundary');
    assert.ok(g.draft.right<=g.main.right+1,'conversation input stays within its visible column');
    assert.ok(Math.abs(g.panel.width-g.content.width)<3,'inner inspector width follows its visible frame');
    return g;
  };
  for (const [cssZoom,rendererZoom] of [[1,1],[1.25,1],[1,1.25]]) {
    window.webContents.setZoomFactor(rendererZoom);
    await read(`document.querySelector('.app').style.zoom='${cssZoom}';browserFixture.setWidth(620);void 0`);
    await pause(300);
    const drag=await start();
    for (const x of [drag.x-100,drag.x-210,drag.x-80]) {
      pointer('mouseMove',x,drag.y); await pause(50); await assertDock(x,drag.offset);
    }
    // Release at a new location without a preceding move event.
    const x=drag.x-130;
    pointer('mouseUp',x,drag.y); await pause(300); await assertDock(x,drag.offset);
    assert.equal(await read('document.body.classList.contains("right-inspector-resizing")'),false);
    const cancel=await start();
    pointer('mouseMove',cancel.x+70,cancel.y); await pause(50);
    await read('window.dispatchEvent(new Event("blur"));void 0');
    pointer('mouseUp',cancel.x+70,cancel.y); await pause(300);
    await assertDock(cancel.x,cancel.offset);
    for (const axis of ['x','y']) {
      await read(`browserFixture.setLayout({...browserFixture.layout,axis:'${axis}',ratio:.5});void 0`); await pause(180);
      const divider=()=>read(`(()=>{const d=document.querySelector('.inspector-tile-divider').getBoundingClientRect(),p=document.querySelector('.right-inspector-tab-pages').getBoundingClientRect();return {x:d.x+d.width/2,y:d.y+d.height/2,start:${axis==='x'?'p.left':'p.top'},size:${axis==='x'?'p.width':'p.height'},ratio:browserFixture.layout.ratio};})()`);
      const initial=await divider(), offset=2;
      const x=initial.x+(axis==='x'?offset:0),y=initial.y+(axis==='y'?offset:0);
      pointer('mouseDown',x,y);
      await waitFor('document.body.classList.contains("inspector-layout-resizing")');
      pointer('mouseMove',x+(axis==='x'?45:0),y+(axis==='y'?45:0)); await pause(40);
      assert.ok(Math.abs((await divider()).ratio-(.5+45/initial.size))<.006,'inner divider retains pointer grab offset');
      pointer('mouseUp',x+(axis==='x'?65:0),y+(axis==='y'?65:0)); await pause(160);
      const released=await divider();
      assert.ok(Math.abs(released.ratio-(.5+65/initial.size))<.006,'inner divider uses final release coordinate');
      pointer('mouseDown',released.x,released.y);
      await waitFor('document.body.classList.contains("inspector-layout-resizing")');
      pointer('mouseMove',released.x-(axis==='x'?35:0),released.y-(axis==='y'?35:0)); await pause(40);
      await read('window.dispatchEvent(new Event("blur"));void 0');
      pointer('mouseUp',released.x,released.y); await pause(160);
      assert.ok(Math.abs((await divider()).ratio-released.ratio)<.001,'blur restores the prior split ratio');
      assert.equal(await read('document.body.classList.contains("inspector-layout-resizing")'),false,'cancel restores browser interaction');
    }
    await read("browserFixture.setLayout({...browserFixture.layout,axis:'x',ratio:.5});void 0"); await pause(160);
  }
  window.webContents.setZoomFactor(1);
  await read("document.querySelector('.app').style.zoom='';browserFixture.setWidth(820);void 0");
  await pause(300);
  const drag=await start();
  pointer('mouseMove',100,drag.y); await pause(50); await assertDock(100,drag.offset);
  pointer('mouseUp',100,drag.y); await pause(300); await assertDock(100,drag.offset);
  // Cover and return use the same mounted guests and saved docked geometry.
  const cover=await start();
  pointer('mouseMove',4,cover.y); pointer('mouseUp',4,cover.y);
  await waitFor('!!document.querySelector(".inspector-covered")');
  await read('browserFixture.setCovered(false);void 0'); await pause(300); await assertDock(100,drag.offset);
  await read('browserFixture.setWidth(820);void 0'); await pause(300);
  const guestWidth=await read('document.querySelector("webview").clientWidth');
  await until(async()=>Math.abs(await original.executeJavaScript('innerWidth')-guestWidth)<3,'guest viewport matches settled frame');
  assert.deepEqual(await read('[...document.querySelectorAll("webview")].map(view=>view.getWebContentsId())'),guestIds,'resizing preserves browser guests');
  assert.equal(await read('document.querySelector("#conversation-draft").value'),'Keep this draft');
  require('node:fs').writeFileSync(require('node:path').resolve('tmp/inspector-resize-docked.png'),(await window.webContents.capturePage()).toPNG());
  window.setSize(...originalSize); await pause(300);
  console.log('Inspector resize: continuous dock, row/column dividers, pointer release/cancel, 125% CSS/renderer zoom, near-left position and cover restoration passed.');
};
