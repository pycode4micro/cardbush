const { app, BrowserWindow, ipcMain } = require('electron');
const { writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const assert = require('node:assert/strict');
const { UsageLedger } = require('../dist-electron/usageLedger.js');
const prefix = join(tmpdir(), 'cardbush-usage-electron-');
const root = resolve(process.argv[2]);
assert.ok(root.startsWith(prefix));
app.setPath('userData', join(root, 'profile'));
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  let ledger, win, status = 0;
  try {
    const preload = join(root, 'preload.cjs');
    writeFileSync(preload, "const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('usage',()=>ipcRenderer.invoke('usage-test'));\n");
    ledger = new UsageLedger(join(root, 'usage', 'ledger.sqlite'));
    ledger.record({ id: 'reported', sessionId: 'fixture', model: 'fixture', recordedAt: new Date().toISOString(), inputTokens: 20, outputTokens: 5 });
    ipcMain.handle('usage-test', () => ledger.snapshot());
    win = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await win.loadURL('data:text/html,<html><body>Usage IPC fixture</body></html>');
    const snapshot = await win.webContents.executeJavaScript('usage()');
    assert.equal(snapshot.totalTokens, 25);
    assert.equal(snapshot.activity[0].tokens, 25);
    console.log('Electron SQLite and isolated renderer IPC usage read passed.');
  } catch (error) { console.error(error); status = 1; }
  finally { win?.destroy(); ledger?.close(); app.exit(status); }
});
