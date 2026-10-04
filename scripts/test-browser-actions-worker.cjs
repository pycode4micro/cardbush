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
    await invoke('release_browser');
    console.log(`Browser native CDP regressions passed: ${tests} cases (hidden fixture only).`);
  } catch (error) { console.error(`Failed after ${tests} native cases`); throw error; }
  finally { window.destroy(); }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
