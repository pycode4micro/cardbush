const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { writeFileSync } = require('node:fs');
const { app, BrowserWindow } = require('electron');
const directory = resolve(process.argv[2]);
app.disableHardwareAcceleration();
app.setPath('userData', join(directory, 'profile'));
const deadline = setTimeout(() => { console.error('Inspector navigation timed out'); app.exit(1); }, 40_000);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, width: 1140, height: 820,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: true, backgroundThrottling: false, offscreen: true } });
  const errors = [];
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  window.webContents.session.webRequest.onBeforeRequest((details, done) => {
    const external = /^https?:/.test(details.url);
    if (external) errors.push('Unexpected network: '+details.url);
    done({cancel:external});
  });
  const read = script => window.webContents.executeJavaScript(script);
  const until = async script => {
    const end = Date.now()+5000;
    while (!(await read(script))) {
      if (Date.now()>end) throw new Error('Timed out: '+script+'; '+await read('document.body.innerText.slice(0,1000)'));
      await pause(30);
    }
  };
  const click = async selector => {
    const point = await read('(()=>{const node=document.querySelector('+JSON.stringify(selector)+'); if(!node)throw Error("Missing target"); const r=node.getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()');
    window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...point});
    window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...point});
    await pause(70);
  };
  const select = async id => {
    await read('navigation.activateTab('+JSON.stringify(id)+'); void 0');
    await until('document.querySelector(".right-inspector-tab-page.active")?.dataset.inspectorPageId==='+JSON.stringify(id));
    assert.equal(await read('document.querySelectorAll(".right-inspector-tab-page.active").length'),1);
    assert.equal(await read('Array.from(document.querySelectorAll(".right-inspector-tab-page:not(.active)")).every(page=>page.inert)'),true);
  };
  try {
    await window.loadFile(join(directory,'index.html'));
    await until('Boolean(window.navigation)');
    await click('#add');
    await click('[data-inspector-action="history"]');
    await until('document.querySelectorAll(".work-summary-inspector-turn").length===9');
    assert.equal(await read('document.querySelectorAll("[role=tab]").length'),1,'history participates in the tab strip');
    await read('document.getElementById("conversation-scroll").scrollTop=300; void 0');
    for (const theme of ['dark','bright','parchment']) {
      await read('document.querySelector(".app").className='+JSON.stringify('app theme-'+theme)+'; void 0');
      await click('.work-summary-turn-selector > button');
      await until('Boolean(document.querySelector(".work-summary-turn-selector-menu"))');
      const geometry=await read('(()=>{const m=document.querySelector(".work-summary-turn-selector-menu"),b=m.querySelector("button"),r=b.getBoundingClientRect(),bg=getComputedStyle(m).backgroundColor;return {bg,hit:b.contains(document.elementFromPoint(r.x+10,r.y+10)),right:m.getBoundingClientRect().right,edge:document.querySelector(".right-inspector").getBoundingClientRect().right};})()');
      assert.notEqual(geometry.bg,'rgba(0, 0, 0, 0)','menu must have an opaque theme background');
      assert.ok(!geometry.bg.startsWith('rgba(')||geometry.bg.endsWith(', 1)'),geometry.bg);
      assert.equal(geometry.hit,true,'menu receives the click above history content');
      assert.ok(geometry.right<=geometry.edge);
      // Outside can be scrolled out of view; use a visible point in the conversation.
      window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:100,y:100});
      window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:100,y:100});
      await until('!document.querySelector(".work-summary-turn-selector-menu")');
    }
    await read('document.querySelector(".app").className="app theme-dark"; void 0');
    await click('.work-summary-turn-selector > button');
    await read('document.querySelectorAll(".work-summary-turn-selector-menu button")[3].click(); void 0');
    await until('document.querySelector(".work-summary-turn-inspector").scrollTop>200');
    await pause(500);
    assert.equal(await read('document.getElementById("conversation-scroll").scrollTop'),300,'turn selection must not scroll the conversation');
    assert.equal(await read('document.documentElement.scrollTop'),0);
    assert.equal(await read('Boolean(document.querySelector(".work-summary-turn-selector-menu"))'),false);
    await read('window.historyNode=document.querySelector(".work-summary-turn-inspector"); window.historyPosition=historyNode.scrollTop; void 0');
    await click('.work-summary-turn-selector > button');
    await until('Boolean(document.querySelector(".work-summary-turn-selector-menu"))');
    await pause(150);
    writeFileSync(resolve('tmp/inspector-history-menu.png'),(await window.webContents.capturePage()).toPNG());
    await read('document.querySelector(".work-summary-turn-selector-menu button").focus({preventScroll:true}); void 0');
    window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
    window.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    await until('!document.querySelector(".work-summary-turn-selector-menu")');
    assert.equal(await read('document.activeElement===document.querySelector(".work-summary-turn-selector > button")'),true);

    await click('#add'); await click('[data-inspector-action="files"]');
    await until('document.querySelector(".markdown-inspector-preview")?.textContent.includes("预览内容")');
    await read('window.fileNode=document.querySelector(".markdown-inspector-preview"); window.initialFileReads=fileReads; void 0');
    await click('#add'); await click('[data-inspector-action="browser"]');
    await until('document.querySelector("webview")?.getWebContentsId?.()>0 && document.querySelector(".right-inspector-tab-page.active .right-inspector-preview.ready")');
    await read('window.browserId=document.querySelector("webview").getWebContentsId(); void 0');
    await click('#add'); await click('[data-inspector-action="review"]');
    await until('document.querySelectorAll(".change-review-file-item").length===2');
    await read('document.querySelectorAll(".change-review-file-item")[1].click(); window.reviewNode=document.querySelector(".change-review-dialog"); void 0');
    await until('document.querySelector(".change-review-file-item.active")?.title==="second.ts"');
    await select('history:a');
    assert.equal(await read('document.querySelector(".work-summary-turn-inspector")===historyNode && historyNode.scrollTop===historyPosition'),true,'history position survives other tab kinds');
    await click('.work-summary-turn-selector > button');
    await select('review:a');
    assert.equal(await read('Boolean(document.querySelector(".work-summary-turn-selector-menu"))'),false,'hidden history closes its picker');
    assert.equal(await read('document.querySelector(".change-review-dialog")===reviewNode && document.querySelector(".change-review-file-item.active").title==="second.ts"'),true,'review selection survives history');
    await read('navigation.openReview("first.ts"); void 0');
    await until('document.querySelector(".change-review-file-item.active").title==="first.ts"');
    await read('document.querySelectorAll(".change-review-file-item")[1].click(); void 0');
    await until('document.querySelector(".change-review-file-item.active").title==="second.ts"');
    await read('navigation.refreshReports(); void 0'); await pause(100);
    assert.equal(await read('document.querySelector(".change-review-file-item.active").title'),'second.ts','a live report refresh must not reapply an old file request');
    await select('history:a');
    await read('navigation.openReview("first.ts"); void 0');
    await until('document.querySelector(".change-review-file-item.active").title==="first.ts"');
    assert.equal(await read('document.querySelector(".change-review-dialog")===reviewNode'),true,'reopening a requested file selects it without remounting the review');
    await read('document.querySelectorAll(".change-review-file-item")[1].click(); void 0');
    await select('file');
    assert.equal(await read('document.querySelector(".markdown-inspector-preview")===fileNode && fileReads===initialFileReads'),true,'file preview stays mounted and is not re-read');
    await select('browser');
    assert.equal(await read('document.querySelector("webview").getWebContentsId()===browserId'),true,'history must not recreate the browser guest');

    await click('#add'); await click('[data-inspector-action="shadow"]');
    await until('document.querySelector(".shadow-window-shell textarea") && !document.querySelector(".shadow-window-shell textarea").disabled');
    await read('window.shadowNode=document.querySelector(".shadow-window-shell"); window.initialShadowCreates=shadowCreates; const input=shadowNode.querySelector("textarea"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(input,"保留此草稿"); input.dispatchEvent(new Event("input",{bubbles:true})); void 0');
    await select('history:a'); await select('shadow:a');
    assert.equal(await read('document.querySelector(".shadow-window-shell")===shadowNode && shadowNode.querySelector("textarea").value==="保留此草稿" && shadowCreates===initialShadowCreates'),true,'Shadow draft and runtime context survive tab switches');
    await read('navigation.setSession("b"); navigation.openHistory("turn-5","b"); void 0');
    await until('document.querySelector(".right-inspector-tab-page.active")?.dataset.inspectorPageId==="history:b"');
    assert.equal(await read('document.querySelector(".right-inspector-tab-page.active").querySelectorAll(".work-summary-inspector-turn").length'),9,'specific turn keeps the full history navigable');
    assert.ok(await read('document.querySelector(".right-inspector-tab-page.active .work-summary-turn-inspector").scrollTop>200'));
    await read('navigation.openHistory("turn-3","b"); void 0'); await pause(100);
    assert.equal(await read('navigation.tabs.filter(tab=>tab.id==="history:b").length'),1);
    await select('review:a');
    assert.equal(await read('document.querySelector(".change-review-file-item.active").title'),'second.ts','active conversation changes must not retarget a review tab');

    await read('navigation.openTab({id:"subagent:a:child",kind:"subagent",title:"子任务",detail:{kind:"subagent-task",sessionId:"a",task:{taskId:"child",status:"running",raw:{}}}}); void 0');
    await until('window.taskReads>0 && document.querySelector(".subagent-task-inspector header small")?.textContent==="运行中"');
    await select('history:a'); await pause(100);
    const reads=await read('window.taskReads');
    await read('window.runtimeTask={...runtimeTask,status:"completed",revision:2,completedAt:"2026-09-11T14:05:00Z",finalResponse:"任务完成"}; void 0');
    await pause(2700);
    assert.equal(await read('window.taskReads'),reads,'inactive child page must not poll');
    await select('subagent:a:child');
    await until('document.querySelector(".subagent-task-inspector header small")?.textContent==="已完成"');
    await select('history:a');
    await read('navigation.setLanguage("en"); document.querySelector(".right-inspector").style.width="380px"; document.querySelector(".right-inspector").style.flex="0 0 380px"; document.querySelector(".right-inspector").style.setProperty("--side-panel-width","380px"); void 0');
    await pause(250);
    await click('.right-inspector-tab-page.active .work-summary-turn-selector > button');
    assert.equal(await read('document.querySelector(".work-summary-turn-selector-menu").getAttribute("aria-label")'),'Select turn');
    assert.equal(await read('(()=>{const p=document.querySelector(".right-inspector").getBoundingClientRect(),m=document.querySelector(".work-summary-turn-selector-menu").getBoundingClientRect();return m.left>=p.left&&m.right<=p.right;})()'),true,'turn menu fits the narrow sidebar');
    await read('navigation.closeTabs(new Set(navigation.tabs.map(tab=>tab.id))); void 0');
    await until('document.querySelectorAll(".right-inspector-tab-page").length===0');
    assert.equal(await read('navigation.activeId'),'');
    assert.deepEqual(errors,[]);
    console.log('Inspector navigation passed: all five page kinds, actual file/browser/Shadow retention, review selection, scoped history scrolling, opaque turn picker, close/reopen identity, and inactive subagent polling.');
    clearTimeout(deadline); window.destroy(); app.exit(0);
  } catch(error) {
    console.error(error); console.error(errors);
    writeFileSync(resolve('tmp/inspector-navigation-failure.png'),(await window.webContents.capturePage()).toPNG());
    clearTimeout(deadline); app.exit(1);
  }
});
