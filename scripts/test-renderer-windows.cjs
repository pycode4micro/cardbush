// Mount the actual split production entry, isolated from the product profile.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const electron = require('electron');

if (typeof electron === 'string') {
  const parent = path.resolve('tmp');
  fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'renderer-windows-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  try {
    const result = require('node:child_process').spawnSync(electron, [__filename, directory], {
      env, windowsHide: true, stdio: 'inherit', timeout: 60000,
    });
    if (result.error) console.error(result.error);
    process.exitCode = result.status ?? 1;
  } finally {
    assert.ok(directory.startsWith(parent + path.sep + 'renderer-windows-'));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
} else {
  void run().catch(error => { console.error(error); electron.app.exit(1); });
}

async function run() {
  const { app, BrowserWindow, ipcMain, session } = electron;
  app.setPath('userData', path.join(path.resolve(process.argv[2]), 'profile'));
  app.disableHardwareAcceleration();
  app.on('window-all-closed', () => {});
  const deadline = setTimeout(() => app.exit(1), 50000);
  await app.whenReady();
  // No provider or external website is involved in this loading test.
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    done({ cancel: !/^(file|data|blob):/.test(details.url) });
  });
  const errors = [];
  ipcMain.handle('window:is-visible', () => true);
  ipcMain.handle('debug:append-log', (_event, _category, payload) => { errors.push(payload); return ''; });
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  for (const [mode, selector] of [
    ['main', '.app'], ['cardling', '.cardling-desktop'], ['shadow', '.shadow-window-shell'],
  ]) {
    const win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
      ...(mode === 'cardling' ? { preload: path.resolve('dist-electron/preload.js') } : {}),
    } });
    const failures = [];
    win.webContents.on('console-message', ({ level, message }) => {
      if (level === 'error' && /Uncaught|ReferenceError|SyntaxError|TypeError|Minified React error/.test(message)) failures.push(message);
    });
    if (mode === 'cardling') {
      win.webContents.on('dom-ready', () => win.webContents.send('cardling:state', {
        enabled: true, language: 'en', theme: 'bright', settings: { size: 'normal', opacity: 1, motion: 'off' },
        status: 'complete', sending: false, queuedMessageCount: 0, pendingInteraction: false,
        activeChangeCount: 0, activeChangeFileCount: 0, error: null,
        miniChat: { title: 'Fixture', lastUser: '', lastAssistant: 'Ready.' },
      }));
    }
    try {
      await win.loadFile(path.resolve('dist/index.html'), { query: { window: mode } });
      const end = Date.now() + 8000;
      while (!await win.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) {
        assert.deepEqual(failures, []);
        if (Date.now() >= end) throw Error(`Timed out mounting ${mode}: ${await win.webContents.executeJavaScript('document.body.innerText')}`);
        await pause(25);
      }
      await pause(100);
      assert.deepEqual(failures, [], `${mode} must evaluate its split chunks without runtime errors`);
      if (mode === 'cardling') assert.equal(await win.webContents.executeJavaScript('document.documentElement.lang'), 'en',
        'the early host snapshot must reach the deferred companion');
    } finally {
      win.destroy();
    }
  }
  assert.deepEqual(errors, []);
  clearTimeout(deadline);
  console.log('Production window entries passed: workspace, companion, shadow and early companion state.');
  app.exit(0);
}
