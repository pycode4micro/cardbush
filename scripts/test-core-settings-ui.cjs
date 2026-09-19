const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { writeFileSync } = require('node:fs');
const { app, BrowserWindow } = require('electron');
const directory = resolve(process.argv[2]);
app.disableHardwareAcceleration();
app.setPath('userData', join(directory, 'core-settings-profile'));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1140, height: 900, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false,
  } });
  win.webContents.session.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/.test(details.url) }));
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') errors.push(event.message); });
  const read = code => win.webContents.executeJavaScript(code);
  const until = async code => {
    const end = Date.now() + 5000;
    while (!await read(code)) {
      if (Date.now() > end) throw Error('Timed out: ' + code + '\n' + await read('document.body.innerText'));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const capture = async name => {
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await read('Promise.all(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})))');
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(Error('Screenshot paint timeout')), 5000);
      win.webContents.once('paint', () => { clearTimeout(timeout); resolve(); });
      win.webContents.invalidate();
    });
    writeFileSync(resolve('tmp', name), (await win.webContents.capturePage()).toPNG());
  };
  try {
    await win.loadFile(join(directory, 'index.html'));
    await until('document.querySelector(".chrome-connector-heading")?.textContent.includes("Chrome 已连接")');
    assert.equal(await read('document.querySelector(".chrome-radio-setting input").checked'), true);
    assert.equal(await read('document.querySelector(".settings-field input").value'), 'https://www.google.com/');
    const palettes = [];
    for (const theme of ['bright', 'dark', 'cyberpunk', 'custom']) {
      await read(`coreTheme(${JSON.stringify(theme)}); void 0`);
      await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      const state = await read(`(() => {
        const card=document.querySelector('.settings-card'), title=card.querySelector('h3'), content=document.querySelector('.settings-content');
        const rect=content.getBoundingClientRect(), sample=document.createElement('span');sample.style.color='var(--accent)';card.appendChild(sample);
        const themeAccent=getComputedStyle(sample).color;sample.remove();
        return {theme:document.querySelector('.app').className, color:getComputedStyle(title).color, background:getComputedStyle(content).backgroundColor,
          radioAccent:getComputedStyle(document.querySelector('.chrome-radio-setting input')).accentColor, themeAccent,
          left:rect.left, top:rect.top, width:rect.width, overflow:content.scrollWidth>content.clientWidth+1, input:document.querySelector('.settings-field input').value};
      })()`);
      assert.equal(state.overflow, false, theme + ' settings do not overflow horizontally');
      assert.equal(state.input, 'https://www.google.com/', 'theme changes retain the home page field');
      assert.notEqual(state.color, state.background, 'settings headings stay visible');
      assert.equal(state.radioAccent, state.themeAccent, theme + ' radio buttons use the theme accent');
      if (palettes.length) assert.ok(['left','top','width'].every(key=>Math.abs(state[key]-palettes[0][key])<=1), theme + ' preserves panel position within its one-pixel border');
      palettes.push(state);
      await capture('browser-core-settings-' + theme + '.png');
    }
    assert.equal(new Set(palettes.map(state=>state.background)).size, 4, 'each theme reaches the settings cards');
    await read('coreTheme("bright"); void 0');
    await capture('browser-core-settings.png');
    await read('document.querySelectorAll(".chrome-radio-setting input")[1].click(); void 0');
    await until('fixtureApps.plugins[1].config.connectionMode==="remote_debugging"');
    await read('document.querySelector(".chrome-radio-setting input").click(); void 0');
    await until('fixtureApps.plugins[1].config.connectionMode==="connector"');
    await read('document.querySelector(".core-capability-settings .settings-switch input").click(); void 0');
    await until('fixtureApps.plugins[1].enabled===false');
    await read('coreSection("computer-use"); void 0');
    await until('document.body.innerText.includes("用户输入优先")');
    await read('document.querySelectorAll(".settings-switch input")[1].click(); void 0');
    assert.notEqual(await read('fixtureApps.plugins[0].config.yieldToUser'), false, 'draft stays local until saved');
    await read('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="保存配置").click(); void 0');
    await until('fixtureApps.plugins[0].config.yieldToUser===false');
    assert.equal(await read('fixtureApps.plugins[1].enabled'), false, 'desktop setting preserves Chrome configuration');
    await read('coreSection("browser"); void 0');
    await until('document.querySelector(".chrome-connector-card")!==null');
    assert.equal(await read('document.querySelector(".core-capability-settings .settings-switch input").checked'), false);
    // Conflicting saves are visible and reloadable; another surface retains its newer data.
    await read('fixtureApps.revision++; fixtureApps.plugins[1].config.connectionMode="remote_debugging"; document.querySelector(".core-capability-settings .settings-switch input").click(); void 0');
    await until('document.querySelector("[role=alert]")?.textContent.includes("revision conflict")');
    assert.equal(await read('fixtureApps.plugins[1].enabled'), false);
    await read('document.querySelector("[role=alert] button").click(); void 0');
    await until('document.querySelectorAll(".chrome-radio-setting input")[1]?.checked===true');
    win.setSize(650, 760);
    await until('document.documentElement.clientWidth<700');
    assert.equal(await read('document.querySelector(".settings-content").scrollWidth<=document.querySelector(".settings-content").clientWidth+1'), true);
    await capture('browser-core-settings-narrow.png');
    assert.deepEqual(errors, []);
    console.log('Core settings UI: Chrome connector/mode/enablement, desktop options, shared config preservation, stale saves, reload and narrow layout passed.');
  } finally { win.destroy(); }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
