const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

module.exports = async ({ window, original, origin, read, waitFor, activeReady, until, pause, click, externallyOpened, webContents }) => {
  const prefs = () => read(`JSON.parse(localStorage.getItem('cardbush_app_center_v1')||'{}')`);
  const installReady = () => waitFor(`document.querySelector('.browser-install-dialog')?.open && !document.querySelector('.browser-install-dialog button[type=submit]').disabled`, 'web app metadata loads');
  await original.loadURL(origin + '/web-app/page'); await activeReady();
  await pause(300); // Let the inspector's initial width transition settle before native hit testing.
  await original.executeJavaScript(`localStorage.setItem('webapp-session','retained');document.cookie='webapp-session=retained;path=/'; void 0`);
  await click(window.webContents, '.browser-install-button'); await installReady();
  assert.equal(await read(`document.querySelector('.browser-install-dialog input[aria-label="应用名称"]').value`), '演示网页应用');
  assert.equal(await read(`document.querySelector('.browser-install-url').textContent`), origin + '/web-app/start');
  await read(`document.querySelector('.browser-install-dialog header button').click(); void 0`);
  await waitFor(`!document.querySelector('.browser-install-dialog')`);
  assert.equal((await prefs()).webApps, undefined, 'cancelling never installs a web app');

  await click(window.webContents, '.browser-install-button'); await installReady();
  await read(`(()=>{const input=document.querySelector('.browser-install-dialog input[aria-label="应用名称"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'我的工作台');input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('.browser-install-pin input').click();})()`);
  for (const theme of ['bright', 'dark']) {
    await read(`document.querySelector('.app').className='app theme-${theme}'; void 0`); await pause(120);
    await fs.writeFile(path.resolve('tmp', `web-app-install-${theme}.png`), (await window.webContents.capturePage()).toPNG());
  }
  await click(window.webContents, '.browser-install-dialog button[type=submit]');
  await waitFor(`document.querySelector('.app-center-drawer')?.open && document.querySelector('.app-center-tile[data-application-id^="web:"]')`);
  const saved = await prefs(), app = saved.webApps[0];
  assert.equal(saved.webApps.length, 1); assert.equal(app.title, '我的工作台'); assert.equal(app.identity, origin + '/web-app');
  assert.ok(saved.shortcuts.includes(app.id));
  assert.equal(original.getURL(), origin + '/web-app/page', 'install form never submits the surrounding address bar');
  await read(`browserFixture.installWebApplication(${JSON.stringify(app)}); void 0`);
  assert.equal((await prefs()).webApps.length, 1, 'repeated installs retain the same app identity');
  await waitFor(`document.querySelector('.app-center-tile[data-application-id^="web:"] img')?.naturalWidth>0`, 'app center uses website icon');
  await click(window.webContents, '.app-center-tile[data-application-id^="web:"] .app-center-tile-open');
  await waitFor(`browserFixture.navigation[browserFixture.activeId]?.url===${JSON.stringify(origin + '/web-app/start')}`); await activeReady();
  const launchedId = await read(`document.querySelector('.right-inspector-tab-page.active webview').getWebContentsId()`), launched = webContents.fromId(launchedId);
  assert.notEqual(launchedId, original.id, 'app launch opens its own start page');
  assert.equal(await launched.executeJavaScript(`localStorage.getItem('webapp-session')`), 'retained');
  assert.match(await launched.executeJavaScript('document.cookie'), /webapp-session=retained/);
  assert.deepEqual(externallyOpened, [], 'web apps never launch the system browser');
  await waitFor(`document.querySelector('.browser-install-button').classList.contains('installed')`);
  await click(window.webContents, '.browser-install-button'); await waitFor(`document.querySelector('.app-center-drawer')?.open`);
  await read(`document.querySelector('.app-center-tile[data-application-id^="web:"] button[aria-label="移除 我的工作台"]').click(); void 0`);
  await waitFor(`!document.querySelector('.app-center-tile[data-application-id^="web:"]')`);
  assert.equal((await prefs()).webApps.length, 0); assert.ok(!(await prefs()).shortcuts.includes(app.id));
  assert.equal(await launched.executeJavaScript(`localStorage.getItem('webapp-session')`), 'retained', 'removing app preserves site data');
  await read(`document.querySelector('.app-center-drawer button[aria-label="关闭应用中心"]').click(); void 0`);
  await waitFor(`!document.querySelector('.app-center-drawer')`);

  await launched.loadURL(origin + '/ordinary-webpage'); await activeReady();
  await click(window.webContents, '.browser-install-button'); await installReady();
  assert.equal(await read(`document.querySelector('.browser-install-url').textContent`), origin + '/ordinary-webpage', 'ordinary pages can be saved without a manifest');
  await read(`document.querySelector('.browser-install-dialog header button').click(); void 0`);
  await assert.rejects(read(`window.cardbushDesktop.browser.webApplication(${window.webContents.id},${JSON.stringify(origin + '/ordinary-webpage')})`), /unavailable/i);
  await assert.rejects(read(`window.cardbushDesktop.browser.webApplication(${launchedId},${JSON.stringify(origin + '/old-url')})`), /Page changed/);
  console.log('Web apps passed: real manifest metadata, install/cancel/rename/pin, icon, identity deduplication, internal launch with retained cookies/storage, removal, ordinary-page fallback, guest ownership and stale-navigation checks.');
};
