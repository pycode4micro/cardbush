const assert = require('node:assert/strict');
const { join, resolve } = require('node:path');
const { writeFileSync } = require('node:fs');
const { app, BrowserWindow, protocol } = require('electron');
const directory = resolve(process.argv[2]);
app.disableHardwareAcceleration();
app.setPath('userData', join(directory, 'appearance-profile'));
protocol.registerSchemesAsPrivileged([{ scheme: 'cardbush-file', privileges: { standard: true, secure: true } }]);
const deadline = setTimeout(() => app.exit(1), 50000);

app.whenReady().then(async () => {
  protocol.handle('cardbush-file', () => new Response('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" rx="8" fill="#2563eb"/></svg>', { headers: { 'Content-Type': 'image/svg+xml' } }));
  const win = new BrowserWindow({ show: false, width: 1140, height: 820, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest((details, done) => done({ cancel: /^https?:/.test(details.url) }));
  const errors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error' && !event.message.includes('resource')) errors.push(event.message); });
  const read = async code => {
    try { return await win.webContents.executeJavaScript(code); }
    catch (cause) { throw new Error('Fixture script failed: ' + code.slice(0,240) + '\n' + errors.slice(-3).join('\n'), {cause}); }
  };
  const until = async code => {
    const end = Date.now() + 5000;
    while (!await read(code)) {
      if (Date.now() > end) throw Error('Timed out: ' + code + '\n' + await read('document.body.innerText'));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  };
  const page = kind => until(`document.querySelector('.plugin-navigation-page:not([hidden])')?.dataset.pluginPage === ${JSON.stringify(kind)}`);
  const click = label => read(`Array.from(document.querySelectorAll('button')).find(button => button.checkVisibility() && (button.textContent.trim() === ${JSON.stringify(label)} || button.title === ${JSON.stringify(label)})).click()`);
  const input = (selector, value) => read(`(() => {
    const input = active().querySelector(${JSON.stringify(selector)});
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(value)});
    input.dispatchEvent(new Event('input', {bubbles:true}));
  })()`);
  // Wait for theme transitions before sampling colors or taking screenshots.
  const settleColors = () => read('Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))');
  const capture = async name => {
    await read('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await settleColors();
    writeFileSync(resolve('tmp', name), (await win.webContents.capturePage()).toPNG());
  };
  const contrast = async selector => {
    await settleColors();
    const values = await read(`contrastFor(${JSON.stringify(selector)})`);
    assert.ok(values.length, 'No visible contrast samples: ' + selector);
    for (const value of values) assert.ok(value.ratio >= 4.5, `${selector}: ${value.ratio.toFixed(2)}:1 (${value.text}) ${JSON.stringify(value)}`);
  };
  try {
    await win.loadFile(join(directory, 'index.html'));
    await until('!!document.querySelector(".plugin-add-button") && !document.querySelector(".plugin-add-button").disabled');
    await read(`
      window.active = () => document.querySelector('.plugin-navigation-page:not([hidden])');
      window.contrastFor = selector => {
        const context = document.createElement('canvas').getContext('2d', {willReadFrequently:true});
        const rgba = value => { context.clearRect(0,0,1,1); context.fillStyle = value; context.fillRect(0,0,1,1); return [...context.getImageData(0,0,1,1).data]; };
        const over = (front,back) => front.slice(0,3).map((v,i) => v * front[3]/255 + back[i] * (1-front[3]/255));
        const light = rgb => rgb.map(v => v/255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4).reduce((sum,v,i) => sum + v * [.2126,.7152,.0722][i], 0);
        return [...document.querySelectorAll(selector)].filter(el => el.checkVisibility() && !el.disabled).map(el => {
          const ancestors=[];for(let p=el;p;p=p.parentElement)ancestors.unshift(p);
          let bg=[255,255,255];for(const p of ancestors)bg=over(rgba(getComputedStyle(p).backgroundColor),bg);
          const fg=over(rgba(getComputedStyle(el).color),bg), a=light(fg), b=light(bg);
          return {text:el.textContent.trim().slice(0,35),theme:document.querySelector('.app').className,fg,bg,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
        });
      };
      fixtureApps = {...fixtureApps, revision:fixtureApps.revision+1,
        plugins:fixtureApps.plugins.map(p => p.id==='chrome' ? {...p,id:'chrome-demo'} : p)};
      refreshFixture();
      const originalCatalog = cardbushDesktop.pluginMarketCatalog;
      cardbushDesktop.pluginMarketCatalog = async (...args) => {
        const result = await originalCatalog(...args);
        if (args[0] === 'builtin') result.entries[0].name='chrome-demo';
        if (args[0] === 'builtin') result.entries.push(...Array.from({length:18}, (_,i) => ({name:'chrome-example-'+i,description:'Sample browser integration',category:'Tools',available:true})));
        return result;
      };
      void 0;
    `);
    await read('remountPlugins()');
    await until('!!document.querySelector(".plugin-add-button") && !document.querySelector(".plugin-add-button").disabled');
    await click('市场'); await page('marketplace');
    await until('active().querySelectorAll(".plugin-market-grid article").length === 19 && !active().querySelector(".plugin-install-button").disabled');
    await contrast('.plugin-market-heading .plugin-install-button');
    await capture('plugin-market-light.png');
    await input('.plugin-search input', 'chrome');
    await read(`window.marketBefore = active(); const card=active().querySelector('.plugin-featured-main');card.focus();document.querySelector('.settings-content').scrollTop=150;window.marketScroll=document.querySelector('.settings-content').scrollTop;card.click();`);
    await page('plugin');
    assert.equal(await read('document.querySelector(".settings-content").scrollTop'), 0, 'detail starts at its heading');
    await until('active().innerText.includes("管理账号")');
    await contrast('.plugin-prompt-showcase > button');
    await capture('plugin-detail-light.png');
    await click('管理账号'); await page('accounts');
    await click('返回插件'); await page('plugin');
    await click('返回市场'); await page('marketplace');
    assert.equal(await read('active()===marketBefore'), true, 'marketplace state stays mounted through nested accounts');
    assert.equal(await read('active().querySelector(".plugin-search input").value'), 'chrome');
    assert.equal(await read('document.querySelector(".settings-content").scrollTop===marketScroll'), true, 'restores marketplace scroll');
    assert.equal(await read('document.activeElement===active().querySelector(".plugin-featured-main")'), true, 'restores keyboard focus');
    await click('返回插件'); await page('catalog');

    await click('管理'); await page('manage');
    await read(`active().querySelectorAll('[role=tab]')[1].click()`);
    await input('.plugin-search input', 'chrome');
    await read(`active().querySelector('.plugin-featured-main').click()`); await page('plugin');
    await click('返回管理'); await page('manage');
    assert.equal(await read('active().querySelector("[aria-selected=true]").textContent.includes("应用")'), true);
    assert.equal(await read('active().querySelector(".plugin-search input").value'), 'chrome');
    await input('.plugin-search input', '');
    await read(`active().querySelectorAll('[role=tab]')[2].click()`);
    await read(`Array.from(active().querySelectorAll('.plugin-featured-main')).find(b=>b.textContent.includes('Blender')).click()`); await page('mcp');
    await click('返回管理'); await page('manage');
    assert.equal(await read('active().querySelector("[aria-selected=true]").textContent.includes("MCP")'), true);
    await click('插件'); await page('catalog');

    await read(`Array.from(active().querySelectorAll('.plugin-added-card')).find(b=>b.textContent.includes('Personal Tools')).click()`); await page('plugin');
    await until('!!active().querySelector(".plugin-mcp-advanced")');
    await read(`active().querySelector('.plugin-mcp-advanced').open=true;active().querySelectorAll('.plugin-hook-trust details').forEach(d=>d.open=true);`);
    await contrast('.plugin-mcp-settings input, .plugin-mcp-settings select, .plugin-mcp-primary-actions button, .plugin-hook-trust pre');
    await capture('plugin-mcp-light.png');
    await read(`const probes=document.createElement('section');probes.className='theme-contrast-probes';probes.innerHTML='<button class="primary-button">保存设置</button><a class="mcp-inline-link">配置链接</a><a class="local-file-reference">文件链接</a><span class="runtime-asset-restart-required">需要重启</span><span class="plugin-component-kind kind-skill">S</span><span class="plugin-component-kind kind-command">/</span><span class="plugin-component-kind kind-mcp">M</span><span class="plugin-component-kind kind-app">A</span>';active().prepend(probes);`);
    for (const theme of ['theme-bright', 'theme-dark', 'theme-dark theme-cyberpunk']) {
      await read(`document.querySelector('.app').className='app '+${JSON.stringify(theme)}`);
      await contrast('.theme-contrast-probes > *');
      await contrast('.plugin-mcp-settings input, .plugin-mcp-primary-actions button');
    }
    await read(`document.querySelector('.app').className='app theme-dark'`);
    await capture('plugin-detail-dark.png');
    await read(`document.querySelector('.app').className='app theme-bright'`);
    await click('返回插件'); await page('catalog'); await click('市场'); await page('marketplace');
    await until('!active().querySelector(".plugin-install-button").disabled');
    await click('添加来源');
    await input('.plugin-market-add input', 'https://github.com/fixture/plugins');
    await read(`active().querySelector('.plugin-market-add').requestSubmit()`);
    await until('active().innerText.includes("示例市场") && !active().querySelector(".plugin-install-button").disabled');
    await read(`marketSlow=true;active().querySelector('.plugin-featured-main').click()`);
    await until('typeof finishMarketPreview === "function"');
    await click('返回市场'); await page('marketplace');
    await read('finishMarketPreview()');
    await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(await read('!!active().querySelector(".plugin-market-detail")'), false, 'cancelled preview must not navigate back into detail');
    win.setSize(650, 750);
    await until('document.documentElement.clientWidth < 700');
    assert.equal(await read('document.querySelector(".settings-content").scrollWidth <= document.querySelector(".settings-content").clientWidth+1'), true, 'marketplace fits a narrow window');
    assert.deepEqual(errors, []);
    console.log('Plugin appearance/navigation passed: light/dark/cyberpunk contrast, retained filters/tabs/scroll/focus, nested accounts/MCP, cancelled previews and narrow layout.');
  } finally { win.destroy(); }
}).then(() => { clearTimeout(deadline); app.exit(0); }).catch(error => { console.error(error); clearTimeout(deadline); app.exit(1); });
