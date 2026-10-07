// Actual guest -> main -> preload -> React navigation, isolated from the user's browser/profile.
const { app, BrowserWindow, webContents, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { installInspectorWindowOpen } = require('../dist-electron/inspectorWindowOpen.js');
const { installAppSessionPermissions } = require('../dist-electron/appSessionPermissions.js');
const { IntegratedBrowser } = require('../dist-electron/integratedBrowser.js');
const { BrowserUiService, registerBrowserUiIpc } = require('../dist-electron/browserUi.js');
const { BrowserBookmarkImporter } = require('../dist-electron/browserImport.js');
const directory = path.resolve(process.argv[2]);
app.setPath('userData', path.join(directory, 'profile'));
app.on('window-all-closed', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  const delayedFrames = [];
  const delayedDocuments = [];
  let backgroundPageRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/metadata/app.webmanifest') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json' });
      res.end(JSON.stringify({ name: '演示网页应用', id: '/web-app', start_url: '../web-app/start', scope: '../web-app/', icons: [{ src: '../site-logo.svg', sizes: '192x192' }] })); return;
    }
    if (req.url.startsWith('/web-app/')) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<title>网站正文</title><link rel="manifest" href="/metadata/app.webmanifest"><link rel="icon" href="/site-logo.svg"><h1>网页应用</h1>'); return;
    }
    if (['/site-logo.svg', '/site-logo-alt.svg', '/favicon.ico'].includes(req.url)) {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="${req.url.includes('alt') ? '#ea580c' : '#2563eb'}"/><path d="M8 16h16M16 8v16" stroke="white" stroke-width="3"/></svg>`); return;
    }
    if (req.url === '/tab-design') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<title>品牌工作台 · 商品与成交数据</title><link rel="icon" href="/site-logo.svg"><h1>浏览器外观验证</h1>'); return;
    }
    if (req.url === '/browser-menu-download') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="browser-test.bin"', 'Content-Length': 1024 * 1024 });
      let sent = 0;
      const timer = setInterval(() => { res.write(Buffer.alloc(32768, 7)); sent += 32768; if (sent === 1024 * 1024) { clearInterval(timer); res.end(); } }, 80);
      res.once('close', () => clearInterval(timer)); return;
    }
    if (req.url === '/external-redirect') { res.writeHead(302, { Location: 'bytedance://probe/redirect' }); res.end(); return; }
    if (req.url === '/redirect') { res.writeHead(302, { Location: '/landing?query=%E6%A8%A1%E5%9E%8B' }); res.end(); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (req.url === '/browser-tools') { res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><title>Browser tools test</title><style>body{background:#caf0df;font:20px sans-serif}p{margin:40px}</style><button id="menu-probe" onclick="window.menuClicks=(window.menuClicks||0)+1">Page action</button><input id="menu-input" aria-label="Page input"><p>needle first</p><p>needle second</p><p>needle third</p><iframe id="menu-frame" src="/menu-frame" style="display:block;width:240px;height:70px"></iframe><a id="download" href="/browser-menu-download" download>Download</a>'); return; }
    if (req.url === '/menu-frame') { res.end('<button onclick="parent.frameClicks=(parent.frameClicks||0)+1">Frame action</button>'); return; }
    if (req.url === '/retention-document') {
      res.end('<title>Browser state</title><style>body{margin:24px;min-height:2200px}</style><input aria-label="Draft" value="Initial draft">'); return;
    }
    if (req.url === '/delayed-frame') { delayedFrames.push(res); return; }
    if (req.url === '/delayed-document') { delayedDocuments.push(res); return; }
    if (req.url === '/background-frame') {
      backgroundPageRequests++;
      res.end('<title>已加载的正文</title><style>body{height:2500px}#working{position:fixed;top:20px;left:20px}</style><button id="working" onclick="this.textContent=\'clicked\'">页面可操作</button><iframe id="background"></iframe><script>addEventListener("scroll",()=>{document.querySelector("#background").src="/delayed-frame"},{once:true})</script>'); return;
    }
    if (req.url === '/') res.end(`<title>搜索结果</title><style>body{margin:24px}a,button{display:block;margin:18px}</style>
      <a id="blank" href="/redirect" target="_blank" rel="noopener noreferrer">新标签搜索结果</a>
      <button id="script" onclick="window.open('/script','_blank')">脚本打开</button>
      <a id="same" href="/same">本页跳转</a><a id="middle" href="/middle">中键打开</a>
      <a id="keyboard" href="/keyboard" target="_blank">键盘打开</a>
      <iframe src="/frame" style="height:100px"></iframe>`);
    else if (req.url === '/frame') res.end('<a id="nested" href="/nested" target="_blank">子框架结果</a>');
    else if (req.url === '/wide') res.end('<title>Wide desktop page</title><style>body{margin:0;min-width:1800px;font:20px/1.5 sans-serif}#far{position:absolute;left:1700px}</style><p>Readable text</p><button id="far" onclick="this.textContent=\'clicked\'">Right edge</button>');
    else res.end(`<title>目标页 ${req.url}</title><h1 id="destination">${req.url}</h1>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, searchUrl = origin + '/';
  const window = new BrowserWindow({ show: false, width: 1100, height: 760, webPreferences: {
    preload: path.resolve('dist-electron/preload.js'), sandbox: true, contextIsolation: true,
    nodeIntegration: false, webviewTag: true, backgroundThrottling: false, offscreen: true,
  } });
  // Never launch a real OS app, even if the production permission policy regresses.
  // Record its decision while denying the external dispatch in this isolated fixture.
  const externalPermissions = [];
  const browserSession = window.webContents.session;
  const setCheck = browserSession.setPermissionCheckHandler.bind(browserSession);
  const setRequest = browserSession.setPermissionRequestHandler.bind(browserSession);
  browserSession.setPermissionCheckHandler = handler => setCheck((contents, permission, requestingOrigin, details) => {
    const allowed = handler(contents, permission, requestingOrigin, details);
    if (permission !== 'openExternal') return allowed;
    externalPermissions.push({ stage: 'check', allowed }); return false;
  });
  browserSession.setPermissionRequestHandler = handler => setRequest((contents, permission, callback, details) => {
    handler(contents, permission, allowed => {
      if (permission !== 'openExternal') { callback(allowed); return; }
      externalPermissions.push({ stage: 'request', allowed }); callback(false);
    }, details);
  });
  installAppSessionPermissions(window);
  browserSession.setPermissionCheckHandler = setCheck;
  browserSession.setPermissionRequestHandler = setRequest;
  installInspectorWindowOpen(window.webContents);
  const integrated = new IntegratedBrowser({ getContents: id => webContents.fromId(id), defaultOwner: () => window.webContents,
    action: (ownerId, action) => webContents.fromId(ownerId)?.send('inspector:browser-action', action) });
  const uiService = new BrowserUiService(path.join(directory, 'browser-library'), new BrowserBookmarkImporter({ chrome: path.join(directory, 'chrome'), edge: path.join(directory, 'edge') }));
  const ui = registerBrowserUiIpc(id => assert.equal(id, window.webContents.id), () => uiService);
  ui.attach(window.webContents);
  ipcMain.handle('inspector:browser-register', (event, input) => { integrated.register(event.sender, input); ui.track(event.sender, input.guestWebContentsId); });
  ipcMain.handle('inspector:browser-unregister', (event, input) => integrated.unregister(event.sender.id, input));
  const { BrowserConfigStore } = await import('@cardbush/product-host');
  const store = new BrowserConfigStore(path.join(directory, 'browser.json'));
  ipcMain.handle('browser:settings-read', () => store.read());
  ipcMain.handle('browser:settings-update', (_event, input) => store.update(input));
  const externallyOpened=[];
  ipcMain.handle('shell:open-external', (_event, target) => { externallyOpened.push(target); });
  const errors = [];
  window.webContents.on('preload-error', (_event, _file, error) => errors.push(error.message));
  window.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  window.webContents.session.webRequest.onBeforeRequest((details, done) => {
    if (details.url.startsWith('https://www.google.com/search?')) { done({redirectURL:origin+'/google-search?'+new URL(details.url).searchParams.toString()}); return; }
    done({ cancel: /^https?:/.test(details.url) && !details.url.startsWith(origin + '/') });
  });
  const read = expression => window.webContents.executeJavaScript(expression);
  const until = async (check, label) => {
    const end = Date.now() + 6000;
    while (!await check()) { if (Date.now() > end) throw new Error(`Timed out: ${label}; ${errors.join('; ')}`); await pause(30); }
  };
  const waitFor = (expression, label = expression) => until(() => read(expression), label);
  const activeReady = () => waitFor('browserFixture.navigation[browserFixture.activeId]?.loading===false && document.querySelector(".right-inspector-tab-page.active .right-inspector-preview.ready")!==null');
  const selectSearch = async () => {
    await read(`browserFixture.activateTab(${JSON.stringify(searchUrl)}); void 0`);
    await waitFor(`browserFixture.activeId===${JSON.stringify(searchUrl)}`);
    await activeReady();
  };
  const click = async (contents, selector, button = 'left') => {
    const point = await contents.executeJavaScript(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)};})()`);
    const zoom = contents.getZoomFactor(); point.x = Math.round(point.x * zoom); point.y = Math.round(point.y * zoom);
    contents.sendInputEvent({ type: 'mouseMove', ...point });
    contents.sendInputEvent({ type: 'mouseDown', button, clickCount: 1, ...point });
    contents.sendInputEvent({ type: 'mouseUp', button, clickCount: 1, ...point });
  };
  try {
    await window.loadFile(path.join(directory, 'index.html'));
    await waitFor('Boolean(window.browserFixture)');
    assert.equal(await read('document.querySelector(".right-inspector")'), null, 'retained pane still mounts lazily');
    await read(`browserFixture.open({target:${JSON.stringify(searchUrl)}}); void 0`);
    await activeReady();
    const originalId = await read('document.querySelector("webview").getWebContentsId()');
    const original = webContents.fromId(originalId);
    await until(() => original.executeJavaScript('!!document.querySelector("#blank")'), 'source page');
    await original.executeJavaScript('window.retainedState="search-state"');
    if (process.argv.includes('--browser-audio')) {
      await require('./helpers/browser-audio.cjs')({ window, original, origin, read, waitFor, activeReady, until, click, webContents });
      assert.deepEqual(errors, []); return;
    }
    if (process.argv.includes('--web-apps')) {
      await require('./helpers/browser-web-apps.cjs')({ window, original, origin, read, waitFor, activeReady, until, pause, click, externallyOpened, webContents });
      assert.deepEqual(errors, []); return;
    }
    if (process.argv.includes('--browser-chrome')) {
      await require('./helpers/browser-chrome.cjs')({ window, original, origin, read, waitFor, activeReady, until, pause, click });
      assert.deepEqual(errors, []); return;
    }
    if (process.argv.includes('--browser-ui')) {
      await require('./helpers/browser-menu.cjs')({ window, original, origin, directory, read, waitFor, activeReady, until, pause, click, uiService });
      assert.deepEqual(errors, []); return;
    }
    await require('./helpers/browser-external-protocols.cjs')({ window, original, origin, read, until, pause, externalPermissions });
    await waitFor('!document.querySelector(".deferred-resize-preview[data-resizing]")');
    await pause(200);

    await click(original, '#blank');
    await waitFor('browserFixture.tabs.length===2'); await activeReady();
    await waitFor('document.querySelector("#address").textContent.includes("/landing?query=")');
    assert.equal(original.getURL(), searchUrl, 'opening a result preserves the source page');
    assert.equal(await original.executeJavaScript('retainedState'), 'search-state');
    assert.equal(await read('openedLinks.length'), 2, 'only the originating guest opens one inspector tab');
    assert.equal(BrowserWindow.getAllWindows().length, 1, 'no native popup is created');

    const guestIds = await read('[...document.querySelectorAll("webview")].map(view=>view.getWebContentsId())');
    await read('browserFixture.setLayout(browserFixture.tabs.reduce((tree,tab)=>browserFixture.addPanel(tree,tab.id),null));void 0');
    await waitFor('document.querySelectorAll(".right-inspector-tab-page.active").length===2');
    const widths = await read('[...document.querySelectorAll(".right-inspector-tab-page")].map(page=>page.getBoundingClientRect().width)');
    assert.ok(Math.abs(widths[0]-widths[1])<2, 'two pages start at half width');
    await until(async () => await original.executeJavaScript('innerWidth') < widths[0]+10, 'guest viewport follows half-size tile');
    assert.equal(await read('document.querySelectorAll(".inspector-tile-frame > header,.inspector-tile-frame svg.lucide-external-link,.inspector-tile-frame svg.lucide-x").length'),0,'no duplicate tile title or global actions');
    assert.equal(await read(`Array.from(document.querySelectorAll('.inspector-tile-frame')).every(frame=>{
      const drag=frame.querySelector('.inspector-tile-drag').getBoundingClientRect(),address=frame.querySelector('form').getBoundingClientRect();
      return Math.abs(drag.y+drag.height/2-address.y-address.height/2)<2 && frame.getBoundingClientRect().height<60;
    })`),true,'drag handle and address share a single row');
    await require('./helpers/inspector-resize.cjs')({ window, read, waitFor, until, pause, original, guestIds });
    await read('browserFixture.setCovered(true);void 0');
    await waitFor('document.querySelector(".right-inspector-content").getBoundingClientRect().width>1000');
    const coverWidth=await read('document.querySelector(".right-inspector").getBoundingClientRect().width');
    await until(async () => Math.abs(await original.executeJavaScript('innerWidth')-(coverWidth/2-2))<3,'native guest fills half of full-cover content');
    assert.ok(await original.executeJavaScript('innerWidth')>widths[0]+50,'full-cover enlarges the actual guest');
    require('node:fs').writeFileSync(path.resolve('tmp/inspector-multipage.png'),(await window.webContents.capturePage()).toPNG());
    await read('browserFixture.setCovered(false);void 0');
    await until(async () => Math.abs(await original.executeJavaScript('innerWidth')-(widths[0]-2))<3,'leaving cover restores guest size');
    await waitFor('Math.abs(document.querySelector(".right-inspector").getBoundingClientRect().width-820)<0.5','return animation settles before targeting drag handles');
    await read('browserFixture.setLayout(browserFixture.resizePanelSplit(browserFixture.layout,"",.65));void 0');
    await waitFor('document.querySelector(".inspector-tile-divider").getAttribute("aria-valuenow")==="65"');
    const getSwapPoints=()=>read(`(()=>{const pages=document.querySelectorAll('.right-inspector-tab-page');
      const from=pages[0].querySelector('.inspector-tile-drag').getBoundingClientRect(),to=pages[1].querySelector('.right-inspector-navigation').getBoundingClientRect();
      return {from:{x:Math.round(from.x+from.width/2),y:Math.round(from.y+from.height/2)},to:{x:Math.round(to.x+to.width/2),y:Math.round(to.y+to.height/2)}};})()`);
    let swapPoints=await getSwapPoints();
    window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...swapPoints.from});
    await waitFor('document.body.classList.contains("inspector-layout-resizing")');
    window.webContents.sendInputEvent({type:'mouseMove',button:'left',...swapPoints.to});
    await waitFor('!!document.querySelector(".inspector-tile-drag-preview")');
    await read('window.dispatchEvent(new Event("blur"));void 0');
    window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...swapPoints.to});
    assert.equal(await read('document.body.classList.contains("inspector-layout-resizing")'),false,'focus loss cancels drag and restores interaction');
    assert.equal(await read('document.querySelectorAll(".inspector-tile-drag-preview,[data-tile-drop-target],[data-tile-drag-source]").length'),0,'cancel removes entire drag preview');
    assert.equal(await read('document.querySelector(".right-inspector-tab-page").style.left'),'0%','cancelled drag does not swap pages');
    // CSS scaling changes pointer-to-layout coordinates, as on scaled displays.
    for(const zoom of [1,1.25]) {
      await read(`document.querySelector('.app').style.zoom=${zoom};void 0`); await pause(150);
      swapPoints=await getSwapPoints();
      const target={x:swapPoints.from.x+200,y:swapPoints.from.y+45};
      window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...swapPoints.from});
      window.webContents.sendInputEvent({type:'mouseMove',button:'left',...target});
      await waitFor('!!document.querySelector(".inspector-tile-drag-preview")'); await pause(40);
      const preview=await read(`(()=>{const p=document.querySelector('.inspector-tile-drag-preview'),s=document.querySelector('[data-tile-drag-source]'),r=p.querySelector('.inspector-tile-drag').getBoundingClientRect();
        return {x:r.x+r.width/2,y:r.y+r.height/2,width:p.getBoundingClientRect().width,sourceWidth:s.getBoundingClientRect().width,address:p.querySelector('input').value,sourceAddress:s.querySelector('input').value,inert:p.inert};})()`);
      assert.ok(Math.abs(preview.x-target.x)<3 && Math.abs(preview.y-target.y)<3,`whole toolbar follows grip at ${zoom}: ${JSON.stringify(preview)}`);
      assert.ok(Math.abs(preview.width-preview.sourceWidth)<2,'preview uses full toolbar width');
      assert.equal(preview.address,preview.sourceAddress,'preview includes current address');
      assert.equal(preview.inert,true,'preview cannot steal address input focus');
      await read('window.dragEscapeSeen=false;window.dragEscapeCheck=event=>{if(event.key==="Escape")window.dragEscapeSeen=event.defaultPrevented};window.addEventListener("keydown",window.dragEscapeCheck);void 0');
      window.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});
      await waitFor('!document.querySelector(".inspector-tile-drag-preview")');
      assert.equal(await read('dragEscapeSeen'),true,'Escape cancels drag before workspace navigation');
      await read('window.removeEventListener("keydown",window.dragEscapeCheck);void 0');
      window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...target});
      assert.equal(await read('document.querySelector(".right-inspector-tab-page").style.left'),'0%','Escape leaves pane positions unchanged');
    }
    await read("document.querySelector('.app').style.zoom='';void 0"); await pause(150);
    swapPoints=await getSwapPoints();
    window.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...swapPoints.from});
    window.webContents.sendInputEvent({type:'mouseMove',button:'left',...swapPoints.to});
    await waitFor('!!document.querySelector("[data-tile-drop-target]")','swap target highlight');
    require('node:fs').writeFileSync(path.resolve('tmp/inspector-toolbar-drag.png'),(await window.webContents.capturePage()).toPNG());
    window.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...swapPoints.to});
    await waitFor('document.querySelector(".right-inspector-tab-page").style.left==="65%"');
    assert.equal(await read('document.body.classList.contains("inspector-layout-resizing")'),false,'drag releases page interaction');
    assert.equal(await read('document.querySelectorAll(".inspector-tile-drag-preview,[data-tile-drop-target],[data-tile-drag-source]").length'),0,'drop cleans preview and highlighting');
    assert.deepEqual(await read('[...document.querySelectorAll("webview")].map(view=>view.getWebContentsId())'),guestIds, 'resize and swap preserve native guests');
    assert.equal(await original.executeJavaScript('retainedState'),'search-state', 'page state survives multi-page layout');
    await original.executeJavaScript('document.body.insertAdjacentHTML("beforeend","<input id=tile-draft style=position:fixed;top:5px;left:5px>");void 0');
    await click(original,'#tile-draft');
    await waitFor(`browserFixture.activeId===${JSON.stringify(searchUrl)}`, 'guest focus activates its tile for browser shortcuts');
    await click(window.webContents,'#external');
    await until(()=>externallyOpened.length===1,'global external action');
    assert.equal(externallyOpened[0],searchUrl,'global action follows clicked guest');
    await click(window.webContents,'.right-inspector-tab-page:nth-child(2) input[aria-label="网址"]');
    await waitFor('browserFixture.activeId===browserFixture.tabs[1].id','address focus selects its page');
    await click(window.webContents,'#external');
    await until(()=>externallyOpened.length===2,'second global external action');
    assert.equal(externallyOpened[1],origin+'/landing?query=%E6%A8%A1%E5%9E%8B','global action uses selected page current URL after redirect');
    await read('browserFixture.setLayout(null);void 0');
    await waitFor('document.querySelectorAll(".right-inspector-tab-page.active").length===1');
    assert.deepEqual(await read('[...document.querySelectorAll("webview")].map(view=>view.getWebContentsId())'),guestIds, 'return to tabs preserves native guests');

    await selectSearch(); await click(original, '#script');
    await waitFor('browserFixture.tabs.length===3'); await activeReady();
    assert.equal(await read('document.querySelector("#address").textContent'), origin + '/script');
    assert.equal(await read('openedLinks.length'), 3);

    await selectSearch(); await click(original, '#same');
    await waitFor('document.querySelector("#address").textContent.endsWith("/same")'); await activeReady();
    assert.equal(await read('browserFixture.tabs.length'), 3, 'same-tab links do not add a tab');
    await read('document.querySelector("#back").click(); void 0');
    await waitFor(`document.querySelector('#address').textContent===${JSON.stringify(searchUrl)}`); await activeReady();
    assert.equal(await read('document.querySelector("#forward").disabled'), false);
    await read('document.querySelector("#forward").click(); void 0');
    await waitFor('document.querySelector("#address").textContent.endsWith("/same")'); await activeReady();
    await read('document.querySelector("#back").click(); void 0');
    await waitFor(`document.querySelector('#address').textContent===${JSON.stringify(searchUrl)}`); await activeReady();

    await click(original, '#middle', 'middle');
    await waitFor('browserFixture.tabs.length===4'); await activeReady();
    assert.equal(await read('document.querySelector("#address").textContent'), origin + '/middle');
    await selectSearch();
    await original.executeJavaScript('document.querySelector("#keyboard").focus(); void 0');
    original.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
    original.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
    await waitFor('browserFixture.tabs.length===5'); await activeReady();
    assert.equal(await read('document.querySelector("#address").textContent'), origin + '/keyboard');

    await selectSearch();
    await original.executeJavaScript('document.querySelector("iframe").contentDocument.querySelector("#nested").click(); void 0', true);
    await waitFor('browserFixture.tabs.length===6'); await activeReady();
    assert.equal(await read('document.querySelector("#address").textContent'), origin + '/nested');
    assert.equal(await read('openedLinks.length'), 6, 'other mounted guests ignore the event');

    await selectSearch();
    await original.executeJavaScript('window.open("file:///C:/private.txt"); void 0', true);
    await original.executeJavaScript('window.open("javascript:document.title=123"); void 0', true);
    await pause(150);
    assert.equal(await read('browserFixture.tabs.length'), 6, 'websites cannot open local or executable URLs');
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    assert.equal(await original.executeJavaScript('typeof require'), 'undefined');
    assert.equal(await original.executeJavaScript('typeof window.cardbushDesktop'), 'undefined', 'guest receives no desktop bridge');

    await store.update({ startPage: origin + '/legacy-home', expectedRevision: 1 });
    await require('./helpers/browser-new-tab.cjs')({ window, read, waitFor, activeReady, origin, webContents, click });
    assert.equal(original.getURL(), searchUrl, 'new tabs preserve existing tabs');

    await read(`browserFixture.open({target:${JSON.stringify(origin + '/wide')}}); void 0`);
    await activeReady();
    const wideId = await read('document.querySelector(".right-inspector-tab-page.active webview").getWebContentsId()');
    const wide = webContents.fromId(wideId);
    await until(() => wide.executeJavaScript('!!document.querySelector("#far")'), 'wide desktop page');
    await pause(350); // Include the former delayed fit-to-width path in this regression.
    assert.equal(wide.getZoomFactor(), 1, 'wide desktop pages keep normal text size');
    await read('document.querySelector(".right-inspector-tab-page.active .deferred-resize-preview").style.width="420px"; void 0');
    await waitFor('document.querySelector(".right-inspector-tab-page.active .deferred-resize-content").style.width==="420px"');
    await pause(250);
    assert.equal(wide.getZoomFactor(), 1, 'narrowing the panel never shrinks text');
    assert.equal(await wide.executeJavaScript('getComputedStyle(document.body).fontSize'), '20px');
    assert.equal(await wide.executeJavaScript('document.documentElement.scrollWidth>innerWidth'), true, 'wide content remains horizontally scrollable');
    await wide.executeJavaScript('scrollTo(document.documentElement.scrollWidth,0); void 0');
    await click(wide, '#far');
    await until(() => wide.executeJavaScript('document.querySelector("#far").textContent==="clicked"'), 'right-edge content remains usable');
    assert.equal(await read('document.querySelector(".right-inspector-tab-page.active webview").getWebContentsId()'), wideId, 'resizing preserves the same guest');

    await read(`browserFixture.open({target:${JSON.stringify(origin + '/background-frame')}}); void 0`);
    await activeReady();
    const backgroundId = await read('document.querySelector(".right-inspector-tab-page.active webview").getWebContentsId()');
    const background = webContents.fromId(backgroundId);
    await until(() => background.executeJavaScript('!!document.querySelector("#background")'), 'page with deferred iframe');
    await background.executeJavaScript('scrollTo(0,400); void 0');
    await until(() => delayedFrames.length === 1, 'background frame request');
    await pause(350);
    assert.equal(await read('getComputedStyle(document.querySelector(".right-inspector-tab-page.active webview")).opacity'), '1', 'background iframe loading must not blank an already loaded page');
    assert.equal(await read('document.querySelector(".right-inspector-tab-page.active .right-inspector-preview-loading")===null'), true, 'background resources must not cover usable content');
    await click(background, '#working');
    await until(() => background.executeJavaScript('document.querySelector("#working").textContent==="clicked"'), 'page usable while iframe is pending');
    assert.equal(await background.executeJavaScript('scrollY'), 400, 'scroll position survives background loading');
    delayedFrames[0].end('<p>Background loaded</p>');
    await activeReady();
    assert.equal(backgroundPageRequests, 1, 'page does not need a second request or an automatic reload');

    // Exercise the real timeout UI without making this suite wait thirty seconds.
    await read('window.normalTimeout=window.setTimeout; window.setTimeout=(callback,delay,...args)=>normalTimeout(callback,delay===30000?250:delay,...args); void 0');
    await read(`browserFixture.open({target:${JSON.stringify(origin + '/delayed-document')}}); void 0`);
    await until(() => delayedDocuments.length === 1, 'slow main document request');
    await waitFor('document.querySelector(".right-inspector-tab-page.active .inspector-preview-error")!==null');
    delayedDocuments[0].end('<title>慢页面已完成</title><p id="late-ready">正文现在可以阅读</p>');
    await activeReady();
    await waitFor('document.querySelector(".right-inspector-tab-page.active .inspector-preview-error")===null');
    assert.equal(delayedDocuments.length, 1, 'a late successful load clears timeout UI without reloading');
    await read('window.setTimeout=normalTimeout; void 0');
    await require('./helpers/inspector-retention.cjs')({ window, read, waitFor, activeReady, origin, webContents, pause, click });
    assert.deepEqual(errors, []);
    console.log('Inspector browser: single-row chrome, real drag/cancel, full-cover guest sizing/restore, selected-page external action, preserved guests, navigation, local new tabs, Google search and loading recovery passed.');
  } catch(error) {
    require('node:fs').writeFileSync(path.resolve('tmp/inspector-browser-failure.png'),(await window.webContents.capturePage()).toPNG());
    throw error;
  } finally { for (const response of [...delayedFrames, ...delayedDocuments]) response.end(); window.destroy(); server.close(); }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
