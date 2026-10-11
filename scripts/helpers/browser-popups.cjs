const assert = require('node:assert/strict');
const http = require('node:http');
const { BrowserWindow } = require('electron');

module.exports = async ({ window, original, origin, read, until, pause, additionalBrowserOrigins, popupEvents }) => {
  const posts = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    if (url.pathname === '/provider') {
      res.end(`<title>Provider iframe</title><button id="login" onclick="signIn()">Sign in</button>
        <script>function signIn(){window.authPopup=window.open('/approve','iframe-auth','popup,width=560,height=720');parent.postMessage({kind:'frame-handle',present:!!authPopup},${JSON.stringify(origin)})}
        addEventListener('message',e=>{if(e.source===window.authPopup)parent.postMessage({kind:'frame-result',result:e.data},${JSON.stringify(origin)})})</script>`); return;
    }
    if (url.pathname === '/post') {
      let body = ''; req.on('data', chunk => body += chunk);
      req.on('end', () => { posts.push({ method: req.method, body }); res.end('<title>POST result</title><p id="posted">Received</p>'); }); return;
    }
    res.end(`<title>Website-controlled misleading title</title><button id="approve" onclick="opener.postMessage({kind:'login-result',cookie:document.cookie},'*');window.close()">Complete fixture login</button>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const authOrigin = `http://127.0.0.1:${server.address().port}`;
  additionalBrowserOrigins.add(authOrigin);
  const authUrl = authOrigin + '/approve?state=diagnostic-secret#private-fragment';
  const popups = () => BrowserWindow.getAllWindows().filter(item => item !== window && !item.isDestroyed());
  const ready = child => until(async () => !child.isDestroyed() && await child.webContents.executeJavaScript('Boolean(document.querySelector("#approve"))'), 'popup ready');
  try {
    await original.executeJavaScript(`window.receipts=[];window.fallbacks=0;
      addEventListener('message',e=>{if(e.origin===${JSON.stringify(authOrigin)})receipts.push({value:e.data,fromPopup:e.source===window.authPopup})});
      window.signIn=()=>{let opened=window.open(${JSON.stringify(authUrl)},'oauth-window','popup,width=560,height=720');
        if(!opened){fallbacks++;opened=window.open(${JSON.stringify(authUrl + '&retry=1')},'oauth-fallback','popup,width=560,height=720')}
        window.authPopup=opened;return !!opened};void 0`);
    const initialTabs = await read('browserFixture.tabs.length');
    assert.equal(await original.executeJavaScript('signIn()', true), true, 'login SDK receives a real WindowProxy instead of retrying a denied popup');
    await until(() => popups().length === 1, 'one native popup');
    const popup = popups()[0]; await ready(popup);
    assert.equal(await original.executeJavaScript('fallbacks'), 0, 'no SDK fallback duplicate');
    assert.equal(await read('browserFixture.tabs.length'), initialTabs, 'popup URL is not also recreated as an inspector tab');
    assert.equal(popup.webContents.session, original.session, 'login uses the same site cookie/session store');
    assert.equal(popup.isVisible(), false, 'isolated UI test does not show a desktop window');
    const preferences = popup.webContents.getLastWebPreferences();
    assert.equal(preferences.sandbox, true); assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.webviewTag, false);
    assert.equal(await popup.webContents.executeJavaScript('typeof window.cardbushDesktop'), 'undefined', 'untrusted login pages have no application bridge');
    assert.equal(await popup.webContents.executeJavaScript('typeof require'), 'undefined');
    assert.equal(await popup.webContents.executeJavaScript('opener!==null'), true);
    assert.equal(popup.getTitle(), authOrigin + ' — CardBush', 'native title identifies the real origin, not the website title');

    await original.executeJavaScript('signIn()', true);
    await pause(120); await ready(popup);
    assert.equal(popups().length, 1, 'opening the same named login window reuses it');
    assert.equal(popups()[0].id, popup.id);
    await popup.webContents.executeJavaScript('document.cookie="fixture_login=ok; SameSite=Lax";document.querySelector("#approve").click();void 0', true);
    await until(() => popup.isDestroyed(), 'provider closes its popup');
    await until(async () => await original.executeJavaScript('receipts.some(item=>item.value.kind==="login-result"&&item.fromPopup)'), 'login result returns to the original page');
    assert.equal(await original.executeJavaScript('authPopup.closed'), true, 'opener observes window.close');
    assert.ok((await original.executeJavaScript('document.cookie')).includes('fixture_login=ok'), 'site session persists after popup closes');

    // Google Identity Services opens from a provider iframe, not necessarily the top page.
    await original.executeJavaScript(`const provider=document.createElement('iframe');provider.src=${JSON.stringify(authOrigin + '/provider')};document.body.append(provider);void 0`);
    await until(() => original.mainFrame.frames.some(frame => frame.url === authOrigin + '/provider'), 'provider frame');
    const provider = original.mainFrame.frames.find(frame => frame.url === authOrigin + '/provider');
    await until(() => provider.executeJavaScript('Boolean(document.querySelector("#login"))'), 'provider button');
    await provider.executeJavaScript('document.querySelector("#login").click();void 0', true);
    await until(() => popups().length === 1, 'iframe popup');
    const iframePopup = popups()[0]; await ready(iframePopup);
    await iframePopup.webContents.executeJavaScript('document.querySelector("#approve").click();void 0', true);
    await until(async () => await original.executeJavaScript('receipts.some(item=>item.value.kind==="frame-result"&&item.value.result.kind==="login-result")'), 'callback returns through the correct provider iframe');
    await until(() => iframePopup.isDestroyed(), 'iframe popup closed');

    await original.executeJavaScript(`window.authPopup=window.open('','blank-auth');authPopup.location=${JSON.stringify(authUrl)};void 0`, true);
    await until(() => popups().length === 1, 'staged blank popup');
    const staged = popups()[0]; await ready(staged);
    assert.equal(await staged.webContents.executeJavaScript('opener!==null'), true, 'about:blank then redirect keeps opener');
    staged.destroy();

    await original.executeJavaScript(`const form=document.createElement('form');form.method='POST';form.action=${JSON.stringify(authOrigin + '/post')};form.target='_blank';
      const value=document.createElement('input');value.name='fixture';value.value='preserved';form.append(value);document.body.append(form);form.submit();void 0`, true);
    await until(() => posts.length === 1, 'new-window form POST reaches provider');
    assert.deepEqual(posts, [{ method: 'POST', body: 'fixture=preserved' }]);
    assert.equal(popups().length, 1);
    const posted = popups()[0];
    await posted.webContents.executeJavaScript('window.open("file:///C:/private.txt","blocked-local","popup");window.open("bytedance://fixture","blocked-external","popup");void 0', true);
    await pause(100);
    assert.equal(popups().length, 1, 'popup descendants cannot open local files or OS protocols');
    assert.equal(await read('browserFixture.tabs.length'), initialTabs);
    const blocked = [];
    posted.webContents.on('will-frame-navigate', event => { if (event.url.startsWith('bytedance:')) blocked.push(event.defaultPrevented); });
    await posted.webContents.executeJavaScript('location.href="bytedance://fixture";void 0', true);
    await until(() => blocked.length === 1, 'popup external-protocol navigation blocked');
    assert.equal(blocked[0], true);
    await read('document.querySelector("webview").remove();void 0');
    await until(() => posted.isDestroyed(), 'closing the original tab closes its popup');
    assert.ok(popupEvents.some(event => event.phase === 'opened') && popupEvents.some(event => event.phase === 'closed'));
    assert.ok(!JSON.stringify(popupEvents).includes('diagnostic-secret') && !JSON.stringify(popupEvents).includes('private-fragment'), 'OAuth query/fragment data stays out of diagnostics');
    console.log('Browser popups passed: real WindowProxy, named reuse without duplicate tabs, opener/postMessage/close, provider iframe, session, staged blank, POST preservation, isolation and cleanup.');
  } finally {
    for (const popup of popups()) popup.destroy();
    additionalBrowserOrigins.delete(authOrigin); server.close();
  }
};
