const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const root = path.resolve(process.argv[2]);
assert.ok(path.basename(root).startsWith('cardbush-maintenance-test-'));
app.setPath('userData', path.join(root, 'profile'));
app.setPath('sessionData', path.join(root, 'profile'));
fs.mkdirSync(app.getPath('userData'), { recursive: true });
app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/cached') { res.setHeader('Cache-Control', 'public, max-age=3600'); res.end('x'.repeat(200000)); }
    else { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Isolated cache fixture</title>'); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const win = new BrowserWindow({ show: false, webPreferences: { partition: 'persist:cache-fixture', sandbox: true } });
  try {
    await win.loadURL(url);
    await win.webContents.executeJavaScript(`(async () => {
      localStorage.setItem('draft', 'keep draft');
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('fixture', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('drafts');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => { const db = request.result, tx = db.transaction('drafts', 'readwrite'); tx.objectStore('drafts').put('keep record', 'draft'); tx.oncomplete = () => { db.close(); resolve(); }; };
      });
      await (await fetch('/cached')).text();
    })()`);
    const session = win.webContents.session;
    await session.cookies.set({ url, name: 'login', value: 'keep login', expirationDate: Date.now() / 1000 + 3600 });
    const { clearBrowserCaches } = require('../dist-electron/cacheMaintenance.js');
    const result = await clearBrowserCaches([session]);
    assert.deepEqual(result.errors, []);
    assert.equal((await session.cookies.get({ url, name: 'login' }))[0].value, 'keep login');
    assert.equal(await win.webContents.executeJavaScript("localStorage.getItem('draft')"), 'keep draft');
    assert.equal(await win.webContents.executeJavaScript(`new Promise((resolve, reject) => { const request = indexedDB.open('fixture', 1); request.onerror = () => reject(request.error); request.onsuccess = () => { const db = request.result, value = db.transaction('drafts').objectStore('drafts').get('draft'); value.onsuccess = () => { resolve(value.result); db.close(); }; }; })`), 'keep record');
    console.log('CACHE_PROFILE_PRESERVED');
  } finally { win.destroy(); await new Promise(resolve => server.close(resolve)); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
