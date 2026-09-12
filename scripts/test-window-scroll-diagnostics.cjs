const electron = require('electron');
if (typeof electron === 'string') {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; delete env.NODE_OPTIONS; delete env.CARDBUSH_WINDOW_SCROLL_DEBUG;
  for (const args of [[], ['--quit-fixture']]) {
    const result = require('node:child_process').spawnSync(electron, [__filename, ...args], { env, stdio: 'inherit', windowsHide: true, timeout: 20000 });
    if (result.error) console.error(result.error);
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  process.exit(0);
}
const { app, BrowserWindow, ipcMain } = electron;
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { WindowScrollDiagnostics } = require('../dist-electron/windowScrollDiagnostics.js');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
const directory = fs.mkdtempSync(path.join(root, 'tmp', 'window-scroll-log-test-'));
app.setPath('userData', path.join(directory, 'profile'));
// Report native event-handler failures as test failures instead of opening
// Electron's blocking main-process error dialog in the isolated test app.
process.on('uncaughtException', error => { console.error(error); app.exit(1); });
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(root, 'dist-electron/preload.js'), sandbox: true, contextIsolation: true,
  } });
  const run = source => win.webContents.executeJavaScript(source);
  const originalBlurListeners = new Set(win.listeners('blur'));
  let diagnostic = new WindowScrollDiagnostics(win, directory);
  assert.equal(diagnostic.config.expiresAt, 0, 'ordinary launch stays disabled');
  fs.writeFileSync(path.join(directory, 'window-scroll-debug.json'), JSON.stringify({ enabled: true, expiresAt: new Date(Date.now() + 60000).toISOString() }));
  diagnostic = new WindowScrollDiagnostics(win, directory);
  const diagnosticBlurListener = win.listeners('blur').find(listener => !originalBlurListeners.has(listener));
  assert.ok(diagnosticBlurListener, 'enabled diagnostics install a blur listener');
  if (process.argv.includes('--quit-fixture')) {
    await win.loadURL('data:text/html,<p>Quit with diagnostics enabled</p>');
    const contents = win.webContents;
    app.once('will-quit', () => {
      assert.ok(win.isDestroyed(), 'app.quit destroys the instrumented window');
      assert.equal(contents.listenerCount('did-finish-load'), 0, 'quit removes renderer subscriptions');
      assert.doesNotThrow(() => diagnostic.dispose(), 'cleanup after native quit is idempotent');
      console.log('Window diagnostic shutdown passed: native app.quit with capture enabled.');
    });
    app.quit();
    return;
  }
  ipcMain.handle('debug:window-scroll-config', () => diagnostic.config);
  ipcMain.handle('debug:append-log', (_event, scope, payload) => {
    assert.equal(scope, 'window-scroll'); return diagnostic.append(payload);
  });
  await win.loadURL('data:text/html,<p>Diagnostic bridge fixture</p>');
  const config = await run('cardbushDesktop.windowScrollDiagnosticConfig()');
  assert.equal(config.runId, diagnostic.config.runId, 'production preload exposes the capture configuration');
  await run('window.nativeEvents = []; window.stopNativeCapture = cardbushDesktop.onWindowScrollDiagnosticEvent(event => nativeEvents.push(event)); void 0');
  win.emit('blur');
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.ok((await run('nativeEvents')).some(event => event.event === 'blur' && event.contentBounds), 'native geometry crosses the preload bridge');
  await run("cardbushDesktop.writeDebugLog('window-scroll', {source:'renderer', records:[{label:'probe'}]})");
  const entries = fs.readFileSync(config.logPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.ok(entries.some(entry => entry.payload.source === 'native' && entry.payload.event === 'blur'));
  assert.ok(entries.some(entry => entry.payload.source === 'renderer'));
  assert.ok(entries.every(entry => entry.runId === config.runId), 'native and renderer entries share a run ID');
  const contents = win.webContents;
  const closed = once(win, 'closed');
  const rendererDestroyed = once(contents, 'destroyed');
  win.destroy();
  await Promise.all([closed, rendererDestroyed]);
  assert.ok(contents.isDestroyed());
  assert.equal(contents.listenerCount('did-finish-load'), 0, 'renderer listeners are removed after destruction');
  assert.ok(!win.listeners('blur').includes(diagnosticBlurListener), 'window listeners are removed after destruction');
  assert.doesNotThrow(() => { diagnostic.dispose(); diagnostic.dispose(); }, 'late repeated disposal is safe');

  const early = new BrowserWindow({ show: false });
  const earlyContents = early.webContents;
  const earlyBlurListeners = early.listeners('blur');
  const earlyDiagnostic = new WindowScrollDiagnostics(early, directory);
  earlyDiagnostic.dispose(); earlyDiagnostic.dispose();
  assert.deepEqual(early.listeners('blur'), earlyBlurListeners, 'manual disposal removes native subscriptions');
  assert.equal(earlyContents.listenerCount('did-finish-load'), 0, 'manual disposal removes renderer subscriptions');
  early.destroy();

  fs.writeFileSync(path.join(directory, 'window-scroll-debug.json'), JSON.stringify({ enabled: true, expiresAt: new Date(Date.now() + 180).toISOString() }));
  const expiring = new BrowserWindow({ show: false });
  const expiryBlurListeners = expiring.listeners('blur');
  const expiryDiagnostic = new WindowScrollDiagnostics(expiring, directory);
  assert.ok(expiryDiagnostic.config.expiresAt > Date.now(), 'expiry fixture starts enabled');
  await new Promise(resolve => setTimeout(resolve, 250));
  assert.deepEqual(expiring.listeners('blur'), expiryBlurListeners, 'expiry disposes listeners on a live window');
  expiring.destroy();
  assert.doesNotThrow(() => expiryDiagnostic.dispose());
  console.log('Window diagnostic bridge passed: native geometry/preload, async logs, destroy before cleanup, repeated cleanup and expiry.');
}).then(() => { if (!process.argv.includes('--quit-fixture')) app.exit(0); }).catch(error => { console.error(error); app.exit(1); });
