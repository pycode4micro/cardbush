const assert = require('node:assert/strict');

// Exercise real browser state, not just React markup: a recreated guest loses
// its document, form values, history and any pending in-page work.
module.exports = async ({ window, read, waitFor, activeReady, origin, webContents, pause, click }) => {
  await read(`browserFixture.setLayout(null); browserFixture.open({target:${JSON.stringify(origin + '/retention-start')},newTab:true}); void 0`);
  await waitFor(`browserFixture.navigation[browserFixture.activeId]?.url===${JSON.stringify(origin + '/retention-start')}`);
  await activeReady();
  const tabId = await read('browserFixture.activeId');
  const guestId = await read('document.querySelector(".right-inspector-tab-page.active webview").getWebContentsId()');
  const guest = webContents.fromId(guestId);
  const ids = () => read('[...document.querySelectorAll("webview")].map(view=>view.getWebContentsId())');
  const beforeIds = await ids();
  await guest.loadURL(origin + '/translation');
  await activeReady();
  await click(guest,'input'); // Chromium may skip history created without a user gesture.
  await guest.executeJavaScript(`
    document.querySelector('input').value='Unsaved browser draft';
    window.retainedDocument={marker:'same document'};
    history.pushState({step:1},'', '#before');
    history.pushState({step:2},'', '#after');
    scrollTo(0,420); void 0;
  `, true);
  await waitFor('document.querySelector("#address").textContent.endsWith("#after")');
  const snapshot = () => guest.executeJavaScript(`({url:location.href,draft:document.querySelector('input').value,
    marker:window.retainedDocument?.marker,scroll:scrollY,entries:history.length})`);
  const before = await snapshot();
  assert.equal(before.scroll,420,'scroll state is prepared');
  const originalSize = window.getSize();
  for (const [width,zoom] of [[1100,1],[1100,1.25],[640,1]]) {
    window.webContents.setZoomFactor(zoom); window.setSize(width,760); await pause(350);
    await read('browserFixture.setInspectorOpen(false); void 0');
    await pause(400); // Beyond the old 240ms unmount, including narrow-window CSS.
    assert.equal(guest.isDestroyed(),false,'collapsing does not destroy the native guest');
    assert.deepEqual(await ids(),beforeIds,'all tabs remain attached while hidden');
    assert.deepEqual(await snapshot(),before,'hidden browser retains navigation, draft, scroll and JS state');
    assert.equal(await read(`(()=>{const pane=document.querySelector('.right-inspector');return pane.inert &&
      pane.getAttribute('aria-hidden')==='true' && getComputedStyle(pane).visibility==='hidden' &&
      pane.getBoundingClientRect().width===0 && !document.elementFromPoint(innerWidth-12,innerHeight/2)?.closest('.right-inspector');})()`),true,
      'hidden pane releases space, focus and pointer input');
    await click(window.webContents,'#conversation-draft');
    await read('document.querySelector("#conversation-draft").value="Conversation draft survives"; void 0');
    assert.equal(await read('document.activeElement.id'),'conversation-draft','conversation input remains focusable');
    await read('browserFixture.setInspectorOpen(true); void 0');
    await waitFor('document.querySelector(".right-inspector").classList.contains("soft-panel-visible")');
    await pause(300);
    assert.deepEqual(await ids(),beforeIds,'reopen reuses all guests');
    assert.deepEqual(await snapshot(),before,'reopen resumes the same document');
    assert.equal(await read('document.querySelector("#conversation-draft").value'),'Conversation draft survives');
  }
  window.webContents.setZoomFactor(1); window.setSize(...originalSize);
  for (const open of [false,true,false,true]) {
    await read(`browserFixture.setInspectorOpen(${open}); void 0`); await pause(35);
  }
  await pause(350);
  assert.deepEqual(await ids(),beforeIds,'rapid toggles cannot apply a stale disposal timer');
  assert.deepEqual(await snapshot(),before);
  await read('document.querySelector("#back").click(); void 0');
  await waitFor('document.querySelector("#address").textContent.endsWith("#before")');
  await read('document.querySelector("#forward").click(); void 0');
  await waitFor('document.querySelector("#address").textContent.endsWith("#after")');
  assert.equal(await guest.executeJavaScript('retainedDocument.marker'),'same document','history stays usable without reloading');

  // Actual tab closure, even while hidden, must still release the guest.
  await read(`browserFixture.setInspectorOpen(false); browserFixture.closeTabs(new Set([${JSON.stringify(tabId)}])); void 0`);
  await waitFor(`!browserFixture.tabs.some(tab=>tab.id===${JSON.stringify(tabId)})`);
  await pause(300);
  assert.equal(guest.isDestroyed(),true,'closing a tab disposes it');
  assert.deepEqual(await ids(),beforeIds.filter(id=>id!==guestId),'closing one tab preserves all others');
  await read('browserFixture.setInspectorOpen(true); void 0');
  await activeReady();
  console.log('Inspector retention passed: deep navigation, unsaved drafts, scroll/history, hidden input, rapid toggles, 125% zoom, narrow windows and actual tab disposal.');
};
