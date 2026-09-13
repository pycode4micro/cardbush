const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { app, BrowserWindow } = require('electron');
const directory = resolve(process.argv[2]);
app.disableHardwareAcceleration();
app.setPath('userData', join(directory, 'profile'));
app.on('window-all-closed', () => {});
const deadline = setTimeout(() => { console.error('Deferred module checks timed out'); app.exit(1); }, 55_000);
app.whenReady().then(async () => {
  async function page() {
    const window = new BrowserWindow({ show: false, width: 1000, height: 700,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    const read = code => window.webContents.executeJavaScript(code);
    const until = async code => {
      const end = Date.now() + 6000;
      while (!await read(code)) {
        if (Date.now() > end) throw new Error(`Timed out: ${code}; ${await read('document.body.innerText')}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    await window.loadFile(join(directory, 'index.html'));
    await until('typeof window.openFeature === "function"');
    return { window, read, until };
  }
  try {
    const old = await page();
    const rebuilt = new Promise(resolve => process.once('message', resolve));
    process.send('rebuild');
    assert.equal(await rebuilt, 'rebuilt');
    await old.read("window.openFeature('diff')");
    await old.until("!!document.querySelector('.diff-lines.syntax-highlighted')");
    assert.equal(await old.read('window.syntaxBuildVersion'), 1, 'an open page must still load its own version after an update');
    assert.deepEqual(await old.read('window.fatalErrors'), []);
    old.window.destroy();

    for (const feature of ['diff', 'source', 'markdown']) {
      const { window, read, until } = await page();
      let blockedRequests = 0;
      window.webContents.session.webRequest.onBeforeRequest((details, done) => {
        const blocked = details.url.split('?')[0].endsWith('.js');
        if (blocked) blockedRequests++;
        done({ cancel: blocked });
      });
      await read(`window.openFeature('${feature}')`);
      await until("!!document.querySelector('.deferred-module-notice')");
      assert.ok(blockedRequests > 0, 'must exercise actual failed module requests');
      assert.equal(await read("document.querySelector('#draft').value"), '未发送的草稿');
      assert.equal(await read('window.mounts'), 1, 'module failure must not remount the workspace');
      const ticks = await read("Number(document.querySelector('#live span').textContent)");
      await until(`Number(document.querySelector('#live span').textContent) > ${ticks}`);
      assert.deepEqual(await read('window.fatalErrors'), []);
      assert.deepEqual(await read('window.unhandled'), []);
      assert.ok((await read('window.diagnostics')).some(item => item.stage === 'deferred-module-unavailable'));
      if (feature === 'diff') {
        assert.match(await read("document.querySelector('.diff-lines').textContent"), /before = 1/);
        assert.match(await read("document.querySelector('.diff-lines').textContent"), /after = 2/);
        assert.equal(await read("document.querySelector('.diff-line.deletion .diff-line-number.old').textContent"), '8');
        assert.equal(await read("document.querySelector('.diff-line.addition .diff-prefix').textContent"), '+');
      } else if (feature === 'source') {
        assert.match(await read("document.querySelector('.source-code-lines').textContent"), /const preview = 42/);
        assert.equal(await read("document.querySelectorAll('.source-line-number').length"), 2);
      } else {
        assert.match(await read("document.querySelector('.markdown-fallback').textContent"), /任务内容仍在/);
      }
      window.webContents.session.webRequest.onBeforeRequest(null);
      // Chromium caches failed module URLs for this document. Keep the usable
      // basic preview; never reload the conversation to regain decoration.
      assert.equal(await read("document.querySelectorAll('.deferred-module-notice button').length"), 0);
      assert.equal(await read('window.mounts'), 1);
      assert.deepEqual(await read('window.fatalErrors'), []);
      const fresh = await page();
      await fresh.read(`window.openFeature('${feature}')`);
      if (feature === 'diff') await fresh.until("!!document.querySelector('.diff-lines.syntax-highlighted')");
      if (feature === 'source') await fresh.until("!!document.querySelector('.source-code-lines.syntax-highlighted')");
      if (feature === 'markdown') await fresh.until("!!document.querySelector('.markdown-content h2')");
      assert.deepEqual(await fresh.read('window.fatalErrors'), []);
      fresh.window.destroy();
      window.destroy();
    }
    const panel = await page();
    await panel.read("window.openFeature('panel')");
    await panel.until("!!document.querySelector('.deferred-module-notice')");
    await panel.read("window.panelReady = true; document.querySelector('.deferred-module-notice button').click()");
    await panel.until("!!document.querySelector('#loaded-panel')");
    assert.equal(await panel.read('window.mounts'), 1);
    panel.window.destroy();
    clearTimeout(deadline);
    console.log('Deferred modules passed: live build retention, failed diff/source/Markdown imports, cached-failure previews, fresh-page recovery, panel retry and uninterrupted workspace state.');
    process.send('passed');
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(deadline);
    app.exit(1);
  }
});
