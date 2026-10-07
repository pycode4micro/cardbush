const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { dialog, webContents } = require('electron');

module.exports = async ({ window, original, origin, directory, read, waitFor, activeReady, until, pause, click, uiService }) => {
  const menu = async label => {
    await read(`document.querySelector('.browser-menu-trigger').click(); void 0`);
    await waitFor(`document.querySelector('.browser-menu-popover').matches(':popover-open')`);
    if (label) await read(`Array.from(document.querySelectorAll('.browser-menu-popover > button')).find(button=>button.textContent===${JSON.stringify(label)}).click(); void 0`);
  };
  const type = async (selector, value) => {
    await read(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  };
  const closeDialog = async () => { await read(`document.querySelector('.browser-library-dialog > header button').click(); void 0`); await waitFor(`!document.querySelector('.browser-library-dialog')`); };
  const screenshotPath = path.join(directory, 'page.png'), downloadPath = path.join(directory, 'download.bin');
  const oldSave = dialog.showSaveDialog, oldPrint = original.print;
  let prints = 0;
  dialog.showSaveDialog = async () => ({ canceled: false, filePath: screenshotPath });
  original.print = (options, callback) => { assert.equal(options.silent, false); prints++; callback(true, ''); };
  const saveDownload = (_event, item) => { if (item.getURL() === origin + '/browser-menu-download') item.setSavePath(downloadPath); };
  original.session.on('will-download', saveDownload);
  try {
    await original.loadURL(origin + '/browser-tools'); await activeReady();
    await until(() => uiService.library.list('history', 'Browser tools').then(page => page.total === 1), 'native history registration');
    const dismissed = () => waitFor(`!document.querySelector('.browser-menu-popover').matches(':popover-open') && document.querySelector('.browser-menu-trigger').getAttribute('aria-expanded')==='false'`, 'clicking the native web page closes the browser menu');
    for (let i = 1; i <= 2; i++) {
      await menu(); await click(original, '#menu-probe');
      await until(() => original.executeJavaScript(`window.menuClicks===${i}`), 'page receives the outside click once');
      await dismissed();
    }
    await menu(); await click(original, '#menu-input'); await dismissed();
    original.sendInputEvent({ type: 'char', keyCode: 'x' });
    await until(() => original.executeJavaScript(`document.activeElement.id==='menu-input' && document.querySelector('#menu-input').value==='x'`), 'dismissal keeps focus in the clicked page input');
    await menu();
    const framePoint = await original.executeJavaScript(`(()=>{const frame=document.querySelector('#menu-frame'),f=frame.getBoundingClientRect(),b=frame.contentDocument.querySelector('button').getBoundingClientRect();return {x:Math.round(f.x+frame.clientLeft+b.x+b.width/2),y:Math.round(f.y+frame.clientTop+b.y+b.height/2)};})()`);
    original.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...framePoint });
    original.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...framePoint });
    await until(() => original.executeJavaScript('window.frameClicks===1'), 'embedded frame receives the click'); await dismissed();
    await menu(); await click(window.webContents, '#conversation-draft'); await dismissed();
    await menu();
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
    await dismissed();
    assert.equal(await read(`document.activeElement===document.querySelector('.browser-menu-trigger')`), true, 'Escape returns focus to the menu button');
    await menu('在页面中查找'); await waitFor(`document.querySelector('.browser-find-bar input')!==null`);
    await type('.browser-find-bar input', 'needle'); await waitFor(`document.querySelector('.browser-find-bar output').textContent==='1 / 3'`);
    await read(`document.querySelector('.browser-find-bar button[aria-label="下一个"]').click(); void 0`);
    await waitFor(`document.querySelector('.browser-find-bar output').textContent==='2 / 3'`);
    await read(`document.querySelector('.browser-find-bar button[aria-label="关闭查找"]').click(); void 0`);
    original.sendInputEvent({ type: 'keyDown', keyCode: 'F', modifiers: ['control'] });
    original.sendInputEvent({ type: 'keyUp', keyCode: 'F', modifiers: ['control'] });
    await waitFor(`document.querySelector('.browser-find-bar')!==null`, 'Ctrl+F from inside the guest');
    await read(`document.querySelector('.browser-find-bar button[aria-label="关闭查找"]').click(); void 0`);

    await menu();
    await click(window.webContents, '.browser-menu-zoom button[aria-label="放大网页"]');
    await until(() => Math.abs(original.getZoomFactor() - 1.1) < .001, 'zoom applies to guest');
    assert.equal(await read(`document.querySelector('.browser-menu-popover').matches(':popover-open')`), true, 'clicking controls inside the menu keeps it open');
    await read(`document.querySelector('.browser-menu-trigger').click(); void 0`);
    original.reload(); await pause(80); await activeReady();
    assert.ok(Math.abs(original.getZoomFactor() - 1.1) < .001, 'navigation retains chosen zoom');
    assert.equal(window.webContents.getZoomFactor(), 1, 'browser zoom never zooms the application');
    await menu(); await read(`document.querySelector('.browser-menu-zoom button[aria-label="重置为 100%"]').click(); void 0`);
    await until(() => Math.abs(original.getZoomFactor() - 1) < .001, 'reset zoom');
    await read(`document.querySelector('.browser-menu-trigger').click(); void 0`);
    await menu('显示 / 隐藏设备工具栏'); await waitFor(`document.querySelector('.browser-device-bar')!==null`);
    await until(() => original.executeJavaScript('innerWidth===390'), 'real mobile viewport');
    await read(`document.querySelector('.browser-device-bar button[aria-label="旋转设备"]').click(); void 0`);
    await until(() => original.executeJavaScript('innerWidth===844'), 'rotated device viewport');
    await read(`document.querySelector('.browser-device-bar button[aria-label="关闭设备工具栏"]').click(); void 0`);
    await until(() => original.executeJavaScript('innerWidth>600 && innerWidth!==844'), 'desktop viewport restored');

    await menu('打印…'); await until(() => prints === 1, 'native print dispatch');
    await menu('截取当前可见页面…'); await until(() => fs.stat(screenshotPath).then(info => info.size > 100, () => false), 'real page screenshot saved');
    assert.equal((await fs.readFile(screenshotPath)).subarray(1, 4).toString(), 'PNG');

    const profile = path.join(directory, 'chrome', 'Default'); await fs.mkdir(profile, { recursive: true });
    await fs.writeFile(path.join(profile, 'Bookmarks'), JSON.stringify({ roots: { bookmark_bar: { name: '工作收藏夹', children: Array.from({ length: 165 }, (_, i) => ({ type: 'url', name: `收藏 ${i}`, url: `${origin}/bookmark-${i}` })) } } }));
    await menu('导入 Chrome / Edge 收藏夹…'); await waitFor(`document.querySelector('.browser-import-controls select').value==='chrome:Default'`);
    await read(`document.querySelector('.browser-import-controls button').click(); void 0`);
    await waitFor(`document.querySelector('.browser-bookmark-import [role=status]')?.textContent.includes('已导入 165')`);
    await read(`document.querySelector('.browser-import-controls button').click(); void 0`);
    await waitFor(`document.querySelector('.browser-bookmark-import [role=status]')?.textContent.includes('已导入 0')`);
    await closeDialog();
    await menu('收藏夹'); await waitFor(`document.querySelectorAll('.browser-library-row').length===50`);
    await type('.browser-library-search', 'bookmark-164'); await waitFor(`document.querySelectorAll('.browser-library-row').length===1`);
    assert.match(await read(`document.querySelector('.browser-library-row').textContent`), /工作收藏夹/);
    await closeDialog();
    await menu('历史记录'); await type('.browser-library-search', 'Browser tools');
    await waitFor(`document.querySelectorAll('.browser-library-row').length===1`); await closeDialog();

    await click(original, '#download');
    await until(() => uiService.library.list('downloads').then(page => page.total === 1 && page.items[0].received > 0), 'actual browser download tracked');
    await menu('下载'); await waitFor(`document.querySelector('.browser-download-info')!==null`);
    await read(`document.querySelector('.browser-library-row button[aria-label="暂停下载"]').click(); void 0`);
    await waitFor(`document.querySelector('.browser-download-info').textContent.includes('已暂停')`);
    await read(`document.querySelector('.browser-library-row button[aria-label="继续下载"]').click(); void 0`);
    await waitFor(`document.querySelector('.browser-download-info').textContent.includes('已完成')`);
    assert.equal((await fs.stat(downloadPath)).size, 1024 * 1024); await closeDialog();

    await read(`localStorage.setItem('application-sentinel','keep'); void 0`);
    await original.executeJavaScript(`localStorage.setItem('website-sentinel','clear');void 0`);
    await menu('清除浏览数据…');
    await read(`(()=>{const inputs=document.querySelectorAll('.browser-clear-options input');inputs[1].click();inputs[3].click();document.querySelector('.browser-clear-options > button').click();})()`);
    await waitFor(`document.querySelector('.browser-library-dialog > [role=status]')?.textContent.includes('已清除')`);
    assert.equal(await original.executeJavaScript(`localStorage.getItem('website-sentinel')`), null);
    assert.equal(await read(`localStorage.getItem('application-sentinel')`), 'keep', 'clearing a site preserves app settings');
    assert.equal((await uiService.library.list('history')).total, 0); assert.equal((await uiService.library.list('downloads')).total, 0);
    assert.equal((await fs.stat(downloadPath)).size, 1024 * 1024, 'clearing metadata keeps the downloaded file');
    assert.equal(await read(`JSON.parse(localStorage.getItem('cardbush.browser_bookmarks.v1')).length`), 165);
    await closeDialog();

    await assert.rejects(uiService.page(window.webContents, window.webContents.id, { action: 'status' }), /unavailable/);
    await assert.rejects(uiService.clear(window.webContents, { history: false, downloads: false, cache: false, site: true, guestId: original.id, origin: 'https://wrong.example' }), /changed/);
    const firstTabId = await read('browserFixture.activeId');
    await read(`browserFixture.open({target:${JSON.stringify(origin + '/browser-tools')},newTab:true}); void 0`); await activeReady();
    const secondId = await read(`document.querySelector('.right-inspector-tab-page.active webview').getWebContentsId()`);
    const second = webContents.fromId(secondId), secondPrint = second.print;
    let secondPrints = 0;
    try {
      second.print = (_options, callback) => { secondPrints++; callback(true, ''); };
      await menu('打印…'); await until(() => secondPrints === 1, 'menu follows a newly selected tab');
      assert.equal(prints, 1, 'the previous tab receives no print action');
    } finally { second.print = secondPrint; }
    await read(`browserFixture.activateTab(${JSON.stringify(firstTabId)}); void 0`); await activeReady();
    for (const theme of ['bright', 'dark']) {
      await read(`document.querySelector('.app').className='app theme-${theme}'; void 0`); await menu();
      await waitFor(`getComputedStyle(document.querySelector('.browser-menu-popover')).getPropertyValue('--surface-raised').trim()==='${theme === 'dark' ? '#32312f' : '#ffffff'}'`);
      await pause(180);
      await fs.writeFile(path.resolve(`tmp/browser-menu-${theme}.png`), (await window.webContents.capturePage()).toPNG());
      const size = await read(`(()=>{const r=document.querySelector('.browser-menu-popover').getBoundingClientRect();return {right:r.right,bottom:r.bottom,width:r.width,height:innerHeight};})()`);
      assert.ok(size.right <= 1100 && size.bottom <= size.height && size.width > 200);
      await read(`document.querySelector('.browser-menu-trigger').click(); void 0`);
    }
    await menu('浏览器设置'); await waitFor(`toolClicks.includes('browser-settings')`);
    assert.equal(await read(`document.querySelector('webview').getWebContentsId()`), original.id, 'menu tools preserve the guest');
    await read(`browserFixture.open({target:${JSON.stringify(origin + '/browser-menu-download')},newTab:true}); void 0`);
    await until(() => uiService.library.list('downloads').then(page => page.total === 1 && page.items[0].state === 'completed'), 'a direct download is tracked before a document becomes ready');
    console.log('Browser menu passed: native page/frame outside clicks, preserved click/focus, Escape, in-menu controls, real find/next/Ctrl+F, persistent page zoom, device/rotation, print routing, PNG, 165 bookmark import/dedup/search, native download pause/resume, history, origin-scoped clear, app data/file preservation, light/dark menus.');
  } finally { dialog.showSaveDialog = oldSave; original.print = oldPrint; original.session.removeListener('will-download', saveDownload); }
};
