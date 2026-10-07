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

    const taller = {...window.getBounds(),height:820};
    window.emit('will-resize', {preventDefault(){}}, taller, {edge:'bottom-right'});
    window.setBounds(taller);window.emit('resized');await pause(120);
    assert.equal((await layout()).preferred,'720','height-only corner resizing must not save a temporarily clamped width');

    // Programmatic viewport changes have no native drag intent, even if the
    // window origin changes. They must retain the ordinary fitting behavior.
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

    // Supply native edge intent, then resize the real isolated BrowserWindow.
    // CSS pixel deltas must stay correct at non-default renderer zoom too.
    for (const [zoom, edge] of [[1, 'right'], [1.25, 'bottom-right']]) {
      window.webContents.setZoomFactor(zoom);
      window.setBounds({x:100,y:60,width:1440,height:900});
      await run('coverWorkspace.setInspectorWidth(500,true)');await readable();await pause(300);
      const before = await layout(), bounds = window.getBounds(), viewport = window.getContentBounds().width;
      for (const delta of [200, 280]) {
        const next = {...bounds,width:bounds.width+delta};
        window.emit('will-resize', {preventDefault(){}}, next, {edge});
        await until('document.querySelector(".desktop-shell").classList.contains("inspector-window-resizing")','native right edge starts pane resizing');
        window.setBounds(next);
        const expected = Math.round(before.browser+(window.getContentBounds().width-viewport)/zoom);
        await until(`Math.abs(document.querySelector('.right-inspector').getBoundingClientRect().width-${expected})<2`,'right pane follows the outer edge');
        const after = await layout();
        assert.ok(Math.abs(after.chat-before.chat)<2,'right edge preserves conversation width');
        assert.ok(Math.abs(after.boundary-before.boundary)<2,'right edge keeps the inner divider stationary');
        assert.equal(await run('getComputedStyle(document.querySelector(".right-inspector")).transitionDuration'),'0s','pane tracks a native resize without animation lag');
      }
      window.emit('resized');
      await until('!document.querySelector(".desktop-shell").classList.contains("inspector-window-resizing")','native gesture ends');
      const resized = await layout();
      assert.equal(resized.preferred,String(Math.round(resized.browser)),'manual right-edge width is remembered');
      const left = {...window.getBounds(),x:20,width:window.getBounds().width+80};
      window.emit('will-resize', {preventDefault(){}}, left, {edge:'left'});
      window.setBounds(left);window.emit('resized');await pause(300);
      assert.ok(Math.abs((await layout()).browser-resized.browser)<2,'left edge leaves the right pane width intact');
      assert.ok((await layout()).chat>resized.chat+50,'left edge allocates space to the conversation');
      window.setPosition(60,80);await pause(100);
      assert.equal((await layout()).preferred,resized.preferred,'moving a window cannot resize its inspector');
    }
    window.webContents.setZoomFactor(1);
    window.setBounds({x:0,y:0,width:1440,height:900});
    await run('coverWorkspace.setInspectorWidth(720,true)');await readable();await pause(300);

    const narrow = {...window.getBounds(),width:1020};
    window.emit('will-resize', {preventDefault(){}}, narrow, {edge:'top-right'});
    await until('document.querySelector(".desktop-shell").classList.contains("inspector-window-resizing")','right corner starts resizing');
    window.setBounds(narrow);
    await until('coverWorkspace.inspectorWidth===380','inward drag respects the right pane minimum');
    window.emit('resized');await readable();await pause(100);
    assert.equal((await layout()).preferred,'380','minimum-sized pane can be restored predictably');

    window.setBounds({x:0,y:0,width:1440,height:900});
    await run('coverWorkspace.setInspectorWidth(720,true)');await readable();await pause(300);
    window.emit('will-resize', {preventDefault(){}}, {...window.getBounds(),width:1540}, {edge:'right'});
    await until('document.querySelector(".desktop-shell").classList.contains("inspector-window-resizing")','interrupted resize starts');
    window.setSize(1540,900);
    await until('coverWorkspace.inspectorWidth===820','interrupted resize has a preview');
    window.emit('maximize');
    await until('!document.querySelector(".desktop-shell").classList.contains("inspector-window-resizing") && coverWorkspace.inspectorWidth===720','window mode change cancels native resizing');
    assert.equal((await layout()).preferred,'720','maximize cannot save its delta as a manual pane width');
    window.setSize(1440,900);await readable();await pause(300);

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
    console.log('Inspector window layout passed: native right-edge allocation, left-edge/move isolation, restore/maximize sizes, sidebar toggles, 125% zoom, draggable split, intentional cover and no duplicate boundary.');
  } finally {
    window.webContents.setZoomFactor(1);window.setBounds(originalBounds);
    await run('coverWorkspace.setWindowMaximized(false);coverWorkspace.setInspectorWidth(500,true)');await pause(300);
  }
};
