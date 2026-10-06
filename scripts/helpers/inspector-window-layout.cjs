const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({run,until,pause,window,root}) => {
  const originalBounds=window.getBounds();
  const guestId=await run('document.querySelector("webview").getWebContentsId()');
  const guest=require('electron').webContents.fromId(guestId);
  await guest.executeJavaScript('window.layoutDraft="unsent browser state"');
  const readable=()=>until('!coverWorkspace.conversationCovered && document.querySelector(".main-stage").clientWidth>=340','readable conversation in the split');
  const layout=()=>run(`(()=>{const chat=document.querySelector('.main-stage').getBoundingClientRect(),browser=document.querySelector('.right-inspector').getBoundingClientRect();return {
    chat:chat.width,browser:browser.width,boundary:chat.right,minimum:getComputedStyle(document.querySelector('.desktop-shell')).getPropertyValue('--conversation-pane-min-width').trim(),
    preferred:localStorage.getItem('cardbush.inspector_width')};})()`);
  try {
    window.setBounds({x:0,y:0,width:1920,height:1000});
    await run('coverWorkspace.setWindowMaximized(true);coverWorkspace.setSidebarCollapsed(false)');await pause(350);
    await run('coverWorkspace.setInspectorWidth(720)');await readable();await pause(300);
    const maximized=await layout();
    assert.equal(maximized.browser,720);
    assert.equal(maximized.minimum,'340px');
    fs.writeFileSync(path.join(root,'tmp','inspector-window-maximized.png'),(await window.webContents.capturePage()).toPNG());

    // Restore changes both the origin and width, unlike dragging the right edge.
    window.setBounds({x:100,y:60,width:1180,height:800});
    await run('coverWorkspace.setWindowMaximized(false)');await readable();await pause(350);
    const restored=await layout();
    assert.ok(restored.browser>=380 && restored.browser<720);
    assert.equal(restored.preferred,'720','automatic fitting does not overwrite the chosen width');
    assert.equal(restored.minimum,maximized.minimum,'window modes share the same split policy');
    fs.writeFileSync(path.join(root,'tmp','inspector-window-restored.png'),(await window.webContents.capturePage()).toPNG());

    // Compare resizing from the left and right to the same available width.
    for(const x of [0,360]) {
      window.setBounds({x,y:60,width:1440,height:800});await readable();await pause(300);
      assert.equal((await layout()).browser,720,'larger viewport restores the preferred width');
      window.setBounds({x:100,y:60,width:1180,height:800});await readable();await pause(300);
      assert.equal((await layout()).browser,restored.browser,'either edge produces the same layout');
    }
    await run('coverWorkspace.setSidebarCollapsed(true)');await readable();
    await until('document.querySelector(".right-inspector").getBoundingClientRect().width===720','sidebar and inspector width animations settle');
    assert.equal((await layout()).browser,720,'hiding the left sidebar restores available space');
    await run('coverWorkspace.setSidebarCollapsed(false)');await readable();
    await until(`document.querySelector('.right-inspector').getBoundingClientRect().width===${restored.browser}`,'reopened sidebar and inspector width animations settle');
    assert.equal((await layout()).browser,restored.browser,'opening the sidebar does not hide the conversation');

    window.setBounds({x:0,y:0,width:1440,height:900});window.webContents.setZoomFactor(1.25);
    await readable();await pause(350);
    assert.equal((await layout()).preferred,'720');
    window.webContents.setZoomFactor(1);await readable();await pause(350);

    // The remaining divider is genuinely draggable in an ordinary split.
    const point=await run(`(()=>{const r=document.querySelector('.right-inspector-resizer').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.top+100)};})()`);
    window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
    window.webContents.sendInputEvent({type:'mouseMove',button:'left',x:point.x+100,y:point.y});
    window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:point.x+100,y:point.y});
    await until('coverWorkspace.inspectorWidth===620','divider updates the actual split');await readable();

    // Crossing the collapsed-chat threshold must not cancel a drag in flight.
    await pause(300);
    const expand=await run(`(()=>{const r=document.querySelector('.right-inspector-resizer').getBoundingClientRect(),s=document.querySelector('.sidebar').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.top+100),edge:Math.round(s.right+180)};})()`);
    window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:expand.x,y:expand.y});
    window.webContents.sendInputEvent({type:'mouseMove',button:'left',x:expand.edge,y:expand.y});
    await until('coverWorkspace.conversationCovered','live drag reaches collapsed chat');
    assert.equal(await run('document.body.classList.contains("right-inspector-resizing")'),true,'drag capture survives the intermediate layout');
    window.webContents.sendInputEvent({type:'mouseMove',button:'left',x:4,y:expand.y});
    window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:4,y:expand.y});
    await until('coverWorkspace.inspectorCover','continuing the same drag enters full cover');
    await run('document.querySelector("#cover-back").click()');await readable();await pause(300);

    await run('coverWorkspace.setInspectorWidth(innerWidth)');
    await until('coverWorkspace.conversationCovered','explicit pane expansion hides chat');
    for(const width of [1180,1920]) {
      window.setBounds({x:0,y:0,width,height:800});await pause(350);
      assert.equal(await run('coverWorkspace.conversationCovered'),true,'an explicit collapsed conversation stays collapsed across window sizes');
      assert.equal(await run('getComputedStyle(document.querySelector(".right-inspector-resizer")).display'),'none','no dead second divider');
      assert.equal(await run('getComputedStyle(document.querySelector(".right-inspector")).borderLeftWidth'),'0px');
    }
    await run('document.querySelector("#cover-back").click()');await readable();await pause(300);
    assert.notEqual(await run('getComputedStyle(document.querySelector(".right-inspector-resizer")).display'),'none','Back restores the real divider');
    assert.equal(await run('document.querySelector("webview").getWebContentsId()'),guestId,'window transitions preserve the same browser');
    assert.equal(await guest.executeJavaScript('window.layoutDraft'),'unsent browser state');
    assert.equal(await run('document.querySelector("textarea[data-composer-input]").value'),'keep draft','chat draft also survives');
    console.log('Inspector window layout passed: restore/maximize sizes, both window edges, sidebar toggles, 125% zoom, draggable split, intentional cover and no duplicate boundary.');
  } finally {
    window.webContents.setZoomFactor(1);window.setBounds(originalBounds);
    await run('coverWorkspace.setWindowMaximized(false);coverWorkspace.setInspectorWidth(500,true)');await pause(300);
  }
};
