const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { webContents } = require('electron');

module.exports = async ({ run, until, pause, window, root }) => {
  const directory = await fs.mkdtemp(path.join(root, 'tmp', 'html-wheel-'));
  const file = path.join(directory, 'report.html');
  const ordinaryFile = path.join(directory, 'ordinary.html');
  await fs.writeFile(file, `<!doctype html><meta name="cardbush:preview" content="visualization"><style>
    html{scrollbar-width:none}html::-webkit-scrollbar{display:none;width:0;height:0}
    body{margin:0;height:2100px;font:16px system-ui}#nested{height:100px;overflow:auto;margin-top:40px}
    #nested div{height:500px}#zoom{height:100px}#horizontal{width:200px;overflow:auto}#horizontal div{width:900px;height:40px}
    </style><button onclick="this.textContent='selected'">Choose</button>
    <div id="nested"><div>Nested scrolling</div></div><div id="zoom">Interactive plot</div>
    <div id="horizontal"><div>Wide table</div></div><p id="text">Ordinary content</p>
    <script>window.zoomCount=0;document.querySelector('#zoom').addEventListener('wheel',event=>{event.preventDefault();zoomCount++},{passive:false});</script>`);
  await fs.writeFile(ordinaryFile, '<!doctype html><style>body{margin:0;height:1800px}</style><p>Ordinary HTML document</p>');
  try {
    await run(`
      window.wheelLogs=[];window.wheelOriginalLog=cardbushDesktop.writeDebugLog;
      cardbushDesktop.writeDebugLog=async(scope,payload)=>{if(scope==='inline-html-preview')wheelLogs.push(...payload.records);};
      window.wheelMessage={id:'wheel-report',conversationId:'fixture',turnId:'fixture',role:'assistant',status:'completed',
        metadata:{transcript_kind:'assistant_final'},createdAt:'2026-10-13T00:00:00Z',content:'![Report](<'+${JSON.stringify(file.replaceAll('\\', '/'))}+'>)'};
      window.renderWheel=()=>renderView(h('div',{id:'wheel-host',style:{height:560,width:704,overflowY:'auto',flex:'none'}},
        h('div',{style:{height:400}}),h('div',{id:'wheel-wrapper',style:{overflowY:'auto'}},
          h(views.MessageBubble,{message:wheelMessage,language:'zh',sending:false,activeTurnId:'',activeAssistantMessageId:''})),
        h('div',{style:{height:1000}})));
      renderWheel();
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
    await run("window.wheelOriginalMotion=document.documentElement.dataset.motionPreference;document.documentElement.dataset.motionPreference='off';void 0");
    const sample = () => run(`window.wheelFrames=[];window.wheelSampling=true;requestAnimationFrame(function sample(time){
      const host=document.querySelector('#wheel-host');wheelFrames.push({time,top:host.scrollTop,anchor:host.style.overflowAnchor});if(wheelSampling)requestAnimationFrame(sample);});void 0`);
    const finishSample = () => run('wheelSampling=false;wheelFrames');
    const checkSmooth = (frames, label) => {
      assert.ok(new Set(frames.map(frame=>frame.top)).size>=4,label+' traverses intermediate positions');
      assert.ok(frames.slice(1).every((frame,index)=>frame.top>=frames[index].top-1),label+' never reverses');
      assert.equal(frames.at(-1).top,500,label+' consumes exactly one wheel delta');
      assert.ok(frames.some(frame=>frame.top>400&&frame.top<480),label+' does not snap a full wheel step');
      assert.ok(frames.every(frame=>frame.anchor===''),label+' keeps the native guest container styles stable throughout motion');
    };
    await reset();
    await sample();
    await wheel('#text', 100);
    const guestFrames = await finishSample(); checkSmooth(guestFrames,'HTML wheel');
    assert.equal(await top(), 500, 'a guest wheel moves the conversation exactly once');
    assert.equal(await page.executeJavaScript('scrollY'), 0, 'full-height report does not scroll internally');
    assert.deepEqual(await run('hostWheelEvents'), [100], 'conversation receives reading intent once');
    const first = await page.executeJavaScript('wheelEvents.at(-1)');
    assert.equal(first.trusted, true, 'regression uses native wheel input');
    assert.equal(first.prevented, true, 'native guest-to-host scroll chaining is cancelled');
    await wheel('#text', -100);
    assert.equal(await top(), 400, 'upward guest wheel returns to the previous reading position');
    // Send trusted host input through text beside the preview, then cross the
    // guest boundary during the same burst. Both must share the pending target.
    await run("window.wheelProbe=document.createElement('div');wheelProbe.textContent='Conversation text';wheelProbe.style.cssText='position:absolute;top:30px;left:4px;width:120px;height:28px;z-index:10;background:#222';document.querySelector('#wheel-host').style.position='relative';document.querySelector('#wheel-host').append(wheelProbe);void 0");
    const hostPoint = await run("(()=>{wheelProbe.style.top=(document.querySelector('#wheel-host').scrollTop+20)+'px';const r=wheelProbe.getBoundingClientRect();return {x:Math.round(r.left+10),y:Math.round(r.top+10)}})()");
    await reset(); await sample();
    window.webContents.sendInputEvent({type:'mouseMove',...hostPoint});
    window.webContents.sendInputEvent({type:'mouseWheel',...hostPoint,deltaX:0,deltaY:-100}); await pause(240);
    const hostFrames = await finishSample(); checkSmooth(hostFrames,'Conversation wheel');
    await reset();
    window.webContents.sendInputEvent({type:'mouseWheel',...hostPoint,deltaX:0,deltaY:-100}); await pause(45);
    await wheel('#text',100);
    assert.equal(await top(),600,'crossing into HTML preserves the unfinished conversation wheel distance');
    await reset();
    window.webContents.sendInputEvent({type:'mouseWheel',...hostPoint,deltaX:0,deltaY:-100}); await pause(40);
    await run("document.querySelector('#wheel-host').scrollTop=700;void 0");
    await wheel('#text',100);
    assert.equal(await top(),800,'a new wheel starts from an externally restored reading position, never a stale target');
    await fs.writeFile(path.join(root,'tmp/html-unified-wheel-motion.json'),JSON.stringify({guestFrames,hostFrames},null,2));
    await run('wheelProbe.remove();void 0');
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
    // Crossing the old 2400px cap must never change the scroll owner.
    await page.executeJavaScript("document.body.style.height='3000px';void 0"); await pause(400);
    await run("document.querySelector('.inline-html-collapse-top').click();void 0");
    await pause(180); await reset(); await wheel('#text');
    assert.equal(await top(), 460, 'folded long HTML scrolls the conversation instead of its clipped document');
    assert.equal(await page.executeJavaScript('scrollY'), 0, 'folded content remains at its beginning');
    await run("document.querySelector('.inline-html-expand-toggle').click();void 0"); await pause(180);
    await until("document.querySelector('.inline-html-viewport').clientHeight===3000", 'expanded HTML exposes its entire document in the conversation');
    assert.notEqual(await page.executeJavaScript("getComputedStyle(document.querySelector('#nested')).scrollbarWidth"), 'none', 'nested scrollers retain visible scrollbars');
    assert.notEqual(await page.executeJavaScript("getComputedStyle(document.querySelector('#horizontal'), '::-webkit-scrollbar').display"), 'none', 'wide tables retain their horizontal scrollbar');
    await reset(); await wheel('#text');
    assert.equal(await top(), 460, 'expanded long HTML uses exactly the same conversation scroll as folded HTML');
    assert.equal(await page.executeJavaScript('scrollY'), 0, 'expanded long HTML has no second page offset');
    await page.executeJavaScript('scrollTo(0,9999);void 0');
    assert.equal(await page.executeJavaScript('scrollY'), 0, 'programmatic root scroll cannot hide an offset');
    // Sample every step, including immediate direction reversals and gestures
    // across the former cap; an eventual correct position could hide a jump.
    const continuous = [];
    await reset();
    let expected = 400;
    for (const dy of [80,80,40,-30,-50,120,-120,16,-16]) {
      await wheel('#text',dy); expected+=dy;
      const actual = await top(); continuous.push({expected,actual});
      assert.ok(Math.abs(actual-expected)<=1, 'uninterrupted wheel deltas do not switch offsets: '+JSON.stringify(continuous));
      assert.equal(await page.executeJavaScript('scrollY'), 0);
    }
    await run("document.querySelector('#wheel-host').scrollTop=2900;hostWheelEvents=[];void 0"); await pause(80);
    page.sendInputEvent({type:'mouseWheel',x:40,y:2700,deltaX:0,deltaY:-60}); await pause(220);
    assert.equal(await top(),2960,'lower document content remains in the same conversation scroll');
    // Existing host cancellation is authoritative, so follow/restore code cannot
    // fight an unconditional second scroll performed by the bridge.
    await reset();
    await run("document.querySelector('#wheel-host').addEventListener('wheel',event=>event.preventDefault(),{once:true});void 0");
    await wheel('#text');
    assert.equal(await top(), 400, 'host handlers can cancel a handoff');
    assert.deepEqual(await run('hostWheelEvents'), [60], 'cancellation is exercised on the host, not an authored plot control');
    assert.equal(await run("document.querySelector('webview').getWebContentsId()"), guestId, 'all gestures retain the same document');
    await pause(1000);
    assert.ok(await run("wheelLogs.some(record=>record.event==='wheel-handoff')"), 'bounded handoff diagnostics identify this input path');
    // Theme opt-in must not select a different scrolling model.
    await run(`wheelMessage={...wheelMessage,content:'![Document](<'+${JSON.stringify(ordinaryFile.replaceAll('\\', '/'))}+'>)'};renderWheel();void 0`);
    await until("!!document.querySelector('.inline-html-viewport.is-ready') && !document.querySelector('.is-visualization')", 'ordinary HTML ready');
    const ordinary = webContents.fromId(await run("document.querySelector('webview').getWebContentsId()"));
    await reset();
    ordinary.sendInputEvent({type:'mouseWheel',x:40,y:100,deltaX:0,deltaY:-60}); await pause(220);
    assert.equal(await ordinary.executeJavaScript('scrollY'), 0, 'ordinary folded HTML has no internal page scroll');
    assert.equal(await top(), 460, 'ordinary folded HTML scrolls the conversation');
    await run("document.querySelector('.inline-html-expand-toggle').click();void 0"); await pause(100);
    await until("document.querySelector('.inline-html-viewport').clientHeight===1816", 'ordinary expanded HTML includes collapsed first-child margins');
    await reset();
    await ordinary.executeJavaScript('scrollTo(0,9999);void 0'); await pause(80);
    assert.equal(await ordinary.executeJavaScript('scrollY'), 0, 'ordinary HTML cannot acquire a second page offset');
    ordinary.sendInputEvent({type:'mouseWheel',x:40,y:100,deltaX:0,deltaY:-60}); await pause(220);
    assert.equal(await top(), 460, 'ordinary expanded HTML scrolls the same ancestor');
    assert.deepEqual(await run('hostWheelEvents'), [60], 'ordinary document scrolls exactly once');
    await ordinary.executeJavaScript('scrollTo(0,0);void 0'); await pause(80);
    ordinary.sendInputEvent({type:'mouseWheel',x:40,y:100,deltaX:0,deltaY:60}); await pause(220);
    assert.equal(await top(), 400, 'ordinary document top hands off upward');
    assert.equal(await run("document.querySelector('#wheel-wrapper').scrollTop"), 0, 'non-overflowing wrappers never absorb the handoff');
    await ordinary.executeJavaScript("document.body.style.cssText='margin:0;padding:24px;min-height:100vh';window.longContent=document.createElement('div');longContent.style.height='3000px';document.body.append(longContent);void 0");
    await until("document.querySelector('webview').clientHeight>3000", 'viewport-sized ordinary HTML grows to fit its real content');
    await pause(300);
    const stableHeight = await run("document.querySelector('webview').clientHeight");
    await pause(600);
    assert.equal(await run("document.querySelector('webview').clientHeight"), stableHeight, '100vh plus padding cannot cause an endless measurement/resize loop');
    assert.ok(stableHeight<3400,'viewport sizing does not accumulate extra blank space');
    assert.equal(await ordinary.executeJavaScript('scrollY'),0);
    await run('renderView(null);void 0'); await pause(100);
    assert.equal(webContents.fromId(guestId), undefined, 'pending bridge reads do not retain a closed guest');
    assert.equal(webContents.fromId(ordinary.id), undefined, 'ordinary document bridge is released');
    console.log('HTML wheel routing passed: native input, folded/expanded and ordinary HTML, visible nested scrollbars, single host handoff, authored controls, modifiers, host cancellation and cleanup.');
  } finally {
    await run("wheelSampling=false;renderView(null);cardbushDesktop.writeDebugLog=wheelOriginalLog;if(wheelOriginalMotion===undefined)delete document.documentElement.dataset.motionPreference;else document.documentElement.dataset.motionPreference=wheelOriginalMotion;void 0");
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(root, 'tmp'));
    await fs.rm(directory, { recursive: true, force: true });
  }
};
