const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ run, until, pause, window, root, guestId }) => {
  const size = window.getSize();
  await run(`
    window.dragSavedProps = { ...coverProps };
    window.dragGuidance = [];
    window.dragInput = document.querySelector('.inspector-quick-input textarea');
    coverUpdate({ draft: '拖动后保留这份草稿', sending: true, activeTurnId: 'cover-turn', guidanceAvailable: true,
      queuedMessageCount: 2, queuedMessages: [{id:'queued-one',text:'优先检查登录状态。'}, {id:'queued-two',text:'然后检查工具连接。'}],
      onGuideQueuedMessage: async (id, mode) => { dragGuidance.push({id, mode}); },
      messages: [{id:'drag-request',role:'user',content:'帮我检查网页',turnId:'cover-turn'},
        {id:'drag-assistant',role:'assistant',content:'正在检查。\\n\\n'.repeat(30),turnId:'cover-turn'},
        {id:'drag-guidance',role:'user',content:'先保留当前网页',turnId:'cover-turn',metadata:{turn_guidance:true,guidance_delivery:'queued'}}] });
  `);
  const dragTo = async (x, y, cancel = false) => {
    const from = await run(`(() => { const r=document.querySelector('.inspector-cover-drag').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`);
    window.webContents.sendInputEvent({ type:'mouseDown', button:'left', clickCount:1, ...from });
    for (let i=1;i<=6;i++) {
      window.webContents.sendInputEvent({ type:'mouseMove', x:Math.round(from.x+(x-from.x)*i/6), y:Math.round(from.y+(y-from.y)*i/6) });
      await pause(16);
    }
    assert.equal(await run('document.body.classList.contains("inspector-cover-dragging")'), true, 'drag retains capture across the native browser');
    if (cancel) window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
    window.webContents.sendInputEvent({ type:'mouseUp', button:'left', clickCount:1, x:Math.round(x), y:Math.round(y) });
    await pause(100);
    assert.equal(await run('document.body.classList.contains("inspector-cover-dragging")'), false, 'drag cursor and browser shielding are released');
  };
  const assertFits = async (label) => {
    const g = await run(`(() => {
      const panel=document.querySelector('.inspector-quick-input'),p=panel.getBoundingClientRect(),bar=document.querySelector('.inspector-cover-capsule').getBoundingClientRect();
      const pane=document.querySelector('.right-inspector').getBoundingClientRect(),s=panel.querySelector('.send-button'),b=s.getBoundingClientRect();
      return {p:p.toJSON(),bar:bar.toJSON(),pane:pane.toJSON(),direction:panel.parentElement.dataset.expands,
        hit:s.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2)),sameInput:dragInput===panel.querySelector('textarea'),value:panel.querySelector('textarea').value};
    })()`);
    assert.ok(g.p.left >= g.pane.left && g.p.right <= g.pane.right+1 && g.p.top >= g.pane.top && g.p.bottom <= g.pane.bottom+1, label+': panel fits the browser pane '+JSON.stringify(g));
    assert.ok(g.bar.left >= g.pane.left && g.bar.right <= g.pane.right+1 && g.bar.top >= g.pane.top && g.bar.bottom <= g.pane.bottom+1, label+': capsule remains reachable');
    assert.ok(g.direction === 'above' ? g.p.bottom <= g.bar.top-9 : g.p.top >= g.bar.bottom+9, label+': preview opens away from the edge');
    assert.ok(g.hit && g.sameInput, label+': the original composer stays mounted and usable');
    assert.equal(g.value, '拖动后保留这份草稿');
    assert.equal(await run('document.querySelector(".right-inspector-tab-page.active webview").getWebContentsId()'), guestId, 'dragging never reloads the browser');
  };
  try {
    await until('document.querySelectorAll(".inspector-quick-input .runtime-queue-item").length===2', 'all guidance stays visible even though the toolbar is hidden');
    await until('document.querySelector(".quick-input-transcript .guidance-activity")?.textContent.includes("等待当前步骤完成")', 'queued guidance delivery is rendered in the preview');
    await run(`document.querySelector('.inspector-quick-input .runtime-queue-guide').click()`);
    await until('dragGuidance.length===1', 'quick input can send queued guidance');
    assert.deepEqual(await run('dragGuidance'), [{id:'queued-one',mode:'interrupt_and_continue'}]);
    assert.deepEqual(await run(`Array.from(document.querySelector('.inspector-cover-capsule').children,button=>button.className)`),
      ['inspector-cover-back','inspector-cover-drag','inspector-cover-input-toggle'], 'drag handle is between Back and Input');
    await pause(100);
    const viewport = await run('({width:innerWidth,height:innerHeight,top:document.querySelector(".desktop-shell").getBoundingClientRect().top})');
    for (const [label,x,y] of [['top-left',20,viewport.top+20],['top-right',viewport.width-20,viewport.top+20],
      ['bottom-right',viewport.width-20,viewport.height-20],['bottom-left',20,viewport.height-20]]) {
      await dragTo(x,y);
      await assertFits(label);
      if (label==='top-left') fs.writeFileSync(path.join(root,'tmp','quick-input-drag-top.png'),(await window.capturePage()).toPNG());
    }
    const savedPosition = await run('localStorage.getItem("cardbush.inspector_cover_position")');
    await dragTo(viewport.width/2,viewport.top+30,true);
    assert.equal(await run('localStorage.getItem("cardbush.inspector_cover_position")'), savedPosition, 'Escape cancels the drag without closing the input');
    await assertFits('cancelled drag');
    await run(`document.querySelector('.inspector-cover-input-toggle').click();`);
    await until('!document.querySelector(".inspector-quick-input")', 'close moved input');
    await run(`document.querySelector('.inspector-cover-input-toggle').click();`);
    await until('!!document.querySelector(".inspector-quick-input textarea")', 'reopen moved input');
    assert.equal(await run('localStorage.getItem("cardbush.inspector_cover_position")'), savedPosition);
    await run('dragInput=document.querySelector(".inspector-quick-input textarea"); document.querySelector(".quick-input-status").click();');
    window.setSize(600,520); window.webContents.setZoomFactor(1.25); await pause(220);
    await assertFits('small window at 125% zoom');
    fs.writeFileSync(path.join(root,'tmp','quick-input-drag-small.png'),(await window.capturePage()).toPNG());
    window.webContents.setZoomFactor(1); window.setSize(...size); await pause(180);
    await run(`(() => {
      const input=document.querySelector('.inspector-quick-input textarea');input.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'/');
      input.setSelectionRange(1,1);input.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await until('!!document.querySelector(".composer-command-portal")', 'slash commands open while floating');
    const popupBefore = await run('document.querySelector(".composer-command-portal").getBoundingClientRect().top');
    await dragTo(viewport.width-30,viewport.top+25);
    assert.equal(await run('!!document.querySelector(".composer-command-portal")'), false, 'drag dismisses the command menu instead of leaving it behind');
    assert.equal(await run('document.querySelector(".inspector-quick-input textarea").value'), '/', 'dismissing commands preserves the draft');
    for (const value of ['', '/']) await run(`(() => {
      const input=document.querySelector('.inspector-quick-input textarea');input.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(value)});
      input.setSelectionRange(${value.length},${value.length});input.dispatchEvent(new Event('input',{bubbles:true}));
    })()`);
    await until('!!document.querySelector(".composer-command-portal")', 'commands reopen at the new input position');
    const popup = await run(`(() => {const p=document.querySelector('.composer-command-portal').getBoundingClientRect();return {top:p.top,bottom:p.bottom,left:p.left,right:p.right};})()`);
    assert.ok(Math.abs(popup.top-popupBefore)>40 && popup.top>=0 && popup.bottom<=viewport.height && popup.right<=viewport.width, 'command menu uses the new input position and fits the window');
    console.log('Quick input drag passed: all edges, opposite-side expansion, narrow/zoomed layout, native browser and draft preservation, cancel, saved position and guidance sending.');
  } finally {
    window.webContents.setZoomFactor(1); window.setSize(...size);
    await run(`document.querySelector('.inspector-cover-drag')?.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}));coverUpdate(dragSavedProps);`);
    await pause(200);
  }
};
