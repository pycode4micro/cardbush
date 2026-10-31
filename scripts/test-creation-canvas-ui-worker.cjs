const { app, BrowserWindow, protocol, ipcMain, webContents, net, nativeImage } = require('electron');
const { readFile, writeFile, mkdir } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const { captureInspectorRegion } = require('../dist-electron/inspectorRegionCapture.js');
const { renderOfficePreview } = require('../dist-electron/officePreview.js');
const directory = process.argv[2], delay = ms => new Promise(resolve => setTimeout(resolve, ms));
app.setPath('userData', join(directory, 'profile'));
protocol.registerSchemesAsPrivileged([{ scheme: 'cardbush-file', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const { CreationCanvasFiles, readCanvas } = await import('../dist-electron/creationCanvasFiles.mjs');
  const { MarkdownFiles } = require('../dist-electron/mdPresentationFiles.js');
  const markdown = new MarkdownFiles(async () => undefined), teams = [];
  ipcMain.handle('canvas:markdown', (_, input) => markdown.command(input));
  ipcMain.handle('canvas:team', (_, { kind, payload }) => {
    if (payload.action === 'list') return kind === 'runtime.agent_registry' ? [] : { teams, runs: [] };
    if (payload.action === 'save') {
      const prior = teams.find(item => item.definition.id === payload.definition.id);
      if ((prior?.revision ?? 0) !== payload.expected_revision) throw Error('Definition changed. Read its current revision before saving.');
      const receipt = { revision: payload.expected_revision + 1, updatedAt: new Date().toISOString(), definition: payload.definition };
      if (prior) teams.splice(teams.indexOf(prior), 1, receipt); else teams.push(receipt);
      return receipt;
    }
    throw Error('Unexpected team command');
  });
  const { ToolRegistry, ToolExecutionCoordinator, WorkspaceObservationStore, registerWorkspaceTools } = await import('@cardbush/bush-runtime');
  const { registerDesignTool } = await import('../packages/bush-runtime/dist/designTool.js');
  const registry = new ToolRegistry(); registerWorkspaceTools(registry, new WorkspaceObservationStore()); registerDesignTool(registry);
  const coordinator = new ToolExecutionCoordinator({ registry, permissions: { request: async () => { throw Error('Unexpected permission prompt'); } } });
  let ordinal = 0;
  const service = new CreationCanvasFiles(async () => directory);
  ipcMain.handle('canvas:command', (_, input) => service.command(input));
  ipcMain.handle('canvas:workspace', async (_, id) => { const root = join(directory, id); await mkdir(root, { recursive: true }); return root; });
  ipcMain.handle('canvas:pick', () => [join(directory, 'sample.md'), join(directory, 'sample.html')]);
  ipcMain.handle('canvas:directory', () => directory);
  ipcMain.handle('canvas:text', async (_, path) => ({ content: await readFile(path, 'utf8'), truncated: false, encoding: 'utf-8' }));
  ipcMain.handle('canvas:design', (_, input) => coordinator.execute({ protocol: 'bush.tool_call.v1', id: `canvas-${++ordinal}`, name: 'design', argumentsText: JSON.stringify(input) }, { requestId: 'ui', sessionId: 'ui', turnId: 'turn', round: 1, ordinal }, undefined, { request: { protocol: 'bush.model_request.v1', requestId: 'ui', sessionId: 'ui', turnId: 'turn', model: 'fixture', tools: registry.definitions(), messages: [], permissionMode: 'all_free', metadata: { workspaceDir: directory } }, contextMessages: [] }));
  const win = new BrowserWindow({ show: false, width: 1440, height: 1020, titleBarStyle: 'hidden', titleBarOverlay: { color: '#00000000', symbolColor: '#eeeeee', height: 36 }, webPreferences: { offscreen: true, webviewTag: true, preload: join(directory, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
  const guests = new Set(); win.webContents.on('did-attach-webview', (_, guest) => guests.add(guest.id));
  ipcMain.handle('canvas:capture', (event, input) => captureInspectorRegion(event.sender, input, id => { assert.ok(guests.has(id)); return webContents.fromId(id); }));
  protocol.handle('cardbush-file', async request => {
    const url = new URL(request.url), path = url.searchParams.get('path');
    if (url.hostname === 'office-preview') {
      if (url.pathname.startsWith('/assets/')) return net.fetch(pathToFileURL(resolve('dist', url.pathname.slice(1))).href);
      if (/\.docx?$/.test(path)) return new Response(await renderOfficePreview(path), { headers: { 'Content-Type': 'text/html' } });
      return new Response(await readFile(resolve('dist/office-preview.html')), { headers: { 'Content-Type': 'text/html' } });
    }
    return net.fetch(pathToFileURL(path || decodeURIComponent(url.pathname).replace(/^\/(?=[A-Za-z]:)/, '')).href);
  });
  const run = async (value, userGesture = false) => {
    try { return await win.webContents.executeJavaScript(value, userGesture); }
    catch (cause) { throw new Error(`Renderer script failed: ${value.slice(0, 600)}`, { cause }); }
  };
  const until = async (expression, timeout = 20000) => { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (await run(expression).catch(() => false)) return; await delay(60); } throw Error(`Timed out: ${expression}; UI: ${(await run('document.body.innerText')).slice(0, 1200)}`); };
  const clickText = text => run(`Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(text)}).click()`);
  const selected = () => run('canvasStore.getCanvases().canvases.find(c=>c.id===canvasStore.getCanvases().selectedId)');
  const point = async selector => {
    // A host file read can see the new revision before the save reply reaches React.
    // Start the next gesture only after that reply and the resulting layout settle.
    await until('window.canvasPendingWrites===0');
    await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const hover = await run(`(()=>{const item=document.querySelector(${JSON.stringify(selector)}).closest('[data-canvas-item]');if(!item)return null;const r=item.getBoundingClientRect();return{x:Math.round(r.left+10),y:Math.round(r.top+10)}})()`);
    if (hover) { pointer('mouseMove', hover); await delay(150); }
    return run(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  };
  const pointer = (type, p, modifiers = []) => win.webContents.sendInputEvent({ type, x: p.x, y: p.y, button: 'left', clickCount: 1, modifiers });
  const design = async input => { const result = await run(`testBridge.design(${JSON.stringify(input)})`); assert.equal(result.kind, 'returned', JSON.stringify(result)); return result.result; };
  try {
    await win.loadFile(join(directory, 'app/index.html')); await until('!!document.querySelector("[data-canvas-item=document]")');
    if (process.env.CARDBUSH_CANVAS_PREVIEW) {
      const preview = await readCanvas(resolve(process.env.CARDBUSH_CANVAS_PREVIEW));
      await run(`canvasStore.acceptCanvas(${JSON.stringify(preview)})`);
      await until(`document.querySelectorAll('[data-canvas-item]').length===${preview.document.items.length} && !document.querySelector('.markdown-fallback') && document.querySelectorAll('.right-inspector-preview.ready').length===${preview.document.items.filter(item => item.kind === 'file').length}`);
      const imageCount = preview.document.items.filter(item => item.kind === 'file' && /\.(png|jpe?g|webp|gif)$/i.test(item.source)).length;
      await until(`document.querySelectorAll('.inspector-image-open img').length===${imageCount} && Array.from(document.querySelectorAll('.canvas-item-content img')).every(image=>image.complete && image.naturalWidth>0) && !document.querySelector('.inspector-media-error')`);
      await delay(700); // Let the existing preview reveal and canvas resize animations settle.
      assert.equal(await run('Array.from(document.querySelectorAll(".inspector-image-open img")).every(image=>image.getBoundingClientRect().height>0 && getComputedStyle(image).opacity!=="0")'), true);
      await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      await writeFile(resolve('tmp/canvas-development-desk-preview.png'), (await win.webContents.capturePage()).toPNG());
      console.log('PASS: opened existing development desk with native file previews.');
      return;
    }
    assert.match(await run('document.querySelector(".canvas-markdown").textContent'), /Preserve my writing/);
    await require('./helpers/sidebar-app-dock.cjs')({read:run,frame:()=>run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'),win,sidebar:'.canvas-sidebar'});
    assert.equal(await run(`canvasFileTarget('图 #1%25.png','C:/root #1/space.canvas.json')`), 'C:/root #1/图 #1%25.png');
    await clickText('新建画板'); await until('!!document.querySelector(".canvas-empty") && !!canvasStore.getCanvases().canvases.find(c=>c.id===canvasStore.getCanvases().selectedId)?.path');
    assert.equal(await run('document.querySelector(".creation-canvas-app").textContent.includes("项目")'), false);
    await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))'); await delay(300);
    assert.equal(await run('document.querySelector(".canvas-zoom-value").textContent'), '100%', 'new canvases open at actual size');
    assert.match(await run('document.querySelector(".canvas-zoom-value").title'), /单击.*100%.*双击.*编辑/);
    const zoomClick = async count => {
      const p = await point('.canvas-zoom-value');
      for (const type of ['mouseDown','mouseUp']) win.webContents.sendInputEvent({ type, ...p, button: 'left', clickCount: count });
    };
    const zoomKey = keyCode => { for (const type of ['keyDown','keyUp']) win.webContents.sendInputEvent({ type, keyCode }); };
    await run('document.querySelector("[aria-label=放大]").click()');
    await until('document.querySelector(".canvas-zoom-value").textContent==="110%"');
    await zoomClick(1); await delay(60); await zoomClick(2);
    await until('!!document.querySelector(".canvas-zoom-edit input")');
    assert.equal(await run('document.querySelector(".canvas-zoom-edit input").value'), '110', 'double-click preserves the pre-click value');
    assert.equal(await run('new DOMMatrix(getComputedStyle(document.querySelector(".canvas-plane")).transform).a'), 1.1);
    await win.webContents.insertText('140'); zoomKey('Return');
    await until('document.querySelector(".canvas-zoom-value")?.textContent==="140%"');
    await zoomClick(1); await until('document.querySelector(".canvas-zoom-value").textContent==="100%"');
    await zoomClick(1); await delay(60); await zoomClick(2); await until('!!document.querySelector(".canvas-zoom-edit input")');
    await win.webContents.insertText('175'); zoomKey('Escape');
    await until('document.querySelector(".canvas-zoom-value")?.textContent==="100%"');
    const zoomWindow = win.getContentSize();
    win.setContentSize(680, 860); await until('innerWidth===680');
    await run('canvasAppearance("en","light")'); await until('document.querySelector(".canvas-zoom-value").title.includes("double-click")');
    assert.equal(await run('document.querySelector(".canvas-zoom-value").textContent'), '100%', 'window resizing preserves the selected zoom');
    await writeFile(resolve('tmp/canvas-zoom-controls-en-light.png'), (await win.webContents.capturePage()).toPNG());
    await run('document.querySelector(".canvas-zoom-value").focus()'); zoomKey('F2');
    await until('!!document.querySelector(".canvas-zoom-edit input")');
    assert.equal(await run('document.querySelector(".canvas-zoom-edit input").getAttribute("aria-label")'), 'Zoom percentage');
    await writeFile(resolve('tmp/canvas-zoom-editor-en-light.png'), (await win.webContents.capturePage()).toPNG()); zoomKey('Escape');
    await run('canvasAppearance("zh","dark")'); win.setContentSize(...zoomWindow);
    await until(`innerWidth===${zoomWindow[0]} && !!document.querySelector('[aria-label="适应窗口"]')`);
    await delay(150); await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await writeFile(resolve('tmp/creation-canvas-empty.png'), (await win.webContents.capturePage()).toPNG());
    await clickText('素材'); await until('document.querySelectorAll("[data-canvas-item]").length===2');
    await until('document.querySelector(".canvas-stage").textContent.includes("A real Markdown file")');
    assert.equal(await run('document.querySelector(".canvas-zoom-value").textContent'), '100%', 'adding files keeps the default scale');
    await run('document.querySelector("[aria-label=适应窗口]").click()');
    await until('document.querySelector("[aria-label=适应窗口]").getAttribute("aria-pressed")==="true"');
    assert.equal(await run('!!document.querySelector(".canvas-board-label")'), false, 'no extra canvas dimension label');
    assert.equal(await run('(()=>{const stage=getComputedStyle(document.querySelector(".canvas-stage")),board=getComputedStyle(document.querySelector(".canvas-size"));return stage.backgroundImage.includes("radial-gradient")&&board.backgroundImage==="none"&&board.outlineStyle==="none"})()'), true, 'the canvas background covers the workspace rather than a fixed document rectangle');
    const initialBlank = await run('(()=>{const r=document.querySelector(".canvas-stage").getBoundingClientRect();return{x:Math.round(r.left+5),y:Math.round(r.top+5)}})()');
    pointer('mouseDown', initialBlank); pointer('mouseUp', initialBlank);
    const initialSize = win.getContentSize();
    for (const [width, height] of [[1440, 1020], [1000, 780], [680, 860], initialSize]) {
      win.setContentSize(width, height); await until(`window.innerWidth===${width} && window.innerHeight===${height}`);
      await delay(150); await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const edges = await run(`(()=>{const rect=selector=>document.querySelector(selector).getBoundingClientRect(),stage=rect('.canvas-stage'),items=[...document.querySelectorAll('[data-canvas-item]')].map(item=>item.getBoundingClientRect());return{title:rect('.topbar h1').left,name:rect('[aria-label=画板名称]').left,zoom:rect('.canvas-zoom').left,left:Math.min(...items.map(r=>r.left)),right:Math.max(...items.map(r=>r.right)),top:Math.min(...items.map(r=>r.top)),bottom:Math.max(...items.map(r=>r.bottom)),stageLeft:stage.left,stageRight:stage.right,stageTop:stage.top,stageBottom:stage.bottom}})()`);
      for (const name of ['name','zoom']) assert.ok(Math.abs(edges.title - edges[name]) < .6, `${width}px viewport: ${name} shares the creation title edge: ${JSON.stringify(edges)}`);
      assert.ok(edges.left >= edges.stageLeft && edges.right <= edges.stageRight && edges.top >= edges.stageTop && edges.bottom <= edges.stageBottom - 44, 'all content fits with room for controls');
      assert.ok(Math.abs((edges.left + edges.right) / 2 - (edges.stageLeft + edges.stageRight) / 2) < 1, 'content is centred even on wide screens');
    }
    await writeFile(resolve('tmp/creation-canvas-boundaries.png'), (await win.webContents.capturePage()).toPNG());
    const entry = await selected(), current = await design({ action: 'inspect', path: entry.path });
    const tutorialId = current.document.items.find(item => item.kind === 'file' && item.source.endsWith('sample.md')).id;
    await run(`document.querySelector('[data-canvas-item="${tutorialId}"] [aria-label=固定此版本]').click()`);
    await until(`document.querySelector('[data-canvas-item="${tutorialId}"]')?.dataset.canvasSource?.includes('canvas-versions/')`);
    assert.equal(await run('!!document.querySelector(".canvas-notice.error")'), false, 'tutorial code examples never trigger missing-file errors');
    await run(`document.querySelector('[data-canvas-item="${tutorialId}"] [aria-label=恢复更新]').click()`);
    await until(`window.canvasPendingWrites===0 && !!document.querySelector('[data-canvas-item="${tutorialId}"] [aria-label=固定此版本]')`);
    const afterVersion = await design({ action: 'inspect', path: entry.path });
    const missing = { id: 'missing-reference', kind: 'markdown', title: 'Missing reference', markdown: '![Missing](missing.png)', frame: { x: 800, y: 400, width: 400, height: 200 } };
    await design({ action: 'update', path: entry.path, expected_revision: afterVersion.revision, upsert: [missing] });
    await until('!!document.querySelector("[data-canvas-item=missing-reference]")');
    const viewportBeforeError = await run('(()=>{const r=document.querySelector(".canvas-size").getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()');
    await run('document.querySelector("[data-canvas-item=missing-reference] [aria-label=固定此版本]").click()');
    await until('document.querySelector(".canvas-notice.error")?.textContent.includes("missing.png")');
    assert.doesNotMatch(await run('document.querySelector(".canvas-notice.error").textContent'), /ENOENT|Error invoking|task-workspaces/);
    assert.deepEqual(await run('(()=>{const r=document.querySelector(".canvas-size").getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})()'), viewportBeforeError, 'notifications never resize or shift the canvas');
    const afterError = await design({ action: 'inspect', path: entry.path });
    await design({ action: 'update', path: entry.path, expected_revision: afterError.revision, remove: ['missing-reference'] });
    await run('document.querySelector("[aria-label=关闭提示]").click()');
    const latest = await design({ action: 'inspect', path: entry.path });
    const html = { id: 'interactive', title: 'Interactive HTML', kind: 'html', html: '<style>body{margin:20px;background:#252e40;color:#cde}h1{font-size:24px}button{padding:10px}</style><h1>Canvas interaction</h1><button onclick="this.textContent=Number(this.textContent)+1">0</button>', frame: { x: 40, y: 500, width: 550, height: 260 } };
    await design({ action: 'update', path: entry.path, expected_revision: latest.revision, upsert: [html] });
    await until('!!document.querySelector("[data-canvas-item=interactive] iframe")'); await delay(250);
    const childFrame = () => win.webContents.mainFrame.frames.find(frame => frame.url.startsWith('about:srcdoc'));
    const frameDeadline = Date.now() + 10000;
    while (Date.now() < frameDeadline && !(await childFrame()?.executeJavaScript('!!document.querySelector("button")').catch(()=>false))) await delay(60);
    assert.ok(childFrame(), 'the interactive HTML document loaded');
    const frameId = childFrame().routingId;
    await childFrame().executeJavaScript('document.querySelector("button").click()'); assert.equal(await childFrame().executeJavaScript('document.querySelector("button").textContent'), '1');
    const update = await design({ action: 'inspect', path: entry.path }); await design({ action: 'update', path: entry.path, expected_revision: update.revision, canvas: { title: 'My canvas space' } });
    await until('document.querySelector("[aria-label=画板名称]").value==="My canvas space"');
    assert.equal(childFrame().routingId, frameId); assert.equal(await childFrame().executeJavaScript('document.querySelector("button").textContent'), '1');
    await run('document.querySelector("[data-canvas-item=interactive]").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))');
    await run(`window.pointerLog=[];for(const type of ['pointerdown','pointermove','pointerup'])document.addEventListener(type,e=>pointerLog.push({type,x:e.clientX,y:e.clientY,target:e.target.outerHTML?.slice(0,160)}),true)`);
    await delay(300); await writeFile(resolve('tmp/creation-canvas-before-drag.png'), (await win.webContents.capturePage()).toPNG());
    const move = await point('[data-canvas-item=interactive] [aria-label=移动内容]'); pointer('mouseMove', move); await delay(80); pointer('mouseDown', move); await delay(80); pointer('mouseMove', { x: move.x + 36, y: move.y + 12 }); await delay(100); pointer('mouseUp', { x: move.x + 36, y: move.y + 12 });
    await until(`testBridge.creationCanvas({action:'read',path:${JSON.stringify(entry.path)}}).then(s=>s.document.items.find(i=>i.id==='interactive').frame.x>40)`);
    const dragged = (await readCanvas(entry.path)).document.items.find(item => item.id === 'interactive'); assert.ok(dragged.frame.x > 40);
    const resize = await point('[data-canvas-item=interactive] [aria-label=调整大小]'); pointer('mouseDown', resize); pointer('mouseMove', { x: resize.x + 20, y: resize.y + 15 }); await delay(100); pointer('mouseUp', { x: resize.x + 20, y: resize.y + 15 });
    await until(`testBridge.creationCanvas({action:'read',path:${JSON.stringify(entry.path)}}).then(s=>s.document.items.find(i=>i.id==='interactive').frame.width>550)`);
    await require('./helpers/canvas-auto-fit.cjs')({ run, until, win, delay, pointer, point, readCanvas, path: entry.path });
    // Exercise the actual pointer path at the small zoom reported by the user.
    const beforeGeometry = await readCanvas(entry.path);
    const peer = { id: 'alignment', kind: 'markdown', title: 'Alignment reference', markdown: '# Alignment reference\n\n' + 'A scrollable paragraph.\n\n'.repeat(40), frame: { x: 900, y: 580, width: 300, height: 200 } };
    await design({ action: 'update', path: entry.path, expected_revision: beforeGeometry.revision, layout: true,
      remove: beforeGeometry.document.items.filter(item => item.id !== 'interactive').map(item => item.id), upsert: [html, peer] });
    await until('document.querySelectorAll("[data-canvas-item]").length===2 && !!document.querySelector("[data-canvas-item=alignment]")');
    const geometryFrame = async () => (await readCanvas(entry.path)).document.items.find(item => item.id === 'interactive').frame;
    const boardRect = () => run('(()=>{const r=document.querySelector(".canvas-plane").getBoundingClientRect();return{x:r.x,y:r.y}})()');
    await run(`window.canvasResizeLog=[];new ResizeObserver(()=>canvasResizeLog.push({w:document.querySelector('.canvas-stage').clientWidth,h:document.querySelector('.canvas-stage').clientHeight,z:document.querySelector('.canvas-zoom span').textContent,at:performance.now()})).observe(document.querySelector('.canvas-stage'))`);
    await run(`(()=>{const stage=document.querySelector('.canvas-stage'),rect=stage.getBoundingClientRect(),zoom=new DOMMatrix(getComputedStyle(document.querySelector('.canvas-plane')).transform).a;stage.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,ctrlKey:true,deltaY:-Math.log(.51/zoom)/.002,clientX:rect.x+rect.width/2,clientY:rect.y+(rect.height-56)/2}))})()`);
    await until('document.querySelector(".canvas-zoom span").textContent==="51%"');
    const manualSize = win.getContentSize(); win.setContentSize(1000, 780);
    await until('innerWidth===1000 && innerHeight===780'); await delay(150);
    assert.equal(await run('document.querySelector("[aria-label=适应窗口]").getAttribute("aria-pressed")'), 'false', 'resizing keeps manual zoom instead of enabling auto-fit');
    assert.equal(await run('document.querySelector(".canvas-zoom-value").textContent'), '51%');
    win.setContentSize(...manualSize); await until(`innerWidth===${manualSize[0]} && innerHeight===${manualSize[1]}`); await delay(400); // Sidebar width transition must finish before a new manual gesture.
    await run(`(()=>{const stage=document.querySelector('.canvas-stage'),rect=stage.getBoundingClientRect(),zoom=new DOMMatrix(getComputedStyle(document.querySelector('.canvas-plane')).transform).a;stage.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,ctrlKey:true,deltaY:-Math.log(.51/zoom)/.002,clientX:rect.x+rect.width/2,clientY:rect.y+(rect.height-56)/2}))})()`);
    await until('document.querySelector(".canvas-zoom span").textContent==="51%"');
    const titleHandle = await point('[data-canvas-item=interactive] .canvas-item-move');
    pointer('mouseMove', titleHandle); pointer('mouseDown', titleHandle); await delay(40);
    pointer('mouseMove', { x: titleHandle.x + 155, y: titleHandle.y }); await delay(100);
    await until('!!document.querySelector(".canvas-guide-x")');
    assert.equal(await run('Number.parseFloat(document.querySelector(".canvas-guide-x").style.left)'), 900);
    await writeFile(resolve('tmp/creation-canvas-alignment.png'), (await win.webContents.capturePage()).toPNG());
    pointer('mouseUp', { x: titleHandle.x + 155, y: titleHandle.y });
    await until(`testBridge.creationCanvas({action:'read',path:${JSON.stringify(entry.path)}}).then(s=>s.document.items.find(i=>i.id==='interactive').frame.x===350)`);
    assert.deepEqual(await geometryFrame(), { ...html.frame, x: 350 });
    const hitSize = await run('(()=>{const r=document.querySelector("[data-canvas-item=interactive] [data-resize-handle=nw]").getBoundingClientRect();return{width:r.width,height:r.height}})()');
    assert.ok(Math.abs(hitSize.width - 18) < .1 && Math.abs(hitSize.height - 18) < .1, 'resize target remains 18 screen pixels at 51%');

    const preciseMove = await point('[data-canvas-item=interactive] .canvas-item-move');
    pointer('mouseDown', preciseMove, ['alt']); pointer('mouseMove', { x: preciseMove.x - 4, y: preciseMove.y }, ['alt']); await delay(80); pointer('mouseUp', { x: preciseMove.x - 4, y: preciseMove.y }, ['alt']);
    await until(`testBridge.creationCanvas({action:'read',path:${JSON.stringify(entry.path)}}).then(s=>s.document.items.find(i=>i.id==='interactive').frame.x===342)`);
    const northwest = await point('[data-canvas-item=interactive] [data-resize-handle=nw]');
    pointer('mouseDown', northwest, ['alt']); pointer('mouseMove', { x: northwest.x + 30, y: northwest.y + 20 }, ['alt']); await delay(80); pointer('mouseUp', { x: northwest.x + 30, y: northwest.y + 20 }, ['alt']);
    await until(`testBridge.creationCanvas({action:'read',path:${JSON.stringify(entry.path)}}).then(s=>s.document.items.find(i=>i.id==='interactive').frame.width===491)`);
    assert.deepEqual(await geometryFrame(), { x: 401, y: 539, width: 491, height: 221 }, 'northwest resize holds the bottom and right edges fixed');
    const beforeClick = await readCanvas(entry.path), selectPoint = await point('[data-canvas-item=interactive] .canvas-item-move');
    pointer('mouseDown', selectPoint); pointer('mouseUp', selectPoint); await delay(60);
    assert.equal((await readCanvas(entry.path)).revision, beforeClick.revision, 'selecting a title does not save an unchanged frame');
    for (const [keyCode, modifiers, axis, value] of [['Right', [], 'x', 402], ['Down', ['shift'], 'y', 549], ['Left', [], 'x', 401], ['Up', ['shift'], 'y', 539]]) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
      await until(`testBridge.creationCanvas({action:'read',path:${JSON.stringify(entry.path)}}).then(s=>s.document.items.find(i=>i.id==='interactive').frame.${axis}===${value})`);
    }

    const beforeCancel = await readCanvas(entry.path), cancelPoint = await point('[data-canvas-item=interactive] .canvas-item-move');
    pointer('mouseDown', cancelPoint); pointer('mouseMove', { x: cancelPoint.x - 80, y: cancelPoint.y - 40 }); await delay(80);
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' }); win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    pointer('mouseUp', { x: cancelPoint.x - 80, y: cancelPoint.y - 40 }); await until('!document.querySelector(".canvas-drag-shield")');
    assert.equal((await readCanvas(entry.path)).revision, beforeCancel.revision, 'Escape cancels without persisting a partial drag');

    const conflictPoint = await point('[data-canvas-item=interactive] .canvas-item-move');
    pointer('mouseDown', conflictPoint); pointer('mouseMove', { x: conflictPoint.x - 60, y: conflictPoint.y }); await delay(80);
    await design({ action: 'update', path: entry.path, expected_revision: beforeCancel.revision, canvas: { title: 'Changed during a drag' } });
    await until('document.querySelector("[aria-label=画板名称]").value==="Changed during a drag"');
    pointer('mouseUp', { x: conflictPoint.x - 60, y: conflictPoint.y }); await until('document.querySelector(".canvas-notice.error")?.textContent.includes("画板刚刚更新")');
    assert.deepEqual(await geometryFrame(), beforeCancel.document.items.find(item => item.id === 'interactive').frame, 'a drag never overwrites a concurrent Agent update');
    await run('document.querySelector("[aria-label=关闭提示]").click()');
    await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');

    const panRevision = (await readCanvas(entry.path)).revision, boardBeforePan = await boardRect();
    const blank = await run('(()=>{const r=document.querySelector(".canvas-stage").getBoundingClientRect();return{x:Math.round(r.x+20),y:Math.round(r.y+30)}})()');
    pointer('mouseDown', blank); pointer('mouseMove', { x: blank.x + 62, y: blank.y + 37 }); await delay(80); pointer('mouseUp', { x: blank.x + 62, y: blank.y + 37 });
    const boardAfterPan = await boardRect(); assert.equal(Math.round(boardAfterPan.x - boardBeforePan.x), 62); assert.equal(Math.round(boardAfterPan.y - boardBeforePan.y), 37);
    assert.equal((await readCanvas(entry.path)).revision, panRevision, 'panning changes the viewport, never the document');
    await run('document.querySelector("[aria-label=平移画板]").click()');
    const overHtml = await point('[data-canvas-item=interactive] iframe'); pointer('mouseDown', overHtml); pointer('mouseMove', { x: overHtml.x - 45, y: overHtml.y - 25 }); await delay(80); pointer('mouseUp', { x: overHtml.x - 45, y: overHtml.y - 25 });
    assert.equal(Math.round((await boardRect()).x - boardAfterPan.x), -45, 'hand mode can pan over an iframe');
    await run('document.querySelector("[aria-label=平移画板]").click()'); await run('document.querySelector("[aria-label=适应窗口]").click()');
    await run('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');

    const beforeScroll = await boardRect(), scrollPoint = await point('[data-canvas-item=alignment] .canvas-markdown');
    pointer('mouseMove', scrollPoint); await delay(80);
    await run(`window.canvasWheelLog=[];document.addEventListener('wheel',e=>queueMicrotask(()=>canvasWheelLog.push({target:e.target.tagName,classes:e.target.className,prevented:e.defaultPrevented,dy:e.deltaY})))`);
    win.webContents.sendInputEvent({ type: 'mouseWheel', x: scrollPoint.x, y: scrollPoint.y, deltaY: -150, deltaX: 0, canScroll: true });
    await until('document.querySelector("[data-canvas-item=alignment] .canvas-markdown").scrollTop>0');
    assert.deepEqual(await boardRect(), beforeScroll, 'scrolling a document does not pan the canvas');
    assert.equal(childFrame().routingId, frameId); assert.equal(await childFrame().executeJavaScript('document.querySelector("button").textContent'), '1');
    const buttonInFrame = await childFrame().executeJavaScript('(()=>{const r=document.querySelector("button").getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()');
    const htmlButton = await run(`(()=>{const r=document.querySelector('[data-canvas-item=interactive] iframe').getBoundingClientRect(),z=new DOMMatrix(getComputedStyle(document.querySelector('.canvas-plane')).transform).a;return{x:Math.round(r.x+${buttonInFrame.x}*z),y:Math.round(r.y+${buttonInFrame.y}*z)}})()`);
    // Offscreen sendInputEvent does not route into cross-process child frames.
    // Verify the host hit target, then exercise the same coordinates inside the frame.
    assert.equal(await run(`document.elementFromPoint(${htmlButton.x},${htmlButton.y})?.tagName`), 'IFRAME');
    assert.equal(await run('getComputedStyle(document.querySelector("[data-canvas-item=interactive] iframe")).pointerEvents'), 'auto');
    assert.equal(await childFrame().executeJavaScript(`document.elementFromPoint(${buttonInFrame.x},${buttonInFrame.y})?.tagName`), 'BUTTON');
    await childFrame().executeJavaScript(`document.elementFromPoint(${buttonInFrame.x},${buttonInFrame.y}).click()`);
    assert.equal(await childFrame().executeJavaScript('document.querySelector("button").textContent'), '2', 'interactive content stays reachable after panning and resizing');
    await require('./helpers/canvas-presentation.cjs')({ run, until, win, delay, pointer, readCanvas, path: entry.path, childFrame });
    await require('./helpers/canvas-expand.cjs')({ run, until, win, delay, pointer, point, readCanvas, design, path: entry.path, childFrame });
    const afterGeometry = await readCanvas(entry.path);
    await design({ action: 'update', path: entry.path, expected_revision: afterGeometry.revision, layout: true, canvas: { title: beforeGeometry.document.title }, remove: ['alignment'], upsert: beforeGeometry.document.items });
    await until('document.querySelectorAll("[data-canvas-item]").length===3 && !document.querySelector("[data-canvas-item=alignment]")');
    await run('document.querySelector("[data-canvas-item=interactive]").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))');
    await run('canvasSend("Make the selected part concise")');
    const prompt = await run('lastCanvasPrompt'); assert.equal(prompt.text, 'Make the selected part concise'); assert.match(prompt.context[0].content, /design\(action=inspect/); assert.match(prompt.context[0].content, /selectedId.*interactive/); assert.match(prompt.context[0].content, /viewport/);
    await run('document.querySelector("[aria-label=更多操作]").click()'); await clickText('提取所选内容为组件'); await until('document.body.textContent.includes("已保存到组件")');
    const components = await run('JSON.parse(localStorage.getItem("cardbush.html_components.v1"))'); assert.ok(components.items.some(item => item.html?.includes('Canvas interaction')));
    const md = (await readCanvas(entry.path)).document.items.find(item => item.kind === 'file' && item.source.endsWith('.md'));
    await run(`document.querySelector('[data-canvas-item="${md.id}"] [aria-label="引用局部"]').click()`); await until('!!document.querySelector(".canvas-file-backdrop .inspector-region-hit-area")');
    const paragraph = await point('.canvas-file-backdrop .markdown-content p'); pointer('mouseMove', paragraph); pointer('mouseDown', paragraph); pointer('mouseUp', paragraph);
    await until('Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="引用到画板"&&!b.disabled)');
    await clickText('引用到画板'); await until('document.querySelectorAll("[data-canvas-item]").length===4 && !document.querySelector(".canvas-file-backdrop")');
    const excerpt = (await readCanvas(entry.path)).document.items.find(item => item.reference); assert.equal(excerpt.reference.source, md.source); assert.match(excerpt.reference.text, /Select this paragraph/); assert.equal(excerpt.reference.mode, 'snapshot');
    const png = nativeImage.createFromBuffer(await readFile(excerpt.source)); assert.ok(!png.isEmpty());
    await run('document.querySelector("[aria-label=更多操作]").click()'); await clickText('保存到文件夹'); await until('document.querySelector(".canvas-notice")?.textContent.includes("已保存到")');
    const exported = (await run('document.querySelector(".canvas-notice").textContent')).replace(/^已保存到 /, ''); assert.ok((await readCanvas(join(exported, 'space.canvas.json'))).document.items.find(item => item.reference).source.startsWith('assets/'));
    await delay(300); await writeFile(resolve('tmp/creation-canvas-populated.png'), (await win.webContents.capturePage()).toPNG());
    await writeFile(join(directory, 'sample.md'), '# Updated by an agent\n\nThe same referenced file refreshes in place.');
    await until('document.querySelector(".canvas-stage").textContent.includes("Updated by an agent")');
    assert.equal(childFrame().routingId, frameId, 'a source-file update does not reload unrelated interactive HTML');
    assert.equal(await childFrame().executeJavaScript('document.querySelector("button").textContent'), '2');
    for (const ext of ['docx','pptx','xlsx','pdf']) {
      const data = await design({ action: 'inspect', path: entry.path }); await design({ action: 'update', path: entry.path, expected_revision: data.revision, remove: data.document.items.filter(item=>item.id!=='office').map(item=>item.id), upsert: [{ id:'office',kind:'file',title:ext,source:join(directory,'sample.'+ext),frame:{x:40,y:40,width:1200,height:800}}] });
      await until(`document.querySelectorAll('[data-canvas-item]').length===1 && document.querySelector('[data-canvas-source$=".${ext}"]')`);
      await until('document.querySelector("[data-canvas-item=office] .right-inspector-preview.ready") && !document.querySelector(".inspector-preview-error")', 30000);
      if (ext === 'pdf') await until('document.querySelector("[data-canvas-item=office]").textContent.includes("Real PDF")');
      else if (ext === 'xlsx') await until(`document.querySelector('[data-canvas-item=office] webview').executeJavaScript('document.querySelector("[data-region-grid]")?.cardbushRegionCells?.().some(c=>c.text==="Alpha")')`, 30000);
      else await until(`document.querySelector('[data-canvas-item=office] webview').executeJavaScript('document.body.innerText').then(text=>text.includes(${JSON.stringify(ext === 'docx' ? 'Real Word document' : 'Real slides')}))`, 30000);
      assert.equal(await run('document.querySelector(".canvas-notice.error")?.textContent||""'), '');
      await run('document.querySelector(".canvas-present-button").click()');
      await until('!!document.querySelector(".canvas-presentation [data-presentation-item=office] .right-inspector-preview.ready") && !document.querySelector(".canvas-presentation .inspector-preview-error")', 30000);
      if (ext === 'pdf') await until('document.querySelector(".canvas-presentation").textContent.includes("Real PDF")');
      else if (ext === 'xlsx') await until(`document.querySelector('.canvas-presentation webview').executeJavaScript('document.querySelector("[data-region-grid]")?.cardbushRegionCells?.().some(c=>c.text==="Alpha")')`, 30000);
      else await until(`document.querySelector('.canvas-presentation webview').executeJavaScript('document.body.innerText').then(text=>text.includes(${JSON.stringify(ext === 'docx' ? 'Real Word document' : 'Real slides')}))`, 30000);
      assert.equal(await run('document.querySelector(".canvas-presentation").dataset.layout'), 'canvas');
      assert.equal(await run('document.querySelectorAll(".canvas-presentation [aria-label=下一页]").length'), 0, 'one whole canvas has no region pagination controls');
      await run('document.querySelector(".canvas-presentation [aria-label=退出演示]").click()');
      await until('!document.querySelector(".canvas-presentation")');
    }
    const reloaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve)); win.reload(); await reloaded; await until('!!document.querySelector("[data-canvas-item=office]")');
    assert.equal((await selected()).path, entry.path);
    await run(`canvasStore.createCanvas(${JSON.stringify({ format: 'cardbush-canvas', version: 1, title: 'Welcome layout', width: 1440, height: 960, background: '#181818', items: [html] })})`);
    await until('document.querySelector("[data-canvas-item=interactive]") && document.querySelector("[aria-label=画板名称]").value==="Welcome layout"');
    await run('document.querySelector("[aria-label=更多操作]").click()'); await clickText('用作新会话布局'); await until('document.body.textContent.includes("已应用到新会话布局")');
    const layout = await run('JSON.parse(localStorage.getItem("cardbush.html_components.v1")).welcomeLayout');
    assert.ok(layout.items.some(item=>item.componentId==='system-input'&&item.composerDock==='bottom')); assert.equal(layout.items.length,2);
    await require('./helpers/canvas-markdown-workspace.cjs')({ run, until, clickText, selected, win, teams, directory });
    await require('./helpers/canvas-development-desk.cjs')({ run, until, clickText, selected, win, teams, directory, design });
    console.log('PASS: canvas previews and geometry; shared Markdown editing, autosave, line context, document switching, conflicts and Team round trip');
  } catch (error) { await writeFile(resolve('tmp/creation-canvas-failure.png'), (await win.webContents.capturePage()).toPNG()); console.error('Pointer diagnostic', await run('window.pointerLog?.slice(-8)')); console.error('Wheel diagnostic', await run('window.canvasWheelLog')); console.error('Resize diagnostic', await run('window.canvasResizeLog')); throw error; } finally { win.destroy(); }
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
