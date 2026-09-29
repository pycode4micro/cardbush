const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { app, BrowserWindow, protocol } = require('electron');
const directory = resolve(process.argv[2]);
const manifests = ['computer-use', 'chrome'].map(id => JSON.parse(readFileSync(resolve('assets/plugins', id, '.codex-plugin/plugin.json'), 'utf8')));
app.disableHardwareAcceleration();
app.setPath('userData', join(directory, 'localization-profile'));
protocol.registerSchemesAsPrivileged([{ scheme: 'cardbush-file', privileges: { standard: true, secure: true } }]);
app.whenReady().then(async () => {
  protocol.handle('cardbush-file', () => new Response('<svg xmlns="http://www.w3.org/2000/svg"/>', { headers: { 'Content-Type': 'image/svg+xml' } }));
  const win = new BrowserWindow({ show: false, width: 1180, height: 760, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false,
  } });
  win.webContents.session.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/.test(details.url) }));
  const read = script => win.webContents.executeJavaScript(script);
  const until = async script => {
    const end = Date.now() + 5000;
    while (!await read(script)) {
      if (Date.now() > end) throw Error('Timed out: ' + script + '\n' + await read('document.body.innerText'));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const card = name => `[...document.querySelectorAll('.plugin-featured-grid .plugin-featured-main')].find(button=>button.querySelector('strong')?.textContent===${JSON.stringify(name)})`;
  try {
    await win.loadFile(join(directory, 'index.html'));
    await until("!!document.querySelector('.plugin-featured-grid small')");
    const original = await read('JSON.stringify(fixtureApps)');
    await read(`window.originalCard=${card('Computer Use')}; void 0`);
    for (const language of ['zh', 'en', 'zh']) {
      await read(`setFixtureLanguage(${JSON.stringify(language)})`);
      for (const manifest of manifests) {
        const expected = { ...manifest.interface, ...manifest.cardbush.localizations[language] };
        await until(`${card(manifest.interface.displayName)}?.querySelector('small')?.textContent===${JSON.stringify(expected.shortDescription)}`);
      }
      assert.equal(await read(`originalCard===${card('Computer Use')}`), true, 'switching languages updates existing cards without remounting');
    }
    for (const manifest of manifests) {
      await read(`${card(manifest.interface.displayName)}.click()`);
      for (const language of ['en', 'zh']) {
        const expected = { ...manifest.interface, ...manifest.cardbush.localizations[language] };
        await read(`setFixtureLanguage(${JSON.stringify(language)})`);
        await until(`document.querySelector('.plugin-detail-hero p')?.textContent===${JSON.stringify(expected.shortDescription)}`);
        assert.equal(await read("document.querySelector('.plugin-long-description').textContent"), expected.longDescription);
        for (const prompt of expected.defaultPrompt) assert.ok(await read(`document.querySelector('.plugin-prompt-showcase').textContent.includes(${JSON.stringify(prompt)})`));
      }
      await read("[...document.querySelectorAll('.plugin-detail-page .plugin-back')].find(button=>button.checkVisibility()).click()");
      await until("document.querySelector('.plugin-catalog-page').checkVisibility()");
    }
    assert.equal(await read('JSON.stringify(fixtureApps)'), original, 'language changes do not save translated text into plugin configuration');
    console.log('Plugin localization UI passed: real bundled manifests, Chinese/English cards, details, prompts, stable DOM and unchanged configuration.');
  } finally { win.destroy(); }
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
