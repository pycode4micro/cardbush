// Actual renderer animations and streaming, isolated from the product profile.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const electron = require('electron');
if (typeof electron === 'string') {
  const parent = path.resolve('tmp'); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'window-visibility-'));
  buildFixture(directory).then(() => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS;
    const result = require('node:child_process').spawnSync(electron, [__filename, directory], {
      env, windowsHide: true, stdio: 'inherit', timeout: 60000,
    });
    if (result.error) console.error(result.error);
    process.exitCode = result.status ?? 1;
  }).catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    assert.ok(directory.startsWith(parent + path.sep + 'window-visibility-'));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
} else {
  void runRendererFixture();
}

async function buildFixture(directory) {
  const { build } = await import('vite');
  const file = name => JSON.stringify(path.resolve(name).replaceAll('\\', '/'));
  const source = `import React from 'react'; import {createRoot} from 'react-dom/client';
import {StarWordmark} from ${file('src/features/chat/StarWordmark.tsx')};
import {installWindowVisibility,isWindowVisible} from ${file('src/shared/windowVisibility.ts')};
import {createFrameStreamBuffers} from ${file('src/features/chatMessages/transcript/frameStreamBuffer.ts')};
import ${file('src/styles/appearance.css')};
const ipc=window.require('electron').ipcRenderer;
window.cardbushDesktop={isWindowVisible:()=>ipc.invoke('window:is-visible'),onWindowVisibilityChanged:fn=>{
  const handler=(_,visible)=>fn(visible);ipc.on('window:visibility-changed',handler);
  return ()=>ipc.removeListener('window:visibility-changed',handler);
}};
const stop=installWindowVisibility();
window.paints=0;window.workTicks=0;window.received='';
const original=CanvasRenderingContext2D.prototype.clearRect;
CanvasRenderingContext2D.prototype.clearRect=function(...args){if(this.canvas.classList.contains('welcome-star-wordmark'))window.paints++;return original.apply(this,args)};
const timer=setInterval(()=>window.workTicks++,20);
const stream=createFrameStreamBuffers(delta=>window.received+=delta,{replace:text=>window.received=text});
const route={turnId:'turn',messageId:'message',segmentId:'segment'};
window.pushStream=text=>stream.push(text,route);
const root=createRoot(document.getElementById('root'));
root.render(<StarWordmark/>);
window.fixture={visible:isWindowVisible,listeners:()=>ipc.listenerCount('window:visibility-changed'),
  dispose:()=>{root.unmount();stream.dispose();clearInterval(timer);stop();}};`;
  const result = await build({ configFile: false, logLevel: 'silent', define: { 'process.env.NODE_ENV': '"production"' }, plugins: [{
    name: 'visibility-fixture', resolveId: id => id.endsWith('__window_visibility__.tsx') ? '\0visibility.tsx' : undefined,
    load: id => id === '\0visibility.tsx' ? source : undefined,
  }], build: { outDir: directory, emptyOutDir: false, minify: false,
    lib: { entry: path.resolve('__window_visibility__.tsx'), formats: ['iife'], name: 'VisibilityFixture' } } });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
  const entry = outputs.find(item => item.type === 'chunk' && item.isEntry);
  fs.writeFileSync(path.join(directory, 'index.html'), `<!doctype html><html data-motion-preference="off"><head><meta charset="utf-8">
${outputs.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => `<link rel="stylesheet" href="${item.fileName}">`).join('')}
<style>.welcome-star-wordmark{width:440px;height:120px}.spinner{width:40px;height:40px;background:red;animation:spin 1s linear infinite}.spinner::before{content:'';animation:spin 1s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}</style>
</head><body><div id="root"></div><div class="spinner"></div><script src="${entry.fileName}"></script></body></html>`);
}

async function runRendererFixture() {
  const { app, BrowserWindow, ipcMain } = electron;
  const { installWindowVisibilityEvents, isWindowVisible } = require('../dist-electron/windowVisibility.js');
  const directory = path.resolve(process.argv[2]);
  app.setPath('userData', path.join(directory, 'profile'));
  app.disableHardwareAcceleration();
  const deadline = setTimeout(() => app.exit(1), 50000);
  await app.whenReady();
  const win = new BrowserWindow({ show: false, width: 800, height: 500, webPreferences: {
    nodeIntegration: true, contextIsolation: false, backgroundThrottling: false, offscreen: true,
  } });
  installWindowVisibilityEvents(win);
  ipcMain.handle('window:is-visible', () => isWindowVisible(win));
  const run = code => win.webContents.executeJavaScript(code);
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const until = async code => {
    const end = Date.now() + 5000;
    while (!await run(code)) { if (Date.now() > end) throw Error('Timed out: ' + code); await pause(20); }
  };
  const setVisible = async value => {
    // Isolated offscreen renderer: exercise the real IPC without raising a window.
    win.webContents.send('window:visibility-changed', value);
    await until(`window.fixture?.visible()===${value}`);
  };
  try {
    await win.loadFile(path.join(directory, 'index.html'));
    await until("window.fixture && document.querySelector('canvas') && document.documentElement.dataset.windowVisible==='false'");
    assert.equal(await run('document.visibilityState'), 'visible', 'reproduce the unthrottled renderer visibility gap');
    assert.equal(await run("getComputedStyle(document.querySelector('.spinner')).animationPlayState"), 'paused');
    assert.equal(await run("getComputedStyle(document.querySelector('.spinner'),'::before').animationPlayState"), 'paused');
    const base = await run('window.paints');
    await setVisible(true); await until(`window.paints>${base+2}`);
    assert.equal(await run("getComputedStyle(document.querySelector('.spinner')).animationPlayState"), 'running');
    await run("window.pushStream('结果'.repeat(10000))");
    await setVisible(false);
    await until('window.received.length===20000');
    await pause(80);
    const stopped = await run('({paints:window.paints,ticks:window.workTicks})');
    await run("window.pushStream('后台结果'.repeat(1000))");
    await until('window.received.length===24000');
    await pause(220);
    assert.equal(await run('window.paints'), stopped.paints, 'decorative canvas is idle while hidden');
    assert.ok(await run(`window.workTicks>${stopped.ticks+3}`), 'background timers continue while UI animation is paused');
    for (let index = 0; index < 30; index++) { await setVisible(true); await setVisible(false); }
    assert.equal(await run('window.fixture.listeners()'), 1, 'native subscription count stays constant');
    await setVisible(true); await until(`window.paints>${stopped.paints+2}`);
    await run('window.fixture.dispose()');
    assert.equal(await run('window.fixture.listeners()'), 0);
    const disposed = await run('window.paints'); await pause(120);
    assert.equal(await run('window.paints'), disposed, 'unmount releases the canvas animation loop');
    console.log('Window visibility renderer passed: hidden CSS/canvas pause, background timers and streaming continue, 30 hide/show cycles, resume and disposal.');
    win.destroy(); clearTimeout(deadline); app.exit(0);
  } catch (error) { console.error(error); clearTimeout(deadline); app.exit(1); }
}
