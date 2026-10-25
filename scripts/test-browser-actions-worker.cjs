const assert = require('node:assert/strict');
const path = require('node:path');
const { writeFile } = require('node:fs/promises');
const { pathToFileURL } = require('node:url');
const { app, BrowserWindow } = require('electron');
const directory = path.resolve(process.argv[2]);
app.setPath('userData', path.join(directory, 'profile'));

app.whenReady().then(async () => {
  const { createCardbushChromeServer } = await import(pathToFileURL(path.resolve('packages/cardbush-chrome-mcp/dist/index.js')).href);
  const window = new BrowserWindow({ show: false, width: 1000, height: 800, useContentSize: true,
    webPreferences: { contextIsolation: true, backgroundThrottling: false, offscreen: true } });
  let tests = 0;
  try {
    const wc = window.webContents;
    wc.debugger.attach('1.3');
    const command = (name, params = {}) => wc.debugger.sendCommand(name, params);
    const events = [], released = [];
    let failRelease = false;
    const server = createCardbushChromeServer({ artifactsDirectory: path.join(directory, 'artifacts'), browserConfigPath: path.join(directory, 'browser.json'),
      connector: async (method, params) => {
        if (method === 'tabs.list') return [{ id: wc.id, active: true, title: 'Local fixture', url: wc.getURL() }];
        if (method === 'debugger.detachScope') return {};
        assert.equal(method, 'debugger.command');
        if (params.command === 'Input.dispatchMouseEvent') {
          events.push(params.commandParams);
          if (failRelease && params.commandParams.type === 'mouseReleased') { failRelease = false; throw new Error('simulated transport loss'); }
        }
        if (params.command === 'Runtime.releaseObject') released.push(params.commandParams.objectId);
        return command(params.command, params.commandParams);
      } });
    const context = { mcpReq: { signal: new AbortController().signal, _meta: { cardbush_session_id: 'browser-actions-fixture' } } };
    const invoke = (name, input = {}) => server._registeredTools[name].handler(input, context);
    const evaluate = expression => wc.executeJavaScript(expression);
    async function load(body, script = '') {
      await writeFile(path.join(directory, 'fixture.html'), `<!doctype html><meta charset="utf-8"><style>
        body{margin:40px;font:16px sans-serif}button,label{padding:12px}button{min-width:120px;min-height:40px}
        .cover{position:absolute;inset:0;background:white;z-index:1000}
        </style>${body}<script>window.audit={clicks:0,submits:0,trusted:[]};document.addEventListener('click',e=>{audit.clicks++;audit.trusted.push(e.isTrusted)});
        document.addEventListener('submit',e=>{e.preventDefault();audit.submits++});${script}</script>`);
      await window.loadFile(path.join(directory, 'fixture.html'));
      events.length = 0;
    }
    async function uid(expression) {
      const result = await command('Runtime.evaluate', { expression });
      const objectId = result.result.objectId;
      assert.ok(objectId, expression);
      const { node } = await command('DOM.describeNode', { objectId });
      await command('Runtime.releaseObject', { objectId });
      return 'cb_' + node.backendNodeId;
    }
    const selectorUid = selector => uid(`document.querySelector(${JSON.stringify(selector)})`);
    const click = async (selector, more = {}) => invoke('click', { uid: await selectorUid(selector), ...more });
    async function succeeds(result) {
      assert.ok(!result.isError, JSON.stringify(result));
      assert.equal(result.structuredContent.status, 'input_dispatched');
      assert.equal(result.structuredContent.hitTargetVerified, true);
      assert.equal(result.structuredContent.outcomeVerified, false);
      assert.doesNotMatch(result.content[0].text, /^Clicked /);
      assert.ok(released.length, 'remote objects are released');
    }
    async function blocked(selector, code) {
      const result = await click(selector);
      assert.equal(result.isError, true, JSON.stringify(result));
      if (code) assert.equal(result.structuredContent.error.code, code, JSON.stringify(result));
      assert.equal(result.structuredContent.error.details.inputDispatched, false);
      assert.equal(events.filter(e => e.type === 'mousePressed').length, 0);
      assert.equal((await evaluate('audit')).clicks, 0);
      tests++;
    }

    await load('<button id="button"><span>Real target child</span></button>');
    await succeeds(await click('#button'));
    assert.deepEqual(await evaluate('audit.trusted'), [true]);
    tests++;
    await succeeds(await click('#button', { doubleClick: true }));
    assert.equal((await evaluate('audit')).clicks, 3); tests++;

    // Real CDP hit testing expects document coordinates after scrollIntoView.
    for (const [left, top, zoom] of [[100, 2400, 1], [1500, 100, 1], [1500, 4000, 1], [100, 2400, 0.8], [100, 2400, 1.25]]) {
      await load(`<style>body{margin:0;width:3000px;height:5000px}</style><button id="target" style="position:absolute;left:${left}px;top:${top}px">Scrolled target</button>`);
      wc.setZoomFactor(zoom);
      await succeeds(await click('#target'));
      assert.deepEqual(await evaluate('audit.trusted'), [true]);
      assert.ok(await evaluate('scrollX > 0 || scrollY > 0'));
      wc.setZoomFactor(1); tests++;
    }
    await load('<style>body{height:5000px}</style><button id="target" style="position:fixed;top:100px;left:100px">Fixed through scroll</button>',
      `target.addEventListener('mouseenter',()=>scrollBy(0,500),{once:true})`);
    await succeeds(await click('#target'));
    assert.equal(await evaluate('scrollY'), 500);
    assert.deepEqual(await evaluate('audit.trusted'), [true]); tests++;

    await load('<style>body{height:5000px}</style><button id="target" style="position:absolute;top:2400px">Scroll away on hover</button>',
      `target.addEventListener('mouseenter',()=>scrollBy(0,500),{once:true})`);
    await blocked('#target', 'element_changed');

    // Bing's actual failure pattern: the submit input has zero area; its label is visible.
    await load('<form><input id="query"><input id="submit" type="submit"><label id="label" for="submit">Search</label></form><style>#submit{padding:0;height:0;width:0;outline:0;border:0;position:absolute}#label{display:inline-block}</style>');
    for (let i = 0; i < 3; i++) {
      const result = await click('#submit'); await succeeds(result);
      assert.equal(result.structuredContent.target, 'associated_label');
      assert.equal(result.structuredContent.targetUid, await selectorUid('#label'));
    }
    assert.equal((await evaluate('audit')).submits, 3); tests++;

    await load('<button id="target" style="min-width:0;min-height:0;padding:0;width:0;height:0;border:0"></button>');
    await blocked('#target', 'element_not_actionable');
    for (const attribute of ['disabled', 'aria-disabled="true"', 'inert', 'style="display:none"', 'style="visibility:hidden"', 'style="opacity:0"']) {
      await load(`<button id="target" ${attribute}>Unavailable</button>`);
      await blocked('#target', 'element_not_actionable');
    }
    await load('<fieldset disabled><button id="target">Disabled fieldset</button></fieldset>');
    await blocked('#target', 'element_not_actionable');
    await load('<button id="target" style="pointer-events:none">Does not receive input</button>');
    await blocked('#target', 'element_obscured');
    await load('<button id="target">Covered</button><div class="cover"></div>');
    await blocked('#target', 'element_obscured');
    await load('<div style="position:relative;display:inline-block"><button id="target">Partially covered</button><div style="position:absolute;left:40%;right:0;inset-block:0;background:white"></div></div>');
    await succeeds(await click('#target')); tests++;

    await load('<button id="target">Hover installs overlay</button>', `target.addEventListener('mouseenter',()=>{const cover=document.createElement('div');cover.className='cover';document.body.append(cover)},{once:true});`);
    await blocked('#target', 'element_changed');
    await load('<button id="target">Hover disables</button>', `target.addEventListener('mouseenter',()=>target.disabled=true,{once:true});`);
    await blocked('#target', 'element_changed');
    await load('<button id="target">Hover moves</button>', `target.addEventListener('mouseenter',()=>target.style.marginLeft='400px',{once:true});`);
    await blocked('#target', 'element_changed');

    await load('<button id="target">Detached</button>');
    const staleUid = await selectorUid('#target');
    await evaluate('target.remove()');
    const stale = await invoke('click', { uid: staleUid });
    assert.equal(stale.isError, true); assert.equal(events.length, 0); tests++;

    await load('<div id="host"></div>', `host.attachShadow({mode:'open'}).innerHTML='<button id="target" style="width:150px;height:50px"><span>Shadow</span></button>'`);
    await succeeds(await invoke('click', { uid: await uid('host.shadowRoot.querySelector("button")') }));
    assert.equal((await evaluate('audit')).clicks, 1); tests++;

    await load('<iframe id="frame" style="width:500px;height:250px;margin:100px;border:8px solid" srcdoc="<button id=inner style=width:180px;height:50px>Frame</button>"></iframe>');
    const frameUid = await uid('frame.contentDocument.querySelector("button")');
    await evaluate('frame.contentWindow.clicks=0;frame.contentDocument.querySelector("button").onclick=()=>frame.contentWindow.clicks++;true');
    await succeeds(await invoke('click', { uid: frameUid }));
    assert.equal(await evaluate('frame.contentWindow.clicks'), 1); tests++;
    await evaluate(`const cover=document.createElement('div');cover.className='cover';document.body.append(cover);`);
    events.length = 0;
    const obscuredFrame = await invoke('click', { uid: frameUid });
    assert.equal(obscuredFrame.isError, true, JSON.stringify(obscuredFrame));
    assert.equal(events.length, 0); tests++;
    await evaluate(`document.querySelector('.cover').remove();frame.style.opacity='0';true`);
    events.length = 0;
    const invisibleFrame = await invoke('click', { uid: frameUid });
    assert.equal(invisibleFrame.isError, true, JSON.stringify(invisibleFrame));
    assert.equal(events.length, 0); tests++;

    await load('<style>body{height:5000px}</style><iframe id="frame" style="position:absolute;top:2400px;width:500px;height:250px" srcdoc="<body style=height:2500px><button style=position:absolute;top:1800px;width:180px;height:50px onclick=window.clicked=true>Nested scroll</button></body>"></iframe>');
    await succeeds(await invoke('click', { uid: await uid('frame.contentDocument.querySelector("button")') }));
    assert.equal(await evaluate('frame.contentWindow.clicked'), true);
    assert.ok(await evaluate('scrollY > 0 && frame.contentWindow.scrollY > 0')); tests++;

    await load('<style>body{height:4000px}</style><iframe id="frame" style="position:absolute;top:2400px;width:500px;height:250px" srcdoc="<button style=width:180px;height:50px>Outer frame scroll only</button>"></iframe>');
    const outerScroll = await invoke('click', { uid: await uid('frame.contentDocument.querySelector("button")') });
    await succeeds(outerScroll);
    assert.ok(await evaluate('scrollY>0 && frame.contentWindow.scrollY===0'));
    assert.equal(outerScroll.structuredContent.autoScrolled,true,'outer frame scrolling must be included in the receipt');tests++;

    await load('<button id="target" style="position:absolute;left:-30px;top:100px;transform:rotate(20deg);width:220px">Transformed and clipped</button>');
    await succeeds(await click('#target'));
    assert.equal((await evaluate('audit')).clicks, 1); tests++;

    await load('<button id="target" disabled>Hover disabled for a tooltip</button>');
    const hover = await invoke('hover', { uid: await selectorUid('#target') });
    assert.equal(hover.isError, undefined, JSON.stringify(hover));
    assert.equal(events.filter(e => e.type !== 'mouseMoved').length, 0); tests++;

    await load('<button id="target">No blind retry</button>');
    failRelease = true;
    const interrupted = await click('#target');
    assert.equal(interrupted.isError, true);
    assert.equal(interrupted.structuredContent.error.details.inputDispatched, 'possibly');
    assert.equal(interrupted.structuredContent.error.details.attemptedPresses, 1);
    assert.equal(events.filter(e => e.type === 'mousePressed').length, 1);
    await command('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 0, y: 0, button: 'left', clickCount: 1 }); tests++;

    await load('<button id="target">Hide after first click</button>', `target.onclick=()=>target.style.display='none'`);
    const partial = await click('#target', { doubleClick: true });
    assert.equal(partial.isError, true);
    assert.equal(partial.structuredContent.error.details.completedClicks, 1);
    assert.equal(events.filter(e => e.type === 'mousePressed').length, 1); tests++;

    await load(`<main>${Array.from({ length: 220 }, (_, i) => `<button>Unique node ${i}</button>`).join('')}</main>`);
    let snapshot = await invoke('take_snapshot', { roles: ['button'], limit: 30 });
    const lines = [], seen = new Set();
    const originalCursor = snapshot.structuredContent.nextCursor;
    while (true) {
      assert.ok(!snapshot.isError, JSON.stringify(snapshot));
      assert.equal(snapshot.structuredContent.snapshot, undefined, 'text is not repeated in structured output');
      assert.ok(JSON.stringify(snapshot).length < 16_000);
      for (const line of snapshot.content[0].text.split('\n').filter(line => line.startsWith('uid='))) {
        assert.ok(!seen.has(line)); seen.add(line); lines.push(line);
      }
      const cursor = snapshot.structuredContent.nextCursor;
      if (!cursor) break;
      snapshot = await invoke('take_snapshot', { cursor, limit: 30 });
      assert.deepEqual(await invoke('take_snapshot', { cursor, limit: 30 }), snapshot, 'explicit reads are repeatable');
    }
    assert.equal(lines.length, 220); tests++;
    const query = await invoke('take_snapshot', { query: 'Unique node 219', roles: ['button'] });
    assert.equal(query.structuredContent.returned, 1); tests++;
    assert.equal((await invoke('take_snapshot', { cursor: originalCursor })).isError, true, 'fresh snapshot invalidates old cursor'); tests++;
    const first = await invoke('take_snapshot', { roles: ['button'], limit: 1 });
    await window.loadFile(path.join(directory, 'fixture.html'));
    const navigated = await invoke('take_snapshot', { cursor: first.structuredContent.nextCursor });
    assert.equal(navigated.structuredContent.error.code, 'snapshot_document_changed'); tests++;
    // Observable state, bounded inspection and reliable result conditions.
    await load('<button id="menu" aria-expanded="false" aria-haspopup="menu" aria-controls="options">Menu</button><div id="options" role="menu"></div><input id="mixed" type="checkbox"><input id="date" value="2026-10-17"><div id="results" aria-busy="true">Loading</div><p>Static prose</p>', 'mixed.indeterminate=true');
    const stateSnapshot = await invoke('take_snapshot', { interactiveOnly:true, inspectLimit:2 });
    assert.ok(!stateSnapshot.isError,JSON.stringify(stateSnapshot));
    assert.match(stateSnapshot.content[0].text,/expanded:false/);
    assert.match(stateSnapshot.content[0].text,/haspopup:"menu"/);
    assert.match(stateSnapshot.content[0].text,/checked:"mixed"/);
    assert.doesNotMatch(stateSnapshot.content[0].text,/Static prose/);
    assert.equal(stateSnapshot.structuredContent.inspection.checkedNodes,2);
    assert.equal(stateSnapshot.structuredContent.virtualizedTotal,'unknown'); tests++;
    const dateUid=await selectorUid('#date'),resultsUid=await selectorUid('#results'),menuUid=await selectorUid('#menu');
    await evaluate(`setTimeout(()=>{date.value='2026-10-18';results.setAttribute('aria-busy','false');results.textContent='Ready'},150);true`);
    const waited=await invoke('wait_for',{conditions:[{kind:'value',uid:dateUid,value:'2026-10-18'},{kind:'state',uid:resultsUid,name:'busy',value:false},{kind:'text',text:'Loading',present:false}],timeout:2000});
    assert.equal(waited.structuredContent.matched,true,JSON.stringify(waited));
    assert.equal(events.length,0); tests++;
    const timeout=await invoke('wait_for',{conditions:[{kind:'state',uid:menuUid,name:'expanded',value:true}],timeout:100});
    assert.equal(timeout.structuredContent.error.code,'wait_for_timeout');
    assert.equal(timeout.structuredContent.error.details.observations[0].state.expanded,false); tests++;
    const missing=await invoke('wait_for',{conditions:[{kind:'state',uid:dateUid,name:'busy',value:false}],timeout:100});
    assert.equal(missing.structuredContent.error.code,'wait_for_timeout','missing ARIA state is unknown'); tests++;
    assert.equal((await invoke('wait_for',{text:'Ready',timeout:100})).structuredContent.matched,true); tests++;
    await evaluate('menu.remove()');
    assert.equal((await invoke('wait_for',{conditions:[{kind:'visible',uid:menuUid,value:false}],timeout:100})).structuredContent.matched,true); tests++;

    // Different physical causes have different evidence; no recovery click is invented.
    for (const [body,reason] of [
      ['<button id="target" disabled>Disabled</button>','disabled'],
      ['<div inert><button id="target">Inert</button></div>','inert'],
      ['<button id="target" style="display:none">Hidden</button>','hidden'],
      ['<button id="target" style="min-width:0;min-height:0;width:0;height:0;padding:0;border:0"></button>','zero_size'],
      ['<button id="target" style="pointer-events:none">Transparent to pointer</button>','pointer_events_none'],
      ['<button id="target">Covered</button><div class="cover" role="dialog" aria-label="Confirmation"></div>','covered'],
      ['<div style="width:0;height:0;overflow:clip"><button id="target">Clipped</button></div>','clipped'],
    ]) {
      await load(body);
      const result=await click('#target');
      assert.equal(result.isError,true,JSON.stringify(result));
      const details=result.structuredContent.error.details;
      assert.equal(details.reason,reason,JSON.stringify(details));
      assert.equal(details.inputDispatched,false);assert.equal(events.filter(e=>e.type==='mousePressed').length,0);
      if(reason==='covered') {assert.equal(details.hitElement.role,'dialog');assert.equal(details.hitElement.name,'Confirmation');}
      tests++;
    }
    await load('<button id="target" style="pointer-events:none"><span style="display:block;pointer-events:auto">Child receives input</span></button>');
    await succeeds(await click('#target')); tests++;

    // An overlay hit after scrolling must not claim that the page was untouched.
    await load('<style>body{height:4000px}.cover{position:fixed}</style><button id="target" style="position:absolute;top:2600px">Offscreen covered</button><div class="cover"></div>');
    const scrolledFailure=await click('#target');
    assert.equal(scrolledFailure.structuredContent.error.details.autoScrolled,true);
    assert.equal(scrolledFailure.structuredContent.error.details.inputDispatched,false);
    assert.ok(await evaluate('scrollY>0')); tests++;
    await load('<button id="target" aria-expanded="false">Open</button>', `target.onclick=()=>target.setAttribute('aria-expanded','true')`);
    const post=await click('#target');await succeeds(post);
    assert.equal(post.structuredContent.postState.target.state.expanded,true);
    assert.equal(post.structuredContent.stability.stable,true);assert.ok(post.structuredContent.stability.frames>=2); tests++;

    await load('<button id="target">Always moving</button>', `let x=0;const move=()=>{target.style.transform='translateX('+(x+=2)+'px)';requestAnimationFrame(move)};requestAnimationFrame(move)`);
    const moving=await click('#target');
    assert.equal(moving.structuredContent.error.code,'element_unstable',JSON.stringify(moving));
    assert.equal(events.filter(e=>e.type==='mousePressed').length,0);tests++;
    await load('<button id="target">Moves briefly</button>', `let count=0;const move=()=>{target.style.transform='translateX('+(++count*2)+'px)';if(count<5)requestAnimationFrame(move)};requestAnimationFrame(move)`);
    await succeeds(await click('#target'));assert.equal((await evaluate('audit')).clicks,1);tests++;
    await load('<button id="target">Hover starts movement</button>', `target.onmouseenter=()=>{let x=0;const move=()=>{target.style.transform='translateX('+(x+=2)+'px)';requestAnimationFrame(move)};requestAnimationFrame(move)}`);
    const hoverMoving=await click('#target');
    assert.equal(hoverMoving.structuredContent.error.code,'element_unstable',JSON.stringify(hoverMoving));
    assert.equal(hoverMoving.structuredContent.error.details.mouseMoved,true);
    assert.equal(events.filter(e=>e.type==='mousePressed').length,0);tests++;

    await load('<button id="target">Rendering paused</button>', 'window.requestAnimationFrame=()=>0');
    const paused=await click('#target');
    assert.equal(paused.structuredContent.error.code,'element_unstable',JSON.stringify(paused));
    assert.equal(paused.structuredContent.error.details.stability.reason,'frames_unavailable');
    assert.equal(events.length,0);tests++;
    await load('<div id="target">Not a value-bearing control</div>');
    const emptyValue=await invoke('wait_for',{conditions:[{kind:'value',uid:await selectorUid('#target'),value:''}],timeout:100});
    assert.equal(emptyValue.structuredContent.error.code,'wait_for_timeout',JSON.stringify(emptyValue));tests++;

    await load('<input id="secret" type="password" value="never-echo-this-secret">');
    const secret=await click('#secret'); await succeeds(secret);
    assert.doesNotMatch(JSON.stringify(secret),/never-echo-this-secret/);tests++;
    await invoke('release_browser');
    console.log(`Browser native CDP regressions passed: ${tests} cases (hidden fixture only).`);
  } catch (error) { console.error(`Failed after ${tests} native cases`); throw error; }
  finally { window.destroy(); }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
