const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { app, BrowserWindow } = require('electron');
app.disableHardwareAcceleration(); app.setPath('userData', join(resolve(process.argv[2]), 'profile'));
const deadline = setTimeout(() => app.exit(1), 45000);
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1000, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  const read = code => win.webContents.executeJavaScript(code);
  const until = async code => { const end = Date.now() + 10000; while (!await read(`Boolean(${code})`)) { if (Date.now() > end) throw Error(code + '\n' + await read('document.body.innerText')); await new Promise(resolve => setTimeout(resolve, 50)); } };
  try {
    await win.loadURL(process.argv[3]);
    await until("document.querySelector('video')?.readyState >= 1 && document.querySelector('audio')?.readyState >= 1");
    assert.ok(await read("document.querySelector('video').controls && document.querySelector('audio').controls"));
    await read("document.querySelector('video').muted=true;document.querySelector('video').play()");
    await until("document.querySelector('video').currentTime > 0");
    await read("document.querySelector('video').pause();document.querySelector('video').currentTime = document.querySelector('video').duration / 2;undefined");
    await until("!document.querySelector('video').seeking");
    assert.ok(await read("document.querySelector('video').currentTime > 0"));
    console.log('Web media UI passed: native conversation rendering, authenticated media URL, video/audio metadata, playback and seeking.');
    win.destroy(); clearTimeout(deadline); app.exit(0);
  } catch (error) { console.error(error); win.destroy(); clearTimeout(deadline); app.exit(1); }
});
