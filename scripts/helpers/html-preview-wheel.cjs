const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { webContents } = require('electron');

module.exports = async ({ run, until, pause, root }) => {
  const directory = await fs.mkdtemp(path.join(root, 'tmp', 'html-wheel-'));
  const file = path.join(directory, 'report.html');
  await fs.writeFile(file, `<!doctype html><meta name="cardbush:preview" content="visualization"><style>
    body{margin:0;height:2100px;font:16px system-ui}#nested{height:100px;overflow:auto;margin-top:40px}
    #nested div{height:500px}#zoom{height:100px}#horizontal{width:200px;overflow:auto}#horizontal div{width:900px;height:40px}
    </style><button onclick="this.textContent='selected'">Choose</button>
    <div id="nested"><div>Nested scrolling</div></div><div id="zoom">Interactive plot</div>
    <div id="horizontal"><div>Wide table</div></div><p id="text">Ordinary content</p>
    <script>window.zoomCount=0;document.querySelector('#zoom').addEventListener('wheel',event=>{event.preventDefault();zoomCount++},{passive:false});</script>`);
  try {
    await run(`
      window.wheelLogs=[];window.wheelOriginalLog=cardbushDesktop.writeDebugLog;
      cardbushDesktop.writeDebugLog=async(scope,payload)=>{if(scope==='inline-html-preview')wheelLogs.push(...payload.records);};
      const message={id:'wheel-report',conversationId:'fixture',turnId:'fixture',role:'assistant',status:'completed',
        metadata:{transcript_kind:'assistant_final'},createdAt:'2026-10-13T00:00:00Z',content:'![Report](<'+${JSON.stringify(file.replaceAll('\\', '/'))}+'>)'};
      renderView(h('div',{id:'wheel-host',style:{height:560,width:704,overflowY:'auto',flex:'none'}},
        h('div',{style:{height:400}}),h(views.MessageBubble,{message,language:'zh',sending:false,activeTurnId:'',activeAssistantMessageId:''}),
        h('div',{style:{height:1000}})));
      window.hostWheelEvents=[];void 0;
    `);
    await until("!!document.querySelector('#wheel-host')", 'wheel host mounted');
    await run("document.querySelector('#wheel-host').addEventListener('wheel',event=>hostWheelEvents.push(event.deltaY));document.querySelector('#wheel-host').scrollTop=400;void 0");
    await until("!!document.querySelector('.inline-html-viewport.is-ready')", 'wheel report ready');
    await run("document.querySelector('.inline-html-expand-toggle').click();void 0");
    await pause(200);
    const guestId = await run("document.querySelector('webview').getWebContentsId()");
    const page = webContents.fromId(guestId);
    await page.executeJavaScript("window.wheelEvents=[];addEventListener('wheel',event=>wheelEvents.push({dy:event.deltaY,prevented:event.defaultPrevented,trusted:event.isTrusted,ctrl:event.ctrlKey,target:event.target.id,nestedTop:document.querySelector('#nested').scrollTop,overscroll:getComputedStyle(document.querySelector('#nested')).overscrollBehaviorY}));void 0");
    const top = () => run("document.querySelector('#wheel-host').scrollTop");
    const reset = async () => { await run("document.querySelector('#wheel-host').scrollTop=400;hostWheelEvents=[];void 0"); await pause(100); };
    const wheel = async (selector, dy = 60, extra = {}) => {
      const point = await page.executeJavaScript(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.left+20),y:Math.round(r.top+20)}})()`);
      page.sendInputEvent({ type: 'mouseMove', ...point });
      page.sendInputEvent({ type: 'mouseWheel', ...point, deltaX: 0, deltaY: -dy, ...extra });
      await pause(220);
    };
    // Native guest input, rather than setting the host's scrollTop, reproduces
    // the previously untested path that caused scrolling-only flashes.
    await reset();
    await wheel('#text', 100);
    assert.equal(await top(), 500, 'a guest wheel moves the conversation exactly once');
    assert.equal(await page.executeJavaScript('scrollY'), 0, 'full-height report does not scroll internally');
    assert.deepEqual(await run('hostWheelEvents'), [100], 'conversation receives reading intent once');
    const first = await page.executeJavaScript('wheelEvents.at(-1)');
    assert.equal(first.trusted, true, 'regression uses native wheel input');
    assert.equal(first.prevented, true, 'native guest-to-host scroll chaining is cancelled');
    await wheel('#text', -100);
    assert.equal(await top(), 400, 'upward guest wheel returns to the previous reading position');
    // Nested content consumes its own wheel until reaching the edge.
    await reset(); await wheel('#nested');
    assert.equal(await top(), 400, 'nested scrolling is not stolen by the conversation');
    assert.ok(await page.executeJavaScript("document.querySelector('#nested').scrollTop>0"));
    await page.executeJavaScript("document.querySelector('#nested').scrollTop=1000;void 0");
    await wheel('#nested'); assert.equal(await top(), 460, 'nested bottom hands off to conversation');
    await reset();
    await page.executeJavaScript("document.querySelector('#nested').style.overscrollBehaviorY='contain';void 0");
    await wheel('#nested'); assert.equal(await top(), 400, 'authored overscroll containment is respected: '+JSON.stringify(await page.executeJavaScript('wheelEvents.slice(-4)')));
    await reset(); await wheel('#zoom');
    assert.equal(await top(), 400, 'interactive chart owns its wheel');
    assert.ok(await page.executeJavaScript('zoomCount>0'));
    await wheel('#horizontal', 0, { deltaX: -60 });
    assert.ok(await page.executeJavaScript("document.querySelector('#horizontal').scrollLeft>0"), 'horizontal table scrolling still works');
    assert.equal(await top(), 400);
    await wheel('#text', 60, { modifiers: ['control'] });
    assert.equal(await run('hostWheelEvents.length'), 0, 'Ctrl+wheel does not become conversation scrolling');
    await page.executeJavaScript("document.querySelector('button').click();void 0");
    assert.equal(await page.executeJavaScript("document.querySelector('button').textContent"), 'selected', 'click interactions are preserved');
    // A capped document still has a native inner scroller, then hands off at its end.
    await page.executeJavaScript("document.body.style.height='3000px';void 0"); await pause(400);
    await reset(); await wheel('#text');
    assert.equal(await top(), 400, 'capped report scrolls inside first');
    assert.ok(await page.executeJavaScript('scrollY>0'));
    await page.executeJavaScript('scrollTo(0,9999);void 0');
    page.sendInputEvent({ type: 'mouseWheel', x: 40, y: 200, deltaX: 0, deltaY: -60 });
    await pause(220);
    assert.equal(await top(), 460, 'capped report hands off at document bottom');
    // Existing host cancellation is authoritative, so follow/restore code cannot
    // fight an unconditional second scroll performed by the bridge.
    await reset();
    await run("document.querySelector('#wheel-host').addEventListener('wheel',event=>event.preventDefault(),{once:true});void 0");
    page.sendInputEvent({ type: 'mouseWheel', x: 40, y: 200, deltaX: 0, deltaY: -60 }); await pause(220);
    assert.equal(await top(), 400, 'host handlers can cancel a handoff');
    assert.equal(await run("document.querySelector('webview').getWebContentsId()"), guestId, 'all gestures retain the same document');
    await pause(1000);
    assert.ok(await run("wheelLogs.some(record=>record.event==='wheel-handoff')"), 'bounded handoff diagnostics identify this input path');
    await run('renderView(null);void 0'); await pause(100);
    assert.equal(webContents.fromId(guestId), undefined, 'pending bridge reads do not retain a closed guest');
    console.log('HTML wheel routing passed: native input, single host scroll, nested/long document boundaries, authored controls, modifiers, host cancellation and cleanup.');
  } finally {
    await run('renderView(null);cardbushDesktop.writeDebugLog=wheelOriginalLog;void 0');
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(root, 'tmp'));
    await fs.rm(directory, { recursive: true, force: true });
  }
};
