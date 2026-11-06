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
    ['main', '.app'], ['shadow', '.shadow-window-shell'],
  ]) {
    const win = new BrowserWindow({ show: false, width: 1100, height: 800, webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
    } });
    const failures = [];
    win.webContents.on('console-message', ({ level, message }) => {
      if (level === 'error' && /Uncaught|ReferenceError|SyntaxError|TypeError|Minified React error/.test(message)) failures.push(message);
    });
    try {
      await win.loadFile(path.resolve('dist/index.html'), { query: { window: mode } });
      const end = Date.now() + 8000;
      while (!await win.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(selector)}))`)) {
        assert.deepEqual(failures, []);
        if (Date.now() >= end) throw Error(`Timed out mounting ${mode}: ${await win.webContents.executeJavaScript('document.body.innerText')}`);
        await pause(25);
      }
      await pause(100);
      if (mode === 'main') {
        const read = code => win.webContents.executeJavaScript(code).catch(cause => {
          throw new Error(`Production window script failed: ${code}; renderer errors: ${failures.join('\n')}`, { cause });
        });
        const until = async code => { const end = Date.now() + 6000; while (!await read(code)) { if (Date.now() >= end) throw Error('Your Friends production integration timed out: ' + code); await pause(25); } };
        await until('document.querySelector("[data-nav-section=your-friends]")');
        await read('document.querySelector("[data-nav-section=your-friends]").click();void 0');
        await until('document.querySelector(".your-friends[data-phase=open]")');
        assert.equal(await read('document.querySelector(".desktop-shell").inert'), true);
        assert.equal(await read('!!document.querySelector(".window-frame")'), true, 'native window frame remains mounted');
        assert.equal(await read('!!document.querySelector(".friends-header nav")'), false, 'onboarding does not expose completed-profile navigation');
        await read('document.querySelector(".friends-back").click();void 0');
        await until('!document.querySelector(".your-friends")');
        assert.equal(await read('document.querySelector(".desktop-shell").inert'), false);
        assert.equal(await read('document.activeElement.dataset.navSection'), 'your-friends');
        // Startup loading uses an isolated saved profile. Settings gestures are
        // covered by test-your-friends-ui after its real onboarding sequence.
        await read(`localStorage.setItem('cardbush_your_friends_v1', JSON.stringify({ version: 2,
          id: 'primary-friend', name: '', startup: true, motion: true, tone: 'lilac',
          introduction: { step: 0, answers: {} }, delegation: { beforeExecution: 'ask', report: 'always' }, events: [] })); void 0`);
        await win.reload();
        await until('document.querySelector(".your-friends[data-phase=open]")');
        assert.ok(await read('document.querySelector(".friends-onboarding")'), 'saved default startup resumes introduction');
        await read('document.querySelector(".friends-back").click();void 0');
        await until('!document.querySelector(".your-friends")');
        assert.equal(await read('document.activeElement.dataset.navSection'), 'your-friends', 'default entry has a valid return focus');
      }
      assert.deepEqual(failures, [], `${mode} must evaluate its split chunks without runtime errors`);
    } finally {
      win.destroy();
    }
  }
  assert.deepEqual(errors, []);
  clearTimeout(deadline);
  console.log('Production window entries passed: workspace, Your Friends entry/return/default startup, and Shadow.');
  app.exit(0);
}
