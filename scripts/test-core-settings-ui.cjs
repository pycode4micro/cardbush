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
    await until('document.querySelector(".chrome-connector-heading")?.textContent.includes("浏览器已连接")');
    assert.equal(await read('document.querySelector(".core-capability-settings h3").textContent'), 'Browser Use');
    assert.equal(await read('document.querySelectorAll(".browser-connection-row").length'), 2);
    await read('document.querySelector(".browser-connections").scrollIntoView({block:"center"}); void 0');
    await capture('browser-use-connections.png');
    await read('document.querySelectorAll(".browser-connection-row")[1].querySelector("button").click(); void 0');
    await until('document.querySelectorAll(".browser-connection-row")[1].querySelector("button").disabled');
    assert.equal(await read('fixtureConnector.defaultConnectionId'), 'b'.repeat(32));
    await read('document.querySelector("[aria-label=要配对的浏览器]").click(); void 0');
    await until('document.querySelector("[role=option]") !== null');
    await read('[...document.querySelectorAll("[role=option]")].find(option=>option.textContent.includes("Microsoft Edge")).click(); void 0');
    await read("[...document.querySelectorAll('button')].find(button=>button.textContent==='生成配对码').click(); void 0");
    await until('document.querySelector(".chrome-connector-pairing input") !== null');
    assert.equal(await read('lastPairInput.browser'), 'edge');
    assert.equal(await read('document.querySelectorAll(".browser-connection-row").length'), 2, 'new pairing code does not replace existing connections');
    await read('document.querySelectorAll(".browser-connection-row")[1].querySelectorAll("button")[1].click(); void 0');
    await until('document.querySelectorAll(".browser-connection-row").length===1');
    assert.equal(await read('fixtureConnector.connections[0].browser'), 'chrome');
    await read('connectorActions=[]; void 0');
    assert.equal(await read('document.querySelector(".chrome-radio-setting input").checked'), true);
    assert.equal(await read('document.querySelector(".settings-field input").value'), 'https://www.google.com/');
    await read("[...document.querySelectorAll('button')].find(button=>button.textContent==='关闭连接器').click(); void 0");
    await until('document.querySelector(".chrome-connector-heading")?.textContent.includes("连接器已关闭")');
    await read("[...document.querySelectorAll('button')].find(button=>button.textContent==='开启连接器').click(); void 0");
    await until('document.querySelector(".chrome-connector-heading")?.textContent.includes("等待扩展")');
    await read("[...document.querySelectorAll('button')].find(button=>button.textContent==='生成配对码').click(); void 0");
    await until('document.querySelector(".chrome-connector-pairing input")?.value === "CB2.45678.fixture-secret"');
    assert.equal(await read('document.querySelector(".chrome-connector-pairing input").type'), 'password');
    await read("[...document.querySelectorAll('button')].find(button=>button.textContent==='移除连接器配置').click(); void 0");
    await until('document.querySelector(".chrome-connector-heading")?.textContent.includes("连接器已关闭")');
    assert.equal(await read('document.querySelector(".chrome-connector-pairing")'), null);
    assert.deepEqual(await read('connectorActions'), ['disable', 'enable', 'pair', 'remove']);
    await read('Object.assign(fixtureConnector,{connectorEnabled:true,bridgeRunning:true,extensionConnected:true,lifecycleState:"enabled",connections:structuredClone(fixtureConnections),defaultConnectionId:"a".repeat(32)}); [...document.querySelectorAll("button")].find(button=>button.textContent==="刷新状态").click(); void 0');
    await until('document.querySelectorAll(".browser-connection-row").length===2');
    const palettes = [];
    for (const theme of ['bright', 'dark', 'custom']) {
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
    assert.equal(new Set(palettes.map(state=>state.background)).size, palettes.length, 'each theme reaches the settings cards');
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
    console.log('Core settings UI: Browser Use connections/default/Edge pairing/revocation, connector mode/enablement, themes, stale saves and narrow layout passed.');
  } finally { win.destroy(); }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
