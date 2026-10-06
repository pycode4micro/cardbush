const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ window, read, waitFor, activeReady, origin, webContents, click }) => {
  const prefix = '.right-inspector-tab-page.active ';
  await read('document.querySelector(".right-inspector-new-tab").click(); void 0');
  await waitFor('browserFixture.tabs.length===7'); await activeReady();
  assert.equal(await read('document.querySelector("#address").textContent'), 'about:blank', 'old home preferences are ignored');
  assert.equal(await read('document.querySelector("input[aria-label=Address]").value'), '', 'new tab invites a search or address');
  await waitFor(`document.querySelector('${prefix}.inspector-new-tab-page')!==null`);
  const firstTab = await read('browserFixture.activeId');
  const guestId = await read(`document.querySelector('${prefix}webview').getWebContentsId()`);
  const guest = webContents.fromId(guestId);
  await click(window.webContents, prefix+'[data-inspector-action=files]');
  await waitFor('toolClicks.includes("files")');
  assert.equal(await read('browserFixture.activeId'), firstTab, 'start-page tools receive clicks over the blank guest');

  for (const theme of ['bright', 'dark']) {
    await read(`document.querySelector('.app').className='app theme-${theme}'; browserFixture.setWidth(460); void 0`);
    await waitFor(`document.querySelector('${prefix}.deferred-resize-content').getBoundingClientRect().width<500`);
    const geometry = await read(`(()=>{const strip=document.querySelector('.right-inspector-tabs').getBoundingClientRect(), plus=document.querySelector('.right-inspector-new-tab').getBoundingClientRect(), page=document.querySelector('${prefix}.inspector-new-tab-page'); return {gap:plus.left-strip.right, visible:plus.right<=innerWidth, noOverflow:page.scrollWidth<=page.clientWidth};})()`);
    assert.ok(geometry.gap >= 0 && geometry.gap <= 8, 'plus stays beside the tabs, including overflow');
    assert.ok(geometry.visible && geometry.noOverflow, 'new tab remains usable in a narrow inspector');
    await waitFor(`getComputedStyle(document.querySelector('${prefix}[data-inspector-action=review]')).getPropertyValue('--surface-strong').trim()==='${theme==='dark'?'#2b2b2b':'#ffffff'}'`);
    await read('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    await read('new Promise(resolve=>setTimeout(resolve,250))');
    fs.writeFileSync(path.resolve(`tmp/browser-new-tab-${theme}.png`), (await window.webContents.capturePage()).toPNG());
  }
  await read("document.querySelector('.app').className='app theme-bright'; browserFixture.setWidth(820); browserFixture.setLanguage('en'); void 0");
  await waitFor(`document.querySelector('${prefix}.inspector-start-tools h2')?.textContent==='Tools'`);
  await waitFor('browserFixture.navigation[browserFixture.activeId]?.title==="New tab"');
  assert.equal(await read(`document.querySelector('${prefix}webview').getWebContentsId()`), guestId, 'language changes keep the guest');
  await read("browserFixture.setLanguage('zh'); void 0");

  const address = async value => {
    await read(`(()=>{const input=document.querySelector('input[aria-label=Address]');
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});
      input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await read("document.querySelector('form.right-inspector-address').requestSubmit(); void 0");
  };
  for (const query of ['openai', '自然语言 搜索']) {
    await address(query);
    await waitFor(`browserFixture.navigation[browserFixture.activeId]?.url===${JSON.stringify(origin+'/google-search?'+new URLSearchParams({q:query}))}`);
    await activeReady();
    assert.equal(new URL(guest.getURL()).searchParams.get('q'), query, 'address bar uses Google with the complete query');
    assert.equal(await read(`document.querySelector('${prefix}.inspector-new-tab-page')`), null, 'navigation removes only the local overlay');
  }
  await address(origin+'/from-new-tab'); await activeReady();
  await waitFor(`browserFixture.navigation[browserFixture.activeId]?.url===${JSON.stringify(origin+'/from-new-tab')}`);
  assert.equal(await read(`document.querySelector('${prefix}webview').getWebContentsId()`), guestId, 'search and navigation reuse the same guest');
  await read('document.querySelector("#back").click(); void 0'); await activeReady();
  await waitFor('browserFixture.navigation[browserFixture.activeId]?.canGoForward===true');
  await read('document.querySelector("#forward").click(); void 0'); await activeReady();
  await waitFor(`browserFixture.navigation[browserFixture.activeId]?.url===${JSON.stringify(origin+'/from-new-tab')}`);

  await read(`browserFixture.toggleBrowserBookmark(${JSON.stringify(origin+'/favorite')},'收藏网站'); document.querySelector('.right-inspector-new-tab').click(); void 0`);
  await waitFor('browserFixture.tabs.length===8'); await activeReady();
  assert.notEqual(await read('browserFixture.activeId'), firstTab, 'blank tabs have independent identities');
  await click(window.webContents, prefix+'.inspector-bookmark-entry');
  await waitFor(`browserFixture.navigation[browserFixture.activeId]?.url===${JSON.stringify(origin+'/favorite')}`);
  await activeReady();
  assert.equal(await read('browserFixture.tabs.length'), 8, 'bookmarks navigate within the new tab');
  assert.equal(guest.getURL(), origin+'/from-new-tab', 'other tabs retain their page');
};
