const assert = require('node:assert/strict');
const { BrowserWindow } = require('electron');

module.exports = async ({ window, original, origin, read, until, pause, externalPermissions }) => {
  const blocked = [];
  const frameNavigation = event => {
    if (event.url.startsWith('bytedance:')) blocked.push({ kind: 'frame', prevented: event.defaultPrevented });
  };
  const redirect = (event, url) => {
    if (url.startsWith('bytedance:')) blocked.push({ kind: 'redirect', prevented: event.defaultPrevented });
  };
  original.on('will-frame-navigate', frameNavigation);
  original.on('will-redirect', redirect);
  try {
    const tabs = await read('browserFixture.tabs.length');
    for (let attempt = 0; attempt < 3; attempt++) {
      const previous = blocked.length;
      await original.executeJavaScript(`location.href='bytedance://probe/repeated-${attempt}';void 0`, true);
      await until(() => blocked.length > previous, 'repeated native app link is cancelled');
    }
    const previous = blocked.length;
    await original.executeJavaScript(`(()=>{
      const frame=document.createElement('iframe');frame.id='native-probe';frame.hidden=true;
      frame.src='bytedance://probe/hidden-frame';document.body.append(frame);
    })()`, true);
    await until(() => blocked.length > previous, 'hidden iframe app link is cancelled');
    await original.executeJavaScript(`document.querySelector('#native-probe').src='/external-redirect';void 0`, true);
    await until(() => blocked.some(item => item.kind === 'redirect'), 'HTTP redirect to native app is cancelled');
    await original.executeJavaScript(`window.open('bytedance://probe/popup','_blank');void 0`, true);
    await pause(120);
    assert.ok(blocked.length >= 5 && blocked.every(item => item.prevented), 'all external document navigations are cancelled');
    assert.equal(original.getURL(), origin + '/', 'native app probes preserve the current webpage');
    assert.equal(await original.executeJavaScript('retainedState'), 'search-state', 'page JS state survives');
    assert.equal(await read('browserFixture.tabs.length'), tabs, 'no bogus inspector tab is created');
    assert.equal(await read('!!document.querySelector(".right-inspector-tab-page.active .inspector-preview-error")'), false);
    await original.executeJavaScript(`document.querySelector('#native-probe').remove();void 0`);

    // No navigation guard in this probe: exercise the session-level fallback
    // for direct Chromium dispatch, including APIs which skip will-navigate.
    const probe = new BrowserWindow({ show: false, webPreferences: {
      session: window.webContents.session, sandbox: true, contextIsolation: true, nodeIntegration: false,
    } });
    try {
      await probe.loadURL(origin + '/permission-probe');
      const before = externalPermissions.length;
      await probe.webContents.executeJavaScript(`location.href='bytedance://probe/permission';void 0`, true);
      await until(() => externalPermissions.length > before, 'external app permission fallback');
      assert.ok(externalPermissions.every(item => item.allowed === false), 'the production policy denies every external launch');
      assert.equal(probe.webContents.getURL(), origin + '/permission-probe');
    } finally { probe.destroy(); }
    assert.equal(BrowserWindow.getAllWindows().length, 1, 'no native popup survives');
    console.log('External protocols: repeated app links, hidden frames, redirects, popups and native permission fallback blocked; page state preserved.');
  } finally {
    original.removeListener('will-frame-navigate', frameNavigation);
    original.removeListener('will-redirect', redirect);
  }
};
