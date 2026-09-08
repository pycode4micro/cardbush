const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, readdirSync } = require('node:fs');
const { resolve, join, sep } = require('node:path');
const { tmpdir } = require('node:os');
const electron = require('electron');

const parent = resolve(tmpdir());
if (typeof electron === 'string') {
  const root = mkdtempSync(join(parent, 'cardbush-delivery-test-'));
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const child = require('node:child_process').spawnSync(electron, [__filename, root], {
    env, stdio: 'inherit', windowsHide: true, timeout: 25_000,
  });
  const completed = existsSync(join(root, 'passed'));
  assert.ok(root.startsWith(parent + sep + 'cardbush-delivery-test-'));
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (child.error) console.error(child.error);
  process.exit(child.status === 0 && completed ? 0 : 1);
}
const { app, BrowserWindow, crashReporter } = electron;
const root = resolve(process.argv[2]);
assert.ok(root.startsWith(parent + sep + 'cardbush-delivery-test-'));
app.setPath('userData', root);
const dumps = join(root, 'crashes');
mkdirSync(dumps);
app.setPath('crashDumps', dumps);
crashReporter.start({ uploadToServer: false, productName: 'CardBush renderer test' });
assert.equal(crashReporter.getUploadToServer(), false);
app.on('window-all-closed', () => {});
const { sendToLiveRenderer } = require('../dist-electron/rendererDelivery.js');
const deadline = setTimeout(() => { console.error('Renderer delivery test timed out'); app.exit(1); }, 20_000);

app.whenReady().then(async () => {
  // Node is enabled only in this data-only fixture so process.crash() can produce
  // an actual native dump. Production window preferences are unchanged.
  let window = new BrowserWindow({ show: false, webPreferences: { sandbox: false, nodeIntegration: true, contextIsolation: false } });
  try {
    await window.loadURL('data:text/html,<p>Isolated renderer lifecycle fixture</p>');
    assert.equal(sendToLiveRenderer(window, 'capabilities:changed'), true);
    const gone = new Promise(resolve => window.webContents.once('render-process-gone', (_event, details) => resolve(details)));
    // Crash only this test-owned renderer to exercise real Chromium frame disposal.
    void window.webContents.executeJavaScript('process.crash()').catch(() => undefined);
    const details = await gone;
    assert.equal(details.reason, 'crashed');
    assert.equal(window.isDestroyed(), false, 'the BrowserWindow still exists after renderer crash');
    assert.equal(window.webContents.isDestroyed(), false, 'so checking window/contents destruction alone is insufficient');
    for (let i = 0; i < 20; i++) assert.equal(sendToLiveRenderer(window, 'capabilities:changed'), false);
    assert.equal(sendToLiveRenderer(window, 'terminal:data', { data: 'late terminal output' }), false);
    const dumpDeadline = Date.now() + 5_000;
    while (!readdirSync(dumps, { recursive: true }).some(file => String(file).endsWith('.dmp')) && Date.now() < dumpDeadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(readdirSync(dumps, { recursive: true }).some(file => String(file).endsWith('.dmp')), 'native crash stack is saved locally');
    window.destroy();
    assert.equal(sendToLiveRenderer(window, 'capabilities:changed'), false);
    // A new test-owned window represents an explicit reopen, not auto-recovery.
    window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
    await window.loadURL('data:text/html,<p>Explicitly reopened window</p>');
    assert.equal(sendToLiveRenderer(window, 'capabilities:changed'), true);
    console.log('Real Electron delivery passed: live frame, native crash with local dump and uploads disabled, late notifications, close and explicit reopen.');
    writeFileSync(join(root, 'passed'), 'All renderer lifecycle assertions completed.');
  } finally {
    if (!window.isDestroyed()) window.destroy();
    clearTimeout(deadline);
  }
}).then(() => app.exit(0)).catch(error => { console.error(error); app.exit(1); });
