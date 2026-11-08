// Exercise the production preload and IPC handler without touching workspace or user logs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const electron = require('electron');
const project = path.resolve(__dirname, '..');

if (typeof electron === 'string') {
  runIsolated().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  verify().catch(error => { console.error(error); electron.app.exit(1); });
}

async function runIsolated() {
  const parent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'cardbush-diagnostics-'));
  const env = { ...process.env, APPDATA:root, LOCALAPPDATA:root, USERPROFILE:root, HOME:root,
    CARDBUSH_DEVELOPMENT_RUNTIME:'1', CARDBUSH_ELECTRON_DEV_SERVER_URL:'' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  try {
    const result = require('node:child_process').spawnSync(electron, [__filename], {cwd:root, env, windowsHide:true, stdio:'inherit', timeout:60000});
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    assert.equal(path.dirname(root), parent);
    assert.ok(path.basename(root).startsWith('cardbush-diagnostics-'));
    await fs.promises.rm(root, {recursive:true, force:true, maxRetries:10, retryDelay:150});
  }
}

async function verify() {
  const {app, BrowserWindow, ipcMain, Tray} = electron;
  const root = process.cwd();
  const profile = path.join(root, 'profile');
  fs.mkdirSync(profile);
  app.setPath('appData', root); app.setPath('userData', profile); app.setAppPath(project);
  fs.writeFileSync(path.join(profile, 'assistant-resident.json'), JSON.stringify({enabled:true,language:'en'}));
  let trayMenu, append;
  const originalMenu = Tray.prototype.setContextMenu, originalHandle = ipcMain.handle;
  Tray.prototype.setContextMenu = function(menu) { trayMenu = menu; return originalMenu.call(this, menu); };
  ipcMain.handle = function(channel, handler) {
    if (channel === 'debug:append-log') append = handler;
    return originalHandle.call(this, channel, handler);
  };
  require(path.join(project, 'dist-electron/bootstrap.js'));
  ipcMain.handle = originalHandle;
  const wait = async predicate => {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw Error('Timed out waiting for a desktop window');
  };
  const windowFor = mode => wait(() => BrowserWindow.getAllWindows().find(win => {
    const url = win.webContents.getURL();
    return url.startsWith('file:') && new URL(url).searchParams.get('window') === mode && !win.webContents.isLoadingMainFrame();
  }));
  const write = (win, scope, event) => win.webContents.executeJavaScript(
    `window.cardbushDesktop.writeDebugLog(${JSON.stringify(scope)},{event:${JSON.stringify(event)}})`);
  await wait(() => trayMenu);
  trayMenu.items[1].click();
  const capsule = await windowFor('assistant');
  assert.equal(BrowserWindow.getAllWindows().length, 1);
  for (const event of ['connected','user-interrupted','closed']) {
    const file = await write(capsule, 'realtime-voice', event);
    assert.equal(file, path.join(root,'logs','realtime-voice.log'));
    assert.ok(fs.readFileSync(file,'utf8').trim().split('\n').some(line => JSON.parse(line).payload.event === event));
  }
  trayMenu.items[0].click();
  const main = await windowFor(null);
  assert.equal(await write(main,'renderer-lifecycle','workspace'),path.join(root,'logs','renderer-lifecycle.log'));
  const scrollConfig = await main.webContents.executeJavaScript('window.cardbushDesktop.windowScrollDiagnosticConfig()');
  assert.equal(await write(main,'window-scroll','workspace'),scrollConfig.logPath);
  await main.webContents.executeJavaScript("window.cardbushDesktop.openShadowWindow({sessionId:'diagnostics',modelConfig:{id:'fixture'}})");
  const shadow = await windowFor('shadow');
  assert.equal(await write(shadow,'renderer-lifecycle','shadow'),path.join(root,'logs','renderer-lifecycle.log'));
  assert.equal(await write(shadow,'window-scroll','isolated'),undefined);
  assert.equal(await capsule.webContents.executeJavaScript('window.cardbushDesktop.windowScrollDiagnosticConfig()'),undefined);

  const sender = capsule.webContents;
  await sender.executeJavaScript("new Promise(resolve=>{const frame=document.createElement('iframe');frame.onload=()=>resolve(true);frame.src='about:blank';document.body.append(frame)})");
  assert.ok(sender.mainFrame.frames.length);
  assert.throws(() => append({sender, senderFrame:sender.mainFrame.frames[0]},'realtime-voice',{}), /invalid_window_sender/);
  assert.throws(() => append({sender, senderFrame:sender.mainFrame},'unregistered-scope',{}), /invalid_renderer_log_scope/);
  const foreign = new BrowserWindow({show:false});
  try {
    assert.throws(() => append({sender:foreign.webContents, senderFrame:foreign.webContents.mainFrame},'renderer-lifecycle',{}), /invalid_window_sender/);
  } finally { foreign.destroy(); }
  assert.ok(!fs.existsSync(path.join(root,'logs','unregistered-scope.log')));
  await wait(() => main.webContents.executeJavaScript("window.cardbushDesktop.runtimeStartupStatus().then(state=>state.phase==='ready')"));
  console.log('Renderer diagnostics passed for workspace, standalone Assistant and Shadow, with subframe, unowned window and scope isolation.');
  trayMenu.items.at(-1).click();
}
